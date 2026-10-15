// dsh-keepsake 提取结算 durable 层（journal）。
//
// 背景（根治两个缺口）：
//   1) 观测面（metrics 的 lastAttemptAt / 失败计数 / lastFailedRange）与 scheduler 的
//      cursor 全是进程内存态——DSH 一重启全清零，面板与补提逻辑都看不到重启前发生了什么；
//   2) 成功提取不留任何持久痕迹（只有失败才进 extraction-errors.log），"哪段提取过、
//      推进到哪"在盘上无从查证；失败区间的 cursor 也不持久，而 scheduler 的设计是
//      "恢复会话不回扫历史"，于是重启后失败区间永远补不回来（静默丢记忆）。
//
// 方案：每次提取结算（成功/零 ops/跳过/失败）落一行 JSON 到
//   <storageRoot>/extraction-journal.jsonl，构造时同步重放重建内存态三件套：
//   - 每会话 cursor（重启后接着推进：不回扫历史，也不重复提已覆盖区间）；
//   - 最近 ringMax 条结算（面板/排障的"最近发生了什么"，新在前）；
//   - 未恢复失败区间 getUnrecovered（跨重启仍能补提的唯一依据）。
//
// 落盘纪律：
//   - 追加串行化（promise 链队列）：多会话并发 recordRun 不得交错写坏文件、不得丢更新；
//   - 写失败 → log.warn（文案含 journal）+ 内存态照常更新，绝不抛（非致命降级但必须可见，
//     吞掉 = 规则 3 的 fail-open：盘上悄悄少一行，重启后 cursor 倒退却无人知晓）；
//   - 原子写：轮转走 tmp+rename（口径同 global-store.js 的 writeAtomic），中断不留半截主档；
//     .tmp-* 孤儿由 sweepTmpOrphans 清扫（命名带 .tmp- 即被认领）；
//   - 轮转只动文件、不动内存态：cursor/ring/unrecovered 全部由内存态独立维护，
//     被裁掉的旧行不得让"未恢复失败区间"凭空消失——那是跨重启补提的命脉。
//
// 边界：本文件与 extraction-errors.log 同性质（诊断/恢复用，非用户记忆真源），
//   不进全量备份（createBackup 只拷 global/ + settings.json + projects/）。
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const JOURNAL_FILE_NAME = "extraction-journal.jsonl";
/**
 * outcome 合法枚举（四个，与提取管道的四种结算一一对应）：
 * - "written"  有 op 落盘（真正的成功提取）
 * - "zero-ops" 成功跑完但模型没给出任何 op（成功，非失败）
 * - "skipped"  本次跳过（无新内容/被闸门拦下等）
 * - "failed"   失败（cursor 未推进）
 * 非法值一律按 "failed" 记账（最保守语义）并把原值留在 reason 前缀里——
 * 一次拼写错误不该让这条结算从失败面凭空消失。
 */
export const JOURNAL_OUTCOMES = Object.freeze(["written", "zero-ops", "skipped", "failed"]);

const RING_MAX_DEFAULT = 30;
const ROTATE_AT_DEFAULT = 2000;
const KEEP_ON_ROTATE_DEFAULT = 1000;

/** 数值字段归一：非负整数、缺省 0（NaN/Infinity/负数/小数全部钳到 0）。 */
function nonNegInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** 正整数参数归一（ringMax/rotateAt/keepOnRotate）；非法值回落默认。 */
function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** at 归一：有限数字直接用，ISO/可解析字符串用 Date.parse，其余回落 Date.now()。 */
function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

/**
 * 组装一条结算（盘上 JSON 行的唯一形态，内存态同形——重放无需二次转换）。
 * at 存 ISO 字符串：JSONL 里时间必须可读可排序，数字毫秒对排障不友好。
 */
function shapeRun(raw, { outcome, reason, atMs }) {
  return {
    at: new Date(atMs).toISOString(),
    sessionId: raw.sessionId,
    from: nonNegInt(raw.from),
    to: nonNegInt(raw.to),
    cursorAfter: nonNegInt(raw.cursorAfter),
    outcome,
    reason,
    writes: nonNegInt(raw.writes),
    deletes: nonNegInt(raw.deletes),
    skippedOps: nonNegInt(raw.skippedOps),
    failedOps: nonNegInt(raw.failedOps),
    filtered: nonNegInt(raw.filtered),
  };
}

/**
 * 入参归一 + 校验（同步抛错面）。
 * sessionId 非法抛 TypeError：那是调用方 bug，静默兜底等于把结算记到匿名会话上，
 * 重启后谁都认领不回来（规则 3：调用方 bug 必须炸出来）。
 */
function normalizeRun(entry) {
  const raw = entry === null || typeof entry !== "object" ? {} : entry;
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
  if (sessionId.trim().length === 0) {
    throw new TypeError(`dsh-keepsake: journal.recordRun 需要非空 sessionId（收到 ${String(raw.sessionId)}）`);
  }
  let outcome = raw.outcome;
  let reason = typeof raw.reason === "string" ? raw.reason : String(raw.reason ?? "");
  if (!JOURNAL_OUTCOMES.includes(outcome)) {
    const tag = `bad-outcome:${String(outcome)}`;
    reason = reason.length > 0 ? `${tag} ${reason}` : tag;
    outcome = "failed";
  }
  return shapeRun(raw, { outcome, reason, atMs: timestampMs(raw.at) });
}

/**
 * 重放单行：坏行返回 null（调用方逐行 warn 跳过）。
 * 盘上数据是自己的序列化，但可能被别的进程/手改/半行截断弄脏，故读侧一律不信任：
 * 非对象、无 sessionId、JSON 解析失败都算坏行；字段级脏值（负数/小数/非法 outcome）
 * 按与写侧同一口径钳制而非整行丢弃——钳制后仍是一条可用的结算，丢了就真的补不回来。
 */
function parseReplayLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : "";
  if (sessionId.trim().length === 0) return null;
  return shapeRun(obj, {
    outcome: JOURNAL_OUTCOMES.includes(obj.outcome) ? obj.outcome : "failed",
    reason: typeof obj.reason === "string" ? obj.reason : "",
    atMs: timestampMs(obj.at),
  });
}

/** 原子写（tmp+rename；与 global-store.js 同口径，中断不留半截主档）。 */
function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/**
 * 创建 journal 实例。构造即【同步】重放：文件不存在=空态不报错，坏行跳过并 warn。
 *
 * @param {object} [options]
 * @param {string} options.storageRoot 数据根（journal 文件落在其根下）
 * @param {{warn?:Function,error?:Function,info?:Function}} [options.log] 宿主日志口（缺省空实现）
 * @param {number} [options.ringMax=30] 内存环形缓冲上限（新在前）
 * @param {number} [options.rotateAt=2000] 达到该行数即轮转（盘上主档恒定 ≤ rotateAt）
 * @param {number} [options.keepOnRotate=1000] 轮转保留的尾部行数（> rotateAt 时钳到 rotateAt）
 * @returns {{recordRun:Function,getCursor:Function,getRing:Function,getUnrecovered:Function,snapshot:Function}}
 */
export function createJournal({
  storageRoot,
  log = { warn() {}, error() {}, info() {} },
  ringMax = RING_MAX_DEFAULT,
  rotateAt = ROTATE_AT_DEFAULT,
  keepOnRotate = KEEP_ON_ROTATE_DEFAULT,
} = {}) {
  // log 逐方法兜底：宿主只注入部分方法（如只给 warn）时不能让 info/error 变成崩点。
  const safeLog = {
    warn: typeof log?.warn === "function" ? log.warn : () => {},
    error: typeof log?.error === "function" ? log.error : () => {},
    info: typeof log?.info === "function" ? log.info : () => {},
  };
  const ringMaxEff = positiveInt(ringMax, RING_MAX_DEFAULT);
  const rotateAtEff = positiveInt(rotateAt, ROTATE_AT_DEFAULT);
  // keepOnRotate 大于 rotateAt 会让轮转自相矛盾（每次保留的比触发线还多，行数压不住），
  // 故钳到 [1, rotateAt]。
  const keepEff = Math.min(positiveInt(keepOnRotate, KEEP_ON_ROTATE_DEFAULT), rotateAtEff);
  const file = typeof storageRoot === "string" && storageRoot.length > 0 ? join(storageRoot, JOURNAL_FILE_NAME) : null;

  const cursors = new Map(); // sessionId → 该会话最后一条结算的 cursorAfter
  let ring = []; // 最近 ringMax 条，新在前
  let pending = []; // 未恢复失败区间，旧→新（内存态独立维护，轮转裁行不影响它）
  let lineCount = 0; // 盘上物理行数（含坏行：轮转按物理行裁，坏行也要被裁掉）
  let chain = Promise.resolve(); // 追加串行化队列（promise 链）

  /** 结算入内存态（重放与运行期同一入口，保证两态同构）。 */
  function apply(rec) {
    cursors.set(rec.sessionId, rec.cursorAfter);
    ring.unshift(rec);
    if (ring.length > ringMaxEff) ring.length = ringMaxEff;
    // 出列判据（先于入列执行）：任何更晚的同会话记录只要把 cursor 推过 to，就说明这段
    // 已被补上（不看出身 outcome——skipped 也可能因区间已被别处覆盖而推进到 to 之后）。
    // 必须先于入列：否则 [from==to] 的退化区间会被自己刚入列的记录立刻清掉。
    if (pending.length > 0) {
      pending = pending.filter((p) => !(p.sessionId === rec.sessionId && rec.cursorAfter >= p.to));
    }
    // 入列判据：失败 + cursor 没动（cursorAfter===from）＝这段承诺过但没提取成。
    // 失败但 cursor 已推进的是"放弃型"（管道自己决定不再补），不进未恢复清单。
    if (rec.outcome === "failed" && rec.cursorAfter === rec.from) pending.push(rec);
  }

  /** 同步重放：坏行逐行 warn 后跳过，好行照常重建 cursor/ring/unrecovered。 */
  function replay() {
    if (file === null) return;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      // 文件不存在 = 首次运行（空态，不是错误）；其它读失败才 warn（空态启动可见降级）
      if (error?.code === "ENOENT") return;
      safeLog.warn(`journal: 重放失败，按空态启动（重启后 cursor 会退回盘上水准）: ${error?.message ?? error}`);
      return;
    }
    lineCount = 0;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line.length === 0) continue;
      lineCount += 1;
      const rec = parseReplayLine(line);
      if (rec === null) {
        safeLog.warn(`journal: 第 ${i + 1} 行无法解析已跳过（坏行不污染内存态）`);
        continue;
      }
      apply(rec);
    }
  }

  /** 轮转：读回文件、保留尾部 keepEff 行、tmp+rename 原子重写（只动文件，不动内存态）。 */
  function rotate() {
    try {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      const kept = lines.slice(Math.max(0, lines.length - keepEff));
      writeAtomic(file, kept.map((l) => `${l}\n`).join(""));
      lineCount = kept.length;
      safeLog.info(`journal: 轮转 ${lines.length} → ${kept.length} 行（rotateAt=${rotateAtEff}）`);
    } catch (error) {
      // 轮转失败不致命：主档仍在（只是偏大），下条追加后再试——但必须留痕
      safeLog.warn(`journal: 轮转失败（主档保留，下条追加后再试）: ${error?.message ?? error}`);
    }
  }

  /** 追加一行（队列内串行执行）。失败只 warn，内存态早已更新，绝不抛。 */
  function appendLine(rec) {
    if (file === null) {
      safeLog.warn(`journal: storageRoot 非法，结算未落盘（session=${rec.sessionId}）`);
      return;
    }
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify(rec)}\n`, "utf8");
      lineCount += 1;
      // rotateAt 是行数【上限】而非下限：达到即转（>= 而非 >），盘上主档因此恒定
      // ≤ rotateAt（而非 rotateAt+1）。一行之差取这一侧：与「rotateAt=5/keepOnRotate=3
      // 写 7 条 → 剩 3 行」的验收口径自洽（> 语义在该参数下会剩 4 行）。
      if (lineCount >= rotateAtEff) rotate();
    } catch (error) {
      safeLog.warn(`journal: 结算落盘失败（内存态照常更新，重启后以盘上为准）: ${error?.message ?? error}`);
    }
  }

  /** 入队：前序无论成败都继续（一次写失败不得堵死后续结算）。 */
  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * 记一次提取结算。
   * - 校验与内存态更新【同步】完成（调用方不 await 也立刻能读到最新 cursor）；
   * - 落盘在 promise 链队列里串行追加（多会话并发不交错、不丢更新）；
   * - 返回 Promise（resolve 为该条结算），永不 reject（写失败已降级为 warn）。
   * @throws {TypeError} sessionId 非法（调用方 bug）
   */
  function recordRun(entry) {
    const rec = normalizeRun(entry);
    apply(rec);
    return enqueue(() => {
      appendLine(rec);
      return rec;
    });
  }

  /** 该会话最后一条结算的 cursorAfter；无记录返回 null（"不知道"与"0"必须可区分）。 */
  function getCursor(sessionId) {
    const value = cursors.get(sessionId);
    return typeof value === "number" ? value : null;
  }

  /** 最近 ringMax 条结算（新在前）；返回拷贝，外改不污染内部态。 */
  function getRing() {
    return ring.map((r) => ({ ...r }));
  }

  /** 未恢复失败区间（新在前）：失败且 cursor 没动、且后来没被同会话更晚的记录补上。 */
  function getUnrecovered() {
    const out = [];
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const p = pending[i];
      out.push({ sessionId: p.sessionId, from: p.from, to: p.to, at: p.at, reason: p.reason });
    }
    return out;
  }

  /** 面板/端点快照：最近结算 + 未恢复失败区间。 */
  function snapshot() {
    return { runs: getRing(), unrecovered: getUnrecovered() };
  }

  replay();
  return { recordRun, getCursor, getRing, getUnrecovered, snapshot };
}

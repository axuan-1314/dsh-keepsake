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
 * outcome 合法枚举（五个，与提取管道的五种结算一一对应）：
 * - "written"  有 op 落盘（真正的成功提取）
 * - "zero-ops" 成功跑完但模型没给出任何 op（成功，非失败）
 * - "skipped"  本次跳过（无新内容/被闸门拦下等）
 * - "failed"   失败（cursor 未推进）
 * - "abandoned" 结构性失败连续多次后显式放弃该区间（cursor 已推进、不再重试）——
 *   与 failed 分列，盘上才能区分"这段被放弃"与"这段还在等补提"。
 * 非法值一律按 "failed" 记账（最保守语义）并把原值留在 reason 前缀里——
 * 一次拼写错误不该让这条结算从失败面凭空消失。
 */
export const JOURNAL_OUTCOMES = Object.freeze(["written", "zero-ops", "skipped", "failed", "abandoned"]);

const RING_MAX_DEFAULT = 30;
const ROTATE_AT_DEFAULT = 2000;
const KEEP_ON_ROTATE_DEFAULT = 1000;
/** 放弃区间清单封顶（面板持久显示"已放弃 N 轮"用；总数另计不封顶）。 */
const ABANDONED_MAX_DEFAULT = 20;

/**
 * 轮转裁剪优先级（数字越小越先被裁）。
 * 背景（缺口）：裁剪原按行序一刀切留尾部 keepOnRotate 行——gate-off 期间 skipped
 * 行成海（每轮无新内容都记一条），它们按行序挤在尾部，把更早的 failed/abandoned
 * 行挤出环；failed 一旦被裁，"跨重启补提"的命脉就没了（abandoned 另有永久保留兜底，
 * 但 failed 只按当前 pending 集保留，pending 之外的失败记录照样会被冲掉）。
 * 故改为按 outcome 定裁剪序：skipped 最先裁（跳过是可再生的观测噪声，价值最低），
 * 其次 zero-ops，written/failed 最后裁；abandoned 维持"永不裁"的既有语义，
 * 不进本表（裁剪时无条件保留）。
 */
const TRIM_PRIORITY = Object.freeze({ skipped: 0, "zero-ops": 1, written: 2, failed: 2 });
/** 表外 outcome（含 abandoned 与非法值）的裁剪优先级：取最保守 = 最后裁。 */
const TRIM_PRIORITY_FALLBACK = 2;

/** 裁剪优先级取值：表外一律最后裁（宁可留可疑行，不误裁失败留痕）。 */
function trimPriorityOf(outcome) {
  const p = TRIM_PRIORITY[outcome];
  return typeof p === "number" ? p : TRIM_PRIORITY_FALLBACK;
}

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
 * redacted（落盘前脱敏命中数）只在 >0 时序列化进行——为 0 的行不写这个键，
 * 保持旧行形态逐字节不变（盘上无此键 = 没有脱敏命中，与显式 0 不区分）。
 */
function shapeRun(raw, { outcome, reason, atMs }) {
  const rec = {
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
  const redacted = nonNegInt(raw.redacted);
  if (redacted > 0) rec.redacted = redacted;
  return rec;
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
  abandonedMax = ABANDONED_MAX_DEFAULT,
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
  const abandonedMaxEff = positiveInt(abandonedMax, ABANDONED_MAX_DEFAULT);
  const file = typeof storageRoot === "string" && storageRoot.length > 0 ? join(storageRoot, JOURNAL_FILE_NAME) : null;

  const cursors = new Map(); // sessionId → 该会话最后一条结算的 cursorAfter
  let ring = []; // 最近 ringMax 条，新在前
  let pending = []; // 未恢复失败区间，旧→新（内存态独立维护，轮转裁行不影响它）
  let abandoned = []; // 已放弃区间，新在前（封顶 ABANDONED_MAX）
  let abandonedCount = 0; // 累计放弃次数（不封顶，面板显示"已放弃 N 轮"）
  let abandonedSeq = 0; // 入列序（单调递增）：同 at 时据此稳定定序，不靠 unshift 的隐式顺序
  let lineCount = 0; // 盘上物理行数（含坏行：轮转按物理行裁，坏行也要被裁掉）
  let protectedCount = 0; // 上次轮转时【强制保留】的行数（放弃/未恢复两类，见 rotate）——
  // 它们不进可裁 ring，故触发线按 rotateAt + 此数放宽，防每追加一条就反复轮转。
  let chain = Promise.resolve(); // 追加串行化队列（promise 链）

  /** 结算入内存态（重放与运行期同一入口，保证两态同构）。 */
  function apply(rec) {
    cursors.set(rec.sessionId, rec.cursorAfter);
    ring.unshift(rec);
    if (ring.length > ringMaxEff) ring.length = ringMaxEff;
    // 出列判据（先于入列执行）：同会话更晚的记录要把这段【整段覆盖】才算补上——
    // 记录起点不得晚于这段的起点（rec.from <= p.from），终点（cursorAfter）不得早于这段的终点。
    // 只看 cursorAfter >= p.to 会把「从更晚的地方起提、尾巴伸过了 to」误判成已补上：
    // 例如 pending [0,10) 遇上 from=5、cursorAfter=12 的补提，[0,5) 其实从没提取过，
    // 却会连同未提取区间一起出列、留痕凭空消失。故补上「起点也覆盖到」这一半判据。
    // 在线提取路径的连续推进（起点与 cursor 对齐，rec.from === p.from）不受影响：
    // 等号满足 <=，照常出列。
    // 必须先于入列：否则 [from==to] 的退化区间会被自己刚入列的记录立刻清掉。
    if (pending.length > 0) {
      pending = pending.filter((p) => !(p.sessionId === rec.sessionId && rec.from <= p.from && rec.cursorAfter >= p.to));
    }
    // 入列判据：失败 + cursor 没动（cursorAfter===from）＝这段承诺过但没提取成。
    // 失败但 cursor 已推进的是"放弃型"（管道自己决定不再补），不进未恢复清单。
    if (rec.outcome === "failed" && rec.cursorAfter === rec.from) pending.push(rec);
    // 放弃区间单列留痕：结构性失败连续多次后显式放弃（cursor 已推进、不再重试）。
    // 与 failed 未恢复清单互斥（放弃型 cursorAfter>from 故不会进 pending）——
    // 关掉进程后重放靠这列把"哪段被放弃了"在盘上留住（此前放弃即永久消失）。
    if (rec.outcome === "abandoned") {
      abandonedCount += 1;
      // 入列序随重放/运行单调递增：同 at 的放弃区间靠 seq 稳定定序（不依赖 unshift 的隐式顺序，
      // 也不依赖文件里同刻行的相对位置——收集序由内容确定）。
      abandonedSeq += 1;
      abandoned.unshift({ from: rec.from, to: rec.to, sessionId: rec.sessionId, at: rec.at, reason: rec.reason, seq: abandonedSeq });
      if (abandoned.length > abandonedMaxEff) abandoned.length = abandonedMaxEff;
    }
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

  /**
   * 轮转：读回文件、保留尾部 keepEff 行【+ 强制保留的放弃/未恢复行】、tmp+rename 原子重写
   * （只动文件，不动内存态）。
   *
   * 「放弃永久留痕」与「未恢复失败区间跨重启补提」是盘上两类不可丢的行：
   *   - abandoned：结构性失败连续多次后显式放弃的区间——承诺永久留痕（abandonedCount 也靠它累计）；
   *   - unrecovered：failed 且 cursor 未动、且至今没被同会话更晚记录补上的区间——重启补提的命脉。
   * 只留尾部 keepEff 行会把它们随 ring 一起裁掉，重启重放再也见不到，承诺落空。
   * 故按【当前内存态】精确保留这两类原始行（无论多旧），其余旧行照常裁掉。
   *
   * 注意行数语义：keepEff 之外的强制行会让主档物理行数【超 rotateAt 上限】（放弃/未恢复
   * 积累得越多越大，这是"永不裁"的必然代价）；protectedCount 记录本次强制保留数，
   * 追加触发线据此放宽到 rotateAt + protectedCount，避免每追加一条就反复整档重写。
   * 保留仍保持原相对顺序（重放靠顺序判定区间是否被更晚记录补上，乱序会误判）。
   */
  function rotate() {
    try {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      // 强制保留集合：当前仍未恢复的失败区间（pending）+ 已放弃区间（abandoned）。
      const keyOf = (sessionId, from, to) => `${sessionId}\u0000${from}\u0000${to}`;
      const protectedKeys = new Set();
      for (const p of pending) protectedKeys.add(keyOf(p.sessionId, p.from, p.to));
      // 分两桶：protect = 无条件保留（abandoned 永久留痕 + 当前未恢复失败区间）；
      // 其余进可裁桶，按裁剪优先级（skipped 最先）排序后裁掉多余的老行。
      const protect = [];
      const trimmable = [];
      for (let i = 0; i < lines.length; i += 1) {
        const rec = parseReplayLine(lines[i].trim());
        if (rec === null) { trimmable.push({ i, priority: 0, rec: null }); continue; } // 坏行：可裁（与旧口径一致）
        // 放弃永久留痕：所有 abandoned 行都保留（含已出内存 abandoned 封顶的旧行——abandonedCount
        // 靠重放全部 abandoned 行累计，裁掉即重启后少算）；未恢复区间按当前 pending 集保留。
        if (rec.outcome === "abandoned" || protectedKeys.has(keyOf(rec.sessionId, rec.from, rec.to))) {
          protect.push({ i, priority: -1, rec });
        } else {
          trimmable.push({ i, priority: trimPriorityOf(rec.outcome), rec });
        }
      }
      // 可裁桶排序：先按裁剪优先级升序（skipped 排最前 = 最先被裁），同优先级保持原行序
      // （稳定排序，行序即时间序：同优先级内先裁更旧的）。排序键以 i 做最终 tie-break，
      // 不依赖引擎的排序稳定性。
      trimmable.sort((a, b) => (a.priority - b.priority) || (a.i - b.i));
      // 排在队首的先被裁掉；留下的是队尾这批（同优先级 = 更近的，跨优先级 = 更不该裁的）。
      // 可裁窗口恒为 keepEff：强制保留行另占盘上行数（"永不裁"的代价），与旧口径一致。
      const trimCount = Math.max(0, trimmable.length - keepEff);
      const keptIdx = new Set();
      for (const item of protect) keptIdx.add(item.i);
      for (let k = trimCount; k < trimmable.length; k += 1) keptIdx.add(trimmable[k].i);
      // 输出按原行序（重放靠顺序判定区间是否被更晚记录补上，乱序会误判——只裁不排）。
      const kept = [];
      for (let i = 0; i < lines.length; i += 1) {
        if (keptIdx.has(i)) kept.push(lines[i]);
      }
      writeAtomic(file, kept.map((l) => `${l}\n`).join(""));
      protectedCount = protect.length;
      lineCount = kept.length;
      safeLog.info(`journal: 轮转 ${lines.length} → ${kept.length} 行（rotateAt=${rotateAtEff}；强制保留放弃/未恢复 ${protectedCount} 行）`);
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
      // 强制保留的放弃/未恢复行（protectedCount）不占可裁窗口，故触发线放宽到
      // rotateAt + protectedCount，避免它们在场时每追加一条就反复整档重写。
      if (lineCount >= rotateAtEff + protectedCount) rotate();
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

  /** 已放弃区间（新在前，封顶 abandonedMax）：结构性失败连续多次后显式放弃、不再重试的区间。
   *  顺序显式定义（at 降序、同 at 用入列 seq 降序），不依赖 unshift 的隐式顺序——同刻放弃
   *  从盘上重放时收集序仍确定（同输入两次运行产出同一顺序）。 */
  function getAbandoned() {
    return abandoned
      .map((a) => ({ ...a }))
      .sort((x, y) => {
        const tx = Date.parse(x.at ?? "") || 0;
        const ty = Date.parse(y.at ?? "") || 0;
        return (ty - tx) || ((y.seq ?? 0) - (x.seq ?? 0));
      })
      .map(({ seq: _drop, ...rest }) => rest); // seq 仅内部定序用，不外露
  }

  /** 面板/端点快照：最近结算 + 未恢复失败区间 + 已放弃区间（封顶）+ 累计放弃次数。 */
  function snapshot() {
    return { runs: getRing(), unrecovered: getUnrecovered(), abandoned: getAbandoned(), abandonedCount };
  }

  replay();
  return { recordRun, getCursor, getRing, getUnrecovered, snapshot };
}

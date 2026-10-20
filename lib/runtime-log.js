// dsh-keepsake 运行时记忆层的观测日志（RUNTIME-FORMAT §九 / §6.2-6）。
//
// 两份独立的 JSONL，刻意不复用 lib/journal.js：提取结算 journal 的 sessionId 是必填
// 字段（空值抛 TypeError），而编译没有会话概念——硬套会让每次编译都炸，或被迫塞假会话 id
// 污染提取侧的续提状态。故本文件只做「按行追加 + 行数轮转」的最小实现。
//
// 文件位置与生命周期（二者刻意不同）：
//   - <storageRoot>/runtime/compile-journal.jsonl —— 编译观测；runtime/ 整目录可删，
//     删了只丢观测历史，不影响任何记忆（下次编译自动重建）。
//   - <storageRoot>/evict-audit.jsonl —— 「已执行归档」的唯一持久记录；**不在 runtime/ 下**，
//     不随 runtime/ 清理消失（审计可追溯性不可与派生产物同生命周期）。
//
// 轮转口径（RUNTIME-FORMAT §九、§6.2-9）：
//   compile-journal 达 2000 行轮转留尾 1000；evict-audit 达 5000 行轮转留尾 2500。
//   「达」= 追加后行数 >= 阈值即转（与 lib/journal.js 同口径），留尾按行序（新行在后）。
//   轮转走 tmp+rename 原子重写（口径同 global-store.js writeAtomic），中断不留半截主档；
//   tmp 名带 `.tmp-`，与 sweepTmpOrphans 的认领规则同名（扫描面纳入 runtime/ 的改动
//   在存储层批次，本文件不依赖它，残留 tmp 不影响任何读取）。
//
// 性能：追加是热路径，行数用「size+mtime 对账的缓存」维护——每条都整档读回数行会退化成
//   O(n²)（5001 条实测 30s+）；对账不匹配（别的进程写过/轮转过/手改过）就整档重读一次。
//   轮转次数本身与留尾行数同阶，整档重写只在每次轮转时发生一次。
//
// 失败语义：本模块**不吞错**——写日志失败原样抛给调用方；
//   编译链路（lib/runtime.js）自行决定「journal 失败只 warn 不阻断编译」，
//   审计链路（归档执行）则应按硬失败处理。吞在这里会让两种语义再也分不开。
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const COMPILE_JOURNAL_FILE_NAME = "compile-journal.jsonl";
export const EVICT_AUDIT_FILE_NAME = "evict-audit.jsonl";
export const COMPILE_JOURNAL_ROTATE_AT = 2000;
export const COMPILE_JOURNAL_KEEP = 1000;
export const EVICT_AUDIT_ROTATE_AT = 5000;
export const EVICT_AUDIT_KEEP = 2500;
/** trigger 枚举（不含 write：写盘只失效缓存，真正编译发生在注入/面板/手动）。 */
export const COMPILE_TRIGGERS = Object.freeze(["inject", "panel", "manual"]);

function nonNegInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function timestampOf(value, now) {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return new Date(now).toISOString();
}

/** 原子写（tmp+rename；失败清 tmp，不掩盖原始错误）。 */
function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch { /* 清理失败不掩盖原始错误 */ }
    throw error;
  }
}

/** 读全文件为行数组（末尾空行丢弃）；文件不存在返回 []。其它读失败原样抛。 */
function readLines(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").filter((line) => line.trim().length > 0);
}

/**
 * 行数缓存（path → { size, mtimeMs, lines }）。
 * 追加是热路径：每条都整档读回数行会退化成 O(n²)（实测 5001 条要 30s+）。
 * 故缓存「该大小/该 mtime 下已知多少行」，追加前用 stat 对账——
 * 对不上（别的进程写过/轮转过/手改过）就整档重读，绝不用过期计数做轮转判断。
 */
const lineCountCache = new Map();

/** 缓存对账：返回该文件当前行数（缓存命中需 size+mtime 双匹配，否则整档重读）。 */
function currentLineCount(path) {
  let st;
  try {
    st = statSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  const cached = lineCountCache.get(path);
  if (cached !== undefined && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.lines;
  const lines = readLines(path).length;
  lineCountCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, lines });
  return lines;
}

/**
 * 追加后对账：磁盘增量恰等于本次追加的字节数 → 行数可信（before+1）；
 * 否则说明期间有别的进程追加/手改，整档重读一次再记。
 */
function settleLineCount(path, before, appendedBytes) {
  try {
    const st = statSync(path);
    const lines = st.size === before.size + appendedBytes ? before.lines + 1 : readLines(path).length;
    lineCountCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, lines });
    return lines;
  } catch {
    lineCountCache.delete(path); // 记不上就下次重读（保守，不影响正确性）
    return 0;
  }
}

/**
 * 追加一行并按行数轮转。
 * 轮转在追加后同步执行：读回主档、保留尾部 keep 行、tmp+rename 原子重写。
 * 「达」= 追加后行数 >= rotateAt（上限语义，主档因此恒定 < rotateAt + 1）。
 * @returns 实际写入的条目对象
 */
function appendWithRotation(path, record, { rotateAt, keep }) {
  mkdirSync(dirname(path), { recursive: true });
  let before;
  try {
    before = statSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    before = { size: 0, mtimeMs: -1 };
  }
  const beforeLines = currentLineCount(path);
  const payload = `${JSON.stringify(record)}\n`;
  appendFileSync(path, payload, "utf8");
  const appended = Buffer.byteLength(payload, "utf8");
  const after = settleLineCount(path, { size: before.size, lines: beforeLines }, appended);
  if (after >= rotateAt) {
    const lines = readLines(path);
    const kept = lines.slice(-keep);
    writeAtomic(path, kept.length > 0 ? `${kept.join("\n")}\n` : "");
    try {
      const st = statSync(path);
      lineCountCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, lines: kept.length });
    } catch {
      lineCountCache.delete(path);
    }
  }
  return record;
}

/**
 * 追加一条编译观测。
 * 行形态（字段名是契约，面板/排障按此读）：
 *   { at, scope, trigger, selected, candidates, overQuota, bytes:{user,memory}, sourceHash }
 * 宽容归一：trigger 非法回落 "inject"（观测行不该因调用方拼错而丢）；
 * 数值字段钳为非负整数；at 可给 ISO 字符串/毫秒/省略（省略=当前时刻）。
 */
export function appendCompileJournal(storageRoot, entry) {
  const raw = entry !== null && typeof entry === "object" ? entry : {};
  const bytes = raw.bytes !== null && typeof raw.bytes === "object" ? raw.bytes : {};
  const record = {
    at: timestampOf(raw.at, Date.now()),
    scope: typeof raw.scope === "string" ? raw.scope : "",
    trigger: COMPILE_TRIGGERS.includes(raw.trigger) ? raw.trigger : "inject",
    selected: nonNegInt(raw.selected),
    candidates: nonNegInt(raw.candidates),
    overQuota: raw.overQuota === true,
    bytes: { user: nonNegInt(bytes.user), memory: nonNegInt(bytes.memory) },
    sourceHash: typeof raw.sourceHash === "string" ? raw.sourceHash : "",
  };
  return appendWithRotation(join(storageRoot, "runtime", COMPILE_JOURNAL_FILE_NAME), record, {
    rotateAt: COMPILE_JOURNAL_ROTATE_AT,
    keep: COMPILE_JOURNAL_KEEP,
  });
}

/**
 * 追加一条归档执行审计（持久记录，落 storageRoot 直下，不随 runtime/ 删除）。
 * 行形态：{ at, scope, rootKey, file, from, to, snapshot, actor }
 * rootKey/file 原样记录（这是审计，不做路径净化改写——要能对上执行前的候选清单）。
 */
export function appendEvictAudit(storageRoot, entry) {
  const raw = entry !== null && typeof entry === "object" ? entry : {};
  const str = (v) => (typeof v === "string" ? v : "");
  const record = {
    at: timestampOf(raw.at, Date.now()),
    scope: str(raw.scope),
    rootKey: str(raw.rootKey),
    file: str(raw.file),
    from: str(raw.from),
    to: str(raw.to),
    snapshot: str(raw.snapshot),
    actor: str(raw.actor).length > 0 ? str(raw.actor) : "panel",
  };
  return appendWithRotation(join(storageRoot, EVICT_AUDIT_FILE_NAME), record, {
    rotateAt: EVICT_AUDIT_ROTATE_AT,
    keep: EVICT_AUDIT_KEEP,
  });
}

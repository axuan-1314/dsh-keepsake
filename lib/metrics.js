/**
 * 提取管道失败计数器（P-PIPE1 修复的共享观测面）。
 *
 * 进程内单例；提取路径（lib/index.js）在失败点 bump，
 * /dsh-memory/api/state 端点（lib/api.js）快照暴露给面板/门牌。
 * 面板侧对字段 tolerant（缺字段=旧版本宿主）。
 *
 * reason 枚举（与 index.js 失败点一一对应）：
 * - "no-route"     双路路由捕获皆失手（结构性）
 * - "no-cwd"       会话无 cwd（结构性）
 * - "llm-error"    LLM 调用失败/超时
 * - "parse-error"  输出解析失败（整批拒收时）
 * - "io-error"     落盘 IO 失败
 */
const COUNTER_KEYS = ["no-route", "no-cwd", "llm-error", "parse-error", "io-error"];

const counters = Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0]));
const streak = { reason: "", count: 0 };

/** 失败一次：累加原因桶，并维护同因连击（成功路径调 resetStreak 清零）。 */
export function bumpExtractionFailure(reason) {
  if (!Object.prototype.hasOwnProperty.call(counters, reason)) reason = "llm-error";
  counters[reason] += 1;
  if (streak.reason === reason) streak.count += 1;
  else { streak.reason = reason; streak.count = 1; }
  return streak.count;
}

/** 任一成功落盘后调用：清零同因连击（计数桶保留累计值）。 */
export function resetExtractionFailureStreak() {
  streak.reason = "";
  streak.count = 0;
}

/** /state 端点快照：各原因累计 + 当前同因连击（供结构性失败断链与面板展示）。 */
export function extractionFailureSnapshot() {
  return { ...counters, streak: streak.count, streakReason: streak.reason };
}

/** 测试专用：全量复位。 */
export function __resetMetricsForTest() {
  for (const k of COUNTER_KEYS) counters[k] = 0;
  streak.reason = "";
  streak.count = 0;
}

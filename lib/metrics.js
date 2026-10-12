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
 *
 * 计数粒度分层（批F1 E-4）：
 * - retried：重试 attempt 粒度（一次 extractSession 内第 2/3/… 次 attempt 各 +1，
 *   与 llm-error 的 extractSession 粒度有意不同——同一次会话提取可既 retried 又 llm-error）；
 * - lastRecoveredAt：一次「有失败尝试」的提取最终成功落盘时打的时间戳（黄态依据，
 *   无失败尝试的成功不打，保持"retry 真的救了场"语义）。
 */
const COUNTER_KEYS = ["no-route", "no-cwd", "llm-error", "parse-error", "io-error"];

const counters = Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0]));
const streak = { reason: "", count: 0 };
// retried：重试 attempt 粒度（见上注）。fallbackUsed：换道次数（批F2 才真正
// 自增，此处恒 0 但字段必须在——/state 契约要求双端同形，缺失=旧版）。
const retryState = { retried: 0, fallbackUsed: 0, lastRecoveredAt: null };
// 批F2 观测面（方案 §三·补 host 契约）：
// - recent：最近失败详情环形缓冲（新在前，≤5 条）——面板健康卡与破案用；
// - lastFailedRange：当前未恢复的失败区间（成功/无失败=null）——U3「错过的轮次」提示；
// - inFlight：进程内有提取在途（含退避 sleep）——UI「提取中…」与 retry 409 判据；
// - lastAttemptAt / lastUsedRoute：最近一次真实提取调用的时刻与用车（U4 主数据源）。
const RECENT_MAX = 5;
const obsState = {
  recent: [],
  lastFailedRange: null,
  inFlight: false,
  lastAttemptAt: null,
  lastUsedRoute: null,
};
// 批次A 注入面（v0.2.0 消息通道注入）：四段注入迁到 durable 消息通道后，注入健康
// 显式化——每次成功注入记账、渲染/注入异常另计，/state.injection 快照暴露给面板/门牌。
// 字段恒在（缺失=旧版宿主），延续批F2「/state 契约双端同形」口径。
// - count：成功注入次数；lastChars：最近一次注入字符数；totalChars：累计注入字符数；
// - resends：因内容变化补发（而非首注）的次数；droppedSegments：预算裁剪丢弃的整段累计；
// - renderFailures：渲染/注入异常次数；lastAt：最近一次成功注入时刻。
const injectState = {
  count: 0,
  lastChars: 0,
  totalChars: 0,
  resends: 0,
  droppedSegments: 0,
  renderFailures: 0,
  lastAt: null,
};

/** 失败一次：累加原因桶，并维护同因连击（成功路径调 resetStreak 清零）。 */
export function bumpExtractionFailure(reason) {
  if (!Object.prototype.hasOwnProperty.call(counters, reason)) reason = "llm-error";
  counters[reason] += 1;
  if (streak.reason === reason) streak.count += 1;
  else { streak.reason = reason; streak.count = 1; }
  return streak.count;
}

/**
 * 失败详情入环形缓冲（批F2）：与 bumpExtractionFailure 同点调用（index.js 的
 * noteFailure 收口），新在前、超过 RECENT_MAX 裁尾。provider/model/message 全部
 * 可选——no-route/no-cwd 类结构性失败没有路由信息。
 */
export function pushRecentFailure({ reason, message = "", provider = "", model = "" } = {}) {
  obsState.recent.unshift({
    reason: typeof reason === "string" && reason.length > 0 ? reason : "llm-error",
    at: Date.now(),
    provider: String(provider ?? "").slice(0, 80),
    model: String(model ?? "").slice(0, 120),
    message: String(message ?? "").slice(0, 200),
  });
  if (obsState.recent.length > RECENT_MAX) obsState.recent.length = RECENT_MAX;
}

/** 记录当前未恢复的失败区间（U3：成功时必须 clearExtractionFailureRange 清掉）。 */
export function setExtractionFailedRange(from, to) {
  obsState.lastFailedRange = { from, to };
}

/** 任一成功路径调用：区间不再承诺补提，null 化（防 UI 显示陈旧的「未记录」）。 */
export function clearExtractionFailedRange() {
  obsState.lastFailedRange = null;
}

/** 提取在途标记（含重试退避窗；extractSession 的 LLM 段入口/finally 收口）。 */
export function setExtractionInFlight(flag) {
  obsState.inFlight = flag === true;
}

/** 每次真实发起提取 LLM 调用时记录（U4「最近一次提取用车」的唯一真值来源）。 */
export function noteExtractionAttempt({ provider = "", model = "" } = {}) {
  const now = Date.now();
  obsState.lastAttemptAt = now;
  obsState.lastUsedRoute = { provider: String(provider ?? ""), model: String(model ?? ""), at: now };
}

/** 任一成功落盘后调用：清零同因连击（计数桶保留累计值）。 */
export function resetExtractionFailureStreak() {
  streak.reason = "";
  streak.count = 0;
}

/**
 * 重试 attempt 计数（E-4）：每次进入重试 attempt（第 2 次起的每次）调用一次。
 * 与 bumpExtractionFailure 的 extractSession 粒度刻意分层，见文件头注。
 */
export function bumpRetryAttempt() {
  retryState.retried += 1;
  return retryState.retried;
}

/**
 * 恢复时间戳（E-4）：一次有失败尝试的提取最终成功落盘时调用。
 * 无失败尝试的成功不应打点（否则"恢复"语义被稀释成"每次成功"）。
 */
export function noteExtractionRecovered() {
  retryState.lastRecoveredAt = Date.now();
}

/** /state 端点快照：各原因累计 + 当前同因连击 + 重试/换道/恢复面 + 观测面（批F1 E-4 + 批F2）。 */
export function extractionFailureSnapshot() {
  return {
    ...counters,
    retried: retryState.retried,
    fallbackUsed: retryState.fallbackUsed,
    streak: streak.count,
    streakReason: streak.reason,
    lastRecoveredAt: retryState.lastRecoveredAt,
    recent: obsState.recent.map((r) => ({ ...r })),
  };
}

/** /state 顶层观测字段快照（批F2；与 extractionFailures 分开供 API 组装）。 */
export function extractionObservationSnapshot() {
  return {
    lastFailedRange: obsState.lastFailedRange === null ? null : { ...obsState.lastFailedRange },
    extractionInFlight: obsState.inFlight,
    lastAttemptAt: obsState.lastAttemptAt,
    lastUsedRoute: obsState.lastUsedRoute === null ? null : { ...obsState.lastUsedRoute },
  };
}

// ---- 注入面（批次A）：成功注入记账 + 异常计数 + 快照 ----

/**
 * 成功注入一次（批次A）：count+1、记录最近/累计字符，resend 为真记补发，
 * dropped 里的整段计入丢弃累计，打成功时刻。任何字段缺失一律按 0/false 处理。
 * @param {{chars?: number, dropped?: string[], resend?: boolean}} [opts]
 */
export function recordInjection({ chars = 0, dropped = [], resend = false } = {}) {
  const n = Number(chars);
  const c = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  injectState.count += 1;
  injectState.lastChars = c;
  injectState.totalChars += c;
  if (resend === true) injectState.resends += 1;
  if (Array.isArray(dropped)) injectState.droppedSegments += dropped.length;
  injectState.lastAt = Date.now();
}

/** 渲染/注入异常记一次（批次A；异常不炸宿主轮次，此处只 bump 计数供观测）。 */
export function recordInjectionError() {
  injectState.renderFailures += 1;
}

/** /state.injection 快照（批次A）：返回拷贝，外部改返回值不影响内部态（字段恒在）。 */
export function injectionSnapshot() {
  return { ...injectState };
}

/** 测试专用：全量复位。 */
export function __resetMetricsForTest() {
  for (const k of COUNTER_KEYS) counters[k] = 0;
  streak.reason = "";
  streak.count = 0;
  retryState.retried = 0;
  retryState.fallbackUsed = 0;
  retryState.lastRecoveredAt = null;
  obsState.recent = [];
  obsState.lastFailedRange = null;
  obsState.inFlight = false;
  obsState.lastAttemptAt = null;
  obsState.lastUsedRoute = null;
  injectState.count = 0;
  injectState.lastChars = 0;
  injectState.totalChars = 0;
  injectState.resends = 0;
  injectState.droppedSegments = 0;
  injectState.renderFailures = 0;
  injectState.lastAt = null;
}

// ---- 失败分类（批F1 E-1：route on code, never by parsing message）----

/**
 * 可重试失败 code 集——对齐内核 dsh-llm DEFAULT_RETRYABLE_CODES
 * （dsh-llm/lib/index.js:251-257）：瞬时/可重复的失败族。
 * AUTH / INVALID_REQUEST / QUOTA 等一律不在集内：重试只会原样再失败。
 */
export const RETRYABLE_FAILURE_CODES = Object.freeze(["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"]);

/**
 * code 缺失/非字符串时的保守消息兜底（最后手段，永不首选）：
 * 内核明令 route on code；仅当 failure 没带可用 code 才退到这一步。
 * 命中即"倾向可重试"，未命中同样按不可重试处理——宁可漏一次重试，
 * 不对确定性的 AUTH/INVALID_REQUEST 类失败浪费 attempt。
 */
const RETRYABLE_MESSAGE_HINTS = /429|rate[_\s-]?limit|5\d\d|timeout|timed[_\s-]?out|connection|transport|unavailable|temporar/i;

/**
 * 判断一次 LLM 失败是否值得进程内重试（E-1，route on code, never by parsing message）。
 *
 * 分类顺序（不可 swap）：
 *   1. failure.code 是字符串 → 只按 RETRYABLE_FAILURE_CODES 表决，绝不看 message；
 *      内核 HarnessError 明令 code 是唯一 machine-routable 判据
 *      （dsh-llm/lib/index.js:127 "route on this, never by parsing message"），
 *      实测 13 个真实 code 族里 message 正则只命中 3 个。
 *   2. code 缺失/非字符串 → 退保守正则兜底（最后手段；2026-10-09 现场证据：
 *      真实 429 的 failure.code 是 null，message 才是唯一线索）。
 * @param failure finish.reason.failure 原样（可为 undefined）
 * @param {string} [extraText] 附加判据文本（error.message 摘要；仅兜底路径参与）
 * @returns {boolean} 无 code 且无任何提示文本时一律 false（宁可漏重试，不赌）
 */
export function isRetryableFailure(failure, extraText = "") {
  const code = failure?.code;
  if (typeof code === "string" && code.length > 0) {
    return RETRYABLE_FAILURE_CODES.includes(code);
  }
  const text = `${typeof failure?.message === "string" ? failure.message : ""} ${extraText}`;
  return text.trim().length > 0 && RETRYABLE_MESSAGE_HINTS.test(text);
}

// ---- 重试退避（批F1 E-3 纯函数，抽在 metrics.js 与 isRetryableFailure 同文件：
//      两者都是"metrics/重试策略"关心的无 IO 判据，供 index.js 与单测共用）----

/**
 * 从 failure 上取 provider 侧的 retry-after 提示（RATE_LIMIT 常见，单位毫秒）。
 * 仅接受有限正整数，防 NaN/负数/超大值污染退避链。
 * @returns {number|null}
 */
export function providerRetryAfterMs(failure) {
  const raw = failure?.providerRetryAfterMs;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) return null;
  return raw;
}

/**
 * 计算第 n 次重试的退避毫秒数（n 从 1 起：1 = 第一次重试前的退避）。
 *
 * 指数退避：base * 2^(n-1)，钳到 maxDelay；jitter ±jitterRatio（默认 ±20%，符号
 * 由 rnd ∈ [0,1) 决定——rand 从外部注入，测试可钉范围与确定值）。
 * providerRetryAfterMs 存在且有限时优先用它（长限流窗口别用本地短退避白撞），
 * 但仍钳 ≤ 3*maxDelay 防恶意/异常长等待把 drain 预算烧穿。
 * @param {number} n 第几次重试（≥1）
 * @param {{backoffMs:number, maxDelayMs:number, jitterRatio?:number, rand?:()=>number}} opts
 * @param {object} [failure] finish.reason.failure（可带 providerRetryAfterMs）
 * @returns {number} 退避毫秒数（整数，≥1）
 */
export function retryDelayMs(n, { backoffMs, maxDelayMs, jitterRatio = 0.2, rand = Math.random }, failure) {
  const attempt = Number.isInteger(n) && n >= 1 ? n : 1;
  const provided = providerRetryAfterMs(failure);
  if (provided !== null) {
    return Math.max(1, Math.min(provided, 3 * maxDelayMs));
  }
  const base = Math.min(backoffMs * 2 ** (attempt - 1), maxDelayMs);
  const low = base * (1 - jitterRatio);
  const high = base * (1 + jitterRatio);
  const jittered = low + (high - low) * (Number.isFinite(rand) ? Math.min(Math.max(rand, 0), 1) : 0.5);
  return Math.max(1, Math.round(jittered));
}

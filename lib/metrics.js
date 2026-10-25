/**
 * 提取管道失败计数器（共享观测面）。
 *
 * 进程内单例；提取路径（lib/index.js）在失败点 bump，
 * /dsh-keepsake/api/state 端点（lib/api.js）快照暴露给面板/门牌。
 * 面板侧对字段 tolerant（缺字段=旧版本宿主）。
 *
 * reason 枚举（与 index.js 失败点一一对应）：
 * - "no-route"     双路路由捕获皆失手（结构性）
 * - "no-cwd"       会话无 cwd（结构性）
 * - "llm-error"    LLM 调用失败/超时
 * - "parse-error"  输出解析失败（整批拒收时）
 * - "io-error"     落盘 IO 失败
 *
 * 计数粒度分层：
 * - retried：重试 attempt 粒度（一次 extractSession 内第 2/3/… 次 attempt 各 +1，
 *   与 llm-error 的 extractSession 粒度有意不同——同一次会话提取可既 retried 又 llm-error）；
 * - reasoningDegraded：宿主拒绝显式思考档（UNSUPPORTED_REASONING_EFFORT）后的降级重发次数，
 *   与 retried/fallbackUsed 同层（见 bumpReasoningDegraded）；
 * - escapeRetried：零正文 max-tokens 后**丢弃显式输出上限、改跟随模型**重发且拿到正文
 *   的次数（结果处计数，发起不计——发起≠成功），与 reasoningDegraded 同层但语义不同
 *   （运行面思考吃光预算 vs 配置面档位不被支持）。
 *   注意"丢档位"救不了这个问题：实测不传 reasoningEffort 时模型照样思考。
 * - extractionTokens：提取 LLM 调用的 token/成本面（进程内累计；calls 与 token 分开口径，
 *   见 bumpExtractionTokens——输出预算跟随模型后的成本放大必须看得见）；
 * - lastRecoveredAt：一次「有失败尝试」的提取最终成功落盘时打的时间戳（黄态依据，
 *   无失败尝试的成功不打，保持"retry 真的救了场"语义）。
 */
const COUNTER_KEYS = ["no-route", "no-cwd", "llm-error", "parse-error", "io-error"];

const counters = Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0]));
// 同因连击按【会话】分键：一个会话的连败不该把另一个会话顶到"放弃线"（streak≥5）。
// 键 = sessionId；值 = { reason, count }。空 sessionId 归到 ""（结构性失败无会话时的兜底桶）。
const streaks = new Map();
const STREAK_SESSIONS_MAX = 200; // 防长进程会话无限累积（超上限丢最旧）
// retried：重试 attempt 粒度（见上注）。fallbackUsed：换道次数（换道接线后才真正
// 自增，此处恒 0 但字段必须在——/state 契约要求双端同形，缺失=旧版）。
// reasoningDegraded：宿主以 UNSUPPORTED_REASONING_EFFORT 拒绝显式思考档、本次丢弃参数
// 重发的次数（每次真实发生一次 +1；同路由记住能力边界后不再撞，故不会每轮重复计）。
// escapeRetried：零正文 max-tokens 触发"丢显式输出上限、改跟随模型"重发**且拿到正文**
// 的次数（在成功返回点计数，不在发起处——发起≠成功，否则逃逸失败时健康卡会同时显示
// "提取失败"与"重发成功"，复查抓过这个谎报）。注意它不是"丢思考档就能救"——本机实测
// （magpie/group/mozu1）不传 reasoningEffort 时模型照样思考，档位不是思考的开关。
// 放 retryState 同层：四者都是"进程内一次观测性自增"，面板按同一种分桶读。
const retryState = { retried: 0, fallbackUsed: 0, reasoningDegraded: 0, escapeRetried: 0, lastRecoveredAt: null };
// 观测面（host 契约）：
// - recent：最近失败详情环形缓冲（新在前，≤5 条）——面板健康卡与破案用；
// - lastFailedRange：当前未恢复的失败区间（成功/无失败=null）——「错过的轮次」提示；
// - inFlight：进程内有提取在途（含退避 sleep）——UI「提取中…」与 retry 409 判据；
// - lastAttemptAt / lastUsedRoute：最近一次真实提取调用的时刻与用车。
const RECENT_MAX = 5;
const obsState = {
  recent: [],
  lastFailedRange: null,
  inFlight: false,
  lastAttemptAt: null,
  lastUsedRoute: null,
};
// 注入面（v0.2.0 消息通道注入）：四段注入迁到 durable 消息通道后，注入健康
// 显式化——每次成功注入记账、渲染/注入异常另计，/state.injection 快照暴露给面板/门牌。
// 同源替换三件套落地后新增两个计数（v0.5.0）：
//   - throttled：变化太小被节流、本轮没有补发的累计（"少发"是宿主 append-only 历史下
//     唯一的收敛手段；不发但记一笔，节流在干活才看得见）；
//   - superseded：本进程内被「取代声明」作废的旧块次数累计（发新块即有旧块被作废；
//     首发时视野里没有旧块可取代，不计）。
// 两者与 count/resends 的分层：count/resends 记"发了"，throttled/superseded 记
// "为什么没发/发了之后意味着什么"——四个数放一起才回答得出"注入通道收敛了没有"。
// 字段恒在（缺失=旧版宿主），延续「/state 契约双端同形」口径。
// - count：成功注入次数；lastChars：最近一次注入字符数；totalChars：累计注入字符数；
// - lastTokens/totalTokens：最近一次与累计的 token 预算占用（CJK 感知估算，见 lib/tokens.js）；
// - resends：因内容变化补发（而非首注）的次数；droppedSegments：预算裁剪丢弃的整段累计；
// - compactedSegments：预算裁剪时降级为紧凑索引的段累计（没丢，但内容被压缩）；
// - throttled：变化太小被节流掉的次数（见上注）；superseded：被取代声明作废的旧块次数；
// - renderFailures：渲染/注入异常次数；lastAt：最近一次成功注入时刻。
const injectState = {
  count: 0,
  lastChars: 0,
  totalChars: 0,
  lastTokens: 0,
  totalTokens: 0,
  resends: 0,
  droppedSegments: 0,
  compactedSegments: 0,
  throttled: 0,
  superseded: 0,
  renderFailures: 0,
  lastAt: null,
};

// 召回面（嵌入语义召回）：召回命中/空/失败三态显式可见，延续「/state 契约双端同形」口径。
// - hits：召回块注入次数（有命中并注入）；items：累计召回条目数；chars：累计召回字符；
// - misses：本轮无命中（降级不注入）；errors：嵌入/检索异常（降级不注入）；lastAt：最近一次有命中时刻。
const recallState = {
  hits: 0,
  items: 0,
  chars: 0,
  misses: 0,
  errors: 0,
  lastAt: null,
};

/** 失败一次：累加原因桶，并维护【按会话】同因连击（成功路径调 resetStreak 清零）。 */
export function bumpExtractionFailure(reason, sessionId = "") {
  if (!Object.prototype.hasOwnProperty.call(counters, reason)) reason = "llm-error";
  counters[reason] += 1;
  const key = typeof sessionId === "string" ? sessionId : "";
  let entry = streaks.get(key);
  if (entry === void 0) {
    entry = { reason: "", count: 0 };
    // 键数上限：超限丢最旧（Map 迭代序=插入序），防长进程会话无限累积。
    if (streaks.size >= STREAK_SESSIONS_MAX) {
      const oldest = streaks.keys().next().value;
      if (oldest !== void 0) streaks.delete(oldest);
    }
    streaks.set(key, entry);
  }
  if (entry.reason === reason) entry.count += 1;
  else { entry.reason = reason; entry.count = 1; }
  return entry.count;
}

/** 当前最强连击（跨会话取最大）+ 其 reason：/state 顶层 streak 的对外口径。 */
function maxStreak() {
  let count = 0;
  let reason = "";
  for (const entry of streaks.values()) {
    if (entry.count > count) { count = entry.count; reason = entry.reason; }
  }
  return { count, reason };
}

/**
 * 失败详情入环形缓冲：与 bumpExtractionFailure 同点调用（index.js 的
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

/** 记录当前未恢复的失败区间（成功时必须 clearExtractionFailureRange 清掉）。 */
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

/** 每次真实发起提取 LLM 调用时记录（「最近一次提取用车」的唯一真值来源）。 */
export function noteExtractionAttempt({ provider = "", model = "" } = {}) {
  const now = Date.now();
  obsState.lastAttemptAt = now;
  obsState.lastUsedRoute = { provider: String(provider ?? ""), model: String(model ?? ""), at: now };
}

/** 会话成功一次：清零【该会话】的同因连击（计数桶保留累计值）。
 *  sessionId 缺省（无会话上下文）→ 全清（兜底；正常调用始终带会话，避免清掉别的会话的连击）。 */
export function resetExtractionFailureStreak(sessionId = void 0) {
  if (typeof sessionId === "string") streaks.delete(sessionId);
  else streaks.clear();
}

/**
 * 重试 attempt 计数：每次进入重试 attempt（第 2 次起的每次）调用一次。
 * 与 bumpExtractionFailure 的 extractSession 粒度刻意分层，见文件头注。
 */
export function bumpRetryAttempt() {
  retryState.retried += 1;
  return retryState.retried;
}

/**
 * 换道计数：主道 attempt 链耗尽后，某条 fallback 路由调用成功时自增一次。
 * 面板分桶键 EXTRACTION_BUCKET_KEYS 已含 `fallbackUsed`（预留位，接线后自增）。
 */
export function bumpFallbackUsed() {
  retryState.fallbackUsed += 1;
  return retryState.fallbackUsed;
}

/**
 * 思考档降级计数：宿主以 UNSUPPORTED_REASONING_EFFORT 拒绝显式档位、插件丢弃参数
 * 重发一次时自增。放在 retryState 里与 retried/fallbackUsed 同层（同种观测粒度）。
 *
 * 为什么必须计数：这次重发是本可避免的额外往返（用户配的档位不被该路由支持），
 * 只打 log.warn 的话 /state 与面板都看不见"每次提取都在白撞一次"。计数后
 * "该换个档位/干脆别配"才有据可依。
 */
export function bumpReasoningDegraded() {
  retryState.reasoningDegraded += 1;
  return retryState.reasoningDegraded;
}

/**
 * 零正文逃逸计数：`finish.kind=max-tokens` 且累计正文为空时，丢弃思考档重发一次时自增。
 *
 * 为什么必须计数：本机实测（magpie/group/mozu1，网关 127.0.0.1:3425）确认
 * **思考 token 与正文共享同一个 maxTokens 预算**，且思考链先跑——预算不够时
 * 正文必然为零。此前这条路径直接判死（llm-error），用户只看到"提取失败"，
 * 看不出"是思考把预算吃光了"。计数后 /state 与面板能回答"这轮是不是靠丢档救回来的"。
 * 与 reasoningDegraded 的区别：后者记"配了不支持的档位"（配置面问题），
 * 本计数记"档位支持但思考吃光预算"（运行面问题），两类不可合并。
 */
export function bumpEscapeRetried() {
  retryState.escapeRetried += 1;
  return retryState.escapeRetried;
}

/**
 * 恢复时间戳：一次有失败尝试的提取最终成功落盘时调用。
 * 无失败尝试的成功不应打点（否则"恢复"语义被稀释成"每次成功"）。
 */
export function noteExtractionRecovered() {
  retryState.lastRecoveredAt = Date.now();
}

/**
 * 提取 LLM 调用的 token / 成本观测面（进程内累计）。
 *
 * 背景（本批修复的副作用必须看得见）：`maxOutputTokens` 缺省从固定 4096 改成 0 = 跟随模型
 * （本机 mozu1 模型默认 250000，约 61 倍）。模型若仍长思考，单次输出上限同步放大 61 倍，
 * **成本可能被带飞而完全看不见**——因为 `callLlmText` 的流消费只认 `text-delta` 与 `finish`，
 * 宿主的 `usage` chunk 被直接丢弃（app.asar 的 dsh-llm-pi-ai mapUsage 在 finish 之前发出：
 * `{type:"usage", usage:{inputTokens, outputTokens, totalTokens, cacheReadTokens?, cacheWriteTokens?}}`）。
 *
 * 口径（两条必须分开，不许互相顶替）：
 *   - `calls`：真实发起的调用次数——含 UNSUPPORTED_REASONING_EFFORT 后的降级重发第二趟、
 *     含失败途。usage chunk 缺失（旧适配器 / 失败途没走到 usage）时 token 记 0 但**调用仍计数**：
 *     "调了几次"与"花了多少 token"是两个问题，拿不到用量不等于没调用（否则降档白撞的那一趟
 *     在观测面上直接消失，正好看不见最该看见的东西）；
 *   - `input`/`output`/`total`：累计 token。`total` 取宿主 `totalTokens`（它可能含 cache 读写，
 *     与 input+output 不相等），缺失/非法时才回落 `input + output`——不自己凑一个数。
 */
const extractionTokens = { input: 0, output: 0, total: 0, calls: 0 };

/** token 计数归一：非有限数/负数/小数一律 0（脏 usage 不污染累计）。 */
function nonNegToken(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * 记一次真实提取 LLM 调用的用量。
 * @param {object|null} [usage] 宿主 usage chunk 的 usage 原样；null/非对象 = 该次没有用量
 *   （旧适配器或失败途）——calls 照计，token 记 0。
 * @returns {number} 累计调用次数
 */
export function bumpExtractionTokens(usage) {
  extractionTokens.calls += 1;
  const u = usage !== null && typeof usage === "object" ? usage : null;
  if (u === null) return extractionTokens.calls; // 无用量：调用事实仍在，token 不累计
  const input = nonNegToken(u.inputTokens);
  const output = nonNegToken(u.outputTokens);
  const totalRaw = Number(u.totalTokens);
  // 宿主 totalTokens 优先（含 cache 读写时它 ≠ input+output）；非法才回落自算
  const total = Number.isFinite(totalRaw) && totalRaw >= 0 ? Math.floor(totalRaw) : input + output;
  extractionTokens.input += input;
  extractionTokens.output += output;
  extractionTokens.total += total;
  return extractionTokens.calls;
}

/** /state 端点快照：各原因累计 + 当前同因连击 + 重试/换道/降档/恢复面 + 观测面 + token 成本面。 */
export function extractionFailureSnapshot() {
  const top = maxStreak();
  return {
    ...counters,
    retried: retryState.retried,
    fallbackUsed: retryState.fallbackUsed,
    reasoningDegraded: retryState.reasoningDegraded,
    escapeRetried: retryState.escapeRetried,
    streak: top.count,
    streakReason: top.reason,
    lastRecoveredAt: retryState.lastRecoveredAt,
    recent: obsState.recent.map((r) => ({ ...r })),
    extractionTokens: { ...extractionTokens },
  };
}

/** /state 顶层观测字段快照（与 extractionFailures 分开供 API 组装）。 */
export function extractionObservationSnapshot() {
  return {
    lastFailedRange: obsState.lastFailedRange === null ? null : { ...obsState.lastFailedRange },
    extractionInFlight: obsState.inFlight,
    lastAttemptAt: obsState.lastAttemptAt,
    lastUsedRoute: obsState.lastUsedRoute === null ? null : { ...obsState.lastUsedRoute },
  };
}

// ---- 注入面：成功注入记账 + 异常计数 + 快照 ----

/**
 * 成功注入一次：count+1、记录最近/累计字符与 token 占用，resend 为真记补发，
 * dropped 里的整段计入丢弃累计，compacted 里的段计入紧凑降级累计，打成功时刻。
 * 任何字段缺失一律按 0/false 处理。
 * @param {{chars?: number, tokens?: number, dropped?: string[], compacted?: string[], resend?: boolean}} [opts]
 */
export function recordInjection({ chars = 0, tokens = 0, dropped = [], compacted = [], resend = false } = {}) {
  const n = Number(chars);
  const c = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const tRaw = Number(tokens);
  const t = Number.isFinite(tRaw) && tRaw > 0 ? Math.floor(tRaw) : 0;
  injectState.count += 1;
  injectState.lastChars = c;
  injectState.totalChars += c;
  injectState.lastTokens = t;
  injectState.totalTokens += t;
  if (resend === true) injectState.resends += 1;
  if (Array.isArray(dropped)) injectState.droppedSegments += dropped.length;
  if (Array.isArray(compacted)) injectState.compactedSegments += compacted.length;
  injectState.lastAt = Date.now();
}

/** 渲染/注入异常记一次（异常不炸宿主轮次，此处只 bump 计数供观测）。 */
export function recordInjectionError() {
  injectState.renderFailures += 1;
}

/**
 * 同源替换节流记账：本轮判定为「变化太小、不补发」时调一次。
 * 与 recordInjection 分层：这条路【没有】发出消息，故不碰 count/chars——
 * 只让"想发而没发"这件事在 /state.injection.throttled 上可见。
 */
export function recordInjectionThrottled() {
  injectState.throttled += 1;
}

/**
 * 同源取代记账：本次新块凭借块首取代声明作废了视野里的旧块时调一次。
 * 首发不计（没有旧块可取代）；纯节流轮不计（没发新块，谈不上一作废）。
 */
export function recordInjectionSuperseded() {
  injectState.superseded += 1;
}

/** /state.injection 快照：返回拷贝，外部改返回值不影响内部态（字段恒在）。 */
export function injectionSnapshot() {
  return { ...injectState };
}

// ---- 召回面：命中/空/异常 + 快照 ----

/** 召回块注入一次（有命中）：hits+1、累计条目数与字符、打时刻。 */
export function recordRecall({ items = 0, chars = 0 } = {}) {
  recallState.hits += 1;
  recallState.items += Number.isFinite(items) && items > 0 ? Math.floor(items) : 0;
  recallState.chars += Number.isFinite(chars) && chars > 0 ? Math.floor(chars) : 0;
  recallState.lastAt = Date.now();
}

/** 本轮无命中（按阈值/预算裁空）：不注入，计一次 miss。 */
export function recordRecallMiss() {
  recallState.misses += 1;
}

/** 嵌入/检索异常（超时/HTTP 失败等）：降级不注入，计一次 error。 */
export function recordRecallError() {
  recallState.errors += 1;
}

/** /state.recall 快照：返回拷贝（字段恒在）。 */
export function recallSnapshot() {
  return { ...recallState };
}

/** 测试专用：全量复位。 */
export function __resetMetricsForTest() {
  for (const k of COUNTER_KEYS) counters[k] = 0;
  streaks.clear();
  retryState.retried = 0;
  retryState.fallbackUsed = 0;
  retryState.reasoningDegraded = 0;
  retryState.escapeRetried = 0;
  retryState.lastRecoveredAt = null;
  obsState.recent = [];
  obsState.lastFailedRange = null;
  obsState.inFlight = false;
  obsState.lastAttemptAt = null;
  obsState.lastUsedRoute = null;
  injectState.count = 0;
  injectState.lastChars = 0;
  injectState.totalChars = 0;
  injectState.lastTokens = 0;
  injectState.totalTokens = 0;
  injectState.resends = 0;
  injectState.droppedSegments = 0;
  injectState.compactedSegments = 0;
  injectState.throttled = 0;
  injectState.superseded = 0;
  injectState.renderFailures = 0;
  injectState.lastAt = null;
  recallState.hits = 0;
  recallState.items = 0;
  recallState.chars = 0;
  recallState.misses = 0;
  recallState.errors = 0;
  recallState.lastAt = null;
  extractionTokens.input = 0;
  extractionTokens.output = 0;
  extractionTokens.total = 0;
  extractionTokens.calls = 0;
}

// ---- 失败分类（route on code, never by parsing message）----

/**
 * 可重试失败 code 集——对齐内核 dsh-llm DEFAULT_RETRYABLE_CODES
 * （dsh-llm/lib/index.js:251-257）：瞬时/可重复的失败族。
 * AUTH / INVALID_REQUEST / QUOTA 等一律不在集内：重试只会原样再失败。
 *
 * 刻意**不收**自造 code（复查 P0：成本纪律）。曾经加过 OUTPUT_BUDGET_EXHAUSTED
 * （零正文 max-tokens）后又移除：跟随模型（本机 25 万 token 预算）仍零正文在实践中
 * 不可达，为它开链级重采样最坏是 retryAttempts × fallback 条数 次满预算调用
 * （实测 retryAttempts=10 + 3 条 fallback = 84 次）——拿真金白银换一个几乎不存在的
 * 场景不划算。显式配小上限的用户走 callLlmText 的预算逃逸（有界：最多多一次调用），
 * 见 lib/index.js 的 callLlmText 头注。
 */
export const RETRYABLE_FAILURE_CODES = Object.freeze([
  "EMPTY_RESPONSE",
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
]);

/**
 * code 缺失/非字符串时的保守消息兜底（最后手段，永不首选）：
 * 内核明令 route on code；仅当 failure 没带可用 code 才退到这一步。
 * 命中即"倾向可重试"，未命中同样按不可重试处理——宁可漏一次重试，
 * 不对确定性的 AUTH/INVALID_REQUEST 类失败浪费 attempt。
 */
const RETRYABLE_MESSAGE_HINTS = /429|rate[_\s-]?limit|5\d\d|timeout|timed[_\s-]?out|connection|transport|unavailable|temporar/i;

/**
 * 判断一次 LLM 失败是否值得进程内重试（route on code, never by parsing message）。
 *
 * 分类顺序（不可 swap）：
 *   1. failure.code 是字符串 → 只按 RETRYABLE_FAILURE_CODES 表决，绝不看 message；
 *      内核 HarnessError 明令 code 是唯一 machine-routable 判据
 *      （dsh-llm/lib/index.js:127 "route on this, never by parsing message"），
 *      实测 13 个真实 code 族里 message 正则只命中 3 个。
 *   2. code 缺失/非字符串 → 退保守正则兜底（最后手段；现场证据：
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

// ---- 重试退避（纯函数，抽在 metrics.js 与 isRetryableFailure 同文件：
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

// dsh-keepsake — 项目记忆自动提取+注入 cordis 插件入口。
// 订阅面（0.2.0 实测）：ctx.on("session/event", (session, event) => ...)；
//   成功轮结束 = event.type === "turn/end" 且 data.reason.kind === "completed"；
//   主请求路由捕获 = "request/header" 的 data.header.config.{provider,model}。
// 注入面（0.2.0 实测）：ctx.systemPrompt.section({name, order, text: fn, interpolate: false})。
// 提取面（0.2.0 实测）：ctx.llm.stream({provider, model, system, messages, maxTokens,
//   sessionId, purpose, signal})，块 {type:'text-delta', text}，终块 {type:'finish', reason}。
//
// 6 条边界落点（规格）：
//   ① 去抖合并+cursor 推进纪律 → lib/state.js（skip 推进/error 不推进）
//   ② 写入边界 → lib/extract.js applyOps（仅 .md，且 resolveSafeMemoryTarget 包含性强制；
//      v1 由插件代写，模型永不直接碰盘）
//   ③ 文件名安全 → lib/filename.js（包含性+黑名单段+Unicode 控制符剥除）
//   ④ 注入预算 → lib/manifest.js（200 行/25k+WARNING；manifest 前 30 行 frontmatter×
//      mtime 降序前 200）
//   ⑤ 触发门槛 → lib/transcript.js skipReason（≥3 词用户散文；主 agent 直写区间跳过）
//   ⑥ 防自反馈 → 本文件 extract()：request-only 输入、不向任何 session append；
//      abort 按 error 处理不推进；workspace 身份经 session.header.cwd 继承
//
// 扩展（v0.2 全局记忆）：
//   注入段：4990 人设（称呼指令+正文，补充设定）/4995 全局索引（四分类+长期，
//   每类 22 行 / 2200 字符预算，总 120 行 / 12k 字符封顶，均保最新）/5000 项目使用说明 / 5001 项目索引（v0.1.0 原样）。
//   0.6.0 运行时记忆层（RUNTIME-FORMAT §七/§十，见 lib/runtime.js）：
//     消息通道六段（persona/runtimeUser/runtimeMemory/globalIndex/usage/projectIndex，
//     runtime 两段为锁定段）/ section 模式同序追加 4992/4993 两段 / long-term 无条件出全局索引 /
//     injectMaxTokens 缺省 24000、persona 上限 8000（预算切分见 §10.2）。
//   开关语义：
//     conversationMemory 总开关：关 = 全段全灭 + 提取全停（cursor 推进不积累）；
//     projectMemory：关 = 5000/5001 灭 + project ops 过滤计数 + runtime 两段不注（保守口径）；
//     runtimeEnabled（settings，缺省关）：关 = 不编译、不注 runtime 两段、globalIndex 去重不生效；
//     globalExtraction：关 = global:* ops 过滤计数；全局段注入跟随数据非空。
//   API/面板：lib/api.js（REST 全套）+ lib/panel.js（面板供给）经 webServer 挂载。
//   滚动清理：recent-activity 启动时 + 每次全局写入后（onGlobalWrite 收口）。
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { INDEX_FILENAME } from "./filename.js";
import { applyScopedOps, buildExtractionPayload, parseExtractionOutput } from "./extract.js";
import { buildManifestText, listMemoryFiles, parseFrontmatterHead, truncateWithWarning } from "./manifest.js";
import { projectMemoryPaths } from "./paths.js";
import { createScheduler } from "./state.js";
import { createJournal } from "./journal.js";
import { clipTail, isMachineOrigin, messageOf, renderTranscript, skipReason, textBlocksOf, countProseWords } from "./transcript.js";
import {
  buildMemoryContext,
  digestOf,
  INJECT_SOURCE_KIND,
  MEMORY_CONTEXT_FORM,
  MEMORY_CONTEXT_INTRO,
  MEMORY_CONTEXT_SUPERSEDE_NOTE,
  sameInjectionText,
  shouldReinject,
  summarizeInjectionDelta,
} from "./inject-channel.js";
import { MEMORY_RECALL_FORM, embedTexts, selectRecall } from "./embedding.js";
import { applyEmbeddings, loadEmbeddingCache, pruneCache, saveEmbeddingCache, staleItems } from "./recall-store.js";
import { buildPendingItems, createSessionAdapter } from "./session-recovery.js";
import { effectiveEmbedding, readSettings } from "./settings.js";
import { computeSourceHash, ensureCompiled, invalidateRuntimeCache, readRuntimeManifest, scopeDir } from "./runtime.js";
import { generatePages, isValidProjectId, pagesSnapshot, pagesSummaryTexts, readPages } from "./pages.js";
import { idleReviewSnapshot, runIdleReview } from "./idle-review.js";
import { applyCorrection, applyCorrections, correctionsSnapshot, correctionLedgerStats, groupCorrectionsByTarget, readCorrectionLedger, CORRECTION_MAX_BATCH } from "./corrections.js";
import { listMemoryEntries, searchMemory } from "./search.js";
import { turnActivity } from "./turn-activity.js";
import { COMMAND_MAX_RESULTS, registerMemoryCommand } from "./memory-command.js";
import { ensureFormat, FORMAT_VERSION } from "./format.js";
import { makeApiRoutes } from "./api.js";
import { makePanelRoutes } from "./panel.js";
// 召回降级文案的单一出处：面板/门牌/启动日志共用同一句（panel-logic 零依赖、零 DOM，可被 Node 直接 import）。
import { recallDisabledNoticeText } from "./panel-logic.js";
import {
  bumpExtractionFailure,
  bumpRetryAttempt,
  bumpFallbackUsed,
  bumpReasoningDegraded,
  bumpEscapeRetried,
  bumpExtractionTokens,
  noteExtractionAttempt,
  noteExtractionRecovered,
  pushRecentFailure,
  resetExtractionFailureStreak,
  retryDelayMs,
  setExtractionFailedRange,
  clearExtractionFailedRange,
  setExtractionInFlight,
  extractionObservationSnapshot,
  recordInjection,
  recordInjectionError,
  recordInjectionSuperseded,
  recordInjectionThrottled,
  injectionSnapshot,
  recordRecall,
  recordRecallMiss,
  recordRecallError,
} from "./metrics.js";
import { isRetryableFailure } from "./metrics.js";
import { appendExtractionError } from "./errorlog.js";
import { recentTsOf } from "./recent-ts.js";
import {
  CATEGORY_IDS,
  CATEGORY_LABELS,
  globalRoot,
  listEntries,
  pruneRecentActivity,
  readAddressing,
  readEntry,
  readPersona,
  stripFrontmatter,
  sweepTmpOrphans,
} from "./global-store.js";
import { redactOps } from "./redact.js";
import { gateDecision, GATE_DEFAULT_MIN_SCORE } from "./extract-gate.js";
import { estimateTokens } from "./tokens.js";

const name = "dsh-keepsake";
// 硬依赖仅"提取用的 llm"与"section 模式用的 systemPrompt"；webServer 只在有它时挂载 API/面板
// （见下方 ctx.inject(["webServer"], …)），不再列为硬依赖——否则无 webserver 的 profile 里记忆功能整体不加载。
const inject = ["llm", "systemPrompt"];

const PERSONA_SECTION = "dsh-keepsake:persona"; // 4990
const GLOBAL_INDEX_SECTION = "dsh-keepsake:global-index"; // 4995
const INSTRUCTIONS_SECTION = "dsh-keepsake:instructions"; // 5000
const INDEX_SECTION = "dsh-keepsake:index"; // 5001
// runtime 两段（RUNTIME-FORMAT §10.1：section 模式同序承载，插在 persona 与 globalIndex 之间）
const RUNTIME_USER_SECTION = "dsh-keepsake:runtime-user"; // 4992
const RUNTIME_MEMORY_SECTION = "dsh-keepsake:runtime-memory"; // 4993
const ROUTING_SECTION = "dsh-keepsake:routing"; // 消息通道模式下的静态路由兜底段（standard 兜底）
const PERSONA_ORDER = 4990;
const RUNTIME_USER_ORDER = 4992;
const RUNTIME_MEMORY_ORDER = 4993;
const GLOBAL_INDEX_ORDER = 4995;
const SECTION_ORDER = 5000; // 外部段可任取有限 order；置于 first-party 指引之后、后缀之前
const MAX_TIMER_DELAY_MS = 2147483647;
// 召回护栏：候选条目上限（防超大库每轮全读）、单次嵌入请求条目上限（防超端点 batch 限制）、
// 连续失败熔断阈值与时长（坏端点不再每轮阻塞满一个 recallTimeoutMs）。
const RECALL_MAX_ITEMS = 1000;
const EMBED_BATCH_SIZE = 64;
const RECALL_FAILURE_LIMIT = 3;
const RECALL_COOLDOWN_MS = 60000;
const USAGE_HEADER = "## Persistent project memory";
// 全局索引预算：每类行数按总闸反推（5 类 × (22 行 + 段落头 + 空行) = 120 行），
// 保证五类都在注入里——此前每类 40 × 5 会撑破总闸，把靠后分类整类裁掉。
// 分类切片与总闸都"保最新"（新条目在索引尾部，保头部会让新记忆从注入里消失）。
const GLOBAL_CATEGORY_BUDGET_LINES = 22;
const GLOBAL_INDEX_TOTAL_LINES = 120;
const GLOBAL_INDEX_TOTAL_CHARS = 12000;
// 每类字符预算：行预算之外的第二道闸。超长钩子（一行几百字符）时按行裁仍会撑破总字符闸，
// 若在总文本上按字符裁会把段落头/半行切掉；改为逐类按字符收紧（保最新、不掉头、不切半行）。
const GLOBAL_CATEGORY_BUDGET_CHARS = 2200;
// 紧凑索引兜底：整段索引放不下时，每类只留最新 N 行 + 总数 + 索引路径。
// 目的不是省几个字符，而是保证「预算再紧，模型也知道有哪些记忆、去哪读」。
const GLOBAL_INDEX_COMPACT_LINES = 2;
const PROJECT_INDEX_COMPACT_LINES = 8;
// 空闲整理（idle review）：默认关；仅在提取新增条目后调度，延迟收口、每会话限次。
const IDLE_REVIEW_DELAY_MS = 60000;
const IDLE_REVIEW_MIN_INTERVAL_MS = 10 * 60 * 1000;
const IDLE_REVIEW_MAX_PER_SESSION = 5;

/** 段求值探针日志：仅 DSH_KEEPSAKE_DEBUG=1 时输出（验证口，平时零噪音）。 */
function debugProbe(message) {
  if (process.env.DSH_KEEPSAKE_DEBUG === "1") {
    console.error(`[dsh-keepsake][probe] ${message}`);
  }
}

/** 配置解析：非法即抛（fail loud），未知键即抛（config 无 schema，靠严格性兜底）。 */

/** 换道路由条数上限（>3 条说明配置写错了，fail loud）。 */
const MAX_FALLBACK_ROUTES = 3;

/** 未知 config 键的最近键建议距离上限（"fallbacks"→"fallback" 这类手滑）。 */
const DID_YOU_MEAN_MAX_DISTANCE = 3;

/** 最小编辑距离（did-you-mean 用；配置键都是短串，O(nm) 足够）。 */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** 从 KNOWN 集里找与 key 最近的键（距离 ≤ DID_YOU_MEAN_MAX_DISTANCE），找不到返回 null。 */
function nearestKnownKey(key, known) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best !== null && bestDistance <= DID_YOU_MEAN_MAX_DISTANCE ? best : null;
}

/** 注入通道取值校验（缺省 message；非法值即抛，带允许值提示——fail loud）。 */
function injectionChannel(value) {
  if (value === void 0 || value === null) return "message";
  if (value === "message" || value === "section") return value;
  throw new Error(`dsh-keepsake: injectChannel must be "message" or "section" (got ${JSON.stringify(value)})`);
}

/**
 * 提取思考档取值校验。
 *
 * 取值集合取宿主 llm 能力声明的交集（dsh-llm-deepseek 的 off/low/high/max 与
 * dsh-llm-pi-ai 的 off/minimal/low/medium/high/xhigh/max 共有的一档是 low/medium/high；
 * 再留 minimal 作最深降档）。刻意**不放 "off"**：off 在部分适配器里等价于"不提这个参数"，
 * 对默认会思考的模型等于没降档（正是本次事故的成因），写进允许值只会误导。
 *
 * **缺省 = 不下发**（不是 low）：宿主按模型能力声明校验档位，不被支持的档位会在
 * provider I/O 之前就被拒（UNSUPPORTED_REASONING_EFFORT），插件只能降级重发一次——
 * 遇到「模型只声明 high/max」的路由（本机主路由 magpie/group/mozu1 正是如此），
 * 硬发 low 等于每次提取白多一次往返，且最终仍按模型默认档跑，降档收益为零。
 * 故缺省保守地「不干预」，由用户按自己路由的实际能力显式配置。
 * 非法值即抛（fail loud，与 injectionChannel 同风格）。
 */
const REASONING_EFFORTS = Object.freeze(["minimal", "low", "medium", "high"]);
function reasoningEffortValue(value) {
  if (value === void 0 || value === null) return void 0; // 不下发（跟随模型默认档）
  if (typeof value === "string" && REASONING_EFFORTS.includes(value)) return value;
  throw new Error(`dsh-keepsake: extractReasoningEffort must be one of ${REASONING_EFFORTS.map((e) => `"${e}"`).join(", ")} (got ${JSON.stringify(value)})`);
}

/** 单位区间取值校验（[0,1] 浮点，缺省 fallback；非法即抛）。 */
function unitInterval(value, fallback, key) {
  if (value === void 0 || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`dsh-keepsake: ${key} must be a number in [0, 1]`);
  }
  return value;
}

export function resolveConfig(raw) {
  const value = raw !== void 0 && raw !== null && typeof raw === "object" ? raw : {};
  const KNOWN = new Set([
    "enabled", "storageRoot", "provider", "model", "minUserWords", "timeoutMs", "maxOutputTokens",
    "maxIndexLines", "maxIndexChars", "maxManifestFiles", "maxPromptChars", "maxOps",
    "recentKeepCount", "recentKeepDays",
    // 退避参数（默认 3 attempt / 500ms / 2000ms，指数+jitter±20%）
    "retryAttempts", "retryBackoffMs", "retryMaxDelayMs",
    // 换道路由（默认 [] = 纯重试不换道；此处只校验+持有）
    "fallback",
    // 嵌入模型（语义召回用）：成对可选；recallEnabled 开启时 embeddingModel 必填（缺省时
    // 插件仍加载、召回被显式关闭并给红条，见 resolveConfig 的 recallConfigGaps），
    // embeddingProvider 仅作面板标签
    "embeddingProvider", "embeddingModel",
    // 注入通道：injectChannel（message|section，默认 message）；injectMaxChars（消息通道注入总预算字符）
    "injectChannel", "injectMaxChars",
    // 语义召回：recallEnabled 开关；embeddingBaseUrl/ApiKey 嵌入端点（OpenAI 兼容）；recall* 检索预算
    "recallEnabled", "embeddingBaseUrl", "embeddingApiKey",
    "recallTopK", "recallMaxTokens", "recallMinScore", "recallTimeoutMs", "recallTotalBudgetMs",
    // 脱敏：redactionEnabled（总开关）
    "redactionEnabled",
    // 自动补提：autoRecoverEnabled / autoRecoverCooldownMs
    "autoRecoverEnabled", "autoRecoverCooldownMs",
    // token 预算：injectMaxTokens（0=禁用 token 预算，退字符口径）
    "injectMaxTokens",
    // 提取门槛：extractGateEnabled / extractGateMinScore / extractIdleDelayMs / extractMaxRunsPerSession
    "extractGateEnabled", "extractGateMinScore", "extractIdleDelayMs", "extractMaxRunsPerSession",
    // 提取思考档：extractReasoningEffort（minimal|low|medium|high，缺省=不下发）——
    // 带思考的模型不显式降档就会套用模型默认最高档，把输出预算全吃在思考上（实测 81/88 的
    // llm-error 是 kind=max-tokens）。但缺省【不下发】而非硬发 low：宿主只对模型声明支持的
    // 档位放行，硬发 low 会在 provider I/O 前被拒（UNSUPPORTED_REASONING_EFFORT），
    // 触发一次降级重发，最终仍按模型默认档跑，降档收益为零。是否降档交给用户按
    // 自己路由的能力显式配置。进 KNOWN 白名单是硬要求：漏了就是启动即抛 unknown key。
    "extractReasoningEffort",
  ]);
  for (const key of Object.keys(value)) {
    if (!KNOWN.has(key)) {
      const suggestion = nearestKnownKey(key, KNOWN);
      throw new Error(`dsh-keepsake: unknown config key "${key}"${suggestion !== null ? ` (did you mean "${suggestion}"?)` : ""}`);
    }
  }
  const enabled = value.enabled === true; // 缺省关（fail-closed）：必须显式 enabled: true 才启用
  const cfg = {
    enabled,
    storageRoot: optionalNonEmptyString(value.storageRoot, "storageRoot") ?? join(homedir(), ".dsh", "memory"),
    provider: optionalNonEmptyString(value.provider, "provider"),
    model: optionalNonEmptyString(value.model, "model"),
    minUserWords: positiveInt(value.minUserWords, 3, "minUserWords"),
    timeoutMs: positiveInt(value.timeoutMs, 120000, "timeoutMs"),
    // 0 = 跟随模型（缺省）：宿主 resolveCallWithInfo 只在 maxTokens === undefined 时套模型默认值，
    // 传 0 会被当成"0 预算"。显式给 4096 的时代，带思考的模型单次思考就吃满 4096，
    // 正文零输出的 finish.kind="max-tokens"（本机实测 81/88 条 llm-error 是这一条）。
    maxOutputTokens: nonNegInt(value.maxOutputTokens, 0, "maxOutputTokens"),
    // 提取思考档（缺省=不下发；显式 minimal|low|medium|high 才下发）
    extractReasoningEffort: reasoningEffortValue(value.extractReasoningEffort),
    maxIndexLines: positiveInt(value.maxIndexLines, 200, "maxIndexLines"),
    maxIndexChars: positiveInt(value.maxIndexChars, 25000, "maxIndexChars"),
    maxManifestFiles: positiveInt(value.maxManifestFiles, 200, "maxManifestFiles"),
    maxPromptChars: positiveInt(value.maxPromptChars, 48000, "maxPromptChars"),
    maxOps: positiveInt(value.maxOps, 20, "maxOps"),
    recentKeepCount: positiveInt(value.recentKeepCount, 30, "recentKeepCount"),
    recentKeepDays: positiveInt(value.recentKeepDays, 30, "recentKeepDays"),
    retryAttempts: positiveInt(value.retryAttempts, 3, "retryAttempts"),
    retryBackoffMs: positiveInt(value.retryBackoffMs, 500, "retryBackoffMs"),
    retryMaxDelayMs: positiveInt(value.retryMaxDelayMs, 2000, "retryMaxDelayMs"),
    embeddingProvider: optionalNonEmptyString(value.embeddingProvider, "embeddingProvider"),
    embeddingModel: optionalNonEmptyString(value.embeddingModel, "embeddingModel"),
    injectChannel: injectionChannel(value.injectChannel),
    // 30000：注入总预算的缺省值。理由：块首新增了取代声明与
    // 免责两行固定开销，且节流判定要求"变化够大才补发"——预算越大，每一轮全量注入的
    // 字符越多，而 append-only 历史下块只增不减。三万字符仍能装下六段完整内容（persona 8k + runtime 两段约 4.8k + 三段索引）
    // （人设 16k + 全局索引 12k 之外还有余量给项目段），显式配置可覆盖，校验语义不变。
    injectMaxChars: positiveInt(value.injectMaxChars, 30000, "injectMaxChars"),
    recallEnabled: value.recallEnabled === true,
    embeddingBaseUrl: optionalNonEmptyString(value.embeddingBaseUrl, "embeddingBaseUrl"),
    embeddingApiKey: optionalNonEmptyString(value.embeddingApiKey, "embeddingApiKey"),
    recallTopK: positiveInt(value.recallTopK, 5, "recallTopK"),
    recallMaxTokens: positiveInt(value.recallMaxTokens, 1200, "recallMaxTokens"),
    recallMinScore: unitInterval(value.recallMinScore, 0.35, "recallMinScore"),
    recallTimeoutMs: positiveInt(value.recallTimeoutMs, 8000, "recallTimeoutMs"),
    // 单轮召回整体时间预算：嵌入可能分多批串行请求，仅单请求超时不足以约束整轮耗时。
    recallTotalBudgetMs: positiveInt(value.recallTotalBudgetMs, 20000, "recallTotalBudgetMs"),
    // 脱敏总开关
    redactionEnabled: value.redactionEnabled !== false,
    // 自动补提
    autoRecoverEnabled: value.autoRecoverEnabled !== false,
    autoRecoverCooldownMs: positiveInt(value.autoRecoverCooldownMs, 300000, "autoRecoverCooldownMs"),
    // token 预算（0=禁用，退字符口径）；缺省 24000：为 runtime 两段让路——
    // persona 8000 字符 × 1.5 token/字 = 12000，runtime 常驻 14336 字节（UTF-8）≈ 4779 中文字符
    // ≈ 7170 tokens，12000 + 7170 ≈ 19170 < 24000（RUNTIME-FORMAT §10.2）。
    injectMaxTokens: nonNegInt(value.injectMaxTokens, 24000, "injectMaxTokens"),
    // 提取门槛
    extractGateEnabled: value.extractGateEnabled !== false,
    extractGateMinScore: positiveInt(value.extractGateMinScore, 6, "extractGateMinScore"),
    extractIdleDelayMs: nonNegInt(value.extractIdleDelayMs, 3000, "extractIdleDelayMs"),
    extractMaxRunsPerSession: nonNegInt(value.extractMaxRunsPerSession, 50, "extractMaxRunsPerSession"),
    fallback: [],
  };
  if (cfg.timeoutMs > MAX_TIMER_DELAY_MS) throw new Error("dsh-keepsake: timeoutMs too large");
  if (cfg.retryMaxDelayMs > MAX_TIMER_DELAY_MS) throw new Error("dsh-keepsake: retryMaxDelayMs too large");
  if (cfg.recallTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error("dsh-keepsake: recallTimeoutMs too large");
  if (cfg.recallTotalBudgetMs > MAX_TIMER_DELAY_MS) throw new Error("dsh-keepsake: recallTotalBudgetMs too large");
  if (cfg.autoRecoverCooldownMs > MAX_TIMER_DELAY_MS) throw new Error("dsh-keepsake: autoRecoverCooldownMs too large");
  if (cfg.extractIdleDelayMs > MAX_TIMER_DELAY_MS) throw new Error("dsh-keepsake: extractIdleDelayMs too large");
  if ((cfg.provider === void 0) !== (cfg.model === void 0)) {
    throw new Error("dsh-keepsake: provider and model must be configured together (or both omitted to follow the session route)");
  }
  // 语义召回自带模型（provider-agnostic）：embeddingProvider 仅作面板显示标签，不要求与 embeddingModel 成对；
  // embeddingBaseUrl 收紧到 http(s)（本机/内网端点有意允许——本地优先是本插件的前提）。
  // 非 http(s) 的端点 URL 仍然是**抛错**——那是「配错了什么」，与「配了什么但没配全」不同：
  // 见下方 recallDisabledReason 的判定。
  if (cfg.embeddingBaseUrl !== void 0) httpUrl(cfg.embeddingBaseUrl, "embeddingBaseUrl");
  // 开启召回但端点/模型/通道不全 → **不再启动即抛**，改为显式降级：召回关闭 + 记下原因。
  //
  // 为什么不抛：缺一个可选功能的端点不该让整个插件（含核心的对话记忆提取与注入）起不来。
  // v0.6.5 之前这里三处 throw 让 apply() 整体失败——用户只是没填嵌入端点，代价是记忆功能全没了。
  //
  // 但不许 fail-open（规矩3）：降级必须「召回明确关闭 + 用户可见原因」，不是静默当没开过——
  // 所以 cfg.recallEnabled 被显式置 false（运行时零嵌入调用），原因落 cfg.recallDisabledReason，
  // 由 /state 透出到面板与门牌的红条。embeddingModel 是向量空间身份（缓存按端点+模型隔离），
  // 缺了它整库缓存无从隔离，故同样必须齐备才能开。
  cfg.fallback = fallbackRoutes(value.fallback, "fallback", cfg);
  // 只有「用户明确要了召回」才算降级；开关本来就没开 = 可选功能没启用，不是故障，不出红条。
  // recallRequested 保留原始请求（降级后 recallEnabled 会被置 false，事后无法分辨
  // "用户没开" 与 "用户开了但配错"——这两种的用户面完全不同）。
  cfg.recallRequested = cfg.recallEnabled;
  if (cfg.recallEnabled) {
    const miss = recallConfigGaps(cfg);
    if (miss !== null) {
      cfg.recallEnabled = false; // 显式关闭：运行时零嵌入调用（不是"开着但不干活"）
      cfg.recallDisabledReason = miss;
    }
  }
  return cfg;
}

/**
 * 召回静态配置完整性判据（纯函数，供 resolveConfig 收集诊断）。
 *
 * 只回答「缺什么」，不产出用户文案——文案的单一出处是 `panel-logic.js` 的
 * `recallDisabledNoticeText`（面板/门牌/启动日志三处共用同一句，避免各写一遍漂移）。
 *
 * @param {{embeddingBaseUrl?:string, embeddingModel?:string, injectChannel:string}} cfg
 * @returns {{missing:string[], channelMismatch:boolean}|null} 齐备时 null
 */
function recallConfigGaps(cfg) {
  const missing = [];
  if (cfg.embeddingBaseUrl === void 0) missing.push("embeddingBaseUrl");
  if (cfg.embeddingModel === void 0) missing.push("embeddingModel");
  const channelMismatch = cfg.injectChannel !== "message";
  if (missing.length === 0 && !channelMismatch) return null;
  return { missing, channelMismatch };
}

/**
 * fallback 换道配置解析。
 * 契约：数组；每项 provider/model 成对非空字符串；数组内去重；不得与主道
 * （显式配置的 provider/model；未配=跟随会话路由，无从判重）重复；≤3 条。
 * 此处只做校验与持有——换道调用逻辑单独实现。
 */
function fallbackRoutes(value, key, cfg) {
  if (value === void 0 || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`dsh-keepsake: ${key} must be an array of {provider, model}`);
  if (value.length > MAX_FALLBACK_ROUTES) {
    throw new Error(`dsh-keepsake: ${key} accepts at most ${MAX_FALLBACK_ROUTES} routes (got ${value.length})`);
  }
  const seen = new Set();
  const routes = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`dsh-keepsake: ${key} entries must be objects like {provider, model}`);
    }
    for (const entryKey of Object.keys(entry)) {
      if (entryKey !== "provider" && entryKey !== "model") {
        throw new Error(`dsh-keepsake: unknown ${key} entry key "${entryKey}" (expected "provider" and "model")`);
      }
    }
    const provider = optionalNonEmptyString(entry.provider, `${key}[].provider`);
    const model = optionalNonEmptyString(entry.model, `${key}[].model`);
    if (provider === void 0 || model === void 0) {
      throw new Error(`dsh-keepsake: ${key} entries need provider and model together (non-empty strings)`);
    }
    if (cfg?.provider === provider && cfg?.model === model) {
      throw new Error(`dsh-keepsake: ${key} route ${provider}/${model} duplicates the primary extraction route`);
    }
    const pair = `${provider}\u0000${model}`;
    if (seen.has(pair)) {
      throw new Error(`dsh-keepsake: ${key} has a duplicate route ${provider}/${model}`);
    }
    seen.add(pair);
    routes.push({ provider, model });
  }
  return routes;
}

function optionalNonEmptyString(value, key) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string" || value.length === 0) throw new Error(`dsh-keepsake: ${key} must be a non-empty string when set`);
  return value;
}

/**
 * 校验值为绝对 http(s) URL（嵌入端点等出网配置用）；非 http(s) scheme 或不可解析 → 抛（不静默放过）。
 * 本机/内网端点有意允许——「本地优先、自带嵌入模型」正是本插件的前提，不做环回/私有地址拦截。
 */
function httpUrl(value, key) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`dsh-keepsake: ${key} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`dsh-keepsake: ${key} must use http or https (got "${parsed.protocol}")`);
  }
  return value;
}

function positiveInt(value, fallback, key) {
  if (value === void 0 || value === null) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`dsh-keepsake: ${key} must be a positive integer`);
  return value;
}

function nonNegInt(value, fallback, key) {
  if (value === void 0 || value === null) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new Error(`dsh-keepsake: ${key} must be a non-negative integer`);
  return value;
}

function makeLogger(ctx, storageRoot) {
  // DSH_KEEPSAKE_DEBUG=1 时全级直送 stderr + 追加 <storageRoot>/debug.log
  // （诊断口，规则4：可观测；Electron desktop 宿主下 utility 进程的 console
  //   不回传主进程，文件口是唯一可见通道）；平时走 ctx.logger（等级阈值由宿主定）。
  // >1MB 轮转两档（debug.log.1 覆盖旧轮转），防无限追加。
  const debug = process.env.DSH_KEEPSAKE_DEBUG === "1";
  const debugFile = debug && typeof storageRoot === "string" ? join(storageRoot, "debug.log") : null;
  const DEBUG_LOG_MAX_BYTES = 1024 * 1024;
  const emit = (level, message, error) => {
    try {
      if (debug) {
        const line = `[dsh-keepsake][${level}] ${message}${error ? " " + String(error?.message ?? error) : ""}\n`;
        console.error(`[dsh-keepsake][${level}] ${message}`, error ?? "");
        if (debugFile) {
          try {
            if (statSync(debugFile).size > DEBUG_LOG_MAX_BYTES) renameSync(debugFile, `${debugFile}.1`);
          } catch { /* 无文件/轮转失败：直接追加 */ }
          appendFileSync(debugFile, line);
        }
        return;
      }
      const logger = ctx.logger;
      if (logger !== void 0 && logger !== null && typeof logger[level] === "function") {
        logger[level](`[dsh-keepsake] ${message}`, error ?? "");
      } else {
        (level === "error" ? console.error : console.warn)(`[dsh-keepsake] ${message}`, error ?? "");
      }
    } catch {
      /* 日志永不炸主流程 */
    }
  };
  return {
    info: (m) => emit("info", m),
    warn: (m, e) => emit("warn", m, e),
    error: (m, e) => emit("error", m, e),
  };
}

/**
 * 近期动态条目行渲染（年龄 + 过期倒计时；4995 与提取 manifest 共用）。
 * 排序与判龄统一走 recentTsOf（与 prune 同一基准，
 * 此前展示按 mtime、清理按 timestamp 双序错位）。
 */
function renderRecentLines(storageRoot, budgetLines, keepDays) {
  const entries = [...listEntries(storageRoot, "recent-activity")]
    .sort((a, b) => recentTsOf(b) - recentTsOf(a))
    .slice(0, budgetLines);
  const now = Date.now();
  const lines = [];
  for (const entry of entries) {
    const ts = recentTsOf(entry);
    const ageDays = Math.floor((now - ts) / 86400_000);
    const expireDays = Math.max(0, keepDays - ageDays);
    const ageText = ageDays <= 0 ? "今天" : ageDays === 1 ? "1 天前" : `${ageDays} 天前`;
    const desc = entry.description ? ` — ${entry.description}` : "";
    lines.push(`- [${entry.title}](${entry.name})${desc}（${ageText} · ${expireDays} 天后过期）`);
  }
  return lines;
}

/**
 * 全局索引渲染（4995 注入段与提取 manifest 共用；每次求值重读——体量小，不做缓存）。
 * 每类 budgetLines 行小预算；近期动态按时间倒序带年龄注记。
 *
 * 渲染集（RUNTIME-FORMAT §10.3）：
 *   - `long-term` **无条件**从渲染集移除（不随 runtimeEnabled、不依赖产物状态）——
 *     归档区条目不再进任何会话索引（同时修「归档条目跨项目外溢」面）。0.6.0 独立行为变化。
 *   - `runtimeCoveredCategories`（该 scope 产物**完整**承载的分类）从渲染集移除。注意是**分类粒度**：
 *     某分类里有条目因配额被淘汰（没进产物）时，该分类**必须**留在索引里——否则那些条目
 *     既不在产物、也不在索引，等于从注入面彻底消失且无任何提示（见 runtimeCoveredCategoriesOf）。
 *   - 产物缺失/error 时调用方传空集 → 三分类照旧渲染（fallback 全量索引，不静默）。
 *   - `recent-activity` 照旧渲染（runtime 不覆盖）。
 * @returns { text, nonEmpty } nonEmpty=任一「被渲染的」分类有条目
 */
/** 按字符预算从尾部（最新）保留整行；至少保一行，绝不切出半行。 */
/**
 * 每类字符预算裁剪（保最新、不切半行）。
 * @returns {{ lines: string[], dropped: number, oversized: boolean }}
 *   dropped = 因预算被裁掉的行数（0 = 全部保留）；
 *   oversized = 是否出现「少数大行把同类其它行挤掉」的病态情形——
 *   调用方据此追加可见提示行（否则用户看到某分类只剩 1-2 条，而面板里明明有 8 条，无从解释）。
 *
 *   判据（区分「正常按预算裁」与「被大行挤」）：**保下来的行明显比丢弃的行长**。
 *   · 正常情形：同类索引行长度相近（都受 clampIndexLine 150 字符约束），
 *     保下来的平均值 ≈ 丢弃的平均值 → 不报警；
 *   · 病态情形：保下来的是少数超长行（如近期活动的长描述），平均值远超丢弃行 → 报警。
 *   用比值而非「占满预算」判据：后者在行普遍较长时会误报（实测验证）。
 */
function clipLinesToChars(lines, maxChars) {
  let total = 0;
  let keepFrom = lines.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const cost = lines[i].length + 1;
    if (total + cost > maxChars && keepFrom < lines.length) break;
    total += cost;
    keepFrom = i;
  }
  const kept = keepFrom === 0 ? lines : lines.slice(keepFrom);
  const droppedLines = keepFrom === 0 ? [] : lines.slice(0, keepFrom);
  const dropped = droppedLines.length;
  let oversized = false;
  if (dropped > 0 && kept.length > 0) {
    const avgKept = kept.reduce((n, l) => n + l.length, 0) / kept.length;
    const avgDropped = droppedLines.reduce((n, l) => n + l.length, 0) / droppedLines.length;
    // 保下来的平均长度达到丢弃行的 3 倍以上（且绝对值不小）→ 是被大行挤的，不是按新旧裁的。
    oversized = avgKept >= Math.max(avgDropped * 3, 200);
  }
  return { lines: kept, dropped, oversized };
}

/** 病态裁剪的可见提示文案（长度参与预算预留，故单独成型）。
 *  刻意写短：这段文案本身要算进 perCategoryChars 预算，写太长会把更多真记忆挤掉。 */
function oversizeNoteText(dropped) {
  return `（另有 ${dropped} 条因过长未进注入）`;
}

/** runtime 去重可覆盖的三分类（§10.3-2）；long-term 是另一条（无条件移除）。 */
const RUNTIME_COVERED_CATEGORIES = ["user-profile", "work-profile", "current-focus"];
/** 归档区：不进任何全局索引（§10.3-1：无条件移除，不看开关与产物状态）。 */
const ARCHIVED_CATEGORY_ID = "long-term";

/**
 * 由编译清单算出「产物完整承载」的分类集合（§10.3-2 的分类粒度去重）。
 * 判据：该分类在候选池里的条目**全部** included=true。任一条被配额淘汰 → 该分类不算覆盖，
 * 索引照旧渲染（被淘汰的条目靠索引行仍然可见/可 Read），双份只在真正全覆盖时消失。
 * @param {object|null} manifest runtime.json 清单
 * @returns {string[]} 分类 id 数组（未覆盖 → 不含）
 */
export function runtimeCoveredCategoriesOf(manifest) {
  if (manifest === null || typeof manifest !== "object" || manifest.status === "error") return [];
  const files = [manifest.user, manifest.memory];
  const total = new Map(); // category → 候选条数
  const missing = new Set(); // 有淘汰条目的分类
  for (const file of files) {
    const entries = Array.isArray(file?.entries) ? file.entries : [];
    for (const entry of entries) {
      const rootKey = typeof entry?.rootKey === "string" ? entry.rootKey : "";
      if (!rootKey.startsWith("global:")) continue; // 项目条目归 projectIndex，不在本函数口径内
      const category = rootKey.slice("global:".length);
      if (!RUNTIME_COVERED_CATEGORIES.includes(category)) continue;
      total.set(category, (total.get(category) ?? 0) + 1);
      if (entry.included !== true) missing.add(category);
    }
  }
  return RUNTIME_COVERED_CATEGORIES.filter((category) => total.has(category) && !missing.has(category));
}

/**
 * 由编译清单算出「已进产物」的项目条目文件名（§10.3 项目侧去重，与全局分类粒度同口径）。
 * 项目索引用它剔掉重复行：产物里已有的条目不再在索引里出现第二遍；
 * 没进产物的（reference 类型、被配额淘汰的）**照旧留在索引**——去重绝不等于让条目消失。
 * @param {object|null} manifest runtime.json 清单
 * @returns {string[]} 相对项目 memory 目录的文件名（'/' 分隔）
 */
export function runtimeCoveredProjectFilesOf(manifest) {
  if (manifest === null || typeof manifest !== "object" || manifest.status === "error") return [];
  const out = [];
  for (const file of [manifest.user, manifest.memory]) {
    const entries = Array.isArray(file?.entries) ? file.entries : [];
    for (const entry of entries) {
      if (entry?.rootKey !== "project" || entry.included !== true) continue;
      if (typeof entry.file === "string" && entry.file.length > 0) out.push(entry.file);
    }
  }
  return out;
}

export function renderGlobalIndex(storageRoot, {  perCategoryLines = GLOBAL_CATEGORY_BUDGET_LINES,
  perCategoryChars = GLOBAL_CATEGORY_BUDGET_CHARS,
  keepDays = 30,
  runtimeCoveredCategories = [],
  includeArchived = false,
} = {}) {
  // §10.3-1：long-term（归档区）默认移除——注入面不看开关、不看产物状态。
  // 提取 prompt（:936）是例外：模型靠归档视图避免重复造已归档条目，故显式传 includeArchived=true。
  const omitted = new Set(includeArchived ? [] : [ARCHIVED_CATEGORY_ID]);
  for (const id of Array.isArray(runtimeCoveredCategories) ? runtimeCoveredCategories : []) omitted.add(id);
  const sections = [];
  let nonEmpty = false;
  for (const id of CATEGORY_IDS) {
    if (omitted.has(id)) continue; // 未渲染的分类连段落头都不出（不是显示「（空）」）
    let lines;
    if (id === "recent-activity") {
      lines = renderRecentLines(storageRoot, perCategoryLines, keepDays);
    } else {
      const indexPath = join(globalRoot(storageRoot), id, INDEX_FILENAME);
      let content = "";
      try {
        content = readFileSync(indexPath, "utf8");
      } catch {
        content = "";
      }
      lines = content.split("\n").filter((l) => l.trim().length > 0);
      // 保最新：merge 语义新条目在尾部；取头部会让写满预算后的新记忆从注入里消失。
      if (lines.length > perCategoryLines) lines = lines.slice(-perCategoryLines);
    }
    let oversizeNote = "";
    if (lines.length > 0) {
      // 每类字符预算（保最新、不切半行）。病态情形（少数大行把同类其它行挤掉）必须可见：
      // 否则用户看到某分类只剩 1-2 条、面板里却有 8 条，无从解释（内容仍在盘上，只是没进注入）。
      //
      // 两遍法：先用完整预算裁一次，若判为病态则**为提示行预留字节**再裁一次。
      // 不预留会让单类实际占用超出 perCategoryChars（提示行是额外拼上去的），
      // 实测单类曾达 3086 字符（预算 2200）。预留 = 先从预算里扣掉提示行的长度。
      const first = clipLinesToChars(lines, perCategoryChars);
      if (first.oversized) {
        // 提示文案长度随 dropped 位数变化，先按「预计数字」估一次再定稿（收敛：位数只会变小）。
        let note = oversizeNoteText(first.dropped);
        let second = clipLinesToChars(lines, Math.max(1, perCategoryChars - note.length - 1));
        // 口径若变了（dropped 数字位数变化）用新的再算一次
        const note2 = oversizeNoteText(second.dropped);
        if (note2.length !== note.length) {
          note = note2;
          second = clipLinesToChars(lines, Math.max(1, perCategoryChars - note.length - 1));
        }
        lines = second.lines;
        if (second.dropped > 0) oversizeNote = oversizeNoteText(second.dropped);
      } else {
        lines = first.lines;
      }
    }
    if (lines.length > 0) nonEmpty = true;
    sections.push(`### ${CATEGORY_LABELS[id]} (${id})`);
    sections.push(lines.length > 0 ? (oversizeNote.length > 0 ? `${lines.join("\n")}\n${oversizeNote}` : lines.join("\n")) : "（空）");
    sections.push("");
  }
  const body = sections.join("\n");
  return { text: body, nonEmpty };
}

function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const log = makeLogger(ctx, cfg.storageRoot);
  if (!cfg.enabled) {
    log.info("enabled=false，插件驻留但不订阅不注入");
    return;
  }

  const storageRoot = cfg.storageRoot;

  // ---- 存储格式闸（升级安全）：数据目录由更新版插件写入时，锁定为只读 ----
  // 数据在插件包目录之外，卸载重装天然不丢；唯一风险是"降级"读到/改到新格式数据。
  const formatState = ensureFormat(storageRoot, log);
  if (!formatState.ok) {
    log.error(
      `存储格式 v${formatState.formatVersion} 高于本插件支持（v${FORMAT_VERSION}）：已进入只读保护，`
        + "拒绝写入与清理以免损坏数据；请升级 dsh-keepsake 插件后重启。",
    );
  }

  // ---- 提取结算 durable 层（journal）----
  // 进程内单例：scheduler 记账与 /state 面板供给共用同一实例（两处必须同源，
  // 否则面板看到的最近结算与真实 cursor 会漂移）。storageRoot/log 与全局同源：
  // journal 与 extraction-errors.log 同性质（诊断/恢复用，非用户记忆真源），
  // 故存储格式只读保护下也照常落——它不碰记忆目录里的任何数据。
  const journal = createJournal({ storageRoot, log });

  const lifetime = new AbortController();
  const callControllers = new Set();
  const sessionStates = new WeakMap(); // session → { route }（主请求路由捕获）
  // 最近一次捕获到的会话路由/会话 id：面板手动「生成知识页」没有当前 session，
  // 用这个 last-good 值作为默认路由（与提取的 per-session 路由分开，失败不清空）。
  let lastKnownRoute = null;
  let lastKnownSessionId = "";
  // 最近一次会话的 workspace 绝对路径：纠错/检索在面板或命令里没有当前 session 时，
  // 用它回落定位项目记忆目录（与 lastKnownRoute 同性质，只在捕获时写入、失败不清空）。
  let lastKnownCwd = "";
  let idleReviewInFlight = false;
  const idleReviewTimers = new Set();
  let indexCache = { key: "", text: null, compact: null }; // 单条缓存足够：全局共享一个 section（full + 紧凑兜底同源）
  let recallFailureStreak = 0; // 召回连续失败计数（熔断用）
  let recallCooldownUntil = 0; // 召回熔断截止时刻（ms；期间跳过召回）
  /**
   * 召回面诊断（/state 的配置层结论；与 /state.recall 的运行计数面分开）。
   *
   * - `disabled`：**静态配置类**——resolveConfig 判定 entry config 开了召回但端点/模型缺失、
   *   或 injectChannel 不是 message。非 null 即面板/门牌红条的依据。
   * - `effectiveEnabled`：**本轮真正会不会召回**（entry config 与面板设置合并 + 通道判据）。
   * - `source`：生效来源（config / settings），面板据此说明"生效的是哪一份"。
   *
   * 关键：面板设置（settings.json）优先于 entry config，所以 entry 侧缺键**不一定**意味着
   * 召回坏了——问题一律按【当前生效配置】现算（见函数体），补齐即消，不指向不存在的缺口。
   * 配置齐了但面板开关没开也是显式问题（switchOff）：嵌入卡开关预填 false，用户照指引填完
   * 端点模型后最常卡在这一步——这里若让红条让位，就是"配置齐了却静默不召回"的 fail-open。
   * channelMismatch 无法被面板救：section 模式下 pre-step 根本没注册，面板再齐也永不召回。
   */
  const recallDiagnostics = () => {
    const gate = readSettings(storageRoot, log);
    const emb = effectiveEmbedding(cfg, gate);
    const hasEndpoint = typeof emb.baseUrl === "string" && emb.baseUrl.length > 0;
    const hasModel = typeof emb.model === "string" && emb.model.length > 0;
    // 真正会不会召回 = 与运行时同一组门槛（gate.conversationMemory && emb.enabled &&
    // computeRecallBlock 的 baseUrl/model 守卫 && 通道是 message）。少一个条件就会谎报。
    const effectiveEnabled = gate.conversationMemory !== false
      && emb.enabled === true && hasEndpoint && hasModel
      && cfg.injectChannel === "message";
    // 只有「entry 请求过召回」才谈得上故障；没开召回是可选功能没启用，不出红条打扰。
    if (cfg.recallRequested !== true) {
      return { disabled: null, effectiveEnabled, requested: false, source: emb.source };
    }
    // 问题按【当前生效配置】每轮现算（settings 优先于 entry config）——不能复用启动时
    // 的 cfg.recallDisabledReason：用户跟着红条把面板补齐后，"缺 X"必须立刻消失，
    // 否则红条指向一个已经不存在的缺口（复查 P0 实锤）。
    // ① 通道不对（面板救不了，只能改 yml）；② 缺端点/模型；③ 配置齐了但面板开关没开
    //    （嵌入卡开关预填 false——用户照指引填完端点模型后最常卡在这一步，缺这条诊断
    //    就是"红条让位但召回静默不工作"的 fail-open，复查两路各自独立抓到）。
    const missing = [];
    if (!hasEndpoint) missing.push("embeddingBaseUrl");
    if (!hasModel) missing.push("embeddingModel");
    const channelMismatch = cfg.injectChannel !== "message";
    if (missing.length > 0 || channelMismatch) {
      return { disabled: { missing, channelMismatch }, effectiveEnabled, requested: true, source: emb.source };
    }
    if (emb.enabled !== true) {
      return { disabled: { missing: [], channelMismatch: false, switchOff: true }, effectiveEnabled, requested: true, source: emb.source };
    }
    return { disabled: null, effectiveEnabled, requested: true, source: emb.source };
  };
  // 召回静态配置不全：插件照常加载，但这件事必须显式可见（规矩3：不静默降级、不 fail-open）。
  // 用与 /state 红条**同一份诊断**（每轮按当前生效配置现算）——面板设置可能已把缺的
  // 端点/模型补齐，那时召回其实是工作的，日志里再喊"已关闭"就是谎报。文案同源，界面与日志不各说一套。
  {
    const diag = recallDiagnostics();
    const notice = recallDisabledNoticeText(diag, join(storageRoot, "settings.json"));
    if (notice !== null) log.warn(notice);
  }
  // 各会话自己的注入状态（agent 句柄为键，一会话一 agent）：injectedOnce=本会话是否已发过
  // 主块（首发没有旧块可取代，superseded 不计——按会话记，别的会话的首发不算取代）；
  // lastInjectedText=本会话最近一次发出的主块全文（旧块被上下文压缩挤出后仍记得"发过什么"，
  // 补发才判得出 resend）。累计值本身不外存——同一轮裁决直接读 metrics 快照（单一事实源）。
  const injectStates = new WeakMap();
  // runtime 两段求值记忆：scope → { at, value }。section 模式六段各求值一次，
  // 无记忆时一轮 prompt 组装会重复跑 ensureCompiled（每次都读一遍候选池算 sourceHash）。
  // TTL 兜外部改动（手改条目不走写盘失效）；写盘路径显式清（invalidateRuntimeAfterWrite）。
  //
  // 测试可用 `DSH_KEEPSAKE_RUNTIME_MEMO_TTL_MS=0` 环境变量关闭记忆化（不进用户配置白名单，
  // 免得成为一个可被误配的开关）。默认 2000ms 时无法在单测里稳定验证「compile 后立即生效」——
  // 等待 2 秒既慢又易受 CI 抖动影响。
  const runtimeMemoTtlFromEnv = Number.parseInt(process.env.DSH_KEEPSAKE_RUNTIME_MEMO_TTL_MS ?? "", 10);
  const RUNTIME_MEMO_TTL_MS = Number.isFinite(runtimeMemoTtlFromEnv) ? Math.max(0, runtimeMemoTtlFromEnv) : 2000;
  const runtimeMemo = new Map();

  // 已知不支持 reasoningEffort 的路由（`provider/model`）。宿主会在发起 provider I/O
  // 之前就以 code=UNSUPPORTED_REASONING_EFFORT 拒绝（非思考模型 / thinking:disabled 的模型
  // 根本没有 reasoning 能力元数据，任何显式档位都被拒）。命中一次即记入本表，
  // 之后同路由不再下发该参数——降级可见（首次打 warn），不是静默 fail-open：
  // 丢掉思考档只回到"模型默认档"，输出预算仍有 maxTokens/max-tokens 兜底。
  const reasoningUnsupported = new Set();

  // ---- 会话补提（跨重启读回失败区间）状态 ----
  // hostPersistence：宿主会话持久化服务（ctx.sessionPersistence）。用宿主官方「可选服务
  // 绑定」惯用法拿（ctx.effect 内 ctx.inject(["sessionPersistence"], cb)）——宿主有就绑上，
  // 旧版宿主没有这个服务时回调不触发、插件照常加载（绝不硬依赖、绝不启动失败）。
  // 再兜一层运行时探测（ctx.get）覆盖某些宿主不派发该回调的老路径；探不到就按不可用降级，
  // 端点走 503 E_HOST_UNSUPPORTED 显式摊牌，不假装补过。
  // recoverState：单飞与最近一次补提结果，供 /state.recover 与 409 E_BUSY 判据共用。
  let hostPersistence = null;
  const recoverState = {
    inFlight: false,
    lastAt: null,
    lastOutcome: null,
    lastSessionId: null,
    // 自动补提状态
    autoAttempts: 0,
    lastAutoAt: null,
    lastAutoTrigger: null,
  };
  // 自动补提冷却：键格式 "sessionId:from:to"，值=上次尝试时间（ms）
  const autoRecoverCooldowns = new Map();
  const AUTO_RECOVER_COOLDOWN_MAX = 1000; // 防泄漏封顶（5 分钟冷却窗内攒下 1000 个不同区间才谈得上逐出）
  try {
    ctx.effect(() => ctx.inject(["sessionPersistence"], (pctx) => {
      const service = pctx?.sessionPersistence;
      hostPersistence = service !== null && service !== undefined && typeof service === "object" ? service : null;
      debugProbe(`sessionPersistence 可选绑定：${hostPersistence === null ? "不可用" : "可用"}`);
    }), "dsh-keepsake: sessionPersistence");
  } catch (error) {
    // 宿主不支持可选绑定：退回纯运行时探测（下面 probePersistence），不因绑定失败炸启动。
    log.warn("sessionPersistence 可选绑定未生效，补提将走运行时探测", error);
  }
  /** 运行时探测宿主 sessionPersistence（可选绑定未触发时兜底；探不到即 null）。 */
  function probePersistence() {
    if (hostPersistence === null && typeof ctx.get === "function") {
      try {
        const service = ctx.get("sessionPersistence");
        hostPersistence = service !== null && service !== undefined && typeof service === "object" ? service : null;
      } catch (error) {
        log.warn("探测宿主 sessionPersistence 失败，补提能力按不可用处理", error);
      }
    }
    return hostPersistence;
  }

  // ---- 全局写入收口（滚动清理触发点 = 启动时 + 每次全局写入后） ----
  // 近期动态保留天数：面板设置（settings.json）优先于 entry config，改完下一轮生效。
  // 读侧每轮取一次现值，与召回总开关同口径（关掉/调小即时可见，无需重启）。
  function effectiveRecentKeepDays() {
    const s = readSettings(storageRoot, log);
    return typeof s.recentKeepDays === "number" && Number.isInteger(s.recentKeepDays) && s.recentKeepDays > 0
      ? s.recentKeepDays
      : cfg.recentKeepDays;
  }
  function onGlobalWrite(reason) {
    try {
      const { removed, kept } = pruneRecentActivity(storageRoot, { keepCount: cfg.recentKeepCount, keepDays: effectiveRecentKeepDays() });
      if (removed > 0) log.info(`近期动态滚动清理（${reason}）：删 ${removed} 条，余 ${kept} 条`);
    } catch (error) {
      log.error("滚动清理异常", error);
    }
  }
  /**
   * 全局写盘后的 runtime 全失效（API/面板写路径的唯一收口）。
   * 全局条目进每个 scope 的产物，任何全局写都可能改变某一 scope 的 sourceHash；
   * 精确到 scope 需要知道改了哪个条目，API 层没有这个信息，故取全失效（代价 = 下一次注入重编）。
   * **不挂在 onGlobalWrite 上**：后者在启动滚动清理时也调（启动不该清缓存，否则每次重启都全量重编）。
   */
  function invalidateRuntimeAfterApiWrite() {
    try {
      runtimeMemo.clear();
      invalidateRuntimeCache(storageRoot, null);
    } catch (error) {
      log.warn("API 写入后 runtime 缓存失效失败（下一次注入的 sourceHash 比对会自愈重编）", error);
    }
  }
  if (formatState.ok) onGlobalWrite("启动");
  else log.warn("存储格式为只读保护：跳过启动滚动清理（不触碰更新版数据）");
  try {
    // 只读保护下不清扫：.tmp-*/staging 也可能是更新版插件的在途文件，不该由旧版本删。
    const swept = formatState.ok ? sweepTmpOrphans(storageRoot) : 0; // 启动清 .tmp 孤儿与陈旧 staging
    if (swept > 0) log.info(`启动清扫：移除 ${swept} 个临时残留`);
  } catch (error) {
    log.warn("启动清扫异常", error);
  }

  // ---- /memory 斜杠命令（可选能力：宿主无 commands 服务时记忆功能照常，只是没这条命令） ----
  // 与 webServer 同款：不进 inject 硬声明，用 ctx.inject 按需挂载。
  ctx.inject(["commands"], (cctx) => {
    cctx.effect(() => {
      // 显式降级而非静默跳过：注入面已声明 commands 但拿不到服务，属宿主面不一致，
      // 必须留一条 warn（规则 3）——否则用户找不到 /memory 时无从判断是没装还是没接上。
      if (cctx?.commands === void 0 || cctx.commands === null) {
        log.warn("/memory 命令未挂载：ctx.inject 拿到命令注入面，但 ctx.commands 服务不可用");
        return () => {};
      }
      return registerMemoryCommand(cctx, {
        search: (q) => searchMemory(storageRoot, q, {
          projectMemoryDir: resolveProjectMemoryDir(""),
          projectId: projectIdForSearch(""),
          limit: COMMAND_MAX_RESULTS,
        }),
        list: () => listMemoryEntries(storageRoot, {
          projectMemoryDir: resolveProjectMemoryDir(""),
          limit: COMMAND_MAX_RESULTS,
        }),
        correct: (input) => correctMemory(input),
        log,
      });
    }, "dsh-keepsake: /memory command");
  });

  // ---- host 自供路由（API 面 + 面板供给）----
  ctx.inject(["webServer"], (sctx) => {
    sctx.effect(() => {
      const routes = [
        // 把提取观测/补提能力经闭包递进 API 面（scheduler 在下方创建，
        // 这里用函数引用延后解构——注册时 scheduler 尚未就绪没关系，调用时才取值）。
        ...makeApiRoutes({
          storageRoot,
          log,
          onGlobalWrite: (opts) => {
            // API/面板写路径：全局条目的任何增删改都可能改变各 scope 的 sourceHash（精确到条目
            // 需要 API 层回传改了谁，它没有），故取全失效——下一次注入/面板打开时重编。
            // 例外：runtime 端点（pin/evict/restore）自己在内部已按受影响 scope 精确失效并重编，
            // 再走一次全失效会把刚写好的产物整个删掉（面板随即 404、候选清单清空）。
            // 但进程内 memo 必须照清：否则最长 2 秒内注入仍会拿到盘上已换新的产物之前的
            // 旧文本与旧覆盖集，与索引去重口径打架。
            runtimeMemo.clear();
            if (opts?.runtimeHandled !== true) invalidateRuntimeAfterApiWrite();
            onGlobalWrite("API 写入");
          },
          // compile / compile-all：只换产物、不动记忆目录。清 memo 即可，
          // 不走 onGlobalWrite（那会触发滚动清理，与「只重编」语义不符）。
          onRuntimeCompiled: () => runtimeMemo.clear(),
          // 面板最近提取记录/未恢复失败区间的数据源（与 scheduler 记账同源实例）。
          journal,
          // 会话补提面：清单（journal 快照 + 宿主探活）/ 触发（单飞）/ 观测三件套。
          recovery: {
            pending: () => pendingRecoveryItems(),
            start: (sessionId, from, to) => startSessionRecover(sessionId, from, to, { trigger: "manual" }),
            // 单会话探活（recover 端点的 404 判据）：宿主 stat 得对象=存在；得 null/抛错=不存在。
            probe: async (sessionId) => {
              const persistence = probePersistence();
              if (persistence === null || typeof persistence.stat !== "function") return null;
              try {
                const stat = await persistence.stat(sessionId);
                return { exists: stat !== null && stat !== undefined };
              } catch {
                return { exists: false };
              }
            },
            // state 暴露 autoEnabled/autoAttempts/lastAutoAt/lastAutoTrigger（api 侧透传）。
            state: () => ({
              inFlight: recoverState.inFlight,
              lastAt: recoverState.lastAt,
              lastOutcome: recoverState.lastOutcome,
              lastSessionId: recoverState.lastSessionId,
              autoEnabled: cfg.autoRecoverEnabled,
              autoAttempts: recoverState.autoAttempts,
              lastAutoAt: recoverState.lastAutoAt,
              lastAutoTrigger: recoverState.lastAutoTrigger,
            }),
          },
          // 记忆整理：数据组装与索引写盘都在 api 层（复用既有批锁 + 快照留档通路），
          // 此处不递入额外依赖——/maintenance/* 两个端点内建数据面。
          extraction: {
            triggerRetry: () => scheduler.retryPending(),
            inFlight: () => extractionObservationSnapshot().extractionInFlight,
            configSummary: () => ({
              provider: cfg.provider,
              model: cfg.model,
              fallback: cfg.fallback,
              embeddingProvider: cfg.embeddingProvider,
              embeddingModel: cfg.embeddingModel,
              injectChannel: cfg.injectChannel,
              // 召回面诊断（静态配置类降级 + 本轮是否真的召回 + requested 请求标记）。
              // 与 /state.recall 的计数面（hits/misses/errors）分开：这里是"配置层结论"，
              // 那里是"运行层计数"。requested 就在诊断对象里（复查 P1：单独透传的
              // recallRequested 没有任何消费方，是死字段——并入诊断，一处说清）。
              recallDiagnostics: recallDiagnostics(),
              timeoutMs: cfg.timeoutMs, // 单次提取超时（/state.extractionTimeoutMs 契约字段）
              retryAttempts: cfg.retryAttempts, // 重试次数（/state.extractionRetryAttempts 契约字段）
              recentKeepDays: cfg.recentKeepDays, // 近期动态保留天数现值（/state.recentKeepDays 契约回退源）
              // 生效嵌入配置（面板设置优先于 entry config）；apiKey 由 api 层出参脱敏，测试端点内部用原值。
              embeddingEffective: effectiveEmbedding(cfg, readSettings(storageRoot, log)),
              // 新增 8 字段
              redactionEnabled: cfg.redactionEnabled,
              injectMaxChars: cfg.injectMaxChars,
              injectMaxTokens: cfg.injectMaxTokens,
              extractGateEnabled: cfg.extractGateEnabled,
              extractGateMinScore: cfg.extractGateMinScore,
              extractIdleDelayMs: cfg.extractIdleDelayMs,
              extractMaxRunsPerSession: cfg.extractMaxRunsPerSession,
              autoRecoverEnabled: cfg.autoRecoverEnabled,
              // 提取调用预算面（0 = 跟随模型，不下发 maxTokens 键）与思考档（undefined = 不下发）。
              // 必须透出：这两个值决定「输出预算是否够用」，排障时看不到生效值等于没法判断
              // 是不是又撞回 max-tokens（本机 81/88 条 llm-error 就是这个原因）。
              maxOutputTokens: cfg.maxOutputTokens,
              extractReasoningEffort: cfg.extractReasoningEffort ?? null,
            }),
          },
          // 知识页：手动生成 + 读取；生成走当前/最近会话路由，单飞、不自动触发。
          pages: {
            read: (projectId) => readPages(storageRoot, projectId),
            generate: (projectId) => generatePagesForProject(projectId),
            state: () => pagesSnapshot(),
          },
          idleReview: {
            state: () => idleReviewSnapshot(),
          },
          // 纠错闭环：给定一条被判有误的记忆 → 最小修正（手动/命令触发，不自动跑）。
          // state/recent 供面板与 /state 展示；correct 抛的错带 code，由 api 层分流 HTTP 码。
          corrections: {
            correct: (input) => correctMemory(input),
            // 批量纠错：一次多条，每条独立成败（单条缺参只废该条，不拖垮整批）。
            correctBatch: (input) => correctMemoryBatch(input),
            state: () => correctionsSnapshot(),
            recent: (limit) => readCorrectionLedger(storageRoot, { limit }),
            // 按条目归组的历史：回答「这条被改过几次」而非只答「最近改了什么」。
            byTarget: (options) => groupCorrectionsByTarget(storageRoot, options),
            stats: () => correctionLedgerStats(storageRoot),
          },
          // 记忆检索（/memory 命令与面板搜索共用；只读）。
          // projectId 缺省用 last-known workspace 推导，供命令在没有当前会话时仍能查。
          search: {
            query: (q, { projectId = "", limit } = {}) => searchMemory(storageRoot, q, {
              projectMemoryDir: resolveProjectMemoryDir(projectId),
              projectId: projectIdForSearch(projectId),
              limit,
            }),
            list: ({ projectId = "", limit } = {}) => listMemoryEntries(storageRoot, {
              projectMemoryDir: resolveProjectMemoryDir(projectId),
              limit,
            }),
            currentProjectId: () => projectIdForSearch(""),
          },
          // 轮次活动条（派生视图：把提取/注入/整理/纠错按会话与时间窗归并）。
          // 入参名与 makeApiRoutes 的形参对齐（turnActivityProvider）——
          // 写 turnActivity 会被同名的 import 遮蔽成"函数调用自己"的死亡接线（变异测试 M3 钉住）。
          turnActivityProvider: (options) => turnActivity({
            extractionLog: journal.snapshot(),
            injection: injectionSnapshot(),
            idleReview: idleReviewSnapshot(),
            corrections: correctionsSnapshot(),
          }, options),
        }),
        ...makePanelRoutes(log),
      ];
      const disposers = routes.map((route) => sctx.webServer.register(route));
      log.info(`webServer 路由已注册：/dsh-keepsake/api/* + /dsh-keepsake/panel/（${routes.length} 条）`);
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "dsh-keepsake: routes");
  });

  /**
   * 检索/纠错用的项目记忆目录解析：显式 projectId 优先，否则回落 last-known workspace。
   * 两者都没有就返回空串——调用方（检索）会把项目侧当空处理，不报错也不猜目录。
   */
  function resolveProjectMemoryDir(projectId) {
    try {
      if (typeof projectId === "string" && projectId.length > 0) {
        if (!isValidProjectId(projectId)) return "";
        return join(storageRoot, "projects", projectId, "memory");
      }
      if (lastKnownCwd.length > 0) return projectMemoryPaths(storageRoot, lastKnownCwd).memoryDir;
    } catch {
      return "";
    }
    return "";
  }

  /** 检索回出的 projectId（用于显示"这些结果属于哪个项目"）；未知给空串，不编。 */
  function projectIdForSearch(projectId) {
    try {
      if (typeof projectId === "string" && projectId.length > 0 && isValidProjectId(projectId)) return projectId;
      if (lastKnownCwd.length > 0) {
        const paths = projectMemoryPaths(storageRoot, lastKnownCwd);
        return `${paths.slug}-${paths.hash}`;
      }
    } catch {
      return "";
    }
    return "";
  }

  const scheduler = createScheduler({
    log: { warn: (m) => log.warn(m), error: (m, e) => log.error(m, e) },
    extract: async (session, fromSeq, toSeq) => {
      const result = await extractSession(session, fromSeq, toSeq);
      maybeScheduleIdleReview(session, result);
      return result;
    },
    journal, // 结算记账（cursor 跨重启恢复的唯一依据）
    // drain 预算与调用超时联动（此前 60s < 120s，慢调用必然挂满 drain）
    drainTimeoutMs: Math.min(60000, cfg.timeoutMs),
    // A4：空闲延迟（合并突发轮次，0=立即）与每会话提取次数上限（0=不限）。
    // 定时器在 scheduler 内 unref + dispose flush（设计纪律：绝不许测试进程被挂住）。
    idleDelayMs: cfg.extractIdleDelayMs,
    maxRunsPerSession: cfg.extractMaxRunsPerSession,
  });

  ctx.effect(() => async () => {
    // 关停纪律：先有界 drain 在途提取（headless one-shot 依赖这段在进程退出前把记忆写完），
    // 超时才 abort 兜底——不是先 abort 再等。
    // 启动清扫定时器同步清（unref 已兜住进程，这里保证 dispose 后不再触发）。
    if (startupSweepTimer !== null) {
      clearTimeout(startupSweepTimer);
      startupSweepTimer = null;
    }
    for (const timer of idleReviewTimers) clearTimeout(timer);
    idleReviewTimers.clear();
    await scheduler.dispose();
    lifetime.abort(new Error("dsh-keepsake disposed"));
    for (const controller of [...callControllers]) controller.abort(new Error("dsh-keepsake disposed"));
  }, "dsh-keepsake lifecycle");

  ctx.on("session/event", (session, event) => {
    try {
      scheduler.see(session, event);
      if (event?.type === "request/header") {
        captureRoute(session, event);
        return;
      }
      if (event?.type === "assistant/message") {
        // 路由兜底（实测加固）：request/header 在部分宿主路径下不带 config
        // （desktop Electron 渲染器链路实测），assistant/message 的 source 字段
        // 是 usage-stats 同款已证可用的路由来源。
        captureRouteFromSource(session, event);
        return;
      }
      if (event?.type === "turn/end" && event.data?.reason?.kind === "completed") {
        // toSeq = turn/end 事件 seq+1（含界快照）
        const endSeq = Number(event.seq);
        scheduler.onTurnCompleted(session, Number.isFinite(endSeq) ? endSeq + 1 : session.seq);
        // A2：成功轮结束顺手全局清扫未恢复区间（journal 持久，跨会话/跨重启都收）
        maybeAutoRecover("turn/end");
      }
    } catch (error) {
      // 订阅回调永不炸宿主轮次（规则3：显式记日志，不静默吞）
      log.error("session/event 处理异常", error);
    }
  });

  ctx.on("session/disposed", (session) => {
    try {
      sessionStates.delete(session);
      scheduler.drop(session); // Map 强持有 session，disposed 必须同步清
      // 会话消亡即清其同因连击键：否则死会话的红灯（maxStreak 恒返回旧值）长亮，
      // /state.streak 对已不存在的会话报警。放弃判定发生在会话在场期间，语义不受影响。
      if (typeof session?.id === "string") resetExtractionFailureStreak(session.id);
      // 自动补提：disposed 触发补该会话未恢复区间
      maybeAutoRecover("disposed", session.id);
    } catch (error) {
      log.warn("session/disposed 清理异常", error); // 不静默吞（规则3）
    }
  });

  function captureRoute(session, event) {
    const configHeader = event.data?.header?.config;
    if (configHeader === void 0 || configHeader === null || typeof configHeader !== "object") return;
    const provider = typeof configHeader.provider === "string" ? configHeader.provider : void 0;
    const model = typeof configHeader.model === "string" ? configHeader.model : void 0;
    if (provider === void 0 || model === void 0) return;
    let state = sessionStates.get(session);
    if (state === void 0) {
      state = {};
      sessionStates.set(session, state);
    }
    // request/header 是权威源：无条件覆盖（中途换模型即自愈），并解除失败标记。
    state.route = { provider, model };
    delete state.routeStale;
    lastKnownRoute = { provider, model };
    if (typeof session?.id === "string" && session.id.length > 0) lastKnownSessionId = session.id;
    // 顺手记 workspace：纠错/检索在无当前 session 时需要它定位项目记忆目录。
    const cwd = session?.header?.cwd;
    if (typeof cwd === "string" && cwd.length > 0) lastKnownCwd = cwd;
  }

  /**
   * 路由兜底：assistant/message 的 source.{provider,model}（usage-stats 同款已证来源）。
   *
   * 覆盖策略：默认只在槽空时填（request/header 权威，不覆盖）；
   * **但失败时打过 routeStale 标记就允许覆盖**——这是"中途换模型能自愈"在
   * desktop（无 request/header）路径上的唯一出口：上一次提取失败说明旧路由可能已失效，
   * 该模型的下一条 assistant/message 应当把路由换成新的。
   */
  function captureRouteFromSource(session, event) {
    const source = event.data?.message?.source;
    if (source === void 0 || source === null || typeof source !== "object") return;
    const provider = typeof source.provider === "string" ? source.provider : void 0;
    const model = typeof source.model === "string" ? source.model : void 0;
    if (provider === void 0 || model === void 0) return;
    let state = sessionStates.get(session);
    if (state === void 0) {
      state = {};
      sessionStates.set(session, state);
    }
    // 槽空才填（request/header 权威）；失败后（routeStale）允许用新 source 顶替旧路由。
    if (state.route === void 0 || state.routeStale === true) {
      state.route = { provider, model };
      delete state.routeStale;
      lastKnownRoute = { provider, model };
      if (typeof session?.id === "string" && session.id.length > 0) lastKnownSessionId = session.id;
      const cwd = session?.header?.cwd;
      if (typeof cwd === "string" && cwd.length > 0) lastKnownCwd = cwd;
    }
  }

  /**
   * 失败留痕+节流告警：首次必警，此后每 10 次同因重警一次；计数进 metrics。
   * 同时进 recent 环形缓冲 + extraction-errors.log 落盘 + lastFailedRange
   * （三个观测口共用本收口，失败点无需各自记——单一事实源，双端不漂移）。
   */
  function noteFailure(reason, message, session, { provider = "", model = "", fromSeq, toSeq } = {}) {
    const streak = bumpExtractionFailure(reason, session?.id); // 连击按会话分键（别会话失败不顶本会话到放弃线）
    pushRecentFailure({ reason, message, provider, model });
    appendExtractionError(storageRoot, { at: Date.now(), reason, provider, model, message });
    if (typeof fromSeq === "number" && typeof toSeq === "number") {
      setExtractionFailedRange(fromSeq, toSeq);
    }
    if (streak === 1 || streak % 10 === 0) {
      log.warn(`${message}（本会话同因连击 ${streak}；累计见 /dsh-keepsake/api/state extractionFailures）`);
    }
    return streak;
  }

  /**
   * 提取任务体。
   * @returns {{status:'ok'|'error', detail:object}} status 决定 cursor 推进与否
   *   （规格①：ok 含 skip 推进，error 不推进）；detail 是结算明细，进 journal
   *   与面板最近提取记录（outcome: written|zero-ops|skipped|failed）。
   */
  async function extractSession(session, fromSeq, toSeq) {
    if (lifetime.signal.aborted) return { status: "error", detail: { outcome: "failed", reason: "aborted" } };
    // 总开关闸：关 = 全部提取停；关期间轮次按 skip 处理（cursor 推进，
    // 不积累——重开后不回头补提取，符合"关掉对话记忆"的用户心智）。
    const gate = readSettings(storageRoot, log);
    if (!gate.conversationMemory) {
      log.info("总开关关：本轮跳过提取（cursor 推进，不积累）");
      resetExtractionFailureStreak(session?.id);
      return { status: "ok", detail: { outcome: "skipped", reason: "gate-off" } };
    }
    // 存储格式只读保护：数据由更新版插件写入时，本版本不提取不落盘。
    // 按 skip 处理（cursor 推进）——与"总开关关"同侧：宁可不提取，也不制造
    // "error 不推进 → 每轮重提 → 区间雪球"的确定性重试循环；升级后新轮次照常提取。
    if (!formatState.ok) {
      log.error(`存储格式 v${formatState.formatVersion} 高于本插件支持（v${FORMAT_VERSION}）：本轮跳过提取（只读保护，不落盘）`);
      resetExtractionFailureStreak(session?.id);
      return { status: "ok", detail: { outcome: "skipped", reason: "format-readonly" } };
    }
    const cwd = session?.header?.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) {
      const streak = noteFailure("no-cwd", "会话无 header.cwd，无法定位项目记忆目录，跳过提取", session, { fromSeq, toSeq });
      if (streak >= 5) {
        // 结构性失败断链：重试不可能自愈，连续 5 次后显式放弃推进 cursor，
        // 斩断"失败区间无限累积 + 每轮全量 snapshotEvents"的 O(n²) 雪球（显式 error 日志非静默）。
        log.error(`会话无 cwd 连续 ${streak} 次，放弃本轮区间（seq ${fromSeq}..${toSeq}）不再重试`);
        // 放弃型：cursor 照推进（斩断 O(n²) 雪球），结算记 outcome=abandoned——
        // 盘上留痕"这段被显式放弃、不再重试"（与 failed 未恢复清单分列，面板可持久显示）。
        return { status: "ok", detail: { outcome: "abandoned", reason: "no-cwd" } };
      }
      return { status: "error", detail: { outcome: "failed", reason: "no-cwd" } };
    }
    const paths = projectMemoryPaths(storageRoot, cwd);
    const seq = typeof session?.seq === "number" ? session.seq : toSeq;
    const to = Math.min(toSeq, seq);
    const from = Math.min(fromSeq, to);
    const events = session.snapshotEvents(from, to);

    // 边界⑤：双 skip 条件（skip 也推进，边界①）
    const reason = skipReason(events, paths.memoryDir, cfg.minUserWords);
    if (reason !== null) {
      log.info(`轮次跳过提取（${reason}，seq ${from}..${to}，${paths.slug}-${paths.hash}）`);
      resetExtractionFailureStreak(session?.id);
      return { status: "ok", detail: { outcome: "skipped", reason } };
    }

    // ---- 打分门----
    // 位置纪律：在 skipReason（结构性命中：直写记忆/无用户散文）之后、no-route 之前——
    // no-route 是"能提但没路由"的失败面（cursor 不推进、要重试），打分门是"内容太薄不值得调
    // LLM"的跳过面（cursor 推进、journal 留痕，自动获得既有 skip 结算路径）。
    // 顺序放在前面能少烧一次 manifest 组装；放在 no-route 后面则薄轮先被记成 failed 白重试。
    // 关掉（extractGateEnabled=false）时 gateDecision 恒 pass，行为与旧版一致。
    const gateVerdict = gateDecision(events, { enabled: cfg.extractGateEnabled, minScore: cfg.extractGateMinScore });
    if (!gateVerdict.pass) {
      log.info(`轮次跳过提取（${gateVerdict.reason}，score=${gateVerdict.score}，seq ${from}..${to}，${paths.slug}-${paths.hash}）`);
      resetExtractionFailureStreak(session?.id);
      return { status: "ok", detail: { outcome: "skipped", reason: gateVerdict.reason, gateScore: gateVerdict.score } };
    }

    // 路由：显式配置优先，否则跟随本会话主请求路由（session-title 同款策略）。
    // 第三级 recoveredRoute 只对**补提适配对象**存在（lib/session-recovery.js 的
    // createSessionAdapter 从读回事件复原）：适配对象不在 sessionStates 里、也收不到
    // session/event，没有这一级补提就 100% 记 no-route。宿主真实 Session 上无此属性，
    // 故对在线路径是恒 undefined 的死分支（字段名带 recovered 前缀即为此）。
    const state = sessionStates.get(session) ?? {};
    const recovered = session?.recoveredRoute;
    const provider = cfg.provider ?? state.route?.provider ?? recovered?.provider;
    const model = cfg.model ?? state.route?.model ?? recovered?.model;
    if (provider === void 0 || model === void 0) {
      const streak = noteFailure("no-route", "本会话尚无可用模型路由（config、request/header 与读回事件均未提供），本轮不提取", session, { fromSeq, toSeq });
      if (streak >= 5) {
        log.error(`路由缺失连续 ${streak} 次，放弃本轮区间（seq ${fromSeq}..${toSeq}）不再重试`);
        // 同 no-cwd：放弃型（outcome=abandoned），cursor 推进但盘上留痕"这段被显式放弃"。
        return { status: "ok", detail: { outcome: "abandoned", reason: "no-route" } };
      }
      return { status: "error", detail: { outcome: "failed", reason: "no-route" } };
    }

    const { manifest, bodies } = buildManifestText(paths.memoryDir, { maxFiles: cfg.maxManifestFiles });
    const sleepAbortable = (ms, signal) => new Promise((resolve) => {
      // 可取消退避 sleep——signal 已 aborted 时立即 resolve（不等满窗），
      // dispose 后不会白白睡完退避再发下一次 attempt。
      if (signal.aborted) {
        resolve();
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // 全局 manifest 进提取 prompt（四分类+长期记忆现状，每类 20 行小预算）
    // includeArchived：提取侧必须看得见归档区（否则会把已归档条目再造一遍）——与注入侧口径不同，勿统一。
    const globalManifest = renderGlobalIndex(storageRoot, { perCategoryLines: 20, keepDays: effectiveRecentKeepDays(), includeArchived: true }).text;
    const raw = renderTranscript(events, { redact: cfg.redactionEnabled });
    const transcript = clipTail(raw, cfg.maxPromptChars);
    if (transcript.length < raw.length) {
      // 转录被裁剪的盲区显式留痕（恢复期旧轮次被裁出 prompt，模型侧有标记行）
      log.warn(`提取转录超预算已裁剪：保留尾部 ${cfg.maxPromptChars} 字符，seq ${from}..${to} 的旧前段本轮未参与提取（clipTail 标记已告知模型）`);
    }
    const { system, user } = buildExtractionPayload({ transcript, manifest, bodies, memoryDir: paths.memoryDir, globalManifest });

    let text;
    // 输出是否被 max-tokens 截断（callLlmText 的返回标记；解析成功时进观测键 truncatedParse）
    let truncated = false;
    // ---- 提取调用重试链 ----
    // 背景：主对话由宿主 5 次重试保护，提取裸调一次判死——
    // 免费池抖 30 秒 → 429 → cursor 不推进 → 之后每轮重提同区间继续撞同一条池。
    //
    // 韧性语义：cfg.retryAttempts 次 attempt（含首次，默认 3），指数退避
    // min(retryBackoffMs*2^(n-1), retryMaxDelayMs) + jitter ±20%；failure 带
    // providerRetryAfterMs 时该次退避直接用它（钳 ≤3*retryMaxDelayMs 防恶意长等）。
    // 可重试性 route on failure.code（isRetryableFailure）：AUTH/INVALID_REQUEST/
    // QUOTA 等确定性失败立即摊牌，不浪费 attempt。
    //
    // drain 纪律（规则）：整条链对 drain 行为清晰、不放大预算——
    //   · 每个 attempt 前检查 lifetime.signal.aborted：dispose 已触发则不再发起，
    //     直接返回 'error'（cursor 不推进，extractSession 语义不变）；
    //   · 退避 sleep 是可取消版（abort 提前 resolve），dispose/disposed 后不会
    //     白白睡满退避窗再进入下一次 attempt；
    //   · 单次 attempt 的超时仍是 cfg.timeoutMs（callLlmText 内
    //   AbortController+setTimeout，finally 清理链每次 attempt 都覆盖），
    //    重试不偷 drain 预算之外的时间——最坏总时长 =
    //    cfg.retryAttempts × timeoutMs + 各次退避；scheduler drainTimeoutMs 与
    //    cfg.timeoutMs 的联动（index.js apply 内 Math.min(60000, timeoutMs)）
    //    保持不变，重试 sleep 同样在 drain 有界内推进/收敛。
    //   · 多 attempt 不构成并发放大：仍是单 attempt 在途，请求放大 ≤ retryAttempts 倍。
    //
    // cfg.fallback（已接线）：主道 attempt 链不可恢复失败后，逐条用
    // 同样 attempt 链调用换道路由；成功即记 fallbackUsed 并把 lastUsedRoute 指向该道。
    let attemptsUsed = 0;
    let usedRoute = { provider, model };
    // 观测面：LLM 段在途标记（含退避窗）；每次 attempt 起点记用车（唯一真值源）。
    setExtractionInFlight(true);

    // attempt 链：主道与换道共用——返回 {ok:true,text,truncated} / {ok:false,error} / {aborted:true}。
    const runAttemptChain = async (routeProvider, routeModel) => {
      let chainError;
      let used = 0;
      for (let attempt = 1; attempt <= cfg.retryAttempts; attempt += 1) {
        if (lifetime.signal.aborted) {
          // disposed 中途不再发起新 attempt（显式失败，不静默走完）。
          log.warn("提取重试链：dispose 信号已置，放弃后续 attempt");
          return { aborted: true, attempts: used };
        }
        used = attempt;
        noteExtractionAttempt({ provider: routeProvider, model: routeModel }); // 每次真实 attempt 记用车
        try {
          const value = await callLlmText({
            provider: routeProvider,
            model: routeModel,
            system,
            user,
            maxTokens: cfg.maxOutputTokens,
            reasoningEffort: cfg.extractReasoningEffort,
            sessionId: session.id,
          });
          return { ok: true, text: value.text, truncated: value.truncated === true, attempts: used };
        } catch (error) {
          // dispose 在途（在途 attempt 被我们自己的 lifetime abort 打断）：按 aborted 收场，
          // 不落 llm-error 桶、不推失败连击。执行结果判据（查 signal 本尊），不猜错误形状——
          // 此前这条路漏了，宿主把在途 abort 映射成 ABORTED 一路落成 llm-error（实际运行
          // extraction-errors.log 13:28 那条就是关机时在途提取被记成 LLM 失败）。
          if (lifetime.signal.aborted) return { aborted: true, attempts: used };
          chainError = error;
          const failure = error?.failure;
          const retryable = isRetryableFailure(failure, error?.message);
          if (failure !== void 0) {
            // 分类证据走 structured failure（status/retryAfter 一并进日志与 recent），不猜 message。
            log.warn(`提取 LLM 第 ${attempt}/${cfg.retryAttempts} 次 attempt 失败（${routeProvider}/${routeModel}）：code=${String(failure?.code)} status=${String(failure?.status)} retryAfterMs=${String(failure?.providerRetryAfterMs)} retryable=${retryable}`);
          } else {
            log.warn(`提取 LLM 第 ${attempt}/${cfg.retryAttempts} 次 attempt 失败（无 structured failure，按 internal 兜底）：${error?.message}`);
          }
          if (!retryable || attempt === cfg.retryAttempts) break;
          // 可取消退避——abort 提前 resolve，不裸 await setTimeout
          const delay = retryDelayMs(attempt, { backoffMs: cfg.retryBackoffMs, maxDelayMs: cfg.retryMaxDelayMs }, failure);
          log.info(`提取重试退避 ${delay}ms 后发起第 ${attempt + 1} 次 attempt`);
          await sleepAbortable(delay, lifetime.signal);
          if (lifetime.signal.aborted) {
            log.warn("提取重试链：退避期间 dispose，放弃后续 attempt");
            return { aborted: true, attempts: used };
          }
          bumpRetryAttempt(); // retry attempt 粒度（本次重试真实发生才计）
        }
      }
      return { ok: false, error: chainError, attempts: used };
    };

    let fallbackUsed = false;
    try {
      let outcome = await runAttemptChain(provider, model);
      attemptsUsed = outcome.attempts ?? 0;
      // 换道：主道不可恢复失败后，逐条试 fallback 路由（同 attempt 链），首条成功即停。
      if (!outcome.ok && outcome.aborted !== true && cfg.fallback.length > 0) {
        for (const route of cfg.fallback) {
          if (lifetime.signal.aborted) {
            outcome = { aborted: true, attempts: attemptsUsed };
            break;
          }
          log.warn(`提取主道不可恢复失败，尝试换道 ${route.provider}/${route.model}`);
          const attemptOutcome = await runAttemptChain(route.provider, route.model);
          attemptsUsed += attemptOutcome.attempts ?? 0;
          outcome = attemptOutcome;
          if (attemptOutcome.ok) {
            usedRoute = { provider: route.provider, model: route.model };
            fallbackUsed = true;
            break;
          }
          if (attemptOutcome.aborted === true) break;
        }
      }
      if (outcome.aborted === true) return { status: "error", detail: { outcome: "failed", reason: "aborted" } };
      if (!outcome.ok) throw outcome.error;
      text = outcome.text;
      truncated = outcome.truncated === true;
      if (truncated) {
        // 可见留痕：截断不是失败，但它意味着"可能少存了几条"，排障时必须看得见。
        log.warn(`提取输出被截断（finish.kind=max-tokens，已累积 ${text.length} 字符）：先按半截输出解析，解析失败才记 parse-error`);
      }
      if (fallbackUsed) {
        bumpFallbackUsed();
        log.info(`提取换道成功：${usedRoute.provider}/${usedRoute.model}`);
      }
    } catch (error) {
      noteFailure(
        "llm-error",
        `提取 LLM 调用失败（${attemptsUsed} 次 attempt 后放弃${cfg.fallback.length > 0 ? "，含换道" : ""}）：${error?.failure?.code ?? error?.message ?? "unknown"}`,
        session,
        { provider: usedRoute.provider, model: usedRoute.model, fromSeq: from, toSeq: to },
      );
      log.warn("提取 LLM 调用失败详情", error);
      // 路由策略：**失败不清槽**（保留 last-good 路由）。
      // 清槽的旧意图是"中途换模型可自愈"，但代价是失败后本会话立刻失去路由：
      // 下一轮 turn/end 在没有任何新 request/header 时必然记 no-route，再失败、再清……
      // 实测转移矩阵 llm-error → no-route 75/88，等于把一次模型侧抖动放大成结构性失败链。
      // 自愈仍然成立：captureRoute（request/header）本就是覆盖写，新模型的下一个
      // request/header 会直接顶掉旧路由；只有 source-only 路径（desktop 无 request/header）
      // 不覆盖，故这里打一个 stale 标记让它下次也能覆盖（见 captureRouteFromSource）。
      if (cfg.provider === void 0) {
        const st = sessionStates.get(session);
        if (st !== void 0 && st.route !== void 0) st.routeStale = true;
      }
      return { status: "error", detail: { outcome: "failed", reason: "llm-error" } };
    } finally {
      setExtractionInFlight(false);
    }
    // 有失败尝试后最终成功——打恢复时间戳（黄态依据；纯一路成功不打）
    if (attemptsUsed > 1) noteExtractionRecovered();

    // 截断但解析成功：记账观测键 truncatedParse（>0 才带上，形态同 redacted——
    // 盘上无此键 = 没有"截断仍解析成功"这回事，与显式 0 不区分）。
    // 它是"预算吃紧、输出被腰斩但这次刚好还够"的显式信号：面板/journal 看得见，
    // 才不会把这类轮次当成普通成功、直到某次真被腰斩成半截 JSON 才发现。
    const truncatedNote = truncated ? { truncatedParse: 1 } : {};
    let parsed;
    try {
      parsed = parseExtractionOutput(text);
    } catch (error) {
      // 半截 JSON 解析失败是**预期路径**（截断既可能是"刚好写完 ops"也可能是"写了一半"），
      // 不静默放过：记 parse-error 并显式标注是不是截断导致的，方便判断要不要调预算。
      const why = truncated ? "（输出被截断：kind=max-tokens，半截 JSON 无法解析）" : "";
      noteFailure("parse-error", `提取输出解析失败${why}：${error?.message ?? "unparseable"}`, session, { provider, model, fromSeq: from, toSeq: to });
      log.warn("提取输出解析失败详情", error);
      return { status: "error", detail: { outcome: "failed", reason: "parse-error" } };
    }
    if (parsed.kind === "nothing") {
      log.info(`提取完成：无需保存（seq ${from}..${to}）`);
      resetExtractionFailureStreak(session?.id);
      clearExtractionFailedRange(); // 成功即不再承诺补提，区间提示撤下
      // 模型侧判"无需保存"：结算成功但零 ops（与"ops 未落盘"区分开——
      // 前者是模型决定不写，后者是写了没落上，排障时的第一分岔）。
      return { status: "ok", detail: { outcome: "zero-ops", reason: "model-无产出", ...truncatedNote } };
    }
    if (parsed.skippedMalformed > 0) {
      // 跳单明细（名称+原因+实际长度）：不再只报数目，能指出具体是哪个 op 被丢了。
      const detail = Array.isArray(parsed.skippedDetails) && parsed.skippedDetails.length > 0
        ? `：${parsed.skippedDetails.map((d) => `${d.name || "（无名）"}[${d.reason}${typeof d.length === "number" ? ` ${d.length} 字` : ""}]`).join("，")}`
        : "";
      log.warn(`提取输出含 ${parsed.skippedMalformed} 条畸形 op 已跳单（好 ops 照常落盘，跳单容错）${detail}`);
    }
    let ops = parsed.ops.slice(0, cfg.maxOps);
    if (parsed.ops.length > cfg.maxOps) {
      log.warn(`ops 超额：模型返回 ${parsed.ops.length} 条，仅取前 ${cfg.maxOps}，丢弃 ${parsed.ops.length - cfg.maxOps} 条`);
    }
    // ---- 第二道脱敏（落盘前，纵深防御）----
    // 第一道在 transcript.js renderTranscript（进提示词前）；此处再兜一道：
    // 模型可能把密钥从别的路径（manifest、settings 回显、自身复述）带进 ops。
    // redactionEnabled=false 时完全不脱敏（回旧行为）。
    // 顺序纪律：先切片后脱敏（只脱要落盘的 ops，省算力）；
    // 命中数进 detail.redacted（>0 时 journal 行落 redacted 字段）。
    let redactedCount = 0;
    if (cfg.redactionEnabled) {
      const redacted = redactOps(ops);
      ops = redacted.ops;
      redactedCount = redacted.count;
      if (redactedCount > 0) {
        log.info(`落盘前脱敏：${redactedCount} 处敏感内容替换为 [redacted]（seq ${from}..${to}）`);
      }
    }
    try {
      // scope 路由落盘：project ops 走项目根；global:* 走全局分类根；
      // projectMemory/globalExtraction 开关各自过滤计数（对称推定）。
      // v0.4.0：写路径安全面接 gate（settings）——surgicalKeep / trashKeepDays /
      // hardfactPolicy 三项由此生效（缺键走默认，见 lib/settings.js）。
      const result = applyScopedOps(
        { storageRoot, projectRoot: paths.memoryDir },
        ops,
        { originSessionId: session.id, allowGlobal: gate.globalExtraction, allowProject: gate.projectMemory, settings: gate, log },
      );
      invalidateIndexCache();
      invalidateRuntimeAfterWrite(result, paths);
      if (result.writes > 0 || result.deletes > 0) onGlobalWrite("提取落盘");
      const filteredNote = result.filteredGlobal > 0 || result.filteredProject > 0
        ? `；过滤 global ${result.filteredGlobal} project ${result.filteredProject}（开关关）`
        : "";
      const unknownNote = result.unknownScope > 0 ? `；未知 scope 跳过 ${result.unknownScope}` : "";
      const failedNote = result.failed > 0 ? `；落盘失败 ${result.failed}（单条隔离不重试，见 error 日志）` : "";
      // v0.4.0 安全面留痕（计数可见即可查；见 /state.safety）
      const safetyBits = [];
      if (result.verifyFailed > 0) safetyBits.push(`校验失败回滚 ${result.verifyFailed}`);
      if (result.hardfactDrops > 0) safetyBits.push(`硬事实丢失 ${result.hardfactDrops}`);
      if (result.hardfactBlocks > 0) safetyBits.push(`硬事实拦截 ${result.hardfactBlocks}`);
      if (result.expectedSha1Mismatches > 0) safetyBits.push(`sha1 不符拒绝 ${result.expectedSha1Mismatches}`);
      if (result.blindWriteDowngrades > 0) safetyBits.push(`盲写降级追加 ${result.blindWriteDowngrades}`);
      if (result.lockConflicts > 0) safetyBits.push(`锁冲突阻断 ${result.lockConflicts}`);
      if (result.snapshotFailures > 0) safetyBits.push(`快照失败 ${result.snapshotFailures}`);
      if (result.blockedDestructiveOps > 0) safetyBits.push(`破坏性被阻 ${result.blockedDestructiveOps}`);
      const safetyNote = safetyBits.length > 0 ? `；安全面[${safetyBits.join("，")}]` : "";
      log.info(
        `提取落盘：写 ${result.writes} 删 ${result.deletes} 跳过 ${result.skipped}${failedNote}${filteredNote}${unknownNote}${safetyNote}（seq ${from}..${to}，${paths.slug}-${paths.hash}）`,
      );
      if (result.failed > 0) {
        // 单条 IO 失败计数留痕但 cursor 照常推进（斩断确定性重试循环）。
        // io-error 部分失败后【不】reset streak（紧跟下方 reset 会把
        // 红条抹掉，该桶变死观测）——软失败语义显式化：计数但保持可见。
        bumpExtractionFailure("io-error", session?.id);
        pushRecentFailure({ reason: "io-error", message: `落盘 ${result.failed} 条单 op 失败（cursor 照常推进）`, provider, model });
        appendExtractionError(storageRoot, { at: Date.now(), reason: "io-error", provider, model, message: `落盘 ${result.failed} 条单 op 失败（单条隔离不重试）` });
      } else {
        resetExtractionFailureStreak(session?.id);
      }
      clearExtractionFailedRange(); // 成功推进 cursor：区间不再承诺补提
      // 落盘结算明细：applied 才是"有没有真落上"的判据（skipped 是被开关过滤/畸形跳单，
      // 不算落盘）。三种分岔见下方对照，outcome 与 noteFailure 分桶同名便于对账。
      // （必须在 try 内：result 是块内绑定，出块即不可见。）
      const applied = result.writes + result.deletes;
      const filtered = result.filteredGlobal + result.filteredProject;
      // 脱敏命中数只在 >0 时进 detail（journal 行同理，>0 才写）。
      const redactedNote = redactedCount > 0 ? { redacted: redactedCount } : {};
      if (applied > 0) {
        return {
          status: "ok",
          detail: {
            outcome: "written",
            writes: result.writes,
            deletes: result.deletes,
            skippedOps: result.skipped,
            failedOps: result.failed,
            filtered,
            ...redactedNote,
            ...truncatedNote,
          },
        };
      }
      if (result.failed > 0) {
        // 一条都没落上且确有单 op 失败：cursor 照常推进是既有语义（斩断确定性重试循环），
        // journal 的 cursorAfter 会把"推进了但没写东西"这一事实留在盘上。
        return {
          status: "ok",
          detail: {
            outcome: "failed",
            reason: "io-error",
            writes: 0,
            deletes: 0,
            skippedOps: result.skipped,
            failedOps: result.failed,
            filtered,
            ...redactedNote,
            ...truncatedNote,
          },
        };
      }
      // 有 ops 但一条都没落上、也没报错：只可能是全被开关过滤/跳过——零 ops 而非失败。
      return {
        status: "ok",
        detail: {
          outcome: "zero-ops",
          reason: "ops-未落盘",
          writes: 0,
          deletes: 0,
          skippedOps: result.skipped,
          failedOps: 0,
          filtered,
          ...redactedNote,
          ...truncatedNote,
        },
      };
    } catch (error) {
      // 整批落盘结构性失败（如索引重建炸）：下轮重提（cursor 不推进）
      noteFailure("io-error", `记忆落盘失败：${error?.message ?? "io"}`, session, { provider, model, fromSeq: from, toSeq: to });
      log.error("记忆落盘失败详情", error);
      return { status: "error", detail: { outcome: "failed", reason: "io-error" } };
    }
  }

  // ---- 会话补提执行体（跨重启把盘上的失败区间读回来重提）----
  /**
   * 从宿主持久化层读回一个会话的 [from, to) 区间并跑提取任务体。异步执行，供
   * POST /api/sessions/recover 的后台任务调用（端点先回 202，结果经 /state.recover 观测）。
   *
   * 记账通路的选择：**自己调 journal.recordRun**（不复用 state.js 的 scheduler.run）。
   * 理由：scheduler 的会话状态 Map 按【活着的 session 对象】分键，补提用的是适配器合成
   * 对象，不在 Map 里；硬塞进去会污染单飞/pending 链（在线轮次与补提轮次的 cursor 语义不同源），
   * 也会让 session/disposed 清理对不上。但记账口径必须与在线完全一致——journal 的
   * pending 出列判据是「整段覆盖」（新行 from 不晚于旧区间起点且 cursorAfter 不早于 to），
   * 故成功即 cursorAfter=to（天然出列），失败即 cursorAfter=from（仍留在未恢复清单里等下次补）。
   *
   * @returns {Promise<{ok:boolean, outcome?:string, error?:string, detail?:object}>}
   */
  async function recoverSessionRange(sessionId, from, to) {
    const persistence = probePersistence();
    if (persistence === null) return { ok: false, error: "host-unsupported" };
    // 适配器：id/header.cwd/seq/snapshotEvents 四个提取触点都在它身上；读回失败透到 source.error。
    const adapter = await createSessionAdapter(persistence, sessionId, { log });
    if (adapter.source.error !== void 0) {
      return { ok: false, error: adapter.source.error };
    }
    // 区间必须整体落在读回范围内（seq=实际读回事件数，读回截断时即上限）：超出就整段拒绝。
    // 绝不把没读到的区间按已补提记账——那会把未提取的尾部判成已补、静默丢记忆。
    const maxSeq = typeof adapter.seq === "number" ? adapter.seq : 0;
    if (to > maxSeq) {
      return { ok: false, error: "range-unavailable" };
    }
    const result = await extractSession(adapter, from, to);
    const detail = result?.detail ?? {};
    const outcome = typeof detail.outcome === "string" ? detail.outcome : (result?.status === "ok" ? "zero-ops" : "failed");
    // 在线口径：status 'ok'（含 skipped/abandoned）→ cursor 推进到区间尾；error → 停在 from。
    // 区间尾再钳到读回边界（防御纵深：即使上面的校验被绕过，也不推到从未存在的位置）。
    const cursorAfter = result?.status === "ok" ? Math.min(to, maxSeq) : from;
    try {
      journal.recordRun({ sessionId, from, to, cursorAfter, ...detail });
    } catch (error) {
      log.error("补提结算记账失败（重启后该区间仍留在未恢复清单）", error);
    }
    return { ok: true, outcome, detail, status: result?.status };
  }

  /**
   * 触发一次补提（单飞）：已有补提在跑 → 直接返回 busy（调用方据此回 409 E_BUSY）。
   * 成功启动返回 { started:true }；本身不 await 执行体（后台），但把最终结果记进 recoverState。
   * @param {string} sessionId
   * @param {number} from
   * @param {number} to
   * @param {{trigger?: "manual"|"auto"}} [options] trigger 缺省 "manual"（API/按钮路径）；
   *   自动补提（A2）传 "auto"——只改观测面（lastAutoAt/lastAutoTrigger/autoAttempts），
   *   不影响单飞/记账口径。runs 上限不约束本函数的调用者：手动补提按设计不受限。
   * @returns {{started:boolean, busy?:boolean}}
   */
  function startSessionRecover(sessionId, from, to, { trigger = "manual" } = {}) {
    if (recoverState.inFlight) return { started: false, busy: true };
    recoverState.inFlight = true;
    recoverState.lastAt = Date.now();
    recoverState.lastSessionId = sessionId;
    recoverState.lastOutcome = "running";
    const isAuto = trigger === "auto";
    if (isAuto) {
      recoverState.autoAttempts += 1;
      recoverState.lastAutoAt = recoverState.lastAt;
      // 具体触发面（"disposed"|"turn/end"|"startup"，由 maybeAutoRecover 紧跟写入）；
      // 先置 "auto" 兜底——直接以 trigger:"auto" 调本函数（不经 maybeAutoRecover）时字段仍在。
      recoverState.lastAutoTrigger = "auto";
    }
    void (async () => {
      try {
        const out = await recoverSessionRange(sessionId, from, to);
        recoverState.lastOutcome = out.ok ? (out.outcome ?? "zero-ops") : `failed:${out.error ?? "unknown"}`;
        if (out.ok) log.info(`会话补提完成（${isAuto ? "auto" : "manual"}）：session=${sessionId} seq ${from}..${to} → ${recoverState.lastOutcome}`);
        else log.warn(`会话补提失败（${isAuto ? "auto" : "manual"}）：session=${sessionId}（${out.error}）`);
      } catch (error) {
        recoverState.lastOutcome = "failed:exception";
        log.error("会话补提异常", error);
      } finally {
        recoverState.inFlight = false;
      }
    })();
    return { started: true };
  }

  /** 补提清单（GET /api/sessions/pending 的数据面）：journal 快照 + 宿主探活。 */
  async function pendingRecoveryItems() {
    const persistence = probePersistence();
    const hostSupported = persistence !== null && typeof persistence.open === "function";
    const statOf = hostSupported && typeof persistence.stat === "function"
      ? async (id) => {
        try {
          return await persistence.stat(id);
        } catch {
          return null; // 单条探不动 → sessionAvailable:false（不炸整张清单）
        }
      }
      : null;
    const items = await buildPendingItems(journal.snapshot(), statOf);
    return { hostSupported, items };
  }

  // ---- 自动补提（压缩/退出边界收口；宿主无 compaction 事件，用三个触发面兜住）----
  /**
   * 自动补提决策与启动（压缩/退出边界收口）。
   *
   * 触发面（三处调用）：
   *   1. session/disposed：带 sessionId → 只补该会话的未恢复区间（会话刚亡，趁持久化层就在读回来）；
   *   2. turn/end completed：不带 sessionId → 全局清扫（journal 是收口的事实源）；
   *   3. apply 装载后数秒（启动清扫）：不带 sessionId → 跨重启续提的闭环（journal 持久）。
   *
   * 纪律：
   *   - 只自动补 kind=failed（journal unrecovered）；abandoned 已显式判死，绝不自动重试（否则
   *     "放弃"名存实亡、O(n²) 雪球换个门再滚起来）；
   *   - 单飞复用 recoverState.inFlight（经 startSessionRecover）——busy 即丢，下个触发面再试，
   *     绝不排队/并发（手动按钮与自动天然互斥）；
   *   - 冷却：键 `sessionId:from:to`，间隔 < autoRecoverCooldownMs 不再试。防 range-unavailable
   *     这类永不出列的区间被每个 turn/end 面白读一次（读回是真实 IO，不是零成本）；
   *   - host 不持久化（probePersistence()===null）→ 静默不跑只 debug 日志（能力缺失不是故障，
   *     与 /sessions/pending 的 503 摊牌语义一致：那边是显式请求，这边是后台习惯动作）；
   *   - 每次触发最多启动 1 个补提（单飞约束），取清单里最新的一条（buildPendingItems 已 at 降序）。
   *
   * @param {"disposed"|"turn/end"|"startup"} triggerOrigin 触发面标记（进 lastAutoTrigger 供观测）
   * @param {string} [sessionId] disposed 面才带（限定该会话）
   */
  function maybeAutoRecover(triggerOrigin, sessionId) {
    if (!cfg.autoRecoverEnabled) return;
    if (lifetime.signal.aborted) return; // dispose 后不再发起（与提取链路同纪律）
    if (recoverState.inFlight) return; // 单飞：busy 即丢（本函数不做排队；下个触发面再试）
    const persistence = probePersistence();
    if (persistence === null) {
      // 能力缺失不是故障：自动链路静默降级（只 debug 日志；显式请求路径另有 503 摊牌）。
      debugProbe(`auto-recover skip（host-unsupported，trigger=${triggerOrigin}）`);
      return;
    }
    let unrecovered;
    try {
      unrecovered = journal.snapshot()?.unrecovered;
    } catch (error) {
      log.warn("auto-recover：读 journal 快照失败，本轮不放行", error);
      return;
    }
    if (!Array.isArray(unrecovered) || unrecovered.length === 0) return;
    const now = Date.now();
    // 过期条目顺手清（冷却表封顶，见下）；阈值取冷却窗的 10 倍（窗口已足够覆盖重试节奏）。
    const expiryMs = Math.max(cfg.autoRecoverCooldownMs * 10, 3600_000);
    for (const [key, at] of autoRecoverCooldowns) {
      if (now - at > expiryMs) autoRecoverCooldowns.delete(key);
    }
    for (const item of unrecovered) {
      const sid = typeof item?.sessionId === "string" ? item.sessionId : "";
      if (sid.length === 0) continue;
      if (typeof sessionId === "string" && sessionId.length > 0 && sid !== sessionId) continue; // disposed 面限定本会话
      const from = Number.isFinite(Number(item.from)) ? Number(item.from) : 0;
      const to = Number.isFinite(Number(item.to)) ? Number(item.to) : 0;
      if (to <= from) continue; // 退化区间：没有可补的内容
      const key = `${sid}:${from}:${to}`;
      const last = autoRecoverCooldowns.get(key);
      if (typeof last === "number" && now - last < cfg.autoRecoverCooldownMs) {
        debugProbe(`auto-recover skip（cooldown，key=${key}，elapsed=${now - last}ms）`);
        continue; // 冷却中：跳过这条，继续找下一条
      }
      // 封顶防泄漏：超限即逐出最旧条目（Map 迭代序=插入序）。
      if (autoRecoverCooldowns.size >= AUTO_RECOVER_COOLDOWN_MAX) {
        const oldest = autoRecoverCooldowns.keys().next().value;
        if (oldest !== void 0) autoRecoverCooldowns.delete(oldest);
      }
      autoRecoverCooldowns.set(key, now);
      const started = startSessionRecover(sid, from, to, { trigger: "auto" });
      if (started.started === true) {
        recoverState.lastAutoTrigger = triggerOrigin;
        log.info(`自动补提启动（${triggerOrigin}）：session=${sid} seq ${from}..${to}`);
      }
      return; // 单飞：一次触发最多启动一个
    }
    debugProbe(`auto-recover 无可用区间（trigger=${triggerOrigin}）`);
  }

  // 启动清扫（触发面 3）：journal 是持久的，装载后延迟数秒跑一次——把上次进程退出时
  // 没补成的区间续上（"退出边界"的跨进程兜底）。定时器必须 unref + dispose 清理：
  // 绝不让测试进程/宿主进程被这个定时器挂住（设计纪律）。
  let startupSweepTimer = null;
  if (cfg.autoRecoverEnabled) {
    startupSweepTimer = setTimeout(() => {
      startupSweepTimer = null;
      try {
        maybeAutoRecover("startup");
      } catch (error) {
        log.warn("启动自动补提异常", error); // 不静默吞（规则3）；后台链路不炸宿主
      }
    }, 5000);
    if (typeof startupSweepTimer.unref === "function") startupSweepTimer.unref();
  }

  /**
   * 单次提取 LLM 调用（一次 attempt 一个 AbortController）。
   *
   * 返回形状：`{ text, truncated }`（不再直接返回裸字符串——max-tokens 半截输出要能带标记
   * 回到调用方，让"先尝试解析"成为一条显式路径，而不是靠 acc 猜）。
   *
   * 预算与思考档（本次修复的两半）：
   *   - `maxTokens` 为 0/undefined 时**不发这个键**：宿主 resolveCallFor 只在
   *     `config.maxTokens === undefined` 时才材料化模型默认值，传 0 会被当成 0 预算直接截死。
   *   - `reasoningEffort` 缺省（cfg.extractReasoningEffort === undefined）**不发这个键**：
   *     宿主按模型能力声明校验档位，不被支持的档位在 provider I/O 之前就被拒
   *     （UNSUPPORTED_REASONING_EFFORT），插件只能降级重发一次——对"只声明 high/max"的
   *     路由（本机主路由 magpie/group/mozu1 正是如此），硬发 low 等于每次提取白多一次
   *     往返，且最终仍按模型默认档跑，降档收益为零。故缺省保守地不干预。
   *
   * 宿主能力校验的已知边界（实测 @deepseek-ai/dsh-llm resolveCallWithInfo）：
   * 模型**不支持**所请求的档位时，宿主在发起 provider I/O 之前就以
   * `code=UNSUPPORTED_REASONING_EFFORT` 拒绝；非思考模型的 reasoning 元数据直接为
   * undefined，任何显式档位都会被拒。用户显式配了不支持的档位时，这里做**显式降级**：
   * 命中该 code 时把路由记进 reasoningUnsupported、打一条 warn（可见，不静默）、
   * 计一次 reasoningDegraded（/state 观测面见得到，见 lib/metrics.js），
   * 并立刻用"不带 reasoningEffort"重发一次。
   * 重发失败照常抛（不是 fail-open：一行 warn + 一次受限重发，绝不无限重试）。
   *
   * max-tokens 的处理（两种形态，各有显式路径）：
   *   - **有正文**：`finish.reason.kind === "max-tokens"` 只说明**被截断**，不等于没产出——
   *     已累积的 acc 可能是完整的 JSON（模型先写完 ops、再被思考尾巴截断），也可能是半截。
   *     此时带 truncated 标记返回，由调用方走正常解析：解析成功即照常落盘（记 truncatedParse
   *     观测），解析失败才记 parse-error。
   *   - **零正文**：真失败，但**不再一次判死**。实测机制（本机 magpie/group/mozu1 → 网关
   *     127.0.0.1:3425）：思考 token 与正文**共享同一个 maxTokens 预算**且思考链先跑，
   *     预算不够时正文必然为零（max_tokens=64 → reasoning 258 字符 / content 0 字符；
   *     不下发 reasoning_effort 也照样思考，故"丢档位"救不了）。两条显式路径：
   *       ① 本次**显式下发**过 maxTokens → 丢掉它、改跟随模型重发一次（唯一真正改变预算
   *          的手段；实测同一 prompt 不下发上限时正文正常产出）。只逃逸一次；
   *          **重发拿到正文才计数**（escapeRetried 在结果处记，不在发起处——发起≠成功，
   *          复查抓过"健康卡同时显示提取失败与重发成功"的谎报）。
   *       ② 本来就跟随模型 / 逃逸后仍零正文 → 抛错落 llm-error，**不进重试链**：
   *          跟随模型（本机 25 万 token 预算）仍零正文在实践中不可达；为它开链级重采样，
   *          最坏是 attempts × fallback 条数 次满预算调用（实测 retryAttempts=10 +
   *          3 条 fallback = 84 次）——拿真金白银换一个几乎不存在的场景，成本纪律不答应。
   *          显式配小上限的用户有 ① 这条有界的出路（最多多一次调用）。
   *
   * 在途中止按「执行结果」分类（controller.signal.reason 是谁置的就归谁，不猜 message）：
   *   - 计时器超时（signal.reason === timeoutError）→ 挂宿主同形 code=TIMEOUT（可重试族，
   *     链上退避重采样）。不分类的话宿主把它映射成 ABORTED（不在可重试族）→ 一次判死；
   *     实际运行 extraction-errors.log 13:28/13:37 两条 `llm-error … ABORTED` 正是这个形状
   *     （1291-seq 大区间撞 120s 上限）。
   *   - dispose（lifetime.signal）→ runAttemptChain 统一按 aborted 收场（见那边的注释），
   *     不进 llm-error 桶、不推失败连击。
   *
   * usage chunk（token/成本观测）：宿主在 finish 之前发
   * `{type:"usage", usage:{inputTokens, outputTokens, totalTokens, cacheReadTokens?, cacheWriteTokens?}}`
   * （app.asar 的 dsh-llm-pi-ai mapUsage）。此前这里把非 text-delta/finish 的 chunk 全丢了，
   * 于是 `maxOutputTokens` 缺省改 0 = 跟随模型（本机模型默认 250000，约 61 倍）之后，
   * 单次输出上限放大 61 倍这件事在 /state 上完全不可见。现在每一趟（含降档重发第二趟）
   * 收口时 bumpExtractionTokens 记一次，进 /state.extractionFailures.extractionTokens。
   *
   * @returns {Promise<{text:string, truncated:boolean}>}
   */
  async function callLlmText({ provider, model, system, user, maxTokens, reasoningEffort, sessionId, purpose = "dsh-keepsake-extraction" }) {
    const controller = new AbortController();
    callControllers.add(controller);
    const onAbort = () => controller.abort(lifetime.signal.reason);
    lifetime.signal.addEventListener("abort", onAbort, { once: true });
    // 计时器自己的 Error 对象：超时后凭 `controller.signal.reason === timeoutError`
    // 判定"这次中止是超时"（执行结果判据，不是猜 message——见函数头注）。
    const timeoutError = new Error(`dsh-keepsake: 提取超时 ${cfg.timeoutMs}ms`);
    const timer = setTimeout(() => controller.abort(timeoutError), cfg.timeoutMs);
    try {
      const messages = [{ role: "user", content: [{ type: "text", text: user }] }];
      const routeKey = `${provider}/${model}`;
      const wantsEffort = typeof reasoningEffort === "string" && reasoningEffort.length > 0
        && !reasoningUnsupported.has(routeKey);
      // 本次是否显式下发了输出上限：只有显式配了正数 maxOutputTokens 才有"丢掉它"这一招。
      // 缺省（0=跟随模型）时 maxTokens 键根本不出现，零正文就没有可退的预算了。
      const hasExplicitMaxTokens = typeof maxTokens === "number" && maxTokens > 0;
      // 一次调用内部最多跑三趟，两类逃逸各一次、互不挤出：
      //   ① UNSUPPORTED_REASONING_EFFORT → 丢档位重发（配置面能力不匹配）；
      //   ② 零正文 max-tokens → 丢显式输出上限、改跟随模型重发（预算面吃光）。
      // 第三个 pass 只为容纳"两类同时命中"的极端情形（先撞档位、再撞预算）；
      // 两个逃逸标志各自只置一次，故最多 3 趟，绝不无限重试。
      let allowEffort = wantsEffort;
      let budgetEscapeUsed = false;
      for (let pass = 0; pass < 3; pass += 1) {
        let acc = "";
        let finish;
        let usage; // 宿主 usage chunk 的 usage 原样（缺失=旧适配器，token 记 0 但调用仍计数）
        const options = {
          provider,
          model,
          system,
          messages,
          // 0/undefined = 跟随模型：键必须不出现（见函数头注）。
          // 预算逃逸后（budgetEscapeUsed）同样不再下发——那正是"丢掉显式上限"的语义。
          ...(hasExplicitMaxTokens && !budgetEscapeUsed ? { maxTokens } : {}),
          // 显式思考档（cfg.extractReasoningEffort，缺省=不下发，键不出现）
          ...(allowEffort ? { reasoningEffort } : {}),
          sessionId,
          purpose,
          signal: controller.signal,
        };
        try {
          for await (const chunk of ctx.llm.stream(options)) {
            if (chunk?.type === "text-delta" && typeof chunk.text === "string") acc += chunk.text;
            else if (chunk?.type === "usage") usage = chunk.usage;
            else if (chunk?.type === "finish") finish = chunk;
          }
        } catch (error) {
          // 在途超时：宿主把我们计时器的 controller.abort 映射成 ABORTED（不可重试族），
          // 但它的真实语义是 TIMEOUT。按 signal.reason 的执行结果补挂宿主同形 code，
          // 让重试链按既有 TIMEOUT 语义退避重采样（1291-seq 大区间撞 120s 上限的实际运行形状）。
          if (controller.signal.aborted && controller.signal.reason === timeoutError) {
            error.failure = { code: "TIMEOUT", message: timeoutError.message };
          }
          throw error;
        }
        // 提取与知识页共用同一调用器，但成本口径分开：知识页 token 不进提取成本面。
        if (purpose === "dsh-keepsake-extraction") bumpExtractionTokens(usage);
        const kind = finish?.reason?.kind;
        // 成功返回点：若这趟是"丢掉显式上限"的逃逸重发且真拿到了正文，才记 escapeRetried
        //（结果处计数：发起≠成功，否则逃逸失败时健康卡会同时显示"提取失败"与"重发成功"）。
        if (kind === "stop") {
          if (budgetEscapeUsed === true) bumpEscapeRetried();
          return { text: acc, truncated: false, usage };
        }
        if (kind === "max-tokens" && acc.length > 0) {
          if (budgetEscapeUsed === true) bumpEscapeRetried();
          return { text: acc, truncated: true, usage };
        }
        const code = finish?.reason?.failure?.code ?? "";
        // 能力不匹配：显式降级重跑一次（只在这一趟确实带了档位时）
        if (code === "UNSUPPORTED_REASONING_EFFORT" && allowEffort) {
          reasoningUnsupported.add(routeKey);
          allowEffort = false;
          bumpReasoningDegraded(); // 观测：/state.extractionFailures.reasoningDegraded（只 log.warn 看不见）
          log.warn(`宿主报告该路由不支持 reasoningEffort=${reasoningEffort}（${routeKey}）：本次丢弃该参数重发；后续同路由不再下发（降级为模型默认档）`);
          continue;
        }
        // 输出预算耗尽且正文零输出：**不是**"截断"，但也不该一次判死。
        // 实测机制（本机 magpie/group/mozu1 → 网关 127.0.0.1:3425）：思考 token 与正文
        // 共享同一个 maxTokens 预算，且思考链先跑——预算不够时正文必然为零（max_tokens=64
        // 时 reasoning 258 字符、content 0 字符；无论是否显式下发 reasoningEffort 都一样，
        // 档位不是思考的开关，故"丢档位"救不了）。
        // 唯一真正改变结果的手段是**改预算**：本次若显式下发过 maxTokens，丢掉它重发一次
        // （缺省=跟随模型）；实测同一 prompt 不下发 maxTokens 时正文正常产出。
        // 只逃逸一次（budgetEscapeUsed），绝不无限重试。计数在成功返回点（见上）。
        if (kind === "max-tokens" && budgetEscapeUsed !== true && hasExplicitMaxTokens) {
          budgetEscapeUsed = true;
          log.warn(`提取输出预算耗尽且正文零输出（maxTokens=${maxTokens}）：本次丢弃显式输出上限、改为跟随模型默认值重发一次`);
          continue;
        }
        // 走到这里 = 真失败（error/aborted/其它 kind；或 max-tokens 但一字未出）
        // failure 本体挂到 error 上供上层 classify（route on code，禁 message 正则）；
        // message 仅给人看的日志摘要（含 kind+code+status 摘要，正文供 debug）。
        // 注意：零正文 max-tokens **不**补自造 code 进重试族——跟随模型仍零正文在实践中
        // 不可达，链级重采样最坏是 attempts × fallback 次满预算调用（见函数头注②），
        // 一次判死落 llm-error 是成本纪律下的正确摊牌；显式配小上限的用户有逃逸这条路。
        const failure = finish?.reason?.failure;
        const status = failure?.status ?? "";
        const suffix = kind === "max-tokens" ? "（输出预算耗尽且正文零输出）" : "";
        const error = new Error(`dsh-keepsake: 提取调用异常结束 kind=${String(kind)}${code ? ` code=${code}` : ""}${status ? ` status=${String(status)}` : ""}${suffix}`);
        if (failure !== void 0 && failure !== null) error.failure = failure;
        throw error;
      }
      // 循环必然在上面 return 或 throw（pass 上限为 2 且第二趟 allowEffort=false 不会再 continue）。
      throw new Error("dsh-keepsake: 提取调用异常结束 kind=unknown（内部状态异常）");
    } finally {
      clearTimeout(timer);
      lifetime.signal.removeEventListener("abort", onAbort);
      callControllers.delete(controller);
    }
  }

  // ---- 知识页（派生视图；手动生成，不自动烧 token） ----
  let pagesInFlight = false;

  function resolvePageRoute() {
    if (typeof cfg.provider === "string" && typeof cfg.model === "string"
      && cfg.provider.length > 0 && cfg.model.length > 0) {
      return { provider: cfg.provider, model: cfg.model };
    }
    if (lastKnownRoute !== null) return { ...lastKnownRoute };
    const first = Array.isArray(cfg.fallback) ? cfg.fallback[0] : null;
    if (first !== null && typeof first?.provider === "string" && typeof first?.model === "string") {
      return { provider: first.provider, model: first.model };
    }
    return null;
  }

  async function generatePagesForProject(projectId) {
    if (pagesInFlight) {
      const error = new Error("已有知识页生成在进行中，请稍候再试");
      error.code = "E_BUSY";
      throw error;
    }
    const gate = readSettings(storageRoot, log);
    if (!gate.conversationMemory || !gate.projectMemory) {
      const error = new Error("对话记忆/项目记忆开关关闭，无法生成知识页");
      error.code = "E_DISABLED";
      throw error;
    }
    const route = resolvePageRoute();
    if (route === null) {
      const error = new Error("尚无可用模型路由：先进行一次对话，或在配置里显式指定 provider/model");
      error.code = "E_NO_ROUTE";
      throw error;
    }
    pagesInFlight = true;
    try {
      return await generatePages({
        storageRoot,
        projectId,
        model: `${route.provider}/${route.model}`,
        log,
        callLlm: async ({ system, user }) => {
          const result = await callLlmText({
            provider: route.provider,
            model: route.model,
            system,
            user,
            maxTokens: 0,
            reasoningEffort: cfg.extractReasoningEffort,
            sessionId: lastKnownSessionId,
            purpose: "dsh-keepsake-pages",
          });
          return { text: result.text };
        },
      });
    } finally {
      pagesInFlight = false;
    }
  }

  // ---- 纠错闭环（给定一条记忆被判有误 → 产出最小修正；手动/命令触发） ----
  // 与知识页/空闲整理共用同一套路由解析与落盘通路；区别是它只改被指名的那条，
  // 且失败/需补充信息都不算"成功"（见 lib/corrections.js 结局口径）。
  let correctionInFlight = false;

  /**
   * 纠错前的公共定位：读开关 → 取路由 → 解析 scope 到记忆目录。
   * 单条与批量纠错共用（批量只是把这段算一次，然后逐条跑）。
   * @returns {{gate: object, route: object}} 失败时抛带 code 的 Error
   * @throws {Error & {code:string}}
   */
  function resolveCorrectionContext() {
    const gate = readSettings(storageRoot, log);
    if (!gate.conversationMemory) {
      const error = new Error("对话记忆开关关闭，无法执行纠错");
      error.code = "E_DISABLED";
      throw error;
    }
    const route = resolvePageRoute();
    if (route === null) {
      const error = new Error("尚无可用模型路由：先进行一次对话，或在配置里显式指定 provider/model");
      error.code = "E_NO_ROUTE";
      throw error;
    }
    return { gate, route };
  }

  /**
   * 把 scope + projectId 解析成「记忆目录 + 记录用 scope 标签」。
   * scope 缺省 project；project 可用 projectId 指定，否则回落 last-known workspace。
   * @returns {{scopeValue: string, memoryDir: string, scopeLabel: string}}
   * @throws {Error & {code:string}}
   */
  function resolveCorrectionScope(scope, projectId) {
    const scopeValue = typeof scope === "string" && scope.length > 0 ? scope : "project";
    let memoryDir = "";
    let scopeLabel = scopeValue;
    if (scopeValue === "project") {
      if (typeof projectId === "string" && projectId.length > 0) {
        if (!isValidProjectId(projectId)) {
          const error = new Error("projectId 不合法");
          error.code = "E_INVALID_PROJECT";
          throw error;
        }
        memoryDir = join(storageRoot, "projects", projectId, "memory");
      } else {
        const cwd = lastKnownCwd;
        if (typeof cwd === "string" && cwd.length > 0) {
          memoryDir = projectMemoryPaths(storageRoot, cwd).memoryDir;
          scopeLabel = `project:${projectMemoryPaths(storageRoot, cwd).slug}`;
        }
      }
      if (memoryDir.length === 0) {
        const error = new Error("无法确定项目：请指定 projectId，或先在有工作区的会话里对话一次");
        error.code = "E_NO_PROJECT";
        throw error;
      }
    } else if (!/^global:[a-z-]+$/.test(scopeValue)) {
      const error = new Error(`未知 scope "${scopeValue}"`);
      error.code = "E_INVALID_SCOPE";
      throw error;
    }
    return { scopeValue, memoryDir, scopeLabel };
  }

  /** 纠错用的 LLM 调用器（与知识页/空闲整理同构：单次调用、跟随模型预算）。 */
  function correctionCallLlm(route) {
    return async ({ system, user }) => {
      const out = await callLlmText({
        provider: route.provider,
        model: route.model,
        system,
        user,
        maxTokens: 0,
        reasoningEffort: cfg.extractReasoningEffort,
        sessionId: lastKnownSessionId,
        purpose: "dsh-keepsake-correction",
      });
      return { text: out.text };
    };
  }

  async function correctMemory({ target, reason, kind, scope, projectId = "", sessionId = "" }) {
    if (correctionInFlight) {
      const error = new Error("已有纠错在进行中，请稍候再试");
      error.code = "E_BUSY";
      throw error;
    }
    const { gate, route } = resolveCorrectionContext();
    const { scopeValue, memoryDir, scopeLabel } = resolveCorrectionScope(scope, projectId);

    correctionInFlight = true;
    try {
      return await applyCorrection({
        storageRoot,
        target,
        currentBody: resolveCorrectionBody(storageRoot, scopeValue, target, memoryDir),
        reason,
        kind,
        scopeLabel,
        neighbors: buildCorrectionNeighbors(storageRoot, scopeValue, target, memoryDir),
        parseOps: parseExtractionOutput,
        applyOps: applyScopedOps,
        projectRoot: memoryDir,
        originSessionId: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : lastKnownSessionId,
        settings: gate,
        log,
        callLlm: correctionCallLlm(route),
      });
    } finally {
      correctionInFlight = false;
    }
  }

  /**
   * 批量纠错：一次提交多条（每条自带诉求）。
   *
   * 与单条的差别只在「逐条」：共用的开关/路由检查只做一次（省 N 次读盘），
   * scope 定位逐条算（批量里各条可能跨 scope），失败逐条隔离。
   * 单飞标记仍按整批占：批量执行期间单条入口也拒绝（否则两条纠错会并发抢提取批锁）。
   */
  async function correctMemoryBatch({ items = [], sessionId = "" }) {
    if (correctionInFlight) {
      const error = new Error("已有纠错在进行中，请稍候再试");
      error.code = "E_BUSY";
      throw error;
    }
    if (!Array.isArray(items) || items.length === 0) {
      const error = new Error("items 必填且非空");
      error.code = "E_EMPTY_BATCH";
      throw error;
    }
    if (items.length > CORRECTION_MAX_BATCH) {
      const error = new Error(`单批最多 ${CORRECTION_MAX_BATCH} 条（收到 ${items.length} 条）`);
      error.code = "E_TOO_MANY";
      throw error;
    }
    // 开关与路由先整体校验：批量是显式动作，N 次调用前必须确认环境齐备，
    // 不能跑到第三条才发现没路由、白烧两次调用。
    const { gate, route } = resolveCorrectionContext();
    const originSessionId = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : lastKnownSessionId;

    correctionInFlight = true;
    try {
      return await applyCorrections({
        storageRoot,
        items,
        parseOps: parseExtractionOutput,
        applyOps: applyScopedOps,
        originSessionId,
        settings: gate,
        log,
        callLlm: correctionCallLlm(route),
        // 逐条定位：批量里各条可能跨 scope（一条项目 + 一条全局），
        // 单条定位失败只废该条（resolveCorrectionScope 抛错 → 该条判 error）。
        resolveBody: (item) => {
          const { scopeValue, memoryDir } = resolveCorrectionScope(item.scope, item.projectId);
          return resolveCorrectionBody(storageRoot, scopeValue, item.target, memoryDir);
        },
        resolveNeighbors: (item) => {
          const { scopeValue, memoryDir } = resolveCorrectionScope(item.scope, item.projectId);
          return buildCorrectionNeighbors(storageRoot, scopeValue, item.target, memoryDir);
        },
        projectRootOf: (item) => {
          try {
            return resolveCorrectionScope(item.scope, item.projectId).memoryDir;
          } catch {
            return "";
          }
        },
      });
    } finally {
      correctionInFlight = false;
    }
  }

  /** 读被纠错条目的当前正文（读不到给空串——不阻断，模型会按"空条目"处理）。 */
  function resolveCorrectionBody(root, scope, target, memoryDir) {
    try {
      if (scope.startsWith("global:")) {
        const categoryId = scope.slice("global:".length);
        const entry = readEntry(storageRoot, categoryId, target);
        return entry === null ? "" : entry.content;
      }
      const full = join(memoryDir, target);
      // 包含性：纠错目标也必须是记忆目录内的 .md（与落盘边界同口径）
      if (!full.startsWith(memoryDir)) return "";
      return existsSync(full) ? readFileSync(full, "utf8") : "";
    } catch {
      return "";
    }
  }

  /** 邻域上下文：同 scope 的 manifest（让模型知道"和哪条重复"），不含别的正文。 */
  function buildCorrectionNeighbors(root, scope, target, memoryDir) {
    try {
      const dir = scope.startsWith("global:")
        ? join(storageRoot, "global", scope.slice("global:".length))
        : memoryDir;
      if (!existsSync(dir)) return "";
      const { manifest } = buildManifestText(dir, { maxFiles: 40, bodyFiles: 0 });
      return String(manifest ?? "")
        .split("\n")
        .filter((line) => line.trim().length > 0 && !line.includes(`[${target}]`))
        .slice(0, 40)
        .join("\n");
    } catch {
      return "";
    }
  }

  // ---- 空闲整理（idle review；默认关，只在提取新增条目后调度） ----
  function maybeScheduleIdleReview(session, result) {
    try {
      const gate = readSettings(storageRoot, log);
      if (!gate.idleReviewEnabled || !gate.conversationMemory || !gate.projectMemory) return;
      if (result?.status !== "ok") return;
      const writes = Number(result?.detail?.writes ?? 0);
      if (!Number.isFinite(writes) || writes <= 0) return;
      const cwd = session?.header?.cwd;
      if (typeof cwd !== "string" || cwd.length === 0) return;
      const paths = projectMemoryPaths(storageRoot, cwd);
      let state = sessionStates.get(session);
      if (state === void 0) {
        state = {};
        sessionStates.set(session, state);
      }
      const review = state.idleReview ?? { count: 0, lastAt: 0, timer: null };
      const now = Date.now();
      if (review.count >= IDLE_REVIEW_MAX_PER_SESSION) return;
      if (review.lastAt > 0 && now - review.lastAt < IDLE_REVIEW_MIN_INTERVAL_MS) return;
      if (review.timer !== null) {
        clearTimeout(review.timer);
        idleReviewTimers.delete(review.timer);
      }
      const timer = setTimeout(() => {
        review.timer = null;
        idleReviewTimers.delete(timer);
        void runIdleReviewForSession(session, paths, review);
      }, IDLE_REVIEW_DELAY_MS);
      if (typeof timer.unref === "function") timer.unref();
      review.timer = timer;
      idleReviewTimers.add(timer);
      state.idleReview = review;
    } catch (error) {
      // 后台调度失败只 warn：不影响提取主链路。
      log.warn("空闲整理调度失败", error);
    }
  }

  async function runIdleReviewForSession(session, paths, review) {
    if (lifetime.signal.aborted || idleReviewInFlight) return;
    if (review.count >= IDLE_REVIEW_MAX_PER_SESSION) return;
    const gate = readSettings(storageRoot, log);
    if (!gate.idleReviewEnabled || !gate.conversationMemory || !gate.projectMemory) return;
    const route = resolvePageRoute(); // 与知识页共用「显式配置 → last-known → fallback」
    if (route === null) {
      log.warn("空闲整理跳过：尚无可用模型路由");
      return;
    }
    idleReviewInFlight = true;
    review.count += 1;
    review.lastAt = Date.now();
    try {
      const result = await runIdleReview({
        storageRoot,
        memoryDir: paths.memoryDir,
        originSessionId: typeof session?.id === "string" ? session.id : "",
        settings: gate,
        log,
        applyOps: applyScopedOps,
        callLlm: async ({ system, user }) => {
          const out = await callLlmText({
            provider: route.provider,
            model: route.model,
            system,
            user,
            maxTokens: 0,
            reasoningEffort: cfg.extractReasoningEffort,
            sessionId: lastKnownSessionId,
            purpose: "dsh-keepsake-idle-review",
          });
          return { text: out.text };
        },
      });
      if (result.outcome === "written") {
        invalidateIndexCache();
        invalidateRuntimeAfterWrite(result.applyResult, paths);
      }
      if (result.outcome === "error") log.warn(`空闲整理失败：${result.error ?? "unknown"}`);
    } catch (error) {
      log.error("空闲整理异常", error);
    } finally {
      idleReviewInFlight = false;
    }
  }

  // ---- 注入（边界④预算在 truncateWithWarning 内强制） ----
  function cwdOf(context) {
    const cwd = context?.agent?.session?.header?.cwd;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : void 0;
  }

  function memoryDirFor(context) {
    const cwd = cwdOf(context);
    if (cwd === void 0) return void 0;
    try {
      return projectMemoryPaths(storageRoot, cwd).memoryDir;
    } catch {
      return void 0;
    }
  }

  /**
   * runtime scope 判定（RUNTIME-FORMAT §10.1）：复用 projectMemoryPaths
   * （storageRoot + cwd → `<slug>-<hash16>`）拼 scope 字符串；cwd 不可得/推导失败 → 回落 "global"。
   * 返回只可能是 "global" 或 "projects/<slug>-<hash16>"（lib/runtime.js 的 scope 口径，直接可入参）。
   */
  function runtimeScopeFor(context) {
    const cwd = cwdOf(context);
    if (cwd === void 0) return "global";
    try {
      const paths = projectMemoryPaths(storageRoot, cwd);
      return `projects/${paths.slug}-${paths.hash}`;
    } catch {
      return "global"; // cwd 非法/不可 resolve：按全局 scope 降级（不抛、不注入项目内容）
    }
  }

  /** 读 runtime 产物文本（USER.md / MEMORY.md；缺任一 → null = 缓存不可用）。 */
  function readRuntimeTexts(scope) {
    try {
      const dir = scopeDir(storageRoot, scope);
      return {
        user: readFileSync(join(dir, "USER.md"), "utf8").trim(),
        memory: readFileSync(join(dir, "MEMORY.md"), "utf8").trim(),
      };
    } catch {
      return null;
    }
  }

  /**
   * runtime 两段求值（RUNTIME-FORMAT §八/§十）。
   *   - 只读闸（format-readonly，现有 formatState）：不编译、不写盘——readRuntimeManifest 有缓存
   *     且两份产物在盘上 → 用缓存文本；无缓存/产物缺 → 两段为空。两种情况 usage 都记 `[runtime readOnly]`。
   *     只读态的去重口径必须**用盘上这份清单自己的选条结果**，不能假定"三分类全覆盖"——
   *     降级期间新写入的条目不在清单里，整类抹掉会让它们既不在产物也不在索引（彻底不可见）。
   *   - 正常：ensureCompiled（懒编译；sourceHash 命中不重写任何文件）；status=error → 两段为空 +
   *     usage 记 `[runtime degraded: compile error]`（可见降级，不 fail-open）。
   *   - 同 scope 短 TTL 记忆（RUNTIME_MEMO_TTL_MS）：section 模式六段各自求值会重复触发
   *     ensureCompiled（每次都要读一遍候选池算 sourceHash），记忆化把一轮 prompt 组装压到一次；
   *     写盘路径（invalidateRuntimeAfterWrite）显式清记忆，外部改动最多滞后一个 TTL。
   * @returns {{ user: string, memory: string, coveredCategories: string[], coveredProjectFiles: string[], note: string }}
   *   coveredCategories = 产物**完整**承载的全局分类（globalIndex 分类粒度去重的判定依据；
   *   有淘汰条目的分类不在其中）；coveredProjectFiles = 已进产物的项目条目文件名
   *   （projectIndex 剔重依据；没进产物的照旧留在索引）；note 非空 = 要挂进 usage 段的可见告警行。
   */
  function runtimeTextFor(scope) {
    const now = Date.now();
    const hit = runtimeMemo.get(scope);
    if (hit !== undefined && now - hit.at < RUNTIME_MEMO_TTL_MS) return hit.value;
    const value = computeRuntimeText(scope);
    runtimeMemo.set(scope, { at: now, value });
    return value;
  }

  function computeRuntimeText(scope) {
    if (!formatState.ok) {
      const cached = readRuntimeManifest(storageRoot, scope);
      const texts = cached !== null && cached.status !== "error" ? readRuntimeTexts(scope) : null;
      if (texts === null) {
        return { user: "", memory: "", coveredCategories: [], coveredProjectFiles: [], note: "[runtime readOnly]" };
      }
      // 只读态只能用盘上这份清单判断覆盖——但清单可能已 stale（降级期间新增/改了条目，
      // 出于只读规则不会重编）。此时若照单全收「三分类全覆盖」，新条目会既不在产物、又被索引整类摘掉。
      // 判据：清单指纹与当前候选池一致才信任覆盖集；不一致就保守不做去重（索引照旧渲染，内容不会丢）。
      let fresh = false;
      try {
        fresh = computeSourceHash({ storageRoot, scope }) === cached.sourceHash;
      } catch {
        fresh = false; // 算不出指纹（读失败）同样按 stale 处理：宁可不省重复，不可丢内容
      }
      const note = fresh ? "[runtime readOnly]" : "[runtime readOnly, stale artifacts: index not deduplicated]";
      return {
        user: texts.user,
        memory: texts.memory,
        coveredCategories: fresh ? runtimeCoveredCategoriesOf(cached) : [],
        coveredProjectFiles: fresh ? runtimeCoveredProjectFilesOf(cached) : [],
        note,
      };
    }
    let manifest;
    try {
      manifest = ensureCompiled({ storageRoot, scope, trigger: "inject", log });
    } catch (error) {
      log.warn(`runtime 编译异常（scope=${scope}），本轮跳过 runtime 段`, error);
      return { user: "", memory: "", coveredCategories: [], coveredProjectFiles: [], note: "[runtime degraded: compile error]" };
    }
    if (manifest === null || manifest === void 0 || manifest.status === "error") {
      return { user: "", memory: "", coveredCategories: [], coveredProjectFiles: [], note: "[runtime degraded: compile error]" };
    }
    const texts = readRuntimeTexts(scope);
    if (texts === null) {
      return { user: "", memory: "", coveredCategories: [], coveredProjectFiles: [], note: "[runtime degraded: artifacts missing]" };
    }
    // overQuota 照常注入（产物内已有可见告警行；§七：锁定段不动刀，收敛靠重编译/归档）
    return {
      user: texts.user,
      memory: texts.memory,
      coveredCategories: runtimeCoveredCategoriesOf(manifest),
      coveredProjectFiles: runtimeCoveredProjectFilesOf(manifest),
      note: "",
    };
  }

  function usageTextFor(memoryDir) {
    return [
      USAGE_HEADER,
      "",
      `This project has persistent memory at: ${memoryDir}`,
      "- MEMORY.md is the index; each line points to one memory file. Read MEMORY.md first, then Read any file whose hook matters before relying on it.",
      "- One file = one fact, with frontmatter (name / description / metadata.type). Types: user (who the user is), feedback (how to behave, include Why: and How to apply:), project (decisions and state of this project), reference (pointers).",
      '- Link related memories with [[name]]; dangling links are fine.',
      "- When the user asks you to remember something: Write the memory file directly (the directory already exists — do not mkdir) and append one index line to MEMORY.md: `- [Title](file.md) — one-line hook` (at most 150 chars).",
      "- When the user asks you to forget something: delete that memory file and its index line.",
      "- Do not save what the repository already records, or details only this session needs.",
      "- Turns with direct writes into the memory directory skip automatic extraction.",
    ].join("\n");
  }

  /**
   * 项目索引的完整文本 + 紧凑兜底文本（同一份缓存，避免一轮读两次 MEMORY.md）。
   * full = 现有注入形态（200 行 / 25k 字符，保最新）；
   * compact = 预算装不下 full 时的降级形态：总条数 + 最新 N 行 + 完整索引路径。
   * 两者都做过 runtime 覆盖条目剔除；返回 "" 表示该段本就不该出现。
   */
  function indexTextsFor(memoryDir, coveredFiles = []) {
    const indexPath = join(memoryDir, INDEX_FILENAME);
    // 去重集合进缓存键：同一份 MEMORY.md 在 runtime 覆盖集变化后要重新过滤，不能命中旧文本。
    const coveredKey = Array.isArray(coveredFiles) && coveredFiles.length > 0 ? [...coveredFiles].sort().join(",") : "";
    let key = "";
    try {
      const stat = statSync(indexPath);
      // 缓存键必须含项目维度：同 size+mtime 的两个项目不得互相串索引
      key = `${memoryDir}|${stat.mtimeMs}:${stat.size}|${coveredKey}`;
    } catch {
      return { full: "", compact: "" }; // 无索引 = 无记忆，注入空段（renderPrompt 丢弃空 section）
    }
    if (indexCache.key === key && indexCache.text !== null) {
      return { full: indexCache.text, compact: indexCache.compact ?? "" };
    }
    let full = "";
    let compact = "";
    try {
      const content = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
      const covered = new Set((Array.isArray(coveredFiles) ? coveredFiles : []).map((f) => String(f).replace(/\\/g, "/").toLowerCase()));
      const remaining = covered.size === 0
        ? content
        : content.split("\n").filter((line) => {
          const matched = line.match(/^\s*-\s*\[[^\]]*\]\(([^)]+\.md)\)/i);
          if (matched === null) return true; // 非条目行（前言行、空行）原样保留
          return !covered.has(matched[1].trim().replace(/\\/g, "/").toLowerCase());
        }).join("\n");
      // 全被覆盖 = 项目条目都已在产物里 → 整段不出，避免只留一个空标题
      if (remaining.trim().length === 0) {
        indexCache = { key, text: "", compact: "" };
        return { full: "", compact: "" };
      }
      full = [
        "## Project memory index (MEMORY.md)",
        "",
        // preferTail 保最新丢最旧（merge 语义新条目在尾部，
        // 此前保头部导致 >200 条后的新记忆反而从注入里消失）
        truncateWithWarning(remaining, cfg.maxIndexLines, cfg.maxIndexChars, { preferTail: true }),
      ].join("\n");
      compact = compactProjectIndexText(remaining, indexPath);
      indexCache = { key, text: full, compact };
    } catch (error) {
      // 显式可见降级：读失败注入空段并告警，不让单次 IO 失败炸掉整个 prompt 组装
      log.warn("MEMORY.md 读取失败，本轮不注入索引", error);
      return { full: "", compact: "" };
    }
    return { full, compact };
  }

  function indexTextFor(memoryDir, coveredFiles = []) {
    return indexTextsFor(memoryDir, coveredFiles).full;
  }

  /**
   * 项目索引紧凑版：只保留条目行 + 总数 + 最新 N 行 + 完整索引路径。
   * 也用于 full 已超预算时的兜底——比「整段消失」多给模型一个可读入口。
   */
  function compactProjectIndexText(remaining, indexPath) {
    const lines = String(remaining ?? "").split("\n");
    const entryLines = lines.filter((line) => /^\s*-\s*\[[^\]]*\]\([^)]+\.md\)/i.test(line));
    if (entryLines.length === 0) return "";
    const kept = entryLines.slice(-PROJECT_INDEX_COMPACT_LINES);
    const more = entryLines.length - kept.length;
    const out = [
      "## Project memory index (MEMORY.md) — compact",
      "",
      `${entryLines.length} entries; showing latest ${kept.length}${more > 0 ? `; full index: ${indexPath}` : ""}.`,
      ...kept,
    ];
    if (more > 0) out.push("", `[+${more} older entries omitted — Read MEMORY.md for the full index.]`);
    return out.join("\n");
  }

  /** 4990 人设段：称呼指令（空则略句）+ 人设正文；正文清空且无称呼 = 空段丢弃。
   * 正文过注入预算（400 行/8000 字符）截断+可见 WARNING——
   * 0.6.0 从 16000 降到 8000（RUNTIME-FORMAT §10.2）：为 runtime 两段腾预算，
   * 8000 字符 × 1.5 = 12000 tokens，加 runtime 常驻 ≈ 19170 < injectMaxTokens 24000。 */
  function personaTextFor() {
    const addressing = readAddressing(storageRoot, log);
    const persona = readPersona(storageRoot, log);
    const lines = [];
    if (addressing.dshName.length > 0) lines.push(`用户叫你「${addressing.dshName}」。`);
    if (addressing.userAlias.length > 0) lines.push(`希望你称呼他为「${addressing.userAlias}」。`);
    const body = persona.content.trim();
    if (lines.length === 0 && body.length === 0) return ""; // 空段自动丢弃
    const parts = ["## 用户为 DSH 设定的补充人设", ""];
    if (lines.length > 0) parts.push(lines.join("\n"), "");
    if (body.length > 0) parts.push(truncateWithWarning(body, 400, 8000, { label: "人设" }));
    return parts.join("\n");
  }

  /**
   * 4995 全局索引段：分类索引 + 全局记忆根路径一行；任一「被渲染的」分类非空才注入。
   * runtimeCoveredCategories 里的分类已由 runtime 段**完整**承载 → 不渲染；
   * 只要有条目被配额淘汰，该分类就不在集合里（索引照旧渲染，被淘汰的条目仍可见）。
   * long-term 恒不渲染（§10.3-1）。
   */
  function globalIndexTextFor({ runtimeCoveredCategories = [] } = {}) {
    const { text, nonEmpty } = renderGlobalIndex(storageRoot, {
      perCategoryLines: GLOBAL_CATEGORY_BUDGET_LINES,
      keepDays: effectiveRecentKeepDays(),
      runtimeCoveredCategories,
    });
    if (!nonEmpty) return "";
    return [
      "## Global memory index (user-level, applies to all conversations)",
      "",
      `Global memory root: ${globalRoot(storageRoot)} — each line points to one memory file; Read any file whose hook matters.`,
      "",
      truncateWithWarning(text, GLOBAL_INDEX_TOTAL_LINES, GLOBAL_INDEX_TOTAL_CHARS, { preferTail: true }),
    ].join("\n");
  }

  /**
   * 全局索引的紧凑兜底（预算装不下 full 时用）：每类保留最新 N 行 + 总条数 + 索引路径。
   * 渲染集与 full 严格同源（long-term 恒移除、runtime 完整覆盖的分类移除），只压行数；
   * 计数按**索引文件里的条目行**算（recent-activity 按条目列表算），不把前言行算进去。
   */
  function compactGlobalIndexTextFor({ runtimeCoveredCategories = [] } = {}) {
    const omitted = new Set([ARCHIVED_CATEGORY_ID]);
    for (const id of Array.isArray(runtimeCoveredCategories) ? runtimeCoveredCategories : []) omitted.add(id);
    const sections = [];
    let nonEmpty = false;
    for (const id of CATEGORY_IDS) {
      if (omitted.has(id)) continue;
      let lines = [];
      let total = 0;
      if (id === "recent-activity") {
        const entries = [...listEntries(storageRoot, "recent-activity")]
          .sort((a, b) => recentTsOf(b) - recentTsOf(a));
        total = entries.length;
        const now = Date.now();
        const keepDays = effectiveRecentKeepDays();
        lines = entries.slice(0, GLOBAL_INDEX_COMPACT_LINES).map((entry) => {
          const ts = recentTsOf(entry);
          const ageDays = Math.floor((now - ts) / 86400_000);
          const expireDays = Math.max(0, keepDays - ageDays);
          const ageText = ageDays <= 0 ? "今天" : ageDays === 1 ? "1 天前" : `${ageDays} 天前`;
          const desc = entry.description ? ` — ${entry.description}` : "";
          return `- [${entry.title}](${entry.name})${desc}（${ageText} · ${expireDays} 天后过期）`;
        });
      } else {
        const indexPath = join(globalRoot(storageRoot), id, INDEX_FILENAME);
        let content = "";
        try {
          content = readFileSync(indexPath, "utf8");
        } catch {
          content = "";
        }
        const entryLines = content.split("\n").filter((line) => /^\s*-\s*\[[^\]]*\]\([^)]+\.md\)/i.test(line));
        total = entryLines.length;
        lines = entryLines.slice(-GLOBAL_INDEX_COMPACT_LINES);
      }
      if (lines.length === 0) continue;
      nonEmpty = true;
      const more = Math.max(0, total - lines.length);
      const indexPath = join(globalRoot(storageRoot), id, INDEX_FILENAME);
      sections.push(`### ${CATEGORY_LABELS[id]} (${id}) · 共 ${total} 条`);
      sections.push(lines.join("\n") + (more > 0 ? `\n（另有 ${more} 条，Read ${indexPath}）` : ""));
      sections.push("");
    }
    if (!nonEmpty) return "";
    return [
      "## Global memory index (user-level, applies to all conversations) — compact",
      "",
      `Global memory root: ${globalRoot(storageRoot)} — compact view; Read MEMORY.md for the full index.`,
      "",
      sections.join("\n").trim(),
    ].join("\n");
  }

  /**
   * 使用说明段文本 + runtime 可见告警行（§十一：status=error/只读闸都记进 usage）。
   * usage 本身（无 cwd）为空时，告警行单独成段——可见降级不能因为没有项目目录就消失。
   */
  function usageTextWithNote(memoryDir, note) {
    const base = memoryDir === void 0 ? "" : usageTextFor(memoryDir);
    if (note === "") return base;
    return base === "" ? note : `${base}\n\n${note}`;
  }

  if (cfg.injectChannel === "section") {
    ctx.systemPrompt.section({
      name: PERSONA_SECTION,
      order: PERSONA_ORDER,
      interpolate: false,
      text: () => {
        try {
          // 人设/称呼只受总开关管（设定不是记忆，总开关开着就生效）。
          const on = readSettings(storageRoot, log).conversationMemory;
          debugProbe(`开关求值 ${PERSONA_SECTION}: conversationMemory=${on}`);
          if (!on) return "";
          return personaTextFor();
        } catch (error) {
          log.error("人设段渲染失败", error);
          return "";
        }
      },
    });

    ctx.systemPrompt.section({
      name: RUNTIME_USER_SECTION,
      order: RUNTIME_USER_ORDER,
      interpolate: false,
      text: (context) => {
        try {
          // 开关口径与消息通道完全一致（§10.1）：总开关 + runtimeEnabled + projectMemory
          // （runtimeUser 可能含项目 user 条目，projectMemory 关则不注——保守口径）。
          const gate = readSettings(storageRoot, log);
          const on = gate.conversationMemory && gate.runtimeEnabled && gate.projectMemory;
          debugProbe(`开关求值 ${RUNTIME_USER_SECTION}: conversationMemory=${gate.conversationMemory} runtimeEnabled=${gate.runtimeEnabled} projectMemory=${gate.projectMemory}`);
          if (!on) return "";
          return runtimeTextFor(runtimeScopeFor(context)).user;
        } catch (error) {
          log.error("运行时 USER 段渲染失败", error);
          return "";
        }
      },
    });

    ctx.systemPrompt.section({
      name: RUNTIME_MEMORY_SECTION,
      order: RUNTIME_MEMORY_ORDER,
      interpolate: false,
      text: (context) => {
        try {
          const gate = readSettings(storageRoot, log);
          const on = gate.conversationMemory && gate.runtimeEnabled && gate.projectMemory;
          debugProbe(`开关求值 ${RUNTIME_MEMORY_SECTION}: conversationMemory=${gate.conversationMemory} runtimeEnabled=${gate.runtimeEnabled} projectMemory=${gate.projectMemory}`);
          if (!on) return "";
          return runtimeTextFor(runtimeScopeFor(context)).memory;
        } catch (error) {
          log.error("运行时 MEMORY 段渲染失败", error);
          return "";
        }
      },
    });

    ctx.systemPrompt.section({
      name: GLOBAL_INDEX_SECTION,
      order: GLOBAL_INDEX_ORDER,
      interpolate: false,
      text: (context) => {
        try {
          // 全局段注入跟随数据非空（不受 globalExtraction 开关管——开关只管提取）。
          // runtimeCoveredCategories：开关开 + projectMemory 开 + 该 scope 产物可用 → 产物完整承载的分类
          // 才交给 runtime 段（有淘汰条目的分类仍走索引，绝不整类抹掉）。
          const gate = readSettings(storageRoot, log);
          const on = gate.conversationMemory;
          const runtimeOn = on && gate.runtimeEnabled && gate.projectMemory;
          const coveredCategories = runtimeOn ? runtimeTextFor(runtimeScopeFor(context)).coveredCategories : [];
          debugProbe(`开关求值 ${GLOBAL_INDEX_SECTION}: conversationMemory=${on} runtimeCovered=${coveredCategories.join(",") || "-"}`);
          if (!on) return "";
          return globalIndexTextFor({ runtimeCoveredCategories: coveredCategories });
        } catch (error) {
          log.error("全局索引段渲染失败", error);
          return "";
        }
      },
    });

    ctx.systemPrompt.section({
      name: INSTRUCTIONS_SECTION,
      order: SECTION_ORDER,
      interpolate: false,
      text: (context) => {
        try {
          // 注入条件：总开关 + 项目记忆开关。
          const gate = readSettings(storageRoot, log);
          const on = gate.conversationMemory && gate.projectMemory;
          debugProbe(`开关求值 ${INSTRUCTIONS_SECTION}: conversationMemory=${gate.conversationMemory} projectMemory=${gate.projectMemory}`);
          if (!on) return "";
          const memoryDir = memoryDirFor(context);
          // runtime 降级/只读告警行挂在 usage 段（§十一）；usage 本体无 cwd 时不单出说明，
          // 但告警行照出（可见降级不因目录缺失而消失）。
          // 判据与 runtime 两段严格同口径（runtimeEnabled && projectMemory）：
          // 少了 projectMemory 会在「关了项目记忆」时仍每轮触发 ensureCompiled（算指纹 + 可能写盘），
          // 而产物永不被注入——纯无谓写盘，且与本段上方 `on` 的语义自相矛盾。
          let note = "";
          if (gate.runtimeEnabled && gate.projectMemory) note = runtimeTextFor(runtimeScopeFor(context)).note;
          const text = usageTextWithNote(memoryDir, note);
          return text;
        } catch (error) {
          log.error("使用说明段渲染失败", error);
          return "";
        }
      },
    });

    ctx.systemPrompt.section({
      name: INDEX_SECTION,
      order: SECTION_ORDER + 1,
      interpolate: false,
      text: (context) => {
        try {
          const gate = readSettings(storageRoot, log);
          const on = gate.conversationMemory && gate.projectMemory;
          debugProbe(`开关求值 ${INDEX_SECTION}: conversationMemory=${gate.conversationMemory} projectMemory=${gate.projectMemory}`);
          if (!on) return "";
          const memoryDir = memoryDirFor(context);
          const scope = runtimeScopeFor(context);
          const projectId = scope.startsWith("projects/") ? scope.slice("projects/".length) : "";
          // 项目条目去重（§10.3 项目侧）：已进产物的条目不再在索引里重复出现一遍。
          const coveredFiles = gate.runtimeEnabled ? runtimeTextFor(scope).coveredProjectFiles : [];
          const pages = projectId.length > 0 ? pagesSummaryTexts(storageRoot, projectId).full : "";
          const index = memoryDir === void 0 ? "" : indexTextFor(memoryDir, coveredFiles);
          return [pages, index].filter((text) => text.length > 0).join("\n\n");
        } catch (error) {
          log.error("索引段渲染失败", error);
          return "";
        }
      },
    });
  } else {
    // 消息通道为主（默认），section 侧只留一条静态路由指引兜底
    //（standard 下第二层保险；minimal 下被 complete 吃掉也无碍——消息通道已覆盖）。
    ctx.systemPrompt.section({
      name: ROUTING_SECTION,
      order: SECTION_ORDER,
      interpolate: false,
      text: (context) => {
        try {
          debugProbe(`开关求值 ${ROUTING_SECTION}`);
          return routingTextFor(context);
        } catch (error) {
          log.error("路由段渲染失败", error);
          return "";
        }
      },
    });
  }

  /** 路由兜底段文本：记忆走消息通道，这里只留一条指针。 */
  function routingTextFor(context) {
    const gate = readSettings(storageRoot, log);
    if (!gate.conversationMemory) return "";
    const lines = [
      "## Persistent memory (dsh-keepsake)",
      "",
      "Relevant memory is delivered in this conversation by the dsh-keepsake plugin; Read the files it points to when needed.",
      `Global memory root: ${globalRoot(storageRoot)}.`,
    ];
    // 项目目录行随 projectMemory 开关（与 messages 模式 desiredMemoryContext 同口径——关掉项目记忆就不指路）
    const memoryDir = gate.projectMemory ? memoryDirFor(context) : void 0;
    if (memoryDir !== void 0) lines.push(`Project memory directory: ${memoryDir} (MEMORY.md is the index).`);
    return lines.join("\n");
  }

  // ---- 消息通道注入（agent/pre-step）----
  /** 逐段渲染容错：失败记注入异常指标 + 日志并返回空串（显式可见降级，绝不静默丢）。 */
  function safeSegment(label, fn) {
    try {
      return String(fn() ?? "");
    } catch (error) {
      recordInjectionError();
      log.error(`消息通道${label}渲染失败`, error);
      return "";
    }
  }

  /**
   * 按开关求值六段文本并做预算裁剪；全空返回 null（不注入）。
   * maxChars/maxTokens 由调用方给（须为召回块让位）；maxTokens=0 = 禁用 token 预算（字符口径）。
   * 返回 { text, dropped, tokens? }——tokens 由 buildMemoryContext 给（旧实现无则调用侧回落估算）。
   *
   * runtime 两段（RUNTIME-FORMAT §10.1/§10.4）：
   *   - 开关口径：`runtimeEnabled && conversationMemory && projectMemory`——
   *     projectMemory 关则两段都不注（runtimeMemory 含项目条目、runtimeUser 可能含项目 user 条目，
   *     保守口径防项目内容经 runtime 绕过开关）。
   *   - 产物可用（status=ok）：runtimeUser/runtimeMemory 取产物文本；globalIndex 三分类去重。
   *   - 产物缺失/error：两段为空 + usage 记 `[runtime degraded: <reason>]`，globalIndex 回退全渲染。
   */
  function desiredMemoryContext(agent, maxChars = cfg.injectMaxChars, maxTokens = cfg.injectMaxTokens) {
    if (maxChars <= 0) return null; // 预算被召回块吃光：不注入只剩包裹/提示的空壳块
    const gate = readSettings(storageRoot, log);
    const segments = { persona: "", runtimeUser: "", runtimeMemory: "", globalIndex: "", usage: "", projectIndex: "" };
    // 紧凑索引兜底：只对索引段生效；buildMemoryContext 在整段放不下时先换它，装不下才丢。
    const fallbacks = {};
    if (gate.conversationMemory) {
      segments.persona = safeSegment("人设段", () => personaTextFor());
      const scope = runtimeScopeFor({ agent });
      const projectId = scope.startsWith("projects/") ? scope.slice("projects/".length) : "";
      const runtimeOn = gate.runtimeEnabled && gate.projectMemory;
      // runtime 求值返回结构化对象（两段文本 + coveredCategories + note），不能走 safeSegment
      // （它会把返回值 String() 化）；这里单独兜错，失败按「两段为空 + 降级告警」处理。
      let runtime = { user: "", memory: "", coveredCategories: [], coveredProjectFiles: [], note: "" };
      if (runtimeOn) {
        try {
          runtime = runtimeTextFor(scope);
        } catch (error) {
          recordInjectionError();
          log.error("消息通道 runtime 段渲染失败", error);
          runtime = { user: "", memory: "", coveredCategories: [], coveredProjectFiles: [], note: "[runtime degraded: compile error]" };
        }
        segments.runtimeUser = runtime.user;
        segments.runtimeMemory = runtime.memory;
      }
      segments.globalIndex = safeSegment("全局索引段", () => globalIndexTextFor({ runtimeCoveredCategories: runtime.coveredCategories }));
      if (segments.globalIndex) {
        // 惰性：紧凑版要重读全局索引，只有 full 真的超预算时才算。
        fallbacks.globalIndex = () => safeSegment("全局紧凑索引段", () => compactGlobalIndexTextFor({ runtimeCoveredCategories: runtime.coveredCategories }));
      }
      if (gate.projectMemory) {
        const memoryDir = memoryDirFor({ agent });
        segments.usage = safeSegment("使用说明段", () => usageTextWithNote(memoryDir, runtime.note));
        // 知识页摘要 + 项目索引同一段：页面是派生视图，排在索引前面（先给地图，再给索引）。
        // 项目条目去重（§10.3 项目侧）：已进产物的条目不再在索引里重复出现一遍。
        if (memoryDir !== void 0 || projectId.length > 0) {
          try {
            const projectTexts = memoryDir !== void 0
              ? indexTextsFor(memoryDir, runtime.coveredProjectFiles)
              : { full: "", compact: "" };
            const pagesTexts = projectId.length > 0
              ? pagesSummaryTexts(storageRoot, projectId)
              : { full: "", compact: "" };
            segments.projectIndex = [pagesTexts.full, projectTexts.full].filter((text) => text.length > 0).join("\n\n");
            const compactParts = [pagesTexts.compact, projectTexts.compact].filter((text) => text.length > 0);
            if (compactParts.length > 0) fallbacks.projectIndex = compactParts.join("\n\n");
          } catch (error) {
            recordInjectionError();
            log.error("消息通道索引段渲染失败", error);
          }
        }
      } else if (runtime.note !== "") {
        segments.usage = safeSegment("使用说明段", () => runtime.note); // 无项目目录也要让降级告警可见
      }
    }
    if (!segments.persona && !segments.runtimeUser && !segments.runtimeMemory
      && !segments.globalIndex && !segments.usage && !segments.projectIndex) return null;
    // supersedeNote：同源替换的声明行——宿主历史 append-only，视野里可能已躺着更早的
    // 同类块，块首这句声明让模型只认最后一块（与 MEMORY_CONTEXT_INTRO 同处块首）。
    // maxTokens：token 预算（0=不限，退字符口径）。inject-channel 侧两个上限同时生效；
    // 返回 tokens=costOf(text)（estimateTokens 口径），调用侧记账用（旧实现无该字段则回落估算）。
    //
    // 预算口径纪律（RUNTIME-FORMAT §七）：预算耗尽必须体现为 maxChars<=0（上面的早退，决定不注入）；
    // 禁止只把 maxTokens 传 0——inject-channel 把 0 解释为「不限」，等于静默关闭 token 预算。
    const { text, dropped, compacted, tokens } = buildMemoryContext(segments, {
      maxChars,
      maxTokens,
      intro: MEMORY_CONTEXT_INTRO,
      supersedeNote: MEMORY_CONTEXT_SUPERSEDE_NOTE,
      fallbacks,
    });
    return text === "" ? null : {
      text,
      dropped,
      compacted,
      tokens: typeof tokens === "number" ? tokens : estimateTokens(text),
    };
  }

  /** 扫会话 surface 找我方指定 form 的**全部**注入文本块（按出现顺序）。 */
  function visibleInjectionTexts(agent, form) {
    const surface = agent?.session?.surface;
    if (surface === void 0 || !Array.isArray(surface.nodes)) return [];
    const found = [];
    for (const seq of surface.nodes) {
      let event;
      try {
        event = agent.session.eventAt(seq);
      } catch {
        continue;
      }
      if (event?.type !== "user/message") continue;
      const message = messageOf(event);
      if (message === void 0) continue;
      if (message.source?.kind !== INJECT_SOURCE_KIND || message.source?.form !== form) continue;
      found.push(textBlocksOf(message));
    }
    return found;
  }

  /** 视野内我方指定 form 的**最后一条**注入文本（主块去重/补发判定；无则 undefined）。 */
  function visibleInjectionText(agent, form) {
    const all = visibleInjectionTexts(agent, form);
    return all.length > 0 ? all[all.length - 1] : void 0;
  }

  /** 构造一条 producer-owned durable user 消息（普通对象，零依赖——对齐 mnemon 形态）。form 区分主块/召回块。 */
  function makeInjectionMessage(text, form) {
    return {
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: INJECT_SOURCE_KIND, form, digest: digestOf(text) },
    };
  }

  /** 本步批里最近一条真人 user 消息的文本（召回查询用）。机器来源——任意插件的注入、
   *  instruction/summary 等——不当查询语料（与提取侧同一判据 isMachineOrigin，防机器话污染查询）。 */
  function latestUserProse(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== "user" || isMachineOrigin(message)) continue;
      const text = textBlocksOf(message);
      if (text.length > 0) return text;
    }
    return "";
  }

  /**
   * 收集记忆条目（全局五类 + 项目）为 {id,text} 列表，供嵌入与召回；条目数封顶（防超大库每轮全读）。
   *
   * 范围均衡取名额：
   *   - 全局/项目各占一半候选名额（双向让位：本侧未用满的余量给另一侧，1:1100 与 1100:1
   *     两个方向都取满，总量 ≤ RECALL_MAX_ITEMS）——此前只做单向让位，project 不足时
   *     global 恒被压在 globalBudget 之下（global 侧白丢名额）；
   *   - 两侧候选收集后按稳定序排序（mtime 降序、同 mtime 用 id 升序兜底），再按名额截取——
   *     project 侧候选原为目录遍历序（readdir 顺序不确定），超限取舍必须确定，否则同输入
   *     两次运行选集不同。
   * 关掉 projectMemory 时不收集项目记忆（与该开关的其它注入/提取口径一致）。
   * gate 取当前 settings：projectMemory=false 即不做项目范围召回。
   */
  function collectRecallItems(agent, gate) {
    const globalBudget = Math.floor(RECALL_MAX_ITEMS / 2);
    const projectBudget = RECALL_MAX_ITEMS - globalBudget;
    // 稳定序：mtime 降序（保最新），同 mtime 用 id 升序（同输入两次运行选集相同）。
    const byStableOrder = (a, b) => (b.mtimeMs - a.mtimeMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const collect = (id, title, description, content, mtimeMs, bucket) => {
      const text = `${title}\n${description}\n${content}`.trim();
      if (text.length > 0) bucket.push({ id, text: text.slice(0, 2000), mtimeMs }); // 单条嵌入口径封顶，防超长条目
    };
    const globalAll = [];
    for (const categoryId of CATEGORY_IDS) {
      for (const entry of listEntries(storageRoot, categoryId)) { // listEntries 按 mtime 降序（本类内）
        collect(`global:${categoryId}/${entry.name}`, entry.title, entry.description, entry.content, entry.mtimeMs ?? 0, globalAll);
      }
    }
    globalAll.sort(byStableOrder); // 跨分类合并后重排：全集按稳定序（截取口径确定）
    const projectAll = [];
    if (gate?.projectMemory !== false) { // 关掉项目记忆 = 不收集项目条目（零项目范围召回）
      const memoryDir = memoryDirFor({ agent });
      if (memoryDir !== void 0) {
        for (const full of listMemoryFiles(memoryDir)) {
          let raw;
          let mtimeMs = 0;
          try {
            raw = readFileSync(full, "utf8");
            mtimeMs = statSync(full).mtimeMs;
          } catch {
            continue; // 竞态消失/读失败：跳过（不炸收集）
          }
          const front = parseFrontmatterHead(raw);
          const rel = full.slice(memoryDir.length + 1).replace(/\\/g, "/");
          collect(`project:${rel}`, front.title ?? front.name ?? rel, front.description ?? "", stripFrontmatter(raw), mtimeMs, projectAll);
        }
      }
    }
    projectAll.sort(byStableOrder); // readdir 遍历序不确定 → 显式排序后才截取
    let globalKept = globalAll.slice(0, globalBudget);
    let projectKept = projectAll.slice(0, projectBudget);
    // 双向让位：本侧未用满的余量给另一侧（另一侧超限时）。两次扩展互相独立
    // （一侧有余量即该侧未超限），总量由末尾封顶兜住 ≤ RECALL_MAX_ITEMS。
    const globalRoomLeft = globalBudget - globalKept.length;
    const projectRoomLeft = projectBudget - projectKept.length;
    if (projectRoomLeft > 0 && globalAll.length > globalKept.length) {
      globalKept = globalAll.slice(0, Math.min(RECALL_MAX_ITEMS, globalBudget + projectRoomLeft));
    }
    if (globalRoomLeft > 0 && projectAll.length > projectKept.length) {
      projectKept = projectAll.slice(0, Math.min(RECALL_MAX_ITEMS, projectBudget + globalRoomLeft));
    }
    if (globalKept.length + projectKept.length > RECALL_MAX_ITEMS) {
      projectKept = projectKept.slice(0, Math.max(0, RECALL_MAX_ITEMS - globalKept.length));
    }
    const items = [...globalKept, ...projectKept].map((it) => ({ id: it.id, text: it.text })); // 剥离内部排序用的 mtimeMs
    const truncated = (globalAll.length - globalKept.length) + (projectAll.length - projectKept.length);
    if (truncated > 0) {
      log.warn(`召回候选超上限已截断：全局 ${globalKept.length}/${globalAll.length}、项目 ${projectKept.length}/${projectAll.length}（共截 ${truncated} 条，上限 ${RECALL_MAX_ITEMS}）`);
    }
    return items;
  }

  /** 召回块文本（`<memory-recall>` 包裹；stripMemoryMarkup 已含此标签的剥除口径）。 */
  function buildRecallBlock(hits) {
    const lines = [
      "<memory-recall>",
      "Possibly relevant memories for the current request (semantic match; may be off-topic):",
      "",
    ];
    for (const hit of hits) lines.push(`- ${String(hit.text).replace(/\s+/g, " ").trim()}`);
    lines.push("</memory-recall>");
    return lines.join("\n");
  }

  /**
   * 计算本轮召回块文本（嵌入语义检索；不落消息，注入与否与预算由调用方决定）。
   * 查询取本步批最近用户散文；条目向量落 <storageRoot>/embeddings.json 增量缓存（仅新/改条目重嵌）。
   * 整体受 recallTotalBudgetMs 约束（分批串行请求，逐批增量落盘，防单轮卡满 N×单请求超时）；
   * 硬失败向上抛（由调用方熔断计数），无命中/超预算则返回空块（不抛）。
   * @returns { text, hits } text==="" 表示本轮不召回。
   */
  async function computeRecallBlock(payload, agent, messages, emb, gate) {
    if (emb.baseUrl === "" || emb.model === "") return { text: "", hits: 0 }; // 端点/模型未齐（配置面已 fail-loud，这里是运行期守卫）
    const query = latestUserProse(messages);
    if (query === "") return { text: "", hits: 0 };
    const items = collectRecallItems(agent, gate);
    if (items.length === 0) return { text: "", hits: 0 };
    // 宿主 pre-step 的 signal 是 AbortSignal；非信号对象（如测试桩）不传，避免 embedTexts 调 addEventListener 抛错。
    const externalSignal = typeof payload?.signal?.addEventListener === "function" ? payload.signal : void 0;
    const baseOpts = { baseUrl: emb.baseUrl, model: emb.model, apiKey: emb.apiKey || void 0, signal: externalSignal };
    // 缓存键 = 端点 + 模型：换端点或换模型都整库重嵌（防同模型不同端点复用错向量 → 静默错召回/全 miss）。
    const cacheKey = `${emb.baseUrl}\u0000${emb.model}`;
    let cache = loadEmbeddingCache(storageRoot);
    const stale = staleItems(cache, items, cacheKey);
    const ids = new Set(items.map((it) => it.id));
    // 只读保护下不落盘：缓存格式可能随版本变化，不覆盖更新版插件的缓存。写失败显式告警（缓存可再生，不中断本轮）。
    const persist = (value) => {
      if (formatState.ok && !saveEmbeddingCache(storageRoot, value)) log.warn("召回向量缓存写盘失败（本轮照常召回，下轮将重嵌）");
    };
    // 整体时间预算：单请求超时 recallTimeoutMs 不足以约束"分批串行"的整轮耗时（最坏 N 批 × 单超时）。
    const deadline = Date.now() + cfg.recallTotalBudgetMs;
    let bounded = false;
    for (let i = 0; i < stale.length; i += EMBED_BATCH_SIZE) { // 分片嵌入（防超出端点 batch/体积上限）
      const remaining = deadline - Date.now();
      if (remaining <= 0) { bounded = true; break; }
      const chunk = stale.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await embedTexts({ ...baseOpts, timeoutMs: Math.min(emb.timeoutMs, remaining), texts: chunk.map((it) => it.text) });
      cache = applyEmbeddings(cache, cacheKey, chunk.map((it, j) => ({ id: it.id, text: it.text, vec: vectors[j] })));
      persist(cache); // 逐批增量落盘：后续批失败也不丢已嵌向量（下轮续跑，不再整轮前功尽弃）
    }
    if (bounded) log.warn(`召回嵌入超出总预算 ${Math.round(cfg.recallTotalBudgetMs / 1000)}s，本轮按已缓存部分召回（下次续跑）`);
    const pruned = pruneCache(cache, ids);
    if (Object.keys(pruned.items).length !== Object.keys(cache.items).length) persist(pruned);
    cache = pruned;
    const withVec = items
      .map((it) => ({ id: it.id, text: it.text, vec: cache.items[it.id]?.vec }))
      .filter((it) => Array.isArray(it.vec));
    if (withVec.length === 0) {
      recordRecallMiss();
      return { text: "", hits: 0 };
    }
    const [queryVec] = await embedTexts({ ...baseOpts, timeoutMs: Math.min(emb.timeoutMs, Math.max(1, deadline - Date.now())), texts: [query] });
    // 维度不一致（同名换模型/换维度）会让余弦恒 0 → 静默全 miss；显式告警。
    const dims = new Set(withVec.map((it) => it.vec.length));
    if (queryVec !== void 0 && (dims.size > 1 || !dims.has(queryVec.length))) {
      log.warn(`嵌入维度不一致（条目 ${[...dims].join("/")} vs 查询 ${queryVec.length}），召回恒不命中；请检查嵌入模型是否变更`);
    }
    const hits = selectRecall(withVec, queryVec, { topK: emb.topK, minScore: emb.minScore, maxTokens: cfg.recallMaxTokens });
    if (hits.length === 0) {
      recordRecallMiss();
      return { text: "", hits: 0 };
    }
    return { text: buildRecallBlock(hits), hits: hits.length };
  }

  /**
   * 注入决策（pre-step 后处理）：每轮首步求值一次——先算召回块（计入注入总预算），再六段渲染 →
   * 预算裁剪（总预算扣除召回块）→ 视野去重 → 主块与召回块依次追加进本步消息批。
   * 任何异常在订阅侧兜底，不让宿主轮次受影响。
   */
  async function applyMemoryInjection(payload, decision) {
    if (decision === void 0 || decision.kind !== "enter") return decision;
    if (payload?.signal?.aborted === true) return decision;
    if (payload.step !== 1) return decision; // 每轮只在第一步求值（与 mnemon 同构）
    const messages = Array.isArray(decision.messages) ? decision.messages : [];
    if (messages.length === 0) return decision; // 无用户输入步：不注入
    if (messages.some((message) => message?.source?.kind === INJECT_SOURCE_KIND)) return decision; // 本步批内已含我方注入（精确判据：勿被他人 kind:"plugin" 误判而漏注入）
    const agent = payload.agent;
    if (agent === void 0) return decision;
    if (agent.session?.header?.origin === "subagent") return decision; // subagent 会话不注入（对齐 hindsight/openviking）

    // 召回块先算：它是注入总预算（injectMaxChars）的一部分，主块须为它让位。
    let recallText = "";
    let recallHits = 0;
    // 生效嵌入配置 = 面板设置（settings.json，每轮读取、免重启）优先于 entry config。
    const gate = readSettings(storageRoot, log);
    const emb = effectiveEmbedding(cfg, gate);
    // 召回与主块同受总开关管：conversationMemory 关 = 零注入 + 零嵌入调用（此前召回只认
    // emb.enabled，总开关关掉仍照跑嵌入调用并注入召回块，与"关掉对话记忆"的用户心智相悖）。
    if (gate.conversationMemory && emb.enabled) {
      if (Date.now() < recallCooldownUntil) {
        // 熔断中：坏端点不再每轮阻塞满一个 recallTimeoutMs（不记 miss——不是"无命中"）。
      } else {
        try {
          const recall = await computeRecallBlock(payload, agent, messages, emb, gate);
          recallText = recall.text;
          recallHits = recall.hits;
          recallFailureStreak = 0;
        } catch (error) {
          recordRecallError();
          recallFailureStreak += 1;
          if (recallFailureStreak >= RECALL_FAILURE_LIMIT) {
            recallCooldownUntil = Date.now() + RECALL_COOLDOWN_MS;
            log.warn(`召回连续失败 ${recallFailureStreak} 次，熔断 ${Math.round(RECALL_COOLDOWN_MS / 1000)}s（期间跳过召回）`);
          }
          log.warn("召回块注入失败（降级为本轮不召回）", error); // 规则3：显式降级，不炸轮次、不静默
        }
      }
    }

    // 主块预算 = 总预算 − 召回块（含块间空行），保证两段合计不超 injectMaxChars；
    // token 口径同理（双口径）：injectMaxTokens=0 时 mainTokens=0（不限）。
    const mainBudget = Math.max(0, cfg.injectMaxChars - (recallText.length > 0 ? recallText.length + 2 : 0));
    const mainTokens = cfg.injectMaxTokens > 0
      ? Math.max(0, cfg.injectMaxTokens - (recallText.length > 0 ? estimateTokens(recallText) + estimateTokens("\n\n") : 0))
      : 0;
    let working = decision;
    const built = desiredMemoryContext(agent, mainBudget, mainTokens);
    if (built !== null) {
      // 同源替换判定：不再只问「与视野里最后一块是否一字不差」，而是让
      // inject-channel.shouldReinject 做三态裁决——视野丢失必补发、规范化相同不重发、
      // 变化太小（节流）也先攒着不发。视野不可见（prior===undefined）或从未注入过
      // （prior 为空串）时交给它按 first/resend 处理，接线层不重复判一遍。
      const prior = visibleInjectionText(agent, MEMORY_CONTEXT_FORM);
      const injectState = injectStates.get(agent) ?? { injectedOnce: false, lastInjectedText: "" };
      // lastInjectedText 优先取本会话自记的上一块（跨压缩仍记得"发过什么"），回落视野里
      // 那一块——「视野在不在」与「发过什么」分开记，resend（旧块被挤出视野后必补发）才判得出。
      const lastInjectedText = injectState.lastInjectedText || prior || "";
      const verdict = shouldReinject({ visible: prior !== void 0, lastInjectedText, nextText: built.text });
      // 增量计数：throttled 记"想发而没发"、superseded 记"发了即作废旧块"（首发不计）。
      // 上一版累计值直接取 metrics 快照（单一事实源，不再自存一份进程计数）；
      // 两个新计数与 verdict 同源推导，不会与 inject 决定各说各话。
      const injectPrev = injectionSnapshot();
      const delta = summarizeInjectionDelta(
        { superseded: injectPrev.superseded, throttled: injectPrev.throttled, prior: injectState.injectedOnce },
        { sent: verdict.inject, throttled: verdict.reason === "throttled" },
      );
      if (verdict.reason === "throttled") recordInjectionThrottled();
      else if (verdict.inject && delta.superseded > injectPrev.superseded) recordInjectionSuperseded();
      if (verdict.inject) {
        // tokens：优先用 buildMemoryContext 给的真实口径，缺失回落 estimateTokens。
        recordInjection({ chars: built.text.length, dropped: built.dropped, compacted: built.compacted, resend: prior !== void 0, tokens: built.tokens ?? estimateTokens(built.text) });
        // 本会话从此有旧块（下一轮的新块才具"可取代"语义）；并记块全文供 resend 判定
        injectStates.set(agent, { injectedOnce: true, lastInjectedText: built.text });
        working = { ...working, messages: [...messages, makeInjectionMessage(built.text, MEMORY_CONTEXT_FORM)] };
      }
    }
    if (recallText.length > 0) {
      // 去重比对视野内**全部**召回块（只比最后一条时，命中集每轮变化会逐轮新增、无限累积）。
      // 召回块是命中集去重，与主块的"同源替换"是两回事——不走 shouldReinject，保持原样。
      const priors = visibleInjectionTexts(agent, MEMORY_RECALL_FORM);
      if (!priors.some((p) => sameInjectionText(p, recallText))) {
        recordRecall({ items: recallHits, chars: recallText.length });
        working = { ...working, messages: [...working.messages, makeInjectionMessage(recallText, MEMORY_RECALL_FORM)] };
      }
    }
    return working;
  }

  if (cfg.injectChannel === "message") {
    ctx.on(
      "agent/pre-step",
      async (payload, next) => {
        const decision = await next();
        try {
          return await applyMemoryInjection(payload, decision);
        } catch (error) {
          // 规则3：注入异常显式记录 + 计入观测面，绝不炸宿主轮次
          recordInjectionError();
          log.error("消息通道注入异常", error);
          return decision;
        }
      },
      { prepend: true },
    );
  }

  function invalidateIndexCache() {
    indexCache = { key: "", text: null, compact: null };
  }

  /**
   * 写盘后失效 runtime 缓存（RUNTIME-FORMAT §八：写盘/删除 → 受影响 scope 失效）。
   * 判据走 applyScopedOps 的 byScope：项目条目操作 → 只失效该 scope；
   * 任一全局分类有落盘 → scope=null（全失效，全局条目进每个 scope 的产物）。
   * 只有真的写/删成功才失效（skipped/failed 不碰缓存：产物仍与盘上一致）。
   * 失效本身失败只 warn——下一次 ensureCompiled 的 sourceHash 比对仍会兜住（懒编译自愈）。
   * @param {{byScope?: object, writes?: number, deletes?: number}} result applyScopedOps 结算
   * @param {{slug: string, hash: string}} paths 本次提取的项目记忆路径（scope 判定同源）
   */
  function invalidateRuntimeAfterWrite(result, paths) {
    const byScope = result?.byScope ?? {};
    const touched = (bucket) => bucket !== void 0 && ((bucket.writes ?? 0) > 0 || (bucket.deletes ?? 0) > 0);
    const globalTouched = Object.keys(byScope).some((key) => key.startsWith("global:") && touched(byScope[key]));
    const projectTouched = touched(byScope.project)
      || (byScope.project === void 0 && (result?.writes ?? 0) + (result?.deletes ?? 0) > 0);
    if (!globalTouched && !projectTouched) return;
    runtimeMemo.clear(); // 本批有落盘：记忆化的产物文本立即作废（不等 TTL）
    try {
      if (globalTouched) {
        invalidateRuntimeCache(storageRoot, null); // 全局条目影响所有 scope 的产物
        return;
      }
      invalidateRuntimeCache(storageRoot, `projects/${paths.slug}-${paths.hash}`);
    } catch (error) {
      log.warn("runtime 缓存失效失败（下一次注入的 sourceHash 比对会自愈重编）", error);
    }
  }
}

export { apply, inject, name };

// dsh-memory — 项目记忆自动提取+注入 cordis 插件入口。
// 订阅面（0.2.0 实测）：ctx.on("session/event", (session, event) => ...)；
//   成功轮结束 = event.type === "turn/end" 且 data.reason.kind === "completed"；
//   主请求路由捕获 = "request/header" 的 data.header.config.{provider,model}。
// 注入面（0.2.0 实测）：ctx.systemPrompt.section({name, order, text: fn, interpolate: false})。
// 提取面（0.2.0 实测）：ctx.llm.stream({provider, model, system, messages, maxTokens,
//   sessionId, purpose, signal})，块 {type:'text-delta', text}，终块 {type:'finish', reason}。
//
// 6 条边界落点（T2 规格）：
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
// 方案C M1 扩展（v0.2 全局记忆）：
//   四段注入：4990 人设（称呼指令+正文，R5 补充设定）/ 4995 全局索引（四分类+长期，
//   每类 40 行小预算总 120 行封顶）/ 5000 项目使用说明 / 5001 项目索引（v0.1.0 原样）。
//   开关语义（§4+R2/R3/R10 组合推定，M1 备份）：
//     conversationMemory 总开关：关 = 四段全灭 + 提取全停（cursor 推进不积累）；
//     projectMemory：关 = 5000/5001 灭 + project ops 过滤计数；
//     globalExtraction：关 = global:* ops 过滤计数（R10）；全局段注入跟随数据非空（R2）。
//   API/面板：lib/api.js（REST 全套）+ lib/panel.js（面板供给）经 webServer 挂载。
//   滚动清理：recent-activity 启动时 + 每次全局写入后（onGlobalWrite 收口）。
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { INDEX_FILENAME } from "./filename.js";
import { applyScopedOps, buildExtractionPayload, parseExtractionOutput } from "./extract.js";
import { buildManifestText, truncateWithWarning } from "./manifest.js";
import { projectMemoryPaths } from "./paths.js";
import { createScheduler } from "./state.js";
import { clipTail, messageOf, renderTranscript, skipReason, textBlocksOf } from "./transcript.js";
import {
  buildMemoryContext,
  digestOf,
  INJECT_SOURCE_KIND,
  MEMORY_CONTEXT_FORM,
  MEMORY_CONTEXT_INTRO,
  isPluginSourcedMessage,
  sameInjectionText,
} from "./inject-channel.js";
import { readSettings } from "./settings.js";
import { makeApiRoutes } from "./api.js";
import { makePanelRoutes } from "./panel.js";
import {
  bumpExtractionFailure,
  bumpRetryAttempt,
  bumpFallbackUsed,
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
  readPersona,
  sweepTmpOrphans,
} from "./global-store.js";

const name = "dsh-memory";
const inject = ["llm", "systemPrompt", "webServer"];

const PERSONA_SECTION = "dsh-memory:persona"; // 4990
const GLOBAL_INDEX_SECTION = "dsh-memory:global-index"; // 4995
const INSTRUCTIONS_SECTION = "dsh-memory:instructions"; // 5000
const INDEX_SECTION = "dsh-memory:index"; // 5001
const ROUTING_SECTION = "dsh-memory:routing"; // 批次A：消息通道模式下的静态路由兜底段（standard 兜底）
const PERSONA_ORDER = 4990;
const GLOBAL_INDEX_ORDER = 4995;
const SECTION_ORDER = 5000; // 外部段可任取有限 order；置于 first-party 指引之后、后缀之前
const MAX_TIMER_DELAY_MS = 2147483647;
const USAGE_HEADER = "## Persistent project memory";
// 全局索引预算（方案C §4：每类 40 行小预算，总 120 行封顶）
const GLOBAL_CATEGORY_BUDGET_LINES = 40;
const GLOBAL_INDEX_TOTAL_LINES = 120;
const GLOBAL_INDEX_TOTAL_CHARS = 12000;

/** 段求值探针日志：仅 DSH_MEMORY_DEBUG=1 时输出（P3 验证口，平时零噪音）。 */
function debugProbe(message) {
  if (process.env.DSH_MEMORY_DEBUG === "1") {
    console.error(`[dsh-memory][probe] ${message}`);
  }
}

/** 配置解析：非法即抛（fail loud），未知键即抛（config 无 schema，靠严格性兜底）。 */

/** 换道路由条数上限（批F1 E-5：>3 条说明配置写错了，fail loud）。 */
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

/** 批次A：注入通道取值校验（缺省 message；非法值即抛，带允许值提示——fail loud）。 */
function injectionChannel(value) {
  if (value === void 0 || value === null) return "message";
  if (value === "message" || value === "section") return value;
  throw new Error(`dsh-memory: injectChannel must be "message" or "section" (got ${JSON.stringify(value)})`);
}

export function resolveConfig(raw) {
  const value = raw !== void 0 && raw !== null && typeof raw === "object" ? raw : {};
  const KNOWN = new Set([
    "enabled", "storageRoot", "provider", "model", "minUserWords", "timeoutMs", "maxOutputTokens",
    "maxIndexLines", "maxIndexChars", "maxManifestFiles", "maxPromptChars", "maxOps",
    "recentKeepCount", "recentKeepDays",
    // 批F1 E-3 退避参数（默认 3 attempt / 500ms / 2000ms，指数+jitter±20%）
    "retryAttempts", "retryBackoffMs", "retryMaxDelayMs",
    // 批F1 E-5 换道路由（默认 [] = 纯重试不换道；换道调用逻辑属下一批，本批只校验+持有）
    "fallback",
    // 批F2 U7 嵌入模型（语义召回预留位）：成对可选，配了只展示不生效——
    // 向量召回管线尚未存在，此键是「留位+可观测」，防止 UI 无真值可显（审查 V-2 同款诚实口径）
    "embeddingProvider", "embeddingModel",
    // 批次A 注入通道：injectChannel（message|section，默认 message）；injectMaxChars（消息通道注入总预算字符）
    "injectChannel", "injectMaxChars",
  ]);
  for (const key of Object.keys(value)) {
    if (!KNOWN.has(key)) {
      const suggestion = nearestKnownKey(key, KNOWN);
      throw new Error(`dsh-memory: unknown config key "${key}"${suggestion !== null ? ` (did you mean "${suggestion}"?)` : ""}`);
    }
  }
  const enabled = value.enabled === true; // 缺省关（fail-closed）：必须显式 enabled: true 才启用（审查 P2-1）
  const cfg = {
    enabled,
    storageRoot: optionalNonEmptyString(value.storageRoot, "storageRoot") ?? join(homedir(), ".dsh", "memory"),
    provider: optionalNonEmptyString(value.provider, "provider"),
    model: optionalNonEmptyString(value.model, "model"),
    minUserWords: positiveInt(value.minUserWords, 3, "minUserWords"),
    timeoutMs: positiveInt(value.timeoutMs, 120000, "timeoutMs"),
    maxOutputTokens: positiveInt(value.maxOutputTokens, 4096, "maxOutputTokens"),
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
    injectMaxChars: positiveInt(value.injectMaxChars, 60000, "injectMaxChars"),
    fallback: [],
  };
  if (cfg.timeoutMs > MAX_TIMER_DELAY_MS) throw new Error("dsh-memory: timeoutMs too large");
  if (cfg.retryMaxDelayMs > MAX_TIMER_DELAY_MS) throw new Error("dsh-memory: retryMaxDelayMs too large");
  if ((cfg.provider === void 0) !== (cfg.model === void 0)) {
    throw new Error("dsh-memory: provider and model must be configured together (or both omitted to follow the session route)");
  }
  if ((cfg.embeddingProvider === void 0) !== (cfg.embeddingModel === void 0)) {
    throw new Error("dsh-memory: embeddingProvider and embeddingModel must be configured together (or both omitted)");
  }
  cfg.fallback = fallbackRoutes(value.fallback, "fallback", cfg);
  return cfg;
}

/**
 * fallback 换道配置解析（批F1 E-5）。
 * 契约：数组；每项 provider/model 成对非空字符串；数组内去重；不得与主道
 * （显式配置的 provider/model；未配=跟随会话路由，无从判重）重复；≤3 条。
 * 本批只做校验与持有——换道调用逻辑在下一批 fallback 行为里实现。
 */
function fallbackRoutes(value, key, cfg) {
  if (value === void 0 || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`dsh-memory: ${key} must be an array of {provider, model}`);
  if (value.length > MAX_FALLBACK_ROUTES) {
    throw new Error(`dsh-memory: ${key} accepts at most ${MAX_FALLBACK_ROUTES} routes (got ${value.length})`);
  }
  const seen = new Set();
  const routes = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`dsh-memory: ${key} entries must be objects like {provider, model}`);
    }
    for (const entryKey of Object.keys(entry)) {
      if (entryKey !== "provider" && entryKey !== "model") {
        throw new Error(`dsh-memory: unknown ${key} entry key "${entryKey}" (expected "provider" and "model")`);
      }
    }
    const provider = optionalNonEmptyString(entry.provider, `${key}[].provider`);
    const model = optionalNonEmptyString(entry.model, `${key}[].model`);
    if (provider === void 0 || model === void 0) {
      throw new Error(`dsh-memory: ${key} entries need provider and model together (non-empty strings)`);
    }
    if (cfg?.provider === provider && cfg?.model === model) {
      throw new Error(`dsh-memory: ${key} route ${provider}/${model} duplicates the primary extraction route`);
    }
    const pair = `${provider}\u0000${model}`;
    if (seen.has(pair)) {
      throw new Error(`dsh-memory: ${key} has a duplicate route ${provider}/${model}`);
    }
    seen.add(pair);
    routes.push({ provider, model });
  }
  return routes;
}

function optionalNonEmptyString(value, key) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string" || value.length === 0) throw new Error(`dsh-memory: ${key} must be a non-empty string when set`);
  return value;
}

function positiveInt(value, fallback, key) {
  if (value === void 0 || value === null) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`dsh-memory: ${key} must be a positive integer`);
  return value;
}

function makeLogger(ctx, storageRoot) {
  // DSH_MEMORY_DEBUG=1 时全级直送 stderr + 追加 <storageRoot>/debug.log
  // （诊断口，规则4：可观测；Electron desktop 宿主下 utility 进程的 console
  //   不回传主进程，文件口是唯一可见通道）；平时走 ctx.logger（等级阈值由宿主定）。
  // 全面审查 O-C1：>1MB 轮转两档（debug.log.1 覆盖旧轮转），防无限追加。
  const debug = process.env.DSH_MEMORY_DEBUG === "1";
  const debugFile = debug && typeof storageRoot === "string" ? join(storageRoot, "debug.log") : null;
  const DEBUG_LOG_MAX_BYTES = 1024 * 1024;
  const emit = (level, message, error) => {
    try {
      if (debug) {
        const line = `[dsh-memory][${level}] ${message}${error ? " " + String(error?.message ?? error) : ""}\n`;
        console.error(`[dsh-memory][${level}] ${message}`, error ?? "");
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
        logger[level](`[dsh-memory] ${message}`, error ?? "");
      } else {
        (level === "error" ? console.error : console.warn)(`[dsh-memory] ${message}`, error ?? "");
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
 * 全面审查 O-A2：排序与判龄统一走 recentTsOf（与 prune 同一基准，
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
 * @returns { text, nonEmpty } nonEmpty=任一分类有条目
 */
export function renderGlobalIndex(storageRoot, { perCategoryLines = GLOBAL_CATEGORY_BUDGET_LINES, keepDays = 30 } = {}) {
  const sections = [];
  let nonEmpty = false;
  for (const id of CATEGORY_IDS) {
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
      lines = content.split("\n").filter((l) => l.trim().length > 0).slice(0, perCategoryLines);
    }
    if (lines.length > 0) nonEmpty = true;
    sections.push(`### ${CATEGORY_LABELS[id]} (${id})`);
    sections.push(lines.length > 0 ? lines.join("\n") : "（空）");
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
  const lifetime = new AbortController();
  const callControllers = new Set();
  const sessionStates = new WeakMap(); // session → { route }（主请求路由捕获）
  let indexCache = { key: "", text: null }; // 单条缓存足够：全局共享一个 section

  // ---- 全局写入收口（方案C §13：滚动清理触发点 = 启动时 + 每次全局写入后） ----
  function onGlobalWrite(reason) {
    try {
      const { removed, kept } = pruneRecentActivity(storageRoot, { keepCount: cfg.recentKeepCount, keepDays: cfg.recentKeepDays });
      if (removed > 0) log.info(`近期动态滚动清理（${reason}）：删 ${removed} 条，余 ${kept} 条`);
    } catch (error) {
      log.error("滚动清理异常", error);
    }
  }
  onGlobalWrite("启动");
  try {
    const swept = sweepTmpOrphans(storageRoot); // 全面审查 P3-3：启动清 .tmp 孤儿与陈旧 staging
    if (swept > 0) log.info(`启动清扫：移除 ${swept} 个临时残留`);
  } catch (error) {
    log.warn("启动清扫异常", error);
  }

  // ---- host 自供路由（方案C §5 API 面 + §13 面板供给）----
  ctx.inject(["webServer"], (sctx) => {
    sctx.effect(() => {
      const routes = [
        // 批F2：把提取观测/补提能力经闭包递进 API 面（scheduler 在下方创建，
        // 这里用函数引用延后解构——注册时 scheduler 尚未就绪没关系，调用时才取值）。
        ...makeApiRoutes({
          storageRoot,
          log,
          onGlobalWrite: () => onGlobalWrite("API 写入"),
          extraction: {
            triggerRetry: () => scheduler.retryPending(),
            inFlight: () => extractionObservationSnapshot().extractionInFlight,
            configSummary: () => ({
              provider: cfg.provider,
              model: cfg.model,
              fallback: cfg.fallback,
              embeddingProvider: cfg.embeddingProvider,
              embeddingModel: cfg.embeddingModel,
            }),
          },
        }),
        ...makePanelRoutes(log),
      ];
      const disposers = routes.map((route) => sctx.webServer.register(route));
      log.info(`webServer 路由已注册：/dsh-memory/api/* + /dsh-memory/panel/（${routes.length} 条）`);
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "dsh-memory: routes");
  });

  const scheduler = createScheduler({
    log: { warn: (m) => log.warn(m), error: (m, e) => log.error(m, e) },
    extract: (session, fromSeq, toSeq) => extractSession(session, fromSeq, toSeq),
    // 全面审查 P3-8：drain 预算与调用超时联动（此前 60s < 120s，慢调用必然挂满 drain）
    drainTimeoutMs: Math.min(60000, cfg.timeoutMs),
  });

  ctx.effect(() => async () => {
    // 关停纪律：先有界 drain 在途提取（headless one-shot 依赖这段在进程退出前把记忆写完），
    // 超时才 abort 兜底——不是先 abort 再等。
    await scheduler.dispose();
    lifetime.abort(new Error("dsh-memory disposed"));
    for (const controller of [...callControllers]) controller.abort(new Error("dsh-memory disposed"));
  }, "dsh-memory lifecycle");

  ctx.on("session/event", (session, event) => {
    try {
      scheduler.see(session, event);
      if (event?.type === "request/header") {
        captureRoute(session, event);
        return;
      }
      if (event?.type === "assistant/message") {
        // 路由兜底（M3 实测加固）：request/header 在部分宿主路径下不带 config
        // （desktop Electron 渲染器链路实测），assistant/message 的 source 字段
        // 是 usage-stats 同款已证可用的路由来源。
        captureRouteFromSource(session, event);
        return;
      }
      if (event?.type === "turn/end" && event.data?.reason?.kind === "completed") {
        // toSeq = turn/end 事件 seq+1（含界快照）
        const endSeq = Number(event.seq);
        scheduler.onTurnCompleted(session, Number.isFinite(endSeq) ? endSeq + 1 : session.seq);
      }
    } catch (error) {
      // 订阅回调永不炸宿主轮次（规则3：显式记日志，不静默吞）
      log.error("session/event 处理异常", error);
    }
  });

  ctx.on("session/disposed", (session) => {
    try {
      sessionStates.delete(session);
      scheduler.drop(session); // 审查 P3-5：Map 强持有 session，disposed 必须同步清
    } catch (error) {
      log.warn("session/disposed 清理异常", error); // 全面审查 P3：不静默吞（规则3）
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
    state.route = { provider, model };
  }

  /** 路由兜底：assistant/message 的 source.{provider,model}（usage-stats 同款已证来源）。 */
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
    if (state.route === void 0) state.route = { provider, model }; // 不覆盖 request/header 已捕获的路由
  }

  /**
   * 失败留痕+节流告警（P-PIPE1）：首次必警，此后每 10 次同因重警一次；计数进 metrics。
   * 批F2：同时进 recent 环形缓冲 + extraction-errors.log 落盘 + lastFailedRange
   * （三个观测口共用本收口，失败点无需各自记——单一事实源，双端不漂移）。
   */
  function noteFailure(reason, message, session, { provider = "", model = "", fromSeq, toSeq } = {}) {
    const streak = bumpExtractionFailure(reason);
    pushRecentFailure({ reason, message, provider, model });
    appendExtractionError(storageRoot, { at: Date.now(), reason, provider, model, message });
    if (typeof fromSeq === "number" && typeof toSeq === "number") {
      setExtractionFailedRange(fromSeq, toSeq);
    }
    if (streak === 1 || streak % 10 === 0) {
      log.warn(`${message}（同因连击 ${streak}；累计见 /dsh-memory/api/state extractionFailures）`);
    }
    return streak;
  }

  /** 提取任务体。返回 'ok'（成功或 skip，cursor 推进）| 'error'（不推进）。 */
  async function extractSession(session, fromSeq, toSeq) {
    if (lifetime.signal.aborted) return "error";
    // 总开关闸（R3）：关 = 全部提取停；关期间轮次按 skip 处理（cursor 推进，
    // 不积累——重开后不回头补提取，符合"关掉对话记忆"的用户心智）。
    const gate = readSettings(storageRoot, log);
    if (!gate.conversationMemory) {
      log.info("总开关关：本轮跳过提取（cursor 推进，不积累）");
      resetExtractionFailureStreak();
      return "ok";
    }
    const cwd = session?.header?.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) {
      const streak = noteFailure("no-cwd", "会话无 header.cwd，无法定位项目记忆目录，跳过提取", session, { fromSeq, toSeq });
      if (streak >= 5) {
        // 结构性失败断链（P-PIPE1）：重试不可能自愈，连续 5 次后显式放弃推进 cursor，
        // 斩断"失败区间无限累积 + 每轮全量 snapshotEvents"的 O(n²) 雪球（显式 error 日志非静默）。
        log.error(`会话无 cwd 连续 ${streak} 次，放弃本轮区间（seq ${fromSeq}..${toSeq}）不再重试`);
        return "ok";
      }
      return "error";
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
      resetExtractionFailureStreak();
      return "ok";
    }

    // 路由：显式配置优先，否则跟随本会话主请求路由（session-title 同款策略）
    const state = sessionStates.get(session) ?? {};
    const provider = cfg.provider ?? state.route?.provider;
    const model = cfg.model ?? state.route?.model;
    if (provider === void 0 || model === void 0) {
      const streak = noteFailure("no-route", "本会话尚无可用模型路由（config 与 request/header 均未提供），本轮不提取", session, { fromSeq, toSeq });
      if (streak >= 5) {
        log.error(`路由缺失连续 ${streak} 次，放弃本轮区间（seq ${fromSeq}..${toSeq}）不再重试`);
        return "ok";
      }
      return "error";
    }

    const { manifest, bodies } = buildManifestText(paths.memoryDir, { maxFiles: cfg.maxManifestFiles });
    const sleepAbortable = (ms, signal) => new Promise((resolve) => {
      // E-2：可取消退避 sleep——signal 已 aborted 时立即 resolve（不等满窗），
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
    // 全局 manifest 进提取 prompt（方案C §13：四分类+长期记忆现状，每类 20 行小预算）
    const globalManifest = renderGlobalIndex(storageRoot, { perCategoryLines: 20, keepDays: cfg.recentKeepDays }).text;
    const raw = renderTranscript(events);
    const transcript = clipTail(raw, cfg.maxPromptChars);
    if (transcript.length < raw.length) {
      // P-PIPE2：转录被裁剪的盲区显式留痕（恢复期旧轮次被裁出 prompt，模型侧有标记行）
      log.warn(`提取转录超预算已裁剪：保留尾部 ${cfg.maxPromptChars} 字符，seq ${from}..${to} 的旧前段本轮未参与提取（clipTail 标记已告知模型）`);
    }
    const { system, user } = buildExtractionPayload({ transcript, manifest, bodies, memoryDir: paths.memoryDir, globalManifest });

    let text;
    // ---- 提取调用重试链（批F1 E-1/E-2/E-3）----
    // 背景（方案 §1.4）：主对话由宿主 5 次重试保护，提取裸调一次判死——
    // 免费池抖 30 秒 → 429 → cursor 不推进 → 之后每轮重提同区间继续撞同一条池。
    //
    // 韧性语义：cfg.retryAttempts 次 attempt（含首次，默认 3），指数退避
    // min(retryBackoffMs*2^(n-1), retryMaxDelayMs) + jitter ±20%；failure 带
    // providerRetryAfterMs 时该次退避直接用它（钳 ≤3*retryMaxDelayMs 防恶意长等）。
    // 可重试性 route on failure.code（isRetryableFailure）：AUTH/INVALID_REQUEST/
    // QUOTA 等确定性失败立即摊牌，不浪费 attempt。
    //
    // drain 纪律（E-2，规则）：整条链对 drain 行为清晰、不放大预算——
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
    // cfg.fallback（E-5 骨架 → 批次A M6 已接线）：主道 attempt 链不可恢复失败后，逐条用
    // 同样 attempt 链调用换道路由；成功即记 fallbackUsed 并把 lastUsedRoute 指向该道。
    let attemptsUsed = 0;
    let usedRoute = { provider, model };
    // 批F2 观测面：LLM 段在途标记（含退避窗）；每次 attempt 起点记用车（U4 唯一真值源）。
    setExtractionInFlight(true);

    // attempt 链（E-2/E-3）：主道与换道共用——返回 {ok:true,text} / {ok:false,error} / {aborted:true}。
    const runAttemptChain = async (routeProvider, routeModel) => {
      let chainError;
      let used = 0;
      for (let attempt = 1; attempt <= cfg.retryAttempts; attempt += 1) {
        if (lifetime.signal.aborted) {
          // E-2：disposed 中途不再发起新 attempt（显式失败，不静默走完）。
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
            sessionId: session.id,
          });
          return { ok: true, text: value, attempts: used };
        } catch (error) {
          chainError = error;
          const failure = error?.failure;
          const retryable = isRetryableFailure(failure, error?.message);
          if (failure !== void 0) {
            // E-1：分类证据走 structured failure（status/retryAfter 一并进日志与 recent），不猜 message。
            log.warn(`提取 LLM 第 ${attempt}/${cfg.retryAttempts} 次 attempt 失败（${routeProvider}/${routeModel}）：code=${String(failure?.code)} status=${String(failure?.status)} retryAfterMs=${String(failure?.providerRetryAfterMs)} retryable=${retryable}`);
          } else {
            log.warn(`提取 LLM 第 ${attempt}/${cfg.retryAttempts} 次 attempt 失败（无 structured failure，按 internal 兜底）：${error?.message}`);
          }
          if (!retryable || attempt === cfg.retryAttempts) break;
          // E-2：可取消退避——abort 提前 resolve，不裸 await setTimeout
          const delay = retryDelayMs(attempt, { backoffMs: cfg.retryBackoffMs, maxDelayMs: cfg.retryMaxDelayMs }, failure);
          log.info(`提取重试退避 ${delay}ms 后发起第 ${attempt + 1} 次 attempt`);
          await sleepAbortable(delay, lifetime.signal);
          if (lifetime.signal.aborted) {
            log.warn("提取重试链：退避期间 dispose，放弃后续 attempt");
            return { aborted: true, attempts: used };
          }
          bumpRetryAttempt(); // E-4：retry attempt 粒度（本次重试真实发生才计）
        }
      }
      return { ok: false, error: chainError, attempts: used };
    };

    let fallbackUsed = false;
    try {
      let outcome = await runAttemptChain(provider, model);
      attemptsUsed = outcome.attempts ?? 0;
      // 批次A M6 换道：主道不可恢复失败后，逐条试 fallback 路由（同 attempt 链），首条成功即停。
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
      if (outcome.aborted === true) return "error";
      if (!outcome.ok) throw outcome.error;
      text = outcome.text;
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
      // P3-6 路由重捕：纯兜底捕获的路由调用失败时清槽强制重捕（中途换模型可自愈）
      if (cfg.provider === void 0) {
        const st = sessionStates.get(session);
        if (st !== void 0) delete st.route;
      }
      return "error";
    } finally {
      setExtractionInFlight(false);
    }
    // E-4：有失败尝试后最终成功——打恢复时间戳（黄态依据；纯一路成功不打）
    if (attemptsUsed > 1) noteExtractionRecovered();

    let parsed;
    try {
      parsed = parseExtractionOutput(text);
    } catch (error) {
      noteFailure("parse-error", `提取输出解析失败：${error?.message ?? "unparseable"}`, session, { provider, model, fromSeq: from, toSeq: to });
      log.warn("提取输出解析失败详情", error);
      return "error";
    }
    if (parsed.kind === "nothing") {
      log.info(`提取完成：无需保存（seq ${from}..${to}）`);
      resetExtractionFailureStreak();
      clearExtractionFailedRange(); // 批F2：成功即不再承诺补提，区间提示撤下
      return "ok";
    }
    if (parsed.skippedMalformed > 0) {
      log.warn(`提取输出含 ${parsed.skippedMalformed} 条畸形 op 已跳单（好 ops 照常落盘，P-PIPE3 跳单容错）`);
    }
    const ops = parsed.ops.slice(0, cfg.maxOps);
    if (parsed.ops.length > cfg.maxOps) {
      log.warn(`ops 超额：模型返回 ${parsed.ops.length} 条，仅取前 ${cfg.maxOps}，丢弃 ${parsed.ops.length - cfg.maxOps} 条`);
    }
    try {
      // scope 路由落盘（§13）：project ops 走项目根；global:* 走全局分类根；
      // projectMemory/globalExtraction 开关各自过滤计数（R10 对称推定）。
      const result = applyScopedOps(
        { storageRoot, projectRoot: paths.memoryDir },
        ops,
        { originSessionId: session.id, allowGlobal: gate.globalExtraction, allowProject: gate.projectMemory, log },
      );
      invalidateIndexCache();
      if (result.writes > 0 || result.deletes > 0) onGlobalWrite("提取落盘");
      const filteredNote = result.filteredGlobal > 0 || result.filteredProject > 0
        ? `；过滤 global ${result.filteredGlobal} project ${result.filteredProject}（开关关）`
        : "";
      const unknownNote = result.unknownScope > 0 ? `；未知 scope 跳过 ${result.unknownScope}` : "";
      const failedNote = result.failed > 0 ? `；落盘失败 ${result.failed}（单条隔离不重试，见 error 日志）` : "";
      log.info(
        `提取落盘：写 ${result.writes} 删 ${result.deletes} 跳过 ${result.skipped}${failedNote}${filteredNote}${unknownNote}（seq ${from}..${to}，${paths.slug}-${paths.hash}）`,
      );
      if (result.failed > 0) {
        // H-OPS1：单条 IO 失败计数留痕但 cursor 照常推进（斩断确定性重试循环）。
        // E-4 审查修正：io-error 部分失败后【不】reset streak（紧跟下方 reset 会把
        // 红条抹掉，该桶变死观测）——软失败语义显式化：计数但保持可见。
        bumpExtractionFailure("io-error");
        pushRecentFailure({ reason: "io-error", message: `落盘 ${result.failed} 条单 op 失败（cursor 照常推进）`, provider, model });
        appendExtractionError(storageRoot, { at: Date.now(), reason: "io-error", provider, model, message: `落盘 ${result.failed} 条单 op 失败（单条隔离不重试）` });
      } else {
        resetExtractionFailureStreak();
      }
      clearExtractionFailedRange(); // 成功推进 cursor：区间不再承诺补提
    } catch (error) {
      // 整批落盘结构性失败（如索引重建炸）：下轮重提（cursor 不推进）
      noteFailure("io-error", `记忆落盘失败：${error?.message ?? "io"}`, session, { provider, model, fromSeq: from, toSeq: to });
      log.error("记忆落盘失败详情", error);
      return "error";
    }
    return "ok";
  }

  async function callLlmText({ provider, model, system, user, maxTokens, sessionId }) {
    const controller = new AbortController();
    callControllers.add(controller);
    const onAbort = () => controller.abort(lifetime.signal.reason);
    lifetime.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`dsh-memory: 提取超时 ${cfg.timeoutMs}ms`)), cfg.timeoutMs);
    try {
      const messages = [{ role: "user", content: [{ type: "text", text: user }] }];
      let acc = "";
      let finish;
      const options = {
        provider,
        model,
        system,
        messages,
        maxTokens,
        sessionId,
        purpose: "dsh-memory-extraction",
        signal: controller.signal,
      };
      for await (const chunk of ctx.llm.stream(options)) {
        if (chunk?.type === "text-delta" && typeof chunk.text === "string") acc += chunk.text;
        else if (chunk?.type === "finish") finish = chunk;
      }
      const kind = finish?.reason?.kind;
      if (kind !== "stop") {
        const code = finish?.reason?.failure?.code ?? "";
        // E-1：failure 本体挂到 error 上供上层 classify（route on code，禁 message 正则）；
        // message 仅给人看的日志摘要（含 kind+code+status 摘要，正文供 debug）。
        const failure = finish?.reason?.failure;
        const status = failure?.status ?? "";
        const error = new Error(`dsh-memory: 提取调用异常结束 kind=${String(kind)}${code ? ` code=${code}` : ""}${status ? ` status=${String(status)}` : ""}`);
        if (failure !== void 0 && failure !== null) error.failure = failure;
        throw error;
      }
      return acc;
    } finally {
      clearTimeout(timer);
      lifetime.signal.removeEventListener("abort", onAbort);
      callControllers.delete(controller);
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

  function indexTextFor(memoryDir) {
    const indexPath = join(memoryDir, INDEX_FILENAME);
    let key = "";
    try {
      const stat = statSync(indexPath);
      // 缓存键必须含项目维度（审查 P2-2）：同 size+mtime 的两个项目不得互相串索引
      key = `${memoryDir}|${stat.mtimeMs}:${stat.size}`;
    } catch {
      return ""; // 无索引 = 无记忆，注入空段（renderPrompt 丢弃空 section）
    }
    if (indexCache.key === key && indexCache.text !== null) return indexCache.text;
    let text = "";
    try {
      const content = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
      text = [
        "## Project memory index (MEMORY.md)",
        "",
        // 全面审查 P3-1：preferTail 保最新丢最旧（merge 语义新条目在尾部，
        // 此前保头部导致 >200 条后的新记忆反而从注入里消失）
        truncateWithWarning(content, cfg.maxIndexLines, cfg.maxIndexChars, { preferTail: true }),
      ].join("\n");
      indexCache = { key, text };
    } catch (error) {
      // 显式可见降级：读失败注入空段并告警，不让单次 IO 失败炸掉整个 prompt 组装
      log.warn("MEMORY.md 读取失败，本轮不注入索引", error);
      return "";
    }
    return text;
  }

  /** 4990 人设段：称呼指令（空则略句）+ 人设正文；正文清空且无称呼 = 空段丢弃。
   * 全面审查 P-INJ1：正文过注入预算（400 行/16k 字符）截断+可见 WARNING——
   * 此前唯一上限是写入侧 100KB，四段最坏叠加 ~138KB 全进每轮 prompt。 */
  function personaTextFor() {
    const addressing = readAddressing(storageRoot, log);
    const persona = readPersona(storageRoot, log);
    const lines = [];
    if (addressing.dshName.length > 0) lines.push(`用户叫你「${addressing.dshName}」。`);
    if (addressing.userAlias.length > 0) lines.push(`希望你称呼他为「${addressing.userAlias}」。`);
    const body = persona.content.trim();
    if (lines.length === 0 && body.length === 0) return ""; // 空段自动丢弃（§4）
    const parts = ["## 用户为 DSH 设定的补充人设", ""];
    if (lines.length > 0) parts.push(lines.join("\n"), "");
    if (body.length > 0) parts.push(truncateWithWarning(body, 400, 16000, { label: "人设" }));
    return parts.join("\n");
  }

  /** 4995 全局索引段：四分类+长期记忆索引 + 全局记忆根路径一行；任一分类非空才注入（R2）。 */
  function globalIndexTextFor() {
    const { text, nonEmpty } = renderGlobalIndex(storageRoot, { perCategoryLines: GLOBAL_CATEGORY_BUDGET_LINES, keepDays: cfg.recentKeepDays });
    if (!nonEmpty) return "";
    return [
      "## Global memory index (user-level, applies to all conversations)",
      "",
      `Global memory root: ${globalRoot(storageRoot)} — each line points to one memory file; Read any file whose hook matters.`,
      "",
      truncateWithWarning(text, GLOBAL_INDEX_TOTAL_LINES, GLOBAL_INDEX_TOTAL_CHARS),
    ].join("\n");
  }

  if (cfg.injectChannel === "section") {
    ctx.systemPrompt.section({
      name: PERSONA_SECTION,
      order: PERSONA_ORDER,
      interpolate: false,
      text: () => {
        try {
          // 人设/称呼只受总开关管（R3：设定不是记忆，总开关开着就生效）。
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
      name: GLOBAL_INDEX_SECTION,
      order: GLOBAL_INDEX_ORDER,
      interpolate: false,
      text: () => {
        try {
          // 全局段注入跟随数据非空（R2：不受 globalExtraction 开关管——开关只管提取）。
          const on = readSettings(storageRoot, log).conversationMemory;
          debugProbe(`开关求值 ${GLOBAL_INDEX_SECTION}: conversationMemory=${on}`);
          if (!on) return "";
          return globalIndexTextFor();
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
          // 注入条件（§4）：总开关 + 项目记忆开关。
          const gate = readSettings(storageRoot, log);
          const on = gate.conversationMemory && gate.projectMemory;
          debugProbe(`开关求值 ${INSTRUCTIONS_SECTION}: conversationMemory=${gate.conversationMemory} projectMemory=${gate.projectMemory}`);
          if (!on) return "";
          const memoryDir = memoryDirFor(context);
          return memoryDir === void 0 ? "" : usageTextFor(memoryDir);
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
          return memoryDir === void 0 ? "" : indexTextFor(memoryDir);
        } catch (error) {
          log.error("索引段渲染失败", error);
          return "";
        }
      },
    });
  } else {
    // 批次A：消息通道为主（默认），section 侧只留一条静态路由指引兜底
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

  /** 批次A 路由兜底段文本：记忆走消息通道，这里只留一条指针。 */
  function routingTextFor(context) {
    const gate = readSettings(storageRoot, log);
    if (!gate.conversationMemory) return "";
    const lines = [
      "## Persistent memory (dsh-memory)",
      "",
      "Relevant memory is delivered in this conversation by the dsh-memory plugin; Read the files it points to when needed.",
      `Global memory root: ${globalRoot(storageRoot)}.`,
    ];
    // 项目目录行随 projectMemory 开关（与 messages 模式 desiredMemoryContext 同口径——关掉项目记忆就不指路）
    const memoryDir = gate.projectMemory ? memoryDirFor(context) : void 0;
    if (memoryDir !== void 0) lines.push(`Project memory directory: ${memoryDir} (MEMORY.md is the index).`);
    return lines.join("\n");
  }

  // ---- 批次A 消息通道注入（agent/pre-step）----
  /** 逐段渲染容错：失败记注入异常指标 + 日志并返回空串（M1：显式可见降级，绝不静默丢）。 */
  function safeSegment(label, fn) {
    try {
      return String(fn() ?? "");
    } catch (error) {
      recordInjectionError();
      log.error(`消息通道${label}渲染失败`, error);
      return "";
    }
  }

  /** 按开关求值四段文本并做预算裁剪；全空返回 null（不注入）。 */
  function desiredMemoryContext(agent) {
    const gate = readSettings(storageRoot, log);
    const segments = { persona: "", globalIndex: "", usage: "", projectIndex: "" };
    if (gate.conversationMemory) {
      segments.persona = safeSegment("人设段", () => personaTextFor());
      segments.globalIndex = safeSegment("全局索引段", () => globalIndexTextFor());
      if (gate.projectMemory) {
        const memoryDir = memoryDirFor({ agent });
        if (memoryDir !== void 0) {
          segments.usage = safeSegment("使用说明段", () => usageTextFor(memoryDir));
          segments.projectIndex = safeSegment("索引段", () => indexTextFor(memoryDir));
        }
      }
    }
    if (!segments.persona && !segments.globalIndex && !segments.usage && !segments.projectIndex) return null;
    const { text, dropped } = buildMemoryContext(segments, { maxChars: cfg.injectMaxChars, intro: MEMORY_CONTEXT_INTRO });
    return text === "" ? null : { text, dropped };
  }

  /** 扫会话 surface 找我方最近一次 memory-context 注入文本（视野判定；被 compaction/rewind 挤出则返回 undefined → 触发补发）。 */
  function visibleMemoryContextText(agent) {
    const surface = agent?.session?.surface;
    if (surface === void 0 || !Array.isArray(surface.nodes)) return void 0;
    let found;
    for (const seq of surface.nodes) {
      let event;
      try {
        event = agent.session.eventAt(seq);
      } catch {
        continue;
      }
      if (event?.type !== "user/message") continue;
      const message = messageOf(event);
      if (message === void 0 || !isPluginSourcedMessage(message)) continue;
      if (message.source?.kind !== INJECT_SOURCE_KIND || message.source?.form !== MEMORY_CONTEXT_FORM) continue;
      found = textBlocksOf(message);
    }
    return found;
  }

  /** 构造一条 producer-owned durable user 消息（普通对象，零依赖——对齐 mnemon 形态）。 */
  function makeMemoryMessage(text) {
    return {
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: INJECT_SOURCE_KIND, form: MEMORY_CONTEXT_FORM, digest: digestOf(text) },
    };
  }

  /**
   * 注入决策（pre-step 后处理）：每轮首步求值一次——四段渲染 → 预算裁剪 →
   * 视野去重（同文本已在 surface 则跳过；内容变化才补发；被挤出则补发）→ 追加进本步消息批。
   */
  function applyMemoryInjection(payload, decision) {
    if (decision === void 0 || decision.kind !== "enter") return decision;
    if (payload?.signal?.aborted === true) return decision;
    if (payload.step !== 1) return decision; // 每轮只在第一步求值（与 mnemon 同构）
    const messages = Array.isArray(decision.messages) ? decision.messages : [];
    if (messages.length === 0) return decision; // 无用户输入步：不注入
    if (messages.some((message) => message?.source?.kind === INJECT_SOURCE_KIND)) return decision; // 本步批内已含我方注入（精确判据：勿被他人 kind:"plugin" 误判而漏注入）
    const agent = payload.agent;
    if (agent === void 0) return decision;
    if (agent.session?.header?.origin === "subagent") return decision; // 批次A 决策：subagent 会话不注入（对齐 hindsight/openviking）
    const built = desiredMemoryContext(agent);
    if (built === null) return decision;
    const prior = visibleMemoryContextText(agent);
    if (prior !== void 0 && sameInjectionText(prior, built.text)) return decision; // 同内容已在视野：不重复
    recordInjection({ chars: built.text.length, dropped: built.dropped, resend: prior !== void 0 });
    return { ...decision, messages: [...messages, makeMemoryMessage(built.text)] };
  }

  if (cfg.injectChannel === "message") {
    ctx.on(
      "agent/pre-step",
      async (payload, next) => {
        const decision = await next();
        try {
          return applyMemoryInjection(payload, decision);
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
    indexCache = { key: "", text: null };
  }
}

export { apply, inject, name };

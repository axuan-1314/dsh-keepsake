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
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { INDEX_FILENAME } from "./filename.js";
import { applyScopedOps, buildExtractionPayload, parseExtractionOutput } from "./extract.js";
import { buildManifestText, truncateWithWarning } from "./manifest.js";
import { projectMemoryPaths } from "./paths.js";
import { createScheduler } from "./state.js";
import { clipTail, renderTranscript, skipReason } from "./transcript.js";
import { readSettings } from "./settings.js";
import { makeApiRoutes } from "./api.js";
import { makePanelRoutes } from "./panel.js";
import {
  CATEGORY_IDS,
  CATEGORY_LABELS,
  globalRoot,
  listEntries,
  pruneRecentActivity,
  readAddressing,
  readPersona,
} from "./global-store.js";

const name = "dsh-memory";
const inject = ["llm", "systemPrompt", "webServer"];

const PERSONA_SECTION = "dsh-memory:persona"; // 4990
const GLOBAL_INDEX_SECTION = "dsh-memory:global-index"; // 4995
const INSTRUCTIONS_SECTION = "dsh-memory:instructions"; // 5000
const INDEX_SECTION = "dsh-memory:index"; // 5001
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
export function resolveConfig(raw) {
  const value = raw !== void 0 && raw !== null && typeof raw === "object" ? raw : {};
  const KNOWN = new Set([
    "enabled", "storageRoot", "provider", "model", "minUserWords", "timeoutMs", "maxOutputTokens",
    "maxIndexLines", "maxIndexChars", "maxManifestFiles", "maxPromptChars", "maxOps",
    "recentKeepCount", "recentKeepDays",
  ]);
  for (const key of Object.keys(value)) {
    if (!KNOWN.has(key)) throw new Error(`dsh-memory: unknown config key "${key}"`);
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
  };
  if (cfg.timeoutMs > MAX_TIMER_DELAY_MS) throw new Error("dsh-memory: timeoutMs too large");
  if ((cfg.provider === void 0) !== (cfg.model === void 0)) {
    throw new Error("dsh-memory: provider and model must be configured together (or both omitted to follow the session route)");
  }
  return cfg;
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

function makeLogger(ctx) {
  // DSH_MEMORY_DEBUG=1 时全级直送 stderr（诊断口，规则4：可观测）；
  // 平时走 ctx.logger（等级阈值由宿主定）。
  const debug = process.env.DSH_MEMORY_DEBUG === "1";
  const emit = (level, message, error) => {
    try {
      if (debug) {
        console.error(`[dsh-memory][${level}] ${message}`, error ?? "");
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
 */
function renderRecentLines(storageRoot, budgetLines, keepDays) {
  const entries = listEntries(storageRoot, "recent-activity").slice(0, budgetLines);
  const now = Date.now();
  const lines = [];
  for (const entry of entries) {
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : entry.mtimeMs;
    const ageDays = Number.isFinite(ts) ? Math.floor((now - ts) / 86400_000) : 0;
    const expireDays = Number.isFinite(ts) ? Math.max(0, keepDays - ageDays) : keepDays;
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
  const log = makeLogger(ctx);
  if (!cfg.enabled) {
    log.info("enabled=false，插件驻留但不订阅不注入");
    return;
  }

  const storageRoot = cfg.storageRoot;
  const lifetime = new AbortController();
  const callControllers = new Set();
  const sessionStates = new WeakMap(); // session → { route }（主请求路由捕获）
  const warnedNoRoute = new WeakSet();
  const warnedNoCwd = new WeakSet();
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

  // ---- host 自供路由（方案C §5 API 面 + §13 面板供给）----
  ctx.inject(["webServer"], (sctx) => {
    sctx.effect(() => {
      const routes = [
        ...makeApiRoutes({ storageRoot, log, onGlobalWrite: () => onGlobalWrite("API 写入") }),
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
    } catch {
      /* ignore */
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

  /** 提取任务体。返回 'ok'（成功或 skip，cursor 推进）| 'error'（不推进）。 */
  async function extractSession(session, fromSeq, toSeq) {
    if (lifetime.signal.aborted) return "error";
    // 总开关闸（R3）：关 = 全部提取停；关期间轮次按 skip 处理（cursor 推进，
    // 不积累——重开后不回头补提取，符合"关掉对话记忆"的用户心智）。
    const gate = readSettings(storageRoot, log);
    if (!gate.conversationMemory) {
      log.info("总开关关：本轮跳过提取（cursor 推进，不积累）");
      return "ok";
    }
    const cwd = session?.header?.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) {
      if (!warnedNoCwd.has(session)) {
        warnedNoCwd.add(session);
        log.warn("会话无 header.cwd，无法定位项目记忆目录，跳过提取");
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
      return "ok";
    }

    // 路由：显式配置优先，否则跟随本会话主请求路由（session-title 同款策略）
    const state = sessionStates.get(session) ?? {};
    const provider = cfg.provider ?? state.route?.provider;
    const model = cfg.model ?? state.route?.model;
    if (provider === void 0 || model === void 0) {
      if (!warnedNoRoute.has(session)) {
        warnedNoRoute.add(session);
        log.warn("本会话尚无可用模型路由（config 与 request/header 均未提供），本轮不提取");
      }
      return "error";
    }

    const { manifest, bodies } = buildManifestText(paths.memoryDir, { maxFiles: cfg.maxManifestFiles });
    // 全局 manifest 进提取 prompt（方案C §13：四分类+长期记忆现状，每类 20 行小预算）
    const globalManifest = renderGlobalIndex(storageRoot, { perCategoryLines: 20, keepDays: cfg.recentKeepDays }).text;
    let transcript = renderTranscript(events);
    transcript = clipTail(transcript, cfg.maxPromptChars);
    const { system, user } = buildExtractionPayload({ transcript, manifest, bodies, memoryRoot: paths.memoryDir, globalManifest });

    let text;
    try {
      text = await callLlmText({
        provider,
        model,
        system,
        user,
        maxTokens: cfg.maxOutputTokens,
        sessionId: session.id,
      });
    } catch (error) {
      log.warn("提取 LLM 调用失败，cursor 不推进", error);
      return "error";
    }

    let parsed;
    try {
      parsed = parseExtractionOutput(text);
    } catch (error) {
      log.warn("提取输出解析失败，cursor 不推进", error);
      return "error";
    }
    if (parsed.kind === "nothing") {
      log.info(`提取完成：无需保存（seq ${from}..${to}）`);
      return "ok";
    }
    const ops = parsed.ops.slice(0, cfg.maxOps);
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
      log.info(
        `提取落盘：写 ${result.writes} 删 ${result.deletes} 跳过 ${result.skipped}${filteredNote}${unknownNote}（seq ${from}..${to}，${paths.slug}-${paths.hash}）`,
      );
    } catch (error) {
      // 落盘半途失败：下轮重提（cursor 不推进），文件操作按文件粒度幂等
      log.error("记忆落盘失败，cursor 不推进", error);
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
        throw new Error(`dsh-memory: 提取调用异常结束 kind=${String(kind)}${code ? ` code=${code}` : ""}`);
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
        truncateWithWarning(content, cfg.maxIndexLines, cfg.maxIndexChars),
      ].join("\n");
      indexCache = { key, text };
    } catch (error) {
      // 显式可见降级：读失败注入空段并告警，不让单次 IO 失败炸掉整个 prompt 组装
      log.warn("MEMORY.md 读取失败，本轮不注入索引", error);
      return "";
    }
    return text;
  }

  /** 4990 人设段：称呼指令（空则略句）+ 人设正文；正文清空且无称呼 = 空段丢弃。 */
  function personaTextFor() {
    const addressing = readAddressing(storageRoot);
    const persona = readPersona(storageRoot);
    const lines = [];
    if (addressing.dshName.length > 0) lines.push(`用户叫你「${addressing.dshName}」。`);
    if (addressing.userAlias.length > 0) lines.push(`希望你称呼他为「${addressing.userAlias}」。`);
    const body = persona.content.trim();
    if (lines.length === 0 && body.length === 0) return ""; // 空段自动丢弃（§4）
    const parts = ["## 用户为 DSH 设定的补充人设", ""];
    if (lines.length > 0) parts.push(lines.join("\n"), "");
    if (body.length > 0) parts.push(body);
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

  function invalidateIndexCache() {
    indexCache = { key: "", text: null };
  }
}

export { apply, inject, name };

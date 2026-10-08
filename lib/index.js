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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { INDEX_FILENAME } from "./filename.js";
import { applyOps, buildExtractionPayload, parseExtractionOutput } from "./extract.js";
import { buildManifestText, truncateWithWarning } from "./manifest.js";
import { projectMemoryPaths } from "./paths.js";
import { createScheduler } from "./state.js";
import { clipTail, renderTranscript, skipReason } from "./transcript.js";

const name = "dsh-memory";
const inject = ["llm", "systemPrompt", "webServer"];

const INSTRUCTIONS_SECTION = "dsh-memory:instructions";
const INDEX_SECTION = "dsh-memory:index";
const SECTION_ORDER = 5000; // 外部段可任取有限 order；置于 first-party 指引之后、后缀之前
const MAX_TIMER_DELAY_MS = 2147483647;
const USAGE_HEADER = "## Persistent project memory";

// ---- M0 探针段（方案C §5/§8）：API 前缀 / 面板路径 / loopback 守卫 ----
const API_PREFIX = "/dsh-memory/api/";
const PANEL_PATH = "/dsh-memory/panel/";
const panelHtmlPath = fileURLToPath(new URL("../web/panel.html", import.meta.url));

/** loopback 守卫（照抄 another-plugin lib/index.js isLoopbackRequest，逐行同款）。 */
function isLoopbackRequest(req) {
  const address = req.socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 段求值探针日志：仅 DSH_MEMORY_DEBUG=1 时输出（P3 验证口，平时零噪音）。 */
function debugProbe(message) {
  if (process.env.DSH_MEMORY_DEBUG === "1") {
    console.error(`[dsh-memory][probe] ${message}`);
  }
}

/**
 * settings.json 读取（M0 内联最简版；M1 抽到 lib/settings.js 并补全量测试）。
 * 语义按方案C R3/R4：缺省三开关全开；损坏=显式 warn + 按缺省运行（corrupt 标记
 * 供门牌红条）；mtime 缓存，每次求值零开销读取。
 * @returns {{version:number, conversationMemory:boolean, projectMemory:boolean,
 *            globalExtraction:boolean, corrupt:boolean}}
 */
export function readMemorySettings(storageRoot, log = { warn: () => {} }) {
  const path = join(storageRoot, "settings.json");
  const defaults = { version: 1, conversationMemory: true, projectMemory: true, globalExtraction: true, corrupt: false };
  let key = "";
  try {
    const stat = statSync(path);
    key = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return defaults; // 不存在 = 缺省全开（R4：与 v0.1.0 行为连续）
  }
  if (readMemorySettings._cache && readMemorySettings._cache.key === key) {
    return readMemorySettings._cache.value;
  }
  let value = defaults;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
    value = {
      version: 1,
      conversationMemory: parsed.conversationMemory !== false,
      projectMemory: parsed.projectMemory !== false,
      globalExtraction: parsed.globalExtraction !== false,
      corrupt: false,
    };
  } catch (error) {
    log.warn("settings.json 解析失败，按缺省（三开关全开）运行", error);
    value = { ...defaults, corrupt: true };
  }
  readMemorySettings._cache = { key, value };
  return value;
}

/** 配置解析：非法即抛（fail loud），未知键即抛（config 无 schema，靠严格性兜底）。 */
export function resolveConfig(raw) {
  const value = raw !== void 0 && raw !== null && typeof raw === "object" ? raw : {};
  const KNOWN = new Set([
    "enabled", "storageRoot", "provider", "model", "minUserWords", "timeoutMs", "maxOutputTokens",
    "maxIndexLines", "maxIndexChars", "maxManifestFiles", "maxPromptChars", "maxOps",
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
  const debug = process.env.DSH_MEMORY_DEBUG === "1";  const emit = (level, message, error) => {
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

  // ---- M0 探针：host 自供路由（方案C §5 API 面 / §8 P2）----
  // web profile（http://127.0.0.1）下 client 相对路径 fetch 反代可达；desktop
  // dsh-app:// 下经反代鉴权面可达。每 handler 先过 loopback 守卫（R7 纵深第二层）。
  ctx.inject(["webServer"], (sctx) => {
    sctx.effect(() => {
      const disposers = [];
      // GET /dsh-memory/api/state —— 轻态端点（R6：开关+计数+概览，不含条目正文）
      disposers.push(sctx.webServer.register({
        kind: "exact",
        path: `${API_PREFIX}state`,
        handler: (req, res) => {
          try {
            if (!isLoopbackRequest(req)) {
              writeJson(res, 403, { error: "loopback requests only" });
              return;
            }
            if (req.method !== "GET" && req.method !== "HEAD") {
              writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") });
              return;
            }
            const settings = readMemorySettings(storageRoot, log);
            writeJson(res, 200, {
              ok: true,
              probe: "m0",
              settings: {
                conversationMemory: settings.conversationMemory,
                projectMemory: settings.projectMemory,
                globalExtraction: settings.globalExtraction,
              },
              corrupt: settings.corrupt,
              counts: { global: 0, projects: countProjects() }, // M0 骨架：global 计数 M1 补
            });
          } catch (error) {
            log.error("GET state 处理异常", error);
            writeJson(res, 500, { error: "internal" });
          }
        },
      }));
      // GET /dsh-memory/panel/ —— 面板页供给（readFileSync + no-cache，方案C §13）
      const servePanel = (req, res) => {
        try {
          if (!isLoopbackRequest(req)) {
            writeJson(res, 403, { error: "loopback requests only" });
            return;
          }
          if (req.method !== "GET" && req.method !== "HEAD") {
            writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") });
            return;
          }
          const body = readFileSync(panelHtmlPath);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
          res.end(body);
        } catch (error) {
          log.error("panel 供给异常", error);
          writeJson(res, 500, { error: "panel unavailable" });
        }
      };
      disposers.push(sctx.webServer.register({ kind: "exact", path: PANEL_PATH, handler: servePanel }));
      disposers.push(sctx.webServer.register({ kind: "prefix", path: PANEL_PATH, handler: servePanel }));
      // 无尾斜杠形态同样供给（浏览器/手输常见；M1 panel.js 统一收口）
      disposers.push(sctx.webServer.register({ kind: "exact", path: PANEL_PATH.replace(/\/$/, ""), handler: servePanel }));
      log.info(`webServer 路由已注册：${API_PREFIX}state + ${PANEL_PATH}`);
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "dsh-memory: m0 probe routes");
  });

  /** projects/ 目录下项目记忆目录计数（M0 骨架版概览）。 */
  function countProjects() {
    try {
      return readdirSync(join(storageRoot, "projects")).filter((f) => f.includes("-")).length;
    } catch {
      return 0;
    }
  }


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
    const gate = readMemorySettings(storageRoot, log);
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
    let transcript = renderTranscript(events);
    transcript = clipTail(transcript, cfg.maxPromptChars);
    const { system, user } = buildExtractionPayload({ transcript, manifest, bodies, memoryRoot: paths.memoryDir });

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
      const result = applyOps(paths.memoryDir, ops, { originSessionId: session.id, log });
      invalidateIndexCache();
      log.info(
        `提取落盘：写 ${result.writes} 删 ${result.deletes} 跳过 ${result.skipped}（seq ${from}..${to}，${paths.slug}-${paths.hash}）`,
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

  ctx.systemPrompt.section({
    name: INSTRUCTIONS_SECTION,
    order: SECTION_ORDER,
    interpolate: false,
    text: (context) => {
      try {
        // 总开关闸（R3）：关 = 四段全灭（空段由 renderPrompt 自动丢弃）。
        const on = readMemorySettings(storageRoot, log).conversationMemory;
        debugProbe(`开关求值 ${INSTRUCTIONS_SECTION}: conversationMemory=${on}`);
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
        const on = readMemorySettings(storageRoot, log).conversationMemory;
        debugProbe(`开关求值 ${INDEX_SECTION}: conversationMemory=${on}`);
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

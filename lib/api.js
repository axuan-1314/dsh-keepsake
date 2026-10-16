// dsh-keepsake REST API 面。
//   全部 handler 先过 loopback 守卫（纵深第二层；dsh-app 反代鉴权是第一层），
//   再过方法白名单与 JSON body 体积上限（导入 2MB / 人设 100KB 分级）。
//   错误显式：结构化 JSON error + 日志。
//   写操作全部经 global-store 三道闸 + 原子写；索引文件永不被写端点触碰。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertWritable, FORMAT_VERSION, readFormatState } from "./format.js";
import {
  CATEGORY_IDS,
  backupsRoot,
  categoryDir,
  clearCategory,
  countEntries,
  createBackup,
  createEntry,
  exportAll,
  isCategoryId,
  isSafeBackupId,
  listBackups,
  listEntries,
  readAddressing,
  readEntry,
  readPersona,
  reconcileCategoryIndexAfterDelete,
  restoreBackup,
  updateEntry,
  writeAddressing,
  writeEntryDirect,
  writePersona,
  resetPersona,
  DEFAULT_PERSONA,
} from "./global-store.js";
import { readSettings, RECENT_KEEP_DAYS_DEFAULT, validateSettingsNumber, writeSettings } from "./settings.js";
import { embedTexts } from "./embedding.js";
import {
  acquireExtractLock,
  createPreRestoreSnapshot,
  createSurgicalSnapshot,
  listSurgicalSnapshots,
  listTrash,
  pruneSurgicalSnapshots,
  purgeTrash,
  resolveSafetySettings,
  restoreSurgicalSnapshot,
  restoreTrash,
  rootKeyOf,
  safetyDiskState,
  trashMemoryFile,
} from "./safety.js";
import { safetyCounterSnapshot } from "./extract.js";

/** 出参脱敏：settings 回给面板时把 embedding.apiKey 换成 apiKeySet 布尔（不外泄密钥）。
 * recentKeepDays 现值：settings 未设时回落到 entry config 的现值，再回落到默认 30（面板恒拿到数字）。 */
function settingsForClient(settings, recentKeepDaysFallback = void 0) {
  const s = settings ?? {};
  const recent = [s.recentKeepDays, recentKeepDaysFallback, RECENT_KEEP_DAYS_DEFAULT].find((v) => typeof v === "number" && Number.isFinite(v));
  const out = {
    conversationMemory: s.conversationMemory,
    projectMemory: s.projectMemory,
    globalExtraction: s.globalExtraction,
    // v0.4.0 写入安全面三项（面板可见/可调）+ 近期动态保留天数
    surgicalKeep: s.surgicalKeep,
    trashKeepDays: s.trashKeepDays,
    recentKeepDays: recent,
    hardfactPolicy: s.hardfactPolicy,
    corrupt: s.corrupt === true,
  };
  if (s.embedding !== void 0 && s.embedding !== null) {
    out.embedding = {
      enabled: s.embedding.enabled === true,
      baseUrl: stripUrlCredentials(s.embedding.baseUrl ?? ""),
      model: s.embedding.model ?? "",
      provider: s.embedding.provider ?? "",
      apiKeySet: typeof s.embedding.apiKey === "string" && s.embedding.apiKey.length > 0,
    };
    if (s.embedding.topK !== void 0) out.embedding.topK = s.embedding.topK;
    if (s.embedding.minScore !== void 0) out.embedding.minScore = s.embedding.minScore;
  }
  return out;
}

/** 出参脱敏：剥离 URL 内嵌凭据（http://user:EXAMPLE_PASSWORD@example.com@host 的 username/password），防凭据回显。
 * 非法/相对 URL 原样返回（调用前已有校验，这里只负责不把凭据带出去）。 */
function stripUrlCredentials(url) {
  if (typeof url !== "string" || url.length === 0) return url ?? "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url; // 非绝对 URL：无可解析的 userinfo，原样返回
  }
  if (parsed.username === "" && parsed.password === "") return url;
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

/** 生效嵌入配置出参脱敏：去 apiKey、代以 apiKeySet，并剥离 baseUrl 内嵌凭据
 * （服务器内部「测试连接」仍用未脱敏原值）。 */
function maskEffectiveEmbedding(eff) {
  if (eff === null || typeof eff !== "object") return null;
  const { apiKey, ...rest } = eff;
  return { ...rest, baseUrl: stripUrlCredentials(rest.baseUrl), apiKeySet: typeof apiKey === "string" && apiKey.length > 0 };
}
import { fallbackEntryName, resolveSafeMemoryTarget, sanitizeMemoryName, INDEX_FILENAME } from "./filename.js";
import { extractionFailureSnapshot, extractionObservationSnapshot, injectionSnapshot, recallSnapshot } from "./metrics.js";

export const API_PREFIX = "/dsh-keepsake/api/";
const MAX_IMPORT_BODY_BYTES = 2 * 1024 * 1024; // 导入 2MB
const MAX_PERSONA_BODY_BYTES = 100 * 1024; // 人设 100KB
const MAX_DEFAULT_BODY_BYTES = 64 * 1024; // 其余写端点 64KB
const MAX_ENTRY_CONTENT_CHARS = 20000; // 条目正文上限（与导入同口径，超长显式 413 不静默截）

/** loopback 守卫：仅允许本机（127.0.0.1 / ::1），并校验 Host。 */
export function isLoopbackRequest(req) {
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

export function writeJson(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        // 超限：停止累积并拒绝，由上层写显式 413。
        // 不销毁 socket——销毁后上层再也写不出响应，客户端只会看到连接被重置。
        // 剩余数据继续消费（丢弃），避免 keep-alive 下请求体残留污染下一请求。
        // limitBytes 挂在 error 上：413 文案要带该端点的具体上限（别只说"有大小限制"）。
        chunks.length = 0;
        settle(reject, Object.assign(new Error("payload too large"), { httpStatus: 413, limitBytes }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => settle(resolve, Buffer.concat(chunks).toString("utf8")));
    req.on("error", (error) => settle(reject, error));
  });
}

async function readJson(req, limitBytes) {
  const text = await readBody(req, limitBytes);
  if (text.trim().length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("invalid JSON body");
  }
  return parsed === null ? {} : parsed; // 合法 JSON null 归一为 {}（与空 body 同口径，缺必填字段走 400 而非 500）
}

/** 项目概览（只读）：projects/<slug>-<hash>/memory 条目数与最后更新。 */
function projectOverview(storageRoot) {
  const root = join(storageRoot, "projects");
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of dirs) {
    const memoryDir = join(root, name, "memory");
    let files;
    try {
      files = readdirSync(memoryDir).filter((f) => f.toLowerCase().endsWith(".md"));
    } catch {
      continue;
    }
    let lastMtime = 0;
    for (const file of files) {
      try {
        const m = statSync(join(memoryDir, file)).mtimeMs;
        if (m > lastMtime) lastMtime = m;
      } catch { /* 竞态跳过 */ }
    }
    out.push({ id: name, entries: files.filter((f) => f !== "MEMORY.md").length, lastMtimeMs: lastMtime });
  }
  out.sort((a, b) => b.lastMtimeMs - a.lastMtimeMs);
  return out;
}

/**
 * 导入解析（JSON 结构化逐条 / Markdown 拆条 / Markdown 整段）。
 * 批内同名去重——撞名自动 -2/-3 避让并在 notes 里注明，
 * dryRun 与 confirm 同一判定，written 按最终落盘文件数口径（merged 计数单列）。
 * @returns { ok, errors: [...], notes: [...], plans: [{category, name, title, description, content, action: "add"|"overwrite"|"rename"}] }
 *   action 由目标分类现状 + 批内计划名共同计算（dryRun 预览行：overwrite/rename = 冲突标红）。
 */
export function planImport(storageRoot, { category, format, payload }) {
  const errors = [];
  const notes = [];
  const plans = [];
  if (!isCategoryId(category)) {
    return { ok: false, errors: [`未知分类 "${String(category)}"`], notes, plans };
  }
  // 批内已计划名 + 盘上现状，一次快照（循环内不再反复全量读）
  const plannedNames = new Map();
  const existingNames = new Set(listEntries(storageRoot, category).map((e) => e.name.toLowerCase()));
  const push = (entry) => {
    const rawTitle = typeof entry.title === "string" ? entry.title.trim() : "";
    const name = sanitizeMemoryName(entry.name ?? "")
      ?? sanitizeMemoryName(rawTitle.slice(0, 80))
      ?? fallbackEntryName(rawTitle || String(entry.content ?? "").slice(0, 200)); // 纯中文/纯符号标题：确定性哈希，替代按批次位置命名（防跨批覆盖）
    const nameLower = name.toLowerCase();
    let finalName = name;
    let action = existingNames.has(nameLower) ? "overwrite" : "add";
    if (plannedNames.has(nameLower)) {
      // 批内撞名：自动 -2/-3… 避让（照 uniqueName 配方），预览如实标 rename
      const stem = name.replace(/\.md$/i, "");
      for (let i = 2; i < 100; i += 1) {
        const candidate = `${stem}-${i}.md`;
        if (!plannedNames.has(candidate.toLowerCase()) && !existingNames.has(candidate.toLowerCase())) {
          finalName = candidate;
          break;
        }
      }
      notes.push(`「${String(entry.title ?? name)}」与本批前条同名，已改名 ${finalName}`);
      action = "rename";
    }
    plannedNames.set(finalName.toLowerCase(), plans.length);
    plans.push({
      category,
      name: finalName,
      title: rawTitle.length > 0 ? rawTitle : (name.replace(/\.md$/i, "")),
      description: String(entry.description ?? ""),
      content: String(entry.content ?? ""),
      action,
    });
  };
  if (format === "json") {
    // 结构化逐条：{entries:[{name?,title,description?,content}]} 或直接数组
    const list = Array.isArray(payload) ? payload : Array.isArray(payload?.entries) ? payload.entries : null;
    if (list === null) {
      errors.push("JSON 导入需要 {entries:[...]} 或条目数组");
    } else {
      for (const [index, raw] of list.entries()) {
        if (raw === null || typeof raw !== "object" || typeof raw.content !== "string") {
          errors.push(`第 ${index + 1} 条缺少 content（跳过）`);
          continue;
        }
        if (raw.content.length > 20000) {
          errors.push(`第 ${index + 1} 条 content 超长（跳过）`);
          continue;
        }
        push(raw);
      }
    }
  } else if (format === "markdown-split") {
    // Markdown 拆条：按 ## 二级标题切分（无二级标题则整段一条）
    const text = String(payload?.markdown ?? "");
    const parts = text.split(/^##\s+/m).filter((p) => p.trim().length > 0);
    if (parts.length === 0) errors.push("Markdown 内容为空");
    parts.forEach((part, index) => {
      const lines = part.split("\n");
      let title = lines[0].trim().slice(0, 60);
      let body = part;
      if (parts.length > 1 || text.startsWith("##")) {
        body = lines.slice(1).join("\n").trim();
      } else {
        // 空串 falsy 也要落到兜底（`"" ?? x` 不吃空串的坑）
        const fallback = typeof payload?.title === "string" && payload.title.trim().length > 0 ? payload.title.trim() : "导入条目";
        title = fallback.slice(0, 60);
        body = part.trim();
      }
      if (body.length === 0) {
        errors.push(`第 ${index + 1} 段（${title}）正文为空（跳过）`);
        return;
      }
      // 超长显式报错跳过，不再静默截断
      if (body.length > 20000) {
        errors.push(`第 ${index + 1} 段（${title}）content 超长（跳过）`);
        return;
      }
      push({ title, content: body });
    });
  } else if (format === "markdown-whole") {
    // Markdown 整段：整个文件一条
    const text = String(payload?.markdown ?? "").trim();
    if (text.length === 0) errors.push("Markdown 内容为空");
    else if (text.length > 20000) errors.push("content 超长（跳过）");
    else {
      const fallback = typeof payload?.title === "string" && payload.title.trim().length > 0 ? payload.title.trim() : "导入条目";
      push({ title: fallback.slice(0, 60), content: text });
    }
  } else {
    errors.push(`未知导入格式 "${String(format)}"`);
  }
  return { ok: errors.length === 0, errors, notes, plans };
}

/**
 * 组装全部 API 路由（webServer.register 形态）。
 * deps: {
 *   storageRoot, log, onGlobalWrite()（全局写入后回调：滚动清理触发口）,
 *   extraction?（可选依赖，缺省=无该扩展）: {
 *     triggerRetry() → number（scheduler.retryPending，返回触发会话数）,
 *     inFlight() → bool（提取在途判据，409/观测共用）,
 *     configSummary() → { provider, model, fallback, embeddingProvider, embeddingModel },
 *   }
 *   journal?（可选依赖，缺省=无结算层）: { snapshot() → { runs, unrecovered } }
 *     面板"最近提取记录/未恢复失败区间"的数据源；与 scheduler 记账同源实例。
 *     缺省时 /state 仍恒出空形 { runs: [], unrecovered: [] }——
 *     **字段恒在、缺失=旧版**的双端同形口径照旧（面板 tolerant 消费，见 panel-logic.js）。
 * }
 */
export function makeApiRoutes({ storageRoot, log, onGlobalWrite = () => {}, extraction = null, journal = null }) {
  const routes = [];
  const register = (method, pattern, handler) => {
    routes.push({ method, pattern, handler }); // handler 各自传体积上限
  };

  // ---- v0.4.0 写入安全面：回收站 / 手术式快照（可逆性端点）----
  // 全部走 safety.js 的三道闸（meta 是盘上数据，不信任）；错误带 code 供面板分流。
  const safetyError = (res, error) => {
    const code = error?.code;
    if (code === "TRASH_INVALID" || code === "SNAPSHOT_INVALID") return writeJson(res, 400, { error: String(error?.message ?? error), code });
    if (code === "TRASH_MISSING" || code === "SNAPSHOT_MISSING") return writeJson(res, 404, { error: String(error?.message ?? error), code });
    writeJson(res, 500, { error: "internal error", code: "E_INTERNAL" });
  };

  // GET /trash/list → { entries: [{ id, createdAt, originSessionId, files: [{ name, rootKey, sha1, action }] }] }
  register("GET", "trash/list", async (_req, res) => {
    writeJson(res, 200, { ok: true, entries: listTrash(storageRoot) });
  });
  // POST /trash/restore { id, name? } → { restored: [...], indexReconciled: boolean }
  register("POST", "trash/restore", async (req, res) => {
    const body = await readJson(req, MAX_DEFAULT_BODY_BYTES);
    if (typeof body.id !== "string" || body.id.length === 0) return writeJson(res, 400, { error: "id 必填" });
    // 破坏性端点统一抢提取批互斥锁：并发提取在途时拒绝（409），不踩快照/回收站
    const lock = acquireExtractLock(storageRoot);
    if (!lock.acquired) {
      return writeJson(res, 409, { error: "提取批进行中（互斥锁被占），恢复已中止，请稍候再试", code: "LOCKED" });
    }
    try {
      const name = typeof body.name === "string" ? body.name : void 0;
      // 留底先行：restore 会覆盖的现存目标先建手术快照（action="restore"）；建不起来 = 不动任何数据
      let preSnapshotId = null;
      try {
        preSnapshotId = createPreRestoreSnapshot(storageRoot, "trash", body.id, { name, log });
      } catch (error) {
        log.error(`API 回收站恢复前留底失败 ${body.id}`, error);
        return writeJson(res, 500, { error: "恢复前留底失败，已中止（未改动任何数据）", code: "E_SNAPSHOT" });
      }
      try {
        const out = restoreTrash(storageRoot, body.id, { name, log });
        onGlobalWrite(); // 恢复可能改动记忆目录 → 触发滚动清理
        log.info(`API 回收站恢复：${body.id}（${out.restored.length} 条${preSnapshotId === null ? "" : `，被覆盖旧版留底快照 ${preSnapshotId}`}）`);
        writeJson(res, 200, { ok: true, ...out, ...(preSnapshotId === null ? {} : { preRestoreSnapshotId: preSnapshotId }) });
      } catch (error) {
        const code = error?.code;
        log.error(`API 回收站恢复失败 ${body.id}`, error);
        if (code === "TRASH_INVALID" || code === "TRASH_MISSING") return safetyError(res, error);
        // 如实：失败时不谎称「未丢/已回滚」——被顶掉的旧版已在留底快照里（若建了的话）
        // 500 响应不带内部细节（fs 错误消息内嵌绝对 storageRoot 路径），全错进日志
        return writeJson(res, 500, {
          error: "恢复过程中发生 IO 错误，已中止（详情见服务端日志）",
          code: "E_RESTORE",
          ...(preSnapshotId === null
            ? {}
            : { preRestoreSnapshotId: preSnapshotId, hint: `被覆盖的旧版已留档于手术快照 ${preSnapshotId}（POST snapshots/restore 可找回）` }),
        });
      }
    } finally {
      lock.release();
    }
  });
  // POST /trash/purge { id?, olderThanDays? } → { purged: number }
  register("POST", "trash/purge", async (req, res) => {
    const body = await readJson(req, MAX_DEFAULT_BODY_BYTES);
    // olderThanDays「缺省」（键不存在，或值为 undefined）=全清（与 id 并存时 id 优先）；
    // 一旦【显式给出】（含显式 null）就必须是 ≥0 的有限数——null/负数/Infinity/字符串漏到
    // 下游会被误读成「全清」，显式 400 拒绝。区分「键缺省」与「键存在但值为 null」：
    // 前者是刻意的全清语义，后者是非法入参（否则 {"olderThanDays":null} 会静默清空全部）。
    const ageProvided = Object.prototype.hasOwnProperty.call(body, "olderThanDays") && body.olderThanDays !== void 0;
    if (ageProvided) {
      const days = body.olderThanDays;
      if (typeof days !== "number" || !Number.isFinite(days) || days < 0) {
        return writeJson(res, 400, { error: "olderThanDays 必须为 ≥0 的有限数（缺省为全清）", code: "INVALID" });
      }
    }
    const lock = acquireExtractLock(storageRoot);
    if (!lock.acquired) {
      return writeJson(res, 409, { error: "提取批进行中（互斥锁被占），清除已中止，请稍候再试", code: "LOCKED" });
    }
    try {
      const out = purgeTrash(storageRoot, {
        id: typeof body.id === "string" ? body.id : void 0,
        olderThanDays: body.olderThanDays, // 显式非法值（含 null）已在上面 400 拦下；键缺省=全清
        log,
      });
      log.info(`API 回收站清除：${out.purged} 条`);
      writeJson(res, 200, { ok: true, ...out });
    } catch (error) {
      log.error("API 回收站清除失败", error);
      safetyError(res, error);
    } finally {
      lock.release();
    }
  });
  // GET /snapshots/list → { snapshots: [{ id, createdAt, originSessionId, fileCount, files: [...] }] }
  register("GET", "snapshots/list", async (_req, res) => {
    writeJson(res, 200, { ok: true, snapshots: listSurgicalSnapshots(storageRoot) });
  });
  // POST /snapshots/restore { id, name? } → { restored: [...], indexReconciled: boolean }
  register("POST", "snapshots/restore", async (req, res) => {
    const body = await readJson(req, MAX_DEFAULT_BODY_BYTES);
    if (typeof body.id !== "string" || body.id.length === 0) return writeJson(res, 400, { error: "id 必填" });
    // 破坏性端点统一抢提取批互斥锁（与 trash/restore 同口径）
    const lock = acquireExtractLock(storageRoot);
    if (!lock.acquired) {
      return writeJson(res, 409, { error: "提取批进行中（互斥锁被占），恢复已中止，请稍候再试", code: "LOCKED" });
    }
    try {
      const name = typeof body.name === "string" ? body.name : void 0;
      // 留底先行：restore 会覆盖的现存目标先建手术快照（action="restore"）；建不起来 = 不动任何数据
      let preSnapshotId = null;
      try {
        preSnapshotId = createPreRestoreSnapshot(storageRoot, "snapshot", body.id, { name, log });
      } catch (error) {
        log.error(`API 快照恢复前留底失败 ${body.id}`, error);
        return writeJson(res, 500, { error: "恢复前留底失败，已中止（未改动任何数据）", code: "E_SNAPSHOT" });
      }
      try {
        const out = restoreSurgicalSnapshot(storageRoot, body.id, { name, log });
        onGlobalWrite();
        log.info(`API 快照恢复：${body.id}（${out.restored.length} 条${preSnapshotId === null ? "" : `，被覆盖旧版留底快照 ${preSnapshotId}`}）`);
        writeJson(res, 200, { ok: true, ...out, ...(preSnapshotId === null ? {} : { preRestoreSnapshotId: preSnapshotId }) });
      } catch (error) {
        const code = error?.code;
        log.error(`API 快照恢复失败 ${body.id}`, error);
        if (code === "SNAPSHOT_INVALID" || code === "SNAPSHOT_MISSING") return safetyError(res, error);
        // 500 响应不带内部细节（fs 错误消息内嵌绝对 storageRoot 路径），全错进日志
        return writeJson(res, 500, {
          error: "恢复过程中发生 IO 错误，已中止（详情见服务端日志）",
          code: "E_RESTORE",
          ...(preSnapshotId === null
            ? {}
            : { preRestoreSnapshotId: preSnapshotId, hint: `被覆盖的旧版已留档于手术快照 ${preSnapshotId}（POST snapshots/restore 可找回）` }),
        });
      }
    } finally {
      lock.release();
    }
  });

  // ---- 手动补提节流（真调 LLM 的端点必须有闸；进程内计数，重启即重置——UI 已注明） ----
  const RETRY_MIN_INTERVAL_MS = 10_000;
  let lastManualRetryAt = 0;

  // ---- 轻态（开关+称呼+人设摘要+各区计数+项目概览+提取观测面，不含条目正文） ----
  register("GET", "state", async (_req, res) => {
    const settings = readSettings(storageRoot, log);
    const addressing = readAddressing(storageRoot, log);
    const persona = readPersona(storageRoot, log);
    const counts = {};
    let globalTotal = 0;
    for (const id of CATEGORY_IDS) {
      counts[id] = countEntries(storageRoot, id);
      globalTotal += counts[id];
    }
    const overview = projectOverview(storageRoot); // 同请求只算一遍（30s 轮询放大器）
    const cfgSummary = extraction !== null && typeof extraction.configSummary === "function" ? extraction.configSummary() : null;
    // 近期动态保留天数 / 单次提取超时：面板契约字段（settings 未设时回落 entry config 现值，
    // 再回落到默认 30，保证 /state.recentKeepDays 恒为数字）。
    const recentKeepDays = settings.recentKeepDays ?? cfgSummary?.recentKeepDays ?? RECENT_KEEP_DAYS_DEFAULT;
    const extractionTimeoutMs = cfgSummary?.timeoutMs ?? null;
    // 提取重试次数：面板 retryPollWindowMs 消费此契约字段（此前 /state 从不产出=死契约）。
    const extractionRetryAttempts = cfgSummary?.retryAttempts ?? null;
    // 生效嵌入端点：settings 覆盖优先于 entry config（脱敏出参，baseUrl 未配置给空串）。
    const effEmb = cfgSummary?.embeddingEffective ?? null;
    writeJson(res, 200, {
      ok: true,
      version: 1,
      settings: settingsForClient(settings, cfgSummary?.recentKeepDays),
      corrupt: settings.corrupt,
      recentKeepDays,
      extractionTimeoutMs,
      extractionRetryAttempts,
      addressingCorrupt: addressing.corrupt === true,
      personaCorrupt: persona.corrupt === true,
      extractionFailures: extractionFailureSnapshot(), // 提取失败观测面（面板 tolerant 消费）
      injection: injectionSnapshot(), // 注入面（消息通道注入健康；服务端恒在，缺失=旧版）
      recall: recallSnapshot(), // 召回面（嵌入语义召回命中/空/异常；服务端恒在，缺失=旧版）
      ...extractionObservationSnapshot(), // lastFailedRange/extractionInFlight/lastAttemptAt/lastUsedRoute
      storageRoot, // 失败日志路径展示用
      extractionLog: journal !== null && typeof journal.snapshot === "function"
        ? journal.snapshot()
        : { runs: [], unrecovered: [], abandoned: [], abandonedCount: 0 }, // 恒在：无 journal（旧宿主/未接线）也给空形，字段缺失才代表旧版
      // 存储格式面：formatVersion 为数据目录标记版本；writable=false 表示数据由更新版插件
      // 写入、本版本已锁定只读（写端点 503），升级插件后恢复。
      format: (() => {
        const st = readFormatState(storageRoot, log);
        const version = st.formatVersion ?? FORMAT_VERSION;
        return { formatVersion: version, supported: st.supported, writable: st.supported, corrupt: st.corrupt === true };
      })(),
      extractionConfig: cfgSummary === null
        ? { provider: null, model: null, fallback: [] }
        : { provider: cfgSummary.provider ?? null, model: cfgSummary.model ?? null, fallback: cfgSummary.fallback ?? [] },
      // 嵌入召回配置（provider/model 可缺省；baseUrl=生效端点 URL，未配置给空串）。
      // 不回显任何 apiKey（脱敏出参口径）。
      embeddingConfig: {
        provider: cfgSummary?.embeddingProvider ?? null,
        model: cfgSummary?.embeddingModel ?? null,
        baseUrl: typeof effEmb?.baseUrl === "string" ? stripUrlCredentials(effEmb.baseUrl) : "",
      },
      injectChannel: cfgSummary === null ? null : cfgSummary.injectChannel ?? null, // 召回只经消息通道投递，面板据此提示
      embeddingEffective: cfgSummary === null ? null : maskEffectiveEmbedding(cfgSummary.embeddingEffective), // 生效嵌入配置（脱敏；settings 优先于 entry config）
      addressing,
      // v0.4.0 写入安全面（十字段：盘上三项现算 + 进程内七项计数）
      safety: {
        ...safetyDiskState(storageRoot), // surgicalBackups / lastSnapshotAt / trashPending（盘上真值）
        ...safetyCounterSnapshot(), // verifyFailed / hardfactDrops / hardfactBlocks / expectedSha1Mismatches / blindWriteDowngrades / lockConflicts（+ snapshotFailures）
      },
      persona: { isDefault: persona.isDefault, excerpt: persona.content.slice(0, 100), chars: persona.content.length },
      counts: { global: globalTotal, byCategory: counts, projects: overview.length },
      projects: overview,
    });
  });

  // ---- 手动补提（复用 scheduler 单飞，禁并行旁路） ----
  register("POST", "extract/retry", async (_req, res) => {
    if (extraction === null || typeof extraction.triggerRetry !== "function") {
      writeJson(res, 404, { error: "extract retry unavailable (old build)" });
      return;
    }
    if (extraction.inFlight()) {
      writeJson(res, 409, { error: "已有提取在进行中，请稍候再试" });
      return;
    }
    const since = Date.now() - lastManualRetryAt;
    if (lastManualRetryAt !== 0 && since < RETRY_MIN_INTERVAL_MS) {
      writeJson(res, 409, { error: `手动重试间隔过短（${Math.ceil((RETRY_MIN_INTERVAL_MS - since) / 1000)}s 后可再试；重启插件会重置计时）` });
      return;
    }
    const triggered = extraction.triggerRetry();
    lastManualRetryAt = Date.now();
    log.info(`API 手动补提触发：${triggered} 个会话有待补提区间（202 Accepted，结果经 /state 观测）`);
    writeJson(res, 202, { ok: true, triggered });
  });

  // ---- 开关 + 嵌入服务配置 ----
  register("PUT", "settings", async (req, res) => {
    const body = await readJson(req, MAX_DEFAULT_BODY_BYTES);
    // 三个数值项严格校验：非法值显式 400（不静默改默认；与 writeSettings 的宽容读侧分层）。
    for (const key of ["trashKeepDays", "surgicalKeep", "recentKeepDays"]) {
      const check = validateSettingsNumber(key, body?.[key]);
      if (!check.ok) return writeJson(res, 400, { error: check.error, message: check.error, code: "E_SETTINGS" });
    }
    let next;
    try {
      // 密钥回填兜底：密钥来自 entry config 而 settings.json 尚无 embedding 覆盖时，
      // 「重存不带 apiKey = 保留已存密钥」保的应是**生效**密钥——把 config 的 key 接管进
      // settings；否则新写入的 settings.embedding.apiKey:"" 会遮蔽 YAML 里配置的密钥。
      const eff = extraction !== null && typeof extraction.configSummary === "function" ? extraction.configSummary()?.embeddingEffective ?? null : null;
      next = writeSettings(storageRoot, body, log, { fallbackApiKey: typeof eff?.apiKey === "string" ? eff.apiKey : "" }); // 含 embedding 校验（非法即抛）
    } catch (error) {
      // settings 校验错误去掉内部前缀（dsh-keepsake: ），给人话 message（保留 code/error 机读字段）
      const raw = String(error?.message ?? error);
      const human = raw.replace(/^dsh-keepsake:\s*/, "");
      return writeJson(res, 400, { error: raw, message: human, code: "E_SETTINGS" }); // 校验错 → 显式 400，不落 500
    }
    log.info(`API 写 settings：开关=(${next.conversationMemory},${next.projectMemory},${next.globalExtraction}) embedding=${next.embedding ? (next.embedding.enabled ? "on" : "off") : "未设"}`);
    writeJson(res, 200, { ok: true, settings: settingsForClient(next) });
  });

  // ---- 嵌入服务连通性测试（面板「测试连接」；真发一次嵌入请求，短超时） ----
  register("POST", "embedding/test", async (req, res) => {
    const body = await readJson(req, MAX_DEFAULT_BODY_BYTES);
    const eff = extraction !== null && typeof extraction.configSummary === "function" ? extraction.configSummary()?.embeddingEffective ?? null : null;
    const pick = (v, fallback) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : fallback);
    const baseUrl = pick(body?.baseUrl, eff?.baseUrl ?? "");
    const model = pick(body?.model, eff?.model ?? "");
    // 已存密钥只发往它所属的端点：仅当最终 baseUrl 与生效端点一致时，才回退用 eff.apiKey；
    // 否则只用请求体自带的 key（未给则不带 key），杜绝把已存密钥随任意地址外发。
    const apiKey = (typeof body?.apiKey === "string" && body.apiKey.length > 0)
      ? body.apiKey
      : (baseUrl === (eff?.baseUrl ?? "") ? (eff?.apiKey ?? "") : "");
    if (baseUrl === "" || model === "") return writeJson(res, 400, { error: "需要嵌入端点 URL 与模型名" });
    try {
      const u = new URL(baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
    } catch {
      return writeJson(res, 400, { error: "嵌入端点必须是绝对 http(s) URL" });
    }
    try {
      const vectors = await embedTexts({ baseUrl, model, apiKey: apiKey || void 0, texts: ["ping"], timeoutMs: Math.min(eff?.timeoutMs ?? 8000, 15000) });
      writeJson(res, 200, { ok: true, dim: Array.isArray(vectors[0]) ? vectors[0].length : 0 });
    } catch (error) {
      writeJson(res, 200, { ok: false, error: String(error?.message ?? error) }); // 测试失败=结果本身，不抛 500
    }
  });

  // ---- 人设 ----
  register("GET", "persona", async (_req, res) => {
    const persona = readPersona(storageRoot, log);
    writeJson(res, 200, { ok: true, content: persona.content, isDefault: persona.isDefault, corrupt: persona.corrupt === true, defaultTemplate: DEFAULT_PERSONA });
  });
  register("PUT", "persona", async (req, res) => {
    const body = await readJson(req, MAX_PERSONA_BODY_BYTES);
    if (typeof body.content !== "string") return writeJson(res, 400, { error: "content 必须是字符串" });
    // 体积上限由 readJson(req, MAX_PERSONA_BODY_BYTES) 把关（超限 → 413）。
    writePersona(storageRoot, body.content, log);
    onGlobalWrite();
    log.info("API 写 persona");
    writeJson(res, 200, { ok: true });
  });
  register("POST", "persona/reset", async (_req, res) => {
    const backupId = createBackup(storageRoot, "persona-reset"); // 重置前自动全量留档
    resetPersona(storageRoot);
    onGlobalWrite();
    log.info(`API 重置 persona 为出厂模板（备份 ${backupId}）`);
    writeJson(res, 200, { ok: true, backupId, content: readPersona(storageRoot, log).content });
  });

  // ---- 称呼 ----
  register("GET", "addressing", async (_req, res) => {
    writeJson(res, 200, { ok: true, ...readAddressing(storageRoot, log) });
  });
  register("PUT", "addressing", async (req, res) => {
    const body = await readJson(req, MAX_DEFAULT_BODY_BYTES);
    const next = writeAddressing(storageRoot, body, log);
    log.info(`API 写 addressing：dshName=${next.dshName ? "有" : "空"} userAlias=${next.userAlias ? "有" : "空"}`);
    writeJson(res, 200, { ok: true, ...next });
  });

  // ---- 分类条目 ----
  register("GET", "category/:id", async (_req, res, { id }) => {
    if (!isCategoryId(id)) return writeJson(res, 404, { error: `未知分类 "${id}"` });
    writeJson(res, 200, { ok: true, category: id, entries: listEntries(storageRoot, id) });
  });
  register("POST", "category/:id/entries", async (req, res, { id }) => {
    if (!isCategoryId(id)) return writeJson(res, 404, { error: `未知分类 "${id}"` });
    const body = await readJson(req, MAX_DEFAULT_BODY_BYTES);
    if (typeof body.content !== "string" || body.content.trim().length === 0) {
      return writeJson(res, 400, { error: "content 必填且非空" });
    }
    if (body.content.length > MAX_ENTRY_CONTENT_CHARS) {
      return writeJson(res, 413, { error: `content 超过 ${MAX_ENTRY_CONTENT_CHARS} 字符上限` }); // 显式拒绝不静默截
    }
    const created = createEntry(storageRoot, id, {
      title: typeof body.title === "string" && body.title.trim().length > 0 ? body.title.trim() : "未命名条目",
      description: typeof body.description === "string" ? body.description : "",
      content: body.content,
      name: typeof body.name === "string" ? body.name : void 0,
    });
    if (created === null) return writeJson(res, 400, { error: "name 非法（嵌套路径或保留名）" }); // 统一拒绝语义
    onGlobalWrite();
    log.info(`API 新增条目：${id}/${created.name}`);
    writeJson(res, 200, { ok: true, ...created });
  });
  register("PUT", "entry", async (req, res) => {
    const body = await readJson(req, MAX_DEFAULT_BODY_BYTES);
    if (!isCategoryId(body.category) || typeof body.name !== "string") {
      return writeJson(res, 400, { error: "category 与 name 必填" });
    }
    if (typeof body.content === "string" && body.content.length > MAX_ENTRY_CONTENT_CHARS) {
      return writeJson(res, 413, { error: `content 超过 ${MAX_ENTRY_CONTENT_CHARS} 字符上限` }); // 显式拒绝不静默截
    }
    // ---- 手动保存前留档（v0.4.0 安全面）：覆盖既有条目前先建手术快照，可逆性兜底 ----
    // 与提取落盘 / 恢复端点共用 extract.lock 批锁：面板保存与自动提取批互斥——否则
    // 快照目录互踩、滚动清理双跑误删在用快照、保存会静默顶掉提取批刚写入的内容且无留档。
    // 条目存在才留档（owner=panel）；纯新增条目不建快照（无旧文可失），交由 updateEntry
    // 返回 null → 404（原逻辑不变）。留档失败 fail-closed：拒绝本次修改，旧文一字未动。
    const lock = acquireExtractLock(storageRoot);
    if (!lock.acquired) {
      return writeJson(res, 409, { error: "提取批进行中（互斥锁被占），保存已中止，请稍候再试", code: "LOCKED" });
    }
    try {
      const existed = readEntry(storageRoot, body.category, body.name);
      let preSaveSnapshotId = null;
      if (existed !== null) {
        const catDir = categoryDir(storageRoot, body.category);
        let snapshot;
        try {
          snapshot = createSurgicalSnapshot(storageRoot, {
            originSessionId: "panel",
            ops: [{ name: body.name, rootKey: rootKeyOf(storageRoot, catDir), action: "overwrite", target: resolveSafeMemoryTarget(catDir, body.name) }],
          });
        } catch (error) {
          log.error(`API 改条目保存前留档失败，已拒绝本次修改（旧文未动）：${body.category}/${body.name}`, error);
          return writeJson(res, 503, { error: "保存前留档失败，已拒绝本次修改（旧文未动）", code: "E_SNAPSHOT_PRESAVE" });
        }
        // 留档零文件 = 旧文没真留到（快照器对单条读失败按跳过处理 / 条目在窗口内消失）：
        // 交出空快照继续写等于留档形同虚设，按留档失败 fail-closed 拒绝。
        if (!Array.isArray(snapshot.files) || snapshot.files.length === 0) {
          log.error(`API 改条目保存前留档为空快照，已拒绝本次修改（旧文未动）：${body.category}/${body.name}`);
          return writeJson(res, 503, { error: "保存前留档失败，已拒绝本次修改（旧文未动）", code: "E_SNAPSHOT_PRESAVE" });
        }
        preSaveSnapshotId = snapshot.id;
        // 滚动保留与提取侧全局写路径同口径（keep 取生效设置）；prune 自身不抛，留档已成功不受其影响。
        const safety = resolveSafetySettings(readSettings(storageRoot, log));
        pruneSurgicalSnapshots(storageRoot, safety.surgicalKeep, log);
      }
      const updated = updateEntry(storageRoot, body.category, body.name, {
        title: typeof body.title === "string" ? body.title : void 0,
        description: typeof body.description === "string" ? body.description : void 0,
        content: typeof body.content === "string" ? body.content : void 0,
        toCategoryId: typeof body.toCategory === "string" ? body.toCategory : void 0,
      });
      if (updated === null) return writeJson(res, 404, { error: "条目不存在" });
      onGlobalWrite();
      log.info(`API 改条目：${body.category}/${body.name} → ${updated.categoryId}/${updated.name}${preSaveSnapshotId === null ? "" : `（旧文留档 ${preSaveSnapshotId}）`}`);
      writeJson(res, 200, { ok: true, ...updated, ...(preSaveSnapshotId === null ? {} : { preSaveSnapshotId }) });
    } finally {
      lock.release();
    }
  });
  register("DELETE", "entry", async (req, res) => {
    const body = await readJson(req, MAX_DEFAULT_BODY_BYTES);
    if (!isCategoryId(body.category) || typeof body.name !== "string") {
      return writeJson(res, 400, { error: "category 与 name 必填", message: "category 与 name 必填" });
    }
    // 面板删除走回收站（与提取路径 delete 同口径）：不是硬删——文件移入 trash/<entryId>/，
    // 面板「回收站」可找回，30 天自动清理照旧（见 /trash/list 与 pruneTrash）。
    // 与其它破坏性端点同抢提取批互斥锁：并发提取在途时拒绝（409），不踩回收站。
    const lock = acquireExtractLock(storageRoot);
    if (!lock.acquired) {
      return writeJson(res, 409, { error: "提取批进行中（互斥锁被占），删除已中止，请稍候再试", code: "LOCKED" });
    }
    try {
      const catDir = categoryDir(storageRoot, body.category);
      // 读失败回调：目标【存在但读不出原文】（如同名目录占位 EISDIR）——绝不谎报 "不存在"，
      // 面板据此才会显示真实失败而非"删除成功"。仅本次删除用，不动提取路径的跳过语义。
      let unreadable = null;
      const entry = trashMemoryFile(storageRoot, {
        rootKey: rootKeyOf(storageRoot, catDir),
        name: body.name,
        originSessionId: "panel",
        log,
        now: Date.now(),
        onUnreadable: ({ name, error }) => { unreadable = { name, error }; },
      });
      if (entry === null) {
        if (unreadable !== null) {
          // 存在但读不出：显式失败（409），盘上原样未动（读失败即未进回收站、未删原件）。
          log.warn(`API 删条目：${body.category}/${body.name} 存在但无法读取，未删除`, unreadable.error);
          return writeJson(res, 409, {
            error: "条目存在但无法读取，未删除",
            message: "条目存在但无法读取，未删除",
            code: "E_ENTRY_UNREADABLE",
            existed: true,
            trashed: false,
          });
        }
        log.info(`API 删条目：${body.category}/${body.name}（存在=false，未移入回收站）`);
        return writeJson(res, 200, { ok: true, existed: false, trashed: false });
      }
      // 文件已移出，必须对账分类索引（否则 MEMORY.md 残留悬挂行、被注入进此后每一轮提示词）。
      try {
        reconcileCategoryIndexAfterDelete(storageRoot, body.category, entry.name ?? body.name);
      } catch (error) {
        log.warn(`API 删条目已移入回收站，但分类索引对账失败（悬挂行待下轮重建）: ${entry.name ?? body.name}`, error);
      }
      onGlobalWrite(); // 删到就触发滚动清理（与其它全局写入同口径）
      log.info(`API 删条目：${body.category}/${body.name} → 回收站 ${entry.entryId}（存在=true）`);
      writeJson(res, 200, { ok: true, existed: true, trashed: true, trashId: entry.entryId });
    } finally {
      lock.release();
    }
  });
  register("POST", "category/:id/reset", async (_req, res, { id }) => {
    if (!isCategoryId(id)) return writeJson(res, 404, { error: `未知分类 "${id}"` });
    const backupId = createBackup(storageRoot, `reset:${id}`); // 重置前自动全量留档
    const removed = clearCategory(storageRoot, id);
    onGlobalWrite();
    log.info(`API 重置分类：${id}（清 ${removed} 条，备份 ${backupId}）`);
    writeJson(res, 200, { ok: true, removed, backupId });
  });

  // ---- 导入（dryRun 预览 → confirm 写入；confirm 前自动备份） ----
  register("POST", "import", async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const dryRun = url.searchParams.get("dryRun") === "1";
    const body = await readJson(req, MAX_IMPORT_BODY_BYTES);
    const { ok, errors, notes, plans } = planImport(storageRoot, { category: body.category, format: body.format, payload: body.payload });
    if (dryRun) {
      writeJson(res, 200, { ok, errors, notes, plans, dryRun: true });
      return;
    }
    if (!ok && plans.length === 0) return writeJson(res, 400, { error: errors.join("；") || "无可导入条目" });
    const backupId = createBackup(storageRoot, "import"); // 导入前自动全量留档
    let written = 0;
    let overwritten = 0;
    const failed = [];
    for (const plan of plans) {
      // 单条失败不中断整批（写入结果按条隔离上报）
      try {
        const result = writeEntryDirect(storageRoot, plan.category, {
          name: plan.name,
          title: plan.title,
          description: plan.description,
          content: plan.content,
        });
        if (result === null) failed.push(plan.name);
        else {
          written += 1;
          if (plan.action === "overwrite") overwritten += 1;
        }
      } catch {
        failed.push(plan.name);
      }
    }
    onGlobalWrite();
    const merged = plans.length - written - failed.length;
    log.info(`API 导入确认：${plans.length} 计划（写 ${written} 覆盖 ${overwritten} 改名 ${merged} 失败 ${failed.length}，备份 ${backupId}）`);
    writeJson(res, 200, { ok: failed.length === 0, written, overwritten, merged, failed, errors, notes, backupId });
  });

  // ---- 导出 / 备份 ----
  register("GET", "export", async (_req, res) => {
    writeJson(res, 200, exportAll(storageRoot), {
      "content-disposition": `attachment; filename="dsh-keepsake-export-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  });
  // 单项目导出。id 与 projects/ 真实目录名全字比对
  // （readdir 名单比对替代全量 stat 扫描；readdir 不返回 ".." 保持 containment）。
  register("GET", "project/:id/export", async (_req, res, { id }) => {
    let known = false;
    try {
      known = readdirSync(join(storageRoot, "projects")).includes(id);
    } catch {
      known = false;
    }
    if (!known) return writeJson(res, 404, { error: `未知项目 "${id}"` });
    const memoryDir = join(storageRoot, "projects", id, "memory");
    const entries = [];
    try {
      const files = readdirSync(memoryDir).filter((f) => f.toLowerCase().endsWith(".md") && f !== INDEX_FILENAME);
      for (const f of files) entries.push({ name: f, content: readFileSync(join(memoryDir, f), "utf8") });
    } catch (error) {
      log.error(`API 导出项目 ${id} 读取失败`, error);
      return writeJson(res, 500, { error: "项目记忆不可读", code: "E_READ" }); // 响应不带内部路径
    }
    log.info(`API 导出项目 ${id}：${entries.length} 条`);
    writeJson(res, 200, { ok: true, id, entries });
  });
  register("GET", "backup/list", async (_req, res) => {
    writeJson(res, 200, { ok: true, backups: listBackups(storageRoot) });
  });
  register("POST", "backup/restore", async (req, res) => {
    const body = await readJson(req, MAX_DEFAULT_BODY_BYTES);
    if (typeof body.id !== "string" || body.id.length === 0) return writeJson(res, 400, { error: "id 必填" });
    // id 校验前置到备份之前（无效请求不再白落一份全量备份）
    if (!isSafeBackupId(body.id)) return writeJson(res, 404, { error: "备份不存在" });
    if (!existsSync(join(backupsRoot(storageRoot), body.id))) return writeJson(res, 404, { error: "备份不存在" });
    // 破坏性端点统一抢提取批互斥锁（与 trash/restore、trash/purge、snapshots/restore 同口径）：
    // 并发提取在途时拒绝（409），不整份覆盖 global/projects 踩掉在途写入
    const lock = acquireExtractLock(storageRoot);
    if (!lock.acquired) {
      return writeJson(res, 409, { error: "提取批进行中（互斥锁被占），恢复已中止，请稍候再试", code: "LOCKED" });
    }
    try {
      // 留底先行：恢复前现态先建全量备份。protectId=body.id 让这次留底的滚动清理
      // 豁免「正在恢复的目标本身」——否则份数顶到 BACKUP_KEEP+1 时会淘汰最旧的那份
      // = 恰为旧目标的备份被自毁，restore 随即 BACKUP_MISSING 且目标目录永久消失。
      const preId = createBackup(storageRoot, "pre-restore", { protectId: body.id }); // 后悔药的后悔药
      try {
        restoreBackup(storageRoot, body.id);
      } catch (error) {
        const code = error?.code;
        if (code === "BACKUP_INVALID" || code === "BACKUP_MISSING" || code === "BACKUP_INCOMPLETE") {
          return writeJson(res, 404, { error: String(error.message ?? error), code, preRestoreBackupId: preId });
        }
        // IO 中途失败=500（状态码语义分对），带 preId 自救指路。
        // 500 响应不带内部细节（fs 错误消息内嵌绝对 storageRoot 路径），全错进日志。
        log.error(`API 恢复备份 ${body.id} 失败`, error);
        return writeJson(res, 500, { error: "恢复过程中发生 IO 错误，已中止（详情见服务端日志）", code: "E_RESTORE", preRestoreBackupId: preId, hint: `操作前现态已留档于备份目录 backups/${preId}（可用 POST backup/restore 恢复该备份）` });
      }
      onGlobalWrite();
      log.info(`API 从备份恢复：${body.id}（恢复前现态已备份 ${preId}）`);
      writeJson(res, 200, { ok: true, restored: body.id, preRestoreBackupId: preId });
    } finally {
      lock.release();
    }
  });

  // ---- 总入口：method+pattern 匹配（category/:id 与 project/:id/export 参数化解） ----
  const matchCategory = (sub) => {
    const m = sub.match(/^category\/([a-z-]+)(\/entries|\/reset)?$/);
    if (m === null) return null;
    return { id: m[1], suffix: m[2] ?? "" };
  };
  const matchProjectExport = (sub) => {
    const m = sub.match(/^project\/([a-z0-9._-]+)\/export$/);
    return m === null ? null : { id: m[1] };
  };

  const handler = async (req, res) => {
    const started = Date.now();
    try {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: "loopback requests only" });
        return;
      }
      const url = new URL(req.url, "http://localhost");
      const sub = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, "");
      let route = null;
      let params = {};
      let pathMatched = false; // 路径可识别但方法不匹配 → 405（与面板 405 语义统一）
      const SUFFIX_BY_PATTERN = {
        "category/:id": "",
        "category/:id/entries": "/entries",
        "category/:id/reset": "/reset",
      };
      const cat = matchCategory(sub);
      const proj = matchProjectExport(sub);
      const pathMatches = (candidate) => {
        if (candidate.pattern === "project/:id/export") return proj !== null;
        if (candidate.pattern.includes(":id")) return cat !== null && SUFFIX_BY_PATTERN[candidate.pattern] === cat.suffix;
        return candidate.pattern === sub;
      };
      for (const candidate of routes) {
        if (!pathMatches(candidate)) continue;
        pathMatched = true;
        if (candidate.method !== req.method) continue;
        route = candidate;
        params = candidate.pattern === "project/:id/export" ? proj : candidate.pattern.includes(":id") ? cat : {};
        break;
      }
      if (route === null) {
        if (pathMatched) {
          writeJson(res, 405, { error: `方法 ${req.method} 不支持`, code: "E_METHOD" });
          return;
        }
        writeJson(res, 404, { error: `未知端点 ${req.method} ${url.pathname}` });
        return;
      }
      // 存储格式只读保护：数据由更新版插件写入时，拒绝一切写端点（GET 只读放行）。
      if (req.method !== "GET") {
        try {
          assertWritable(storageRoot, log);
        } catch (error) {
          log.warn(`写端点 ${req.method} /${sub} 被只读保护拒绝（存储格式过新）`);
          writeJson(res, 503, {
            error: "format-too-new",
            code: error?.code ?? "FORMAT_TOO_NEW",
            message: "数据由更高版本写入，已转只读，升级插件后恢复",
          });
          return;
        }
      }
      await route.handler(req, res, params);
      log.info(`API ${req.method} /${sub} → 完成（${Date.now() - started}ms）`);
    } catch (error) {
      const message = String(error?.message ?? error);
      log.error(`API ${req.method} ${req.url} 异常`, error);
      if (!res.headersSent) {
        // 500 响应不带内部细节（fs 错误消息内嵌绝对路径），全错进日志
        if (message === "payload too large") {
          const limit = Number.isFinite(error?.limitBytes) ? `（上限 ${Math.round(error.limitBytes / 1024)} KB）` : "";
          writeJson(res, 413, { error: "请求体超过上限", message: `请求体超过上限${limit}`, code: "E_PAYLOAD_TOO_LARGE" });
        } else if (message === "invalid JSON body") {
          writeJson(res, 400, { error: message, message: "请求体不是合法 JSON" });
        } else {
          writeJson(res, 500, { error: "internal error", message: "服务端内部错误（详情见服务端日志）", code: "E_INTERNAL" });
        }
      }
    }
  };

  return [{ kind: "prefix", path: API_PREFIX.replace(/\/$/, ""), handler }];
  // 注：内核 prefix 语义 = pathname === prefix || pathname.startsWith(prefix + "/")
  //（dsh-host-webserver match() 实证），注册 path 带尾斜杠会拼成双斜杠永不匹配。
}

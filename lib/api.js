// dsh-memory REST API 面（方案C §5 + R6/R7）。
//   全部 handler 先过 loopback 守卫（照抄 qudao 现役同款，纵深第二层；
//   dsh-app 反代鉴权是第一层），再过方法白名单与 JSON body 体积上限
//   （导入 2MB / 人设 100KB 分级）。错误显式：结构化 JSON error + 日志。
//   写操作全部经 global-store 三道闸 + 原子写；索引文件永不被写端点触碰。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CATEGORY_IDS,
  backupsRoot,
  clearCategory,
  countEntries,
  createBackup,
  createEntry,
  deleteEntry,
  exportAll,
  isCategoryId,
  isSafeBackupId,
  listBackups,
  listEntries,
  readAddressing,
  readPersona,
  restoreBackup,
  updateEntry,
  writeAddressing,
  writeEntryDirect,
  writePersona,
  resetPersona,
  DEFAULT_PERSONA,
} from "./global-store.js";
import { readSettings, writeSettings } from "./settings.js";
import { sanitizeMemoryName, INDEX_FILENAME } from "./filename.js";
import { extractionFailureSnapshot, extractionObservationSnapshot, injectionSnapshot } from "./metrics.js";

export const API_PREFIX = "/dsh-memory/api/";
const MAX_IMPORT_BODY_BYTES = 2 * 1024 * 1024; // 导入 2MB（R7 分级上限）
const MAX_PERSONA_BODY_BYTES = 100 * 1024; // 人设 100KB
const MAX_DEFAULT_BODY_BYTES = 64 * 1024; // 其余写端点 64KB
const MAX_ENTRY_CONTENT_CHARS = 20000; // 条目正文上限（与导入同口径，超长显式 413 不静默截）

/** loopback 守卫（照抄 another-plugin lib/index.js isLoopbackRequest，逐行同款）。 */
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
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        settled = true;
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function readJson(req, limitBytes) {
  const text = await readBody(req, limitBytes);
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid JSON body");
  }
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
 * 全面审查 IMP-1（P1）：批内同名去重——撞名自动 -2/-3 避让并在 notes 里注明，
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
  // 批内已计划名（IMP-1）+ 盘上现状，一次快照（L-2：循环内不再反复全量读）
  const plannedNames = new Map();
  const existingNames = new Set(listEntries(storageRoot, category).map((e) => e.name.toLowerCase()));
  const push = (entry) => {
    const rawTitle = typeof entry.title === "string" ? entry.title.trim() : "";
    const name = sanitizeMemoryName(entry.name ?? "") ?? sanitizeMemoryName(rawTitle.slice(0, 80)) ?? `entry-${plans.length + 1}.md`;
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
        // 全面审查 L-3：空串 falsy 也要落到兜底（`"" ?? x` 不吃空串的坑）
        const fallback = typeof payload?.title === "string" && payload.title.trim().length > 0 ? payload.title.trim() : "导入条目";
        title = fallback.slice(0, 60);
        body = part.trim();
      }
      if (body.length === 0) {
        errors.push(`第 ${index + 1} 段（${title}）正文为空（跳过）`);
        return;
      }
      // 全面审查 U-TRU1（导入侧口径统一）：超长显式报错跳过，不再静默截断
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
 *   extraction?（批F2 可选依赖，缺省=旧契约零字段）: {
 *     triggerRetry() → number（scheduler.retryPending，返回触发会话数）,
 *     inFlight() → bool（提取在途判据，409/观测共用）,
 *     configSummary() → { provider, model, fallback, embeddingProvider, embeddingModel },
 *   }
 * }
 */
export function makeApiRoutes({ storageRoot, log, onGlobalWrite = () => {}, extraction = null }) {
  const routes = [];
  const register = (method, pattern, handler) => {
    routes.push({ method, pattern, handler }); // 全面审查 P3：bodyLimit 死元数据删除（handler 各自传限）
  };

  // ---- 手动补提节流（批F2 V-6：真调 LLM 的端点必须有闸；进程内计数，重启即重置——UI 已注明） ----
  const RETRY_MIN_INTERVAL_MS = 10_000;
  let lastManualRetryAt = 0;

  // ---- 轻态（R6：开关+称呼+人设摘要+各区计数+项目概览+提取观测面，不含条目正文） ----
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
    const overview = projectOverview(storageRoot); // 全面审查 P3-2：同请求只算一遍（30s 轮询放大器）
    const cfgSummary = extraction !== null && typeof extraction.configSummary === "function" ? extraction.configSummary() : null;
    writeJson(res, 200, {
      ok: true,
      version: 1,
      settings: {
        conversationMemory: settings.conversationMemory,
        projectMemory: settings.projectMemory,
        globalExtraction: settings.globalExtraction,
      },
      corrupt: settings.corrupt,
      addressingCorrupt: addressing.corrupt === true,
      personaCorrupt: persona.corrupt === true,
      extractionFailures: extractionFailureSnapshot(), // P-PIPE1 可观测面（面板 tolerant 消费）
      injection: injectionSnapshot(), // 批次A：注入面（消息通道注入健康；服务端恒在，缺失=旧版）
      ...extractionObservationSnapshot(), // 批F2：lastFailedRange/extractionInFlight/lastAttemptAt/lastUsedRoute
      storageRoot, // 批F2 V-10：失败日志路径展示用
      extractionConfig: cfgSummary === null
        ? { provider: null, model: null, fallback: [] }
        : { provider: cfgSummary.provider ?? null, model: cfgSummary.model ?? null, fallback: cfgSummary.fallback ?? [] },
      embeddingConfig: cfgSummary === null || cfgSummary.embeddingProvider === void 0
        ? { provider: null, model: null }
        : { provider: cfgSummary.embeddingProvider, model: cfgSummary.embeddingModel }, // U7：语义召回预留位
      addressing,
      persona: { isDefault: persona.isDefault, excerpt: persona.content.slice(0, 100), chars: persona.content.length },
      counts: { global: globalTotal, byCategory: counts, projects: overview.length },
      projects: overview,
    });
  });

  // ---- 手动补提（批F2 V-1：复用 scheduler 单飞，禁并行旁路） ----
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

  // ---- 开关 ----
  register("PUT", "settings", async (req, res) => {
    const body = await readJson(req, MAX_DEFAULT_BODY_BYTES);
    const next = writeSettings(storageRoot, body, log);
    log.info(`API 写 settings：${JSON.stringify(next)}`);
    writeJson(res, 200, { ok: true, settings: next });
  });

  // ---- 人设 ----
  register("GET", "persona", async (_req, res) => {
    const persona = readPersona(storageRoot, log);
    writeJson(res, 200, { ok: true, content: persona.content, isDefault: persona.isDefault, corrupt: persona.corrupt === true, defaultTemplate: DEFAULT_PERSONA });
  });
  register("PUT", "persona", async (req, res) => {
    const body = await readJson(req, MAX_PERSONA_BODY_BYTES);
    if (typeof body.content !== "string") return writeJson(res, 400, { error: "content 必须是字符串" });
    if (body.content.length > MAX_PERSONA_BODY_BYTES) return writeJson(res, 413, { error: "persona 超过 100KB 上限" });
    writePersona(storageRoot, body.content, log);
    onGlobalWrite();
    log.info("API 写 persona");
    writeJson(res, 200, { ok: true });
  });
  register("POST", "persona/reset", async (_req, res) => {
    const backupId = createBackup(storageRoot, "persona-reset"); // 重置前自动全量留档（方案C §5 备份对）
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
      return writeJson(res, 413, { error: `content 超过 ${MAX_ENTRY_CONTENT_CHARS} 字符上限` }); // 全面审查 U-TRU1：显式拒绝不静默截
    }
    const created = createEntry(storageRoot, id, {
      title: typeof body.title === "string" && body.title.trim().length > 0 ? body.title.trim() : "未命名条目",
      description: typeof body.description === "string" ? body.description : "",
      content: body.content,
      name: typeof body.name === "string" ? body.name : void 0,
    });
    if (created === null) return writeJson(res, 400, { error: "name 非法（嵌套路径或保留名）" }); // P3-8：统一拒绝语义
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
      return writeJson(res, 413, { error: `content 超过 ${MAX_ENTRY_CONTENT_CHARS} 字符上限` }); // 全面审查 U-TRU1
    }
    const updated = updateEntry(storageRoot, body.category, body.name, {
      title: typeof body.title === "string" ? body.title : void 0,
      description: typeof body.description === "string" ? body.description : void 0,
      content: typeof body.content === "string" ? body.content : void 0,
      toCategoryId: typeof body.toCategory === "string" ? body.toCategory : void 0,
    });
    if (updated === null) return writeJson(res, 404, { error: "条目不存在" });
    onGlobalWrite();
    log.info(`API 改条目：${body.category}/${body.name} → ${updated.categoryId}/${updated.name}`);
    writeJson(res, 200, { ok: true, ...updated });
  });
  register("DELETE", "entry", async (req, res) => {
    const body = await readJson(req, MAX_DEFAULT_BODY_BYTES);
    if (!isCategoryId(body.category) || typeof body.name !== "string") {
      return writeJson(res, 400, { error: "category 与 name 必填" });
    }
    const existed = deleteEntry(storageRoot, body.category, body.name);
    if (existed) onGlobalWrite(); // 全面审查 P3：没删到不白跑滚动清理全扫
    log.info(`API 删条目：${body.category}/${body.name}（存在=${existed}）`);
    writeJson(res, 200, { ok: true, existed });
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
      // 全面审查 H-OPS1 同族纪律：单条失败不中断整批（写入结果按条隔离上报）
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
      "content-disposition": `attachment; filename="dsh-memory-export-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  });
  // 单项目导出（方案C §6 附行；审查 P2 补齐）。id 与 projects/ 真实目录名全字比对
  // （全面审查 P3：readdir 名单比对替代全量 stat 扫描；readdir 不返回 ".." 保持 containment）。
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
      return writeJson(res, 500, { error: "项目记忆不可读", code: "E_READ" }); // 全面审查 P3：响应不带内部路径
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
    // 全面审查 H-BAK1：id 校验前置到备份之前（无效请求不再白落一份全量备份）
    if (!isSafeBackupId(body.id)) return writeJson(res, 404, { error: "备份不存在" });
    if (!existsSync(join(backupsRoot(storageRoot), body.id))) return writeJson(res, 404, { error: "备份不存在" });
    const preId = createBackup(storageRoot, "pre-restore"); // 后悔药的后悔药
    try {
      restoreBackup(storageRoot, body.id);
    } catch (error) {
      const code = error?.code;
      if (code === "BACKUP_INVALID" || code === "BACKUP_MISSING" || code === "BACKUP_INCOMPLETE") {
        return writeJson(res, 404, { error: String(error.message ?? error), code, preRestoreBackupId: preId });
      }
      // 全面审查 H-RES1：IO 中途失败=500（状态码语义分对），带 preId 自救指路
      log.error(`API 恢复备份 ${body.id} 失败`, error);
      return writeJson(res, 500, { error: String(error.message ?? error), code: "E_RESTORE", preRestoreBackupId: preId, hint: "现态未丢或已回滚，可用 preRestoreBackupId 恢复到操作前" });
    }
    onGlobalWrite();
    log.info(`API 从备份恢复：${body.id}（恢复前现态已备份 ${preId}）`);
    writeJson(res, 200, { ok: true, restored: body.id, preRestoreBackupId: preId });
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
      let pathMatched = false; // 路径可识别但方法不匹配 → 405（全面审查 P3-7：与面板 405 语义统一）
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
      await route.handler(req, res, params);
      log.info(`API ${req.method} /${sub} → 完成（${Date.now() - started}ms）`);
    } catch (error) {
      const message = String(error?.message ?? error);
      log.error(`API ${req.method} ${req.url} 异常`, error);
      if (!res.headersSent) {
        // 全面审查 P3：500 响应不带内部细节（fs 错误消息内嵌绝对路径），全错进日志
        const status = message === "payload too large" ? 413 : message === "invalid JSON body" ? 400 : 500;
        writeJson(res, status, { error: status === 500 ? "internal error" : message, code: status === 500 ? "E_INTERNAL" : void 0 });
      }
    }
  };

  return [{ kind: "prefix", path: API_PREFIX.replace(/\/$/, ""), handler }];
  // 注：内核 prefix 语义 = pathname === prefix || pathname.startsWith(prefix + "/")
  //（dsh-host-webserver match() 实证），注册 path 带尾斜杠会拼成双斜杠永不匹配。
}

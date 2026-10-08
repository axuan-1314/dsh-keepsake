// dsh-memory REST API 面（方案C §5 + R6/R7）。
//   全部 handler 先过 loopback 守卫（照抄 qudao 现役同款，纵深第二层；
//   dsh-app 反代鉴权是第一层），再过方法白名单与 JSON body 体积上限
//   （导入 2MB / 人设 100KB 分级）。错误显式：结构化 JSON error + 日志。
//   写操作全部经 global-store 三道闸 + 原子写；索引文件永不被写端点触碰。
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CATEGORY_IDS,
  clearCategory,
  countEntries,
  createBackup,
  createEntry,
  deleteEntry,
  exportAll,
  isCategoryId,
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
import { sanitizeMemoryName } from "./filename.js";

export const API_PREFIX = "/dsh-memory/api/";
const MAX_IMPORT_BODY_BYTES = 2 * 1024 * 1024; // 导入 2MB（R7 分级上限）
const MAX_PERSONA_BODY_BYTES = 100 * 1024; // 人设 100KB
const MAX_DEFAULT_BODY_BYTES = 64 * 1024; // 其余写端点 64KB

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
 * @returns { ok, errors: [...], plans: [{category, name, title, description, content, action: "add"|"overwrite"}] }
 *   action 由目标分类现状计算（dryRun 预览行：overwrite = 冲突标红）。
 */
export function planImport(storageRoot, { category, format, payload }) {
  const errors = [];
  const plans = [];
  if (!isCategoryId(category)) {
    return { ok: false, errors: [`未知分类 "${String(category)}"`], plans };
  }
  const push = (entry) => {
    const name = sanitizeMemoryName(entry.name ?? "") ?? sanitizeMemoryName(String(entry.title ?? "").slice(0, 80)) ?? `entry-${plans.length + 1}.md`;
    const existing = listEntries(storageRoot, category).some((e) => e.name.toLowerCase() === name.toLowerCase());
    plans.push({
      category,
      name,
      title: String(entry.title ?? name.replace(/\.md$/i, "")),
      description: String(entry.description ?? ""),
      content: String(entry.content ?? ""),
      action: existing ? "overwrite" : "add",
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
        title = String(payload?.title ?? "导入条目").slice(0, 60);
        body = part.trim();
      }
      if (body.length === 0) {
        errors.push(`第 ${index + 1} 段（${title}）正文为空（跳过）`);
        return;
      }
      push({ title, content: body.slice(0, 20000) });
    });
  } else if (format === "markdown-whole") {
    // Markdown 整段：整个文件一条
    const text = String(payload?.markdown ?? "").trim();
    if (text.length === 0) errors.push("Markdown 内容为空");
    else push({ title: String(payload?.title ?? "导入条目").slice(0, 60), content: text.slice(0, 20000) });
  } else {
    errors.push(`未知导入格式 "${String(format)}"`);
  }
  return { ok: errors.length === 0, errors, plans };
}

/**
 * 组装全部 API 路由（webServer.register 形态）。
 * deps: { storageRoot, log, onGlobalWrite()（全局写入后回调：滚动清理触发口） }
 */
export function makeApiRoutes({ storageRoot, log, onGlobalWrite = () => {} }) {
  const routes = [];
  const register = (method, pattern, handler, bodyLimit = MAX_DEFAULT_BODY_BYTES) => {
    routes.push({ method, pattern, handler, bodyLimit });
  };

  // ---- 轻态（R6：开关+称呼+人设摘要+各区计数+项目概览，不含条目正文） ----
  register("GET", "state", async (_req, res) => {
    const settings = readSettings(storageRoot, log);
    const addressing = readAddressing(storageRoot);
    const persona = readPersona(storageRoot);
    const counts = {};
    let globalTotal = 0;
    for (const id of CATEGORY_IDS) {
      counts[id] = countEntries(storageRoot, id);
      globalTotal += counts[id];
    }
    writeJson(res, 200, {
      ok: true,
      version: 1,
      settings: {
        conversationMemory: settings.conversationMemory,
        projectMemory: settings.projectMemory,
        globalExtraction: settings.globalExtraction,
      },
      corrupt: settings.corrupt,
      addressing,
      persona: { isDefault: persona.isDefault, excerpt: persona.content.slice(0, 100), chars: persona.content.length },
      counts: { global: globalTotal, byCategory: counts, projects: projectOverview(storageRoot).length },
      projects: projectOverview(storageRoot),
    });
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
    const persona = readPersona(storageRoot);
    writeJson(res, 200, { ok: true, content: persona.content, isDefault: persona.isDefault, defaultTemplate: DEFAULT_PERSONA });
  });
  register("PUT", "persona", async (req, res) => {
    const body = await readJson(req, MAX_PERSONA_BODY_BYTES);
    if (typeof body.content !== "string") return writeJson(res, 400, { error: "content 必须是字符串" });
    if (body.content.length > MAX_PERSONA_BODY_BYTES) return writeJson(res, 413, { error: "persona 超过 100KB 上限" });
    writePersona(storageRoot, body.content);
    onGlobalWrite();
    log.info("API 写 persona");
    writeJson(res, 200, { ok: true });
  });
  register("POST", "persona/reset", async (_req, res) => {
    resetPersona(storageRoot);
    onGlobalWrite();
    log.info("API 重置 persona 为出厂模板");
    writeJson(res, 200, { ok: true, content: readPersona(storageRoot).content });
  });

  // ---- 称呼 ----
  register("GET", "addressing", async (_req, res) => {
    writeJson(res, 200, { ok: true, ...readAddressing(storageRoot) });
  });
  register("PUT", "addressing", async (req, res) => {
    const body = await readJson(req, MAX_DEFAULT_BODY_BYTES);
    const next = writeAddressing(storageRoot, body);
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
    const created = createEntry(storageRoot, id, {
      title: typeof body.title === "string" && body.title.trim().length > 0 ? body.title.trim() : "未命名条目",
      description: typeof body.description === "string" ? body.description : "",
      content: body.content.slice(0, 20000),
      name: typeof body.name === "string" ? body.name : void 0,
    });
    onGlobalWrite();
    log.info(`API 新增条目：${id}/${created.name}`);
    writeJson(res, 200, { ok: true, ...created });
  });
  register("PUT", "entry", async (req, res) => {
    const body = await readJson(req, MAX_DEFAULT_BODY_BYTES);
    if (!isCategoryId(body.category) || typeof body.name !== "string") {
      return writeJson(res, 400, { error: "category 与 name 必填" });
    }
    const updated = updateEntry(storageRoot, body.category, body.name, {
      title: typeof body.title === "string" ? body.title : void 0,
      description: typeof body.description === "string" ? body.description : void 0,
      content: typeof body.content === "string" ? body.content.slice(0, 20000) : void 0,
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
    onGlobalWrite();
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
    const { ok, errors, plans } = planImport(storageRoot, { category: body.category, format: body.format, payload: body.payload });
    if (dryRun) {
      writeJson(res, 200, { ok, errors, plans, dryRun: true });
      return;
    }
    if (!ok && plans.length === 0) return writeJson(res, 400, { error: errors.join("；") || "无可导入条目" });
    const backupId = createBackup(storageRoot, "import"); // 导入前自动全量留档
    let written = 0;
    let overwritten = 0;
    const failed = [];
    for (const plan of plans) {
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
    }
    onGlobalWrite();
    log.info(`API 导入确认：${plans.length} 计划（写 ${written} 覆盖 ${overwritten} 失败 ${failed.length}，备份 ${backupId}）`);
    writeJson(res, 200, { ok: failed.length === 0, written, overwritten, failed, errors, backupId });
  });

  // ---- 导出 / 备份 ----
  register("GET", "export", async (_req, res) => {
    writeJson(res, 200, exportAll(storageRoot), {
      "content-disposition": `attachment; filename="dsh-memory-export-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  });
  register("GET", "backup/list", async (_req, res) => {
    writeJson(res, 200, { ok: true, backups: listBackups(storageRoot) });
  });
  register("POST", "backup/restore", async (req, res) => {
    const body = await readJson(req, MAX_DEFAULT_BODY_BYTES);
    if (typeof body.id !== "string" || body.id.length === 0) return writeJson(res, 400, { error: "id 必填" });
    const preId = createBackup(storageRoot, "pre-restore"); // 后悔药的后悔药
    try {
      restoreBackup(storageRoot, body.id);
    } catch (error) {
      return writeJson(res, 404, { error: String(error.message ?? error) });
    }
    onGlobalWrite();
    log.info(`API 从备份恢复：${body.id}（恢复前现态已备份 ${preId}）`);
    writeJson(res, 200, { ok: true, restored: body.id, preRestoreBackupId: preId });
  });

  // ---- 总入口：method+pattern 匹配（category/:id 参数化解） ----
  const matchCategory = (sub) => {
    const m = sub.match(/^category\/([a-z-]+)(\/entries|\/reset)?$/);
    if (m === null) return null;
    return { id: m[1], suffix: m[2] ?? "" };
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
      const SUFFIX_BY_PATTERN = {
        "category/:id": "",
        "category/:id/entries": "/entries",
        "category/:id/reset": "/reset",
      };
      const cat = matchCategory(sub);
      for (const candidate of routes) {
        if (candidate.method !== req.method) continue;
        if (candidate.pattern.includes(":id")) {
          if (cat !== null && SUFFIX_BY_PATTERN[candidate.pattern] === cat.suffix) {
            route = candidate;
            params = cat;
            break;
          }
        } else if (candidate.pattern === sub) {
          route = candidate;
          params = {};
          break;
        }
      }
      if (route === null) {
        writeJson(res, 404, { error: `未知端点 ${req.method} ${url.pathname}` });
        return;
      }
      await route.handler(req, res, params);
      log.info(`API ${req.method} /${sub} → 完成（${Date.now() - started}ms）`);
    } catch (error) {
      const message = String(error?.message ?? error);
      log.error(`API ${req.method} ${req.url} 异常`, error);
      if (!res.headersSent) {
        writeJson(res, message === "payload too large" ? 413 : message === "invalid JSON body" ? 400 : 500, { error: message });
      }
    }
  };

  return [{ kind: "prefix", path: API_PREFIX.replace(/\/$/, ""), handler }];
  // 注：内核 prefix 语义 = pathname === prefix || pathname.startsWith(prefix + "/")
  //（dsh-host-webserver match() 实证），注册 path 带尾斜杠会拼成双斜杠永不匹配。
}

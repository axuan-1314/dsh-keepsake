// 项目知识页（派生视图）：把项目记忆条目合成 5 页稳定文档。
// 真源仍是项目 memory/ 下的条目文件；pages/ 是派生产物，可删可重建。
// 设计参照 hindsight 的 5 页 taxonomy，但保持本地 markdown、零依赖、单次 LLM 调用。
//
// 目录：<storageRoot>/pages/<projectId>/<page-id>.md + manifest.json
// 注入：pagesSummaryText() 只输出「标题 + 一行摘要 + 页面路径」，全文按需 Read。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { INDEX_FILENAME } from "./filename.js";
import { buildManifestText } from "./manifest.js";
import { redactSensitive } from "./redact.js";

export const PAGES_DIR_NAME = "pages";
export const PAGES_MANIFEST_FILENAME = "manifest.json";
export const PAGES_VERSION = 1;
export const PAGE_MAX_CONTENT_CHARS = 6000;
export const PAGE_MAX_SUMMARY_CHARS = 240;
export const PAGE_MAX_TITLE_CHARS = 80;
export const PAGES_MANIFEST_DESC_CHARS = 120;
export const PAGES_BODY_MAX_CHARS = 20000;
export const PAGES_BODY_FILES = 16;

export const PAGE_DEFS = Object.freeze([
  {
    id: "component-map",
    title: "组件地图",
    description: "项目由哪些模块 / 目录 / 服务组成，各自负责什么。",
    hint: "列出主干模块与关键文件路径；只写有记忆依据的组件。",
  },
  {
    id: "core-concepts",
    title: "核心概念",
    description: "领域术语、架构不变量、理解项目必须知道的背景。",
    hint: "解释概念之间的关系；保留原文中的术语与缩写。",
  },
  {
    id: "conventions",
    title: "约定与模式",
    description: "代码风格、工作流、测试、发布、协作的稳定约定。",
    hint: "区分「必须遵守」与「只是偏好」；引用来源条目。",
  },
  {
    id: "key-decisions",
    title: "关键决策",
    description: "已经确定的重要决策与理由、状态、替代方案。",
    hint: "有日期就写日期；有未决问题就标「待定」，不要补造理由。",
  },
  {
    id: "initiatives",
    title: "进行中事项",
    description: "当前在做的任务、下一步、风险与待确认事项。",
    hint: "按时间与状态整理；过时的事项标「已收口」或省略。",
  },
]);

const PAGE_BY_ID = new Map(PAGE_DEFS.map((page) => [page.id, page]));
const PAGE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const PROJECT_ID_RE = /^[a-z0-9._-]+-[a-f0-9]{16}$/;

export function isValidProjectId(projectId) {
  return typeof projectId === "string" && PROJECT_ID_RE.test(projectId);
}

export function pagesDir(storageRoot, projectId) {
  if (!isValidProjectId(projectId)) throw new Error(`dsh-keepsake: 非法 projectId "${String(projectId)}"`);
  return join(storageRoot, PAGES_DIR_NAME, projectId);
}

function clampCodePoints(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return Array.from(value).slice(0, max - 1).join("") + "…";
}

/** 标题/摘要进注入行：压成单行并去掉会破坏 markdown 链接的方括号。 */
function oneLine(text, max) {
  return clampCodePoints(String(text ?? "").replace(/\s+/g, " ").replace(/[[\]]/g, "").trim(), max);
}

function escapeYamlDouble(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ").trim();
}

function stripFrontmatter(text) {
  return String(text ?? "").replace(/^---\s*[\r\n][\s\S]*?[\r\n]---\s*[\r\n]?/, "").trim();
}

/** 项目 MEMORY.md 的轻量指纹（用于提示「记忆已变、知识页可能过期」）。 */
export function indexStampOf(memoryDir) {
  try {
    const stat = statSync(join(memoryDir, INDEX_FILENAME));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "";
  }
}

/** 条目内容指纹：用于 manifest.sourceHash（生成时写入，供面板/后续对账）。 */
export function pagesSourceHash({ manifest, bodies }) {
  return createHash("sha256").update(`${manifest ?? ""}\n\n${bodies ?? ""}`, "utf8").digest("hex").slice(0, 16);
}

/**
 * 收集生成知识页的输入：manifest 全量（最多 200 行，压成 type/name/description）
 * + 最近正文（最多 16 个、每个 1200 字符、总计 ≤20000 字符）。
 * 知识页不写 op，故 manifest 不需要 sha1/时间戳——砍掉这两段可把 186 条的 prompt
 * 从约 3.6 万字符压到约 1.8 万；正文按「最新优先」截断，避免一次生成吃掉过多 token。
 * 先脱敏再进 prompt（与提取路径同口径；旧条目里的密钥不会被新页面复制出去）。
 */
export function collectPageSources(memoryDir, { bodyFiles = PAGES_BODY_FILES, maxBodyChars = 1200 } = {}) {
  const { manifest, bodies } = buildManifestText(memoryDir, {
    maxFiles: 200,
    bodyFiles,
    maxBodyChars,
  });
  const compactManifest = String(manifest ?? "")
    .split("\n")
    .map((line) => {
      const matched = line.match(/^- \[([^\]]+)\] ([^ ]+) \((?:[^)]*)\): (.*)$/);
      if (matched === null) return line;
      const [, type, name, description] = matched;
      return `- [${type}] ${name}: ${clampCodePoints(description, PAGES_MANIFEST_DESC_CHARS)}`;
    })
    .join("\n");
  const clippedBodies = clipBodies(bodies, PAGES_BODY_MAX_CHARS);
  return {
    manifest: redactSensitive(compactManifest),
    bodies: redactSensitive(clippedBodies),
  };
}

/** 正文按块（`--- name ---` 分隔）保留最新若干块，总量封顶；截断时留可见标记。 */
function clipBodies(bodies, maxChars) {
  const text = String(bodies ?? "");
  if (text.length <= maxChars) return text;
  const blocks = text.split(/\n\n(?=--- )/);
  const kept = [];
  let total = 0;
  for (const block of blocks) {
    if (total + block.length > maxChars) break;
    kept.push(block);
    total += block.length + 2;
  }
  return kept.length === 0
    ? text.slice(0, maxChars)
    : `${kept.join("\n\n")}\n\n[…] older entry bodies clipped for prompt budget`;
}

/**
 * 生成 prompt：五页定义 + 记忆现状 + 输出契约。
 * 页面只是派生视图，prompt 明确要求「不发明、引用 [[条目名]]、保留硬事实」。
 */
export function buildPagesPayload({ projectId, manifest, bodies, existing = null }) {
  const definitions = PAGE_DEFS.map((page) => `- ${page.id}（${page.title}）：${page.description} ${page.hint}`).join("\n");
  const existingText = existing === null
    ? "(none — first generation)"
    : existing.pages.map((page) => `- ${page.id}: ${page.title} — ${page.summary}`).join("\n");
  const system = [
    "You are the project knowledge-page compiler for dsh-keepsake.",
    "Synthesize five stable project pages from the project memory entries. The entries remain the source of truth; these pages are a derived, compact view.",
    "",
    "Pages:",
    definitions,
    "",
    "Rules:",
    "- Only use facts present in the provided manifest and entry bodies. Do not invent modules, decisions, dates or reasons.",
    "- Cite source entries with [[entry-name]] using the exact name from the manifest.",
    "- Keep code, paths, versions, numbers and identifiers verbatim.",
    "- Write in the language of the source entries (Chinese if they are Chinese).",
    "- Each page content <= 4000 characters; summary <= 160 characters; title <= 60 characters.",
    "- If a page has too little material, write a short '暂无足够材料' note instead of guessing.",
    "- Do not include frontmatter; output only the page body markdown.",
    "",
    "Output contract (strict): reply with ONE JSON object and nothing else:",
    '{"pages":[{"id":"component-map","title":"...","summary":"one-line hook","content":"markdown body"}]}',
    "All five ids must be present exactly once: component-map, core-concepts, conventions, key-decisions, initiatives.",
  ].join("\n");
  const user = [
    `Project: ${projectId}`,
    "",
    "Current project memory manifest:",
    manifest || "(empty)",
    "",
    "Recent entry bodies (most recent first):",
    bodies || "(none)",
    "",
    "Existing page summaries (for continuity; rewrite freely if stale):",
    existingText,
    "",
    "Synthesize the five pages now. Reply per the output contract.",
  ].join("\n");
  return { system, user };
}

/** 宽松解析：容忍 markdown fence / 前后缀；五个 id 必须齐全。 */
export function parsePagesOutput(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0) throw new Error("dsh-keepsake: 知识页输出为空");
  let payload = trimmed;
  const fenced = payload.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) payload = fenced[1];
  const start = payload.indexOf("{");
  const end = payload.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("dsh-keepsake: 知识页输出中未找到 JSON 对象");
  const parsed = JSON.parse(payload.slice(start, end + 1));
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.pages)) {
    throw new Error("dsh-keepsake: 知识页输出缺少 pages 数组");
  }
  const byId = new Map();
  for (const raw of parsed.pages) {
    if (raw === null || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!PAGE_BY_ID.has(id) || byId.has(id)) continue;
    const content = stripFrontmatter(typeof raw.content === "string" ? raw.content : "");
    if (content.length === 0) continue;
    const definition = PAGE_BY_ID.get(id);
    const title = oneLine(typeof raw.title === "string" && raw.title.trim().length > 0 ? raw.title : definition.title, PAGE_MAX_TITLE_CHARS);
    const summary = oneLine(
      typeof raw.summary === "string" && raw.summary.trim().length > 0
        ? raw.summary
        : content.replace(/\s+/g, " ").trim(),
      PAGE_MAX_SUMMARY_CHARS,
    );
    byId.set(id, {
      id,
      title,
      summary,
      content: clampCodePoints(content, PAGE_MAX_CONTENT_CHARS),
    });
  }
  const missing = PAGE_DEFS.filter((page) => !byId.has(page.id)).map((page) => page.id);
  if (missing.length > 0) throw new Error(`dsh-keepsake: 知识页输出缺少页面：${missing.join(", ")}`);
  return PAGE_DEFS.map((page) => byId.get(page.id));
}

/** 读 manifest：宽容解析；未知 page id / 非法文件名不信任，只返回合法页。 */
export function readPagesManifest(storageRoot, projectId) {
  if (!isValidProjectId(projectId)) return null;
  const path = join(pagesDir(storageRoot, projectId), PAGES_MANIFEST_FILENAME);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || parsed.version !== PAGES_VERSION) return null;
  if (!Array.isArray(parsed.pages)) return null;
  const pages = [];
  for (const raw of parsed.pages) {
    if (raw === null || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!PAGE_ID_RE.test(id) || !PAGE_BY_ID.has(id)) continue;
    const title = oneLine(typeof raw.title === "string" ? raw.title : id, PAGE_MAX_TITLE_CHARS);
    const summary = oneLine(typeof raw.summary === "string" ? raw.summary : "", PAGE_MAX_SUMMARY_CHARS);
    pages.push({ id, title, summary, chars: Number.isFinite(raw.chars) ? raw.chars : 0 });
  }
  if (pages.length === 0) return null;
  return {
    version: PAGES_VERSION,
    projectId,
    generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
    sourceHash: typeof parsed.sourceHash === "string" ? parsed.sourceHash : "",
    indexStamp: typeof parsed.indexStamp === "string" ? parsed.indexStamp : "",
    model: typeof parsed.model === "string" ? parsed.model : "",
    pages,
  };
}

/** 读单页正文（缺失返回 null；文件路径由 id 推导，不信任 manifest 里的路径）。 */
export function readPageText(storageRoot, projectId, pageId) {
  if (!isValidProjectId(projectId) || !PAGE_BY_ID.has(pageId)) return null;
  try {
    return readFileSync(join(pagesDir(storageRoot, projectId), `${pageId}.md`), "utf8");
  } catch {
    return null;
  }
}

/** 读全部页面（manifest + 正文）；缺失的页跳过，如实返回。 */
export function readPages(storageRoot, projectId) {
  const manifest = readPagesManifest(storageRoot, projectId);
  if (manifest === null) return null;
  const pages = manifest.pages
    .map((page) => ({ ...page, content: readPageText(storageRoot, projectId, page.id) }))
    .filter((page) => typeof page.content === "string");
  if (pages.length === 0) return null;
  return { ...manifest, pages };
}

function renderPageFile({ page, projectId, generatedAt }) {
  const description = escapeYamlDouble(page.summary);
  return [
    "---",
    `name: "page-${page.id}"`,
    `description: "${description}"`,
    "metadata:",
    '  type: "reference"',
    'node_type: "page"',
    `generatedAt: "${escapeYamlDouble(generatedAt)}"`,
    `scope: "projects/${projectId}"`,
    "---",
    "",
    "<!-- AUTO-GENERATED by dsh-keepsake pages; edit entries, not this file. -->",
    "",
    `# ${page.title}`,
    "",
    page.content.trim(),
    "",
  ].join("\n");
}

function atomicWrite(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, path);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* 留给清理 */ }
    throw error;
  }
}

/**
 * 落盘 5 页 + manifest。先写页文件、最后写 manifest；manifest 是「这批页可用」的提交点。
 * 返回 manifest；任何一页写失败都抛错（不写 manifest，旧 manifest 仍在）。
 */
export function writePages(storageRoot, projectId, pages, { generatedAt, sourceHash, indexStamp = "", model = "", log = {} } = {}) {
  if (!isValidProjectId(projectId)) throw new Error("dsh-keepsake: 非法 projectId");
  const list = Array.isArray(pages) ? pages : [];
  if (list.length !== PAGE_DEFS.length) throw new Error(`dsh-keepsake: 知识页数量必须为 ${PAGE_DEFS.length}`);
  for (const page of list) {
    if (!PAGE_BY_ID.has(page.id)) throw new Error(`dsh-keepsake: 未知知识页 id "${page.id}"`);
  }
  const dir = pagesDir(storageRoot, projectId);
  mkdirSync(dir, { recursive: true });
  const writtenAt = typeof generatedAt === "string" && generatedAt.length > 0 ? generatedAt : new Date().toISOString();
  for (const page of list) {
    atomicWrite(join(dir, `${page.id}.md`), renderPageFile({ page, projectId, generatedAt: writtenAt }));
  }
  const manifest = {
    version: PAGES_VERSION,
    projectId,
    generatedAt: writtenAt,
    sourceHash: typeof sourceHash === "string" ? sourceHash : "",
    indexStamp: typeof indexStamp === "string" ? indexStamp : "",
    model: typeof model === "string" ? model : "",
    pages: list.map((page) => ({
      id: page.id,
      title: page.title,
      summary: page.summary,
      chars: page.content.length,
    })),
  };
  atomicWrite(join(dir, PAGES_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);
  if (typeof log.info === "function") log.info(`知识页已写入 ${projectId}（${list.length} 页）`);
  return manifest;
}

/**
 * 注入用摘要：标题 + 一行钩子 + 页面路径；不注入全文（模型按需 Read）。
 * 记忆索引变了会附一行 stale 提示（不改页面、不自动重生成）。
 * 同一次读 manifest 产出 full/compact 两份（compact 去掉「N 字」提示行）。
 */
export function pagesSummaryTexts(storageRoot, projectId) {
  if (!isValidProjectId(projectId)) return { full: "", compact: "" };
  const manifest = readPagesManifest(storageRoot, projectId);
  if (manifest === null) return { full: "", compact: "" };
  const dir = pagesDir(storageRoot, projectId);
  const current = indexStampOf(join(storageRoot, "projects", projectId, "memory"));
  const stale = manifest.indexStamp.length > 0 && current.length > 0 && current !== manifest.indexStamp;
  const head = [`## Project knowledge pages (generated ${manifest.generatedAt})`];
  if (stale) head.push("[stale: project memory changed since generation; rerun 生成知识页]");
  head.push("Synthesized from project memories; the entries remain the source of truth. Read a page when its topic matters.", "");
  const full = [...head];
  const compact = [...head];
  for (const page of manifest.pages) {
    const pagePath = join(dir, `${page.id}.md`).replace(/\\/g, "/");
    const line = `- [${page.title}](${pagePath})${page.summary ? ` — ${page.summary}` : ""}`;
    full.push(line);
    compact.push(line);
    if (page.chars > 0) full.push(`  - ${page.chars} 字；完整正文见上列路径`);
  }
  return { full: full.join("\n"), compact: compact.join("\n") };
}

export function pagesSummaryText(storageRoot, projectId, { compact = false } = {}) {
  const texts = pagesSummaryTexts(storageRoot, projectId);
  return compact ? texts.compact : texts.full;
}

function pageError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== void 0) error.cause = cause;
  return error;
}

/**
 * 生成一整套知识页（编排层；LLM 调用由调用方注入，便于测试与复用路由）。
 * 任何失败都不写 manifest（旧页面继续可用），错误码供 API 分流。
 * @param {{storageRoot: string, projectId: string, callLlm: (payload: {system: string, user: string}) => Promise<{text: string}>, model?: string, log?: object}} input
 */
export async function generatePages({ storageRoot, projectId, callLlm, model = "", log = {} }) {
  if (!isValidProjectId(projectId)) throw pageError("E_INVALID_PROJECT", `非法 projectId "${String(projectId)}"`);
  if (typeof callLlm !== "function") throw pageError("E_NO_LLM", "缺少 LLM 调用器");
  const memoryDir = join(storageRoot, "projects", projectId, "memory");
  if (!existsSync(memoryDir)) throw pageError("E_PROJECT_NOT_FOUND", `项目记忆不存在：${projectId}`);
  const { manifest, bodies } = collectPageSources(memoryDir);
  if (manifest.trim().length === 0) throw pageError("E_EMPTY", "项目记忆为空，暂无可生成的知识页");
  const existing = readPagesManifest(storageRoot, projectId);
  const { system, user } = buildPagesPayload({ projectId, manifest, bodies, existing });
  let text;
  try {
    const result = await callLlm({ system, user });
    text = typeof result === "string" ? result : result?.text;
  } catch (error) {
    const wrapped = pageError("E_LLM", `知识页生成调用失败：${String(error?.message ?? error)}`, error);
    recordPagesError({ scope: `projects/${projectId}`, error: wrapped.message });
    throw wrapped;
  }
  let pages;
  try {
    pages = parsePagesOutput(text);
  } catch (error) {
    const wrapped = pageError("E_PARSE", String(error?.message ?? error), error);
    recordPagesError({ scope: `projects/${projectId}`, error: wrapped.message });
    throw wrapped;
  }
  const safePages = pages.map((page) => ({
    ...page,
    title: redactSensitive(page.title),
    summary: redactSensitive(page.summary),
    content: redactSensitive(page.content),
  }));
  try {
    const manifestOut = writePages(storageRoot, projectId, safePages, {
      generatedAt: new Date().toISOString(),
      sourceHash: pagesSourceHash({ manifest, bodies }),
      indexStamp: indexStampOf(memoryDir),
      model,
      log,
    });
    recordPagesGeneration({
      scope: `projects/${projectId}`,
      chars: safePages.reduce((total, page) => total + page.content.length, 0),
    });
    return { manifest: manifestOut, pages: safePages };
  } catch (error) {
    const wrapped = pageError("E_WRITE", `知识页落盘失败：${String(error?.message ?? error)}`, error);
    recordPagesError({ scope: `projects/${projectId}`, error: wrapped.message });
    throw wrapped;
  }
}

/** 页面生成失败/成功的轻量观测（进程内；面板通过 /state.pages 消费）。 */
const pagesState = {
  generations: 0,
  errors: 0,
  lastAt: null,
  lastError: null,
  lastScope: null,
  lastChars: 0,
};

export function recordPagesGeneration({ scope = "", chars = 0 } = {}) {
  pagesState.generations += 1;
  pagesState.lastAt = Date.now();
  pagesState.lastError = null;
  pagesState.lastScope = scope;
  pagesState.lastChars = Number.isFinite(chars) && chars > 0 ? Math.floor(chars) : 0;
}

export function recordPagesError({ scope = "", error = "" } = {}) {
  pagesState.errors += 1;
  pagesState.lastAt = Date.now();
  pagesState.lastError = String(error ?? "").slice(0, 300);
  pagesState.lastScope = scope;
}

export function pagesSnapshot() {
  return { ...pagesState };
}

export function __resetPagesStateForTest() {
  pagesState.generations = 0;
  pagesState.errors = 0;
  pagesState.lastAt = null;
  pagesState.lastError = null;
  pagesState.lastScope = null;
  pagesState.lastChars = 0;
}

// 记忆检索（search）：跨全局分类 + 项目条目的关键词检索，供 /memory 命令与面板复用。
//
// 定位：这是"按名字/描述/正文找条目"的字面检索，不是语义召回
//   （embedding.js 那条线是「按当前对话语义找相关记忆」，两者受众不同：
//   召回喂给模型，本模块喂给人——用户/模型主动问"我记得的那条叫什么"）。
//
// 打分口径（有意简单、可解释，不做 tf-idf）：
//   名字完全相等 100 > 名字包含 60 > 标题包含 45 > 描述包含 30 > 正文包含 15。
//   多关键词 AND 语义：每个关键词都要在「名字+标题+描述+正文」的全文中命中，
//   单关键词可只命中名字。多个关键词命中时按最高权重累加。
//   这样"pnpm 铁律"能同时命中名字含 pnpm、正文含铁律的条目，而不会被
//   "只命中 pnpm"的条目淹没。
//
// 边界：纯函数 + 只读 IO，不写任何东西；不加载正文以外的派生视图（pages/）。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CATEGORY_IDS, categoryDir, stripFrontmatter } from "./global-store.js";
import { parseFrontmatterHead } from "./manifest.js";
import { INDEX_FILENAME } from "./filename.js";

export const SEARCH_MAX_RESULTS = 20;
export const SEARCH_SNIPPET_CHARS = 200;
export const SEARCH_SCAN_MAX_FILES = 2000;

const WEIGHT = { nameExact: 100, nameContains: 60, title: 45, description: 30, body: 15 };

function lower(value) {
  return String(value ?? "").toLowerCase();
}

/** 关键词切分：空白分隔，去掉过短（<1）与纯符号词；原序保留（供 AND 判定去重）。 */
export function splitQuery(query) {
  const raw = typeof query === "string" ? query : "";
  const parts = raw.split(/\s+/).map((p) => p.trim()).filter((p) => p.length > 0);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const key = lower(part);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out.slice(0, 8); // 关键词过多只会让 AND 全落空；8 个是实用上限
}

/**
 * 单条目打分。
 * @returns {{score:number, hits:string[]}|null} 任一关键词都未命中 → null
 */
export function scoreEntry({ name, title, description, body }, terms) {
  if (!Array.isArray(terms) || terms.length === 0) return null;
  const nameL = lower(name).replace(/\.md$/i, "");
  const titleL = lower(title);
  const descL = lower(description);
  const bodyL = lower(body);
  let score = 0;
  const hits = [];
  for (const term of terms) {
    const t = lower(term);
    if (t.length === 0) continue;
    let best = 0;
    let where = "";
    if (nameL === t) {
      best = WEIGHT.nameExact;
      where = "name";
    } else if (nameL.includes(t)) {
      best = WEIGHT.nameContains;
      where = "name";
    } else if (titleL.includes(t)) {
      best = WEIGHT.title;
      where = "title";
    } else if (descL.includes(t)) {
      best = WEIGHT.description;
      where = "description";
    } else if (bodyL.includes(t)) {
      best = WEIGHT.body;
      where = "body";
    }
    if (best === 0) return null; // AND：任一关键词全无命中 → 本条不入选
    score += best;
    hits.push(where);
  }
  return { score, hits };
}

/** 从正文里取命中关键词附近的片段（正文无命中时取开头）。 */
export function snippetOf(body, terms, max = SEARCH_SNIPPET_CHARS) {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (text.length === 0) return "";
  const bodyL = lower(text);
  let at = -1;
  for (const term of Array.isArray(terms) ? terms : []) {
    const idx = bodyL.indexOf(lower(term));
    if (idx >= 0 && (at < 0 || idx < at)) at = idx;
  }
  if (at < 0) at = 0;
  // 命中点前后各留一段，避免片段从词中间开始
  const start = Math.max(0, at - Math.floor(max / 4));
  const slice = text.slice(start, start + max);
  return (start > 0 ? "…" : "") + slice + (start + max < text.length ? "…" : "");
}

function readEntryFile(fullPath, relName) {
  let raw;
  try {
    raw = readFileSync(fullPath, "utf8");
  } catch {
    return null;
  }
  const front = parseFrontmatterHead(raw);
  return {
    name: relName,
    title: front.title ?? front.name ?? relName.replace(/\.md$/i, ""),
    description: front.description ?? "",
    type: front.type ?? "",
    body: stripFrontmatter(raw),
  };
}

function walkMarkdown(root, base = "", out = []) {
  if (out.length >= SEARCH_SCAN_MAX_FILES) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= SEARCH_SCAN_MAX_FILES) break;
    const rel = base.length > 0 ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // 派生/留档目录不进检索：pages 是派生视图，backups/trash/snapshots 不是真源
      if (entry.name === "pages" || entry.name === "backups" || entry.name === "trash"
        || entry.name === "snapshots" || entry.name === "runtime" || entry.name === "surgical") continue;
      walkMarkdown(join(root, entry.name), rel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.md$/i.test(entry.name)) continue;
    if (entry.name === INDEX_FILENAME) continue; // 索引不是条目，正文重复且无 frontmatter
    out.push(rel);
  }
  return out;
}

/**
 * 跨范围检索。
 *
 * @param {string} storageRoot
 * @param {string} query 关键词串（空白分隔）
 * @param {{
 *   projectMemoryDir?: string, projectId?: string,
 *   limit?: number, includeGlobal?: boolean, includeProject?: boolean
 * }} [options]
 * @returns {{
 *   query: string, terms: string[], total: number, truncated: boolean,
 *   results: Array<{scope:string, name:string, title:string, description:string,
 *     type:string, score:number, hits:string[], snippet:string}>
 * }}
 */
export function searchMemory(storageRoot, query, {
  projectMemoryDir = "",
  projectId = "",
  limit = SEARCH_MAX_RESULTS,
  includeGlobal = true,
  includeProject = true,
} = {}) {
  const terms = splitQuery(query);
  const empty = { query: String(query ?? ""), terms, total: 0, truncated: false, results: [] };
  if (terms.length === 0) return empty;
  if (typeof storageRoot !== "string" || storageRoot.length === 0) return empty;

  const candidates = [];
  if (includeGlobal) {
    for (const categoryId of CATEGORY_IDS) {
      const dir = categoryDir(storageRoot, categoryId);
      if (!existsSync(dir)) continue;
      for (const rel of walkMarkdown(dir)) {
        const entry = readEntryFile(join(dir, rel), rel);
        if (entry !== null) candidates.push({ ...entry, scope: `global:${categoryId}`, category: categoryId });
      }
    }
  }
  if (includeProject && typeof projectMemoryDir === "string" && projectMemoryDir.length > 0
    && existsSync(projectMemoryDir)) {
    for (const rel of walkMarkdown(projectMemoryDir)) {
      const entry = readEntryFile(join(projectMemoryDir, rel), rel);
      if (entry !== null) candidates.push({ ...entry, scope: "project", category: "project", projectId });
    }
  }

  const scored = [];
  for (const candidate of candidates) {
    const result = scoreEntry(candidate, terms);
    if (result === null) continue;
    scored.push({ candidate, score: result.score, hits: result.hits });
  }
  scored.sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name));

  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SEARCH_MAX_RESULTS;
  const picked = scored.slice(0, cap);
  return {
    query: String(query ?? ""),
    terms,
    total: scored.length,
    truncated: scored.length > picked.length,
    results: picked.map(({ candidate, score, hits }) => ({
      scope: candidate.scope,
      category: candidate.category,
      projectId: candidate.projectId ?? "",
      name: candidate.name,
      title: candidate.title,
      description: candidate.description,
      type: candidate.type,
      score,
      hits,
      snippet: snippetOf(candidate.body, terms),
    })),
  };
}

/**
 * 列出某范围的条目（/memory 无参数时用：不检索，只给目录）。
 * @returns {{entries:Array<{scope,name,title,description,type}>, total:number, truncated:boolean}}
 */
export function listMemoryEntries(storageRoot, {
  projectMemoryDir = "",
  includeGlobal = true,
  includeProject = true,
  limit = SEARCH_MAX_RESULTS,
} = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SEARCH_MAX_RESULTS;
  const rows = [];
  const push = (dir, scopeOf, categoryOf) => {
    if (!existsSync(dir)) return;
    for (const rel of walkMarkdown(dir)) {
      if (rows.length > cap) return;
      const entry = readEntryFile(join(dir, rel), rel);
      if (entry === null) continue;
      rows.push({
        scope: scopeOf,
        category: categoryOf,
        name: entry.name,
        title: entry.title,
        description: entry.description,
        type: entry.type,
        mtimeMs: (() => {
          try {
            return statSync(join(dir, rel)).mtimeMs;
          } catch {
            return 0;
          }
        })(),
      });
    }
  };
  if (includeGlobal) {
    for (const categoryId of CATEGORY_IDS) push(categoryDir(storageRoot, categoryId), `global:${categoryId}`, categoryId);
  }
  if (includeProject && projectMemoryDir.length > 0) push(projectMemoryDir, "project", "project");
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { entries: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
}

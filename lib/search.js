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

/** 检索折叠：NFKC 统一全角/兼容字符，并合成 NFD 组合字符，再转小写。
 *  正文与查询必须同口径折叠——否则「正文写 ＰＮＰＭ、用户查 pnpm」会 0 命中，
 *  而用户看不出为什么（字面检索的唯一承诺就是「打出来就找得到」）。 */
function foldText(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase();
}

/** 关键词切分：空白分隔，去掉过短（<1）与纯符号词；原序保留（供 AND 判定去重）。 */
export function splitQuery(query) {
  const raw = typeof query === "string" ? query : "";
  const parts = raw.split(/\s+/).map((p) => p.trim()).filter((p) => p.length > 0);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const key = foldText(part);
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
  const nameL = foldText(name).replace(/\.md$/i, "");
  const titleL = foldText(title);
  const descL = foldText(description);
  const bodyL = foldText(body);
  let score = 0;
  const hits = [];
  for (const term of terms) {
    const t = foldText(term);
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

/** 字素切分器：用 Intl.Segmenter 取真正的 grapheme cluster。
 *  正则 `\P{M}\p{M}*` 不是字素簇——半角浊音 `ｶﾞ` 的 `ﾞ` 是 Lm 不是 M、
 *  韩文 conjoining jamo 也不是 M，会被硬拆成两段，折叠后长度与整串不一致。 */
const GRAPHEME_SEGMENTER = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

/** 把原串切成 [{start, fold}]：start 是原串下标，fold 是该字素折叠后的文本。
 *  没有 Segmenter 时退到「码点 + 其后组合记号」近似（不会切开代理对）。 */
function graphemeFolds(text) {
  if (GRAPHEME_SEGMENTER !== null) {
    const out = [];
    for (const { segment, index } of GRAPHEME_SEGMENTER.segment(text)) {
      out.push({ start: index, fold: segment.normalize("NFKC").toLowerCase() });
    }
    return out;
  }
  const out = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    let end = i + (cp > 0xffff ? 2 : 1);
    while (end < text.length && /\p{M}/u.test(text.slice(end, end + 1))) end += 1;
    out.push({ start: i, fold: text.slice(i, end).normalize("NFKC").toLowerCase() });
    i = end;
  }
  return out;
}

/** 折叠并保留「折叠后下标 → 原串下标」映射。
 *  片段必须从**原串**切：NFKC 会把中文全角标点（「，」「。」）与兼容字符一起改写，
 *  直接把折叠串当片段显示，用户会看到自己被改过的正文。
 *
 *  折叠本身对**整串**做一次（toLowerCase 与 NFKC 都有跨字符上下文：希腊词尾 Σ→ς、
 *  半角浊音 ｶﾞ 要两码点合并）。逐字素折叠只用于铺开映射，两者长度可能差 ±1。
 *  因此返回错位标记 approx：调用方据此在命中位置附近用精确前缀折叠校正一次，
 *  否则会出现「打分命中、片段却从正文开头开始」——等于没定位到。 */
function foldWithMap(value) {
  const text = String(value ?? "");
  const folded = text.normalize("NFKC").toLowerCase();
  const units = graphemeFolds(text);
  const map = [];
  for (const unit of units) {
    for (let k = 0; k < unit.fold.length; k += 1) map.push(unit.start);
  }
  return { folded, map, units };
}

/** 折叠下标 → 原串下标。
 *
 *  难点：整串 NFKC 会把相邻字素**合并**（韩文兼容字母 `ㄱ`+`ㅏ` → `가`、
 *  `가ㄳ` → `각`），而逐字素折叠铺出来的 map 每个字素各占一项——偏差会随重复次数
 *  线性累积。±N 的邻域搜索修不了线性漂移：2000 个 `ㄱㅏ` 之后命中，偏差达 4000 字符，
 *  片段会从正文开头开始、命中词根本不在里面（等于没定位）。
 *
 *  正确做法：前缀折叠长度对字素边界单调（相邻合并只会让长度变短、不会回增），
 *  于是在**边界集合**上二分找「最长前缀，其折叠长度 ≤ foldedAt」。
 *  只在 map 直查不准时才走二分（正常文本走快路径，零额外开销）。
 */
function originIndexOf(text, units, foldedAt, map) {
  if (foldedAt < 0) return 0;
  if (units.length === 0) return 0;
  const foldLenAt = (boundary) => text.slice(0, boundary).normalize("NFKC").toLowerCase().length;
  const guess = foldedAt < map.length ? map[foldedAt] : null;
  if (guess !== null && foldLenAt(guess) === foldedAt) return guess;
  // 二分：找最大的字素序号 i，使前缀（到 units[i] 起点为止）折叠长度 ≤ foldedAt
  let lo = 0;
  let hi = units.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (foldLenAt(units[mid].start) <= foldedAt) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return units[best].start;
}

/** 从正文里取命中关键词附近的片段（正文无命中时取开头）。 */
export function snippetOf(body, terms, max = SEARCH_SNIPPET_CHARS) {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (text.length === 0) return "";
  // 负数/非数字上限归一化：负 max 会让切窗落在代理对中间，产出孤立代理（U+FFFD）。
  const width = Number.isFinite(max) && max >= 1 ? Math.floor(max) : SEARCH_SNIPPET_CHARS;
  const { folded, map, units } = foldWithMap(text);
  let at = -1;
  for (const term of Array.isArray(terms) ? terms : []) {
    const idx = folded.indexOf(foldText(term));
    if (idx >= 0 && (at < 0 || idx < at)) at = idx;
  }
  // 命中位置换回原串下标（折叠后长度可能变长或变短，不能直接当原串下标用）
  const origAt = originIndexOf(text, units, at, map);
  // 命中点前后各留一段，避免片段从词中间开始。
  // 切窗必须对齐码点边界：直接按 UTF-16 下标切会把代理对劈成两半，
  // 渲染出来是 U+FFFD 替换字符。
  let start = Math.max(0, origAt - Math.floor(width / 4));
  if (start > 0 && start < text.length) {
    const code = text.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) start -= 1; // 落在低位代理上 → 退一格
  }
  let end = Math.min(text.length, start + width);
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end += 1; // 尾巴停在半个代理对 → 补全
  }
  const slice = text.slice(start, end);
  return (start > 0 ? "…" : "") + slice + (end < text.length ? "…" : "");
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

/**
 * 收集可收录条目的相对路径，上限 SEARCH_SCAN_MAX_FILES。
 *
 * 是否「有遗漏」不能由 out.length 推断：目录恰好装满上限时一条都没丢，
 * 用长度判会把 2000 条整的目录误报成有未收录条目。判据必须是**确实遇到第 N+1 个**
 * 可收录文件。装满后仍要把剩余的 dirent 看完（只 readdir，不读正文，代价可忽略），
 * 才能回答「后面还有没有」。
 *
 * @param {{truncated: boolean}} [state] 出参：确证存在未收录条目时置 truncated。
 *   searchMemory 不关心扫描是否被截断，只取返回值；listMemoryEntries 需要如实回报。
 */
function walkMarkdown(root, base = "", out = [], state = { truncated: false }) {
  if (state.truncated) return out; // 已确证有遗漏，继续扫也不会改变结论
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    // 符号链接一律不跟随：跨平台分发时 Linux/macOS 的 symlink 目录
    // isDirectory() 为 true，会递归到 storageRoot 之外把外部文件读进检索结果。
    if (entry.isSymbolicLink()) continue;
    const rel = base.length > 0 ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // 派生/留档目录不进检索：pages 是派生视图，backups/trash/snapshots 不是真源
      if (entry.name === "pages" || entry.name === "backups" || entry.name === "trash"
        || entry.name === "snapshots" || entry.name === "runtime" || entry.name === "surgical") continue;
      walkMarkdown(join(root, entry.name), rel, out, state);
      if (state.truncated) return out;
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.md$/i.test(entry.name)) continue;
    if (entry.name === INDEX_FILENAME) continue; // 索引不是条目，正文重复且无 frontmatter
    if (out.length >= SEARCH_SCAN_MAX_FILES) {
      state.truncated = true; // 第 N+1 个可收录条目：确有遗漏
      return out;
    }
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
 *
 * 语义是「最近的条目」——所以必须按 mtime 全局排序后再截断：不能在目录内提前
 * 截断，CATEGORY_IDS 顺序会让第一个分类灌满 cap，用户在后面的分类刚写入的条目
 * 就永远不出现在列表里。
 *
 * 性能口径：排序只需要 mtime，所以先只 stat（不读文件），排完序只对入选的
 * top-N 读正文与 frontmatter。全量都读正文的话，7500 条要 5 秒级；
 * 只 stat 是毫秒级。
 *
 * 扫描上界：walkMarkdown 的 SEARCH_SCAN_MAX_FILES 是**每个目录**的上限而非全局，
 * 所以这里额外记 scanTruncated（有目录确证还有未收录条目），与「因 limit 截断」分开如实回报。
 *
 * 三个正交事实，不要互相顶替：
 *   - total / truncated：「扫描到的候选」里因 limit 只列了前 picked 条；
 *   - scanTruncated：候选集本身就没扫全（目录超上限），排序基准不完整；
 *   - skipped：入选的 top-N 里有文件 stat 到了、读正文时却失败（被删/权限/坏路径），
 *     这些行不编造成空条目，只计数——entries.length + skipped === picked.length。
 * 前两个是「没看全」，skipped 是「看过了但没读出来」，UI 需要分开告知。
 * @returns {{entries:Array<{scope,name,title,description,type}>,
 *   total:number, truncated:boolean, scanTruncated:boolean, skipped:number}}
 */
export function listMemoryEntries(storageRoot, {
  projectMemoryDir = "",
  includeGlobal = true,
  includeProject = true,
  limit = SEARCH_MAX_RESULTS,
} = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SEARCH_MAX_RESULTS;
  const candidates = [];
  let scanTruncated = false;
  const collect = (dir, scopeOf, categoryOf) => {
    if (!existsSync(dir)) return;
    const state = { truncated: false };
    const rels = walkMarkdown(dir, "", [], state);
    if (state.truncated) scanTruncated = true;
    for (const rel of rels) {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(join(dir, rel)).mtimeMs;
      } catch {
        continue; // stat 不到（刚被删/权限）就不列，不编一条空行
      }
      candidates.push({ scope: scopeOf, category: categoryOf, dir, rel, mtimeMs });
    }
  };
  if (includeGlobal) {
    for (const categoryId of CATEGORY_IDS) collect(categoryDir(storageRoot, categoryId), `global:${categoryId}`, categoryId);
  }
  if (includeProject && projectMemoryDir.length > 0) collect(projectMemoryDir, "project", "project");

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const picked = candidates.slice(0, cap);
  const entries = [];
  for (const row of picked) {
    const entry = readEntryFile(join(row.dir, row.rel), row.rel);
    if (entry === null) continue; // 读取期间被删：跳过，不让一条坏行炸掉整页
    entries.push({
      scope: row.scope,
      category: row.category,
      name: entry.name,
      title: entry.title,
      description: entry.description,
      type: entry.type,
      mtimeMs: row.mtimeMs,
    });
  }
  return {
    entries,
    total: candidates.length,
    truncated: candidates.length > picked.length,
    scanTruncated,
    skipped: picked.length - entries.length,
  };
}

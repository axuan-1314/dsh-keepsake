// dsh-keepsake 索引与清单（规格边界④：注入预算）。
//   MEMORY.md 索引行：`- [Title](file.md) — 一行钩子`，≤150 字符；
//   注入截断：200 行 / 25k 字符 + WARNING；
//   manifest：递归收 .md（排除 MEMORY.md），前 30 行解析 frontmatter，
//   mtime 降序取前 200，渲染 `- [type] filename (ISO): description`；
//   v0.4.0（）：manifest 行尾追加短 sha1（8 hex），提取契约的 write op 可带
//   同名 sha1 覆盖既有文件——覆盖闸据此判「带对/带错/没带」三态。
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { INDEX_FILENAME } from "./filename.js";

export const INDEX_LINE_MAX_CHARS = 150;
/** 短 sha1 长度（manifest 行与提取契约 write op 的 sha1 字段同口径）。 */
export const SHORT_SHA1_LEN = 8;

/**
 * manifest 行（v0.4.0 起带短 sha1）：`- [type] filename (ISO · sha1:xxxxxxxx): description`。
 * sha1 放在时间括号里而非行尾——既让「行尾仍是 description」的既有断言/解析口径
 * 不变，又让模型在取 description 前就先读到哈希（覆盖闸的输入）。
 * sha1 缺省/非法时省略该段（旧数据/读失败不致把 manifest 行弄脏）。
 */
export function buildManifestLine({ type, name, mtimeIso, description, sha1 }) {
  const short = typeof sha1 === "string" && /^[0-9a-f]{8}$/.test(sha1) ? sha1 : null;
  const stamp = short === null ? mtimeIso : `${mtimeIso} · sha1:${short}`;
  return `- [${type}] ${name} (${stamp}): ${description}`;
}

/** 索引行截断到 150 字符（码点安全）。 */
export function clampIndexLine(line) {
  const text = String(line ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= INDEX_LINE_MAX_CHARS) return text;
  return Array.from(text).slice(0, INDEX_LINE_MAX_CHARS - 1).join("") + "…";
}

/** 规格索引行形态：`- [Title](file.md) — 一行钩子`。 */
export function buildIndexLine(title, name, description) {
  const safeTitle = String(title ?? name ?? "").replace(/[[\]]/g, "").trim() || name;
  return clampIndexLine(`- [${safeTitle}](${name}) — ${String(description ?? "").trim()}`);
}

/**
 * 规格截断：maxLines 行 / maxChars 字符，触发任一即追加 WARNING。
 * 扩展：
 *   - preferTail=true 保最新丢最旧（5001 项目索引：merge 语义新条目在尾部，
 *     保头部会让 >200 条后的新记忆反而从注入里消失）；
 *   - label 可换（人设段复用时警示文案不提 MEMORY.md）；
 *   - 码点安全切点（不切出孤立代理对）。
 */
export function truncateWithWarning(content, maxLines, maxChars, { preferTail = false, label = "MEMORY.md" } = {}) {
  const text = String(content ?? "");
  const lines = text.split("\n");
  let lineCut = false;
  let charCut = false;
  let kept = preferTail ? lines.slice(-maxLines) : lines.slice(0, maxLines);
  if (lines.length > maxLines) lineCut = true;
  let out = kept.join("\n");
  if (out.length > maxChars) {
    charCut = true;
    out = preferTail ? out.slice(out.length - maxChars) : out.slice(0, maxChars);
    // 码点安全：切点落在代理对中间则回退/前进一码点
    if (preferTail) {
      const first = out.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) out = out.slice(1);
    } else {
      const last = out.charCodeAt(out.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
    }
  }
  if (lineCut || charCut) {
    out += `\n\n[WARNING] ${label} 超出注入预算，已截断（${lineCut ? `${maxLines} 行上限` : ""}${lineCut && charCut ? "，" : ""}${charCut ? `${maxChars} 字符上限` : ""}）。内容可能不完整，读取记忆文件前请以文件系统为准。`;
  }
  return out;
}

/** 从内容前 30 行解析 frontmatter 的 description/type/title/pinned。 */
export function parseFrontmatterHead(content, maxLines = 30) {
  const lines = String(content ?? "").split("\n", maxLines);
  if (lines[0]?.trim() !== "---") return {};
  const fields = {};
  let metadataType;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "---" || line.trim() === "...") break;
    const metadata = line.match(/^metadata:\s*$/);
    if (metadata) {
      // 进入 metadata 子块（缩进行）
      for (let j = i + 1; j < lines.length; j += 1) {
        const sub = lines[j].match(/^\s+type:\s*(.+)$/);
        if (sub) {
          metadataType = sub[1].trim().replace(/^['"]|['"]$/g, "");
          i = j;
          break;
        }
        if (lines[j].trim() !== "" && /^\S/.test(lines[j])) break;
      }
      continue;
    }
    const simple = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (simple) fields[simple[1]] = simple[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return {
    name: fields.name,
    description: fields.description,
    type: metadataType ?? fields.type,
    title: fields.title,
    // pinned（RUNTIME-FORMAT §5.2-1）：顶层布尔、宽容解析——"true"/true 皆真，
    // 缺省/其它值一律 false，绝不因脏值抛错（frontmatter 是盘上数据，读侧不信任）。
    pinned: String(fields.pinned ?? "").trim().replace(/^['"]|['"]$/g, "").toLowerCase() === "true",
  };
}

/** 递归收集 memoryRoot 下全部 .md（排除 MEMORY.md），返回绝对路径列表。 */
export function listMemoryFiles(memoryRoot, stat = statSync, readDir = readdirSync) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readDir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && entry.name !== INDEX_FILENAME) {
        out.push(full);
      }
    }
  };
  walk(memoryRoot);
  return out;
}

/**
 * 构建提取提示词用的 manifest 文本。
 * @param maxFiles mtime 降序取前 N（规格 200）
 * @param bodyFiles 额外附正文的最近文件数（v1 单次调用的合并上下文）
 * @param maxBodyChars 单文件正文上限
 */
export function buildManifestText(
  memoryRoot,
  { maxFiles = 200, bodyFiles = 10, maxBodyChars = 3000, stat = statSync, readDir = readdirSync, readFile = readFileSync } = {},
) {
  const files = listMemoryFiles(memoryRoot, stat, readDir);
  const stamped = [];
  for (const file of files) {
    try {
      stamped.push({ file, mtime: stat(file).mtimeMs });
    } catch {
      /* 文件竞态消失：跳过 */
    }
  }
  stamped.sort((a, b) => b.mtime - a.mtime);
  const selected = stamped.slice(0, maxFiles);
  const lines = [];
  const bodies = [];
  for (const { file, mtime } of selected) {
    let content = "";
    try {
      content = readFile(file, "utf8");
    } catch {
      continue;
    }
    const front = parseFrontmatterHead(content);
    const type = front.type ?? "project";
    const name = front.name ?? file.slice(memoryRoot.length + 1).replace(/\\/g, "/");
    const description = (front.description ?? "").slice(0, 200);
    // 短 sha1 进 manifest 行（模型覆盖写时回填同名 sha1，盲写即可被闸识别）
    const short = createHash("sha1").update(content, "utf8").digest("hex").slice(0, SHORT_SHA1_LEN);
    lines.push(buildManifestLine({ type, name, mtimeIso: new Date(mtime).toISOString(), description, sha1: short }));
    if (bodies.length < bodyFiles && content.length <= maxBodyChars + 1024) {
      bodies.push(`--- ${name} ---\n${content.slice(0, maxBodyChars)}`);
    }
  }
  return { manifest: lines.join("\n"), bodies: bodies.join("\n\n") };
}

/**
 * 解析现有 MEMORY.md 索引 → 有序 Map<filename, line>。
 * 仅接受 `- [..](x.md) …` 形态的行，其余原样保留在 preamble 里。
 */
export function parseIndexContent(content) {
  const map = new Map();
  const preamble = [];
  for (const line of String(content ?? "").split("\n")) {
    const matched = line.match(/^\s*-\s*\[[^\]]*\]\(([^)]+\.md)\)\s*[—:-–]?\s*(.*)$/i);
    if (matched) {
      const file = matched[1].trim().replace(/\\/g, "/").toLowerCase();
      if (!map.has(file)) map.set(file, line.trim());
      continue;
    }
    if (line.trim().length > 0 || preamble.length > 0) preamble.push(line);
  }
  return { map, preamble: preamble.join("\n").trim() };
}

/** 合并索引行：保持既有顺序，替换/新增 touched，剔除 deleted。
 * 不变量：deleted 优先于 touched——同名既删又写时按删除终态走，
 * 悬挂行不可达（调用方 applyOps 已按终态对账，此处兜底）。 */
export function mergeIndexContent(existingContent, touchedEntries, deletedNames) {
  const { map, preamble } = parseIndexContent(existingContent);
  const deleted = new Set((deletedNames ?? []).map((n) => n.toLowerCase()));
  for (const name of deleted) map.delete(name);
  const touchedMap = new Map();
  for (const entry of touchedEntries ?? []) {
    const name = String(entry.name ?? "").toLowerCase();
    if (name.length === 0 || deleted.has(name)) continue; // 删除终态优先
    const line = entry.line ?? buildIndexLine(entry.title, entry.name, entry.description);
    touchedMap.set(name, clampIndexLine(line));
  }
  // 既有顺序优先（touched 命中既有文件时原位替换），touched 中真正新增的排后面。
  const lines = [];
  const emitted = new Set();
  for (const [name, line] of map) {
    lines.push(touchedMap.get(name) ?? line);
    emitted.add(name);
  }
  for (const [name, line] of touchedMap) if (!emitted.has(name)) lines.push(line);
  const head = preamble.length > 0 ? `${preamble}\n` : "";
  return `${head}${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

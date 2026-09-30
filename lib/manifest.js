// dsh-memory 索引与清单（规格边界④：注入预算）。
//   MEMORY.md 索引行：`- [Title](file.md) — 一行钩子`，≤150 字符；
//   注入截断：200 行 / 25k 字符 + WARNING；
//   manifest：递归收 .md（排除 MEMORY.md），前 30 行解析 frontmatter，
//   mtime 降序取前 200，渲染 `- [type] filename (ISO): description`。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { INDEX_FILENAME } from "./filename.js";

export const INDEX_LINE_MAX_CHARS = 150;

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

/** 规格截断：maxLines 行 / maxChars 字符，触发任一即追加 WARNING。 */
export function truncateWithWarning(content, maxLines, maxChars) {
  const text = String(content ?? "");
  const lines = text.split("\n");
  let lineCut = false;
  let charCut = false;
  let kept = lines.slice(0, maxLines);
  if (lines.length > maxLines) lineCut = true;
  let out = kept.join("\n");
  if (out.length > maxChars) {
    charCut = true;
    out = out.slice(0, maxChars);
  }
  if (lineCut || charCut) {
    out += `\n\n[WARNING] MEMORY.md 超出注入预算，已截断（${lineCut ? `${maxLines} 行上限` : ""}${lineCut && charCut ? "，" : ""}${charCut ? `${maxChars} 字符上限` : ""}）。索引可能不完整，读取记忆文件前请以文件系统为准。`;
  }
  return out;
}

/** 从内容前 30 行解析 frontmatter 的 description/type/title。 */
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
    lines.push(`- [${type}] ${name} (${new Date(mtime).toISOString()}): ${description}`);
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

/** 合并索引行：保持既有顺序，替换/新增 touched，剔除 deleted。 */
export function mergeIndexContent(existingContent, touchedEntries, deletedNames) {
  const { map, preamble } = parseIndexContent(existingContent);
  const deleted = new Set((deletedNames ?? []).map((n) => n.toLowerCase()));
  for (const name of deleted) map.delete(name);
  const touchedMap = new Map();
  for (const entry of touchedEntries ?? []) {
    const name = String(entry.name ?? "").toLowerCase();
    if (name.length === 0) continue;
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

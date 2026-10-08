// dsh-memory 全局记忆区 CRUD（方案C §3 数据布局 v0.2）。
//   <storageRoot>/global/
//     persona.md          人设（frontmatter + markdown 正文；出厂默认模板，R5"补充设定"措辞）
//     addressing.json     {"dshName":"","userAlias":""}
//     work-profile/       四分类：逐条 .md + MEMORY.md（R1 统一索引名，与项目记忆同构）
//     user-profile/       同构
//     current-focus/      同构
//     recent-activity/    同构 + frontmatter metadata.timestamp（host 盖章 R9）；滚动清理
//     long-term/          长期记忆（与项目记忆完全同构）
//   <storageRoot>/backups/<ts>/  reset/import/restore 前自动全量导出留档
// 安全纪律：全部落盘文件名过 sanitizeMemoryName/resolveSafeMemoryTarget 三道闸；
//   写操作原子写（tmp+rename）；索引文件（各根 MEMORY.md）永不被写路径触碰（仅重建）。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { INDEX_FILENAME, resolveSafeMemoryTarget, sanitizeMemoryName } from "./filename.js";
import { buildIndexLine, mergeIndexContent, parseFrontmatterHead } from "./manifest.js";

export const GLOBAL_DIR_NAME = "global";
export const BACKUPS_DIR_NAME = "backups";

/** 五个全局分类（四个对话记忆分类 + 长期记忆；API :id 合法集）。 */
export const CATEGORY_IDS = ["work-profile", "user-profile", "current-focus", "recent-activity", "long-term"];
export const CATEGORY_LABELS = {
  "work-profile": "工作背景",
  "user-profile": "用户个人背景",
  "current-focus": "当前关注",
  "recent-activity": "近期动态",
  "long-term": "长期记忆",
};
/** 四个对话记忆分类（注入/提取面；long-term 单列）。 */
export const CONVERSATION_CATEGORY_IDS = CATEGORY_IDS.slice(0, 4);

/** 出厂默认人设（R5：补充设定措辞——是官方系统提示的补充而非替换）。 */
export const DEFAULT_PERSONA = `---
name: "persona"
description: "DSH 的补充人设设定"
metadata:
  type: global
---

# 补充人设

以下是你（DSH）的补充设定，在官方身份与规则之上生效（补充而非替换）：

- 你乐于承认不知道的事，不会强行编造答案。
- 回答风格：直接、结论先行，重要结论给出依据。
- 代码与技术内容保持原文（命令、标识符、报错不翻译）。

（这是出厂默认模板。你可以在记忆管理面板的「人设」页随时修改以上内容。）
`;

// ---- 路径 ----
export function globalRoot(storageRoot) {
  return join(storageRoot, GLOBAL_DIR_NAME);
}
export function isCategoryId(id) {
  return CATEGORY_IDS.includes(id);
}
export function categoryDir(storageRoot, categoryId) {
  if (!isCategoryId(categoryId)) throw new Error(`dsh-memory: 未知分类 "${String(categoryId)}"`);
  return join(globalRoot(storageRoot), categoryId);
}
export function backupsRoot(storageRoot) {
  return join(storageRoot, BACKUPS_DIR_NAME);
}
export function personaPath(storageRoot) {
  return join(globalRoot(storageRoot), "persona.md");
}
export function addressingPath(storageRoot) {
  return join(globalRoot(storageRoot), "addressing.json");
}

// ---- 原子写 ----
function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}
function writeAtomicBuffer(path, buffer) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, buffer);
  renameSync(tmp, path);
}

// ---- frontmatter 渲染/解析（与项目记忆同构；recent-activity 带 timestamp） ----
const esc = (v) => String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");

/**
 * 渲染全局条目文件（frontmatter + 正文）。
 * @param timestamp recent-activity 专用（host 盖章 R9，ISO 字符串）；其余分类省略。
 * frontmatter 带 title（UI 读回用；项目记忆格式超集，向下兼容无 title 旧文件）。
 */
export function renderGlobalEntry({ name, title, description, timestamp, content }) {
  const lines = [
    "---",
    `name: "${esc(name)}"`,
    `title: "${esc(title ?? name)}"`,
    `description: "${esc(description)}"`,
    "metadata:",
    "  type: global",
  ];
  if (typeof timestamp === "string" && timestamp.length > 0) {
    lines.push(`  timestamp: "${esc(timestamp)}"`);
  }
  lines.push('node_type: "memory"', "---", "", String(content ?? "").trimEnd(), "");
  return lines.join("\n");
}

/** 剥 frontmatter 取正文（首个 --- 块之后的内容）。 */
export function stripFrontmatter(content) {
  const text = String(content ?? "");
  if (!text.startsWith("---")) return text.trim();
  const end = text.indexOf("\n---", 3);
  if (end < 0) return text.trim();
  return text.slice(end + 4).trim();
}

/** 从 frontmatter 头解析 timestamp（metadata 子块；parseFrontmatterHead 未覆盖）。 */
export function parseTimestampHead(content, maxLines = 30) {
  const lines = String(content ?? "").split("\n", maxLines);
  let inMetadata = false;
  for (const line of lines) {
    if (line.trim() === "---" && !inMetadata) { inMetadata = true; continue; }
    if (inMetadata && line.trim() === "---") break;
    const sub = line.match(/^\s+timestamp:\s*"?([^"\n]+)"?\s*$/);
    if (sub) return sub[1].trim();
  }
  return void 0;
}

// ---- 条目读取 ----
/**
 * 读分类目录全部条目（排除 MEMORY.md；按 mtime 降序）。
 * @returns Array<{ name, title, description, content, timestamp?, mtimeMs }>
 */
export function listEntries(storageRoot, categoryId) {
  const dir = categoryDir(storageRoot, categoryId);
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md") && f !== INDEX_FILENAME);
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    const full = join(dir, file);
    let raw;
    let mtimeMs = 0;
    try {
      raw = readFileSync(full, "utf8");
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue; // 竞态消失/读失败：跳过（不炸列表）
    }
    const front = parseFrontmatterHead(raw);
    out.push({
      name: file,
      title: front.title ?? front.name ?? file.replace(/\.md$/i, ""),
      description: front.description ?? "",
      content: stripFrontmatter(raw),
      timestamp: parseTimestampHead(raw),
      mtimeMs,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** 单条读取（name 过三道闸）。 */
export function readEntry(storageRoot, categoryId, name) {
  const dir = categoryDir(storageRoot, categoryId);
  const target = resolveSafeMemoryTarget(dir, name);
  if (target === null || !existsSync(target)) return null;
  const raw = readFileSync(target, "utf8");
  const front = parseFrontmatterHead(raw);
  return {
    name: target.slice(dir.length + 1).replace(/\\/g, "/"),
    title: front.title ?? front.name ?? name.replace(/\.md$/i, ""),
    description: front.description ?? "",
    content: stripFrontmatter(raw),
    timestamp: parseTimestampHead(raw),
    mtimeMs: statSync(target).mtimeMs,
  };
}

/** 文件名派生：title → kebab（三道闸净化）；中文标题等净化为空时兜底 entry-<ts>。 */
export function deriveEntryName(title, fallbackSeed = "") {
  const fromTitle = sanitizeMemoryName(String(title ?? "").slice(0, 80));
  if (fromTitle !== null) return fromTitle;
  const seed = String(fallbackSeed || Date.now()).replace(/[^a-z0-9]/gi, "").slice(-10) || String(Date.now());
  return `entry-${seed.toLowerCase()}.md`;
}

/** 分类内唯一文件名（重名加 -2/-3…）。 */
function uniqueName(dir, wantName) {
  let candidate = wantName;
  for (let i = 2; i < 100; i += 1) {
    if (!existsSync(join(dir, candidate))) return candidate;
    candidate = wantName.replace(/\.md$/i, `-${i}.md`);
  }
  return `entry-${Date.now()}.md`;
}

// ---- 索引重建（复用 mergeIndexContent；索引文件永不被写端点直接触碰） ----
function rebuildIndex(dir, touched, deletedNames) {
  const indexPath = join(dir, INDEX_FILENAME);
  const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  writeAtomic(indexPath, mergeIndexContent(existing, touched, deletedNames));
}

// ---- 条目写入 ----
/**
 * 新增条目。name 可显式给（英文 kebab）；否则从 title 派生 + 重名避让。
 * recent-activity 由 host 盖 timestamp（R9）。
 * @returns { name } 实际落盘文件名。
 */
export function createEntry(storageRoot, categoryId, { title, description = "", content = "", name, timestamp } = {}) {
  const dir = categoryDir(storageRoot, categoryId);
  mkdirSync(dir, { recursive: true });
  let safe = typeof name === "string" && name.length > 0 ? sanitizeMemoryName(name) : null;
  if (safe === null) safe = deriveEntryName(title ?? "entry");
  if (safe.includes("/")) safe = safe.split("/").pop(); // 条目强制单层（UI 语义）
  safe = uniqueName(dir, safe);
  const stamp = categoryId === "recent-activity" ? (typeof timestamp === "string" && timestamp.length > 0 ? timestamp : new Date().toISOString()) : void 0;
  const body = renderGlobalEntry({ name: safe.replace(/\.md$/i, ""), title: title ?? safe, description, timestamp: stamp, content });
  writeAtomic(join(dir, safe), body);
  rebuildIndex(dir, [{ name: safe, title: title ?? safe, description, line: buildIndexLine(title ?? safe, safe, description) }], []);
  return { name: safe };
}

/**
 * 覆盖写条目（提取 ops 落盘语义：content 整体替换旧 body；不做重名避让——
 * 模型点名即目标）。name 过三道闸，非法返回 null。索引同步重建。
 * @returns { name } | null
 */
export function writeEntryDirect(storageRoot, categoryId, { name, title, description = "", content = "", timestamp } = {}) {
  const dir = categoryDir(storageRoot, categoryId);
  mkdirSync(dir, { recursive: true });
  const safe = sanitizeMemoryName(name);
  if (safe === null) return null;
  if (safe.includes("/")) return null; // 审查 P2 修复：全局条目强制单层——嵌套名会绕过 listEntries/clearCategory/滚动清理成幽灵条目
  const stamp = categoryId === "recent-activity" ? (typeof timestamp === "string" && timestamp.length > 0 ? timestamp : new Date().toISOString()) : void 0;
  const body = renderGlobalEntry({ name: safe.replace(/\.md$/i, ""), title: title ?? safe, description, timestamp: stamp, content });
  writeAtomic(join(dir, safe), body);
  rebuildIndex(dir, [{ name: safe, title: title ?? safe, description, line: buildIndexLine(title ?? safe, safe, description) }], []);
  return { name: safe };
}

/**
 * 改条目（正文/标题/描述）或跨分类移动（toCategoryId 不同名移动）。
 * @returns { name, categoryId } 新位置；条目不存在返回 null。
 */
export function updateEntry(storageRoot, categoryId, name, { title, description, content, toCategoryId } = {}) {
  const current = readEntry(storageRoot, categoryId, name);
  if (current === null) return null;
  const targetCategory = typeof toCategoryId === "string" && isCategoryId(toCategoryId) ? toCategoryId : categoryId;
  const next = {
    title: typeof title === "string" && title.length > 0 ? title : current.title,
    description: typeof description === "string" ? description : current.description,
    content: typeof content === "string" ? content : current.content,
    timestamp: current.timestamp,
  };
  const srcDir = categoryDir(storageRoot, categoryId);
  const srcTarget = resolveSafeMemoryTarget(srcDir, name);
  if (targetCategory !== categoryId) {
    // 跨分类移动：写新（重名避让）→ 删旧 → 两边索引重建；时间戳语义跟随目标分类
    const created = createEntry(storageRoot, targetCategory, {
      title: next.title,
      description: next.description,
      content: next.content,
      name,
      timestamp: targetCategory === "recent-activity" ? (next.timestamp ?? new Date().toISOString()) : void 0,
    });
    if (srcTarget !== null) rmSync(srcTarget, { force: true });
    rebuildIndex(srcDir, [], [name]);
    return { name: created.name, categoryId: targetCategory };
  }
  const body = renderGlobalEntry({ name: name.replace(/\.md$/i, ""), title: next.title, description: next.description, timestamp: next.timestamp, content: next.content });
  if (srcTarget === null) return null;
  writeAtomic(srcTarget, body);
  rebuildIndex(srcDir, [{ name, title: next.title, description: next.description, line: buildIndexLine(next.title, name, next.description) }], []);
  return { name, categoryId };
}

/** 删条目（name 过三道闸；索引同步剔除）。 @returns true=删到文件 */
export function deleteEntry(storageRoot, categoryId, name) {
  const dir = categoryDir(storageRoot, categoryId);
  const target = resolveSafeMemoryTarget(dir, name);
  if (target === null) return false;
  const existed = existsSync(target);
  if (existed) rmSync(target, { force: true });
  rebuildIndex(dir, [], [name]);
  return existed;
}

/** 分类条目计数（state 端点轻态用；不读正文）。 */
export function countEntries(storageRoot, categoryId) {
  try {
    return readdirSync(categoryDir(storageRoot, categoryId)).filter((f) => f.toLowerCase().endsWith(".md") && f !== INDEX_FILENAME).length;
  } catch {
    return 0;
  }
}

// ---- 人设 ----
/** 读人设正文；文件不存在或内容等于出厂模板 → isDefault=true（reset 后即回默认态）。 */
export function readPersona(storageRoot) {
  const path = personaPath(storageRoot);
  if (!existsSync(path)) return { content: DEFAULT_PERSONA, isDefault: true };
  try {
    const body = stripFrontmatter(readFileSync(path, "utf8"));
    return { content: body, isDefault: body === stripFrontmatter(DEFAULT_PERSONA) };
  } catch {
    return { content: DEFAULT_PERSONA, isDefault: true };
  }
}

/** 写人设正文（≤100KB 由 API 层强制；frontmatter 由本层补齐）。 */
export function writePersona(storageRoot, content) {
  const body = [
    "---",
    'name: "persona"',
    'description: "DSH 的补充人设设定"',
    "metadata:",
    "  type: global",
    'node_type: "memory"',
    "---",
    "",
    String(content ?? "").trim(),
    "",
  ].join("\n");
  writeAtomic(personaPath(storageRoot), body);
}

/** 人设重置 = 恢复出厂默认模板（R5：非清空）。 */
export function resetPersona(storageRoot) {
  writeAtomic(personaPath(storageRoot), DEFAULT_PERSONA);
}

// ---- 称呼 ----
export function readAddressing(storageRoot) {
  const path = addressingPath(storageRoot);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      dshName: typeof parsed.dshName === "string" ? parsed.dshName : "",
      userAlias: typeof parsed.userAlias === "string" ? parsed.userAlias : "",
    };
  } catch {
    return { dshName: "", userAlias: "" }; // 不存在/损坏 = 空称呼（注入段略句）
  }
}
export function writeAddressing(storageRoot, { dshName, userAlias } = {}) {
  const current = readAddressing(storageRoot);
  const next = {
    dshName: typeof dshName === "string" ? dshName.slice(0, 40) : current.dshName,
    userAlias: typeof userAlias === "string" ? userAlias.slice(0, 40) : current.userAlias,
  };
  writeAtomicBuffer(addressingPath(storageRoot), Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf8"));
  return next;
}

// ---- 近期动态滚动清理（30 条/30 天默认，cordis config 可调） ----
/**
 * @returns { removed, kept } 计数（日志由调用方记）。
 */
export function pruneRecentActivity(storageRoot, { keepCount = 30, keepDays = 30 } = {}) {
  const dir = categoryDir(storageRoot, "recent-activity");
  const entries = listEntries(storageRoot, "recent-activity");
  if (entries.length === 0) return { removed: 0, kept: 0 };
  const now = Date.now();
  const maxAgeMs = keepDays * 86400_000;
  const survivors = [];
  const victims = [];
  for (const entry of entries) {
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : entry.mtimeMs;
    const ageOk = Number.isFinite(ts) ? now - ts <= maxAgeMs : true;
    if (ageOk) survivors.push({ entry, ts: Number.isFinite(ts) ? ts : 0 });
    else victims.push(entry);
  }
  survivors.sort((a, b) => b.ts - a.ts); // 新的在前
  for (const over of survivors.slice(keepCount)) victims.push(over.entry);
  const kept = survivors.slice(0, keepCount);
  const deletedNames = [];
  for (const victim of victims) {
    const target = resolveSafeMemoryTarget(dir, victim.name);
    if (target !== null && existsSync(target)) {
      rmSync(target, { force: true });
      deletedNames.push(victim.name);
    }
  }
  if (deletedNames.length > 0) rebuildIndex(dir, [], deletedNames);
  return { removed: deletedNames.length, kept: kept.length };
}

// ---- 分类重置（先自动备份再清空；备份由调用方显式触发 createBackup） ----
/** 清空分类全部条目（不动 MEMORY.md 之外的非 .md 文件）。 @returns 删除条数 */
export function clearCategory(storageRoot, categoryId) {
  const dir = categoryDir(storageRoot, categoryId);
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md") && f !== INDEX_FILENAME);
  } catch {
    return 0;
  }
  for (const file of files) rmSync(join(dir, file), { force: true });
  rebuildIndex(dir, [], files);
  return files.length;
}

// ---- 全量导出 / 备份 / 恢复 ----
export function exportAll(storageRoot) {
  const categories = {};
  for (const id of CATEGORY_IDS) categories[id] = listEntries(storageRoot, id);
  let persona = null;
  try {
    persona = existsSync(personaPath(storageRoot)) ? readFileSync(personaPath(storageRoot), "utf8") : null;
  } catch { persona = null; }
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    persona,
    addressing: readAddressing(storageRoot),
    categories,
  };
}

/** 全量备份：global/ + settings.json → backups/<ISO 安全时间戳>/。 @returns backupId */
export function createBackup(storageRoot, reason = "manual") {
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(backupsRoot(storageRoot), id);
  mkdirSync(dest, { recursive: true });
  const gRoot = globalRoot(storageRoot);
  if (existsSync(gRoot)) cpSync(gRoot, join(dest, GLOBAL_DIR_NAME), { recursive: true });
  const settings = join(storageRoot, "settings.json");
  if (existsSync(settings)) cpSync(settings, join(dest, "settings.json"));
  writeAtomicBuffer(join(dest, "backup-meta.json"), Buffer.from(JSON.stringify({ id, reason, createdAt: new Date().toISOString(), version: 1 }, null, 2) + "\n", "utf8"));
  return id;
}

export function listBackups(storageRoot) {
  const root = backupsRoot(storageRoot);
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const id of dirs) {
    let meta = null;
    try {
      meta = JSON.parse(readFileSync(join(root, id, "backup-meta.json"), "utf8"));
    } catch { /* 无 meta 也列出 */ }
    out.push({ id, reason: meta?.reason ?? null, createdAt: meta?.createdAt ?? null });
  }
  out.sort((a, b) => (a.id < b.id ? 1 : -1)); // 新的在前
  return out;
}

/** 备份 id 安全校验（防路径穿越；只认 createBackup 生成形态 "2026-10-08T19-40-04-505Z"）。 */
export function isSafeBackupId(id) {
  return typeof id === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(id) && id.length <= 64;
}

/**
 * 从备份恢复：全量覆盖 global/ + settings.json。
 * 调用方应先对当前状态再备份一次（后悔药的后悔药，见 api.js）。
 */
export function restoreBackup(storageRoot, backupId) {
  if (!isSafeBackupId(backupId)) throw new Error(`dsh-memory: 非法备份 id "${String(backupId)}"`);
  const src = join(backupsRoot(storageRoot), backupId);
  if (!existsSync(src)) throw new Error(`dsh-memory: 备份不存在 "${backupId}"`);
  const gRoot = globalRoot(storageRoot);
  rmSync(gRoot, { recursive: true, force: true });
  const srcGlobal = join(src, GLOBAL_DIR_NAME);
  if (existsSync(srcGlobal)) cpSync(srcGlobal, gRoot, { recursive: true });
  const srcSettings = join(src, "settings.json");
  if (existsSync(srcSettings)) cpSync(srcSettings, join(storageRoot, "settings.json"), { force: true });
  return true;
}

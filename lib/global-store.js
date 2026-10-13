// dsh-keepsake 全局记忆区 CRUD。
//   <storageRoot>/global/
//     persona.md          人设（frontmatter + markdown 正文；出厂默认模板，"补充设定"措辞）
//     addressing.json     {"dshName":"","userAlias":""}
//     work-profile/       四分类：逐条 .md + MEMORY.md（统一索引名，与项目记忆同构）
//     user-profile/       同构
//     current-focus/      同构
//     recent-activity/    同构 + frontmatter metadata.timestamp（host 盖章）；滚动清理
//     long-term/          长期记忆（与项目记忆完全同构）
//   <storageRoot>/backups/<ts>/  reset/import/restore 前自动全量导出留档
// 安全纪律：全部落盘文件名过 sanitizeMemoryName/resolveSafeMemoryTarget 三道闸；
//   写操作原子写（tmp+rename）；索引文件（各根 MEMORY.md）永不被写路径触碰（仅重建）。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { INDEX_FILENAME, fallbackEntryName, resolveSafeMemoryTarget, sanitizeMemoryName, stripControlAndBidi } from "./filename.js";
import { buildIndexLine, mergeIndexContent, parseFrontmatterHead } from "./manifest.js";
import { recentTsOf } from "./recent-ts.js";

export const GLOBAL_DIR_NAME = "global";
export const BACKUPS_DIR_NAME = "backups";
/** 备份滚动上限（reset/import/restore 全量拷贝此前无界累积）。 */
export const BACKUP_KEEP = 20;

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

/** 出厂默认人设（补充设定措辞——是官方系统提示的补充而非替换）。 */
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
  if (!isCategoryId(categoryId)) throw new Error(`dsh-keepsake: 未知分类 "${String(categoryId)}"`);
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
 * @param timestamp recent-activity 专用（host 盖章，ISO 字符串）；其余分类省略。
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

/** 文件名派生：title → kebab（三道闸净化）；中文标题等净化为空时兜底 entry-<sha1>。 */
export function deriveEntryName(title, fallbackSeed = "") {
  const fromTitle = sanitizeMemoryName(String(title ?? "").slice(0, 80));
  if (fromTitle !== null) return fromTitle;
  // 确定性兜底：同标题同名、异标题异名（取代旧的时间戳命名），防同目录多条中文条目撞名。
  return fallbackEntryName(fallbackSeed || title);
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
 * recent-activity 由 host 盖 timestamp。
 * @returns { name } 实际落盘文件名。
 */
export function createEntry(storageRoot, categoryId, { title, description = "", content = "", name, timestamp } = {}) {
  const dir = categoryDir(storageRoot, categoryId);
  mkdirSync(dir, { recursive: true });
  let safe;
  if (typeof name === "string" && name.length > 0) {
    safe = sanitizeMemoryName(name);
    if (safe === null) return null; // 显式非法名（保留名/../黑名单段等）→ 拒绝，不再静默改按标题派生
    if (safe.includes("/")) return null; // 显式嵌套路径 → 显式拒绝，不再静默拍扁
  } else {
    const derived = deriveEntryName(title ?? "entry");
    // 标题含 "/" 会派生出嵌套路径；全局条目强制单层，取末段（不再整条拒绝）。
    safe = derived === null ? null : derived.includes("/") ? derived.split("/").pop() : derived;
  }
  if (safe === null || safe.length === 0) return null;
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
  if (safe.includes("/")) return null; // 全局条目强制单层——嵌套名会绕过 listEntries/clearCategory/滚动清理成幽灵条目
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
    // 跨分类移动：写新（重名避让）→ 删旧 → 两边索引重建；时间戳语义跟随目标分类。
    // 删旧失败（EBUSY）时补偿删新位，不丢双份。
    const created = createEntry(storageRoot, targetCategory, {
      title: next.title,
      description: next.description,
      content: next.content,
      name,
      timestamp: targetCategory === "recent-activity" ? (next.timestamp ?? new Date().toISOString()) : void 0,
    });
    if (created === null) return null;
    if (srcTarget !== null) {
      try {
        rmSync(srcTarget, { force: true });
      } catch (error) {
        const createdTarget = resolveSafeMemoryTarget(categoryDir(storageRoot, targetCategory), created.name);
        if (createdTarget !== null) rmSync(createdTarget, { force: true });
        throw error;
      }
    }
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
  if (!existed) return false; // 不存在就不重建索引（少一次白写盘）
  try {
    rmSync(target, { force: true });
  } catch {
    return false; // 外部占用（EBUSY/EPERM 等）：按未删处理，不抛 500
  }
  rebuildIndex(dir, [], [name]);
  return true;
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
/** 损坏文件备份：覆盖写前把原文件改名 <name>.corrupt-<ts>（原数据永不失访）。 */
function preserveCorruptFile(path) {
  try {
    if (existsSync(path)) renameSync(path, `${path}.corrupt-${Date.now()}`);
  } catch { /* 备份失败不阻断写入 */ }
}
/**
 * 读人设正文；文件不存在或内容等于出厂模板 → isDefault=true（reset 后即回默认态）。
 * 读失败/半损 → corrupt:true + warn（对齐 settings 可见降级），
 * 覆盖写前原文件备份。
 */
export function readPersona(storageRoot, log = { warn: () => {} }) {
  const path = personaPath(storageRoot);
  if (!existsSync(path)) return { content: DEFAULT_PERSONA, isDefault: true, corrupt: false };
  try {
    const body = stripFrontmatter(readFileSync(path, "utf8"));
    return { content: body, isDefault: body === stripFrontmatter(DEFAULT_PERSONA), corrupt: false };
  } catch (error) {
    log.warn("persona.md 读取失败，回退出厂模板（corrupt）", error);
    return { content: DEFAULT_PERSONA, isDefault: true, corrupt: true };
  }
}

/** 写人设正文（≤100KB 由 API 层强制；frontmatter 由本层补齐；损坏旧档先备份）。 */
export function writePersona(storageRoot, content, log = { warn: () => {} }) {
  if (readPersona(storageRoot, log).corrupt) preserveCorruptFile(personaPath(storageRoot));
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

/** 人设重置 = 恢复出厂默认模板（非清空）。 */
export function resetPersona(storageRoot) {
  writeAtomic(personaPath(storageRoot), DEFAULT_PERSONA);
}

// ---- 称呼 ----
/**
 * 读称呼。JSON 半损 → corrupt:true + warn，不再静默吞；
 * 后续写以损坏标记触发旧档备份，原数据不被覆盖丢失。
 */
export function readAddressing(storageRoot, log = { warn: () => {} }) {
  const path = addressingPath(storageRoot);
  if (!existsSync(path)) return { dshName: "", userAlias: "", corrupt: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      dshName: typeof parsed.dshName === "string" ? parsed.dshName : "",
      userAlias: typeof parsed.userAlias === "string" ? parsed.userAlias : "",
      corrupt: false,
    };
  } catch (error) {
    log.warn("addressing.json 解析失败，回退空称呼（corrupt）", error);
    return { dshName: "", userAlias: "", corrupt: true }; // 可见降级（门牌红条）
  }
}
export function writeAddressing(storageRoot, { dshName, userAlias } = {}, log = { warn: () => {} }) {
  const current = readAddressing(storageRoot, log);
  if (current.corrupt) preserveCorruptFile(addressingPath(storageRoot));
  // 剥控制符/bidi（称呼最终进 system prompt）；40 字符截断
  const clip = (v) => stripControlAndBidi(String(v)).slice(0, 40);
  const next = {
    dshName: typeof dshName === "string" ? clip(dshName) : current.dshName,
    userAlias: typeof userAlias === "string" ? clip(userAlias) : current.userAlias,
  };
  writeAtomicBuffer(addressingPath(storageRoot), Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf8"));
  return next;
}

// ---- 近期动态滚动清理（30 条/30 天默认，cordis config 可调） ----
/**
 * @returns { removed, kept } 计数（日志由调用方记）。
 * 判龄与排序统一走 recentTsOf（timestamp 为准、未来 ts 钳制、坏值回退 mtime），
 * 与展示/注入侧同一基准（此前展示按 mtime、清理按 timestamp 双序错位）。
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
    const ts = recentTsOf(entry);
    const ageOk = now - ts <= maxAgeMs;
    if (ageOk) survivors.push({ entry, ts });
    else victims.push(entry);
  }
  survivors.sort((a, b) => b.ts - a.ts); // 新的在前
  for (const over of survivors.slice(keepCount)) victims.push(over.entry);
  const kept = survivors.slice(0, keepCount);
  const deletedNames = [];
  for (const victim of victims) {
    const target = resolveSafeMemoryTarget(dir, victim.name);
    if (target === null || !existsSync(target)) continue;
    try {
      rmSync(target, { force: true }); // 单条删除失败不中断整批
      deletedNames.push(victim.name);
    } catch { /* 该条下轮再清 */ }
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
  const deleted = [];
  for (const file of files) {
    try {
      rmSync(join(dir, file), { force: true }); // 单条失败不吞整批，索引必须对账
      deleted.push(file);
    } catch { /* 保留索引行，下次再清 */ }
  }
  if (deleted.length > 0) rebuildIndex(dir, [], deleted);
  return deleted.length;
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

/**
 * 全量备份：global/ + settings.json → backups/<ISO 安全时间戳>/。
 * 两段式备份要点：
 *   - id 同毫秒撞车重试（mkdir 目录已存在即换 id，防两备份混合）；
 *   - meta 两段式：先写 complete:false，拷完改写 complete:true——中断的半备份
 *     带 complete:false，listBackups 标 incomplete、restoreBackup 拒绝；
 *   - 滚动保留最新 BACKUP_KEEP 份，防无界累积。
 * @returns backupId
 */
export function createBackup(storageRoot, reason = "manual") {
  let id = new Date().toISOString().replace(/[:.]/g, "-");
  let dest = join(backupsRoot(storageRoot), id);
  for (let i = 0; existsSync(dest) && i < 50; i += 1) {
    id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${i}`;
    dest = join(backupsRoot(storageRoot), id);
  }
  mkdirSync(dest, { recursive: true });
  const metaPath = join(dest, "backup-meta.json");
  const meta = { id, reason, createdAt: new Date().toISOString(), version: 1, complete: false };
  writeAtomicBuffer(metaPath, Buffer.from(JSON.stringify(meta, null, 2) + "\n", "utf8"));
  const gRoot = globalRoot(storageRoot);
  if (existsSync(gRoot)) cpSync(gRoot, join(dest, GLOBAL_DIR_NAME), { recursive: true });
  const settings = join(storageRoot, "settings.json");
  if (existsSync(settings)) cpSync(settings, join(dest, "settings.json"));
  writeAtomicBuffer(metaPath, Buffer.from(JSON.stringify({ ...meta, complete: true }, null, 2) + "\n", "utf8"));
  pruneBackups(storageRoot);
  return id;
}

/** 滚动清理：按 id 降序保留最新 BACKUP_KEEP 份（含 incomplete 半备份一起清）。 */
export function pruneBackups(storageRoot) {
  const root = backupsRoot(storageRoot);
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return 0;
  }
  dirs.sort().reverse(); // id 即时间序
  let removed = 0;
  for (const stale of dirs.slice(BACKUP_KEEP)) {
    try {
      rmSync(join(root, stale), { recursive: true, force: true });
      removed += 1;
    } catch { /* 下轮再清 */ }
  }
  return removed;
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
    } catch { /* 无 meta = incomplete（半备份），仍列出但标红 */ }
    out.push({
      id,
      reason: meta?.reason ?? null,
      createdAt: meta?.createdAt ?? null,
      // 旧备份（meta 无 complete 字段）视同完整；无 meta / complete:false = 半备份
      incomplete: meta === null || meta.complete === false,
    });
  }
  out.sort((a, b) => (a.id < b.id ? 1 : -1)); // 新的在前
  return out;
}

/** 备份 id 安全校验（防路径穿越；只认 createBackup 生成形态 "2026-10-08T19-40-04-505Z"，撞车重试可带 -N 尾）。 */
export function isSafeBackupId(id) {
  return typeof id === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d{1,2})?$/.test(id) && id.length <= 64;
}

/**
 * 从备份恢复：全量覆盖 global/ + settings.json（两阶段换入）。
 *   1) 校验备份完整性（meta.complete；无 meta 的半备份拒绝）；
 *   2) 先把备份内容 cp 到 staging，旧 global 改名 retired，rename 换入；失败回滚 retired。
 * 错误带 code 供 API 分流：BACKUP_INVALID / BACKUP_MISSING / BACKUP_INCOMPLETE → 4xx；
 * RESTORE_FAILED（IO 中途）→ 500（调用方带 preRestoreBackupId 自救）。
 */
export function restoreBackup(storageRoot, backupId) {
  if (!isSafeBackupId(backupId)) {
    const err = new Error(`dsh-keepsake: 非法备份 id "${String(backupId)}"`);
    err.code = "BACKUP_INVALID";
    throw err;
  }
  const src = join(backupsRoot(storageRoot), backupId);
  if (!existsSync(src)) {
    const err = new Error(`dsh-keepsake: 备份不存在 "${backupId}"`);
    err.code = "BACKUP_MISSING";
    throw err;
  }
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(join(src, "backup-meta.json"), "utf8"));
  } catch { meta = null; }
  if (meta === null || meta.complete === false) {
    const err = new Error(`dsh-keepsake: 备份 "${backupId}" 不完整（半备份），拒绝恢复`);
    err.code = "BACKUP_INCOMPLETE";
    throw err;
  }
  const gRoot = globalRoot(storageRoot);
  const stamp = `${process.pid}-${Date.now()}`;
  const staging = join(storageRoot, `global.staging-${stamp}`);
  const retired = join(storageRoot, `global.retired-${stamp}`);
  const srcGlobal = join(src, GLOBAL_DIR_NAME);
  try {
    if (existsSync(srcGlobal)) cpSync(srcGlobal, staging, { recursive: true });
    else mkdirSync(staging, { recursive: true }); // 备份无 global = 恢复成空 global
    const hadOld = existsSync(gRoot);
    if (hadOld) renameSync(gRoot, retired);
    try {
      renameSync(staging, gRoot);
    } catch (error) {
      if (hadOld) renameSync(retired, gRoot); // 换入失败回滚旧档
      throw error;
    }
    if (hadOld) rmSync(retired, { recursive: true, force: true });
    const srcSettings = join(src, "settings.json");
    if (existsSync(srcSettings)) cpSync(srcSettings, join(storageRoot, "settings.json"), { force: true });
    return true;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    rmSync(retired, { recursive: true, force: true });
    const err = new Error(`dsh-keepsake: 恢复失败（${String(error?.message ?? error)}）`);
    err.code = "RESTORE_FAILED";
    throw err;
  }
}

// ---- 临时文件清扫（writeAtomic tmp+rename 中断残留的 .tmp-*） ----
/** 启动/写后收口时清 .tmp-* 孤儿与 restore 中断残留的 staging/retired 目录。 @returns 清理个数 */
export function sweepTmpOrphans(storageRoot) {
  let removed = 0;
  const roots = [storageRoot, globalRoot(storageRoot), join(storageRoot, BACKUPS_DIR_NAME)];
  for (const id of CATEGORY_IDS) roots.push(join(globalRoot(storageRoot), id));
  for (const root of roots) {
    let names;
    try {
      names = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of names) {
      const full = join(root, ent.name);
      if (!ent.isDirectory() && ent.name.includes(".tmp-")) {
        try { rmSync(full, { force: true }); removed += 1; } catch { /* 下轮再清 */ }
      } else if (ent.isDirectory() && /^global\.(staging|retired)-/.test(ent.name) && root === storageRoot) {
        // restore 中断残留目录（正常路径自清）；仅清 1 小时以上的，避开在途恢复
        try {
          if (Date.now() - statSync(full).mtimeMs > 3600_000) {
            rmSync(full, { recursive: true, force: true });
            removed += 1;
          }
        } catch { /* 下轮再清 */ }
      }
    }
  }
  return removed;
}

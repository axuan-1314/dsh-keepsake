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
import { dirname, join, basename, relative } from "node:path";
import { INDEX_FILENAME, fallbackEntryName, resolveSafeMemoryTarget, sanitizeMemoryName, stripControlAndBidi } from "./filename.js";
import { buildIndexLine, mergeIndexContent, parseFrontmatterHead } from "./manifest.js";
import { recentTsOf } from "./recent-ts.js";
import { SURGICAL_DIR_NAME } from "./safety.js";

export const GLOBAL_DIR_NAME = "global";
export const BACKUPS_DIR_NAME = "backups";
/** 备份滚动上限（reset/import/restore 全量拷贝此前无界累积）。 */
export const BACKUP_KEEP = 20;
/**
 * 全量备份 meta 版本号（v0.4.0 = 2：首次把 project/ 记忆纳入备份）。
 * 读侧对 meta 版本宽容：无 version 字段的旧备份视同 1，restore 不得因版本差异崩。
 */
export const BACKUP_META_VERSION = 2;

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

/**
 * 全局 delete 后对账分类索引：重建 MEMORY.md 并剔除该条 name（复用 rebuildIndex）。
 * 提取路径的 global delete 走回收站移入（trashMemoryFile），文件虽已移出，但 MEMORY.md
 * 里的索引行若不再对账就会成为悬挂行、被注入进此后每一轮的提示词——故删后必须对账。
 * name 归一口径与写路径一致（sanitizeMemoryName）；未过闸返回 false，不触碰索引。
 * @returns boolean 是否执行了重建
 */
export function reconcileCategoryIndexAfterDelete(storageRoot, categoryId, name) {
  const dir = categoryDir(storageRoot, categoryId);
  const safe = sanitizeMemoryName(name ?? "");
  if (safe === null) return false;
  rebuildIndex(dir, [], [safe]);
  return true;
}

/**
 * 全局写后被回滚后的分类索引对账（写路径 writeEntryDirect 已即时重建过索引，
 * 回滚改了磁盘状态，索引须跟上）：
 *   - preContent 为字符串（覆盖既有回滚到旧文）：按旧文 frontmatter 重建该行；
 *   - 否则（纯新增回滚，文件已被删）：剔除该行，不留悬挂。
 * name 归一口径与写路径一致（sanitizeMemoryName）；未过闸返回 false。
 * @returns boolean 是否执行了重建
 */
export function reconcileCategoryIndexAfterRollback(storageRoot, categoryId, name, preContent) {
  const dir = categoryDir(storageRoot, categoryId);
  const safe = sanitizeMemoryName(name ?? "");
  if (safe === null) return false;
  if (typeof preContent === "string") {
    const front = parseFrontmatterHead(preContent);
    const title = front.title ?? front.name ?? safe.replace(/\.md$/i, "");
    rebuildIndex(dir, [{ name: safe, title, description: front.description ?? "", line: buildIndexLine(title, safe, front.description ?? "") }], []);
  } else {
    rebuildIndex(dir, [], [safe]);
  }
  return true;
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
 * 全量备份：global/ + settings.json + project/ → backups/<ISO 安全时间戳>/。
 * v0.4.0：增拷 project/ 记忆目录——此前 8 份备份全无项目记忆，
 *   项目侧（记忆真正的大头）在全量恢复里是空的。
 *   注：backups/surgical/ 是另一套东西（手术式快照，非全量备份），
 *   由 listBackups 显式区分，不进全量备份、也不被全量备份的滚动清理带走。
 * 两段式备份要点：
 *   - id 同毫秒撞车重试（mkdir 目录已存在即换 id，防两备份混合）；
 *   - meta 两段式：先写 complete:false，拷完改写 complete:true——中断的半备份
 *     带 complete:false，listBackups 标 incomplete、restoreBackup 拒绝；
 *   - 滚动保留最新 BACKUP_KEEP 份，防无界累积。
 * @param {{ protectId?: string }} [options] protectId：本次滚动清理豁免的对象备份 id
 *   （backup/restore 恢复前先建留底：留底会把份数顶到 BACKUP_KEEP+1，若不豁免，
 *   被清理掉的恰是最旧的那份 = 正在恢复的目标本身，目标目录被永久删除）。
 * @returns backupId
 */
export function createBackup(storageRoot, reason = "manual", options = {}) {
  let id = new Date().toISOString().replace(/[:.]/g, "-");
  let dest = join(backupsRoot(storageRoot), id);
  for (let i = 0; existsSync(dest) && i < 50; i += 1) {
    id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${i}`;
    dest = join(backupsRoot(storageRoot), id);
  }
  mkdirSync(dest, { recursive: true });
  const metaPath = join(dest, "backup-meta.json");
  const meta = { id, reason, createdAt: new Date().toISOString(), version: BACKUP_META_VERSION, complete: false };
  writeAtomicBuffer(metaPath, Buffer.from(JSON.stringify(meta, null, 2) + "\n", "utf8"));
  const gRoot = globalRoot(storageRoot);
  if (existsSync(gRoot)) cpSync(gRoot, join(dest, GLOBAL_DIR_NAME), { recursive: true });
  const settings = join(storageRoot, "settings.json");
  if (existsSync(settings)) cpSync(settings, join(dest, "settings.json"));
  // project/ 记忆目录首次纳入全量备份（缺目录不算失败——还没建过项目记忆是正常态）
  const pRoot = join(storageRoot, "projects");
  if (existsSync(pRoot)) cpSync(pRoot, join(dest, "projects"), { recursive: true });
  writeAtomicBuffer(metaPath, Buffer.from(JSON.stringify({ ...meta, complete: true }, null, 2) + "\n", "utf8"));
  pruneBackups(storageRoot, options?.protectId);
  return id;
}

/** 滚动清理：按 id 降序保留最新 BACKUP_KEEP 份（含 incomplete 半备份一起清）。
 * 跳过 backups/surgical/——那是手术式快照（另一套保留策略 surgicalKeep），
 * 既不是全量备份，也不能被全量备份的滚动清理带走。
 * @param {string} [protectId] 本次清理豁免的对象备份 id（在返回集合里强制保留；
 *   用于 backup/restore：留底备份的清理不得把正在恢复的目标本身清掉）。 */
export function pruneBackups(storageRoot, protectId = void 0) {
  const root = backupsRoot(storageRoot);
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== SURGICAL_DIR_NAME).map((d) => d.name);
  } catch {
    return 0;
  }
  dirs.sort().reverse(); // id 即时间序
  // 淘汰集 = 第 BACKUP_KEEP 名之后的分母，但豁免 protectId（正常调用不传，集合不变）。
  // 豁免会让本次保留 BACKUP_KEEP+1 份——这正是「该次清理绝不淘汰在途目标」的语义。
  const evict = dirs.slice(BACKUP_KEEP).filter((d) => !(typeof protectId === "string" && d === protectId));
  let removed = 0;
  for (const stale of evict) {
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
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== SURGICAL_DIR_NAME).map((d) => d.name);
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
      version: meta?.version ?? 1, // 旧备份无 version 字段 → 视同 1（读侧宽容，不因版本差异崩）
      id,
      reason: meta?.reason ?? null,
      // createdAt：优先 meta.createdAt；缺失/不可解析时回落备份目录 mtime（转 ISO）；都取不到给 null。
      createdAt: backupCreatedAt(meta, join(root, id)),
      // 旧备份（meta 无 complete 字段）视同完整；无 meta / complete:false = 半备份
      incomplete: meta === null || meta.complete === false,
    });
  }
  out.sort((a, b) => (a.id < b.id ? 1 : -1)); // 新的在前
  return out;
}

/** 备份生成时间：meta.createdAt（可解析字符串）优先，否则目录 mtime 转 ISO，取不到 null。 */
function backupCreatedAt(meta, dir) {
  if (typeof meta?.createdAt === "string" && Number.isFinite(Date.parse(meta.createdAt))) return meta.createdAt;
  try {
    const mtime = statSync(dir).mtimeMs;
    if (Number.isFinite(mtime)) return new Date(mtime).toISOString();
  } catch { /* 目录不可 stat：无 createdAt 兜底 */ }
  return null;
}

/** 备份 id 安全校验（防路径穿越；只认 createBackup 生成形态 "2026-10-08T19-40-04-505Z"，撞车重试可带 -N 尾）。 */
export function isSafeBackupId(id) {
  return typeof id === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d{1,2})?$/.test(id) && id.length <= 64;
}

/**
 * 从备份恢复：全量覆盖 global/ + settings.json + project/（两阶段换入）。
 *   project/ 恢复对旧备份宽容：备份里没有 projects（meta version<2）就跳过，
 *   绝不因 meta 版本差异崩（旧备份必须兼容）。
 *   1) 校验备份完整性（meta.complete；无 meta 的半备份拒绝）；
 *   2) global/ 与 projects/ 都用【同一套两阶段换入】：备份内容先 cp 到各自的 staging，
 *      旧本体改名 retired，rename 把 staging 换入。拷贝全程发生在 staging，
 *      半成品拷贝绝不成为本体（改掉了 projects/ 直接拷进本体、中途失败留半成品的旧弊）。
 *   3) 换入失败：先删半成品再 rename 回滚旧档；回滚 rename 也失败时保留 retired-* 并抛出
 *      点名该目录的错误（人工恢复材料）。
 *   退役副本清理（换入成功后的 rmSync retired-*）单列 try/catch，只 warn 绝不回滚——
 *      递归 rm 在 Windows 上非原子，可能删残后抛 EPERM；若把它当拷贝失败回滚，
 *      会把被删残的退役目录换回本体，反而毁掉恢复前数据。
 *   失败保全纪律：外层 catch 只清 staging/stagingP，绝不删 retired-*——那是恢复前的原始数据；
 *   RESTORE_FAILED 消息先核对 retired-* 确实存在且非空才说「已保留」，清理中断/空目录如实说明，
 *   不谎称已完整保留。
 *   options.copyFn / options.renameFn / options.rmFn 仅供测试注入（默认走 fs 原生 cpSync / renameSync / rmSync）。
 * 错误带 code 供 API 分流：BACKUP_INVALID / BACKUP_MISSING / BACKUP_INCOMPLETE → 4xx；
 * RESTORE_FAILED（IO 中途）→ 500（调用方带 preRestoreBackupId 自救）。
 */
// 回滚 rename 也失败时的终错：retired-* 目录是唯一好副本，错误里点名它，供人工恢复。
function restoreRollbackFailedError(retiredDir, label, cause) {
  const err = new Error(
    `dsh-keepsake: 恢复失败，${label}/ 未能完成换入（回滚 rename 也失败），恢复前数据已保留在 ${basename(retiredDir)}，可手动改名恢复，切勿删除`,
  );
  err.code = "RESTORE_FAILED";
  err.cause = cause;
  return err;
}

export function restoreBackup(storageRoot, backupId, options = {}) {
  const copyFn = typeof options.copyFn === "function" ? options.copyFn : cpSync;
  const renameFn = typeof options.renameFn === "function" ? options.renameFn : renameSync;
  const rmFn = typeof options.rmFn === "function" ? options.rmFn : rmSync;
  const log = options.log ?? { warn: () => {} };
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
  const pRoot = join(storageRoot, "projects");
  const stamp = `${process.pid}-${Date.now()}`;
  const staging = join(storageRoot, `global.staging-${stamp}`);
  const stagingP = join(storageRoot, `projects.staging-${stamp}`);
  const retired = join(storageRoot, `global.retired-${stamp}`);
  const retiredP = join(storageRoot, `projects.retired-${stamp}`);
  const srcGlobal = join(src, GLOBAL_DIR_NAME);
  const srcProjects = join(src, "projects");
  const srcSettings = join(src, "settings.json");
  // 清理中断的退役目录：该目录的清理（rmFn）抛过异常，内容完整性无法确认——
  // 失败消息里必须如实说明，不得谎称「已完整保留」。
  const cleanupSuspect = new Set();

  // 退役副本清理：绝不在任何会触发回滚的 catch 里做。
  // 递归 rm 在 Windows 上非原子——可能删掉一部分条目再对锁定/只读子项抛 EPERM。
  // 换入成功后新数据已是本体，若把这个异常当「拷贝失败」回滚，就会把「被删残的退役目录」
  // 换回本体（=毁掉恢复前数据，且把已就位的恢复数据也删掉）。故单独 try/catch，只 warn 绝不回滚；
  // 清理中途失败会让该目录残缺，故失败消息里据 cleanupSuspect 如实说明「完整性未确认」。
  const cleanupRetired = (dir) => {
    if (!existsSync(dir)) return;
    try {
      rmFn(dir, { recursive: true, force: true });
    } catch (error) {
      cleanupSuspect.add(dir);
      log.warn?.(`恢复已成功，但退役目录清理未完成（残留可手动删除）: ${basename(dir)}`, error);
    }
  };

  // 两阶段换入一个根：现有 root 先改名退役，再把已就绪的 staging 换入。
  // 换入失败回滚退役副本；回滚 rename 也失败则点名保留该退役目录（人工恢复材料）。
  const swapIn = (rootDir, stageDir, retireDir, label) => {
    const hadOld = existsSync(rootDir);
    if (hadOld) renameFn(rootDir, retireDir);
    try {
      renameFn(stageDir, rootDir);
    } catch (error) {
      if (hadOld) {
        // 换入可能已留下半成品目录，先删再 rename（Windows 上 rename 撞已存在目录抛 EPERM）
        rmFn(rootDir, { recursive: true, force: true });
        try {
          renameFn(retireDir, rootDir); // 换入失败回滚旧档
        } catch {
          throw restoreRollbackFailedError(retireDir, label, error); // 保留退役副本供人工恢复
        }
      }
      throw error;
    }
    return hadOld;
  };

  try {
    // ---- global/：先拷进 staging，再换入（半成品拷贝绝不成为本体）----
    if (existsSync(srcGlobal)) copyFn(srcGlobal, staging, { recursive: true });
    else mkdirSync(staging, { recursive: true }); // 备份无 global = 恢复成空 global
    if (swapIn(gRoot, staging, retired, "global")) cleanupRetired(retired);
    if (existsSync(srcSettings)) copyFn(srcSettings, join(storageRoot, "settings.json"), { force: true });
    // ---- projects/：与 global/ 同构的两阶段换入（先 staging 拷贝，再换入）----
    // 旧备份无此目录则跳过——绝不因 meta 版本差异崩。
    if (existsSync(srcProjects)) {
      copyFn(srcProjects, stagingP, { recursive: true }); // 纯 staging：拷贝中途失败也不碰本体
      if (swapIn(pRoot, stagingP, retiredP, "projects")) cleanupRetired(retiredP);
    }
    return true;
  } catch (error) {
    // 失败保全：staging/stagingP 是拷贝中转，可安全清；retired-* 是恢复前的原始数据，一律保留作人工恢复材料
    rmFn(staging, { recursive: true, force: true });
    rmFn(stagingP, { recursive: true, force: true });
    if (error?.code === "RESTORE_FAILED") throw error; // 已是点名保留目录的终错，原样抛
    // 现场核对：既有非空的退役目录才算「已保留」；清理中断（可能已删残）或空的，
    // 如实说明完整性问题，绝不谎称「已完整保留」。
    const intact = [];
    const suspect = [];
    for (const dir of [retired, retiredP]) {
      if (!existsSync(dir)) continue;
      let nonEmpty = false;
      try { nonEmpty = readdirSync(dir).length > 0; } catch { nonEmpty = false; }
      if (cleanupSuspect.has(dir) || !nonEmpty) suspect.push(basename(dir));
      else intact.push(basename(dir));
    }
    const parts = [];
    if (intact.length > 0) parts.push(`恢复前数据已保留在 ${intact.join(" 与 ")}，可手动改名恢复，切勿删除`);
    if (suspect.length > 0) parts.push(`${suspect.join(" 与 ")} 清理中断，完整性未确认（请人工核实，切勿直接删除）`);
    const where = parts.length > 0 ? `；${parts.join("；")}` : "；未遗留 retired 副本目录";
    const err = new Error(`dsh-keepsake: 恢复失败（${String(error?.message ?? error)}）${where}`);
    err.code = "RESTORE_FAILED";
    throw err;
  }
}

// ---- 临时文件清扫 ----
/** 临时档到龄门槛（与 staging-* 同口径）：mtime 超 1 小时才算孤儿，避开在途写入。 */
const TMP_ORPHAN_MAX_AGE_MS = 3600_000;

/**
 * 清扫红线（一律不碰，无论多旧）：
 *   - retired-*：恢复失败留下的抢救副本（恢复前数据最后一份），删了就真没了；
 *   - backups / snapshots / surgical / trash：留档本体区，不是临时档。
 * retired-* 判据只看名字（rename 会继承旧 mtime，按 mtime 判会把刚留下的副本误删——
 * 已有测试钉住这条红线）。
 */
const SWEEP_PROTECTED_NAME = /retired-/i;
const SWEEP_PROTECTED_DIRS = new Set([BACKUPS_DIR_NAME, "snapshots", SURGICAL_DIR_NAME, "trash"]);

/** 残留临时档名：`*.tmp`（含 `*.json.tmp`，如 embeddings.json.tmp——原子写中断残留）。 */
function isStaleTmpName(name) {
  return /\.tmp$/i.test(name);
}

/** 该目录是否留档本体区（backups/snapshots/surgical/trash 及其子目录）：临时档清扫不进。
 *  判据取相对 storageRoot 的路径段——临时根本身的绝对路径里可能含同名目录（误判 = 漏扫或误删）。 */
function isProtectedSweepDir(root, storageRoot) {
  if (root === storageRoot) return false;
  const rel = relative(storageRoot, root);
  if (rel.length === 0 || rel.startsWith("..")) return true; // 根外目录：不在清扫面内
  for (const part of rel.split(/[\\/]/)) {
    if (SWEEP_PROTECTED_DIRS.has(part)) return true;
  }
  return false;
}

/**
 * 启动/写后收口时的临时档清扫。覆盖三类：
 *   1. `.tmp-*` 孤儿（writeAtomic 中断残留，命名带 .tmp- 即被认领）；
 *   2. `*.tmp` / `*.json.tmp` 残留（如 embeddings.json.tmp——另一套原子写命名，
 *      此前无人清扫，攒在 storage 根与子目录里）；
 *   3. restore 中断残留的 `*.staging-*` 目录（拷贝中转）。
 * 2、3 按 mtime 判龄（超 1 小时才清，避开在途写入）；解析不出年龄的一律不清
 * （宁可留垃圾，不可删在途数据）。retired-* / backups / snapshots / surgical / trash 永不碰。
 * @returns 清理个数
 */
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
    const protectedRoot = isProtectedSweepDir(root, storageRoot);
    for (const ent of names) {
      const full = join(root, ent.name);
      if (!ent.isDirectory() && ent.name.includes(".tmp-")) {
        try { rmSync(full, { force: true }); removed += 1; } catch { /* 下轮再清 */ }
      } else if (ent.isDirectory() && /^(global|projects)\.staging-/.test(ent.name) && root === storageRoot) {
        // staging-* 是拷贝中转（新建目录，mtime 可信）；仅清 1 小时以上的，避开在途恢复
        try {
          if (Date.now() - statSync(full).mtimeMs > TMP_ORPHAN_MAX_AGE_MS) {
            rmSync(full, { recursive: true, force: true });
            removed += 1;
          }
        } catch { /* 下轮再清 */ }
      } else if (!protectedRoot && !ent.isDirectory() && isStaleTmpName(ent.name)) {
        // 残留临时档（*.tmp / *.json.tmp）：红线名字与留档区一律跳过；到龄（mtime 超 1 小时）才清
        if (SWEEP_PROTECTED_NAME.test(ent.name)) continue;
        try {
          const age = Date.now() - statSync(full).mtimeMs;
          if (!Number.isFinite(age) || age <= TMP_ORPHAN_MAX_AGE_MS) continue; // 解析不出年龄 / 未到龄：不清
          rmSync(full, { force: true });
          removed += 1;
        } catch { /* 下轮再清 */ }
      }
    }
  }
  return removed;
}

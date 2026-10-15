// dsh-keepsake 写入安全面（v0.4.0：提取写入可逆 + 盲写阻断）。
//   手术式快照：覆盖/删除前把原文留档 <storageRoot>/backups/surgical/<ISO>-<pid>/，失败 fail-closed；
//   快照恢复端点的数据面（list/restore/prune，listBackups 侧区分 surgical 与全量备份）；
//   回收站：delete 复制进 <storageRoot>/trash/<entryId>/（副本先行），meta 落定后才删原件，
//      可 restore/purge；崩溃窗口内文件不再两头消失；
//   写后读校验 + 硬事实 token 比对（269→267 类误写检出；判据在 lib/hardfact.js）；
//   短 sha1 覆盖闸（盲写降级追加 / 哈希不符拒绝）；
//   提取批互斥锁：<storageRoot>/extract.lock（wx 原子建、stale 30s/未来时间戳可抢、token 释放）。
//
// 安全纪律：一切 name 过 sanitizeMemoryName + resolveSafeMemoryTarget 三道闸（含
//   trash/snapshot meta 里读回的 name/rootKey——meta 是盘上数据，不信任）；
//   backups/、trash/ 是包外非真源目录，FORMAT.md 后续声明可安全删除。
//
// 模块边界（遗产处置）：本文件只管 IO 侧安全面（快照/回收站/锁/写后校验/状态聚合）；
//   硬事实 token 的纯函数判据与 unified diff 片段在 lib/hardfact.js（避免两套判据漂移）。
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { INDEX_FILENAME, isInsideRoot, resolveSafeMemoryTarget, sanitizeMemoryName, sanitizeSegment } from "./filename.js";
import { buildIndexLine, mergeIndexContent, parseFrontmatterHead, parseIndexContent } from "./manifest.js";
import { HARDFACT_POLICIES, HARDFACT_POLICY_DEFAULT, diffHardFacts, unifiedDiffSnippet } from "./hardfact.js";

export const SURGICAL_DIR_NAME = "surgical";
export const TRASH_DIR_NAME = "trash";
export const LOCK_FILE_NAME = "extract.lock";
export const SURGICAL_KEEP_DEFAULT = 30;
export const TRASH_KEEP_DAYS_DEFAULT = 30;
export const LOCK_STALE_MS = 30_000;
export const DIFF_SNIPPET_MAX_CHARS = 2048;
/** 盲写降级追加时的分隔线（一行；保留旧正文的前提下给新内容一个显式边界）。 */
export const APPEND_SEPARATOR = "---";

// ---- 哈希 ----
export function sha1Full(text) {
  return createHash("sha1").update(String(text ?? ""), "utf8").digest("hex");
}
/** 短 sha1（8 hex）——manifest/提取契约/sha1 闸统一口径。 */
export function sha1Short(text) {
  return sha1Full(text).slice(0, 8);
}

// ---- rootKey 路由（meta 里记 rootKey，恢复时路由回原根） ----
/** memoryRoot 相对 storageRoot 的 '/' 分隔相对路径；同根返回 ""（独立 applyOps 兜底形态）。 */
export function rootKeyOf(storageRoot, rootDir) {
  const rel = relative(resolve(storageRoot), resolve(rootDir)).replace(/\\/g, "/");
  return rel === "." ? "" : rel;
}
/** rootKey → 绝对根目录；非法/越界返回 null（meta 不信任，恢复前必须过这道闸）。 */
export function rootDirOf(storageRoot, rootKey) {
  const key = String(rootKey ?? "");
  if (key === "") return resolve(storageRoot);
  const segments = key.split("/").filter((s) => s.length > 0);
  if (segments.length === 0 || segments.length > 6) return null;
  for (const segment of segments) if (sanitizeSegment(segment) === null) return null;
  const dir = resolve(storageRoot, ...segments);
  return isInsideRoot(storageRoot, dir) ? dir : null;
}

/** 快照 id 形态：<ISO 化时间戳>-<pid>（pid 段 ≤10 位：Windows pid 可达 8 位，位宽不够会让
 * 目录变成不可见不可清的孤儿；撞车重试带 -N 尾）；防路径穿越。 */
export function isSafeSnapshotId(id) {
  return typeof id === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d{1,10}(-\d{1,2})?$/.test(id) && id.length <= 80;
}
/** 快照 id = <ISO 化时间戳>-<pid>（规格 跨实例同毫秒撞车由 pid 天然区分）。 */
function snapshotId(now = Date.now()) {
  return `${isoId(now)}-${process.pid}`;
}
/** 回收站 entryId 形态：ISO 化时间戳（撞车重试带 -N 尾）。 */
export function isSafeTrashId(id) {
  return typeof id === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d{1,2})?$/.test(id) && id.length <= 64;
}

function isoId(now = Date.now()) {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

export function surgicalRoot(storageRoot) {
  return join(storageRoot, "backups", SURGICAL_DIR_NAME);
}
export function trashRoot(storageRoot) {
  return join(storageRoot, TRASH_DIR_NAME);
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ---- settings 归一（三项新设置；缺键走默认，向后兼容旧 settings.json） ----
/**
 * 从 settings 对象取生效的安全面参数。
 * @returns {{ surgicalKeep:number, trashKeepDays:number, hardfactPolicy:"warn"|"block" }}
 */
export function resolveSafetySettings(settings) {
  const s = settings !== null && typeof settings === "object" ? settings : {};
  const keep = Number(s.surgicalKeep);
  const days = Number(s.trashKeepDays);
  const policy = HARDFACT_POLICIES.has(s.hardfactPolicy) ? s.hardfactPolicy : HARDFACT_POLICY_DEFAULT;
  return {
    surgicalKeep: Number.isInteger(keep) && keep > 0 ? keep : SURGICAL_KEEP_DEFAULT,
    trashKeepDays: Number.isFinite(days) && days >= 0 ? days : TRASH_KEEP_DAYS_DEFAULT,
    hardfactPolicy: policy,
  };
}

// ---- 内部工具：剥 frontmatter 取正文（盲写降级追加用；不依赖 global-store 防循环依赖） ----
function bodyOnly(content) {
  const text = String(content ?? "");
  if (!text.startsWith("---")) return text.trim();
  const end = text.indexOf("\n---", 3);
  if (end < 0) return text.trim();
  return text.slice(end + 4).trim();
}

/**
 * 盲写降级：保留旧正文，新内容以一行分隔线追加。
 * 旧档 frontmatter 与正文原样保留；新正文（剥掉自己的 frontmatter）接在分隔线后。
 * @returns 合并后的完整文件文本
 */
export function appendDowngradedWrite(oldContent, newContent) {
  const oldText = String(oldContent ?? "").trimEnd();
  const newBody = bodyOnly(newContent);
  return `${oldText}\n\n${APPEND_SEPARATOR}\n\n${newBody}\n`;
}

// ---- MEMORY.md 索引对账（恢复/回滚共用） ----
/** 根目录 MEMORY.md 按 touched/deleted 对账重建（原子写）。 */
export function reconcileIndex(rootDir, touchedEntries, deletedNames = []) {
  const indexPath = join(rootDir, INDEX_FILENAME);
  const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  const merged = mergeIndexContent(existing, touchedEntries, deletedNames);
  mkdirSync(rootDir, { recursive: true });
  const tmp = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, merged, "utf8");
  renameSync(tmp, indexPath);
}

function indexLineFor(rootDir, name, content) {
  try {
    const { map } = parseIndexContent(existsSync(join(rootDir, INDEX_FILENAME)) ? readFileSync(join(rootDir, INDEX_FILENAME), "utf8") : "");
    const hit = map.get(String(name).toLowerCase());
    if (hit !== void 0) return hit;
  } catch { /* 读不到就按 frontmatter 重建 */ }
  const front = parseFrontmatterHead(content);
  return buildIndexLine(front.title ?? front.name ?? name.replace(/\.md$/i, ""), name, front.description ?? "");
}

// ---- 手术式快照 ----
/**
 * 批前快照：把本批破坏性 op（覆盖既有/删除）触及的原文留档。
 * @param ops 预解析清单 [{ name, rootKey, action: "overwrite"|"delete", target, content? }]（content 缺省读盘）
 *   name 一律先过 sanitizeMemoryName（三道闸第一道），不过的条目跳过（无原文可留）。
 * @returns { id, dir, files, manifestPath }；失败抛错（调用方 fail-closed 阻断破坏 op）。
 */
export function createSurgicalSnapshot(storageRoot, { originSessionId = "", ops = [], now = Date.now() } = {}) {
  const root = surgicalRoot(storageRoot);
  mkdirSync(root, { recursive: true });
  let id = snapshotId(now);
  let dir = join(root, id);
  for (let i = 0; existsSync(dir) && i < 50; i += 1) {
    id = `${snapshotId(now)}-${i}`; // 同 ms 同 pid 撞车（罕见）：-N 尾
    dir = join(root, id);
  }
  mkdirSync(join(dir, "files"), { recursive: true });
  const files = [];
  const summary = [];
  for (const op of ops) {
    const safeRel = sanitizeMemoryName(op.name ?? "");
    if (safeRel === null) continue; // 未过闸：无原文可留（调用方已拦，此处防御）
    summary.push({ action: op.action, name: safeRel, rootKey: op.rootKey ?? "" });
    const rootDir = rootDirOf(storageRoot, op.rootKey ?? "");
    if (rootDir === null) continue; // 非法 rootKey：无原文可留（调用方已过闸，此处防御）
    let content = op.content;
    if (typeof content !== "string") {
      try {
        content = readFileSync(op.target, "utf8");
      } catch {
        continue; // 目标已消失：无可留档原文
      }
    }
    const copyPath = op.rootKey ? join(dir, "files", ...String(op.rootKey).split("/"), safeRel) : join(dir, "files", safeRel);
    mkdirSync(dirname(copyPath), { recursive: true });
    writeFileSync(copyPath, content, "utf8");
    files.push({
      name: safeRel,
      rootKey: op.rootKey ?? "",
      sha1: sha1Short(content),
      action: op.action,
      indexLine: indexLineFor(rootDir, safeRel, content),
    });
  }
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ batchId: id, originSessionId, createdAt: new Date(now).toISOString(), ops: summary, files }, null, 2) + "\n", "utf8");
  return { id, dir, files, manifestPath };
}

/** 快照列表（新在前）。 */
export function listSurgicalSnapshots(storageRoot) {
  const root = surgicalRoot(storageRoot);
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && isSafeSnapshotId(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const id of dirs) {
    const meta = readJsonSafe(join(root, id, "manifest.json"));
    out.push({
      id,
      createdAt: meta?.createdAt ?? null,
      originSessionId: meta?.originSessionId ?? "",
      fileCount: Array.isArray(meta?.files) ? meta.files.length : 0,
      files: Array.isArray(meta?.files)
        ? meta.files.map((f) => ({ name: f.name, rootKey: f.rootKey ?? "", sha1: f.sha1 ?? "", action: f.action ?? "overwrite" }))
        : [],
    });
  }
  out.sort((a, b) => (a.id < b.id ? 1 : -1));
  return out;
}

/**
 * 恢复快照：name 省略=整快照；只回拷 meta.files 里 name 命中的条目，恢复后按根对账 MEMORY.md。
 * name/rootKey 都过三道闸（meta 是盘上数据，不信任）。
 * @returns { restored: string[], indexReconciled: boolean }
 */
export function restoreSurgicalSnapshot(storageRoot, id, { name, log = { warn: () => {} } } = {}) {
  if (!isSafeSnapshotId(id)) {
    const err = new Error(`dsh-keepsake: 非法快照 id "${String(id)}"`);
    err.code = "SNAPSHOT_INVALID";
    throw err;
  }
  const dir = join(surgicalRoot(storageRoot), id);
  const meta = readJsonSafe(join(dir, "manifest.json"));
  if (meta === null) {
    const err = new Error(`dsh-keepsake: 快照不存在或 manifest 损坏 "${id}"`);
    err.code = "SNAPSHOT_MISSING";
    throw err;
  }
  const want = typeof name === "string" && name.length > 0 ? sanitizeMemoryName(name) : null;
  if (typeof name === "string" && name.length > 0 && want === null) {
    const err = new Error("dsh-keepsake: name 未通过安全闸");
    err.code = "SNAPSHOT_INVALID";
    throw err;
  }
  const restored = [];
  const touchedByRoot = new Map();
  for (const file of Array.isArray(meta.files) ? meta.files : []) {
    const safeRel = sanitizeMemoryName(file?.name ?? "");
    if (safeRel === null) { log.warn(`快照条目 name 非法已跳过: ${String(file?.name).slice(0, 80)}`); continue; }
    if (want !== null && safeRel !== want) continue;
    const rootDir = rootDirOf(storageRoot, file.rootKey ?? "");
    if (rootDir === null) { log.warn(`快照条目 rootKey 非法已跳过: ${String(file.rootKey).slice(0, 80)}`); continue; }
    const target = resolveSafeMemoryTarget(rootDir, safeRel);
    if (target === null) continue;
    const copyPath = file.rootKey ? join(dir, "files", ...String(file.rootKey).split("/"), safeRel) : join(dir, "files", safeRel);
    if (!existsSync(copyPath)) { log.warn(`快照副本缺失: ${id}/${safeRel}`); continue; }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(copyPath, target);
    restored.push(safeRel);
    const bucket = touchedByRoot.get(rootDir) ?? [];
    bucket.push({ name: safeRel, line: typeof file.indexLine === "string" && file.indexLine.length > 0 ? file.indexLine : indexLineFor(rootDir, safeRel, readFileSync(copyPath, "utf8")) });
    touchedByRoot.set(rootDir, bucket);
  }
  let indexReconciled = false;
  for (const [rootDir, touched] of touchedByRoot) {
    reconcileIndex(rootDir, touched, []);
    indexReconciled = true;
  }
  return { restored, indexReconciled };
}

/**
 * 恢复前的留底：把 restore 将【覆盖】的现存目标文件原文复制进一份手术快照（action="restore"）。
 *   - 没有现存目标会被覆盖（纯回填）→ null，不建空快照；
 *   - 将覆盖的原文读不出来 → 抛 SNAPSHOT_READ_FAILED（留不了底就不能覆盖：fail-closed）；
 *   - 快照本体失败 → createSurgicalSnapshot 抛错（调用方 500 且不动任何数据）。
 * id/name 的合法性校验仍由 restore 本体负责（400/404 语义不变）；meta 读不到按「无可覆盖目标」放行，
 * 交给 restore 本体抛 MISSING。
 * @returns 快照 id | null（无现存目标被覆盖）
 */
export function createPreRestoreSnapshot(storageRoot, kind, id, { name, log = { warn: () => {} } } = {}) {
  const isTrash = kind === "trash";
  if (!isTrash && kind !== "snapshot") {
    const err = new Error(`dsh-keepsake: 未知留底类型 "${String(kind)}"`);
    err.code = "SNAPSHOT_INVALID";
    throw err;
  }
  if (isTrash ? !isSafeTrashId(id) : !isSafeSnapshotId(id)) return null; // 非法 id：restore 本体给 400
  const meta = isTrash
    ? readJsonSafe(join(trashRoot(storageRoot), id, "meta.json"))
    : readJsonSafe(join(surgicalRoot(storageRoot), id, "manifest.json"));
  if (meta === null) return null; // 条目不存在/损坏：restore 本体会给 404，此处无可覆盖目标
  const want = typeof name === "string" && name.length > 0 ? sanitizeMemoryName(name) : null;
  if (typeof name === "string" && name.length > 0 && want === null) return null; // name 未过闸：restore 本体 400
  const ops = [];
  for (const file of Array.isArray(meta.files) ? meta.files : []) {
    const safeRel = sanitizeMemoryName(file?.name ?? "");
    if (safeRel === null) continue;
    if (want !== null && safeRel !== want) continue;
    const rootDir = rootDirOf(storageRoot, file.rootKey ?? "");
    if (rootDir === null) continue;
    const target = resolveSafeMemoryTarget(rootDir, safeRel);
    if (target === null || !existsSync(target)) continue;
    let content;
    try {
      content = readFileSync(target, "utf8");
    } catch (error) {
      const err = new Error(`dsh-keepsake: 恢复前留底读取失败（${safeRel}），无法保证可逆`);
      err.code = "SNAPSHOT_READ_FAILED";
      err.cause = error;
      throw err;
    }
    ops.push({ name: safeRel, rootKey: file.rootKey ?? "", action: "restore", target, content });
  }
  if (ops.length === 0) return null;
  const origin = typeof meta.originSessionId === "string" && meta.originSessionId.length > 0
    ? `restore:${meta.originSessionId}`
    : `restore:${kind}/${id}`;
  return createSurgicalSnapshot(storageRoot, { originSessionId: origin, ops }).id;
}

/** 快照滚动保留：只留最新 keep 份。 @returns 删除份数
 * options.rmFn 仅供测试注入（默认走 fs 原生 rmSync）——用于确定性触发「删不掉 → warn」分支。 */
export function pruneSurgicalSnapshots(storageRoot, keep = SURGICAL_KEEP_DEFAULT, log = { warn: () => {} }, options = {}) {
  const limit = Number.isInteger(keep) && keep > 0 ? keep : SURGICAL_KEEP_DEFAULT;
  const rmFn = typeof options.rmFn === "function" ? options.rmFn : rmSync;
  const root = surgicalRoot(storageRoot);
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && isSafeSnapshotId(d.name)).map((d) => d.name);
  } catch {
    return 0;
  }
  dirs.sort().reverse();
  let removed = 0;
  for (const stale of dirs.slice(limit)) {
    try {
      rmFn(join(root, stale), { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      // 删不掉不静默：下轮还会再试，但不留无痕失败（占用/权限/磁盘满）
      log.warn(`手术式快照清理失败（下轮再试）: ${stale}`, error);
    }
  }
  return removed;
}

/** /state.safety 盘上面：surgicalBackups 数量 + 最近快照时刻。 */
export function surgicalDiskState(storageRoot) {
  const list = listSurgicalSnapshots(storageRoot);
  return { surgicalBackups: list.length, lastSnapshotAt: list.length > 0 ? list[0].createdAt : null };
}

// ---- 回收站 ----
/** 条目已成立的判据：meta.json 是在盘文件（半成品残条/被占位的 meta 不算占位）。 */
function trashEntryEstablished(root, entryId) {
  try {
    return statSync(join(root, entryId, "meta.json")).isFile();
  } catch {
    return false;
  }
}

/**
 * 回收站条目落盘（副本先行；崩溃窗口内文件不再两头消失）：
 *   1. trash/<id>/files/ 逐条写【副本】——原件原地不动；
 *   2. meta.json 落定才算条目成立——写不进去（路径被占/权限/磁盘）→ 拆掉半成品条目并抛错，
 *      原件一个都没碰（调用方按失败处理，记忆根不丢文件）；
 *   3. 条目成立后才逐个删原件：单个删不掉只 warn 不回滚——副本+meta 已齐，可逆性已经保住，
 *      原件残留只是盘上多一份重复。
 * @param files [{ name, rootKey, sha1, content, moveFromAbs?, indexLine? }]
 *   content 为留档文本（调用方已读盘）；moveFromAbs 为可选的原件绝对路径。
 * @returns { entryId, dir }；全部条目被闸拦时 { entryId: null, dir: null }（不留空幽灵条目）
 * @throws TRASH_WRITE_FAILED（meta 写不进去：条目不成立，原件未动）
 */
function writeTrashEntry(storageRoot, { originSessionId, files, action, now, log = { warn: () => {} } }) {
  const root = trashRoot(storageRoot);
  mkdirSync(root, { recursive: true });
  let entryId = isoId(now);
  // 撞车判据 = 「meta.json 是在盘文件」：无 meta 的残条目录可直接接管（顺带清掉崩溃 litter）
  for (let i = 0; trashEntryEstablished(root, entryId) && i < 50; i += 1) {
    entryId = `${isoId(now)}-${i}`;
  }
  const dir = join(root, entryId);
  mkdirSync(join(dir, "files"), { recursive: true });
  const metaFiles = [];
  const originals = []; // 条目成立后才逐个删的原件清单
  try {
    for (const file of files) {
      const safeRel = sanitizeMemoryName(file.name ?? "");
      if (safeRel === null) continue; // 未过闸的条目不进回收站（meta 不可信，盘上数据）
      const copyPath = file.rootKey ? join(dir, "files", ...String(file.rootKey).split("/"), safeRel) : join(dir, "files", safeRel);
      mkdirSync(dirname(copyPath), { recursive: true });
      writeFileSync(copyPath, String(file.content ?? ""), "utf8");
      if (typeof file.moveFromAbs === "string" && file.moveFromAbs.length > 0) originals.push({ abs: file.moveFromAbs, name: safeRel });
      metaFiles.push({ name: safeRel, rootKey: file.rootKey ?? "", sha1: file.sha1 ?? "", action: file.action ?? action ?? "delete", indexLine: file.indexLine ?? "" });
    }
  } catch (error) {
    // 拷贝中途失败（磁盘满/权限等）：不留零文件幽灵条目——拆掉半成品目录再抛。
    // 原件自始至终未动（源文件读取在 trashMemoryFile，此处只写副本）。
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  if (metaFiles.length === 0) {
    // 全部条目被闸拦：不留空条目目录（否则 listTrash 出现零文件幽灵条目）
    rmSync(dir, { recursive: true, force: true });
    return { entryId: null, dir: null };
  }
  try {
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ entryId, createdAt: new Date(now).toISOString(), originSessionId, files: metaFiles }, null, 2) + "\n", "utf8");
  } catch (error) {
    // meta 写不进去 = 条目不成立：拆掉半成品（含刚写的副本），原件自始至终未动
    rmSync(dir, { recursive: true, force: true });
    const err = new Error(`dsh-keepsake: 回收站条目 meta 写入失败（${entryId}），已中止且未动原件`);
    err.code = "TRASH_WRITE_FAILED";
    err.cause = error;
    throw err;
  }
  for (const original of originals) {
    try {
      rmSync(original.abs, { force: true });
    } catch (error) {
      // 副本+meta 已齐：删不掉只是留份重复，warn 留痕即可（不回滚已成立的条目）
      log.warn(`回收站条目已建立但原件删除失败（副本已在案）: ${original.name}`, error);
    }
  }
  return { entryId, dir };
}

/**
 * delete 语义：把文件【复制】进 trash/<entryId>/files/，meta 落定后才删原件（崩溃窗内不丢文件）。
 * @returns { entryId, name } | null（目标不存在/未过闸/读原文失败）
 * @throws TRASH_WRITE_FAILED（meta 写不进去：条目不成立，原件未动——调用方按失败处理）
 */
export function trashMemoryFile(storageRoot, { rootKey, name, originSessionId = "", log = { warn: () => {} }, now = Date.now() } = {}) {
  const rootDir = rootDirOf(storageRoot, rootKey ?? "");
  const safeRel = sanitizeMemoryName(name ?? "");
  if (rootDir === null || safeRel === null) return null;
  const target = resolveSafeMemoryTarget(rootDir, safeRel);
  if (target === null || !existsSync(target)) return null;
  let content = "";
  try {
    content = readFileSync(target, "utf8");
  } catch (error) {
    log.warn(`回收站读原文失败（按未删处理）: ${safeRel}`, error);
    return null;
  }
  // 副本先行：content 已在内存，原件删除推迟到 meta 落定之后（由 writeTrashEntry 负责）
  const entry = writeTrashEntry(storageRoot, {
    originSessionId,
    action: "delete",
    now,
    log,
    files: [{ name: safeRel, rootKey: rootKey ?? "", sha1: sha1Short(content), content, moveFromAbs: target, indexLine: indexLineFor(rootDir, safeRel, content) }],
  });
  if (entry.entryId === null) return null;
  return { entryId: entry.entryId, name: safeRel };
}

/**
 * 标本隔离（校验失败的新档不删）：有快照进快照 failed/，否则落回收站（action=verify-failed）。
 * 回收站分支同样副本先行：隔离失败不抛（extract 紧接着回滚旧文，抛错会跳过回滚留下坏档）。
 * @returns { at: "snapshot"|"trash"|null, entryId? }
 */
export function quarantineSpecimen(storageRoot, { rootKey, name, originSessionId = "", snapshotDir = null, log = { warn: () => {} }, now = Date.now() } = {}) {
  const rootDir = rootDirOf(storageRoot, rootKey ?? "");
  const safeRel = sanitizeMemoryName(name ?? "");
  if (rootDir === null || safeRel === null) return { at: null };
  const target = resolveSafeMemoryTarget(rootDir, safeRel);
  if (target === null || !existsSync(target)) return { at: null };
  if (typeof snapshotDir === "string" && snapshotDir.length > 0) {
    const dest = rootKey ? join(snapshotDir, "failed", ...String(rootKey).split("/"), safeRel) : join(snapshotDir, "failed", safeRel);
    mkdirSync(dirname(dest), { recursive: true });
    try {
      renameSync(target, dest);
    } catch {
      copyFileSync(target, dest);
      rmSync(target, { force: true });
    }
    return { at: "snapshot" };
  }
  let content = "";
  try {
    content = readFileSync(target, "utf8");
  } catch {
    return { at: null }; // 读不到原文：无可留档，隔离作废（回滚会覆盖坏档）
  }
  try {
    const entry = writeTrashEntry(storageRoot, {
      originSessionId,
      action: "verify-failed",
      now,
      log,
      files: [{ name: safeRel, rootKey: rootKey ?? "", sha1: "", content, moveFromAbs: target }],
    });
    if (entry.entryId === null) return { at: null };
    return { at: "trash", entryId: entry.entryId };
  } catch (error) {
    // 隔离失败按未隔离处理：extract 的回滚（写回批前原文）紧接着执行，抛错会跳过回滚
    log.warn(`回收站隔离失败（标本留待回滚覆盖）: ${safeRel}`, error);
    return { at: null };
  }
}

export function listTrash(storageRoot) {
  const root = trashRoot(storageRoot);
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && isSafeTrashId(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const id of dirs) {
    const meta = readJsonSafe(join(root, id, "meta.json"));
    if (meta === null) continue; // 无 meta = 条目未成立（崩溃 litter/幽灵残条），不对用户可见
    out.push({
      id,
      createdAt: meta?.createdAt ?? null,
      originSessionId: meta?.originSessionId ?? "",
      files: Array.isArray(meta?.files)
        ? meta.files.map((f) => ({ name: f.name, rootKey: f.rootKey ?? "", sha1: f.sha1 ?? "", action: f.action ?? "delete" }))
        : [],
    });
  }
  out.sort((a, b) => (a.id < b.id ? 1 : -1));
  return out;
}

/**
 * 恢复回收站条目：name 省略=整条目；文件回拷原根并对账索引，已恢复文件从条目移除（清空即删条目）。
 * @returns { restored: string[], indexReconciled: boolean }
 */
export function restoreTrash(storageRoot, id, { name, log = { warn: () => {} } } = {}) {
  if (!isSafeTrashId(id)) {
    const err = new Error(`dsh-keepsake: 非法回收站 id "${String(id)}"`);
    err.code = "TRASH_INVALID";
    throw err;
  }
  const dir = join(trashRoot(storageRoot), id);
  const meta = readJsonSafe(join(dir, "meta.json"));
  if (meta === null) {
    const err = new Error(`dsh-keepsake: 回收站条目不存在 "${id}"`);
    err.code = "TRASH_MISSING";
    throw err;
  }
  const want = typeof name === "string" && name.length > 0 ? sanitizeMemoryName(name) : null;
  if (typeof name === "string" && name.length > 0 && want === null) {
    const err = new Error("dsh-keepsake: name 未通过安全闸");
    err.code = "TRASH_INVALID";
    throw err;
  }
  const restored = [];
  const remaining = [];
  const touchedByRoot = new Map();
  for (const file of Array.isArray(meta.files) ? meta.files : []) {
    const safeRel = sanitizeMemoryName(file?.name ?? "");
    const rootDir = safeRel === null ? null : rootDirOf(storageRoot, file.rootKey ?? "");
    const copyPath = safeRel !== null && rootDir !== null
      ? (file.rootKey ? join(dir, "files", ...String(file.rootKey).split("/"), safeRel) : join(dir, "files", safeRel))
      : null;
    const keep = copyPath === null || !existsSync(copyPath) || (want !== null && safeRel !== want);
    if (keep) {
      remaining.push(file);
      if (want !== null && safeRel !== null && safeRel === want) log.warn(`回收站副本缺失: ${id}/${safeRel}`);
      continue;
    }
    const target = resolveSafeMemoryTarget(rootDir, safeRel);
    if (target === null) {
      remaining.push(file);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    try {
      renameSync(copyPath, target);
    } catch {
      copyFileSync(copyPath, target);
      rmSync(copyPath, { force: true });
    }
    restored.push(safeRel);
    const bucket = touchedByRoot.get(rootDir) ?? [];
    bucket.push({ name: safeRel, line: typeof file.indexLine === "string" && file.indexLine.length > 0 ? file.indexLine : indexLineFor(rootDir, safeRel, readFileSync(target, "utf8")) });
    touchedByRoot.set(rootDir, bucket);
  }
  let indexReconciled = false;
  for (const [rootDir, touched] of touchedByRoot) {
    reconcileIndex(rootDir, touched, []);
    indexReconciled = true;
  }
  if (remaining.length > 0) {
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...meta, files: remaining }, null, 2) + "\n", "utf8");
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
  return { restored, indexReconciled };
}

/**
 * 清除回收站条目：id=清单条；olderThanDays=清 N 天前；两参都省=全清。
 * olderThanDays 一旦【显式给出】（含显式 null）就必须是 ≥0 的有限数——null/负数/Infinity
 * 显式抛错（TRASH_INVALID），绝不静默落进「全清」分支（一次误清光）。区分「键缺省」（刻意的
 * 全清语义）与「键存在但值为 null」（非法入参）：两者在此层同口径把关，不依赖调用方。
 * @returns { purged: number }（清除条目数）
 */
export function purgeTrash(storageRoot, opts = {}) {
  const { id, olderThanDays, now = Date.now(), log = { warn: () => {} } } = opts;
  const root = trashRoot(storageRoot);
  // id/olderThanDays 校验前置到枚举目录之前：非法入参必须显式抛 TRASH_INVALID，
  // 与文件系统状态无关——否则回收站根不可读（全新环境）时会提前 return，
  // 把非法 id 静默当成功（purgeTrash(root,{id:"bogus"}) 返回 {purged:0}）。
  const daysProvided = Object.prototype.hasOwnProperty.call(opts, "olderThanDays") && olderThanDays !== void 0;
  const days = daysProvided ? olderThanDays : void 0;
  if (typeof id === "string" && id.length > 0) {
    if (!isSafeTrashId(id)) {
      const err = new Error(`dsh-keepsake: 非法回收站 id "${String(id)}"`);
      err.code = "TRASH_INVALID";
      throw err;
    }
  } else if (daysProvided) {
    if (typeof days !== "number" || !Number.isFinite(days) || days < 0) {
      const err = new Error(`dsh-keepsake: olderThanDays 必须为 ≥0 的有限数（收到 ${String(olderThanDays)}）`);
      err.code = "TRASH_INVALID";
      throw err;
    }
  }
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && isSafeTrashId(d.name)).map((d) => d.name);
  } catch {
    return { purged: 0 };
  }
  let victims = dirs;
  if (typeof id === "string" && id.length > 0) {
    victims = dirs.includes(id) ? [id] : [];
  } else if (days !== void 0) {
    const cutoff = now - days * 86400_000;
    victims = dirs.filter((d) => {
      const meta = readJsonSafe(join(root, d, "meta.json"));
      const at = meta?.createdAt ? Date.parse(meta.createdAt) : NaN;
      return Number.isFinite(at) ? at < cutoff : true; // 无 createdAt 的残条按最旧处理
    });
  }
  let purged = 0;
  for (const victim of victims) {
    try {
      rmSync(join(root, victim), { recursive: true, force: true });
      purged += 1;
    } catch (error) {
      // 删不掉不静默：下轮还会再试，但不留无痕失败（占用/权限/磁盘满）
      log.warn(`回收站清理失败（下轮再试）: ${victim}`, error);
    }
  }
  return { purged };
}

/** 写路径顺带滚动清理：超过 trashKeepDays 的条目清掉。 @returns 清除条目数 */
export function pruneTrash(storageRoot, keepDays = TRASH_KEEP_DAYS_DEFAULT, now = Date.now(), log = { warn: () => {} }) {
  const days = Number.isFinite(keepDays) && keepDays >= 0 ? keepDays : TRASH_KEEP_DAYS_DEFAULT;
  return purgeTrash(storageRoot, { olderThanDays: days, now, log }).purged;
}

export function trashDiskState(storageRoot) {
  return { trashPending: listTrash(storageRoot).length };
}

/** /state.safety 的盘上面两项（surgicalBackups/lastSnapshotAt/trashPending）。 */
export function safetyDiskState(storageRoot) {
  return { ...surgicalDiskState(storageRoot), ...trashDiskState(storageRoot) };
}

// ---- 提取批互斥锁（跨实例；wx 原子建、stale 30s/未来时间戳可抢、token 释放） ----
/**
 * 抢提取批锁。锁被占 → { acquired:false }（调用方 fail-closed 阻断破坏 op）。
 * 进程死锁靠 stale 超时接管；at 落在未来（时钟漂移/篡改）同样按 stale 接管，不永久占位；
 * finally 里 release()。
 * release 带 token 比对：stale 接管后若锁已被他人重抢，绝不误删新主的锁。
 */
export function acquireExtractLock(storageRoot, { staleMs = LOCK_STALE_MS, now = Date.now } = {}) {
  const file = join(storageRoot, LOCK_FILE_NAME);
  const noop = { acquired: false, stolen: false, release: () => {} };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = `${process.pid}-${now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      mkdirSync(storageRoot, { recursive: true });
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: now(), token }) + "\n", { encoding: "utf8", flag: "wx" });
      return {
        acquired: true,
        stolen: attempt > 0,
        release: () => {
          try {
            const cur = readJsonSafe(file);
            // 只拆自己的锁（token 不符 = 已被他人 stale 接管/重抢，绝不误删）
            if (cur === null || cur.token === token || (cur.pid === process.pid && cur.token === void 0)) rmSync(file, { force: true });
          } catch { /* 锁清理失败：靠 stale 超时 */ }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") return noop; // 建锁异常=锁面不可用，按未获锁处理（fail-closed）
      let at = 0;
      try {
        at = JSON.parse(readFileSync(file, "utf8")).at ?? 0;
      } catch {
        at = 0; // 锁文件损坏：按最旧处理（可抢）
      }
      // age<0（at 落在未来：时钟漂移/盘上篡改）按 stale 处理——否则未来时间戳会把锁
      // 「永久占住」，谁都不知多久后才敢抢。解析失败 at=0 → age 巨大 → 同样按最旧。
      const age = now() - at;
      if (Number.isFinite(age) && age >= 0 && age <= staleMs) return noop;
      try {
        rmSync(file, { force: true }); // stale 接管：拆旧锁重抢一次
      } catch {
        return noop;
      }
    }
  }
  return noop;
}

// ---- 写后读校验 ----
/**
 * 写后读校验：frontmatter 四字段（name/description/metadata.type/node_type）可解析、
 * name 与文件名归一口径一致、正文非空、长度合规（≤ maxBodyChars）。
 * @returns { ok: true } | { ok: false, reason }
 */
export function verifyMemoryFileContent(content, { expectedName, maxBodyChars = 20000 } = {}) {
  const text = String(content ?? "");
  if (!text.startsWith("---")) return { ok: false, reason: "frontmatter 缺失" };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { ok: false, reason: "frontmatter 未闭合" };
  const head = text.slice(0, end);
  const hasName = /^name:\s*"?.+"?\s*$/m.test(head);
  const hasDescription = /^description:\s*.*$/m.test(head);
  const hasType = /^\s+type:\s*\S+\s*$/m.test(head);
  const hasNodeType = /^node_type:\s*"?\S+"?\s*$/m.test(head);
  if (!hasName || !hasDescription || !hasType || !hasNodeType) return { ok: false, reason: "frontmatter 四字段不全" };
  const front = parseFrontmatterHead(text);
  if (typeof expectedName === "string" && expectedName.length > 0 && front.name !== expectedName) {
    return { ok: false, reason: `name 与文件名不一致（${String(front.name)} ≠ ${expectedName}）` };
  }
  const body = text.slice(end + 4).trim();
  if (body.length === 0) return { ok: false, reason: "正文为空" };
  if (body.length > maxBodyChars) return { ok: false, reason: `正文超长（${body.length} > ${maxBodyChars}）` };
  return { ok: true };
}

// ---- 硬事实比对（判据在 lib/hardfact.js：token 带类型 + hybrid 近值判据） ----
/**
 * 新旧正文硬事实对比（薄封装，供 extract.js 写路径调用）。
 * @returns {{ dropped: Array<{type,value,raw,reason}>, diff: string }}
 *   dropped 为空 = 无告警；diff 为 ≤2KB 的 unified diff 片段（日志附件）。
 */
export function hardfactWritebackReport(oldText, newText) {
  const { dropped } = diffHardFacts(oldText, newText);
  if (dropped.length === 0) return { dropped: [], diff: "" };
  return { dropped, diff: unifiedDiffSnippet(oldText, newText, { maxChars: DIFF_SNIPPET_MAX_CHARS }) };
}

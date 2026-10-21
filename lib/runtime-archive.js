// dsh-keepsake 运行时记忆层的「动作层」——RUNTIME-FORMAT.md v2.1 §六（淘汰归档 / 归档移回）、
// §五 pin、§八 强制重编的施工落点。
//
// 分层定位：lib/runtime.js 是纯编译器（读真源→产物，绝不搬文件）；本文件是**唯一搬移入口**
// 的实现——面板确认触发的归档执行、归档移回、pin 端点、面板强制重编都落在这里；api.js 只做
// 路由与出参。
//
// 为什么 renderArchivedEntry 落在这里（而不是 global-store.js）：
//   - §6.3 要求 long-term 归档条目在全局 schema 上加 origin 三字段，且「不走 createEntry 重写
//     （丢 originSessionId）、不做字面 rename」；global-store.js 的 writeEntryDirect/createEntry
//     都走 renderGlobalEntry（无 origin 字段位），不动它（并行批次约定 + 最小 diff）；
//   - 归档是 runtime 层的动作（候选清单来自 runtime.json），把归档格式与执行序列放一起，
//     global-store 保持「通用全局 CRUD」的职责不膨胀。
//
// 全序列（§6.2）：抢锁（调用方 api.js 持有）→ 逐条校验仍是候选 → 手术式快照
//   → 归档重写 global/long-term/ → 索引对账（只重建、绝不手改）→ 持久审计 → 失效+重编
//   → 滚动清理 backups/evict-*（保留最近 10 份）。
//
// 纪律：
//   - 编译绝不搬文件（定案 10-20①）——搬移只发生在本文件的 evictEntries/restoreArchivedEntry；
//   - 索引文件（各根 MEMORY.md）永不被写路径直接触碰，只经 mergeIndexContent 重建；
//   - 审计（evict-audit.jsonl）失败按硬失败处理（runtime-log.js 契约：审计链路不吞错）；
//   - 快照失败不静默：该条进 skipped[] 且不搬。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { INDEX_FILENAME, resolveSafeMemoryTarget, sanitizeMemoryName } from "./filename.js";
import { buildIndexLine, mergeIndexContent, parseFrontmatterHead } from "./manifest.js";
import { categoryDir, isCategoryId, renderGlobalEntry, stripFrontmatter, updateEntry } from "./global-store.js";
import { renderMemoryFile } from "./extract.js";
import { appendCompileJournal, appendEvictAudit } from "./runtime-log.js";
import {
  compileScope,
  ensureCompiled,
  invalidateRuntimeCache,
  isValidScope,
  listScopes,
  writeRuntimeArtifacts,
} from "./runtime.js";

/** 归档去向分类（§3.3：long-term 不在 L0 候选池——搬动引起的 mtime 变化不会把条目选回 L0）。 */
export const ARCHIVE_CATEGORY_ID = "long-term";
/** 归档快照目录前缀与保留份数（§6.2-9：backups/evict-* 保留最近 10 份，按目录名 ts 排序裁旧）。 */
export const EVICT_BACKUP_PREFIX = "evict-";
export const EVICT_BACKUP_KEEP = 10;
/** 项目 scope 形态（与 RUNTIME-FORMAT §十一 matchRuntime 同口径）。 */
const PROJECT_SCOPE_RE = /^projects\/[a-z0-9._-]+-[a-f0-9]{16}$/;
/** 项目条目可用的 metadata.type 集（归档移回时按此校验/回落 originType）。 */
const PROJECT_TYPES = new Set(["user", "feedback", "project", "reference"]);
const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

/** 结构化错误（code 供 API 分流：400/404/500）。 */
function archiveError(code, message) {
  const err = new Error(`dsh-keepsake: ${message}`);
  err.code = code;
  return err;
}

/** 原子写（tmp+rename；失败清 tmp，不掩盖原始错误；tmp 名带 `.tmp-` 供 sweepTmpOrphans 认领）。 */
function writeAtomicText(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch { /* 清理失败不掩盖原始错误 */ }
    throw error;
  }
}

/** 索引重建（只经 mergeIndexContent 重建，绝不手改索引；口径同 global-store.js rebuildIndex）。 */
function rebuildIndex(dir, touched, deletedNames) {
  const indexPath = join(dir, INDEX_FILENAME);
  const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  writeAtomicText(indexPath, mergeIndexContent(existing, touched, deletedNames));
}

/** 分类内唯一文件名（重名 -2/-3… 避让；口径同 global-store.js uniqueName）。 */
function uniqueName(dir, wantName) {
  let candidate = wantName;
  for (let i = 2; i < 100; i += 1) {
    if (!existsSync(join(dir, candidate))) return candidate;
    candidate = wantName.replace(/\.md$/i, `-${i}.md`);
  }
  return `entry-${Date.now()}.md`;
}

/** 解析 frontmatter 顶层全部简单字段（顶格不缩进的行；origin 三字段与 originSessionId 用）。 */
function parseHeadFields(raw, maxLines = 30) {
  const lines = String(raw ?? "").split("\n", maxLines);
  if (lines[0]?.trim() !== "---") return {};
  const out = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "---" || line.trim() === "...") break;
    const matched = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/); // 顶格（不缩进）= 顶层字段
    if (matched !== null) out[matched[1]] = matched[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}

/** storageRoot 相对路径（'/' 归一；审计/响应用）。 */
function relOf(storageRoot, absPath) {
  return relative(storageRoot, absPath).replace(/\\/g, "/");
}

/** rootKey → 源根目录（evict：候选清单的 rootKey 形态只有 global:<category> / project）。 */
function sourceDirOf(storageRoot, scope, rootKey) {
  if (rootKey === "project") {
    if (scope === "global") return null;
    return join(storageRoot, ...scope.split("/"), "memory");
  }
  if (typeof rootKey === "string" && rootKey.startsWith("global:")) {
    const category = rootKey.slice("global:".length);
    return isCategoryId(category) ? categoryDir(storageRoot, category) : null;
  }
  return null;
}

/** 失效 + 重编若干 scope（ensureCompiled 在缓存已清时必真编译；journal trigger=panel）。 */
function recompileScopes(storageRoot, scopes, log) {
  const out = new Map();
  for (const s of scopes) out.set(s, ensureCompiled({ storageRoot, scope: s, trigger: "panel", log }));
  return out;
}

// ---- 归档条目渲染（§6.3 schema：全局 schema + origin 三字段） ----

/**
 * 渲染归档条目（只服务归档路径；§6.3）。
 * 全局 schema（name/title/description/metadata.type=global/node_type）上：
 *   - title 缺省补 = name（项目条目无 title）；
 *   - pinned 透传（仅 true 时写出，字段序 metadata 之后、node_type 之前——§5.2 同口径）；
 *   - originProject/originType/originSessionId 仅在非空时写出（全部可选）；
 *   - 正文原样。
 */
export function renderArchivedEntry({ name, title, description = "", pinned = false, content = "", originProject = "", originType = "", originSessionId = "" }) {
  const esc = (v) => String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
  const lines = [
    "---",
    `name: "${esc(name)}"`,
    `title: "${esc(title ?? name)}"`,
    `description: "${esc(description)}"`,
    "metadata:",
    "  type: global",
  ];
  if (pinned === true) lines.push("pinned: true");
  lines.push('node_type: "memory"');
  if (typeof originProject === "string" && originProject.length > 0) lines.push(`originProject: "${esc(originProject)}"`);
  if (typeof originType === "string" && originType.length > 0) lines.push(`originType: "${esc(originType)}"`);
  if (typeof originSessionId === "string" && originSessionId.length > 0) lines.push(`originSessionId: "${esc(originSessionId)}"`);
  lines.push("---", "", String(content ?? "").trimEnd(), "");
  return lines.join("\n");
}

// ---- 淘汰归档执行（§6.2 全序列；本文件的唯一搬移入口之一） ----

/**
 * 执行归档：把候选文件从源根搬进 global/long-term/（按 §6.3 重写）。
 * 调用方（api.js）负责抢 extract.lock（拿不到 409），本函数不再抢锁。
 * @param {object} opts
 * @param {Array<{rootKey:string,file:string}>} opts.files 面板勾选的候选（可能过期）
 * @param {number} [opts.now] 仅供测试（快照目录 ts / 审计时刻）
 * @returns {{archived:number, skipped:Array<{rootKey,file,reason}>, snapshotDir:string|null}}
 */
export function evictEntries({ storageRoot, scope, files, log = noopLog, now = Date.now() } = {}) {
  if (!isValidScope(scope)) throw archiveError("SCOPE_INVALID", `非法 runtime scope "${String(scope)}"`);
  // 候选真相 = 现算的编译结果（面板清单可能过期：文件已被改/已不在候选 → skipped 报告，不静默）。
  const freshCandidates = compileScope({ storageRoot, scope }).evictCandidates;
  const candidateKeys = new Set(freshCandidates.map((c) => `${c.rootKey}\u0000${c.file}`));

  const skipped = [];
  const archived = [];
  let snapshotDirAbs = null;
  let snapshotDirRel = null;
  let seq = 0;
  let auditFailed = false; // 审计坏掉后停止搬运，但仍走完失效重编与滚动清理
  let auditError = null;
  const ltDir = categoryDir(storageRoot, ARCHIVE_CATEGORY_ID);

  for (const item of files) {
    const rootKey = item.rootKey;
    const file = item.file;
    if (!candidateKeys.has(`${rootKey}\u0000${file}`)) {
      // 过期候选（已被改/已入选/已从盘上消失）：跳过并如实报告原因（§6.2-2）。
      skipped.push({ rootKey, file, reason: "not-candidate" });
      continue;
    }
    const rootDir = sourceDirOf(storageRoot, scope, rootKey);
    if (rootDir === null) {
      skipped.push({ rootKey, file, reason: "invalid-root-key" });
      continue;
    }
    const safeRel = sanitizeMemoryName(file ?? "");
    if (safeRel === null) {
      skipped.push({ rootKey, file, reason: "invalid-file" });
      continue;
    }
    const src = resolveSafeMemoryTarget(rootDir, safeRel);
    if (src === null) {
      skipped.push({ rootKey, file, reason: "invalid-file" });
      continue;
    }
    let raw;
    try {
      raw = readFileSync(src, "utf8");
    } catch {
      skipped.push({ rootKey, file, reason: "missing" });
      continue;
    }
    // ---- 3) 手术式快照（只快照被搬文件；失败 = 该条跳过，不搬）----
    if (snapshotDirAbs === null) {
      const backups = join(storageRoot, "backups");
      mkdirSync(backups, { recursive: true });
      const ts = new Date(now).toISOString().replace(/[:.]/g, "-");
      let name = `${EVICT_BACKUP_PREFIX}${ts}`;
      let dir = join(backups, name);
      for (let i = 0; existsSync(dir) && i < 50; i += 1) {
        name = `${EVICT_BACKUP_PREFIX}${ts}-${i}`;
        dir = join(backups, name);
      }
      mkdirSync(dir, { recursive: true });
      snapshotDirAbs = dir;
      snapshotDirRel = relOf(storageRoot, dir);
    }
    seq += 1;
    // 快照文件名展平（'/'→'_'）：不子目录（§6.2-3 的 <n>-<safe-name>）。
    const snapName = `${seq}-${safeRel.replace(/\//g, "_")}`;
    const snapPath = join(snapshotDirAbs, snapName);
    try {
      copyFileSync(src, snapPath);
    } catch (error) {
      log.warn?.(`归档快照失败，该条已跳过（不搬）: ${rootKey}/${safeRel}`, error);
      skipped.push({ rootKey, file, reason: "snapshot-failed" });
      continue;
    }
    // ---- 4) 按 §6.3 重写进 global/long-term/（重名 -2 避让；不子目录）----
    const front = parseFrontmatterHead(raw);
    const heads = parseHeadFields(raw);
    const stem = safeRel.split("/").pop().replace(/\.md$/i, "");
    const title = front.title ?? front.name ?? stem;
    const description = front.description ?? "";
    const originProject = rootKey === "project" ? scope : "";
    const originType = rootKey === "project" ? (front.type ?? "project") : rootKey.slice("global:".length);
    const archivedText = renderArchivedEntry({
      name: stem,
      title,
      description,
      pinned: front.pinned === true, // §5.2-3：归档重写也必须透传 pinned
      content: stripFrontmatter(raw),
      originProject,
      originType,
      originSessionId: heads.originSessionId ?? "",
    });
    mkdirSync(ltDir, { recursive: true });
    const finalName = uniqueName(ltDir, `${stem}.md`);
    const target = join(ltDir, finalName);
    try {
      writeAtomicText(target, archivedText);
    } catch (error) {
      log.warn?.(`归档写入失败，该条已跳过（源文件未动）: ${rootKey}/${safeRel}`, error);
      skipped.push({ rootKey, file, reason: "write-failed" });
      continue;
    }
    // 写成功才删源；删源失败回滚归档副本（不丢双份、该条按未归档报告）。
    try {
      rmSync(src, { force: true });
    } catch (error) {
      try {
        rmSync(target, { force: true });
      } catch { /* 回滚删除失败：留双份，仍按未归档如实报告 */ }
      log.warn?.(`归档后源文件删除失败，已回滚归档副本: ${rootKey}/${safeRel}`, error);
      skipped.push({ rootKey, file, reason: "delete-failed" });
      continue;
    }
    // ---- 5) 索引对账（源根删行、long-term 加行；只重建，绝不手改）----
    try {
      rebuildIndex(rootDir, [], [safeRel]);
      rebuildIndex(ltDir, [{ name: finalName, title, description, line: buildIndexLine(title, finalName, description) }], []);
    } catch (error) {
      // 文件已搬、索引未对上：warn 如实留痕（维护端点可修），不回滚已完成的归档。
      log.warn?.(`归档索引对账失败（可用维护页索引修复）: ${rootKey}/${safeRel}`, error);
    }
    // ---- 6) 持久审计（追加失败按硬失败处理——已搬条目必须可追溯）----
    // 审计坏掉时后续条目一律不再搬（它们会同样缺审计），但**必须走完流程**：
    // 早先版本在这里直接 throw，余下合法候选既不入 archived 也不进 skipped（静默失踪），
    // 且第 7 步的失效重编与快照滚动都不执行——runtime.json 与盘上状态长期对不上。
    if (auditFailed) {
      skipped.push({ rootKey, file: safeRel, reason: "audit-failed" });
      continue;
    }
    try {
      appendEvictAudit(storageRoot, {
        at: new Date(now).toISOString(),
        scope,
        rootKey,
        file: safeRel,
        from: relOf(storageRoot, src),
        to: relOf(storageRoot, target),
        snapshot: relOf(storageRoot, snapPath),
        actor: "panel",
      });
    } catch (error) {
      auditFailed = true;
      log.error?.(`归档审计写入失败，本轮起停止搬运（本条已归档：${rootKey}/${safeRel}，快照在 ${snapshotDirRel}）`, error);
      auditError = error;
      // 本条已搬完（源已删、归档副本已写、索引已对账）——如实计入 archived，只是缺审计行。
    }
    archived.push({ rootKey, file: safeRel, to: finalName });
  }

  // ---- 7) 失效 + 重编（全局条目 → 所有 scope；项目条目 → 该 scope；防跨 scope 断链）----
  if (archived.length > 0) {
    const touchedGlobal = archived.some((a) => a.rootKey.startsWith("global:"));
    const scopes = touchedGlobal ? listScopes(storageRoot) : [scope];
    invalidateRuntimeCache(storageRoot, touchedGlobal ? null : scope);
    recompileScopes(storageRoot, scopes, log);
  } else if (snapshotDirAbs !== null) {
    // 一条都没搬成（全部在写盘/删源阶段失败）：快照是对仍原位文件的冗余副本，连同空目录清掉，
    // 不留无人认领的 evict-* 目录（把滚动份数浪费在零归档轮次上）。
    try {
      rmSync(snapshotDirAbs, { recursive: true, force: true });
      snapshotDirRel = null;
    } catch (error) {
      log.warn?.(`零归档轮次的空快照目录清理失败（可手动删除）: ${snapshotDirRel}`, error);
    }
  }
  // ---- 9) 尾部滚动清理：backups/evict-* 保留最近 10 份 ----
  pruneEvictBackups(storageRoot, { keep: EVICT_BACKUP_KEEP, log });
  const result = { archived: archived.length, skipped, snapshotDir: snapshotDirRel };
  // 审计坏掉才抛——此时上面各步（含失效重编）都已走完，响应带得出真实的已归档条数。
  if (auditFailed) {
    const error = archiveError("EVICT_AUDIT_FAILED", "归档审计（evict-audit.jsonl）写入失败，本轮起停止搬运");
    error.details = { ...result };
    error.cause = auditError ?? void 0;
    throw error;
  }
  return result;
}

/** 归档快照滚动清理：按目录名（ts 序）保留最新 keep 份。 @returns 删除份数 */
export function pruneEvictBackups(storageRoot, { keep = EVICT_BACKUP_KEEP, log = noopLog } = {}) {
  const limit = Number.isInteger(keep) && keep > 0 ? keep : EVICT_BACKUP_KEEP;
  const root = join(storageRoot, "backups");
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(EVICT_BACKUP_PREFIX))
      .map((d) => d.name);
  } catch {
    return 0;
  }
  dirs.sort().reverse(); // 目录名 = evict-<ISO ts>，字典序即时间序
  let removed = 0;
  for (const stale of dirs.slice(limit)) {
    try {
      rmSync(join(root, stale), { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      // 删不掉不静默：下轮还会再试，但不留无痕失败（占用/权限/磁盘满）
      log.warn?.(`归档快照清理失败（下轮再试）: ${stale}`, error);
    }
  }
  return removed;
}

// ---- 归档移回（§6.4 推荐路径） ----

/**
 * 从 global/long-term/ 把归档条目移回原位（按 origin 三字段还原 schema）。
 * 调用方负责抢锁（与其他破坏性端点同口径）。
 * @param {object} opts
 * @param {string} opts.file long-term 下的文件名（单层）
 * @returns {{file:string, name:string, to:string, scope:string}} 落点（name 可能因重名 -2 避让而变）
 */
export function restoreArchivedEntry({ storageRoot, file, log = noopLog, now = Date.now() } = {}) {
  const safe = sanitizeMemoryName(file ?? "");
  if (safe === null || safe.includes("/")) {
    throw archiveError("ARCHIVE_INVALID", `非法归档文件名 "${String(file)}"（只认 long-term 下单层 .md 名）`);
  }
  const ltDir = categoryDir(storageRoot, ARCHIVE_CATEGORY_ID);
  const src = resolveSafeMemoryTarget(ltDir, safe);
  if (src === null) throw archiveError("ARCHIVE_INVALID", `非法归档文件名 "${String(file)}"`);
  if (!existsSync(src)) throw archiveError("ARCHIVE_MISSING", `归档条目不存在 "${safe}"`);
  const raw = readFileSync(src, "utf8");
  const front = parseFrontmatterHead(raw);
  const heads = parseHeadFields(raw);
  const stem = safe.replace(/\.md$/i, "");
  const title = front.title ?? front.name ?? stem;
  const description = front.description ?? "";
  const pinned = front.pinned === true; // §5.2-3：移回重写保留 pin
  const body = stripFrontmatter(raw);
  const originProject = heads.originProject ?? "";
  const originType = heads.originType ?? "";
  const originSessionId = heads.originSessionId ?? "";

  let targetDir;
  let affectedScope = "global";
  if (originProject.length > 0) {
    if (!PROJECT_SCOPE_RE.test(originProject)) {
      throw archiveError("ARCHIVE_INVALID", `归档条目的 originProject 非法 "${originProject}"`);
    }
    // 目标目录不存在则新建（§6.4「目标不存在/重名走 -2 避让」）：与手动搬回的兼容路径同效，
    // 不因项目目录曾被清掉就把归档条目永久困在 long-term。
    targetDir = join(storageRoot, ...originProject.split("/"), "memory");
    affectedScope = originProject;
  } else if (originType.length > 0 && isCategoryId(originType) && originType !== ARCHIVE_CATEGORY_ID) {
    targetDir = categoryDir(storageRoot, originType);
  } else {
    throw archiveError("ARCHIVE_INVALID", "归档条目缺少 origin 字段（originProject/originType），无法确定移回位置");
  }

  mkdirSync(targetDir, { recursive: true });
  const finalName = uniqueName(targetDir, safe);
  const finalStem = finalName.replace(/\.md$/i, "");
  // 按原 schema 重写 = 剥掉 origin 三字段（目标渲染器本就不写）+ 恢复原 metadata.type。
  const targetText = originProject.length > 0
    // 项目 schema（renderMemoryFile：name/description/metadata.type/originSessionId；无 title）。
    ? renderMemoryFile({
        name: finalStem,
        description,
        type: PROJECT_TYPES.has(originType) ? originType : "project",
        originSessionId,
        pinned,
        content: body,
      })
    // 全局 schema（type 恒 global）；recent-activity 由 host 重新盖 timestamp（不信旧值）。
    : renderGlobalEntry({
        name: finalStem,
        title,
        description,
        timestamp: originType === "recent-activity" ? new Date(now).toISOString() : void 0,
        pinned,
        content: body,
      });
  const target = join(targetDir, finalName);
  try {
    writeAtomicText(target, targetText);
  } catch (error) {
    throw archiveError("ARCHIVE_WRITE_FAILED", `移回写入失败：${String(error?.message ?? error)}`);
  }
  try {
    rmSync(src, { force: true });
  } catch (error) {
    try {
      rmSync(target, { force: true });
    } catch { /* 回滚删除失败：留双份，仍如实报错 */ }
    throw archiveError("ARCHIVE_WRITE_FAILED", `源归档文件删除失败，已回滚移回副本：${String(error?.message ?? error)}`);
  }
  // 索引对账：long-term 删行、目标根加行（只重建）。
  try {
    rebuildIndex(ltDir, [], [safe]);
    rebuildIndex(targetDir, [{ name: finalName, title, description, line: buildIndexLine(title, finalName, description) }], []);
  } catch (error) {
    log.warn?.(`移回索引对账失败（可用维护页索引修复）: ${safe}`, error);
  }
  // 失效 + 重编：项目条目 → 该项目 scope；全局条目 → 所有 scope（原分类条目会进每个 scope 产物）。
  const scopes = affectedScope === "global" ? listScopes(storageRoot) : [affectedScope];
  invalidateRuntimeCache(storageRoot, affectedScope === "global" ? null : affectedScope);
  recompileScopes(storageRoot, scopes, log);
  return { file: safe, name: finalName, to: relOf(storageRoot, target), scope: affectedScope };
}

// ---- pin 端点（§五：改 frontmatter，走既有条目写盘路径） ----

/**
 * 切 pin：rootKey 一律在路径 scope 内解析（§十一）——
 * `global:<category>` 只在 global scope 有效；`project` 只在项目 scope 有效（指该 scope 自己的项目条目）。
 * 改完 frontmatter 后失效缓存并强制重编（全局条目进所有 scope 产物 → 全量；
 * 项目条目只影响该 scope），返回路径 scope 的新 manifest 摘要。
 * @returns {{rootKey:string, file:string, pinned:boolean, manifest:object}}
 */
export function pinRuntimeEntry({ storageRoot, scope, rootKey, file, pinned, log = noopLog } = {}) {
  if (!isValidScope(scope)) throw archiveError("SCOPE_INVALID", `非法 runtime scope "${String(scope)}"`);
  if (typeof pinned !== "boolean") throw archiveError("PIN_INVALID", "pinned 必须是布尔值");
  const safe = sanitizeMemoryName(file ?? "");
  if (safe === null) throw archiveError("PIN_INVALID", `非法条目名 "${String(file)}"`);
  let affectsAllScopes = false;
  if (rootKey === "project") {
    if (scope === "global") throw archiveError("PIN_INVALID", "rootKey=project 只在项目 scope 内有效");
    const rootDir = join(storageRoot, ...scope.split("/"), "memory");
    const target = resolveSafeMemoryTarget(rootDir, safe);
    if (target === null || !existsSync(target)) throw archiveError("PIN_MISSING", `条目不存在 "${safe}"`);
    // 项目条目覆写：走 renderMemoryFile 渲染原语（生产写路径同款），保留
    // description/type/originSessionId/正文，只改 pinned；name 展平 '/'（同 applyOps 口径）。
    const raw = readFileSync(target, "utf8");
    const front = parseFrontmatterHead(raw);
    const heads = parseHeadFields(raw);
    const text = renderMemoryFile({
      name: safe.replace(/\.md$/i, "").replace(/\//g, "-"),
      description: front.description ?? "",
      type: front.type ?? "project",
      originSessionId: heads.originSessionId ?? "",
      pinned,
      content: stripFrontmatter(raw),
    });
    writeAtomicText(target, text);
    // 索引行只承载 title/description（本次未变）——不无谓触碰索引文件。
  } else if (typeof rootKey === "string" && rootKey.startsWith("global:")) {
    if (scope !== "global") throw archiveError("PIN_INVALID", "rootKey=global:<category> 只在 global scope 内有效");
    if (safe.includes("/")) throw archiveError("PIN_INVALID", `全局条目强制单层，非法条目名 "${safe}"`);
    const category = rootKey.slice("global:".length);
    if (!isCategoryId(category)) throw archiveError("PIN_INVALID", `未知全局分类 "${category}"`);
    // 全局条目覆写：走 updateEntry 的 pinned 路径（显式布尔按其值；索引随写重建）。
    const updated = updateEntry(storageRoot, category, safe, { pinned });
    if (updated === null) throw archiveError("PIN_MISSING", `条目不存在 "${safe}"`);
    affectsAllScopes = true;
  } else {
    throw archiveError("PIN_INVALID", `rootKey "${String(rootKey)}" 无法在 scope "${scope}" 内解析`);
  }
  // 失效 + 重编：全局条目进所有 scope 产物（pin 标记出现在每份产物里）→ 全量；
  // 项目条目只影响该 scope。路径 scope 的 manifest 作为响应摘要。
  if (affectsAllScopes) {
    invalidateRuntimeCache(storageRoot, null);
    const manifests = recompileScopes(storageRoot, listScopes(storageRoot), log);
    const manifest = manifests.get(scope) ?? ensureCompiled({ storageRoot, scope, trigger: "panel", log });
    return { rootKey, file: safe, pinned, manifest: summarizeManifest(manifest) };
  }
  invalidateRuntimeCache(storageRoot, scope);
  const manifest = recompileScopes(storageRoot, [scope], log).get(scope);
  return { rootKey, file: safe, pinned, manifest: summarizeManifest(manifest) };
}

// ---- 强制重编（§八：面板「重新编译」；绕过懒编译缓存） ----

/** manifest → 面板消费的摘要（选了几条/候选几条/字节；§十一 compile 契约字段）。 */
export function summarizeManifest(manifest) {
  const included = (file) => (Array.isArray(file?.entries) ? file.entries.filter((e) => e.included).length : 0);
  return {
    scope: manifest.scope,
    status: manifest.status,
    selected: included(manifest.user) + included(manifest.memory),
    candidates: Array.isArray(manifest.evictCandidates) ? manifest.evictCandidates.length : 0,
    overQuota: manifest.status === "overQuota",
    bytes: {
      user: manifest.user?.bytes ?? 0,
      memory: manifest.memory?.bytes ?? 0,
    },
  };
}

/**
 * 强制重编一个 scope（不看缓存）：compileScope + writeRuntimeArtifacts + journal(trigger)。
 * 编译失败：交回 ensureCompiled 写 status=error 清单（保留上一版产物语义、journal 照记），
 * 再抛 COMPILE_FAILED 供 API 层显式 500——不 fail-open、不静默。
 * @returns runtime.json 清单
 */
export function forceCompile(storageRoot, scope, { trigger = "panel", log = noopLog } = {}) {
  if (!isValidScope(scope)) throw archiveError("SCOPE_INVALID", `非法 runtime scope "${String(scope)}"`);
  try {
    const compiled = compileScope({ storageRoot, scope });
    const manifest = writeRuntimeArtifacts(storageRoot, scope, compiled);
    try {
      appendCompileJournal(storageRoot, {
        at: manifest.compiledAt,
        scope,
        trigger,
        selected: manifest.user.entries.filter((e) => e.included).length + manifest.memory.entries.filter((e) => e.included).length,
        candidates: manifest.evictCandidates.length,
        overQuota: manifest.status === "overQuota",
        bytes: { user: manifest.user.bytes, memory: manifest.memory.bytes },
        sourceHash: manifest.sourceHash,
      });
    } catch (error) {
      log.warn?.(`runtime: compile-journal 追加失败（编译结果不受影响）: ${String(error?.message ?? error)}`);
    }
    return manifest;
  } catch (error) {
    // 失败路径：ensureCompiled 内部会重试编译、失败时写 status=error 清单 + journal（自身不抛）。
    log.warn?.(`runtime: 强制编译失败（scope=${scope}），转 status=error 语义: ${String(error?.message ?? error)}`);
    try {
      ensureCompiled({ storageRoot, scope, trigger, log });
    } catch (fallbackError) {
      log.warn?.(`runtime: status=error 清单兜底也失败（scope=${scope}）: ${String(fallbackError?.message ?? fallbackError)}`);
    }
    throw archiveError("COMPILE_FAILED", `编译失败（scope=${scope}）`);
  }
}

// dsh-keepsake 存储格式版本闸 —— 升级/降级安全。
//
// 背景：记忆数据全部落在 <storageRoot>（默认 ~/.dsh/memory），在插件包目录之外，
// 因此"卸载旧版 → 安装新版"的升级方式天然不碰用户数据。真正的风险只剩一个方向：
// 用户先装了**更新版**插件（写入新格式数据），之后又**降级**到本旧版——旧版的读/写/滚动清理
// 可能按旧规则误删或误改新格式数据。
//
// 为此在存储根写一个标记文件记录"写这份数据的格式版本"：
//   - 缺失（v0.1/v0.2 无标记的旧数据）或全新目录 → 补写当前版本，正常可写；
//   - 等于当前 → 正常；
//   - 低于当前 → 将来在此跑迁移（当前 FORMAT_VERSION=1，无更早版本），补写当前版本；
//   - 高于当前 → 拒绝【写入与清理】，显式报错（不许 fail-open）；读取仍放行（非破坏性）。
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 当前插件能安全读写的存储格式版本。任何破坏性格式变更都要 +1 并在此登记迁移。 */
export const FORMAT_VERSION = 1;
export const FORMAT_FILENAME = "keepsake-format.json";

export function formatPath(storageRoot) {
  return join(storageRoot, FORMAT_FILENAME);
}

/**
 * 读格式标记（mtime+size 缓存）。
 * @returns { present, formatVersion, supported, corrupt }
 *   formatVersion=null 表示缺失或不可读；corrupt=true 表示文件在但解析失败。
 */
export function readFormatState(storageRoot, log = { warn: () => {} }) {
  const path = formatPath(storageRoot);
  let key = "";
  try {
    const stat = statSync(path);
    key = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    key = ""; // 文件不存在
  }
  if (key !== "" && readFormatState._cache && readFormatState._cache.path === path && readFormatState._cache.key === key) {
    return readFormatState._cache.value;
  }
  let value;
  if (key === "") {
    value = { present: false, formatVersion: null, supported: true, corrupt: false };
  } else {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      const v = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.formatVersion : void 0;
      if (Number.isInteger(v) && v > 0) {
        value = { present: true, formatVersion: v, supported: v <= FORMAT_VERSION, corrupt: false };
      } else {
        value = { present: true, formatVersion: null, supported: true, corrupt: true };
      }
    } catch (error) {
      log.warn("keepsake-format.json 解析失败，按未知格式处理（将补写当前版本）", error);
      value = { present: true, formatVersion: null, supported: true, corrupt: true };
    }
  }
  // 只在文件存在时缓存：缺失态不缓存，避免本次补写后仍读到陈旧的"缺失"。
  readFormatState._cache = key !== "" ? { path, key, value } : void 0;
  return value;
}

/** 原子补写当前格式版本标记。 */
function stampFormat(storageRoot) {
  const path = formatPath(storageRoot);
  mkdirSync(storageRoot, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify({ formatVersion: FORMAT_VERSION }, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
  readFormatState._cache = void 0;
}

/**
 * 判定存储目录能否被本版本安全写入（启动时调用一次，写入路径前亦可调用）。
 * @returns { ok, formatVersion, supported, reason?, stamped?, migratedFrom? }
 *   ok=false 仅在数据格式版本高于本插件支持时出现（reason:"too-new"）。
 */
export function ensureFormat(storageRoot, log = { warn: () => {}, error: () => {} }) {
  const state = readFormatState(storageRoot, log);
  if (state.present && state.corrupt) {
    log.warn("存储格式标记损坏，按当前版本补写（原标记不可读）");
    stampFormat(storageRoot);
    return { ok: true, formatVersion: FORMAT_VERSION, supported: true, stamped: true };
  }
  if (!state.present) {
    // 本插件自己 v0.1/v0.2 的旧数据（无标记）或全新目录：补写当前版本。
    stampFormat(storageRoot);
    return { ok: true, formatVersion: FORMAT_VERSION, supported: true, stamped: true };
  }
  if (state.formatVersion > FORMAT_VERSION) {
    return { ok: false, formatVersion: state.formatVersion, supported: false, reason: "too-new" };
  }
  if (state.formatVersion < FORMAT_VERSION) {
    // 迁移位：将来格式升版时在此按 migratedFrom → FORMAT_VERSION 逐版迁移。
    stampFormat(storageRoot);
    return { ok: true, formatVersion: FORMAT_VERSION, supported: true, stamped: true, migratedFrom: state.formatVersion };
  }
  return { ok: true, formatVersion: state.formatVersion, supported: true };
}

/**
 * 写入/清理前的硬闸：数据格式高于本版本即抛出（code=FORMAT_TOO_NEW），绝不静默写坏。
 * @throws Error(code="FORMAT_TOO_NEW")
 */
export function assertWritable(storageRoot, log = { warn: () => {}, error: () => {} }) {
  const result = ensureFormat(storageRoot, log);
  if (!result.ok) {
    const error = new Error(
      `dsh-keepsake: 存储目录由更新版本的插件写入（存储格式 v${result.formatVersion}，本插件支持 v${FORMAT_VERSION}），`
        + "已拒绝写入与清理以防损坏数据；请升级 dsh-keepsake 插件。",
    );
    error.code = "FORMAT_TOO_NEW";
    throw error;
  }
  return result;
}

/** 测试用：清缓存（同进程内连续写读场景）。 */
export function resetFormatCache() {
  readFormatState._cache = void 0;
}

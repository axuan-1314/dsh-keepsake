// dsh-memory 用户开关（方案C §3/§4 R3/R4）：~/.dsh/memory/settings.json。
//   语义：缺省三开关全开（与 v0.1.0 行为连续，开关纯做减法）；
//   损坏 = 显式 warn + 按缺省全开运行 + corrupt 标记（门牌红条可见降级）；
//   mtime 缓存，host 每次触发/注入前读取，改完下一轮即生效（绕开 desktop 重启限制）。
//   写入走原子写（tmp+rename），合并式 patch（缺省字段回填 true）。
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const SETTINGS_FILENAME = "settings.json";
export const SETTINGS_VERSION = 1;

/** 缺省值（R4：三开关全开）。corrupt 为运行时标记，不落盘。 */
export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    conversationMemory: true,
    projectMemory: true,
    globalExtraction: true,
    corrupt: false,
  };
}

export function settingsPath(storageRoot) {
  return join(storageRoot, SETTINGS_FILENAME);
}

/**
 * 读取 settings.json（mtime 缓存；不存在=缺省；损坏=warn+缺省+corrupt）。
 * @returns {{version:number, conversationMemory:boolean, projectMemory:boolean,
 *            globalExtraction:boolean, corrupt:boolean}}
 */
export function readSettings(storageRoot, log = { warn: () => {} }) {
  const path = settingsPath(storageRoot);
  const defaults = defaultSettings();
  let key = "";
  try {
    const stat = statSync(path);
    key = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return defaults; // 不存在 = 缺省全开
  }
  if (readSettings._cache && readSettings._cache.path === path && readSettings._cache.key === key) {
    return readSettings._cache.value;
  }
  let value = defaults;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    value = {
      version: SETTINGS_VERSION,
      conversationMemory: parsed.conversationMemory !== false,
      projectMemory: parsed.projectMemory !== false,
      globalExtraction: parsed.globalExtraction !== false,
      corrupt: false,
    };
  } catch (error) {
    log.warn("settings.json 解析失败，按缺省（三开关全开）运行", error);
    value = { ...defaults, corrupt: true };
  }
  readSettings._cache = { path, key, value };
  return value;
}

/** 测试用：清 mtime 缓存（同进程内连续写读场景）。 */
export function resetSettingsCache() {
  readSettings._cache = void 0;
}

/**
 * 合并式写入（原子写 tmp+rename）。patch 只接受三开关键，其余忽略；
 * 写前按现值合并（现值缺失/损坏按缺省），保证文件永远三键齐全。
 * @returns 写入后的完整 settings 对象。
 */
export function writeSettings(storageRoot, patch, log = { warn: () => {} }) {
  const current = readSettings(storageRoot, log);
  const next = {
    version: SETTINGS_VERSION,
    conversationMemory: typeof patch?.conversationMemory === "boolean" ? patch.conversationMemory : current.conversationMemory,
    projectMemory: typeof patch?.projectMemory === "boolean" ? patch.projectMemory : current.projectMemory,
    globalExtraction: typeof patch?.globalExtraction === "boolean" ? patch.globalExtraction : current.globalExtraction,
  };
  const path = settingsPath(storageRoot);
  writeAtomicJson(path, next);
  resetSettingsCache();
  return { ...next, corrupt: false };
}

/** 原子写 JSON（同目录 tmp + rename；目录不存在先建）。 */
export function writeAtomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

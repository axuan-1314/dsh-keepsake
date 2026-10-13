// dsh-memory 用户开关 + 嵌入服务配置（~/.dsh/memory/settings.json）。
//   语义：缺省三开关全开；embedding 缺省缺位（= 跟随 cordis.patch.yml 的 entry config）；
//   一旦用户从面板写入 embedding，即以 settings 为准（enabled:false 亦为显式关闭）。
//   损坏 = 显式 warn + 按缺省运行 + corrupt 标记（门牌红条可见降级）；
//   mtime 缓存，host 每次触发/注入前读取，改完下一轮即生效（绕开 desktop 重启限制）。
//   写入走原子写（tmp+rename），合并式 patch。
import { readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const SETTINGS_FILENAME = "settings.json";
export const SETTINGS_VERSION = 1;

/** 缺省值（三开关全开；embedding 缺位 = 跟随 entry config）。corrupt 为运行时标记，不落盘。 */
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

function str(value) {
  return typeof value === "string" ? value : "";
}

/** 读侧归一 embedding（宽容，绝不 throw）：非对象 → undefined（= 跟随 entry config）。 */
function normalizeStoredEmbedding(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const out = {
    enabled: raw.enabled === true,
    baseUrl: str(raw.baseUrl),
    model: str(raw.model),
    provider: str(raw.provider),
    apiKey: str(raw.apiKey),
  };
  if (Number.isInteger(raw.topK) && raw.topK > 0) out.topK = raw.topK;
  if (typeof raw.minScore === "number" && raw.minScore >= 0 && raw.minScore <= 1) out.minScore = raw.minScore;
  return out;
}

/** 写侧校验 embedding（严格）：undefined=不改，null=显式清除，对象=规范化。非法即抛（fail loud）。 */
function validateEmbedding(raw) {
  if (raw === void 0) return void 0;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("dsh-memory: settings.embedding 必须是对象");
  const enabled = raw.enabled === true;
  const baseUrl = str(raw.baseUrl).trim();
  const model = str(raw.model).trim();
  const provider = str(raw.provider).trim();
  const apiKey = str(raw.apiKey);
  if (enabled && baseUrl.length === 0) throw new Error("dsh-memory: 开启语义召回需要嵌入端点 URL");
  if (enabled && model.length === 0) throw new Error("dsh-memory: 开启语义召回需要嵌入模型名");
  if (baseUrl.length > 0) {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error("dsh-memory: 嵌入端点必须是绝对 http(s) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`dsh-memory: 嵌入端点必须是 http(s)（当前 ${parsed.protocol}）`);
    }
  }
  const out = { enabled, baseUrl, model, provider, apiKey };
  if (raw.topK !== void 0 && raw.topK !== null && raw.topK !== "") {
    const n = Number(raw.topK);
    if (!Number.isInteger(n) || n <= 0) throw new Error("dsh-memory: embedding.topK 必须是正整数");
    out.topK = n;
  }
  if (raw.minScore !== void 0 && raw.minScore !== null && raw.minScore !== "") {
    const n = Number(raw.minScore);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error("dsh-memory: embedding.minScore 必须在 [0,1] 区间");
    out.minScore = n;
  }
  return out;
}

/**
 * 读取 settings.json（mtime 缓存；不存在=缺省；损坏=warn+缺省+corrupt）。
 * @returns 三开关 + （若有）embedding 覆盖。
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
    const emb = normalizeStoredEmbedding(parsed.embedding);
    if (emb !== void 0) value.embedding = emb;
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
 * 合并式写入（原子写 tmp+rename）。patch 接受三开关键 + 可选 embedding（对象=覆盖，null=清除，缺位=不动）；
 * 其余忽略。写前按现值合并，保证三键恒在。
 * @returns 写入后的完整 settings 对象（含 corrupt: false）。
 */
export function writeSettings(storageRoot, patch, log = { warn: () => {} }) {
  const current = readSettings(storageRoot, log);
  const next = {
    version: SETTINGS_VERSION,
    conversationMemory: typeof patch?.conversationMemory === "boolean" ? patch.conversationMemory : current.conversationMemory,
    projectMemory: typeof patch?.projectMemory === "boolean" ? patch.projectMemory : current.projectMemory,
    globalExtraction: typeof patch?.globalExtraction === "boolean" ? patch.globalExtraction : current.globalExtraction,
  };
  const emb = validateEmbedding(patch === null || typeof patch !== "object" ? void 0 : patch.embedding);
  if (emb === void 0) {
    if (current.embedding !== void 0) next.embedding = current.embedding; // 未提供：保留现有覆盖
  } else if (emb !== null) {
    next.embedding = emb;
  } // emb === null：显式清除，不写 embedding 键
  const path = settingsPath(storageRoot);
  writeAtomicJson(path, next);
  resetSettingsCache();
  return { ...next, corrupt: false };
}

/**
 * 生效的嵌入配置：settings.embedding（用户从面板设置）优先于 entry config；source 标注来源。
 * 纯函数，供注入路径与 /state 共用。
 */
export function effectiveEmbedding(cfg, settings) {
  const s = settings && typeof settings === "object" && !Array.isArray(settings) ? settings.embedding : void 0;
  if (s !== void 0 && s !== null && typeof s === "object") {
    return {
      source: "settings",
      enabled: s.enabled === true,
      baseUrl: str(s.baseUrl),
      model: str(s.model),
      provider: str(s.provider),
      apiKey: str(s.apiKey),
      topK: Number.isInteger(s.topK) && s.topK > 0 ? s.topK : cfg.recallTopK,
      minScore: typeof s.minScore === "number" ? s.minScore : cfg.recallMinScore,
      timeoutMs: cfg.recallTimeoutMs,
    };
  }
  return {
    source: "config",
    enabled: cfg.recallEnabled === true,
    baseUrl: cfg.embeddingBaseUrl ?? "",
    model: cfg.embeddingModel ?? "",
    provider: cfg.embeddingProvider ?? "",
    apiKey: cfg.embeddingApiKey ?? "",
    topK: cfg.recallTopK,
    minScore: cfg.recallMinScore,
    timeoutMs: cfg.recallTimeoutMs,
  };
}

/** 原子写 JSON（同目录 tmp + rename；目录不存在先建）。 */
export function writeAtomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

// dsh-keepsake 用户开关 + 嵌入服务配置（~/.dsh/memory/settings.json）。
//   语义：缺省三开关全开；embedding 缺省缺位（= 跟随 cordis.patch.yml 的 entry config）；
//   一旦用户从面板写入 embedding，即以 settings 为准（enabled:false 亦为显式关闭）。
//   损坏 = 显式 warn + 留档（改名 settings.corrupt-<ts>）+ 从 last-good 影子恢复（无影子才落默认）
//   + corrupt 标记（门牌红条可见降级）；每次成功写入同步刷新 last-good 影子。
//   无缓存：文件极小，每轮直读盘上真值，杜绝 mtime+size 缓存键同值不同内容时误读旧值。
//   写入走原子写（tmp+rename），合并式 patch。
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const SETTINGS_FILENAME = "settings.json";
/** last-good 影子文件（每次成功写入同步刷新；settings.json 损坏时从它恢复）。 */
export const SETTINGS_LAST_GOOD_FILENAME = "settings.last-good.json";
/** 损坏标记文件（settings.json 损坏过即为它落标记；用户下次成功保存设置时清除）——
 *  让 corrupt 不只在本轮请求可见，而是持久暴露到用户重新保存，避免红条一闪而过。 */
export const SETTINGS_CORRUPT_FLAG_FILENAME = "settings.corrupt";
export const SETTINGS_VERSION = 1;

/** 缺省值（三开关全开 + runtimeEnabled 缺省关；embedding 缺位 = 跟随 entry config）。corrupt 为运行时标记，不落盘。
 *  recentKeepDays 不入缺省（缺位 = 不覆盖，交由 entry config 现值决定）。 */
export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    conversationMemory: true,
    projectMemory: true,
    globalExtraction: true,
    // 运行时记忆层总开关（RUNTIME-FORMAT §10.1）：缺省 **false**（规矩：开关默认关、可回滚）。
    // 关闭 = 不编译、不注入 runtime 两段、globalIndex 的 runtime 去重不生效。
    runtimeEnabled: false,
    // v0.4.0 写入安全面三项（缺键走默认：旧 settings.json 无需迁移）
    surgicalKeep: 30,
    trashKeepDays: 30,
    hardfactPolicy: "warn",
    corrupt: false,
  };
}

export function settingsPath(storageRoot) {
  return join(storageRoot, SETTINGS_FILENAME);
}

/** last-good 影子文件路径（与 settings.json 同目录）。 */
export function settingsLastGoodPath(storageRoot) {
  return join(storageRoot, SETTINGS_LAST_GOOD_FILENAME);
}

/** 损坏标记文件路径（settings.json 损坏过即落；用户下次成功保存设置时清除）。 */
export function settingsCorruptFlagPath(storageRoot) {
  return join(storageRoot, SETTINGS_CORRUPT_FLAG_FILENAME);
}

/** 损坏标记是否在场（读侧据此让 corrupt 持久暴露到用户重新保存设置）。 */
function corruptFlagPresent(storageRoot) {
  try {
    return existsSync(settingsCorruptFlagPath(storageRoot));
  } catch {
    return false;
  }
}

/** 落损坏标记；失败只 warn（不阻断读取——corrupt 至少本轮仍可见）。 */
function raiseCorruptFlag(storageRoot, log) {
  try {
    writeFileSync(settingsCorruptFlagPath(storageRoot), new Date().toISOString() + "\n", "utf8");
  } catch (error) {
    log.warn("settings.corrupt 标记写入失败（本次读仍报 corrupt，但无法持久标记）", error);
  }
}

/** 清损坏标记（用户成功保存设置 = 已重写修复）；失败只 warn。 */
function clearCorruptFlag(storageRoot, log) {
  try {
    rmSync(settingsCorruptFlagPath(storageRoot), { force: true });
  } catch (error) {
    log.warn("settings.corrupt 标记清除失败（用户已重存设置，下次保存再试）", error);
  }
}

/** 安全面三项的取值白名单与边界（与 lib/safety.js 的 resolveSafetySettings 同口径）。 */
export const HARDFACT_POLICIES = new Set(["warn", "block"]);
export const SURGICAL_KEEP_DEFAULT = 30;
export const TRASH_KEEP_DAYS_DEFAULT = 30;
export const RECENT_KEEP_DAYS_DEFAULT = 30;

/**
 * 落默认诊断的内存态：最近一次 readSettings 里被顶回默认的字段名集合。
 * 进程内、不持久化（"最近一次读取发生了什么"，不是盘上配置）；每次 readSettings 开头重算，
 * 由 getSettingsDiagnostics() 外读。模块级单态（一个进程一个 storageRoot，无多根混淆场景）。
 */
let coercedFields = new Set();

/** 三个数值设置项的合理上限（PUT /settings 严格校验用；越界即拒）。 */
export const SURGICAL_KEEP_MAX = 200;
export const TRASH_KEEP_DAYS_MAX = 365;
export const RECENT_KEEP_DAYS_MAX = 365;

/**
 * PUT /settings 数值项严格校验（整数 + 上限）；返回 { ok, error? }。
 * 与 writeSettings 的宽容读侧不同：写端点显式拒绝非法入参（400），不静默改默认。
 * key 缺省（undefined）= 未提及 → ok（保留现值）。
 * 下界沿用现有语义：trashKeepDays 允许 0（0 天=当天清空是既有合法配置），
 * surgicalKeep / recentKeepDays 必须是正整数。
 */
export function validateSettingsNumber(key, value) {
  if (value === void 0) return { ok: true };
  const spec = key === "surgicalKeep"
    ? { max: SURGICAL_KEEP_MAX, min: 1 }
    : key === "trashKeepDays"
      ? { max: TRASH_KEEP_DAYS_MAX, min: 0 }
      : { max: RECENT_KEEP_DAYS_MAX, min: 1 };
  if (typeof value !== "number" || !Number.isInteger(value) || value < spec.min || value > spec.max) {
    return { ok: false, error: `${key} 必须是 ${spec.min}..${spec.max} 的整数` };
  }
  return { ok: true };
}

/**
 * 安全面三项归一（读侧宽容：非法/缺键一律走默认，绝不 throw）。
 * surgicalKeep：正整数；trashKeepDays：≥0 有限数；hardfactPolicy：warn|block。
 * 数值键的判据：原始值必须是 number 类型且有限（不经 Number() 强转）——
 * null/false/""/空白串/数字字符串一律走默认，与「显式非法 → 默认」同口径；
 * 合法数字 0 保持有效（trashKeepDays=0 即当天清空，是合法配置）。
 *
 * 落默认不再静默：手改 settings.json 时错型值（该是数字给了字符串之类）会把设置悄悄顶回默认，
 * 用户以为配了 90 天其实只有 30 天。故每次落默认都记一笔（字段名 + 收到的值 + 落的默认值），
 * 由 readSettings 汇总进 getSettingsDiagnostics().coercedFields 并 log.warn 留痕——
 * 取值语义本身不变（「非数值走默认」是文档化规则），只是让它可见。
 * 记账判据 =「键在场但值非法」：键【缺席】是旧 settings.json 的正常向后兼容（缺键走默认），
 * 不是用户写错，不该每次读都报一笔噪音。
 * @param {object} parsed
 * @param {object} [diag] 可选诊断收集器 { fields:Set, notes:string[] }
 */
function normalizeSafetySettings(parsed, diag = null) {
  const keep = parsed.surgicalKeep;
  const days = parsed.trashKeepDays;
  const policy = parsed.hardfactPolicy;
  const keepOk = typeof keep === "number" && Number.isInteger(keep) && keep > 0;
  const daysOk = typeof days === "number" && Number.isFinite(days) && days >= 0;
  const policyOk = HARDFACT_POLICIES.has(policy);
  if (diag !== null) {
    if (!keepOk && has(parsed, "surgicalKeep")) coerce(diag, "surgicalKeep", keep, SURGICAL_KEEP_DEFAULT);
    if (!daysOk && has(parsed, "trashKeepDays")) coerce(diag, "trashKeepDays", days, TRASH_KEEP_DAYS_DEFAULT);
    if (!policyOk && has(parsed, "hardfactPolicy")) coerce(diag, "hardfactPolicy", policy, "warn");
  }
  return {
    surgicalKeep: keepOk ? keep : SURGICAL_KEEP_DEFAULT,
    trashKeepDays: daysOk ? days : TRASH_KEEP_DAYS_DEFAULT,
    hardfactPolicy: policyOk ? policy : "warn",
  };
}

/** 键是否在场（不含原型链；缺键走默认不算落默认）。 */
function has(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

/** 落默认记账：字段名进诊断集合，明细进 notes（供 log.warn 一次性带出）。 */
function coerce(diag, field, received, fallback) {
  if (diag.fields.has(field)) return; // 同名字段只记一次（一次读取内不重复刷屏）
  diag.fields.add(field);
  diag.notes.push(`${field} 收到 ${describeValue(received)}，已落默认 ${String(fallback)}`);
}

/** 落默认记账用：把收到的值描成一段可读文本（含类型，字符串加引号，对象/数组不展开）。 */
function describeValue(value) {
  if (value === void 0) return "缺键（undefined）";
  if (value === null) return "null";
  if (typeof value === "string") return `字符串 "${value}"`;
  if (typeof value === "number") return `数字 ${value}`;
  if (typeof value === "boolean") return `布尔 ${value}`;
  if (Array.isArray(value)) return "数组";
  return typeof value === "object" ? "对象" : String(value);
}

/**
 * 近期动态保留天数归一：正整数才有效；否则 undefined（缺省=不覆盖，回落到 entry config）。
 * 缺键是正常缺省（不算落默认，不记账）；显式给了非法值才记一笔。
 */
function normalizeRecentKeepDays(raw, diag = null) {
  const ok = typeof raw === "number" && Number.isInteger(raw) && raw > 0;
  if (!ok && raw !== void 0 && diag !== null) {
    coerce(diag, "recentKeepDays", raw, "缺键（回落 entry config 现值）");
  }
  return ok ? raw : void 0;
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

/**
 * 写侧校验 embedding（严格）：undefined=不改，null=显式清除，对象=规范化。非法即抛（fail loud）。
 * apiKey 三态：键缺省/undefined → 返回对象不带该键（写侧合并时保留已存密钥）；
 *   null/"" /非字符串 → 落 ""（显式清空）；非空字符串 → 新值。
 * 这样面板重存嵌入配置（不带密钥）不会把已存密钥顶掉。
 */
function validateEmbedding(raw) {
  if (raw === void 0) return void 0;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("dsh-keepsake: settings.embedding 必须是对象");
  const enabled = raw.enabled === true;
  const baseUrl = str(raw.baseUrl).trim();
  const model = str(raw.model).trim();
  const provider = str(raw.provider).trim();
  const apiKeyProvided = Object.prototype.hasOwnProperty.call(raw, "apiKey") && raw.apiKey !== void 0;
  const apiKey = apiKeyProvided ? str(raw.apiKey) : void 0;
  if (enabled && baseUrl.length === 0) throw new Error("dsh-keepsake: 开启语义召回需要嵌入端点 URL");
  if (enabled && model.length === 0) throw new Error("dsh-keepsake: 开启语义召回需要嵌入模型名");
  if (baseUrl.length > 0) {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error("dsh-keepsake: 嵌入端点必须是绝对 http(s) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`dsh-keepsake: 嵌入端点必须是 http(s)（当前 ${parsed.protocol}）`);
    }
  }
  const out = { enabled, baseUrl, model, provider, apiKey };
  if (raw.topK !== void 0 && raw.topK !== null && raw.topK !== "") {
    const n = Number(raw.topK);
    if (!Number.isInteger(n) || n <= 0) throw new Error("dsh-keepsake: embedding.topK 必须是正整数");
    out.topK = n;
  }
  if (raw.minScore !== void 0 && raw.minScore !== null && raw.minScore !== "") {
    const n = Number(raw.minScore);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error("dsh-keepsake: embedding.minScore 必须在 [0,1] 区间");
    out.minScore = n;
  }
  return out;
}

/**
 * 读侧把一个 JSON 对象归一成完整 settings（所有读路径共用：settings.json 与 last-good 同口径）。
 * 非法顶层（非对象）抛错（交由调用方按损坏处理）。
 */
function normalizeSettings(parsed, diag = null) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("settings 顶层必须是对象");
  const value = {
    version: SETTINGS_VERSION,
    conversationMemory: parsed.conversationMemory !== false,
    projectMemory: parsed.projectMemory !== false,
    globalExtraction: parsed.globalExtraction !== false,
    // runtimeEnabled：缺省关（与三开关的「!== false」反向——只有显式 true 才开，
    // 与 entry config 的 enabled 同口径：开关默认关、可回滚）。
    runtimeEnabled: parsed.runtimeEnabled === true,
    // v0.4.0 写入安全面三项：缺键/非法值一律走默认（旧 settings.json 向后兼容）
    ...normalizeSafetySettings(parsed, diag),
    corrupt: false,
  };
  // recentKeepDays：面板可调（近期动态保留天数）；缺键/非法 → 不带该键（读侧回落到 entry config）。
  const recentKeep = normalizeRecentKeepDays(parsed.recentKeepDays, diag);
  if (recentKeep !== void 0) value.recentKeepDays = recentKeep;
  const emb = normalizeStoredEmbedding(parsed.embedding);
  if (emb !== void 0) value.embedding = emb;
  return value;
}

/** 损坏档备份改名：settings.json → settings.corrupt-<ts>（原内容永不失访，口径同 lib/format.js）。 */
function preserveCorruptSettings(path, log) {
  try {
    if (existsSync(path)) renameSync(path, `${path}.corrupt-${Date.now()}`);
  } catch (error) {
    log.warn("settings.json 损坏备份改名失败（继续从 last-good / 默认恢复，原文件保留原地）", error);
  }
}

/** 损坏影子备份改名：settings.last-good.json → settings.last-good.json.corrupt-<ts>（原内容永不失访）。 */
function preserveCorruptShadow(path, log) {
  try {
    if (existsSync(path)) renameSync(path, `${path}.corrupt-${Date.now()}`);
  } catch (error) {
    log.warn("settings.last-good.json 损坏备份改名失败（继续落默认，原文件保留原地）", error);
  }
}

/**
 * 落默认诊断：最近一次 readSettings 里「键在场但值非法、已被顶回默认」的字段名清单。
 * 进程内存态（不持久化）：随每次 readSettings 重算，供状态口/面板接线暴露
 * 「你手改的设置里有几项没生效」。读取返回拷贝，外改不污染内部态。
 * @returns {{ coercedFields: string[] }}
 */
export function getSettingsDiagnostics() {
  return { coercedFields: [...coercedFields] };
}

/** 重算诊断（每次 readSettings 开头清空后重填）；notes 顺带交回给调用方去 warn。 */
function newDiagnostics() {
  return { fields: new Set(), notes: [] };
}

/**
 * 读取 settings.json。
 *   不存在：先查 last-good 影子——影子在场（损坏恢复窗口中途崩溃：settings.json 已改名、
 *   写回未落）即从影子恢复用户真实开关 + corrupt:true；影子也缺席（真正的全新安装）才落
 *   默认全开且 corrupt:false。
 *   存在且可解析 = 归一后返回；损坏（截断/非法 JSON/顶层非对象）=
 *   先留档（改名 settings.json.corrupt-<ts>，原内容永不失访）→ 从 last-good 影子取回
 *   用户真实开关（无影子才落默认全开）→ 把恢复结果写回 settings.json（口径同 lib/format.js
 *   的"先备份再补写"，否则下次读又变 ENOENT 落默认，等于静默 fail-open 打开用户关过的开关）
 *   → 本次读返回 corrupt:true（本次请求周期内可见）+ 显式 warn。无 mtime 缓存：文件极小，
 *   直读盘上真值，杜绝 mtime+size 缓存键同值不同内容时误读旧值。
 *   落默认可见化：手改 settings.json 写成错型值时（该是数字给了字符串之类）不再静默顶回默认，
 *   而是 log.warn 字段名+收到的值+落的默认值，并把字段名累积进 getSettingsDiagnostics()。
 * @returns 三开关 + runtimeEnabled + 安全面三项 + （若有）recentKeepDays / embedding 覆盖 + corrupt 标记。
 */
export function readSettings(storageRoot, log = { warn: () => {} }) {
  const path = settingsPath(storageRoot);
  const diag = newDiagnostics();
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      // 文件不存在 ≠ 一定要落默认全开（那是 fail-open：会把用户关过的开关静默打开）。
      // 损坏恢复窗口是「先 rename settings.json → .corrupt-<ts>、再从 last-good 写回」，
      // 两步之间崩溃/写回失败后盘上只剩 last-good + settings.json 缺失——此时必须从影子
      // 取回用户真实开关。只有影子也不存在（真正的全新安装）才落默认。
      return recoverFromLastGood(storageRoot, path, log, { missing: true, diag });
    }
    // 非"不存在"的读失败（权限/EISDIR 等）：不能当作缺省静默 fail-open——显式 warn + corrupt
    log.warn("settings.json 读取失败，无法确认用户开关，按缺省（三开关全开）并标 corrupt", error);
    raiseCorruptFlag(storageRoot, log);
    publishDiagnostics(diag, log);
    return { ...defaultSettings(), corrupt: true };
  }
  let value;
  try {
    value = normalizeSettings(JSON.parse(text), diag);
  } catch (error) {
    log.warn("settings.json 解析失败：先留档，再从 last-good 恢复并写回", error);
    preserveCorruptSettings(path, log);
    return recoverFromLastGood(storageRoot, path, log, { diag });
  }
  publishDiagnostics(diag, log);
  // 解析成功但损坏标记仍在场（上次损坏恢复后用户尚未重存设置）：继续暴露 corrupt。
  return corruptFlagPresent(storageRoot) ? { ...value, corrupt: true } : value;
}

/** 把本次读取的诊断落进全局（供 getSettingsDiagnostics 取）并 warn 一次明细。 */
function publishDiagnostics(diag, log) {
  coercedFields = diag.fields;
  if (diag.notes.length === 0) return;
  log.warn(`settings.json 有 ${diag.notes.length} 项值非法已落默认（面板「设置」重存可写正）：${diag.notes.join("；")}`);
}

/**
 * 损坏/缺失恢复：从 last-good 影子读回并归一，随后把恢复结果【写回】settings.json——
 * 否则下一次 readSettings 见 ENOENT 又落默认全开，用户关过的开关被静默打开（fail-open）。
 *
 * 两条入口共用本函数：
 *   - 损坏路径（settings.json 解析失败，missing=false）：损坏事实对用户可见，本次读恒带 corrupt:true；
 *   - 缺失路径（settings.json ENOENT，missing=true）：若影子在场说明这是「损坏恢复窗口」中途崩溃
 *     （settings.json 已改名、写回未落），要恢复用户真实开关；影子也缺席才是真正的全新安装 →
 *     落默认全开、不标 corrupt（绝不把干净安装误标成损坏）。
 *
 * 影子本身损坏（解析失败）→ 留档改名 + 落默认 + corrupt:true（可见降级，不静默吞）。
 * 写回失败只 warn（本次读仍返回恢复值，不阻断）。恢复来源写进日志便于排障。
 */
function recoverFromLastGood(storageRoot, path, log, { missing = false, diag = newDiagnostics() } = {}) {
  const shadow = settingsLastGoodPath(storageRoot);
  let recovered;
  let shadowMissing = false;
  try {
    // 影子也是手改得动的盘上档：这里同样要记落默认诊断（口径与主档一致）。
    recovered = normalizeSettings(JSON.parse(readFileSync(shadow, "utf8")), diag);
    log.warn(`settings.json 已从 last-good 影子恢复（${SETTINGS_LAST_GOOD_FILENAME}）：三开关=${recovered.conversationMemory}/${recovered.projectMemory}/${recovered.globalExtraction}`);
  } catch (error) {
    recovered = defaultSettings();
    if (error?.code === "ENOENT") {
      shadowMissing = true;
      // 影子不存在：损坏路径下只能落默认（并标 corrupt）；缺失路径下是真正的全新安装。
      if (!missing) log.warn("settings.last-good.json 不存在，落默认（三开关全开）");
    } else {
      // 影子本身损坏：留档改名 + 落默认 + corrupt（原影子内容永不失访）。
      log.warn("settings.last-good.json 不可用，已留档并落默认（三开关全开）", error);
      preserveCorruptShadow(shadow, log);
    }
  }
  // corrupt 判定：损坏路径恒 true；缺失路径下仅当影子在场/可恢复、影子损坏、或损坏标记尚存时 true；
  // 两者皆无且无标记 = 真正的全新安装 → false（默认全开是正常缺省，不是降级）。
  const freshInstall = missing && shadowMissing && !corruptFlagPresent(storageRoot);
  const corrupt = !freshInstall;
  if (freshInstall) {
    // 全新安装：不写回（保持「干净安装盘上无 settings.json」形态）、不落标记。
    publishDiagnostics(diag, log);
    return recovered; // = defaultSettings()，corrupt:false
  }
  // 写回恢复结果（原子写）：让后续读拿到恢复后的真值，而不是退回"不存在=默认全开"。
  const { corrupt: _drop, ...persistable } = recovered;
  try {
    writeAtomicJson(path, persistable);
  } catch (error) {
    log.warn("settings.json 恢复结果写回失败（本次仍返回恢复值，下次读可能再走一遍恢复）", error);
  }
  // 落持久损坏标记：写回后 settings.json 已可解析，靠标记让 corrupt 一直暴露到用户重存设置。
  raiseCorruptFlag(storageRoot, log);
  publishDiagnostics(diag, log);
  return { ...recovered, corrupt };
}

/** 测试用：无缓存（保留导出以兼容既有调用方；清理无副作用）。 */
export function resetSettingsCache() { /* 无缓存，no-op */ }

/**
 * 合并式写入（原子写 tmp+rename）。patch 接受三开关键 + runtimeEnabled（运行时记忆层，
 * 缺省关）+ 写入安全面三项（surgicalKeep / trashKeepDays / hardfactPolicy）
 * + recentKeepDays + 可选 embedding（对象=覆盖，null=清除，缺位=不动）。
 * embedding.apiKey 三态：键缺省 → 保留已存密钥；null/"" → 显式清空；非空串 → 新值。
 * patch 语义：未提供的键保留现值；surgicalKeep / trashKeepDays 显式提供但非法 → 落默认
 * （读侧同口径，绝不 throw）；hardfactPolicy 白名单外 → 保留现值。其余键忽略。
 * 写前按现值合并，保证三键恒在。成功写入后同步刷新 last-good 影子（损坏时据此恢复）。
 * @returns 写入后的完整 settings 对象（含 corrupt: false）。
 */
export function writeSettings(storageRoot, patch, log = { warn: () => {} }, { fallbackApiKey = "" } = {}) {
  const current = readSettings(storageRoot, log);
  const next = {
    version: SETTINGS_VERSION,
    conversationMemory: typeof patch?.conversationMemory === "boolean" ? patch.conversationMemory : current.conversationMemory,
    projectMemory: typeof patch?.projectMemory === "boolean" ? patch.projectMemory : current.projectMemory,
    globalExtraction: typeof patch?.globalExtraction === "boolean" ? patch.globalExtraction : current.globalExtraction,
    // runtimeEnabled：与三开关同一 patch 口径（未提供 → 保留现值；现值缺省 false）。
    runtimeEnabled: typeof patch?.runtimeEnabled === "boolean" ? patch.runtimeEnabled : current.runtimeEnabled,
    // v0.4.0 写入安全面三项：与三开关同一 patch 语义——
    //   surgicalKeep / trashKeepDays：未提供（缺键/undefined）→ 保留现值；
    //   显式提供但非法 → 落默认（复用读侧 normalizeSafetySettings 的归一规则，绝不 throw）；
    //   hardfactPolicy：白名单外 → 保留现值。
    surgicalKeep: patch?.surgicalKeep !== void 0 ? normalizeSafetySettings({ surgicalKeep: patch.surgicalKeep }).surgicalKeep : current.surgicalKeep,
    trashKeepDays: patch?.trashKeepDays !== void 0 ? normalizeSafetySettings({ trashKeepDays: patch.trashKeepDays }).trashKeepDays : current.trashKeepDays,
    hardfactPolicy: HARDFACT_POLICIES.has(patch?.hardfactPolicy) ? patch.hardfactPolicy : current.hardfactPolicy,
  };
  // recentKeepDays：显式提供且合法 → 新值；显式提供但非法 → 保留现值（读侧同口径）；
  // 未提供 → 保留现值（现值可能缺省，此时不写该键，读侧回落 entry config）。
  if (patch?.recentKeepDays !== void 0) {
    const normalized = normalizeRecentKeepDays(patch.recentKeepDays);
    if (normalized !== void 0) next.recentKeepDays = normalized;
    else if (current.recentKeepDays !== void 0) next.recentKeepDays = current.recentKeepDays;
  } else if (current.recentKeepDays !== void 0) {
    next.recentKeepDays = current.recentKeepDays;
  }
  const emb = validateEmbedding(patch === null || typeof patch !== "object" ? void 0 : patch.embedding);
  if (emb === void 0) {
    if (current.embedding !== void 0) next.embedding = current.embedding; // 未提供：保留现有覆盖
  } else if (emb !== null) {
    // apiKey 三态写侧唯一合并点：validateEmbedding 在键缺省时剔掉 apiKey（= undefined），
    // 此处回填已存密钥——面板重存嵌入配置不再顶掉密钥；null/"" 已在 validateEmbedding
    // 归一成 ""（显式清空的显式落盘），不在此回填。回填链：settings 现值 → fallbackApiKey
    // （api 层注入的**生效**密钥：密钥来自 entry config 而 settings 尚无 embedding 时，
    // 重存会把 config 的密钥接管进 settings——否则 apiKey:"" 会遮蔽 YAML 里配置的密钥）。
    const keptApiKey = current.embedding?.apiKey
      ?? (typeof fallbackApiKey === "string" && fallbackApiKey.length > 0 ? fallbackApiKey : "");
    next.embedding = emb.apiKey === void 0 ? { ...emb, apiKey: keptApiKey } : emb;
  } // emb === null：显式清除，不写 embedding 键
  const path = settingsPath(storageRoot);
  writeAtomicJson(path, next);
  // last-good 影子：每次成功写入同步刷新（损坏时从它恢复，避免用户关过的开关被静默打开）。
  // 影子写失败只是丢了这层兜底（settings.json 本身已写成功），显式 warn 不阻断。
  try {
    writeAtomicJson(settingsLastGoodPath(storageRoot), next);
  } catch (error) {
    log.warn("settings.last-good.json 影子写入失败（settings.json 已写成功，损坏时无 last-good 可恢复）", error);
  }
  // 用户成功保存设置 = 已重写修复：清持久损坏标记（下次读不再报 corrupt）。
  clearCorruptFlag(storageRoot, log);
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

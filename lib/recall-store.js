// dsh-memory 语义召回：条目向量缓存（嵌入语义召回）。
//   <storageRoot>/embeddings.json
//     { version: 1, model: "", items: { [id]: { digest, vec } } }
// 定位：磁盘 JSON 缓存 + 增量同步纯逻辑。id 只当字符串键（稳定标识的含义由调用方决定）。
// 纪律（对齐 global-store）：
//   - 读 tolerant：文件缺失/损坏/形状不符/坏条目 → 退化默认空缓存，绝不 throw（缓存可再生）；
//   - 写原子：tmp + rename；写失败吞掉返回 false（记不了日志就静默降级，下次重建）；
//   - 纯逻辑（staleItems/applyEmbeddings/pruneCache）不碰磁盘、不原地改入参，便于单测。
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digestOf } from "./inject-channel.js";

/** 缓存文件名（相对 storageRoot）。 */
export const EMBEDDING_CACHE_FILE = "embeddings.json";

/** 缓存结构版本号。 */
const CACHE_VERSION = 1;

/** 缺省空缓存（每次新建，防共享可变对象）。 */
function emptyCache() {
  return { version: CACHE_VERSION, model: "", items: {} };
}

/** 纯对象判定（排除 null 与数组）。 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 数字数组判定（vec 必须非空且全为有限数；空数组不算有效向量）。 */
function isNumberArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** 缓存文件绝对路径。 */
function embeddingCachePath(storageRoot) {
  return join(storageRoot, EMBEDDING_CACHE_FILE);
}

/**
 * 读取向量缓存（tolerant，绝不 throw）。
 * 文件缺失/JSON 解析失败/顶层形状不符 → 返回默认空缓存；
 * items 非纯对象 → 整体回退默认；单个坏条目（digest 非串 / vec 非数字数组）→ 丢弃该条，保留其余。
 * @param {string} storageRoot 记忆存储根
 * @returns {{version: number, model: string, items: Record<string, {digest: string, vec: number[]}>}}
 */
export function loadEmbeddingCache(storageRoot) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(embeddingCachePath(storageRoot), "utf8"));
  } catch {
    return emptyCache();
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.items)) return emptyCache();
  const items = {};
  for (const [id, entry] of Object.entries(parsed.items)) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.digest !== "string") continue;
    if (!isNumberArray(entry.vec)) continue;
    items[id] = { digest: entry.digest, vec: entry.vec.slice() };
  }
  return {
    version: CACHE_VERSION,
    model: typeof parsed.model === "string" ? parsed.model : "",
    items,
  };
}

/**
 * 原子写向量缓存（<file>.tmp → rename）。目录由调用方保证已存在。
 * 写/改名失败吞掉返回 false（缓存可再生，静默降级）。
 * @param {string} storageRoot 记忆存储根
 * @param {object} cache 待写缓存（形状不符也照写，读侧 tolerant 兜底）
 * @returns {boolean} true=落盘成功
 */
export function saveEmbeddingCache(storageRoot, cache) {
  const path = embeddingCachePath(storageRoot);
  const tmp = `${path}.tmp`;
  try {
    const body = JSON.stringify(isPlainObject(cache) ? cache : emptyCache(), null, 2);
    writeFileSync(tmp, `${body}\n`, "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 纯逻辑：挑出需要重新嵌入的 item。
 * 判定 stale：cache.model !== model（整库换模型），或 cache.items[id] 缺失，
 * 或 digest 不匹配（digestOf(item.text)）。命中任一即返回该 item（含原 id/text）。
 * 入参不合法（非数组条目）跳过；缺失 id 的条目一律视为 stale。
 * @param {{model: string, items: object}} cache 现有缓存
 * @param {Array<{id: string, text: string}>} items 待召回条目
 * @param {string} model 目标嵌入模型标识
 * @returns {Array<{id: string, text: string}>} 需重新嵌入的条目（保持入参顺序）
 */
export function staleItems(cache, items, model) {
  const current = isPlainObject(cache) ? cache : emptyCache();
  const known = isPlainObject(current.items) ? current.items : {};
  const targetModel = typeof model === "string" ? model : "";
  const modelChanged = current.model !== targetModel;
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!isPlainObject(item)) continue;
    const cached = typeof item.id === "string" ? known[item.id] : void 0;
    const fresh = !modelChanged
      && isPlainObject(cached)
      && cached.digest === digestOf(item.text);
    if (!fresh) out.push(item);
  }
  return out;
}

/**
 * 纯逻辑：把新嵌入结果并入 cache（返回新 cache，不原地改）。
 * 换 model（cache.model !== model）时旧向量全部作废——清空 items 再并入，避免新旧模型向量混存。
 * embedded: [{ id, text, vec }]；缺 id / vec 非数字数组的条目跳过。
 * @param {{version?: number, model: string, items: object}} cache 现有缓存
 * @param {string} model 本次嵌入模型标识
 * @param {Array<{id: string, text: string, vec: number[]}>} embedded 新嵌入结果
 * @returns {{version: number, model: string, items: object}} 新的缓存
 */
export function applyEmbeddings(cache, model, embedded) {
  const current = isPlainObject(cache) ? cache : emptyCache();
  const targetModel = typeof model === "string" ? model : "";
  const base = current.model === targetModel && isPlainObject(current.items) ? current.items : {};
  const items = {};
  for (const [id, entry] of Object.entries(base)) {
    items[id] = { digest: entry.digest, vec: Array.isArray(entry.vec) ? entry.vec.slice() : [] };
  }
  for (const entry of Array.isArray(embedded) ? embedded : []) {
    if (!isPlainObject(entry) || typeof entry.id !== "string") continue;
    if (!isNumberArray(entry.vec)) continue;
    items[entry.id] = { digest: digestOf(entry.text), vec: entry.vec.slice() };
  }
  return { version: CACHE_VERSION, model: targetModel, items };
}

/**
 * 纯逻辑：删掉 id 不在 validIds 的条目（返回新 cache，不原地改）。
 * @param {{version?: number, model: string, items: object}} cache 现有缓存
 * @param {Set<string>|string[]} validIds 仍有效的条目 id 集合
 * @returns {{version: number, model: string, items: object}} 新的缓存
 */
export function pruneCache(cache, validIds) {
  const current = isPlainObject(cache) ? cache : emptyCache();
  const known = isPlainObject(current.items) ? current.items : {};
  const valid = validIds instanceof Set ? validIds : new Set(Array.isArray(validIds) ? validIds : []);
  const items = {};
  for (const [id, entry] of Object.entries(known)) {
    if (!valid.has(id) || !isPlainObject(entry)) continue;
    items[id] = { digest: entry.digest, vec: Array.isArray(entry.vec) ? entry.vec.slice() : [] };
  }
  return { version: CACHE_VERSION, model: typeof current.model === "string" ? current.model : "", items };
}

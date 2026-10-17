// dsh-keepsake 嵌入与召回（语义召回纯逻辑 + OpenAI 兼容嵌入客户端）。
// 除 embedTexts（唯一 I/O 出口，用全局 fetch）外全为纯函数；零新增依赖。
//   召回块经注入通道以 source.form=MEMORY_RECALL_FORM 落位（对齐 inject-channel 的 <memory-recall> 剥除口径）。
//   选型未确认：端点/模型由配置注入，本文件不内置任何服务地址。

import { estimateTokens } from "./tokens.js";

/** 召回块的 form 标识（注入消息 source.form；与 inject-channel.stripMemoryMarkup 的 <memory-recall> 同名系）。 */
export const MEMORY_RECALL_FORM = "memory-recall";

/** 嵌入请求默认超时（毫秒）。 */
const DEFAULT_EMBED_TIMEOUT_MS = 1500;

/** Re-export estimateTokens（对外签名不变）。 */
export { estimateTokens };

/**
 * 余弦相似度。非数组、长度不等、任一零范数（或含非有限元素）→ 返回 0。
 *
 * @param {*} a 向量 A
 * @param {*} b 向量 B
 * @returns {number} 相似度（保留原始浮点；退化情形一律 0）
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 选取召回条目（纯函数，无 I/O）。
 *
 * - 对每条算 `score = cosine(queryVec, vec)`，过滤 `score ≥ minScore`；
 * - 按 score 降序排序（稳定排序，分数相同保持原序）；
 * - 依次累加 `estimateTokens(text)`，若「加入该条后累计 > maxTokens」则**停止**（不跳过继续找）；
 * - 至多取 topK 条。
 *
 * @param {Array<{id:*, text:string, vec:number[]}>} items 候选条目
 * @param {number[]} queryVec 查询向量
 * @param {{topK?:number, minScore?:number, maxTokens?:number}} [options]
 * @returns {Array<{id:*, text:string, score:number}>} 命中条目（score 保留原始浮点）
 */
export function selectRecall(items, queryVec, { topK = 5, minScore = 0.35, maxTokens = 1200 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const scored = [];
  for (const item of list) {
    const score = cosineSimilarity(queryVec, item?.vec);
    if (score >= minScore) scored.push({ id: item?.id, text: item?.text, score });
  }
  scored.sort((x, y) => y.score - x.score);

  const picked = [];
  let used = 0;
  for (const hit of scored) {
    if (picked.length >= topK) break;
    const cost = estimateTokens(hit.text);
    if (used + cost > maxTokens) break;
    used += cost;
    picked.push(hit);
  }
  return picked;
}

/**
 * 解析嵌入响应。主形态为 OpenAI 兼容 `{data:[{embedding:[...]}]}`；
 * 另容忍两种本地服务常见形态：`{embedding:[...]}`（单条，如 ollama 原生 `/api/embeddings`）、
 * `{embeddings:[[...],...]}`（批量）。结构不符 → 返回 null。
 *
 * @param {*} json 解析后的响应体
 * @returns {number[][]|null} 每个输入一个向量；不合法时 null
 */
export function parseEmbeddingResponse(json) {
  const obj = json !== null && typeof json === "object" ? json : null;
  if (obj === null) return null;
  if ("data" in obj) {
    const data = obj.data;
    if (!Array.isArray(data) || data.length === 0) return null;
    const vectors = [];
    for (const item of data) {
      if (!isFiniteVector(item?.embedding)) return null;
      vectors.push(item.embedding);
    }
    return vectors;
  }
  if (isFiniteVector(obj.embedding)) return [obj.embedding];
  if (Array.isArray(obj.embeddings) && obj.embeddings.length > 0) {
    const vectors = [];
    for (const embedding of obj.embeddings) {
      if (!isFiniteVector(embedding)) return null;
      vectors.push(embedding);
    }
    return vectors;
  }
  return null;
}

/** 非空且全为有限数的数组（一条有效向量）。 */
function isFiniteVector(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const n of value) {
    if (!Number.isFinite(n)) return false;
  }
  return true;
}

/**
 * 调用嵌入端点（OpenAI 兼容）：`POST <baseUrl>`，JSON 体 `{model, input: texts}`，
 * 有 apiKey 时带 `Authorization: Bearer <apiKey>`。唯一做 I/O 的导出，fetch 可注入以便测试。
 * 失败一律 throw（调用方据此降级）：HTTP 非 2xx → `Error("embedding HTTP <status>")`；
 * 响应解析为 null 或条数不符 → throw；超时（timeoutMs 默认 1500）→ throw。
 * 用内部 AbortController 实现超时；若传入外部 signal，二者任一 abort 都取消请求。
 *
 * @param {{baseUrl:string, model:string, apiKey?:string, texts:string[], fetchImpl?:Function, signal?:AbortSignal, timeoutMs?:number}} opts
 * @returns {Promise<number[][]>} 每个输入一个向量
 */
export async function embedTexts(opts) {
  const {
    baseUrl,
    model,
    apiKey,
    texts,
    fetchImpl = globalThis.fetch,
    signal: externalSignal,
    timeoutMs = DEFAULT_EMBED_TIMEOUT_MS,
  } = opts ?? {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`embedding timeout ${timeoutMs}ms`)), timeoutMs);
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const headers = { "Content-Type": "application/json" };
    if (typeof apiKey === "string" && apiKey.length > 0) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: texts }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`embedding HTTP ${response.status}`);
    const vectors = parseEmbeddingResponse(await response.json());
    if (vectors === null) throw new Error("embedding: 响应结构不符");
    if (vectors.length !== (Array.isArray(texts) ? texts.length : 0)) {
      throw new Error(`embedding: 向量条数不符（${vectors.length} ≠ ${texts?.length}）`);
    }
    return vectors;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }
}

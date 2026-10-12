// embedding：嵌入与召回纯逻辑 + OpenAI 兼容嵌入客户端（estimateTokens/cosineSimilarity/
//   selectRecall/parseEmbeddingResponse/embedTexts）。embedTexts 用注入的假 fetchImpl 测，不触网。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MEMORY_RECALL_FORM,
  cosineSimilarity,
  embedTexts,
  estimateTokens,
  parseEmbeddingResponse,
  selectRecall,
} from "../lib/embedding.js";

const close = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps;

/** 构造假 Response（仅 embedTexts 用到的字段）。 */
function fakeResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return body; } };
}

test("常量：MEMORY_RECALL_FORM 与注入剥除口径同名", () => {
  assert.equal(MEMORY_RECALL_FORM, "memory-recall");
});

test("① estimateTokens：ASCII / CJK / 混合 / 空 / 非字符串 的数值", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("a"), 1); // 0.25 → ceil 1
  assert.equal(estimateTokens("cd"), 1); // 0.5 → 1
  assert.equal(estimateTokens("abcd"), 1); // 1.0 → 1
  assert.equal(estimateTokens("abcde"), 2); // 1.25 → 2
  assert.equal(estimateTokens("中文"), 3); // 2 × 1.5
  assert.equal(estimateTokens("a中"), 2); // 0.25 + 1.5 = 1.75 → 2
  assert.equal(estimateTokens("中中中中"), 6); // 4 × 1.5
  // 同长度 CJK 明显高于 ASCII
  assert.ok(estimateTokens("中中中中") > estimateTokens("aaaa"));
  // 码点边界：0x3000 起算高密度，0x2FFF 仍按 ASCII
  assert.equal(estimateTokens(String.fromCodePoint(0x3000)), 2);
  assert.equal(estimateTokens(String.fromCodePoint(0x2fff)), 1);
  // 代理对按单个码点处理（emoji U+1F600 ≥ 0x3000）
  assert.equal(estimateTokens("😀"), 2);
  // 非字符串先 String()
  assert.equal(estimateTokens(123), 1); // "123" → 0.75 → 1
  assert.equal(estimateTokens(null), 1); // "null" → 1.0
  assert.equal(estimateTokens(true), 1); // "true" → 1.0
  assert.equal(estimateTokens(undefined), 3); // "undefined" → 2.25 → 3
});

test("①b estimateTokens：单调不减", () => {
  const seq = ["", "a", "ab", "abcd", "abcde", "中", "中文", "中中中中"];
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(
      estimateTokens(seq[i]) >= estimateTokens(seq[i - 1]),
      `estimateTokens 单调性坏于 ${JSON.stringify(seq[i - 1])} → ${JSON.stringify(seq[i])}`,
    );
  }
});

test("② cosineSimilarity：正交/同向/反向/退化", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0); // 正交
  assert.ok(close(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1)); // 同向
  assert.ok(close(cosineSimilarity([1, 0], [2, 0]), 1));
  assert.ok(close(cosineSimilarity([1, 0], [-1, 0]), -1)); // 反向
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0); // 零范数
  assert.equal(cosineSimilarity([1, 2], [1]), 0); // 长度不等
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity([], []), 0); // 空
  assert.equal(cosineSimilarity("x", [1]), 0); // 非数组
  assert.equal(cosineSimilarity(null, null), 0);
  assert.equal(cosineSimilarity([1, NaN], [1, 1]), 0); // 非有限元素
});

test("③ selectRecall：按分数降序", () => {
  const items = [
    { id: "c", text: "cccc", vec: [0, 1] }, // score 0（被 minScore 挡下）
    { id: "a", text: "aaaa", vec: [1, 0] }, // score 1
    { id: "b", text: "bbbb", vec: [0.8, 0.6] }, // score 0.8
  ];
  const got = selectRecall(items, [1, 0]);
  assert.deepEqual(got.map((x) => x.id), ["a", "b"]);
  assert.ok(close(got[0].score, 1));
  assert.ok(close(got[1].score, 0.8));
});

test("③b selectRecall：minScore 过滤，无命中返回 []", () => {
  const items = [
    { id: "a", text: "aaaa", vec: [1, 0] },
    { id: "c", text: "cccc", vec: [0, 1] },
  ];
  assert.deepEqual(selectRecall(items, [1, 0], { minScore: 0.35 }).map((x) => x.id), ["a"]);
  assert.deepEqual(selectRecall(items, [1, 0], { minScore: 1.01, topK: 5 }), []);
  // 全不命中
  assert.deepEqual(selectRecall([{ id: "c", text: "c", vec: [0, 1] }], [1, 0]), []);
});

test("③c selectRecall：topK 截断", () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ id: i, text: "aaaa", vec: [1, 0] }));
  const got = selectRecall(items, [1, 0], { topK: 3 });
  assert.equal(got.length, 3);
  // 同分稳定排序：保持原序
  assert.deepEqual(got.map((x) => x.id), [0, 1, 2]);
});

test("③d selectRecall：maxTokens 预算截断为“停止”而非“跳过”", () => {
  const items = [
    { id: "i1", text: "aaaa", vec: [1, 0] }, // 1 token
    { id: "i2", text: "b".repeat(40), vec: [1, 0] }, // 10 token → 超预算应停
    { id: "i3", text: "cccc", vec: [1, 0] }, // 1 token（若“跳过”会进来，必须不进来）
  ];
  const got = selectRecall(items, [1, 0], { maxTokens: 5 });
  assert.deepEqual(got.map((x) => x.id), ["i1"]);
  // 首条即超预算 → 空
  assert.deepEqual(selectRecall([{ id: "big", text: "b".repeat(40), vec: [1, 0] }], [1, 0], { maxTokens: 2 }), []);
});

test("③e selectRecall：score 保留原始浮点", () => {
  const got = selectRecall([{ id: "x", text: "aaaa", vec: [1, 1] }], [1, 0], { minScore: 0.5 });
  assert.equal(got.length, 1);
  assert.ok(close(got[0].score, Math.SQRT1_2)); // cos = 1/√2
});

test("④ parseEmbeddingResponse：合法", () => {
  assert.deepEqual(parseEmbeddingResponse({ data: [{ embedding: [1, 2, 3] }, { embedding: [4, 5] }] }), [[1, 2, 3], [4, 5]]);
  assert.deepEqual(parseEmbeddingResponse({ data: [{ embedding: [0] }] }), [[0]]);
});

test("④b parseEmbeddingResponse：缺 data / 空 embedding / 垃圾 → null", () => {
  assert.equal(parseEmbeddingResponse({}), null);
  assert.equal(parseEmbeddingResponse({ data: null }), null);
  assert.equal(parseEmbeddingResponse({ data: "x" }), null);
  assert.equal(parseEmbeddingResponse({ data: [] }), null); // 空 data
  assert.equal(parseEmbeddingResponse({ data: [{}] }), null);
  assert.equal(parseEmbeddingResponse({ data: [{ embedding: [] }] }), null); // 空向量
  assert.equal(parseEmbeddingResponse({ data: [{ embedding: ["a", "b"] }] }), null); // 非数值
  assert.equal(parseEmbeddingResponse(null), null);
  assert.equal(parseEmbeddingResponse(undefined), null);
  assert.equal(parseEmbeddingResponse(42), null);
});

test("⑤a embedTexts：请求 url/method/body/Content-Type（无 key 不带 Authorization）", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return fakeResponse({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] });
  };
  const vectors = await embedTexts({ baseUrl: "http://localhost:11434/v1/embeddings", model: "nomic-embed", texts: ["a", "b"], fetchImpl });

  assert.deepEqual(vectors, [[1, 2], [3, 4]]);
  assert.equal(captured.url, "http://localhost:11434/v1/embeddings");
  assert.equal(captured.options.method, "POST");
  assert.deepEqual(JSON.parse(captured.options.body), { model: "nomic-embed", input: ["a", "b"] });
  assert.equal(captured.options.headers["Content-Type"], "application/json");
  assert.ok(!("Authorization" in captured.options.headers));
  assert.ok(captured.options.signal instanceof AbortSignal);
});

test("⑤b embedTexts：有 apiKey 带 Authorization: Bearer", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = options;
    return fakeResponse({ data: [{ embedding: [7] }] });
  };
  await embedTexts({ baseUrl: "https://api.example.com/v1/embeddings", model: "m", apiKey: "secret", texts: ["x"], fetchImpl });
  assert.equal(captured.headers.Authorization, "Bearer secret");
});

test("⑤c embedTexts：非 2xx 抛 embedding HTTP <status>", async () => {
  await assert.rejects(
    embedTexts({ baseUrl: "http://x", model: "m", texts: ["a"], fetchImpl: async () => fakeResponse({}, { ok: false, status: 429 }) }),
    /embedding HTTP 429/,
  );
});

test("⑤d embedTexts：响应结构不符抛错", async () => {
  await assert.rejects(
    embedTexts({ baseUrl: "http://x", model: "m", texts: ["a"], fetchImpl: async () => fakeResponse({}) }),
    /响应结构不符/,
  );
});

test("⑤e embedTexts：向量条数不符抛错", async () => {
  await assert.rejects(
    embedTexts({ baseUrl: "http://x", model: "m", texts: ["a", "b"], fetchImpl: async () => fakeResponse({ data: [{ embedding: [1] }] }) }),
    /条数不符/,
  );
});

test("⑤f embedTexts：fetch reject 原样抛出", async () => {
  await assert.rejects(
    embedTexts({ baseUrl: "http://x", model: "m", texts: ["a"], fetchImpl: () => Promise.reject(new Error("net down")) }),
    /net down/,
  );
});

test("⑤g embedTexts：超时抛出（signal 感知的永不 resolve 假 fetch）", async () => {
  let sawAbort = false;
  const neverFetch = (url, options) => new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => {
      sawAbort = true;
      reject(options.signal.reason instanceof Error ? options.signal.reason : new Error("aborted"));
    }, { once: true });
  });
  await assert.rejects(
    embedTexts({ baseUrl: "http://x", model: "m", texts: ["a"], fetchImpl: neverFetch, timeoutMs: 20 }),
    /timeout 20ms/,
  );
  assert.equal(sawAbort, true);
});

test("⑤h embedTexts：外部 signal abort 取消请求", async () => {
  const controller = new AbortController();
  const neverFetch = (url, options) => new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason instanceof Error ? options.signal.reason : new Error("aborted")), { once: true });
  });
  const pending = embedTexts({ baseUrl: "http://x", model: "m", texts: ["a"], fetchImpl: neverFetch, signal: controller.signal, timeoutMs: 100000 });
  controller.abort(new Error("external cancel"));
  await assert.rejects(pending, /external cancel/);
});

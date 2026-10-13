// recall-store：条目向量缓存（磁盘 JSON + 增量同步纯逻辑）。
// 覆盖：tolerant 读 / 原子写往返 / stale 判定 / 并入 / 裁剪 / 入参不被污染。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digestOf } from "../lib/inject-channel.js";
import {
  EMBEDDING_CACHE_FILE,
  applyEmbeddings,
  loadEmbeddingCache,
  pruneCache,
  saveEmbeddingCache,
  staleItems,
} from "../lib/recall-store.js";

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-recall-"));
}

/** 在 root 下直接落一个 embeddings.json（不走 save，测坏档容错）。 */
function writeRaw(root, text) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, EMBEDDING_CACHE_FILE), text, "utf8");
}

const DEFAULT_EMPTY = { version: 1, model: "", items: {} };

// ---- ① load 缺失文件 → 默认空缓存 ----

test("loadEmbeddingCache：文件缺失 → 默认空缓存", () => {
  const root = freshRoot();
  try {
    assert.deepEqual(loadEmbeddingCache(root), DEFAULT_EMPTY);
    // 目录本身也不存在时同样 tolerant
    assert.deepEqual(loadEmbeddingCache(join(root, "nope", "deep")), DEFAULT_EMPTY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ② load 容错：损坏 JSON / 形状不符 / 坏 vec 条目 ----

test("loadEmbeddingCache：损坏 JSON → 默认空缓存（不 throw）", () => {
  const root = freshRoot();
  try {
    writeRaw(root, "{ this is not json");
    assert.deepEqual(loadEmbeddingCache(root), DEFAULT_EMPTY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadEmbeddingCache：形状不符 → 默认空缓存", () => {
  const root = freshRoot();
  try {
    // 顶层非对象
    writeRaw(root, JSON.stringify("just a string"));
    assert.deepEqual(loadEmbeddingCache(root), DEFAULT_EMPTY);
    writeRaw(root, JSON.stringify([1, 2, 3]));
    assert.deepEqual(loadEmbeddingCache(root), DEFAULT_EMPTY);
    // items 非纯对象（数组 / null / 缺失）
    writeRaw(root, JSON.stringify({ version: 1, model: "m", items: [] }));
    assert.deepEqual(loadEmbeddingCache(root), DEFAULT_EMPTY);
    writeRaw(root, JSON.stringify({ version: 1, model: "m", items: null }));
    assert.deepEqual(loadEmbeddingCache(root), DEFAULT_EMPTY);
    writeRaw(root, JSON.stringify({ version: 1, model: "m" }));
    assert.deepEqual(loadEmbeddingCache(root), DEFAULT_EMPTY);
    // model 非串 → 归一为空串（items 保留）
    writeRaw(root, JSON.stringify({ version: 1, model: 42, items: { a: { digest: "d", vec: [0.1] } } }));
    assert.deepEqual(loadEmbeddingCache(root), { version: 1, model: "", items: { a: { digest: "d", vec: [0.1] } } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadEmbeddingCache：坏 vec/digest 条目丢弃，好条目保留", () => {
  const root = freshRoot();
  try {
    writeRaw(root, JSON.stringify({
      version: 1,
      model: "text-embed-1",
      items: {
        good: { digest: "abc", vec: [0.1, 0.2, 0.3] },
        badVec: { digest: "abc", vec: ["0.1", "0.2"] },
        badVecNaN: { digest: "abc", vec: [0.1, null] },
        badDigest: { digest: 123, vec: [0.1] },
        nullEntry: null,
        stringEntry: "nope",
        // digest 缺失
        noDigest: { vec: [0.1] },
      },
    }));
    const cache = loadEmbeddingCache(root);
    assert.deepEqual(cache, {
      version: 1,
      model: "text-embed-1",
      items: { good: { digest: "abc", vec: [0.1, 0.2, 0.3] } },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ③ save → load 往返一致 ----

test("saveEmbeddingCache：写盘成功返回 true，save→load 往返一致", () => {
  const root = freshRoot();
  try {
    const cache = {
      version: 1,
      model: "text-embed-1",
      items: {
        "a.md": { digest: digestOf("alpha"), vec: [0.1, 0.2] },
        "b.md": { digest: digestOf("beta"), vec: [1, 2, 3] },
      },
    };
    assert.equal(saveEmbeddingCache(root, cache), true);
    assert.deepEqual(loadEmbeddingCache(root), cache);
    // 落盘为合法 JSON 文本
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(root, EMBEDDING_CACHE_FILE), "utf8")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveEmbeddingCache：非对象入参退化为默认空缓存落盘，仍返回 true", () => {
  const root = freshRoot();
  try {
    assert.equal(saveEmbeddingCache(root, null), true);
    assert.deepEqual(loadEmbeddingCache(root), DEFAULT_EMPTY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ④ staleItems ----

test("staleItems：新条目 / digest 变化 / model 变化均判 stale，未变的不 stale", () => {
  const cache = {
    version: 1,
    model: "m1",
    items: {
      a: { digest: digestOf("alpha"), vec: [0.1] },
      b: { digest: digestOf("beta-old"), vec: [0.2] },
    },
  };
  // 同 model：a 未变（不 stale）、b digest 变化（stale）、c 新条目（stale）
  const items = [
    { id: "a", text: "alpha" },
    { id: "b", text: "beta-new" },
    { id: "c", text: "gamma" },
  ];
  assert.deepEqual(staleItems(cache, items, "m1"), [
    { id: "b", text: "beta-new" },
    { id: "c", text: "gamma" },
  ]);
  // 换 model：即便 digest 未变也全部 stale
  assert.deepEqual(staleItems(cache, items, "m2"), items);
  // 全新鲜 → 空数组
  assert.deepEqual(staleItems(cache, [{ id: "a", text: "alpha" }], "m1"), []);
  // 缺失 id 的条目一律 stale；乱序/非对象条目跳过
  assert.deepEqual(staleItems(cache, [null, { text: "no-id" }, "x"], "m1"), [{ text: "no-id" }]);
  // cache 为空缓存 → 全部 stale
  assert.deepEqual(staleItems(DEFAULT_EMPTY, items, "m1"), items);
});

// ---- ⑤ applyEmbeddings ----

test("applyEmbeddings：并入后同 model 同 text 不再 stale，digest 按 text 计算", () => {
  const cache = { version: 1, model: "m1", items: { a: { digest: digestOf("alpha"), vec: [0.1] } } };
  const embedded = [
    { id: "b", text: "beta", vec: [0.2, 0.3] },
    { id: "c", text: "gamma", vec: [0.4] },
  ];
  const next = applyEmbeddings(cache, "m1", embedded);
  assert.equal(next.model, "m1");
  assert.deepEqual(next.items.a, { digest: digestOf("alpha"), vec: [0.1] });
  assert.deepEqual(next.items.b, { digest: digestOf("beta"), vec: [0.2, 0.3] });
  assert.deepEqual(next.items.c, { digest: digestOf("gamma"), vec: [0.4] });
  // 并入的条目不再 stale
  const items = [
    { id: "a", text: "alpha" },
    { id: "b", text: "beta" },
    { id: "c", text: "gamma" },
  ];
  assert.deepEqual(staleItems(next, items, "m1"), []);
  // 坏条目（缺 id / vec 非数字数组）跳过，不写坏值
  const dirty = applyEmbeddings(next, "m1", [
    { id: "d", text: "delta", vec: "no" },
    { text: "no-id", vec: [1] },
    null,
    { id: "e", text: "epsilon", vec: [0.5] },
  ]);
  assert.equal("d" in dirty.items, false);
  assert.deepEqual(dirty.items.e, { digest: digestOf("epsilon"), vec: [0.5] });
});

test("applyEmbeddings：换 model 时旧向量全作废（清空 items 后并入）", () => {
  const cache = { version: 1, model: "m1", items: { a: { digest: digestOf("alpha"), vec: [0.1] } } };
  const next = applyEmbeddings(cache, "m2", [{ id: "b", text: "beta", vec: [0.9] }]);
  assert.equal(next.model, "m2");
  assert.deepEqual(next.items, { b: { digest: digestOf("beta"), vec: [0.9] } });
});

// ---- ⑥ pruneCache ----

test("pruneCache：移除不在 validIds 的条目，保留的带过来", () => {
  const cache = {
    version: 1,
    model: "m1",
    items: {
      a: { digest: "da", vec: [0.1] },
      b: { digest: "db", vec: [0.2] },
      c: { digest: "dc", vec: [0.3] },
    },
  };
  assert.deepEqual(pruneCache(cache, new Set(["a", "c"])), {
    version: 1,
    model: "m1",
    items: { a: { digest: "da", vec: [0.1] }, c: { digest: "dc", vec: [0.3] } },
  });
  // 数组形式的 validIds 亦可
  assert.deepEqual(Object.keys(pruneCache(cache, ["b"]).items), ["b"]);
  // 空集 → 全清（model 保留）
  assert.deepEqual(pruneCache(cache, []), { version: 1, model: "m1", items: {} });
});

// ---- ⑦ 不污染原对象 ----

test("applyEmbeddings/pruneCache 返回新对象，不改原 cache", () => {
  const cache = { version: 1, model: "m1", items: { a: { digest: digestOf("alpha"), vec: [0.1] } } };
  const snapshot = JSON.parse(JSON.stringify(cache));

  const applied = applyEmbeddings(cache, "m1", [{ id: "b", text: "beta", vec: [0.2] }]);
  assert.notEqual(applied, cache);
  assert.notEqual(applied.items, cache.items);
  assert.deepEqual(cache, snapshot);

  const pruned = pruneCache(cache, new Set());
  assert.notEqual(pruned, cache);
  assert.notEqual(pruned.items, cache.items);
  assert.deepEqual(cache, snapshot);

  // 并入条目追加后，原 cache.items 未被牵连
  assert.deepEqual(Object.keys(cache.items), ["a"]);
});

test("save/load 不污染入参：save 后原对象不变，load 返回独立副本", () => {
  const root = freshRoot();
  try {
    const cache = { version: 1, model: "m1", items: { a: { digest: "da", vec: [0.1, 0.2] } } };
    const snapshot = JSON.parse(JSON.stringify(cache));
    assert.equal(saveEmbeddingCache(root, cache), true);
    assert.deepEqual(cache, snapshot);

    const loaded = loadEmbeddingCache(root);
    assert.deepEqual(loaded, cache);
    // load 返回的是深拷贝：改 loaded 不影响再次 load，也不影响原对象
    loaded.items.a.vec.push(9);
    loaded.items.a.digest = "mutated";
    delete loaded.items.a;
    assert.deepEqual(loadEmbeddingCache(root), cache);
    assert.deepEqual(cache, snapshot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

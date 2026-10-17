// tokens.test.mjs：estimateTokens 估算器完整测试矩阵 + re-export 钉。
import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTokens as estimateFromTokens } from "../lib/tokens.js";
import { estimateTokens as estimateFromEmbedding } from "../lib/embedding.js";

test("① CJK：码点 ≥ 0x3000 按 1.5 token/字", () => {
  assert.equal(estimateFromTokens("中文"), 3); // 2 × 1.5
  assert.equal(estimateFromTokens("中中中中"), 6); // 4 × 1.5
  assert.equal(estimateFromTokens(String.fromCodePoint(0x3000)), 2); // 0x3000 边界
  assert.equal(estimateFromTokens(String.fromCodePoint(0x4e00)), 2); // 汉字区首字
  assert.equal(estimateFromTokens(String.fromCodePoint(0x9fff)), 2); // 汉字区末字
});

test("② ASCII：码点 < 0x3000 按 0.25 token/字（≈ chars/4）", () => {
  assert.equal(estimateFromTokens("a"), 1); // 0.25 → ceil 1
  assert.equal(estimateFromTokens("cd"), 1); // 0.5 → 1
  assert.equal(estimateFromTokens("abcd"), 1); // 1.0 → 1
  assert.equal(estimateFromTokens("abcde"), 2); // 1.25 → 2
  assert.equal(estimateFromTokens("abcdefgh"), 2); // 2.0 → 2
  assert.equal(estimateFromTokens("".padStart(9, "x")), 3); // 2.25 → 3
});

test("③ 边界：0x2FFF 与 0x3000 紧邻行为不同", () => {
  assert.equal(estimateFromTokens(String.fromCodePoint(0x2fff)), 1); // < 0x3000 → 0.25 → 1
  assert.equal(estimateFromTokens(String.fromCodePoint(0x3000)), 2); // ≥ 0x3000 → 1.5 → 2
});

test("④ Emoji：代理对按单个码点处理（≥ 0x3000 算高密度）", () => {
  assert.equal(estimateFromTokens("😀"), 2); // U+1F600 ≥ 0x3000 → 1.5 → 2
  assert.equal(estimateFromTokens("😀😀"), 3); // 2 × 1.5 = 3
  assert.equal(estimateFromTokens("a😀"), 2); // 0.25 + 1.5 = 1.75 → 2
});

test("⑤ 空串：0 token", () => {
  assert.equal(estimateFromTokens(""), 0);
});

test("⑥ 非字符串：先 String() 归一", () => {
  assert.equal(estimateFromTokens(123), 1); // "123" → 0.75 → 1
  assert.equal(estimateFromTokens(null), 1); // "null" → 1.0 → 1
  assert.equal(estimateFromTokens(true), 1); // "true" → 1.0 → 1
  assert.equal(estimateFromTokens(false), 2); // "false" → 1.25 → 2
  assert.equal(estimateFromTokens(undefined), 3); // "undefined" → 2.25 → 3
  assert.equal(estimateFromTokens({}), 4); // "[object Object]" → 3.75 → 4
});

test("⑦ 单调性：长度增加时 token 数不减", () => {
  const seq = ["", "a", "ab", "abcd", "abcde", "中", "中文", "中中中中"];
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(
      estimateFromTokens(seq[i]) >= estimateFromTokens(seq[i - 1]),
      `estimateTokens 单调性坏于 ${JSON.stringify(seq[i - 1])} → ${JSON.stringify(seq[i])}`,
    );
  }
});

test("⑧ 混合文本：CJK 显著高于同长度 ASCII", () => {
  assert.ok(estimateFromTokens("中中中中") > estimateFromTokens("aaaa"));
  assert.ok(estimateFromTokens("中文中文") > estimateFromTokens("abcdefgh"));
});

test("⑨ re-export 钉：embedding.js 导出的 estimateTokens 与 tokens.js 是同一实现", () => {
  // 行为逐例相等
  const cases = [
    "",
    "a",
    "abcd",
    "abcde",
    "中文",
    "a中",
    "中中中中",
    String.fromCodePoint(0x2fff),
    String.fromCodePoint(0x3000),
    "😀",
    123,
    null,
    true,
    undefined,
  ];
  for (const t of cases) {
    assert.equal(
      estimateFromTokens(t),
      estimateFromEmbedding(t),
      `estimateTokens 行为不一致于输入 ${JSON.stringify(t)}`,
    );
  }
});

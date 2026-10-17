// dsh-keepsake Token 估算（从 embedding.js 原样搬迁）。
//   口径：码点 ≥ 0x3000（CJK/全角等）按 1.5 token/字，其余按 0.25 token/字（≈ chars/4）。
//   按 Unicode 码点遍历（代理对算一个码点），逐点累加后向上取整为非负整数（空串 → 0）。

/** 码点 ≥ 此值视为 CJK/全角区（高 token 密度），否则按 ASCII 口径。 */
const CJK_CODEPOINT_MIN = 0x3000;

/**
 * 估算文本 token 数（openviking 口径）：码点 ≥ 0x3000（CJK/全角等）按 1.5 token/字，
 * 其余按 0.25 token/字（≈ chars/4）。按 Unicode 码点遍历（代理对算一个码点），
 * 逐点累加后向上取整为非负整数（空串 → 0）。
 *
 * @param {*} text 任意文本（非字符串先 String() 归一）
 * @returns {number} 非负整数 token 估算
 */
export function estimateTokens(text) {
  const value = typeof text === "string" ? text : String(text);
  let sum = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    sum += cp >= CJK_CODEPOINT_MIN ? 1.5 : 0.25;
  }
  return Math.ceil(sum);
}

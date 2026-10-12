// inject-channel：注入通道纯逻辑（包裹/拼接顺序/预算丢弃/persona 兜底/比较/判据/摘要）
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INJECT_DROPPABLE_ORDER,
  INJECT_SEGMENT_ORDER,
  INJECT_SOURCE_KIND,
  MEMORY_CONTEXT_FORM,
  MEMORY_CONTEXT_INTRO,
  buildMemoryContext,
  digestOf,
  isPluginSourcedMessage,
  sameInjectionText,
  stripMemoryMarkup,
} from "../lib/inject-channel.js";

test("常量：来源标识/ form / 顺序", () => {
  assert.equal(INJECT_SOURCE_KIND, "plugin:dsh-memory");
  assert.equal(MEMORY_CONTEXT_FORM, "memory-context");
  assert.deepEqual(INJECT_SEGMENT_ORDER, ["persona", "globalIndex", "usage", "projectIndex"]);
  assert.deepEqual(INJECT_DROPPABLE_ORDER, ["globalIndex", "projectIndex", "usage"]);
  assert.ok(!INJECT_DROPPABLE_ORDER.includes("persona"), "persona 不参与丢弃");
});

test("① 全空段 → text 为空、不丢不截", () => {
  assert.deepEqual(buildMemoryContext({}), { text: "", dropped: [], truncated: false });
  assert.deepEqual(buildMemoryContext(undefined), { text: "", dropped: [], truncated: false });
  assert.deepEqual(
    buildMemoryContext({ persona: "", globalIndex: undefined, usage: "", projectIndex: "" }),
    { text: "", dropped: [], truncated: false },
  );
});

test("② 四段拼接：顺序正确、`\\n\\n` 分隔、标签各占一行包裹", () => {
  const segments = { persona: "人格", globalIndex: "全局索引", usage: "用法", projectIndex: "项目索引" };
  const { text, dropped, truncated } = buildMemoryContext(segments);
  assert.equal(
    text,
    "<memory-context>\n人格\n\n全局索引\n\n用法\n\n项目索引\n</memory-context>",
  );
  assert.deepEqual(dropped, []);
  assert.equal(truncated, false);
  assert.ok(text.startsWith("<memory-context>\n"));
  assert.ok(text.endsWith("\n</memory-context>"));
  // 顺序：persona < globalIndex < usage < projectIndex
  assert.ok(text.indexOf("人格") < text.indexOf("全局索引"));
  assert.ok(text.indexOf("全局索引") < text.indexOf("用法"));
  assert.ok(text.indexOf("用法") < text.indexOf("项目索引"));
});

test("③ 预算内不丢段（truncated=false）", () => {
  const segments = { persona: "P".repeat(10), globalIndex: "G".repeat(10), usage: "U".repeat(10), projectIndex: "J".repeat(10) };
  const { text, dropped, truncated } = buildMemoryContext(segments); // 默认 60000
  assert.deepEqual(dropped, []);
  assert.equal(truncated, false);
  assert.ok(text.includes("P".repeat(10)) && text.includes("G".repeat(10)));
  assert.ok(text.includes("U".repeat(10)) && text.includes("J".repeat(10)));
  // 恰在预算边界（等于长度）不丢
  const exact = buildMemoryContext(segments, { maxChars: text.length });
  assert.deepEqual(exact.dropped, []);
  assert.equal(exact.truncated, false);
});

test("④ 小预算按序丢弃 globalIndex→projectIndex，dropped 正确、被丢段消失、含提示行", () => {
  const segments = { persona: "P".repeat(10), globalIndex: "G".repeat(10), usage: "U".repeat(10), projectIndex: "J".repeat(10) };
  // 全量 text 长 81（35 包裹 + 46 正文）；62 触发丢 globalIndex(69>62) 再丢 projectIndex(57≤62)
  const { text, dropped, truncated } = buildMemoryContext(segments, { maxChars: 62 });
  assert.deepEqual(dropped, ["globalIndex", "projectIndex"]);
  assert.equal(truncated, true);
  assert.ok(!text.includes("G".repeat(10)), "被丢段 globalIndex 不应出现");
  assert.ok(!text.includes("J".repeat(10)), "被丢段 projectIndex 不应出现");
  assert.ok(text.includes("P".repeat(10)) && text.includes("U".repeat(10)), "保留段仍在");
  assert.match(text, /\[memory-context truncated: dropped globalIndex, projectIndex\]/);
  assert.ok(text.startsWith("<memory-context>\n"));
  assert.ok(text.endsWith("\n</memory-context>"));
});

test("④b 单段超限：只丢 globalIndex 即达标", () => {
  const segments = { persona: "P".repeat(10), globalIndex: "G".repeat(10), usage: "U".repeat(10), projectIndex: "J".repeat(10) };
  const { dropped, truncated } = buildMemoryContext(segments, { maxChars: 70 });
  assert.deepEqual(dropped, ["globalIndex"]);
  assert.equal(truncated, true);
});

test("⑤ persona 兜底截断：maxChars 小于 persona 本身仍以 `<memory-context>` 开头", () => {
  const { text, dropped, truncated } = buildMemoryContext({ persona: "A".repeat(100) }, { maxChars: 50 });
  assert.equal(truncated, true);
  assert.deepEqual(dropped, [], "persona 不整段丢弃");
  assert.ok(text.startsWith("<memory-context>"), "仍以标签开头");
  assert.ok(text.endsWith("</memory-context>"));
  assert.ok(text.includes("…"), "末尾省略号");
  assert.ok(text.includes("A".repeat(10)), "保留头部内容");
  assert.ok(!text.includes("A".repeat(100)), "已截断，非全文");
  assert.match(text, /\[memory-context truncated: persona truncated\]/);
});

test("⑥ sameInjectionText：空白差异判等、类型不符判否", () => {
  assert.equal(sameInjectionText("a  b\n\tc", "a b c"), true); // 连续空白折叠
  assert.equal(sameInjectionText("  x  ", "x"), true); // 首尾空白
  assert.equal(sameInjectionText("<memory-context>\nA\n</memory-context>", "<memory-context>   A   </memory-context>"), true);
  assert.equal(sameInjectionText("x", "y"), false);
  assert.equal(sameInjectionText("", "x"), false);
  assert.equal(sameInjectionText(1, "1"), false); // 非字符串
  assert.equal(sameInjectionText(null, null), false);
  assert.equal(sameInjectionText(undefined, ""), false);
});

test("⑦ isPluginSourcedMessage：plugin / plugin:xxx / 普通 / undefined", () => {
  assert.equal(isPluginSourcedMessage({ source: { kind: "plugin" } }), true);
  assert.equal(isPluginSourcedMessage({ source: { kind: "plugin:dsh-memory" } }), true);
  assert.equal(isPluginSourcedMessage({ source: { kind: "agent-instructions" } }), false);
  assert.equal(isPluginSourcedMessage({}), false);
  assert.equal(isPluginSourcedMessage(undefined), false);
  assert.equal(isPluginSourcedMessage(null), false);
  assert.equal(isPluginSourcedMessage({ source: { kind: 123 } }), false);
});

test("⑧ digestOf：稳定且区分输入", () => {
  assert.equal(digestOf("hello"), digestOf("hello"));
  assert.notEqual(digestOf("hello"), digestOf("world"));
  assert.match(digestOf("hello"), /^[0-9a-f]{40}$/);
  assert.equal(digestOf(123), digestOf("123")); // 非字符串先 String() 归一
  assert.equal(digestOf(""), digestOf(""));
});

test("⑨ B3 免责/署名行：intro 在开标签后首行、计入预算；缺省不破坏既有形态", () => {
  const segments = { persona: "人格" };
  assert.equal(buildMemoryContext(segments).text, "<memory-context>\n人格\n</memory-context>", "无 intro 形态不变");
  const { text } = buildMemoryContext(segments, { intro: "INTRO" });
  assert.equal(text, "<memory-context>\nINTRO\n\n人格\n</memory-context>");
  assert.ok(MEMORY_CONTEXT_INTRO.length > 0);
  // intro 计入预算：给刚够正文+包裹、不够 intro 的预算 → 触发 persona 截断
  const tight = buildMemoryContext({ persona: "A".repeat(50) }, { maxChars: 50, intro: MEMORY_CONTEXT_INTRO });
  assert.equal(tight.truncated, true);
  assert.ok(tight.text.includes(MEMORY_CONTEXT_INTRO), "intro 仍在（先保 intro 再截正文）");
});

test("⑩ B4 stripMemoryMarkup：剥 <memory-context>/<memory-recall> 整段，保留其余", () => {
  const squash = (s) => s.replace(/\s+/g, " ").trim();
  assert.equal(squash(stripMemoryMarkup("前 <memory-context>\nA\n</memory-context> 后")), "前 后");
  assert.equal(stripMemoryMarkup("<memory-recall>x</memory-recall>"), "");
  assert.equal(stripMemoryMarkup("无标签纯文本"), "无标签纯文本");
  assert.equal(stripMemoryMarkup(undefined), "");
  assert.equal(stripMemoryMarkup(123), "123");
  assert.equal(stripMemoryMarkup("<memory-context>unclosed"), "<memory-context>unclosed", "未闭合不误吃");
});

// inject-channel：注入通道纯逻辑（包裹/拼接顺序/预算丢弃/persona 兜底/比较/判据/摘要
// + 同源替换三件套：取代声明 / 变更节流 shouldReinject / 增量计数 summarizeInjectionDelta）
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INJECT_DROPPABLE_ORDER,
  INJECT_LOCKED_SEGMENTS,
  INJECT_SEGMENT_ORDER,
  INJECT_SOURCE_KIND,
  INJECT_TRUNCATION_ORDER,
  MEMORY_CONTEXT_FORM,
  MEMORY_CONTEXT_INTRO,
  MEMORY_CONTEXT_SUPERSEDE_NOTE,
  REINJECT_MIN_ABS_DELTA,
  REINJECT_MIN_REL_DELTA,
  REINJECT_SIMILARITY_MIN,
  REINJECT_SIMILARITY_REWRITE,
  REINJECT_SMALL_TEXT,
  bigramSimilarity,
  buildMemoryContext,
  digestOf,
  isPluginSourcedMessage,
  sameInjectionText,
  shouldReinject,
  stripMemoryMarkup,
  summarizeInjectionDelta,
} from "../lib/inject-channel.js";

test("常量：来源标识/ form / 顺序", () => {
  assert.equal(INJECT_SOURCE_KIND, "plugin:dsh-keepsake");
  assert.equal(MEMORY_CONTEXT_FORM, "memory-context");
  // 六段（RUNTIME-FORMAT §10.1）：runtime 两段插在 persona 与 globalIndex 之间，现有四段相对序不动
  assert.deepEqual(INJECT_SEGMENT_ORDER, ["persona", "runtimeUser", "runtimeMemory", "globalIndex", "usage", "projectIndex"]);
  assert.deepEqual(INJECT_DROPPABLE_ORDER, ["globalIndex", "projectIndex", "usage"]);
  for (const locked of ["persona", "runtimeUser", "runtimeMemory"]) {
    assert.ok(!INJECT_DROPPABLE_ORDER.includes(locked), `${locked} 是锁定段，不参与丢弃`);
  }
  // 锁定段兜底截断顺序：从最低优先级开始（persona 最后）
  assert.deepEqual(INJECT_TRUNCATION_ORDER, ["runtimeMemory", "runtimeUser", "persona"]);
  // 现有四段相对顺序不动（usage 不前移）
  const fourOld = INJECT_SEGMENT_ORDER.filter((name) => !["runtimeUser", "runtimeMemory"].includes(name));
  assert.deepEqual(fourOld, ["persona", "globalIndex", "usage", "projectIndex"]);
});

test("① 全空段 → text 为空、不丢不截", () => {
  assert.deepEqual(buildMemoryContext({}), { text: "", dropped: [], truncated: false, tokens: 0 });
  assert.deepEqual(buildMemoryContext(undefined), { text: "", dropped: [], truncated: false, tokens: 0 });
  assert.deepEqual(
    buildMemoryContext({ persona: "", globalIndex: undefined, usage: "", projectIndex: "" }),
    { text: "", dropped: [], truncated: false, tokens: 0 },
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
  assert.equal(isPluginSourcedMessage({ source: { kind: "plugin:dsh-keepsake" } }), true);
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

test("⑨ 免责/署名行：intro 在开标签后首行、计入预算；缺省不破坏既有形态", () => {
  const segments = { persona: "人格" };
  assert.equal(buildMemoryContext(segments).text, "<memory-context>\n人格\n</memory-context>", "无 intro 形态不变");
  const { text } = buildMemoryContext(segments, { intro: "INTRO" });
  assert.equal(text, "<memory-context>\nINTRO\n\n人格\n</memory-context>");
  assert.ok(MEMORY_CONTEXT_INTRO.length > 0);
  // intro 计入预算：给刚够正文+包裹、不够 intro 的预算 → 触发 persona 截断
  const tight = buildMemoryContext({ persona: "A".repeat(50) }, { maxChars: 50, intro: MEMORY_CONTEXT_INTRO });
  assert.equal(tight.truncated, true);
  // 预算连「包裹 + intro + 提示行」都装不下时，锁定段会被截空 → 只剩零内容的壳块。
  // 零内容 = 与「不注入」同义：按空文本返回（调用侧据此跳过），绝不占着预算发空壳。
  assert.equal(tight.text, "", "内容段被截空 → 不发零内容空壳块");
  // 预算够放包裹+intro+少量正文时：intro 与提示行都在，正文被截断且不越界
  const roomy = buildMemoryContext({ persona: "A".repeat(400) }, { maxChars: 460, intro: MEMORY_CONTEXT_INTRO });
  assert.equal(roomy.truncated, true);
  assert.ok(roomy.text.includes(MEMORY_CONTEXT_INTRO), "intro 仍在（先保 intro 再截正文）");
  assert.ok(roomy.text.length <= 460, `截断后仍在预算内（实际 ${roomy.text.length}）`);
});

test("⑩ stripMemoryMarkup：剥 <memory-context>/<memory-recall> 整段，保留其余", () => {
  const squash = (s) => s.replace(/\s+/g, " ").trim();
  assert.equal(squash(stripMemoryMarkup("前 <memory-context>\nA\n</memory-context> 后")), "前 后");
  assert.equal(stripMemoryMarkup("<memory-recall>x</memory-recall>"), "");
  assert.equal(stripMemoryMarkup("无标签纯文本"), "无标签纯文本");
  assert.equal(stripMemoryMarkup(undefined), "");
  assert.equal(stripMemoryMarkup(123), "123");
  assert.equal(stripMemoryMarkup("<memory-context>unclosed"), "<memory-context>unclosed", "未闭合不误吃");
});

// ---- 同源替换：① 取代声明 / ② 变更节流 / ③ 增量计数 ----

test("⑪ 取代声明：块首在场、位于 intro 之前、与正文空行分隔", () => {
  const segments = { persona: "人格" };
  const { text } = buildMemoryContext(segments, {
    intro: MEMORY_CONTEXT_INTRO,
    supersedeNote: MEMORY_CONTEXT_SUPERSEDE_NOTE,
  });
  assert.ok(text.startsWith("<memory-context>\n"), "开标签仍独占首行");
  const firstLine = text.split("\n")[1];
  assert.equal(firstLine, MEMORY_CONTEXT_SUPERSEDE_NOTE, "取代声明是第一行");
  assert.ok(text.includes(MEMORY_CONTEXT_INTRO), "intro 仍在");
  assert.ok(
    text.indexOf(MEMORY_CONTEXT_SUPERSEDE_NOTE) < text.indexOf(MEMORY_CONTEXT_INTRO),
    "取代声明在免责行之前",
  );
  assert.ok(text.includes(`${MEMORY_CONTEXT_SUPERSEDE_NOTE}\n\n`), "声明与后文空行分隔");
  assert.ok(text.endsWith("\n</memory-context>"));
  assert.ok(MEMORY_CONTEXT_SUPERSEDE_NOTE.includes("supersedes"), "措辞含取代语义");
  assert.ok(MEMORY_CONTEXT_SUPERSEDE_NOTE.includes("ignore the older ones"), "措辞含忽略旧块指引");
});

test("⑪b 取代声明计入总预算：加了声明即占额度、缺省不出（既有形态不变）", () => {
  const segments = { persona: "A".repeat(2000) };
  const bare = buildMemoryContext(segments, { maxChars: 100000 });
  const withNote = buildMemoryContext(segments, { maxChars: 100000, supersedeNote: MEMORY_CONTEXT_SUPERSEDE_NOTE });
  assert.ok(!bare.text.includes(MEMORY_CONTEXT_SUPERSEDE_NOTE), "缺省不出声明（既有形态不变）");
  assert.equal(
    withNote.text.length - bare.text.length,
    MEMORY_CONTEXT_SUPERSEDE_NOTE.length + 2,
    "声明 + 其后空行整额计入长度",
  );
  // 同一预算：没声明时放得下、有声明时触发截断 —— 声明确实在花同一份额度
  const budget = bare.text.length;
  assert.equal(buildMemoryContext(segments, { maxChars: budget }).truncated, false, "裸块正好装下");
  const tight = buildMemoryContext(segments, { maxChars: budget, supersedeNote: MEMORY_CONTEXT_SUPERSEDE_NOTE });
  assert.equal(tight.truncated, true, "声明占预算 → 触发截断");
  assert.ok(tight.text.length <= budget, `不得越界（实际 ${tight.text.length} ≤ ${budget}）`);
  assert.ok(tight.text.includes(MEMORY_CONTEXT_SUPERSEDE_NOTE), "声明先保，正文让位");
  // 显式传空串 = 关掉（与缺省同形）
  assert.equal(buildMemoryContext(segments, { supersedeNote: "" }).text, bare.text);
});

test("⑫ shouldReinject：first（上次为空 → 发）", () => {
  const r = shouldReinject({ visible: true, lastInjectedText: "", nextText: "新块" });
  assert.deepEqual(r, { inject: true, reason: "first", similarity: 0 });
  assert.equal(shouldReinject({ visible: false, lastInjectedText: undefined, nextText: "新块" }).reason, "first");
  // 纯空白（含换行）也当"没注入过"——不是"没变"，别把首次注入误判成不变
  assert.equal(shouldReinject({ visible: true, lastInjectedText: "  \n\t ", nextText: "新块" }).reason, "first");
});

test("⑬ shouldReinject：resend（视野不可见 → 必发，节流让路）", () => {
  const last = "旧块内容 A";
  const r = shouldReinject({ visible: false, lastInjectedText: last, nextText: last });
  assert.deepEqual(r, { inject: true, reason: "resend", similarity: 1 });
  // 完全相同也必发（压缩挤出后补发靠这条路）
  assert.equal(shouldReinject({ visible: false, lastInjectedText: "X".repeat(100), nextText: "X".repeat(100) }).inject, true);
  // visible 缺失/非 true 一律按不可见处理（漏传退回"每轮都发"，绝不静默漏发）
  assert.equal(shouldReinject({ lastInjectedText: "a".repeat(50), nextText: "a".repeat(50) }).reason, "resend");
  assert.equal(shouldReinject({ visible: undefined, lastInjectedText: "q", nextText: "q" }).reason, "resend");
  // 视野不可见时连"变化太小"也让路（压缩后补发是唯一的收敛手段）
  assert.equal(shouldReinject({ visible: false, lastInjectedText: "旧".repeat(500), nextText: "旧".repeat(500) + "。" }).reason, "resend");
});

test("⑭ shouldReinject：unchanged（规范化后相等 → 不发）", () => {
  const text = "<memory-context>\n记忆正文\n</memory-context>";
  assert.deepEqual(shouldReinject({ visible: true, lastInjectedText: text, nextText: text }), {
    inject: false,
    reason: "unchanged",
    similarity: 1,
  });
  // 空白差异（首尾/连续空白折叠）也算不变
  const spaced = "  <memory-context>\n\n  记忆正文  \n\n</memory-context>  ";
  assert.equal(shouldReinject({ visible: true, lastInjectedText: text, nextText: spaced }).reason, "unchanged");
  // 空/纯空白 next：不发（不为补发而发一个空块）
  assert.equal(shouldReinject({ visible: true, lastInjectedText: text, nextText: "" }).reason, "unchanged");
  assert.equal(shouldReinject({ visible: true, lastInjectedText: text, nextText: "   " }).reason, "unchanged");
});

test("⑮ shouldReinject：changed（实质变化 → 发）", () => {
  // 追加 300 个全新字符：相似度掉到 0.04、字符差 300 > 地板 200 → 放行
  const base = "记忆条目一：使用 pnpm。".repeat(20);
  const fresh = Array.from({ length: 300 }, (_, i) => String.fromCharCode(0x5000 + i)).join("");
  const r = shouldReinject({ visible: true, lastInjectedText: base, nextText: base + fresh });
  assert.equal(r.inject, true);
  assert.equal(r.reason, "changed");
  assert.ok(r.similarity < REINJECT_SIMILARITY_MIN, `相似度应掉到阈下（实际 ${r.similarity}）`);
  assert.ok(r.similarity >= 0 && r.similarity <= 1);
});

test("⑯ shouldReinject：throttled（变化太小 → 不发）", () => {
  // 7200 字文本尾部加一个字符：字符差 1 ≤ 地板 200 → 节流（相似度 0.957 其实没过阈）
  const body = "记忆条目一：使用 pnpm，禁止 npm ci。".repeat(300);
  const r = shouldReinject({ visible: true, lastInjectedText: body, nextText: `${body}。` });
  assert.equal(r.inject, false);
  assert.equal(r.reason, "throttled");
  assert.ok(r.similarity < REINJECT_SIMILARITY_MIN, `本例是 delta 规则接住的（相似度 ${r.similarity} 未过阈）`);
  // 另一类：同长度替换（pnpm→yarn）→ 相似度 0.704 也没过阈，仍是 delta 规则接住
  // 真正的相似度规则样本见 ⑰（阈值边界）；这里确认"长度不变的修改一律节流"
  const swap = body.replaceAll("pnpm", "yarn");
  assert.equal(swap.length, body.length, "同长度替换 → 字符差 0");
  assert.equal(shouldReinject({ visible: true, lastInjectedText: body, nextText: swap }).reason, "throttled");
  // 压得很小的块（persona 独苗、几十字）：只改一个字 → 字符差 0 → 节流
  const tiny = "简短人设：回答用中文。";
  const tinyEdited = "简短人设：回答用中文。".replace("中文", "汉语");
  assert.equal(shouldReinject({ visible: true, lastInjectedText: tiny, nextText: tinyEdited }).reason, "throttled");
  // 但小块的实质变化（换主题）→ 放行：字符差短文本也按差量判，差值够大就发
  assert.equal(
    shouldReinject({ visible: true, lastInjectedText: tiny, nextText: "完整人格设定与偏好：".repeat(30) }).reason,
    "changed",
  );
});

test("⑰ 阈值边界：bigram 相似度 0.98 上下（差一个 2-gram 即换分支）", () => {
  // 唯一 2-gram 文本：token = "a" + 一个汉字，两两组合均不重复
  const token = (i) => `a${String.fromCharCode(0x4e00 + i)}`;
  const base = (m) => {
    let out = "";
    for (let i = 0; i < m; i += 1) out += token(i);
    return out;
  };
  const M = 5000;
  const last = base(M);
  assert.ok(last.length >= REINJECT_SMALL_TEXT, "大文本走 bigram 分支");

  // 追加 p 个新 token（长度 2p）：交集 2M-1、并集 2M+2p-1 → sim = (2M-1)/(2M+2p-1)
  // p=102 → 0.98001 ≥ 0.98（节流）；p=103 → 0.97981 < 0.98（发）；两边字符差都 > 地板值
  const grow = (p) => {
    let out = last;
    for (let i = 0; i < p; i += 1) out += `a${String.fromCharCode(0x8000 + i)}`;
    return out;
  };
  const justUnder = shouldReinject({ visible: true, lastInjectedText: last, nextText: grow(102) });
  const justOver = shouldReinject({ visible: true, lastInjectedText: last, nextText: grow(103) });
  assert.ok(justUnder.similarity >= REINJECT_SIMILARITY_MIN, `p=102 相似度 ${justUnder.similarity} 应 ≥ 0.98`);
  assert.ok(justOver.similarity < REINJECT_SIMILARITY_MIN, `p=103 相似度 ${justOver.similarity} 应 < 0.98`);
  assert.equal(justUnder.reason, "throttled", "刚好过阈 → 节流");
  assert.equal(justOver.reason, "changed", "刚好掉到阈下 → 发");
  // 边界两侧字符差都远超地板值，说明换分支确实由相似度阈值决定（不是被 delta 规则抢走）
  const floor = Math.max(REINJECT_MIN_ABS_DELTA, Math.max(last.length, grow(102).length) * REINJECT_MIN_REL_DELTA);
  assert.ok(Math.abs(grow(102).length - last.length) > floor, "节流侧不是靠 delta 规则");
  assert.ok(Math.abs(grow(103).length - last.length) > floor, "发放侧不是靠 delta 规则");
  // 阈值常量本身
  assert.equal(REINJECT_SIMILARITY_MIN, 0.98);
  assert.equal(REINJECT_MIN_ABS_DELTA, 200);
  assert.equal(REINJECT_MIN_REL_DELTA, 0.01);
});

test("⑰b delta 地板规则：字符差 ≤ max(200, 全长 1%) 也节流（长度不变的小幅改写也算小变）", () => {
  // 长度完全相等（字符差 0 ≤ 地板值）、相似度仍在地板之上（未整块换掉）→ 节流（只改文字不动版式也算小变）
  const M = 400;
  let last = "";
  for (let i = 0; i < M; i += 1) last += tokenOf(i);
  let next = "";
  for (let i = 0; i < M; i += 1) next += i < 360 ? tokenOf(i) : `b${String.fromCharCode(0x9f00 + i)}`;
  assert.equal(next.length, last.length, "长度相同 → 字符差 0");
  const r = shouldReinject({ visible: true, lastInjectedText: last, nextText: next });
  assert.equal(r.reason, "throttled", "字符差未过地板值 → 节流");
  assert.ok(r.similarity < REINJECT_SIMILARITY_MIN, "相似度没过阈，是 delta 规则接住的");
  assert.ok(r.similarity >= REINJECT_SIMILARITY_REWRITE, "相似度仍在地板之上，不是整块换掉");
  // 地板值随长度放大：20000 字的地板 = max(200, 200) = 200 → 差 200 节流、差 400 放行
  const base = last.repeat(25);
  assert.equal(base.length, 20000);
  const tail = (n) => {
    let out = "";
    for (let i = 0; i < n; i += 1) out += tokenOf(i + 5000);
    return base + out;
  };
  const small = shouldReinject({ visible: true, lastInjectedText: base, nextText: tail(100) });
  assert.equal(small.reason, "throttled", "追加 50 个 token（差 200 字）→ 节流");
  assert.ok(small.similarity < REINJECT_SIMILARITY_MIN, "本例是 delta 规则接住的（相似度 ${small.similarity} 未过阈）");
  const bigger = shouldReinject({ visible: true, lastInjectedText: base, nextText: tail(200) });
  assert.equal(bigger.reason, "changed", "追加 100 个 token（差 400 字）→ 放行");
  assert.ok(bigger.similarity < REINJECT_SIMILARITY_MIN, "相似度也未过阈——是 delta 门槛放的行");
  // 长度不变的原地替换：差 0 → 必节流（改文字不动版式也算小变）
  // 150 个 token 换 150 个 token（300 字换 300 字）→ 总长不变
  let rep = "";
  for (let i = 0; i < 150; i += 1) rep += tokenOf(i + 9000);
  const inPlace = base.slice(0, 10000) + rep + base.slice(10300);
  assert.equal(inPlace.length, base.length, "长度相同 → 字符差 0");
  assert.equal(shouldReinject({ visible: true, lastInjectedText: base, nextText: inPlace }).reason, "throttled");
  assert.ok(shouldReinject({ visible: true, lastInjectedText: base, nextText: inPlace }).similarity < REINJECT_SIMILARITY_MIN,
    "相似度很低，是 delta 规则接住的");
  // 相对成分真的在起作用：20000 字的地板 = max(200, 202.01) = 202.01。
  // 差 201 / 202 过了绝对值 200、没过相对值 202.01 → 只有 max(…) 完整才算节流；
  // 差 203 两个都过了 → 放行。（去掉 max 里的相对项，k=201/202 会被误放行）
  const longBase = last.repeat(25);
  assert.equal(longBase.length, 20000);
  const pad = (k) => {
    let out = "";
    for (let i = 0; i < k; i += 1) out += String.fromCharCode(0x5000 + i);
    return longBase + out;
  };
  for (const k of [201, 202]) {
    assert.equal(shouldReinject({ visible: true, lastInjectedText: longBase, nextText: pad(k) }).reason, "throttled",
      `差 ${k} 过了绝对值 200、没过相对值 ${(20201 + k) * 0.01} → 节流`);
  }
  assert.equal(shouldReinject({ visible: true, lastInjectedText: longBase, nextText: pad(203) }).reason, "changed",
    "差 203 两个都过了 → 放行");
  function tokenOf(i) {
    return `a${String.fromCharCode(0x4e00 + i)}`;
  }
});

test("⑰c 等长原地改写：整块换掉放行、小幅等长改写仍节流（相似度例外）", () => {
  const tokenOf = (i) => `a${String.fromCharCode(0x4e00 + i)}`;
  const build = (from, count) => {
    let out = "";
    for (let i = 0; i < count; i += 1) out += tokenOf(from + i);
    return out;
  };
  // 300 字全文换新：长度不变（字符差 0）、相似度 ≈ 0 → 必须放行，否则地板规则永久节流
  const before = build(0, 150);
  const after = build(9000, 150);
  assert.equal(after.length, before.length, "两侧等长 → 字符差 0，地板规则接不住");
  const rewritten = shouldReinject({ visible: true, lastInjectedText: before, nextText: after });
  assert.equal(rewritten.inject, true, "整块换掉必须放行");
  assert.equal(rewritten.reason, "changed");
  assert.ok(rewritten.similarity < REINJECT_SIMILARITY_REWRITE, `相似度应低到改写线之下（实际 ${rewritten.similarity}）`);
  // 等长小改（只动一个字符、相似度 ≥ 0.98）→ 仍节流：例外只救"整段换新"，不放开零碎抖动
  const tweaked = `${before.slice(0, 150)}Z${before.slice(151)}`;
  assert.equal(tweaked.length, before.length, "等长小改");
  const held = shouldReinject({ visible: true, lastInjectedText: before, nextText: tweaked });
  assert.equal(held.inject, false);
  assert.equal(held.reason, "throttled");
  assert.ok(held.similarity >= REINJECT_SIMILARITY_MIN, `相似度应过阈（实际 ${held.similarity}）`);
  // 边界：相似度落在 [0.5, 0.98) 之间的等长改写不属"整块换掉"，仍按地板规则节流
  const partial = shouldReinject({
    visible: true,
    lastInjectedText: before,
    nextText: `${before.slice(0, 60)}${build(9000, 30)}${before.slice(120)}`,
  });
  assert.equal(partial.reason, "throttled", "半程改写相似度过改写线 → 仍节流");
  assert.ok(partial.similarity >= REINJECT_SIMILARITY_REWRITE, "相似度在改写线之上");
  assert.equal(REINJECT_SIMILARITY_REWRITE, 0.5);
});

test("⑱ 小文本：不比 bigram，按字符差判（<20 字符）", () => {
  assert.equal(REINJECT_SMALL_TEXT, 20);
  // 两侧都短：只差一个字符 → 相似度不参与（样本不足、比值抖动），按字符差判 → 节流
  const r = shouldReinject({ visible: true, lastInjectedText: "记忆A", nextText: "记忆B" });
  assert.equal(r.reason, "throttled");
  assert.equal(r.similarity, 0, "小文本不落到无意义的 bigram 比值上");
  // 同长度的短文本：字符差 0 ≤ 地板值 → 节流（小改动不值得每轮补发）
  assert.equal(shouldReinject({ visible: true, lastInjectedText: "旧索引", nextText: "新索引" }).reason, "throttled");
  // 两侧都 ≥ 20 才真正比 bigram（短侧参与时一律走字符差，不掺 bigram 噪声）
  const long = "记忆条目一。".repeat(50);
  const short = shouldReinject({ visible: true, lastInjectedText: long, nextText: "短" });
  assert.equal(short.reason, "changed", "短侧参与：字符差 299 > 地板 300 的边界之外 → 放行");
  assert.equal(short.similarity, 0);
  const a = "记忆条目一：使用 pnpm。".repeat(20);
  const b = "记忆条目一：使用 yarn。".repeat(20);
  assert.ok(shouldReinject({ visible: true, lastInjectedText: a, nextText: b }).similarity > 0, "都够长才比 bigram");
});

test("⑲ bigramSimilarity：自身=1、无交集=0、对称、空串兜底", () => {
  assert.equal(bigramSimilarity("abcde", "abcde"), 1);
  assert.equal(bigramSimilarity("", ""), 1, "两侧都空 → 1（无可比内容）");
  assert.equal(bigramSimilarity("abc", ""), 0);
  assert.equal(bigramSimilarity("", "abc"), 0);
  assert.equal(bigramSimilarity("ab", "cd"), 0, "无共用 2-gram");
  // abcd vs abxd：gram 集 {ab,bc,cd} vs {ab,bx,xd} → 交 1、并 5
  assert.equal(bigramSimilarity("abcd", "abxd"), 1 / 5);
  assert.equal(bigramSimilarity("abcd", "abxd"), bigramSimilarity("abxd", "abcd"), "对称");
  // 单字符文本没有 2-gram → 并集空 → 1（不抛错、不 NaN）
  assert.equal(bigramSimilarity("a", "a"), 1);
  assert.equal(bigramSimilarity("a", "b"), 1, "都无 2-gram 时不臆断差异");
});

test("⑳ shouldReinject 确定性：同输入两次输出全等、入参健壮", () => {
  const input = { visible: true, lastInjectedText: "旧".repeat(500), nextText: `${"旧".repeat(500)}新条目` };
  assert.deepEqual(shouldReinject(input), shouldReinject(input));
  // 缺失入参 / 非字符串：不抛错
  assert.equal(shouldReinject().reason, "first");
  assert.equal(shouldReinject({}).reason, "first");
  assert.equal(shouldReinject({ visible: true, lastInjectedText: 123, nextText: 456 }).reason, "first");
  assert.equal(shouldReinject({ visible: true, lastInjectedText: "x".repeat(50), nextText: null }).reason, "unchanged");
  // 返回字段恒定且类型稳定
  for (const r of [shouldReinject(), shouldReinject(input), shouldReinject({ visible: false, lastInjectedText: "a", nextText: "b" })]) {
    assert.deepEqual(Object.keys(r).sort(), ["inject", "reason", "similarity"]);
    assert.equal(typeof r.inject, "boolean");
    assert.equal(typeof r.similarity, "number");
    assert.ok(["first", "resend", "changed", "unchanged", "throttled"].includes(r.reason));
  }
});

test("㉑ summarizeInjectionDelta：首发不计 superseded，之后发一次 +1", () => {
  // 首发：没旧块可取代
  const first = summarizeInjectionDelta(undefined, { sent: true });
  assert.deepEqual(first, { superseded: 0, throttled: 0, sent: true });
  // 第二块：prior=true → 取代一块旧块
  const state = { superseded: first.superseded, throttled: first.throttled, prior: true };
  const second = summarizeInjectionDelta(state, { sent: true });
  assert.deepEqual(second, { superseded: 1, throttled: 0, sent: true });
  // 连续发 3 块：1 → 2 → 3
  const third = summarizeInjectionDelta({ ...second, prior: true }, { sent: true });
  assert.equal(third.superseded, 2);
  const fourth = summarizeInjectionDelta({ superseded: third.superseded, prior: true }, { sent: true });
  assert.equal(fourth.superseded, 3);
  // 没发（节流/不变）：计数不动
  const held = summarizeInjectionDelta({ superseded: 3, prior: true }, { sent: false, throttled: true });
  assert.deepEqual(held, { superseded: 3, throttled: 1, sent: false });
});

test("㉑b summarizeInjectionDelta：throttled 独立累计、脏值按 0、纯函数不改入参", () => {
  let acc = { superseded: 0, throttled: 0, prior: false };
  acc = summarizeInjectionDelta(acc, { sent: true });           // 首发
  assert.equal(acc.superseded, 0);
  acc = { ...acc, prior: true, superseded: acc.superseded, throttled: acc.throttled };
  for (let i = 0; i < 4; i += 1) {
    const prev = { superseded: acc.superseded, throttled: acc.throttled, prior: true };
    acc = summarizeInjectionDelta(prev, { sent: false, throttled: true });
  }
  assert.equal(acc.throttled, 4, "节流四次累四次");
  assert.equal(acc.superseded, 0, "节流不发块，不产生取代");
  // 脏值：NaN/Infinity/负数/数字字符串/其它类型 一律按 0（计数只增不减，脏值不透进 /state）
  const dirty = summarizeInjectionDelta({ superseded: NaN, throttled: -5, prior: true }, { sent: true });
  assert.deepEqual(dirty, { superseded: 1, throttled: 0, sent: true });
  const inf = summarizeInjectionDelta({ superseded: Infinity, throttled: "abc", prior: true }, { sent: true });
  assert.deepEqual(inf, { superseded: 1, throttled: 0, sent: true });
  const str = summarizeInjectionDelta({ superseded: "12", throttled: "9", prior: true }, { sent: true });
  assert.deepEqual(str, { superseded: 1, throttled: 0, sent: true }, "数字字符串不当数字用（归零重数更可预测）");
  const nullish = summarizeInjectionDelta({ superseded: null, throttled: undefined, prior: true }, { sent: true });
  assert.deepEqual(nullish, { superseded: 1, throttled: 0, sent: true });
  const empty = summarizeInjectionDelta(null, {});
  assert.deepEqual(empty, { superseded: 0, throttled: 0, sent: false });
  // 纯函数：入参对象不被改写
  const prev = { superseded: 2, throttled: 1, prior: true };
  summarizeInjectionDelta(prev, { sent: true, throttled: true });
  assert.deepEqual(prev, { superseded: 2, throttled: 1, prior: true });
});

test("㉑c summarizeInjectionDelta：prior 只认自有字段，原型污染不把首发算成取代", () => {
  // 进程内任何地方写下 Object.prototype.prior=true 都会污染所有对象；只认自有的 prior，
  // 否则首发(sent=true, 无 prior)会被误算成一次取代。
  Object.prototype.prior = true;
  try {
    const first = summarizeInjectionDelta(undefined, { sent: true });
    assert.deepEqual(first, { superseded: 0, throttled: 0, sent: true }, "原型污染下首发仍不计取代");
    // 显式传 prior:false 的自有字段同样按不取代处理（自有字段覆盖原型）
    const ownFalse = summarizeInjectionDelta({ prior: false, superseded: 4 }, { sent: true });
    assert.deepEqual(ownFalse, { superseded: 4, throttled: 0, sent: true });
    // 自有 prior:true 仍正常计一次取代（污染不改变正常路径）
    const ownTrue = summarizeInjectionDelta({ prior: true, superseded: 4 }, { sent: true });
    assert.deepEqual(ownTrue, { superseded: 5, throttled: 0, sent: true });
  } finally {
    delete Object.prototype.prior;
  }
  assert.equal(Object.prototype.prior, undefined, "测完还原污染");
  // 还原后首发照旧不计取代
  assert.deepEqual(summarizeInjectionDelta(undefined, { sent: true }), { superseded: 0, throttled: 0, sent: true });
});

// ---- token 预算（maxTokens）：CJK 感知估算、双上限取更严者、maxTokens=0 逐字节回归 ----

import { estimateTokens } from "../lib/tokens.js";

test("㉒ maxTokens=0（缺省）→ 与字符口径逐字节一致；tokens 字段 = estimateTokens(text)", () => {
  const segments = { persona: "人格说明", globalIndex: "全局索引条目", usage: "用法说明", projectIndex: "项目索引" };
  const charsOnly = buildMemoryContext(segments, { maxChars: 80 });
  const zeroTokens = buildMemoryContext(segments, { maxChars: 80, maxTokens: 0 });
  assert.equal(zeroTokens.text, charsOnly.text, "maxTokens=0 不改变文本");
  assert.deepEqual(zeroTokens.dropped, charsOnly.dropped);
  assert.equal(zeroTokens.truncated, charsOnly.truncated);
  assert.equal(charsOnly.tokens, estimateTokens(charsOnly.text), "tokens 字段与默认估算一致");
});

test("㉓ token 超限按 INJECT_DROPPABLE_ORDER 丢段（字符预算宽松时由 token 顶紧）", () => {
  // 四段各 40 个中文字（60 token/段）：maxChars 宽松、maxTokens 只够 persona+usage
  const segments = { persona: "人".repeat(40), globalIndex: "全".repeat(40), usage: "用".repeat(40), projectIndex: "项".repeat(40) };
  const charsFit = buildMemoryContext(segments, { maxChars: 60000 });
  assert.deepEqual(charsFit.dropped, [], "字符口径不丢");
  const { text, dropped, truncated } = buildMemoryContext(segments, { maxChars: 60000, maxTokens: 150 });
  assert.deepEqual(dropped, ["globalIndex", "projectIndex"], "token 口径按序先丢 globalIndex 再 projectIndex");
  assert.equal(truncated, true);
  assert.ok(text.includes("人".repeat(40)) && text.includes("用".repeat(40)), "persona/usage 保留");
  assert.ok(estimateTokens(text) <= 150, `token 预算内（实际 ${estimateTokens(text)}）`);
});

test("㉔ 双上限取更严者：token 上限极松不改字符口径结果；token 顶紧时独立生效", () => {
  const segments = { persona: "P".repeat(10), globalIndex: "G".repeat(10), usage: "U".repeat(10), projectIndex: "J".repeat(10) };
  // 方向一：字符顶紧（与用例④同参）、token 极松 → 逐字节一致
  const byChars = buildMemoryContext(segments, { maxChars: 62 });
  const looseTokens = buildMemoryContext(segments, { maxChars: 62, maxTokens: 1e9 });
  assert.equal(looseTokens.text, byChars.text, "token 上限极松不改变字符口径结果");
  assert.deepEqual(looseTokens.dropped, byChars.dropped);
  assert.equal(looseTokens.truncated, byChars.truncated);
  // 方向二：字符极松、token 顶紧 → 按序丢段照常发生（18 token 恰好只丢一段：全量 21→丢后 17）
  const bindTokens = buildMemoryContext(segments, { maxChars: 60000, maxTokens: 18 });
  assert.deepEqual(bindTokens.dropped, ["globalIndex"], "token 顶紧独立生效（先丢 globalIndex）");
  assert.equal(bindTokens.truncated, true);
});

test("㉕ persona 兜底截断（token 口径）：CJK 长 persona 收到预算内，保留头部+省略号", () => {
  const persona = "忆".repeat(300); // 450 token
  const { text, dropped, truncated } = buildMemoryContext({ persona }, { maxChars: 60000, maxTokens: 120 });
  assert.equal(truncated, true);
  assert.deepEqual(dropped, [], "persona 不整段丢弃");
  assert.ok(text.endsWith("</memory-context>"));
  assert.ok(text.includes("…"), "末尾省略号");
  assert.ok(text.includes("忆".repeat(5)), "保留头部内容");
  assert.ok(estimateTokens(text) <= 120, `token 预算内（实际 ${estimateTokens(text)}）`);
});

test("㉖ persona 兜底截断（字符口径照旧）：ASCII 长 persona 仍按 maxChars 收", () => {
  const persona = "A".repeat(500);
  const { text, truncated } = buildMemoryContext({ persona }, { maxChars: 100, maxTokens: 100000 });
  assert.equal(truncated, true);
  assert.ok(text.length <= 100, `字符预算内（实际 ${text.length}）`);
  assert.ok(text.includes("A".repeat(10)));
});

test("㉗ 两上限交叉：CJK persona 同时受字符与 token 顶紧，产出满足两者", () => {
  const persona = "合".repeat(400); // 600 token / 400 字符
  const { text, truncated } = buildMemoryContext({ persona }, { maxChars: 150, maxTokens: 100 });
  assert.equal(truncated, true);
  assert.ok(text.length <= 150, `字符预算内（实际 ${text.length}）`);
  assert.ok(estimateTokens(text) <= 100, `token 预算内（实际 ${estimateTokens(text)}）`);
});

test("㉘ 截断提示行计入 token 预算：丢段后的含提示行文本仍在预算内", () => {
  const segments = { persona: "人".repeat(30), globalIndex: "全".repeat(30), usage: "用".repeat(30), projectIndex: "项".repeat(30) };
  const { text, dropped, truncated } = buildMemoryContext(segments, { maxChars: 60000, maxTokens: 160 });
  assert.equal(truncated, true);
  assert.ok(dropped.length > 0);
  assert.match(text, /\[memory-context truncated:/, "提示行在场");
  assert.ok(estimateTokens(text) <= 160, `含提示行仍在预算内（实际 ${estimateTokens(text)}）`);
});

test("㉙ 自定义 costOf 生效：按字数计价的口径下 ASCII 段同样被裁", () => {
  const segments = { persona: "A".repeat(50), globalIndex: "B".repeat(50) };
  const charCost = (t) => t.length; // 粗口径：1 字 = 1 代价
  const { text, dropped } = buildMemoryContext(segments, { maxChars: 60000, maxTokens: 120, costOf: charCost });
  assert.deepEqual(dropped, ["globalIndex"], "自定义口径下丢段照常");
  assert.ok(charCost(text) <= 120, `自定义口径预算内（实际 ${charCost(text)}）`);
});

// ---- 锁定段语义（RUNTIME-FORMAT §七）----

test("㉚ 锁定段永不进 dropped：预算再紧也只丢可丢段，锁定段只截不丢", () => {
  const segments = {
    persona: "人设" + "P".repeat(200),
    runtimeUser: "USER-" + "R".repeat(200),
    runtimeMemory: "MEM-" + "M".repeat(200),
    globalIndex: "G".repeat(50),
    usage: "S".repeat(50),
    projectIndex: "J".repeat(50),
  };
  const full = buildMemoryContext(segments, { maxChars: 100000 });
  assert.equal(full.truncated, false, "前置：宽松预算下六段全量");
  // 预算远小于「三段锁定段 + 三个可丢段」→ 三个可丢段必须全丢；锁定段只截不丢
  const maxChars = 600;
  const { text, dropped, truncated } = buildMemoryContext(segments, { maxChars });
  assert.deepEqual(dropped, ["globalIndex", "projectIndex", "usage"], "可丢段按序丢尽");
  for (const locked of INJECT_LOCKED_SEGMENTS) {
    assert.ok(!dropped.includes(locked), `${locked} 是锁定段，不得进 dropped`);
  }
  assert.equal(truncated, true);
  assert.ok(text.includes("人设"), "persona 头部仍在（截而不丢）");
  assert.ok(text.includes("USER-"), "runtimeUser 头部仍在（截而不丢）");
  assert.ok(text.includes("MEM-"), "runtimeMemory 头部仍在（截而不丢）");
  assert.ok(!text.includes("G".repeat(50)) && !text.includes("S".repeat(50)) && !text.includes("J".repeat(50)), "可丢段全文消失");
  assert.match(text, /\[memory-context truncated: dropped globalIndex, projectIndex, usage/, "告警行列出全部丢弃与截断");
  assert.ok(text.length <= maxChars, `预算内（${text.length} ≤ ${maxChars}）`);
});

test("㉛ 锁定段兜底截断顺序：runtimeMemory → runtimeUser → persona（persona 最后），每次带告警行", () => {
  const persona = "P".repeat(600);
  const runtimeUser = "U".repeat(600);
  const runtimeMemory = "M".repeat(600);
  const segments = { persona, runtimeUser, runtimeMemory };
  // 只裁一轮（runtimeMemory）就够：budget 落在「三段全量」与「runtimeMemory 大截后」之间
  const full = buildMemoryContext(segments, { maxChars: 100000 });
  const budgetOne = full.text.length - 300; // 需要让出 ~300 字符
  const one = buildMemoryContext(segments, { maxChars: budgetOne });
  assert.equal(one.truncated, true);
  assert.ok(one.text.includes(persona), "第一轮只动 runtimeMemory：persona 完整");
  assert.ok(one.text.includes(runtimeUser), "第一轮只动 runtimeMemory：runtimeUser 完整");
  assert.ok(!one.text.includes(runtimeMemory), "runtimeMemory 已被收短");
  assert.match(one.text, /\[memory-context truncated: runtimeMemory truncated\]/, "只报 runtimeMemory 截断");
  assert.ok(one.text.length <= budgetOne, `预算内（${one.text.length} ≤ ${budgetOne}）`);

  // 更紧：runtimeMemory 收尽后轮到 runtimeUser，persona 仍不动
  const budgetTwo = 780;
  const two = buildMemoryContext(segments, { maxChars: budgetTwo });
  assert.match(two.text, /runtimeMemory truncated, runtimeUser truncated/, "第二轮才动 runtimeUser");
  assert.doesNotMatch(two.text, /persona truncated/, "persona 还没到截断的时候");
  assert.ok(two.text.includes(persona.slice(0, 60)), "persona 头部仍在");
  assert.ok(two.text.length <= budgetTwo, `预算内（${two.text.length} ≤ ${budgetTwo}）`);

  // 极紧：两段都已收尽，才轮到 persona（顺序：runtimeMemory → runtimeUser → persona）
  const tiny = buildMemoryContext(segments, { maxChars: 400 });
  assert.equal(tiny.truncated, true);
  assert.match(tiny.text, /runtimeMemory truncated, runtimeUser truncated, persona truncated/, "persona 最后被截");
  assert.ok(tiny.text.length <= 400, `预算内（${tiny.text.length} ≤ 400）`);
  assert.ok(tiny.text.startsWith("<memory-context>"));
  assert.ok(tiny.text.endsWith("</memory-context>"));
});

test("㉜ 回归门（引擎侧）：六段调用中 runtime 两段为空 = 四段调用逐字节一致", () => {
  const four = {
    persona: "人设正文".repeat(30),
    globalIndex: "全局索引行\n".repeat(20),
    usage: "使用说明".repeat(30),
    projectIndex: "- [P](p.md) — 项目条目".repeat(10),
  };
  const fourResult = buildMemoryContext(four, { maxChars: 30000, maxTokens: 24000 });
  const sixResult = buildMemoryContext(
    { ...four, runtimeUser: "", runtimeMemory: "" },
    { maxChars: 30000, maxTokens: 24000 },
  );
  assert.equal(sixResult.text, fourResult.text, "空 runtime 段不产生任何输出差异");
  assert.deepEqual(sixResult.dropped, fourResult.dropped);
  assert.equal(sixResult.truncated, fourResult.truncated);
  // undefined 与空串同义（接线层未赋值时也是同一形态）
  const undefinedRuntime = buildMemoryContext({ ...four, runtimeUser: undefined, runtimeMemory: undefined }, { maxChars: 30000, maxTokens: 24000 });
  assert.equal(undefinedRuntime.text, fourResult.text);
});


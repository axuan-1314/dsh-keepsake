// transcript：触发门槛（边界⑤：≥3 词用户散文 / 直写记忆跳过）与摘录渲染
import assert from "node:assert/strict";
import { test } from "node:test";
import { clipTail, hasDirectMemoryWrite, hasEnoughUserProse, isMachineOrigin, renderTranscript, skipReason } from "../lib/transcript.js";

// 路径按平台取（直写判定对 file_path 相对 memoryRoot 解析：Windows 绝对路径在 posix 不是绝对）
const IS_WIN = process.platform === "win32";
const ROOT = IS_WIN ? "C:\\mem\\x\\memory" : "/mem/x/memory";
const INSIDE = IS_WIN ? "C:\\mem\\x\\memory\\uses-pnpm.md" : "/mem/x/memory/uses-pnpm.md";
const OUTSIDE = IS_WIN ? "D:\\proj\\notes.md" : "/proj/notes.md";

test("skipReason: no-user-prose（<3 词）", () => {
  const events = [
    { type: "user/message", surfaceOp: "append", seq: 1, data: { role: "user", content: [{ type: "text", text: "继续" }] } },
    { type: "assistant/message", surfaceOp: "append", seq: 2, data: { message: { role: "assistant", content: [{ type: "text", text: "好的" }] } } },
  ];
  assert.equal(skipReason(events, ROOT), "no-user-prose");
});

test("skipReason: CJK 按 2 字≈1 词折算（纯中文 ≥6 字即合格）", () => {
  const qualify = [
    { type: "user/message", surfaceOp: "append", seq: 1, data: { role: "user", content: [{ type: "text", text: "我们团队决定统一使用 pnpm 管理所有依赖" }] } },
  ];
  assert.equal(skipReason(qualify, ROOT), null); // 空格词+CJK 折算
  const short = [
    { type: "user/message", surfaceOp: "append", seq: 1, data: { role: "user", content: [{ type: "text", text: "继续吧" }] } },
  ];
  assert.equal(skipReason(short, ROOT), "no-user-prose"); // 1 词 + 3 字→1 = 2 < 3
});

test("skipReason: 有 ≥3 词散文则不跳过", () => {
  const events = [
    { type: "user/message", surfaceOp: "append", seq: 1, data: { role: "user", content: [{ type: "text", text: "我们团队决定统一用 pnpm 管理依赖" }] } },
  ];
  assert.equal(skipReason(events, ROOT), null);
});

test("skipReason: direct-memory-write 优先（write 落 memoryRoot）", () => {
  const events = [
    { type: "user/message", surfaceOp: "append", seq: 1, data: { role: "user", content: [{ type: "text", text: "记住 我们 用 pnpm" }] } },
    {
      type: "tool/call",
      seq: 2,
      data: { name: "write", callId: "c1", arguments: JSON.stringify({ file_path: INSIDE, content: "---\n---\n" }) },
    },
    { type: "tool/result", seq: 3, data: { message: { role: "tool", source: { callId: "c1" }, isError: false, content: [{ type: "text", text: "ok" }] } } },
  ];
  assert.equal(skipReason(events, ROOT), "direct-memory-write");
});

test("skipReason: 直写被拒（isError）不算直写，正常提取", () => {
  const events = [
    { type: "user/message", surfaceOp: "append", seq: 1, data: { role: "user", content: [{ type: "text", text: "记住 我们 用 pnpm 管依赖" }] } },
    {
      type: "tool/call",
      seq: 2,
      data: { name: "write", callId: "c1", arguments: JSON.stringify({ file_path: INSIDE, content: "x" }) },
    },
    { type: "tool/result", seq: 3, data: { message: { role: "tool", source: { callId: "c1" }, isError: true, content: [{ type: "text", text: "denied" }] } } },
  ];
  assert.equal(skipReason(events, ROOT), null);
});

test("skipReason: write 落根外不算直写", () => {
  const events = [
    { type: "user/message", surfaceOp: "append", seq: 1, data: { role: "user", content: [{ type: "text", text: "记住 我们 用 pnpm 管依赖" }] } },
    {
      type: "tool/call",
      seq: 2,
      data: { name: "write", callId: "c1", arguments: JSON.stringify({ file_path: OUTSIDE, content: "x" }) },
    },
  ];
  assert.equal(skipReason(events, ROOT), null);
});

// ── run_code 路径：主 agent 在代码里调 tools.write/tools.edit 直写记忆目录 ──
// 代码里的路径写正斜杠（与 agent 实际书写一致，且平台无关），JSON 实参路径仍用 INSIDE/OUTSIDE
const INSIDE_CODE = INSIDE.replace(/\\/g, "/");
const OUTSIDE_CODE = OUTSIDE.replace(/\\/g, "/");

/** 造 run_code 的 tool/call（arguments 走 JSON 字符串，与真实事件一致）。 */
function runCodeCall(callId, code) {
  return { type: "tool/call", seq: 2, data: { name: "run_code", callId, arguments: JSON.stringify({ code }) } };
}

/** 造 tool/result；isError 决定该调用算不算成功。 */
function resultEvent(callId, isError = false) {
  return {
    type: "tool/result",
    seq: 3,
    data: { message: { role: "tool", source: { callId }, isError, content: [{ type: "text", text: isError ? "denied" : "ok" }] } },
  };
}

/** 合格用户散文（≥3 词）：保证 skipReason 的落点只由直写判定决定，不被 no-user-prose 干扰。 */
const PROSE = { type: "user/message", surfaceOp: "append", seq: 1, data: { role: "user", content: [{ type: "text", text: "记住 我们 用 pnpm" }] } };

test("skipReason: run_code 里 tools.write 落 memoryRoot 也算直写", () => {
  const code = `await tools.write({ file_path: "${INSIDE_CODE}", content: "---\\n---\\n" });`;
  const events = [PROSE, runCodeCall("c1", code), resultEvent("c1")];
  assert.equal(hasDirectMemoryWrite(events, ROOT), true);
  assert.equal(skipReason(events, ROOT), "direct-memory-write");

  // 反引号路径同判（同一 run_code 调用，三种引号口径一致）
  const backtick = `await tools.write({ file_path: \`${INSIDE_CODE}\`, content: "x" });`;
  assert.equal(hasDirectMemoryWrite([PROSE, runCodeCall("c1", backtick)], ROOT), true);
});

test("skipReason: run_code 里 tools.write 落根外不算直写", () => {
  const code = `await tools.write({ file_path: "${OUTSIDE_CODE}", content: "x" });`;
  const events = [PROSE, runCodeCall("c1", code), resultEvent("c1")];
  assert.equal(hasDirectMemoryWrite(events, ROOT), false);
  assert.equal(skipReason(events, ROOT), null);
});

test("skipReason: run_code 里 tools.edit 单引号 file_path 也算直写", () => {
  const code = `await tools.edit({ file_path: '${INSIDE_CODE}', old: "a", new: "b" });`;
  const events = [PROSE, runCodeCall("c1", code), resultEvent("c1")];
  assert.equal(hasDirectMemoryWrite(events, ROOT), true);
  assert.equal(skipReason(events, ROOT), "direct-memory-write");
});

test("skipReason: run_code 直写失败（isError）不算直写，正常提取", () => {
  const code = `await tools.write({ file_path: "${INSIDE_CODE}", content: "x" });`;
  const events = [PROSE, runCodeCall("c1", code), resultEvent("c1", true)];
  assert.equal(hasDirectMemoryWrite(events, ROOT), false); // 失败豁免：与原生 write/edit 同机制
  assert.equal(skipReason(events, ROOT), null);
});

test("skipReason: run_code 只读（无 write/edit）不算直写", () => {
  const code = `const t = await tools.read({ file_path: "${INSIDE_CODE}" });\nreturn t;`;
  const events = [PROSE, runCodeCall("c1", code), resultEvent("c1")];
  assert.equal(hasDirectMemoryWrite(events, ROOT), false);
  assert.equal(skipReason(events, ROOT), null);
});

test("skipReason: 注释里的 tools.write 示例不当真（误识别会静默丢该轮记忆）", () => {
  // 整行行注释
  const lineComment = `// 示例：await tools.write({ file_path: "${INSIDE_CODE}", content: "x" });\nconst a = 1;`;
  assert.equal(hasDirectMemoryWrite([PROSE, runCodeCall("c1", lineComment), resultEvent("c1")], ROOT), false);
  assert.equal(skipReason([PROSE, runCodeCall("c1", lineComment), resultEvent("c1")], ROOT), null);
  // 块注释
  const blockComment = `/*\n  await tools.write({ file_path: "${INSIDE_CODE}", content: "x" });\n*/\nreturn 1;`;
  assert.equal(hasDirectMemoryWrite([PROSE, runCodeCall("c1", blockComment), resultEvent("c1")], ROOT), false);
  // 注释里的是示例、真代码在后面：真写的照常判直写（剥注释不误伤）
  const mixed = `// 旧写法：tools.write({ file_path: "${INSIDE_CODE}" });\nawait tools.write({ file_path: "${INSIDE_CODE}", content: "x" });`;
  assert.equal(hasDirectMemoryWrite([PROSE, runCodeCall("c1", mixed), resultEvent("c1")], ROOT), true);
});

test("skipReason: 替换面事件（surfaceOp≠append）不算新散文", () => {
  const events = [
    { type: "user/message", surfaceOp: "replace", seq: 1, data: { role: "user", content: [{ type: "text", text: "one two three four five" }] } },
  ];
  assert.equal(skipReason(events, ROOT), "no-user-prose");
});

test("skipReason: 参数非 JSON 的 write 不误判", () => {
  const events = [
    { type: "user/message", surfaceOp: "append", seq: 1, data: { role: "user", content: [{ type: "text", text: "记住 我们 用 pnpm" }] } },
    { type: "tool/call", seq: 2, data: { name: "write", arguments: "{broken" } },
  ];
  assert.equal(skipReason(events, ROOT), null);
});

test("clipTail 保最新丢最旧 + 截断标记行", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `[seq ${i}] User: m${i}`);
  const text = lines.join("\n");
  const cut = clipTail(text, 40);
  assert.match(cut, /^\[\.\.\.earlier content omitted \(extraction backlog truncated\)\.\.\.\]/); // 模型可见标记
  assert.match(cut, /m9$/); // 最新保留
  assert.doesNotMatch(cut, /m0 /); // 最旧丢弃
  assert.match(cut, /\[seq \d+\] User: m\d/); // 正文无残行
  assert.equal(clipTail(text, 100000), text); // 未超预算原样
});

test("clipTail/clip 码点安全（切点不切出孤立代理对）", () => {
  const text = "a".repeat(10) + "😀".repeat(4) + "b".repeat(10);
  const cut = clipTail(text, 12);
  assert.ok(cut.includes("😀"), "emoji 成对保留");
  for (const ch of cut) {
    const c = ch.codePointAt(0);
    assert.ok(!(c >= 0xd800 && c <= 0xdfff), `无孤立代理码元 U+${c.toString(16)}`);
  }
});

test("renderTranscript: 摘录含用户/助手/工具行并截断", () => {
  const events = [
    { type: "user/message", seq: 3, data: { role: "user", content: [{ type: "text", text: "你好世界" }] } },
    { type: "assistant/message", seq: 4, data: { message: { content: [{ type: "reasoning", text: "思考" }, { type: "text", text: "答复内容" }] } } },
    { type: "tool/call", seq: 5, data: { name: "read", arguments: '{"file_path":"D:/x"}' } },
    { type: "tool/result", seq: 6, data: { message: { content: [{ type: "text", text: "文件内容" }] } } },
    { type: "system/message", seq: 7, data: { message: { content: [{ type: "text", text: "系统提示" }] } } },
  ];
  const text = renderTranscript(events, { maxMessageChars: 3 });
  assert.match(text, /\[seq 3\] User: 你好世…/); // 3 字截断
  assert.match(text, /\[seq 4\] Assistant: 答复内…/);
  assert.match(text, /\[seq 5\] ToolCall read:/);
  assert.match(text, /\[seq 6\] ToolResult: 文件内容/); // tool/result 走独立 200 字上限
  assert.doesNotMatch(text, /系统提示/); // system/message 不进摘录
  assert.doesNotMatch(text, /思考/); // reasoning 不进摘录
});

// ── 防自食：已知机器来源不进门槛、不进摘录；其余来源保守地按真人处理 ──

const MACHINE_ORIGIN_CASES = [
  ["别家插件", "plugin:other-memory"],
  ["本插件", "plugin:dsh-keepsake"],
  ["注入", "inject"],
  ["指令", "instruction"],
  ["系统", "system"],
  ["工具", "tool"],
  ["摘要", "summary"],
  ["压缩", "compaction"],
  ["记忆", "memory"],
  ["便笺", "note"],
  ["合成", "synthetic"],
];

const HUMAN_ORIGIN_CASES = [
  ["无来源", void 0],
  ["用户", "user"],
  ["转向", "steer"],
  ["追问", "followup"],
  ["未知类型", "agent-instructions"],
  ["无冒号的 plugin", "plugin"],
];

/** 构造用户消息；kind 省略时不生成 source，覆盖最常见的真人消息形态。 */
function userMessageEvent(seq, text, kind) {
  const data = { role: "user", content: [{ type: "text", text }] };
  if (kind !== void 0) data.source = { kind };
  return { type: "user/message", surfaceOp: "append", seq, data };
}

for (const [label, kind] of MACHINE_ORIGIN_CASES) {
  test(`机器来源矩阵：${label} 不计入门槛且不进摘录`, () => {
    const marker = `MACHINE-${kind}`;
    const events = [userMessageEvent(1, `${marker} one two three four`, kind)];
    assert.equal(isMachineOrigin(events[0].data), true, `${label} 应识别为机器来源`);
    assert.equal(hasEnoughUserProse(events, 3), false, `${label} 的长文不得满足用户散文门槛`);
    assert.equal(skipReason(events, ROOT, 3), "no-user-prose", `${label} 不得触发提取`);
    assert.doesNotMatch(renderTranscript(events), new RegExp(marker), `${label} 不得进入摘录`);
  });
}

for (const [label, kind] of HUMAN_ORIGIN_CASES) {
  test(`真人来源矩阵：${label} 照常计入门槛与摘录`, () => {
    const marker = `HUMAN-${kind ?? "none"}`;
    const events = [userMessageEvent(1, `${marker} one two three`, kind)];
    assert.equal(isMachineOrigin(events[0].data), false, `${label} 应按真人来源处理`);
    assert.equal(hasEnoughUserProse(events, 3), true, `${label} 必须满足用户散文门槛`);
    assert.equal(skipReason(events, ROOT, 3), null, `${label} 必须照常触发提取`);
    assert.match(renderTranscript(events), new RegExp(marker), `${label} 必须进入摘录`);
  });
}

test("混合消息跳过机器注入后仍保留真人内容", () => {
  const events = [
    userMessageEvent(1, `MACHINE-CONTEXT ${"x ".repeat(30)}`, "plugin:other-memory"),
    userMessageEvent(2, "HUMAN-CONTENT one two three", "followup"),
    { type: "assistant/message", surfaceOp: "append", seq: 3, data: { message: { content: [{ type: "text", text: "助手答复" }] } } },
    { type: "tool/call", seq: 4, data: { name: "read", arguments: '{"file_path":"sample.txt"}' } },
    { type: "tool/result", seq: 5, data: { message: { content: [{ type: "text", text: "工具结果" }] } } },
  ];
  assert.equal(hasEnoughUserProse(events, 3), true);
  const text = renderTranscript(events);
  assert.doesNotMatch(text, /MACHINE-CONTEXT/);
  assert.match(text, /HUMAN-CONTENT/);
  assert.match(text, /助手答复/);
  assert.match(text, /ToolCall read/);
  assert.match(text, /工具结果/);
});

test("renderTranscript 剥掉助手回复里回声的注入块（<memory-context> 整段）", () => {
  const echoed = "好的，我按记忆来。<memory-context>\n注入的记忆正文 SHOULD-NOT-APPEAR\n</memory-context> 以上。";
  const events = [
    { type: "assistant/message", surfaceOp: "append", seq: 1, data: { message: { content: [{ type: "text", text: echoed }] } } },
  ];
  const text = renderTranscript(events);
  assert.doesNotMatch(text, /SHOULD-NOT-APPEAR/, "回声的注入块内容必须被剥掉");
  assert.match(text, /我按记忆来/, "回复里的正常文本仍在");
});

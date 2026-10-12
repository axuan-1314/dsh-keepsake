// transcript：触发门槛（边界⑤：≥3 词用户散文 / 直写记忆跳过）与摘录渲染
import assert from "node:assert/strict";
import { test } from "node:test";
import { clipTail, hasEnoughUserProse, renderTranscript, skipReason } from "../lib/transcript.js";

const ROOT = "C:\\mem\\x\\memory";

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
      data: { name: "write", callId: "c1", arguments: JSON.stringify({ file_path: "C:\\mem\\x\\memory\\uses-pnpm.md", content: "---\n---\n" }) },
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
      data: { name: "write", callId: "c1", arguments: JSON.stringify({ file_path: "C:\\mem\\x\\memory\\uses-pnpm.md", content: "x" }) },
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
      data: { name: "write", callId: "c1", arguments: JSON.stringify({ file_path: "D:\\proj\\notes.md", content: "x" }) },
    },
  ];
  assert.equal(skipReason(events, ROOT), null);
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

test("clipTail 保最新丢最旧 + 截断标记行（审查 P3-7 + P-PIPE2）", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `[seq ${i}] User: m${i}`);
  const text = lines.join("\n");
  const cut = clipTail(text, 40);
  assert.match(cut, /^\[\.\.\.earlier content omitted \(extraction backlog truncated\)\.\.\.\]/); // P-PIPE2 模型可见标记
  assert.match(cut, /m9$/); // 最新保留
  assert.doesNotMatch(cut, /m0 /); // 最旧丢弃
  assert.match(cut, /\[seq \d+\] User: m\d/); // 正文无残行
  assert.equal(clipTail(text, 100000), text); // 未超预算原样
});

test("clipTail/clip 码点安全（P3-4：切点不切出孤立代理对）", () => {
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

// ── M3 防自食：插件注入消息（source.kind 属插件）不进门槛、不进摘录 ──

test("M3: 纯插件注入长文不算用户散文（≥3 词门槛不被架空）", () => {
  const longText = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const events = [
    {
      type: "user/message",
      surfaceOp: "append",
      seq: 1,
      data: { role: "user", source: { kind: "plugin:dsh-memory" }, content: [{ type: "text", text: longText }] },
    },
  ];
  assert.equal(hasEnoughUserProse(events, 3), false);
  assert.equal(skipReason(events, ROOT, 3), "no-user-prose");
});

test("M3: 前缀判定覆盖 kind='plugin'（无冒号）", () => {
  const events = [
    {
      type: "user/message",
      surfaceOp: "append",
      seq: 1,
      data: { role: "user", source: { kind: "plugin" }, content: [{ type: "text", text: "one two three four" }] },
    },
  ];
  assert.equal(hasEnoughUserProse(events, 3), false);
  assert.equal(skipReason(events, ROOT, 3), "no-user-prose");
  assert.doesNotMatch(renderTranscript(events), /User:/);
});

test("M3 回归：正常用户消息（无 source / 非 plugin kind）仍过门槛", () => {
  const noSource = [
    { type: "user/message", surfaceOp: "append", seq: 1, data: { role: "user", content: [{ type: "text", text: "one two three" }] } },
  ];
  assert.equal(hasEnoughUserProse(noSource, 3), true);
  assert.equal(skipReason(noSource, ROOT, 3), null);

  const otherKind = [
    {
      type: "user/message",
      surfaceOp: "append",
      seq: 1,
      data: { role: "user", source: { kind: "agent-instructions" }, content: [{ type: "text", text: "one two three" }] },
    },
  ];
  assert.equal(hasEnoughUserProse(otherKind, 3), true); // 非 plugin 前缀不误伤

  const mixed = [
    {
      type: "user/message",
      surfaceOp: "append",
      seq: 1,
      data: { role: "user", source: { kind: "plugin:dsh-memory" }, content: [{ type: "text", text: `注入 ${"y ".repeat(30)}` }] },
    },
    { type: "user/message", surfaceOp: "append", seq: 2, data: { role: "user", content: [{ type: "text", text: "one two three" }] } },
  ];
  assert.equal(hasEnoughUserProse(mixed, 3), true); // 跳过注入后，正常散文仍达标
});

test("M3: renderTranscript 剔除插件注入行，保留正常用户/助手/工具行", () => {
  const injected = `MEMORY-CONTEXT-SHOULD-NOT-APPEAR ${"x".repeat(50)}`;
  const events = [
    {
      type: "user/message",
      surfaceOp: "append",
      seq: 1,
      data: { role: "user", source: { kind: "plugin:dsh-memory" }, content: [{ type: "text", text: injected }] },
    },
    { type: "user/message", surfaceOp: "append", seq: 2, data: { role: "user", content: [{ type: "text", text: "真实用户发言" }] } },
    { type: "assistant/message", surfaceOp: "append", seq: 3, data: { message: { content: [{ type: "text", text: "助手答复" }] } } },
    { type: "tool/call", seq: 4, data: { name: "read", arguments: '{"file_path":"D:/x"}' } },
    { type: "tool/result", seq: 5, data: { message: { content: [{ type: "text", text: "工具结果" }] } } },
  ];
  const text = renderTranscript(events);
  assert.doesNotMatch(text, /MEMORY-CONTEXT-SHOULD-NOT-APPEAR/);
  assert.doesNotMatch(text, /\[seq 1\] User:/);
  assert.match(text, /\[seq 2\] User: 真实用户发言/);
  assert.match(text, /\[seq 3\] Assistant: 助手答复/);
  assert.match(text, /\[seq 4\] ToolCall read:/);
  assert.match(text, /\[seq 5\] ToolResult: 工具结果/);
});

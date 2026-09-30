// transcript：触发门槛（边界⑤：≥3 词用户散文 / 直写记忆跳过）与摘录渲染
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTranscript, skipReason } from "../lib/transcript.js";

const ROOT = "C:\\mem\\x\\memory";

test("skipReason: no-user-prose（<3 词）", () => {
  const events = [
    { type: "user/message", surfaceOp: "append", seq: 1, data: { role: "user", content: [{ type: "text", text: "继续" }] } },
    { type: "assistant/message", surfaceOp: "append", seq: 2, data: { message: { role: "assistant", content: [{ type: "text", text: "好的" }] } } },
  ];
  assert.equal(skipReason(events, ROOT), "no-user-prose");
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
  ];
  assert.equal(skipReason(events, ROOT), "direct-memory-write");
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

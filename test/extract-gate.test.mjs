// extract-gate：打分门测试
import assert from "node:assert/strict";
import { test } from "node:test";
import { gateDecision, scoreExtractionEvidence, GATE_DEFAULT_MIN_SCORE } from "../lib/extract-gate.js";
import { countProseWords, hasEnoughUserProse } from "../lib/transcript.js";

/** 构造用户消息事件（append 面）。 */
function userMessage(seq, text, kind) {
  const data = { role: "user", content: [{ type: "text", text }] };
  if (kind !== void 0) data.source = { kind };
  return { type: "user/message", surfaceOp: "append", seq, data };
}

/** 构造工具调用事件。 */
function toolCall(seq, name, callId = "c1") {
  return { type: "tool/call", seq, data: { name, callId } };
}

// ── 分数矩阵测试 ──

test("分数矩阵：纯闲聊薄轮（1 词）不通过", () => {
  const events = [userMessage(1, "继续")];
  const result = gateDecision(events);
  assert.equal(result.pass, false);
  assert.equal(result.reason, "thin-evidence");
  assert.equal(result.score, 4); // 1 token + 1 CJK折算 = 2 词 + 0 工具 + 2*1 轮 = 4
  assert.equal(result.parts.userWords, 2);
  assert.equal(result.parts.toolKinds, 0);
  assert.equal(result.parts.turns, 1);
});

test("分数矩阵：纯闲聊薄轮（2 词）不通过", () => {
  const events = [userMessage(1, "继续吧")];
  const result = gateDecision(events);
  assert.equal(result.pass, false);
  assert.equal(result.reason, "thin-evidence");
  assert.equal(result.score, 4); // 2 词 + 0 工具 + 2*1 轮 = 4
});

test("分数矩阵：纯闲聊（3 词）不通过（需 4 词才够）", () => {
  const events = [userMessage(1, "one two three")];
  const result = gateDecision(events);
  assert.equal(result.pass, false);
  assert.equal(result.reason, "thin-evidence");
  assert.equal(result.score, 5); // 3 词 + 0 工具 + 2*1 轮 = 5
});

test("分数矩阵：纯闲聊（4 词）刚好通过", () => {
  const events = [userMessage(1, "one two three four")];
  const result = gateDecision(events);
  assert.equal(result.pass, true);
  assert.equal(result.score, 6); // 4 词 + 0 工具 + 2*1 轮 = 6
});

test("分数矩阵：带工具调用（1 词 + 1 工具）不通过（需 2 词才够）", () => {
  const events = [userMessage(1, "read"), toolCall(2, "read")];
  const result = gateDecision(events);
  assert.equal(result.pass, false);
  assert.equal(result.reason, "thin-evidence");
  assert.equal(result.score, 5); // 1 词 + 2*1 工具 + 2*1 轮 = 5
});

test("分数矩阵：带工具调用（2 词 + 1 工具）通过", () => {
  const events = [userMessage(1, "read file"), toolCall(2, "read")];
  const result = gateDecision(events);
  assert.equal(result.pass, true);
  assert.equal(result.score, 6); // 2 词 + 2*1 工具 + 2*1 轮 = 6
});

test("分数矩阵：多轮薄文本（2 轮各 1 词）通过", () => {
  const events = [userMessage(1, "hi"), userMessage(2, "ok")];
  const result = gateDecision(events);
  assert.equal(result.pass, true);
  assert.equal(result.score, 6); // 2 词 + 0 工具 + 2*2 轮 = 6
});

test("分数矩阵：超长用户文本（10 词）通过", () => {
  const events = [userMessage(1, "one two three four five six seven eight nine ten")];
  const result = gateDecision(events);
  assert.equal(result.pass, true);
  assert.equal(result.score, 12); // 10 词 + 0 工具 + 2*1 轮 = 12
});

test("分数矩阵：CJK 按 2 字≈1 词折算（6 字中文 + 1 轮）通过", () => {
  const events = [userMessage(1, "我们团队决定")]; // 1 token + 6 CJK chars/2 = 4 词
  const result = gateDecision(events);
  assert.equal(result.pass, true);
  assert.equal(result.score, 6); // 4 词 + 0 工具 + 2*1 轮 = 6
});

test("分数矩阵：多工具种类去重计数", () => {
  const events = [
    userMessage(1, "one two"),
    toolCall(2, "read", "c1"),
    toolCall(3, "write", "c2"),
    toolCall(4, "read", "c3"), // 重复工具不计
  ];
  const result = gateDecision(events);
  assert.equal(result.pass, true);
  assert.equal(result.parts.toolKinds, 2); // read + write
  assert.equal(result.score, 8); // 2 词 + 2*2 工具 + 2*1 轮 = 8
});

test("分数矩阵：复杂场景（多轮 + 多工具 + 长文本）高分通过", () => {
  const events = [
    userMessage(1, "one two three four five"),
    toolCall(2, "read"),
    userMessage(3, "six seven eight"),
    toolCall(4, "write"),
    toolCall(5, "edit"),
  ];
  const result = gateDecision(events);
  assert.equal(result.pass, true);
  assert.equal(result.parts.userWords, 8);
  assert.equal(result.parts.toolKinds, 3);
  assert.equal(result.parts.turns, 2);
  assert.equal(result.score, 18); // 8 + 2*3 + 2*2 = 18
});

// ── enabled=false 恒 pass ──

test("enabled=false 恒 pass（薄轮也通过）", () => {
  const events = [userMessage(1, "继续")];
  const result = gateDecision(events, { enabled: false });
  assert.equal(result.pass, true);
  assert.equal(result.reason, void 0);
  assert.equal(result.score, 4); // 分数照算
});

test("enabled=false 恒 pass（复杂场景也通过）", () => {
  const events = [userMessage(1, "one two three four five"), toolCall(2, "read")];
  const result = gateDecision(events, { enabled: false });
  assert.equal(result.pass, true);
  assert.equal(result.reason, void 0);
});

// ── minScore 可调 ──

test("minScore 可调：提高阈值后薄轮不通过", () => {
  const events = [userMessage(1, "one two three")];
  const result = gateDecision(events, { minScore: 10 });
  assert.equal(result.pass, false);
  assert.equal(result.reason, "thin-evidence");
});

test("minScore 可调：降低阈值后薄轮通过", () => {
  const events = [userMessage(1, "继续")];
  const result = gateDecision(events, { minScore: 2 });
  assert.equal(result.pass, true);
});

test("minScore 默认值等于 GATE_DEFAULT_MIN_SCORE", () => {
  const events = [userMessage(1, "one two three")];
  const result1 = gateDecision(events);
  const result2 = gateDecision(events, { minScore: GATE_DEFAULT_MIN_SCORE });
  assert.equal(result1.score, result2.score);
  assert.equal(result1.pass, result2.pass);
});

// ── 机器来源不计入 ──

test("机器来源注入文本不计入 userWords/turns", () => {
  const events = [
    userMessage(1, "plugin injected one two three four five", "plugin:other-memory"),
    userMessage(2, "real user one two", "user"),
  ];
  const result = gateDecision(events);
  assert.equal(result.parts.userWords, 4); // 只算真人 (real user one two = 4 词)
  assert.equal(result.parts.turns, 1); // 只算真人轮次
  assert.equal(result.score, 6); // 4 + 0 + 2*1 = 6
});

test("机器来源矩阵（各种已知类型）不计入", () => {
  const machineKinds = ["inject", "instruction", "system", "tool", "summary", "compaction", "memory", "note", "synthetic", "plugin:test"];
  for (const kind of machineKinds) {
    const events = [userMessage(1, "one two three four five", kind)];
    const result = gateDecision(events);
    assert.equal(result.parts.userWords, 0, `${kind} 不应计入 userWords`);
    assert.equal(result.parts.turns, 0, `${kind} 不应计入 turns`);
  }
});

test("未知来源保守按真人处理", () => {
  const events = [userMessage(1, "one two three", "unknown-type")];
  const result = gateDecision(events);
  assert.equal(result.parts.userWords, 3);
  assert.equal(result.parts.turns, 1);
});

// ── 容错测试 ──

test("空事件数组返回零分", () => {
  const result = gateDecision([]);
  assert.equal(result.pass, false);
  assert.equal(result.score, 0);
  assert.equal(result.parts.userWords, 0);
  assert.equal(result.parts.toolKinds, 0);
  assert.equal(result.parts.turns, 0);
});

test("非数组输入返回零分", () => {
  const result = gateDecision(null);
  assert.equal(result.pass, false);
  assert.equal(result.score, 0);
  const result2 = gateDecision("not an array");
  assert.equal(result2.pass, false);
  assert.equal(result2.score, 0);
});

test("事件为 null/undefined 跳过", () => {
  const events = [null, void 0, userMessage(1, "one two three four")]; // 4 words to pass
  const result = gateDecision(events);
  assert.equal(result.pass, true);
  assert.equal(result.score, 6);
});

test("事件缺字段跳过（无 type）", () => {
  const events = [{ seq: 1 }, userMessage(1, "one two three four")]; // 4 words to pass
  const result = gateDecision(events);
  assert.equal(result.pass, true);
  assert.equal(result.score, 6);
});

test("事件缺 data 字段跳过", () => {
  const events = [{ type: "user/message", surfaceOp: "append", seq: 1 }, userMessage(1, "one two three four")]; // 4 words to pass
  const result = gateDecision(events);
  assert.equal(result.pass, true);
  assert.equal(result.score, 6);
});

test("工具调用缺 name 跳过", () => {
  const events = [userMessage(1, "one two three"), { type: "tool/call", seq: 2, data: {} }];
  const result = gateDecision(events);
  assert.equal(result.parts.toolKinds, 0);
});

test("用户消息缺 content 跳过", () => {
  const events = [{ type: "user/message", surfaceOp: "append", seq: 1, data: { role: "user" } }];
  const result = gateDecision(events);
  assert.equal(result.parts.userWords, 0);
  assert.equal(result.parts.turns, 0);
});

test("替换面事件（surfaceOp≠append）不计入", () => {
  const events = [userMessage(1, "one two three four five")];
  events[0].surfaceOp = "replace";
  const result = gateDecision(events);
  assert.equal(result.parts.userWords, 0);
  assert.equal(result.parts.turns, 0);
});

// ── 与 countProseWords 口径一致性 ──

test("countProseWords 与 hasEnoughUserProse 词数口径一致", () => {
  const text = "one two three four five";
  const events = [userMessage(1, text)];
  const wordCount = countProseWords(text);
  const evidence = scoreExtractionEvidence(events);
  assert.equal(evidence.userWords, wordCount);
  assert.equal(hasEnoughUserProse(events, wordCount), true);
  assert.equal(hasEnoughUserProse(events, wordCount + 1), false);
});

test("countProseWords 与 scoreExtractionEvidence CJK 折算一致", () => {
  const text = "我们团队决定"; // 1 token + 6 CJK chars/2 = 4 词
  const events = [userMessage(1, text)];
  const wordCount = countProseWords(text);
  const evidence = scoreExtractionEvidence(events);
  assert.equal(evidence.userWords, wordCount);
  assert.equal(wordCount, 4); // 1 token + 6 CJK chars/2 = 4 词
});

test("countProseWords 与 scoreExtractionEvidence 混合文本一致", () => {
  const text = "我们团队用 pnpm"; // 1 token + 4 CJK chars/2 + 1 token = 4 词
  const events = [userMessage(1, text)];
  const wordCount = countProseWords(text);
  const evidence = scoreExtractionEvidence(events);
  assert.equal(evidence.userWords, wordCount);
  assert.equal(wordCount, 4);
});

test("scoreExtractionEvidence 对多段文本累加词数", () => {
  const events = [
    userMessage(1, "one two three"),
    userMessage(2, "four five six"),
  ];
  const evidence = scoreExtractionEvidence(events);
  assert.equal(evidence.userWords, 6);
  assert.equal(evidence.turns, 2);
});

// ── scoreExtractionEvidence 独立测试 ──

test("scoreExtractionEvidence 返回完整分数组件", () => {
  const events = [userMessage(1, "one two three"), toolCall(2, "read")];
  const result = scoreExtractionEvidence(events);
  assert.ok(typeof result.userWords === "number");
  assert.ok(typeof result.toolKinds === "number");
  assert.ok(typeof result.turns === "number");
  assert.ok(typeof result.score === "number");
  assert.equal(result.score, result.userWords + 2 * result.toolKinds + 2 * result.turns);
});

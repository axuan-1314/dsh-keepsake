// inject-channel-wiring：批次A（v0.2.0）消息通道注入接线验收。
//   模拟宿主 rc.2 的 agent/pre-step 契约（payload:{agent,messages,step,signal} + next()）
//   与 agent.session.{header.cwd,surface.nodes,eventAt(seq)}，验证：
//   minimal 场景不再依赖 section、视野去重（同内容不重复）、内容变化补发、视野丢失补发、
//   开关关闭不注入、预算丢弃可见、section 模式不注册 pre-step。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apply } from "../lib/index.js";
import { createEntry } from "../lib/global-store.js";
import { projectMemoryPaths } from "../lib/paths.js";
import { writeSettings, resetSettingsCache } from "../lib/settings.js";
import { __resetMetricsForTest, injectionSnapshot } from "../lib/metrics.js";
import { skipReason } from "../lib/transcript.js";

function fakeCtx() {
  const sections = [];
  const handlers = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, handler) {
      handlers.set(event, handler);
      return () => {};
    },
    effect() {},
    inject(_deps, setup) {
      setup({ effect(fn) { fn(); }, webServer: { register() { return () => {}; } } });
    },
    systemPrompt: { section(section) { sections.push(section); return () => {}; } },
    llm: { stream() { throw new Error("不应调用"); } },
  };
  return { ctx, sections, handlers };
}

function freshRoot() {
  resetSettingsCache();
  return mkdtempSync(join(tmpdir(), "dsh-memory-wiring-"));
}

/** 造 cwd=root 的项目记忆（条目+索引）。 */
function seedProjectMemory(root) {
  const { memoryDir } = projectMemoryPaths(root, root);
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, "p.md"), "---\nname: p\ntitle: P\n---\n项目正文。\n");
  writeFileSync(join(memoryDir, "MEMORY.md"), "- [P](p.md) — 项目条目\n");
}

/** 模拟 agent 句柄：surface.nodes + eventAt(seq)。events 顺序即 surface 顺序。 */
function makeAgent({ cwd, events = [] } = {}) {
  const map = new Map(events.map((event, index) => [index, event]));
  return {
    session: {
      header: { cwd },
      surface: { nodes: [...map.keys()] },
      eventAt(seq) { return map.get(seq); },
    },
  };
}

const payloadOf = ({ agent, messages, step = 1, aborted = false }) => ({ agent, messages, step, signal: { aborted } });
const run = (handler, payload, decision) => handler(payload, async () => decision);
const textOf = (message) => message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const userMsg = (text) => ({ role: "user", content: [{ type: "text", text }] });

test("批次A：默认 message 模式——pre-step 注入 memory-context（不依赖 section，minimal 场景根治）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "Uses pnpm", description: "包管理", content: "正文" });
    seedProjectMemory(root);
    const { ctx, sections, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root }); // 缺省 injectChannel=message
    assert.equal(sections.length, 1, "section 侧只剩一条路由兜底段");
    assert.equal(sections[0].name, "dsh-memory:routing");
    const handler = handlers.get("agent/pre-step");
    assert.equal(typeof handler, "function", "message 模式应注册 pre-step");

    const decision = { kind: "enter", messages: [userMsg("记住 我们 统一 用 pnpm")] };
    const agent = makeAgent({ cwd: root });
    const out = await run(handler, payloadOf({ agent, messages: decision.messages }), decision);

    assert.equal(out.messages.length, 2, "应追加一条注入消息");
    const injected = out.messages[1];
    assert.equal(injected.role, "user");
    assert.equal(injected.source.kind, "plugin:dsh-memory");
    assert.equal(injected.source.form, "memory-context");
    assert.equal(typeof injected.source.digest, "string");
    const text = textOf(injected);
    assert.match(text, /^<memory-context>/);
    assert.match(text, /Global memory index/); // 全局索引段
    assert.match(text, /Uses pnpm/); // 条目内容
    assert.match(text, /Persistent project memory/); // 项目使用说明段（cwd 有效）
    // 观测面记账
    const snap = injectionSnapshot();
    assert.equal(snap.count, 1);
    assert.equal(snap.lastChars, text.length);
    assert.equal(snap.totalChars, text.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("批次A：同内容已在视野 → 不重复注入；内容变化 → 补发；视野丢失 → 补发", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "A", content: "一" });
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root });
    const handler = handlers.get("agent/pre-step");
    const decision = () => ({ kind: "enter", messages: [userMsg("正常 用户 一句话")] });

    // 第一次：注入
    const first = await run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: [] }), decision());
    assert.equal(first.messages.length, 2);
    const injected = first.messages[1];

    // 第二次：surface 里已有同内容 → 不重复
    const visibleEvent = { type: "user/message", data: injected };
    const second = await run(handler, payloadOf({ agent: makeAgent({ cwd: root, events: [visibleEvent] }), messages: [] }), decision());
    assert.equal(second.messages.length, 1, "同内容不重复注入");
    assert.equal(injectionSnapshot().count, 1);

    // 第三次：内容变化（新条目）→ 补发
    createEntry(root, "work-profile", { title: "B", content: "二" });
    const third = await run(handler, payloadOf({ agent: makeAgent({ cwd: root, events: [visibleEvent] }), messages: [] }), decision());
    assert.equal(third.messages.length, 2, "内容变化应补发");
    assert.equal(injectionSnapshot().resends, 1);

    // 第四次：视野里没有（compaction 挤出）→ 补发
    const fourth = await run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: [] }), decision());
    assert.equal(fourth.messages.length, 2, "视野丢失应补发");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("批次A：非注入场景一律原样返回（reject / step≠1 / 空批 / 批内已含我方消息 / 开关关）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "A", content: "一" });
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root });
    const handler = handlers.get("agent/pre-step");
    const agent = makeAgent({ cwd: root });
    const msgs = [userMsg("正常 用户 一句话")];

    const rejected = { kind: "reject" };
    assert.equal(await run(handler, payloadOf({ agent, messages: msgs }), rejected), rejected);

    const step2 = { kind: "enter", messages: msgs };
    assert.equal(await run(handler, payloadOf({ agent, messages: msgs, step: 2 }), step2), step2);

    const empty = { kind: "enter", messages: [] };
    assert.equal(await run(handler, payloadOf({ agent, messages: [] }), empty), empty);

    const ours = { role: "user", content: [{ type: "text", text: "x" }], source: { kind: "plugin:dsh-memory", form: "memory-context" } };
    const already = { kind: "enter", messages: [ours, ...msgs] };
    assert.equal(await run(handler, payloadOf({ agent, messages: already.messages }), already), already);

    const aborted = { kind: "enter", messages: msgs };
    assert.equal(await run(handler, payloadOf({ agent, messages: msgs, aborted: true }), aborted), aborted);

    writeSettings(root, { conversationMemory: false });
    const gated = { kind: "enter", messages: msgs };
    assert.equal(await run(handler, payloadOf({ agent, messages: msgs }), gated), gated, "总开关关 → 不注入");

    assert.equal(injectionSnapshot().count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("批次A：projectMemory 关 → 消息模式不注入项目段，路由段也不指项目目录（口径一致）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "A", content: "一" });
    seedProjectMemory(root);
    writeSettings(root, { projectMemory: false });
    const { ctx, sections, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root });
    // 路由段：不指项目目录
    const routing = sections[0].text({ agent: { session: { header: { cwd: root } } } });
    assert.doesNotMatch(routing, /Project memory directory/, "projectMemory 关时路由段不得泄漏项目目录");
    // 消息段：无 usage/projectIndex，但人设/全局仍在
    const handler = handlers.get("agent/pre-step");
    const decision = { kind: "enter", messages: [userMsg("正常 用户 一句话")] };
    const out = await run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision);
    const text = textOf(out.messages[1]);
    assert.match(text, /Global memory index|补充人设/);
    assert.doesNotMatch(text, /Persistent project memory/, "projectMemory 关时不注入项目使用说明段");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("批次A：subagent 会话不注入（session.header.origin === 'subagent'）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "A", content: "一" });
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root });
    const handler = handlers.get("agent/pre-step");
    const subagent = { session: { header: { cwd: root, origin: "subagent" }, surface: { nodes: [] }, eventAt() {} } };
    const decision = { kind: "enter", messages: [userMsg("正常 用户 一句话")] };
    const out = await run(handler, payloadOf({ agent: subagent, messages: decision.messages }), decision);
    assert.equal(out.messages.length, 1, "subagent 会话不应注入");
    assert.equal(injectionSnapshot().count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("批次A：injectMaxChars 预算触发整段丢弃 + 可见截断提示 + droppedSegments 记账", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "A", content: "一".repeat(200) });
    seedProjectMemory(root);
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, injectMaxChars: 220 });
    const handler = handlers.get("agent/pre-step");
    const decision = { kind: "enter", messages: [userMsg("正常 用户 一句话")] };
    const out = await run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision);
    const text = textOf(out.messages[1]);
    assert.match(text, /\[memory-context truncated/, "超预算应留可见提示");
    assert.ok(text.length <= 320, `应受预算约束（实际 ${text.length}）`);
    assert.ok(injectionSnapshot().droppedSegments >= 1, "应记录丢弃段数");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("批次A：injectChannel=section → 不注册 pre-step，恢复旧四段", () => {
  const root = freshRoot();
  try {
    const { ctx, sections, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, injectChannel: "section" });
    assert.equal(sections.length, 4);
    assert.equal(handlers.has("agent/pre-step"), false, "section 模式不应注册 pre-step");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("批次A：注入消息以 user/message 落事件流 → 提取侧 skip 门槛不被架空（防自食）", () => {
  const root = freshRoot();
  try {
    const injected = { role: "user", content: [{ type: "text", text: "很长很长的一段注入记忆内容".repeat(20) }], source: { kind: "plugin:dsh-memory", form: "memory-context" } };
    const events = [{ type: "user/message", surfaceOp: "append", seq: 0, data: injected }];
    assert.equal(skipReason(events, root, 3), "no-user-prose", "纯注入批次必须 skip 提取");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

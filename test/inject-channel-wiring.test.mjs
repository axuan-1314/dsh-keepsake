// inject-channel-wiring：消息通道注入接线。
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
import { __resetMetricsForTest, injectionSnapshot, recallSnapshot } from "../lib/metrics.js";
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

test("默认 message 模式——pre-step 注入 memory-context（不依赖 section，minimal 场景根治）", async () => {
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
    assert.match(text, /Reference memory from earlier sessions/); // 免责/署名行
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

test("同内容已在视野 → 不重复注入；内容变化 → 补发；视野丢失 → 补发", async () => {
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

test("非注入场景一律原样返回（reject / step≠1 / 空批 / 批内已含我方消息 / 开关关）", async () => {
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

test("projectMemory 关 → 消息模式不注入项目段，路由段也不指项目目录（口径一致）", async () => {
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

test("subagent 会话不注入（session.header.origin === 'subagent'）", async () => {
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

test("injectMaxChars 预算触发整段丢弃 + 可见截断提示 + droppedSegments 记账", async () => {
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

test("injectChannel=section → 不注册 pre-step，恢复旧四段", () => {
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

test("注入消息以 user/message 落事件流 → 提取侧 skip 门槛不被架空（防自食）", () => {
  const root = freshRoot();
  try {
    const injected = { role: "user", content: [{ type: "text", text: "很长很长的一段注入记忆内容".repeat(20) }], source: { kind: "plugin:dsh-memory", form: "memory-context" } };
    const events = [{ type: "user/message", surfaceOp: "append", seq: 0, data: injected }];
    assert.equal(skipReason(events, root, 3), "no-user-prose", "纯注入批次必须 skip 提取");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 嵌入语义召回接线 ----

/** 确定性 stub 嵌入端点：向量按关键词命中（无需真实服务）。 */
function stubFetch() {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const vectors = JSON.parse(options.body).input.map((t) => [String(t).includes("pnpm") ? 1 : 0, String(t).includes("python") ? 1 : 0]);
    return { ok: true, status: 200, json: async () => ({ data: vectors.map((embedding) => ({ embedding })) }) };
  };
  return { impl, calls };
}

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const RECALL_CONFIG = { recallEnabled: true, embeddingBaseUrl: "http://stub/embeddings", embeddingProvider: "stub", embeddingModel: "stub-embed" };

test("recallEnabled 时按语义召回注入 <memory-recall> 块（主块不受影响）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "包管理", content: "团队统一用 pnpm 管理依赖" });
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, ...RECALL_CONFIG });
    const handler = handlers.get("agent/pre-step");
    const { impl } = stubFetch();
    const decision = { kind: "enter", messages: [userMsg("我们 用 pnpm 还是 python？")] };
    const out = await withFetch(impl, () => run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision));
    const forms = out.messages.map((m) => m.source?.form).filter(Boolean);
    assert.ok(forms.includes("memory-context"), "主块仍在");
    assert.ok(forms.includes("memory-recall"), "召回块应注入");
    const recall = textOf(out.messages.find((m) => m.source?.form === "memory-recall"));
    assert.match(recall, /^<memory-recall>/);
    assert.match(recall, /pnpm/, "命中条目应在召回块里");
    assert.equal(recallSnapshot().hits, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recallEnabled 默认关 → 无召回块且零嵌入调用", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "包管理", content: "团队统一用 pnpm 管理依赖" });
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root }); // 未开 recallEnabled
    const handler = handlers.get("agent/pre-step");
    let called = 0;
    const impl = async () => { called += 1; throw new Error("默认关不应触发嵌入调用"); };
    const decision = { kind: "enter", messages: [userMsg("我们 用 pnpm 还是 python？")] };
    const out = await withFetch(impl, () => run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision));
    assert.ok(!out.messages.some((m) => m.source?.form === "memory-recall"), "默认不召回");
    assert.equal(called, 0, "默认关不得产生任何嵌入调用");
    assert.equal(recallSnapshot().hits, 0);
    assert.equal(recallSnapshot().errors, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("同查询二次 pre-step → 召回块不重复注入（视野去重）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "包管理", content: "团队统一用 pnpm 管理依赖" });
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, ...RECALL_CONFIG });
    const handler = handlers.get("agent/pre-step");
    const { impl } = stubFetch();
    const msg = () => [userMsg("pnpm 命令")];
    const first = await withFetch(impl, () => run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: msg() }), { kind: "enter", messages: msg() }));
    const recallMsg = first.messages.find((m) => m.source?.form === "memory-recall");
    assert.ok(recallMsg, "首轮应注入召回块");
    const second = await withFetch(impl, () => run(
      handler,
      payloadOf({ agent: makeAgent({ cwd: root, events: [{ type: "user/message", data: recallMsg }] }), messages: msg() }),
      { kind: "enter", messages: msg() },
    ));
    assert.ok(!second.messages.some((m) => m.source?.form === "memory-recall"), "同内容已在视野 → 不重复注入");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("嵌入响应畸形（缺 data）→ 降级不召回、记 errors", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "包管理", content: "团队统一用 pnpm 管理依赖" });
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, ...RECALL_CONFIG });
    const handler = handlers.get("agent/pre-step");
    const impl = async () => ({ ok: true, status: 200, json: async () => ({}) }); // 缺 data → parseEmbeddingResponse null → throw
    const decision = { kind: "enter", messages: [userMsg("pnpm 命令")] };
    const out = await withFetch(impl, () => run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision));
    assert.ok(!out.messages.some((m) => m.source?.form === "memory-recall"), "畸形响应不召回");
    assert.ok(out.messages.some((m) => m.source?.form === "memory-context"), "主块不受影响");
    assert.equal(recallSnapshot().errors, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("条目向量缓存——第二次 pre-step 不再重嵌条目，只嵌查询", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "包管理", content: "团队统一用 pnpm 管理依赖" });
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, ...RECALL_CONFIG });
    const handler = handlers.get("agent/pre-step");
    const agent = makeAgent({ cwd: root });
    const first = stubFetch();
    await withFetch(first.impl, () => run(handler, payloadOf({ agent, messages: [userMsg("pnpm 命令")] }), { kind: "enter", messages: [userMsg("pnpm 命令")] }));
    assert.equal(first.calls.length, 2, "首轮：1 条条目 + 1 次查询嵌入");
    const second = stubFetch();
    await withFetch(second.impl, () => run(handler, payloadOf({ agent, messages: [userMsg("pnpm 命令")] }), { kind: "enter", messages: [userMsg("pnpm 命令")] }));
    assert.equal(second.calls.length, 1, "次轮：条目已缓存，只嵌查询");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("嵌入端点失败 → 降级不召回、主块不受影响、记 errors", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "包管理", content: "团队统一用 pnpm 管理依赖" });
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, ...RECALL_CONFIG });
    const handler = handlers.get("agent/pre-step");
    const impl = async () => { throw new Error("embedding endpoint down"); };
    const decision = { kind: "enter", messages: [userMsg("我们 用 pnpm")] };
    const out = await withFetch(impl, () => run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision));
    assert.ok(!out.messages.some((m) => m.source?.form === "memory-recall"), "失败不召回");
    assert.ok(out.messages.some((m) => m.source?.form === "memory-context"), "主块照常注入");
    assert.equal(recallSnapshot().errors, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

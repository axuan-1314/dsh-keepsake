// inject-channel-wiring：消息通道注入接线。
//   模拟宿主 rc.2 的 agent/pre-step 契约（payload:{agent,messages,step,signal} + next()）
//   与 agent.session.{header.cwd,surface.nodes,eventAt(seq)}，验证：
//   minimal 场景不再依赖 section、视野去重（同内容不重复）、内容变化补发、视野丢失补发、
//   开关关闭不注入、预算丢弃可见、section 模式不注册 pre-step。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { apply } from "../lib/index.js";
import { createEntry, categoryDir, writePersona } from "../lib/global-store.js";
import { projectMemoryPaths } from "../lib/paths.js";
import { writeSettings, resetSettingsCache } from "../lib/settings.js";
import { PAGE_DEFS, writePages } from "../lib/pages.js";
import { __resetMetricsForTest, injectionSnapshot, recallSnapshot, recordInjection, recordInjectionSuperseded, recordInjectionThrottled } from "../lib/metrics.js";
import { estimateTokens } from "../lib/tokens.js";
import { MEMORY_CONTEXT_INTRO, MEMORY_CONTEXT_SUPERSEDE_NOTE } from "../lib/inject-channel.js";
import { skipReason } from "../lib/transcript.js";

function fakeCtx({ logs = null } = {}) {
  const sections = [];
  const handlers = new Map();
  const record = (level, ...args) => { if (logs !== null) logs.push({ level, args }); };
  const ctx = {
    logger: {
      info: (...a) => record("info", ...a),
      warn: (...a) => record("warn", ...a),
      error: (...a) => record("error", ...a),
    },
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
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-wiring-"));
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

/** 同一会话跨多轮的 agent 句柄：setEvents 换视野（本机实际环境里一会话一 agent，surface 随压缩/新轮变化）。
 *  跨轮断言必须用它——每轮新建 makeAgent 会被当成新会话，与本机实际环境语义不符。 */
function makeMutableAgent({ cwd, events = [] } = {}) {
  const state = { events: [...events] };
  return {
    setEvents(next) { state.events = [...next]; },
    session: {
      header: { cwd },
      get surface() { return { nodes: state.events.map((_, index) => index) }; },
      eventAt(seq) { return state.events[seq]; },
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
    assert.equal(sections[0].name, "dsh-keepsake:routing");
    const handler = handlers.get("agent/pre-step");
    assert.equal(typeof handler, "function", "message 模式应注册 pre-step");

    const decision = { kind: "enter", messages: [userMsg("记住 我们 统一 用 pnpm")] };
    const agent = makeAgent({ cwd: root });
    const out = await run(handler, payloadOf({ agent, messages: decision.messages }), decision);

    assert.equal(out.messages.length, 2, "应追加一条注入消息");
    const injected = out.messages[1];
    assert.equal(injected.role, "user");
    assert.equal(injected.source.kind, "plugin:dsh-keepsake");
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
    assert.equal(snap.lastTokens, estimateTokens(text), "token 记账与注入文本估算一致");
    assert.equal(snap.totalTokens, estimateTokens(text));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("同内容已在视野 → 不重复注入；小变化被节流；大变化补发；视野丢失必补发", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "A", content: "一" });
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root });
    const handler = handlers.get("agent/pre-step");
    const decision = () => ({ kind: "enter", messages: [userMsg("正常 用户 一句话")] });

    // 同一会话跨多轮共享一个 agent 句柄（本机实际环境语义：一会话一 agent，surface 随压缩/新轮变化）
    const agent = makeMutableAgent({ cwd: root });

    // 第一次：注入
    const first = await run(handler, payloadOf({ agent, messages: [] }), decision());
    assert.equal(first.messages.length, 2);
    const injected = first.messages[1];
    assert.equal(injectionSnapshot().throttled, 0, "首轮与节流无关");

    // 第二次：surface 里已有同内容 → 不重复
    const visibleEvent = { type: "user/message", data: injected };
    agent.setEvents([visibleEvent]);
    const second = await run(handler, payloadOf({ agent, messages: [] }), decision());
    assert.equal(second.messages.length, 1, "同内容不重复注入");
    assert.equal(injectionSnapshot().count, 1);
    assert.equal(injectionSnapshot().throttled, 0, "规范化相同不变 ≠ 节流，两态分列记账");

    // 第三次：内容变化但幅度太小 → 节流（同源替换：少发是 append-only 下唯一的收敛手段）
    createEntry(root, "work-profile", { title: "B", content: "二" });
    const third = await run(handler, payloadOf({ agent, messages: [] }), decision());
    assert.equal(third.messages.length, 1, "小变化被节流：本轮不注入新块");
    assert.equal(injectionSnapshot().count, 1, "节流轮不记成功注入");
    assert.equal(injectionSnapshot().throttled, 1, "节流轮记一笔 throttled（想发而没发，可见）");
    assert.equal(injectionSnapshot().superseded, 0, "没发新块就没有旧块被作废");

    // 第三次半：变化够大（人设正文涨 3000 字符）→ 节流放行，补发并作废旧块。
    // 3000 字符是为了稳稳越过 max(200, 全长 1%) 的地板值——升级阈值只认幅度，
    // 索引行数量的小幅增长本就该被节流（那是节流的本职工作，不是漏发）。
    writePersona(root, "人设正文".repeat(500));
    const thirdHalf = await run(handler, payloadOf({ agent, messages: [] }), decision());
    assert.equal(thirdHalf.messages.length, 2, "大变化应补发");
    assert.equal(injectionSnapshot().resends, 1, "补发记 resends");
    assert.equal(injectionSnapshot().superseded, 1, "发新块即凭取代声明作废旧块，记一次 superseded");
    assert.equal(injectionSnapshot().throttled, 1, "superseded 不挤占 throttled 计数");

    // 第四次：视野里没有（compaction 挤出）→ 节流让路，无条件补发。
    // 视野里虽然看不到旧块，但会话自记的上一块仍在（resend 判定的依据），
    // 故这条补发同样作废了历史里那个看不见的旧块——这才是同源替换要的语义：
    // 模型视野里只会同时留下"最后一块 + 声明"，不管它是否还在 surface 上。
    agent.setEvents([]);
    const fourth = await run(handler, payloadOf({ agent, messages: [] }), decision());
    assert.equal(fourth.messages.length, 2, "视野丢失应补发");
    assert.equal(injectionSnapshot().superseded, 2, "视野丢失轮：旧块已不在 surface，但会话仍知道发过，记 superseded");
    assert.equal(injectionSnapshot().throttled, 1, "视野丢失轮不记节流");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("superseded 按会话记账：新会话首发不计取代，同会话换块才计", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "A", content: "一" });
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root });
    const handler = handlers.get("agent/pre-step");
    const decision = () => ({ kind: "enter", messages: [userMsg("正常 用户 一句话")] });

    // 会话甲：首发
    const agentA = makeMutableAgent({ cwd: root });
    const a1 = await run(handler, payloadOf({ agent: agentA, messages: [] }), decision());
    assert.equal(a1.messages.length, 2);
    assert.equal(injectionSnapshot().superseded, 0, "甲会话首发没有旧块可取代");

    // 会话乙：全新会话首发——进程里虽然发过，但乙视野里没有旧块，不得记取代
    const agentB = makeMutableAgent({ cwd: root });
    const b1 = await run(handler, payloadOf({ agent: agentB, messages: [] }), decision());
    assert.equal(b1.messages.length, 2, "乙会话首发照常注入");
    assert.equal(injectionSnapshot().superseded, 0, "乙会话首发不计取代（跨会话不串账）");

    // 会话甲：内容大改且旧块已挤出视野 → 补发并作废甲自己的旧块 → 记一次取代
    writePersona(root, "人设正文".repeat(500));
    const a2 = await run(handler, payloadOf({ agent: agentA, messages: [] }), decision());
    assert.equal(a2.messages.length, 2);
    assert.equal(injectionSnapshot().superseded, 1, "同会话换块才记取代");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("接线结构钉：召回查询走统一机器来源判据、补发判定带会话自记的上一块", () => {
  const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  const anchor = src.indexOf("function latestUserProse");
  assert.ok(anchor > 0, "latestUserProse 应在");
  const region = src.slice(anchor, anchor + 500);
  assert.ok(region.includes("isMachineOrigin(message)"), "召回查询应与提取侧同一机器来源判据");
  assert.ok(!region.includes("isPluginSourcedMessage"), "不再用只认自家插件的窄判据");
  assert.ok(src.includes("injectStates.get(agent)"), "注入判定应按会话取自记状态");
  assert.ok(/shouldReinject\(\{ visible: prior !== void 0, lastInjectedText,/.test(src), "shouldReinject 应收到会话自记的 lastInjectedText（否则 resend 分支不可达）");
});

test("主块注入带块首取代声明（同源替换：旧块撤不回，声明让模型只认最后一块）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "A", content: "一" });
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root });
    const handler = handlers.get("agent/pre-step");
    const decision = { kind: "enter", messages: [userMsg("正常 用户 一句话")] };
    const out = await run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision);
    const text = textOf(out.messages[1]);
    // 声明行在免责/署名行之前（两者同处块首，顺序固定）
    assert.ok(text.indexOf(MEMORY_CONTEXT_SUPERSEDE_NOTE) < text.indexOf(MEMORY_CONTEXT_INTRO), "取代声明须在免责行之前");
    assert.match(text, /supersedes any earlier memory-context block/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("metrics：同源替换两计数分层记账（throttled 想发没发 / superseded 发了作废旧块）", () => {
  __resetMetricsForTest();
  // 空态：两个新字段恒在（/state.injection 契约双端同形，缺失=旧版）
  const empty = injectionSnapshot();
  assert.equal(empty.throttled, 0);
  assert.equal(empty.superseded, 0);
  // 节流轮：只有"想发而没发"，不碰 count/chars（没有消息真的发出）
  recordInjectionThrottled();
  recordInjectionThrottled();
  const throttled = injectionSnapshot();
  assert.equal(throttled.throttled, 2);
  assert.equal(throttled.count, 0, "节流不记成功注入");
  assert.equal(throttled.totalChars, 0, "节流不记字符");
  assert.equal(throttled.superseded, 0, "节流与取代无关");
  // 发新块：真的注入 + 作废旧块各记各的
  recordInjection({ chars: 500, resend: true });
  recordInjectionSuperseded();
  const sent = injectionSnapshot();
  assert.equal(sent.count, 1);
  assert.equal(sent.totalChars, 500);
  assert.equal(sent.superseded, 1);
  assert.equal(sent.throttled, 2, "两计数互不挤占");
  // 快照不可变（改返回值不影响内部态）
  sent.throttled = 999;
  sent.superseded = 999;
  assert.equal(injectionSnapshot().throttled, 2);
  assert.equal(injectionSnapshot().superseded, 1);
  __resetMetricsForTest();
  assert.equal(injectionSnapshot().throttled, 0, "复位生效");
  assert.equal(injectionSnapshot().superseded, 0, "复位生效");
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

    const ours = { role: "user", content: [{ type: "text", text: "x" }], source: { kind: "plugin:dsh-keepsake", form: "memory-context" } };
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
    // 720：块首两行固定开销（取代声明 179 + 免责）+ 包裹 + 人设正文（~220）都装得下的最小档，
    // 再低就会掉进"预算连固定开销都不够"的另一条路径（见下一条用例）。
    apply(ctx, { enabled: true, storageRoot: root, injectMaxChars: 720 });
    const handler = handlers.get("agent/pre-step");
    const decision = { kind: "enter", messages: [userMsg("正常 用户 一句话")] };
    const out = await run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision);
    const text = textOf(out.messages[1]);
    assert.match(text, /\[memory-context truncated/, "超预算应留可见提示");
    assert.ok(text.length <= 720, `应受预算约束（实际 ${text.length}）`);
    assert.ok(injectionSnapshot().droppedSegments >= 1, "应记录丢弃段数");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("injectChannel=section → 不注册 pre-step，注册六段（含 runtime 两段）", () => {
  const root = freshRoot();
  try {
    const { ctx, sections, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, injectChannel: "section" });
    assert.equal(sections.length, 6);
    assert.deepEqual(
      sections.map((s) => s.name),
      [
        "dsh-keepsake:persona",
        "dsh-keepsake:runtime-user",
        "dsh-keepsake:runtime-memory",
        "dsh-keepsake:global-index",
        "dsh-keepsake:instructions",
        "dsh-keepsake:index",
      ],
    );
    assert.equal(handlers.has("agent/pre-step"), false, "section 模式不应注册 pre-step");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("注入消息以 user/message 落事件流 → 提取侧 skip 门槛不被架空（防自食）", () => {
  const root = freshRoot();
  try {
    const injected = { role: "user", content: [{ type: "text", text: "很长很长的一段注入记忆内容".repeat(20) }], source: { kind: "plugin:dsh-keepsake", form: "memory-context" } };
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

// ---- 本批补钉：召回熔断 / 总预算 / 只读闸 / 总预算扣减召回块 / 全历史去重 ----

test("召回熔断有牙（P2-7）：连续 3 次失败后冷却期内不再发起嵌入请求", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "包管理", content: "团队统一用 pnpm 管理依赖" });
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, ...RECALL_CONFIG });
    const handler = handlers.get("agent/pre-step");
    const agent = makeAgent({ cwd: root });
    const msgs = () => [userMsg("pnpm 命令")];
    let calls = 0;
    const impl = async () => { calls += 1; throw new Error("embedding endpoint down"); };

    // 前 3 轮：每轮真实发起一次嵌入请求并失败 → 累积 streak=3 触发冷却
    for (let round = 1; round <= 3; round += 1) {
      calls = 0;
      await withFetch(impl, () => run(handler, payloadOf({ agent, messages: msgs() }), { kind: "enter", messages: msgs() }));
      assert.equal(calls, 1, `第 ${round} 轮失败前应发起 1 次嵌入请求`);
    }
    assert.equal(recallSnapshot().errors, 3, "三次失败应记入召回 errors");

    // 第 4 轮：冷却期内，嵌入请求次数不得再增长（0 次）——这是熔断的牙
    calls = 0;
    await withFetch(impl, () => run(handler, payloadOf({ agent, messages: msgs() }), { kind: "enter", messages: msgs() }));
    assert.equal(calls, 0, "冷却期内不得再发起嵌入请求（熔断生效）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recallTotalBudgetMs 总预算截断多批嵌入：批次数受限 + 已嵌向量增量落盘（新逻辑）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    const TOTAL = 130; // ceil(130/64)=3 批
    for (let i = 0; i < TOTAL; i += 1) {
      createEntry(root, "long-term", { name: `b-${String(i).padStart(3, "0")}.md`, title: `B${i}`, content: "x" });
    }
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, ...RECALL_CONFIG, recallTotalBudgetMs: 40, recallTimeoutMs: 5000 });
    const handler = handlers.get("agent/pre-step");
    let batchCalls = 0;
    // 慢桩且忽略 abort signal：每批固定 50ms，单批即超 40ms 总预算
    const impl = async (_url, options) => {
      const input = JSON.parse(options.body).input;
      if (input.length > 1) batchCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true, status: 200, json: async () => ({ data: input.map(() => ({ embedding: [0.1, 0.1] })) }) };
    };
    const decision = { kind: "enter", messages: [userMsg("pnpm 命令")] };
    await withFetch(impl, () => run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision));

    const totalBatches = Math.ceil(TOTAL / 64); // 3
    assert.ok(batchCalls < totalBatches, `总预算应截断批次（实际 ${batchCalls} < 全量 ${totalBatches}）`);
    assert.equal(batchCalls, 1, "40ms 预算 + 每批 50ms → 首轮批后即超预算，只跑 1 批");
    // 增量落盘：已嵌的那批向量不因预算截断而丢
    const cachePath = join(root, "embeddings.json");
    assert.equal(existsSync(cachePath), true, "逐批增量落盘：embeddings.json 应已写出");
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(Object.keys(cached.items).length, 64, "首批发出的 64 条向量应已落盘（不因截断丢已嵌向量）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("injectMaxChars 是总预算：覆盖召回块，主块让位（新逻辑）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    writePersona(root, "人".repeat(4000)); // 主块必然超预算 → 走截断路径
    createEntry(root, "work-profile", { title: "包管理", content: `团队统一用 pnpm 管理依赖 ${"详情".repeat(120)}` });
    const INJECT_MAX = 900;
    const decision = { kind: "enter", messages: [userMsg("我们 用 pnpm")] };
    const { impl } = stubFetch();

    // 召回开启：主块预算 = 总预算 − 召回块（+块间空行）
    const on = fakeCtx();
    apply(on.ctx, { enabled: true, storageRoot: root, injectChannel: "message", injectMaxChars: INJECT_MAX, ...RECALL_CONFIG });
    const outOn = await withFetch(impl, () => run(on.handlers.get("agent/pre-step"), payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision));
    const mainOn = textOf(outOn.messages.find((m) => m.source?.form === "memory-context"));
    const recallText = textOf(outOn.messages.find((m) => m.source?.form === "memory-recall"));
    assert.ok(recallText.length > 0, "召回块应注入");
    assert.ok(mainOn.length > 0, "主块应注入");
    assert.ok(mainOn.length <= INJECT_MAX, `主块应受总预算约束（实际 ${mainOn.length} ≤ ${INJECT_MAX}）`);

    // 召回关闭基线：主块独享总预算 → 更长；开启时两段合计不得超基线（±2 容差）
    const off = fakeCtx();
    apply(off.ctx, { enabled: true, storageRoot: root, injectChannel: "message", injectMaxChars: INJECT_MAX });
    const outOff = await run(off.handlers.get("agent/pre-step"), payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision);
    const mainOff = textOf(outOff.messages.find((m) => m.source?.form === "memory-context"));
    assert.ok(mainOn.length < mainOff.length, "召回开启时主块应比独享时短（为召回块让位）");
    assert.ok(
      mainOn.length + recallText.length <= mainOff.length + 2,
      `主块+召回块合计（${mainOn.length + recallText.length}）应不超过主块独享时的长度（${mainOff.length}，±2）`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("召回块按「全部历史块」去重：命中集变化再回到旧集不得新增第三块（新逻辑）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "包管理", content: "团队统一用 pnpm 管理依赖" });
    createEntry(root, "work-profile", { title: "脚本", content: "用 python 写脚本" });
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, ...RECALL_CONFIG });
    const handler = handlers.get("agent/pre-step");
    const { impl } = stubFetch();
    const history = [];
    const recallTexts = [];
    const step = async (query) => {
      const messages = [userMsg(query)];
      const out = await withFetch(impl, () => run(
        handler,
        payloadOf({ agent: makeAgent({ cwd: root, events: [...history] }), messages }),
        { kind: "enter", messages },
      ));
      const recall = out.messages.find((m) => m.source?.form === "memory-recall");
      if (recall) {
        recallTexts.push(textOf(recall));
        history.push({ type: "user/message", data: recall }); // 落进视野，供下一轮去重
      }
      return out;
    };

    // 轮 A：命中集合 X（pnpm）→ 注入第一块
    await step("pnpm 命令");
    assert.equal(recallTexts.length, 1, "首轮应注入召回块 X");
    assert.match(recallTexts[0], /pnpm/);

    // 轮 B：命中集合 Y（python）≠ X → 注入第二块
    await step("python 命令");
    assert.equal(recallTexts.length, 2, "命中集合变化应注入第二块");
    assert.match(recallTexts[1], /python/);
    assert.notEqual(recallTexts[0], recallTexts[1]);

    // 轮 C：回到 A 的等价查询（命中 X）→ X 已在视野（按全部历史块去重）→ 不得注入第三块
    const outC = await step("pnpm 命令");
    assert.equal(recallTexts.length, 2, "命中集合回到历史已注入的 X → 不得再注入");
    assert.ok(!outC.messages.some((m) => m.source?.form === "memory-recall"), "轮 C 不应产生新召回块");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 召回受总开关管（conversationMemory）/ 项目范围均衡 / 项目记忆开关 ----

test("总开关关（conversationMemory=false）→ 零注入 + 零嵌入调用（召回不再只认 emb.enabled）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "包管理", content: "团队统一用 pnpm 管理依赖" });
    writeSettings(root, { conversationMemory: false }); // 面板关掉对话记忆
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, ...RECALL_CONFIG });
    const handler = handlers.get("agent/pre-step");
    let calls = 0;
    const impl = async () => { calls += 1; throw new Error("总开关关：不得发起嵌入调用"); };
    const decision = { kind: "enter", messages: [userMsg("我们 用 pnpm 还是 python？")] };
    const out = await withFetch(impl, () => run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision));
    assert.equal(calls, 0, "总开关关：零嵌入调用");
    assert.ok(!out.messages.some((m) => m.source?.kind === "plugin:dsh-keepsake"), "总开关关：零注入（主块与召回块都不投）");
    assert.equal(recallSnapshot().hits, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("projectMemory=false → 召回只收集全局、不做项目范围召回（零项目条目）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    // 只放项目条目（无全局条目）+ 关掉项目记忆 → 候选集为空 → 不召回、不发起嵌入
    seedProjectMemory(root);
    writeSettings(root, { projectMemory: false });
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, ...RECALL_CONFIG });
    const handler = handlers.get("agent/pre-step");
    let calls = 0;
    const impl = async () => { calls += 1; throw new Error("项目记忆关且无全局条目：无候选，不应发起嵌入"); };
    const decision = { kind: "enter", messages: [userMsg("项目 条目 P")] };
    const out = await withFetch(impl, () => run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision));
    assert.equal(calls, 0, "项目范围被关且无全局条目 → 候选为空 → 零嵌入调用");
    assert.ok(!out.messages.some((m) => m.source?.form === "memory-recall"), "无召回块");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("召回候选范围均衡：全局先占满不再饿死项目（各半名额，总量仍受上限约束）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    // 全局条目数 > RECALL_MAX_ITEMS（1000）：旧实现全局先占满候选，项目永远轮不上。
    // 用裸文件写（createEntry 逐条重建索引太慢），listEntries 读 .md 即可。
    const gDir = categoryDir(root, "long-term");
    mkdirSync(gDir, { recursive: true });
    for (let i = 0; i < 1100; i += 1) {
      const name = `g-${String(i).padStart(4, "0")}.md`;
      writeFileSync(join(gDir, name), `---\nname: g${i}\ntitle: G${i}\ndescription: d\n---\n全局正文 ${i}\n`);
    }
    seedProjectMemory(root); // 1 条项目条目（含 "项目正文"）
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, ...RECALL_CONFIG });
    const handler = handlers.get("agent/pre-step");
    const { impl, calls } = stubFetch();
    const decision = { kind: "enter", messages: [userMsg("pnpm 命令")] };
    await withFetch(impl, () => run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision));
    // 批次里至少嵌过项目条目——旧实现全局先占满会让项目永远轮不上
    const embeddedTexts = calls.flatMap((c) => c.body.input.map(String));
    assert.ok(embeddedTexts.some((t) => t.includes("项目正文")), "项目条目进入了嵌入候选（范围均衡生效）");
    // 总量仍受 RECALL_MAX_ITEMS 约束（候选条目数不超过 1000；剔除同批里的查询文本）
    const QUERY = "pnpm 命令";
    const candidateTexts = new Set(embeddedTexts.filter((t) => t !== QUERY));
    assert.ok(candidateTexts.size <= 1000, `候选总量不超上限（实际 ${candidateTexts.size}）`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("召回候选双向让位：全局 1100 项目 1 → 全局吃满余量（旧实现白丢 499 名额）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    const gDir = categoryDir(root, "long-term");
    mkdirSync(gDir, { recursive: true });
    for (let i = 0; i < 1100; i += 1) {
      const name = `g-${String(i).padStart(4, "0")}.md`;
      writeFileSync(join(gDir, name), `---\nname: g${i}\ntitle: G${i}\ndescription: d\n---\n全局正文 ${i}\n`);
    }
    seedProjectMemory(root); // 1 条项目条目
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, ...RECALL_CONFIG });
    const handler = handlers.get("agent/pre-step");
    const { impl, calls } = stubFetch();
    const decision = { kind: "enter", messages: [userMsg("pnpm 命令")] };
    await withFetch(impl, () => run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision));
    const QUERY = "pnpm 命令";
    const embedded = new Set(calls.flatMap((c) => c.body.input.map(String)).filter((t) => t !== QUERY));
    // 双向让位：项目只占 1 名额，其余 999 名额全给全局（旧单向实现 global 恒 ≤500）
    const globalCount = [...embedded].filter((t) => t.includes("全局正文")).length;
    assert.equal(embedded.size, 1000, "候选吃满上限（全局占满项目让出的余量）");
    assert.equal(globalCount, 999, "全局侧拿到 999 名额（=1000 - 1 个项目条目）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("召回候选双向让位：全局 1 项目 1100 → 项目吃满余量（与 1100:1 对称）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "long-term", { title: "G0", name: "g0.md", content: "全局正文 0" });
    const { memoryDir } = projectMemoryPaths(root, root);
    mkdirSync(memoryDir, { recursive: true });
    for (let i = 0; i < 1100; i += 1) {
      const name = `p-${String(i).padStart(4, "0")}.md`;
      writeFileSync(join(memoryDir, name), `---\nname: p${i}\ntitle: P${i}\ndescription: d\n---\n项目正文 ${i}\n`);
    }
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, ...RECALL_CONFIG });
    const handler = handlers.get("agent/pre-step");
    const { impl, calls } = stubFetch();
    const decision = { kind: "enter", messages: [userMsg("pnpm 命令")] };
    await withFetch(impl, () => run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision));
    const QUERY = "pnpm 命令";
    const embedded = new Set(calls.flatMap((c) => c.body.input.map(String)).filter((t) => t !== QUERY));
    const projectCount = [...embedded].filter((t) => t.includes("项目正文")).length;
    assert.equal(embedded.size, 1000, "候选吃满上限（项目占满全局让出的余量）");
    assert.equal(projectCount, 999, "项目侧拿到 999 名额（=1000 - 1 个全局条目）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("召回候选截断：超上限时 log.warn 可见（不静默丢候选）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    const gDir = categoryDir(root, "long-term");
    mkdirSync(gDir, { recursive: true });
    for (let i = 0; i < 1100; i += 1) {
      const name = `g-${String(i).padStart(4, "0")}.md`;
      writeFileSync(join(gDir, name), `---\nname: g${i}\ntitle: G${i}\ndescription: d\n---\n全局正文 ${i}\n`);
    }
    const logs = [];
    const { ctx, handlers } = fakeCtx({ logs });
    apply(ctx, { enabled: true, storageRoot: root, ...RECALL_CONFIG });
    const handler = handlers.get("agent/pre-step");
    const { impl } = stubFetch();
    const decision = { kind: "enter", messages: [userMsg("pnpm 命令")] };
    await withFetch(impl, () => run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision));
    assert.ok(
      logs.some((l) => l.level === "warn" && String(l.args[0]).includes("召回候选超上限已截断")),
      "候选超上限必须留 warn 痕（此前该 warn 无牙）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("召回候选确定性：超限取舍按稳定序（mtime 降序），与 readdir 遍历序无关", async () => {
  __resetMetricsForTest();
  // 1100 项目条目：mtime = 递增（p-1099 最新、p-0000 最旧），故意与文件名 readdir 序相悖。
  // mtime 降序取舍的期望集 = p-1099 … p-0100；若按 readdir 序（文件名序）截取会得到
  // p-0000 … p-0999（不同的集）——两次运行独立 root 都取到同一期望集才算稳定序生效。
  const seedSame = (root) => {
    const { memoryDir } = projectMemoryPaths(root, root);
    mkdirSync(memoryDir, { recursive: true });
    const base = new Date("2020-01-01T00:00:00.000Z").getTime();
    for (let i = 0; i < 1100; i += 1) {
      const name = `p-${String(i).padStart(4, "0")}.md`;
      const full = join(memoryDir, name);
      writeFileSync(full, `---\nname: p${i}\ntitle: P${i}\ndescription: d\n---\n项目正文 ${i}\n`);
      const t = new Date(base + i * 1000);
      utimesSync(full, t, t);
    }
  };
  const collectOnce = async (root) => {
    seedSame(root);
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, ...RECALL_CONFIG });
    const handler = handlers.get("agent/pre-step");
    const { impl, calls } = stubFetch();
    const decision = { kind: "enter", messages: [userMsg("pnpm 命令")] };
    await withFetch(impl, () => run(handler, payloadOf({ agent: makeAgent({ cwd: root }), messages: decision.messages }), decision));
    const QUERY = "pnpm 命令";
    return calls.flatMap((c) => c.body.input.map(String)).filter((t) => t !== QUERY);
  };
  const rootA = freshRoot();
  const rootB = freshRoot();
  try {
    const first = await collectOnce(rootA);
    const second = await collectOnce(rootB);
    assert.equal(first.length, 1000, "项目侧超限取满上限（全局无条目，余量全给项目）");
    // 期望集：mtime 降序前 1000 条 = p-1099 … p-0100
    const expected = new Set();
    for (let i = 1099; i >= 100; i -= 1) expected.add(`P${i}\nd\n项目正文 ${i}`);
    assert.deepEqual(new Set(first), expected, "取舍按 mtime 降序（不是 readdir 文件名序）");
    assert.deepEqual(first, second, "同输入两次运行选集完全相同（稳定序）");
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('注入 token 记账：累计只加显式值、缺省/脏值按 0、复位清零', () => {
  __resetMetricsForTest();
  recordInjection({ chars: 10, tokens: 7 });
  recordInjection({ chars: 20 }); // 缺省 tokens
  let snap = injectionSnapshot();
  assert.equal(snap.lastTokens, 0, '缺省 tokens 最近值按 0');
  assert.equal(snap.totalTokens, 7, '缺省不加也清不掉累计');
  recordInjection({ chars: 5, tokens: 3 });
  recordInjection({ chars: 5, tokens: NaN });
  recordInjection({ chars: 5, tokens: -2 });
  snap = injectionSnapshot();
  assert.equal(snap.lastTokens, 0, '脏值（NaN/负数）按 0');
  assert.equal(snap.totalTokens, 10, '只累计显式正值');
  __resetMetricsForTest();
  snap = injectionSnapshot();
  assert.equal(snap.lastTokens, 0);
  assert.equal(snap.totalTokens, 0);
});

test('token 预算接线：injectMaxTokens 顶紧按 token 丢段、记账不越上限（字符口径宽松）', async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    // 三条重 CJK 索引（描述进索引行）：字符数不高但 token 代价高（1.5/字）
    for (let i = 1; i <= 3; i += 1) {
      createEntry(root, 'work-profile', { title: 'T' + i, description: '述'.repeat(500), content: '正文' });
    }
    seedProjectMemory(root);
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, injectMaxChars: 100000, injectMaxTokens: 300 });
    const handler = handlers.get('agent/pre-step');
    const decision = { kind: 'enter', messages: [userMsg('你好')] };
    const agent = makeAgent({ cwd: root });
    const out = await run(handler, payloadOf({ agent, messages: decision.messages }), decision);
    const text = textOf(out.messages[1]);
    const snap = injectionSnapshot();
    assert.ok(snap.droppedSegments > 0, 'token 顶紧应丢段');
    assert.ok(estimateTokens(text) <= 300, '注入块 token 预算内（实际 ' + estimateTokens(text) + '）');
    assert.equal(snap.lastTokens, estimateTokens(text), '记账=真实口径');
    assert.ok(snap.lastTokens <= 300);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('token 预算接线：上限禁用（0）同样内容不丢段（对照）', async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, 'work-profile', { title: 'T', description: '述'.repeat(500), content: '正文' });
    seedProjectMemory(root);
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, injectMaxChars: 100000, injectMaxTokens: 0 });
    const handler = handlers.get('agent/pre-step');
    const decision = { kind: 'enter', messages: [userMsg('你好')] };
    const agent = makeAgent({ cwd: root });
    const out = await run(handler, payloadOf({ agent, messages: decision.messages }), decision);
    const text = textOf(out.messages[1]);
    const snap = injectionSnapshot();
    assert.equal(snap.droppedSegments, 0, 'token 预算禁用时不丢段');
    assert.ok(text.includes('述'.repeat(50)), '重 CJK 内容全量在场');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 紧凑索引兜底接线：项目 MEMORY.md 太大时不整段消失，降级为「总数 + 最新 N 行 + 路径」 ----

test("紧凑索引兜底接线：项目索引超预算时注入 compact 版并记账 compactedSegments", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    const { memoryDir } = projectMemoryPaths(root, root);
    mkdirSync(memoryDir, { recursive: true });
    const lines = [];
    for (let i = 1; i <= 40; i += 1) {
      lines.push(`- [entry-${i}](entry-${i}.md) — 这是一条用于预算测试的项目记忆索引行，编号 ${i}，后面补足字符让完整索引确实放不下。`);
    }
    writeFileSync(join(memoryDir, "MEMORY.md"), lines.join("\n"));

    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, injectMaxChars: 3200 });
    const handler = handlers.get("agent/pre-step");
    const decision = { kind: "enter", messages: [userMsg("继续做预算测试")] };
    const agent = makeAgent({ cwd: root });
    const out = await run(handler, payloadOf({ agent, messages: decision.messages }), decision);

    assert.equal(out.messages.length, 2, "应追加一条注入消息");
    const text = textOf(out.messages[1]);
    assert.match(text, /Project memory index \(MEMORY\.md\) — compact/, "项目索引应降级为紧凑版");
    assert.match(text, /40 entries; showing latest 8/, "紧凑版应给出总数与展示条数");
    assert.match(text, /entry-40/, "紧凑版应保留最新条目");
    assert.ok(!text.includes("entry-1]"), "紧凑版不应保留最旧条目（证明不是完整索引）");
    assert.match(text, /\[memory-context truncated: compacted projectIndex\]/, "截断提示应点名紧凑降级");
    assert.equal(injectionSnapshot().compactedSegments, 1, "compactedSegments 应记一笔");
    assert.equal(injectionSnapshot().droppedSegments, 0, "紧凑降级不是整段丢弃");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("知识页摘要接线：有页面时排在项目索引前，模型先看到知识地图", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    const { memoryDir } = projectMemoryPaths(root, root);
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "p.md"), "---\nname: p\ntitle: P\n---\n正文\n");
    writeFileSync(join(memoryDir, "MEMORY.md"), "- [P](p.md) — 项目条目\n");
    const projectId = basename(dirname(memoryDir));
    writePages(root, projectId, PAGE_DEFS.map((definition) => ({
      id: definition.id,
      title: definition.title,
      summary: `${definition.title} 一行摘要`,
      content: `# ${definition.title}\n\n- 来自 [[p]]`,
    })), { generatedAt: "2026-10-25T00:00:00.000Z" });

    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root });
    const handler = handlers.get("agent/pre-step");
    const decision = { kind: "enter", messages: [userMsg("继续")] };
    const agent = makeAgent({ cwd: root });
    const out = await run(handler, payloadOf({ agent, messages: decision.messages }), decision);
    const text = textOf(out.messages[1]);
    assert.match(text, /Project knowledge pages/, "应注入知识页摘要");
    assert.match(text, /组件地图/, "五页标题应在摘要里");
    assert.ok(
      text.indexOf("Project knowledge pages") < text.indexOf("Project memory index"),
      "知识页应排在原始索引之前（先地图、后索引）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

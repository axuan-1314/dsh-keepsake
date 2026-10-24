// recall-degrade：召回端点配错时的面板红条（方案 v2 §4.2 的降级落地）。
//
// 事故背景：v0.6.5 之前 `resolveConfig` 对「recallEnabled 开了但端点/模型/通道不全」
// 直接 throw，而 apply() 第一行就调它且无 try/catch——用户只是没填嵌入端点，
// 代价是**整个插件起不来**：核心的对话记忆提取与注入一起没了。
// 本批把它拆成两类，语义完全不同：
//   ① 静态配置类（本用例主角）：插件照常加载 + 召回**显式关闭**（零嵌入调用）+ 面板红条指路。
//      不是 fail-open——开关被置 false、原因上屏，用户看得见「开了但没工作」。
//   ② 运行时故障类（端点配了但连不上/超时/HTTP 错）：既有熔断 + /state.recall.errors 不动，
//      本批只补面板可见性。
//
// 断言纪律（不许只测纯函数）：
//   - 走真 `apply()` 入口（构造 recallEnabled=true 但缺 baseUrl 的配置）；
//   - 走真 REST `/state` 面（与面板/门牌同一数据源）；
//   - 走真 panel.html 的行模板求值（渲染级，不是 grep 源码）；
//   - 召回「真的不执行」用**假 fetch 计数**证（0 次嵌入调用），不看内部变量。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { API_PREFIX } from "../lib/api.js";
import { createEntry } from "../lib/global-store.js";
import { apply, resolveConfig } from "../lib/index.js";
import { __resetMetricsForTest, recallSnapshot } from "../lib/metrics.js";
import { recallDisabledNoticeText, recallRuntimeFailureText } from "../lib/panel-logic.js";
import { resetSettingsCache, writeSettings } from "../lib/settings.js";
import { resetFormatCache } from "../lib/format.js";
import * as L from "../lib/panel-logic.js";

const here = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(join(here, "..", "web", "panel.html"), "utf8");
const clientSrc = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

const silentLog = { info() {}, warn() {}, error() {} };

/** 假宿主 ctx：事件处理器 + REST 路由（与 extract-route-resilience 同形）。 */
function fakeCtx() {
  const handlers = new Map();
  const routes = [];
  const warns = [];
  const ctx = {
    logger: { info() {}, warn: (...a) => warns.push(a.join(" ")), error() {} },
    on(type, fn) { handlers.set(type, fn); },
    effect(fn) { try { fn(); } catch { /* disposer 忽略 */ } return () => {}; },
    inject(_deps, setup) {
      const pending = [];
      const sctx = {
        effect(fn) { pending.push(fn); },
        webServer: { register(route) { routes.push(route); return () => {}; } },
      };
      setup(sctx);
      for (const fn of pending) fn();
    },
    systemPrompt: { section() { return () => {}; } },
    llm: { stream() { throw new Error("本用例不涉及提取调用"); } },
  };
  return { ctx, handlers, routes, warns };
}

function mockReq({ method, url }) {
  const req = new Readable({ read() { this.push(null); } });
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1:3080" };
  req.socket = { remoteAddress: "127.0.0.1" };
  req.destroy = () => {};
  return req;
}

function mockRes() {
  return {
    status: 0,
    body: "",
    writeHead(status) { this.status = status; },
    end(chunk) { this.body = chunk ?? ""; },
    get headersSent() { return this.status !== 0; },
  };
}

function freshRoot(tag) {
  resetSettingsCache();
  resetFormatCache();
  __resetMetricsForTest();
  return mkdtempSync(join(tmpdir(), `dsh-keepsake-recall-${tag}-`));
}

/** 经真 REST 面读 /state（面板与门牌同一数据源）。 */
async function readState(routes) {
  const apiRoute = routes.find((r) => r.kind === "prefix" && r.path === API_PREFIX.replace(/\/$/, ""));
  assert.ok(apiRoute, "apply() 应注册 API prefix 路由");
  const res = mockRes();
  await apiRoute.handler(mockReq({ method: "GET", url: API_PREFIX + "state" }), res);
  assert.equal(res.status, 200, `/state 应 200（实际 ${res.status}）`);
  return JSON.parse(res.body);
}

/** 假 agent/pre-step 载荷（同 inject-channel-wiring 的宿主契约形态）。 */
function makeAgent(cwd, events = []) {
  const map = new Map(events.map((event, index) => [index, event]));
  return {
    session: {
      header: { cwd },
      surface: { nodes: [...map.keys()] },
      eventAt(seq) { return map.get(seq); },
    },
  };
}

const userMsg = (text) => ({ role: "user", content: [{ type: "text", text }] });

/** 跑一轮 pre-step；返回 [决策, fetch 调用次数]。 */
async function runPreStep(handler, cwd, text) {
  let fetchCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error("端点未配齐时不得发起嵌入调用"); };
  try {
    const messages = [userMsg(text)];
    const decision = { kind: "enter", messages };
    const out = await handler({ agent: makeAgent(cwd), messages, step: 1, signal: { aborted: false } }, async () => decision);
    return [out, fetchCalls];
  } finally {
    globalThis.fetch = original;
  }
}

// ================================================================
// ① 静态配置类：插件照常起、召回不执行、/state 有诊断、面板与门牌出红条
// ================================================================

test("① 静态配置类：recallEnabled 但缺 embeddingBaseUrl → apply 不抛、插件照常加载、/state 带诊断", async () => {
  const root = freshRoot("missing-url");
  try {
    const { ctx, routes } = fakeCtx();
    // 关键断言：不再启动即抛（这是本批要修的真 bug）
    assert.doesNotThrow(
      () => apply(ctx, { enabled: true, storageRoot: root, recallEnabled: true }),
      "缺端点不得让整个插件起不来（核心记忆功能不该被可选功能配错连坐）",
    );
    const state = await readState(routes);
    assert.equal(state.ok, true);
    // 诊断面：缺什么、通道有没有问题
    assert.deepEqual(
      state.recallDiagnostics.disabled,
      { missing: ["embeddingBaseUrl", "embeddingModel"], channelMismatch: false },
      "/state 必须如实报出缺哪两个键",
    );
    assert.equal(state.recallDiagnostics.effectiveEnabled, false, "本轮不会召回（显式关闭，不是静默照跑）");
    // 计数面保持原样（没跑过召回 → 全零；不能把"没跑"伪装成"跑了但没命中"）
    assert.equal(state.recall.hits, 0);
    assert.equal(state.recall.misses, 0);
    assert.equal(state.recall.errors, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("① 静态配置类：只缺 embeddingModel / 通道是 section 各自给出精确诊断", async () => {
  const root = freshRoot("partial");
  try {
    {
      const { ctx, routes } = fakeCtx();
      apply(ctx, { enabled: true, storageRoot: root, recallEnabled: true, embeddingBaseUrl: "http://127.0.0.1:1/v1/embeddings" });
      const state = await readState(routes);
      assert.deepEqual(state.recallDiagnostics.disabled, { missing: ["embeddingModel"], channelMismatch: false });
    }
    {
      resetSettingsCache();
      const { ctx, routes } = fakeCtx();
      apply(ctx, {
        enabled: true, storageRoot: root, injectChannel: "section", recallEnabled: true,
        embeddingBaseUrl: "http://127.0.0.1:1/v1/embeddings", embeddingModel: "m",
      });
      const state = await readState(routes);
      assert.deepEqual(
        state.recallDiagnostics.disabled,
        { missing: [], channelMismatch: true },
        "section 模式召回永不执行 → 必须显式摊牌（不静默 no-op）",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("① 静态配置类：召回真的不执行（一轮 pre-step 零嵌入调用，主块照常注入）", async () => {
  const root = freshRoot("no-call");
  try {
    const { ctx, handlers } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, recallEnabled: true }); // 缺端点
    const handler = handlers.get("agent/pre-step");
    assert.equal(typeof handler, "function", "message 通道照常注册（核心注入不受影响）");
    // 必须先造一条真条目再断言 fetch=0：无条目时召回即使 fail-open 也不会发嵌入请求
    //（没有候选就没有调用），断言就没有区分力（复查 P1：两道闸叠着，退化成 fail-open 仍全部通过）。
    createEntry(root, "work-profile", { title: "包管理", content: "团队统一用 pnpm 管理依赖" });
    const [out, fetchCalls] = await runPreStep(handler, root, "我们 团队 统一 用 pnpm 管理依赖 记住 这件事");
    assert.equal(fetchCalls, 0, "配置不全时不得发起任何嵌入调用（不是「开着但每轮白撞一次」）；有候选仍为 0 才算真关闭");
    assert.ok(
      Array.isArray(out.messages) && !out.messages.some((m) => m.source?.form === "memory-recall"),
      "不得注入召回块",
    );
    assert.equal(recallSnapshot().hits, 0);
    assert.equal(recallSnapshot().errors, 0, "没有真的去调，就不能记 error（错误计数要如实）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("① 静态配置类：面板红条真的渲染（抠 panel.html 真实行模板求值）", () => {
  // 从 panel.html 抠「语义召回红条」两行模板求值——不是 grep 源码，
  // 能拦住「函数在场但面板没接线」与「接线时接错数据源」。
  const lines = panelSrc.split("\n");
  const pathIdx = lines.findIndex((l) => l.includes("const settingsFilePath = data.storageRoot"));
  const assignIdx = lines.findIndex((l) => l.includes("const recallDisabledLine = L.recallDisabledNoticeText("));
  assert.ok(pathIdx >= 0 && assignIdx >= 0 && assignIdx === pathIdx + 1,
    "面板必须先现算 settingsFilePath（storageRoot 可配，写死 ~/.dsh 会指错路）再接红条");
  assert.match(lines[assignIdx], /L\.recallDisabledNoticeText\(data\.recallDiagnostics, settingsFilePath\)/,
    "红条数据源必须是 data.recallDiagnostics + 现算路径（接到 /state.recall 上就永远拿不到配置诊断）");
  const pushLine = lines[assignIdx + 1];
  assert.ok(pushLine.includes("class=\"notice show err\"") && pushLine.includes("⚠️"), "红条必须是 err 样式 + ⚠️ 前缀（与既有红条同口径）");
  assert.ok(pushLine.includes("esc(recallDisabledLine)"), "文案必须过 esc（含用户可控的键名）");

  // 按面板同口径求值整行（esc 与 panel.html 定义一致；parts 是健康卡的累积数组）
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const render = (state) => {
    const parts = [];
    new Function("data", "L", "esc", "parts",
      `${lines[pathIdx]}\n${lines[assignIdx]}\n${pushLine}`)(state, L, esc, parts);
    return parts.join("");
  };
  const html = render({ recallDiagnostics: { disabled: { missing: ["embeddingBaseUrl"], channelMismatch: false }, effectiveEnabled: false } });
  assert.ok(html.includes("<div"), `应渲染成 div：${html}`);
  assert.ok(html.includes("语义召回已关闭"), "红条必须说清「召回被关了」（不是含糊的『配置有问题』）");
  assert.ok(html.includes("embeddingBaseUrl"), "必须点名缺哪个键（用户要照着改）");
  assert.ok(html.includes("~/.dsh/memory/settings.json"), "storageRoot 缺失时回落默认路径");
  assert.ok(html.includes("其它功能不受影响"), "必须说明影响范围（否则用户以为整个插件坏了）");
  // 自定义 storageRoot → 指路必须是真实路径（写死 ~/.dsh 会给自定义用户指错路）
  const customHtml = render({
    storageRoot: "D:/custom/root/",
    recallDiagnostics: { disabled: { missing: ["embeddingBaseUrl"], channelMismatch: false }, effectiveEnabled: false },
  });
  assert.ok(customHtml.includes("D:/custom/root/settings.json"), "自定义 storageRoot 时必须指真实路径");
  assert.ok(!customHtml.includes("~/.dsh"), "自定义路径下不得再出现 ~/.dsh 兜底（指路只能有一个真相）");
  // switchOff 岔：配置齐了但开关没开 → 红条点名开关（不是继续喊缺键——键已不缺）
  const switchHtml = render({
    recallDiagnostics: { disabled: { missing: [], channelMismatch: false, switchOff: true }, effectiveEnabled: false },
  });
  assert.ok(switchHtml.includes("开启语义召回"), "switchOff 红条必须点名「开启语义召回」开关");
  assert.ok(switchHtml.includes("端点与模型已配好"), "switchOff 红条必须说明配置已齐（缺的只是开关这一步）");
  assert.ok(!switchHtml.includes("缺 embedding"), "switchOff 时不得谎报缺键（复查 P0：红条指向不存在的缺口）");
  // 没降级（诊断 null）→ 不渲染任何东西
  assert.equal(render({ recallDiagnostics: null }).trim(), "", "无诊断不得渲染红条（旧宿主/配置齐备）");
});

test("① 静态配置类：门牌红条真的渲染（client.js 兜底 + 接线锚）", () => {
  // 接线锚：门牌必须消费 /state.recallDiagnostics + storageRoot 现算路径（缺了 = 红条只面板有，门牌沉默）
  assert.match(clientSrc, /const recallDisabledLine = state \? recallDisabledNotice\(state\.recallDiagnostics, settingsFilePath\) : null;/,
    "门牌接线锚：数据源必须是 state.recallDiagnostics + 现算 settingsFilePath");
  assert.match(clientSrc, /LOGIC \? LOGIC\.recallDisabledNoticeText/, "门牌必须经 panel-logic 优先分发（单一事实源）");
  // 兜底与实现逐字一致（动态 import 失败时的退路，不许两边文案不同）
  const fn = extractFactoryFn(clientSrc, "recallDisabledNoticeFallback", "diagnostics, settingsPath");
  const cases = [
    null, void 0, {}, [], "x", // 旧宿主/畸形 → null
    { disabled: null },
    { disabled: {} }, // 空 reason：既没缺键也没通道问题 → null（不装样子）
    { disabled: { missing: ["embeddingBaseUrl"], channelMismatch: false } },
    { disabled: { missing: ["embeddingModel"], channelMismatch: false } },
    { disabled: { missing: ["embeddingBaseUrl", "embeddingModel"], channelMismatch: false } },
    { disabled: { missing: [], channelMismatch: true } },
    { disabled: { missing: ["embeddingModel"], channelMismatch: true } },
    { disabled: { missing: ["embeddingBaseUrl", null, 3, ""], channelMismatch: false } },
    { disabled: { missing: [], channelMismatch: false, switchOff: true } },
    { disabled: { missing: ["embeddingModel"], channelMismatch: false, switchOff: true } },
  ];
  for (const c of cases) {
    assert.equal(fn(c), recallDisabledNoticeText(c), `兜底与实现输出不一致：${JSON.stringify(c)}`);
  }
  // 文案模板锚（任何一边改文案，另一边立刻失一致被上一循环抓住；此处再钉模板本身）
  assert.ok(clientSrc.includes("语义召回已关闭（"), "门牌兜底必须保留「语义召回已关闭」这句");
  assert.ok(panelSrc.includes("L.recallDisabledNoticeText("), "面板必须走共享纯函数");
});

/** 从 client.js factory（4 空格缩进）提取指定内联兜底函数体并求值（同 client-source.test.mjs）。 */
function extractFactoryFn(src, name, params) {
  const re = new RegExp(`^ {4}function ${name}\\(${params}\\) \\{([\\s\\S]*?)\\n {4}\\}$`, "m");
  const m = src.match(re);
  assert.ok(m, `client.js 必须保留内联兜底 ${name}（动态 import 失败的退路）`);
  const argNames = params.split(",").map((p) => p.trim().split("=")[0].trim());
  return new Function(...argNames, m[1]);
}

// ================================================================
// ② 运行时故障类：配置齐备但端点连不上 → 既有熔断不动，面板/门牌看得见
// ================================================================

test("② 运行时故障类：端点连不上 → errors 计数上屏 + 面板/门牌红条；静态诊断保持 null", async () => {
  const root = freshRoot("runtime-fail");
  try {
    // 必须真有一条记忆条目：无条目时 collectRecallItems 为空、根本不发嵌入请求（会假装"没失败"）
    createEntry(root, "work-profile", { title: "包管理", content: "团队统一用 pnpm 管理依赖" });
    const { ctx, handlers, routes } = fakeCtx();
    apply(ctx, {
      enabled: true, storageRoot: root, recallEnabled: true,
      embeddingBaseUrl: "http://127.0.0.1:1/v1/embeddings", embeddingModel: "m",
      recallTimeoutMs: 500, extractIdleDelayMs: 0,
    });
    // 配置齐备 → 静态诊断 null（不误报降级）
    let state = await readState(routes);
    assert.equal(state.recallDiagnostics.disabled, null, "配置齐备时不得报「已关闭」");
    assert.equal(state.recallDiagnostics.effectiveEnabled, true, "本轮会尝试召回");

    // 真跑一轮 pre-step，fetch 直接拒（端点不可达）→ 记 error，不抛给宿主
    const handler = handlers.get("agent/pre-step");
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    try {
      const messages = [userMsg("我们 团队 统一 用 pnpm 管理依赖 记住 这件事")];
      const decision = { kind: "enter", messages };
      const out = await handler({ agent: makeAgent(root), messages, step: 1, signal: { aborted: false } }, async () => decision);
      assert.ok(out && Array.isArray(out.messages), "召回失败不得炸宿主轮次");
    } finally {
      globalThis.fetch = original;
    }
    state = await readState(routes);
    assert.equal(state.recall.errors, 1, "失败必须计数（/state.recall.errors 既有通路）");
    // 运行时故障文案：与静态配置类分开
    const line = recallRuntimeFailureText(state.recall);
    assert.ok(line !== null && line.includes("语义召回失败 1 次"), `运行时故障文案：${line}`);
    assert.ok(line.includes("检查设置里的嵌入端点"), "文案要指路（去哪查）");
    // 面板/门牌都接线了这条（互斥显示：静态红条在时不重复报运行时）
    assert.ok(panelSrc.includes("L.recallRuntimeFailureText(data.recall)"), "面板必须消费运行时故障文案");
    assert.match(clientSrc, /recallRuntimeFailure\(state\.recall\)/, "门牌必须消费运行时故障文案");
    // 推行锚（复查 P1：只锁 const 行锁不住「算了但没 push」）
    assert.match(panelSrc, /if \(recallFailureLine\) parts\.push\(/, "面板必须把 recallFailureLine push 进健康卡");
    assert.match(clientSrc, /recallFailureLine = state && recallDisabledLine === null \? recallRuntimeFailure\(state\.recall\) : null;/,
      "门牌运行时红条必须与静态红条互斥（静态在场时不重复报）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("② 运行时故障类：熔断语义未动（连续 3 次后暂停）；本批只加可见性", async () => {
  const root = freshRoot("breaker");
  try {
    const { ctx, routes } = fakeCtx();
    apply(ctx, {
      enabled: true, storageRoot: root, recallEnabled: true,
      embeddingBaseUrl: "http://127.0.0.1:1/v1/embeddings", embeddingModel: "m",
      recallTimeoutMs: 500, extractIdleDelayMs: 0,
    });
    // 直接改 metrics 不可行（本用例要证的是"熔断阈值/时长没被我改动"）——
    // 用源码常量锚 + 行为断言的一半：常量仍是 3 次 / 60s。
    const src = readFileSync(join(here, "..", "lib", "index.js"), "utf8");
    assert.match(src, /const RECALL_FAILURE_LIMIT = 3;/, "熔断阈值必须保持 3（本批不改熔断语义）");
    assert.match(src, /const RECALL_COOLDOWN_MS = 60000;/, "熔断冷却必须保持 60s（本批不改熔断语义）");
    // 且运行时故障不写进静态诊断（两类不许混）
    const state = await readState(routes);
    assert.equal(state.recallDiagnostics.disabled, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ================================================================
// ③ 降级边界：谁该抛、谁不该抛（写进 CHANGELOG 的口径必须有测试）
// ================================================================

test("③ 边界：配错（非 http(s) 端点）仍然启动即抛；配不全才降级", () => {
  const root = freshRoot("boundary");
  try {
    const { ctx } = fakeCtx();
    // 「配了但配错」= 用户明确给了个非法值 → 仍然 fail loud（与其它配置键同口径）
    assert.throws(
      () => apply(ctx, { enabled: true, storageRoot: root, recallEnabled: true, embeddingBaseUrl: "file:///etc/passwd", embeddingModel: "m" }),
      /http/,
    );
    assert.throws(
      () => apply(ctx, { enabled: true, storageRoot: root, recallEnabled: true, embeddingBaseUrl: "not a url", embeddingModel: "m" }),
      /http/,
    );
    // 「配不全」= 少填 → 降级（本批的唯一语义变更）
    const cfg = resolveConfig({ enabled: true, storageRoot: root, recallEnabled: true });
    assert.equal(cfg.recallEnabled, false);
    assert.ok(cfg.recallDisabledReason);
    // 没开召回 → 不产生诊断（可选功能没启用不是故障，不该有红条）
    const off = resolveConfig({ enabled: true, storageRoot: root });
    assert.equal(off.recallEnabled, false);
    assert.equal(off.recallDisabledReason, undefined, "没开召回不得产生降级诊断（否则每个人都会看到一条红条）");
    assert.equal(off.recallRequested, false);
    // 配齐 → 正常启用，无诊断
    const ok = resolveConfig({
      enabled: true, storageRoot: root, recallEnabled: true,
      embeddingBaseUrl: "http://127.0.0.1:1234/v1/embeddings", embeddingModel: "nomic-embed-text",
    });
    assert.equal(ok.recallEnabled, true);
    assert.equal(ok.recallDisabledReason, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("③ 边界：面板把缺少的键补齐 → entry 侧的缺口不再成立，红条让位（不谎报故障）", async () => {
  const root = freshRoot("settings-rescue");
  try {
    // entry config 故意缺 baseUrl/model（会被降级），但面板里配齐了 → 运行时真的会召回
    writeSettings(root, { embedding: { enabled: true, baseUrl: "http://127.0.0.1:1/v1/embeddings", model: "m" } });
    resetSettingsCache();
    const { ctx, routes } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, recallEnabled: true }); // entry 缺键
    const state = await readState(routes);
    assert.equal(
      state.recallDiagnostics.disabled, null,
      "面板配齐了就不该再报「缺键」——否则用户明明能用却看到一条红条（谎报）",
    );
    assert.equal(state.recallDiagnostics.effectiveEnabled, true, "面板配置生效 → 本轮真的会召回");
    assert.equal(state.recallDiagnostics.source, "settings");

    // effectiveEnabled 不能只是"看着对"：真跑一轮，必须真的发起嵌入调用（与降级用例的 0 次成对照）
    const { ctx: ctx2, handlers } = fakeCtx();
    apply(ctx2, { enabled: true, storageRoot: root, recallEnabled: true });
    createEntry(root, "work-profile", { title: "包管理", content: "团队统一用 pnpm 管理依赖" });
    let fetchCalls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 0, 0] }] }) };
    };
    try {
      const messages = [userMsg("我们 团队 统一 用 pnpm 管理依赖 记住 这件事")];
      const decision = { kind: "enter", messages };
      await handlers.get("agent/pre-step")(
        { agent: makeAgent(root), messages, step: 1, signal: { aborted: false } }, async () => decision,
      );
    } finally {
      globalThis.fetch = original;
    }
    assert.ok(fetchCalls > 0, "面板配齐时召回真的会跑（effectiveEnabled=true 不是空话）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("③ 边界：面板配置也救不了的（injectChannel=section）→ 红条照出，并给出对应补法", async () => {
  const root = freshRoot("channel-unfixable");
  try {
    // 面板把端点/模型配齐了，但注入通道是 section —— pre-step 根本没注册，永不召回
    writeSettings(root, { embedding: { enabled: true, baseUrl: "http://127.0.0.1:1/v1/embeddings", model: "m" } });
    resetSettingsCache();
    const { ctx, routes } = fakeCtx();
    apply(ctx, {
      enabled: true, storageRoot: root, injectChannel: "section", recallEnabled: true,
      embeddingBaseUrl: "http://127.0.0.1:1/v1/embeddings", embeddingModel: "m",
    });
    const state = await readState(routes);
    assert.deepEqual(state.recallDiagnostics.disabled, { missing: [], channelMismatch: true }, "通道问题面板救不了，必须照报");
    assert.equal(state.recallDiagnostics.effectiveEnabled, false);
    const text = L.recallDisabledNoticeText(state.recallDiagnostics);
    assert.ok(text.includes("injectChannel"), "补法必须点名 injectChannel");
    assert.ok(text.includes("cordis.patch.yml"), "通道只能改 yml（面板没有这个开关）——指路必须准确");
    assert.ok(!text.includes("嵌入服务」卡填好"), "纯通道问题不该叫人去填嵌入卡（会白折腾）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("③ 边界：entry 请求了召回但面板开关没开 → 显式 switchOff 红条（不许静默不召回）", async () => {
  const root = freshRoot("settings-off");
  try {
    // 复查两路各自独立抓到的 fail-open：嵌入卡开关预填 false，用户照红条指引填好端点+模型
    // → 旧实现 rescuedBySettings 只看端点/模型 → 红条让位、日志无话、召回静默不工作。
    writeSettings(root, { embedding: { enabled: false, baseUrl: "http://127.0.0.1:1/v1/embeddings", model: "m" } });
    resetSettingsCache();
    const { ctx, routes } = fakeCtx();
    // entry config 配齐了（用户明确要召回），但面板开关没开
    apply(ctx, {
      enabled: true, storageRoot: root, recallEnabled: true,
      embeddingBaseUrl: "http://127.0.0.1:1/v1/embeddings", embeddingModel: "m",
    });
    const state = await readState(routes);
    assert.deepEqual(
      state.recallDiagnostics.disabled,
      { missing: [], channelMismatch: false, switchOff: true },
      "配置齐了但开关没开必须显式报出（这是用户照指引做完后最常卡的点）",
    );
    assert.equal(state.recallDiagnostics.effectiveEnabled, false);
    assert.equal(state.recallDiagnostics.source, "settings", "生效来源如实报（面板据此说明）");
    assert.equal(state.recallDiagnostics.requested, true, "entry 请求标记必须在诊断里（死字段已并入）");
    const text = L.recallDisabledNoticeText(state.recallDiagnostics);
    assert.ok(text.includes("开启语义召回"), "补法必须点名开关（用户下一步唯一要做的事）");
    assert.ok(text.includes("端点与模型已配好"), "必须说明配置已齐（缺的只是开关这一步）");
    assert.ok(!text.includes("缺 embedding"), "键已不缺，不得谎报缺键（红条指向不存在的缺口 = P0）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("③ 边界：面板开关关了且 entry 没请求过召回 → 不是故障，不出红条", async () => {
  const root = freshRoot("settings-off-noentry");
  try {
    // 没开召回的用户（大多数人的默认状态）不被无关红条打扰——只有 entry 请求过召回，
    // 开关没开才算「要了没给」；从没要过的用户看到开关红条纯属打扰。
    writeSettings(root, { embedding: { enabled: false, baseUrl: "http://127.0.0.1:1/v1/embeddings", model: "m" } });
    resetSettingsCache();
    const { ctx, routes } = fakeCtx();
    apply(ctx, {
      enabled: true, storageRoot: root,
      embeddingBaseUrl: "http://127.0.0.1:1/v1/embeddings", embeddingModel: "m",
    });
    const state = await readState(routes);
    assert.equal(state.recallDiagnostics.disabled, null, "没请求过召回 → 无诊断（不出红条打扰）");
    assert.equal(state.recallDiagnostics.effectiveEnabled, false);
    assert.equal(state.recallDiagnostics.requested, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("④ 热恢复：用户补开面板开关 → 不重启即恢复（诊断每轮现算，红条自动让位）", async () => {
  const root = freshRoot("hot-recover");
  try {
    writeSettings(root, { embedding: { enabled: false, baseUrl: "http://127.0.0.1:1/v1/embeddings", model: "m" } });
    resetSettingsCache();
    const { ctx, routes } = fakeCtx();
    apply(ctx, {
      enabled: true, storageRoot: root, recallEnabled: true,
      embeddingBaseUrl: "http://127.0.0.1:1/v1/embeddings", embeddingModel: "m",
    });
    let state = await readState(routes);
    assert.deepEqual(state.recallDiagnostics.disabled, { missing: [], channelMismatch: false, switchOff: true }, "起步：开关没开 → switchOff 红条");
    // 用户在面板打开开关（writeSettings = 面板保存的同一通路），不重启、不重建插件
    writeSettings(root, { embedding: { enabled: true, baseUrl: "http://127.0.0.1:1/v1/embeddings", model: "m" } });
    resetSettingsCache();
    state = await readState(routes);
    assert.equal(state.recallDiagnostics.disabled, null, "补开开关后诊断必须立刻消（诊断每轮按当前生效配置现算）");
    assert.equal(state.recallDiagnostics.effectiveEnabled, true, "下一轮真的会召回");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("③ 旧版宿主容错：/state 无 recallDiagnostics → 双端都不渲染、不炸", () => {
  assert.equal(L.recallDisabledNoticeText(undefined), null);
  assert.equal(L.recallDisabledNoticeText(null), null);
  assert.equal(L.recallDisabledNoticeText({}), null);
  assert.equal(L.recallDisabledNoticeText("x"), null);
  assert.equal(L.recallRuntimeFailureText(undefined), null);
  assert.equal(L.recallRuntimeFailureText({}), null, "零错误不印 0 装饰");
  assert.equal(L.recallRuntimeFailureText({ errors: 0 }), null);
  assert.equal(L.recallRuntimeFailureText({ errors: "x" }), null);
  assert.equal(L.recallRuntimeFailureText({ errors: 2.7 }).includes("失败 2 次"), true, "向下取整");
});

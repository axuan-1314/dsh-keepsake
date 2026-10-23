// extract-route-resilience：提取韧性的三道修复（输出预算/思考档/截断解析、失败不清路由、
// 补提路径从事件复原路由）。全部走真入口：
//   - 1-A/1-B 走 apply() 注册的 session/event 处理器（真 scheduler → 真 extractSession）；
//   - 1-C 走 apply() 注册的 REST 面（POST /sessions/recover → 真 recoverSessionRange →
//     真 createSessionAdapter → 真 extractSession）；
//   - 断言落在最终结果（落盘文件 / journal 行 / 假 llm 收到的真实调用参数），不看中间变量。
//
// 背景（实测，勿重新推导）：本机 extraction-errors.log 309 行里 llm-error 88 条，81 条是
// kind=max-tokens；llm-error → no-route 转移 75/88（失败自删路由导致的级联）；补提路径
// 100% no-route（适配对象不在 sessionStates、收不到 session/event）。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { API_PREFIX } from "../lib/api.js";
import { apply, resolveConfig } from "../lib/index.js";
import { createJournal } from "../lib/journal.js";
import { __resetMetricsForTest, extractionFailureSnapshot } from "../lib/metrics.js";
import { projectMemoryPaths } from "../lib/paths.js";
import { ADAPTER_SESSION_FIELDS, createSessionAdapter, routeFromEvents } from "../lib/session-recovery.js";
import { resetSettingsCache } from "../lib/settings.js";
import { resetFormatCache } from "../lib/format.js";

const silentLog = { info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------- 夹具

/** 假宿主 ctx：事件处理器 + REST 路由 + 假 llm（捕获真实 options）。 */
function fakeCtx(streamImpl, persistence = null) {
  const handlers = new Map();
  const routes = [];
  const streamCalls = [];
  const ctx = {
    logger: silentLog,
    get(name) { return name === "sessionPersistence" ? persistence : void 0; },
    on(type, fn) { handlers.set(type, fn); },
    effect(fn) { try { const r = fn(); if (typeof r === "function") r; } catch { /* disposer 忽略 */ } return () => {}; },
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
    llm: {
      stream(options) {
        streamCalls.push(options);
        return streamImpl(options, streamCalls.length);
      },
    },
  };
  return { ctx, handlers, routes, streamCalls };
}

const USER_EVENT = {
  type: "user/message",
  surfaceOp: "append",
  seq: 0,
  data: { role: "user", content: [{ type: "text", text: "记住 我们 团队 统一 用 pnpm 管理依赖 这件事 很重要" }] },
};
const USER_EVENT_2 = {
  type: "user/message",
  surfaceOp: "append",
  seq: 1,
  data: { role: "user", content: [{ type: "text", text: "还有 发布 前 必须 跑 全量 测试 不许 跳过" }] },
};

/** 假会话（snapshotEvents 与宿主同口径：[from,to) 半开切片）。 */
function fakeSession(id, cwd, events) {
  return {
    id,
    seq: events.length,
    header: { cwd },
    snapshotEvents(from, to) { return events.slice(from, to); },
  };
}

/** 成功终块 + 指定正文的假流（直接返回 async 迭代器，供 agent 侧 for-await）。 */
function okStream(text) {
  return (async function* () {
    yield { type: "text-delta", index: 0, text };
    yield { type: "finish", reason: { kind: "stop" } };
  })();
}

/** 成功终块 + usage chunk 的假流（照宿主真实形态：usage 在 finish 之前发出）。
 *  usage 传 null = 旧适配器/不带用量的流（用来钉"无 usage 只计 calls"口径）。 */
function okStreamWithUsage(text, usage = { inputTokens: 100, outputTokens: 500, totalTokens: 600 }) {
  return (async function* () {
    yield { type: "text-delta", index: 0, text };
    if (usage !== null) yield { type: "usage", usage };
    yield { type: "finish", reason: { kind: "stop" } };
  })();
}

/** 失败终块（structured failure，照真实宿主形态）。 */
function failingStream(failure) {
  return (async function* () {
    yield { type: "finish", reason: { kind: "error", failure } };
  })();
}

/** 截断终块：先给 text，再以 kind=max-tokens 收尾。 */
function truncatedStream(text) {
  return (async function* () {
    if (text.length > 0) yield { type: "text-delta", index: 0, text };
    yield { type: "finish", reason: { kind: "max-tokens" } };
  })();
}

const OK_TEXT = JSON.stringify({
  ops: [{ action: "write", name: "route-works.md", type: "project", title: "Route", description: "路由修复", content: "团队统一用 pnpm" }],
});

/** 轮询等待外部可观测量（不依赖内部变量）。 */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return false;
}

/** 读 journal 全部结算行（不存在则 []）。 */
function journalRuns(root) {
  try {
    return readFileSync(join(root, "extraction-journal.jsonl"), "utf8").trim().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function freshRoots(tag) {
  return {
    root: mkdtempSync(join(tmpdir(), `dsh-keepsake-${tag}-`)),
    workspace: mkdtempSync(join(tmpdir(), `dsh-keepsake-${tag}-ws-`)),
  };
}

function cleanup(...dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

// ================================================================
// 1-A 预算：maxOutputTokens 缺省 0 = 跟随模型（options 里不得出现 maxTokens 键）
// ================================================================

test("1-A 预算：resolveConfig 缺省 maxOutputTokens=0；真调用 options 不含 maxTokens 键", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("budget-default");
  try {
    // 配置面：缺省 0（0 = 跟随模型），显式正数照旧接受
    assert.equal(resolveConfig({}).maxOutputTokens, 0, "缺省必须 0（跟随模型）");
    assert.equal(resolveConfig({ maxOutputTokens: 1234 }).maxOutputTokens, 1234, "显式正数照旧");
    assert.throws(() => resolveConfig({ maxOutputTokens: -1 }), /maxOutputTokens/, "负数非法");

    const { ctx, handlers, streamCalls } = fakeCtx(() => okStream("nothing to save."));
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 5000, extractIdleDelayMs: 0 });
    const session = fakeSession("s-budget", workspace, [USER_EVENT]);
    handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
    handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    await waitFor(() => streamCalls.length > 0);

    assert.equal(streamCalls.length, 1, "应发起一次真实提取调用");
    assert.equal(
      Object.prototype.hasOwnProperty.call(streamCalls[0], "maxTokens"),
      false,
      "0 = 跟随模型：maxTokens 键必须不出现（传 0 会被宿主当成 0 预算）",
    );
  } finally {
    cleanup(root, workspace);
  }
});

test("1-A 预算：显式正数照旧下发 maxTokens（不是一律省略）", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("budget-explicit");
  try {
    const { ctx, handlers, streamCalls } = fakeCtx(() => okStream("nothing to save."));
    apply(ctx, {
      enabled: true, storageRoot: root, provider: "prov", model: "model-x",
      timeoutMs: 5000, extractIdleDelayMs: 0, maxOutputTokens: 777,
    });
    const session = fakeSession("s-budget2", workspace, [USER_EVENT]);
    handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
    handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    await waitFor(() => streamCalls.length > 0);
    assert.equal(streamCalls[0].maxTokens, 777, "显式预算必须原样下发");
  } finally {
    cleanup(root, workspace);
  }
});

// ================================================================
// 1-A 思考档：缺省不下发（options 里不出现 reasoningEffort 键）；
//            显式 high 下发 high；非法值启动即抛
// ================================================================

test("1-A 思考档：缺省不下发；显式 high 下发 high；非法值抛错", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("effort");
  try {
    // 配置面校验（fail loud，带允许值提示）
    assert.equal(resolveConfig({}).extractReasoningEffort, void 0, "缺省必须不下发（不是硬发 low）");
    assert.equal(resolveConfig({ extractReasoningEffort: null }).extractReasoningEffort, void 0, "显式 null = 缺省");
    assert.equal(resolveConfig({ extractReasoningEffort: "high" }).extractReasoningEffort, "high");
    assert.throws(() => resolveConfig({ extractReasoningEffort: "max" }), /extractReasoningEffort.*minimal.*low.*medium.*high/, "非法档位必须抛且提示允许值");

    // 真调用面：缺省 = 键不出现（宿主只对模型声明支持的档位放行，硬发 low 会被
    // UNSUPPORTED_REASONING_EFFORT 拒 → 每次提取白多一次降级往返）
    const runOne = async (id, config) => {
      const { ctx, handlers, streamCalls } = fakeCtx(() => okStream("nothing to save."));
      apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 5000, extractIdleDelayMs: 0, ...config });
      const session = fakeSession(id, workspace, [USER_EVENT]);
      handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
      handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
      await waitFor(() => streamCalls.length > 0);
      return streamCalls[0];
    };
    assert.equal(
      Object.prototype.hasOwnProperty.call(await runOne("s-eff1", {}), "reasoningEffort"),
      false,
      "缺省时 options 不得出现 reasoningEffort 键（不得硬发 low）",
    );
    const explicit = await runOne("s-eff2", { extractReasoningEffort: "high" });
    assert.equal(explicit.reasoningEffort, "high", "显式档位原样下发");
    assert.equal(Object.prototype.hasOwnProperty.call(explicit, "reasoningEffort"), true, "显式档位时键必须在");
  } finally {
    cleanup(root, workspace);
  }
});

// ================================================================
// 1-A max-tokens：先尝试解析已累积内容；成功即落盘 + truncatedParse 记账
// ================================================================

test("1-A 截断解析：kind=max-tokens + 完整 ops JSON → 照常落盘，journal 记 truncatedParse=1 且跨实例重放仍在", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("trunc-ok");
  try {
    // 真实形态：模型先写完 ops JSON，随后继续输出被预算截断（尾段没有闭合花括号）。
    const halfTail = `${OK_TEXT}\n\n另外补充一点关于发布流程的说明，本来还想继续写`;
    const { ctx, handlers, streamCalls } = fakeCtx(() => truncatedStream(halfTail));
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 5000, extractIdleDelayMs: 0 });
    const session = fakeSession("s-trunc-ok", workspace, [USER_EVENT]);
    handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
    handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => journalRuns(root).length > 0), true, "应留下一行结算");

    // 最终结果①：落盘成功（截断不等于失败）
    const memoryDir = projectMemoryPaths(root, workspace).memoryDir;
    assert.equal(existsSync(join(memoryDir, "route-works.md")), true, "截断但可解析 → 必须照常落盘");
    assert.match(readFileSync(join(memoryDir, "route-works.md"), "utf8"), /pnpm/);

    // 最终结果②：journal 行 outcome=written 且带 truncatedParse=1
    const runs = journalRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].outcome, "written");
    assert.equal(runs[0].truncatedParse, 1, "截断仍解析成功必须记账 truncatedParse");

    // 最终结果③：shapeRun 白名单（写盘 → 新建 journal 实例 → 字段仍在；漏白名单即静默丢）
    const fresh = createJournal({ storageRoot: root, log: silentLog });
    const replayed = fresh.snapshot().runs[0];
    assert.equal(replayed.truncatedParse, 1, "重放后 truncatedParse 不得消失（shapeRun 白名单测试）");
  } finally {
    cleanup(root, workspace);
  }
});

test("1-A 截断解析：半截 JSON 解析失败 → parse-error（不静默放过），且不落盘", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("trunc-bad");
  try {
    // 真半截：对象没写完就被截断
    const halfJson = '{"ops":[{"action":"write","name":"never.md","content":"写到一半就被截断';
    const { ctx, handlers } = fakeCtx(() => truncatedStream(halfJson));
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 5000, extractIdleDelayMs: 0 });
    const session = fakeSession("s-trunc-bad", workspace, [USER_EVENT]);
    handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
    handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => journalRuns(root).length > 0), true, "失败也要留结算行");

    const runs = journalRuns(root);
    assert.equal(runs[0].outcome, "failed");
    assert.equal(runs[0].reason, "parse-error", "半截 JSON 必须走 parse-error（预期路径，不许静默成功）");
    assert.equal(extractionFailureSnapshot()["parse-error"], 1);
    const memoryDir = projectMemoryPaths(root, workspace).memoryDir;
    assert.equal(existsSync(join(memoryDir, "never.md")), false, "解析失败不得落盘半截内容");
  } finally {
    cleanup(root, workspace);
  }
});

test("1-A 截断解析：kind=max-tokens 且正文零输出 → 仍是 llm-error（那不是截断，是真失败）", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("trunc-empty");
  try {
    const { ctx, handlers } = fakeCtx(() => truncatedStream(""));
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 5000, extractIdleDelayMs: 0, retryAttempts: 1 });
    const session = fakeSession("s-trunc-empty", workspace, [USER_EVENT]);
    handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
    handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => journalRuns(root).length > 0), true);

    const runs = journalRuns(root);
    assert.equal(runs[0].outcome, "failed");
    assert.equal(runs[0].reason, "llm-error", "零输出 + max-tokens 仍按失败判死（不 fail-open）");
    assert.equal(extractionFailureSnapshot()["llm-error"], 1);
  } finally {
    cleanup(root, workspace);
  }
});

// ================================================================
// 1-A 思考档降级：宿主拒绝 UNSUPPORTED_REASONING_EFFORT 时不得把整次提取判死
// ================================================================

test("1-A 思考档降级：宿主报 UNSUPPORTED_REASONING_EFFORT → 去掉档位重发一次并成功落盘（不静默、不无限重试）", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("effort-unsupported");
  try {
    // 真实宿主行为：模型不支持所请求档位时，在 provider I/O 之前就以该 code 拒绝
    //（@deepseek-ai/dsh-llm resolveCallWithInfo 实测）。这里模拟"带档位就拒、不带就通"。
    let calls = 0;
    const { ctx, handlers, streamCalls } = fakeCtx((options) => {
      calls += 1;
      if (options.reasoningEffort !== void 0) {
        return (async function* () {
          yield { type: "finish", reason: { kind: "error", failure: { code: "UNSUPPORTED_REASONING_EFFORT", message: "model does not support reasoning effort" } } };
        })();
      }
      return okStream(OK_TEXT);
    });
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "non-thinking", timeoutMs: 5000, extractIdleDelayMs: 0, retryAttempts: 1, extractReasoningEffort: "low" });
    const session = fakeSession("s-effort-unsup", workspace, [USER_EVENT]);
    handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
    handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => journalRuns(root).length > 0), true);

    // 最终结果①：整体成功（不是 llm-error）
    const runs = journalRuns(root);
    assert.equal(runs[0].outcome, "written", "档位不被支持时应降级重发，而不是把整次提取判死");
    assert.equal(extractionFailureSnapshot()["llm-error"], 0);

    // 最终结果②：恰好两次调用——第一次带档位、第二次不带（不是无限重试）
    assert.equal(calls, 2, "只应有一次降级重发");
    assert.equal(streamCalls[0].reasoningEffort, "low", "第一趟带档位");
    assert.equal("reasoningEffort" in streamCalls[1], false, "降级重发必须不带档位");

    // 最终结果③：同路由后续轮次不再下发档位（记住能力边界一次即可，别每轮白撞）
    const second = fakeSession("s-effort-unsup-2", workspace, [USER_EVENT]);
    handlers.get("session/event")(second, { type: "session/mounted", seq: 0, data: {} });
    handlers.get("session/event")(second, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => streamCalls.length >= 3), true);
    assert.equal("reasoningEffort" in streamCalls[2], false, "已记入不支持表的同路由不再下发档位");
    assert.equal(calls, 3, "第二轮只应发一次（不再先撞一次）");

    // 最终结果④：降级重发必须计数（/state.extractionFailures.reasoningDegraded）——
    // 只打 log.warn 的话这次额外往返在观测面上完全隐形，无法判断"该不该换档位"。
    // 计数口径：每真实发生一次降级重发 +1；同路由记住能力边界后不再撞，故第二轮不重复计。
    assert.equal(extractionFailureSnapshot().reasoningDegraded, 1, "一次降级重发必须计 1");
  } finally {
    cleanup(root, workspace);
  }
});

// ================================================================
// 1-B 失败不清路由：一次 llm-error 之后，同一会话下一轮仍能拿到路由
// ================================================================

test("1-B 不清槽：llm-error 后同会话下一轮提取仍用 last-good 路由（不产生 no-route）", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("route-keep");
  try {
    const events = [USER_EVENT, USER_EVENT_2];
    // 第 1 轮：不可重试失败（AUTH），1 次 attempt 即摊牌；第 2 轮：成功
    const { ctx, handlers, streamCalls } = fakeCtx((_options, callIndex) => (
      callIndex === 1
        ? failingStream({ code: "AUTH", status: 401, message: "invalid api key" })
        : okStream(OK_TEXT)
    ));
    // 不给 provider/model：纯走会话路由（cfg.provider === undefined 才会走那次清槽）
    apply(ctx, { enabled: true, storageRoot: root, timeoutMs: 5000, extractIdleDelayMs: 0, retryAttempts: 1 });
    const session = fakeSession("s-route-keep", workspace, events);
    handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
    // 路由唯一来源：request/header（不掺 assistant/message.source，确保测的是"没被删槽"）
    handlers.get("session/event")(session, {
      type: "request/header",
      seq: 0,
      data: { header: { config: { provider: "p-main", model: "m-main" } } },
    });

    // 第 1 轮：失败
    session.seq = 1;
    handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => streamCalls.length === 1), true, "第 1 轮应真实发起调用");
    assert.equal(await waitFor(() => journalRuns(root).length >= 1), true, "第 1 轮应留下 failed 结算");
    assert.equal(journalRuns(root)[0].outcome, "failed");

    // 第 2 轮：同会话、无新 request/header —— 旧实现此时已把 route 删掉，必记 no-route
    session.seq = 2;
    handlers.get("session/event")(session, { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => streamCalls.length === 2), true, "第 2 轮必须仍能发起调用（级联 no-route 的回归哨兵）");

    assert.equal(streamCalls[1].provider, "p-main", "第 2 轮应沿用 last-good provider");
    assert.equal(streamCalls[1].model, "m-main", "第 2 轮应沿用 last-good model");
    assert.equal(await waitFor(() => journalRuns(root).length >= 2), true, "第 2 轮应留下第二条结算");
    assert.equal(extractionFailureSnapshot()["no-route"], 0, "失败不得把路由删成 no-route");
    assert.equal(journalRuns(root).at(-1).outcome, "written", "第 2 轮应成功落盘");
  } finally {
    cleanup(root, workspace);
  }
});

test("1-B 自愈仍在：失败后新的 assistant/message.source 能覆盖旧路由（中途换模型）", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("route-heal");
  try {
    const events = [USER_EVENT, USER_EVENT_2];
    const { ctx, handlers, streamCalls } = fakeCtx((_options, callIndex) => (
      callIndex === 1 ? failingStream({ code: "AUTH", status: 401, message: "invalid api key" }) : okStream(OK_TEXT)
    ));
    apply(ctx, { enabled: true, storageRoot: root, timeoutMs: 5000, extractIdleDelayMs: 0, retryAttempts: 1 });
    const session = fakeSession("s-route-heal", workspace, events);
    handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
    // desktop 路径：只有 source 兜底（没有 request/header）
    handlers.get("session/event")(session, {
      type: "assistant/message",
      seq: 0,
      data: { message: { source: { kind: "model", provider: "p-old", model: "m-old" } } },
    });

    session.seq = 1;
    handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => streamCalls.length === 1), true);
    assert.equal(streamCalls[0].provider, "p-old");
    // 必须先等第 1 轮真失败（routeStale 是失败时打的标记）——否则测不到"失败后自愈"
    assert.equal(await waitFor(() => journalRuns(root).length >= 1), true);

    // 失败之后用户换了模型：下一条 assistant/message 的 source 是新模型
    handlers.get("session/event")(session, {
      type: "assistant/message",
      seq: 1,
      data: { message: { source: { kind: "model", provider: "p-new", model: "m-new" } } },
    });
    session.seq = 2;
    handlers.get("session/event")(session, { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => streamCalls.length === 2), true);
    assert.equal(streamCalls[1].provider, "p-new", "失败后新 source 必须能顶替旧路由（换模型自愈）");
    assert.equal(streamCalls[1].model, "m-new");
    assert.equal(await waitFor(() => journalRuns(root).length >= 2), true, "第 2 轮应留下第二条结算");
  } finally {
    cleanup(root, workspace);
  }
});

// ================================================================
// 1-C 补提路由：读回事件里的 provider/model 能喂到真提取调用
// ================================================================

/** 假会话持久化（形状对齐宿主 ctx.sessionPersistence：open/stat/list）。 */
function fakePersistence({ sessions, headerOf }) {
  return {
    stat(id) { return sessions.has(id) ? headerOf(id) : null; },
    list() { return [...sessions.keys()]; },
    async open(id, mode) {
      assert.equal(mode, "read");
      const events = sessions.get(id) ?? [];
      return { header: headerOf(id), read(offset, length) { return { events: events.slice(offset, offset + length) }; }, close() {} };
    },
  };
}

function mockReq({ method, url, body }) {
  const req = new Readable({
    read() {
      if (body !== void 0) this.push(JSON.stringify(body));
      this.push(null);
    },
  });
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

test("1-C routeFromEvents：request/header 优先于 assistant/message.source；两者皆无 → undefined", () => {
  assert.equal(routeFromEvents([]), void 0);
  assert.equal(routeFromEvents([USER_EVENT]), void 0, "无路由事件不猜");
  // 只有 source
  assert.deepEqual(
    routeFromEvents([{ type: "assistant/message", data: { message: { source: { provider: "sp", model: "sm" } } } }]),
    { provider: "sp", model: "sm" },
  );
  // 两者都有：header 权威（即使 source 在更后面）
  assert.deepEqual(
    routeFromEvents([
      { type: "request/header", data: { header: { config: { provider: "hp", model: "hm" } } } },
      { type: "assistant/message", data: { message: { source: { provider: "sp", model: "sm" } } } },
    ]),
    { provider: "hp", model: "hm" },
  );
  // 同一来源多条：取最后一条（区间跨模型切换，最后一条才是实际用车）
  assert.deepEqual(
    routeFromEvents([
      { type: "request/header", data: { header: { config: { provider: "hp1", model: "hm1" } } } },
      { type: "request/header", data: { header: { config: { provider: "hp2", model: "hm2" } } } },
    ]),
    { provider: "hp2", model: "hm2" },
  );
  // 半截配置（缺 model）不算路由
  assert.equal(routeFromEvents([{ type: "request/header", data: { header: { config: { provider: "hp" } } } }]), void 0);
});

test("1-C 补提路由：读回事件带 request/header → 补提发起真实调用且不是 no-route", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root } = freshRoots("recover-route");
  try {
    const sessionId = "sess-recover-route";
    const events = [
      { type: "request/header", seq: 0, data: { header: { config: { provider: "rec-prov", model: "rec-model" } } } },
      { ...USER_EVENT, seq: 1 },
      { type: "assistant/message", seq: 2, surfaceOp: "append", data: { message: { content: [{ type: "text", text: "好的，记下了" }] } } },
    ];
    // 盘上先有一条未恢复区间（补提的入口条件）
    const seed = createJournal({ storageRoot: root, log: silentLog });
    await seed.recordRun({ sessionId, from: 0, to: 3, cursorAfter: 0, outcome: "failed", reason: "llm-error" });

    const { ctx, routes, streamCalls } = fakeCtx(() => okStream(OK_TEXT), fakePersistence({ sessions: new Map([[sessionId, events]]), headerOf: () => ({ cwd: root }) }));
    apply(ctx, { enabled: true, storageRoot: root, injectChannel: "section", extractIdleDelayMs: 0, timeoutMs: 5000 });
    const apiRoute = routes.find((r) => r.kind === "prefix" && r.path === API_PREFIX.replace(/\/$/, ""));
    assert.ok(apiRoute, "apply 应注册 API 路由");

    const call = async (method, path, body) => {
      const res = mockRes();
      await apiRoute.handler(mockReq({ method, url: API_PREFIX + path, body }), res);
      return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
    };
    const rec = await call("POST", "sessions/recover", { sessionId, from: 0, to: 3 });
    assert.equal(rec.status, 202);

    // 等后台补提收口（观测面：recover.lastOutcome 不再是 running）
    const settled = await waitFor(() => journalRuns(root).some((r) => r.outcome === "written"), 8000);
    assert.equal(settled, true, `补提应成功落盘（当前结算：${JSON.stringify(journalRuns(root))}）`);

    // 最终结果①：真实调用了 llm，且用的是从事件里复原的路由
    assert.equal(streamCalls.length, 1, "补提应发起一次真实提取调用");
    assert.equal(streamCalls[0].provider, "rec-prov", "补提路由必须来自读回的 request/header（不是 no-route）");
    assert.equal(streamCalls[0].model, "rec-model");

    // 最终结果②：没有任何 no-route 记账
    assert.equal(extractionFailureSnapshot()["no-route"], 0, "补提路径不得再记 no-route");
    const errorsPath = join(root, "extraction-errors.log");
    if (existsSync(errorsPath)) {
      assert.doesNotMatch(readFileSync(errorsPath, "utf8"), /no-route/, "失败日志里不得出现 no-route");
    }
    // 最终结果③：journal 最新一行是 written 且区间出列
    const fresh = createJournal({ storageRoot: root, log: silentLog });
    assert.equal(fresh.snapshot().runs[0].outcome, "written");
    assert.equal(fresh.snapshot().unrecovered.length, 0, "补提成功应使未恢复区间出列");
  } finally {
    cleanup(root);
  }
});

// ================================================================
// 世界观守卫：补提适配对象只暴露约定字段（recoveredRoute 是新增的那一个）
// ================================================================

test("1-C 适配对象：recoveredRoute 在不进 sessionStates 的前提下随事件可见", async () => {
  const events = [{ type: "request/header", data: { header: { config: { provider: "x", model: "y" } } } }];
  const adapter = await createSessionAdapter(null, "s-adapter", { events, cwd: "/ws", log: silentLog });
  for (const field of ADAPTER_SESSION_FIELDS) assert.ok(field in adapter, `缺字段 ${field}`);
  assert.deepEqual(adapter.recoveredRoute, { provider: "x", model: "y" });
  assert.deepEqual(adapter.source.recoveredRoute, { provider: "x", model: "y" }, "观测面同值");
    // 无路由事件 → 键在但值为 undefined（不伪造）
    const bare = await createSessionAdapter(null, "s-bare", { events: [USER_EVENT], cwd: "/ws", log: silentLog });
    assert.equal("recoveredRoute" in bare, true);
    assert.equal(bare.recoveredRoute, void 0);
    assert.equal(bare.source.recoveredRoute, null);
});

// ================================================================
// 1-D token/成本观测：usage chunk 必须被接住，进 /state.extractionFailures.extractionTokens
//
// 背景：maxOutputTokens 缺省改 0 = 跟随模型（本机 mozu1 默认 250000，约 61 倍）后，
// 单次输出上限放大 61 倍这件事必须看得见——而 callLlmText 此前只认 text-delta/finish，
// 宿主的 usage chunk 被直接丢弃，成本放大在观测面上完全隐形。
// 断言全走真 apply() 入口 + 真 /state REST 面（不碰内部变量）。
// ================================================================

test("1-D usage：假 llm 发 usage chunk → /state.extractionFailures.extractionTokens 如实记账", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("usage-basic");
  try {
    const { ctx, handlers, routes } = fakeCtx(() => okStreamWithUsage(OK_TEXT));
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 5000, extractIdleDelayMs: 0 });
    const session = fakeSession("s-usage", workspace, [USER_EVENT]);
    handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
    handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => journalRuns(root).length > 0), true);

    // 经真 REST 面读 /state（面板与门牌的同一数据源）
    const apiRoute = routes.find((r) => r.kind === "prefix" && r.path === API_PREFIX.replace(/\/$/, ""));
    const call = async (method, path) => {
      const res = mockRes();
      await apiRoute.handler(mockReq({ method, url: API_PREFIX + path }), res);
      return res.body ? JSON.parse(res.body) : null;
    };
    const state = await call("GET", "state");
    assert.deepEqual(
      state.extractionFailures.extractionTokens,
      { input: 100, output: 500, total: 600, calls: 1 },
      "usage chunk 必须被接住并如实进 /state（丢 chunk = 成本放大完全看不见）",
    );
  } finally {
    cleanup(root, workspace);
  }
});

test("1-D usage：两次真实调用 → calls=2 且三项累加（含降档重发第二趟也计）", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("usage-twice");
  try {
    // 第 1 轮带 usage，第 2 轮带另一组 usage：calls 与 token 都要累加
    let n = 0;
    const { ctx, handlers, routes } = fakeCtx(() => {
      n += 1;
      return okStreamWithUsage(OK_TEXT, n === 1
        ? { inputTokens: 100, outputTokens: 500, totalTokens: 600 }
        : { inputTokens: 200, outputTokens: 1000, totalTokens: 1200 });
    });
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 5000, extractIdleDelayMs: 0 });
    const session = fakeSession("s-usage2", workspace, [USER_EVENT, USER_EVENT_2]);
    handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
    session.seq = 1;
    handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => journalRuns(root).length >= 1), true);
    session.seq = 2;
    handlers.get("session/event")(session, { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => journalRuns(root).length >= 2), true);

    const apiRoute = routes.find((r) => r.kind === "prefix" && r.path === API_PREFIX.replace(/\/$/, ""));
    const res = mockRes();
    await apiRoute.handler(mockReq({ method: "GET", url: API_PREFIX + "state" }), res);
    assert.deepEqual(JSON.parse(res.body).extractionFailures.extractionTokens, {
      input: 300, output: 1500, total: 1800, calls: 2,
    });
  } finally {
    cleanup(root, workspace);
  }
});

test("1-D usage：降档重发第二趟也计 calls（两趟都发过 usage 就两笔都累计）", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("usage-degraded");
  try {
    // 宿主先以 UNSUPPORTED_REASONING_EFFORT 拒（该趟也发 usage），重发成功（也发 usage）
    const { ctx, handlers, routes } = fakeCtx((options) => (options.reasoningEffort !== void 0
      ? (async function* () {
          yield { type: "usage", usage: { inputTokens: 50, outputTokens: 200, totalTokens: 250 } };
          yield { type: "finish", reason: { kind: "error", failure: { code: "UNSUPPORTED_REASONING_EFFORT", message: "unsupported" } } };
        })()
      : okStreamWithUsage(OK_TEXT)));
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "non-thinking", timeoutMs: 5000, extractIdleDelayMs: 0, retryAttempts: 1, extractReasoningEffort: "low" });
    const session = fakeSession("s-usage-deg", workspace, [USER_EVENT]);
    handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
    handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => journalRuns(root).length > 0), true);

    const apiRoute = routes.find((r) => r.kind === "prefix" && r.path === API_PREFIX.replace(/\/$/, ""));
    const res = mockRes();
    await apiRoute.handler(mockReq({ method: "GET", url: API_PREFIX + "state" }), res);
    const tokens = JSON.parse(res.body).extractionFailures.extractionTokens;
    // 降档那一趟白撞的成本必须记账：否则"每次提取都在多烧一次"在 /state 上仍不可见
    assert.deepEqual(tokens, { input: 150, output: 700, total: 850, calls: 2 }, "两趟（含被拒的降档趟）都要计 calls 与 token");
  } finally {
    cleanup(root, workspace);
  }
});

test("1-D usage：旧适配器不带 usage chunk → 不抛错且 calls 仍计数（token 记 0）", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("usage-missing");
  try {
    // 不 yield usage chunk（旧适配器/简化假流）：调用必须照常成功，calls 仍计 1
    const { ctx, handlers, routes } = fakeCtx(() => okStreamWithUsage(OK_TEXT, null));
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 5000, extractIdleDelayMs: 0 });
    const session = fakeSession("s-usage-missing", workspace, [USER_EVENT]);
    handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
    handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => journalRuns(root).length > 0), true);
    assert.equal(journalRuns(root)[0].outcome, "written", "无 usage chunk 不得影响提取本身");

    const apiRoute = routes.find((r) => r.kind === "prefix" && r.path === API_PREFIX.replace(/\/$/, ""));
    const res = mockRes();
    await apiRoute.handler(mockReq({ method: "GET", url: API_PREFIX + "state" }), res);
    // 口径：拿不到用量 ≠ 没调用。"调了几次"与"花了多少 token"分开报，token 记 0 不编造
    assert.deepEqual(JSON.parse(res.body).extractionFailures.extractionTokens, { input: 0, output: 0, total: 0, calls: 1 });
  } finally {
    cleanup(root, workspace);
  }
});

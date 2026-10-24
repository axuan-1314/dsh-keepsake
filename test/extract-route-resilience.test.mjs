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
import { __resetMetricsForTest, extractionFailureSnapshot, extractionObservationSnapshot } from "../lib/metrics.js";
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
// 1-A 零正文逃逸：预算耗尽且正文零输出时，先丢显式上限重发一次（不是一次判死）
//   实测机制（本机 magpie/group/mozu1 → 网关 127.0.0.1:3425）：思考 token 与正文
//   共享同一 maxTokens 预算、思考链先跑；max_tokens=64 时 reasoning 258 字符 /
//   content 0 字符；不传 reasoning_effort 也照样思考（档位不是思考开关）。
//   故唯一真正改变结果的手段是"改预算"：显式配了小上限 → 丢掉它改跟随模型重发。
// ================================================================

test("1-A 零正文逃逸：显式 maxOutputTokens + 两次零正文预算 → 丢上限重发后成功落盘（escapeRetried=1）", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("budget-escape");
  try {
    const seen = [];
    const { ctx, handlers, streamCalls } = fakeCtx((options) => {
      seen.push(options);
      // 真实形态：下发了 maxTokens（小上限）→ 思考吃光、正文零输出；
      // 不下发 maxTokens（跟随模型）→ 正文正常产出。
      if (Object.prototype.hasOwnProperty.call(options, "maxTokens")) {
        return (async function* () {
          yield { type: "finish", reason: { kind: "max-tokens" } };
        })();
      }
      return okStream(OK_TEXT);
    });
    apply(ctx, {
      enabled: true, storageRoot: root, provider: "prov", model: "model-x",
      timeoutMs: 5000, extractIdleDelayMs: 0, retryAttempts: 1, maxOutputTokens: 4096,
    });
    const session = fakeSession("s-budget-escape", workspace, [USER_EVENT]);
    handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
    handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => journalRuns(root).length > 0), true, "应留下一行结算");

    // 最终结果①：真发起了第二趟，且第二趟不再带 maxTokens（这是"丢上限"的唯一证据）
    assert.equal(seen.length, 2, "零正文必须先逃逸重发一次（不是一次判死）");
    assert.equal(hasOwnProperty.call(seen[0], "maxTokens"), true, "第一趟必须带上配置的显式上限");
    assert.equal(hasOwnProperty.call(seen[1], "maxTokens"), false, "逃逸那趟必须不再下发 maxTokens（改跟随模型）");

    // 最终结果②：救回来了 → 照常落盘、journal outcome=written
    const memoryDir = projectMemoryPaths(root, workspace).memoryDir;
    assert.equal(existsSync(join(memoryDir, "route-works.md")), true, "逃逸成功即照常落盘");
    const runs = journalRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].outcome, "written");

    // 最终结果③：观测面记下这次逃逸（/state 看得见，不是静默）
    assert.equal(extractionFailureSnapshot().escapeRetried, 1, "逃逸必须在 /state 计数");
    assert.equal(extractionFailureSnapshot()["llm-error"], 0, "救回来的轮次不得记 llm-error");
  } finally {
    cleanup(root, workspace);
  }
});

test("1-A 零正文逃逸：跟随模型（缺省未下发 maxTokens）且仍零正文 → 不逃逸、不重试、落 llm-error（成本纪律）", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("budget-escape-noop");
  try {
    const seen = [];
    const { ctx, handlers } = fakeCtx((options) => {
      seen.push(options);
      return (async function* () {
        yield { type: "finish", reason: { kind: "max-tokens" } };
      })();
    });
    // maxOutputTokens 缺省 0 = 跟随模型：本来就没下发上限，"丢上限"无从谈起。
    // retryAttempts=3（默认档）：零正文**不在可重试族**——跟随模型仍零正文在实践中不可达，
    // 为它开链级重采样最坏是 attempts × fallback 条数次满预算调用（复查 P0：成本纪律）。
    // 变异（把自造 code 加回 RETRYABLE_FAILURE_CODES）→ 本用例会变成 3 次调用，必红。
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 5000, extractIdleDelayMs: 0, retryAttempts: 3 });
    const session = fakeSession("s-budget-escape-noop", workspace, [USER_EVENT]);
    handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
    handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => journalRuns(root).length > 0), true);

    // 只跑一趟：没有可丢的上限，也不许进重试链凭空多打满预算调用
    assert.equal(seen.length, 1, "缺省跟随模型时零正文不逃逸、不重试（一次显式判死，不烧预算）");
    const runs = journalRuns(root);
    assert.equal(runs[0].outcome, "failed");
    assert.equal(runs[0].reason, "llm-error", "真失败仍显式判死，不静默当成功");
    assert.equal(extractionFailureSnapshot().escapeRetried, 0, "未发生逃逸不得计数");
  } finally {
    cleanup(root, workspace);
  }
});

test("1-A 零正文逃逸：逃逸那趟仍零正文 → 恰好两趟后 llm-error，且 escapeRetried 不计数（结果口径：发起≠成功）", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("budget-escape-fail");
  try {
    let calls = 0;
    const { ctx, handlers } = fakeCtx(() => {
      calls += 1;
      return (async function* () {
        yield { type: "finish", reason: { kind: "max-tokens" } };
      })();
    });
    apply(ctx, {
      enabled: true, storageRoot: root, provider: "prov", model: "model-x",
      timeoutMs: 5000, extractIdleDelayMs: 0, retryAttempts: 1, maxOutputTokens: 4096,
    });
    const session = fakeSession("s-budget-escape-fail", workspace, [USER_EVENT]);
    handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
    handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => journalRuns(root).length > 0), true);

    // 恰好两趟：一趟带上限、一趟逃逸；第二次零正文后不再循环（pass 上限 + 逃逸标志）
    assert.equal(calls, 2, "逃逸只许一次，绝不允许无限重试");
    const runs = journalRuns(root);
    assert.equal(runs[0].outcome, "failed");
    assert.equal(runs[0].reason, "llm-error", "两次都零正文 → 如实 llm-error（不 fail-open）");
    // 逃逸重发**没拿到正文**就不许计数：escapeRetried 的口径是"重发成功 N 次"
    //（面板文案如实说"重发成功"）。发起处计数会让健康卡在逃逸失败时同时显示
    // "提取失败"与"重发成功"——复查抓到的「意图当结果」同型错误。
    assert.equal(extractionFailureSnapshot().escapeRetried, 0, "逃逸重发失败不计数（结果口径，发起不计）");
  } finally {
    cleanup(root, workspace);
  }
});

// ================================================================
// 在途中止分类：超时 → TIMEOUT（可重试族）；dispose → aborted（不进 llm-error）
// 本机实际环境 extraction-errors.log 13:28/13:37 两条 `llm-error … ABORTED` 的形状：
// 120s 计时器把在途提取 abort 掉，宿主把它映射成 ABORTED（不在可重试族）→ 一次判死。
// ================================================================

test("1-E 在途超时：计时器 abort → 按执行结果挂 TIMEOUT（可重试族，链上退避重采样），不再一次判死", async () => {
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root, workspace } = freshRoots("inflight-timeout");
  try {
    // 模拟宿主：signal 被 abort 后才收口并抛 ABORTED 形状的错误（本机实际环境实测形状）
    const { ctx, handlers } = fakeCtx((options) => (async function* () {
      const signal = options.signal;
      while (!signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
      const e = new Error("ABORTED");
      e.failure = { code: "ABORTED" };
      throw e;
    })());
    apply(ctx, {
      enabled: true, storageRoot: root, provider: "prov", model: "model-x",
      timeoutMs: 60, extractIdleDelayMs: 0, retryAttempts: 2, retryBackoffMs: 10, retryMaxDelayMs: 20,
    });
    const session = fakeSession("s-inflight-timeout", workspace, [USER_EVENT]);
    handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
    handlers.get("session/event")(session, { type: "turn/end", seq: 0, data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal(await waitFor(() => journalRuns(root).length > 0, 10000), true);

    // 超时属 TIMEOUT（可重试族）→ 链上真实重采样：retried 必须真实发生。
    // 变异（摘掉 callLlmText 的 TIMEOUT 补挂）→ ABORTED 不在可重试族 → 1 次判死 → retried=0，必红。
    assert.ok(extractionFailureSnapshot().retried >= 1, "在途超时必须走可重试族真实重采样（不再一次判死）");
    const runs = journalRuns(root);
    assert.equal(runs[0].outcome, "failed");
    assert.equal(runs[0].reason, "llm-error", "重试用尽后仍如实落 llm-error");
    // 用户面文案必须说清是超时（code=TIMEOUT 进 reason 摘要），不得露 ABORTED 谜团
    const snap = extractionFailureSnapshot();
    const last = Array.isArray(snap.recent) && snap.recent[0] ? String(snap.recent[0].message ?? "") : "";
    assert.ok(last.includes("TIMEOUT"), `失败摘要应带 TIMEOUT 分类（实际：${last}）`);
  } finally {
    cleanup(root, workspace);
  }
});

test("1-E dispose 在途：卸载打断在途 attempt → 按 aborted 收场，不进 llm-error 桶、不推失败连击", async () => {
  // 为什么走补提路径：scheduler.dispose 会先有界 drain 在途在线提取（预算=min(60s,timeoutMs)），
  // 然后才 lifetime.abort——在线路径的 abort 永远落在「两次 attempt 之间」（那里本就有
  // pre-check 兜着），端到端根本到不了「attempt 中途被打断」这个分支（本轮实测两版假流
  // 都是死路）。补提不经 scheduler：dispose 的 scheduler 段空转立即返回，lifetime.abort
  // 直落进在途 attempt——本机实际环境 13:28（重启时在途提取被打断）正是这个形状。
  resetSettingsCache(); resetFormatCache(); __resetMetricsForTest();
  const { root } = freshRoots("dispose-inflight");
  try {
    const sessionId = "sess-dispose-inflight";
    const events = [
      { type: "request/header", seq: 0, data: { header: { config: { provider: "rec-prov", model: "rec-model" } } } },
      { ...USER_EVENT, seq: 1 },
    ];
    const seed = createJournal({ storageRoot: root, log: silentLog });
    await seed.recordRun({ sessionId, from: 0, to: 2, cursorAfter: 0, outcome: "failed", reason: "llm-error" });

    // 自组 ctx：effects 捕获（拿 lifecycle disposer）+ 假持久化（喂补提读回）+ 假 llm
    const persistence = fakePersistence({ sessions: new Map([[sessionId, events]]), headerOf: () => ({ cwd: root }) });
    const effects = [];
    const handlers = new Map();
    const routes = [];
    const ctx = {
      logger: silentLog,
      get(name) { return name === "sessionPersistence" ? persistence : void 0; },
      on(type, fn) { handlers.set(type, fn); },
      effect(fn, label) { effects.push({ fn, label }); },
      inject(_deps, setup) {
        const pending = [];
        const sctx = { effect(fn) { pending.push(fn); }, webServer: { register(route) { routes.push(route); return () => {}; } } };
        setup(sctx);
        for (const fn of pending) fn();
      },
      systemPrompt: { section() { return () => {}; } },
      llm: {
        stream(options) {
          // 挂起直到 signal 被 abort（模拟宿主流被取消），abort 后抛宿主形状的 ABORTED。
          // 不能用"永不 yield 的死流"——它对 abort 无动于衷，extractSession 永远挂在
          // for-await 上，dispose 路径根本走不到，测试会静默退化成假绿（本轮实测）。
          return (async function* () {
            const signal = options.signal;
            if (!signal?.aborted) {
              await new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            }
            const e = new Error("ABORTED");
            e.failure = { code: "ABORTED" };
            throw e;
          })();
        },
      },
    };
    apply(ctx, {
      enabled: true, storageRoot: root, injectChannel: "section", extractIdleDelayMs: 0,
      timeoutMs: 60000, retryAttempts: 3,
    });
    const apiRoute = routes.find((r) => r.kind === "prefix" && r.path === API_PREFIX.replace(/\/$/, ""));
    const call = async (method, path, body) => {
      const res = mockRes();
      await apiRoute.handler(mockReq({ method, url: API_PREFIX + path, body }), res);
      return { status: res.status };
    };
    const rec = await call("POST", "sessions/recover", { sessionId, from: 0, to: 2 });
    assert.equal(rec.status, 202);
    await waitFor(() => extractionObservationSnapshot().extractionInFlight === true, 5000);
    const snap0 = extractionFailureSnapshot();

    // 卸载：scheduler 段无在线会话空转返回 → lifetime.abort → 补提在途 attempt 被打断
    const disposeFns = effects.filter((e) => e.label === "dsh-keepsake lifecycle").map((e) => e.fn());
    for (const dispose of disposeFns) await dispose();
    await waitFor(() => extractionObservationSnapshot().extractionInFlight === false, 8000);

    // dispose 打断的在途 attempt：不算 LLM 失败（不进 llm-error 桶）。
    // 变异（摘掉 runAttemptChain 的 dispose 检查）→ 宿主形状的 ABORTED 落 llm-error → 必红。
    const snap = extractionFailureSnapshot();
    assert.equal(snap["llm-error"], snap0["llm-error"], "dispose 在途不得记 llm-error（是我们在卸载，不是模型失败）");
    const runs = journalRuns(root);
    const last = runs[runs.length - 1];
    assert.ok(last, "补提结算必须留痕");
    assert.notEqual(last.reason, "llm-error", "journal 也不得把 dispose 打断记成 LLM 失败");
  } finally {
    cleanup(root);
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

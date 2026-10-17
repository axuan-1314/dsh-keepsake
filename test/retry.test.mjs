// 提取调用重试韧性：错误分类（route on code）/ 重试链+drain 纪律/
// 退避参数与纯函数 / retried·lastRecoveredAt 计数 / fallback 换道接线。
// 假 ctx 配方照 test/entry.test.mjs；DATA_DIR 隔离照各测试的 mkdtempSync(tmpdir())，
// 不写 ~/.dsh 真实数据、不真实调用任何 LLM（stream 全假队列）。
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apply, resolveConfig } from "../lib/index.js";
import {
  __resetMetricsForTest,
  bumpRetryAttempt,
  extractionFailureSnapshot,
  isRetryableFailure,
  noteExtractionRecovered,
  retryDelayMs,
} from "../lib/metrics.js";
import { projectMemoryPaths } from "../lib/paths.js";
import { INDEX_FILENAME } from "../lib/filename.js";
import { resetSettingsCache, writeSettings } from "../lib/settings.js";
import { FORMAT_FILENAME, resetFormatCache } from "../lib/format.js";
import { JOURNAL_FILE_NAME } from "../lib/journal.js";

const USER_EVENT = {
  type: "user/message",
  surfaceOp: "append",
  seq: 0,
  data: { role: "user", content: [{ type: "text", text: "记住 我们 团队 统一 用 pnpm" }] },
};

/** MAX_TIMER_DELAY_MS 同值（index.js 未导出该常量，矩阵边界用同一字面值钉）。 */
const MAX_TIMER_DELAY_MS = 2147483647;

function fakeCtx(streamImpl) {
  const handlers = new Map();
  const sections = [];
  const streamCalls = [];
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(type, fn) {
      handlers.set(type, fn);
    },
    effect(fn, label) {
      effects.push({ fn, label });
      fn();
    },
    inject(_deps, setup) {
      const pending = [];
      const sctx = {
        effect(fn) {
          pending.push(fn);
        },
        webServer: {
          register() {
            return () => {};
          },
        },
      };
      setup(sctx);
      for (const fn of pending) fn();
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    llm: {
      stream(options) {
        streamCalls.push(options);
        return streamImpl(options, streamCalls.length);
      },
    },
  };
  return { ctx, handlers, sections, streamCalls, effects };
}

function fakeSession(cwd, events) {
  return {
    id: "s-test",
    seq: events.length,
    header: { cwd },
    snapshotEvents(from, to) {
      return events.slice(from, to);
    },
  };
}

/**
 * 触发一次提取并等待 settle。
 * @param streamImpl (options, callIndex1Based) => 异步可迭代（假流）
 * @param waitFor () => boolean 完成判据（默认：首个 attempt 已发起）
 *   注意：waitFor 在 runExtraction 内部同步轮询，引用其返回前未初始化的
 *   streamCalls 会 TDZ 抛错——完成判据一律只依赖 existsSync(target) 等外部可观测量。
 */
async function runExtraction({ root, workspace, streamImpl, config = {}, waitFor, timeoutMs = 15000 }) {
  const { ctx, handlers, streamCalls } = fakeCtx(streamImpl);
  // extractIdleDelayMs: 0 — 本文件非延迟用例（立即提取，防 3s 默认拖慢/抖动）
  apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 5000, extractIdleDelayMs: 0, ...config });
  const session = fakeSession(workspace, [USER_EVENT]);
  handlers.get("session/event")(session, USER_EVENT);
  handlers.get("session/event")(session, { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
  const done = waitFor ?? (() => streamCalls.length > 0);
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { ctx, handlers, streamCalls, session };
}

/**
 * 多轮触发（同一 ctx/同一 session）：streak 类分叉（no-cwd/no-route 的
 * "连续 5 次放弃"）需要同一进程内连续多次结算才能走到，单轮 harness 表达不了。
 * @param rounds 每轮 { seq, events?, cwd? } —— seq 是宿主侧 seq 快照，
 *   events 是该轮 snapshotEvents 返回的增量（逐轮给，别让后轮拿到空增量——
 *   空增量会先被 skipReason 拦成 no-user-prose，测不到目标分支）。
 */
async function runRounds({ root, workspace, streamImpl, config = {}, rounds, sessionId = "s-test", settleMs = 60, noRoute = false }) {
  const { ctx, handlers, streamCalls, effects } = fakeCtx(streamImpl);
  apply(ctx, { enabled: true, storageRoot: root, provider: noRoute ? void 0 : "prov", model: noRoute ? void 0 : "model-x", timeoutMs: 5000, extractIdleDelayMs: 0, ...config });
  const session = {
    id: sessionId,
    seq: 0,
    header: { cwd: workspace },
    snapshotEvents(from, to) {
      // 逐轮取该轮声明的 events；宿主真实语义是 [from, to) 切片，这里按轮次整体给
      return roundEvents(rounds, from, to);
    },
  };
  // 种子事件（seq 0）：让 see() 以"小 seq 新会话"建立 cursor=0，后续 turn/end 边界才能
  // 覆盖到全部 events（否则首见即 seq>1 会被判成恢复会话、cursor=seq+1 直接跳过本轮区间）。
  handlers.get("session/event")(session, { type: "session/mounted", seq: 0, data: {} });
  for (const round of rounds) {
    session.seq = round.seq;
    if (round.cwd !== void 0) session.header.cwd = round.cwd;
    handlers.get("session/event")(session, { type: "turn/end", seq: round.seq - 1, data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
  return { ctx, handlers, streamCalls, session, effects };
}

/** 按轮次声明的 events 拼出 [from,to) 切片（真实宿主是全量事件流切片，此处逐轮等价）。 */
function roundEvents(rounds, from, to) {
  const all = rounds.flatMap((r) => r.events ?? [USER_EVENT]);
  return all.slice(from, to);
}

/**
 * 两会话交错多轮 harness：同一 ctx/同一 storageRoot 下驱动两个 session 对象，
 * 用于验证 streak 按会话分键（别会话的失败不把本会话顶到放弃线）。
 * @param plan [{ sessionId, seq }] 逐条触发，seq 是该轮 turn/end 边界（宿主快照 seq）
 */
async function runTwoSessions({ root, plan, settleMs = 60 }) {
  const { ctx, handlers, effects } = fakeCtx(() => { throw new Error("两会话 streak 用例不应发起 LLM 调用"); });
  apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 5000, extractIdleDelayMs: 0 });
  const sessions = new Map();
  const getSession = (id) => {
    let s = sessions.get(id);
    if (s === void 0) {
      s = {
        id,
        seq: 0,
        header: { cwd: "" }, // 全程无 cwd → 每轮 no-cwd 失败
        snapshotEvents(from, to) { return [USER_EVENT].slice(from, to); },
      };
      sessions.set(id, s);
      handlers.get("session/event")(s, { type: "session/mounted", seq: 0, data: {} });
    }
    return s;
  };
  for (const step of plan) {
    const session = getSession(step.sessionId);
    session.seq = step.seq;
    handlers.get("session/event")(session, { type: "turn/end", seq: step.seq - 1, data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
  return { ctx, handlers, effects, sessions };
}

/** 读 journal 全部结算行（不存在则 []）。 */
function journalRuns(root) {
  try {
    return readFileSync(join(root, JOURNAL_FILE_NAME), "utf8").trim().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

const OK_TEXT = '{"ops":[{"action":"write","name":"retry-works.md","type":"project","title":"Retry","description":"重试成功","content":"团队统一用 pnpm"}]}';

/** 失败终块的假流生成器（kind=error + structured failure，照真实宿主形态）。 */
function failingStream(failure) {
  return async function* () {
    yield { type: "finish", reason: { kind: "error", failure } };
  };
}

/** 成功终块的假流生成器。 */
function okStream(text = OK_TEXT) {
  return async function* () {
    yield { type: "text-delta", index: 0, text };
    yield { type: "finish", reason: { kind: "stop" } };
  };
}

/** 按队列消费的假流：第 n 次调用用 results[n-1] 对应的流，越界调用抛错（便于断言调用次数）。 */
function queuedStream(results) {
  return (options, callIndex) => {
    const entry = results[callIndex - 1];
    if (entry === void 0) throw new Error(`假流队列越界：第 ${callIndex} 次调用不应发生`);
    return entry();
  };
}

/** 全败链的 settle 判据：没有落盘目标可等，用固定 tick 窗口（每次 tick 20ms）。 */
function settleAfter(ticks) {
  let n = 0;
  return () => {
    n += 1;
    return n >= ticks;
  };
}

/**
 * AUTH 不可重试用例的完成判据：失败不落盘、目标文件永不出现，
 * 以固定的短 settle 窗口为外部可观测量（两次 tick ≈ 40ms 后 attempt 链必已收口；
 * 真正的"只 1 次 attempt"由越界哨兵 stream impl 兜底——第 2 次调用直接抛）。
 */
let authSettleTicks = 0;
function authSettled() {
  authSettleTicks += 1;
  return authSettleTicks >= 2;
}

// ---- isRetryableFailure 表驱动钉 ----

test("isRetryableFailure 表驱动：可重试 code 逐个断言", () => {
  for (const code of ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"]) {
    assert.equal(isRetryableFailure({ code, message: "irrelevant" }), true, `code=${code} 应可重试`);
    // code 一致即可重试——message 再无害也不翻转结论（route on code, never by parsing message）
    assert.equal(isRetryableFailure({ code, message: "200 OK all good" }), true, `code=${code} 无害 message 不得翻转`);
  }
});

test("isRetryableFailure 表驱动：确定性失败 code 逐个断言不可重试", () => {
  for (const code of ["AUTH", "INVALID_REQUEST", "QUOTA", "NO_ADAPTER", "CONTEXT_WINDOW_EXCEEDED", "MISSING_CREDENTIAL"]) {
    assert.equal(isRetryableFailure({ code, message: "429 slow down please" }), false, `code=${code} 应不可重试`);
  }
});

test("isRetryableFailure：code 缺失时的保守消息兜底（最后手段）", () => {
  // 现场真实形态：真实 429 的 failure.code 是 null，message 是唯一线索
  assert.equal(
    isRetryableFailure({ code: null, message: "OpenCode Zen Free: Upstream request failed: Endpoint is unavailable." }, "dsh-keepsake: 提取调用异常结束 kind=error"),
    true,
  );
  assert.equal(isRetryableFailure({ message: "HTTP 429 Too Many Requests" }, "kind=error"), true);
  assert.equal(isRetryableFailure({ message: "connection reset by peer" }, "kind=error"), true);
  assert.equal(isRetryableFailure({ message: "request timed out after 120s" }, "kind=error"), true);
  // 兜底命不中 = 不可重试：AUTH 词面无 429/5xx/timeout/connection 字样
  assert.equal(isRetryableFailure({ message: "invalid api key supplied" }, "kind=error"), false);
  // 无 code 无 message：一律保守 false（宁可漏一次重试，不赌确定性失败）
  assert.equal(isRetryableFailure({}, ""), false);
  assert.equal(isRetryableFailure(undefined, ""), false);
});

// ---- 重试链集成钉 ----

test("重试链：可重试 code 失败后重试成功——3 次 attempt、retried=2、落盘、lastRecoveredAt 打点", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-retry-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-retry-"));
  try {
    const target = join(projectMemoryPaths(root, workspace).memoryDir, "retry-works.md");
    const queue = [failingStream({ code: "RATE_LIMIT", status: 429, message: "rate limited" }), failingStream({ code: "TRANSPORT", message: "conn reset" }), okStream()];
    const { streamCalls } = await runExtraction({
      root,
      workspace,
      config: { retryAttempts: 3, retryBackoffMs: 5, retryMaxDelayMs: 20 },
      streamImpl: queuedStream(queue),
      waitFor: () => existsSync(target),
    });
    assert.equal(streamCalls.length, 3, "RATE_LIMIT→TRANSPORT→成功：恰好 3 次 attempt");
    const snapshot = extractionFailureSnapshot();
    assert.equal(snapshot.retried, 2, "retried = 重试 attempt 粒度（第 2/3 次各 +1）");
    assert.equal(snapshot.fallbackUsed, 0, "fallbackUsed 本批恒 0 但字段必须在");
    assert.equal(existsSync(target), true, "重试成功后落盘");
    const recoveredAt = snapshot.lastRecoveredAt;
    assert.equal(typeof recoveredAt, "number", "有失败尝试后成功：lastRecoveredAt 打时间戳");
    // 同一轮提取里三次 attempt 用的是同一条主道路由
    assert.deepEqual(streamCalls.map((c) => c.provider), ["prov", "prov", "prov"]);
    assert.deepEqual(streamCalls.map((c) => c.model), ["model-x", "model-x", "model-x"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("重试链：不可重试 code（AUTH）只 attempt 1 次即摊牌", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-auth-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-auth-"));
  try {
    const queue = [failingStream({ code: "AUTH", status: 401, message: "invalid api key" }), okStream()];
    const { streamCalls } = await runExtraction({
      root,
      workspace,
      config: { retryAttempts: 3, retryBackoffMs: 5, retryMaxDelayMs: 20 },
      streamImpl: (options, callIndex) => {
        // AUTH 不可重试：只应发生 1 次调用，第 2 次调用直接抛暴露回归（越界哨兵）
        const entry = queue[callIndex - 1];
        if (entry === void 0) throw new Error(`AUTH 不可重试：第 ${callIndex} 次调用不应发生`);
        return entry();
      },
      waitFor: authSettled,
      timeoutMs: 3000,
    });
    // 再等一小段确认第 2 次 attempt 不会来（越界哨兵若触发会直接抛）
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(streamCalls.length, 1, "AUTH 不可重试：只发 1 次 attempt");
    const snapshot = extractionFailureSnapshot();
    assert.equal(snapshot.retried, 0, "未发生重试：retried=0");
    assert.equal(snapshot["llm-error"], 1, "llm-error 按 extractSession 粒度 +1");
    assert.equal(snapshot.lastRecoveredAt, null, "未恢复：lastRecoveredAt 保持 null");
    assert.equal(existsSync(join(projectMemoryPaths(root, workspace).memoryDir, "retry-works.md")), false, "失败不落盘");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("重试链：三次全败——llm-error 只 +1、retried=+2（口径钉）", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-exhaust-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-exhaust-"));
  try {
    const fail = failingStream({ code: "SERVER", status: 503, message: "upstream down" }); // 流工厂（async generator function），queuedStream entry() 调用得 iterator
    const queue = [fail, fail, fail];
    // 完成判据走外部可观测量：三次全败不落盘，给足 settle 窗口
    // （退避仅 5/10ms，整链 <100ms；10 tick=200ms 后必已收口）。
    const { streamCalls } = await runExtraction({
      root,
      workspace,
      config: { retryAttempts: 3, retryBackoffMs: 5, retryMaxDelayMs: 20 },
      streamImpl: queuedStream(queue),
      waitFor: settleAfter(10),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const snapshot = extractionFailureSnapshot();
    assert.equal(streamCalls.length, 3, "可重试失败用满全部 attempt");
    assert.equal(snapshot["llm-error"], 1, "llm-error 按 extractSession 粒度只 +1");
    assert.equal(snapshot.retried, 2, "retried 按 attempt 粒度 +2");
    assert.equal(snapshot.streak, 1, "streak 语义不变（extractSession 粒度）");
    assert.equal(snapshot.streakReason, "llm-error");
    assert.equal(snapshot.lastRecoveredAt, null, "全败无恢复");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("drain 纪律：退避 sleep 期间 dispose——不发起后续 attempt", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-drain-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-drain-"));
  try {
    // 三次全败但退避拉长（1s）：第一次失败后进入退避，此刻触发 dispose
    const fail = failingStream({ code: "SERVER", status: 503, message: "upstream down" }); // 流工厂（async generator function），queuedStream entry() 调用得 iterator
    const queue = [fail, fail, fail];
    let disposeFns = [];
    const effects = [];
    const streamCalls = [];
    const handlers = new Map();
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      on(type, fn) {
        handlers.set(type, fn);
      },
      effect(fn, label) {
        effects.push({ fn, label });
      },
      inject(_deps, setup) {
        const pending = [];
        const sctx = {
          effect(fn) {
            pending.push(fn);
          },
          webServer: { register() { return () => {}; } },
        };
        setup(sctx);
        for (const fn of pending) fn();
      },
      systemPrompt: { section() { return () => {}; } },
      llm: {
        stream(options) {
          streamCalls.push(options);
          return queue[streamCalls.length - 1]();
        },
      },
    };
    // 时序设计（drain 语义 = 先有界 drain 再 abort）：
    //   · 退避 3000ms 必须 > drain 预算 min(60000, timeoutMs=1000)=1000ms，
    //     这样 dispose 的 abort 一定落在那次退避 sleep 窗口内；
    //   · 首次 attempt 瞬败 → 进退避 → dispose 等待 drain 1s 后 abort →
    //     可取消 sleep 提前 resolve → attempt 前 aborted 检查命中，不再发起。
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 1000, retryAttempts: 3, retryBackoffMs: 3000, retryMaxDelayMs: 3000, extractIdleDelayMs: 0 });
    // 摘出 lifecycle dispose 句柄（apply 注册的 ctx.effect 返回的清理函数）
    disposeFns = effects.filter((e) => e.label === "dsh-keepsake lifecycle").map((e) => e.fn());
    const session = fakeSession(workspace, [USER_EVENT]);
    handlers.get("session/event")(session, USER_EVENT);
    handlers.get("session/event")(session, { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    // 等第一次 attempt 失败并进入退避窗口
    while (streamCalls.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // dispose：drain 等满 1s 预算 → lifetime.abort → 可取消 sleep 提前 resolve → 不再发起 attempt
    for (const dispose of disposeFns) await dispose();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(streamCalls.length, 1, "dispose 后重试链不得再发起第 2 次 attempt");
    const snapshot = extractionFailureSnapshot();
    assert.equal(snapshot.retried, 0, "退避期间 dispose：重试未真实发生，retried 不虚计");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("drain 纪律：dispose 挂起中的 stream（永不 finish）后不再有后续 attempt", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-hang-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-hang-"));
  try {
    const effects = [];
    const handlers = new Map();
    const streamCalls = [];
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      on(type, fn) {
        handlers.set(type, fn);
      },
      effect(fn, label) {
        effects.push({ fn, label });
      },
      inject(_deps, setup) {
        const pending = [];
        const sctx = { effect(fn) { pending.push(fn); }, webServer: { register() { return () => {}; } } };
        setup(sctx);
        for (const fn of pending) fn();
      },
      systemPrompt: { section() { return () => {}; } },
      llm: {
        stream() {
          streamCalls.push(1);
          // 永不 yield 的挂起流：靠 attempt 自身 timeoutMs 或 dispose abort 收口
          return { [Symbol.asyncIterator]() { return { next() { return new Promise(() => {}); } }; } };
        },
      },
    };
    // timeoutMs 故意短（1500ms）：本用例验的是"挂起流不衍生重试链"而非超时收口本身，
    // 长 timeout 会让 drain 等满 60s 预算拖垮检查（attempt 级超时有单独钉）。
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 1500, retryAttempts: 3, retryBackoffMs: 10, retryMaxDelayMs: 20, extractIdleDelayMs: 0 });
    const disposeFns = effects.filter((e) => e.label === "dsh-keepsake lifecycle").map((e) => e.fn());
    const session = fakeSession(workspace, [USER_EVENT]);
    handlers.get("session/event")(session, USER_EVENT);
    handlers.get("session/event")(session, { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    while (streamCalls.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const dispose of disposeFns) await dispose();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(streamCalls.length, 1, "dispose 后挂起的 attempt 不得衍生重试链");
    assert.equal(extractionFailureSnapshot().retried, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- 退避纯函数 ----

test("retryDelayMs：指数退避+jitter 范围+cap+providerRetryAfterMs 优先", () => {
  const opts = { backoffMs: 500, maxDelayMs: 2000, jitterRatio: 0.2 };
  // 指数形状：base*2^(n-1) 钳 maxDelay——n=1 基准 500，n=2 基准 1000，
  // n=3 起 2000 触顶（这才是正确的指数退避：第 3 次重试已到 cap）。
  const cases = [
    { n: 1, base: 500 },
    { n: 2, base: 1000 },
    { n: 3, base: 2000 },
    { n: 4, base: 2000 },
    { n: 9, base: 2000 },
  ];
  for (const { n, base } of cases) {
    for (const rand of [0, 0.25, 0.5, 0.75, 0.999]) {
      const delay = retryDelayMs(n, { ...opts, rand });
      assert.ok(delay >= Math.round(base * 0.8) - 1 && delay <= Math.round(base * 1.2) + 1, `n=${n} rand=${rand} 越界: ${delay}（基准 ${base}）`);
    }
  }
  // jitter 边界：rand=0 取下界、rand≈1 取上界
  assert.equal(retryDelayMs(1, { ...opts, rand: 0 }), 400);
  assert.equal(retryDelayMs(1, { ...opts, rand: 0.999999 }), 600);
  // providerRetryAfterMs 优先（长限流窗口不用本地短退避白撞）
  assert.equal(retryDelayMs(1, { ...opts, rand: 0 }, { providerRetryAfterMs: 3000 }), 3000);
  // 钳 ≤3*maxDelayMs 防恶意长等
  assert.equal(retryDelayMs(1, { ...opts, rand: 0 }, { providerRetryAfterMs: 999999 }), 6000);
  // 非有限/非正整数/负数一律忽略 providerRetryAfterMs 走本地退避
  for (const bad of [NaN, Infinity, -5, 0, 1.5, "3000"]) {
    const delay = retryDelayMs(1, { ...opts, rand: 0 }, { providerRetryAfterMs: bad });
    assert.equal(delay, 400, `providerRetryAfterMs=${String(bad)} 应被忽略: ${delay}`);
  }
  // n 越小或异常不炸（钳到 ≥1）
  assert.ok(retryDelayMs(0, { backoffMs: 500, maxDelayMs: 2000, rand: 0 }) >= 1);
});

// ---- resolveConfig 钉 ----

test("resolveConfig：retry 参数合法值+缺省+非法值 fail loud", () => {
  const base = { enabled: true };
  // 缺省（batch 契约：3 attempt / 500 / 2000）
  const cfg = resolveConfig(base);
  assert.equal(cfg.retryAttempts, 3);
  assert.equal(cfg.retryBackoffMs, 500);
  assert.equal(cfg.retryMaxDelayMs, 2000);
  assert.deepEqual(cfg.fallback, []);
  // 合法显式值
  const custom = resolveConfig({ ...base, retryAttempts: 5, retryBackoffMs: 100, retryMaxDelayMs: 1000 });
  assert.equal(custom.retryAttempts, 5);
  assert.equal(custom.retryBackoffMs, 100);
  assert.equal(custom.retryMaxDelayMs, 1000);
  // 非法值逐个抛
  for (const bad of [0, -1, 1.5, "3", NaN, true, Infinity]) {
    assert.throws(() => resolveConfig({ ...base, retryAttempts: bad }), /retryAttempts/, `retryAttempts=${String(bad)} 应抛`);
    assert.throws(() => resolveConfig({ ...base, retryBackoffMs: bad }), /retryBackoffMs/, `retryBackoffMs=${String(bad)} 应抛`);
    assert.throws(() => resolveConfig({ ...base, retryMaxDelayMs: bad }), /retryMaxDelayMs/, `retryMaxDelayMs=${String(bad)} 应抛`);
  }
  // 超 MAX_TIMER_DELAY_MS：fail loud
  assert.throws(() => resolveConfig({ ...base, retryMaxDelayMs: 2147483648 }), /too large/);
});

test("resolveConfig：fallback 校验矩阵（空/合法/超量/重复/撞主道/缺配对）", () => {
  const base = { enabled: true };
  // 缺省空 = 纯重试不换道（inert）
  assert.deepEqual(resolveConfig(base).fallback, []);
  assert.deepEqual(resolveConfig({ ...base, fallback: null }).fallback, []);
  // 合法 3 条
  const three = resolveConfig({
    ...base,
    fallback: [
      { provider: "p1", model: "m1" },
      { provider: "p2", model: "m2" },
      { provider: "p3", model: "m3" },
    ],
  });
  assert.deepEqual(three.fallback, [
    { provider: "p1", model: "m1" },
    { provider: "p2", model: "m2" },
    { provider: "p3", model: "m3" },
  ]);
  // 第 4 条抛
  assert.throws(
    () => resolveConfig({ ...base, fallback: [{ provider: "p1", model: "m1" }, { provider: "p2", model: "m2" }, { provider: "p3", model: "m3" }, { provider: "p4", model: "m4" }] }),
    /fallback.*at most 3|at most 3/,
  );
  // 数组内重复抛
  assert.throws(() => resolveConfig({ ...base, fallback: [{ provider: "p1", model: "m1" }, { provider: "p1", model: "m1" }] }), /duplicate/);
  // 与主道（显式配置）重复抛
  assert.throws(() => resolveConfig({ ...base, provider: "main", model: "main-m", fallback: [{ provider: "main", model: "main-m" }] }), /duplicates the primary/);
  // 主道未配（跟随会话路由）时不判重
  const follow = resolveConfig({ ...base, fallback: [{ provider: "main", model: "main-m" }] });
  assert.deepEqual(follow.fallback, [{ provider: "main", model: "main-m" }]);
  // 缺 model / 缺 provider / 空串 / 非对象 / 非数组
  assert.throws(() => resolveConfig({ ...base, fallback: [{ provider: "p" }] }), /provider and model together/);
  assert.throws(() => resolveConfig({ ...base, fallback: [{ model: "m" } ] }), /provider and model together/);
  assert.throws(() => resolveConfig({ ...base, fallback: [{ provider: "", model: "m" }] }), /non-empty string/);
  assert.throws(() => resolveConfig({ ...base, fallback: ["p/m"] }), /objects like/);
  assert.throws(() => resolveConfig({ ...base, fallback: { provider: "p", model: "m" } }), /must be an array/);
  // 未知 entry key fail loud
  assert.throws(() => resolveConfig({ ...base, fallback: [{ provider: "p", model: "m", weight: 2 }] }), /unknown fallback entry key/);
});

test("resolveConfig：未知键 did-you-mean 提示（failbacks→fallback）", () => {
  assert.throws(() => resolveConfig({ enabled: true, fallbacks: [] }), /unknown config key "fallbacks" \(did you mean "fallback"\?\)/);
  // 无近邻时裸报错（不再脑补）
  assert.throws(() => resolveConfig({ enabled: true, zzzzqqq: 1 }), /unknown config key "zzzzqqq"$/);
  // retryMaxDelayMs 拼错也应提示
  assert.throws(() => resolveConfig({ enabled: true, retryMaxDelay: 1 }), /did you mean "retryMaxDelayMs"\?/);
});

test("resolveConfig：8 新键矩阵（默认/显式/0 语义/边界/未知近邻）", () => {
  const base = { enabled: true };
  // 默认全表
  const cfg = resolveConfig(base);
  assert.deepEqual(
    {
      redactionEnabled: cfg.redactionEnabled, autoRecoverEnabled: cfg.autoRecoverEnabled,
      autoRecoverCooldownMs: cfg.autoRecoverCooldownMs, injectMaxTokens: cfg.injectMaxTokens,
      extractGateEnabled: cfg.extractGateEnabled, extractGateMinScore: cfg.extractGateMinScore,
      extractIdleDelayMs: cfg.extractIdleDelayMs, extractMaxRunsPerSession: cfg.extractMaxRunsPerSession,
    },
    {
      redactionEnabled: true, autoRecoverEnabled: true, autoRecoverCooldownMs: 300000, injectMaxTokens: 16000,
      extractGateEnabled: true, extractGateMinScore: 6, extractIdleDelayMs: 3000, extractMaxRunsPerSession: 50,
    },
  );
  // 缺省 null 与 undefined 同义（回落默认）
  assert.equal(resolveConfig({ ...base, injectMaxTokens: null }).injectMaxTokens, 16000);
  // nonNegInt：0 合法（三个键各自的 0 语义）
  const zeros = resolveConfig({ ...base, injectMaxTokens: 0, extractIdleDelayMs: 0, extractMaxRunsPerSession: 0 });
  assert.equal(zeros.injectMaxTokens, 0);
  assert.equal(zeros.extractIdleDelayMs, 0);
  assert.equal(zeros.extractMaxRunsPerSession, 0);
  // nonNegInt 非法值逐个抛
  for (const bad of [-1, 1.5, "0", NaN, Infinity, true]) {
    assert.throws(() => resolveConfig({ ...base, injectMaxTokens: bad }), /injectMaxTokens/, `injectMaxTokens=${String(bad)}`);
    assert.throws(() => resolveConfig({ ...base, extractIdleDelayMs: bad }), /extractIdleDelayMs/, `extractIdleDelayMs=${String(bad)}`);
    assert.throws(() => resolveConfig({ ...base, extractMaxRunsPerSession: bad }), /extractMaxRunsPerSession/, `extractMaxRunsPerSession=${String(bad)}`);
  }
  // positiveInt：0 非法（两键）
  for (const bad of [0, -1, 1.5, "300000", NaN]) {
    assert.throws(() => resolveConfig({ ...base, autoRecoverCooldownMs: bad }), /autoRecoverCooldownMs/, `autoRecoverCooldownMs=${String(bad)}`);
    assert.throws(() => resolveConfig({ ...base, extractGateMinScore: bad }), /extractGateMinScore/, `extractGateMinScore=${String(bad)}`);
  }
  // ms 级键过 MAX_TIMER_DELAY_MS 钳
  assert.throws(() => resolveConfig({ ...base, autoRecoverCooldownMs: MAX_TIMER_DELAY_MS + 1 }), /autoRecoverCooldownMs too large/);
  assert.throws(() => resolveConfig({ ...base, extractIdleDelayMs: MAX_TIMER_DELAY_MS + 1 }), /extractIdleDelayMs too large/);
  // 边界值恰好合法
  assert.equal(resolveConfig({ ...base, autoRecoverCooldownMs: MAX_TIMER_DELAY_MS }).autoRecoverCooldownMs, MAX_TIMER_DELAY_MS);
  // 显式自定义值生效
  const custom = resolveConfig({
    ...base, redactionEnabled: false, autoRecoverEnabled: false, autoRecoverCooldownMs: 1000,
    injectMaxTokens: 999, extractGateEnabled: false, extractGateMinScore: 12, extractIdleDelayMs: 20, extractMaxRunsPerSession: 3,
  });
  assert.equal(custom.redactionEnabled, false);
  assert.equal(custom.autoRecoverEnabled, false);
  assert.equal(custom.autoRecoverCooldownMs, 1000);
  assert.equal(custom.injectMaxTokens, 999);
  assert.equal(custom.extractGateEnabled, false);
  assert.equal(custom.extractGateMinScore, 12);
  assert.equal(custom.extractIdleDelayMs, 20);
  assert.equal(custom.extractMaxRunsPerSession, 3);
  // 未知键 did-you-mean：手滑近邻应提示
  assert.throws(() => resolveConfig({ ...base, injectMaxToken: 1 }), /did you mean "injectMaxTokens"\?/);
  assert.throws(() => resolveConfig({ ...base, extractGateMinScores: 1 }), /did you mean "extractGateMinScore"\?/);
});

test("fallback 换道接线：主道耗尽→换道成功→记 fallbackUsed + 落盘", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-fb-wire-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-fb-wire-"));
  try {
    const fail = failingStream({ code: "SERVER", status: 503, message: "upstream down" });
    const queue = [fail, fail, okStream()]; // 主道 2 attempt 全败 → 换道 1 次成功
    const target = join(projectMemoryPaths(root, workspace).memoryDir, "retry-works.md");
    const { streamCalls } = await runExtraction({
      root,
      workspace,
      config: {
        retryAttempts: 2,
        retryBackoffMs: 5,
        retryMaxDelayMs: 20,
        fallback: [{ provider: "fb-prov", model: "fb-model" }],
      },
      streamImpl: queuedStream(queue),
      waitFor: () => existsSync(target),
    });
    assert.equal(existsSync(target), true, "换道成功后应落盘");
    assert.equal(streamCalls.length, 3, "主道 2 attempt + 换道 1 attempt");
    assert.ok(streamCalls[0].provider === "prov" && streamCalls[0].model === "model-x", "第 1 次走主道");
    assert.ok(streamCalls[1].provider === "prov" && streamCalls[1].model === "model-x", "第 2 次仍走主道（未提前换道）");
    assert.ok(streamCalls[2].provider === "fb-prov" && streamCalls[2].model === "fb-model", "主道耗尽后才换道");
    const snap = extractionFailureSnapshot();
    assert.equal(snap.fallbackUsed, 1, "换道成功计一次");
    assert.equal(snap.streak, 0, "换道成功=恢复，无失败连击");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("fallback：配了但全败 → 报 error、fallbackUsed 不加、不落盘", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-fb-fail-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-fb-fail-"));
  try {
    const fail = failingStream({ code: "SERVER", status: 503, message: "down" });
    const queue = [fail, fail, fail, fail]; // 主道 2 + 换道 2（换道同样走完整 attempt 链）全败
    const target = join(projectMemoryPaths(root, workspace).memoryDir, "retry-works.md");
    const { streamCalls } = await runExtraction({
      root,
      workspace,
      config: {
        retryAttempts: 2,
        retryBackoffMs: 5,
        retryMaxDelayMs: 20,
        fallback: [{ provider: "fb-prov", model: "fb-model" }],
      },
      streamImpl: queuedStream(queue),
      waitFor: settleAfter(12),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(streamCalls.length, 4, "主道 2 + 换道 2（队列越界哨兵兜底更多调用）");
    assert.equal(extractionFailureSnapshot().fallbackUsed, 0, "全败不记换道成功");
    assert.equal(existsSync(target), false, "全败不落盘");
    assert.ok(streamCalls.every((c) => c.provider === "prov" || c.provider === "fb-prov"), "两道路由都试过");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- metrics 计数与恢复语义 ----

test("metrics：retried / lastRecoveredAt / fallbackUsed 契约", () => {
  __resetMetricsForTest();
  let snap = extractionFailureSnapshot();
  assert.equal(snap.retried, 0);
  assert.equal(snap.fallbackUsed, 0);
  assert.equal(snap.lastRecoveredAt, null);
  bumpRetryAttempt();
  bumpRetryAttempt();
  snap = extractionFailureSnapshot();
  assert.equal(snap.retried, 2);
  // streak 语义不受影响（extractSession 粒度由 bump/reset 管）
  assert.equal(snap.streak, 0);
  assert.equal(snap.streakReason, "");
  const before = Date.now();
  noteExtractionRecovered();
  const after = extractionFailureSnapshot().lastRecoveredAt;
  assert.ok(after >= before && after <= Date.now(), "lastRecoveredAt 是打点时刻");
  __resetMetricsForTest();
  assert.equal(extractionFailureSnapshot().retried, 0, "__resetMetricsForTest 复位新字段");
});

// ---- 提取结算明细端到端（extractSession 返回对象 → journal 落盘）----
//
// 取舍说明：extractSession 不导出（只经 scheduler 闭包调用），故不在单元层直接断言它的
// 返回值，而是断言它的**可观测落点**——<storageRoot>/extraction-journal.jsonl。
// 这样"返回了什么对象"与"盘上留下了什么"一起被钉住，比断言返回值更能防回归
// （返回对象写错 → 盘上明细必错）；契约形状本身另由 state 层记账用例钉住。

test("结算明细落盘：成功提取记 written（writes/deletes 如实）；模型无产出记 zero-ops", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-detail-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-journal-detail-"));
  try {
    const target = join(projectMemoryPaths(root, workspace).memoryDir, "retry-works.md");
    await runExtraction({
      root,
      workspace,
      streamImpl: okStream(),
      waitFor: () => existsSync(target),
    });
    await new Promise((resolve) => setTimeout(resolve, 150)); // 等 journal 追加（promise 链队列）
    const lines = readFileSync(join(root, JOURNAL_FILE_NAME), "utf8").trim().split("\n");
    const runs = lines.map((l) => JSON.parse(l));
    assert.equal(runs.length, 1, "一次提取落一行结算");
    assert.equal(runs[0].outcome, "written", "有 op 落盘 = written");
    assert.equal(runs[0].writes, 1);
    assert.equal(runs[0].deletes, 0);
    assert.equal(runs[0].sessionId, "s-test");
    assert.ok(runs[0].cursorAfter > 0, "ok 结算 cursorAfter 已推进");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("结算明细落盘：模型判「无需保存」→ zero-ops（不是 failed，也不当成功写盘）", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-zero-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-journal-zero-"));
  try {
    await runExtraction({
      root,
      workspace,
      streamImpl: okStream("nothing to save."),
      waitFor: settleAfter(10),
    });
    await new Promise((resolve) => setTimeout(resolve, 200)); // 等 journal 追加
    const runs = readFileSync(join(root, JOURNAL_FILE_NAME), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(runs.length, 1);
    assert.equal(runs[0].outcome, "zero-ops", "模型无产出 = zero-ops（成功但零 ops）");
    assert.equal(runs[0].reason, "model-无产出");
    assert.ok(runs[0].cursorAfter > 0, "skip/zero-ops 也推进 cursor（边界①）");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("结算明细落盘：LLM 失败 → failed/reason=llm-error 且 cursorAfter==from（进未恢复清单）", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-fail-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-journal-fail-"));
  try {
    await runExtraction({
      root,
      workspace,
      config: { retryAttempts: 3, retryBackoffMs: 5, retryMaxDelayMs: 20 }, // 退避压到毫秒级：整链 <100ms 收口
      streamImpl: failingStream({ code: "SERVER", status: 503, message: "upstream down" }),
      waitFor: settleAfter(20),
    });
    await new Promise((resolve) => setTimeout(resolve, 300)); // 等重试链收口 + journal 追加
    const runs = readFileSync(join(root, JOURNAL_FILE_NAME), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(runs.length, 1, "重试链整体只结算一次（extractSession 粒度）");
    assert.equal(runs[0].outcome, "failed");
    assert.equal(runs[0].reason, "llm-error");
    assert.equal(runs[0].cursorAfter, runs[0].from, "error 不推进：cursorAfter == from");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("关闭总开关 → skipped/gate-off 仍记账（成功面也要有痕）", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-gate-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-journal-gate-"));
  try {
    writeSettings(root, { conversationMemory: false }, { info() {}, warn() {}, error() {} });
    resetSettingsCache();
    await runExtraction({
      root,
      workspace,
      streamImpl: () => {
        throw new Error("总开关关：不得发起任何 LLM 调用");
      },
      waitFor: settleAfter(10),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const runs = readFileSync(join(root, JOURNAL_FILE_NAME), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(runs.length, 1, "跳过也要记账（只记失败 = 盘上全是红条，看不出提取一直在工作）");
    assert.equal(runs[0].outcome, "skipped");
    assert.equal(runs[0].reason, "gate-off");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- extractSession 14 个 return 点的 {status, detail} 全量钉子 ----
//
// 前面只钉住 4 个点（written / zero-ops-model-无产出 / failed-llm-error /
// skipped-gate-off），其余写错测试仍会通过。以下把缺的逐个补齐，全部走同一口径：
// 触发真实提取 → 读 extraction-journal.jsonl → 断言 outcome/reason/status/cursorAfter。
// status 无法从盘上直读（journal 只落 detail），用 cursorAfter 反推：
//   · status==='error' → cursor 不动 → cursorAfter === from；
//   · status==='ok'   → cursor 推进 → cursorAfter > from。
// 故每个用例都同时钉 outcome/reason 与 cursor 行为（status 的等价物）。

test("skipReason 命中 → skipped 且 reason 原值透传（direct-memory-write / no-user-prose）", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  // ① direct-memory-write：主 agent 已把记忆直写进 memoryDir → 本轮跳过（reason 原值透传）
  {
    const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-skip-dmw-"));
    const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-journal-skip-dmw-"));
    try {
      const inside = join(projectMemoryPaths(root, workspace).memoryDir, "direct.md");
      const events = [
        USER_EVENT,
        { type: "tool/call", seq: 1, data: { name: "write", callId: "c1", arguments: JSON.stringify({ file_path: inside, content: "x" }) } },
        { type: "tool/result", seq: 2, data: { message: { role: "tool", source: { callId: "c1" }, isError: false, content: [{ type: "text", text: "ok" }] } } },
      ];
      await runRounds({
        root,
        workspace,
        rounds: [{ seq: 3, events }],
        streamImpl: () => {
          throw new Error("skip：不得发起任何 LLM 调用");
        },
      });
      const runs = journalRuns(root);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].outcome, "skipped");
      assert.equal(runs[0].reason, "direct-memory-write", "reason 原值透传（不是写死的字符串）");
      assert.ok(runs[0].cursorAfter > runs[0].from, "status='ok'：skip 也推进");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }
  // ② no-user-prose：增量内无 ≥3 词合格用户散文 → 跳过
  {
    const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-skip-prose-"));
    const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-journal-skip-prose-"));
    try {
      const events = [
        { type: "user/message", surfaceOp: "append", seq: 0, data: { role: "user", content: [{ type: "text", text: "嗯" }] } },
      ];
      await runRounds({
        root,
        workspace,
        rounds: [{ seq: 1, events }],
        streamImpl: () => {
          throw new Error("skip：不得发起任何 LLM 调用");
        },
      });
      const runs = journalRuns(root);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].outcome, "skipped");
      assert.equal(runs[0].reason, "no-user-prose");
      assert.ok(runs[0].cursorAfter > runs[0].from, "status='ok'：skip 也推进");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("format-readonly：数据目录标了更高格式版本 → skipped（cursor 推进，不发起 LLM）", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-fmt-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-journal-fmt-"));
  try {
    // 写比 FORMAT_VERSION（1）更高的标记 → apply 的 ensureFormat 判定只读保护
    writeFileSync(join(root, FORMAT_FILENAME), JSON.stringify({ formatVersion: 99 }), "utf8");
    resetFormatCache();
    await runExtraction({
      root,
      workspace,
      streamImpl: () => {
        throw new Error("只读保护：不得发起任何 LLM 调用");
      },
      waitFor: settleAfter(12),
    });
    const runs = journalRuns(root);
    assert.equal(runs.length, 1, "只读保护也记账（盘上要看得出是保护而非消失）");
    assert.equal(runs[0].outcome, "skipped");
    assert.equal(runs[0].reason, "format-readonly");
    assert.ok(runs[0].cursorAfter > runs[0].from, "status='ok'：cursor 照推进（与 gate-off 同侧）");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("no-cwd 两态：streak<5 → status='error' cursorAfter==from；第 5 次放弃 → status='ok' cursor 推进", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-nocwd-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-journal-nocwd-"));
  try {
    // 全程无 cwd（header.cwd 清空）→ 每轮 no-cwd 失败，streak 逐轮 +1
    await runRounds({
      root,
      workspace,
      streamImpl: () => {
        throw new Error("no-cwd：不得发起任何 LLM 调用");
      },
      rounds: Array.from({ length: 6 }, (_, i) => ({ seq: i + 1, cwd: "" })),
    });
    const runs = journalRuns(root);
    assert.equal(runs.length, 6, "六轮各落一条结算");
    // 前 4 轮：streak 1..4 → status='error'，cursor 不动（恒等于首见 0）
    for (let i = 0; i < 4; i += 1) {
      assert.equal(runs[i].outcome, "failed", `第 ${i + 1} 轮 outcome`);
      assert.equal(runs[i].reason, "no-cwd");
      assert.equal(runs[i].cursorAfter, runs[i].from, `第 ${i + 1} 轮 cursor 不动`);
    }
    // 第 5 轮：streak=5 → 放弃型，status='ok'（cursor 推进），outcome=abandoned（独立留痕）
    assert.equal(runs[4].outcome, "abandoned", "放弃型记 abandoned（与 failed 分列）");
    assert.equal(runs[4].reason, "no-cwd");
    assert.ok(runs[4].cursorAfter > runs[4].from, "第 5 轮 status='ok'：cursor 推进");
    // 第 6 轮：放弃后不 reset（no reset 调用在放弃分支），streak 续到 6 → 继续放弃型
    assert.equal(runs[5].outcome, "abandoned");
    assert.equal(runs[5].reason, "no-cwd");
    assert.ok(runs[5].cursorAfter > runs[5].from, "第 6 轮仍是放弃型：cursor 继续推进");
    assert.ok(runs[4].cursorAfter > 0, "推进后的 cursor 不是 0（证明真的动了）");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("no-route 两态：streak<5 → status='error' cursorAfter==from；第 5 次放弃 → status='ok' cursor 推进", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-noroute-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-journal-noroute-"));
  try {
    // 不配 provider/model（config 与 request/header 都不给路由）→ 每轮 no-route。
    // 走 runRounds 的 noRoute 口径：每轮声明独立 events，后轮增量不为空，
    // 不会先被 skipReason 拦成 no-user-prose（否则测不到目标分支）。
    await runRounds({
      root,
      workspace,
      noRoute: true,
      streamImpl: () => {
        throw new Error("no-route：不得发起任何 LLM 调用");
      },
      rounds: Array.from({ length: 6 }, (_, i) => ({ seq: i + 1 })),
    });
    const runs = journalRuns(root);
    assert.equal(runs.length, 6, "六轮各落一条结算");
    for (let i = 0; i < 4; i += 1) {
      assert.equal(runs[i].outcome, "failed", `第 ${i + 1} 轮 outcome`);
      assert.equal(runs[i].reason, "no-route");
      assert.equal(runs[i].cursorAfter, runs[i].from, `第 ${i + 1} 轮 cursor 不动`);
    }
    assert.equal(runs[4].outcome, "abandoned", "放弃型记 abandoned");
    assert.equal(runs[4].reason, "no-route");
    assert.ok(runs[4].cursorAfter > runs[4].from, "第 5 轮 status='ok'：cursor 推进");
    assert.equal(runs[5].outcome, "abandoned");
    assert.equal(runs[5].reason, "no-route");
    assert.ok(runs[5].cursorAfter > runs[5].from, "第 6 轮继续放弃型");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("streak 按会话分键：别会话的连续失败不把本会话顶到放弃线", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-streak-perm-"));
  try {
    // 会话 A 失败 4 轮（streak=4，未到放弃线），期间会话 B 也失败 4 轮——
    // 若 streak 不分键，A 会被 B 顶到 ≥5 而提前进入放弃型（cursor 推进）；
    // 分键后 A 的第 5 轮才到放弃线。
    const plan = [];
    for (let i = 1; i <= 4; i += 1) {
      plan.push({ sessionId: "A", seq: i });
      plan.push({ sessionId: "B", seq: i });
    }
    plan.push({ sessionId: "A", seq: 5 }); // A 的第 5 轮 = 放弃线
    plan.push({ sessionId: "B", seq: 5 }); // B 的第 5 轮 = 放弃线
    await runTwoSessions({ root, plan });
    const runs = journalRuns(root);
    const aRuns = runs.filter((r) => r.sessionId === "A");
    const bRuns = runs.filter((r) => r.sessionId === "B");
    assert.equal(aRuns.length, 5, "A 五轮各一条结算");
    assert.equal(bRuns.length, 5, "B 五轮各一条结算");
    // A 前 4 轮：cursor 不动、failed；第 5 轮才 abandoned（cursor 推进）
    for (let i = 0; i < 4; i += 1) {
      assert.equal(aRuns[i].outcome, "failed", `A 第 ${i + 1} 轮仍是 failed（不被 B 顶到放弃线）`);
      assert.equal(aRuns[i].cursorAfter, aRuns[i].from, `A 第 ${i + 1} 轮 cursor 不动`);
    }
    assert.equal(aRuns[4].outcome, "abandoned", "A 第 5 轮才放弃");
    // B 同理：前 4 轮 failed
    for (let i = 0; i < 4; i += 1) {
      assert.equal(bRuns[i].outcome, "failed", `B 第 ${i + 1} 轮仍是 failed`);
      assert.equal(bRuns[i].cursorAfter, bRuns[i].from);
    }
    assert.equal(bRuns[4].outcome, "abandoned", "B 第 5 轮才放弃");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("streak 随会话消亡消退：A 连败 4 次后 disposed → 快照 streak 回 0（死会话红灯不长亮）", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-streak-decay-"));
  try {
    // A 会话连败 4 轮（streak=4，未到放弃线），此时快照 streak=4
    const { handlers, sessions } = await runTwoSessions({
      root,
      plan: Array.from({ length: 4 }, (_, i) => ({ sessionId: "A", seq: i + 1 })),
    });
    assert.equal(extractionFailureSnapshot().streak, 4, "A 连败期间快照 streak=4");
    // A 会话消亡（session/disposed）→ 其连击键被清，快照不再对已不存在的会话报警
    handlers.get("session/disposed")(sessions.get("A"));
    assert.equal(extractionFailureSnapshot().streak, 0, "会话消亡后 streak 消退为 0（不再含 A）");
    assert.equal(extractionFailureSnapshot().streakReason, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aborted：重试链退避期间 dispose → failed/aborted（cursor 不动，不再发起后续 attempt）", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-abort-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-journal-abort-"));
  try {
    const { ctx, handlers, effects, streamCalls } = fakeCtx(() => {
      // 首次 attempt 即触发 dispose（照真实"卸载发生在提取在途"时序）：
      // lifetime.signal 置位 → 可取消退避提前 resolve → 下一次 attempt 前 aborted 检查命中。
      for (const dispose of disposeFns) dispose();
      return (async function* () {
        yield { type: "finish", reason: { kind: "error", failure: { code: "SERVER", status: 503, message: "down" } } };
      })();
    });
    let disposeFns = [];
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 5000, retryAttempts: 3, retryBackoffMs: 50, retryMaxDelayMs: 100, extractIdleDelayMs: 0 });
    disposeFns = effects.filter((e) => e.label === "dsh-keepsake lifecycle").map((e) => e.fn());
    const session = { id: "s-test", seq: 1, header: { cwd: workspace }, snapshotEvents(from, to) { return [USER_EVENT].slice(from, to); } };
    handlers.get("session/event")(session, USER_EVENT);
    handlers.get("session/event")(session, { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((resolve) => setTimeout(resolve, 600)); // 等整链收口
    assert.equal(streamCalls.length, 1, "abort 后不得再发起第 2 次 attempt");
    const runs = journalRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].outcome, "failed");
    assert.equal(runs[0].reason, "aborted");
    assert.equal(runs[0].cursorAfter, runs[0].from, "status='error'：abort 不推进 cursor");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("parse-error：模型返回非 JSON 输出 → failed/parse-error 且 cursor 不动", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-parse-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-journal-parse-"));
  try {
    await runExtraction({
      root,
      workspace,
      streamImpl: okStream("这不是 JSON，模型跑题了"),
      waitFor: settleAfter(12),
    });
    const runs = journalRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].outcome, "failed");
    assert.equal(runs[0].reason, "parse-error");
    assert.equal(runs[0].cursorAfter, runs[0].from, "status='error'：parse 失败不推进 cursor");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- io-error 三态（落盘结算的三岔，cursor 全部照常推进——既有语义）----
//
// 全部用盘上真实故障构造，不 mock 任何模块（mock applyScopedOps 会把整批语义
// 一起 mock 掉，钉的就不是产品行为了）：
//   · "blocker.md" 先建成普通文件，再用 "blocker.md/bad.md" 作 op 名
//     → mkdirSync(dirname) 因 parent 是文件而炸 → 该 op 计 failed（单条隔离）；
//   · MEMORY.md 建成目录 → readFileSync EISDIR → 整批重建索引抛 → status='error'。

test("io-error ①：部分 op 落盘 + 部分单 op 失败 → written 带 failedOps>0（cursor 照常推进）", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-io-partial-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-journal-io-partial-"));
  try {
    const memDir = projectMemoryPaths(root, workspace).memoryDir;
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "blocker.md"), "I am a file"); // 占位成文件 → 以其为父目录的 op 必炸
    await runExtraction({
      root,
      workspace,
      streamImpl: okStream('{"ops":['
        + '{"action":"write","name":"good-a.md","type":"project","title":"Good","content":"内容一"},'
        + '{"action":"write","name":"blocker.md/bad.md","type":"project","title":"Bad","content":"内容二"}]}'),
      waitFor: settleAfter(12),
    });
    const runs = journalRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].outcome, "written", "有 op 落盘 = written（不是 failed）");
    assert.equal(runs[0].writes, 1, "好的那条落上了");
    assert.equal(runs[0].failedOps, 1, "坏的那条计单 op 失败（单条隔离不重试）");
    assert.ok(runs[0].cursorAfter > runs[0].from, "status='ok'：部分失败 cursor 照常推进（斩断确定性重试）");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("io-error ②：一条都没落上且有单 op 失败 → failed/io-error 但 status='ok'（cursor 推进）", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-io-allfail-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-journal-io-allfail-"));
  try {
    const memDir = projectMemoryPaths(root, workspace).memoryDir;
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "blocker.md"), "I am a file");
    await runExtraction({
      root,
      workspace,
      streamImpl: okStream('{"ops":['
        + '{"action":"write","name":"blocker.md/bad.md","type":"project","title":"Bad","content":"内容"}]}'),
      waitFor: settleAfter(12),
    });
    const runs = journalRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].outcome, "failed", "applied=0：没写成功就不是 written");
    assert.equal(runs[0].reason, "io-error");
    assert.equal(runs[0].writes, 0);
    assert.equal(runs[0].deletes, 0);
    assert.equal(runs[0].failedOps, 1, "确有单 op 失败");
    assert.ok(runs[0].cursorAfter > runs[0].from, "status='ok'：cursor 推进（盘上留着'推进了但没写东西'）");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("io-error ③：整批落盘结构性失败（索引重建炸）→ failed/io-error status='error' cursor 不动", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-io-batch-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-journal-io-batch-"));
  try {
    const memDir = projectMemoryPaths(root, workspace).memoryDir;
    mkdirSync(memDir, { recursive: true });
    // MEMORY.md 建成目录 → 索引重建的 readFileSync 抛 EISDIR → 整批捕获 → status='error'
    mkdirSync(join(memDir, INDEX_FILENAME), { recursive: true });
    await runExtraction({
      root,
      workspace,
      streamImpl: okStream('{"ops":['
        + '{"action":"write","name":"ok.md","type":"project","title":"OK","content":"内容"}]}'),
      waitFor: settleAfter(12),
    });
    const runs = journalRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].outcome, "failed");
    assert.equal(runs[0].reason, "io-error", "整批抛与单 op 失败同桶（noteFailure 分桶同名）");
    assert.equal(runs[0].cursorAfter, runs[0].from, "status='error'：整批失败不推进 cursor（下轮重提）");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("ops-未落盘：有 op 但全被跳过/过滤 → zero-ops（applied=0 且 failed=0）", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  // ① 全被开关过滤：projectMemory=false → filteredProject 计 2，applied=0
  {
    const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-ops-filtered-"));
    const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-journal-ops-filtered-"));
    try {
      writeSettings(root, { projectMemory: false }, { info() {}, warn() {}, error() {} });
      resetSettingsCache();
      await runExtraction({
        root,
        workspace,
        streamImpl: okStream('{"ops":['
          + '{"action":"write","name":"filt-a.md","type":"project","title":"F","content":"内容一"},'
          + '{"action":"write","name":"filt-b.md","type":"project","title":"G","content":"内容二"}]}'),
        waitFor: settleAfter(12),
      });
      const runs = journalRuns(root);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].outcome, "zero-ops", "全被过滤 = 零 ops（不是失败）");
      assert.equal(runs[0].reason, "ops-未落盘");
      assert.equal(runs[0].writes, 0);
      assert.equal(runs[0].failedOps, 0, "过滤不是失败");
      assert.equal(runs[0].filtered, 2, "过滤数如实记账（filteredProject 累加）");
      assert.ok(runs[0].cursorAfter > runs[0].from, "status='ok'：零 ops 也推进");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }
  // ② 全被跳过：op 名是已存在目录 → 批前原文读失败 fail-closed 跳过 → skippedOps=2，applied=0
  {
    const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-ops-skipped-"));
    const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-journal-ops-skipped-"));
    try {
      const memDir = projectMemoryPaths(root, workspace).memoryDir;
      mkdirSync(join(memDir, "blk1.md"), { recursive: true });
      mkdirSync(join(memDir, "blk2.md"), { recursive: true });
      await runExtraction({
        root,
        workspace,
        streamImpl: okStream('{"ops":['
          + '{"action":"write","name":"blk1.md","type":"project","title":"B1","content":"内容一"},'
          + '{"action":"write","name":"blk2.md","type":"project","title":"B2","content":"内容二"}]}'),
        waitFor: settleAfter(12),
      });
      const runs = journalRuns(root);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].outcome, "zero-ops");
      assert.equal(runs[0].reason, "ops-未落盘");
      assert.equal(runs[0].skippedOps, 2, "两条都被跳过（fail-closed，不计失败）");
      assert.equal(runs[0].failedOps, 0);
      assert.ok(runs[0].cursorAfter > runs[0].from);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

// ---- 打分门 e2e：薄轮 skipped/thin-evidence 留痕 + cursor 推进；厚轮照常提取 ----

test("打分门：薄轮（低分）→ skipped/thin-evidence 留痕 + cursor 推进，不调 LLM", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-gate-thin-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-gate-thin-"));
  try {
    // 文本过薄但过 skipReason（≥3 词）而打分门拦（score<6）：3 空格词 + 0 工具 + 1 轮
    // = 3 + 0 + 2 = 5 <6。刻意构造"能过 no-user-prose 但过不了打分门"的夹缝轮——
    // 这正是打分门要拦的烧钱轮。（注意 CJK 按 ⌊字数/2⌋ 折算会抬分，故用纯 ASCII 三词。）
    const events = [
      { type: "user/message", surfaceOp: "append", seq: 0, data: { role: "user", content: [{ type: "text", text: "please do it" }] } },
    ];
    await runRounds({
      root,
      workspace,
      rounds: [{ seq: 3, events }],
      streamImpl: () => {
        throw new Error("打分门拦下：不得发起任何 LLM 调用");
      },
    });
    const runs = journalRuns(root);
    assert.equal(runs.length, 1, "薄轮也记账（journal 留痕）");
    assert.equal(runs[0].outcome, "skipped");
    assert.equal(runs[0].reason, "thin-evidence", "门拦 reason=thin-evidence");
    assert.ok(runs[0].cursorAfter > runs[0].from, "status='ok'：门拦也推进 cursor（不积累重试）");
    // journal 行不写 gateScore（detail 字段只落 journal 白名单数值——gateScore 无对应列即不入行，
    // 观测经日志与 detail 出参；此处钉的是"留痕 + 推进"两件事）
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("打分门：厚轮（工具种类/多轮抬分）照常提取落盘", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-gate-thick-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-gate-thick-"));
  try {
    // 带 2 种工具（2×2=4 分）+ 1 轮（2 分）→ 6 分过门；薄文本也无妨（工具证据即够）
    const events = [
      { type: "user/message", surfaceOp: "append", seq: 0, data: { role: "user", content: [{ type: "text", text: "看 一下 这个" }] } },
      { type: "tool/call", seq: 1, data: { name: "read", callId: "c1", arguments: JSON.stringify({ file_path: "/tmp/x" }) } },
      { type: "tool/call", seq: 2, data: { name: "grep", callId: "c2", arguments: JSON.stringify({ pattern: "y" }) } },
    ];
    const { streamCalls } = await runRounds({
      root,
      workspace,
      rounds: [{ seq: 4, events }],
      streamImpl: okStream(),
      settleMs: 200,
    });
    assert.ok(streamCalls.length >= 1, "厚轮应过门并调 LLM");
    const runs = journalRuns(root);
    assert.equal(runs[0].outcome, "written", "过门后照常提取落盘");
    assert.notEqual(runs[0].reason, "thin-evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("打分门：extractGateEnabled=false 关掉 → 薄轮照常提取（回滚面）", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-gate-off-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-gate-off-"));
  try {
    const events = [
      { type: "user/message", surfaceOp: "append", seq: 0, data: { role: "user", content: [{ type: "text", text: "看 一下 这个" }] } },
    ];
    const { streamCalls } = await runRounds({
      root,
      workspace,
      config: { extractGateEnabled: false },
      rounds: [{ seq: 3, events }],
      streamImpl: okStream(),
      settleMs: 200,
    });
    assert.ok(streamCalls.length >= 1, "关了门薄轮也照常调 LLM（旧行为）");
    const runs = journalRuns(root);
    assert.notEqual(runs[0].reason, "thin-evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("打分门：阈值可调（extractGateMinScore 抬高 → 原本过门的轮被拦）", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-gate-min-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-gate-min-"));
  try {
    // 1 种工具 + 1 轮 = 2 + 2 = 4 分：默认门（6）本会拦；这里反向验证阈值旋钮生效——
    // 抬阈值 + 加厚到"默认能过"的组合才有甄别力：userWords 5（3 空格词 + ⌊4 CJK/2⌋）
    // + 3 工具（6）+ 1 轮（2）= 13 ≥ 6 默认过；阈值抬到 20 → 13 < 20 被拦 ——
    // 这一对才真正钉住阈值被读取（若实现恒用默认 6，此用例会红）。
    const events = [
      { type: "user/message", surfaceOp: "append", seq: 0, data: { role: "user", content: [{ type: "text", text: "看 一下 这个" }] } },
      { type: "tool/call", seq: 1, data: { name: "read", callId: "c1", arguments: "{}" } },
      { type: "tool/call", seq: 2, data: { name: "grep", callId: "c2", arguments: "{}" } },
      { type: "tool/call", seq: 3, data: { name: "write", callId: "c3", arguments: "{}" } },
    ];
    const { streamCalls } = await runRounds({
      root,
      workspace,
      config: { extractGateMinScore: 20 },
      rounds: [{ seq: 5, events }],
      streamImpl: () => {
        throw new Error("阈值 20：8 分轮应被拦，不得调 LLM");
      },
    });
    assert.equal(streamCalls.length, 0, "抬阈值后低分轮被拦");
    const runs = journalRuns(root);
    assert.equal(runs[0].outcome, "skipped");
    assert.equal(runs[0].reason, "thin-evidence");
    assert.ok(runs[0].cursorAfter > runs[0].from);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- 二道脱敏 e2e：假 LLM 回含密钥 op → 记忆文件落 [redacted] + journal redacted 计数 ----

test("二道脱敏：模型把密钥写进 op → 落盘前替换 [redacted]，journal 记 redacted 计数", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-redact-hit-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-redact-hit-"));
  try {
    // 模型回一条含 GitHub PAT 与 password= 赋值的 op（模拟"密钥经别的路径漏进 ops"）
    const keyText = '{"ops":[{"action":"write","name":"creds.md","type":"project","title":"Creds","description":"token=ghp_' + "a".repeat(30) + '","content":"部署用 password=hunter2super 与 ghp_' + "b".repeat(30) + ' 两处"}]}';
    await runExtraction({
      root,
      workspace,
      streamImpl: okStream(keyText),
      waitFor: settleAfter(12),
    });
    const { memoryDir } = projectMemoryPaths(root, workspace);
    const body = readFileSync(join(memoryDir, "creds.md"), "utf8");
    assert.doesNotMatch(body, /ghp_[ab]{30}/, "厂商标记不得原样落盘");
    assert.doesNotMatch(body, /hunter2super/, "password 值不得原样落盘");
    assert.match(body, /\[redacted\]/, "应落占位符");
    const runs = journalRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].outcome, "written");
    assert.ok(runs[0].redacted > 0, "journal 行应记 redacted 命中数（>0 才写）");
    assert.equal(typeof runs[0].redacted, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("二道脱敏：redactionEnabled=false → 完全不脱敏（回旧行为，回滚面）", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-redact-off-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-redact-off-"));
  try {
    const keyText = '{"ops":[{"action":"write","name":"creds-off.md","type":"project","title":"Creds","description":"d","content":"password=hunter2super"}]}';
    await runExtraction({
      root,
      workspace,
      config: { redactionEnabled: false },
      streamImpl: okStream(keyText),
      waitFor: settleAfter(12),
    });
    const { memoryDir } = projectMemoryPaths(root, workspace);
    const body = readFileSync(join(memoryDir, "creds-off.md"), "utf8");
    assert.match(body, /hunter2super/, "关脱敏后密钥原样落盘（旧行为）");
    assert.doesNotMatch(body, /\[redacted\]/);
    const runs = journalRuns(root);
    assert.equal(runs[0].redacted, void 0, "无命中不写 redacted 键");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("二道脱敏：无敏感内容 → journal 行不含 redacted 键（>0 才序列化）", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-redact-clean-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-redact-clean-"));
  try {
    await runExtraction({ root, workspace, streamImpl: okStream(), waitFor: settleAfter(12) });
    const runs = journalRuns(root);
    assert.equal(runs[0].outcome, "written");
    assert.equal(runs[0].redacted, void 0, "干净轮不写 redacted 键（旧行形态不变）");
    const file = readFileSync(join(root, JOURNAL_FILE_NAME), "utf8");
    assert.doesNotMatch(file, /"redacted"/, "盘上原始行也不含该键");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

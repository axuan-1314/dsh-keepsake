// 提取调用重试韧性：错误分类（route on code）/ 重试链+drain 纪律/
// 退避参数与纯函数 / retried·lastRecoveredAt 计数 / fallback 换道接线。
// 假 ctx 配方照 test/entry.test.mjs；DATA_DIR 隔离照各测试的 mkdtempSync(tmpdir())，
// 不写 ~/.dsh 真实数据、不真实调用任何 LLM（stream 全假队列）。
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
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
import { resetSettingsCache } from "../lib/settings.js";

const USER_EVENT = {
  type: "user/message",
  surfaceOp: "append",
  seq: 0,
  data: { role: "user", content: [{ type: "text", text: "记住 我们 团队 统一 用 pnpm" }] },
};

function fakeCtx(streamImpl) {
  const handlers = new Map();
  const sections = [];
  const streamCalls = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(type, fn) {
      handlers.set(type, fn);
    },
    effect(fn) {
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
  return { ctx, handlers, sections, streamCalls };
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
  apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 5000, ...config });
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
    isRetryableFailure({ code: null, message: "OpenCode Zen Free: Upstream request failed: Endpoint is unavailable." }, "dsh-memory: 提取调用异常结束 kind=error"),
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
  const root = mkdtempSync(join(tmpdir(), "dsh-memory-retry-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-memory-ws-retry-"));
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
  const root = mkdtempSync(join(tmpdir(), "dsh-memory-auth-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-memory-ws-auth-"));
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
  const root = mkdtempSync(join(tmpdir(), "dsh-memory-exhaust-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-memory-ws-exhaust-"));
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
  const root = mkdtempSync(join(tmpdir(), "dsh-memory-drain-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-memory-ws-drain-"));
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
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 1000, retryAttempts: 3, retryBackoffMs: 3000, retryMaxDelayMs: 3000 });
    // 摘出 lifecycle dispose 句柄（apply 注册的 ctx.effect 返回的清理函数）
    disposeFns = effects.filter((e) => e.label === "dsh-memory lifecycle").map((e) => e.fn());
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
  const root = mkdtempSync(join(tmpdir(), "dsh-memory-hang-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-memory-ws-hang-"));
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
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 1500, retryAttempts: 3, retryBackoffMs: 10, retryMaxDelayMs: 20 });
    const disposeFns = effects.filter((e) => e.label === "dsh-memory lifecycle").map((e) => e.fn());
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

test("fallback 换道接线：主道耗尽→换道成功→记 fallbackUsed + 落盘", async () => {
  resetSettingsCache();
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-memory-fb-wire-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-memory-ws-fb-wire-"));
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
  const root = mkdtempSync(join(tmpdir(), "dsh-memory-fb-fail-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-memory-ws-fb-fail-"));
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

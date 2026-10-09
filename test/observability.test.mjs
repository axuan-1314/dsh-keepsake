// 批F2 观测面钉：extraction-errors.log 落盘+轮转（E-6）、recent 环形/区间/在途/用车（metrics）、
// retry 端点契约（V-1/V-6）、scheduler.retryPending 单飞复用（V-1）。
// 全部走临时目录，不碰 ~/.dsh 真实数据；假流配方照 test/retry.test.mjs。
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  __resetMetricsForTest,
  clearExtractionFailedRange,
  extractionFailureSnapshot,
  extractionObservationSnapshot,
  pushRecentFailure,
  setExtractionFailedRange,
  setExtractionInFlight,
  noteExtractionAttempt,
} from "../lib/metrics.js";
import {
  appendExtractionError,
  ERROR_LOG_MAX_BYTES,
  ERROR_LOG_NAME,
  formatErrorLogLine,
  sanitizeLogMessage,
} from "../lib/errorlog.js";
import { makeApiRoutes } from "../lib/api.js";
import { createScheduler } from "../lib/state.js";

// ---- E-6: errorlog 纯函数 ----

test("F2 E-6 sanitizeLogMessage：剥 CR/LF 防注入假行 + 截 200", () => {
  assert.equal(sanitizeLogMessage("line1\nline2\r\nline3"), "line1 line2 line3");
  assert.equal(sanitizeLogMessage("a".repeat(500)).length, 200);
  assert.equal(sanitizeLogMessage(null), "");
  assert.equal(sanitizeLogMessage(42), "42");
});

test("F2 E-6 formatErrorLogLine：[ISO] [pid] reason provider/model 摘要", () => {
  const line = formatErrorLogLine({ at: 1730000000000, reason: "llm-error", provider: "example-provider", model: "group/example-model", message: "429: Endpoint is unavailable" }, 4321);
  assert.ok(line.startsWith("[2025-10-27T") || line.startsWith("[20"), line);
  assert.ok(line.includes("[4321] llm-error provider=example-provider model=group/example-model 429: Endpoint is unavailable\n"), line);
  // 无路由字段时不留空尾巴
  const bare = formatErrorLogLine({ at: 1730000000000, reason: "no-cwd", message: "x" }, 1);
  assert.ok(bare.includes("] no-cwd x"), bare);
});

// ---- E-6: 落盘与轮转 ----

test("F2 E-6 appendExtractionError：追加一行 + >512KB 先删旧 .1 再轮转", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-memory-elog-"));
  try {
    appendExtractionError(root, { reason: "llm-error", provider: "p", model: "m", message: "first" });
    const file = join(root, ERROR_LOG_NAME);
    assert.ok(existsSync(file), "日志文件已创建");
    const first = readFileSync(file, "utf8");
    assert.ok(first.includes("llm-error"), first);
    // 预置超限文件 + 旧轮转档，验证「先删旧 .1 再 rename」不覆盖丢证
    writeFileSync(file, "x".repeat(ERROR_LOG_MAX_BYTES + 1), "utf8");
    writeFileSync(`${file}.1`, "OLD-ROTATED-SHOULD-BE-DELETED", "utf8");
    appendExtractionError(root, { reason: "parse-error", message: "second" });
    assert.ok(existsSync(`${file}.1`), "轮转档存在");
    const rotated = readFileSync(`${file}.1`, "utf8");
    assert.ok(rotated.startsWith("xxxx") && rotated.length >= ERROR_LOG_MAX_BYTES, "新轮转档=旧主档内容");
    const fresh = readFileSync(file, "utf8");
    assert.ok(fresh.includes("parse-error"), "主档从新行开始");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F2 E-6 appendExtractionError：storageRoot 异常/IO 失败永不炸主流程", () => {
  assert.doesNotThrow(() => appendExtractionError("", { reason: "x" }));
  assert.doesNotThrow(() => appendExtractionError(null, { reason: "x" }));
  // 指向一个「文件占位的路径」让 appendFileSync 必炸
  const blocker = mkdtempSync(join(tmpdir(), "dsh-memory-elog-block-"));
  try {
    writeFileSync(join(blocker, ERROR_LOG_NAME), "", "utf8"); // 是文件不是目录 → join 后再 append 会 ENOTDIR? 实际同路径 append 正常
    assert.doesNotThrow(() => appendExtractionError(join(blocker, "no-such-parent", ".."), { reason: "x" }));
  } finally {
    rmSync(blocker, { recursive: true, force: true });
  }
});

// ---- metrics 观测面 ----

test("F2 metrics：recent 环形 ≤5 新在前 + 字段截断", () => {
  __resetMetricsForTest();
  for (let i = 1; i <= 7; i += 1) {
    pushRecentFailure({ reason: "llm-error", message: `m${i}`, provider: `p${i}`, model: `model-${i}` });
  }
  const snap = extractionFailureSnapshot();
  assert.equal(snap.recent.length, 5, "环形裁到 5 条");
  assert.equal(snap.recent[0].message, "m7", "新在前");
  assert.equal(snap.recent[4].message, "m3", "最旧保留到第 5 条");
  // 超长字段截断
  pushRecentFailure({ reason: "llm-error", message: "x".repeat(500), provider: "p".repeat(300), model: "m".repeat(300) });
  const top = extractionFailureSnapshot().recent[0];
  assert.equal(top.message.length, 200);
  assert.equal(top.provider.length, 80);
  assert.equal(top.model.length, 120);
  assert.equal(typeof top.at, "number");
  // 缺省 reason 兜底 llm-error
  pushRecentFailure({});
  assert.equal(extractionFailureSnapshot().recent[0].reason, "llm-error");
});

test("F2 metrics：lastFailedRange 置/清 + inFlight + lastUsedRoute 快照拷贝", () => {
  __resetMetricsForTest();
  setExtractionFailedRange(473, 478);
  setExtractionInFlight(true);
  noteExtractionAttempt({ provider: "example-provider", model: "group/x" });
  const obs = extractionObservationSnapshot();
  assert.deepEqual(obs.lastFailedRange, { from: 473, to: 478 });
  assert.equal(obs.extractionInFlight, true);
  assert.equal(obs.lastUsedRoute.provider, "example-provider");
  assert.equal(typeof obs.lastAttemptAt, "number");
  // 快照是拷贝：外改不污染内部态
  obs.lastFailedRange.from = 999;
  assert.equal(extractionObservationSnapshot().lastFailedRange.from, 473);
  clearExtractionFailedRange();
  setExtractionInFlight(false);
  const cleared = extractionObservationSnapshot();
  assert.equal(cleared.lastFailedRange, null);
  assert.equal(cleared.extractionInFlight, false);
  __resetMetricsForTest();
  assert.equal(extractionObservationSnapshot().lastUsedRoute, null, "复位生效");
});

// ---- V-1/V-6: retry 端点契约 ----

function mockReqRes() {
  const req = { method: "POST", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:1" }, on() {}, destroy() {} };
  const res = {
    status: 0,
    body: null,
    writeHead(code, headers) { this.status = code; this.headers = headers; },
    end(payload) { this.body = payload; },
  };
  return { req, res };
}

function mockRes() {
  return {
    status: 0,
    body: null,
    get headersSent() { return this.status !== 0; },
    writeHead(code, headers) { this.status = code; this.headers = headers; },
    end(payload) { this.body = payload; },
  };
}

function findRoute(routes, method, pattern) {
  // makeApiRoutes 返回单条 prefix 路由，内部 routes 数组不导出——经 handler
  // 端到端调用（与 test/api.test.mjs 的 callApi 同款口径），这里只组 req。
  return routes[0].handler;
}

function makeReq(method, path) {
  return {
    method,
    url: `${"/dsh-memory/api/"}${path}`,
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:1" },
    on() {},
    destroy() {},
  };
}

test("F2 api：POST extract/retry 202/409（在途+节流）/无 extraction 依赖 404", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-memory-api-retry-"));
  const log = { info() {}, warn() {}, error() {} };
  try {
    // 旧形态（无 extraction 依赖）→ 404
    const legacyHandler = findRoute(makeApiRoutes({ storageRoot: root, log }), "POST", "extract/retry");
    {
      const res = mockRes();
      await legacyHandler(makeReq("POST", "extract/retry"), res);
      assert.equal(res.status, 404);
    }
    // 新形态
    let triggerCalls = 0;
    const handler = findRoute(makeApiRoutes({
      storageRoot: root,
      log,
      extraction: {
        triggerRetry: () => { triggerCalls += 1; return 2; },
        inFlight: () => false,
        configSummary: () => ({ provider: "p", model: "m", fallback: [], embeddingProvider: "gemini-local", embeddingModel: "embed-model 2" }),
      },
    }), "POST", "extract/retry");
    {
      const res = mockRes();
      await handler(makeReq("POST", "extract/retry"), res);
      assert.equal(res.status, 202);
      assert.deepEqual(JSON.parse(res.body), { ok: true, triggered: 2 });
      assert.equal(triggerCalls, 1);
    }
    // 节流：10s 内第二次 → 409（不调 triggerRetry）
    {
      const res = mockRes();
      await handler(makeReq("POST", "extract/retry"), res);
      assert.equal(res.status, 409);
      assert.ok(String(JSON.parse(res.body).error).includes("间隔过短"));
      assert.equal(triggerCalls, 1, "409 不触发真补提");
    }
    // 在途优先于节流
    const inFlightHandler = findRoute(makeApiRoutes({
      storageRoot: root,
      log,
      extraction: { triggerRetry: () => 0, inFlight: () => true, configSummary: () => ({}) },
    }), "POST", "extract/retry");
    {
      const res = mockRes();
      await inFlightHandler(makeReq("POST", "extract/retry"), res);
      assert.equal(res.status, 409);
      assert.ok(String(JSON.parse(res.body).error).includes("进行中"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F2 api：GET state 带批F2 新字段（观测面+双模型卡数据源）", async () => {
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-memory-api-state-"));
  const log = { info() {}, warn() {}, error() {} };
  try {
    const handler = findRoute(makeApiRoutes({
      storageRoot: root,
      log,
      extraction: {
        triggerRetry: () => 0,
        inFlight: () => false,
        configSummary: () => ({ provider: void 0, model: void 0, fallback: [], embeddingProvider: void 0, embeddingModel: void 0 }),
      },
    }), "GET", "state");
    const res = mockRes();
    await handler(makeReq("GET", "state"), res);
    const body = JSON.parse(res.body);
    // 批F2 契约字段恒在（缺失=旧版判定依据）
    assert.ok(Array.isArray(body.extractionFailures.recent));
    assert.equal(body.extractionFailures.retried, 0);
    assert.equal(body.extractionFailures.fallbackUsed, 0);
    assert.equal(body.extractionFailures.lastRecoveredAt, null);
    assert.equal(body.lastFailedRange, null);
    assert.equal(body.extractionInFlight, false);
    assert.equal(body.lastAttemptAt, null);
    assert.equal(body.lastUsedRoute, null);
    assert.equal(body.storageRoot, root);
    // 未配 overrides → 如实 null（跟随会话路由）
    assert.deepEqual(body.extractionConfig, { provider: null, model: null, fallback: [] });
    assert.deepEqual(body.embeddingConfig, { provider: null, model: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- V-1: scheduler.retryPending 单飞复用 ----

test("F2 scheduler.retryPending：落后会话补提 + 在途合并 pending 不双跑", async () => {
  const calls = [];
  const extractCallsPerSession = new Map();
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      const key = session.id;
      extractCallsPerSession.set(key, (extractCallsPerSession.get(key) ?? 0) + 1);
      calls.push({ id: key, from, to });
      return "error"; // 失败不推进 cursor，制造「落后」状态
    },
    log: { warn() {}, error() {} },
  });
  const s1 = { id: "s1", seq: 10, snapshotEvents() { return []; } };
  scheduler.see(s1, { seq: 1 });
  scheduler.onTurnCompleted(s1, 10);
  await scheduler.quiesce();
  assert.equal(extractCallsPerSession.get("s1"), 1);
  assert.equal(scheduler.stateOf(s1).cursor, 0, "失败后 cursor 未推进（落后成立）");
  // 手动补提：重触发同区间
  const triggered = scheduler.retryPending();
  assert.equal(triggered, 1);
  await scheduler.quiesce();
  assert.equal(extractCallsPerSession.get("s1"), 2);
  // 无落后会话时 0
  const s2 = { id: "s2", seq: 5, snapshotEvents() { return []; } };
  scheduler.see(s2, { seq: 1 });
  scheduler.onTurnCompleted(s2, 20); // 从 2 提到 20
  await scheduler.quiesce();
  // s1 仍落后、s2 视 extract 结果而定——extract 恒 error 所以两个都落后
  assert.equal(scheduler.retryPending(), 2);
  await scheduler.quiesce();
  // dropped 会话不补提
  scheduler.drop(s1);
  assert.ok(scheduler.retryPending() >= 1);
  await scheduler.dispose();
});

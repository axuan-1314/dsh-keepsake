// 观测面钉：extraction-errors.log 落盘+轮转、recent 环形/区间/在途/用车（metrics）、
// retry 端点契约、scheduler.retryPending 单飞复用。
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
  injectionSnapshot,
  pushRecentFailure,
  recordInjection,
  recordInjectionError,
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
import { createJournal } from "../lib/journal.js";
import { effectiveEmbedding, readSettings, writeSettings } from "../lib/settings.js";

// ---- errorlog 纯函数 ----

test("sanitizeLogMessage：剥 CR/LF 防注入假行 + 截 200", () => {
  assert.equal(sanitizeLogMessage("line1\nline2\r\nline3"), "line1 line2 line3");
  assert.equal(sanitizeLogMessage("a".repeat(500)).length, 200);
  assert.equal(sanitizeLogMessage(null), "");
  assert.equal(sanitizeLogMessage(42), "42");
});

test("formatErrorLogLine：[ISO] [pid] reason provider/model 摘要", () => {
  const line = formatErrorLogLine({ at: 1730000000000, reason: "llm-error", provider: "acme", model: "group/chat-model", message: "429: Endpoint is unavailable" }, 4321);
  assert.ok(line.startsWith("[2025-10-27T") || line.startsWith("[20"), line);
  assert.ok(line.includes("[4321] llm-error provider=acme model=group/chat-model 429: Endpoint is unavailable\n"), line);
  // 无路由字段时不留空尾巴
  const bare = formatErrorLogLine({ at: 1730000000000, reason: "no-cwd", message: "x" }, 1);
  assert.ok(bare.includes("] no-cwd x"), bare);
});

// ---- 落盘与轮转 ----

test("appendExtractionError：追加一行 + >512KB 先删旧 .1 再轮转", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-elog-"));
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

test("appendExtractionError：storageRoot 异常/IO 失败永不炸主流程", () => {
  assert.doesNotThrow(() => appendExtractionError("", { reason: "x" }));
  assert.doesNotThrow(() => appendExtractionError(null, { reason: "x" }));
  // 指向一个「文件占位的路径」让 appendFileSync 必炸
  const blocker = mkdtempSync(join(tmpdir(), "dsh-keepsake-elog-block-"));
  try {
    writeFileSync(join(blocker, ERROR_LOG_NAME), "", "utf8"); // 是文件不是目录 → join 后再 append 会 ENOTDIR? 实际同路径 append 正常
    assert.doesNotThrow(() => appendExtractionError(join(blocker, "no-such-parent", ".."), { reason: "x" }));
  } finally {
    rmSync(blocker, { recursive: true, force: true });
  }
});

// ---- metrics 观测面 ----

test("metrics：recent 环形 ≤5 新在前 + 字段截断", () => {
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

test("metrics：lastFailedRange 置/清 + inFlight + lastUsedRoute 快照拷贝", () => {
  __resetMetricsForTest();
  setExtractionFailedRange(473, 478);
  setExtractionInFlight(true);
  noteExtractionAttempt({ provider: "acme", model: "group/x" });
  const obs = extractionObservationSnapshot();
  assert.deepEqual(obs.lastFailedRange, { from: 473, to: 478 });
  assert.equal(obs.extractionInFlight, true);
  assert.equal(obs.lastUsedRoute.provider, "acme");
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

// ---- 注入面（消息通道注入健康：记账 / 异常计数 / 快照不可变） ----

test("metrics：recordInjection 记账（count/chars/resend/dropped/lastAt）+ 缺省入参按 0", () => {
  __resetMetricsForTest();
  // 空态：字段恒在（缺失=旧版判据），值全零
  assert.deepEqual(injectionSnapshot(), {
    count: 0, lastChars: 0, totalChars: 0, resends: 0, droppedSegments: 0, renderFailures: 0, lastAt: null,
  });
  recordInjection({ chars: 120 });
  recordInjection({ chars: 80, dropped: ["globalIndex", "persona"], resend: true });
  const snap = injectionSnapshot();
  assert.equal(snap.count, 2);
  assert.equal(snap.lastChars, 80, "lastChars = 最近一次 chars");
  assert.equal(snap.totalChars, 200, "totalChars 累加");
  assert.equal(snap.resends, 1, "resend 为真才计补发");
  assert.equal(snap.droppedSegments, 2, "dropped.length 计入丢段累计");
  assert.equal(typeof snap.lastAt, "number");
  // 缺省入参：chars 0 / dropped 空 / 非 resend 不额外计数
  recordInjection();
  const dflt = injectionSnapshot();
  assert.equal(dflt.count, 3);
  assert.equal(dflt.lastChars, 0);
  assert.equal(dflt.totalChars, 200);
  assert.equal(dflt.resends, 1);
  __resetMetricsForTest();
});

test("metrics：recordInjectionError → renderFailures；快照不可变（改返回值不影响内部态）", () => {
  __resetMetricsForTest();
  recordInjectionError();
  recordInjectionError();
  assert.equal(injectionSnapshot().renderFailures, 2);
  // 快照是拷贝：外改不污染内部态
  const snap = injectionSnapshot();
  snap.count = 999;
  snap.droppedSegments = 999;
  snap.renderFailures = 999;
  const again = injectionSnapshot();
  assert.equal(again.count, 0);
  assert.equal(again.droppedSegments, 0);
  assert.equal(again.renderFailures, 2);
  __resetMetricsForTest();
  assert.equal(injectionSnapshot().renderFailures, 0, "复位生效");
  assert.equal(injectionSnapshot().lastAt, null);
});

// ---- retry 端点契约 ----

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
    url: `${"/dsh-keepsake/api/"}${path}`,
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:1" },
    on() {},
    destroy() {},
  };
}

test("api：POST extract/retry 202/409（在途+节流）/无 extraction 依赖 404", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-api-retry-"));
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
        configSummary: () => ({ provider: "p", model: "m", fallback: [], embeddingProvider: "gemini-local", embeddingModel: "EmbeddingGemma 2" }),
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

test("api：GET state 带新字段（观测面+双模型卡数据源）", async () => {
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-api-state-"));
  const log = { info() {}, warn() {}, error() {} };
  try {
    const handler = findRoute(makeApiRoutes({
      storageRoot: root,
      log,
      extraction: {
        triggerRetry: () => 0,
        inFlight: () => false,
        configSummary: () => ({ provider: void 0, model: void 0, fallback: [], embeddingProvider: void 0, embeddingModel: void 0, timeoutMs: 45000, recentKeepDays: 45 }),
      },
    }), "GET", "state");
    const res = mockRes();
    await handler(makeReq("GET", "state"), res);
    const body = JSON.parse(res.body);
    // 契约字段恒在（缺失=旧版判定依据）
    assert.ok(Array.isArray(body.extractionFailures.recent));
    assert.equal(body.extractionFailures.retried, 0);
    assert.equal(body.extractionFailures.fallbackUsed, 0);
    assert.equal(body.extractionFailures.lastRecoveredAt, null);
    assert.equal(body.lastFailedRange, null);
    assert.equal(body.extractionInFlight, false);
    assert.equal(body.lastAttemptAt, null);
    assert.equal(body.lastUsedRoute, null);
    assert.equal(body.storageRoot, root);
    // 契约：近期动态保留天数 / 单次提取超时为数字（接 configSummary 现值）
    assert.equal(body.recentKeepDays, 45);
    assert.equal(body.extractionTimeoutMs, 45000);
    assert.equal(body.settings.recentKeepDays, 45, "settings.recentKeepDays 回落到 config 现值");
    // 未配 overrides → 如实 null（跟随会话路由）
    assert.deepEqual(body.extractionConfig, { provider: null, model: null, fallback: [] });
    assert.deepEqual(body.embeddingConfig, { provider: null, model: null, baseUrl: "" });
    // 提取结算层（面板最近提取记录数据源）：字段恒在，无 journal 依赖时为标准空形
    assert.ok(Array.isArray(body.extractionLog.runs));
    assert.ok(Array.isArray(body.extractionLog.unrecovered));
    assert.deepEqual(body.extractionLog, { runs: [], unrecovered: [], abandoned: [], abandonedCount: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("api：GET state 的 extractionLog 反映 journal 记账（runs 新在前 + unrecovered）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-api-journal-"));
  const log = { info() {}, warn() {}, error() {} };
  try {
    const journal = createJournal({ storageRoot: root, log });
    journal.recordRun({ sessionId: "s1", from: 0, to: 5, cursorAfter: 5, outcome: "written", writes: 1, deletes: 0 });
    // 失败且 cursor 未动 → 进未恢复清单
    journal.recordRun({ sessionId: "s1", from: 5, to: 9, cursorAfter: 5, outcome: "failed", reason: "llm-error" });
    const handler = findRoute(makeApiRoutes({
      storageRoot: root,
      log,
      journal,
      extraction: { triggerRetry: () => 0, inFlight: () => false, configSummary: () => ({}) },
    }), "GET", "state");
    const res = mockRes();
    await handler(makeReq("GET", "state"), res);
    const body = JSON.parse(res.body);
    assert.equal(body.extractionLog.runs.length, 2);
    assert.equal(body.extractionLog.runs[0].outcome, "failed", "runs 新在前");
    assert.equal(body.extractionLog.runs[0].cursorAfter, 5);
    assert.equal(body.extractionLog.runs[1].outcome, "written");
    assert.equal(body.extractionLog.unrecovered.length, 1);
    assert.deepEqual(
      { from: body.extractionLog.unrecovered[0].from, to: body.extractionLog.unrecovered[0].to },
      { from: 5, to: 9 },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("api：只配 embeddingModel（不配 provider 标签）时 embeddingConfig 不再误判为未配置", async () => {
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-api-embcfg-"));
  const log = { info() {}, warn() {}, error() {} };
  try {
    const handler = findRoute(makeApiRoutes({
      storageRoot: root,
      log,
      extraction: {
        triggerRetry: () => 0,
        inFlight: () => false,
        configSummary: () => ({ provider: void 0, model: void 0, fallback: [], embeddingProvider: void 0, embeddingModel: "nomic-embed-text" }),
      },
    }), "GET", "state");
    const res = mockRes();
    await handler(makeReq("GET", "state"), res);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.embeddingConfig, { provider: null, model: "nomic-embed-text", baseUrl: "" });
    // 生效端点 URL 从 configSummary.embeddingEffective 取（未配置给空串）；apiKey 绝不出现在出参
    assert.equal("apiKey" in body.embeddingConfig, false, "不回显任何 apiKey");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("api：GET state 的 embeddingConfig.baseUrl 取生效嵌入端点（settings 优先），绝不回显 apiKey", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-api-emburl-"));
  const log = { info() {}, warn() {}, error() {} };
  try {
    writeSettings(root, { embedding: { enabled: true, baseUrl: "http://127.0.0.1:11434/v1/embeddings", model: "m", apiKey: "secret-key" } });
    const handler = findRoute(makeApiRoutes({
      storageRoot: root,
      log,
      extraction: {
        triggerRetry: () => 0,
        inFlight: () => false,
        configSummary: () => ({ embeddingEffective: effectiveEmbedding({ recallEnabled: false, embeddingBaseUrl: "", embeddingModel: "", embeddingProvider: "", embeddingApiKey: "", recallTopK: 5, recallMinScore: 0.35, recallTimeoutMs: 8000 }, readSettings(root)) }),
      },
    }), "GET", "state");
    const res = mockRes();
    await handler(makeReq("GET", "state"), res);
    const body = JSON.parse(res.body);
    assert.equal(body.embeddingConfig.baseUrl, "http://127.0.0.1:11434/v1/embeddings");
    assert.equal(JSON.stringify(body).includes("secret-key"), false, "响应体任何位置都不含明文 apiKey");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- scheduler.retryPending 单飞复用 ----

test("scheduler.retryPending：落后会话补提 + 在途合并 pending 不双跑", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-obs-retry-"));
  const calls = [];
  const extractCallsPerSession = new Map();
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      const key = session.id;
      extractCallsPerSession.set(key, (extractCallsPerSession.get(key) ?? 0) + 1);
      calls.push({ id: key, from, to });
      return { status: "error", detail: { outcome: "failed", reason: "llm-error" } }; // 失败不推进 cursor，制造「落后」状态
    },
    log: { warn() {}, error() {} },
    // 真 journal（临时根）：本例只验补提触发次数，落盘不参与断言
    journal: createJournal({ storageRoot: root, log: { info() {}, warn() {}, error() {} } }),
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
  // s1 仍落后、s2 视 extract 结果而定——extract 恒失败（status=error）所以两个都落后
  assert.equal(scheduler.retryPending(), 2);
  await scheduler.quiesce();
  // dropped 会话不补提
  scheduler.drop(s1);
  assert.ok(scheduler.retryPending() >= 1);
  await scheduler.dispose();
  rmSync(root, { recursive: true, force: true });
});

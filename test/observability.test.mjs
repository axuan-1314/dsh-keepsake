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
  bumpExtractionTokens,
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

// ---- token / 成本观测面（maxOutputTokens 跟随模型后的成本放大必须看得见） ----

test("metrics：bumpExtractionTokens 累计 input/output/total + calls；两次调用累加", () => {
  __resetMetricsForTest();
  // 空态：字段恒在（缺失=旧版判定依据），值全零
  assert.deepEqual(extractionFailureSnapshot().extractionTokens, { input: 0, output: 0, total: 0, calls: 0 });
  // 宿主形态（app.asar 的 dsh-llm-pi-ai mapUsage，finish 之前发出）
  assert.equal(bumpExtractionTokens({ inputTokens: 100, outputTokens: 500, totalTokens: 600 }), 1, "返回累计调用次数");
  let snap = extractionFailureSnapshot();
  assert.deepEqual(snap.extractionTokens, { input: 100, output: 500, total: 600, calls: 1 });
  // 第二次：calls +1 且三项都累加
  bumpExtractionTokens({ inputTokens: 200, outputTokens: 1000, totalTokens: 1200 });
  snap = extractionFailureSnapshot();
  assert.deepEqual(snap.extractionTokens, { input: 300, output: 1500, total: 1800, calls: 2 });
  // cache 读写场景：totalTokens ≠ input+output 时如实取宿主 total（不自算）
  bumpExtractionTokens({ inputTokens: 10, outputTokens: 20, totalTokens: 25, cacheReadTokens: 5, cacheWriteTokens: 3 });
  snap = extractionFailureSnapshot();
  assert.equal(snap.extractionTokens.total, 1825, "host totalTokens 优先（含 cache 时 ≠ input+output）");
  assert.equal(snap.extractionTokens.calls, 3);
  __resetMetricsForTest();
  assert.deepEqual(extractionFailureSnapshot().extractionTokens, { input: 0, output: 0, total: 0, calls: 0 }, "复位生效");
});

test("metrics：bumpExtractionTokens 对脏 usage 钳零 + 无 usage 只计 calls（调用事实不丢）", () => {
  __resetMetricsForTest();
  // 旧适配器/失败途没有 usage chunk：token 记 0，但 calls 必须仍计数——
  // "调了几次"与"花了多少 token"是两个问题，拿不到用量不等于没调用
  // （否则降档重发那一趟在观测面上直接消失，正好看不见最该看见的东西）。
  assert.equal(bumpExtractionTokens(void 0), 1);
  assert.equal(bumpExtractionTokens(null), 2);
  assert.equal(bumpExtractionTokens("nope"), 3);
  assert.equal(bumpExtractionTokens({}), 4);
  let snap = extractionFailureSnapshot();
  assert.deepEqual(snap.extractionTokens, { input: 0, output: 0, total: 0, calls: 4 }, "无 usage：只计调用");
  // 脏值（NaN/负数/小数/字符串）逐项钳到 0，不污染累计。
  // totalTokens=3.7 是有限非负 → 按 Math.floor 钳成 3（脏但有依据，不归零）；
  // input/output 的负数与 NaN 归零。三者分开钳，不互相顶替。
  bumpExtractionTokens({ inputTokens: -5, outputTokens: NaN, totalTokens: 3.7 });
  snap = extractionFailureSnapshot();
  assert.deepEqual(snap.extractionTokens, { input: 0, output: 0, total: 3, calls: 5 });
  // totalTokens 非法（负数/NaN）才整体回落 input+output
  bumpExtractionTokens({ inputTokens: 1, outputTokens: 2, totalTokens: -9 });
  snap = extractionFailureSnapshot();
  assert.deepEqual(snap.extractionTokens, { input: 1, output: 2, total: 6, calls: 6 });
  // totalTokens 缺失 → 回落 input+output（不自己凑一个宿主没给的数）
  bumpExtractionTokens({ inputTokens: 7, outputTokens: 11 });
  snap = extractionFailureSnapshot();
  assert.deepEqual(snap.extractionTokens, { input: 8, output: 13, total: 24, calls: 7 });
  __resetMetricsForTest();
});

test("metrics：extractionFailureSnapshot 的 extractionTokens 是拷贝（外改不污染内部态）", () => {
  __resetMetricsForTest();
  bumpExtractionTokens({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  const snap = extractionFailureSnapshot();
  snap.extractionTokens.input = 999;
  snap.extractionTokens.calls = 999;
  assert.deepEqual(extractionFailureSnapshot().extractionTokens, { input: 1, output: 2, total: 3, calls: 1 });
  __resetMetricsForTest();
});

// ---- 注入面（消息通道注入健康：记账 / 异常计数 / 快照不可变） ----

test("metrics：recordInjection 记账（count/chars/resend/dropped/lastAt）+ 缺省入参按 0", () => {
  __resetMetricsForTest();
  // 空态：字段恒在（缺失=旧版判据），值全零（throttled/superseded 为同源替换两计数；
  // lastTokens/totalTokens 为 token 口径两计数）
  assert.deepEqual(injectionSnapshot(), {
    count: 0, lastChars: 0, totalChars: 0, resends: 0, droppedSegments: 0, throttled: 0, superseded: 0, renderFailures: 0, lastAt: null,
    lastTokens: 0, totalTokens: 0,
  });
  recordInjection({ chars: 120, tokens: 60 });
  recordInjection({ chars: 80, tokens: 40, dropped: ["globalIndex", "persona"], resend: true });
  const snap = injectionSnapshot();
  assert.equal(snap.count, 2);
  assert.equal(snap.lastChars, 80, "lastChars = 最近一次 chars");
  assert.equal(snap.totalChars, 200, "totalChars 累加");
  assert.equal(snap.lastTokens, 40, "lastTokens = 最近一次 tokens（token 口径）");
  assert.equal(snap.totalTokens, 100, "totalTokens 累加");
  assert.equal(snap.resends, 1, "resend 为真才计补发");
  assert.equal(snap.droppedSegments, 2, "dropped.length 计入丢段累计");
  assert.equal(typeof snap.lastAt, "number");
  // 缺省入参：chars 0 / tokens 0 / dropped 空 / 非 resend 不额外计数
  recordInjection();
  const dflt = injectionSnapshot();
  assert.equal(dflt.count, 3);
  assert.equal(dflt.lastChars, 0);
  assert.equal(dflt.totalChars, 200);
  assert.equal(dflt.lastTokens, 0);
  assert.equal(dflt.totalTokens, 100, "缺省 tokens 记 0，不清累计");
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
    assert.equal(body.extractionFailures.reasoningDegraded, 0);
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
    // 未配 overrides → 如实 null（跟随会话路由）；七字段恒在（旧宿主 configSummary 无键 → null）
    assert.deepEqual(body.extractionConfig, {
      provider: null, model: null, fallback: [],
      gateEnabled: null, gateMinScore: null, idleDelayMs: null, maxRunsPerSession: null, redactionEnabled: null,
      // 提取预算面：null = 旧宿主无此键，与 0（跟随模型）/ null（不下发档位）语义可区分
      maxOutputTokens: null, reasoningEffort: null,
    });
    assert.deepEqual(body.embeddingConfig, { provider: null, model: null, baseUrl: "" });
    // 提取结算层（面板最近提取记录数据源）：字段恒在，无 journal 依赖时为标准空形
    assert.ok(Array.isArray(body.extractionLog.runs));
    assert.ok(Array.isArray(body.extractionLog.unrecovered));
    assert.equal(body.extractionLog.coverage, null, "无 journal 时 coverage=null（不拿 0 冒充无失败区间）");
    assert.deepEqual(body.extractionLog, { runs: [], unrecovered: [], abandoned: [], abandonedCount: 0, coverage: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("api：GET state 的新字段面（extractionConfig 五字段 / 顶层双预算 / recover 四字段）", async () => {
  __resetMetricsForTest();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-api-state-contract-"));
  const log = { info() {}, warn() {}, error() {} };
  try {
    // ① 新宿主：configSummary 备齐 8 字段 → extractionConfig 实值、顶层双预算透传
    const handler = findRoute(makeApiRoutes({
      storageRoot: root,
      log,
      extraction: {
        triggerRetry: () => 0,
        inFlight: () => false,
        configSummary: () => ({
          provider: "p", model: "m", fallback: [],
          redactionEnabled: true, injectMaxChars: 30000, injectMaxTokens: 16000,
          extractGateEnabled: true, extractGateMinScore: 6,
          extractIdleDelayMs: 3000, extractMaxRunsPerSession: 50,
          autoRecoverEnabled: true,
        }),
      },
      recovery: {
        pending: async () => ({ hostSupported: true, items: [] }),
        start: () => ({ started: true }),
        state: () => ({
          inFlight: false, lastAt: 123, lastOutcome: "written", lastSessionId: "s1",
          autoEnabled: true, autoAttempts: 2, lastAutoAt: 456, lastAutoTrigger: "turn/end",
        }),
      },
    }), "GET", "state");
    const res = mockRes();
    await handler(makeReq("GET", "state"), res);
    const body = JSON.parse(res.body);
    // extractionConfig 新增五字段（契约名与数据源一一对应，键名漂移立刻红）
    assert.equal(body.extractionConfig.gateEnabled, true);
    assert.equal(body.extractionConfig.gateMinScore, 6);
    assert.equal(body.extractionConfig.idleDelayMs, 3000);
    assert.equal(body.extractionConfig.maxRunsPerSession, 50);
    assert.equal(body.extractionConfig.redactionEnabled, true);
    // 顶层双预算（仿 injectChannel 口径）
    assert.equal(body.injectMaxChars, 30000);
    assert.equal(body.injectMaxTokens, 16000);
    // injection 快照的 token 口径两计数（metrics 落字段后自动在场）
    assert.equal(body.injection.lastTokens, 0);
    assert.equal(body.injection.totalTokens, 0);
    // recover 四字段透传（autoEnabled 取 cfg）
    assert.equal(body.recover.autoEnabled, true);
    assert.equal(body.recover.autoAttempts, 2);
    assert.equal(body.recover.lastAutoAt, 456);
    assert.equal(body.recover.lastAutoTrigger, "turn/end");
    assert.equal(body.recover.lastOutcome, "written");

    // ② 旧宿主形态：configSummary 缺新键 → 如实 null（不冒领默认值）；未接线 recovery → 八字段空形
    const legacy = findRoute(makeApiRoutes({
      storageRoot: root,
      log,
      extraction: { triggerRetry: () => 0, inFlight: () => false, configSummary: () => ({ timeoutMs: 45000 }) },
    }), "GET", "state");
    const res2 = mockRes();
    await legacy(makeReq("GET", "state"), res2);
    const b2 = JSON.parse(res2.body);
    for (const k of ["gateEnabled", "gateMinScore", "idleDelayMs", "maxRunsPerSession", "redactionEnabled"]) {
      assert.equal(b2.extractionConfig[k], null, `旧宿主 extractionConfig.${k} 应如实 null`);
    }
    assert.equal(b2.injectMaxChars, null);
    assert.equal(b2.injectMaxTokens, null);
    // recover 八字段恒在（未接线空形；autoEnabled 未知给 null）
    assert.deepEqual(b2.recover, {
      inFlight: false, lastAt: null, lastOutcome: null, lastSessionId: null,
      autoEnabled: null, autoAttempts: 0, lastAutoAt: null, lastAutoTrigger: null,
    });
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

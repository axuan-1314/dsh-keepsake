// session-recovery-wiring：会话补提接线（跨重启把盘上的失败区间读回重提）。
//   驱动真插件入口 apply() —— 走它自供的 REST 面（GET /sessions/pending、POST /sessions/recover），
//   宿主会话持久化层用假实现（形状对齐 ctx.sessionPersistence：open/stat/list）。
//   钉三件事（都是补提接线的记账要害）：
//     ① 补提成功后 journal 的 pending 出列（cursorAfter=to）；
//     ② 补提失败后区间仍留在未恢复清单（cursorAfter=from）；
//     ③ 已有补提在跑时第二次调用 409 E_BUSY（单飞）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { API_PREFIX, makeApiRoutes } from "../lib/api.js";
import { apply } from "../lib/index.js";
import { createJournal } from "../lib/journal.js";
import { writeSettings } from "../lib/settings.js";

const silentLog = { info() {}, warn() {}, error() {} };

function mockReq({ method, url, body }) {
  const req = new Readable({
    read() {
      if (body !== void 0) this.push(typeof body === "string" ? body : JSON.stringify(body));
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

/**
 * 假宿主 ctx：捕获 webServer 路由、把 sessionPersistence 经 ctx.get 暴露。
 * @param {object|null} persistence 假会话持久化服务（null = 旧版宿主没这能力）
 */
function fakeCtx(persistence) {
  const handlers = new Map();
  const routes = [];
  const disposers = [];
  const ctx = {
    logger: silentLog,
    get(name) { return name === "sessionPersistence" ? persistence : void 0; },
    on(event, handler) { handlers.set(event, handler); return () => {}; },
    effect(fn) { try { const result = fn(); if (typeof result === "function") disposers.push(result); } catch { /* disposer 忽略 */ } return () => {}; },
    inject(_deps, setup) {
      setup({ effect(fn) { fn(); }, webServer: { register(route) { routes.push(route); return () => {}; } } });
    },
    systemPrompt: { section() { return () => {}; } },
    llm: { stream() { throw new Error("补提测试不应真调 LLM（走 skip/无 cwd 早退路径）"); } },
  };
  return { ctx, handlers, routes, disposers };
}

/** 假持久化：stat 给会话头部（决定 cwd 有无），open 给只读句柄。open 可挂起（单飞测试用）。 */
function fakePersistence({ sessions = new Map(), headerOf = () => ({ cwd: "" }), holdOpen = false } = {}) {
  let releaseOpen;
  const gate = holdOpen ? new Promise((resolve) => { releaseOpen = resolve; }) : null;
  return {
    _sessions: sessions,
    _release: () => { if (releaseOpen) releaseOpen(); },
    stat(id) {
      if (!sessions.has(id)) return null;
      return headerOf(id);
    },
    list() { return [...sessions.keys()]; },
    async open(id, mode) {
      assert.equal(mode, "read");
      if (gate !== null) await gate;
      const events = sessions.get(id) ?? [];
      return { header: headerOf(id), read(offset, length) { return { events: events.slice(offset, offset + length) }; }, close() {} };
    },
  };
}

/** 建一个只带 API 面的实例（复用真 index.js 的 apply，只取它注册的 API 路由）。 */
function apiHandlerFor(storageRoot, persistence, journal) {
  const { ctx, routes } = fakeCtx(persistence);
  apply(ctx, { enabled: true, storageRoot, injectChannel: "section" }); // section 侧不注册 pre-step，省去无关面
  // 真 index.js 注册的 API + 面板路由里，取 API 那条（/dsh-keepsake/api）
  const apiRoute = routes.find((r) => r.kind === "prefix" && r.path === API_PREFIX.replace(/\/$/, ""));
  assert.ok(apiRoute, "apply 应注册 API 路由");
  void journal; // journal 由 apply 内部创建；此处只用作引用对照
  return apiRoute.handler;
}

async function callApi(handler, { method, path, body }) {
  const req = mockReq({ method, url: API_PREFIX + path, body });
  const res = mockRes();
  await handler(req, res);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

/** 轮询到补提不再在途（background 任务收口）。 */
async function waitSettled(handler, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await callApi(handler, { method: "GET", path: "state" });
    if (json.recover && json.recover.inFlight === false && json.recover.lastOutcome !== "running" && json.recover.lastOutcome !== null) return json.recover;
    if (Date.now() > deadline) throw new Error(`补提未在 ${timeoutMs}ms 内收口：${JSON.stringify(json.recover)}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-recover-wiring-"));
}

/** n 条合成用户消息事件。补提区间校验要求 to 不超过读回事件数——夹具照真实形态给足事件。 */
function userEvents(n) {
  return Array.from({ length: n }, (_, i) => ({
    type: "user/message",
    data: { role: "user", content: [{ type: "text", text: `第 ${i} 条 用户内容` }] },
  }));
}

test("补提成功（闸门 skip 也推进）→ journal 的 pending 出列", async () => {
  const root = freshRoot();
  try {
    // 盘上先有一条未恢复失败区间：sess-ok 的 [0, 5) 失败（cursorAfter=0）。
    // recordRun 的落盘是异步队列——必须 await，否则 apply 构造的 journal 重放时行还没写下去。
    const seed = createJournal({ storageRoot: root, log: silentLog });
    await seed.recordRun({ sessionId: "sess-ok", from: 0, to: 5, cursorAfter: 0, outcome: "failed", reason: "llm-error" });
    assert.equal(seed.snapshot().unrecovered.length, 1, "前提：有未恢复区间");
    // 总开关关 → extractSession 走 skipped（status ok），cursor 推进到 to
    writeSettings(root, { conversationMemory: false }, silentLog);
    const persistence = fakePersistence({ sessions: new Map([["sess-ok", userEvents(5)]]), headerOf: () => ({ cwd: root }) });
    const handler = apiHandlerFor(root, persistence, seed);

    const pending = await callApi(handler, { method: "GET", path: "sessions/pending" });
    assert.equal(pending.status, 200);
    assert.equal(pending.json.hostSupported, true);
    assert.equal(pending.json.items.length, 1);
    assert.equal(pending.json.items[0].sessionAvailable, true);

    const rec = await callApi(handler, { method: "POST", path: "sessions/recover", body: { sessionId: "sess-ok", from: 0, to: 5 } });
    assert.equal(rec.status, 202);
    assert.equal(rec.json.started, true);

    const recover = await waitSettled(handler);
    assert.equal(recover.lastOutcome, "skipped", "闸门关 → skip 也推进（与在线口径一致）");
    // 出列判据（整段覆盖：from 不晚于起点且 cursorAfter >= to）：再取一次清单应已空
    const after = await callApi(handler, { method: "GET", path: "sessions/pending" });
    assert.equal(after.json.items.length, 0, "补提成功后 pending 应出列");
    // 盘上核对：重放新 journal（apply 内部那个实例不可外取，走同一文件重放）
    const fresh = createJournal({ storageRoot: root, log: silentLog });
    assert.equal(fresh.snapshot().unrecovered.length, 0, "盘上未恢复清单也应清空");
    const rec2 = fresh.snapshot().runs[0];
    assert.equal(rec2.sessionId, "sess-ok");
    assert.equal(rec2.cursorAfter, 5, "成功补提落 cursorAfter=to");
    assert.equal(rec2.to, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("补提失败（无 cwd 结构性失败）→ 区间仍留在未恢复清单", async () => {
  const root = freshRoot();
  try {
    const journal = createJournal({ storageRoot: root, log: silentLog });
    await journal.recordRun({ sessionId: "sess-bad", from: 0, to: 5, cursorAfter: 0, outcome: "failed", reason: "llm-error" });
    // stat 不给 cwd → 适配器 cwd="" → extractSession 记 no-cwd 失败（status error）
    const persistence = fakePersistence({ sessions: new Map([["sess-bad", userEvents(5)]]), headerOf: () => ({}) });
    const handler = apiHandlerFor(root, persistence, journal);

    const rec = await callApi(handler, { method: "POST", path: "sessions/recover", body: { sessionId: "sess-bad", from: 0, to: 5 } });
    assert.equal(rec.status, 202);
    const recover = await waitSettled(handler);
    assert.match(recover.lastOutcome, /^failed/, "失败结果如实标注");

    const after = await callApi(handler, { method: "GET", path: "sessions/pending" });
    // 失败后该区间仍在未恢复清单（可再补）。清单里可能同区间出现多条（seed 那条 + 本次
    // 失败又记的一条）——判据是"这段还在等补"，不是"条数恰好 1"，故按存在性断言。
    assert.ok(after.json.items.length >= 1, "失败后区间仍在未恢复清单（可再补）");
    assert.ok(after.json.items.some((it) => it.sessionId === "sess-bad" && it.from === 0 && it.to === 5), "0..5 区间仍在清单");
    const fresh = createJournal({ storageRoot: root, log: silentLog });
    const latest = fresh.snapshot().runs[0];
    assert.equal(latest.sessionId, "sess-bad");
    assert.equal(latest.cursorAfter, 0, "失败不推进 cursor（cursorAfter=from=0）");
    assert.equal(latest.outcome, "failed");
    assert.ok(fresh.snapshot().unrecovered.length >= 1, "盘上区间仍在未恢复清单");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("单飞：已有补提在跑时第二次调用 409 E_BUSY", async () => {
  const root = freshRoot();
  try {
    const journal = createJournal({ storageRoot: root, log: silentLog });
    await journal.recordRun({ sessionId: "sess-hold", from: 0, to: 5, cursorAfter: 0, outcome: "failed", reason: "llm-error" });
    // 放行后走闸门 skip 早退（不真调 LLM）；open 挂起 → 第一次补提停在读事件处，inFlight 保持 true
    writeSettings(root, { conversationMemory: false }, silentLog);
    const persistence = fakePersistence({ sessions: new Map([["sess-hold", userEvents(5)]]), headerOf: () => ({ cwd: root }), holdOpen: true });
    const handler = apiHandlerFor(root, persistence, journal);

    const first = await callApi(handler, { method: "POST", path: "sessions/recover", body: { sessionId: "sess-hold", from: 0, to: 5 } });
    assert.equal(first.status, 202);
    // 确认已在途
    await new Promise((r) => setTimeout(r, 20));
    const mid = await callApi(handler, { method: "GET", path: "state" });
    assert.equal(mid.json.recover.inFlight, true, "第一次补提应在途");

    const second = await callApi(handler, { method: "POST", path: "sessions/recover", body: { sessionId: "sess-hold", from: 0, to: 5 } });
    assert.equal(second.status, 409);
    assert.equal(second.json.code, "E_BUSY");

    persistence._release(); // 放行第一次，等它收口避免悬挂
    await waitSettled(handler);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("host 无 sessionPersistence → pending 标 hostSupported:false；recover 503", async () => {
  const root = freshRoot();
  try {
    const journal = createJournal({ storageRoot: root, log: silentLog });
    const handler = apiHandlerFor(root, null, journal); // 宿主没这服务
    const pending = await callApi(handler, { method: "GET", path: "sessions/pending" });
    assert.equal(pending.status, 200);
    assert.equal(pending.json.hostSupported, false);
    const rec = await callApi(handler, { method: "POST", path: "sessions/recover", body: { sessionId: "x", from: 0, to: 5 } });
    assert.equal(rec.status, 503);
    assert.equal(rec.json.code, "E_HOST_UNSUPPORTED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("会话不存在 → POST /sessions/recover 404 E_SESSION_NOT_FOUND（stat 探不到）", async () => {
  const root = freshRoot();
  try {
    const journal = createJournal({ storageRoot: root, log: silentLog });
    // 持久化层里没有 sess-ghost：stat 返回 null
    const persistence = fakePersistence({ sessions: new Map(), headerOf: () => ({ cwd: root }) });
    const handler = apiHandlerFor(root, persistence, journal);
    const rec = await callApi(handler, { method: "POST", path: "sessions/recover", body: { sessionId: "sess-ghost", from: 0, to: 5 } });
    assert.equal(rec.status, 404);
    assert.equal(rec.json.code, "E_SESSION_NOT_FOUND");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("区间超出读回范围 → 显式失败不记账：未恢复区间原样留着（不静默丢尾部记忆）", async () => {
  const root = freshRoot();
  try {
    // 盘上先有一条未恢复区间 sess-range 的 [0, 20)（cursorAfter=0）。
    const seed = createJournal({ storageRoot: root, log: silentLog });
    await seed.recordRun({ sessionId: "sess-range", from: 0, to: 20, cursorAfter: 0, outcome: "failed", reason: "llm-error" });
    assert.equal(seed.snapshot().unrecovered.length, 1, "前提：有未恢复区间");
    // 会话实际只有 10 条事件：请求 [0,20) 超出读回范围（读回截断/越界 to 的同一条防线）。
    const persistence = fakePersistence({ sessions: new Map([["sess-range", userEvents(10)]]), headerOf: () => ({ cwd: root }) });
    const handler = apiHandlerFor(root, persistence, seed);

    const rec = await callApi(handler, { method: "POST", path: "sessions/recover", body: { sessionId: "sess-range", from: 0, to: 20 } });
    assert.equal(rec.status, 202, "异步启动照旧（范围校验在执行体内）");
    const recover = await waitSettled(handler);
    assert.equal(recover.lastOutcome, "failed:range-unavailable", "越界区间应显式失败，不假装补过");

    const after = await callApi(handler, { method: "GET", path: "sessions/pending" });
    assert.equal(after.json.items.length, 1, "未恢复区间不得出列");
    const fresh = createJournal({ storageRoot: root, log: silentLog });
    assert.equal(fresh.snapshot().unrecovered.length, 1, "盘上未恢复清单照旧");
    assert.equal(fresh.snapshot().runs.length, 1, "越界请求不得写结算行（原种子行之外零新增）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// 自动补提：三触发面 / 冷却 / 单飞 / abandoned 不碰 / host 降级。
// 驱动真 index.js 的 apply()：直接调它注册的 session/disposed 与 session/event 处理器
//（比走 API 更贴触发面本体），观测面经 GET /state.recover（与 api 消费同源）。
// ============================================================

/** apply 真入口并同时取回 API 路由与事件处理器（自动补提的触发面在事件侧）。 */
function appWithHandlers(storageRoot, persistence, config = {}) {
  const { ctx, handlers, routes, disposers } = fakeCtx(persistence);
  apply(ctx, {
    enabled: true,
    storageRoot,
    injectChannel: "section", // section 侧不注册 pre-step，省去无关面
    extractIdleDelayMs: 0, // 非延迟用例显式 0（防 3s 默认拖尾）
    ...config,
  });
  const apiRoute = routes.find((r) => r.kind === "prefix" && r.path === API_PREFIX.replace(/\/$/, ""));
  assert.ok(apiRoute, "apply 应注册 API 路由");
  return { handler: apiRoute.handler, handlers, ctx, disposers };
}

/** 种子：盘上写一条未恢复失败区间（cursorAfter=from → 进 pending）。 */
async function seedFailed(root, sessionId, from, to, reason = "llm-error") {
  const seed = createJournal({ storageRoot: root, log: silentLog });
  await seed.recordRun({ sessionId, from, to, cursorAfter: from, outcome: "failed", reason });
  return seed;
}

/** 常驻会话对象（turn/end 触发面要有个 session 递进 scheduler.see）。 */
function liveSession(cwd, events = []) {
  return {
    id: "sess-live",
    seq: events.length,
    header: { cwd },
    snapshotEvents(from, to) { return events.slice(from, to); },
  };
}

test("自动补提 disposed 触发：只补该会话未恢复区间（别会话区间不碰），journal 出列 + 观测面记录", async () => {
  const root = freshRoot();
  try {
    await seedFailed(root, "sess-a", 0, 5);
    await seedFailed(root, "sess-b", 0, 5);
    writeSettings(root, { conversationMemory: false }, silentLog); // 闸门关 → 补提走 skipped（成功面）
    const persistence = fakePersistence({
      sessions: new Map([["sess-a", userEvents(5)], ["sess-b", userEvents(5)]]),
      headerOf: () => ({ cwd: root }),
    });
    const { handler, handlers } = appWithHandlers(root, persistence);

    handlers.get("session/disposed")({ id: "sess-a" }); // disposed 触发面：限定 sess-a
    const recover = await waitSettled(handler);
    assert.equal(recover.autoEnabled, true, "autoEnabled 恒在");
    assert.equal(recover.autoAttempts, 1, "启动一次自动补提");
    assert.equal(recover.lastAutoTrigger, "disposed", "触发面标记如实");
    assert.equal(recover.lastOutcome, "skipped", "闸门关 → skip 也推进（与在线口径一致）");
    assert.ok(typeof recover.lastAutoAt === "number", "lastAutoAt 落时刻");

    const after = await callApi(handler, { method: "GET", path: "sessions/pending" });
    assert.equal(after.json.items.length, 1, "sess-a 出列、sess-b 原样留守");
    assert.equal(after.json.items[0].sessionId, "sess-b", "只补 disposed 的那一个会话");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("自动补提 turn/end 触发：全局清扫未恢复区间（journal 是收口事实源）", async () => {
  const root = freshRoot();
  try {
    await seedFailed(root, "sess-sweep", 0, 5);
    writeSettings(root, { conversationMemory: false }, silentLog);
    const persistence = fakePersistence({ sessions: new Map([["sess-sweep", userEvents(5)]]), headerOf: () => ({ cwd: root }) });
    const { handler, handlers } = appWithHandlers(root, persistence);

    const session = liveSession(root, []);
    handlers.get("session/event")(session, { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    const recover = await waitSettled(handler);
    assert.equal(recover.lastAutoTrigger, "turn/end");
    assert.equal(recover.autoAttempts, 1);
    const after = await callApi(handler, { method: "GET", path: "sessions/pending" });
    assert.equal(after.json.items.length, 0, "全局清扫后未恢复清单出列");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("启动清扫：apply 装载后 ~5s 定时器触发（跨重启续提闭环；定时器 unref 不挂进程）", async () => {
  const root = freshRoot();
  try {
    await seedFailed(root, "sess-boot", 0, 5);
    writeSettings(root, { conversationMemory: false }, silentLog);
    const persistence = fakePersistence({ sessions: new Map([["sess-boot", userEvents(5)]]), headerOf: () => ({ cwd: root }) });
    // 拦截 apply 期间创建的定时器：钉"挂了 5s 清扫且 unref"，然后手动触发到点
    //（不真等 5s：真实等待只增时长、不减验证力——到点行为由被捕获的回调本体承担）。
    const realSetTimeout = globalThis.setTimeout;
    const captured = [];
    const unrefCalls = [];
    globalThis.setTimeout = (fn, ms, ...args) => {
      const entry = { fn, ms, args, unrefCalled: false };
      captured.push(entry);
      return {
        unref() { entry.unrefCalled = true; unrefCalls.push(ms); },
        ref() {},
      }; // 不真排程（测试自己调 fn）
    };
    let app;
    try {
      app = appWithHandlers(root, persistence);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    const sweep = captured.find((c) => c.ms === 5000);
    assert.ok(sweep, `装载后应挂 5s 启动清扫定时器（捕获：${captured.map((c) => c.ms).join(",")}）`);
    assert.equal(sweep.unrefCalled, true, "启动清扫定时器必须 unref（绝不许测试/宿主进程被它挂住）");

    sweep.fn(); // 到点
    const recover = await waitSettled(app.handler);
    assert.equal(recover.lastAutoTrigger, "startup", "启动清扫触发面");
    assert.equal(recover.autoAttempts, 1);
    const after = await callApi(app.handler, { method: "GET", path: "sessions/pending" });
    assert.equal(after.json.items.length, 0, "启动清扫把上次进程没补成的区间续上");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("自动补提冷却：同区间冷却窗内不再试（防 range-unavailable 永不出列的区间被反复白读）；过期后可再试", async () => {
  const root = freshRoot();
  try {
    // 区间 [0,20) 但会话只有 10 条事件 → 每次补提都 range-unavailable、永不出列（冷却要拦的正是它）
    await seedFailed(root, "sess-cool", 0, 20);
    const persistence = fakePersistence({ sessions: new Map([["sess-cool", userEvents(10)]]), headerOf: () => ({ cwd: root }) });
    const { handler, handlers } = appWithHandlers(root, persistence, { autoRecoverCooldownMs: 500 });
    const disposed = handlers.get("session/disposed");

    disposed({ id: "sess-cool" }); // 第 1 次：真实尝试
    const first = await waitSettled(handler);
    assert.equal(first.lastOutcome, "failed:range-unavailable", "前提：该区间确会失败");
    assert.equal(first.autoAttempts, 1);

    disposed({ id: "sess-cool" }); // 第 2 次：冷却窗内 —— 不试
    await new Promise((r) => setTimeout(r, 30));
    const second = await callApi(handler, { method: "GET", path: "state" });
    assert.equal(second.json.recover.autoAttempts, 1, "冷却窗内不得再试（autoAttempts 不涨）");
    assert.equal(second.json.recover.inFlight, false, "也确实没有在跑的补提");

    // 过期后再试：上次尝试后 500ms 已过（余量 200ms，抗负载抖动）
    await new Promise((r) => setTimeout(r, 700));
    disposed({ id: "sess-cool" });
    const third = await waitSettled(handler);
    assert.equal(third.autoAttempts, 2, "冷却过期后允许再试（不是永久封锁）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("自动补提单飞：自动补提在途时新一轮触发直接丢弃（绝不并发；不同区间也被 busy 拦住）", async () => {
  const root = freshRoot();
  try {
    await seedFailed(root, "sess-hold", 0, 5);
    await seedFailed(root, "sess-other", 0, 5);
    writeSettings(root, { conversationMemory: false }, silentLog);
    // open 挂起 → 第一次自动补提停在读事件处，inFlight 保持 true
    const persistence = fakePersistence({
      sessions: new Map([["sess-hold", userEvents(5)], ["sess-other", userEvents(5)]]),
      headerOf: () => ({ cwd: root }),
      holdOpen: true,
    });
    const { handler, handlers } = appWithHandlers(root, persistence);
    const disposed = handlers.get("session/disposed");

    disposed({ id: "sess-hold" });
    await new Promise((r) => setTimeout(r, 20));
    const mid = await callApi(handler, { method: "GET", path: "state" });
    assert.equal(mid.json.recover.inFlight, true, "第 1 次自动补提应在途");

    disposed({ id: "sess-other" }); // 不同区间（不受冷却约束），但单飞 busy → 丢弃
    await new Promise((r) => setTimeout(r, 20));
    const after = await callApi(handler, { method: "GET", path: "state" });
    assert.equal(after.json.recover.autoAttempts, 1, "busy 即丢：不得启动第二个补提");

    persistence._release(); // 放行收口
    await waitSettled(handler);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("自动补提 abandoned 不碰：已放弃区间绝不自动重试（放弃名存实亡 = O(n²) 雪球换门再滚）", async () => {
  const root = freshRoot();
  try {
    const seed = createJournal({ storageRoot: root, log: silentLog });
    await seed.recordRun({ sessionId: "sess-dead", from: 0, to: 5, cursorAfter: 5, outcome: "abandoned", reason: "no-cwd" });
    assert.equal(seed.snapshot().abandoned.length, 1, "前提：盘上有放弃区间");
    const persistence = fakePersistence({ sessions: new Map([["sess-dead", userEvents(5)]]), headerOf: () => ({ cwd: root }) });
    const { handler, handlers } = appWithHandlers(root, persistence);

    handlers.get("session/disposed")({ id: "sess-dead" }); // 该会话只有 abandoned、没有 failed
    handlers.get("session/event")(liveSession(root, []), { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((r) => setTimeout(r, 60));
    const st = await callApi(handler, { method: "GET", path: "state" });
    assert.equal(st.json.recover.autoAttempts, 0, "abandoned 不触发任何自动补提");
    assert.equal(st.json.extractionLog.abandoned.length, 1, "放弃区间原样留守（不自动回炉）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("自动补提 host 不支持：自动补提静默不跑（只 debug 日志），不报错、不记账", async () => {
  const root = freshRoot();
  try {
    await seedFailed(root, "sess-nohost", 0, 5);
    const { handler, handlers } = appWithHandlers(root, null); // 宿主没 sessionPersistence
    handlers.get("session/disposed")({ id: "sess-nohost" });
    handlers.get("session/event")(liveSession(root, []), { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((r) => setTimeout(r, 40));
    const st = await callApi(handler, { method: "GET", path: "state" });
    assert.equal(st.json.recover.autoAttempts, 0, "能力缺失不是故障：降级为不跑");
    assert.equal(st.json.recover.inFlight, false);
    const after = await callApi(handler, { method: "GET", path: "sessions/pending" });
    assert.equal(after.json.items.length, 1, "区间原样留守（没能力补 ≠ 补过了）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("自动补提开关：autoRecoverEnabled=false → 三触发面全静默（回滚面）", async () => {
  const root = freshRoot();
  try {
    await seedFailed(root, "sess-off", 0, 5);
    const persistence = fakePersistence({ sessions: new Map([["sess-off", userEvents(5)]]), headerOf: () => ({ cwd: root }) });
    const { handler, handlers } = appWithHandlers(root, persistence, { autoRecoverEnabled: false });
    handlers.get("session/disposed")({ id: "sess-off" });
    handlers.get("session/event")(liveSession(root, []), { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((r) => setTimeout(r, 40));
    const st = await callApi(handler, { method: "GET", path: "state" });
    assert.equal(st.json.recover.autoEnabled, false, "观测面如实反映开关");
    assert.equal(st.json.recover.autoAttempts, 0, "关掉后零自动尝试");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('自动补提 dispose 守卫：卸载后触发面不再发起（启动清扫定时器一并清）', async () => {
  const root = freshRoot();
  // 拦截全局定时器：钉住「apply 定的启动清扫定时器在 dispose 时被 clear」（不拦的话该守卫无覆盖）
  const origSet = globalThis.setTimeout;
  const origClear = globalThis.clearTimeout;
  const sweepTimers = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const handle = origSet(fn, ms, ...rest);
    if (typeof ms === 'number' && ms >= 1000) sweepTimers.push({ handle, ms, cleared: false });
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    for (const entry of sweepTimers) if (entry.handle === handle) entry.cleared = true;
    return origClear(handle);
  };
  try {
    await seedFailed(root, 'sess-x', 0, 5);
    writeSettings(root, { conversationMemory: false }, silentLog);
    const persistence = fakePersistence({ sessions: new Map([['sess-x', userEvents(5)]]), headerOf: () => ({ cwd: root }) });
    const { handler, handlers, disposers } = appWithHandlers(root, persistence);
    assert.ok(disposers.length >= 1, '生命周期 disposer 应被捕获');
    for (const dispose of disposers) await dispose(); // 卸载：abort lifetime + 清启动清扫定时器
    assert.ok(sweepTimers.some((e) => e.ms >= 4000 && e.cleared), '启动清扫定时器应在 dispose 时被 clear（实际 ' + JSON.stringify(sweepTimers) + '）');
    handlers.get('session/disposed')({ id: 'sess-x' }); // 卸载后再触发
    await new Promise((r) => setTimeout(r, 50));
    const state = await callApi(handler, { method: 'GET', path: 'state' });
    assert.equal(state.json.recover.autoAttempts, 0, 'dispose 后不发起自动补提');
    assert.equal(state.json.recover.lastAutoAt, null);
    const pending = await callApi(handler, { method: 'GET', path: 'sessions/pending' });
    assert.equal(pending.json.items.length, 1, '区间原样留守（没被消费）');
  } finally {
    globalThis.setTimeout = origSet;
    globalThis.clearTimeout = origClear;
    rmSync(root, { recursive: true, force: true });
  }
});

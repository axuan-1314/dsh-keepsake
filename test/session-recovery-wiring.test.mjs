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
  const ctx = {
    logger: silentLog,
    get(name) { return name === "sessionPersistence" ? persistence : void 0; },
    on(event, handler) { handlers.set(event, handler); return () => {}; },
    effect(fn) { try { fn(); } catch { /* disposer 忽略 */ } return () => {}; },
    inject(_deps, setup) {
      setup({ effect(fn) { fn(); }, webServer: { register(route) { routes.push(route); return () => {}; } } });
    },
    systemPrompt: { section() { return () => {}; } },
    llm: { stream() { throw new Error("补提测试不应真调 LLM（走 skip/无 cwd 早退路径）"); } },
  };
  return { ctx, handlers, routes };
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

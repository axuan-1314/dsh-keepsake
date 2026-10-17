// session-recovery：补提清单合成、事件分页读取、会话适配对象（口径以 lib/index.js 提取链路实际消费为准）
// 夹具全为合成数据，不碰真实宿主：persistence 一律是本文件里的假实现。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADAPTER_SESSION_FIELDS,
  MAX_EVENTS_PER_SESSION,
  READ_PAGE_SIZE,
  RECOVERY_ERRORS,
  buildPendingItems,
  createSessionAdapter,
  loadEvents,
} from "../lib/session-recovery.js";
import { projectMemoryPaths } from "../lib/paths.js";
import { renderTranscript, skipReason } from "../lib/transcript.js";

// ─────────────────────────── 合成夹具 ───────────────────────────

/** 合成会话事件（.data.message.content 形态取自 lib/transcript.js 的 messageOf 口径）。 */
function userTurn(seq, text) {
  return {
    type: "user/message",
    surfaceOp: "append",
    seq,
    data: { role: "user", content: [{ type: "text", text }] },
  };
}

/** 拼 n 条合成事件（文本带序号，便于断言顺序与切片边界）。 */
function makeEvents(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(userTurn(i, `第 ${i} 轮 用户说了足够长的散文内容`));
  return out;
}

/**
 * 假会话持久化服务（模仿宿主 ctx.sessionPersistence 的形状）。
 * open(id, "read") 返回只读句柄，handle.read(offset, length) → { eventState, events }。
 * @param {object} options
 * @param {Map<string,Array>} options.sessions 会话 id → 事件数组
 * @param {string} [options.throwOnOpen] open 时抛的错误（可带 code）
 * @param {number} [options.failAtOffset] read 到该 offset 时抛错（模拟读取中断）
 * @param {boolean} [options.ignoreLength] 不理 length 形参（模拟宿主超额返回）
 * @param {boolean} [options.ignoreOffset] 永远从头给（模拟句柄不推进 → 死循环防线用）
 * @param {object} [options.eventState] 句柄随页带回的 eventState
 * @param {Array<number>} options.readLengths 记录每次 read 收到的 length（uhn Happy path 断言分页参数）
 */
function fakePersistence(options = {}) {
  const sessions = options.sessions ?? new Map();
  const openCalls = [];
  const readCalls = [];
  const readLengths = [];
  const api = {
    openCalls,
    readCalls,
    readLengths,
    statCalls: [],
    stat(id) {
      api.statCalls.push(id);
      const events = sessions.get(id);
      if (events === undefined) return null;
      return { header: { cwd: options.cwd ?? "" }, eventCount: events.length };
    },
    list() {
      return [...sessions.keys()];
    },
    open(id, mode) {
      openCalls.push({ id, mode });
      if (options.throwOnOpen !== undefined) throw options.throwOnOpen;
      if (options.openReturnsNull === true) return null;
      if (options.missing !== true && !sessions.has(id)) {
        const error = new Error(`no such session: ${id}`);
        error.code = "ENOENT";
        throw error;
      }
      const events = sessions.get(id) ?? [];
      return {
        read(offset, length) {
          readCalls.push({ offset, length });
          readLengths.push(length);
          if (options.throwOnRead !== undefined) throw options.throwOnRead;
          const at = Number.isFinite(options.failAtOffset) && offset >= options.failAtOffset;
          if (at) throw new Error(`read 中断（offset=${offset}）`);
          const start = options.ignoreOffset === true ? 0 : offset;
          const end = options.ignoreLength === true ? events.length : Math.min(events.length, start + (length ?? events.length));
          return {
            eventState: options.eventState ?? { kind: "synthetic" },
            events: events.slice(start, end),
          };
        },
      };
    },
  };
  return api;
}

/** 空日志口（需要时替成收集器）。 */
function silentLog() {
  return { warn: () => {}, error: () => {}, info: () => {} };
}

/**
 * 假提取入口：逐行照抄 lib/index.js extractSession 对 session 对象的**全部**触点
 * （第 663-680 行），这四条之外提取链路不再读会话——能跑通它就意味着适配器够用。
 */
function fakeExtractSession(session, fromSeq, toSeq) {
  const cwd = session?.header?.cwd; // ← extractSession 第 663 行
  if (typeof cwd !== "string" || cwd.length === 0) {
    return { status: "error", detail: { outcome: "failed", reason: "no-cwd" } };
  }
  const seq = typeof session?.seq === "number" ? session.seq : toSeq; // ← 第 677 行
  const to = Math.min(toSeq, seq); // ← 第 678 行
  const from = Math.min(fromSeq, to); // ← 第 679 行
  const events = session.snapshotEvents(from, to); // ← 第 680 行
  return {
    status: "ok",
    detail: { outcome: "written", sessionId: session.id, cwd, events, from, to }, // session.id ← 第 782/895 行
  };
}

// ─────────────────────── 1. loadEvents：happy path 分页 ───────────────────────

test("loadEvents: happy path 分页读多段事件并按序拼回", async () => {
  const events = makeEvents(7);
  const persistence = fakePersistence({ sessions: new Map([["session-abc", events]]) });
  const result = await loadEvents(persistence, "session-abc", { pageSize: 3, log: silentLog() });

  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.equal(result.truncated, false);
  assert.equal(result.read, 7);
  assert.deepEqual(result.events, events); // 顺序与全量一致，不多不少
  assert.deepEqual(result.eventState, { kind: "synthetic" }); // 宿主 eventState 原样透传
  // 分页形态：0/3/6 三页读到 6 条，第 4 页（offset=7）读到空 → 判定读到底，收。
  assert.deepEqual(persistence.readCalls.map((c) => c.offset), [0, 3, 6, 7]);
  assert.deepEqual(persistence.readLengths, [3, 3, 3, 3]); // length 按 min(pageSize, 余量)
  assert.deepEqual(persistence.openCalls, [{ id: "session-abc", mode: "read" }]); // 只读句柄，不抢写锁
});

test("loadEvents: 空会话返回空数组（ok:true 而非错误）", async () => {
  const persistence = fakePersistence({ sessions: new Map([["session-empty", []]]) });
  const result = await loadEvents(persistence, "session-empty", { log: silentLog() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.events, []);
  assert.equal(result.read, 0);
  assert.equal(result.truncated, false);
});

test("loadEvents: 默认 pageSize/上限取自模块常量", async () => {
  const persistence = fakePersistence({ sessions: new Map([["session-def", makeEvents(1)]]) });
  const result = await loadEvents(persistence, "session-def", { log: silentLog() });
  assert.equal(result.ok, true);
  // 1 条事件：第 1 页给 1 条（length=READ_PAGE_SIZE），第 2 页探尾为空 → 收
  assert.deepEqual(persistence.readLengths, [READ_PAGE_SIZE, READ_PAGE_SIZE]);
  assert.ok(MAX_EVENTS_PER_SESSION > 0);
});

// ─────────────────────── 2-4. typed error 三态 ───────────────────────

test("loadEvents: 会话不存在 → session-not-found（open 抛 ENOENT）", async () => {
  const persistence = fakePersistence({ sessions: new Map() });
  const result = await loadEvents(persistence, "session-gone", { log: silentLog() });
  assert.equal(result.ok, false);
  assert.equal(result.error, "session-not-found");
  assert.equal(typeof result.detail, "string");
  assert.equal(result.events, undefined); // 失败面不带半成品
});

test("loadEvents: open 返回空句柄 → session-not-found", async () => {
  const persistence = fakePersistence({ sessions: new Map([["s", makeEvents(1)]]) });
  persistence.open = () => null;
  const result = await loadEvents(persistence, "s", { log: silentLog() });
  assert.equal(result.ok, false);
  assert.equal(result.error, "session-not-found");
});

test("loadEvents: persistence 缺失/null → host-unsupported（优雅降级，不抛）", async () => {
  for (const persistence of [null, undefined, {}, { open: "不是函数" }]) {
    const result = await loadEvents(persistence, "session-x", { log: silentLog() });
    assert.equal(result.ok, false, `${String(persistence)} 应降级`);
    assert.equal(result.error, "host-unsupported");
  }
});

test("loadEvents: 读取中途抛错 → read-error，且不吐半截事件", async () => {
  const persistence = fakePersistence({
    sessions: new Map([["session-cut", makeEvents(10)]]),
    failAtOffset: 4,
  });
  const errors = [];
  const result = await loadEvents(persistence, "session-cut", {
    pageSize: 2,
    log: { warn: () => {}, error: (m) => errors.push(String(m)), info: () => {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "read-error"); // 非 ENOENT 家族 → 不冒充 not-found
  assert.match(result.detail, /read 中断/);
  assert.equal(result.events, undefined); // 半截事件会让提取写出残缺记忆，绝不给
  assert.ok(errors.length > 0, "读中断必须留痕（不能静默）");
});

test("loadEvents: open 抛非 not-found 异常 → read-error（不许吞成 not-found）", async () => {
  const boom = new Error("EBUSY lock held");
  boom.code = "EBUSY";
  const persistence = fakePersistence({ sessions: new Map([["s", makeEvents(2)]]), throwOnOpen: boom });
  const result = await loadEvents(persistence, "s", { log: silentLog() });
  assert.equal(result.ok, false);
  assert.equal(result.error, "read-error");
  assert.match(result.detail, /EBUSY/);
});

test("loadEvents: 句柄缺 read 方法 → read-error（typed，不野抛）", async () => {
  const persistence = { open: async () => ({}) };
  const result = await loadEvents(persistence, "s", { log: silentLog() });
  assert.equal(result.ok, false);
  assert.equal(result.error, "read-error");
});

test("loadEvents: id 为空 → session-not-found（不抛 TypeError）", async () => {
  const persistence = fakePersistence({ sessions: new Map([["s", makeEvents(1)]]) });
  for (const id of ["", "   ", undefined]) {
    const result = await loadEvents(persistence, id, { log: silentLog() });
    assert.equal(result.ok, false);
    assert.equal(result.error, "session-not-found");
  }
});

// ─────────────────────── 5. 截断 ───────────────────────

test("loadEvents: 超上限截断 → ok:true + truncated:true（不静默）", async () => {
  const persistence = fakePersistence({ sessions: new Map([["session-big", makeEvents(20)]]), });
  const warnings = [];
  const result = await loadEvents(persistence, "session-big", {
    maxEvents: 8,
    pageSize: 3,
    log: { warn: (m) => warnings.push(String(m)), error: () => {}, info: () => {} },
  });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true); // 显式带出
  assert.equal(result.read, 8);
  assert.deepEqual(result.events, makeEvents(8)); // 保头部、丢尾部
  assert.ok(warnings.some((m) => m.includes("截断")), "截断必须告警（禁止静默砍数据）");
});

test("loadEvents: 恰好等于上限不算截断", async () => {
  const persistence = fakePersistence({ sessions: new Map([["session-eq", makeEvents(4)]]) });
  const result = await loadEvents(persistence, "session-eq", { maxEvents: 4, log: silentLog() });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, false);
  assert.equal(result.read, 4);
});

test("loadEvents: 宿主超额返回（不理 length）仍被上限压住", async () => {
  const persistence = fakePersistence({
    sessions: new Map([["session-greedy", makeEvents(20)]]),
    ignoreLength: true,
  });
  const result = await loadEvents(persistence, "session-greedy", { maxEvents: 5, pageSize: 2, log: silentLog() });
  assert.equal(result.ok, true);
  assert.equal(result.read, 5);
  assert.equal(result.truncated, true);
});

test("loadEvents: 句柄不推进 offset（死循环）→ 页数兜底判 read-error", async () => {
  const persistence = fakePersistence({
    sessions: new Map([["session-stuck", makeEvents(500)]]),
    ignoreOffset: true,
  });
  const result = await loadEvents(persistence, "session-stuck", { maxEvents: 40, pageSize: 4, log: silentLog() });
  // 每次都从头给 → 每页都满 4 条，events 一路涨到 40 触上限；此处重点是不许无限循环
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.read, 40);
});

// ─────────────────────── 6. buildPendingItems ───────────────────────

const SNAP_BASE = {
  unrecovered: [
    { sessionId: "session-a", from: 3, to: 6, at: "2026-10-16T10:00:00.000Z", reason: "llm-error" },
    { sessionId: "session-b", from: 9, to: 12, at: "2026-10-16T12:00:00.000Z", reason: "parse-error" },
  ],
  abandoned: [
    { sessionId: "session-c", from: 1, to: 2, at: "2026-10-16T11:00:00.000Z", reason: "no-cwd" },
  ],
};

test("buildPendingItems: 合并两列并按 at 降序", async () => {
  const items = await buildPendingItems(SNAP_BASE, async () => ({ eventCount: 10 }));
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.sessionId), ["session-b", "session-c", "session-a"]); // 12:00 → 11:00 → 10:00
  assert.deepEqual(items.map((i) => i.kind), ["failed", "abandoned", "failed"]); // kind 身份不丢
  assert.deepEqual(items.map((i) => [i.from, i.to]), [[9, 12], [1, 2], [3, 6]]);
  assert.equal(items[0].reason, "parse-error");
});

test("buildPendingItems: 同 at 稳定排序（failed 列在前、各自保输入序）", async () => {
  const at = "2026-10-16T10:00:00.000Z";
  const snap = {
    unrecovered: [
      { sessionId: "u1", from: 1, to: 2, at, reason: "r1" },
      { sessionId: "u2", from: 3, to: 4, at, reason: "r2" },
    ],
    abandoned: [{ sessionId: "a1", from: 5, to: 6, at, reason: "r3" }],
  };
  const first = await buildPendingItems(snap, async () => ({ eventCount: 1 }));
  const second = await buildPendingItems(snap, async () => ({ eventCount: 1 }));
  assert.deepEqual(first.map((i) => i.sessionId), ["u1", "u2", "a1"]);
  assert.deepEqual(second.map((i) => i.sessionId), first.map((i) => i.sessionId)); // 两次运行同序
});

test("buildPendingItems: statOf 返回对象 → sessionAvailable:true 且带 eventCount", async () => {
  const seen = [];
  const items = await buildPendingItems(SNAP_BASE, async (id) => {
    seen.push(id);
    return { eventCount: 42, header: { cwd: "/ws" } };
  });
  assert.deepEqual(seen, ["session-b", "session-c", "session-a"]); // 按排完的顺序探活
  for (const item of items) {
    assert.equal(item.sessionAvailable, true);
    assert.equal(item.eventCount, 42);
  }
});

test("buildPendingItems: statOf 返回 null → sessionAvailable:false（不默认可用）", async () => {
  const items = await buildPendingItems(SNAP_BASE, async () => null);
  assert.equal(items.length, 3);
  for (const item of items) {
    assert.equal(item.sessionAvailable, false);
    assert.equal("eventCount" in item, false); // 没探到就不带，不用 0 冒充
  }
});

test("buildPendingItems: statOf 抛错被隔离在单条（其余照常）", async () => {
  const items = await buildPendingItems(SNAP_BASE, async (id) => {
    if (id === "session-c") throw new Error("宿主抖动");
    return { eventCount: 7 };
  });
  assert.equal(items.length, 3); // 整张清单没被一次抛错带走
  const byId = new Map(items.map((i) => [i.sessionId, i]));
  assert.equal(byId.get("session-c").sessionAvailable, false);
  assert.equal(byId.get("session-a").sessionAvailable, true);
  assert.equal(byId.get("session-b").eventCount, 7);
});

test("buildPendingItems: 不传 statOf → 一律 sessionAvailable:false", async () => {
  const items = await buildPendingItems(SNAP_BASE);
  assert.equal(items.length, 3);
  for (const item of items) assert.equal(item.sessionAvailable, false);
});

test("buildPendingItems: 脏快照容错（非对象/非数组/无 sessionId）", async () => {
  assert.deepEqual(await buildPendingItems(null), []);
  assert.deepEqual(await buildPendingItems({}), []);
  assert.deepEqual(await buildPendingItems({ unrecovered: "不是数组", abandoned: 42 }), []);
  const dirty = await buildPendingItems({
    unrecovered: [
      { sessionId: "", from: 1, to: 2, at: "2026-10-16T10:00:00.000Z" }, // 无 id → 幽灵条目，出列
      null,
      { sessionId: "session-ok", from: "x", to: -5, at: "坏时间" }, // 字段级脏值 → 钳到 0
    ],
    abandoned: undefined,
  }, async () => null);
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].sessionId, "session-ok");
  assert.equal(dirty[0].from, 0);
  assert.equal(dirty[0].to, 0);
  assert.equal(dirty[0].kind, "failed");
  assert.equal(dirty[0].reason, "");
});

// ─────────────────────── 7. createSessionAdapter ───────────────────────

test("createSessionAdapter: 对象面与提取消费面一致（假提取入口能吃）", async () => {
  const events = makeEvents(9);
  const persistence = fakePersistence({ sessions: new Map([["session-adapt", events]]) });
  const adapter = await createSessionAdapter(persistence, "session-adapt", {
    cwd: "/ws/project",
    log: silentLog(),
  });

  // 提取链路的四个触点全部在位
  for (const field of ADAPTER_SESSION_FIELDS) assert.ok(field in adapter, `缺字段 ${field}`);
  assert.equal(adapter.id, "session-adapt");
  assert.equal(adapter.seq, 9); // seq = 真实事件边界（不许虚报）
  assert.equal(adapter.header.cwd, "/ws/project");

  // 照抄 extractSession 首段的假入口：能跑通 = 适配成立
  const run = fakeExtractSession(adapter, 3, 7);
  assert.equal(run.status, "ok");
  assert.deepEqual(run.detail.events, events.slice(3, 7)); // [from,to) 半开切片，与宿主同口径
  assert.equal(run.detail.from, 3);
  assert.equal(run.detail.to, 7);
  assert.equal(run.detail.sessionId, "session-adapt");
  assert.equal(run.detail.cwd, "/ws/project");
});

test("createSessionAdapter: 真实下游可用（项目路径推导 + skipReason/renderTranscript）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-recovery-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-"));
  try {
    const events = makeEvents(5);
    const adapter = await createSessionAdapter(null, "session-static", { events, cwd: workspace, log: silentLog() });
    const slice = adapter.snapshotEvents(1, 4);

    // 真实项目记忆目录推导（lib/paths.js）——只有 header.cwd 形状对了才推得出来
    const expected = projectMemoryPaths(root, workspace).memoryDir;
    const actual = projectMemoryPaths(root, adapter.header.cwd).memoryDir;
    assert.equal(actual, expected);

    // 真实门槛判定 + 摘录渲染（lib/transcript.js）——事件形态对了才有摘录
    assert.equal(skipReason(slice, actual), null); // 合成散文够门槛
    const text = renderTranscript(slice);
    assert.match(text, /\[seq 1\]/);
    assert.match(text, /\[seq 3\]/);
    assert.doesNotMatch(text, /\[seq 0\]/);
    assert.doesNotMatch(text, /\[seq 4\]/);
  } finally {
    // 临时根交给系统回收：测试内不删，避免与上轮并行的用例抢同一临时目录
  }
});

test("createSessionAdapter: cwd 三级来源与 cwdSource 标注", async () => {
  const events = makeEvents(2);

  const fromMeta = await createSessionAdapter(null, "s1", { events, cwd: "/from/meta", log: silentLog() });
  assert.equal(fromMeta.header.cwd, "/from/meta");
  assert.equal(fromMeta.source.cwdSource, "meta");

  const fromStat = await createSessionAdapter(null, "s2", {
    events,
    stat: { header: { cwd: "/from/stat" } },
    log: silentLog(),
  });
  assert.equal(fromStat.header.cwd, "/from/stat");
  assert.equal(fromStat.source.cwdSource, "stat");

  const persistence = fakePersistence({ sessions: new Map([["s3", events]]), cwd: "/from/persistence-stat" });
  const fromPersistence = await createSessionAdapter(persistence, "s3", { log: silentLog() });
  assert.equal(fromPersistence.header.cwd, "/from/persistence-stat");
  assert.equal(fromPersistence.source.cwdSource, "stat");
  assert.deepEqual(persistence.statCalls, ["s3"]);
});

test("createSessionAdapter: 取不到 cwd → 空串 + cwdSource:none（由提取侧照 no-cwd 纪律处理）", async () => {
  const adapter = await createSessionAdapter(null, "s-none", { events: makeEvents(2), log: silentLog() });
  assert.equal(adapter.header.cwd, "");
  assert.equal(adapter.source.cwdSource, "none");
  // 与在线会话同侧：假提取入口应判 no-cwd 失败，不得把记忆落到猜出来的地方
  const run = fakeExtractSession(adapter, 0, 2);
  assert.equal(run.status, "error");
  assert.equal(run.detail.reason, "no-cwd");
});

test("createSessionAdapter: persistence 为 null 且用 meta.events 静态构造时 source 诚实", async () => {
  const adapter = await createSessionAdapter(null, "s-static", { events: makeEvents(3), log: silentLog() });
  assert.equal(adapter.source.eventsReady, true);
  assert.equal(adapter.source.truncated, false);
  assert.equal(adapter.source.eventCount, 3);
  assert.equal("error" in adapter.source, false);
  assert.equal(adapter.seq, 3);
});

test("createSessionAdapter: 读事件失败 → 空事件 + source.error 为 typed error（不冒充成功）", async () => {
  const persistence = fakePersistence({ sessions: new Map() }); // 没这个会话 → session-not-found
  const adapter = await createSessionAdapter(persistence, "session-missing", { log: silentLog() });
  assert.deepEqual(adapter.snapshotEvents(0, 5), []);
  assert.equal(adapter.seq, 0);
  assert.equal(adapter.source.eventsReady, false);
  assert.equal(adapter.source.error, "session-not-found");
  assert.ok(RECOVERY_ERRORS.includes(adapter.source.error), "错误码必须落在 typed 全集里");
});

test("createSessionAdapter: 事件被截断时 source.truncated 透出", async () => {
  const persistence = fakePersistence({ sessions: new Map([["s-trunc", makeEvents(20)]]), });
  const adapter = await createSessionAdapter(persistence, "s-trunc", { maxEvents: 6, log: silentLog() });
  assert.equal(adapter.seq, 6);
  assert.equal(adapter.source.truncated, true);
  assert.equal(adapter.source.eventCount, 6);
});

test("createSessionAdapter: snapshotEvents 边界（越界/反转）与宿主 slice 语义一致", async () => {
  const events = makeEvents(4);
  const adapter = await createSessionAdapter(null, "s-edge", { events, log: silentLog() });
  assert.deepEqual(adapter.snapshotEvents(0, 99), events); // 上界越界 → 给到尾
  assert.deepEqual(adapter.snapshotEvents(2, 2), []); // 空区间
  assert.deepEqual(adapter.snapshotEvents(3, 1), []); // 反转 → 空（与 Array.slice 同）
  assert.deepEqual(adapter.snapshotEvents(0, 2).length, 2);
});

// ─────────────────────── 8. 口径对照：真实 journal 快照直接喂进来 ───────────────────────

test("端到端口径：真 journal 的 unrecovered/abandoned 能一路走到补提清单", async () => {
  const { createJournal } = await import("../lib/journal.js");
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-journal-"));
  const journal = createJournal({ storageRoot: root, log: silentLog() });
  // 两会话各记一条，避开同会话"后一条把 cursor 推过前一条的 to 即出列"的判据，
  // 让两列各留一条（这正是 journal 的语义：只有真没被补上的区间才进 unrecovered）。
  journal.recordRun({ sessionId: "session-live", from: 0, to: 3, cursorAfter: 0, outcome: "failed", reason: "llm-error" });
  journal.recordRun({ sessionId: "session-live2", from: 3, to: 6, cursorAfter: 6, outcome: "abandoned", reason: "no-cwd" });
  const snapshot = journal.snapshot();
  assert.equal(snapshot.unrecovered.length, 1);
  assert.equal(snapshot.abandoned.length, 1);

  const items = await buildPendingItems(snapshot, async () => ({ eventCount: 12 }));
  assert.equal(items.length, 2);
  const kinds = items.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["abandoned", "failed"]);
  for (const item of items) {
    assert.match(item.sessionId, /^session-live/);
    assert.equal(item.sessionAvailable, true);
    assert.equal(item.eventCount, 12);
    assert.ok(typeof item.at === "string" && item.at.length > 0); // journal 的 at 是 ISO 串
  }
  // 清单条目直接喂适配器：按 (from,to) 取到的切片长度 == to-from
  const adapter = await createSessionAdapter(null, "session-live", { events: makeEvents(12), log: silentLog() });
  for (const item of items) {
    const slice = adapter.snapshotEvents(item.from, item.to);
    assert.equal(slice.length, Math.max(0, item.to - item.from));
  }
});

test("RECOVERY_ERRORS 是三种且冻结（错误码不得漂移）", () => {
  assert.deepEqual(RECOVERY_ERRORS, ["session-not-found", "host-unsupported", "read-error"]);
  assert.equal(Object.isFrozen(RECOVERY_ERRORS), true);
});

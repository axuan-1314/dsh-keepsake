// state：提取状态机推进纪律（边界①：skip 推进/error 不推进/单飞合并；边界⑥：abort 不推进）
// + 结算记账纪律（每次结算必落 journal，cursorAfter 取结算后真值）
// + cursor 持久化恢复（journal 有记录 → 首见即续提；无记录仍不回扫历史）
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createScheduler } from "../lib/state.js";
import { createJournal } from "../lib/journal.js";

function fakeSession(seq, id = "s") {
  return { id, seq };
}

/**
 * 最小 journal stub：只记账不持久化（getCursor 恒 null = "从没提取过的会话"）。
 * 用于纯推进纪律用例——这些用例关心 cursor 怎么动，不关心盘上。
 */
function stubJournal() {
  const runs = [];
  return {
    runs,
    recordRun(entry) {
      runs.push(entry);
      return Promise.resolve(entry);
    },
    getCursor: () => null,
    getRing: () => runs.slice(),
    getUnrecovered: () => [],
    snapshot: () => ({ runs: runs.slice(), unrecovered: [] }),
  };
}

const ok = (detail = { outcome: "written" }) => ({ status: "ok", detail });
const err = (detail = { outcome: "failed" }) => ({ status: "error", detail });

test("skip（ok）推进 cursor", async () => {
  let calls = [];
  const journal = stubJournal();
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      return ok();
    },
    journal,
  });
  const session = fakeSession(10);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 10);
  await scheduler.dispose();
  assert.deepEqual(calls, [[0, 10]]);
  assert.equal(scheduler.stateOf(session).cursor, 10);
});

test("error 不推进 cursor，下一轮从原 cursor 起跑", async () => {
  let fail = true;
  const calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      return fail ? err() : ok();
    },
    journal: stubJournal(),
  });
  const session = fakeSession(5);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 5);
  await scheduler.quiesce();
  assert.equal(scheduler.stateOf(session).cursor, 0); // 不推进
  fail = false;
  session.seq = 12; // 宿主 seq 前移（真实宿主恒有 seq ≥ toSeq）
  scheduler.onTurnCompleted(session, 12);
  await scheduler.quiesce();
  assert.deepEqual(calls, [[0, 5], [0, 12]]); // 第二轮仍从 0 起跑（含上一轮增量）
  assert.equal(scheduler.stateOf(session).cursor, 12);
  await scheduler.dispose();
});

test("单飞 + latestPending 合并", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      if (calls.length === 1) await gate; // 首个任务挂起
      return ok();
    },
    journal: stubJournal(),
  });
  const session = fakeSession(15);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 4); // running 开始，挂起
  scheduler.onTurnCompleted(session, 8); // pending 覆盖
  scheduler.onTurnCompleted(session, 15); // latest 待命
  assert.equal(calls.length, 1); // 单飞：无并发第二任务
  release();
  await scheduler.quiesce();
  assert.deepEqual(calls, [[0, 4], [4, 15]]); // 合并为一次最新区间
  assert.equal(scheduler.stateOf(session).cursor, 15);
  await scheduler.dispose();
});

test("extract 抛异常视为 error：不推进不炸调度器", async () => {
  const calls = [];
  const scheduler = createScheduler({
    log: { warn: () => {}, error: () => {} },
    extract: async () => {
      calls.push(1);
      throw new Error("boom");
    },
    journal: stubJournal(),
  });
  const session = fakeSession(3);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 3);
  await scheduler.quiesce();
  assert.equal(scheduler.stateOf(session).cursor, 0);
  assert.equal(calls.length, 1);
  await scheduler.dispose();
});

test("首见判定：小 seq 新会话 cursor=0 全量纳入；大 seq 恢复会话跳过既有历史", () => {
  const scheduler = createScheduler({ extract: async () => ok(), journal: stubJournal() });
  const fresh = fakeSession(1);
  scheduler.see(fresh, { seq: 0 });
  assert.equal(scheduler.stateOf(fresh).cursor, 0);
  const resumed = fakeSession(100, "resumed");
  scheduler.see(resumed, { seq: 100 }); // 恢复会话的新事件在既有历史之后
  // journal 无该会话记录 → 走老路（seq+1 跳历史），不回扫
  assert.equal(scheduler.stateOf(resumed).cursor, 101);
  void scheduler.dispose();
});

test("drop 清除强持有：drop 后 see 重新首见生效", async () => {
  // 用 getCursor 恒 null 的 stub：本例只验 Map 清理，不涉及持久化边界。
  const scheduler = createScheduler({ extract: async () => ok(), journal: stubJournal() });
  const session = fakeSession(7);
  scheduler.see(session, { seq: 0 }); // cursor=0
  scheduler.onTurnCompleted(session, 7);
  await scheduler.quiesce();
  assert.equal(scheduler.stateOf(session).cursor, 7);
  scheduler.drop(session);
  // 若 Map 未清，see() 是 no-op（cursor 仍 7）；已清则按"恢复会话"重建为 seq+1=51
  scheduler.see(session, { seq: 50 });
  assert.equal(scheduler.stateOf(session).cursor, 51);
  await scheduler.dispose();
});

test("已覆盖区间（toSeq ≤ cursor）不重复调度", async () => {
  const calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      return ok();
    },
    journal: stubJournal(),
  });
  const session = fakeSession(2);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 2);
  scheduler.onTurnCompleted(session, 1); // 旧边界，已被覆盖
  await scheduler.quiesce();
  assert.deepEqual(calls, [[0, 2]]);
  await scheduler.dispose();
});

test("cursor 钳制：宿主 seq 滞后时不跨过未物化区间（宁可重叠不丢）", async () => {
  const calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      return ok();
    },
    journal: stubJournal(),
  });
  const session = fakeSession(5); // 宿主 seq 滞后于 turn/end 边界 12
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 12);
  await scheduler.quiesce();
  assert.equal(scheduler.stateOf(session).cursor, 5); // 不跨过 [5,12)
  session.seq = 12; // 宿主追平
  scheduler.onTurnCompleted(session, 12);
  await scheduler.quiesce();
  assert.deepEqual(calls, [[0, 12], [5, 12]]); // 缺口区间被补提，不永久丢失
  assert.equal(scheduler.stateOf(session).cursor, 12);
  await scheduler.dispose();
});

test("drop 后 pending 链不再续跑（已释放会话不提取）", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      if (calls.length === 1) await gate;
      return ok();
    },
    journal: stubJournal(),
  });
  const session = fakeSession(10);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 4); // 挂起
  scheduler.onTurnCompleted(session, 8); // pending
  scheduler.drop(session); // 会话释放
  release();
  await scheduler.quiesce();
  assert.equal(calls.length, 1, "pending 续跑被 dropped 拦截");
  await scheduler.dispose();
});

// ---- 空闲延迟（extractIdleDelayMs>0）：固定时刻定时器、合并突发、dispose flush ----

// 假定时器：钉「固定时刻不滑动 / 合并 / dispose flush」语义用，杜绝真实睡眠的负载竞态。
// 观测口：setCalls/clearCalls 计次（钉"只定一次、从不重设"）+ handle 带 unref（钉不挂进程契约）。
function fakeTimers() {
  const scheduled = new Map(); // handle → { fn, ms }
  const stats = { setCalls: 0, clearCalls: 0, unrefCalls: 0 };
  return {
    stats,
    setTimer(fn, ms) {
      stats.setCalls += 1;
      const handle = {
        unref() {
          stats.unrefCalls += 1;
        },
      };
      scheduled.set(handle, { fn, ms });
      return handle;
    },
    clearTimer(handle) {
      stats.clearCalls += 1;
      scheduled.delete(handle);
    },
    get size() {
      return scheduled.size;
    },
    deadlines() {
      return [...scheduled.values()].map((entry) => entry.ms);
    },
    fireAll() {
      const entries = [...scheduled.values()];
      scheduled.clear();
      for (const entry of entries) entry.fn();
      return entries.length;
    },
  };
}

test("空闲延迟：三轮突发合并成一次提取（单定时器、边界取最新）", async () => {
  const timers = fakeTimers();
  const calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      return ok();
    },
    journal: stubJournal(),
    idleDelayMs: 60,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const session = fakeSession(20);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 5); // 首个触发：定 60ms 定时器，不起跑
  scheduler.onTurnCompleted(session, 12); // 突发第二轮：只合并，不重置定时器
  scheduler.onTurnCompleted(session, 20); // 第三轮并入
  assert.equal(calls.length, 0, "延迟期内不得起跑");
  assert.equal(timers.size, 1, "三轮只定一个定时器（重置=滑动窗口病灶）");
  assert.equal(timers.stats.setCalls, 1, "只 set 一次——滑动窗口实现会 set 三次");
  assert.equal(timers.stats.clearCalls, 0, "期间从不 clear 重设");
  assert.equal(timers.stats.unrefCalls, 1, "定时器 unref：不许挂住宿主/测试进程");
  assert.deepEqual(timers.deadlines(), [60], "定时器是首触发时定的固定时刻");
  timers.fireAll();
  await scheduler.quiesce();
  assert.deepEqual(calls, [[0, 20]], "三轮合并为一次提取（边界取最新）");
  assert.equal(scheduler.stateOf(session).cursor, 20);
  await scheduler.dispose();
});

test("空闲延迟：固定时刻不滑动——持续触发不重置定时器，到点必跑", async () => {
  const timers = fakeTimers();
  const calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      return ok();
    },
    journal: stubJournal(),
    idleDelayMs: 100,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const session = fakeSession(100);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 10);
  for (let i = 1; i <= 4; i += 1) scheduler.onTurnCompleted(session, 10 + i * 10);
  assert.equal(timers.size, 1, "五刀仍是一个定时器——滑动窗口实现会每次重设、永不触发");
  assert.equal(timers.stats.setCalls, 1, "只 set 一次（滑动窗口=五次 set+clear 重设）");
  assert.equal(timers.stats.clearCalls, 0, "从不 clear 重设");
  assert.deepEqual(timers.deadlines(), [100], "deadline 停在首触发定的 100ms");
  assert.equal(calls.length, 0, "未到点不跑");
  timers.fireAll(); // 到点：必跑
  await scheduler.quiesce();
  assert.equal(calls.length, 1, "固定时刻到点即跑");
  assert.equal(calls[0][0], 0);
  assert.equal(calls[0][1], 50, "合并区间跨过全部五刀（0→50）");
  // 到点之后的新触发仍能再定新定时器（不残留、不失效）
  scheduler.onTurnCompleted(session, 60);
  assert.equal(timers.size, 1, "新一轮触发重新定一个定时器");
  assert.equal(timers.stats.setCalls, 2, "第二窗重新 set 一次");
  timers.fireAll();
  await scheduler.quiesce();
  assert.deepEqual(calls[1], [50, 60], "第二窗跑增量区间");
  await scheduler.dispose();
});

test("空闲延迟：乱序触发边界不倒退（pendingTo 取 max）", async () => {
  const timers = fakeTimers();
  const calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      return ok();
    },
    journal: stubJournal(),
    idleDelayMs: 50,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const session = fakeSession(20);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 12);
  scheduler.onTurnCompleted(session, 7); // 乱序/回退边界：不得把合并边界拉低
  timers.fireAll();
  await scheduler.quiesce();
  assert.deepEqual(calls, [[0, 12]], "合并边界取 max，不被回退刀拉低");
  await scheduler.dispose();
});

test("空闲延迟：真实定时器路径——不注入定时器时到点自然触发", async () => {
  const calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      return ok();
    },
    journal: stubJournal(),
    idleDelayMs: 20, // 真 setTimeout：短窗 + 轮询等待，不赌固定睡眠
  });
  const session = fakeSession(6);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 6);
  assert.equal(calls.length, 0, "20ms 内未到点");
  const deadline = Date.now() + 2000;
  while (calls.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(calls, [[0, 6]], "真实 setTimeout 到点即跑（缺省定时器路径有覆盖）");
  await scheduler.dispose();
});

test("空闲延迟：dispose flush 不丢——挂起定时器转立即跑并进 drain", async () => {
  const timers = fakeTimers();
  const calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      return ok();
    },
    journal: stubJournal(),
    idleDelayMs: 60_000, // 故意长：只有 flush 才会跑
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const session = fakeSession(9);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 9);
  assert.equal(calls.length, 0, "60s 定时器未到点");
  assert.equal(timers.size, 1);
  await scheduler.dispose(); // flush：转立即跑并等 drain
  assert.deepEqual(calls, [[0, 9]], "dispose 不得静默丢掉挂起区间");
  assert.equal(timers.size, 0, "flush 后不留挂起定时器");
});

test("空闲延迟：dispose flush 后完成结算（cursor 推进 + journal 记账）", async () => {
  const timers = fakeTimers();
  const journal = stubJournal();
  const scheduler = createScheduler({
    extract: async () => ok({ outcome: "written", writes: 1 }),
    journal,
    idleDelayMs: 60_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const session = fakeSession(4);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 4);
  await scheduler.dispose();
  assert.equal(journal.runs.length, 1, "flush 出来的 run 必须结算记账（不是空转）");
  assert.equal(journal.runs[0].outcome, "written");
  assert.equal(journal.runs[0].cursorAfter, 4);
});

test("空闲延迟：drop（会话消亡）清挂起定时器，到点不起跑", async () => {
  const calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      return ok();
    },
    journal: stubJournal(),
    idleDelayMs: 30,
  });
  const session = fakeSession(6);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 6);
  scheduler.drop(session); // 定时器随之清
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, 0, "已消亡会话不得再起跑（区间由 自动补提接管）");
  await scheduler.dispose();
});

test("空闲延迟：0=立即（旧行为，回归钉）与 idleDelayMs 非法值回落 0", async () => {
  const calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      return ok();
    },
    journal: stubJournal(),
    idleDelayMs: 0,
  });
  const session = fakeSession(3);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 3);
  assert.deepEqual(calls, [[0, 3]], "0 = 同步起跑（旧行为）");
  await scheduler.dispose();
  // 非法值（负数/NaN）归一为 0：同样立即起跑，不炸
  const calls2 = [];
  const s2 = createScheduler({
    extract: async (session, from, to) => {
      calls2.push([from, to]);
      return ok();
    },
    journal: stubJournal(),
    idleDelayMs: -5,
  });
  const sess2 = fakeSession(2);
  s2.see(sess2, { seq: 0 });
  s2.onTurnCompleted(sess2, 2);
  assert.deepEqual(calls2, [[0, 2]]);
  await s2.dispose();
});

// ---- 每会话上限（extractMaxRunsPerSession>0）：超限 skipped/session-cap ----

test("每会话上限：超限即 skipped/session-cap 并推 cursor，不调 LLM", async () => {
  const journal = stubJournal();
  const calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      return ok({ outcome: "written" });
    },
    journal,
    maxRunsPerSession: 2,
  });
  const session = fakeSession(10);
  scheduler.see(session, { seq: 0 });
  // 三次触发三个独立区间（逐次清 pending，让 run 串行结算）
  scheduler.onTurnCompleted(session, 3);
  await scheduler.quiesce();
  session.seq = 6;
  scheduler.onTurnCompleted(session, 6);
  await scheduler.quiesce();
  session.seq = 10;
  scheduler.onTurnCompleted(session, 10);
  await scheduler.quiesce();
  assert.deepEqual(calls, [[0, 3], [3, 6]], "上限内两次真实提取，第三次不再调 LLM");
  assert.equal(journal.runs.length, 3, "三次触发各记一条结算");
  const capRun = journal.runs[2];
  assert.equal(capRun.outcome, "skipped");
  assert.equal(capRun.reason, "session-cap");
  assert.equal(capRun.cursorAfter, 10, "上限截断也推 cursor（斩断后续重试）");
  assert.equal(scheduler.stateOf(session).cursor, 10);
  await scheduler.dispose();
});

test("每会话上限：0=不限（旧行为，回归钉）", async () => {
  const calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      return ok();
    },
    journal: stubJournal(),
    maxRunsPerSession: 0,
  });
  const session = fakeSession(6);
  scheduler.see(session, { seq: 0 });
  for (let i = 1; i <= 4; i += 1) {
    session.seq = i * 2;
    scheduler.onTurnCompleted(session, i * 2);
    await scheduler.quiesce();
  }
  assert.equal(calls.length, 4, "0=不限：四次触发四次提取");
  await scheduler.dispose();
});

test("每会话上限：计数含失败尝试（失败重试同样烧预算）", async () => {
  const journal = stubJournal();
  const calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      return err({ outcome: "failed", reason: "llm-error" });
    },
    journal,
    maxRunsPerSession: 1,
  });
  const session = fakeSession(5);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 4);
  await scheduler.quiesce();
  session.seq = 5;
  scheduler.onTurnCompleted(session, 5);
  await scheduler.quiesce();
  assert.equal(calls.length, 1, "失败也算一次（第 2 次起被上限拦）");
  assert.equal(journal.runs[1].reason, "session-cap");
  assert.equal(journal.runs[0].reason, "llm-error");
});

// ---- 结算记账纪律（边界①的盘上侧）----

test("结算必记账：written/skipped/failed 三种明细各落一条，cursorAfter 取结算后真值", async () => {
  const journal = stubJournal();
  let mode = "written";
  const scheduler = createScheduler({
    extract: async () => {
      if (mode === "written") return ok({ outcome: "written", writes: 2, deletes: 1, skippedOps: 0, failedOps: 0, filtered: 0 });
      if (mode === "skipped") return ok({ outcome: "skipped", reason: "gate-off" });
      return err({ outcome: "failed", reason: "llm-error" });
    },
    journal,
  });
  const session = fakeSession(4);
  scheduler.see(session, { seq: 0 });

  // ① written（ok）→ cursor 推进到 4，记账 cursorAfter=4
  scheduler.onTurnCompleted(session, 4);
  await scheduler.quiesce();
  assert.equal(scheduler.stateOf(session).cursor, 4);
  assert.equal(journal.runs.length, 1);
  assert.deepEqual(journal.runs[0], {
    sessionId: "s", from: 0, to: 4, cursorAfter: 4,
    outcome: "written", writes: 2, deletes: 1, skippedOps: 0, failedOps: 0, filtered: 0,
  });

  // ② skipped（ok）→ cursor 推进到 8，记账 cursorAfter=8
  mode = "skipped";
  session.seq = 8;
  scheduler.onTurnCompleted(session, 8);
  await scheduler.quiesce();
  assert.equal(scheduler.stateOf(session).cursor, 8);
  assert.equal(journal.runs.length, 2);
  assert.deepEqual(journal.runs[1], {
    sessionId: "s", from: 4, to: 8, cursorAfter: 8, outcome: "skipped", reason: "gate-off",
  });

  // ③ failed（error）→ cursor 不动（仍 8），记账 cursorAfter=8（== from，进未恢复清单）
  mode = "failed";
  session.seq = 12;
  scheduler.onTurnCompleted(session, 12);
  await scheduler.quiesce();
  assert.equal(scheduler.stateOf(session).cursor, 8, "error 不推进");
  assert.equal(journal.runs.length, 3);
  assert.deepEqual(journal.runs[2], {
    sessionId: "s", from: 8, to: 12, cursorAfter: 8, outcome: "failed", reason: "llm-error",
  });
  await scheduler.dispose();
});

test("结算必记账：extract 抛异常记 outcome=failed reason=exception（cursor 不动）", async () => {
  const journal = stubJournal();
  const scheduler = createScheduler({
    log: { warn() {}, error() {} },
    extract: async () => {
      throw new Error("boom");
    },
    journal,
  });
  const session = fakeSession(6);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 6);
  await scheduler.quiesce();
  assert.equal(scheduler.stateOf(session).cursor, 0);
  assert.equal(journal.runs.length, 1, "异常路径也必须记账（否则这段区间盘上无痕）");
  assert.deepEqual(journal.runs[0], {
    sessionId: "s", from: 0, to: 6, cursorAfter: 0, outcome: "failed", reason: "exception",
  });
  await scheduler.dispose();
});

test("journal 必传：缺或缺方法即抛（不做静默兜底）", () => {
  const extract = async () => ok();
  assert.throws(() => createScheduler({ extract }), /journal/);
  assert.throws(() => createScheduler({ extract, journal: {} }), /journal/);
  assert.throws(() => createScheduler({ extract, journal: { recordRun() {} } }), /journal/);
  assert.doesNotThrow(() => createScheduler({ extract, journal: stubJournal() }));
});

test("dispose/dropped 早退路径不记账（会话已亡）", async () => {
  const journal = stubJournal();
  const calls = [];
  const scheduler = createScheduler({
    extract: async () => {
      calls.push(1);
      return ok();
    },
    journal,
  });
  const session = fakeSession(9);
  scheduler.see(session, { seq: 0 });
  await scheduler.dispose(); // 先 dispose
  scheduler.onTurnCompleted(session, 9); // disposed：不调度
  await scheduler.quiesce();
  assert.equal(calls.length, 0);
  assert.equal(journal.runs.length, 0, "已释放会话不再记账");
});

// ---- cursor 跨重启恢复（journal 持久化边界优先）----

/** 包一层真 journal：把 recordRun 的 promise 收集起来，测试可 await 落盘完成。 */
function spiedJournal(real) {
  const pending = [];
  return {
    real,
    pending,
    recordRun(entry) {
      const p = real.recordRun(entry);
      pending.push(p);
      return p;
    },
    getCursor: (id) => real.getCursor(id),
    getRing: () => real.getRing(),
    getUnrecovered: () => real.getUnrecovered(),
    snapshot: () => real.snapshot(),
    async flush() {
      await Promise.allSettled(pending.splice(0, pending.length));
    },
  };
}

test("重启续提：同 storageRoot 重建 journal+scheduler 后 cursor 恢复，失败区间被补提", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-state-resume-"));
  const silent = { info() {}, warn() {}, error() {} };
  try {
    // ---- 重启前：第 1 轮成功推进到 10，第 2 轮失败（cursor 卡在 10，区间 [10,20) 未覆盖）----
    const j1 = spiedJournal(createJournal({ storageRoot: root, log: silent }));
    let fail = false;
    const calls1 = [];
    const s1 = createScheduler({
      log: silent,
      extract: async (session, from, to) => {
        calls1.push([from, to]);
        return fail ? err({ outcome: "failed", reason: "llm-error" }) : ok({ outcome: "written", writes: 1, deletes: 0 });
      },
      journal: j1,
    });
    const session1 = fakeSession(10, "long-lived");
    s1.see(session1, { seq: 0 });
    s1.onTurnCompleted(session1, 10);
    await s1.quiesce();
    assert.equal(s1.stateOf(session1).cursor, 10);
    fail = true;
    session1.seq = 20;
    s1.onTurnCompleted(session1, 20);
    await s1.quiesce();
    assert.equal(s1.stateOf(session1).cursor, 10, "失败不推进");
    assert.deepEqual(calls1, [[0, 10], [10, 20]]);
    await j1.flush(); // 等落盘（模拟进程正常退出前写完）
    assert.equal(j1.real.getCursor("long-lived"), 10, "盘上 cursor=10");
    assert.equal(j1.real.getUnrecovered().length, 1, "[10,20) 未恢复");
    assert.deepEqual(
      { from: j1.real.getUnrecovered()[0].from, to: j1.real.getUnrecovered()[0].to },
      { from: 10, to: 20 },
    );
    await s1.dispose();

    // ---- 重启：新 journal（重放盘上）+ 新 scheduler，新 session 对象同 id ----
    const j2 = spiedJournal(createJournal({ storageRoot: root, log: silent }));
    assert.equal(j2.real.getCursor("long-lived"), 10, "重放后 cursor 恢复");
    const calls2 = [];
    const s2 = createScheduler({
      log: silent,
      extract: async (session, from, to) => {
        calls2.push([from, to]);
        return ok({ outcome: "written", writes: 1, deletes: 0 });
      },
      journal: j2,
    });
    const session2 = fakeSession(20, "long-lived");
    // 首见 seq=20 —— 若无持久化分支，cursor 会是 21（跳过 [10,20)），失败区间永久丢失
    s2.see(session2, { seq: 20 });
    assert.equal(s2.stateOf(session2).cursor, 10, "持久化边界优先：从上次覆盖边界 10 续提");
    s2.onTurnCompleted(session2, 20);
    await s2.quiesce();
    assert.deepEqual(calls2, [[10, 20]], "先前失败区间被一起覆盖");
    assert.equal(s2.stateOf(session2).cursor, 20);
    await j2.flush();
    assert.equal(j2.real.getUnrecovered().length, 0, "补提后未恢复清单清空");
    await s2.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("重启续提：journal 无该会话记录时仍不回扫历史（老语义不变）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-state-norec-"));
  const silent = { info() {}, warn() {}, error() {} };
  try {
    const journal = createJournal({ storageRoot: root, log: silent });
    assert.equal(journal.getCursor("never-seen"), null, "无记录 = null（不是 0）");
    const calls = [];
    const scheduler = createScheduler({
      log: silent,
      extract: async (session, from, to) => {
        calls.push([from, to]);
        return ok();
      },
      journal,
    });
    const session = fakeSession(100, "never-seen");
    scheduler.see(session, { seq: 100 });
    assert.equal(scheduler.stateOf(session).cursor, 101, "仍走 seq+1 跳历史，绝不回扫");
    await scheduler.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

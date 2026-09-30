// state：提取状态机推进纪律（边界①：skip 推进/error 不推进/单飞合并；边界⑥：abort 不推进）
import assert from "node:assert/strict";
import { test } from "node:test";
import { createScheduler } from "../lib/state.js";

function fakeSession(seq) {
  return { seq };
}

test("skip（ok）推进 cursor", async () => {
  let calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      return "ok";
    },
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
      return fail ? "error" : "ok";
    },
  });
  const session = fakeSession(5);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 5);
  await scheduler.quiesce();
  assert.equal(scheduler.stateOf(session).cursor, 0); // 不推进
  fail = false;
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
      return "ok";
    },
  });
  const session = fakeSession(0);
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
  const scheduler = createScheduler({ extract: async () => "ok" });
  const fresh = fakeSession(1);
  scheduler.see(fresh, { seq: 0 });
  assert.equal(scheduler.stateOf(fresh).cursor, 0);
  const resumed = fakeSession(100);
  scheduler.see(resumed, { seq: 100 }); // 恢复会话的新事件在既有历史之后
  assert.equal(scheduler.stateOf(resumed).cursor, 101);
  void scheduler.dispose();
});

test("已覆盖区间（toSeq ≤ cursor）不重复调度", async () => {
  const calls = [];
  const scheduler = createScheduler({
    extract: async (session, from, to) => {
      calls.push([from, to]);
      return "ok";
    },
  });
  const session = fakeSession(0);
  scheduler.see(session, { seq: 0 });
  scheduler.onTurnCompleted(session, 2);
  scheduler.onTurnCompleted(session, 1); // 旧边界，已被覆盖
  await scheduler.quiesce();
  assert.deepEqual(calls, [[0, 2]]);
  await scheduler.dispose();
});

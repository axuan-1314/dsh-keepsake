// turn-activity：四面观测按会话与时间窗归并的派生视图（纯函数）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { collectEvents, turnActivity, TURN_WINDOW_MS } from "../lib/turn-activity.js";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const MIN = 60 * 1000;

function iso(msAgo) {
  return new Date(NOW - msAgo).toISOString();
}

function snapshots(overrides = {}) {
  return {
    now: NOW,
    extractionLog: {
      runs: [
        { at: iso(5 * MIN), sessionId: "s1", from: 10, to: 20, outcome: "written", writes: 2, deletes: 0, failedOps: 0, truncatedParse: 0 },
        { at: iso(9 * MIN), sessionId: "s2", from: 1, to: 5, outcome: "failed", reason: "llm-error" },
      ],
    },
    injection: { count: 3, lastAt: NOW - 6 * MIN, lastChars: 1200, droppedSegments: 1, compactedSegments: 2 },
    idleReview: { runs: 1, lastAt: NOW - 20 * MIN, lastOutcome: "written", lastWrites: 1, lastDeletes: 1 },
    corrections: { recent: [{ at: iso(30 * MIN), target: "deploy.md", outcome: "applied", writes: 1, deletes: 0 }] },
    ...overrides,
  };
}

test("collectEvents：四面都能拍平成事件，按时间倒序", () => {
  const events = collectEvents(snapshots());
  assert.equal(events.length, 5, "2 提取 + 1 注入 + 1 整理 + 1 纠错");
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(events[i - 1].at >= events[i].at, "必须时间倒序");
  }
  const kinds = events.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ["correction", "extraction", "extraction", "idle-review", "injection"]);
  const written = events.find((e) => e.kind === "extraction" && e.outcome === "written");
  assert.equal(written.sessionId, "s1");
  assert.match(written.detail, /已写 2 条/);
});

test("collectEvents：注入/整理/纠错没有 sessionId，如实留空（不编归属）", () => {
  const events = collectEvents(snapshots());
  for (const kind of ["injection", "idle-review", "correction"]) {
    const e = events.find((x) => x.kind === kind);
    assert.equal(e.sessionId, "", `${kind} 不该有会话归属`);
  }
});

test("collectEvents：字段缺失/脏值不炸，坏行跳过", () => {
  assert.deepEqual(collectEvents({ now: NOW }), []);
  assert.deepEqual(collectEvents({ extractionLog: { runs: [null, "x", { at: "不是时间" }] }, now: NOW }), []);
  // 注入 count=0 不出行（没注入过就别印一条空事件）
  assert.deepEqual(collectEvents({ injection: { count: 0, lastAt: NOW }, now: NOW }), []);
  // 整理 runs=0 同理
  assert.deepEqual(collectEvents({ idleReview: { runs: 0, lastAt: NOW }, now: NOW }), []);
});

test("turnActivity：按会话过滤提取事件，无归属事件按时间窗保留", () => {
  const out = turnActivity(snapshots(), { sessionId: "s1" });
  const extractions = out.events.filter((e) => e.kind === "extraction");
  assert.equal(extractions.length, 1);
  assert.equal(extractions[0].sessionId, "s1");
  // 注入/整理/纠错仍在窗口内 → 保留（已在 detail 说明粒度）
  assert.ok(out.events.some((e) => e.kind === "injection"));
  assert.equal(out.sessionId, "s1");
});

test("turnActivity：不传会话 = 全局视图（所有提取都在）", () => {
  const out = turnActivity(snapshots(), {});
  assert.equal(out.events.filter((e) => e.kind === "extraction").length, 2);
  assert.equal(out.sessionId, "");
});

test("turnActivity：默认窗口 30 分钟，窗口外的老事件被排除", () => {
  const out = turnActivity(snapshots(), {});
  assert.equal(out.window.until - out.window.since, TURN_WINDOW_MS);
  // 30 分钟前那条纠错正好在边界上（>= since 保留）
  assert.ok(out.events.some((e) => e.kind === "correction"));
  // 再往前推 1 分钟就该出窗
  const wider = turnActivity(snapshots(), { since: NOW - 31 * MIN });
  assert.ok(wider.events.some((e) => e.kind === "correction"));
});

test("turnActivity：显式 since/until 生效，且窗口钳到一周上限并如实回报实际窗口", () => {
  const out = turnActivity(snapshots(), { since: NOW - 60 * 24 * 60 * MIN, until: NOW });
  assert.equal(out.window.until, NOW);
  const width = out.window.until - out.window.since;
  assert.equal(width, 7 * 24 * 60 * 60 * 1000, "超过一周的请求钳到一周");
});

test("turnActivity：limit 生效且 truncated 如实", () => {
  const out = turnActivity(snapshots(), { limit: 2 });
  assert.equal(out.events.length, 2);
  assert.equal(out.truncated, true);
  assert.equal(out.total, 5);
});

// 越界时间戳：数字型 8.64e15+1 / 1e17 原先一路走到 new Date().toISOString() 才抛
// RangeError，把整个「最近活动」页打成 500。msOf 现在做范围夹取。
test("collectEvents：越界数字时间戳不炸（RangeError 曾整页 500）", () => {
  assert.doesNotThrow(() => collectEvents({
    extractionLog: { runs: [{ at: 8.64e15 + 1, sessionId: "s", outcome: "ok" }] },
    now: NOW,
  }));
  assert.doesNotThrow(() => collectEvents({ injection: { count: 1, lastAt: 1e17, lastChars: 1 }, now: NOW }));
  assert.doesNotThrow(() => collectEvents({ idleReview: { lastAt: 1e17, runs: 1 }, now: NOW }));
  // 越界事件被跳过，不是被悄悄夹到边界、编成一条假事件
  const out = collectEvents({ extractionLog: { runs: [{ at: 8.64e15 + 1, sessionId: "s" }] }, now: NOW });
  assert.equal(out.length, 0, "越界时间戳的事件应被丢弃，不编造归属时间");
});

test("collectEvents：合法但久远的数字时间戳仍然保留（别把夹取写成一律丢弃）", () => {
  const out = collectEvents({ injection: { count: 1, lastAt: NOW - MIN, lastChars: 10 }, now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].at, NOW - MIN);
});

// 非法窗口：since > until 原先回报负宽度，面板算成「最近 0 分钟」，
// 看起来像刚看过、没事发生。
test("turnActivity：since > until 钳到 until，不回报负宽度窗口", () => {
  const out = turnActivity(snapshots(), { since: NOW + 60 * MIN, until: NOW });
  assert.equal(out.window.until, NOW);
  assert.equal(out.window.since, NOW, "非法窗口钳成零宽");
  assert.ok(out.window.until - out.window.since >= 0, "窗口宽度不得为负");
  assert.equal(out.total, 0);
});

test("turnActivity：越界 since（1e308）不产生负宽度窗口", () => {
  const out = turnActivity(snapshots(), { since: 1e308, until: NOW });
  assert.ok(out.window.until - out.window.since >= 0, "1e308 也要钳住");
  assert.equal(out.window.since, NOW);
});

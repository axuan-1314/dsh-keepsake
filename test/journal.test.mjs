// journal：提取结算 durable 层（落盘 JSONL + 跨重启恢复 cursor / 未恢复失败区间）。
// 全部走 os.tmpdir() 下 mkdtempSync 临时目录，不碰 ~/.dsh 真实数据；风格对齐
// test/observability.test.mjs（node:test + node:assert/strict，每例自建目录、finally 清理）。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JOURNAL_FILE_NAME, createJournal } from "../lib/journal.js";

/** 每例自建 storageRoot（绝不能指到真实 ~/.dsh 或仓库内固定路径）。 */
function tempRoot(prefix = "dsh-keepsake-journal-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 静默日志口 + 可选 spy：断言 warn/info 是否被调（写失败必须可见）。 */
function spyLog() {
  const calls = { warn: [], info: [], error: [] };
  return {
    calls,
    log: {
      warn: (...args) => { calls.warn.push(args.join(" ")); },
      info: (...args) => { calls.info.push(args.join(" ")); },
      error: (...args) => { calls.error.push(args.join(" ")); },
    },
  };
}

function lines(root) {
  const file = join(root, JOURNAL_FILE_NAME);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
}

// ---- 1. 基本正确性：ring 新在前 + ringMax 裁尾 + cursor 取每会话最新 ----

test("journal：recordRun → getRing/getCursor 基本正确性（新在前、ringMax 裁尾、cursor 每会话最新）", async () => {
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root, ringMax: 3 });
    await journal.recordRun({ sessionId: "s1", from: 0, to: 10, cursorAfter: 10, outcome: "written", writes: 2, at: 1700000000000 });
    await journal.recordRun({ sessionId: "s2", from: 5, to: 8, cursorAfter: 8, outcome: "zero-ops", at: 1700000001000 });
    await journal.recordRun({ sessionId: "s1", from: 10, to: 20, cursorAfter: 20, outcome: "written", deletes: 1, at: 1700000002000 });
    await journal.recordRun({ sessionId: "s1", from: 20, to: 30, cursorAfter: 30, outcome: "skipped", at: 1700000003000 });
    const ring = journal.getRing();
    assert.equal(ring.length, 3, "ringMax=3 裁尾");
    assert.deepEqual(ring.map((r) => [r.sessionId, r.from, r.to]), [["s1", 20, 30], ["s1", 10, 20], ["s2", 5, 8]], "新在前");
    assert.equal(ring[0].outcome, "skipped");
    assert.equal(ring[1].deletes, 1, "数值字段保留");
    assert.equal(ring[2].writes, 0, "数值字段缺省 0");
    assert.equal(ring[0].at, "2023-11-14T22:13:23.000Z", "at 序列化为 ISO 字符串");
    // cursor：s1 取最后一条（30），s2 不受 s1 影响，未知会话 null
    assert.equal(journal.getCursor("s1"), 30);
    assert.equal(journal.getCursor("s2"), 8);
    assert.equal(journal.getCursor("s-unknown"), null, "未知会话 null（null 与 0 必须可区分）");
    // 快照 = ring + unrecovered 两份
    const snap = journal.snapshot();
    assert.equal(snap.runs.length, 3);
    assert.deepEqual(snap.unrecovered, []);
    // 快照是拷贝：外改不污染内部态
    snap.runs[0].to = 999;
    assert.equal(journal.getRing()[0].to, 30);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 2. 重放：同 storageRoot 新建实例，三件套全部恢复 ----

test("journal：重放（新实例）恢复 cursor/ring/unrecovered", async () => {
  const root = tempRoot();
  try {
    const first = createJournal({ storageRoot: root });
    await first.recordRun({ sessionId: "s1", from: 0, to: 10, cursorAfter: 10, outcome: "written", at: 1700000000000 });
    await first.recordRun({ sessionId: "s2", from: 3, to: 9, cursorAfter: 3, outcome: "failed", reason: "llm-error", at: 1700000001000 });
    await first.recordRun({ sessionId: "s1", from: 10, to: 15, cursorAfter: 15, outcome: "zero-ops", at: 1700000002000 });
    const before = first.snapshot();

    // 同根新建实例 = 模拟重启
    const second = createJournal({ storageRoot: root });
    assert.equal(second.getCursor("s1"), 15, "cursor 跨重启恢复");
    assert.equal(second.getCursor("s2"), 3);
    assert.deepEqual(second.getRing().map((r) => [r.sessionId, r.from, r.to]), [["s1", 10, 15], ["s2", 3, 9], ["s1", 0, 10]]);
    assert.deepEqual(second.getUnrecovered(), [{ sessionId: "s2", from: 3, to: 9, at: "2023-11-14T22:13:21.000Z", reason: "llm-error" }]);
    assert.deepEqual(second.snapshot().unrecovered, before.unrecovered);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal：全新 storageRoot（无文件）空态不报错", async () => {
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root });
    assert.deepEqual(journal.getRing(), []);
    assert.deepEqual(journal.getUnrecovered(), []);
    assert.equal(journal.getCursor("s1"), null);
    await journal.recordRun({ sessionId: "s1", from: 0, to: 1, cursorAfter: 1, outcome: "written" });
    assert.equal(lines(root).length, 1, "首次追加建文件");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 3. getUnrecovered 三分支 ----

test("journal：getUnrecovered 三分支（在列 / 后续推进出列 / 放弃型不入列）", async () => {
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root });
    // ① 失败且 cursorAfter===from（cursor 没动）→ 在列
    await journal.recordRun({ sessionId: "s1", from: 10, to: 20, cursorAfter: 10, outcome: "failed", reason: "llm-error", at: 1700000000000 });
    assert.deepEqual(journal.getUnrecovered().map((u) => [u.sessionId, u.from, u.to, u.reason]), [["s1", 10, 20, "llm-error"]]);
    // ③ 失败但 cursorAfter 已推进（放弃型：管道自己决定不再补）→ 不入列
    await journal.recordRun({ sessionId: "s2", from: 30, to: 40, cursorAfter: 40, outcome: "failed", reason: "gave-up", at: 1700000001000 });
    assert.deepEqual(journal.getUnrecovered().map((u) => u.sessionId), ["s1"], "放弃型不入列");
    // 多会话并存：新在前
    await journal.recordRun({ sessionId: "s3", from: 0, to: 5, cursorAfter: 0, outcome: "failed", reason: "io-error", at: 1700000002000 });
    assert.deepEqual(journal.getUnrecovered().map((u) => [u.sessionId, u.from, u.to]), [["s3", 0, 5], ["s1", 10, 20]], "新在前");
    // ② 后续同会话记录把 cursor 推过 to → s1 出列（且不误清 s3：跨会话互不影响）
    await journal.recordRun({ sessionId: "s1", from: 10, to: 20, cursorAfter: 20, outcome: "written", at: 1700000003000 });
    assert.deepEqual(journal.getUnrecovered().map((u) => [u.sessionId, u.from, u.to]), [["s3", 0, 5]], "推进后出列，跨会话不误清");
    // 推进超过 to（而非恰好等于）同样出列
    await journal.recordRun({ sessionId: "s3", from: 0, to: 9, cursorAfter: 12, outcome: "skipped", at: 1700000004000 });
    assert.deepEqual(journal.getUnrecovered(), [], "cursorAfter > to 同样视为已补上");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 4. 并发：20 次 recordRun 不 await，混合 2 个会话 ----

test("journal：并发 20 次 recordRun（2 会话混合）全部落盘、行数正确、无坏行", async () => {
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root, rotateAt: 500 });
    const promises = [];
    for (let i = 0; i < 20; i += 1) {
      const sessionId = i % 2 === 0 ? "sA" : "sB";
      promises.push(journal.recordRun({ sessionId, from: i, to: i + 1, cursorAfter: i + 1, outcome: "written", writes: 1, at: 1700000000000 + i }));
    }
    await Promise.all(promises);
    const written = lines(root);
    assert.equal(written.length, 20, "一行不丢（串行化队列生效）");
    // 无坏行 = 每行都是完整 JSON 且 sessionId 在预期集内
    const ids = new Set(["sA", "sB"]);
    for (const line of written) {
      const obj = JSON.parse(line); // 抛错即坏行（交错写会在这里炸）
      assert.ok(ids.has(obj.sessionId), `未知会话 ${obj.sessionId}`);
      assert.equal(typeof obj.at, "string");
    }
    // 并发下每会话 cursor 取各自最后一条（sA 最后一次 i=18 → 19；sB i=19 → 20）
    assert.equal(journal.getCursor("sA"), 19);
    assert.equal(journal.getCursor("sB"), 20);
    assert.equal(journal.getRing().length, 20);
    assert.equal(journal.getRing()[0].sessionId, "sB", "最后一次追加的在最前");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal：并发下区间互不串味（同会话串行推进，未恢复区间只算自己的）", async () => {
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root });
    const promises = [];
    // 10 个会话各失败一段（cursor 停在 from）：并发写互不串味。
    // 同一会话连续推进的场景下，后一条 cursor 必然推过前一条的 to 从而把前段出列
    // （这是「已补提」的正确语义），故此处用跨会话并发验证互不干扰。
    for (let i = 0; i < 10; i += 1) {
      promises.push(journal.recordRun({ sessionId: `s${i}`, from: i, to: i + 1, cursorAfter: i, outcome: "failed", reason: `r${i}`, at: 1700000000000 + i }));
    }
    await Promise.all(promises);
    const unrecovered = journal.getUnrecovered();
    assert.equal(unrecovered.length, 10, "10 个会话各自失败、cursor 未动 → 10 段都在列");
    assert.deepEqual(unrecovered.map((u) => u.reason), ["r9", "r8", "r7", "r6", "r5", "r4", "r3", "r2", "r1", "r0"], "新在前（按结算顺序，非 reason 字典序）");
    assert.equal(journal.getCursor("s9"), 9);
    assert.equal(journal.getCursor("s0"), 0);
    // 逐个补提：只清自己的段，不误清别人的
    await journal.recordRun({ sessionId: "s9", from: 9, to: 10, cursorAfter: 10, outcome: "written", at: 1700000100000 });
    assert.deepEqual(journal.getUnrecovered().map((u) => u.sessionId), ["s8", "s7", "s6", "s5", "s4", "s3", "s2", "s1", "s0"], "补提只清自己那一段");
    assert.equal(lines(root).length, 11, "并发 11 条结算全部落盘");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 5. 坏行容错 ----

test("journal：坏行跳过不炸 + 好行照常恢复 + 逐行 warn", () => {
  const root = tempRoot();
  try {
    const file = join(root, JOURNAL_FILE_NAME);
    writeFileSync(
      file,
      [
        "",
        "{ not json",
        JSON.stringify({ sessionId: "s1", from: 0, to: 10, cursorAfter: 10, outcome: "written", at: 1700000000000 }),
        "[1,2,3]",
        JSON.stringify({ noSession: true, from: 0 }),
        JSON.stringify({ sessionId: "s2", from: 5, to: 9, cursorAfter: 5, outcome: "failed", reason: "io-error", at: 1700000001000 }),
        "half-line {",
        "",
      ].join("\n"),
      "utf8",
    );
    const { log, calls } = spyLog();
    const journal = createJournal({ storageRoot: root, log });
    assert.equal(journal.getCursor("s1"), 10, "好行恢复");
    assert.equal(journal.getCursor("s2"), 5);
    assert.equal(journal.getRing().length, 2, "只有 2 条好行入环");
    assert.deepEqual(journal.getUnrecovered().map((u) => u.sessionId), ["s2"], "坏行不污染未恢复清单");
    // 坏行逐行 warn（空行不算坏行）：4 条坏行 → 4 条 warn
    assert.equal(calls.warn.length, 4, `坏行逐行告警（实际 ${calls.warn.length}）：${calls.warn.join(" | ")}`);
    assert.ok(calls.warn.every((m) => m.includes("journal")), "warn 文案含 journal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal：字段级脏值（负数/小数/未 outcome）按写侧同口径钳制而非整行丢弃", () => {
  const root = tempRoot();
  try {
    writeFileSync(
      join(root, JOURNAL_FILE_NAME),
      `${JSON.stringify({ sessionId: "s1", from: -5, to: 7.9, cursorAfter: -1, outcome: "weird", at: 1700000000000 })}\n`,
      "utf8",
    );
    const journal = createJournal({ storageRoot: root });
    const rec = journal.getRing()[0];
    assert.equal(rec.from, 0, "负数钳 0");
    assert.equal(rec.to, 7, "小数取整");
    assert.equal(rec.cursorAfter, 0);
    assert.equal(rec.outcome, "failed", "非法 outcome 按 failed 记（最保守）");
    assert.equal(journal.getCursor("s1"), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 6. 轮转 ----

test("journal：轮转 rotateAt=5/keepOnRotate=3 —— 文件只剩 3 行且内存态/重放后 cursor 不丢", async () => {
  const root = tempRoot();
  try {
    const { log, calls } = spyLog();
    const journal = createJournal({ storageRoot: root, log, rotateAt: 5, keepOnRotate: 3, ringMax: 30 });
    for (let i = 1; i <= 7; i += 1) {
      await journal.recordRun({ sessionId: "s1", from: i - 1, to: i, cursorAfter: i, outcome: "written", at: 1700000000000 + i });
    }
    const kept = lines(root);
    assert.equal(kept.length, 3, "轮转后文件只剩 keepOnRotate 行");
    const parsed = kept.map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((r) => r.cursorAfter), [5, 6, 7], "保留尾部（最新）3 行");
    // 内存态不受轮转影响：cursor 仍是最后一条
    assert.equal(journal.getCursor("s1"), 7);
    assert.equal(journal.getRing().length, 7, "ring 是内存态，不因裁行变短");
    // 轮转记一条 info
    assert.ok(calls.info.length >= 1, "轮转要留 info 痕");
    assert.ok(calls.info.some((m) => m.includes("journal")), "info 文案含 journal");
    // 重放后：文件虽只剩 3 行，cursor 仍取得到（=7，不是被裁掉的 4）
    const again = createJournal({ storageRoot: root, rotateAt: 5, keepOnRotate: 3 });
    assert.equal(again.getCursor("s1"), 7, "重放取尾部最新 cursor");
    assert.equal(again.getRing().length, 3, "重放 ring = 盘上剩余行数");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal：轮转不吞未恢复失败区间（裁掉旧行后 unrecovered 仍在内存态）", async () => {
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root, rotateAt: 3, keepOnRotate: 1 });
    await journal.recordRun({ sessionId: "s1", from: 10, to: 20, cursorAfter: 10, outcome: "failed", reason: "llm-error", at: 1700000000000 });
    await journal.recordRun({ sessionId: "s2", from: 0, to: 1, cursorAfter: 1, outcome: "written", at: 1700000001000 });
    await journal.recordRun({ sessionId: "s2", from: 1, to: 2, cursorAfter: 2, outcome: "written", at: 1700000002000 });
    assert.equal(lines(root).length, 1, "已轮转到 1 行");
    // 失败行已被裁出文件，但未恢复清单必须还在——那是跨重启补提的命脉
    assert.deepEqual(journal.getUnrecovered().map((u) => [u.sessionId, u.from, u.to]), [["s1", 10, 20]]);
    assert.equal(journal.getCursor("s1"), 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal：轮转阈值按 >= 触发（恰满 rotateAt 即转，主档恒不超过 rotateAt 行）", async () => {
  // 钉住 >= 而非 > 的口径：若被改成 >，恰满阈值的这第 4 条不触发轮转、盘上会留 4 行。
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root, rotateAt: 4, keepOnRotate: 2, ringMax: 30 });
    for (let i = 1; i <= 4; i += 1) {
      await journal.recordRun({ sessionId: "s1", from: i - 1, to: i, cursorAfter: i, outcome: "written", at: 1700000000000 + i });
    }
    assert.equal(lines(root).length, 2, "恰满 rotateAt 即轮转到 keepOnRotate 行");
    assert.equal(journal.getCursor("s1"), 4, "内存态 cursor 不受轮转影响");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 7. 写失败不抛（降级可见） ----

test("journal：写失败不抛，内存态照常更新 + log.warn（文案含 journal）", async () => {
  const root = tempRoot();
  try {
    // storageRoot 指到「文件占位的路径」：mkdirSync/appendFileSync 必炸（ENOTDIR）
    const file = join(root, "blocker");
    writeFileSync(file, "i am a file, not a dir", "utf8");
    const { log, calls } = spyLog();
    const journal = createJournal({ storageRoot: join(file, "nope"), log });
    // 不抛（非致命降级）
    await assert.doesNotReject(() => journal.recordRun({ sessionId: "s1", from: 0, to: 5, cursorAfter: 5, outcome: "written" }));
    assert.doesNotThrow(() => journal.recordRun({ sessionId: "s1", from: 5, to: 9, cursorAfter: 5, outcome: "failed", reason: "io-error" }));
    // 内存态照常更新（本进程内面板/补提逻辑仍可用）
    assert.equal(journal.getCursor("s1"), 5);
    assert.deepEqual(journal.getUnrecovered().map((u) => [u.from, u.to]), [[5, 9]]);
    // 落盘失败必须留痕：warn 被调且文案含 journal
    assert.ok(calls.warn.length >= 1, "写失败要 warn");
    assert.ok(calls.warn.every((m) => m.includes("journal")), `warn 文案含 journal（实际：${calls.warn.join(" | ")}）`);
    // 后续结算不被一次失败堵死（队列前序失败照常继续）
    await journal.recordRun({ sessionId: "s1", from: 9, to: 12, cursorAfter: 12, outcome: "written" });
    assert.equal(journal.getCursor("s1"), 12, "一次写失败不堵死后续结算");
    assert.ok(calls.warn.length >= 3, "每次失败都留痕");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal：storageRoot 缺省/空串也不抛（降级为纯内存态）", async () => {
  const { log, calls } = spyLog();
  const journal = createJournal({ log });
  await assert.doesNotReject(() => journal.recordRun({ sessionId: "s1", from: 0, to: 1, cursorAfter: 1, outcome: "written" }));
  assert.equal(journal.getCursor("s1"), 1, "内存态仍更新");
  assert.ok(calls.warn.some((m) => m.includes("journal")));
});

// ---- 8. 入参校验 ----

test("journal：非法 outcome 钳为 failed 且 reason 带 bad-outcome: 前缀；空 sessionId 抛 TypeError", async () => {
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root });
    const rec = await journal.recordRun({ sessionId: "s1", from: 0, to: 5, cursorAfter: 0, outcome: "OK-typo", reason: "llm-error", at: 1700000000000 });
    assert.equal(rec.outcome, "failed", "非法 outcome 按 failed 记");
    assert.ok(rec.reason.startsWith("bad-outcome:OK-typo"), `reason 带前缀（实际：${rec.reason}）`);
    assert.ok(rec.reason.includes("llm-error"), "原 reason 保留在后（不丢证据）");
    // 无 reason 时前缀即全部
    const bare = await journal.recordRun({ sessionId: "s1", from: 5, to: 9, cursorAfter: 5, outcome: 42 });
    assert.equal(bare.outcome, "failed");
    assert.equal(bare.reason, "bad-outcome:42");
    // outcome 缺省（undefined）同样按非法处理
    const missing = await journal.recordRun({ sessionId: "s2", from: 0, to: 3, cursorAfter: 3 });
    assert.equal(missing.outcome, "failed");
    assert.equal(missing.reason, "bad-outcome:undefined");
    // 四个合法值原样保留
    for (const ok of ["written", "zero-ops", "skipped", "failed"]) {
      const r = await journal.recordRun({ sessionId: "s3", from: 0, to: 1, cursorAfter: 1, outcome: ok });
      assert.equal(r.outcome, ok);
      assert.equal(r.reason, "", "合法 outcome 不注入 bad-outcome 前缀");
    }
    // 落盘同步可见
    const persisted = lines(root).map((l) => JSON.parse(l));
    assert.equal(persisted[0].outcome, "failed");
    assert.ok(persisted[0].reason.startsWith("bad-outcome:OK-typo"));
    // 空 sessionId 抛 TypeError（调用方 bug 要炸出来，不静默）
    assert.throws(() => journal.recordRun({ sessionId: "", from: 0, to: 1, outcome: "written" }), TypeError);
    assert.throws(() => journal.recordRun({ sessionId: "   ", from: 0, to: 1, outcome: "written" }), TypeError);
    assert.throws(() => journal.recordRun({ from: 0, to: 1, outcome: "written" }), TypeError);
    assert.throws(() => journal.recordRun({ sessionId: 7, from: 0, to: 1, outcome: "written" }), TypeError);
    assert.equal(lines(root).length, 7, "抛错的调用不落盘、不污染内存态");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal：数值字段钳为非负整数、at 缺省 Date.now()、reason 缺省空串", async () => {
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root });
    const rec = await journal.recordRun({
      sessionId: "s1",
      from: -3, to: 4.7, cursorAfter: NaN, writes: -1, deletes: 2.2, skippedOps: Infinity, failedOps: -0.5, filtered: "x",
    });
    assert.equal(rec.from, 0);
    assert.equal(rec.to, 4, "小数取整（不四舍五入：4.7 → 4）");
    assert.equal(rec.cursorAfter, 0, "NaN 钳 0");
    assert.equal(rec.writes, 0);
    assert.equal(rec.deletes, 2);
    assert.equal(rec.skippedOps, 0, "Infinity 钳 0");
    assert.equal(rec.failedOps, 0);
    assert.equal(rec.filtered, 0, "非数字钳 0");
    assert.equal(rec.outcome, "failed", "outcome 缺省按非法处理（最保守）");
    assert.equal(rec.reason, "bad-outcome:undefined", "非法 outcome 时 reason 必带 bad-outcome 前缀（缺省 reason 即前缀本身）");
    const atMs = Date.parse(rec.at);
    assert.ok(Number.isFinite(atMs), "at 缺省可解析");
    assert.ok(Math.abs(atMs - Date.now()) < 60_000, "at 缺省≈当前时刻");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

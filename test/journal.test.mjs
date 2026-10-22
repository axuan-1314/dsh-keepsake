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

test("journal：出列判据收紧为完全覆盖——部分覆盖（起点更晚）不得出列", async () => {
  // R1 复现：pending [0,10)，随后同会话一段 from=5、cursorAfter=12 的补提（尾巴伸过了 10），
  // 但 [0,5) 这段从没提取过——旧判据只看 cursorAfter>=to 会把它整段出列、留痕凭空消失。
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root });
    await journal.recordRun({ sessionId: "s1", from: 0, to: 10, cursorAfter: 0, outcome: "failed", reason: "llm-error", at: 1700000000000 });
    assert.deepEqual(journal.getUnrecovered().map((u) => [u.sessionId, u.from, u.to]), [["s1", 0, 10]], "前置：失败区间在列");
    // 起点更晚（from=5 > 0）：只盖住了 [5,12)，[0,5) 仍未提取 → 不出列
    await journal.recordRun({ sessionId: "s1", from: 5, to: 12, cursorAfter: 12, outcome: "written", writes: 1, at: 1700000001000 });
    assert.deepEqual(
      journal.getUnrecovered().map((u) => [u.sessionId, u.from, u.to]),
      [["s1", 0, 10]],
      "部分覆盖不得出列（[0,5) 从未提取，留痕不能丢）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal：出列判据收紧为完全覆盖——完全覆盖照旧出列（起点对齐 + 尾巴伸过）", async () => {
  // 起点与 cursor 对齐的在线连续推进（rec.from === p.from）、以及起点更早的补提，
  // 都算整段覆盖 → 照常出列；收紧判据不得把这两条正确路径误伤。
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root });
    // 起首对齐：from=10 与失败区间起点一致，cursorAfter 伸过 to → 出列
    await journal.recordRun({ sessionId: "s1", from: 10, to: 20, cursorAfter: 10, outcome: "failed", reason: "llm-error", at: 1700000000000 });
    await journal.recordRun({ sessionId: "s1", from: 10, to: 20, cursorAfter: 20, outcome: "written", writes: 1, at: 1700000001000 });
    assert.deepEqual(journal.getUnrecovered(), [], "起点对齐的连续推进照常出列");
    // 起点更早（from=5 <= 10）且尾巴伸过 to → 整段覆盖，同样出列
    await journal.recordRun({ sessionId: "s2", from: 10, to: 30, cursorAfter: 10, outcome: "failed", reason: "io-error", at: 1700000002000 });
    await journal.recordRun({ sessionId: "s2", from: 5, to: 30, cursorAfter: 30, outcome: "written", writes: 1, at: 1700000003000 });
    assert.deepEqual(journal.getUnrecovered(), [], "起点更早且完全覆盖照常出列");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal：出列先于入列的顺序钉——[from==to] 退化区间不得自出列", async () => {
  // 若把 apply() 里的顺序颠倒（先入列再出列），刚入列的失败区间会拿自己的记录判自己「已覆盖」：
  // rec.from<=p.from（相等）且 rec.cursorAfter>=p.to（相等）成立 → 立刻自出列、凭空消失。
  // [from==to] 的退化区间（零长度承诺）正是这条顺序的探针：入列后必须仍在列。
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root });
    await journal.recordRun({ sessionId: "s1", from: 5, to: 5, cursorAfter: 5, outcome: "failed", reason: "llm-error", at: 1700000000000 });
    assert.deepEqual(
      journal.getUnrecovered().map((u) => [u.sessionId, u.from, u.to]),
      [["s1", 5, 5]],
      "退化区间入列后必须仍在列（出列必须先于入列，否则会自出列）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 3b. 放弃区间（abandoned）：独立留痕 + 跨重启可见 + 与 lost 区间互斥 ----

test("journal：abandoned 独立留痕（新在前、封顶、abandonedCount）+ 与 unrecovered 互斥", async () => {
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root, abandonedMax: 3 });
    // 放弃型：cursorAfter>from（cursor 已推进），不进 unrecovered，只进 abandoned
    await journal.recordRun({ sessionId: "s1", from: 0, to: 10, cursorAfter: 10, outcome: "abandoned", reason: "no-cwd", at: 1700000000000 });
    await journal.recordRun({ sessionId: "s1", from: 10, to: 20, cursorAfter: 20, outcome: "abandoned", reason: "no-route", at: 1700000001000 });
    // failed 未推进：进 unrecovered 不进 abandoned
    await journal.recordRun({ sessionId: "s2", from: 0, to: 5, cursorAfter: 0, outcome: "failed", reason: "llm-error", at: 1700000002000 });
    const snap = journal.snapshot();
    assert.equal(snap.abandoned.length, 2, "两条放弃区间在列");
    assert.equal(snap.abandonedCount, 2);
    assert.deepEqual(snap.abandoned[0], { from: 10, to: 20, sessionId: "s1", at: "2023-11-14T22:13:21.000Z", reason: "no-route" }, "新在前");
    assert.equal(snap.unrecovered.length, 1, "failed 未推进在未恢复清单");
    assert.equal(snap.unrecovered[0].sessionId, "s2");
    assert.equal(snap.abandoned.every((a) => a.sessionId === "s1"), true, "放弃区间不含 failed 的 s2");
    // 封顶：超 abandonedMax 裁尾（保留最新），但 abandonedCount 不封顶
    await journal.recordRun({ sessionId: "s1", from: 20, to: 30, cursorAfter: 30, outcome: "abandoned", reason: "no-cwd", at: 1700000003000 });
    await journal.recordRun({ sessionId: "s1", from: 30, to: 40, cursorAfter: 40, outcome: "abandoned", reason: "no-cwd", at: 1700000004000 });
    assert.equal(journal.snapshot().abandoned.length, 3, "封顶 3");
    assert.equal(journal.snapshot().abandonedCount, 4, "累计计数不封顶");
    assert.deepEqual(journal.snapshot().abandoned.map((a) => a.from), [30, 20, 10], "保留最新（新在前）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal：abandoned 顺序稳定（按 at 定序、跨重放一致，不靠 unshift 隐式顺序）", async () => {
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root });
    // 入列顺序故意与 at 时序相悖（时钟偏差/盘上手改/交错重放）：纯 unshift 顺序会给出
    // [from=1(at 早), from=0(at 晚)]，而按 at 降序（新在前）应得 [from=0, from=1]。
    await journal.recordRun({ sessionId: "s1", from: 0, to: 1, cursorAfter: 1, outcome: "abandoned", reason: "no-cwd", at: 1700000002000 });
    await journal.recordRun({ sessionId: "s1", from: 1, to: 2, cursorAfter: 2, outcome: "abandoned", reason: "no-cwd", at: 1700000001000 });
    const order = journal.snapshot().abandoned.map((a) => a.from);
    assert.deepEqual(order, [0, 1], "按 at 降序（新在前），与入列序无关");
    // 重启重放：同一 at 序 → 同一顺序（收集序由内容确定，非 unshift 机制）
    const again = createJournal({ storageRoot: root });
    assert.deepEqual(again.snapshot().abandoned.map((a) => a.from), [0, 1], "重放后顺序一致");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal：放弃区间跨『重启』（重放）仍可见——放弃不再永久消失", async () => {
  const root = tempRoot();
  try {
    const first = createJournal({ storageRoot: root });
    await first.recordRun({ sessionId: "s1", from: 0, to: 10, cursorAfter: 10, outcome: "abandoned", reason: "no-cwd", at: 1700000000000 });
    await first.recordRun({ sessionId: "s1", from: 10, to: 20, cursorAfter: 20, outcome: "written", writes: 1, at: 1700000001000 });
    const before = first.snapshot();
    // 新实例（模拟进程重启）重放盘上 JSONL
    const second = createJournal({ storageRoot: root });
    assert.deepEqual(second.snapshot().abandoned, before.abandoned, "重放后放弃区间逐字段恢复");
    assert.equal(second.snapshot().abandonedCount, 1);
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

test("journal：轮转强制保留未恢复失败区间（裁掉普通旧行，失败行留盘 + 重启仍可见）", async () => {
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root, rotateAt: 3, keepOnRotate: 1 });
    await journal.recordRun({ sessionId: "s1", from: 10, to: 20, cursorAfter: 10, outcome: "failed", reason: "llm-error", at: 1700000000000 });
    await journal.recordRun({ sessionId: "s2", from: 0, to: 1, cursorAfter: 1, outcome: "written", at: 1700000001000 });
    await journal.recordRun({ sessionId: "s2", from: 1, to: 2, cursorAfter: 2, outcome: "written", at: 1700000002000 });
    // 轮转后：普通旧行（s2 第一条）被裁，尾窗 1 行 + 强制保留的失败行 → 2 行（可超 keepEff）
    const onDisk = lines(root);
    assert.equal(onDisk.length, 2, "尾窗 1 行 + 强制保留的未恢复失败行 1 行");
    assert.equal(JSON.parse(onDisk[0]).outcome, "failed", "失败行留在盘上（无论多旧）");
    // 内存态未恢复清单不受轮转影响
    assert.deepEqual(journal.getUnrecovered().map((u) => [u.sessionId, u.from, u.to]), [["s1", 10, 20]]);
    assert.equal(journal.getCursor("s1"), 10);
    // 重启重放：未恢复区间从盘上重建（此前裁掉旧行后重启就再也见不到）
    const again = createJournal({ storageRoot: root, rotateAt: 3, keepOnRotate: 1 });
    assert.deepEqual(again.getUnrecovered().map((u) => [u.sessionId, u.from, u.to]), [["s1", 10, 20]], "重启后未恢复区间仍可见");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal：轮转强制保留 abandoned（永久留痕跨轮转 + 跨重启仍可见，abandonedCount 不丢）", async () => {
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root, rotateAt: 4, keepOnRotate: 2 });
    // 先记一条放弃区间（旧行），随后写足普通结算把它挤出尾窗
    await journal.recordRun({ sessionId: "s1", from: 0, to: 10, cursorAfter: 10, outcome: "abandoned", reason: "no-cwd", at: 1700000000000 });
    for (let i = 1; i <= 6; i += 1) {
      await journal.recordRun({ sessionId: "s2", from: i - 1, to: i, cursorAfter: i, outcome: "written", at: 1700000000000 + i });
    }
    // 盘上：尾窗内普通行 + 强制保留的 abandoned 行（放弃行无论多旧都不被裁）
    const onDisk = lines(root).map((l) => JSON.parse(l));
    assert.equal(onDisk.filter((r) => r.outcome === "abandoned").length, 1, "放弃行永久留痕（未被轮转裁掉）");
    assert.ok(onDisk.length >= 3, "尾窗普通行 + 强制保留 abandoned 行同存盘上（可超 keepOnRotate）");
    // 重启重放：放弃区间与累计计数都从盘上恢复
    const again = createJournal({ storageRoot: root, rotateAt: 4, keepOnRotate: 2 });
    const snap = again.snapshot();
    assert.equal(snap.abandoned.length, 1, "重启后放弃区间仍可见");
    assert.deepEqual(snap.abandoned[0], { from: 0, to: 10, sessionId: "s1", at: "2023-11-14T22:13:20.000Z", reason: "no-cwd" });
    assert.equal(snap.abandonedCount, 1, "累计放弃计数不因轮转丢");
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

test("journal：轮转 keepEff 钳制——keepOnRotate 大于 rotateAt 时盘上行数仍被压到 rotateAt 以内", async () => {
  // keepOnRotate > rotateAt 会让轮转自相矛盾（每次想保留的行数比触发线还多，行数越攒越多）。
  // 实现把 keepEff 钳到 rotateAt；若去掉这层钳制（keepEff 直接用 keepOnRotate），
  // 可裁窗口恒大于在场行数 → 永不裁剪 → 盘上行数随写入无上限增长，本用例应变红。
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root, rotateAt: 4, keepOnRotate: 100, ringMax: 30 });
    for (let i = 1; i <= 10; i += 1) {
      await journal.recordRun({ sessionId: "s1", from: i - 1, to: i, cursorAfter: i, outcome: "written", at: 1700000000000 + i });
    }
    const kept = lines(root);
    assert.ok(kept.length <= 4, `盘上行数应被压到 rotateAt（4）以内，实际 ${kept.length}`);
    assert.equal(kept.length, 4, "钳制后保留窗口 = rotateAt");
    assert.equal(JSON.parse(kept[kept.length - 1]).cursorAfter, 10, "最尾部是最新一行");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 6b. 轮转裁剪顺序（skipped 先裁，failed/abandoned 留存）----

test("journal：轮转裁剪按 outcome 定序——skipped 最先裁，written/failed 让位留存（gate-off 不丢失败留痕）", async () => {
  // 钉住「裁剪顺序」而非「行序」：gate-off 期间 skipped 成海，若仍按行序一刀切留尾部，
  // 更早的 failed 行会被冲掉——跨重启补提的命脉就没了。此处让 skipped 行【更新】却先被裁。
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root, rotateAt: 6, keepOnRotate: 2, ringMax: 30 });
    // 第 1 行：失败（cursor 未动 = 未恢复区间，进 pending）；第 2 行：放弃（永久留痕）
    // 放弃行另用一个会话：同会话且 cursor 推过 to 会把该失败区间判为「已补上」而出列（入/出列判据）。
    await journal.recordRun({ sessionId: "s1", from: 10, to: 20, cursorAfter: 10, outcome: "failed", reason: "llm-error", at: 1700000000000 });
    await journal.recordRun({ sessionId: "s0", from: 20, to: 30, cursorAfter: 30, outcome: "abandoned", reason: "no-cwd", at: 1700000001000 });
    await journal.recordRun({ sessionId: "s2", from: 0, to: 1, cursorAfter: 1, outcome: "written", at: 1700000002000 });
    // 随后 3 条 skipped（最晚落的 3 行 = 按旧口径（留尾部）正是会被留下的那批）
    for (let i = 1; i <= 3; i += 1) {
      await journal.recordRun({ sessionId: "s3", from: i - 1, to: i, cursorAfter: i, outcome: "skipped", reason: "gate-off", at: 1700000003000 + i });
    }
    const kept = lines(root).map((l) => JSON.parse(l));
    // 旧口径（留尾部 2 行）会留 [skipped, skipped]，written 与一切非保护行全灭；
    // 新口径按 outcome 裁：skipped 先让位，written 保住，失败/放弃照旧留痕。
    assert.equal(kept.filter((r) => r.outcome === "skipped").length, 1, "3 条 skipped 被优先裁掉 2 条（可再生噪声先让位）");
    assert.equal(kept.some((r) => r.outcome === "written"), true, "written 比更新的 skipped 更该留（旧口径会把它裁掉）");
    assert.equal(kept.some((r) => r.outcome === "failed" && r.reason === "llm-error"), true, "更早的失败行留盘（未被较新的 skipped 挤出）");
    assert.equal(kept.some((r) => r.outcome === "abandoned"), true, "abandoned 永久留痕语义不动");
    assert.equal(kept.length, 4, "可裁窗口恒为 keepOnRotate（2）+ 强制保留（2）");
    // 行序仍是原相对顺序（重放靠顺序判定区间是否被补上，乱序会误判）
    const ats = kept.map((r) => Date.parse(r.at));
    assert.deepEqual(ats, [...ats].sort((a, b) => a - b), "保留行维持原行序（只裁不排）");
    // 重启重放：失败区间与放弃区间都还在（gate-off 长时间不丢失败/放弃留痕）
    const again = createJournal({ storageRoot: root, rotateAt: 6, keepOnRotate: 2 });
    assert.deepEqual(again.getUnrecovered().map((u) => [u.sessionId, u.from, u.to]), [["s1", 10, 20]], "重启后未恢复失败区间仍可见");
    assert.equal(again.snapshot().abandonedCount, 1, "重启后放弃计数不丢");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal：裁剪优先级内 skipped→zero-ops→written/failed（同窗口下先牺牲可再生行）", async () => {
  // 可裁窗口 2 行：1 条 written + 1 条 failed + 1 条 zero-ops + 1 条 skipped 竞争，
  // 结果必须是 skipped 与 zero-ops 被裁，written/failed 两条留下（跨重启补提优先）。
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root, rotateAt: 4, keepOnRotate: 2, ringMax: 30 });
    await journal.recordRun({ sessionId: "s1", from: 0, to: 1, cursorAfter: 1, outcome: "written", at: 1700000000000 });
    // failed 但 cursor 已推进（非未恢复区间 → 不进强制保留桶），才参与本例的优先级竞争
    await journal.recordRun({ sessionId: "s1", from: 1, to: 5, cursorAfter: 5, outcome: "failed", reason: "boom", at: 1700000001000 });
    await journal.recordRun({ sessionId: "s1", from: 5, to: 6, cursorAfter: 6, outcome: "zero-ops", at: 1700000002000 });
    await journal.recordRun({ sessionId: "s1", from: 6, to: 7, cursorAfter: 7, outcome: "skipped", at: 1700000003000 });
    const kept = lines(root).map((l) => JSON.parse(l));
    assert.deepEqual(kept.map((r) => r.outcome), ["written", "failed"], "written/failed 留存，zero-ops/skipped 被裁");
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

// ---- 二道脱敏：journal 行 redacted 字段（>0 才序列化） ----

test("journal：redacted 字段 >0 才写进行（盘上行与内存 ring 同形；0/缺省不出现该键）", async () => {
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root });
    // >0 → 键在
    const hit = await journal.recordRun({ sessionId: "s1", from: 0, to: 10, cursorAfter: 10, outcome: "written", redacted: 3 });
    assert.equal(hit.redacted, 3);
    // 0 / 缺省 → 键不在（旧行形态逐字节不变）
    const zero = await journal.recordRun({ sessionId: "s1", from: 10, to: 20, cursorAfter: 20, outcome: "written", redacted: 0 });
    assert.equal(Object.prototype.hasOwnProperty.call(zero, "redacted"), false, "redacted=0 不写键");
    const absent = await journal.recordRun({ sessionId: "s1", from: 20, to: 30, cursorAfter: 30, outcome: "zero-ops" });
    assert.equal(Object.prototype.hasOwnProperty.call(absent, "redacted"), false, "缺省不写键");
    // 盘上 JSONL：首行含 "redacted":3，后两行不含
    const raw = lines(root);
    assert.equal(raw.length, 3);
    assert.match(raw[0], /"redacted":3/);
    assert.doesNotMatch(raw[1], /redacted/);
    assert.doesNotMatch(raw[2], /redacted/);
    // ring 快照同形（内存态 = 盘上形态）
    const ring = journal.getRing();
    assert.equal(ring.find((r) => r.from === 0).redacted, 3);
    assert.equal(Object.prototype.hasOwnProperty.call(ring.find((r) => r.from === 10), "redacted"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal：redacted 脏值归一（负/小数/NaN/非数字 → 0 即不写键；重放保持同口径）", async () => {
  const root = tempRoot();
  try {
    const journal = createJournal({ storageRoot: root });
    for (const bad of [-1, 2.9, NaN, Infinity, "x", null]) {
      const rec = await journal.recordRun({ sessionId: "s1", from: 0, to: 1, cursorAfter: 1, outcome: "written", redacted: bad });
      // 2.9 是正数小数：floor 后 2 → 写键；其余钳 0 → 不写
      if (bad === 2.9) assert.equal(rec.redacted, 2, "小数向下取整");
      else assert.equal(Object.prototype.hasOwnProperty.call(rec, "redacted"), false, `redacted=${String(bad)} 应不写键`);
    }
    // 重放：手写一行带 redacted 的行 + 一行脏值（负数），新实例读回同口径
    writeFileSync(join(root, JOURNAL_FILE_NAME), [
      JSON.stringify({ at: "2026-01-01T00:00:00.000Z", sessionId: "s2", from: 0, to: 5, cursorAfter: 5, outcome: "written", redacted: 7 }),
      JSON.stringify({ at: "2026-01-01T00:00:01.000Z", sessionId: "s2", from: 5, to: 9, cursorAfter: 9, outcome: "written", redacted: -3 }),
      "",
    ].join("\n"), "utf8");
    const replayed = createJournal({ storageRoot: root });
    const rows = replayed.getRing();
    assert.equal(rows.find((r) => r.from === 5).redacted, void 0, "重放脏值按 0 处理（键不出现）");
    assert.equal(rows.find((r) => r.from === 5).cursorAfter, 9, "其它字段不受影响");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- P3-a abandoned 行封顶（2026-10-22 补）----
// 语境：abandoned 行原「永不裁」→ 主档在 rotateAt 之外无限增长（protectedCount 越大，
// 触发线越高，但每次触发仍是整档读+写）。修法：盘上只留最近 200 条 abandoned 行，
// 更旧的裁掉并把计数写进 sidecar，保证「已放弃 N 轮」跨重启不缩水。

test("journal：abandoned 行超上限时裁旧留新，计数经 sidecar 跨重启不丢", async () => {
  const root = tempRoot();
  try {
    const { log } = spyLog();
    // rotateAt 设小，逼出轮转；abandoned 上限是模块常量 200，故造 260 条
    const journal = createJournal({ storageRoot: root, rotateAt: 60, keepOnRotate: 20, log });
    for (let i = 0; i < 260; i += 1) {
      await journal.recordRun({
        sessionId: "s1",
        from: i * 10,
        to: i * 10 + 10,
        cursorAfter: i * 10 + 10,
        outcome: "abandoned",
        reason: "no-cwd",
        at: 1700000000000 + i * 1000,
      });
    }
    const total = journal.snapshot().abandonedCount;
    assert.equal(total, 260, "运行期累计计数必须准确");
    // 盘上 abandoned 行数应被限到 200（不是 260）
    const abandonedOnDisk = lines(root).filter((l) => l.includes('"abandoned"'));
    // 上限语义是「至少裁过一次后不再无限增长」：两次轮转之间会再长一段（触发线 = rotateAt+protected），
    // 故合法上界 = 200 + 一个触发周期的余量，绝不是原样 260。
    assert.ok(abandonedOnDisk.length < 260, `必须真的裁掉过（否则档无限长），实际 ${abandonedOnDisk.length}`);
    assert.ok(abandonedOnDisk.length <= 200 + 60, `裁后行数受上限约束（200 + 一个轮转周期），实际 ${abandonedOnDisk.length}`);
    // sidecar 必须存在
    assert.equal(existsSync(join(root, `${JOURNAL_FILE_NAME}.abandoned-truncated.json`)), true, "裁掉的行数必须存档");

    // 重启（新实例重放）：计数不得缩水
    const revived = createJournal({ storageRoot: root, rotateAt: 60, keepOnRotate: 20, log });
    assert.equal(revived.snapshot().abandonedCount, 260, "重启后「已放弃 N 轮」不得因裁行而缩水");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- P2-b：sidecar 与主档同生命周期（2026-10-22 复查修复）----
// 语境：FORMAT.md 承诺 extraction-journal.jsonl 可安全删除（删了不丢记忆），
// 但 sidecar 不是 .jsonl、不会被一起删。若照旧从它加回计数，用户「按文档清一次日志」
// 之后「已放弃 N 轮」会虚高且跨重启不消失。修法：主档不存在时 sidecar 视为过期，归零并清理。

test("journal：主档被删后 sidecar 计数不得回灌（幽灵计数自愈）", async () => {
  const root = tempRoot();
  try {
    const { log, calls } = spyLog();
    const j = createJournal({ storageRoot: root, rotateAt: 60, keepOnRotate: 20, log });
    for (let i = 0; i < 3000; i += 1) {
      await j.recordRun({ sessionId: "s", from: i * 10, to: i * 10 + 10, cursorAfter: i * 10 + 10, outcome: "abandoned", reason: "no-cwd", at: 1700000000000 + i });
    }
    assert.equal(j.snapshot().abandonedCount, 3000);
    const main = join(root, JOURNAL_FILE_NAME);
    const sidecar = `${main}.abandoned-truncated.json`;
    assert.equal(existsSync(sidecar), true, "轮转后应有 sidecar");
    const before = JSON.parse(readFileSync(sidecar, "utf8")).truncated;
    assert.ok(before > 0, "sidecar 应记录了被裁条数");

    // 按文档承诺删主档（「可安全删除，不损失任何记忆」）
    rmSync(main, { force: true });

    const revived = createJournal({ storageRoot: root, rotateAt: 60, keepOnRotate: 20, log });
    assert.equal(revived.snapshot().abandonedCount, 0, "主档已删：计数必须归零，不得从 sidecar 回灌");
    assert.equal(existsSync(sidecar), false, "过期的 sidecar 应被顺手清理");
    assert.ok(calls.info.some((m) => m.includes("放弃计数存档视为过期")), "清理要留痕（不静默）");

    // 之后正常记录仍从 0 起算
    for (let i = 0; i < 3; i += 1) {
      await revived.recordRun({ sessionId: "s2", from: i, to: i + 1, cursorAfter: i + 1, outcome: "abandoned", reason: "x", at: 1800000000000 + i });
    }
    assert.equal(revived.snapshot().abandonedCount, 3, "新记录从 0 起算，不受历史幽灵值污染");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

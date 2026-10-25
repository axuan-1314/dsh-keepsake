// corrections：纠错闭环的结局分类、记录、以及"不谎报 applied"这条硬口径。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  __resetCorrectionsForTest,
  applyCorrection,
  applyCorrections,
  buildCorrectionPayload,
  CORRECTION_LEDGER_FILENAME,
  CORRECTION_MAX_BATCH,
  correctionLedgerStats,
  correctionsSnapshot,
  groupCorrectionsByTarget,
  normalizeCorrectionKind,
  parseCorrectionOutput,
  readCorrectionLedger,
} from "../lib/corrections.js";
import { parseExtractionOutput } from "../lib/extract.js";

function newRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-corrections-"));
}

function stubApply(result) {
  const calls = [];
  const fn = (roots, ops, options) => {
    calls.push({ roots, ops, options });
    return typeof result === "function" ? result(ops) : result;
  };
  fn.calls = calls;
  return fn;
}

test("buildCorrectionPayload：只喂目标与邻域，明说不得改无关条目", () => {
  const { system, user } = buildCorrectionPayload({
    target: "deploy.md",
    currentBody: "端口 3000",
    reason: "现在是 8080",
    kind: "wrong-fact",
    neighbors: "- [其它](other.md) — 无关",
  });
  assert.match(system, /only touch the flagged entry/i);
  assert.match(system, /Do NOT rewrite unrelated entries/i);
  assert.match(system, /NEEDS_USER_INPUT/);
  assert.match(user, /Flagged entry: deploy\.md/);
  assert.match(user, /端口 3000/);
  assert.match(user, /现在是 8080/);
  assert.match(user, /Related entries \(context only/);
});

test("buildCorrectionPayload：无邻域时不出现邻域段（不给模型空壳噪声）", () => {
  const { user } = buildCorrectionPayload({ target: "a.md", currentBody: "x", reason: "y", kind: "outdated" });
  assert.ok(!user.includes("Related entries"));
});

test("parseCorrectionOutput：NEEDS_USER_INPUT 是一等公民结局，不是失败", () => {
  assert.deepEqual(parseCorrectionOutput("NEEDS_USER_INPUT", parseExtractionOutput), { kind: "needs-input" });
  assert.deepEqual(parseCorrectionOutput("  needs_user_input.  ", parseExtractionOutput), { kind: "needs-input" });
  assert.deepEqual(parseCorrectionOutput("Nothing to save.", parseExtractionOutput), { kind: "nothing" });
});

test("parseCorrectionOutput：ops 截到 3 个并如实报告被过滤数", () => {
  const text = JSON.stringify({
    ops: Array.from({ length: 5 }, (_, i) => ({
      action: "write", name: `n${i}.md`, type: "project", title: `T${i}`, content: "体",
    })),
  });
  const out = parseCorrectionOutput(text, parseExtractionOutput);
  assert.equal(out.kind, "ops");
  assert.equal(out.ops.length, 3);
  assert.equal(out.filtered, 2);
});

test("parseCorrectionOutput：解析器未接线必须炸，不静默当 nothing", () => {
  assert.throws(() => parseCorrectionOutput('{"ops":[]}', null), /解析器未接线/);
});

test("normalizeCorrectionKind：未知值收敛到 other（不让模型措辞决定记录枚举）", () => {
  assert.equal(normalizeCorrectionKind("wrong-fact"), "wrong-fact");
  assert.equal(normalizeCorrectionKind("  乱写  "), "other");
  assert.equal(normalizeCorrectionKind(null), "other");
  assert.equal(normalizeCorrectionKind(""), "other");
});

test("applyCorrection：applied 时落记录 + 记账（写/删如实）", async () => {
  __resetCorrectionsForTest();
  const root = newRoot();
  try {
    const applyOps = stubApply({ writes: 1, deletes: 0, verifyFailed: 0 });
    const out = await applyCorrection({
      storageRoot: root,
      target: "deploy.md",
      currentBody: "端口 3000",
      reason: "现在是 8080",
      kind: "wrong-fact",
      parseOps: parseExtractionOutput,
      applyOps,
      callLlm: async () => ({
        text: JSON.stringify({ ops: [{ action: "write", name: "deploy.md", type: "project", title: "部署端口", content: "端口 8080" }] }),
      }),
    });
    assert.equal(out.outcome, "applied");
    assert.equal(out.writes, 1);
    assert.equal(applyOps.calls.length, 1, "落盘只走一次 applyScopedOps");
    const ledger = readCorrectionLedger(root);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].target, "deploy.md");
    assert.equal(ledger[0].kind, "wrong-fact");
    assert.equal(ledger[0].writes, 1);
    const snap = correctionsSnapshot();
    assert.equal(snap.applied, 1);
    assert.equal(snap.writes, 1);
    const stats = correctionLedgerStats(root);
    assert.equal(stats.entries, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyCorrection：ops 全被闸拦下（writes/deletes 皆 0）→ 判失败，不谎报 applied、不写记录", async () => {
  __resetCorrectionsForTest();
  const root = newRoot();
  try {
    const applyOps = stubApply({ writes: 0, deletes: 0, verifyFailed: 1 });
    const out = await applyCorrection({
      storageRoot: root,
      target: "deploy.md",
      reason: "改一下",
      parseOps: parseExtractionOutput,
      applyOps,
      callLlm: async () => ({
        text: JSON.stringify({ ops: [{ action: "write", name: "deploy.md", type: "project", title: "x", content: "y" }] }),
      }),
    });
    assert.equal(out.outcome, "error");
    assert.equal(out.error, "no-op-applied");
    assert.equal(readCorrectionLedger(root).length, 0, "未生效不得留 applied 记录");
    assert.equal(correctionsSnapshot().applied, 0);
    assert.equal(correctionsSnapshot().failed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyCorrection：NEEDS_USER_INPUT → needs-input，不动盘、不写记录", async () => {
  __resetCorrectionsForTest();
  const root = newRoot();
  try {
    const applyOps = stubApply({ writes: 1, deletes: 0 });
    const out = await applyCorrection({
      storageRoot: root,
      target: "vague.md",
      reason: "感觉不太对",
      parseOps: parseExtractionOutput,
      applyOps,
      callLlm: async () => ({ text: "NEEDS_USER_INPUT" }),
    });
    assert.equal(out.outcome, "needs-input");
    assert.equal(applyOps.calls.length, 0, "needs-input 不得落盘");
    assert.equal(readCorrectionLedger(root).length, 0);
    assert.equal(correctionsSnapshot().runs, 1);
    assert.equal(existsSync(join(root, CORRECTION_LEDGER_FILENAME)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyCorrection：空诉求直接拒，不白烧一次 LLM 调用", async () => {
  __resetCorrectionsForTest();
  const root = newRoot();
  try {
    let called = 0;
    const out = await applyCorrection({
      storageRoot: root,
      target: "a.md",
      reason: "   ",
      parseOps: parseExtractionOutput,
      applyOps: stubApply({ writes: 1 }),
      callLlm: async () => {
        called += 1;
        return { text: "NEEDS_USER_INPUT" };
      },
    });
    assert.equal(out.outcome, "error");
    assert.equal(out.error, "empty-complaint");
    assert.equal(called, 0, "没诉求就不该调模型");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyCorrection：LLM 调用失败与解析失败都判 error（各自留痕），且都不落盘", async () => {
  __resetCorrectionsForTest();
  const root = newRoot();
  try {
    const applyOps = stubApply({ writes: 1 });
    const llmFail = await applyCorrection({
      storageRoot: root,
      target: "a.md",
      reason: "改",
      parseOps: parseExtractionOutput,
      applyOps,
      callLlm: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(llmFail.outcome, "error");
    assert.match(String(llmFail.error), /boom/);

    const parseFail = await applyCorrection({
      storageRoot: root,
      target: "a.md",
      reason: "改",
      parseOps: parseExtractionOutput,
      applyOps,
      callLlm: async () => ({ text: "这不是 JSON" }),
    });
    assert.equal(parseFail.outcome, "error");
    assert.equal(applyOps.calls.length, 0);
    assert.equal(correctionsSnapshot().failed, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyCorrection：applyOps 抛错 → error，不崩（后台链路不炸宿主）", async () => {
  __resetCorrectionsForTest();
  const root = newRoot();
  try {
    const out = await applyCorrection({
      storageRoot: root,
      target: "a.md",
      reason: "改",
      parseOps: parseExtractionOutput,
      applyOps: () => {
        throw new Error("磁盘炸了");
      },
      callLlm: async () => ({
        text: JSON.stringify({ ops: [{ action: "write", name: "a.md", type: "project", title: "x", content: "y" }] }),
      }),
    });
    assert.equal(out.outcome, "error");
    assert.match(String(out.error), /磁盘炸了/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readCorrectionLedger：坏行跳过（手工编辑/半行截断不挡整份记录）", () => {
  const root = newRoot();
  try {
    writeFileSync(join(root, CORRECTION_LEDGER_FILENAME), [
      JSON.stringify({ at: "2026-10-25T10:00:00.000Z", target: "a.md", outcome: "applied", writes: 1, deletes: 0 }),
      "{ 这不是 JSON",
      JSON.stringify({ at: "2026-10-25T11:00:00.000Z", target: "b.md", outcome: "applied", writes: 2, deletes: 1 }),
    ].join("\n"));
    const rows = readCorrectionLedger(root);
    assert.equal(rows.length, 2, "坏行跳过、好行保留");
    assert.equal(rows[0].target, "b.md", "新在前");
    assert.equal(rows[1].target, "a.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("correctionsSnapshot：环形缓冲封顶且不外泄内部数组", () => {
  __resetCorrectionsForTest();
  const snap = correctionsSnapshot();
  assert.ok(Array.isArray(snap.recent));
  snap.recent.push({ fake: true });
  assert.equal(correctionsSnapshot().recent.length, 0, "快照必须是副本，外部改不动内部态");
});

// ---- 按条目归组（P1 增补：纠错历史按条目回看） ----
function seedLedger(root, rows) {
  writeFileSync(join(root, CORRECTION_LEDGER_FILENAME), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

test("groupCorrectionsByTarget：只归组 applied，组内时间倒序，组间按最近时间倒序", () => {
  const root = newRoot();
  try {
    seedLedger(root, [
      { at: "2026-10-25T10:00:00.000Z", target: "a.md", scope: "project", kind: "wrong-fact", outcome: "applied", writes: 1, deletes: 0 },
      { at: "2026-10-25T11:00:00.000Z", target: "a.md", scope: "project", kind: "outdated", outcome: "applied", writes: 2, deletes: 0 },
      { at: "2026-10-25T12:00:00.000Z", target: "b.md", scope: "project", kind: "wrong-fact", outcome: "applied", writes: 1, deletes: 1 },
      // 这三个没有盘上后果，不得入组（否则「改过几次」虚高）
      { at: "2026-10-25T13:00:00.000Z", target: "c.md", scope: "project", kind: "other", outcome: "needs-input" },
      { at: "2026-10-25T13:30:00.000Z", target: "c.md", scope: "project", kind: "other", outcome: "nothing" },
      { at: "2026-10-25T14:00:00.000Z", target: "c.md", scope: "project", kind: "other", outcome: "failed" },
    ]);
    const out = groupCorrectionsByTarget(root);
    assert.equal(out.total, 2, "只有 a.md 与 b.md 入组");
    assert.equal(out.entries, 3, "入组的行数（applied 才算）");
    assert.equal(out.truncated, false);
    assert.equal(out.groups[0].target, "b.md", "b 最近（12:00 > 11:00）排前");
    assert.equal(out.groups[1].target, "a.md");
    const a = out.groups[1];
    assert.equal(a.count, 2);
    assert.equal(a.writes, 3, "组内 writes 累加");
    assert.equal(a.lastAt, "2026-10-25T11:00:00.000Z", "lastAt 取最新一条");
    assert.deepEqual(a.kinds, ["outdated", "wrong-fact"], "出现过的原因去重列出（顺序跟随行序：新在前）");
    assert.equal(a.rows.length, 2);
    // 组内新在前
    assert.equal(a.rows[0].at, "2026-10-25T11:00:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("groupCorrectionsByTarget：scope + target 才是唯一键（同名不同 scope 不合并）", () => {
  const root = newRoot();
  try {
    seedLedger(root, [
      { at: "2026-10-25T10:00:00.000Z", target: "deploy.md", scope: "project", outcome: "applied", writes: 1, deletes: 0 },
      { at: "2026-10-25T10:30:00.000Z", target: "deploy.md", scope: "global:work-profile", outcome: "applied", writes: 1, deletes: 0 },
    ]);
    const out = groupCorrectionsByTarget(root);
    assert.equal(out.total, 2, "同名不同 scope 是两个文件，不许合并");
    // 按 target + scope 过滤
    const proj = groupCorrectionsByTarget(root, { target: "deploy.md", scope: "project" });
    assert.equal(proj.total, 1);
    assert.equal(proj.groups[0].scope, "project");
    const glob = groupCorrectionsByTarget(root, { scope: "global:work-profile" });
    assert.equal(glob.total, 1);
    assert.equal(glob.groups[0].scope, "global:work-profile");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("groupCorrectionsByTarget：空/坏输入 → 空组不抛", () => {
  const root = newRoot();
  try {
    assert.deepEqual(groupCorrectionsByTarget(root), { groups: [], total: 0, truncated: false, entries: 0 });
    seedLedger(root, [
      { at: "2026-10-25T10:00:00.000Z", target: "a.md", outcome: "applied", writes: 1, deletes: 0 },
      "{ 坏行",
      "null",
    ]);
    const out = groupCorrectionsByTarget(root);
    assert.equal(out.total, 1, "坏行跳过");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("groupCorrectionsByTarget：maxGroups 生效且 truncated 如实", () => {
  const root = newRoot();
  try {
    seedLedger(root, Array.from({ length: 5 }, (_, i) => ({
      at: new Date(Date.parse("2026-10-25T10:00:00Z") + i * 60000).toISOString(),
      target: `f${i}.md`,
      scope: "project",
      outcome: "applied",
      writes: 1,
      deletes: 0,
    })));
    const out = groupCorrectionsByTarget(root, { maxGroups: 2 });
    assert.equal(out.groups.length, 2);
    assert.equal(out.total, 5);
    assert.equal(out.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 批量纠错（P1 增补：一次指出多条） ----
test("applyCorrections：全成 → applied；部分成 → partial；全败 → error", async () => {
  __resetCorrectionsForTest();
  const root = newRoot();
  try {
    const applyOps = stubApply({ writes: 1, deletes: 0 });
    const okText = (name) => JSON.stringify({ ops: [{ action: "write", name, type: "project", title: "T", content: "体" }] });
    const all = await applyCorrections({
      storageRoot: root,
      items: [
        { target: "a.md", reason: "改 A" },
        { target: "b.md", reason: "改 B" },
      ],
      parseOps: parseExtractionOutput,
      applyOps,
      callLlm: async ({ user }) => ({ text: okText(/a\.md/.test(user) ? "a.md" : "b.md") }),
    });
    assert.equal(all.outcome, "applied");
    assert.equal(all.results.length, 2);
    assert.equal(all.writes, 2);

    // 第二条失败（LLM 抛错）→ partial，第一条的成果保留
    __resetCorrectionsForTest();
    let call = 0;
    const partial = await applyCorrections({
      storageRoot: root,
      items: [
        { target: "a.md", reason: "改 A" },
        { target: "b.md", reason: "改 B" },
      ],
      parseOps: parseExtractionOutput,
      applyOps,
      callLlm: async ({ user }) => {
        call += 1;
        if (/b\.md/.test(user)) throw new Error("boom");
        return { text: okText("a.md") };
      },
    });
    assert.equal(partial.outcome, "partial");
    assert.equal(partial.failed, 1);
    assert.equal(partial.writes, 1);
    assert.equal(partial.results[1].outcome, "error");
    assert.equal(call, 2, "逐条跑，一条失败不拦住下一条");

    // 全失败 → error
    __resetCorrectionsForTest();
    const none = await applyCorrections({
      storageRoot: root,
      items: [{ target: "a.md", reason: "改 A" }],
      parseOps: parseExtractionOutput,
      applyOps,
      callLlm: async () => { throw new Error("boom"); },
    });
    assert.equal(none.outcome, "error");
    assert.equal(none.failed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyCorrections：超上限显式拒（不静默截前 N 条）", async () => {
  __resetCorrectionsForTest();
  const root = newRoot();
  try {
    let called = 0;
    const items = Array.from({ length: CORRECTION_MAX_BATCH + 1 }, (_, i) => ({
      target: `f${i}.md`, reason: "改",
    }));
    const out = await applyCorrections({
      storageRoot: root,
      items,
      parseOps: parseExtractionOutput,
      applyOps: stubApply({ writes: 1 }),
      callLlm: async () => { called += 1; return { text: "NEEDS_USER_INPUT" }; },
    });
    assert.equal(out.outcome, "error");
    assert.match(String(out.error), /too-many-items/);
    assert.equal(called, 0, "超上限不该跑任何一条——批量要烧 N 次调用，悄悄做一部分等于骗用户");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyCorrections：单条缺参只废该条，其余照跑（一条填漏不拖垮整批）", async () => {
  __resetCorrectionsForTest();
  const root = newRoot();
  try {
    let called = 0;
    const out = await applyCorrections({
      storageRoot: root,
      items: [
        { target: "", reason: "没指名" },
        { target: "a.md", reason: "   " },
        { target: "b.md", reason: "改 B" },
      ],
      parseOps: parseExtractionOutput,
      applyOps: stubApply({ writes: 1 }),
      callLlm: async ({ user }) => {
        called += 1;
        assert.match(user, /b\.md/);
        return { text: JSON.stringify({ ops: [{ action: "write", name: "b.md", type: "project", title: "T", content: "体" }] }) };
      },
    });
    assert.equal(out.outcome, "partial", "三条里成功一条、失败两条");
    assert.equal(out.results.length, 3);
    assert.equal(out.results[0].error, "missing-target");
    assert.equal(out.results[1].error, "empty-complaint");
    assert.equal(out.failed, 2);
    assert.equal(called, 1, "缺参的两条不调模型");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyCorrections：空 items → error 不调模型", async () => {
  __resetCorrectionsForTest();
  const root = newRoot();
  try {
    let called = 0;
    const out = await applyCorrections({
      storageRoot: root,
      items: [],
      parseOps: parseExtractionOutput,
      applyOps: stubApply({ writes: 1 }),
      callLlm: async () => { called += 1; return { text: "x" }; },
    });
    assert.equal(out.outcome, "error");
    assert.equal(out.error, "empty-batch");
    assert.equal(called, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyCorrections：逐条独立落记录，记录数与 applied 条数一致", async () => {
  __resetCorrectionsForTest();
  const root = newRoot();
  try {
    const names = ["a.md", "b.md"];
    let call = 0;
    await applyCorrections({
      storageRoot: root,
      items: [
        { target: "a.md", reason: "改 A" },
        { target: "b.md", reason: "改 B" },
      ],
      parseOps: parseExtractionOutput,
      applyOps: stubApply({ writes: 1, deletes: 0 }),
      // 按调用顺序返回：不能靠 user 文本猜是哪一条——两条的 prompt 里都可能出现同一个名字
      callLlm: async () => ({
        text: JSON.stringify({
          ops: [{ action: "write", name: names[call++] ?? "x.md", type: "project", title: "T", content: "体" }],
        }),
      }),
    });
    const ledger = readCorrectionLedger(root);
    assert.equal(ledger.length, 2, "每条 applied 各留一行");
    const targets = ledger.map((r) => r.target).sort();
    assert.deepEqual(targets, ["a.md", "b.md"]);
    // 逐条可归组
    const grouped = groupCorrectionsByTarget(root);
    assert.equal(grouped.total, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyCorrections：接线缺失（parseOps/callLlm/applyOps 缺一）→ 每条都判 error，不静默当成 nothing", async () => {
  __resetCorrectionsForTest();
  const root = newRoot();
  try {
    const out = await applyCorrections({
      storageRoot: root,
      items: [{ target: "a.md", reason: "改 A" }],
      applyOps: stubApply({ writes: 1 }),
      callLlm: async () => ({ text: "x" }),
    });
    assert.equal(out.outcome, "error");
    assert.equal(out.results[0].error, "missing-wiring");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

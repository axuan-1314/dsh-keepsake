// corrections：纠错闭环的结局分类、记录、以及"不谎报 applied"这条硬口径。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  __resetCorrectionsForTest,
  applyCorrection,
  buildCorrectionPayload,
  CORRECTION_LEDGER_FILENAME,
  correctionLedgerStats,
  correctionsSnapshot,
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

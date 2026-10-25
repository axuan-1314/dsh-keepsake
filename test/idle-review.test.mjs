// idle-review：空闲整理的提示词/解析/执行编排（一次审查，不碰调度计时）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  __resetIdleReviewStateForTest,
  buildIdleReviewPayload,
  idleReviewSnapshot,
  parseIdleReviewOutput,
  runIdleReview,
} from "../lib/idle-review.js";
import { projectMemoryPaths } from "../lib/paths.js";

function freshMemory(entries = 2) {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-idle-"));
  const { memoryDir } = projectMemoryPaths(root, root);
  mkdirSync(memoryDir, { recursive: true });
  const lines = [];
  for (let i = 1; i <= entries; i += 1) {
    const name = `entry-${i}.md`;
    writeFileSync(join(memoryDir, name), [
      "---",
      `name: "entry-${i}"`,
      `description: "条目 ${i}"`,
      "metadata:",
      "  type: project",
      'node_type: "memory"',
      "---",
      "",
      `# 条目 ${i}`,
      "",
      `事实 ${i}。`,
    ].join("\n"));
    lines.push(`- [条目 ${i}](${name}) — 条目 ${i}`);
  }
  writeFileSync(join(memoryDir, "MEMORY.md"), `${lines.join("\n")}\n`);
  return { root, memoryDir };
}

const opsText = (ops) => JSON.stringify({ ops });

test("buildIdleReviewPayload：项目范围、sha1 契约、最多 3 个 op 都在", () => {
  const { system, user } = buildIdleReviewPayload({ projectId: "project-x", manifest: "- [A](a.md)", bodies: "--- A ---" });
  assert.match(system, /Project scope only/);
  assert.match(system, /sha1/);
  assert.match(system, /at most 3/);
  assert.match(system, /Nothing to save/);
  assert.match(user, /project-x/);
});

test("parseIdleReviewOutput：nothing / 过滤 global / 最多 3 个", () => {
  assert.equal(parseIdleReviewOutput("Nothing to save.").kind, "nothing");
  const mixed = [
    { action: "delete", name: "a.md", scope: "global:user-profile" },
    { action: "delete", name: "b.md", scope: "project" },
    { action: "delete", name: "c.md" },
    { action: "delete", name: "d.md" },
    { action: "delete", name: "e.md" },
  ];
  const parsed = parseIdleReviewOutput(opsText(mixed));
  assert.equal(parsed.kind, "ops");
  assert.equal(parsed.ops.length, 3, "最多 3 个 op");
  assert.ok(parsed.ops.every((op) => (op.scope ?? "project") === "project"), "global op 被过滤");
  assert.equal(parsed.filtered, 2);
});

test("runIdleReview：执行 op 前脱敏，成功记账；不足两条直接跳过", async () => {
  __resetIdleReviewStateForTest();
  const { root, memoryDir } = freshMemory(2);
  try {
    let applied = null;
    const out = await runIdleReview({
      storageRoot: root,
      memoryDir,
      originSessionId: "s1",
      callLlm: async () => ({
        text: opsText([{
          action: "write",
          name: "merged.md",
          type: "project",
          title: "合并",
          description: "合并结果",
          content: "token: sk-FAKE0000000000000000",
        }]),
      }),
      applyOps: (_roots, ops) => {
        applied = ops;
        return { writes: 1, deletes: 0, byScope: { project: { writes: 1, deletes: 0 } } };
      },
    });
    assert.equal(out.outcome, "written");
    assert.equal(out.writes, 1);
    assert.ok(applied !== null && applied.length === 1);
    assert.ok(!applied[0].content.includes("sk-FAKE0000000000000000"), "落盘前必须脱敏");
    assert.match(applied[0].content, /\[redacted\]/);
    assert.equal(idleReviewSnapshot().written, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const one = freshMemory(1);
  try {
    let called = 0;
    const out = await runIdleReview({
      storageRoot: one.root,
      memoryDir: one.memoryDir,
      callLlm: async () => { called += 1; return { text: "Nothing to save." }; },
      applyOps: () => ({ writes: 0, deletes: 0 }),
    });
    assert.equal(out.outcome, "skipped");
    assert.equal(called, 0, "条目不足两条不调模型");
  } finally {
    rmSync(one.root, { recursive: true, force: true });
  }
});

test("idle review 接线钉：提取结算后调度、dispose 清定时器、默认关设置键在位", () => {
  const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.match(src, /maybeScheduleIdleReview\(session, result\)/, "scheduler 的 extract 结算必须尝试调度");
  assert.match(src, /IDLE_REVIEW_DELAY_MS/, "必须有空闲延迟常量");
  assert.match(src, /idleReviewTimers\.add\(timer\)/, "定时器必须登记以便 dispose 清理");
  assert.match(src, /for \(const timer of idleReviewTimers\) clearTimeout\(timer\)/, "dispose 必须清掉挂起的整理定时器");
  assert.match(src, /purpose: "dsh-keepsake-idle-review"/, "整理调用必须有独立 purpose（不混提取成本）");
  const settingsSrc = readFileSync(new URL("../lib/settings.js", import.meta.url), "utf8");
  assert.match(settingsSrc, /idleReviewEnabled: false/, "缺省必须关");
  assert.match(settingsSrc, /parsed\.idleReviewEnabled === true/, "只有显式 true 才开");
});

test("runIdleReview：LLM/解析/落盘失败都记 error，不抛出", async () => {
  __resetIdleReviewStateForTest();
  const { root, memoryDir } = freshMemory(2);
  try {
    const llmError = await runIdleReview({
      storageRoot: root,
      memoryDir,
      callLlm: async () => { throw new Error("boom"); },
      applyOps: () => ({ writes: 0, deletes: 0 }),
    });
    assert.equal(llmError.outcome, "error");

    const parseError = await runIdleReview({
      storageRoot: root,
      memoryDir,
      callLlm: async () => ({ text: "not json" }),
      applyOps: () => ({ writes: 0, deletes: 0 }),
    });
    assert.equal(parseError.outcome, "error");

    const applyError = await runIdleReview({
      storageRoot: root,
      memoryDir,
      callLlm: async () => ({ text: opsText([{ action: "delete", name: "entry-1.md" }]) }),
      applyOps: () => { throw new Error("apply failed"); },
    });
    assert.equal(applyError.outcome, "error");
    assert.equal(idleReviewSnapshot().errors, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

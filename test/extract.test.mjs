// extract：输出解析、frontmatter 渲染、ops 落盘（边界②：写入边界在插件侧强制）
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NOTHING_TO_SAVE, applyOps, parseExtractionOutput, renderMemoryFile } from "../lib/extract.js";

test("parseExtractionOutput: Nothing to save 各形态", () => {
  assert.deepEqual(parseExtractionOutput(NOTHING_TO_SAVE), { kind: "nothing" });
  assert.deepEqual(parseExtractionOutput("nothing to save."), { kind: "nothing" });
  assert.deepEqual(parseExtractionOutput("  NOTHING TO SAVE.  "), { kind: "nothing" });
});

test("parseExtractionOutput: 裸 JSON 与围栏 JSON", () => {
  const raw = '{"ops":[{"action":"write","name":"a.md","type":"project","title":"A","description":"d","content":"body"}]}';
  const fenced = "```json\n" + raw + "\n```";
  for (const text of [raw, fenced, `前言${raw}后语`]) {
    const parsed = parseExtractionOutput(text);
    assert.equal(parsed.kind, "ops");
    assert.equal(parsed.ops[0].name, "a.md");
  }
});

test("parseExtractionOutput: 非法输出抛错", () => {
  assert.throws(() => parseExtractionOutput(""));
  assert.throws(() => parseExtractionOutput("没有 JSON"));
  assert.throws(() => parseExtractionOutput('{"nope":1}'));
  assert.throws(() => parseExtractionOutput('{"ops":[{"action":"fly"}]}'));
  assert.throws(() => parseExtractionOutput('{"ops":[{"action":"write","name":"a.md","content":123}]}'));
});

test("parseExtractionOutput: 未知 type 归一为 project，缺省 indexLine", () => {
  const parsed = parseExtractionOutput('{"ops":[{"action":"write","name":"a.md","type":"diary","content":"b"}]}');
  assert.equal(parsed.ops[0].type, "project");
});

test("renderMemoryFile: frontmatter 形态（name/description/metadata.type/node_type/originSessionId）", () => {
  const body = renderMemoryFile({ name: "a", description: "d\"引", type: "feedback", originSessionId: "s-1", content: "Why: x" });
  assert.match(body, /^---\n/);
  assert.match(body, /name: "a"/);
  assert.match(body, /metadata:\n {2}type: feedback/);
  assert.match(body, /node_type: "memory"/);
  assert.match(body, /originSessionId: "s-1"/);
  assert.match(body, /Why: x\n$/);
});

test("applyOps: 安全写+索引重建+黑名单跳过+删除", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-memory-test-"));
  try {
    const log = { warn: () => {} };
    let result = applyOps(
      root,
      [
        { action: "write", name: "uses-pnpm.md", type: "project", title: "Uses pnpm", description: "包管理器", indexLine: "- [Uses pnpm](uses-pnpm.md) — 包管理器", content: "团队统一 pnpm" },
        { action: "write", name: "../escape.md", type: "project", title: "E", description: "", content: "x" },
        { action: "write", name: ".git/steal.md", type: "project", title: "G", description: "", content: "x" },
      ],
      { originSessionId: "s1", log },
    );
    assert.equal(result.writes, 1);
    assert.equal(result.skipped, 2);
    const written = readFileSync(join(root, "uses-pnpm.md"), "utf8");
    assert.match(written, /type: project/);
    assert.equal(existsSync(join(root, "MEMORY.md")), true);
    assert.match(readFileSync(join(root, "MEMORY.md"), "utf8"), /\[Uses pnpm\]\(uses-pnpm\.md\)/);
    // 越界文件绝不出现
    assert.equal(existsSync(join(root, "..", "escape.md")), false);

    result = applyOps(root, [{ action: "delete", name: "uses-pnpm.md" }], { originSessionId: "s1", log });
    assert.equal(result.deletes, 1);
    assert.equal(existsSync(join(root, "uses-pnpm.md")), false);
    assert.doesNotMatch(readFileSync(join(root, "MEMORY.md"), "utf8"), /uses-pnpm\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyOps: MEMORY.md 本体不可被模型写", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-memory-test-"));
  try {
    const result = applyOps(root, [{ action: "write", name: "MEMORY.md", content: "hijack", type: "project", title: "M", description: "" }], { log: { warn: () => {} } });
    assert.equal(result.writes, 0);
    assert.equal(result.skipped, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

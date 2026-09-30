// extract：输出解析、frontmatter 渲染、ops 落盘（边界②：写入边界在插件侧强制）
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NOTHING_TO_SAVE, applyOps, isValidModelIndexLine, parseExtractionOutput, renderMemoryFile } from "../lib/extract.js";

test("isValidModelIndexLine（审查 P3-8）：格式/长度/文件名一致性", () => {
  assert.equal(isValidModelIndexLine("- [Uses pnpm](uses-pnpm.md) — 包管理器选择", "uses-pnpm.md"), true);
  assert.equal(isValidModelIndexLine("- [T](x.md) — hook", "x.md"), true);
  // 非法：空/超长/无 em dash/普通文本/文件名不匹配/路径越界
  assert.equal(isValidModelIndexLine("", "a.md"), false);
  assert.equal(isValidModelIndexLine("- [T](a.md) — " + "d".repeat(200), "a.md"), false);
  assert.equal(isValidModelIndexLine("- [T](a.md) : hook", "a.md"), false);
  assert.equal(isValidModelIndexLine("随手一行", "a.md"), false);
  assert.equal(isValidModelIndexLine("- [T](other.md) — hook", "a.md"), false);
  assert.equal(isValidModelIndexLine("- [T](../escape.md) — hook", "a.md"), false);
});

test("applyOps: 非法 indexLine 回退规范行（防索引重复累积）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-memory-test-"));
  try {
    const log = { warn: () => {} };
    applyOps(
      root,
      [{ action: "write", name: "a.md", type: "project", title: "A", description: "描述", indexLine: "随手写的非法行", content: "b" }],
      { originSessionId: "s1", log },
    );
    const first = readFileSync(join(root, "MEMORY.md"), "utf8");
    assert.match(first, /^- \[A\]\(a\.md\) — 描述$/m); // 规范行
    // 第二轮再写同一文件：若首轮写入了不可解析行，此处会累积 preamble——断言不累积
    applyOps(
      root,
      [{ action: "write", name: "a.md", type: "project", title: "A2", description: "描述2", indexLine: "还是非法", content: "b2" }],
      { originSessionId: "s1", log },
    );
    const second = readFileSync(join(root, "MEMORY.md"), "utf8");
    assert.match(second, /^- \[A2\]\(a\.md\) — 描述2$/m);
    assert.equal(second.split("\n").filter((l) => l.includes("(a.md)")).length, 1); // 恰一行
    assert.doesNotMatch(second, /非法/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

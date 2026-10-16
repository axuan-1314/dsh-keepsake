// extract：输出解析、frontmatter 渲染、ops 落盘（边界②：写入边界在插件侧强制）
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NOTHING_TO_SAVE, applyOps, isValidModelIndexLine, parseExtractionOutput, renderMemoryFile } from "../lib/extract.js";

test("isValidModelIndexLine：格式/长度/文件名一致性", () => {
  assert.equal(isValidModelIndexLine("- [Uses pnpm](uses-pnpm.md) — 包管理器选择", "uses-pnpm.md"), true);
  assert.equal(isValidModelIndexLine("- [T](x.md) — hook", "x.md"), true);
  // 非法：空/超长/无 em dash/普通文本/文件名不匹配/路径越界
  assert.equal(isValidModelIndexLine("", "a.md"), false);
  assert.equal(isValidModelIndexLine("- [T](a.md) — " + "d".repeat(200), "a.md"), false);
  assert.equal(isValidModelIndexLine("- [T](a.md) : hook", "a.md"), false);
  assert.equal(isValidModelIndexLine("随手一行", "a.md"), false);
  assert.equal(isValidModelIndexLine("- [T](other.md) — hook", "a.md"), false);
  assert.equal(isValidModelIndexLine("- [T](../escape.md) — hook", "a.md"), false);
  // 逐字节一致：大小写不一致不放行（旧版双侧 sanitize 后比会误判为一致）
  assert.equal(isValidModelIndexLine("- [T](X.md) — hook", "x.md"), false);
  assert.equal(isValidModelIndexLine("- [T](x.md) — hook", "x.md"), true);
  // 逐字节一致：链接目标缺 .md（原文）不放行
  assert.equal(isValidModelIndexLine("- [T](x.md) — hook", "x"), false);
});

test("applyOps: 非法 indexLine 回退规范行（防索引重复累积）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-test-"));
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

test("applyOps: 索引链接目标与磁盘文件名逐字节一致（混合大小写/无 .md 归一）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-test-"));
  try {
    const log = { warn: () => {} };
    const result = applyOps(
      root,
      [
        { action: "write", name: "MyFact", type: "project", title: "My Fact", description: "混合大小写", content: "b" },
        { action: "write", name: "TeamTools", type: "project", title: "Team Tools", description: "无扩展名", content: "c" },
        // 模型 indexLine 引用归一化后的名字 → 应被接受（不再因原始名不符而回退）
        { action: "write", name: "Kebab-Case", type: "project", title: "Kebab", description: "hook", indexLine: "- [Kebab](kebab-case.md) — hook", content: "d" },
      ],
      { originSessionId: "s1", log },
    );
    assert.equal(result.writes, 3);
    // 磁盘实际文件名：一律小写 + .md（原始名不落盘；用 readdir 取真实字节名，
    // 规避 win32 大小写不敏感文件系统 existsSync 的假阳）
    assert.deepEqual(readdirSync(root).filter((f) => f !== "MEMORY.md").sort(), ["kebab-case.md", "myfact.md", "teamtools.md"]);
    assert.equal(existsSync(join(root, "myfact.md")), true);
    assert.equal(existsSync(join(root, "teamtools.md")), true);
    // 索引行括号内目标与磁盘文件名逐字节一致（大小写敏感文件系统不断链）
    const index = readFileSync(join(root, "MEMORY.md"), "utf8");
    assert.match(index, /^- \[My Fact\]\(myfact\.md\) — 混合大小写$/m);
    assert.match(index, /^- \[Team Tools\]\(teamtools\.md\) — 无扩展名$/m);
    assert.match(index, /^- \[Kebab\]\(kebab-case\.md\) — hook$/m); // 模型行原样保留
    assert.doesNotMatch(index, /\(MyFact\)|\(TeamTools\)|\(Kebab-Case\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyOps: 同批 write+delete 同名按终态对账，索引不留悬挂行", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-test-"));
  try {
    const log = { warn: () => {} };
    // 原始名大小写混合：write 归一为 foo.md，delete 也必须归一为 foo.md 才能对上
    const result = applyOps(
      root,
      [
        { action: "write", name: "Foo", type: "project", title: "Foo", description: "临时", content: "x" },
        { action: "delete", name: "Foo" },
      ],
      { originSessionId: "s1", log },
    );
    assert.equal(result.writes, 1);
    assert.equal(result.deletes, 1);
    // 磁盘无 foo.md
    assert.deepEqual(readdirSync(root).filter((f) => f !== "MEMORY.md"), []);
    // 索引不含指向已删文件的悬挂行
    const indexPath = join(root, "MEMORY.md");
    const index = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
    assert.doesNotMatch(index, /foo\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyOps: 模型 indexLine 链接目标须与归一化名逐字节一致（大小写不符即回退）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-test-"));
  try {
    const log = { warn: () => {} };
    const result = applyOps(
      root,
      [
        // 链接目标 (MyFact.md) 与归一化名 myfact.md 不符 → 拒绝原样，回退规范行（小写）
        { action: "write", name: "MyFact", type: "project", title: "My Fact", description: "混合大小写", indexLine: "- [My Fact](MyFact.md) — hook", content: "b" },
        // 链接目标恰好等于归一化名 → 原样采纳
        { action: "write", name: "Legit", type: "project", title: "Legit", description: "hook", indexLine: "- [Legit](legit.md) — 原样采纳", content: "c" },
      ],
      { originSessionId: "s1", log },
    );
    assert.equal(result.writes, 2);
    const index = readFileSync(join(root, "MEMORY.md"), "utf8");
    // 回退行链接目标为小写归一化名（与磁盘一致）
    assert.match(index, /^- \[My Fact\]\(myfact\.md\) — 混合大小写$/m);
    assert.doesNotMatch(index, /\(MyFact\.md\)/);
    // 合法行原样采纳
    assert.match(index, /^- \[Legit\]\(legit\.md\) — 原样采纳$/m);
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

test("parseExtractionOutput: 整批不可解析抛错；单条畸形跳单容错", () => {
  // 整批级：payload 非 JSON / 缺 ops 数组 → 抛（cursor 不推进）
  assert.throws(() => parseExtractionOutput(""));
  assert.throws(() => parseExtractionOutput("没有 JSON"));
  assert.throws(() => parseExtractionOutput('{"nope":1}'));
  // 单条级：坏 op 跳过计数，好 ops 照常（旧版一票否决整批）
  const mixed = parseExtractionOutput('{"ops":[{"action":"fly"},{"action":"write","name":"a.md","content":123},{"action":"write","name":"ok.md","content":"好"}]}');
  assert.equal(mixed.ops.length, 1);
  assert.equal(mixed.ops[0].name, "ok.md");
  assert.equal(mixed.skippedMalformed, 2);
  const del = parseExtractionOutput('{"ops":[{"action":"delete"}]}'); // 缺 name 的 delete 同样跳单
  assert.equal(del.ops.length, 0);
  assert.equal(del.skippedMalformed, 1);
});

test("parseExtractionOutput: 跳单明细带具体 op（名称+原因+实际长度）——超大写入不再无痕", () => {
  const big = "x".repeat(20001); // 超 MAX_CONTENT_CHARS（20000）
  const parsed = parseExtractionOutput(JSON.stringify({
    ops: [
      { action: "write", name: "too-big.md", content: big },
      { action: "write", name: "no-content.md" },
      { action: "delete" },
      { action: "write", name: "ok.md", content: "好" },
    ],
  }));
  assert.equal(parsed.ops.length, 1, "只保留好的 op");
  assert.equal(parsed.skippedMalformed, 3, "三条畸形");
  assert.deepEqual(parsed.skippedDetails, [
    { name: "too-big.md", reason: "content 超上限", length: 20001 },
    { name: "no-content.md", reason: "write 缺 content" },
    { name: "", reason: "delete 缺 name" },
  ]);
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
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-test-"));
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
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-test-"));
  try {
    const result = applyOps(root, [{ action: "write", name: "MEMORY.md", content: "hijack", type: "project", title: "M", description: "" }], { log: { warn: () => {} } });
    assert.equal(result.writes, 0);
    assert.equal(result.skipped, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

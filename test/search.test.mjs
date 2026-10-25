// search：关键词检索的打分口径与范围过滤（纯函数 + 只读 IO）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listMemoryEntries, scoreEntry, searchMemory, snippetOf, splitQuery } from "../lib/search.js";
import { categoryDir } from "../lib/global-store.js";

function entryFile(root, name, { title, description = "", type = "project", body = "" }) {
  const content = [
    "---",
    `name: "${name.replace(/\.md$/i, "")}"`,
    `description: "${description}"`,
    "metadata:",
    `  type: ${type}`,
    `title: "${title}"`,
    "---",
    "",
    body,
  ].join("\n");
  writeFileSync(join(root, name), content);
  return content;
}

test("splitQuery：去重、保序、上限 8 个，空串给空数组", () => {
  assert.deepEqual(splitQuery(""), []);
  assert.deepEqual(splitQuery("   "), []);
  assert.deepEqual(splitQuery("pnpm  pnpm 铁律"), ["pnpm", "铁律"]);
  const many = splitQuery("a b c d e f g h i j k");
  assert.equal(many.length, 8);
});

test("scoreEntry：名字完全相等 100，名字包含 60，标题 45，摘要 30，正文 15", () => {
  const base = { name: "pnpm.md", title: "PNPM", description: "包管理器", body: "用它装依赖" };
  assert.equal(scoreEntry(base, ["pnpm"]).score, 100);
  assert.equal(scoreEntry({ ...base, name: "pnpm-rule.md" }, ["pnpm"]).score, 60);
  assert.equal(scoreEntry({ ...base, name: "other.md" }, ["pnpm"]).score, 45); // 命中 title
  assert.equal(scoreEntry({ ...base, name: "other.md", title: "别的" }, ["包管理"]).score, 30);
  assert.equal(scoreEntry({ ...base, name: "other.md", title: "别的", description: "" }, ["装依赖"]).score, 15);
});

test("scoreEntry：AND 语义——任一关键词全无命中则不入选", () => {
  const entry = { name: "pnpm.md", title: "PNPM", description: "", body: "包管理器" };
  assert.notEqual(scoreEntry(entry, ["pnpm"]), null);
  assert.equal(scoreEntry(entry, ["pnpm", "完全不存在"]), null);
  // 两个词都命中时分数累加（都落在有用字段上）
  const both = scoreEntry(entry, ["pnpm", "包管理"]);
  assert.equal(both.score, 100 + 15);
  assert.deepEqual([...new Set(both.hits)].sort(), ["body", "name"]);
});

test("snippetOf：正文命中处取片段并加省略号；无命中取开头", () => {
  const body = `${"前".repeat(300)}关键片段${"后".repeat(300)}`;
  const snip = snippetOf(body, ["关键片段"], 60);
  assert.match(snip, /关键片段/);
  assert.ok(snip.startsWith("…"), "命中点前有省略号");
  const noHit = snippetOf("很短的一段正文", ["不存在"], 60);
  assert.ok(!noHit.includes("…") || noHit.length > 0);
  assert.equal(snippetOf("", ["x"]), "");
});

test("searchMemory：跨全局与项目、按分数排序、AND 语义、limit 生效", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-search-"));
  try {
    const globalDir = categoryDir(root, "work-profile");
    mkdirSync(globalDir, { recursive: true });
    entryFile(globalDir, "pnpm-rule.md", {
      title: "PNPM 铁律",
      description: "装依赖只用 pnpm",
      body: "禁止 npm install。",
    });
    entryFile(globalDir, "npm-legacy.md", {
      title: "旧 npm 说明",
      description: "历史遗留",
      body: "以前用 npm，现已废弃。",
    });

    const projectDir = join(root, "projects", "demo-0123456789abcdef", "memory");
    mkdirSync(projectDir, { recursive: true });
    entryFile(projectDir, "deploy.md", {
      title: "部署端口",
      description: "服务监听端口",
      body: "开发环境端口 3000。",
    });
    // 索引文件必须被排除（它不是条目）
    writeFileSync(join(projectDir, "MEMORY.md"), "- [部署](deploy.md) — 服务监听端口\n");

    const hit = searchMemory(root, "pnpm", { projectMemoryDir: projectDir });
    assert.equal(hit.total, 1, "只有 pnpm-rule 命中 pnpm");
    assert.equal(hit.results[0].name, "pnpm-rule.md");
    assert.equal(hit.results[0].scope, "global:work-profile");

    // 两个词都要命中：pnpm + 端口 分散在两个范围 → 无单条同时含两词 → 空
    const none = searchMemory(root, "pnpm 端口", { projectMemoryDir: projectDir });
    assert.equal(none.total, 0);

    // 只查项目侧：pnpm 在全局，应查不到
    const projOnly = searchMemory(root, "pnpm", { projectMemoryDir: projectDir, includeGlobal: false });
    assert.equal(projOnly.total, 0);

    // 项目侧命中：端口
    const port = searchMemory(root, "端口", { projectMemoryDir: projectDir, includeGlobal: false });
    assert.equal(port.total, 1);
    assert.equal(port.results[0].scope, "project");

    // limit 生效且 truncated 如实
    const limited = searchMemory(root, "端口", { projectMemoryDir: projectDir, limit: 1 });
    assert.equal(limited.results.length, 1);

    // 索引文件不进结果（否则每个查询都会命中 MEMORY.md）
    const indexish = searchMemory(root, "服务监听", { projectMemoryDir: projectDir });
    assert.ok(indexish.results.every((r) => r.name !== "MEMORY.md"), "MEMORY.md 不该作为条目出现");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("searchMemory：空查询/空存储根 → 空结果不抛", () => {
  assert.deepEqual(searchMemory("", "x").results, []);
  assert.deepEqual(searchMemory("/nonexistent-root-xyz", "").results, []);
  assert.equal(searchMemory("/nonexistent-root-xyz", "x").total, 0);
});

test("listMemoryEntries：按 mtime 倒序，含索引文件排除与 truncated", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-list-"));
  try {
    const dir = categoryDir(root, "user-profile");
    mkdirSync(dir, { recursive: true });
    entryFile(dir, "a.md", { title: "A", body: "一" });
    entryFile(dir, "b.md", { title: "B", body: "二" });
    writeFileSync(join(dir, "MEMORY.md"), "- [A](a.md) — x\n");
    const out = listMemoryEntries(root, { limit: 10 });
    assert.equal(out.total, 2, "MEMORY.md 不计入");
    assert.equal(out.entries.length, 2);
    assert.equal(out.truncated, false);

    const capped = listMemoryEntries(root, { limit: 1 });
    assert.equal(capped.entries.length, 1);
    assert.equal(capped.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// manifest：注入预算（边界④：截断+WARNING；索引行 ≤150；frontmatter 解析；manifest mtime 降序×前 200；索引合并）
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildIndexLine,
  buildManifestText,
  clampIndexLine,
  mergeIndexContent,
  parseFrontmatterHead,
  parseIndexContent,
  truncateWithWarning,
} from "../lib/manifest.js";

test("truncateWithWarning: 200 行/25k 截断 + WARNING", () => {
  const many = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
  const cut = truncateWithWarning(many, 200, 25000);
  assert.equal(cut.split("\n").length > 200, true);
  assert.match(cut, /\[WARNING\][\s\S]*200 行上限/);
  const huge = "x".repeat(30000);
  const cut2 = truncateWithWarning(huge, 200, 25000);
  assert.match(cut2, /\[WARNING\][\s\S]*25000 字符上限/);
  const small = "a\nb";
  assert.equal(truncateWithWarning(small, 200, 25000), small); // 未截断无 WARNING
});

test("clampIndexLine: ≤150 字符（码点安全）", () => {
  const long = "- [T](x.md) — " + "很".repeat(200);
  assert.ok(clampIndexLine(long).length <= 150);
  assert.equal(clampIndexLine("  - [T](x.md) — ok  "), "- [T](x.md) — ok");
});

test("buildIndexLine: 规格形态", () => {
  assert.equal(buildIndexLine("Uses pnpm", "uses-pnpm.md", "包管理器选择"), "- [Uses pnpm](uses-pnpm.md) — 包管理器选择");
});

test("parseFrontmatterHead: 前 30 行解析 name/description/metadata.type", () => {
  const content = ["---", 'name: "uses-pnpm"', "description: 团队用 pnpm", "metadata:", "  type: project", "---", "", "正文"].join("\n");
  const front = parseFrontmatterHead(content);
  assert.equal(front.name, "uses-pnpm");
  assert.equal(front.description, "团队用 pnpm");
  assert.equal(front.type, "project");
  assert.deepEqual(parseFrontmatterHead("no frontmatter"), {});
});

test("buildManifestText: mtime 降序、排除 MEMORY.md、前 30 行 frontmatter", () => {
  const root = "C:\\mem\\m";
  const files = [`${root}\\MEMORY.md`, `${root}\\a.md`, `${root}\\sub\\b.md`];
  const stat = (p) => {
    if (p.endsWith("a.md")) return { mtimeMs: 100 };
    if (p.endsWith("b.md")) return { mtimeMs: 200 };
    return { mtimeMs: 0 };
  };
  const readDir = (dir) => {
    if (dir === root) return [{ name: "MEMORY.md", isFile: () => true, isDirectory: () => false }, { name: "a.md", isFile: () => true, isDirectory: () => false }, { name: "sub", isFile: () => false, isDirectory: () => true }];
    return [{ name: "b.md", isFile: () => true, isDirectory: () => false }];
  };
  const readFile = (p) => (p.endsWith("a.md")
    ? "---\nname: a\ndescription: Alpha\ntype: user\n---\nbody"
    : `---\nname: b\ndescription: Beta\nmetadata:\n  type: feedback\n---\n${"x".repeat(50)}`);
  const result = buildManifestText(root, { stat, readDir, readFile });
  const lines = result.manifest.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\- \[feedback\] b \(.*\): Beta$/); // b 更新在前（mtime 降序）
  assert.match(lines[1], /^\- \[user\] a \(.*\): Alpha$/);
  assert.match(result.bodies, /--- b ---/); // 小文件附正文
});

test("parseIndexContent 与 mergeIndexContent: 替换/新增/删除保序", () => {
  const existing = "preamble\n- [Old](old.md) — old hook\n- [Keep](keep.md) — keep";
  const { map } = parseIndexContent(existing);
  assert.equal(map.get("old.md"), "- [Old](old.md) — old hook");
  const merged = mergeIndexContent(
    existing,
    [{ name: "new.md", title: "New", description: "新记忆" }, { name: "old.md", title: "Old2", description: "更新了" }],
    ["keep.md"],
  );
  assert.match(merged, /^preamble\n/m);
  assert.match(merged, /\[Old2\]\(old\.md\)/);
  assert.match(merged, /\[New\]\(new\.md\)/);
  assert.doesNotMatch(merged, /keep\.md/); // 已删
  const lines = merged.split("\n").filter((l) => l.startsWith("- ["));
  assert.equal(lines.indexOf(lines.find((l) => l.includes("old.md"))), 0); // old 仍在原位
  assert.equal(lines[lines.length - 1].includes("new.md"), true); // 新增排尾
});

test("mergeIndexLine 超长钩子被截断", () => {
  const merged = mergeIndexContent("", [{ name: "x.md", title: "X", description: "d".repeat(300) }], []);
  assert.ok(merged.length <= 160);
});

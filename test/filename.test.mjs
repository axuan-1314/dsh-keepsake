// filename：文件名安全三道闸（边界③）
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { INDEX_FILENAME, isInsideRoot, resolveSafeMemoryTarget, sanitizeMemoryName } from "../lib/filename.js";

const ROOT = "C:\\mem\\projects\\x\\memory";

test("isInsideRoot: 包含性判定", () => {
  assert.equal(isInsideRoot(ROOT, join(ROOT, "a.md")), true);
  assert.equal(isInsideRoot(ROOT, join(ROOT, "sub", "b.md")), true);
  assert.equal(isInsideRoot(ROOT, ROOT), false); // 根本身非空判定
  assert.equal(isInsideRoot(ROOT, "C:\\mem\\other.md"), false); // 越界
  assert.equal(isInsideRoot(ROOT, join(ROOT, "..", "escape.md")), false); // ../
  assert.equal(isInsideRoot(ROOT, ""), false);
  assert.equal(isInsideRoot("", join(ROOT, "a.md")), false);
});

test("sanitizeMemoryName: 常规与净化", () => {
  assert.equal(sanitizeMemoryName("prefers-pnpm.md"), "prefers-pnpm.md");
  assert.equal(sanitizeMemoryName("My Cool Idea!!"), "my-cool-idea.md"); // 自动补 .md
  assert.equal(sanitizeMemoryName("sub/dir/Note.md"), "sub/dir/note.md");
  assert.equal(sanitizeMemoryName("  spaced  name  "), "spaced-name.md");
});

test("sanitizeMemoryName: 越界/点段/黑名单/控制符/冒号", () => {
  assert.equal(sanitizeMemoryName("../escape.md"), null); // .. 段
  assert.equal(sanitizeMemoryName("a/../../b.md"), null);
  // 盘符风格输入不越界：净化落在根内的安全相对路径（包含性兜底）
  const drive = resolveSafeMemoryTarget(ROOT, "C:\\evil.md");
  assert.ok(drive !== null && isInsideRoot(ROOT, drive));
  assert.equal(sanitizeMemoryName("x/.git/config.md"), null); // 黑名单段
  assert.equal(sanitizeMemoryName("x/node_modules/y.md"), null);
  assert.equal(sanitizeMemoryName("HOOKS/a.md"), null); // 大写黑名单
  assert.equal(sanitizeMemoryName("name:.md"), "name-.md"); // 段中 ':' 白名单净化为 '-'（盘符段尾 ':' 另有剥除）
  assert.equal(sanitizeMemoryName("bad\u202Ename.md"), "badname.md"); // bidi 剥除
  assert.equal(sanitizeMemoryName("a\u0000b.md"), "ab.md"); // 控制符剥除
  assert.equal(sanitizeMemoryName("MEMORY.md"), null); // 索引保留
  assert.equal(sanitizeMemoryName("memory.md"), null); // win32 大小写不敏感
  assert.equal(sanitizeMemoryName(""), null);
  assert.equal(sanitizeMemoryName("///"), null);
  assert.equal(sanitizeMemoryName("."), null);
});

test("resolveSafeMemoryTarget: 三道闸合成", () => {
  const inside = resolveSafeMemoryTarget(ROOT, "ok.md");
  assert.ok(inside !== null);
  assert.equal(isInsideRoot(ROOT, inside), true);
  assert.equal(resolveSafeMemoryTarget(ROOT, "../../etc/passwd.md"), null);
  assert.equal(resolveSafeMemoryTarget(ROOT, "x/.git/config.md"), null);
});

test("INDEX_FILENAME 保留名核对", () => {
  assert.equal(INDEX_FILENAME, "MEMORY.md");
});

// filename：文件名安全三道闸（边界③）
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { INDEX_FILENAME, fallbackEntryName, isInsideRoot, isReservedDeviceSegment, resolveSafeMemoryTarget, sanitizeMemoryName, stripControlAndBidi } from "../lib/filename.js";

const ROOT = "C:\\mem\\projects\\x\\memory";

test("fallbackEntryName：纯中文/纯符号标题的确定性哈希兜底", () => {
  const a = fallbackEntryName("用户喜欢简洁");
  const b = fallbackEntryName("用户喜欢简洁");
  const c = fallbackEntryName("完全不同的标题");
  assert.equal(a, b, "同种子同名（幂等重导＝覆盖同条）");
  assert.notEqual(a, c, "异种子异名（防跨批按位置覆盖）");
  assert.match(a, /^entry-[0-9a-f]{10}\.md$/);
  assert.match(fallbackEntryName("!!!纯符号!!!"), /^entry-[0-9a-f]{10}\.md$/);
});

test("fallbackEntryName：空种子确定性（不再随调用时间变化）", () => {
  const a = fallbackEntryName("");
  const b = fallbackEntryName("");
  assert.equal(a, b, "空种子两次调用同名");
  assert.equal(a, fallbackEntryName(null), "null 与空种子同结果");
  assert.equal(a, fallbackEntryName("   "), "纯空白与空种子同结果（trim 后为空）");
  assert.equal(a, "entry-da39a3ee5e.md", '空种子 = sha1("") 前 10 hex（确定性锚点）');
  assert.match(a, /^entry-[0-9a-f]{10}\.md$/);
});

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
  // 无扩展名的 "memory" 补 .md 后恰为索引文件——旧实现保留名检查在追加之前，漏拦
  assert.equal(sanitizeMemoryName("memory"), null, "无扩展名 memory 应拒（追加 .md 后即 MEMORY.md）");
  assert.equal(sanitizeMemoryName("Memory"), null);
  assert.equal(sanitizeMemoryName("sub/memory"), null, "嵌套末段同样应拒");
  assert.equal(sanitizeMemoryName("memories"), "memories.md", "前缀相近的正常名不受影响");
  assert.equal(sanitizeMemoryName(""), null);
  assert.equal(sanitizeMemoryName("///"), null);
  assert.equal(sanitizeMemoryName("."), null);
});

test("Windows 保留设备名段：含带扩展名形态", () => {
  for (const name of ["con.md", "CON.MD", "prn.md", "aux.md", "nul.md", "com1.md", "com9.md", "lpt1.md", "lpt9.md", "nul"]) {
    assert.equal(sanitizeMemoryName(name), null, `应拒绝保留名: ${name}`);
  }
  assert.equal(isReservedDeviceSegment("sub/con.md".split("/").pop()), true);
  // 非保留名不受影响
  assert.equal(sanitizeMemoryName("console.md"), "console.md");
  assert.equal(sanitizeMemoryName("acon.md"), "acon.md");
  assert.equal(sanitizeMemoryName("com10.md"), "com10.md");
  assert.equal(sanitizeMemoryName("x/con-n.md"), "x/con-n.md");
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

test("保留设备名剥到首点（nul.tar.md 一族拒绝）", () => {
  assert.equal(isReservedDeviceSegment("nul.tar.md"), true);
  assert.equal(isReservedDeviceSegment("aux.tar.gz.md"), true);
  assert.equal(isReservedDeviceSegment("lpt1.tar.md"), true);
  assert.equal(isReservedDeviceSegment("note.tar.md"), false);
  assert.equal(sanitizeMemoryName("nul.tar.md"), null);
  assert.equal(sanitizeMemoryName("con.backup.md"), null);
  assert.equal(sanitizeMemoryName("my-notes.tar.md"), "my-notes.tar.md"); // 非保留名不受影响
});

test("中间段冒充索引名拒绝（x/memory.md/y.md 一族）", () => {
  assert.equal(sanitizeMemoryName("x/memory.md/y.md"), null);
  assert.equal(sanitizeMemoryName("memory.md/y.md"), null);
  assert.equal(sanitizeMemoryName("x/MEMORY.md"), null); // 末段同样拒（既有语义保持）
  assert.equal(sanitizeMemoryName("x/notes.md/y.md"), "x/notes.md/y.md"); // 正常嵌套不受影响
});

test("stripControlAndBidi：值域剥控制符/bidi", () => {
  assert.equal(stripControlAndBidi("好" + String.fromCharCode(0) + "的"), "好的");
  assert.equal(stripControlAndBidi("a" + String.fromCharCode(0x200b) + "b"), "ab");
  assert.equal(stripControlAndBidi("普通文本"), "普通文本");
});

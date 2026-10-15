// expected-sha1（短 sha1 覆盖闸）：不带/带错/纯新增/同批 write+delete。
// 约定：只用临时 storageRoot（os.tmpdir 下自建），绝不读写 ~/.dsh/memory。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyOps, parseExtractionOutput } from "../lib/extract.js";
import { sha1Short, surgicalRoot } from "../lib/safety.js";

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-sha1-"));
}
const silent = { warn: () => {}, error: () => {} };
function seed(memRoot, name, body, description = "desc") {
  mkdirSync(memRoot, { recursive: true });
  const content = `---
name: "${name.replace(/\.md$/i, "")}"
description: "${description}"
metadata:
  type: project
node_type: "memory"
---

${body}
`;
  writeFileSync(join(memRoot, name), content, "utf8");
  return content;
}

// ---- 三态 ----

test("覆盖既有文件不带 sha1 → 盲写降级为追加（保留旧正文）+ 计 blindWriteDowngrades", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seed(memRoot, "a.md", "这是必须保住的旧正文。", "旧钩子");
    const result = applyOps(memRoot, [
      { action: "write", name: "a.md", type: "project", title: "A", description: "新钩子", content: "新内容" },
    ], { storageRoot: root, originSessionId: "s-1", log: silent });
    assert.equal(result.blindWriteDowngrades, 1);
    const after = readFileSync(join(memRoot, "a.md"), "utf8");
    // 旧正文完好（降级追加，不是覆盖）
    assert.match(after, /这是必须保住的旧正文。/);
    // 新内容也进来了，且以一行分隔线相接
    assert.match(after, /新内容/);
    assert.match(after, /\n\n---\n\n新内容/);
    // 顺序：旧文在前，分隔线，新文
    assert.equal(after.indexOf("旧正文") < after.indexOf("---\n\n新内容"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("带但 sha1 不符 → 拒绝该 op（旧文分毫不动）+ 计 expectedSha1Mismatches", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seed(memRoot, "b.md", "旧正文，不能被改。", "钩子");
    const result = applyOps(memRoot, [
      { action: "write", name: "b.md", type: "project", title: "B", description: "新", content: "新正文", sha1: "deadbeef" },
    ], { storageRoot: root, originSessionId: "s-1", log: silent });
    assert.equal(result.expectedSha1Mismatches, 1);
    assert.equal(result.writes, 0);
    assert.equal(result.skipped, 1);
    // 旧文逐字节不动
    assert.equal(readFileSync(join(memRoot, "b.md"), "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("带正确 sha1 → 正常覆盖（不降级、不拒绝）", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seed(memRoot, "c.md", "旧正文。", "钩子");
    const result = applyOps(memRoot, [
      { action: "write", name: "c.md", type: "project", title: "C", description: "新", content: "新正文", sha1: sha1Short(original) },
    ], { storageRoot: root, originSessionId: "s-1", log: silent });
    assert.equal(result.writes, 1);
    assert.equal(result.blindWriteDowngrades, 0);
    assert.equal(result.expectedSha1Mismatches, 0);
    const after = readFileSync(join(memRoot, "c.md"), "utf8");
    assert.match(after, /新正文/);
    assert.doesNotMatch(after, /旧正文。/); // 真覆盖（不是追加）
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("纯新增不需要 sha1（无旧文 → 既不降级也不拒绝）", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const result = applyOps(memRoot, [
      { action: "write", name: "fresh.md", type: "project", title: "F", description: "新", content: "全新增正文" },
    ], { storageRoot: root, originSessionId: "s-1", log: silent });
    assert.equal(result.writes, 1);
    assert.equal(result.blindWriteDowngrades, 0);
    assert.equal(result.expectedSha1Mismatches, 0);
    assert.equal(result.snapshotId, null); // 纯新增不触发快照（无旧文可失）
    assert.match(readFileSync(join(memRoot, "fresh.md"), "utf8"), /全新增正文/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("同批 write+delete 同名 → write 按纯新增落盘、delete 真删，计数不误报", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const result = applyOps(memRoot, [
      { action: "write", name: "tmp.md", type: "project", title: "T", description: "临时", content: "临时正文" },
      { action: "delete", name: "tmp.md" },
    ], { storageRoot: root, originSessionId: "s-1", log: silent });
    assert.equal(result.writes, 1);
    assert.equal(result.deletes, 1);
    // 批前不存在 → 既不是盲写降级也不是 sha1 不符
    assert.equal(result.blindWriteDowngrades, 0);
    assert.equal(result.expectedSha1Mismatches, 0);
    // 终态：磁盘无文件，索引无悬挂行
    assert.equal(existsSync(join(memRoot, "tmp.md")), false);
    assert.doesNotMatch(readFileSync(join(memRoot, "MEMORY.md"), "utf8"), /tmp\.md/);
    // 进了回收站（delete 不硬删）
    assert.equal(existsSync(join(root, "trash")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("同批 write(既有)+delete 同名 → 覆盖闸先判，delete 走终态", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seed(memRoot, "both.md", "旧正文。", "钩子");
    // 带错 sha1 的覆盖会被拒绝（skipped），随后 delete 把旧文移入回收站
    const result = applyOps(memRoot, [
      { action: "write", name: "both.md", type: "project", title: "B", description: "新", content: "新正文", sha1: "00000000" },
      { action: "delete", name: "both.md" },
    ], { storageRoot: root, originSessionId: "s-1", log: silent });
    assert.equal(result.writes, 0);
    assert.equal(result.expectedSha1Mismatches, 1);
    assert.equal(result.deletes, 1); // 终态为删
    assert.equal(existsSync(join(memRoot, "both.md")), false);
    // 旧文留档可恢复（快照 + 回收站双侧）
    assert.notEqual(result.snapshotId, null);
    assert.equal(readFileSync(join(surgicalRoot(root), result.snapshotId, "files", "memory", "both.md"), "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 契约字段解析 ----

test("提取契约：write op 的可选 sha1 字段被解析（非法形态归一为 undefined）", () => {
  const parsed = parseExtractionOutput('{"ops":['
    + '{"action":"write","name":"a.md","content":"x","sha1":"ab12cd34"},'
    + '{"action":"write","name":"b.md","content":"y"},'
    + '{"action":"write","name":"c.md","content":"z","sha1":"toolongnothex01"},'
    + '{"action":"write","name":"d.md","content":"w","sha1":12345}'
    + ']}');
  assert.equal(parsed.ops[0].sha1, "ab12cd34");
  assert.equal(parsed.ops[1].sha1, void 0); // 缺省
  assert.equal(parsed.ops[2].sha1, void 0); // 非 8 hex
  assert.equal(parsed.ops[3].sha1, void 0); // 非字符串
});

test("sha1Short：8 hex 且与内容一一对应（同内容同值、异内容异值）", () => {
  assert.match(sha1Short("abc"), /^[0-9a-f]{8}$/);
  assert.equal(sha1Short("abc"), sha1Short("abc"));
  assert.notEqual(sha1Short("abc"), sha1Short("abd"));
});

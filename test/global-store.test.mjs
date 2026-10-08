// global-store：全局记忆区 CRUD（原子写/三道闸/索引重建）、人设与称呼、
// 滚动清理、分类重置、导出/备份/恢复。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_PERSONA,
  categoryDir,
  clearCategory,
  countEntries,
  createBackup,
  createEntry,
  deleteEntry,
  deriveEntryName,
  exportAll,
  globalRoot,
  isCategoryId,
  isSafeBackupId,
  listBackups,
  listEntries,
  pruneRecentActivity,
  readAddressing,
  readEntry,
  readPersona,
  renderGlobalEntry,
  restoreBackup,
  stripFrontmatter,
  updateEntry,
  writeAddressing,
  writeEntryDirect,
  writePersona,
  resetPersona,
} from "../lib/global-store.js";

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-memory-gstore-"));
}

// ---- 条目 CRUD ----

test("createEntry：落盘 frontmatter+正文，MEMORY.md 索引重建", () => {
  const root = freshRoot();
  try {
    const { name } = createEntry(root, "work-profile", { title: "Uses pnpm", description: "包管理", content: "团队统一用 pnpm" });
    assert.equal(name, "uses-pnpm.md");
    const file = join(categoryDir(root, "work-profile"), name);
    assert.equal(existsSync(file), true);
    const body = readFileSync(file, "utf8");
    assert.match(body, /type: global/);
    assert.match(body, /团队统一用 pnpm/);
    const index = readFileSync(join(categoryDir(root, "work-profile"), "MEMORY.md"), "utf8");
    assert.match(index, /- \[Uses pnpm\]\(uses-pnpm\.md\) — 包管理/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createEntry：中文标题净化为空 → 兜底文件名 entry-*", () => {
  const root = freshRoot();
  try {
    const { name } = createEntry(root, "user-profile", { title: "用户喜欢简洁", content: "正文" });
    assert.match(name, /^entry-[a-z0-9]+\.md$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createEntry：重名自动 -2 避让", () => {
  const root = freshRoot();
  try {
    const a = createEntry(root, "long-term", { title: "Note", content: "一" });
    const b = createEntry(root, "long-term", { title: "Note", content: "二" });
    assert.equal(a.name, "note.md");
    assert.equal(b.name, "note-2.md");
    const entries = listEntries(root, "long-term");
    assert.equal(entries.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createEntry：recent-activity 由 host 盖 timestamp（R9）", () => {
  const root = freshRoot();
  try {
    const before = Date.now();
    const { name } = createEntry(root, "recent-activity", { title: "Standup", content: "今天站会同步了排期" });
    const entry = readEntry(root, "recent-activity", name);
    assert.ok(entry.timestamp, "timestamp 应存在");
    const ts = Date.parse(entry.timestamp);
    assert.ok(Number.isFinite(ts) && ts >= before - 1000 && ts <= Date.now() + 1000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listEntries：mtime 降序 + frontmatter 解析 + 排除 MEMORY.md", () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "A one", description: "第一条", content: "一" });
    createEntry(root, "work-profile", { title: "B two", description: "第二条", content: "二" });
    const entries = listEntries(root, "work-profile");
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => e.name !== "MEMORY.md"));
    assert.ok(entries[0].mtimeMs >= entries[1].mtimeMs);
    assert.equal(entries.map((e) => e.title).sort().join(","), "A one,B two");
    assert.equal(entries.find((e) => e.title === "A one").content, "一");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updateEntry：改正文/标题，索引行同步", () => {
  const root = freshRoot();
  try {
    const { name } = createEntry(root, "current-focus", { title: "Old", description: "旧", content: "旧文" });
    const updated = updateEntry(root, "current-focus", name, { title: "New", content: "新文" });
    assert.equal(updated.name, name);
    const entry = readEntry(root, "current-focus", name);
    assert.equal(entry.content, "新文");
    const index = readFileSync(join(categoryDir(root, "current-focus"), "MEMORY.md"), "utf8");
    assert.match(index, /- \[New\]/);
    assert.doesNotMatch(index, /- \[Old\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updateEntry：跨分类移动（两边索引重建）", () => {
  const root = freshRoot();
  try {
    const { name } = createEntry(root, "work-profile", { title: "Move me", content: "正文" });
    const moved = updateEntry(root, "work-profile", name, { toCategoryId: "long-term" });
    assert.equal(moved.categoryId, "long-term");
    assert.equal(readEntry(root, "work-profile", name), null);
    const entry = readEntry(root, "long-term", moved.name);
    assert.equal(entry.content, "正文");
    const srcIndex = readFileSync(join(categoryDir(root, "work-profile"), "MEMORY.md"), "utf8");
    assert.doesNotMatch(srcIndex, /Move me/);
    const dstIndex = readFileSync(join(categoryDir(root, "long-term"), "MEMORY.md"), "utf8");
    assert.match(dstIndex, /Move me/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updateEntry：条目不存在返回 null", () => {
  const root = freshRoot();
  try {
    assert.equal(updateEntry(root, "work-profile", "ghost.md", { content: "x" }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleteEntry：删文件 + 索引剔除；不存在返回 false", () => {
  const root = freshRoot();
  try {
    const { name } = createEntry(root, "user-profile", { title: "Gone", content: "x" });
    assert.equal(deleteEntry(root, "user-profile", name), true);
    assert.equal(existsSync(join(categoryDir(root, "user-profile"), name)), false);
    const index = readFileSync(join(categoryDir(root, "user-profile"), "MEMORY.md"), "utf8");
    assert.doesNotMatch(index, /Gone/);
    assert.equal(deleteEntry(root, "user-profile", name), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleteEntry：路径穿越名被三道闸拦（不删任何文件）", () => {
  const root = freshRoot();
  try {
    const { name } = createEntry(root, "work-profile", { title: "Keep", content: "x" });
    assert.equal(deleteEntry(root, "work-profile", "../escape"), false);
    assert.equal(deleteEntry(root, "work-profile", "..\\..\\evil.md"), false);
    assert.equal(existsSync(join(categoryDir(root, "work-profile"), name)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeEntryDirect：覆盖写语义（同名不避让，body 整体替换）", () => {
  const root = freshRoot();
  try {
    writeEntryDirect(root, "long-term", { name: "fact.md", title: "Fact", content: "旧" });
    writeEntryDirect(root, "long-term", { name: "fact.md", title: "Fact v2", content: "新" });
    assert.equal(countEntries(root, "long-term"), 1);
    const entry = readEntry(root, "long-term", "fact.md");
    assert.equal(entry.content, "新");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeEntryDirect：非法名返回 null（不创建任何文件）", () => {
  const root = freshRoot();
  try {
    assert.equal(writeEntryDirect(root, "work-profile", { name: "../evil.md", content: "x" }), null);
    assert.equal(writeEntryDirect(root, "work-profile", { name: "MEMORY.md", content: "x" }), null); // 索引保留名
    assert.equal(countEntries(root, "work-profile"), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("countEntries：不存在目录 = 0", () => {
  const root = freshRoot();
  try {
    assert.equal(countEntries(root, "work-profile"), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isCategoryId / deriveEntryName / isSafeBackupId 纯函数", () => {
  assert.equal(isCategoryId("work-profile"), true);
  assert.equal(isCategoryId("nope"), false);
  assert.equal(deriveEntryName("Hello World"), "hello-world.md");
  assert.match(deriveEntryName("纯中文"), /^entry-/);
  assert.equal(isSafeBackupId("2026-10-08T14-00-00-000Z"), true);
  assert.equal(isSafeBackupId("../escape"), false);
  assert.equal(isSafeBackupId("a".repeat(100)), false);
});

// ---- 人设 ----

test("persona：不存在 = 出厂模板（isDefault）", () => {
  const root = freshRoot();
  try {
    const p = readPersona(root);
    assert.equal(p.isDefault, true);
    assert.match(p.content, /补充人设/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persona：写入后读回（stripFrontmatter）；reset 恢复默认模板（R5 非清空）", () => {
  const root = freshRoot();
  try {
    writePersona(root, "# 我的人设\n直接一点。");
    const p = readPersona(root);
    assert.equal(p.isDefault, false);
    assert.match(p.content, /直接一点/);
    assert.doesNotMatch(p.content, /^---/);
    resetPersona(root);
    const r = readPersona(root);
    assert.equal(r.content, stripFrontmatter(DEFAULT_PERSONA));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persona isDefault：reset 后回到默认态；PUT 与模板同文 = 默认；改动一字 = 非默认", () => {
  const root = freshRoot();
  try {
    writePersona(root, "# 我的人设\n直接一点。");
    resetPersona(root);
    assert.equal(readPersona(root).isDefault, true, "reset 后应视为默认（回归：曾按文件存在判 false）");
    writePersona(root, stripFrontmatter(DEFAULT_PERSONA));
    assert.equal(readPersona(root).isDefault, true, "内容等于出厂模板应视为默认");
    writePersona(root, stripFrontmatter(DEFAULT_PERSONA) + "\n多一个字。");
    assert.equal(readPersona(root).isDefault, false, "内容偏离模板应视为非默认");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 称呼 ----

test("addressing：缺省空；写入读回；部分更新；40 字符截断", () => {
  const root = freshRoot();
  try {
    assert.deepEqual(readAddressing(root), { dshName: "", userAlias: "" });
    writeAddressing(root, { dshName: "小舟" });
    assert.deepEqual(readAddressing(root), { dshName: "小舟", userAlias: "" });
    writeAddressing(root, { userAlias: "老板" });
    assert.deepEqual(readAddressing(root), { dshName: "小舟", userAlias: "老板" });
    const long = writeAddressing(root, { dshName: "x".repeat(50) });
    assert.equal(long.dshName.length, 40);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("addressing：损坏 JSON = 空称呼（注入略句，不炸）", () => {
  const root = freshRoot();
  try {
    const dir = globalRoot(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "addressing.json"), "{bad", "utf8");
    assert.deepEqual(readAddressing(root), { dshName: "", userAlias: "" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 滚动清理 ----

test("pruneRecentActivity：超龄条目删除 + 索引剔除", () => {
  const root = freshRoot();
  try {
    // 手工造一条 40 天前的条目（timestamp 盖章）
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    createEntry(root, "recent-activity", { title: "Old news", content: "旧闻", timestamp: old });
    createEntry(root, "recent-activity", { title: "Fresh", content: "新鲜" });
    const { removed, kept } = pruneRecentActivity(root, { keepCount: 30, keepDays: 30 });
    assert.equal(removed, 1);
    assert.equal(kept, 1);
    const entries = listEntries(root, "recent-activity");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, "Fresh");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneRecentActivity：超量保留最新 N 条", () => {
  const root = freshRoot();
  try {
    for (let i = 0; i < 5; i += 1) {
      createEntry(root, "recent-activity", { title: `Item ${i}`, content: `内容 ${i}`, timestamp: new Date(Date.now() - i * 1000).toISOString() });
    }
    const { removed, kept } = pruneRecentActivity(root, { keepCount: 2, keepDays: 30 });
    assert.equal(removed, 3);
    assert.equal(kept, 2);
    const titles = listEntries(root, "recent-activity").map((e) => e.title);
    assert.deepEqual(titles.sort(), ["Item 0", "Item 1"]); // 最新两条
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneRecentActivity：空目录零动作", () => {
  const root = freshRoot();
  try {
    assert.deepEqual(pruneRecentActivity(root), { removed: 0, kept: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneRecentActivity：无 timestamp 条目按 mtime 兜底（不误删新条目）", () => {
  const root = freshRoot();
  try {
    // writeEntryDirect 对 recent-activity 也会盖章；手工写一个无 timestamp 的文件模拟旧格式
    const dir = categoryDir(root, "recent-activity");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "legacy.md"), "---\nname: \"legacy\"\nmetadata:\n  type: global\n---\n\n旧格式条目\n", "utf8");
    const { removed } = pruneRecentActivity(root, { keepCount: 30, keepDays: 30 });
    assert.equal(removed, 0); // mtime 是刚刚 → 保留
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 分类重置 / 导出 / 备份 / 恢复 ----

test("clearCategory：清空条目 + 索引剔除；不动 MEMORY.md 之外文件", () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "A", content: "一" });
    createEntry(root, "work-profile", { title: "B", content: "二" });
    const removed = clearCategory(root, "work-profile");
    assert.equal(removed, 2);
    assert.equal(countEntries(root, "work-profile"), 0);
    const index = readFileSync(join(categoryDir(root, "work-profile"), "MEMORY.md"), "utf8");
    assert.doesNotMatch(index, /\[A\]|\[B\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exportAll：五分类 + persona + addressing 结构化导出", () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "W", content: "工" });
    createEntry(root, "long-term", { title: "L", content: "长" });
    writeAddressing(root, { dshName: "小舟", userAlias: "老板" });
    writePersona(root, "人设正文");
    const all = exportAll(root);
    assert.equal(all.version, 1);
    assert.equal(all.categories["work-profile"].length, 1);
    assert.equal(all.categories["long-term"].length, 1);
    assert.equal(all.categories["recent-activity"].length, 0);
    assert.equal(all.addressing.dshName, "小舟");
    assert.match(all.persona, /人设正文/);
    assert.ok(all.exportedAt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createBackup/listBackups：全量留档 + meta 可读 + 新在前", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "B4 backup", content: "备份前" });
    const id1 = createBackup(root, "reset:work-profile");
    await new Promise((r) => setTimeout(r, 1100)); // 保证 id 不同（秒级时间戳）
    const id2 = createBackup(root, "import");
    assert.notEqual(id1, id2);
    const backups = listBackups(root);
    assert.equal(backups.length, 2);
    assert.equal(backups[0].id, id2); // 新的在前
    assert.equal(backups[1].reason, "reset:work-profile");
    // 备份内含 global 数据
    assert.equal(existsSync(join(root, "backups", id1, "global", "work-profile")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreBackup：全量覆盖恢复；非法 id 拒绝", () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "Before", content: "恢复点" });
    const backupId = createBackup(root, "manual");
    clearCategory(root, "work-profile");
    createEntry(root, "work-profile", { title: "After", content: "新写" });
    restoreBackup(root, backupId);
    const entries = listEntries(root, "work-profile");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, "Before");
    assert.throws(() => restoreBackup(root, "../evil"));
    assert.throws(() => restoreBackup(root, "2099-01-01T00-00-00-000Z"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 渲染原语 ----

test("renderGlobalEntry：frontmatter+正文；timestamp 仅传时出现", () => {
  const withTs = renderGlobalEntry({ name: "a", description: "d", timestamp: "2026-10-08T00:00:00.000Z", content: "正文" });
  assert.match(withTs, /timestamp: "2026-10-08T00:00:00.000Z"/);
  assert.match(withTs, /type: global/);
  const withoutTs = renderGlobalEntry({ name: "a", description: "d", content: "正文" });
  assert.doesNotMatch(withoutTs, /timestamp/);
});

test("stripFrontmatter：无 frontmatter 返回原文 trim；有则取正文", () => {
  assert.equal(stripFrontmatter("没有头"), "没有头");
  assert.equal(stripFrontmatter("---\nname: x\n---\n\n正文\n"), "正文");
});

test("globalRoot/categoryDir：路径拼装与分类校验", () => {
  assert.equal(globalRoot("/r"), join("/r", "global"));
  assert.equal(categoryDir("/r", "work-profile"), join("/r", "global", "work-profile"));
  assert.throws(() => categoryDir("/r", "evil"));
});

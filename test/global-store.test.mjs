// global-store：全局记忆区 CRUD（原子写/三道闸/索引重建）、人设与称呼、
// 滚动清理、分类重置、导出/备份/恢复。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BACKUP_KEEP,
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
  sweepTmpOrphans,
  updateEntry,
  writeAddressing,
  writeEntryDirect,
  writePersona,
  resetPersona,
} from "../lib/global-store.js";
import { recentTsOf } from "../lib/recent-ts.js";

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-gstore-"));
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

test("createEntry：recent-activity 由 host 盖 timestamp", () => {
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
  // 旧字符集正则放行 "." 与 ":"——restoreBackup(".") 曾把 global/ 清空不恢复
  assert.equal(isSafeBackupId("."), false, "单点目录名应拒绝");
  assert.equal(isSafeBackupId(":"), false, "盘符根应拒绝");
  assert.equal(isSafeBackupId(".."), false);
  assert.equal(isSafeBackupId("2026-10-08T14-00-00-000Z/../../evil"), false);
});

test("writeEntryDirect：嵌套名拒绝（嵌套条目会绕过 listEntries/clearCategory/滚动清理成幽灵）", () => {
  const root = freshRoot();
  try {
    assert.equal(writeEntryDirect(root, "work-profile", { name: "tools/rust.md", title: "R", content: "c" }), null);
    assert.equal(writeEntryDirect(root, "recent-activity", { name: "a/b.md", title: "B", content: "c" }), null);
    assert.equal(existsSync(join(root, "global", "work-profile", "tools")), false, "不应产生嵌套目录");
    assert.equal(countEntries(root, "work-profile"), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreBackup：非法 id 抛错不清库（回归钉）", () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "W", content: "工" });
    assert.throws(() => restoreBackup(root, "."));
    assert.equal(countEntries(root, "work-profile"), 1, "拒绝后数据原样");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("persona：写入后读回（stripFrontmatter）；reset 恢复默认模板（非清空）", () => {
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

test("addressing：缺省空；写入读回；部分更新；40 字符截断；控制符剥除", () => {
  const root = freshRoot();
  try {
    assert.deepEqual(readAddressing(root), { dshName: "", userAlias: "", corrupt: false });
    writeAddressing(root, { dshName: "小助手" });
    assert.deepEqual(readAddressing(root), { dshName: "小助手", userAlias: "", corrupt: false });
    writeAddressing(root, { userAlias: "朋友" });
    assert.deepEqual(readAddressing(root), { dshName: "小助手", userAlias: "朋友", corrupt: false });
    const long = writeAddressing(root, { dshName: "x".repeat(50) });
    assert.equal(long.dshName.length, 40);
    const dirty = writeAddressing(root, { dshName: "小" + String.fromCharCode(0) + "助手" });
    assert.equal(dirty.dshName, "小助手"); // 控制符被剥
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("addressing：损坏 JSON = 空称呼 + corrupt 标记（可见降级），写前旧档备份", () => {
  const root = freshRoot();
  try {
    const dir = globalRoot(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "addressing.json"), "{bad", "utf8");
    const read = readAddressing(root, { warn: () => {} });
    assert.deepEqual(read, { dshName: "", userAlias: "", corrupt: true }); // 不再静默
    writeAddressing(root, { dshName: "小助手" });
    const preserved = readdirSync(dir).filter((f) => f.startsWith("addressing.json.corrupt-"));
    assert.equal(preserved.length, 1); // 原损坏档备份，不被覆盖丢尸
    assert.equal(readAddressing(root).corrupt, false);
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
    writeAddressing(root, { dshName: "小助手", userAlias: "朋友" });
    writePersona(root, "人设正文");
    const all = exportAll(root);
    assert.equal(all.version, 1);
    assert.equal(all.categories["work-profile"].length, 1);
    assert.equal(all.categories["long-term"].length, 1);
    assert.equal(all.categories["recent-activity"].length, 0);
    assert.equal(all.addressing.dshName, "小助手");
    assert.match(all.persona, /人设正文/);
    assert.ok(all.exportedAt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createBackup/listBackups：全量留档 + meta 可读 + 新在前", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "backup target", content: "备份前" });
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

// ---- 修复回归钉 ----

test("嵌套名：createEntry 嵌套名显式拒绝（与 writeEntryDirect 统一）", () => {
  const root = freshRoot();
  try {
    assert.equal(createEntry(root, "long-term", { title: "X", content: "c", name: "a/b.md" }), null);
    assert.equal(writeEntryDirect(root, "long-term", { name: "a/b.md", content: "c" }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createEntry：标题含 \"/\" 派生命名取末段（不整条拒绝）", () => {
  const root = freshRoot();
  try {
    const created = createEntry(root, "long-term", { title: "API/DB 设计", content: "c" });
    assert.ok(created !== null, "标题含斜杠应可落盘（旧行为整条拒绝）");
    assert.ok(!created.name.includes("/"), `落盘名不得含嵌套路径：${created.name}`);
    assert.equal(listEntries(root, "long-term").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createEntry：显式非法 name 拒绝（返回 null，不再静默按标题派生）", () => {
  const root = freshRoot();
  try {
    // 保留名 / 点段 / 黑名单段 / 嵌套路径 —— 显式给了就必须拒绝，而非改按 title 派生
    for (const bad of ["con.md", "..", "node_modules", "a/b"]) {
      assert.equal(
        createEntry(root, "work-profile", { name: bad, title: "不应派生", content: "c" }),
        null,
        `显式非法名应拒绝: ${bad}`,
      );
    }
    assert.equal(countEntries(root, "work-profile"), 0);
    assert.equal(existsSync(join(categoryDir(root, "work-profile"), "MEMORY.md")), false, "拒绝即零落盘（不建索引）");
    // 回归：未提供 name 时仍按标题派生
    const derived = createEntry(root, "work-profile", { title: "Derived Title", content: "c" });
    assert.equal(derived.name, "derived-title.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("备份滚动上限（只留最新 BACKUP_KEEP 份）", () => {
  const root = freshRoot();
  try {
    createEntry(root, "long-term", { title: "keep", content: "c" });
    const ids = [];
    for (let i = 0; i < BACKUP_KEEP + 3; i += 1) ids.push(createBackup(root, "test"));
    const listed = listBackups(root);
    assert.equal(listed.length, BACKUP_KEEP); // 超额被滚动清
    assert.equal(listed[0].id, ids[ids.length - 1]); // 新的留着
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("半备份拒绝恢复（complete:false 与无 meta 两形态）", () => {
  const root = freshRoot();
  try {
    const sRoot = root;
    const id = createBackup(sRoot, "test");
    // 手工搓一个 complete:false 半备份
    const halfId = "2020-01-01T00-00-00-000Z";
    const halfDir = join(sRoot, "backups", halfId);
    mkdirSync(halfDir, { recursive: true });
    writeFileSync(join(halfDir, "backup-meta.json"), JSON.stringify({ id: halfId, complete: false }), "utf8");
    assert.throws(() => restoreBackup(sRoot, halfId), /不完整/);
    // 无 meta 的裸目录同样拒
    const bareId = "2020-01-02T00-00-00-000Z";
    mkdirSync(join(sRoot, "backups", bareId), { recursive: true });
    assert.throws(() => restoreBackup(sRoot, bareId), /不完整/);
    const bareList = listBackups(sRoot).find((b) => b.id === bareId);
    assert.equal(bareList.incomplete, true); // 列表标红
    // 旧式 meta（无 complete 字段）视同完整，可恢复（向下兼容）
    assert.equal(restoreBackup(sRoot, id), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("恢复后原态可被 pre 备份找回（换入语义不丢档）", () => {
  const root = freshRoot();
  try {
    const sRoot = root;
    createEntry(root, "long-term", { title: "v1", content: "一版" });
    const backupId = createBackup(sRoot, "test");
    createEntry(root, "long-term", { title: "v2", content: "二版" });
    const preId = createBackup(sRoot, "pre-restore");
    restoreBackup(sRoot, backupId);
    assert.equal(countEntries(sRoot, "long-term"), 1); // 回到备份时点
    restoreBackup(sRoot, preId);
    assert.equal(countEntries(sRoot, "long-term"), 2); // 后悔药的后悔药
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persona：损坏回退出厂 + corrupt 标记 + 写前备份", () => {
  const root = freshRoot();
  try {
    const gDir = globalRoot(root);
    mkdirSync(gDir, { recursive: true });
    writeFileSync(join(gDir, "persona.md"), "---\nname: \"persona\"\n", "utf8"); // 半截 frontmatter 致 strip 后非模板但仍可读——改用不可读形态
    rmSync(join(gDir, "persona.md"));
    mkdirSync(join(gDir, "persona.md"), { recursive: true }); // 目录占位 = 读取必炸
    const read = readPersona(root, { warn: () => {} });
    assert.equal(read.corrupt, true);
    assert.equal(read.isDefault, true);
    writePersona(root, "新正文", { warn: () => {} });
    const preserved = readdirSync(gDir).filter((f) => f.startsWith("persona.md.corrupt-"));
    assert.equal(preserved.length, 1);
    assert.equal(readPersona(root).corrupt, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweepTmpOrphans：.tmp 孤儿与陈旧 staging 清扫", () => {
  const root = freshRoot();
  try {
    const sRoot = root;
    const gDir = globalRoot(root);
    mkdirSync(join(gDir, "long-term"), { recursive: true });
    writeFileSync(join(gDir, "long-term", "a.md.tmp-1-2"), "x", "utf8");
    writeFileSync(join(sRoot, "settings.json.tmp-1-2"), "x", "utf8");
    mkdirSync(join(sRoot, "global.staging-1-2"), { recursive: true });
    const removed = sweepTmpOrphans(sRoot);
    assert.ok(removed >= 2);
    assert.ok(!existsSync(join(gDir, "long-term", "a.md.tmp-1-2")));
    assert.ok(!existsSync(join(sRoot, "settings.json.tmp-1-2")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recentTsOf：未来时间戳钳制回 mtime、坏值回退、字符串 ISO 支持", () => {
  const now = Date.now();
  assert.equal(recentTsOf({ timestamp: new Date(now - 5000).toISOString(), mtimeMs: now - 9000 }), now - 5000); // ISO 字符串
  assert.equal(recentTsOf({ timestamp: now - 5000, mtimeMs: now - 9000 }), now - 5000); // 数值
  assert.equal(recentTsOf({ timestamp: "2099-01-01T00:00:00Z", mtimeMs: now - 9000 }), now - 9000); // 未来 ts 钳制
  assert.equal(recentTsOf({ timestamp: "garbage", mtimeMs: now - 9000 }), now - 9000); // 坏值回退
  assert.equal(recentTsOf({ timestamp: "garbage" }), 0); // 双坏 = 0
});

test("未来时间戳条目不再永生（prune 判龄同源 recentTsOf）", () => {
  const root = freshRoot();
  try {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    createEntry(root, "recent-activity", { title: "Old", content: "旧", timestamp: old });
    createEntry(root, "recent-activity", { title: "Future", content: "未来", timestamp: "2099-01-01T00:00:00.000Z" });
    // Future 的 mtime 是现在 → recentTsOf 回退 mtime → 判龄为新，应存活；Old 过期删除
    const { removed, kept } = pruneRecentActivity(root, { keepCount: 30, keepDays: 30 });
    assert.equal(removed, 1);
    assert.equal(kept, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

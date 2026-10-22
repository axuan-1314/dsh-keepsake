// verify-writeback：写后读校验失败 → 从快照回滚旧文 + 新档留标本 + 计数。
// 约定：只用临时 storageRoot（os.tmpdir 下自建），绝不读写 ~/.dsh/memory。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyOps, applyScopedOps } from "../lib/extract.js";
import { createEntry, readEntry } from "../lib/global-store.js";
import { listSurgicalSnapshots, listTrash, restoreSurgicalSnapshot, sha1Short, surgicalRoot, trashRoot, verifyMemoryFileContent } from "../lib/safety.js";

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-verify-"));
}
const silent = { warn: () => {}, error: () => {} };
const collecting = () => {
  const warns = [];
  return { log: { warn: (m) => warns.push(String(m)), error: () => {} }, warns };
};

/** 合法记忆文件（能过 verifyMemoryFileContent）。 */
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

// ---- 校验判据（纯函数口径）----

test("verifyMemoryFileContent：四字段/name 归一/正文非空/长度合规", () => {
  // 用临时根（绝不写相对路径到 cwd——那会在仓库里留下 x/ 之类脏目录）
  const tmpRoot = freshRoot();
  try {
  const good = seed(join(tmpRoot, "memory"), "ok.md", "正文");
  const ok = verifyMemoryFileContent(good, { expectedName: "ok" });
  assert.equal(ok.ok, true);
  // frontmatter 缺失
  assert.equal(verifyMemoryFileContent("没有 frontmatter\n\n正文").ok, false);
  // frontmatter 未闭合
  assert.equal(verifyMemoryFileContent("---\nname: \"a\"\ndescription: \"d\"\n\n正文").ok, false);
  // 四字段不全（缺 node_type）
  assert.equal(verifyMemoryFileContent('---\nname: "a"\ndescription: "d"\nmetadata:\n  type: project\n---\n\n正文').ok, false);
  // 缺 metadata.type
  assert.equal(verifyMemoryFileContent('---\nname: "a"\ndescription: "d"\nnode_type: "memory"\n---\n\n正文').ok, false);
  // name 与文件名不一致
  assert.equal(verifyMemoryFileContent(good, { expectedName: "other" }).ok, false);
  // 正文为空
  assert.equal(verifyMemoryFileContent('---\nname: "a"\ndescription: "d"\nmetadata:\n  type: project\nnode_type: "memory"\n---\n\n').ok, false);
  // 正文超长
  const long = '---\nname: "a"\ndescription: "d"\nmetadata:\n  type: project\nnode_type: "memory"\n---\n\n' + "x".repeat(300);
  assert.equal(verifyMemoryFileContent(long, { maxBodyChars: 100 }).ok, false);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---- 写后校验失败 → 回滚 + 标本 + 计数 ----

test("frontmatter 损坏 → 回滚旧文 + 新档进快照 failed/ 留标本 + 计 verifyFailed", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seed(memRoot, "fact.md", "旧正文，完好无损。", "旧钩子");
    const { log, warns } = collecting();
    // 覆盖既有文件（带正确 sha1 以免先被盲写闸拦），但 content 会渲染出损坏的 frontmatter
    // ——这里用超长正触发校验失败（正文超长 = 写后校验不过）。
    const result = applyOps(memRoot, [
      { action: "write", name: "fact.md", type: "project", title: "Fact", description: "新钩子", content: "x".repeat(25000) },
    ], { storageRoot: root, originSessionId: "s-1", log });
    // 校验失败 → 该 op 不计 writes，计 verifyFailed
    assert.equal(result.writes, 0);
    assert.equal(result.verifyFailed, 1);
    // 旧文被回滚（逐字节还原）
    assert.equal(readFileSync(join(memRoot, "fact.md"), "utf8"), original);
    // 标本进了快照 failed/ 子目录
    const snaps = listSurgicalSnapshots(root);
    assert.equal(snaps.length, 1);
    assert.equal(existsSync(join(surgicalRoot(root), snaps[0].id, "failed", "memory", "fact.md")), true);
    // 有 warn 留痕
    assert.equal(warns.some((w) => w.includes("写后校验失败")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("带正确 sha1 的合法覆盖 → 落盘 + 快照留旧文（可回滚）", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seed(memRoot, "wrong.md", "旧正文。", "旧钩子");
    // 覆盖必须带与当前文件相符的短 sha1，否则盲写降级/带错拒绝（见 expected-sha1.test.mjs）
    const result = applyOps(memRoot, [
      { action: "write", name: "wrong.md", type: "project", title: "W", description: "新钩子", content: "新正文", sha1: sha1Short(original) },
    ], { storageRoot: root, originSessionId: "s-1", log: silent });
    assert.equal(result.writes, 1);
    assert.equal(result.verifyFailed, 0);
    assert.equal(result.expectedSha1Mismatches, 0);
    assert.equal(result.blindWriteDowngrades, 0);
    // 落的是新内容
    assert.match(readFileSync(join(memRoot, "wrong.md"), "utf8"), /新正文/);
    // 旧文进了快照（可回滚）
    assert.notEqual(result.snapshotId, null);
    assert.equal(readFileSync(join(surgicalRoot(root), result.snapshotId, "files", "memory", "wrong.md"), "utf8"), original);
    // 一键恢复原文
    const restored = restoreSurgicalSnapshot(root, result.snapshotId, { log: silent });
    assert.deepEqual(restored.restored, ["wrong.md"]);
    assert.equal(readFileSync(join(memRoot, "wrong.md"), "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hardfactPolicy=block 时硬事实丢失按校验失败回滚（计 hardfactBlocks，不混入 verifyFailed）", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seed(memRoot, "count.md", "上个月统计有 269 个文件。", "统计");
    const result = applyOps(memRoot, [
      { action: "write", name: "count.md", type: "project", title: "C", description: "统计", content: "上个月统计有 267 个文件。", sha1: sha1Short(original) },
    ], { storageRoot: root, originSessionId: "s-1", settings: { hardfactPolicy: "block" }, log: silent });
    // block：检出近似替换（269→267）→ 回滚，不落盘
    assert.equal(result.writes, 0);
    assert.equal(result.hardfactDrops, 1);
    // 计数分离：block 计 hardfactBlocks，verifyFailed 保持 0（性质不同的失败不混计）
    assert.equal(result.hardfactBlocks, 1);
    assert.equal(result.verifyFailed, 0);
    assert.equal(readFileSync(join(memRoot, "count.md"), "utf8"), original);
    // 标本留档
    assert.equal(existsSync(join(surgicalRoot(root), result.snapshotId, "failed", "memory", "count.md")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hardfactPolicy=warn（默认）时硬事实丢失只告警不回滚", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seed(memRoot, "count2.md", "上个月统计有 269 个文件。", "统计");
    const result = applyOps(memRoot, [
      { action: "write", name: "count2.md", type: "project", title: "C", description: "统计", content: "上个月统计有 267 个文件。", sha1: sha1Short(original) },
    ], { storageRoot: root, originSessionId: "s-1", log: silent });
    assert.equal(result.writes, 1);
    assert.equal(result.hardfactDrops, 1); // 有记录
    assert.equal(result.hardfactBlocks, 0); // warn 不拦截
    assert.equal(result.verifyFailed, 0); // 但不回滚
    assert.match(readFileSync(join(memRoot, "count2.md"), "utf8"), /267/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("纯新增文件校验失败 → 不留脏档（无旧文可回滚即删除）+ 标本入回收站", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const { log, warns } = collecting();
    const result = applyOps(memRoot, [
      { action: "write", name: "brand-new.md", type: "project", title: "N", description: "d", content: "y".repeat(25000) },
    ], { storageRoot: root, originSessionId: "s-1", log });
    assert.equal(result.writes, 0);
    assert.equal(result.verifyFailed, 1);
    // 没有旧文 → 不在记忆目录留这个坏档
    assert.equal(existsSync(join(memRoot, "brand-new.md")), false);
    // 纯新增无快照（无破坏性 op）→ 标本落回收站
    const trashDir = join(root, "trash");
    assert.equal(existsSync(trashDir), true);
    assert.equal(warns.some((w) => w.includes("写后校验失败")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("校验失败的 op 不进索引（MEMORY.md 不留坏档行）", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const result = applyOps(memRoot, [
      { action: "write", name: "bad.md", type: "project", title: "B", description: "坏", content: "z".repeat(25000) },
      { action: "write", name: "good.md", type: "project", title: "G", description: "好", content: "好正文" },
    ], { storageRoot: root, originSessionId: "s-1", log: silent });
    assert.equal(result.writes, 1); // 只有 good 落盘
    assert.equal(result.verifyFailed, 1);
    const index = readFileSync(join(memRoot, "MEMORY.md"), "utf8");
    assert.match(index, /- \[G\]\(good\.md\) — 好/);
    assert.doesNotMatch(index, /\(bad\.md\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("不传 storageRoot = 旧版裸写语义（校验关闭，不新增计数）", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    // 无 storageRoot：不启用安全面（向后兼容独立 applyOps 调用）
    const result = applyOps(memRoot, [
      { action: "write", name: "plain.md", type: "project", title: "P", description: "d", content: "正文" },
    ], { originSessionId: "s-1", log: silent });
    assert.equal(result.writes, 1);
    assert.equal(result.verifyFailed, 0);
    assert.equal(result.snapshotId, null);
    assert.equal(existsSync(join(root, "backups")), false); // 不落快照
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 批前原文读失败（文件存在却读不出）→ 覆盖 / 删除 fail-closed 跳过 ----

test("批前原文读失败（同名目录占位）→ 覆盖被跳过，盘上「内容」未被动", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    mkdirSync(memRoot, { recursive: true });
    // 用「同名目录占位」让 readFileSync(EISDIR)：文件路径上坐着目录，
    // 覆盖按 fail-closed 跳过——不盲写、也不把目录当空文件顶替。
    mkdirSync(join(memRoot, "stuck.md"), { recursive: true });
    writeFileSync(join(memRoot, "stuck.md", "inner.txt"), "占位内部标记", "utf8");
    const { log, warns } = collecting();
    const result = applyOps(memRoot, [
      { action: "write", name: "stuck.md", type: "project", title: "S", description: "d", content: "想覆盖的正文" },
    ], { storageRoot: root, originSessionId: "s-1", log });
    // 覆盖被跳过（不计写成功）
    assert.equal(result.writes, 0);
    assert.equal(result.skipped, 1);
    // 盘上占位目录与内部标记未被动（没被当文件顶替、没被删）
    assert.equal(existsSync(join(memRoot, "stuck.md", "inner.txt")), true);
    assert.equal(readFileSync(join(memRoot, "stuck.md", "inner.txt"), "utf8"), "占位内部标记");
    assert.equal(warns.some((w) => w.includes("读取失败")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 全局 write 批前原文读失败 → 覆盖 fail-closed 跳过（global 维度）----

test("global 批前原文读失败（同名目录占位）→ 覆盖被跳过，占位未被动", () => {
  const root = freshRoot();
  const projectRoot = join(root, "projects", "p1", "memory");
  try {
    const catDir = join(root, "global", "long-term");
    mkdirSync(catDir, { recursive: true });
    // 同名目录占位让 readFileSync(EISDIR)：global 侧覆盖按 fail-closed 跳过。
    mkdirSync(join(catDir, "stuck.md"), { recursive: true });
    writeFileSync(join(catDir, "stuck.md", "inner.txt"), "占位内部标记", "utf8");
    const { log, warns } = collecting();
    const result = applyScopedOps({ storageRoot: root, projectRoot }, [
      { action: "write", name: "stuck.md", title: "S", description: "d", content: "想覆盖的正文", scope: "global:long-term" },
    ], { originSessionId: "s-1", log });
    // 覆盖被跳过（不计写成功）+ 计数
    assert.equal(result.writes, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.blockedDestructiveOps, 1, "读失败跳过必须计入 blockedDestructiveOps");
    // 盘上占位目录与内部标记未被动（没被当文件顶替、没被删）
    assert.equal(existsSync(join(catDir, "stuck.md", "inner.txt")), true);
    assert.equal(readFileSync(join(catDir, "stuck.md", "inner.txt"), "utf8"), "占位内部标记");
    assert.equal(warns.some((w) => w.includes("读取失败")), true, "必须 warn 留痕");
    // 无既有可留档 → 不建快照
    assert.equal(result.snapshotId, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 删除读失败闸：目标被同名目录占位 → delete 跳过 + 计数 + 不进回收站 ----

test("project 删除读失败（同名目录占位）→ 跳过 + 计数 + 不进回收站", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    mkdirSync(memRoot, { recursive: true });
    // 同名目录占位让 readFileSync(EISDIR)：delete 无从留档也无从判定 → fail-closed 跳过。
    mkdirSync(join(memRoot, "gone.md"), { recursive: true });
    writeFileSync(join(memRoot, "gone.md", "inner.txt"), "占位内部标记", "utf8");
    const { log, warns } = collecting();
    const result = applyOps(memRoot, [
      { action: "delete", name: "gone.md" },
    ], { storageRoot: root, originSessionId: "s-1", log });
    assert.equal(result.deletes, 0, "删除必须被跳过");
    assert.equal(result.skipped, 1);
    assert.equal(result.blockedDestructiveOps, 1, "跳过必须计入 blockedDestructiveOps");
    // 占位目录与内部标记未被动；未进回收站（不盲删）
    assert.equal(existsSync(join(memRoot, "gone.md", "inner.txt")), true);
    assert.equal(readFileSync(join(memRoot, "gone.md", "inner.txt"), "utf8"), "占位内部标记");
    assert.equal(listTrash(root).length, 0, "不得进回收站");
    assert.equal(warns.some((w) => w.includes("读取失败")), true, "必须 warn 留痕");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global 删除读失败（同名目录占位）→ 跳过 + 计数 + 不进回收站", () => {
  const root = freshRoot();
  const projectRoot = join(root, "projects", "p1", "memory");
  try {
    const catDir = join(root, "global", "long-term");
    mkdirSync(catDir, { recursive: true });
    mkdirSync(join(catDir, "gone.md"), { recursive: true });
    writeFileSync(join(catDir, "gone.md", "inner.txt"), "占位内部标记", "utf8");
    const { log, warns } = collecting();
    const result = applyScopedOps({ storageRoot: root, projectRoot }, [
      { action: "delete", name: "gone.md", scope: "global:long-term" },
    ], { originSessionId: "s-1", log });
    assert.equal(result.deletes, 0, "删除必须被跳过");
    assert.equal(result.skipped, 1);
    assert.equal(result.blockedDestructiveOps, 1, "跳过必须计入 blockedDestructiveOps");
    assert.equal(existsSync(join(catDir, "gone.md", "inner.txt")), true);
    assert.equal(readFileSync(join(catDir, "gone.md", "inner.txt"), "utf8"), "占位内部标记");
    assert.equal(listTrash(root).length, 0, "不得进回收站");
    assert.equal(warns.some((w) => w.includes("读取失败")), true, "必须 warn 留痕");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 原子回滚不消失：标本 copy 失败时目标路径仍存旧文，绝不出现文件消失 ----

test("标本 copy 失败（failed/ 路径被占位成目录）→ 目标文件仍存在且为旧文，绝不消失", () => {
  const root = freshRoot();
  const realNow = Date.now;
  const FIXED = 1730000000000;
  const iso = new Date(FIXED).toISOString().replace(/[:.]/g, "-");
  const base = `${iso}-${process.pid}`;
  try {
    const memRoot = join(root, "memory");
    const original = seed(memRoot, "victim.md", "旧正文，绝不能消失。", "旧钩子");
    // 确定性手法：固定时间戳 + 预铺快照 id 目录，把最终新建的那份（base-49）的
    // failed/ 标本路径占成目录，使 copyFileSync 必炸（EPERM）；同时把 base、base-0..base-49
    // 全部占住，逼 snapshotId 的撞车重试耗尽落到 base-49。快照本体仍成功（留档不丢）。
    const sroot = surgicalRoot(root);
    mkdirSync(sroot, { recursive: true });
    for (let i = -1; i <= 49; i += 1) mkdirSync(join(sroot, i < 0 ? base : `${base}-${i}`), { recursive: true });
    mkdirSync(join(sroot, `${base}-49`, "failed", "memory", "victim.md"), { recursive: true });
    Date.now = () => FIXED;
    let result;
    const { log, warns } = collecting();
    try {
      result = applyOps(memRoot, [
        { action: "write", name: "victim.md", type: "project", title: "V", description: "新钩子", content: "x".repeat(25000) },
      ], { storageRoot: root, originSessionId: "s-1", log });
    } finally {
      Date.now = realNow;
    }
    // 校验失败按回滚处理：标本没留住（warn）但旧文必须原子换回
    assert.equal(result.verifyFailed, 1);
    assert.equal(warns.some((w) => w.includes("标本复制失败")), true);
    // 关键约定：目标文件仍存在，且内容为旧文（原子回滚成功）
    assert.equal(existsSync(join(memRoot, "victim.md")), true, "目标文件绝不能消失");
    assert.equal(readFileSync(join(memRoot, "victim.md"), "utf8"), original, "盘上应为旧文");
  } finally {
    Date.now = realNow;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 全局 delete 必须对账分类索引（悬挂行本就无测试，回退到 trashMemoryFile-only 即红）----

test("global delete 后：文件进回收站 + 分类 MEMORY.md 不再含该名（无悬挂行）", () => {
  const root = freshRoot();
  const projectRoot = join(root, "projects", "p1", "memory");
  try {
    // 分类索引先有该条（createEntry 会同步重建索引）
    createEntry(root, "long-term", { title: "待删全局条目", description: "旧钩子", content: "正文。", name: "gone.md" });
    const catDir = join(root, "global", "long-term");
    assert.match(readFileSync(join(catDir, "MEMORY.md"), "utf8"), /gone\.md/, "删除前索引应含该名");
    const before = readFileSync(join(catDir, "gone.md"), "utf8");

    const result = applyScopedOps({ storageRoot: root, projectRoot }, [
      { action: "delete", name: "gone.md", scope: "global:long-term" },
    ], { originSessionId: "s-1", log: silent });

    assert.equal(result.deletes, 1, "删除应成功");
    // 文件已移出本体
    assert.equal(existsSync(join(catDir, "gone.md")), false);
    // 进了回收站且原文可找回（delete 不硬删）
    const entries = listTrash(root);
    assert.equal(entries.length, 1, "必须进回收站");
    const copy = join(trashRoot(root), entries[0].id, "files", "global", "long-term", "gone.md");
    assert.equal(readFileSync(copy, "utf8"), before, "回收站副本应与原文一致");
    // 关键回归：索引不再含该名（若仍只调 trashMemoryFile、不对账索引，此行会残留 = 红）
    assert.doesNotMatch(readFileSync(join(catDir, "MEMORY.md"), "utf8"), /gone\.md/, "分类索引不得残留悬挂行");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 全局写后读校验：空/损坏 body 的覆盖必须检出并回滚（此前 verifyFailed 恒 0）----

test("global 覆盖既有条目写入空/损坏 body → 检出 + 回滚旧文 + 计 verifyFailed，索引不留坏行", () => {
  const root = freshRoot();
  const projectRoot = join(root, "projects", "p1", "memory");
  try {
    createEntry(root, "long-term", { title: "旧条目", description: "旧钩子", content: "旧正文，必须留住。", name: "keep.md" });
    const catDir = join(root, "global", "long-term");
    const before = readFileSync(join(catDir, "keep.md"), "utf8");
    // 覆盖既有全局条目，但 content 超长 → 渲染出的 body 过不了写后校验（正文超长）。
    const result = applyScopedOps({ storageRoot: root, projectRoot }, [
      { action: "write", name: "keep.md", title: "新条目", description: "新钩子", content: "x".repeat(25000), scope: "global:long-term" },
    ], { originSessionId: "s-1", log: silent });

    assert.equal(result.verifyFailed, 1, "全局写后校验必须检出坏档");
    assert.equal(result.writes, 0, "坏档不计写成功");
    // 旧文被回滚到原样
    assert.equal(readFileSync(join(catDir, "keep.md"), "utf8"), before, "旧文必须逐字节回滚");
    // 索引仍是旧行（不残留坏档新行）
    const index = readFileSync(join(catDir, "MEMORY.md"), "utf8");
    assert.match(index, /keep\.md/, "旧条目索引行应保留");
    assert.doesNotMatch(index, /新钩子/, "坏档新行不得留在索引");
    // 旧文进快照可找回（覆盖既有 → 批前留档）
    assert.notEqual(result.snapshotId, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global 纯新增写入损坏 body → 检出 + 移除脏档 + 计 verifyFailed（不留脏档）", () => {
  const root = freshRoot();
  const projectRoot = join(root, "projects", "p1", "memory");
  try {
    const catDir = join(root, "global", "long-term");
    const result = applyScopedOps({ storageRoot: root, projectRoot }, [
      { action: "write", name: "brand-new.md", title: "新", description: "d", content: "y".repeat(25000), scope: "global:long-term" },
    ], { originSessionId: "s-1", log: silent });

    assert.equal(result.verifyFailed, 1);
    assert.equal(result.writes, 0);
    // 纯新增脏档不留记忆目录（无旧文可回滚 → 移除）
    assert.equal(existsSync(join(catDir, "brand-new.md")), false, "纯新增坏档不得留在记忆目录");
    // 索引不留该行
    const index = existsSync(join(catDir, "MEMORY.md")) ? readFileSync(join(catDir, "MEMORY.md"), "utf8") : "";
    assert.doesNotMatch(index, /brand-new\.md/, "纯新增坏档不得进索引");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global 合法覆盖：写后校验通过、不计 verifyFailed、索引即时更新", () => {
  const root = freshRoot();
  const projectRoot = join(root, "projects", "p1", "memory");
  try {
    createEntry(root, "long-term", { title: "旧条目", description: "旧钩子", content: "旧正文。", name: "ok.md" });
    const result = applyScopedOps({ storageRoot: root, projectRoot }, [
      { action: "write", name: "ok.md", title: "新条目", description: "新钩子", content: "新正文，完全合法。", scope: "global:long-term" },
    ], { originSessionId: "s-1", log: silent });
    assert.equal(result.writes, 1);
    assert.equal(result.verifyFailed, 0, "合法覆盖不得误报校验失败");
    assert.equal(readEntry(root, "long-term", "ok.md").content, "新正文，完全合法。");
    assert.match(readFileSync(join(root, "global", "long-term", "MEMORY.md"), "utf8"), /新钩子/, "索引应即时更新为新钩子");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- project 同批同名双写：第二个写前发现已建出 → fail-closed 跳过（非 last-wins）----

test("project 同批同名双写：第二个写前发现已建出被跳过，第一个文件存活且索引无悬挂行", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const { log, warns } = collecting();
    // 两个 op 同名、预扫时都不存在（都判纯新增）；第一个落盘后目标才出现——若无写前检查，
    // 第二个会当纯新增直通覆盖（last-wins）静默顶掉第一个；更坏的是若随后写后校验失败，
    // rollbackBadWrite 会按纯新增把文件整个删掉（好写被无声丢失、索引悬挂）。
    const result = applyOps(memRoot, [
      { action: "write", name: "dup.md", type: "project", title: "第一个", description: "d", content: "第一个正文，必须存活。" },
      { action: "write", name: "dup.md", type: "project", title: "第二个", description: "d", content: "第二个正文，不得顶掉。" },
    ], { storageRoot: root, originSessionId: "s-1", log });

    assert.equal(result.writes, 1, "只有第一个落盘（非 last-wins）");
    assert.equal(result.skipped, 1, "第二个必须被跳过");
    assert.equal(result.blockedDestructiveOps, 1, "跳过必须计入 blockedDestructiveOps");
    // 第一个文件存活、内容未被第二个顶掉
    const body = readFileSync(join(memRoot, "dup.md"), "utf8");
    assert.match(body, /第一个正文，必须存活。/);
    assert.doesNotMatch(body, /第二个正文/);
    // 索引恰好一行、指向存活的那个（无悬挂行、无 last-wins 覆盖的痕迹）
    const index = readFileSync(join(memRoot, "MEMORY.md"), "utf8");
    assert.equal(index.split("\n").filter((l) => l.includes("(dup.md)")).length, 1, "索引应恰一行");
    assert.match(index, /第一个/);
    assert.doesNotMatch(index, /第二个/);
    // 纯新增批不产生快照；warn 留痕说明写前发现已被建出
    assert.equal(result.snapshotId, null, "纯新增批不应触发快照");
    assert.equal(warns.some((w) => w.includes("写前") && w.includes("dup.md")), true, "必须 warn 留痕");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- P2-a 同批两侧快照互杀（2026-10-22 补）----
// 语境：同一批既有 global 又有 project 破坏性 op 时，两侧各建一份手术快照、各 prune 一次。
// surgicalKeep 调小（如 1）时，后一次 prune 会把前一次刚建的那份顶掉——用户丢掉本批的
// 一半回滚材料（面板「快照」页只剩一份，另一侧覆盖后无法回滚）。
// 修法：prune 接受 protectIds，本批新建的两份都豁免。

test("同批 global+project 破坏性写：surgicalKeep=1 时两份预映像都必须保留", () => {
  const root = freshRoot();
  const projectRoot = join(root, "memory");
  try {
    // 各建一条既有条目（都已有旧文 → 两侧都会建快照）
    const catDir = join(root, "global", "work-profile");
    mkdirSync(catDir, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    const globalOriginal = seed(catDir, "g.md", "全局旧正文", "全局条目");
    const projectOriginal = seed(projectRoot, "p.md", "项目旧正文", "项目条目");

    const result = applyScopedOps({ storageRoot: root, projectRoot }, [
      { action: "write", name: "g.md", scope: "global:work-profile", title: "G", description: "全局条目", content: "全局新正文", sha1: sha1Short(globalOriginal) },
      { action: "write", name: "p.md", scope: "project", title: "P", description: "项目条目", content: "项目新正文", sha1: sha1Short(projectOriginal) },
    ], { originSessionId: "s-1", settings: { surgicalKeep: 1 }, log: silent });

    // 两份快照必须都在（keep=1 也不许互杀）
    const snaps = listSurgicalSnapshots(root);
    assert.equal(snaps.length, 2, `keep=1 时同批两份预映像都必须保留，实际 ${snaps.length} 份`);
    // 且每份真的含对应旧文（不是空壳）
    const names = [];
    for (const s of snaps) {
      const dir = join(surgicalRoot(root), s.id, "files");
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(d, e.name));
          else names.push(e.name);
        }
      };
      if (existsSync(dir)) walk(dir);
    }
    assert.ok(names.some((n) => n.includes("g.md")), "global 侧预映像必须在");
    assert.ok(names.some((n) => n.includes("p.md")), "project 侧预映像必须在");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

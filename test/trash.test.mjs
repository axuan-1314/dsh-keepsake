// trash：delete→trash→restore 往返、索引对账、purge 策略、路径穿越拒绝。
// 约定：只用临时 storageRoot（os.tmpdir 下自建），绝不读写 ~/.dsh/memory。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireExtractLock,
  isSafeSnapshotId,
  isSafeTrashId,
  listSurgicalSnapshots,
  listTrash,
  pruneSurgicalSnapshots,
  pruneTrash,
  purgeTrash,
  restoreSurgicalSnapshot,
  restoreTrash,
  sha1Short,
  surgicalRoot,
  trashMemoryFile,
  trashRoot,
} from "../lib/safety.js";
import { applyOps } from "../lib/extract.js";

const silent = { warn: () => {}, error: () => {} };

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-trash-"));
}
function seed(memRoot, name, body, description = "desc") {
  mkdirSync(memRoot, { recursive: true });
  writeFileSync(join(memRoot, name), `---
name: "${name.replace(/\.md$/i, "")}"
description: "${description}"
metadata:
  type: project
node_type: "memory"
---

${body}
`, "utf8");
  return readFileSync(join(memRoot, name), "utf8");
}

// ---- 往返 ----

test("delete → 移入 trash（非硬删）+ restore 往返还原原文", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seed(memRoot, "a.md", "要被删掉的正文。", "钩子");
    // 先建索引（模拟既有记忆目录）
    writeFileSync(join(memRoot, "MEMORY.md"), "- [a](a.md) — 钩子\n", "utf8");
    const moved = trashMemoryFile(root, { rootKey: "memory", name: "a.md", originSessionId: "s-1" });
    assert.notEqual(moved, null);
    assert.equal(isSafeTrashId(moved.entryId), true);
    // 磁盘上真没了（delete 语义成立）
    assert.equal(existsSync(join(memRoot, "a.md")), false);
    // 但进了回收站（副本仍在）
    const entryDir = join(trashRoot(root), moved.entryId);
    assert.equal(existsSync(join(entryDir, "files", "memory", "a.md")), true);
    const meta = JSON.parse(readFileSync(join(entryDir, "meta.json"), "utf8"));
    assert.equal(meta.entryId, moved.entryId);
    assert.equal(meta.originSessionId, "s-1");
    assert.equal(meta.files[0].name, "a.md");
    assert.equal(meta.files[0].rootKey, "memory"); // rootKey 能路由回原根
    assert.equal(meta.files[0].action, "delete");
    assert.match(meta.files[0].sha1, /^[0-9a-f]{8}$/);
    // restore 回原根，原文逐字节还原
    const out = restoreTrash(root, moved.entryId);
    assert.deepEqual(out.restored, ["a.md"]);
    assert.equal(out.indexReconciled, true);
    assert.equal(readFileSync(join(memRoot, "a.md"), "utf8"), original);
    // 恢复后条目清空（目录删除）
    assert.equal(listTrash(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore 后 MEMORY.md 与磁盘一致（索引对账，不留悬挂/重复行）", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seed(memRoot, "b.md", "B 正文。", "B 钩子");
    seed(memRoot, "c.md", "C 正文。", "C 钩子");
    // 走真实删除路径（applyOps 负责把 delete 落到回收站并对账索引）
    const del = applyOps(memRoot, [{ action: "delete", name: "b.md" }, { action: "delete", name: "c.md" }], { storageRoot: root, originSessionId: "s-1", log: silent });
    assert.equal(del.deletes, 2);
    // 删除后磁盘无文件、索引无悬挂行（终态对账由 applyOps 完成）
    assert.equal(existsSync(join(memRoot, "b.md")), false);
    assert.equal(existsSync(join(memRoot, "c.md")), false);
    assert.doesNotMatch(readFileSync(join(memRoot, "MEMORY.md"), "utf8"), /\(b\.md\)|\(c\.md\)/);
    const entries = listTrash(root);
    assert.equal(entries.length, 2);
    // 只恢复 b：索引补回 b，c 不得出现
    const which = entries.find((e) => e.files[0].name === "b.md");
    const out = restoreTrash(root, which.id);
    assert.deepEqual(out.restored, ["b.md"]);
    assert.equal(out.indexReconciled, true);
    let index = readFileSync(join(memRoot, "MEMORY.md"), "utf8");
    assert.match(index, /- \[b\]\(b\.md\) — B 钩子/);
    assert.doesNotMatch(index, /\(c\.md\)/);
    assert.equal(existsSync(join(memRoot, "b.md")), true);
    assert.equal(existsSync(join(memRoot, "c.md")), false); // 磁盘与索引双侧一致
    // 再恢复 c → 各恰一行
    const other = listTrash(root).find((e) => e.files[0].name === "c.md");
    restoreTrash(root, other.id);
    index = readFileSync(join(memRoot, "MEMORY.md"), "utf8");
    assert.equal(index.split("\n").filter((l) => l.includes("(c.md)")).length, 1);
    assert.equal(index.split("\n").filter((l) => l.includes("(b.md)")).length, 1);
    assert.equal(existsSync(join(memRoot, "b.md")), true);
    assert.equal(existsSync(join(memRoot, "c.md")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- purge 策略 ----

test("purge 按 id 清单条 / 按 olderThanDays 清过期 / 全清", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seed(memRoot, "x.md", "X"); seed(memRoot, "y.md", "Y"); seed(memRoot, "z.md", "Z");
    const old = trashMemoryFile(root, { rootKey: "memory", name: "x.md", now: 1700000000000 });
    const recent = trashMemoryFile(root, { rootKey: "memory", name: "y.md", now: 1700000000000 + 86_400_000 });
    const now = 1700000000000 + 2 * 86_400_000; // 当前视作 base+2 天：old=2 天前，recent=1 天前
    assert.equal(listTrash(root).length, 2);
    // 按 id 清单条
    assert.deepEqual(purgeTrash(root, { id: old.entryId }), { purged: 1 });
    assert.equal(listTrash(root).length, 1);
    // 按天数：清超过 5 天的 → 两条都不到 5 天（2 天/1 天），一条不清
    assert.deepEqual(purgeTrash(root, { olderThanDays: 5, now }), { purged: 0 });
    assert.equal(listTrash(root).length, 1);
    // 按天数：清超过 1.5 天的 → 只剩 old（2 天前）过期，recent（1 天前）保留
    assert.deepEqual(purgeTrash(root, { olderThanDays: 1.5, now }), { purged: 0 });
    // 按天数：清超过 0.5 天的 → recent（1 天前）也过期
    assert.deepEqual(purgeTrash(root, { olderThanDays: 0.5, now }), { purged: 1 });
    assert.equal(listTrash(root).length, 0);
    // 全清（两参都省）——三条一起进回收站再全清
    seed(memRoot, "p.md", "P"); seed(memRoot, "q.md", "Q");
    trashMemoryFile(root, { rootKey: "memory", name: "p.md" });
    trashMemoryFile(root, { rootKey: "memory", name: "q.md" });
    assert.equal(purgeTrash(root).purged, 2);
    assert.equal(listTrash(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneTrash（写路径顺带清理）按 trashKeepDays 清过期；当天条目保留", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seed(memRoot, "keep.md", "K"); seed(memRoot, "drop.md", "D");
    trashMemoryFile(root, { rootKey: "memory", name: "keep.md", now: Date.now() });
    trashMemoryFile(root, { rootKey: "memory", name: "drop.md", now: Date.now() - 40 * 86_400_000 });
    assert.equal(listTrash(root).length, 2);
    assert.equal(pruneTrash(root, 30), 1); // 40 天前那条清掉
    const left = listTrash(root);
    assert.equal(left.length, 1);
    assert.equal(left[0].files[0].name, "keep.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 安全闸：路径穿越拒绝 ----

test("路径穿越 name 被三道闸拒绝（不删任何文件、不留回收站条目）", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seed(memRoot, "a.md", "正文");
    seed(join(root, "outside"), "secret.md", "根外文件");
    for (const evil of ["../outside/secret.md", "..\\..\\evil.md", "MEMORY.md", ".git/x.md"]) {
      assert.equal(trashMemoryFile(root, { rootKey: "memory", name: evil }), null, `应被拒绝: ${evil}`);
    }
    // 根外文件与记忆目录完好，回收站无条目
    assert.equal(existsSync(join(root, "outside", "secret.md")), true);
    assert.equal(existsSync(join(memRoot, "a.md")), true);
    assert.equal(listTrash(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore 的 name/id 未过闸即显式抛错；meta 里的穿越条目被跳过", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seed(memRoot, "a.md", "正文");
    const moved = trashMemoryFile(root, { rootKey: "memory", name: "a.md", originSessionId: "s-1" });
    // 非法 id 形态
    assert.throws(() => restoreTrash(root, "../etc"), /非法回收站 id/);
    assert.throws(() => restoreTrash(root, "xx"), /非法回收站 id/);
    // 合法 id 但条目不存在
    assert.throws(() => restoreTrash(root, "2099-01-01T00-00-00-000Z"), /不存在/);
    // 未过闸的 name
    assert.throws(() => restoreTrash(root, moved.entryId, { name: "../../evil.md" }), /未通过安全闸/);
    // 篡改 meta 塞穿越条目 → 恢复时跳过（meta 是盘上数据，不信任）
    const metaPath = join(trashRoot(root), moved.entryId, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.files.push({ name: "../../escape.md", rootKey: "memory", sha1: "", action: "delete" });
    meta.files.push({ name: "ok.md", rootKey: "..", sha1: "", action: "delete" });
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
    const warns = [];
    const out = restoreTrash(root, moved.entryId, { log: { warn: (m) => warns.push(m) } });
    assert.deepEqual(out.restored, ["a.md"]); // 只回合法那条
    assert.equal(existsSync(join(root, "..", "escape.md")), false);
    assert.equal(existsSync(join(root, "ok.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore 指定 name 只回该条，其余留在条目里", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seed(memRoot, "one.md", "1"); seed(memRoot, "two.md", "2");
    const entry = trashMemoryFile(root, { rootKey: "memory", name: "one.md" });
    // 同一 entryId 塞第二条（模拟同批多文件一次入站）
    const metaPath = join(trashRoot(root), entry.entryId, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.files.push({ name: "two.md", rootKey: "memory", sha1: "", action: "delete", indexLine: "- [two](two.md) — 2" });
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
    mkdirSync(join(trashRoot(root), entry.entryId, "files", "memory"), { recursive: true });
    writeFileSync(join(trashRoot(root), entry.entryId, "files", "memory", "two.md"), "---\nname: \"two\"\ndescription: \"2\"\nmetadata:\n  type: project\nnode_type: \"memory\"\n---\n\n2\n", "utf8");
    const out = restoreTrash(root, entry.entryId, { name: "two.md" });
    assert.deepEqual(out.restored, ["two.md"]);
    assert.equal(existsSync(join(memRoot, "two.md")), true);
    assert.equal(existsSync(join(memRoot, "one.md")), false); // 未点名仍在站里
    assert.equal(listTrash(root).length, 1); // 条目未清空
    assert.equal(listTrash(root)[0].files.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("同一毫秒撞车 → entryId 带 -N 尾且不互串", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seed(memRoot, "a.md", "A"); seed(memRoot, "b.md", "B");
    const fixed = 1700000000000;
    const e1 = trashMemoryFile(root, { rootKey: "memory", name: "a.md", now: fixed });
    const e2 = trashMemoryFile(root, { rootKey: "memory", name: "b.md", now: fixed });
    assert.notEqual(e1.entryId, e2.entryId);
    assert.equal(listTrash(root).length, 2);
    // 各自的内容不互串
    const files = listTrash(root).flatMap((e) => e.files.map((f) => f.name)).sort();
    assert.deepEqual(files, ["a.md", "b.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 副本先行：meta 写不进去时，原件一个都不许被碰 ----

test("meta 写不进去 → 抛 TRASH_WRITE_FAILED，原件原地不动、trash 下无残留半成品", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seed(memRoot, "a.md", "丢不得的正文。", "钩子");
    const fixed = 1700000000000;
    const id = new Date(fixed).toISOString().replace(/[:.]/g, "-");
    // 注入：把 meta.json 目标路径先占成目录——条目目录/files 能建，写 meta 必失败（EISDIR）。
    mkdirSync(join(trashRoot(root), id, "meta.json"), { recursive: true });
    let thrown = null;
    assert.throws(
      () => trashMemoryFile(root, { rootKey: "memory", name: "a.md", now: fixed }),
      (err) => { thrown = err; assert.equal(err.code, "TRASH_WRITE_FAILED"); return true; },
    );
    assert.match(thrown.message, /未动原件/);
    // 顺序不变量：meta 没落定前原件不许删——记忆根里原件逐字节仍在
    assert.equal(readFileSync(join(memRoot, "a.md"), "utf8"), original, "meta 失败时原件必须原地不动");
    // 半成品被拆干净：占位目录连同刚写的副本一并清掉，list 看不到条目
    assert.equal(existsSync(join(trashRoot(root), id)), false, "失败条目目录必须被拆掉");
    assert.equal(listTrash(root).length, 0, "失败条目不得出现在回收站清单");
    const leftovers = existsSync(trashRoot(root)) ? readdirSync(trashRoot(root)) : [];
    assert.deepEqual(leftovers, [], "trash 下不得残留零文件幽灵条目");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("正常删流——副本 + meta 齐备、原件已删、可原地恢复", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seed(memRoot, "n.md", "正常删流正文。", "钩子");
    const moved = trashMemoryFile(root, { rootKey: "memory", name: "n.md", originSessionId: "s-1" });
    assert.notEqual(moved, null);
    const entryDir = join(trashRoot(root), moved.entryId);
    // 副本先落盘，且与原件逐字节一致
    assert.equal(readFileSync(join(entryDir, "files", "memory", "n.md"), "utf8"), original);
    // meta 已落定（条目成立的判据 = meta.json 是在盘文件）
    assert.equal(existsSync(join(entryDir, "meta.json")), true);
    const meta = JSON.parse(readFileSync(join(entryDir, "meta.json"), "utf8"));
    assert.equal(meta.files[0].name, "n.md");
    assert.equal(meta.files[0].sha1, sha1Short(original));
    // 条目成立后才删原件：记忆根已无原件（delete 语义成立）
    assert.equal(existsSync(join(memRoot, "n.md")), false);
    // 可逆性：恢复原地还原
    const out = restoreTrash(root, moved.entryId);
    assert.deepEqual(out.restored, ["n.md"]);
    assert.equal(readFileSync(join(memRoot, "n.md"), "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- id 位宽：8 位 pid 的快照目录不许被漏看 ----

test("8 位 pid 的快照 id 被 list/prune/恢复识别（Windows pid 位宽不再漏看）", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seed(memRoot, "w.md", "就地被顶替的旧正文。", "钩子");
    const mkSnap = (id, content) => {
      const dir = join(surgicalRoot(root), id);
      mkdirSync(join(dir, "files", "memory"), { recursive: true });
      writeFileSync(join(dir, "files", "memory", "w.md"), content, "utf8");
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({
        batchId: id, originSessionId: "s", createdAt: new Date().toISOString(), ops: [],
        files: [{ name: "w.md", rootKey: "memory", sha1: sha1Short(content), action: "overwrite", indexLine: "- [w](w.md) — 钩子" }],
      }), "utf8");
    };
    const older = "2026-01-02T03-04-05-678Z-12345678"; // 8 位 pid 段
    const newer = "2026-01-03T03-04-05-678Z-87654321";
    assert.equal(isSafeSnapshotId(older), true, "8 位 pid 快照 id 形态合法");
    mkSnap(older, "旧档正文");
    mkSnap(newer, "新档正文");
    // list 认得 8 位 pid 目录（排在最前的新档不被漏看）
    assert.deepEqual(listSurgicalSnapshots(root).map((s) => s.id), [newer, older]);
    // prune 认得：生效滚动保留（若 8 位 pid 目录被漏看，删的数就不对）
    assert.equal(pruneSurgicalSnapshots(root, 1), 1);
    assert.deepEqual(listSurgicalSnapshots(root).map((s) => s.id), [newer]);
    // 恢复认得 8 位 pid 目录：整份回填
    const out = restoreSurgicalSnapshot(root, newer);
    assert.deepEqual(out.restored, ["w.md"]);
    assert.match(readFileSync(join(memRoot, "w.md"), "utf8"), /新档正文/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("合法回收站 id（时间戳 / -N 撞车尾）被 list/purge/恢复识别", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seed(memRoot, "t.md", "T"); seed(memRoot, "u.md", "U");
    const fixed = 1700000000000;
    const e1 = trashMemoryFile(root, { rootKey: "memory", name: "t.md", now: fixed });
    const e2 = trashMemoryFile(root, { rootKey: "memory", name: "u.md", now: fixed }); // 同 ms → -N 尾
    assert.notEqual(e1.entryId, e2.entryId);
    assert.equal(isSafeTrashId(e1.entryId), true);
    assert.equal(isSafeTrashId(e2.entryId), true);
    // list 认得两条
    assert.deepEqual(listTrash(root).map((e) => e.id).sort(), [e1.entryId, e2.entryId].sort());
    // 恢复认得 id（指定名回填）
    const out = restoreTrash(root, e1.entryId, { name: "t.md" });
    assert.deepEqual(out.restored, ["t.md"]);
    assert.equal(existsSync(join(memRoot, "t.md")), true);
    // purge 认得 id：清另一条
    const purged = purgeTrash(root, { id: e2.entryId });
    assert.deepEqual(purged, { purged: 1 });
    assert.equal(listTrash(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- purge 参数校验：非法入参必须在枚举目录之前就抛（全新/不可读根也不例外）----

test("purgeTrash 参数校验前置：非法 olderThanDays/id 一律 TRASH_INVALID，与文件系统状态无关", () => {
  const root = freshRoot();
  try {
    // 全新根（回收站目录都还没建）：非法入参也必须显式抛，不得提前 return 当成功
    assert.equal(existsSync(trashRoot(root)), false, "前置条件：回收站根尚不存在");
    assert.throws(
      () => purgeTrash(root, { olderThanDays: -1 }),
      (err) => err.code === "TRASH_INVALID",
      "olderThanDays<0 必须抛 TRASH_INVALID（此前该守卫零测试，删实现即静默）",
    );
    assert.throws(() => purgeTrash(root, { olderThanDays: -1 }), /olderThanDays/);
    assert.throws(() => purgeTrash(root, { olderThanDays: Number.POSITIVE_INFINITY }), /olderThanDays/);
    assert.throws(
      () => purgeTrash(root, { id: "bogus" }),
      (err) => err.code === "TRASH_INVALID",
      "全新根上非法 id 必须抛 TRASH_INVALID（此前根不可读会提前 return 当成功）",
    );
    assert.throws(() => purgeTrash(root, { id: "../etc" }), /非法回收站 id/);
    // 合法缺省（两参都省）仍能全清（空根返回 0）
    assert.deepEqual(purgeTrash(root), { purged: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("purgeTrash 显式 null 与非数值一律 TRASH_INVALID（库层同口径，不依赖 API 把关）", () => {
  const root = freshRoot();
  try {
    // 造 2 条真回收站条目：显式 null 若被当缺省就会全清（不可逆）——库层必须抛
    const memRoot = join(root, "memory");
    mkdirSync(memRoot, { recursive: true });
    for (const n of ["p.md", "q.md"]) {
      writeFileSync(join(memRoot, n), `---\nname: "${n.replace(/\.md$/, "")}"\ndescription: "d"\nmetadata:\n  type: project\nnode_type: "memory"\n---\n\n正文`);
      trashMemoryFile(root, { rootKey: "memory", name: n });
    }
    assert.equal(listTrash(root).length, 2, "前置：两条回收站条目");
    assert.throws(
      () => purgeTrash(root, { olderThanDays: null }),
      (err) => err.code === "TRASH_INVALID",
      "显式 null 必须在库层就抛（否则任何调用方误传即静默全清）",
    );
    assert.throws(() => purgeTrash(root, { olderThanDays: "3" }), /olderThanDays/);
    assert.equal(listTrash(root).length, 2, "非法入参下一条都不许被清");
    // 反证：键缺省仍=全清；合法有限数按天数过滤
    assert.deepEqual(purgeTrash(root), { purged: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 拷贝中途失败：不留零文件幽灵条目（半成品目录被拆掉）----

test("trash 拷贝中途失败 → 半成品条目目录被拆掉，不留零文件幽灵（listTrash 看不到）", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seed(memRoot, "a.md", "丢不得的正文。", "钩子");
    const fixed = 1700000000000;
    const id = new Date(fixed).toISOString().replace(/[:.]/g, "-");
    // 注入：把副本落点先占成目录 → writeFileSync(copyPath) 抛 EISDIR（拷贝循环中途失败）
    mkdirSync(join(trashRoot(root), id, "files", "memory", "a.md"), { recursive: true });
    assert.throws(() => trashMemoryFile(root, { rootKey: "memory", name: "a.md", now: fixed }));
    // 半成品条目目录被拆干净：listTrash 不得出现零文件幽灵条目
    assert.equal(existsSync(join(trashRoot(root), id)), false, "拷贝中途失败必须拆掉半成品条目目录");
    assert.equal(listTrash(root).length, 0, "不得出现幽灵条目");
    // 原件未被碰（副本先行语义：拷贝失败 = 未成立，原件原地不动）
    assert.equal(readFileSync(join(memRoot, "a.md"), "utf8").includes("丢不得的正文。"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listTrash 忽略无 meta.json 的残条目录（崩溃 litter 不对用户可见）", () => {
  const root = freshRoot();
  try {
    // 手工造一个合法 id 形态但无 meta 的残条目录
    const ghostId = "2020-01-01T00-00-00-000Z";
    mkdirSync(join(trashRoot(root), ghostId, "files", "memory"), { recursive: true });
    writeFileSync(join(trashRoot(root), ghostId, "files", "memory", "x.md"), "残条", "utf8");
    assert.equal(listTrash(root).length, 0, "无 meta.json 的残条目录必须被忽略");
    // 有 meta 的正常条目仍可见
    const memRoot = join(root, "memory");
    seed(memRoot, "a.md", "正文");
    trashMemoryFile(root, { rootKey: "memory", name: "a.md" });
    assert.equal(listTrash(root).length, 1, "有 meta 的条目正常可见");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extract.lock 未来时间戳（时钟漂移/篡改）按 stale 可抢，stale 窗口内的锁仍被尊重", () => {
  const root = freshRoot();
  try {
    mkdirSync(root, { recursive: true });
    // at 落在未来一小时：age<0，若按「未 stale」处理会把锁永久占住
    writeFileSync(join(root, "extract.lock"), JSON.stringify({ pid: process.pid, at: Date.now() + 3_600_000, token: "future" }) + "\n", "utf8");
    const stolen = acquireExtractLock(root);
    assert.equal(stolen.acquired, true, "未来时间戳的锁必须可被抢占");
    assert.equal(stolen.stolen, true);
    // 新主已写回自己的锁（token 换新，无 future 残影）
    assert.notEqual(JSON.parse(readFileSync(join(root, "extract.lock"), "utf8")).token, "future");
    stolen.release();
    assert.equal(existsSync(join(root, "extract.lock")), false);
    // 对照：新鲜锁（age 落在 stale 窗口内）仍被尊重，不可抢
    writeFileSync(join(root, "extract.lock"), JSON.stringify({ pid: 999999, at: Date.now(), token: "fresh" }) + "\n", "utf8");
    const blocked = acquireExtractLock(root);
    assert.equal(blocked.acquired, false, "新鲜锁不得被抢");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

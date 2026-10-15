// safety-snapshot：手术式快照（覆盖触发/新增不触发/失败阻断/滚动保留）+ 恢复端点。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireExtractLock,
  createSurgicalSnapshot,
  isSafeSnapshotId,
  isSafeTrashId,
  listSurgicalSnapshots,
  pruneSurgicalSnapshots,
  restoreSurgicalSnapshot,
  rootDirOf,
  rootKeyOf,
  safetyDiskState,
  surgicalRoot,
} from "../lib/safety.js";
import { mergeIndexContent } from "../lib/manifest.js";

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-snap-"));
}

/** 造一个带 frontmatter 的记忆文件（可直接被 verifyMemoryFileContent 接受）。 */
function seedMemory(memRoot, name, body, description = "desc") {
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

// ---- 触发判据 ----

test("覆盖既有文件 → 落快照（manifest + 原文副本 + 短 sha1）", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seedMemory(memRoot, "a.md", "旧正文，共 269 个文件。");
    const snap = createSurgicalSnapshot(root, {
      originSessionId: "s-1",
      ops: [{ name: "a.md", rootKey: "memory", action: "overwrite", target: join(memRoot, "a.md") }],
    });
    // id 形态：ISO-pid（防路径穿越）
    assert.equal(isSafeSnapshotId(snap.id), true);
    assert.match(snap.id, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+$/);
    // manifest 四要素
    const meta = JSON.parse(readFileSync(snap.manifestPath, "utf8"));
    assert.equal(meta.batchId, snap.id);
    assert.equal(meta.originSessionId, "s-1");
    assert.equal(typeof meta.createdAt, "string");
    assert.equal(meta.files.length, 1);
    assert.equal(meta.files[0].name, "a.md");
    assert.equal(meta.files[0].rootKey, "memory");
    assert.equal(meta.files[0].action, "overwrite");
    // 原文副本逐字节一致
    assert.equal(readFileSync(join(snap.dir, "files", "memory", "a.md"), "utf8"), original);
    // sha1 是 8 hex 短哈希
    assert.match(meta.files[0].sha1, /^[0-9a-f]{8}$/);
    // 盘上状态可见
    const disk = safetyDiskState(root);
    assert.equal(disk.surgicalBackups, 1);
    assert.equal(disk.lastSnapshotAt, meta.createdAt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("纯新增 op 不触发快照（ops 空 = 不留空目录）", () => {
  const root = freshRoot();
  try {
    const snap = createSurgicalSnapshot(root, { originSessionId: "s-1", ops: [] });
    // 空批仍返回合法 id（调用方按需 prune），但盘上不记 surgicalBackups 之外的痕迹
    assert.equal(isSafeSnapshotId(snap.id), true);
    assert.deepEqual(snap.files, []);
    const list = listSurgicalSnapshots(root);
    assert.equal(list.length, 1);
    assert.equal(list[0].fileCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delete op 也留快照（回收站之外的第二道可逆面）", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seedMemory(memRoot, "gone.md", "将被删除的正文。");
    const snap = createSurgicalSnapshot(root, {
      originSessionId: "s-1",
      ops: [{ name: "gone.md", rootKey: "memory", action: "delete", target: join(memRoot, "gone.md") }],
    });
    assert.equal(snap.files[0].action, "delete");
    assert.equal(readFileSync(join(snap.dir, "files", "memory", "gone.md"), "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("快照失败 → 抛错（调用方 fail-closed 阻断破坏 op）", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seedMemory(memRoot, "a.md", "正文");
    // 把 surgical 根占成一个普通文件 → mkdirSync 必炸 → 整批快照失败
    mkdirSync(join(root, "backups"), { recursive: true });
    writeFileSync(surgicalRoot(root), "not a directory", "utf8");
    assert.throws(
      () => createSurgicalSnapshot(root, { originSessionId: "s-1", ops: [{ name: "a.md", rootKey: "memory", action: "overwrite", target: join(memRoot, "a.md") }] }),
      /E(EXIST|ISDIR|NOTDIR|ACCES)/,
    );
    // fail-closed：原文完好未被破坏
    assert.equal(existsSync(join(memRoot, "a.md")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("快照滚动保留 surgicalKeep（默认 30）", () => {
  const root = freshRoot();
  try {
    for (let i = 0; i < 5; i += 1) {
      createSurgicalSnapshot(root, { originSessionId: "s-1", ops: [], now: 1700000000000 + i * 1000 });
    }
    assert.equal(listSurgicalSnapshots(root).length, 5);
    assert.equal(pruneSurgicalSnapshots(root, 3), 2); // 只留最新 3 份
    const kept = listSurgicalSnapshots(root);
    assert.equal(kept.length, 3);
    // 新在前；被裁的是最旧的
    assert.equal(kept[0].id > kept[1].id, true);
    assert.equal(kept[1].id > kept[2].id, true);
    // 非法 keep（0/负数/非整数）回落默认 30：不足 30 份时一份不删
    assert.equal(pruneSurgicalSnapshots(root, 0), 0);
    assert.equal(pruneSurgicalSnapshots(root, -5), 0);
    assert.equal(listSurgicalSnapshots(root).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("非法 id 形态被 listSurgicalSnapshots 过滤（防路径穿越）", () => {
  const root = freshRoot();
  try {
    createSurgicalSnapshot(root, { originSessionId: "s-1", ops: [], now: 1700000000000 });
    mkdirSync(join(surgicalRoot(root), "..", "..", "evil"), { recursive: true }); // 根外无关目录
    mkdirSync(surgicalRoot(root), { recursive: true });
    mkdirSync(join(surgicalRoot(root), "..%2f..%2fetc"), { recursive: true }); // 穿越形态
    const list = listSurgicalSnapshots(root);
    assert.equal(list.length, 1);
    for (const item of list) assert.equal(isSafeSnapshotId(item.id), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneSurgicalSnapshots：超保留份数时删不掉不静默——warn 留痕且不虚增删除数", () => {
  const root = freshRoot();
  try {
    // 建 3 份快照，keep=1 → 应删 2
    for (let i = 0; i < 3; i += 1) {
      createSurgicalSnapshot(root, { originSessionId: "s-1", ops: [], now: 1700000000000 + i * 1000 });
    }
    // 注入 rmFn：全部拒绝（模拟占用/权限/磁盘满）→ 一份都删不掉
    const warns = [];
    const removed = pruneSurgicalSnapshots(root, 1, { warn: (m) => warns.push(m) }, { rmFn: () => { const e = new Error("EPERM: 模拟删不掉"); e.code = "EPERM"; throw e; } });
    assert.equal(removed, 0, "删不掉不得虚增删除数");
    assert.equal(warns.length, 2, "每份删不掉都必须 warn 留痕（不得静默）");
    assert.match(warns[0], /清理失败/);
    assert.equal(listSurgicalSnapshots(root).length, 3, "删不掉 → 快照原样保留");
    // 反证：正常 rmFn 下 warn 不噪声、删除数如实
    const okWarns = [];
    assert.equal(pruneSurgicalSnapshots(root, 1, { warn: (m) => okWarns.push(m) }), 2);
    assert.deepEqual(okWarns, [], "正常删除不得产生 warn 噪声");
    assert.equal(listSurgicalSnapshots(root).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 恢复端点 ----

test("快照恢复整包 → 原文回拷 + MEMORY.md 索引对账", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seedMemory(memRoot, "a.md", "旧正文。", "旧钩子");
    const snap = createSurgicalSnapshot(root, {
      originSessionId: "s-1",
      ops: [{ name: "a.md", rootKey: "memory", action: "overwrite", target: join(memRoot, "a.md") }],
    });
    // 模拟错误覆盖
    writeFileSync(join(memRoot, "a.md"), "被模型写坏的内容", "utf8");
    writeFileSync(join(memRoot, "MEMORY.md"), mergeIndexContent("", [], []), "utf8");
    const out = restoreSurgicalSnapshot(root, snap.id);
    assert.deepEqual(out.restored, ["a.md"]);
    assert.equal(out.indexReconciled, true);
    assert.equal(readFileSync(join(memRoot, "a.md"), "utf8"), original);
    assert.match(readFileSync(join(memRoot, "MEMORY.md"), "utf8"), /- \[a\]\(a\.md\) — 旧钩子/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("快照恢复指定 name（只回该条）+ name 未过闸即拒", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seedMemory(memRoot, "a.md", "A 正文");
    seedMemory(memRoot, "b.md", "B 正文");
    const snap = createSurgicalSnapshot(root, {
      originSessionId: "s-1",
      ops: [
        { name: "a.md", rootKey: "memory", action: "overwrite", target: join(memRoot, "a.md") },
        { name: "b.md", rootKey: "memory", action: "overwrite", target: join(memRoot, "b.md") },
      ],
    });
    rmSync(join(memRoot, "a.md"));
    rmSync(join(memRoot, "b.md")); // 同批两条都被删，只回点名的那条
    const out = restoreSurgicalSnapshot(root, snap.id, { name: "a.md" });
    assert.deepEqual(out.restored, ["a.md"]);
    assert.equal(existsSync(join(memRoot, "a.md")), true);
    assert.equal(existsSync(join(memRoot, "b.md")), false); // 未点名不回
    // 整包恢复才回 b.md
    const full = restoreSurgicalSnapshot(root, snap.id);
    assert.deepEqual(full.restored.sort(), ["a.md", "b.md"]);
    // 非法 name / 非法 id → 显式抛错（不静默）
    assert.throws(() => restoreSurgicalSnapshot(root, snap.id, { name: "../evil.md" }), /未通过安全闸/);
    assert.throws(() => restoreSurgicalSnapshot(root, "../../etc"), /非法快照 id/);
    assert.throws(() => restoreSurgicalSnapshot(root, "2099-01-01T00-00-00-000Z-1"), /不存在或 manifest 损坏/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("meta 是盘上数据不信任——rootKey 越界/name 非法条目被跳过", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seedMemory(memRoot, "a.md", "正文");
    const snap = createSurgicalSnapshot(root, {
      originSessionId: "s-1",
      ops: [{ name: "a.md", rootKey: "memory", action: "overwrite", target: join(memRoot, "a.md") }],
    });
    // 手工篡改 manifest：塞越界 rootKey 与非法 name
    const meta = JSON.parse(readFileSync(snap.manifestPath, "utf8"));
    meta.files.push({ name: "../../escape.md", rootKey: "memory", sha1: "", action: "overwrite" });
    meta.files.push({ name: "ok.md", rootKey: "../../..", sha1: "", action: "overwrite" });
    writeFileSync(snap.manifestPath, JSON.stringify(meta, null, 2), "utf8");
    const warns = [];
    const out = restoreSurgicalSnapshot(root, snap.id, { log: { warn: (m) => warns.push(m) } });
    assert.deepEqual(out.restored, ["a.md"]); // 只回合法条目
    assert.equal(warns.length, 2); // 两条各一条 warn
    assert.equal(existsSync(join(root, "..", "escape.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- rootKey 路由 ----

test("rootKey：同根为 ''，子目录为相对路径，越界/黑名单段返回 null", () => {
  const root = freshRoot();
  try {
    assert.equal(rootKeyOf(root, root), "");
    assert.equal(rootKeyOf(root, join(root, "memory")), "memory");
    assert.equal(rootKeyOf(root, join(root, "global", "long-term")), "global/long-term");
    assert.equal(rootDirOf(root, ""), root);
    assert.equal(rootDirOf(root, "memory"), join(root, "memory"));
    // 越界与黑名单段
    assert.equal(rootDirOf(root, "../evil"), null);
    assert.equal(rootDirOf(root, "a/b/c/d/e/f/g"), null); // 段数 >6
    assert.equal(rootDirOf(root, ".git/hooks"), null); // 黑名单段
    assert.equal(rootDirOf(root, "memory/../../etc"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 提取批互斥锁 ----

test("extract.lock：wx 原子占锁；被占时第二次不得 acquired；释放后可再抢", () => {
  const root = freshRoot();
  try {
    const first = acquireExtractLock(root);
    assert.equal(first.acquired, true);
    assert.equal(existsSync(join(root, "extract.lock")), true);
    const meta = JSON.parse(readFileSync(join(root, "extract.lock"), "utf8"));
    assert.equal(meta.pid, process.pid);
    assert.equal(typeof meta.at, "number");
    assert.equal(typeof meta.token, "string");
    const second = acquireExtractLock(root); // 未 stale → 抢不到
    assert.equal(second.acquired, false);
    first.release();
    assert.equal(existsSync(join(root, "extract.lock")), false);
    const third = acquireExtractLock(root);
    assert.equal(third.acquired, true);
    third.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extract.lock：stale 30s 可抢；损坏锁文件按最旧处理", () => {
  const root = freshRoot();
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "extract.lock"), JSON.stringify({ pid: 999999, at: Date.now() - 60_000, token: "dead" }) + "\n", "utf8");
    const stolen = acquireExtractLock(root);
    assert.equal(stolen.acquired, true);
    assert.equal(stolen.stolen, true);
    stolen.release();
    // 损坏内容 → 按最旧处理（可抢）
    writeFileSync(join(root, "extract.lock"), "garbage-not-json", "utf8");
    const after = acquireExtractLock(root);
    assert.equal(after.acquired, true);
    after.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extract.lock：release 不误删他人重抢到的锁（token 比对）", () => {
  const root = freshRoot();
  try {
    const mine = acquireExtractLock(root);
    const token = JSON.parse(readFileSync(join(root, "extract.lock"), "utf8")).token;
    // 模拟：我的锁 stale 后被别人重抢（token 换了）
    writeFileSync(join(root, "extract.lock"), JSON.stringify({ pid: 4242, at: Date.now(), token: "someone-else" }) + "\n", "utf8");
    mine.release(); // 绝不能拆掉新主的锁
    assert.equal(existsSync(join(root, "extract.lock")), true);
    assert.equal(JSON.parse(readFileSync(join(root, "extract.lock"), "utf8")).token, "someone-else");
    assert.notEqual(token, "someone-else");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trashId 形态校验（与 snapshot id 同源的防穿越判据）", () => {
  assert.equal(isSafeTrashId("2026-10-14T15-14-43-528Z"), true);
  assert.equal(isSafeTrashId("2026-10-14T15-14-43-528Z-3"), true);
  assert.equal(isSafeTrashId("../../etc"), false);
  assert.equal(isSafeTrashId("..%2f..%2fetc"), false);
  assert.equal(isSafeSnapshotId("2026-10-14T15-14-43-487Z-5892"), true);
  assert.equal(isSafeSnapshotId("2026-10-14T15-14-43-487Z"), false); // 缺 pid 段
  assert.equal(isSafeSnapshotId(".."), false);
});

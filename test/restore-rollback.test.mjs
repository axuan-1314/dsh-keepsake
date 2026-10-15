// restoreBackup 回滚健壮性（数据保全回归）：
//   projects/ 与 global/ 两阶段换入任一步中途失败时，恢复前的数据绝不丢失——
//   要么就地回滚回本体，要么完整保留在 retired-* 里并由错误消息点名告知；
//   外层 catch 只清 staging，绝不删除任何 retired-* 目录（那是用户的原始数据）。
// copyFn / renameFn 两个注入点用于跨平台确定性复现「拷贝/换入中途失败」。
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { createBackup, createEntry, listEntries, restoreBackup, sweepTmpOrphans } from "../lib/global-store.js";

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-restore-rollback-"));
}

/** 目录内容快照（相对路径 → 文本），用于比对「恢复前数据完好无损」 */
function snapshot(dir) {
  const out = {};
  const walk = (cur, rel) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, ent.name);
      const key = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(full, key);
      else out[key] = readFileSync(full, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return out;
}

function sameTree(dir, snap) {
  return existsSync(dir) && JSON.stringify(snapshot(dir)) === JSON.stringify(snap);
}

/** 现场遗留的 staging/retired 目录（staging 是拷贝中转残留，retired-* 是抢救副本） */
function leftovers(root) {
  return readdirSync(root).filter((n) => /^(global|projects)\.(staging|retired)-/.test(n));
}

/** 造一份含两条项目记忆 + 一条全局记忆 + settings 的全量备份，返回 backupId */
function makeBackup(root) {
  mkdirSync(join(root, "projects", "proj-a", "memory"), { recursive: true });
  writeFileSync(join(root, "projects", "proj-a", "memory", "one.md"), "备份项目A", "utf8");
  writeFileSync(join(root, "projects", "proj-a", "MEMORY.md"), "idx-a", "utf8");
  mkdirSync(join(root, "projects", "proj-b", "memory"), { recursive: true });
  writeFileSync(join(root, "projects", "proj-b", "memory", "two.md"), "备份项目B", "utf8");
  createEntry(root, "long-term", { title: "备份全局", content: "备份时点的全局记忆" });
  writeFileSync(join(root, "settings.json"), JSON.stringify({ theme: "backup" }), "utf8");
  return createBackup(root, "manual");
}

/** 备份之后改写现网（projects/global/settings 三处都动），返回恢复前快照 */
function mutateLive(root) {
  const pRoot = join(root, "projects");
  rmSync(pRoot, { recursive: true, force: true });
  mkdirSync(join(pRoot, "proj-live", "memory"), { recursive: true });
  writeFileSync(join(pRoot, "proj-live", "memory", "live.md"), "现网项目记忆-勿丢", "utf8");
  writeFileSync(join(pRoot, "proj-live", "MEMORY.md"), "live-index", "utf8");
  createEntry(root, "long-term", { title: "现网全局", content: "恢复前的全局记忆" });
  writeFileSync(join(root, "settings.json"), JSON.stringify({ theme: "live" }), "utf8");
  return { projects: snapshot(pRoot), global: snapshot(join(root, "global")) };
}

/** 断言「恢复到备份时点」：projects/global/settings 都回到备份内容 */
function assertAtBackupPoint(root) {
  assert.equal(readFileSync(join(root, "projects", "proj-a", "memory", "one.md"), "utf8"), "备份项目A");
  assert.equal(readFileSync(join(root, "projects", "proj-b", "memory", "two.md"), "utf8"), "备份项目B");
  assert.equal(existsSync(join(root, "projects", "proj-live")), false, "现网项目目录应被备份内容覆盖");
  assert.equal(readFileSync(join(root, "settings.json"), "utf8"), JSON.stringify({ theme: "backup" }));
  assert.deepEqual(listEntries(root, "long-term").map((e) => e.title), ["备份全局"], "global 应恢复到备份时点");
}

/** 断言的合法终态二选一：就地回滚进本体，或完整留在某个 retired-* 里（本体不得有半成品） */
function assertLiveIntact(dir, snap, prefix) {
  if (sameTree(dir, snap)) return "rolled-back";
  assert.equal(existsSync(dir), false, "未就地回滚时本体不得残留半成品");
  return "rescued";
}

// ---- 成功路径：行为与现状完全一致 ----

test("restoreBackup：成功路径行为不变（projects 恢复成功、retired/staging 全清）", () => {
  const root = freshRoot();
  try {
    const backupId = makeBackup(root);
    mutateLive(root);
    // 不带 options（默认走 fs 原生 cpSync/renameSync）
    assert.equal(restoreBackup(root, backupId), true);
    assertAtBackupPoint(root);
    assert.deepEqual(leftovers(root), [], "成功路径不得遗留 staging/retired 目录");

    // 再恢复一次，这次显式注入默认实现：seam 不得改变成功路径行为
    mutateLive(root);
    assert.equal(restoreBackup(root, backupId, { copyFn: cpSync, renameFn: renameSync }), true);
    assertAtBackupPoint(root);
    assert.deepEqual(leftovers(root), [], "显式默认 seam 的成功路径同样不得遗留目录");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- projects 段：拷贝中途失败（拷贝只发生在 staging，本体绝不被碰） ----

test("restoreBackup：projects 拷贝中途失败 → 本体未被换动，恢复前项目记忆完好且无好副本被删", () => {
  const root = freshRoot();
  try {
    const backupId = makeBackup(root);
    const live = mutateLive(root);
    const stagingPrefix = join(root, "projects.staging-");
    // 拷一半再抛错：备份 projects 的拷贝目标是 staging 目录（不是本体）——只拷第一个条目就中断
    const copyFn = (src, dest, opts) => {
      if (!String(dest).startsWith(stagingPrefix)) return cpSync(src, dest, opts);
      const entries = readdirSync(src, { withFileTypes: true });
      assert.ok(entries.length >= 2, "备份 projects 至少两个目录才能模拟「拷一半」");
      mkdirSync(dest, { recursive: true });
      cpSync(join(src, entries[0].name), join(dest, entries[0].name), { recursive: true });
      throw new Error("模拟拷贝中途失败");
    };
    let thrown = null;
    assert.throws(() => restoreBackup(root, backupId, { copyFn }), (err) => {
      thrown = err;
      assert.equal(err.code, "RESTORE_FAILED");
      assert.match(err.message, /恢复失败/);
      return true;
    });
    // 拷贝失败只污染 staging：projects/ 本体从未被改名换动，逐字节完好
    assert.equal(sameTree(join(root, "projects"), live.projects), true, "projects/ 必须完整保留恢复前内容");
    // staging 是拷贝中转，失败后被清；没有 retired 副本可保留
    assert.deepEqual(leftovers(root), [], "回滚成功后不得遗留 staging/retired 目录");
    // 消息如实：没有 retired 副本可保留，就不许谎称「已保留」
    assert.doesNotMatch(thrown.message, /已保留/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreBackup：projects 换入 rename 失败且回滚也失败 → retired 副本保留并被错误点名，外层不删", () => {
  const root = freshRoot();
  try {
    const backupId = makeBackup(root);
    const live = mutateLive(root);
    const pRoot = join(root, "projects");
    // 拷贝进 staging 照常；以 projects/ 为目标的 rename（换入与回滚）都失败
    const renameFn = (src, dst) => {
      if (dst === pRoot) throw new Error("EPERM: 模拟换入与回滚 rename 均失败");
      return renameSync(src, dst);
    };
    let thrown = null;
    assert.throws(() => restoreBackup(root, backupId, { renameFn }), (err) => {
      thrown = err;
      assert.equal(err.code, "RESTORE_FAILED");
      return true;
    });
    const rescues = readdirSync(root).filter((n) => n.startsWith("projects.retired-"));
    assert.equal(rescues.length, 1, "回滚 rename 失败时必须保留唯一的 projects.retired-* 好副本");
    assert.ok(sameTree(join(root, rescues[0]), live.projects), "retired 副本内容必须与恢复前一致");
    assert.equal(existsSync(pRoot), false, "projects/ 本体不得残留半成品");
    assert.deepEqual(leftovers(root), rescues, "只允许遗留 retired 抢救副本，staging 必须清掉");
    assert.ok(thrown.message.includes(rescues[0]), "错误消息必须点名保留目录");
    assert.match(thrown.message, /切勿删除/);
    assert.match(thrown.message, /已保留/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 退役副本清理中断：绝不回滚（否则会把删残的副本换回本体），消息如实 ----

test("restoreBackup：退役副本清理中途失败 → 绝不回滚删数据，后续失败时消息如实称「完整性未确认」", () => {
  const root = freshRoot();
  try {
    const backupId = makeBackup(root);
    const live = mutateLive(root);
    const stagingPrefix = join(root, "projects.staging-");
    // 注入 rmFn：清理 global.retired-* 时先删一个子项再抛错（模拟 Windows 递归 rm 删一半 EPERM）
    const rmFn = (target, opts) => {
      if (String(target).includes("global.retired-")) {
        const children = readdirSync(target);
        if (children.length > 0) rmSync(join(target, children[0]), { recursive: true, force: true });
        throw new Error("EPERM: 模拟清理中途失败");
      }
      return rmSync(target, opts);
    };
    // 令 projects 换入的拷贝失败，逼外层 catch 走「失败保全」消息分支
    const copyFn = (src, dest, opts) => {
      if (String(dest).startsWith(stagingPrefix)) throw new Error("模拟拷贝中途失败");
      return cpSync(src, dest, opts);
    };
    let thrown = null;
    assert.throws(() => restoreBackup(root, backupId, { copyFn, rmFn, log: { warn: () => {} } }), (err) => {
      thrown = err;
      assert.equal(err.code, "RESTORE_FAILED");
      return true;
    });
    // P0 关键不变量：清理失败不得触发回滚——global/ 本体是已换入的备份内容，未被删；
    // 抢救副本仍在（清理未完成），恢复前数据不因这条清理异常而丢。
    assert.deepEqual(listEntries(root, "long-term").map((e) => e.title), ["备份全局"], "global/ 本体应为恢复后的备份内容");
    const rescues = readdirSync(root).filter((n) => n.startsWith("global.retired-"));
    assert.equal(rescues.length, 1, "清理失败的退役副本必须保留在盘上（未被回滚删掉）");
    // 消息如实：清理中断/完整性未确认，绝不谎称「已保留」
    assert.match(thrown.message, /清理中断|完整性未确认/);
    assert.doesNotMatch(thrown.message, /已保留/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- global 段：换入失败 / 回滚失败（与 projects 同构的风险面） ----

test("restoreBackup：global 换入 rename 失败且留下半成品 → 回滚后 global/ 恢复原样", () => {
  const root = freshRoot();
  try {
    const backupId = makeBackup(root);
    const live = mutateLive(root);
    const gRoot = join(root, "global");
    const renameFn = (src, dst) => {
      if (dst === gRoot && basename(src).startsWith("global.staging-")) {
        // 复现 Windows 形态：rename 报错但目标位置已留下半成品目录
        mkdirSync(gRoot, { recursive: true });
        writeFileSync(join(gRoot, "half-done.md"), "半成品", "utf8");
        throw new Error("EPERM: 模拟换入 rename 失败");
      }
      return renameSync(src, dst);
    };
    assert.throws(() => restoreBackup(root, backupId, { renameFn }), (err) => {
      assert.equal(err.code, "RESTORE_FAILED");
      return true;
    });
    assert.ok(sameTree(gRoot, live.global), "global/ 必须完整回到恢复前内容（半成品被清、retired 被 rename 回来）");
    assert.deepEqual(leftovers(root), [], "回滚成功后不得遗留 staging/retired 目录");
    assert.ok(sameTree(join(root, "projects"), live.projects), "global 段失败不应波及以上一步的 projects/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreBackup：global 换入 rename 干净失败 → 回滚照常成功", () => {
  const root = freshRoot();
  try {
    const backupId = makeBackup(root);
    const live = mutateLive(root);
    const gRoot = join(root, "global");
    const renameFn = (src, dst) => {
      if (dst === gRoot && basename(src).startsWith("global.staging-")) throw new Error("ENOENT: 模拟换入 rename 失败");
      return renameSync(src, dst);
    };
    assert.throws(() => restoreBackup(root, backupId, { renameFn }), (err) => {
      assert.equal(err.code, "RESTORE_FAILED");
      return true;
    });
    assert.ok(sameTree(gRoot, live.global), "无半成品时回滚 rename 应直接成功");
    assert.deepEqual(leftovers(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreBackup：global 回滚 rename 也失败 → retired 保留并被错误点名，外层不删", () => {
  const root = freshRoot();
  try {
    const backupId = makeBackup(root);
    const live = mutateLive(root);
    const gRoot = join(root, "global");
    // 换入与回滚都以 global/ 为 rename 目标，一律失败（换出目标是 retired，放开）
    const renameFn = (src, dst) => {
      if (dst === gRoot) throw new Error("EPERM: 模拟换入与回滚 rename 均失败");
      return renameSync(src, dst);
    };
    let thrown = null;
    assert.throws(() => restoreBackup(root, backupId, { renameFn }), (err) => {
      thrown = err;
      assert.equal(err.code, "RESTORE_FAILED");
      return true;
    });
    const rescues = readdirSync(root).filter((n) => n.startsWith("global.retired-"));
    assert.equal(rescues.length, 1, "回滚 rename 失败时必须保留唯一的 global.retired-* 好副本");
    assert.ok(sameTree(join(root, rescues[0]), live.global), "retired 副本内容必须与恢复前一致");
    assert.equal(existsSync(gRoot), false, "global/ 本体不得残留半成品");
    assert.deepEqual(leftovers(root), rescues, "只允许遗留 retired 抢救副本，staging 必须清掉");
    assert.ok(thrown.message.includes(rescues[0]), "错误消息必须点名保留目录");
    assert.match(thrown.message, /切勿删除/);
    assert.equal(thrown.cause?.message, "EPERM: 模拟换入与回滚 rename 均失败", "cause 应保留原始失败原因");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 遗留清扫：staging-* 是拷贝中转（可清），retired-* 是抢救副本（绝不自动删） ----
//
// 背景：恢复失败时 global/→retired 的 rename 会继承旧 mtime，父目录 mtime 也长期不刷新，
// 按 mtime 判会把刚留下的抢救副本误判成「已超 1 小时」而删掉——与错误消息「切勿删除」矛盾。
// 扫尾纪律：retired-* 携带恢复前数据（最后一份），任何自动清扫都不得删除——无论多旧。

test("sweepTmpOrphans：mtime 很旧但名字时间戳新鲜的 retired-* 抢救副本不被误删", () => {
  const root = freshRoot();
  try {
    const fresh = join(root, `global.retired-${process.pid}-${Date.now()}`);
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, "persona.md"), "抢救副本-勿删", "utf8");
    // 制造陷阱：目录与内容 mtime 都改到 3 小时前（rename 继承旧 mtime 的现场）
    const old = Date.now() - 3 * 3_600_000;
    utimesSync(fresh, old / 1000, old / 1000);
    const removed = sweepTmpOrphans(root);
    assert.equal(removed, 0, "抢救副本一律不清");
    assert.equal(existsSync(fresh), true, "刚留下的抢救副本不得被启动清扫删掉");
    assert.equal(readFileSync(join(fresh, "persona.md"), "utf8"), "抢救副本-勿删");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweepTmpOrphans：名字时间戳超 1 小时的 retired-* 同样保留（抢救副本绝不自动删）", () => {
  const root = freshRoot();
  try {
    const stale = join(root, `projects.retired-1-${Date.now() - 3_600_001}`);
    mkdirSync(join(stale, "proj-live"), { recursive: true });
    writeFileSync(join(stale, "proj-live", "live.md"), "旧抢救副本", "utf8");
    const removed = sweepTmpOrphans(root);
    assert.equal(removed, 0, "retired-* 一律不清，无论多旧");
    assert.equal(existsSync(stale), true, "名字时间戳超 1 小时的 retired-* 也必须保留（那是恢复前数据最后一份）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweepTmpOrphans：名字解析不出时间戳的 retired-* 保守保留（宁可留垃圾不可删抢救材料）", () => {
  const root = freshRoot();
  try {
    const unparseable = join(root, "global.retired-nostamp");
    mkdirSync(unparseable, { recursive: true });
    writeFileSync(join(unparseable, "persona.md"), "无时间戳的抢救副本", "utf8");
    const old = Date.now() - 6 * 3_600_000;
    utimesSync(unparseable, old / 1000, old / 1000); // 即便 mtime 也老，仍不清
    const removed = sweepTmpOrphans(root);
    assert.equal(removed, 0);
    assert.equal(existsSync(unparseable), true, "解析不出时间戳的 retired-* 一律不清");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweepTmpOrphans：staging-*（拷贝中转、新建目录）维持 mtime 判法；.tmp-* 孤儿照清", () => {
  const root = freshRoot();
  try {
    const freshStaging = join(root, `global.staging-${process.pid}-${Date.now()}`);
    mkdirSync(freshStaging, { recursive: true });
    const freshStagingP = join(root, `projects.staging-${process.pid}-${Date.now()}`);
    mkdirSync(freshStagingP, { recursive: true });
    const staleStaging = join(root, `global.staging-1-${Date.now()}`);
    mkdirSync(staleStaging, { recursive: true });
    const old = Date.now() - 3 * 3_600_000;
    utimesSync(staleStaging, old / 1000, old / 1000);
    // 顺带一个 .tmp-* 孤儿（writeAtomic 中断残留）
    mkdirSync(join(root, "global", "long-term"), { recursive: true });
    writeFileSync(join(root, "global", "long-term", "x.md.tmp-1-1"), "半截", "utf8");
    const removed = sweepTmpOrphans(root);
    assert.equal(removed, 2, "mtime 超 1 小时的 staging-* + .tmp-* 孤儿");
    assert.equal(existsSync(freshStaging), true, "在途 staging（mtime 新鲜）不清");
    assert.equal(existsSync(freshStagingP), true, "在途 projects.staging（mtime 新鲜）不清");
    assert.equal(existsSync(staleStaging), false, "mtime 超 1 小时的 staging-* 被清扫");
    assert.equal(existsSync(join(root, "global", "long-term", "x.md.tmp-1-1")), false, ".tmp-* 孤儿被清扫");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

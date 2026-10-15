// global-snapshot：全局记忆落盘的批前快照与滚动保留（与 project 侧同纪律）。
//   (a) 覆盖既有全局条目 → 批前留档一份、旧文可从快照找回、写成功；
//   (b) 快照建档失败 → 覆盖既有被阻断、纯新增 write 与 delete 照常；
//   (c) 无既有文件的纯新增 write 不产生快照；
//   (d) 全局破坏性批后 prune 被触发（surgicalKeep=1 连写两批滚动）；
//   (e) 同批同名双写：第二个写前发现目标已建出 → fail-closed 跳过（不顶掉第一个）。
// 约定：只用临时 storageRoot/projectRoot（os.tmpdir 下自建），绝不读写 ~/.dsh/memory。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyScopedOps, __resetSafetyCountersForTest, safetyCounterSnapshot } from "../lib/extract.js";
import { createEntry, readEntry } from "../lib/global-store.js";
import { acquireExtractLock, listSurgicalSnapshots, surgicalRoot } from "../lib/safety.js";

function freshRoots() {
  const storageRoot = mkdtempSync(join(tmpdir(), "dsh-keepsake-gsnap-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "dsh-keepsake-gsnap-proj-"));
  return { storageRoot, projectRoot };
}
const silentLog = { warn: () => {}, error: () => {} };
const collecting = () => {
  const warns = [];
  return { log: { warn: (m) => warns.push(String(m)), error: () => {} }, warns };
};

/** 全局条目原始盘上文本（含 frontmatter）——快照里应逐字节找回它。 */
function rawGlobal(storageRoot, categoryId, name) {
  return readFileSync(join(storageRoot, "global", categoryId, name), "utf8");
}

// ---- (a) 覆盖既有 → 留档 + 可找回 + 写成功 ----

test("global 覆盖既有条目：批前留档一份、旧文可从快照找回、写成功", () => {
  __resetSafetyCountersForTest();
  const { storageRoot, projectRoot } = freshRoots();
  try {
    createEntry(storageRoot, "long-term", { title: "旧条目", description: "旧钩子", content: "旧正文，必须留档。", name: "fact.md" });
    const before = rawGlobal(storageRoot, "long-term", "fact.md");
    assert.equal(listSurgicalSnapshots(storageRoot).length, 0, "批前不应有快照");

    const result = applyScopedOps({ storageRoot, projectRoot }, [
      { action: "write", name: "fact.md", title: "新条目", description: "新钩子", content: "新正文。", scope: "global:long-term" },
    ], { originSessionId: "s-1", log: silentLog });

    assert.equal(result.writes, 1, "覆盖应成功");
    assert.notEqual(result.snapshotId, null, "覆盖既有必须留档");
    // 快照目录多一份
    const snaps = listSurgicalSnapshots(storageRoot);
    assert.equal(snaps.length, 1);
    // 旧文从快照文件里逐字节找回（rootKey = global/long-term）
    const copyPath = join(surgicalRoot(storageRoot), snaps[0].id, "files", "global", "long-term", "fact.md");
    assert.equal(existsSync(copyPath), true, "快照副本必须在案");
    assert.equal(readFileSync(copyPath, "utf8"), before, "快照里的旧文必须逐字节一致");
    // 盘上已是新内容
    assert.match(rawGlobal(storageRoot, "long-term", "fact.md"), /新正文。/);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---- (b) 快照建档失败 → 覆盖被阻断，纯新增 write 与 delete 照常 ----

test("global 快照失败：覆盖既有被阻断、纯新增 write 与 delete 照常", () => {
  __resetSafetyCountersForTest();
  const { storageRoot, projectRoot } = freshRoots();
  try {
    createEntry(storageRoot, "long-term", { title: "旧条目", description: "旧钩子", content: "旧正文，不能被改。", name: "keep.md" });
    createEntry(storageRoot, "long-term", { title: "待删", description: "d", content: "待删正文。", name: "gone.md" });
    const keepBefore = rawGlobal(storageRoot, "long-term", "keep.md");
    // 令快照必然失败：backups/surgical 占成普通文件（mkdir 递归建不进来）
    mkdirSync(join(storageRoot, "backups"), { recursive: true });
    writeFileSync(join(storageRoot, "backups", "surgical"), "not a dir", "utf8");
    const { log, warns } = collecting();

    const result = applyScopedOps({ storageRoot, projectRoot }, [
      { action: "write", name: "keep.md", title: "新条目", description: "新钩子", content: "新正文。", scope: "global:long-term" },
      { action: "write", name: "brand-new.md", title: "纯新增", description: "d", content: "全新正文。", scope: "global:long-term" },
      { action: "delete", name: "gone.md", scope: "global:long-term" },
    ], { originSessionId: "s-1", log });

    // 覆盖既有的那条被阻断：盘上旧文分毫不差
    assert.equal(readFileSync(join(storageRoot, "global", "long-term", "keep.md"), "utf8"), keepBefore, "旧文必须逐字节不变");
    // 纯新增照常落盘
    assert.equal(existsSync(join(storageRoot, "global", "long-term", "brand-new.md")), true, "纯新增必须照常落盘");
    // delete 照常（移入回收站 → 原件不在）
    assert.equal(existsSync(join(storageRoot, "global", "long-term", "gone.md")), false, "delete 必须照常生效");
    // 计数透出：快照失败 + 被阻 op
    assert.ok(result.snapshotFailures >= 1, "snapshotFailures 必须计数");
    assert.ok(result.blockedDestructiveOps >= 1, "blockedDestructiveOps 必须计数");
    assert.ok(safetyCounterSnapshot().snapshotFailures >= 1, "进程内 snapshotFailures 计数必须 bump");
    assert.equal(warns.some((w) => w.includes("快照失败")), true, "必须 warn 留痕");
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---- (c) 纯新增不产生快照 ----

test("global 纯新增 write：不产生任何快照（无旧文可失）", () => {
  __resetSafetyCountersForTest();
  const { storageRoot, projectRoot } = freshRoots();
  try {
    const result = applyScopedOps({ storageRoot, projectRoot }, [
      { action: "write", name: "fresh.md", title: "纯新增", description: "d", content: "全新正文。", scope: "global:long-term" },
    ], { originSessionId: "s-1", log: silentLog });
    assert.equal(result.writes, 1);
    assert.equal(result.snapshotId, null, "纯新增不应触发快照");
    assert.equal(listSurgicalSnapshots(storageRoot).length, 0);
    assert.equal(existsSync(surgicalRoot(storageRoot)), false, "不应建快照目录");
    assert.equal(readEntry(storageRoot, "long-term", "fresh.md").content, "全新正文。");
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---- (e) 同批同名双写：预扫都判纯新增，第二个写前发现目标已建出 → fail-closed 跳过 ----

test("global 同批同名双写：第二个写前发现已建出被跳过，盘上留第一个的内容", () => {
  __resetSafetyCountersForTest();
  const { storageRoot, projectRoot } = freshRoots();
  try {
    const { log, warns } = collecting();
    // 两个 op 同名、预扫时都不存在（都判纯新增）；第一个落盘后，第二个的目标才出现——
    // 若无写前检查，第二个会当纯新增直通覆盖、静默顶掉第一个的内容。
    const result = applyScopedOps({ storageRoot, projectRoot }, [
      { action: "write", name: "dup.md", title: "一", description: "d", content: "第一个正文。", scope: "global:long-term" },
      { action: "write", name: "dup.md", title: "二", description: "d", content: "第二个正文。", scope: "global:long-term" },
    ], { originSessionId: "s-1", log });

    assert.equal(result.writes, 1, "只有第一个落盘");
    assert.equal(result.skipped, 1, "第二个必须被跳过");
    assert.equal(result.blockedDestructiveOps, 1, "跳过必须计入 blockedDestructiveOps");
    // 盘上是第一个的内容，第二个没顶掉它
    assert.match(rawGlobal(storageRoot, "long-term", "dup.md"), /第一个正文。/);
    assert.doesNotMatch(rawGlobal(storageRoot, "long-term", "dup.md"), /第二个正文。/);
    assert.equal(readEntry(storageRoot, "long-term", "dup.md").content, "第一个正文。");
    // 纯新增批不产生快照；warn 留痕说明写前发现已被建出
    assert.equal(result.snapshotId, null, "纯新增批不应触发快照");
    assert.equal(warns.some((w) => w.includes("写前") && w.includes("dup.md")), true, "必须 warn 留痕");
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---- (d) 破坏性批后 prune 被触发（滚动保留）----

test("global 破坏性批后 prune：surgicalKeep=1 连写两批只留最新一份快照", () => {
  __resetSafetyCountersForTest();
  const { storageRoot, projectRoot } = freshRoots();
  try {
    const settings = { surgicalKeep: 1 };
    createEntry(storageRoot, "long-term", { title: "条目", description: "d", content: "第一代正文。", name: "roll.md" });

    // 批一：覆盖既有 → 建快照 A，prune 保留 1
    applyScopedOps({ storageRoot, projectRoot }, [
      { action: "write", name: "roll.md", title: "条目", description: "d", content: "第二代正文。", scope: "global:long-term" },
    ], { originSessionId: "s-1", settings, log: silentLog });
    assert.equal(listSurgicalSnapshots(storageRoot).length, 1, "批一后应只留一份");

    // 批二：再覆盖 → 建快照 B，prune 把 A 滚掉
    applyScopedOps({ storageRoot, projectRoot }, [
      { action: "write", name: "roll.md", title: "条目", description: "d", content: "第三代正文。", scope: "global:long-term" },
    ], { originSessionId: "s-2", settings, log: silentLog });
    assert.equal(listSurgicalSnapshots(storageRoot).length, 1, "批二后 prune 必须把旧快照滚掉（仍是 1 份）");
    // 留下的应是最新一份（批二那份含第二代正文）
    const snaps = listSurgicalSnapshots(storageRoot);
    assert.match(readFileSync(join(surgicalRoot(storageRoot), snaps[0].id, "files", "global", "long-term", "roll.md"), "utf8"), /第二代正文。/);
    assert.match(rawGlobal(storageRoot, "long-term", "roll.md"), /第三代正文。/);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---- (f) 锁被占（本批破坏性 op 全阻断）→ 不建快照、不 prune（不白耗保留配额、不误逐真 pre-image）----

test("global 锁被占：破坏性批全阻断，既不建快照也不 roll 掉上一批的真 pre-image", () => {
  __resetSafetyCountersForTest();
  const { storageRoot, projectRoot } = freshRoots();
  try {
    const settings = { surgicalKeep: 1 };
    createEntry(storageRoot, "long-term", { title: "条目", description: "d", content: "第一代正文。", name: "roll.md" });

    // 批一（无锁）：覆盖既有 → 建快照，prune 保留 1；快照里是真正的 pre-image（第一代）
    applyScopedOps({ storageRoot, projectRoot }, [
      { action: "write", name: "roll.md", title: "条目", description: "d", content: "第二代正文。", scope: "global:long-term" },
    ], { originSessionId: "s-1", settings, log: silentLog });
    const afterFirst = listSurgicalSnapshots(storageRoot);
    assert.equal(afterFirst.length, 1, "批一后应有一份 pre-image 快照");
    const preImageId = afterFirst[0].id;

    // 本进程占住提取批锁：下一批的破坏性 op 会被全部阻断（一个都不执行）
    const held = acquireExtractLock(storageRoot);
    assert.equal(held.acquired, true);
    try {
      const result = applyScopedOps({ storageRoot, projectRoot }, [
        { action: "write", name: "roll.md", title: "条目", description: "d", content: "第三代正文。", scope: "global:long-term" },
      ], { originSessionId: "s-2", settings, log: silentLog });
      assert.equal(result.locked, true);
      assert.equal(result.writes, 0, "锁被占时覆盖既有必须被阻断");
      assert.equal(result.snapshotId, null, "全阻断批不得建快照（无 op 会执行）");
    } finally {
      held.release();
    }
    // 关键回归：上一批的真 pre-image 快照仍在（未被执行 0 次破坏的批白耗配额 + prune 误逐）
    const afterSecond = listSurgicalSnapshots(storageRoot);
    assert.deepEqual(afterSecond.map((s) => s.id), [preImageId], "上一批真 pre-image 快照必须原样保留");
    assert.match(readFileSync(join(surgicalRoot(storageRoot), preImageId, "files", "global", "long-term", "roll.md"), "utf8"), /第一代正文。/, "保留的必须是真 pre-image");
    // 本体也未被改动
    assert.match(rawGlobal(storageRoot, "long-term", "roll.md"), /第二代正文。/);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

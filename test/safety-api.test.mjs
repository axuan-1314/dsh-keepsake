// safety-api：v0.4.0 五个写入安全面端点的契约（字段名一字不改）。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { API_PREFIX, makeApiRoutes } from "../lib/api.js";
import { BACKUP_KEEP, backupsRoot, createBackup, createEntry, listBackups, listEntries } from "../lib/global-store.js";
import { applyOps } from "../lib/extract.js";
import { acquireExtractLock, sha1Short } from "../lib/safety.js";

const silentLog = { info() {}, warn() {}, error() {} };
function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-safetyapi-"));
}
function mockReq({ method, url, body, headers = {}, remoteAddress = "127.0.0.1" }) {
  const req = new Readable({ read() { if (body !== void 0) this.push(typeof body === "string" ? body : JSON.stringify(body)); this.push(null); } });
  req.method = method; req.url = url; req.destroy = () => {};
  req.headers = { host: "127.0.0.1:3080", ...headers };
  req.socket = { remoteAddress };
  return req;
}
function mockRes() {
  return { status: 0, headers: {}, body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; },
    end(chunk) { this.body = chunk ?? ""; },
    get headersSent() { return this.status !== 0; } };
}
async function callApi(storageRoot, { method, path, body }) {
  const routes = makeApiRoutes({ storageRoot, log: silentLog, onGlobalWrite: () => {} });
  const req = mockReq({ method, url: path, body });
  const res = mockRes();
  await routes[0].handler(req, res);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}
function seed(memRoot, name, body, description = "钩子") {
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

// ---- GET /state.safety（八字段）----

test("GET state：safety 字段集合严格相等（盘上三项 + 进程内七项）", async () => {
  const root = freshRoot();
  try {
    const { json } = await callApi(root, { method: "GET", path: `${API_PREFIX}state` });
    assert.equal(json.ok, true);
    const s = json.safety;
    assert.notEqual(s, void 0);
    // 集合严格相等：将来多/少一个字段都必须红（原断言只做 key in，加字段永远不红）
    assert.deepEqual(Object.keys(s).sort(), [
      "blindWriteDowngrades", "expectedSha1Mismatches", "hardfactBlocks", "hardfactDrops", "lastSnapshotAt",
      "lockConflicts", "snapshotFailures", "surgicalBackups", "trashPending", "verifyFailed",
    ].sort());
    assert.equal(s.surgicalBackups, 0);
    assert.equal(s.lastSnapshotAt, null);
    assert.equal(s.trashPending, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 回收站三端点 ----

test("trash/list → trash/restore → trash/purge：契约字段名与往返语义", async () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "projects", "p1", "memory");
    seed(memRoot, "a.md", "旧正文。", "钩子");
    // 用真实删除路径造回收站条目
    const del = applyOps(memRoot, [{ action: "delete", name: "a.md" }], { storageRoot: root, originSessionId: "s-1", log: silentLog });
    assert.equal(del.deletes, 1);
    // list
    const list = await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` });
    assert.equal(list.status, 200);
    assert.equal(list.json.ok, true);
    const entries = list.json.entries;
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.deepEqual(Object.keys(e).sort(), ["createdAt", "files", "id", "originSessionId"]);
    assert.equal(typeof e.id, "string");
    assert.equal(typeof e.createdAt, "string");
    assert.equal(e.originSessionId, "s-1");
    assert.deepEqual(Object.keys(e.files[0]).sort(), ["action", "name", "rootKey", "sha1"]);
    assert.equal(e.files[0].name, "a.md");
    // restore
    const restored = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/restore`, body: { id: e.id } });
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.json.restored, ["a.md"]);
    assert.equal(restored.json.indexReconciled, true);
    assert.equal(existsSync(join(memRoot, "a.md")), true);
    // 恢复后条目清空
    const after = await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` });
    assert.equal(after.json.entries.length, 0);
    // purge（再造一条后全清）
    applyOps(memRoot, [{ action: "delete", name: "a.md" }], { storageRoot: root, log: silentLog });
    const purge = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/purge`, body: {} });
    assert.equal(purge.status, 200);
    assert.equal(purge.json.purged, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- purge 入参闸：olderThanDays 非「≥0 有限数」→ 400，绝不静默落进全清 ----

test("trash/purge：olderThanDays 非法（负数/字符串/JSON 溢出）→ 400 INVALID，条目不被动", async () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seed(memRoot, "keep.md", "别清我。", "钩子");
    applyOps(memRoot, [{ action: "delete", name: "keep.md" }], { storageRoot: root, log: silentLog });
    assert.equal((await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` })).json.entries.length, 1);
    // 负数
    const neg = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/purge`, body: { olderThanDays: -1 } });
    assert.equal(neg.status, 400);
    assert.equal(neg.json.code, "INVALID");
    // 字符串（漏闸会被下游 Number 化误读）
    const str = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/purge`, body: { olderThanDays: "5" } });
    assert.equal(str.status, 400);
    assert.equal(str.json.code, "INVALID");
    // JSON 溢出字面量 1e999 → JSON.parse 得 Infinity（非有限）→ 同样 400
    const overflow = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/purge`, body: '{"olderThanDays":1e999}' });
    assert.equal(overflow.status, 400);
    assert.equal(overflow.json.code, "INVALID");
    // 三次非法请求都没有清掉条目（fail-closed 不动数据）
    assert.equal((await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` })).json.entries.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 破坏性端点：锁被占 → 409 LOCKED，且不碰任何数据 ----

test("锁被占：backup/restore（整份恢复）同样 409 LOCKED，数据原地不动", async () => {
  const root = freshRoot();
  try {
    // 造一份合法全量备份（含一条全局记忆），随后改写现网
    createEntry(root, "long-term", { title: "备份时点", content: "备份里的内容" });
    const backupId = createBackup(root, "test");
    createEntry(root, "long-term", { title: "现网时点", content: "恢复前的现网内容" });
    const before = listEntries(root, "long-term").map((e) => e.title).sort();
    // 本进程占住提取批锁（模拟另一实例在途）
    const held = acquireExtractLock(root);
    assert.equal(held.acquired, true);
    try {
      const out = await callApi(root, { method: "POST", path: `${API_PREFIX}backup/restore`, body: { id: backupId } });
      assert.equal(out.status, 409);
      assert.equal(out.json.code, "LOCKED");
      // 数据未动：全局记忆仍是恢复前的现网内容（没被整份覆盖回备份时点）
      assert.deepEqual(listEntries(root, "long-term").map((e) => e.title).sort(), before);
    } finally {
      held.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("锁被占：trash/restore 与 snapshots/restore 均 409 LOCKED，数据原地不动", async () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "projects", "p1", "memory");
    seed(memRoot, "a.md", "旧正文。", "钩子");
    // 造回收站条目（删除真实文件）
    applyOps(memRoot, [{ action: "delete", name: "a.md" }], { storageRoot: root, originSessionId: "s-1", log: silentLog });
    const trashId = (await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` })).json.entries[0].id;
    // 造一份手术快照（带正确 sha1 覆盖既有 → 落快照）
    const original = seed(memRoot, "b.md", "要保住的正文。", "钩子");
    const applied = applyOps(memRoot, [
      { action: "write", name: "b.md", type: "project", title: "B", description: "新钩子", content: "新正文", sha1: sha1Short(original) },
    ], { storageRoot: root, originSessionId: "s-1", log: silentLog });
    const snapId = applied.snapshotId;
    assert.notEqual(snapId, null);
    // 制造「恢复会覆盖现存同名文件」的现场
    writeFileSync(join(memRoot, "a.md"), "现网新 A（将被顶掉）。", "utf8");
    const bBefore = readFileSync(join(memRoot, "b.md"), "utf8");
    // 本进程占住提取批锁（模拟另一实例在途）
    const held = acquireExtractLock(root);
    assert.equal(held.acquired, true);
    try {
      const trashRestore = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/restore`, body: { id: trashId } });
      assert.equal(trashRestore.status, 409);
      assert.equal(trashRestore.json.code, "LOCKED");
      const snapRestore = await callApi(root, { method: "POST", path: `${API_PREFIX}snapshots/restore`, body: { id: snapId } });
      assert.equal(snapRestore.status, 409);
      assert.equal(snapRestore.json.code, "LOCKED");
      // 数据未动：被覆盖目标保持现网版本，快照条目也没被消费
      assert.equal(readFileSync(join(memRoot, "a.md"), "utf8"), "现网新 A（将被顶掉）。");
      assert.equal(readFileSync(join(memRoot, "b.md"), "utf8"), bBefore);
      assert.equal((await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` })).json.entries.length, 1);
    } finally {
      held.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 恢复前留底：被覆盖的旧版必须可从留底快照找回 ----

test("trash/restore 覆盖同名现存文件：响应带 preRestoreSnapshotId，快照多一份，旧版可从该快照找回", async () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "projects", "p1", "memory");
    const original = seed(memRoot, "a.md", "回收站里的旧版。", "旧钩子");
    applyOps(memRoot, [{ action: "delete", name: "a.md" }], { storageRoot: root, originSessionId: "s-1", log: silentLog });
    const trashId = (await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` })).json.entries[0].id;
    // 顶掉目标：现网同名不同内容
    const liveVersion = "现网被顶掉的那版。\n";
    writeFileSync(join(memRoot, "a.md"), liveVersion, "utf8");
    const snapsBefore = (await callApi(root, { method: "GET", path: `${API_PREFIX}snapshots/list` })).json.snapshots.length;
    const out = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/restore`, body: { id: trashId } });
    assert.equal(out.status, 200);
    assert.equal(typeof out.json.preRestoreSnapshotId, "string");
    // 恢复后文件回到回收站里的原文
    assert.equal(readFileSync(join(memRoot, "a.md"), "utf8"), original);
    // 快照目录多一份（留底）
    const snapsAfter = (await callApi(root, { method: "GET", path: `${API_PREFIX}snapshots/list` })).json.snapshots;
    assert.equal(snapsAfter.length, snapsBefore + 1);
    assert.ok(snapsAfter.some((s) => s.id === out.json.preRestoreSnapshotId), "留底快照必须在列");
    // 被顶掉的现网旧版本可从该留底快照找回
    const back = await callApi(root, { method: "POST", path: `${API_PREFIX}snapshots/restore`, body: { id: out.json.preRestoreSnapshotId } });
    assert.equal(back.status, 200);
    assert.deepEqual(back.json.restored, ["a.md"]);
    assert.equal(readFileSync(join(memRoot, "a.md"), "utf8"), liveVersion, "留底快照必须能找回被顶掉的版本");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("纯回填恢复（现网无同名冲突）→ 不建空留底快照（不留 manifest-only 幽灵，不耗保留配额）", async () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "projects", "p1", "memory");
    const original = seed(memRoot, "a.md", "回收站里的原文。", "旧钩子");
    applyOps(memRoot, [{ action: "delete", name: "a.md" }], { storageRoot: root, originSessionId: "s-1", log: silentLog });
    const trashId = (await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` })).json.entries[0].id;
    // 现网【无】同名冲突目标（删除后未重建）＝纯回填：留底无对象可留 → 不建快照
    const snapsBefore = (await callApi(root, { method: "GET", path: `${API_PREFIX}snapshots/list` })).json.snapshots.length;
    const out = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/restore`, body: { id: trashId } });
    assert.equal(out.status, 200);
    assert.equal(out.json.preRestoreSnapshotId, void 0, "纯回填不得留底（无可覆盖对象，不留空快照）");
    assert.equal(readFileSync(join(memRoot, "a.md"), "utf8"), original, "回填内容应逐字节回到原文");
    const snapsAfter = (await callApi(root, { method: "GET", path: `${API_PREFIX}snapshots/list` })).json.snapshots.length;
    assert.equal(snapsAfter, snapsBefore, "纯回填不得新增快照（此前 ops.length===0 分支无测试）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 恢复前留底读取失败：fail-closed，数据原地不动 ----

test("恢复前留底读取失败 → 500 E_SNAPSHOT 且数据原地不动（fail-closed：留不了底就不许覆盖）", async () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "projects", "p1", "memory");
    seed(memRoot, "a.md", "回收站里的原文。", "旧钩子");
    applyOps(memRoot, [{ action: "delete", name: "a.md" }], { storageRoot: root, originSessionId: "s-1", log: silentLog });
    const trashId = (await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` })).json.entries[0].id;
    // 把「恢复会覆盖的现网同名目标」占位成【目录】：existsSync 为真但 readFileSync 抛 EISDIR
    // → createPreRestoreSnapshot 抛 SNAPSHOT_READ_FAILED（留底读不出 = 无法保证可逆）。
    const occupied = join(memRoot, "a.md");
    rmSync(occupied, { force: true });
    mkdirSync(occupied, { recursive: true });
    const snapsBefore = (await callApi(root, { method: "GET", path: `${API_PREFIX}snapshots/list` })).json.snapshots.length;
    const out = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/restore`, body: { id: trashId } });
    assert.equal(out.status, 500);
    assert.equal(out.json.code, "E_SNAPSHOT");
    assert.match(out.json.error, /留底失败/);
    // fail-closed：留底失败必须中止且不改动任何数据——回收站条目与现网占位都原样，且不留空快照
    const entries = (await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` })).json.entries;
    assert.equal(entries.length, 1, "回收站条目不得被动");
    assert.equal(existsSync(occupied), true, "现网占位不得被动");
    assert.equal((await callApi(root, { method: "GET", path: `${API_PREFIX}snapshots/list` })).json.snapshots.length, snapsBefore, "留底失败不得新增（空）快照");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- purge 入参闸：显式 null 与非法值同口径 400，绝不静默落进全清 ----

test("trash/purge：显式 {\"olderThanDays\":null} → 400 INVALID，条目一个不清（缺键才=全清）", async () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seed(memRoot, "p.md", "P", "钩子"); seed(memRoot, "q.md", "Q", "钩子");
    applyOps(memRoot, [{ action: "delete", name: "p.md" }, { action: "delete", name: "q.md" }], { storageRoot: root, originSessionId: "s-1", log: silentLog });
    assert.equal((await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` })).json.entries.length, 2);
    // 显式 null：与负数/字符串同口径——非法入参 400，不是「缺省全清」
    const nulled = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/purge`, body: { olderThanDays: null } });
    assert.equal(nulled.status, 400);
    assert.equal(nulled.json.code, "INVALID");
    // 显式 null 换来的不是全清：2 条一条没动
    assert.equal((await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` })).json.entries.length, 2);
    // 缺键（{} / 空 body）才是全清语义——对照保持不变
    const absent = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/purge`, body: {} });
    assert.equal(absent.status, 200);
    assert.equal(absent.json.purged, 2);
    assert.equal((await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` })).json.entries.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("全清 purge（空 body）语义保持：清空全部条目（真正删除）", async () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seed(memRoot, "p.md", "P", "钩子"); seed(memRoot, "q.md", "Q", "钩子");
    applyOps(memRoot, [{ action: "delete", name: "p.md" }, { action: "delete", name: "q.md" }], { storageRoot: root, originSessionId: "s-1", log: silentLog });
    assert.equal((await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` })).json.entries.length, 2);
    const purge = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/purge`, body: {} });
    assert.equal(purge.status, 200);
    assert.equal(purge.json.ok, true);
    assert.equal(purge.json.purged, 2);
    // 全清 = 真正删除：清单空、磁盘条目目录已清
    assert.equal((await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` })).json.entries.length, 0);
    // 空 body（无 JSON）同样走全清语义，不报错
    const again = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/purge`, body: "" });
    assert.equal(again.status, 200);
    assert.equal(again.json.purged, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trash/restore：缺 id → 400；非法 id → 400（code=TRASH_INVALID）", async () => {
  const root = freshRoot();
  try {
    const noId = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/restore`, body: {} });
    assert.equal(noId.status, 400);
    const evil = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/restore`, body: { id: "../etc" } });
    assert.equal(evil.status, 400);
    assert.equal(evil.json.code, "TRASH_INVALID");
    const missing = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/restore`, body: { id: "2099-01-01T00-00-00-000Z" } });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, "TRASH_MISSING");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 快照两端点 ----

test("snapshots/list → snapshots/restore：契约字段名与一键还原", async () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "projects", "p2", "memory");
    const original = seed(memRoot, "b.md", "要保住的正文。", "旧钩子");
    // 带正确 sha1 的覆盖 → 落快照
    const { sha1Short } = await import("../lib/safety.js");
    const res = applyOps(memRoot, [
      { action: "write", name: "b.md", type: "project", title: "B", description: "新钩子", content: "新正文", sha1: sha1Short(original) },
    ], { storageRoot: root, originSessionId: "s-1", log: silentLog });
    assert.equal(res.writes, 1);
    assert.notEqual(res.snapshotId, null);
    // list 契约
    const list = await callApi(root, { method: "GET", path: `${API_PREFIX}snapshots/list` });
    assert.equal(list.status, 200);
    const snaps = list.json.snapshots;
    assert.equal(snaps.length, 1);
    const s0 = snaps[0];
    assert.deepEqual(Object.keys(s0).sort(), ["createdAt", "fileCount", "files", "id", "originSessionId"]);
    assert.equal(s0.id, res.snapshotId);
    assert.equal(s0.fileCount, 1);
    assert.equal(s0.originSessionId, "s-1");
    assert.deepEqual(Object.keys(s0.files[0]).sort(), ["action", "name", "rootKey", "sha1"]);
    // restore 一键还原原文
    const back = await callApi(root, { method: "POST", path: `${API_PREFIX}snapshots/restore`, body: { id: s0.id } });
    assert.equal(back.status, 200);
    assert.deepEqual(back.json.restored, ["b.md"]);
    assert.equal(back.json.indexReconciled, true);
    assert.equal(readFileSync(join(memRoot, "b.md"), "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshots/restore：缺 id → 400；非法 id → 400（code=SNAPSHOT_INVALID）", async () => {
  const root = freshRoot();
  try {
    const noId = await callApi(root, { method: "POST", path: `${API_PREFIX}snapshots/restore`, body: {} });
    assert.equal(noId.status, 400);
    const evil = await callApi(root, { method: "POST", path: `${API_PREFIX}snapshots/restore`, body: { id: "../../evil" } });
    assert.equal(evil.status, 400);
    assert.equal(evil.json.code, "SNAPSHOT_INVALID");
    const missing = await callApi(root, { method: "POST", path: `${API_PREFIX}snapshots/restore`, body: { id: "2099-01-01T00-00-00-000Z-1" } });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, "SNAPSHOT_MISSING");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 全量备份与 surgical 区分 ----

test("createBackup 备份目录首次出现 project 记忆；listBackups 区分 surgical", async () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "projects", "slug-hash", "memory");
    seed(memRoot, "proj.md", "项目记忆正文。", "项目钩子");
    const id = createBackup(root, "test");
    const dir = join(root, "backups", id);
    // 首次出现 projects 目录
    assert.equal(existsSync(join(dir, "projects")), true);
    assert.equal(existsSync(join(dir, "projects", "slug-hash", "memory", "proj.md")), true);
    assert.equal(readFileSync(join(dir, "projects", "slug-hash", "memory", "proj.md"), "utf8"), readFileSync(join(memRoot, "proj.md"), "utf8"));
    // meta 版本号
    const meta = JSON.parse(readFileSync(join(dir, "backup-meta.json"), "utf8"));
    assert.equal(meta.version, 2);
    // listBackups：surgical 不混入全量备份；列表条目不再带 kind 字段（只含全量备份，无消费方）
    const listed = listBackups(root);
    assert.equal(listed.every((b) => !Object.prototype.hasOwnProperty.call(b, "kind")), true);
    assert.equal(listed.some((b) => b.id === "surgical"), false);
    assert.equal(listed.find((b) => b.id === id).version, 2);
    // 端点可见
    const apiList = await callApi(root, { method: "GET", path: `${API_PREFIX}backup/list` });
    assert.equal(apiList.status, 200);
    assert.equal(apiList.json.backups.every((b) => !Object.prototype.hasOwnProperty.call(b, "kind")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("旧备份兼容：无 projects 目录的备份 restore 不崩（meta 版本差异容错）", async () => {
  const root = freshRoot();
  try {
    const id = createBackup(root, "old-style");
    const dir = join(root, "backups", id);
    // 模拟旧备份：删掉 projects、meta 改回无 version
    rmSync(join(dir, "projects"), { recursive: true, force: true });
    const meta = JSON.parse(readFileSync(join(dir, "backup-meta.json"), "utf8"));
    delete meta.version;
    writeFileSync(join(dir, "backup-meta.json"), JSON.stringify(meta, null, 2), "utf8");
    const out = await callApi(root, { method: "POST", path: `${API_PREFIX}backup/restore`, body: { id } });
    assert.equal(out.status, 200);
    assert.equal(out.json.ok, true);
    // listBackups 对无 version 的旧备份视同 1，不崩
    const listed = listBackups(root);
    assert.ok(listed.length >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 恢复失败 500：不带内部细节（fs 错误消息内嵌绝对 storageRoot 路径）----

test("snapshots/restore IO 失败 → 500 E_RESTORE：响应不含 storageRoot 绝对路径，但仍带留底快照指路", async () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "projects", "p1", "memory");
    const original = seed(memRoot, "a.md", "要保住的正文。", "旧钩子");
    const applied = applyOps(memRoot, [
      { action: "write", name: "a.md", type: "project", title: "A", description: "新钩子", content: "新正文", sha1: sha1Short(original) },
    ], { storageRoot: root, originSessionId: "s-1", log: silentLog });
    assert.notEqual(applied.snapshotId, null);
    // 制造「恢复要覆盖现存同名文件」的现场（这样 preRestoreSnapshotId 才不为 null）
    writeFileSync(join(memRoot, "a.md"), "现网被顶掉的那版。\n", "utf8");
    // 逼出 IO 失败：把记忆根的索引位 MEMORY.md 占位成「目录」——恢复 payload 照常写完，
    // 到末尾重建索引的 rename 才炸（EPERM/EXDEV，错误消息内嵌绝对 storageRoot 路径）。
    // 这正是「IO 中途失败」的真实形态：数据面已在盘，500 带 preRestoreSnapshotId 自救指路。
    rmSync(join(memRoot, "MEMORY.md"), { recursive: true, force: true }); // applyOps 已把索引建成了文件，先清掉
    mkdirSync(join(memRoot, "MEMORY.md"), { recursive: true });
    const out = await callApi(root, { method: "POST", path: `${API_PREFIX}snapshots/restore`, body: { id: applied.snapshotId } });
    assert.equal(out.status, 500);
    assert.equal(out.json.code, "E_RESTORE");
    // 泄露闸：500 响应不得含 storageRoot 绝对路径（fs 错误消息里就有）
    assert.equal(JSON.stringify(out.json).includes(root), false, "500 响应不得内嵌 storageRoot 路径");
    assert.equal(out.json.error.includes("\\"), false, "500 响应不得含任何路径分隔符");
    assert.equal(out.json.error.includes("/"), false, "500 响应不得含任何路径分隔符");
    assert.ok(out.json.error.length > 0, "仍要给一句人话");
    // 有用的诊断照旧带上：留底快照可找回被顶掉的版本
    assert.equal(typeof out.json.preRestoreSnapshotId, "string");
    assert.equal(typeof out.json.hint, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trash/restore IO 失败 → 500 E_RESTORE：同样不泄露 storageRoot 路径", async () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "projects", "p1", "memory");
    seed(memRoot, "a.md", "回收站里的旧版。", "旧钩子");
    applyOps(memRoot, [{ action: "delete", name: "a.md" }], { storageRoot: root, originSessionId: "s-1", log: silentLog });
    const trashId = (await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` })).json.entries[0].id;
    // 现网同名不同内容（制造「恢复会覆盖现存目标」→ 有留底快照）
    writeFileSync(join(memRoot, "a.md"), "现网被顶掉的那版。\n", "utf8");
    rmSync(join(memRoot, "MEMORY.md"), { recursive: true, force: true }); // applyOps 删条目后索引仍是文件，先清掉
    mkdirSync(join(memRoot, "MEMORY.md"), { recursive: true }); // 索引位占位成目录：末尾 rename 必炸
    const out = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/restore`, body: { id: trashId } });
    assert.equal(out.status, 500);
    assert.equal(out.json.code, "E_RESTORE");
    assert.equal(JSON.stringify(out.json).includes(root), false, "500 响应不得内嵌 storageRoot 路径");
    assert.equal(typeof out.json.preRestoreSnapshotId, "string");
    assert.equal(typeof out.json.hint, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- P1：backup/restore 的 pre 备份不得自毁正在恢复的目标 ----

test("backup/restore IO 失败 → 500 E_RESTORE：响应不含 storageRoot 绝对路径，但仍带留底备份指路", async () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "projects", "p1", "memory");
    seed(memRoot, "a.md", "要保住的正文。", "旧钩子");
    // 让备份内容含 settings.json（备份含它才会走「恢复 settings.json」这一步）
    writeFileSync(join(root, "settings.json"), JSON.stringify({ surgicalKeep: 30 }), "utf8");
    const backupId = createBackup(root, "manual");
    // 逼出 IO 中途失败：把【备份里】的 settings.json 换成一个目录——恢复写它时
    // copyFileSync 必炸（EISDIR，fs 错误消息内嵌绝对 storageRoot 路径）。改备份而非改现网，
    // 是为了让留底（pre-restore）备份照常成功，失败只发生在 restore 本体这一步。
    const bakSettings = join(backupsRoot(root), backupId, "settings.json");
    rmSync(bakSettings, { force: true });
    mkdirSync(bakSettings, { recursive: true });
    const out = await callApi(root, { method: "POST", path: `${API_PREFIX}backup/restore`, body: { id: backupId } });
    assert.equal(out.status, 500);
    assert.equal(out.json.code, "E_RESTORE");
    // 泄露闸：500 响应不得含 storageRoot 绝对路径（fs 错误消息里就有）
    assert.equal(JSON.stringify(out.json).includes(root), false, "500 响应不得内嵌 storageRoot 路径");
    assert.equal(out.json.error.includes("\\"), false, "500 响应不得含任何路径分隔符");
    assert.equal(out.json.error.includes("/"), false, "500 响应不得含任何路径分隔符");
    assert.ok(out.json.error.length > 0, "仍要给一句人话");
    // 有用的诊断照旧带上：恢复前现态已留底
    assert.equal(typeof out.json.preRestoreBackupId, "string");
    assert.equal(typeof out.json.hint, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup/restore 恢复最旧那份：pre 备份的滚动清理豁免目标（20 份上限不许清掉在途目标）", async () => {
  const root = freshRoot();
  try {
    // 先造满 BACKUP_KEEP 份，目标 = 其中最早的那份
    const ids = [];
    for (let i = 0; i < BACKUP_KEEP; i += 1) {
      createEntry(root, "long-term", { title: `点位 ${i}`, content: `内容 ${i}` });
      ids.push(createBackup(root, "manual"));
    }
    assert.equal(listBackups(root).length, BACKUP_KEEP);
    const target = ids[0]; // 最旧
    // 恢复前改现网（pre 备份要留的是「恢复前的现态」，与目标时点不同）
    createEntry(root, "long-term", { title: "现网追加", content: "恢复前的现网内容" });
    const out = await callApi(root, { method: "POST", path: `${API_PREFIX}backup/restore`, body: { id: target } });
    // P1 回归：pre 备份把份数顶到 21 时，旧缺陷会把最旧的（=目标）清掉 → BACKUP_MISSING + 目录永失
    assert.equal(out.status, 200);
    assert.equal(out.json.ok, true);
    assert.equal(out.json.restored, target);
    assert.ok(out.json.preRestoreBackupId);
    // 目标备份必须还在（被本次 restore 自己用掉后才可能被【后续】正常备份淘汰）
    assert.equal(existsSync(join(backupsRoot(root), target)), true, "目标备份不得被本次 restore 自毁");
    const listedIds = listBackups(root).map((b) => b.id);
    assert.ok(listedIds.includes(target), "目标备份仍可列、可再恢复");
    // 现网已回到目标时点（最旧那份备份里的内容）
    const titles = listEntries(root, "long-term").map((e) => e.title).sort();
    assert.deepEqual(titles, ["点位 0"].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

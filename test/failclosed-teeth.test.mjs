// failclosed-teeth：fail-closed / 锁 / 日志三处「实现退化即红」的回归测试。
//   覆盖：快照失败必须阻断覆盖与删除、锁被占必须阻断破坏性 op、
//   硬事实 diff 必须真的落盘、manifest 短 sha1 与真实内容一致。
//   每条都按「把实现改回缺陷形态必须变红」的标准写。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyOps, applyScopedOps, __resetSafetyCountersForTest, safetyCounterSnapshot } from "../lib/extract.js";
import { acquireExtractLock, listSurgicalSnapshots, sha1Short } from "../lib/safety.js";
import { buildManifestText } from "../lib/manifest.js";
import { ERROR_LOG_NAME, sanitizeLogDetail } from "../lib/errorlog.js";

const silentLog = { warn: () => {}, error: () => {} };

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-teeth-"));
}

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

// ---- 快照失败必须阻断覆盖（带正确 sha1 也不许绕过）----

test("fail-closed：快照必炸时带正确 sha1 的覆盖也被阻断，原文逐字节不变", () => {
  __resetSafetyCountersForTest();
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seedMemory(memRoot, "a.md", "旧正文：269 个文件。");
    // 令快照必然失败：把 backups/surgical 占成普通文件（mkdir 递归建不进来）
    mkdirSync(join(root, "backups"), { recursive: true });
    writeFileSync(join(root, "backups", "surgical"), "not a dir", "utf8");
    const result = applyOps(memRoot, [
      { action: "write", name: "a.md", type: "project", title: "A", description: "d", content: "新正文：267 个文件。", sha1: sha1Short(original) },
    ], { storageRoot: root, originSessionId: "s-1", log: silentLog });
    assert.equal(result.writes, 0, "快照失败时覆盖必须被阻断");
    assert.equal(result.blockedDestructive, true);
    assert.equal(readFileSync(join(memRoot, "a.md"), "utf8"), original, "原文必须逐字节不变");
    assert.ok(safetyCounterSnapshot().snapshotFailures >= 1, "snapshotFailures 必须计数");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fail-closed：快照必炸时删除同样被阻断（文件原地不动）", () => {
  __resetSafetyCountersForTest();
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    seedMemory(memRoot, "b.md", "别删我。");
    mkdirSync(join(root, "backups"), { recursive: true });
    writeFileSync(join(root, "backups", "surgical"), "not a dir", "utf8");
    const result = applyOps(memRoot, [{ action: "delete", name: "b.md" }], { storageRoot: root, originSessionId: "s-1", log: silentLog });
    assert.equal(result.deletes, 0);
    assert.equal(existsSync(join(memRoot, "b.md")), true, "删除必须被阻断");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 锁被占必须阻断删除（project + global 两侧）----

test("锁被占：project 与 global 的 delete 双双阻断，lockConflicts=1，文件不动", () => {
  __resetSafetyCountersForTest();
  const storageRoot = freshRoot();
  // projectRoot 必须在 storageRoot 之下（真实布局 projects/<slug>/memory）：
  // 隔离在外的 root 会让 rootDirOf 拒载回收站（越界），测不到锁语义本身。
  const projectRoot = join(storageRoot, "projects", "p1", "memory");
  try {
    // 先造一个 project 记忆和一个 global 记忆（无锁状态下正常落盘）
    applyScopedOps({ storageRoot, projectRoot }, [
      { action: "write", name: "p.md", type: "project", title: "P", description: "d", content: "project 正文" },
      { action: "write", name: "g.md", type: "global", title: "G", description: "d", content: "global 正文", scope: "global:long-term" },
    ], { originSessionId: "s-seed", log: silentLog });
    const projectFile = join(projectRoot, "p.md");
    const globalFile = join(storageRoot, "global", "long-term", "g.md");
    assert.equal(existsSync(projectFile), true);
    assert.equal(existsSync(globalFile), true);
    // 本测试进程占住提取批锁（模拟另一个实例正在写）
    const held = acquireExtractLock(storageRoot);
    assert.equal(held.acquired, true);
    try {
      const result = applyScopedOps({ storageRoot, projectRoot }, [
        { action: "delete", name: "p.md" },
        { action: "delete", name: "g.md", scope: "global:long-term" },
      ], { originSessionId: "s-locked", log: silentLog });
      assert.equal(result.locked, true);
      assert.equal(result.lockConflicts, 1);
      assert.equal(result.deletes, 0, "锁被占时两侧删除都必须被阻断");
      assert.equal(existsSync(projectFile), true, "project 文件必须原地不动");
      assert.equal(existsSync(globalFile), true, "global 文件必须原地不动");
      assert.ok(safetyCounterSnapshot().lockConflicts >= 1, "lockConflicts 必须计数");
    } finally {
      held.release();
    }
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---- 硬事实 diff 片段必须真的落盘 ----

test("hardfact-drop 日志必须带 detail= diff 片段（269→267）", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seedMemory(memRoot, "c.md", "旧结论：共 269 个文件。");
    applyOps(memRoot, [
      { action: "write", name: "c.md", type: "project", title: "C", description: "d", content: "新结论：共 267 个文件。", sha1: sha1Short(original) },
    ], { storageRoot: root, originSessionId: "s-1", log: silentLog });
    const logPath = join(root, ERROR_LOG_NAME);
    assert.equal(existsSync(logPath), true, "必须有 extraction-errors.log");
    const text = readFileSync(logPath, "utf8");
    assert.match(text, /hardfact-drop/, "必须记 hardfact-drop");
    assert.match(text, /detail=/, "必须带 detail= diff 片段");
    assert.match(text, /269/, "diff 里必须看得到旧值");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- manifest 短 sha1 必须与真实内容一致 ----

test("manifest 行短 sha1 = 文件真实内容 sha1 前 8 位", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const content = seedMemory(memRoot, "d.md", "随便一段正文。");
    const { manifest } = buildManifestText(memRoot);
    // manifest 行用的是 frontmatter 的 name（非文件名），单文件场景直接取第一行
    const line = manifest.split("\n")[0];
    assert.ok(line && line.includes("d"), "manifest 必须列出该条目");
    const m = line.match(/sha1:([0-9a-f]{8})/);
    assert.ok(m, "manifest 行必须带 sha1: 短哈希");
    assert.equal(m[1], sha1Short(content), "短 sha1 必须等于真实内容哈希前 8 位");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 锁被占必须阻断 overwrite ----

test("锁被占：project 与 global 的 overwrite 均被阻断，原文不动，纯新增放行", () => {
  __resetSafetyCountersForTest();
  const storageRoot = freshRoot();
  const projectRoot = join(storageRoot, "projects", "p1", "memory");
  try {
    applyScopedOps({ storageRoot, projectRoot }, [
      { action: "write", name: "p.md", type: "project", title: "P", description: "d", content: "project 旧正文" },
      { action: "write", name: "g.md", type: "global", title: "G", description: "d", content: "global 旧正文", scope: "global:long-term" },
    ], { originSessionId: "s-seed", log: silentLog });
    const projectFile = join(projectRoot, "p.md");
    const globalFile = join(storageRoot, "global", "long-term", "g.md");
    const projectBefore = readFileSync(projectFile, "utf8");
    const globalBefore = readFileSync(globalFile, "utf8");
    const held = acquireExtractLock(storageRoot);
    assert.equal(held.acquired, true);
    try {
      const result = applyScopedOps({ storageRoot, projectRoot }, [
        { action: "write", name: "p.md", type: "project", title: "P", description: "d", content: "project 新正文", sha1: sha1Short(projectBefore) },
        { action: "write", name: "g.md", type: "global", title: "G", description: "d", content: "global 新正文", scope: "global:long-term" },
        { action: "write", name: "new.md", type: "project", title: "N", description: "d", content: "纯新增照常" },
      ], { originSessionId: "s-locked", log: silentLog });
      assert.equal(result.locked, true);
      assert.equal(result.writes, 1, "只有纯新增那一条放行");
      assert.equal(readFileSync(projectFile, "utf8"), projectBefore, "project 旧文必须不动");
      assert.equal(readFileSync(globalFile, "utf8"), globalBefore, "global 旧文必须不动");
      assert.equal(existsSync(join(projectRoot, "new.md")), true, "纯新增必须照常落盘");
    } finally {
      held.release();
    }
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

// ---- 锁被占（全阻断批）不建快照、不 prune：不白耗保留配额、不误逐真 pre-image ----

test("锁被占的项目侧批：全阻断、不建快照、不 prune（上一批真 pre-image 原样保留）", () => {
  __resetSafetyCountersForTest();
  const storageRoot = freshRoot();
  const projectRoot = join(storageRoot, "projects", "p1", "memory");
  try {
    const settings = { surgicalKeep: 1 };
    // 批一（无锁）：覆盖既有 → 建 pre-image 快照并 prune 保留 1
    applyScopedOps({ storageRoot, projectRoot }, [
      { action: "write", name: "p.md", type: "project", title: "P", description: "d", content: "第二代正文" },
    ], { originSessionId: "s-1", settings, log: silentLog });
    applyScopedOps({ storageRoot, projectRoot }, [
      { action: "write", name: "p.md", type: "project", title: "P", description: "d", content: "第三代正文", sha1: sha1Short(readFileSync(join(projectRoot, "p.md"), "utf8")) },
    ], { originSessionId: "s-2", settings, log: silentLog });
    const beforeIds = listSurgicalSnapshots(storageRoot).map((s) => s.id);
    assert.equal(beforeIds.length, 1, "前置：应有一份真 pre-image 快照");

    const held = acquireExtractLock(storageRoot);
    assert.equal(held.acquired, true);
    try {
      const result = applyScopedOps({ storageRoot, projectRoot }, [
        { action: "write", name: "p.md", type: "project", title: "P", description: "d", content: "第四代正文", sha1: sha1Short(readFileSync(join(projectRoot, "p.md"), "utf8")) },
        { action: "write", name: "new.md", type: "project", title: "N", description: "d", content: "纯新增照常" },
      ], { originSessionId: "s-3", settings, log: silentLog });
      assert.equal(result.locked, true);
      assert.equal(result.writes, 1, "只有纯新增放行");
      assert.equal(result.snapshotId, null, "全阻断批且无纯新增破坏性 op → 不得建快照");
    } finally {
      held.release();
    }
    assert.deepEqual(listSurgicalSnapshots(storageRoot).map((s) => s.id), beforeIds, "上一批真 pre-image 快照必须原样保留（不被空批误逐）");
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

// ---- sanitizeLogDetail：超长 detail 截断必须留痕（尾部带标记），且含标记仍 ≤2048 ----

test("sanitizeLogDetail：超长 detail 截到 ≤2048 且尾部带 [...truncated...]；短 detail 原样、不留标记", () => {
  const MARK = "[...truncated...]";
  const short = "一段短短的 diff 片段。";
  assert.equal(sanitizeLogDetail(short), short, "未超长时原样返回，不带截断标记");
  assert.ok(!sanitizeLogDetail(short).includes(MARK));

  // 超长输入：截到上限且尾部带标记，含标记总长 ≤2048
  const long = "长".repeat(5000);
  const out = sanitizeLogDetail(long);
  assert.ok(out.length <= 2048, `含标记总长必须 ≤2048（实际 ${out.length}）`);
  assert.ok(out.endsWith(MARK), `截断后尾部必须带 ${MARK}`);
  // 截断后仍是原文本前缀（不夹带无关内容）
  assert.ok(long.startsWith(out.slice(0, out.length - MARK.length)));

  // CR/LF 先剥净：注入的假日志行不得形成独立行
  const injected = `正文${"\r\n"} [2099-01-01T00:00:00.000Z] [1] 假行 ${"填充".repeat(2000)}`;
  const cleaned = sanitizeLogDetail(injected);
  assert.ok(!cleaned.includes("\r") && !cleaned.includes("\n"), "CR/LF 必须剥净");
  assert.ok(cleaned.length <= 2048);
  assert.ok(cleaned.endsWith(MARK), "超长且带 CRLF 的输入同样必须留截断标记");
});

// ---- hardfact diff 的 2048 截断 + CR/LF 剥离 ----

test("hardfact-drop 的 detail 被截到 ≤2048 且剥净 CR/LF（防注入假行）", () => {
  const root = freshRoot();
  try {
    const memRoot = join(root, "memory");
    const original = seedMemory(memRoot, "e.md", "旧结论：269 个文件。");
    // 造一条超长且带 CRLF 的新正文：diff 必超 2048，且若 CR/LF 不剥会伪造日志行
    // 填充不带数字：否则正文里的普通数字会掩护 269 的丢失（hybrid 判据局限，实测踩过）
    const longTail = Array.from({ length: 400 }, () => "填充行内容填充行内容填充行内容").join("\r\n");
    applyOps(memRoot, [
      { action: "write", name: "e.md", type: "project", title: "E", description: "d", content: `新结论：267 个文件。${longTail}`, sha1: sha1Short(original) },
    ], { storageRoot: root, originSessionId: "s-1", log: silentLog });
    const text = readFileSync(join(root, ERROR_LOG_NAME), "utf8");
    const detailAt = text.indexOf("detail=");
    assert.ok(detailAt >= 0, "必须带 detail=");
    const detail = text.slice(detailAt);
    assert.ok(detail.length <= 2048 + 16, `detail 超长（${detail.length}），必须截到 2048`);
    assert.ok(!detail.includes("\r"), "detail 必须剥净 CR");
    // 注入面：正文里塞一个假日志行前缀，剥净后不得形成独立行
    const withInjection = detail.includes("[2099-01-01T00:00:00.000Z]");
    if (withInjection) {
      const lineCount = text.split("\n").length;
      assert.equal(lineCount, 1, "注入内容不得伪造出新的日志行");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

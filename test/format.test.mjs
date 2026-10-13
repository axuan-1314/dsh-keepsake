// format：存储格式版本闸（缺失补写 / 同级放行 / 过新只读拒绝 / 损坏补写）。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertWritable, ensureFormat, FORMAT_FILENAME, FORMAT_VERSION, formatPath, readFormatState, resetFormatCache } from "../lib/format.js";

function freshRoot() {
  resetFormatCache();
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-format-"));
}

const silent = { warn: () => {}, error: () => {} };

test("缺失标记（旧数据/全新目录）= 补写当前版本并可写", () => {
  const root = freshRoot();
  try {
    const before = readFormatState(root, silent);
    assert.equal(before.present, false);
    const result = ensureFormat(root, silent);
    assert.equal(result.ok, true);
    assert.equal(result.stamped, true);
    assert.equal(result.formatVersion, FORMAT_VERSION);
    assert.equal(existsSync(formatPath(root)), true);
    const parsed = JSON.parse(readFileSync(formatPath(root), "utf8"));
    assert.equal(parsed.formatVersion, FORMAT_VERSION);
    // 补写后再次读取：present 且 supported
    const after = readFormatState(root, silent);
    assert.equal(after.present, true);
    assert.equal(after.supported, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("同级标记 = 放行，不重写", () => {
  const root = freshRoot();
  try {
    writeFileSync(formatPath(root), JSON.stringify({ formatVersion: FORMAT_VERSION }), "utf8");
    const result = ensureFormat(root, silent);
    assert.equal(result.ok, true);
    assert.equal(result.stamped, void 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("过新标记 = 拒绝写入（assertWritable 抛 FORMAT_TOO_NEW），且不覆盖原标记", () => {
  const root = freshRoot();
  try {
    const future = FORMAT_VERSION + 1;
    writeFileSync(formatPath(root), JSON.stringify({ formatVersion: future }), "utf8");
    const state = ensureFormat(root, silent);
    assert.equal(state.ok, false);
    assert.equal(state.reason, "too-new");
    assert.equal(state.formatVersion, future);
    assert.throws(() => assertWritable(root, silent), (error) => error.code === "FORMAT_TOO_NEW");
    // 关键：拒绝路径绝不改写标记（否则会把更新版的数据标记降级成本版本）
    const parsed = JSON.parse(readFileSync(formatPath(root), "utf8"));
    assert.equal(parsed.formatVersion, future);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("损坏标记 = 先备份（.corrupt-*）再补写当前版本，且保持可写不阻断", () => {
  const root = freshRoot();
  try {
    const corruptBody = "{ not json";
    writeFileSync(formatPath(root), corruptBody, "utf8");
    const before = readFormatState(root, silent);
    assert.equal(before.corrupt, true);
    const result = ensureFormat(root, silent);
    // ① 返回成功，并带 corruptReset 观测字段
    assert.equal(result.ok, true);
    assert.equal(result.corruptReset, true);
    assert.equal(result.stamped, true);
    assert.equal(result.formatVersion, FORMAT_VERSION);
    // ② 目录下出现备份文件，且内容为原始损坏内容（证据永不失访）
    const evidence = readdirSync(root).filter((name) => name.startsWith(`${FORMAT_FILENAME}.corrupt-`));
    assert.equal(evidence.length, 1);
    assert.equal(readFileSync(join(root, evidence[0]), "utf8"), corruptBody);
    // ③ 标记被补写为当前版本
    assert.equal(JSON.parse(readFileSync(formatPath(root), "utf8")).formatVersion, FORMAT_VERSION);
    // ④ 再读为干净状态：corrupt:false 且版本为当前
    resetFormatCache();
    const after = readFormatState(root, silent);
    assert.equal(after.corrupt, false);
    assert.equal(after.formatVersion, FORMAT_VERSION);
    // ⑤ 回归：损坏标记场景下写入闸不抛（保持可写）
    assert.doesNotThrow(() => assertWritable(root, silent));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("标记缺 formatVersion 字段 = 视为损坏并补写", () => {
  const root = freshRoot();
  try {
    writeFileSync(formatPath(root), JSON.stringify({ note: "no version" }), "utf8");
    const state = readFormatState(root, silent);
    assert.equal(state.corrupt, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FORMAT_FILENAME 常量与 formatPath 一致", () => {
  assert.equal(formatPath("/x/y"), join("/x/y", FORMAT_FILENAME));
});

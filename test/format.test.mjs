// format：存储格式版本闸（缺失补写 / 同级放行 / 过新只读拒绝 / 损坏补写）。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("损坏标记 = 补写当前版本（可见降级，不阻断）", () => {
  const root = freshRoot();
  try {
    writeFileSync(formatPath(root), "{ not json", "utf8");
    const before = readFormatState(root, silent);
    assert.equal(before.corrupt, true);
    const result = ensureFormat(root, silent);
    assert.equal(result.ok, true);
    assert.equal(result.stamped, true);
    assert.equal(JSON.parse(readFileSync(formatPath(root), "utf8")).formatVersion, FORMAT_VERSION);
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

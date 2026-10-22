// pin-name-stability：pin 端点切 pinned 时**不得改动 frontmatter.name**（2026-10-22 补）。
//
// 背景：pin 项目条目走「读原文 → renderMemoryFile 整体覆写」。早先实现按 safe 名展平
// （`sub/nested.md` → name: "sub-nested"），而文件仍在 `sub/nested.md`——
// frontmatter.name 与磁盘路径脱钩后：manifest 行按 front.name 回填
// （lib/manifest.js:167），模型据此覆盖写会新建一份扁平文件，原文件成幽灵条目；
// 指向它的互链与索引行也随之名实不符。
//
// 自拆改验证：把 lib/runtime-archive.js pinRuntimeEntry 的
// `name: heads.name ?? safe.replace(...)` 改回 `safe.replace(/\.md$/i,"").replace(/\//g,"-")`，
// 本文件②必须红；其余不受影响。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pinRuntimeEntry } from "../lib/runtime-archive.js";
import { applyOps } from "../lib/extract.js";
import { parseFrontmatterHead } from "../lib/manifest.js";

const silentLog = { warn: () => {}, error: () => {}, info: () => {} };

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-pinname-"));
}

/** 直接落一份项目条目文件（嵌套路径也走真实形态）。 */
function seedEntry(projectRoot, rel, body) {
  const target = join(projectRoot, rel);
  mkdirSync(join(target, ".."), { recursive: true });
  const content = `---
name: "${rel.replace(/\.md$/i, "")}"
description: "d"
metadata:
  type: project
node_type: "memory"
---

${body}
`;
  writeFileSync(target, content, "utf8");
  return content;
}

test("pin 嵌套项目条目：frontmatter.name 保留真实相对路径（不被展平）", () => {
  const root = freshRoot();
  try {
    const scope = "projects/p-0123456789abcdef";
    const projectRoot = join(root, ...scope.split("/"), "memory");
    seedEntry(projectRoot, "sub/nested.md", "正文");
    const result = pinRuntimeEntry({
      storageRoot: root,
      scope,
      rootKey: "project",
      file: "sub/nested.md",
      pinned: true,
      log: silentLog,
    });
    assert.equal(result.pinned, true);
    // 文件没被搬到别处（pin 不是搬移）
    const raw = readFileSync(join(projectRoot, "sub", "nested.md"), "utf8");
    const front = parseFrontmatterHead(raw);
    assert.equal(front.name, "sub/nested", "name 必须保留真实相对路径（展平会制造幽灵条目）");
    assert.equal(front.pinned, true, "pin 态必须落盘");
    assert.equal(front.description, "d", "description 必须原样保留");
    assert.match(raw, /正文/, "正文必须原样保留");
    // 不得新生出扁平文件
    assert.equal(existsSync(join(projectRoot, "sub-nested.md")), false, "不得产生展平名副本");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pin 单层项目条目：name/description/originSessionId 全部原样透传", () => {
  const root = freshRoot();
  try {
    const scope = "projects/p-0123456789abcdef";
    const projectRoot = join(root, ...scope.split("/"), "memory");
    const original = `---
name: "flat"
description: "带 originSessionId 的条目"
metadata:
  type: project
node_type: "memory"
originSessionId: "sess_abc"
---

正文
`;
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, "flat.md"), original, "utf8");
    pinRuntimeEntry({ storageRoot: root, scope, rootKey: "project", file: "flat.md", pinned: true, log: silentLog });
    const raw = readFileSync(join(projectRoot, "flat.md"), "utf8");
    const front = parseFrontmatterHead(raw);
    assert.equal(front.name, "flat");
    assert.equal(front.description, "带 originSessionId 的条目");
    assert.equal(front.pinned, true);
    assert.match(raw, /originSessionId: "sess_abc"/, "originSessionId 必须原样透传");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("解 pin（pinned=false）同样不碰 name", () => {
  const root = freshRoot();
  try {
    const scope = "projects/p-0123456789abcdef";
    const projectRoot = join(root, ...scope.split("/"), "memory");
    seedEntry(projectRoot, "a/b.md", "正文");
    pinRuntimeEntry({ storageRoot: root, scope, rootKey: "project", file: "a/b.md", pinned: true, log: silentLog });
    pinRuntimeEntry({ storageRoot: root, scope, rootKey: "project", file: "a/b.md", pinned: false, log: silentLog });
    const raw = readFileSync(join(projectRoot, "a", "b.md"), "utf8");
    const front = parseFrontmatterHead(raw);
    assert.equal(front.name, "a/b", "解 pin 也不得改 name");
    assert.equal(front.pinned, false, "解 pin 后 pinned 应为假");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("写后校验口径：嵌套条目 name 与真实相对路径逐字一致（applyOps 落盘即可过校验）", () => {
  const root = freshRoot();
  try {
    const projectRoot = join(root, "memory");
    mkdirSync(projectRoot, { recursive: true });
    // 走真实写路径（applyOps）落一个嵌套条目：写后回读校验的 expectedName
    // 必须是真实相对路径，否则嵌套条目全部被判「name 与文件名不一致」而回滚。
    const result = applyOps(projectRoot, [
      { action: "write", name: "x/y/z.md", type: "project", title: "Z", description: "d", content: "正文" },
    ], { storageRoot: root, originSessionId: "s-1", log: silentLog });
    assert.equal(result.writes, 1, "嵌套条目必须写成功（不被写后校验误回滚）");
    assert.equal(result.verifyFailed, 0);
    const front = parseFrontmatterHead(readFileSync(join(projectRoot, "x", "y", "z.md"), "utf8"));
    assert.equal(front.name, "x/y/z");
    // 索引链接目标与磁盘路径一致
    const index = readFileSync(join(projectRoot, "MEMORY.md"), "utf8");
    assert.match(index, /\]\(x\/y\/z\.md\)/, "索引链接必须是真实相对路径");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// pin-roundtrip：`pinned` 真源字段在五条「覆盖既有条目」写路径上的透传 roundtrip
// （RUNTIME-FORMAT.md §5.2 / §十四⑥；FORMAT.md §二 pin 契约 / §八 FORMAT_VERSION=2）。
//
// 五条覆写路径（与本文件用例一一对应）：
//   ① 面板保存        PUT /entry → updateEntry → renderGlobalEntry
//   ② 提取覆写全局    applyScopedOps → writeEntryDirect → renderGlobalEntry
//   ③ 提取覆写项目    applyOps → renderMemoryFile
//   ④ 导入覆盖        POST /import → planImport → writeEntryDirect → renderGlobalEntry
//   ⑤ 漏传兜底        显式不带 pinned 的覆盖调用（writeEntryDirect / updateEntry）——
//                    必须读原文 frontmatter 保留，漏传不得剥 pin
// 另有渲染原语（仅 true 时写、字段序在 metadata 之后 node_type 之前）、解析宽容口径、
// 跨分类移动保留 pin、显式 pinned:false 解 pin、以及 v1→v2 迁移位（无数据迁移）的钉子。
//
// ---- 自拆改验证法（本文件不用真的放坏代码，改一处验证一次即可）----
// 这套测试的意义在于「透传漏一处必红」。自变异步骤：
//   1. 删掉/短路任意一处透传（例：renderGlobalEntry 里 `if (pinned === true)` 改成不写，
//      或 writeEntryDirect 的 `const keptPinned = ...` 改成 `false`，或 applyOps 里
//      `pinned: pinnedOfContent(...)` 改成 `false`，或 updateEntry 的 keptPinned 改成 false）；
//   2. 只跑 `node --test test/pin-roundtrip.test.mjs`；
//   3. 预期：对应用例（①/②/③/⑤）**必红**，其余透传路径不受影响仍绿——红了说明该路径的
//      测试真的钉住了它，绿了说明用例没咬住，先补用例再谈修代码；
//   4. 还原被删的那一行，全部通过即验证完成。
// 五条路径互相独立：任何一条漏透传，只有它的用例会红（这正是「五条路径各一条测试」的意义）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { API_PREFIX, makeApiRoutes } from "../lib/api.js";
import { applyOps, applyScopedOps, renderMemoryFile } from "../lib/extract.js";
import { FORMAT_VERSION, formatPath, resetFormatCache } from "../lib/format.js";
import {
  categoryDir,
  createEntry,
  parsePinnedHead,
  readEntry,
  renderGlobalEntry,
  updateEntry,
  writeEntryDirect,
} from "../lib/global-store.js";
import { ensureFormat } from "../lib/format.js";

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-pin-"));
}
function freshProject() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-pin-proj-"));
}
/** 条目盘上原文（含 frontmatter）。 */
function rawGlobal(storageRoot, categoryId, name) {
  return readFileSync(join(categoryDir(storageRoot, categoryId), name), "utf8");
}
/** 条目是否 pinned（走生产解析器，不用正则自证）。 */
function isPinned(raw) {
  return parsePinnedHead(raw) === true;
}
/** 项目条目短 sha1（applyOps 覆盖闸要求：整份文件文本 sha1 前 8 hex）。 */
function shortSha1(text) {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 8);
}

// ---- API 最小 harness（只用于 ①面板保存 与 ④导入覆盖；与 test/api.test.mjs 同构）----

function mockReq({ method, url, body }) {
  const req = new Readable({
    read() {
      if (body !== void 0) this.push(typeof body === "string" ? body : JSON.stringify(body));
      this.push(null);
    },
  });
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1:3080" };
  req.socket = { remoteAddress: "127.0.0.1" };
  req.destroy = () => {};
  return req;
}
function mockRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(chunk) {
      this.body = chunk ?? "";
    },
    get headersSent() {
      return this.status !== 0;
    },
  };
}
async function callApi(storageRoot, { method, path, body }) {
  const routes = makeApiRoutes({ storageRoot, log: silentLog, onGlobalWrite: () => {} });
  const handler = routes[0].handler;
  const req = mockReq({ method, url: path, body });
  const res = mockRes();
  await handler(req, res);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

// ---- 渲染原语：仅 true 时写、字段序 metadata 之后 node_type 之前 ----

test("renderGlobalEntry：pinned 仅 true 时写出，序在 metadata 块之后、node_type 之前", () => {
  const pinned = renderGlobalEntry({ name: "a", description: "d", pinned: true, content: "正文" });
  const head = pinned.split("\n---")[0];
  const lines = head.split("\n");
  const typeIdx = lines.indexOf("  type: global");
  const pinnedIdx = lines.indexOf("pinned: true");
  const nodeTypeIdx = lines.indexOf('node_type: "memory"');
  assert.ok(typeIdx >= 0, "metadata.type 必须在");
  assert.ok(pinnedIdx > typeIdx, "pinned 必须在 metadata 块之后");
  assert.ok(nodeTypeIdx > pinnedIdx, "pinned 必须在 node_type 之前");
  // 非 true 一律不写（false / undefined / 字符串 "true" 都不算——渲染侧只认严格布尔真）
  for (const value of [void 0, false, "true", 1]) {
    const raw = renderGlobalEntry({ name: "a", description: "d", pinned: value, content: "正文" });
    assert.doesNotMatch(raw, /pinned:/, `pinned=${JSON.stringify(value)} 不应写出该字段`);
  }
});

test("renderMemoryFile：pinned 仅 true 时写出，序在 metadata 块之后、node_type 之前", () => {
  const pinned = renderMemoryFile({ name: "a", description: "d", type: "project", originSessionId: "s", pinned: true, content: "正文" });
  const lines = pinned.split("\n---")[0].split("\n");
  const typeIdx = lines.indexOf("  type: project");
  const pinnedIdx = lines.indexOf("pinned: true");
  const nodeTypeIdx = lines.indexOf('node_type: "memory"');
  assert.ok(pinnedIdx > typeIdx, "pinned 必须在 metadata 块之后");
  assert.ok(nodeTypeIdx > pinnedIdx, "pinned 必须在 node_type 之前");
  for (const value of [void 0, false, "true", 1]) {
    assert.doesNotMatch(
      renderMemoryFile({ name: "a", description: "d", type: "project", originSessionId: "s", pinned: value, content: "正文" }),
      /pinned:/,
      `pinned=${JSON.stringify(value)} 不应写出该字段`,
    );
  }
});

test("parsePinnedHead：宽容口径（true / \"true\" 为真，其余为假；不认 metadata 子块）", () => {
  const head = (body) => `---\nname: "a"\ndescription: "d"\n${body}node_type: "memory"\n---\n\n正文\n`;
  assert.equal(parsePinnedHead(head("pinned: true\n")), true);
  assert.equal(parsePinnedHead(head('pinned: "true"\n')), true);
  assert.equal(parsePinnedHead(head('pinned: "TRUE"\n')), true);
  assert.equal(parsePinnedHead(head("pinned: false\n")), false);
  assert.equal(parsePinnedHead(head('pinned: "false"\n')), false);
  assert.equal(parsePinnedHead(head("pinned: yes\n")), false);
  assert.equal(parsePinnedHead(head("")), false, "字段缺失 = 非 pinned");
  assert.equal(parsePinnedHead("没有 frontmatter\npinned: true\n"), false, "无 frontmatter 不认");
  // metadata 子块里同名字段不算（pin 契约是顶层字段）
  assert.equal(parsePinnedHead(head("metadata:\n  type: global\n  pinned: true\n")), false);
});

// ---- ① 面板保存（PUT /entry → updateEntry）----

test("① 面板保存：updateEntry 链保留既有 pinned（未显式给 pinned）", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "long-term", { title: "Pinned fact", description: "旧", content: "旧正文", name: "pinned-fact.md", pinned: true });
    assert.equal(isPinned(rawGlobal(root, "long-term", "pinned-fact.md")), true, "前置：条目已 pinned");

    const res = await callApi(root, {
      method: "PUT",
      path: `${API_PREFIX}entry`,
      body: { category: "long-term", name: "pinned-fact.md", title: "Pinned fact v2", description: "新", content: "新正文" },
    });
    assert.equal(res.status, 200);
    const raw = rawGlobal(root, "long-term", "pinned-fact.md");
    assert.match(raw, /新正文/, "正文已更新");
    assert.equal(isPinned(raw), true, "面板保存不得剥掉 pinned");
    assert.equal(readEntry(root, "long-term", "pinned-fact.md").content, "新正文");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("① 面板保存 + 跨分类移动：pin 跟着条目走（updateEntry → createEntry）", () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "Movable", content: "正文", name: "movable.md", pinned: true });
    const moved = updateEntry(root, "work-profile", "movable.md", { toCategoryId: "long-term", content: "移动后正文" });
    assert.equal(moved.categoryId, "long-term");
    const raw = rawGlobal(root, "long-term", moved.name);
    assert.equal(isPinned(raw), true, "跨分类移动必须保留 pinned");
    assert.match(raw, /移动后正文/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updateEntry：显式 pinned:false 能解 pin（显式值优先于原文保留）", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "current-focus", { title: "Toggle", content: "正文", name: "toggle.md", pinned: true });
    const off = updateEntry(root, "current-focus", "toggle.md", { content: "改正文", pinned: false });
    assert.equal(off.name, "toggle.md");
    assert.equal(isPinned(rawGlobal(root, "current-focus", "toggle.md")), false, "显式 false 应解 pin");
    const on = updateEntry(root, "current-focus", "toggle.md", { pinned: true });
    assert.equal(isPinned(rawGlobal(root, "current-focus", "toggle.md")), true, "显式 true 应重新 pin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ② 提取覆写全局条目（applyScopedOps → writeEntryDirect）----

test("② 提取覆写全局条目：applyScopedOps 覆盖保留 pinned", () => {
  const storageRoot = freshRoot();
  const projectRoot = freshProject();
  try {
    createEntry(storageRoot, "work-profile", { title: "Global pinned", description: "旧钩子", content: "旧正文", name: "global-pinned.md", pinned: true });
    const result = applyScopedOps({ storageRoot, projectRoot }, [
      { action: "write", name: "global-pinned.md", title: "Global pinned v2", description: "新钩子", content: "提取写入的新正文", scope: "global:work-profile" },
    ], { originSessionId: "s-1", log: silentLog });
    assert.equal(result.writes, 1, "全局覆写应成功");
    const raw = rawGlobal(storageRoot, "work-profile", "global-pinned.md");
    assert.match(raw, /提取写入的新正文/);
    assert.equal(isPinned(raw), true, "提取覆写全局条目不得剥掉 pinned");
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("② 提取新增全局条目：不带 pinned（新条目不该凭空继承 pin）", () => {
  const storageRoot = freshRoot();
  const projectRoot = freshProject();
  try {
    applyScopedOps({ storageRoot, projectRoot }, [
      { action: "write", name: "fresh-global.md", title: "Fresh", description: "钩子", content: "全新的", scope: "global:current-focus" },
    ], { originSessionId: "s-1", log: silentLog });
    assert.equal(isPinned(rawGlobal(storageRoot, "current-focus", "fresh-global.md")), false);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---- ③ 提取覆写项目条目（applyOps → renderMemoryFile）----

test("③ 提取覆写项目条目：applyOps 覆盖保留 pinned（带正确 sha1）", () => {
  const storageRoot = freshRoot();
  const projectRoot = freshProject();
  try {
    // 项目条目先按生产渲染器写一份 pinned 条目（模拟 pin 端点已落盘的状态）
    const pinnedFile = renderMemoryFile({
      name: "proj-pinned",
      description: "项目钩子",
      type: "project",
      originSessionId: "s-0",
      pinned: true,
      content: "项目旧正文",
    });
    writeFileSync(join(projectRoot, "proj-pinned.md"), pinnedFile, "utf8");

    const result = applyOps(projectRoot, [
      {
        action: "write",
        name: "proj-pinned.md",
        type: "project",
        title: "Proj pinned",
        description: "项目钩子 v2",
        content: "提取写入的项目新正文",
        sha1: shortSha1(pinnedFile),
      },
    ], { originSessionId: "s-1", storageRoot, log: silentLog });
    assert.equal(result.writes, 1, "项目覆写应成功（未被 sha1 闸拦）");
    const raw = readFileSync(join(projectRoot, "proj-pinned.md"), "utf8");
    assert.match(raw, /提取写入的项目新正文/);
    assert.equal(parsePinnedHead(raw), true, "提取覆写项目条目不得剥掉 pinned");
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("③ 盲写降级（未带 sha1）路径：旧文原样保留 ⇒ pinned 仍在", () => {
  const storageRoot = freshRoot();
  const projectRoot = freshProject();
  try {
    const pinnedFile = renderMemoryFile({ name: "blind", description: "d", type: "project", originSessionId: "s-0", pinned: true, content: "旧正文" });
    writeFileSync(join(projectRoot, "blind.md"), pinnedFile, "utf8");
    const result = applyOps(projectRoot, [
      { action: "write", name: "blind.md", type: "project", title: "Blind", description: "d", content: "新正文（降级追加）" },
    ], { originSessionId: "s-1", storageRoot, log: silentLog });
    assert.equal(result.blindWriteDowngrades, 1);
    const raw = readFileSync(join(projectRoot, "blind.md"), "utf8");
    assert.equal(parsePinnedHead(raw), true, "降级追加保留旧 frontmatter ⇒ pin 不丢");
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---- ④ 导入覆盖（POST /import → writeEntryDirect）----

test("④ 导入覆盖：导入同名条目保留既有 pinned", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "Same", description: "旧", content: "旧内容", name: "same.md", pinned: true });
    const res = await callApi(root, {
      method: "POST",
      path: `${API_PREFIX}import`,
      body: {
        category: "work-profile",
        format: "json",
        payload: { entries: [{ name: "same.md", title: "Same", content: "导入的新内容" }] },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.overwritten, 1, "前置：确实走了覆盖分支");
    const raw = rawGlobal(root, "work-profile", "same.md");
    assert.match(raw, /导入的新内容/);
    assert.equal(isPinned(raw), true, "导入覆盖不得剥掉 pinned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ⑤ 漏传兜底：显式不带 pinned 的覆盖调用 ----

test("⑤ 漏传兜底（writeEntryDirect）：未传 pinned 时从原文保留；没有原文 = 非 pinned", () => {
  const root = freshRoot();
  try {
    createEntry(root, "long-term", { title: "Keep me", content: "旧", name: "keep-me.md", pinned: true });
    // 调用方完全没提 pinned（旧代码/第三方调用形态）
    writeEntryDirect(root, "long-term", { name: "keep-me.md", title: "Keep me v2", content: "新" });
    assert.equal(isPinned(rawGlobal(root, "long-term", "keep-me.md")), true, "漏传 pinned 必须从原文保留");
    // 纯新增（盘上无原文）→ 非 pinned，不凭空 pin
    writeEntryDirect(root, "long-term", { name: "brand-new.md", title: "New", content: "全新" });
    assert.equal(isPinned(rawGlobal(root, "long-term", "brand-new.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⑤ 漏传兜底（updateEntry）：未传 pinned 时从原文保留", () => {
  const root = freshRoot();
  try {
    createEntry(root, "user-profile", { title: "User pinned", content: "旧", name: "user-pinned.md", pinned: true });
    updateEntry(root, "user-profile", "user-pinned.md", { title: "改标题" });
    assert.equal(isPinned(rawGlobal(root, "user-profile", "user-pinned.md")), true, "updateEntry 漏传不得剥 pin");
    // 无 pin 的条目经同路径覆盖后也不该被凭空 pin
    createEntry(root, "user-profile", { title: "Plain", content: "旧", name: "plain.md" });
    updateEntry(root, "user-profile", "plain.md", { content: "新" });
    assert.equal(isPinned(rawGlobal(root, "user-profile", "plain.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⑤ 漏传兜底（applyScopedOps 全局覆写）：未带 pinned 的 op 也保留原文 pin", () => {
  const storageRoot = freshRoot();
  const projectRoot = freshProject();
  try {
    createEntry(storageRoot, "long-term", { title: "LT", content: "旧", name: "lt.md", pinned: true });
    applyScopedOps({ storageRoot, projectRoot }, [
      { action: "write", name: "lt.md", title: "LT v2", description: "d", content: "新", scope: "global:long-term" },
    ], { originSessionId: "s-1", log: silentLog });
    assert.equal(isPinned(rawGlobal(storageRoot, "long-term", "lt.md")), true);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---- FORMAT_VERSION 1 → 2（迁移位：无数据迁移，只补写标记）----

test("FORMAT_VERSION=2：v1 标记升级为 v2 且不改写任何条目文件", () => {
  resetFormatCache();
  const root = freshRoot();
  try {
    createEntry(root, "long-term", { title: "Legacy", content: "旧数据", name: "legacy.md" });
    const before = rawGlobal(root, "long-term", "legacy.md");
    writeFileSync(formatPath(root), JSON.stringify({ formatVersion: 1 }) + "\n", "utf8");
    resetFormatCache();
    assert.equal(FORMAT_VERSION, 2);
    const result = ensureFormat(root, silentLog);
    assert.equal(result.ok, true);
    assert.equal(result.stamped, true);
    assert.equal(result.migratedFrom, 1);
    assert.equal(result.formatVersion, 2);
    assert.equal(JSON.parse(readFileSync(formatPath(root), "utf8")).formatVersion, 2, "标记被补写为 2");
    assert.equal(rawGlobal(root, "long-term", "legacy.md"), before, "v1→v2 无数据迁移：条目文件一字未改");
    // v2 标记下旧条目照常可写（缺省 pinned = 非 pinned）
    writeEntryDirect(root, "long-term", { name: "legacy.md", title: "Legacy", content: "升级后改写" });
    assert.equal(isPinned(rawGlobal(root, "long-term", "legacy.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetFormatCache();
  }
});

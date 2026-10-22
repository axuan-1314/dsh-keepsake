// runtime-api：运行时记忆层 REST 端点组（RUNTIME-FORMAT v2.1 §十一 API / §6.2 淘汰归档全序列 /
// §6.4 归档移回 / §五 pin / §八 强制重编）的契约验收。
// 与 test/runtime-compile.test.mjs 分层：那边验编译器纯函数与产物落盘；这边验端点契约与
// 「搬移唯一入口」（lib/runtime-archive.js）的全序列副作用——快照/审计/索引对账/重编无断链。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { API_PREFIX, makeApiRoutes } from "../lib/api.js";
import { createBackup, createEntry, parsePinnedHead, restoreBackup, sweepTmpOrphans } from "../lib/global-store.js";
import { renderArchivedEntry } from "../lib/runtime-archive.js";
import { ensureCompiled, readRuntimeManifest } from "../lib/runtime.js";
import { EVICT_AUDIT_FILE_NAME } from "../lib/runtime-log.js";
import { acquireExtractLock } from "../lib/safety.js";

const silentLog = { info() {}, warn() {}, error() {} };
const PROJECT_SCOPE = "projects/demo-0123456789abcdef";
/** 超配额标题：MEMORY.md 配额 10240 字节，11500 字符的 title（不截断）必装不下 → 淘汰候选。 */
const BIG_TITLE = `Big-${"T".repeat(11500)}`;
const BIG_PROJECT_TITLE = `Proj-${"P".repeat(11500)}`;

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-runtime-api-"));
}

function mockReq({ method, url, body, headers = {}, remoteAddress = "127.0.0.1" }) {
  const req = new Readable({
    read() {
      if (body !== void 0) this.push(typeof body === "string" ? body : JSON.stringify(body));
      this.push(null);
    },
  });
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1:3080", ...headers };
  req.socket = { remoteAddress };
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

/** 写一条全局条目（frontmatter 形态同 renderGlobalEntry；pinned 顶层布尔）。 */
function writeGlobalEntry(root, category, file, { title, description = "", pinned = false, body = "正文" } = {}) {
  const dir = join(root, "global", category);
  mkdirSync(dir, { recursive: true });
  const name = file.replace(/\.md$/i, "");
  const lines = ["---", `name: "${name}"`, `title: "${title ?? name}"`, `description: "${description}"`, "metadata:", "  type: global"];
  if (pinned) lines.push("pinned: true");
  lines.push('node_type: "memory"', "---", "", body, "");
  const target = join(dir, file);
  writeFileSync(target, lines.join("\n"), "utf8");
  return target;
}

/** 写一条项目条目（metadata.type 决定去向）。 */
function writeProjectEntry(root, scope, file, { title, description = "", body = "正文", type = "project", originSessionId = "s-test", pinned = false } = {}) {
  const dir = join(root, ...scope.split("/"), "memory");
  mkdirSync(dir, { recursive: true });
  const name = file.split("/").pop().replace(/\.md$/i, "");
  const lines = ["---", `name: "${name}"`];
  if (title !== undefined) lines.push(`title: "${title}"`);
  lines.push(`description: "${description}"`, "metadata:", `  type: ${type}`);
  if (pinned) lines.push("pinned: true");
  lines.push('node_type: "memory"', `originSessionId: "${originSessionId}"`, "---", "", body, "");
  const target = join(dir, ...file.split("/"));
  writeFileSync(target, lines.join("\n"), "utf8");
  return target;
}

/** 产物无断链断言：产物里每个 Markdown 链接（从产物目录出发的相对路径）都指向存在的文件。 */
function assertProductsHealthy(root, scope) {
  const dir = join(root, "runtime", ...scope.split("/"));
  for (const name of ["USER.md", "MEMORY.md"]) {
    const product = join(dir, name);
    if (!existsSync(product)) continue;
    const text = readFileSync(product, "utf8");
    for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
      assert.ok(existsSync(resolve(dir, m[1])), `产物断链（${scope}/${name}）：${m[1]}`);
    }
  }
}

function readAudit(root) {
  const raw = readFileSync(join(root, EVICT_AUDIT_FILE_NAME), "utf8").trim();
  return raw.length === 0 ? [] : raw.split("\n").map((line) => JSON.parse(line));
}

// ---- 归档渲染原语（§6.3 schema） ----

test("renderArchivedEntry：origin 三字段可选；pinned 仅 true 时写（序在 metadata 后 node_type 前）；title 缺省补 name", () => {
  const withAll = renderArchivedEntry({
    name: "a",
    title: "A",
    description: "d",
    pinned: true,
    content: "正文",
    originProject: "projects/x-0123456789abcdef",
    originType: "project",
    originSessionId: "s1",
  });
  const head = withAll.split("\n---")[0].split("\n");
  const idx = (needle) => head.findIndex((line) => line === needle);
  assert.ok(idx("  type: global") >= 0, "全局 schema：type 恒为 global");
  assert.ok(idx("pinned: true") > idx("  type: global"), "pinned 在 metadata 块之后");
  assert.ok(idx('node_type: "memory"') > idx("pinned: true"), "pinned 在 node_type 之前");
  assert.ok(idx('originProject: "projects/x-0123456789abcdef"') > idx('node_type: "memory"'), "origin 三字段在 node_type 之后");
  assert.ok(idx('originType: "project"') > idx('originProject: "projects/x-0123456789abcdef"'));
  assert.ok(idx('originSessionId: "s1"') > idx('originType: "project"'));
  assert.match(withAll, /正文/);
  // 可选字段全部缺省：不写 pinned / 不写 origin
  const bare = renderArchivedEntry({ name: "foo", description: "d", content: "x" });
  assert.doesNotMatch(bare, /pinned:/);
  assert.doesNotMatch(bare, /origin/);
  assert.match(bare, /title: "foo"/, "title 缺省补 = name");
});

// ---- GET runtime/<scope>：只读契约 ----

test("GET runtime/<scope>：无产物 404；compile 后 200 字段齐全；未知/非法 scope 404；方法不匹配 405", async () => {
  const root = freshRoot();
  try {
    // ① 无产物（未编译过）→ 404，不触发编译
    const miss = await callApi(root, { method: "GET", path: `${API_PREFIX}runtime/global` });
    assert.equal(miss.status, 404);
    assert.ok(miss.json.error);
    assert.equal(existsSync(join(root, "runtime")), false, "GET 不得触发编译写盘");

    // ② 编译后 200：字段契约 {scope,user:{text,bytes,quotaBytes},memory:{…},status,candidates}
    writeGlobalEntry(root, "user-profile", "me.md", { title: "Me", description: "用户" });
    writeGlobalEntry(root, "work-profile", "big.md", { title: BIG_TITLE, description: "太大" });
    const compile = await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/global/compile` });
    assert.equal(compile.status, 200);
    const got = await callApi(root, { method: "GET", path: `${API_PREFIX}runtime/global` });
    assert.equal(got.status, 200);
    const j = got.json;
    assert.equal(j.scope, "global");
    assert.match(j.user.text, /AUTO-GENERATED/);
    assert.equal(j.user.bytes, Buffer.byteLength(j.user.text, "utf8"));
    assert.equal(j.user.quotaBytes, 4096);
    assert.equal(j.memory.quotaBytes, 10240);
    assert.equal(j.memory.bytes, Buffer.byteLength(j.memory.text, "utf8"));
    assert.equal(j.status, "ok");
    assert.equal(j.candidates, 1, "big.md 装不下 → 淘汰候选 1");
    assert.equal(j.evictCandidates[0].file, "big.md");

    // ③ scope 目录不存在 → 404；正则不匹配形态 → 404
    const ghost = await callApi(root, { method: "GET", path: `${API_PREFIX}runtime/projects/nope-0123456789abcdef` });
    assert.equal(ghost.status, 404);
    const badForm = await callApi(root, { method: "GET", path: `${API_PREFIX}runtime/projects/UPPER-0123456789abcdef` });
    assert.equal(badForm.status, 404, "大写 slug 不符合 scope 正则");
    const badPath = await callApi(root, { method: "GET", path: `${API_PREFIX}runtime/foo` });
    assert.equal(badPath.status, 404);

    // ④ 路径可识别、方法不匹配 → 405（与面板 405 语义统一）
    const wrongMethod = await callApi(root, { method: "DELETE", path: `${API_PREFIX}runtime/global` });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.json.code, "E_METHOD");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- POST runtime/<scope>/compile 与 runtime/compile-all ----

test("POST runtime/<scope>/compile：强制重编返回 diff 摘要 + compile-journal trigger=panel；未知 scope 404", async () => {
  const root = freshRoot();
  try {
    writeGlobalEntry(root, "work-profile", "a.md", { title: "A", description: "小条目" });
    const res = await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/global/compile` });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.scope, "global");
    assert.equal(res.json.selected, 1);
    assert.equal(res.json.candidates, 0);
    assert.equal(res.json.overQuota, false);
    assert.equal(typeof res.json.bytes.user, "number");
    assert.equal(typeof res.json.bytes.memory, "number");
    assert.ok(existsSync(join(root, "runtime", "global", "USER.md")));
    assert.ok(existsSync(join(root, "runtime", "global", "MEMORY.md")));
    // journal：面板触发记 trigger=panel（§九）
    const journal = readFileSync(join(root, "runtime", "compile-journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(journal.at(-1).trigger, "panel");
    assert.equal(journal.at(-1).scope, "global");
    // 强制重编不看缓存：再调一次仍走真编译（journal +1）
    await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/global/compile` });
    assert.equal(readFileSync(join(root, "runtime", "compile-journal.jsonl"), "utf8").trim().split("\n").length, 2);
    // 未知 scope / 非法形态 → 404
    const miss = await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/projects/nope-0123456789abcdef/compile` });
    assert.equal(miss.status, 404);
    // 非法 body 形态不适用（compile 无 body 要求）
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST runtime/compile-all：逐 scope 摘要数组（global + projects 全量）", async () => {
  const root = freshRoot();
  try {
    writeGlobalEntry(root, "work-profile", "g.md", { title: "G", description: "全局" });
    writeProjectEntry(root, PROJECT_SCOPE, "p1.md", { title: "P1", description: "项目一" });
    writeProjectEntry(root, "projects/zeta-fedcba9876543210", "p2.md", { title: "P2", description: "项目二" });
    const res = await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/compile-all` });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.failed, 0);
    assert.deepEqual(res.json.scopes.map((s) => s.scope), ["global", "projects/demo-0123456789abcdef", "projects/zeta-fedcba9876543210"]);
    for (const item of res.json.scopes) {
      assert.equal(item.ok, true);
      assert.equal(typeof item.selected, "number");
      assert.equal(typeof item.candidates, "number");
      assert.equal(typeof item.bytes.user, "number");
      assert.ok(existsSync(join(root, "runtime", ...item.scope.split("/"), "runtime.json")), `产物应存在：${item.scope}`);
    }
    assertProductsHealthy(root, PROJECT_SCOPE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- POST runtime/<scope>/pin ----

test("runtime pin（global scope）：global:<category> 切 pin 改 frontmatter 并重编；跨 scope 形态/未知分类/坏 body 400；条目不存在 404", async () => {
  const root = freshRoot();
  try {
    writeGlobalEntry(root, "user-profile", "me.md", { title: "Me", description: "用户" });
    // 切 pin：true
    const on = await callApi(root, {
      method: "POST",
      path: `${API_PREFIX}runtime/global/pin`,
      body: { rootKey: "global:user-profile", file: "me.md", pinned: true },
    });
    assert.equal(on.status, 200);
    assert.equal(on.json.ok, true);
    assert.equal(on.json.pinned, true);
    assert.equal(on.json.manifest.scope, "global");
    const raw = readFileSync(join(root, "global", "user-profile", "me.md"), "utf8");
    assert.match(raw, /^pinned: true$/m, "pin 写进 frontmatter 顶层");
    assert.equal(parsePinnedHead(raw), true);
    // 重编已发生：manifest 里该条 pinned=true
    const manifest = readRuntimeManifest(root, "global");
    const entry = manifest.user.entries.find((e) => e.file === "me.md");
    assert.equal(entry.pinned, true);
    assert.equal(entry.included, true, "pinned 条目优先入选");
    // 解 pin：false
    const off = await callApi(root, {
      method: "POST",
      path: `${API_PREFIX}runtime/global/pin`,
      body: { rootKey: "global:user-profile", file: "me.md", pinned: false },
    });
    assert.equal(off.status, 200);
    assert.equal(parsePinnedHead(readFileSync(join(root, "global", "user-profile", "me.md"), "utf8")), false);
    // 400：未知分类 / rootKey=project 出现在 global scope / pinned 非布尔 / 缺字段
    for (const body of [
      { rootKey: "global:nope", file: "me.md", pinned: true },
      { rootKey: "project", file: "me.md", pinned: true },
      { rootKey: "global:user-profile", file: "me.md", pinned: "yes" },
      { rootKey: "global:user-profile", file: "me.md" },
      { file: "me.md", pinned: true },
    ]) {
      const bad = await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/global/pin`, body });
      assert.equal(bad.status, 400, `应 400：${JSON.stringify(body)}`);
      assert.ok(bad.json.error);
    }
    // 404：条目不存在
    const ghost = await callApi(root, {
      method: "POST",
      path: `${API_PREFIX}runtime/global/pin`,
      body: { rootKey: "global:user-profile", file: "ghost.md", pinned: true },
    });
    assert.equal(ghost.status, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime pin（project scope）：rootKey=project 指本 scope 项目条目；global:<category> 在项目 scope 400", async () => {
  const root = freshRoot();
  try {
    writeProjectEntry(root, PROJECT_SCOPE, "keep.md", { title: "Keep", description: "项目条目" });
    const on = await callApi(root, {
      method: "POST",
      path: `${API_PREFIX}runtime/${PROJECT_SCOPE}/pin`,
      body: { rootKey: "project", file: "keep.md", pinned: true },
    });
    assert.equal(on.status, 200);
    assert.equal(on.json.manifest.scope, PROJECT_SCOPE);
    const raw = readFileSync(join(root, ...PROJECT_SCOPE.split("/"), "memory", "keep.md"), "utf8");
    assert.equal(parsePinnedHead(raw), true, "项目条目 pin 写进 frontmatter");
    assert.match(raw, /metadata:\n  type: project/, "原 metadata.type 保留");
    assert.match(raw, /originSessionId: "s-test"/, "originSessionId 保留");
    // global:<category> 出现在项目 scope → 400
    const cross = await callApi(root, {
      method: "POST",
      path: `${API_PREFIX}runtime/${PROJECT_SCOPE}/pin`,
      body: { rootKey: "global:work-profile", file: "keep.md", pinned: true },
    });
    assert.equal(cross.status, 400);
    // 条目不存在 → 404
    const ghost = await callApi(root, {
      method: "POST",
      path: `${API_PREFIX}runtime/${PROJECT_SCOPE}/pin`,
      body: { rootKey: "project", file: "ghost.md", pinned: true },
    });
    assert.equal(ghost.status, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- POST runtime/<scope>/evict：归档全序列（§6.2） ----

test("evict 全序列（全局条目）：锁→快照→归档重写→索引对账→审计→重编无断链；候选清单执行后清空", async () => {
  const root = freshRoot();
  try {
    writeGlobalEntry(root, "work-profile", "keep.md", { title: "Keep", description: "保留的", body: "保留正文" });
    const bigRaw = readFileSync(writeGlobalEntry(root, "work-profile", "big.md", { title: BIG_TITLE, description: "被淘汰的", body: "大条目正文" }), "utf8");
    // 源索引预置该条索引行：归档后必须被删（否则不残留悬挂行）
    const srcIndexPath = join(root, "global", "work-profile", "MEMORY.md");
    writeFileSync(srcIndexPath, "- [Big](big.md) — 将被归档\n", "utf8");
    // 预置 long-term 索引前文：归档加行时前文保留
    const ltDir = join(root, "global", "long-term");
    mkdirSync(ltDir, { recursive: true });
    writeFileSync(join(ltDir, "MEMORY.md"), "旧前文\n", "utf8");

    const res = await callApi(root, {
      method: "POST",
      path: `${API_PREFIX}runtime/global/evict`,
      body: { files: [{ rootKey: "global:work-profile", file: "big.md" }] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.archived, 1);
    assert.deepEqual(res.json.skipped, [], "无跳过（候选新鲜）");
    const snapshotDir = res.json.snapshotDir;
    assert.match(snapshotDir, /^backups\/evict-/, "响应带快照目录");

    // ① 手术式快照：被搬文件原样（逐字节）在 <snapshotDir>/1-big.md
    const snapCopy = join(root, ...snapshotDir.split("/"), "1-big.md");
    assert.ok(existsSync(snapCopy), "快照副本存在");
    assert.equal(readFileSync(snapCopy, "utf8"), bigRaw, "快照 = 原文逐字节");

    // ② 源文件已移出
    assert.equal(existsSync(join(root, "global", "work-profile", "big.md")), false);

    // ③ long-term 归档条目 schema（§6.3）：title 保原值 / type=global / origin 三字段承载出处 / 正文原样
    const ltRaw = readFileSync(join(ltDir, "big.md"), "utf8");
    assert.match(ltRaw, /metadata:\n  type: global/);
    assert.match(ltRaw, new RegExp(`title: "Big-T+`), "title 原样保留");
    assert.match(ltRaw, /originType: "work-profile"/, "全局条目归档：originType=原分类");
    assert.doesNotMatch(ltRaw, /originProject/, "全局条目归档省略 originProject");
    assert.doesNotMatch(ltRaw, /pinned:/, "源非 pinned：归档不凭空写 pin");
    assert.match(ltRaw, /大条目正文/, "正文原样");

    // ④ 索引对账：源根删行、long-term 加行（前文保留）
    assert.doesNotMatch(readFileSync(srcIndexPath, "utf8"), /big\.md/, "源索引行已剔除");
    const ltIndex = readFileSync(join(ltDir, "MEMORY.md"), "utf8");
    assert.match(ltIndex, /旧前文/, "既有前文保留");
    // 长标题索引行走的是 clampIndexLine 整行 150 截断（生产口径）——断言「加了一行指向 big.md 的候选」
    const ltLine = ltIndex.split("\n").find((l) => l.includes("Big-"));
    assert.ok(ltLine !== undefined, "long-term 索引已加该条");
    assert.match(ltLine, /big\.md|…$/, "索引行含该条目（超长行按既有口径截断）");

    // ⑤ 持久审计：evict-audit.jsonl 单行、字段齐全（§6.2-6）
    const audit = readAudit(root);
    assert.equal(audit.length, 1);
    assert.deepEqual(Object.keys(audit[0]).sort(), ["actor", "at", "file", "from", "rootKey", "scope", "snapshot", "to"]);
    assert.equal(audit[0].actor, "panel");
    assert.equal(audit[0].scope, "global");
    assert.equal(audit[0].rootKey, "global:work-profile");
    assert.equal(audit[0].file, "big.md");
    assert.equal(audit[0].from, "global/work-profile/big.md");
    assert.equal(audit[0].to, "global/long-term/big.md");
    assert.equal(audit[0].snapshot, `${snapshotDir}/1-big.md`);
    assert.ok(Number.isFinite(Date.parse(audit[0].at)));

    // ⑥ 失效+重编：产物已重建、无断链；候选清单因条目离开候选池而清空
    assert.ok(existsSync(join(root, "runtime", "global", "MEMORY.md")), "归档后已重编");
    assertProductsHealthy(root, "global");
    const got = await callApi(root, { method: "GET", path: `${API_PREFIX}runtime/global` });
    assert.equal(got.status, 200);
    assert.equal(got.json.candidates, 0, "归档执行后候选自然消失");
    assert.ok(got.json.memory.text.includes("keep.md"), "保留条目仍在产物里");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evict 全序列（项目条目）：originProject/originType/originSessionId 落档；移回复原 schema；重名 -2 避让", async () => {
  const root = freshRoot();
  try {
    // 无 title（项目条目常态）→ 归档补 title=name；长 title 把条目顶出配额成为候选
    writeProjectEntry(root, PROJECT_SCOPE, "big-project.md", { description: "项目大条目", body: "项目正文", type: "project", originSessionId: "sess-abc", pinned: false });
    // 覆写 title（补 title=name 的用例在 restore 场景单独覆盖）
    const big = readFileSync(join(root, ...PROJECT_SCOPE.split("/"), "memory", "big-project.md"), "utf8")
      .replace('name: "big-project"', `name: "big-project"\ntitle: "BigProject-${"P".repeat(11500)}"`);
    writeFileSync(join(root, ...PROJECT_SCOPE.split("/"), "memory", "big-project.md"), big, "utf8");
    const res = await callApi(root, {
      method: "POST",
      path: `${API_PREFIX}runtime/${PROJECT_SCOPE}/evict`,
      body: { files: [{ rootKey: "project", file: "big-project.md" }] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.archived, 1);
    const ltRaw = readFileSync(join(root, "global", "long-term", "big-project.md"), "utf8");
    assert.match(ltRaw, new RegExp(`originProject: "${PROJECT_SCOPE}"`));
    assert.match(ltRaw, /originType: "project"/);
    assert.match(ltRaw, /originSessionId: "sess-abc"/);
    assert.match(ltRaw, /title: "BigProject-P+/, "title 原样保留（不截断）");
    // 项目产物已重编（scope 级失效）
    assert.ok(existsSync(join(root, "runtime", ...PROJECT_SCOPE.split("/"), "runtime.json")));

    // 归档移回：落回原项目 → 原 schema（无 origin 字段、type 恢复、originSessionId 保留）
    const restore = await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/global/archive/restore`, body: { file: "big-project.md" } });
    assert.equal(restore.status, 200);
    assert.equal(restore.json.scope, PROJECT_SCOPE);
    assert.equal(restore.json.name, "big-project.md");
    const backRaw = readFileSync(join(root, ...PROJECT_SCOPE.split("/"), "memory", "big-project.md"), "utf8");
    assert.match(backRaw, /metadata:\n  type: project/, "type 恢复为 project");
    assert.doesNotMatch(backRaw, /originProject|originType/, "origin 三字段已剥（originSessionId 是原 schema 字段，保留）");
    assert.match(backRaw, /originSessionId: "sess-abc"/);
    assert.equal(parsePinnedHead(backRaw), false);
    assert.equal(existsSync(join(root, "global", "long-term", "big-project.md")), false);

    // 重编后：条目重新进候选池（mtime 新，排序靠前属预期——§6.4）。
    // 注意：项目 schema 无 title（以 name 兼作标题），移回重写后条目变小 → 本轮不再是淘汰候选；
    // 真正的「重新入选」判据是它在产物里（候选池内且装得下）。
    const got = await callApi(root, { method: "GET", path: `${API_PREFIX}runtime/${PROJECT_SCOPE}` });
    assert.equal(got.status, 200);
    const entry = readRuntimeManifest(root, PROJECT_SCOPE).memory.entries.find((e) => e.file === "big-project.md");
    assert.ok(entry !== undefined, "移回后条目重新进候选池（出现在 manifest）");
    assert.equal(entry.included, true, "移回后重新入选（在产物正文里）");
    assert.ok(got.json.memory.text.includes("big-project.md"), "产物行指向移回条目");
    assertProductsHealthy(root, PROJECT_SCOPE);

    // 重名 -2 避让：手搓一条从本项目归档的条目（原位置放同名占位）→ 移回应落 -2
    writeFileSync(
      join(root, "global", "long-term", "big-project.md"),
      `---\nname: "big-project"\ntitle: "big-project"\ndescription: "再归档一份"\nmetadata:\n  type: global\nnode_type: "memory"\noriginProject: "${PROJECT_SCOPE}"\noriginType: "project"\n---\n\n第二份正文\n`,
      "utf8",
    );
    writeProjectEntry(root, PROJECT_SCOPE, "big-project.md", { title: "占位", description: "占住名字", body: "小" });
    const restored2 = await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/global/archive/restore`, body: { file: "big-project.md" } });
    assert.equal(restored2.status, 200);
    assert.equal(restored2.json.name, "big-project-2.md", "重名 -2 避让");
    assert.ok(existsSync(join(root, ...PROJECT_SCOPE.split("/"), "memory", "big-project-2.md")));
    assert.ok(existsSync(join(root, ...PROJECT_SCOPE.split("/"), "memory", "big-project.md")), "原占位条目未被动");
    assert.match(readFileSync(join(root, ...PROJECT_SCOPE.split("/"), "memory", "big-project-2.md"), "utf8"), /第二份正文/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evict：提取批锁被占 → 409 LOCKED 不搬任何文件；释放后重试成功", async () => {
  const root = freshRoot();
  try {
    writeGlobalEntry(root, "work-profile", "big.md", { title: BIG_TITLE, description: "候选" });
    const lock = acquireExtractLock(root);
    assert.equal(lock.acquired, true, "前置：测试先占住批锁");
    try {
      const blocked = await callApi(root, {
        method: "POST",
        path: `${API_PREFIX}runtime/global/evict`,
        body: { files: [{ rootKey: "global:work-profile", file: "big.md" }] },
      });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.json.code, "LOCKED");
      assert.equal(existsSync(join(root, "global", "work-profile", "big.md")), true, "被拒不得搬文件");
      assert.equal(existsSync(join(root, "global", "long-term")), false, "被拒不得写归档");
      assert.equal(existsSync(join(root, EVICT_AUDIT_FILE_NAME)), false, "被拒不得写审计");
    } finally {
      lock.release();
    }
    const retry = await callApi(root, {
      method: "POST",
      path: `${API_PREFIX}runtime/global/evict`,
      body: { files: [{ rootKey: "global:work-profile", file: "big.md" }] },
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.archived, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evict skipped：过期候选（不在当前清单/跨 rootKey）进 skipped[] 带原因且不搬；空 files/坏项 400", async () => {
  const root = freshRoot();
  try {
    writeGlobalEntry(root, "work-profile", "big.md", { title: BIG_TITLE, description: "候选" });
    const res = await callApi(root, {
      method: "POST",
      path: `${API_PREFIX}runtime/global/evict`,
      body: {
        files: [
          { rootKey: "global:work-profile", file: "big.md" }, // 真候选
          { rootKey: "global:work-profile", file: "not-a-candidate.md" }, // 不在清单
          { rootKey: "global:user-profile", file: "big.md" }, // rootKey 与真实位置不符
          { rootKey: "project", file: "big.md" }, // global scope 无项目条目
        ],
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.archived, 1);
    assert.equal(res.json.skipped.length, 3);
    for (const item of res.json.skipped) assert.equal(item.reason, "not-candidate", "过期候选原因显式");
    assert.equal(existsSync(join(root, "global", "long-term", "not-a-candidate.md")), false, "跳过者不得产生归档");
    assert.equal(existsSync(join(root, "global", "long-term", "big.md")), true);
    // 400：空 files / 非数组 / 项字段缺失
    for (const body of [{}, { files: [] }, { files: "x" }, { files: [{ rootKey: "global:work-profile" }] }, { files: [null] }]) {
      const bad = await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/global/evict`, body });
      assert.equal(bad.status, 400, `应 400：${JSON.stringify(body)}`);
    }
    // 未知 scope → 404
    const miss = await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/projects/nope-0123456789abcdef/evict`, body: { files: [{ rootKey: "project", file: "x.md" }] } });
    assert.equal(miss.status, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evict 尾部滚动清理：backups/evict-* 保留最近 10 份（含本轮新建），裁最旧", async () => {
  const root = freshRoot();
  try {
    // 造 11 份旧 evict-* 目录（名字即 ts 序）
    mkdirSync(join(root, "backups"), { recursive: true });
    for (let i = 1; i <= 11; i += 1) {
      mkdirSync(join(root, "backups", `evict-2020-01-01T00-00-00-000Z-${String(i).padStart(2, "0")}`));
    }
    writeGlobalEntry(root, "work-profile", "big.md", { title: BIG_TITLE, description: "候选" });
    const res = await callApi(root, {
      method: "POST",
      path: `${API_PREFIX}runtime/global/evict`,
      body: { files: [{ rootKey: "global:work-profile", file: "big.md" }] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.archived, 1);
    const dirs = readdirSync(join(root, "backups"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("evict-"))
      .map((d) => d.name);
    assert.equal(dirs.length, 10, "12 份（11 旧 + 本轮）裁到 10");
    assert.equal(dirs.includes("evict-2020-01-01T00-00-00-000Z-01"), false, "最旧被裁");
    assert.equal(dirs.includes("evict-2020-01-01T00-00-00-000Z-02"), false);
    assert.equal(dirs.includes("evict-2020-01-01T00-00-00-000Z-03"), true, "次新保留");
    assert.ok(dirs.includes(res.json.snapshotDir.split("/").pop()), "本轮快照保留");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evict 归档重写：项目条目无 title 时补 title=name（§6.3）", async () => {
  const root = freshRoot();
  try {
    // 无 title + 长 title 不可用 → 用 description 撑不进配额：补 title=name 用例用手搓候选替代
    // （编译侧已覆盖「title 缺省 → entryTitle 回落 name」；这里只验 renderArchivedEntry 的补值行为）
    const raw = renderArchivedEntry({ name: "no-title-entry", description: "d", content: "正文" });
    assert.match(raw, /title: "no-title-entry"/);
    assert.match(raw, /name: "no-title-entry"/);
    // 全局条目归档保留原 title（不覆盖为 name）
    const withTitle = renderArchivedEntry({ name: "a", title: "真标题", description: "d", content: "x" });
    assert.match(withTitle, /title: "真标题"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- POST runtime/global/archive/restore：归档移回（§6.4） ----

test("restore：全局归档条目移回原分类（剥 origin、type=global、pin 透传）；缺 origin 400；不存在 404；穿越名 400", async () => {
  const root = freshRoot();
  try {
    // 直接手搓归档条目的两面：① 全局来源（originType=分类，pinned 透传）
    const ltDir = join(root, "global", "long-term");
    mkdirSync(ltDir, { recursive: true });
    writeFileSync(
      join(ltDir, "legacy.md"),
      '---\nname: "legacy"\ntitle: "Legacy"\ndescription: "旧条目"\nmetadata:\n  type: global\npinned: true\nnode_type: "memory"\noriginType: "work-profile"\n---\n\n旧正文\n',
      "utf8",
    );
    const res = await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/global/archive/restore`, body: { file: "legacy.md" } });
    assert.equal(res.status, 200);
    assert.equal(res.json.scope, "global");
    assert.equal(res.json.to, "global/work-profile/legacy.md");
    const raw = readFileSync(join(root, "global", "work-profile", "legacy.md"), "utf8");
    assert.match(raw, /metadata:\n  type: global/);
    assert.doesNotMatch(raw, /originType|originProject/, "origin 已剥");
    assert.equal(parsePinnedHead(raw), true, "移回重写保留 pin（§5.2-3）");
    assert.match(raw, /旧正文/);
    assert.equal(existsSync(join(ltDir, "legacy.md")), false);
    assert.doesNotMatch(readFileSync(join(ltDir, "MEMORY.md"), "utf8"), /legacy\.md/, "long-term 索引删行");
    assert.match(readFileSync(join(root, "global", "work-profile", "MEMORY.md"), "utf8"), /\[Legacy\]\(legacy\.md\)/, "目标索引加行");

    // ② 缺 origin 字段 → 400（不猜落点）
    writeFileSync(join(ltDir, "noorigin.md"), '---\nname: "noorigin"\ntitle: "No"\ndescription: "d"\nmetadata:\n  type: global\nnode_type: "memory"\n---\n\n正文\n', "utf8");
    const noOrigin = await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/global/archive/restore`, body: { file: "noorigin.md" } });
    assert.equal(noOrigin.status, 400);
    assert.equal(existsSync(join(ltDir, "noorigin.md")), true, "400 时不动文件");

    // ③ 不存在 → 404；穿越名 → 400；缺 file → 400
    assert.equal((await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/global/archive/restore`, body: { file: "ghost.md" } })).status, 404);
    assert.equal((await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/global/archive/restore`, body: { file: "../../evil.md" } })).status, 400);
    assert.equal((await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/global/archive/restore`, body: {} })).status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore：锁被占 → 409 不搬；释放后成功", async () => {
  const root = freshRoot();
  try {
    const ltDir = join(root, "global", "long-term");
    mkdirSync(ltDir, { recursive: true });
    writeFileSync(join(ltDir, "legacy.md"), '---\nname: "legacy"\ntitle: "Legacy"\ndescription: "d"\nmetadata:\n  type: global\nnode_type: "memory"\noriginType: "current-focus"\n---\n\n正文\n', "utf8");
    const lock = acquireExtractLock(root);
    try {
      const blocked = await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/global/archive/restore`, body: { file: "legacy.md" } });
      assert.equal(blocked.status, 409);
      assert.equal(existsSync(join(ltDir, "legacy.md")), true, "被拒不动文件");
    } finally {
      lock.release();
    }
    const ok = await callApi(root, { method: "POST", path: `${API_PREFIX}runtime/global/archive/restore`, body: { file: "legacy.md" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.to, "global/current-focus/legacy.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- D：sweepTmpOrphans 认领 runtime/ tmp + restoreBackup 失效 runtime ----

test("sweepTmpOrphans：认领 runtime/ 下 .tmp- 残留（根与 scope 目录都扫），不误删正常产物", () => {
  const root = freshRoot();
  try {
    writeGlobalEntry(root, "work-profile", "a.md", { title: "A", description: "d" });
    ensureCompiled({ storageRoot: root, scope: "global" });
    writeProjectEntry(root, PROJECT_SCOPE, "p.md", { title: "P", description: "d" });
    ensureCompiled({ storageRoot: root, scope: PROJECT_SCOPE });
    // 造残留：runtime 根（compile-journal 轮转 tmp）、global scope（原子写 tmp）、项目 scope
    // 2026-10-22：`.tmp-*` 改为到龄才清（防误删另一实例在途写入），故先造陈旧 mtime。
    const old = (Date.now() - 3 * 3_600_000) / 1000;
    const tmp1 = join(root, "runtime", "compile-journal.jsonl.tmp-1-2");
    const tmp2 = join(root, "runtime", "global", "runtime.json.tmp-3-4");
    const tmp3 = join(root, "runtime", ...PROJECT_SCOPE.split("/"), "USER.md.tmp-5-6");
    writeFileSync(tmp1, "half", "utf8");
    writeFileSync(tmp2, "half", "utf8");
    writeFileSync(tmp3, "half", "utf8");
    for (const f of [tmp1, tmp2, tmp3]) utimesSync(f, old, old);
    const removed = sweepTmpOrphans(root);
    assert.equal(removed, 3, "三处 runtime tmp 全部认领");
    assert.equal(existsSync(join(root, "runtime", "compile-journal.jsonl.tmp-1-2")), false);
    assert.equal(existsSync(join(root, "runtime", "global", "runtime.json.tmp-3-4")), false);
    assert.equal(existsSync(join(root, "runtime", ...PROJECT_SCOPE.split("/"), "USER.md.tmp-5-6")), false);
    // 正常产物不被误删
    assert.ok(existsSync(join(root, "runtime", "global", "runtime.json")), "正常清单保留");
    assert.ok(existsSync(join(root, "runtime", "global", "MEMORY.md")), "正常产物保留");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreBackup 成功后 runtime 全失效（备份项目集与现存集可能不一致），下次编译自愈", () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "V1", content: "恢复点" });
    ensureCompiled({ storageRoot: root, scope: "global" });
    const runtimeManifest = join(root, "runtime", "global", "runtime.json");
    assert.ok(existsSync(runtimeManifest), "前置：产物已在盘上");
    const backupId = createBackup(root, "test");
    assert.equal(restoreBackup(root, backupId), true);
    assert.equal(existsSync(runtimeManifest), false, "备份恢复后 runtime 全部失效");
    // compile-journal 在 runtime 根（不在 scope 目录内），全失效只清 scope 目录 → 观测日志保留。
    // 这是真实不变量（此前写成 `|| true` 恒真断言，等于没测）。
    assert.ok(existsSync(join(root, "runtime", "compile-journal.jsonl")), "scope 失效不删编译观测日志（它在 runtime 根）");
    // 自愈：下一次 ensureCompiled 重编
    const manifest = ensureCompiled({ storageRoot: root, scope: "global" });
    assert.equal(manifest.status, "ok");
    assert.ok(existsSync(runtimeManifest));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

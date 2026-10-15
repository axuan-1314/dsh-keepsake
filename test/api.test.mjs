// api：REST 路由匹配与校验、loopback 守卫负路径、导入 dryRun 解析。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { API_PREFIX, isLoopbackRequest, makeApiRoutes, planImport } from "../lib/api.js";
import { categoryDir, createEntry, listEntries, readPersona, listBackups } from "../lib/global-store.js";
import { listSurgicalSnapshots, surgicalRoot, acquireExtractLock } from "../lib/safety.js";

const silentLog = { info() {}, warn() {}, error() {} };

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-api-"));
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

async function callApi(storageRoot, { method, path, body, headers, remoteAddress }) {
  const routes = makeApiRoutes({ storageRoot, log: silentLog, onGlobalWrite: () => {} });
  const handler = routes[0].handler;
  assert.equal(routes[0].kind, "prefix");
  assert.equal(routes[0].path, API_PREFIX.replace(/\/$/, "")); // 内核 prefix 不带尾斜杠（实证）
  const req = mockReq({ method, url: path, body, headers, remoteAddress });
  const res = mockRes();
  await handler(req, res);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}

// ---- loopback 守卫 ----

test("isLoopbackRequest：四种 remoteAddress 形态", () => {
  const base = { headers: { host: "127.0.0.1:3080" }, socket: {} };
  assert.equal(isLoopbackRequest({ ...base, socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.equal(isLoopbackRequest({ ...base, socket: { remoteAddress: "::1" } }), true);
  assert.equal(isLoopbackRequest({ ...base, socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
  assert.equal(isLoopbackRequest({ ...base, socket: { remoteAddress: "10.0.0.5" } }), false);
});

test("isLoopbackRequest：host 头校验", () => {
  const socket = { remoteAddress: "127.0.0.1" };
  assert.equal(isLoopbackRequest({ headers: { host: "localhost:3080" }, socket }), true);
  assert.equal(isLoopbackRequest({ headers: { host: "[::1]:3080" }, socket }), true);
  assert.equal(isLoopbackRequest({ headers: { host: "evil.com" }, socket }), false);
  assert.equal(isLoopbackRequest({ headers: {}, socket }), false);
});

test("isLoopbackRequest：sec-fetch-site cross-site 拒绝；origin 同源校验", () => {
  const socket = { remoteAddress: "127.0.0.1" };
  const host = "127.0.0.1:3080";
  assert.equal(isLoopbackRequest({ headers: { host, "sec-fetch-site": "cross-site" }, socket }), false);
  assert.equal(isLoopbackRequest({ headers: { host, "sec-fetch-site": "same-origin" }, socket }), true);
  assert.equal(isLoopbackRequest({ headers: { host, origin: "http://127.0.0.1:3080" }, socket }), true);
  assert.equal(isLoopbackRequest({ headers: { host, origin: "https://evil.example" }, socket }), false);
  assert.equal(isLoopbackRequest({ headers: { host, origin: "://bad" }, socket }), false);
});

// ---- 路由匹配与校验 ----

test("GET state：轻态六要素（开关/称呼/人设摘要/计数/项目概览/corrupt）", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "W", content: "工" });
    const { status, json } = await callApi(root, { method: "GET", path: `${API_PREFIX}state` });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    // v0.4.0：settings 增写入安全面三项（surgicalKeep/trashKeepDays/hardfactPolicy）
    assert.deepEqual(json.settings, {
      conversationMemory: true,
      projectMemory: true,
      globalExtraction: true,
      surgicalKeep: 30,
      trashKeepDays: 30,
      hardfactPolicy: "warn",
      corrupt: false,
    });
    assert.equal(json.corrupt, false);
    assert.equal(json.counts.byCategory["work-profile"], 1);
    assert.equal(json.counts.global, 1);
    assert.ok(json.persona && typeof json.persona.excerpt === "string");
    assert.ok(Array.isArray(json.projects));
    assert.equal(json.addressing.dshName, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("非 loopback 请求 → 403", async () => {
  const root = freshRoot();
  try {
    const { status } = await callApi(root, { method: "GET", path: `${API_PREFIX}state`, remoteAddress: "10.1.2.3" });
    assert.equal(status, 403);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未知端点 → 404；方法不匹配 → 405（语义统一）", async () => {
  const root = freshRoot();
  try {
    const a = await callApi(root, { method: "GET", path: `${API_PREFIX}nope` });
    assert.equal(a.status, 404);
    const b = await callApi(root, { method: "DELETE", path: `${API_PREFIX}state` });
    assert.equal(b.status, 405); // 路径可识别、方法不支持
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PUT settings：合并写入 + 下轮 GET 可见", async () => {
  const root = freshRoot();
  try {
    const put = await callApi(root, { method: "PUT", path: `${API_PREFIX}settings`, body: { conversationMemory: false } });
    assert.equal(put.status, 200);
    assert.equal(put.json.settings.conversationMemory, false);
    const get = await callApi(root, { method: "GET", path: `${API_PREFIX}state` });
    assert.equal(get.json.settings.conversationMemory, false);
    assert.equal(get.json.settings.projectMemory, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("settings：嵌入服务配置写入 + /state 回显（apiKey 脱敏）+ 校验 400", async () => {
  const root = freshRoot();
  try {
    const put = await callApi(root, {
      method: "PUT",
      path: `${API_PREFIX}settings`,
      body: { embedding: { enabled: true, baseUrl: "http://127.0.0.1:11434/v1/embeddings", model: "nomic-embed-text", provider: "ollama", apiKey: "secret" } },
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.settings.embedding.enabled, true);
    assert.equal(put.json.settings.embedding.apiKeySet, true, "apiKey 脱敏为 apiKeySet");
    assert.equal(put.json.settings.embedding.apiKey, void 0, "不回显明文 key");
    const get = await callApi(root, { method: "GET", path: `${API_PREFIX}state` });
    assert.equal(get.json.settings.embedding.model, "nomic-embed-text");
    assert.equal(get.json.settings.embedding.apiKeySet, true);
    assert.equal(get.json.settings.embedding.apiKey, void 0);
    // 非法：开启但缺端点 / 非 http(s) scheme → 400（不落 500）
    const bad = await callApi(root, { method: "PUT", path: `${API_PREFIX}settings`, body: { embedding: { enabled: true, model: "m" } } });
    assert.equal(bad.status, 400);
    const bad2 = await callApi(root, { method: "PUT", path: `${API_PREFIX}settings`, body: { embedding: { enabled: false, baseUrl: "file:///x" } } });
    assert.equal(bad2.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persona：GET 默认模板 → PUT 写入 → POST reset 恢复", async () => {
  const root = freshRoot();
  try {
    const before = await callApi(root, { method: "GET", path: `${API_PREFIX}persona` });
    assert.equal(before.json.isDefault, true);
    assert.ok(before.json.defaultTemplate);
    const put = await callApi(root, { method: "PUT", path: `${API_PREFIX}persona`, body: { content: "我的人设正文" } });
    assert.equal(put.status, 200);
    assert.equal(readPersona(root).content, "我的人设正文");
    const bad = await callApi(root, { method: "PUT", path: `${API_PREFIX}persona`, body: { content: 123 } });
    assert.equal(bad.status, 400);
    const reset = await callApi(root, { method: "POST", path: `${API_PREFIX}persona/reset` });
    assert.equal(reset.status, 200);
    assert.match(reset.json.content, /补充人设/);
    assert.ok(reset.json.backupId, "persona reset 前应自动留档备份");
    const after = await callApi(root, { method: "GET", path: `${API_PREFIX}persona` });
    assert.equal(after.json.isDefault, true, "reset 后 GET 应回到默认态（回归）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PUT persona：超 100KB 上限 → 413 或 400（分级体积上限）", async () => {
  const root = freshRoot();
  try {
    const big = "x".repeat(101 * 1024);
    const { status } = await callApi(root, { method: "PUT", path: `${API_PREFIX}persona`, body: JSON.stringify({ content: big }) });
    assert.ok(status === 413 || status === 400);
    assert.equal(readPersona(root).isDefault, true); // 未写入
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("addressing：GET/PUT 往返", async () => {
  const root = freshRoot();
  try {
    const put = await callApi(root, { method: "PUT", path: `${API_PREFIX}addressing`, body: { dshName: "小助手", userAlias: "朋友" } });
    assert.equal(put.status, 200);
    const get = await callApi(root, { method: "GET", path: `${API_PREFIX}addressing` });
    assert.deepEqual({ dshName: get.json.dshName, userAlias: get.json.userAlias }, { dshName: "小助手", userAlias: "朋友" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("category：GET 条目列表 / POST 新增 / 非法分类 404", async () => {
  const root = freshRoot();
  try {
    const created = await callApi(root, {
      method: "POST",
      path: `${API_PREFIX}category/work-profile/entries`,
      body: { title: "API Entry", description: "经 API", content: "正文" },
    });
    assert.equal(created.status, 200);
    assert.equal(created.json.name, "api-entry.md");
    const list = await callApi(root, { method: "GET", path: `${API_PREFIX}category/work-profile` });
    assert.equal(list.json.entries.length, 1);
    assert.equal(list.json.entries[0].content, "正文");
    const bad = await callApi(root, { method: "GET", path: `${API_PREFIX}category/evil` });
    assert.equal(bad.status, 404);
    const noContent = await callApi(root, { method: "POST", path: `${API_PREFIX}category/work-profile/entries`, body: { title: "无正文" } });
    assert.equal(noContent.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("entry：PUT 改条目（含跨分类移动）/ DELETE 删条目", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "To edit", content: "旧" });
    const put = await callApi(root, {
      method: "PUT",
      path: `${API_PREFIX}entry`,
      body: { category: "work-profile", name: "to-edit.md", content: "新", toCategory: "long-term" },
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.categoryId, "long-term");
    const del = await callApi(root, { method: "DELETE", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "to-edit.md" } });
    assert.equal(del.json.existed, true);
    const ghost = await callApi(root, { method: "PUT", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "ghost.md", content: "x" } });
    assert.equal(ghost.status, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- PUT entry 手动保存前留档（v0.4.0 安全面）----

test("PUT entry 覆盖既有：留手术快照（内容=旧文）+ 响应带 preSaveSnapshotId + 可恢复旧文", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "long-term", { title: "E", name: "e.md", content: "旧正文" });
    const dir = categoryDir(root, "long-term");
    const before = readFileSync(join(dir, "e.md"), "utf8"); // 含 frontmatter 的完整原文
    const put = await callApi(root, { method: "PUT", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "e.md", content: "新正文" } });
    assert.equal(put.status, 200);
    assert.equal(typeof put.json.preSaveSnapshotId, "string");
    // 快照在盘上，且文件内容=旧文（逐字节）
    const snaps = listSurgicalSnapshots(root);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].id, put.json.preSaveSnapshotId);
    assert.equal(snaps[0].originSessionId, "panel");
    const copy = join(surgicalRoot(root), put.json.preSaveSnapshotId, "files", "global", "long-term", "e.md");
    assert.equal(readFileSync(copy, "utf8"), before);
    // 条目已是新文
    assert.match(readFileSync(join(dir, "e.md"), "utf8"), /新正文/);
    // 从该快照恢复 → 拿回旧文
    const restored = await callApi(root, { method: "POST", path: `${API_PREFIX}snapshots/restore`, body: { id: put.json.preSaveSnapshotId } });
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.json.restored, ["e.md"]);
    assert.equal(readFileSync(join(dir, "e.md"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PUT entry 留档失败 fail-closed：503 E_SNAPSHOT_PRESAVE 且旧文逐字节不变", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "long-term", { title: "E", name: "e.md", content: "旧正文" });
    const dir = categoryDir(root, "long-term");
    const before = readFileSync(join(dir, "e.md"), "utf8");
    // 破坏快照根：把 backups/surgical 占成一个文件 → createSurgicalSnapshot 的 mkdir 必炸
    mkdirSync(join(root, "backups"), { recursive: true });
    writeFileSync(join(root, "backups", "surgical"), "占位", "utf8");
    const put = await callApi(root, { method: "PUT", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "e.md", content: "新正文" } });
    assert.equal(put.status, 503);
    assert.equal(put.json.code, "E_SNAPSHOT_PRESAVE");
    // 旧文一字未动（逐字节）
    assert.equal(readFileSync(join(dir, "e.md"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PUT entry 纯新增（条目不存在）→ 404 且不建任何快照", async () => {
  const root = freshRoot();
  try {
    const put = await callApi(root, { method: "PUT", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "ghost.md", content: "x" } });
    assert.equal(put.status, 404);
    assert.equal(put.json.preSaveSnapshotId, void 0);
    assert.equal(listSurgicalSnapshots(root).length, 0);
    assert.equal(existsSync(join(root, "backups", "surgical")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PUT entry 与提取批互斥：锁被占 → 409 LOCKED 不建快照旧文不动；释放后保存成功", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "long-term", { title: "E", name: "e.md", content: "旧正文" });
    const dir = categoryDir(root, "long-term");
    const before = readFileSync(join(dir, "e.md"), "utf8");
    const lock = acquireExtractLock(root);
    assert.equal(lock.acquired, true, "前置：测试先占住批锁");
    try {
      const put = await callApi(root, { method: "PUT", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "e.md", content: "新正文" } });
      assert.equal(put.status, 409);
      assert.equal(put.json.code, "LOCKED");
      assert.equal(listSurgicalSnapshots(root).length, 0, "被拒的保存不得建快照（不白耗保留配额）");
      assert.equal(readFileSync(join(dir, "e.md"), "utf8"), before, "旧文一字未动");
    } finally {
      lock.release();
    }
    const retry = await callApi(root, { method: "PUT", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "e.md", content: "新正文" } });
    assert.equal(retry.status, 200);
    assert.match(readFileSync(join(dir, "e.md"), "utf8"), /新正文/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("category reset：先自动备份再清空（后悔药留档）", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "user-profile", { title: "Keep safe", content: "别丢" });
    const reset = await callApi(root, { method: "POST", path: `${API_PREFIX}category/user-profile/reset` });
    assert.equal(reset.status, 200);
    assert.equal(reset.json.removed, 1);
    assert.ok(reset.json.backupId);
    const backups = listBackups(root);
    assert.equal(backups.length, 1);
    assert.equal(backups[0].reason, "reset:user-profile");
    assert.equal(listEntries(root, "user-profile").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("export：全量 JSON + content-disposition 附件头", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "long-term", { title: "L", content: "长" });
    const { status, json, headers } = await callApi(root, { method: "GET", path: `${API_PREFIX}export` });
    assert.equal(status, 200);
    assert.equal(json.categories["long-term"].length, 1);
    assert.match(headers["content-disposition"], /attachment; filename="dsh-keepsake-export-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup list/restore：列备份 + 恢复（恢复前自动再备份）", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "V1", content: "第一版" });
    const reset = await callApi(root, { method: "POST", path: `${API_PREFIX}category/work-profile/reset` });
    const backupId = reset.json.backupId;
    const list = await callApi(root, { method: "GET", path: `${API_PREFIX}backup/list` });
    assert.equal(list.json.backups.length, 1);
    const restore = await callApi(root, { method: "POST", path: `${API_PREFIX}backup/restore`, body: { id: backupId } });
    assert.equal(restore.status, 200);
    assert.ok(restore.json.preRestoreBackupId); // 后悔药的后悔药
    assert.equal(listEntries(root, "work-profile").length, 1);
    assert.equal(listEntries(root, "work-profile")[0].title, "V1");
    const bad = await callApi(root, { method: "POST", path: `${API_PREFIX}backup/restore`, body: { id: "../evil" } });
    assert.equal(bad.status, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import：dryRun 预览不落盘；confirm 写入 + 覆盖计数 + 自动备份", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "Same", content: "旧内容" }); // 制造 overwrite
    const payload = {
      entries: [
        { title: "Same", content: "新内容" },
        { title: "Brand new", content: "全新" },
      ],
    };
    const dry = await callApi(root, {
      method: "POST",
      path: `${API_PREFIX}import?dryRun=1`,
      body: { category: "work-profile", format: "json", payload },
    });
    assert.equal(dry.status, 200);
    assert.equal(dry.json.dryRun, true);
    assert.equal(dry.json.plans.length, 2);
    assert.equal(dry.json.plans[0].action, "overwrite"); // 冲突标红位
    assert.equal(dry.json.plans[1].action, "add");
    assert.equal(listEntries(root, "work-profile").length, 1); // dryRun 不落盘
    const confirm = await callApi(root, {
      method: "POST",
      path: `${API_PREFIX}import`,
      body: { category: "work-profile", format: "json", payload },
    });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.json.written, 2);
    assert.equal(confirm.json.overwritten, 1);
    assert.ok(confirm.json.backupId);
    assert.equal(listEntries(root, "work-profile").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- planImport 解析（dryRun 纯函数面） ----

test("planImport：纯中文标题跨批次不撞名（确定性哈希兜底，替代按位置 entry-1/-2）", () => {
  const root = freshRoot();
  try {
    const p1 = planImport(root, { category: "long-term", format: "markdown-whole", payload: { markdown: "内容甲", title: "标题甲" } });
    const p2 = planImport(root, { category: "long-term", format: "markdown-whole", payload: { markdown: "内容乙", title: "标题乙" } });
    assert.equal(p1.plans.length, 1);
    assert.equal(p2.plans.length, 1);
    assert.match(p1.plans[0].name, /^entry-[0-9a-f]{10}\.md$/);
    assert.notEqual(p1.plans[0].name, p2.plans[0].name, "不同中文标题必须得到不同文件名");
    const p3 = planImport(root, { category: "long-term", format: "markdown-whole", payload: { markdown: "内容丙", title: "标题甲" } });
    assert.equal(p3.plans[0].name, p1.plans[0].name, "同标题同名（重导幂等）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planImport：JSON 数组与 {entries} 两种形态", () => {
  const root = freshRoot();
  try {
    const a = planImport(root, { category: "long-term", format: "json", payload: [{ title: "A", content: "一" }] });
    assert.equal(a.ok, true);
    assert.equal(a.plans[0].action, "add");
    const b = planImport(root, { category: "long-term", format: "json", payload: { entries: [{ title: "A", content: "一" }] } });
    assert.equal(b.plans.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planImport：坏条目（缺 content / 超长）跳过并记 errors", () => {
  const root = freshRoot();
  try {
    const { ok, errors, plans } = planImport(root, {
      category: "work-profile",
      format: "json",
      payload: { entries: [{ title: "无正文" }, { title: "超长", content: "x".repeat(20001) }, { title: "好", content: "行" }] },
    });
    assert.equal(ok, false); // 有 errors
    assert.equal(errors.length, 2);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].title, "好");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planImport：markdown-split 按 ## 拆条；无标题段记 error", () => {
  const root = freshRoot();
  try {
    const md = "## 第一条\n内容一\n\n## 第二条\n内容二\n## 空条\n";
    const { plans, errors } = planImport(root, { category: "current-focus", format: "markdown-split", payload: { markdown: md } });
    assert.equal(plans.length, 2);
    assert.equal(plans[0].title, "第一条");
    assert.equal(plans[0].content, "内容一");
    assert.equal(errors.length, 1); // 空条跳过
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planImport：markdown-whole 整段一条", () => {
  const root = freshRoot();
  try {
    const { plans } = planImport(root, { category: "user-profile", format: "markdown-whole", payload: { markdown: "# 我的偏好\n全在这里", title: "偏好总汇" } });
    assert.equal(plans.length, 1);
    assert.equal(plans[0].title, "偏好总汇");
    assert.match(plans[0].content, /全在这里/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planImport：未知分类 / 未知格式 / 空内容 显式报错", () => {
  const root = freshRoot();
  try {
    assert.equal(planImport(root, { category: "evil", format: "json", payload: [] }).ok, false);
    assert.equal(planImport(root, { category: "long-term", format: "yaml", payload: {} }).ok, false);
    assert.equal(planImport(root, { category: "long-term", format: "markdown-whole", payload: { markdown: "" } }).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 单项目导出 ----

test("project/:id/export：已知项目导出条目；未知项目 404；穿越形态 404", async () => {
  const root = freshRoot();
  try {
    const memDir = join(root, "projects", "demo-aabb0011223344", "memory");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "note.md"), "---\nname: note\ntitle: Note\n---\n项目条目正文\n");
    writeFileSync(join(memDir, "MEMORY.md"), "- [Note](note.md) — 索引不导出\n");
    const ok = await callApi(root, { method: "GET", path: `${API_PREFIX}project/demo-aabb0011223344/export` });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.entries.length, 1, "只导出条目不含索引");
    assert.match(ok.json.entries[0].content, /项目条目正文/);
    const miss = await callApi(root, { method: "GET", path: `${API_PREFIX}project/unknown-0000000000000000/export` });
    assert.equal(miss.status, 404);
    const evil = await callApi(root, { method: "GET", path: `${API_PREFIX}project/..%2F..%2Fetc/export` });
    assert.equal(evil.status, 404, "穿越形态不匹配 slug-hash 目录名正则");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 修复回归钉 ----

test("导入批内同名去重（dryRun 标 rename、confirm 全落盘不互覆）", async () => {
  const root = freshRoot();
  try {
    const payload = { category: "long-term", format: "json", payload: { entries: [
      { title: "My Note", content: "第一条" },
      { title: "my note", content: "第二条" },
      { title: "My  Note!", content: "第三条" },
    ] } };
    const dry = await callApi(root, { method: "POST", path: `${API_PREFIX}import?dryRun=1`, body: payload });
    assert.equal(dry.json.plans.length, 3);
    const names = dry.json.plans.map((p) => p.name);
    assert.equal(new Set(names).size, 3, "批内计划名两两不同");
    assert.equal(dry.json.plans[0].action, "add");
    assert.equal(dry.json.plans[1].action, "rename");
    assert.equal(dry.json.notes.length, 2);
    const confirm = await callApi(root, { method: "POST", path: `${API_PREFIX}import`, body: payload });
    assert.equal(confirm.json.written, 3, "written=最终落盘文件数（旧版虚报 3 实存 1）");
    assert.equal(confirm.json.failed.length, 0);
    assert.equal(listEntries(root, "long-term").length, 3, "三条都在盘上");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("条目写入超 20000 字符显式 413（不静默截断）；markdown 导入超长显式报错", async () => {
  const root = freshRoot();
  try {
    const over = "x".repeat(20001);
    const post = await callApi(root, { method: "POST", path: `${API_PREFIX}category/long-term/entries`, body: { title: "T", content: over } });
    assert.equal(post.status, 413);
    assert.equal(listEntries(root, "long-term").length, 0);
    createEntry(root, "long-term", { title: "E", name: "e.md", content: "旧" });
    const put = await callApi(root, { method: "PUT", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "e.md", content: over } });
    assert.equal(put.status, 413);
    const md = await callApi(root, { method: "POST", path: `${API_PREFIX}import?dryRun=1`, body: { category: "long-term", format: "markdown-whole", payload: { markdown: over } } });
    assert.equal(md.json.ok, false);
    assert.match(md.json.errors.join("；"), /超长/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore id 校验前置（无效 id 不白落备份）+ 半备份 404 带 code", async () => {
  const root = freshRoot();
  try {
    const before = listBackups(root).length;
    const bad = await callApi(root, { method: "POST", path: `${API_PREFIX}backup/restore`, body: { id: "../evil" } });
    assert.equal(bad.status, 404);
    assert.equal(listBackups(root).length, before, "无效 id 不触发 pre-restore 备份");
    const missing = await callApi(root, { method: "POST", path: `${API_PREFIX}backup/restore`, body: { id: "1999-01-01T00-00-00-000Z" } });
    assert.equal(missing.status, 404);
    assert.equal(listBackups(root).length, before, "不存在 id 同样不白落备份");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state：extractionFailures 计数面在场（观测口）", async () => {
  const root = freshRoot();
  try {
    const s = await callApi(root, { method: "GET", path: `${API_PREFIX}state` });
    assert.equal(s.status, 200);
    assert.equal(typeof s.json.extractionFailures, "object");
    assert.equal(typeof s.json.extractionFailures["no-route"], "number");
    assert.equal(typeof s.json.addressingCorrupt, "boolean");
    assert.equal(typeof s.json.personaCorrupt, "boolean");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state：injection 注入面字段在场（服务端恒在；缺失=旧版）", async () => {
  const root = freshRoot();
  try {
    const s = await callApi(root, { method: "GET", path: `${API_PREFIX}state` });
    assert.equal(s.status, 200);
    const inj = s.json.injection;
    assert.equal(typeof inj, "object");
    // 契约字段恒在（字段缺失=旧版宿主，面板 tolerant 消费）
    for (const k of ["count", "lastChars", "totalChars", "resends", "droppedSegments", "renderFailures", "lastAt"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(inj, k), `injection 缺字段 ${k}`);
    }
    assert.equal(typeof inj.count, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("真实 http：超长请求体返回显式 413（不再 ECONNRESET；mock 掩盖过该缺陷）", async () => {
  const { createServer } = await import("node:http");
  const root = freshRoot();
  const routes = makeApiRoutes({ storageRoot: root, log: silentLog, onGlobalWrite: () => {} });
  const server = createServer((req, res) => routes[0].handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const big = "x".repeat(120 * 1024); // 超过 persona 100KB 体积上限
    const res = await fetch(`http://127.0.0.1:${port}${API_PREFIX}persona`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: big }),
    });
    assert.equal(res.status, 413);
    const j = await res.json();
    assert.match(String(j.error), /上限/);
    assert.equal(readPersona(root).isDefault, true); // 未写入
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 存储格式只读保护（降级安全） ----

test("格式过新：写端点 503，GET /state 照常并报 writable=false", async () => {
  const root = freshRoot();
  try {
    const { writeFileSync } = await import("node:fs");
    const { formatPath, FORMAT_VERSION, resetFormatCache } = await import("../lib/format.js");
    resetFormatCache();
    writeFileSync(formatPath(root), JSON.stringify({ formatVersion: FORMAT_VERSION + 1 }), "utf8");

    const write = await callApi(root, { method: "PUT", path: `${API_PREFIX}persona`, body: { content: "不应写入" } });
    assert.equal(write.status, 503);
    assert.equal(write.json.code, "FORMAT_TOO_NEW");

    const read = await callApi(root, { method: "GET", path: `${API_PREFIX}state` });
    assert.equal(read.status, 200);
    assert.equal(read.json.format.writable, false);
    assert.equal(read.json.format.supported, false);
    assert.equal(read.json.format.formatVersion, FORMAT_VERSION + 1);
    assert.equal(readPersona(root).isDefault, true); // 只读保护下确未写入
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("格式同级/缺失：写端点放行，/state 报 writable=true", async () => {
  const root = freshRoot();
  try {
    const { resetFormatCache } = await import("../lib/format.js");
    resetFormatCache();
    const write = await callApi(root, { method: "PUT", path: `${API_PREFIX}persona`, body: { content: "正常写入" } });
    assert.equal(write.status, 200);
    assert.equal(readPersona(root).content, "正常写入");

    const read = await callApi(root, { method: "GET", path: `${API_PREFIX}state` });
    assert.equal(read.json.format.writable, true);
    assert.equal(read.json.format.supported, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 写端点 null 请求体：不再 500 ----

test("写端点 null 请求体（合法 JSON）不再 500：有必填字段者归一为 400", async () => {
  const root = freshRoot();
  try {
    const nullBody = { body: "null", headers: { "content-type": "application/json" } };
    // 修复前 JSON.parse("null") → null → handler 访问 body.xxx 抛 TypeError → 被兜成 500
    const required = [
      ["PUT", "persona"],
      ["POST", "category/work-profile/entries"],
      ["PUT", "entry"],
      ["DELETE", "entry"],
      ["POST", "import"],
      ["POST", "backup/restore"],
    ];
    for (const [method, sub] of required) {
      const { status } = await callApi(root, { method, path: `${API_PREFIX}${sub}`, ...nullBody });
      assert.equal(status, 400, `${method} ${sub} 的 null body 应为 400（修复前 500）`);
    }
    // addressing 无必填字段：null 归一为 {} 后是一次合法写入（200），关键是**不再 500**
    const addressing = await callApi(root, { method: "PUT", path: `${API_PREFIX}addressing`, ...nullBody });
    assert.notEqual(addressing.status, 500, "addressing 的 null body 不得再落 500");
    assert.equal(addressing.status, 200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- embedding/test：已存密钥只发往它所属端点（安全回归） ----

/** 起一个本机 sink 服务：记录收到的 Authorization，回一个合法嵌入响应。 */
async function startEmbedSink() {
  const { createServer } = await import("node:http");
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen.push({ authorization: req.headers.authorization, raw });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { seen, baseUrl: `http://127.0.0.1:${port}/v1/embeddings`, close: () => new Promise((r) => server.close(r)) };
}

/** 带 extraction 依赖（含生效嵌入配置）调用 embedding/test。 */
async function callEmbeddingTest(storageRoot, embeddingEffective, body) {
  const routes = makeApiRoutes({
    storageRoot,
    log: silentLog,
    onGlobalWrite: () => {},
    extraction: { triggerRetry: () => 0, inFlight: () => false, configSummary: () => ({ embeddingEffective }) },
  });
  const handler = routes[0].handler;
  const req = mockReq({ method: "POST", url: `${API_PREFIX}embedding/test`, body });
  const res = mockRes();
  await handler(req, res);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

test("embedding/test：已存密钥只发往它所属端点（不随请求体任意地址外泄）", async () => {
  const root = freshRoot();
  const eff = await startEmbedSink();
  const alt = await startEmbedSink();
  try {
    // ① 请求体自带 key → 用它发往请求体指定的地址
    const a = await callEmbeddingTest(root, { baseUrl: eff.baseUrl, model: "m", apiKey: "stored-secret" }, { baseUrl: alt.baseUrl, model: "m", apiKey: "body-key" });
    assert.equal(a.status, 200);
    assert.equal(a.json.ok, true);
    assert.equal(alt.seen.length, 1);
    assert.equal(alt.seen[0].authorization, "Bearer body-key");
    assert.equal(eff.seen.length, 0, "未向生效端点发请求");

    // ② baseUrl ≠ 生效端点且未带 key → 绝不外发已存密钥
    const b = await callEmbeddingTest(root, { baseUrl: eff.baseUrl, model: "m", apiKey: "stored-secret" }, { baseUrl: alt.baseUrl, model: "m" });
    assert.equal(b.status, 200);
    assert.equal(alt.seen.length, 2);
    assert.equal(alt.seen.at(-1).authorization, void 0, "未带 key 时不得携带已存密钥");

    // ③ baseUrl = 生效端点且未带 key → 使用已存密钥
    const c = await callEmbeddingTest(root, { baseUrl: eff.baseUrl, model: "m", apiKey: "stored-secret" }, { baseUrl: eff.baseUrl, model: "m" });
    assert.equal(c.status, 200);
    assert.equal(eff.seen.length, 1);
    assert.equal(eff.seen[0].authorization, "Bearer stored-secret");
  } finally {
    await eff.close();
    await alt.close();
    rmSync(root, { recursive: true, force: true });
  }
});

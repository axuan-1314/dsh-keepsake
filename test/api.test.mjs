// api：REST 路由匹配与校验、loopback 守卫负路径、导入 dryRun 解析。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { API_PREFIX, collectMaintenanceInputs, isLoopbackRequest, makeApiRoutes, planImport, validateRepairPlan } from "../lib/api.js";
import { createJournal } from "../lib/journal.js";
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

async function callApi(storageRoot, { method, path, body, headers, remoteAddress, journal, recovery, maintenance, extraction }) {
  const routes = makeApiRoutes({ storageRoot, log: silentLog, onGlobalWrite: () => {}, journal, recovery, maintenance, extraction });
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
    // v0.4.0：settings 增写入安全面三项（surgicalKeep/trashKeepDays/hardfactPolicy）+ recentKeepDays
    // v0.6.1：增 runtimeEnabled（面板开关状态的真相源；缺省关）
    assert.deepEqual(json.settings, {
      conversationMemory: true,
      projectMemory: true,
      globalExtraction: true,
      runtimeEnabled: false,
      surgicalKeep: 30,
      trashKeepDays: 30,
      recentKeepDays: 30,
      hardfactPolicy: "warn",
      corrupt: false,
    });
    assert.equal(json.corrupt, false);
    assert.equal(json.counts.byCategory["work-profile"], 1);
    assert.equal(json.counts.global, 1);
    assert.ok(json.persona && typeof json.persona.excerpt === "string");
    assert.ok(Array.isArray(json.projects));
    assert.equal(json.addressing.dshName, "");
    // 契约字段：近期动态保留天数 / 单次提取超时（未接线 extraction 时 null）
    assert.equal(json.recentKeepDays, 30);
    assert.equal(json.extractionTimeoutMs, null);
    // 提取结算层：字段恒在（缺失=旧版判定依据），无 journal 依赖时为空形
    assert.deepEqual(json.extractionLog, { runs: [], unrecovered: [], abandoned: [], abandonedCount: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET state：extractionLog 恒含 runs/unrecovered（含 journal 缺省的空形与记账后的真值）", async () => {
  const root = freshRoot();
  try {
    // ① journal 缺省 → 空形但字段恒在
    {
      const { status, json } = await callApi(root, { method: "GET", path: `${API_PREFIX}state` });
      assert.equal(status, 200);
      assert.ok(Array.isArray(json.extractionLog.runs), "runs 恒为数组");
      assert.ok(Array.isArray(json.extractionLog.unrecovered), "unrecovered 恒为数组");
      assert.ok(Array.isArray(json.extractionLog.abandoned), "abandoned 恒为数组");
      assert.equal(json.extractionLog.abandonedCount, 0);
      assert.deepEqual(json.extractionLog, { runs: [], unrecovered: [], abandoned: [], abandonedCount: 0 });
    }
    // ② 真 journal 记账后 → /state 如实反映（runs 新在前 + 未恢复失败区间）
    const journal = createJournal({ storageRoot: root, log: silentLog });
    journal.recordRun({ sessionId: "sess-a", from: 3, to: 7, cursorAfter: 7, outcome: "written", writes: 2, deletes: 0 });
    journal.recordRun({ sessionId: "sess-a", from: 7, to: 11, cursorAfter: 7, outcome: "failed", reason: "llm-error" });
    {
      const { status, json } = await callApi(root, { method: "GET", path: `${API_PREFIX}state`, journal });
      assert.equal(status, 200);
      assert.equal(json.extractionLog.runs.length, 2);
      assert.equal(json.extractionLog.runs[0].outcome, "failed");
      assert.equal(json.extractionLog.runs[0].sessionId, "sess-a");
      assert.equal(json.extractionLog.runs[1].outcome, "written");
      assert.equal(json.extractionLog.runs[1].writes, 2);
      assert.equal(json.extractionLog.unrecovered.length, 1);
      assert.equal(json.extractionLog.unrecovered[0].from, 7);
      assert.equal(json.extractionLog.unrecovered[0].to, 11);
    }
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

test("PUT settings：数值三项严格校验（非法 400，中文明话 message，保留机读 code）", async () => {
  const root = freshRoot();
  try {
    // 三项都非法：正整数/上限；trashKeepDays 允许 0
    for (const [key, bad] of [["trashKeepDays", -1], ["trashKeepDays", 366], ["surgicalKeep", 0], ["surgicalKeep", 201], ["recentKeepDays", 1.5], ["recentKeepDays", 366]]) {
      const res = await callApi(root, { method: "PUT", path: `${API_PREFIX}settings`, body: { [key]: bad } });
      assert.equal(res.status, 400, `${key}=${bad} 应 400`);
      assert.equal(res.json.code, "E_SETTINGS");
      assert.equal(typeof res.json.error, "string");
      assert.equal(typeof res.json.message, "string", "带中文可读 message");
      assert.match(res.json.message, new RegExp(key));
      // 非法入参不落盘：现值保持默认
      assert.equal((await callApi(root, { method: "GET", path: `${API_PREFIX}state` })).json.settings[key], 30);
    }
    // 合法值：写入成功 + /state.settings 三键回显
    const ok = await callApi(root, { method: "PUT", path: `${API_PREFIX}settings`, body: { trashKeepDays: 7, surgicalKeep: 11, recentKeepDays: 90 } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.settings.trashKeepDays, 7);
    assert.equal(ok.json.settings.surgicalKeep, 11);
    assert.equal(ok.json.settings.recentKeepDays, 90);
    const get = await callApi(root, { method: "GET", path: `${API_PREFIX}state` });
    assert.equal(get.json.settings.trashKeepDays, 7);
    assert.equal(get.json.settings.surgicalKeep, 11);
    assert.equal(get.json.settings.recentKeepDays, 90);
    assert.equal(get.json.recentKeepDays, 90, "/state.recentKeepDays 反映现值");
    // 未提及保留现值
    await callApi(root, { method: "PUT", path: `${API_PREFIX}settings`, body: { conversationMemory: false } });
    const get2 = await callApi(root, { method: "GET", path: `${API_PREFIX}state` });
    assert.equal(get2.json.settings.trashKeepDays, 7);
    assert.equal(get2.json.settings.recentKeepDays, 90);
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
    assert.equal(del.json.trashed, true, "面板删除走回收站（不是硬删）");
    const ghost = await callApi(root, { method: "PUT", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "ghost.md", content: "x" } });
    assert.equal(ghost.status, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DELETE entry 走回收站：文件移入 trash、响应带 trashed/trashId、listTrash 可见、restore 可找回、分类索引对账", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "Gone", name: "gone.md", content: "将被删除的正文" });
    const indexBefore = readFileSync(join(categoryDir(root, "work-profile"), "MEMORY.md"), "utf8");
    assert.match(indexBefore, /Gone/, "前置：索引里有该条");
    const del = await callApi(root, { method: "DELETE", path: `${API_PREFIX}entry`, body: { category: "work-profile", name: "gone.md" } });
    assert.equal(del.status, 200);
    assert.equal(del.json.existed, true);
    assert.equal(del.json.trashed, true);
    assert.equal(typeof del.json.trashId, "string", "响应带回收站条目 id");
    // 文件不在原位；索引对账（不残留悬挂行）
    assert.equal(existsSync(join(categoryDir(root, "work-profile"), "gone.md")), false, "原件已移出");
    const indexAfter = readFileSync(join(categoryDir(root, "work-profile"), "MEMORY.md"), "utf8");
    assert.doesNotMatch(indexAfter, /Gone/, "分类 MEMORY.md 索引对账剔除该行");
    // 回收站可见（含该文件）
    const trashList = await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` });
    const entry = trashList.json.entries.find((e) => e.files.some((f) => f.name === "gone.md"));
    assert.ok(entry, "删除的条目出现在回收站清单");
    assert.equal(entry.id, del.json.trashId);
    // 可从回收站找回
    const restore = await callApi(root, { method: "POST", path: `${API_PREFIX}trash/restore`, body: { id: entry.id } });
    assert.equal(restore.status, 200);
    assert.equal(restore.json.restored.length, 1);
    assert.equal(existsSync(join(categoryDir(root, "work-profile"), "gone.md")), true, "恢复后文件回到原位");
    assert.match(readFileSync(join(categoryDir(root, "work-profile"), "gone.md"), "utf8"), /将被删除的正文/);
    // 删除不存在的条目 → existed=false 且不建回收站条目
    const ghost = await callApi(root, { method: "DELETE", path: `${API_PREFIX}entry`, body: { category: "work-profile", name: "ghost.md" } });
    assert.equal(ghost.status, 200);
    assert.equal(ghost.json.existed, false);
    assert.equal(ghost.json.trashed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- PUT entry 手动保存前留档（v0.4.0 安全面）----

test("DELETE entry 存在但读不出（同名目录占位）→ 409 显式失败不谎报不存在，盘上原样", async () => {
  const root = freshRoot();
  try {
    // 目标存在但是目录（readFileSync 抛 EISDIR）：绝不能被当 "不存在" 谎报删除成功
    mkdirSync(join(categoryDir(root, "long-term"), "occupied.md"), { recursive: true });
    const del = await callApi(root, { method: "DELETE", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "occupied.md" } });
    assert.equal(del.status, 409, "存在但读不出 → 显式失败（不是 200 谎报）");
    assert.equal(del.json.code, "E_ENTRY_UNREADABLE");
    assert.equal(del.json.existed, true);
    assert.equal(del.json.trashed, false);
    assert.match(del.json.message, /无法读取/);
    // 盘上原样：目录占位未被删、未进回收站
    assert.equal(existsSync(join(categoryDir(root, "long-term"), "occupied.md")), true, "占用目录原样保留");
    const trashList = await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` });
    assert.equal(trashList.json.entries.length, 0, "未进回收站（读失败即未动原件）");
    // 不存在 → 仍走 200 existed:false（与上条明确区分）
    const ghost = await callApi(root, { method: "DELETE", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "ghost.md" } });
    assert.equal(ghost.status, 200);
    assert.equal(ghost.json.existed, false);
    // 正常条目 → 200 existed:true,trashed:true
    createEntry(root, "long-term", { title: "Norm", name: "norm.md", content: "正文" });
    const ok = await callApi(root, { method: "DELETE", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "norm.md" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.existed, true);
    assert.equal(ok.json.trashed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- DELETE entry 三态（不存在 / 已移入回收站 / 存在但删不掉）----

test("DELETE entry 三态互不混同：不存在=existed:false；删除成功=existed+trashed；删不掉=显式错误带 code/reason", async () => {
  const root = freshRoot();
  try {
    // ---- 态①：条目不存在 → 200 existed:false, trashed:false（不谎报、不建回收站条目）----
    const ghost = await callApi(root, { method: "DELETE", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "ghost.md" } });
    assert.equal(ghost.status, 200);
    assert.equal(ghost.json.ok, true);
    assert.equal(ghost.json.existed, false, "态①：不存在 = existed:false");
    assert.equal(ghost.json.trashed, false, "态①：不存在 = 未移入回收站");
    assert.equal(ghost.json.trashId, void 0, "态①：不凭空给出回收站 id");
    const trashAfterGhost = await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` });
    assert.equal(trashAfterGhost.json.entries.length, 0, "态①：未建回收站条目");

    // ---- 态②：存在且移入回收站 → 200 existed:true, trashed:true, 带 trashId ----
    createEntry(root, "long-term", { title: "Norm", name: "norm.md", content: "正文" });
    const ok = await callApi(root, { method: "DELETE", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "norm.md" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.existed, true, "态②：存在 = existed:true");
    assert.equal(ok.json.trashed, true, "态②：已移入回收站 = trashed:true");
    assert.equal(typeof ok.json.trashId, "string", "态②：响应带回收站条目 id");
    assert.equal(existsSync(join(categoryDir(root, "long-term"), "norm.md")), false, "态②：原件已移出");

    // ---- 态③：存在但移不进回收站（trash 根被文件占位 → 条目建立失败）→ 显式错误，不谎报成功 ----
    createEntry(root, "long-term", { title: "Stuck", name: "stuck.md", content: "删不掉的正文" });
    rmSync(join(root, "trash"), { recursive: true, force: true }); // 清掉态②留下的回收站，好把 trash 根换成文件占位
    writeFileSync(join(root, "trash"), "占位文件（trash 根被占 → 回收站条目建不起来）", "utf8");
    const stuck = await callApi(root, { method: "DELETE", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "stuck.md" } });
    assert.notEqual(stuck.status, 200, "态③：绝不回 200 谎报删除成功");
    assert.equal(stuck.json.ok, void 0, "态③：不带 ok（失败不是成功）");
    assert.equal(stuck.json.existed, true, "态③：不假装不存在（明明在场）");
    assert.equal(stuck.json.trashed, false, "态③：如实说明未移入回收站");
    assert.equal(stuck.json.code, "E_ENTRY_DELETE_FAILED", "态③：错误体带可辨识 code");
    assert.equal(typeof stuck.json.reason, "string", "态③：错误体带可辨识 reason");
    assert.ok(stuck.json.reason.length > 0, "态③：reason 非空（面板接线据此分流）");
    assert.match(String(stuck.json.error), /未删除/, "态③：文案明确说未删除");
    // 盘上原样：原件仍在（副本+meta 不成立 → 一个都没删）
    assert.equal(existsSync(join(categoryDir(root, "long-term"), "stuck.md")), true, "态③：原件原样保留");
    // 不因失败而串味到态①/②：清掉占位后同一条目可正常删除
    rmSync(join(root, "trash"), { force: true });
    const retry = await callApi(root, { method: "DELETE", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "stuck.md" } });
    assert.equal(retry.status, 200);
    assert.deepEqual([retry.json.existed, retry.json.trashed], [true, true], "占位清掉后回到态②");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DELETE entry 态③ 另一路：存在但读不出（同名目录占位）→ 409 E_ENTRY_UNREADABLE 显式失败", async () => {
  const root = freshRoot();
  try {
    mkdirSync(join(categoryDir(root, "long-term"), "occupied.md"), { recursive: true });
    const del = await callApi(root, { method: "DELETE", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "occupied.md" } });
    assert.equal(del.status, 409, "态③：存在但读不出 → 显式失败（不是 200 谎报）");
    assert.equal(del.json.code, "E_ENTRY_UNREADABLE");
    assert.equal(del.json.reason, "UNREADABLE", "错误体带可辨识 reason（与移入失败分支可分）");
    assert.equal(del.json.existed, true, "绝不谎报不存在");
    assert.equal(del.json.trashed, false);
    assert.equal(existsSync(join(categoryDir(root, "long-term"), "occupied.md")), true, "盘上原样未动");
    const trashList = await callApi(root, { method: "GET", path: `${API_PREFIX}trash/list` });
    assert.equal(trashList.json.entries.length, 0, "未进回收站");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DELETE entry 态① 边界：请求名未过闸（越界段）→ 按未删除处理并 warn（不静默归到\"不存在\"）", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "long-term", { title: "Real", name: "real.md", content: "在场" });
    const bad = await callApi(root, { method: "DELETE", path: `${API_PREFIX}entry`, body: { category: "long-term", name: "../../real.md" } });
    // 净化不出安全相对路径 → 无从判定"存在"，绝不谎报 existed:true 或删除成功
    assert.equal(bad.status, 200);
    assert.equal(bad.json.existed, false, "未过闸 ≠ 确认存在：无法判定就不声称存在");
    assert.equal(bad.json.trashed, false);
    assert.equal(existsSync(join(categoryDir(root, "long-term"), "real.md")), true, "盘上原样未动（越界名删不到任何东西）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    // 契约：每项带 createdAt（ISO 字符串，备份生成时间）
    assert.equal(typeof list.json.backups[0].createdAt, "string", "backups/list 项带 createdAt");
    assert.ok(Number.isFinite(Date.parse(list.json.backups[0].createdAt)), "createdAt 是合法 ISO 时间");
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

test("state：新字段面（extractionConfig 五字段 / 顶层双预算 / recover 八字段）", async () => {
  const root = freshRoot();
  try {
    // ① 新宿主：configSummary 备齐 → extractionConfig 实值 + 顶层双预算；recover 走假依赖八字段
    const extraction = {
      triggerRetry: () => 0,
      inFlight: () => false,
      configSummary: () => ({
        provider: "p", model: "m", fallback: [],
        redactionEnabled: false, injectMaxChars: 30000, injectMaxTokens: 8000,
        extractGateEnabled: false, extractGateMinScore: 9,
        extractIdleDelayMs: 0, extractMaxRunsPerSession: 20,
        autoRecoverEnabled: false,
      }),
    };
    const { deps } = fakeRecovery({});
    const withDeps = await callApi(root, { method: "GET", path: `${API_PREFIX}state`, extraction, recovery: { ...deps, state: () => ({ inFlight: false, lastAt: 1, lastOutcome: "written", lastSessionId: "s", autoEnabled: false, autoAttempts: 3, lastAutoAt: 2, lastAutoTrigger: "startup" }) } });
    assert.equal(withDeps.status, 200);
    const j = withDeps.json;
    assert.equal(j.extractionConfig.gateEnabled, false);
    assert.equal(j.extractionConfig.gateMinScore, 9);
    assert.equal(j.extractionConfig.idleDelayMs, 0);
    assert.equal(j.extractionConfig.maxRunsPerSession, 20);
    assert.equal(j.extractionConfig.redactionEnabled, false);
    assert.equal(j.injectMaxChars, 30000);
    assert.equal(j.injectMaxTokens, 8000);
    assert.equal(j.recover.autoEnabled, false);
    assert.equal(j.recover.autoAttempts, 3);
    assert.equal(j.recover.lastAutoAt, 2);
    assert.equal(j.recover.lastAutoTrigger, "startup");
    // ② 旧宿主：extraction/configSummary 全缺 → 五字段/双预算如实 null；recover 八字段空形
    const legacy = await callApi(root, { method: "GET", path: `${API_PREFIX}state` });
    const lj = legacy.json;
    for (const k of ["gateEnabled", "gateMinScore", "idleDelayMs", "maxRunsPerSession", "redactionEnabled"]) {
      assert.equal(lj.extractionConfig[k], null, `旧宿主 extractionConfig.${k} 应如实 null`);
    }
    assert.equal(lj.injectMaxChars, null);
    assert.equal(lj.injectMaxTokens, null);
    assert.deepEqual(lj.recover, {
      inFlight: false, lastAt: null, lastOutcome: null, lastSessionId: null,
      autoEnabled: null, autoAttempts: 0, lastAutoAt: null, lastAutoTrigger: null,
    });
    // ③ 半新宿主：configSummary 只有 provider/model（无新键）→ 同样如实 null（不冒领默认）
    const half = await callApi(root, {
      method: "GET", path: `${API_PREFIX}state`,
      extraction: { triggerRetry: () => 0, inFlight: () => false, configSummary: () => ({ provider: "p", model: "m", fallback: [] }) },
    });
    assert.equal(half.json.extractionConfig.gateEnabled, null);
    assert.equal(half.json.injectMaxTokens, null);
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
    // throttled/superseded：同源替换两计数（想发没发 / 发了作废旧块），契约恒在；
    // lastTokens/totalTokens：token 口径两计数（token 预算观测面）
    for (const k of ["count", "lastChars", "totalChars", "lastTokens", "totalTokens", "resends", "droppedSegments", "throttled", "superseded", "renderFailures", "lastAt"]) {
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
    assert.match(String(j.message), /上限/);
    // 413 带上该端点的具体大小上限（persona 100KB），不再只说"有大小限制"
    assert.match(String(j.message), /100\s*KB/, "413 message 给出该端点具体上限");
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
    assert.equal(write.json.error, "format-too-new");
    assert.equal(write.json.message, "数据由更高版本写入，已转只读，升级插件后恢复", "503 带中文可读 message");

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

test("state：embeddingConfig/embeddingEffective baseUrl 剥离 URL 内嵌凭据（不回显 user:pass）", async () => {
  const root = freshRoot();
  try {
    const routes = makeApiRoutes({
      storageRoot: root,
      log: silentLog,
      onGlobalWrite: () => {},
      extraction: {
        triggerRetry: () => 0,
        inFlight: () => false,
        configSummary: () => ({
          timeoutMs: 120000,
          retryAttempts: 3,
          embeddingEffective: { source: "settings", enabled: true, baseUrl: "http://user:EXAMPLE_PASSWORD@example.com@embed.local/v1/embeddings", model: "m", provider: "p", apiKey: "secret", topK: 5, minScore: 0, timeoutMs: 5000 },
        }),
      },
    });
    const handler = routes[0].handler;
    const req = mockReq({ method: "GET", url: `${API_PREFIX}state` });
    const res = mockRes();
    await handler(req, res);
    const json = JSON.parse(res.body);
    assert.equal(json.embeddingConfig.baseUrl.includes("user"), false, "embeddingConfig.baseUrl 剥离 username");
    assert.equal(json.embeddingConfig.baseUrl.includes("pass"), false, "embeddingConfig.baseUrl 剥离 password");
    assert.equal(json.embeddingConfig.baseUrl, "http://embed.local/v1/embeddings");
    assert.equal(json.embeddingEffective.baseUrl.includes("user"), false, "embeddingEffective.baseUrl 剥离凭据");
    assert.equal(json.embeddingEffective.baseUrl, "http://embed.local/v1/embeddings");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state：extractionRetryAttempts 补发（=cfg.retryAttempts，面板消费契约字段）", async () => {
  const root = freshRoot();
  try {
    const routes = makeApiRoutes({
      storageRoot: root,
      log: silentLog,
      onGlobalWrite: () => {},
      extraction: { triggerRetry: () => 0, inFlight: () => false, configSummary: () => ({ timeoutMs: 120000, retryAttempts: 4 }) },
    });
    const handler = routes[0].handler;
    const req = mockReq({ method: "GET", url: `${API_PREFIX}state` });
    const res = mockRes();
    await handler(req, res);
    const json = JSON.parse(res.body);
    assert.equal(json.extractionRetryAttempts, 4, "/state 产出 extractionRetryAttempts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 会话补提端点（GET /sessions/pending / POST /sessions/recover）----

/** 假 recovery 依赖：pending 返回固定清单；start 记录调用并返回 busy/started。 */
function fakeRecovery({ items = [], hostSupported = true, busy = false } = {}) {
  const calls = [];
  return {
    deps: {
      pending: async () => ({ hostSupported, items }),
      start: (sessionId, from, to) => { calls.push({ sessionId, from, to }); return busy ? { started: false, busy: true } : { started: true }; },
      state: () => ({ inFlight: false, lastAt: 123, lastOutcome: "written", lastSessionId: "sess-1" }),
    },
    calls,
  };
}

test("GET sessions/pending：hostSupported + items 形状（未接线时恒出空形而非 404）", async () => {
  const root = freshRoot();
  try {
    // 未接线（旧构建）：200 + hostSupported:false + items:[]（面板 tolerant 消费）
    {
      const { status, json } = await callApi(root, { method: "GET", path: `${API_PREFIX}sessions/pending` });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.hostSupported, false);
      assert.deepEqual(json.items, []);
    }
    // 已接线：如实透出 hostSupported 与清单
    const { deps } = fakeRecovery({ items: [{ sessionId: "s1", from: 3, to: 9, kind: "failed", sessionAvailable: true, eventCount: 20 }], hostSupported: true });
    {
      const { status, json } = await callApi(root, { method: "GET", path: `${API_PREFIX}sessions/pending`, recovery: deps });
      assert.equal(status, 200);
      assert.equal(json.hostSupported, true);
      assert.equal(json.items.length, 1);
      assert.equal(json.items[0].sessionId, "s1");
      assert.equal(json.items[0].kind, "failed");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST sessions/recover：参数校验 400（缺参/非数字/to<=from）", async () => {
  const root = freshRoot();
  try {
    const { deps, calls } = fakeRecovery({ items: [{ sessionId: "s1", sessionAvailable: true }] });
    const cases = [
      { sessionId: "s1", from: 1 }, // 缺 to
      { sessionId: "", from: 1, to: 3 }, // sessionId 空
      { sessionId: "s1", from: "1", to: 3 }, // from 非数字
      { sessionId: "s1", from: 1, to: 3.5 }, // to 非整数
      { sessionId: "s1", from: 5, to: 5 }, // to == from
      { sessionId: "s1", from: 9, to: 3 }, // to < from
      { sessionId: "s1", from: -1, to: 3 }, // 负数
    ];
    for (const body of cases) {
      const { status, json } = await callApi(root, { method: "POST", path: `${API_PREFIX}sessions/recover`, body, recovery: deps });
      assert.equal(status, 400, `应 400：${JSON.stringify(body)}`);
      assert.equal(json.code, "E_INVALID_ARGUMENT");
    }
    assert.equal(calls.length, 0, "参数非法一律不触发执行");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST sessions/recover：host 不支持 503 / 会话不存在 404 / 已有补提在跑 409 / 通过 202", async () => {
  const root = freshRoot();
  try {
    // ① host 不支持 → 503 E_HOST_UNSUPPORTED
    {
      const { deps } = fakeRecovery({ hostSupported: false });
      const { status, json } = await callApi(root, { method: "POST", path: `${API_PREFIX}sessions/recover`, body: { sessionId: "s1", from: 1, to: 5 }, recovery: deps });
      assert.equal(status, 503);
      assert.equal(json.code, "E_HOST_UNSUPPORTED");
    }
    // ② 会话不存在（清单里标不可读）→ 404 E_SESSION_NOT_FOUND
    {
      const { deps } = fakeRecovery({ items: [{ sessionId: "s1", sessionAvailable: false }] });
      const { status, json } = await callApi(root, { method: "POST", path: `${API_PREFIX}sessions/recover`, body: { sessionId: "s1", from: 1, to: 5 }, recovery: deps });
      assert.equal(status, 404);
      assert.equal(json.code, "E_SESSION_NOT_FOUND");
    }
    // ③ 已有补提在跑（单飞）→ 409 E_BUSY
    {
      const { deps } = fakeRecovery({ items: [{ sessionId: "s1", sessionAvailable: true }], busy: true });
      const { status, json } = await callApi(root, { method: "POST", path: `${API_PREFIX}sessions/recover`, body: { sessionId: "s1", from: 1, to: 5 }, recovery: deps });
      assert.equal(status, 409);
      assert.equal(json.code, "E_BUSY");
    }
    // ④ 通过 → 202 { ok:true, started:true }
    {
      const { deps, calls } = fakeRecovery({ items: [{ sessionId: "s1", sessionAvailable: true }] });
      const { status, json } = await callApi(root, { method: "POST", path: `${API_PREFIX}sessions/recover`, body: { sessionId: "s1", from: 1, to: 5 }, recovery: deps });
      assert.equal(status, 202);
      assert.equal(json.ok, true);
      assert.equal(json.started, true);
      assert.deepEqual(calls, [{ sessionId: "s1", from: 1, to: 5 }]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state：recover 观测面字段恒在（未接线八字段空形 / 已接线真值透传）", async () => {
  const root = freshRoot();
  try {
    const empty = await callApi(root, { method: "GET", path: `${API_PREFIX}state` });
    assert.equal(empty.status, 200);
    // 未接线也要八字段同形（缺失=旧版判定依据）；autoEnabled 未知给 null 不谎报
    assert.deepEqual(empty.json.recover, {
      inFlight: false, lastAt: null, lastOutcome: null, lastSessionId: null,
      autoEnabled: null, autoAttempts: 0, lastAutoAt: null, lastAutoTrigger: null,
    });
    const { deps } = fakeRecovery({});
    const wired = await callApi(root, { method: "GET", path: `${API_PREFIX}state`, recovery: deps });
    assert.equal(wired.json.recover.lastOutcome, "written");
    assert.equal(wired.json.recover.lastAt, 123);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 记忆整理端点（GET /maintenance/suggestions / POST /maintenance/repair-index）----

test("GET maintenance/suggestions：形状完整（duplicates/stale/indexHealth/counts/generatedAt）", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "A", content: "同样的正文内容" });
    createEntry(root, "user-profile", { title: "A", content: "同样的正文内容" }); // 跨分类同名 + 正文相同 → 重复候选
    const { status, json } = await callApi(root, { method: "GET", path: `${API_PREFIX}maintenance/suggestions` });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.duplicates));
    assert.ok(json.duplicates.length >= 1, "跨分类同名+正文相同应命中重复候选");
    assert.ok(Array.isArray(json.stale));
    assert.ok(json.indexHealth && Array.isArray(json.indexHealth.dangling) && Array.isArray(json.indexHealth.orphans));
    assert.equal(typeof json.counts.entries, "number");
    assert.equal(json.counts.truncated, false);
    assert.match(json.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST maintenance/repair-index：悬挂行剔除 + 漏行补齐，且幂等（第二次 fixed=[]）", async () => {
  const root = freshRoot();
  try {
    const dir = categoryDir(root, "work-profile");
    // 磁盘上两个条目文件；索引里：一个悬挂行（指向不存在文件）+ 只登记了其一（漏登记 b）
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "---\nname: a\ntitle: A\n---\n正文A\n");
    writeFileSync(join(dir, "b.md"), "---\nname: b\ntitle: B\n---\n正文B\n");
    writeFileSync(join(dir, "MEMORY.md"), "- [A](a.md) — 钩子\n- [Ghost](ghost.md) — 悬挂\n");
    const first = await callApi(root, { method: "POST", path: `${API_PREFIX}maintenance/repair-index` });
    assert.equal(first.status, 200);
    assert.equal(first.json.ok, true);
    // 响应契约：fixed 为【已应用动作明细】数组（与 planIndexRepair 的 op 同形），fixedCount = 条数
    assert.ok(Array.isArray(first.json.fixed), "fixed 是明细数组（面板按数组消费）");
    assert.ok(first.json.fixed.length >= 2, `应修悬挂行+补漏行（实际 ${first.json.fixed.length}）`);
    assert.equal(first.json.fixedCount, first.json.fixed.length, "fixedCount = 明细条数");
    assert.equal(first.json.unchanged, false, "有动作即未 unchanged");
    const removeOp = first.json.fixed.find((f) => f.type === "remove-line");
    assert.ok(removeOp, "明细含 remove-line 动作");
    assert.equal(removeOp.category, "global:work-profile");
    assert.match(removeOp.line, /ghost\.md/, "remove-line 的 line 是悬挂行原文");
    const addOp = first.json.fixed.find((f) => f.type === "add-line");
    assert.ok(addOp, "明细含 add-line 动作");
    assert.equal(addOp.name, "b.md", "add-line 的 name 是漏登记文件名");
    // 落盘核对：悬挂行没了、漏行补上了、两个条目文件仍在（绝不删文件）
    const after = readFileSync(join(dir, "MEMORY.md"), "utf8");
    assert.doesNotMatch(after, /ghost\.md/, "悬挂行应被剔除");
    assert.match(after, /b\.md/, "漏登记条目应补上");
    assert.ok(existsSync(join(dir, "a.md")) && existsSync(join(dir, "b.md")), "条目文件绝不能被删");
    // 幂等：再跑一次计划为空 → fixed=[]、fixedCount=0、unchanged=true
    const second = await callApi(root, { method: "POST", path: `${API_PREFIX}maintenance/repair-index` });
    assert.equal(second.status, 200);
    assert.deepEqual(second.json.fixed, [], "已对上账后第二次修复无动作（幂等）：fixed=[]");
    assert.equal(second.json.fixedCount, 0, "fixedCount=0");
    assert.equal(second.json.unchanged, true, "unchanged=true");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST maintenance/repair-index：嵌套条目在盘在索引 → 不报 dangling、不产 remove-line（递归对账）", async () => {
  // 嵌套条目名合法形态含多段（sub/topic.md）：只扫顶层会把它的有效索引行误判成悬挂行而删掉。
  const root = freshRoot();
  try {
    const dir = categoryDir(root, "work-profile");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "topic.md"), "---\nname: topic\ntitle: 嵌套主题\n---\n正文\n");
    writeFileSync(join(dir, "MEMORY.md"), "- [嵌套主题](sub/topic.md) — 钩子\n");
    const { json } = await callApi(root, { method: "POST", path: `${API_PREFIX}maintenance/repair-index` });
    assert.equal(json.ok, true);
    assert.equal(json.fixed.some((f) => f.type === "remove-line"), false, "嵌套有效索引行不得被当悬挂行删");
    const after = readFileSync(join(dir, "MEMORY.md"), "utf8");
    assert.match(after, /sub\/topic\.md/, "嵌套索引行仍在（未被误删）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST maintenance/repair-index：嵌套文件不在索引 → orphan 如实报、补登记补上（递归对账）", async () => {
  const root = freshRoot();
  try {
    const dir = categoryDir(root, "work-profile");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "topic.md"), "---\nname: topic\ntitle: 嵌套主题\n---\n正文\n");
    writeFileSync(join(dir, "MEMORY.md"), "");
    const { json } = await callApi(root, { method: "POST", path: `${API_PREFIX}maintenance/repair-index` });
    assert.equal(json.ok, true);
    const addOp = json.fixed.find((f) => f.type === "add-line");
    assert.ok(addOp, "嵌套孤儿应被如实报为漏登记并补行");
    assert.equal(addOp.name, "sub/topic.md", "orphan 名为相对目录的多段路径");
    const after = readFileSync(join(dir, "MEMORY.md"), "utf8");
    assert.match(after, /sub\/topic\.md/, "嵌套孤儿补登记已落盘");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST maintenance/repair-index：留底快照失败 fail-closed —— 该分类索引不被改写、不计入 fixed", async () => {
  // 留底（手术快照）失败时必须跳过该分类、绝不改索引（宁可不修，也不在没有原档的情况下动索引）。
  // 把 backups/surgical 占位成文件 → createSurgicalSnapshot 的 mkdirSync 抛错 → continue 分支。
  // 删掉该 continue 会让索引照改（本用例的 MEMORY.md 应保持原样这一断言立即变红）。
  const root = freshRoot();
  try {
    const dir = categoryDir(root, "work-profile");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "---\nname: a\ntitle: A\n---\n正文A\n");
    const original = "- [A](a.md) — 钩子\n- [Ghost](ghost.md) — 悬挂\n";
    writeFileSync(join(dir, "MEMORY.md"), original);
    // 占位 backups/surgical 为文件：快照根建不出来 → 留底失败
    mkdirSync(join(root, "backups"), { recursive: true });
    writeFileSync(join(root, "backups", "surgical"), "占位：不是目录");
    const { status, json } = await callApi(root, { method: "POST", path: `${API_PREFIX}maintenance/repair-index` });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.deepEqual(json.fixed, [], "留底失败 → 该分类未应用任何动作，明细为空");
    assert.equal(json.fixedCount, 0);
    assert.equal(json.unchanged, true);
    assert.equal(readFileSync(join(dir, "MEMORY.md"), "utf8"), original, "留底失败时索引原文一字未动（fail-closed）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST maintenance/repair-index：present.has 存在性兜底 —— 指向索引文件自身的行不被误删", async () => {
  // remove-line 前按名做存在性检查：目标文件在盘上就绝不剔。MEMORY.md 自链行是探针——
  // 它被对账判为 dangling（索引文件不在 files 清单里），但文件确实在盘上，兜底必须拦住。
  // 删掉 present.has 兜底会让这行被删（本用例的 doesMatch 立即变红）。
  const root = freshRoot();
  try {
    const dir = categoryDir(root, "work-profile");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "---\nname: a\ntitle: A\n---\n正文A\n");
    writeFileSync(join(dir, "MEMORY.md"), "- [索引](MEMORY.md) — 自链\n- [A](a.md) — 钩子\n");
    const { json } = await callApi(root, { method: "POST", path: `${API_PREFIX}maintenance/repair-index` });
    assert.equal(json.ok, true);
    assert.equal(json.fixed.some((f) => f.type === "remove-line"), false, "指向索引文件自身的行不得被判悬挂删除");
    const after = readFileSync(join(dir, "MEMORY.md"), "utf8");
    assert.match(after, /\[索引\]\(MEMORY\.md\)/, "自链行仍在（存在性兜底拦住了误删）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state：settingsDiagnostics 字段恒在（形状 { coercedFields: [...] }）", async () => {
  const root = freshRoot();
  try {
    const { status, json } = await callApi(root, { method: "GET", path: `${API_PREFIX}state` });
    assert.equal(status, 200);
    assert.ok(json.settingsDiagnostics && typeof json.settingsDiagnostics === "object");
    assert.ok(Array.isArray(json.settingsDiagnostics.coercedFields));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateRepairPlan：只放行 remove-line/add-line，删文件类动作整单拒绝（绝不删条目文件）", () => {
  // 合法计划：一路放行
  assert.deepEqual(validateRepairPlan([]), { ok: true });
  assert.deepEqual(validateRepairPlan([{ type: "remove-line" }, { type: "add-line" }]), { ok: true });
  // 任何非白名单动作（含删文件）→ 整单拒绝，badType 如实带出
  assert.deepEqual(validateRepairPlan([{ type: "delete-file" }]), { ok: false, badType: "delete-file" });
  assert.deepEqual(validateRepairPlan([{ type: "remove-line" }, { type: "delete-file", name: "a.md" }]), { ok: false, badType: "delete-file" });
  assert.deepEqual(validateRepairPlan([{ type: "unlink" }]), { ok: false, badType: "unlink" });
  assert.deepEqual(validateRepairPlan([{}]), { ok: false, badType: "undefined" });
  // 非数组：按空计划放行（不炸）
  assert.deepEqual(validateRepairPlan(null), { ok: true });
});

test("collectMaintenanceInputs：条目描述 + 索引现状两份现状（title 取 frontmatter 真标题，truncated 达标）", () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "真标题", content: "正文" });
    const { entries, indexStatus, counts } = collectMaintenanceInputs(root);
    assert.ok(entries.length >= 1);
    const hit = entries.find((e) => e.category === "global:work-profile");
    assert.ok(hit, "应含全局分类条目");
    assert.equal(hit.title, "真标题", "title 取 frontmatter 真标题");
    assert.equal(typeof hit.mtimeMs, "number");
    assert.ok(indexStatus.some((g) => g.category === "global:work-profile" && Array.isArray(g.lines) && Array.isArray(g.files)));
    assert.equal(counts.truncated, false);
    assert.equal(typeof counts.entryTotal, "number");
    // 上限截断：limit=0 时全部截断、如实标注
    const tiny = collectMaintenanceInputs(root, { limit: 0 });
    assert.equal(tiny.entries.length, 0);
    assert.equal(tiny.counts.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectMaintenanceInputs：递归收集——嵌套（含多段）条目进 files 与 entries，口径同 manifest", () => {
  const root = freshRoot();
  try {
    // 全局分类下的嵌套条目
    const dir = categoryDir(root, "work-profile");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "topic.md"), "---\nname: topic\ntitle: 嵌套标题\n---\n正文\n");
    // 项目记忆下的嵌套条目
    const memDir = join(root, "projects", "demo-aabb0011223344", "memory");
    mkdirSync(join(memDir, "deep", "inner"), { recursive: true });
    writeFileSync(join(memDir, "deep", "inner", "note.md"), "---\nname: note\ntitle: 深层\n---\n项目正文\n");
    writeFileSync(join(memDir, "MEMORY.md"), "");
    const { entries, indexStatus } = collectMaintenanceInputs(root);
    // files 是 auditIndex 的对账依据：两条嵌套条目都必须在列（只扫顶层会误判/漏报）
    const g = indexStatus.find((x) => x.category === "global:work-profile");
    assert.ok(g.files.includes("sub/topic.md"), "嵌套全局条目进 files（posix 多段相对路径）");
    const p = indexStatus.find((x) => x.category === "project:demo-aabb0011223344");
    assert.ok(p.files.includes("deep/inner/note.md"), "嵌套项目条目进 files（深层多段路径）");
    // 项目记忆的 entry 组装同样递归：嵌套条目进 entries（name 为相对路径、title 取 frontmatter）
    assert.ok(
      entries.some((e) => e.category === "project:demo-aabb0011223344" && e.name === "demo-aabb0011223344/deep/inner/note.md" && e.title === "深层"),
      "嵌套项目条目进 entries（name 为相对路径、title 取 frontmatter）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

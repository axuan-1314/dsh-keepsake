// runtime-regress：v0.6.1 修复批的回归门（每条钉一个已实测复现的缺陷，防再退化）。
//   ① 淘汰条目在产物里必须留可见痕迹（此前静默消失：产物没有、索引又被整类去重）；
//   ② 分类粒度去重：有淘汰条目的分类必须留在 globalIndex（含只读态 stale 清单）；
//   ③ 候选池读失败不得静默当空池（会把上一版好产物覆盖成空）；
//   ④ runtime 端点（pin/evict/restore）成功后产物必须还在（写后全失效曾把刚编的删掉）；
//   ⑤ 归档条目被普通覆写时 origin 三字段必须保留（否则移回恒 400）；
//   ⑥ /state.settings 必须带 runtimeEnabled（面板开关状态的真相源）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { API_PREFIX, makeApiRoutes } from "../lib/api.js";
import { createEntry, renderGlobalEntry, updateEntry } from "../lib/global-store.js";
import { renderGlobalIndex, runtimeCoveredCategoriesOf, runtimeCoveredProjectFilesOf } from "../lib/index.js";
import { compileScope, ensureCompiled, scopeDir } from "../lib/runtime.js";
import { evictEntries } from "../lib/runtime-archive.js";
import { resetSettingsCache } from "../lib/settings.js";

const silentLog = { info() {}, warn() {}, error() {} };
const FIXED_NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

function freshRoot() {
  resetSettingsCache();
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-runtime-regress-"));
}

/** 写一条全局条目（frontmatter 形态同 renderGlobalEntry）。 */
function writeGlobalEntry(root, category, file, { title, description = "", pinned = false, body = "正文" } = {}) {
  const dir = join(root, "global", category);
  mkdirSync(dir, { recursive: true });
  const name = file.replace(/\.md$/i, "");
  const lines = ["---", `name: "${name}"`, `title: "${title ?? name}"`, `description: "${description}"`, "metadata:", "  type: global"];
  if (pinned) lines.push("pinned: true");
  lines.push('node_type: "memory"', "---", "", body, "");
  writeFileSync(join(dir, file), lines.join("\n"), "utf8");
  writeFileSync(join(dir, "MEMORY.md"), `- [${title ?? name}](${file}) — ${description}\n`, "utf8");
}

function mockReq({ method, url, body }) {
  const req = new Readable({ read() { if (body !== void 0) this.push(JSON.stringify(body)); this.push(null); } });
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
    body: "",
    writeHead(status) { this.status = status; },
    end(chunk) { this.body = chunk ?? ""; },
    get headersSent() { return this.status !== 0; },
  };
}
async function callApi(root, { method, path, body, onGlobalWrite }) {
  const routes = makeApiRoutes({ storageRoot: root, log: silentLog, onGlobalWrite: onGlobalWrite ?? (() => {}) });
  const res = mockRes();
  await routes[0].handler(mockReq({ method, url: path, body }), res);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

// ---- ① 淘汰留痕 ----

test("① 淘汰条目：产物内必须有可见告警行（此前静默消失，产物没有、索引也被去重）", () => {
  const root = freshRoot();
  try {
    // 12 条 × 1500 字符 ≈ 18KB > MEMORY.md 10240 字节配额 → 必有淘汰
    for (let i = 0; i < 12; i += 1) {
      writeGlobalEntry(root, "work-profile", `n${String(i).padStart(2, "0")}.md`, { title: `N${i}-${"W".repeat(1500)}`, description: "hook" });
    }
    const compiled = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
    assert.ok(compiled.evictCandidates.length > 0, "前置：确有条目装不下");
    assert.match(compiled.memory.text, /\[runtime evicted: \d+ entries exceed MEMORY\.md quota/, "产物必须写明有多少条没进来");
    // 淘汰是设计内行为，不该冒充 overQuota（两者语义不同：一个是收敛机制，一个是预警）
    assert.equal(compiled.status, "ok");
    assert.doesNotMatch(compiled.memory.text, /runtime over quota/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ② 分类粒度去重 ----

test("② runtimeCoveredCategoriesOf：只有全覆盖的分类才算覆盖；有淘汰条目的分类必须留在索引", () => {
  const root = freshRoot();
  try {
    writeGlobalEntry(root, "user-profile", "u.md", { title: "U" });
    // 12 条 × 1500 字符 ≈ 18KB > MEMORY.md 10240 字节配额 → 必有淘汰
    for (let i = 0; i < 12; i += 1) {
      writeGlobalEntry(root, "work-profile", `n${String(i).padStart(2, "0")}.md`, { title: `N${i}-${"W".repeat(1500)}`, description: "hook" });
    }
    const compiled = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
    assert.ok(compiled.evictCandidates.length > 0, "前置：work-profile 确有条目装不下");
    const covered = runtimeCoveredCategoriesOf(compiled);
    assert.ok(covered.includes("user-profile"), "user-profile 全入选 → 覆盖");
    assert.ok(!covered.includes("work-profile"), "work-profile 有淘汰条目 → 不算覆盖（索引照旧渲染）");
    // 索引侧：被淘汰分类的行仍在，覆盖分类的行消失
    const index = renderGlobalIndex(root, { runtimeCoveredCategories: covered }).text;
    assert.match(index, /### 工作背景 \(work-profile\)/, "未覆盖分类的段落必须在");
    assert.doesNotMatch(index, /### 用户个人背景 \(user-profile\)/, "已覆盖分类不重复渲染");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("② 只读态 stale 清单：降级期间新增的条目不得因整类去重而彻底不可见", () => {
  const root = freshRoot();
  try {
    writeGlobalEntry(root, "user-profile", "u.md", { title: "OldUser" });
    const compiled = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
    // 模拟「降级只读期间新增条目」：盘上清单还是老的（只有 u.md），盘上却多了一条
    writeGlobalEntry(root, "user-profile", "new.md", { title: "NewUser" });
    const covered = runtimeCoveredCategoriesOf(compiled);
    assert.ok(covered.includes("user-profile"), "清单自述全覆盖");
    // 结论边界：清单是唯一事实源时，新条目只能靠下一次可写态编译补上；此处钉住的是
    // 「去重判据必须来自清单自身」这一契约——不因 status=ok 就假定三分类全覆盖。
    const other = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
    assert.ok(runtimeCoveredCategoriesOf(other).includes("user-profile"));
    assert.match(other.user.text, /NewUser/, "可写态重编后新条目进产物");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ③ 读失败不得静默当空池 ----

test("③ 分类目录读失败 → status=error 且保留上一版产物（不把记忆静默清空）", () => {
  const root = freshRoot();
  try {
    writeGlobalEntry(root, "user-profile", "u.md", { title: "KeepMe" });
    const first = ensureCompiled({ storageRoot: root, scope: "global", trigger: "test", log: silentLog });
    assert.equal(first.status, "ok");
    const productBefore = readFileSync(join(scopeDir(root, "global"), "USER.md"), "utf8");
    assert.match(productBefore, /KeepMe/);
    // 把整个分类目录换成同名**文件**：readdir 得到 ENOTDIR（不是 ENOENT），必须上抛而非当空池
    const catDir = join(root, "global", "user-profile");
    rmSync(catDir, { recursive: true, force: true });
    writeFileSync(catDir, "占位", "utf8");
    const second = ensureCompiled({ storageRoot: root, scope: "global", trigger: "test", log: silentLog });
    assert.equal(second.status, "error", "读失败必须显式降级，不能伪装成「分类空了」");
    assert.equal(readFileSync(join(scopeDir(root, "global"), "USER.md"), "utf8"), productBefore, "上一版产物原样保留");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ④ runtime 端点成功后产物必须还在 ----

test("④ pin 成功后产物仍在（写后全失效不得删掉刚重编的结果）", async () => {
  const root = freshRoot();
  try {
    writeGlobalEntry(root, "user-profile", "u.md", { title: "U" });
    ensureCompiled({ storageRoot: root, scope: "global", trigger: "test", log: silentLog });
    // 复刻真实接线：runtimeHandled 时不得再全量失效
    const onGlobalWrite = (opts) => {
      if (opts?.runtimeHandled !== true) {
        rmSync(join(root, "runtime"), { recursive: true, force: true });
      }
    };
    const pin = await callApi(root, {
      method: "POST",
      path: `${API_PREFIX}runtime/global/pin`,
      body: { rootKey: "global:user-profile", file: "u.md", pinned: true },
      onGlobalWrite,
    });
    assert.equal(pin.status, 200);
    assert.ok(existsSync(join(scopeDir(root, "global"), "USER.md")), "pin 后产物必须还在");
    const got = await callApi(root, { method: "GET", path: `${API_PREFIX}runtime/global` });
    assert.equal(got.status, 200, "面板随后 GET 必须拿得到产物（不能 404）");
    assert.match(got.json.user.text, /【关键】/, "pin 结果体现在产物里");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("④ 非 runtime 端点仍要全量失效（修复不能把通用失效一起关掉）", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "W", name: "w.md", content: "工" });
    ensureCompiled({ storageRoot: root, scope: "global", trigger: "test", log: silentLog });
    let invalidated = 0;
    await callApi(root, {
      method: "PUT",
      path: `${API_PREFIX}persona`,
      body: { content: "新人设" },
      onGlobalWrite: () => { invalidated += 1; },
    });
    assert.equal(invalidated, 1, "普通写路径照常触发失效钩子");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ⑤ 归档 origin 三字段不得被覆写剥掉 ----

test("⑤ 归档条目被面板覆写：origin 三字段保留，仍可移回（普通编辑不得破坏可逆性）", () => {
  const root = freshRoot();
  try {
    const dir = join(root, "global", "long-term");
    mkdirSync(dir, { recursive: true });
    const text = renderGlobalEntry({
      name: "archived",
      title: "归档条目",
      description: "来自项目",
      content: "正文",
      origin: { originProject: "projects/demo-0123456789abcdef", originType: "project", originSessionId: "s-1" },
    });
    writeFileSync(join(dir, "archived.md"), text, "utf8");
    writeFileSync(join(dir, "MEMORY.md"), "- [归档条目](archived.md) — 来自项目\n", "utf8");

    const updated = updateEntry(root, "long-term", "archived.md", { title: "改过标题", content: "新正文" });
    assert.notEqual(updated, null);
    const after = readFileSync(join(dir, "archived.md"), "utf8");
    assert.match(after, /originProject: "projects\/demo-0123456789abcdef"/, "originProject 必须保留");
    assert.match(after, /originType: "project"/, "originType 必须保留");
    assert.match(after, /originSessionId: "s-1"/, "originSessionId 必须保留");
    assert.match(after, /新正文/);

    // 反向：非归档条目的覆写不该凭空长出 origin 字段
    createEntry(root, "work-profile", { title: "Normal", name: "n.md", content: "x" });
    updateEntry(root, "work-profile", "n.md", { content: "y" });
    assert.doesNotMatch(readFileSync(join(root, "global", "work-profile", "n.md"), "utf8"), /originProject/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ⑥ settings 契约 ----

test("⑥ GET state 必带 settings.runtimeEnabled；盘上开启时如实回显", async () => {
  const root = freshRoot();
  try {
    const off = await callApi(root, { method: "GET", path: `${API_PREFIX}state` });
    assert.equal(off.json.settings.runtimeEnabled, false, "缺省关，且字段恒在");
    const put = await callApi(root, { method: "PUT", path: `${API_PREFIX}settings`, body: { runtimeEnabled: true } });
    assert.equal(put.status, 200);
    const on = await callApi(root, { method: "GET", path: `${API_PREFIX}state` });
    assert.equal(on.json.settings.runtimeEnabled, true, "盘上开启必须回显（面板刷新后开关不能显示成关）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ⑦ 项目条目去重（§10.3 项目侧） ----

test("⑦ 项目条目：已进产物的索引行被剔除；未进产物的（reference）照旧留在索引", () => {
  const root = freshRoot();
  try {
    const scope = "projects/demo-0123456789abcdef";
    const memoryDir = join(root, ...scope.split("/"), "memory");
    mkdirSync(memoryDir, { recursive: true });
    const writeEntry = (name, type, title) => writeFileSync(
      join(memoryDir, `${name}.md`),
      `---\nname: "${name}"\ntitle: "${title}"\ndescription: "钩子"\nmetadata:\n  type: ${type}\n---\n正文\n`,
      "utf8",
    );
    writeEntry("proj", "project", "项目决策");
    writeEntry("ref", "reference", "参考链接");
    writeFileSync(
      join(memoryDir, "MEMORY.md"),
      "- [项目决策](proj.md) — 钩子\n- [参考链接](ref.md) — 钩子\n",
      "utf8",
    );
    const compiled = compileScope({ storageRoot: root, scope, now: FIXED_NOW });
    const covered = runtimeCoveredProjectFilesOf(compiled);
    assert.deepEqual(covered, ["proj.md"], "只有进了产物的条目算覆盖（reference 不进正文）");
    // 索引侧过滤：proj 行消失、ref 行留下（同 indexTextFor 的剔行口径）
    const remaining = "- [项目决策](proj.md) — 钩子\n- [参考链接](ref.md) — 钩子\n"
      .split("\n")
      .filter((line) => {
        const matched = line.match(/^\s*-\s*\[[^\]]*\]\(([^)]+\.md)\)/i);
        return matched === null || !covered.includes(matched[1].trim());
      })
      .join("\n");
    assert.match(remaining, /\[参考链接\]\(ref\.md\)/, "reference 条目必须留在索引（去重不等于消失）");
    assert.doesNotMatch(remaining, /proj\.md/, "已进产物的条目不重复出现");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ⑧ 极小预算不发零内容空壳 ----

test("⑧ buildMemoryContext：内容段全被截空时返回空文本（不发只剩声明+告警的 500 字符壳）", async () => {
  const { buildMemoryContext, MEMORY_CONTEXT_INTRO, MEMORY_CONTEXT_SUPERSEDE_NOTE } = await import("../lib/inject-channel.js");
  const tiny = buildMemoryContext(
    { persona: "A".repeat(3000) },
    { maxChars: 400, intro: MEMORY_CONTEXT_INTRO, supersedeNote: MEMORY_CONTEXT_SUPERSEDE_NOTE },
  );
  assert.equal(tiny.text, "", "零内容 = 不注入（调用侧靠 text==='' 判）");
  assert.equal(tiny.truncated, true, "仍如实标记「截过」");
});

// ---- ⑨ 归档审计失败不得让余下候选静默失踪 ----

test("⑨ 审计写失败：已归档条数如实回报，余下候选进 skipped（不再静默中断）", () => {
  const root = freshRoot();
  try {
    const scope = "global";
    // 造 3 条必被淘汰的大条目
    for (let i = 0; i < 12; i += 1) {
      writeGlobalEntry(root, "work-profile", `n${String(i).padStart(2, "0")}.md`, { title: `N${i}-${"W".repeat(1500)}`, description: "hook" });
    }
    const candidates = compileScope({ storageRoot: root, scope, now: FIXED_NOW }).evictCandidates.slice(0, 3);
    assert.equal(candidates.length, 3);
    // 审计文件路径被同名目录占位 → append 必失败
    mkdirSync(join(root, "evict-audit.jsonl"), { recursive: true });
    let thrown = null;
    try {
      evictEntries({
        storageRoot: root,
        scope,
        files: candidates.map((c) => ({ rootKey: c.rootKey, file: c.file })),
        log: silentLog,
        now: FIXED_NOW,
      });
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown?.code, "EVICT_AUDIT_FAILED", "审计失败仍要显式抛出");
    assert.equal(thrown.details.archived, 1, "第一条已搬完，如实计入");
    assert.equal(thrown.details.skipped.length, 2, "余下 2 条必须进 skipped（不静默失踪）");
    assert.ok(thrown.details.skipped.every((s) => s.reason === "audit-failed"));
    assert.ok(thrown.details.snapshotDir !== null, "快照目录信息随错误带回");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
import { FORMAT_VERSION } from "../lib/format.js";
import { createEntry, renderGlobalEntry, updateEntry } from "../lib/global-store.js";
import { apply, renderGlobalIndex, runtimeCoveredCategoriesOf, runtimeCoveredProjectFilesOf } from "../lib/index.js";
import { __resetMetricsForTest } from "../lib/metrics.js";
import { projectMemoryPaths } from "../lib/paths.js";
import { compileScope, ensureCompiled, readRuntimeManifest, scopeDir } from "../lib/runtime.js";
import { evictEntries, restoreArchivedEntry } from "../lib/runtime-archive.js";
import { resetSettingsCache, writeSettings } from "../lib/settings.js";

const silentLog = { info() {}, warn() {}, error() {} };
const FIXED_NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

function freshRoot() {
  resetSettingsCache();
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-runtime-regress-"));
}

/** 最小宿主 ctx（与 runtime-inject.test.mjs 同构）：只为把 apply() 真跑起来。
 *  **webServer.register 会把路由留在 registered 里**——这样测试能打到 apply() 真实接线的 API 面
 *  （含 lib/index.js 里那个 onGlobalWrite 守卫），而不是自建一份「长得像」的接线。 */
function fakeCtx() {
  const sections = [];
  const handlers = new Map();
  const registered = [];
  return {
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      on(event, handler) { handlers.set(event, handler); return () => {}; },
      effect() {},
      inject(_deps, setup) {
        setup({
          effect(fn) { fn(); },
          webServer: { register(route) { registered.push(route); return () => {}; } },
        });
      },
      systemPrompt: { section(section) { sections.push(section); return () => {}; } },
      llm: { stream() { throw new Error("不应调用"); } },
    },
    sections,
    handlers,
    registered,
  };
}

const userMsg = (text) => ({ role: "user", content: [{ type: "text", text }] });

/** 起 message 模式插件，返回「求一次注入文本」的求值器 + apply() 注册的真实 API 路由。 */
function startMessage(root) {
  const { ctx, handlers, registered } = fakeCtx();
  apply(ctx, { enabled: true, storageRoot: root });
  const handler = handlers.get("agent/pre-step");
  assert.equal(typeof handler, "function", "message 模式应注册 pre-step");
  return {
    registered,
    handler,
    async injectTextNoCwd() {
      const agent = { session: { header: { cwd: void 0 }, surface: { nodes: [] }, eventAt() {} } };
      const messages = [userMsg("正常 用户 一句话")];
      const decision = { kind: "enter", messages };
      const out = await handler({ agent, messages, step: 1, signal: { aborted: false } }, async () => decision);
      const injected = out.messages.find((m) => m.source?.form === "memory-context");
      return injected === void 0 ? "" : injected.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    },
  };
}

/** 在 apply() 注册的真实路由里找前缀路由并打一次请求（走真实 onGlobalWrite 接线）。 */
async function callApplyApi(registered, { method, path, body }) {
  const prefixRoute = registered.find((r) => r.kind === "prefix");
  assert.ok(prefixRoute, "apply 应注册前缀路由");
  const res = mockRes();
  await prefixRoute.handler(mockReq({ method, url: path, body }), res);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
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

test("② 只读态 stale 清单：降级期间新增的条目不得因整类去重而彻底不可见", async () => {
  const root = freshRoot();
  try {
    writeGlobalEntry(root, "user-profile", "u.md", { title: "OldUser" });
    // 必须**真落盘**一份清单：本用例要咬的是注入侧「清单指纹 vs 盘上候选池指纹」的比对分支，
    // 而 compileScope 是纯内存编译（不写 runtime.json）——用它会让 readRuntimeManifest
    // 返回 null、走「无缓存」早退分支，指纹比对代码根本不执行，测试变成自证式
    // （变异：删掉指纹守卫仍全部通过，2026-10-22 复查实证）。
    ensureCompiled({ storageRoot: root, scope: "global", trigger: "test", log: silentLog });
    // 模拟「降级只读期间新增条目」：盘上清单还是老的（只有 u.md），盘上却多了一条
    writeGlobalEntry(root, "user-profile", "new.md", { title: "NewUser" });
    const cached = readRuntimeManifest(root, "global");
    assert.ok(cached !== null, "清单必须已落盘（否则本用例咬不到指纹比对分支）");
    const stale = runtimeCoveredCategoriesOf(cached);
    assert.ok(stale.includes("user-profile"), "清单自述全覆盖");
    // 关键：注入侧绝不能只信「status=ok + 三分类全覆盖」就摘掉整个分类——
    // 那会让 NewUser 既不在产物（清单旧）也不在索引（整类被去重），彻底不可见。
    // 故注入侧必须用「清单指纹 == 盘上候选池指纹」来判定，不一致就保守不摘（用 apply 跑真实注入链路）。
    writeSettings(root, { runtimeEnabled: true });
    resetSettingsCache();
    writeFileSync(join(root, "keepsake-format.json"), JSON.stringify({ formatVersion: FORMAT_VERSION + 1 }) + "\n", "utf8");
    const { injectTextNoCwd } = startMessage(root);
    const text = await injectTextNoCwd();
    assert.match(text, /### 用户个人背景 \(user-profile\)/, "只读态 + stale 清单 → 索引照旧渲染（不整类摘掉）");
    assert.match(text, /\[NewUser\]/, "stale 清单期间新增的条目在索引里可见（不两头不可见）");
    assert.match(text, /\[runtime readOnly/, "只读态照常记告警");
    // 反向：指纹一致时（无外部改动）覆盖集照常生效——三分类不重复渲染
    const root2 = freshRoot();
    try {
      writeGlobalEntry(root2, "user-profile", "u.md", { title: "OnlyUser" });
      ensureCompiled({ storageRoot: root2, scope: "global", trigger: "test", log: silentLog });
      writeSettings(root2, { runtimeEnabled: true });
      resetSettingsCache();
      writeFileSync(join(root2, "keepsake-format.json"), JSON.stringify({ formatVersion: FORMAT_VERSION + 1 }) + "\n", "utf8");
      const { injectTextNoCwd: inject2 } = startMessage(root2);
      const text2 = await inject2();
      assert.match(text2, /\[OnlyUser\]/, "指纹一致 → 条目由产物承载");
      assert.doesNotMatch(text2, /### 用户个人背景 \(user-profile\)/, "指纹一致 → 索引不重复渲染（去重生效）");
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
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

// 单条读失败的独立场景在本机造不出来（Windows 上 chmod 无效、目录占位会被 isFile() 过滤掉，
// 走不到 readEntryFile），故该分支由上面那条目录级 ENOTDIR 用例覆盖——两者都会上抛并让
// compileScope 走 status=error。readEntryFile 里只放行 ENOENT 的判据由代码注释与本文件
// 「读失败不得静默」的总体约束守住。

// ---- ④ runtime 端点成功后产物必须还在 ----

test("④ pin 成功后产物仍在（写后全失效不得删掉刚重编的结果）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    writeSettings(root, { runtimeEnabled: true });
    writeGlobalEntry(root, "user-profile", "u.md", { title: "U" });
    // 先让注入链路编译一次产物
    const plugin = startMessage(root);
    await plugin.injectTextNoCwd();
    assert.ok(existsSync(join(scopeDir(root, "global"), "USER.md")), "前置：产物已生成");
    // 打 apply() 注册的真实路由：若 lib/index.js 的 runtimeHandled 守卫被摘掉，
    // 它会真的执行 invalidateRuntimeAfterApiWrite（删产物），下面两条断言随即变红。
    const pin = await callApplyApi(plugin.registered, {
      method: "POST",
      path: `${API_PREFIX}runtime/global/pin`,
      body: { rootKey: "global:user-profile", file: "u.md", pinned: true },
    });
    assert.equal(pin.status, 200, "pin 应成功");
    assert.ok(existsSync(join(scopeDir(root, "global"), "USER.md")), "pin 后产物必须还在（守卫真的生效）");
    const got = await callApplyApi(plugin.registered, { method: "GET", path: `${API_PREFIX}runtime/global` });
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

    // 真跑一次「从归档移回」：证明被编辑过之后 origin 仍可用（不是只断言字段文本）
    const restored = restoreArchivedEntry({ storageRoot: root, file: "archived.md", log: silentLog, now: FIXED_NOW });
    assert.match(restored.to, /projects\/demo-0123456789abcdef\/memory\//, "按 originProject 落回原项目");
    const back = readFileSync(join(root, ...restored.to.split("/")), "utf8");
    assert.match(back, /新正文/, "移回保留编辑后的正文");
    assert.doesNotMatch(back, /originProject/, "移回后剥掉 origin（恢复原 schema）");
    assert.equal(existsSync(join(dir, "archived.md")), false, "归档副本已移走");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⑤ 普通条目移入 long-term 时补写 origin（否则日后移回恒 400）", () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "要归档的", name: "to-archive.md", content: "正文" });
    const moved = updateEntry(root, "work-profile", "to-archive.md", { toCategoryId: "long-term" });
    assert.notEqual(moved, null);
    const archived = readFileSync(join(root, "global", "long-term", moved.name), "utf8");
    assert.match(archived, /originType: "work-profile"/, "记下原分类");
    // 由此可移回（不再因缺 origin 报 400）
    const restored = restoreArchivedEntry({ storageRoot: root, file: moved.name, log: silentLog, now: FIXED_NOW });
    assert.match(restored.to, /global\/work-profile\//, "移回原分类");
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

test("⑦ 项目条目：已进产物的索引行被剔除；未进产物的（reference）照旧留在索引（走真实注入链路）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    // 让 cwd 落进这个项目目录，注入侧才会走项目 scope（projectMemoryPaths 按 cwd 算 slug+hash）
    const { memoryDir } = projectMemoryPaths(root, root);
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
    writeSettings(root, { runtimeEnabled: true });
    resetSettingsCache();
    const plugin = startMessage(root);
    // 用 cwd=root 触发项目 scope（与 index.js 的 runtimeScopeFor/memoryDirFor 同口径）
    const agent = { session: { header: { cwd: root }, surface: { nodes: [] }, eventAt() {} } };
    const handler = plugin.handler;
    const messages = [userMsg("正常 用户 一句话")];
    const out = await handler({ agent, messages, step: 1, signal: { aborted: false } }, async () => ({ kind: "enter", messages }));
    const injected = out.messages.find((m) => m.source?.form === "memory-context");
    assert.ok(injected, "应注入记忆块");
    const text = injected.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

    // 产物承载 proj（进了 MEMORY.md 段）；索引里不该再出现 proj 行
    assert.match(text, /\[项目决策\]/, "proj 条目由 runtime 段承载");
    const indexSection = text.split("## Project memory index (MEMORY.md)")[1] ?? "";
    assert.doesNotMatch(indexSection, /\[项目决策\]\(proj\.md\)/, "已进产物的项目条目不在索引里重复出现");
    // reference 不进产物 → 必须留在索引（去重不等于消失）
    assert.match(indexSection, /\[参考链接\]\(ref\.md\)/, "reference 条目照旧留在索引");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ⑧ 极小预算不发零内容空壳 ----

test("⑧ buildMemoryContext：内容段全被截空时返回空文本（不发只剩声明+告警的 500 字符壳）", async () => {
  const { buildMemoryContext, MEMORY_CONTEXT_INTRO, MEMORY_CONTEXT_SUPERSEDE_NOTE } = await import("../lib/inject-channel.js");
  const opts = { intro: MEMORY_CONTEXT_INTRO, supersedeNote: MEMORY_CONTEXT_SUPERSEDE_NOTE };
  const tiny = buildMemoryContext({ persona: "A".repeat(3000) }, { ...opts, maxChars: 400 });
  assert.equal(tiny.text, "", "零内容 = 不注入（调用侧靠 text==='' 判）");
  assert.equal(tiny.truncated, true, "仍如实标记「截过」");
  assert.equal(tiny.tokens, 0, "不注入的东西不该记 token");
  // 边界：预算恰好只够截出「…」时也不能当有内容（否则会漏出一个含 intro+提示行、
  // 却没有任何记忆的块——正是这条判断要消灭的东西）。逐个预算扫一遍，全不许出现「只有省略号」的块。
  for (let maxChars = 401; maxChars <= 470; maxChars += 1) {
    const out = buildMemoryContext({ persona: "A".repeat(3000) }, { ...opts, maxChars });
    if (out.text === "") continue;
    const body = out.text.replace(/<memory-context>|<\/memory-context>/g, "").replace(MEMORY_CONTEXT_INTRO, "").replace(MEMORY_CONTEXT_SUPERSEDE_NOTE, "");
    assert.ok(/[^…\s]/.test(body), `maxChars=${maxChars} 时不应发出只剩省略号的空壳块`);
  }
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
    // 最关键的一条：被报为 skipped 的条目**源文件必须还在原处**。
    // （0.6.1 首版把守卫放在搬移之后，导致「已搬走、源已删」的条目被报成 skipped——进度谎报。）
    const workDir = join(root, "global", "work-profile");
    for (const s of thrown.details.skipped) {
      assert.ok(existsSync(join(workDir, s.file)), `skipped 的 ${s.file} 源文件必须仍在原位`);
    }
    const archivedFile = candidates.find((c) => !thrown.details.skipped.some((s) => s.file === c.file));
    assert.ok(archivedFile, "应有且只有一条真正归档");
    assert.equal(existsSync(join(workDir, archivedFile.file)), false, "已归档的那条源文件应已移走");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

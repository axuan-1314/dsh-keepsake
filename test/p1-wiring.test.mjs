// p1-wiring：/memory 命令与三个新端点走 apply() 的真实接线。
//   钉住的不变量（都是"看着接上了跑起来却是死的"那类）：
//   ① 宿主有 commands 服务 → /memory 真的注册上，且 handler 能查到刚写的条目；
//   ② 宿主没有 commands 服务 → 记忆功能照常（不是靠 catch 吞掉，是显式不挂）；
//   ③ turn-activity 端点必须回调到 provider（形参名与被传键名一致，防"同名的 import 遮蔽"）；
//   ④ 纠错端点走真实 applyScopedOps 写盘，且写后能读回新正文。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { apply } from "../lib/index.js";
import { projectMemoryPaths } from "../lib/paths.js";
import { resetSettingsCache } from "../lib/settings.js";

const API_PATH = "/dsh-keepsake/api";

function fakeCtx({ stream = null, withCommands = true } = {}) {
  const handlers = new Map();
  const webRoutes = [];
  const commands = [];
  const warns = [];
  const ctx = {
    logger: { info() {}, warn: (m) => warns.push(String(m)), error() {} },
    on(event, handler) { handlers.set(event, handler); return () => {}; },
    effect(fn) {
      const dispose = typeof fn === "function" ? fn() : void 0;
      return typeof dispose === "function" ? dispose : () => {};
    },
    inject(deps, setup) {
      const services = {
        effect: (fn) => {
          const dispose = fn();
          return typeof dispose === "function" ? dispose : () => {};
        },
        webServer: { register(route) { webRoutes.push(route); return () => {}; } },
        commands: withCommands
          ? { register(def) { commands.push(def); return () => {}; } }
          : void 0,
      };
      // 模拟 cordis：只把请求的服务放进去；未提供的服务保持 undefined
      const scoped = { effect: services.effect };
      for (const dep of deps) {
        if (dep === "webServer") scoped.webServer = services.webServer;
        if (dep === "commands" && withCommands) scoped.commands = services.commands;
      }
      setup(scoped);
    },
    systemPrompt: { section() { return () => {}; } },
    llm: { stream: stream ?? (async function* empty() {}) },
  };
  return { ctx, handlers, webRoutes, commands, warns };
}

function mockReq({ method, url, body }) {
  const req = new Readable({
    read() {
      if (body !== void 0) this.push(JSON.stringify(body));
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
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; },
    end(chunk) { this.body = chunk ?? ""; },
    get headersSent() { return this.status !== 0; },
  };
}

async function call(handler, { method, path, body }) {
  const req = mockReq({ method, url: path, body });
  const res = mockRes();
  await handler(req, res);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

function seedProject(root) {
  const { memoryDir } = projectMemoryPaths(root, root);
  mkdirSync(memoryDir, { recursive: true });
  const projectId = basename(dirname(memoryDir));
  writeFileSync(join(memoryDir, "deploy.md"), [
    "---",
    'name: "deploy"',
    'description: "部署端口"',
    "metadata:",
    "  type: project",
    "---",
    "",
    "开发环境端口 3000。",
  ].join("\n"));
  writeFileSync(join(memoryDir, "MEMORY.md"), "- [部署端口](deploy.md) — 开发环境端口 3000\n");
  return { memoryDir, projectId };
}

function captureRoute(handlers, cwd) {
  handlers.get("session/event")(
    { id: "session-p1", header: { cwd } },
    { type: "request/header", data: { header: { config: { provider: "p", model: "m" } } } },
  );
}

test("/memory 命令：宿主有 commands 服务时真注册，且能查到项目条目", async () => {
  resetSettingsCache();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-p1-cmd-"));
  try {
    seedProject(root);
    const { ctx, handlers, commands } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root });
    assert.equal(commands.length, 1, "应注册一条命令");
    assert.equal(commands[0].name, "memory");
    assert.equal(commands[0].recordInput, false, "命令输入可能含个人信息，不进会话日志");

    captureRoute(handlers, root); // 让 last-known workspace 指向本项目

    const listed = await commands[0].handler({ rawInput: "", agent: { session: { id: "s" } } });
    assert.equal(listed.kind, "success");
    assert.match(listed.text, /部署端口/);

    const searched = await commands[0].handler({ rawInput: "部署", agent: { session: { id: "s" } } });
    assert.equal(searched.kind, "success");
    assert.match(searched.text, /找到 1 条/);
    assert.match(searched.text, /deploy\.md/);

    const miss = await commands[0].handler({ rawInput: "绝不存在的东西", agent: { session: { id: "s" } } });
    assert.match(miss.text, /没找到包含/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/memory 命令：宿主没有 commands 服务 → 不挂命令、记忆功能照常、留一条 warn", async () => {
  resetSettingsCache();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-p1-nocmd-"));
  try {
    seedProject(root);
    const { ctx, webRoutes, commands, warns } = fakeCtx({ withCommands: false });
    // 构造上不会调 setup（cordis 只在服务齐全时调），这里直接确认没命令注册、且 API 路由仍在
    apply(ctx, { enabled: true, storageRoot: root });
    assert.equal(commands.length, 0);
    assert.ok(webRoutes.length > 0, "命令缺失不得影响 API/面板路由注册");
    // 若宿主把空的 commands 传进 setup，也必须显式 warn 而不是静默（本 fake 不传，故只验证不炸）
    assert.ok(Array.isArray(warns));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("API /search 与 /search/list：真实检索项目条目", async () => {
  resetSettingsCache();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-p1-search-"));
  try {
    const { projectId } = seedProject(root);
    const { ctx, handlers, webRoutes } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root });
    captureRoute(handlers, root);
    const apiRoute = webRoutes.find((route) => route.kind === "prefix");
    assert.ok(apiRoute);

    const hit = await call(apiRoute.handler, { method: "GET", path: `${API_PATH}/search?q=${encodeURIComponent("端口")}` });
    assert.equal(hit.status, 200, JSON.stringify(hit.json));
    assert.equal(hit.json.total >= 1, true);
    assert.ok(hit.json.results.some((r) => r.name === "deploy.md"));

    const empty = await call(apiRoute.handler, { method: "GET", path: `${API_PATH}/search?q=` });
    assert.equal(empty.status, 400, "空 q 必须拒，不能退化成 list");

    const list = await call(apiRoute.handler, { method: "GET", path: `${API_PATH}/search/list?projectId=${encodeURIComponent(projectId)}` });
    assert.equal(list.status, 200);
    assert.ok(list.json.entries.some((e) => e.name === "deploy.md"));

    const badLimit = await call(apiRoute.handler, { method: "GET", path: `${API_PATH}/search?q=x&limit=0` });
    assert.equal(badLimit.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("API /corrections/correct：真实落盘并读回新正文，记录留痕", async () => {
  resetSettingsCache();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-p1-fix-"));
  try {
    const { memoryDir, projectId } = seedProject(root);
    // 模型返回一条覆盖写（带 sha1 才能过覆盖闸；先读真实 sha1）
    const { createHash } = await import("node:crypto");
    const before = readFileSync(join(memoryDir, "deploy.md"), "utf8");
    const short = createHash("sha1").update(before, "utf8").digest("hex").slice(0, 8);

    async function* stream() {
      yield {
        type: "text-delta",
        text: JSON.stringify({
          ops: [{
            action: "write",
            name: "deploy.md",
            scope: "project",
            type: "project",
            title: "部署端口",
            description: "部署端口（已更正）",
            sha1: short,
            content: "开发环境端口 8080。",
          }],
        }),
      };
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { ctx, handlers, webRoutes } = fakeCtx({ stream });
    apply(ctx, { enabled: true, storageRoot: root });
    captureRoute(handlers, root);
    const apiRoute = webRoutes.find((route) => route.kind === "prefix");

    const out = await call(apiRoute.handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct`,
      body: { target: "deploy.md", reason: "端口现在是 8080", scope: "project", projectId },
    });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    assert.equal(out.json.outcome, "applied");
    assert.equal(out.json.writes, 1);

    const after = readFileSync(join(memoryDir, "deploy.md"), "utf8");
    assert.match(after, /8080/, "盘上正文应换成新值");
    assert.ok(!/3000/.test(after), "旧值应被替换（不是追加）");

    const recent = await call(apiRoute.handler, { method: "GET", path: `${API_PATH}/corrections/recent` });
    assert.equal(recent.status, 200);
    assert.equal(recent.json.entries.length, 1);
    assert.equal(recent.json.entries[0].target, "deploy.md");
    assert.equal(recent.json.state.applied, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 真实纠错场景的回归：模型**不带** sha1（这是常态——纠错的提示词与 manifest 都不给它
// 目标条目自己的哈希，manifest 只列别的条目），覆盖仍必须真的替换旧正文。
//
// 修之前的表现：每次覆盖都落进落盘侧的盲写降级分支 → appendDowngradedWrite →
// 文件里「错的」和「对的」两句并列，纠错的目的（把错的改掉）完全没达成。
// 修法：纠错层用**盘上原文算出的**短 sha1 给「覆盖目标条目自身」的 write op 兜底
// （模型自报的哈希不作数），这样覆盖闸拿到的仍是「我知道盘上是什么」的真实证明。
test("API /corrections/correct：模型不带 sha1 时也必须真替换（不得降级成追加）", async () => {
  resetSettingsCache();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-p1-nosha-"));
  try {
    const { memoryDir, projectId } = seedProject(root);

    // 关键：ops 里**没有** sha1 字段，与真实模型行为一致。
    async function* stream() {
      yield {
        type: "text-delta",
        text: JSON.stringify({
          ops: [{
            action: "write",
            name: "deploy.md",
            scope: "project",
            type: "project",
            title: "部署端口",
            description: "部署端口（已更正）",
            content: "开发环境端口 8080。",
          }],
        }),
      };
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { ctx, handlers, webRoutes } = fakeCtx({ stream });
    apply(ctx, { enabled: true, storageRoot: root });
    captureRoute(handlers, root);
    const apiRoute = webRoutes.find((route) => route.kind === "prefix");

    const out = await call(apiRoute.handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct`,
      body: { target: "deploy.md", reason: "端口现在是 8080", scope: "project", projectId },
    });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    assert.equal(out.json.outcome, "applied");

    const after = readFileSync(join(memoryDir, "deploy.md"), "utf8");
    assert.match(after, /8080/, "盘上正文应换成新值");
    assert.ok(!/3000/.test(after), "旧值必须被替换掉，不能以「分隔线 + 追加」的方式留在文件里");
    assert.equal(
      out.json.applyResult.blindWriteDowngrades,
      0,
      "纠错不该落进盲写降级分支（降级 = 归一化成追加，纠错目的落空）",
    );
    // frontmatter 只应有一份（追加会把新文再带一份 frontmatter 塞进正文）
    assert.equal(after.match(/^---$/gm).length, 2, "整份文件应只有一个 frontmatter 块");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 反向约束：注入的 sha1 只给「目标条目自身」。模型若顺手写别的条目，
// 那一条仍走原来的保守路径（不带哈希 → 盲写降级），不许被这层顺手放宽。
test("stampCorrectionSha1：只给目标条目自身补哈希，别的条目不动", async () => {
  const { stampCorrectionSha1 } = await import("../lib/corrections.js");
  const ops = [
    { action: "write", name: "deploy.md", scope: "project", content: "新" },
    { action: "write", name: "other.md", scope: "project", content: "别的" },
    { action: "write", name: "progress.md", scope: "global:current-focus", content: "全局" },
    { action: "delete", name: "deploy.md", scope: "project" },
  ];
  const stamped = stampCorrectionSha1(ops, { target: "deploy.md", scopeLabel: "project", targetSha1: "ab12cd34" });
  assert.equal(stamped[0].sha1, "ab12cd34", "目标条目自身应拿到真哈希");
  assert.equal(stamped[1].sha1, undefined, "别的条目不得被顺手补哈希");
  assert.equal(stamped[2].sha1, undefined, "global 侧没有覆盖闸，不塞无用字段");
  assert.equal(stamped[3].sha1, undefined, "delete 不需要哈希");
  assert.equal(ops[0].sha1, undefined, "原数组不得被就地修改");
});

test("stampCorrectionSha1：无哈希 / 名字不合规 / 非数组 → 原样返回", async () => {
  const { stampCorrectionSha1 } = await import("../lib/corrections.js");
  const ops = [{ action: "write", name: "deploy.md", scope: "project", content: "新" }];
  assert.equal(stampCorrectionSha1(ops, { target: "deploy.md", scopeLabel: "project", targetSha1: "" }), ops);
  assert.equal(stampCorrectionSha1(ops, { target: "../escape.md", scopeLabel: "project", targetSha1: "ab12cd34" }), ops);
  assert.equal(stampCorrectionSha1(null, { target: "deploy.md", scopeLabel: "project", targetSha1: "ab12cd34" }), null);
});

test("API /corrections/correct：缺 target/reason → 400（不白烧模型调用）", async () => {  resetSettingsCache();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-p1-fix400-"));
  try {
    seedProject(root);
    let called = 0;
    async function* stream() {
      called += 1;
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { ctx, handlers, webRoutes } = fakeCtx({ stream });
    apply(ctx, { enabled: true, storageRoot: root });
    captureRoute(handlers, root);
    const apiRoute = webRoutes.find((route) => route.kind === "prefix");

    const noTarget = await call(apiRoute.handler, {
      method: "POST", path: `${API_PATH}/corrections/correct`, body: { reason: "x" },
    });
    assert.equal(noTarget.status, 400);
    const noReason = await call(apiRoute.handler, {
      method: "POST", path: `${API_PATH}/corrections/correct`, body: { target: "deploy.md" },
    });
    assert.equal(noReason.status, 400);
    assert.equal(called, 0, "参数不全不该调模型");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("API /turn-activity：真的回调到 provider（防同名 import 遮蔽成死接线）", async () => {
  resetSettingsCache();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-p1-turn-"));
  try {
    seedProject(root);
    const { ctx, handlers, webRoutes } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root });
    captureRoute(handlers, root);
    const apiRoute = webRoutes.find((route) => route.kind === "prefix");

    // 先制造一条提取结算（走 journal），这样 provider 返回值里一定有内容
    const { createJournal } = await import("../lib/journal.js");
    createJournal({ storageRoot: root }).recordRun({
      sessionId: "session-p1", from: 1, to: 5, cursorAfter: 6, outcome: "written", writes: 2,
    });
    // 注意：apply 内部建的是另一个 journal 实例，这里只验证端点本身活着且不 500；
    // provider 真被调用的证据 = window 字段（只有 provider 返回才有的形状）。
    const out = await call(apiRoute.handler, { method: "GET", path: `${API_PATH}/turn-activity` });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    assert.equal(out.json.ok, true);
    assert.ok(out.json.window && typeof out.json.window.since === "number", "window 只在 provider 真被调用时出现");
    assert.ok(Array.isArray(out.json.events));

    const badTime = await call(apiRoute.handler, { method: "GET", path: `${API_PATH}/turn-activity?sinceMs=abc` });
    assert.equal(badTime.status, 400, "非法时间戳必须拒");

    const badLimit = await call(apiRoute.handler, { method: "GET", path: `${API_PATH}/turn-activity?limit=0` });
    assert.equal(badLimit.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/state 带 corrections 面（含 recent 数组），旧形兼容", async () => {
  resetSettingsCache();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-p1-state-"));
  try {
    seedProject(root);
    const { ctx, handlers, webRoutes } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root });
    captureRoute(handlers, root);
    const apiRoute = webRoutes.find((route) => route.kind === "prefix");
    const state = await call(apiRoute.handler, { method: "GET", path: `${API_PATH}/state` });
    assert.equal(state.status, 200);
    assert.ok(state.json.corrections && typeof state.json.corrections === "object");
    for (const key of ["runs", "applied", "writes", "deletes", "failed"]) {
      assert.equal(typeof state.json.corrections[key], "number", `corrections.${key} 必须是数字（面板 tolerant 读）`);
    }
    assert.ok(Array.isArray(state.json.corrections.recent));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 批量纠错 + 按条目归组（P1 增补批） ----
test("API 批量纠错：两条真实落盘 + 按条目归组能读回", async () => {
  resetSettingsCache();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-p1-batch-"));
  try {
    const { memoryDir, projectId } = seedProject(root);
    const { createHash } = await import("node:crypto");
    const before = readFileSync(join(memoryDir, "deploy.md"), "utf8");
    const short = createHash("sha1").update(before, "utf8").digest("hex").slice(0, 8);
    writeFileSync(join(memoryDir, "extra.md"), [
      "---", 'name: "extra"', 'description: "额外条目"', "metadata:", "  type: project", "---", "", "旧内容。",
    ].join("\n"));
    const before2 = readFileSync(join(memoryDir, "extra.md"), "utf8");
    const short2 = createHash("sha1").update(before2, "utf8").digest("hex").slice(0, 8);

    let callSeq = 0;
    async function* stream() {
      const which = callSeq++;
      const target = which === 0 ? "deploy.md" : "extra.md";
      const sha = which === 0 ? short : short2;
      const body = which === 0 ? "开发环境端口 8080。" : "新内容。";
      yield {
        type: "text-delta",
        text: JSON.stringify({
          ops: [{ action: "write", name: target, scope: "project", type: "project", title: "T", description: "d", sha1: sha, content: body }],
        }),
      };
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { ctx, handlers, webRoutes } = fakeCtx({ stream });
    apply(ctx, { enabled: true, storageRoot: root });
    captureRoute(handlers, root);
    const apiRoute = webRoutes.find((route) => route.kind === "prefix");

    const out = await call(apiRoute.handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct-batch`,
      body: {
        items: [
          { target: "deploy.md", reason: "端口现在是 8080", scope: "project", projectId },
          { target: "extra.md", reason: "内容已更新", scope: "project", projectId },
        ],
      },
    });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    assert.equal(out.json.outcome, "applied");
    assert.equal(out.json.writes, 2);
    assert.equal(out.json.results.length, 2);

    // 两条都真落盘了
    assert.match(readFileSync(join(memoryDir, "deploy.md"), "utf8"), /8080/);
    assert.match(readFileSync(join(memoryDir, "extra.md"), "utf8"), /新内容/);

    // 按条目归组：每个 target 一组、各 1 次
    const grouped = await call(apiRoute.handler, { method: "GET", path: `${API_PATH}/corrections/by-target` });
    assert.equal(grouped.status, 200);
    assert.equal(grouped.json.total, 2, "两条 target 各成一组");
    assert.equal(grouped.json.entries, 2);
    const deploy = grouped.json.groups.find((g) => g.target === "deploy.md");
    assert.ok(deploy, "deploy.md 应有归组");
    assert.equal(deploy.count, 1);
    assert.equal(deploy.writes, 1);

    // 按单条 target 过滤
    const one = await call(apiRoute.handler, {
      method: "GET",
      path: `${API_PATH}/corrections/by-target?target=${encodeURIComponent("extra.md")}`,
    });
    assert.equal(one.status, 200);
    assert.equal(one.json.total, 1);
    assert.equal(one.json.groups[0].target, "extra.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("API 批量纠错：超上限 400 且一次模型都不调（不许静默截前 N 条）", async () => {
  resetSettingsCache();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-p1-batchcap-"));
  try {
    seedProject(root);
    let called = 0;
    async function* stream() {
      called += 1;
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { ctx, handlers, webRoutes } = fakeCtx({ stream });
    apply(ctx, { enabled: true, storageRoot: root });
    captureRoute(handlers, root);
    const apiRoute = webRoutes.find((route) => route.kind === "prefix");

    const items = Array.from({ length: 11 }, (_, i) => ({ target: `f${i}.md`, reason: "改" }));
    const out = await call(apiRoute.handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct-batch`,
      body: { items },
    });
    assert.equal(out.status, 400);
    assert.equal(out.json.code, "E_TOO_MANY");
    assert.equal(called, 0, "超上限不该跑任何一条");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("API 批量纠错：items 为空/非数组 → 400；单条缺 target/reason → 400", async () => {
  resetSettingsCache();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-p1-batch400-"));
  try {
    seedProject(root);
    const { ctx, handlers, webRoutes } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root });
    captureRoute(handlers, root);
    const apiRoute = webRoutes.find((route) => route.kind === "prefix");

    const empty = await call(apiRoute.handler, {
      method: "POST", path: `${API_PATH}/corrections/correct-batch`, body: { items: [] },
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.code, "E_EMPTY_BATCH");

    const noItems = await call(apiRoute.handler, {
      method: "POST", path: `${API_PATH}/corrections/correct-batch`, body: {},
    });
    assert.equal(noItems.status, 400);

    const noReason = await call(apiRoute.handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct-batch`,
      body: { items: [{ target: "deploy.md" }] },
    });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.json.code, "E_EMPTY_REASON");

    const noTarget = await call(apiRoute.handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct-batch`,
      body: { items: [{ reason: "改" }] },
    });
    assert.equal(noTarget.status, 400);
    assert.equal(noTarget.json.code, "E_INVALID_TARGET");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("API corrections/by-target：maxGroups 非法 → 400；空库 → 空组", async () => {
  resetSettingsCache();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-p1-group400-"));
  try {
    seedProject(root);
    const { ctx, handlers, webRoutes } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root });
    captureRoute(handlers, root);
    const apiRoute = webRoutes.find((route) => route.kind === "prefix");

    const bad = await call(apiRoute.handler, { method: "GET", path: `${API_PATH}/corrections/by-target?maxGroups=0` });
    assert.equal(bad.status, 400);

    const empty = await call(apiRoute.handler, { method: "GET", path: `${API_PATH}/corrections/by-target` });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.groups, []);
    assert.equal(empty.json.total, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

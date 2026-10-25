// pages-wiring：知识页生成走 apply() 的真实接线——路由捕获 → callLlmText → 写盘 → API 读取。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { apply } from "../lib/index.js";
import { PAGE_DEFS } from "../lib/pages.js";
import { projectMemoryPaths } from "../lib/paths.js";
import { resetSettingsCache } from "../lib/settings.js";

const API_PATH = "/dsh-keepsake/api/pages";

function fakeCtx(stream) {
  const handlers = new Map();
  const webRoutes = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, handler) { handlers.set(event, handler); return () => {}; },
    effect() {},
    inject(_deps, setup) {
      setup({
        effect(fn) { fn(); },
        webServer: { register(route) { webRoutes.push(route); return () => {}; } },
      });
    },
    systemPrompt: { section() { return () => {}; } },
    llm: { stream },
  };
  return { ctx, handlers, webRoutes };
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

test("知识页接线：侧栏无 session 用 last-known 路由，生成后 API 可读", async () => {
  resetSettingsCache();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-pages-wiring-"));
  try {
    const { memoryDir } = projectMemoryPaths(root, root);
    mkdirSync(memoryDir, { recursive: true });
    const projectId = basename(dirname(memoryDir));
    writeFileSync(join(memoryDir, "p.md"), [
      "---",
      'name: "p"',
      'description: "项目事实"',
      "metadata:",
      "  type: project",
      'node_type: "memory"',
      "---",
      "",
      "项目用 pnpm。",
    ].join("\n"));
    writeFileSync(join(memoryDir, "MEMORY.md"), "- [P](p.md) — 项目事实\n");

    let calls = 0;
    async function* stream() {
      calls += 1;
      yield { type: "text-delta", text: JSON.stringify({
        pages: PAGE_DEFS.map((definition) => ({
          id: definition.id,
          title: definition.title,
          summary: `${definition.title} 摘要`,
          content: `# ${definition.title}\n\n- 来自 [[p]]`,
        })),
      }) };
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { ctx, handlers, webRoutes } = fakeCtx(stream);
    apply(ctx, { enabled: true, storageRoot: root });
    const apiRoute = webRoutes.find((route) => route.kind === "prefix");
    assert.ok(apiRoute, "应注册 API 前缀路由");

    // 侧栏/面板没有 session：先由真实会话事件捕获 last-known 路由。
    handlers.get("session/event")(
      { id: "session-pages-1" },
      { type: "request/header", data: { header: { config: { provider: "p", model: "m" } } } },
    );

    const generated = await call(apiRoute.handler, {
      method: "POST",
      path: `${API_PATH}/generate`,
      body: { projectId },
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.json));
    assert.equal(generated.json.manifest.pages.length, 5);
    assert.equal(calls, 1, "手动生成只调用一次 LLM");

    const read = await call(apiRoute.handler, {
      method: "GET",
      path: `${API_PATH}/read?projectId=${encodeURIComponent(projectId)}`,
    });
    assert.equal(read.status, 200);
    assert.equal(read.json.available, true);
    assert.equal(read.json.pages.length, 5);
    assert.match(read.json.pages[0].content, /来自 \[\[p\]\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// pages.lock 被别的实例占住时，对用户就是「稍后再试」——必须和进程内单飞
// （E_BUSY → 409）给同一个可读反馈。曾经被包成 E_WRITE → 500「详情见服务端日志」，
// 看起来像插件坏了。
test("知识页接线：pages.lock 被别的实例占住 → 409 E_PAGES_BUSY 而不是 500", async () => {
  resetSettingsCache();
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-pages-busy-"));
  try {
    const { memoryDir } = projectMemoryPaths(root, root);
    mkdirSync(memoryDir, { recursive: true });
    const projectId = basename(dirname(memoryDir));
    writeFileSync(join(memoryDir, "p.md"), [
      "---",
      'name: "p"',
      'description: "项目事实"',
      "metadata:",
      "  type: project",
      'node_type: "memory"',
      "---",
      "",
      "项目用 pnpm。",
    ].join("\n"));
    writeFileSync(join(memoryDir, "MEMORY.md"), "- [P](p.md) — 项目事实\n");

    // 另一个实例留下的新鲜锁（token 任意，只要没过期）
    writeFileSync(join(root, "pages.lock"), JSON.stringify({ token: "other-instance", at: Date.now() }));

    async function* stream() {
      yield { type: "text-delta", text: JSON.stringify({
        pages: PAGE_DEFS.map((d) => ({ id: d.id, title: d.title, summary: "s", content: `# ${d.title}` })),
      }) };
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { ctx, handlers, webRoutes } = fakeCtx(stream);
    apply(ctx, { enabled: true, storageRoot: root });
    const apiRoute = webRoutes.find((route) => route.kind === "prefix");
    handlers.get("session/event")(
      { id: "session-pages-busy" },
      { type: "request/header", data: { header: { config: { provider: "p", model: "m" } } } },
    );

    const out = await call(apiRoute.handler, {
      method: "POST",
      path: `${API_PATH}/generate`,
      body: { projectId },
    });
    assert.equal(out.status, 409, `应回 409（可重试），实际 ${out.status}：${JSON.stringify(out.json)}`);
    assert.equal(out.json.code, "E_PAGES_BUSY");
    // 别人的锁不能被这次失败拆掉
    assert.equal(JSON.parse(readFileSync(join(root, "pages.lock"), "utf8")).token, "other-instance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// entry：插件入口集成冒烟（假 cordis ctx）——事件订阅→skip/提取→落盘→注入段渲染。
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apply, resolveConfig, name, inject } from "../lib/index.js";
import { projectMemoryPaths } from "../lib/paths.js";
import { writeSettings, resetSettingsCache } from "../lib/settings.js";

function fakeCtx(streamImpl) {
  const handlers = new Map();
  const sections = [];
  const effects = [];
  const streamCalls = [];
  const registeredRoutes = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(type, fn) {
      handlers.set(type, fn);
    },
    effect(fn, label) {
      effects.push({ fn, label });
    },
    // 宿主面扩展：ctx.inject(["webServer"], (sctx) => …)
    // mock：立即执行 setup 并触发其注册的 effect（模拟宿主启动），路由可被断言。
    inject(deps, setup) {
      const pending = [];
      const sctx = {
        effect(fn) {
          pending.push(fn);
        },
        webServer: {
          register(route) {
            registeredRoutes.push(route);
            return () => {};
          },
        },
      };
      setup(sctx);
      for (const fn of pending) fn();
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    llm: {
      stream(options) {
        streamCalls.push(options);
        return streamImpl(options);
      },
    },
  };
  return { ctx, handlers, sections, effects, streamCalls, registeredRoutes };
}

const USER_EVENT = {
  type: "user/message",
  surfaceOp: "append",
  seq: 0,
  data: { role: "user", content: [{ type: "text", text: "记住 我们 团队 统一 用 pnpm" }] },
};

function fakeSession(cwd, events) {
  return {
    id: "s-test",
    seq: events.length,
    header: { cwd },
    snapshotEvents(from, to) {
      return events.slice(from, to);
    },
  };
}

test("入口元数据与注入段注册", () => {
  assert.equal(name, "dsh-keepsake");
  // 硬依赖仅 llm + systemPrompt；webServer 为可选（有则挂载 API/面板，无则记忆仍工作）
  assert.deepEqual(inject.slice().sort(), ["llm", "systemPrompt"]);
  const { ctx, sections, registeredRoutes } = fakeCtx();
  apply(ctx, { enabled: false });
  assert.equal(sections.length, 0); // 关闭时不注入
  apply(ctx, {}); // 缺省关（fail-closed），无显式 enabled: true 不启用
  assert.equal(sections.length, 0);
  apply(ctx, { enabled: true, storageRoot: join(tmpdir(), "dsh-keepsake-entry") });
  // 默认 injectChannel=message → section 侧只留一条静态路由兜底段
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, "dsh-keepsake:routing");
  assert.equal(sections[0].order, 5000);
  assert.equal(sections[0].interpolate, false);
  // 路由已注册（API prefix 总入口 + panel exact/prefix）
  assert.ok(registeredRoutes.length >= 3);
  assert.ok(registeredRoutes.some((r) => r.kind === "prefix" && r.path === "/dsh-keepsake/api"));
  assert.ok(registeredRoutes.some((r) => r.path === "/dsh-keepsake/panel/"));

  // 显式 injectChannel=section → 旧四段：4990 人设 / 4995 全局索引 / 5000 项目说明 / 5001 项目索引
  const sectioned = fakeCtx();
  apply(sectioned.ctx, { enabled: true, storageRoot: join(tmpdir(), "dsh-keepsake-entry"), injectChannel: "section" });
  assert.equal(sectioned.sections.length, 4);
  assert.equal(sectioned.sections[0].name, "dsh-keepsake:persona");
  assert.equal(sectioned.sections[0].order, 4990);
  assert.equal(sectioned.sections[1].name, "dsh-keepsake:global-index");
  assert.equal(sectioned.sections[1].order, 4995);
  assert.equal(sectioned.sections[2].name, "dsh-keepsake:instructions");
  assert.equal(sectioned.sections[2].order, 5000);
  assert.equal(sectioned.sections[3].name, "dsh-keepsake:index");
  assert.equal(sectioned.sections[3].order, 5001);
  for (const section of sectioned.sections) assert.equal(section.interpolate, false);
});

test("事件→提取→落盘 全链路", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-entry-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-"));
  try {
    const { ctx, handlers, sections, streamCalls } = fakeCtx(async function* () {
      yield {
        type: "text-delta",
        index: 0,
        text: '{"ops":[{"action":"write","name":"uses-pnpm.md","type":"project","title":"Uses pnpm","description":"包管理器","content":"团队统一用 pnpm"}]}',
      };
      yield { type: "finish", reason: { kind: "stop" } };
    });
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 5000, injectChannel: "section" });
    const session = fakeSession(workspace, [USER_EVENT]);
    // 照真实事件流：先消息事件（首见登记 cursor=0），再 turn/end(completed) 触发
    handlers.get("session/event")(session, USER_EVENT);
    handlers.get("session/event")(session, { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    // 轮询等落盘（提取为后台异步任务）
    const paths = projectMemoryPaths(root, workspace);
    const target = join(paths.memoryDir, "uses-pnpm.md");
    for (let i = 0; i < 100 && !existsSync(target); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(target), true);
    const body = readFileSync(target, "utf8");
    assert.match(body, /type: project/);
    assert.match(body, /团队统一用 pnpm/);
    assert.equal(existsSync(join(paths.memoryDir, "MEMORY.md")), true);
    // 提取调用面断言：路由/用途/请求输入
    assert.equal(streamCalls.length, 1);
    assert.equal(streamCalls[0].provider, "prov");
    assert.equal(streamCalls[0].model, "model-x");
    assert.equal(streamCalls[0].purpose, "dsh-keepsake-extraction");
    assert.equal(streamCalls[0].sessionId, "s-test");
    // 注入段：项目索引段（sections[3]）此时能读到 MEMORY.md
    const indexText = sections[3].text({ agent: { session: { header: { cwd: workspace } } } });
    assert.match(indexText, /uses-pnpm\.md/);
    const usageText = sections[2].text({ agent: { session: { header: { cwd: workspace } } } });
    assert.match(usageText, new RegExp(paths.memoryDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // 无 cwd 会话：项目两段为空串（不炸组装）
    assert.equal(sections[2].text({}), "");
    assert.equal(sections[3].text({}), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("skip 轮（无散文）不调 LLM 但推进", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-entry-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-"));
  try {
    const { ctx, handlers, streamCalls } = fakeCtx(async function* () {
      throw new Error("不应被调用");
    });
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x" });
    const userEvent = { type: "user/message", surfaceOp: "append", seq: 0, data: { role: "user", content: [{ type: "text", text: "好" }] } };
    const session = fakeSession(workspace, [userEvent]);
    handlers.get("session/event")(session, userEvent);
    handlers.get("session/event")(session, { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(streamCalls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("直写轮跳过（skip 双条件②）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-entry-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-"));
  try {
    const { ctx, handlers, streamCalls } = fakeCtx(async function* () {
      throw new Error("不应被调用");
    });
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x" });
    const paths = projectMemoryPaths(root, workspace);
    const directEvent = {
      type: "tool/call",
      seq: 1,
      data: { name: "write", arguments: JSON.stringify({ file_path: join(paths.memoryDir, "direct.md"), content: "x" }) },
    };
    const session = fakeSession(workspace, [USER_EVENT, directEvent]);
    handlers.get("session/event")(session, USER_EVENT);
    handlers.get("session/event")(session, directEvent);
    handlers.get("session/event")(session, { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(streamCalls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("非 completed 轮不触发", async () => {
  const { ctx, handlers, streamCalls } = fakeCtx(async function* () {
    throw new Error("不应被调用");
  });
  apply(ctx, { enabled: true, storageRoot: join(tmpdir(), "dsh-keepsake-entry-x"), provider: "prov", model: "m" });
  const session = fakeSession("D:\\nowhere", [USER_EVENT]);
  handlers.get("session/event")(session, { type: "turn/end", seq: 4, data: { turn: 1, reason: { kind: "aborted" } } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(streamCalls.length, 0);
});

test("总开关关 = 提取全停（提取半边；补覆盖——此前该闸零测试）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-entry-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-"));
  try {
    resetSettingsCache();
    const { ctx, handlers, streamCalls } = fakeCtx(async function* () {
      throw new Error("总开关关时不应调用 LLM");
    });
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x" });
    writeSettings(root, { conversationMemory: false });
    const session = fakeSession(workspace, [USER_EVENT]);
    handlers.get("session/event")(session, USER_EVENT);
    handlers.get("session/event")(session, { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(streamCalls.length, 0, "总开关关时提取器不应发起 LLM 调用");
    const paths = projectMemoryPaths(root, workspace);
    assert.equal(existsSync(paths.memoryDir), false, "总开关关时不应有落盘");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("路由兜底（desktop 实测加固）：无 request/header 时 assistant/message.source 提供路由", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-entry-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-"));
  try {
    resetSettingsCache();
    const { ctx, handlers, streamCalls } = fakeCtx(async function* () {
      yield {
        type: "text-delta",
        index: 0,
        text: '{"ops":[{"action":"write","name":"fallback-route.md","type":"project","title":"Fallback","description":"路由兜底","content":"正文"}]}',
      };
      yield { type: "finish", reason: { kind: "stop" } };
    });
    // 不给 provider/model 配置、不发 request/header——只发 assistant/message 带 source
    apply(ctx, { enabled: true, storageRoot: root });
    const session = fakeSession(workspace, [USER_EVENT]);
    handlers.get("session/event")(session, {
      type: "assistant/message",
      seq: 1,
      data: { message: { source: { kind: "main", provider: "fallback-prov", model: "fallback-model" } } },
    });
    handlers.get("session/event")(session, { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } });
    const target = join(projectMemoryPaths(root, workspace).memoryDir, "fallback-route.md");
    for (let i = 0; i < 100 && !existsSync(target); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(target), true, "路由兜底应让提取照常落盘");
    assert.equal(streamCalls.length, 1);
    assert.equal(streamCalls[0].provider, "fallback-prov");
    assert.equal(streamCalls[0].model, "fallback-model");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("config 未知键 fail loud", () => {
  const { ctx } = fakeCtx();
  assert.throws(() => apply(ctx, { enabled: true, whatever: 1 }));
});

test("config 注入通道键 fail loud：injectChannel 非法值 / injectMaxChars 非正/非整数", () => {
  const { ctx } = fakeCtx();
  assert.throws(() => apply(ctx, { enabled: true, injectChannel: "bogus" }), /injectChannel/);
  assert.throws(() => apply(ctx, { enabled: true, injectMaxChars: 0 }), /injectMaxChars/);
  assert.throws(() => apply(ctx, { enabled: true, injectMaxChars: -5 }), /injectMaxChars/);
  assert.throws(() => apply(ctx, { enabled: true, injectMaxChars: 1.5 }), /injectMaxChars/);
});

test("config 自带嵌入模型（provider-agnostic）：端点/模型缺一即抛、section 冲突、端点 scheme 收紧、阈值/超时越界", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-entry-recall-"));
  const { ctx } = fakeCtx();
  assert.throws(() => apply(ctx, { enabled: true, storageRoot: root, recallEnabled: true }), /embeddingBaseUrl/);
  assert.throws(() => apply(ctx, { enabled: true, storageRoot: root, recallEnabled: true, embeddingBaseUrl: "http://x" }), /embeddingModel/);
  assert.throws(
    () => apply(ctx, { enabled: true, storageRoot: root, injectChannel: "section", recallEnabled: true, embeddingBaseUrl: "http://x", embeddingModel: "m" }),
    /injectChannel/,
    "section 模式召回永不执行 → 开即抛（不静默 no-op）",
  );
  assert.throws(
    () => apply(ctx, { enabled: true, storageRoot: root, recallEnabled: true, embeddingBaseUrl: "file:///etc/passwd", embeddingModel: "m" }),
    /http/,
    "嵌入端点收紧到 http(s)：非 http(s) scheme 即抛",
  );
  // 自带模型：只给端点 + 模型（不配 provider 标签）必须放行——用户点自己的本地嵌入模型即此形态
  assert.doesNotThrow(() =>
    apply(ctx, { enabled: true, storageRoot: root, recallEnabled: true, embeddingBaseUrl: "http://127.0.0.1:1234/v1/embeddings", embeddingModel: "nomic-embed-text" }),
  );
  // embeddingProvider 仅作面板标签：单独出现（无模型、未开召回）同样放行（不再强制与 model 成对）
  assert.doesNotThrow(() => apply(ctx, { enabled: true, storageRoot: root, embeddingProvider: "local" }));
  assert.throws(() => apply(ctx, { enabled: true, storageRoot: root, recallMinScore: 1.5 }), /recallMinScore/);
  assert.throws(() => apply(ctx, { enabled: true, storageRoot: root, recallTimeoutMs: 2147483648 }), /recallTimeoutMs/);
});

// ---- 假绿补钉（变异坐实零覆盖的新行为，本批必须有牙） ----

test("DSH_KEEPSAKE_DEBUG 文件日志口：debug.log 落盘含标记行", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-entry-dbg-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-dbg-"));
  const prev = process.env.DSH_KEEPSAKE_DEBUG;
  try {
    process.env.DSH_KEEPSAKE_DEBUG = "1";
    const { ctx, handlers } = fakeCtx(async function* () {
      yield { type: "text-delta", index: 0, text: "Nothing to save." };
      yield { type: "finish", reason: { kind: "stop" } };
    });
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "m", timeoutMs: 5000 });
    const session = fakeSession(workspace, [USER_EVENT]);
    handlers.get("session/event")(session, USER_EVENT);
    handlers.get("session/event")(session, { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    for (let i = 0; i < 100; i += 1) {
      if (existsSync(join(root, "debug.log"))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const logged = readFileSync(join(root, "debug.log"), "utf8");
    assert.match(logged, /\[dsh-keepsake\]/, "debug.log 应含插件日志行（Electron 宿主唯一可见通道）");
    assert.match(logged, /提取|路由|webServer/, "应记录提取链路事件");
  } finally {
    if (prev === void 0) delete process.env.DSH_KEEPSAKE_DEBUG;
    else process.env.DSH_KEEPSAKE_DEBUG = prev;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("路由优先级：assistant/message.source 不覆盖 request/header 已捕获路由", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-entry-prio-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-prio-"));
  try {
    const { ctx, handlers, streamCalls } = fakeCtx(async function* () {
      yield { type: "text-delta", index: 0, text: "Nothing to save." };
      yield { type: "finish", reason: { kind: "stop" } };
    });
    apply(ctx, { enabled: true, storageRoot: root }); // 不给显式配置，走会话路由
    const session = fakeSession(workspace, [USER_EVENT]);
    // 主路由先捕获（request/header 权威），兜底路 source 后到——不得覆盖
    handlers.get("session/event")(session, {
      type: "request/header",
      seq: 1,
      data: { header: { config: { provider: "main-prov", model: "main-model" } } },
    });
    handlers.get("session/event")(session, {
      type: "assistant/message",
      seq: 2,
      data: { message: { source: { kind: "main", provider: "fallback-prov", model: "fallback-model" } } },
    });
    handlers.get("session/event")(session, { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } });
    for (let i = 0; i < 100 && streamCalls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(streamCalls.length, 1);
    assert.equal(streamCalls[0].provider, "main-prov", "request/header 路由不被 source 兜底顶掉");
    assert.equal(streamCalls[0].model, "main-model");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- 本批补钉：存储格式只读闸（P2-7）/ recallTotalBudgetMs 配置键 ----

test("存储格式高于本插件 → 只读保护：不提取、不落盘（P2-7）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-entry-ro-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-keepsake-ws-ro-"));
  try {
    // 造"更新版插件写入"的存储根：formatVersion=2 高于当前 FORMAT_VERSION(1)
    writeFileSync(join(root, "keepsake-format.json"), JSON.stringify({ formatVersion: 2 }) + "\n", "utf8");

    const logs = [];
    const streamCalls = [];
    const handlers = new Map();
    const ctx = {
      logger: {
        info: (m) => logs.push(String(m)),
        warn: (m) => logs.push(String(m)),
        error: (m) => logs.push(String(m)),
      },
      on(type, fn) { handlers.set(type, fn); },
      effect() {},
      inject(_deps, setup) { setup({ effect(fn) { fn(); }, webServer: { register() { return () => {}; } } }); },
      systemPrompt: { section() { return () => {}; } },
      // 若只读闸失效，提取会真的调到 LLM 并落盘——桩会产出合法 ops 暴露之
      llm: {
        stream(options) {
          streamCalls.push(options);
          return (async function* () {
            yield { type: "text-delta", index: 0, text: '{"ops":[{"action":"write","name":"ro.md","type":"project","title":"RO","description":"d","content":"c"}]}' };
            yield { type: "finish", reason: { kind: "stop" } };
          })();
        },
      },
    };
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 5000 });

    const session = fakeSession(workspace, [USER_EVENT]);
    handlers.get("session/event")(session, USER_EVENT);
    handlers.get("session/event")(session, { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const { memoryDir } = projectMemoryPaths(root, workspace);
    assert.equal(streamCalls.length, 0, "只读保护下不得发起提取 LLM 调用");
    assert.equal(existsSync(memoryDir), false, "只读保护下不得写出任何记忆文件");
    assert.ok(logs.some((line) => /只读保护/.test(line)), "应有只读保护日志（本轮跳过提取）");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("recallTotalBudgetMs 配置键：默认 20000 / 显式生效 / 超 MAX_TIMER_DELAY_MS 抛错", () => {
  assert.equal(resolveConfig({ enabled: true }).recallTotalBudgetMs, 20000, "默认总预算 20000ms");
  assert.equal(resolveConfig({ enabled: true, recallTotalBudgetMs: 1234 }).recallTotalBudgetMs, 1234, "显式传值应生效");
  assert.throws(() => resolveConfig({ enabled: true, recallTotalBudgetMs: 2147483648 }), /recallTotalBudgetMs too large/);
  assert.throws(() => resolveConfig({ enabled: true, recallTotalBudgetMs: 0 }), /recallTotalBudgetMs/);
  assert.throws(() => resolveConfig({ enabled: true, recallTotalBudgetMs: 1.5 }), /recallTotalBudgetMs/);
});

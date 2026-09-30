// entry：插件入口集成冒烟（假 cordis ctx）——事件订阅→skip/提取→落盘→注入段渲染。
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apply, name, inject } from "../lib/index.js";
import { projectMemoryPaths } from "../lib/paths.js";

function fakeCtx(streamImpl) {
  const handlers = new Map();
  const sections = [];
  const effects = [];
  const streamCalls = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(type, fn) {
      handlers.set(type, fn);
    },
    effect(fn, label) {
      effects.push({ fn, label });
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
  return { ctx, handlers, sections, effects, streamCalls };
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
  assert.equal(name, "dsh-memory");
  assert.deepEqual(inject.sort(), ["llm", "systemPrompt"]);
  const { ctx, sections } = fakeCtx();
  apply(ctx, { enabled: false });
  assert.equal(sections.length, 0); // 关闭时不注入
  apply(ctx, {}); // 审查 P2-1：缺省关（fail-closed），无显式 enabled: true 不启用
  assert.equal(sections.length, 0);
  apply(ctx, { enabled: true, storageRoot: join(tmpdir(), "dsh-memory-entry") });
  assert.equal(sections.length, 2);
  assert.equal(sections[0].interpolate, false);
  assert.equal(sections[1].interpolate, false);
});

test("事件→提取→落盘 全链路", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-memory-entry-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-memory-ws-"));
  try {
    const { ctx, handlers, sections, streamCalls } = fakeCtx(async function* () {
      yield {
        type: "text-delta",
        index: 0,
        text: '{"ops":[{"action":"write","name":"uses-pnpm.md","type":"project","title":"Uses pnpm","description":"包管理器","content":"团队统一用 pnpm"}]}',
      };
      yield { type: "finish", reason: { kind: "stop" } };
    });
    apply(ctx, { enabled: true, storageRoot: root, provider: "prov", model: "model-x", timeoutMs: 5000 });
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
    assert.equal(streamCalls[0].purpose, "dsh-memory-extraction");
    assert.equal(streamCalls[0].sessionId, "s-test");
    // 注入段：索引段此时能读到 MEMORY.md
    const indexText = sections[1].text({ agent: { session: { header: { cwd: workspace } } } });
    assert.match(indexText, /uses-pnpm\.md/);
    const usageText = sections[0].text({ agent: { session: { header: { cwd: workspace } } } });
    assert.match(usageText, new RegExp(paths.memoryDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // 无 cwd 会话：注入段为空串（不炸组装）
    assert.equal(sections[0].text({}), "");
    assert.equal(sections[1].text({}), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("skip 轮（无散文）不调 LLM 但推进", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-memory-entry-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-memory-ws-"));
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
  const root = mkdtempSync(join(tmpdir(), "dsh-memory-entry-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-memory-ws-"));
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
  apply(ctx, { enabled: true, storageRoot: join(tmpdir(), "dsh-memory-entry-x"), provider: "prov", model: "m" });
  const session = fakeSession("D:\\nowhere", [USER_EVENT]);
  handlers.get("session/event")(session, { type: "turn/end", seq: 4, data: { turn: 1, reason: { kind: "aborted" } } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(streamCalls.length, 0);
});

test("config 未知键 fail loud", () => {
  const { ctx } = fakeCtx();
  assert.throws(() => apply(ctx, { enabled: true, whatever: 1 }));
});

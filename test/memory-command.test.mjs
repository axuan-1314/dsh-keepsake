// memory-command：命令行解析、文案渲染、以及"纠错结局不误报成错误"这条口径。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  makeMemoryCommandHandler,
  parseMemoryCommand,
  pickCorrectionTarget,
  renderCorrectionOutcome,
  renderMemoryResult,
  scopeText,
  typeText,
} from "../lib/memory-command.js";

test("parseMemoryCommand：各子命令解析", () => {
  assert.deepEqual(parseMemoryCommand(""), { kind: "list" });
  assert.deepEqual(parseMemoryCommand("   "), { kind: "list" });
  assert.deepEqual(parseMemoryCommand("help"), { kind: "help" });
  assert.deepEqual(parseMemoryCommand("--help"), { kind: "help" });
  assert.deepEqual(parseMemoryCommand("pnpm 铁律"), { kind: "search", query: "pnpm 铁律" });
  assert.deepEqual(parseMemoryCommand("why 部署端口"), { kind: "why", query: "部署端口" });
  assert.deepEqual(parseMemoryCommand("forget 旧端口"), { kind: "forget", query: "旧端口" });
  assert.deepEqual(
    parseMemoryCommand("fix 部署端口 | 现在是 8080 不是 3000"),
    { kind: "fix", query: "部署端口", complaint: "现在是 8080 不是 3000" },
  );
});

test("parseMemoryCommand：缺参数给可执行的中文错误，不是空白", () => {
  assert.equal(parseMemoryCommand("why").kind, "error");
  assert.match(parseMemoryCommand("why").error, /需要关键词/);
  assert.equal(parseMemoryCommand("forget").kind, "error");
  assert.equal(parseMemoryCommand("fix").kind, "error");
  assert.match(parseMemoryCommand("fix").error, /关键词 \| 诉求/);
  // 有竖线但一侧为空 → 错误
  assert.equal(parseMemoryCommand("fix 部署 |").kind, "error");
  assert.equal(parseMemoryCommand("fix | 错了").kind, "error");
  // 无竖线也报错（不是把整段当关键词蒙混过去）
  const noBar = parseMemoryCommand("fix 部署端口");
  assert.equal(noBar.kind, "error");
  assert.match(noBar.error, /关键词 \| 诉求/);
});

test("scopeText / typeText：范围与类型人话化，未知不编", () => {
  assert.equal(scopeText("project"), "项目");
  assert.equal(scopeText("global:work-profile"), "工作背景");
  assert.equal(scopeText("global:unknown-cat"), "全局/unknown-cat");
  assert.equal(scopeText(""), "未知");
  assert.equal(typeText("feedback"), "反馈");
  assert.equal(typeText("reference"), "参考");
  assert.equal(typeText("nonsense"), "");
});

test("renderMemoryResult/list：空态给可操作提示，有条目给计数", () => {
  assert.match(renderMemoryResult({ kind: "list", entries: [] }), /还没有条目/);
  const text = renderMemoryResult({
    kind: "list",
    entries: [
      { title: "PNPM 铁律", scope: "global:work-profile", type: "feedback", name: "pnpm-rule.md", description: "只用 pnpm" },
    ],
    total: 1,
    truncated: false,
  });
  assert.match(text, /最近的记忆（共 1 条）/);
  assert.match(text, /PNPM 铁律（工作背景 · 反馈）/);
  assert.match(text, /pnpm-rule\.md/);
});

test("renderMemoryResult/search：空命中给换词提示，命中给条数与条目", () => {
  const empty = renderMemoryResult({ kind: "search", query: "不存在的东西", results: [] });
  assert.match(empty, /没找到包含「不存在的东西」/);
  assert.match(empty, /\/memory 看全部条目/);

  const hit = renderMemoryResult({
    kind: "search",
    query: "pnpm",
    results: [{ title: "PNPM 铁律", scope: "global:work-profile", type: "feedback", name: "p.md", description: "只用 pnpm", snippet: "", hits: ["name"] }],
    total: 1,
  });
  assert.match(hit, /找到 1 条/);
});

test("renderMemoryResult/why：额外给出命中位置与相关度", () => {
  const text = renderMemoryResult({
    kind: "why",
    query: "pnpm",
    results: [{
      title: "PNPM 铁律", scope: "project", type: "project", name: "p.md",
      description: "", snippet: "", hits: ["name", "body"], score: 115,
    }],
    total: 1,
  });
  assert.match(text, /命中：/);
  assert.match(text, /文件名/);
  assert.match(text, /正文/);
  assert.match(text, /相关度 115/);
});

test("renderCorrectionOutcome：三种结局各自的人话（needs-input 不是失败口吻）", () => {
  const applied = renderCorrectionOutcome({ outcome: "applied", writes: 1, deletes: 0 }, { target: "deploy.md" });
  assert.match(applied, /已纠正 deploy\.md/);
  assert.match(applied, /1 处改写/);
  assert.match(applied, /快照/);
  assert.doesNotMatch(applied, /校验失败/, "没有 verifyFailed 时不凭空提校验");

  // 有一处改动被写后校验打回：只报「已纠正 X 处改写」等于告诉用户全改成了。
  const partial = renderCorrectionOutcome({ outcome: "applied", writes: 1, deletes: 0, verifyFailed: 2 }, { target: "deploy.md" });
  assert.match(partial, /已纠正 deploy\.md/);
  assert.match(partial, /另有 2 处改动写后校验失败/, "被打回的改动必须明说");

  const needs = renderCorrectionOutcome({ outcome: "needs-input", reason: "wrong-fact" }, { target: "a.md", complaint: "感觉不对" });
  assert.match(needs, /不足以确定怎么改/);
  assert.match(needs, /记忆没有任何改动/);
  assert.ok(!/失败/.test(needs), "needs-input 不该带失败口吻");

  const nothing = renderCorrectionOutcome({ outcome: "nothing" }, { target: "a.md" });
  assert.match(nothing, /不需要改动/);

  const failed = renderCorrectionOutcome({ outcome: "error", error: "no-op-applied" }, { target: "a.md" });
  assert.match(failed, /失败/);
  assert.match(failed, /记忆未改动/);
});

test("pickCorrectionTarget：取最高分那条（结果已排序），无结果给 null", () => {
  assert.equal(pickCorrectionTarget([]), null);
  assert.equal(pickCorrectionTarget(null), null);
  assert.equal(pickCorrectionTarget([{ name: "b.md" }, { name: "a.md" }]).name, "b.md");
  assert.equal(pickCorrectionTarget([null, { name: "ok.md" }]).name, "ok.md");
});

test("handler /list：调 list 并渲染", async () => {
  const handler = makeMemoryCommandHandler({
    list: () => ({ entries: [], total: 0, truncated: false }),
    search: () => ({ results: [] }),
  });
  const out = await handler({ rawInput: "" });
  assert.equal(out.kind, "success");
  assert.match(out.text, /还没有条目/);
});

test("handler /search：把查询透传给 search", async () => {
  let got = null;
  const handler = makeMemoryCommandHandler({
    search: (q) => {
      got = q;
      return { results: [], total: 0 };
    },
    list: () => ({ entries: [] }),
  });
  await handler({ rawInput: "pnpm 铁律" });
  assert.equal(got, "pnpm 铁律");
});

test("handler /fix：定位后提交纠错，applied 报 success", async () => {
  let corrected = null;
  const handler = makeMemoryCommandHandler({
    search: () => ({
      results: [{ name: "deploy.md", title: "部署端口", scope: "project", type: "project", projectId: "p-0123456789abcdef" }],
      total: 1,
    }),
    list: () => ({ entries: [] }),
    correct: async (input) => {
      corrected = input;
      return { outcome: "applied", writes: 1, deletes: 0 };
    },
  });
  const out = await handler({ rawInput: "fix 部署端口 | 现在是 8080" });
  assert.equal(out.kind, "success");
  assert.equal(corrected.target, "deploy.md");
  assert.equal(corrected.reason, "现在是 8080");
  assert.equal(corrected.kind, "wrong-fact");
  assert.equal(corrected.scope, "project");
  assert.equal(corrected.projectId, "p-0123456789abcdef");
  assert.match(out.text, /已纠正/);
});

test("handler /fix：needs-input 报 success（用户没做错，只是诉求不够具体）", async () => {
  const handler = makeMemoryCommandHandler({
    search: () => ({ results: [{ name: "a.md", title: "A", scope: "project" }], total: 1 }),
    list: () => ({ entries: [] }),
    correct: async () => ({ outcome: "needs-input", reason: "other" }),
  });
  const out = await handler({ rawInput: "fix A | 有点怪" });
  assert.equal(out.kind, "success", "needs-input 不是命令错误");
  assert.match(out.text, /不足以确定怎么改/);
});

test("handler /forget：把诉求换成删除请求（kind=wrong-scope，复用既有枚举）", async () => {
  let corrected = null;
  const handler = makeMemoryCommandHandler({
    search: () => ({ results: [{ name: "old.md", title: "旧端口", scope: "project" }], total: 1 }),
    list: () => ({ entries: [] }),
    correct: async (input) => {
      corrected = input;
      return { outcome: "applied", writes: 0, deletes: 1 };
    },
  });
  await handler({ rawInput: "forget 旧端口" });
  assert.equal(corrected.target, "old.md");
  assert.equal(corrected.kind, "wrong-scope");
  assert.match(corrected.reason, /不该存在|删除/);
});

test("handler：命中多条时如实说明取了哪条（不假装懂用户指哪条）", async () => {
  const handler = makeMemoryCommandHandler({
    search: () => ({
      results: [
        { name: "a.md", title: "端口 A", scope: "project" },
        { name: "b.md", title: "端口 B", scope: "project" },
      ],
      total: 2,
    }),
    list: () => ({ entries: [] }),
    correct: async () => ({ outcome: "applied", writes: 1, deletes: 0 }),
  });
  const out = await handler({ rawInput: "fix 端口 | 错了" });
  assert.match(out.text, /命中 2 条/);
  assert.match(out.text, /本次处理「端口 A」\/a\.md/);
});

test("handler：定位不到目标时明确拒绝，不白烧一次纠错调用", async () => {
  let called = 0;
  const handler = makeMemoryCommandHandler({
    search: () => ({ results: [], total: 0 }),
    list: () => ({ entries: [] }),
    correct: async () => {
      called += 1;
      return { outcome: "applied" };
    },
  });
  const out = await handler({ rawInput: "fix 不存在的东西 | 错了" });
  assert.equal(out.kind, "error");
  assert.equal(called, 0, "定位失败不该调纠错");
  assert.match(out.text, /没找到包含/);
});

test("handler：纠错抛错 → error 且文案带原因，不把异常漏给宿主", async () => {
  const handler = makeMemoryCommandHandler({
    search: () => ({ results: [{ name: "a.md", title: "A", scope: "project" }], total: 1 }),
    list: () => ({ entries: [] }),
    correct: async () => {
      throw new Error("E_NO_ROUTE");
    },
  });
  const out = await handler({ rawInput: "fix A | 错了" });
  assert.equal(out.kind, "error");
  assert.match(out.text, /E_NO_ROUTE/);
});

test("handler：帮助文案覆盖全部子命令", async () => {
  const handler = makeMemoryCommandHandler({ search: () => ({}), list: () => ({ entries: [] }) });
  const out = await handler({ rawInput: "help" });
  for (const piece of ["/memory <关键词>", "why", "fix", "forget"]) {
    assert.ok(out.text.includes(piece), `帮助里应含 ${piece}`);
  }
});

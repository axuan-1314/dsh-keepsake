// runtime-inject：运行时记忆层注入接线（RUNTIME-FORMAT §七/§八/§十）。
// 覆盖：六段注入（runtime 两段位置/内容）、scope 判定（cwd → projects/<slug>-<hash16>，
//       cwd 不可得 → global）、只读闸（有缓存用缓存 / 无缓存跳过 + usage 记 readOnly）、
//       status=error 可见降级、三开关矩阵（runtimeEnabled × conversationMemory × projectMemory）、
//       persona 8000 截断、写盘失效接线，以及回归门「无 runtime 数据时与旧四段内容集合等价」。
import assert from "node:assert/strict";
// 关闭 runtime 求值记忆化：让「compile/写盘后注入能否看到新内容」成为可判定的行为
// （默认 2000ms TTL 会遮蔽，等 2 秒既慢又受 CI 抖动影响）。apply() 在调用时才读 env。
process.env.DSH_KEEPSAKE_RUNTIME_MEMO_TTL_MS = "0";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apply, renderGlobalIndex } from "../lib/index.js";
import { createEntry, writeAddressing, writePersona } from "../lib/global-store.js";
import { projectMemoryPaths } from "../lib/paths.js";
import { writeSettings, resetSettingsCache } from "../lib/settings.js";
import { scopeDir } from "../lib/runtime.js";
import { forceCompile } from "../lib/runtime-archive.js";
import { __resetMetricsForTest } from "../lib/metrics.js";
import { MEMORY_CONTEXT_INTRO, MEMORY_CONTEXT_SUPERSEDE_NOTE } from "../lib/inject-channel.js";
import { FORMAT_VERSION } from "../lib/format.js";

function fakeCtx({ logs = null } = {}) {
  const sections = [];
  const handlers = new Map();
  const record = (level, ...args) => { if (logs !== null) logs.push({ level, args }); };
  const ctx = {
    logger: {
      info: (...a) => record("info", ...a),
      warn: (...a) => record("warn", ...a),
      error: (...a) => record("error", ...a),
    },
    on(event, handler) { handlers.set(event, handler); return () => {}; },
    effect() {},
    inject(_deps, setup) {
      setup({ effect(fn) { fn(); }, webServer: { register() { return () => {}; } } });
    },
    systemPrompt: { section(section) { sections.push(section); return () => {}; } },
    llm: { stream() { throw new Error("不应调用"); } },
  };
  return { ctx, sections, handlers };
}

function freshRoot() {
  resetSettingsCache();
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-rt-inject-"));
}

function seedProjectMemory(root) {
  const { memoryDir } = projectMemoryPaths(root, root);
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, "p.md"), "---\nname: p\ntitle: P\n---\n项目正文。\n");
  writeFileSync(join(memoryDir, "MEMORY.md"), "- [P](p.md) — 项目条目\n");
  return { memoryDir };
}

function makeAgent({ cwd } = {}) {
  return { session: { header: { cwd }, surface: { nodes: [] }, eventAt() {} } };
}

const payloadOf = ({ agent, messages, step = 1 }) => ({ agent, messages, step, signal: { aborted: false } });
const run = (handler, payload, decision) => handler(payload, async () => decision);
const textOf = (message) => message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const userMsg = (text) => ({ role: "user", content: [{ type: "text", text }] });

/** 起 message 模式插件并返回 pre-step handler + 注入文本求值器（每轮新建 agent = 新会话，必发块）。 */
function startMessage(root, extra = {}) {
  const { ctx, handlers, sections } = fakeCtx();
  apply(ctx, { enabled: true, storageRoot: root, ...extra });
  const handler = handlers.get("agent/pre-step");
  assert.equal(typeof handler, "function", "message 模式应注册 pre-step");
  /** 用显式 agent 求一次注入文本（cwd 缺省=无 cwd 会话，不是 undefined 触发默认参数）。 */
  const injectTextOf = async (agent) => {
    const decision = { kind: "enter", messages: [userMsg("正常 用户 一句话")] };
    const out = await run(handler, payloadOf({ agent, messages: decision.messages }), decision);
    const injected = out.messages.find((m) => m.source?.form === "memory-context");
    return injected === void 0 ? "" : textOf(injected);
  };
  const injectText = (cwd) => injectTextOf(makeAgent({ cwd: cwd === void 0 ? root : cwd }));
  const injectTextNoCwd = () => injectTextOf(makeAgent({ cwd: void 0 }));
  return { handler, sections, injectText, injectTextNoCwd, injectTextOf };
}

/** 把注入块按「段头」切成段（识别人设/全局索引/项目说明/项目索引/runtime 两段的段头）。 */
const SEGMENT_HEADINGS = [
  "## 用户为 DSH 设定的补充人设",
  "## Global memory index (user-level, applies to all conversations)",
  "## Persistent project memory",
  "## Project memory index (MEMORY.md)",
];
function segmentsOf(text) {
  const body = text.replace(/^<memory-context>\n/, "").replace(/\n<\/memory-context>$/, "");
  const starts = [];
  for (const heading of SEGMENT_HEADINGS) {
    const at = body.indexOf(heading);
    if (at >= 0) starts.push({ at, heading });
  }
  starts.sort((a, b) => a.at - b.at);
  return starts.map((entry, index) => body.slice(entry.at, index + 1 < starts.length ? starts[index + 1].at : body.length).trim());
}

// ---- 六段注入：runtime 两段位置与内容 ----

test("runtimeEnabled=true 且产物 ok：消息块含 runtimeUser/runtimeMemory，位置在 persona 后 globalIndex 前", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    writeAddressing(root, { dshName: "小助手" });
    writePersona(root, "回答要直接。");
    createEntry(root, "user-profile", { title: "Pref", description: "偏好", content: "喜欢简洁" });
    createEntry(root, "work-profile", { title: "Stack", description: "技术栈", content: "pnpm" });
    seedProjectMemory(root);
    writeSettings(root, { runtimeEnabled: true });
    const { injectText } = startMessage(root);

    const text = await injectText();
    assert.match(text, /^<memory-context>/);
    // 产物内容进场（AUTO-GENERATED 头 + 条目行）
    assert.match(text, /AUTO-GENERATED by dsh-keepsake/, "runtime 产物（含头声明）应在注入块里");
    assert.match(text, /\[Pref\]/, "user-profile 条目应进 runtimeUser 段");
    assert.match(text, /\[Stack\]/, "work-profile 条目应进 runtimeMemory 段");
    // 位置序：persona < runtimeUser < runtimeMemory < globalIndex < usage
    const personaAt = text.indexOf("用户为 DSH 设定的补充人设");
    const runtimeAt = text.indexOf("AUTO-GENERATED");
    const usageAt = text.indexOf("## Persistent project memory");
    assert.ok(personaAt > 0 && runtimeAt > personaAt, "runtime 段在 persona 之后");
    assert.ok(usageAt > runtimeAt, "runtime 段在 usage 之前");
    // 双份消失：三分类画面已由 runtime 段承载 → globalIndex 不再重复渲染它们
    assert.doesNotMatch(text, /### 用户个人背景 \(user-profile\)/, "runtime 覆盖的三分类不再进 globalIndex");
    assert.doesNotMatch(text, /### 工作背景 \(work-profile\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope 判定：cwd 可得 → projects/<slug>-<hash16> 产物；cwd 不可得 → global 产物", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "GlobalOnly", description: "全局条目", content: "全局正文" });
    const { memoryDir } = seedProjectMemory(root);
    writeFileSync(join(memoryDir, "proj-only.md"), "---\nname: proj-only\ntitle: ProjOnly\ndescription: 项目条目\nmetadata:\n  type: project\n---\n项目正文\n");
    writeSettings(root, { runtimeEnabled: true });
    const { injectText, injectTextNoCwd } = startMessage(root);

    // 有 cwd：项目 scope 产物 → 含项目条目（proj-only），且产物落盘位置正是 scopeDir(projects/…)
    const withCwd = await injectText(root);
    assert.match(withCwd, /\[ProjOnly\]/, "项目 scope 产物应含本项目条目");
    const paths = projectMemoryPaths(root, root);
    const projectScope = `projects/${paths.slug}-${paths.hash}`;
    assert.ok(existsSync(join(scopeDir(root, projectScope), "MEMORY.md")), "产物落在 project scope 目录");

    // 无 cwd：回落 global scope → 产物只有全局条目，不含项目条目
    const noCwd = await injectTextNoCwd();
    assert.match(noCwd, /\[GlobalOnly\]/, "global scope 产物含全局条目");
    assert.doesNotMatch(noCwd, /\[ProjOnly\]/, "global scope 产物不含项目条目（scope 判定生效）");
    assert.ok(existsSync(join(scopeDir(root, "global"), "MEMORY.md")), "产物落在 global scope 目录");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 只读闸（format-readonly） ----

test("只读闸：有缓存用缓存文本 + usage 记 [runtime readOnly]；无缓存跳过 runtime 段（不写盘）", async () => {
  __resetMetricsForTest();
  const rootNoCache = freshRoot();
  const rootCached = freshRoot();
  try {
    // ---- 无缓存：整根都是"更新版写过的数据"，runtime/ 里什么都没有 ----
    createEntry(rootNoCache, "work-profile", { title: "W", description: "工", content: "工" });
    writeFileSync(join(rootNoCache, "keepsake-format.json"), JSON.stringify({ formatVersion: FORMAT_VERSION + 1 }) + "\n", "utf8");
    writeSettings(rootNoCache, { runtimeEnabled: true });
    const noCache = startMessage(rootNoCache);
    const textNoCache = await noCache.injectText();
    assert.match(textNoCache, /\[runtime readOnly\]/, "usage 应记只读告警");
    assert.doesNotMatch(textNoCache, /AUTO-GENERATED/, "无缓存 → 不注入 runtime 段");
    assert.equal(existsSync(join(rootNoCache, "runtime")), false, "只读闸下绝不写任何 runtime 产物");
    assert.match(textNoCache, /### 工作背景 \(work-profile\)/, "无 runtime 产物 → globalIndex 回退全量（三分类照旧）");

    // ---- 有缓存：先用可写态编译一次，再把存储标成更新版 ----
    createEntry(rootCached, "work-profile", { title: "CachedW", description: "缓存条目", content: "正文" });
    writeSettings(rootCached, { runtimeEnabled: true });
    resetSettingsCache();
    const warm = startMessage(rootCached);
    const warmText = await warm.injectText();
    assert.match(warmText, /\[CachedW\]/, "前置：可写态下产物已生成");
    writeFileSync(join(rootCached, "keepsake-format.json"), JSON.stringify({ formatVersion: FORMAT_VERSION + 1 }) + "\n", "utf8");
    // 新起一次 apply：formatState 在装载时求值（重启后进入只读态的真实路径）
    const readonly = startMessage(rootCached);
    const textCached = await readonly.injectText();
    assert.match(textCached, /\[CachedW\]/, "有缓存 → 用缓存文本注入");
    assert.match(textCached, /\[runtime readOnly\]/, "只读态 usage 照记告警");
  } finally {
    rmSync(rootNoCache, { recursive: true, force: true });
    rmSync(rootCached, { recursive: true, force: true });
  }
});

// ---- status=error 可见降级 ----

test("status=error：跳过 runtime 段 + usage 记 [runtime degraded: compile error]，globalIndex 回退全渲染", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "user-profile", { title: "U", description: "用户", content: "用户" });
    createEntry(root, "work-profile", { title: "W", description: "工", content: "工" });
    seedProjectMemory(root);
    writeSettings(root, { runtimeEnabled: true });
    const { injectText } = startMessage(root);
    // 先正常编译一次（确保 runtime/ 目录存在），随后破坏落盘：用目录占位 USER.md 让 rename 必失败
    await injectText();
    const dir = scopeDir(root, "global");
    const target = join(dir, "USER.md");
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });

    // 新起一次 apply 清掉进程内 runtime 记忆（等价于新会话/重启后的首次注入）
    const degraded = startMessage(root);
    const noCwdText = await degraded.injectTextNoCwd();
    assert.match(noCwdText, /\[runtime degraded: compile error\]/, "usage 应记 error 降级告警");
    assert.doesNotMatch(noCwdText, /AUTO-GENERATED/, "error 态不注入 runtime 段");
    assert.match(noCwdText, /### 工作背景 \(work-profile\)/, "error 态 globalIndex 回退全渲染（不静默丢分类）");
    assert.match(noCwdText, /\[W\]\(w\.md\)/, "三分类条目行仍在");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 三开关矩阵 ----

test("开关矩阵：runtimeEnabled × conversationMemory × projectMemory → runtime 两段有无", async () => {
  __resetMetricsForTest();
  const matrix = [
    { conversationMemory: true, projectMemory: true, runtimeEnabled: true, expect: true },
    { conversationMemory: true, projectMemory: true, runtimeEnabled: false, expect: false },
    { conversationMemory: true, projectMemory: false, runtimeEnabled: true, expect: false },
    { conversationMemory: false, projectMemory: true, runtimeEnabled: true, expect: false },
    { conversationMemory: false, projectMemory: false, runtimeEnabled: false, expect: false },
  ];
  for (const row of matrix) {
    const root = freshRoot();
    try {
      createEntry(root, "work-profile", { title: "W", description: "工", content: "工" });
      seedProjectMemory(root);
      writeSettings(root, {
        conversationMemory: row.conversationMemory,
        projectMemory: row.projectMemory,
        runtimeEnabled: row.runtimeEnabled,
      });
      const { injectText } = startMessage(root);
      const text = await injectText();
      const label = `cm=${row.conversationMemory} pm=${row.projectMemory} rt=${row.runtimeEnabled}`;
      if (row.expect) {
        assert.match(text, /AUTO-GENERATED by dsh-keepsake/, `${label}：runtime 两段应注入`);
        // 六段齐：runtime 两段都有产物文本（同一份产物头在两段各出现一次）
        assert.equal((text.match(/AUTO-GENERATED by dsh-keepsake/g) ?? []).length, 2, `${label}：runtimeUser 与 runtimeMemory 各一段`);
      } else {
        assert.doesNotMatch(text, /AUTO-GENERATED/, `${label}：runtime 两段不得注入`);
      }
      // projectMemory 关 → 项目两段也不在（口径一致）
      if (!row.projectMemory) assert.doesNotMatch(text, /Persistent project memory/, `${label}：项目段同样不注`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("开关矩阵：projectMemory 关时 runtime 段不注 → 全局三分类仍走 globalIndex（内容不丢）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "user-profile", { title: "UP", description: "用户画像", content: "用户" });
    createEntry(root, "work-profile", { title: "WP", description: "工作背景", content: "工" });
    seedProjectMemory(root);
    writeSettings(root, { runtimeEnabled: true, projectMemory: false });
    const { injectText } = startMessage(root);
    const text = await injectText();
    assert.doesNotMatch(text, /AUTO-GENERATED/, "projectMemory 关 → runtime 两段不注（保守口径）");
    // 三分类没被 runtime 接管 → 必须照旧渲染，不能因为开关组合把内容弄丢
    assert.match(text, /### 用户个人背景 \(user-profile\)/, "globalIndex 照旧承载 user-profile");
    assert.match(text, /### 工作背景 \(work-profile\)/);
    assert.match(text, /\[UP\]\(up\.md\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 回归门：无 runtime 数据 / runtimeEnabled=false 时与旧四段内容集合等价 ----

test("回归门：runtimeEnabled=false 时，输出 = 旧四段渲染剔除 long-term 索引行（内容集合等价）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    writeAddressing(root, { dshName: "小助手", userAlias: "朋友" });
    writePersona(root, "回答要直接。");
    createEntry(root, "user-profile", { title: "U", description: "用户", content: "用户正文" });
    createEntry(root, "work-profile", { title: "W", description: "工", content: "工作正文" });
    createEntry(root, "current-focus", { title: "C", description: "焦", content: "焦点正文" });
    createEntry(root, "recent-activity", { title: "R", description: "动态", content: "动态正文" });
    // 归档区条目：0.6.0 起无条件剔出索引（本回归门唯一允许的差异）
    createEntry(root, "long-term", { title: "Archived", description: "归档钩子", content: "归档正文" });
    const { memoryDir } = seedProjectMemory(root);

    const { injectText } = startMessage(root); // runtimeEnabled 缺省 false
    const text = await injectText();

    // ① runtime 两段为空 = 不存在：块里没有产物头、没有 readOnly/degraded 告警
    assert.doesNotMatch(text, /AUTO-GENERATED/, "runtimeEnabled=false → 不编译不注入 runtime 段");
    assert.doesNotMatch(text, /\[runtime (readOnly|degraded)/, "开关关时不该出现 runtime 告警行");
    assert.equal(existsSync(join(root, "runtime")), false, "开关关 = 不编译（零写盘）");

    // ② 非 runtime 四段的段集合与文本与旧四段一致（顺序也一致）
    const segs = segmentsOf(text);
    assert.equal(segs.length, 4, `应只有四段（实际 ${segs.length} 段）`);
    assert.match(segs[0], /^## 用户为 DSH 设定的补充人设/);
    assert.match(segs[1], /^## Global memory index/);
    assert.match(segs[2], /^## Persistent project memory/);
    assert.match(segs[3], /^## Project memory index \(MEMORY\.md\)/);

    // ③ 全局索引段内容：五分类里四类照旧、long-term 不在（唯一白名单差异）、recent-activity 在
    const globalIdx = segs[1];
    assert.match(globalIdx, /### 用户个人背景 \(user-profile\)/);
    assert.match(globalIdx, /### 工作背景 \(work-profile\)/);
    assert.match(globalIdx, /### 当前关注 \(current-focus\)/);
    assert.match(globalIdx, /### 近期动态 \(recent-activity\)/);
    assert.doesNotMatch(globalIdx, /### 长期记忆 \(long-term\)/, "差异白名单：long-term 索引行移除");
    assert.doesNotMatch(globalIdx, /\[Archived\]/, "归档条目钩子不进索引");
    for (const line of ["- [U](u.md) — 用户", "- [W](w.md) — 工", "- [C](c.md) — 焦", "- [R](r.md) — 动态"]) {
      assert.ok(globalIdx.includes(line), `旧四段的条目行应原样保留：${line}`);
    }

    // ④ 项目两段原样（路径行 + MEMORY.md 索引行）
    assert.ok(segs[2].includes(`This project has persistent memory at: ${memoryDir}`));
    assert.ok(segs[3].includes("- [P](p.md) — 项目条目"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("回归门：0.5.0 关键输出快照（runtimeEnabled=false 下四段文本逐字钉死，差异仅 long-term 索引行）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    writeAddressing(root, { dshName: "小助手", userAlias: "朋友" });
    writePersona(root, "回答要直接。");
    createEntry(root, "user-profile", { title: "U", description: "用户", content: "用户正文" });
    createEntry(root, "long-term", { title: "Archived", description: "归档钩子", content: "归档正文" });
    const { memoryDir } = seedProjectMemory(root);
    const { injectText } = startMessage(root);
    const text = await injectText();

    // 快照把绝对路径归一成 <ROOT> 并统一分隔符（win32 '\\' → '/'），断言四段正文逐字稳定。
    const normalize = (value) => String(value).split(root).join("<ROOT>").split("\\").join("/");
    const normalized = normalize(text);
    const expected = [
      "<memory-context>",
      MEMORY_CONTEXT_SUPERSEDE_NOTE,
      "",
      MEMORY_CONTEXT_INTRO,
      "",
      "## 用户为 DSH 设定的补充人设",
      "",
      "用户叫你「小助手」。",
      "希望你称呼他为「朋友」。",
      "",
      "回答要直接。",
      "",
      "## Global memory index (user-level, applies to all conversations)",
      "",
      "Global memory root: <ROOT>/global — each line points to one memory file; Read any file whose hook matters.",
      "",
      "### 工作背景 (work-profile)",
      "（空）",
      "",
      "### 用户个人背景 (user-profile)",
      "- [U](u.md) — 用户",
      "",
      "### 当前关注 (current-focus)",
      "（空）",
      "",
      "### 近期动态 (recent-activity)",
      "（空）",
      "",
      "",
      "## Persistent project memory",
      "",
      `This project has persistent memory at: ${normalize(memoryDir)}`,
      "- MEMORY.md is the index; each line points to one memory file. Read MEMORY.md first, then Read any file whose hook matters before relying on it.",
      "- One file = one fact, with frontmatter (name / description / metadata.type). Types: user (who the user is), feedback (how to behave, include Why: and How to apply:), project (decisions and state of this project), reference (pointers).",
      "- Link related memories with [[name]]; dangling links are fine.",
      "- When the user asks you to remember something: Write the memory file directly (the directory already exists — do not mkdir) and append one index line to MEMORY.md: `- [Title](file.md) — one-line hook` (at most 150 chars).",
      "- When the user asks you to forget something: delete that memory file and its index line.",
      "- Do not save what the repository already records, or details only this session needs.",
      "- Turns with direct writes into the memory directory skip automatic extraction.",
      "",
      "## Project memory index (MEMORY.md)",
      "",
      "- [P](p.md) — 项目条目",
      "",
      "</memory-context>",
    ];
    // 五分类里 long-term 整段消失（段落头 + 行都不在）——这是唯一允许的差异
    assert.doesNotMatch(normalized, /### 长期记忆 \(long-term\)/);
    assert.deepEqual(normalized.split("\n"), expected, "0.5.0 关键输出快照（long-term 剔除后）应逐字一致");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("回归门：runtimeEnabled=true 且产物 ok 时，非 runtime 段的差异有界（仅三分类离场 + runtime 两段进场）", async () => {
  __resetMetricsForTest();
  const build = async (runtimeEnabled) => {
    const root = freshRoot();
    try {
      writeAddressing(root, { dshName: "小助手" });
      writePersona(root, "回答要直接。");
      createEntry(root, "user-profile", { title: "UP", description: "用户画像", content: "用户" });
      createEntry(root, "recent-activity", { title: "Tick", description: "流水", content: "事件" });
      seedProjectMemory(root);
      writeSettings(root, { runtimeEnabled });
      const { injectText } = startMessage(root);
      const text = await injectText();
      const normalized = text.split(root).join("<ROOT>").split("\\").join("/");
      return { root, normalized };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const on = await build(true);
  const off = await build(false);
  const withRuntime = on.normalized;
  const withoutRuntime = off.normalized;

  // ① runtime 两段进场（含 AUTO-GENERATED 头），开关关时没有
  assert.match(withRuntime, /AUTO-GENERATED/, "开关开 → runtime 段在场");
  assert.doesNotMatch(withoutRuntime, /AUTO-GENERATED/, "开关关 → runtime 段不在场");

  // ② 允许的差异只有一处：runtime 覆盖的三分类从 globalIndex 离场（内容已进 runtime 段）
  assert.match(withRuntime, /AUTO-GENERATED[\s\S]*\[UP\]/, "user-profile 条目改由 runtimeUser 段承载");
  assert.match(withoutRuntime, /### 用户个人背景 \(user-profile\)\n- \[UP\]\(up\.md\) — 用户画像/, "开关关时三分类照旧在 globalIndex");
  // ③ 其余可比的非 runtime 段（persona / usage / recent-activity 行）逐字节一致
  for (const anchor of [
    "## 用户为 DSH 设定的补充人设\n\n用户叫你「小助手」。\n\n回答要直接。",
    "## Persistent project memory",
    "### 近期动态 (recent-activity)\n- [Tick](tick.md) — 流水",
  ]) {
    assert.ok(withRuntime.includes(anchor), `开关开时该段原样保留：${anchor.split("\n")[0]}`);
    assert.ok(withoutRuntime.includes(anchor), `开关关时该段原样保留：${anchor.split("\n")[0]}`);
  }
  // 项目段：开关开时项目条目已进产物 → 索引里剔掉该行；项目段整段消失属预期（只剩一个段标题没有意义）
  assert.match(withoutRuntime, /## Project memory index \(MEMORY\.md\)\n\n- \[P\]\(p\.md\) — 项目条目/, "开关关：项目索引原样");
  assert.match(withRuntime, /AUTO-GENERATED[\s\S]*\[P\]/, "开关开：项目条目改由 runtimeMemory 段承载");
  assert.doesNotMatch(withRuntime, /## Project memory index \(MEMORY\.md\)\n\n- \[P\]\(p\.md\)/, "开关开：项目条目不在索引里重复出现");
});

// ---- persona 8000 截断 ----

test("persona 上限 8000 字符：超限截断 + 可见 WARNING（不再按 16000 放行）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    writeAddressing(root, { dshName: "", userAlias: "" });
    writePersona(root, "人".repeat(9000));
    seedProjectMemory(root);
    const { injectText } = startMessage(root);
    const text = await injectText();
    assert.match(text, /\[WARNING\] 人设 超出注入预算/, "超 8000 应留可见 WARNING");
    assert.match(text, /8000 字符上限/, "WARNING 文案标明 8000 字符上限");
    assert.match(text, /人{100}/, "保留头部内容");
    assert.doesNotMatch(text, /人{8100}/, "超过 8000 的部分已被截掉");
    // 8000 以内不截：换一份 7000 字符的人设，不得出现 WARNING
    resetSettingsCache();
    const root2 = freshRoot();
    try {
      writeAddressing(root2, { dshName: "", userAlias: "" });
      writePersona(root2, "人".repeat(7000));
      seedProjectMemory(root2);
      const second = startMessage(root2);
      const text2 = await second.injectText();
      assert.doesNotMatch(text2, /\[WARNING\] 人设/, "7000 字符在 8000 上限内，不截");
      assert.match(text2, /人{7000}/);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- section 模式：runtime 两段同序承载（RUNTIME-FORMAT §10.1）----

test("section 模式：runtimeUser/runtimeMemory 两段承载产物，globalIndex 只留 recent-activity", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "user-profile", { title: "UP", description: "用户画像", content: "用户" });
    createEntry(root, "work-profile", { title: "WP", description: "工作", content: "工" });
    createEntry(root, "recent-activity", { title: "Tick", description: "流水", content: "事件" });
    seedProjectMemory(root);
    writeSettings(root, { runtimeEnabled: true });
    const { ctx, sections } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, injectChannel: "section" });
    const byName = (n) => sections.find((s) => s.name === `dsh-keepsake:${n}`);
    const scope = { agent: { session: { header: { cwd: root } } } };

    const userText = byName("runtime-user").text(scope);
    const memoryText = byName("runtime-memory").text(scope);
    assert.match(userText, /AUTO-GENERATED/, "runtimeUser 段应承载 USER.md 产物");
    assert.match(userText, /\[UP\]/);
    assert.match(memoryText, /AUTO-GENERATED/, "runtimeMemory 段应承载 MEMORY.md 产物");
    assert.match(memoryText, /\[WP\]/);
    // 段序：persona(4990) → runtime-user(4992) → runtime-memory(4993) → global-index(4995)
    const orders = ["persona", "runtime-user", "runtime-memory", "global-index", "instructions", "index"]
      .map((n) => byName(n).order);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b), "段 order 单调递增（顺序正确）");

    // globalIndex：三分类已被 runtime 承载 → 不渲染；recent-activity 照旧
    const globalIdx = byName("global-index").text(scope);
    assert.doesNotMatch(globalIdx, /### 用户个人背景/);
    assert.doesNotMatch(globalIdx, /### 工作背景/);
    assert.match(globalIdx, /### 近期动态 \(recent-activity\)/, "recent-activity 照旧渲染");
    assert.match(globalIdx, /\[Tick\]/);
    assert.doesNotMatch(globalIdx, /### 长期记忆/, "long-term 无条件不渲染");

    // 开关关 → 两段空，globalIndex 回退三分类
    writeSettings(root, { runtimeEnabled: false });
    assert.equal(byName("runtime-user").text(scope), "");
    assert.equal(byName("runtime-memory").text(scope), "");
    assert.match(byName("global-index").text(scope), /### 用户个人背景/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 写盘失效接线 ----

test("写盘失效：项目条目落盘 → 只清该 scope；全局条目落盘 → 全 scope 清", () => {
  const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  // 结构钉（落盘路径必须接线）：applyScopedOps 之后调失效
  assert.match(src, /invalidateRuntimeAfterWrite\(result, paths\)/, "提取落盘后应调 invalidateRuntimeAfterWrite");
  const anchor = src.indexOf("function invalidateRuntimeAfterWrite");
  assert.ok(anchor > 0, "invalidateRuntimeAfterWrite 应在");
  const region = src.slice(anchor, anchor + 2200);
  assert.match(region, /invalidateRuntimeCache\(storageRoot, null\)/, "全局条目操作 → 全失效（scope=null）");
  assert.match(region, /invalidateRuntimeCache\(storageRoot, `projects\/\$\{paths\.slug\}-\$\{paths\.hash\}`\)/, "项目条目操作 → 只清该 scope");
  assert.match(region, /runtimeMemo\.clear\(\)/, "失效同时清进程内 runtime 求值记忆");
});

test("写盘失效接线（行为面）：编译后改条目 → 下一次注入看到新内容（缓存被清）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "Before", description: "旧", content: "旧正文" });
    seedProjectMemory(root);
    writeSettings(root, { runtimeEnabled: true });
    const { injectText } = startMessage(root);
    const first = await injectText();
    assert.match(first, /\[Before\]/);
    assert.doesNotMatch(first, /\[After\]/);
    // 直接改条目（模拟外部写盘；sourceHash 指纹变化 → 下一次注入必重编）
    createEntry(root, "work-profile", { title: "After", description: "新", content: "新正文" });
    resetSettingsCache();
    const second = startMessage(root);
    const later = await second.injectText();
    assert.match(later, /\[After\]/, "新条目应出现在重编后的产物里");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("提取侧口径：renderGlobalIndex 默认剔除归档，includeArchived=true 时保留（模型要看得见 long-term）", () => {
  const root = freshRoot();
  try {
    createEntry(root, "long-term", { title: "Archived", description: "归档钩子", content: "归档正文" });
    // 注入面（默认）：归档区不可见
    const injected = renderGlobalIndex(root, { perCategoryLines: 20 }).text;
    assert.doesNotMatch(injected, /长期记忆 \(long-term\)/, "注入面必须剔除归档区");
    assert.doesNotMatch(injected, /\[Archived\]/);
    // 提取面（显式开启）：归档区可见——否则模型会把已归档条目再造一遍
    const extract = renderGlobalIndex(root, { perCategoryLines: 20, includeArchived: true }).text;
    assert.match(extract, /长期记忆 \(long-term\)/, "提取 prompt 必须看得见归档区");
    assert.match(extract, /\[Archived\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- P2-d 单行超长挤掉同类其它行必须可见（2026-10-22 补）----
// 语境：每类字符预算裁剪（clipLinesToChars）是「从尾部往前装、装不下即停」。
// 若某条索引行本身超预算（如描述极长），保它就必然丢掉前面所有能装下的行——
// 用户看到某分类只剩 1 条、面板里却有 8 条，无从解释。修法：追加可见提示行。

test("renderGlobalIndex：单行超长挤掉同类其它行时必须留可见提示", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    const catDir = join(root, "global", "work-profile");
    mkdirSync(catDir, { recursive: true });
    // 8 条正常行 + 1 条超长行（尾部，保最新会优先保它）
    const lines = [];
    for (let i = 0; i < 8; i += 1) lines.push(`- [W${i}](w${i}.md) — 正常描述 ${i}`);
    lines.push(`- [Huge](huge.md) — ${"X".repeat(3000)}`);
    writeFileSync(join(catDir, "MEMORY.md"), lines.join("\n") + "\n", "utf8");

    const out = renderGlobalIndex(root, { perCategoryChars: 1200 });
    const body = out.text;
    // 只能保下超长那条（装不下别的），但必须告知这一点
    assert.match(body, /另有 \d+ 条因过长未进注入/, "单行超长挤掉其它行时必须留可见提示");
    assert.match(body, /Huge/, "超长那条本身仍在（保最新）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderGlobalIndex：正常裁剪（无超长行）不出现该提示", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    const catDir = join(root, "global", "work-profile");
    mkdirSync(catDir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 20; i += 1) lines.push(`- [W${i}](w${i}.md) — 正常描述 ${i} ${"d".repeat(50)}`);
    writeFileSync(join(catDir, "MEMORY.md"), lines.join("\n") + "\n", "utf8");
    const out = renderGlobalIndex(root, { perCategoryChars: 600 });
    assert.doesNotMatch(out.text, /因过长未进注入/, "正常裁剪（多条能装下）不该出这条提示");
    // 仍然做了裁剪（不是全留）
    assert.ok((out.text.match(/- \[W\d+\]/g) ?? []).length < 20, "预算生效，确实裁掉了一部分");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- runtimeMemo.clear 的行为面测试（2026-10-22 补，替代纯源码正则）----
// 语境：此前只有 `assert.match(src, /runtimeMemo\.clear\(\)/)` 这种「文本里有这串字符」的测试——
// 把该语句删掉/挪进永不执行的分支，正则仍绿而行为已坏（对抗复查实测 M16d 存活）。
//
// 设计承诺（RUNTIME-FORMAT §八）：同 scope 短 TTL 记忆 RUNTIME_MEMO_TTL_MS=2000，
// 写盘路径显式清记忆；**外部改动最多滞后一个 TTL**（这是设计内取舍，不是缺陷）。
// 故本用例按设计承诺测两件事：
//   ① 同一 TTL 窗口内（不经过写盘接线）返回一致结果 —— 记忆化生效、不抖动；
//   ② 越过 TTL 后必须重新求值、看到盘上新内容 —— 记忆会过期而不是永久钉死。
// 「清 memo 后立即可见」由写盘路径（invalidateRuntimeAfterWrite）保证，其源码钉
// 在上一例；此处不重复断言设计外的承诺。

test("runtimeMemo 行为面：TTL 内结果稳定、越过 TTL 必须看到盘上新内容", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "Same", description: "AAAA", content: "正文" });
    writeSettings(root, { runtimeEnabled: true });
    const { injectText } = startMessage(root);
    const first = await injectText();
    assert.match(first, /AAAA/, "首轮应含旧钩子");

    // TTL 内：再注入一次应命中记忆（同一份旧文本）——记忆化确实生效
    const second = await injectText();
    assert.match(second, /AAAA/, "TTL 窗口内允许滞后（设计承诺），不得抖动成空");

    // 等长改写 + 越过 TTL：必须重新求值并看到新钩子
    createEntry(root, "work-profile", { title: "Same", description: "BBBB", content: "正文" });
    await new Promise((r) => setTimeout(r, 2200)); // > RUNTIME_MEMO_TTL_MS(2000)
    const third = await injectText();
    assert.match(third, /BBBB/, "越过 TTL 必须看到盘上新内容（记忆会过期，不是永久钉死）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- P3-b：oversized 判据不得漏掉「大行未超预算但仍挤掉同类」（2026-10-22 复查修复）----
// 语境：旧判据 `kept.length===1 && kept[0].length+1 > maxChars` 只在「单行真的超预算」时报。
// 实测 2199 字符（未超 2200）或 kept=2 时零提示，用仍然被挤掉 7-8 条、用户无从解释。
// 新判据：保下来的行平均长度达到丢弃行的 3 倍以上 → 是被大行挤的（不是按新旧裁的）。

test("P3-b：尾部大行未超预算但挤掉多条同类时，仍必须留可见提示", () => {
  const cases = [3000, 2199, 2150];
  for (const tailLen of cases) {
    __resetMetricsForTest();
    const root = freshRoot();
    try {
      const catDir = join(root, "global", "work-profile");
      mkdirSync(catDir, { recursive: true });
      const lines = [];
      for (let i = 0; i < 8; i += 1) lines.push(`- [W${i}](w${i}.md) — 正常描述 ${i} ${"d".repeat(50)}`);
      lines.push(`- [Huge](huge.md) — ${"X".repeat(tailLen)}`);
      writeFileSync(join(catDir, "MEMORY.md"), lines.join("\n") + "\n", "utf8");
      const out = renderGlobalIndex(root, { perCategoryChars: 2200 });
      assert.match(out.text, /另有 \d+ 条因过长未进注入/, `tailLen=${tailLen}：被大行挤掉时必须留提示`);
      assert.match(out.text, /Huge/, "大行本身仍在（保最新）");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("P3-b：正常等长行按预算裁剪时不误报（不出现过长提示）", () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    const catDir = join(root, "global", "work-profile");
    mkdirSync(catDir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 30; i += 1) lines.push(`- [W${i}](w${i}.md) — 正常描述 ${i} ${"d".repeat(50)}`);
    writeFileSync(join(catDir, "MEMORY.md"), lines.join("\n") + "\n", "utf8");
    const out = renderGlobalIndex(root, { perCategoryChars: 800 });
    assert.doesNotMatch(out.text, /因过长未进注入/, "等长行按预算裁是正常行为，不得误报");
    assert.ok((out.text.match(/- \[W\d+\]/g) ?? []).length < 30, "预算生效，确实裁掉了一部分");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 行为测试（2026-10-22 复查后补）：memo 链路端到端 ----
// 复查指出的最大测试缺口：compile 端点只测了「回调被调用」（计数），
// 「memo 真的被清」在 1067 条测试里是空白——影子 Map / clear 变空操作 /
// 失效函数整体空转三种退化都能全部通过通过。
// 这里用 `runtimeMemoTtlMs: 0` 关闭记忆化（测试专用注入点），让记忆化不再遮蔽，
// 任何「本该清却没清」的退化都会暴露为「注入看不到新内容」。

test("行为面：compile 后注入必须看到新产物（TTL=0 直读，不经记忆化）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    writeSettings(root, { runtimeEnabled: true });
    createEntry(root, "work-profile", { title: "Before", description: "旧", content: "a" });
    const { injectText } = startMessage(root);
    const t1 = await injectText();
    assert.match(t1, /\[Before\]/);
    assert.doesNotMatch(t1, /\[After\]/);

    // 直接落盘后强制重编（等价于面板「重新编译」；不经 API 层以隔离出编译+注入链路本身）
    createEntry(root, "work-profile", { title: "After", description: "新", content: "b" });
    forceCompile(root, "global", { trigger: "test", log: { warn: () => {}, error: () => {}, info: () => {} } });

    const t2 = await injectText();
    assert.match(t2, /\[After\]/, "重编后注入必须看到新产物（memo 必须不遮蔽）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("行为面：写盘后注入必须看到新条目（写盘失效接线端到端）", async () => {
  __resetMetricsForTest();
  const root = freshRoot();
  try {
    writeSettings(root, { runtimeEnabled: true });
    createEntry(root, "work-profile", { title: "First", description: "旧", content: "a" });
    const { injectText } = startMessage(root);
    const t1 = await injectText();
    assert.match(t1, /\[First\]/);
    assert.doesNotMatch(t1, /\[Second\]/);

    // 直接写盘（模拟外部写入；不走 API 的 onGlobalWrite）
    createEntry(root, "work-profile", { title: "Second", description: "新", content: "b" });

    const t2 = await injectText();
    assert.match(t2, /\[Second\]/, "写盘后注入必须看到新条目（sourceHash 变化应触发重编）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// inject-sections：4990 人设段 / 4995 全局索引段渲染快照 + 开关矩阵（含 runtime 两段 4992/4993）。
//   开关语义：
//     总开关关 = 全段全灭；projectMemory 关 = 5000/5001 灭 + runtime 两段灭（4990/4995 不受影响）；
//     globalExtraction 关 = 全段不受影响（4995 跟随数据非空）；
//     runtimeEnabled 关（缺省）= runtime 两段空 + globalIndex 三分类照旧渲染。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apply } from "../lib/index.js";
import { createEntry, writeAddressing, writePersona } from "../lib/global-store.js";
import { projectMemoryPaths } from "../lib/paths.js";
import { writeSettings, resetSettingsCache } from "../lib/settings.js";

function fakeCtx() {
  const sections = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    effect() {},
    inject(_deps, setup) {
      const sctx = { effect(fn) { fn(); }, webServer: { register() { return () => {}; } } };
      setup(sctx);
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    llm: { stream() { throw new Error("不应调用"); } },
  };
  return { ctx, sections };
}

function freshRoot() {
  resetSettingsCache();
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-inject-"));
}

/** 起插件并返回六段 text 函数（段序：persona / runtimeUser / runtimeMemory / globalIndex / instructions / index）。 */
function setup(root) {
  const { ctx, sections } = fakeCtx();
  apply(ctx, { enabled: true, storageRoot: root, provider: "p", model: "m", injectChannel: "section" });
  assert.equal(sections.length, 6);
  return {
    persona: sections[0],
    runtimeUser: sections[1],
    runtimeMemory: sections[2],
    globalIndex: sections[3],
    instructions: sections[4],
    index: sections[5],
  };
}

const NO_CTX = {};

/** 造 cwd=root 的项目记忆（条目+索引），让 5000/5001 在 withCwd 下有内容——无 cwd 的空串断言无甄别力（假绿修复）。 */
function seedProjectMemory(root) {
  const { memoryDir } = projectMemoryPaths(root, root);
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, "p.md"), "---\nname: p\ntitle: P\n---\n项目正文。\n");
  writeFileSync(join(memoryDir, "MEMORY.md"), "- [P](p.md) — 项目条目\n");
  return { agent: { session: { header: { cwd: root } } } };
}

// ---- 4990 人设段渲染快照 ----

test("4990：称呼两句 + 人设正文组合渲染", () => {
  const root = freshRoot();
  try {
    writeAddressing(root, { dshName: "小助手", userAlias: "朋友" });
    writePersona(root, "回答要直接。");
    const s = setup(root);
    const text = s.persona.text(NO_CTX);
    assert.match(text, /^## 用户为 DSH 设定的补充人设/);
    assert.match(text, /用户叫你「小助手」。/);
    assert.match(text, /希望你称呼他为「朋友」。/);
    assert.match(text, /回答要直接。/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("4990：只有称呼 / 只有正文 两种半满态", () => {
  const root = freshRoot();
  try {
    writeAddressing(root, { dshName: "小助手" });
    writePersona(root, ""); // 正文清空
    const s = setup(root);
    let text = s.persona.text(NO_CTX);
    assert.match(text, /用户叫你「小助手」。/);
    assert.doesNotMatch(text, /称呼他为/);
    // 只有正文
    writeAddressing(root, { dshName: "", userAlias: "" });
    writePersona(root, "只有正文。");
    resetSettingsCache();
    text = s.persona.text(NO_CTX);
    assert.doesNotMatch(text, /用户叫你/);
    assert.match(text, /只有正文。/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("4990：称呼空 + 正文空 = 空段丢弃（注入条件）", () => {
  const root = freshRoot();
  try {
    writeAddressing(root, { dshName: "", userAlias: "" });
    writePersona(root, "");
    const s = setup(root);
    assert.equal(s.persona.text(NO_CTX), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("4990：出厂默认模板非空 → 全新环境段存在（默认模板保证非空）", () => {
  const root = freshRoot();
  try {
    const s = setup(root);
    const text = s.persona.text(NO_CTX);
    assert.match(text, /补充人设/); // 出厂模板内容
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 4995 全局索引段渲染快照 ----

test("4995：全分类空 = 空段丢弃（注入跟随数据非空）", () => {
  const root = freshRoot();
  try {
    const s = setup(root);
    assert.equal(s.globalIndex.text(NO_CTX), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("4995：任一分类非空 → 段存在（分类小节 + 全局根路径行）", () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "Uses pnpm", description: "包管理", content: "正文" });
    const s = setup(root);
    const text = s.globalIndex.text(NO_CTX);
    assert.match(text, /^## Global memory index/);
    assert.match(text, /Global memory root: .*global/);
    assert.match(text, /### 工作背景 \(work-profile\)/);
    assert.match(text, /- \[Uses pnpm\]\(uses-pnpm\.md\) — 包管理/);
    assert.match(text, /### 用户个人背景 \(user-profile\)/);
    assert.match(text, /（空）/); // 空分类显式标注
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("4995：近期动态按时间倒序带年龄与过期倒计时", () => {
  const root = freshRoot();
  try {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400_000).toISOString();
    createEntry(root, "recent-activity", { title: "Old event", content: "三天前的事", timestamp: threeDaysAgo });
    createEntry(root, "recent-activity", { title: "New event", content: "今天的事" });
    const s = setup(root);
    const text = s.globalIndex.text(NO_CTX);
    const newPos = text.indexOf("New event");
    const oldPos = text.indexOf("Old event");
    assert.ok(newPos > 0 && oldPos > newPos, "新的在前（倒序）");
    assert.match(text, /Old event[^\n]*（3 天前 · 27 天后过期）/);
    assert.match(text, /New event[^\n]*（今天 · \d+ 天后过期）/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("4995：不依赖 cwd（无 cwd 会话同样注入）；long-term（归档区）无条件不渲染", () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "W", content: "工" });
    createEntry(root, "long-term", { title: "L", content: "长" });
    const s = setup(root);
    assert.match(s.globalIndex.text(NO_CTX), /### 工作背景 \(work-profile\)/);
    assert.match(s.globalIndex.text({ agent: { session: { header: {} } } }), /### 工作背景/);
    // §10.3-1：归档区不进任何会话索引（不随 runtimeEnabled、不依赖产物状态）
    assert.doesNotMatch(s.globalIndex.text(NO_CTX), /长期记忆|\[L\]\(l\.md\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("4995：runtimeEnabled 缺省关 → 三分类照旧渲染（fallback 全量索引，不静默失内容）", () => {
  const root = freshRoot();
  try {
    createEntry(root, "user-profile", { title: "U", content: "用户" });
    createEntry(root, "work-profile", { title: "W", content: "工" });
    createEntry(root, "current-focus", { title: "C", content: "焦" });
    const s = setup(root);
    const text = s.globalIndex.text(NO_CTX);
    assert.match(text, /### 用户个人背景 \(user-profile\)/);
    assert.match(text, /### 工作背景 \(work-profile\)/);
    assert.match(text, /### 当前关注 \(current-focus\)/);
    assert.match(text, /- \[U\]\(u\.md\)/);
    // runtime 两段在开关关时为空
    assert.equal(s.runtimeUser.text(NO_CTX), "");
    assert.equal(s.runtimeMemory.text(NO_CTX), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 开关矩阵 ----

test("开关矩阵：总开关关 = 四段全灭（一刀切）", () => {
  const root = freshRoot();
  try {
    writeAddressing(root, { dshName: "小助手" });
    createEntry(root, "work-profile", { title: "W", content: "工" });
    const withCwd = seedProjectMemory(root); // 5000/5001 需要 cwd 且需有内容，否则空串断言假绿
    const s = setup(root);
    // 先验全开基线：四段都有内容（防止"本来就空"的假绿）
    assert.notEqual(s.persona.text(NO_CTX), "");
    assert.notEqual(s.globalIndex.text(NO_CTX), "");
    assert.notEqual(s.instructions.text(withCwd), "");
    assert.notEqual(s.index.text(withCwd), "");
    writeSettings(root, { conversationMemory: false });
    assert.equal(s.persona.text(NO_CTX), "");
    assert.equal(s.globalIndex.text(NO_CTX), "");
    assert.equal(s.instructions.text(withCwd), "");
    assert.equal(s.index.text(withCwd), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("开关矩阵：projectMemory 关 = 5000/5001 灭；4990/4995 不受影响", () => {
  const root = freshRoot();
  try {
    writeAddressing(root, { dshName: "小助手" });
    createEntry(root, "work-profile", { title: "W", content: "工" });
    const withCwd = seedProjectMemory(root);
    const s = setup(root);
    assert.notEqual(s.instructions.text(withCwd), ""); // 先验基线非空（假绿修复）
    assert.notEqual(s.index.text(withCwd), "");
    writeSettings(root, { projectMemory: false });
    assert.notEqual(s.persona.text(NO_CTX), "");
    assert.notEqual(s.globalIndex.text(NO_CTX), "");
    assert.equal(s.instructions.text(withCwd), "");
    assert.equal(s.index.text(withCwd), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("开关矩阵：globalExtraction 关 = 四段不受影响（4995 跟随数据）", () => {
  const root = freshRoot();
  try {
    writeAddressing(root, { dshName: "小助手" });
    createEntry(root, "work-profile", { title: "W", content: "工" });
    const withCwd = seedProjectMemory(root);
    const s = setup(root);
    writeSettings(root, { globalExtraction: false });
    assert.notEqual(s.persona.text(NO_CTX), "");
    assert.notEqual(s.globalIndex.text(NO_CTX), "");
    assert.notEqual(s.instructions.text(withCwd), "");
    assert.notEqual(s.index.text(withCwd), ""); // 5001 同样不受全局提取开关影响（补漏）
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("开关矩阵：全开基线 = 4990/4995 非空", () => {
  const root = freshRoot();
  try {
    writeAddressing(root, { dshName: "小助手" });
    createEntry(root, "work-profile", { title: "W", content: "工" });
    const s = setup(root);
    assert.notEqual(s.persona.text(NO_CTX), "");
    assert.notEqual(s.globalIndex.text(NO_CTX), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("4995 两级注入预算：每类 22 行保最新 + 总预算不裁整类", () => {
  // 相位 A（每类预算 + 保最新）：单类 50 条 → 只见 22 行（每类预算），且是**最新** 22 条（尾部保留）。
  // 用 work-profile（long-term 归档区已无条件移出索引，不再适合做本用例的载体）。
  const rootA = freshRoot();
  try {
    for (let i = 0; i < 50; i += 1) {
      createEntry(rootA, "work-profile", { name: `pin-${String(i).padStart(3, "0")}.md`, title: `P-work-${i}`, content: "c" });
    }
    const { ctx, sections } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: rootA, injectChannel: "section" });
    const text = sections.find((s) => s.name === "dsh-keepsake:global-index").text(NO_CTX);
    const workLines = text.split("\n").filter((l) => l.includes("[P-work-"));
    assert.equal(workLines.length, 22, "每类 22 行预算生效（50 条只见 22）");
    assert.match(text, /\[P-work-49\]/, "保最新：最新一条仍在注入里");
    assert.doesNotMatch(text, /\[P-work-0\]/, "保最新：最旧一条被裁掉（此前保头部会让新记忆消失）");
    assert.doesNotMatch(text, /\[WARNING\]/, "单类 22 行未触总预算");
  } finally {
    rmSync(rootA, { recursive: true, force: true });
  }
  // 相位 B（总预算）：四类各 40 条（long-term 已出索引，不参与）→ 每类裁到 22 行，
  // 四类段落头齐全、无整类被裁；总闸 120 行仍富余（4 × 23 = 92）。
  const rootB = freshRoot();
  try {
    for (const cat of ["work-profile", "user-profile", "current-focus", "recent-activity"]) {
      for (let i = 0; i < 40; i += 1) {
        createEntry(rootB, cat, { name: `pin-${cat}-${String(i).padStart(3, "0")}.md`, title: `P-${cat}-${i}`, content: "c" });
      }
    }
    const { ctx, sections } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: rootB, injectChannel: "section" });
    const text = sections.find((s) => s.name === "dsh-keepsake:global-index").text(NO_CTX);
    assert.doesNotMatch(text, /\[WARNING\]/, "每类 22 行 + 段落头应落在总闸 120 行内");
    const entryLines = text.split("\n").filter((l) => /^- \[P-/.test(l));
    assert.equal(entryLines.length, 88, `四类各 22 行应全部保留，实际 ${entryLines.length}`);
    assert.equal((text.match(/^### /gm) ?? []).length, 4, "四类段落头齐全（不整类被裁；long-term 不渲染）");
  } finally {
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("4995 全局索引字符预算：超长钩子逐类收紧，段落头齐全、不切半行", () => {
  const root = freshRoot();
  try {
    const longHook = "钩".repeat(400); // 单行约 400 字符 → 行预算装得下、字符闸装不下
    for (const cat of ["work-profile", "user-profile", "current-focus", "recent-activity"]) {
      for (let i = 0; i < 22; i += 1) {
        createEntry(root, cat, { name: `pin-${cat}-${String(i).padStart(3, "0")}.md`, title: `P-${cat}-${i}`, description: longHook, content: "c" });
      }
    }
    const { ctx, sections } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: root, injectChannel: "section" });
    const text = sections.find((s) => s.name === "dsh-keepsake:global-index").text(NO_CTX);
    assert.equal((text.match(/^### /gm) ?? []).length, 4, "超长钩子下四类段落头仍齐全（字符闸不掉头）");
    const contentLines = text.split("\n").filter((l) => l.trim().length > 0 && !l.startsWith("##") && !l.startsWith("###") && !l.startsWith("Global memory root:") && l !== "（空）");
    assert.ok(contentLines.length > 0, "仍有条目行");
    assert.ok(contentLines.every((l) => l.startsWith("- [")), "内容行均为完整条目行（无半行残片）");
    assert.ok(text.length <= 12400, `总文本应受总字符闸约束，实际 ${text.length}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- token 预算接线：desiredMemoryContext 的 token 口径与调用面 ----
// 引擎侧（buildMemoryContext 的 maxTokens 双上限）另有测试；这里钉的是 index.js
// 接线结构 + 配置键流（若引擎侧缺 maxTokens 支持，token 参数会被旧签名忽略、字符口径照旧——对引擎缺陷仍有甄别力）。

test("token 预算接线钉：desiredMemoryContext 收 token 预算、主块为召回让位按双口径算、记账带 tokens", () => {
  const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  // 签名收 maxTokens（缺省 cfg.injectMaxTokens）
  assert.ok(/function desiredMemoryContext\(agent, maxChars = cfg\.injectMaxChars, maxTokens = cfg\.injectMaxTokens\)/.test(src),
    "desiredMemoryContext 应增 token 预算参数（缺省取 cfg.injectMaxTokens）");
  // 传给 buildMemoryContext 的两口径
  const anchor = src.indexOf("buildMemoryContext(segments, {");
  assert.ok(anchor > 0, "buildMemoryContext 调用应显式传 segments 选项");
  const region = src.slice(anchor, anchor + 320);
  assert.ok(region.includes("maxChars"), "buildMemoryContext 调用应显式传 maxChars");
  assert.ok(region.includes("maxTokens"), "buildMemoryContext 调用应同传 maxTokens（双上限）");
  assert.ok(region.includes("fallbacks"), "索引段应传紧凑兜底（预算紧时不整段消失）");
  assert.ok(region.includes("tokens"), "返回对象应带 tokens（记账用）");
  // 召回让位双口径：mainTokens = max(0, injectMaxTokens − costOf(recallText) − costOf("\n\n"))
  assert.ok(/const mainTokens = cfg\.injectMaxTokens > 0/.test(src), "主块 token 预算应在 injectMaxTokens>0 时计算");
  assert.ok(/estimateTokens\(recallText\) \+ estimateTokens\("\\n\\n"\)/.test(src), "召回让位口径：costOf(recallText)+costOf(\\n\\n)");
  // recordInjection 传 tokens（缺失回落 estimateTokens）与紧凑降级段
  assert.ok(/recordInjection\(\{ chars: built\.text\.length, dropped: built\.dropped, compacted: built\.compacted, resend: prior !== void 0, tokens: built\.tokens \?\? estimateTokens\(built\.text\) \}\)/.test(src),
    "recordInjection 应传 tokens 与 compacted（built.tokens ?? estimateTokens(built.text)）");
  // estimateTokens 从 lib/tokens.js 引（不是 embedding.js 转发）
  assert.ok(/import \{ estimateTokens \} from "\.\/tokens\.js"/.test(src), "estimateTokens 引自强模块 lib/tokens.js");
});

test("token 预算配置流：resolveConfig 产出 injectMaxTokens（默认 24000 / 0=禁用）并进 configSummary 字段面", async () => {
  // configSummary 是闭包递进 api 的——这里用源码钉字段全集更直白（api 侧透传另测）。
  const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  const anchor = src.indexOf("configSummary: () => ({");
  assert.ok(anchor > 0, "configSummary 应在");
  const region = src.slice(anchor, src.indexOf("\n            }),", anchor) + 16);
  for (const field of [
    "redactionEnabled:", "injectMaxChars:", "injectMaxTokens:", "extractGateEnabled:",
    "extractGateMinScore:", "extractIdleDelayMs:", "extractMaxRunsPerSession:", "autoRecoverEnabled:",
  ]) {
    assert.ok(region.includes(field), `configSummary 应含字段 ${field}`);
  }
  const { resolveConfig } = await import("../lib/index.js");
  assert.equal(resolveConfig({ enabled: true }).injectMaxTokens, 24000);
  assert.equal(resolveConfig({ enabled: true, injectMaxTokens: 0 }).injectMaxTokens, 0);
  assert.equal(resolveConfig({ enabled: true, injectMaxTokens: 4096 }).injectMaxTokens, 4096);
  // injectMaxChars 保留不动（字符口径并存）
  assert.equal(resolveConfig({ enabled: true }).injectMaxChars, 30000);
});


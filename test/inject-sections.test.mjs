// inject-sections：4990 人设段 / 4995 全局索引段渲染快照 + 四段开关矩阵（方案C §4 验收）。
//   开关语义（§4+R2/R3/R10 组合推定）：
//     总开关关 = 四段全灭；projectMemory 关 = 5000/5001 灭（4990/4995 不受影响）；
//     globalExtraction 关 = 四段不受影响（4995 跟随数据非空，R2）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  return mkdtempSync(join(tmpdir(), "dsh-memory-inject-"));
}

/** 起插件并返回四段 text 函数。 */
function setup(root) {
  const { ctx, sections } = fakeCtx();
  apply(ctx, { enabled: true, storageRoot: root, provider: "p", model: "m" });
  assert.equal(sections.length, 4);
  return {
    persona: sections[0],
    globalIndex: sections[1],
    instructions: sections[2],
    index: sections[3],
  };
}

const NO_CTX = {};

/** 造 cwd=root 的项目记忆（条目+索引），让 5000/5001 在 withCwd 下有内容——无 cwd 的空串断言无甄别力（审查 P1 假绿修复）。 */
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
    writeAddressing(root, { dshName: "小舟", userAlias: "老板" });
    writePersona(root, "回答要直接。");
    const s = setup(root);
    const text = s.persona.text(NO_CTX);
    assert.match(text, /^## 用户为 DSH 设定的补充人设/);
    assert.match(text, /用户叫你「小舟」。/);
    assert.match(text, /希望你称呼他为「老板」。/);
    assert.match(text, /回答要直接。/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("4990：只有称呼 / 只有正文 两种半满态", () => {
  const root = freshRoot();
  try {
    writeAddressing(root, { dshName: "小舟" });
    writePersona(root, ""); // 正文清空
    const s = setup(root);
    let text = s.persona.text(NO_CTX);
    assert.match(text, /用户叫你「小舟」。/);
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

test("4990：称呼空 + 正文空 = 空段丢弃（§4 注入条件）", () => {
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

test("4990：出厂默认模板非空 → 全新环境段存在（R5 默认模板保证非空）", () => {
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

test("4995：全分类空 = 空段丢弃（R2 注入跟随数据非空）", () => {
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

test("4995：不依赖 cwd（无 cwd 会话同样注入，功能4 落点）", () => {
  const root = freshRoot();
  try {
    createEntry(root, "long-term", { title: "L", content: "长" });
    const s = setup(root);
    assert.match(s.globalIndex.text(NO_CTX), /### 长期记忆 \(long-term\)/);
    assert.match(s.globalIndex.text({ agent: { session: { header: {} } } }), /### 长期记忆/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 开关矩阵 ----

test("开关矩阵：总开关关 = 四段全灭（R3 一刀切）", () => {
  const root = freshRoot();
  try {
    writeAddressing(root, { dshName: "小舟" });
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
    writeAddressing(root, { dshName: "小舟" });
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

test("开关矩阵：globalExtraction 关 = 四段不受影响（4995 跟随数据，R2）", () => {
  const root = freshRoot();
  try {
    writeAddressing(root, { dshName: "小舟" });
    createEntry(root, "work-profile", { title: "W", content: "工" });
    const withCwd = seedProjectMemory(root);
    const s = setup(root);
    writeSettings(root, { globalExtraction: false });
    assert.notEqual(s.persona.text(NO_CTX), "");
    assert.notEqual(s.globalIndex.text(NO_CTX), "");
    assert.notEqual(s.instructions.text(withCwd), "");
    assert.notEqual(s.index.text(withCwd), ""); // 5001 同样不受全局提取开关影响（审查补漏）
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("开关矩阵：全开基线 = 4990/4995 非空", () => {
  const root = freshRoot();
  try {
    writeAddressing(root, { dshName: "小舟" });
    createEntry(root, "work-profile", { title: "W", content: "工" });
    const s = setup(root);
    assert.notEqual(s.persona.text(NO_CTX), "");
    assert.notEqual(s.globalIndex.text(NO_CTX), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T-GRA1③ 4995 两级注入预算：每类 40 行 + 总 120 行截断（F2/F3 变异坐实的假绿补钉）", () => {
  // 相位 A（F2 每类预算）：单类 50 条 → 只见 40 行，且未触总预算无 WARNING
  const rootA = freshRoot();
  try {
    for (let i = 0; i < 50; i += 1) {
      createEntry(rootA, "long-term", { name: `pin-${String(i).padStart(3, "0")}.md`, title: `P-long-term-${i}`, content: "c" });
    }
    const { ctx, sections } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: rootA });
    const text = sections.find((s) => s.name === "dsh-memory:global-index").text(NO_CTX);
    const longTermLines = text.split("\n").filter((l) => l.includes("[P-long-term-"));
    assert.equal(longTermLines.length, 40, "每类 40 行预算生效（50 条只见 40）");
    assert.doesNotMatch(text, /\[WARNING\]/, "单类 40 行未触总预算");
  } finally {
    rmSync(rootA, { recursive: true, force: true });
  }
  // 相位 B（F3 总预算）：五类各 40 条共 200 行 > 120 → 截断 + WARNING
  const rootB = freshRoot();
  try {
    for (const cat of ["work-profile", "user-profile", "current-focus", "recent-activity", "long-term"]) {
      for (let i = 0; i < 40; i += 1) {
        createEntry(rootB, cat, { name: `pin-${cat}-${String(i).padStart(3, "0")}.md`, title: `P-${cat}-${i}`, content: "c" });
      }
    }
    const { ctx, sections } = fakeCtx();
    apply(ctx, { enabled: true, storageRoot: rootB });
    const text = sections.find((s) => s.name === "dsh-memory:global-index").text(NO_CTX);
    assert.match(text, /\[WARNING\]/, "总预算截断应带可见 WARNING");
    const entryLines = text.split("\n").filter((l) => /^- \[P-/.test(l));
    assert.ok(entryLines.length <= 120, `注入条目行应 ≤120，实际 ${entryLines.length}`);
    assert.ok(entryLines.length >= 40, "截断后仍保留内容（非全灭）");
  } finally {
    rmSync(rootB, { recursive: true, force: true });
  }
});

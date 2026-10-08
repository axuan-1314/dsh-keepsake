// panel-logic 检查：导入解析/预览行模型/主题映射/档位决策/近期动态/检索。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PERSONA_PRESETS,
  applyThemeVars,
  buildImportRequest,
  collectThemeVarsFromDoc,
  decideLadderTier,
  detectImportFormat,
  filterEntries,
  ladderFallbackOf,
  ladderNoteOf,
  parseSourceText,
  previewRowsOf,
  recentAgeOf,
  recentExpireDays,
  serializeEntries,
} from "../lib/panel-logic.js";

// ---- 人设模板 ----

test("PERSONA_PRESETS：五档（简洁/专业/幽默/伙伴/自定义），自定义不覆盖内容", () => {
  assert.equal(PERSONA_PRESETS.length, 5);
  assert.deepEqual(PERSONA_PRESETS.map((p) => p.id), ["concise", "professional", "humorous", "companion", "custom"]);
  assert.equal(PERSONA_PRESETS.find((p) => p.id === "custom").content, "");
  assert.ok(PERSONA_PRESETS.filter((p) => p.id !== "custom").every((p) => p.content.includes("补充人设")));
});

// ---- 导入解析 ----

test("detectImportFormat：文件名 .json 优先；内容 {/[ 判 json；## 判拆条；否则整段", () => {
  assert.equal(detectImportFormat("a.json", "anything"), "json");
  assert.equal(detectImportFormat("a.md", '{"entries":[]}'), "json");
  assert.equal(detectImportFormat("a.md", "[1,2]"), "json");
  assert.equal(detectImportFormat("a.md", "# 标题\n## 条目一\n内容"), "markdown-split");
  assert.equal(detectImportFormat("a.md", "普通文本"), "markdown-whole");
});

test("buildImportRequest：json 合法解析为 payload；非法返回 ok:false", () => {
  const good = buildImportRequest("work-profile", "json", '{"entries":[{"title":"A","content":"一"}]}');
  assert.equal(good.ok, true);
  assert.equal(good.body.category, "work-profile");
  assert.equal(good.body.payload.entries.length, 1);
  const bad = buildImportRequest("work-profile", "json", "{bad json");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /JSON 解析失败/);
});

test("buildImportRequest：markdown 形态带 title 透传", () => {
  const r = buildImportRequest("long-term", "markdown-whole", "# 全部", "总汇");
  assert.equal(r.ok, true);
  assert.deepEqual(r.body.payload, { markdown: "# 全部", title: "总汇" });
});

test("previewRowsOf：overwrite 标红（danger），add 不标；preview 截 80 字符", () => {
  const rows = previewRowsOf([
    { category: "work-profile", name: "a.md", title: "A", action: "overwrite", content: "x".repeat(100) },
    { category: "work-profile", name: "b.md", title: "B", action: "add", content: "短" },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].danger, true);
  assert.equal(rows[0].preview.length, 80);
  assert.equal(rows[1].danger, false);
  assert.equal(previewRowsOf(void 0).length, 0); // 空防御
});

// ---- 主题映射 ----

test("collectThemeVarsFromDoc：样式表枚举 + computed 取值（模拟 document）", () => {
  const fakeDoc = {
    body: {},
    defaultView: {
      getComputedStyle: () => ({
        getPropertyValue: (n) => (n === "--dsw-alias-label-primary" ? " #111 " : ""),
      }),
    },
    styleSheets: [
      { cssRules: [{ style: { 0: "--dsw-alias-label-primary", length: 1 } }] },
      { get cssRules() { throw new Error("跨源"); } }, // 跨源样式表跳过
    ],
  };
  const vars = collectThemeVarsFromDoc(fakeDoc);
  assert.equal(vars["--dsw-alias-label-primary"], "#111");
});

test("collectThemeVarsFromDoc：异常返回空对象（桥失败降级）", () => {
  assert.deepEqual(collectThemeVarsFromDoc(null), {});
  assert.deepEqual(collectThemeVarsFromDoc({}), {});
});

test("applyThemeVars：只写 --dsw-alias- 前缀，返回应用条数", () => {
  const written = {};
  const target = { setProperty: (k, v) => { written[k] = v; } };
  const n = applyThemeVars(target, { "--dsw-alias-a": "1", "--other": "x", "color": "red" });
  assert.equal(n, 1);
  assert.deepEqual(written, { "--dsw-alias-a": "1" });
});

// ---- 档位决策 ----

test("decideLadderTier：open null→iframe；握手成功→window；超时→iframe", () => {
  assert.equal(decideLadderTier(null, false), "iframe");
  assert.equal(decideLadderTier(void 0, false), "iframe");
  assert.equal(decideLadderTier({}, true), "window");
  assert.equal(decideLadderTier({}, false), "iframe");
});

test("ladderFallbackOf：window→iframe→location 逐级", () => {
  assert.equal(ladderFallbackOf("window"), "iframe");
  assert.equal(ladderFallbackOf("iframe"), "location");
  assert.equal(ladderFallbackOf("location"), "location");
});

test("ladderNoteOf：降级可见提示文案（window 档无提示）", () => {
  assert.match(ladderNoteOf("iframe"), /已改为内嵌模式/);
  assert.match(ladderNoteOf("iframe", "window.open 返回空"), /window\.open 返回空/);
  assert.match(ladderNoteOf("location"), /已改为跳转模式/);
  assert.equal(ladderNoteOf("window"), "");
});

// ---- 近期动态 ----

test("recentAgeOf：今天/1 天前/N 天前；非法时间戳按今天", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  assert.deepEqual(recentAgeOf("2026-10-08T01:00:00Z", now), { days: 0, text: "今天" });
  assert.deepEqual(recentAgeOf("2026-10-07T13:00:00Z", now), { days: 0, text: "今天" }); // 22h
  assert.deepEqual(recentAgeOf("2026-10-06T13:00:00Z", now), { days: 1, text: "1 天前" });
  assert.deepEqual(recentAgeOf("2026-10-01T00:00:00Z", now), { days: 7, text: "7 天前" });
  assert.deepEqual(recentAgeOf("bad", now), { days: 0, text: "今天" });
});

test("recentExpireDays：keepDays - age，下限 0", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  assert.equal(recentExpireDays("2026-10-05T12:00:00Z", 30, now), 27);
  assert.equal(recentExpireDays("2026-09-01T00:00:00Z", 30, now), 0);
});

// ---- 检索 ----

test("filterEntries：三字段小写包含；空 query 全量；null 防御", () => {
  const entries = [
    { title: "Uses pnpm", description: "包管理", content: "团队统一" },
    { title: "Note", description: "便签", content: "随便记的 PNPM 事" },
    { title: "Other", description: "", content: "无关" },
  ];
  assert.equal(filterEntries(entries, "pnpm").length, 2); // title + content 命中
  assert.equal(filterEntries(entries, "团队").length, 1);
  assert.equal(filterEntries(entries, "").length, 3);
  assert.equal(filterEntries(entries, "  ").length, 3);
  assert.equal(filterEntries(null, "x").length, 0);
});

// ---- 源码模式序列化/解析（审查 P2 修复：description 往返不丢） ----

test("serializeEntries ↔ parseSourceText：含 description 的整类往返无损", () => {
  const entries = [
    { title: "团队技术栈", name: "team-stack.md", description: "包管理与运行时", content: "统一 pnpm + Node 24。" },
    { title: "无描述条目", name: "plain.md", description: "", content: "只有正文。" },
  ];
  const text = serializeEntries(entries);
  const back = parseSourceText(text);
  assert.equal(back.length, 2);
  assert.equal(back[0].title, "团队技术栈");
  assert.equal(back[0].name, "team-stack.md");
  assert.equal(back[0].description, "包管理与运行时", "description 必须随注释往返（审查 P2 回归钉）");
  assert.equal(back[0].content, "统一 pnpm + Node 24。");
  assert.equal(back[1].description, "");
});

test("parseSourceText：desc 含 --> 时转义往返；头部不合规块跳过；空正文跳过", () => {
  const text = [
    "## A", "<!-- name: a.md desc: 箭头--＞转义前是 -->", "正文 A", "",
    "---", "",
    "## B", "<!-- name: b.md -->", "正文 B", "",
    "---", "",
    "不是标题开头", "",
    "---", "",
    "## C", "<!-- name: c.md -->", "   ",
  ].join("\n");
  const parsed = parseSourceText(text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].description, "箭头-->转义前是", "转义符 --＞ 读回还原为 -->");
  assert.equal(parsed[1].name, "b.md");
});

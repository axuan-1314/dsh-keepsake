// panel-logic 检查：导入解析/预览行模型/主题映射/档位决策/近期动态/检索
//   + 提取管道可观测纯函数（三态判定/红条文案/模型短名/相对时间/诊断文本）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXTRACTION_BUCKET_KEYS,
  PERSONA_PRESETS,
  applyThemeVars,
  buildImportRequest,
  collectThemeVarsFromDoc,
  decideLadderTier,
  detectImportFormat,
  diagnosticTextOf,
  embeddingClearActionVisible,
  extractionNoticeText,
  extractionRangeText,
  extractionRunLabel,
  extractionRunLines,
  extractionStreakOf,
  filterEntries,
  injectionSummary,
  importTitleOf,
  ladderFallbackOf,
  ladderNoteOf,
  modelShortName,
  panelBackAction,
  parseSourceText,
  pipeHealthLevel,
  previewRowsOf,
  recentAgeOf,
  recentExpireDays,
  relativeTimeOf,
  safetyLocationText,
  safetySummaryText,
  serializeEntries,
  utf8Length,
  unrecoveredTextFromLog,
  validateEmbeddingDraft,
  validateEntryDraft,
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

test("importTitleOf：markdown 标题推断（面板侧）；json 恒空", () => {
  assert.equal(importTitleOf("markdown-split", "## 条目一\n内容\n\n## 条目二\n内容"), "条目一");
  assert.equal(importTitleOf("markdown-whole", "# 总标题\n\n正文"), "总标题");
  assert.equal(importTitleOf("markdown-whole", "没有标题的普通首行\n正文"), "没有标题的普通首行");
  assert.equal(importTitleOf("markdown-whole", "\n\n  \n首行前有空白"), "首行前有空白");
  assert.equal(importTitleOf("markdown-whole", ""), "");
  assert.equal(importTitleOf("markdown-whole", "   \n#\n"), "");
  assert.equal(importTitleOf("json", '{"entries":[]}'), "");
  assert.equal(importTitleOf("markdown-whole", "x".repeat(80)).length <= 60, true); // 60 上限
});

test("previewRowsOf：overwrite/rename 标红（danger），add 不标；preview 截 80 字符", () => {
  const rows = previewRowsOf([
    { category: "work-profile", name: "a.md", title: "A", action: "overwrite", content: "x".repeat(100) },
    { category: "work-profile", name: "b.md", title: "B", action: "add", content: "短" },
    { category: "work-profile", name: "c-2.md", title: "C", action: "rename", content: "改名避让" }, // 批内去重
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].danger, true);
  assert.equal(rows[0].preview.length, 80);
  assert.equal(rows[1].danger, false);
  assert.equal(rows[2].danger, true, "rename（批内撞名改名）同样标红");
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

test("panelBackAction：popup 关窗 / iframe 通知宿主 / 顶层按 hash 步数回退", () => {
  assert.deepEqual(panelBackAction(true, false, 1, 0), { mode: "close" });
  assert.deepEqual(panelBackAction(false, true, 1, 0), { mode: "notify-host" });
  // 顶层：面板内部点过 3 个路由 → 一次跳回 4 步前的设置页
  assert.deepEqual(panelBackAction(false, false, 5, 3), { mode: "back", steps: 4 });
  assert.deepEqual(panelBackAction(false, false, 2, 0), { mode: "back", steps: 1 });
  // 无历史（面板是首个条目）→ 应用根
  assert.deepEqual(panelBackAction(false, false, 1, 0), { mode: "root" });
});

// ---- 条目草稿预检 ----

test("utf8Length：ASCII 1 字节 / CJK 3 字节 / emoji 4 字节；空与 null 防御", () => {
  assert.equal(utf8Length("abc"), 3);
  assert.equal(utf8Length("中文"), 6);
  assert.equal(utf8Length("😀"), 4); // emoji 代理对：2 字符 4 字节——字符数视角看不到的真实占用
  assert.equal(utf8Length(""), 0);
  assert.equal(utf8Length(null), 0);
  assert.equal(utf8Length(void 0), 0);
});

test("validateEntryDraft：必填 / 20000 字符上限 / 字节上限三道门", () => {
  assert.equal(validateEntryDraft("标题", "正文").ok, true);
  assert.equal(validateEntryDraft("", "正文").ok, false); // 空标题（服务端会静默回退旧标题）
  assert.equal(validateEntryDraft("  ", "正文").ok, false);
  assert.equal(validateEntryDraft("标题", "").ok, false); // 空正文（会建出空白条目）
  assert.equal(validateEntryDraft("标题", "   ").ok, false);
  const overChars = validateEntryDraft("标题", "a".repeat(20001));
  assert.equal(overChars.ok, false);
  assert.match(overChars.error, /20000 字符上限/);
  // 默认门槛下字符门先拦（码元≤20000 ⇒ UTF-8≤40000B）；字节门是 maxlength 被绕过
  // （脚本赋值/拖放/存量超长）时的纵深防线——自定义参数钉独立逻辑。
  const emoji = "😀".repeat(5001); // 10002 码元 / 20004 UTF-8 字节
  assert.equal(validateEntryDraft("标题", emoji).ok, true); // 默认门槛放行
  const overBytes = validateEntryDraft("标题", emoji, { maxBytes: 20000 });
  assert.equal(overBytes.ok, false);
  assert.match(overBytes.error, /KB/);
  assert.equal(validateEntryDraft("t", "aaaa", { maxChars: 2 }).ok, false);
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

// ---- 源码模式序列化/解析（description 往返不丢） ----

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
  assert.equal(back[0].description, "包管理与运行时", "description 必须随注释往返（回归钉）");
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

test("serializeEntries：desc 含换行折叠为空格（单行注释协议防失配丢 name）", () => {
  const text = serializeEntries([
    { title: "T", name: "t.md", description: "第一行\n第二行", content: "正文" },
  ]);
  assert.match(text, /desc: 第一行 第二行 -->/);
  assert.doesNotMatch(text, /desc: 第一行\n/);
  const back = parseSourceText(text);
  assert.equal(back.length, 1);
  assert.equal(back[0].name, "t.md", "换行 desc 不得让 name 丢失");
  assert.equal(back[0].description, "第一行 第二行");
});

// ---- 提取管道可观测（/state 新字段 tolerant 消费纯函数） ----

test("EXTRACTION_BUCKET_KEYS：五存量桶 + retried/fallbackUsed，顺序稳定（分桶展示序）", () => {
  assert.deepEqual(EXTRACTION_BUCKET_KEYS, [
    "no-route", "no-cwd", "llm-error", "parse-error", "io-error", "retried", "fallbackUsed",
  ]);
});

test("modelShortName：取路径末段（门牌模型）；无斜杠原样；空/null 防御", () => {
  assert.equal(modelShortName("group/chat-model"), "chat-model");
  assert.equal(modelShortName("a/b/c"), "c");
  assert.equal(modelShortName("auto-glm"), "auto-glm");
  assert.equal(modelShortName("EmbeddingGemma 2"), "EmbeddingGemma 2"); // 无路径的嵌入模型名原样展示
  assert.equal(modelShortName(""), "");
  assert.equal(modelShortName(null), "");
  assert.equal(modelShortName(void 0), "");
  assert.equal(modelShortName("  group/x  "), "x"); // 先 trim 再取末段
});

test("relativeTimeOf：刚刚/秒/分/时/天；超 30 天回落绝对日期；无效 → —", () => {
  const now = 1730000000000;
  assert.equal(relativeTimeOf(null, now), "—");
  assert.equal(relativeTimeOf(void 0, now), "—");
  assert.equal(relativeTimeOf(0, now), "—");
  assert.equal(relativeTimeOf("abc", now), "—");
  assert.equal(relativeTimeOf(now, now), "刚刚");
  assert.equal(relativeTimeOf(now - 5000, now), "刚刚"); // <10s 视为刚刚
  assert.equal(relativeTimeOf(now + 60000, now), "刚刚"); // 时钟偏移在未来：不出现负数
  assert.equal(relativeTimeOf(now - 59000, now), "59 秒前");
  assert.equal(relativeTimeOf(now - 300000, now), "5 分钟前");
  assert.equal(relativeTimeOf(now - 7200000, now), "2 小时前");
  assert.equal(relativeTimeOf(now - 2 * 86400000, now), "2 天前");
  assert.equal(relativeTimeOf(now - 29 * 86400000, now), "29 天前");
  assert.match(relativeTimeOf(now - 40 * 86400000, now), /^\d{4}-\d{2}-\d{2}$/, "超 30 天回落 YYYY-MM-DD");
});

test("relativeTimeOf：ISO 时间串（journal 落盘格式）也出相对时间，整条链时间列不出「—」", () => {
  // journal 的 at 序列化为 ISO（JSONL 要可读可排序）——只认数字的那版会把"最近提取记录"
  // 的整列时间渲染成「—」，核心反馈面打对折。
  const now = 1730000000000;
  assert.equal(relativeTimeOf(new Date(now - 300000).toISOString(), now), "5 分钟前");
  assert.match(relativeTimeOf(new Date(now - 40 * 86400000).toISOString(), now), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(relativeTimeOf("不是时间", now), "—"); // 解析不了仍回 —，不瞎编
  // 整条链：journal 行模型透传的 at 喂进 relativeTimeOf 必须出真时间
  const rows = extractionRunLines({ runs: [{ at: new Date(now - 300000).toISOString(), sessionId: "s", from: 0, to: 3, outcome: "written", writes: 1 }] });
  assert.equal(rows.length, 1);
  assert.equal(relativeTimeOf(rows[0].at, now), "5 分钟前");
});

test("extractionStreakOf：对象取 streak / 缺字段 0 / 旧数字形态原值（混搭矩阵）", () => {
  assert.equal(extractionStreakOf({ streak: 0 }), 0);
  assert.equal(extractionStreakOf({ streak: 1 }), 1);
  assert.equal(extractionStreakOf({ streak: 10 }), 10);
  assert.equal(extractionStreakOf({}), 0);
  assert.equal(extractionStreakOf(5), 5); // 旧数字形态
  assert.equal(extractionStreakOf(null), 0);
  assert.equal(extractionStreakOf(void 0), 0);
});

test("pipeHealthLevel 三态矩阵：红 streak≥1 / 灰 busy / 黄 恢复<24h 或 retried>0 / 绿 其余", () => {
  const now = 1730000000000;
  assert.equal(pipeHealthLevel({ streak: 1 }), "red");
  assert.equal(pipeHealthLevel({ streak: 10 }), "red");
  assert.equal(pipeHealthLevel({ streak: 3 }, { inFlight: true }), "red", "在途但已有连击仍是红（重试中不粉饰）");
  assert.equal(pipeHealthLevel({ streak: 0 }, { inFlight: true }), "busy");
  assert.equal(pipeHealthLevel({ streak: 0, retried: 2 }), "yellow");
  assert.equal(pipeHealthLevel({ streak: 0, lastRecoveredAt: now - 3600_000 }, { now }), "yellow", "24h 内恢复过");
  assert.equal(pipeHealthLevel({ streak: 0, retried: 1, lastRecoveredAt: now - 30 * 3600_000 }, { now }), "yellow", "retried>0 且 streak=0（黄态）");
  assert.equal(pipeHealthLevel({ streak: 0 }, { now }), "green");
  assert.equal(pipeHealthLevel({ streak: 0, retried: 0, lastRecoveredAt: now - 30 * 3600_000 }, { now }), "green", "恢复超 24h 且无重试痕迹回绿");
  assert.equal(pipeHealthLevel(3), "red", "旧数字形态按 streak");
  assert.equal(pipeHealthLevel(null), "green", "旧服务端无失败字段：绿灯");
});

test("extractionNoticeText：新版带病因+模型短名；streak 0 → 空；旧形态沿用旧单行文案（零回归）", () => {
  const OLD = (n) => `记忆自动提取最近连续失败 ${n} 次，期间对话内容可能未被记录——请检查服务端日志。`;
  assert.equal(extractionNoticeText(null), "");
  assert.equal(extractionNoticeText(0), "");
  assert.equal(extractionNoticeText({ streak: 0, recent: [] }), "");
  // 新版主形态（计数 · 病因（模型末段））
  assert.equal(
    extractionNoticeText({ streak: 3, recent: [{ reason: "llm-error", at: 1, provider: "acme", model: "group/chat-model", message: "429 …" }] }),
    "自动提取失败 3 次 · 最近：llm-error（chat-model）",
  );
  assert.equal(extractionNoticeText({ streak: 1, recent: [{ reason: "io-error" }] }), "自动提取失败 1 次 · 最近：io-error");
  assert.equal(extractionNoticeText({ streak: 2, recent: [] }), "自动提取失败 2 次", "有 recent 字段但空（≠旧版文案）");
  assert.equal(
    extractionNoticeText({ streak: 2, recent: [], streakReason: "parse-error" }),
    "自动提取失败 2 次 · 最近：parse-error",
    "recent 空时 streakReason 兜底",
  );
  assert.equal(extractionNoticeText({ streak: 2, recent: [{ model: "group/x" }] }), "自动提取失败 2 次", "无原因时只报计数");
  // 旧版：无 recent 字段（对象）或纯数字 → 沿用旧单行文案
  assert.equal(extractionNoticeText({ streak: 3, streakReason: "llm-error" }), OLD(3));
  assert.equal(extractionNoticeText(3), OLD(3));
});

test("extractionRangeText：seq X 之后的轮次…（收紧措辞）；条件不满足 → 空", () => {
  const TEXT = "seq 473 之后的轮次尚未记录，恢复后自动补提";
  assert.equal(extractionRangeText({ streak: 3 }, { from: 473, to: 478 }), TEXT);
  assert.equal(extractionRangeText({ streak: 1 }, { from: 473 }), TEXT);
  assert.equal(extractionRangeText(2, { from: 10 }), "seq 10 之后的轮次尚未记录，恢复后自动补提", "旧数字形态 streak 也认");
  assert.equal(extractionRangeText({ streak: 0 }, { from: 473 }), "", "已恢复不提示");
  assert.equal(extractionRangeText({ streak: 3 }, null), "");
  assert.equal(extractionRangeText({ streak: 3 }, {}), "");
  assert.equal(extractionRangeText({ streak: 3 }, { from: "x" }), "", "非法 from 不渲染");
  assert.equal(extractionRangeText({ streak: 3 }, "473"), "", "非对象形态不渲染");
});

test("diagnosticTextOf：版本/全量分桶（含零值）/最近失败摘要/用车；旧版缺 recent 有旧版说明行", () => {
  const now = 1730000000000;
  const state = {
    version: 1,
    extractionFailures: {
      "no-route": 0, "no-cwd": 0, "llm-error": 4, "parse-error": 0, "io-error": 1,
      retried: 2, fallbackUsed: 0, streak: 3, streakReason: "llm-error",
      recent: [
        { reason: "llm-error", at: now - 60000, provider: "acme", model: "group/chat-model", message: "429 Endpoint is unavailable" },
        { reason: "io-error", at: now - 3600000 },
      ],
    },
    lastFailedRange: { from: 473, to: 478 },
    extractionInFlight: false,
    lastAttemptAt: now - 60000,
    lastUsedRoute: { provider: "acme", model: "group/chat-model", at: now - 60000 },
  };
  const text = diagnosticTextOf(state, now);
  assert.match(text, /\/state 版本：1/);
  assert.match(text, /连续失败：3（原因：llm-error）/);
  assert.match(text, /llm-error 4/);
  assert.match(text, /io-error 1/);
  assert.match(text, /retried 2/);
  assert.match(text, /no-route 0/, "诊断文本分桶含零值（区别于 UI badge 的零值不渲染）");
  assert.match(text, /llm-error acme\/group\/chat-model：429 Endpoint is unavailable/);
  assert.match(text, /acme\/group\/chat-model（1 分钟前）/);
  assert.match(text, /未恢复区间：seq 473 之后/);
  assert.match(text, /提取中：否/);
  // 旧版宿主：无 recent / 无 lastUsedRoute
  const legacy = diagnosticTextOf({ version: 1, extractionFailures: { streak: 2, "llm-error": 2 } }, now);
  assert.match(legacy, /宿主版本较旧，未提供失败详情/);
  assert.match(legacy, /最近一次提取用车：尚无/);
  // 空态防御：整个 state 空对象也不炸
  assert.equal(typeof diagnosticTextOf({}, now), "string");
  assert.equal(typeof diagnosticTextOf(null, now), "string");
});

// ---- 最近提取记录（/state.extractionLog tolerant 消费纯函数） ----

test("extractionRunLabel：written 计数（writes+deletes）/ 部分失败附加；负数与非数字按 0", () => {
  assert.equal(extractionRunLabel({ outcome: "written", writes: 3, deletes: 2 }), "已写 5 条");
  assert.equal(extractionRunLabel({ outcome: "written", writes: 3 }), "已写 3 条");
  assert.equal(extractionRunLabel({ outcome: "written", deletes: 4 }), "已写 4 条");
  assert.equal(extractionRunLabel({ outcome: "written" }), "已写 0 条", "计数全缺按 0，不出现 NaN");
  assert.equal(
    extractionRunLabel({ outcome: "written", writes: 3, failedOps: 1 }),
    "已写 3 条；落盘失败 1",
    "部分成功必须可见（良性总数会掩盖失败的 1 条）",
  );
  assert.equal(extractionRunLabel({ outcome: "written", writes: "x", deletes: -2 }), "已写 0 条", "脏计数不炸不显示负数");
});

test("extractionRunLabel：zero-ops 两态（无可记 / 无可落盘）", () => {
  assert.equal(extractionRunLabel({ outcome: "zero-ops" }), "无可记");
  assert.equal(extractionRunLabel({ outcome: "zero-ops", reason: "no-user-prose" }), "无可记");
  assert.equal(
    extractionRunLabel({ outcome: "zero-ops", reason: "ops-未落盘" }),
    "无可落盘（被过滤/跳过）",
    "reason=ops-未落盘 是内容有但没落成 op，不能报成无可记",
  );
});

test("extractionRunLabel：skipped 四种中文原因 + 未收录 reason 原样透传", () => {
  assert.equal(extractionRunLabel({ outcome: "skipped", reason: "direct-memory-write" }), "跳过：主 agent 直写记忆");
  assert.equal(extractionRunLabel({ outcome: "skipped", reason: "no-user-prose" }), "跳过：无有效用户发言");
  assert.equal(extractionRunLabel({ outcome: "skipped", reason: "gate-off" }), "跳过：对话记忆总开关关");
  assert.equal(extractionRunLabel({ outcome: "skipped", reason: "format-readonly" }), "跳过：存储格式只读保护");
  assert.equal(extractionRunLabel({ outcome: "skipped", reason: "quota-exceeded" }), "跳过：quota-exceeded", "新 reason 未中文化时原样露（不错译）");
  assert.equal(extractionRunLabel({ outcome: "skipped" }), "跳过：—", "无 reason 不留空");
});

test("extractionRunLabel：failed 七种中文原因 + 未收录 reason 原样透传", () => {
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "llm-error" }), "失败：LLM 调用失败");
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "parse-error" }), "失败：输出解析失败");
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "io-error" }), "失败：落盘失败");
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "no-route" }), "失败：无模型路由");
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "no-cwd" }), "失败：会话无工作区");
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "aborted" }), "失败：中止");
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "exception" }), "失败：内部异常");
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "weird-new-reason" }), "失败：weird-new-reason");
  assert.equal(extractionRunLabel({ outcome: "failed" }), "失败：—");
});

test("extractionRunLabel：未知 outcome 报「未知：<原值>」，脏输入不炸", () => {
  assert.equal(extractionRunLabel({ outcome: "nope" }), "未知：nope");
  assert.equal(extractionRunLabel({ outcome: "" }), "未知：—", "空 outcome = 缺字段同口径");
  assert.equal(extractionRunLabel({}), "未知：—");
  assert.equal(extractionRunLabel(null), "未知：—");
  assert.equal(extractionRunLabel(void 0), "未知：—");
  assert.equal(extractionRunLabel("written"), "未知：—");
  assert.equal(extractionRunLabel(42), "未知：—", "非对象输入不抛");
});

test("extractionRunLines：行模型（at 透传/range/label/sessionId）；顺序保持（新在前）", () => {
  const lines = extractionRunLines({
    runs: [
      { at: 1730000000000, sessionId: "s1", from: 12, to: 80, outcome: "written", writes: 3, deletes: 1 },
      { at: 1729999900000, sessionId: "s2", from: 5, to: 11, outcome: "failed", reason: "llm-error" },
    ],
  });
  assert.deepEqual(lines, [
    { at: 1730000000000, range: "seq 12..80", label: "已写 4 条", sessionId: "s1" },
    { at: 1729999900000, range: "seq 5..11", label: "失败：LLM 调用失败", sessionId: "s2" },
  ]);
  // range 退化：一端/两端都缺如实显示，不编造 seq 0
  assert.equal(extractionRunLines({ runs: [{ outcome: "zero-ops", from: 7 }] })[0].range, "seq 7");
  assert.equal(extractionRunLines({ runs: [{ outcome: "zero-ops", to: 7 }] })[0].range, "seq ..7");
  assert.equal(extractionRunLines({ runs: [{ outcome: "zero-ops" }] })[0].range, "");
  // 缺 sessionId → 空串（渲染侧不显示 "undefined"）
  assert.equal(extractionRunLines({ runs: [{ outcome: "written", writes: 1 }] })[0].sessionId, "");
});

test("extractionRunLines：坏条目跳过（非对象/缺 outcome）；空与非数组容错", () => {
  const lines = extractionRunLines({
    runs: [
      null, "written", 42, [],
      { outcome: "written", writes: 1 }, // 唯一幸存条目
      { at: 1, from: 1, to: 2 }, // 缺 outcome：格式不明，跳过而不是猜
      { outcome: "", reason: "x" }, // 空 outcome 同上
    ],
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].label, "已写 1 条");
  // 容错：空/非数组/旧版宿主（无 extractionLog）一律空数组
  assert.deepEqual(extractionRunLines(null), []);
  assert.deepEqual(extractionRunLines(void 0), []);
  assert.deepEqual(extractionRunLines({}), []);
  assert.deepEqual(extractionRunLines({ runs: [] }), []);
  assert.deepEqual(extractionRunLines({ runs: "x" }), [], "runs 非数组不炸");
  assert.deepEqual(extractionRunLines([]), []);
  // 裸 runs 数组也能吃（面板两种拿法都可用）
  assert.equal(extractionRunLines([{ outcome: "skipped", reason: "gate-off" }])[0].label, "跳过：对话记忆总开关关");
});

test("unrecoveredTextFromLog：非空出提示串（与 extractionRangeText 同风格）；空/非数组 → 空串", () => {
  assert.equal(unrecoveredTextFromLog([{ sessionId: "s1", from: 473, to: 478, at: 1, reason: "llm-error" }]), "seq 473 之后的轮次未提取");
  assert.equal(unrecoveredTextFromLog([{ from: 10 }]), "seq 10 之后的轮次未提取", "只有 from 也够");
  // 首条无合法 from 时往下找第二条（脏数据不该让整提示消失）
  assert.equal(unrecoveredTextFromLog([{ from: "x" }, null, { from: 20 }]), "seq 20 之后的轮次未提取");
  assert.equal(unrecoveredTextFromLog([]), "");
  assert.equal(unrecoveredTextFromLog(null), "");
  assert.equal(unrecoveredTextFromLog(void 0), "");
  assert.equal(unrecoveredTextFromLog("x"), "");
  assert.equal(unrecoveredTextFromLog({ from: 1 }), "", "非数组（对象形态）不渲染");
  assert.equal(unrecoveredTextFromLog([{ from: undefined }, { to: 5 }]), "", "全无合法 from → 空（不编造 seq）");
});

// ---- 注入面摘要（/state.injection tolerant 消费纯函数） ----

test("injectionSummary：正常值「已注入 N 次 · 最近 X 字符」；丢段/渲染失败附加；空与 undefined → null", () => {
  assert.equal(injectionSummary({ count: 3, lastChars: 1200 }), "已注入 3 次 · 最近 1200 字符");
  assert.equal(
    injectionSummary({ count: 2, lastChars: 400, droppedSegments: 3, renderFailures: 1 }),
    "已注入 2 次 · 最近 400 字符 · 丢段 3 · 渲染失败 1",
  );
  assert.equal(injectionSummary({ count: 1, lastChars: 0 }), "已注入 1 次 · 最近 0 字符", "首注空块也如实报 0 字符");
  assert.equal(
    injectionSummary({ count: 2, lastChars: 100, droppedSegments: 0, renderFailures: 0 }),
    "已注入 2 次 · 最近 100 字符",
    "零值附加项不渲染",
  );
  // 无数据不显示（旧版宿主 / 尚未注入）
  assert.equal(injectionSummary(null), null);
  assert.equal(injectionSummary(void 0), null);
  assert.equal(injectionSummary({}), null);
  assert.equal(injectionSummary({ count: 0 }), null);
  assert.equal(injectionSummary({ count: 0, lastChars: 5 }), null);
  assert.equal(injectionSummary({ count: "x" }), null, "非法 count 不渲染");
});

test("validateEmbeddingDraft：开启需端点+模型、URL 限 http(s)", () => {
  assert.equal(validateEmbeddingDraft({ enabled: true, baseUrl: "", model: "m" }).ok, false);
  assert.match(validateEmbeddingDraft({ enabled: true, baseUrl: "", model: "m" }).error, /端点/);
  assert.match(validateEmbeddingDraft({ enabled: true, baseUrl: "http://x", model: "" }).error, /模型/);
  assert.match(validateEmbeddingDraft({ enabled: false, baseUrl: "file:///etc/passwd" }).error, /http/);
  assert.equal(validateEmbeddingDraft({ enabled: false, baseUrl: "not a url" }).ok, false);
  // 关闭且不填 → 放行（仅当覆盖用于清除/关闭）
  assert.equal(validateEmbeddingDraft({ enabled: false, baseUrl: "", model: "" }).ok, true);
  // 合法 http(s)（本地/远程均放行）
  assert.equal(validateEmbeddingDraft({ enabled: true, baseUrl: "http://127.0.0.1:11434/v1/embeddings", model: "nomic-embed-text" }).ok, true);
  assert.equal(validateEmbeddingDraft({ enabled: true, baseUrl: "https://api.openai.com/v1/embeddings", model: "text-embedding-3-small" }).ok, true);
  // apiKey 保留/清空两形态均放行：缺省（保留已存）与 null（显式清空）都不参与端点/模型校验
  assert.equal(validateEmbeddingDraft({ enabled: true, baseUrl: "http://x", model: "m", apiKey: null }).ok, true, "apiKey:null 放行（显式清空）");
  assert.equal(validateEmbeddingDraft({ enabled: false, baseUrl: "", model: "", apiKey: null }).ok, true, "仅清空 key 的关闭态也放行");
  assert.equal(validateEmbeddingDraft({ enabled: true, baseUrl: "http://x", model: "m" }).ok, true, "apiKey 键缺省放行（服务端保留）");
});

test("embeddingClearActionVisible：只认 settings 那份密钥；entry config 来源不出现清除入口", () => {
  assert.equal(embeddingClearActionVisible({ settings: { embedding: { apiKeySet: true } } }), true);
  assert.equal(embeddingClearActionVisible({ settings: { embedding: { apiKeySet: false } } }), false, "未设 key 不渲染");
  assert.equal(embeddingClearActionVisible({ settings: {} }), false, "settings 无 embedding = 密钥不在面板手里");
  // 密钥来自 entry config（settings.json 无 embedding）时清不掉也不该清——改 YAML 才是正主
  assert.equal(embeddingClearActionVisible({ embeddingEffective: { apiKeySet: true } }), false, "config 来源的密钥不出现清除入口");
  assert.equal(embeddingClearActionVisible({}), false, "旧宿主无 settings");
  assert.equal(embeddingClearActionVisible(null), false);
  assert.equal(embeddingClearActionVisible(void 0), false, "容错：非对象输入不抛");
  assert.equal(embeddingClearActionVisible({ settings: { embedding: { apiKeySet: "true" } } }), false, "严格 === true，字符串不算");
});

// ---- 写入安全面展示（回收站/快照页位置列 + 恢复确认弹窗共用） ----

test("safetyLocationText：rootKey 三种真实形态如实显示 + 畸形输入容错", () => {
  // 真实形态 1：全局分类删除（<storageRoot>/global/<category>）——原样，用户按目录找得到
  assert.equal(safetyLocationText({ rootKey: "global/work-profile" }), "global/work-profile");
  // 真实形态 2：项目记忆删除（<storageRoot>/projects/<slug>-<hash16>/memory）——slug 可读，hash 无意义
  assert.equal(safetyLocationText({ rootKey: "projects/demo-a1b2c3d4e5f6a7b/memory" }), "项目 demo");
  // 真实形态 3：rootKeyOf 同根返回 ""（写入目标就是项目记忆根本身）
  assert.equal(safetyLocationText({ rootKey: "" }), "项目记忆");
  assert.equal(safetyLocationText({}), "项目记忆", "缺 rootKey 字段 = 空串形态");
  // 未知真实形态：原样显示，不猜前缀
  assert.equal(safetyLocationText({ rootKey: "other/whatever" }), "other/whatever");
  // 宽容归一：首尾斜杠 / 多余斜杠 / Windows 反斜杠 / 空白
  assert.equal(safetyLocationText({ rootKey: "/global/work-profile/" }), "global/work-profile");
  assert.equal(safetyLocationText({ rootKey: " global\\work-profile " }), "global/work-profile");
  // 畸形输入：绝不出现 undefined/NaN/异常
  assert.equal(safetyLocationText(null), "—");
  assert.equal(safetyLocationText(void 0), "—");
  assert.equal(safetyLocationText("x"), "—");
  assert.equal(safetyLocationText({ rootKey: null }), "项目记忆", "null rootKey = 缺失同口径");
  assert.equal(safetyLocationText({ rootKey: 42 }), "—", "非字符串 rootKey 不 String 化成怪串");
  assert.equal(safetyLocationText({ rootKey: {} }), "—");
  assert.equal(safetyLocationText({ rootKey: [] }), "—");
  assert.equal(safetyLocationText({ rootKey: true }), "—");
});

test("safetySummaryText：hardfactBlocks>0 显示「硬事实拦截 N」（与 verifyFailed 分列）；=0 不显示；全零仍 null", () => {
  // hardfactBlocks>0：与相邻段同格式（段名 + 空格 + 计数），且与 verifyFailed 各自成段
  const s = safetySummaryText({ hardfactBlocks: 2, verifyFailed: 1 });
  assert.match(s, /硬事实拦截 2/);
  assert.match(s, /写后校验失败 1/);
  assert.equal(s, "写入安全面：写后校验失败 1 · 硬事实拦截 2");
  // hardfactBlocks=0：不渲染段
  assert.doesNotMatch(safetySummaryText({ hardfactBlocks: 0, trashPending: 1 }) ?? "", /硬事实拦截/);
  // 仅 hardfactBlocks>0 也出文案（不为零即显式可见）
  assert.equal(safetySummaryText({ hardfactBlocks: 3 }), "写入安全面：硬事实拦截 3");
  // 全零 / 空对象 / 缺失 / 畸形 → null（与既有纪律一致）
  assert.equal(safetySummaryText({}), null);
  assert.equal(safetySummaryText({ hardfactBlocks: 0 }), null);
  assert.equal(safetySummaryText(null), null);
  assert.equal(safetySummaryText(void 0), null);
  assert.equal(safetySummaryText("x"), null);
});

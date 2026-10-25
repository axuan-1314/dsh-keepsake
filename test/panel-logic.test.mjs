// panel-logic 检查：导入解析/预览行模型/主题映射/档位决策/近期动态/检索
//   + 提取管道可观测纯函数（三态判定/红条文案/模型短名/相对时间/诊断文本）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXTRACTION_BUCKET_KEYS,
  EXTRACTION_REASON_LABELS,
  MAINTENANCE_EMPTY_TEXT,
  PAGE_SIZE,
  PERSONA_PRESETS,
  PENDING_EMPTY_TEXT,
  PENDING_RECOVERING_TEXT,
  PENDING_UNAVAILABLE_NOTE,
  RUNTIME_GUIDE_TEXT,
  RUNTIME_OVER_QUOTA_HINT,
  RUNTIME_READONLY_NOTE,
  RUNTIME_SKIP_REASON_LABELS,
  RUNTIME_UNPIN_WARNING,
  abandonedNoticeText,
  applyThemeVars,
  buildImportRequest,
  canShowNoFailureLine,
  collectThemeVarsFromDoc,
  decideLadderTier,
  deleteOutcomeOf,
  detectImportFormat,
  diagnosticTextOf,
  duplicateScorePct,
  embeddingClearActionVisible,
  extractionNoticeText,
  extractionRangeText,
  extractionRunLabel,
  extractionRunLines,
  extractionStreakOf,
  filterEntries,
  healthPriorityLevel,
  healthPriorityWord,
  INDEX_HEALTH_COLUMNS,
  injectionBudgetText,
  injectionExtraText,
  injectionSummary,
  importTitleOf,
  ladderFallbackOf,
  ladderNoteOf,
  maintenanceCountsText,
  maintenanceSuggestionsEmpty,
  modelShortName,
  paginateOf,
  paginationText,
  panelBackAction,
  parseSourceText,
  pendingHostNote,
  pendingItemLabel,
  pipeHealthLevel,
  previewRowsOf,
  reasonLabelOf,
  reasoningDegradedText,
  recentAgeOf,
  recentExpireDays,
  relativeTimeOf,
  repairIndexResultText,
  runtimeArtifactRows,
  runtimeCandidateRows,
  runtimeCompileSummaryText,
  runtimeEnabledOf,
  runtimeEvictSelection,
  runtimeEvictToastText,
  runtimePinTarget,
  runtimeRestoreRows,
  runtimeRestoreToastText,
  runtimeScopeLabel,
  runtimeScopeOptions,
  runtimeSkippedRows,
  runtimeStatusBadge,
  runtimeUsageOf,
  safetyLocationText,
  safetySummaryText,
  serializeEntries,
  settingsCoercionNote,
  staleDaysText,
  trapFocus,
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

test("recentAgeOf：今天/1 天前/N 天前；非法时间戳显示「—」不冒充今天", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  assert.deepEqual(recentAgeOf("2026-10-08T01:00:00Z", now), { days: 0, text: "今天" });
  assert.deepEqual(recentAgeOf("2026-10-07T13:00:00Z", now), { days: 0, text: "今天" }); // 22h
  assert.deepEqual(recentAgeOf("2026-10-06T13:00:00Z", now), { days: 1, text: "1 天前" });
  assert.deepEqual(recentAgeOf("2026-10-01T00:00:00Z", now), { days: 7, text: "7 天前" });
  // 解析失败：days 给 null + text 给 "—"（旧行为返回 {days:0,text:"今天"} 是误报）
  assert.deepEqual(recentAgeOf("bad", now), { days: null, text: "—" });
  assert.deepEqual(recentAgeOf("", now), { days: null, text: "—" });
  assert.deepEqual(recentAgeOf(null, now), { days: null, text: "—" });
});

test("recentExpireDays：keepDays - age，下限 0；第二参数缺省/非法落 30；时间戳坏 → null", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  assert.equal(recentExpireDays("2026-10-05T12:00:00Z", 30, now), 27);
  assert.equal(recentExpireDays("2026-09-01T00:00:00Z", 30, now), 0);
  // 第二参数按 keepDays 走（不再写死 30）——面板经 /state.recentKeepDays 传入
  assert.equal(recentExpireDays("2026-10-05T12:00:00Z", 7, now), 4);
  assert.equal(recentExpireDays("2026-10-05T12:00:00Z", 90, now), 87);
  // 第二参数缺省才落 30
  assert.equal(recentExpireDays("2026-10-05T12:00:00Z", void 0, now), 27);
  // 非法 keepDays（0/负/NaN/非数字）一律按缺省 30 处理，不出负数或 NaN
  assert.equal(recentExpireDays("2026-10-05T12:00:00Z", 0, now), 27);
  assert.equal(recentExpireDays("2026-10-05T12:00:00Z", -5, now), 27);
  assert.equal(recentExpireDays("2026-10-05T12:00:00Z", "x", now), 27);
  assert.equal(recentExpireDays("2026-10-05T12:00:00Z", NaN, now), 27);
  // 时间戳解析不了：不编造"还剩 N 天"，如实给 null
  assert.equal(recentExpireDays("bad", 30, now), null);
  assert.equal(recentExpireDays(null, 30, now), null);
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

test("EXTRACTION_BUCKET_KEYS：五存量桶 + retried/fallbackUsed/reasoningDegraded/escapeRetried，顺序稳定（分桶展示序）", () => {
  assert.deepEqual(EXTRACTION_BUCKET_KEYS, [
    "no-route", "no-cwd", "llm-error", "parse-error", "io-error", "retried", "fallbackUsed", "reasoningDegraded", "escapeRetried",
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
  const OLD = (n) => `记忆自动提取最近连续失败 ${n} 次，期间对话内容可能未被记录——可在记忆管理面板复制诊断信息（含 /state 快照）反馈给开发者。`;
  assert.equal(extractionNoticeText(null), "");
  assert.equal(extractionNoticeText(0), "");
  assert.equal(extractionNoticeText({ streak: 0, recent: [] }), "");
  // 新版主形态（计数 · 病因（模型末段））——原因走中文映射，不露英文枚举
  assert.equal(
    extractionNoticeText({ streak: 3, recent: [{ reason: "llm-error", at: 1, provider: "acme", model: "group/chat-model", message: "429 …" }] }),
    "自动提取失败 3 次 · 最近：LLM 调用失败（chat-model）",
  );
  assert.equal(extractionNoticeText({ streak: 1, recent: [{ reason: "io-error" }] }), "自动提取失败 1 次 · 最近：落盘失败");
  assert.equal(extractionNoticeText({ streak: 2, recent: [] }), "自动提取失败 2 次", "有 recent 字段但空（≠旧版文案）");
  assert.equal(
    extractionNoticeText({ streak: 2, recent: [], streakReason: "parse-error" }),
    "自动提取失败 2 次 · 最近：输出解析失败",
    "recent 空时 streakReason 兜底",
  );
  assert.equal(extractionNoticeText({ streak: 2, recent: [{ model: "group/x" }] }), "自动提取失败 2 次", "无原因时只报计数");
  // 旧版：无 recent 字段（对象）或纯数字 → 沿用旧单行文案
  assert.equal(extractionNoticeText({ streak: 3, streakReason: "llm-error" }), OLD(3));
  assert.equal(extractionNoticeText(3), OLD(3));
});

test("reasoningDegradedText：>0 出「思考档降级 N 次」摘要；零值/缺失/脏值 → null（不渲染）", () => {
  const t = reasoningDegradedText({ reasoningDegraded: 3 });
  assert.match(t, /思考档降级 3 次/, "必须含次数");
  assert.match(t, /降级/, "必须含「降级」字样（用户面文案测试关键词）");
  assert.match(t, /该路由不支持所配档位/, "必须说清原因（用户据此决定换不换档位）");
  // 零值 / 缺字段 / 旧数字形态 / 脏值 → null（不印 0 装饰）
  assert.equal(reasoningDegradedText({ reasoningDegraded: 0 }), null);
  assert.equal(reasoningDegradedText({}), null);
  assert.equal(reasoningDegradedText(null), null);
  assert.equal(reasoningDegradedText(void 0), null);
  assert.equal(reasoningDegradedText(2), null, "旧数字形态没有这个字段：null（不拿 streak 顶替）");
  assert.equal(reasoningDegradedText({ reasoningDegraded: -1 }), null);
  assert.equal(reasoningDegradedText({ reasoningDegraded: "x" }), null);
  assert.equal(reasoningDegradedText({ reasoningDegraded: NaN }), null);
  // 小数钳成整数次数（不印 2.5 次）
  assert.match(reasoningDegradedText({ reasoningDegraded: 2.9 }), /思考档降级 2 次/);
});

test("extractionNoticeText：失败原因中文化（复用 EXTRACTION_REASON_LABELS），未收录走兜底美化", () => {
  const ENUM_RE = /\b(no-route|llm-error|parse-error|io-error|no-cwd)\b/;
  // 已收录的失败枚举：一律译成中文，且绝不露英文 token
  for (const [token, zh] of Object.entries(EXTRACTION_REASON_LABELS)) {
    const text = extractionNoticeText({ streak: 2, recent: [{ reason: token, model: "acme/chat" }] });
    assert.doesNotMatch(text, ENUM_RE, `原因 ${token} 不得以英文枚举出现在面板：${text}`);
    assert.ok(text.includes(zh), `原因 ${token} 应显示为「${zh}」：${text}`);
  }
  // 用户实际看到的形态（实测的 no-route 场景）
  assert.equal(
    extractionNoticeText({ streak: 5, recent: [{ reason: "no-route", model: "mozu1" }] }),
    "自动提取失败 5 次 · 最近：无模型路由（mozu1）",
  );
  // streakReason 兜底路径同样中文化（recent 空）
  assert.equal(
    extractionNoticeText({ streak: 2, recent: [], streakReason: "no-cwd" }),
    "自动提取失败 2 次 · 最近：会话无工作区",
  );
  // 未收录原因：兜底美化（连字符/下划线转空格），不抛错、不显示原始下划线串
  const future = extractionNoticeText({ streak: 1, recent: [{ reason: "some-future-reason" }] });
  assert.equal(future, "自动提取失败 1 次 · 最近：some future reason");
  assert.doesNotMatch(future, /some-future-reason|some_future_reason/, "未收录原因不得原样露出下划线/连字符串");
  assert.equal(extractionNoticeText({ streak: 1, recent: [{ reason: "quota_exceeded" }] }), "自动提取失败 1 次 · 最近：quota exceeded");
});

test("extractionRangeText：第 X 轮对话之后…（去 seq 内部术语）；条件不满足 → 空", () => {
  const TEXT = "第 473 轮对话之后的内容尚未记录，恢复后自动补提";
  assert.equal(extractionRangeText({ streak: 3 }, { from: 473, to: 478 }), TEXT);
  assert.equal(extractionRangeText({ streak: 1 }, { from: 473 }), TEXT);
  assert.equal(extractionRangeText(2, { from: 10 }), "第 10 轮对话之后的内容尚未记录，恢复后自动补提", "旧数字形态 streak 也认");
  assert.equal(extractionRangeText({ streak: 0 }, { from: 473 }), "", "已恢复不提示");
  assert.equal(extractionRangeText({ streak: 3 }, null), "");
  assert.equal(extractionRangeText({ streak: 3 }, {}), "");
  assert.equal(extractionRangeText({ streak: 3 }, { from: "x" }), "", "非法 from 不渲染");
  assert.equal(extractionRangeText({ streak: 3 }, "473"), "", "非对象形态不渲染");
  assert.doesNotMatch(TEXT, /seq/, "面板文案不得再露 seq 内部术语");
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

test("extractionRunLabel：written + truncatedParse>0 → 附「（输出被截断，可能少存）」", () => {
  // 截断仍解析成功 = "看起来正常的成功"，不标出来用户永远不知道这次可能少存了几条
  assert.equal(
    extractionRunLabel({ outcome: "written", writes: 2, truncatedParse: 1 }),
    "已写 2 条（输出被截断，可能少存）",
  );
  // 与落盘失败并存在场（两个提示都要在，不互相顶替）
  assert.equal(
    extractionRunLabel({ outcome: "written", writes: 2, failedOps: 1, truncatedParse: 1 }),
    "已写 2 条；落盘失败 1（输出被截断，可能少存）",
  );
  // 0/缺省/脏值 → 不附（不印 0 装饰）
  assert.equal(extractionRunLabel({ outcome: "written", writes: 2, truncatedParse: 0 }), "已写 2 条");
  assert.equal(extractionRunLabel({ outcome: "written", writes: 2 }), "已写 2 条");
  assert.equal(extractionRunLabel({ outcome: "written", writes: 2, truncatedParse: "x" }), "已写 2 条", "脏值不炸不附标");
  // 非 written 终态不带截断标（截断标只对"写成了"有意义）
  assert.equal(extractionRunLabel({ outcome: "zero-ops", truncatedParse: 1 }), "无可记");
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "parse-error", truncatedParse: 1 }), "失败：输出解析失败");
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

test("extractionRunLabel：skipped 四种中文原因 + 未收录 reason 走兜底美化（连字符转空格）", () => {
  assert.equal(extractionRunLabel({ outcome: "skipped", reason: "direct-memory-write" }), "跳过：主 agent 直写记忆");
  assert.equal(extractionRunLabel({ outcome: "skipped", reason: "no-user-prose" }), "跳过：无有效用户发言");
  assert.equal(extractionRunLabel({ outcome: "skipped", reason: "gate-off" }), "跳过：对话记忆总开关关");
  assert.equal(extractionRunLabel({ outcome: "skipped", reason: "format-readonly" }), "跳过：存储格式只读保护");
  assert.equal(extractionRunLabel({ outcome: "skipped", reason: "quota-exceeded" }), "跳过：quota exceeded", "新 reason 未中文化时兜底美化（连字符转空格），不直接糊 token");
  assert.equal(extractionRunLabel({ outcome: "skipped" }), "跳过：—", "无 reason 不留空");
});

test("extractionRunLabel：failed 七种中文原因 + 未收录 reason 走兜底美化", () => {
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "llm-error" }), "失败：LLM 调用失败");
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "parse-error" }), "失败：输出解析失败");
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "io-error" }), "失败：落盘失败");
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "no-route" }), "失败：无模型路由");
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "no-cwd" }), "失败：会话无工作区");
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "aborted" }), "失败：中止");
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "exception" }), "失败：内部异常");
  assert.equal(extractionRunLabel({ outcome: "failed", reason: "weird-new-reason" }), "失败：weird new reason");
  assert.equal(extractionRunLabel({ outcome: "failed" }), "失败：—");
});

test("extractionRunLabel：abandoned（journal 第五态）报「已放弃：」+ 中文化原因，不落「未知：」", () => {
  assert.equal(extractionRunLabel({ outcome: "abandoned", reason: "no-cwd" }), "已放弃：会话无工作区");
  assert.equal(extractionRunLabel({ outcome: "abandoned", reason: "no-route" }), "已放弃：无模型路由");
  assert.equal(extractionRunLabel({ outcome: "abandoned", reason: "weird-reason" }), "已放弃：weird reason", "未收录 reason 兜底美化");
  assert.equal(extractionRunLabel({ outcome: "abandoned" }), "已放弃：—", "无 reason 不留空");
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

test("unrecoveredTextFromLog：非空出提示串（与 extractionRangeText 同风格，说人话不露 seq）；空/非数组 → 空串", () => {
  assert.equal(unrecoveredTextFromLog([{ sessionId: "s1", from: 473, to: 478, at: 1, reason: "llm-error" }]), "第 473 轮对话之后的内容未提取");
  assert.equal(unrecoveredTextFromLog([{ from: 10 }]), "第 10 轮对话之后的内容未提取", "只有 from 也够");
  // 首条无合法 from 时往下找第二条（脏数据不该让整提示消失）
  assert.equal(unrecoveredTextFromLog([{ from: "x" }, null, { from: 20 }]), "第 20 轮对话之后的内容未提取");
  assert.equal(unrecoveredTextFromLog([]), "");
  assert.equal(unrecoveredTextFromLog(null), "");
  assert.equal(unrecoveredTextFromLog(void 0), "");
  assert.equal(unrecoveredTextFromLog("x"), "");
  assert.equal(unrecoveredTextFromLog({ from: 1 }), "", "非数组（对象形态）不渲染");
  assert.equal(unrecoveredTextFromLog([{ from: undefined }, { to: 5 }]), "", "全无合法 from → 空（不编造轮次）");
});

// ---- 放弃区间红条（/state.extractionLog.abandoned tolerant 消费纯函数） ----

test("EXTRACTION_REASON_LABELS：中英混杂 token 归一为纯中文（模型无产出/改动未落盘）", () => {
  assert.equal(EXTRACTION_REASON_LABELS["model-无产出"], "模型无产出");
  assert.equal(EXTRACTION_REASON_LABELS["ops-未落盘"], "改动未落盘");
  // 全表值都不含连字符/下划线残留（面板不露 token 原形）
  assert.ok(Object.values(EXTRACTION_REASON_LABELS).every((v) => !/[-_]/.test(v)));
});

test("reasonLabelOf：收录译中文；未收录兜底美化（连字符/下划线转空格）；空 → —", () => {
  assert.equal(reasonLabelOf("llm-error"), "LLM 调用失败");
  assert.equal(reasonLabelOf("model-无产出"), "模型无产出");
  assert.equal(reasonLabelOf("ops-未落盘"), "改动未落盘");
  assert.equal(reasonLabelOf("some_new-token"), "some new token", "未收录 token 转空格美化，不留连字符");
  assert.equal(reasonLabelOf(""), "—");
  assert.equal(reasonLabelOf("   "), "—");
  assert.equal(reasonLabelOf(null), "—");
  assert.equal(reasonLabelOf(void 0), "—");
});

test("abandonedNoticeText：有数据 → 文案字符串；空/非数组 → null（不渲染）", () => {
  const r = abandonedNoticeText([{ from: 10, to: 20, sessionId: "s1" }, { from: 30, to: 40, sessionId: "s1" }]);
  assert.equal(typeof r, "string", "返回裸文案字符串（面板按 err 红条渲染）");
  assert.match(r, /有 2 段对话的提取已放弃/);
  assert.match(r, /可在下方最近提取记录查看明细|可在最近提取记录查看明细/);
  assert.match(r, /可在「待补提区间」里找到并尝试救回/, "已放弃区间必须指路补提入口（只说不会补上=用户不知道还能救）");
  // 单条
  assert.equal(abandonedNoticeText([{ from: 1, to: 2 }]).startsWith("有 1 段对话的提取已放弃"), true);
  // 无数据 / 旧版宿主 → null（不渲染，不装样子）
  assert.equal(abandonedNoticeText([]), null);
  assert.equal(abandonedNoticeText(null), null);
  assert.equal(abandonedNoticeText(void 0), null);
  assert.equal(abandonedNoticeText("x"), null);
  // 数组里只有脏条目（非对象）→ 计数为 0 → null（不编造）
  assert.equal(abandonedNoticeText([null, "x", 42]), null);
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

// ---- 会话补提清单（/sessions/pending 契约行模型） ----

test("pendingItemLabel：未恢复/已放弃人话标签 + 区间不露 seq + reason 走共享映射 + 相对时间", () => {
  const now = 1730000000000;
  const failed = pendingItemLabel({
    sessionId: "session-abc", from: 473, to: 478,
    at: new Date(now - 300000).toISOString(), reason: "llm-error", kind: "failed",
    sessionAvailable: true,
  }, now);
  assert.equal(failed, "未恢复区间 · 第 473 轮对话之后的内容 · 5 分钟前 · LLM 调用失败");
  // abandoned 换标签（结论不同：不再自动重试），reason 同样中文化
  assert.match(
    pendingItemLabel({ sessionId: "s", from: 10, at: now, reason: "no-cwd", kind: "abandoned" }, now),
    /^已放弃区间 · 第 10 轮对话之后的内容 · 刚刚 · 会话无工作区$/,
  );
  // 未收录 reason 走兜底美化（连字符转空格），不糊 token
  assert.match(
    pendingItemLabel({ sessionId: "s", from: 1, at: now, reason: "quota-exceeded", kind: "failed" }, now),
    /quota exceeded$/,
  );
  // 无 reason → "—"（不留空）
  assert.match(pendingItemLabel({ sessionId: "s", from: 1, at: now, kind: "failed" }, now), /· —$/);
  // from 非法不编造轮次；kind 缺失按「待补提」如实降级
  assert.match(pendingItemLabel({ sessionId: "s", at: now, kind: "weird" }, now), /^待补提区间 · 一段对话内容/);
  assert.doesNotMatch(pendingItemLabel({ sessionId: "s", at: now, kind: "failed" }, now), /seq/, "面板文案不露 seq 内部术语");
  // 坏行 → null（调用方跳过，不渲染空行）
  assert.equal(pendingItemLabel(null), null);
  assert.equal(pendingItemLabel(void 0), null);
  assert.equal(pendingItemLabel("x"), null);
  assert.equal(pendingItemLabel(42), null);
});

test("补提清单常量：空态/忙碌/不可读说明文案在位（不空承诺）", () => {
  assert.equal(PENDING_EMPTY_TEXT, "没有待补的区间");
  assert.equal(PENDING_RECOVERING_TEXT, "补提中…");
  assert.equal(PENDING_UNAVAILABLE_NOTE, "该会话当前不可读，重开会话后可自动续提");
  // hostSupported=false 才出说明；true/缺失（旧宿主）不渲染
  assert.match(pendingHostNote(false), /不支持读取历史会话/);
  assert.equal(pendingHostNote(true), "");
  assert.equal(pendingHostNote(void 0), "");
});

// ---- 记忆整理建议（/maintenance/suggestions 契约） ----

test("duplicateScorePct：0..1 → 整数百分比；非法与负值按 0（不印 NaN）", () => {
  assert.equal(duplicateScorePct(0.98), 98);
  assert.equal(duplicateScorePct(0.9), 90);
  assert.equal(duplicateScorePct(0.5), 50);
  assert.equal(duplicateScorePct(1), 100);
  assert.equal(duplicateScorePct(1.5), 100, "超 1 夹到 100，不印 150%");
  assert.equal(duplicateScorePct(0), 0);
  assert.equal(duplicateScorePct(-1), 0);
  assert.equal(duplicateScorePct("x"), 0);
  assert.equal(duplicateScorePct(null), 0);
  assert.equal(duplicateScorePct(void 0), 0);
});

test("staleDaysText：stale 报 N 天未更新；unknown-age 与坏值如实说「年龄不可知」", () => {
  assert.equal(staleDaysText({ name: "a.md", kind: "stale", days: 137 }), "137 天未更新");
  assert.equal(staleDaysText({ name: "a.md", kind: "unknown-age", lastModifiedAt: null, days: null }), "年龄不可知");
  // days 缺失/非法（旧宿主或脏数据）：不拿 0 冒充「0 天未更新」
  assert.equal(staleDaysText({ name: "a.md", kind: "stale" }), "年龄不可知");
  assert.equal(staleDaysText({ name: "a.md", kind: "stale", days: "x" }), "年龄不可知");
  assert.equal(staleDaysText({ name: "a.md", kind: "stale", days: -5 }), "年龄不可知");
  assert.equal(staleDaysText(null), "年龄不可知");
  assert.equal(staleDaysText("x"), "年龄不可知");
});

test("maintenanceSuggestionsEmpty：三组全空才空态；任一组有内容即非空；畸形容错", () => {
  assert.equal(maintenanceSuggestionsEmpty(null), true);
  assert.equal(maintenanceSuggestionsEmpty({}), true);
  assert.equal(maintenanceSuggestionsEmpty({ duplicates: [], stale: [], indexHealth: { dangling: [], orphans: [], emptyCategories: [] } }), true);
  assert.equal(maintenanceSuggestionsEmpty({ duplicates: [{ a: "x", b: "y", score: 0.9, why: "w" }] }), false);
  assert.equal(maintenanceSuggestionsEmpty({ stale: [{ name: "a", kind: "stale", days: 100 }] }), false);
  assert.equal(maintenanceSuggestionsEmpty({ indexHealth: { dangling: [{ category: "c", line: "l", name: "n" }] } }), false);
  assert.equal(maintenanceSuggestionsEmpty({ indexHealth: { orphans: [{ category: "c", name: "n" }] } }), false);
  assert.equal(maintenanceSuggestionsEmpty({ indexHealth: { emptyCategories: ["c"] } }), false);
  // 非数组脏值不当内容（不炸，按空算）
  assert.equal(maintenanceSuggestionsEmpty({ duplicates: "x", stale: 3, indexHealth: "y" }), true);
  assert.equal(MAINTENANCE_EMPTY_TEXT, "暂无建议");
});

test("INDEX_HEALTH_COLUMNS：三列（悬挂行/漏登记/空分类）标题与口径说明", () => {
  assert.deepEqual(INDEX_HEALTH_COLUMNS.map((c) => c.key), ["dangling", "orphans", "emptyCategories"]);
  assert.deepEqual(INDEX_HEALTH_COLUMNS.map((c) => c.label), ["悬挂行", "漏登记", "空分类"]);
});

test("repairIndexResultText：数组列明细 / 数字报数 / 空与 unchanged → 无需修复 / 形状不明如实说", () => {
  // 服务端最终契约：fixed=已应用动作明细数组 + fixedCount + unchanged
  assert.equal(
    repairIndexResultText({ ok: true, fixed: [{ type: "remove-line", category: "long-term", line: "- [x](g.md)" }, { type: "add-line", category: "work-profile", name: "n.md" }], fixedCount: 2, unchanged: false }),
    "已修复 2 处：删悬挂行（long-term）、补登记（work-profile）",
  );
  // 真路由形状（服务端真发这三字段）：断言回显含「已修复 1 处」
  assert.equal(
    repairIndexResultText({ ok: true, fixed: [{ type: "remove-line", category: "legacy", line: "- [x](gone.md)" }], fixedCount: 1, unchanged: false }),
    "已修复 1 处：删悬挂行（legacy）",
  );
  assert.equal(repairIndexResultText({ ok: true, fixed: [], fixedCount: 0, unchanged: true }), "无需修复：索引与磁盘已经对上账");
  assert.equal(repairIndexResultText({ ok: true, fixed: [], fixedCount: 0 }), "无需修复：索引与磁盘已经对上账");
  // 未知 type 原样报（不吞）——后端新增动作类型时面板不装懂
  assert.match(repairIndexResultText({ fixed: [{ type: "reorder-line", category: "c" }] }), /reorder-line（c）/);
  // 数字形态（旧服务端 fixed 为条数）：0 → 无需修复；N → 已修复 N 处
  assert.equal(repairIndexResultText({ ok: true, fixed: 0, unchanged: false }), "无需修复：索引与磁盘已经对上账");
  assert.equal(repairIndexResultText({ ok: true, fixed: 3 }), "已修复 3 处");
  // 形状不明（缺字段/非对象）：如实「修复结果未知」，绝不冒充「无需修复」
  assert.equal(repairIndexResultText({ ok: true }), "修复结果未知");
  assert.equal(repairIndexResultText(null), "修复结果未知");
  assert.equal(repairIndexResultText({ fixed: "x" }), "修复结果未知");
});

test("maintenanceCountsText：计数字段人话化 + truncated 补一行提示（不裸布尔）", () => {
  assert.equal(
    maintenanceCountsText({ entries: 12, entryTotal: 12, indexes: 8, indexTotal: 8, truncated: false }),
    "计数：条目 12/12 · 索引 8/8",
  );
  // 截断：补一行人话（含「前 500 条」），不裸印 truncated true
  assert.equal(
    maintenanceCountsText({ entries: 500, entryTotal: 900, indexes: 8, indexTotal: 8, truncated: true }),
    "计数：条目 500/900 · 索引 8/8。条目过多，建议基于部分数据（前 500 条）",
  );
  // 只有半数字段时如实显示
  assert.equal(maintenanceCountsText({ entries: 5 }), "计数：条目 5");
  assert.equal(maintenanceCountsText({ entryTotal: 5 }), "计数：条目总数 5");
  // 空/脏值/非对象：容错不炸，报「暂不可用」
  assert.equal(maintenanceCountsText(null), "计数暂不可用");
  assert.equal(maintenanceCountsText({}), "计数暂不可用");
  assert.equal(maintenanceCountsText({ entries: "x" }), "计数暂不可用");
  // truncated 为 true 但无计数字段：仍如实报不可用（不裸布尔）
  assert.equal(maintenanceCountsText({ truncated: true }), "计数暂不可用");
});

// ---- 健康卡状态优先级（绿红并置修正） ----

test("healthPriorityLevel：数据损坏/只读 > 未恢复区间 > 已放弃 > 绿行（显式优先级）", () => {
  // 最高优先级：数据损坏/只读（压过一切，哪怕同时有未恢复区间）
  assert.equal(healthPriorityLevel({ corrupt: true, extractionLog: { unrecovered: [{ from: 1 }] } }), "corrupt");
  assert.equal(healthPriorityLevel({ addressingCorrupt: true }), "corrupt");
  assert.equal(healthPriorityLevel({ personaCorrupt: true }), "corrupt");
  assert.equal(healthPriorityLevel({ format: { writable: false } }), "corrupt");
  // 未恢复区间压过已放弃（failed 是承诺过要补的）
  assert.equal(healthPriorityLevel({ extractionLog: { unrecovered: [{ from: 473 }], abandoned: [{ from: 10 }] } }), "unrecovered");
  assert.equal(healthPriorityLevel({ extractionLog: { unrecovered: [{ from: 473 }] } }), "unrecovered");
  // 只有已放弃 → abandoned
  assert.equal(healthPriorityLevel({ extractionLog: { abandoned: [{ from: 10 }] } }), "abandoned");
  // 一切正常（含旧宿主无 extractionLog）
  assert.equal(healthPriorityLevel({}), "green");
  assert.equal(healthPriorityLevel(null), "green");
  assert.equal(healthPriorityLevel({ extractionLog: { unrecovered: [], abandoned: [] } }), "green");
  assert.equal(healthPriorityLevel({ format: { writable: true } }), "green");
  // 空数组不当有内容（旧宿主空形）
  assert.equal(healthPriorityLevel({ extractionLog: "x" }), "green", "extractionLog 非对象按无（旧宿主/脏值）");
});

test("healthPriorityWord + canShowNoFailureLine：状态词第二编码；有未恢复/已放弃时绿行禁显", () => {
  assert.equal(healthPriorityWord("corrupt"), "需处理");
  assert.equal(healthPriorityWord("unrecovered"), "待补提");
  assert.equal(healthPriorityWord("abandoned"), "有放弃");
  assert.equal(healthPriorityWord("green"), "正常");
  assert.equal(healthPriorityWord("bogus"), "正常", "未知级别回落正常（不崩）");
  // 核心修正：只有 green 允许显示「最近无失败」
  assert.equal(canShowNoFailureLine("green"), true);
  assert.equal(canShowNoFailureLine("unrecovered"), false, "有未恢复区间 → 禁显绿行（并置自相矛盾）");
  assert.equal(canShowNoFailureLine("abandoned"), false, "有已放弃区间 → 禁显绿行");
  assert.equal(canShowNoFailureLine("corrupt"), false);
});

// ---- 删除三态判读（DELETE /entry 契约） ----

test("deleteOutcomeOf：三态互不混同（不存在/已移入回收站/删除失败不抹列表）", () => {
  // 态①：不存在 → 提示 + 刷新
  assert.deepEqual(deleteOutcomeOf({ ok: true, existed: false, trashed: false }), {
    kind: "missing", toast: "条目不存在（可能已被删除）", reload: true,
  });
  // 态②：已移入回收站 → 成功提示 + 刷新
  assert.deepEqual(deleteOutcomeOf({ ok: true, existed: true, trashed: true, trashId: "t1" }), {
    kind: "trashed", toast: "已移入回收站（可在回收站找回）", reload: true,
  });
  // 态③：删除失败（409 E_ENTRY_UNREADABLE / 500 E_ENTRY_DELETE_FAILED）→ 错误提示 + **不**刷新
  const failed = deleteOutcomeOf({ existed: true, trashed: false, code: "E_ENTRY_DELETE_FAILED" });
  assert.equal(failed.kind, "failed");
  assert.equal(failed.toast, "未能删除，条目仍在原位");
  assert.equal(failed.reload, false, "失败时不得刷新列表——原件还在，抹掉就是静默消失");
  // 旧宿主无 existed 字段 → 按失败处理（不谎报成功）
  assert.equal(deleteOutcomeOf({}).kind, "failed");
  assert.equal(deleteOutcomeOf(null).kind, "failed");
  // trashed 缺失（缺字段）不算成功：existed:true 但无 trashed:true
  assert.equal(deleteOutcomeOf({ existed: true }).kind, "failed");
});

// ---- 设置健康提示（/state.settingsDiagnostics.coercedFields） ----

test("settingsCoercionNote：N 项不合法已回默认（字段名）；空/缺失/非数组 → 空串不渲染", () => {
  assert.equal(
    settingsCoercionNote({ coercedFields: ["trashKeepDays", "recentKeepDays"] }),
    "2 项设置值不合法已回默认（trashKeepDays、recentKeepDays），重存设置可修正",
  );
  // 超过 5 个字段：列前 5 个 + 总量（不无限铺开）
  const many = settingsCoercionNote({ coercedFields: ["a", "b", "c", "d", "e", "f", "g"] });
  assert.match(many, /7 项设置值不合法已回默认（a、b、c、d、e 等 7 项）/);
  // 非字符串条目过滤掉（脏数据不出现在文案里）
  assert.equal(settingsCoercionNote({ coercedFields: ["ok", null, 3, ""] }), "1 项设置值不合法已回默认（ok），重存设置可修正");
  // 空/缺失/畸形 → ""（不渲染黄条）
  assert.equal(settingsCoercionNote({}), "");
  assert.equal(settingsCoercionNote({ coercedFields: [] }), "");
  assert.equal(settingsCoercionNote(null), "");
  assert.equal(settingsCoercionNote(void 0), "");
  assert.equal(settingsCoercionNote("x"), "");
  assert.equal(settingsCoercionNote({ coercedFields: [null, 3] }), "");
});

// ---- 注入面节流/取代计数（/state.injection.throttled/superseded） ----

test("injectionExtraText：「变更节流 N 次 / 取代 N 次」；缺失或全零 → 空串不显示", () => {
  assert.equal(injectionExtraText({ throttled: 3, superseded: 1 }), "变更节流 3 次 / 取代 1 次");
  assert.equal(injectionExtraText({ throttled: 2 }), "变更节流 2 次");
  assert.equal(injectionExtraText({ superseded: 5 }), "取代 5 次");
  // 字段缺失（旧宿主）/ 零值 / 非数字 → 不渲染（不印 0 装饰）
  assert.equal(injectionExtraText({}), "");
  assert.equal(injectionExtraText({ throttled: 0, superseded: 0 }), "");
  assert.equal(injectionExtraText({ throttled: "x" }), "");
  assert.equal(injectionExtraText(null), "");
  assert.equal(injectionExtraText("x"), "");
  // 负数按 0（不出现「变更节流 -1 次」）
  assert.equal(injectionExtraText({ throttled: -2 }), "");
});

test("injectionSummary：附加 throttled/superseded 两计数（既有输出零回归）", () => {
  // 新计数进场，追加在丢段/渲染失败之后（顺序稳定）
  assert.equal(
    injectionSummary({ count: 3, lastChars: 1200, throttled: 2, superseded: 1 }),
    "已注入 3 次 · 最近 1200 字符 · 变更节流 2 次 / 取代 1 次",
  );
  assert.equal(
    injectionSummary({ count: 3, lastChars: 100, droppedSegments: 2, throttled: 1, superseded: 4 }),
    "已注入 3 次 · 最近 100 字符 · 丢段 2 · 变更节流 1 次 / 取代 4 次",
  );
  // 零回归：无新计数字段时输出与旧版逐字一致
  assert.equal(injectionSummary({ count: 3, lastChars: 1200 }), "已注入 3 次 · 最近 1200 字符");
  assert.equal(injectionSummary({ count: 2, lastChars: 400, droppedSegments: 3, renderFailures: 1 }), "已注入 2 次 · 最近 400 字符 · 丢段 3 · 渲染失败 1");
  assert.equal(injectionSummary({ count: 0, renderFailures: 2 }), "注入异常 渲染失败 2 次");
  assert.equal(injectionSummary(null), null);
  assert.equal(injectionSummary({ count: 0 }), null);
});

// ---- 注入预算占用（token 口径；上限 0/缺失=退纯字符展示） ----

test("injectionBudgetText：`最近 ≈X tokens / 上限 Y`；Y=0/上限缺失/无 lastTokens → 空串（维持纯字符展示）", () => {
  // 正常：最近一次注入估算 token + 上限（取整防脏数据小数）
  assert.equal(injectionBudgetText({ count: 3, lastTokens: 812 }, 16000), "最近 ≈812 tokens / 上限 16000");
  assert.equal(injectionBudgetText({ count: 1, lastTokens: 0 }, 4096), "最近 ≈0 tokens / 上限 4096", "空块也如实报 0");
  assert.equal(injectionBudgetText({ count: 2, lastTokens: 100.7 }, 4096.9), "最近 ≈100 tokens / 上限 4096", "小数向下取整");
  // Y=0 = 禁用 token 预算（回滚档）：不显 token 段，不印"上限 0"
  assert.equal(injectionBudgetText({ count: 3, lastTokens: 812 }, 0), "");
  assert.equal(injectionBudgetText({ count: 3, lastTokens: 812 }, "0"), "");
  // 旧数据/缺字段容错：旧服务端无 lastTokens / 无上限 / 尚未注入 → 空串，绝不抛
  assert.equal(injectionBudgetText({ count: 3 }, 16000), "", "无 lastTokens（旧服务端）→ 空串");
  assert.equal(injectionBudgetText({ count: 3, lastTokens: 812 }, void 0), "");
  assert.equal(injectionBudgetText({ count: 3, lastTokens: 812 }, null), "");
  assert.equal(injectionBudgetText({ count: 3, lastTokens: 812 }, -5), "");
  assert.equal(injectionBudgetText({ count: 3, lastTokens: 812 }, "x"), "");
  assert.equal(injectionBudgetText({ count: 0, lastTokens: 812 }, 16000), "", "尚未注入与 injectionSummary 同口径不装样子");
  assert.equal(injectionBudgetText({ count: "x", lastTokens: 812 }, 16000), "");
  assert.equal(injectionBudgetText({ count: 3, lastTokens: "x" }, 16000), "");
  assert.equal(injectionBudgetText({ count: 3, lastTokens: -1 }, 16000), "");
  // 畸形 injection（旧宿主/脏数据）→ 空串，绝不抛
  assert.equal(injectionBudgetText(null, 16000), "");
  assert.equal(injectionBudgetText(void 0, 16000), "");
  assert.equal(injectionBudgetText("x", 16000), "");
  assert.equal(injectionBudgetText([], 16000), "");
  // 面板实际调用形态：maxTokens 来自 /state.injectMaxTokens（旧宿主为 null）
  assert.equal(injectionBudgetText({ count: 1, lastTokens: 500 }, null), "");
});

// ---- 列表分页（分类页/长期记忆列表共用） ----

test("paginateOf：每页 50；越界回落末页；空列表 0 页；脏值不炸", () => {
  assert.equal(PAGE_SIZE, 50);
  // 53 条 → 2 页；第 1 页 50 条，第 2 页 3 条
  const p0 = paginateOf(53, 0);
  assert.deepEqual(p0, { total: 53, pageSize: 50, pageCount: 2, page: 0, start: 0, end: 50, hasPrev: false, hasNext: true });
  const p1 = paginateOf(53, 1);
  assert.equal(p1.start, 50);
  assert.equal(p1.end, 53);
  assert.equal(p1.hasPrev, true);
  assert.equal(p1.hasNext, false);
  // 恰好一页：无上一页/下一页
  const one = paginateOf(50, 0);
  assert.equal(one.pageCount, 1);
  assert.equal(one.hasPrev, false);
  assert.equal(one.hasNext, false);
  // 空列表：0 页、区间空
  const empty = paginateOf(0, 0);
  assert.equal(empty.pageCount, 0);
  assert.equal(empty.start, 0);
  assert.equal(empty.end, 0);
  assert.equal(empty.hasPrev, false);
  assert.equal(empty.hasNext, false);
  // 越界页码（删条目后旧页号还在）→ 末页，不是空页
  assert.equal(paginateOf(53, 99).page, 1);
  assert.equal(paginateOf(53, 99).end, 53);
  assert.equal(paginateOf(53, -1).page, 0, "负数页回第 1 页");
  assert.equal(paginateOf(53, 1.7).page, 1, "小数页向下取整");
  assert.equal(paginateOf(53, "x").page, 0, "非数字页回第 1 页");
  // total/pageSize 脏值防御
  assert.equal(paginateOf(-5, 0).total, 0);
  assert.equal(paginateOf("x", 0).total, 0);
  assert.equal(paginateOf(53, 0, 0).pageSize, PAGE_SIZE, "非法 pageSize 回落默认");
  assert.equal(paginateOf(10, 0, 3).pageCount, 4);
});

test("paginationText：「第 N/M 页 · 共 X 条」（M=0 时第 1/0 页不崩）", () => {
  assert.equal(paginationText(paginateOf(53, 1)), "第 2/2 页 · 共 53 条");
  assert.equal(paginationText(paginateOf(53, 0)), "第 1/2 页 · 共 53 条");
  assert.equal(paginationText(paginateOf(0, 0)), "第 1/0 页 · 共 0 条");
  assert.equal(paginationText(null), "第 1/0 页 · 共 0 条", "空输入不炸");
});

// ---- 弹窗焦点陷阱（四处弹窗复用） ----

test("trapFocus：Tab 循环（首尾回卷）+ 焦点外拉回 + Esc 关闭；卸载后不再拦", () => {
  // 模拟 DOM：容器 + 3 个可聚焦按钮，document.activeElement 全局可写
  const handlers = [];
  const els = ["a", "b", "c"].map((id) => ({ id, offsetParent: {}, focus() { doc.activeElement = this; } }));
  const container = { contains: (el) => els.includes(el), querySelectorAll: () => els };
  const doc = { activeElement: null, addEventListener: (_t, fn) => handlers.push(fn), removeEventListener: (_t, fn) => {
    const i = handlers.indexOf(fn);
    if (i >= 0) handlers.splice(i, 1);
  } };
  const realDoc = globalThis.document;
  globalThis.document = doc;
  let closed = 0;
  try {
    const off = trapFocus(container, () => { closed += 1; });
    // 注意：合成事件的 key 必须显式 key: keyName——简写 { key } 会解析到外层同名绑定
    const press = (keyName, shiftKey = false) => handlers[handlers.length - 1]({ key: keyName, shiftKey, preventDefault() {} });
    doc.activeElement = els[2]; // 焦点在末元素
    press("Tab");               // 末元素 Tab → 回卷首元素
    assert.equal(doc.activeElement, els[0], "末元素 Tab 回卷到首元素");
    press("Tab", true);         // 首元素 Shift+Tab → 回卷末元素
    assert.equal(doc.activeElement, els[2], "首元素 Shift+Tab 回卷到末元素");
    press("Tab");               // 首元素 Tab：不拦（非边界，焦点推进交给浏览器，陷阱不越权）
    assert.equal(doc.activeElement, els[0], "非边界 Tab 不拦（本模拟 DOM 无默认推进，焦点停在首元素）");
    doc.activeElement = null;   // 焦点逃到 body
    press("Tab");
    assert.equal(doc.activeElement, els[0], "容器外 Tab 拉回首元素");
    press("Escape");
    assert.equal(closed, 1, "Esc 关闭");
    press("x");                 // 非 Tab/Esc 键不拦（不炸）
    off();
    assert.equal(handlers.length, 0, "卸载后监听摘除（弹窗关闭必须调 off，否则泄漏到后台页）");
    const before = doc.activeElement;
    // 卸载后再触发：无监听即无副作用
    assert.equal(handlers.length, 0);
    assert.equal(doc.activeElement, before);
  } finally {
    globalThis.document = realDoc;
  }
});

test("trapFocus：卸载时把焦点还原到打开前的触发元素（无障碍；脱挂则跳过）", () => {
  const handlers = [];
  const prev = { id: "trigger", isConnected: true, focus() { doc.activeElement = this; } };
  const inside = { id: "ok", isConnected: true, focus() { doc.activeElement = this; } };
  const container = { contains: (el) => el === inside, querySelectorAll: () => [inside] };
  const doc = { activeElement: prev, addEventListener: (_t, fn) => handlers.push(fn), removeEventListener: (_t, fn) => {
    const i = handlers.indexOf(fn);
    if (i >= 0) handlers.splice(i, 1);
  } };
  const realDoc = globalThis.document;
  globalThis.document = doc;
  try {
    // 打开时焦点在触发元素上 → 卸载后应还原回去
    const off = trapFocus(container, () => {});
    doc.activeElement = inside; // 焦点已移进弹窗
    off();
    assert.equal(doc.activeElement, prev, "卸载后焦点还原到打开前的触发元素");
    // 触发元素已脱挂（isConnected===false）→ 不硬拉，焦点留在原处
    doc.activeElement = prev;
    prev.isConnected = false;
    const off2 = trapFocus(container, () => {});
    doc.activeElement = inside;
    off2();
    assert.equal(doc.activeElement, inside, "触发元素脱挂时不硬拉焦点");
  } finally {
    globalThis.document = realDoc;
  }
});

test("trapFocus：容器内暂无可聚焦元素时不拦（空态弹窗不卡键盘）", () => {
  const handlers = [];
  const container = { contains: () => false, querySelectorAll: () => [] };
  const doc = { activeElement: null, addEventListener: (_t, fn) => handlers.push(fn), removeEventListener: () => {} };
  const realDoc = globalThis.document;
  globalThis.document = doc;
  try {
    let closed = 0;
    trapFocus(container, () => { closed += 1; });
    handlers[handlers.length - 1]({ key: "Tab", preventDefault() { throw new Error("不应拦截"); } });
    // Esc 仍生效（关闭不依赖容器内元素）
    handlers[handlers.length - 1]({ key: "Escape", preventDefault() {} });
    assert.equal(closed, 1);
  } finally {
    globalThis.document = realDoc;
  }
});

// ---- 运行时记忆页签（RUNTIME-FORMAT §十二 UX 约定；GET/POST runtime 契约纯函数） ----

test("runtimeScopeLabel：global→全局；projects/<slug>-<hash16>→项目 <slug>（hash 对用户无意义）；脏值容错", () => {
  assert.equal(runtimeScopeLabel("global"), "全局");
  assert.equal(runtimeScopeLabel("projects/demo-0123456789abcdef"), "项目 demo");
  assert.equal(runtimeScopeLabel("projects/my-app-aaaaaaaaaaaaaaaa"), "项目 my-app");
  assert.equal(runtimeScopeLabel(""), "—");
  assert.equal(runtimeScopeLabel(null), "—");
  assert.equal(runtimeScopeLabel("projects/foo"), "projects/foo", "未知形态原样显示（不硬掰）");
});

test("runtimeScopeOptions：全局在首 + 项目升序；坏 id/重复 id 丢弃（不摆必 404 的死选项）；同名 slug 补 hash 消歧", () => {
  const out = runtimeScopeOptions([
    { id: "zeta-0123456789abcdef", entries: 3 },
    { id: "alpha-0123456789abcdef", entries: 1 },
    { id: "Bad_UPPER", entries: 9 }, // 不过形态闸
    null,
    { id: "alpha-0123456789abcdef", entries: 1 }, // 重复
  ]);
  assert.deepEqual(out.map((o) => o.scope), ["global", "projects/alpha-0123456789abcdef", "projects/zeta-0123456789abcdef"]);
  assert.equal(out[0].label, "全局");
  assert.equal(out[0].entries, null);
  assert.equal(out[1].label, "项目 alpha");
  assert.equal(out[1].entries, 1);
  // 同名 slug 撞车 → 补 hash 前 8 位
  const dup = runtimeScopeOptions([
    { id: "app-aaaaaaaaaaaaaaaa" }, { id: "app-bbbbbbbbbbbbbbbb" },
  ]);
  assert.equal(dup[1].label, "项目 app · aaaaaaaa");
  assert.equal(dup[2].label, "项目 app · bbbbbbbb");
  // 空/脏输入 → 只有全局
  assert.deepEqual(runtimeScopeOptions(undefined).map((o) => o.scope), ["global"]);
  assert.deepEqual(runtimeScopeOptions("x").map((o) => o.scope), ["global"]);
});

test("runtimeUsageOf：百分比/越界红显/条宽截顶；配额未知不拿 0% 冒充", () => {
  const u = runtimeUsageOf({ bytes: 1024, quotaBytes: 4096 });
  assert.deepEqual({ bytes: u.bytes, quotaBytes: u.quotaBytes, pct: u.pct, barPct: u.barPct, over: u.over }, { bytes: 1024, quotaBytes: 4096, pct: 25, barPct: 25, over: false });
  assert.match(u.text, /1024 \/ 4096 字节 · 25%/);
  // 越界：pct 如实 >100，barPct 截顶 100（防破版），over=true
  const over = runtimeUsageOf({ bytes: 12288, quotaBytes: 10240 });
  assert.equal(over.pct, 120);
  assert.equal(over.barPct, 100);
  assert.equal(over.over, true);
  assert.match(over.text, /已超配额/);
  // 恰好等于配额：不算越界（≤ 是 ok）
  const exact = runtimeUsageOf({ bytes: 4096, quotaBytes: 4096 });
  assert.equal(exact.pct, 100);
  assert.equal(exact.over, false);
  // 配额未知（缺失/0/脏值）→ over=false 且文案明说（不冒充 0% 正常）
  for (const file of [undefined, null, {}, { bytes: 100 }, { bytes: 100, quotaBytes: 0 }, { bytes: "x", quotaBytes: "y" }]) {
    const r = runtimeUsageOf(file);
    assert.equal(r.over, false);
    assert.equal(r.pct, 0);
    assert.match(r.text, /配额未知/);
  }
});

test("runtimeStatusBadge：ok/overQuota/error 三态映射 + 缺失/未知→尚未编译（不冒充正常）", () => {
  assert.deepEqual(runtimeStatusBadge("ok"), { level: "green", word: "正常", hint: "" });
  const over = runtimeStatusBadge("overQuota");
  assert.equal(over.level, "red");
  assert.equal(over.word, "超配额");
  assert.equal(over.hint, RUNTIME_OVER_QUOTA_HINT, "overQuota 必须给操作指引（解 pin/精简/归档）");
  assert.match(over.hint, /解 pin/);
  assert.match(over.hint, /long-term/);
  // 文案不得再指路「改配置文件调高配额」——配额是编译期常量，那条路不可执行
  assert.doesNotMatch(over.hint, /改配置文件/);
  const err = runtimeStatusBadge("error");
  assert.equal(err.level, "red");
  assert.equal(err.word, "编译失败");
  assert.match(err.hint, /重新编译/);
  for (const s of [undefined, null, "", "bogus"]) {
    const b = runtimeStatusBadge(s);
    assert.equal(b.level, "grey");
    assert.equal(b.word, "尚未编译");
  }
  // §十二 固定文案常量在场（单一出处）
  assert.match(RUNTIME_GUIDE_TEXT, /运行时记忆＝每轮注入的紧凑记忆层，默认关闭；开启后生效/);
  assert.match(RUNTIME_UNPIN_WARNING, /取消关键标记后，该条目可能在下次编译成为淘汰候选/);
  assert.match(RUNTIME_READONLY_NOTE, /只读预览/);
});

test("runtimeCandidateRows：标题/分类/字节/稳定 key；global:<category> 与 project 分类文案分列；坏项跳过", () => {
  const rows = runtimeCandidateRows([
    { rootKey: "global:work-profile", file: "big.md", bytes: 620, reason: "quota", lastSeenAt: "2026-10-20T12:00:00.000Z" },
    { rootKey: "project", file: "deep/nested.md", bytes: 300, reason: "quota" },
    null,
    { rootKey: "global:user-profile" }, // 缺 file → 跳过
    { rootKey: "global:user-profile", file: "   " }, // 空 file → 跳过
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual({ title: rows[0].title, category: rows[0].category, bytes: rows[0].bytes, sizeText: rows[0].sizeText, reasonText: rows[0].reasonText }, {
    title: "big", category: "全局 · work-profile", bytes: 620, sizeText: "620 字节", reasonText: "超出配额",
  });
  // 嵌套 file 取末段做标题，key 用完整 file（供提交时原样回传）
  assert.equal(rows[1].title, "nested");
  assert.equal(rows[1].category, "项目条目");
  assert.equal(rows[1].key, "project\u0000deep/nested.md");
  // 未知 reason 原样透传（不粉饰）
  assert.equal(runtimeCandidateRows([{ rootKey: "project", file: "a.md", reason: "weird" }])[0].reasonText, "weird");
  assert.deepEqual(runtimeCandidateRows(undefined), []);
});

test("runtimeEvictSelection：刷新后清单与勾选集求交（防过期）；消失的进 dropped 不硬提交", () => {
  const rows = runtimeCandidateRows([
    { rootKey: "global:work-profile", file: "a.md", bytes: 1 },
    { rootKey: "global:work-profile", file: "b.md", bytes: 1 },
  ]);
  const strong = new Set([rows[0].key, rows[1].key, "global:work-profile\u0000gone.md"]);
  const sel = runtimeEvictSelection(strong, rows);
  assert.deepEqual(sel.files, [
    { rootKey: "global:work-profile", file: "a.md" },
    { rootKey: "global:work-profile", file: "b.md" },
  ]);
  assert.deepEqual(sel.dropped, [{ rootKey: "global:work-profile", file: "gone.md" }]);
  // 刷新后清单为空（产出消失）→ 一条都不提交，全部如实进 dropped
  const none = runtimeEvictSelection(strong, []);
  assert.deepEqual(none.files, []);
  assert.equal(none.dropped.length, 3);
  // 空勾选 / 脏输入不炸
  assert.deepEqual(runtimeEvictSelection(undefined, rows), { files: [], dropped: [] });
  assert.deepEqual(runtimeEvictSelection([], null), { files: [], dropped: [] });
});

test("runtimeSkippedRows：skipped 原因中文化（含「条目已变化，已跳过」）；未收录原因原样如实", () => {
  const rows = runtimeSkippedRows([
    { rootKey: "global:work-profile", file: "x.md", reason: "not-candidate" },
    { rootKey: "project", file: "y.md", reason: "missing" },
    { rootKey: "project", file: "z.md", reason: "weird-reason" },
    null,
  ]);
  assert.equal(rows.length, 3);
  assert.match(rows[0].text, /条目已变化，已跳过/);
  assert.match(rows[1].text, /已不存在/);
  assert.match(rows[2].text, /weird-reason/);
  assert.equal(RUNTIME_SKIP_REASON_LABELS["not-candidate"], "条目已变化，已跳过", "§十二 固定文案");
  assert.deepEqual(runtimeSkippedRows(null), []);
});

test("runtimeCompileSummaryText：diff 摘要（入选/候选/前后字节差）；无前值只报现值；响应不成形如实说未知", () => {
  const out = { ok: true, scope: "global", status: "ok", selected: 5, candidates: 2, overQuota: false, bytes: { user: 220, memory: 4300 } };
  const text = runtimeCompileSummaryText(out, { user: { bytes: 200 }, memory: { bytes: 4300 } });
  assert.match(text, /全局/);
  assert.match(text, /入选 5 条/);
  assert.match(text, /淘汰候选 2 条/);
  assert.match(text, /user 200→220 字节（\+20）/);
  assert.match(text, /memory 4300→4300 字节（±0）/);
  // 减少与无前值两态
  assert.match(runtimeCompileSummaryText(out, { user: { bytes: 300 }, memory: { bytes: 5000 } }), /memory 5000→4300 字节（-700）/);
  assert.match(runtimeCompileSummaryText(out, null), /user 220 字节/);
  // overQuota 附指引；不成形响应如实说未知（不拿 0 冒充）
  assert.match(runtimeCompileSummaryText({ ...out, overQuota: true }, null), /超出配额/);
  assert.match(runtimeCompileSummaryText(null, null), /重新编译结果未知/);
  assert.match(runtimeCompileSummaryText({ ok: false }, null), /重新编译结果未知/);
  // 项目 scope 标签人话化
  assert.match(runtimeCompileSummaryText({ ...out, scope: "projects/demo-0123456789abcdef" }, null), /项目 demo/);
});

test("runtimeEvictToastText：§十二 固定口径（已归档到 long-term，未删除；快照在 backups/evict-<ts>）+ skipped 计数", () => {
  const text = runtimeEvictToastText({ archived: 2, skipped: [], snapshotDir: "backups/evict-2026-10-20T12-00-00-000Z" });
  assert.match(text, /已归档 2 条到 long-term，未删除/);
  assert.match(text, /快照在 backups\/evict-/);
  // skipped 非空：附计数（明细在页内）
  const withSkip = runtimeEvictToastText({ archived: 1, skipped: [{ rootKey: "project", file: "a.md", reason: "not-candidate" }], snapshotDir: "backups/evict-x" });
  assert.match(withSkip, /1 条已跳过/);
  // 零归档不谎报成功
  assert.match(runtimeEvictToastText({ archived: 0, skipped: [{ file: "a.md", reason: "not-candidate" }] }), /没有条目被归档/);
  assert.match(runtimeEvictToastText(undefined), /没有条目被归档/);
  // 无快照（异常态）不编造路径
  assert.doesNotMatch(runtimeEvictToastText({ archived: 1, skipped: [] }), /快照在/);
});

test("runtimeRestoreRows：单层 .md 名才收（端点只认单层）；嵌套/坏名跳过；古人话时间", () => {
  const now = Date.parse("2026-10-20T12:00:00.000Z");
  const rows = runtimeRestoreRows([
    { name: "archived.md", title: "归档条目", description: "来自项目", mtimeMs: now - 3600_000 },
    { name: "nested/evil.md", title: "嵌套" },
    { name: "not-md.txt", title: "非 md" },
    null,
  ], now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, "archived.md");
  assert.equal(rows[0].title, "归档条目");
  assert.match(rows[0].whenText, /小时前/);
  // 无 title 用文件名去扩展名兜底（不空着）
  assert.equal(runtimeRestoreRows([{ name: "x.md" }])[0].title, "x");
  assert.deepEqual(runtimeRestoreRows(undefined), []);
});

test("runtimeRestoreToastText：移回成功文案（落点/重名避让/scope）；坏响应不炸", () => {
  const text = runtimeRestoreToastText({ file: "a.md", name: "a.md", to: "global/long-term/a.md", scope: "global" });
  assert.match(text, /已从归档移回：a\.md/);
  assert.match(text, /落点 global\/long-term\/a\.md/);
  assert.doesNotMatch(text, /重名避让/, "未改名不印避让说明");
  const renamed = runtimeRestoreToastText({ file: "a.md", name: "a-2.md", to: "projects/demo-0123456789abcdef/memory/a-2.md", scope: "projects/demo-0123456789abcdef" });
  assert.match(renamed, /a\.md → a-2\.md（重名避让改名）/);
  assert.match(renamed, /scope：项目 demo/);
  assert.match(runtimeRestoreToastText(null), /已从归档移回/);
});

test("runtimePinTarget：rootKey 一律在路径 scope 内解析（§十一）；不可定位给原因不猜", () => {
  const globalRow = { rootKey: "global:work-profile", file: "f.md" };
  const projectRow = { rootKey: "project", file: "p.md" };
  assert.deepEqual(runtimePinTarget(globalRow, "global"), { ok: true, rootKey: "global:work-profile", file: "f.md" });
  assert.deepEqual(runtimePinTarget(projectRow, "projects/demo-0123456789abcdef"), { ok: true, rootKey: "project", file: "p.md" });
  // 跨 scope 形态：拒绝并说清该去哪切
  assert.match(runtimePinTarget(globalRow, "projects/demo-0123456789abcdef").reason, /全局.*scope/);
  assert.match(runtimePinTarget(projectRow, "global").reason, /项目.*scope/);
  // 不可定位（产物行反推失败）
  assert.match(runtimePinTarget({ rootKey: null, file: null }, "global").reason, /不可识别/);
  assert.match(runtimePinTarget(null, "global").reason, /不可识别/);
});

test("runtimeEnabledOf：后端字段优先 → 本会话回填 → 缺省关（三态 tolerant，不让界面回弹谎报）", () => {
  // ① 后端带了该字段（settingsForClient 接线后）：以它为准，本地回填不得覆盖
  assert.equal(runtimeEnabledOf({ runtimeEnabled: true }, null), true);
  assert.equal(runtimeEnabledOf({ runtimeEnabled: false }, true), false, "后端说关就关（本地回填不越过真值）");
  // ② 后端没带（旧宿主）：用本会话 PUT 成功后的回填
  assert.equal(runtimeEnabledOf({}, true), true);
  assert.equal(runtimeEnabledOf({}, false), false);
  // ③ 都没有 → 缺省关（与 settings 读侧 parsed.runtimeEnabled === true 同口径）
  assert.equal(runtimeEnabledOf({}, null), false);
  assert.equal(runtimeEnabledOf(undefined, undefined), false);
  assert.equal(runtimeEnabledOf(null, "yes"), false, "脏回填不冒充布尔");
  assert.equal(runtimeEnabledOf({ runtimeEnabled: 1 }, null), false, "非布尔真值不当 true（口径是 === true）");
});

// ---- P1：纠错面 + 轮次活动条（纯函数容错与口径） ----
test("correctionsSummary：零值/null 不装饰，成功与失败各自可见", async () => {
  const L = await import("../lib/panel-logic.js");
  assert.equal(L.correctionsSummary(undefined), null);
  assert.equal(L.correctionsSummary(null), null);
  assert.equal(L.correctionsSummary({}), null, "全零不印 0 装饰");
  assert.equal(L.correctionsSummary({ applied: 2, writes: 3, deletes: 1 }), "已纠正 2 次（改写 3 / 删除 1）");
  // 失败不能被成功掩盖：两者并置
  assert.match(L.correctionsSummary({ applied: 1, writes: 1, deletes: 0, failed: 2 }), /未生效 2 次/);
  assert.equal(L.correctionsSummary({ failed: 1 }), "未生效 1 次");
});

test("correctionRows：四种结局人话化，坏行跳过，相对时间容错", async () => {
  const L = await import("../lib/panel-logic.js");
  const rows = L.correctionRows([
    { at: new Date().toISOString(), target: "a.md", kind: "wrong-fact", outcome: "applied", writes: 1, deletes: 0 },
    { at: new Date().toISOString(), target: "b.md", kind: "outdated", outcome: "needs-input" },
    { at: new Date().toISOString(), target: "c.md", kind: "duplicate", outcome: "nothing" },
    { at: new Date().toISOString(), target: "d.md", kind: "unknown-kind", outcome: "error" },
    null,
  ]);
  assert.equal(rows.length, 4, "坏行（null）跳过");
  assert.equal(rows[0].kindText, "记错事实");
  assert.match(rows[0].resultText, /改了 1 条/);
  assert.equal(rows[1].resultText, "需补充说明（未改）");
  assert.equal(rows[2].resultText, "无需改动");
  assert.equal(rows[3].resultText, "失败");
  assert.equal(rows[3].kindText, "unknown-kind", "未知类型原样显示，不编");
  assert.deepEqual(L.correctionRows(undefined), []);
});

test("correctionKindOptions：五种类型全部给中英对照", async () => {
  const L = await import("../lib/panel-logic.js");
  const opts = L.correctionKindOptions();
  assert.equal(opts.length, 5);
  assert.deepEqual(opts.map((o) => o.value).sort(), ["duplicate", "other", "outdated", "wrong-fact", "wrong-scope"]);
  assert.ok(opts.every((o) => typeof o.label === "string" && o.label.length > 0));
});

test("turnActivityRows：失败事件涂红标记，坏行跳过，时间格式化", async () => {
  const L = await import("../lib/panel-logic.js");
  const rows = L.turnActivityRows([
    { at: Date.parse("2026-10-25T10:20:30Z"), kind: "extraction", detail: "已写 2 条", outcome: "written" },
    { at: Date.parse("2026-10-25T10:21:00Z"), kind: "extraction", detail: "失败：模型调用失败", outcome: "failed" },
    { at: Date.parse("2026-10-25T10:22:00Z"), kind: "weird", detail: "未知面" },
    null,
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kindText, "提取");
  assert.equal(rows[0].isBad, false);
  assert.equal(rows[1].isBad, true, "失败事件必须可被涂红");
  assert.equal(rows[2].kindText, "其它", "未知类型不硬编");
  assert.match(rows[0].time, /^\d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(L.turnActivityRows(null), []);
});

test("turnActivityNote：区分『没接上』与『这段时间确实没活动』", async () => {
  const L = await import("../lib/panel-logic.js");
  const now = Date.parse("2026-10-25T12:00:00Z");
  assert.match(L.turnActivityNote(null), /未提供活动数据/);
  assert.match(L.turnActivityNote({ events: [] }), /未提供活动数据/, "window 缺失 = 旧宿主/未接线");
  assert.match(
    L.turnActivityNote({ window: { since: now - 30 * 60000, until: now }, total: 0 }),
    /最近 30 分钟内没有提取\/注入活动/,
    "接上了但确实没活动 —— 措辞必须与『没接上』不同",
  );
  assert.match(
    L.turnActivityNote({ window: { since: now - 120 * 60000, until: now }, total: 7 }),
    /最近 2 小时内共 7 条活动/,
  );
  assert.match(
    L.turnActivityNote({ window: { since: now - 60 * 60000, until: now }, total: 30, truncated: true }),
    /只显示最新的部分/,
  );
});

test("correctionKindText：面板任何展示「原因」的地方都必须过它（不许露英文枚举）", async () => {
  const L = await import("../lib/panel-logic.js");
  assert.equal(L.correctionKindText("wrong-fact"), "记错事实");
  assert.equal(L.correctionKindText("outdated"), "已过时");
  assert.equal(L.correctionKindText("wrong-scope"), "放错位置");
  assert.equal(L.correctionKindText("duplicate"), "重复");
  assert.equal(L.correctionKindText("other"), "其它");
  // 未知值原样返回：不丢信息，也不编一个中文名冒充认识它
  assert.equal(L.correctionKindText("brand-new-kind"), "brand-new-kind");
  assert.equal(L.correctionKindText(""), "");
  assert.equal(L.correctionKindText(null), "");
  // 五种下拉选项必须全部有中文（与 corrections 模块枚举同口径）
  for (const opt of L.correctionKindOptions()) {
    assert.equal(L.correctionKindText(opt.value), opt.label, `${opt.value} 下拉与翻译必须一致`);
  }
});

test("面板源码不把 kinds 原样拼进 HTML（归组视图曾因此露出 wrong-fact）", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, "..", "web", "panel.html"), "utf8");
  // 禁止 `(x.kinds || []).join(...)` 这种直接拼接——必须先 map 过 correctionKindText
  assert.doesNotMatch(
    html,
    /\(g\.kinds\s*\|\|\s*\[\]\)\.join\(/,
    "kinds 必须先经 L.correctionKindText 翻译再拼接",
  );
  assert.match(html, /kinds \|\| \[\]\)\.map\(\(k\) => L\.correctionKindText\(k\)\)/, "归组列表必须走翻译函数");
});

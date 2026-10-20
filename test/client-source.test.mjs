// client.js / panel.html 防漂移检查（短平快第一步 + 各修复的结构钉）
//   + 提取管道可观测：兜底-实现表驱动一致 + 面板消费锚。
//   源码 grep 型 + 兜底函数提取执行对比：lib/client.js 的内联兜底、web/panel.html 的
//   协议字面量与行为锚点，任何一边改动立刻红——防止"检查测的是没被消费的那份"。
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  decideLadderTier,
  extractionNoticeText,
  extractionRangeText,
  extractionStreakOf,
  injectionBudgetText,
  injectionSummary,
  formatNoticeText,
  ladderNoteOf,
} from "../lib/panel-logic.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientSrc = readFileSync(path.join(root, "lib", "client.js"), "utf8");
const panelSrc = readFileSync(path.join(root, "web", "panel.html"), "utf8");

/** 从 client.js factory（4 空格缩进）提取指定内联兜底函数体并求值。
 *  锚定「行首恰好 4 空格的 }」为函数结束（体内 if 块为 6 空格缩进，不会误配）。
 *  deps：被提函数体内引用的同厂内联 helper 名（如 injectionSummaryFallback 调
 *  injectionExtraFallback）——一并提取后按名注入为外层绑定，缺了它们会 ReferenceError。 */
function extractFactoryFn(src, name, params, deps = []) {
  const re = new RegExp(`^ {4}function ${name}\\(${params}\\) \\{([\\s\\S]*?)\\n {4}\\}$`, "m");
  const m = src.match(re);
  assert.ok(m, `client.js 必须保留内联兜底 ${name}（动态 import 失败的退路）`);
  const argNames = params.split(",").map((p) => p.trim().split("=")[0].trim());
  const depFns = deps.map((dep) => {
    const dm = src.match(new RegExp(`^ {4}function ${dep}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n {4}\\}`, "m"));
    assert.ok(dm, `client.js 必须保留被 ${name} 引用的内联兜底 ${dep}`);
    const depParams = dm[1].split(",").map((p) => p.trim().split("=")[0].trim()).filter((p) => p.length > 0);
    return new Function(...depParams, dm[2]);
  });
  if (deps.length === 0) return new Function(...argNames, m[1]);
  // 有依赖：外层包一层工厂，把 dep 绑进闭包，再返回真正的目标函数
  const factory = new Function(...deps, `return function(${argNames.join(", ")}) {${m[1]}};`);
  return factory(...depFns);
}

// ---- 单一事实源与内联兜底 ----

test("防漂移：client.js 动态 import 消费 panel-logic（根治面在位）", () => {
  assert.match(clientSrc, /import\("\/dsh-keepsake\/panel\/panel-logic\.js"\)/, "client.js 必须动态加载自供 panel-logic 模块");
  assert.match(clientSrc, /LOGIC \? LOGIC\.ladderNoteOf/, "ladderNoteOf 必须经 panel-logic 优先分发");
  assert.match(clientSrc, /LOGIC \? LOGIC\.decideLadderTier/, "decideLadderTier 必须经 panel-logic 优先分发");
  assert.match(clientSrc, /LOGIC\.collectThemeVarsFromDoc\(document\)/, "主题收集必须优先消费 collectThemeVarsFromDoc");
});

test("防漂移：梯子文案兜底 ladderNoteFallback 与 ladderNoteOf 输出逐字一致", () => {
  const fn = extractFactoryFn(clientSrc, "ladderNoteFallback", 'tier, reason = ""');
  for (const [tier, reason] of [
    ["iframe", ""], ["iframe", "window.open 返回空"], ["iframe", "新窗口 2 秒未回执握手"],
    ["location", ""], ["location", "iframe 加载出错"],
    ["window", ""], ["window", "r"], ["bogus-tier", "x"],
  ]) {
    assert.equal(fn(tier, reason), ladderNoteOf(tier, reason), `兜底与实现输出不一致：tier=${tier} reason=${reason}`);
  }
  // 模板锚（任何一边改文案，另一边立刻失去一致性被上一循环抓住；此处再钉模板本身）
  assert.ok(clientSrc.includes("`新窗口不可用${suffix}，已改为内嵌模式`"));
  assert.ok(clientSrc.includes("`内嵌模式不可用${suffix}，已改为跳转模式`"));
});

test("防漂移：档位决策兜底 decideLadderTierFallback 与 decideLadderTier 输出一致", () => {
  const fn = extractFactoryFn(clientSrc, "decideLadderTierFallback", "openResult, handshakeOk");
  for (const [openResult, ok] of [[null, false], [null, true], [void 0, true], [{}, true], [{}, false]]) {
    assert.equal(fn(openResult, ok), decideLadderTier(openResult, ok));
  }
});

test("防漂移：协议常量 client.js 定义侧与 panel.html 字面量侧一致", () => {
  for (const [name, lit] of [
    ["PANEL_READY_MSG", "dsh-keepsake:panel-ready"],
    ["THEME_MSG", "dsh-keepsake:theme"],
    ["PANEL_CLOSE_MSG", "dsh-keepsake:panel-close"],
  ]) {
    assert.ok(clientSrc.includes(`const ${name} = "${lit}";`), `client.js 必须以常量定义 ${name}`);
    assert.ok(panelSrc.includes(`"${lit}"`), `panel.html 必须含字面量 "${lit}"（改名必漏一边）`);
  }
});

test("防漂移：collectThemeVars 死导出保持删除（收敛，不许回潮）", () => {
  assert.ok(!clientSrc.includes("exports.collectThemeVars"), "client.js 不得再导出 collectThemeVars（零消费者的死拷贝）");
});

test("防漂移：称呼防抖常量双端一致（漂移表 #7：600ms 魔数双写收敛）", () => {
  assert.match(clientSrc, /const ADDRESS_SAVE_DEBOUNCE_MS = 600;/);
  assert.match(panelSrc, /const ADDRESS_SAVE_DEBOUNCE_MS = 600;/);
  assert.doesNotMatch(panelSrc, /\}, 600\);/, "panel.html 不得残留防抖魔数（用常量）");
});

// ---- 梯子生命周期结构钉 ----

test("结构钉：梯子代际号 + 中止检查在位", () => {
  assert.match(clientSrc, /ladderGenRef/, "代际 ref 必须存在");
  assert.match(clientSrc, /const gen = \+\+ladderGenRef\.current/, "openPanel 入口必须取新代际");
  assert.match(clientSrc, /gen !== ladderGenRef\.current \|\| !frame\.isConnected\) return/, "giveUp 必须双条件守卫（代际 + frame 连接）");
  assert.match(clientSrc, /onClick: abortLadder/, "收起按钮必须走 abortLadder（递增代际作废定时器）");
  assert.match(clientSrc, /useEffect\(\(\) => \(\) => \{ ladderGenRef\.current \+= 1; \}, \[\]\)/, "Plaque 卸载必须作废代际");
});

test("结构钉：握手消息校验 ev.source（并发两梯互不误点亮）", () => {
  assert.match(clientSrc, /ev\.source === frame\.contentWindow/, "iframe 档 ready 只认本 frame");
  assert.match(clientSrc, /ev\.source === win/, "window 档 ready 只认本窗口");
});

test("结构钉：openPanel 入口复位档位 + 清旧 iframe（双面板并存）", () => {
  assert.match(clientSrc, /iframeHostRef\.current\) iframeHostRef\.current\.innerHTML = ""/, "openPanel 必须清理旧内嵌面板");
});

// ---- [已知] 簇结构钉 ----

test("结构钉：stateError 拆槽为 pollError/actionError（poll 不得清写失败告警）", () => {
  assert.ok(!clientSrc.includes("stateError"), "不得残留混槽 stateError");
  assert.match(clientSrc, /const \[pollError, setPollError\]/);
  assert.match(clientSrc, /const \[actionError, setActionError\]/);
});

test("结构钉：请求序号防线 + 写后强刷（[已知] 轮询在途回滚）", () => {
  assert.match(clientSrc, /reqSeqRef/, "序号 ref 必须存在");
  assert.match(clientSrc, /if \(seq !== reqSeqRef\.current\) return/, "旧响应必须丢弃");
  assert.match(clientSrc, /if \(!busyRef\.current\) setMainOn/, "busy 期间不得回写开关");
});

// ---- panel.html 行为锚 ----

test("结构钉：主题桥手动断桥 + 内联清理 + 失效退路", () => {
  assert.match(panelSrc, /if \(manualTheme\) return 0;/, "bridgeApply 必须 manualTheme 早退（断桥）");
  assert.match(panelSrc, /removeProperty\(name\)/, "手动钮必须 removeProperty 清 --dsw-alias-* 内联");
  assert.match(panelSrc, /bridgeLastOk/, "桥失效退路（lastOk 标记）必须在位");
});

test("结构钉：确认弹窗栈式（不覆写下层对话框）", () => {
  assert.match(panelSrc, /dialogHost\.appendChild\(layer\)/, "confirmDialog 必须 append 独立层");
  assert.doesNotMatch(
    panelSrc.slice(panelSrc.indexOf("function confirmDialog"), panelSrc.indexOf("function entryCard")),
    /dialogHost\.innerHTML = ""/,
    "confirmDialog 内不得整清 dialogHost（会毁掉下层源码模式编辑框）",
  );
});

test("结构钉：长度上限可见化（双端）", () => {
  assert.match(clientSrc, /const ADDRESS_MAX_LEN = 40;/, "门牌称呼上限常量");
  assert.match(clientSrc, /maxLength: ADDRESS_MAX_LEN/, "门牌称呼输入必须 maxLength");
  assert.match(panelSrc, /maxlength="40"/, "面板称呼输入必须 maxlength=40");
  assert.match(panelSrc, /const ENTRY_MAX_CHARS = 20000;/, "条目字符上限常量");
  assert.match(panelSrc, /maxlength="\$\{ENTRY_MAX_CHARS\}"/, "编辑/新增正文必须 maxlength");
  assert.match(panelSrc, /validateEntryDraft\(/, "保存前必须走草稿预检（必填/字符/字节）");
});

// ---- 提取管道可观测（门牌红条两行制 + 双端一致） ----

test("防漂移：提取可观测纯函数经 panel-logic 优先分发（消费分发锚）", () => {
  assert.match(clientSrc, /LOGIC \? LOGIC\.extractionStreakOf/, "streak 归一必须经 panel-logic 优先分发");
  assert.match(clientSrc, /LOGIC \? LOGIC\.extractionNoticeText/, "红条文案必须经 panel-logic 优先分发");
  assert.match(clientSrc, /LOGIC \? LOGIC\.extractionRangeText/, "错过区间文案必须经 panel-logic 优先分发");
});

test("防漂移：streak 归一兜底 extractionStreakOfFallback 与实现一致（含旧数字形态）", () => {
  const fn = extractFactoryFn(clientSrc, "extractionStreakOfFallback", "efRaw");
  for (const c of [null, void 0, 0, 3, "5", { streak: 0 }, { streak: 1 }, { streak: 10 }, {}]) {
    assert.equal(fn(c), extractionStreakOf(c), `兜底与实现输出不一致：${JSON.stringify(c)}`);
  }
});

test("防漂移：红条文案兜底 extractionNoticeTextFallback 与实现表驱动一致（streak 0/1/10、字段缺失、旧数字形态）", () => {
  const fn = extractFactoryFn(clientSrc, "extractionNoticeTextFallback", "efRaw");
  const cases = [
    null, void 0, 0, 3, // 旧数字形态
    { streak: 0 }, { streak: 1 }, { streak: 10 },
    { streak: 0, recent: [] },
    { streak: 3, streakReason: "llm-error" }, // 旧对象形态（无 recent）
    { streak: 3, recent: [] },
    { streak: 3, recent: [{ reason: "llm-error", model: "group/chat-model", message: "429" }] },
    { streak: 1, recent: [{ reason: "io-error" }] },
    { streak: 2, recent: [{ model: "a/b" }] },
    { streak: 2, recent: [], streakReason: "parse-error" },
  ];
  for (const c of cases) {
    assert.equal(fn(c), extractionNoticeText(c), `兜底与实现输出不一致：${JSON.stringify(c)}`);
  }
  // 模板锚（任何一边改文案，另一边立刻失去一致性被上一循环抓住；此处再钉模板本身）
  assert.ok(clientSrc.includes("`自动提取失败 ${streak} 次 · 最近：${reason}（${model}）`"));
  assert.ok(clientSrc.includes("`记忆自动提取最近连续失败 ${streak} 次，期间对话内容可能未被记录——可在记忆管理面板复制诊断信息（含 /state 快照）反馈给开发者。`"));
});

test("防漂移：错过区间兜底 extractionRangeTextFallback 与实现表驱动一致", () => {
  const fn = extractFactoryFn(clientSrc, "extractionRangeTextFallback", "efRaw, range");
  const cases = [
    [null, null], [null, { from: 473 }],
    [{ streak: 0 }, { from: 473 }],
    [{ streak: 1 }, null], [{ streak: 1 }, {}],
    [{ streak: 3 }, { from: 473, to: 478 }],
    [{ streak: 3 }, { from: "x" }], [{ streak: 3 }, "473"],
    [2, { from: 10 }],
  ];
  for (const [ef, range] of cases) {
    assert.equal(fn(ef, range), extractionRangeText(ef, range), `兜底与实现输出不一致：${JSON.stringify([ef, range])}`);
  }
  assert.ok(clientSrc.includes("`第 ${from} 轮对话之后的内容尚未记录，恢复后自动补提`"));
});

test("结构钉：门牌红条两行制 + 详情深链 + 恢复一次性提示", () => {
  assert.match(clientSrc, /openPanel\("#\/settings"\)/, "「详情」必须 openPanel 深链 #/settings（三档梯子同带）");
  assert.match(clientSrc, /extractionRangeText\(efRaw, state\.lastFailedRange\)/, "行2 错过区间消费 state.lastFailedRange");
  assert.match(clientSrc, /lastStreakRef/, "「红条从有到无」判断沿必须存 ref");
  assert.match(clientSrc, /提取已恢复/, "恢复一次性提示文案在位");
  assert.match(clientSrc, /typeof hash === "string"/, "openPanel 深链参数必须防 React 事件对象误入");
});

// ---- 面板健康卡结构钉 ----

test("结构钉：面板健康卡消费 panel-logic + data-pipe-health 锚（消费锚）", () => {
  assert.match(panelSrc, /L\.extractionNoticeText\(/, "健康卡红态 headline 必须走共享文案纯函数");
  assert.match(panelSrc, /L\.abandonedNoticeText\(/, "已放弃区间提示必须接线渲染（不接线=放弃留痕白做）");
  assert.match(panelSrc, /L\.pipeHealthLevel\(/, "三态判定必须走纯函数");
  assert.match(panelSrc, /L\.modelShortName\(/, "模型短名必须走纯函数");
  assert.match(panelSrc, /L\.relativeTimeOf\(/, "相对时间必须走纯函数");
  assert.match(panelSrc, /L\.extractionStreakOf\(/, "streak 归一必须走纯函数");
  assert.match(panelSrc, /L\.diagnosticTextOf\(/, "复制诊断必须走纯函数组装");
  assert.match(panelSrc, /id = "data-pipe-health"/, "健康卡锚点 id 在场（深链滚动目标）");
  assert.match(panelSrc, /宿主版本较旧，未提供失败详情/, "旧服务端文案在位（旧版宿主）");
  assert.match(panelSrc, /extraction-errors\.log/, "失败日志路径行在位（路径展示）");
  assert.match(panelSrc, /title="\$\{esc\(msg\)\}"/, "recent[].message 不可信——全量必须进 title 且过 esc()");
  assert.match(panelSrc, /msg\.length > 60 \? msg\.slice\(0, 60\)/, "message 摘要截 60 字符");
});

test("结构钉：立即重试三段式——retry 只在 click handler、busy disabled、轮询只 GET state", () => {
  const hits = panelSrc.match(/extract\/retry/g) ?? [];
  assert.equal(hits.length, 1, "extract/retry 全文件只允许出现一次（确认弹窗 onConfirm 内）——轮询路径绝不调 retry");
  const clickIdx = panelSrc.indexOf('retryBtn.addEventListener("click"');
  const retryIdx = panelSrc.indexOf("extract/retry");
  assert.ok(clickIdx >= 0 && retryIdx > clickIdx, "retry 调用必须位于重试按钮 click handler 内");
  assert.match(panelSrc, /retryBtn\.disabled = true/, "202 后按钮 busy disabled");
  assert.match(panelSrc, /retryBtn\.textContent = "提取中…"/, "busy 文案「提取中…」");
  assert.match(panelSrc, /toast\("提取已恢复"\)/, "streak 清零才 toast 成功（禁同步假承诺）");
  assert.match(panelSrc, /等待超时：重试后仍未恢复/, "超时文案如实说「可能仍在进行」");
  assert.match(panelSrc, /setTimeout\(poll, 2000\)/, "2s 轮询节奏");
  assert.match(panelSrc, /retryPollWindowMs\(data\)/, "轮询窗口必须按契约推导（非硬编码 60s）");
  assert.match(panelSrc, /10 \* 60_000, Math\.max\(60_000, timeoutMs \* n\)/, "窗口夹在 [60s, 10min]"); 
  assert.match(panelSrc, /extractionRetryAttempts/, "窗口消费契约新增 extractionRetryAttempts");
  assert.match(panelSrc, /extractionTimeoutMs/, "窗口消费契约新增 extractionTimeoutMs");
});

// ---- 面板 UI 体验批行为锚 ----

test("结构钉：错误类 toast 延长至 8s + 关闭按钮 + 最近错误回看区", () => {
  assert.match(panelSrc, /const RECENT_ERRORS_MAX = 5;/, "最近错误保留 5 条");
  assert.match(panelSrc, /isErr \? 8000 : 3200/, "错误类延长至 8s（读得完），成功类维持短时");
  assert.match(panelSrc, /toastClose/, "toast 关闭按钮在位");
  assert.match(panelSrc, /id="recentErrors"/, "最近错误回看区锚点在场");
  assert.match(panelSrc, /el\.setAttribute\("aria-live", isErr \? "assertive" : "polite"\)/, "错误用 assertive、其余 polite");
});

test("结构钉：最近错误回看区文本必须过 esc()（XSS 防线，删掉即红）", () => {
  // renderRecentErrors 用 innerHTML 拼字符串——at/text 皆不可信，两处都必须 esc()，
  // 缺任一处即为可注入的 XSS 缺口（本批补钉子）。
  const renderBody = panelSrc.slice(
    panelSrc.indexOf("function renderRecentErrors()"),
    panelSrc.indexOf("function toast("),
  );
  assert.match(renderBody, /esc\(it\.at\)/, "最近错误的时间戳必须 esc()");
  assert.match(renderBody, /esc\(it\.text\)/, "最近错误的文案必须 esc()");
});

test("结构钉：坏时间戳不渲染「null 天后过期」——recentExpireDays 为 null 时整段徽标省略", () => {
  assert.match(panelSrc, /const expireDays = L\.recentExpireDays\(/, "过期天数先取值再判定");
  assert.match(
    panelSrc,
    /expireDays === null \? "" : ` · \$\{expireDays\} 天后过期`/,
    "expireDays 为 null（坏时间戳）时不渲染「天后过期」字样，避免印出「null 天后过期」",
  );
});

test("结构钉：api() 报错优先取后端 message（fallback 到 error）", () => {
  assert.match(panelSrc, /throw new Error\(body\.message \|\| body\.error/, "优先展示中文 message，回落错误码");
});

test("结构钉：危险/耗时按钮 busy 态（保存人设/导出/清空/恢复）", () => {
  assert.match(panelSrc, /saveBtn\.disabled = true; \/\/ 三段式：busy 期间禁用/, "保存人设 busy");
  assert.match(panelSrc, /saveBtn\.textContent = "处理中…"/, "保存人设 busy 文案");
  assert.match(panelSrc, /exportBtn\.disabled = true; exportBtn\.textContent = "处理中…"/, "导出全部 busy");
  assert.match(panelSrc, /clearAllBtn\.disabled = true; clearAllBtn\.textContent = "处理中…"/, "清空全部 busy");
  assert.match(panelSrc, /btn\.disabled = true; btn\.textContent = "处理中…";[\s\S]{0,80}backup\/restore/, "备份恢复 busy");
  assert.match(panelSrc, /btn\.disabled = true; btn\.textContent = "处理中…";[\s\S]{0,80}snapshots\/restore/, "快照恢复 busy");
  assert.match(panelSrc, /keepBtn\.disabled = true; keepBtn\.textContent = "处理中…"/, "保留策略保存 busy");
});

test("结构钉：人设预设覆盖未保存内容要确认 + 新增/源码取消丢草稿确认", () => {
  assert.match(panelSrc, /覆盖未保存内容？/, "预设覆盖确认标题在位");
  assert.match(panelSrc, /const isDirty = \(\) => editor\.value !== savedContent;/, "未保存判定");
  assert.match(panelSrc, /放弃未保存内容？/, "取消丢草稿确认标题在位");
  assert.match(panelSrc, /const dirty = \$t\.value\.trim\(\)\.length > 0/, "新增弹窗取消前的非空判定");
  assert.match(panelSrc, /const changed = dialogHost\.querySelector\("\[data-src\]"\)\.value !== original;/, "源码模式取消前比对原内容");
});

test("结构钉：嵌入表单缺省预填 embeddingConfig + API Key 不预填明文", () => {
  assert.match(panelSrc, /const entryCfg = data\.embeddingConfig/, "读契约新增 embeddingConfig");
  assert.match(panelSrc, /baseUrl: \(eff && eff\.baseUrl\) \|\| entryCfg\.baseUrl \|\| ""/, "端点预填回落 entry config");
  assert.match(panelSrc, /model: \(eff && eff\.model\) \|\| entryCfg\.model \|\| ""/, "模型预填回落 entry config");
  assert.match(panelSrc, /if \(q\("embApiKey"\)\.value\.length > 0\) out\.apiKey/, "Key 仅非空时提交（口径不变）");
});

test("结构钉：设置页保留策略三输入 + 正整数预检 + PUT /settings", () => {
  assert.match(panelSrc, /id="card-retention"/, "保留策略卡在场");
  assert.match(panelSrc, /id="keepTrashDays"/, "回收站保留天数输入");
  assert.match(panelSrc, /id="keepSurgical"/, "快照保留份数输入");
  assert.match(panelSrc, /id="keepRecentDays"/, "近期动态保留天数输入");
  assert.match(panelSrc, /if \(s\.trashKeepDays != null\) \$td\.value = String\(s\.trashKeepDays\)/, "预填 trashKeepDays");
  assert.match(panelSrc, /if \(s\.recentKeepDays != null\) \$rd\.value = String\(s\.recentKeepDays\)/, "预填 recentKeepDays（契约新增）");
  assert.match(panelSrc, /回收站保留天数必须是不小于 0 的整数/, "回收站天数前端预检");
  assert.match(panelSrc, /快照保留份数必须是正整数/, "快照份数前端预检");
  assert.match(panelSrc, /await apiPut\("settings", patch\)/, "保存走 PUT /settings");
});

test("结构钉：近期动态过期天数传 recentKeepDays + 分类页搜索 + query 保留", () => {
  assert.match(panelSrc, /L\.recentExpireDays\(e\.timestamp, keepDays\)/, "过期天数按保留策略传参（非写死 30）");
  assert.match(panelSrc, /function recentKeepDaysOf\(st\)/, "保留天数 tolerant 取值");
  assert.match(panelSrc, /async function renderCategoryPage\(cat, title, query = "", pageIndex = 0\)/, "分类页带检索词与页码参数（参数名 pageIndex，不得遮蔽页面容器）");
  assert.match(panelSrc, /\$q\.value = query; \/\/ reload 后保留并回填检索词/, "长/分类页 reload 回填 query");
  assert.match(panelSrc, /没有匹配「\$\{esc\(q\)\}」的条目/, "搜索无命中回显 query");
});

test("结构钉：列表分页（pageSize 50 + 越界回落 + 检索词/页码保留 + seq 竞态守卫）", () => {
  assert.match(panelSrc, /const PAGE_SIZE = L\.PAGE_SIZE;/, "每页条数走 panel-logic 单一常量（双端同值）");
  assert.match(panelSrc, /L\.paginateOf\(entries\.length, currentPage\)/, "分页计算走纯函数（越界回落末页）");
  assert.match(panelSrc, /data-prev/, "上一页按钮锚点");
  assert.match(panelSrc, /data-next/, "下一页按钮锚点");
  assert.match(panelSrc, /L\.paginationText\(pg\)/, "分页底栏文案走纯函数");
  // 翻页保留检索词与页码（reload 后不丢上下文）
  assert.match(panelSrc, /renderCategoryPage\(cat, title, current, currentPage\)/, "分类页 reload 保留检索词与页码");
  assert.match(panelSrc, /renderLongTermPage\(current, currentPage\)/, "长期页 reload 保留检索词与页码");
  // 检索词变化时页码回落第 1 页（旧页号对新过滤结果可能越界）
  assert.match(panelSrc, /current = ev\.target\.value; currentPage = 0;/, "检索变化页码回落");
  // 竞态守卫沿用：翻页是异步渲染，连点时旧响应不得写入新页
  assert.match(panelSrc, /const seq = \+\+pageRenderSeq;/, "页面渲染序号在场");
  assert.match(panelSrc, /if \(seq !== pageRenderSeq\) return; \/\/ 旧渲染丢弃/, "分类页旧渲染丢弃");
  assert.match(panelSrc, /if \(seq !== pageRenderSeq\) return;\r?\n  const all = data\.entries/, "长期页旧渲染丢弃");
});

test("结构钉：清空全部失败列明细 + 备份列表 createdAt/未显示提示", () => {
  assert.match(panelSrc, /清空未完成——已清空：\$\{doneText\}；未清空：\$\{failText\}/, "清空失败列已清/未清分类");
  assert.match(panelSrc, /const BACKUP_LIST_LIMIT = 20;/, "备份列表硬截 20（常量）");
  assert.match(panelSrc, /还有 \$\{backups\.length - BACKUP_LIST_LIMIT\} 条未显示/, "未显示条数如实提示");
  assert.match(panelSrc, /const backupTime = \(b\) =>/, "备份时间列走 createdAt 契约");
  assert.match(panelSrc, /if \(raw == null\) return "—";/, "createdAt null 显示破折号");
});

test("结构钉：标题/描述 maxlength 实时计数", () => {
  assert.match(panelSrc, /data-tcnt/, "标题计数锚点");
  assert.match(panelSrc, /data-dcnt/, "描述计数锚点");
  assert.match(panelSrc, /\$\{ \$t\.value\.length \} \/ 60|\$\{\$t\.value\.length\} \/ 60/, "标题计数文案");
  assert.match(panelSrc, /const updTitleCnt = \(\) =>/, "标题计数更新函数");
});

test("结构钉：无障碍（侧栏 href / Esc 关窗 / 聚焦首钮 / 状态词 / corrupt 标记）", () => {
  assert.match(panelSrc, /<a href="#\/category\/work-profile" data-route="category\/work-profile">/, "侧栏锚点带 href（键盘可达）");
  assert.match(panelSrc, /if \(e\.key === "Escape"\) close\(\);/, "确认弹窗 Esc 关闭");
  assert.match(panelSrc, /cancelBtn\.focus\(\)/, "弹窗打开聚焦首个按钮");
  assert.match(panelSrc, /const statusWord = level === "green"/, "三态灯状态词在场");
  assert.match(panelSrc, /aria-label="状态：\$\{statusWord\}"/, "三态灯 aria-label");
  assert.match(panelSrc, /设置文件已损坏，已按缺省运行/, "settings.corrupt 醒目标记");
});

test("结构钉：焦点陷阱抽工具四处复用 + 卸载必调（防 document 监听泄漏）", () => {
  // 单一实现：trapFocus 在 panel-logic，四处弹窗都经 L.trapFocus 接入
  assert.match(panelSrc, /L\.trapFocus\(/, "面板必须经 L.trapFocus 接入焦点陷阱（不复写第二份）");
  const traps = panelSrc.match(/L\.trapFocus\(/g) ?? [];
  assert.equal(traps.length, 4, "四处弹窗（确认/新增/源码/导入）必须全部接入焦点陷阱");
  // 卸载纪律：每条 trapFocus 的返回值必须被某个 offFocus() 消费（弹窗关闭时摘监听）
  const offs = panelSrc.match(/offFocus\(\)/g) ?? [];
  assert.ok(offs.length >= 8, `每个 trapFocus 至少两处卸载点（取消/成功），当前 ${offs.length} 处`);
  // Tab 回卷语义由 panel-logic 单侧保证（panel-logic.test.mjs 已钉），此处只钉接线存在
  assert.match(panelSrc, /const offFocus = L\.trapFocus\(dialogHost/, "弹窗用 dialogHost 作容器接入");
});

test("结构钉：错误 toast role=alert（成功回落 status）+ aria-live 行为保持", () => {
  assert.match(panelSrc, /el\.setAttribute\("role", isErr \? "alert" : "status"\)/, "错误类 role=alert、成功回落 role=status");
  assert.match(panelSrc, /el\.setAttribute\("aria-live", isErr \? "assertive" : "polite"\)/, "aria-live 行为保持（错误 assertive、其余 polite）");
  // 静态初始值仍是 status（toast() 首次调用前读屏不报警）
  assert.match(panelSrc, /id="toast" role="status" aria-live="polite"/, "toast 静态初始 role=status");
});

test("结构钉：窄屏 @media + 文案统一 + fmtHint + 计数 0 显示 + 删除移入回收站", () => {
  assert.match(panelSrc, /@media \(max-width: 800px\)/, "窄屏媒体查询在位");
  assert.match(panelSrc, /\.split \{ grid-template-columns: 1fr; \}/, "窄屏 split 堆叠单列");
  assert.match(panelSrc, /<div class="group">记忆分类<\/div>/, "侧栏分组改名「记忆分类」");
  assert.doesNotMatch(panelSrc, /改动即时生效（下一轮对话）/, "去掉自相矛盾的即时生效文案");
  assert.match(panelSrc, /const FMT_HINTS = \{/, "导入格式说明表在位");
  // 计数 0 也显示（红徽标与 runtime 候选徽标除外——两者都是「有值才显」的告警/提示位）
  assert.match(panelSrc, /\(key === "extraction-streak"(?: \|\| key === "runtime")?\) \? \(n > 0 \? String\(n\) : ""\) : String\(n\)/, "计数 0 也显示（红徽标/runtime 徽标除外）");
  assert.match(panelSrc, /function markCountsError\(\)/, "refreshCounts 失败给提示态（不吞错）");
  assert.match(panelSrc, /将移入回收站（可在回收站找回，保留天数见设置页保留策略）/, "删除确认文案对齐移入回收站（保留天数不写死，指向设置页保留策略）");
  const delConfirm = panelSrc.slice(panelSrc.indexOf('title: "删除条目"'), panelSrc.indexOf('title: "删除条目"') + 400);
  assert.doesNotMatch(delConfirm, /默认保留 30 天/, "删除确认不再写死「默认保留 30 天」（用户改 trashKeepDays 后误导）");
  // 侧栏品牌与分组措辞错开（「记忆」字不重复）
  assert.match(panelSrc, /<div class="brand">记忆管理台<\/div>/, "品牌区措辞「记忆管理台」（与分组「记忆分类」错开）");
});

test("结构钉：删除三态判读（existed/trashed 三分支，失败不抹列表）", () => {
  assert.match(panelSrc, /L\.deleteOutcomeOf\(out\)/, "删除结果走纯函数三态判读（不内联 if 链）");
  assert.match(panelSrc, /const outcome = L\.deleteOutcomeOf\(out\);/, "三态结果先取值再分流");
  assert.match(panelSrc, /toast\(outcome\.toast, outcome\.kind === "failed" \? "err" : "ok"\)/, "三态提示按 kind 分错误/成功语气");
  assert.match(panelSrc, /if \(outcome\.reload\) reload\(\);/, "只有存在/成功态才刷新列表——失败态不抹条目");
  assert.doesNotMatch(
    panelSrc.slice(panelSrc.indexOf("data-del\"]"), panelSrc.indexOf("data-del\"]") + 700),
    /else toast\("已移入回收站/,
    "不得保留「非不存在即报成功」的旧二分支（会把删除失败谎报成成功）",
  );
});

test("结构钉：健康卡 5s 本地轮询 + 路由切走清 timer", () => {
  assert.match(panelSrc, /function stopPipePoll\(\)/, "清 timer 入口在位");
  assert.match(panelSrc, /\}, 5000\)/, "5s 轮询节奏");
  assert.match(panelSrc, /function render\(\) \{\r?\n  stopPipePoll\(\)/, "render 切路由必须先清健康卡轮询");
  assert.match(panelSrc, /pipeRetryBusy/, "手动重试在途时 5s 轮询让位");
});

test("结构钉：提取模型卡两个诚实字段 + 嵌入召回配置", () => {
  assert.match(panelSrc, /id = "data-pipe-model"/);
  assert.match(panelSrc, /未指定（跟随会话路由）/, "extractionConfig 缺失时的诚实文案");
  assert.match(panelSrc, /尚未有提取/, "lastUsedRoute 缺失时的诚实文案");
  assert.match(panelSrc, /嵌入模型（语义召回）/, "嵌入模型字段在场");
  assert.match(panelSrc, /语义召回未启用/, "未配置端点时的说明文案在场");
});

test("结构钉：设置页嵌入服务卡（面板配置嵌入端点的入口）", () => {
  assert.match(panelSrc, /id="card-embedding"/, "嵌入服务卡在场");
  assert.match(panelSrc, /id="embBaseUrl"/, "端点输入在场");
  assert.match(panelSrc, /id="embModel"/, "模型输入在场");
  assert.match(panelSrc, /id="embApiKey"/, "API Key 输入在场");
  assert.match(panelSrc, /id="embSave"/, "保存按钮在场");
  assert.match(panelSrc, /id="embTest"/, "测试连接按钮在场");
  assert.match(panelSrc, /validateEmbeddingDraft/, "面板侧校验接入");
});

test("结构钉：嵌入卡「清除已存 Key」入口（可见性走纯函数 + 载荷 apiKey:null + 保留语义）", () => {
  // 可见性：按钮渲染条件必须走共享纯函数（与 /state.embeddingEffective.apiKeySet 绑定，未设不渲染）
  assert.match(panelSrc, /L\.embeddingClearActionVisible\(data\)/, "清除按钮可见性必须走 panel-logic 纯函数");
  assert.match(panelSrc, /id="embClearKey"/, "清除按钮锚点在场");
  assert.match(panelSrc, /清除已存 Key/, "清除按钮文案在位");
  // 载荷契约：显式 apiKey:null = 服务端清空语义（区别于缺省键 = 保留）；确认后提交
  assert.match(panelSrc, /apiKey: null/, "清除载荷必须显式 apiKey:null（服务端清空语义）");
  // 保留语义：新 key 仅在输入非空时提交（apiKey 键缺省 = 服务端保留已存密钥）
  assert.match(panelSrc, /if \(q\("embApiKey"\)\.value\.length > 0\) out\.apiKey/, "非空才提交新 key（缺省=保留）");
  // 清除后刷新状态行（apiKeySet 变 false → 按钮随之消失）
  assert.match(panelSrc, /已清除已存 API Key/, "清除成功反馈文案在位");
});

test("结构钉：细节——tableScroll 滚动容器双处在场 + 长期记忆空态两态 + 三态灯点色", () => {
  assert.match(panelSrc, /\.tableScroll \{ overflow: auto/, "tableScroll 样式在位");
  const wrapped = panelSrc.match(/<div class="tableScroll"><table class="preview">/g) ?? [];
  assert.ok(wrapped.length >= 2, "导入预览表与失败详情表都必须包 tableScroll 容器");
  assert.match(panelSrc, /没有匹配「\$\{esc\(q\)\}」/, "搜索无命中回显 query（分类页/长期页共用渲染）");
  assert.match(panelSrc, /暂无长期记忆/, "库空态文案（与搜索无命中区分）");
  assert.match(panelSrc, /\.dot\.green \{ background: #50a05a; \}/, "灯点绿 #50a05a（不引新色值）");
  assert.match(panelSrc, /\.dot\.yellow \{ background: #c98a3d; \}/, "灯点黄 #c98a3d");
  assert.match(panelSrc, /\.dot\.red \{ background: #d5564d; \}/, "灯点红 #d5564d");
});

// ---- 注入面（消息通道）防漂移 ----

test("防漂移：注入面摘要兜底 injectionSummaryFallback 与实现表驱动一致（含纯失败告警 + throttled/superseded）", () => {
  const fn = extractFactoryFn(clientSrc, "injectionSummaryFallback", "injection", ["injectionExtraFallback"]);
  const cases = [
    null, void 0, {}, [], "x", // 旧版宿主/畸形：均 null
    { count: 0 }, // 未注入无异常：null
    { count: 0, lastChars: 5 }, // count=0（lastChars 无意义）：null
    { count: 0, renderFailures: 2 }, // 纯失败：仍出告警（显式可见，不静默藏）
    { count: -1, renderFailures: 0 }, // 非法 count 无异常：null
    { count: 3, lastChars: 1200 },
    { count: 3, lastChars: 1200, droppedSegments: 2 },
    { count: 3, lastChars: 1200, renderFailures: 1, droppedSegments: 1 },
    { count: "5", lastChars: "900" }, // 字符串数字归一
    // throttled / superseded 契约新增计数：零回归 + 新计数附加
    { count: 3, lastChars: 1200, throttled: 0, superseded: 0 }, // 零值不渲染
    { count: 3, lastChars: 1200, throttled: 2 },
    { count: 3, lastChars: 1200, superseded: 1 },
    { count: 3, lastChars: 1200, throttled: 2, superseded: 1 },
    { count: 3, lastChars: 1200, droppedSegments: 2, throttled: 1, superseded: 4, renderFailures: 1 },
    { count: 3, lastChars: 1200, throttled: "x", superseded: -1 }, // 脏值按 0
  ];
  for (const c of cases) {
    assert.equal(fn(c), injectionSummary(c), `兜底与实现输出不一致：${JSON.stringify(c)}`);
  }
  assert.match(clientSrc, /LOGIC \? LOGIC\.injectionSummary/, "注入摘要必须经 panel-logic 优先分发");
  assert.match(panelSrc, /L\.injectionSummary\(/, "健康卡注入摘要必须走共享纯函数（消费锚）");
  // 兜底侧的节流/取代文案模板锚（任一边改模板立刻红）
  assert.ok(clientSrc.includes("`变更节流 ${throttled} 次`"));
  assert.ok(clientSrc.includes("`取代 ${superseded} 次`"));
});

test("防漂移：注入预算兜底 injectionBudgetTextFallback 与实现表驱动一致（Y=0/缺字段→空串）", () => {
  const fn = extractFactoryFn(clientSrc, "injectionBudgetTextFallback", "injection, maxTokens");
  const cases = [
    // 正常：最近 tokens + 上限（含小数取整）
    [{ count: 3, lastTokens: 812 }, 16000],
    [{ count: 1, lastTokens: 0 }, 4096],
    [{ count: 2, lastTokens: 100.7 }, 4096.9],
    // Y=0 = 禁用 token 预算（回滚档）：不显 token 段
    [{ count: 3, lastTokens: 812 }, 0],
    [{ count: 3, lastTokens: 812 }, "0"],
    // 旧数据/缺字段容错：空串而非半截文案
    [{ count: 3 }, 16000],
    [{ count: 3, lastTokens: 812 }, void 0],
    [{ count: 3, lastTokens: 812 }, null],
    [{ count: 3, lastTokens: 812 }, -5],
    [{ count: 3, lastTokens: 812 }, "x"],
    [{ count: 0, lastTokens: 812 }, 16000],
    [{ count: "x", lastTokens: 812 }, 16000],
    [{ count: 3, lastTokens: "x" }, 16000],
    [{ count: 3, lastTokens: -1 }, 16000],
    // 畸形 injection
    [null, 16000], [void 0, 16000], ["x", 16000], [[], 16000],
  ];
  for (const [inj, max] of cases) {
    assert.equal(fn(inj, max), injectionBudgetText(inj, max), `兜底与实现输出不一致：injection=${JSON.stringify(inj)} maxTokens=${String(max)}`);
  }
  assert.match(clientSrc, /LOGIC \? LOGIC\.injectionBudgetText/, "注入预算文案必须经 panel-logic 优先分发");
  assert.match(clientSrc, /injectionBudgetText\(state\.injection, state\.injectMaxTokens\)/, "门牌消费锚：上限取 /state.injectMaxTokens");
  assert.match(panelSrc, /L\.injectionBudgetText\(data\.injection, data\.injectMaxTokens\)/, "健康卡消费锚：上限取 /state.injectMaxTokens");
  // 兜底侧的模板锚（任一边改模板立刻红）
  assert.ok(clientSrc.includes("`最近 ≈${Math.floor(last)} tokens / 上限 ${Math.floor(limit)}`"), "兜底模板锚必须逐字在位");
});

// ---- 存储格式只读告警防漂移 ----

test("防漂移：存储格式只读兜底 formatNoticeFallback 与实现表驱动一致（仅 writable=false 出文案）", () => {
  const fn = extractFactoryFn(clientSrc, "formatNoticeFallback", "format");
  const cases = [
    null, void 0, {}, [], "x", // 旧版宿主/畸形：均 null
    { formatVersion: 1, supported: true, writable: true }, // 正常：null
    { formatVersion: 1 }, // 无 writable 字段（语义=可写）：null
    { formatVersion: 2, supported: false, writable: false }, // 只读：出文案（含版本号）
    { writable: false }, // 版本缺失：回退"更高版本"
    { formatVersion: "3", writable: false }, // 字符串数字归一
  ];
  for (const c of cases) {
    assert.equal(fn(c), formatNoticeText(c), `兜底与实现输出不一致：${JSON.stringify(c)}`);
  }
  assert.match(clientSrc, /LOGIC \? LOGIC\.formatNoticeText/, "只读告警必须经 panel-logic 优先分发");
  assert.match(panelSrc, /L\.formatNoticeText\(/, "健康卡只读告警必须走共享纯函数（消费锚）");
});

// ---- 面板新面接线锚（补提 / 记忆整理 / 设置健康 / 绿红优先级）----

test("结构钉：补提 UI 接线（GET /sessions/pending + POST /sessions/recover + busy 三段式 + 轮询）", () => {
  assert.match(panelSrc, /api\("sessions\/pending"\)/, "补提清单必须拉 pending 端点");
  assert.match(panelSrc, /apiPost\("sessions\/recover"/, "补提动作必须 POST recover 端点");
  assert.match(panelSrc, /L\.pendingItemLabel\(it\)/, "行文案走纯函数（不露 seq、人话标签）");
  assert.match(panelSrc, /btn\.textContent = L\.PENDING_RECOVERING_TEXT/, "补提按钮 busy 文案走常量");
  assert.match(panelSrc, /out2\.started === true/, "202 后必须确认 started 才进轮询（不空承诺）");
  assert.match(panelSrc, /retryPollWindowMs\(state\)/, "轮询窗口复用提取超时口径（不硬编码）");
  assert.match(panelSrc, /setTimeout\(poll, 2000\)/, "补提轮询 2s 节奏");
  assert.match(panelSrc, /L\.PENDING_UNAVAILABLE_NOTE/, "会话不可读时如实说明（不空承诺重开后自动续提）");
  assert.match(panelSrc, /const avail = it && it\.sessionAvailable === true;/, "仅 sessionAvailable 才渲染可点按钮");
  assert.match(panelSrc, /L\.pendingHostNote\(/, "hostSupported=false 出整块说明");
  assert.match(panelSrc, /stopPendingPoll\(\)/, "路由切走清补提轮询 timer");
});

test("结构钉：记忆整理 UI 接线（suggestions 三组 + repair-index busy + 回显）", () => {
  assert.match(panelSrc, /api\("maintenance\/suggestions"\)/, "记忆整理必须拉 suggestions 端点");
  assert.match(panelSrc, /apiPost\("maintenance\/repair-index"\)/, "修复索引必须 POST repair-index 端点");
  assert.match(panelSrc, /L\.maintenanceSuggestionsEmpty\(suggestions\)/, "空态判定走纯函数（暂无建议）");
  assert.match(panelSrc, /L\.duplicateScorePct\(d && d\.score\)/, "重复建议 score 百分比走纯函数");
  assert.match(panelSrc, /L\.staleDaysText\(it\)/, "久未更新天数走纯函数（unknown-age 如实说）");
  assert.match(panelSrc, /L\.INDEX_HEALTH_COLUMNS\.map/, "索引健康三列走常量表");
  assert.match(panelSrc, /L\.repairIndexResultText\(out\)/, "修复回显走纯函数（fixed / 无需修复）");
  assert.match(panelSrc, /btn\.textContent = "修复中…"/, "修复按钮 busy 文案");
  assert.match(panelSrc, /data-retry/, "加载失败可重试");
  assert.match(panelSrc, /重复项需要你自己决定留哪条——这里不自动合并/, "只提示不自动合并");
});

test("结构钉：记忆整理卡不可信内容渲染必须过 esc()（XSS 防线，删掉即红）", () => {
  // innerHTML 拼接的字段（重复建议 d.why/d.a/d.b、久未更新 it.*、索引健康 it.*、
  // 空分类字符串项、修复明细回显）皆不可信，缺任一 esc() 即为可注入缺口（本批补钉子）。
  assert.match(panelSrc, /esc\(d && d\.why\)/, "重复建议判断依据必须 esc()");
  assert.match(panelSrc, /esc\(d && d\.a\)/, "重复建议条目 a 必须 esc()");
  assert.match(panelSrc, /esc\(d && d\.b\)/, "重复建议条目 b 必须 esc()");
  assert.match(panelSrc, /esc\(it && it\.name\)/, "久未更新/索引健康条目名必须 esc()");
  assert.match(panelSrc, /esc\(it && it\.category\)/, "久未更新/索引健康分类必须 esc()");
  assert.match(panelSrc, /esc\(it\.line\)/, "索引健康悬挂行原文必须 esc()");
  // 空分类是分类 id 字符串数组：字符串项按 esc(it) 渲染（删掉即红）
  assert.match(panelSrc, /typeof it === "string"[\s\S]{0,80}esc\(it\)/, "空分类字符串项必须 esc()");
  // 修复明细回显含分类名：必须过 esc()
  assert.match(panelSrc, /result\.innerHTML = esc\(text\)/, "修复明细回显必须 esc()");
});

test("结构钉：设置健康黄条接线（coercedFields 非空渲染 / 空摘除）", () => {
  assert.match(panelSrc, /L\.settingsCoercionNote\(data && data\.settingsDiagnostics\)/, "coercedFields 消费走纯函数");
  assert.match(panelSrc, /id = "data-settings-health"/, "设置健康黄条锚点");
  assert.match(panelSrc, /if \(healthCard\) healthHost\.replaceWith\(healthCard\);/, "非空才渲染黄条");
  assert.match(panelSrc, /else healthHost\.remove\(\);/, "空则整块摘除（不留空位）");
  assert.match(panelSrc, /data-settingsHealth/, "设置健康占位锚在场");
});

test("结构钉：健康卡状态优先级（绿红并置修正——有未恢复/已放弃禁显绿行）", () => {
  assert.match(panelSrc, /const priority = L\.healthPriorityLevel\(data\);/, "优先级判定走纯函数");
  assert.match(panelSrc, /const allowGreenLine = L\.canShowNoFailureLine\(priority\);/, "绿行许可走纯函数");
  assert.match(panelSrc, /if \(level === "green" && allowGreenLine\) \{/, "绿行仅在允许时渲染（并置修正）");
  assert.match(panelSrc, /allowGreenLine \? "正常" : L\.healthPriorityWord\(priority\)/, "状态词随优先级改口");
  assert.match(panelSrc, /const statusCls = level === "green" && !allowGreenLine \? "yellow" : dotCls;/, "灯色随优先级降级（颜色第二编码）");
  assert.doesNotMatch(panelSrc, /重启以来无失败/, "旧「重启以来无失败」让步文案已删除（改真优先级）");
});

test("结构钉：记忆整理卡锚点（data-maintenance）+ 设置页装配", () => {
  assert.match(panelSrc, /id = "data-maintenance"/, "记忆整理卡锚点在场");
  assert.match(panelSrc, /page\.querySelector\("\[data-maintenance\]"\)\.replaceWith\(buildMaintenanceCard\(\)\)/, "设置页装配记忆整理卡");
  assert.match(panelSrc, /id = "data-pending-recover"/, "补提卡锚点在场");
  assert.match(panelSrc, /data-pendingRecover/, "健康卡内补提占位锚在场");
});

test("结构钉：页面容器不得被参数遮蔽（页码参数名固定 pageIndex）", () => {
  // 病史：分页改造把列表页的页码参数命名为 page，遮蔽模块级 const page = $("page")（页面容器），
  // page.innerHTML 打在数字上，两个列表页整页渲染当场抛死。签名与容器绑定分开钉住。
  assert.match(panelSrc, /const page = \$\("page"\)/, "页面容器绑定在场");
  assert.match(panelSrc, /renderCategoryPage\(cat, title, query = "", pageIndex = 0\)/, "分类页页码参数名 pageIndex");
  assert.match(panelSrc, /renderLongTermPage\(query = "", pageIndex = 0\)/, "长期记忆页页码参数名 pageIndex");
  const shadowing = panelSrc.match(/function\s+[A-Za-z0-9_$]+\s*\([^)]*\bpage\s*=/g) || [];
  assert.deepEqual(shadowing, [], "不得出现名为 page 的函数参数（会遮蔽页面容器）");
});

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
  injectionSummary,
  formatNoticeText,
  ladderNoteOf,
} from "../lib/panel-logic.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientSrc = readFileSync(path.join(root, "lib", "client.js"), "utf8");
const panelSrc = readFileSync(path.join(root, "web", "panel.html"), "utf8");

/** 从 client.js factory（4 空格缩进）提取指定内联兜底函数体并求值。
 *  锚定「行首恰好 4 空格的 }」为函数结束（体内 if 块为 6 空格缩进，不会误配）。 */
function extractFactoryFn(src, name, params) {
  const re = new RegExp(`^ {4}function ${name}\\(${params}\\) \\{([\\s\\S]*?)\\n {4}\\}$`, "m");
  const m = src.match(re);
  assert.ok(m, `client.js 必须保留内联兜底 ${name}（动态 import 失败的退路）`);
  return new Function(...params.split(",").map((p) => p.trim().split("=")[0].trim()), m[1]);
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
  assert.ok(clientSrc.includes("`记忆自动提取最近连续失败 ${streak} 次，期间对话内容可能未被记录——请检查服务端日志。`"));
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
  assert.ok(clientSrc.includes("`seq ${from} 之后的轮次尚未记录，恢复后自动补提`"));
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
  assert.match(panelSrc, /重试后仍未恢复，查看失败详情/, "60s 超时文案");
  assert.match(panelSrc, /setTimeout\(poll, 2000\)/, "2s 轮询节奏");
  assert.match(panelSrc, /Date\.now\(\) \+ 60000/, "轮询上限 60s");
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
  assert.match(panelSrc, /没有匹配「\$\{esc\(query\)\}」/, "搜索无命中回显 query");
  assert.match(panelSrc, /暂无长期记忆/, "库空态文案（与搜索无命中区分）");
  assert.match(panelSrc, /\.dot\.green \{ background: #50a05a; \}/, "灯点绿 #50a05a（不引新色值）");
  assert.match(panelSrc, /\.dot\.yellow \{ background: #c98a3d; \}/, "灯点黄 #c98a3d");
  assert.match(panelSrc, /\.dot\.red \{ background: #d5564d; \}/, "灯点红 #d5564d");
});

// ---- 注入面（消息通道）防漂移 ----

test("防漂移：注入面摘要兜底 injectionSummaryFallback 与实现表驱动一致（含纯失败告警）", () => {
  const fn = extractFactoryFn(clientSrc, "injectionSummaryFallback", "injection");
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
  ];
  for (const c of cases) {
    assert.equal(fn(c), injectionSummary(c), `兜底与实现输出不一致：${JSON.stringify(c)}`);
  }
  assert.match(clientSrc, /LOGIC \? LOGIC\.injectionSummary/, "注入摘要必须经 panel-logic 优先分发");
  assert.match(panelSrc, /L\.injectionSummary\(/, "健康卡注入摘要必须走共享纯函数（消费锚）");
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

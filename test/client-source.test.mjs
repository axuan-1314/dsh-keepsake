// client.js / panel.html 防漂移检查（U-DRI1 短平快第一步 + 各修复的结构钉）。
//   源码 grep 型 + 兜底函数提取执行对比：lib/client.js 的内联兜底、web/panel.html 的
//   协议字面量与行为锚点，任何一边改动立刻红——防止"检查测的是没被消费的那份"。
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decideLadderTier, ladderNoteOf } from "../lib/panel-logic.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientSrc = readFileSync(path.join(root, "lib", "client.js"), "utf8");
const panelSrc = readFileSync(path.join(root, "web", "panel.html"), "utf8");

/** 从 client.js factory（4 空格缩进）提取指定内联兜底函数体并求值。
 *  锚定「行首恰好 4 空格的 }」为函数结束（体内 if 块为 6 空格缩进，不会误配）。 */
function extractFactoryFn(src, name, params) {
  const re = new RegExp(`^ {4}function ${name}\\(${params}\\) \\{([\\s\\S]*?)\\n {4}\\}$`, "m");
  const m = src.match(re);
  assert.ok(m, `client.js 必须保留内联兜底 ${name}（U-DRI1：动态 import 失败的退路）`);
  return new Function(...params.split(",").map((p) => p.trim().split("=")[0].trim()), m[1]);
}

// ---- U-DRI1：单一事实源与内联兜底 ----

test("防漂移：client.js 动态 import 消费 panel-logic（U-DRI1 根治面在位）", () => {
  assert.match(clientSrc, /import\("\/dsh-memory\/panel\/panel-logic\.js"\)/, "client.js 必须动态加载自供 panel-logic 模块");
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
    ["PANEL_READY_MSG", "dsh-memory:panel-ready"],
    ["THEME_MSG", "dsh-memory:theme"],
    ["PANEL_CLOSE_MSG", "dsh-memory:panel-close"],
  ]) {
    assert.ok(clientSrc.includes(`const ${name} = "${lit}";`), `client.js 必须以常量定义 ${name}`);
    assert.ok(panelSrc.includes(`"${lit}"`), `panel.html 必须含字面量 "${lit}"（改名必漏一边）`);
  }
});

test("防漂移：collectThemeVars 死导出保持删除（U-DRI1 收敛，不许回潮）", () => {
  assert.ok(!clientSrc.includes("exports.collectThemeVars"), "client.js 不得再导出 collectThemeVars（零消费者的死拷贝）");
});

test("防漂移：称呼防抖常量双端一致（漂移表 #7：600ms 魔数双写收敛）", () => {
  assert.match(clientSrc, /const ADDRESS_SAVE_DEBOUNCE_MS = 600;/);
  assert.match(panelSrc, /const ADDRESS_SAVE_DEBOUNCE_MS = 600;/);
  assert.doesNotMatch(panelSrc, /\}, 600\);/, "panel.html 不得残留防抖魔数（用常量）");
});

// ---- U-LAD1 / P3-2 / P3-3：梯子生命周期结构钉 ----

test("结构钉：梯子代际号 + 中止检查在位（U-LAD1）", () => {
  assert.match(clientSrc, /ladderGenRef/, "代际 ref 必须存在");
  assert.match(clientSrc, /const gen = \+\+ladderGenRef\.current/, "openPanel 入口必须取新代际");
  assert.match(clientSrc, /gen !== ladderGenRef\.current \|\| !frame\.isConnected\) return/, "giveUp 必须双条件守卫（代际 + frame 连接）");
  assert.match(clientSrc, /onClick: abortLadder/, "收起按钮必须走 abortLadder（递增代际作废定时器）");
  assert.match(clientSrc, /useEffect\(\(\) => \(\) => \{ ladderGenRef\.current \+= 1; \}, \[\]\)/, "Plaque 卸载必须作废代际");
});

test("结构钉：握手消息校验 ev.source（P3-3 并发两梯互不误点亮）", () => {
  assert.match(clientSrc, /ev\.source === frame\.contentWindow/, "iframe 档 ready 只认本 frame");
  assert.match(clientSrc, /ev\.source === win/, "window 档 ready 只认本窗口");
});

test("结构钉：openPanel 入口复位档位 + 清旧 iframe（P3-2 双面板并存）", () => {
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

// ---- U-THE1 / panel.html 行为锚 ----

test("结构钉：主题桥手动断桥 + 内联清理 + 失效退路（U-THE1）", () => {
  assert.match(panelSrc, /if \(manualTheme\) return 0;/, "bridgeApply 必须 manualTheme 早退（断桥）");
  assert.match(panelSrc, /removeProperty\(name\)/, "手动钮必须 removeProperty 清 --dsw-alias-* 内联");
  assert.match(panelSrc, /bridgeLastOk/, "桥失效退路（lastOk 标记）必须在位");
});

test("结构钉：确认弹窗栈式（P3-5 不覆写下层对话框）", () => {
  assert.match(panelSrc, /dialogHost\.appendChild\(layer\)/, "confirmDialog 必须 append 独立层");
  assert.doesNotMatch(
    panelSrc.slice(panelSrc.indexOf("function confirmDialog"), panelSrc.indexOf("function entryCard")),
    /dialogHost\.innerHTML = ""/,
    "confirmDialog 内不得整清 dialogHost（会毁掉下层源码模式编辑框）",
  );
});

test("结构钉：长度上限可见化（U-TRU1 / P3-12 双端）", () => {
  assert.match(clientSrc, /const ADDRESS_MAX_LEN = 40;/, "门牌称呼上限常量");
  assert.match(clientSrc, /maxLength: ADDRESS_MAX_LEN/, "门牌称呼输入必须 maxLength");
  assert.match(panelSrc, /maxlength="40"/, "面板称呼输入必须 maxlength=40");
  assert.match(panelSrc, /const ENTRY_MAX_CHARS = 20000;/, "条目字符上限常量");
  assert.match(panelSrc, /maxlength="\$\{ENTRY_MAX_CHARS\}"/, "编辑/新增正文必须 maxlength");
  assert.match(panelSrc, /validateEntryDraft\(/, "保存前必须走草稿预检（必填/字符/字节）");
});

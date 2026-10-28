// 内嵌模式（iframe 档）检查 —— 2026-10-26 内嵌 UI 优化的结构钉。
//
// 为什么单独一组：这批改动的正当性建立在「独立窗口档零影响」上，
// 而 client-source / panel-drift / panel-logic 三个既有套件对 dsk-embedded
// 相关面零命中——八个变异实验（回退注入）全部全绿，说明当时没有任何断言兜底。
// 本文件把这些「删了会真坏、改了不该生效」的地方钉住。
//
// 分工：源码 grep 型（本仓既有惯例），不跑浏览器。几何真值另有真实环境实测
// （745×392 iframe，2026-10-26），此处只钉「实现面在位且不外溢」。
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientSrc = readFileSync(path.join(root, "lib", "client.js"), "utf8");
const panelSrc = readFileSync(path.join(root, "web", "panel.html"), "utf8");

/** 取 panel.html 一份脚本正文（内联同步脚本按 index 取，module 取 <script type="module">）。 */
function moduleScript(src) {
  const m = src.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, "panel.html 必须有 <script type=\"module\"> 段");
  return m[1];
}

// ---- 一、内嵌探测：必须在 module 之前同步加上 class（防首屏闪一帧） ----

test("内嵌探测：<body> 后有同步内联脚本先加 dsk-embedded（早于 module import）", () => {
  const moduleAt = panelSrc.indexOf('<script type="module">');
  const inlineAt = panelSrc.indexOf("window.self !== window.top");
  assert.ok(moduleAt > 0, "module 段必须在位");
  assert.ok(inlineAt > 0 && inlineAt < moduleAt, "内嵌探测必须出现在 module 段之前（否则按非内嵌先渲染一帧）");
  // 内联脚本必须在 body 打开之后（能拿到 document.body）
  const bodyAt = panelSrc.indexOf("<body>");
  assert.ok(bodyAt > 0 && inlineAt > bodyAt, "探测脚本必须在 <body> 之后");
  // 异常退路：跨域取 window.top 抛 SecurityError 时按内嵌处理（保守）
  const inlineBlock = panelSrc.slice(bodyAt, moduleAt);
  assert.match(inlineBlock, /catch[^{]*\{[^}]*classList\.add\("dsk-embedded"\)/, "跨域异常时也必须按内嵌处理（catch 分支加 class）");
});

test("内嵌探测：module 侧保留幂等兜底 classList.add", () => {
  const body = moduleScript(panelSrc);
  assert.match(body, /const EMBEDDED = \(\(\) => \{ try \{ return window\.self !== window\.top; \} catch \(e\) \{ return true; \} \}\)\(\)/, "EMBEDDED 常量必须保留（JS 分档全靠它）");
  assert.match(body, /if \(EMBEDDED\) document\.body\.classList\.add\("dsk-embedded"\)/, "module 侧必须有幂等兜底 add（防内联脚本被误删）");
});

// ---- 二、内嵌特化：每条规则必须挂 body.dsk-embedded（不得外溢到全局） ----

test("内嵌特化：正文滚动面在位（main 可滚 + page 自滚 + 顶栏 sticky）", () => {
  assert.match(panelSrc, /body\.dsk-embedded main \{ min-height: 0; overflow-y: auto; \}/,
    "main 必须 overflow-y:auto——overflow:hidden 下提示区叠满会把 #page 挤出盒子且无任何滚动路径");
  assert.match(panelSrc, /body\.dsk-embedded \.topbar \{ position: sticky; top: 0; z-index: 2; \}/,
    "顶栏必须 sticky（main 兜底滚动时顶栏不跟着走）");
  assert.match(panelSrc, /body\.dsk-embedded #page \{ flex: 1; min-height: 0; overflow-y: auto; \}/,
    "#page 必须自滚（只有正文滚，侧栏顶栏钉死）");
  assert.match(panelSrc, /body\.dsk-embedded #recentErrors \{ max-height: 25vh; overflow-y: auto; \}/,
    "#recentErrors 必须限高可滚（展开 5 条长错误是 429 常态，不限高会挤没正文）");
});

test("内嵌特化：独立窗口档的全局 .dialog 规则不得被改成容器相对（收回作用域）", () => {
  // 基础规则必须仍是纯 vh——100% 的参照是 .mask，将来 mask 定位一改整条 max-height 就失效
  const base = panelSrc.match(/\.dialog \{[^}]*\}/);
  assert.ok(base, ".dialog 基础规则必须在位");
  assert.match(base[0], /max-height: 86vh;/, "全局 .dialog 必须保持 max-height:86vh（不得写成 calc(100%…)）");
  assert.doesNotMatch(base[0], /max-height: min\(86vh/, "容器相对的钳制必须挂在内嵌作用域，不得改全局规则");
  // 内嵌档专属钳制必须在
  assert.match(panelSrc, /body\.dsk-embedded \.dialog \{ max-height: min\(86vh, calc\(100% - 24px\)\); \}/,
    "内嵌档 .dialog 必须按容器钳高（弹窗 foot 不得超框）");
});

test("内嵌特化：侧栏横滚四条规则必须包在 ≤800px media 内（竖排态不得撑破 200px 侧栏）", () => {
  // 找出所有 @media (max-width: 800px) 块，取其中含 body.dsk-embedded aside 的那一个
  const blocks = [];
  let cursor = 0;
  while (true) {
    const start = panelSrc.indexOf("@media (max-width: 800px) {", cursor);
    if (start < 0) break;
    const end = panelSrc.indexOf("\n  }", start); // 媒体块在本文件里收在同缩进的 } 处
    blocks.push(panelSrc.slice(start, end > start ? end : panelSrc.indexOf("</style>", start)));
    cursor = start + 10;
  }
  const block = blocks.find((b) => b.includes("body.dsk-embedded aside"));
  assert.ok(block, "侧栏内嵌规则必须被 @media (max-width:800px) 包裹（宽内嵌下 aside 是竖排 200px，nowrap 会溢出）");
  for (const [rule, why] of [
    [/body\.dsk-embedded aside \{ flex-wrap: nowrap; overflow-x: auto; \}/, "横排单行横滚"],
    [/body\.dsk-embedded aside \.group \{ display: none; \}/, "横排隐藏无意义的分组标签"],
    [/body\.dsk-embedded aside \.brand \{ flex: none; \}/, "品牌区不参与压缩"],
    [/body\.dsk-embedded aside a \{ flex: none; white-space: nowrap; \}/, "链接保持固有宽度（否则被 flex-shrink 压到 574px，横滚永不触发）"],
  ]) {
    assert.match(block, rule, `侧栏规则缺失：${why}`);
  }
});

test("内嵌特化：主题桥提示分档 + 图标钮可访问名", () => {
  const body = moduleScript(panelSrc);
  // B3：从未成功的两个分支走 bridgeNeverOkNotice，函数内按 EMBEDDED 分档
  assert.match(body, /function bridgeNeverOkNotice\(\) \{[\s\S]{0,300}if \(EMBEDDED\) \{[\s\S]{0,120}toast\(/, "内嵌档从未成功 → toast（不占常驻高度）");
  assert.match(body, /function bridgeNeverOkNotice\(\) \{[\s\S]{0,400}\} else \{[\s\S]{0,160}bridgeNotice"\)\.classList\.add\("show"\)/, "独立窗口档保持常驻黄条");
  // B2：图标钮必须带 aria-label（textContent 压成 ◐ 后读屏只剩几何符号）
  assert.match(body, /aria-label", "手动切换深浅色"/, "图标钮必须补 aria-label（可访问名不得退化成 ◐）");
  assert.match(panelSrc, /body\.dsk-embedded #themeToggle\.dsk-iconBtn \{/, "图标钮样式必须挂内嵌作用域");
});

// ---- 三、client 侧：内嵌容器高度 + 新窗口按钮不得自毁内嵌面板 ----

test("client 侧：内嵌容器高度有上限钳制（不把宿主设置页压成一条）", () => {
  assert.match(clientSrc, /\.dsk-iframeHost\{[^}]*height:min\(70vh,620px\)/,
    "内嵌容器必须 height:min(70vh,620px)（纯 70vh 在矮宿主下会压扁面板）");
});

test("client 侧：「新窗口打开」必须先握手成功才收起内嵌面板（不许复用 openPanel）", () => {
  // openPanel 先清 DOM 再 window.open；内嵌档的存在前提就是 open 被拦，
  // 复用它会在失败时清空面板再重建（草稿/路由全丢）。必须走专用回调。
  assert.match(clientSrc, /const openInNewWindow = useCallback\(/, "必须有专用 openInNewWindow 回调");
  const fnStart = clientSrc.indexOf("const openInNewWindow = useCallback(");
  const fnEnd = clientSrc.indexOf("}, []);", fnStart);
  assert.ok(fnEnd > fnStart, "openInNewWindow 函数体必须可定位");
  const fn = clientSrc.slice(fnStart, fnEnd);
  // 顺序断言：window.open 必须在清空 DOM 之前
  const openAt = fn.indexOf("window.open(PANEL_PATH");
  const clearAt = fn.indexOf('iframeHostRef.current.innerHTML = ""');
  assert.ok(openAt > 0, "openInNewWindow 内部必须自己调 window.open");
  assert.ok(clearAt > openAt, "清空 iframe 必须在 window.open 之后（失败时面板原样保留）");
  // 失败分支不得 fallback 重建（那等于重置面板）
  assert.doesNotMatch(fn, /fallbackToIframe/, "openInNewWindow 失败不得 fallbackToIframe（会重建并重置面板）");
  // 两条失败提示都必须可见（不静默）
  assert.match(fn, /新窗口仍被拦/, "被拦时必须有可见提示");
  assert.match(fn, /新窗口未响应/, "未回执时必须有可见提示");
  // 按钮必须接这个回调，不得接 openPanel
  const btn = clientSrc.slice(clientSrc.indexOf('title: "在独立窗口打开'), clientSrc.indexOf('"↗ 新窗口打开"'));
  assert.match(clientSrc.slice(clientSrc.lastIndexOf("onClick", clientSrc.indexOf('"↗ 新窗口打开"')), clientSrc.indexOf('"↗ 新窗口打开"')), /onClick: openInNewWindow/,
    "按钮 onClick 必须接 openInNewWindow");
  assert.ok(btn.length > 0, "新窗口按钮必须在位");
});

// ---- 四、独立窗口档零影响（安全承诺的可机械验证部分） ----

test("独立窗口档：A3 常量在非内嵌时必须是原 vh 字面量（不得被顺手改掉）", () => {
  const body = moduleScript(panelSrc);
  for (const [name, literal] of [
    ["DIALOG_CAP_PAGES", '"88vh"'],
    ["DIALOG_MIN_SRC", '"46vh"'],
    ["DIALOG_MIN_PERSONA", '"52vh"'],
    ["DIALOG_CAP_LIST", '"52vh"'],
  ]) {
    const re = new RegExp(`const ${name} = EMBEDDED \\? "[^"]*" : ${literal.replace(/"/g, '"')};`);
    assert.match(body, re, `${name} 的非内嵌分支必须保持原字面量 ${literal}`);
  }
});

test("独立窗口档：静态文案与静态形态在位上（内嵌分档不得污染基线）", () => {
  assert.match(panelSrc, /id="themeToggle"[^>]*>◐ 手动切换深浅色</,
    "themeToggle 静态文案必须仍是「◐ 手动切换深浅色」（内嵌档才在 JS 里压成 ◐）");
  assert.match(panelSrc, /id="backBtn"[^>]*>← 返回设置</,
    "backBtn 静态文案必须仍是「← 返回设置」（内嵌档才在 JS 里改文案）");
  assert.match(panelSrc, /body \{ margin: 0; font: 14px\/1\.6[^}]*min-height: 100vh;/,
    "body 基线必须保持 min-height:100vh（内嵌档 height:100vh 挂在 dsk-embedded 下，不得改基线）");
});

test("markCountsError 的可见提示仍在（该断言原先只钉函数名，掏空函数体也全绿）", () => {
  const start = panelSrc.indexOf("function markCountsError()");
  assert.ok(start > 0, "markCountsError 必须在位");
  const body = panelSrc.slice(start, start + 500);
  assert.match(body, /countsStatus/, "失败提示必须落到 #countsStatus 节点");
  assert.match(body, /计数暂时无法加载/, "失败提示文案必须在函数体内（不只钉函数名）");
});

// ---- 五、panel.html 的脚本语法必须被检查解析（原先全靠人眼） ----
// 背景：npm run check 只扫 lib/*.js，测试只从模板串里抠单函数求值——
// 整个 <script type="module"> 从未被整体解析过，语法错一行整页白屏而 1307 项全绿。

test("panel.html 的 <script type=\"module\"> 必须整体可解析（防白屏）", () => {
  const body = moduleScript(panelSrc);
  assert.ok(body.trim().length > 1000, "module 段不应为空壳");
  // 用 Function 构造器只做语法解析，不执行（模块顶层 import 语句不能进 Function，
  // 故此处的校验对象是「除 import 之外的主体」——import 行单独保留在 moduleScript 里）。
  const withoutImports = body.replace(/^\s*import\s[^\n]*\n/gm, "");
  assert.doesNotThrow(() => new Function(withoutImports), "module 主体必须语法正确");
  // import 语句本身也要在位（剥掉后仍要能在原文里找到）
  const imports = body.match(/^\s*import\s[^\n]*$/gm) || [];
  assert.ok(imports.length >= 1, "module 段必须保留 panel-logic 的 import");
  assert.ok(imports.every((line) => /panel-logic\.js/.test(line)), "import 必须指向自供 panel-logic");
});

test("panel.html 的内联同步脚本必须可解析", () => {
  const inline = [...panelSrc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(inline.length >= 1, "必须有内嵌探测的内联同步脚本");
  for (const code of inline) {
    assert.doesNotThrow(() => new Function(code), "内联脚本必须语法正确（错一行整页白屏）");
  }
});

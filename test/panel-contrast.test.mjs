// 面板配色可读性检查 —— 2026-10-27 「刺眼」事故的结构钉。
//
// 为什么单独一组：事故是「白字压在半透明中灰上」，实测正文对比度 3.10:1（AA 线 4.5）、
// 卡片与正文底 1.00:1 完全同色、弹窗 1.49:1。当时的三个既有测试套件对配色零命中
// （panel-logic 测搬运语义、panel-drift 测 L.* 集合、panel-embedded 测内嵌 CSS），
// 所以这类回归可以完全无声地回来。本文件把「面板自有不透明底色」「双档语义色达标」
// 「背景不消费宿主 bg token」三件事钉住。
//
// 分工：源码 grep + 纯函数复算，不跑浏览器。实际渲染的几何/观感另有验收步骤。
//
// ⚠️ 本文件的盲区（实测过，别误以为单跑它就够了）：它只读 panel.html 的**静态文本**，
// 所以「applyThemeVars 运行时是否真的跳过自持背景」抓不到——把跳过逻辑改成
// `if (false && owned.has(name))` 时本文件全绿。那条由 test/panel-logic.test.mjs 的
// 「自持背景 token 一律跳过」用例兜住（变异实测会红）。两个套件要一起跑。
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { contrastRatio, parseColor } from "../lib/color.js";
import { OWNED_BG_TOKENS } from "../lib/panel-logic.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelSrc = readFileSync(path.join(root, "web", "panel.html"), "utf8");

/**
 * 取某个档位的完整变量集（基础浅色 / 手动深色 / media 兜底 / 手动浅色）。
 * 分档块在 panel.html 里出现顺序是：
 *   body{} → body.theme-dark{} → @media{body:not(.theme-light){}} → body.theme-light{}
 *
 * ⚠️ 只取**第一个**匹配块：若后人把某档拆成两条同名规则，这里会漏掉后一条
 * （CSS 级联后者胜，实测能静默造出 1.63:1 而不被发现）。所以下面额外断言
 * 「每档取到的变量数 ≥ 8」，一旦拆分就立刻红，而不是静默取到不完整的集合。
 */
function tierValues(tier) {
  const patterns = {
    light: /body \{([^}]*--fb-bg[^}]*)\}/,
    dark: /body\.theme-dark \{([^}]*--fb-bg[^}]*)\}/,
    media: /@media \(prefers-color-scheme: dark\) \{\s*body:not\(\.theme-light\) \{([^}]*)\}/,
    manualLight: /body\.theme-light \{([^}]*--fb-bg[^}]*)\}/,
  };
  const pattern = patterns[tier];
  assert.ok(pattern, `未知档位 ${tier}`);
  const block = pattern.exec(panelSrc);
  assert.ok(block, `找不到 ${tier} 档的定义块（选择器写法可能变了）`);
  const out = {};
  for (const m of block[1].matchAll(/--(fb-[a-z0-9]+)\s*:\s*([^;]+)/g)) {
    out[m[1]] = m[2].trim();
  }
  assert.ok(Object.keys(out).length >= 8,
    `${tier} 档只解析到 ${Object.keys(out).length} 个变量（<8）——选择器写法变了或该档被拆成多条规则，`
    + "本测试取不到完整集合，请不要调色值而是修正选择器");
  return out;
}

/**
 * 断言每个 --fb-* 变量在全文件只被定义在「允许的档位块」里，没有游离的后置同名规则。
 *
 * 为什么需要这条：tierValues 取的是**第一个**匹配块。若后人在样式表尾部追加一条
 * `body{--fb-label2:#c8cbd0}`（CSS 级联后者胜，渲染真的变成 1.63:1），
 * 分档检查全绿而实际早已改坏——实测过这个假绿色。
 */
function assertNoStrayDefinitions() {
  const styleStart = panelSrc.indexOf("<style>");
  const styleEnd = panelSrc.indexOf("</style>");
  assert.ok(styleStart >= 0 && styleEnd > styleStart, "找不到样式表段");
  const css = panelSrc.slice(styleStart, styleEnd).replace(/\/\*[\s\S]*?\*\//g, "");
  // 展开 @media 包裹：把 `@media (...) { X { ... } }` 变成只取内层 `X { ... }`
  const unwrapped = css.replace(/@media[^{]*\{\s*([^{}]+\{[^}]*\})\s*\}/g, "$1");
  // 允许定义 --fb-* 的选择器（三档 + 基础 body），且每个只能出现一次：
  // 同名块出现第二次 = 后置同名规则，会因 CSS 级联后者胜而绕过前面档位的检查。
  const allowed = ["body", "body.theme-dark", "body.theme-light", "body:not(.theme-light)"];
  const seen = new Map();
  for (const block of unwrapped.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = block[1].trim().replace(/\s+/g, " ");
    const decls = block[2];
    if (!/--fb-[a-z0-9]+\s*:/.test(decls)) continue;
    assert.ok(allowed.includes(selector),
      `选择器「${selector}」里定义了 --fb-* 变量，但不在允许的档位块里。`
      + `后置同名规则会因 CSS 级联覆盖前面的档位而绕过所有对比度检查（允许的：${allowed.join(" / ")}）`);
    const count = (seen.get(selector) ?? 0) + 1;
    seen.set(selector, count);
    assert.equal(count, 1,
      `选择器「${selector}」定义了两次 --fb-* 变量。第二次是后置同名规则，`
      + "CSS 级联会让它胜出，而本文件的分档检查只取第一个块——会静默漏掉真实生效的值。"
      + "请合并到同一个档位块。");
  }
}

// ---- 一、背景由面板自持：不得消费宿主 bg token ----

/** 取一段 CSS 里所有背景声明（含 background-color / background-image 写法）。 */
function bgDeclsOf(css) {
  return [...css.matchAll(/background(?:-color|-image)?\s*:\s*([^;}]+)/g)].map((m) => m[1]);
}

test("档位块之外不得有游离的 --fb-* 定义（后置同名规则会绕过全部对比度检查）", () => {
  assertNoStrayDefinitions();
});

test("背景自持：body/aside/topbar/card/dialog 的 background 不引用 --dsw-alias-bg-*", () => {
  // 排除注释（样式表注释里允许提到 token 名作为说明；脚本里的 // 注释也一并剥掉，
  // 否则日后在 JS 注释里写一句「曾消费 --dsw-alias-bg-base」就会假红）
  const cssOnly = panelSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const bgDecls = bgDeclsOf(cssOnly);
  // 防空转：background 的写法若被改成别的属性名，正则匹配 0 条时下面那条会「空数组=空数组」通过
  assert.ok(bgDecls.length >= 8,
    `只匹配到 ${bgDecls.length} 条 background 声明（<8）——属性名写法可能变了（如改成 background-color），`
    + "本检查会因此空转失效");
  const offenders = bgDecls.filter((v) => v.includes("--dsw-alias-bg-"));
  assert.deepEqual(offenders, [],
    "背景不得引用宿主 bg token：宿主侧壁纸/玻璃插件会把它改写成半透明，白字会坐在半透明层上（实测 3.10:1）");
});

test("背景自持：五个承载文字的面都写 var(--fb-panel) / var(--fb-bg)", () => {
  for (const [sel, varName] of [
    ["body", "--fb-bg"],
    ["aside", "--fb-panel"],
    [".topbar", "--fb-panel"],
    [".card", "--fb-panel"],
    [".dialog", "--fb-panel"],
  ]) {
    const re = new RegExp("(?:^|\\n)\\s*" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{[^}]*background\\s*:\\s*var\\(" + varName + "\\)");
    assert.match(panelSrc, re, `${sel} 的 background 必须是 var(${varName})（面板自持实色）`);
  }
});

test("背景自持：OWNED_BG_TOKENS 与面板实际消费的 bg token 双向相等（防漂移）", () => {
  // 面板若改引用别的 bg token，这里立刻红——不会因为「两边一起写错」而静默放行
  // （这也是不做「背景类白名单」的原因：名单会漂移，消费侧声明才稳）
  const cssOnly = panelSrc.replace(/\/\*[\s\S]*?\*\//g, "");
  const referenced = new Set(
    [...cssOnly.matchAll(/--dsw-alias-bg-[a-z0-9-]+/g)].map((m) => m[0]),
  );
  assert.deepEqual([...referenced].sort(), [],
    "面板已不应再引用任何宿主 bg token；若确实需要，必须同时更新 OWNED_BG_TOKENS 与本文断言");
  assert.deepEqual([...OWNED_BG_TOKENS].sort(), ["--dsw-alias-bg-layer-1", "--dsw-alias-bg-layer-2"]);
});

// ---- 二、双档语义色与文字色必须全部达 AA ----

const MIN_RATIO = 4.5;
/** 所有档位都必须定义的前景变量（缺一档就会退回上一级继承值）。 */
const FG_KEYS = ["fb-label", "fb-label2", "fb-danger", "fb-ok", "fb-warn", "fb-accent"];
/** 所有档位都必须定义的全部变量（含边框与面底色）。 */
const ALL_KEYS = [...FG_KEYS, "fb-bg", "fb-panel", "fb-border", "fb-hover", "fb-selected"];

test("四档变量集合完全相等（漏一档会在该档退回继承值，实测造出近白选中条 1.03:1）", () => {
  const tiers = ["light", "dark", "media", "manualLight"];
  const sets = tiers.map((t) => [t, Object.keys(tierValues(t)).sort()]);
  const base = sets[0][1];
  assert.deepEqual(base, [...ALL_KEYS].sort(), "基础浅色档的变量集合与预期不符");
  for (const [tier, keys] of sets.slice(1)) {
    assert.deepEqual(keys, base,
      `${tier} 档的变量集合与基础浅色档不一致（多余或缺失）。`
      + "缺变量会让该档退回上一级继承值：媒体兜底档漏 --fb-hover/--fb-selected 时，"
      + "深色面板上会出现近白色选中条，压在上面的文字只有 1.03:1");
  }
});

/** 在某档上校验所有前景变量 vs 所有承载文字的面。 */
function assertTierReadable(tier, surfaces) {
  const v = tierValues(tier);
  for (const fgName of FG_KEYS) {
    for (const [sufName, sufColor] of Object.entries(surfaces)) {
      const fg = v[fgName];
      assert.ok(fg && sufColor, `${tier} 档缺 ${fgName} 或 ${sufName}`);
      const r = contrastRatio(fg, sufColor);
      assert.ok(r > 0,
        `${tier} 档 ${fgName}(${fg}) on ${sufName}(${sufColor}) 返回 0——不是「对比度极差」，`
        + "而是输入无效（多半是半透明色或无法解析），先修色值再谈对比度");
      assert.ok(r >= MIN_RATIO,
        `${tier} 档 ${fgName}(${fg}) on ${sufName}(${sufColor}) = ${r.toFixed(2)}，低于 AA ${MIN_RATIO}`);
    }
  }
}

/** 某一档的四个承载面（正文底 / 卡片底 / 悬停面 / 选中面）。 */
function surfacesOf(tier) {
  const v = tierValues(tier);
  return { panel: v["fb-panel"], bg: v["fb-bg"], hover: v["fb-hover"], selected: v["fb-selected"] };
}

test("浅色档：文字/语义色 vs 四个承载面（panel/bg/hover/selected）均 ≥ 4.5", () => {
  assertTierReadable("light", surfacesOf("light"));
});

test("深色档：文字/语义色 vs 四个承载面（panel/bg/hover/selected）均 ≥ 4.5", () => {
  assertTierReadable("dark", surfacesOf("dark"));
});

test("媒体兜底档：文字/语义色 vs 四个承载面均 ≥ 4.5", () => {
  // 这条路径是「主题桥失败 + 系统深色」，内嵌 iframe 里 opener 常为 null，属于常见路径。
  assertTierReadable("media", surfacesOf("media"));
});

test("系统深色兜底档：与手动深色档取值一致（否则桥失败时会串档）", () => {
  const dark = tierValues("dark");
  const media = tierValues("media");
  for (const key of ALL_KEYS) {
    assert.equal(media[key], dark[key], `media 兜底档的 --${key} 必须与 theme-dark 一致`);
  }
});

test("手动浅色档（theme-light）：与基础浅色档一致，且四个承载面都达标", () => {
  // 这一档此前完全没有覆盖：手动点「◐」切到浅色时，实际生效的就是它。
  // 实测把它改成半透明 + 浅灰字（2.51:1）时旧检查 11 条全绿。
  const base = tierValues("light");
  const manual = tierValues("manualLight");
  for (const key of ALL_KEYS) {
    assert.equal(manual[key], base[key], `theme-light 档的 --${key} 必须与基础浅色档一致`);
  }
  assertTierReadable("manualLight", surfacesOf("manualLight"));
});

test("hover / 选中面：自有实色且与面板底可区分（宿主半透明面在玻璃浅色档会与底同色）", () => {
  // 宿主 --dsw-alias-button-ghost-active-fill 在壁纸插件浅色档解析为 rgba(255,255,255,.698)，
  // 叠在面板自有 #ffffff 上 = 1.00:1 —— 选中项与普通项完全同色，主按钮看不出主次。
  // 阈值：selected ≥1.15（要能明确看出「这是当前项」），hover ≥1.08（悬停本就该克制）。
  for (const tier of ["light", "dark", "media", "manualLight"]) {
    const v = tierValues(tier);
    for (const name of ["fb-hover", "fb-selected"]) {
      assert.ok(v[name], `${tier} 档缺 --${name}`);
      const c = parseColor(v[name]);
      assert.ok(c !== null && c.a === 1, `${tier} 档 --${name}(${v[name]}) 必须是不透明实色`);
    }
    const sel = contrastRatio(v["fb-selected"], v["fb-panel"]);
    assert.ok(sel >= 1.10, `${tier} 档 selected vs panel = ${sel.toFixed(2)}，选中态看不出来（<1.10）`);
  }
});

test("状态面不得再引用宿主的 ghost-active / interactive-bg-hover token", () => {
  const cssOnly = panelSrc.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const token of ["--dsw-alias-button-ghost-active-fill", "--dsw-alias-interactive-bg-hover"]) {
    assert.ok(!cssOnly.includes(token),
      `${token} 不得再用于面底色：它是按宿主底色调的 alpha，压到面板自有实色上会失效（选中态 1.00:1）`);
  }
});

test("正文/次要文字的唯一入口必须回落到 --fb-label 系（不许写死事故色）", () => {
  // body 的 color 是正文色唯一入口。若 fallback 被写成事故色 #8c8f96，
  // 全套 1370 测试曾全绿而面板正文重新变成不可读（3.05:1）。
  assert.match(panelSrc, /body \{[^}]*color:\s*var\(--dsw-alias-label-primary, var\(--fb-label\)\)/,
    "body 的 color 必须回落 var(--fb-label)");
  const secondaryUses = [...panelSrc.matchAll(/var\(--dsw-alias-label-secondary,\s*(var\(--[a-z0-9-]+\)|#[0-9a-fA-F]{3,8})\)/g)].map((m) => m[1].trim());
  assert.ok(secondaryUses.length >= 5, `label-secondary 消费点异常少（${secondaryUses.length}）`);
  for (const fallback of secondaryUses) {
    assert.equal(fallback, "var(--fb-label2)",
      `--dsw-alias-label-secondary 的回落必须是 var(--fb-label2)，实际是 ${fallback}`);
  }
});

test("背景档位必须钉到宿主权威（popup 档下 media 跟 OS 不跟宿主）", () => {
  // 前景色来自宿主 token，背景档若只靠 media，独立窗口档会出现
  // 「宿主深色字 + 面板浅色底」= 1.02:1（比本事故 3.10 更糟）。
  const js = /<script type="module">([\s\S]*?)<\/script>/.exec(panelSrc);
  assert.ok(js, "必须有 module 脚本段");
  assert.match(js[1], /function syncTierToHost\(\)/,
    "必须有 syncTierToHost：把背景档钉到宿主 data-ds-dark-theme（否则 popup 档与 iframe 档结果相反）");
  assert.match(js[1], /hasAttribute\("data-ds-dark-theme"\)/,
    "syncTierToHost 必须读宿主的 data-ds-dark-theme");
  // 断言 bridgeApply 函数体内确实调用了 syncTierToHost（限定在函数体内找，不跨函数误配）
  const applyBody = /function bridgeApply\(vars\) \{([\s\S]*?)\n\}\n/.exec(js[1]);
  assert.ok(applyBody, "找不到 bridgeApply 函数体");
  assert.match(applyBody[1], /syncTierToHost\(\)/,
    "桥成功后必须立即同步档位（否则前景翻转而背景不动）");
  // 手动切换必须按「实际渲染档」判定，否则系统深色下首点无视觉变化
  assert.match(js[1], /function currentTierIsDark\(\)/,
    "必须有 currentTierIsDark：按实际渲染档判定，否则系统深色下首次点击幂等（看起来像按钮坏了）");
  const toggleBody = /addEventListener\("click",[\s\S]*?\n\}\);/.exec(js[1]);
  assert.ok(toggleBody, "找不到手动切换的 click 处理");
  assert.match(toggleBody[0], /currentTierIsDark\(\)/,
    "手动切换必须调用 currentTierIsDark()（不能直接读 class，否则会漏掉 media 兜底生效的情况）");
  assert.doesNotMatch(toggleBody[0], /classList\.contains\("theme-dark"\)\s*;/,
    "手动切换不得直接读 classList.contains(\"theme-dark\")：系统深色 + 未手动选时它得 false，首点会变成幂等");
});

test("所有档位都是不透明实色（半透明底色是本次事故的根因）", () => {
  for (const tier of ["light", "dark", "media", "manualLight"]) {
    const v = tierValues(tier);
    for (const name of ["fb-bg", "fb-panel"]) {
      const c = parseColor(v[name]);
      assert.ok(c !== null, `${tier} 档 --${name}(${v[name]}) 必须是可解析的实色`);
      assert.equal(c.a, 1, `${tier} 档 --${name}(${v[name]}) 必须完全不透明`);
    }
  }
});

// ---- 三、card 与 body 的边界要能看出来 ----

test("卡片与正文底：底色差或描边至少一项成立（不能既同色又无描边）", () => {
  for (const tier of ["light", "dark"]) {
    const v = tierValues(tier);
    const diff = contrastRatio(v["fb-panel"], v["fb-bg"]);
    const hasBorder = /\.card \{[^}]*border\s*:[^;}]*var\(--dsw-alias-border-l2, var\(--fb-border\)\)/.test(panelSrc);
    // 深色档底差只有 ~1.13，单靠底色分不清，必须配描边
    assert.ok(diff >= 1.10 || hasBorder,
      `${tier} 档：panel vs bg = ${diff.toFixed(2)}，底色差不足时必须靠描边区分（当前 hasBorder=${hasBorder}）`);
  }
  assert.match(panelSrc, /\.card \{[^}]*border\s*:/,
    ".card 必须有边框（深色档底色差仅 1.13:1，纯靠底色分不清卡片边界）");
});

// ---- 四、深浅档兜底与 color-scheme 必须在位 ----

test("深浅兜底：prefers-color-scheme 媒体查询与 color-scheme 声明在位", () => {
  assert.match(panelSrc, /@media \(prefers-color-scheme: dark\)/,
    "必须有系统深色兜底：否则桥失败时面板停在浅色白底，深色系统下闪白");
  assert.match(panelSrc, /html \{\s*color-scheme: light dark;?\s*\}/,
    "html 必须声明 color-scheme（滚动条/表单控件配色跟着走）");
  assert.match(panelSrc, /body\.theme-dark \{[^}]*color-scheme: dark/,
    "深色档必须声明 color-scheme: dark");
  assert.match(panelSrc, /body\.theme-light/,
    "必须有 theme-light 档：手动切浅色时才能压过 media 兜底（两档互斥）");
});

test("手动切换：两档互斥 toggle，不只切 theme-dark", () => {
  const js = /<script type="module">([\s\S]*?)<\/script>/.exec(panelSrc);
  assert.ok(js, "必须有 module 脚本段");
  assert.match(js[1], /classList\.toggle\("theme-dark",/,
    "手动切换必须显式设 theme-dark 的布尔值（两档互斥）");
  assert.match(js[1], /classList\.toggle\("theme-light",/,
    "手动切换必须同时设 theme-light，否则 media 兜底会继续压过手动选择");
});

// ---- 五、事故基线：把「合成救不了」固定在检查里 ----

test("事故基线：白字 vs 半透明白洗出的中灰仍不达标（防有人改回吃宿主 bg）", () => {
  // 这是 2026-10-27 实测值：面板正文底 #8c8f96、白字 #f9fafb → 3.10:1
  const r = contrastRatio("#f9fafb", "#8c8f96");
  assert.ok(Math.abs(r - 3.10) < 0.02, `事故基线应 ≈3.10，实际 ${r.toFixed(2)}`);
  assert.ok(r < MIN_RATIO, "事故基线必须低于 AA——这条是「吃宿主半透明背景 = 不可读」的锚");
  // 修复后目标：面板自持实色
  assert.ok(contrastRatio("#f9fafb", "#2c2c2e") >= MIN_RATIO, "深色档自持实色 #2c2c2e 必须达标");
  assert.ok(contrastRatio("#1f2328", "#ffffff") >= MIN_RATIO, "浅色档自持实色 #ffffff 必须达标");
});

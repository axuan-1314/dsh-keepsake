// 颜色判定与 WCAG 对比度 —— lib/color.js 的纯函数检查。
//
// 为什么单独一组：这批函数是「颜色字符串 → 数字」的判定层与 WCAG 数学层，零 DOM、零依赖、
// 无副作用，属于最该被直测的一类代码；而 panel-logic / panel-drift / panel-embedded 三个
// 既有套件都不碰它（它们测记忆逻辑、源码在位性、内嵌结构），所以这里从零建基线。
//
// 本组只钉三件事：
//   1. 认得哪些写法（hex/rgb/rgba/hsl/transparent），认不出的一律 null —— 不抛、不猜；
//   2. 对比度只对实色有意义，带 alpha 一律 0，绝不给「看起来还行」的假数；
//   3. 把 2026-10-27 面板刺眼事故的取证基线锁死，特别是「合成救不了对比度」这条反例，
//      防止将来有人再提出「把半透明合成到实色上」这个已经被证伪的方案。
//
// 语气说明：这里的数值不是随手写的期望值，是复算过的真实基线，改动它们等于改结论。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alphaOf,
  compositeOver,
  contrastRatio,
  isOpaqueColor,
  parseColor,
  toHex,
} from "../lib/color.js";

// ---- 一、parseColor：合法输入必须解析成确定的数字 ----

test("parseColor(#rgb)：三位缩写按位复制成六位", () => {
  assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor("#000"), { r: 0, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor("#abc"), { r: 170, g: 187, b: 204, a: 1 });
});

test("parseColor(#rrggbb)：面板主底色 #f9fafb 必须逐通道准确", () => {
  // 这个值是宿主面板的浅色底，后续所有对比度基线都从它算出来，差一个通道整条结论就漂。
  assert.deepEqual(parseColor("#f9fafb"), { r: 249, g: 250, b: 251, a: 1 });
});

test("parseColor(#rrggbbaa)：8 位 hex 的 alpha 按 /255 解释", () => {
  const c = parseColor("#ffffff80");
  assert.equal(c.r, 255);
  assert.equal(c.g, 255);
  assert.equal(c.b, 255);
  // 0x80 = 128，alpha = 128/255 ≈ 0.502，不是 0.5；精度按 /255 而不是 /256。
  assert.ok(Math.abs(c.a - 128 / 255) < 0.01, `#ffffff80 的 alpha 应 ≈ 0.502，实际 ${c.a}`);
});

test("parseColor(rgb())：逗号分隔且不透明", () => {
  assert.deepEqual(parseColor("rgb(255, 255, 255)"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor("rgb(20,30,40)"), { r: 20, g: 30, b: 40, a: 1 });
});

test("parseColor(rgba())：逗号第四位是 alpha", () => {
  const c = parseColor("rgba(255,255,255,0.51)");
  assert.equal(c.r, 255);
  assert.equal(c.g, 255);
  assert.equal(c.b, 255);
  // 事故配方的 alpha 就是 0.51，这个数字后面要参与合成反例，必须精确到 0.01。
  assert.ok(Math.abs(c.a - 0.51) < 0.01, `rgba(...,0.51) 的 alpha 应 ≈ 0.51，实际 ${c.a}`);
});

test("parseColor(rgba 空格+斜杠写法)：CSS Color 4 的 'a b c / d' 必须支持", () => {
  // 现代 Chromium 计算样式可能回这种写法；解析不出来就会被误判为「不可信」而回落实色，
  // 白白丢掉宿主主题色。
  assert.deepEqual(parseColor("rgba(255 255 255 / 0.5)"), { r: 255, g: 255, b: 255, a: 0.5 });
  assert.deepEqual(parseColor("rgb(255 255 255)"), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(parseColor("rgb(255 255 255 / .5)").a, 0.5);
});

test("parseColor(rgb 百分比通道)：100% 必须映射到 255 而不是 100", () => {
  // 百分比写法是规格允许的；若被 parseFloat 当成裸数就会得到 {100,0,0} 这种灰红，
  // 在对比度里是另一种颜色，属于静默错色。
  assert.deepEqual(parseColor("rgb(100%, 0%, 0%)"), { r: 255, g: 0, b: 0, a: 1 });
  assert.equal(parseColor("rgb(50%, 50%, 50%)").r, 128);
});

test("parseColor(transparent)：全透明固定为 {0,0,0,0}", () => {
  assert.deepEqual(parseColor("transparent"), { r: 0, g: 0, b: 0, a: 0 });
  // 大小写不该影响判定（宿主可能回大写）。
  assert.deepEqual(parseColor("TRANSPARENT"), { r: 0, g: 0, b: 0, a: 0 });
});

test("parseColor(hsl())：纯红近似值在 ±1 容差内", () => {
  const c = parseColor("hsl(0, 100%, 50%)");
  // hsl 走浮点往返，末位可能差 1，容差 ±1 是合理的；这也是唯一允许容差的 RGB 解析。
  assert.ok(Math.abs(c.r - 255) <= 1, `hsl(0,100%,50%) 的 r 应 ≈255，实际 ${c.r}`);
  assert.ok(Math.abs(c.g - 0) <= 1, `g 应 ≈0，实际 ${c.g}`);
  assert.ok(Math.abs(c.b - 0) <= 1, `b 应 ≈0，实际 ${c.b}`);
  assert.equal(c.a, 1);
});

test("parseColor 前后空白：trim 后才能匹配 hex", () => {
  // 计算样式回读偶尔带空白，不 trim 会整条解析失败 → 回落实色 → 主题色丢失。
  assert.deepEqual(parseColor("  #fff  "), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor("\t#f9fafb\n"), { r: 249, g: 250, b: 251, a: 1 });
});

// ---- 二、parseColor：非法输入一律 null，且绝不抛 ----

test("parseColor 非字符串：null / undefined / 数字 / 对象都是 null", () => {
  // 调用方拿到的可能来自 JSON.parse 或 config，类型不保证；这里必须挡在门口。
  assert.equal(parseColor(null), null);
  assert.equal(parseColor(undefined), null);
  assert.equal(parseColor(123), null);
  assert.equal(parseColor({}), null);
  assert.equal(parseColor([]), null);
});

test("parseColor 空串与纯空白：null", () => {
  assert.equal(parseColor(""), null);
  assert.equal(parseColor("   "), null);
});

test("parseColor 非法 hex 与自由文本：null", () => {
  assert.equal(parseColor("#gg0000"), null);
  assert.equal(parseColor("#ffff"), null);
  assert.equal(parseColor("not-a-color"), null);
  // 命名色不在支持清单里：明确拒答，而不是猜成一堆近似值。
  assert.equal(parseColor("red"), null);
  assert.equal(parseColor("white"), null);
});

test("parseColor(color-mix(...)) → null：不支持 color-mix，明确拒答不做近似解析", () => {
  // 这条是本文件最重要的一条。宿主真实值是三层嵌套 color-mix + calc(var(...))（壁纸插件的
  // 玻璃配方）。我们既不知道变量求值结果，也不知道混合空间，任何「近似解析」都只是猜；
  // 而猜错颜色比拒答更危险——拒答时调用方会回落到自有实色（安全），猜错则会把错误的
  // 半透明层当成底搬过去（正是事故本身）。所以这里钉死 null。
  assert.equal(parseColor("color-mix(in srgb, #fff 50%, transparent)"), null);
  assert.equal(parseColor("color-mix(in srgb, var(--a) 30%, color-mix(in srgb, #000 40%, transparent))"), null);
});

test("parseColor(var(...)) → null：CSS 变量未求值前不是颜色", () => {
  // 计算样式回读里若出现 var() 说明取错了层（拿到的是声明值而非计算值），必须当不可信。
  assert.equal(parseColor("var(--dsk-bg)"), null);
  assert.equal(parseColor("var(--dsw-alias-bg-layer-1)"), null);
});

test("parseColor 永不抛异常：脏输入走的是返回值而不是 throw", () => {
  // 这些函数跑在主题桥的热路径上，一次 throw 会打断整段主题注入；契约是「返回 null」。
  const dirty = [null, undefined, 0, "", "   ", "#zzz", "rgb()", "rgb(1,2)", "hsl(a,b,c)", "color-mix(in srgb)", "%%%"];
  assert.doesNotThrow(() => {
    for (const v of dirty) parseColor(v);
  });
  assert.equal(parseColor("rgb(1,2)"), null);
  assert.equal(parseColor("rgb()"), null);
});

// ---- 三、alphaOf：取不透明度，无法判定必须是 null 而不是 1 ----

test("alphaOf：实色 → 1，半透明 → 小数，全透明 → 0", () => {
  assert.equal(alphaOf("#ffffff"), 1);
  assert.equal(alphaOf("rgba(255,255,255,.5)"), 0.5);
  assert.equal(alphaOf("rgba(0,0,0,0)"), 0);
});

test("alphaOf(color-mix(...)) → null（不是 1）：不可判定不等于不透明", () => {
  // 这是 fail-open 的经典入口：若这里返回 1，调用方会把一个可能半透明的背景当实色放行，
  // 事故原样复现。null 强制调用方走「自有实色」分支。
  assert.equal(alphaOf("color-mix(in srgb, #fff 50%, transparent)"), null);
  assert.equal(alphaOf(null), null);
  assert.equal(alphaOf("not-a-color"), null);
});

// ---- 四、isOpaqueColor：保守布尔，解析失败 → false ----

test("isOpaqueColor：不透明 → true，半透明 → false", () => {
  assert.equal(isOpaqueColor("#ffffff"), true);
  assert.equal(isOpaqueColor("rgb(0,0,0)"), true);
  assert.equal(isOpaqueColor("rgba(255,255,255,0.51)"), false);
  assert.equal(isOpaqueColor("transparent"), false);
});

test("isOpaqueColor 解析失败 → false（保守，不放行）", () => {
  // 关键语义：不许把「不知道」当「不透明」。false 的结果是回落到自有实色——多花一点样式，
  // 换掉一次刺眼事故，这个方向不能反。
  assert.equal(isOpaqueColor("color-mix(in srgb, #fff 50%, transparent)"), false);
  assert.equal(isOpaqueColor("var(--x)"), false);
  assert.equal(isOpaqueColor(null), false);
  assert.equal(isOpaqueColor("not-a-color"), false);
});

// ---- 五、contrastRatio：WCAG 数学与事故基线 ----

test("contrastRatio 极值：黑白 21:1，同色 1:1", () => {
  const bw = contrastRatio("#000000", "#ffffff");
  assert.ok(Math.abs(bw - 21) < 0.05, `黑白对比度应 ≈21，实际 ${bw}`);
  assert.equal(contrastRatio("#ffffff", "#ffffff"), 1);
});

test("contrastRatio 事故基线 3.10：2026-10-27 实测值，keepsake 面板刺眼事故的取证基线", () => {
  // #f9fafb 面板底 vs #8c8f96 半透明层合成后的观测色，实测 3.10:1，低于 AA 的 4.5。
  // 这条数字是「当时到底有多糟」的唯一量化证据，改它就等于抹掉事故记录。
  const r = contrastRatio("#f9fafb", "#8c8f96");
  assert.ok(Math.abs(r - 3.1) < 0.02, `事故基线应 ≈3.10，实际 ${r}`);
  assert.ok(r < 4.5, "事故基线必须低于 AA 线 4.5，否则不再是事故");
});

test("contrastRatio 修复后目标 13.34：宿主深色 bg-layer-2 (#2c2c2e)", () => {
  // 修复方向是「不要那层半透明」，直接坐到宿主的不透明深色层上。
  const r = contrastRatio("#f9fafb", "#2c2c2e");
  assert.ok(Math.abs(r - 13.34) < 0.05, `修复后应 ≈13.34，实际 ${r}`);
  assert.ok(r > 4.5, "修复值必须明显高于 AA 线");
});

test("contrastRatio #232324：另一条深色底，复算 ≈15.03", () => {
  // 注：早期记录把这条记作 12.79，按 lib/color.js 的公式复算实为 15.03（±0.05 容差内无歧义），
  // 本文件以复算值为准；12.79 与任何 #f9fafb 对深灰的组合都对不上（最接近的是 #2f2f2f≈12.81）。
  const r = contrastRatio("#f9fafb", "#232324");
  assert.ok(Math.abs(r - 15.03) < 0.05, `应 ≈15.03，实际 ${r}`);
  assert.ok(r > 13.34, "#232324 比 #2c2c2e 更深，对比度应更高");
});

test("contrastRatio 参数顺序无关：亮暗互换结果相同", () => {
  // 公式里 hi/lo 已经排序，顺序不该影响结果；这条钉住「不许把实现改成有向的」。
  const a = "#f9fafb";
  const b = "#8c8f96";
  assert.equal(contrastRatio(a, b), contrastRatio(b, a));
  assert.equal(contrastRatio("#000000", "#ffffff"), contrastRatio("#ffffff", "#000000"));
});

test("contrastRatio 非法输入 → 0（不抛）", () => {
  // 0 是「无法计算」的哨兵值，调用方据此判定不可用；不能返回 1 或 21 冒充结果。
  assert.equal(contrastRatio("not-a-color", "#000000"), 0);
  assert.equal(contrastRatio(null, "#000000"), 0);
  assert.equal(contrastRatio("#000000", undefined), 0);
  assert.equal(contrastRatio("color-mix(in srgb, #fff 50%, transparent)", "#000000"), 0);
});

test("contrastRatio 带 alpha 的颜色 → 0：对比度只对实色有意义", () => {
  // 半透明色的实际对比度取决于它叠在什么上，本函数不替调用方假设底色，
  // 直接判无效比给一个「假设叠在白底上」的假数安全。
  assert.equal(contrastRatio("rgba(255,255,255,0.5)", "#000000"), 0);
  assert.equal(contrastRatio("#000000", "rgba(0,0,0,0.99)"), 0);
  assert.equal(contrastRatio("transparent", "#fff"), 0);
  // 对照：alpha 恰好为 1 的 rgba 应当正常计算。
  assert.ok(contrastRatio("rgba(0,0,0,1)", "#ffffff") > 20);
});

// ---- 六、toHex：固定大写六位 ----

test("toHex：大写 #RRGGBB", () => {
  assert.equal(toHex({ r: 255, g: 255, b: 255 }), "#FFFFFF");
  assert.equal(toHex({ r: 20, g: 22, b: 32 }), "#141620");
  // 大写是契约的一部分（与宿主回读值比较时不分大小写，但产出必须稳定）。
  assert.equal(toHex({ r: 171, g: 205, b: 239 }), "#ABCDEF");
});

test("toHex 补齐前导零：个位数通道必须占两位", () => {
  // 不补零会拼出 "#123" 这种长度错误、语义完全不同的字符串。
  assert.equal(toHex({ r: 1, g: 2, b: 3 }), "#010203");
  assert.equal(toHex({ r: 0, g: 0, b: 0 }), "#000000");
  assert.equal(toHex({ r: 0, g: 10, b: 0 }), "#000A00");
});

// ---- 七、compositeOver：只做取证复算，绝不当修复手段 ----

test("compositeOver：白 51% 叠 #141620 → #8C8D92（取证复算）", () => {
  // 把截图里的观测色反推回配方的那个方向：给定配方，算出应有的观测色。
  assert.equal(compositeOver("rgba(255,255,255,0.51)", "#141620"), "#8C8D92");
});

test("合成救不了对比度：白 51% 叠 #141620 后，白字对比度仍 < 4.5", () => {
  // 「合成救不了对比度」——白 51% 叠任何底色，白字对比度都到不了 4.5（叠纯黑也只有 3.68）。
  // 这是 2026-10-27 第一版方案被对抗式审查证伪的核心数学事实，钉在这里防止将来有人再想出
  // 「把半透明合成到实色上」这个主意。
  //
  // 直觉上「白色叠上去就变亮了，白字该更清楚」是反的：叠白让底色变亮，正好压缩了白字与
  // 底色的亮度差。合成改变的是「颜色长什么样」，不改变「白字能不能读」。
  const composited = compositeOver("rgba(255,255,255,0.51)", "#141620");
  assert.equal(composited, "#8C8D92");
  const r = contrastRatio("#f9fafb", composited);
  assert.ok(r < 4.5, `合成后白字对比度必须 < 4.5，实际 ${r}`);
  assert.ok(Math.abs(r - 3.17) < 0.02, `复算值应 ≈3.17，实际 ${r}`);
});

test("合成救不了对比度（强化）：叠纯黑底也只有 3.68，仍 < 4.5", () => {
  // 有人会想「那我把底换成纯黑总行了吧」——不行。白 51% 已经决定了合成色的上限，
  // 纯黑是最有利的底色，也只到 3.68。这条把「换底色」这条退路也钉死。
  const composited = compositeOver("rgba(255,255,255,0.51)", "#000000");
  assert.equal(composited, "#828282");
  const r = contrastRatio("#f9fafb", composited);
  assert.ok(r < 4.5, `叠纯黑后白字对比度仍必须 < 4.5，实际 ${r}`);
  assert.ok(Math.abs(r - 3.68) < 0.02, `复算值应 ≈3.68，实际 ${r}`);
});

test("compositeOver(transparent, 底) → 底色不变", () => {
  // 全透明前景的合成结果就是底色本身，也是「没有任何前景」的退化情形。
  assert.equal(compositeOver("transparent", "#141620"), "#141620");
});

test("compositeOver 不透明前景 → 直接返回它自己", () => {
  // alpha=1 时合成应退化为直通，避免被错误地掺进底色。
  assert.equal(compositeOver("rgb(100,100,100)", "#141620"), "#646464");
  assert.equal(compositeOver("#000000", "#141620"), "#000000");
});

test("compositeOver 前景解析失败 → 保守返回底色原文", () => {
  // 不可信的前景不许参与运算；返回底色原文至少不会产出「一个不存在的颜色」，
  // 也保证调用方拿到的永远是它能理解的形态。
  assert.equal(compositeOver("color-mix(in srgb, #fff 50%, transparent)", "#141620"), "#141620");
  assert.equal(compositeOver(null, "#141620"), "#141620");
  assert.equal(compositeOver("not-a-color", "#141620"), "#141620");
});

test("compositeOver 底色带 alpha → 拒绝合成，原样返回第二个参数", () => {
  // 半透明底上再合成半透明前景，结果依赖于更下面的一层（未知）。这里不做两层假设，
  // 把原始字符串原样退回，让调用方自己决定——这是「不猜」原则在合成方向的体现。
  assert.equal(compositeOver("rgba(255,255,255,.5)", "rgba(0,0,0,.5)"), "rgba(0,0,0,.5)");
  // 底色无法解析时同样原样退回。
  assert.equal(compositeOver("rgba(255,255,255,.5)", "not-a-color"), "not-a-color");
});

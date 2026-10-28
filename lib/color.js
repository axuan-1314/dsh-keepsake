// 颜色解析与 WCAG 对比度（纯函数，零 DOM、零依赖）。
//
// 为什么单独成文件：面板主题桥把宿主颜色搬进 iframe 时，需要判定「这个背景值是不是
// 半透明的」——半透明的背景搬过去会让白字直接坐在半透明层上（实测 3.10:1，AA 线 4.5）。
// 这类运算与 panel-logic 的记忆/面板逻辑无关，单独成文件便于直测。
//
// ⚠️ 不支持 color-mix()：宿主真实值可能是三层嵌套 color-mix + calc(var())（壁纸插件的
// 玻璃配方），本模块明确返回 null 而**不做近似解析**——猜错颜色比拒答更危险。
// 调用方拿到 null 时必须走「自有实色」而不是放行原值。

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX8 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RGB_FN = /^rgba?\(\s*([^)]+)\)$/i;
const HSL_FN = /^hsla?\(\s*([^)]+)\)$/i;

function clamp255(n) {
  return Math.min(255, Math.max(0, n));
}

/** 拆 "a b c / d" 或 "a,b,c,d" 形式的参数串；返回 {nums, alphaText}。 */
function splitArgs(inner) {
  const slashAt = inner.indexOf("/");
  let parts;
  let alphaText = null;
  if (slashAt >= 0) {
    parts = inner.slice(0, slashAt).split(/[\s,]+/);
    alphaText = inner.slice(slashAt + 1).trim();
  } else {
    parts = inner.split(/[\s,]+/);
  }
  return { parts: parts.filter(Boolean), alphaText };
}

/** 解析百分比或数字为 0..1 的 alpha；无法判定 → null。 */
function alphaOfText(text) {
  if (text === null || text === void 0) return null;
  const t = String(text).trim();
  if (t === "") return null;
  if (t.endsWith("%")) {
    const n = Number.parseFloat(t.slice(0, -1));
    if (!Number.isFinite(n)) return null;
    return Math.min(1, Math.max(0, n / 100));
  }
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/** 严格数字：整个串必须就是一个数字（可选带指定后缀），否则 null。
 *  用它而不是 parseFloat 是为了不让 "255px" 这类非法值被悄悄当 255 收下——
 *  本模块的契约是「解析不了就 null」，静默宽容等于猜。 */
function strictNumber(text, allowedSuffix) {
  const t = String(text).trim();
  const suffix = allowedSuffix ?? "";
  if (suffix !== "" && t.toLowerCase().endsWith(suffix)) {
    const body = t.slice(0, -suffix.length);
    if (body.trim() === "") return null;
    const n = Number(body);
    return Number.isFinite(n) ? n : null;
  }
  if (suffix !== "") {
    // 要求后缀时缺后缀也接受裸数（CSS 对 s/l 的裸数写法虽非法但普遍存在，按百分数处理）
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 解析百分数/数字通道为 0..255（rgb 的百分比写法规格允许）。 */
function channelOfText(text) {
  const t = String(text).trim();
  if (t.endsWith("%")) {
    const n = strictNumber(t.slice(0, -1));
    if (n === null) return null;
    return clamp255(Math.round((n / 100) * 255));
  }
  const n = strictNumber(t);
  if (n === null) return null;
  return clamp255(Math.round(n));
}

/** 解析 hsl 的色相角为度数。支持裸数（度）与 deg；turn/rad/grad 换算出度数；
 *  未知单位或非数字 → null（绝不像 parseFloat 那样丢掉单位后当度数用）。
 *  ⚠️ 判断顺序有意义：grad 必须排在 rad 之前，因为 "200grad".endsWith("rad") 为真。 */
function hueToDegrees(text) {
  const t = String(text).trim().toLowerCase();
  const readNumber = (body) => {
    const n = Number(body);
    return Number.isFinite(n) ? n : null;
  };
  if (t.endsWith("grad")) {
    const n = readNumber(t.slice(0, -4));
    return n === null ? null : n * 0.9;
  }
  if (t.endsWith("deg")) return readNumber(t.slice(0, -3));
  if (t.endsWith("turn")) {
    const n = readNumber(t.slice(0, -4));
    return n === null ? null : n * 360;
  }
  if (t.endsWith("rad")) {
    const n = readNumber(t.slice(0, -3));
    return n === null ? null : (n * 180) / Math.PI;
  }
  return readNumber(t);
}

/** 解析 hsl 的 s/l 为 0..1。规格要求百分数；裸数按百分数处理（CSS 实际写法常见），
 *  但 0..1 的小数会因此被当成 0..1%——所以对「无 % 且 |n| <= 1」的输入判 null，
 *  避免把 hsl(0,1,0.5) 静默解析成近黑色。 */
function ratioOfText(text) {
  const t = String(text).trim();
  if (t.endsWith("%")) {
    const n = strictNumber(t.slice(0, -1));
    if (n === null) return null;
    return Math.min(1, Math.max(0, n / 100));
  }
  const n = strictNumber(t);
  if (n === null) return null;
  if (Math.abs(n) <= 1) return null; // 疑似 0..1 小数，语义歧义 → 拒答
  return Math.min(1, Math.max(0, n / 100));
}

function hslToRgb(h, s, l) {
  const hh = ((h % 360) + 360) % 360;
  const ss = Math.min(1, Math.max(0, s));
  const ll = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: clamp255(Math.round((r + m) * 255)),
    g: clamp255(Math.round((g + m) * 255)),
    b: clamp255(Math.round((b + m) * 255)),
  };
}

/**
 * 解析颜色字符串为 {r,g,b,a}（r/g/b 0..255 整数，a 0..1）。
 * 支持 #rgb / #rrggbb / #rrggbbaa / rgb() / rgba() / hsl() / hsla() / transparent。
 * 不支持的语法（含 color-mix、var()、命名色）一律返回 null —— 不抛异常、不猜。
 * @param {unknown} input
 * @returns {{r:number,g:number,b:number,a:number}|null}
 */
export function parseColor(input) {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (s === "") return null;
  const lower = s.toLowerCase();
  if (lower === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  let m = HEX3.exec(s);
  if (m) {
    return {
      r: parseInt(m[1] + m[1], 16),
      g: parseInt(m[2] + m[2], 16),
      b: parseInt(m[3] + m[3], 16),
      a: 1,
    };
  }
  m = HEX6.exec(s);
  if (m) {
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a: 1 };
  }
  m = HEX8.exec(s);
  if (m) {
    return {
      r: parseInt(m[1], 16),
      g: parseInt(m[2], 16),
      b: parseInt(m[3], 16),
      a: parseInt(m[4], 16) / 255,
    };
  }

  m = RGB_FN.exec(s);
  if (m) {
    const { parts, alphaText } = splitArgs(m[1]);
    if (parts.length < 3) return null;
    const r = channelOfText(parts[0]);
    const g = channelOfText(parts[1]);
    const b = channelOfText(parts[2]);
    if (r === null || g === null || b === null) return null;
    let a = 1;
    if (alphaText !== null) {
      const parsed = alphaOfText(alphaText);
      if (parsed === null) return null;
      a = parsed;
    } else if (parts.length >= 4) {
      const parsed = alphaOfText(parts[3]);
      if (parsed === null) return null;
      a = parsed;
    }
    return { r, g, b, a };
  }

  m = HSL_FN.exec(s);
  if (m) {
    const { parts, alphaText } = splitArgs(m[1]);
    if (parts.length < 3) return null;
    const h = hueToDegrees(parts[0]);
    const sat = ratioOfText(parts[1]);
    const light = ratioOfText(parts[2]);
    if (h === null || sat === null || light === null) return null;
    const rgb = hslToRgb(h, sat, light);
    let a = 1;
    if (alphaText !== null) {
      const parsed = alphaOfText(alphaText);
      if (parsed === null) return null;
      a = parsed;
    } else if (parts.length >= 4) {
      const parsed = alphaOfText(parts[3]);
      if (parsed === null) return null;
      a = parsed;
    }
    return { ...rgb, a };
  }

  return null;
}

/**
 * 取颜色的不透明度。无法判定 → null（调用方必须按「不可信」处理，不许当 1）。
 * @param {unknown} input
 * @returns {number|null}
 */
export function alphaOf(input) {
  const c = parseColor(input);
  return c === null ? null : c.a;
}

/**
 * 是否可判定为完全不透明。解析失败一律 false —— 保守：宁可回落实色，
 * 也不把「不知道」当成「不透明」放行。
 * @param {unknown} input
 * @returns {boolean}
 */
export function isOpaqueColor(input) {
  return alphaOf(input) === 1;
}

/** WCAG 相对亮度（sRGB → 线性）。 */
function relativeLuminance({ r, g, b }) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * WCAG 对比度（1..21）。任一输入无法解析（含带 alpha 的颜色里 alpha<1 的情形，
 * 因为对比度只对实色有意义）→ 0。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
export function contrastRatio(a, b) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (ca === null || cb === null) return 0;
  // 半透明色的对比度取决于它叠在什么上；这里不替调用方假设底色，直接判无效。
  if (ca.a < 1 || cb.a < 1) return 0;
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 格式化为大写 #rrggbb。 */
export function toHex({ r, g, b }) {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * 把带 alpha 的前景合成到实色底上，返回不透明 hex。
 *
 * ⚠️ 这个函数**不是**可读性修复手段：合成只改变「颜色长什么样」，不改变「白字能不能读」。
 * 实测反例（本仓 test/color.test.mjs 钉住）：白 51% 叠 #141620 → #8C8D92，白字仍只有
 * 3.17:1；换成纯黑底也只有 3.68:1。要提升对比度只能**不要那层半透明**。
 * 保留它只为取证复算（把截图里的观测色反推回配方）。
 *
 * 前景或底色无法解析 → 返回底色原文（保守：不把不可信结果当成颜色用）。
 * @param {unknown} fg
 * @param {string} baseHex
 * @returns {string}
 */
export function compositeOver(fg, baseHex) {
  const f = parseColor(fg);
  const b = parseColor(baseHex);
  if (f === null || b === null || b.a < 1) return baseHex;
  const mix = (v, base) => Math.round(f.a * v + (1 - f.a) * base);
  return toHex({ r: mix(f.r, b.r), g: mix(f.g, b.g), b: mix(f.b, b.b) });
}

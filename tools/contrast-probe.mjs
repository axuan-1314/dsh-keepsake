#!/usr/bin/env node
// contrast-probe —— 从截图原始像素里量「文字色 vs 背景色」的 WCAG 对比度。
//
// 为什么存在：2026-10-27 面板可读性事故——白字压在半透明中灰上，实测 3.10:1（AA 线 4.5）。
// 当时的取色是临时脚本手搓的，事后无法复现同一次测量。固化成本工具后，回归时重跑同一条
// 命令即可拿到同样的数字与判定，不用再对着截图肉眼猜。
//
// 为什么输入是 raw RGB 而不是 PNG：本仓零运行时依赖，不引 PNG 解码库；ffmpeg 一行就能把
// 截图拍成裸像素。裸像素还有个好处：不受 PNG 滤镜、色彩空间、缩放差异影响，取证更硬。
// 生成输入（务必用原始分辨率截图，缩放会改像素颜色，测出来的对比度就不是事故现场了）：
//   ffmpeg -y -i shot.png -f rawvideo -pix_fmt rgb24 shot.rgb
//
// 典型用法：
//   # 已知文字色，量每块背景
//   node tools/contrast-probe.mjs --rgb shot.rgb --size 1920x1032 \
//     --region '条目卡正文:420,300,1500,420' --region '工具栏:0,0,1919,96' --fg '#F9FAFB'
//   # 不知道文字色：取区域内最亮 2% 分位当推定前景（白字压深底的常见情形）
//   node tools/contrast-probe.mjs --rgb shot.rgb --size 1920x1032 --region '卡片:420,300,1500,420'
//
// 退出码：0 全部达标 / 1 有区域不达标 / 2 参数或输入错误。可直接挂进 CI 当检查。

import { readFileSync } from "node:fs";
import { parseColor, contrastRatio, compositeOver, toHex } from "../lib/color.js";

const DEFAULT_MIN = 4.5;
const SEPARATOR = "─".repeat(38);

const USAGE = `用法: node tools/contrast-probe.mjs --rgb <path> --size <W>x<H> --region [名字:]x0,y0,x1,y1 [选项]

取证对象：截图里的文字色 vs 背景色（WCAG 对比度）。输入是 ffmpeg 拍出来的裸 RGB，
不是 PNG —— 本仓零运行时依赖，且裸像素不受 PNG 解码差异影响。

必需:
  --rgb <path>                  raw rgb24 像素文件（生成命令见下）
  --size <W>x<H>                像素尺寸，例如 1920x1032（必须与文件字节数吻合）
  --region [名字:]x0,y0,x1,y1   统计区域，坐标含边界，可多次；区名可省，默认 region#N。
                                坐标必须在图内，且区域面积至少 100 像素（太小统计没意义）。

选项:
  --fg <hex>      已知文字色（#rrggbb / #rgb / rgb() 等）；不给则取区域内最亮 2% 分位
                  （p98）当推定前景。给了半透明色会按该区主色合成后测量（会标注“合成”）。
  --min <ratio>   达标线，默认 ${DEFAULT_MIN}（WCAG AA 正文）
  -h, --help      显示本帮助

生成输入:
  ffmpeg -y -i shot.png -f rawvideo -pix_fmt rgb24 shot.rgb

每个区域输出:
  主色 top3 及占比、区域内亮度分位 p2/p50/p98、对比度、是否达标。

退出码: 0 全部达标 / 1 有区域不达标 / 2 参数或输入错误

示例:
  node tools/contrast-probe.mjs --rgb shot.rgb --size 1920x1032 \\
    --region '条目卡正文:420,300,1500,420' --region '工具栏:0,0,1919,96' --fg '#F9FAFB'
`;

/** 参数/输入错误一律显式退出 2：检查里要能和「有区域不达标（1）」区分开。 */
function die(message) {
  process.stderr.write(`contrast-probe: ${message}\n`);
  process.stderr.write("用 --help 查看用法\n");
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { rgb: null, size: null, regionSpecs: [], fg: null, min: DEFAULT_MIN, help: false };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    // 同时接受 --flag value 与 --flag=value，省得调用方记两套写法
    let key = raw;
    let inlineValue = null;
    if (raw.startsWith("--")) {
      const eq = raw.indexOf("=");
      if (eq > 0) {
        key = raw.slice(0, eq);
        inlineValue = raw.slice(eq + 1);
      }
    }
    const value = () => {
      if (inlineValue !== null) return inlineValue;
      if (i + 1 >= argv.length) die(`${key} 缺少取值`);
      return argv[++i];
    };

    if (key === "-h" || key === "--help") {
      opts.help = true;
    } else if (key === "--rgb") {
      opts.rgb = value();
    } else if (key === "--size") {
      opts.size = value();
    } else if (key === "--region") {
      opts.regionSpecs.push(value());
    } else if (key === "--fg") {
      opts.fg = value();
    } else if (key === "--min") {
      const text = value();
      const n = Number(text);
      if (!Number.isFinite(n) || n < 1 || n > 21) die(`--min 需要 1..21 的数字，收到 "${text}"`);
      opts.min = n;
    } else if (raw.startsWith("-")) {
      die(`未知选项 ${raw}`);
    } else if (opts.rgb === null) {
      // 位置参数只当 --rgb 的简写；PNG 之类在后面显式拒绝
      opts.rgb = raw;
    } else {
      die(`多余的参数 ${raw}`);
    }
  }
  return opts;
}

/** 终端里 CJK 占两列，不按显示宽度补空格的话中文区名对不齐（本仓输出全是中文标签）。 */
function displayWidth(text) {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

function parseSize(text) {
  const m = /^(\d+)\s*[xX]\s*(\d+)$/.exec(text.trim());
  if (!m) die(`--size 格式应为 <W>x<H>（例如 1920x1032），收到 "${text}"`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width <= 0 || height <= 0) die(`--size 的宽高必须为正整数，收到 "${text}"`);
  return { width, height };
}

function parseRegionSpec(spec, index, imgW, imgH) {
  const fallbackName = `region#${index}`;
  let name = fallbackName;
  let coords = spec;
  // 区名里理论上可能带冒号，所以按最后一个冒号切；纯坐标本身不含冒号
  const at = spec.lastIndexOf(":");
  if (at >= 0) {
    name = spec.slice(0, at).trim() || fallbackName;
    coords = spec.slice(at + 1);
  }
  const m = /^(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)$/.exec(coords.trim());
  if (!m) die(`--region "${spec}" 坐标格式应为 x0,y0,x1,y1（含边界），例 "卡片:420,300,1500,420"`);
  const [x0, y0, x1, y1] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (x0 > x1 || y0 > y1) die(`--region "${spec}" 起点在终点之后（x0<=x1 且 y0<=y1）`);
  if (x1 >= imgW || y1 >= imgH) {
    die(`--region "${spec}" 越界：图是 ${imgW}x${imgH}，合法坐标 x<${imgW}、y<${imgH}`);
  }
  const area = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (area < 100) die(`--region "${spec}" 只有 ${area} 像素（<100），统计没有意义，放大区域再测`);
  return { name, x0, y0, x1, y1, area };
}

// 同色像素在 UI 截图里常有 ±1 的抖动（压缩/抗锯齿），按精确值统计会把主色占比打散；
// 4 bit/通道又太粗会把相邻层级并掉，5 bit 是本仓截图上的折中。
const QUANT_SHIFT = 3;

const lumCache = new Map();

/** WCAG 相对亮度。不复制公式：对黑色取对比度即 (L+0.05)/0.05，反解得到 L。 */
function luminanceOf(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  const cached = lumCache.get(key);
  if (cached !== undefined) return cached;
  const ratio = contrastRatio(toHex({ r, g, b }), "#000000");
  const lum = (ratio - 1) / 20;
  // 照片类截图颜色数可能上百万，缓存别无限涨；UI 截图的颜色数远小于这个阈值
  if (lumCache.size > 200000) lumCache.clear();
  lumCache.set(key, lum);
  return lum;
}

/** 最近秩分位：sorted 必须升序。返回该分位处的亮度值。 */
function quantile(sorted, p) {
  const n = sorted.length;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  return sorted[idx];
}

function analyzeRegion(buf, imgW, region) {
  const { x0, y0, x1, y1 } = region;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const n = w * h;

  const lums = new Float64Array(n);
  const buckets = new Map();
  let k = 0;
  for (let y = y0; y <= y1; y++) {
    let off = (y * imgW + x0) * 3;
    for (let x = 0; x < w; x++, off += 3) {
      const r = buf[off];
      const g = buf[off + 1];
      const b = buf[off + 2];
      lums[k++] = luminanceOf(r, g, b);
      const bucketKey = ((r >> QUANT_SHIFT) << 10) | ((g >> QUANT_SHIFT) << 5) | (b >> QUANT_SHIFT);
      let bucket = buckets.get(bucketKey);
      if (bucket === undefined) {
        bucket = { count: 0, r: 0, g: 0, b: 0 };
        buckets.set(bucketKey, bucket);
      }
      bucket.count++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    }
  }

  const sorted = Float64Array.from(lums).sort();
  // 主色取桶内均值而不是桶中心：纯色区域能还原出精确的原色（如 #8C8F96），
  // 渐变/抖动区域也仍是该桶里真实出现过的颜色平均，不会被量化网格带偏。
  const top = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((bucket) => ({
      hex: toHex({
        r: Math.round(bucket.r / bucket.count),
        g: Math.round(bucket.g / bucket.count),
        b: Math.round(bucket.b / bucket.count),
      }),
      share: bucket.count / n,
    }));

  return { lums, sorted, top, n, p2: quantile(sorted, 0.02), p50: quantile(sorted, 0.5), p98: quantile(sorted, 0.98) };
}

/**
 * 推定前景：取最亮 2% 分位以上的像素求平均色。
 * 取平均而不是取单个分位像素，是为了不被一两个抗锯齿噪点带跑；
 * 平坦的纯色文字区域（本仓面板）平均下来就是那个精确的文字色。
 */
function brightestAverage(buf, imgW, region, threshold) {
  const { x0, y0, x1, y1 } = region;
  const w = x1 - x0 + 1;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    let off = (y * imgW + x0) * 3;
    for (let x = 0; x < w; x++, off += 3) {
      const r = buf[off];
      const g = buf[off + 1];
      const b = buf[off + 2];
      if (luminanceOf(r, g, b) >= threshold) {
        sr += r;
        sg += g;
        sb += b;
        count++;
      }
    }
  }
  return toHex({
    r: Math.round(sr / count),
    g: Math.round(sg / count),
    b: Math.round(sb / count),
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (opts.rgb === null) die("缺少 --rgb <path>（或直接给文件路径作为位置参数）");
  if (/\.(png|apng|jpe?g|webp|bmp|gif|tiff?)$/i.test(opts.rgb)) {
    die(
      `不支持直接解码 ${opts.rgb}（零依赖）；先生成裸像素：` +
        `ffmpeg -y -i "${opts.rgb}" -f rawvideo -pix_fmt rgb24 out.rgb`,
    );
  }
  if (opts.size === null) die("缺少 --size <W>x<H>（raw RGB 没有自带尺寸信息）");
  // 先校验尺寸格式再校验区域数量：调用方写错 --size 时应该听到尺寸的错，而不是被
  // 「缺 --region」抢先盖掉（否则改一处错再跑一次才发现下一处错）。
  const { width, height } = parseSize(opts.size);
  if (opts.regionSpecs.length === 0) die("至少给一个 --region 名字:x0,y0,x1,y1");

  let buf;
  try {
    buf = readFileSync(opts.rgb);
  } catch (e) {
    die(`读不到 --rgb 文件 "${opts.rgb}"（${e.code || e.message}）`);
  }
  const expectedBytes = width * height * 3;
  if (buf.length !== expectedBytes) {
    die(
      `--size ${width}x${height} 需要 ${expectedBytes} 字节（W*H*3），实际 ${buf.length} 字节；` +
        `确认 ffmpeg 用的是 -pix_fmt rgb24，且 --size 与截图原始分辨率一致`,
    );
  }

  let fgParsed = null;
  if (opts.fg !== null) {
    fgParsed = parseColor(opts.fg);
    if (fgParsed === null) die(`--fg 不是可解析的颜色："${opts.fg}"（支持 #rgb / #rrggbb / rgb() / hsl()）`);
  }

  const regions = opts.regionSpecs.map((spec, i) => parseRegionSpec(spec, i + 1, width, height));

  const results = [];
  for (const region of regions) {
    const stats = analyzeRegion(buf, width, region);
    const bgHex = stats.top[0].hex;

    let fgHex;
    let fgNote = "";
    if (fgParsed === null) {
      fgHex = brightestAverage(buf, width, region, stats.p98);
      fgNote = "(p98)";
    } else if (fgParsed.a < 1) {
      // 半透明前景的实际观感由它叠在主色上决定；取证时按主色合成才是截图上真实看到的颜色。
      // （注意：合成只用于测量，不是可读性修复手段，见 lib/color.js 里 compositeOver 的告警。）
      fgHex = compositeOver(opts.fg, bgHex);
      fgNote = "(合成)";
    } else {
      fgHex = toHex(fgParsed);
    }

    const ratio = contrastRatio(fgHex, bgHex);
    if (ratio <= 0) die(`内部颜色计算失败：bg=${bgHex} fg=${fgHex}`);

    results.push({ region, stats, bgHex, fgHex, fgNote, ratio });
  }

  const labelWidth = Math.max(...results.map((r) => displayWidth(`[${r.region.name}]`)));

  process.stdout.write(`contrast-probe: ${opts.rgb} ${width}x${height}\n`);
  process.stdout.write(`${SEPARATOR}\n`);

  for (const r of results) {
    const label = `[${r.region.name}]`;
    const pad = " ".repeat(labelWidth - displayWidth(label) + 2);
    const verdict = r.ratio >= opts.min ? "✓ pass" : `✗ FAIL (min ${opts.min})`;
    process.stdout.write(
      `${label}${pad}bg=${r.bgHex} (${Math.round(r.stats.top[0].share * 100)}%)  ` +
        `fg=${r.fgHex}${r.fgNote}  ratio=${r.ratio.toFixed(2)}  ${verdict}\n`,
    );
    const indent = " ".repeat(labelWidth + 2);
    const topText = r.stats.top.map((t) => `${t.hex} ${Math.round(t.share * 100)}%`).join(", ");
    process.stdout.write(
      `${indent}亮度分位 p2=${r.stats.p2.toFixed(4)} p50=${r.stats.p50.toFixed(4)} ` +
        `p98=${r.stats.p98.toFixed(4)}  n=${r.stats.n} ｜ top3: ${topText}\n`,
    );
  }

  process.stdout.write(`${SEPARATOR}\n`);

  const failed = results.filter((r) => r.ratio < opts.min).length;
  if (failed === 0) {
    process.stdout.write(`${results.length}/${results.length} 区域达标（min ${opts.min}:1）\n`);
  } else {
    process.stdout.write(`${failed}/${results.length} 区域未达 ${opts.min}:1\n`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();

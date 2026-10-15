// dsh-keepsake 硬事实 token 抽取与新旧正文差异告警（专治「269 记成 267」类静默改数）。
//   token 类型：number（≥2 位数字，逗号归一）/ semver（x.y.z）/
//               hex（≥6 位、且同时含数字与 a-f 字母，不含纯英文词如 decade/facade）/ bytesize（4KB/1024 字节等）。
//   排除：frontmatter 字段（运行时数字 churn，如 originSessionId）、ISO 时间戳/日期、
//         非 ISO 斜杠日期（2026/10/14）、时钟时间（10:30）、索引行（- [..](..) 形态）、
//         动态倒计时注记（中英文，如「（今天 · 30 天后过期）」「30 days left」）。
//   差异判据（hybrid，同时钉住 269→267 检出与 346→412 不误报）：
//     1) 纯丢失：旧 token 在新文中同类型一个都不剩 → 记 hardfact-drop（「旧有新无」口径）；
//     2) 近似替换：旧 token 被同类型 token 顶掉且数值极近（|Δ| ≤ max(10, 2%)）→ 疑似誊写错误，记 hardfact-drop；
//     3) 远值替换：同类型新 token 存在但都不近 → 判为有意更新（346→412、版本号升位），不报。
//   纯函数，无 IO；diff 片段用统一 diff 形态，供 extraction-errors.log 落盘（≤2KB）。

export const HARDFACT_TYPES = ["number", "semver", "hex", "bytesize"];

/** 硬事实告警策略：warn（默认，只计数+留痕）| block（该 op 按校验失败回滚）。 */
export const HARDFACT_POLICIES = new Set(["warn", "block"]);
export const HARDFACT_POLICY_DEFAULT = "warn";

/** 索引行形态：- [Title](file.md) …（整行不参与硬事实抽取）。 */
const INDEX_LINE_RE = /^\s*-\s*\[[^\]]*\]\([^)]*\)/;

/** ISO 日期/时间戳（含日期+时间+时区的完整形态与裸日期）。 */
const ISO_RE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;

/** 非 ISO 斜杠日期（2026/10/14）与时钟时间（10:30 / 10:30:00）：同样是动态值，不得报丢失。 */
const SLASH_DATE_RE = /\d{4}\/\d{1,2}\/\d{1,2}/g;
const CLOCK_TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

/** 动态倒计时注记（renderRecentLines 产物：「（今天 · 30 天后过期）」「N 天前」）。 */
const COUNTDOWN_BLOCK_RE = /（[^）]*(?:天后过期|天前)[^）]*）|\([^)]*(?:天后过期|天前)[^)]*\)/g;
const COUNTDOWN_TAIL_RE = /\d+\s*(?:天后过期|天前)/g;

/**
 * 动态倒计时注记的英文镜像（与 COUNTDOWN_TAIL_RE 同口径：数字 + 时段 + 剩余/经过语义）。
 * 中文收「N 天后过期」与「N 天前」两类，英文对应「N days left/remaining/to go」与「N days ago」，
 * 如「30 days left」「4 hours remaining」「12 minutes to go」「30 days ago」。
 * 只收「剩余/倒计时」与「N 前」这类动态值，不碰普通数字句
 * （「30 days before cutover」「30 days later」中文无镜像，照常比对）。
 */
const COUNTDOWN_EN_TAIL_RE = /\b\d+\s*(?:days?|hours?|hrs?|minutes?|mins?)\s+(?:left|remaining|to\s+go|ago)\b/gi;

/**
 * 字节尺寸（4KB/8MB/1024 字节）。
 * 单位只收 kb/mb/gb/tb/pb（含 KiB 等二进制写法）与「字节」前缀；
 * 不含裸 b —— 否则「3 boxes」「269 beans」会被当成 「3b」「269b」，还会劫持普通数字。
 */
const BYTESIZE_RE = /(\d+(?:[.,]\d+)?)\s?((?:[kmgt]i?b)|字节)/gi;
const SEMVER_RE = /v?\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?/gi;
/**
 * 十六进制串（≥6 位）：必须同时含数字与 a-f 字母。
 * 两个 lookahead 缺一不可——只要求含 a-f 会把 decade/facade/defaced 这类普通英文词当 hex；
 * 只要求含数字会把纯数字串（123456）当 hex（那是 number 的活）。
 */
const HEX_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/gi;
const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

/** 清洗参与抽取的文本：剥索引行、ISO/斜杠日期、时钟时间、倒计时注记（先剥再扫，防误抽）。 */
export function scrubDynamicText(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (INDEX_LINE_RE.test(line)) continue;
    out.push(
      line
        .replace(COUNTDOWN_BLOCK_RE, " ")
        .replace(COUNTDOWN_TAIL_RE, " ")
        .replace(COUNTDOWN_EN_TAIL_RE, " ")
        .replace(ISO_RE, " ")
        .replace(SLASH_DATE_RE, " ")
        .replace(CLOCK_TIME_RE, " "),
    );
  }
  return out.join("\n");
}

/**
 * 剥 frontmatter，只留正文（首个 --- 块之后的内容）。
 * 思路同 lib/global-store.js 的 stripFrontmatter 与 lib/safety.js 的 bodyOnly（「首行 --- + 收尾 --- 之后即正文」），
 * 这里内联一份：hardfact.js 被 safety.js 反向依赖，import global-store 会成环。
 * 与那两处相比收紧两点，避免误伤正文：收尾分隔行必须独占一行（「---」或「...」）；
 * 块内每行都得是空行 / YAML 形态（键值、列表、注释），否则视为正文里拿 --- 当分隔线的写法，整段不剥。
 */
function stripFrontmatterBlock(text) {
  const lines = String(text ?? "").split("\n");
  if (lines[0]?.trim() !== "---") return lines.join("\n");
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "---" || trimmed === "...") return lines.slice(i + 1).join("\n");
    if (trimmed !== "" && !/^(?:#|-\s|[A-Za-z_][\w-]*\s*:)/.test(trimmed)) return lines.join("\n");
  }
  return lines.join("\n"); // 没收尾分隔行：不是 frontmatter，原文照返
}

function normalizeNumber(raw) {
  const plain = String(raw).replace(/,/g, "");
  if (/^\d+$/.test(plain)) return plain.replace(/^0+(?=\d)/, "");
  return plain;
}

function collectSpans(scrubbed) {
  const spans = [];
  const scan = (re, type, priority, toToken) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(scrubbed)) !== null) {
      const raw = m[0];
      const token = toToken(m);
      if (token === null) continue;
      spans.push({ start: m.index, end: m.index + raw.length, type, priority, token, raw });
    }
  };
  scan(BYTESIZE_RE, "bytesize", 4, (m) => {
    const value = normalizeNumber(m[1]);
    const unit = m[2].toLowerCase() === "字节" ? "b" : m[2].toLowerCase();
    // 字节大小本身就是硬事实，不套「≥2 位数字」门槛（否则 4KB/8MB 这类单位数
    // 尺寸会被整条丢掉——单位已经把语义钉死，不会与编号类数字混淆）。
    if (value.length === 0 || !Number.isFinite(parseFloat(value))) return null;
    return value + unit;
  });
  scan(SEMVER_RE, "semver", 3, (m) => m[0].toLowerCase().replace(/^v/, ""));
  scan(HEX_RE, "hex", 2, (m) => m[0].toLowerCase());
  scan(NUMBER_RE, "number", 1, (m) => {
    const value = normalizeNumber(m[0]);
    return value.replace(/[.]/g, "").length >= 2 ? value : null;
  });
  // 重叠消解：高优先级（bytesize>semver>hex>number）吃掉低优先级重叠 span
  spans.sort((a, b) => a.start - b.start || b.priority - a.priority);
  const kept = [];
  for (const span of spans) {
    const clash = kept.some((k) => span.start < k.end && k.start < span.end);
    if (!clash) kept.push(span);
  }
  return kept;
}

/**
 * 抽硬事实 token（只抽正文：frontmatter 里的 name/描述/运行时字段数字不复参与比对）。
 * @returns Array<{ type, value, raw, numeric? }>
 */
export function extractHardFacts(text) {
  const spans = collectSpans(scrubDynamicText(stripFrontmatterBlock(text)));
  return spans.map((s) => ({
    type: s.type,
    value: s.token,
    raw: s.raw,
    numeric: s.type === "number" || s.type === "bytesize" ? parseFloat(s.token) : void 0,
  }));
}

function bytesizeNumeric(value) {
  const m = String(value).match(/^([\d.]+)([a-z]*)$/);
  if (m === null) return NaN;
  const scale = { "": 1, b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, pb: 1024 ** 5 };
  const unit = m[2] in scale ? m[2] : "";
  return parseFloat(m[1]) * scale[unit];
}

/** 近似替换判据：数值型 token 差值极小 = 誊写错误签名（269→267 报，346→412 不报）。 */
export function isNearMiss(oldToken, newToken) {
  if (oldToken.type !== newToken.type) return false;
  if (oldToken.type === "number" || oldToken.type === "bytesize") {
    const a = oldToken.type === "bytesize" ? bytesizeNumeric(oldToken.value) : parseFloat(oldToken.value);
    const b = newToken.type === "bytesize" ? bytesizeNumeric(newToken.value) : parseFloat(newToken.value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= Math.max(10, Math.abs(a) * 0.02);
  }
  return false; // semver/hex 的替换恒按有意更新处理（版本升位/换哈希）
}

/**
 * 新旧正文硬事实对比（两侧都先剥 frontmatter，只比正文 token）。
 * @returns { dropped: [{ type, value, raw, reason }], kept }
 *   reason: "pure-loss"（旧有新无，同类型全没了）| "near-miss"（被极近值顶掉，疑似写错）
 */
export function diffHardFacts(oldText, newText) {
  const oldTokens = extractHardFacts(oldText);
  const newTokens = extractHardFacts(newText);
  const newKeys = new Set(newTokens.map((t) => t.type + ":" + t.value));
  const dropped = [];
  for (const token of oldTokens) {
    if (newKeys.has(token.type + ":" + token.value)) continue;
    const sameType = newTokens.filter((t) => t.type === token.type);
    let reason = null;
    if (sameType.length === 0) reason = "pure-loss";
    else if (sameType.some((t) => isNearMiss(token, t))) reason = "near-miss";
    if (reason !== null) dropped.push({ type: token.type, value: token.value, raw: token.raw, reason });
  }
  return { dropped, kept: newTokens.length };
}

// ---- 统一 diff 片段（extraction-errors.log 附件，≤2KB）----

function splitLines(text) {
  return String(text ?? "").split("\n");
}

/** LCS 中间段对齐（前缀/后缀先裁掉；超大中间段退化为整段替换 hunk）。 */
function diffMiddle(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  if (n > 1200 || m > 1200) {
    return [
      ...oldLines.map((l) => ({ op: "-", text: l })),
      ...newLines.map((l) => ({ op: "+", text: l })),
    ];
  }
  // DP LCS（行粒度）
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { ops.push({ op: " ", text: oldLines[i] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: "-", text: oldLines[i] }); i += 1; }
    else { ops.push({ op: "+", text: newLines[j] }); j += 1; }
  }
  while (i < n) { ops.push({ op: "-", text: oldLines[i] }); i += 1; }
  while (j < m) { ops.push({ op: "+", text: newLines[j] }); j += 1; }
  return ops;
}

/**
 * 统一 diff 片段（含 @@ hunk 头、± 行、上下文行），截到 maxChars（默认 2048）。
 * 只对变更区给出上下文，避免长文全量进日志。
 */
export function unifiedDiffSnippet(oldText, newText, { maxChars = 2048, context = 2 } = {}) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const oldMid = a.slice(prefix, a.length - suffix);
  const newMid = b.slice(prefix, b.length - suffix);
  const ops = [
    ...a.slice(Math.max(0, prefix - context), prefix).map((l) => ({ op: " ", text: l })),
    ...diffMiddle(oldMid, newMid),
    ...b.slice(b.length - suffix, b.length - suffix + Math.min(context, suffix)).map((l) => ({ op: " ", text: l })),
  ];
  const start = Math.max(1, prefix - context + 1);
  const header = "@@ -" + start + "," + (prefix + oldMid.length + suffix) + " +" + start + "," + (prefix + newMid.length + suffix) + " @@";
  const lines = [header];
  for (const item of ops) lines.push(item.op + item.text);
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + "\n[...diff truncated...]";
  return out;
}

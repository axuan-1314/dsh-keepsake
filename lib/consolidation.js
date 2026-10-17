// dsh-keepsake 记忆整理建议引擎（纯函数、确定性输出、零依赖、不做任何 IO）。
//
// 定位：只出「建议」，不动磁盘。接线层从磁盘拼好两份现状传进来——
//   条目描述数组：[{ name, category, title, body, mtimeMs }]
//   分类索引现状：[{ category, lines:[索引行原文], files:[磁盘文件名] }]
// 本模块据此算出四项建议，调用方（面板/整理流程）自行决定怎么展示、是否执行：
//   findDuplicates   重复条目候选（跨分类同名 / 正文近重复 / 标题近重复且正文有重叠）
//   findStale        长期未更新的条目提醒（只提醒，绝不删）
//   auditIndex       索引与磁盘对账（悬挂行 / 漏登记的条目 / 空分类）
//   planIndexRepair  索引修复计划（只删悬挂行、只补漏行，绝不含删条目文件的动作）
//
// 确定性纪律：不自发读时钟（nowMs 由调用方给）、不依赖 Map/Set 之外的迭代巧合、
// 排序键全部显式补齐（同分项按 name → category → 输入下标兜底），
// 故同一份输入两次调用的输出逐字节相同，可直接进快照比对。
//
// 索引行口径与 lib/manifest.js 的 parseIndexContent 对齐（`- [Title](file.md) — 钩子`
// 形态，链接目标去空白、反斜杠转斜杠、小写归一），不自造格式。

/** 重复判定阈值（归一化正文的字符 bigram Jaccard）。 */
export const DUPLICATE_THRESHOLDS = {
  /** 正文近重复：≥ 此值即判为「同一件事存了两遍」。 */
  body: 0.85,
  /** 标题近重复（配合正文重叠使用）。 */
  title: 0.8,
  /** 标题近重复时要求的正文重叠下限。 */
  overlap: 0.6,
};

/** 陈旧提醒的默认天数阈值（90 天未更新才提醒）。 */
export const DEFAULT_STALE_DAYS = 90;

/** 一天的毫秒数（陈旧天数换算用）。 */
const DAY_MS = 86_400_000;

// ---- 归一化需要的码点区间（用码点常量表达，源码里不出现裸控制符）----
const CP_NUL = 0x0000;
const CP_US = 0x001f;
const CP_DEL = 0x007f;
const CP_C1_END = 0x009f;
const CP_SHY = 0x00ad;
const CP_ALM = 0x061c;
const CP_ZWSP = 0x200b;
const CP_RLO = 0x200f;
const CP_LRE = 0x202a;
const CP_RLE = 0x202e;
const CP_WJ = 0x2060;
const CP_NADS = 0x2069;
const CP_BOM = 0xfeff;
/** 全角 ASCII 起止码点（U+FF01～U+FF5E）与偏移（U+FF01 − 0xFEE0 = U+0021）。 */
const CP_FULLWIDTH_START = 0xff01;
const CP_FULLWIDTH_END = 0xff5e;
const FULLWIDTH_OFFSET = 0xfee0;
/** 表意空格 U+3000（全角空格，单独归一为半角空格）。 */
const CP_IDEOGRAPHIC_SPACE = 0x3000;

/** 判断码点是否落在若干闭区间之一。 */
function inRanges(code, ranges) {
  for (let i = 0; i < ranges.length; i += 2) {
    if (code >= ranges[i] && code <= ranges[i + 1]) return true;
  }
  return false;
}

/** 控制符/不可见符/bidi 控制符区间表（与 lib/filename.js 同口径：剥除而非拒绝）。 */
const CONTROL_RANGES = [
  CP_NUL, CP_US,
  CP_DEL, CP_C1_END,
  CP_SHY, CP_SHY,
  CP_ALM, CP_ALM,
  CP_ZWSP, CP_RLO,
  CP_LRE, CP_RLE,
  CP_WJ, CP_NADS,
  CP_BOM, CP_BOM,
];

/** 剥控制符/不可见符/bidi（逐码点，不做正则，源码保持可读）。 */
function stripInvisible(text) {
  const chars = Array.from(String(text ?? ""));
  const kept = [];
  for (const ch of chars) {
    const code = ch.codePointAt(0);
    if (code === CP_IDEOGRAPHIC_SPACE) {
      kept.push(" "); // 表意空格 → 半角空格（后续统一按空白去掉）
      continue;
    }
    if (inRanges(code, CONTROL_RANGES)) continue;
    kept.push(ch);
  }
  return kept.join("");
}

/** 全角 ASCII → 半角（U+FF01–U+FF5E 减 0xFEE0）。 */
function foldWidthChars(text) {
  const chars = Array.from(String(text ?? ""));
  const out = [];
  for (const ch of chars) {
    const code = ch.codePointAt(0);
    if (code >= CP_FULLWIDTH_START && code <= CP_FULLWIDTH_END) {
      out.push(String.fromCharCode(code - FULLWIDTH_OFFSET));
      continue;
    }
    out.push(ch);
  }
  return out.join("");
}

/** 名称/标题归一：剥控制符 → 全角转半角 → 小写 → 去全部空白（My Note.md 与全角写法归一后相同）。 */
export function normalizeKey(value) {
  return foldWidthChars(stripInvisible(value)).toLowerCase().replace(/\s+/g, "");
}

/** 剥 frontmatter（首个 --- 块），口径对齐 lib/global-store.js 的 stripFrontmatter。 */
function stripFrontmatterBlock(text) {
  const raw = String(text ?? "");
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return raw;
  return raw.slice(end + 4);
}

/** 正文归一：剥 frontmatter、剥控制符/bidi、全角转半角、小写、去全部空白。 */
export function normalizeBody(value) {
  return foldWidthChars(stripInvisible(stripFrontmatterBlock(value)))
    .toLowerCase()
    .replace(/\s+/g, "");
}

/** 字符 bigram 集合（按码点切，中文不裂成半个字）。 */
function bigrams(text) {
  const chars = Array.from(text);
  const out = new Set();
  for (let i = 0; i + 1 < chars.length; i += 1) out.add(`${chars[i]}${chars[i + 1]}`);
  return out;
}

/**
 * 两段文本的字符 bigram Jaccard 相似度（0~1，先归一化再算）。
 * 两边都为空时返回 0 —— 「都没有内容」不是相似的证据，不冒充重复。
 */
export function bigramJaccard(left, right) {
  const a = bigrams(normalizeBody(left));
  const b = bigrams(normalizeBody(right));
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** 三位小数（分数只用于排序与展示，收敛浮点噪声）。 */
const round3 = (value) => Math.round(value * 1000) / 1000;

/** 稳定比较：不碰与 locale 相关的字符串比较，逐码点比大小。 */
function compareText(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---- 1. 重复条目候选 ----

/**
 * 找出可能存重的条目对。
 * @param entries Array<{ name, category, title?, body?, mtimeMs? }>
 * @returns Array<{ a, b, score, why }> a/b 为条目 name，score 0~1，why 为人话原因。
 *   不自我配对、同一对只报一次、按 score 降序 + name 升序稳定排序。
 */
export function findDuplicates(entries) {
  const prepared = prepareEntries(entries);
  const found = [];
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const signal = evaluatePair(prepared[i], prepared[j]);
      if (signal !== null) found.push(signal);
    }
  }
  found.sort(
    (x, y) =>
      y.score - x.score // 分数降序
      || compareText(x.a, y.a) // 同分按名字升序
      || compareText(x.b, y.b)
      || x.ia - y.ia // 最终兜底：输入顺序，保证逐字节可复现
      || x.ib - y.ib,
  );
  return found.map(({ a, b, score, why }) => ({ a, b, score, why }));
}

/** 条目预处理：只做纯计算，脏数据（null/缺字段）一律降级为空串而非抛错。 */
function prepareEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const out = [];
  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index];
    if (raw === null || typeof raw !== "object") continue;
    const name = typeof raw.name === "string" ? raw.name : "";
    const title = typeof raw.title === "string" && raw.title.length > 0 ? raw.title : name;
    const titleKey = normalizeKey(title);
    const bodyText = normalizeBody(raw.body);
    out.push({
      index,
      name,
      category: typeof raw.category === "string" ? raw.category : "",
      nameKey: normalizeKey(name),
      titleKey,
      titleGrams: bigrams(titleKey),
      bodyText,
      bodyGrams: bigrams(bodyText),
    });
  }
  return out;
}

/**
 * 一对条目的信号判定。三类信号分别计分，取分数最高者；
 * 同分时按声明顺序（同名 > 正文 > 标题）保留前者，故同一对的输出永远唯一。
 */
function evaluatePair(x, y) {
  const [a, b] = orderPair(x, y);
  // 同一条被重复传入（name + category 都相同）：那是同一条，不是"存了两遍"，不配对。
  if (a.name === b.name && a.category === b.category) return null;
  const bodyJ = jaccardOf(a.bodyGrams, b.bodyGrams);
  const bodyExact = a.bodyText.length > 0 && a.bodyText === b.bodyText;
  const candidates = [];

  // ① 不同分类下同名（归一化后一致：去空白、全半角、大小写）
  if (a.nameKey.length > 0 && a.nameKey === b.nameKey && a.category !== b.category) {
    candidates.push({ score: 0.9, why: "两个条目在不同分类下用了同一个名字（归一化后同名）" });
  }
  // ② 正文近重复（归一化后完全相等，或 bigram ≥ 0.85）
  if (bodyExact) {
    candidates.push({ score: 0.98, why: "两个条目正文完全相同" });
  } else if (bodyJ >= DUPLICATE_THRESHOLDS.body) {
    candidates.push({ score: round3(bodyJ), why: "两个条目正文高度重叠" });
  }
  // ③ 标题近重复 且 正文有重叠（bigram ≥ 0.6）
  const titleNear = a.titleKey.length > 0 && (a.titleKey === b.titleKey || jaccardOf(a.titleGrams, b.titleGrams) >= DUPLICATE_THRESHOLDS.title);
  if (titleNear && bodyJ >= DUPLICATE_THRESHOLDS.overlap) {
    candidates.push({ score: round3(Math.min(0.9, 0.5 + 0.5 * bodyJ)), why: "两个条目标题相近，且正文有重叠" });
  }

  let best = null;
  for (const candidate of candidates) {
    // 严格大于才替换：同分保留优先级更高的那条
    if (best === null || candidate.score > best.score) best = candidate;
  }
  if (best === null) return null;
  return { a: a.name, b: b.name, score: best.score, why: best.why, ia: a.index, ib: b.index };
}

/** 一对条目的输出顺序：名字升序，同名时按输入下标（与调用方给的顺序无关）。 */
function orderPair(x, y) {
  const byName = compareText(x.name, y.name);
  if (byName !== 0) return byName < 0 ? [x, y] : [y, x];
  return x.index <= y.index ? [x, y] : [y, x];
}

function jaccardOf(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// ---- 2. 长期未更新提醒 ----

/**
 * 找出长期未更新的条目（只提醒，不删任何东西）。
 * @param entries Array<{ name, category, mtimeMs }>
 * @param options { nowMs, olderThanDays = 90 }
 * @returns Array<{ name, category, kind, lastModifiedAt, days }>
 *   kind="stale" 时 days 为取整后的天数；kind="unknown-age" 时 lastModifiedAt/days 为 null
 *   —— mtime 缺失或非法就如实说「不知道」，不拿 0 或当前时间冒充。
 */
export function findStale(entries, options = {}) {
  const opts = options === null || typeof options !== "object" ? {} : options;
  const now = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const limit = Number.isFinite(opts.olderThanDays) && opts.olderThanDays >= 0 ? opts.olderThanDays : DEFAULT_STALE_DAYS;
  const list = Array.isArray(entries) ? entries : [];
  const out = [];
  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index];
    if (raw === null || typeof raw !== "object") continue;
    const name = typeof raw.name === "string" ? raw.name : "";
    const category = typeof raw.category === "string" ? raw.category : "";
    const mtime = Number(raw.mtimeMs);
    if (!Number.isFinite(mtime) || mtime <= 0) {
      out.push({ name, category, kind: "unknown-age", lastModifiedAt: null, days: null, rank: 1, daysKey: 0, index });
      continue;
    }
    const days = Math.floor((now - mtime) / DAY_MS);
    // 时钟倒挂（mtime 在未来）会算出负天数：那不是「陈旧」，按不提醒处理，也不谎报年龄。
    if (days < limit) continue;
    out.push({ name, category, kind: "stale", lastModifiedAt: new Date(mtime).toISOString(), days, rank: 0, daysKey: days, index });
  }
  out.sort(
    (x, y) =>
      x.rank - y.rank // 能算出年龄的排在前面，年龄未知的垫底
      || y.daysKey - x.daysKey // 天数降序（越久越靠前）
      || compareText(x.name, y.name)
      || compareText(x.category, y.category)
      || x.index - y.index,
  );
  return out.map(({ name, category, kind, lastModifiedAt, days }) => ({ name, category, kind, lastModifiedAt, days }));
}

// ---- 3. 索引对账 ----

/**
 * 索引行形态：`- [Title](file.md) …`，链接目标为捕获组 1。
 * 与 lib/manifest.js 的 parseIndexContent 逐字一致（含 em-dash/en-dash/冒号/连字符四种分隔符）。
 */
const INDEX_LINE_RE = /^\s*-\s*\[[^\]]*\]\(([^)]+\.md)\)\s*[—:-–]?\s*(.*)$/i;

/** 索引文件名（保留，不是条目；磁盘清单里出现也不算漏登记的条目）。 */
const INDEX_FILE_NAME = "memory.md";

/**
 * 从索引行原文里推断它指向的条目文件名。
 * 口径对齐 lib/manifest.js 的 parseIndexContent：去空白、反斜杠转斜杠、小写归一。
 * @returns 归一化文件名；该行不是索引行（标题/空行/说明文字）时返回 null。
 */
export function indexLineFile(line) {
  const matched = String(line ?? "").match(INDEX_LINE_RE);
  if (matched === null) return null;
  return matched[1].trim().replace(/\\/g, "/").toLowerCase();
}

/** 磁盘文件名归一（与索引行同一口径，便于比对）。 */
function normalizeDiskName(name) {
  return String(name ?? "").trim().replace(/\\/g, "/").toLowerCase();
}

/** 是否为索引文件本身（不是条目，不参与漏登记判定）。 */
function isIndexFileName(name) {
  const normalized = normalizeDiskName(name);
  return normalized === INDEX_FILE_NAME || normalized.endsWith(`/${INDEX_FILE_NAME}`);
}

/**
 * 索引与磁盘对账。
 * @param indexStatus Array<{ category, lines:[索引行原文], files:[磁盘文件名] }>
 * @returns { dangling, orphans, emptyCategories }
 *   dangling  [{ category, line, name }]  索引行指向的文件磁盘上已不存在（悬挂行）
 *   orphans   [{ category, name }]        磁盘有条目文件，索引里却没有这一行（漏登记）
 *   emptyCategories [category]            有分类索引但零条目
 */
export function auditIndex(indexStatus) {
  const groups = Array.isArray(indexStatus) ? indexStatus : [];
  const dangling = [];
  const orphans = [];
  const empty = new Set();

  for (const group of groups) {
    if (group === null || typeof group !== "object") continue;
    const category = typeof group.category === "string" ? group.category : "";
    const lines = Array.isArray(group.lines) ? group.lines : typeof group.lines === "string" ? group.lines.split("\n") : [];
    const files = Array.isArray(group.files) ? group.files : [];

    // 磁盘条目文件（剔除索引文件本身）
    const entryFiles = [];
    const disk = new Set();
    for (const file of files) {
      if (typeof file !== "string" || file.trim().length === 0) continue;
      if (isIndexFileName(file)) continue;
      entryFiles.push(file);
      disk.add(normalizeDiskName(file));
    }

    // 索引行 → 文件名（同名只留首行，与 parseIndexContent 的口径一致）
    const indexed = new Map();
    for (const line of lines) {
      if (typeof line !== "string") continue;
      const file = indexLineFile(line);
      if (file === null) continue; // 非索引行：不参与对账
      if (!indexed.has(file)) indexed.set(file, line);
    }

    for (const [file, line] of indexed) {
      if (!disk.has(file)) dangling.push({ category, line, name: file });
    }
    for (const file of entryFiles) {
      if (!indexed.has(normalizeDiskName(file))) orphans.push({ category, name: file });
    }
    if (entryFiles.length === 0) empty.add(category);
  }

  dangling.sort((x, y) => compareText(x.category, y.category) || compareText(x.name, y.name) || compareText(x.line, y.line));
  orphans.sort((x, y) => compareText(x.category, y.category) || compareText(x.name, y.name));
  return { dangling, orphans, emptyCategories: [...empty].sort(compareText) };
}

// ---- 4. 索引修复计划 ----

/**
 * 由对账结果生成纯索引修复计划（删悬挂行 + 补漏行）。
 * 只动索引行，绝不含删除条目文件的动作——条目去留由用户决定。
 * 幂等：对已经对上账的状态返回空计划；同一份对账结果两次调用输出一致。
 * @param audit auditIndex 的返回值
 * @returns Array<{ type:"remove-line", category, line } | { type:"add-line", category, name, title? }>
 *   先删后补（删行全在前、补行全在后），各自按分类 + 行原文/文件名升序，输出顺序稳定。
 */
export function planIndexRepair(audit) {
  const source = audit === null || typeof audit !== "object" ? {} : audit;
  const dangling = Array.isArray(source.dangling) ? source.dangling : [];
  const orphans = Array.isArray(source.orphans) ? source.orphans : [];
  const removes = [];
  const adds = [];
  const seenRemove = new Set();
  const seenAdd = new Set();

  for (const item of dangling) {
    if (item === null || typeof item !== "object") continue;
    const category = typeof item.category === "string" ? item.category : "";
    const line = typeof item.line === "string" ? item.line : "";
    if (line.length === 0) continue;
    const key = `${category} ${line}`;
    if (seenRemove.has(key)) continue;
    seenRemove.add(key);
    removes.push({ type: "remove-line", category, line });
  }
  for (const item of orphans) {
    if (item === null || typeof item !== "object") continue;
    const category = typeof item.category === "string" ? item.category : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (name.length === 0 || isIndexFileName(name)) continue;
    const key = `${category} ${name}`;
    if (seenAdd.has(key)) continue;
    seenAdd.add(key);
    const op = { type: "add-line", category, name };
    const title = titleFromName(name);
    // title 只是兜底（去扩展名的文件名）；接线层可用条目 frontmatter 的真标题覆盖
    if (title !== null) op.title = title;
    adds.push(op);
  }

  removes.sort((x, y) => compareText(x.category, y.category) || compareText(x.line, y.line));
  adds.sort((x, y) => compareText(x.category, y.category) || compareText(x.name, y.name));
  return [...removes, ...adds];
}

/** 由文件名派生兜底标题（取末段、去 .md）；派生不出返回 null（此时不写 title 字段）。 */
function titleFromName(name) {
  const segments = String(name).replace(/\\/g, "/").split("/").filter((s) => s.length > 0);
  const last = segments.length > 0 ? segments[segments.length - 1] : "";
  const title = last.replace(/\.md$/i, "").trim();
  return title.length > 0 ? title : null;
}

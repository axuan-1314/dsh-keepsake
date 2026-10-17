// dsh-keepsake 面板纯逻辑（导入解析/预览行模型/主题映射/档位决策）。
//   双端 ESM：Node 测试 import（检查），面板 <script type="module"> 经
//   /dsh-keepsake/panel/panel-logic.js 路由引用。零 node 依赖、零 DOM 依赖
//   （主题映射收 document 参数，不直接触全局）。

// ---- 人设预设模板（简洁/专业/幽默/伙伴/自定义五档 + 恢复默认） ----
export const PERSONA_PRESETS = [
  {
    id: "concise",
    label: "简洁",
    content: "# 补充人设\n\n- 回答尽量简短，一两句话说清重点。\n- 不解释常识，不铺垫客套。\n- 不确定就直接说不知道。",
  },
  {
    id: "professional",
    label: "专业",
    content: "# 补充人设\n\n- 以资深工程师的严谨回答问题：结论先行，论据充分。\n- 涉及代码时给出可运行的完整示例与边界说明。\n- 主动指出方案的风险点与替代路径。",
  },
  {
    id: "humorous",
    label: "幽默",
    content: "# 补充人设\n\n- 回答可以带一点恰到好处的幽默与比喻，但不油腻、不抢信息主体。\n- 严肃技术内容保持准确，玩笑只作调味。",
  },
  {
    id: "companion",
    label: "伙伴",
    content: "# 补充人设\n\n- 像并肩工作的伙伴一样交流：平等、直接、有温度。\n- 会记住我们之前的讨论，主动承接上下文。\n- 我卡壳时先帮我理清问题，再给建议。",
  },
  { id: "custom", label: "自定义", content: "" }, // 自定义 = 保留当前内容（仅切换态，不覆盖文本）
];

// ---- 导入解析（面板侧：文件/粘贴文本 → dryRun 请求体；预览行模型） ----

/** 由文件名与内容推断导入格式：json / markdown-split / markdown-whole。 */
export function detectImportFormat(filename, text) {
  const name = String(filename ?? "").toLowerCase();
  if (name.endsWith(".json")) return "json";
  const trimmed = String(text ?? "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (/^##\s+/m.test(trimmed)) return "markdown-split";
  return "markdown-whole";
}

/** 组装 dryRun/confirm 请求体（与 host planImport 的 payload 契约一致）。 */
export function buildImportRequest(category, format, text, title = "") {
  if (format === "json") {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: "JSON 解析失败，请检查文件内容" };
    }
    return { ok: true, body: { category, format, payload: parsed } };
  }
  return { ok: true, body: { category, format, payload: { markdown: text, title } } };
}

/** markdown 导入的标题推断（面板侧修复）：首 ## 标题 → 首任意级标题 → 首行；
 *  空/纯空白返回 ""（交服务端兜底）。截 60 与服务端 title 上限对齐。 */
export function importTitleOf(format, text) {
  if (format === "json") return "";
  const t = String(text ?? "");
  let m = t.match(/^##\s+([^\n]+)/m);
  if (!m) m = t.match(/^#{1,6}\s+([^\n]+)/m);
  if (!m) m = t.match(/([^\s#][^\n]*)/); // 首个非空非 # 行
  const title = (m ? m[1] : "").replace(/[\s#]+$/, "").trim();
  return title.slice(0, 60);
}

/**
 * dryRun 响应 → 预览行模型（含冲突标红位）。
 * @returns rows: [{category, name, title, action: "add"|"overwrite"|"rename", danger: boolean, preview}]
 */
export function previewRowsOf(plans) {
  return (plans ?? []).map((plan) => ({
    category: plan.category,
    name: plan.name,
    title: plan.title,
    action: plan.action,
    // 覆盖/批内改名 = 冲突标红（rename 为批内去重的动作值）
    danger: plan.action === "overwrite" || plan.action === "rename",
    preview: String(plan.content ?? "").slice(0, 80),
  }));
}

// ---- 主题映射（实证机制：样式表枚举 --dsw-alias-* + computed 取值） ----

/** 从指定 document 枚举 --dsw-alias-* 变量（样式表 cssRules 遍历 + body computed 取值）。 */
export function collectThemeVarsFromDoc(doc) {
  const vars = {};
  try {
    const computed = doc.defaultView.getComputedStyle(doc.body);
    const names = new Set();
    for (const sheet of Array.from(doc.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules ?? [])) {
        if (!rule || !rule.style) continue;
        for (let i = 0; i < rule.style.length; i += 1) {
          const n = rule.style[i];
          if (typeof n === "string" && n.startsWith("--dsw-alias-")) names.add(n);
        }
      }
    }
    for (const n of names) {
      const v = computed.getPropertyValue(n);
      if (typeof v === "string" && v.length > 0) vars[n] = v.trim();
    }
  } catch {
    /* 跨文档拒绝等：返回空（桥失败走降级） */
  }
  return vars;
}

/** 把主题变量写到目标元素 style 上。 @returns 应用条数 */
export function applyThemeVars(targetStyle, vars) {
  let applied = 0;
  for (const name of Object.keys(vars ?? {})) {
    if (!name.startsWith("--dsw-alias-")) continue;
    targetStyle.setProperty(name, vars[name]);
    applied += 1;
  }
  return applied;
}

// ---- 打开梯子档位决策（运行时梯子） ----

/**
 * 档位决策纯函数。
 * @param openResult window.open 返回值（null=被拦）
 * @param handshakeOk 2 秒内是否收到面板 ready 回执（openResult 非空时考察）
 * @returns "window" | "iframe" | "location"
 */
export function decideLadderTier(openResult, handshakeOk) {
  if (openResult === null || openResult === void 0) return "iframe";
  return handshakeOk ? "window" : "iframe"; // location 兜底由 iframe 加载失败再降
}

/** iframe 加载失败后的终极档位。 */
export function ladderFallbackOf(tier) {
  if (tier === "window") return "iframe";
  if (tier === "iframe") return "location";
  return "location";
}

/** 档位降级可见提示文案（门牌原位显示，不静默）。 */
export function ladderNoteOf(tier, reason = "") {
  const suffix = reason ? `（${reason}）` : "";
  if (tier === "iframe") return `新窗口不可用${suffix}，已改为内嵌模式`;
  if (tier === "location") return `内嵌模式不可用${suffix}，已改为跳转模式`;
  return "";
}

/** 「返回设置」分档决策：popup 关窗 / iframe 通知宿主收起 / 顶层按
 *  自身 hash 压栈步数回退（绕开面板内部路由历史），无历史才退应用根。 */
export function panelBackAction(hasOpener, hasParent, historyLength, hashSteps) {
  if (hasOpener) return { mode: "close" };
  if (hasParent) return { mode: "notify-host" };
  if (Number(historyLength) > 1) return { mode: "back", steps: Number(hashSteps) + 1 };
  return { mode: "root" };
}

// ---- 条目草稿客户端预检 ----

/** 字符串 UTF-8 字节数（emoji 密集内容按字符数看不到 64KB body 上限的真实占用）。 */
export function utf8Length(s) {
  try {
    return new TextEncoder().encode(String(s ?? "")).length;
  } catch {
    return String(s ?? "").length * 2; // TextEncoder 缺席时的粗略上界兜底
  }
}

/** 编辑/新增共用草稿校验：必填 + 20000 字符上限（与服务端拒绝而非截断对齐）
 *  + 60000 UTF-8 字节预检（body 64KB 上限留余量，避免字符数未超却撞 413 的困惑报错）。 */
export function validateEntryDraft(title, content, opts = {}) {
  const maxChars = opts.maxChars ?? 20000;
  const maxBytes = opts.maxBytes ?? 60000;
  const t = String(title ?? "");
  const c = String(content ?? "");
  if (t.trim().length === 0) return { ok: false, error: "标题必填（留空保存将被服务端静默回退旧标题）" };
  if (c.trim().length === 0) return { ok: false, error: "正文必填（空白正文会建出空条目）" };
  if (c.length > maxChars) {
    return { ok: false, error: `正文 ${c.length} 字符超过 ${maxChars} 字符上限——请精简后再保存（超长会被服务端拒绝）` };
  }
  const bytes = utf8Length(c);
  if (bytes > maxBytes) {
    return { ok: false, error: `正文 UTF-8 约 ${Math.ceil(bytes / 1024)}KB，超过 ${Math.ceil(maxBytes / 1024)}KB 请求上限（emoji 等多字节字符按字节计）——请拆分或精简` };
  }
  return { ok: true };
}

// ---- 近期动态年龄/过期（与 host renderRecentLines 同算法，面板展示用） ----

export function recentAgeOf(timestamp, now = Date.now()) {
  const ts = timestamp ? Date.parse(timestamp) : NaN;
  // 解析失败不冒充「今天」：时间戳坏了就说不知道（"—"），days 给 null 让调用方如实留白
  if (!Number.isFinite(ts)) return { days: null, text: "—" };
  const days = Math.floor((now - ts) / 86400_000);
  const text = days <= 0 ? "今天" : days === 1 ? "1 天前" : `${days} 天前`;
  return { days, text };
}

/** 距离过期还剩几天：keepDays（近期动态保留天数，来自 /state.recentKeepDays）减去已过天数，
 *  下限 0。keepDays 缺省或非法（缺失/NaN/≤0/非数字）一律落 30；时间戳解析不了 → null
 *  （不编造“还剩 N 天”，交调用方显示「—」）。 */
export function recentExpireDays(timestamp, keepDays, now = Date.now()) {
  const keep = Number.isFinite(Number(keepDays)) && Number(keepDays) > 0 ? Math.floor(Number(keepDays)) : 30;
  const { days } = recentAgeOf(timestamp, now);
  if (days === null) return null;
  return Math.max(0, keep - days);
}

// ---- 长期记忆客户端即时检索 ----

/** 标题/描述/正文三字段小写包含过滤（query 空 = 全量）。 */
export function filterEntries(entries, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (q.length === 0) return entries ?? [];
  return (entries ?? []).filter((e) =>
    String(e.title ?? "").toLowerCase().includes(q)
    || String(e.description ?? "").toLowerCase().includes(q)
    || String(e.content ?? "").toLowerCase().includes(q));
}

// ---- 源码模式序列化/解析（description 随注释往返不丢；进检查钉住） ----

/** 整类序列化：每条 = ## 标题 + name/desc 注释行 + 正文，条目间一行 --- 分隔。
 *  desc 换行折叠为空格（注释行是单行协议，换行会让解析正则失配丢 name）。 */
export function serializeEntries(entries) {
  return (entries ?? [])
    .map((e) => `## ${e.title}\n<!-- name: ${e.name}${e.description ? ` desc: ${String(e.description).replace(/-->/g, "--＞").replace(/[\r\n]+/g, " ")}` : ""} -->\n${e.content}`)
    .join("\n\n---\n\n");
}

/** 源码模式解析：split 后逐块匹配头部（title/name/desc）+ 正文；不合规块跳过。
 *  块首 trimStart：join("\n\n---\n\n") 与 split(/\n---\n/) 不对称，第二块起残留前导换行，
 *  不剥会让 ^## 锚定失败静默丢条目（存量 bug，本批修复）。 */
export function parseSourceText(text) {
  const entries = [];
  const blocks = String(text ?? "").split(/\r?\n---\r?\n/).map((b) => b.replace(/^\s+/, ""));
  for (const block of blocks) {
    const m = block.match(/^##\s+([^\n]+)\r?\n(?:<!--\s*name:\s*(\S+)\s*(?:desc:\s*([^\n]*?)\s*)?-->)?\r?\n?([\s\S]*)$/);
    if (!m) continue;
    const content = m[4].trim();
    if (content.length === 0) continue;
    entries.push({ title: m[1].trim(), name: m[2] ?? void 0, description: (m[3] ?? "").replace(/--＞/g, "-->"), content });
  }
  return entries;
}

// ---- 自动提取管道可观测（host 契约） ----
//   /state 新字段（extractionFailures.recent/retried/lastRecoveredAt、lastFailedRange、
//   extractionInFlight、lastAttemptAt、extractionConfig、lastUsedRoute、embeddingConfig）
//   新服务端恒在、缺失=旧版。这里只做归一与文案/三态判定，零 node 依赖零 DOM 依赖；
//   门牌（client.js 内联兜底同构）与面板 <script type="module"> 双端共用。

/** 失败分桶键（五存量桶 + 新增 retried/fallbackUsed；顺序即展示顺序）。 */
export const EXTRACTION_BUCKET_KEYS = ["no-route", "no-cwd", "llm-error", "parse-error", "io-error", "retried", "fallbackUsed"];

/** 嵌入配置草稿校验（面板侧；与服务端 settings 校验同口径的关键几条）。
 *  apiKey 只做「保留/清空」两种形态放行：缺省（键不在）或 null/undefined 均不校验——
 *  apiKey 键缺省 = 服务端保留已存密钥，apiKey:null = 显式清空，二者都不参与端点/模型校验。 */
export function validateEmbeddingDraft(draft) {
  const enabled = draft?.enabled === true;
  const baseUrl = typeof draft?.baseUrl === "string" ? draft.baseUrl.trim() : "";
  const model = typeof draft?.model === "string" ? draft.model.trim() : "";
  if (enabled && baseUrl.length === 0) return { ok: false, error: "开启语义召回需要填写嵌入端点 URL" };
  if (enabled && model.length === 0) return { ok: false, error: "开启语义召回需要填写嵌入模型名" };
  if (baseUrl.length > 0) {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      return { ok: false, error: "嵌入端点必须是绝对 http(s) URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: `嵌入端点必须是 http(s)（当前 ${parsed.protocol}）` };
    }
  }
  return { ok: true, error: "" };
}

/** 嵌入卡「清除已存 Key」按钮可见性：只认**面板自己保存的那份密钥**（/state.settings.embedding.apiKeySet===true）。
 *  密钥来自 entry config（cordis.patch.yml）时清不掉也不该清——改 YAML 才是正主，按钮不出现；
 *  /state 缺失 / 旧宿主 / settings 无 embedding / 未设 key → false（不渲染，不装样子）。 */
export function embeddingClearActionVisible(state) {
  const s = state && typeof state === "object" ? state.settings : null;
  const emb = s && typeof s === "object" ? s.embedding : null;
  return !!(emb && typeof emb === "object" && emb.apiKeySet === true);
}

/** 模型短名：取路径末段（"vendor/model-x" → "model-x"；门牌行1 模型）。
 *  无斜杠原样（"EmbeddingGemma 2" 一类本地嵌入模型名不受影响）；空/null → ""。 */
export function modelShortName(name) {
  const s = String(name ?? "").trim();
  if (!s) return "";
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 相对时间：刚刚 / N 秒 / N 分钟 / N 小时 / N 天前；超 30 天回落 YYYY-MM-DD 绝对日期；
 *  无效/空 → "—"。未来时间（时钟偏移）按「刚刚」，不出负数。
 *  入参接受毫秒数或 ISO 时间串——journal 落盘的 at 是 ISO（JSONL 要可读可排序），
 *  只认数字会让"最近提取记录"的整列时间恒为「—」。 */
export function relativeTimeOf(at, now = Date.now()) {
  let t = Number(at);
  if ((!Number.isFinite(t) || t <= 0) && typeof at === "string") {
    const parsed = Date.parse(at); // ISO 等可解析时间串
    if (Number.isFinite(parsed)) t = parsed;
  }
  if (!Number.isFinite(t) || t <= 0) return "—";
  const diff = Number.isFinite(now) ? now - t : Date.now() - t;
  if (diff < 10_000) return "刚刚";
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const days = Math.floor(diff / 86_400_000);
  if (days <= 30) return `${days} 天前`;
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** streak 归一：新形态对象取 streak、旧数字形态直接取值、缺失 0。
 *  双端新旧混搭的统一入口。 */
export function extractionStreakOf(efRaw) {
  if (efRaw && typeof efRaw === "object") return Number(efRaw.streak ?? 0);
  return Number(efRaw ?? 0);
}

/** 管道三态（+提取中）判定：
 *  - red：streak≥1（在途重试不粉饰，红灯照亮）；
 *  - busy：streak=0 且在途（灰灯闪烁 + 「提取中…」文案）；
 *  - yellow：24h 内恢复过（lastRecoveredAt 距今<24h）或（retried>0 且 streak=0）；
 *  - green：其余（streak 0 且非在途）。
 *  @param efRaw /state.extractionFailures（对象/数字/缺失皆可）
 *  @param extras { inFlight?: bool, now?: number }（inFlight 来自顶层 extractionInFlight） */
export function pipeHealthLevel(efRaw, extras = {}) {
  if (extractionStreakOf(efRaw) >= 1) return "red";
  if (extras.inFlight === true) return "busy";
  const now = Number.isFinite(extras.now) ? extras.now : Date.now();
  const ef = efRaw && typeof efRaw === "object" ? efRaw : null;
  const recovered = Number(ef && ef.lastRecoveredAt != null ? ef.lastRecoveredAt : 0);
  if (recovered > 0 && now - recovered < 24 * 3600_000) return "yellow";
  if (Number(ef && ef.retried != null ? ef.retried : 0) > 0) return "yellow";
  return "green";
}

/** 门牌红条行1：streak<1 → ""（不渲染）。新版取 recent[0] 的 reason + 模型末段，
 *  recent 空时 streakReason 兜底；旧服务端（无 recent 字段/纯数字形态）沿用旧单行
 *  文案——零回归。 */
export function extractionNoticeText(efRaw) {
  const streak = extractionStreakOf(efRaw);
  if (streak < 1) return "";
  const ef = efRaw && typeof efRaw === "object" ? efRaw : null;
  if (!ef || !Array.isArray(ef.recent)) {
    return `记忆自动提取最近连续失败 ${streak} 次，期间对话内容可能未被记录——可在记忆管理面板复制诊断信息（含 /state 快照）反馈给开发者。`;
  }
  const last = ef.recent.length > 0 ? ef.recent[0] : null;
  const reason = last && last.reason ? String(last.reason) : (ef.streakReason ? String(ef.streakReason) : "");
  const model = last && last.model ? modelShortName(last.model) : "";
  if (reason && model) return `自动提取失败 ${streak} 次 · 最近：${reason}（${model}）`;
  if (reason) return `自动提取失败 ${streak} 次 · 最近：${reason}`;
  return `自动提取失败 ${streak} 次`;
}

/** 门牌红条行2（收紧措辞）：streak>0 且 lastFailedRange 在场才有——「第 X 轮对话
 *  之后的内容尚未记录，恢复后自动补提」（说人话，不露 seq 内部术语）。会话已
 *  disposed/多会话场景不承诺具体区间一定补回。 */
export function extractionRangeText(efRaw, lastFailedRange) {
  if (extractionStreakOf(efRaw) < 1) return "";
  if (!lastFailedRange || typeof lastFailedRange !== "object") return "";
  const from = Number(lastFailedRange.from);
  if (!Number.isFinite(from)) return "";
  return `第 ${from} 轮对话之后的内容尚未记录，恢复后自动补提`;
}

/** 绝对时间（诊断文本用；面板展示用相对时间，报 bug 用绝对时间可对表）。 */
function fmtAbs(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return "—";
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 「复制诊断信息」纯文本组装：/state 版本 / 连击与病因 / 全量分桶（含零值，
 *  区别于 UI badge 的零值不渲染）/ 最近失败摘要（新在前 ≤5 条）/ 用车与在途 / 未恢复区间。
 *  旧服务端缺 recent 时给旧版说明行。message 截 200 并折叠换行（落盘同口径）。 */
export function diagnosticTextOf(state, now = Date.now()) {
  const s = state && typeof state === "object" ? state : {};
  const efRaw = s.extractionFailures;
  const ef = efRaw && typeof efRaw === "object" ? efRaw : null;
  const streak = extractionStreakOf(efRaw);
  const lines = [];
  lines.push("dsh-keepsake 提取管道诊断");
  lines.push(`生成时间：${fmtAbs(now)}`);
  lines.push(`/state 版本：${s.version != null ? String(s.version) : "未知（旧版宿主）"}`);
  lines.push(`连续失败：${streak}${ef && ef.streakReason ? `（原因：${ef.streakReason}）` : ""}`);
  lines.push(`分桶：${EXTRACTION_BUCKET_KEYS.map((k) => `${k} ${Number(ef && ef[k] != null ? ef[k] : 0)}`).join(" · ")}`);
  const recent = ef && Array.isArray(ef.recent) ? ef.recent : null;
  if (!recent) lines.push("最近失败：宿主版本较旧，未提供失败详情");
  else if (recent.length === 0) lines.push("最近失败：无记录");
  else {
    lines.push("最近失败：");
    for (const r of recent.slice(0, 5)) {
      const who = r && (r.provider || r.model) ? ` ${[r.provider, r.model].filter(Boolean).join("/")}` : "";
      const msg = String(r && r.message != null ? r.message : "").slice(0, 200).replace(/[\r\n]+/g, " ");
      lines.push(`- ${fmtAbs(r && r.at)} ${r ? String(r.reason ?? "") : ""}${who}${msg ? `：${msg}` : ""}`);
    }
  }
  const used = s.lastUsedRoute && typeof s.lastUsedRoute === "object" ? s.lastUsedRoute : null;
  lines.push(`最近一次提取用车：${used ? `${used.provider ?? "—"}/${used.model ?? "—"}（${relativeTimeOf(used.at, now)}）` : "尚无"}`);
  lines.push(`提取中：${s.extractionInFlight === true ? "是" : "否"}`);
  if (streak > 0 && s.lastFailedRange && typeof s.lastFailedRange === "object" && Number.isFinite(Number(s.lastFailedRange.from))) {
    lines.push(`未恢复区间：seq ${Number(s.lastFailedRange.from)} 之后`);
  }
  return lines.join("\n");
}

// ---- 最近提取记录（/state.extractionLog：runs 新在前 ≤30 条 + unrecovered） ----
//   为什么要有这条数据面：lastFailedRange 是进程内存态，DSH 一重启就归零，
//   失败区间在面板上就此隐身（用户只看到"一切正常"却实际丢了几轮的记忆）；
//   extractionLog.unrecovered 是服务端留痕，重启后仍能回答"哪些区间没提取上"。
//   口径同其它新字段：缺失/null/字段残缺一律 tolerant，旧版宿主零影响、绝不抛。

/** 提取原因 token → 中文显示的单一映射表（skipped / failed / zero-ops 共用）。
 *  中英混杂的 token（如 "model-无产出"、"ops-未落盘"）在这里归一为纯中文，
 *  避免生译文直接进面板。收录的是白盒枚举值；未收录的走 reasonLabelOf 兜底美化。 */
export const EXTRACTION_REASON_LABELS = {
  // skipped
  "direct-memory-write": "主 agent 直写记忆",
  "no-user-prose": "无有效用户发言",
  "gate-off": "对话记忆总开关关",
  "format-readonly": "存储格式只读保护",
  // failed
  "llm-error": "LLM 调用失败",
  "parse-error": "输出解析失败",
  "io-error": "落盘失败",
  "no-route": "无模型路由",
  "no-cwd": "会话无工作区",
  aborted: "中止",
  exception: "内部异常",
  // zero-ops
  "model-无产出": "模型无产出",
  "ops-未落盘": "改动未落盘",
};

/** 原因 token → 面板显示文本：收录的译成中文；未收录的原样透传但做兜底美化
 *  （连字符/下划线转空格再合并空白——好过把 "quota-exceeded" 直接糊在脸上）；
 *  空/纯空白 → "—"（不留空）。 */
export function reasonLabelOf(token) {
  const t = String(token ?? "").trim();
  if (t.length === 0) return "—";
  if (EXTRACTION_REASON_LABELS[t]) return EXTRACTION_REASON_LABELS[t];
  return t.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

/** 一条记录里的计数字段归一：缺/非数字/负数一律 0（面板不做负数展示）。 */
function extractionOpCountOf(run, key) {
  const n = Number(run ? run[key] : 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 区间标签（提取范围 explain）。两端都有效时 "seq 12..80"；只有一端就如实显示那一端；
 *  两端都缺/非法 → ""（由调用方决定怎么留白，不编造 seq 0）。 */
function extractionSeqRangeOf(from, to) {
  const f = Number(from);
  const t = Number(to);
  if (Number.isFinite(f) && Number.isFinite(t)) return `seq ${f}..${t}`;
  if (Number.isFinite(f)) return `seq ${f}`;
  if (Number.isFinite(t)) return `seq ..${t}`;
  return "";
}

/**
 * 单次提取结果的一行中文标签。
 * written → "已写 N 条"（N=writes+deletes；failedOps>0 附 "；落盘失败 M"——部分成功必须可见）
 * zero-ops → "无可记"；reason==='ops-未落盘' → "无可落盘（被过滤/跳过）"（本是没落盘，不是没内容）
 * skipped/failed/abandoned → "跳过：/失败：/已放弃：" + 中文化原因（统一映射表，未收录走 reasonLabelOf 兜底美化）
 * 未知/非法 outcome → "未知：<原值>"（不炸，让脏数据自己露出来）。
 */
export function extractionRunLabel(run) {
  const r = run && typeof run === "object" ? run : null;
  if (!r || r.outcome == null || String(r.outcome).length === 0) return "未知：—";
  const outcome = String(r.outcome);
  const reason = r.reason == null ? "" : String(r.reason);
  if (outcome === "written") {
    const text = `已写 ${extractionOpCountOf(r, "writes") + extractionOpCountOf(r, "deletes")} 条`;
    const failed = extractionOpCountOf(r, "failedOps");
    return failed > 0 ? `${text}；落盘失败 ${failed}` : text;
  }
  if (outcome === "zero-ops") return reason === "ops-未落盘" ? "无可落盘（被过滤/跳过）" : "无可记";
  if (outcome === "skipped") return `跳过：${reasonLabelOf(reason)}`;
  if (outcome === "failed") return `失败：${reasonLabelOf(reason)}`;
  if (outcome === "abandoned") return `已放弃：${reasonLabelOf(reason)}`;
  return `未知：${outcome}`;
}

/**
 * extractionLog → 展示行 [{at, range, label, sessionId}]（顺序即输入顺序，新在前）。
 * 入参既收整个 extractionLog 对象也收裸 runs 数组（面板两种拿法都能用）；
 * 整条坏记录（非对象/缺 outcome）跳过不留空行；at 原样透传（展示侧再转相对时间）。
 */
export function extractionRunLines(log) {
  const runs = Array.isArray(log) ? log
    : log && typeof log === "object" && Array.isArray(log.runs) ? log.runs
      : null;
  if (!runs) return [];
  const lines = [];
  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    if (run.outcome == null || String(run.outcome).length === 0) continue;
    lines.push({
      at: run.at,
      range: extractionSeqRangeOf(run.from, run.to),
      label: extractionRunLabel(run),
      sessionId: run.sessionId == null ? "" : String(run.sessionId),
    });
  }
  return lines;
}

/**
 * 未恢复区间提示（盘侧来源，重启后仍可见）：取第一条可得 from 的 unrecovered 项，
 * 文案与 extractionRangeText 同风格（说人话，不露 seq 内部术语）；
 * 空数组/非数组/全无合法 from（旧版宿主）→ ""。
 */
export function unrecoveredTextFromLog(unrecovered) {
  if (!Array.isArray(unrecovered)) return "";
  for (const item of unrecovered) {
    if (!item || typeof item !== "object") continue;
    const from = Number(item.from);
    if (Number.isFinite(from)) return `第 ${from} 轮对话之后的内容未提取`;
  }
  return "";
}

/**
 * 放弃区间红条（/state.extractionLog.abandoned：连续失败过多被放弃的区间）——
 * 与 unrecovered 红条的双源风格一致：盘侧留痕，重启后仍能看到"哪些区间不再自动补"。
 * 说人话，不露 seq 内部术语。空/非数组/无有效条目 → null（不渲染，旧版宿主零影响）。
 * @param abandonedItems /state.extractionLog.abandoned（数组；undefined=旧版宿主）
 * @returns {string|null} 展示文案；无有效条目 → null
 */
export function abandonedNoticeText(abandonedItems) {
  if (!Array.isArray(abandonedItems)) return null;
  const count = abandonedItems.filter((it) => it && typeof it === "object").length;
  if (count === 0) return null;
  return `有 ${count} 段对话的提取已放弃（连续失败过多），这部分记忆不会自动补上，可在下方最近提取记录查看明细`;
}

// ---- 注入面可观测（消息通道注入健康；/state.injection 服务端恒在，缺失=旧版） ----
//   纯逻辑、零 DOM：面板健康卡与门牌共用同一条摘要文案，避免双端漂移。

/**
 * 注入面摘要：injection 缺失（旧版宿主）/ 非对象 / 无注入且无异常 → null。
 * 有注入 → 「已注入 N 次 · 最近 X 字符」（可附 丢段 / 渲染失败 / 变更节流 N 次 / 取代 N 次）；
 * 全是渲染失败（count=0 但 renderFailures>0）→ 仍返回告警串（显式可见，不静默藏）。
 * throttled/superseded 是契约新增计数：字段缺失或零值不渲染（旧宿主零影响，不印 0 装饰）。
 * @param injection /state.injection（对象；undefined=旧版宿主）
 * @returns {string|null}
 */
export function injectionSummary(injection) {
  if (!injection || typeof injection !== "object") return null;
  const count = Number(injection.count ?? 0);
  const ok = Number.isFinite(count) && count > 0;
  const failures = Number(injection.renderFailures ?? 0);
  const hasFailures = Number.isFinite(failures) && failures > 0;
  if (!ok && !hasFailures) return null;
  if (!ok) return `注入异常 渲染失败 ${Math.floor(failures)} 次`;
  const lastChars = Number(injection.lastChars ?? 0);
  let text = `已注入 ${count} 次 · 最近 ${Number.isFinite(lastChars) && lastChars > 0 ? lastChars : 0} 字符`;
  const dropped = Number(injection.droppedSegments ?? 0);
  if (Number.isFinite(dropped) && dropped > 0) text += ` · 丢段 ${dropped}`;
  if (hasFailures) text += ` · 渲染失败 ${failures}`;
  const extra = injectionExtraText(injection);
  if (extra) text += ` · ${extra}`;
  return text;
}

// ---- 会话补提清单（GET /sessions/pending 契约行模型；缺失=旧宿主，不渲染） ----
//   纯逻辑零 DOM：一行「未恢复/已放弃区间」的文案全在这里算，面板只负责渲染与按钮。
//   两条口径写死：
//   ① 不空承诺——会话当前读不回来（sessionAvailable=false）就明说，不挂可点按钮；
//   ② 不露 seq——区间文案复用「第 X 轮对话之后」人话（与门牌红条同风格）。

/** 补提清单行文案（单行：人话标签 + 时间 + 区间 + 原因）。
 *  kind=failed→「未恢复」/ abandoned→「已放弃」（lib/session-recovery.js normalizePendingItem
 *  的 kind 枚举就是这两个值）；reason 复用 EXTRACTION_REASON_LABELS 口径美化（reasonLabelOf）；
 *  时间走 relativeTimeOf（接受 ISO 串或毫秒）；区间说人话不露 seq。
 *  整条坏行（非对象）→ null（调用方跳过，不渲染空行）。 */
export function pendingItemLabel(item, now = Date.now()) {
  if (!item || typeof item !== "object") return null;
  const kind = String(item.kind ?? "");
  const kindText = kind === "failed" ? "未恢复" : kind === "abandoned" ? "已放弃" : "待补提";
  const from = Number(item.from);
  const rangeText = Number.isFinite(from) ? `第 ${from} 轮对话之后的内容` : "一段对话内容";
  const reason = reasonLabelOf(item.reason);
  return `${kindText}区间 · ${rangeText} · ${relativeTimeOf(item.at, now)} · ${reason}`;
}

/** 会话当前不可读时的如实说明（不空承诺「重开后自动续提」）。 */
export const PENDING_UNAVAILABLE_NOTE = "该会话当前不可读，重开会话后可自动续提";

/** 补提清单空态文案。 */
export const PENDING_EMPTY_TEXT = "没有待补的区间";

/** 补提发起后的忙碌提示（按钮进入三段式时显示）。 */
export const PENDING_RECOVERING_TEXT = "补提中…";

/** 宿主不支持会话读取（hostSupported=false）时的整块说明。 */
export function pendingHostNote(hostSupported) {
  if (hostSupported === false) {
    return "当前宿主不支持读取历史会话，无法在这里补提——升级宿主后可恢复该能力。";
  }
  return "";
}

// ---- 记忆整理建议（GET /maintenance/suggestions 契约；缺失=旧宿主，不渲染） ----

/** 重复建议一行的 score 百分比（0..1 → 整数百分比；非法 → 0，不印 NaN）。 */
export function duplicateScorePct(score) {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1) return 100;
  return Math.round(n * 100);
}

/** 久未更新一行的天数文案：kind="unknown-age" 或 days 非法 → 「年龄不可知」（不拿 0 冒充）。 */
export function staleDaysText(entry) {
  const e = entry && typeof entry === "object" ? entry : {};
  if (String(e.kind ?? "") === "unknown-age") return "年龄不可知";
  const n = Number(e.days);
  if (!Number.isFinite(n) || n < 0) return "年龄不可知";
  return `${Math.floor(n)} 天未更新`;
}

/** 记忆整理整组建议是否为空（三组全空 → 渲染「暂无建议」）。 */
export function maintenanceSuggestionsEmpty(suggestions) {
  const s = suggestions && typeof suggestions === "object" ? suggestions : {};
  const dup = Array.isArray(s.duplicates) ? s.duplicates : [];
  const stale = Array.isArray(s.stale) ? s.stale : [];
  const health = s.indexHealth && typeof s.indexHealth === "object" ? s.indexHealth : null;
  const dangling = health && Array.isArray(health.dangling) ? health.dangling : [];
  const orphans = health && Array.isArray(health.orphans) ? health.orphans : [];
  const emptyCats = health && Array.isArray(health.emptyCategories) ? health.emptyCategories : [];
  return dup.length === 0 && stale.length === 0 && dangling.length === 0 && orphans.length === 0 && emptyCats.length === 0;
}

/** 记忆整理空态文案。 */
export const MAINTENANCE_EMPTY_TEXT = "暂无建议";

/** 记忆整理底栏计数人话化（/maintenance/suggestions.counts）。
 *  已知键译中文：entries/indexes/entryTotal/indexTotal（成对时显示「条目 x/共 y」）；
 *  truncated 为 true 时补一行人话「条目过多，建议基于部分数据（前 500 条）」——不裸布尔；
 *  无可用键（空对象/脏值/非对象）→ "计数暂不可用"（容错，不炸）。 */
export function maintenanceCountsText(counts) {
  const c = counts && typeof counts === "object" ? counts : {};
  const num = (k) => {
    const raw = c[k];
    if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };
  const parts = [];
  const entries = num("entries");
  const entryTotal = num("entryTotal");
  if (entries !== null && entryTotal !== null) parts.push(`条目 ${entries}/${entryTotal}`);
  else if (entries !== null) parts.push(`条目 ${entries}`);
  else if (entryTotal !== null) parts.push(`条目总数 ${entryTotal}`);
  const indexes = num("indexes");
  const indexTotal = num("indexTotal");
  if (indexes !== null && indexTotal !== null) parts.push(`索引 ${indexes}/${indexTotal}`);
  else if (indexes !== null) parts.push(`索引 ${indexes}`);
  else if (indexTotal !== null) parts.push(`索引总数 ${indexTotal}`);
  if (parts.length === 0) return "计数暂不可用";
  let text = `计数：${parts.join(" · ")}`;
  if (c.truncated === true) text += "。条目过多，建议基于部分数据（前 500 条）";
  return text;
}

/** 索引健康三列标题（悬挂行/漏登记/空分类各一列）。 */
export const INDEX_HEALTH_COLUMNS = [
  { key: "dangling", label: "悬挂行", hint: "索引里有、文件已不在" },
  { key: "orphans", label: "漏登记", hint: "文件在、索引里没有" },
  { key: "emptyCategories", label: "空分类", hint: "有索引、零条目" },
];

/** 索引修复回显文案。服务端最终契约 = { ok:true, fixed:[{type,category,line?|name?}],
 *  fixedCount:number, unchanged:boolean }（fixed 为「已应用动作明细」数组）。
 *  按 fixed 的三种形态如实回显，任何形态都不撒谎：
 *   - 数组：空（或 unchanged）→ 「无需修复：索引与磁盘已经对上账」；非空 → 「已修复 N 处：」列明细；
 *   - 数字（旧服务端）：0 → 「无需修复」；N → 「已修复 N 处」；
 *   - 形状不明（缺字段/非对象/类型不认得）→ 「修复结果未知」，不拿「无需修复」冒充已对上账。 */
export function repairIndexResultText(out) {
  const o = out && typeof out === "object" ? out : {};
  const fixed = o.fixed;
  if (Array.isArray(fixed)) {
    if (o.unchanged === true || fixed.length === 0) return "无需修复：索引与磁盘已经对上账";
    const parts = fixed.map((f) => {
      const type = String(f && f.type != null ? f.type : "");
      const cat = String(f && f.category != null ? f.category : "");
      if (type === "remove-line") return `删悬挂行（${cat}）`;
      if (type === "add-line") return `补登记（${cat}）`;
      return `${type || "修复"}（${cat}）`;
    });
    return `已修复 ${parts.length} 处：${parts.join("、")}`;
  }
  if (typeof fixed === "number" && Number.isFinite(fixed)) {
    const n = Math.floor(fixed);
    if (n <= 0) return "无需修复：索引与磁盘已经对上账";
    return `已修复 ${n} 处`;
  }
  return "修复结果未知";
}

// ---- 管道健康卡状态优先级（绿红并置修正） ----
//   老逻辑里绿态只看 streak/inFlight/lastRecovered，出现「绿灯 + 红条」并置：
//   一行说「最近无失败」，一行说「有区间没提取上」——两条都真，并置读不通。
//   修正 = 引入显式优先级：数据损坏/只读 > 未恢复区间 > 已放弃 > 「最近无失败」绿行。
//   有未恢复或已放弃区间时，绿行让位（不再显示「最近无失败」），状态词同步改口。

/** 健康卡状态优先级（纯函数；panel.buildPipeHealthCard 消费）。
 *  @param state /state（tolerant：字段缺失=旧宿主）
 *  @returns "corrupt" | "unrecovered" | "abandoned" | "green" */
export function healthPriorityLevel(state) {
  const s = state && typeof state === "object" ? state : {};
  if (s.corrupt === true || s.addressingCorrupt === true || s.personaCorrupt === true) return "corrupt";
  if (s.format && typeof s.format === "object" && s.format.writable === false) return "corrupt";
  const log = s.extractionLog && typeof s.extractionLog === "object" ? s.extractionLog : null;
  if (Array.isArray(log?.unrecovered) && log.unrecovered.length > 0) return "unrecovered";
  if (Array.isArray(log?.abandoned) && log.abandoned.length > 0) return "abandoned";
  return "green";
}

/** 状态优先级 → 状态词（颜色之外的第二编码，与灯同色）。 */
export function healthPriorityWord(level) {
  if (level === "corrupt") return "需处理";
  if (level === "unrecovered") return "待补提";
  if (level === "abandoned") return "有放弃";
  return "正常";
}

/** 绿行是否允许显示「最近无失败」：有未恢复/已放弃区间时不允许（并置修正核心）。
 *  其余（含数据损坏——那有专属红卡文案，不靠绿行兜底）按原口径。 */
export function canShowNoFailureLine(level) {
  return level === "green";
}

// ---- 删除三态判读（DELETE /entry 契约；纯函数，entryCard 消费） ----

/** 删除结果 → 面板提示与是否刷新。
 *  200 {existed:false} → 「条目不存在」+ 刷新；
 *  200 {existed:true,trashed:true} → 「已移入回收站」+ 刷新；
 *  其余（409/500，错误体 existed:true,trashed:false）→ 「未能删除，条目仍在原位」+ **不**刷新
 *  （不把还在盘上的条目从列表里抹掉——静默消失比报错更糟）。 */
export function deleteOutcomeOf(out) {
  const o = out && typeof out === "object" ? out : {};
  if (o.existed === false) {
    return { kind: "missing", toast: "条目不存在（可能已被删除）", reload: true };
  }
  if (o.existed === true && o.trashed === true) {
    return { kind: "trashed", toast: "已移入回收站（可在回收站找回）", reload: true };
  }
  return { kind: "failed", toast: "未能删除，条目仍在原位", reload: false };
}

// ---- 设置健康提示（/state.settingsDiagnostics.coercedFields；缺失=旧宿主不渲染） ----

/** 设置页黄条：N 项设置值不合法已回默认（字段名），重存设置可修正。
 *  空/缺失/非数组 → ""（不渲染）。字段名逐个列出（最多 5 个，余量报数）。 */
export function settingsCoercionNote(diagnostics) {
  const d = diagnostics && typeof diagnostics === "object" ? diagnostics : {};
  const fields = Array.isArray(d.coercedFields) ? d.coercedFields.filter((f) => typeof f === "string" && f.length > 0) : [];
  if (fields.length === 0) return "";
  const shown = fields.slice(0, 5).join("、");
  const rest = fields.length > 5 ? ` 等 ${fields.length} 项` : "";
  return `${fields.length} 项设置值不合法已回默认（${shown}${rest}），重存设置可修正`;
}

// ---- 注入面节流/取代计数（/state.injection.throttled/superseded；缺失不显示） ----

/** 注入摘要附加段：「变更节流 N 次 / 取代 N 次」。
 *  两计数都缺失/为零 → ""（不显示，不印 0 装饰）；任一在场且 >0 才渲染。
 *  人话口径：throttled=同一会话内变更被节流合并的次数，superseded=注入被更新内容取代的次数。 */
export function injectionExtraText(injection) {
  if (!injection || typeof injection !== "object") return "";
  const t = Number(injection.throttled);
  const s = Number(injection.superseded);
  const throttled = Number.isFinite(t) && t > 0 ? Math.floor(t) : 0;
  const superseded = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  if (throttled === 0 && superseded === 0) return "";
  const parts = [];
  if (throttled > 0) parts.push(`变更节流 ${throttled} 次`);
  if (superseded > 0) parts.push(`取代 ${superseded} 次`);
  return parts.join(" / ");
}

// ---- 注入预算占用（token 口径；token 预算 0=禁用 → 退回纯字符展示） ----

/**
 * 注入行预算占用文案：「最近 ≈X tokens / 上限 Y」（X=最近一次注入估算 token，
 * Y=injectMaxTokens）。任一前提不成立 → ""（旧数据/缺字段容错，面板维持纯字符展示）：
 *   - injection 非对象 / count 不为正（尚未注入：与 injectionSummary 同口径，不装样子）；
 *   - injection.lastTokens 缺失或非有限数（旧服务端还没有 token 口径）；
 *   - maxTokens 缺失 / 非有限数 / ≤0（0=禁用 token 预算的回滚档，不显示"上限 0"）。
 * 取整用 floor：上游 estimateTokens 已 ceil，这里只防脏数据出小数。
 * @param injection /state.injection（对象；undefined=旧版宿主）
 * @param maxTokens /state.injectMaxTokens（数字；0/缺失=禁用）
 * @returns {string} 预算段文案或空串
 */
export function injectionBudgetText(injection, maxTokens) {
  if (!injection || typeof injection !== "object") return "";
  const count = Number(injection.count ?? 0);
  if (!Number.isFinite(count) || count <= 0) return "";
  const limit = Number(maxTokens);
  if (!Number.isFinite(limit) || limit <= 0) return "";
  const last = Number(injection.lastTokens);
  if (!Number.isFinite(last) || last < 0) return "";
  return `最近 ≈${Math.floor(last)} tokens / 上限 ${Math.floor(limit)}`;
}

// ---- 列表分页（分类页/长期记忆列表共用） ----

/** 分页默认每页条数。 */
export const PAGE_SIZE = 50;

/** 分页计算：total/currentPage（0 起）→ { pageCount, page, start, end, hasPrev, hasNext }。
 *  越界防御：page 非有限数/负数/小数 → 0；超过末页 → 末页（不是空页）；
 *  total 非有限数/负数 → 0。空列表 pageCount=0、page=0、start=end=0。 */
export function paginateOf(total, currentPage, pageSize = PAGE_SIZE) {
  const t = Number(total);
  const n = Number.isFinite(t) && t > 0 ? Math.floor(t) : 0;
  const sizeRaw = Number(pageSize);
  const size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.floor(sizeRaw) : PAGE_SIZE;
  const pageCount = n === 0 ? 0 : Math.ceil(n / size);
  let p = Number(currentPage);
  if (!Number.isFinite(p) || p < 0) p = 0;
  p = Math.floor(p);
  if (p > pageCount - 1) p = pageCount - 1;
  if (p < 0) p = 0;
  const start = p * size;
  const end = Math.min(n, start + size);
  return {
    total: n,
    pageSize: size,
    pageCount,
    page: p,
    start,
    end,
    hasPrev: pageCount > 1 && p > 0,
    hasNext: pageCount > 1 && p < pageCount - 1,
  };
}

/** 分页底栏文案：「上一页/下一页 · 第 N/M 页 · 共 X 条」（M=0 时第 0/0 页）。 */
export function paginationText(pg) {
  const p = pg && typeof pg === "object" ? pg : paginateOf(0, 0);
  return `第 ${p.page + 1}/${p.pageCount} 页 · 共 ${p.total} 条`;
}

// ---- 弹窗焦点陷阱（confirmDialog/sourceModeDialog/newEntryDialog/importDialog 复用） ----

/** 焦点陷阱：Tab/Shift+Tab 在容器内循环（首尾回卷），Esc 关闭。
 *  打开时记住当时的触发元素，卸载函数摘监听后把焦点还原回去（无障碍：关窗不该把键盘
 *  用户丢在 body 上）。触发元素已被移出文档时静默跳过，绝不因还原失败影响关闭。
 *  @returns 卸载函数（removeEventListener + 还原焦点，调用方关闭弹窗时必须调） */
export function trapFocus(container, onClose, opts = {}) {
  const sel = opts.selector ?? 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const previous = document.activeElement; // 打开时的触发元素（卸载时还原焦点）
  const keydown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key !== "Tab") return;
    const items = Array.from(container.querySelectorAll(sel)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (items.length === 0) return; // 容器内暂无可聚焦元素：不拦（浏览器自然顺序）
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    // 焦点在容器外（含 body）：Tab 拉回首个（防焦点逃逸到背景页）
    if (!container.contains(active)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && (active === first || active === last)) {
      // 回卷：首元素 Shift+Tab → 末元素；末元素 Shift+Tab → 首元素
      e.preventDefault();
      (active === first ? last : first).focus();
      return;
    }
    if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", keydown);
  return () => {
    document.removeEventListener("keydown", keydown);
    // 还原焦点：触发元素仍在文档里才还原（isConnected===false 已脱挂则跳过，不硬拉）
    if (previous && typeof previous.focus === "function" && previous.isConnected !== false) {
      try { previous.focus(); } catch { /* 还原失败不影响关闭 */ }
    }
  };
}

// ---- 存储格式只读保护提示（/state.format；缺失=旧版宿主，不渲染） ----

/**
 * 存储格式只读告警：仅在数据由更新版插件写入（format.writable===false）时返回文案，
 * 否则 null（不渲染）。显式可见——不静默降级。
 * @param format /state.format（对象；undefined=旧版宿主）
 * @returns {string|null}
 */
export function formatNoticeText(format) {
  if (!format || typeof format !== "object") return null;
  if (format.writable !== false) return null;
  const v = Number(format.formatVersion);
  const ver = Number.isFinite(v) && v > 0 ? `v${v}` : "更高版本";
  return `记忆数据由更新版插件（存储格式 ${ver}）写入，本插件已转为只读：不再记录新记忆，管理页写入被拒。升级 dsh-keepsake 后自动恢复。`;
}

// ---- v0.4.0 写入安全面：面板展示纯函数 ----
// 数据源 /state.safety（十字段：盘上三项 + 进程内七项计数）
// 与 trash/snapshots 列表条目。全部容错：
// 旧版宿主 /state 无 safety 字段 → 返回 null 或 "—"，不炸渲染。

/** 安全面摘要（管道健康卡一行）：全零返回 null（不渲染）。
 *  hardfactBlocks（硬事实 block 策略触发的回滚）与 verifyFailed 分列：前者是策略主动拦下，不静默。 */
export function safetySummaryText(safety) {
  if (!safety || typeof safety !== "object") return null;
  const parts = [];
  const n = safetyCountOf(safety, "trashPending");
  // 如实报总数：/state.safety 只给了条数没有到期信息，别用"待清"暗示都是到期待删的
  if (n > 0) parts.push(`回收站共 ${n} 条`);
  const v = safetyCountOf(safety, "verifyFailed");
  if (v > 0) parts.push(`写后校验失败 ${v}`);
  const hb = safetyCountOf(safety, "hardfactBlocks");
  if (hb > 0) parts.push(`硬事实拦截 ${hb}`);
  const h = safetyCountOf(safety, "hardfactDrops");
  if (h > 0) parts.push(`硬事实丢失告警 ${h}`);
  const b = safetyCountOf(safety, "blindWriteDowngrades");
  if (b > 0) parts.push(`盲写降级追加 ${b}`);
  const e = safetyCountOf(safety, "expectedSha1Mismatches");
  if (e > 0) parts.push(`sha1 不符拒写 ${e}`);
  const l = safetyCountOf(safety, "lockConflicts");
  if (l > 0) parts.push(`提取批锁冲突 ${l}`);
  const s = safetyCountOf(safety, "snapshotFailures");
  if (s > 0) parts.push(`快照失败 ${s}`);
  if (parts.length === 0) return null;
  return `写入安全面：${parts.join(" · ")}`;
}

/** 取一个计数字段（非有限数按 0）。 */
export function safetyCountOf(safety, key) {
  if (!safety || typeof safety !== "object") return 0;
  const n = Number(safety[key]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 条目/快照的时间（ISO 字符串或毫秒 → 相对时间；无效 → "—"）。 */
export function safetyEntryTimeOf(entry) {
  if (!entry || typeof entry !== "object") return "—";
  const raw = entry.createdAt;
  const ms = typeof raw === "number" ? raw : Date.parse(String(raw ?? ""));
  return Number.isFinite(ms) ? relativeTimeOf(ms) : "—";
}

/** 来源会话短显（无则 "—"）。 */
export function safetyOriginText(entry) {
  if (!entry || typeof entry !== "object") return "—";
  const s = String(entry.originSessionId ?? "").trim();
  return s.length > 0 ? s : "—";
}

/** 文件位置如实显示：rootKey 是 memoryRoot 相对 storageRoot 的相对路径
 *  （lib/safety.js rootKeyOf 的产物：全局分类 = `global/<category>`；
 *  项目记忆根 = `projects/<slug>-<hash>/memory`；空串 = 项目记忆根本身）。
 *  回收站/快照页位置列与恢复确认弹窗共用本函数：不猜形态、不套前缀：
 *  `global/…` 原样显示（用户按目录找得到），`projects/…/memory` 显示「项目 <slug>」
 *  （hash 对用户无意义），空 rootKey 宽容显示「项目记忆」；
 *  未知真实形态原样显示，畸形输入（file 非对象 / rootKey 非字符串）→ "—"。 */
export function safetyLocationText(file) {
  if (!file || typeof file !== "object") return "—";
  const raw = file.rootKey;
  if (raw != null && typeof raw !== "string") return "—";
  const segments = String(raw ?? "").trim().replace(/\\/g, "/").split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return "项目记忆";
  const path = segments.join("/");
  if (segments[0] === "global") return path;
  if (segments[0] === "projects" && segments.length >= 3 && segments[2] === "memory") {
    const dir = segments[1];
    const dash = dir.lastIndexOf("-");
    const slug = dash > 0 ? dir.slice(0, dash) : dir;
    return `项目 ${slug}`;
  }
  return path;
}

/** 操作中文：overwrite=覆写 / delete=删除 / 其他原样。 */
export function safetyActionText(action) {
  const a = String(action ?? "").trim();
  if (a === "overwrite") return "覆写";
  if (a === "delete") return "删除";
  return a.length > 0 ? a : "—";
}

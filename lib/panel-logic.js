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
  if (!Number.isFinite(ts)) return { days: 0, text: "今天" };
  const days = Math.floor((now - ts) / 86400_000);
  const text = days <= 0 ? "今天" : days === 1 ? "1 天前" : `${days} 天前`;
  return { days, text };
}

export function recentExpireDays(timestamp, keepDays = 30, now = Date.now()) {
  const { days } = recentAgeOf(timestamp, now);
  return Math.max(0, keepDays - days);
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
 *  无效/空 → "—"。未来时间（时钟偏移）按「刚刚」，不出负数。 */
export function relativeTimeOf(at, now = Date.now()) {
  const t = Number(at);
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
    return `记忆自动提取最近连续失败 ${streak} 次，期间对话内容可能未被记录——请检查服务端日志。`;
  }
  const last = ef.recent.length > 0 ? ef.recent[0] : null;
  const reason = last && last.reason ? String(last.reason) : (ef.streakReason ? String(ef.streakReason) : "");
  const model = last && last.model ? modelShortName(last.model) : "";
  if (reason && model) return `自动提取失败 ${streak} 次 · 最近：${reason}（${model}）`;
  if (reason) return `自动提取失败 ${streak} 次 · 最近：${reason}`;
  return `自动提取失败 ${streak} 次`;
}

/** 门牌红条行2（收紧措辞）：streak>0 且 lastFailedRange 在场才有——「seq X 之后的
 *  轮次尚未记录，恢复后自动补提」。会话已 disposed/多会话场景不承诺具体区间一定补回。 */
export function extractionRangeText(efRaw, lastFailedRange) {
  if (extractionStreakOf(efRaw) < 1) return "";
  if (!lastFailedRange || typeof lastFailedRange !== "object") return "";
  const from = Number(lastFailedRange.from);
  if (!Number.isFinite(from)) return "";
  return `seq ${from} 之后的轮次尚未记录，恢复后自动补提`;
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

// ---- 注入面可观测（消息通道注入健康；/state.injection 服务端恒在，缺失=旧版） ----
//   纯逻辑、零 DOM：面板健康卡与门牌共用同一条摘要文案，避免双端漂移。

/**
 * 注入面摘要：injection 缺失（旧版宿主）/ 非对象 / 无注入且无异常 → null。
 * 有注入 → 「已注入 N 次 · 最近 X 字符」（可附 丢段 / 渲染失败）；
 * 全是渲染失败（count=0 但 renderFailures>0）→ 仍返回告警串（显式可见，不静默藏）。
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
  return text;
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
  if (n > 0) parts.push(`回收站待清 ${n}`);
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

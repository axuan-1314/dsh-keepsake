// dsh-memory 面板纯逻辑（方案C §2 panel-logic.js：导入解析/预览行模型/主题映射/档位决策）。
//   双端 ESM：Node 测试 import（检查），面板 <script type="module"> 经
//   /dsh-memory/panel/panel-logic.js 路由引用。零 node 依赖、零 DOM 依赖
//   （主题映射收 document 参数，不直接触全局）。

// ---- 人设预设模板（方案C §6 功能4：简洁/专业/幽默/伙伴/自定义五档 + 恢复默认） ----
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

/** markdown 导入的标题推断（审查 P3-4 面板侧修复）：首 ## 标题 → 首任意级标题 → 首行；
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
    // 覆盖/批内改名 = 冲突标红（rename 为全面审查 IMP-1 批内去重的动作值）
    danger: plan.action === "overwrite" || plan.action === "rename",
    preview: String(plan.content ?? "").slice(0, 80),
  }));
}

// ---- 主题映射（M0 P7 实证机制：样式表枚举 --dsw-alias-* + computed 取值） ----

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

// ---- 打开梯子档位决策（方案C §1.4 运行时梯子） ----

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

/** 「返回设置」分档决策（审查 P3-1）：popup 关窗 / iframe 通知宿主收起 / 顶层按
 *  自身 hash 压栈步数回退（绕开面板内部路由历史），无历史才退应用根。 */
export function panelBackAction(hasOpener, hasParent, historyLength, hashSteps) {
  if (hasOpener) return { mode: "close" };
  if (hasParent) return { mode: "notify-host" };
  if (Number(historyLength) > 1) return { mode: "back", steps: Number(hashSteps) + 1 };
  return { mode: "root" };
}

// ---- 条目草稿客户端预检（U-TRU1 / P3-11 / P3-14） ----

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

// ---- 源码模式序列化/解析（审查 P2 修复：description 随注释往返不丢；进检查钉住） ----

/** 整类序列化：每条 = ## 标题 + name/desc 注释行 + 正文，条目间一行 --- 分隔。
 *  desc 换行折叠为空格（审查 P3-15：注释行是单行协议，换行会让解析正则失配丢 name）。 */
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

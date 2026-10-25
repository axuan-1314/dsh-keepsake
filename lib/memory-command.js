// /memory 斜杠命令：在对话里直接查记忆，不用切面板。
//
// 子命令（刻意少而正交，每个都对应一个既有能力，不发明新语义）：
//   /memory                  列出最近条目（全局 + 当前项目）
//   /memory <关键词...>      关键词检索（AND 语义，见 lib/search.js）
//   /memory why <关键词>     同检索，但额外带"这条为什么在"的上下文（类型/范围/片段）
//   /memory forget <文件或关键词>
//                            纠错闭环入口：把命中的那条当作"不该存在/记错了"提交，
//                            走 lib/corrections.js（模型提案 → applyScopedOps 落盘）
//   /memory fix <关键词> | <诉求>
//                            纠错闭环入口（改错）：前半是定位关键词，后半是用户诉求原文
//
// 为什么 forget/fix 都走纠错而不是直接删/写：
//   直接删会绕过模型的"最小修正"判断（用户说"这个记错了"往往不是要删，而是要改对），
//   直接写又没有 sha1 闸保护（模型可能基于陈旧正文覆盖）。走纠错 = 复用整条安全通路。
//
// 注册面（0.2.0 实测）：ctx.commands.register({ name, description, input?, handler })，
// handler 收 { commandId, agent, rawInput, signal }，返回 { kind:"success"|"error", text }。
// 命令名不含斜杠；COMMAND_NAME 正则 ^[a-z][a-z0-9_-]*$。
//
// 边界：命令注册是**可选能力**——宿主没有 commands 服务时不得影响记忆功能。
//   因此本模块由 index.js 经 ctx.inject(["commands"], …) 挂载（与 webServer 同款），
//   而不是进 inject 硬声明。
import { CATEGORY_LABELS } from "./global-store.js";
import { CORRECTION_KIND_LABELS } from "./corrections.js";

export const MEMORY_COMMAND_NAME = "memory";
export const COMMAND_MAX_RESULTS = 10;
export const COMMAND_RESULT_LINE_CHARS = 160;

const USAGE = [
  "/memory — 列出最近记忆",
  "/memory <关键词> — 检索",
  "/memory why <关键词> — 检索并说明命中原因",
  "/memory fix <关键词> | <诉求> — 让模型按诉求纠正这条记忆（有留档，可回滚）",
  "/memory forget <关键词> — 让模型判断这条是否该删（走回收站）",
].join("\n");

/** 范围翻译成人话（面板/命令共用口径）。 */
export function scopeText(scope) {
  const value = String(scope ?? "");
  if (value === "project") return "项目";
  if (value.startsWith("global:")) {
    const id = value.slice("global:".length);
    return CATEGORY_LABELS[id] ?? `全局/${id}`;
  }
  return value.length > 0 ? value : "未知";
}

/** 类型翻译（frontmatter.metadata.type）。 */
export function typeText(type) {
  switch (String(type ?? "")) {
    case "user": return "用户";
    case "feedback": return "反馈";
    case "project": return "项目";
    case "reference": return "参考";
    default: return "";
  }
}

function clip(text, max = COMMAND_RESULT_LINE_CHARS) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * 解析命令行（rawInput 是 "/memory" 之后的部分，原样未归一化）。
 * @returns {{
 *   kind: "help"|"list"|"search"|"why"|"fix"|"forget"|"error",
 *   query?: string, complaint?: string, error?: string
 * }}
 */
export function parseMemoryCommand(rawInput) {
  const text = typeof rawInput === "string" ? rawInput.trim() : "";
  if (text.length === 0) return { kind: "list" };
  const [head, ...rest] = text.split(/\s+/);
  const lower = head.toLowerCase();
  const tail = rest.join(" ").trim();

  if (lower === "help" || lower === "-h" || lower === "--help") return { kind: "help" };
  if (lower === "why") {
    if (tail.length === 0) return { kind: "error", error: "/memory why 需要关键词，例如：/memory why pnpm" };
    return { kind: "why", query: tail };
  }
  if (lower === "forget") {
    if (tail.length === 0) return { kind: "error", error: "/memory forget 需要关键词或文件名，例如：/memory forget 旧端口" };
    return { kind: "forget", query: tail };
  }
  if (lower === "fix") {
    // fix 的形状：「关键词 | 诉求」；没有竖线时整段当关键词，诉求缺失由上层拒（不白烧调用）
    const bar = tail.indexOf("|");
    if (bar < 0) {
      if (tail.length === 0) {
        return { kind: "error", error: "/memory fix 需要「关键词 | 诉求」，例如：/memory fix 部署端口 | 现在是 8080 不是 3000" };
      }
      return { kind: "error", error: "/memory fix 需要「关键词 | 诉求」：前半定位条目，后半写清哪里错了" };
    }
    const query = tail.slice(0, bar).trim();
    const complaint = tail.slice(bar + 1).trim();
    if (query.length === 0 || complaint.length === 0) {
      return { kind: "error", error: "/memory fix 的「关键词」与「诉求」都不能为空" };
    }
    return { kind: "fix", query, complaint };
  }
  return { kind: "search", query: text };
}

/** 一条检索结果 → 一行（不含命中原因）。 */
function resultLine(item, index) {
  const type = typeText(item.type);
  const meta = [scopeText(item.scope), type].filter((part) => part.length > 0).join(" · ");
  return `${index + 1}. ${clip(item.title, 60)}（${meta}）\n   ${item.name} — ${clip(item.description || item.snippet, COMMAND_RESULT_LINE_CHARS)}`;
}

/**
 * 渲染 /memory 的输出文本。
 * @param {{
 *   kind: string, query?: string, complaint?: string,
 *   results?: Array<object>, total?: number, truncated?: boolean,
 *   entries?: Array<object>, projectId?: string
 * }} input
 * @returns {string}
 */
export function renderMemoryResult(input) {
  const data = input && typeof input === "object" ? input : {};
  const kind = String(data.kind ?? "");
  if (kind === "help") return `dsh-keepsake 记忆命令\n\n${USAGE}`;

  if (kind === "list") {
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (entries.length === 0) return "记忆里还没有条目。对话几轮后会自动积累。";
    const total = Number(data.total ?? entries.length);
    const tail = data.truncated ? `（共 ${total} 条，只显示最近 ${entries.length} 条；用 /memory <关键词> 精确找）` : `（共 ${total} 条）`;
    // 两个「没列全」的原因必须分开说：读失败（条目在、读不出来）与扫描没扫全
    // （目录条目数超上限）都不是「只有这么多条」。不说，用户会把缺口当成事实。
    const notes = [];
    const skipped = Number(data.skipped ?? 0);
    if (Number.isFinite(skipped) && skipped > 0) notes.push(`其中 ${Math.floor(skipped)} 条读取失败，未列出`);
    if (data.scanTruncated === true) notes.push("条目数超出单次扫描上限，更早的条目可能没扫到");
    const note = notes.length > 0 ? `\n（${notes.join("；")}）` : "";
    return `最近的记忆${tail}${note}\n\n${entries.map((item, i) => resultLine(item, i)).join("\n")}`;
  }

  if (kind === "search" || kind === "why") {
    const results = Array.isArray(data.results) ? data.results : [];
    if (results.length === 0) {
      return `没找到包含「${clip(data.query ?? "", 80)}」的记忆。可以换个说法，或用 /memory 看全部条目。`;
    }
    const total = Number(data.total ?? results.length);
    const head = data.truncated
      ? `找到 ${total} 条，显示前 ${results.length} 条：`
      : `找到 ${total} 条：`;
    const lines = results.map((item, i) => {
      const base = resultLine(item, i);
      if (kind !== "why") return base;
      const hits = Array.isArray(item.hits) ? item.hits : [];
      const where = hits.length > 0 ? `命中：${[...new Set(hits)].map(hitText).join("、")}` : "命中：—";
      const score = Number.isFinite(item.score) ? `（相关度 ${item.score}）` : "";
      return `${base}\n   ${where}${score}`;
    });
    return `${head}\n\n${lines.join("\n")}`;
  }

  return USAGE;
}

function hitText(hit) {
  switch (String(hit ?? "")) {
    case "name": return "文件名";
    case "title": return "标题";
    case "description": return "摘要";
    case "body": return "正文";
    default: return "其它";
  }
}

/** 纠错结局 → 人话（命令返回，与记录口径一致）。 */
export function renderCorrectionOutcome(outcome, { target = "", complaint = "" } = {}) {
  const result = outcome && typeof outcome === "object" ? outcome : {};
  switch (String(result.outcome ?? "")) {
    case "applied": {
      const verifyFailed = Number(result.verifyFailed ?? 0);
      // 写后校验打回的改动必须说出来：只报「已纠正 X 处改写」会让用户以为全改成了。
      const lost = Number.isFinite(verifyFailed) && verifyFailed > 0
        ? `\n另有 ${Math.floor(verifyFailed)} 处改动写后校验失败、已回滚原样，需要重新说明。`
        : "";
      return `已纠正 ${target}：${Number(result.writes ?? 0)} 处改写 / ${Number(result.deletes ?? 0)} 处删除。\n原文件已留快照，可在面板「快照」页回退。${lost}`;
    }
    case "needs-input":
      return `「${clip(complaint, 80)}」不足以确定怎么改（${CORRECTION_KIND_LABELS[String(result.reason ?? "other")] ?? "其它原因"}）。\n记忆没有任何改动。请说得更具体些再试，例如指出正确的值是什么。`;
    case "nothing":
      return `模型判断 ${target} 不需要改动，记忆未变。\n如果确实有错，试着在诉求里写清正确的值。`;
    default: {
      // 写后校验把唯一的改动打回时，这里最关键的信息不是内部码 no-op-applied，
      // 而是「改了但没通过校验、已回滚」——不说清楚，用户会以为是被权限/开关挡住。
      const verifyFailed = Number(result.verifyFailed ?? 0);
      if (Number.isFinite(verifyFailed) && verifyFailed > 0) {
        return `纠正 ${target} 失败：${Math.floor(verifyFailed)} 处改动写后校验没通过、已回滚原样，记忆未改动。\n可以再试一次，或换一种说法指出正确的值。`;
      }
      return `纠正 ${target} 失败（${String(result.error ?? "未知原因")}），记忆未改动。`;
    }
  }
}

/**
 * 从检索结果里挑纠错目标：优先文件名/标题完全相等的，否则取最高分那条。
 * @returns {object|null}
 */
export function pickCorrectionTarget(results) {
  const list = Array.isArray(results) ? results.filter((r) => r && typeof r === "object" && typeof r.name === "string") : [];
  if (list.length === 0) return null;
  // 结果已按分数降序（lib/search.js），故首条即最高分；无需再找"完全相等"——
  // 名字完全相等的那条分数本来就是 100，已经排在前面。
  return list[0];
}

/**
 * 构造命令处理器。
 *
 * 依赖全部注入（不 import index.js，避免循环依赖）：
 * @param {{
 *   search: (q: string) => object,        // → { results, total, truncated }
 *   list: () => object,                   // → { entries, total, truncated }
 *   correct: (input: object) => Promise<object>,
 *   log?: object
 * }} deps
 * @returns {(invocation: {rawInput?: string, agent?: object}) => Promise<{kind:string, text:string}>}
 */
export function makeMemoryCommandHandler({ search, list, correct, log = {} } = {}) {
  return async function handleMemoryCommand(invocation) {
    const parsed = parseMemoryCommand(invocation?.rawInput ?? "");
    try {
      if (parsed.kind === "help") return { kind: "success", text: renderMemoryResult({ kind: "help" }) };
      if (parsed.kind === "error") return { kind: "error", text: parsed.error };

      if (parsed.kind === "list") {
        const data = typeof list === "function" ? list() : {};
        return { kind: "success", text: renderMemoryResult({ kind: "list", ...data }) };
      }

      if (parsed.kind === "search" || parsed.kind === "why") {
        const data = typeof search === "function" ? search(parsed.query) : {};
        return { kind: "success", text: renderMemoryResult({ kind: parsed.kind, query: parsed.query, ...data }) };
      }

      // fix / forget：先检索定位，再提交纠错
      const found = typeof search === "function" ? search(parsed.query) : {};
      const results = Array.isArray(found.results) ? found.results : [];
      if (results.length === 0) {
        return {
          kind: "error",
          text: `没找到包含「${clip(parsed.query, 60)}」的记忆，无法定位要纠正哪一条。先用 /memory <关键词> 找找看。`,
        };
      }
      const target = pickCorrectionTarget(results);
      if (target === null) {
        return { kind: "error", text: "检索结果里没有可用的条目名，无法纠错。" };
      }
      // 多条命中时如实告知取了哪条，并给出精确指名的办法——不假装"我懂你指哪条"。
      const ambiguous = results.length > 1
        ? `（命中 ${results.length} 条，本次处理「${target.title}」/${target.name}；要指定其它条请用更精确的关键词）\n`
        : "";
      const complaint = parsed.kind === "fix"
        ? parsed.complaint
        : "这条记忆不该存在或已完全错误，请删除它。";
      const kind = parsed.kind === "fix" ? "wrong-fact" : "wrong-scope";
      const outcome = typeof correct === "function"
        ? await correct({
          target: target.name,
          reason: complaint,
          kind,
          scope: target.scope,
          projectId: target.projectId ?? "",
          sessionId: invocation?.agent?.session?.id ?? "",
        })
        : { outcome: "error", error: "纠错未接线" };
      const text = renderCorrectionOutcome(outcome, { target: target.name, complaint });
      // 结局如实回报（applied / needs-input / nothing 都是**成功执行**的命令，
      // 只有真出错才是 error）——把 needs-input 报成 error 会让 UI 涂红，
      // 而用户其实什么都没做错，只是诉求不够具体。
      const isError = String(outcome?.outcome ?? "") === "error";
      return { kind: isError ? "error" : "success", text: ambiguous + text };
    } catch (error) {
      // 规则 3：命令处理失败必须显式回报，不可静默；也不把异常抛给宿主 UI（会变成无上下文的红条）。
      log.error?.("/memory 命令处理异常", error);
      return { kind: "error", text: `/memory 执行失败：${String(error?.message ?? error)}` };
    }
  };
}

/**
 * 把处理器注册到 commands 服务。
 * @param {object} ctx cordis 上下文（含 ctx.commands）
 * @param {object} deps 见 makeMemoryCommandHandler
 * @returns {Function} disposer
 */
export function registerMemoryCommand(ctx, deps) {
  if (ctx === null || typeof ctx !== "object" || ctx.commands === void 0 || ctx.commands === null) {
    throw new Error("dsh-keepsake: registerMemoryCommand 需要 ctx.commands（不应在无 commands 服务时调用）");
  }
  const handler = makeMemoryCommandHandler(deps);
  return ctx.commands.register({
    name: MEMORY_COMMAND_NAME,
    description: "查询 / 纠正 dsh-keepsake 记忆",
    input: { hint: "[关键词] | why <关键词> | fix <关键词> | <诉求> | forget <关键词>" },
    // 命令输入可能含个人事实：不进会话日志的命令记录（recordInput=false）。
    recordInput: false,
    handler,
  });
}

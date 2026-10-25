// 纠错闭环（correction ledger）：给"模型发现某条记忆是错的"一条正式通道。
//
// 背景（为什么需要）：提取与空闲整理都只会 write/delete，模型无法表达
//   「这条记错了，正确的事实是 X」。于是错误事实只能靠下一轮提取碰巧覆盖——
//   而覆盖需要 sha1 闸、需要模型重新读全文，实际常常留下两条互相矛盾的记忆。
//   本模块把「指名纠错」做成一条独立、可审计、可回滚的通道：
//   模型提案 → 落一条 durable 记录 → 应用为一次正常的 write/delete 批。
//
// 与提取/整理的分工：
//   - 提取（extract.js）：从对话增量里发现新事实；
//   - 空闲整理（idle-review.js）：合并/更新近重复条目；
//   - 纠错（本模块）：给定一条具体记忆「它错了」，产出修正动作并留记录。
//   三者共用同一条落盘通路（applyScopedOps：批锁 / 快照 / sha1 闸 / 写后校验），
//   本模块不新增任何写盘原语——纠错不是特权路径，安全面完全复用。
//
// 记录（correction-ledger.jsonl，<storageRoot> 根下，非记忆真源）：
//   每次应用一条，记录 {at, outcome, kind, target, scope, writes, deletes, verifyFailed,
//   originSessionId}。落盘纪律同 journal.js：追加串行化、原子写、
//   写失败只 warn 不抛（非致命降级但必须可见）。
//
// 边界（有意从窄，与项目既有取舍一致）：
//   - 纠错只处理"有明确目标条目"的场景；"我不记得有这回事"这类无法定位的诉求
//     仍走普通提取（让模型按常规判断写/删）。
//   - 不自动触发：由显式调用方（/memory 命令或面板按钮）发起，不增加每轮成本。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactSensitive } from "./redact.js";

export const CORRECTION_LEDGER_FILENAME = "correction-ledger.jsonl";
export const CORRECTION_LEDGER_ROTATE_AT = 1000;
export const CORRECTION_LEDGER_KEEP = 500;
export const CORRECTION_MAX_OPS = 3;
/** 批量纠错单批上限：每条一次 LLM 调用，上限是为了把一次误操作的成本锁死。 */
export const CORRECTION_MAX_BATCH = 10;
export const CORRECTION_BODY_CHARS = 4000;

/** 记录内存环形缓冲上限（面板/命令读最近记录用）。 */
export const CORRECTION_RING_MAX = 20;

/** 纠错类型枚举的唯一权威集合（模型能声明的取值都在这里）。
 *  面板的中文映射必须覆盖它——漏一个就会在界面上露出英文枚举，
 *  结构测试用这个集合兜底（见 test/panel-logic.test.mjs）。 */
export const CORRECTION_KINDS = Object.freeze(["wrong-fact", "outdated", "wrong-scope", "duplicate", "other"]);

const CORRECTION_KIND_SET = new Set(CORRECTION_KINDS);

/**
 * 纠错的五种诉求（模型只需在其中声明一种，人话标签在 panel-logic 侧翻译）。
 * 收窄到五类是有意的：更细的分类没有对应的落盘动作，只会让模型在措辞上纠缠。
 */
export const CORRECTION_KIND_LABELS = Object.freeze({
  "wrong-fact": "记错了事实",
  outdated: "已经过时",
  "wrong-scope": "放错了位置",
  duplicate: "和另一条重复",
  other: "其它原因",
});

const ledgerState = {
  runs: 0,
  applied: 0,
  writes: 0,
  deletes: 0,
  verifyFailed: 0,
  failed: 0,
  lastAt: null,
  lastOutcome: null,
  lastTarget: null,
  lastReason: null,
  recent: [],
};

export function correctionsSnapshot() {
  return { ...ledgerState, recent: ledgerState.recent.slice() };
}

export function __resetCorrectionsForTest() {
  Object.assign(ledgerState, {
    runs: 0,
    applied: 0,
    writes: 0,
    deletes: 0,
    verifyFailed: 0,
    failed: 0,
    lastAt: null,
    lastOutcome: null,
    lastTarget: null,
    lastReason: null,
    recent: [],
  });
}

function note({ outcome, target = "", reason = "", writes = 0, deletes = 0, verifyFailed = 0 }) {
  ledgerState.runs += 1;
  ledgerState.lastAt = Date.now();
  ledgerState.lastOutcome = outcome;
  ledgerState.lastTarget = typeof target === "string" && target.length > 0 ? target : null;
  ledgerState.lastReason = reason;
  // verifyFailed 与 outcome 正交：写后校验打回可能发生在 applied（另有一处落成）
  // 也可能发生在 failed（唯一那处被打回、writes=0）。两条路径都要累计，
  // 否则「最该解释清的一次」在面板上反而看不到原因。
  ledgerState.verifyFailed += Number.isFinite(verifyFailed) && verifyFailed > 0 ? Math.floor(verifyFailed) : 0;
  if (outcome === "applied") {
    ledgerState.applied += 1;
    ledgerState.writes += Number.isFinite(writes) && writes > 0 ? Math.floor(writes) : 0;
    ledgerState.deletes += Number.isFinite(deletes) && deletes > 0 ? Math.floor(deletes) : 0;
  } else if (outcome === "failed") {
    ledgerState.failed += 1;
  }
  ledgerState.recent.unshift({
    at: new Date(ledgerState.lastAt).toISOString(),
    outcome,
    target: ledgerState.lastTarget,
    reason: reason.length > 0 ? reason.slice(0, 200) : null,
    writes: Number.isFinite(writes) && writes > 0 ? Math.floor(writes) : 0,
    deletes: Number.isFinite(deletes) && deletes > 0 ? Math.floor(deletes) : 0,
  });
  if (ledgerState.recent.length > CORRECTION_RING_MAX) {
    ledgerState.recent.length = CORRECTION_RING_MAX;
  }
}

function ledgerPath(storageRoot) {
  return join(storageRoot, CORRECTION_LEDGER_FILENAME);
}

/** 原子写（tmp+rename；与 journal.js / global-store.js 同口径）。 */
function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/**
 * 追加一条记录并轮转。
 * 串行化：本模块的写入点只有 applyCorrection 一处（不像 journal 有多会话并发），
 * 故用 appendFileSync 即可；轮转仍走 tmp+rename，中断不留半截主档。
 * 写失败只 warn：记录是审计面，丢了不该拖垮已经成功的纠错落盘。
 */
function appendLedger(storageRoot, record, log = {}) {
  const path = ledgerPath(storageRoot);
  const line = JSON.stringify(record);
  try {
    mkdirSync(storageRoot, { recursive: true });
    let lines = 0;
    if (existsSync(path)) {
      try {
        lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
      } catch {
        lines = 0;
      }
    }
    if (lines + 1 > CORRECTION_LEDGER_ROTATE_AT) {
      const kept = existsSync(path)
        ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0).slice(-CORRECTION_LEDGER_KEEP)
        : [];
      kept.push(line);
      writeAtomic(path, `${kept.join("\n")}\n`);
      return;
    }
    appendFileSync(path, `${line}\n`, "utf8");
  } catch (error) {
    log.warn?.("纠错记录写入失败（纠错本身可能已成功落盘，记录仅供审计）", error);
  }
}

/**
 * 纠错提示词：只喂「这一条目标 + 相关邻近条目」，不喂全量记忆。
 *
 * 为什么不复用提取提示词：提取是从对话增量里找新事实（广），纠错是给定一条
 * 已判定有误的记忆、产出修正（窄）。同一个提示词做两件事会让模型在纠错时
 * 顺手把无关条目也改写一遍——那是空闲整理的职责，不是纠错的。
 *
 * @param {{
 *   target: string, currentBody: string, reason: string, kind: string,
 *   neighbors?: string, scopeLabel?: string
 * }} input
 * @returns {{system: string, user: string}}
 */
export function buildCorrectionPayload({ target, currentBody, reason, kind, neighbors = "", scopeLabel = "project" }) {
  const system = [
    "You are the memory correction assistant of the dsh-keepsake plugin for DeepSeek Harness.",
    "The user has flagged ONE existing memory entry as wrong. Produce the minimal fix.",
    "",
    "Rules:",
    "- You may only touch the flagged entry (and, if the complaint is a duplicate, the redundant copy).",
    "- Do NOT rewrite unrelated entries; do not 'tidy up' the surrounding memory.",
    "- A write's content is the COMPLETE new body of the file (it replaces the old body).",
    "- Preserve every fact that is still true; change only what the complaint says is wrong.",
    "- Never invent facts, dates, numbers or reasons that the complaint does not establish.",
    "- If the complaint means the entry should not exist at all, reply with a delete op.",
    "- If the complaint cannot be resolved into a concrete edit (too vague, contradicts nothing,",
    "  or would require facts you do not have), reply with exactly: NEEDS_USER_INPUT",
    "- Otherwise reply with ONE JSON object and nothing else (no markdown fence, no commentary):",
    '{"ops":[{"action":"write","name":"kebab-name.md","scope":"project","type":"user|feedback|project|reference","title":"Title","description":"one-line hook","content":"complete new body"},{"action":"delete","name":"obsolete.md","scope":"project"}]}',
    `- At most ${CORRECTION_MAX_OPS} ops.`,
    `- The flagged entry lives in scope "${scopeLabel}". Keep the write in the same scope unless the complaint is specifically about the wrong scope.`,
  ].join("\n");
  const user = [
    `Flagged entry: ${target}`,
    `Scope: ${scopeLabel}`,
    `Complaint kind: ${kind} (${CORRECTION_KIND_LABELS[kind] ?? kind})`,
    "",
    "Complaint (verbatim from the user):",
    reason || "(no detail given)",
    "",
    "Current body of the flagged entry:",
    currentBody || "(empty)",
    neighbors ? `\nRelated entries (context only — do not edit unless the complaint is about duplication):\n${neighbors}` : "",
    "",
    "Produce the minimal correction now. Reply per the output contract.",
  ].filter((line) => line !== "").join("\n");
  return { system, user };
}

/**
 * 解析纠错输出。
 * 与提取的差别：NEEDS_USER_INPUT 是一等公民结局（不是失败）——
 * 「这条说不清怎么改」是真实且常见的结局，必须能如实回报而不是硬凑一个 edit。
 * @returns {{kind:"needs-input"} | {kind:"nothing"} | {kind:"ops", ops:Array, filtered:number}}
 */
export function parseCorrectionOutput(text, parseOps) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0) throw new Error("dsh-keepsake: 纠错输出为空");
  if (/^needs_user_input\.?$/i.test(trimmed)) return { kind: "needs-input" };
  const parsed = parseOps ? parseOps(trimmed) : null;
  if (parsed === null || parsed === undefined) {
    // 调用方未注入解析器 = 接线漏了；显式抛错，不静默当成 nothing
    throw new Error("dsh-keepsake: 纠错解析器未接线（需要传入 parseOps）");
  }
  if (parsed.kind === "nothing") return { kind: "nothing" };
  const all = Array.isArray(parsed.ops) ? parsed.ops : [];
  const ops = all.slice(0, CORRECTION_MAX_OPS);
  return { kind: "ops", ops, filtered: all.length - ops.length };
}

/** 归一化 kind（未知值收敛到 other，不让模型的自由措辞决定记录枚举）。 */
export function normalizeCorrectionKind(kind) {
  const value = typeof kind === "string" ? kind.trim() : "";
  return CORRECTION_KIND_SET.has(value) ? value : "other";
}

/**
 * 执行一次纠错。
 *
 * @param {{
 *   storageRoot: string,
 *   target: string,
 *   currentBody: string,
 *   reason: string,
 *   kind?: string,
 *   scopeLabel?: string,
 *   neighbors?: string,
 *   parseOps: Function,
 *   callLlm: (payload: {system:string,user:string}) => Promise<{text:string}>,
 *   applyOps: Function,
 *   projectRoot?: string,
 *   originSessionId?: string,
 *   settings?: object,
 *   log?: object
 * }} input
 * @returns {Promise<{outcome:"applied"|"needs-input"|"nothing"|"error", writes?:number, deletes?:number, ops?:Array, error?:string}>}
 */
export async function applyCorrection({
  storageRoot,
  target,
  currentBody = "",
  reason = "",
  kind = "other",
  scopeLabel = "project",
  neighbors = "",
  parseOps,
  callLlm,
  applyOps,
  projectRoot = "",
  originSessionId = "",
  settings = null,
  log = {},
} = {}) {
  const kindValue = normalizeCorrectionKind(kind);
  if (typeof storageRoot !== "string" || storageRoot.length === 0) {
    note({ outcome: "failed", target, reason: "missing-storage-root" });
    return { outcome: "error", error: "missing-storage-root" };
  }
  if (typeof target !== "string" || target.trim().length === 0) {
    note({ outcome: "failed", reason: "missing-target" });
    return { outcome: "error", error: "missing-target" };
  }
  if (typeof callLlm !== "function" || typeof applyOps !== "function" || typeof parseOps !== "function") {
    note({ outcome: "failed", target, reason: "missing-wiring" });
    return { outcome: "error", error: "missing-wiring" };
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    // 无诉求的纠错没有信息量：直接拒，不白烧一次调用。
    note({ outcome: "failed", target, reason: "empty-complaint" });
    return { outcome: "error", error: "empty-complaint" };
  }

  const payload = buildCorrectionPayload({
    target,
    currentBody: redactSensitive(String(currentBody).slice(0, CORRECTION_BODY_CHARS)),
    reason: redactSensitive(String(reason).slice(0, 2000)),
    kind: kindValue,
    neighbors: redactSensitive(String(neighbors ?? "")),
    scopeLabel,
  });

  let text;
  try {
    const result = await callLlm(payload);
    text = typeof result === "string" ? result : result?.text;
  } catch (error) {
    note({ outcome: "failed", target, reason: "llm-error" });
    log.warn?.("纠错：LLM 调用失败", error);
    return { outcome: "error", error: String(error?.message ?? error) };
  }

  let parsed;
  try {
    parsed = parseCorrectionOutput(text, parseOps);
  } catch (error) {
    note({ outcome: "failed", target, reason: "parse-error" });
    log.warn?.("纠错：输出解析失败", error);
    return { outcome: "error", error: String(error?.message ?? error) };
  }

  if (parsed.kind === "needs-input") {
    note({ outcome: "needs-input", target, reason: kindValue });
    return { outcome: "needs-input", reason: kindValue };
  }
  if (parsed.kind === "nothing") {
    note({ outcome: "nothing", target, reason: kindValue });
    return { outcome: "nothing", filtered: parsed.filtered ?? 0 };
  }

  let result;
  try {
    result = applyOps(
      { storageRoot, projectRoot },
      parsed.ops,
      { originSessionId, allowGlobal: true, allowProject: true, settings, log },
    );
  } catch (error) {
    note({ outcome: "failed", target, reason: "apply-error" });
    log.error?.("纠错：落盘失败", error);
    return { outcome: "error", error: String(error?.message ?? error) };
  }

  const writes = Number(result?.writes ?? 0);
  const deletes = Number(result?.deletes ?? 0);
  const verifyFailedRaw = Number(result?.verifyFailed ?? 0);
  const verifyFailed = Number.isFinite(verifyFailedRaw) && verifyFailedRaw > 0 ? Math.floor(verifyFailedRaw) : 0;
  if (writes + deletes <= 0) {
    // ops 全被闸拦下（sha1 不符 / 锁冲突 / 校验失败）：不得谎报 applied。
    // 这里最常见的成因就是**写后校验失败被整条回滚**（verifyFailed=1、writes=0）——
    // 最该解释清楚的一次，若把 verifyFailed 丢掉，用户只能看到内部码 no-op-applied。
    note({ outcome: "failed", target, reason: "no-op-applied", verifyFailed });
    return { outcome: "error", error: "no-op-applied", writes: 0, deletes: 0, verifyFailed, applyResult: result };
  }

  note({ outcome: "applied", target, reason: kindValue, writes, deletes, verifyFailed });
  // 写后校验失败被回滚的次数：writes 仍 >0（有别处改动真落了），所以单看
  // 「已纠正 X：N 处改写」会把「另一次改动被打回」藏掉。回报里带着它，
  // 命令与面板才可能说清「有一处没改成」。
  appendLedger(storageRoot, {
    at: new Date().toISOString(),
    // outcome 显式落盘：appendLedger 只在 applied 路径被调，但读侧（按条目归组）
    // 不该靠"调用点位置"推断——行上没这个字段，归组就永远筛不出东西。
    outcome: "applied",
    kind: kindValue,
    target,
    scope: scopeLabel,
    writes,
    deletes,
    verifyFailed,
    originSessionId: typeof originSessionId === "string" ? originSessionId : "",
  }, log);
  log.info?.(`纠错：${target} → ${writes} 写 / ${deletes} 删（${kindValue}）`);
  return {
    outcome: "applied",
    writes,
    deletes,
    verifyFailed,
    applyResult: result,
  };
}

/**
 * 批量纠错：一次提交多条（每条自带诉求），逐条跑 applyCorrection。
 *
 * 为什么不合成一次 LLM 调用：纠错的可靠性建立在「一次只说一条、上下文最小」上。
 * 合成一次会让一条的诉求污染另一条的判断（模型倾向把相似的几条一起改），
 * 而且任一一条失败会拖垮整批。代价是 N 次调用——批量纠错是用户显式发起的，
 * 这个成本换「每条独立可回滚、独立可判失败」是划算的。
 *
 * 失败隔离（与提取批锁同思路）：一条失败不影响后续条目，逐条返回结局。
 * @param {{
 *   storageRoot: string, items: Array<{target:string, reason:string, kind?:string, scope?:string, projectId?:string}>,
 *   resolveBody: (item: object) => string,
 *   resolveNeighbors: (item: object) => string,
 *   parseOps: Function, callLlm: Function, applyOps: Function,
 *   projectRootOf?: (item: object) => string,
 *   originSessionId?: string, settings?: object, log?: object, maxItems?: number
 * }} input
 * @returns {Promise<{outcome:"applied"|"partial"|"error"|"nothing", results:Array, writes:number, deletes:number, failed:number, error?:string}>}
 */
export async function applyCorrections({
  storageRoot,
  items = [],
  resolveBody = () => "",
  resolveNeighbors = () => "",
  parseOps,
  callLlm,
  applyOps,
  projectRootOf = () => "",
  originSessionId = "",
  settings = null,
  log = {},
  maxItems = CORRECTION_MAX_BATCH,
} = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { outcome: "error", results: [], writes: 0, deletes: 0, failed: 0, error: "empty-batch" };
  }
  const cap = Number.isFinite(maxItems) && maxItems > 0 ? Math.floor(maxItems) : CORRECTION_MAX_BATCH;
  if (items.length > cap) {
    // 显式拒而非静默截：批量纠错要烧 N 次调用，悄悄只做前 N 条等于骗用户
    return { outcome: "error", results: [], writes: 0, deletes: 0, failed: 0, error: `too-many-items:${items.length}>${cap}` };
  }
  const results = [];
  let writes = 0;
  let deletes = 0;
  let failed = 0;
  for (const item of items) {
    const target = typeof item?.target === "string" ? item.target.trim() : "";
    const reason = typeof item?.reason === "string" ? item.reason : "";
    const scope = typeof item?.scope === "string" && item.scope.length > 0 ? item.scope : "project";
    if (target.length === 0 || reason.trim().length === 0) {
      // 单条缺参：该条判失败，继续下一条（一条填漏不该让整批白跑）
      failed += 1;
      results.push({ target, outcome: "error", error: target.length === 0 ? "missing-target" : "empty-complaint" });
      continue;
    }
    // 逐条**定位**（resolveBody/resolveNeighbors）也可能抛错（scope 解析失败）：
    // 任一条抛错只废该条，绝不让它冲出循环——否则前面已落盘的条目会从回报里
    // 消失，用户看到「整批没执行」而盘上已有改动，重试还会再烧一次调用。
    // 注意只把定位层的调用包进 try：applyCorrection 内部对 LLM/解析/落盘的失败
    // 有自己的判 error 语义（missing-wiring / llm-error / parse-error / apply-error），
    // 外层 catch 只接定位抛错，不接它的返回值。
    let currentBody = "";
    let neighbors = "";
    let projectRoot = "";
    try {
      currentBody = typeof resolveBody === "function" ? resolveBody(item) : "";
      neighbors = typeof resolveNeighbors === "function" ? resolveNeighbors(item) : "";
      projectRoot = typeof projectRootOf === "function" ? projectRootOf(item) : "";
    } catch (error) {
      failed += 1;
      results.push({ target, outcome: "error", error: String(error?.code ?? error?.message ?? error) });
      continue;
    }
    const one = await applyCorrection({
      storageRoot,
      target,
      currentBody,
      reason,
      kind: item?.kind,
      scopeLabel: scope,
      neighbors,
      parseOps,
      callLlm,
      applyOps,
      projectRoot,
      originSessionId,
      settings,
      log,
    });
    results.push({ target, ...one });
    if (one.outcome === "applied") {
      writes += Number(one.writes ?? 0);
      deletes += Number(one.deletes ?? 0);
    } else if (one.outcome === "error") {
      failed += 1;
    }
  }
  const applied = results.filter((r) => r.outcome === "applied").length;
  // 汇总写后校验被打回的处数：逐条 results 里有，但顶部不汇总的话，
  // 批量对话框只写「全部成功」，用户看不出某一条里有一处没改成。
  const verifyFailed = results.reduce((sum, r) => {
    const n = Number(r?.verifyFailed ?? 0);
    return sum + (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  }, 0);
  // 四档，判据是「有没有 applied」与「有没有失败」两个正交事实：
  //   applied   = 每条都改成了
  //   error     = 一条都没成且全部失败（含单条全败）
  //   no-change = 一条都没成但没有失败（全是 needs-input/nothing）
  //               ——这不是失败，单条路径 needs-input 也报 success
  //   partial   = 有成的也有没成的
  // 没有 no-change 时全批 needs-input 会被报成 error，面板显示
  // 「全部失败（0 条失败）」而逐条写着「说明不够具体，未改动」。
  const outcome = applied === results.length
    ? "applied"
    : applied === 0 && failed === results.length ? "error"
      : applied === 0 ? "no-change"
        : "partial";
  return { outcome, results, writes, deletes, failed, verifyFailed };
}

/**
 * 读记录最近 N 条（面板/命令展示用）。坏行跳过，不整档失败。
 * @returns {Array<object>} 新在前
 */
export function readCorrectionLedger(storageRoot, { limit = CORRECTION_RING_MAX } = {}) {
  const path = ledgerPath(storageRoot);
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") out.push(parsed);
    } catch {
      /* 坏行跳过（手工编辑/半行截断），不让一条脏行挡住整份记录 */
    }
  }
  return out;
}

/** 记录文件统计（面板数据卡展示：条数 + 最近写入时刻）。 */
export function correctionLedgerStats(storageRoot) {
  const path = ledgerPath(storageRoot);
  if (!existsSync(path)) return { entries: 0, lastAt: null, bytes: 0 };
  try {
    const st = statSync(path);
    const raw = readFileSync(path, "utf8");
    const entries = raw.split("\n").filter((l) => l.trim().length > 0).length;
    return { entries, lastAt: new Date(st.mtimeMs).toISOString(), bytes: st.size };
  } catch {
    return { entries: 0, lastAt: null, bytes: 0 };
  }
}

/**
 * 按条目归组纠错记录：回答「这条记忆被改过几次、最近一次改了什么」。
 *
 * 为什么需要：readCorrectionLedger 是时间倒序的平铺视图，能看「最近改了什么」，
 * 但答不了「这一条的纠错史」——条目多起来后平铺视图里同一 target 的行会隔很远。
 *
 * 口径（不臆造）：
 *   - 只归组真正改了盘的（applied 才有盘上后果），needs-input / nothing / failed 不入组——
 *     它们没有改变任何记忆，混进来会让「改过几次」虚高；
 *   - 组内行保持时间倒序（与平铺视图一致，新在前）；
 *   - scope + target 才是盘上唯一键：同名 .md 在 project 与 global:<cat> 是两个文件，
 *     记录行带 scope 就用它区分，不带（老记录）退回空 scope。
 *
 * @param storageRoot
 * @param {{limit?: number, target?: string, scope?: string, maxGroups?: number}} [options]
 * @returns {{groups: Array<object>, total: number, truncated: boolean, entries: number}}
 */
export function groupCorrectionsByTarget(storageRoot, {
  limit = CORRECTION_RING_MAX,
  target = "",
  scope = "",
  maxGroups = 50,
} = {}) {
  // 归组要扫**全量**记录，不能套 limit：readCorrectionLedger 是「从尾部读 N 条」，
  // 套了 maxGroups*4 会让历史超过该窗口的条目查出来是「没有改过」——
  // 用户据此判断要不要再纠一次，静默丢历史比丢计数更糟。
  // 文件本身有 1000 行轮转上限（CORRECTION_LEDGER_ROTATE_AT），全量读有界。
  const rows = readCorrectionLedger(storageRoot, { limit: CORRECTION_LEDGER_ROTATE_AT });
  const wantTarget = typeof target === "string" ? target.trim() : "";
  const wantScope = typeof scope === "string" ? scope.trim() : "";
  const groups = new Map();
  let entries = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    // 只归组真正改了盘的：applied 之外的结局没有盘上后果
    if (String(row.outcome ?? "") !== "applied") continue;
    if (wantTarget.length > 0 && String(row.target ?? "") !== wantTarget) continue;
    if (wantScope.length > 0 && String(row.scope ?? "") !== wantScope) continue;
    entries += 1;
    const key = `${String(row.scope ?? "")}\u0000${String(row.target ?? "")}`;
    if (!groups.has(key)) {
      groups.set(key, {
        target: String(row.target ?? ""),
        scope: String(row.scope ?? ""),
        count: 0,
        writes: 0,
        deletes: 0,
        verifyFailed: 0,
        lastAt: typeof row.at === "string" ? row.at : null,
        kinds: [],
        rows: [],
      });
    }
    const group = groups.get(key);
    group.count += 1;
    group.writes += Number.isFinite(row.writes) ? Math.floor(row.writes) : 0;
    group.deletes += Number.isFinite(row.deletes) ? Math.floor(row.deletes) : 0;
    group.verifyFailed += Number.isFinite(row.verifyFailed) ? Math.floor(row.verifyFailed) : 0;
    const kind = String(row.kind ?? "");
    if (kind.length > 0 && !group.kinds.includes(kind)) group.kinds.push(kind);
    group.rows.push(row);
  }
  const list = [...groups.values()].sort((a, b) => {
    // 组间按最近一次时间倒序；时间相同退回 target 名（确定性，别让 UI 抖动）
    const at = a.lastAt ?? "";
    const bt = b.lastAt ?? "";
    if (at !== bt) return at < bt ? 1 : -1;
    return a.target.localeCompare(b.target);
  });
  const cap = Number.isFinite(maxGroups) && maxGroups > 0 ? Math.floor(maxGroups) : 50;
  return {
    groups: list.slice(0, cap),
    total: list.length,
    truncated: list.length > cap,
    entries,
  };
}

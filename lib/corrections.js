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
//   每次应用一条，记录 {at, kind, target, action, writes, deletes, verifyFailed,
//   reason, originSessionId}。落盘纪律同 journal.js：追加串行化、原子写、
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
export const CORRECTION_BODY_CHARS = 4000;

/** 记录内存环形缓冲上限（面板/命令读最近记录用）。 */
export const CORRECTION_RING_MAX = 20;

const CORRECTION_KINDS = new Set(["wrong-fact", "outdated", "wrong-scope", "duplicate", "other"]);

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
    failed: 0,
    lastAt: null,
    lastOutcome: null,
    lastTarget: null,
    lastReason: null,
    recent: [],
  });
}

function note({ outcome, target = "", reason = "", writes = 0, deletes = 0 }) {
  ledgerState.runs += 1;
  ledgerState.lastAt = Date.now();
  ledgerState.lastOutcome = outcome;
  ledgerState.lastTarget = typeof target === "string" && target.length > 0 ? target : null;
  ledgerState.lastReason = reason;
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
  return CORRECTION_KINDS.has(value) ? value : "other";
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
  if (writes + deletes <= 0) {
    // ops 全被闸拦下（sha1 不符 / 锁冲突 / 校验失败）：不得谎报 applied。
    note({ outcome: "failed", target, reason: "no-op-applied" });
    return { outcome: "error", error: "no-op-applied", writes: 0, deletes: 0, applyResult: result };
  }

  note({ outcome: "applied", target, reason: kindValue, writes, deletes });
  appendLedger(storageRoot, {
    at: new Date().toISOString(),
    kind: kindValue,
    target,
    scope: scopeLabel,
    writes,
    deletes,
    verifyFailed: Number(result?.verifyFailed ?? 0),
    originSessionId: typeof originSessionId === "string" ? originSessionId : "",
  }, log);
  log.info?.(`纠错：${target} → ${writes} 写 / ${deletes} 删（${kindValue}）`);
  return { outcome: "applied", writes, deletes, applyResult: result };
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

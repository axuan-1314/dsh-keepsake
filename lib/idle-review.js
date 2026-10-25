// 空闲整理（idle review）：有新增项目记忆后，用一次 LLM 调用提出最多 3 个合并/清理 op。
// 设计参照 mnemon 的 idle review 三道闸，但触发与预算更保守：
//   - 默认关（settings.idleReviewEnabled）；
//   - 只在提取确实写了新条目的会话上调度；
//   - 每会话最小间隔 / 次数上限由 index.js 的调度层控制；本模块只做「一次审查」。
// 模型只提案，落盘仍走 applyScopedOps（批锁、快照、sha1 覆盖闸、写后校验全部照旧）。
import { buildManifestText } from "./manifest.js";
import { parseExtractionOutput } from "./extract.js";
import { redactOps, redactSensitive } from "./redact.js";

export const IDLE_REVIEW_MAX_OPS = 3;
export const IDLE_REVIEW_BODY_FILES = 12;
export const IDLE_REVIEW_BODY_CHARS = 1200;

const idleState = {
  runs: 0,
  written: 0,
  deletes: 0,
  skipped: 0,
  errors: 0,
  lastAt: null,
  lastOutcome: null,
  lastWrites: 0,
  lastDeletes: 0,
  lastError: null,
};

function recordIdleReview({ outcome, writes = 0, deletes = 0, error = null }) {
  idleState.runs += 1;
  idleState.lastAt = Date.now();
  idleState.lastOutcome = outcome;
  idleState.lastWrites = Number.isFinite(writes) && writes > 0 ? Math.floor(writes) : 0;
  idleState.lastDeletes = Number.isFinite(deletes) && deletes > 0 ? Math.floor(deletes) : 0;
  idleState.lastError = typeof error === "string" && error.length > 0 ? error.slice(0, 300) : null;
  if (outcome === "written") {
    idleState.written += 1;
    idleState.deletes += idleState.lastDeletes;
  } else if (outcome === "skipped" || outcome === "nothing") {
    idleState.skipped += 1;
  } else if (outcome === "error") {
    idleState.errors += 1;
  }
}

export function idleReviewSnapshot() {
  return { ...idleState };
}

export function __resetIdleReviewStateForTest() {
  Object.assign(idleState, {
    runs: 0,
    written: 0,
    deletes: 0,
    skipped: 0,
    errors: 0,
    lastAt: null,
    lastOutcome: null,
    lastWrites: 0,
    lastDeletes: 0,
    lastError: null,
  });
}

function projectIdFromMemoryDir(memoryDir) {
  const parts = String(memoryDir ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

/**
 * 整理提示词：只看最近条目（manifest 全量 + 最近 12 个正文），最多 3 个 op。
 * ops 契约与提取一致（write 需完整正文；覆盖项目文件必须带 manifest 里的 sha1）。
 */
export function buildIdleReviewPayload({ projectId = "", manifest, bodies }) {
  const system = [
    "You are the memory curator for dsh-keepsake.",
    "Review the recent project memory entries and propose at most 3 consolidation operations.",
    "Goals, in priority order:",
    "1. Merge near-duplicate entries into one better entry (write the merged body, delete the redundant files).",
    "2. Update an entry that is now stale or incomplete (write the complete new body with the manifest sha1).",
    "3. Delete an entry that is clearly obsolete and not a source of truth (delete goes to trash).",
    "",
    "Rules:",
    "- Project scope only; never write global:* scopes.",
    "- Preserve hard facts (numbers, versions, hex ids, byte sizes); do not invent facts or reasons.",
    "- Keep code, paths and identifiers verbatim; do not summarize away evidence that the entries need.",
    "- A write's content is the COMPLETE new body of the file (it replaces the old body).",
    "- To update an existing project file you MUST copy the sha1 from its manifest line into the op: \"sha1\":\"xxxxxxxx\".",
    "- If there is nothing worth consolidating, reply with exactly: Nothing to save.",
    "- Otherwise reply with ONE JSON object and nothing else:",
    '{"ops":[{"action":"write","name":"kebab-name.md","type":"project","title":"Title","description":"one-line hook","sha1":"ab12cd34","content":"full markdown body"},{"action":"delete","name":"obsolete.md"}]}',
  ].join("\n");
  const user = [
    projectId.length > 0 ? `Project: ${projectId}` : "",
    "",
    "Current memory manifest:",
    manifest || "(empty)",
    "",
    "Recent entry bodies (most recent first):",
    bodies || "(none)",
    "",
    "Propose at most 3 project-scope ops now. Reply per the output contract.",
  ].filter((line) => line !== "").join("\n");
  return { system, user };
}

/** 解析并收紧审查输出：只留 project ops，最多 3 个；nothing 显式返回。 */
export function parseIdleReviewOutput(text) {
  const parsed = parseExtractionOutput(text);
  if (parsed.kind === "nothing") return { kind: "nothing", ops: [], filtered: 0 };
  const all = parsed.ops ?? [];
  const ops = all
    .filter((op) => (op.scope ?? "project") === "project")
    .slice(0, IDLE_REVIEW_MAX_OPS);
  const filtered = all.length - ops.length;
  if (ops.length === 0) return { kind: "nothing", ops: [], filtered };
  return { kind: "ops", ops, filtered };
}

/**
 * 执行一次整理审查。所有失败都返回 outcome=error（后台链路不抛，不炸宿主）。
 * @param {{
 *   storageRoot: string, memoryDir: string, callLlm: (payload: {system:string,user:string}) => Promise<{text:string}>,
 *   applyOps: Function, originSessionId?: string, settings?: object, log?: object
 * }} input
 * @returns {Promise<{outcome:"written"|"nothing"|"skipped"|"error", writes?:number, deletes?:number, error?:string}>}
 */
export async function runIdleReview({
  storageRoot,
  memoryDir,
  callLlm,
  applyOps,
  originSessionId = "",
  settings = null,
  log = {},
} = {}) {
  if (typeof memoryDir !== "string" || memoryDir.length === 0) {
    recordIdleReview({ outcome: "skipped" });
    return { outcome: "skipped", reason: "no-project" };
  }
  if (typeof callLlm !== "function" || typeof applyOps !== "function") {
    recordIdleReview({ outcome: "error", error: "missing-call-llm-or-apply-ops" });
    return { outcome: "error", error: "missing-call-llm-or-apply-ops" };
  }
  let sources;
  try {
    sources = buildManifestText(memoryDir, {
      maxFiles: 200,
      bodyFiles: IDLE_REVIEW_BODY_FILES,
      maxBodyChars: IDLE_REVIEW_BODY_CHARS,
    });
  } catch (error) {
    recordIdleReview({ outcome: "error", error: error?.message });
    return { outcome: "error", error: String(error?.message ?? error) };
  }
  const entryLines = String(sources.manifest ?? "").split("\n").filter((line) => line.trim().length > 0);
  if (entryLines.length < 2) {
    recordIdleReview({ outcome: "skipped" });
    return { outcome: "skipped", reason: "too-few-entries" };
  }
  const manifest = redactSensitive(sources.manifest);
  const bodies = redactSensitive(sources.bodies);
  const payload = buildIdleReviewPayload({
    projectId: projectIdFromMemoryDir(memoryDir),
    manifest,
    bodies,
  });
  let text;
  try {
    const result = await callLlm(payload);
    text = typeof result === "string" ? result : result?.text;
  } catch (error) {
    recordIdleReview({ outcome: "error", error: error?.message });
    log.warn?.("空闲整理：LLM 调用失败", error);
    return { outcome: "error", error: String(error?.message ?? error) };
  }
  let parsed;
  try {
    parsed = parseIdleReviewOutput(text);
  } catch (error) {
    recordIdleReview({ outcome: "error", error: error?.message });
    log.warn?.("空闲整理：输出解析失败", error);
    return { outcome: "error", error: String(error?.message ?? error) };
  }
  if (parsed.kind === "nothing") {
    recordIdleReview({ outcome: "nothing" });
    return { outcome: "nothing", filtered: parsed.filtered };
  }
  const safeOps = redactOps(parsed.ops).ops;
  try {
    const result = applyOps(
      { storageRoot, projectRoot: memoryDir },
      safeOps,
      { originSessionId, allowGlobal: false, allowProject: true, settings, log },
    );
    const writes = Number(result?.writes ?? 0);
    const deletes = Number(result?.deletes ?? 0);
    if (writes + deletes <= 0) {
      recordIdleReview({ outcome: "nothing" });
      return { outcome: "nothing", writes: 0, deletes: 0, filtered: parsed.filtered };
    }
    recordIdleReview({ outcome: "written", writes, deletes });
    log.info?.(`空闲整理：应用 ${writes} 写 / ${deletes} 删`);
    return { outcome: "written", writes, deletes, filtered: parsed.filtered, applyResult: result };
  } catch (error) {
    recordIdleReview({ outcome: "error", error: error?.message });
    log.error?.("空闲整理：落盘失败", error);
    return { outcome: "error", error: String(error?.message ?? error) };
  }
}

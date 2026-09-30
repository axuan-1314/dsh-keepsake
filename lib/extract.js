// dsh-memory 提取执行（v1 简化决策：单次 ctx.llm 调用，不起子任务 loop）。
//   输入 = 增量 transcript 摘录 + 现有记忆 manifest（含最近小文件正文）；
//   输出 = "Nothing to save." 或一个 JSON {ops:[...]}；
//   落盘由插件完成：文件名三道闸（边界②③）在写路径上强制，不信任模型提议路径。
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { INDEX_FILENAME, resolveSafeMemoryTarget } from "./filename.js";
import { buildIndexLine, mergeIndexContent } from "./manifest.js";
import { renderTranscript, skipReason } from "./transcript.js";

export const NOTHING_TO_SAVE = "Nothing to save.";

const MEMORY_TYPES = new Set(["user", "feedback", "project", "reference"]);
const MAX_CONTENT_CHARS = 20000;

/**
 * 解析提取模型输出。
 * @returns { kind: 'nothing' } | { kind: 'ops', ops: [...] }
 * @throws 解析失败/结构非法时抛错（调用方按 error 处理，cursor 不推进）。
 */
export function parseExtractionOutput(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0) throw new Error("dsh-memory: 提取输出为空");
  if (/^nothing to save\.?$/i.test(trimmed)) return { kind: "nothing" };
  let payload = trimmed;
  const fenced = payload.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) payload = fenced[1];
  const start = payload.indexOf("{");
  const end = payload.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("dsh-memory: 提取输出中未找到 JSON 对象");
  const parsed = JSON.parse(payload.slice(start, end + 1));
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.ops)) {
    throw new Error("dsh-memory: 提取输出缺少 ops 数组");
  }
  const ops = [];
  for (const raw of parsed.ops) {
    if (raw === null || typeof raw !== "object") throw new Error("dsh-memory: op 必须是对象");
    if (raw.action === "delete") {
      if (typeof raw.name !== "string") throw new Error("dsh-memory: delete op 缺少 name");
      ops.push({ action: "delete", name: raw.name });
      continue;
    }
    if (raw.action === "write") {
      if (typeof raw.name !== "string" || raw.name.length === 0) throw new Error("dsh-memory: write op 缺少 name");
      if (typeof raw.content !== "string") throw new Error("dsh-memory: write op 缺少 content");
      if (raw.content.length > MAX_CONTENT_CHARS) throw new Error("dsh-memory: write op content 超长");
      const type = MEMORY_TYPES.has(raw.type) ? raw.type : "project";
      ops.push({
        action: "write",
        name: raw.name,
        type,
        title: typeof raw.title === "string" ? raw.title : raw.name,
        description: typeof raw.description === "string" ? raw.description : "",
        indexLine: typeof raw.indexLine === "string" && raw.indexLine.trim().length > 0 ? raw.indexLine : void 0,
        content: raw.content,
      });
      continue;
    }
    throw new Error(`dsh-memory: 未知 op action "${String(raw.action)}"`);
  }
  return { kind: "ops", ops };
}

/** 前端 frontmatter 渲染（规格：name/description/metadata.type + node_type/originSession 运行时补充）。 */
export function renderMemoryFile({ name, description, type, originSessionId, content }) {
  const esc = (v) => String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
  return [
    "---",
    `name: "${esc(name)}"`,
    `description: "${esc(description)}"`,
    "metadata:",
    `  type: ${MEMORY_TYPES.has(type) ? type : "project"}`,
    'node_type: "memory"',
    `originSessionId: "${esc(originSessionId)}"`,
    "---",
    "",
    String(content ?? "").trimEnd(),
    "",
  ].join("\n");
}

/**
 * 把解析出的 ops 落盘。全部写操作经 resolveSafeMemoryTarget 三道闸（边界②③）。
 * @returns { writes, deletes, skipped } 计数
 */
export function applyOps(memoryRoot, ops, { originSessionId = "", log = { warn: () => {} } } = {}) {
  let writes = 0;
  let deletes = 0;
  let skipped = 0;
  const touched = [];
  const deletedNames = [];
  for (const op of ops) {
    if (op.action === "write") {
      const target = resolveSafeMemoryTarget(memoryRoot, op.name);
      if (target === null) {
        skipped += 1;
        log.warn(`记忆文件名未通过安全闸，已跳过: ${op.name}`);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      const body = renderMemoryFile({
        name: op.name.replace(/\.md$/i, "").replace(/\//g, "-"),
        description: op.description,
        type: op.type,
        originSessionId,
        content: op.content,
      });
      writeFileSync(target, body, "utf8");
      touched.push({
        name: op.name,
        title: op.title,
        description: op.description,
        line: op.indexLine ?? buildIndexLine(op.title, op.name, op.description),
      });
      writes += 1;
      continue;
    }
    if (op.action === "delete") {
      const target = resolveSafeMemoryTarget(memoryRoot, op.name);
      if (target === null) {
        skipped += 1;
        log.warn(`待删记忆文件名未通过安全闸，已跳过: ${op.name}`);
        continue;
      }
      if (existsSync(target)) {
        rmSync(target, { force: true });
        deletedNames.push(op.name);
        deletes += 1;
      }
    }
  }
  // MEMORY.md 重建（存在任何写/删时；索引文件本身永远不被模型触碰）
  if (touched.length > 0 || deletedNames.length > 0) {
    const indexPath = join(memoryRoot, INDEX_FILENAME);
    const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
    writeFileSync(indexPath, mergeIndexContent(existing, touched, deletedNames), "utf8");
  }
  return { writes, deletes, skipped };
}

/**
 * 组装一次提取调用的提示词（照规格骨架的单次调用版）。
 */
export function buildExtractionPayload({ transcript, manifest, bodies, memoryRoot, minWordsNote = "" }) {
  const system = [
    "You are the project-memory extractor of the dsh-memory plugin for DeepSeek Harness.",
    "Analyze the conversation increment and maintain this project's persistent memory directory.",
    "",
    "Memory conventions:",
    "- One file = one fact. File name is kebab-case English; content language follows the user's language.",
    "- metadata.type is one of: user (who the user is), feedback (how to behave, with Why:/How to apply: sections), project (decisions and state of this project), reference (pointers to external material).",
    "- Link related memories with [[another-memory-name]]; dangling links are fine.",
    "- Prefer updating existing memories over creating near-duplicates.",
    "- Do NOT save what the repository already records, trivial session-only details, or code dumps.",
    "- If the user asked you to remember something, save it. If the user asked to forget something, delete the memory file.",
    "",
    `The memory directory is: ${memoryRoot}`,
    "Its current state follows (manifest first, then full bodies of the most recent small files):",
    "",
    manifest || "(empty — no memories yet)",
    bodies ? `\n${bodies}` : "",
    "",
    "Output contract (strict):",
    `- If nothing is worth saving, reply with exactly: ${NOTHING_TO_SAVE}`,
    "- Otherwise reply with ONE JSON object and nothing else (no markdown fence, no commentary):",
    '{"ops":[{"action":"write","name":"kebab-name.md","type":"user|feedback|project|reference","title":"Title","description":"one-line recall hook","indexLine":"- [Title](kebab-name.md) — one-line hook <=150 chars","content":"full markdown body WITHOUT frontmatter"},{"action":"delete","name":"obsolete.md"}]}',
    "- At most 20 ops. content must be the COMPLETE new body of the file (it replaces any old body).",
    minWordsNote,
  ]
    .filter((line) => line !== "")
    .join("\n");
  const user = `Conversation increment to analyze:\n\n${transcript || "(no message body captured)"}\n\nUpdate the persistent memory now. Reply per the output contract.`;
  return { system, user };
}

export { skipReason, renderTranscript };

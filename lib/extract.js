// dsh-memory 提取执行（v1 简化决策：单次 ctx.llm 调用，不起子任务 loop）。
//   输入 = 增量 transcript 摘录 + 现有记忆 manifest（含最近小文件正文）；
//   输出 = "Nothing to save." 或一个 JSON {ops:[...]}；
//   落盘由插件完成：文件名三道闸（边界②③）在写路径上强制，不信任模型提议路径。
// ops 扩展：
//   - op.scope 协议：合法集 project（缺省）/ global:work-profile / global:user-profile /
//     global:current-focus / global:recent-activity / global:long-term；
//   - applyScopedOps 按 scope 查根路由表逐根落盘（每个根 MEMORY.md 重建原样复用）；
//   - recent-activity 写入 host 盖 metadata.timestamp（不信模型报的时间）；
//   - 全局提取开关关 → global:* ops 过滤并计数（显式可观测，不 fail-open）；
//   - 未知 scope 显式 skip + warn（不炸整批）。
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { INDEX_FILENAME, resolveSafeMemoryTarget, sanitizeMemoryName } from "./filename.js";
import { buildIndexLine, INDEX_LINE_MAX_CHARS, mergeIndexContent } from "./manifest.js";
import { renderTranscript, skipReason } from "./transcript.js";
import { CATEGORY_IDS, categoryDir, deleteEntry as deleteGlobalEntry, isCategoryId, writeEntryDirect } from "./global-store.js";

export const NOTHING_TO_SAVE = "Nothing to save.";

const MEMORY_TYPES = new Set(["user", "feedback", "project", "reference"]);
const MAX_CONTENT_CHARS = 20000;

/** 合法 scope 集（缺省 project；global:* 与 global-store 分类一一对应）。 */
export const VALID_SCOPES = new Set(["project", ...CATEGORY_IDS.map((id) => `global:${id}`)]);

/**
 * 模型 indexLine 合法性校验：
 * 非空、≤150 字符、形如 `- [Title](file.md) — hook`、且引用文件名归一后与 op.name 一致。
 * 非法行回退插件规范行，防 MEMORY.md 里不可解析行累积成 preamble 并重复追加。
 */
export function isValidModelIndexLine(line, name) {
  if (typeof line !== "string") return false;
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > INDEX_LINE_MAX_CHARS) return false;
  const matched = trimmed.match(/^- \[[^\]]+\]\(([^()\s]+\.md)\) — \S.*$/);
  if (matched === null) return false;
  const referenced = sanitizeMemoryName(matched[1]);
  const target = sanitizeMemoryName(name);
  return referenced !== null && target !== null && referenced === target;
}

/**
 * 解析提取模型输出（单条坏 op 跳单容错，不再一票否决整批——
 * 好 ops 照落、坏 ops 计数可见；仅整 payload 非 JSON / 缺 ops 数组才拒整批）。
 * @returns { kind: 'nothing' } | { kind: 'ops', ops: [...], skippedMalformed: n }
 * @throws 仅整批不可解析时抛错（调用方按 error 处理，cursor 不推进）。
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
  let skippedMalformed = 0;
  for (const raw of parsed.ops) {
    if (raw === null || typeof raw !== "object") {
      skippedMalformed += 1;
      continue;
    }
    if (raw.action === "delete") {
      if (typeof raw.name !== "string") {
        skippedMalformed += 1;
        continue;
      }
      ops.push({ action: "delete", name: raw.name, scope: typeof raw.scope === "string" ? raw.scope : "project" });
      continue;
    }
    if (raw.action === "write") {
      if (typeof raw.name !== "string" || raw.name.length === 0 || typeof raw.content !== "string" || raw.content.length > MAX_CONTENT_CHARS) {
        skippedMalformed += 1;
        continue;
      }
      const type = MEMORY_TYPES.has(raw.type) ? raw.type : "project";
      ops.push({
        action: "write",
        name: raw.name,
        type,
        title: typeof raw.title === "string" ? raw.title : raw.name,
        description: typeof raw.description === "string" ? raw.description : "",
        indexLine: typeof raw.indexLine === "string" && raw.indexLine.trim().length > 0 ? raw.indexLine : void 0,
        content: raw.content,
        scope: typeof raw.scope === "string" ? raw.scope : "project",
      });
      continue;
    }
    skippedMalformed += 1;
  }
  return { kind: "ops", ops, skippedMalformed };
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
 * 逐 op try/catch 隔离——单条 IO 失败（文件被锁/磁盘满）计 failed
 * 不中断整批，斩断"整轮 error→cursor 不推进→确定性重试循环"。
 * 同批 write+delete 同名按终态对账（write 后 delete = 文件删、索引不留悬挂行）。
 * @returns { writes, deletes, skipped, failed } 计数
 */
export function applyOps(memoryRoot, ops, { originSessionId = "", log = { warn: () => {}, error: () => {} } } = {}) {
  let writes = 0;
  let deletes = 0;
  let skipped = 0;
  let failed = 0;
  const touched = [];
  const deletedNames = [];
  for (const op of ops) {
    try {
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
        // 原子写（tmp+rename，写一半进程死不损旧档）
        const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
        writeFileSync(tmp, body, "utf8");
        renameSync(tmp, target);
        let indexLine = buildIndexLine(op.title, op.name, op.description);
        if (typeof op.indexLine === "string" && op.indexLine.trim().length > 0) {
          if (isValidModelIndexLine(op.indexLine, op.name)) {
            indexLine = op.indexLine.trim();
          } else {
            log.warn(`模型 indexLine 非法（格式/长度/文件名不匹配），已回退规范行: ${op.indexLine.trim().slice(0, 80)}`);
          }
        }
        touched.push({
          name: op.name,
          title: op.title,
          description: op.description,
          line: indexLine,
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
    } catch (error) {
      failed += 1;
      log.error(`记忆 op 落盘失败（跳过该条继续整批）: ${op.action} ${String(op.name).slice(0, 80)}`, error);
    }
  }
  // MEMORY.md 重建（存在任何写/删时；索引文件本身永远不被模型触碰）。
  // 终态对账：同批 write 后 delete 的名字，索引按 delete 终态走（防悬挂行）。
  const deletedSet = new Set(deletedNames.map((n) => n.toLowerCase()));
  const finalTouched = touched.filter((t) => !deletedSet.has(String(t.name).toLowerCase()));
  if (finalTouched.length > 0 || deletedNames.length > 0) {
    const indexPath = join(memoryRoot, INDEX_FILENAME);
    const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
    const tmp = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, mergeIndexContent(existing, finalTouched, deletedNames), "utf8");
    renameSync(tmp, indexPath);
  }
  return { writes, deletes, skipped, failed };
}

/**
 * scope 路由落盘：按 op.scope 分组——
 *   project → applyOps(projectRoot)（原逻辑）；
 *   global:<category> → writeEntryDirect/deleteEntry（global-store，覆盖写语义，
 *     recent-activity 由 global-store 盖 host timestamp）；
 *   allowGlobal=false（全局提取开关关）→ global:* ops 过滤并计数；
 *   allowProject=false（项目记忆开关关）→ project ops 过滤并计数（对称推定）；
 *   未知 scope → 显式 skip + warn（不炸整批）。
 * @returns { writes, deletes, skipped, filteredGlobal, filteredProject, unknownScope, byScope }
 */
export function applyScopedOps(
  { storageRoot, projectRoot },
  ops,
  { originSessionId = "", allowGlobal = true, allowProject = true, log = { warn: () => {} } } = {},
) {
  const projectOps = [];
  const globalOpsByCategory = new Map();
  let unknownScope = 0;
  let filteredGlobal = 0;
  let filteredProject = 0;
  for (const op of ops) {
    const scope = typeof op.scope === "string" && op.scope.length > 0 ? op.scope : "project";
    if (scope === "project") {
      if (!allowProject) {
        filteredProject += 1;
        continue;
      }
      projectOps.push(op);
      continue;
    }
    const matched = scope.match(/^global:([a-z-]+)$/);
    if (matched !== null && isCategoryId(matched[1])) {
      if (!allowGlobal) {
        filteredGlobal += 1; // 开关关=过滤计数（不整轮丢弃）
        continue;
      }
      const bucket = globalOpsByCategory.get(matched[1]) ?? [];
      bucket.push(op);
      globalOpsByCategory.set(matched[1], bucket);
      continue;
    }
    unknownScope += 1;
    log.warn(`未知 scope 显式跳过: ${String(scope).slice(0, 60)}（op ${op.action} ${String(op.name).slice(0, 60)}）`);
  }

  let writes = 0;
  let deletes = 0;
  let skipped = 0;
  let failed = 0;
  const byScope = {};

  if (projectOps.length > 0) {
    const result = applyOps(projectRoot, projectOps, { originSessionId, log });
    writes += result.writes;
    deletes += result.deletes;
    skipped += result.skipped;
    failed += result.failed;
    byScope.project = { writes: result.writes, deletes: result.deletes, skipped: result.skipped, failed: result.failed };
  }

  for (const [categoryId, catOps] of globalOpsByCategory) {
    let w = 0;
    let d = 0;
    let s = 0;
    let f = 0;
    for (const op of catOps) {
      try {
        if (op.action === "write") {
          const written = writeEntryDirect(storageRoot, categoryId, {
            name: op.name,
            title: op.title,
            description: op.description,
            content: op.content,
            // timestamp 不传：recent-activity 由 global-store host 盖章
          });
          if (written === null) {
            s += 1;
            log.warn(`全局记忆文件名未通过安全闸，已跳过: ${op.name}`);
          } else {
            w += 1;
          }
        } else if (op.action === "delete") {
          // 与 write 对称——被三道闸拒绝显式计 skipped+warn，不再无声消失
          const target = resolveSafeMemoryTarget(categoryDir(storageRoot, categoryId), op.name);
          if (target === null) {
            s += 1;
            log.warn(`全局待删记忆文件名未通过安全闸，已跳过: ${op.name}`);
            continue;
          }
          if (deleteGlobalEntry(storageRoot, categoryId, op.name)) d += 1;
        }
      } catch (error) {
        f += 1;
        log.error(`全局记忆 op 落盘失败（跳过该条继续整批）: ${op.action} ${String(op.name).slice(0, 80)}`, error);
      }
    }
    writes += w;
    deletes += d;
    skipped += s;
    failed += f;
    byScope[`global:${categoryId}`] = { writes: w, deletes: d, skipped: s, failed: f };
  }

  return { writes, deletes, skipped, failed, filteredGlobal, filteredProject, unknownScope, byScope };
}

/**
 * 组装一次提取调用的提示词（照规格骨架的单次调用版）。
 * globalManifest（四分类+长期记忆现状）与分类定义进 prompt；
 * 输出契约 ops 支持 scope 字段（缺省 project）。
 */
export function buildExtractionPayload({ transcript, manifest, bodies, memoryRoot, globalManifest = "" }) {
  const system = [
    "You are the project-memory extractor of the dsh-memory plugin for DeepSeek Harness.",
    "Analyze the conversation increment and maintain this project's persistent memory directory, plus the user-level global memory when appropriate.",
    "",
    "Memory conventions:",
    "- One file = one fact. File name is kebab-case English; content language follows the user's language.",
    "- metadata.type is one of: user (who the user is), feedback (how to behave, with Why:/How to apply: sections), project (decisions and state of this project), reference (pointers to external material).",
    "- Link related memories with [[another-memory-name]]; dangling links are fine.",
    "- Prefer updating existing memories over creating near-duplicates.",
    "- Do NOT save what the repository already records, trivial session-only details, or code dumps.",
    "- If the user asked you to remember something, save it. If the user asked to forget something, delete the memory file.",
    "",
    "Scopes (where to save):",
    '- "project" (default): facts bound to THIS project/workspace only.',
    '- "global:work-profile" — 工作背景：用户的职业角色、团队、工作方式、技术栈等跨项目稳定信息。',
    '- "global:user-profile" — 用户个人背景：用户是谁、偏好、习惯、沟通风格。',
    '- "global:current-focus" — 当前关注：用户近期专注的目标、项目、问题（会随时间更新）。',
    '- "global:recent-activity" — 近期动态：最近发生的事件与进展（短期滚动窗口，勿写长期结论）。',
    '- "global:long-term" — 长期记忆：跨会话值得长期保留的重要结论与信息。',
    "Use a global scope only for facts that are clearly user-level and project-independent; otherwise keep the default project scope.",
    "",
    `The project memory directory is: ${memoryRoot}`,
    "Its current state follows (manifest first, then full bodies of the most recent small files):",
    "",
    manifest || "(empty — no memories yet)",
    bodies ? `\n${bodies}` : "",
    "",
    "Current global memory state (user-level, across projects):",
    "",
    globalManifest || "(empty — no global memories yet)",
    "",
    "Output contract (strict):",
    `- If nothing is worth saving, reply with exactly: ${NOTHING_TO_SAVE}`,
    "- Otherwise reply with ONE JSON object and nothing else (no markdown fence, no commentary):",
    '{"ops":[{"action":"write","name":"kebab-name.md","scope":"project","type":"user|feedback|project|reference","title":"Title","description":"one-line recall hook","indexLine":"- [Title](kebab-name.md) — one-line hook <=150 chars","content":"full markdown body WITHOUT frontmatter"},{"action":"delete","name":"obsolete.md","scope":"project"}]}',
    "- At most 20 ops. content must be the COMPLETE new body of the file (it replaces any old body).",
    '- scope is optional and defaults to "project"; global ops use the same kebab-case file naming.',
  ]
    .filter((line) => line !== "")
    .join("\n");
  const user = `Conversation increment to analyze:\n\n${transcript || "(no message body captured)"}\n\nUpdate the persistent memory now. Reply per the output contract.`;
  return { system, user };
}

export { skipReason, renderTranscript };

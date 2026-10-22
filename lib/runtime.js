// dsh-keepsake 运行时记忆层（L0）编译器 —— RUNTIME-FORMAT.md v2.1 的施工落点。
//
// 职责（纯编译 + 产物落盘 + 懒编译缓存）：
//   - 候选池：全局 user-profile/work-profile/current-focus + 当前 scope 项目条目；
//     项目条目按 metadata.type 映射（user→USER.md w3 / feedback→MEMORY.md w2 /
//     project→MEMORY.md w1）；reference / long-term / recent-activity 永不进 L0。
//   - 选条：pinned 全量优先入选（不参与淘汰）；其余按 (权重 desc, mtimeMs desc,
//     文件名升序, rootKey 升序) 顺序装填，装不下即停（不背包跳过）；装不下的登记
//     evictCandidates（每次编译全量重算，只登记不搬文件）。
//   - 渲染：AUTO-GENERATED 头 + 两行记忆根绝对路径 + `- 【关键|普通】[Title](relPath) — hook`。
//     Title/path 永不截断；hook 单独截 150 字符（不复用 clampIndexLine——它是整行截 150，
//     会吃掉标题/路径）。条目路径是从产物目录出发的相对路径（编辑器可点开）。
//   - 落盘：runtime/<scope>/{USER.md, MEMORY.md, runtime.json}，原子写（tmp+rename，
//     失败清 tmp）；runtime/ 全部是派生产物，整目录可删、下次编译自动重建。
//   - 懒编译：ensureCompiled 比对盘上候选池指纹 sourceHash，命中缓存不重写任何文件。
//
// 安全纪律：
//   - scope 只认 "global" 与 "projects/<slug>-<hash16>"（与 RUNTIME-FORMAT §十一 路由
//     正则同口径）；其余一律抛 SCOPE_INVALID，绝不把参数原样拼进路径（防 ../ 穿越）。
//   - 编译只读真源（global/ 与 projects/*/memory/ 的条目文件），只写 runtime/ 产物；
//     绝不搬移/删除任何条目文件（淘汰是「登记 + 面板确认」两阶段，执行在别的批次）。
//   - 候选池枚举/读失败按「跳过该条」降级（不炸整批）：读不到的条目等同不在池；
//     其后续恢复会再改一次指纹并触发重编，最终自洽。sourceHash 以 mtime+size 代理内容，
//     同尺寸等长改写会漏检——这是 §四 已声明的懒编译可接受延迟（下次增删改路径必重编）。
//   - 失效方式（invalidateRuntimeCache）：直接删该 scope 的产物目录（含 runtime.json），
//     下一次 ensureCompiled 必重编。scope=null 清全部 scope 目录，但**保留**
//     runtime/compile-journal.jsonl（观测历史不随产物失效而丢）。
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { INDEX_FILENAME } from "./filename.js";
import { parseFrontmatterHead } from "./manifest.js";
import { appendCompileJournal } from "./runtime-log.js";

/** 配额（UTF-8 字节口径；首部声明、行格式标记、告警行都计入）。 */
export const RUNTIME_QUOTAS = Object.freeze({ userBytes: 4096, memoryBytes: 10240 });
/** 选条/渲染算法版本：改版 +1，旧缓存随 sourceHash 自动失效（§四）。 */
export const RUNTIME_ALGO = 1;
/** runtime.json 结构版本（§四）。 */
export const RUNTIME_VERSION = 2;
export const RUNTIME_DIR_NAME = "runtime";

const SCOPE_GLOBAL = "global";
/** 项目 scope 形态与 RUNTIME-FORMAT §十一 的 matchRuntime 正则同口径。 */
const PROJECT_SCOPE_RE = /^projects\/[a-z0-9._-]+-[a-f0-9]{16}$/;
const USER_FILE = "USER.md";
const MEMORY_FILE = "MEMORY.md";
const MANIFEST_FILE = "runtime.json";

/**
 * §3.3 候选池来源表（全局条目按分类目录分组，metadata.type 恒为 global）。
 * 未列出的分类（recent-activity / long-term）不是候选池。
 */
const GLOBAL_SOURCES = Object.freeze([
  { category: "user-profile", target: "user", weight: 3 },
  { category: "work-profile", target: "memory", weight: 3 },
  { category: "current-focus", target: "memory", weight: 2 },
]);

/** §3.3 项目条目 metadata.type → 去向/权重；reference 不进正文（也不进候选池）。 */
const PROJECT_TYPE_MAP = Object.freeze({
  user: { target: "user", weight: 3 },
  feedback: { target: "memory", weight: 2 },
  project: { target: "memory", weight: 1 },
});

// ---- 路径 ----

/** `<storageRoot>/runtime`（全部编译产物的根）。 */
export function runtimeDir(storageRoot) {
  return join(storageRoot, RUNTIME_DIR_NAME);
}

/** scope 合法性：只认 global 与 projects/<slug>-<hash16>。 */
export function isValidScope(scope) {
  return scope === SCOPE_GLOBAL || (typeof scope === "string" && PROJECT_SCOPE_RE.test(scope));
}

function assertScope(scope) {
  if (isValidScope(scope)) return scope;
  const err = new Error(`dsh-keepsake: 非法 runtime scope "${String(scope)}"（只认 global 或 projects/<slug>-<hash16>）`);
  err.code = "SCOPE_INVALID";
  throw err;
}

/** `<storageRoot>/runtime/<scope>`；scope 非法直接抛错（绝不拼进路径）。 */
export function scopeDir(storageRoot, scope) {
  assertScope(scope);
  return join(runtimeDir(storageRoot), ...scope.split("/"));
}

/**
 * 盘上现存 scope 列表：恒含 "global"，其后是 projects/ 下匹配
 * `<slug>-<hash16>` 的目录（升序）。只读 projects/，不经 runtime/projects。
 */
export function listScopes(storageRoot) {
  const scopes = [SCOPE_GLOBAL];
  let entries;
  try {
    entries = readdirSync(join(storageRoot, "projects"), { withFileTypes: true });
  } catch {
    return scopes; // 还没建过项目记忆 = 只有 global（正常态）
  }
  const names = entries.filter((ent) => ent.isDirectory()).map((ent) => ent.name).sort();
  for (const name of names) {
    if (PROJECT_SCOPE_RE.test(`projects/${name}`)) scopes.push(`projects/${name}`);
  }
  return scopes;
}

// ---- 候选池 ----

/** 目录/文件不存在（首次使用、分类还没建、扫描到读取之间被删）= 正常态；其余读失败一律上抛。 */
function isMissingDirError(error) {
  return error?.code === "ENOENT";
}

/**
 * 列出目录下条目文件名（相对该目录、'/' 分隔；排除 MEMORY.md）。
 * 读失败策略：目录不存在 → 空（正常）；其余（EACCES/EIO/句柄占用…）→ **上抛**，
 * 让 compileScope 走 status=error 并保留上一版产物。绝不把「读不到」当成「没有」——
 * 那会用一份空产物覆盖掉上一版好产物，等于静默清空该分类的记忆。
 */
function listEntryNames(dir, { recursive = false } = {}) {
  const out = [];
  const walk = (current, prefix) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (isMissingDirError(error)) return;
      throw error;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (recursive) walk(join(current, ent.name), prefix.length > 0 ? `${prefix}/${ent.name}` : ent.name);
        continue;
      }
      if (!ent.isFile()) continue;
      const lower = ent.name.toLowerCase();
      if (!lower.endsWith(".md")) continue;
      if (lower === INDEX_FILENAME.toLowerCase()) continue; // 索引不是条目（索引重建由存储层负责）
      out.push(prefix.length > 0 ? `${prefix}/${ent.name}` : ent.name);
    }
  };
  walk(dir, "");
  out.sort();
  return out;
}

/**
 * 读一条条目文件（stat+read+frontmatter）。
 * 只有「扫到之后又消失」（ENOENT，正常竞态）按跳过处理；其余读失败 **一律上抛** ——
 * 包括 EISDIR（同名目录占位）与 EACCES/EIO：那是「这条记忆读不出来」，不是「这条不存在」。
 * 上抛后整个编译走 status=error 并保留上一版产物，用户看到的是可见降级，而不是记忆凭空少一条。
 */
function readEntryFile(absPath) {
  let raw;
  let st;
  try {
    st = statSync(absPath);
    raw = readFileSync(absPath, "utf8");
  } catch (error) {
    if (isMissingDirError(error)) return null;
    throw error;
  }
  return { front: parseFrontmatterHead(raw), mtimeMs: st.mtimeMs, size: st.size };
}

/** 条目标题：title → name → 文件名去扩展名（项目记忆通常只有 name）。 */
function entryTitle(front, file) {
  const fallback = file.split("/").pop().replace(/\.md$/i, "");
  const raw = front.title ?? front.name ?? fallback;
  const text = String(raw ?? "").replace(/[\r\n]+/g, " ").trim();
  return text.length > 0 ? text : fallback;
}

/** 项目条目类型映射：reference → null（不进候选池）；未知/缺省按 project（与 extract.js 缺省一致）。 */
function projectMapping(front) {
  const type = String(front.type ?? "").trim().toLowerCase();
  if (type === "reference") return null;
  return PROJECT_TYPE_MAP[type] ?? PROJECT_TYPE_MAP.project;
}

/**
 * 采集候选池（已按 §3.4 排序）。
 * 返回项：{ rootKey, file, absPath, mtimeMs, size, pinned, target, weight, title, description }
 * rootKey 口径唯一 = 召回 id 形态：global:<category> / project。
 */
function collectPool(storageRoot, scope) {
  const candidates = [];
  for (const source of GLOBAL_SOURCES) {
    const dir = join(storageRoot, "global", source.category);
    for (const file of listEntryNames(dir)) {
      const absPath = join(dir, ...file.split("/"));
      const read = readEntryFile(absPath);
      if (read === null) continue;
      candidates.push({
        rootKey: `global:${source.category}`,
        file,
        absPath,
        mtimeMs: read.mtimeMs,
        size: read.size,
        pinned: read.front.pinned === true,
        target: source.target,
        weight: source.weight,
        title: entryTitle(read.front, file),
        description: String(read.front.description ?? ""),
      });
    }
  }
  if (scope !== SCOPE_GLOBAL) {
    const memoryDir = join(storageRoot, ...scope.split("/"), "memory");
    for (const file of listEntryNames(memoryDir, { recursive: true })) {
      const absPath = join(memoryDir, ...file.split("/"));
      const read = readEntryFile(absPath);
      if (read === null) continue;
      const mapping = projectMapping(read.front);
      if (mapping === null) continue; // reference 不进正文（也不会被 pinned 拉进来）
      candidates.push({
        rootKey: "project",
        file,
        absPath,
        mtimeMs: read.mtimeMs,
        size: read.size,
        pinned: read.front.pinned === true,
        target: mapping.target,
        weight: mapping.weight,
        title: entryTitle(read.front, file),
        description: String(read.front.description ?? ""),
      });
    }
  }
  candidates.sort(compareCandidates);
  return candidates;
}

/** §3.4-4 tie-break：权重 desc → mtimeMs desc → 文件名升序 → rootKey 升序。 */
function compareCandidates(a, b) {
  if (a.weight !== b.weight) return b.weight - a.weight;
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.rootKey !== b.rootKey) return a.rootKey < b.rootKey ? -1 : 1;
  return 0;
}

/**
 * 候选池指纹：候选池全集（路径+mtimeMs+size）+ 配额 + algo 的 sha1（§四 口径）。
 * 只含候选池（reference/long-term/recent-activity 不在池内，改它们不触发重编）。
 * mtime+size 有同尺寸改写漏检面（§四 已声明，属懒编译可接受延迟）。
 * @param {{algo?:number, quotas?:{userBytes:number,memoryBytes:number}}} [options]
 *   algo/quotas 仅供测试与算法升级注入；生产调用不传。
 */
export function computeSourceHash({ storageRoot, scope, algo = RUNTIME_ALGO, quotas = RUNTIME_QUOTAS } = {}) {
  assertScope(scope);
  const pool = collectPool(storageRoot, scope);
  return hashPool(algo, normalizeQuotas(quotas), pool);
}

function normalizeQuotas(quotas) {
  const userBytes = Number.isFinite(quotas?.userBytes) ? quotas.userBytes : RUNTIME_QUOTAS.userBytes;
  const memoryBytes = Number.isFinite(quotas?.memoryBytes) ? quotas.memoryBytes : RUNTIME_QUOTAS.memoryBytes;
  return { userBytes, memoryBytes };
}

function hashPool(algo, quotas, candidates) {
  // rows 按 key 排序：与枚举顺序解耦，保证同输入同摘要。
  const rows = candidates.map((c) => `${c.rootKey}/${c.file}\t${c.mtimeMs}\t${c.size}`).sort();
  const payload = [
    "dsh-keepsake-runtime-source-v1",
    `algo=${algo}`,
    `userBytes=${quotas.userBytes}`,
    `memoryBytes=${quotas.memoryBytes}`,
    ...rows,
  ].join("\n");
  return createHash("sha1").update(payload, "utf8").digest("hex");
}

// ---- 渲染 ----

/** §3.1 文件头（计入配额；手改会被下次编译覆盖的显式声明）。 */
function renderHeader(scope, compiledAt) {
  return `<!-- AUTO-GENERATED by dsh-keepsake · scope=${scope} · compiledAt=${compiledAt} · 手工修改会在下次编译时被覆盖；编辑请回到条目文件 -->`;
}

/**
 * 段首两行记忆根绝对路径声明（沿用现有索引段 "Global memory root: …" 行式）。
 * global scope 无「当前项目」，第二行给 projects/ 根（项目记忆根的总入口）。
 */
function renderRootLines(storageRoot, scope) {
  const globalMemoryRoot = join(storageRoot, "global");
  const projectMemoryRoot = scope === SCOPE_GLOBAL
    ? join(storageRoot, "projects")
    : join(storageRoot, ...scope.split("/"), "memory");
  return [`Global memory root: ${globalMemoryRoot}`, `Project memory root: ${projectMemoryRoot}`];
}

/** 钩子截断：只截钩子本身（150 字符、码点安全），绝不碰标题/路径。 */
function clampHook(text, maxChars = 150) {
  const collapsed = String(text ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(collapsed);
  if (chars.length <= maxChars) return collapsed;
  return chars.slice(0, maxChars - 1).join("") + "…";
}

/** 条目行：`- 【关键|普通】[Title](relPath) — hook`（§3.2；钩子为空时省掉分隔符与空钩子）。 */
function renderEntryLine(candidate, productDir) {
  const relPath = relative(productDir, candidate.absPath).replace(/\\/g, "/");
  const fallback = candidate.file.split("/").pop().replace(/\.md$/i, "");
  // 标题只剥 Markdown 链接分隔符（防手改 frontmatter 破坏产物行结构），长度不截断。
  const title = String(candidate.title ?? "").replace(/[[\]]/g, "").replace(/\s+/g, " ").trim() || fallback;
  const hook = clampHook(candidate.description);
  const pin = candidate.pinned ? "关键" : "普通";
  return hook.length > 0 ? `- 【${pin}】[${title}](${relPath}) — ${hook}` : `- 【${pin}】[${title}](${relPath})`;
}

/**
 * 渲染一份产物（USER.md 或 MEMORY.md）并按配额装填。
 * entries 直接产出 §四 runtime.json 的条目形态 `{rootKey,file,pinned,included,bytes}`
 * （compiled 对象因此无需二次转换，调用方拿到的就是契约字段）。
 * @returns {{ text:string, bytes:number, entries:Array, evicted:Array, overQuota:boolean, reason:string|null }}
 */
function buildArtifact({ fileName, quotaBytes, candidates, header, rootLines, productDir }) {
  const base = `${header}\n${rootLines.join("\n")}\n\n`;
  const pinned = candidates.filter((c) => c.pinned);
  const rest = candidates.filter((c) => !c.pinned);
  const entries = [];
  const evicted = [];
  const includedLines = [];
  const includedRest = []; // rest 里已入选的（尾部先退，用于给淘汰留痕行腾地方）
  let used = Buffer.byteLength(base, "utf8");

  const take = (candidate, bytes, included, line) => {
    const entry = { rootKey: candidate.rootKey, file: candidate.file, pinned: candidate.pinned, included, bytes };
    entries.push(entry);
    if (included) includedLines.push(line);
    return entry;
  };

  // 1) pinned 全量优先入选，不参与淘汰、不截断。
  for (const candidate of pinned) {
    const line = renderEntryLine(candidate, productDir);
    const bytes = Buffer.byteLength(`${line}\n`, "utf8");
    used += bytes;
    take(candidate, bytes, true, line);
  }
  const pinnedOver = used > quotaBytes;

  // 2) 其余按排序顺序装填，装不下即停（不背包跳过继续）。
  let stopped = pinnedOver;
  for (const candidate of rest) {
    const line = renderEntryLine(candidate, productDir);
    const bytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (!stopped && used + bytes <= quotaBytes) {
      used += bytes;
      const entry = take(candidate, bytes, true, line);
      includedRest.push({ candidate, bytes, entry });
    } else {
      stopped = true;
      take(candidate, bytes, false, line);
      evicted.push({ rootKey: candidate.rootKey, file: candidate.file, bytes });
    }
  }

  // 3) 淘汰留痕行的字节也要占配额（§七：产物内每一行都算），否则会产出「超出配额却 status=ok」的产物。
  //    优先级：**记忆内容 > 提示行的详细程度**。详细行放不下就先换短行；短行仍放不下才退条目
  //    （退条目是最后手段——为一行说明挤掉一条真记忆，代价远大于提示变简）。
  //    行长度随淘汰条数变化（位数），所以每轮重算，循环必收敛。
  const evictedNoteOf = (count) => (count === 0
    ? ""
    : `[runtime evicted: ${count} entries exceed ${fileName} quota and are not included here; see the keepsake panel (运行时记忆 → 淘汰候选)]\n`);
  const shortNoteOf = (count) => (count === 0 ? "" : `[runtime evicted: ${count} over quota; see keepsake panel]\n`);
  let evictedNote = "";
  if (evicted.length > 0) {
    const fits = (note) => used + Buffer.byteLength(note, "utf8") <= quotaBytes;
    let note = evictedNoteOf(evicted.length);
    if (!fits(note)) note = shortNoteOf(evicted.length);
    while (!fits(note) && includedRest.length > 0) {
      const last = includedRest.pop();
      used -= last.bytes;
      last.entry.included = false;
      includedLines.pop();
      // unshift 保持与装填顺序一致（被退的都是紧挨着淘汰边界的那几条）
      evicted.unshift({ rootKey: last.candidate.rootKey, file: last.candidate.file, bytes: last.bytes });
      note = evictedNoteOf(evicted.length);
      if (!fits(note)) note = shortNoteOf(evicted.length);
    }
    evictedNote = fits(note) ? note : "";
  }

  const renderedOver = used > quotaBytes;
  const overQuota = pinnedOver || renderedOver;
  const reason = pinnedOver
    ? `pinned entries exceed ${fileName} quota`
    : renderedOver
      ? `rendered bytes exceed ${fileName} quota`
      : null;
  let text = base + includedLines.map((line) => `${line}\n`).join("");
  if (overQuota) text += `[runtime over quota: ${reason}]\n`; // §七：告警行计入配额
  // 装不下即停（正常淘汰）也要留可见痕迹：这批条目既不在产物、其分类又已从 globalIndex 去重，
  // 不写这行模型与用户都看不到「有记忆没进来」。与 overQuota 分开——淘汰是设计内行为，不算超配额。
  text += evictedNote;
  return { text, bytes: Buffer.byteLength(text, "utf8"), entries, evicted, overQuota, reason };
}

/**
 * 纯编译（不落盘）：读条目 → 选条 → 渲染 → 返回 compiled 对象。
 * @param {number} [now] 仅供测试/确定性复现（compiledAt 的来源）；生产不传。
 * @returns {{
 *   version:number, algo:number, scope:string, compiledAt:string, sourceHash:string,
 *   status:"ok"|"overQuota",
 *   user:{quotaBytes:number,bytes:number,text:string,entries:Array},
 *   memory:{quotaBytes:number,bytes:number,text:string,entries:Array},
 *   evictCandidates:Array
 * }}
 */
export function compileScope({ storageRoot, scope, now } = {}) {
  assertScope(scope);
  const compiledAtMs = now === undefined ? Date.now() : now;
  const compiledAt = new Date(compiledAtMs).toISOString();
  const candidates = collectPool(storageRoot, scope);
  const sourceHash = hashPool(RUNTIME_ALGO, RUNTIME_QUOTAS, candidates);
  const productDir = scopeDir(storageRoot, scope);
  const header = renderHeader(scope, compiledAt);
  const rootLines = renderRootLines(storageRoot, scope);

  const user = buildArtifact({
    fileName: USER_FILE,
    quotaBytes: RUNTIME_QUOTAS.userBytes,
    candidates: candidates.filter((c) => c.target === "user"),
    header,
    rootLines,
    productDir,
  });
  const memory = buildArtifact({
    fileName: MEMORY_FILE,
    quotaBytes: RUNTIME_QUOTAS.memoryBytes,
    candidates: candidates.filter((c) => c.target === "memory"),
    header,
    rootLines,
    productDir,
  });

  const evictCandidates = [...user.evicted, ...memory.evicted].map(({ rootKey, file, bytes }) => ({
    rootKey,
    file,
    bytes,
    reason: "quota",
    firstSeenAt: compiledAt,
  }));

  return {
    version: RUNTIME_VERSION,
    algo: RUNTIME_ALGO,
    scope,
    compiledAt,
    sourceHash,
    status: user.overQuota || memory.overQuota ? "overQuota" : "ok",
    user: { quotaBytes: RUNTIME_QUOTAS.userBytes, bytes: user.bytes, text: user.text, entries: user.entries },
    memory: { quotaBytes: RUNTIME_QUOTAS.memoryBytes, bytes: memory.bytes, text: memory.text, entries: memory.entries },
    evictCandidates,
  };
}

// ---- 落盘 ----

/** 原子写一组文件（tmp+rename；失败清掉所有未落定的 tmp，不掩盖原始错误）。 */
function writeFilesAtomic(dir, files) {
  mkdirSync(dir, { recursive: true });
  const pending = [];
  try {
    for (const [name, content] of files) {
      const target = join(dir, name);
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${pending.length}`;
      // 先登记再写：writeFileSync 可能写到一半才抛（磁盘满），半截 tmp 也要被清掉。
      pending.push(tmp);
      writeFileSync(tmp, content, "utf8");
      renameSync(tmp, target);
      pending.pop(); // 已落定，无需清理
    }
  } catch (error) {
    for (const tmp of pending) {
      try {
        rmSync(tmp, { force: true });
      } catch { /* 清理失败不掩盖原始错误 */ }
    }
    throw error;
  }
}

/** compiled → §四 runtime.json 结构（entries 已是契约字段，原样透传）。 */
function manifestOf(compiled) {
  const shapeFile = (file, quotaBytes) => ({
    quotaBytes,
    bytes: Buffer.byteLength(file.text, "utf8"),
    entries: file.entries.map(({ rootKey, file: name, pinned, included, bytes }) => ({ rootKey, file: name, pinned, included, bytes })),
  });
  return {
    version: RUNTIME_VERSION,
    algo: compiled.algo,
    scope: compiled.scope,
    compiledAt: compiled.compiledAt,
    sourceHash: compiled.sourceHash,
    status: compiled.status,
    user: shapeFile(compiled.user, compiled.user.quotaBytes),
    memory: shapeFile(compiled.memory, compiled.memory.quotaBytes),
    evictCandidates: compiled.evictCandidates,
  };
}

/**
 * 原子写 USER.md / MEMORY.md / runtime.json。
 * 三份文件各自 tmp+rename（单个文件不会半截）；跨文件非事务——失败时已落定的文件保留旧/新版本，
 * 未落定的一律不留 tmp，调用方按失败处理（ensureCompiled 会写 status=error 并保留上一版文本）。
 * @returns runtime.json 清单对象
 */
export function writeRuntimeArtifacts(storageRoot, scope, compiled) {
  assertScope(scope);
  if (compiled === null || typeof compiled !== "object") {
    throw new TypeError("dsh-keepsake: writeRuntimeArtifacts 需要 compileScope 返回的 compiled 对象");
  }
  if (compiled.scope !== scope) {
    throw new TypeError(`dsh-keepsake: compiled.scope（${String(compiled.scope)}）与参数 scope（${scope}）不一致`);
  }
  if (typeof compiled.user?.text !== "string" || typeof compiled.memory?.text !== "string") {
    throw new TypeError("dsh-keepsake: compiled 缺少 user.text / memory.text");
  }
  const manifest = manifestOf(compiled);
  writeFilesAtomic(scopeDir(storageRoot, scope), [
    [USER_FILE, compiled.user.text],
    [MEMORY_FILE, compiled.memory.text],
    [MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`],
  ]);
  return manifest;
}

/** 只写 runtime.json（status=error 用；绝不碰上一版产物文本）。 */
function writeManifestOnly(storageRoot, scope, manifest) {
  writeFilesAtomic(scopeDir(storageRoot, scope), [[MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`]]);
}

/**
 * 读 runtime.json；不存在 / JSON 损坏 / 结构不可用（非对象、无 sourceHash/scope）返回 null。
 * 结构校验只到「能安全参与缓存比对」为止，字段级宽容交给调用方。
 */
export function readRuntimeManifest(storageRoot, scope) {
  assertScope(scope);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(scopeDir(storageRoot, scope), MANIFEST_FILE), "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (typeof parsed.sourceHash !== "string" || typeof parsed.scope !== "string") return null;
  if (parsed.scope !== scope) return null; // 错放的清单（scope 不符）= 不可用，按损坏处理
  return parsed;
}

// ---- 懒编译 ----

/** 产物文件（USER.md + MEMORY.md）是否都在盘上；缺任一则缓存不可用。 */
function artifactsExist(dir) {
  for (const name of [USER_FILE, MEMORY_FILE]) {
    try {
      if (!statSync(join(dir, name)).isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * error 清单：status=error + 本次算出的 sourceHash；user/memory 统计若上一版清单可用则原样保留
 * ——产物文本确实还是上一版（§四「保留上一版产物文本」），清单就该与盘上一致，
 * 面板/注入侧看到的是「降级但可解释」的用量，而不是凭空归零。
 */
function errorManifest(scope, sourceHash, compiledAt, previous) {
  const emptyUser = { quotaBytes: RUNTIME_QUOTAS.userBytes, bytes: 0, entries: [] };
  const emptyMemory = { quotaBytes: RUNTIME_QUOTAS.memoryBytes, bytes: 0, entries: [] };
  const keep = (prev, fallback) => (prev !== null && typeof prev === "object" && Array.isArray(prev.entries) ? prev : fallback);
  return {
    version: RUNTIME_VERSION,
    algo: RUNTIME_ALGO,
    scope,
    compiledAt,
    sourceHash,
    status: "error",
    user: keep(previous?.user, emptyUser),
    memory: keep(previous?.memory, emptyMemory),
    evictCandidates: Array.isArray(previous?.evictCandidates) ? previous.evictCandidates : [],
  };
}

/** journal 失败不阻断编译/注入；但必须可见（log.warn 留痕，不静默）。 */
function journalCompile(log, storageRoot, entry) {
  try {
    appendCompileJournal(storageRoot, entry);
  } catch (error) {
    log.warn(`runtime: compile-journal 追加失败（编译结果不受影响）: ${error?.message ?? error}`);
  }
}

/**
 * 懒编译：
 *   1) 算盘上候选池指纹；runtime.json.sourceHash 一致、status 非 error、且两份产物都在
 *      → 直接返回缓存清单（不重写任何文件）；
 *   2) 否则重编译 + 原子落盘 + 追加 compile-journal（journal=false 可关，如只读闸）；
 *   3) 编译抛错 → 写 status=error 清单（保留上一版产物文本）+ journal（selected=0）+ warn。
 *      error 态不参与缓存命中：下一次调用会重试编译（瞬时错误可自愈），期间注入侧按
 *      §十一 跳过 runtime 段并记 usage 告警。
 * @param {"inject"|"panel"|"manual"} [trigger] 仅用于 compile-journal 的 trigger 字段；
 *   注入链路默认 "inject"，面板强制重编传 "panel"，手动/脚本传 "manual"。
 */
export function ensureCompiled({ storageRoot, scope, journal = true, trigger = "inject", log = {} } = {}) {
  assertScope(scope);
  const warn = typeof log?.warn === "function" ? log.warn.bind(log) : () => {};
  const dir = scopeDir(storageRoot, scope);
  const cached = readRuntimeManifest(storageRoot, scope);
  // 指纹计算与编译同处 try：候选池读失败（EACCES 等）同样要落到 status=error，
  // 不能绕过下面这条「保留上一版产物」的路直接抛给调用方。
  let sourceHash = typeof cached?.sourceHash === "string" ? cached.sourceHash : "";
  try {
    sourceHash = computeSourceHash({ storageRoot, scope });
    // 命中条件四件齐：结构版本/algo 一致、指纹一致、非 error 态、两份产物都在盘上。
    // error 态不参与命中 → 下次调用自动重试（瞬时错误自愈），期间注入侧按 §十一 跳过。
    if (
      cached !== null
      && cached.version === RUNTIME_VERSION
      && cached.algo === RUNTIME_ALGO
      && cached.sourceHash === sourceHash
      && cached.status !== "error"
      && artifactsExist(dir)
    ) {
      return cached;
    }
    const compiled = compileScope({ storageRoot, scope });
    const manifest = writeRuntimeArtifacts(storageRoot, scope, compiled);
    if (journal) {
      journalCompile({ warn }, storageRoot, {
        at: manifest.compiledAt,
        scope,
        trigger,
        selected: manifest.user.entries.filter((e) => e.included).length + manifest.memory.entries.filter((e) => e.included).length,
        candidates: manifest.evictCandidates.length,
        overQuota: manifest.status === "overQuota",
        bytes: { user: manifest.user.bytes, memory: manifest.memory.bytes },
        sourceHash: manifest.sourceHash,
      });
    }
    return manifest;
  } catch (error) {
    warn(`runtime: 编译失败（scope=${scope}），保留上一版产物并记 status=error: ${error?.message ?? error}`);
    const manifest = errorManifest(scope, sourceHash, new Date().toISOString(), cached);
    try {
      writeManifestOnly(storageRoot, scope, manifest);
    } catch (writeError) {
      warn(`runtime: status=error 清单写入失败（scope=${scope}）: ${writeError?.message ?? writeError}`);
    }
    if (journal) {
      journalCompile({ warn }, storageRoot, {
        at: manifest.compiledAt,
        scope,
        trigger,
        selected: 0,
        candidates: 0,
        overQuota: false,
        bytes: { user: 0, memory: 0 },
        sourceHash,
      });
    }
    return manifest;
  }
}

/**
 * 失效缓存：scope 指定时删该 scope 产物目录（含 runtime.json）；scope=null 清全部 scope。
 * 实现选择「直接删产物目录」而非写失效标记：最简、无标记残留、下次 ensureCompiled 必重编。
 * **保留** runtime/compile-journal.jsonl（观测历史；它不在任何 scope 目录里）。
 * @returns 删除的 scope 目录数
 */
export function invalidateRuntimeCache(storageRoot, scope = null) {
  if (scope !== null && scope !== undefined) {
    assertScope(scope);
    const dir = scopeDir(storageRoot, scope);
    if (!existsSync(dir)) return 0;
    rmSync(dir, { recursive: true, force: true });
    return 1;
  }
  let removed = 0;
  const targets = [join(runtimeDir(storageRoot), SCOPE_GLOBAL)];
  let projectDirs = [];
  try {
    projectDirs = readdirSync(join(runtimeDir(storageRoot), "projects"), { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => ent.name);
  } catch { /* 还没有项目产物目录 */ }
  for (const name of projectDirs) targets.push(join(runtimeDir(storageRoot), "projects", name));
  for (const dir of targets) {
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

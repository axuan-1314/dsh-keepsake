// dsh-keepsake 提取执行（v1 简化决策：单次 ctx.llm 调用，不起子任务 loop）。
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
// v0.4.0「提取写入可逆 + 盲写阻断」写路径安全面，全部经 lib/safety.js：
//   手术式快照：批内含覆盖既有/删除 → 落盘前快照；快照失败 fail-closed 阻断该批
//       全部破坏性 op（纯新增 op 可继续），计 warn（project 与 global 两侧同纪律）；
//   回收站：delete 语义由 rmSync 改为移入 trash/<entryId>/（project 与 global 两侧统一）；
//   写后读校验：写盘后回读，frontmatter 四字段/name 归一口径/正文非空/长度合规，
//       失败 → 从快照回滚旧文，坏档在快照 failed/ 留标本，计 verifyFailed；
//   硬事实比对（hybrid 判据在 lib/hardfact.js）：纯丢失/近似替换记 hardfact-drop 并附
//       unified diff 片段（≤2KB）到 extraction-errors.log；hardfactPolicy=block 时按
//       校验失败回滚；
//   短 sha1 覆盖闸：覆盖既有文件必须带 manifest 给出的短 sha1——不带 → 盲写
//       降级为追加（保留旧正文，新内容以一行分隔线追加）+ 计 blindWriteDowngrades；
//       带但与当前文件不符 → 拒绝该 op + 计 expectedSha1Mismatches；纯新增不需要 sha1；
//   批前原文读失败（文件存在却读不出）：该文件的覆盖/删除按 fail-closed 跳过，不盲写；
//   提取批互斥锁：<storageRoot>/extract.lock，锁被占 → 该批破坏性 op 阻断 + 计
//       lockConflicts（纯新增 op 不受影响）。
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { INDEX_FILENAME, resolveSafeMemoryTarget, sanitizeMemoryName } from "./filename.js";
import { buildIndexLine, INDEX_LINE_MAX_CHARS, mergeIndexContent } from "./manifest.js";
import { renderTranscript, skipReason } from "./transcript.js";
import { CATEGORY_IDS, categoryDir, isCategoryId, reconcileCategoryIndexAfterDelete, reconcileCategoryIndexAfterRollback, writeEntryDirect } from "./global-store.js";
import {
  acquireExtractLock,
  appendDowngradedWrite,
  createSurgicalSnapshot,
  hardfactWritebackReport,
  pruneSurgicalSnapshots,
  pruneTrash,
  quarantineSpecimen,
  resolveSafetySettings,
  rootKeyOf,
  sha1Short,
  trashMemoryFile,
  verifyMemoryFileContent,
} from "./safety.js";
import { appendExtractionError } from "./errorlog.js";

export const NOTHING_TO_SAVE = "Nothing to save.";

const MEMORY_TYPES = new Set(["user", "feedback", "project", "reference"]);
const MAX_CONTENT_CHARS = 20000;

/** 合法 scope 集（缺省 project；global:* 与 global-store 分类一一对应）。 */
export const VALID_SCOPES = new Set(["project", ...CATEGORY_IDS.map((id) => `global:${id}`)]);

/**
 * 模型 indexLine 合法性校验：
 * 非空、≤150 字符、形如 `- [Title](file.md) — hook`、且链接目标（原文）
 * 必须逐字节等于归一化名 name（即落盘用的 safeRel，如 myfact.md）。
 * 不做 sanitize 后比较——否则 `(MyFact.md)` 与归一化名 myfact.md 会被误判一致并原样采纳，
 * 在大小写敏感文件系统上断链。非法行回退插件规范行，防 MEMORY.md 里不可解析行累积成 preamble 并重复追加。
 */
export function isValidModelIndexLine(line, name) {
  if (typeof line !== "string") return false;
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > INDEX_LINE_MAX_CHARS) return false;
  const matched = trimmed.match(/^- \[[^\]]+\]\(([^()\s]+\.md)\) — \S.*$/);
  if (matched === null) return false;
  return matched[1] === name; // 逐字节一致：链接目标原文 === 归一化名
}

/**
 * 解析提取模型输出（单条坏 op 跳单容错，不再一票否决整批——
 * 好 ops 照落、坏 ops 计数可见；仅整 payload 非 JSON / 缺 ops 数组才拒整批）。
 * @returns { kind: 'nothing' } | { kind: 'ops', ops: [...], skippedMalformed: n, skippedDetails: [{name, reason, length?}] }
 * @throws 仅整批不可解析时抛错（调用方按 error 处理，cursor 不推进）。
 */
export function parseExtractionOutput(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0) throw new Error("dsh-keepsake: 提取输出为空");
  if (/^nothing to save\.?$/i.test(trimmed)) return { kind: "nothing" };
  let payload = trimmed;
  const fenced = payload.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) payload = fenced[1];
  const start = payload.indexOf("{");
  const end = payload.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("dsh-keepsake: 提取输出中未找到 JSON 对象");
  const parsed = JSON.parse(payload.slice(start, end + 1));
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.ops)) {
    throw new Error("dsh-keepsake: 提取输出缺少 ops 数组");
  }
  const ops = [];
  let skippedMalformed = 0;
  const skippedDetails = []; // 跳单明细（name+原因+实际长度）：warn 里能指出具体是哪个 op
  for (const raw of parsed.ops) {
    if (raw === null || typeof raw !== "object") {
      skippedMalformed += 1;
      skippedDetails.push({ name: "", reason: "op 非对象" });
      continue;
    }
    if (raw.action === "delete") {
      if (typeof raw.name !== "string") {
        skippedMalformed += 1;
        skippedDetails.push({ name: "", reason: "delete 缺 name" });
        continue;
      }
      ops.push({ action: "delete", name: raw.name, scope: typeof raw.scope === "string" ? raw.scope : "project" });
      continue;
    }
    if (raw.action === "write") {
      if (typeof raw.name !== "string" || raw.name.length === 0) {
        skippedMalformed += 1;
        skippedDetails.push({ name: "", reason: "write 缺 name" });
        continue;
      }
      if (typeof raw.content !== "string") {
        skippedMalformed += 1;
        skippedDetails.push({ name: raw.name, reason: "write 缺 content" });
        continue;
      }
      if (raw.content.length > MAX_CONTENT_CHARS) {
        // 超长不静默丢：warn 里记具体 op（名称 + 实际长度），超限上限本身不改（留定案）。
        skippedMalformed += 1;
        skippedDetails.push({ name: raw.name, reason: "content 超上限", length: raw.content.length });
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
        // 模型从 manifest 行回填的短 sha1（8 hex）；不带 = 盲写（见 applyOps 覆盖闸）。
        sha1: typeof raw.sha1 === "string" && /^[0-9a-f]{8}$/.test(raw.sha1.trim()) ? raw.sha1.trim() : void 0,
        scope: typeof raw.scope === "string" ? raw.scope : "project",
      });
      continue;
    }
    skippedMalformed += 1;
    skippedDetails.push({ name: typeof raw.name === "string" ? raw.name : "", reason: `未知 action "${String(raw.action)}"` });
  }
  return { kind: "ops", ops, skippedMalformed, skippedDetails };
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
 * 安全面计数（v0.4.0）：进程内单例，/state.safety 的七个动态字段来源。
 * 磁盘面三项（surgicalBackups/lastSnapshotAt/trashPending）由 lib/safety.js 现算。
 */
const SAFETY_COUNTER_KEYS = ["verifyFailed", "hardfactDrops", "hardfactBlocks", "expectedSha1Mismatches", "blindWriteDowngrades", "lockConflicts", "snapshotFailures"];
const safetyCounters = Object.fromEntries(SAFETY_COUNTER_KEYS.map((k) => [k, 0]));

/** 累加一个安全面计数（未知键忽略，防拼写错误静默吞计数）。 */
export function bumpSafetyCounter(name, by = 1) {
  if (!Object.prototype.hasOwnProperty.call(safetyCounters, name)) return 0;
  const n = Number.isFinite(by) && by > 0 ? Math.floor(by) : 1;
  safetyCounters[name] += n;
  return safetyCounters[name];
}

/** /state.safety 动态字段快照（返回拷贝）。 */
export function safetyCounterSnapshot() {
  return { ...safetyCounters };
}

/** 测试专用：清零安全面计数。 */
export function __resetSafetyCountersForTest() {
  for (const k of SAFETY_COUNTER_KEYS) safetyCounters[k] = 0;
}

/**
 * 落一条硬事实告警到 extraction-errors.log（附 ≤2KB unified diff 片段）。
 * 纯计数型留痕，绝不炸主流程（写日志失败只落 console）。
 */
function logHardfactDrop(storageRoot, { name, rootKey, dropped, diff, originSessionId }, log = { warn: () => {} }) {
  const brief = dropped.map((d) => `${d.type}:${d.value}(${d.reason})`).join(",");
  if (typeof storageRoot !== "string" || storageRoot.length === 0) return;
  try {
    appendExtractionError(storageRoot, {
      at: Date.now(),
      reason: "hardfact-drop",
      message: `${rootKey ? rootKey + "/" : ""}${name} 丢失硬事实 ${brief.slice(0, 160)}`,
      detail: diff,
    });
  } catch (error) {
    log.warn?.("hardfact-drop 日志落盘失败", error);
  }
}

/**
 * 原子替换：临时文件 + rename（写一半进程死也不损目标；目标路径任何时刻不为空）。
 * @returns 是否成功（失败时清掉残留 tmp，留给调用方 warn+计数）
 */
function atomicReplaceFile(target, content) {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, target);
    return true;
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* 清不动留给 sweepTmpOrphans */ }
    return false;
  }
}

/**
 * 校验失败 / hardfact block 的回滚收口（目标路径任何时刻都不能为空）：
 *   1) 先把【坏的新档】复制一份留标本——不是移走（move 会让目标路径出现空窗，
 *      回写再失败，记忆文件就从磁盘上消失）；标本 copy 失败仅 warn（快照里的
 *      旧文副本仍可兜底恢复）；
 *   2) 有批前原文时，用「临时文件 + rename」原子替换把旧文换回目标路径；
 *      原子替换失败 → warn+计数（旧文仍有快照副本可恢复）；
 *   3) 纯新增（无旧文可换回）时，标本留好后把坏档移出记忆目录。
 * @returns {{ stashed: "snapshot"|"trash"|null, rollback: "restored"|"removed"|"left"|"failed" }}
 */
function rollbackBadWrite(storageRoot, { target, name, rootKey, preContent, snapshotDir, originSessionId = "", log = { warn: () => {} } } = {}) {
  let stashed = null;
  if (typeof snapshotDir === "string" && snapshotDir.length > 0) {
    // copy（非 move）：片刻后目标路径还要被旧文换回，不能先搬空
    try {
      const dest = rootKey ? join(snapshotDir, "failed", ...String(rootKey).split("/"), name) : join(snapshotDir, "failed", name);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(target, dest);
      stashed = "snapshot";
    } catch (error) {
      log.warn(`坏档标本复制失败（快照副本仍可兜底恢复）: ${name}`, error);
    }
  } else {
    // 无快照（纯新增）：标本落回收站（move 语义——本就没有旧文要写回目标路径）
    try {
      const spec = quarantineSpecimen(storageRoot, { rootKey, name, originSessionId });
      stashed = spec.at;
    } catch (error) {
      log.warn(`坏档标本隔离失败: ${name}`, error);
    }
  }
  if (typeof preContent === "string") {
    if (!atomicReplaceFile(target, preContent)) return { stashed, rollback: "failed" };
    return { stashed, rollback: "restored" };
  }
  if (stashed === "snapshot") {
    // 纯新增：标本已留副本，坏档不留记忆目录（未进索引的脏档）
    try { rmSync(target, { force: true }); } catch { /* 清不动留给 sweepTmpOrphans */ }
    return { stashed, rollback: "removed" };
  }
  if (stashed === null) {
    // 标本没留住、又没有旧文可换回：坏档暂留记忆目录（未进索引，可见但不丢数据）
    return { stashed, rollback: "left" };
  }
  return { stashed, rollback: "removed" }; // trash move 已把坏档带出记忆目录
}

/**
 * 把解析出的 ops 落盘。全部写操作经 resolveSafeMemoryTarget 三道闸（边界②③）。
 * 逐 op try/catch 隔离——单条 IO 失败（文件被锁/磁盘满）计 failed
 * 不中断整批，斩断"整轮 error→cursor 不推进→确定性重试循环"。
 * 同批 write+delete 同名按终态对账（write 后 delete = 文件删、索引不留悬挂行）。
 *
 * v0.4.0 安全面（传 storageRoot 才启用；不传 = 旧版裸写语义，供独立 applyOps 兜底）：
 *   快照 / 回收站 delete / 写后校验+硬事实 / 短 sha1 覆盖闸+盲写降级 /
 *   批前原文读失败 fail-closed / 提取批锁。
 * @returns { writes, deletes, skipped, failed, snapshotId, blockedDestructive,
 *   blockedDestructiveOps, snapshotFailures,
 *   verifyFailed, hardfactDrops, hardfactBlocks, expectedSha1Mismatches, blindWriteDowngrades, quarantined }
 */
export function applyOps(memoryRoot, ops, {
  originSessionId = "",
  log = { warn: () => {}, error: () => {} },
  storageRoot = null,
  settings = null,
  // lockHeld = 提取批锁被别的实例占着（本批未拿到锁）→ 破坏性 op（覆盖既有/删除既有）
  // 在此批内一律阻断；纯新增 op 照常落盘（不因锁竞争丢新记忆）。
  lockHeld = false,
} = {}) {
  let writes = 0;
  let deletes = 0;
  let skipped = 0;
  let failed = 0;
  let verifyFailed = 0;
  let hardfactDrops = 0;
  let hardfactBlocks = 0;
  let expectedSha1Mismatches = 0;
  let blindWriteDowngrades = 0;
  let quarantined = 0;
  // 破坏性 op 被阻计数（快照缺失 / 批前原文读失败）+ 快照建档失败计数
  // （透出到 applyScopedOps → lib/index.js 落盘摘要，不既有字段只增）
  let blockedDestructiveOps = 0;
  let snapshotFailures = 0;
  const touched = [];
  const deletedNames = [];
  const safety = storageRoot === null ? null : resolveSafetySettings(settings);
  const rootKey = storageRoot === null ? null : rootKeyOf(storageRoot, memoryRoot);

  // ---- 预解析：本批触及的每个目标，先取「批前是否存在 + 批前原文」----
  // 破坏性判据只看批前状态：批内新建再删的名字不算「覆盖既有/删除既有」，
  // 无需快照（无旧文可失），也无需 sha1 闸（纯新增）。
  const preState = new Map(); // target → { preExisted, preContent, readFailed }
  const stateOf = (target) => {
    let st = preState.get(target);
    if (st === void 0) {
      let preExisted = false;
      let preContent = null;
      let readFailed = false;
      try {
        if (existsSync(target)) {
          preExisted = true;
          preContent = readFileSync(target, "utf8");
        }
      } catch {
        // 文件存在却读不出原文（EISDIR/权限等）：按读失败记账。若按不存在处理，
        // 后续覆盖会拿空旧文盲写降级（正文被顶替）且快照缺条——由写路径 fail-closed 拦下。
        readFailed = true;
      }
      st = { preExisted, preContent, readFailed };
      preState.set(target, st);
    }
    return st;
  };

  // ---- 批前快照：覆盖既有 / 删除既有 → 留档；失败 fail-closed ----
  let snapshot = null;
  let snapshotId = null;
  let destructiveBlocked = false;
  // lockHeld（别的实例占着锁）时本批全部破坏性 op 都会被写路径阻断——它们一个都不会执行，
  // 为它们建快照纯属浪费保留配额，还会（surgicalKeep=1 时）把上一批真pre-image滚掉。
  // 故锁被占时根本不建快照、不 prune：只有「本批真会执行 ≥1 个破坏性 op」才建。
  if (safety !== null && !lockHeld) {
    const destructive = [];
    for (const op of ops) {
      if (op.action !== "write" && op.action !== "delete") continue;
      const safeRel = sanitizeMemoryName(op.name ?? "");
      if (safeRel === null) continue;
      const target = resolveSafeMemoryTarget(memoryRoot, safeRel);
      const st = stateOf(target);
      // 原文读不出的目标无从留档（快照必缺条）——不进破坏性集合，
      // 由写路径的读失败闸 fail-closed 拦下该 op。
      if (target === null || !st.preExisted || st.readFailed) continue;
      destructive.push({ name: safeRel, rootKey, action: op.action === "delete" ? "delete" : "overwrite", target, content: st.preContent });
    }
    if (destructive.length > 0) {
      try {
        snapshot = createSurgicalSnapshot(storageRoot, { originSessionId, ops: destructive });
        snapshotId = snapshot.id;
        pruneSurgicalSnapshots(storageRoot, safety.surgicalKeep); // 滚动保留 surgicalKeep
        pruneTrash(storageRoot, safety.trashKeepDays); // 写路径顺带 prune 回收站
      } catch (error) {
        // fail-closed：快照建不起来 = 可逆性没有保证 → 阻断该批全部破坏性 op，
        // 纯新增 op 照常落盘（不因安全面故障让整批记忆丢失）。
        destructiveBlocked = true;
        snapshotFailures += 1;
        bumpSafetyCounter("snapshotFailures");
        log.warn(`手术式快照失败，本批破坏性 op 全部阻断（纯新增继续）: ${String(error?.message ?? error).slice(0, 120)}`);
      }
    }
  }

  for (const op of ops) {
    try {
      if (op.action === "write") {
        // 归一化只算一次：落盘路径/索引链接目标/touched 名/模型行比对统一用归一化相对名，
        // 保证 MEMORY.md 链接目标与磁盘文件名逐字节一致（大小写敏感文件系统不致断链）。
        // 模型给的原始名可能混合大小写或缺 .md，sanitizeMemoryName 会强制小写 + 补 .md。
        const safeRel = sanitizeMemoryName(op.name);
        const target = safeRel === null ? null : resolveSafeMemoryTarget(memoryRoot, safeRel);
        if (target === null) {
          skipped += 1;
          log.warn(`记忆文件名未通过安全闸，已跳过: ${op.name}`);
          continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        let body = renderMemoryFile({
          name: safeRel.replace(/\.md$/i, "").replace(/\//g, "-"),
          description: op.description,
          type: op.type,
          originSessionId,
          content: op.content,
        });
        const pre = stateOf(target);
        // ---- project 侧写前重检（与 global 侧同纪律）----
        // 预扫判为纯新增（preExisted=false）的 op，若此刻目标已被同批靠前的同名 op
        // 建出（或真并发实例建出），不能当纯新增直通覆盖：那会静默顶掉盘上内容；更坏的是，
        // 若第二个 op 随后写后校验失败，rollbackBadWrite 会按「纯新增」把文件整个删掉——
        // 一份好写被无声丢失，而 MEMORY.md 仍列着它（悬挂行）。落盘前重检：已被建出即
        // fail-closed 跳过并计数（快照保护集与读失败目标各有其闸，不在此重检范围）。
        if (safety !== null && !pre.preExisted && existsSync(target)) {
          skipped += 1;
          blockedDestructiveOps += 1;
          log.warn(`覆盖写前发现目标已被并发建出（未受快照保护，fail-closed 跳过）: ${safeRel}`);
          continue;
        }
        if (safety !== null && pre.preExisted) {
          // ---- fail-closed 第一关：本批快照失败（destructiveBlocked）时，
          // 覆盖既有文件一律阻断——可逆性没有保证就不许破坏。该检查必须先于 sha1
          // 闸，顺序不可调换：否则带了 sha1 的覆盖会绕过阻断直接落盘。
          if (destructiveBlocked) {
            skipped += 1;
            blockedDestructiveOps += 1;
            log.warn(`快照缺失，覆盖既有文件被阻断: ${safeRel}`);
            continue;
          }
          // ---- fail-closed 第二关：批前原文读不出（文件存在但 EISDIR/权限等）——
          // 不按纯新增放行，也不盲写降级（拿空旧文追加会把正文顶替掉），直接跳过。
          if (pre.readFailed) {
            skipped += 1;
            blockedDestructiveOps += 1;
            log.warn(`批前原文读取失败，覆盖按 fail-closed 跳过: ${safeRel}`);
            continue;
          }
          // 提取批锁被别的实例占着：破坏性 op 同样阻断（纯新增不受影响）
          if (lockHeld) {
            skipped += 1;
            log.warn(`提取批锁被占，覆盖既有文件被阻断: ${safeRel}`);
            continue;
          }
          // ---- 短 sha1 覆盖闸：必须先证明「我知道现在盘上是什么」----
          const currentShort = sha1Short(pre.preContent ?? "");
          if (typeof op.sha1 !== "string" || op.sha1.length === 0) {
            // 盲写：不覆盖旧正文，降级为「保留旧文 + 分隔线 + 新文」追加
            body = appendDowngradedWrite(pre.preContent ?? "", body);
            blindWriteDowngrades += 1;
            bumpSafetyCounter("blindWriteDowngrades");
            log.warn(`盲写降级为追加（未带 manifest 短 sha1，旧正文保留）: ${safeRel}`);
          } else if (op.sha1 !== currentShort) {
            // 带错 sha1 = 基于过时 manifest 的覆盖 → 拒绝该 op（不猜、不改）
            expectedSha1Mismatches += 1;
            bumpSafetyCounter("expectedSha1Mismatches");
            skipped += 1;
            log.warn(`短 sha1 与当前文件不符，拒绝覆盖（请重取 manifest）: ${safeRel}（期望 ${op.sha1}，实际 ${currentShort}）`);
            continue;
          }
        }
        // 原子写（tmp+rename，写一半进程死不损旧档）
        const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
        writeFileSync(tmp, body, "utf8");
        renameSync(tmp, target);
        // ---- 写后读校验 ----
        if (safety !== null) {
          let readback = null;
          try {
            readback = readFileSync(target, "utf8");
          } catch { /* 读不到：按校验失败处理 */ }
          const verdict = readback === null
            ? { ok: false, reason: "写后回读失败" }
            : verifyMemoryFileContent(readback, { expectedName: safeRel.replace(/\.md$/i, "").replace(/\//g, "-"), maxBodyChars: MAX_CONTENT_CHARS });
          if (!verdict.ok) {
            verifyFailed += 1;
            bumpSafetyCounter("verifyFailed");
            // 回滚原子化：先复制一份坏档标本（不是移走），再以「临时文件 + rename」
            // 把批前原文原子换回目标路径——目标路径任何时刻都不能为空（回写若失败，
            // 旧文仍有快照副本兜底）。顺序与语义见 rollbackBadWrite。
            const rolled = rollbackBadWrite(storageRoot, { target, name: safeRel, rootKey, preContent: pre.preContent, snapshotDir: snapshot === null ? null : snapshot.dir, originSessionId, log });
            if (rolled.stashed !== null) quarantined += 1;
            if (rolled.rollback === "failed") failed += 1;
            log.warn(`写后校验失败已回滚（${verdict.reason}）: ${safeRel}`);
            continue; // 不进 touched：索引不记这个坏档
          }
          // ---- 硬事实比对（hybrid 判据：纯丢失/近似替换）----
          if (pre.preExisted && typeof pre.preContent === "string") {
            const report = hardfactWritebackReport(pre.preContent, readback ?? "");
            if (report.dropped.length > 0) {
              hardfactDrops += report.dropped.length;
              bumpSafetyCounter("hardfactDrops", report.dropped.length);
              logHardfactDrop(storageRoot, { name: safeRel, rootKey, dropped: report.dropped, diff: report.diff, originSessionId }, log);
              if (safety.hardfactPolicy === "block") {
                // block 策略：该 op 按校验失败回滚——与写后校验失败同一收口
                // （先复制标本，再原子替换回旧文，目标路径任何时刻不为空）。
                // 计数上 hardfactBlocks 与 verifyFailed 分离（性质不同的失败不混计）：
                // block 必然先计 hardfactDrops，此处只 bump hardfactBlocks，不动 verifyFailed。
                hardfactBlocks += 1;
                bumpSafetyCounter("hardfactBlocks");
                const rolled = rollbackBadWrite(storageRoot, { target, name: safeRel, rootKey, preContent: pre.preContent, snapshotDir: snapshot === null ? null : snapshot.dir, originSessionId, log });
                if (rolled.stashed !== null) quarantined += 1;
                if (rolled.rollback === "failed") failed += 1;
                log.warn(`hardfactPolicy=block：硬事实丢失已回滚: ${safeRel}`);
                continue;
              }
            }
          }
        }
        let indexLine = buildIndexLine(op.title, safeRel, op.description);
        if (typeof op.indexLine === "string" && op.indexLine.trim().length > 0) {
          if (isValidModelIndexLine(op.indexLine, safeRel)) {
            indexLine = op.indexLine.trim();
          } else {
            log.warn(`模型 indexLine 非法（格式/长度/文件名不匹配），已回退规范行: ${op.indexLine.trim().slice(0, 80)}`);
          }
        }
        touched.push({
          name: safeRel,
          title: op.title,
          description: op.description,
          line: indexLine,
        });
        writes += 1;
        continue;
      }
      if (op.action === "delete") {
        // 归一化相对名与 write 分支同口径：终态对账（deletedSet 与 touched 比对）两侧都用归一化名，
        // 否则原始名（Foo）与归一化名（foo.md）比不中，同批 write+delete 会在索引里残留悬挂行。
        const safeRel = sanitizeMemoryName(op.name);
        const target = safeRel === null ? null : resolveSafeMemoryTarget(memoryRoot, safeRel);
        if (target === null) {
          skipped += 1;
          log.warn(`待删记忆文件名未通过安全闸，已跳过: ${op.name}`);
          continue;
        }
        // 判据是「此刻有没有这个文件」而非「批前有没有」——同批先 write 后 delete 时，
        // 文件是本批新建的（preExisted=false），但此刻确实存在，必须真删（终态对账）。
        // preExisted 只用于快照/锁的破坏性判据（批前就有的才需要留档）。
        const pre = stateOf(target);
        if (existsSync(target)) {
          if (safety !== null) {
            if (pre.readFailed) {
              // 原文读不出：无从留档也无从判定，fail-closed 跳过（不盲删）
              skipped += 1;
              blockedDestructiveOps += 1;
              log.warn(`批前原文读取失败，删除按 fail-closed 跳过: ${safeRel}`);
              continue;
            }
            if (destructiveBlocked) {
              skipped += 1; // 快照失败：删除也被阻断（可逆性无保障）
              blockedDestructiveOps += 1;
              continue;
            }
            if (lockHeld) {
              skipped += 1; // 批锁被占：删除同样阻断（并发两批不互踩回收站）
              continue;
            }
            // delete = 移入回收站（不硬删）；失败按未删处理
            const entry = trashMemoryFile(storageRoot, { rootKey, name: safeRel, originSessionId, log, now: Date.now() });
            if (entry === null) {
              skipped += 1;
              log.warn(`回收站移入失败，按未删处理: ${safeRel}`);
              continue;
            }
          } else {
            rmSync(target, { force: true });
          }
          deletedNames.push(safeRel);
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
  return {
    writes,
    deletes,
    skipped,
    failed,
    snapshotId,
    blockedDestructive: destructiveBlocked,
    blockedDestructiveOps,
    snapshotFailures,
    verifyFailed,
    hardfactDrops,
    hardfactBlocks,
    expectedSha1Mismatches,
    blindWriteDowngrades,
    quarantined,
  };
}

/**
 * scope 路由落盘：按 op.scope 分组——
 *   project → applyOps(projectRoot)（原逻辑）；
 *   global:<category> → writeEntryDirect（覆盖写语义，recent-activity 由 global-store
 *     盖 host timestamp）+ 写后读校验；delete → trashMemoryFile + reconcileCategoryIndexAfterDelete
 *     （两者都在 global-store，删后索引对账，不留悬挂行）；
 *   allowGlobal=false（全局提取开关关）→ global:* ops 过滤并计数；
 *   allowProject=false（项目记忆开关关）→ project ops 过滤并计数（对称推定）；
 *   未知 scope → 显式 skip + warn（不炸整批）。
 *
 * v0.4.0 安全面（全局侧批前快照 + 统一走回收站 + 提取批互斥锁 fail-closed）：
 *   · 全局侧覆盖既有条目前留档：预扫各分类 write op 命中既有文件者集为破坏性集合，
 *     落盘前 createSurgicalSnapshot 一次；快照失败 → 覆盖既有全阻断（纯新增照常），
 *     成功 → pruneSurgicalSnapshots/pruneTrash 滚动保留（与 project 侧同纪律）；
 *   · 本批含破坏性 op（覆盖既有/删除既有）时先抢 <storageRoot>/extract.lock——
 *     锁被占 → 破坏性 op 全部阻断并计 lockConflicts，纯新增 op 照常落盘
 *     （并发两批不互相踩踏快照，也不因锁竞争丢记忆）；
 *   · global 侧 delete 与 project 侧同一语义：移入 trash/<entryId>/ 而非 rmSync。
 * @returns { writes, deletes, skipped, failed, filteredGlobal, filteredProject,
 *   unknownScope, byScope, snapshotId, locked, lockConflicts, verifyFailed,
 *   hardfactDrops, hardfactBlocks, expectedSha1Mismatches, blindWriteDowngrades,
 *   blockedDestructiveOps, snapshotFailures }
 */
export function applyScopedOps(
  { storageRoot, projectRoot },
  ops,
  { originSessionId = "", allowGlobal = true, allowProject = true, settings = null, log = { warn: () => {} } } = {},
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

  // ---- 提取批互斥锁：本批有破坏性 op 才需独占（纯新增不锁，不互相挡路）----
  const hasDestructive = (list, rootDir) => list.some((op) => {
    const rel = sanitizeMemoryName(op?.name ?? "");
    if (rel === null) return false;
    const target = resolveSafeMemoryTarget(rootDir, rel);
    return target !== null && existsSync(target);
  });
  const destructiveInGlobal = [...globalOpsByCategory].some(([categoryId, list]) => hasDestructive(list, categoryDir(storageRoot, categoryId)));
  const destructiveInProject = hasDestructive(projectOps, projectRoot);
  const needLock = destructiveInProject || destructiveInGlobal;
  let locked = false;
  let lockConflicts = 0;
  let releaseLock = () => {};
  if (needLock) {
    const held = acquireExtractLock(storageRoot);
    if (!held.acquired) {
      locked = true;
      lockConflicts = 1;
      bumpSafetyCounter("lockConflicts");
      log.warn("提取批锁被占：本批破坏性 op（覆盖既有/删除）全部阻断，纯新增 op 照常落盘");
    } else {
      releaseLock = held.release;
    }
  }

  // ---- 全局侧批前快照：覆盖既有条目前留档（与 project 侧同纪律）----
  // 预扫各分类 write op：目标文件已存在者（existsSync）收集为全局破坏性集合（有旧文可失）；
  // 纯新增（目标本不存在）与 delete（自身走回收站）不需要快照。
  // 快照失败 → 该批全部「覆盖既有」的 write 阻断（fail-closed），纯新增 write 与 delete 照常。
  let globalSnapshot = null;
  let globalDestructiveBlocked = false;
  let snapshotFailures = 0;
  let blockedDestructiveOps = 0;
  const globalSafety = resolveSafetySettings(settings);
  const globalPreState = new Map(); // `${categoryId}\u0000${safeRel}` → { preExisted, readFailed, rel, snapshotProtected }
  const globalDestructive = [];
  for (const [categoryId, catOps] of globalOpsByCategory) {
    const catRoot = categoryDir(storageRoot, categoryId);
    const catRootKey = rootKeyOf(storageRoot, catRoot);
    for (const op of catOps) {
      if (op.action !== "write") continue;
      const rel = sanitizeMemoryName(op.name ?? "");
      if (rel === null) continue;
      const target = resolveSafeMemoryTarget(catRoot, rel);
      if (target === null) continue;
      const key = `${categoryId}\u0000${rel}`;
      let preExisted = false;
      let preContent = null;
      let readFailed = false;
      if (existsSync(target)) {
        preExisted = true;
        try {
          preContent = readFileSync(target, "utf8");
        } catch {
          // 文件在盘上却读不出（EISDIR/权限等）：无从留档，也无从保真覆盖 → 记账
          readFailed = true;
        }
      }
      globalPreState.set(key, { preExisted, readFailed, rel, preContent });
      // 只有「预扫即有旧文且可读」的目标进破坏性集合（有旧文可失、需留档）；
      // 纯新增（preExisted=false）与读失败目标不进——写分支各有其闸兜底。
      if (preExisted && !readFailed) globalDestructive.push({ name: rel, rootKey: catRootKey, action: "overwrite", target, content: preContent });
    }
  }
  if (globalDestructive.length > 0 && !locked) {
    // locked（别的实例占着锁）→ 本批全部覆盖既有的 write 都会被写路径阻断，一个都不执行；
    // 为它们建快照纯属浪费保留配额，还会把上一批真 pre-image 滚掉（surgicalKeep=1 时）。
    // 只在「本批真会执行破坏性 op」时才建快照 + prune。
    try {
      globalSnapshot = createSurgicalSnapshot(storageRoot, { originSessionId, ops: globalDestructive });
      pruneSurgicalSnapshots(storageRoot, globalSafety.surgicalKeep, log); // 全局侧写后滚动保留
      pruneTrash(storageRoot, globalSafety.trashKeepDays, Date.now(), log); // 顺带 prune 回收站：global-only 场景回收站不再无限增长
    } catch (error) {
      // fail-closed：全局快照建不起来 = 可逆性无保证 → 阻断该批全部覆盖既有的 write，
      // 纯新增 write 与 delete 照常落盘（不因安全面故障让整批记忆丢失）。
      globalDestructiveBlocked = true;
      snapshotFailures += 1;
      bumpSafetyCounter("snapshotFailures");
      log.warn(`全局手术式快照失败，本批覆盖既有条目全部阻断（纯新增继续）: ${String(error?.message ?? error).slice(0, 120)}`);
    }
  }

  let writes = 0;
  let deletes = 0;
  let skipped = 0;
  let failed = 0;
  let verifyFailed = 0;
  let hardfactDrops = 0;
  let hardfactBlocks = 0;
  let expectedSha1Mismatches = 0;
  let blindWriteDowngrades = 0;
  let quarantined = 0; // 全局侧写后校验失败时留标本数（与 project 侧同口径）
  let snapshotId = globalSnapshot === null ? null : globalSnapshot.id;
  const byScope = {};

  try {
    if (projectOps.length > 0) {
      // lockHeld=locked：抢不到锁（别的实例占着）时把「本批无锁」传给 applyOps，
      // 由其在写路径阻断破坏性 op（语义必须为抢不到锁即阻断——语义反转，锁被占反而放行）。
      const result = applyOps(projectRoot, projectOps, { originSessionId, log, storageRoot, settings, lockHeld: locked });
      writes += result.writes;
      deletes += result.deletes;
      skipped += result.skipped;
      failed += result.failed;
      verifyFailed += result.verifyFailed;
      hardfactDrops += result.hardfactDrops;
      hardfactBlocks += result.hardfactBlocks;
      expectedSha1Mismatches += result.expectedSha1Mismatches;
      blindWriteDowngrades += result.blindWriteDowngrades;
      blockedDestructiveOps += result.blockedDestructiveOps ?? 0;
      snapshotFailures += result.snapshotFailures ?? 0;
      if (result.snapshotId !== null) snapshotId = result.snapshotId;
      byScope.project = {
        writes: result.writes,
        deletes: result.deletes,
        skipped: result.skipped,
        failed: result.failed,
        blockedDestructive: result.blockedDestructive,
        verifyFailed: result.verifyFailed,
        hardfactDrops: result.hardfactDrops,
        hardfactBlocks: result.hardfactBlocks,
        expectedSha1Mismatches: result.expectedSha1Mismatches,
        blindWriteDowngrades: result.blindWriteDowngrades,
      };
    }

    for (const [categoryId, catOps] of globalOpsByCategory) {
      let w = 0;
      let d = 0;
      let s = 0;
      let f = 0;
      const catRootKey = rootKeyOf(storageRoot, categoryDir(storageRoot, categoryId));
      for (const op of catOps) {
        try {
          if (op.action === "write") {
            // ---- 全局侧 fail-closed：覆盖既有条目的两关（顺序与 project 侧一致）----
            const rel = sanitizeMemoryName(op.name ?? "");
            const pre = rel === null ? void 0 : globalPreState.get(`${categoryId}\u0000${rel}`);
            if (pre !== void 0 && pre.preExisted) {
              if (globalDestructiveBlocked) {
                // 批前快照建不起来：覆盖既有一律阻断（可逆性无保证），纯新增继续
                s += 1;
                blockedDestructiveOps += 1;
                log.warn(`全局快照缺失，覆盖既有条目被阻断: ${rel}`);
                continue;
              }
              if (pre.readFailed) {
                // 批前原文读不出（EISDIR/权限等）：不盲写、不按纯新增放行，直接跳过
                s += 1;
                blockedDestructiveOps += 1;
                log.warn(`全局批前原文读取失败，覆盖按 fail-closed 跳过: ${rel}`);
                continue;
              }
            }
            if (locked && existsSync(resolveSafeMemoryTarget(categoryDir(storageRoot, categoryId), op.name) ?? "")) {
              s += 1; // 锁被占 → 全局侧覆盖既有同样阻断
              continue;
            }
            // ---- 写前检查（堵 TOCTOU 与同批同名双写）----
            // 预扫是急切读取：只在预扫那一刻判「目标不存在 = 纯新增」的 op 才走这里。
            // 预扫之后（同批前一个 op 刚写入、或真并发实例）才出现的同名文件，会让
            // 「纯新增」当纯新增直通覆盖、静默丢掉盘上内容——落盘前再验一次，已被建出
            // 即 fail-closed 跳过并计数。快照保护集（已有留档）与读失败目标各有其闸，
            // 不在此检查范围（pre 只对纯新增为真，与 readFailed/locked 语义不打架）。
            if (pre !== void 0 && !pre.preExisted) {
              const recheckTarget = resolveSafeMemoryTarget(categoryDir(storageRoot, categoryId), op.name);
              if (recheckTarget !== null && existsSync(recheckTarget)) {
                s += 1;
                blockedDestructiveOps += 1;
                log.warn(`全局覆盖写前发现目标已被并发建出（未受快照保护，fail-closed 跳过）: ${rel ?? op.name}`);
                continue;
              }
            }
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
              // ---- 全局侧写后读校验（与 project 侧同纪律）----
              // 此前全局写路径没有写后回读：空/损坏 body 会被静默写穿（verifyFailed 恒 0）。
              // 回读并按写路径同口径校验（期望名 = 落盘名去 .md 与斜杠），失败则计 verifyFailed
              // 并回滚到批前原文（覆盖既有）/移除脏档（纯新增，与 project 侧一致），该 op 不计 writes。
              const writtenTarget = resolveSafeMemoryTarget(categoryDir(storageRoot, categoryId), written.name);
              let readback = null;
              try {
                readback = writtenTarget === null ? null : readFileSync(writtenTarget, "utf8");
              } catch { /* 读不到：按校验失败处理 */ }
              const verdict = readback === null
                ? { ok: false, reason: "写后回读失败" }
                : verifyMemoryFileContent(readback, { expectedName: written.name.replace(/\.md$/i, "").replace(/\//g, "-"), maxBodyChars: MAX_CONTENT_CHARS });
              if (!verdict.ok) {
                verifyFailed += 1;
                bumpSafetyCounter("verifyFailed");
                const hadPre = typeof pre?.preContent === "string";
                const rolled = rollbackBadWrite(storageRoot, {
                  target: writtenTarget,
                  name: written.name,
                  rootKey: catRootKey,
                  preContent: hadPre ? pre.preContent : void 0,
                  snapshotDir: globalSnapshot === null ? null : globalSnapshot.dir,
                  originSessionId,
                  log,
                });
                if (rolled.stashed !== null) quarantined += 1;
                if (rolled.rollback === "failed") f += 1;
                // writeEntryDirect 已即时重建索引并把坏档新行写进去了；回滚后索引必须回到
                // 旧态——覆盖既有按批前旧文重建该行，纯新增（无旧文）则剔除该行，不留悬挂。
                try {
                  reconcileCategoryIndexAfterRollback(storageRoot, categoryId, written.name, hadPre ? pre.preContent : null);
                } catch (error) {
                  log.warn(`全局写后校验回滚后索引对账失败（下轮重建）: ${written.name}`, error);
                }
                log.warn(`全局写后校验失败已尝试回滚（${verdict.reason}）: ${written.name}`);
              } else {
                w += 1;
              }
            }
          } else if (op.action === "delete") {
            // 与 write 对称——被三道闸拒绝显式计 skipped+warn，不再无声消失
            if (locked) {
              s += 1; // 锁被占：global 侧删除同样阻断
              continue;
            }
            const target = resolveSafeMemoryTarget(categoryDir(storageRoot, categoryId), op.name);
            if (target === null) {
              s += 1;
              log.warn(`全局待删记忆文件名未通过安全闸，已跳过: ${op.name}`);
              continue;
            }
            // 批前原文读失败闸（与 project 侧同口径）：目标在盘上却读不出（EISDIR/权限等）
            // → 无从留档也无从判定，fail-closed 跳过（不盲删、不进回收站）。
            if (existsSync(target)) {
              let readable = true;
              try {
                readFileSync(target, "utf8");
              } catch {
                readable = false;
              }
              if (!readable) {
                s += 1;
                blockedDestructiveOps += 1;
                log.warn(`全局批前原文读取失败，删除按 fail-closed 跳过: ${op.name}`);
                continue;
              }
            }
            // project 与 global 两侧统一——delete = 移入回收站（不硬删）
            const entry = trashMemoryFile(storageRoot, { rootKey: catRootKey, name: op.name, originSessionId, log, now: Date.now() });
            if (entry === null) {
              // 回收站移不动（目标本就不存在或被闸拦）：按未删处理，不计删除数
              if (!existsSync(target)) continue;
              s += 1;
              log.warn(`全局回收站移入失败，按未删处理: ${op.name}`);
              continue;
            }
            // 文件已移出，必须对账分类索引：否则 MEMORY.md 残留悬挂行，被注入进此后每一轮提示词。
            // entry.name 是归一化后的落盘名（回收站写路径同口径），以其为准重建索引并剔除该行。
            try {
              reconcileCategoryIndexAfterDelete(storageRoot, categoryId, entry.name ?? op.name);
            } catch (error) {
              log.warn(`全局条目已移入回收站，但分类索引对账失败（悬挂行待下轮重建）: ${entry.name ?? op.name}`, error);
            }
            d += 1;
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
  } finally {
    releaseLock(); // 抢到锁才真释放；finally 保证异常路径也不留锁
  }

  return {
    writes,
    deletes,
    skipped,
    failed,
    filteredGlobal,
    filteredProject,
    unknownScope,
    byScope,
    snapshotId,
    locked,
    lockConflicts,
    verifyFailed,
    hardfactDrops,
    hardfactBlocks,
    expectedSha1Mismatches,
    blindWriteDowngrades,
    // 全局侧安全面计数（与 project 侧同口径合并后透出，供 lib/index.js 落盘摘要）
    blockedDestructiveOps,
    snapshotFailures,
    quarantined,
  };
}

/**
 * 组装一次提取调用的提示词（照规格骨架的单次调用版）。
 * globalManifest（四分类+长期记忆现状）与分类定义进 prompt；
 * 输出契约 ops 支持 scope 字段（缺省 project）。
 * 项目记忆目录键：以 memoryRoot 为准（调用方 lib/index.js 历史传 memoryDir，兼容接受）。
 */
export function buildExtractionPayload({ transcript, manifest, bodies, memoryRoot, memoryDir, globalManifest = "" }) {
  const projectMemoryDir = memoryRoot ?? memoryDir;
  const system = [
    "You are the project-memory extractor of the dsh-keepsake plugin for DeepSeek Harness.",
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
    `The project memory directory is: ${projectMemoryDir}`,
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
    '{"ops":[{"action":"write","name":"kebab-name.md","scope":"project","type":"user|feedback|project|reference","title":"Title","description":"one-line recall hook","indexLine":"- [Title](kebab-name.md) — one-line hook <=150 chars","sha1":"ab12cd34","content":"full markdown body WITHOUT frontmatter"},{"action":"delete","name":"obsolete.md","scope":"project"}]}',
    "- At most 20 ops. content must be the COMPLETE new body of the file (it replaces any old body).",
    '- scope is optional and defaults to "project"; global ops use the same kebab-case file naming.',
    "- Overwrite guard (project memories): each project manifest line carries the file's short hash inside its timestamp parens, as (ISO · sha1:xxxxxxxx).",
    "- When you UPDATE an existing PROJECT file, you MUST copy that exact sha1 value into the op as \"sha1\":\"xxxxxxxx\" — it proves you read the CURRENT body you are replacing.",
    "- Global manifest lines do NOT carry a hash, so overwriting a global file needs NO sha1 (a pre-write snapshot protects it). Brand-new files need no sha1 either.",
    "- An overwrite without a correct project sha1 is rejected: without one it degrades to appending instead of replacing, and a stale value is refused outright.",
  ]
    .filter((line) => line !== "")
    .join("\n");
  const user = `Conversation increment to analyze:\n\n${transcript || "(no message body captured)"}\n\nUpdate the persistent memory now. Reply per the output contract.`;
  return { system, user };
}

export { skipReason, renderTranscript };

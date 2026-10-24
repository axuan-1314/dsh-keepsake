// runtime-compile：L0 编译器（RUNTIME-FORMAT v2.1 §三/§四/§七/§八/§九）验收。
// 覆盖：编译确定性、配额与 overQuota、pinned 优先（含 reference 不入选）、
//       顺序装填装不下即停、相对路径层数、hook 截断、sourceHash 敏感面、
//       懒编译缓存、原子写失败面、两份观测日志轮转、失效与 scope 枚举。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  RUNTIME_ALGO,
  RUNTIME_QUOTAS,
  compileScope,
  computeSourceHash,
  ensureCompiled,
  invalidateRuntimeCache,
  listScopes,
  readRuntimeManifest,
  runtimeDir,
  scopeDir,
  writeRuntimeArtifacts,
} from "../lib/runtime.js";
import {
  COMPILE_JOURNAL_FILE_NAME,
  EVICT_AUDIT_FILE_NAME,
  appendCompileJournal,
  appendEvictAudit,
} from "../lib/runtime-log.js";

const PROJECT_SCOPE = "projects/myproj-0123456789abcdef";
const FIXED_NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-runtime-"));
}

/** 写一条全局条目（frontmatter 形态同 renderGlobalEntry；pinned 是顶层字段）。 */
function writeGlobalEntry(root, category, file, { title, description = "", pinned = false, body = "正文", type = "global" } = {}) {
  const dir = join(root, "global", category);
  mkdirSync(dir, { recursive: true });
  const name = file.replace(/\.md$/i, "");
  const lines = ["---", `name: "${name}"`];
  if (title !== undefined) lines.push(`title: "${title}"`);
  lines.push(`description: "${description}"`, "metadata:", `  type: ${type}`);
  // §5.2：pinned 紧随 metadata 块后（顶层布尔）
  if (pinned) lines.push("pinned: true");
  lines.push('node_type: "memory"', "---", "", body, "");
  const target = join(dir, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, lines.join("\n"), "utf8");
  return target;
}

/** 写一条项目条目（metadata.type 决定去向；file 可含嵌套目录）。 */
function writeProjectEntry(root, scope, file, { title, description = "", pinned = false, body = "正文", type = "project" } = {}) {
  const dir = join(root, ...scope.split("/"), "memory");
  const target = join(dir, ...file.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  const name = file.split("/").pop().replace(/\.md$/i, "");
  const lines = ["---", `name: "${name}"`];
  if (title !== undefined) lines.push(`title: "${title}"`);
  lines.push(`description: "${description}"`, "metadata:", `  type: ${type}`);
  if (pinned) lines.push("pinned: true");
  lines.push('node_type: "memory"', 'originSessionId: "s-test"', "---", "", body, "");
  writeFileSync(target, lines.join("\n"), "utf8");
  return target;
}

function setMtime(path, ms) {
  utimesSync(path, new Date(ms), new Date(ms));
}

/** 从产物行取 hook（无 hook 返回 null）。 */
function hookOf(line) {
  const matched = line.match(/^- 【(?:关键|普通)】\[[^\]]*\]\([^)]*\)(?: — (.*))?$/);
  return matched === null ? undefined : (matched[1] ?? null);
}

// ---- ① 编译确定性 ----

test("编译确定性：同输入两次编译（含落盘字节）完全一致", () => {
  const root = freshRoot();
  try {
    writeGlobalEntry(root, "user-profile", "identity.md", { title: "Identity", description: "用户身份" });
    writeGlobalEntry(root, "user-profile", "prefs.md", { title: "Prefs", description: "偏好" });
    writeGlobalEntry(root, "work-profile", "stack.md", { title: "Stack", description: "技术栈" });
    writeGlobalEntry(root, "current-focus", "goal.md", { title: "Goal", description: "当前目标" });
    writeProjectEntry(root, PROJECT_SCOPE, "decision.md", { title: "Decision", description: "项目决策", type: "project" });
    writeProjectEntry(root, PROJECT_SCOPE, "feedback.md", { title: "Feedback", description: "反馈", type: "feedback" });
    writeProjectEntry(root, PROJECT_SCOPE, "who.md", { title: "Who", description: "用户", type: "user" });
    writeProjectEntry(root, PROJECT_SCOPE, "ref.md", { title: "Ref", description: "外部指针", type: "reference" });

    const first = compileScope({ storageRoot: root, scope: PROJECT_SCOPE, now: FIXED_NOW });
    const second = compileScope({ storageRoot: root, scope: PROJECT_SCOPE, now: FIXED_NOW });
    assert.deepEqual(second, first, "同输入两次编译应逐字段相同");
    assert.equal(second.user.text, first.user.text);
    assert.equal(second.memory.text, first.memory.text);

    // 落盘字节：两次写入后读回与 compiled.text 逐字节相同
    const manifest = writeRuntimeArtifacts(root, PROJECT_SCOPE, first);
    const dir = scopeDir(root, PROJECT_SCOPE);
    assert.deepEqual(readFileSync(join(dir, "USER.md")), Buffer.from(first.user.text, "utf8"));
    assert.deepEqual(readFileSync(join(dir, "MEMORY.md")), Buffer.from(first.memory.text, "utf8"));
    writeRuntimeArtifacts(root, PROJECT_SCOPE, second);
    assert.deepEqual(readFileSync(join(dir, "USER.md")), Buffer.from(first.user.text, "utf8"));
    assert.deepEqual(readFileSync(join(dir, "MEMORY.md")), Buffer.from(first.memory.text, "utf8"));

    // runtime.json 结构（§四）
    assert.equal(manifest.version, 2);
    assert.equal(manifest.algo, RUNTIME_ALGO);
    assert.equal(manifest.scope, PROJECT_SCOPE);
    assert.match(manifest.compiledAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(manifest.sourceHash, /^[0-9a-f]{40}$/);
    assert.equal(manifest.status, "ok");
    assert.equal(manifest.user.quotaBytes, RUNTIME_QUOTAS.userBytes);
    assert.equal(manifest.memory.quotaBytes, RUNTIME_QUOTAS.memoryBytes);
    for (const entry of [...manifest.user.entries, ...manifest.memory.entries]) {
      assert.deepEqual(Object.keys(entry).sort(), ["bytes", "file", "included", "pinned", "rootKey"]);
    }
    // rootKey 口径：全局条目 global:<category>、项目条目 project
    assert.ok(manifest.user.entries.every((e) => e.rootKey === "global:user-profile" || e.rootKey === "project"));
    assert.ok(manifest.memory.entries.some((e) => e.rootKey === "project"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ② 配额与 overQuota ----

test("overQuota：pinned 合计超配额 → status=overQuota 且产物不截断（含告警行）", () => {
  const root = freshRoot();
  try {
    const titles = [];
    for (let i = 0; i < 30; i += 1) {
      const title = `Pinned-${String(i).padStart(2, "0")}`;
      titles.push(title);
      // title 300 字符 + hook 150 字符 ≈ 500 字节/行 → 30 条 ≈ 15KB > 10240
      writeGlobalEntry(root, "work-profile", `pin-${String(i).padStart(2, "0")}.md`, {
        title: `${title}-${"T".repeat(280)}`,
        description: "d".repeat(150),
        pinned: true,
      });
    }
    const compiled = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
    assert.equal(compiled.status, "overQuota");
    assert.ok(compiled.memory.bytes > RUNTIME_QUOTAS.memoryBytes, "产物字节数应超配额（不被截断）");
    assert.match(compiled.memory.text, /^\[runtime over quota: pinned entries exceed MEMORY\.md quota\]$/m);
    // 不截断：30 条 pinned 的标题全部在产物里
    for (const title of titles) assert.ok(compiled.memory.text.includes(`[${title}-`), `${title} 必须在产物中`);
    // entries 全部 included=true（pinned 不参与淘汰）
    const pinnedEntries = compiled.memory.entries.filter((e) => e.pinned);
    assert.equal(pinnedEntries.length, 30);
    assert.ok(pinnedEntries.every((e) => e.included));
    assert.equal(compiled.evictCandidates.length, 0, "pinned 超配额只告警，不登记淘汰候选");
    // 落盘后 runtime.json 的 bytes 与产物一致且超配额
    const manifest = writeRuntimeArtifacts(root, "global", compiled);
    assert.equal(manifest.status, "overQuota");
    assert.equal(manifest.memory.bytes, Buffer.byteLength(compiled.memory.text, "utf8"));
    assert.ok(manifest.memory.bytes > manifest.memory.quotaBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("overQuota：非 pinned 装填后仍超配额（告警行计入字节数）", () => {
  const root = freshRoot();
  try {
    // 单条恰好把配额吃满：再叠加告警行即越界（触发「渲染后仍超配额」分支）
    const compiled = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
    assert.equal(compiled.status, "ok"); // 空池 = ok（基线）
    writeGlobalEntry(root, "work-profile", "huge.md", { title: "H".repeat(20000), description: "hook" });
    const over = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
    // 单条装不下 → 进淘汰候选，产物本身不超配额
    assert.equal(over.status, "ok");
    assert.equal(over.memory.entries.filter((e) => e.included).length, 0);
    assert.equal(over.evictCandidates.length, 1);
    assert.equal(over.evictCandidates[0].file, "huge.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ③ pinned 优先入选 ----

test("pinned 优先：低权重 pinned 必入选；reference 的 pinned 永不入选", () => {
  const root = freshRoot();
  try {
    // 四条高权重普通条目把 MEMORY.md 配额吃掉大半
    for (let i = 0; i < 4; i += 1) {
      writeGlobalEntry(root, "work-profile", `normal-${i}.md`, {
        title: `Normal-${i}-${"N".repeat(2200)}`,
        description: "普通条目",
      });
    }
    // 一条最低权重（project=1）的 pinned 项目条目：若按权重排序它必被挤掉
    writeProjectEntry(root, PROJECT_SCOPE, "critical.md", {
      title: `Critical-${"C".repeat(1200)}`,
      description: "关键项目决策",
      pinned: true,
      type: "project",
    });
    // reference pinned：候选池外，pinned 也不入选
    writeProjectEntry(root, PROJECT_SCOPE, "ref-pinned.md", { title: "RefPinned", description: "外部指针", pinned: true, type: "reference" });
    // long-term / recent-activity 的 pinned：候选池外
    writeGlobalEntry(root, "long-term", "archived.md", { title: "Archived", description: "归档", pinned: true });
    writeGlobalEntry(root, "recent-activity", "recent.md", { title: "Recent", description: "流水", pinned: true });
    // 全局 pinned（USER.md 去向）
    writeGlobalEntry(root, "user-profile", "always.md", { title: "AlwaysUser", description: "用户画像", pinned: true });

    const compiled = compileScope({ storageRoot: root, scope: PROJECT_SCOPE, now: FIXED_NOW });
    const memory = compiled.memory;
    assert.ok(memory.text.includes("[Critical-"), "低权重 pinned 项目条目必须入选");
    assert.ok(compiled.user.text.includes("[AlwaysUser]"), "全局 pinned 条目必须进 USER.md");
    assert.ok(!memory.text.includes("RefPinned"), "reference 的 pinned 永不入选");
    assert.ok(!memory.text.includes("Archived"), "long-term 的 pinned 永不入选");
    assert.ok(!memory.text.includes("Recent"), "recent-activity 的 pinned 永不入选");
    assert.ok(!compiled.user.text.includes("RefPinned"));
    // pinned 条目的 runtime.json 记录
    const critical = memory.entries.find((e) => e.file === "critical.md");
    assert.equal(critical.pinned, true);
    assert.equal(critical.included, true);
    assert.equal(critical.rootKey, "project");
    // 至少一条普通条目被挤掉（证明 pinned 抢在权重排序之前）
    const evicted = compiled.evictCandidates.map((e) => e.file);
    assert.ok(evicted.length >= 1, "普通条目应有被淘汰者");
    assert.ok(!evicted.includes("critical.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ④ 顺序装填：装不下即停 + evictCandidates ----

test("顺序装填：装不下即停（后续小条目也不再装）+ 淘汰候选登记口径", () => {
  const root = freshRoot();
  try {
    // 同权重、同 mtime → 按文件名升序：a(2000) b(2000) c(7000) d(10)
    writeGlobalEntry(root, "work-profile", "a.md", { title: `A-${"a".repeat(2000)}`, description: "a" });
    writeGlobalEntry(root, "work-profile", "b.md", { title: `B-${"b".repeat(2000)}`, description: "b" });
    writeGlobalEntry(root, "work-profile", "c.md", { title: `C-${"c".repeat(7000)}`, description: "c" });
    writeGlobalEntry(root, "work-profile", "d.md", { title: `D-${"d".repeat(10)}`, description: "d" });
    for (const name of ["a.md", "b.md", "c.md", "d.md"]) {
      setMtime(join(root, "global", "work-profile", name), FIXED_NOW);
    }
    const compiled = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
    const text = compiled.memory.text;
    assert.ok(text.includes("[A-"), "a 应入选");
    assert.ok(text.includes("[B-"), "b 应入选");
    assert.ok(!text.includes("[C-"), "c 装不下");
    assert.ok(!text.includes("[D-"), "d 很小但排在 c 之后，装不下即停 → 也不装（不背包跳过）");
    const evicted = compiled.evictCandidates;
    assert.deepEqual(evicted.map((e) => e.file), ["c.md", "d.md"]);
    for (const entry of evicted) {
      assert.equal(entry.rootKey, "global:work-profile");
      assert.equal(entry.reason, "quota");
      assert.equal(entry.lastSeenAt, compiled.compiledAt);
      assert.ok(entry.bytes > 0);
    }
    // 淘汰候选每次编译全量重算（不是累积）
    const again = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
    assert.deepEqual(again.evictCandidates, evicted);

    // 删掉 c（大条目）后 d 自然入选（证明排序前缀 + 重算语义）
    rmSync(join(root, "global", "work-profile", "c.md"));
    const after = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
    assert.ok(after.memory.text.includes("[D-"));
    assert.deepEqual(after.evictCandidates, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ⑤ 相对路径层数 ----

test("相对路径：global 产物 ../../、project 产物 ../../../（全局与项目条目各按产物目录算）", () => {
  const root = freshRoot();
  try {
    writeGlobalEntry(root, "user-profile", "me.md", { title: "Me", description: "用户" });
    writeGlobalEntry(root, "work-profile", "stack.md", { title: "Stack", description: "技术栈" });
    writeProjectEntry(root, PROJECT_SCOPE, "decision.md", { title: "Decision", description: "决策", type: "project" });
    writeProjectEntry(root, PROJECT_SCOPE, "sub/nested.md", { title: "Nested", description: "嵌套条目", type: "project" });

    const globalCompiled = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
    assert.ok(globalCompiled.user.text.includes("](../../global/user-profile/me.md)"), "global 产物 → 全局条目两层");
    assert.ok(globalCompiled.memory.text.includes("](../../global/work-profile/stack.md)"));
    assert.ok(!globalCompiled.memory.text.includes("](../../projects/"), "global scope 无项目条目");
    // 段首两行记忆根绝对路径声明
    assert.ok(globalCompiled.memory.text.includes(`Global memory root: ${join(root, "global")}`));
    assert.ok(globalCompiled.memory.text.includes(`Project memory root: ${join(root, "projects")}`));

    const projectCompiled = compileScope({ storageRoot: root, scope: PROJECT_SCOPE, now: FIXED_NOW });
    assert.ok(projectCompiled.user.text.includes("](../../../global/user-profile/me.md)"), "project 产物 → 全局条目三层");
    assert.ok(projectCompiled.memory.text.includes("](../../../global/work-profile/stack.md)"));
    assert.ok(projectCompiled.memory.text.includes(`](../../../${PROJECT_SCOPE}/memory/decision.md)`), "project 产物 → 本项目条目三层");
    assert.ok(projectCompiled.memory.text.includes(`](../../../${PROJECT_SCOPE}/memory/sub/nested.md)`), "嵌套条目路径不丢层级");
    assert.ok(projectCompiled.memory.text.includes(`Global memory root: ${join(root, "global")}`));
    assert.ok(projectCompiled.memory.text.includes(`Project memory root: ${join(root, ...PROJECT_SCOPE.split("/"), "memory")}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ⑥ hook 截 150 且 Title/path 不截 ----

test("条目行：hook 截 150 字符，Title/path 永不截（不复用 clampIndexLine）", () => {
  const root = freshRoot();
  try {
    const longTitle = `Title-${"T".repeat(300)}`;
    writeGlobalEntry(root, "work-profile", "long.md", { title: longTitle, description: "d".repeat(300) });
    const compiled = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
    const line = compiled.memory.text.split("\n").find((l) => l.includes("[Title-"));
    assert.ok(line !== undefined, "条目行应存在");
    assert.ok(line.startsWith("- 【普通】"), "行首 pin 标记");
    assert.ok(line.includes(`[${longTitle}]`), "Title 完整（300 字符不截）");
    assert.ok(line.includes("](../../global/work-profile/long.md)"), "path 完整");
    const hook = hookOf(line);
    assert.equal(typeof hook, "string");
    assert.equal(Array.from(hook).length, 150, "hook 截到 150 字符");
    assert.ok(hook.endsWith("…"));
    assert.ok(line.length > 150, "整行远超 150（未用整行 clamp）");
    // pinned 行前缀
    writeGlobalEntry(root, "work-profile", "pinned.md", { title: "Pinned", description: "关键", pinned: true });
    const withPin = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
    assert.ok(withPin.memory.text.split("\n").some((l) => l.startsWith("- 【关键】[Pinned]")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ⑦ sourceHash 敏感面 ----

test("sourceHash：候选文件 size/mtime 变化与 algo 版本变化都会改变摘要", () => {
  const root = freshRoot();
  try {
    const target = writeGlobalEntry(root, "work-profile", "topic.md", { title: "Topic", description: "主题" });
    writeProjectEntry(root, PROJECT_SCOPE, "p.md", { title: "P", description: "项目" });
    writeProjectEntry(root, PROJECT_SCOPE, "ref.md", { title: "Ref", description: "指针", type: "reference" });
    setMtime(target, FIXED_NOW);
    const before = computeSourceHash({ storageRoot: root, scope: PROJECT_SCOPE });
    assert.equal(computeSourceHash({ storageRoot: root, scope: PROJECT_SCOPE }), before, "同输入摘要稳定");

    // 改内容尺寸（size 变）
    writeGlobalEntry(root, "work-profile", "topic.md", { title: "Topic", description: "主题变长了" });
    const afterSize = computeSourceHash({ storageRoot: root, scope: PROJECT_SCOPE });
    assert.notEqual(afterSize, before, "尺寸变化必须改变摘要");

    // 仅改 mtime（内容不变）
    setMtime(target, FIXED_NOW + 5000);
    const afterMtime = computeSourceHash({ storageRoot: root, scope: PROJECT_SCOPE });
    assert.notEqual(afterMtime, afterSize, "mtime 变化必须改变摘要");

    // algo 版本变化（选条算法改版 → 旧缓存失效）
    const afterAlgo = computeSourceHash({ storageRoot: root, scope: PROJECT_SCOPE, algo: RUNTIME_ALGO + 1 });
    assert.notEqual(afterAlgo, afterMtime, "algo 变化必须改变摘要");

    // 候选池外文件（reference）变化不影响摘要
    const ref = join(root, ...PROJECT_SCOPE.split("/"), "memory", "ref.md");
    writeProjectEntry(root, PROJECT_SCOPE, "ref.md", { title: "Ref", description: "指针内容改了", type: "reference" });
    setMtime(ref, FIXED_NOW + 90000);
    assert.equal(computeSourceHash({ storageRoot: root, scope: PROJECT_SCOPE }), afterMtime, "reference 不在候选池，不参与摘要");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ⑧ 懒编译缓存 ----

test("ensureCompiled：hash 一致走缓存不重写产物；候选变化才重编并记 compile-journal", () => {
  const root = freshRoot();
  try {
    const topic = writeGlobalEntry(root, "work-profile", "topic.md", { title: "Topic", description: "主题" });
    setMtime(topic, FIXED_NOW);
    const journalPath = join(runtimeDir(root), COMPILE_JOURNAL_FILE_NAME);

    const first = ensureCompiled({ storageRoot: root, scope: "global" });
    assert.equal(first.status, "ok");
    assert.ok(existsSync(join(scopeDir(root, "global"), "USER.md")));
    assert.ok(existsSync(join(scopeDir(root, "global"), "MEMORY.md")));
    assert.equal(readFileSync(journalPath, "utf8").trim().split("\n").length, 1, "每次真编译记一行 journal");
    const journal = JSON.parse(readFileSync(journalPath, "utf8").trim());
    assert.equal(journal.scope, "global");
    assert.equal(journal.trigger, "inject");
    assert.equal(journal.overQuota, false);
    assert.equal(journal.sourceHash, first.sourceHash);
    assert.equal(typeof journal.bytes.user, "number");
    assert.equal(typeof journal.bytes.memory, "number");

    // 手改产物（哨兵）→ 缓存命中时不重写
    const userPath = join(scopeDir(root, "global"), "USER.md");
    writeFileSync(userPath, "SENTINEL-HAND-EDIT\n", "utf8");
    const cached = ensureCompiled({ storageRoot: root, scope: "global" });
    assert.equal(cached.sourceHash, first.sourceHash);
    assert.equal(readFileSync(userPath, "utf8"), "SENTINEL-HAND-EDIT\n", "缓存命中不得覆盖产物");
    assert.equal(readFileSync(journalPath, "utf8").trim().split("\n").length, 1, "缓存命中不记 journal");

    // 候选变化 → 重编（哨兵被覆盖）+ journal +1
    writeGlobalEntry(root, "work-profile", "topic2.md", { title: "Topic2", description: "新条目" });
    const recompiled = ensureCompiled({ storageRoot: root, scope: "global" });
    assert.notEqual(recompiled.sourceHash, first.sourceHash);
    const text = readFileSync(userPath, "utf8");
    assert.ok(!text.includes("SENTINEL-HAND-EDIT"));
    assert.match(text, /AUTO-GENERATED/);
    assert.equal(readFileSync(journalPath, "utf8").trim().split("\n").length, 2);

    // journal=false 不写观测
    writeGlobalEntry(root, "work-profile", "topic3.md", { title: "Topic3", description: "再一条" });
    ensureCompiled({ storageRoot: root, scope: "global", journal: false });
    assert.equal(readFileSync(journalPath, "utf8").trim().split("\n").length, 2, "journal=false 不追加");

    // trigger 显式传入（面板/手动强制重编时用）
    writeGlobalEntry(root, "work-profile", "topic4.md", { title: "Topic4", description: "又一条" });
    ensureCompiled({ storageRoot: root, scope: "global", trigger: "panel" });
    const lines = readFileSync(journalPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[2]).trigger, "panel");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ⑨ 原子写失败面 ----

test("原子写失败：rename 失败不留 .tmp- 残留；ensureCompiled 记 status=error 并保留上一版产物", () => {
  const root = freshRoot();
  try {
    writeGlobalEntry(root, "work-profile", "topic.md", { title: "Topic", description: "主题" });
    const dir = scopeDir(root, "global");
    const first = ensureCompiled({ storageRoot: root, scope: "global" });
    const memoryBefore = readFileSync(join(dir, "MEMORY.md"), "utf8");
    const userTarget = join(dir, "USER.md");

    // 用目录占位 USER.md：tmp 写得进、rename 必失败（跨平台）
    rmSync(userTarget, { force: true });
    mkdirSync(userTarget, { recursive: true });
    const warns = [];
    const failed = ensureCompiled({ storageRoot: root, scope: "global", journal: false, log: { warn: (...args) => warns.push(args.join(" ")) } });
    assert.equal(failed.status, "error");
    assert.ok(warns.some((w) => w.includes("编译失败")), "失败必须可见（warn），不许静默");
    assert.deepEqual(readFileSync(join(dir, "MEMORY.md"), "utf8"), memoryBefore, "上一版产物文本保留");
    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp-"));
    assert.deepEqual(leftovers, [], "失败必须清 tmp");
    // runtime.json 被 error 清单覆盖（注入侧按 §十一 跳过 + usage 告警）；
    // 用量统计保留上一版（产物文本确实是上一版，清单不该凭空归零）
    const manifest = readRuntimeManifest(root, "global");
    assert.equal(manifest.status, "error");
    assert.equal(manifest.sourceHash, first.sourceHash);
    assert.equal(manifest.memory.bytes, first.memory.bytes);
    assert.deepEqual(manifest.memory.entries, first.memory.entries);
    // error 态不参与缓存命中：下次调用会重试（此处仍失败，仍为 error）
    const retried = ensureCompiled({ storageRoot: root, scope: "global", journal: false });
    assert.equal(retried.status, "error");
    assert.equal(readRuntimeManifest(root, "global").status, "error");

    // 恢复目录占位后成功重编
    rmSync(userTarget, { recursive: true, force: true });
    const ok = ensureCompiled({ storageRoot: root, scope: "global", journal: false });
    assert.equal(ok.status, "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("非法 scope：编译/落盘/懒编译一律拒绝（防路径穿越）", () => {
  const root = freshRoot();
  try {
    for (const scope of ["../evil", "projects/../evil", "projects/NO-UPPER-0123456789abcdef", "projects/x-0123", "global/", "", null, undefined]) {
      assert.throws(() => compileScope({ storageRoot: root, scope }), (error) => error.code === "SCOPE_INVALID", `scope=${String(scope)}`);
      assert.throws(() => writeRuntimeArtifacts(root, scope, { scope }), (error) => error.code === "SCOPE_INVALID");
      assert.throws(() => ensureCompiled({ storageRoot: root, scope }), (error) => error.code === "SCOPE_INVALID");
      assert.throws(() => scopeDir(root, scope), (error) => error.code === "SCOPE_INVALID");
    }
    assert.equal(existsSync(join(root, "runtime", "evil")), false);
    assert.equal(existsSync(join(root, "evil")), false);
    // 合法 scope 的两个形态
    assert.doesNotThrow(() => scopeDir(root, "global"));
    assert.doesNotThrow(() => scopeDir(root, PROJECT_SCOPE));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readRuntimeManifest：缺失/损坏返回 null", () => {
  const root = freshRoot();
  try {
    assert.equal(readRuntimeManifest(root, "global"), null);
    const dir = scopeDir(root, "global");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "runtime.json"), "{ not json", "utf8");
    assert.equal(readRuntimeManifest(root, "global"), null);
    writeFileSync(join(dir, "runtime.json"), JSON.stringify({ scope: "global" }), "utf8");
    assert.equal(readRuntimeManifest(root, "global"), null, "缺 sourceHash 视为不可用");
    writeFileSync(join(dir, "runtime.json"), JSON.stringify({ scope: "global", sourceHash: "x" }), "utf8");
    assert.notEqual(readRuntimeManifest(root, "global"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ⑩ compile-journal / evict-audit 轮转 ----

test("compile-journal 轮转：灌 2001 行 → 达 2000 转、留尾 1000（共 1001 行）", () => {
  const root = freshRoot();
  try {
    for (let i = 0; i < 2001; i += 1) {
      appendCompileJournal(root, {
        at: "2026-10-20T12:00:00.000Z",
        scope: "global",
        trigger: "inject",
        selected: i,
        candidates: 1,
        overQuota: false,
        bytes: { user: 1, memory: 2 },
        sourceHash: "h",
      });
    }
    const path = join(runtimeDir(root), COMPILE_JOURNAL_FILE_NAME);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 1001, "第 2000 条触发轮转留 1000，再追加 1 条");
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
    assert.equal(JSON.parse(lines[0]).selected, 1000, "被裁掉的是前 1000 行（阻止无界增长）");
    assert.equal(JSON.parse(lines[lines.length - 1]).selected, 2000);
    // journal 在 runtime/ 下（随 runtime 可删）
    assert.equal(dirname(path), runtimeDir(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evict-audit 轮转：灌 5001 行 → 达 5000 转、留尾 2500（共 2501 行），落 storageRoot 直下", () => {
  const root = freshRoot();
  try {
    for (let i = 0; i < 5001; i += 1) {
      appendEvictAudit(root, {
        at: "2026-10-20T12:00:00.000Z",
        scope: "global",
        rootKey: "project",
        file: `a${i}.md`,
        from: "projects/x/memory/a.md",
        to: "global/long-term/a.md",
        snapshot: "backups/evict-20261020/t-1-a.md",
        actor: "panel",
      });
    }
    const path = join(root, EVICT_AUDIT_FILE_NAME);
    assert.ok(!path.includes(`${join(root, "runtime")}`), "审计不随 runtime/ 删除");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2501);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
    const firstRecord = JSON.parse(lines[0]);
    assert.equal(firstRecord.file, "a2500.md");
    assert.equal(JSON.parse(lines[lines.length - 1]).file, "a5000.md");
    // 行形态完整（§6.2-6）
    assert.deepEqual(Object.keys(firstRecord).sort(), ["actor", "at", "file", "from", "rootKey", "scope", "snapshot", "to"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendCompileJournal 宽容归一：非法 trigger 回落 inject、数值钳非负、缺 at 补当前时刻", () => {
  const root = freshRoot();
  try {
    const record = appendCompileJournal(root, { scope: "global", trigger: "write", selected: -3, candidates: "7", overQuota: 1, bytes: { user: NaN, memory: "9" } });
    assert.equal(record.trigger, "inject", "trigger 枚举不含 write");
    assert.equal(record.selected, 0);
    assert.equal(record.candidates, 7);
    assert.equal(record.overQuota, false, "只有严格 true 才算 overQuota");
    assert.deepEqual(record.bytes, { user: 0, memory: 9 });
    assert.match(record.at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 辅助面：scope 枚举与缓存失效 ----
test("listScopes/scopeDir/runtimeDir：global 恒在，项目 scope 按目录名升序", () => {
  const root = freshRoot();
  try {
    assert.equal(runtimeDir(root), join(root, "runtime"));
    assert.equal(scopeDir(root, "global"), join(root, "runtime", "global"));
    assert.deepEqual(listScopes(root), ["global"]);
    mkdirSync(join(root, "projects", "zeta-0123456789abcdef", "memory"), { recursive: true });
    mkdirSync(join(root, "projects", "alpha-fedcba9876543210", "memory"), { recursive: true });
    mkdirSync(join(root, "projects", "not-a-scope"), { recursive: true });
    mkdirSync(join(root, "projects", "notes-0123456789abcdefx"), { recursive: true });
    assert.deepEqual(listScopes(root), ["global", "projects/alpha-fedcba9876543210", "projects/zeta-0123456789abcdef"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalidateRuntimeCache：删产物目录但保留 compile-journal；scope=null 清全部", () => {
  const root = freshRoot();
  try {
    writeGlobalEntry(root, "work-profile", "topic.md", { title: "Topic", description: "主题" });
    writeProjectEntry(root, PROJECT_SCOPE, "p.md", { title: "P", description: "项目" });
    ensureCompiled({ storageRoot: root, scope: "global" });
    ensureCompiled({ storageRoot: root, scope: PROJECT_SCOPE });
    const journalPath = join(runtimeDir(root), COMPILE_JOURNAL_FILE_NAME);
    assert.ok(existsSync(join(scopeDir(root, "global"), "runtime.json")));
    assert.ok(existsSync(join(scopeDir(root, PROJECT_SCOPE), "runtime.json")));
    assert.equal(readFileSync(journalPath, "utf8").trim().split("\n").length, 2);

    assert.equal(invalidateRuntimeCache(root, "global"), 1);
    assert.equal(existsSync(join(scopeDir(root, "global"), "runtime.json")), false);
    assert.ok(existsSync(join(scopeDir(root, PROJECT_SCOPE), "runtime.json")), "只失效指定 scope");
    assert.ok(existsSync(journalPath), "观测日志不随 scope 产物失效而消失");
    // 失效后下一次 ensureCompiled 必重编
    const rebuilt = ensureCompiled({ storageRoot: root, scope: "global" });
    assert.equal(rebuilt.status, "ok");
    assert.ok(existsSync(join(scopeDir(root, "global"), "runtime.json")));

    assert.equal(invalidateRuntimeCache(root), 2);
    assert.equal(existsSync(join(scopeDir(root, "global"), "runtime.json")), false);
    assert.equal(existsSync(join(scopeDir(root, PROJECT_SCOPE), "runtime.json")), false);
    assert.ok(existsSync(journalPath), "全量失效同样保留观测日志");
    // 不存在的 scope 失效 = 0（幂等）
    assert.equal(invalidateRuntimeCache(root, "global"), 0);
    assert.equal(invalidateRuntimeCache(root), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- ②b pinnedOver + 普通条目并存：候选 reason 与提示行（2026-10-22 补）----
// 语境：pinned 已把配额撑爆时，普通条目一条也装不进。它们**不是**「因配额淘汰」——
// 真因是 pinned，归档它们无效（下轮照样 overQuota、候选原样复现）。
// 且产物必须留下「另有 N 条没进来」的痕迹，否则面板候选清单与产物数字对不上。

test("pinnedOver + 普通条目：候选 reason=pinned-overflow（不是 quota），产物留 evicted 提示行", () => {
  const root = freshRoot();
  try {
    // 22 条 pinned 各约 500 字节 → 合计约 11KB，必超 10240
    for (let i = 0; i < 22; i += 1) {
      writeGlobalEntry(root, "work-profile", `pin-${i}.md`, {
        title: `P-${i}-${"T".repeat(300)}`,
        description: "d".repeat(150),
        pinned: true,
      });
    }
    // 3 条普通条目（必然一条也装不进）
    for (let i = 0; i < 3; i += 1) {
      writeGlobalEntry(root, "current-focus", `n-${i}.md`, { title: `N-${i}`, description: "普通条目" });
    }
    const compiled = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
    assert.equal(compiled.status, "overQuota", "pinned 撑爆配额");
    assert.ok(compiled.evictCandidates.length > 0, "普通条目必须登记为候选");
    // 全部候选的 reason 必须是 pinned-overflow（不是 quota——归档无效会误导用户）
    assert.ok(
      compiled.evictCandidates.every((c) => c.reason === "pinned-overflow"),
      `pinnedOver 时 reason 必须是 pinned-overflow，实际：${JSON.stringify(compiled.evictCandidates.map((c) => c.reason))}`,
    );
    // 产物必须留可见痕迹（否则面板有 N 条候选、产物里一句不提）
    assert.match(compiled.memory.text, /\[runtime evicted: \d+ /, "pinnedOver 时也必须写淘汰提示行");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("正常配额淘汰（无 pinned）：reason 仍是 quota，提示行照旧", () => {
  const root = freshRoot();
  try {
    // 无 pinned，纯普通条目撑爆配额 → 走顺序装填「装不下即停」分支
    for (let i = 0; i < 25; i += 1) {
      writeGlobalEntry(root, "work-profile", `w-${i}.md`, {
        title: `W-${i}-${"T".repeat(280)}`,
        description: "d".repeat(150),
      });
    }
    const compiled = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
    assert.ok(compiled.evictCandidates.length > 0, "应有淘汰候选");
    assert.ok(
      compiled.evictCandidates.every((c) => c.reason === "quota"),
      "无 pinned 时真淘汰，reason 必须是 quota",
    );
    assert.match(compiled.memory.text, /\[runtime evicted: \d+ /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- H2 配额预留（2026-10-22 补，v0.6.1 自称修掉但无测试）----
// 语境：淘汰提示行的字节必须计入配额。早先实现是「先装填完再事后追加提示行」，
// 会产出 bytes > quota 却 status=ok 的产物（面板用量条爆红 + 状态绿灯，自相矛盾）。
// 11e0915 改成「装填时为提示行预留字节」，但**没有任何测试钉住**它——
// 变异（删掉预留、恢复事后追加）全部通过（2026-10-22 独立复查实测）。

test("淘汰提示行必须计入配额：任何装填边界下 status=ok 都不得 bytes > quota", () => {
  // 实测定位的临界点（2026-10-22）：16 条固定宽度条目 + 第 17 条宽度 500/1100/1200 的 pads
  // 恰好把装填量顶到配额边缘；事后追加提示行的实现会产出 bytes>quota 却 status=ok。
  // 逐个 pad 覆盖——任何一处越界都算回归（不许只挑一个刚好过得去的用例）。
  for (const pad of [400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300]) {
    const root = freshRoot();
    try {
      for (let i = 0; i < 16; i += 1) {
        writeGlobalEntry(root, "work-profile", `f-${String(i).padStart(2, "0")}.md`, {
          title: `F-${i}-${"T".repeat(400)}`,
          description: "d".repeat(150),
        });
      }
      writeGlobalEntry(root, "work-profile", "g.md", {
        title: `G-${"Z".repeat(pad)}`,
        description: "d".repeat(150),
      });
      const compiled = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
      const quota = compiled.memory.quotaBytes;
      const bytes = compiled.memory.bytes;
      assert.equal(bytes, Buffer.byteLength(compiled.memory.text, "utf8"), `pad=${pad}：bytes 必须与产物文本逐字节一致`);
      // 核心不变量：status=ok 就必须真的没超配额（提示行也占字节，不许事后追加越界）
      if (compiled.status === "ok") {
        assert.ok(bytes <= quota, `pad=${pad}：status=ok 时产物必须 ≤ 配额（实际 ${bytes} > ${quota}）——提示行必须在装填时预留字节`);
      }
      // 有淘汰候选就必有提示行
      if (compiled.evictCandidates.length > 0) {
        assert.match(compiled.memory.text, /\[runtime evicted: \d+ /, `pad=${pad}：有淘汰候选就必须留可见痕迹`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("提示行放不下时先退条目（记忆内容 > 提示详细度），退完仍不越界", () => {
  const root = freshRoot();
  try {
    // 极端构造：装填刚好填满，提示行放不下 → 必须退掉尾部条目腾地方
    for (let i = 0; i < 40; i += 1) {
      writeGlobalEntry(root, "work-profile", `x-${String(i).padStart(2, "0")}.md`, {
        title: `X-${i}-${"B".repeat(250)}`,
        description: "z".repeat(140),
      });
    }
    const compiled = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
    assert.ok(compiled.evictCandidates.length > 0, "必然有淘汰");
    assert.match(compiled.memory.text, /\[runtime evicted: \d+ /, "必须留下提示行");
    // 提示行占字节后仍不得越界（status 与 bytes 必须自洽）
    if (compiled.status === "ok") {
      assert.ok(compiled.memory.bytes <= compiled.memory.quotaBytes, "退条目后必须回到配额内");
      // 被退的条目必须出现在淘汰清单里（不能凭空消失）
      const evictedFiles = new Set(compiled.evictCandidates.map((c) => c.file));
      const includedFiles = new Set(compiled.memory.entries.filter((e) => e.included).map((e) => e.file));
      for (const f of evictedFiles) {
        assert.ok(!includedFiles.has(f), `被退条目 ${f} 不得同时标记为 included`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- P2-a：退条目后提示行绝不能被清空（2026-10-22 复查修复）----
// 语境：v0.6.3 遗留缺陷——剩余空间落在 [0, 短提示行) 且 rest 里有可退条目时，
// 循环退掉真条目后仍放不下 → 旧写法 `fits(note) ? note : ""` 把提示清空。
// 结果是「101 条没进来、一条能进来的也被退掉、产物一个字都没提」：
// 代价付了、痕迹抹了。修法：只要发生过 retreat，提示行必须留（哪怕 status 变 overQuota）。

test("P2-a：产物内 every 淘汰候选都必须有对应提示行或可见降级（不变量扫描）", () => {
  // 不变量（不是某个特定构造）：只要 evictCandidates 非空，产物要么带 evicted 提示行，
  // 要么 status=overQuota（可见降级），绝不允许「有淘汰、产物却一句不提」。
  // 这条约束不依赖具体尺寸，能覆盖「退了条目但提示被清空」与「提示放不下且无处可退」两类。
  const cases = [
    { pinned: 0, pads: [400, 500, 600, 700, 800, 900, 1000, 1100, 1200] },
    { pinned: 45, pads: [400, 600, 800, 1000] },
    { pinned: 47, pads: [400, 600, 800, 1000, 1200] },
    { pinned: 48, pads: [400, 800] },
  ];
  for (const { pinned, pads } of cases) {
    for (const pad of pads) {
      const root = freshRoot();
      try {
        for (let i = 0; i < pinned; i += 1) {
          writeGlobalEntry(root, "work-profile", `p${String(i).padStart(2, "0")}.md`, {
            title: `P${i}`, description: "d".repeat(150), pinned: true,
          });
        }
        // 一条尺寸可调的普通条目 + 一批必然落选的大条目
        writeGlobalEntry(root, "current-focus", "mid.md", { title: `M-${"Y".repeat(pad)}`, description: "t" });
        for (let i = 0; i < 50; i += 1) {
          writeGlobalEntry(root, "current-focus", `n${String(i).padStart(3, "0")}.md`, {
            title: `N${i}-${"T".repeat(400)}`, description: "d".repeat(150),
          });
        }
        const c = compileScope({ storageRoot: root, scope: "global", now: FIXED_NOW });
        if (c.evictCandidates.length === 0) continue;
        const hasNote = /\[runtime evicted/.test(c.memory.text);
        const visiblyDegraded = c.status === "overQuota";
        assert.ok(
          hasNote || visiblyDegraded,
          `pinned=${pinned} pad=${pad}：有 ${c.evictCandidates.length} 条淘汰候选，但产物既无提示行也不是 overQuota（静默丢失）`,
        );
        // 被淘汰的条目不得同时标记 included
        const includedFiles = new Set(c.memory.entries.filter((e) => e.included).map((e) => e.file));
        for (const cand of c.evictCandidates) {
          assert.ok(!includedFiles.has(cand.file), `pinned=${pinned} pad=${pad}：被淘汰的 ${cand.file} 不得同时 included`);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

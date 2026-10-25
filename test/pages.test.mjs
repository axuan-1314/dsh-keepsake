// pages：项目知识页（派生视图）——解析、落盘、摘要注入、生成编排。
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import {
  PAGE_DEFS,
  PAGES_LOCK_FILENAME,
  PAGES_LOCK_STALE_MS,
  __resetPagesStateForTest,
  acquirePagesLock,
  buildPagesPayload,
  collectPageSources,
  generatePages,
  isPagesWriteBusy,
  isValidProjectId,
  pagesDir,
  pagesSnapshot,
  pagesSummaryTexts,
  parsePagesOutput,
  readPages,
  readPagesManifest,
  writePages,
} from "../lib/pages.js";
import { projectMemoryPaths } from "../lib/paths.js";

function freshProject() {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-pages-"));
  const { memoryDir } = projectMemoryPaths(root, root);
  mkdirSync(memoryDir, { recursive: true });
  const projectId = basename(dirname(memoryDir));
  writeFileSync(join(memoryDir, "decision.md"), [
    "---",
    'name: "use-pnpm"',
    'description: "团队统一用 pnpm"',
    "metadata:",
    "  type: project",
    'node_type: "memory"',
    "---",
    "",
    "# 使用 pnpm",
    "",
    "团队统一用 pnpm，禁止 npm。",
  ].join("\n"));
  writeFileSync(join(memoryDir, "MEMORY.md"), "- [使用 pnpm](use-pnpm.md) — 团队统一用 pnpm\n");
  return { root, memoryDir, projectId };
}

function page(id, title = id) {
  return { id, title, summary: `${title} summary`, content: `# ${title}\n\n- 来自 [[use-pnpm]]` };
}

function fullPagesOutput() {
  return JSON.stringify({ pages: PAGE_DEFS.map((definition) => page(definition.id, definition.title)) });
}

test("parsePagesOutput：fence/前后缀 + 五页齐全 + 截断超长字段", () => {
  const raw = `说明\n\`\`\`json\n${fullPagesOutput()}\n\`\`\`\n尾部`;
  const pages = parsePagesOutput(raw);
  assert.equal(pages.length, 5);
  assert.deepEqual(pages.map((p) => p.id), PAGE_DEFS.map((p) => p.id));
  assert.equal(pages[0].title, "组件地图");
  // 摘要进注入行前必须压成单行、去掉方括号（防伪造索引行）
  const dirty = JSON.parse(fullPagesOutput());
  dirty.pages[0].summary = "第一行\n第二行 [伪标题]";
  assert.equal(parsePagesOutput(JSON.stringify(dirty))[0].summary, "第一行 第二行 伪标题");
});

test("parsePagesOutput：缺页/空内容/未知 id 都拒绝（不写半套页面）", () => {
  const missing = JSON.stringify({ pages: [page("component-map")] });
  assert.throws(() => parsePagesOutput(missing), /缺少页面/);
  const empty = JSON.parse(fullPagesOutput());
  empty.pages[0].content = "";
  assert.throws(() => parsePagesOutput(JSON.stringify(empty)), /缺少页面/);
  const unknown = JSON.parse(fullPagesOutput());
  unknown.pages[0].id = "not-a-page";
  assert.throws(() => parsePagesOutput(JSON.stringify(unknown)), /缺少页面/);
});

test("writePages/readPages：manifest 是提交点；读取只认合法 id，路径不信任 manifest", () => {
  const { root, projectId } = freshProject();
  try {
    const manifest = writePages(root, projectId, PAGE_DEFS.map((definition) => page(definition.id, definition.title)), {
      generatedAt: "2026-10-25T00:00:00.000Z",
      sourceHash: "abc123",
      indexStamp: "1:1",
      model: "p/m",
    });
    assert.equal(manifest.pages.length, 5);
    const read = readPages(root, projectId);
    assert.equal(read.generatedAt, "2026-10-25T00:00:00.000Z");
    assert.equal(read.pages.length, 5);
    assert.match(read.pages[0].content, /来自 \[\[use-pnpm\]\]/);
    // 手改 manifest 的 file 字段不会让读取越界
    const manifestPath = join(pagesDir(root, projectId), "manifest.json");
    const dirty = JSON.parse(readFileSync(manifestPath, "utf8"));
    dirty.pages[0].file = "../../etc/passwd";
    writeFileSync(manifestPath, JSON.stringify(dirty));
    assert.equal(readPagesManifest(root, projectId).pages[0].id, "component-map");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isValidProjectId/pagesDir：拒绝路径穿越与非法 id", () => {
  assert.equal(isValidProjectId("default-workspace-96f6668a1bb6707b"), true);
  assert.equal(isValidProjectId("../evil"), false);
  assert.equal(isValidProjectId("project-xyz"), false);
  assert.throws(() => pagesDir("C:/tmp", "../evil"), /非法 projectId/);
});

test("collectPageSources：进 prompt 前脱敏（旧条目里的密钥不会复制到页面）", () => {
  const { root, memoryDir } = freshProject();
  try {
    writeFileSync(join(memoryDir, "secret.md"), [
      "---",
      'name: "secret"',
      'description: "带密钥的旧条目"',
      "metadata:",
      "  type: reference",
      'node_type: "memory"',
      "---",
      "",
      "token: sk-FAKE0000000000000000",
    ].join("\n"));
    const { manifest, bodies } = collectPageSources(memoryDir);
    assert.ok(!bodies.includes("sk-FAKE0000000000000000"), "正文里的密钥应被脱敏");
    assert.match(bodies, /\[redacted\]/);
    assert.ok(!manifest.includes("sk-FAKE0000000000000000"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildPagesPayload：五页定义、引用约定与严格输出契约都在", () => {
  const { root, memoryDir, projectId } = freshProject();
  try {
    const { manifest, bodies } = collectPageSources(memoryDir);
    const { system, user } = buildPagesPayload({ projectId, manifest, bodies, existing: null });
    for (const definition of PAGE_DEFS) assert.ok(system.includes(definition.id));
    assert.match(system, /\[\[entry-name\]\]/);
    assert.match(system, /ONE JSON object/);
    assert.match(user, /项目记忆|Current project memory manifest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePages：端到端写盘 + 摘要；失败保留旧 manifest、计数可见", async () => {
  __resetPagesStateForTest();
  const { root, projectId } = freshProject();
  try {
    const ok = await generatePages({
      storageRoot: root,
      projectId,
      model: "p/m",
      callLlm: async () => ({ text: fullPagesOutput() }),
    });
    assert.equal(ok.manifest.pages.length, 5);
    assert.equal(readPages(root, projectId).pages.length, 5);
    assert.equal(pagesSnapshot().generations, 1);
    const summary = pagesSummaryTexts(root, projectId);
    assert.match(summary.full, /Project knowledge pages/);
    assert.match(summary.full, /组件地图/);
    assert.match(summary.full, /字；完整正文见/);
    assert.doesNotMatch(summary.compact, /字；完整正文见/, "compact 去掉字数提示行");

    const before = readFileSync(join(pagesDir(root, projectId), "manifest.json"), "utf8");
    await assert.rejects(
      generatePages({
        storageRoot: root,
        projectId,
        callLlm: async () => ({ text: "not json" }),
      }),
      (error) => error.code === "E_PARSE",
    );
    assert.equal(readFileSync(join(pagesDir(root, projectId), "manifest.json"), "utf8"), before, "失败不覆盖旧 manifest");
    assert.equal(pagesSnapshot().errors, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pagesSummaryTexts：MEMORY.md 变化后标记 stale", async () => {
  const { root, memoryDir, projectId } = freshProject();
  try {
    await generatePages({ storageRoot: root, projectId, callLlm: async () => ({ text: fullPagesOutput() }) });
    assert.doesNotMatch(pagesSummaryTexts(root, projectId).full, /stale/);
    writeFileSync(join(memoryDir, "MEMORY.md"), "- [使用 pnpm](use-pnpm.md) — 团队统一用 pnpm\n- [新增](use-pnpm.md) — 新增一条\n");
    assert.match(pagesSummaryTexts(root, projectId).full, /stale/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 升级兼容：旧版 manifest 的 indexStamp 是 "mtimeMs:size"，与新的内容哈希必然不等。
// 若不识别旧格式，所有存量项目升级后都会一直显示「记忆已变」——那是升级噪声。
test("pagesSummaryTexts：旧格式 indexStamp 不产生升级假 stale", async () => {
  const { root, projectId } = freshProject();
  try {
    await generatePages({ storageRoot: root, projectId, callLlm: async () => ({ text: fullPagesOutput() }) });
    const manifestPath = join(pagesDir(root, projectId), "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.indexStamp = "1792944691058:38"; // 旧格式（mtimeMs:size）
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    assert.doesNotMatch(pagesSummaryTexts(root, projectId).full, /stale/, "旧格式不该被当作「记忆已变」");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 同长度改写 + mtime 复原（备份还原 / 跨设备复制 / 编辑器保留时间戳）：
// 旧的 `mtimeMs:size` 指纹在这三种情况下完全不变，stale 提示永远不出现。
// 注意 mtime 必须钉成**整秒**再复原：Windows/NTFS 的时间戳精度是 100ns，
// 而 Node 的 Date 只有 ms，直接 utimesSync 回原 Date 会差出亚毫秒残差，
// 那样测试会因为「时间戳其实变了」而假绿（本项目已三次栽在假绿上）。
test("pagesSummaryTexts：同长度改写且 mtime 复原，仍标记 stale（内容哈希判据）", async () => {
  const { root, memoryDir, projectId } = freshProject();
  try {
    const indexPath = join(memoryDir, "MEMORY.md");
    const pinned = new Date("2026-10-01T00:00:00.000Z"); // 整秒，可精确复原
    utimesSync(indexPath, pinned, pinned);
    const original = readFileSync(indexPath, "utf8");
    const sizeAtGeneration = statSync(indexPath).size;
    await generatePages({ storageRoot: root, projectId, callLlm: async () => ({ text: fullPagesOutput() }) });
    assert.doesNotMatch(pagesSummaryTexts(root, projectId).full, /stale/, "生成后即新鲜");

    // 前提校验：复原后的 mtime 与 size 必须与生成时**完全一致**，
    // 否则这条测试证明不了「内容哈希比 mtime:size 更强」。
    const sameLength = original.replace("pnpm", "yarn");
    assert.equal(sameLength.length, original.length, "前提：改写后字符数不变");
    assert.equal(Buffer.byteLength(sameLength, "utf8"), Buffer.byteLength(original, "utf8"), "前提：改写后字节数不变（旧指纹比的是 size）");
    assert.notEqual(sameLength, original, "前提：内容确实变了");
    writeFileSync(indexPath, sameLength);
    utimesSync(indexPath, pinned, pinned);
    const restored = statSync(indexPath);
    assert.equal(restored.mtimeMs, pinned.getTime(), "前提：mtime 必须精确复原");
    // size 要与**生成时那一刻**的真实 size 比，不能与「同一个字符串」比——
    // 那样是恒真式，换字符数相同但字节数不同的词（例如中文）时会静默退化成假绿。
    assert.equal(restored.size, sizeAtGeneration, "前提：size 必须与生成时完全一致");

    assert.match(pagesSummaryTexts(root, projectId).full, /stale/, "内容变了就必须标 stale，哪怕 mtime 与 size 都没变");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 落盘两阶段：任何一步失败都不得留「新页 + 旧 manifest」的混合态。
test("writePages：单页落盘失败时不留下半新半旧的现场", async () => {
  const { root, projectId } = freshProject();
  try {
    const oldAt = "2026-01-01T00:00:00.000Z";
    // summary 必须新旧可区分，否则「manifest 保持旧版」这条断言对新旧两版都成立=假绿
    const pages = PAGE_DEFS.map((def, i) => ({ id: def.id, title: def.title, summary: `old-s${i}`, content: `old ${i}` }));
    writePages(root, projectId, pages, { generatedAt: oldAt });
    const firstPagePath = join(pagesDir(root, projectId), `${PAGE_DEFS[0].id}.md`);
    const oldFirst = readFileSync(firstPagePath, "utf8");

    // 把最后一页的目标位置占成目录，让换入阶段必然失败
    const lastId = PAGE_DEFS[PAGE_DEFS.length - 1].id;
    const lastPath = join(pagesDir(root, projectId), `${lastId}.md`);
    rmSync(lastPath, { force: true });
    mkdirSync(lastPath);

    const next = PAGE_DEFS.map((def, i) => ({ id: def.id, title: def.title, summary: `new-s${i}`, content: `new ${i}` }));
    assert.throws(() => writePages(root, projectId, next, { generatedAt: "2026-02-02T00:00:00.000Z" }));

    // 已提交的页必须回滚成旧文，manifest 也必须是旧的
    assert.equal(readFileSync(firstPagePath, "utf8"), oldFirst, "已换进去的页必须回滚");
    const manifest = readPagesManifest(root, projectId);
    assert.equal(manifest.generatedAt, oldAt, "manifest 必须是旧版（generatedAt 可区分新旧）");
    assert.ok(manifest.pages.every((p) => p.summary.startsWith("old-s")), "manifest 的 summary 必须还是旧版");
    // 已换入的页正文也必须回滚（不能只查第一页）
    for (const def of PAGE_DEFS) {
      if (def.id === lastId) continue; // 这一页的目标位置被目录占着，本就没写成
      const body = readFileSync(join(pagesDir(root, projectId), `${def.id}.md`), "utf8");
      assert.doesNotMatch(body, /new-s?\d|new \d/, `${def.id} 不得留新内容`);
    }
    // 不留临时文件
    const leftovers = readdirSync(pagesDir(root, projectId)).filter((name) => name.includes(".tmp-"));
    assert.deepEqual(leftovers, [], "失败后不得残留临时文件");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 阶段一失败（写临时文件就失败）时：正式文件零改动，且半截临时文件也要清干净。
// 阶段一（写 .tmp-new）失败时：正式文件零改动，且**半截临时文件**也要清干净。
// 触发方式：临时文件名是 `<page>.md.tmp-new-<pid>-<Date.now()>`，把 Date.now 钉住
// 就能预先用目录占住那个路径 → writeFileSync 必然 EISDIR。
// （不能用「只读文件/只读目录」：Windows 上两者都挡不住写入，测不出东西。）
test("writePages：阶段一失败时正式文件零改动、无临时文件残留", async () => {
  const { root, projectId } = freshProject();
  const realNow = Date.now;
  try {
    const pages = PAGE_DEFS.map((def, i) => ({ id: def.id, title: def.title, summary: `old-s${i}`, content: `old ${i}` }));
    writePages(root, projectId, pages, { generatedAt: "2026-01-01T00:00:00.000Z" });
    const dir = pagesDir(root, projectId);
    const before = PAGE_DEFS.map((def) => readFileSync(join(dir, `${def.id}.md`), "utf8"));
    const manifestBefore = readFileSync(join(dir, "manifest.json"), "utf8");

    // 钉住时钟，让 stamp 可预测；第 3 页的临时路径预先被目录占住
    const frozen = 1700000000123;
    Date.now = () => frozen;
    const stamp = `${process.pid}-${frozen}`;
    const blockedTmp = join(dir, `${PAGE_DEFS[2].id}.md.tmp-new-${stamp}`);
    mkdirSync(blockedTmp);

    const next = PAGE_DEFS.map((def, i) => ({ id: def.id, title: def.title, summary: `new-s${i}`, content: `new ${i}` }));
    assert.throws(
      () => writePages(root, projectId, next, { generatedAt: "2026-02-02T00:00:00.000Z" }),
      (error) => error.code === "EISDIR" || /EISDIR|directory/i.test(String(error.message)),
      "必须是阶段一的写入失败",
    );

    // 正式文件与 manifest 零改动
    for (const [i, def] of PAGE_DEFS.entries()) {
      assert.equal(readFileSync(join(dir, `${def.id}.md`), "utf8"), before[i], `${def.id} 必须零改动`);
    }
    assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), manifestBefore, "manifest 必须零改动");
    // 半截临时文件不得残留（这就是原先漏清的「正在写的那一个」）
    rmSync(blockedTmp, { recursive: true, force: true });
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp-")), [], "不得残留临时文件");
  } finally {
    Date.now = realNow;
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatePages：项目不存在/记忆为空时显式拒绝", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-pages-empty-"));
  try {
    await assert.rejects(
      generatePages({ storageRoot: root, projectId: "project-8469841b416be31b", callLlm: async () => ({ text: "{}" }) }),
      (error) => error.code === "E_PROJECT_NOT_FOUND",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 跨进程写锁（pages.lock）----
// 本仓不保证 storageRoot 独占（web + desktop 可共用），进程内单飞挡不住跨进程交错：
// 两个两阶段提交交错时，后失败者会把对方刚写好的页当旧版还原回去。

/** 锁文件是 storageRoot 下的 pages.lock（不是 pages/<project>/ 里，也不是 extract.lock）。 */
function lockPath(root) {
  return join(root, PAGES_LOCK_FILENAME);
}

/** 一次成功写入的页集合；summary 带前缀便于区分新旧。 */
function pagesWith(prefix) {
  return PAGE_DEFS.map((def, i) => ({ id: def.id, title: def.title, summary: `${prefix}-s${i}`, content: `${prefix} ${i}` }));
}

test("writePages：锁被占时显式失败 E_PAGES_BUSY，正式文件零改动（读路径不受影响）", () => {
  const { root, projectId } = freshProject();
  try {
    const oldAt = "2026-03-03T00:00:00.000Z";
    writePages(root, projectId, pagesWith("old"), { generatedAt: oldAt });
    const dir = pagesDir(root, projectId);
    const before = PAGE_DEFS.map((def) => readFileSync(join(dir, `${def.id}.md`), "utf8"));
    const manifestBefore = readFileSync(join(dir, "manifest.json"), "utf8");

    // 模拟另一个实例正持锁：新鲜 at（未 stale）的锁文件
    writeFileSync(lockPath(root), JSON.stringify({ pid: process.pid === 1 ? 2 : 1, at: Date.now(), token: "other-instance" }) + "\n", "utf8");

    assert.throws(
      () => writePages(root, projectId, pagesWith("new"), { generatedAt: "2026-04-04T00:00:00.000Z" }),
      (error) => {
        assert.equal(error.code, "E_PAGES_BUSY", "并发被拒必须有可分流错误码，不能静默跳过");
        assert.match(error.message, /未写入/, "消息必须说明这次没写");
        return true;
      },
    );

    // 正式文件零改动（既不能写新内容，也不能因为「没抢到锁」而清掉别人的现场）
    for (const [i, def] of PAGE_DEFS.entries()) {
      assert.equal(readFileSync(join(dir, `${def.id}.md`), "utf8"), before[i], `${def.id} 必须零改动`);
    }
    assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), manifestBefore, "manifest 必须零改动");
    // 别人的锁不能被我们拆掉（否则下一个实例就能趁隙进入写段）
    assert.equal(JSON.parse(readFileSync(lockPath(root), "utf8")).token, "other-instance", "失败路径不得释放他人的锁");
    // 读路径不被写锁阻塞
    assert.equal(readPages(root, projectId).pages.length, 5, "持锁期间读取必须照常可用");
    assert.match(pagesSummaryTexts(root, projectId).full, /Project knowledge pages/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// release 必须只拆自己的锁：按 stale 接管后锁已换主，误删新主的锁会让两个实例同时进入写段。
test("acquirePagesLock：release 只拆 token 匹配的锁", () => {
  const { root } = freshProject();
  try {
    const mine = acquirePagesLock(root);
    assert.equal(mine.acquired, true);
    assert.equal(existsSync(lockPath(root)), true);
    // 模拟：我的锁被判 stale 后由他人重抢（token 已换）
    writeFileSync(lockPath(root), JSON.stringify({ pid: 4242, at: Date.now(), token: "someone-else" }) + "\n", "utf8");
    mine.release();
    assert.equal(existsSync(lockPath(root)), true, "不得拆掉新主的锁");
    assert.equal(JSON.parse(readFileSync(lockPath(root), "utf8")).token, "someone-else");
    // 自己的锁则正常释放
    const again = acquirePagesLock(root);
    again.release();
    rmSync(lockPath(root), { force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writePages：成功后锁不残留", () => {
  const { root, projectId } = freshProject();
  try {
    writePages(root, projectId, pagesWith("ok"), { generatedAt: "2026-03-03T00:00:00.000Z" });
    assert.equal(existsSync(lockPath(root)), false, "成功路径必须释放锁，否则下一次写入永远 E_PAGES_BUSY");
    // 释放的实证：紧接着还能再写一次
    writePages(root, projectId, pagesWith("again"), { generatedAt: "2026-03-04T00:00:00.000Z" });
    assert.equal(readPagesManifest(root, projectId).generatedAt, "2026-03-04T00:00:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writePages：落盘失败也释放锁（一次失败不能永久锁死后续写入）", () => {
  const { root, projectId } = freshProject();
  try {
    writePages(root, projectId, pagesWith("old"), { generatedAt: "2026-03-03T00:00:00.000Z" });
    const dir = pagesDir(root, projectId);
    // 用目录占住最后一页目标：换入阶段必然失败（既有测试同款手法）
    const lastPath = join(dir, `${PAGE_DEFS[PAGE_DEFS.length - 1].id}.md`);
    rmSync(lastPath, { force: true });
    mkdirSync(lastPath);

    assert.throws(() => writePages(root, projectId, pagesWith("new"), { generatedAt: "2026-04-04T00:00:00.000Z" }));
    assert.equal(existsSync(lockPath(root)), false, "失败路径必须释放锁（finally）");

    // 关键：清掉障碍后必须还能写进去——锁若残留，这里会抛 E_PAGES_BUSY
    rmSync(lastPath, { recursive: true, force: true });
    writePages(root, projectId, pagesWith("next"), { generatedAt: "2026-05-05T00:00:00.000Z" });
    assert.equal(readPagesManifest(root, projectId).generatedAt, "2026-05-05T00:00:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 崩溃留下的陈锁必须能被抢掉，否则一次崩溃 = 知识页永久不可写。
// 同时把两条可能的时间判据都做成「很旧」：锁内容里的 at（当前实现用它）与文件 mtime。
// 判据换成 mtime 时这条测试仍然成立，不会因为实现口径变化而假绿/假红。
test("writePages：陈锁可被抢（内容 at 与 mtime 双旧）", () => {
  const { root, projectId } = freshProject();
  try {
    const staleAt = Date.now() - PAGES_LOCK_STALE_MS - 60_000;
    writeFileSync(lockPath(root), JSON.stringify({ pid: 999999, at: staleAt, token: "dead-owner" }) + "\n", "utf8");
    const old = new Date(staleAt);
    utimesSync(lockPath(root), old, old);

    const manifest = writePages(root, projectId, pagesWith("stale"), { generatedAt: "2026-06-06T00:00:00.000Z" });
    assert.equal(manifest.generatedAt, "2026-06-06T00:00:00.000Z", "陈锁必须被抢过来并完成写入");
    assert.equal(readPages(root, projectId).pages.length, 5);
    assert.equal(existsSync(lockPath(root)), false, "抢到的新锁在完成后同样要释放");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 回滚备份（.tmp-old-*）必须用「诞生时刻」计时，不能继承被备份页的 mtime。
// Windows 上 copyFileSync 会继承源 mtime，于是「隔了一小时以上重新生成」的备份
// 一落地就是「到龄孤儿」；另一实例此刻跑启动清扫会删掉还没用完的回滚材料，
// 换入失败时回滚直接 ENOENT，留下半新半旧 + 旧 manifest（两阶段提交要消灭的混合态）。
//
// 直接从原语层验证：备份的正常窗口只有毫秒级（整次写入实测 21~48ms），
// 从外部等不到；且 writePages 是同步的，单进程内并发清扫根本跑不起来（事件循环被占）。
// 所以钉住 makeRollbackBackup 的产出，再用真正的清扫器当裁判。
test("makeRollbackBackup：备份 mtime 是诞生时刻，清扫器不会把它当到龄孤儿", async () => {
  const { makeRollbackBackup } = await import("../lib/pages.js");
  const { sweepTmpOrphans } = await import("../lib/global-store.js");
  const { root, projectId } = freshProject();
  try {
    const dir = pagesDir(root, projectId);
    mkdirSync(dir, { recursive: true });
    const src = join(dir, "component-map.md");
    writeFileSync(src, "# 旧页\n\n八天前生成的。\n");
    const ancient = new Date(Date.now() - 8 * 24 * 3600_000);
    utimesSync(src, ancient, ancient);

    // 前提确认：源文件确实很旧（否则下面的断言不成立）
    assert.ok(Date.now() - statSync(src).mtimeMs > 3600_000, "前提：源文件 mtime 已超清扫到龄阈值");

    const backup = join(dir, `component-map.md.tmp-old-${process.pid}-${Date.now()}`);
    makeRollbackBackup(src, backup);

    // 核心：备份的 mtime 必须是「刚才」，不是源文件的 8 天前
    const age = Date.now() - statSync(backup).mtimeMs;
    assert.ok(age < 60_000, `备份 mtime 必须是诞生时刻，实际 ${(age / 3600_000).toFixed(1)} 小时前`);

    // 用真正的清扫器裁决：新鲜的备份不该被清
    sweepTmpOrphans(root);
    assert.ok(existsSync(backup), "刚建的备份不得被清扫器清掉（否则失败回滚会 ENOENT）");

    // 反向对照：不钉 mtime 的同类文件会被清掉——证明上面那条不是空验
    const inherited = join(dir, `core-concepts.md.tmp-old-${process.pid}-${Date.now() + 1}`);
    copyFileSync(src, inherited);
    utimesSync(inherited, ancient, ancient);
    sweepTmpOrphans(root);
    assert.equal(existsSync(inherited), false, "继承旧 mtime 的备份会被清扫掉——这正是要避免的情形");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 抢锁前预检：另一个实例在写时直接拒绝，不白烧一次 LLM 调用。
// 预检只负责省调用，不承担互斥（真正的闸在 writePages 的锁）——
// 所以 TOCTOU 无害：预检过了但写入前被别人抢到，退化成「烧一次调用后被告知忙」。
test("generatePages：锁被占时在调 LLM 之前就拒绝（不白烧模型调用）", async () => {
  const { root, projectId } = freshProject();
  try {
    writeFileSync(lockPath(root), JSON.stringify({ pid: 424242, at: Date.now(), token: "other" }) + "\n", "utf8");
    let calls = 0;
    let caught = null;
    try {
      await generatePages({
        storageRoot: root,
        projectId,
        callLlm: async () => { calls += 1; return { text: "{}" }; },
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught !== null, "锁被占时必须抛错");
    assert.equal(caught.code, "E_PAGES_BUSY");
    assert.equal(calls, 0, "预检必须在调用 LLM 之前生效——否则每次撞锁都白烧一次模型调用");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isPagesWriteBusy：只把「新鲜的锁」当成占用（陈锁/未来时间戳/坏文件都不算）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-busy-"));
  try {
    assert.equal(isPagesWriteBusy(root), false, "没有锁 = 不忙");
    writeFileSync(lockPath(root), JSON.stringify({ pid: 1, at: Date.now(), token: "t" }) + "\n", "utf8");
    assert.equal(isPagesWriteBusy(root), true, "新鲜锁 = 忙");
    writeFileSync(lockPath(root), JSON.stringify({ pid: 1, at: Date.now() - PAGES_LOCK_STALE_MS - 1000, token: "t" }) + "\n", "utf8");
    assert.equal(isPagesWriteBusy(root), false, "陈锁不算占用（否则崩溃一次就永久拒绝）");
    writeFileSync(lockPath(root), JSON.stringify({ pid: 1, at: Date.now() + 3600_000, token: "t" }) + "\n", "utf8");
    assert.equal(isPagesWriteBusy(root), false, "未来时间戳不算占用（时钟漂移不该锁死）");
    writeFileSync(lockPath(root), "not json", "utf8");
    assert.equal(isPagesWriteBusy(root), false, "坏锁文件按最旧处理");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// storageRoot 被一个同名文件占住时，mkdirSync 抛 EEXIST——那不是「锁被占」，
// 而是配置/磁盘错误。报成 E_PAGES_BUSY 会让用户一直重试一个永远不可能成功的操作。
test("acquirePagesLock：存储根不是目录时不被误报成 E_PAGES_BUSY", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-notdir-"));
  try {
    const asFile = join(root, "storage");
    writeFileSync(asFile, "i am a file", "utf8");
    assert.throws(() => acquirePagesLock(asFile), (error) => {
      assert.notEqual(error.code, "E_PAGES_BUSY", "存储根不可用不得说成「稍后重试」");
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

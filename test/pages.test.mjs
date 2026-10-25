// pages：项目知识页（派生视图）——解析、落盘、摘要注入、生成编排。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import {
  PAGE_DEFS,
  __resetPagesStateForTest,
  buildPagesPayload,
  collectPageSources,
  generatePages,
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

// pages：项目知识页（派生视图）——解析、落盘、摘要注入、生成编排。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      "token: sk-example-not-a-real-key-000",
    ].join("\n"));
    const { manifest, bodies } = collectPageSources(memoryDir);
    assert.ok(!bodies.includes("sk-example-not-a-real-key-000"), "正文里的密钥应被脱敏");
    assert.match(bodies, /\[redacted\]/);
    assert.ok(!manifest.includes("sk-example-not-a-real-key-000"));
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

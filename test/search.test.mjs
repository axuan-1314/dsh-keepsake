// search：关键词检索的打分口径与范围过滤（纯函数 + 只读 IO）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listMemoryEntries, scoreEntry, searchMemory, snippetOf, splitQuery, SEARCH_SCAN_MAX_FILES } from "../lib/search.js";
import { categoryDir } from "../lib/global-store.js";

function entryFile(root, name, { title, description = "", type = "project", body = "" }) {
  const content = [
    "---",
    `name: "${name.replace(/\.md$/i, "")}"`,
    `description: "${description}"`,
    "metadata:",
    `  type: ${type}`,
    `title: "${title}"`,
    "---",
    "",
    body,
  ].join("\n");
  writeFileSync(join(root, name), content);
  return content;
}

test("splitQuery：去重、保序、上限 8 个，空串给空数组", () => {
  assert.deepEqual(splitQuery(""), []);
  assert.deepEqual(splitQuery("   "), []);
  assert.deepEqual(splitQuery("pnpm  pnpm 铁律"), ["pnpm", "铁律"]);
  const many = splitQuery("a b c d e f g h i j k");
  assert.equal(many.length, 8);
});

test("scoreEntry：名字完全相等 100，名字包含 60，标题 45，摘要 30，正文 15", () => {
  const base = { name: "pnpm.md", title: "PNPM", description: "包管理器", body: "用它装依赖" };
  assert.equal(scoreEntry(base, ["pnpm"]).score, 100);
  assert.equal(scoreEntry({ ...base, name: "pnpm-rule.md" }, ["pnpm"]).score, 60);
  assert.equal(scoreEntry({ ...base, name: "other.md" }, ["pnpm"]).score, 45); // 命中 title
  assert.equal(scoreEntry({ ...base, name: "other.md", title: "别的" }, ["包管理"]).score, 30);
  assert.equal(scoreEntry({ ...base, name: "other.md", title: "别的", description: "" }, ["装依赖"]).score, 15);
});

test("scoreEntry：AND 语义——任一关键词全无命中则不入选", () => {
  const entry = { name: "pnpm.md", title: "PNPM", description: "", body: "包管理器" };
  assert.notEqual(scoreEntry(entry, ["pnpm"]), null);
  assert.equal(scoreEntry(entry, ["pnpm", "完全不存在"]), null);
  // 两个词都命中时分数累加（都落在有用字段上）
  const both = scoreEntry(entry, ["pnpm", "包管理"]);
  assert.equal(both.score, 100 + 15);
  assert.deepEqual([...new Set(both.hits)].sort(), ["body", "name"]);
});

test("snippetOf：正文命中处取片段并加省略号；无命中取开头", () => {
  const body = `${"前".repeat(300)}关键片段${"后".repeat(300)}`;
  const snip = snippetOf(body, ["关键片段"], 60);
  assert.match(snip, /关键片段/);
  assert.ok(snip.startsWith("…"), "命中点前有省略号");
  const noHit = snippetOf("很短的一段正文", ["不存在"], 60);
  assert.ok(!noHit.includes("…") || noHit.length > 0);
  assert.equal(snippetOf("", ["x"]), "");
});

test("searchMemory：跨全局与项目、按分数排序、AND 语义、limit 生效", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-search-"));
  try {
    const globalDir = categoryDir(root, "work-profile");
    mkdirSync(globalDir, { recursive: true });
    entryFile(globalDir, "pnpm-rule.md", {
      title: "PNPM 铁律",
      description: "装依赖只用 pnpm",
      body: "禁止 npm install。",
    });
    entryFile(globalDir, "npm-legacy.md", {
      title: "旧 npm 说明",
      description: "历史遗留",
      body: "以前用 npm，现已废弃。",
    });

    const projectDir = join(root, "projects", "demo-0123456789abcdef", "memory");
    mkdirSync(projectDir, { recursive: true });
    entryFile(projectDir, "deploy.md", {
      title: "部署端口",
      description: "服务监听端口",
      body: "开发环境端口 3000。",
    });
    // 索引文件必须被排除（它不是条目）
    writeFileSync(join(projectDir, "MEMORY.md"), "- [部署](deploy.md) — 服务监听端口\n");

    const hit = searchMemory(root, "pnpm", { projectMemoryDir: projectDir });
    assert.equal(hit.total, 1, "只有 pnpm-rule 命中 pnpm");
    assert.equal(hit.results[0].name, "pnpm-rule.md");
    assert.equal(hit.results[0].scope, "global:work-profile");

    // 两个词都要命中：pnpm + 端口 分散在两个范围 → 无单条同时含两词 → 空
    const none = searchMemory(root, "pnpm 端口", { projectMemoryDir: projectDir });
    assert.equal(none.total, 0);

    // 只查项目侧：pnpm 在全局，应查不到
    const projOnly = searchMemory(root, "pnpm", { projectMemoryDir: projectDir, includeGlobal: false });
    assert.equal(projOnly.total, 0);

    // 项目侧命中：端口
    const port = searchMemory(root, "端口", { projectMemoryDir: projectDir, includeGlobal: false });
    assert.equal(port.total, 1);
    assert.equal(port.results[0].scope, "project");

    // limit 生效且 truncated 如实
    const limited = searchMemory(root, "端口", { projectMemoryDir: projectDir, limit: 1 });
    assert.equal(limited.results.length, 1);

    // 索引文件不进结果（否则每个查询都会命中 MEMORY.md）
    const indexish = searchMemory(root, "服务监听", { projectMemoryDir: projectDir });
    assert.ok(indexish.results.every((r) => r.name !== "MEMORY.md"), "MEMORY.md 不该作为条目出现");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("searchMemory：空查询/空存储根 → 空结果不抛", () => {
  assert.deepEqual(searchMemory("", "x").results, []);
  assert.deepEqual(searchMemory("/nonexistent-root-xyz", "").results, []);
  assert.equal(searchMemory("/nonexistent-root-xyz", "x").total, 0);
});

// 字面检索的承诺是「打出来就找得到」：正文用全角/NFD 写，用户用半角/NFC 查必须命中。
// 两侧同口径折叠（NFKC + 大小写），但片段要按原文切——不能把用户的正文改写后显示出来。
test("searchMemory：全角正文与半角查询互通，片段保留原文", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-nfkc-"));
  try {
    const dir = categoryDir(root, "user-profile");
    mkdirSync(dir, { recursive: true });
    entryFile(dir, "pkg.md", { title: "包管理器", body: "我们用 ＰＮＰＭ 管理依赖，装完就行。" });
    const half = searchMemory(root, "pnpm");
    assert.equal(half.total, 1, "正文全角 ＰＮＰＭ 必须能被半角 pnpm 查到");
    assert.match(half.results[0].snippet, /ＰＮＰＭ/, "片段取原文，不得显示被折叠改写的正文");
    assert.equal(searchMemory(root, "ＰＮＰＭ").total, 1, "反过来查全角也要命中");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("searchMemory：NFD 正文与 NFC 查询互通（组合字符）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-nfc-"));
  try {
    const dir = categoryDir(root, "user-profile");
    mkdirSync(dir, { recursive: true });
    entryFile(dir, "cafe.md", { title: "咖啡", body: "店名 cafe\u0301 nordic" }); // 正文是 NFD
    assert.equal(searchMemory(root, "caf\u00e9").total, 1, "NFC 查询必须命中 NFD 正文");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 片段定位必须能穿过「整串折叠会合并相邻字素」的漂移。
// 韩文兼容字母 ㄱ+ㅏ 在 Segmenter 眼里是两个字素，整串 NFKC 后合成一个 가，
// 重复 N 次偏差就累积 N 个字符——邻域搜索修不了，片段会从正文开头开始、
// 命中词完全不在里面（等于没定位）。
test("snippetOf：相邻字素被 NFKC 合并时仍能定位到命中处（不累积漂移）", () => {
  const cases = [
    ["ㄱㅏ".repeat(2000) + "缓存装置", "缓存"],
    ["가ㄳ".repeat(2000) + "缓存装置", "缓存"],
    ["가".repeat(2000) + "缓存装置", "缓存"],
    ["ｶﾞ".repeat(2000) + "缓存装置", "缓存"],
    ["😀".repeat(2000) + "缓存装置", "缓存"],
  ];
  for (const [body, term] of cases) {
    const snip = snippetOf(body, [term], 60);
    assert.ok(
      snip.normalize("NFKC").toLowerCase().includes(term.normalize("NFKC").toLowerCase()),
      `片段必须包含命中词（${term}），实际：…${snip.slice(-30)}`,
    );
  }
});

// 导出函数的契约：任何 max 下都不得切出孤立代理（渲染成 U+FFFD）。
test("snippetOf：任意 max（含 0 与负数）都不产生孤立代理", () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const body = `😀😀 pnpm ${"😀".repeat(20)}`;
  for (let max = -12; max <= 40; max += 1) {
    const snip = snippetOf(body, ["pnpm"], max);
    assert.ok(!lone.test(snip), `max=${max} 切出孤立代理：${JSON.stringify(snip)}`);
  }
});

test("listMemoryEntries：按 mtime 倒序，含索引文件排除与 truncated", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-list-"));
  try {
    const dir = categoryDir(root, "user-profile");
    mkdirSync(dir, { recursive: true });
    entryFile(dir, "a.md", { title: "A", body: "一" });
    entryFile(dir, "b.md", { title: "B", body: "二" });
    writeFileSync(join(dir, "MEMORY.md"), "- [A](a.md) — x\n");
    const out = listMemoryEntries(root, { limit: 10 });
    assert.equal(out.total, 2, "MEMORY.md 不计入");
    assert.equal(out.entries.length, 2);
    assert.equal(out.truncated, false);

    const capped = listMemoryEntries(root, { limit: 1 });
    assert.equal(capped.entries.length, 1);
    assert.equal(capped.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 跨分类列表：语义是「最近的条目」，不能在目录内提前截断——
// CATEGORY_IDS 顺序会让第一个分类灌满 cap，用户在后面分类刚写的条目永远不出现。
test("listMemoryEntries：跨分类按 mtime 取最近，不被第一个分类灌满", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-list-x-"));
  try {
    const work = categoryDir(root, "work-profile");
    const user = categoryDir(root, "user-profile");
    mkdirSync(work, { recursive: true });
    mkdirSync(user, { recursive: true });
    // work-profile（CATEGORY_IDS 靠前）塞 30 条旧条目
    const old = new Date("2026-01-01T00:00:00Z");
    for (let i = 0; i < 30; i++) {
      const p = join(work, `w${i}.md`);
      entryFile(work, `w${i}.md`, { title: `W${i}`, body: "旧" });
      utimesSync(p, old, old);
    }
    // user-profile（靠后）一条最新
    entryFile(user, "u-newest.md", { title: "最新", description: "最新写入", body: "新" });
    const newestPath = join(user, "u-newest.md");
    utimesSync(newestPath, new Date(), new Date());

    const out = listMemoryEntries(root, { limit: 10 });
    assert.equal(out.entries.length, 10);
    assert.equal(out.entries[0].name, "u-newest.md", "最新条目必须排在首位");
    assert.equal(out.entries[0].category, "user-profile");
    assert.equal(out.total, 31, "total 数全量，不受 cap 影响");
    assert.equal(out.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 排序只需要 mtime：不能为了列 20 条去把几千个文件的正文全读一遍。// 判据不用绝对耗时（CI 慢机会抖），而是同一批数据上「列 10 条」必须明显快于
// 「把全部正文读一遍」——后者用 searchMemory 一个必定命中的查询来近似。
test("listMemoryEntries：只读入选的 top-N，不读全量正文", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-listperf-"));
  try {
    const dir = categoryDir(root, "work-profile");
    mkdirSync(dir, { recursive: true });
    const body = "正文".repeat(400); // 每条 ~800 字符
    for (let i = 0; i < 800; i += 1) {
      entryFile(dir, `e${String(i).padStart(4, "0")}.md`, { title: `条目 ${i}`, description: "d", body });
    }
    const t0 = Date.now();
    const out = listMemoryEntries(root, { limit: 10 });
    const listMs = Date.now() - t0;
    assert.equal(out.entries.length, 10);
    assert.equal(out.total, 800, "total 仍是全量条目数");

    const t1 = Date.now();
    searchMemory(root, "正文", { limit: 10 }); // 必须读全部正文才能打分
    const fullScanMs = Math.max(1, Date.now() - t1);
    // 只 stat 的路径应当明显快于全量读正文（留 2 倍余量吸收抖动）。
    assert.ok(listMs * 2 < fullScanMs, `列 10 条 ${listMs}ms vs 全量扫描 ${fullScanMs}ms——疑似退化成全量读正文`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 扫描上限是**每目录**的，不是全局：被扫满时要如实说「没扫全」，
// 不能只说「因 limit 截断」——后者会让用户以为排序覆盖了所有条目。
test("listMemoryEntries：目录被扫满时如实回报 scanTruncated", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-scancap-"));
  try {
    const dir = categoryDir(root, "work-profile");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < SEARCH_SCAN_MAX_FILES + 5; i += 1) {
      writeFileSync(join(dir, `f${String(i).padStart(5, "0")}.md`), "---\ntitle: t\n---\nb\n");
    }
    const out = listMemoryEntries(root, { limit: 10 });
    assert.equal(out.scanTruncated, true, "目录被扫满必须显式回报");
    assert.equal(out.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 符号链接目录不得被跟随：跨平台分发时 Linux/macOS 的 symlink 目录
// isDirectory() 为 true，会递归到 storageRoot 之外。
test("searchMemory：符号链接目录不跟随（防越界读）", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "dsh-keepsake-outside-"));
  try {
    entryFile(outside, "leak.md", { title: "外部", description: "机密", body: "TOPSECRETSYMLINK" });
    const dir = categoryDir(root, "work-profile");
    mkdirSync(dir, { recursive: true });
    entryFile(dir, "ok.md", { title: "正常", body: "普通内容" });
    try {
      symlinkSync(outside, join(dir, "linkdir"), "dir");
    } catch (error) {
      // Windows 无权限建 symlink 时跳过（CI/受限环境），不算失败
      t.skip(`本环境无法创建符号链接：${error.code}`);
      return;
    }
    const out = searchMemory(root, "TOPSECRETSYMLINK");
    assert.equal(out.total, 0, "storageRoot 外的文件不得被检索到");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

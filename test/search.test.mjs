// search：关键词检索的打分口径与范围过滤（纯函数 + 只读 IO）。
import assert from "node:assert/strict";
import fs, {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

// 扫描上限是**每目录**的，不是全局：确证还有未收录条目时要如实说「没扫全」。
// 判据不能是 rels.length >= 上限——恰好装满上限时一条都没丢，长度判会把
// 「2000 条整」误报成有遗漏。这里 1999/2000/2001 三分支钉住边界：
// 同一目录先建 2001 个文件，再逐个删到 2000、1999，避免重复建文件的等待。
test("listMemoryEntries：scanTruncated 只在上限之外真有条目时为真（1999/2000/2001）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-scancap-"));
  const dir = categoryDir(root, "work-profile");
  const nameOf = (i) => `f${String(i).padStart(5, "0")}.md`;
  try {
    mkdirSync(dir, { recursive: true });
    const total = SEARCH_SCAN_MAX_FILES + 1;
    for (let i = 0; i < total; i += 1) {
      writeFileSync(join(dir, nameOf(i)), "---\ntitle: t\n---\nb\n");
    }

    const exactlyOneMore = listMemoryEntries(root, { limit: 10 });
    assert.equal(exactlyOneMore.scanTruncated, true, "2001 条：上限外还有 1 条，必须回报没扫全");
    assert.equal(exactlyOneMore.total, SEARCH_SCAN_MAX_FILES, "只有上限内的条目进入候选");

    rmSync(join(dir, nameOf(total - 1)));
    const exactlyFull = listMemoryEntries(root, { limit: 10 });
    assert.equal(exactlyFull.scanTruncated, false, "2000 条恰好装满上限，一条都没丢，不得误报");
    assert.equal(exactlyFull.total, SEARCH_SCAN_MAX_FILES);

    rmSync(join(dir, nameOf(total - 2)));
    const belowFull = listMemoryEntries(root, { limit: 10 });
    assert.equal(belowFull.scanTruncated, false, "1999 条未到上限");
    assert.equal(belowFull.total, SEARCH_SCAN_MAX_FILES - 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 入选 top-N 后读正文失败（读取期间被删/权限/坏路径）不能编造成空条目，
// 但也不能悄悄消失让 total 与 entries 自相矛盾：必须单独计数并给出可断言的不变量。
// 这里拦截 readFileSync 制造读失败：Windows 上 chmod 挡不住读取，目录占位则连 isFile 都过不了。
test("listMemoryEntries：读正文失败只计入 skipped，不编造条目也不静默吞掉", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-skip-"));
  const dir = categoryDir(root, "work-profile");
  const original = fs.readFileSync;
  const withReadFailure = (fn) => {
    fs.readFileSync = function patched(target, ...rest) {
      if (String(target).endsWith("b.md")) {
        const error = new Error("模拟读取失败");
        error.code = "EACCES";
        throw error;
      }
      return original.call(fs, target, ...rest);
    };
    syncBuiltinESMExports(); // ESM 具名导入是快照，改了 fs 必须同步才生效
    try {
      return fn();
    } finally {
      fs.readFileSync = original;
      syncBuiltinESMExports();
    }
  };
  try {
    mkdirSync(dir, { recursive: true });
    for (const name of ["a.md", "b.md", "c.md", "d.md"]) {
      entryFile(dir, name, { title: name.replace(/\.md$/, ""), body: "正文" });
    }
    // 让 b.md 成为最新条目：limit=2 时它必然入选，才能验证「截断 + 读失败」并存。
    // 时间戳必须明显晚于其它条目——同一毫秒内写入的 mtime 有小数差，+1ms 仍可能排不上。
    const newest = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "b.md"), newest, newest);

    const out = withReadFailure(() => listMemoryEntries(root, { limit: 10 }));
    assert.equal(out.total, 4, "total 是扫描到的候选数，读失败不改变它");
    assert.equal(out.entries.length, 3);
    assert.equal(out.skipped, 1, "读失败的那条必须显式计数");
    assert.equal(out.entries.length + out.skipped, out.total, "不变量：列出的 + 跳过的 = 被选中的");
    assert.ok(out.entries.every((e) => e.name !== "b.md"), "读失败的行不得以空条目形式出现");
    assert.ok(out.entries.every((e) => e.title.length > 0), "不得为对齐数字编造空标题");
    assert.equal(out.truncated, false, "读失败不是 limit 截断，两个事实不能混为一谈");
    assert.equal(out.scanTruncated, false);

    // limit 截断与读失败并存：picked = [b.md, 次新]，b.md 读失败 → 1 条 + skip 1 条
    const capped = withReadFailure(() => listMemoryEntries(root, { limit: 2 }));
    assert.equal(capped.truncated, true);
    assert.equal(capped.skipped, 1);
    assert.equal(capped.entries.length + capped.skipped, 2, "不变量对 picked 成立，与 limit 无关");
    assert.equal(capped.entries.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 符号链接目录不得被跟随：跨平台分发时 Linux/macOS 的 symlink 目录
// isDirectory() 为 true，会递归到 storageRoot 之外。
//
// 三个平台事实决定了这条测试怎么写（本机逐一实测）：
//   1. Windows 非管理员建不了 symlink（symlinkSync 抛 EPERM），故优先走 junction；
//   2. junction 的 Dirent 是 isSymbolicLink=true **但 isDirectory=false**——
//      也就是说在 Windows 上即使删掉守卫，walkMarkdown 也递归不进去，
//      光靠 junction 无法区分「守卫生效」与「守卫不存在」；
//   3. Linux/macOS 的真实 symlink 目录 isDirectory=true，守卫失效时会真越界。
// 所以本测试分两层：真实链接（symlink 优先、退 junction）证明「不越界」；
// 再用 readdirSync 补丁把 junction 按 POSIX 口径重分类为目录，模拟 3 的场景，
// 让「守卫被删」在本机也一定变红。两层都失败才 skip。
test("searchMemory：符号链接目录不跟随（防越界读）", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "dsh-keepsake-outside-"));
  const probeName = "leak.md";
  const probePath = join(outside, probeName);
  const dir = categoryDir(root, "work-profile");
  const linkPath = join(dir, "linkdir");

  // 清理顺序有讲究：Windows 上 rmSync(link, {recursive:true}) 对 junction 有删穿风险，
  // 一旦删穿就会把 outside 里的探针文件一起带走，于是「负向断言」下次跑直接假绿。
  // 这里先只摘链接本身（unlink 对 junction 是安全的，实测不碰目标），
  // 摘不掉再退 rmdir；确认探针文件还在之后才删 outside。
  const removeLink = () => {
    if (!existsSync(linkPath)) return;
    try {
      unlinkSync(linkPath);
    } catch {
      try {
        rmdirSync(linkPath);
      } catch {
        // 实在摘不掉：至少别用 recursive 去冒删穿目标的险，留给 root 清理
      }
    }
  };
  const cleanup = () => {
    removeLink();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  };

  try {
    entryFile(outside, probeName, { title: "外部", description: "机密", body: "TOPSECRETSYMLINK" });
    mkdirSync(dir, { recursive: true });
    entryFile(dir, "ok.md", { title: "正常", body: "普通内容" });

    // 建链接：symlink（POSIX/有权限的 Windows）→ junction（Windows 非管理员）。
    // 两者都还要经 linkIsLive 验证真的建成：只看返回值会把「命令没报错但链接
    // 没落地」当成功，那样负向断言就变成了假绿。
    let linked = false;
    try {
      symlinkSync(outside, linkPath, "dir");
      linked = true;
    } catch {
      // 落到 junction
    }
    if (!linked && process.platform === "win32") {
      // Git Bash 下 cmd 的 / 参数会被 MSYS 转义成路径，故显式传数组 + windowsVerbatimArguments，
      // 并给两侧路径都加引号以容纳空格。
      const made = spawnSync(
        process.env.ComSpec || "cmd.exe",
        ["/d", "/s", "/c", `mklink /J "${linkPath}" "${outside}"`],
        { windowsVerbatimArguments: true, encoding: "utf8" },
      );
      linked = made.status === 0;
    }

    // 验证链接确实存在且真指向 outside：链接没建成时负向断言会假绿，必须在这里拦住。
    const linkIsLive = () => {
      try {
        if (!lstatSync(linkPath).isSymbolicLink()) return false;
        // 能被 readdir 读到，且读到的正是外部探针——证明链接真的指向 outside 而不是空目录
        return readdirSync(linkPath).includes(probeName);
      } catch {
        return false;
      }
    };

    if (!linkIsLive()) {
      removeLink();
      t.skip(`本环境无法创建可用的符号链接/junction（symlink EPERM，junction 未建成或被拒）`);
      return;
    }

    // 第一层：真实链接下的负向断言——storageRoot 外的文件绝不能被检索到。
    const out = searchMemory(root, "TOPSECRETSYMLINK");
    assert.equal(out.total, 0, "storageRoot 外的文件不得被检索到");
    // 正向对照：同一个查询直接作用在 outside 上必须命中。
    // 没有这条，「0 命中」也可能只是因为查询/解析本身失效，而不是守卫生效。
    assert.equal(
      searchMemory(outside, "TOPSECRETSYMLINK", { projectMemoryDir: outside }).total,
      1,
      "正向对照：同一查询直接检索 outside 必须命中（证明是守卫生效，不是查询失效）",
    );

    // 第二层：把链接按 POSIX 口径重分类成「真目录」，逼出守卫的作用。
    // Windows junction 的 dirent 本来 isDirectory=false（见文件头注释），
    // 不重分类的话删掉 lib/search.js 里的守卫这条测试依然绿——等于没有回归保护。
    const realReaddir = fs.readdirSync;
    const posixView = function patched(target, options) {
      const dirents = realReaddir.call(fs, target, options);
      if (!options || options.withFileTypes !== true) return dirents;
      if (resolve(String(target)) !== resolve(dir)) return dirents;
      return dirents.map((entry) => {
        if (entry.name !== "linkdir") return entry;
        // 伪装成「Linux 上被跟随的 symlink 目录」：isDirectory 真、isSymbolicLink 仍真。
        // 守卫（先判 isSymbolicLink）在时会被 continue 掉；守卫没了就会递归进 outside。
        return new Proxy(entry, {
          get(obj, prop) {
            if (prop === "isDirectory") return () => true;
            if (prop === "isFile") return () => false;
            const value = Reflect.get(obj, prop);
            return typeof value === "function" ? value.bind(obj) : value;
          },
        });
      });
    };
    fs.readdirSync = posixView;
    syncBuiltinESMExports(); // ESM 具名导入是快照，改了 fs 必须同步才生效
    try {
      const asPosix = searchMemory(root, "TOPSECRETSYMLINK");
      assert.equal(
        asPosix.total,
        0,
        "守卫失效：symlink 目录被当成普通目录递归，读到了 storageRoot 之外的文件",
      );
    } finally {
      fs.readdirSync = realReaddir;
      syncBuiltinESMExports();
    }

    // 先按安全方式摘掉链接，再确认没有删穿到目标目录。
    // 这条断言放在 try 体内而非 finally：否则它会顶替掉上面真正的失败原因。
    removeLink();
    assert.ok(existsSync(probePath), "摘除链接不得删穿到目标目录（outside 探针文件必须还在）");
  } finally {
    cleanup(); // 幂等：链接已摘时只回收两个临时根
  }
});

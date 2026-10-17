// consolidation：记忆整理建议引擎（纯函数 / 确定性 / 零依赖 / 不动磁盘）
// 夹具全为合成数据（分类 id 取自 lib/global-store.js 的真实集合，正文与标题均为虚构）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditIndex,
  bigramJaccard,
  DEFAULT_STALE_DAYS,
  DUPLICATE_THRESHOLDS,
  findDuplicates,
  findStale,
  indexLineFile,
  normalizeBody,
  normalizeKey,
  planIndexRepair,
} from "../lib/consolidation.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1, 0, 0, 0); // 固定"现在"，测试不碰真实时钟

// —— 合成正文夹具（归一化后 bigram Jaccard 已实测钉住，见各用例注释）——
const BODY_BASE = "abcdefghijklmnopqrstuvwxyz"; // 26 字符 → 25 bigram
const BODY_ONE_CHANGE = "abcd0fghijklmnopqrstuvwxyz"; // 改 1 字符 → 0.8519（恰好 ≥ 0.85）
const BODY_TWO_CHANGES = "abc0efg1ijk2mno3qrstuvwxyz"; // 改 4 字符 → 0.5152（< 0.6）
const BODY_THREE_CHANGES = "abcd0fghijklmn1pqrstuv2xyz"; // 改 3 字符 → 0.6129（≥ 0.6 且 < 0.85）
const BODY_UNRELATED = "a0c1e2g3i4k5m6o7q8s9uvwxyz"; // 改 10 字符 → 0.1111

const entry = (name, category, body, extra = {}) => ({ name, category, title: name, body, ...extra });

/** 找出某一对（按 name 集合匹配，与顺序无关）。 */
function pairOf(pairs, a, b) {
  return pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a)) ?? null;
}

// ---- 1. 重复：信号①——跨分类同名 ----

test("findDuplicates：不同分类下同名命中（归一化：去空白+全半角+大小写）", () => {
  const pairs = findDuplicates([
    entry("deploy-notes.md", "work-profile", "甲正文：完全不同的内容一号。"),
    entry("Deploy-Notes.md", "long-term", "乙正文：完全不同的内容二号。"),
  ]);
  assert.equal(pairs.length, 1, "大小写归一后同名 → 命中");
  assert.deepEqual(
    { a: pairs[0].a, b: pairs[0].b },
    { a: "Deploy-Notes.md", b: "deploy-notes.md" },
    "a/b 按名字升序输出",
  );
  assert.match(pairs[0].why, /同一个名字/);
  assert.equal(pairs[0].score, 0.9);
});

test("findDuplicates：去空白归一（My Note.md ≡ MyNote.md）", () => {
  const pairs = findDuplicates([
    entry("MyNote.md", "work-profile", "甲正文：完全不同的一号。"),
    entry("My Note.md", "long-term", "乙正文：完全不同的二号。"),
  ]);
  assert.equal(normalizeKey("My Note.md"), normalizeKey("MyNote.md"));
  assert.equal(pairs.length, 1, "去空白后同名 → 命中");
  assert.match(pairs[0].why, /同一个名字/);
});

test("findDuplicates：全半角同名也归一（Ｎｏｔｅ．md ≡ note.md）", () => {
  const pairs = findDuplicates([
    entry("note.md", "work-profile", "甲正文 alpha。"),
    entry("Ｎｏｔｅ．md", "current-focus", "乙正文 beta。"),
  ]);
  assert.equal(pairs.length, 1, "全角名与半角名归一后同名 → 命中");
  assert.equal(normalizeKey("Ｎｏｔｅ．md"), normalizeKey("note.md"));
});

test("findDuplicates：同分类同名不算重复（落盘本就唯一，不打扰）", () => {
  const pairs = findDuplicates([
    entry("same-name.md", "work-profile", "甲正文：完全不同的一号。"),
    entry("same-name.md", "work-profile", "乙正文：完全不同的二号。"),
  ]);
  assert.equal(pairs.length, 0, "同一分类下同名不报——同目录文件名唯一，那是同一条");
});

test("findDuplicates：异名且正文无关 → 不命中", () => {
  const pairs = findDuplicates([
    entry("alpha-topic.md", "work-profile", "完全不同的正文甲，写的是安装路线的取舍。"),
    entry("beta-topic.md", "long-term", "完全不同的正文乙，写的是代码风格的取舍。"),
  ]);
  assert.equal(pairs.length, 0);
});

// ---- 2. 重复：信号②——正文近重复（阈值 0.85 上下各一）----

test("findDuplicates：正文完全相同 → 命中且分数最高", () => {
  const pairs = findDuplicates([
    entry("one.md", "work-profile", "同一段正文，一字不差地存了两遍。"),
    entry("two.md", "long-term", "同一段正文，一字不差地存了两遍。"),
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].score, 0.98);
  assert.match(pairs[0].why, /正文完全相同/);
});

test("findDuplicates：正文 Jaccard 0.8519（≥0.85）→ 命中", () => {
  const pairs = findDuplicates([
    entry("aaa.md", "work-profile", BODY_BASE),
    entry("bbb.md", "long-term", BODY_ONE_CHANGE),
  ]);
  assert.equal(bigramJaccard(BODY_BASE, BODY_ONE_CHANGE) >= DUPLICATE_THRESHOLDS.body, true, "夹具本身确实过线");
  assert.equal(bigramJaccard(BODY_BASE, BODY_ONE_CHANGE) < 0.86, true, "且确实贴近阈值下沿（0.8519）");
  assert.equal(pairs.length, 1, "0.8519 ≥ 0.85 → 报重复");
  assert.equal(pairs[0].score, 0.852);
  assert.match(pairs[0].why, /正文高度重叠/);
});

test("findDuplicates：正文 Jaccard 0.8462（<0.85）→ 不命中（阈值下沿）", () => {
  const base = "abcdefghijklmnopqrstuvwxy"; // 25 字符 → 24 bigram
  const changed = `${base.slice(0, 12)}0${base.slice(13)}`;
  const pairs = findDuplicates([
    entry("aaa.md", "work-profile", base),
    entry("bbb.md", "long-term", changed),
  ]);
  assert.equal(bigramJaccard(base, changed) < DUPLICATE_THRESHOLDS.body, true, "夹具本身确实不过线（0.8462）");
  assert.equal(pairs.length, 0, "差一点点也不报——宁可漏报也不打扰");
});

test("findDuplicates：正文差异很大（0.11）→ 不命中", () => {
  const pairs = findDuplicates([
    entry("aaa.md", "work-profile", BODY_BASE),
    entry("bbb.md", "long-term", BODY_UNRELATED),
  ]);
  assert.equal(pairs.length, 0);
});

// ---- 3. 重复：信号③——标题近重复且正文有重叠 ----

test("findDuplicates：标题近重复（0.87）且正文重叠 0.61 → 命中", () => {
  const pairs = findDuplicates([
    { name: "aaa.md", category: "work-profile", title: "deploy-pipeline-notes", body: BODY_BASE },
    { name: "bbb.md", category: "long-term", title: "deploy-pipeline-notes-v2", body: BODY_THREE_CHANGES },
  ]);
  assert.equal(bigramJaccard(BODY_BASE, BODY_THREE_CHANGES) >= 0.6, true, "正文重叠 0.6129 ≥ 0.6");
  assert.equal(bigramJaccard(BODY_BASE, BODY_THREE_CHANGES) < DUPLICATE_THRESHOLDS.body, true, "但未达正文近重复线");
  assert.equal(pairs.length, 1);
  assert.match(pairs[0].why, /标题相近/);
  assert.equal(pairs[0].score, 0.806); // 0.5 + 0.5 × 0.6129
});

test("findDuplicates：标题近重复但正文重叠不足（0.52 < 0.6）→ 不命中", () => {
  const pairs = findDuplicates([
    { name: "aaa.md", category: "work-profile", title: "deploy-pipeline-notes", body: BODY_BASE },
    { name: "bbb.md", category: "long-term", title: "deploy-pipeline-notes-v2", body: BODY_TWO_CHANGES },
  ]);
  assert.equal(bigramJaccard(BODY_BASE, BODY_TWO_CHANGES) < DUPLICATE_THRESHOLDS.overlap, true, "正文重叠 0.5152 < 0.6");
  assert.equal(pairs.length, 0, "只是标题像、内容各说各的 → 不报");
});

test("findDuplicates：标题近重复但正文毫无重叠 → 不命中", () => {
  const pairs = findDuplicates([
    { name: "aaa.md", category: "work-profile", title: "deploy-pipeline-notes", body: "甲正文：站会安排与看板纪律。" },
    { name: "bbb.md", category: "long-term", title: "deploy-pipeline-notes-v2", body: "乙正文：依赖安装与镜像路线。" },
  ]);
  assert.equal(pairs.length, 0);
});

// ---- 4. 重复：配对纪律与排序 ----

test("findDuplicates：不自我配对、同一对只报一次", () => {
  const one = entry("solo.md", "work-profile", "只有一条，正文再长也不和自己比。");
  assert.deepEqual(findDuplicates([one]), [], "单条目不自我配对");
  assert.deepEqual(findDuplicates([one, one]), [], "同一条被传两遍也不自我配对");

  const pairs = findDuplicates([
    entry("aaa.md", "work-profile", "同一段正文，存了两遍。"),
    entry("bbb.md", "long-term", "同一段正文，存了两遍。"),
    entry("ccc.md", "current-focus", "同一段正文，存了两遍。"),
  ]);
  assert.equal(pairs.length, 3, "三条两两配对共 3 对");
  const keys = pairs.map((p) => `${p.a}|${p.b}`);
  assert.equal(new Set(keys).size, 3, "同一对不重复报");
  for (const p of pairs) assert.notEqual(p.a, p.b, "绝不与自己配对");
});

test("findDuplicates：稳定排序（分数降序 + 同分按名字升序）", () => {
  const pairs = findDuplicates([
    entry("zzz.md", "work-profile", "同一段正文，存了两遍。"), // 0.98
    entry("mmm.md", "long-term", "同一段正文，存了两遍。"), // 0.98
    entry("aaa.md", "work-profile", BODY_BASE), // 与 bbb 0.852
    entry("bbb.md", "current-focus", BODY_ONE_CHANGE),
  ]);
  const expected = [
    "mmm.md|zzz.md", // 0.98，同分按名字升序
    "aaa.md|bbb.md", // 0.852
  ];
  assert.deepEqual(pairs.map((p) => `${p.a}|${p.b}`), expected);
  for (let i = 1; i < pairs.length; i += 1) {
    assert.equal(pairs[i - 1].score >= pairs[i].score, true, "分数不递增");
  }
});

test("findDuplicates：自身顺序打乱不影响输出（确定性）", () => {
  const list = [
    entry("aaa.md", "work-profile", BODY_BASE),
    entry("bbb.md", "long-term", BODY_ONE_CHANGE),
    entry("ccc.md", "work-profile", "同一段正文，存了两遍。"),
    entry("ddd.md", "current-focus", "同一段正文，存了两遍。"),
  ];
  const forward = findDuplicates(list);
  const reversed = findDuplicates([...list].reverse());
  assert.deepEqual(forward, reversed, "输入顺序不影响结果");
});

test("findDuplicates：脏输入不炸（null / 缺字段 / 空正文）", () => {
  assert.deepEqual(findDuplicates([]), []);
  assert.deepEqual(findDuplicates(null), []);
  assert.deepEqual(findDuplicates([null, { name: "x.md" }, { name: "y.md", category: "work-profile" }]), [], "空正文不冒充重复");
  assert.deepEqual(findDuplicates([{ name: "x.md", category: "a", body: "" }, { name: "y.md", category: "b", body: "" }]), [], "两边都空 → 不算相似");
});

// ---- 5. 陈旧提醒 ----

test("findStale：超阈值的报出来、天数取整、按天数降序", () => {
  const stale = findStale(
    [
      { name: "old.md", category: "work-profile", mtimeMs: NOW - 200 * DAY },
      { name: "older.md", category: "long-term", mtimeMs: NOW - 400 * DAY },
      { name: "fresh.md", category: "current-focus", mtimeMs: NOW - 10 * DAY },
    ],
    { nowMs: NOW },
  );
  assert.deepEqual(stale.map((s) => s.name), ["older.md", "old.md"], "只报超阈值的，且按天数降序");
  assert.equal(stale[0].days, 400);
  assert.equal(stale[1].days, 200);
  assert.equal(stale[0].kind, "stale");
  assert.equal(stale[0].category, "long-term");
  assert.equal(typeof stale[0].lastModifiedAt, "string", "给出 ISO 时间，便于面板展示");
});

test("findStale：边界——刚好 90 天算陈旧，89 天不算", () => {
  const exact = findStale([{ name: "e.md", category: "work-profile", mtimeMs: NOW - 90 * DAY }], { nowMs: NOW });
  assert.equal(exact.length, 1, "≥ 阈值 → 提醒");
  assert.equal(exact[0].days, 90);
  const justUnder = findStale([{ name: "j.md", category: "work-profile", mtimeMs: NOW - 89 * DAY }], { nowMs: NOW });
  assert.equal(justUnder.length, 0, "差一天不提醒");
  assert.equal(DEFAULT_STALE_DAYS, 90, "默认阈值 90 天");
});

test("findStale：自定义 olderThanDays 生效", () => {
  const list = [{ name: "s.md", category: "work-profile", mtimeMs: NOW - 40 * DAY }];
  assert.equal(findStale(list, { nowMs: NOW, olderThanDays: 30 }).length, 1, "阈值 30 天 → 40 天算陈旧");
  assert.equal(findStale(list, { nowMs: NOW, olderThanDays: 60 }).length, 0, "阈值 60 天 → 40 天不算");
});

test("findStale：mtime 缺失/非法 → 单列 unknown-age，不冒充天数", () => {
  const stale = findStale(
    [
      { name: "no-mtime.md", category: "work-profile" },
      { name: "nan.md", category: "long-term", mtimeMs: Number.NaN },
      { name: "zero.md", category: "current-focus", mtimeMs: 0 },
      { name: "negative.md", category: "user-profile", mtimeMs: -5 },
      { name: "string.md", category: "recent-activity", mtimeMs: "昨天" },
      { name: "genuine.md", category: "work-profile", mtimeMs: NOW - 100 * DAY },
    ],
    { nowMs: NOW },
  );
  const unknown = stale.filter((s) => s.kind === "unknown-age");
  assert.equal(unknown.length, 5, "五种非法/缺失形态全部单列");
  for (const u of unknown) {
    assert.equal(u.days, null, "不拿 0 或当前时间冒充天数");
    assert.equal(u.lastModifiedAt, null);
  }
  assert.equal(stale[0].name, "genuine.md", "能算出年龄的排在前面");
  assert.equal(stale[stale.length - 1].kind, "unknown-age", "年龄未知的垫底");
  assert.deepEqual(unknown.map((u) => u.name), ["nan.md", "negative.md", "no-mtime.md", "string.md", "zero.md"], "未知组内按名字升序");
});

test("findStale：mtime 在未来（时钟倒挂）不报陈旧", () => {
  const stale = findStale([{ name: "future.md", category: "work-profile", mtimeMs: NOW + 30 * DAY }], { nowMs: NOW });
  assert.equal(stale.length, 0, "负天数不是「陈旧」，不谎报年龄");
});

test("findStale：只提醒不删——输出里没有任何删除语义", () => {
  const stale = findStale([{ name: "old.md", category: "work-profile", mtimeMs: NOW - 365 * DAY }], { nowMs: NOW });
  assert.deepEqual(Object.keys(stale[0]).sort(), ["category", "days", "kind", "lastModifiedAt", "name"]);
  assert.equal("delete" in stale[0], false);
  assert.equal("action" in stale[0], false);
});

// ---- 6. 索引对账 ----

test("auditIndex：悬挂行（索引有、磁盘无）", () => {
  const audit = auditIndex([
    {
      category: "work-profile",
      lines: ["- [老条目](gone.md) — 文件已被移走", "- [在条目](alive.md) — 文件还在"],
      files: ["alive.md", "MEMORY.md"],
    },
  ]);
  assert.equal(audit.dangling.length, 1);
  assert.equal(audit.dangling[0].category, "work-profile");
  assert.equal(audit.dangling[0].name, "gone.md", "推断出的文件名");
  assert.equal(audit.dangling[0].line, "- [老条目](gone.md) — 文件已被移走", "保留行原文，便于直接删这一行");
  assert.equal(audit.orphans.length, 0);
  assert.deepEqual(audit.emptyCategories, []);
});

test("auditIndex：漏登记（磁盘有、索引无）", () => {
  const audit = auditIndex([
    {
      category: "long-term",
      lines: ["- [已登记](indexed.md) — 有索引行"],
      files: ["indexed.md", "forgotten.md", "MEMORY.md"],
    },
  ]);
  assert.equal(audit.orphans.length, 1);
  assert.deepEqual({ category: audit.orphans[0].category, name: audit.orphans[0].name }, { category: "long-term", name: "forgotten.md" });
  assert.equal(audit.dangling.length, 0, "索引文件本身不算悬挂");
  assert.deepEqual(audit.emptyCategories, [], "有条目就不是空分类");
});

test("auditIndex：空分类（有索引但零条目）", () => {
  const audit = auditIndex([
    { category: "current-focus", lines: [], files: ["MEMORY.md"] },
    { category: "user-profile", lines: ["- [标题](a.md) — 钩子"], files: ["a.md"] },
  ]);
  assert.deepEqual(audit.emptyCategories, ["current-focus"], "只剩索引文件的分类算空");
  assert.deepEqual(audit.emptyCategories.includes("user-profile"), false);
});

test("auditIndex：三类问题可以同盘共存且各自独立", () => {
  const audit = auditIndex([
    { category: "work-profile", lines: ["- [悬挂](gone.md) — 没了", "- [正常](ok.md) — 在的"], files: ["ok.md", "orphan.md", "MEMORY.md"] },
    { category: "recent-activity", lines: [], files: ["MEMORY.md"] },
  ]);
  assert.equal(audit.dangling.length, 1);
  assert.equal(audit.orphans.length, 1);
  assert.deepEqual(audit.emptyCategories, ["recent-activity"]);
});

test("auditIndex：行→文件名推断与 lib/manifest.js 同口径（去空白/反斜杠/小写）", () => {
  assert.equal(indexLineFile("- [标题](My Note.md) — 钩子"), "my note.md");
  assert.equal(indexLineFile("- [标题](sub\\dir\\X.MD) — 钩子"), "sub/dir/x.md");
  assert.equal(indexLineFile("### 分类标题"), null, "非索引行返回 null，不参与对账");
  assert.equal(indexLineFile(""), null);
  assert.equal(indexLineFile("随便一句说明文字"), null);
  // 四种分隔符（em-dash / 连字符 / 冒号 / en-dash）都能识别
  for (const sep of ["—", "-", ":", "–"]) {
    assert.equal(indexLineFile(`- [标题](a.md) ${sep} 钩子`), "a.md", `分隔符 ${sep} 可识别`);
  }
  // 磁盘名大小写/斜杠差异：索引行与磁盘清单归一后能对上，不算悬挂
  const audit = auditIndex([{ category: "work-profile", lines: ["- [标题](Sub\\Named.md) — 钩子"], files: ["sub/named.md"] }]);
  assert.equal(audit.dangling.length, 0);
  assert.equal(audit.orphans.length, 0);
});

test("auditIndex：脏输入不炸，重复行/空行不重复报", () => {
  assert.deepEqual(auditIndex([]), { dangling: [], orphans: [], emptyCategories: [] });
  assert.deepEqual(auditIndex(null), { dangling: [], orphans: [], emptyCategories: [] });
  const audit = auditIndex([
    { category: "work-profile", lines: ["- [重复](dup.md) — 第一次", "- [重复](dup.md) — 第二次", "", "### 标题"], files: ["MEMORY.md"] },
  ]);
  assert.equal(audit.dangling.length, 1, "同名重复行只留首行，不重复报");
  assert.equal(audit.dangling[0].line, "- [重复](dup.md) — 第一次");
});

// ---- 7. 修复计划 ----

test("planIndexRepair：删悬挂行 + 补漏行，且绝不含删条目文件的动作", () => {
  const audit = auditIndex([
    { category: "work-profile", lines: ["- [悬挂](gone.md) — 没了", "- [正常](ok.md) — 在的"], files: ["ok.md", "orphan.md", "MEMORY.md"] },
  ]);
  const plan = planIndexRepair(audit);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], { type: "remove-line", category: "work-profile", line: "- [悬挂](gone.md) — 没了" });
  assert.deepEqual(plan[1], { type: "add-line", category: "work-profile", name: "orphan.md", title: "orphan" });
  // 只出现这两种动作；任何删除文件的语义都不许出现
  for (const op of plan) assert.ok(op.type === "remove-line" || op.type === "add-line");
  for (const op of plan) {
    assert.equal(typeof op.category, "string");
    if (op.type === "remove-line") assert.equal("name" in op, false, "删行不携带文件名，避免被当成删文件");
  }
  const serialized = JSON.stringify(plan);
  assert.equal(/\b(delete|rm|unlink|remove-file)\b/.test(serialized), false, "计划里不出现删除文件的动作名");
});

test("planIndexRepair：幂等——已对上账的状态返回空计划", () => {
  const healthy = auditIndex([
    { category: "work-profile", lines: ["- [甲](a.md) — 钩子甲", "- [乙](b.md) — 钩子乙"], files: ["a.md", "b.md", "MEMORY.md"] },
  ]);
  assert.deepEqual(planIndexRepair(healthy), [], "已对账 → 空计划");
  assert.deepEqual(planIndexRepair({ dangling: [], orphans: [], emptyCategories: [] }), []);

  // 修一遍之后再对账（模拟执行计划后的状态）→ 仍是空计划
  const broken = auditIndex([
    { category: "long-term", lines: ["- [悬挂](gone.md) — 没了", "- [正常](ok.md) — 在的"], files: ["ok.md", "orphan.md", "MEMORY.md"] },
  ]);
  const plan = planIndexRepair(broken);
  const after = auditIndex([
    {
      category: "long-term",
      lines: ["- [正常](ok.md) — 在的", "- [新增](orphan.md) — 钩子"], // 悬挂行已删、漏行已补
      files: ["ok.md", "orphan.md", "MEMORY.md"],
    },
  ]);
  assert.deepEqual(planIndexRepair(after), [], "修完后再对账 → 空计划（幂等）");
  assert.equal(plan.length, 2, "上一轮确实给出了修复动作");
});

test("planIndexRepair：幂等——同一份对账结果两次调用逐字节相同", () => {
  const audit = auditIndex([
    { category: "work-profile", lines: ["- [x](gone-a.md) — 甲", "- [y](gone-b.md) — 乙", "- [z](ok.md) — 丙"], files: ["ok.md", "orphan-b.md", "orphan-a.md", "MEMORY.md"] },
  ]);
  assert.equal(JSON.stringify(planIndexRepair(audit)), JSON.stringify(planIndexRepair(audit)));
  assert.deepEqual(planIndexRepair(audit).map((o) => o.type), ["remove-line", "remove-line", "add-line", "add-line"], "先删后补");
  assert.deepEqual(planIndexRepair(audit).filter((o) => o.type === "add-line").map((o) => o.name), ["orphan-a.md", "orphan-b.md"], "补行按文件名升序");
  assert.deepEqual(planIndexRepair(audit).filter((o) => o.type === "remove-line").map((o) => o.name ?? o.line), ["- [x](gone-a.md) — 甲", "- [y](gone-b.md) — 乙"], "删行按行原文升序");
});

test("planIndexRepair：脏输入不炸，重复项去重", () => {
  assert.deepEqual(planIndexRepair(null), []);
  assert.deepEqual(planIndexRepair({}), []);
  const plan = planIndexRepair({
    dangling: [
      { category: "work-profile", line: "- [a](dup.md) — 甲", name: "dup.md" },
      { category: "work-profile", line: "- [a](dup.md) — 甲", name: "dup.md" },
      { category: "work-profile", line: "", name: "" },
    ],
    orphans: [
      { category: "work-profile", name: "same.md" },
      { category: "work-profile", name: "same.md" },
      { category: "work-profile", name: "MEMORY.md" }, // 索引文件本身不许被当成漏登记条目
      { category: "work-profile", name: "  " },
    ],
    emptyCategories: [],
  });
  assert.deepEqual(plan.map((o) => `${o.type}:${o.name ?? o.line}`), ["remove-line:- [a](dup.md) — 甲", "add-line:same.md"]);
});

// ---- 8. 确定性：同输入两次输出逐字节相同 ----

test("确定性：四个函数同输入两次调用输出逐字节相同", () => {
  const entries = [
    { name: "aaa.md", category: "work-profile", title: "甲标题", body: "甲正文：依赖安装路线。", mtimeMs: NOW - 200 * DAY },
    { name: "bbb.md", category: "long-term", title: "乙标题", body: "乙正文：依赖安装路线。", mtimeMs: NOW - 100 * DAY },
    { name: "ccc.md", category: "current-focus", title: "丙标题", body: "丙正文：完全不同的主题。", mtimeMs: 0 },
  ];
  const indexStatus = [
    { category: "work-profile", lines: ["- [甲](aaa.md) — 钩子甲", "- [丢](gone.md) — 钩子丢"], files: ["aaa.md", "orphan.md", "MEMORY.md"] },
    { category: "long-term", lines: ["- [乙](bbb.md) — 钩子乙"], files: ["bbb.md", "MEMORY.md"] },
  ];
  const snapshot = JSON.stringify({
    dup: findDuplicates(entries),
    stale: findStale(entries, { nowMs: NOW }),
    audit: auditIndex(indexStatus),
  });
  const again = JSON.stringify({
    dup: findDuplicates(entries),
    stale: findStale(entries, { nowMs: NOW }),
    audit: auditIndex(indexStatus),
  });
  assert.equal(snapshot, again, "两次结果逐字节相同");
  assert.equal(JSON.stringify(planIndexRepair(auditIndex(indexStatus))), JSON.stringify(planIndexRepair(auditIndex(indexStatus))));
});

// ---- 9. 归一化与相似度基础 ----

test("归一化：空白/全半角/大小写/控制符剥除", () => {
  assert.equal(normalizeKey("My  Note.MD"), normalizeKey("my note.md"));
  assert.equal(normalizeKey("Ｎｏｔｅ．ｍｄ"), normalizeKey("note.md"));
  assert.equal(normalizeKey("  "), "");
  assert.equal(normalizeKey(null), "");
  assert.equal(normalizeKey("bad\u200bname.md"), normalizeKey("badname.md"), "零宽字符剥除");
  assert.equal(normalizeBody("　全角　空格　"), "全角空格", "表意空格归一后按空白去掉");
  assert.equal(normalizeBody("---\nname: \"x\"\n---\n\n真正正文"), "真正正文", "frontmatter 不参与正文比对");
  assert.equal(normalizeBody(null), "");
});

test("bigramJaccard：对称性、自比 1、空值 0", () => {
  assert.equal(bigramJaccard(BODY_BASE, BODY_ONE_CHANGE), bigramJaccard(BODY_ONE_CHANGE, BODY_BASE), "对称");
  assert.equal(bigramJaccard(BODY_BASE, BODY_BASE), 1, "与自己比 = 1");
  assert.equal(bigramJaccard("", ""), 0, "两边都空不是相似的证据");
  assert.equal(bigramJaccard("", "有内容"), 0);
  assert.equal(bigramJaccard("短", "短"), 0, "单字符无法成 bigram，不冒充相似");
});

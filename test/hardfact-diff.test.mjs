// hardfact-diff（判据）：269→267 检出、346→412 不误报、frontmatter/日期/倒计时/索引行排除。
// 判据在 lib/hardfact.js（token 带类型 + hybrid 近值判据；禁止裸 Set 差集）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { diffHardFacts, extractHardFacts, isNearMiss, scrubDynamicText, unifiedDiffSnippet } from "../lib/hardfact.js";
import { hardfactWritebackReport } from "../lib/safety.js";

const droppedValues = (oldText, newText) => diffHardFacts(oldText, newText).dropped.map((d) => `${d.type}:${d.value}`);
const report = (oldText, newText) => hardfactWritebackReport(oldText, newText);

// ---- 固定用例（规格点名，必须成立）----

test("269→267 检出（近似替换 = 誊写错误签名）", () => {
  const oldText = "上个月统计有 269 个文件需要处理。";
  const newText = "上个月统计有 267 个文件需要处理。";
  const dropped = droppedValues(oldText, newText);
  assert.deepEqual(dropped, ["number:269"]);
  const { dropped: d2 } = diffHardFacts(oldText, newText);
  assert.equal(d2[0].reason, "near-miss");
  // 经 safety 封装同样成立，并附 diff 片段
  const rep = report(oldText, newText);
  assert.equal(rep.dropped.length, 1);
  assert.ok(rep.diff.length > 0);
  assert.ok(rep.diff.length <= 2048 + 40); // ≤2KB（含截断标记余量）
});

test("346→412 不误报（远值替换 = 有意更新）", () => {
  const oldText = "测试共 346 例全部通过。";
  const newText = "测试共 412 例全部通过。";
  assert.deepEqual(droppedValues(oldText, newText), []);
  assert.equal(report(oldText, newText).dropped.length, 0);
  assert.equal(report(oldText, newText).diff, ""); // 不告警即不附 diff
});

test("纯丢失（该类型 token 在新文中全无）记 hardfact-drop", () => {
  assert.deepEqual(droppedValues("服务端口 8080 已开放。", "服务已开放。"), ["number:8080"]);
  const { dropped } = diffHardFacts("服务端口 8080 已开放。", "服务已开放。");
  assert.equal(dropped[0].reason, "pure-loss");
});

// ---- 排除项 ----

test("ISO 时间戳/日期不参与比对（动态值不得报丢失）", () => {
  assert.deepEqual(droppedValues("记录于 2026-10-14 完成。", "记录于 2026-10-15 完成。"), []);
  assert.deepEqual(droppedValues("完成于 2026-10-14T10:30:00Z。", "完成于 2026-10-15T11:00:00Z。"), []);
  assert.deepEqual(droppedValues("会议 2026-01-05 09:00 开始。", "会议 2026-01-06 09:00 开始。"), []);
});

test("非 ISO 斜杠日期与时钟时间不参与比对（动态值不得报 near-miss）", () => {
  // 斜杠日期 2026/10/14 → 2026/10/15 不得报 number:14
  assert.deepEqual(droppedValues("日期 2026/10/14 发布。", "日期 2026/10/15 发布。"), []);
  // 时钟时间 10:30 → 10:31 不得报 number:30
  assert.deepEqual(droppedValues("开始 10:30 结束。", "开始 10:31 结束。"), []);
  // 带秒的时钟时间同样剥掉
  assert.deepEqual(droppedValues("开始 10:30:15 结束。", "开始 10:31:20 结束。"), []);
  // 反证：真数值事实仍照常检出
  assert.deepEqual(droppedValues("端口 8080 已开放。", "端口 8081 已开放。"), ["number:8080"]);
});

test("动态倒计时文本排除（「（今天 · 30 天后过期）」类）", () => {
  assert.deepEqual(droppedValues("条目（今天 · 30 天后过期）", "条目（今天 · 29 天后过期）"), []);
  assert.deepEqual(droppedValues("备份 3 天前创建。", "备份 4 天前创建。"), []);
  assert.deepEqual(droppedValues("(今天 · 7 天后过期)", "(今天 · 6 天后过期)"), []);
});

test("索引行（- [..](..) 形态）整行不参与比对", () => {
  const oldText = "- [foo](foo.md) — v1 第 269 条\n正文 269 条。";
  const newText = "- [foo](foo.md) — v1 第 267 条\n正文 269 条。";
  // 索引行里的 269→267 被排除（整行剥掉），正文里的 269 仍在 → 不报
  assert.deepEqual(droppedValues(oldText, newText), []);
  // 正文里真丢了才报
  assert.deepEqual(droppedValues(oldText, "- [foo](foo.md) — v1 第 267 条\n正文无数字。"), ["number:269"]);
});

// ---- frontmatter 不参与比对（运行时字段数字 churn）----

const memoryFile = (originSessionId, body) =>
  [
    "---",
    'name: "build-notes"',
    'description: "构建注意事项"',
    "metadata:",
    "  type: project",
    'node_type: "memory"',
    `originSessionId: "${originSessionId}"`,
    "---",
    "",
    body,
    "",
  ].join("\n");

const BODY = "构建用 pnpm，共 12 步，其中 269 个测试必须全部通过。";

test("frontmatter 字段数字变化不参与比对（originSessionId 之类运行时字段）", () => {
  // 会话 id 尾数 +1（267 式 churn，若参与比对就是 near-miss 误报）
  assert.deepEqual(
    droppedValues(memoryFile("s-1758000000123", BODY), memoryFile("s-1758000000124", BODY)),
    [],
  );
  // 会话 id 整段换掉（正文无数字时会冒成 pure-loss 误报）
  const noNumberBody = "构建用 pnpm 安装即可。";
  assert.deepEqual(
    droppedValues(
      memoryFile("s-1758000000123", noNumberBody),
      memoryFile("s-998877665544", noNumberBody),
    ),
    [],
  );
  // 抽取本身只看正文：frontmatter 里的数字不进 token 列表
  assert.deepEqual(
    extractHardFacts(memoryFile("s-1758000000123", BODY)).map((f) => `${f.type}:${f.value}`),
    ["number:12", "number:269"],
  );
});

test("正文里拿 --- 当分隔线的写法不被误剥", () => {
  const oldText = "---\n段落 269\n---\n正文 12 条。";
  const newText = "---\n段落 267\n---\n正文 12 条。";
  // 首段不是 YAML 形态 → 不当 frontmatter，正文里的 269→267 照常检出
  assert.deepEqual(droppedValues(oldText, newText), ["number:269"]);
});

test("frontmatter 剥离不误伤正文召回：正文数字真丢仍报", () => {
  assert.deepEqual(
    droppedValues(memoryFile("s-1758000000123", "服务端口 8080 已开放。"), memoryFile("s-1758000000999", "服务已开放。")),
    ["number:8080"],
  );
});

// ---- 英文倒计时/剩余注记 ----

test("英文倒计时/剩余注记排除（「30 days left」类，与中文形态同口径）", () => {
  assert.deepEqual(droppedValues("备份令牌 30 days left 后轮换。", "备份令牌 29 days left 后轮换。"), []);
  assert.deepEqual(droppedValues("镜像有效期 12 hours left。", "镜像有效期 11 hours left。"), []);
  assert.deepEqual(droppedValues("构建窗口 45 minutes left 关闭。", "构建窗口 44 minutes left 关闭。"), []);
  assert.deepEqual(droppedValues("(today · 7 days left)", "(today · 6 days left)"), []);
  // 反证：不带 left/remaining/to go 的普通数字句仍照常比对（收窄没有过度泛化）
  assert.deepEqual(droppedValues("切换还需 30 days before cutover。", "切换还需 29 days before cutover。"), ["number:30"]);
});

test("英文「N ago」经过语义排除（与中文「N 天前」对称，日期滚动不误报）", () => {
  // 30 days ago → 29 days ago：例行时间滚动，不得报
  assert.deepEqual(droppedValues("备份创建于 30 days ago。", "备份创建于 29 days ago。"), []);
  assert.deepEqual(droppedValues("节点 12 hours ago 掉线。", "节点 11 hours ago 掉线。"), []);
  // 与中文「N 天前」对称：中文侧同样不报
  assert.deepEqual(droppedValues("备份 30 天前创建。", "备份 29 天前创建。"), []);
  // 不带 ago 的未来语义（later）中文无镜像，照常比对（收窄不泛化）
  assert.deepEqual(droppedValues("将在 30 days later 查看。", "将在 29 days later 查看。"), ["number:30"]);
});

// ---- token 类型 ----

test("token 带类型：num / semver / hex / bytes 各归其位", () => {
  const facts = extractHardFacts("版本 v0.3.1，commit abc1234def，占用 4KB，编号 269。");
  const byType = Object.fromEntries(facts.map((f) => [`${f.type}:${f.value}`, true]));
  assert.equal(byType["semver:0.3.1"], true);
  assert.equal(byType["hex:abc1234def"], true);
  assert.equal(byType["bytesize:4kb"], true);
  assert.equal(byType["number:269"], true);
});

test("hex 不得吞纯数字串（123456 是 number 不是 hex）", () => {
  const facts = extractHardFacts("编号 123456 与 commit 998877fedc 共存。");
  assert.deepEqual(facts.map((f) => `${f.type}:${f.value}`), ["number:123456", "hex:998877fedc"]);
  // 纯数字串替换按 number 判（346→412 口径），不按 hex 的纯丢失乱报
  assert.deepEqual(droppedValues("编号 123456 与 987654 共存。", "编号 123456 与 555555 共存。"), []);
});

test("hex 必须同时含数字与 a-f 字母：纯英文词不得当 hex（decade/facade 类）", () => {
  // 只含 a-f 字母、无数字的普通英文词不得抽成 hex
  assert.deepEqual(extractHardFacts("a decade facade defaced accede beaded efface here"), []);
  // 整句替换也不得冒 phantom hex 纯丢失
  assert.deepEqual(droppedValues("After a decade of work", "After many years of work"), []);
  // 反证：真哈希（数字+字母）照抽
  assert.deepEqual(
    extractHardFacts("commit abc1234def 与 hash 998877fedc").map((f) => `${f.type}:${f.value}`),
    ["hex:abc1234def", "hex:998877fedc"],
  );
});

test("hex 需 ≥6 位：5 位十六进制串不算硬事实（门槛收紧不得回退）", () => {
  // 5 位纯字母/混合串都不抽成 hex；其中的数字部分按 number 收（≥2 位才收）
  assert.deepEqual(extractHardFacts("标识 abc12 结束").map((f) => `${f.type}:${f.value}`), ["number:12"]);
  assert.deepEqual(extractHardFacts("标识 abcde 结束"), []);
  // 6 位（含数字+字母）越过门槛照抽——门槛是「≥6」而非「≥5」
  assert.deepEqual(extractHardFacts("标识 abc123 结束").map((f) => `${f.type}:${f.value}`), ["hex:abc123"]);
});

test("bytesize 不收裸 b 单位：boxes/beans 不误判，kb/mb 与「字节」仍匹配", () => {
  // 「3 boxes」「269 beans」里的 3/269 是 number，不得拼成 3b/269b
  assert.deepEqual(extractHardFacts("Ship 3 boxes and 269 beans"), [
    { type: "number", value: "269", raw: "269", numeric: 269 },
  ]);
  assert.deepEqual(droppedValues("Ship 3 boxes", "Ship 3 crates"), []);
  // 单位齐全的字节尺寸照抽（含「字节」中文单位归一为 b）
  assert.deepEqual(
    extractHardFacts("占用 4KB，另有 4MB 与 1024 字节").map((f) => `${f.type}:${f.value}`),
    ["bytesize:4kb", "bytesize:4mb", "bytesize:1024b"],
  );
});

test("number 需 ≥2 位数字：个位数不是硬事实", () => {
  assert.deepEqual(extractHardFacts("共 5 步，共 42 步"), [
    { type: "number", value: "42", raw: "42", numeric: 42 },
  ]);
});

test("同类型才比：跨类型替换不算 near-miss（semver/hex 恒按有意更新）", () => {
  // 版本升位不报
  assert.deepEqual(droppedValues("版本 v0.3.1 已发布。", "版本 v0.4.0 已发布。"), []);
  // 换哈希不报
  assert.deepEqual(droppedValues("commit abc1234def 已合入。", "commit 998877fedc 已合入。"), []);
  // number → semver 跨类型不比
  assert.deepEqual(droppedValues("第 100 号。", "第 1.2.3 号。"), ["number:100"]);
});

test("isNearMiss：|Δ| ≤ max(10, 2%) 为近值；超出不报", () => {
  const mk = (value) => ({ type: "number", value: String(value), numeric: value });
  assert.equal(isNearMiss(mk(269), mk(267)), true);   // Δ2
  assert.equal(isNearMiss(mk(1000), mk(1019)), true); // Δ19 ≤ max(10,20)
  assert.equal(isNearMiss(mk(1000), mk(1021)), false);// Δ21 > 20
  assert.equal(isNearMiss(mk(346), mk(412)), false);  // Δ66 > max(10, 6.92)
  assert.equal(isNearMiss(mk(100), mk(90)), true);    // Δ10 = 阈值
  assert.equal(isNearMiss(mk(100), mk(89)), false);   // Δ11 > 10
  // 跨类型恒 false
  assert.equal(isNearMiss({ type: "hex", value: "abc123" }, { type: "number", value: "269" }), false);
});

// ---- diff 片段 ----

test("unifiedDiffSnippet：含变更行与上下文，超长截到 2KB", () => {
  const snippet = unifiedDiffSnippet("a\nb\nc\n老数字 269\nd", "a\nb\nc\n老数字 267\nd");
  assert.match(snippet, /@@/);
  assert.match(snippet, /^-.*269$/m);
  assert.match(snippet, /^\+.*267$/m);
  assert.ok(snippet.length <= 2048 + 40);
  // 无变更 → 只有 @@ 头，无 ± 行（判据：不含 +/- 行前缀）
  const noop = unifiedDiffSnippet("same\ntext", "same\ntext");
  assert.match(noop, /@@/);
  assert.doesNotMatch(noop, /^[+-]/m);
  // 超长输入被截断且有标记
  const huge = unifiedDiffSnippet("x".repeat(5000), "y".repeat(5000));
  assert.ok(huge.length <= 2048 + 40);
  assert.match(huge, /truncated/);
});

test("scrubDynamicText：索引行/ISO/倒计时被剥（先剥再扫，防误抽）", () => {
  const scrubbed = scrubDynamicText("- [a](a.md) — 269 条\n日期 2026-10-14\n（今天 · 30 天后过期）\n真数字 8080");
  assert.doesNotMatch(scrubbed, /a\.md/);
  assert.doesNotMatch(scrubbed, /2026-10-14/);
  assert.doesNotMatch(scrubbed, /30 天后过期/);
  assert.match(scrubbed, /真数字 8080/); // 非动态内容保留
});

test("scrubDynamicText：斜杠日期与时钟时间被剥，普通数字保留", () => {
  const scrubbed = scrubDynamicText("日期 2026/10/14，时间 10:30:15 开始，共 8080 条");
  assert.doesNotMatch(scrubbed, /2026\/10\/14/);
  assert.doesNotMatch(scrubbed, /10:30:15/);
  assert.match(scrubbed, /8080/); // 非动态数字保留
});

test("scrubDynamicText：含倒计时词的整个括号块被剥（含块内普通数字）；无倒计时词的括号不动", () => {
  // 括号里带「天后过期/天前」→ 整块（含括号内 269 这类普通数字）一起剥，
  // 避免「（今天 · 30 天后过期）」里的 30 与块内其他数字混进比对。
  const withCountdown = scrubDynamicText("（今天 · 30 天后过期，容量 269）");
  assert.doesNotMatch(withCountdown, /269/);
  assert.doesNotMatch(withCountdown, /天后过期/);
  // 反证：括号里没有倒计时词时整块保留（不得误剥普通括号内容）
  const noCountdown = scrubDynamicText("（容量 269）");
  assert.match(noCountdown, /269/);
  // 连带：整块被剥 → 块内数字变化不冒 phantom 纯丢失
  assert.deepEqual(droppedValues("（今天 · 30 天后过期，容量 269）", "（今天 · 29 天后过期，容量 267）"), []);
});

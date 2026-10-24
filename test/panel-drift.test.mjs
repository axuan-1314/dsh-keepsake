// panel-drift：面板与面板逻辑层的漂移守卫（panel.html 曾调用 6 个 panel-logic.js
// 里不存在的 safety* 函数，面板测试此前零看护，页面运行时全部报错）。
//   本用例把「panel.html 的 L.* 调用集 ⊆ panel-logic export 集」钉成不变量：
//   今后任何一面新增/改名 helper 而另一面没跟上，这里立刻红。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as L from "../lib/panel-logic.js";

const here = dirname(fileURLToPath(import.meta.url));
const panelHtml = readFileSync(join(here, "..", "web", "panel.html"), "utf8");

// 抓 panel.html 里所有 L.<identifier> 调用（import * as L 的绑定名）
const called = new Set(
  [...panelHtml.matchAll(/\bL\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
);

test("面板漂移：panel.html 的 L.* 调用全部解析到 panel-logic export", () => {
  const exported = new Set(Object.keys(L));
  const missing = [...called].filter((name) => !exported.has(name)).sort();
  assert.deepEqual(missing, [], `panel.html 调用了 panel-logic 不存在的函数: ${missing.join(", ")}`);
  // 同时保证抓取面不是空的（防面板改 import 绑定名后本测试静默失效）
  assert.ok(called.size >= 20, `L.* 调用集异常小（${called.size}），检查 import 绑定名是否变了`);
});

test("面板漂移：safety 六函数在场且容错（旧宿主无 /state.safety 不炸）", () => {
  for (const name of ["safetySummaryText", "safetyCountOf", "safetyEntryTimeOf", "safetyOriginText", "safetyLocationText", "safetyActionText"]) {
    assert.equal(typeof L[name], "function", `缺 ${name}`);
  }
  // 旧宿主 / 脏数据：全部返回 null/0/—，绝不抛
  assert.equal(L.safetySummaryText(undefined), null);
  assert.equal(L.safetySummaryText(null), null);
  assert.equal(L.safetySummaryText({}), null);
  assert.equal(L.safetyCountOf(undefined, "trashPending"), 0);
  assert.equal(L.safetyEntryTimeOf(null), "—");
  assert.equal(L.safetyOriginText({}), "—");
  assert.equal(L.safetyLocationText(null), "—");
  assert.equal(L.safetyActionText(""), "—");
  // 有数据时给真文案
  assert.match(L.safetySummaryText({ trashPending: 3, hardfactDrops: 1 }), /回收站共 3 条/);
  assert.match(L.safetySummaryText({ trashPending: 3, hardfactDrops: 1 }), /硬事实丢失告警 1/);
  // hardfactBlocks（硬事实 block 回滚）与 verifyFailed 分列；零值不渲染
  assert.match(L.safetySummaryText({ hardfactBlocks: 2 }), /硬事实拦截 2/);
  assert.equal(L.safetySummaryText({ hardfactBlocks: 0 }), null, "零值不渲染（全零 null 纪律）");
  assert.equal(L.safetyActionText("overwrite"), "覆写");
  assert.equal(L.safetyActionText("delete"), "删除");
  // rootKey 是 memoryRoot 相对 storageRoot 的相对路径（lib/safety.js rootKeyOf）：如实显示
  assert.equal(L.safetyLocationText({ rootKey: "global/work-profile" }), "global/work-profile");
  assert.equal(L.safetyLocationText({ rootKey: "projects/demo-a1b2c3d4e5f6a7b/memory" }), "项目 demo");
  assert.equal(L.safetyLocationText({ rootKey: "" }), "项目记忆");
});

// ---- 新面板面（补提 / 记忆整理 / 状态优先级 / 删除三态 / 设置健康 / 注入计数）防漂移 ----
//   面板消费的每个新纯函数必须在 panel-logic 在场且容错（旧宿主字段缺失不炸）；
//   同时在 panel.html 有对应的消费锚（不接线=纯函数白做）。

test("面板漂移：新纯函数全部在场（补提/整理/优先级/删除/健康/注入/预算/分页/焦点）", () => {
  for (const name of [
    "pendingItemLabel", "pendingHostNote",
    "duplicateScorePct", "staleDaysText", "maintenanceSuggestionsEmpty", "repairIndexResultText", "maintenanceCountsText",
    "healthPriorityLevel", "healthPriorityWord", "canShowNoFailureLine",
    "deleteOutcomeOf", "settingsCoercionNote", "injectionExtraText", "injectionBudgetText",
    "paginateOf", "paginationText", "trapFocus",
    // 召回降级双红条（静态配置类 / 运行时故障类，见 panel-logic 顶部注释）
    "recallDisabledNoticeText", "recallRuntimeFailureText",
  ]) {
    assert.equal(typeof L[name], "function", `缺 ${name}`);
  }
  for (const c of ["PENDING_EMPTY_TEXT", "PENDING_RECOVERING_TEXT", "PENDING_UNAVAILABLE_NOTE", "MAINTENANCE_EMPTY_TEXT", "PAGE_SIZE", "INDEX_HEALTH_COLUMNS", "RECALL_SETTINGS_PATH"]) {
    assert.ok(L[c] !== undefined, `缺常量 ${c}`);
  }
});

test("面板漂移：新纯函数旧宿主容错（字段缺失返回安全值，绝不抛）", () => {
  // 补提行：坏行 → null
  assert.equal(L.pendingItemLabel(null), null);
  assert.equal(L.pendingItemLabel("x"), null);
  assert.equal(L.pendingHostNote(false).length > 0, true);
  assert.equal(L.pendingHostNote(true), "");
  // 整理建议容错
  assert.equal(L.duplicateScorePct(null), 0);
  assert.equal(L.staleDaysText(null), "年龄不可知");
  assert.equal(L.maintenanceSuggestionsEmpty(null), true);
  assert.equal(L.repairIndexResultText(null) === "修复结果未知", true);
  // 数字形态容错（旧服务端 fixed 为条数）：0 → 无需修复，N → 已修复 N 处
  assert.equal(L.repairIndexResultText({ fixed: 0 }), "无需修复：索引与磁盘已经对上账");
  assert.equal(L.repairIndexResultText({ fixed: 2 }), "已修复 2 处");
  // 状态优先级容错（旧宿主无 extractionLog → 绿）
  assert.equal(L.healthPriorityLevel(null), "green");
  assert.equal(L.healthPriorityLevel({}), "green");
  assert.equal(L.healthPriorityWord("bogus"), "正常");
  assert.equal(L.canShowNoFailureLine("green"), true);
  // 删除三态容错（无 existed 字段按失败，不谎报成功）
  assert.equal(L.deleteOutcomeOf(null).kind, "failed");
  // 设置健康 / 注入计数 / 注入预算容错
  assert.equal(L.settingsCoercionNote(null), "");
  assert.equal(L.injectionExtraText(null), "");
  assert.equal(L.injectionBudgetText(null, 16000), "");
  assert.equal(L.injectionBudgetText({ count: 1, lastTokens: 10 }, void 0), "", "上限缺失 → 空串（旧宿主）");
  // 召回双红条容错：旧宿主无 /state.recallDiagnostics / 无 errors 计数 → null（不渲染、不炸）
  assert.equal(L.recallDisabledNoticeText(void 0), null);
  assert.equal(L.recallDisabledNoticeText({}), null);
  assert.equal(L.recallDisabledNoticeText({ disabled: null }), null);
  assert.equal(L.recallRuntimeFailureText(void 0), null);
  assert.equal(L.recallRuntimeFailureText({ errors: 0 }), null, "零错误不印 0 装饰");
  // 分页 / 焦点陷阱在场且是函数
  assert.equal(L.paginateOf(0, 0).pageCount, 0);
  // trapFocus 依赖 document 全局：此处给最小桩，验证它返回卸载函数（Node 无 DOM）
  const realDoc = globalThis.document;
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {}, activeElement: null };
  try {
    assert.equal(typeof L.trapFocus({ querySelectorAll: () => [] }, () => {}), "function");
  } finally {
    globalThis.document = realDoc;
  }
});

test("面板漂移：新面板消费锚全部接线（L.* 调用在位防白做）", () => {
  for (const anchor of [
    "L.pendingItemLabel(", "L.pendingHostNote(", "L.PENDING_UNAVAILABLE_NOTE", "L.PENDING_EMPTY_TEXT", "L.PENDING_RECOVERING_TEXT",
    "L.maintenanceSuggestionsEmpty(", "L.duplicateScorePct(", "L.staleDaysText(", "L.repairIndexResultText(", "L.maintenanceCountsText(", "L.MAINTENANCE_EMPTY_TEXT", "L.INDEX_HEALTH_COLUMNS",
    "L.healthPriorityLevel(", "L.healthPriorityWord(", "L.canShowNoFailureLine(",
    "L.deleteOutcomeOf(", "L.settingsCoercionNote(",
    "L.injectionBudgetText(",
    "L.paginateOf(", "L.paginationText(", "L.trapFocus(",
    // 召回降级红条：数据源必须是 /state.recallDiagnostics + 现算 settingsFilePath
    //（接错成 /state.recall 就永远拿不到配置诊断，只会静默失效），运行时故障另走 /state.recall.errors
    "L.recallDisabledNoticeText(data.recallDiagnostics, settingsFilePath)", "L.recallRuntimeFailureText(data.recall)",
  ]) {
    assert.ok(panelHtml.includes(anchor), `panel.html 未接线 ${anchor}（纯函数白做）`);
  }
  // 注入面节流/取代：面板经共享 injectionSummary 消费（extra 段落在 panel-logic 内拼接，
  // 面板不直接调 injectionExtraText——所以钉「共享函数已含两计数」而非直连调用）
  assert.ok(panelHtml.includes("L.injectionSummary("), "面板必须消费共享 injectionSummary（含 throttled/superseded 段）");
  assert.match(L.injectionSummary({ count: 3, lastChars: 100, throttled: 2, superseded: 1 }) ?? "", /变更节流 2 次 \/ 取代 1 次/, "共享摘要必须含两计数人话文案");
  // 注入预算占用：消费锚 + 上限取自 /state.injectMaxTokens（数据源不对=白做）
  assert.ok(panelHtml.includes("L.injectionBudgetText(data.injection, data.injectMaxTokens)"), "面板注入行必须消费 injectionBudgetText 且上限取 /state.injectMaxTokens");
});

// ---- 运行时记忆页签（RUNTIME-FORMAT §十二 UX）防漂移 ----
//   面板消费的每个 runtime 纯函数必须在 panel-logic 在场且容错（GET 404 / 旧宿主字段缺失不炸）；
//   同时在 panel.html 有对应的消费锚（不接线=纯函数白做）。

test("面板漂移：runtime 页签纯函数与常量全部在场", () => {
  for (const name of [
    "runtimeScopeLabel", "runtimeScopeOptions", "runtimeUsageOf", "runtimeStatusBadge",
    "runtimeCandidateRows", "runtimeArtifactRows", "runtimePinTarget", "runtimeEnabledOf",
    "runtimeCompileSummaryText", "runtimeEvictToastText", "runtimeSkippedRows",
    "runtimeEvictSelection", "runtimeRestoreRows", "runtimeRestoreToastText",
  ]) {
    assert.equal(typeof L[name], "function", `缺 ${name}`);
  }
  for (const c of [
    "RUNTIME_GLOBAL_SCOPE", "RUNTIME_GUIDE_TEXT", "RUNTIME_UNPIN_WARNING",
    "RUNTIME_OVER_QUOTA_HINT", "RUNTIME_READONLY_NOTE", "RUNTIME_RESTORE_NOTE", "RUNTIME_SKIP_REASON_LABELS",
  ]) {
    assert.ok(L[c] !== undefined, `缺常量 ${c}`);
  }
});

test("面板漂移：runtime 纯函数容错（缺产物/脏值返回安全值，绝不抛）", () => {
  // scope 标签/选项：缺失项目列表 → 只有全局；坏 id 直接丢弃（不摆必 404 的死选项）
  assert.equal(L.runtimeScopeLabel(undefined), "—");
  assert.equal(L.runtimeScopeLabel("global"), "全局");
  assert.equal(L.runtimeScopeLabel("projects/demo-0123456789abcdef"), "项目 demo");
  assert.deepEqual(L.runtimeScopeOptions(null).map((o) => o.scope), ["global"]);
  assert.deepEqual(L.runtimeScopeOptions([{ id: "Bad_ID" }, null, { id: "demo-0123456789abcdef", entries: 2 }]).map((o) => o.scope), ["global", "projects/demo-0123456789abcdef"]);
  // 用量：缺配额不冒充 0%（明说「配额未知」）；越界 pct > 100 且 barPct 截顶
  const noQuota = L.runtimeUsageOf(undefined);
  assert.equal(noQuota.pct, 0);
  assert.equal(noQuota.over, false);
  assert.match(noQuota.text, /配额未知/);
  const over = L.runtimeUsageOf({ bytes: 5000, quotaBytes: 4096 });
  assert.equal(over.pct, 122);
  assert.equal(over.barPct, 100);
  assert.equal(over.over, true);
  // 状态徽标：三态 + 缺失/未知 → 尚未编译（不冒充正常）
  assert.equal(L.runtimeStatusBadge("ok").level, "green");
  assert.equal(L.runtimeStatusBadge("overQuota").level, "red");
  assert.equal(L.runtimeStatusBadge("error").level, "red");
  assert.equal(L.runtimeStatusBadge(undefined).level, "grey");
  assert.equal(L.runtimeStatusBadge("bogus").level, "grey");
  // 候选行 / 跳过行 / 移回行：非数组与坏项一律安全
  assert.deepEqual(L.runtimeCandidateRows(null), []);
  assert.deepEqual(L.runtimeCandidateRows([null, {}, { file: "  " }]), []);
  assert.deepEqual(L.runtimeSkippedRows(undefined), []);
  assert.deepEqual(L.runtimeRestoreRows(null), []);
  // pin 目标：不可定位 / 跨 scope 形态 → ok:false + 人话原因
  assert.equal(L.runtimePinTarget(null, "global").ok, false);
  assert.equal(L.runtimePinTarget({ rootKey: "project", file: "p.md" }, "global").ok, false);
  assert.equal(L.runtimePinTarget({ rootKey: "global:work-profile", file: "f.md" }, "projects/demo-0123456789abcdef").ok, false);
  assert.deepEqual(L.runtimePinTarget({ rootKey: "global:work-profile", file: "f.md" }, "global"), { ok: true, rootKey: "global:work-profile", file: "f.md" });
  // diff 摘要：响应不成形如实说「未知」，不拿 0 冒充
  assert.match(L.runtimeCompileSummaryText(null), /重新编译结果未知/);
  assert.match(L.runtimeCompileSummaryText({ ok: false }), /重新编译结果未知/);
  // 归档 Toast：零归档 + 有跳过 → 明说没归档（不谎报成功）
  assert.match(L.runtimeEvictToastText({ archived: 0, skipped: [{ file: "a.md", reason: "not-candidate" }] }), /没有条目被归档/);
  assert.match(L.runtimeEvictToastText({}), /没有条目被归档/);
  // 移回 Toast：坏响应不炸（给个能读的句子）
  assert.match(L.runtimeRestoreToastText(null), /已从归档移回/);
});

test("面板漂移：runtime 产物行解析不误用 parseIndexContent 口径（前缀标记行 + 相对路径反推）", () => {
  // global 产物 2 层 `../`；项目产物 3 层（§3.2 相对路径层数）
  const globalText = [
    "<!-- AUTO-GENERATED by dsh-keepsake · scope=global · compiledAt=x -->",
    "Global memory root: /root/global",
    "",
    "- 【关键】[Me](../../global/user-profile/me.md) — 用户",
    "- 【普通】[Foo](../../global/work-profile/foo.md)",
    "- 【普通】[P](../../projects/demo-0123456789abcdef/memory/p.md) — 项目",
    "[runtime over quota: pinned entries exceed MEMORY.md quota]",
  ].join("\n");
  const rows = L.runtimeArtifactRows(globalText, "global");
  assert.equal(rows.length, 3, "告警行/声明行/头行不算条目");
  assert.deepEqual(rows[0], { pinned: true, title: "Me", hook: "用户", rootKey: "global:user-profile", file: "me.md", locatable: true });
  assert.equal(rows[1].hook, "", "无钩子行不编造钩子");
  assert.equal(rows[2].locatable, false, "全局产物里的项目路径不跨 scope 定位（rootKey 拒猜）");
  // 项目产物：全局条目与项目条目都能定位
  const projText = [
    "- 【关键】[Me](../../../global/user-profile/me.md) — 用户",
    "- 【普通】[P](../../../projects/demo-0123456789abcdef/memory/p.md) — 项目",
  ].join("\n");
  const projRows = L.runtimeArtifactRows(projText, "projects/demo-0123456789abcdef");
  assert.equal(projRows[0].rootKey, "global:user-profile");
  assert.equal(projRows[1].rootKey, "project");
  assert.equal(projRows[1].locatable, true);
  // 脏输入不炸
  assert.deepEqual(L.runtimeArtifactRows(undefined, "global"), []);
});

test("面板漂移：runtime 消费锚全部接线（L.* 调用在位防白做）", () => {
  for (const anchor of [
    "L.runtimeScopeOptions(", "L.runtimeStatusBadge(", "L.runtimeUsageOf(",
    "L.runtimeCandidateRows(", "L.runtimeArtifactRows(", "L.runtimePinTarget(",
    "L.runtimeCompileSummaryText(", "L.runtimeEvictToastText(", "L.runtimeSkippedRows(",
    "L.runtimeEvictSelection(", "L.runtimeRestoreRows(", "L.runtimeRestoreToastText(",
    "L.RUNTIME_GUIDE_TEXT", "L.RUNTIME_UNPIN_WARNING", "L.RUNTIME_READONLY_NOTE", "L.RUNTIME_RESTORE_NOTE",
  ]) {
    assert.ok(panelHtml.includes(anchor), `panel.html 未接线 ${anchor}（纯函数白做）`);
  }
  // 端点接线（字段级：路径与载荷形态必须与 §十一 一致）
  for (const ep of [
    'api("runtime/" + runtimeScope)',
    "`runtime/${runtimeScope}/compile`",
    "`runtime/${runtimeScope}/evict`",
    "`runtime/${runtimeScope}/pin`",
    '"runtime/global/archive/restore"',
    '"runtime/compile-all"',
  ]) {
    assert.ok(panelHtml.includes(ep), `panel.html 未接端点 ${ep}`);
  }
  // 页签与路由在位（aside 项 + ROUTES）
  assert.ok(panelHtml.includes('data-route="runtime"'), "aside 缺「运行时记忆」页签");
  assert.ok(panelHtml.includes('"runtime": { title: "运行时记忆" }'), "ROUTES 缺 runtime 路由");
  assert.ok(panelHtml.includes('route === "runtime"'), "render() 未分发 runtime 页");
  // 设置页 runtimeEnabled 开关（缺省关口径）
  assert.ok(panelHtml.includes('switchRow("runtimeEnabled"'), "设置页缺 runtimeEnabled 开关");
  assert.ok(panelHtml.includes("L.runtimeEnabledOf("), "开关与引导必须走 runtimeEnabledOf（三态 tolerant，不硬判 false）");
});
// ---- 用户面文案测试：面板表格不得出现英文枚举（复查点名的遗留缺口） ----
// 最近失败表的 reason 列曾直接 esc(r.reason) 渲染，面板上会露出 no-route / llm-error /
// parse-error / io-error 这类英文枚举（用户看不懂也不知道该做什么）。现在该列与
// 「最近提取记录」结果列同口径走 L.reasonLabelOf 中文化。
// 这里把面板的真实行模板抠出来求值（不是只 grep 源码）：模板若回退成 esc(r.reason)
// 或换掉 reasonLabelOf，下面渲染出的 HTML 立刻命中英文枚举正则。
test("面板漂移：最近失败表 reason 列经 reasonLabelOf 中文化（渲染级，不 grep）", () => {
  // 从 panel.html 抠出真实行模板（`const rows = ef.recent.slice(0, 5).map((r) => {` 起）
  const start = panelHtml.indexOf("ef.recent.slice(0, 5).map((r) => {");
  assert.ok(start >= 0, "面板必须保留最近失败表行模板");
  // 取到 return 语句那一行（模板是 return `<tr>…` 一行）
  const retLine = panelHtml.slice(start).match(/return `([^`]*)`;/);
  assert.ok(retLine, "必须抠得到 return `<tr>…` 行模板");
  // 模板引用的绑定照面板源码同口径喂：r（该行）/ msg（r.message 原样）/ short（截 60 摘要）
  const rowFn = new Function("r", "msg", "short", "L", "esc", "return `" + retLine[1] + "`;");
  const escFn = (s) => String(s ?? "");
  const render = (reason) => {
    const r = { at: 1730000000000, reason, model: "acme/chat-model", message: "429 …" };
    const msg = String(r.message ?? "");
    const short = msg.length > 60 ? msg.slice(0, 60) + "…" : msg;
    return rowFn(r, msg, short, L, escFn);
  };
  const ENUM_RE = /\b(no-route|llm-error|parse-error|io-error|no-cwd)\b/;
  for (const reason of ["no-route", "llm-error", "parse-error", "io-error", "no-cwd"]) {
    const html = render(reason);
    assert.doesNotMatch(html, ENUM_RE, `reason 列不得露英文枚举 ${reason}：${html}`);
    assert.ok(html.includes("<tr>"), `必须渲染成表格行：${html}`);
  }
  // 中文化确实生效（不是把 reason 吞掉留空）
  assert.match(render("no-route"), /无模型路由/, "reason 列必须出中文标签");
});

test("面板漂移：思考档降级摘要已接线（reasoningDegraded>0 时渲染，零值不渲染）", () => {
  assert.ok(panelHtml.includes("L.reasoningDegradedText(efRaw)"), "健康卡必须消费 reasoningDegradedText");
  // 纯函数侧：>0 出文案含「降级」，零值/旧宿主 null
  assert.match(L.reasoningDegradedText({ reasoningDegraded: 2 }), /思考档降级 2 次/);
  assert.match(L.reasoningDegradedText({ reasoningDegraded: 2 }), /降级/);
  assert.equal(L.reasoningDegradedText({ reasoningDegraded: 0 }), null);
  assert.equal(L.reasoningDegradedText(null), null);
});

test("面板漂移：最近提取记录截断标记（written + truncatedParse>0 标签含「截断」）", () => {
  // extractionRunLines 内部调 extractionRunLabel：截断标随行标签出（双端同源）
  const lines = L.extractionRunLines([
    { at: 1730000000000, from: 0, to: 5, sessionId: "s", outcome: "written", writes: 2, truncatedParse: 1 },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0].label, /截断/, "truncatedParse>0 的 written 行标签必须含「截断」");
  // 无截断标记 → 标签干净（不印 0 装饰）
  const plain = L.extractionRunLines([
    { at: 1730000000000, from: 0, to: 5, sessionId: "s", outcome: "written", writes: 2 },
  ]);
  assert.equal(plain[0].label, "已写 2 条");
});

// ---- hardfactPolicy 指路文案（方案 v2 4.3：只说明，不加控件） ----
//   为什么必须有渲染级测试：这段文案的全部价值就在面板真实渲染出来的那一行上——
//   只 grep「hardfactPolicyNote 在源码里出现过」拦不住「函数在场但面板没接线」
//   （纯函数白做），也拦不住「接线时把 s.hardfactPolicy 换成写死的 'warn'」
//   （拨到 block 的用户永远看不到自己的现值）。故把保留策略卡真实行模板抠出来求值。
test("hardfactPolicy 指路：面板保留策略卡渲染级接线（抠真实行模板求值）", () => {
  // 从 panel.html 抠出真实行模板（`<div class="meta" id="keepHardfactNote">` 起一行）
  const line = panelHtml.split("\n").find((l) => l.includes('id="keepHardfactNote"'));
  assert.ok(line, "保留策略卡必须有 hardfactPolicy 指路行");
  const tmpl = line.match(/\$\{([^}]*)\}/);
  assert.ok(tmpl, "指路行必须是模板插值（写死文案 = 现值永不变，直接红）");
  assert.match(tmpl[1], /^esc\(L\.hardfactPolicyNote\(s\.hardfactPolicy, data\.storageRoot /, "指路行必须经 esc(L.hardfactPolicyNote(现值, 真实路径)) 渲染（路径用 /state.storageRoot 现算，storageRoot 可配不能写死 ~/.dsh）");
  // 按面板源码同口径喂绑定：整行当模板字面量求值（s = /state.settings；esc 同 panel.html 定义）
  const render = (settings, data = {}) => new Function("s", "L", "esc", "data", "return `" + line + "`;")(
    settings, L, (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    data,
  );
  const POLICY_KEY = "hardfactPolicy";
  // ① warn：文案到位 + 现值正确 + 键名与改法路径在场（storageRoot 缺失 → 回落 ~/.dsh 默认）
  const warnHtml = render({ [POLICY_KEY]: "warn" });
  assert.ok(warnHtml.includes("<div"), `必须渲染成 div：${warnHtml}`);
  assert.match(warnHtml, /当前值 warn/);
  assert.match(warnHtml, /只告警并记日志/);
  assert.ok(warnHtml.includes(POLICY_KEY), "文案必须写出 settings 键名（用户照此改文件）");
  assert.ok(warnHtml.includes("~/.dsh/memory/settings.json"), "storageRoot 缺失时文案必须回落默认路径");
  assert.match(warnHtml, /我改的记忆自己变回去了/, "必须说明为什么不给控件（回滚合法更新的观感）");
  // ①-b 自定义 storageRoot：指路必须是真实路径（写死 ~/.dsh 会给自定义用户指错路）
  const customHtml = render({ [POLICY_KEY]: "warn" }, { storageRoot: "D:/custom/root/" });
  assert.ok(customHtml.includes("D:/custom/root/settings.json"), "自定义 storageRoot 时必须指真实路径");
  assert.ok(!customHtml.includes("~/.dsh"), "自定义路径下不得再出现 ~/.dsh 兜底（指路只能有一个真相）");
  // ② block：现值切换（证明取值真的来自 settings，不是写死 warn）
  const blockHtml = render({ [POLICY_KEY]: "block" });
  assert.match(blockHtml, /当前值 block/);
  assert.match(blockHtml, /撤销回滚/);
  assert.doesNotMatch(blockHtml, /当前值 warn/, "block 时不得仍显示 warn（现值谎报）");
  // ③ 旧宿主 /state.settings 无该键：仍要渲染（tolerant），按缺省 warn 生效但不冒充现值
  const missingHtml = render({});
  assert.match(missingHtml, /当前值不认识（按 warn 生效）/);
  assert.match(missingHtml, /只告警并记日志/);
  // ④ 脏值（白名单外，如 settings 校验已回默认 warn）不当成合法现值冒充
  const dirtyHtml = render({ [POLICY_KEY]: "blocked" });
  assert.match(dirtyHtml, /当前值不认识（按 warn 生效）/);
  // ⑤ 纯函数层：常量与白名单在场（门牌/双端共用同一出处）
  assert.deepEqual(L.HARDFACT_POLICY_VALUES, ["warn", "block"]);
  assert.equal(L.HARDFACT_POLICY_SETTINGS_PATH, "~/.dsh/memory/settings.json");
  assert.equal(L.hardfactPolicyNote(void 0), L.hardfactPolicyNote("blocked"), "缺失与脏值同口径：都不冒充合法现值");
  assert.equal(L.hardfactPolicyNote(null), L.hardfactPolicyNote("blocked"));
  assert.equal(L.hardfactPolicyNote(123), L.hardfactPolicyNote("blocked"), "非字符串同口径");
  assert.match(L.hardfactPolicyNote(void 0), /按 warn 生效/, "缺失必须明说按 warn 生效");
  // ⑥ 路径参数兜底：不传/空串 → 默认路径；真实路径 → 原样采用
  assert.ok(L.hardfactPolicyNote("warn").includes("~/.dsh/memory/settings.json"), "不传路径回落默认");
  assert.ok(L.hardfactPolicyNote("warn", "").includes("~/.dsh/memory/settings.json"), "空串路径同样回落默认");
  assert.ok(L.hardfactPolicyNote("warn", "D:/custom/root/settings.json").includes("D:/custom/root/settings.json"), "真实路径原样采用");
  assert.ok(!L.hardfactPolicyNote("warn", "D:/custom/root/settings.json").includes("~/.dsh"), "给了真实路径不得再出现默认路径");
});

test("hardfactPolicy 指路：面板不得为该键新增任何控件（定案：只加文案）", () => {
  // 输入/下拉/开关一律不许有——用户拨到 block 会让合法更新被回滚（方案 v2 4.3）。
  // 切片边界用「下一张卡的锚点」（`data-settingsHealth` / `<h3>数据</h3>`），
  // 不用 </div> 计数——数不准会让边界悄悄落到文件尾，本用例就退化成了全文扫描
  // （曾实测：加了下拉框仍然全部通过，等于没拦）。
  const cardStart = panelHtml.indexOf('id="card-retention"');
  assert.ok(cardStart >= 0, "保留策略卡必须存在");
  const after = panelHtml.slice(cardStart);
  const nextAnchor = [after.indexOf("data-settingsHealth"), after.indexOf("<h3>数据</h3>")].filter((i) => i > 0).sort((a, b) => a - b)[0];
  assert.ok(nextAnchor > 0, "找不到保留策略卡的结束锚点（卡片结构变了，本用例必须红而不是静默扫全文）");
  const body = after.slice(0, nextAnchor);
  // 卡必须真的被切出来了（含三个既有控件），否则边界又退化了
  for (const id of ["keepTrashDays", "keepSurgical", "keepRecentDays"]) {
    assert.ok(body.includes(`id="${id}"`), `切片边界退化：保留策略卡里应有 ${id}`);
  }
  // 控件判据升级（复查 P1：旧判据只认带 keepHardfact 的标签，加个 radio/checkbox 就绕过）：
  // 卡内凡 input/select/textarea 一律白名单核对——不在三个既有控件之列的就是违规。
  const tagRe = /<(?:input|select|textarea)\b[^>]*>/gi;
  const offenders = [];
  let m;
  while ((m = tagRe.exec(body)) !== null) {
    if (!/\b(?:keepTrashDays|keepSurgical|keepRecentDays)\b/.test(m[0])) offenders.push(m[0].trim());
  }
  assert.equal(offenders.length, 0, `保留策略卡出现白名单外的输入控件（含 radio/checkbox）：${offenders.join(" ; ")}`);
  // 任何 option=warn/block 的下拉同样不许有（兜底，防白名单控件被塞进非法选项）
  assert.doesNotMatch(body, /<option[^>]*>\s*(?:warn|block)\s*<\/option>/i, "不得出现 warn/block 选项");
});

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
  ]) {
    assert.equal(typeof L[name], "function", `缺 ${name}`);
  }
  for (const c of ["PENDING_EMPTY_TEXT", "PENDING_RECOVERING_TEXT", "PENDING_UNAVAILABLE_NOTE", "MAINTENANCE_EMPTY_TEXT", "PAGE_SIZE", "INDEX_HEALTH_COLUMNS"]) {
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
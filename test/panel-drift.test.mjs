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

test("面板漂移：新纯函数全部在场（补提/整理/优先级/删除/健康/注入/分页/焦点）", () => {
  for (const name of [
    "pendingItemLabel", "pendingHostNote",
    "duplicateScorePct", "staleDaysText", "maintenanceSuggestionsEmpty", "repairIndexResultText", "maintenanceCountsText",
    "healthPriorityLevel", "healthPriorityWord", "canShowNoFailureLine",
    "deleteOutcomeOf", "settingsCoercionNote", "injectionExtraText",
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
  // 设置健康 / 注入计数容错
  assert.equal(L.settingsCoercionNote(null), "");
  assert.equal(L.injectionExtraText(null), "");
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
    "L.paginateOf(", "L.paginationText(", "L.trapFocus(",
  ]) {
    assert.ok(panelHtml.includes(anchor), `panel.html 未接线 ${anchor}（纯函数白做）`);
  }
  // 注入面节流/取代：面板经共享 injectionSummary 消费（extra 段落在 panel-logic 内拼接，
  // 面板不直接调 injectionExtraText——所以钉「共享函数已含两计数」而非直连调用）
  assert.ok(panelHtml.includes("L.injectionSummary("), "面板必须消费共享 injectionSummary（含 throttled/superseded 段）");
  assert.match(L.injectionSummary({ count: 3, lastChars: 100, throttled: 2, superseded: 1 }) ?? "", /变更节流 2 次 \/ 取代 1 次/, "共享摘要必须含两计数人话文案");
});
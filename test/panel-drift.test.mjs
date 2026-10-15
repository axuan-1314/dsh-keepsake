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
  assert.match(L.safetySummaryText({ trashPending: 3, hardfactDrops: 1 }), /回收站待清 3/);
  assert.match(L.safetySummaryText({ trashPending: 3, hardfactDrops: 1 }), /硬事实丢失告警 1/);
  assert.equal(L.safetyActionText("overwrite"), "覆写");
  assert.equal(L.safetyActionText("delete"), "删除");
  // rootKey 是 memoryRoot 相对 storageRoot 的相对路径（lib/safety.js rootKeyOf）：如实显示
  assert.equal(L.safetyLocationText({ rootKey: "global/work-profile" }), "global/work-profile");
  assert.equal(L.safetyLocationText({ rootKey: "projects/demo-a1b2c3d4e5f6a7b/memory" }), "项目 demo");
  assert.equal(L.safetyLocationText({ rootKey: "" }), "项目记忆");
});
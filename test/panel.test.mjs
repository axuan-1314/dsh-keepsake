// panel：面板页供给——loopback 守卫、同源嵌入防护头、静态供给。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { PANEL_PATH, makePanelRoutes } from "../lib/panel.js";

const silentLog = { info() {}, warn() {}, error() {} };
const here = dirname(fileURLToPath(import.meta.url));
const panelHtml = readFileSync(join(here, "..", "web", "panel.html"), "utf8");

function mockReq({ method = "GET", remoteAddress = "127.0.0.1", headers = {} } = {}) {
  return { method, socket: { remoteAddress }, headers: { host: "127.0.0.1:3080", ...headers } };
}
function mockRes() {
  return {
    status: 0,
    headers: {},
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(chunk) {
      this.body = chunk ?? null;
    },
  };
}

test("面板供给：同源嵌入防护头在场（X-Frame-Options / CSP frame-ancestors）", () => {
  const routes = makePanelRoutes(silentLog);
  const handler = routes.find((r) => r.path === PANEL_PATH.replace(/\/$/, "") && r.kind === "exact").handler;
  const res = mockRes();
  handler(mockReq(), res);
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");
  assert.match(res.headers["content-security-policy"] ?? "", /frame-ancestors 'self'/);
  assert.match(res.headers["content-type"] ?? "", /text\/html/);
});

test("面板供给：非 loopback 请求 403（守卫不松）", () => {
  const routes = makePanelRoutes(silentLog);
  const handler = routes.find((r) => r.kind === "exact" && r.path === PANEL_PATH).handler;
  const res = mockRes();
  handler(mockReq({ remoteAddress: "10.0.0.9" }), res);
  assert.equal(res.status, 403);
});

test("面板供给：非 GET/HEAD 方法 405", () => {
  const routes = makePanelRoutes(silentLog);
  const handler = routes.find((r) => r.kind === "exact" && r.path === PANEL_PATH).handler;
  const res = mockRes();
  handler(mockReq({ method: "POST" }), res);
  assert.equal(res.status, 405);
});

// ---- HTML 结构断言：页签存在性（新页签「运行时记忆」+ 设置开关项；DOM 细节不钉，钉接线面） ----

test("面板结构：运行时记忆页签（aside 项 + 路由 + 渲染函数）在位", () => {
  assert.ok(panelHtml.includes('data-route="runtime"'), "aside 缺「运行时记忆」入口");
  assert.ok(panelHtml.includes('"runtime": { title: "运行时记忆" }'), "ROUTES 缺 runtime 路由");
  assert.ok(panelHtml.includes("async function renderRuntimePage"), "缺 renderRuntimePage 渲染函数");
  assert.ok(panelHtml.includes('route === "runtime"'), "render() 未分发 runtime 页");
  assert.ok(panelHtml.includes('data-cnt="runtime"'), "aside 缺候选计数徽标锚点");
  // 现有页签一个不少（新页签只加不改：防顺手动结构）
  for (const route of ["category/work-profile", "category/user-profile", "category/current-focus", "category/recent-activity", "long-term", "persona", "addressing", "projects", "trash", "snapshots", "settings"]) {
    assert.ok(panelHtml.includes(`data-route="${route}"`), `既有页签 ${route} 被动了`);
  }
});

test("面板结构：设置页 runtimeEnabled 开关在位且缺省关口径（=== true 才勾选）", () => {
  assert.ok(panelHtml.includes('switchRow("runtimeEnabled"'), "设置页缺 runtimeEnabled 开关行");
  assert.ok(panelHtml.includes("L.runtimeEnabledOf("), "runtimeEnabled 现值必须走 runtimeEnabledOf（后端字段 → 本会话回填 → 缺省关）");
  // 三开关仍走缺省开口径（不被新开关带偏）
  for (const key of ["conversationMemory", "projectMemory", "globalExtraction"]) {
    assert.ok(panelHtml.includes(`switchRow("${key}"`), `既有开关 ${key} 被动了`);
  }
});

test("面板结构：§十二 UX 条目接线（只读预览/用量条/候选勾选/重编/移回/开关联动）", () => {
  // 只读预览（等宽滚动区 + 头声明）
  assert.ok(panelHtml.includes('class="codeBox"'), "缺只读预览等宽滚动区");
  assert.ok(panelHtml.includes("L.RUNTIME_READONLY_NOTE"), "预览区缺「只读」声明");
  // 用量进度条（越界红显：.bar.over 类）
  assert.ok(panelHtml.includes('class="bar${userUsage.over ? " over" : ""}"'), "USER.md 用量条缺越界红显类");
  assert.ok(panelHtml.includes('class="bar${memUsage.over ? " over" : ""}"'), "MEMORY.md 用量条缺越界红显类");
  // 淘汰候选：勾选框 + 计数徽标 + 「执行归档」
  assert.ok(panelHtml.includes('data-ck='), "候选清单缺勾选框");
  assert.ok(panelHtml.includes("淘汰候选 ${candRows.length}"), "缺候选计数徽标");
  assert.ok(panelHtml.includes(">执行归档</button>"), "缺「执行归档」按钮");
  // 「执行归档」先自动刷新候选清单再提交（§十二 防过期）
  assert.ok(panelHtml.includes("L.runtimeEvictSelection("), "归档提交前必须与刷新后清单求交（防过期）");
  // 「重新编译」按钮 + diff 摘要展示
  assert.ok(panelHtml.includes(">重新编译</button>"), "缺「重新编译」按钮");
  assert.ok(panelHtml.includes("L.runtimeCompileSummaryText("), "缺 diff 摘要展示");
  // 「从归档移回」入口
  assert.ok(panelHtml.includes("从归档移回"), "缺「从归档移回」入口");
  // 首次打开且开关关：内联引导（非打断式弹窗），文案取共享常量
  assert.ok(panelHtml.includes("L.RUNTIME_GUIDE_TEXT"), "缺开关关闭时的内联引导句");
  // 解 pin 预警文案 + pin 端点
  assert.ok(panelHtml.includes("L.RUNTIME_UNPIN_WARNING"), "解 pin 缺预警文案");
  // overQuota 指引
  assert.ok(panelHtml.includes("badge.hint"), "缺 overQuota 操作指引渲染");
});

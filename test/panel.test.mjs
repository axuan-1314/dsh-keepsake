// panel：面板页供给——loopback 守卫、同源嵌入防护头、静态供给。
import assert from "node:assert/strict";
import { test } from "node:test";
import { PANEL_PATH, makePanelRoutes } from "../lib/panel.js";

const silentLog = { info() {}, warn() {}, error() {} };

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

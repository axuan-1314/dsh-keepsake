// dsh-memory 面板页供给：/dsh-memory/panel/ 单文件 HTML。
//   readFileSync + no-cache（迭代期防旧页）；loopback 守卫与 api.js 同款。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isLoopbackRequest, writeJson } from "./api.js";

export const PANEL_PATH = "/dsh-memory/panel/";

const panelHtmlPath = fileURLToPath(new URL("../web/panel.html", import.meta.url));
const panelLogicPath = fileURLToPath(new URL("./panel-logic.js", import.meta.url));

export function makePanelRoutes(log = { error: () => {} }) {
  const guard = (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: "loopback requests only" });
      return false;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") });
      return false;
    }
    return true;
  };
  const servePanel = (req, res) => {
    try {
      if (!guard(req, res)) return;
      const body = readFileSync(panelHtmlPath);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        // 只许同源嵌入（宿主设置页 iframe）：防第三方页面内嵌本面板做点击劫持。
        "x-frame-options": "SAMEORIGIN",
        "content-security-policy": "frame-ancestors 'self'",
      });
      res.end(body);
    } catch (error) {
      log.error("panel 供给异常", error);
      writeJson(res, 500, { error: "panel unavailable" });
    }
  };
  // 面板纯逻辑静态供给（<script type="module"> 引用；与 Node 检查同一份文件）
  const servePanelLogic = (req, res) => {
    try {
      if (!guard(req, res)) return;
      const body = readFileSync(panelLogicPath);
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      res.end(body);
    } catch (error) {
      log.error("panel-logic 供给异常", error);
      writeJson(res, 500, { error: "panel-logic unavailable" });
    }
  };
  return [
    { kind: "exact", path: PANEL_PATH, handler: servePanel },
    { kind: "exact", path: `${PANEL_PATH}panel-logic.js`, handler: servePanelLogic },
    // 内核 prefix 语义（实证）：pathname === prefix || startsWith(prefix + "/")——
    // 注册无尾斜杠形态才能命中子路径。
    { kind: "prefix", path: PANEL_PATH.replace(/\/$/, ""), handler: servePanel },
    // 无尾斜杠形态同样供给（浏览器/手输常见）
    { kind: "exact", path: PANEL_PATH.replace(/\/$/, ""), handler: servePanel },
  ];
}

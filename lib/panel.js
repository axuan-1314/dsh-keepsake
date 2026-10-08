// dsh-memory 面板页供给（方案C §13）：/dsh-memory/panel/ 单文件 HTML。
//   readFileSync + no-cache（迭代期防旧页）；loopback 守卫与 api.js 同款。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isLoopbackRequest, writeJson } from "./api.js";

export const PANEL_PATH = "/dsh-memory/panel/";

const panelHtmlPath = fileURLToPath(new URL("../web/panel.html", import.meta.url));

export function makePanelRoutes(log = { error: () => {} }) {
  const servePanel = (req, res) => {
    try {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: "loopback requests only" });
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") });
        return;
      }
      const body = readFileSync(panelHtmlPath);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(body);
    } catch (error) {
      log.error("panel 供给异常", error);
      writeJson(res, 500, { error: "panel unavailable" });
    }
  };
  return [
    { kind: "exact", path: PANEL_PATH, handler: servePanel },
    // 内核 prefix 语义（实证）：pathname === prefix || startsWith(prefix + "/")——
    // 注册无尾斜杠形态才能命中子路径。
    { kind: "prefix", path: PANEL_PATH.replace(/\/$/, ""), handler: servePanel },
    // 无尾斜杠形态同样供给（浏览器/手输常见）
    { kind: "exact", path: PANEL_PATH.replace(/\/$/, ""), handler: servePanel },
  ];
}

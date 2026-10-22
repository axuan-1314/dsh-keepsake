// runtime-compile-memo：POST runtime/<scope>/compile 与 compile-all 必须通知接线层作废
// 注入侧进程内 memo（2026-10-22 补）。
//
// 背景：pin/evict/restore 三端点走 onGlobalWrite({runtimeHandled:true}) 清 memo；
// 但 compile / compile-all 只换产物、不动记忆目录，不经 onGlobalWrite。早先因此漏清——
// 点「重新编译」后最长 2 秒（RUNTIME_MEMO_TTL_MS=2000）内，注入仍拿重编前的旧产物文本
// 与旧覆盖集，用户看到「面板显示已重编、模型看到的还是旧的」。
//
// 本文件测**接线契约**：两个 compile 端点都必须调用 onRuntimeCompiled()。
// 该回调在 lib/index.js 里实现为 runtimeMemo.clear()（与 pin 路径同一收口）。
//
// 自拆改验证：删掉 lib/api.js 里任一 `onRuntimeCompiled()` 调用，对应用例必红。
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { API_PREFIX, makeApiRoutes } from "../lib/api.js";
import { createEntry } from "../lib/global-store.js";

const silentLog = { warn: () => {}, error: () => {}, info: () => {} };

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-rt-memo-"));
}

function mockReq({ method, url, body }) {
  const req = new Readable({
    read() {
      if (body !== void 0) this.push(typeof body === "string" ? body : JSON.stringify(body));
      this.push(null);
    },
  });
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1:3080" };
  req.socket = { remoteAddress: "127.0.0.1" };
  req.destroy = () => {};
  return req;
}

function mockRes() {
  return {
    status: 0,
    body: "",
    writeHead(status) {
      this.status = status;
    },
    end(chunk) {
      this.body = chunk ?? "";
    },
    get headersSent() {
      return this.status !== 0;
    },
  };
}

/**
 * 发一次真实 API 调用。makeApiRoutes 只返回一条 prefix 路由
 * （`{kind:"prefix", path:"/dsh-keepsake/api", handler}`），内部按 method+pathname 分发。
 */
async function callApi(storageRoot, hooks, { method, path, body }) {
  const [mount] = makeApiRoutes({ storageRoot, log: silentLog, onGlobalWrite: () => {}, ...hooks });
  const req = mockReq({ method, url: `${API_PREFIX}${path}`, body });
  const res = mockRes();
  await mount.handler(req, res);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

test("POST runtime/<scope>/compile 成功后必须调用 onRuntimeCompiled（否则注入侧 2s 内拿旧产物）", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "A", description: "d", content: "body" });
    let cleared = 0;
    const out = await callApi(root, { onRuntimeCompiled: () => { cleared += 1; } }, {
      method: "POST",
      path: "runtime/global/compile",
      body: {},
    });
    assert.equal(out.status, 200, "compile 应成功");
    assert.equal(cleared, 1, "compile 成功后必须通知接线层作废 memo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST runtime/compile-all 必须调用 onRuntimeCompiled（一次换新 N 份产物）", async () => {
  const root = freshRoot();
  try {
    createEntry(root, "work-profile", { title: "B", description: "d", content: "body" });
    let cleared = 0;
    const out = await callApi(root, { onRuntimeCompiled: () => { cleared += 1; } }, {
      method: "POST",
      path: "runtime/compile-all",
      body: {},
    });
    assert.equal(out.status, 200);
    assert.equal(cleared, 1, "compile-all 后必须通知接线层作废 memo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未知 scope 的 compile → 404，不宣称已重编", async () => {
  const root = freshRoot();
  try {
    const out = await callApi(root, {}, {
      method: "POST",
      path: "runtime/projects/nope-0123456789abcdef/compile",
      body: {},
    });
    assert.equal(out.status, 404, "未知 scope 必须 404");
    assert.equal(out.json?.code, "E_SCOPE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("接线层：lib/index.js 把 onRuntimeCompiled 实现为 runtimeMemo.clear()（源码契约）", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.match(src, /onRuntimeCompiled:\s*\(\)\s*=>\s*runtimeMemo\.clear\(\)/, "接线层必须把回调接到 runtimeMemo.clear()");
  // 且不得走 onGlobalWrite（那会触发滚动清理，与「只重编」语义不符）
  const line = src.split("\n").find((l) => l.includes("onRuntimeCompiled:")) ?? "";
  assert.doesNotMatch(line, /onGlobalWrite/, "compile 回调不得走 onGlobalWrite");
});

// corrections-wiring：纠错闭环的对外承诺，走 apply() 的真实接线。
//
// 补的正是「CHANGELOG 承诺了、实现是对的、但没有任何回归保护」的四条：
//   ① 并发第二次纠错 → 409 E_BUSY（单飞锁，单条 + 批量各一条）
//   ② 开关关 → 409 E_DISABLED（conversationMemory:false）
//   ③ ops 全被闸拦下 → 422 no-op-applied
//   ④ 批量里一条定位失败只废该条（P0-1：已落盘的条目不得从回报里消失）
// 前三条在检查里实测过「变异掉仍全绿」——实现没错，缺的是钉子。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { apply } from "../lib/index.js";
import { resetSettingsCache } from "../lib/settings.js";

const API_PATH = "/dsh-keepsake/api";

function fakeCtx({ stream = null } = {}) {
  const handlers = new Map();
  const webRoutes = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, handler) { handlers.set(event, handler); return () => {}; },
    effect(fn) {
      const dispose = typeof fn === "function" ? fn() : void 0;
      return typeof dispose === "function" ? dispose : () => {};
    },
    inject(deps, setup) {
      const scoped = {
        effect: (fn) => {
          const dispose = fn();
          return typeof dispose === "function" ? dispose : () => {};
        },
      };
      if (deps.includes("webServer")) {
        scoped.webServer = { register(route) { webRoutes.push(route); return () => {}; } };
      }
      setup(scoped);
    },
    systemPrompt: { section() { return () => {}; } },
    llm: { stream: stream ?? (async function* empty() {}) },
  };
  return { ctx, handlers, webRoutes };
}

function mockReq({ method, url, body }) {
  const req = new Readable({
    read() {
      if (body !== void 0) this.push(JSON.stringify(body));
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
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; },
    end(chunk) { this.body = chunk ?? ""; },
    get headersSent() { return this.status !== 0; },
  };
}

async function call(handler, { method, path, body }) {
  const req = mockReq({ method, url: path, body });
  const res = mockRes();
  await handler(req, res);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

/** 起一个带项目条目 + 已捕获路由的实例，返回 API handler 与探针句柄。 */
function boot({ storageRoot, stream, settings }) {
  const memoryDir = join(storageRoot, "projects", bootProjectId, "memory");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, "deploy.md"), [
    "---",
    'name: "deploy"',
    'description: "部署端口"',
    "metadata:",
    "  type: project",
    "---",
    "",
    "开发环境端口 3000。",
  ].join("\n"));
  writeFileSync(join(memoryDir, "MEMORY.md"), "- [部署端口](deploy.md) — 开发环境端口 3000\n");
  if (settings) writeFileSync(join(storageRoot, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

  const { ctx, handlers, webRoutes } = fakeCtx({ stream });
  apply(ctx, { enabled: true, storageRoot });
  // 捕获模型路由：resolveCorrectionContext 需要 last-known provider/model
  handlers.get("session/event")(
    { id: "session-cw", header: { cwd: storageRoot } },
    { type: "request/header", data: { header: { config: { provider: "p", model: "m" } } } },
  );
  const route = webRoutes.find((r) => r.kind === "prefix");
  assert.ok(route, "应注册 /dsh-keepsake/api 前缀路由");
  return { handler: route.handler, handlers, memoryDir };
}

let bootProjectId = "";
function newRoot() {
  // isValidProjectId 要求 <slug>-<16位十六进制>（与 lib/pages.js 同款正则）
  const hash = Math.random().toString(16).slice(2).padEnd(16, "0").slice(0, 16);
  bootProjectId = `cw-${hash}`;
  const root = mkdtempSync(join(tmpdir(), "dsh-keepsake-cw-"));
  return root;
}

/** 等第一次调用真正进入 LLM 流（忙等会挂死测试，用信号 + 兜底超时）。 */
async function waitFor(fn, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时：条件始终未满足");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("纠错并发：第二次 POST correct → 409 E_BUSY（单飞锁，不排队不重试）", async () => {
  resetSettingsCache();
  const root = newRoot();
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    async function* stream() {
      calls += 1;
      await gate; // 挂住第一次调用，让第二次撞上单飞
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { handler } = boot({ storageRoot: root, stream });
    const first = call(handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct`,
      body: { target: "deploy.md", reason: "端口现在是 8080", projectId: bootProjectId },
    });
    // 等第一次真正进入 LLM 调用再打第二次
    await waitFor(() => calls > 0);
    const second = await call(handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct`,
      body: { target: "deploy.md", reason: "端口现在是 8080", projectId: bootProjectId },
    });
    assert.equal(second.status, 409, JSON.stringify(second.json));
    assert.equal(second.json.code, "E_BUSY");
    release();
    await first;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("批量纠错并发：执行期间单条入口也拒绝 → 409 E_BUSY", async () => {
  resetSettingsCache();
  const root = newRoot();
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    async function* stream() {
      calls += 1;
      await gate;
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { handler } = boot({ storageRoot: root, stream });
    const batch = call(handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct-batch`,
      body: { items: [{ target: "deploy.md", reason: "端口现在是 8080", projectId: bootProjectId }] },
    });
    await waitFor(() => calls > 0);
    const single = await call(handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct`,
      body: { target: "deploy.md", reason: "端口现在是 8080", projectId: bootProjectId },
    });
    assert.equal(single.status, 409, JSON.stringify(single.json));
    assert.equal(single.json.code, "E_BUSY");
    release();
    await batch;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("纠错开关关（conversationMemory:false）→ 409 E_DISABLED，一次调用都不发", async () => {
  resetSettingsCache();
  const root = newRoot();
  try {
    let calls = 0;
    async function* stream() {
      calls += 1;
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { handler } = boot({
      storageRoot: root,
      stream,
      settings: { version: 1, conversationMemory: false, projectMemory: true, globalExtraction: true },
    });
    const out = await call(handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct`,
      body: { target: "deploy.md", reason: "端口现在是 8080", projectId: bootProjectId },
    });
    assert.equal(out.status, 409, JSON.stringify(out.json));
    assert.equal(out.json.code, "E_DISABLED");
    assert.equal(calls, 0, "开关关时不该发任何 LLM 调用");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("纠错 ops 全被闸拦下 → 422 no-op-applied，不谎报 applied", async () => {
  resetSettingsCache();
  const root = newRoot();
  try {
    // 模型产出 ops 但 applyOps 返回 0 写 0 删（sha1 不符/校验失败时就是这样）
    async function* stream() {
      yield { type: "text-delta", text: JSON.stringify({ ops: [] }) };
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { handler } = boot({ storageRoot: root, stream });
    const out = await call(handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct`,
      body: { target: "deploy.md", reason: "端口现在是 8080", projectId: bootProjectId },
    });
    assert.equal(out.status, 422, JSON.stringify(out.json));
    assert.equal(out.json.code, "no-op-applied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("批量纠错：一条定位失败只废该条，已落盘条目必须留在 results 里", async () => {
  resetSettingsCache();
  const root = newRoot();
  try {
    // 第二条 scope 非法 → 定位阶段就抛 E_INVALID_SCOPE；
    // 第一条必须真的落盘，且逐条结局都要出现在回报里（不许整批消失）。
    const { createHash } = await import("node:crypto");
    let sha = null;
    async function* stream() {
      // sha1 要对着盘上真值算，而 boot() 才创建文件——故在流首次被拉取时算
      const target = join(root, "projects", bootProjectId, "memory", "deploy.md");
      if (sha === null) sha = createHash("sha1").update(readFileSync(target, "utf8"), "utf8").digest("hex").slice(0, 8);
      yield {
        type: "text-delta",
        text: JSON.stringify({
          ops: [{
            action: "write", name: "deploy.md", scope: "project", type: "project",
            title: "T", description: "d", sha1: sha, content: "开发环境端口 8080。",
          }],
        }),
      };
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { handler, memoryDir } = boot({ storageRoot: root, stream });
    const out = await call(handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct-batch`,
      body: {
        items: [
          { target: "deploy.md", reason: "端口现在是 8080", scope: "project", projectId: bootProjectId },
          { target: "deploy.md", reason: "端口现在是 8080", scope: "global:BAD" },
        ],
      },
    });
    // 整批不许因第二条的定位失败而 400/500
    assert.equal(out.status, 200, JSON.stringify(out.json));
    assert.equal(out.json.outcome, "partial", `应报 partial，实际 ${out.json.outcome}`);
    assert.equal(out.json.results.length, 2, "两条的结局都要在 results 里");
    const good = out.json.results.find((r) => r.target === "deploy.md" && r.outcome === "applied");
    assert.ok(good, "已落盘的那条必须报 applied");
    const bad = out.json.results.find((r) => r.outcome === "error");
    assert.ok(bad, "定位失败的那条必须报 error");
    assert.match(String(bad.error ?? ""), /E_INVALID_SCOPE/);
    // 盘上确实改了
    assert.match(readFileSync(join(memoryDir, "deploy.md"), "utf8"), /8080/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("批量纠错：全批 needs-input → no-change（不是失败，与单条 needs-input 同口径）", async () => {
  resetSettingsCache();
  const root = newRoot();
  try {
    async function* stream() {
      yield { type: "text-delta", text: "NEEDS_USER_INPUT" };
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { handler } = boot({ storageRoot: root, stream });
    const out = await call(handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct-batch`,
      body: {
        items: [
          { target: "deploy.md", reason: "说不清哪错了", projectId: bootProjectId },
          { target: "deploy.md", reason: "也说不太清", projectId: bootProjectId },
        ],
      },
    });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    assert.equal(out.json.outcome, "no-change", `应报 no-change，实际 ${out.json.outcome}`);
    assert.equal(out.json.failed, 0, "needs-input 不计失败");
    assert.equal(out.json.writes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("纠错记录：recent 与盘上 ledger 行数一致（计了要能读到）", async () => {
  resetSettingsCache();
  const root = newRoot();
  try {
    const { createHash } = await import("node:crypto");
    let sha = null;
    async function* stream() {
      // sha1 对着盘上真值算（文件由 boot() 创建，故在流首次被拉取时算）
      if (sha === null) {
        sha = createHash("sha1")
          .update(readFileSync(join(root, "projects", bootProjectId, "memory", "deploy.md"), "utf8"), "utf8")
          .digest("hex").slice(0, 8);
      }
      yield {
        type: "text-delta",
        text: JSON.stringify({
          ops: [{
            action: "write", name: "deploy.md", scope: "project", type: "project",
            title: "T", description: "d", sha1: sha, content: "开发环境端口 8080。",
          }],
        }),
      };
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { handler } = boot({ storageRoot: root, stream });
    const out = await call(handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct`,
      body: { target: "deploy.md", reason: "端口现在是 8080", scope: "project", projectId: bootProjectId },
    });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    assert.equal(out.json.outcome, "applied");

    const recent = await call(handler, { method: "GET", path: `${API_PATH}/corrections/recent?limit=20` });
    assert.equal(recent.status, 200);
    assert.equal(recent.json.entries.length, 1, "ledger 落了一条，recent 就该读到一条");
    assert.equal(recent.json.entries[0].outcome, "applied");

    const grouped = await call(handler, { method: "GET", path: `${API_PATH}/corrections/by-target?target=deploy.md` });
    assert.equal(grouped.status, 200);
    assert.equal(grouped.json.total, 1, "按条目归组要能归出这一条（applied 才有盘上后果）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// P0-2 回归：纠错读目标必须与落盘同口径（resolveSafeMemoryTarget）。
//
// 原始实现是 `join(memoryDir, target).startsWith(memoryDir)`——字符串前缀比对，
// 而 "<memDir>-extra/secret.md" 天然以 memDir 开头，于是记忆目录外的文件会被
// 原样读出、当成 currentBody 塞进提示词（已实测复现）。
//
// 判据必须看「模型收到的提示词里有没有那个机密串」：只看盘上后效抓不住
// （读出来也未必写回去），只看最终 outcome 也抓不住（能读到的条目依然会被正常纠正）。
test("纠错读取：兄弟目录路径不得被读到（防止把记忆目录外内容喂给模型）", async () => {
  resetSettingsCache();
  const root = newRoot();
  // 攻击路径 ../memory-extra/secret.md 经 join 规范化后是 "<memDir>-extra/secret.md"，
  // 天然以 memDir 开头 → 字符串前缀判据会放行。所以兄弟目录必须按这个形态构造。
  const sibling = join(root, "projects", bootProjectId, "memory-extra");
  try {
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "secret.md"), "TOPSECRET-OUTSIDE-MEMORY");

    // ctx.llm.stream(options) 的 options.messages 里就是模型实际收到的正文
    const seen = [];
    async function* stream(options) {
      seen.push(JSON.stringify(options ?? {}));
      yield { type: "text-delta", text: "NEEDS_USER_INPUT" };
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { handler } = boot({ storageRoot: root, stream });
    await call(handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct`,
      body: {
        target: "../memory-extra/secret.md",
        reason: "内容需要更正",
        scope: "project",
        projectId: bootProjectId,
      },
    });
    assert.ok(seen.length > 0, "必须真的发出了模型调用，否则这条测试没有判据");
    const prompt = seen.join("\n");
    assert.ok(!prompt.includes("TOPSECRET-OUTSIDE-MEMORY"), "记忆目录外文件内容不得进提示词");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 反向约束：安全闸不能把**目录内的真实文件名**也挡掉。
// resolveSafeMemoryTarget 会 sanitize（"我的笔记.md"→"md.md"、"Deploy.md"→"deploy.md"），
// 而记忆条目可能不经本插件落盘（手工放入 / 整目录拷贝 / git checkout），
// 那种条目按 sanitize 后的路径找不到 → 读回空串 → 模型按「空条目」处理。
test("纠错读取：目录内非规范化真实文件名（中文/大写/空格）仍能读到正文", async () => {
  resetSettingsCache();
  const root = newRoot();
  try {
    const seen = [];
    async function* stream(options) {
      seen.push(JSON.stringify(options ?? {}));
      yield { type: "text-delta", text: "NEEDS_USER_INPUT" };
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { handler, memoryDir } = boot({ storageRoot: root, stream });
    // 手工放入一个「名字不合 sanitize 规则」但确实在记忆目录内的条目
    writeFileSync(join(memoryDir, "我的笔记.md"), "---\ntitle: 手工笔记\n---\n正文里有 MANUAL-NOTE-BODY 这个串。\n");
    await call(handler, {
      method: "POST",
      path: `${API_PATH}/corrections/correct`,
      body: { target: "我的笔记.md", reason: "内容需要更正", scope: "project", projectId: bootProjectId },
    });
    assert.ok(seen.length > 0, "必须真的发出了模型调用");
    assert.ok(seen.join("\n").includes("MANUAL-NOTE-BODY"), "目录内的真实条目正文必须被读到（不能被 sanitize 改写后读空）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 上一条的**反向**约束：放宽成「只要在根内就读」会把非条目文件也喂给模型。
// 精确匹配分支必须保留落盘侧的段级闸（拒索引名 / 黑名单段 / 非 .md）。
test("纠错读取：目录内的非条目文件（索引/黑名单段/非 md）不得进提示词", async () => {
  resetSettingsCache();
  const root = newRoot();
  try {
    const seen = [];
    async function* stream(options) {
      seen.push(JSON.stringify(options ?? {}));
      yield { type: "text-delta", text: "NEEDS_USER_INPUT" };
      yield { type: "finish", reason: { kind: "stop" } };
    }
    const { handler, memoryDir } = boot({ storageRoot: root, stream });

    // 三种都确实落在记忆目录内，但都不是「记忆条目」
    writeFileSync(join(memoryDir, "MEMORY.md"), "- [索引](x.md) — INDEXMARKER-LEAK\n");
    writeFileSync(join(memoryDir, ".env"), "SECRET_KEY=ENVFILE-LEAK\n");
    mkdirSync(join(memoryDir, "skills"), { recursive: true });
    writeFileSync(join(memoryDir, "skills", "s.md"), "SKILLS-LEAK\n");

    for (const target of ["MEMORY.md", ".env", "skills/s.md"]) {
      await call(handler, {
        method: "POST",
        path: `${API_PATH}/corrections/correct`,
        body: { target, reason: "内容需要更正", scope: "project", projectId: bootProjectId },
      });
    }
    const prompt = seen.join("\n");
    assert.ok(seen.length > 0, "必须真的发出了模型调用");
    for (const marker of ["INDEXMARKER-LEAK", "ENVFILE-LEAK", "SKILLS-LEAK"]) {
      assert.ok(!prompt.includes(marker), `${marker} 不得进提示词（非条目文件不该被当记忆正文）`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// P1-3 回归：按条目归组必须扫全量记录。
// readCorrectionLedger 是「从尾部读 N 条」，若归组套 limit（旧实现是 maxGroups*4），
// 历史超过该窗口的条目会查出来是「没有改过」——用户据此判断要不要再纠一次，
// 静默丢历史比丢计数更糟。
test("纠错归组：历史超过读取窗口的条目仍能查出（按条目视图不得静默丢历史）", async () => {
  resetSettingsCache();
  const root = newRoot();
  try {
    const { handler } = boot({ storageRoot: root, stream: async function* () { yield { type: "finish", reason: { kind: "stop" } }; } });
    // 直接铺 300 行 ledger：第 1 行是最老的（会被尾部读取窗口挤掉）
    const lines = [];
    for (let i = 0; i < 300; i++) {
      lines.push(JSON.stringify({
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        outcome: "applied",
        kind: "wrong-fact",
        target: i === 0 ? "oldest.md" : `f${i}.md`,
        scope: "project",
        writes: 1,
        deletes: 0,
      }));
    }
    writeFileSync(join(root, "correction-ledger.jsonl"), `${lines.join("\n")}\n`);

    const oldest = await call(handler, {
      method: "GET",
      path: `${API_PATH}/corrections/by-target?target=oldest.md&maxGroups=50`,
    });
    assert.equal(oldest.status, 200, JSON.stringify(oldest.json));
    assert.equal(oldest.json.total, 1, "最老的那条记录必须能归出组（旧实现会返回 0）");
    assert.equal(oldest.json.groups[0].target, "oldest.md");
    assert.equal(oldest.json.groups[0].count, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

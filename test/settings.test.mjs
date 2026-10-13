// settings：settings.json 读取（缺省/损坏/mtime 缓存）与合并式原子写入。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultSettings, effectiveEmbedding, readSettings, resetSettingsCache, settingsPath, writeSettings } from "../lib/settings.js";

function freshRoot() {
  resetSettingsCache();
  return mkdtempSync(join(tmpdir(), "dsh-memory-settings-"));
}

test("缺省：文件不存在 = 三开关全开（R4）", () => {
  const root = freshRoot();
  try {
    const s = readSettings(root);
    assert.equal(s.version, 1);
    assert.equal(s.conversationMemory, true);
    assert.equal(s.projectMemory, true);
    assert.equal(s.globalExtraction, true);
    assert.equal(s.corrupt, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("读取：显式 false 被保留，缺省键回填 true", () => {
  const root = freshRoot();
  try {
    writeFileSync(settingsPath(root), JSON.stringify({ conversationMemory: false }), "utf8");
    const s = readSettings(root);
    assert.equal(s.conversationMemory, false);
    assert.equal(s.projectMemory, true);
    assert.equal(s.globalExtraction, true);
    assert.equal(s.corrupt, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("读取：非 boolean 值按 true 处理（!== false）", () => {
  const root = freshRoot();
  try {
    writeFileSync(settingsPath(root), JSON.stringify({ conversationMemory: 0, projectMemory: null }), "utf8");
    const s = readSettings(root);
    assert.equal(s.conversationMemory, true);
    assert.equal(s.projectMemory, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("损坏：非法 JSON = corrupt 标记 + 按缺省全开（可见降级不炸）", () => {
  const root = freshRoot();
  try {
    writeFileSync(settingsPath(root), "{not json", "utf8");
    const warns = [];
    const s = readSettings(root, { warn: (m) => warns.push(m) });
    assert.equal(s.conversationMemory, true);
    assert.equal(s.projectMemory, true);
    assert.equal(s.corrupt, true);
    assert.equal(warns.length, 1); // 显式 warn（不静默）
    assert.match(warns[0], /解析失败/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("损坏：顶层非对象 = corrupt + 缺省", () => {
  const root = freshRoot();
  try {
    writeFileSync(settingsPath(root), "[1,2,3]", "utf8");
    const s = readSettings(root, { warn: () => {} });
    assert.equal(s.corrupt, true);
    assert.equal(s.conversationMemory, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mtime 缓存：同 mtime+size 不重读；文件变更后重读生效", () => {
  const root = freshRoot();
  try {
    const path = settingsPath(root);
    writeFileSync(path, JSON.stringify({ conversationMemory: false }), "utf8");
    const first = readSettings(root);
    assert.equal(first.conversationMemory, false);
    // 改内容（mtime 变）→ 重读
    writeFileSync(path, JSON.stringify({ conversationMemory: true, projectMemory: false }), "utf8");
    const second = readSettings(root);
    assert.equal(second.conversationMemory, true);
    assert.equal(second.projectMemory, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("写入：合并式 patch（未提及键保持现值）", () => {
  const root = freshRoot();
  try {
    writeSettings(root, { conversationMemory: false });
    const next = writeSettings(root, { globalExtraction: false });
    assert.equal(next.conversationMemory, false); // 保持
    assert.equal(next.projectMemory, true);
    assert.equal(next.globalExtraction, false);
    // 落盘内容三键齐全 + version
    const onDisk = JSON.parse(readFileSync(settingsPath(root), "utf8"));
    assert.deepEqual(Object.keys(onDisk).sort(), ["conversationMemory", "globalExtraction", "projectMemory", "version"]);
    assert.equal(onDisk.version, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("写入：非 boolean 键被忽略", () => {
  const root = freshRoot();
  try {
    const next = writeSettings(root, { conversationMemory: "no", projectMemory: 1 });
    assert.equal(next.conversationMemory, true);
    assert.equal(next.projectMemory, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("写入：目录不存在时自动创建（原子写 tmp+rename，无 .tmp 残留）", () => {
  const root = freshRoot();
  try {
    const nested = join(root, "a", "b");
    writeSettings(nested, { projectMemory: false });
    assert.equal(existsSync(settingsPath(nested)), true);
    const s = readSettings(nested);
    assert.equal(s.projectMemory, false);
    // 原子写无 tmp 残留
    const leftovers = readdirSync(nested).filter((f) => f.includes(".tmp-"));
    assert.equal(leftovers.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("写入后读取立即可见（缓存失效）", () => {
  const root = freshRoot();
  try {
    readSettings(root); // 建立缓存（不存在=缺省）
    writeSettings(root, { conversationMemory: false });
    const s = readSettings(root);
    assert.equal(s.conversationMemory, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("defaultSettings：每次返回新对象（防外部篡改共享态）", () => {
  const a = defaultSettings();
  const b = defaultSettings();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
});

test("settingsPath：落在 storageRoot 下（不越界）", () => {
  assert.equal(settingsPath("/x/y"), join("/x/y", "settings.json"));
});

test("embedding：面板写入 round-trip + 校验（开启需端点/模型、URL 限 http(s)、null 清除）", () => {
  const root = freshRoot();
  try {
    assert.throws(() => writeSettings(root, { embedding: { enabled: true, model: "m" } }), /端点/);
    assert.throws(() => writeSettings(root, { embedding: { enabled: true, baseUrl: "http://x" } }), /模型/);
    assert.throws(() => writeSettings(root, { embedding: { enabled: false, baseUrl: "file:///etc/passwd" } }), /http/);
    assert.throws(() => writeSettings(root, { embedding: { enabled: false, baseUrl: "not a url" } }), /URL/);
    const w = writeSettings(root, { embedding: { enabled: true, baseUrl: "http://127.0.0.1:11434/v1/embeddings", model: "nomic-embed-text", provider: "ollama", apiKey: "k" } });
    assert.equal(w.embedding.enabled, true);
    assert.equal(readSettings(root).embedding.baseUrl, "http://127.0.0.1:11434/v1/embeddings");
    assert.equal(readSettings(root).embedding.apiKey, "k");
    // 未提及 embedding → 保留现值
    assert.equal(writeSettings(root, { conversationMemory: false }).embedding.model, "nomic-embed-text");
    // 显式清除（null）→ 回到 entry config
    assert.equal(writeSettings(root, { embedding: null }).embedding, void 0);
    assert.equal(readSettings(root).embedding, void 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effectiveEmbedding：面板设置优先于 entry config（含显式关闭覆盖开启）", () => {
  const cfg = { recallEnabled: false, embeddingBaseUrl: "", embeddingModel: "", embeddingProvider: "", embeddingApiKey: "", recallTopK: 5, recallMinScore: 0.35, recallTimeoutMs: 8000 };
  const fromCfg = effectiveEmbedding(cfg, {});
  assert.equal(fromCfg.source, "config");
  assert.equal(fromCfg.enabled, false);
  const fromSettings = effectiveEmbedding(cfg, { embedding: { enabled: true, baseUrl: "http://h/v1/embeddings", model: "m", provider: "", apiKey: "" } });
  assert.equal(fromSettings.source, "settings");
  assert.equal(fromSettings.enabled, true);
  assert.equal(fromSettings.baseUrl, "http://h/v1/embeddings");
  assert.equal(fromSettings.topK, 5);
  const off = effectiveEmbedding({ ...cfg, recallEnabled: true }, { embedding: { enabled: false, baseUrl: "http://h", model: "m" } });
  assert.equal(off.enabled, false, "面板显式关闭覆盖 entry 的开启");
});

// settings：settings.json 读取（缺省/损坏/mtime 缓存）与合并式原子写入。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultSettings, effectiveEmbedding, readSettings, resetSettingsCache, settingsPath, writeSettings } from "../lib/settings.js";

function freshRoot() {
  resetSettingsCache();
  return mkdtempSync(join(tmpdir(), "dsh-keepsake-settings-"));
}

test("缺省：文件不存在 = 三开关全开", () => {
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
    // v0.4.0：安全面三项并入 settings（缺键走默认，旧 settings.json 无需迁移）
    assert.deepEqual(Object.keys(onDisk).sort(), ["conversationMemory", "globalExtraction", "hardfactPolicy", "projectMemory", "surgicalKeep", "trashKeepDays", "version"]);
    assert.equal(onDisk.version, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("写入：安全面三项单键 patch 不重置（拨开关/存嵌入配置后 surgicalKeep/trashKeepDays/hardfactPolicy 保持现值）", () => {
  const root = freshRoot();
  try {
    writeSettings(root, { surgicalKeep: 5, trashKeepDays: 7, hardfactPolicy: "block" });
    const next = writeSettings(root, { conversationMemory: false });
    assert.equal(next.conversationMemory, false); // 本键已改
    assert.equal(next.surgicalKeep, 5);
    assert.equal(next.trashKeepDays, 7);
    assert.equal(next.hardfactPolicy, "block");
    // 读回与落盘都是现值（不是默认 30/30/warn）
    const s = readSettings(root);
    assert.equal(s.surgicalKeep, 5);
    assert.equal(s.trashKeepDays, 7);
    assert.equal(s.hardfactPolicy, "block");
    const onDisk = JSON.parse(readFileSync(settingsPath(root), "utf8"));
    assert.equal(onDisk.surgicalKeep, 5);
    assert.equal(onDisk.trashKeepDays, 7);
    assert.equal(onDisk.hardfactPolicy, "block");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("写入：安全面数值显式非法 → 落默认（读侧同口径，绝不 throw）", () => {
  const root = freshRoot();
  try {
    writeSettings(root, { surgicalKeep: 5, trashKeepDays: 7 });
    assert.equal(writeSettings(root, { surgicalKeep: -1 }).surgicalKeep, 30); // 越界（负）
    assert.equal(writeSettings(root, { surgicalKeep: "abc" }).surgicalKeep, 30); // 非有限数
    assert.equal(writeSettings(root, { surgicalKeep: 0 }).surgicalKeep, 30); // 正整数，0 非法
    assert.equal(writeSettings(root, { surgicalKeep: 2.5 }).surgicalKeep, 30); // 非整数
    assert.equal(readSettings(root).trashKeepDays, 7); // 非法 surgicalKeep 不波及 trashKeepDays
    assert.equal(writeSettings(root, { trashKeepDays: -1 }).trashKeepDays, 30); // 越界（负）
    assert.equal(writeSettings(root, { trashKeepDays: "abc" }).trashKeepDays, 30); // 非有限数
    assert.equal(writeSettings(root, { trashKeepDays: 0 }).trashKeepDays, 0); // ≥0 合法（0 天 = 当天清）
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("写入：安全面数值显式非数值（null/false/空串/空白串/数字字符串）→ 落默认，不与合法 0 混淆", () => {
  const root = freshRoot();
  try {
    // trashKeepDays：过去 Number(null)/Number(false)/Number("")/Number("  ") 都=0，
    // 会被当成合法「0 天=立即清空」，方向危险；收紧后一律落默认 30。
    assert.equal(writeSettings(root, { trashKeepDays: null }).trashKeepDays, 30);
    assert.equal(writeSettings(root, { trashKeepDays: false }).trashKeepDays, 30);
    assert.equal(writeSettings(root, { trashKeepDays: "" }).trashKeepDays, 30);
    assert.equal(writeSettings(root, { trashKeepDays: "  " }).trashKeepDays, 30);
    assert.equal(writeSettings(root, { trashKeepDays: "30" }).trashKeepDays, 30); // 数字字符串不是数字
    assert.equal(writeSettings(root, { trashKeepDays: true }).trashKeepDays, 30); // 布尔 true 也非数字
    // 合法数字 0 仍有效（0 天 = 立即清空是合法配置）
    assert.equal(writeSettings(root, { trashKeepDays: 0 }).trashKeepDays, 0);
    // surgicalKeep 同口径：非数值走默认 30，合法正整数保持
    assert.equal(writeSettings(root, { surgicalKeep: null }).surgicalKeep, 30);
    assert.equal(writeSettings(root, { surgicalKeep: false }).surgicalKeep, 30);
    assert.equal(writeSettings(root, { surgicalKeep: "" }).surgicalKeep, 30);
    assert.equal(writeSettings(root, { surgicalKeep: "5" }).surgicalKeep, 30); // 数字字符串不是数字
    assert.equal(writeSettings(root, { surgicalKeep: 5 }).surgicalKeep, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("读取：盘上历史非数值/数字字符串 → 落默认 30（与默认一致，无感）", () => {
  const root = freshRoot();
  try {
    // 历史值若是数字字符串（JSON 里写成 "30"）→ 回到默认 30（值相同，无感）
    writeFileSync(settingsPath(root), JSON.stringify({ surgicalKeep: "30", trashKeepDays: null }), "utf8");
    const s = readSettings(root);
    assert.equal(s.surgicalKeep, 30);
    assert.equal(s.trashKeepDays, 30);
    // 显式数字 0 读回仍是 0（合法配置不被抬回默认）
    writeFileSync(settingsPath(root), JSON.stringify({ trashKeepDays: 0 }), "utf8");
    assert.equal(readSettings(root).trashKeepDays, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("写入：安全面显式合法 patch 只改一键（另一键与 hardfactPolicy 不重置）", () => {
  const root = freshRoot();
  try {
    writeSettings(root, { surgicalKeep: 5, trashKeepDays: 7, hardfactPolicy: "block" });
    let next = writeSettings(root, { surgicalKeep: 9 });
    assert.equal(next.surgicalKeep, 9);
    assert.equal(next.trashKeepDays, 7); // 未提及 → 保持现值
    assert.equal(next.hardfactPolicy, "block"); // 未提及 → 保持现值
    next = writeSettings(root, { trashKeepDays: 3 });
    assert.equal(next.trashKeepDays, 3);
    assert.equal(next.surgicalKeep, 9); // 未提及 → 保持现值
    assert.equal(next.hardfactPolicy, "block");
    next = writeSettings(root, { surgicalKeep: 11, trashKeepDays: 1, hardfactPolicy: "warn" });
    assert.deepEqual([next.surgicalKeep, next.trashKeepDays, next.hardfactPolicy], [11, 1, "warn"]);
    // 显式 undefined 视为未提供
    next = writeSettings(root, { surgicalKeep: undefined });
    assert.equal(next.surgicalKeep, 11);
    assert.equal(next.trashKeepDays, 1);
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

test("embedding.apiKey 三态：键缺省=保留已存密钥（面板重存不顶掉）", () => {
  const root = freshRoot();
  try {
    writeSettings(root, { embedding: { enabled: true, baseUrl: "http://h/v1/embeddings", model: "m", apiKey: "secret" } });
    // 面板重存嵌入配置（不带 apiKey 键）——已存密钥必须保留（此前会顶成 ""）
    const again = writeSettings(root, { embedding: { enabled: true, baseUrl: "http://h2/v1/embeddings", model: "m2" } });
    assert.equal(again.embedding.apiKey, "secret");
    assert.equal(again.embedding.baseUrl, "http://h2/v1/embeddings"); // 其余字段照常覆盖
    assert.equal(readSettings(root).embedding.apiKey, "secret"); // 盘上也在
    // 显式 undefined（键存在但值 undefined）= 键缺省语义 → 保留
    const undef = writeSettings(root, { embedding: { enabled: true, baseUrl: "http://h2/v1/embeddings", model: "m2", apiKey: undefined } });
    assert.equal(undef.embedding.apiKey, "secret");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("embedding.apiKey 键缺省 + 密钥来自 entry config（fallbackApiKey 兜底）→ 接管而非遮蔽", () => {
  const root = freshRoot();
  try {
    // settings 尚无 embedding 覆盖；api 层把生效的 config 密钥作兜底传入。
    // 不接管的话，新写入的 settings.embedding.apiKey:"" 会遮蔽 YAML 里配置的密钥。
    const took = writeSettings(root, { embedding: { enabled: true, baseUrl: "http://h/v1/embeddings", model: "m" } }, void 0, { fallbackApiKey: "cfg-key" });
    assert.equal(took.embedding.apiKey, "cfg-key", "config 密钥被接管进 settings");
    // 已显式清空（""）后，兜底不得复活它（?? 不跳过空串，显式清除语义优先）
    writeSettings(root, { embedding: { apiKey: null } });
    const keptClear = writeSettings(root, { embedding: { enabled: true, baseUrl: "http://h/v1/embeddings", model: "m" } }, void 0, { fallbackApiKey: "cfg-key" });
    assert.equal(keptClear.embedding.apiKey, "", "显式清空过的密钥不被 fallback 复活");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("embedding.apiKey 三态：null / \"\" 显式清空 → 落空串", () => {
  const root = freshRoot();
  try {
    writeSettings(root, { embedding: { enabled: true, baseUrl: "http://h/v1/embeddings", model: "m", apiKey: "secret" } });
    const clearedNull = writeSettings(root, { embedding: { enabled: true, baseUrl: "http://h/v1/embeddings", model: "m", apiKey: null } });
    assert.equal(clearedNull.embedding.apiKey, "");
    assert.equal(readSettings(root).embedding.apiKey, "");
    // 再存一轮非空值，然后用空串清空
    writeSettings(root, { embedding: { enabled: true, baseUrl: "http://h/v1/embeddings", model: "m", apiKey: "k2" } });
    assert.equal(readSettings(root).embedding.apiKey, "k2");
    const clearedEmpty = writeSettings(root, { embedding: { enabled: true, baseUrl: "http://h/v1/embeddings", model: "m", apiKey: "" } });
    assert.equal(clearedEmpty.embedding.apiKey, "");
    assert.equal(readSettings(root).embedding.apiKey, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("embedding.apiKey 三态：非空字符串=新值覆盖", () => {
  const root = freshRoot();
  try {
    writeSettings(root, { embedding: { enabled: true, baseUrl: "http://h/v1/embeddings", model: "m", apiKey: "old" } });
    const next = writeSettings(root, { embedding: { enabled: true, baseUrl: "http://h/v1/embeddings", model: "m", apiKey: "new" } });
    assert.equal(next.embedding.apiKey, "new");
    assert.equal(readSettings(root).embedding.apiKey, "new");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("embedding：enabled 校验不因 apiKey 三态回归（开启仍需端点/模型；URL 限 http(s)）", () => {
  const root = freshRoot();
  try {
    // 已存一份完整配置
    writeSettings(root, { embedding: { enabled: true, baseUrl: "http://h/v1/embeddings", model: "m", apiKey: "k" } });
    // 重存时缺端点/模型仍必须显式抛（不被 apiKey 保留逻辑吞掉）
    assert.throws(() => writeSettings(root, { embedding: { enabled: true, model: "m" } }), /端点/);
    assert.throws(() => writeSettings(root, { embedding: { enabled: true, baseUrl: "http://h/v1/embeddings" } }), /模型/);
    assert.throws(() => writeSettings(root, { embedding: { enabled: false, baseUrl: "ftp://h/x", apiKey: "k" } }), /http/);
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

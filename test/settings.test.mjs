// settings：settings.json 读取（缺省/损坏/mtime 缓存）与合并式原子写入。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultSettings, effectiveEmbedding, getSettingsDiagnostics, readSettings, resetSettingsCache, settingsLastGoodPath, settingsPath, validateSettingsNumber, writeSettings } from "../lib/settings.js";

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

test("runtimeEnabled：缺省关（只有显式 true 才开，与三开关的 !== false 反向）", () => {
  const root = freshRoot();
  try {
    // 缺省（文件不存在）→ false
    assert.equal(defaultSettings().runtimeEnabled, false, "defaultSettings 缺省 false");
    assert.equal(readSettings(root).runtimeEnabled, false, "全新安装不打开 runtime");
    // 缺键（旧 settings.json）→ false（不迁移、不 fail-open）
    writeFileSync(settingsPath(root), JSON.stringify({ conversationMemory: true }), "utf8");
    assert.equal(readSettings(root).runtimeEnabled, false, "旧 settings.json 缺键 = 关");
    // 显式 true → true；非布尔（"true"/1/null）一律 false（严格 === true）
    writeFileSync(settingsPath(root), JSON.stringify({ runtimeEnabled: true }), "utf8");
    assert.equal(readSettings(root).runtimeEnabled, true);
    for (const bogus of ["true", 1, null, {}]) {
      writeFileSync(settingsPath(root), JSON.stringify({ runtimeEnabled: bogus }), "utf8");
      assert.equal(readSettings(root).runtimeEnabled, false, `非布尔 ${JSON.stringify(bogus)} 按关处理`);
    }
    // patch 合并：未提及 → 保留现值；显式 false → 关
    writeSettings(root, { runtimeEnabled: true });
    assert.equal(readSettings(root).runtimeEnabled, true);
    assert.equal(writeSettings(root, { conversationMemory: false }).runtimeEnabled, true, "未提及的 runtimeEnabled 保持现值");
    assert.equal(writeSettings(root, { runtimeEnabled: false }).runtimeEnabled, false, "显式 false 生效");
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

test("损坏 + 无 last-good：corrupt 标记 + 按缺省全开（可见降级不炸）", () => {
  const root = freshRoot();
  try {
    writeFileSync(settingsPath(root), "{not json", "utf8");
    const warns = [];
    const s = readSettings(root, { warn: (m) => warns.push(m) });
    assert.equal(s.conversationMemory, true);
    assert.equal(s.projectMemory, true);
    assert.equal(s.corrupt, true);
    assert.ok(warns.length >= 1, "显式 warn（不静默）");
    assert.ok(warns.some((m) => /解析失败/.test(m)));
    // 原损坏档改名存证（settings.json.corrupt-<ts>，原内容永不失访）
    const corruptLeftovers = readdirSync(root).filter((f) => f.startsWith("settings.json.corrupt-"));
    assert.equal(corruptLeftovers.length, 1, "损坏档被改名存证");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("损坏 + 有 last-good：从影子恢复原开关值 + corrupt 标记（关过的开关不被静默打开）", () => {
  const root = freshRoot();
  try {
    // 先正常写入一份（同时刷新 last-good 影子）：用户把对话记忆关掉
    writeSettings(root, { conversationMemory: false, projectMemory: false, globalExtraction: true, trashKeepDays: 7 });
    assert.equal(existsSync(settingsLastGoodPath(root)), true, "成功写入刷新 last-good 影子");
    // 把 settings.json 弄坏（外部手改/截断），影子仍在
    writeFileSync(settingsPath(root), "{broken", "utf8");
    const warns = [];
    const s = readSettings(root, { warn: (m) => warns.push(m) });
    assert.equal(s.conversationMemory, false, "恢复用户关过的开关（不是默认 true）");
    assert.equal(s.projectMemory, false);
    assert.equal(s.globalExtraction, true);
    assert.equal(s.trashKeepDays, 7, "安全面现值也一并恢复");
    assert.equal(s.corrupt, true, "损坏事实仍暴露（本次请求周期内可见）");
    assert.ok(warns.some((m) => /last-good/.test(m)), "恢复来源写进日志");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("损坏 + last-good 也不可用：落默认 + corrupt（绝不 fail-open 静默开全）", () => {
  const root = freshRoot();
  try {
    writeFileSync(settingsPath(root), "{broken", "utf8");
    writeFileSync(settingsLastGoodPath(root), "also broken", "utf8");
    const warns = [];
    const s = readSettings(root, { warn: (m) => warns.push(m) });
    assert.equal(s.conversationMemory, true);
    assert.equal(s.corrupt, true);
    assert.ok(warns.some((m) => /last-good|默认/.test(m)));
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

test("损坏恢复后 corrupt 持久暴露（不因写回而一闪而过），用户重存设置才清除", () => {
  const root = freshRoot();
  try {
    writeSettings(root, { conversationMemory: false, recentKeepDays: 88 }); // 建立 last-good 影子
    writeFileSync(settingsPath(root), "{broken", "utf8");
    // 第 1 次读：存证 + 从 last-good 恢复 + 写回 + corrupt
    const first = readSettings(root, { warn: () => {} });
    assert.equal(first.conversationMemory, false);
    assert.equal(first.corrupt, true);
    // 第 2/3 次读：settings.json 已被写回可解析，但损坏标记仍在 → 仍报 corrupt（用户视觉未恢复前不消失）
    assert.equal(readSettings(root, { warn: () => {} }).corrupt, true, "损坏标记未清前 corrupt 恒在");
    assert.equal(readSettings(root, { warn: () => {} }).conversationMemory, false, "恢复后的开关值仍生效");
    // 用户面板重存设置 = 已重写修复 → 清标记，corrupt 转 false
    writeSettings(root, { trashKeepDays: 5 });
    const afterSave = readSettings(root, { warn: () => {} });
    assert.equal(afterSave.corrupt, false, "用户重存设置后 corrupt 清除");
    assert.equal(afterSave.trashKeepDays, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- settings.json ENOENT 恢复窗口（fail-open 回归）：损坏恢复「先改名、后写回」两步之间
//      崩溃/写回失败后，盘上只剩 last-good + settings.json 缺失——此时必须从影子恢复用户开关，
//      不许静默落默认全开（否则之后任意一次写入会把全开值刷进 last-good，用户开关永久丢失）。----

test("ENOENT + last-good 在场：从影子恢复用户开关 + corrupt:true（损坏恢复窗口中途崩溃）", () => {
  const root = freshRoot();
  try {
    // 先正常写入一份建立 last-good 影子：用户关掉对话/项目记忆
    writeSettings(root, { conversationMemory: false, projectMemory: false, trashKeepDays: 9 });
    assert.equal(existsSync(settingsLastGoodPath(root)), true, "前置：影子在场");
    // 模拟损坏恢复窗口中途崩溃：settings.json 已被改名存证出来，但写回还没落（盘上只剩影子）
    rmSync(settingsPath(root), { force: true });
    assert.equal(existsSync(settingsPath(root)), false, "前置：settings.json 缺失");
    const warns = [];
    const s = readSettings(root, { warn: (m) => warns.push(m) });
    assert.equal(s.conversationMemory, false, "从影子恢复用户关过的开关，绝不默认全开");
    assert.equal(s.projectMemory, false);
    assert.equal(s.trashKeepDays, 9, "安全面现值一并恢复");
    assert.equal(s.corrupt, true, "损坏恢复窗口暴露 corrupt");
    assert.ok(warns.some((m) => /last-good/.test(m)), "恢复来源写进日志");
    // 恢复结果已写回 settings.json（下次读不再回落默认）
    assert.equal(existsSync(settingsPath(root)), true, "恢复结果写回盘上");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ENOENT：损坏 rename 后写回失败 → 再读仍恢复用户开关（级联丢失回归）", () => {
  const root = freshRoot();
  try {
    writeSettings(root, { conversationMemory: false, globalExtraction: false });
    // 模拟损坏恢复窗口：settings.json 已改名出去（原内容永不失访），写回失败后盘上只剩影子
    const path = settingsPath(root);
    renameSync(path, `${path}.corrupt-${Date.now()}`);
    const s = readSettings(root, { warn: () => {} });
    assert.equal(s.conversationMemory, false, "再读仍从影子恢复用户开关（不是全开）");
    assert.equal(s.globalExtraction, false);
    assert.equal(s.corrupt, true);
    // 级联防线：此后一次普通写入，last-good 仍是用户开关（而非被全开值顶掉）
    writeSettings(root, { trashKeepDays: 5 });
    const shadow = JSON.parse(readFileSync(settingsLastGoodPath(root), "utf8"));
    assert.equal(shadow.conversationMemory, false, "last-good 未被全开默认值污染（用户开关未永久丢失）");
    assert.equal(shadow.trashKeepDays, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ENOENT + 无影子 + 无标记：全新安装落默认全开 + corrupt:false（不误标损坏）", () => {
  const root = freshRoot();
  try {
    const s = readSettings(root, { warn: () => {} });
    assert.equal(s.conversationMemory, true);
    assert.equal(s.projectMemory, true);
    assert.equal(s.globalExtraction, true);
    assert.equal(s.corrupt, false, "干净安装不是降级，不标 corrupt");
    // 全新安装不写回：保持「干净安装盘上无 settings.json」形态
    assert.equal(existsSync(settingsPath(root)), false, "全新安装不落 settings.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ENOENT + 影子本身损坏：存证改名 + 落默认 + corrupt:true", () => {
  const root = freshRoot();
  try {
    writeFileSync(settingsLastGoodPath(root), "{broken shadow", "utf8");
    const warns = [];
    const s = readSettings(root, { warn: (m) => warns.push(m) });
    assert.equal(s.conversationMemory, true, "影子坏 → 落默认全开（可见降级）");
    assert.equal(s.corrupt, true, "影子损坏事实暴露（不静默吞）");
    const shadowLeftovers = readdirSync(root).filter((f) => f.startsWith("settings.last-good.json.corrupt-"));
    assert.equal(shadowLeftovers.length, 1, "损坏影子被改名存证");
    assert.ok(warns.some((m) => /last-good/.test(m)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("无缓存：文件变更立即重读生效（含同 mtime+size 的静默改写——旧 mtime+size 缓存键会误读旧值）", () => {
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
    // 同字节长度的不同内容 + 强制 mtime 相同：直读盘上真值，绝不误读缓存（mtime+size 键的经典盲区）
    const a = JSON.stringify({ trashKeepDays: 30 });
    const b = JSON.stringify({ trashKeepDays: 31 });
    assert.equal(a.length, b.length, "前置：两份内容同长度");
    const fixed = new Date("2020-01-01T00:00:00.000Z");
    writeFileSync(path, a, "utf8");
    utimesSync(path, fixed, fixed);
    assert.equal(statSync(path).size, a.length);
    assert.equal(readSettings(root).trashKeepDays, 30);
    // 改写同尺寸内容并把 mtime 钉到同一时刻（mtime+size 完全相同的外部改写）
    writeFileSync(path, b, "utf8");
    utimesSync(path, fixed, fixed);
    assert.equal(statSync(path).size, a.length, "前置：size 相同");
    assert.equal(Math.floor(statSync(path).mtimeMs), fixed.getTime(), "前置：mtime 相同");
    assert.equal(readSettings(root).trashKeepDays, 31, "同 mtime+size 改写也必须读到新值（无缓存键误读）");
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
    // 0.6.0：runtimeEnabled 并入（运行时记忆层总开关，缺省关）
    // Unreleased：idleReviewEnabled 并入（空闲整理，缺省关）
    assert.deepEqual(Object.keys(onDisk).sort(), ["conversationMemory", "globalExtraction", "hardfactPolicy", "idleReviewEnabled", "projectMemory", "runtimeEnabled", "surgicalKeep", "trashKeepDays", "version"]);
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

// ---- 落默认可见化（getSettingsDiagnostics）----

test("落默认可见化：错型值落默认 → warn 明细 + coercedFields 记名字；取值语义不变", () => {
  const root = freshRoot();
  try {
    // 手改 settings.json 的常见错型：该是数字给了字符串、该是白名单值给了别的
    writeFileSync(
      settingsPath(root),
      JSON.stringify({ surgicalKeep: "90", trashKeepDays: "7", hardfactPolicy: "blocked", recentKeepDays: "60" }),
      "utf8",
    );
    const warns = [];
    const s = readSettings(root, { warn: (m) => warns.push(String(m)) });
    // 取值语义不变（文档化的「非数值走默认」规则保持）
    assert.equal(s.surgicalKeep, 30, "错型 surgicalKeep 仍落默认 30");
    assert.equal(s.trashKeepDays, 30, "错型 trashKeepDays 仍落默认 30");
    assert.equal(s.hardfactPolicy, "warn", "白名单外仍落默认 warn");
    assert.equal(s.recentKeepDays, void 0, "错型 recentKeepDays 仍按缺键处理");
    // 可见化：warn 里带字段名 + 收到的值 + 落的默认值
    const joined = warns.join("\n");
    for (const field of ["surgicalKeep", "trashKeepDays", "hardfactPolicy", "recentKeepDays"]) {
      assert.match(joined, new RegExp(field), `warn 点名 ${field}`);
    }
    assert.match(joined, /"90"/, "warn 带收到的值（字符串 90 带引号便于辨识）");
    assert.match(joined, /30/, "warn 带落的默认值");
    // 诊断记账
    const diag = getSettingsDiagnostics();
    assert.deepEqual(diag.coercedFields.slice().sort(), ["hardfactPolicy", "recentKeepDays", "surgicalKeep", "trashKeepDays"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("落默认诊断：随最近一次 readSettings 重算（修好就不再记）+ 缺键不算落默认", () => {
  const root = freshRoot();
  try {
    writeFileSync(settingsPath(root), JSON.stringify({ surgicalKeep: "90", trashKeepDays: 7 }), "utf8");
    readSettings(root, { warn: () => {} });
    assert.deepEqual(getSettingsDiagnostics().coercedFields, ["surgicalKeep"], "只记错型的那一项；合法 7 与缺键不记");
    // 重读（同一份坏档）仍记同一项（不累积重复）
    readSettings(root, { warn: () => {} });
    assert.deepEqual(getSettingsDiagnostics().coercedFields, ["surgicalKeep"], "同名字段不重复记账");
    // 修好后重读 → 重算为空（诊断随最近一次读取走，不持久化）
    writeFileSync(settingsPath(root), JSON.stringify({ surgicalKeep: 90, trashKeepDays: 7 }), "utf8");
    readSettings(root, { warn: () => {} });
    assert.deepEqual(getSettingsDiagnostics().coercedFields, [], "修好后重算为空");
    // 全新安装（无任何键）→ 不记账（缺键走默认属于向后兼容，不是用户写错）
    const root2 = freshRoot();
    readSettings(root2, { warn: () => {} });
    assert.deepEqual(getSettingsDiagnostics().coercedFields, [], "全新安装不刷落默认噪音");
    rmSync(root2, { recursive: true, force: true });
    // 合法值（含合法 0）→ 不记账
    writeFileSync(settingsPath(root), JSON.stringify({ surgicalKeep: 5, trashKeepDays: 0, hardfactPolicy: "block", recentKeepDays: 30 }), "utf8");
    readSettings(root, { warn: () => {} });
    assert.deepEqual(getSettingsDiagnostics().coercedFields, [], "合法 0 与白名单值不误记");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getSettingsDiagnostics：返回拷贝（外改不污染内部态）+ 形状恒为 { coercedFields: [] }", () => {
  const root = freshRoot();
  try {
    writeFileSync(settingsPath(root), JSON.stringify({ surgicalKeep: "x" }), "utf8");
    readSettings(root, { warn: () => {} });
    const diag = getSettingsDiagnostics();
    assert.ok(Array.isArray(diag.coercedFields));
    diag.coercedFields.push("tampered");
    diag.coercedFields.length = 0;
    assert.deepEqual(getSettingsDiagnostics().coercedFields, ["surgicalKeep"], "再读仍是原值（拷贝语义）");
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

test("recentKeepDays：合法值写入并可读回；非法值保留现值；未提供保留现值", () => {
  const root = freshRoot();
  try {
    const w = writeSettings(root, { recentKeepDays: 90 });
    assert.equal(w.recentKeepDays, 90);
    assert.equal(readSettings(root).recentKeepDays, 90);
    // 显式非法（非正整数）→ 保留现值（90）
    assert.equal(writeSettings(root, { recentKeepDays: 0 }).recentKeepDays, 90);
    assert.equal(writeSettings(root, { recentKeepDays: "60" }).recentKeepDays, 90);
    // 未提供 → 保留现值
    assert.equal(writeSettings(root, { conversationMemory: false }).recentKeepDays, 90);
    // 未设置过时缺位（不带该键），读侧回落 entry config
    const root2 = freshRoot();
    assert.equal(readSettings(root2).recentKeepDays, void 0);
    rmSync(root2, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateSettingsNumber：严格校验（正整数/上限）；trashKeepDays 允许 0", () => {
  for (const key of ["surgicalKeep", "recentKeepDays"]) {
    assert.equal(validateSettingsNumber(key, void 0).ok, true, "未提供 → ok");
    assert.equal(validateSettingsNumber(key, 1).ok, true);
    assert.equal(validateSettingsNumber(key, key === "surgicalKeep" ? 200 : 365).ok, true, "上限内");
    assert.equal(validateSettingsNumber(key, 0).ok, false, "0 非法（非正整数）");
    assert.equal(validateSettingsNumber(key, -1).ok, false);
    assert.equal(validateSettingsNumber(key, 1.5).ok, false);
    assert.equal(validateSettingsNumber(key, "5").ok, false);
    assert.equal(validateSettingsNumber(key, 99999).ok, false, "超上限");
    assert.match(validateSettingsNumber(key, 0).error, new RegExp(key));
  }
  // trashKeepDays：0 合法（既有语义），负数/非整数/超限非法
  assert.equal(validateSettingsNumber("trashKeepDays", 0).ok, true);
  assert.equal(validateSettingsNumber("trashKeepDays", 365).ok, true);
  assert.equal(validateSettingsNumber("trashKeepDays", -1).ok, false);
  assert.equal(validateSettingsNumber("trashKeepDays", 366).ok, false);
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

test("idleReviewEnabled：默认关、显式 true 才开、patch 未提及保持现值", () => {
  const root = freshRoot();
  try {
    assert.equal(readSettings(root).idleReviewEnabled, false, "默认关");
    const on = writeSettings(root, { idleReviewEnabled: true });
    assert.equal(on.idleReviewEnabled, true);
    assert.equal(readSettings(root).idleReviewEnabled, true);
    const preserved = writeSettings(root, { conversationMemory: false });
    assert.equal(preserved.idleReviewEnabled, true, "未提及的 idleReviewEnabled 保持现值");
    const off = writeSettings(root, { idleReviewEnabled: false });
    assert.equal(off.idleReviewEnabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

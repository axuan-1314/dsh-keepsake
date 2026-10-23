// cordis-yml-compat：出厂 loader 配置（cordis.patch.yml）的降级兼容守卫。
//
// 事故背景：v0.6.4 这批施工把 `extractReasoningEffort: low` 与 `maxOutputTokens: 0`
// 直接写进了出厂 yml。但 v0.6.4 的 resolveConfig 对未知键直接抛
// `unknown config key`（KNOWN 白名单里没有 extractReasoningEffort），
// `maxOutputTokens: 0` 又过不了 v0.6.4 的 positiveInt（要求正整数，0 被拒）。
// 而 apply() 第一行就调 resolveConfig 且无 try/catch——用户降级回 v0.6.4 时
// 插件装载直接失败，不是降级运行。出厂配置对旧版必须完全兼容，故这两个键
// 在 yml 里只以注释形式保留（代码缺省本来就是 0 + 不下发，写进去纯属冗余）。
//
// 本守卫用「上一个发布版的 KNOWN 键集」做基线（从 git tag v0.4.0 取证后的
// 硬编码快照，见下方 PREVIOUS_KNOWN），断言出厂 yml 的 config 块不含任何
// 该版本不认识的键。今后新增 config 键时必须同步注释化，否则这里立刻红。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const yml = readFileSync(join(here, "..", "cordis.patch.yml"), "utf8");

/**
 * 上一个发布版（v0.6.4，git tag v0.4.0 的 resolveConfig KNOWN 集实测取证）
 * 认识的 config 键。新增键后这个集合【不】更新——它就是"旧版会不会装载失败"的标尺。
 */
const PREVIOUS_KNOWN = new Set([
  "enabled", "storageRoot", "provider", "model", "minUserWords", "timeoutMs", "maxOutputTokens",
  "maxIndexLines", "maxIndexChars", "maxManifestFiles", "maxPromptChars", "maxOps",
  "recentKeepCount", "recentKeepDays",
  "retryAttempts", "retryBackoffMs", "retryMaxDelayMs",
  "fallback",
  "embeddingProvider", "embeddingModel",
  "injectChannel", "injectMaxChars",
  "recallEnabled", "embeddingBaseUrl", "embeddingApiKey",
  "recallTopK", "recallMaxTokens", "recallMinScore", "recallTimeoutMs", "recallTotalBudgetMs",
  "redactionEnabled",
  "autoRecoverEnabled", "autoRecoverCooldownMs",
  "injectMaxTokens",
  "extractGateEnabled", "extractGateMinScore", "extractIdleDelayMs", "extractMaxRunsPerSession",
]);

/**
 * 抽出出厂 yml 的 `config:` 块里**未被注释掉**的顶层键（最小 YAML 子集解析：
 * 只处理本文件用到的形态——`- insert:` 列表、`- id:` 项、`config:` 映射及其
 * 缩进子键；# 起头的整行与行内 # 之后的尾注释都剥掉，因此注释掉的键天然不计入）。
 * @returns {string[]} 键名列表
 */
function activeConfigKeys(text) {
  const lines = text.split(/\r?\n/);
  const keys = [];
  let inConfig = false;
  let configIndent = -1;
  for (const raw of lines) {
    // 去行内尾注释（# 前无引号包裹时直接切；本文件无带 # 的字符串值）
    const line = raw.replace(/\s+#.*$/, "");
    if (line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    if (!inConfig) {
      if (/^\s*config:\s*$/.test(line)) {
        inConfig = true;
        configIndent = indent;
      }
      continue;
    }
    // config 块以"缩进回到 config 层级或更浅"的非空行结束
    if (indent <= configIndent) break;
    const m = /^(\s*)([A-Za-z_][\w-]*)\s*:/.exec(line);
    if (m !== null) keys.push(m[2]);
  }
  return keys;
}

test("出厂 yml 兼容旧版：config 块不含上一个发布版不认识的键（降级不会装载失败）", () => {
  const keys = activeConfigKeys(yml);
  assert.ok(keys.length >= 10, `config 键抓取异常小（${keys.length}），检查解析或文件是否被改空`);
  const unknown = [...new Set(keys)].filter((k) => !PREVIOUS_KNOWN.has(k)).sort();
  assert.deepEqual(unknown, [], `cordis.patch.yml 含旧版不认识的键，降级会装载即失败：${unknown.join(", ")}`);
});

test("出厂 yml 兼容旧版：两个新键以注释示例保留（开着会破坏 v0.6.4 装载）", () => {
  // 键必须在场（用户要知道怎么开），但必须是注释（# 开头），不是活键
  assert.match(yml, /^\s*#\s*maxOutputTokens:\s*0\s*$/m, "maxOutputTokens 必须注释掉（0 过不了旧版 positiveInt）");
  assert.match(yml, /^\s*#\s*extractReasoningEffort:\s*low\s*$/m, "extractReasoningEffort 必须注释掉（旧版 KNOWN 无此键）");
  // 且不能有第二个未注释的活实例（上面已断言过一次，这里防多写）
  const active = activeConfigKeys(yml);
  assert.equal(active.filter((k) => k === "maxOutputTokens").length, 0, "maxOutputTokens 不得作为活键出现");
  assert.equal(active.filter((k) => k === "extractReasoningEffort").length, 0, "extractReasoningEffort 不得作为活键出现");
});

test("出厂 yml 的每个活键都能过当前 resolveConfig（键名没打错、值合法）", () => {
  // 反向守卫：注释化的键用户取消注释后必须仍可用，故 yml 注释里给出的示例值
  // 要真能过当前版 resolveConfig（否则注释教用户配一个会抛的值）。
  assert.equal(resolveConfig({ maxOutputTokens: 0 }).maxOutputTokens, 0, "注释示例 maxOutputTokens: 0 必须合法");
  assert.equal(resolveConfig({ extractReasoningEffort: "low" }).extractReasoningEffort, "low", "注释示例 extractReasoningEffort: low 必须合法");
});

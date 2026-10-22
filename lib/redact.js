/**
 * dsh-keepsake 脱敏模块（纯函数，零 IO，零第三方依赖；只用 node:crypto 算名字指纹）
 *
 * 按固定 7 类正则模式脱敏敏感信息：
 * 1. 私钥块：-----BEGIN ... PRIVATE KEY-----
 * 2. Authorization 头：Authorization/Proxy-Authorization: Bearer|Basic|Token <...>
 * 3. 独立 Bearer/Basic 令牌：Bearer|Basic <16+字符>
 * 4. 厂商 key 形态：sk-xxx / ghp_xxx / gho_xxx / ghu_xxx / ghs_xxx / ghr_xxx / github_pat_xxx / AKIA[0-9A-Z]{16} / xox[baprs]-xxx / AIzaxxx / JWT
 * 5. URL 内凭据：scheme://user:EXAMPLE_PASSWORD@example.com@ 保留 scheme，userinfo 换占位符
 * 6. 键值赋值：password/passwd/pwd/secret/token/api_key/apikey/access_key/private_key/credential(s) [:=] 值
 * 7. 内网 IPv4：10.x.x.x / 172.16-31.x.x / 192.168.x.x
 *
 * 幂等：对已脱敏文本再跑 count=0
 * 占位符 [redacted] 无数字无 a-f 长串，不触发 hardfact HEX_RE/NUMBER_RE
 * 防 ReDoS：所有模式线性，无嵌套量词回溯
 */

export const REDACTION_PLACEHOLDER = "[redacted]";

import { createHash } from "node:crypto";

/**
 * 模式 1：私钥块（完整 PEM 格式）
 * 匹配 -----BEGIN ... PRIVATE KEY----- 到 -----END ... PRIVATE KEY-----
 */
const PRIVATE_KEY_PATTERN = /-----BEGIN[A-Z0-9\s]+PRIVATE KEY-----[\s\S]+?-----END[A-Z0-9\s]+PRIVATE KEY-----/g;

/**
 * 模式 2：Authorization/Proxy-Authorization 头
 * Authorization: Bearer <token> / Authorization: Basic <base64> / Authorization: Token <token>
 */
const AUTH_HEADER_PATTERN = /(Authorization|Proxy-Authorization):\s*(Bearer|Basic|Token)\s+[^\s\r\n]+/gi;

/**
 * 模式 3：独立 Bearer/Basic 令牌（不在 Authorization 头内的）
 * Bearer <16+字符> 或 Basic <16+字符>
 */
const BEARER_BASIC_TOKEN_PATTERN = /\b(Bearer|Basic)\s+[^\s\r\n]{16,}/gi;

/**
 * 模式 4：厂商 key 形态
 * - sk-xxx (OpenAI 风格，16+ 字符)
 * - ghp_xxx / gho_xxx / ghu_xxx / ghs_xxx / ghr_xxx (GitHub PAT)
 * - github_pat_xxx (GitHub Fine-grained PAT)
 * - AKIA[0-9A-Z]{16} (AWS Access Key)
 * - xox[baprs]-xxx (Slack tokens)
 * - AIza[A-Za-z0-9_-]{35,} (Google API key，真 key 是 35 位尾串；下限定 35、上限放开——
 *   脱敏器宁多勿漏：误伤「AIza 开头的长随机串」成本趋近于零，漏伤真 key 才是事故)
 * - JWT (eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)
 */
const VENDOR_KEY_PATTERN = /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|ghr_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9_-]{10,}|AIza[A-Za-z0-9_-]{35,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g;

/**
 * 模式 5：URL 内凭据
 * scheme://user:EXAMPLE_PASSWORD@example.com@host → scheme://[redacted]@host
 * 保留 scheme 和 host，只替换 userinfo 部分。
 * host 只认主机形状（字母数字.- 与可选 :端口），路径里的 @（/path@segment）不再被卷进匹配；
 * userinfo 不跨 / 与 @，密码本身含 @ 的情形只按首个 @ 前截断（尽力而为，见已知限制）。
 */
const URL_CREDENTIALS_PATTERN = /([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/\s@]+)@([A-Za-z0-9.-]+(?::\d{1,5})?)/g;

/**
 * 模式 6：敏感键值赋值
 * password[:=] <值> / passwd[:=] <值> / pwd[:=] <值> / secret[:=] <值> / token[:=] <值>
 * api_key[:=] <值> / apikey[:=] <值> / access_key[:=] <值> / private_key[:=] <值> / credential[:=] <值> / credentials[:=] <值>
 * 值可以是引号包裹或非空白字符（引号包裹时到匹配引号结束，否则到行尾或空格）
 * 排除 [redacted] 本身以实现幂等
 */
const SENSITIVE_KEY_VALUE_PATTERN = /\b(password|passwd|pwd|secret|token|api_key|apikey|access_key|private_key|credential|credentials)\s*[:=]\s*(?!\[redacted\])("[^"]*"|'[^']*'|[^\s\r\n]+)/gi;

/**
 * 模式 7：内网 IPv4 地址
 * 10.x.x.x / 172.16-31.x.x / 192.168.x.x
 */
const PRIVATE_IPV4_PATTERN = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g;

/**
 * 脱敏敏感信息（返回脱敏后文本）
 * @param {string} text - 待脱敏文本
 * @returns {string} 脱敏后文本
 */
export function redactSensitive(text) {
  if (typeof text !== "string") return text;
  let result = text;

  // 1. 私钥块
  result = result.replace(PRIVATE_KEY_PATTERN, REDACTION_PLACEHOLDER);

  // 2. Authorization 头
  result = result.replace(AUTH_HEADER_PATTERN, (match, header, scheme) => {
    return `${header}: ${scheme} ${REDACTION_PLACEHOLDER}`;
  });

  // 4. 厂商 key 形态（在 Bearer/Basic 之前，避免 sk- 双重匹配）
  result = result.replace(VENDOR_KEY_PATTERN, REDACTION_PLACEHOLDER);

  // 3. 独立 Bearer/Basic 令牌
  result = result.replace(BEARER_BASIC_TOKEN_PATTERN, (match, scheme) => {
    return `${scheme} ${REDACTION_PLACEHOLDER}`;
  });

  // 5. URL 内凭据（保留 scheme 和 host）
  result = result.replace(URL_CREDENTIALS_PATTERN, (match, scheme, userinfo, host) => {
    return `${scheme}://${REDACTION_PLACEHOLDER}@${host}`;
  });

  // 6. 敏感键值赋值
  result = result.replace(SENSITIVE_KEY_VALUE_PATTERN, (match, key, value) => {
    // 保留引号（如果有）
    const isQuoted = value.startsWith('"') || value.startsWith("'");
    if (isQuoted) {
      const quote = value[0];
      return `${key}${match.includes("=") ? "=" : ":"} ${quote}${REDACTION_PLACEHOLDER}${quote}`;
    }
    return `${key}${match.includes("=") ? "=" : ":"} ${REDACTION_PLACEHOLDER}`;
  });

  // 7. 内网 IPv4
  result = result.replace(PRIVATE_IPV4_PATTERN, REDACTION_PLACEHOLDER);

  return result;
}

/**
 * 脱敏敏感信息并返回命中计数
 * @param {string} text - 待脱敏文本
 * @returns {{ text: string, count: number }} 脱敏后文本和命中数
 */
export function redactSensitiveWithCount(text) {
  if (typeof text !== "string") return { text, count: 0 };

  let count = 0;
  let result = text;

  // 1. 私钥块
  const before = result.length;
  result = result.replace(PRIVATE_KEY_PATTERN, REDACTION_PLACEHOLDER);
  count += (before !== result.length) ? 1 : 0;

  // 2. Authorization 头
  const authMatches = result.match(AUTH_HEADER_PATTERN);
  if (authMatches) count += authMatches.length;
  result = result.replace(AUTH_HEADER_PATTERN, (match, header, scheme) => {
    return `${header}: ${scheme} ${REDACTION_PLACEHOLDER}`;
  });

  // 4. 厂商 key 形态（在 Bearer/Basic 之前，避免 sk- 双重匹配）
  const vendorMatches = result.match(VENDOR_KEY_PATTERN);
  if (vendorMatches) count += vendorMatches.length;
  result = result.replace(VENDOR_KEY_PATTERN, REDACTION_PLACEHOLDER);

  // 3. 独立 Bearer/Basic 令牌
  const bearerMatches = result.match(BEARER_BASIC_TOKEN_PATTERN);
  if (bearerMatches) count += bearerMatches.length;
  result = result.replace(BEARER_BASIC_TOKEN_PATTERN, (match, scheme) => {
    return `${scheme} ${REDACTION_PLACEHOLDER}`;
  });

  // 5. URL 内凭据
  const urlMatches = result.match(URL_CREDENTIALS_PATTERN);
  if (urlMatches) count += urlMatches.length;
  result = result.replace(URL_CREDENTIALS_PATTERN, (match, scheme, userinfo, host) => {
    return `${scheme}://${REDACTION_PLACEHOLDER}@${host}`;
  });

  // 6. 敏感键值赋值
  const keyMatches = result.match(SENSITIVE_KEY_VALUE_PATTERN);
  if (keyMatches) count += keyMatches.length;
  result = result.replace(SENSITIVE_KEY_VALUE_PATTERN, (match, key, value) => {
    const isQuoted = value.startsWith('"') || value.startsWith("'");
    if (isQuoted) {
      const quote = value[0];
      return `${key}${match.includes("=") ? "=" : ":"} ${quote}${REDACTION_PLACEHOLDER}${quote}`;
    }
    return `${key}${match.includes("=") ? "=" : ":"} ${REDACTION_PLACEHOLDER}`;
  });

  // 7. 内网 IPv4
  const ipMatches = result.match(PRIVATE_IPV4_PATTERN);
  if (ipMatches) count += ipMatches.length;
  result = result.replace(PRIVATE_IPV4_PATTERN, REDACTION_PLACEHOLDER);

  return { text: result, count };
}

/**
 * 对 ops 数组进行脱敏
 * 只脱敏字符串内容字段（content/title/description/indexLine/body/name）
 * 不动文件路径/sha1/op 类型字段
 *
 * **name 的脱敏必须是单射**：若两条名字里各含不同密钥的条目都替换成 `[redacted]`，
 * 经 sanitizeMemoryName 归一后同为 `redacted.md` —— 两条不同记忆会被合并成一条；
 * 更糟的是 `delete` 一条密钥名条目会命中盘上一条**完全无关**的 `redacted.md` 并把它
 * 移进回收站。故 name 命中时保留原名的可辨识部分，并追加源名短 sha1 保证唯一。
 * @param {Array} ops - ops 数组
 * @returns {{ ops: Array, count: number }} 新数组 + 命中总数
 */
export function redactOps(ops) {
  if (!Array.isArray(ops)) return { ops: [], count: 0 };

  let totalCount = 0;
  const newOps = ops.map((op) => {
    if (op === null || typeof op !== "object") return op;

    const newOp = { ...op };
    // name 也必须在列：模型可以把密钥片段写进文件名（如 `sk-abc123def456.md`），
    // 而文件名会落盘、进 MEMORY.md 索引、进提取 manifest、并随每轮注入进模型视野。
    // sanitizeMemoryName 只做字符白名单，不拦这种形态。
    const stringFields = ["content", "title", "description", "indexLine", "body"];

    for (const field of stringFields) {
      if (typeof newOp[field] === "string") {
        const { text, count } = redactSensitiveWithCount(newOp[field]);
        newOp[field] = text;
        totalCount += count;
      }
    }

    // name 单独处理：脱敏 + 唯一化后缀（保证不同原名映射到不同结果，绝不撞名）
    if (typeof newOp.name === "string") {
      const { text, count } = redactSensitiveWithCount(newOp.name);
      if (count > 0) {
        newOp.name = uniqueRedactedName(text, op.name);
        totalCount += count;
      }
    }

    return newOp;
  });

  return { ops: newOps, count: totalCount };
}

/** 源名短指纹（稳定、无密钥残留：只输出十六进制）。
 *  用 sha256 而非 sha1——这里不是安全用途（只为唯一化），但既然要引入哈希就用强算法，
 *  免得多一处弱算法告警面。 */
function shortFingerprint(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 8);
}

/**
 * 脱敏后的 name 唯一化：`sk-abc….md` 与 `sk-xyz….md` 都变成 `[redacted]` 后，
 * 追加源名指纹避免撞名（`[redacted]-1a2b3c4d`）。指纹是纯十六进制，既不含原文片段
 * （不可逆推密钥），又能把不同原名区分开——这正是「替换后不得指向无关文件」的要求。
 * @param redacted 脱敏后的名字
 * @param original 原名（仅用于算指纹，不写进结果）
 */
export function uniqueRedactedName(redacted, original) {
  const stem = String(redacted ?? "").replace(/\.md$/i, "");
  const hasMd = /\.md$/i.test(String(redacted ?? ""));
  return `${stem}-${shortFingerprint(original)}${hasMd ? ".md" : ""}`;
}

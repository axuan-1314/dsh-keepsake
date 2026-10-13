// dsh-keepsake 文件名安全（规格边界③：包含性判定 + 黑名单段 + Unicode 控制符剥除）。
// 对应上游规格 memory-file-path 的三道闸：
//   1) 包含性判定：relative(rootDir, p) 非空 / 非 ../ 开头 / 不越界 / 非绝对；
//   2) 黑名单段：段名小写比对（.git/hooks/node_modules/.zcode/skills/...），剥 ':' 后缀；
//   3) Unicode 控制符（含 bidi）剥除。
// 另含 sanitizeMemoryName：把模型提议的 name 规范成安全 .md 相对路径。
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * 标题净化后为空（纯中文/纯符号标题）时的兜底文件名：对种子（标题或正文）取 sha1 前 10 hex。
 * 确定性且抗撞——同种子同名（幂等重导＝覆盖同条）、异种子必异名；取代按批次位置命名
 * （entry-1/-2）导致的多次导入互相覆盖。空种子取 sha1("") 的确定前缀，结果不随调用时间变化
 * （撞名由调用方 uniqueName 的 -2/-3… 兜底，不影响正确性）。
 */
export function fallbackEntryName(seed) {
  const base = String(seed ?? "").trim();
  const digest = createHash("sha1").update(base).digest("hex").slice(0, 10);
  return `entry-${digest}.md`;
}

/** 黑名单段（小写比对）。覆盖规格点名段 + 本插件自身相关目录。 */
export const BLACKLIST_SEGMENTS = new Set([
  ".git",
  "hooks",
  "node_modules",
  ".zcode",
  ".dsh",
  ".obsidian",
  "skills",
]);

/**
 * Windows 保留设备名基名：con/prn/aux/nul/com1-9/lpt1-9。
 * 含带扩展名形态（con.md 在 win32 同样保留）；按"剥到首点前的基名"比对
 * （nul.tar.md 等多级扩展形态旧内核首点前基名即设备名，一并拒绝）。
 */
export const WINDOWS_RESERVED_BASENAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** 段是否为 Windows 保留设备名（剥到首点前基名精确比对，大小写不敏感）。 */
export function isReservedDeviceSegment(segment) {
  const base = String(segment ?? "").toLowerCase().split(".")[0];
  return WINDOWS_RESERVED_BASENAMES.has(base);
}

/** 索引文件名（保留，不可被提取写入/删除）。 */
export const INDEX_FILENAME = "MEMORY.md";

/** Unicode 控制符 + 不可见字符 + bidi 控制符（剥除而非拒绝，规格口径）。 */
// eslint-disable-next-line no-control-regex
const CONTROL_AND_BIDI = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** 剥控制符/bidi（供称呼等值域复用；与文件名净化同口径）。 */
export function stripControlAndBidi(value) {
  return String(value ?? "").replace(CONTROL_AND_BIDI, "");
}

/**
 * 包含性判定：targetPath 是否严格位于 rootDir 内（的普通文件路径）。
 * 规格口径：relative 非空、非 '..' 开头、不越界、非绝对。
 */
export function isInsideRoot(rootDir, targetPath) {
  if (typeof rootDir !== "string" || rootDir.length === 0) return false;
  if (typeof targetPath !== "string" || targetPath.length === 0) return false;
  let rel;
  try {
    rel = relative(resolve(rootDir), resolve(targetPath));
  } catch {
    return false;
  }
  if (rel.length === 0) return false; // 目标 == 根本身
  if (isAbsolute(rel)) return false;
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../")) return false;
  return true;
}

/** 单段净化：剥控制符/bidi、剥 ':' 后缀、小写比对黑名单与点段。返回 null 表示该段被拒。 */
export function sanitizeSegment(rawSegment) {
  let seg = String(rawSegment ?? "").replace(CONTROL_AND_BIDI, "");
  // 剥段尾 ':'（win32 盘符/ADS 风格），再剥首尾空白与点。
  seg = seg.replace(/:+\s*$/, "").trim();
  if (seg.length === 0) return null;
  const lowered = seg.toLowerCase();
  if (lowered === "." || lowered === "..") return null;
  if (BLACKLIST_SEGMENTS.has(lowered)) return null;
  return seg;
}

/**
 * 把模型提议的 name 规范为 memoryRoot 内的安全相对 .md 路径（'/' 分隔返回）。
 * @returns 安全相对路径；不安全返回 null。
 */
export function sanitizeMemoryName(rawName) {
  if (typeof rawName !== "string") return null;
  const stripped = rawName.replace(CONTROL_AND_BIDI, "").trim().replace(/\\/g, "/");
  if (stripped.length === 0 || stripped.length > 260) return null;
  const segments = stripped.split("/").filter((s) => s.length > 0);
  if (segments.length === 0 || segments.length > 4) return null;
  const safeSegments = [];
  for (const segment of segments) {
    const kept = sanitizeSegment(segment);
    if (kept === null) return null;
    // 段内净化：小写、白名单字符，非法段合并 '-'，去首尾 '-'/'.'（防 ".." 变体）。
    const cleaned = kept
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .replace(/-{2,}/g, "-");
    if (cleaned.length === 0) return null;
    if (isReservedDeviceSegment(cleaned)) return null; // Windows 保留设备名段
    // 任何一段（含中间目录段）都不得冒充索引文件名
    const asMd = cleaned.endsWith(".md") ? cleaned : `${cleaned}.md`;
    if (asMd === INDEX_FILENAME.toLowerCase()) return null;
    safeSegments.push(cleaned);
  }
  const last = safeSegments[safeSegments.length - 1];
  const lastMd = last.endsWith(".md") ? last : `${last}.md`;
  // 先补 .md 再比保留名——否则无扩展名的 "memory" 追加后恰为索引文件
  if (lastMd === INDEX_FILENAME.toLowerCase()) return null; // MEMORY.md 保留给索引
  safeSegments[safeSegments.length - 1] = lastMd;
  return safeSegments.join("/");
}

/**
 * 三道闸合成：sanitize + 绝对路径包含性判定（防消毒后仍越界的任何残差）。
 * @returns 绝对目标文件路径；不安全返回 null。
 */
export function resolveSafeMemoryTarget(memoryRoot, rawName) {
  const rel = sanitizeMemoryName(rawName);
  if (rel === null) return null;
  const absolute = resolve(memoryRoot, ...rel.split("/"));
  if (!isInsideRoot(memoryRoot, absolute)) return null;
  return absolute;
}

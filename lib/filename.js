// dsh-memory 文件名安全（规格边界③：包含性判定 + 黑名单段 + Unicode 控制符剥除）。
// 对应 ZCode memory-file-path.ts 的三道闸：
//   1) 包含性判定：relative(rootDir, p) 非空 / 非 ../ 开头 / 不越界 / 非绝对；
//   2) 黑名单段：段名小写比对（.git/hooks/node_modules/.zcode/skills/...），剥 ':' 后缀；
//   3) Unicode 控制符（含 bidi）剥除。
// 另含 sanitizeMemoryName：把模型提议的 name 规范成安全 .md 相对路径。
import { isAbsolute, relative, resolve, sep } from "node:path";

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
 * Windows 保留设备名基名（审查 P3-6）：con/prn/aux/nul/com1-9/lpt1-9。
 * 含带扩展名形态（con.md 在 win32 同样保留）；按"剥单层扩展名后的基名"精确比对。
 */
export const WINDOWS_RESERVED_BASENAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** 段是否为 Windows 保留设备名（剥单层扩展名后精确比对，大小写不敏感）。 */
export function isReservedDeviceSegment(segment) {
  const base = String(segment ?? "").toLowerCase().replace(/\.[^.]*$/, "");
  return WINDOWS_RESERVED_BASENAMES.has(base);
}

/** 索引文件名（保留，不可被提取写入/删除）。 */
export const INDEX_FILENAME = "MEMORY.md";

/** Unicode 控制符 + 不可见字符 + bidi 控制符（剥除而非拒绝，规格口径）。 */
// eslint-disable-next-line no-control-regex
const CONTROL_AND_BIDI = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

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
    if (isReservedDeviceSegment(cleaned)) return null; // 审查 P3-6：Windows 保留设备名段
    safeSegments.push(cleaned);
  }
  const last = safeSegments[safeSegments.length - 1];
  if (last === INDEX_FILENAME.toLowerCase()) return null; // MEMORY.md 保留给索引
  safeSegments[safeSegments.length - 1] = last.endsWith(".md") ? last : `${last}.md`;
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

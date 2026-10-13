// dsh-memory 数据布局 —— 项目记忆目录推导。
// 规格（蓝图「数据布局」）：
//   项目记忆根 = <storageRoot>/projects/<slug>-<hash16>/memory
//   slug   = workspace basename 净化（小写、[^a-z0-9._-]+→'-'、截 48、空则 "project"）
//   hash16 = 绝对路径（win32 转小写）sha256 前 16 hex
// 本模块只做纯计算，不做 IO，方便单测。
import { createHash } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";

export const MEMORY_DIR_NAME = "memory";

/** 净化 workspace basename 为 slug：小写、非法段合并为 '-'、截 48、空则 "project"。 */
export function slugifyBasename(basename) {
  const cleaned = String(basename ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48)
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.length > 0 ? cleaned : "project";
}

/** 绝对路径身份哈希：win32 转小写后 sha256 前 16 hex。 */
export function hashProjectPath(absPath) {
  const normalized = normalizeWorkspacePath(absPath);
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}

/** win32 路径统一转小写（规格：keySource=workspaceIdentity 否则绝对路径 win32 转小写）。 */
export function normalizeWorkspacePath(absPath) {
  const text = String(absPath ?? "");
  return process.platform === "win32" ? text.toLowerCase() : text;
}

/**
 * 由 workspace cwd 推导项目记忆目录：
 * <storageRoot>/projects/<slug>-<hash16>/memory
 * @param storageRoot 记忆总根（默认 ~/.dsh/memory）
 * @param cwd 会话 header.cwd（workspace 绝对路径）
 * @returns { root, projectDir, memoryDir, slug, hash }（全部为已 resolve 的绝对路径）
 */
export function projectMemoryPaths(storageRoot, cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) throw new Error("dsh-memory: cwd is required");
  const abs = resolve(cwd);
  if (!isAbsolute(abs)) throw new Error("dsh-memory: cwd must resolve to an absolute path");
  const slug = slugifyBasename(basenameOf(abs));
  const hash = hashProjectPath(abs);
  const projectDir = `${stripTrailingSep(storageRoot)}${sep}projects${sep}${slug}-${hash}`;
  const memoryDir = `${projectDir}${sep}${MEMORY_DIR_NAME}`;
  return { root: stripTrailingSep(storageRoot), projectDir, memoryDir, slug, hash };
}

function basenameOf(p) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

function stripTrailingSep(p) {
  let out = String(p ?? "");
  while (out.length > 1 && (out.endsWith("/") || out.endsWith(sep))) out = out.slice(0, -1);
  return out;
}

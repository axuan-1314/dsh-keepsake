/**
 * recent-activity 规范时间戳（双序统一的共享判定）。
 *
 * 展示/注入排序与滚动清理此前各用一套基准（mtime vs timestamp），
 * 现统一：timestamp 为准，但仅当它是有限数且不超前当前时刻超过
 * 1 小时宽容窗（防手工造的未来时间戳永不过期）；否则回退 mtimeMs。
 * 排序与龄清理（prune）都必须经此函数取值，禁止直接读字段。
 */
const RECENT_TOLERANCE_MS = 60 * 60 * 1000;

export function recentTsOf(entry) {
  const raw = entry?.timestamp;
  // 条目 timestamp 为 ISO 字符串（frontmatter 盖章）或数值（内部）；都归一到 epoch ms
  const ts = typeof raw === "string" ? Date.parse(raw) : Number(raw);
  if (Number.isFinite(ts) && ts <= Date.now() + RECENT_TOLERANCE_MS) return ts;
  const mtime = Number(entry?.mtimeMs);
  return Number.isFinite(mtime) ? mtime : 0;
}

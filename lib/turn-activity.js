// 轮次活动条（turn bar）：把「本轮发生了什么」聚合成一条可读的时间线。
//
// 背景（为什么需要）：现有观测面都是**分面**的——extractionLog 讲提取、
// /state.injection 讲注入、/state.idleReview 讲整理、纠错记录讲纠错。
// 用户问「刚才那轮到底做了些什么」时，得在四个面板之间来回看，还得自己对时间。
// 本模块把那四面按**会话 + 时间窗**归并成一条事件流。
//
// 归属口径（有意只用已有事实，不新增落盘）：
//   - 提取事件自带 sessionId（journal 行里有），直接按会话归；
//   - 注入事件**没有** sessionId（metrics 是进程级累计），只能按时间落进窗口；
//   - 纠错/整理同理（它们是显式动作，时间足够定位）。
//   所以这里给的是「这个会话的这段时间里发生了什么」，不是严格因果链。
//   刻意不编造因果（比如不说"因为注入了 X 所以提取写了 Y"）——那是在猜。
//
// 边界：纯派生计算，零新增状态。调用方给四个快照，本模块返回行数组。
import { extractionRunLabel } from "./panel-logic.js";

export const TURN_WINDOW_MS = 30 * 60 * 1000; // 默认看最近 30 分钟
export const TURN_MAX_ROWS = 200;
export const TURN_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 上限一周（journal ring 本身也就这么长）

function msOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function seqRange(from, to) {
  const f = Number(from);
  const t = Number(to);
  return Number.isFinite(f) && Number.isFinite(t) ? [f, t] : null;
}

/**
 * 把四份快照拍平成事件流。
 *
 * @param {{
 *   extractionLog?: object, injection?: object, idleReview?: object,
 *   corrections?: object, now?: number
 * }} input 四个观测面快照（都宽容 undefined = 旧版/未接线）
 * @returns {Array<{at:number, iso:string, kind:string, sessionId:string, title:string, detail:string}>}
 *   时间倒序（新在前）
 */
export function collectEvents({ extractionLog = null, injection = null, idleReview = null, corrections = null, now = Date.now() } = {}) {
  const events = [];

  // 提取：journal ring 每行是「某会话的某段区间结算」
  const runs = extractionLog && Array.isArray(extractionLog.runs) ? extractionLog.runs : [];
  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const at = msOf(run.at);
    if (at === null) continue;
    const range = seqRange(run.from, run.to);
    events.push({
      at,
      iso: new Date(at).toISOString(),
      kind: "extraction",
      outcome: String(run.outcome ?? ""),
      sessionId: typeof run.sessionId === "string" ? run.sessionId : "",
      title: "提取",
      detail: extractionRunLabel(run),
      range,
    });
  }

  // 注入：只有进程级累计 + 最近一次的时刻，无法拆成多行（诚实：只出一条"最近一次"）
  if (injection && typeof injection === "object") {
    const at = msOf(injection.lastAt);
    const count = Number(injection.count ?? 0);
    if (at !== null && Number.isFinite(count) && count > 0) {
      const chars = Number(injection.lastChars ?? 0);
      const dropped = Number(injection.droppedSegments ?? 0);
      const compacted = Number(injection.compactedSegments ?? 0);
      const extras = [];
      if (Number.isFinite(dropped) && dropped > 0) extras.push(`丢段 ${dropped}`);
      if (Number.isFinite(compacted) && compacted > 0) extras.push(`紧凑降级 ${compacted}`);
      events.push({
        at,
        iso: new Date(at).toISOString(),
        kind: "injection",
        sessionId: "",
        title: "注入",
        detail: `最近一次 ${Number.isFinite(chars) ? chars : 0} 字符${extras.length > 0 ? ` · ${extras.join(" · ")}` : ""}（累计 ${Math.floor(count)} 次）`,
      });
    }
  }

  // 空闲整理：同样是"最近一次"粒度
  if (idleReview && typeof idleReview === "object") {
    const at = msOf(idleReview.lastAt);
    const runs = Number(idleReview.runs ?? 0);
    if (at !== null && Number.isFinite(runs) && runs > 0) {
      const w = Number(idleReview.lastWrites ?? 0);
      const d = Number(idleReview.lastDeletes ?? 0);
      const outcome = String(idleReview.lastOutcome ?? "");
      const detail = outcome === "written"
        ? `整理 ${w} 写 / ${d} 删`
        : outcome === "error" ? "整理失败" : "整理：无需变动";
      events.push({
        at,
        iso: new Date(at).toISOString(),
        kind: "idle-review",
        sessionId: "",
        title: "空闲整理",
        detail,
      });
    }
  }

  // 纠错：记录最近 N 条（每条自带 at）
  const correctionsRecent = Array.isArray(corrections) ? corrections
    : corrections && Array.isArray(corrections.recent) ? corrections.recent : [];
  for (const row of correctionsRecent) {
    if (!row || typeof row !== "object") continue;
    const at = msOf(row.at);
    if (at === null) continue;
    const outcome = String(row.outcome ?? "");
    const detail = outcome === "applied"
      ? `已应用 ${Number(row.writes ?? 0)} 写 / ${Number(row.deletes ?? 0)} 删`
      : outcome === "needs-input" ? "需要更多信息（未改动）"
        : outcome === "nothing" ? "无需改动" : "失败";
    events.push({
      at,
      iso: new Date(at).toISOString(),
      kind: "correction",
      sessionId: "",
      title: "纠错",
      detail: `${row.target ?? "（未指名）"} — ${detail}`,
    });
  }

  events.sort((a, b) => b.at - a.at);
  return events;
}

/**
 * 取一个会话在时间窗内的事件行。
 *
 * 过滤规则（写清楚，免得面板各自解释）：
 *   - 提取事件按 sessionId 精确匹配；sessionId 为空表示"不按会话过滤"（全局视图）；
 *   - 注入/整理/纠错没有 sessionId，只要落进时间窗就保留（已在 detail 里说明粒度）。
 *
 * @param {object} snapshots collectEvents 的入参
 * @param {{sessionId?: string, since?: number, until?: number, limit?: number}} [options]
 * @returns {{
 *   events: Array<object>, total: number, truncated: boolean,
 *   window: {since:number, until:number}, sessionId:string
 * }}
 */
export function turnActivity(snapshots = {}, { sessionId = "", since = null, until = null, limit = TURN_MAX_ROWS } = {}) {
  const now = Number.isFinite(snapshots.now) ? snapshots.now : Date.now();
  const untilMs = Number.isFinite(until) ? until : now;
  const rawSince = Number.isFinite(since) ? since : untilMs - TURN_WINDOW_MS;
  // 窗口上限：更久远的直接钳到上限（不是静默截断——返回值里给了实际窗口）
  const sinceMs = Math.max(rawSince, untilMs - TURN_MAX_WINDOW_MS);
  const all = collectEvents({ ...snapshots, now });
  const sid = typeof sessionId === "string" ? sessionId : "";
  const filtered = all.filter((event) => {
    if (event.at < sinceMs || event.at > untilMs) return false;
    if (sid.length === 0) return true;
    if (event.kind !== "extraction") return true; // 无会话归属的事件只在窗口内匹配
    return event.sessionId === sid;
  });
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TURN_MAX_ROWS;
  return {
    events: filtered.slice(0, cap),
    total: filtered.length,
    truncated: filtered.length > cap,
    window: { since: sinceMs, until: untilMs },
    sessionId: sid,
  };
}

/**
 * 一条事件的展示文案（单一出处：面板行与 /memory 命令共用，避免双端漂移）。
 * @returns {{time:string, label:string, text:string}}
 */
export function turnEventLine(event) {
  const e = event && typeof event === "object" ? event : {};
  const at = Number.isFinite(e.at) ? e.at : Date.now();
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return {
    time,
    label: String(e.title ?? ""),
    text: String(e.detail ?? ""),
  };
}

/** 窗口人话描述（"最近 30 分钟" / "最近 2 小时"）。 */
export function turnWindowText(window) {
  const w = window && typeof window === "object" ? window : null;
  if (w === null) return "最近一段时间的活动";
  const since = Number(w.since);
  const until = Number(w.until);
  if (!Number.isFinite(since) || !Number.isFinite(until)) return "最近一段时间的活动";
  const minutes = Math.max(0, Math.round((until - since) / 60000));
  if (minutes < 60) return `最近 ${minutes} 分钟的活动`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `最近 ${hours} 小时的活动`;
  return `最近 ${Math.round(hours / 24)} 天的活动`;
}

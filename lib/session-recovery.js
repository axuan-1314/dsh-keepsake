// dsh-keepsake 会话补提恢复（lib/session-recovery.js）。
//
// 背景：提取任务体（lib/index.js 的 extractSession）是一条**内存态**流水线——
//   scheduler 的 cursor 与 session.snapshotEvents(from, to) 都依赖会话对象还活着。
//   DSH 一重启，内存 cursor 归零；lib/journal.js 把每次结算留在盘上，于是"哪段失败、
//   哪段被放弃"重启后仍查得见（journal.snapshot().unrecovered / .abandoned），
//   但**把那段内容读回来**缺一环：宿主早已释放会话对象，snapshotEvents 无从调用。
//   宿主会话持久化层（ctx.sessionPersistence，宿主注入、非 npm 依赖）把事件文件
//   永不删除地留在盘上——本模块就是把"盘上的失败清单"与"盘上的事件"接起来：
//     1) buildPendingItems：把 journal 快照合成一条补提清单，并标出哪些会话仍可读；
//     2) loadEvents：只读句柄分页读出全量事件（超上限显式截断，不静默丢）；
//     3) createSessionAdapter：把读回的事件包成一个会话形状的适配对象，
//        让现有提取入口原样吃下去，不必改动提取侧一行代码。
//
// 四条纪律：
//   - 零依赖 + 只用 Node 18 已有的语言/内置 API（CI 跑 18/20/22）；
//   - 不直接碰 ctx：一切宿主调用从参数注入（测试给假 persistence）。本文件不 import
//     任何宿主模块——@deepseek-ai/dsh-session-persistence 永不进 dependencies；
//   - 宿主可能根本没有 sessionPersistence（旧版本）→ 一律降级成 typed error 而非抛异常：
//     缺能力不是故障，装作有能力才是（静默放行会在上层演变成"已经补提过了"的假象）；
//   - 任何"不可用 / 被截断 / cwd 没取到"都必须显式出现在返回值里（sessionAvailable /
//     truncated / cwdSource），绝不让上层在信息缺失的情况下静默继续。
//
// 边界：本模块只负责【读回】与【适配】。要不要补提、补提后怎么记账由调用方决定
//   （记账仍走 journal.recordRun，口径与在线轮次完全一致）。

/** 单会话单次读取的事件总数上限（宿主持久化的事件永不删除，长会话可能几十万条）。 */
export const MAX_EVENTS_PER_SESSION = 50000;

/** 分页读的单次批量（兼顾调用开销与内存峰值）。 */
export const READ_PAGE_SIZE = 2000;

/** 分页循环的安全兜底：超过该页数即停并按 read-error 返回（句柄行为异常时不许无限循环）。 */
export const MAX_READ_PAGES = 2000;

/** 本模块的 typed error 全集（调用方据此分岔，不得出现第四种值）。 */
export const RECOVERY_ERRORS = Object.freeze([
  "session-not-found", // 会话不在持久化层里（宿主 open 明确报"没有这个会话"）
  "host-unsupported", // 宿主没有 sessionPersistence（旧版本 / 未注入 / 缺 open 方法）
  "read-error", // 读的过程中断了：open/read 抛非 not-found 错、句柄缺方法、页数超限
]);

/** 会话适配对象对外暴露的字段（提取链路实际消费的那几个；测试据此核对适配面）。 */
export const ADAPTER_SESSION_FIELDS = Object.freeze(["id", "seq", "header", "snapshotEvents", "source"]);

/** 非负整数归一（NaN/Infinity/负数/小数/非数字一律钳到 0；与 journal.js 同口径）。 */
function nonNegInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** 正整数参数归一（非法/≤0/非整数回落默认）。 */
function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 空对象兜底：宿主返回的形状不可信，取字段一律先过这里。 */
function objOf(value) {
  return value !== null && typeof value === "object" ? value : {};
}

/** ISO 字符串 / 数字 → 毫秒；不可解析一律 0（排序时"没有时间"排在最后且不越界）。 */
function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** 取首个非空字符串（宿主给的可能是别的类型或空串）。 */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return "";
}

/** 错误信息归一（Error / 字符串 / 带 code 的宿主对象一律出字符串，用于留痕与判定）。 */
function errorMessageOf(error) {
  if (error === null || error === undefined) return "unknown";
  if (typeof error === "string") return error;
  return String(error?.message ?? error?.code ?? error);
}

/** 错误是否属于"宿主明确说没有这个会话"家族（读文件时炸的是另一回事，按 read-error）。 */
function isNotFound(error, message) {
  const code = String(error?.code ?? "");
  if (code === "ENOENT" || code === "SESSION_NOT_FOUND" || code === "NOT_FOUND") return true;
  return /not[-_ ]?found|no such|enoent/i.test(message);
}

/** 日志口逐方法兜底（宿主可能只给 warn）。 */
function safeLogOf(log) {
  const raw = objOf(log);
  return {
    warn: typeof raw.warn === "function" ? raw.warn : () => {},
    error: typeof raw.error === "function" ? raw.error : () => {},
    info: typeof raw.info === "function" ? raw.info : () => {},
  };
}

/** typed error 结果体（失败出口的唯一形态）。 */
function fail(error, detail) {
  if (!RECOVERY_ERRORS.includes(error)) {
    // 内部兜底：写错错误码比返回上层 switch 不到的野值更糟——统一落到 read-error，
    // 并把原值留在 detail 里（一次笔误不该让失败从统计里凭空消失）。
    return { ok: false, error: "read-error", detail: `bad-error-code:${String(error)} ${String(detail ?? "")}`.trim() };
  }
  return { ok: false, error, detail: String(detail ?? "") };
}

/**
 * 补提清单条目归一。
 * kind 只有 failed / abandoned 两种（对应 journal 的 unrecovered / abandoned 两列）——
 * 两者结论不同（failed = 承诺过要补；abandoned = 已显式判死不再重试），合并成一张清单时
 * 必须保留身份，否则上层会把"不用再试的区间"当成"待补提区间"反复重试。
 * @returns {object|null} 无 sessionId 返回 null（清单里不出现认领不回来的幽灵条目）
 */
function normalizePendingItem(raw, kind) {
  const item = objOf(raw);
  const sessionId = typeof item.sessionId === "string" ? item.sessionId.trim() : "";
  if (sessionId.length === 0) return null;
  return {
    sessionId,
    from: nonNegInt(item.from),
    to: nonNegInt(item.to),
    at: item.at,
    reason: typeof item.reason === "string" ? item.reason : "",
    kind,
  };
}

/**
 * 把 journal 快照合成一张补提清单（unrecovered + abandoned），按 at 降序、稳定排序。
 *
 * 为什么合并：处置动作不同（见 kind），但要读回的内容一次请求就够——
 *   一趟探活 + 一趟读取能覆盖两类，清单条目同构，上层只需在一处按 kind 分岔。
 * 为什么 at 降序：新的先补。重启堆了很多段时，先补最近的内容最贴近用户此刻的语境。
 * 为什么强调稳定：同 at 时不额外定序，保持上方插入序（failed 列在前、abandoned 列在后，
 *   各自保留 journal 给出的顺序）——同输入两次运行产出同一顺序。
 *
 * @param {object} snapshot journal.snapshot() 的产物：
 *   { runs, unrecovered, abandoned, abandonedCount }。非对象或两列缺失/非数组 → 空清单
 *   （旧版宿主也给得出合法空清单，不抛）。
 * @param {Function} [statOf] 探活函数 (sessionId) => (object | null) | Promise<object | null>。
 *   null / 抛错 / 非对象 → sessionAvailable:false。缺省 = 不探活，一律 false：
 *   "没探过"与"探过不可读"表现必须一致——默认可用会让上层拿着读不出来的会话去跑提取。
 * @returns {Promise<Array<{sessionId,from,to,at,reason,kind,sessionAvailable,eventCount?}>>}
 *   eventCount 仅在探活拿到有限数值时出现。
 */
export async function buildPendingItems(snapshot, statOf) {
  const snap = objOf(snapshot);
  const rows = [];
  const collect = (list, kind) => {
    if (!Array.isArray(list)) return; // 缺列/非数组：当作空列，不炸（旧版宿主兼容）
    for (const raw of list) {
      const item = normalizePendingItem(raw, kind);
      if (item !== null) rows.push(item);
    }
  };
  collect(snap.unrecovered, "failed");
  collect(snap.abandoned, "abandoned");

  // 只比主键 at，相等不附加 tie-breaker：Node 的 sort 自 v11 起稳定，因此相等元素保输入序。
  rows.sort((x, y) => timestampMs(y.at) - timestampMs(x.at));

  const probe = typeof statOf === "function" ? statOf : null;
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const item = { ...row, sessionAvailable: false };
    if (probe !== null) {
      // 抛错被隔离在单条：一个会话探不动不代表别的会话读不回来。整体炸掉 =
      // 拿一次宿主抖动换整张清单消失，跨重启补提的命脉就此断掉。
      let stat = null;
      try {
        stat = await probe(row.sessionId);
      } catch {
        stat = null;
      }
      if (stat !== null && stat !== undefined && typeof stat === "object") {
        item.sessionAvailable = true;
        const info = objOf(stat);
        const count = Number(info.eventCount ?? info.count ?? info.events);
        if (Number.isFinite(count) && count >= 0) item.eventCount = Math.floor(count);
      }
    }
    out[i] = item;
  }
  return out;
}

/**
 * 读一个会话的**全量**事件（分页读到底）。
 *
 * 走 open(id, "read") 拿【只读句柄】：不抢写锁。补提是读路径，绝不能锁住正在写入的会话，
 * 也不能让只读行为退化成一次锁竞争。
 *
 * @param {object|null|undefined} persistence 宿主会话持久化服务（ctx.sessionPersistence）
 * @param {string} sessionId 会话 id（形如 session-<uuid>；journal 里就是这种形态）
 * @param {object} [options]
 * @param {number} [options.maxEvents=50000] 事件总数上限
 * @param {number} [options.pageSize=2000] 单次 read 的条数
 * @param {Function} [options.log] 宿主日志口 {warn?,error?,info?}
 * @returns {Promise<object>} 成功：{ ok:true, events, eventState, truncated, read }；
 *   失败：{ ok:false, error:'session-not-found'|'host-unsupported'|'read-error', detail }。
 *   eventState 原样透传宿主给的值（本模块不解释它的形状——解释权在提取侧，
 *   见 lib/transcript.js 的 renderTranscript / skipReason）。
 *   注意失败时**不返回半截事件**：拿残缺对话去提取，会据此写出长期污染后续轮次的记忆，
 *   比"这次没读成"糟得多。
 */
export async function loadEvents(persistence, sessionId, options = {}) {
  const opts = objOf(options);
  const log = safeLogOf(opts.log);
  const maxEvents = positiveInt(opts.maxEvents, MAX_EVENTS_PER_SESSION);
  const pageSize = positiveInt(opts.pageSize, READ_PAGE_SIZE);
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (id.length === 0) return fail("session-not-found", "会话 id 为空");

  // 宿主未提供持久化服务 = 能力缺失，不是故障。调用方据此走"没法补提"的显式分支，
  // 而不是被当成一次读取失败去重试。
  if (persistence === null || persistence === undefined || typeof persistence !== "object") {
    return fail("host-unsupported", "宿主未提供 sessionPersistence（旧版本或未注入）");
  }
  if (typeof persistence.open !== "function") {
    return fail("host-unsupported", "sessionPersistence 缺少 open 方法");
  }

  let handle;
  try {
    handle = await persistence.open(id, "read");
  } catch (error) {
    const message = errorMessageOf(error);
    log.error(`会话恢复：open 失败（session=${id}）`, error);
    return fail(isNotFound(error, message) ? "session-not-found" : "read-error", message);
  }
  if (handle === null || handle === undefined) return fail("session-not-found", "open 未返回句柄");
  if (typeof handle.read !== "function") return fail("read-error", "只读句柄缺少 read 方法");

  const events = [];
  let eventState;
  let offset = 0;
  let pages = 0;
  let truncated = false;

  /**
   * 读一页（页数上限与读异常的收口都在这一处，主循环只管拼装）。
   * @returns {null|{failed:true,code,detail}|{failed:false,page}} null = 页数超出上限（按 read-error 处理）
   */
  async function nextPage(want) {
    if (pages >= MAX_READ_PAGES) {
      // 安全兜底：分页停不下来（句柄行为异常，如从不推进 offset）——这与"超限截断"是两回事：
      // 截断是"读满了、还有剩"，这里是"读不下去了"，必须显形而不是悄悄返回半截。
      log.error(`会话恢复：读取页数超出上限（session=${id}，已读 ${events.length} 条，pages=${pages}）`);
      return null;
    }
    pages += 1;
    let page;
    try {
      page = await handle.read(offset, want);
    } catch (error) {
      const message = errorMessageOf(error);
      log.error(`会话恢复：read 失败（session=${id}，offset=${offset}）`, error);
      return { failed: true, code: isNotFound(error, message) ? "session-not-found" : "read-error", detail: message };
    }
    return { failed: false, page };
  }

  for (;;) {
    const remaining = maxEvents - events.length;
    if (remaining <= 0) break; // 触到上限：是否真被截断由下方"余料/探尾"两步判定
    const attempt = await nextPage(Math.min(pageSize, remaining));
    if (attempt === null) return fail("read-error", `读取页数超出上限（${MAX_READ_PAGES}）`);
    if (attempt.failed) return fail(attempt.code, attempt.detail);
    const pageObj = objOf(attempt.page);
    const batch = Array.isArray(pageObj.events) ? pageObj.events : [];
    if (typeof eventState === "undefined" && "eventState" in pageObj) eventState = pageObj.eventState;
    if (batch.length === 0) break; // 读到底（含空会话）
    let took = 0;
    while (took < batch.length && events.length < maxEvents) {
      events.push(batch[took]);
      took += 1;
    }
    // offset 按【真正吃掉的条数】推进。就当前策略而言 took 必等于 batch.length（不满即触限并
    // 退出，见下），两种写法此刻等价；取 took 是为了把"偏移量 = 已消费事件数"这条不变量写在
    // 码上——将来若改填充策略（如跳过非事件行），偏移量不会跟着虚增而漏读中间段。
    offset += took;
    if (took < batch.length) {
      // 本批没吃完就触限 → 确知后面还有，直接判截断（不必再探）
      truncated = true;
      break;
    }
  }

  // 恰好读满上限的情形：本批刚好吃完、没留下余料，此时"还有更多"与"刚好这么多"
  // 单凭已读数据无从分辨——再探一条来定案：探到即有后续（真截断），探空才是真读完。
  // 少了这一探，"会话恰好有 maxEvents 条"会被误标成截断，上层据此白跑一次补提。
  if (!truncated && events.length >= maxEvents) {
    const probe = await nextPage(1);
    if (probe === null) return fail("read-error", `读取页数超出上限（${MAX_READ_PAGES}）`);
    if (probe.failed) {
      // 探尾失败 → 既不能标"完整"（可能是截断却查不出来），也不能确认"被截断"，
      // 因此整次读取判失败（已读到的条数一并作废，避免上层拿残缺事件去提取）。
      return fail(probe.code, probe.detail);
    }
    const tail = Array.isArray(objOf(probe.page).events) ? objOf(probe.page).events : [];
    truncated = tail.length > 0;
  }

  if (truncated) {
    log.warn(`会话恢复：事件超上限已截断（session=${id}，保留前 ${events.length} 条，上限 ${maxEvents}）`);
  }
  return { ok: true, events, eventState, truncated, read: events.length };
}

/**
 * 构造一个与提取管线兼容的【会话适配对象】。
 *
 * 适配面的取值完全以**代码实际消费**为准（不信文档、不信猜测），来源是：
 *   - id：extractSession 用它做失败连击分键并进 journal 记账（lib/index.js 的 noteFailure /
 *     account 读 session.id，见第 627、652、782、895 行等）；
 *   - header：项目记忆目录由 session.header.cwd 推导（extractSession 第 663-675 行；
 *     cwd 缺失按既有纪律记 no-cwd 失败/放弃）；adapter 只填 cwd，不伪造 header.origin
 *     ——身份伪造会把记忆写成别的项目/别的会话的；
 *   - seq：轮次边界。extractSession 第 677-678 行用 Math.min(toSeq, seq) 把 [from,to] 钳到
 *     实际长度，lib/state.js 的 run 也用它钳 cursor（第 111-113 行）；
 *   - snapshotEvents(from, to)：提取取事件的唯一入口（extractSession 第 680 行）。
 *   以上四处是提取链路对 session 对象的全部触点。
 *
 * cwd 取值顺序（缺哪一环都如实标注，不猜）：
 *   1) meta.cwd        → cwdSource:"meta"
 *   2) meta.stat.header.cwd / meta.header.cwd → cwdSource:"stat"
 *   3) persistence.stat(id) 头部的 cwd       → cwdSource:"stat"
 *   4) 都没有 → 空串 + cwdSource:"none"，交给提取侧照既有的 no-cwd 纪律处理
 *      （与在线会话完全一致：宁可不落盘，也不把记忆写错地方）。
 *
 * @param {object|null} persistence 宿主 sessionPersistence（可为 null：直接用 meta.events 静态构造）
 * @param {string} sessionId 会话 id
 * @param {object} [meta]
 * @param {string} [meta.cwd] 已知的 workspace cwd（优先级最高）
 * @param {object} [meta.stat] 已探到的 stat（含 header / eventCount），省一次 stat 调用
 * @param {Array} [meta.events] 预先读好的事件；给了就不碰宿主
 * @param {Function} [meta.load] 注入的加载器 (persistence, id, opts) => Promise<结果体>，
 *   缺省是本模块的 loadEvents（测试与将来换实现用）
 * @param {number} [meta.maxEvents] 传给加载器的事件上限
 * @param {number} [meta.pageSize] 传给加载器的分页条数
 * @param {Function} [meta.log] 宿主日志口
 * @returns {Promise<object>} { id, seq, header:{cwd}, snapshotEvents(from,to), source }
 *   source = { cwdSource, eventsReady, truncated, eventCount, eventState, error? }——
 *   本模块自己的留痕，不冒充宿主字段；提取侧不读它，上层编排与排障读。
 */
export async function createSessionAdapter(persistence, sessionId, meta = {}) {
  const info = objOf(meta);
  const log = safeLogOf(info.log);
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  const loader = typeof info.load === "function" ? info.load : loadEvents;

  // ── 第一步：事件（有 meta.events 就不碰宿主；否则走 loader，typed error 透到 source.error） ──
  let events = Array.isArray(info.events) ? info.events.slice() : null;
  let truncated = false;
  let eventState;
  let loadError = null;
  if (events === null) {
    const result = await loader(persistence, id, { log, maxEvents: info.maxEvents, pageSize: info.pageSize });
    if (result !== null && typeof result === "object" && result.ok === true) {
      events = Array.isArray(result.events) ? result.events : [];
      truncated = result.truncated === true;
      eventState = result.eventState;
    } else {
      events = [];
      loadError = String(objOf(result).error ?? "read-error");
      if (!RECOVERY_ERRORS.includes(loadError)) loadError = "read-error";
      log.warn(`会话恢复：未能读回事件（session=${id}，${loadError}）——适配器按空事件构造，勿当作补提完成`);
    }
  }

  // ── 第二步：cwd（三级来源，每级都说得出处；取不到 = "" 且 cwdSource:"none"） ──
  let cwd = "";
  let cwdSource = "none";
  const statHeaderCwd = objOf(objOf(info.stat).header).cwd;
  const metaHeaderCwd = objOf(info.header).cwd;
  if (typeof info.cwd === "string" && info.cwd.trim().length > 0) {
    cwd = info.cwd;
    cwdSource = "meta";
  } else {
    const fromMeta = firstString(metaHeaderCwd, statHeaderCwd);
    if (fromMeta.length > 0) {
      cwd = fromMeta;
      cwdSource = "stat";
    } else if (persistence !== null && persistence !== undefined && typeof persistence === "object"
      && typeof persistence.stat === "function") {
      // stat 抛错/返回怪东西 = 拿不到 cwd，绝不因此让适配器构造失败（适配器必须总是可用，
      // 由提取侧走统一的 no-cwd 纪律）。
      let stat = null;
      try {
        stat = await persistence.stat(id);
      } catch (error) {
        log.warn(`会话恢复：stat 失败（session=${id}），cwd 按缺失处理`, error);
        stat = null;
      }
      const fromStat = firstString(objOf(objOf(stat).header).cwd, objOf(stat).cwd);
      if (fromStat.length > 0) {
        cwd = fromStat;
        cwdSource = "stat";
      }
    }
  }

  // seq 恒等于读回的事件数（补提区间里真实的事件边界）。虚报更大的 seq 会让 cursor
  // 推进到从未提取过的位置——那等于把一段记忆静默判死。
  const seq = events.length;
  return {
    id,
    seq,
    header: { cwd },
    // 与宿主 Session.snapshotEvents 同口径：[from, to) 半开切片，直接走 Array.slice
    // （越界/反转由 slice 自身的语义兜，与真实宿主一致，不在这里加二次解释）。
    snapshotEvents(from, to) {
      return events.slice(from, to);
    },
    source: {
      cwdSource,
      eventsReady: loadError === null,
      truncated,
      eventCount: seq,
      eventState,
      ...(loadError === null ? {} : { error: loadError }),
    },
  };
}

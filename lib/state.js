// dsh-keepsake 提取状态机（规格边界①+⑥：去抖合并 + cursor 推进纪律 + 防自反馈）。
//   cursor：进程内 seq，不持久化；首次见到会话时初始化为当前 log 末尾
//           （恢复的会话只提取插件存活期间新完成的轮次，不回扫历史）。
//           唯一例外是【持久化覆盖边界】：journal 记过该会话最后一条结算的
//           cursorAfter（见下方 see()），重放后据此续提——DSH 一重启，进程内
//           cursor 归零，没有它失败区间就永远补不回来（静默丢记忆）。
//   推进纪律：run 结算 status 'ok'（含 skip）→ cursor 推进到快照边界；
//             'error'/abort/异常 → cursor 不动（下轮合并重提）。
//   单飞 + latestPending：running 期间新触发只置 pending（最新边界覆盖旧边界），
//             run 收尾后若 pending 则立即再跑最新区间。
//   防自反馈：提取调用为 request-only 输入，不向任何 session append 事件；
//             插件卸载时 abort 全部在途任务，abort 按 error 处理不推进。
//
// 结算记账纪律（边界①的盘上侧）：每次结算（ok/error/异常）都必须落一条 journal
// ——成功也要落，否则"哪段提取过、推进到哪"在盘上无从查证，重启后只能退回盲提。
// 只写失败是半边账：面板看到的全是红条，反而看不出提取一直在正常工作。
export function createScheduler({
  extract,
  log = { warn: () => {}, error: () => {} },
  drainTimeoutMs = 60000,
  journal,
} = {}) {
  if (typeof extract !== "function") throw new Error("dsh-keepsake: extract function is required");
  // journal 必传（无兼容层：缺它就是接线漏了，静默兜底 = 盘上永远少一行结算，
  // 重启后 cursor 倒退却无人知晓——规则 3 的 fail-open）。
  if (journal === null || typeof journal !== "object"
    || typeof journal.recordRun !== "function" || typeof journal.getCursor !== "function") {
    throw new Error("dsh-keepsake: journal is required (需要 { recordRun, getCursor })");
  }
  const sessions = new Map(); // session 对象 → 状态
  let disposed = false;
  const inflight = new Set();

  function stateOf(session) {
    let state = sessions.get(session);
    if (state === void 0) {
      state = {
        cursor: typeof session?.seq === "number" ? session.seq : 0, // 首见：跳过既有历史
        running: false,
        pending: false,
        pendingTo: 0,
      };
      sessions.set(session, state);
    }
    return state;
  }

  /**
   * 会话首见登记（任意 session/event 都要调）。
   * cursor = 提取覆盖边界（非"看见"边界）：首见事件 seq 很小（≤1）视为新会话，
   * 从 0 全量纳入；否则视为恢复/中途挂载的会话，既有历史不回扫，从下一条起算。
   *
   * 持久化边界优先（跨重启续提）：journal 若记过该会话（getCursor 非 null），
   * cursor 直接用持久值——DSH 重启后进程内 cursor 归零，靠这条才能接着上次
   * 覆盖边界往下提，并把重启前失败的区间一并补上。
   * 只在 journal 有记录时改变行为：从没提取过的会话仍走"首见 seq>1 → seq+1
   * 跳历史"的老路，绝不因为加了这个分支就去回扫历史。
   */
  function see(session, event) {
    if (sessions.has(session)) return;
    const state = stateOf(session);
    const persisted = journal.getCursor(session.id);
    if (persisted !== null && Number.isFinite(persisted)) {
      state.cursor = persisted;
      return;
    }
    const seq = Number(event?.seq);
    state.cursor = Number.isFinite(seq) && seq > 1 ? seq + 1 : 0;
  }

  /** turn/end(completed) 触发入口。toSeq = 快照边界（含 turn/end 事件本身，exclusive）。 */
  function onTurnCompleted(session, toSeq) {
    if (disposed) return;
    const state = stateOf(session);
    if (toSeq <= state.cursor) return; // 该区间已被覆盖（如首见即 completed 的旧轮）
    if (state.running) {
      state.pending = true; // latestPending 合并：只留最新边界
      state.pendingTo = Math.max(state.pendingTo, toSeq);
      return;
    }
    void run(session, state, toSeq);
  }

  /**
   * 结算记账（ok/error 两条结算路径共用同一出口，异常路径单独记 'exception'）。
   * detail 由 extract 给出（{ outcome, reason?, writes?, ... }）；cursorAfter 取
   * 【结算后】的 cursor——这才是该轮真正的覆盖边界，盘上要留的是它。
   * fire-and-forget：recordRun 自身永不抛（写失败只 warn），但 sessionId 非法时
   * 它会抛 TypeError（调用方 bug），故在此 catch 兜住并记日志——记账失败绝不能
   * 反过来炸掉提取主流程（规则 3：不静默吞，也不让观测面拖垮主链路）。
   */
  function account(session, fromSeq, toSeq, cursorAfter, detail) {
    try {
      journal.recordRun({ sessionId: session.id, from: fromSeq, to: toSeq, cursorAfter, ...detail });
    } catch (error) {
      log.error("提取结算记账失败（journal 不可写，重启后 cursor 将退回盘上水准）", error);
    }
  }

  async function run(session, state, toSeq) {
    state.running = true;
    const fromSeq = state.cursor;
    const task = (async () => {
      try {
        if (disposed || state.dropped) return; // 已释放会话不再续跑提取（也不记账：会话已亡）
        const result = await extract(session, fromSeq, toSeq); // { status: 'ok'|'error', detail }
        if (result?.status === "ok") {
          // skip 也推进：cursor 推进到快照末尾（规格 ①）。
          // 钳到 session.seq——宿主"先派发 turn/end 后更 seq"时序下
          // [session.seq, toSeq) 区间不被跨过（宁可下轮重叠不丢）。
          const hostSeq = Number(session?.seq);
          const frontier = Number.isFinite(hostSeq) ? Math.min(toSeq, hostSeq) : toSeq;
          state.cursor = Math.max(state.cursor, frontier);
          // cursorAfter 取结算【后】的真实值：盘上留的是"这段已覆盖到哪"。
          account(session, fromSeq, toSeq, state.cursor, result.detail ?? {});
        } else {
          log.warn(`提取未成功，cursor 不推进（from=${fromSeq} to=${toSeq}）`);
          // error 也要记账：失败区间的 from/to 是跨重启补提的唯一依据，
          // 不落盘 = 重启后这段记忆静默消失。
          account(session, fromSeq, toSeq, state.cursor, result?.detail ?? {});
        }
      } catch (error) {
        // error/abort 不推进（规格 ①⑥）；记日志显式暴露（规则3）
        log.error("提取任务异常，cursor 不推进", error);
        account(session, fromSeq, toSeq, state.cursor, { outcome: "failed", reason: "exception" });
      } finally {
        state.running = false;
      }
    })();
    inflight.add(task);
    try {
      await task;
    } finally {
      inflight.delete(task);
    }
    if (state.pending && !disposed && !state.dropped) {
      state.pending = false;
      const next = state.pendingTo;
      state.pendingTo = 0;
      if (next > state.cursor) void run(session, state, next);
    }
  }

  /** 会话释放（session/disposed）：清除 Map 强持有并标记 dropped，防会话对象泄漏。 */
  function drop(session) {
    const state = sessions.get(session);
    if (state !== void 0) state.dropped = true; // pending 链不再为已释放会话续跑
    sessions.delete(session);
  }

  /**
   * 手动补提入口：对所有 cursor 落后会话重触发一次提取。
   * 复用 onTurnCompleted 的单飞/latestPending 语义（在途 → 合并 pending，绝不并发双跑）；
   * 已释放（dropped/cleared）的会话天然不在 Map 里，不会被补提。
   * @returns {number} 实际触发（含并入 pending）的会话数
   */
  function retryPending() {
    if (disposed) return 0;
    let triggered = 0;
    for (const [session, state] of sessions) {
      if (state.dropped) continue;
      const hostSeq = Number(session?.seq);
      const to = Number.isFinite(hostSeq) ? hostSeq : 0;
      if (to > state.cursor) {
        onTurnCompleted(session, to);
        triggered += 1;
      }
    }
    return triggered;
  }

  /** 插件卸载：abort 语义由 extract 实现方通过外部 signal 承担；此处等待有界 drain。 */
  async function dispose() {
    disposed = true;
    sessions.clear();
    if (inflight.size === 0) return;
    const deadline = Date.now() + drainTimeoutMs;
    while (inflight.size > 0 && Date.now() < deadline) {
      await Promise.race([Promise.allSettled([...inflight]), sleep(50)]);
    }
  }

  /** 等全部在途任务与 pending 链收口（测试与排障用；不置 disposed）。 */
  async function quiesce(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let busy = inflight.size > 0;
      if (!busy) for (const state of sessions.values()) {
        if (state.running || state.pending) {
          busy = true;
          break;
        }
      }
      if (!busy || Date.now() > deadline) return;
      await Promise.race([Promise.allSettled([...inflight]), sleep(10)]);
    }
  }

  return { onTurnCompleted, see, drop, dispose, quiesce, stateOf, retryPending };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

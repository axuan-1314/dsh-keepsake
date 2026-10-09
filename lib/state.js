// dsh-memory 提取状态机（规格边界①+⑥：去抖合并 + cursor 推进纪律 + 防自反馈）。
//   cursor：进程内 seq，不持久化；首次见到会话时初始化为当前 log 末尾
//           （恢复的会话只提取插件存活期间新完成的轮次，不回扫历史）。
//   推进纪律：run 结算 'ok'（含 skip）→ cursor 推进到快照边界；
//             'error'/abort → cursor 不动（下轮合并重提）。
//   单飞 + latestPending：running 期间新触发只置 pending（最新边界覆盖旧边界），
//             run 收尾后若 pending 则立即再跑最新区间。
//   防自反馈：提取调用为 request-only 输入，不向任何 session append 事件；
//             插件卸载时 abort 全部在途任务，abort 按 error 处理不推进。
export function createScheduler({ extract, log = { warn: () => {}, error: () => {} }, drainTimeoutMs = 60000 } = {}) {
  if (typeof extract !== "function") throw new Error("dsh-memory: extract function is required");
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
   */
  function see(session, event) {
    if (sessions.has(session)) return;
    const state = stateOf(session);
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

  async function run(session, state, toSeq) {
    state.running = true;
    const fromSeq = state.cursor;
    const task = (async () => {
      try {
        if (disposed || state.dropped) return; // 全面审查 P3-7：已释放会话不再续跑提取
        const outcome = await extract(session, fromSeq, toSeq); // 'ok' | 'error'
        if (outcome === "ok") {
          // skip 也推进：cursor 推进到快照末尾（规格 ①）。
          // 全面审查 P3-5：钳到 session.seq——宿主"先派发 turn/end 后更 seq"时序下
          // [session.seq, toSeq) 区间不被跨过（宁可下轮重叠不丢）。
          const hostSeq = Number(session?.seq);
          const frontier = Number.isFinite(hostSeq) ? Math.min(toSeq, hostSeq) : toSeq;
          state.cursor = Math.max(state.cursor, frontier);
        } else {
          log.warn(`提取未成功，cursor 不推进（from=${fromSeq} to=${toSeq}）`);
        }
      } catch (error) {
        // error/abort 不推进（规格 ①⑥）；记日志显式暴露（规则3）
        log.error("提取任务异常，cursor 不推进", error);
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

  /** 会话释放（session/disposed）：清除 Map 强持有并标记 dropped，防会话对象泄漏（审查 P3-5）。 */
  function drop(session) {
    const state = sessions.get(session);
    if (state !== void 0) state.dropped = true; // 全面审查 P3-7：pending 链不再为已释放会话续跑
    sessions.delete(session);
  }

  /**
   * 手动补提入口（批F2 V-1）：对所有 cursor 落后会话重触发一次提取。
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

// dsh-keepsake client 半边 —— 门牌（最高频三件套 + 状态摘要 + 打开梯子）。
//   settings.section order 12：
//     主开关（可写，optimistic + 失败回滚）+「DSH 的名字」「对我的称呼」两输入框
//     （防抖即时保存）+ 状态摘要（轮询 30s）+「打开记忆管理」（运行时梯子：
//     window.open+握手 → 原位 iframe → location 往返，每级降级可见提示）+ 主题桥
//     （读 app 页 --dsw-alias-* 变量，postMessage 递给面板）。
//   重操作全在自供整页面板 /dsh-keepsake/panel/（vanilla 单文件，不 inject 官方包）。
//   CSS 手写 dsk-* 类消费 --dsw-alias-*（变量取值均带 fallback）。
// inject 最小集：package.json dsh.client.inject 仅挂
//   @deepseek-ai/dsh-client-ui-slots；react 由官方模块表内置 require。
window.__ModuleLoader__.load({
  id: "dsh-keepsake",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const { useState, useEffect, useRef, useCallback } = react;

    //#region css（dsk-* 手写类，全部消费 --dsw-alias-* 带 fallback）
    const css = [
      ".dsk-plaque{display:flex;flex-direction:column;gap:10px}",
      ".dsk-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".dsk-state{color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".dsk-state b{color:var(--dsw-alias-label-primary);font-weight:600}",
      ".dsk-btn{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}",
      ".dsk-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}",
      ".dsk-btn:disabled{opacity:.45;cursor:default}",
      ".dsk-btnPrimary{background:var(--dsw-alias-button-ghost-active-fill,rgba(128,128,128,.2));font-weight:600}",
      ".dsk-hint{color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".dsk-notice{border-radius:6px;padding:6px 10px;font-size:12px;background:rgba(204,153,102,.16);color:var(--dsw-alias-label-primary)}",
      ".dsk-noticeErr{background:rgba(221,85,85,.14);color:var(--dsw-alias-label-primary)}",
      ".dsk-switchWrap{display:inline-flex;align-items:center;gap:8px}",
      ".dsk-switch{position:relative;width:34px;height:19px;flex:none;display:inline-block}",
      ".dsk-switch input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}",
      ".dsk-slider{position:absolute;inset:0;border-radius:99px;background:rgba(128,128,128,.4);transition:.15s;pointer-events:none}",
      ".dsk-slider::after{content:'';position:absolute;top:2.5px;left:3px;width:14px;height:14px;border-radius:50%;background:#c8cdd4;transition:.15s}",
      ".dsk-switch input:checked + .dsk-slider{background:var(--dsw-alias-state-business-primary,#4176e6)}",
      ".dsk-switch input:checked + .dsk-slider::after{left:17px;background:#fff}",
      ".dsk-fields{display:flex;gap:10px;flex-wrap:wrap}",
      ".dsk-field{display:flex;flex-direction:column;gap:3px;min-width:160px;flex:1;max-width:260px}",
      ".dsk-label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".dsk-inp{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 8px;font-size:12px}",
      ".dsk-inp:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4176e6)}",
      ".dsk-iframeHost{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));border-radius:10px;overflow:hidden;height:70vh;display:flex;flex-direction:column}",
      ".dsk-iframeHead{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2))}",
      ".dsk-iframeBody{flex:1;min-height:0}",
      ".dsk-iframeBody iframe{width:100%;height:100%;border:0}",
    ];
    function ensureCss() {
      if (typeof document === "undefined") return;
      const id = "dsh-keepsake-client-css";
      if (document.getElementById(id)) return;
      const style = document.createElement("style");
      style.id = id;
      style.textContent = css.join("\n");
      document.head.appendChild(style);
    }
    //#endregion

    //#region panel-logic 单一事实源（梯子决策/文案/主题收集）
    //   浏览器页面上下文动态 import 自供模块（panel.js 已按 text/javascript 供给该路径）；
    //   import 失败走下方内联兜底——兜底文案模板与 panel-logic 同构，防漂移检查
    //   test/client-source.test.mjs 逐字钉死，任何一边改动立刻红。
    let LOGIC = null;
    try {
      import("/dsh-keepsake/panel/panel-logic.js")
        .then((m) => { LOGIC = m; })
        .catch(() => { /* 模块不可达：内联兜底已在位 */ });
    } catch { /* 动态 import 不可用（异常宿主环境）：内联兜底已在位 */ }

    // ---- 内联兜底（与 panel-logic.js 导出同构；检查钉模板一致性） ----
    function ladderNoteFallback(tier, reason = "") {
      const suffix = reason ? `（${reason}）` : "";
      if (tier === "iframe") return `新窗口不可用${suffix}，已改为内嵌模式`;
      if (tier === "location") return `内嵌模式不可用${suffix}，已改为跳转模式`;
      return "";
    }
    function decideLadderTierFallback(openResult, handshakeOk) {
      if (openResult === null || openResult === void 0) return "iframe";
      return handshakeOk ? "window" : "iframe"; // location 兜底由 iframe 加载失败再降
    }
    function ladderNoteOf(tier, reason) {
      return LOGIC ? LOGIC.ladderNoteOf(tier, reason) : ladderNoteFallback(tier, reason);
    }
    function decideLadderTier(openResult, handshakeOk) {
      return LOGIC ? LOGIC.decideLadderTier(openResult, handshakeOk) : decideLadderTierFallback(openResult, handshakeOk);
    }

    // ---- 提取管道可观测兜底（门牌红条两行制；与 panel-logic 同构，检查表驱动钉死） ----
    //   只兜门牌真正消费的三个函数（streak 归一/红条文案/错过区间）；三态判定、模型短名、
    //   相对时间目前仅面板健康卡使用，走面板侧 L.* 直连，不在门牌留死兜底（删除优于兼容）。
    function extractionStreakOfFallback(efRaw) {
      if (efRaw && typeof efRaw === "object") return Number(efRaw.streak ?? 0);
      return Number(efRaw ?? 0);
    }
    function extractionNoticeTextFallback(efRaw) {
      const efO = efRaw && typeof efRaw === "object" ? efRaw : null;
      const streak = efO ? Number(efO.streak ?? 0) : Number(efRaw ?? 0);
      if (streak < 1) return "";
      if (!efO || !Array.isArray(efO.recent)) {
        return `记忆自动提取最近连续失败 ${streak} 次，期间对话内容可能未被记录——可在记忆管理面板复制诊断信息（含 /state 快照）反馈给开发者。`;
      }
      const last = efO.recent.length > 0 ? efO.recent[0] : null;
      const reason = last && last.reason ? String(last.reason) : (efO.streakReason ? String(efO.streakReason) : "");
      let model = "";
      if (last && last.model) {
        const s = String(last.model).trim();
        const i = s.lastIndexOf("/");
        model = i >= 0 ? s.slice(i + 1) : s;
      }
      if (reason && model) return `自动提取失败 ${streak} 次 · 最近：${reason}（${model}）`;
      if (reason) return `自动提取失败 ${streak} 次 · 最近：${reason}`;
      return `自动提取失败 ${streak} 次`;
    }
    function extractionRangeTextFallback(efRaw, range) {
      const efO = efRaw && typeof efRaw === "object" ? efRaw : null;
      const streak = efO ? Number(efO.streak ?? 0) : Number(efRaw ?? 0);
      if (streak < 1) return "";
      if (!range || typeof range !== "object") return "";
      const from = Number(range.from);
      if (!Number.isFinite(from)) return "";
      return `第 ${from} 轮对话之后的内容尚未记录，恢复后自动补提`;
    }
    function extractionStreakOf(efRaw) {
      return LOGIC ? LOGIC.extractionStreakOf(efRaw) : extractionStreakOfFallback(efRaw);
    }
    function extractionNoticeText(efRaw) {
      return LOGIC ? LOGIC.extractionNoticeText(efRaw) : extractionNoticeTextFallback(efRaw);
    }
    function extractionRangeText(efRaw, range) {
      return LOGIC ? LOGIC.extractionRangeText(efRaw, range) : extractionRangeTextFallback(efRaw, range);
    }
    // 注入面兜底（与 panel-logic.injectionSummary 同构；无数据且无异常 → null 不渲染）
    //   throttled/superseded 两计数为契约新增：缺失或零值不渲染（旧宿主零影响）
    function injectionExtraFallback(injection) {
      if (!injection || typeof injection !== "object") return "";
      const t = Number(injection.throttled);
      const s = Number(injection.superseded);
      const throttled = Number.isFinite(t) && t > 0 ? Math.floor(t) : 0;
      const superseded = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
      if (throttled === 0 && superseded === 0) return "";
      const parts = [];
      if (throttled > 0) parts.push(`变更节流 ${throttled} 次`);
      if (superseded > 0) parts.push(`取代 ${superseded} 次`);
      return parts.join(" / ");
    }
    function injectionSummaryFallback(injection) {
      if (!injection || typeof injection !== "object") return null;
      const count = Number(injection.count ?? 0);
      const ok = Number.isFinite(count) && count > 0;
      const failures = Number(injection.renderFailures ?? 0);
      const hasFailures = Number.isFinite(failures) && failures > 0;
      if (!ok && !hasFailures) return null;
      if (!ok) return `注入异常 渲染失败 ${Math.floor(failures)} 次`;
      const lastChars = Number(injection.lastChars ?? 0);
      let text = `已注入 ${count} 次 · 最近 ${Number.isFinite(lastChars) && lastChars > 0 ? lastChars : 0} 字符`;
      const dropped = Number(injection.droppedSegments ?? 0);
      if (Number.isFinite(dropped) && dropped > 0) text += ` · 丢段 ${dropped}`;
      if (hasFailures) text += ` · 渲染失败 ${failures}`;
      const extra = injectionExtraFallback(injection);
      if (extra) text += ` · ${extra}`;
      return text;
    }
    function injectionSummary(injection) {
      return LOGIC ? LOGIC.injectionSummary(injection) : injectionSummaryFallback(injection);
    }
    // 存储格式只读兜底（与 panel-logic.formatNoticeText 同构；正常/旧版宿主 → null 不渲染）
    function formatNoticeFallback(format) {
      if (!format || typeof format !== "object") return null;
      if (format.writable !== false) return null;
      const v = Number(format.formatVersion);
      const ver = Number.isFinite(v) && v > 0 ? `v${v}` : "更高版本";
      return `记忆数据由更新版插件（存储格式 ${ver}）写入，本插件已转为只读：不再记录新记忆，管理页写入被拒。升级 dsh-keepsake 后自动恢复。`;
    }
    function formatNotice(format) {
      return LOGIC ? LOGIC.formatNoticeText(format) : formatNoticeFallback(format);
    }
    //#endregion

    //#region 主题桥发送端（样式表枚举 + computed 取值）
    //   优先消费 panel-logic.collectThemeVarsFromDoc（单一实现），
    //   模块未就绪时走参数化内联兜底（仅模块加载窗口期/失败时触达）。
    const THEME_PREFIX = "--dsw-alias-";
    function collectThemeVarsFallback(doc) {
      const out = {};
      try {
        const computed = doc.defaultView.getComputedStyle(doc.body);
        const names = new Set();
        for (const sheet of Array.from(doc.styleSheets)) {
          try {
            for (const rule of Array.from(sheet.cssRules || [])) {
              if (!rule || !rule.style) continue;
              for (let i = 0; i < rule.style.length; i += 1) {
                const n = rule.style[i];
                if (typeof n === "string" && n.startsWith(THEME_PREFIX)) names.add(n);
              }
            }
          } catch { /* 跨源样式表忽略 */ }
        }
        for (const name of names) {
          const v = computed.getPropertyValue(name);
          if (typeof v === "string" && v.length > 0) out[name] = v.trim();
        }
      } catch { /* 收集失败=桥降级（面板自带双档） */ }
      return out;
    }
    function collectThemeVars() {
      if (LOGIC) return LOGIC.collectThemeVarsFromDoc(document);
      return collectThemeVarsFallback(document);
    }
    //#endregion

    //#region API helper（相对路径 fetch，反代自动带鉴权 cookie）
    async function api(path, options) {
      const res = await fetch("/dsh-keepsake/api/" + path, options);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
      return body;
    }
    //#endregion

    const PANEL_PATH = "/dsh-keepsake/panel/";
    const PANEL_READY_MSG = "dsh-keepsake:panel-ready";
    const THEME_MSG = "dsh-keepsake:theme";
    const PANEL_CLOSE_MSG = "dsh-keepsake:panel-close"; // 面板「返回设置」→ iframe 档收起（协议常量进检查）
    const HANDSHAKE_TIMEOUT_MS = 2000;
    const STATE_POLL_MS = 30000;
    const ADDRESS_SAVE_DEBOUNCE_MS = 600;
    const ADDRESS_MAX_LEN = 40; // 与服务端 slice(0,40) 对齐（截断必须可见）

    function Plaque() {
      const [state, setState] = useState(null);
      // [已知] 拆槽：pollError 只装轮询失败（下轮 poll 成功自清）；
      // actionError 只装动作失败（开关/称呼写入），仅由后续动作成功或用户点「知道了」清除——
      // 轮询不得顺带抹掉写失败告警（fail-open 味道的告警吞没）。
      const [pollError, setPollError] = useState(null);
      const [actionError, setActionError] = useState(null);
      const [mainOn, setMainOn] = useState(true); // 主开关本地态（optimistic）
      const [busy, setBusy] = useState(false);
      const [dshName, setDshName] = useState("");
      const [userAlias, setUserAlias] = useState("");
      const [saveHint, setSaveHint] = useState("");
      const [ladderNote, setLadderNote] = useState("");
      const [ladderLevel, setLadderLevel] = useState(""); // ""|iframe
      const iframeHostRef = useRef(null);
      const handshookRef = useRef(false);
      const addrTimerRef = useRef(null);
      const addrInitRef = useRef(false);
      const busyRef = useRef(false); // toggleMain in-flight 标志（reqSeq 防线要读同步值）
      const reqSeqRef = useRef(0); // [已知] 请求序号防线：写前发起的旧 GET 返回后不得翻回开关
      const ladderGenRef = useRef(0); // 梯子代际号：收起/卸载/换轮时递增作废旧轮回调
      const lastStreakRef = useRef(null); // 上次轮询的提取连击数——「红条从有到无」一次性提示的判断沿

      // ---- 状态轮询（轻态端点） ----
      const refreshState = useCallback(() => {
        const seq = ++reqSeqRef.current; // 取号：toggleMain 成功后强刷会再取号作废旧响应
        return api("state")
          .then((j) => {
            if (seq !== reqSeqRef.current) return; // 旧响应（序号已被作废）静默丢弃
            setState(j);
            setPollError(null);
            if (!addrInitRef.current) {
              addrInitRef.current = true;
              setDshName(j.addressing?.dshName ?? "");
              setUserAlias(j.addressing?.userAlias ?? "");
            }
            // [已知] 轮询在途回滚：开关写 in-flight 期间不回写开关（写完强刷拿真值）
            if (!busyRef.current) setMainOn(j.settings?.conversationMemory !== false);
            // 红条从有到无 → 一次性「提取已恢复」（沿存 ref 判断，不随后续轮询重放）
            const streakNow = extractionStreakOf(j.extractionFailures);
            if (lastStreakRef.current !== null && lastStreakRef.current > 0 && streakNow === 0) {
              setSaveHint("提取已恢复");
              setTimeout(() => setSaveHint(""), 3000);
            }
            lastStreakRef.current = streakNow;
          })
          .catch((e) => {
            if (seq === reqSeqRef.current) setPollError(String(e && e.message ? e.message : e));
          });
      }, []);

      useEffect(() => {
        ensureCss();
        refreshState();
        const timer = setInterval(refreshState, STATE_POLL_MS);
        return () => clearInterval(timer);
      }, [refreshState]);

      // Plaque 卸载（离开设置页）必须作废梯子代际——
      // 挂起的 2s/8s 握手定时器不得在卸载后劫持整页 location 跳转。
      useEffect(() => () => { ladderGenRef.current += 1; }, []);

      // ---- 消息监听：面板 ready 推主题 + 面板「返回设置」请求收起（iframe 档） ----
      useEffect(() => {
        const onMessage = (ev) => {
          if (!ev || !ev.data || typeof ev.data !== "object") return;
          if (ev.data.type === PANEL_READY_MSG && !handshookRef.current) {
            handshookRef.current = true;
            try {
              ev.source.postMessage({ type: THEME_MSG, vars: collectThemeVars() }, ev.origin);
            } catch { /* 桥失败：面板走自带双档降级 */ }
          }
          if (ev.data.type === PANEL_CLOSE_MSG) {
            // 面板侧「返回设置」分档：iframe 档由宿主收起。
            // 幂等无害：收起空梯子等于 no-op；来源不限（该消息只触发收起动作，无破坏面）。
            ladderGenRef.current += 1; // 作废挂起的握手/降级定时器（同款中止）
            setLadderLevel("");
            setLadderNote("");
          }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
      }, []);

      // ---- 主开关（optimistic 写 + 失败回滚；host mtime 读取下一轮即生效） ----
      const toggleMain = useCallback(() => {
        if (busy) return;
        const next = !mainOn;
        setMainOn(next); // optimistic
        setBusy(true);
        busyRef.current = true;
        api("settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationMemory: next }),
        })
          .then(() => {
            setActionError(null); // 动作成功清除本槽告警（拆槽语义）
            setSaveHint(next ? "已开启，下一轮对话生效" : "已关闭，下一轮对话生效");
            reqSeqRef.current += 1; // 作废在途旧 GET（[已知] 轮询回滚）
            refreshState(); // 成功后立即强刷拿服务端真值
          })
          .catch((e) => {
            setMainOn(!next); // 回滚
            setActionError("开关写入失败：" + String(e && e.message ? e.message : e));
          })
          .finally(() => {
            busyRef.current = false;
            setBusy(false);
            setTimeout(() => setSaveHint(""), 3000);
          });
      }, [busy, mainOn, refreshState]);

      // ---- 称呼输入（防抖即时保存；字段级：只发被编辑字段，服务端字段合并已备好） ----
      const scheduleAddressingSave = useCallback((field, value) => {
        if (addrTimerRef.current !== null) clearTimeout(addrTimerRef.current);
        addrTimerRef.current = setTimeout(() => {
          addrTimerRef.current = null;
          api("addressing", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ [field]: value }),
          })
            .then(() => {
              setActionError(null); // 动作成功清除本槽告警
              setSaveHint("称呼已保存，下一轮对话生效");
              setTimeout(() => setSaveHint(""), 3000);
            })
            .catch((e) => setActionError("称呼保存失败：" + String(e && e.message ? e.message : e)));
        }, ADDRESS_SAVE_DEBOUNCE_MS);
      }, []);

      // ---- 运行时梯子（裁决三）：①window.open+握手 → ②原位 iframe → ③location ----
      // 代际号纪律：每轮 openPanel 取新代际；「收起」/Plaque 卸载/面板请求收起
      // 都递增代际——挂起的握手与降级定时器在代际作废后一律静默丢弃，绝不整页跳转劫持。
      const abortLadder = useCallback(() => {
        ladderGenRef.current += 1; // 作废一切旧代际回调（giveUp / 握手 timer / 降级链）
        setLadderLevel("");
        setLadderNote("");
      }, []);

      const fallbackToLocation = useCallback((note, gen, path) => {
        if (gen !== ladderGenRef.current) return; // 旧代际静默丢弃（双保险：giveUp 已拦一道）
        setLadderNote(note);
        window.location.href = path || PANEL_PATH; // 深链路径随梯子透传（面板内"返回设置"跳回）
      }, []);

      const fallbackToIframe = useCallback((note, path) => {
        const gen = ladderGenRef.current; // 与本轮 openPanel 同代际（继承，不另取号）
        setLadderNote(note);
        setLadderLevel("iframe");
        setTimeout(() => {
          if (gen !== ladderGenRef.current) return; // 挂起期间被收起/卸载/换轮
          const host = iframeHostRef.current;
          if (!host) return;
          const frame = document.createElement("iframe");
          frame.src = path || PANEL_PATH; // 深链路径随梯子透传
          // 握手判活：被 CSP 拦截/404 的 iframe 同样触发 load 事件，
          // 只有面板脚本真正跑起来才会回发 panel-ready——与 window 档同一判活标准。
          // ready 只认本 frame 的回执（ev.source）——并发的另一梯
          // （慢 iframe + 新 popup）互不误点亮，死档照常降级。
          let ready = false;
          const onReady = (ev) => {
            if (ev && ev.source === frame.contentWindow && ev.data && ev.data.type === PANEL_READY_MSG) {
              ready = true;
              window.removeEventListener("message", onReady);
            }
          };
          window.addEventListener("message", onReady);
          const giveUp = (why) => {
            if (ready) return;
            window.removeEventListener("message", onReady);
            // 收起/卸载（代际作废）或 frame 已脱离 DOM → 静默丢弃，不跳转
            if (gen !== ladderGenRef.current || !frame.isConnected) return;
            fallbackToLocation(ladderNoteOf("location", why), gen, path);
          };
          frame.addEventListener("load", () => {
            // load 只说明框架文档到了（可能是错误页），load 后再留握手窗口
            setTimeout(() => giveUp("iframe 加载后未回执握手，可能被拦截"), HANDSHAKE_TIMEOUT_MS);
          }, true);
          frame.addEventListener("error", () => {
            giveUp("iframe 加载出错");
          }, true);
          host.appendChild(frame);
          // 总兜底：连 load 都没触发（挂载即失败）
          setTimeout(() => giveUp("iframe 未加载成功"), HANDSHAKE_TIMEOUT_MS * 4);
        }, 0);
      }, [fallbackToLocation]);

      const openPanel = useCallback((hash) => {
        // 门牌「详情」深链——三档梯子都带面板路由（如 #/settings）；非字符串
        // （React onClick 事件对象误入等）按无深链处理
        const path = typeof hash === "string" && hash.length > 0 ? PANEL_PATH + hash : PANEL_PATH;
        const gen = ++ladderGenRef.current; // 新一轮梯子：作废旧轮回调
        // 入口复位档位并清掉旧内嵌面板——popup 成功后旧 iframe 不得双面板并存
        setLadderLevel("");
        setLadderNote("");
        if (iframeHostRef.current) iframeHostRef.current.innerHTML = "";
        let win = null;
        try {
          win = window.open(path, "_blank");
        } catch {
          win = null;
        }
        // 档位决策（走 panel-logic 单一实现，import 失败内联兜底）：
        // window.open 被拦（null/undefined）→ decideLadderTier 恒判 iframe 档
        if (decideLadderTier(win, true) !== "window") {
          fallbackToIframe(ladderNoteOf("iframe", "window.open 返回空"), path);
          return;
        }
        // 本次打开的局部握手标志（不复用 handshookRef——它首次成功后
        // 永不复位，第二次打开若新窗口加载失败将永不降级）
        let ready = false;
        // 只认本窗口的回执（ev.source === win）
        const onReady = (ev) => {
          if (ev && ev.source === win && ev.data && ev.data.type === PANEL_READY_MSG) {
            ready = true;
            clearTimeout(timer);
            window.removeEventListener("message", onReady);
          }
        };
        const timer = setTimeout(() => {
          window.removeEventListener("message", onReady);
          // 旧轮（用户已收起/又开一轮）→ 静默放弃：不关新窗、不降级
          if (gen !== ladderGenRef.current) return;
          if (decideLadderTier(win, ready) === "window") return; // 已回执（保险位）
          try { win.close(); } catch { /* ignore */ }
          fallbackToIframe(ladderNoteOf("iframe", "新窗口 2 秒未回执握手"), path);
        }, HANDSHAKE_TIMEOUT_MS);
        window.addEventListener("message", onReady);
      }, [fallbackToIframe]);

      // ---- 渲染 ----
      const settings = state && state.settings ? state.settings : null;
      const counts = state && state.counts ? state.counts : null;
      // /state 新字段 tolerant 消费：字段缺失（旧版服务端）时 falsy 零影响
      const corruptBits = [];
      if (state && state.corrupt) corruptBits.push("settings.json（开关）");
      if (state && state.addressingCorrupt) corruptBits.push("addressing.json（称呼）");
      if (state && state.personaCorrupt) corruptBits.push("persona.md（人设）");
      // 红条两行制：行1 计数+病因+模型（modelShortName 末段，纯函数内收）；
      // 行2 错过区间（次级色，仅 streak>0 且 lastFailedRange 在场）。
      // 文案与归一走 panel-logic（双端一致）；旧服务端（无 recent/数字形态）沿用旧单行文案。
      const efRaw = state ? state.extractionFailures : null;
      const extractionNotice = extractionNoticeText(efRaw);
      const extractionRange = state ? extractionRangeText(efRaw, state.lastFailedRange) : "";
      // 注入面摘要（消息通道注入健康）——无数据不显示
      const injectionLine = state ? injectionSummary(state.injection) : null;
      // 存储格式只读告警——仅"数据由更新版插件写入"时显示（正常/旧版宿主不渲染）
      const formatNoticeLine = state ? formatNotice(state.format) : null;

      return react.createElement(
        "div",
        { className: "dsk-plaque" },
        react.createElement(
          "div",
          { className: "dsk-row" },
          react.createElement(
            "span",
            { className: "dsk-switchWrap" },
            react.createElement(
              "label",
              { className: "dsk-switch" },
              react.createElement("input", {
                type: "checkbox",
                checked: mainOn,
                disabled: busy,
                onChange: toggleMain,
                title: "对话记忆总开关：关闭后 DSH 不带任何记忆、也不再自动记录（下一轮对话生效）",
              }),
              react.createElement("span", { className: "dsk-slider" }),
            ),
            react.createElement("span", { className: "dsk-hint" }, mainOn ? "记忆已开启" : "记忆已关闭"),
          ),
          react.createElement(
            "button",
            // openPanel(hash) 收深链参数——主入口不带 hash；箭头包裹防 React 事件对象误入首参
            { className: "dsk-btn dsk-btnPrimary", onClick: () => openPanel() },
            "打开记忆管理",
          ),
          saveHint !== "" ? react.createElement("span", { className: "dsk-hint" }, saveHint) : null,
        ),
        react.createElement(
          "div",
          { className: "dsk-fields" },
          react.createElement(
            "div",
            { className: "dsk-field" },
            react.createElement("label", { className: "dsk-label" }, "DSH 的名字 · " + dshName.length + "/" + ADDRESS_MAX_LEN),
            react.createElement("input", {
              className: "dsk-inp",
              value: dshName,
              maxLength: ADDRESS_MAX_LEN, // 与服务端 slice(0,40) 对齐，截断必须可见
              placeholder: "例如：小助手（留空则不称呼）",
              onChange: (e) => {
                addrInitRef.current = true; // 动过即初始化——慢到的首轮 poll 不得覆盖用户输入
                setDshName(e.target.value);
                scheduleAddressingSave("dshName", e.target.value); // 字段级保存
              },
            }),
          ),
          react.createElement(
            "div",
            { className: "dsk-field" },
            react.createElement("label", { className: "dsk-label" }, "对我的称呼 · " + userAlias.length + "/" + ADDRESS_MAX_LEN),
            react.createElement("input", {
              className: "dsk-inp",
              value: userAlias,
              maxLength: ADDRESS_MAX_LEN,
              placeholder: "例如：朋友（留空则不称呼）",
              onChange: (e) => {
                addrInitRef.current = true;
                setUserAlias(e.target.value);
                scheduleAddressingSave("userAlias", e.target.value);
              },
            }),
          ),
        ),
        react.createElement(
          "div",
          { className: "dsk-state" },
          pollError !== null
            ? "状态获取失败：" + pollError + "（host 未就绪或路由未注册）"
            : state === null
              ? "正在获取记忆状态…"
              : [
                    // 开关态已由上方开关旁 hint 显示，这里不重复，只报计数与相关开关
                    "全局 " + String(counts && typeof counts.global === "number" ? counts.global : 0) + " 条",
                    String(counts && typeof counts.projects === "number" ? counts.projects : 0) + " 个项目",
                  ].join(" · ") +
                (settings && settings.projectMemory === false ? "（项目记忆已关）" : "") +
                (settings && settings.globalExtraction === false ? "（全局提取已关）" : ""),
        ),
        // 注入面摘要行（无数据/旧版宿主时不渲染）
        injectionLine !== null
          ? react.createElement("div", { className: "dsk-hint" }, "注入：" + injectionLine)
          : null,
        // 存储格式只读告警行（仅数据由更新版插件写入时渲染；显式可见不静默）
        formatNoticeLine !== null
          ? react.createElement(
              "div",
              { className: "dsk-notice dsk-noticeErr" },
              react.createElement("span", null, "⚠️ " + formatNoticeLine),
            )
          : null,
        actionError !== null
          ? react.createElement(
              "div",
              { className: "dsk-notice dsk-noticeErr" },
              react.createElement("span", null, actionError),
              react.createElement(
                "button",
                { className: "dsk-btn", onClick: () => setActionError(null), style: { marginLeft: "8px", flex: "none" } },
                "知道了",
              ),
            )
          : null,
        corruptBits.length > 0
          ? react.createElement(
              "div",
              { className: "dsk-notice dsk-noticeErr" },
              "解析失败（已按缺省运行）：" + corruptBits.join("、") + "——请到面板重新保存对应内容以重写修复。",
            )
          : null,
        extractionNotice !== ""
          ? react.createElement(
              "div",
              { className: "dsk-notice dsk-noticeErr" },
              react.createElement(
                "div",
                { className: "dsk-row", style: { rowGap: "4px" } },
                react.createElement("span", null, extractionNotice),
                react.createElement(
                  "button",
                  // 「详情」跳面板设置页——三档梯子都带 #/settings 深链 + 健康卡锚点滚动
                  { className: "dsk-btn", onClick: () => openPanel("#/settings"), style: { flex: "none" } },
                  "详情",
                ),
              ),
              extractionRange !== ""
                ? react.createElement("div", { className: "dsk-hint", style: { marginTop: "4px" } }, extractionRange)
                : null,
            )
          : null,
        ladderNote !== ""
          ? react.createElement("div", { className: "dsk-notice" }, ladderNote)
          : null,
        ladderLevel === "iframe"
          ? react.createElement(
              "div",
              { className: "dsk-iframeHost" },
              react.createElement(
                "div",
                { className: "dsk-iframeHead" },
                react.createElement("span", { className: "dsk-hint" }, "记忆管理（内嵌模式）"),
                react.createElement(
                  "button",
                  {
                    className: "dsk-btn",
                    onClick: abortLadder, // 收起=递增代际，作废挂起的握手/降级定时器
                  },
                  "收起",
                ),
              ),
              react.createElement("div", { className: "dsk-iframeBody", ref: iframeHostRef }),
            )
          : null,
      );
    }

    const inject = ["slots"];

    function apply(ctx) {
      ensureCss();
      // 门牌（settings.section order 12）。
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "memory",
            order: 12,
            label: () => "记忆",
          },
          Plaque,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

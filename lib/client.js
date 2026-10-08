// dsh-memory client 半边 —— 门牌（方案C §1.2：最高频三件套 + 状态摘要 + 打开梯子）。
//   settings.section order 12（qudao 11 之后）：
//     主开关（可写，optimistic + 失败回滚）+「DSH 的名字」「对我的称呼」两输入框
//     （防抖即时保存）+ 状态摘要（轮询 30s）+「打开记忆管理」（运行时梯子：
//     window.open+握手 → 原位 iframe → location 往返，每级降级可见提示）+ 主题桥
//     （读 app 页 --dsw-alias-* 变量，postMessage 递给面板）。
//   重操作全在自供整页面板 /dsh-memory/panel/（vanilla 单文件，不 inject 官方包）。
//   CSS 手写 dsm-* 类消费 --dsw-alias-*（照 qudao dqd-* 配方，变量取值均带 fallback）。
// inject 最小集（M0 P8 定案）：package.json dsh.client.inject 仅挂
//   @deepseek-ai/dsh-client-ui-slots；react 由官方模块表内置 require。
window.__ModuleLoader__.load({
  id: "dsh-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const { useState, useEffect, useRef, useCallback } = react;

    //#region css（dsm-* 手写类，全部消费 --dsw-alias-* 带 fallback）
    const css = [
      ".dsm-plaque{display:flex;flex-direction:column;gap:10px}",
      ".dsm-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".dsm-state{color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".dsm-state b{color:var(--dsw-alias-label-primary);font-weight:600}",
      ".dsm-btn{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}",
      ".dsm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}",
      ".dsm-btn:disabled{opacity:.45;cursor:default}",
      ".dsm-btnPrimary{background:var(--dsw-alias-button-ghost-active-fill,rgba(128,128,128,.2));font-weight:600}",
      ".dsm-hint{color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".dsm-notice{border-radius:6px;padding:6px 10px;font-size:12px;background:rgba(204,153,102,.16);color:var(--dsw-alias-label-primary)}",
      ".dsm-noticeErr{background:rgba(221,85,85,.14);color:var(--dsw-alias-label-primary)}",
      ".dsm-switchWrap{display:inline-flex;align-items:center;gap:8px}",
      ".dsm-switch{position:relative;width:34px;height:19px;flex:none;display:inline-block}",
      ".dsm-switch input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}",
      ".dsm-slider{position:absolute;inset:0;border-radius:99px;background:rgba(128,128,128,.4);transition:.15s;pointer-events:none}",
      ".dsm-slider::after{content:'';position:absolute;top:2.5px;left:3px;width:14px;height:14px;border-radius:50%;background:#c8cdd4;transition:.15s}",
      ".dsm-switch input:checked + .dsm-slider{background:var(--dsw-alias-state-business-primary,#4176e6)}",
      ".dsm-switch input:checked + .dsm-slider::after{left:17px;background:#fff}",
      ".dsm-fields{display:flex;gap:10px;flex-wrap:wrap}",
      ".dsm-field{display:flex;flex-direction:column;gap:3px;min-width:160px;flex:1;max-width:260px}",
      ".dsm-label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".dsm-inp{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 8px;font-size:12px}",
      ".dsm-inp:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4176e6)}",
      ".dsm-iframeHost{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));border-radius:10px;overflow:hidden;height:70vh;display:flex;flex-direction:column}",
      ".dsm-iframeHead{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2))}",
      ".dsm-iframeBody{flex:1;min-height:0}",
      ".dsm-iframeBody iframe{width:100%;height:100%;border:0}",
    ];
    function ensureCss() {
      if (typeof document === "undefined") return;
      const id = "dsh-memory-client-css";
      if (document.getElementById(id)) return;
      const style = document.createElement("style");
      style.id = id;
      style.textContent = css.join("\n");
      document.head.appendChild(style);
    }
    //#endregion

    //#region panel-logic 单一事实源（U-DRI1 收敛：梯子决策/文案/主题收集）
    //   浏览器页面上下文动态 import 自供模块（panel.js 已按 text/javascript 供给该路径）；
    //   import 失败走下方内联兜底——兜底文案模板与 panel-logic 同构，防漂移检查
    //   test/client-source.test.mjs 逐字钉死，任何一边改动立刻红。
    let LOGIC = null;
    try {
      import("/dsh-memory/panel/panel-logic.js")
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
    //#endregion

    //#region 主题桥发送端（M0 P7 定案：样式表枚举 + computed 取值）
    //   U-DRI1：优先消费 panel-logic.collectThemeVarsFromDoc（单一实现），
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
      const res = await fetch("/dsh-memory/api/" + path, options);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
      return body;
    }
    //#endregion

    const PANEL_PATH = "/dsh-memory/panel/";
    const PANEL_READY_MSG = "dsh-memory:panel-ready";
    const THEME_MSG = "dsh-memory:theme";
    const PANEL_CLOSE_MSG = "dsh-memory:panel-close"; // 面板「返回设置」→ iframe 档收起（协议常量进检查）
    const HANDSHAKE_TIMEOUT_MS = 2000;
    const STATE_POLL_MS = 30000;
    const ADDRESS_SAVE_DEBOUNCE_MS = 600;
    const ADDRESS_MAX_LEN = 40; // 与服务端 slice(0,40) 对齐（P3-12：截断必须可见）

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
      const ladderGenRef = useRef(0); // U-LAD1 梯子代际号：收起/卸载/换轮时递增作废旧轮回调

      // ---- 状态轮询（R6 轻态端点） ----
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

      // U-LAD1：Plaque 卸载（离开设置页）必须作废梯子代际——
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
            // 面板侧「返回设置」分档（P3-1）：iframe 档由宿主收起。
            // 幂等无害：收起空梯子等于 no-op；来源不限（该消息只触发收起动作，无破坏面）。
            ladderGenRef.current += 1; // 作废挂起的握手/降级定时器（U-LAD1 同款中止）
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

      // ---- 称呼输入（防抖即时保存；P3-9 字段级：只发被编辑字段，服务端字段合并已备好） ----
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
      // U-LAD1 代际号纪律：每轮 openPanel 取新代际；「收起」/Plaque 卸载/面板请求收起
      // 都递增代际——挂起的握手与降级定时器在代际作废后一律静默丢弃，绝不整页跳转劫持。
      const abortLadder = useCallback(() => {
        ladderGenRef.current += 1; // 作废一切旧代际回调（giveUp / 握手 timer / 降级链）
        setLadderLevel("");
        setLadderNote("");
      }, []);

      const fallbackToLocation = useCallback((note, gen) => {
        if (gen !== ladderGenRef.current) return; // 旧代际静默丢弃（双保险：giveUp 已拦一道）
        setLadderNote(note);
        window.location.href = PANEL_PATH; // 面板内"返回设置"跳回
      }, []);

      const fallbackToIframe = useCallback((note) => {
        const gen = ladderGenRef.current; // 与本轮 openPanel 同代际（继承，不另取号）
        setLadderNote(note);
        setLadderLevel("iframe");
        setTimeout(() => {
          if (gen !== ladderGenRef.current) return; // 挂起期间被收起/卸载/换轮
          const host = iframeHostRef.current;
          if (!host) return;
          const frame = document.createElement("iframe");
          frame.src = PANEL_PATH;
          // 握手判活（审查 P2 修复）：被 CSP 拦截/404 的 iframe 同样触发 load 事件，
          // 只有面板脚本真正跑起来才会回发 panel-ready——与 window 档同一判活标准。
          // P3-3：ready 只认本 frame 的回执（ev.source）——并发的另一梯
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
            // U-LAD1：收起/卸载（代际作废）或 frame 已脱离 DOM → 静默丢弃，不跳转
            if (gen !== ladderGenRef.current || !frame.isConnected) return;
            fallbackToLocation(ladderNoteOf("location", why), gen);
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

      const openPanel = useCallback(() => {
        const gen = ++ladderGenRef.current; // 新一轮梯子：作废旧轮回调
        // P3-2：入口复位档位并清掉旧内嵌面板——popup 成功后旧 iframe 不得双面板并存
        setLadderLevel("");
        setLadderNote("");
        if (iframeHostRef.current) iframeHostRef.current.innerHTML = "";
        let win = null;
        try {
          win = window.open(PANEL_PATH, "_blank");
        } catch {
          win = null;
        }
        // 档位决策（U-DRI1：走 panel-logic 单一实现，import 失败内联兜底）：
        // window.open 被拦（null/undefined）→ decideLadderTier 恒判 iframe 档
        if (decideLadderTier(win, true) !== "window") {
          fallbackToIframe(ladderNoteOf("iframe", "window.open 返回空"));
          return;
        }
        // 本次打开的局部握手标志（审查 P3 修复：不复用 handshookRef——它首次成功后
        // 永不复位，第二次打开若新窗口加载失败将永不降级）
        let ready = false;
        // P3-3：只认本窗口的回执（ev.source === win）
        const onReady = (ev) => {
          if (ev && ev.source === win && ev.data && ev.data.type === PANEL_READY_MSG) {
            ready = true;
            clearTimeout(timer);
            window.removeEventListener("message", onReady);
          }
        };
        const timer = setTimeout(() => {
          window.removeEventListener("message", onReady);
          // U-LAD1：旧轮（用户已收起/又开一轮）→ 静默放弃：不关新窗、不降级
          if (gen !== ladderGenRef.current) return;
          if (decideLadderTier(win, ready) === "window") return; // 已回执（保险位）
          try { win.close(); } catch { /* ignore */ }
          fallbackToIframe(ladderNoteOf("iframe", "新窗口 2 秒未回执握手"));
        }, HANDSHAKE_TIMEOUT_MS);
        window.addEventListener("message", onReady);
      }, [fallbackToIframe]);

      // ---- 渲染 ----
      const settings = state && state.settings ? state.settings : null;
      const counts = state && state.counts ? state.counts : null;
      // 批次A /state 新字段 tolerant 消费：字段缺失（旧版服务端）时 falsy 零影响
      const corruptBits = [];
      if (state && state.corrupt) corruptBits.push("settings.json（开关）");
      if (state && state.addressingCorrupt) corruptBits.push("addressing.json（称呼）");
      if (state && state.personaCorrupt) corruptBits.push("persona.md（人设）");
      // P-PIPE1：extractionFailures 是分桶对象 {no-route,...,streak}（旧服务端可能缺）——
      // 红条文案是"最近连续失败"，取 streak（同因连击）；对象缺席时按数字兜底。
      const efRaw = state ? state.extractionFailures : null;
      const extractionFailures = efRaw && typeof efRaw === "object"
        ? Number(efRaw.streak ?? 0)
        : Number(efRaw ?? 0);

      return react.createElement(
        "div",
        { className: "dsm-plaque" },
        react.createElement(
          "div",
          { className: "dsm-row" },
          react.createElement(
            "span",
            { className: "dsm-switchWrap" },
            react.createElement(
              "label",
              { className: "dsm-switch" },
              react.createElement("input", {
                type: "checkbox",
                checked: mainOn,
                disabled: busy,
                onChange: toggleMain,
                title: "对话记忆总开关：关闭后 DSH 不带任何记忆、也不再自动记录（下一轮对话生效）",
              }),
              react.createElement("span", { className: "dsm-slider" }),
            ),
            react.createElement("span", { className: "dsm-hint" }, mainOn ? "记忆已开启" : "记忆已关闭"),
          ),
          react.createElement(
            "button",
            { className: "dsm-btn dsm-btnPrimary", onClick: openPanel },
            "打开记忆管理",
          ),
          saveHint !== "" ? react.createElement("span", { className: "dsm-hint" }, saveHint) : null,
        ),
        react.createElement(
          "div",
          { className: "dsm-fields" },
          react.createElement(
            "div",
            { className: "dsm-field" },
            react.createElement("label", { className: "dsm-label" }, "DSH 的名字 · " + dshName.length + "/" + ADDRESS_MAX_LEN),
            react.createElement("input", {
              className: "dsm-inp",
              value: dshName,
              maxLength: ADDRESS_MAX_LEN, // P3-12：与服务端 slice(0,40) 对齐，截断必须可见
              placeholder: "例如：小舟（留空则不称呼）",
              onChange: (e) => {
                addrInitRef.current = true; // P3-7：动过即初始化——慢到的首轮 poll 不得覆盖用户输入
                setDshName(e.target.value);
                scheduleAddressingSave("dshName", e.target.value); // P3-9：字段级保存
              },
            }),
          ),
          react.createElement(
            "div",
            { className: "dsm-field" },
            react.createElement("label", { className: "dsm-label" }, "对我的称呼 · " + userAlias.length + "/" + ADDRESS_MAX_LEN),
            react.createElement("input", {
              className: "dsm-inp",
              value: userAlias,
              maxLength: ADDRESS_MAX_LEN,
              placeholder: "例如：老板（留空则不称呼）",
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
          { className: "dsm-state" },
          pollError !== null
            ? "状态获取失败：" + pollError + "（host 未就绪或路由未注册）"
            : state === null
              ? "正在获取记忆状态…"
              : [
                    mainOn ? "记忆已开启" : "记忆已关闭",
                    "全局 " + String(counts && typeof counts.global === "number" ? counts.global : 0) + " 条",
                    String(counts && typeof counts.projects === "number" ? counts.projects : 0) + " 个项目",
                  ].join(" · ") +
                (settings && settings.projectMemory === false ? "（项目记忆已关）" : "") +
                (settings && settings.globalExtraction === false ? "（全局提取已关）" : ""),
        ),
        actionError !== null
          ? react.createElement(
              "div",
              { className: "dsm-notice dsm-noticeErr" },
              react.createElement("span", null, actionError),
              react.createElement(
                "button",
                { className: "dsm-btn", onClick: () => setActionError(null), style: { marginLeft: "8px", flex: "none" } },
                "知道了",
              ),
            )
          : null,
        corruptBits.length > 0
          ? react.createElement(
              "div",
              { className: "dsm-notice dsm-noticeErr" },
              "解析失败（已按缺省运行）：" + corruptBits.join("、") + "——请到面板重新保存对应内容以重写修复。",
            )
          : null,
        extractionFailures > 0
          ? react.createElement(
              "div",
              { className: "dsm-notice dsm-noticeErr" },
              "记忆自动提取最近连续失败 " + extractionFailures + " 次，期间对话内容可能未被记录——请检查服务端日志。",
            )
          : null,
        ladderNote !== ""
          ? react.createElement("div", { className: "dsm-notice" }, ladderNote)
          : null,
        ladderLevel === "iframe"
          ? react.createElement(
              "div",
              { className: "dsm-iframeHost" },
              react.createElement(
                "div",
                { className: "dsm-iframeHead" },
                react.createElement("span", { className: "dsm-hint" }, "记忆管理（内嵌模式）"),
                react.createElement(
                  "button",
                  {
                    className: "dsm-btn",
                    onClick: abortLadder, // U-LAD1：收起=递增代际，作废挂起的握手/降级定时器
                  },
                  "收起",
                ),
              ),
              react.createElement("div", { className: "dsm-iframeBody", ref: iframeHostRef }),
            )
          : null,
      );
    }

    const inject = ["slots"];

    function apply(ctx) {
      ensureCss();
      // 门牌（settings.section order 12，qudao 11 之后）。
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

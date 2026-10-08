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

    //#region 主题桥发送端（M0 P7 定案：样式表枚举 + computed 取值）
    const THEME_PREFIX = "--dsw-alias-";
    function collectThemeVars() {
      const out = {};
      try {
        const computed = getComputedStyle(document.body);
        const names = new Set();
        for (const sheet of Array.from(document.styleSheets)) {
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
    const HANDSHAKE_TIMEOUT_MS = 2000;
    const STATE_POLL_MS = 30000;
    const ADDRESS_SAVE_DEBOUNCE_MS = 600;

    function Plaque() {
      const [state, setState] = useState(null);
      const [stateError, setStateError] = useState(null);
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

      // ---- 状态轮询（R6 轻态端点） ----
      const refreshState = useCallback(() => {
        return api("state")
          .then((j) => {
            setState(j);
            setStateError(null);
            if (!addrInitRef.current) {
              addrInitRef.current = true;
              setDshName(j.addressing?.dshName ?? "");
              setUserAlias(j.addressing?.userAlias ?? "");
            }
            setMainOn(j.settings?.conversationMemory !== false);
          })
          .catch((e) => setStateError(String(e && e.message ? e.message : e)));
      }, []);

      useEffect(() => {
        ensureCss();
        refreshState();
        const timer = setInterval(refreshState, STATE_POLL_MS);
        return () => clearInterval(timer);
      }, [refreshState]);

      // ---- 主题桥监听：面板 ready 后把当前主题变量递过去 ----
      useEffect(() => {
        const onMessage = (ev) => {
          if (!ev || !ev.data || typeof ev.data !== "object") return;
          if (ev.data.type === PANEL_READY_MSG && !handshookRef.current) {
            handshookRef.current = true;
            try {
              ev.source.postMessage({ type: THEME_MSG, vars: collectThemeVars() }, ev.origin);
            } catch { /* 桥失败：面板走自带双档降级 */ }
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
        api("settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationMemory: next }),
        })
          .then(() => { setSaveHint(next ? "已开启，下一轮对话生效" : "已关闭，下一轮对话生效"); })
          .catch((e) => {
            setMainOn(!next); // 回滚
            setStateError("开关写入失败：" + String(e && e.message ? e.message : e));
          })
          .finally(() => {
            setBusy(false);
            setTimeout(() => setSaveHint(""), 3000);
          });
      }, [busy, mainOn]);

      // ---- 称呼两输入框（防抖即时保存） ----
      const scheduleAddressingSave = useCallback((nextName, nextAlias) => {
        if (addrTimerRef.current !== null) clearTimeout(addrTimerRef.current);
        addrTimerRef.current = setTimeout(() => {
          addrTimerRef.current = null;
          api("addressing", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dshName: nextName, userAlias: nextAlias }),
          })
            .then(() => { setSaveHint("称呼已保存，下一轮对话生效"); setTimeout(() => setSaveHint(""), 3000); })
            .catch((e) => setStateError("称呼保存失败：" + String(e && e.message ? e.message : e)));
        }, ADDRESS_SAVE_DEBOUNCE_MS);
      }, []);

      // ---- 运行时梯子（裁决三）：①window.open+握手 → ②原位 iframe → ③location ----
      const fallbackToLocation = useCallback((note) => {
        setLadderNote(note);
        window.location.href = PANEL_PATH; // 面板内"返回设置"跳回
      }, []);

      const fallbackToIframe = useCallback((note) => {
        setLadderNote(note);
        setLadderLevel("iframe");
        setTimeout(() => {
          const host = iframeHostRef.current;
          if (!host) return;
          const frame = document.createElement("iframe");
          frame.src = PANEL_PATH;
          let loaded = false;
          frame.addEventListener("load", () => { loaded = true; }, true);
          frame.addEventListener("error", () => {
            if (!loaded) fallbackToLocation("内嵌 iframe 被拦截，已改为跳转模式");
          }, true);
          host.appendChild(frame);
          setTimeout(() => {
            if (!loaded) fallbackToLocation("内嵌 iframe 未加载成功，已改为跳转模式");
          }, HANDSHAKE_TIMEOUT_MS);
        }, 0);
      }, [fallbackToLocation]);

      const openPanel = useCallback(() => {
        let win = null;
        try {
          win = window.open(PANEL_PATH, "_blank");
        } catch {
          win = null;
        }
        if (win === null || win === void 0) {
          fallbackToIframe("新窗口不可用（window.open 返回空），已改为内嵌模式");
          return;
        }
        const timer = setTimeout(() => {
          if (!handshookRef.current) {
            try { win.close(); } catch { /* ignore */ }
            fallbackToIframe("新窗口 2 秒未回执握手，已改为内嵌模式");
          }
        }, HANDSHAKE_TIMEOUT_MS);
        const onReady = (ev) => {
          if (ev && ev.data && ev.data.type === PANEL_READY_MSG) {
            clearTimeout(timer);
            window.removeEventListener("message", onReady);
          }
        };
        window.addEventListener("message", onReady);
      }, [fallbackToIframe]);

      // ---- 渲染 ----
      const settings = state && state.settings ? state.settings : null;
      const counts = state && state.counts ? state.counts : null;

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
            react.createElement("label", { className: "dsm-label" }, "DSH 的名字"),
            react.createElement("input", {
              className: "dsm-inp",
              value: dshName,
              placeholder: "例如：小舟（留空则不称呼）",
              onChange: (e) => {
                setDshName(e.target.value);
                scheduleAddressingSave(e.target.value, userAlias);
              },
            }),
          ),
          react.createElement(
            "div",
            { className: "dsm-field" },
            react.createElement("label", { className: "dsm-label" }, "对我的称呼"),
            react.createElement("input", {
              className: "dsm-inp",
              value: userAlias,
              placeholder: "例如：老板（留空则不称呼）",
              onChange: (e) => {
                setUserAlias(e.target.value);
                scheduleAddressingSave(dshName, e.target.value);
              },
            }),
          ),
        ),
        react.createElement(
          "div",
          { className: "dsm-state" },
          stateError !== null
            ? "状态获取失败：" + stateError + "（host 未就绪或路由未注册）"
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
        state && state.corrupt
          ? react.createElement(
              "div",
              { className: "dsm-notice dsm-noticeErr" },
              "settings.json 解析失败，已按缺省（全开）运行——请到面板「设置」页检查或重写开关。",
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
                    onClick: () => {
                      setLadderLevel("");
                      setLadderNote("");
                    },
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
    exports.collectThemeVars = collectThemeVars; // 测试导出（M0 P7 断言口）
    return module.exports;
  },
});

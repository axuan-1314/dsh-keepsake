// dsh-memory client 半边 —— M0 探针骨架（方案C §8 P1/P4/P5/P6/P7/P8）。
// 门牌（settings.section order 12，qudao 11 之后）：
//   状态行（fetch /dsh-memory/api/state）+ 打开记忆管理（运行时梯子：
//   window.open+握手 → 内嵌 iframe → location 往返，每级降级可见提示）
//   + 主题桥（读 app 页 body 的 --dsw-alias-* 变量，postMessage 递给面板）。
// M2 扩展为完整门牌（主开关/称呼两输入框/状态摘要）；本文件保持 vanilla React
// （react 由官方模块表内置 require），CSS 手写 dsm-* 类消费 --dsw-alias-*（照
// qudao dqd-* 配方，变量取值均带 fallback）。
// inject 最小集（P8 探针）：package.json dsh.client.inject 仅挂
//   @deepseek-ai/dsh-client-ui-slots（提供 client 侧 slots service）。
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
      ".dsm-title{color:var(--dsw-alias-label-primary);font-weight:600}",
      ".dsm-state{color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".dsm-state b{color:var(--dsw-alias-label-primary);font-weight:600}",
      ".dsm-btn{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}",
      ".dsm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}",
      ".dsm-btnPrimary{background:var(--dsw-alias-button-ghost-active-fill,rgba(128,128,128,.2));font-weight:600}",
      ".dsm-hint{color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".dsm-notice{border-radius:6px;padding:6px 10px;font-size:12px;background:rgba(204,153,102,.16);color:var(--dsw-alias-label-primary)}",
      ".dsm-switchWrap{display:inline-flex;align-items:center;gap:8px}",
      ".dsm-switch{position:relative;width:34px;height:19px;flex:none;display:inline-block}",
      ".dsm-switch input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}",
      ".dsm-slider{position:absolute;inset:0;border-radius:99px;background:rgba(128,128,128,.4);transition:.15s;pointer-events:none}",
      ".dsm-slider::after{content:'';position:absolute;top:2.5px;left:3px;width:14px;height:14px;border-radius:50%;background:#c8cdd4;transition:.15s}",
      ".dsm-switch input:checked + .dsm-slider{background:var(--dsw-alias-state-business-primary,#4176e6)}",
      ".dsm-switch input:checked + .dsm-slider::after{left:17px;background:#fff}",
      ".dsm-inp{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 8px;font-size:12px}",
      ".dsm-field{display:flex;flex-direction:column;gap:3px}",
      ".dsm-label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
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

    //#region 主题桥（P7）：读 app 页 body 的 --dsw-alias-* 变量
    const THEME_PREFIX = "--dsw-alias-";
    /** 收集当前文档 body 上的全部 --dsw-alias-* 变量（app 页侧调用）。 */
    function collectThemeVars() {
      const out = {};
      try {
        const computed = getComputedStyle(document.body);
        // getComputedStyle 不枚举自定义属性；从 body style 与 styleSheet 双源收集名集。
        const names = new Set();
        for (const decl of Array.from(document.body.style)) names.add(decl);
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
          if (!name.startsWith(THEME_PREFIX)) continue;
          const v = computed.getPropertyValue(name);
          if (typeof v === "string" && v.length > 0) out[name] = v.trim();
        }
      } catch { /* 收集失败=桥降级 */ }
      return out;
    }
    //#endregion

    //#region 门牌组件（M0 探针版）
    const PANEL_PATH = "/dsh-memory/panel/";
    const PANEL_READY_MSG = "dsh-memory:panel-ready";
    const THEME_MSG = "dsh-memory:theme";
    const HANDSHAKE_TIMEOUT_MS = 2000;

    function Plaque() {
      const [state, setState] = useState(null); // /api/state 结果
      const [stateError, setStateError] = useState(null);
      const [ladderNote, setLadderNote] = useState(""); // 梯子降级可见提示
      const [ladderLevel, setLadderLevel] = useState(""); // ""|window|iframe|location
      const iframeHostRef = useRef(null);
      const handshookRef = useRef(false);

      useEffect(() => {
        ensureCss();
        let alive = true;
        fetch("/dsh-memory/api/state")
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
          .then((j) => { if (alive) { setState(j); setStateError(null); } })
          .catch((e) => { if (alive) setStateError(String(e && e.message ? e.message : e)); });
        return () => { alive = false; };
      }, []);

      // 主题桥监听：面板 ready 后把当前主题变量递过去（P7）
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

      /** 运行时梯子（裁决三）：①window.open+握手 → ②内嵌 iframe → ③location 往返。 */
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
        setLadderLevel("window");
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
      }, []);

      const fallbackToIframe = useCallback((note) => {
        setLadderNote(note);
        setLadderLevel("iframe");
        // 原位展开：下一渲染出现 iframe 宿主块；iframe 加载失败（CSP）再降 location。
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
          // onload 不触发的兜底（部分拦截形态 load 也不发）
          setTimeout(() => {
            if (!loaded) fallbackToLocation("内嵌 iframe 未加载成功，已改为跳转模式");
          }, HANDSHAKE_TIMEOUT_MS);
        }, 0);
      }, []);

      const fallbackToLocation = useCallback((note) => {
        setLadderNote(note);
        setLadderLevel("location");
        window.location.href = PANEL_PATH; // 面板内"返回设置"跳回
      }, []);

      const settings = state && state.settings ? state.settings : null;
      const on = settings ? settings.conversationMemory !== false : true;

      return react.createElement(
        "div",
        { className: "dsm-plaque" },
        react.createElement(
          "div",
          { className: "dsm-row" },
          react.createElement("span", { className: "dsm-title" }, "记忆"),
          react.createElement(
            "span",
            { className: "dsm-switchWrap" },
            react.createElement(
              "label",
              { className: "dsm-switch" },
              react.createElement("input", {
                type: "checkbox",
                checked: on,
                disabled: true, // M0 探针只读；M2 接 PUT /api/settings
                title: "M0 探针：开关只读（host 侧闸已生效，手改 settings.json 验证 P3）",
              }),
              react.createElement("span", { className: "dsm-slider" }),
            ),
            react.createElement("span", { className: "dsm-hint" }, on ? "已开启" : "已关闭"),
          ),
          react.createElement(
            "button",
            { className: "dsm-btn dsm-btnPrimary", onClick: openPanel },
            "打开记忆管理",
          ),
        ),
        react.createElement(
          "div",
          { className: "dsm-state" },
          stateError !== null
            ? "状态获取失败：" + stateError + "（host 未就绪或路由未注册）"
            : state === null
              ? "正在获取记忆状态…"
              : "记忆" + (on ? "已开启" : "已关闭") +
                " · 全局 " + String(state.counts && state.counts.global ? state.counts.global : 0) +
                " 条 · " + String(state.counts && state.counts.projects ? state.counts.projects : 0) +
                " 个项目" +
                (state.probe ? "（" + state.probe + "）" : ""),
        ),
        state && state.corrupt
          ? react.createElement(
              "div",
              { className: "dsm-notice" },
              "settings.json 解析失败，已按缺省（全开）运行——请检查文件内容。",
            )
          : null,
        ladderNote !== ""
          ? react.createElement("div", { className: "dsm-notice" }, ladderNote)
          : null,
        ladderLevel === "iframe"
          ? react.createElement(
              "div",
              { className: "dsm-iframeHost", ref: iframeHostRef },
              react.createElement(
                "div",
                { className: "dsm-iframeHead" },
                react.createElement("span", { className: "dsm-hint" }, "记忆管理（内嵌模式）"),
                react.createElement(
                  "button",
                  {
                    className: "dsm-btn",
                    onClick: () => { setLadderLevel(""); setLadderNote(""); },
                  },
                  "收起",
                ),
              ),
              react.createElement("div", { className: "dsm-iframeBody" }),
            )
          : null,
      );
    }
    //#endregion

    const inject = ["slots"];

    function apply(ctx) {
      ensureCss();
      // 门牌（settings.section order 12，qudao 11 之后；P1 探针）。
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

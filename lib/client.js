// Browser half of the FPGA workbench plugin.
//
// This file is a client bundle in the shape `dsh-client-modules` serves: one
// `window.__ModuleLoader__.load` registration whose factory is lazy CommonJS.
// Executing the file only registers the factory; `require` resolves against the
// shell's frozen platform module table, so `react` is the only import this
// bundle needs and no build step stands between the source and the browser.
//
// WHERE THE ENTRY LIVES, and why not beside the new-session chips:
// `conversation.hero.workspace` and `conversation.hero.agentPreset` are `single`
// slots and both are occupied by shipped plugins, so a third entry cannot join
// that row without shadowing one of them. `conversation.session.header.actions`
// is a `list` slot — built for appending — and it renders in the session header,
// which every session has, including a brand-new one. That is where this
// plugin's permanent entry goes.

window.__ModuleLoader__.load({
  id: "dsh-fpga-workbench",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /**
     * Two identities, deliberately different:
     *   MODULE_ID — this bundle's module id, which must equal the package name
     *               because the kernel keys its boot graph by package name.
     *   PANEL_ID  — the panel identity: the header entry's list `id` and the main
     *               panel's keyed `key` are both this, because clicking the entry
     *               calls `selectPanel(PANEL_ID)` and the layout resolves a panel
     *               by matching the registered key.
     */
    const MODULE_ID = "dsh-fpga-workbench";
    const PANEL_ID = "fpga-workbench";
    const LABEL = "FPGA 工作台";
    const DATA_URL = "/plugins/fpga-workbench/data";

    const CSS = `
      .fpga-wb { padding: 24px 28px; max-width: 980px; font-size: 13px; line-height: 1.6; }
      .fpga-wb h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
      .fpga-wb .fpga-wb-sub { opacity: .6; margin-bottom: 20px; font-size: 12px; }
      .fpga-wb .fpga-wb-error { padding: 10px 12px; border-radius: 6px; border: 1px solid var(--dsh-danger-border, #d46b6b); background: var(--dsh-danger-bg, rgba(212,107,107,.08)); margin-bottom: 16px; }
      .fpga-wb table { width: 100%; border-collapse: collapse; }
      .fpga-wb th { text-align: left; font-weight: 600; font-size: 12px; opacity: .6; padding: 0 12px 8px 0; border-bottom: 1px solid var(--dsh-border, rgba(128,128,128,.25)); }
      .fpga-wb td { padding: 9px 12px 9px 0; border-bottom: 1px solid var(--dsh-border-subtle, rgba(128,128,128,.12)); vertical-align: top; }
      .fpga-wb tr:last-child td { border-bottom: none; }
      .fpga-wb .fpga-wb-path { font-family: var(--dsh-font-mono, ui-monospace, monospace); font-size: 12px; opacity: .85; word-break: break-all; }
      .fpga-wb .fpga-wb-muted { opacity: .5; }
      .fpga-wb .fpga-wb-tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; border: 1px solid var(--dsh-border, rgba(128,128,128,.3)); opacity: .8; }
      .fpga-wb-action { margin: 4px 0 18px; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--dsh-border, rgba(128,128,128,.4)); background: transparent; color: inherit; font: inherit; cursor: pointer; }
      .fpga-wb-action:hover { background: var(--dsh-hover-bg, rgba(128,128,128,.12)); }
    `;

    /** Inject the stylesheet once per document, so a remount does not stack copies. */
    function ensureStyles() {
      if (document.querySelector("style[data-fpga-workbench]") !== null) return;
      const style = document.createElement("style");
      style.setAttribute("data-fpga-workbench", "");
      style.textContent = CSS;
      document.head.append(style);
    }

    /**
     * The sidebar row's mark.
     *
     * The sidebar renders a panel row as one 16–18px glyph plus the row's label
     * when the column is wide, and clicking that row calls `layout.selectPanel(id)`
     * itself — so this plugin contributes a mark, not a button, and needs no click
     * handler or layout binding of its own.
     *
     * It returns the `<svg>` directly rather than a wrapper element: one component
     * hop fewer means the sidebar's own render is the only place the mark is
     * mounted, and there is nothing between the row's `size` prop and the viewBox.
     * @param props - `size` in px and `active`, as the sidebar's row render supplies them.
     */
    function EntryGlyph(props) {
      return mark(props.size ?? 18);
    }

    /**
     * The die-with-pads mark, at a requested size.
     * @param size - edge length in px.
     */
    function mark(size) {
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.3,
          "aria-hidden": "true",
          focusable: "false"
        },
        h("rect", { x: 2.5, y: 2.5, width: 11, height: 11, rx: 1.2 }),
        h("rect", { x: 5.5, y: 5.5, width: 5, height: 5, rx: 0.5 }),
        h("path", { d: "M0.8 5.5h1.7M0.8 8h1.7M0.8 10.5h1.7M13.5 5.5h1.7M13.5 8h1.7M13.5 10.5h1.7M5.5 0.8v1.7M8 0.8v1.7M10.5 0.8v1.7M5.5 13.5v1.7M8 13.5v1.7M10.5 13.5v1.7" })
      );
    }

    /** One project row. */
    function ProjectRow(props) {
      const project = props.project ?? {};
      return h(
        "tr",
        null,
        h("td", null, project.name ?? h("span", { className: "fpga-wb-muted" }, "(unnamed)")),
        h("td", { className: "fpga-wb-path" }, project.path ?? h("span", { className: "fpga-wb-muted" }, "—")),
        h(
          "td",
          null,
          project.stage === undefined || project.stage === null
            ? h("span", { className: "fpga-wb-muted" }, "—")
            : h("span", { className: "fpga-wb-tag" }, project.stage)
        ),
        h("td", null, project.note ?? h("span", { className: "fpga-wb-muted" }, "—"))
      );
    }

    /**
     * The workbench surface.
     *
     * 当前形态(用户选择:先要框架可用,内里以后再填)是**会话启动器**:进入这个面板
     * 就新建一个普通会话,和点「新会话」得到的东西完全一样,只是入口在工作台这里。
     *
     * 为什么需要面板这一层:侧边栏行的点击行为由侧边栏自己实现(`selectPanel(id)`),
     * 插件改不了它的 onClick。所以"点入口就开会话"只能做成"面板挂载后立即开"。
     * 同时保留一个显式按钮兜底 —— 自动那一步若因任何原因没生效(例如当前没有可用
     * 工作区),用户仍然有一条明确的路,而不是对着一个空白面板。
     */
    function WorkbenchPanel() {
      const [state, setState] = React.useState({ status: "loading" });
      // 只自动开一次:面板重渲染时不能再开一个新会话,否则会不停新建。
      const launched = React.useRef(false);

      React.useEffect(() => {
        ensureStyles();
        const controller = new AbortController();
        fetch(DATA_URL, { signal: controller.signal })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
            return await response.json();
          })
          .then((registry) => {
            setState({ status: "ready", registry });
          })
          .catch((error) => {
            if (error.name === "AbortError") return;
            setState({ status: "failed", message: error.message });
          });
        return () => {
          controller.abort();
        };
      }, []);

      React.useEffect(() => {
        if (launched.current) return;
        launched.current = true;
        startSession();
      }, []);

      const registry = state.registry ?? {};
      const projects = Array.isArray(registry.projects) ? registry.projects : [];
      const problems = [];
      if (state.status === "failed") problems.push(`无法读取工作台数据:${state.message}`);
      if (typeof registry.error === "string") problems.push(registry.error);

      return h(
        "div",
        { className: "fpga-wb" },
        h("h1", null, LABEL),
        h("div", { className: "fpga-wb-sub" }, registry.workspace ?? "未配置工作区"),
        h(
          "button",
          { type: "button", className: "fpga-wb-action", onClick: () => { startSession(); } },
          "新建 FPGA 会话"
        ),
        ...problems.map((problem, index) => h("div", { className: "fpga-wb-error", key: `p${String(index)}` }, problem)),
        state.status === "loading"
          ? h("div", { className: "fpga-wb-muted" }, "加载中…")
          : projects.length === 0
            ? h("div", { className: "fpga-wb-muted" }, "还没有项目。在 workbench.json 的 projects 里添加。")
            : h(
                "table",
                null,
                h(
                  "thead",
                  null,
                  h("tr", null, h("th", null, "模块"), h("th", null, "路径"), h("th", null, "阶段"), h("th", null, "备注"))
                ),
                h(
                  "tbody",
                  null,
                  ...projects.map((project, index) =>
                    h(ProjectRow, { project, key: project?.path ?? `r${String(index)}` })
                  )
                )
              )
      );
    }

    /**
     * 新建一个普通会话,由 `apply` 绑定到注入的 uiWorkspace 服务。
     *
     * 不套任何 agent 预设:当前这一步只要求"能像正常新会话一样用",预设留到下一阶段。
     * 不传 workspaceId,交给服务自己挑(当前工作区 → 最近用过的),与官方「新会话」
     * 按钮的选法一致。
     */
    let startSession = () => {};

    /**
     * Register the sidebar entry and the panel it selects.
     *
     * `sidebar.panellist` is a LIST slot the shipped sidebar reserves for exactly
     * this: it renders one row per registration, and selecting a row calls
     * `selectPanel(id)`, which the layout resolves against the `main` slot's keys.
     * No shipped plugin occupies it — the sidebar is the slot's host, not an
     * occupant — so a third party can take a row without shadowing anything.
     *
     * Why not the new-session row: `conversation.hero.workspace` and
     * `conversation.hero.agentPreset` are SINGLE slots already held by shipped
     * plugins, so a third entry cannot join that row without replacing one.
     *
     * Both registrations go through `slots.inject(parent, …)` so the parent slot is
     * known to exist before the child row is added. A parent that is not declared
     * yet is waited for rather than treated as an error, which keeps this plugin
     * independent of load order.
     *
     * `uiWorkspace` 是注入的服务名,不是模块名 —— 名字写错不会有"未知服务"报错,
     * 只会让 startSession 变成空函数。tools/check-service-names.mjs 从已安装插件里
     * 收集真实服务名来挡这个错。
     * @param ctx - client plugin context carrying `slots` and `uiWorkspace`.
     */
    function apply(ctx) {
      startSession = (workspaceId) => {
        ctx.uiWorkspace.startSession(workspaceId);
      };

      ctx.slots.inject("sidebar.panellist", function* () {
        yield ctx.slots.register(
          { name: "sidebar.panellist", id: PANEL_ID, order: 100, label: LABEL },
          EntryGlyph
        );
      });
      ctx.slots.inject("main", function* () {
        yield ctx.slots.register({ name: "main", key: PANEL_ID }, WorkbenchPanel);
      });
    }

    exports.apply = apply;
    /**
     * Service names this plugin needs before `apply` runs.
     *
     * MUST be an array of service names: the client cordis runtime resolves these
     * and installs them on the context BEFORE calling `apply`. With any other
     * shape `apply` receives a context carrying no `slots`, its first line throws
     * a TypeError, and the host reports only "the client Loader did not provide an
     * error message" while refusing to start the whole desktop app.
     *
     * `slots` renders the entry; `uiWorkspace` starts the plain new session the
     * entry leads to. Both names are asserted against the installed plugins by
     * tools/check-service-names.mjs.
     */
    exports.inject = ["slots", "uiWorkspace"];
    exports.name = MODULE_ID;
    return module.exports;
  }
});

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
      .fpga-wb-entry { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 6px; border: 1px solid transparent; background: none; color: inherit; font: inherit; cursor: pointer; opacity: .75; }
      .fpga-wb-entry:hover { opacity: 1; background: var(--dsh-hover-bg, rgba(128,128,128,.12)); }
      .fpga-wb-entry[aria-current="page"] { opacity: 1; border-color: var(--dsh-border, rgba(128,128,128,.35)); }
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
     * The entry's mark. The header is narrow, so this is a bare glyph with no
     * intrinsic size and no text of its own.
     * @param props - `size` in px.
     */
    function Glyph(props) {
      const size = props.size ?? 14;
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

    /**
     * The entry button.
     *
     * It switches through the injected `layout` SERVICE, never through props: the
     * slot supplies no props at all — the conversation header calls
     * `renderSlot("conversation.session.header.actions", {})` — so a
     * `props.selectPanel` fallback silently degrades to a no-op and the click does
     * nothing. Only the sidebar's own panel rows receive `selectPanel`, because
     * the sidebar injects it into its own subtree.
     * @param props - unused; the row renders the component with whatever the slot passes.
     */
    function WorkbenchEntry(props) {
      ensureStyles();
      void props;
      return h(
        "button",
        {
          type: "button",
          className: "fpga-wb-entry",
          title: LABEL,
          onClick: () => {
            togglePanel();
          }
        },
        h(Glyph, { size: 14 }),
        h("span", null, LABEL)
      );
    }

    /**
     * Bound by `apply` to the injected layout service. One toggle, because the
     * slot passes no panel-info hook and the layout service exposes no readable
     * active id: the panel is either open or not, and `selectPanel(null)` is the
     * conversation.
     */
    let togglePanel = () => {};

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

    /** The workbench surface, shown in the main region while the panel is selected. */
    function WorkbenchPanel() {
      const [state, setState] = React.useState({ status: "loading" });

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
     * Register the header entry and the panel it selects.
     *
     * Both go through `slots.inject(parent, …)` so the parent slot is known to
     * exist before the child row is added. A parent that is not declared yet is
     * waited for rather than treated as an error, which is what keeps this plugin
     * independent of load order.
     * @param ctx - client plugin context carrying `slots` and `layout`.
     */    function apply(ctx) {
      // The click path goes through the injected service, because the slot renders
      // this component with no props at all.
      let open = false;
      togglePanel = () => {
        open = !open;
        ctx.layout.selectPanel(open ? PANEL_ID : null);
      };

      ctx.slots.inject("conversation.session.header.actions", function* () {
        yield ctx.slots.register(
          { name: "conversation.session.header.actions", id: PANEL_ID, order: 20, label: LABEL },
          WorkbenchEntry
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
     */
    exports.inject = ["slots", "layout"];
    exports.name = MODULE_ID;
    return module.exports;
  }
});

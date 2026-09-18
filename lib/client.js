// Browser half of the FPGA workbench plugin.
//
// This file is a client bundle in the shape `dsh-client-modules` serves: one
// `window.__ModuleLoader__.load` registration whose factory is lazy CommonJS.
// Executing the file only registers the factory; `require` resolves against the
// shell's frozen platform module table, so `react` is the only import this
// bundle needs and no build step stands between the source and the browser.

window.__ModuleLoader__.load({
  id: "dsh-fpga-workbench",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /**
     * One id serves both halves of the entry: the sidebar row registers this as
     * its list `id`, the main panel as its keyed `key`, and the row calls
     * `selectPanel(id)`. `dsh-client-ui-layout` resolves a panel by matching the
     * registered key, so these two must stay the same string.
     */
    const PANEL_ID = "fpga-workbench";
    const LABEL = "FPGA 工作台";
    const DATA_URL = "/plugins/fpga-workbench/data";

    const CSS = `
      .fpga-wb { padding: 24px 28px; max-width: 980px; color: var(--dsh-text-primary, inherit); font-size: 13px; line-height: 1.6; }
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
    `;

    /**
     * Inject the stylesheet once per document, so a panel remount does not stack
     * duplicate `<style>` elements.
     */
    function ensureStyles() {
      if (document.querySelector("style[data-fpga-workbench]") !== null) return;
      const style = document.createElement("style");
      style.setAttribute("data-fpga-workbench", "");
      style.textContent = CSS;
      document.head.append(style);
    }

    /**
     * The sidebar glyph. The sidebar renders it into a 16–18px box and labels the
     * row itself, so this stays a bare mark with no text and no intrinsic size.
     * @param props - `size` and `active` from the sidebar's row render.
     */
    function Glyph(props) {
      const size = props.size ?? 18;
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
        // A die outline with a grid of pads: the FPGA mark.
        h("rect", { x: 2.5, y: 2.5, width: 11, height: 11, rx: 1.2 }),
        h("rect", { x: 5.5, y: 5.5, width: 5, height: 5, rx: 0.5 }),
        h("path", { d: "M0.8 5.5h1.7M0.8 8h1.7M0.8 10.5h1.7M13.5 5.5h1.7M13.5 8h1.7M13.5 10.5h1.7M5.5 0.8v1.7M8 0.8v1.7M10.5 0.8v1.7M5.5 13.5v1.7M8 13.5v1.7M10.5 13.5v1.7" })
      );
    }

    /**
     * Render one project row.
     * @param props - `project` from the registry.
     */
    function ProjectRow(props) {
      const project = props.project ?? {};
      return h(
        "tr",
        null,
        h("td", null, project.name ?? h("span", { className: "fpga-wb-muted" }, "(unnamed)")),
        h(
          "td",
          { className: "fpga-wb-path" },
          project.path ?? h("span", { className: "fpga-wb-muted" }, "—")
        ),
        h(
          "td",
          null,
          project.stage === undefined || project.stage === null
            ? h("span", { className: "fpga-wb-muted" }, "—")
            : h("span", { className: "fpga-wb-tag" }, project.stage)
        ),
        h(
          "td",
          null,
          project.note ?? h("span", { className: "fpga-wb-muted" }, "—")
        )
      );
    }

    /**
     * The workbench surface. It owns its fetch lifecycle so the panel is correct
     * on first paint, on remount, and after an aborted unmount.
     */
    function Panel() {
      const [state, setState] = React.useState({ status: "loading" });

      React.useEffect(() => {
        ensureStyles();
        const controller = new AbortController();
        fetch(DATA_URL, { signal: controller.signal })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
        h(
          "div",
          { className: "fpga-wb-sub" },
          registry.workspace ?? "未配置工作区"
        ),
        ...problems.map((problem, index) =>
          h("div", { className: "fpga-wb-error", key: `problem-${String(index)}` }, problem)
        ),
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
                  h(
                    "tr",
                    null,
                    h("th", null, "模块"),
                    h("th", null, "路径"),
                    h("th", null, "阶段"),
                    h("th", null, "备注")
                  )
                ),
                h(
                  "tbody",
                  null,
                  ...projects.map((project, index) =>
                    h(ProjectRow, { project, key: project?.path ?? `project-${String(index)}` })
                  )
                )
              )
      );
    }

    /**
     * Register the sidebar entry and the panel it selects.
     *
     * Both registrations go through `slots.inject(parent, …)` so the parent slot
     * is known to exist before the child row is added; registering a child of an
     * unregistered slot is what turns a missing parent into a load failure.
     * @param ctx - client plugin context carrying `slots`.
     */
    function apply(ctx) {
      ctx.slots.inject("sidebar.panellist", function* () {
        yield ctx.slots.register(
          { name: "sidebar.panellist", id: PANEL_ID, order: 100, label: LABEL },
          Glyph
        );
      });
      ctx.slots.inject("main", function* () {
        yield ctx.slots.register({ name: "main", key: PANEL_ID }, Panel);
      });
    }

    exports.apply = apply;
    exports.inject = { required: ["slots"] };
    exports.name = "fpga-workbench";
    return module.exports;
  }
});

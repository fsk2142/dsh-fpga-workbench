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
      .fpga-wb-head { font-size: 12px; font-weight: 600; opacity: .6; margin: 22px 0 8px; }
      .fpga-wb-sessions { list-style: none; margin: 0; padding: 0; }
      .fpga-wb-sessions > li { margin: 0; }
      .fpga-wb-session { display: flex; align-items: baseline; gap: 10px; width: 100%; text-align: left; padding: 7px 10px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
      .fpga-wb-session:hover { background: var(--dsh-hover-bg, rgba(128,128,128,.12)); }
      .fpga-wb-session-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
     * The workbench surface: **选会话**的面板。
     *
     * 形态参考用户给的截图(那个"智能体集群"面板):点侧边栏入口 → 主区域列出这个工作台
     * 的会话,点其中一个就进去对话;另有一个显式按钮开新会话。
     *
     * 之前是"挂载即新建一个会话"。改成面板列会话,是因为那样才看得见"这个工作台里有
     * 哪些会话",也才能选着进去 —— 直接新建会立刻跳走,面板本身永远看不到。
     *
     * 会话必须属于**正确的工作区**:`apply` 已按 workbench.json 的 workspace 路径解析出
     * workspaceId(不指定时服务会挑"当前 → 最近用过的",会话就落进别的分组)。
     */
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
      // 每次渲染都重新读一次快照:面板每次进入都是新挂载,所以看到的是最新会话列表。
      const view = describeWorkbench();

      const projects = Array.isArray(registry.projects) ? registry.projects : [];
      const problems = [];
      if (state.status === "failed") problems.push(`无法读取工作台数据:${state.message}`);
      if (typeof registry.error === "string") problems.push(registry.error);

      return h(
        "div",
        { className: "fpga-wb" },
        h("h1", null, LABEL),
        h("div", { className: "fpga-wb-sub" }, registry.workspace ?? view.workspacePath ?? "未配置工作区"),
        h(
          "button",
          { type: "button", className: "fpga-wb-action", onClick: () => { startSession(); } },
          "新建 FPGA 会话"
        ),
        ...problems.map((problem, index) => h("div", { className: "fpga-wb-error", key: `p${String(index)}` }, problem)),

        h("h2", { className: "fpga-wb-head" }, `这个工作台里的会话（${String(view.sessions.length)}）`),
        view.sessions.length === 0
          ? h("div", { className: "fpga-wb-muted" }, "还没有会话。点上面的按钮开一个。")
          : h(
              "ul",
              { className: "fpga-wb-sessions" },
              ...view.sessions.map((session) =>
                h(
                  "li",
                  { key: session.id },
                  h(
                    "button",
                    { type: "button", className: "fpga-wb-session", onClick: () => { openSession(session.id); } },
                    h("span", { className: "fpga-wb-session-title" }, session.title ?? session.id),
                    session.updatedAt === undefined
                      ? null
                      : h("span", { className: "fpga-wb-muted" }, shortTime(session.updatedAt))
                  )
                )
              )
            ),

        h("h2", { className: "fpga-wb-head" }, `项目（${String(projects.length)}）`),
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

    /** 把时间戳渲染成简短形式(只到分钟),避免长串干扰阅读。 */
    function shortTime(value) {
      const text = String(value);
      const match = /(\d{2}:\d{2})/.exec(text);
      if (match !== null) return match[1];
      return text.slice(0, 10);
    }

    /**
     * 读工作台当前状态:目标工作区 + 它的会话列表(最近的在前)。
     *
     * 由 `apply` 绑定到注入的服务。全程自己 try/catch —— 面板是要"能看见东西"的,
     * 不能因为一次读取失败就整块空白。
     * @returns `{ workspacePath, sessions: [{ id, title, updatedAt }] }`
     */
    let describeWorkbench = () => ({ sessions: [] });

    /**
     * 打开一个已有会话,由 `apply` 绑定到注入的 uiWorkspace 服务。
     * @param sessionId - 会话 id。
     */
    let openSession = () => {};

    /**
     * 在目标工作区里新建一个普通会话,由 `apply` 绑定到注入的 uiWorkspace 服务。
     *
     * 目标工作区由 `apply` 解析一次(见那里的注释):不指定工作区时服务挑"当前 → 最近
     * 用过的",会话就会落进别的分组。解析出的 id 让会话固定落在 FPGA 工作台那个工作区里。
     */
    let startSession = () => {};

    /** 路径比较用的归一化:大小写与结尾分隔符都不该影响匹配。 */
    function normalizePath(value) {
      return String(value ?? "").replace(/[\\/]+$/u, "").replace(/\//gu, "\\").toLowerCase();
    }

    /**
     * 按路径在工作中区列表里找出 workspaceId。
     * @param ctx - client plugin context carrying `uiWorkspace`.
     * @param workspacePath - 目标目录;来自注册表的 `workspace` 字段。
     * @returns 匹配到的 id,或 undefined(调用方据此退回"不指定")。
     */
    function findWorkspaceId(ctx, workspacePath) {
      const target = normalizePath(workspacePath);
      if (target === "") return undefined;
      try {
        const snapshot = ctx.uiWorkspace.workspaces.list.getSnapshot();
        const match = (snapshot?.items ?? []).find((item) => normalizePath(item.path) === target);
        return match?.workspaceId;
      } catch {
        return undefined;
      }
    }

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
      // 注册表里的 workspace 路径(以及它解析出的 id)。
      //
      // 路径在这里取一次即可(注册表内容不常变);**id 不能只在这里解析**:apply 在插件
      // 加载的很早期执行,那时 workspaces.list 往往还没就绪(items 为空),一次性解析会
      // 永远拿到 undefined —— 于是会话退回"当前 → 最近用过的"分组,正是用户报的现象。
      // 所以点击时再实时解析一次,这里的值只作兜底。
      let targetWorkspaceId;
      let targetWorkspacePath;
      fetch(DATA_URL, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : undefined))
        .then((registry) => {
          targetWorkspacePath = registry?.workspace;
          targetWorkspaceId = findWorkspaceId(ctx, targetWorkspacePath);
        })
        .catch(() => {
          targetWorkspaceId = undefined;
        });

      startSession = () => {
        // 实时解析优先,缓存的 id 兜底。
        const live = findWorkspaceId(ctx, targetWorkspacePath);
        ctx.uiWorkspace.startSession(live ?? targetWorkspaceId);
      };

      openSession = (sessionId) => {
        ctx.uiWorkspace.openSession(sessionId);
      };

      describeWorkbench = () => {
        // 全程自己兜住:面板要"能看见东西",不能因为一次读取异常就整块空白。
        try {
          const workspaces = ctx.uiWorkspace.workspaces.list.getSnapshot();
          const sessions = ctx.uiWorkspace.sessions.list.getSnapshot();
          const items = workspaces?.items ?? [];
          // 优先按已解析的 id 找;拿不到就按路径再匹配一次(注册表还没回来时的兜底)。
          const target = normalizePath(targetWorkspacePath);
          const workspace =
            items.find((item) => item.workspaceId !== undefined && item.workspaceId === targetWorkspaceId) ??
            (target === "" ? undefined : items.find((item) => normalizePath(item.path) === target));
          const sessionIds = workspace?.sessionIds ?? [];
          const list = sessionIds
            .map((id) => sessions?.byId?.[id] ?? { id })
            .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
          return { workspacePath: workspace?.path, sessions: list };
        } catch {
          return { sessions: [] };
        }
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

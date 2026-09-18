// 浏览器半侧:「设置 → FPGA 开发模式」——工具链路径 + 缺失警告。
//
// 手写的懒 CJS bundle(内核的 window.__ModuleLoader__.load 契约),无构建步骤,
// 只 require("react")。
//
// 为什么必须自己写这张卡:官方 settings-plugins 只内置 bash / agent-loop /
// subagent-model-selection / web-search-deepseek 四张卡,它**不对外提供**按 schema
// 生成表单的服务(只导出 apply/inject)。插件要设置项就得自己认领,和 dsh-context 一样。
//
// 读写走官方 settingsScope 服务;存在性判断必须问宿主(浏览器不能 stat 本地文件),
// 所以状态从宿主那条只读路由拿。

window.__ModuleLoader__.load({
  id: "dsh-fpga-workbench",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /** 与宿主 lib/toolchain.js 的 NS 一致 —— 这就是卡片的认领 key。 */
    const NS = "fpga-workbench";
    /**
     * 显示名:设置分区名与设置页标题都用它。
     *
     * 必须与 presets/fpga-workbench/preset.yml 的 `name` 一致 —— 同一个产品只有一个名字。
     * tools/check-preset-root.mjs 会断言两者相同,防止改名只改了一半。
     */
    const LABEL = "FPGA 开发模式";

    /** 宿主 lib/index.js 里的 STATUS_PATH,必须一致。 */
    const STATUS_URL = "/plugins/fpga-workbench/toolchain";

    /** 宿主 lib/index.js 里的 BROWSE_PATH,必须一致。「浏览…」靠它列目录。 */
    const BROWSE_URL = "/plugins/fpga-workbench/browse";

    /**
     * 字段**不再在这里维护** —— 全部由宿主那条状态路由返回(标签、说明、选项、默认值、分组)。
     *
     * 以前这里重复一份 label/hint,靠自检断言"两边逐字一致"来防漂移;现在连重复都取消了:
     * 只有 lib/toolchain.js 一处真相,设置页照着它渲染。
     */

    const CSS = `
      .fpga-set { display: flex; flex-direction: column; gap: 14px; padding: 4px 0 8px; font-size: 13px; }
      .fpga-set-head { display: flex; align-items: center; gap: 8px; }
      .fpga-set-mark { display: inline-flex; align-items: center; color: inherit; opacity: .85; }
      .fpga-set-title { font-size: 15px; font-weight: 600; }
      .fpga-set-lead { opacity: .65; line-height: 1.6; margin: 0; }
      .fpga-set-group { font-weight: 600; opacity: .8; margin-top: 6px; padding-bottom: 4px; border-bottom: 1px solid var(--dsh-border, rgba(128,128,128,.2)); }
      .fpga-set-row { display: flex; flex-direction: column; gap: 4px; }
      .fpga-set-label { font-weight: 600; display: flex; align-items: center; gap: 6px; }
      .fpga-set-hint { opacity: .5; font-size: 12px; }
      .fpga-set-bad { color: #d9822b; font-size: 12px; font-weight: 400; }
      .fpga-set-good { color: #3cb46e; font-size: 12px; font-weight: 400; }
      .fpga-set-skips { min-height: 0; }
      .fpga-set-skips:empty { display: none; }
      .fpga-set-input { width: 100%; box-sizing: border-box; padding: 6px 9px; border-radius: 6px; border: 1px solid var(--dsh-border, rgba(128,128,128,.3)); background: transparent; color: inherit; font: inherit; }
      .fpga-set-input:focus { outline: none; border-color: var(--dsh-accent, rgba(120,160,255,.7)); }
      .fpga-set-input-bad { border-color: rgba(230,160,40,.6); }
      .fpga-set-field { display: flex; gap: 6px; align-items: center; }
      .fpga-set-btn { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--dsh-border, rgba(128,128,128,.3)); background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
      .fpga-set-btn:hover { background: var(--dsh-hover, rgba(128,128,128,.12)); }
      .fpga-set-btn:disabled { opacity: .45; cursor: default; }
      .fpga-set-browse { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--dsh-border, rgba(128,128,128,.3)); border-radius: 6px; }
      .fpga-set-browse-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .fpga-set-browse-path { flex: 1; min-width: 160px; font-size: 12px; opacity: .75; word-break: break-all; }
      .fpga-set-browse-list { display: flex; flex-direction: column; max-height: 200px; overflow: auto; }
      .fpga-set-entry { text-align: left; padding: 3px 6px; border: 0; border-radius: 4px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
      .fpga-set-entry:hover { background: var(--dsh-hover, rgba(128,128,128,.15)); }
    `;

    /** 注入一次样式表,避免重挂载时堆叠多份。 */
    function ensureStyles() {
      if (document.querySelector("style[data-fpga-workbench]") !== null) return;
      const style = document.createElement("style");
      style.setAttribute("data-fpga-workbench", "");
      style.textContent = CSS;
      document.head.append(style);
    }

    /**
     * 芯片标记(带引脚的裸片)。
     * @param size - 边长(px)。
     * @returns svg 元素。
     */
    function chipMark(size) {
      const pins = [];
      for (const offset of [8, 12, 16]) {
        pins.push(h("line", { key: `l${String(offset)}`, x1: 4, y1: offset, x2: 7, y2: offset }));
        pins.push(h("line", { key: `r${String(offset)}`, x1: 17, y1: offset, x2: 20, y2: offset }));
        pins.push(h("line", { key: `t${String(offset)}`, x1: offset, y1: 4, x2: offset, y2: 7 }));
        pins.push(h("line", { key: `b${String(offset)}`, x1: offset, y1: 17, x2: offset, y2: 20 }));
      }
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
          "aria-hidden": "true"
        },
        h("rect", { x: 7, y: 7, width: 10, height: 10, rx: 2 }),
        h("rect", { x: 10, y: 10, width: 4, height: 4, rx: 0.8, strokeWidth: 1.2 }),
        ...pins
      );
    }

    /** 绑定的设置 scope(由 apply 装上)。 */
    let scope;

    /**
     * 读取当前值。快照形状来自 SettingsScopeController:`{ status, value, user, writable }`。
     * @returns 字段值对象。
     */
    function currentValues() {
      try {
        const snapshot = scope?.store?.getSnapshot?.();
        if (snapshot === undefined || snapshot === null) return {};
        if (snapshot.status !== undefined && snapshot.status !== "ready") return {};
        return typeof snapshot.value === "object" && snapshot.value !== null ? snapshot.value : {};
      } catch {
        return {};
      }
    }

    /**
     * 写入一个字段。blur 时写而不是逐键写:scope.set 会走一次 settings mutation,
     * 逐字写既吵闹又容易和宿主的 revision 竞争。
     *
     * **必须把那个 promise 返回出去。** scope.set 转给 mutate,而 mutate 是排队执行的,
     * 要等写入落地才结算(dsh-client-ui-settings:"Settlement after the write and any
     * latest-write recovery read")。不等它就去问宿主状态,拿到的是**旧值** —— 现象就是
     * 填完路径要关掉设置再打开才显示"已就绪"。
     * @param field - 字段名。
     * @param value - 新值。
     * @returns 写入结算的 promise(没有 scope 时是已 resolve 的)。
     */
    function writeField(field, value) {
      try {
        const pending = scope?.set?.(field, value);
        if (pending === undefined || pending === null) return Promise.resolve();
        return Promise.resolve(pending);
      } catch (error) {
        console.warn(`fpga-workbench: 写入设置 ${field} 失败:`, error);
        return Promise.resolve();
      }
    }

    /** 设置页:标题 + 状态警告 + 各字段。 */
    function SettingsPanel() {
      ensureStyles();
      const values = currentValues();
      const ready = scope !== undefined;

      // 宿主探到的存在性 + 字段定义。拿不到就不显示状态 —— 而不是把它显示成"全部缺失"。
      const [status, setStatus] = React.useState(null);
      const [failed, setFailed] = React.useState(false);
      const [reload, setReload] = React.useState(0);
      // 「浏览…」当前打开的字段、那份目录列表、以及过滤词;null = 没打开。
      const [browse, setBrowse] = React.useState(null);
      React.useEffect(() => {
        let live = true;
        fetch(STATUS_URL, { cache: "no-store" })
          .then((response) => (response.ok ? response.json() : undefined))
          .then((data) => {
            if (!live) return;
            // 字段定义也来自这里,所以拿不到就必须说出来 —— 否则界面会是"空白的设置页",
            // 看起来像插件没装好,而其实只是这条路由没答上来。
            if (data === undefined) setFailed(true);
            else {
              setFailed(false);
              setStatus(data);
            }
          })
          .catch(() => {
            if (live) setFailed(true);
          });
        return () => {
          live = false;
        };
      }, [reload]);

      // 字段定义全部来自宿主那条状态路由 —— 客户端不再自己维护一份标签/说明/选项,
      // 两边不一致这种漂移从根上没有了。
      const fields = status?.tools ?? [];

      const browseTo = (key, path) => {
        fetch(`${BROWSE_URL}?path=${encodeURIComponent(String(path ?? ""))}`, { cache: "no-store" })
          .then((response) => (response.ok ? response.json() : undefined))
          .then((data) => {
            // 换目录就清掉过滤词:上一个目录的过滤词对新目录没有意义
            if (data !== undefined) setBrowse({ key, listing: data, filter: "" });
          })
          .catch(() => {
            setBrowse({ key, listing: { path: String(path ?? ""), entries: [], error: "接口不可用" }, filter: "" });
          });
      };

      return h(
        "div",
        { className: "fpga-set" },
        h(
          "div",
          { className: "fpga-set-head" },
          h("span", { className: "fpga-set-mark" }, chipMark(20)),
          h("span", { className: "fpga-set-title" }, LABEL)
        ),
        h(
          "p",
          { className: "fpga-set-lead" },
          "填上本机的工具路径、选好语言与仿真器。未填或填错的项,下面会标出开发过程中会跳过哪些步骤。"
        ),
        ...renderFields(fields, values, ready, setReload, browse, browseTo, setBrowse),
        ready ? null : h("p", { className: "fpga-set-hint" }, "设置服务尚未就绪,稍后重试。"),
        failed
          ? h(
              "p",
              { className: "fpga-set-hint" },
              "读不到宿主的状态接口(字段与就绪状态都来自它)。检查插件是否装好、或稍后重新打开设置。"
            )
          : null
      );
    }

    /**
     * 按宿主的字段定义渲染:分组 → 每行(标签 + 状态 + 说明 + 控件)。
     *
     * 控件分两种:`select` 渲染下拉(选项来自宿主),其余渲染文本框 + 「浏览…」。
     * @param fields - 宿主返回的字段数组。
     * @param values - 当前设置值。
     * @param ready - 设置服务是否可用(不可用则禁用控件)。
     * @param setReload - 触发重新拉取状态的函数。
     * @param browse - 当前打开的浏览器状态 `{ key, listing }`,或 null。
     * @param browseTo - 打开/切换目录。
     * @param setBrowse - 关闭浏览器。
     * @returns React 子节点数组。
     */
    function renderFields(fields, values, ready, setReload, browse, browseTo, setBrowse) {
      const nodes = [];
      let group;
      for (const field of fields) {
        // 隐藏字段(迁移用的旧键)不渲染 —— 宿主已经不发了,这里再挡一道:免得以后有人
        // 加了 hidden 字段却忘了过滤,页面上冒出几个看不懂的空输入框。
        if (field.control === "hidden") continue;
        if (field.group !== group) {
          group = field.group;
          nodes.push(h("div", { className: "fpga-set-group", key: `group-${String(group)}` }, group));
        }
        nodes.push(renderField(field, values, ready, setReload, browse, browseTo, setBrowse));
      }
      return nodes;
    }

    /**
     * 一行字段。
     * @param field - 宿主的字段定义(带 `control` / `options` / `required` / `skips`)。
     * @param values - 当前设置值。
     * @param ready - 设置服务是否可用。
     * @param setReload - 触发重新拉取状态的函数。
     * @param browse - 当前打开的浏览器状态。
     * @param browseTo - 打开/切换目录。
     * @param setBrowse - 关闭浏览器。
     * @returns React 节点。
     */
    function renderField(field, values, ready, setReload, browse, browseTo, setBrowse) {
      const isSelect = field.control === "select";
      const usable = field.present === true;
      const optional = field.required !== true;
      const blocked = !optional && !usable;
      const skips = blocked ? (field.skips ?? []) : [];
      const current = values[field.key] ?? field.default ?? "";

      /** 写完等落地再刷新状态 —— 顺序反了会显示旧值。 */
      const commit = (next) => {
        writeField(field.key, next).then(() => {
          setReload((count) => count + 1);
        });
      };

      return h(
        "label",
        { className: "fpga-set-row", key: field.key },
        h(
          "span",
          { className: "fpga-set-label" },
          field.label,
          // 下拉没有"未就绪"可言;可选字段留空不算未就绪(留空即用自带那份)
          isSelect
            ? null
            : usable
              ? h("span", { className: "fpga-set-good" }, "✓ 已就绪")
              : optional
                ? h("span", { className: "fpga-set-hint" }, "留空即用自带")
                : h("span", { className: "fpga-set-bad" }, "⚠ 未就绪")
        ),
        h("span", { className: "fpga-set-hint" }, field.hint),
        isSelect
          ? h(
              "select",
              {
                className: "fpga-set-input",
                defaultValue: String(current),
                disabled: !ready,
                onChange: (event) => {
                  commit(event.target.value ?? "");
                }
              },
              ...(field.options ?? []).map((option) =>
                h("option", { key: option.value, value: option.value }, option.label)
              )
            )
          : h(
              "span",
              { className: "fpga-set-field" },
              h("input", {
                className: blocked ? "fpga-set-input fpga-set-input-bad" : "fpga-set-input",
                type: "text",
                spellCheck: false,
                defaultValue: String(current),
                disabled: !ready,
                placeholder: field.kind === "directory" ? "例如 C:\\...\\某目录" : "例如 C:\\...\\工具.exe",
                onBlur: (event) => {
                  commit(event.target.value ?? "");
                },
                onKeyDown: (event) => {
                  if (event.key === "Enter") event.target.blur();
                }
              }),
              // 路径在手打之外再给一条:点开就是这台机器上的目录与文件(宿主列的),带过滤框
              h(
                "button",
                {
                  type: "button",
                  className: "fpga-set-btn",
                  disabled: !ready,
                  onClick: () => browseTo(field.key, startDir(field, current))
                },
                "浏览…"
              )
            ),
        browse !== null && browse !== undefined && browse.key === field.key
          ? renderBrowser(field, browse, browseTo, setBrowse, commit)
          : null,
        h(
          "span",
          { className: "fpga-set-skips" },
          skips.length === 0
            ? null
            : h(
                "span",
                { className: "fpga-set-bad" },
                field.configured === true
                  ? `路径不存在(${String(field.path)}),会跳过:${skips.join("、")}`
                  : `未配置,会跳过:${skips.join("、")}`
              )
        )
      );
    }

    /**
     * 从浏览器文件框给的文件对象里取出**真实路径**,取不到就返回 undefined。
     *
     * 普通浏览器出于安全只给文件名(`file.path` 是 `C:\fakepath\xxx.exe` 这种假路径),
     * Electron 壳里才是真的。所以两道关:必须是绝对路径,且不含 `fakepath` 段 ——
     * 宁可退回列表让人自己选,也不能把一个假路径写进设置。
     * @param file - `<input type="file">` 给的文件对象。
     * @returns 绝对路径,或 undefined。
     */
    function browserFilePath(file) {
      const path = file?.path;
      if (typeof path !== "string" || path === "") return undefined;
      if (!/^([A-Za-z]:[\\/]|\\\\)/u.test(path)) return undefined;
      if (/[\\/]fakepath[\\/]/iu.test(path)) return undefined;
      return path;
    }

    /**
     * 「浏览…」从哪个目录开始:填了文件就从不含文件名的目录开始;填了目录就从它开始。
     * @param field - 宿主的字段定义(`kind` 为 `directory` 时按目录处理)。
     * @param value - 当前值。
     * @returns 起始目录;空串表示从盘符开始。
     */
    function startDir(field, value) {
      const text = String(value ?? "").trim();
      if (text === "") return "";
      if (field.kind === "directory") return text;
      const cut = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
      return cut > 0 ? text.slice(0, cut) : "";
    }

    /**
     * 面板内的选择器:列出目录内容,打字过滤、点目录进去、点文件填上。
     *
     * **过滤框是关键**:一个 bin 目录动辄几十上百项,一层层找很慢;打三四个字母就只剩目标,
     * 回车直接选中。比"必须弹系统窗口"稳,也比纯点击快。
     * @param field - 宿主的字段定义。
     * @param browse - `{ key, listing, filter }`。
     * @param browseTo - 切换目录。
     * @param setBrowse - 关闭或改过滤词。
     * @param commit - 选中后写入设置。
     * @returns React 节点。
     */
    function renderBrowser(field, browse, browseTo, setBrowse, commit) {
      const listing = browse.listing ?? {};
      const filter = String(browse.filter ?? "").toLowerCase();
      const all = listing.entries ?? [];
      const entries = filter === "" ? all : all.filter((entry) => String(entry.name).toLowerCase().includes(filter));
      const close = () => setBrowse(null);
      /** 选中一项:目录就进去,文件就填上。 */
      const choose = (entry) => {
        if (entry.kind === "directory") {
          browseTo(field.key, entry.path);
        } else {
          commit(entry.path);
          close();
        }
      };
      /** 在当前面板上补一句说明(不改目录、不清过滤词)。 */
      const note = (text) => setBrowse({ key: browse.key, listing, filter: browse.filter, note: text });
      /**
       * 借**浏览器自己**的文件框选文件:弹窗由浏览器弹,不依赖宿主起进程 —— 所以不会像
       * "宿主弹系统窗口"那样卡住。风险只有一个:能不能拿到完整路径。Electron 壳里 `file.path`
       * 是真的;普通浏览器只给文件名,这时如实说一句、让人继续用列表。
       * 目录字段不给这个按钮(浏览器选不了目录)。
       */
      const pickViaBrowser = () => {
        const picker = document.createElement("input");
        picker.type = "file";
        picker.onchange = () => {
          const path = browserFilePath(picker.files?.[0]);
          if (path !== undefined) {
            commit(path);
            close();
          } else {
            note("浏览器没给出完整路径(只给了文件名),请用上面的列表选,或把路径直接粘进输入框。");
          }
        };
        picker.click();
      };
      return h(
        "span",
        { className: "fpga-set-browse" },
        h(
          "span",
          { className: "fpga-set-browse-head" },
          h("span", { className: "fpga-set-browse-path" }, listing.path === "" || listing.path === undefined ? "选择一个盘符" : String(listing.path)),
          h(
            "button",
            {
              type: "button",
              className: "fpga-set-btn",
              disabled: listing.parent === undefined || listing.path === "",
              onClick: () => browseTo(field.key, listing.parent ?? "")
            },
            "↑ 上级"
          ),
          listing.path === "" || listing.path === undefined
            ? null
            : h(
                "button",
                {
                  type: "button",
                  className: "fpga-set-btn",
                  onClick: () => {
                    commit(String(listing.path));
                    close();
                  }
                },
                "用这个目录"
              ),
          // 文件字段额外给一条"借浏览器文件框"的路(目录不行 —— 浏览器选不了目录)。
          // 它是加速项,不是主路径:拿不到完整路径就退回上面的列表。
          field.kind === "directory"
            ? null
            : h("button", { type: "button", className: "fpga-set-btn", onClick: pickViaBrowser }, "系统窗口选文件…"),
          h("button", { type: "button", className: "fpga-set-btn", onClick: close }, "关闭")
        ),
        browse.note === undefined ? null : h("span", { className: "fpga-set-hint" }, browse.note),
        h("input", {
          className: "fpga-set-input",
          type: "text",
          spellCheck: false,
          autoFocus: true,
          placeholder: "打字过滤当前目录,回车选中唯一匹配项",
          value: String(browse.filter ?? ""),
          onChange: (event) => setBrowse({ key: browse.key, listing, filter: event.target.value ?? "" }),
          onKeyDown: (event) => {
            if (event.key !== "Enter") return;
            // 只剩一项就直接选中 —— 这是"打字找文件"最省事的收尾
            if (entries.length === 1) choose(entries[0]);
          }
        }),
        listing.error === undefined
          ? null
          : h("span", { className: "fpga-set-bad" }, `读不了这个目录(${String(listing.error)})`),
        h(
          "span",
          { className: "fpga-set-browse-list" },
          ...entries.map((entry) =>
            h(
              "button",
              {
                type: "button",
                key: entry.path,
                className: "fpga-set-entry",
                onClick: () => choose(entry)
              },
              `${entry.kind === "directory" ? "📁" : "📄"} ${String(entry.name)}`
            )
          ),
          entries.length === 0 && listing.error === undefined
            ? h("span", { className: "fpga-set-hint" }, filter === "" ? "(这个目录是空的)" : `(没有名字含「${String(browse.filter)}」的项)`)
            : null
        ),
        listing.truncated === true ? h("span", { className: "fpga-set-hint" }, "条目过多,只显示了前 500 项") : null
      );
    }

    /**
     * 挂载客户端半侧:认领设置分区。
     *
     * 注册在 `settings.section` 上(那是个 list 槽,`{name,id,order,label}`),于是设置
     * 左侧出现一个「FPGA 开发模式」分区。
     * @param ctx - client plugin context carrying `slots`.
     */
    function apply(ctx) {
      ctx.inject(["settingsScope"], (modeCtx) => {
        const binder = modeCtx.settingsScope;
        // 远端浏览器等拿不到这个服务的部署:安静地不注册,不报错、不显示空卡片。
        if (binder === undefined || binder === null) return;

        modeCtx.effect(
          () => {
            scope = binder.bind({ namespace: NS });
            return () => {
              scope = undefined;
            };
          },
          "fpga-workbench: settings scope"
        );

        modeCtx.slots.inject("settings.section", function* () {
          yield modeCtx.slots.register(
            { name: "settings.section", id: NS, order: 500, label: LABEL },
            SettingsPanel
          );
        });
      });
    }

    exports.apply = apply;
    /**
     * 服务注入:数组,不是对象。形状写错会让 apply 拿到缺服务的 ctx 并抛 TypeError,
     * 而宿主只回一句「did not provide an error message」。
     *
     * 只列 slots:`settingsScope` 由内部 ctx.inject 按需获取(官方 dsh-context 的做法)。
     * 若列在这儿,拿不到该服务的部署会让整个插件不激活;放内部则只是不注册卡片。
     */
    exports.inject = ["slots"];
    exports.name = "dsh-fpga-workbench";
    return module.exports;
  }
});

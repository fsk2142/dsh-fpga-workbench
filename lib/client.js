// 浏览器半侧:在「设置」里开一个 FPGA 工作台分区,编辑工具链路径。
//
// 这是手写的懒 CJS bundle(内核的 window.__ModuleLoader__.load 契约),没有构建步骤,
// 只 require("react") —— 不依赖任何基座之外的模块。
//
// 为什么必须自己写这张卡:官方 settings-plugins 只内置了 bash / agent-loop /
// subagent-model-selection / web-search-deepseek 四张卡,它**不对外提供**按 schema
// 生成表单的服务(只导出 apply/inject)。所以插件要设置项,就得自己认领卡片。
//
// 读写走官方 settingsScope 服务(dsh-client-ui-settings 提供):
//   ctx.settingsScope.bind({ namespace }) → { store, set, unset, mutate, subscribe }
// 值来自宿主那个命名空间,schema 也随 describe 一起发到浏览器,所以两边不会各说一套。

window.__ModuleLoader__.load({
  id: "dsh-fpga-workbench",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /** 与宿主 lib/index.js 里的命名空间一致 —— 这就是卡片的认领 key。 */
    const NS = "fpga-workbench";
    const LABEL = "FPGA 工作台";

    /** 设置项:与宿主字段一一对应。 */
    const FIELDS = [
      { key: "vivadoPath", label: "Vivado", hint: "vivado.bat / vivado 可执行文件(综合与实现)" },
      { key: "modelsimPath", label: "ModelSim", hint: "vsim.exe / vsim 可执行文件(仿真)" },
      { key: "verilatorPath", label: "Verilator", hint: "verilator 可执行文件(lint 与快速仿真)" },
      { key: "libraryPath", label: "库目录", hint: "厂商与仿真库所在目录" }
    ];

    const CSS = `
      .fpga-set { display: flex; flex-direction: column; gap: 14px; padding: 4px 0 8px; font-size: 13px; }
      .fpga-set-lead { opacity: .65; line-height: 1.6; margin: 0; }
      .fpga-set-row { display: flex; flex-direction: column; gap: 4px; }
      .fpga-set-label { font-weight: 600; }
      .fpga-set-hint { opacity: .5; font-size: 12px; }
      .fpga-set-input { width: 100%; box-sizing: border-box; padding: 6px 9px; border-radius: 6px; border: 1px solid var(--dsh-border, rgba(128,128,128,.3)); background: transparent; color: inherit; font: inherit; }
      .fpga-set-input:focus { outline: none; border-color: var(--dsh-accent, rgba(120,160,255,.7)); }
    `;

    /** 注入一次样式表,避免重挂载时堆叠多份。 */
    function ensureStyles() {
      if (document.querySelector("style[data-fpga-workbench]") !== null) return;
      const style = document.createElement("style");
      style.setAttribute("data-fpga-workbench", "");
      style.textContent = CSS;
      document.head.append(style);
    }

    /** 绑定的设置 scope(由 apply 装上);拿不到时页面显示提示而不是空白。 */
    let scope;

    /**
     * 读取当前值。
     *
     * scope 的快照形状来自 dsh-client-ui-settings 的 SettingsScopeController:
     * `{ status, value, user, writable }`,其中 `value` 是宿主解析后的命名空间值。
     * @returns 字段值对象(可能为空)。
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
     * 写入一个字段。
     *
     * 在 blur 时写而不是每次按键都写:scope.set 会走一次 settings mutation,
     * 逐字写既吵闹又容易和宿主的 revision 竞争。
     * @param field - 字段名。
     * @param value - 新值。
     */
    function writeField(field, value) {
      try {
        scope?.set?.(field, value);
      } catch (error) {
        console.warn(`fpga-workbench: 写入设置 ${field} 失败:`, error);
      }
    }

    /** 设置页:一行一个路径字段。 */
    function SettingsPanel() {
      ensureStyles();
      const values = currentValues();
      const ready = scope !== undefined;

      return h(
        "div",
        { className: "fpga-set" },
        h(
          "p",
          { className: "fpga-set-lead" },
          "这些路径会写进「FPGA 工作台」模式会话的提示里,agent 直接使用它们调用工具,",
          "不需要每次问你,也不会去 PATH 里猜。留空表示该项未配置。"
        ),
        ...FIELDS.map((field) =>
          h(
            "label",
            { className: "fpga-set-row", key: field.key },
            h("span", { className: "fpga-set-label" }, field.label),
            h("span", { className: "fpga-set-hint" }, field.hint),
            h("input", {
              className: "fpga-set-input",
              type: "text",
              spellCheck: false,
              defaultValue: String(values[field.key] ?? ""),
              disabled: !ready,
              placeholder: "例如 C:\\...",
              onBlur: (event) => {
                writeField(field.key, event.target.value ?? "");
              },
              onKeyDown: (event) => {
                if (event.key === "Enter") event.target.blur();
              }
            })
          )
        ),
        ready ? null : h("p", { className: "fpga-set-hint" }, "设置服务尚未就绪,稍后重试。")
      );
    }

    /**
     * 挂载客户端半侧:认领设置卡。
     *
     * 卡片必须注册在 `settings.plugin.item` 上、以宿主命名空间为 key —— 官方那个标签页
     * 渲染的是「宿主服务的命名空间」与「注册在这些 key 上的卡片」的交集,只注册命名空间
     * 而没人认领,界面上什么都不出现。
     * @param ctx - client plugin context carrying `slots` and `settingsScope`.
     */
    function apply(ctx) {
      ctx.inject(["settingsScope"], (modeCtx) => {
        const binder = modeCtx.settingsScope;
        // 远端浏览器等拿不到这个服务的部署,安静地不注册 —— 不报错、不显示空卡片。
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
     * 这里**只列 slots**:`settingsScope` 由内部的 ctx.inject 按需获取,和官方
     * dsh-context 的做法一致。若把它列在这儿,拿不到该服务的部署(远端浏览器)会让整个
     * 插件不激活;放在内部则只是不注册那张卡片,其余照常。
     */
    exports.inject = ["slots"];
    exports.name = "dsh-fpga-workbench";
    return module.exports;
  }
});

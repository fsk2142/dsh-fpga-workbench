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

    /** 宿主 lib/index.js 里的 DETECT_PATH,必须一致。「检测本机工具」靠它。 */
    const DETECT_URL = "/plugins/fpga-workbench/detect";

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
      .fpga-set-group { display: flex; align-items: center; gap: 8px; font-weight: 600; opacity: .8; margin-top: 6px; padding-bottom: 4px; border-bottom: 1px solid var(--dsh-border, rgba(128,128,128,.2)); }
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
      .fpga-set-head .fpga-set-btn { margin-left: auto; }
      .fpga-set-foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; padding-top: 10px; border-top: 1px solid var(--dsh-border, rgba(128,128,128,.2)); }
      .fpga-set-foot .fpga-set-marker { margin-right: auto; }
      .fpga-set-detect-row { display: flex; align-items: center; gap: 8px; font-size: 12px; opacity: .85; }
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

    // 写设置的唯一入口是设置页里的 saveAll(一次 `scope.mutate` 原子提交)。
    // 这里曾经有一个逐字段的 writeField(blur 即写):改成"保存按钮"之后它没有调用方了,
    // 已删掉 —— 留着会让人以为还存在第二条写入路径。
    //
    // 这里也曾经有"借浏览器文件框弹系统窗口"那条路(pickNative / browserFilePath /
    // isDesktopShell):实测在这种外壳里**拿不到真实路径**(新版 Electron 去掉了 `File.path`),
    // 弹了只能再退回列表,还让人以为"选完了"。按用户口径**整个删掉**,只留页面内列表。

    /** 设置页:标题 + 状态警告 + 各字段。 */
    function SettingsPanel() {
      ensureStyles();
      const values = currentValues();
      const ready = scope !== undefined;

      // 宿主探到的存在性 + 字段定义。拿不到就不显示状态 —— 而不是把它显示成"全部缺失"。
      const [status, setStatus] = React.useState(null);
      const [failed, setFailed] = React.useState(false);
      const [reload, setReload] = React.useState(0);
      // 未保存的改动(字段 → 新值)。**改完不立刻写**:写只发生在点「保存改动」那一次
      // 原子提交里 —— 既免得碰一下就改了设置(用户要的"防止误修改"),也免得几个字段
      // 各写一次、中途失败留下半吊子状态。
      const [drafts, setDrafts] = React.useState({});
      const [saving, setSaving] = React.useState(false);
      const [saveError, setSaveError] = React.useState(undefined);
      // 检测结论(**逐字段**,写在各自那一行下面):null = 还没跑过;`{perField}` 或 `{error}`。
      const [detect, setDetect] = React.useState(null);
      // **未保存改动的预演状态**:把页面上这些值带上问宿主一次,拿到的"已就绪/未就绪"与路径类型
      // 就是**眼前这一份**的 —— 不必先保存才看得到状态(用户实际反馈过这一点)。
      const [preview, setPreview] = React.useState(undefined);
      // 「浏览…」当前打开的字段、那份目录列表、以及过滤词;null = 没打开。
      const [browse, setBrowse] = React.useState(null);
      // 系统窗口那条路没成时,说明一句(比如"拿不到完整路径,已改用列表")
      const [pickNote, setPickNote] = React.useState(undefined);
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

      /**
       * 未保存改动的预演:把当前页面上的值当查询参数问一次状态路由,宿主按**这一份**判就绪与
       * 路径类型(类型随所选工具变)。改动清空就回到正常状态。
       *
       * 防抖 250ms:打字时每个键都会触发一次,没必要一个字 stat 一次。
       */
      React.useEffect(() => {
        const keys = Object.keys(drafts);
        if (keys.length === 0) {
          setPreview(undefined);
          return undefined;
        }
        const timer = setTimeout(() => {
          const query = new URLSearchParams();
          for (const key of keys) query.set(key, String(drafts[key]));
          fetch(`${STATUS_URL}?${query.toString()}`, { cache: "no-store" })
            .then((response) => (response.ok ? response.json() : undefined))
            .then((data) => {
              if (data !== undefined) setPreview(data.tools ?? []);
            })
            .catch(() => {});
        }, 250);
        return () => clearTimeout(timer);
      }, [drafts, reload]);

      /**
       * 打开设置页就检测一次:没配过的字段会被填进"未保存的改动"(点保存才落地),
       * 没检测到的会在那一行下面直接写出来。**没有单独的「检测」按钮** —— 用户口径:
       * 换工具时没检测到就直接提醒就够了,不必再多一步手动动作。
       */
      React.useEffect(() => {
        if (fields.length === 0) return;
        runDetect();
      }, [status]);

      // 字段定义全部来自宿主那条状态路由 —— 客户端不再自己维护一份标签/说明/选项,
      // 两边不一致这种漂移从根上没有了。
      const fields = status?.tools ?? [];

      const dirty = Object.keys(drafts).length > 0;

      /**
       * 记下一次改动(**不写设置**)。改回原值时就把这条撤掉,别让"未保存"无谓地亮着。
       * @param key - 字段名。
       * @param value - 新值。
       */
      const stage = (key, value) => {
        setSaveError(undefined);
        setDrafts((current) => {
          const next = { ...current };
          if (String(value) === String(currentValues()[key] ?? "")) delete next[key];
          else next[key] = value;
          return next;
        });
      };

      /** 丢弃全部未保存的改动。 */
      const revert = () => {
        setDrafts({});
        setSaveError(undefined);
      };

      /**
       * 换工具时把对应的路径**一起换掉** —— 靠的是重新检测一次(见 {@link runDetect})。
       *
       * 这个栏位只有一个含义:**当前选中那个工具**的路径。留着上一个工具的路径(哪怕是你手填的)
       * 只会造出"框里是 A 的路径、下拉是 B、状态还显示已就绪"这种自相矛盾的画面 —— 用户实际
       * 反馈过。所以新工具有路径就换成它的;没检测到就**清空**,并在那一行下面说明。
       * @param selectKey - 下拉字段名。
       * @param option - 新选中的工具。
       */
      const changeTool = (selectKey, option, pathKey) => {
        stage(selectKey, option);
        // 明确选了「不用」:那个路径栏位没有意义了 → 清掉,检测那边也会跳过它
        if (option === "none") stage(pathKey, "");
        // 把这次选择当覆盖值传进去:setState 还没结算,不然会按**旧工具**筛
        runDetect({ [selectKey]: option }, option === "none" ? [] : [pathKey]);
      };

      /**
       * 保存:把未保存的改动**一次原子提交**(`scope.mutate` 带 revision 校验),不会出现
       * "存了三个、第四个失败"。提交失败时改动**留着**并说明原因,绝不静默丢掉。
       */
      const saveAll = () => {
        const keys = Object.keys(drafts);
        if (keys.length === 0 || scope === undefined) return;
        setSaving(true);
        setSaveError(undefined);
        const ops = keys.map((key) => ({ op: "set", path: [key], value: drafts[key] }));
        Promise.resolve()
          .then(() => scope.mutate(ops))
          .then(
            () => {
              // 注意:宿主**拒收时 mutate 也正常结算**(它 recover 一下就直接 return 了),
              // 所以"存没存进去"只能看结果:宿主刷新后的值里有没有我们写的那几个。
              const after = currentValues();
              const missed = keys.filter((key) => String(after[key] ?? "") !== String(drafts[key]));
              if (missed.length > 0) {
                // 读不到状态(设置服务不可用)时也会落到这里:如实说没确认,不假装成功
                setSaveError(`没有确认这次改动生效(${missed.join("、")})。改动还留着,可以再存一次。`);
                return;
              }
              setDrafts({});
              setReload((count) => count + 1);
            },
            (error) => {
              setSaveError(`保存失败:${String(error?.message ?? error)}(改动还留着,可以再试)`);
            }
          )
          .then(() => setSaving(false));
      };

      /**
       * 预设同步那一行 —— 只报事实:这次启动把自带预设同步进用户目录的结果。
       * 拿不到就整行不显示:设置页不该凭猜说一句"正常"。
       * @param preset - 宿主状态接口里的 `preset`。
       * @returns 一行提示,或 null。
       */
      const presetLine = (preset) => {
        if (preset === undefined || preset === null) return null;
        if (preset.state === "failed") {
          return h(
            "p",
            { className: "fpga-set-bad" },
            `预设同步失败:${String(preset.error ?? "未知原因")} —— 预设列表里可能看不到「${LABEL}」`
          );
        }
        const base = preset.state === "synced"
          ? `预设已同步到 ${String(preset.dir ?? "")}`
          : preset.state === "up-to-date"
            ? "预设与包内版本一致,无需同步"
            : "预设同步尚未执行";
        const backup = preset.backupDir === undefined ? "" : `(覆盖前的旧文件备份在 ${String(preset.backupDir)})`;
        return h("p", { className: "fpga-set-hint" }, `${base}${backup}`);
      };

      /**
       * 某个路径字段**当前选中**的那个工具(含页面上未保存的改动)。
       * @param key - 字段名。
       * @returns 选中的选项;没有下拉管这个字段时返回 undefined(如 PowerShell / Python)。
       */
      const selectedOptionOf = (key, pending = {}) => {
        const owner = fields.find(
          (entry) => entry.control === "select" && (entry.options ?? []).some((option) => option.needs === key)
        );
        if (owner === undefined) return undefined;
        // 刚换过工具但 state 还没结算时,把这次选择当覆盖值传进来(见 runDetect)
        const current = String(pending[owner.key] ?? drafts[owner.key] ?? values[owner.key] ?? owner.default ?? "");
        return (owner.options ?? []).find((option) => option.value === current);
      };

      /**
       * 采用一条检测结果:把路径记进"未保存的改动"。
       *
       * 结果已经按**当前选中的工具**筛过(见 {@link runDetect}),所以这里不用动下拉 ——
       * 下拉里选的就是它。与手填一个规矩:点「保存改动」才落地。
       * @param hit - 检测路由给的一项 `{ field, option?, label, path, source }`。
       */
      const applyHit = (hit) => {
        stage(hit.field, hit.path);
      };

      /**
       * 跑一次检测,把结论**逐字段**记下来(找到了什么、或者干脆没找到 —— "没找到"本身就是要说的话)。
       *
       * 什么时候跑:**打开设置页时**(没配过的字段需要有东西可填)和**每次换工具时**。
       * 所以不再需要一个单独的「检测」按钮(用户口径:换工具时没检测到就直接提醒)。
       * @param pending - 刚发生、状态还没结算的选择(换工具时用,否则会按**旧工具**筛)。
       * @param force - 必须**跟着换**的字段(换工具时它管着的那个路径栏):哪怕已经配过也要换成
       *   新工具的;新工具没有路径就清空 —— 否则会出现"框里是上一个工具的路径、下拉是新的"。
       */
      const runDetect = (pending = {}, force = []) => {
        fetch(DETECT_URL, { cache: "no-store" })
          .then((response) => (response.ok ? response.json() : undefined))
          .then((data) => {
            const all = Array.isArray(data?.found) ? data.found : [];
            // **只按当前选中的工具报**:选了 Quartus 就不能拿 Vivado 的路径来答话。
            // 选中哪个工具由页面说了算 —— 它看得到**未保存的改动**,宿主看不到。
            const perField = fields
              .filter((field) => field.control === "text" && field.kind !== undefined && field.detectable === true)
              .map((field) => {
                const option = selectedOptionOf(field.key, pending);
                // 选了「不用(本机没有这个工具)」= 用户的明确决定:不必再探,也不必再提醒
                // "没检测到路径" —— 那正是这个选项要避免的打扰。
                if (option?.value === "none") return undefined;
                return {
                  key: field.key,
                  tool: option?.label,
                  hits: all.filter(
                    (hit) => hit.field === field.key && (option === undefined || hit.option === option.value)
                  )
                };
              })
              .filter((entry) => entry !== undefined);
            // 自动填:这个字段还没填过(已保存的、或页面上未保存的)、且候选唯一 ——
            // 装了多个版本不替他挑,列出来让他点。
            for (const entry of perField) {
              const field = fields.find((item) => item.key === entry.key);
              if (field === undefined) continue;
              // 正常:只填"还没填过、且候选唯一"的字段(不覆盖你已经填的);
              // forced(换工具):那一栏必须跟着换 —— 有就换成它的,没有就清空。
              if (force.includes(entry.key)) {
                if (entry.hits.length === 1) applyHit(entry.hits[0]);
                else if (entry.hits.length === 0) stage(entry.key, "");
                continue;
              }
              if (field.configured === true || drafts[entry.key] !== undefined) continue;
              if (entry.hits.length !== 1) continue;
              applyHit(entry.hits[0]);
            }
            setDetect({ perField });
          })
          .catch(() => setDetect({ error: "检测接口不可用" }));
      };

      /** 一组字段的标题行。**没有检测按钮** —— 检测在打开页面和换工具时自动跑,结论写在各自那一行下面。 */
      const renderGroupHead = (group) =>
        h("div", { className: "fpga-set-group", key: `group-${String(group)}` }, h("span", null, group));

      /**
       * 一个字段的检测结论,写在它自己那一行下面。
       *
       * **只报事实**:按当前选中的工具,机器上找到了什么;没找到就明说没有 —— 不回声用户原来填的值。
       * @param entry - `{ key, tool, hits }`(来自 {@link runDetect});`undefined` = 这个字段不参与检测。
       * @returns React 节点,或 null。
       */
      const detectNote = (entry) => {
        if (entry === undefined) return null;
        const where = entry.tool === undefined ? "" : `(${String(entry.tool)})`;
        if (entry.hits.length === 0) {
          return h(
            "span",
            { className: "fpga-set-detect-row" },
            `没检测到${where}的路径 —— 手填,或用「浏览…」挑`
          );
        }
        return entry.hits.map((hit) =>
          h(
            "span",
            { className: "fpga-set-detect-row", key: `${String(entry.key)}-${String(hit.path)}` },
            `检测到${where}:${String(hit.path)}${hit.source === "path" ? "(来自 PATH,可能是旧的)" : "(厂商默认安装位置)"}`,
            // 已经就是这个值(含未保存的改动)时不给按钮 —— 不该让人再点一次
            String(drafts[hit.field] ?? values[hit.field] ?? "") === String(hit.path)
              ? null
              : h(
                  "button",
                  {
                    type: "button",
                    className: "fpga-set-btn",
                    disabled: !ready,
                    onClick: () => applyHit(hit)
                  },
                  "用这个"
                )
          )
        );
      };

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

      /**
       * 传给字段渲染的检测结论。`head` / `note` 必须一起带上:renderFields 是**模块级**函数,
       * 看不到 SettingsPanel 里的闭包 —— 忘了带,渲染时直接 ReferenceError(自检里那条真实
       * 渲染用例抓到过)。
       */
      const detectCtx = { head: renderGroupHead, note: detectNote, perField: detect?.perField ?? [] };

      /**
       * 「浏览…」的入口:**一律用页面内的列表,不弹系统窗口**。
       *
       * 为什么不弹(用户口径,实测踩过好几回):系统文件框在这套外壳里**给不出真实路径** ——
       * 新版 Electron 去掉了 `File.path`(`webUtils.getPathForFile()` 在插件 bundle 里拿不到),
       * 选完只剩文件名;浏览器那条更是只给 `C:\fakepath\…`。弹了就得再退回列表,白走一步、
       * 还让人以为"选完了"。列表本来就能选文件:**进目录 → 单击文件**(或打几个字母过滤后回车)。
       * (名字不叫 browse,免得和上面那份 browse 状态撞名。)
       */
      const startPick = (field, current, commit) => {
        setPickNote(
          String(field.kind) === "directory"
            ? "在下面进到那一层,点「用这个目录」;也可以直接把路径粘进输入框。"
            : "在下面找到那个文件**点一下**选中(或打几个字母过滤后回车);也可以直接把路径粘进输入框。"
        );
        browseTo(field.key, startDir(field, current));
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
        // 检测失败也要看得见(每一行的结论都依赖它;拿不到就如实说,不假装"没检测到")
        detect?.error === undefined ? null : h("p", { className: "fpga-set-bad" }, `工具检测失败:${String(detect.error)}`),
        h(
          "p",
          { className: "fpga-set-lead" },
          "填上本机的工具路径、选好语言与仿真器。未填或填错的项,下面会标出哪些能力当前不可执行(分析与改代码不受影响)。"
        ),
        presetLine(status?.preset),
        ...renderFields(fields, values, ready, browse, browseTo, setBrowse, startPick, drafts, stage, changeTool, detectCtx, preview),
        pickNote === undefined ? null : h("p", { className: "fpga-set-hint" }, pickNote),
        ready ? null : h("p", { className: "fpga-set-hint" }, "设置服务尚未就绪,稍后重试。"),
        failed
          ? h(
              "p",
              { className: "fpga-set-hint" },
              "读不到宿主的状态接口(字段与就绪状态都来自它)。检查插件是否装好、或稍后重新打开设置。"
            )
          : null,
        // 保存放在**最后**(用户口径):改完往下看就是它,不用回头找顶部。
        // 改动只留在页面上,点「保存改动」才写进设置(防止误碰一下就改了配置)。
        h(
          "div",
          { className: "fpga-set-foot" },
          dirty ? h("span", { className: "fpga-set-bad fpga-set-marker" }, "有未保存的改动") : null,
          h(
            "button",
            { type: "button", className: "fpga-set-btn", disabled: !dirty || saving, onClick: revert },
            "放弃改动"
          ),
          h(
            "button",
            { type: "button", className: "fpga-set-btn", disabled: !dirty || saving, onClick: saveAll },
            saving ? "保存中…" : "保存改动"
          )
        ),
        saveError === undefined ? null : h("p", { className: "fpga-set-bad" }, saveError)
      );
    }

    /**
     * 按宿主的字段定义渲染:分组 → 每行(标签 + 状态 + 说明 + 控件)。
     *
     * 控件分两种:`select` 渲染下拉(选项来自宿主),其余渲染文本框 + 「浏览…」。
     * @param fields - 宿主返回的字段数组。
     * @param values - 当前设置值。
     * @param ready - 设置服务是否可用(不可用则禁用控件)。
     * @param browse - 当前打开的浏览器状态 `{ key, listing }`,或 null。
     * @param browseTo - 打开/切换目录。
     * @param setBrowse - 关闭浏览器。
     * @param drafts - 未保存的改动(字段 → 新值)。
     * @param stage - 记下一次改动(**不写设置**)。
     * @param onToolChange - 换工具时的联动(它管着的路径跟着换)。
     * @param detectCtx - `{ head, note, perField }`:分组标题渲染、逐字段的检测结论、结论数据。
     * @returns React 子节点数组。
     */
    function renderFields(fields, values, ready, browse, browseTo, setBrowse, pick, drafts, stage, onToolChange, detectCtx, preview) {
      const nodes = [];
      let group;
      for (const field of fields) {
        // 隐藏字段(迁移用的旧键)不渲染 —— 宿主已经不发了,这里再挡一道:免得以后有人
        // 加了 hidden 字段却忘了过滤,页面上冒出几个看不懂的空输入框。
        if (field.control === "hidden") continue;
        if (field.group !== group) {
          group = field.group;
          nodes.push(detectCtx.head(group));
        }
        nodes.push(renderField(field, values, ready, browse, browseTo, setBrowse, pick, drafts, stage, onToolChange, preview, detectCtx));
      }
      return nodes;
    }

    /**
     * 一行字段。
     * @param field - 宿主的字段定义(带 `control` / `options` / `required` / `skips`)。
     * @param values - 当前设置值(宿主那份)。
     * @param ready - 设置服务是否可用(不可用则禁用控件)。
     * @param browse - 当前打开的浏览器状态。
     * @param browseTo - 打开/切换目录。
     * @param setBrowse - 关闭浏览器。
     * @param pick - 「浏览…」的入口(按外壳分流)。
     * @param drafts - 未保存的改动(字段 → 新值)。
     * @param stage - 记下一次改动(**不写设置**)。
     * @param onToolChange - 换工具时的联动(它管着的那条路径跟着换)。
     * @param preview - 未保存改动的预演状态(有它的字段按**页面上那一份**判就绪/类型)。
     * @param detectCtx - `{ head, note, perField }`(检测结论逐字段写在这一行下面)。
     * @returns React 节点。
     */
    function renderField(field, values, ready, browse, browseTo, setBrowse, pick, drafts, stage, onToolChange, preview, detectCtx) {
      const isSelect = field.control === "select";
      // 有未保存的改动时,状态按**页面上这一份**算(宿主预演出来的那份):路径类型也跟着
      // 新选中的工具变,于是"换了工具但还没保存"时不会再显示成已就绪。
      const effective = preview?.find((entry) => entry.key === field.key) ?? field;
      const usable = effective.present === true;
      const optional = field.required !== true;
      const blocked = !optional && !usable && effective.unused !== true;
      const skips = blocked ? (field.skips ?? []) : [];
      const current = values[field.key] ?? field.default ?? "";
      const draft = drafts?.[field.key];
      // 显示"未保存的那份";没改动就显示宿主的值
      const shown = draft === undefined ? String(current) : String(draft);

      /** 浏览/选择器选中、下拉切换:都只是"记一次改动",点「保存改动」才落地。 */
      const commit = (next) => stage(field.key, next);

      return h(
        "label",
        { className: "fpga-set-row", key: field.key },
        h(
          "span",
          { className: "fpga-set-label" },
          field.label,
          // 下拉没有"未就绪"可言;可选字段留空不算未就绪 —— 但**"留空会怎样"必须由宿主说**:
          // 模板是"用自带那份"、库映射文件是"用安装目录那份"、运行时是"按 PATH 找",
          // 不是同一回事。客户端不再自己编一句(以前统一写成模板那种说法,对后两类是错话)。
          // 填了却找不到时更要紧:必须说清它现在不生效,不然用户以为自己那份用上了。
          isSelect
            ? null
            : usable
              ? h("span", { className: "fpga-set-good" }, draft === undefined ? "✓ 已就绪" : "✓ 已就绪(未保存)")
              // 用户明确选了「不用这个工具」:不是未就绪,是决定不用
              : effective.unused === true
                ? h("span", { className: "fpga-set-hint" }, "（不用这个工具）")
                : optional
                ? field.configured === true
                  ? h(
                      "span",
                      { className: "fpga-set-bad" },
                      field.blankNote === undefined ? "⚠ 路径不可用" : `⚠ 路径不可用 —— ${String(field.blankNote)}`
                    )
                  : field.blankNote === undefined
                    ? null
                    : h("span", { className: "fpga-set-hint" }, String(field.blankNote))
                : h("span", { className: "fpga-set-bad" }, "⚠ 未就绪")
        ),
        h("span", { className: "fpga-set-hint" }, field.hint),
        isSelect
          ? h(
              "select",
              {
                className: "fpga-set-input",
                value: shown,
                disabled: !ready,
                onChange: (event) => {
                  const next = String(event.target.value ?? "");
                  // 换工具:重新检测一次 —— 有路径就换成它的,没检测到就在那一行下面提醒
                  const pathKey = (field.options ?? []).find((option) => option.value === next)?.needs;
                  if (pathKey === undefined) commit(next);
                  else onToolChange(field.key, next, pathKey);
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
                // 受控:框里显示"未保存的那份"(否则用户看不到自己刚打的字)
                value: shown,
                disabled: !ready || effective.unused === true,
                placeholder: effective.kind === "directory" ? "例如 C:\\...\\某目录" : "例如 C:\\...\\工具.exe",
                onChange: (event) => {
                  commit(event.target.value ?? "");
                }
              }),
              // 路径在手打/粘贴之外再给一条:点开就是这台机器上的系统窗口(桌面壳里),
              // 拿不到路径才退回页面内的列表 —— 分流在 pick() 里
              h(
                "button",
                {
                  type: "button",
                  className: "fpga-set-btn",
                  disabled: !ready,
                  onClick: () => pick(effective, current, commit)
                },
                "浏览…"
              )
            ),
        browse !== null && browse !== undefined && browse.key === field.key
          ? renderBrowser(effective, browse, browseTo, setBrowse, commit)
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
                  ? `路径不可用(${String(field.path)}),当前不可执行:${skips.join("、")}`
                  : `未配置,当前不可执行:${skips.join("、")}`
              )
        ),
        // 这一行的检测结论(找到了什么 / 没找到)—— 就地写在这一行下面,不再有分组检测块
        detectCtx?.note(detectCtx.perField.find((entry) => entry.key === field.key)),
        // 这一行有未保存的改动:标出来,免得用户以为已经生效了
        draft === undefined ? null : h("span", { className: "fpga-set-hint" }, "未保存")
      );
    }

    /**
     * 取路径的目录部分(文件字段浏览时从它所在目录开始)。
     * @param path - 路径。
     * @returns 目录,取不到时为空串。
     */
    function dirOf(path) {
      const text = String(path ?? "").trim();
      const cut = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
      return cut > 0 ? text.slice(0, cut) : "";
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
      return dirOf(text);
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
      return h(
        "span",
        { className: "fpga-set-browse" },
        h(
          "span",
          { className: "fpga-set-browse-head" },
          h(
            "span",
            { className: "fpga-set-browse-path" },
            listing.path === "" || listing.path === undefined
              ? field.kind === "directory"
                ? "选择一个盘符"
                : "选一个文件(先选盘符)"
              : String(listing.path)
          ),
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
          // 「用这个目录」只给**要目录的字段**(XSim 那种):文件字段上点它,会把一个目录填进
          // 本该填 vsim.exe 的框里。文件字段只保留"点某项即选中"。
          listing.path === "" || listing.path === undefined || field.kind !== "directory"
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
          h("button", { type: "button", className: "fpga-set-btn", onClick: close }, "关闭")
        ),
        browse.note === undefined ? null : h("span", { className: "fpga-set-hint" }, browse.note),        h("input", {
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

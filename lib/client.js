window.__ModuleLoader__.load({
	id: "dsh-fpga-workbench",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region src/client/index.ts
		const h = react.default.createElement;
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
		/** 宿主 lib/index.js 里的 TEMPLATE_PATH；只在能力卡展开时读取分类模板。 */
		const TEMPLATE_URL = "/plugins/fpga-workbench/templates";
		/** 宿主 lib/index.js 里的 SETTINGS_PATH；DSH 0.1.7 没有旧 settingsScope，改走这条保存路由。 */
		const SETTINGS_URL = "/plugins/fpga-workbench/settings";
		/** 宿主 lib/index.js 里的 SELFCHECK_PATH；「运行自检」按需拉一次,不在挂载时请求。 */
		const SELFCHECK_URL = "/plugins/fpga-workbench/selfcheck";
		/** 宿主 lib/index.js 里的 VERSION_PATH；只读本包版本,不发网络请求。 */
		const VERSION_URL = "/plugins/fpga-workbench/version";
		/** 宿主 lib/index.js 里的 UPDATE_PATH；**唯一会离开本机**的调用,只在点按钮时发。 */
		const UPDATE_URL = "/plugins/fpga-workbench/update";
		/**
		* 字段**不再在这里维护** —— 全部由宿主那条状态路由返回(标签、说明、选项、默认值、分组)。
		*
		* 以前这里重复一份 label/hint,靠自检断言"两边逐字一致"来防漂移;现在连重复都取消了:
		* 只有 lib/toolchain.js 一处真相,设置页照着它渲染。
		*/
		const CSS = `
  /* color-scheme 必须声明:否则 select 展开的原生下拉(以及滚动条等控件)不跟随主题 ——
     页面是暗色、弹层却是白底浅字,选项几乎看不清(用户实际看到过)。
     light dark = 交给浏览器按系统/主题偏好选,暗色下弹层、滚动条一起变暗。
     **这条只是没 JS 时的兜底**:实测它在宿主暗色下没变化(偏好是浅色,见 themeOf),
     真正生效的是挂载后按**实际底色**算出来、显式写上去的那份。 */
  .fpga-set { --fpga-set-field-bg: Canvas; color-scheme: light dark; display: flex; flex-direction: column; gap: 14px; padding: 4px 0 8px; font-size: 13px; }
  .fpga-set-head { display: flex; align-items: center; gap: 8px; }
  .fpga-set-mark { display: inline-flex; align-items: center; color: inherit; opacity: .85; }
  .fpga-set-title { font-size: 15px; font-weight: 600; }
  .fpga-set-lead { opacity: .65; line-height: 1.6; margin: 0; }
  .fpga-set-section { display: flex; flex-direction: column; gap: 10px; padding: 10px; border: 1px solid var(--dsh-border, rgba(128,128,128,.22)); border-radius: 8px; }
  .fpga-set-section-head { display: flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 650; }
  .fpga-set-section-head .fpga-set-btn { margin-left: auto; }
  .fpga-set-section-summary { margin-left: auto; font-size: 12px; font-weight: 400; opacity: .62; }
  .fpga-set-tool-groups { display: flex; flex-direction: column; gap: 10px; }
  .fpga-set-tool-group { display: flex; flex-direction: column; gap: 7px; }
  .fpga-set-tool-group-title { font-size: 12px; font-weight: 650; opacity: .65; }
  .fpga-set-tool-card { display: flex; flex-direction: column; gap: 8px; padding: 9px; border-radius: 7px; background: var(--dsh-hover, rgba(128,128,128,.06)); }
  .fpga-set-tool-head { display: flex; align-items: center; gap: 8px; }
  .fpga-set-tool-name { font-weight: 600; }
  .fpga-set-tool-state { margin-left: auto; font-size: 12px; }
  .fpga-set-tool-state-ready { color: #3cb46e; }
  .fpga-set-tool-state-invalid { color: #d9822b; }
  .fpga-set-tool-state-pending { opacity: .6; }
  .fpga-set-tool-body { display: flex; flex-direction: column; gap: 8px; padding-top: 3px; }
  .fpga-set .fpga-set-collapsed { display: none; }
  .fpga-set-tool-actions { display: flex; align-items: center; justify-content: flex-end; gap: 7px; padding-top: 4px; }
  .fpga-set-conventions { display: flex; flex-direction: column; gap: 8px; margin-top: 3px; padding-top: 9px; border-top: 1px solid var(--dsh-border, rgba(128,128,128,.2)); }
  .fpga-set-conventions-head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .fpga-set-conventions-head .fpga-set-btn { margin-left: auto; }
  .fpga-set-aux { display: flex; flex-direction: column; gap: 8px; margin-top: 3px; padding-top: 9px; border-top: 1px solid var(--dsh-border, rgba(128,128,128,.2)); }
  .fpga-set-aux-head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .fpga-set-aux-head .fpga-set-btn { margin-left: auto; }
  .fpga-set-capability { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 7px; background: var(--dsh-hover, rgba(128,128,128,.06)); }
  .fpga-set-capability-head { display: flex; align-items: center; gap: 7px; font-weight: 600; }
  .fpga-set-capability-head .fpga-set-btn { margin-left: auto; }
  .fpga-set-capability-summary { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
  .fpga-set-capability-body { display: flex; flex-direction: column; gap: 9px; padding-top: 4px; }
  .fpga-set-template-errors { display: flex; flex-direction: column; gap: 3px; }
  .fpga-set-stage { display: flex; flex-direction: column; gap: 8px; padding: 9px; border-radius: 7px; background: var(--dsh-hover, rgba(128,128,128,.06)); }
  .fpga-set-stage-head { display: flex; align-items: center; gap: 7px; font-weight: 600; }
  .fpga-set-stage-note { margin: 0; opacity: .58; font-size: 12px; line-height: 1.5; }
  .fpga-set-binding { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
  .fpga-set-group { display: flex; align-items: center; gap: 8px; font-weight: 600; opacity: .8; margin-top: 6px; padding-bottom: 4px; border-bottom: 1px solid var(--dsh-border, rgba(128,128,128,.2)); }
  .fpga-set-row { display: flex; flex-direction: column; gap: 4px; }
  .fpga-set-label { font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .fpga-set-hint { opacity: .5; font-size: 12px; }
  .fpga-set-help { position: relative; width: 18px; height: 18px; padding: 0; border-radius: 50%; border: 1px solid currentColor; background: transparent; color: inherit; opacity: .58; font: inherit; font-size: 11px; line-height: 16px; cursor: help; }
  .fpga-set-help:hover { opacity: 1; }
  .fpga-set-help:focus-visible { opacity: 1; outline: 2px solid var(--dsh-accent, rgba(120,160,255,.7)); outline-offset: 2px; }
  .fpga-set-tooltip { display: none; position: absolute; z-index: 20; left: 22px; top: -6px; width: min(340px, 70vw); padding: 8px 10px; border: 1px solid var(--dsh-border, rgba(128,128,128,.3)); border-radius: 6px; background: var(--fpga-set-field-bg); color: inherit; box-shadow: 0 6px 20px rgba(0,0,0,.2); text-align: left; line-height: 1.5; white-space: normal; }
  .fpga-set-help:hover .fpga-set-tooltip, .fpga-set-help:focus .fpga-set-tooltip, .fpga-set-help:focus-visible .fpga-set-tooltip { display: block; }
  .fpga-set-bad { color: #d9822b; font-size: 12px; font-weight: 400; }
  .fpga-set-good { color: #3cb46e; font-size: 12px; font-weight: 400; }
  .fpga-set-warn { color: #d9822b; font-size: 12px; font-weight: 400; }
  /* 自检卡片:顶栏放标题与按钮,结论逐条列在下面。路径可能很长,必须能断行。 */
  .fpga-set-check { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--dsh-border, rgba(128,128,128,.25)); }
  .fpga-set-check-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .fpga-set-check-list { margin: 6px 0 0; padding-left: 18px; list-style: none; }
  .fpga-set-check-list li { margin: 3px 0; word-break: break-all; }
  .fpga-set-skips { min-height: 0; }
  .fpga-set-skips:empty { display: none; }
  /* 「没装怎么装」:只在工具未就绪时出现。左侧一道细线,和字段说明区分开 ——
     它是**可执行的动作建议**,不是又一条说明文字。 */
  .fpga-set-install {
    border-left: 2px solid currentColor;
    padding-left: 8px;
    margin: 2px 0 4px;
    opacity: .75;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .fpga-set-install .fpga-set-hint { opacity: 1; }
  .fpga-set-install a { color: inherit; text-decoration: underline; word-break: break-all; }
  .fpga-set-input { width: 100%; box-sizing: border-box; padding: 6px 9px; border-radius: 6px; border: 1px solid var(--dsh-border, rgba(128,128,128,.3)); background: transparent; color: inherit; font: inherit; }
  textarea.fpga-set-input { min-height: 72px; resize: vertical; line-height: 1.5; }
  .fpga-set-input:focus { outline: none; border-color: var(--dsh-accent, rgba(120,160,255,.7)); }
  /* 自动填充(:-webkit-autofill)会把输入框盖成**浅底深字** —— 暗色主题下那个框会亮得刺眼,
     而且它是浏览器自己画的、我们改不到 background。用 inset box-shadow 把它盖回去:
     颜色取 --fpga-set-field-bg(定义在 .fpga-set 上),它默认是系统色 Canvas ——
     系统色跟着 color-scheme 走,而上面那份 color-scheme 是**按实际主题显式声明**的,
     所以这里不必写死任何颜色;宿主想换成别的底色,只覆盖这一个变量就行。
     -webkit-text-fill-color: inherit 同理:别让自动填充把字色钉成黑色。 */
  .fpga-set-input:-webkit-autofill { box-shadow: inset 0 0 0 1000px var(--fpga-set-field-bg); -webkit-text-fill-color: inherit; }
  .fpga-set-input-bad { border-color: rgba(230,160,40,.6); }
  /* 可自定义 select(Chromium 135+ 的 appearance: base-select)。
     为什么还需要这一段:上面那份 color-scheme 管得着滚动条、输入框、聚焦环,**却管不着
     select 展开后的弹层** —— 实测宿主暗色下弹层仍是白底浅字(这套 Electron 的原生弹层不吃
     页面的 color-scheme)。base-select 把弹层从"OS 原生菜单"换成**页面自己渲染的一层**
     (Top Layer 里的 popover),颜色这才归 CSS 管;控件仍是真 <select>,键盘与无障碍语义不变。
     整段包在 @supports 里:不支持的引擎一条都不生效,保持现状(没 JS 时也一样)。
     颜色一律走已有变量 / inherit,不写死:弹层底色复用 --fpga-set-field-bg(系统色 Canvas,
     跟着上面按实际主题写下的 color-scheme 走),文字与箭头用 inherit。
     只动 select.fpga-set-input(元素+类),输入框那几条不受影响。
      已知残留(用本机 Chromium 153 实测过,不改):base-select 不替按钮里的文字给箭头留位,
      标签长到贴右边框时会被硬裁、可能压住箭头(原生那份会提前留白);本插件的选项标签
      (最长约 30 字)离得远,试过用 padding-inline-end 留位但**实测无效**(裁点没动),故不留死代码。 */
  @supports (appearance: base-select) {
    /* 进入"可自定义"渲染(选择器与弹层**两处**都要写才进)。按钮部分的边框/内边距/背景仍由上面
       .fpga-set-input 那几条管 —— 这里刻意不动 padding,收起时的排版与现在一致。
       外加单行截断:base-select 下按钮里的文字默认会**换行**(原生是单行裁掉),
       长标签会把行高顶成两行 —— 补回原生那份行为。 */
    select.fpga-set-input { appearance: base-select; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    select.fpga-set-input::picker(select) {
      appearance: base-select;
      background-color: var(--fpga-set-field-bg);
      color: inherit;
      border: 1px solid var(--dsh-border, rgba(128,128,128,.3));
      border-radius: 6px;
    }
    /* 箭头:base-select 下由 UA 样式表给(仍在,不必自绘),只把颜色钉到当前文字色 ——
       UA 那份默认色不受主题控制,暗色下会看不见。位置/大小交给 UA(不用定位去凑,
       也就不会和文字抢地方)。 */
    select.fpga-set-input::picker-icon { color: inherit; }
    /* 选项:选中/悬停的背景同样跟主题走(半透明色叠在弹层底色上,不写死具体颜色) */
    select.fpga-set-input option { background-color: var(--fpga-set-field-bg); color: inherit; }
    select.fpga-set-input option:hover,
    select.fpga-set-input option:focus-visible { background-color: var(--dsh-hover, rgba(128,128,128,.15)); }
    select.fpga-set-input option:checked { background-color: var(--dsh-accent, rgba(120,160,255,.35)); }
  }
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
		* 从 `getComputedStyle` 的颜色里抠出通道与 alpha。
		*
		* 只认 `rgb(r, g, b)` / `rgba(r, g, b, a)` 这两种写法(计算样式回的就是这两种);
		* 空串、`transparent`、`oklch(…)` / `color(srgb …)` 之类一律当成"读不到" → undefined,
		* 由调用方换下一个信号(这也正是后面还留着"宿主主题标记"那一层的原因:配色写法抠不出 rgb 时,
		* 标记仍然能把主题说清楚)。
		* @param text - 计算样式里的一个颜色值。
		* @returns `{ r, g, b, a }`,或 undefined。
		*/
		function parseColor(text) {
			const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/u.exec(String(text ?? "").trim());
			if (match === null) return void 0;
			return {
				r: Number(match[1]),
				g: Number(match[2]),
				b: Number(match[3]),
				a: match[4] === void 0 ? 1 : Number(match[4])
			};
		}
		/**
		* 颜色的相对亮度(0–255,BT.601 那套权重)。阈值 128 是用户给的口径。
		* @param color - {@link parseColor} 的产物。
		* @returns 亮度。
		*/
		function brightness(color) {
			return (color.r * 299 + color.g * 587 + color.b * 114) / 1e3;
		}
		/**
		* 沿祖先链读一个 CSS 颜色,取第一个"能用"的。
		*
		* 透明的东西要跳过(alpha 为 0 等于没画),否则会拿一个根本看不见的颜色去判主题;
		* 一路到头都没读到就返回 undefined,由调用方换下一个信号。
		* @param element - 起点(设置页的根节点)。
		* @param property - 计算样式里的属性名(`color` / `backgroundColor`)。
		* @param opaqueOnly - true = 只认**完全不透明**的值。文字色用这个:半透明的字压在什么底色上
		*   都说得通,判不出主题(而正文的文字色一定是实心的)。背景色沿用原来的口径:画出来了就算。
		* @returns `{ r, g, b, a }`,或 undefined。
		*/
		function firstUsableColor(element, property, opaqueOnly) {
			let node = element;
			while (node !== null && node !== void 0) {
				const color = parseColor(window.getComputedStyle(node)[property] ?? "");
				if (color !== void 0 && (opaqueOnly ? color.a === 1 : color.a !== 0)) return color;
				node = node?.parentElement;
			}
		}
		/**
		* 宿主自己在 `<html>` / `<body>` 上标的主题。
		*
		* **不能写死属性名**:实际用到的写法至少有三种 —— `class="dark"`、`data-theme="light"`,
		* 以及真实宿主用的那种:body 上的 `data-ds-dark-theme`(**属性名里带 dark、值是空串**,
		* 见 DSH 的 dsh-client-ui-layout)。所以遍历每个属性的**名字与值**,找 `dark` / `light`
		* 这两个词,按词边界匹配(`lightbox` 这种不算)。
		*
		* 有意**跳过 `style` 属性**:那是本插件自己也会写的地方(容器与根元素的 color-scheme),
		* 读它等于拿自己上一轮写下的结论当证据 —— 主题真变了也翻不过来。
		* @returns `"dark"` / `"light"`,或 undefined(两个元素上都没有可认的标记)。
		*/
		function markerTheme() {
			for (const node of [document.documentElement, document.body]) {
				if (node === null || node === void 0) continue;
				const values = typeof node.className === "string" ? [node.className] : [];
				for (const attribute of node.attributes ?? []) {
					if (String(attribute?.name ?? "").toLowerCase() === "style") continue;
					values.push(String(attribute?.name ?? ""), String(attribute?.value ?? ""));
				}
				for (const value of values) {
					const text = String(value).toLowerCase();
					if (/(^|[^a-z])dark([^a-z]|$)/u.test(text)) return "dark";
					if (/(^|[^a-z])light([^a-z]|$)/u.test(text)) return "light";
				}
			}
		}
		/**
		* 这个元素**实际看起来**是暗色还是浅色 —— 多信号,按可靠性排序,取第一个判得出来的。
		*
		* 顺序与方向(为什么是这个顺序):
		*   ① **文字颜色**:一定反映主题 —— 暗色主题下正文是**浅色**、浅色主题下是深色,
		*      而且正文的文字色一定是实心的。所以:**文字亮 → "dark"、文字暗 → "light"**
		*      (方向和"背景"**相反**,这是最容易写反的一处)。
		*   ② **第一个不透明背景色**:同样读真实渲染结果;文字读不出来时用它。
		*   ③ **宿主的主题标记**:见 {@link markerTheme}。前两条都读不出来时才轮到它 ——
		*      配色用了 `oklch(…)` 这类抠不出 rgb 的写法时,这一条仍然能判对。
		*   ④ **兜底**:`prefers-color-scheme`。**单独用它不可靠** —— 它反映的是宿主 ui-theme 的
		*      light / dark / system(还可能被第三方主题换掉整套调色板),而弹层要跟的是页面上
		*      **真正渲染成什么样**。宿主 Electron 会把主题偏好同步给渲染进程,所以这一层通常和前
		*      三条一致;只有前三条都读不出来时才用它。
		* @param element - 起点(设置页的根节点)。
		* @returns `"dark"` 或 `"light"`。**任何异常都不许往外抛**(不能为了一个主题把设置页弄崩):
		*   每个信号各自 try/catch,一个读不出来只跳过它,四个都没结论才回到 `"light"`。
		*/
		function themeOf(element) {
			try {
				const ink = firstUsableColor(element, "color", true);
				if (ink !== void 0) return brightness(ink) >= 128 ? "dark" : "light";
			} catch {}
			try {
				const background = firstUsableColor(element, "backgroundColor", false);
				if (background !== void 0) return brightness(background) < 128 ? "dark" : "light";
			} catch {}
			try {
				const marked = markerTheme();
				if (marked !== void 0) return marked;
			} catch {}
			try {
				return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
			} catch {
				return "light";
			}
		}
		/**
		* 芯片标记(带引脚的裸片)。
		* @param size - 边长(px)。
		* @returns svg 元素。
		*/
		function chipMark(size) {
			const pins = [];
			for (const offset of [
				8,
				12,
				16
			]) {
				pins.push(h("line", {
					key: `l${String(offset)}`,
					x1: 4,
					y1: offset,
					x2: 7,
					y2: offset
				}));
				pins.push(h("line", {
					key: `r${String(offset)}`,
					x1: 17,
					y1: offset,
					x2: 20,
					y2: offset
				}));
				pins.push(h("line", {
					key: `t${String(offset)}`,
					x1: offset,
					y1: 4,
					x2: offset,
					y2: 7
				}));
				pins.push(h("line", {
					key: `b${String(offset)}`,
					x1: offset,
					y1: 17,
					x2: offset,
					y2: 20
				}));
			}
			return h("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.5,
				strokeLinecap: "round",
				"aria-hidden": "true"
			}, h("rect", {
				x: 7,
				y: 7,
				width: 10,
				height: 10,
				rx: 2
			}), h("rect", {
				x: 10,
				y: 10,
				width: 4,
				height: 4,
				rx: .8,
				strokeWidth: 1.2
			}), ...pins);
		}
		/** 把长说明收进可用鼠标或键盘打开的小问号。 */
		function helpBubble(key, text) {
			if (typeof text !== "string" || text.trim() === "") return null;
			const id = `fpga-help-${String(key)}`;
			const hint = text.replace(/\s+/gu, " ").trim();
			return h("button", {
				type: "button",
				className: "fpga-set-help",
				"aria-label": `查看说明：${hint.length > 30 ? `${hint.slice(0, 30)}…` : hint}`,
				"aria-describedby": id
			}, "?", h("span", {
				id,
				className: "fpga-set-tooltip",
				role: "tooltip"
			}, text));
		}
		/** 当前插件行的设置值;DSH 0.1.7 由状态路由带回,保存走 SETTINGS_URL。 */
		let settingsValues = {};
		/**
		* 读取当前值。
		* @returns 字段值对象。
		*/
		function currentValues() {
			return settingsValues;
		}
		/** 设置页:标题 + 状态警告 + 各字段。 */
		function SettingsPanel() {
			ensureStyles();
			const [status, setStatus] = react.default.useState(null);
			const values = currentValues();
			const ready = status !== null && status.values !== void 0;
			const [failed, setFailed] = react.default.useState(false);
			const [reload, setReload] = react.default.useState(0);
			const [drafts, setDrafts] = react.default.useState({});
			const [saving, setSaving] = react.default.useState(false);
			const [saveError, setSaveError] = react.default.useState(void 0);
			const [detect, setDetect] = react.default.useState(null);
			const [preview, setPreview] = react.default.useState(void 0);
			const [previewError, setPreviewError] = react.default.useState(void 0);
			const [expandedTool, setExpandedTool] = react.default.useState(void 0);
			const [showToolSettings, setShowToolSettings] = react.default.useState(false);
			const [expandedAuxGroup, setExpandedAuxGroup] = react.default.useState(void 0);
			const [expandedCapability, setExpandedCapability] = react.default.useState(void 0);
			const [templateScan, setTemplateScan] = react.default.useState(null);
			const [browse, setBrowse] = react.default.useState(null);
			const [pickNote, setPickNote] = react.default.useState(void 0);
			const [selfCheck, setSelfCheck] = react.default.useState(null);
			const [version, setVersion] = react.default.useState(void 0);
			const [update, setUpdate] = react.default.useState(null);
			const previewSeq = react.default.useRef(0);
			const detectSeq = react.default.useRef(0);
			const browseSeq = react.default.useRef(0);
			const templateSeq = react.default.useRef(0);
			const rootRef = react.default.useRef(null);
			const schemeBefore = react.default.useRef(void 0);
			/**
			* 挂载后按**实际渲染出来的**主题定一次(见 {@link themeOf}:文字色 → 背景色 → 宿主标记 →
			* 系统偏好,取第一个判得出来的),再把它显式声明出去。
			*
			* 为什么要写两处:容器自身的内联 `color-scheme` 管容器里的原生控件;而 Chromium 里
			* `<select>` 展开的**弹出层是独立渲染的一层**,按**根元素**的 scheme 走 —— 只设容器它
			* 不跟。所以两处都写,卸载时把根元素那个值恢复原样。
			*/
			react.default.useEffect(() => {
				const apply = () => {
					const scheme = themeOf(rootRef.current);
					if (scheme === void 0) return;
					if (rootRef.current?.style !== void 0) rootRef.current.style.colorScheme = scheme;
					if (document.documentElement?.style !== void 0) document.documentElement.style.colorScheme = scheme;
				};
				if (schemeBefore.current === void 0) schemeBefore.current = String(document.documentElement?.style?.colorScheme ?? "");
				apply();
				const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : void 0;
				if (typeof media?.addEventListener === "function") media.addEventListener("change", apply);
				return () => {
					if (typeof media?.removeEventListener === "function") media.removeEventListener("change", apply);
					if (schemeBefore.current !== void 0 && document.documentElement?.style !== void 0) document.documentElement.style.colorScheme = schemeBefore.current;
					schemeBefore.current = void 0;
				};
			}, []);
			react.default.useEffect(() => {
				let live = true;
				fetch(VERSION_URL, { cache: "no-store" }).then((response) => response.ok ? response.json() : void 0).then((data) => {
					if (!live || data === null || typeof data !== "object") return;
					setVersion(data);
				}).catch(() => {});
				return () => {
					live = false;
				};
			}, []);
			react.default.useEffect(() => {
				let live = true;
				fetch(STATUS_URL, { cache: "no-store" }).then((response) => response.ok ? response.json() : void 0).then((data) => {
					if (!live) return;
					if (data === void 0) setFailed(true);
					else {
						if (data.values !== null && typeof data.values === "object") settingsValues = { ...data.values };
						setFailed(false);
						setStatus(data);
					}
				}).catch(() => {
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
			react.default.useEffect(() => {
				const keys = Object.keys(drafts);
				const mine = previewSeq.current += 1;
				setPreview(void 0);
				setPreviewError(void 0);
				if (keys.length === 0) return;
				const timer = setTimeout(() => {
					const query = new URLSearchParams();
					for (const key of keys) query.set(key, String(drafts[key]));
					fetch(`${STATUS_URL}?${query.toString()}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : void 0).then((data) => {
						if (mine !== previewSeq.current) return;
						if (data === void 0) {
							setPreviewError("路径检查接口没有返回结果");
							return;
						}
						setPreview(data);
					}).catch(() => {
						if (mine !== previewSeq.current) return;
						setPreviewError("路径检查接口不可用，请稍后重试");
					});
				}, 250);
				return () => clearTimeout(timer);
			}, [drafts, reload]);
			const fields = status?.tools ?? [];
			const toolFieldKeys = new Set((status?.toolCards ?? []).flatMap((card) => card.fieldKeys ?? []));
			const capabilityFieldKeys = new Set((status?.capabilities ?? []).flatMap((capability) => [String(capability.toolKey ?? ""), ...(capability.templates ?? []).map((template) => template.key)]));
			const templateLibraryFieldKey = status?.templateLibrary?.fieldKey;
			const otherDraftKeys = Object.keys(drafts).filter((key) => !toolFieldKeys.has(key) && !capabilityFieldKeys.has(key) && key !== templateLibraryFieldKey);
			/**
			* 记下一次改动(**不写设置**)。改回原值时就把这条撤掉,别让"未保存"无谓地亮着。
			* @param key - 字段名。
			* @param value - 新值。
			*/
			const stage = (key, value) => {
				setSaveError(void 0);
				previewSeq.current += 1;
				setPreview(void 0);
				setPreviewError(void 0);
				setDrafts((current) => {
					const next = { ...current };
					if (String(value) === String(currentValues()[key] ?? "")) delete next[key];
					else next[key] = value;
					return next;
				});
			};
			/** 丢弃指定字段的未保存改动。 */
			const revertKeys = (keys) => {
				const wanted = new Set(keys);
				previewSeq.current += 1;
				setPreview(void 0);
				setPreviewError(void 0);
				setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !wanted.has(key))));
				setSaveError(void 0);
			};
			/**
			* 只保存调用方给出的字段。同一张工具卡里的多个字段仍是一次原子提交；其他卡和后两块
			* 的草稿不会被顺手带进去。
			*/
			const saveKeys = (requestedKeys, onSaved) => {
				const keys = requestedKeys.filter((key) => drafts[key] !== void 0);
				if (keys.length === 0) return;
				const submitted = Object.fromEntries(keys.map((key) => [key, drafts[key]]));
				setSaving(true);
				setSaveError(void 0);
				fetch(SETTINGS_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ patch: submitted })
				}).then(async (response) => {
					const data = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(data?.error ?? `保存接口返回 ${String(response.status)}`);
					if (data?.values !== null && typeof data?.values === "object") settingsValues = { ...data.values };
					return data;
				}).then(() => {
					const after = currentValues();
					const missed = keys.filter((key) => String(after[key] ?? "") !== String(submitted[key]));
					if (missed.length > 0) {
						setSaveError(`没有确认这次改动生效(${missed.join("、")})。改动还留着,可以再存一次。`);
						return;
					}
					setDrafts((current) => {
						const next = { ...current };
						for (const key of keys) if (String(next[key] ?? "") === String(submitted[key] ?? "")) delete next[key];
						return next;
					});
					setReload((count) => count + 1);
					if (typeof onSaved === "function") onSaved();
				}, (error) => {
					setSaveError(`保存失败:${String(error?.message ?? error)}(改动还留着,可以再试)`);
				}).then(() => setSaving(false));
			};
			/**
			* 采用一条检测结果:把路径记进"未保存的改动"。
			*
			* 检测结果只指向「工具设置」中该工具自己的路径字段,不会改任何环节选择。与手填一个规矩:
			* 点「保存改动」才落地。
			* @param hit - 检测路由给的一项 `{ field, tool, label, path, source }`。
			*/
			const applyHit = (hit) => {
				stage(hit.field, hit.path);
			};
			/** 展开工具卡时，只检测这一个路径字段。检测结果不会自动改路径。 */
			const runDetect = (fieldKey, label) => {
				if (typeof fieldKey !== "string" || fieldKey === "") return;
				const mine = detectSeq.current += 1;
				setDetect({
					fieldKey,
					loading: true,
					perField: [{
						key: fieldKey,
						tool: label,
						hits: [],
						loading: true
					}]
				});
				fetch(`${DETECT_URL}?field=${encodeURIComponent(fieldKey)}`, { cache: "no-store" }).then((response) => {
					if (!response.ok) throw new Error(`接口返回 ${String(response.status ?? "错误")}`);
					return response.json();
				}).then((data) => {
					if (mine !== detectSeq.current) return;
					if (data === null || typeof data !== "object" || !Array.isArray(data.found)) throw new Error("接口返回格式不正确");
					const hits = data.found.filter((hit) => hit.field === fieldKey);
					setDetect({
						fieldKey,
						perField: [{
							key: fieldKey,
							tool: hits[0]?.label ?? label,
							hits
						}]
					});
				}).catch((error) => {
					if (mine !== detectSeq.current) return;
					setDetect({
						fieldKey,
						error: String(error?.message ?? error),
						perField: []
					});
				});
			};
			/** 一组普通字段的标题行。`group` 就是分组名（宿主给的字符串标签）。 */
			const renderGroupHead = (group) => h("div", {
				className: "fpga-set-group",
				key: `group-${String(group)}`
			}, h("span", null, String(group)));
			/**
			* 一项检测结果上的**版本信息**,接在同一行检测结论的后面。
			*
			* 版本字段只有**会起进程问版本的那个运行时字段**(Python 的路径)才有;别的检测项根本
			* 没有这些键 —— 那就一个标签都不给(不留空壳)。
			*
			* 两种情形分别如实说:
			*   · `versionError`(命令跑不起来,版本没验到):"版本查询失败:…"。**只说版本没验到** ——
			*     "就绪/未就绪"是宿主那条状态路由的口径,这里不置一词(文件本身是在的,不能因此说未就绪)。
			*   · 其余:照抄宿主那句 note(实测版本 / 查不出来;hint 样式)。
			* 本模式不再对任何工具做"版本够不够"的判定(带 `expected` 的那套判定随终端字段一起删了),
			* 所以这里也没有"版本不匹配"这种话可说。
			* @param hit - 检测路由给的一项(`{ field, tool, label, path, source, version…? }`)。
			* @returns React 节点,或 null。
			*/
			const versionLine = (hit) => {
				const error = hit.versionError;
				if (typeof error === "string" && error !== "") return h("span", { className: "fpga-set-bad" }, `版本查询失败:${error}`);
				const note = hit.versionNote;
				if (typeof note !== "string" || note === "") return null;
				return h("span", { className: "fpga-set-hint" }, note);
			};
			/**
			* 一个字段的检测结论,写在它自己那一行下面。
			*
			* **只报事实**:这个已登记工具在机器上找到了什么;没找到就明说没有 —— 不回声用户原来填的值。
			* @param entry - `{ key, tool, hits }`(来自 {@link runDetect});`undefined` = 这个字段不参与检测。
			* @returns React 节点,或 null。
			*/
			const detectNote = (entry) => {
				if (entry === void 0) return null;
				if (entry.loading === true) return h("span", { className: "fpga-set-detect-row fpga-set-hint" }, "正在检测这个工具…");
				const where = entry.tool === void 0 ? "" : `(${String(entry.tool)})`;
				const hits = entry.hits ?? [];
				if (hits.length === 0) return h("span", { className: "fpga-set-detect-row" }, `没检测到${where}的路径 —— 手填,或用「浏览…」挑`);
				return hits.map((hit) => h("span", {
					className: "fpga-set-detect-row",
					key: `${String(entry.key)}-${String(hit.path)}`
				}, `检测到${where}:${String(hit.path)}${hit.source === "path" ? "(来自 PATH,可能是旧的)" : "(厂商默认安装位置)"}`, versionLine(hit), String(drafts[hit.field] ?? values[hit.field] ?? "") === String(hit.path) ? null : h("button", {
					type: "button",
					className: "fpga-set-btn",
					disabled: !ready,
					onClick: () => applyHit(hit)
				}, "用这个")));
			};
			const browseTo = (key, path) => {
				const mine = browseSeq.current += 1;
				fetch(`${BROWSE_URL}?path=${encodeURIComponent(String(path ?? ""))}`, { cache: "no-store" }).then((response) => {
					if (mine !== browseSeq.current) return void 0;
					if (!response.ok) throw new Error(`接口返回 HTTP ${String(response.status)}`);
					return response.json();
				}).then((data) => {
					if (mine !== browseSeq.current) return;
					if (data !== void 0) setBrowse({
						key,
						listing: data,
						filter: ""
					});
				}).catch((error) => {
					if (mine !== browseSeq.current) return;
					const reason = error instanceof Error ? error.message : String(error);
					setBrowse({
						key,
						listing: {
							path: String(path ?? ""),
							entries: [],
							error: reason
						},
						filter: ""
					});
				});
			};
			/**
			* 传给字段渲染的检测结论。`head` / `note` 必须一起带上:renderFields 是**模块级**函数,
			* 看不到 SettingsPanel 里的闭包 —— 忘了带,渲染时直接 ReferenceError(自检里那条真实
			* 渲染用例抓到过)。
			*/
			const detectCtx = {
				head: renderGroupHead,
				note: detectNote,
				perField: detect?.perField ?? []
			};
			/**
			* 「浏览…」的入口:**一律用页面内的列表,不弹系统窗口**。
			*
			* 为什么不弹(用户口径,实测踩过好几回):系统文件框在这套外壳里**给不出真实路径** ——
			* 新版 Electron 去掉了 `File.path`(`webUtils.getPathForFile()` 在插件 bundle 里拿不到),
			* 选完只剩文件名;浏览器那条更是只给 `C:\fakepath\…`。弹了就得再退回列表,白走一步、
			* 还让人以为"选完了"。列表本来就能选文件:**进目录 → 单击文件**(或打几个字母过滤后回车)。
			* (名字不叫 browse,免得和上面那份 browse 状态撞名。)
			*/
			const startPick = (field, current) => {
				setPickNote(String(field.kind) === "directory" ? "在下面进到那一层,点「用这个目录」;也可以直接把路径粘进输入框。" : "在下面找到那个文件**点一下**选中(或打几个字母过滤后回车);也可以直接把路径粘进输入框。");
				browseTo(String(field.key), startDir(field, current));
			};
			/** 当前草稿下的一张工具卡状态；路径刚改而预演未返回时显示“正在检查”。 */
			const toolState = (card) => {
				if (!(card.pathKey === void 0 ? false : drafts[card.pathKey] !== void 0)) return card.state ?? "pending";
				if (String(drafts[card.pathKey ?? ""] ?? "").trim() === "") return "unconfigured";
				if (previewError !== void 0) return "invalid";
				return String((preview?.toolCards)?.find((entry) => entry.key === card.key)?.state ?? "pending");
			};
			const toolCardDirty = (card) => (card.fieldKeys ?? []).some((key) => drafts[key] !== void 0);
			const openTool = (card) => {
				setExpandedTool(card.key);
				setSaveError(void 0);
				setDetect(null);
				if (fields.find((field) => field.key === card.pathKey)?.detectable === true && card.pathKey !== void 0) runDetect(card.pathKey, String(card.label ?? ""));
			};
			const closeTool = () => {
				browseSeq.current += 1;
				detectSeq.current += 1;
				setBrowse(null);
				setDetect(null);
				setExpandedTool(void 0);
			};
			const cancelTool = (card) => {
				revertKeys(card.fieldKeys ?? []);
				browseSeq.current += 1;
				detectSeq.current += 1;
				setBrowse(null);
				setDetect(null);
				setExpandedTool(void 0);
			};
			const saveTool = (card) => {
				const state = toolState(card);
				if (state !== "ready" && state !== "unconfigured") return;
				saveKeys(card.fieldKeys ?? [], () => {
					browseSeq.current += 1;
					detectSeq.current += 1;
					setBrowse(null);
					setDetect(null);
					setExpandedTool(void 0);
				});
			};
			/** 能力卡展开时才扫描它需要的模板分类；关闭、切卡或重开都会让旧答复作废。 */
			const openCapability = (capability) => {
				const mine = templateSeq.current += 1;
				setExpandedCapability(capability.key);
				setSaveError(void 0);
				setTemplateScan({
					capability: capability.key,
					loading: true
				});
				fetch(`${TEMPLATE_URL}?capability=${encodeURIComponent(capability.key)}`, { cache: "no-store" }).then((response) => {
					if (!response.ok) throw new Error(`接口返回 ${String(response.status ?? "错误")}`);
					return response.json();
				}).then((data) => {
					if (mine !== templateSeq.current) return;
					const validGroups = Array.isArray(data?.groups) && data.groups.every((group) => group !== null && typeof group === "object" && typeof group.key === "string" && Array.isArray(group.items) && Array.isArray(group.errors ?? []));
					if (data === null || typeof data !== "object" || !validGroups) throw new Error("接口返回格式不正确");
					setTemplateScan({
						capability: capability.key,
						data
					});
				}).catch((error) => {
					if (mine !== templateSeq.current) return;
					setTemplateScan({
						capability: capability.key,
						error: String(error?.message ?? error)
					});
				});
			};
			const closeCapability = () => {
				templateSeq.current += 1;
				setExpandedCapability(void 0);
				setTemplateScan(null);
			};
			const capabilityKeys = (capability) => [String(capability.toolKey ?? ""), ...(capability.templates ?? []).map((template) => template.key)];
			const cancelCapability = (capability) => {
				revertKeys(capabilityKeys(capability));
				closeCapability();
			};
			const saveCapability = (capability) => {
				saveKeys(capabilityKeys(capability), closeCapability);
			};
			const capabilityDirty = (capability) => capabilityKeys(capability).some((key) => drafts[key] !== void 0);
			const toolUi = {
				expandedTool,
				showToolSettings,
				toggleToolSettings: () => setShowToolSettings((shown) => !shown),
				expandedAuxGroup,
				toggleAuxGroup: (group) => setExpandedAuxGroup((current) => current === group ? void 0 : group),
				state: toolState,
				dirty: toolCardDirty,
				open: openTool,
				close: closeTool,
				cancel: cancelTool,
				save: saveTool,
				saveFields: saveKeys,
				revertFields: revertKeys,
				saving,
				saveError
			};
			const capabilityUi = {
				expandedCapability,
				templateScan,
				open: openCapability,
				close: closeCapability,
				cancel: cancelCapability,
				save: saveCapability,
				dirty: capabilityDirty,
				saving
			};
			/**
			* 跑一次只读自检。结果三态:进行中 / 结果 / 失败原因 —— 失败要说清是"拉不到",而不是显示成"没问题"。
			*/
			const runCheck = () => {
				setSelfCheck({ loading: true });
				fetch(SELFCHECK_URL, { cache: "no-store" }).then((response) => response.ok ? response.json() : Promise.reject(/* @__PURE__ */ new Error(`HTTP ${String(response.status)}`))).then((payload) => {
					const checks = Array.isArray(payload?.checks) ? payload.checks : null;
					if (!(checks !== null && checks.every((item) => item !== null && typeof item === "object" && typeof item.id === "string" && typeof item.status === "string"))) throw new Error("自检接口返回格式不正确");
					setSelfCheck({ result: {
						ok: payload.ok === true,
						failed: payload.failed,
						warned: payload.warned,
						checks: checks.map((item) => ({
							id: item.id,
							status: item.status,
							label: typeof item.label === "string" ? item.label : item.id,
							detail: typeof item.detail === "string" ? item.detail : ""
						}))
					} });
				}).catch((error) => setSelfCheck({ error: error instanceof Error ? error.message : String(error) }));
			};
			/**
			* 检查更新。**唯一会离开本机的操作** —— 只有用户点按钮才发请求。
			* 失败要如实说清原因(网络不通 / 限流 / 仓库没有 tag),不编"已是最新"。
			*/
			const runUpdateCheck = () => {
				setUpdate({ loading: true });
				fetch(UPDATE_URL, {
					method: "POST",
					cache: "no-store"
				}).then((response) => response.ok ? response.json() : Promise.reject(/* @__PURE__ */ new Error(`HTTP ${String(response.status)}`))).then((payload) => {
					if (payload === null || typeof payload !== "object") throw new Error("检查更新接口返回格式不正确");
					setUpdate({ result: {
						ok: payload.ok === true,
						kind: typeof payload.kind === "string" ? payload.kind : "unknown",
						installed: typeof payload.installed === "string" ? payload.installed : "",
						latest: typeof payload.latest === "string" ? payload.latest : "",
						source: typeof payload.source === "string" ? payload.source : "",
						reason: typeof payload.reason === "string" ? payload.reason : ""
					} });
				}).catch((error) => setUpdate({ error: error instanceof Error ? error.message : String(error) }));
			};
			const checkMark = (state) => state === "fail" ? "✗" : state === "warn" ? "!" : "✓";
			const checkClass = (state) => state === "fail" ? "fpga-set-bad" : state === "warn" ? "fpga-set-warn" : "fpga-set-good";
			/** 自检卡片:按钮 + 逐条结论。只在用户点过之后才出现结果。 */
			const selfCheckBlock = () => h("div", { className: "fpga-set-check" }, h("div", { className: "fpga-set-check-head" }, h("span", { className: "fpga-set-title" }, "自检"), h("button", {
				type: "button",
				className: "fpga-set-btn",
				disabled: selfCheck?.loading === true,
				onClick: runCheck
			}, selfCheck?.loading === true ? "自检中…" : "运行自检")), h("p", { className: "fpga-set-hint" }, "只读检查:不写设置、不改文件、不起任何进程。它看的是这份已装副本与当前设置;真正的开发自检(npm test)仍在仓库里跑。"), selfCheck?.error === void 0 ? null : h("p", {
				className: "fpga-set-bad",
				role: "alert"
			}, `自检没跑成:${selfCheck.error}`), selfCheck?.result === void 0 ? null : h("div", null, h("p", { className: selfCheck.result?.ok === true ? "fpga-set-good" : "fpga-set-bad" }, `${selfCheck.result?.ok === true ? "通过" : "有阻塞项"}:共 ${String(selfCheck.result?.checks?.length ?? 0)} 项,${String(selfCheck.result?.failed)} 项失败、${String(selfCheck.result?.warned)} 项提醒`), h("ul", { className: "fpga-set-check-list" }, ...(selfCheck.result?.checks ?? []).map((item) => h("li", {
				key: item.id,
				className: checkClass(item.status)
			}, `${checkMark(item.status)} ${item.label}:${item.detail}`)))));
			/**
			* 版本与更新卡片。
			*
			* 「当前版本」在挂载时读一次本地清单(不发网络);「检查更新」必须点按钮才联网 ——
			* 这是本插件唯一会离开本机的请求,静默联网对装在别人机器上的插件是不合适的。
			*/
			const versionBlock = () => h("div", { className: "fpga-set-check" }, h("div", { className: "fpga-set-check-head" }, h("span", { className: "fpga-set-title" }, "版本"), h("button", {
				type: "button",
				className: "fpga-set-btn",
				disabled: update?.loading === true,
				onClick: runUpdateCheck
			}, update?.loading === true ? "检查中…" : "检查更新")), h("p", { className: "fpga-set-hint" }, version === void 0 ? "当前版本:读取中…" : `当前版本 ${String(version.version ?? "")}。兼容 DSH:${String(version.dshRange ?? "")}。`), h("p", { className: "fpga-set-hint" }, "「检查更新」会向 GitHub 查询一次版本标签(约 8 秒超时),不发送任何本机信息;不点就不会联网。"), update?.error === void 0 ? null : h("p", {
				className: "fpga-set-bad",
				role: "alert"
			}, `检查更新没成功:${String(update.error)}`), update?.result === void 0 ? null : update.result.ok !== true ? h("p", {
				className: "fpga-set-warn",
				role: "status"
			}, `查不了:${update.result.reason || "未知原因"}`) : h("p", {
				className: update.result.kind === "available" ? "fpga-set-warn" : update.result.kind === "current" ? "fpga-set-good" : "fpga-set-hint",
				role: "status"
			}, update.result.kind === "available" ? `有新版本 ${update.result.latest}(当前 ${update.result.installed})—— 在「插件」页更新这个插件,或按 README 的 git 命令重新 add。` : update.result.kind === "current" ? `已是最新(${update.result.installed})。` : update.result.reason));
			return h("div", {
				className: "fpga-set",
				ref: rootRef
			}, h("div", { className: "fpga-set-head" }, h("span", { className: "fpga-set-mark" }, chipMark(20)), h("span", { className: "fpga-set-title" }, LABEL)), detect?.error === void 0 ? null : h("p", {
				className: "fpga-set-bad",
				role: "alert"
			}, `工具检测失败:${String(detect.error)}`), h("p", { className: "fpga-set-lead" }, "先登记本机工具，再为模块和工程环节选择已就绪工具及模板。各环节可按需反复切换，并非固定流水线。"), ...(status?.migrationWarnings ?? []).map((warning, index) => h("p", {
				className: "fpga-set-bad",
				key: `migration-warning-${String(index)}`
			}, `设置迁移提醒：${String(warning)}`)), ...renderFields(status, fields, values, ready, browse, browseTo, setBrowse, startPick, drafts, stage, detectCtx, preview, toolUi, capabilityUi), previewError === void 0 ? null : h("p", {
				className: "fpga-set-bad",
				role: "alert"
			}, previewError), pickNote === void 0 ? null : h("p", { className: "fpga-set-hint" }, pickNote), ready ? null : h("p", { className: "fpga-set-hint" }, "设置服务尚未就绪,稍后重试。"), failed ? h("p", { className: "fpga-set-hint" }, "读不到宿主的状态接口(字段与就绪状态都来自它)。检查插件是否装好、或稍后重新打开设置。") : null, selfCheckBlock(), versionBlock(), otherDraftKeys.length === 0 ? null : h("div", { className: "fpga-set-foot" }, h("span", { className: "fpga-set-bad fpga-set-marker" }, "其他设置有未保存的改动"), h("button", {
				type: "button",
				className: "fpga-set-btn",
				disabled: saving,
				onClick: () => revertKeys(otherDraftKeys)
			}, "放弃改动"), h("button", {
				type: "button",
				className: "fpga-set-btn",
				disabled: saving,
				onClick: () => saveKeys(otherDraftKeys)
			}, saving ? "保存中…" : "保存改动")), saveError === void 0 ? null : h("p", {
				className: "fpga-set-bad",
				role: "alert"
			}, saveError));
		}
		/** 按宿主的 section / capability 元数据渲染；数组位置只表示展示顺序。 */
		function renderFields(status, fields, values, ready, browse, browseTo, setBrowse, pick, drafts, stage, detectCtx, preview, toolUi, capabilityUi) {
			const sections = status?.sections ?? [];
			const visible = fields.filter((field) => field.control !== "hidden");
			const row = (field) => renderField(field, values, ready, browse, browseTo, setBrowse, pick, drafts, stage, preview, detectCtx);
			const stateLabel = (state) => state === "ready" ? "已就绪" : state === "invalid" ? "路径不可用" : state === "pending" ? "正在检查" : "未配置";
			const stateClass = (state) => state === "ready" ? "fpga-set-tool-state fpga-set-tool-state-ready" : state === "invalid" ? "fpga-set-tool-state fpga-set-tool-state-invalid" : state === "pending" ? "fpga-set-tool-state fpga-set-tool-state-pending" : "fpga-set-tool-state fpga-set-hint";
			const commonFields = (sectionKey) => {
				const cards = status?.toolCards ?? [];
				const groups = status?.toolGroups ?? [];
				if (cards.length === 0) {
					const nodes = [];
					let group;
					for (const field of visible.filter((entry) => entry.section === sectionKey && entry.capability === void 0)) {
						if (field.group !== group) {
							group = field.group;
							nodes.push(detectCtx.head(group));
						}
						nodes.push(row(field));
					}
					return nodes;
				}
				const toolGroups = groups.map((group) => {
					const groupCards = cards.filter((card) => card.role === group.key);
					if (groupCards.length === 0) return null;
					return h("div", {
						className: "fpga-set-tool-group",
						key: `tool-group-${String(group.key)}`
					}, h("div", { className: "fpga-set-tool-group-title" }, group.label), ...groupCards.map((card) => {
						const expanded = toolUi.expandedTool === card.key;
						const cardState = toolUi.state(card);
						const dirty = toolUi.dirty(card);
						const cardFields = (card.fieldKeys ?? []).map((key) => visible.find((field) => field.key === key)).filter((field) => field !== void 0);
						return h("div", {
							className: "fpga-set-tool-card",
							key: `tool-${String(card.key)}`
						}, h("div", { className: "fpga-set-tool-head" }, h("span", { className: "fpga-set-tool-name" }, card.label), h("span", { className: stateClass(cardState) }, stateLabel(cardState)), h("button", {
							type: "button",
							className: "fpga-set-btn",
							disabled: !ready || toolUi.saving,
							"aria-expanded": expanded,
							"aria-controls": `fpga-tool-body-${String(card.key)}`,
							onClick: () => expanded ? toolUi.close(card) : toolUi.open(card)
						}, expanded ? "收起" : card.configured === true ? "修改路径" : "路径设置")), h("div", {
							id: `fpga-tool-body-${String(card.key)}`,
							className: expanded ? "fpga-set-tool-body" : "fpga-set-tool-body fpga-set-collapsed"
						}, ...cardFields.map(row), h("div", { className: "fpga-set-tool-actions" }, dirty ? h("span", { className: "fpga-set-bad fpga-set-marker" }, "有未保存的改动") : null, h("button", {
							type: "button",
							className: "fpga-set-btn",
							disabled: toolUi.saving,
							onClick: () => toolUi.cancel(card)
						}, "取消"), h("button", {
							type: "button",
							className: "fpga-set-btn",
							disabled: !dirty || toolUi.saving || cardState === "invalid" || cardState === "pending",
							onClick: () => toolUi.save(card)
						}, toolUi.saving ? "保存中…" : "保存此工具"))));
					}));
				}).filter((node) => node !== null);
				const cardFieldKeys = new Set(cards.flatMap((card) => card.fieldKeys ?? []));
				const auxiliary = visible.filter((field) => field.section === sectionKey && field.capability === void 0 && (field.key === void 0 || !cardFieldKeys.has(field.key)));
				const auxiliaryGroups = [...new Set(auxiliary.map((field) => String(field.group ?? "")))].filter((group) => group !== "");
				return [h("div", {
					id: "fpga-tool-settings-body",
					className: toolUi.showToolSettings ? "fpga-set-tool-groups" : "fpga-set-tool-groups fpga-set-collapsed",
					key: "tool-settings-body"
				}, ...toolGroups, ...auxiliaryGroups.map((group, groupIndex) => {
					const expanded = toolUi.expandedAuxGroup === group;
					const bodyId = `fpga-aux-body-${String(groupIndex)}`;
					const groupFields = auxiliary.filter((field) => field.group === group);
					const templateLibrary = groupFields.find((field) => field.key === status?.templateLibrary?.fieldKey);
					const templateKey = templateLibrary?.key ?? "";
					const templateDirty = templateLibrary !== void 0 && drafts[templateKey] !== void 0;
					return h("div", {
						className: "fpga-set-aux",
						key: `aux-${String(group)}`
					}, h("div", { className: "fpga-set-aux-head" }, h("span", null, group), h("button", {
						type: "button",
						className: "fpga-set-btn",
						"aria-expanded": expanded,
						"aria-controls": bodyId,
						onClick: () => toolUi.toggleAuxGroup(group)
					}, expanded ? "收起" : "展开设置")), h("div", {
						id: bodyId,
						className: expanded ? "fpga-set-tool-body" : "fpga-set-tool-body fpga-set-collapsed"
					}, ...groupFields.map(row), templateLibrary === void 0 ? null : h("div", { className: "fpga-set-tool-actions" }, templateDirty ? h("span", { className: "fpga-set-bad fpga-set-marker" }, "有未保存的改动") : null, h("button", {
						type: "button",
						className: "fpga-set-btn",
						disabled: !templateDirty || toolUi.saving,
						onClick: () => toolUi.revertFields([templateKey])
					}, "取消"), h("button", {
						type: "button",
						className: "fpga-set-btn",
						disabled: !templateDirty || toolUi.saving,
						onClick: () => toolUi.saveFields([templateKey])
					}, toolUi.saving ? "保存中…" : "保存路径"))));
				}))];
			};
			const capabilityCards = (sectionKey) => (status?.capabilities ?? []).filter((capability) => capability.section === sectionKey).map((capability) => {
				const expanded = capabilityUi?.expandedCapability === capability.key;
				const toolKey = String(capability.toolKey ?? "");
				const selectedTool = String(drafts[toolKey] ?? values[toolKey] ?? capability.selection ?? "auto");
				const previewCapability = (preview?.capabilities)?.find((entry) => entry.key === capability.key);
				const alignedPreview = previewCapability !== void 0 && String(previewCapability.selection) === selectedTool ? previewCapability : void 0;
				const currentCapability = alignedPreview ?? capability;
				const selectedOption = (capability.toolOptions ?? []).find((option) => String(option.value) === selectedTool);
				const toolText = selectedTool === "auto" ? "由 AI 从已就绪工具中判断" : selectedTool === "none" ? "明确不用" : String(currentCapability.toolLabel ?? selectedOption?.label ?? selectedTool);
				const toolProblem = selectedTool !== "auto" && selectedTool !== "none" && (currentCapability.state === "missing" || currentCapability.state === "invalid" || selectedOption?.disabled === true);
				const scan = capabilityUi?.templateScan?.capability === capability.key ? capabilityUi.templateScan : null;
				const scanGroups = scan?.data?.groups ?? [];
				const templateSelection = (template) => String(drafts[template.key] ?? values[template.key] ?? template.selection ?? "");
				const scannedItem = (template, selection) => scanGroups.find((group) => group.key === template.category)?.items?.find((item) => String(item.id) === selection);
				const effectiveTemplate = (template) => {
					const selection = templateSelection(template);
					const candidate = alignedPreview?.templates?.find((entry) => entry.key === template.key);
					if (candidate !== void 0 && String(candidate.selection ?? "") === selection) return candidate;
					if (String(template.selection ?? "") === selection) return template;
					const item = scannedItem(template, selection);
					return {
						...template,
						selection,
						state: selection === "" ? "default" : item === void 0 ? "pending" : "selected",
						present: selection === "" || item !== void 0,
						summary: selection === "" ? "由 AI 自行决定" : String(item?.label ?? selection)
					};
				};
				const dirty = capabilityUi?.dirty(capability) === true;
				return h("div", {
					className: "fpga-set-capability",
					key: `capability-${String(capability.key)}`
				}, h("div", { className: "fpga-set-capability-head" }, h("span", null, capability.label), helpBubble(`capability-${String(capability.key)}`, String(capability.hint ?? "")), h("button", {
					type: "button",
					className: "fpga-set-btn",
					disabled: !ready || capabilityUi?.saving === true,
					"aria-expanded": expanded,
					"aria-controls": `fpga-capability-body-${String(capability.key)}`,
					onClick: () => expanded ? capabilityUi.close(capability) : capabilityUi.open(capability)
				}, expanded ? "收起" : "展开设置")), h("div", { className: "fpga-set-capability-summary" }, h("span", {
					className: toolProblem ? "fpga-set-bad" : selectedTool === "auto" || selectedTool === "none" ? "fpga-set-hint" : "fpga-set-good",
					key: `capability-tool-summary-${String(capability.key)}`
				}, `工具：${toolText}${toolProblem ? "（未就绪）" : ""}`), ...(capability.templates ?? []).map((template) => {
					const current = effectiveTemplate(template);
					const problem = current.state === "missing" || current.state === "invalid" || current.present === false;
					return h("span", {
						className: problem ? "fpga-set-bad" : "fpga-set-hint",
						key: `capability-template-summary-${String(template.key)}`
					}, `${String(template.label)}：${String(current.summary ?? current.warning ?? "使用内置默认模板")}`);
				})), h("div", {
					id: `fpga-capability-body-${String(capability.key)}`,
					className: expanded ? "fpga-set-capability-body" : "fpga-set-capability-body fpga-set-collapsed"
				}, h("div", {
					className: "fpga-set-row",
					key: capability.toolKey
				}, h("div", { className: "fpga-set-label" }, h("span", null, "工具"), helpBubble(String(capability.toolKey ?? ""), "只可选择工具设置中已经就绪的工具；未就绪项会显示但不可选。")), h("select", {
					className: "fpga-set-input",
					value: selectedTool,
					disabled: !ready,
					"aria-label": `${String(capability.label)}工具`,
					onChange: (event) => {
						const next = String(event.target.value ?? "auto");
						stage(String(capability.toolKey ?? ""), next);
						if (next === "auto" || next === "none") for (const t of capability.templates ?? []) stage(t.key, "");
					}
				}, ...(capability.toolOptions ?? []).map((option) => h("option", {
					key: String(option.value),
					value: String(option.value),
					disabled: option.disabled === true
				}, `${String(option.label)}${option.disabled === true ? "（未就绪）" : ""}`)))), scan?.loading === true ? h("p", { className: "fpga-set-hint" }, "正在扫描这张能力卡需要的模板…") : null, scan?.error === void 0 ? null : h("p", { className: "fpga-set-bad" }, `模板读取失败：${String(scan.error)}`), ...(capability.templates ?? []).map((template) => {
					const selection = templateSelection(template);
					const current = effectiveTemplate(template);
					const shownSelection = String(selection ?? "");
					const group = scanGroups.find((entry) => entry.key === template.category);
					const items = group?.items ?? [];
					const missingSelection = shownSelection !== "" && !items.some((item) => String(item.id) === shownSelection);
					const incompatible = (item) => Array.isArray(item.compatibleTools) && !item.compatibleTools.includes("*") && selectedTool !== "auto" && !item.compatibleTools.includes(selectedTool);
					return h("div", {
						className: "fpga-set-row",
						key: template.key
					}, h("div", { className: "fpga-set-label" }, h("span", null, template.label), helpBubble(template.key, String(template.hint ?? "可保持「由 AI 自行决定」（不固定专用模板）；指定工具后也可从该工具兼容的模板里固定选一份。用户模板可以(不必)在文件头写 `# fpga-workbench-level: module` / `project` 声明所属层级；没声明的两层都会显示并标「未声明层级」。"))), h("select", {
						className: "fpga-set-input",
						value: shownSelection === "" || missingSelection || items.some((item) => String(item.id) === shownSelection && !incompatible(item)) ? shownSelection : "",
						"aria-label": `${String(capability.label)}${String(template.label)}`,
						onChange: (event) => stage(template.key, String(event.target.value ?? ""))
					}, h("option", {
						key: "default",
						value: ""
					}, "由 AI 自行决定"), ...selectedTool === "auto" ? [] : (group?.items ?? []).filter((item) => !incompatible(item)).map((item) => h("option", {
						key: item.id,
						value: item.id
					}, `${String(item.label)}（${item.source === "builtin" ? "内置" : `模板库·${item.level === "module" ? "模块级" : item.level === "project" ? "工程级" : "未声明层级"}`}）`)), missingSelection ? h("option", {
						key: `missing-${shownSelection}`,
						value: shownSelection
					}, current.present === true ? `已保存旧版路径（可用）：${String(current.label ?? shownSelection)}` : `已保存但当前不可用：${shownSelection}`) : null), ...(group?.errors ?? []).map((error, index) => h("span", {
						className: "fpga-set-bad",
						key: `${String(template.key)}-error-${String(index)}`
					}, String(error))), group?.truncated === true ? h("span", { className: "fpga-set-hint" }, "模板数量较多，只显示扫描上限内的项目。") : null, drafts[template.key] === void 0 ? null : h("span", { className: "fpga-set-hint" }, "未保存"));
				}), ...(scan?.data?.errors ?? []).map((error, index) => h("p", {
					className: "fpga-set-bad",
					key: `template-scan-error-${String(index)}`
				}, String(error))), h("div", { className: "fpga-set-tool-actions" }, dirty ? h("span", { className: "fpga-set-bad fpga-set-marker" }, "有未保存的改动") : null, h("button", {
					type: "button",
					className: "fpga-set-btn",
					disabled: capabilityUi?.saving === true,
					onClick: () => capabilityUi.cancel(capability)
				}, "取消"), h("button", {
					type: "button",
					className: "fpga-set-btn",
					disabled: !dirty || capabilityUi?.saving === true,
					onClick: () => capabilityUi.save(capability)
				}, capabilityUi?.saving === true ? "保存中…" : "保存此能力"))));
			});
			if (sections.length === 0) return visible.map(row);
			return sections.map((section) => {
				const common = section.key === "common";
				const sectionKey = String(section.key ?? "");
				const cards = status?.toolCards ?? [];
				const readyCount = common ? cards.filter((card) => toolUi.state(card) === "ready").length : 0;
				return h("section", {
					className: "fpga-set-section",
					key: `section-${String(section.key)}`
				}, h("div", { className: "fpga-set-section-head" }, h("span", null, section.label), helpBubble(`section-${sectionKey}`, String(section.hint ?? "")), common && toolUi !== void 0 ? h("span", { className: "fpga-set-section-summary" }, `已就绪 ${readyCount} / ${cards.length}`) : null, common && toolUi !== void 0 ? h("button", {
					type: "button",
					className: "fpga-set-btn",
					"aria-expanded": toolUi.showToolSettings,
					"aria-controls": "fpga-tool-settings-body",
					onClick: toolUi.toggleToolSettings
				}, toolUi.showToolSettings ? "收起" : "展开设置") : null), ...common ? commonFields(sectionKey) : capabilityCards(sectionKey));
			});
		}
		/**
		* 一个路径字段的**就绪标记**:"文件存在"就是已就绪。
		*
		* 只这一条口径:本模式不再对任何字段做"版本够不够"的判定(带 `versionExpected` 的那套
		* 随终端字段一起删了,2026-09-21),所以这里没有"版本未核验"这类降级说法 —— 实测版本
		* 照样由下面那一行的检测结论照实说出来。
		* @param draft - 未保存的改动;undefined = 显示的是宿主那份值。
		* @returns React 节点。
		*/
		/**
		* "已就绪"徽标。
		* @param draft - 这个字段的未保存草稿；`undefined` 表示没有改动。
		*   ⚠️ 必须保留 `undefined` 与"空字符串"的区别 —— 前者是"没改"，后者是"改成空"。
		*/
		function readyBadge(draft) {
			return h("span", { className: "fpga-set-good" }, draft === void 0 ? "✓ 已就绪" : "✓ 已就绪(未保存)");
		}
		/**
		* 一行字段。
		* @param field - 宿主的字段定义(带 `control` / `options` / `required` / `skips`)。
		* @param values - 当前设置值(宿主那份)。
		* @param ready - 设置服务是否可用(不可用则禁用控件)。
		* @param browse - 当前打开的浏览器状态。
		* @param browseTo - 打开/切换目录。
		* @param setBrowse - 关闭浏览器。
		* @param pick - 打开页面内路径选择器。
		* @param drafts - 未保存的改动(字段 → 新值)。
		* @param stage - 记下一次改动(**不写设置**)。
		* @param preview - 未保存改动的预演状态(有它的字段按**页面上那一份**判就绪/类型/说明)。
		* @param detectCtx - `{ head, note, perField }`(检测结论逐字段写在这一行下面)。
		* @returns React 节点。
		*/
		function renderField(field, values, ready, browse, browseTo, setBrowse, pick, drafts, stage, preview, detectCtx) {
			const isSelect = field.control === "select";
			const fieldKey = String(field.key ?? "");
			const previewField = preview?.tools?.find((entry) => entry.key === field.key);
			const effective = previewField ?? field;
			const pathField = effective.kind !== void 0;
			const current = values[fieldKey] ?? field.default ?? "";
			const draft = drafts?.[fieldKey];
			const shown = draft === void 0 ? String(current) : String(draft);
			const pendingPath = pathField && draft !== void 0 && shown.trim() !== "" && previewField === void 0;
			const configured = draft === void 0 ? effective.configured === true : shown.trim() !== "";
			const usable = draft === void 0 ? effective.present === true : previewField?.present === true;
			const invalidPath = pathField && configured && !pendingPath && !usable && effective.inactive !== true;
			const skips = field.required === true && invalidPath ? field.skips ?? [] : [];
			const commit = (next) => stage(fieldKey, next);
			let control;
			if (isSelect) control = h("select", {
				className: "fpga-set-input",
				value: shown,
				disabled: !ready,
				"aria-label": field.label,
				onChange: (event) => commit(String(event.target.value ?? ""))
			}, ...(field.options ?? []).map((option) => h("option", {
				key: option.value,
				value: option.value
			}, option.label)));
			else {
				const tag = field.control === "textarea" ? "textarea" : "input";
				const editor = h(tag, {
					className: invalidPath ? "fpga-set-input fpga-set-input-bad" : "fpga-set-input",
					...tag === "input" ? { type: "text" } : {},
					spellCheck: false,
					value: shown,
					disabled: !ready || effective.unused === true,
					"aria-label": field.label,
					placeholder: pathField ? effective.kind === "directory" ? "例如 C:\\...\\某目录" : "例如 C:\\...\\工具.exe" : field.control === "textarea" ? "补充命令、参数或限制" : "请输入名称",
					onChange: (event) => commit(event.target.value ?? "")
				});
				control = pathField ? h("span", { className: "fpga-set-field" }, editor, h("button", {
					type: "button",
					className: "fpga-set-btn",
					disabled: !ready,
					onClick: () => pick(effective, shown)
				}, "浏览…")) : editor;
			}
			const state = isSelect || !pathField ? null : pendingPath ? h("span", { className: "fpga-set-hint" }, "正在检查…") : configured ? usable ? readyBadge(draft) : h("span", { className: "fpga-set-bad" }, field.blankNote === void 0 ? "⚠ 路径不可用" : `⚠ 路径不可用 —— ${String(field.blankNote)}`) : field.blankNote === void 0 ? null : h("span", { className: "fpga-set-hint" }, String(field.blankNote));
			/**
			* 「没装怎么装」——只在没就绪时出现。
			*
			* 数据来自宿主的 install 字段(见 lib/toolchain.js 的 INSTALL_HINTS),已经装好的
			* 工具不会带这一段,所以这里不需要再判一次"要不要显示"。
			*/
			const installBlock = () => {
				const install = field === void 0 ? void 0 : field.install;
				if (install === void 0 || install === null || typeof install !== "object") return null;
				const cost = install.free === true ? "免费" : "商业授权";
				const account = install.account === true ? ",下载需注册账号" : "";
				return h("div", { className: "fpga-set-install" }, h("div", { className: "fpga-set-hint" }, `从哪儿装(${cost}${account}):${String(install.where ?? "")}`), h("div", { className: "fpga-set-hint" }, `填什么:${String(install.note ?? "")}`), h("div", { className: "fpga-set-hint" }, "官网:", h("a", {
					href: String(install.url ?? ""),
					target: "_blank",
					rel: "noreferrer"
				}, String(install.url ?? ""))));
			};
			return h("div", {
				className: "fpga-set-row",
				key: field.key
			}, h("div", { className: "fpga-set-label" }, h("span", null, field.label), helpBubble(fieldKey, String(field.hint ?? "")), state), control, installBlock(), pathField && browse !== null && browse !== void 0 && browse.key === field.key ? renderBrowser(effective, browse, browseTo, setBrowse, commit) : null, h("span", { className: "fpga-set-skips" }, skips.length === 0 ? null : h("span", { className: "fpga-set-bad" }, effective.configured === true ? `路径不可用(${String(effective.path)}),当前不可执行:${skips.join("、")}` : `未配置,当前不可执行:${skips.join("、")}`)), detectCtx?.note(detectCtx.perField.find((entry) => entry.key === field.key) ?? {}), draft === void 0 ? null : h("span", { className: "fpga-set-hint" }, "未保存"));
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
			if (browse === null) return null;
			const listing = browse.listing ?? {};
			const filter = String(browse.filter ?? "").toLowerCase();
			const all = listing.entries ?? [];
			const entries = filter === "" ? all : all.filter((entry) => String(entry.name).toLowerCase().includes(filter));
			const close = () => setBrowse(null);
			/** 选中一项:目录就进去,文件就填上。 */
			const choose = (entry) => {
				if (entry.kind === "directory") browseTo(String(field.key ?? ""), String(entry.path ?? ""));
				else {
					commit(String(entry.path ?? ""));
					close();
				}
			};
			return h("span", { className: "fpga-set-browse" }, h("span", { className: "fpga-set-browse-head" }, h("span", { className: "fpga-set-browse-path" }, listing.path === "" || listing.path === void 0 ? field.kind === "directory" ? "选择一个盘符" : "选一个文件(先选盘符)" : String(listing.path)), h("button", {
				type: "button",
				className: "fpga-set-btn",
				disabled: listing.parent === void 0 || listing.path === "",
				onClick: () => browseTo(String(field.key ?? ""), listing.parent ?? "")
			}, "↑ 上级"), listing.path === "" || listing.path === void 0 || field.kind !== "directory" ? null : h("button", {
				type: "button",
				className: "fpga-set-btn",
				onClick: () => {
					commit(String(listing.path));
					close();
				}
			}, "用这个目录"), h("button", {
				type: "button",
				className: "fpga-set-btn",
				onClick: close
			}, "关闭")), h("input", {
				className: "fpga-set-input",
				type: "text",
				spellCheck: false,
				autoFocus: true,
				placeholder: "打字过滤当前目录,回车选中唯一匹配项",
				value: String(browse.filter ?? ""),
				onChange: (event) => setBrowse({
					key: browse.key,
					listing,
					filter: event.target.value ?? ""
				}),
				onKeyDown: (event) => {
					if (event.key !== "Enter") return;
					if (entries.length === 1) choose(entries[0]);
				}
			}), listing.error === void 0 ? null : h("span", { className: "fpga-set-bad" }, `读不了这个目录(${String(listing.error)})`), h("span", { className: "fpga-set-browse-list" }, ...entries.map((entry) => h("button", {
				type: "button",
				key: entry.path,
				className: "fpga-set-entry",
				onClick: () => choose(entry)
			}, `${entry.kind === "directory" ? "📁" : "📄"} ${String(entry.name)}`)), entries.length === 0 && listing.error === void 0 ? h("span", { className: "fpga-set-hint" }, filter === "" ? "(这个目录是空的)" : `(没有名字含「${String(browse.filter)}」的项)`) : null), listing.truncated === true ? h("span", { className: "fpga-set-hint" }, "条目过多,只显示了前 500 项") : null);
		}
		/**
		* 挂载客户端半侧:把本插件的设置面板挂到**插件详情页**。
		*
		* 位置是「侧边栏 → 插件 → dsh-fpga-workbench → 配置」。为什么只在插件页、**不在
		* 「设置」侧栏再放一份**（2026-10-22 按用户的取舍）:
		*
		*   · 这里的配置基本是**装一次就不再动**（工具路径、模板来源、环节偏好），
		*     不是日常要调的东西，放在「设置」里只是占一格；
		*   · 宿主本身就把 `plugins.bundle.config` 定义为"插件自己的配置"，
		*     语义上它就该在插件页，而不是混进全局设置。
		*
		* ⚠️ 删掉 `settings.section` 之后，改配置的唯一入口就是这个插件详情页
		* （或者直接编辑 profile 的 `cordis.patch.yml` 里那段 `config:` 再重启）。
		* 工具调用、路径探测、会话提示**都不依赖这个 UI** —— 它们走宿主 settings 服务
		* 与文件系统，所以即使入口找不到也不影响插件工作。
		*
		* 旧版使用 `settings.plugin.item` + `settingsScope`;0.1.7 改为
		* `plugins.bundle.config`,并由宿主设置路由提供当前行值。
		* @param ctx - client plugin context carrying `slots`.
		*/
		function apply(ctx) {
			ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: "dsh-fpga-workbench",
				order: 500,
				label: () => LABEL
			}, SettingsPanel));
		}
		/**
		* 服务注入:数组,不是对象。形状写错会让 apply 拿到缺服务的 ctx 并抛 TypeError,
		* 而宿主只回一句「did not provide an error message」。
		*
		* 只列 slots；DSH 0.1.7 的设置卡挂在 `plugins.bundle.config`,不再依赖 settingsScope。
		*/
		const inject = ["slots"];
		const name = "dsh-fpga-workbench";
		//#endregion
		exports.__themeOf = themeOf;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

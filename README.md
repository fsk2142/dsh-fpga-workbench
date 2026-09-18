# dsh-fpga-workbench

DSH web GUI 的一个插件:在左侧栏加一行「FPGA 工作台」,点开在主区域显示一个工作台面板。

面板当前显示项目注册表里的模块列表(名称 / 路径 / 阶段 / 备注)。这一版是**壳**:先把
"入口出现在侧边栏、点开有真实数据的面板"这条链路打通,FPGA 流程本身(preset 人设、
技能、engine 接入)还没接。

## 安装

```powershell
# 从 GitHub(推荐;pnpm 会把包物理拷进 profile)
dsh plugin --profile desktop add github:fsk2142/dsh-fpga-workbench

# 从本地工作区(调试用;file: 会建 symlink)
dsh plugin --profile desktop add file:C:\Work\dsh-fpga-workbench

# 卸载
dsh plugin --profile desktop remove dsh-fpga-workbench
```

装完**重启 DSH Desktop**(bundle 列表在启动时组合),左侧栏应出现「FPGA 工作台」。

`dsh plugin` 会做三件事:把包装进 profile、把包名追加进 `dsh.profile.bundles`、
（reconcile 时）把不再声明 `dsh.bundle` 的依赖移出列表。

## 配置

面板读的项目注册表路径,由插件行的 `config.registry` 决定。**以 GitHub/npm 安装时
必须设置它**——因为包被拷进了 profile 的 `node_modules`,默认路径会落在那里,你没有
理由去编辑那个文件。

在 profile 的 `cordis.patch.yml` 里补一行(或在安装后追加):

```yaml
- id: fpga-workbench
  name: 'dsh-fpga-workbench'
  config:
    registry: C:\Work\dsh-fpga-workbench\workbench.json
```

注册表格式:

```json
{
  "workspace": "C:\\Work\\dsh-fpga-workbench",
  "projects": [
    { "name": "我的模块", "path": "C:\\Work\\xxx", "stage": "sim", "note": "备注" }
  ]
}
```

文件缺失是正常状态(首次运行),不是故障:面板显示空列表。JSON 损坏时面板显示原因,
不会静默空白。宿主每次请求都重读,所以改完刷新页面即可。

## 这个插件的两条硬约束

**不要给它加任何 npm 依赖。** ESM 的裸依赖从模块自身位置向上解析,不看宿主锚点。
所以只要包不是**物理拷进** profile 的 `node_modules`,任何 `dependencies` 都会
`ERR_MODULE_NOT_FOUND`——而插件加载失败会把整个组合拖崩,代价是用户的桌面端起不来。
实测过的三种加载方式:

| 加载方式 | 裸依赖 | 结果 |
|---|---|---|
| 绝对路径挂载(`name: 'C:\...\lib\index.js'`) | 有 | 解析失败 |
| `file:` 链接(`dsh plugin add file:...`) | 有 | 解析失败 |
| `github:` / `npm:`(物理拷进 profile) | 有 | 可解析 |

因此 `lib/index.js` 只 import `node:` 内置模块。`tools/check-load-contract.mjs`
会强制这条。

**客户端半侧是手写的懒 CJS bundle,没有构建步骤。** `lib/client.js` 是
`window.__ModuleLoader__.load({ id, factory })` 形式,只 `require("react")`
(来自内核冻结的基座模块表)。所以仓库里没有 tsdown/tsc,也不需要 `prepare` 脚本
——这一点是 `dsh plugin add <git 规格>` 能装上的前提,pnpm 会跑 `prepare`。

`lib/` 是**源码**,不是产物。`.gitattributes` 里标了 `linguist-generated=false`,
免得被当成生成代码折叠掉。

## 侧边栏入口是怎么挂上去的

两条注册必须成对,`id` 必须相同:

```js
ctx.slots.inject("sidebar.panellist", function* () {
  yield ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 100, label: LABEL }, Glyph);
});
ctx.slots.inject("main", function* () {
  yield ctx.slots.register({ name: "main", key: PANEL_ID }, Panel);
});
```

- `sidebar.panellist` 是 list 槽(要求 `id`),侧边栏按 `order` 排序渲染成可点击行。
- `main` 是 keyed 槽(要求 `key`),`ctx.layout.selectPanel(id)` 按 `key` 匹配面板。
- 两处不一致时,点击会在控制台抛 `main panel "..." is not registered`。
- `slots.inject(parent, callback)` 在父槽**尚未声明时会等待**并在声明提交后对账,
  所以注册顺序无关,不会因为侧边栏还没加载就失败。

## 自检

```powershell
node tools/check-compat.mjs          # 插件用到的每个接口在当前 DSH 上确实存在
node tools/check-load-contract.mjs   # 无裸依赖 / 三种加载方式可 import / 导出面正确
node tools/check-host-route.mjs      # 路由在数据异常与配置覆盖下都返回可渲染结果
node tools/check-install-safety.mjs  # 装进来会不会扰动 profile 既有依赖(镜像实测)
node tools/compare-locks.mjs         # 上一步的两份锁文件差异
```

`check-compat.mjs` 与 `check-install-safety.mjs` 里写死了本机路径
(`C:/Program Files/DSH Desktop`、`~/.dsh/profiles/desktop`),换机器要改;
两者都支持用 `DSH_PROFILE_MANIFEST` 覆盖 profile 清单位置。

## 已验证 / 未验证

**已机器验证**:清单契约;bundle 在内核语义下的物化与导出面;两条槽位注册的形状与
`id`/`key` 配对;宿主路由在四种数据状态(正常 / 缺失 / JSON 损坏 / 顶层非对象)与
`config.registry` 覆盖下的行为;版本兼容(插件用到的每个接口都已安装 DSH 上存在);
安装不扰动既有依赖(镜像实测 177→178 个包,既有锁定版本无一位移)。

**未验证**:侧边栏那一行是否真的出现、点击能否切到面板。这需要真实浏览器,而本会话
的沙箱不允许 Chrome 启动(它要建命名管道与 IPC:`mojo platform_channel` 拒绝访问)。
这一条只能靠人在 GUI 里确认。

# dsh-fpga-workbench

**一个 DSH 的 FPGA 开发模式。**

它做两件事:

1. 往 DSH 的 agent 预设名单里加一个「**FPGA 开发模式**」,于是新建会话时能和
   `标准 / 极简 / PTC / 创造` 并列地选它。
2. 在「设置 → FPGA 开发模式」里收五个本机路径(Vivado / ModelSim / Verilator /
   库目录 / 缓存目录),并在**这个模式的会话里**把它们交给 agent 使用。

**它不注册任何主界面。** 没有侧边栏入口、没有面板、没有替换官方任何组件——你现有的
界面一行都不动,只多一个设置分区。

## 安装

```powershell
# 从工作区(开发时用)
dsh plugin --profile desktop add file:C:\Work\dsh-fpga-workbench
```

装完**重启 DSH Desktop**,新建会话时预设选择器里就会出现「FPGA 开发模式」。

> 刷新安装用 `node C:\Work\dsh-fpga-workbench\tools\install.mjs`(先校验、不一致才重装、
> 并逐字节校验结果)。**必须在你自己的终端里跑** —— 受限沙箱里 pnpm 无法在 profile
> 目录建临时文件。

## 它由什么组成

```
package.json                  dsh.bundle.patch + dsh.client + exports['./mode'];
                              peer 依赖 schemastery(profile 自带,不新增依赖)
cordis.patch.yml              profile 层:挂载宿主半侧 + 覆盖 agent-presets 行
lib/index.js                  宿主半侧(全局):注册设置、同步预设、探测路径、只读状态路由
lib/mode.js                   模式半侧(只有本模式):把工具链交给本模式的会话
lib/toolchain.js              字段定义 + 存在性判定 + 提示文案 —— 只依赖 node 内置模块
lib/client.js                 浏览器半侧:手写懒 CJS bundle,「设置 → FPGA 开发模式」分区
presets/fpga-workbench/
    preset.yml                选择器里显示的名字与描述
    agent.cordis.yml          这个模式的组装:人设 + 工具行 + 模式半侧 + 自带技能目录
    skills/                   只在本模式可见的技能(随预设复制走)
tools/                        7 个自检 + install.mjs + 依赖安全/锁文件比对
```

## 两个半侧,以及为什么提示只给这个模式

DSH 里插件可以挂在两个平面上,这是本插件最要紧的一条设计:

| | 插件行(profile 层) | 预设行(agent 作用域) |
|---|---|---|
| 谁看得见 | 所有会话 | 只有命名了本预设的会话 |
| 这里放什么 | 设置命名空间、路径探测、缓存目录、状态路由 | 工具链提示段、模式专属技能 |
| 代码 | `lib/index.js` | `lib/mode.js` |

**刻意不往会话提示里注入任何东西** —— 那是插件行的作用域,是全局的:普通会话也会看到
FPGA 工具链的信息与警告,与"不影响正常会话"冲突。所以工具链那段提示由 `lib/mode.js`
注册,它只从本预设的组装里挂载。`tools/check-toolchain.mjs` 有一条源码断言守着这个分工:
`lib/index.js` 里不允许出现 `systemPrompt`。

同理,技能也按模式隔离:`agent.cordis.yml` 里 `skill-filesystem` 那一行把**预设目录下**的
`skills/` 追加进 `customSkillDirs`(`!!js ... new URL('skills/', baseUrl)`,baseUrl 是组装
文件自己的目录,所以预设被复制到用户预设目录之后依然指得对 —— 官方 `cordis` 预设就是这么写的)。
`includeDefaultRoots` 保持默认的 `true`:你的工作区技能与用户技能在本模式下**照常可见**,
这里是追加,不是替换。

## 三条必须知道的约束

**一、`files` 白名单必须包含 `lib` 与 `presets`。**

pnpm 安装 `file:` 依赖时按 `files` 打包,白名单外的东西**不会被拷进 profile**。踩过这个坑:
`presets/` 没写进 `files` → 安装副本缺预设目录 → **预设列表里永远看不到这个模式,而且没有
任何报错**。`tools/check-installed.mjs` 会断言这条,并逐字节比对整个 `presets/` 树。

**二、覆盖 `agent-presets` 必须重述要保留的字段。**

按 id 定位的 patch 不做深度合并,会**替换整份 config**。所以 `default` /
`includeShippedRoot` / `includeUserRoot` 都必须重述——漏掉 `includeShippedRoot`
会让 `标准 / 极简 / PTC / 创造` 那些官方预设**整个消失**。
`tools/check-preset-root.mjs` 用宿主同一个 loader 的求值器把 `!!js` 算出来,断言
路径真实存在、预设结构合法、字段重述完整。

**三、预设行里的包名写错不会报错,只会让预设消失。**

`agent.cordis.yml` 里那一行 `name: 'dsh-fpga-workbench/mode'` 靠 `exports['./mode']`
解析。名字对不上时,discovery 会把整个预设判成 **broken**、从选择器里摘掉,只在日志里
留一行。`tools/check-preset-root.mjs` 断言这一行的解析,`tools/check-preset-sync.mjs`
断言它没跟官方 `standard` 漂移。

## 自检

```powershell
node tools/check-toolchain.mjs     # 字段/存在性/警告措辞/两侧契约/提示文案三种状态
node tools/check-preset-root.mjs   # 预设路径求值 + 组装结构 + 模式行 + 自带技能
node tools/check-preset-sync.mjs   # 预设底座与官方 standard 的漂移(行 id / 包名)
node tools/check-patch-file.mjs    # 补丁字节合法 + 形状
node tools/check-installed.mjs     # 已装副本与源逐字节一致(支持 DSH_PROFILE_DIR 覆盖)
node tools/check-install-safety.mjs / compare-locks.mjs   # 依赖与锁文件安全(较慢)
```

前三个写死了本机路径(`C:/Program Files/DSH Desktop`、`~/.dsh/profiles/desktop`),
换机器要改。

## 现状与下一步

- ✅ 模式本身可用:预设随插件走,选择器里可选
- ✅ 五个路径可用:设置页配置 → 宿主核对存在性 → **本模式的会话提示**拿到路径与调用姿势
- ✅ 模式专属技能:`presets/fpga-workbench/skills/`(目前一个 `fpga-module-flow`)
- ⬜ 更强的能力接入:把 lint / 仿真 / 综合 / 时序做成**这个模式能直接调用的工具**
  (由插件起进程、产物落缓存目录)。现在命令仍由 agent 用 shell 工具跑 —— 走沙箱、
  可见、可中断;真做成工具就得接 subprocess 服务并自己处理超时与日志
- ⬜ 技能内容按实际使用反馈扩充

## 关于界面(已放弃的方案,留作记录)

早期版本尝试过在 UI 上加东西:侧边栏入口行、主区域面板、甚至替换官方会话区。
结论:

- **入口行 / 面板**能做,但对"FPGA 工作模式"这个目标来说是多余的
- **替换官方会话区**做过一版,实机效果远不如官方(要追上得复刻它的 CSS 与交互),
  而且必然改掉官方列表的样子 —— 已回退
- **替换整个侧边栏**机制上做不到:声明一个已被声明的子槽会直接抛错
  (`slot "x" is already declared`),那个错发生在插件加载阶段,**会让桌面端起不来**

那些实现都在 git 历史里(`b3781ff` 是替换版,`7560643` 是回退)。

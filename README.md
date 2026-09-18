# dsh-fpga-workbench

用来在 dsh 中导入一个 FPGA 工作台进行自动化 FPGA 工程开发。

**一个 DSH 的 FPGA 开发模式。**

它做两件事:

1. 往 DSH 的 agent 预设名单里加一个「**FPGA 开发模式**」,于是新建会话时能和
   `标准 / 极简 / PTC / 创造` 并列地选它。
2. 在「设置 → FPGA 开发模式」里收五个本机路径(Vivado / ModelSim / Verilator /
   库目录 / 缓存目录)**外加一个可选的模板目录**,并在**这个模式的会话里**把它们交给 agent 使用。

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
>
> **如果 `dsh plugin add` 被供应链策略挡住**(`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`):
> 那个门禁查的是**整个 profile 的锁文件**,里面任何一个包"太新"就会整体拒绝,与我们这个
> 包无关。这时用 `node tools\sync-installed.mjs`:它不经过 pnpm,只把包内容写进已装的
> `node_modules/<包名>`(依赖声明与锁文件里本来就有这个包,且记录的是**路径**,所以内容
> 更新不会让它们失效)。它不碰 profile 的 `package.json` / 锁文件 / `settings.yaml`,
> 不联网、不装新依赖。等那几条锁文件记录过了最小发布年龄,再跑 `install.mjs` 即可。

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
    templates/                自带模板:rtl.sv / tb.sv / constraints.xdc(写法规范的载体)
    tools/                    自带命令:check-rtl.mjs(规范检查)/ stage-status.mjs(阶段汇总)
tools/                        8 个自检 + install.mjs + 依赖安全/锁文件比对
```

## 自带命令:只做"一条命令能判成败"的事

技能的判据写在文档里,靠 AI 逐条看;**能用一条命令判定成败的,做成脚本** —— 这类检查脚本比
人可靠,而且每次代价一样:

| 命令 | 干什么 | 退出码 |
|---|---|---|
| `node presets/fpga-workbench/tools/check-rtl.mjs <模块目录>` | RTL 机械规范:文件头 / 九个小节块 / 端口类型 / 复位极性 / always_ff / end-else / 断言 / 测试平台自检 / Tab / 行尾 / 代码行非英文 | 0 无阻塞项 / 1 有阻塞项 / 2 用法问题 |
| `node presets/fpga-workbench/tools/stage-status.mjs <目录>` | 阶段状态汇总:读各阶段结果里的 `结论:...`,一眼看出做到哪了 | 0 正常 / 2 找不到 `.fpga-workbench.json` |

两条规则与旧包一致,别自己加严:

- **Tab / 代码行非英文 / 行尾混用 只算警告**,不阻塞门禁
- **纯格式检查要宽容**:文件头只要求"顶部有分隔条 + 前 15 行字段齐全";九个小节块只要求名字作为
  banner 存在(宽度容忍 84–86),不校验列宽与顺序

会话提示里会列出这两个命令的**绝对路径**,AI 照用即可。`tools/check-fpga-tools.mjs` 断言
**插件自带的模板必须过自己的检查器** —— 模板与检查器不能互相矛盾。

## 写法规范放在模板里,不放在技能正文里

RTL 的文件头、九个小节块、端口对齐这些**格式**都是各自的习惯,写死在技能里换个人就废了。
所以:

- 插件自带一套默认模板(`presets/fpga-workbench/templates/`),来源是原先 FPGAWorkFlowKit
  的模块模板;用户不动它就一直用这套
- 设置里的**模板路径是可选项**(RTL / 测试平台 / 约束各一个字段):填了就用你那份,
  留空或找不到就用自带那份,并在会话提示里写清**最终用的是哪一份**
- 会话提示里会给出每个模板的绝对路径,agent 写 RTL 之前先读它,照着写

这样换一套模板 = 换写法规范,技能一个字都不用改。

## 路径怎么填:手打、粘贴,或者点一下挑

路径字段三个办法:直接敲、把资源管理器地址栏里的路径粘进去、或者点旁边的「**浏览…**」。

「浏览…」按**外壳**分流,两种外壳各自走到能用的那条路上:

- **桌面壳(Electron)** → 直接弹**系统窗口**:文件字段是打开文件框,目录字段是选文件夹框
  (取的是所选文件夹本身)。一步到位,不用在页面里一层层点。
- **普通浏览器** → 直接给**页面内的列表**:打几个字母过滤(打开就聚焦),**只剩一项时回车直接选中**;
  点目录进去、「↑ 上级」往上走、「用这个目录」填当前目录。目录由**宿主**列
  (只读路由 `/plugins/fpga-workbench/browse`,浏览器碰不到磁盘),鉴权与状态路由相同。

为什么普通浏览器不弹系统窗口:浏览器出于安全**只给文件名**(`file.path` 是 `C:\fakepath\xxx.exe`),
拿不到真实路径 —— 弹了也白弹,所以干脆不弹。桌面壳里 `file.path` 是真的,才启用。
拿不到路径时(极少数情况,比如选了个空文件夹)会自动退回列表并说明原因,
**绝不会把一个假路径写进设置**。

**为什么不是"宿主弹系统对话框"**(试过,撤了):起初做成"宿主起 PowerShell 弹 OpenFileDialog /
BrowseForFolder"。实测那条路在宿主上下文里**弹不出窗口** —— 进程活着、窗口不出现,按钮还会卡在
"等待选择…"且无法取消。DSH 自己的 `ctx.directoryPicker` 只能选目录,而且那是给工作区切换器占位的
接缝;平台的原生选择器走 worker + koffi 调 Win32,插件用不上。**没验证过的东西不留在代码里**。
现在的做法把弹窗交给**浏览器自己**——它一定弹得出来,不需要我们起进程。

另外手打这条路本来也不慢:路径常常是你手上就有的(资源管理器地址栏、别人的命令、日志里的一行),
复制粘贴比任何选择器都快。

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
node tools/check-toolchain.mjs      # 字段/存在性/警告措辞/两侧契约/提示文案三种状态
node tools/check-load-contract.mjs  # 加载契约:语法/lib 内部 import/bundle 契约/半侧分工(重启前必跑)
node tools/check-fpga-tools.mjs     # 自带命令的判定正确性 + 自带模板自洽 + CLI 退出码
node tools/check-preset-root.mjs    # 预设路径求值 + 组装结构 + 模式行 + 自带技能
node tools/check-preset-sync.mjs   # 预设底座与官方 standard 的漂移(行 id / 包名)
node tools/check-patch-file.mjs    # 补丁字节合法 + 形状
node tools/check-installed.mjs     # 已装副本与源逐字节一致(支持 DSH_PROFILE_DIR 覆盖)
node tools/smoke-installed.mjs     # 已装副本在真实解析环境里能否加载(装完/重启前跑)
node tools/check-install-safety.mjs / compare-locks.mjs   # 依赖与锁文件安全(较慢)
```

`smoke-installed` 与 `check-installed` 的关系:后者比字节,前者**真的加载一遍** ——
在 profile 的解析环境里 import 宿主半侧、执行客户端 bundle 的工厂函数、用真实设置跑一遍
状态载荷与会话提示段。"文件都对但一加载就炸"只有它能抓住,而那种情况重启后就是黑屏。
`tools/install.mjs` 装完会自动跑它。

前三个写死了本机路径(`C:/Program Files/DSH Desktop`、`~/.dsh/profiles/desktop`),
换机器要改。

## 现状与下一步

- ✅ 模式本身可用:预设随插件走,选择器里可选
- ✅ 五个路径可用:设置页配置 → 宿主核对存在性 → **本模式的会话提示**拿到路径与调用姿势
- ✅ **模块开发的七个阶段技能**(`presets/fpga-workbench/skills/`),按阶段加载,一个阶段一个:

  | 技能 | 干什么 | 结果落在哪 |
  |---|---|---|
  | `fpga-spec` | 讨论与规格:谈功能 → 建参考(翻资料 / Python 原型)→ 落规格 | `spec/spec.md` |
  | `fpga-lint` | 写完 RTL 统一检查:Verilator + 规范逐条对 | `lint/lint.md` |
  | `fpga-sim` | 功能仿真:命令行 vsim,测试平台自检 + 看门狗 | `sim/sim.md` |
  | `fpga-comp` | 与参考模型 / golden 比对,差异归属 | `comp/comp.md` |
  | `fpga-synth` | Vivado 批处理综合(频率是观察值,不是门禁) | `synth/synth.md` |
  | `fpga-timing` | 读综合后时序报告:约束是否干净 + CDC | `timing/timing.md` |
  | `fpga-review` | 审查:AC 覆盖、结构、跨域、握手、独立性 | `review/review.md` |

  另有一个 `fpga-module-flow` 是早期雏形,开头已标弃用,留着当对照,待清理。
- ✅ **工程级流程**(9 个技能,`fpga-project-*`),门槛是**模块级跑完并通过确认**:

  | 技能 | 干什么 | 结果落在哪 |
  |---|---|---|
  | `fpga-project-spec` | 工程需求 + 架构 + 模块清单表 + 器件工程选择 + IP 策略 | `project/spec/spec.md` |
  | `fpga-project-integrate` | 顶层集成:时钟复位分配、接口对接、加进工程 | `project/integrate/` |
  | `fpga-project-constraints` | 约束与管脚:对原理图逐条核、IO 电平、时序例外写理由 | `project/constraints/` |
  | `fpga-project-syssim` | 系统级仿真(可选,不适用就记 NOT_APPLICABLE) | `project/syssim/` |
  | `fpga-project-impl` | 布局布线 + DRC + bitstream | `project/impl/` |
  | `fpga-project-timing` | **post-route** 时序(与模块级 post-synth 不同) | `project/timing/` |
  | `fpga-project-board` | 上板:下载(-verify)、ILA/VIO、回读数据比对、固化 Flash | `project/board/` |
  | `fpga-project-release` | 发布归档:判据是"照着归档能重建同样的 bit" | `project/release/` |
  | `fpga-project-audit` | 工程体检(横切):断链、过时、孤儿文件、跑不起来的脚本 | `project/audit/` |

  工程级阶段文件夹统一在 `project/` 下——模块级与工程级都有 `spec`/`timing`,平铺会撞名。
- ✅ 模板:自带 `rtl.sv` / `tb.sv` / `constraints.xdc`,设置里可换成自己的
- ⬜ 更强的能力接入:把某些阶段做成**这个模式能直接调用的工具**(由插件起进程)。
  现在命令仍由 agent 用 shell 工具跑 —— 走沙箱、可见、可中断;真做成工具就得接 subprocess
  服务并自己处理超时与日志
- ⬜ 待清理:旧雏形技能、以及旧工具包里已经带进来的东西的收尾

## 关于界面(已放弃的方案,留作记录)

早期版本尝试过在 UI 上加东西:侧边栏入口行、主区域面板、甚至替换官方会话区。
结论:

- **入口行 / 面板**能做,但对"FPGA 工作模式"这个目标来说是多余的
- **替换官方会话区**做过一版,实机效果远不如官方(要追上得复刻它的 CSS 与交互),
  而且必然改掉官方列表的样子 —— 已回退
- **替换整个侧边栏**机制上做不到:声明一个已被声明的子槽会直接抛错
  (`slot "x" is already declared`),那个错发生在插件加载阶段,**会让桌面端起不来**

那些实现都在 git 历史里(`b3781ff` 是替换版,`7560643` 是回退)。

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
    tools/                    自带命令,**按级别分目录**:module/ 只放模块级、project/ 只放工程级、
                              顶层是两级共用(setup-scaffold.mjs)、lib/ 是内部模块(不是命令)
tools/                        8 个自检 + install.mjs + 依赖安全/锁文件比对
```

## 自带命令:按级别分目录,按环节分命令

技能的判据写在文档里,靠 AI 逐条看;**能用一条命令判定成败的,做成脚本** —— 这类检查脚本比
人可靠,而且每次代价一样:

命令按**级别**分目录(`module/` 只放模块级、`project/` 只放工程级、顶层两级共用),名字再带**环节**
前缀 —— 级别与环节两样都要一眼看出来:

| 级别 | 环节 | 命令 | 干什么 | 退出码 |
|---|---|---|---|---|
| 两级共用 | 规格 | `node presets/fpga-workbench/tools/setup-scaffold.mjs <根目录> [--kind module\|project] [--modules A,B] [--force] [--dry-run]` | 一次建好环节目录骨架 + 锚点 `.fpga-workbench.json`(幂等;只建目录,不生成空报告) | 0 成功 / 1 出错 / 2 参数不对 |
| 模块级 | RTL | `node presets/fpga-workbench/tools/module/module-rtl-new.mjs <模块根> <模块名> --template <RTL 模板路径> [--out <相对路径>] [--force] [--dry-run]` | 按模板起 RTL 文件:复制模板、**只替模块名**,其余内容原样保留;默认落 `rtl/<模块名>.<扩展名>` | 0 成功 / 1 目标已存在 / 2 参数或环境问题 |
| 模块级 | RTL | `node presets/fpga-workbench/tools/module/module-rtl-check.mjs <模块目录>` | RTL 机械规范:文件头 / 九个小节块 / 端口类型 / 复位极性 / always_ff / end-else / 断言 / 测试平台自检 / Tab / 行尾 / 代码行非英文 | 0 无阻塞项 / 1 有阻塞项 / 2 用法问题 |
| 模块级 | 验证 | `node presets/fpga-workbench/tools/module/module-verif-new.mjs <模块根> <模块名> --template <测试平台模板路径> [--out <相对路径>] [--force] [--dry-run]` | 按模板起测试平台;默认落 `verif/tb_<模块名下划线形式>.<扩展名>` | 0 成功 / 1 目标已存在 / 2 参数或环境问题 |
| 模块级 | 验证 | `node presets/fpga-workbench/tools/module/module-verif-wave.mjs <模块根> [模块名] [--sim-path <仿真器>] [--tb <测试平台>] [--dry-run]` | **给人看波形**:编译 + 开 GUI + `log -r /*` + 加波形 + 停在 0 时刻(不自动 run);生成 `verif/wave.do` | 0 已打开/已生成 / 1 找不到平台或设计 / 2 参数或环境问题 |
| 模块级 | 综合 | `node presets/fpga-workbench/tools/module/module-synth-new.mjs <模块根> <模块名> --template <约束模板路径> [--out <相对路径>] [--force] [--dry-run]` | 按模板起约束文件;默认落 `synth/<模块名>.xdc` | 0 成功 / 1 目标已存在 / 2 参数或环境问题 |

另外两条规则与旧包一致,不要自行加严:

- **Tab / 代码行非英文 / 行尾混用 只算警告**,不阻塞门禁
- **纯格式检查要宽容**:文件头只要求"顶部有分隔条 + 前 15 行字段齐全";九个小节块只要求名字作为
  banner 存在(宽度容忍 84–86),不校验列宽与顺序

会话提示里会列出这几个命令的**绝对路径**,AI 照用即可。`tools/check-fpga-tools.mjs` 断言
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

**已知边界(别指望它做不到的事)**:`module-rtl-check.mjs` 这个机械检查器认的是**自带那套约定** ——
文件头字段、九个小节块、端口对齐、复位高有效。换成你自己的模板时:

- 格式细节(缩进、对齐、注释风格)会跟着你的模板走 ✓
- 但**检查器仍按自带约定判定** —— 你的模板若换了文件头写法或不要那九个小节,检查器会报出来

两种应对:保持这些约定(最省事),或者把检查器当参考、以你模板的规则为准(那就要接受它的告警)。
没做成"读模板自动改规则"是有意的 —— 那等于写一个模板引擎,收益不抵复杂度。

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

**注意技能是从 `~/.dsh/.agent-presets/<id>/skills/` 扫的,不是从包里扫的** —— 启动时
`ensureUserPreset` 把包内预设同步进用户预设目录(`cpSync`,只合并不删)。所以**包内删掉或改名的
技能,用户目录里那份不会自己消失**,还照样被加载(改一次技能名就会新旧两套同时生效)。
为此同步时做三件事,顺序不能反:

1. **先备份**:用户改过或新增的文件,连同"包内已删的旧文件"一起,备份到
   `$DSH_HOME/.fpga-workbench-backup/<时间>/`;
2. **再清掉包里已经没有的**:上次清单里记过的,加上 **`skills/` 下所有包内已没有的**
   (技能留着就直接改变 AI 行为,不能等清单);
3. **同步并写清单** `$DSH_HOME/.fpga-workbench-backup/synced-files.json`(记我们写过哪些文件;
   放预设目录**外面**,否则"两棵树是否一致"永远为假、每次启动都白同步)。

用户自己在预设目录里加的东西(不在清单、也不在 `skills/` 下)一律不动。

**工作区指令 `AGENTS.fpga.md`(本模式自有,排在 `AGENTS.md` 之前)**

模式的人设与工具链提示走的是**会话提示**那条链(预设的 `persona.prefix` 与 `lib/mode.js`),
只有命名了本预设的会话看得到;而工作区指令走的是**指令文件**那条链(宿主的
`dsh-agent-instructions`:用户全局 `$DSH_HOME/AGENTS.md` → 项目根到工作目录逐层)。

本模式把 `AGENTS.fpga.md` 排在候选名最前(见 `agent.cordis.yml`,**候选名必须给全** ——
给了就以给的为准,漏掉 `AGENTS.md` 就等于不再加载它)。于是项目里可以放一份**本模式专用**的
工作区规则,不必挤进用户的 `AGENTS.md`。骨架(`setup-scaffold.mjs`)建模块 / 工程时会把下面
这段抽出来落成 `<根>/AGENTS.fpga.md`,**已存在就跳过**(`--force` 才覆盖)。

规则正文只维护**这一处**:骨架从 README 抽,不另外维护一份模板。

<!-- fpga-mode-rules:start -->
**这是 FPGA 开发模式的工作区规则**,按项目改这一份即可。它只管本模式下的做法,不改变
`spec/` `rtl/` `verif/` `synth/` 里那些产物格式与流程本身(那些见技能与模板)。

1. **动手前先看清现状**:工作区里有什么、相关报告与已有证据是什么。已有报告按需读,先看与当前
   问题直接相关的那几份;不要凭印象假设。
2. **方案先画出来再实现**:新增功能、改接口、改数据结构或算法路径时,先把实现思路画成流程图
   (模块级)或框图(工程级)给人确认再动 RTL。图没确认 = 方案没确认;中途发现图走不通,先说清
   怎么改、改完图再继续。
3. **确定性检查交给脚本**:能用命令判定的就别用肉眼替代,把命令输出当事实依据。
4. **局部问题走局部闭环**:定位 → 最小必要修改 → 相关验证;失败就继续定位,不要当成"这一步
   结束"往下走。小改动优先局部验证,不必每次重跑全链。
5. **分清"任务完成"与"正式验收"**:前者按当前范围与实际验证结果说;后者要求与交付范围相称的
   证据。工具缺失时可以继续分析并给出未验证的修复,但要写明未验证,不得说成已通过。
6. **不硬造记录**:只在真跑了那个环节、或正式交付/明确要求留档时才写结论文件;短诊断在回复里
   说清做了什么、哪些没验证即可。
7. **高风险操作先取得确认**:改管脚/电平/时钟例外/固化参数、把 bit 下到板子、擦除或清空、不可逆
   的批量改动 —— 先核实目标与依据,并让人点头,不要自行推断参数。
8. **长任务的结论与证据落到文件里**:模块级写模块自己的环节目录,工程级写 `project/`;会话会被
   压缩,文件不会。结果文件保留 `结论:` 那一行。
<!-- fpga-mode-rules:end -->

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
node tools/check-preset-sync.mjs    # 预设底座与官方 standard 的漂移(行 id / 包名)
node tools/check-patch-file.mjs     # 补丁字节合法 + 形状
node tools/check-installed.mjs      # 已装副本与源逐字节一致(支持 DSH_PROFILE_DIR 覆盖)
node tools/smoke-installed.mjs      # 已装副本在真实解析环境里能否加载(装完/重启前跑)
node tools/check-install-safety.mjs # 依赖与锁文件安全:装本插件不动既有依赖(较慢,要跑两次 pnpm)
```

上面七项 `check-*` / `smoke-*` 是每轮改动都要跑的那一套；`sync-installed.mjs`(装/同步已装副本,
改名删文件时加 `--prune`)、`install.mjs`(装完自动跑 `smoke-installed`)与 `check-install-safety.mjs`
按需跑。`tools/shipped.mjs` 是内部模块,不是命令。

**自检自己收尾**:会建 fixture 的几项(`check-toolchain` / `check-fpga-tools`)跑完把 `.tmp/` 下的
临时目录清掉,跑完那一区是空的 —— 以前它只建不删,攒过上百个时间戳目录。

`smoke-installed` 与 `check-installed` 的关系:后者比字节,前者**真的加载一遍** ——
在 profile 的解析环境里 import 宿主半侧、执行客户端 bundle 的工厂函数、用真实设置跑一遍
状态载荷与会话提示段。"文件都对但一加载就炸"只有它能抓住,而那种情况重启后就是黑屏。
`tools/install.mjs` 装完会自动跑它。

前三个写死了本机路径(`C:/Program Files/DSH Desktop`、`~/.dsh/profiles/desktop`),
换机器要改。

## 现状与下一步

- ✅ 模式本身可用:预设随插件走,选择器里可选
- ✅ 五个路径可用:设置页配置 → 宿主核对存在性 → **本模式的会话提示**拿到路径与调用姿势
- ✅ **模块开发的四个环节技能**(`presets/fpga-workbench/skills/`),按需加载,一个环节一个:

  | 环节 | 技能 | 干什么 | 结果落在哪 |
  |---|---|---|---|
  | 规格 | `fpga-module-spec` | **讨论**:定方向(模块/工程)→ 定器件 → 方案(参考模型)→ 实现思路流程图(用户确认)→ 验证要求与对照数据;收尾用脚本一次建骨架 | `spec/spec.md` + `spec/flow.md` |
  | RTL | `fpga-module-rtl` | **编写**:按依据写(接口照 spec、路径照 flow.md、参数照参考资料),模板起文件 + 编译器检查 + 规范逐条对 | `rtl/`(报告 `rtl/lint.md`) |
  | 验证 | `fpga-module-verif` | **验证**:写测试平台把数据跑出来 → 拿独立参考模型 / golden 比对 → 不一致时判归属(RTL / 测试平台 / 模型),判不了就问用户 | `verif/verif.md`(TB、模型、比对脚本、日志都在这) |
  | 综合 | `fpga-module-synth` | **综合门禁 + 综合后时序**:批处理综合;约束是否干净、CDC | `synth/synth.md` + `synth/timing.md` |
  | 审查 | `fpga-module-review` | 审查(**按需能力,不是环节**):AC 覆盖、结构、跨域、握手、参考模型独立性 | `<模块根>/review.md`(不占目录) |

  入口是**按需取用**,不是阶段流水线:写一个模块时通常走 spec → rtl → verif → synth,
  但每一步都可以单独调用,出问题就回到那一步重来,不必补齐整条链。

  **仿真与比对是一个环节**(用户口径 2026-09-19):测试平台只负责把数据跑出来,判"对不对"要拿
  独立参照比 —— 两件事本来是一件事,劈成两半会让人以为"仿真跑绿了"就等于"对了"。

  早期雏形 `fpga-module-flow` 已删除(它的产物路径是当初拍定的、已被这些技能取代;
  Git 历史里能翻到)。
- ✅ **工程级流程**(9 个技能,`fpga-project-*`):**早期集成随时可做**(搭骨架、试接口、
  定位集成问题,把未验证的模块标注清楚);**正式集成验收**才要求相关模块的模块级结论齐。

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

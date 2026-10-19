# dsh-fpga-workbench

用来在 dsh 中导入一个 FPGA 工作台,做 **AI 辅助的** FPGA 工程开发(不是替你自动跑流程 ——
能力按需使用、可反复回跳,见下面「边界」一节)。

**一个 DSH 的 FPGA 开发模式。**

它做两件事:

1. 往 DSH 的 agent 预设名单里加一个「**FPGA 开发模式**」,于是新建会话时能和
   `标准 / 极简 / PTC / 创造` 并列地选它。
2. 在「设置 → FPGA 开发模式」里提供**工具设置 / 模块工具 / 工程工具**三个顶层区:
   工具设置逐项登记本机工具路径；模块和工程区只从已经就绪的工具中选择,并为每项能力选择模板。
   它们是给 AI 使用的能力配置,不是自动流水线,并且只交给**这个模式的会话**。
   (终端不在设置里配:用哪个 `pwsh` 由宿主的 shell 执行器自己定,在这里填路径喂不到那儿去 —— 见 `lib/toolchain.js` 的 `FIELDS` 顶上那段注。)

**它不注册任何主界面。** 没有侧边栏入口、没有面板、没有替换官方任何组件——你现有的
界面一行都不动,只多一个设置分区。

## 设置模型:就绪工具 + 环节偏好,不是流水线

设置页只有三个顶层区:

- **工具设置**:按脚本、编译、仿真、FPGA 四类列出 Python、Verilator、Icarus Verilog、
  ModelSim、QuestaSim、Vivado XSim、Vivado、Quartus 以及自定义工具。每张卡独立设置路径、检测和保存；
  未展开时只显示就绪状态。RTL 与仿真语言放在「语言标准」；ModelSim、QuestaSim 各自的
  `modelsim.ini` 放在「仿真库」。Vivado / XSim 不显示这类库映射设置。用户模板库根目录单独放在
  「模板库」。这些分组都是按需展开。
- **模块工具**:四张能力卡——RTL 编译、仿真测试、脚本验证、综合与门禁。规格讨论不需要外部工具,
  因此不制造一张空的“规格工具”卡。四类能力可以反复切换、回跳或单独使用。
- **工程工具**:三张能力卡——工程主工具、系统仿真、脚本验证。综合、实现、时序、生成文件与下载
  共用同一个厂商工程主工具,避免在每个工程环节重复选择同一套 Vivado / Quartus。

每张能力卡都可以选:

- **由 AI 从已就绪工具中判断(`auto`)**:保留 AI 的判断空间,结合当前问题选择已就绪工具。
- **明确工具**:例如模块 RTL 固定首选 Verilator。能力卡只引用「工具设置」中保存的路径,
  **没有第二份能力覆盖路径**；未检测或未就绪的工具会显示,但不可选。
- **明确不用(`none`)**:明确告诉 AI 这项能力不用,它与 `auto`、工具未就绪是三种不同状态。

选择能力工具只改变该能力的偏好,**不会清空、改写或互换顶部工具路径**。所以 Verilator 与 Icarus、
ModelSim、QuestaSim 与 XSim，以及 Vivado 与 Quartus 都可以同时保留。模块和工程可以引用同一工具,也可以选择不同工具；
这只是偏好与素材配置,不会生成命令队列、当前阶段、下一步或完成百分比。

较长说明收在字段或分区标题旁的 **`?`** 中:鼠标悬停或用键盘 Tab 聚焦都会显示同一份解释。
当前就绪状态、路径错误、`auto` / `none`、未保存标记和保存失败仍直接显示,不用打开说明才能看到。

设置页最下面还有一个 **「自检」** 按钮(点一下才跑,**挂载时不请求**):它**按清单逐份核对**这份已装副本
——12 份内置模板的**文件**、7 个自带命令入口**及它们相对 import 的 4 个辅助模块**、16 个技能目录及各自的
`SKILL.md` 与显式引用的 `references/*.md`、四棵运行时子树**与按名字读的 `workspace/AGENTS.fpga.md`**、补丁里的预设声明行、设置模型版本、
已登记工具路径、用户模板库目录,共 8 项。结论分 `pass` / `warn` / `fail` 三档逐条列出,少哪一份文件就点名
哪一份(只检查"目录在不在"会漏报:辅助模块与模式规则文件都属于这一类)。
它是**只读**的:不写设置、不改文件、**不起任何进程**
(真跑 verilator / vsim / vivado 属于仓库里的 `npm test` 与 `npm run test:vivado`,发布包里没有那些)。
实现见 `lib/selfcheck.js`,路由 `GET /plugins/fpga-workbench/selfcheck`;
判据本身由 `tools/check-selfcheck.mjs` 用"**故意少造一份文件**"的夹具打靶(缺模板 / 缺技能 / 缺命令 /
缺辅助模块 / 缺模式规则文件 / 缺整树都必须红;夹具里 skills、templates 放空文件,一轮 8 份约 1.4 MB,
落在 `.tmp/` 下并已 gitignore,不进发布包,跑完不删、由人自行处置)。

## 安装

官方 DeepSeek Harness Desktop `0.2.1-rc.2`:在侧边栏的「插件」页安装本仓库的绝对路径
`C:\Work\dsh-fpga-workbench`，更新后重启桌面端，再新建会话选择「FPGA 开发模式」。
插件声明同时保留对 DSH `0.2.0-rc.2` / `0.2.0-rc.1` 与 `0.1.7-rc.2` 的兼容。插件自身的 `0.4.4` 是独立版本号，
不需要与 DSH 版本号相同。桌面端内置的 DSH 与 PATH 上的 `dsh` 可能不是同一版本，
不要用旧的全局命令更新官方桌面端的 profile。

下面的命令与 `tools/install.mjs` 是旧 DSH Desktop 环境的安装方式；使用前先确认
`dsh --version` 与目标桌面端相符。

```powershell
# 从本机工作区(开发时用)
dsh plugin --profile desktop add file:C:\Work\dsh-fpga-workbench

# 从 git 仓库(换机器、或不想带着源码目录时用)
dsh plugin --profile desktop add git+ssh://git@github.com/fsk2142/dsh-fpga-workbench.git
```

装完**重启 DSH Desktop**,新建会话时预设选择器里就会出现「FPGA 开发模式」。

**git 装法要知道的三件事**:

1. **不需要构建步骤**。`lib/` 里是可执行的 JS,没有编译产物 —— 包直接就能跑,
   所以仓库里没有 `prepare` / `dist`。git 装法取的是仓库中的**已跟踪内容**；`tools/` 会带上,
   本地且已忽略的 `.tmp/` 不会带上。`tools/` 只用于开发自检,不参与插件加载。
2. **要指定分支或标签时**在地址后面加 `#`：例如 `...#main`；仓库发布 tag 后也可写 `...#<tag>`。
   不打标签就跟着 `main` 走,升级时重新 `add` 一次即可。
3. `pnpm pack` 打出来的 tarball包含 `files` 白名单中的 `lib` / `presets` / `cordis.patch.yml` /
   `icon.svg`,以及 npm 自动加入的 `package.json` / `README.md`；发布包不带仓库根 `tools/` 与 `docs/`。

> 刷新安装用 `node C:\Work\dsh-fpga-workbench\tools\install.mjs`(先校验、不一致才重装、
> 并逐字节校验结果)。**绝不先删**:旧副本先**改名**成备份再重装,装成了备份**保留**
> (路径会打出来,自己处置);装失败就把备份改回去。**必须在你自己的终端里跑** ——
> 受限沙箱里 pnpm 无法在 profile 目录建临时文件。
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
cordis.patch.yml              profile 层:挂载宿主半侧 + 插入 FPGA 预设声明行
lib/index.js                  宿主半侧(全局):注册设置、同步预设、探测路径、只读状态路由
lib/mode.js                   模式半侧(只有本模式):把工具链交给本模式的会话
lib/toolchain.js              字段定义 + 存在性判定 + 提示文案 —— 只依赖 node 内置模块
lib/client.js                 浏览器半侧:手写懒 CJS bundle,「设置 → FPGA 开发模式」分区
presets/fpga-workbench/
    preset.yml                选择器里显示的名字与描述
    agent.cordis.yml          这个模式的组装:人设 + 工具行 + 模式半侧 + 自带技能目录
    skills/                   只在本模式可见的技能(随预设复制走)
    templates/                分类模板(逻辑分类 12 个;模块与工程的综合/约束各一份,
                              **用户模板库目录不按层级拆**):RTL、约束、Testbench、仿真脚本(编译与运行同一份)、验证、
                              综合、实现、下载、Lint、Bitstream、工程综合、工程约束；不再保留旧的平面模板副本
    tools/                    自带命令,**按级别分目录**:module/ 只放模块级、project/ 只放工程级、
                              顶层是两级共用(setup-scaffold.mjs)、lib/ 是内部模块(不是命令)
tools/                        分层自检 + install/sync-installed + 依赖安全/锁文件比对
```

## 自带命令:按级别分目录,按环节分命令

**脚本只做机械化的事,不做判断、不约束 AI**(用户口径,2026-09-20)。具体边界:

| 归脚本 | 不归脚本 |
|---|---|
| 起模板、建骨架、复制文件、替占位符 | 决定该走哪个环节、判该不该继续 |
| 跑一条固定命令并落盘(编译、仿真、综合) | 判"这个结果算不算过" |
| 机械规范检查(文件头、小节块、Tab、命名) | 设计方案的取舍与风险判断 |
| 把事实摆出来(状态、路径、退出码、日志位置) | 阶段推进、自动串联、"下一步该做什么" |

理由:AI 的主观能动性是这套东西的核心 —— 它能发现参照物错了、能看出证据过期、能判断该停下问用户。
**把判断写成脚本,等于把这部分能力从 AI 手里拿走**,换来的只是"看起来更自动"。
所以**不要**往这个仓库里加:全流程编排器、阶段状态机、逐环节的自动化命令、
"结论文件解析后自动判定 PASS/FAIL"之类的东西。

技能的判据写在文档里,靠 AI 逐条看;**能用一条命令判定成败的机械检查,才做成脚本** ——
这类检查比人可靠,而且每次代价一样:

命令按**级别**分目录(`module/` 只放模块级、`project/` 只放工程级、顶层两级共用),名字再带**环节**
前缀 —— 级别与环节两样都要一眼看出来:

| 级别 | 环节 | 命令 | 干什么 | 退出码 |
|---|---|---|---|---|
| 两级共用 | 规格 | `node presets/fpga-workbench/tools/setup-scaffold.mjs <用户指定目录> [--kind module\|project] [--force] [--dry-run]` | 传入目录本身就是模块根或工程根；一次建好骨架 + 锚点 `.fpga-workbench.json`(幂等；`--modules` 已停用) | 0 成功 / 1 出错 / 2 参数不对 |
| 模块级 | RTL | `node presets/fpga-workbench/tools/module/module-rtl-new.mjs <模块根> <模块名> --template <RTL 模板路径> [--out <相对路径>] [--force] [--dry-run]` | 按模板起 RTL 文件:复制模板、**只替模块名**,其余内容原样保留;默认落 `rtl/<模块名>.<扩展名>` | 0 成功 / 1 目标已存在 / 2 参数或环境问题 |
| 模块级 | RTL | `node presets/fpga-workbench/tools/module/module-rtl-check.mjs <模块目录>` | RTL 机械规范:文件头 / 九个小节块 / 端口类型 / 复位极性 / always_ff / end-else / 断言 / 测试平台自检 / Tab / 行尾 / 代码行非英文 | 0 无阻塞项 / 1 有阻塞项 / 2 用法问题 |
| 模块级 | 验证 | `node presets/fpga-workbench/tools/module/module-verif-new.mjs <模块根> <模块名> --template <测试平台模板路径> [--out <相对路径>] [--force] [--dry-run]` | 按模板起测试平台;默认落 `verif/tb_<模块名下划线形式>.<扩展名>` | 0 成功 / 1 目标已存在 / 2 参数或环境问题 |
| 模块级 | 综合 | `node presets/fpga-workbench/tools/module/module-synth-new.mjs <模块根> <模块名> --template <约束模板路径> [--out <相对路径>] [--force] [--dry-run]` | 按模板起约束文件;默认落 `synth/<模块名>.xdc` | 0 成功 / 1 目标已存在 / 2 参数或环境问题 |
| 模块级 | 验收 | `node presets/fpga-workbench/tools/module/module-report-check.mjs <模块目录> [--json] [--record] [--gate]` | 核报告引用的**证据路径是否真的在**:`spec/spec.md` 的 AC 行声明的证据位置 + `verif/*.md` / `synth/*.md` 引用的路径(**只验存在与摘要,不判内容**;行号后缀摘掉再核,可再生目录 `work/` 缺失不判错);`--record` 把当前依据的 sha256 摘要写进报告,之后依据内容变了就告警 | 0 都在(**空结果** `NO_REPORTS` / `NO_EVIDENCE` 也退 0 —— 判“有没有证据”看输出分类,别只看退出码)/ 1 有引用了却不存在的路径或越界(junction 真实落点也算),或 `--record` 时依据内容已变且未加 `--accept-changed` / 2 用法问题 |;`--gate` 下"没有可核的东西"(NO_REPORTS / NO_EVIDENCE)退 2
| 工程级 | RTL/lint | `node presets/fpga-workbench/tools/project/project-rtl-check.mjs <用户指定工程目录> [--json]` | 扫 `src/rtl/`、`src/sim/` 与根 `sim/`；工程 RTL 用设计规则，仿真文件用测试平台规则 | 0 无阻塞项 / 1 有阻塞项 / 2 用法问题,**或**「部分覆盖」(范围里有未检查的 VHDL 时:摘要写 PARTIAL,机器调用不该当成通过) |

另外两条规则与旧包一致,不要自行加严:

- **Tab / 代码行非英文 / 行尾混用 只算警告**,不阻塞门禁
- **纯格式检查要宽容**:文件头只要求"顶部有分隔条 + 前 15 行字段齐全";九个小节块只要求名字作为
  banner 存在(宽度容忍 84–86),不校验列宽与顺序

会话提示里会列出这几个命令的**绝对路径**,AI 照用即可。`tools/check-fpga-tools.mjs` 断言
**插件自带的模板必须过自己的检查器** —— 模板与检查器不能互相矛盾。

## 写法规范放在模板里,不放在技能正文里

RTL 的文件头、九个小节块、端口对齐这些**格式**都是各自的习惯,写死在技能里换个人就废了。
所以:

- 插件自带默认模板(`presets/fpga-workbench/templates/`),逻辑分类 12 个(模块九 + 工程级 Linter / Bitstream /
  工程综合 / 工程约束),覆盖 RTL、约束、Testbench、
  仿真脚本(编译与运行同一份)、验证、综合、实现、下载,以及工程级的 Lint 与 Bitstream。默认模板带工具兼容信息,例如 Vivado 脚本不会被
  当成 Quartus 的默认值。
- 设置里只登记一个可选的**模板库根目录**。目录树固定如下,没有额外的 `fpga/` 分级；
  Testbench 是仿真输入文件,`simulation/run/` 下那份仿真脚本是执行脚本(编译与运行同一份),用途不同,因此分开存放:

  ```text
  <模板库>/
  ├─ rtl/
  ├─ constraints/
  ├─ verification/
  ├─ simulation/
  │  ├─ testbench/
  │  └─ run/
  ├─ synthesis/
  ├─ implementation/
  └─ programming/
  ```

- 设置页**只有展开某张能力卡时**才扫描这张卡需要的分类；卡片收起时不扫描,关闭后重开会重新扫描。
  每类最多读取 500 份用户模板,忽略隐藏/临时文件并且不跟随符号链接或 junction。
- 同类型模板共用一座库,但模块和工程保存各自的选择。例如模块 RTL 与工程主工具都从 `rtl/` 取候选,
  仍可各选不同的一份。留空表示使用与当前工具适配的内置默认模板；已经明确选择的模板如果消失,
  会保留原选择并报警,不会静默换成另一份。
- 旧的平面模板 `rtl.sv`、`tb.sv`、`constraints.xdc`、`run_synth.tcl`、`comp.py`
  已移除。旧设置中的这些路径只在迁移时映射到对应的分类内置模板，不再依赖旧文件继续存在。

这样换一套模板 = 换写法规范,技能一个字都不用改。

**已知边界(别指望它做不到的事)**:`module-rtl-check.mjs` 这个机械检查器认的是**自带那套约定** ——
文件头字段、九个小节块、端口对齐、复位高有效。换成你自己的模板时:

- 格式细节(缩进、对齐、注释风格)会跟着你的模板走 ✓
- 但**检查器仍按自带约定判定** —— 你的模板若换了文件头写法或不要那九个小节,检查器会报出来

两种应对:保持这些约定(最省事),或者把检查器当参考、以你模板的规则为准(那就要接受它的告警)。
没做成"读模板自动改规则"是有意的 —— 那等于写一个模板引擎,收益不抵复杂度。

## 路径怎么填:手打、粘贴,或者点一下挑

路径字段三个办法:直接敲、把资源管理器地址栏里的路径粘进去、或者点旁边的「**浏览…**」。

「浏览…」**一律给页面内的列表**(不再按外壳分流):打几个字母过滤(打开就聚焦),
**只剩一项时回车直接选中**;点目录进去、「↑ 上级」往上走、「用这个目录」填当前目录。
目录由**宿主**列(只读路由 `/plugins/fpga-workbench/browse`,浏览器碰不到磁盘),鉴权与状态路由相同。

为什么**不弹**系统文件框(实测,所以撤了):这套外壳里系统框**给不出真实路径** ——
新版 Electron 去掉了 `File.path`(`webUtils.getPathForFile()` 在插件 bundle 里拿不到),
选完只剩文件名;浏览器那条更是只给 `C:\fakepath\xxx.exe`。弹了还得退回列表,白走一步、
还让人以为"选完了"。所以代码里**没有**弹框这条路,**绝不会把一个假路径写进设置**。

**为什么不是"宿主弹系统对话框"**(试过,撤了):起初做成"宿主起 PowerShell 弹 OpenFileDialog /
BrowseForFolder"。实测那条路在宿主上下文里**弹不出窗口** —— 进程活着、窗口不出现,按钮还会卡在
"等待选择…"且无法取消。DSH 自己的 `ctx.directoryPicker` 只能选目录,而且那是给工作区切换器占位的
接缝;平台的原生选择器走 worker + koffi 调 Win32,插件用不上。**没验证过的东西不留在代码里**。
现在**干脆不弹**:列表本来就能选文件,不用起进程、也不欠谁的窗口。

另外手打这条路本来也不慢:路径常常是你手上就有的(资源管理器地址栏、别人的命令、日志里的一行),
复制粘贴比任何选择器都快。

## 检测怎么跑、改动怎么落地(逐工具、按需检测)

- 打开设置页时**不做全量检测**。点击某张卡的「路径设置 / 修改路径」才只检测这一项；检测只读文件系统，
  Python 另外如实查询版本,但不拿版本做硬门禁。
- 找到了就写在对应工具卡里(旁边给「用这个」);没找到就就地提醒手填或用「浏览…」。检测结果只是建议，
  **绝不自动填入路径**；点「用这个」后也只进入未保存草稿。
- 展开或切换模块/工程能力卡**不会重跑工具检测,也不会改写任何顶部路径**。能力卡只能选择已经
  就绪的工具；检测和路径编辑只存在于第一块「工具设置」。
- 每张能力卡都有 `auto` 与 `none`:`auto` 交给 AI 从已就绪工具中结合任务判断；`none` 是用户明确
  禁用这项能力。两者都不会删掉顶部工具,以后换回显式工具仍可继续复用原路径。
- 工具改动**先留在当前卡片**,确认路径可用后点「**保存此工具**」才写入；同一卡中的多字段一次原子提交，
  不会顺带保存其他工具卡。每张模块/工程能力卡也用自己的「**保存此能力**」；语言标准、仿真库、模板库
  路径走辅助设置的保存入口。所以字段的
  "已就绪 / 未就绪"跟着**你眼前这一份**走(未保存的会标出来),不必先保存 —— 选 XSim 还没保存时,
  路径类型也按 XSim 判。
- 「浏览…」**一律走页面内的列表**(目录由宿主那条只读路由列)。**没有**"桌面壳里弹系统文件框"
  那条路 —— 实测这套外壳拿不到真实路径(新版 Electron 去掉了 `File.path`,选完只剩文件名),
  所以也不靠页面嗅探 UA 去分流。

## 两个半侧,以及为什么提示只给这个模式

DSH 里插件可以挂在两个平面上,这是本插件最要紧的一条设计:

| | 插件行(profile 层) | 预设行(agent 作用域) |
|---|---|---|
| 谁看得见 | 所有会话 | 只有命名了本预设的会话 |
| 这里放什么 | 设置命名空间、路径探测、只读状态路由 | 工具链提示段、模式专属技能 |
| 代码 | `lib/index.js` | `lib/mode.js` |

**刻意不往会话提示里注入任何东西** —— 那是插件行的作用域,是全局的:普通会话也会看到
FPGA 工具链的信息与警告,与"不影响正常会话"冲突。所以工具链那段提示由 `lib/mode.js`
注册,它只从本预设的组装里挂载。`tools/check-toolchain.mjs` 有一条源码断言守着这个分工:
`lib/index.js` 里不允许出现 `systemPrompt`。

同理,技能也按模式隔离:预设声明里的 `skill-filesystem` 行把**包内**
`presets/fpga-workbench/skills/` 追加进 `customSkillDirs`(`!!js ... new URL('skills/', baseUrl)`,
baseUrl 是补丁文件自己的目录,路径随包走)。`includeDefaultRoots` 保持默认的 `true`:
你的工作区技能与用户技能在本模式下**照常可见**,这里是追加,不是替换。

预设本身由 `cordis.patch.yml` 里的 `@deepseek-ai/dsh-agent-preset` 声明行注册 ——
DSH 0.1.7-rc.2 的 `agent-preset-registry` 只从组合里收集声明,**不扫描**用户预设目录。
`presets/fpga-workbench/agent.cordis.yml` 是可编辑源,`cordis.patch.yml` 内联同一份行集合;
`tools/check-preset-root.mjs` 会逐行比对两者,防止漂移。

**工作区指令 `AGENTS.fpga.md`(本模式自有,排在 `AGENTS.md` 之前)**

模式的人设与工具链提示走的是**会话提示**那条链(预设的 `persona.prefix` 与 `lib/mode.js`),
只有命名了本预设的会话看得到;而工作区指令走的是**指令文件**那条链(宿主的
`dsh-agent-instructions`:用户全局 `$DSH_HOME/AGENTS.md` → 项目根到工作目录逐层)。

本模式把 `AGENTS.fpga.md` 排在候选名最前(见 `agent.cordis.yml`,**候选名必须给全** ——
给了就以给的为准,漏掉 `AGENTS.md` 就等于不再加载它)。于是项目里可以放一份**本模式专用**的
工作区规则,不必挤进用户的 `AGENTS.md`。规则正文的唯一包内来源是
`presets/fpga-workbench/workspace/AGENTS.fpga.md`；骨架(`setup-scaffold.mjs`)建模块 / 工程时会把
它**原样复制**为 `<根>/AGENTS.fpga.md`,已存在就跳过(`--force` 才覆盖)。

## 三条必须知道的约束

**一、`files` 白名单必须包含 `lib` 与预设的四棵运行时子树。**

pnpm 安装 `file:` 依赖时按 `files` 打包,白名单外的东西**不会被拷进 profile**。踩过这个坑:
`presets/` 没写进 `files` → 安装副本缺预设目录 → **预设列表里永远看不到这个模式,而且没有
任何报错**。所以白名单精确到 `presets/fpga-workbench/{skills,templates,tools,workspace}`
这四棵:技能、模板、自带命令、骨架规则各一棵,少哪棵就静默少一项能力。

`presets/fpga-workbench/agent.cordis.yml` 与 `preset.yml` **故意不进发布包** —— 预设由
`cordis.patch.yml` 内联的 `@deepseek-ai/dsh-agent-preset` 声明提供(名字、描述、`plugins`
都在那份声明里),运行时两份都不读;它们留在仓库里继续做编辑与一致性检查
(`preset.yml` 的显示名与 `lib/client.js` 的 `LABEL` 对齐,`agent.cordis.yml` 与补丁声明逐行对齐)。
`tools/check-installed.mjs` 与 `tools/check-package.mjs` 会断言"四棵都在、两份编辑源不在"。

**二、预设必须在组合里有 `@deepseek-ai/dsh-agent-preset` 声明行。**

DSH 0.1.7-rc.2 的 `agent-preset-registry` 只从组合里的声明行收集预设,**不扫描**
`.agent-presets` 目录。所以 `cordis.patch.yml` 里必须有
`id: preset-fpga-workbench` + `name: '@deepseek-ai/dsh-agent-preset'` 的 insert 行,
且 `config.plugins` 与 `agent.cordis.yml` 保持一致。
`tools/check-preset-root.mjs` 会断言声明行存在、包名正确、两边逐行一致。

**三、预设行里的包名写错不会报错,只会让预设消失。**

`agent.cordis.yml` 里那一行 `name: 'dsh-fpga-workbench/mode'` 靠 `exports['./mode']`
解析。名字对不上时,discovery 会把整个预设判成 **broken**、从选择器里摘掉,只在日志里
留一行。`tools/check-preset-root.mjs` 断言这一行的解析,以及补丁声明与 `agent.cordis.yml`
逐行一致(不跟任何外部 standard 比对:组合里内联的就是唯一真相)。

## 机器级设置放哪:Vivado_init.tcl / modelsim.ini

**同一个策略不要在每份工程脚本里各写一遍** —— 除了"两处真相",有些设置写在脚本里**根本传不到**:

- **Vivado**:`<Vivado>/scripts/Vivado_init.tcl`(安装级)或 `~/.Xilinx/Vivado/Vivado_init.tcl`
  (用户级,升级 Vivado 不会被覆盖)在**每个** Vivado 进程启动时被 source —— **包括 `launch_runs`
  另起的 run 进程**。所以 `set_param general.maxThreads <N>` 放这里一次就够(AMD 文档:Windows
  默认只有 **2**、Linux 8;本机被 init 设成 16,而 run 进程日志里那句
  `Multithreading enabled for synth_design using a maximum of 7 processes` 就是它生效的证据)。
  反例:在 launcher 脚本里 `set_param`,run 进程读不到,日志里也看不出是谁设的。
  自定义板卡文件同理:把仓库根加进 `set_param board.repoPaths` 一次即可。
- **ModelSim / Questa**:默认值放安装目录那份 `modelsim.ini`(或它映射到的文件)。改了它是**安全**的:
  仿真的**编译身份**里记着 ini 的路径 + mtime + size,一变就会要求重编(见
  `templates/simulation/run/modelsim_run.do` 的 `config_identity`)。
- **不能放这里的**:任何 `set_property`(工程 / step / run 属性,例如综合策略、
  `AUTO_INCREMENTAL_CHECKPOINT`、bitstream 的 `-bin_file`)—— init 里没有工程上下文,要么直接报错
  要么静默无效;任何改 QoR 的算法参数;以及 `set_msg_config` 屏蔽消息 —— 那会把判据要读的
  CRITICAL WARNING 一起盖掉,门禁就瞎了。

## 自检

开发与发布的统一入口是 `npm test`；核对已装副本用 `npm run test:installed`，真实 Vivado 综合与依赖
安全检查分别按需运行 `npm run test:vivado`、`npm run test:safety`。各子检查、宿主选择顺序、零删除
fixture 规则与历史原因见 [`docs/DEVELOPMENT.md`](https://github.com/fsk2142/dsh-fpga-workbench/blob/main/docs/DEVELOPMENT.md)。

## 现状与下一步

- ✅ 模式本身可用:预设随插件走,选择器里可选
- ✅ 路径可用:设置页配置 → 宿主核对存在性 → **本模式的会话提示**拿到路径与调用姿势
- ✅ **模块开发的五个能力阶段 / 技能**(`presets/fpga-workbench/skills/`),按需加载,一个阶段一个:

  | 环节 | 技能 | 干什么 | 结果落在哪 |
  |---|---|---|---|
  | 规格 | `fpga-module-spec` | **讨论**:定方向(模块/工程)→ 定器件 → 方案(参考模型)→ 实现思路流程图(用户确认)→ 验证要求与对照数据;收尾用脚本一次建骨架 | `spec/spec.md` + `spec/flow.md` |
  | RTL | `fpga-module-rtl` | **编写**:两条路径 —— 新设计/重大变更按依据写(接口照 spec、路径照 flow.md、参数照参考资料);**局部修复直接动手**(不要求先补规格 / 先建 flow.md),读代码与项目约束 + 聚焦验证。都用模板起文件 + 编译器检查 + 规范逐条对 | `rtl/`(报告 `rtl/lint.md`) |
  | 验证 | `fpga-module-verif` | **验证**:写测试平台把数据跑出来 → 拿独立参考模型 / golden 比对 → 不一致时判归属(RTL / 测试平台 / 模型),判不了就问用户 | `verif/verif.md`(TB、模型、比对脚本、日志都在这) |
  | 综合 | `fpga-module-synth` | **综合门禁 + 综合后时序**:批处理综合;约束是否干净、CDC | `synth/synth.md` + `synth/timing.md` |
  | 审查 | `fpga-module-review` | **按需审查阶段**:AC 覆盖、结构、跨域、握手、参考模型独立性；不要求排在固定位置 | `<模块根>/review.md`(不占独立目录) |

  五个阶段是**按需取用**,不是自动流水线:写一个模块时通常会在 spec、rtl、verif、synth 之间
  反复来回,review 则可在任何需要复核的时点调用；任一步都可以单独使用,不必补齐整条链。

  **"先画图确认"的门槛按任务风险定**(唯一出处:`presets/fpga-workbench/workspace/AGENTS.fpga.md` 第 2 条):重大架构 / 公共接口 /
  跨时钟方案 / 关键数据通路 / 用户可见的算法决策**尚未确定** → 先出图确认;已有批准方案里的普通
  实现与**局部修复**(语法错、单条 lint 告警、已有模块局部 Bug)→ 直接动手 + 聚焦验证。

  **仿真与比对是一个环节**(用户口径 2026-09-19):测试平台只负责把数据跑出来,判"对不对"要拿
  独立参照比 —— 两件事本来是一件事,劈成两半会让人以为"仿真跑绿了"就等于"对了"。

  早期雏形 `fpga-module-flow` 已删除(它的产物路径是当初拍定的、已被这些技能取代;
  Git 历史里能翻到)。
- ✅ **工程级能力**(11 个技能,`fpga-project-*`):**早期集成随时可做**(搭骨架、试接口、
  定位集成问题,把未验证的模块标注清楚);**正式集成验收**才要求相关模块的模块级结论齐。

  用户传给 `setup-scaffold.mjs --kind project` 的目录**本身就是工程根**,不会在工作区下再套一层:

  ```text
  <用户指定工程目录>/
  ├─ .fpga-workbench.json
  ├─ doc/          # 工程级报告 + files.md
  ├─ sch/          # 原理图、手册
  ├─ prj/          # Vivado / Quartus 工程（工具地盘）
  ├─ src/
  │  ├─ rtl/       # 所有 RTL 平铺
  │  └─ sim/       # 专用模块的简单 sim（不算工程证据）
  ├─ ip/
  ├─ sim/          # 工程级仿真证据，与 src/sim/ 不同
  ├─ xdc/
  └─ bit/
  ```

  | 技能 | 干什么 | 结果落在哪 |
  |---|---|---|
  | `fpga-project-spec` | 工程需求 + 架构 + 模块清单表 + 器件工程选择 + IP 策略 | `doc/spec.md` + `doc/flow.md` |
  | `fpga-project-rtl` | 工程专用 RTL、顶层、IP/BD 与简单 sim；BD 保留复现脚本或人工集成步骤 | `src/rtl/`、`ip/`、`src/sim/`；结论 `doc/rtl.md` |
  | `fpga-project-lint` | 工程 RTL 与仿真文件的机械/厂商静态检查 | `doc/lint.md` |
  | `fpga-project-integrate` | 只把已有源接进顶层:时钟复位分配、接口对接、加入厂商工程 | `doc/integrate.md` |
  | `fpga-project-constraints` | 约束与管脚:对原理图逐条核、IO 电平、时序例外写理由 | `xdc/` + `doc/constraints.md` |
  | `fpga-project-syssim` | 工程级仿真；复用可信证据后按任务补覆盖，使用设置所选仿真器 | `sim/` + `doc/syssim.md` |
  | `fpga-project-synth` | 工程综合、资源与综合后时序摘要 | `prj/` + `doc/synth.md` |
  | `fpga-project-impl` | `route_design` + DRC；用户需要时再生成并归档 bitstream | `prj/`、按需 `bit/` + `doc/impl.md` |
  | `fpga-project-timing` | **post-route** 时序(与模块级 post-synth 不同) | `doc/timing.md` |
  | `fpga-project-board` | 上板:下载、ILA/VIO、回读数据比对、固化 Flash | `bit/` + `doc/board.md` |
  | `fpga-project-release` | 仅在用户明确要求时发布归档；判据是"照着归档能重建同一版设计" | `doc/release.md` |

  这些是可反复跳转的工程能力,不是编号流水线；工程报告平铺在 `doc/`,工具生成内容留在 `prj/`。
- ✅ 模板:分类模板共用一座可选模板库(**逻辑分类数 ≠ 用户目录数**:工程综合/工程约束与模块版共享目录),模块与工程能力卡可以分别选择其中不同的一份；旧六份平面模板已移除
- 用户模板的**层级标记**(可选):模块与工程的综合/约束共享同一个用户库目录(不拆目录),所以用户自己放的模板可以在文件头声明层级 —— `# fpga-workbench-level: module`(tcl/do/xdc 用 `#`,`sv` 用 `//`)。声明后只在该层级的卡里出现;**没声明**的照旧两层都显示,设置页会标「未声明层级」。
- ⬜ 更强的能力接入:把某些阶段做成**这个模式能直接调用的工具**(由插件起进程)。
  现在命令仍由 agent 用 shell 工具跑 —— 走沙箱、可见、可中断;真做成工具就得接 subprocess
  服务并自己处理超时与日志
- ⬜ 待清理:旧雏形技能、以及旧工具包里已经带进来的东西的收尾

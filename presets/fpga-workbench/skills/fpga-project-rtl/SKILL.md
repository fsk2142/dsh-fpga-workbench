---
name: fpga-project-rtl
description: 编写工程缺少的专用 RTL、顶层、IP/BD 或简单 tb 时用;可复用模块只从库拷入。
---

# project-rtl:工程内 RTL 编写

**本技能只服务工程内的专用代码**(含顶层)。可复用模块**不在这里写** ——
要么库里已有拷进来,要么停下来等人工走 `fpga-module-*` 完整流程,写完再拷。

| 谁的事 | 哪里写 |
|---|---|
| 工程内专用模块 | **本技能** → `src/rtl/` + `src/sim/tb_*` |
| 顶层 | **本技能** → `src/rtl/`(不要求简单自测) |
| 可复用模块 | `fpga-module-rtl` 等(在**模块库**里);工程里只拷入 |
| 接进顶层、核对接口 | `fpga-project-integrate` |

目录树见 `fpga-project-spec`。**不写模块需求文档**;接口以 `doc/spec.md` 清单表 + 框图 + RTL 为准。

## 自由度(本技能与模块级的最大差别)

**在接口与系统约束内,怎么实现由你定**:

- 微架构、状态机、流水级数、编码方式 —— 按你对需求的理解写,不套固定结构
- **需要 IP 就自己建**(厂商 IP / 原语 / XPM / 自写核均可),不必先请示「用不用 IP」
- **复杂 IP 不会写就先看例程**:打不开思路时直接打开该 IP 的**参考例程 / 厂商自带参考工程**照着接;
  **没有参考例程就去搜开源实现**作参照。例程只当老师,接口仍以 `doc/spec.md` 为准,不要整包照抄了事
- **需要 Block Design 就自己搭**(Vivado BD / 自己写的子系统均可),同时留下可复现步骤与集成状态
- 拆不拆文件、分几个子模块 —— 按功能块判,不为「模块化」硬拆
- **有问题随时问用户**(器件能力、资源预算、协议细节、拿不准的取舍)——问清再写,
  不要猜关键参数后硬做

**不能动的只有这些**:清单表里的**对外接口**、spec 的**时钟/复位约定**、模板的**写法格式**。
要改接口或约定 → 先回 `doc/spec.md` 改并让用户确认,再动手。

其余工程技能按需并列或回跳,见 `fpga-project-spec`。

## 前置

1. `doc/spec.md` 有模块清单表,专用模块的**职责 / 接口(短)** 已和用户确认
2. 时钟目标、复位约定在 spec 固定小节
3. 写之前读:`doc/flow.md`、模板(见会话开头模板路径)、`sch/` 里相关的部分
4. 不清楚就问用户 —— 这是本技能的默认动作,不是最后手段

## 格式照模板(从模块级同一条口径)

**模板已经定好的不要再另立一套**:文件头字段、开头/结尾那些指令、端口声明与对齐、
`end else begin` 同行、九个小节 banner 及其排法 —— 起文件时带上模板即可,照模板写。
机械检查器按**插件自带那套约定**判;换了自定义模板、约定不一致时**以你的模板为准**,
检查器当参考,并在报告里说明差异。

模板定不了的,写的时候守住:

- **接口照 `doc/spec.md` 清单表 + `flow.md` 抄准**:端口名、方向、位宽、复位极性、时钟
- 复位与事件沿**以 `doc/spec.md` 固定小节为准**;要改极性/沿,先说明理由并**取得用户确认**
- `always_ff` 用 `posedge`(新代码照模板);已有约定以工程实际为准
- 每个 RTL 须有设计断言,并写明 Purpose / Trigger / Failure
- **一个 always 块内不混放不相关信号**(除非共用同一套控制逻辑)
- 占位符(`<DATE>` / `<Author>` 等)填实,`TODO` 换成真实逻辑
- 命名参考模块级习惯:`_r` = 寄存后的值;`_d` = 数据类暂存;新代码不用 `_q`

## 干什么

1. **看清还缺谁**:对照 `doc/spec.md` 清单表 + `src/` 现有文件,列出缺的专用 RTL/顶层
   (可复用缺件**不列进待写清单**,那是停下来报告的事)
2. **确定文件名**:全部 RTL 平铺到 `src/rtl/`;若文件名冲突,停下来请用户裁决,不得静默覆盖
3. **写 RTL**:文件名与模块名一致;撞名**停下问用户**。新建文件**按设置里选中的 RTL 模板**
   抄改到 `src/rtl/<模块名>.<扩展名>`(模板路径见会话提示的模板来源;**不要用 `module-rtl-new`**,
   那条默认落模块库的 `rtl/`,不是工程的 `src/rtl/`),或按模板结构手写 —— 以模板格式为准即可
4. **IP / Block Design**:按上面「自由度」自建。**一 IP 一目录**:`ip/<ip-name>/` 放 `.xci`、
   `.bd`、wrapper、`.coe` 等;**不要**把 `.xci` 平铺在 `ip/` 根下
   (时序卡按 `ip/<ip-name>/timing.json` 找)。自建单一 `.xci` IP 可只保留 `.xci`,工程里引用原文件。
   **Block Design** 可用 Vivado Tcl 或写清 GUI 步骤创建;保留 `.bd`、wrapper、器件与 Vivado 版本,
   并优先用 `write_bd_tcl` 把复现脚本放进 `prj/`。无法自动生成或连接时,在 `doc/rtl.md` 标记
   `manual integration required` 并列出操作。elaborate 由 `fpga-project-integrate` 执行并记录在
   `doc/integrate.md`;project-rtl 的 `PASS` 不以 elaborate 为条件。
5. **简单 sim**:`src/sim/tb_*.sv` 或 `tb_*.v`,**跑过一次**、确认没啥大问题即可
   —— **不算正式证据**;顶层不要求简单自测
6. **记清单**:新文件写进 `doc/files.md`(**位置 + 来源=手写**;IP 记来源=自建)
7. **能跑就跑机械检查**:
   - 工程内 RTL:`node "<自带命令目录>\project\project-rtl-check.mjs" <用户指定工程目录>`
     (扫 `src/rtl`、`src/sim`、根 `sim/`,并查根 `ip/` 的 IP 时序卡)
   - 工程级命令的参数就是用户指定工程目录；只有 `module-*` 命令才接模块根

### IP 时序卡:`ip/<ip>/timing.json`(每个 IP 一张)

厂商 IP 与 XPM 的时序前提要**量出来**:换实现、换配置、换器件时延迟与复位行为都可能变。
每个 `ip/<ip>/` 里留一张 `timing.json`(`card` / `measured` / `probe` / `config` 四栏 + 至少一个
实测数值;探针路径相对**工程根**)。量法与字段含义见 `fpga-module-rtl` 的「IP 时序卡」。
`project-rtl-check.mjs` 会检查工程根 `ip/` 下有没有这张卡、能不能复核 —— **缺了报警告,不拦门禁**。

写完要核对接口 / 再 elaborate → `fpga-project-integrate`,不要在本技能里重复集成。
**集成之后 `rtl` / `sim` / `constraints` 并列**,可随便跳转(见 `fpga-project-syssim`)。

## 本技能不做什么

- **不写**可复用/通用模块(停止并报告,见 `fpga-project-spec`)
- **不写**模块级 `spec/`、完整验证报告 —— 那是模块库里的 `fpga-module-*`
- **不跑**实现、约束、上板
- **不把结论写进 `src/`、`prj/` 或 `sim/`**；需要留档时统一写 `doc/rtl.md`

## 判据

- **PASS**:清单里本该由工程写的专用 RTL 与顶层都在位;接口与 `doc/spec.md` / `flow.md` 一致;
  格式与模板一致(或差异已说明);专用模块各有 `src/sim/tb_*` 且跑过一次(顶层除外);
  机械检查无阻塞项(或差异已说明);使用 BD 时文件、wrapper 与复现/人工步骤已记录
- **FAIL**:接口与 spec 不符、格式检查有阻塞项且说不清、文件名撞了却覆盖了
- **BLOCKED**:还缺可复用模块(等人工)、器件/协议等关键问题问了还没得到答复
- **UNVERIFIED**:RTL 写了但简单 sim / 检查没跑 —— 如实记,不要写成 PASS
- **NOT_APPLICABLE**:这次不写工程内 RTL

判定词含义见 `fpga-module-verif` 的**状态表**(唯一权威)。

## 产物

- RTL:`src/rtl/`、顶层 `src/rtl/`
- IP / BD / 初始化文件:**`ip/<ip-name>/`**(`.xci` `.bd` wrapper `.coe` + `timing.json`);
  BD 的 `write_bd_tcl` 或明确 GUI 步骤放 `prj/` / `doc/rtl.md`
- 简单 sim:`src/sim/tb_*`(顶层可不写)
- 要求留档时写 `doc/rtl.md`:结论(`PASS` / `FAIL` / `BLOCKED` / `UNVERIFIED` / `NOT_APPLICABLE`)
  + 缺谁写了谁 + IP/BD 自建了什么 + 复现或 `manual integration required` 步骤 + 跑过的命令 + 简单 sim 一次结果
- 同步 `doc/files.md`

## 必须停下来问用户的时候

- 文件名撞车
- 接口与 spec/框图对不上,或要改对外接口
- 关键参数拿不准(位宽、深度、协议时序、器件是否够用)
- 要把某个专用模块升级成可复用 —— 改 spec 清单,停到模块级流程

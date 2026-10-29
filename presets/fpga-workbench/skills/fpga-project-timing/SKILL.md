---
name: fpga-project-timing
description: 判断 FPGA 工程 post-route 时序、未约束路径或违例归属时用。
---

# project-timing:工程级时序

**一份已经存在的 post-route 报告随时可以读**(用户递过来、或 `prj/` 的 run 里就有),直接分析。
只有**正式判工程时序通过**时,才要求报告出自当前这版代码、约束是最终版。

结论写 **`doc/timing.md`**。

其余工程技能按需并列或回跳,见 `fpga-project-spec`。

## 前置

1. **读现有报告随时可以**,不必先跑实现
2. **正式判 PASS** 才要求:报告出自当前代码、`xdc/` 是最终版、器件与时钟目标清楚
3. 报告来自**布局布线后**(impl 的 run);没跑过 impl 就先跑,别拿综合后的估计当门禁

## 和模块级那一关的区别

| | 模块级(`fpga-module-synth` 里那段) | 本环节 |
|---|---|---|
| 报告来自 | 综合后估计 | **布局布线后** |
| 时钟来自 | 分析参考周期 | 板级真实约束(`xdc/`) |
| 能证明 | 大概能不能收敛 | **能不能上板跑** |

综合后摘要(`fpga-project-synth` 里先看的那一眼)只是预览;**到这里 WNS 才算数**。

## 判据

- **PASS**:每个时钟 `WNS ≥ 0`(满足用户目标,不是统一阈值);无未约束路径;
  无被静默跳过的约束;CDC 干净
- **FAIL**:有违例路径(给出最差几条:起点→终点→裕量)或时钟没约束上
- **BLOCKED**:实现没跑完 / 报告没生成 / `xdc/` 有问题
- **UNVERIFIED**:只读了部分或过期报告,不足以判定当前工程时序
- **NOT_APPLICABLE**:没有可分析的时序路径(如纯直通)

判定词含义见 `fpga-module-verif` 的**状态表**(唯一权威)。 *PASS* / *FAIL* / *BLOCKED* / *UNVERIFIED* / *NOT_APPLICABLE* 五个词,含义与用法以那张表为准。

### 三条硬门禁(2026-10-29 补)

这三条都是「工具不报错但上板会偶发失败」的形态,所以必须显式查,不能只看 WNS 绿。

### 先把数字抠出来(2026-10-29 新增)

```
node project-timing-report.mjs <报告文件或 prj/ 的 run 目录>
```

它从 `report_timing_summary` 的输出里抠出：WNS/TNS/WHS/THS/WPWS、时钟清单、
分析角（Slow/Fast 各自是否分析建立与保持）、`check_timing` 的 12 项。

**它不给结论** —— 时序过不过取决于这个设计的目标。工具有两个实际价值：

- `top_ddr3_rw` 那份 routed 报告有 **5.1 MB**，人打开会跳着看，
  而「未约束端点有几个」恰恰藏在中间某一段
- `check_timing` 那段**每个角各有一份**，人工容易只看第一份

拿到数字后，下面三条判据由你自己按工程实际情况执行。

**① 未约束的东西必须为 0**

`WNS ≥ 0` 只统计**被约束到**的路径。漏了一条 `create_clock`,那条路径根本不进时序分析 ——
报告照样全绿,但它可能跑在 1/3 的频率上。

**先纠正一个容易搞错的地方**（2026-10-29 实测）：`report_timing_summary` 的输出里
**没有一个叫 "Unconstrained Paths" 的段落**。真正反映这件事的是 `check_timing report`
那 12 项 —— 其中这几项才是「没被约束到」：

| check_timing 项 | 含义 | 要它为 0 |
|---|---|---|
| `unconstrained_internal_endpoints` | 内部端点没有任何时钟约束 | ✅ |
| `no_clock` | 有寄存器但没时钟 | ✅ |
| `no_input_delay` / `no_output_delay` | 端口没有输入/输出延迟 | 看设计目标 |
| `partial_input_delay` / `partial_output_delay` | 只约束了一部分 | 看设计目标 |
| `generated_clocks` | 衍生时钟没连到源 | ✅ |

取数两条路，选一条：

```
# 一、用本项目工具（推荐 —— 它会取各角最大值，人工容易只看第一份）
node project-timing-report.mjs <报告>

# 二、Vivado 里直接问
report_timing_summary -file timing_summary.rpt
# 然后在报告里找 "check_timing report" 段
```

**注意 `check_timing` 那段在报告里出现多次**（每个角一份）。只看第一份会漏 ——
某个角有 3 个未约束端点、另一个角是 0，真实情况是 3。

**`no_input_delay` / `no_output_delay` 要不要清零，取决于这个设计**：
LED、低速 GPIO、异步按键这类端口本来就没有建立保持要求；
接 SDRAM、以太网、高速总线的端口必须有。这一条**没有通用答案**，按工程判断。

**未约束路径的六类来源**（对着这张表逐个排除，比盲查快得多）：

| 来源 | 典型场景 | 约束方式 |
|---|---|---|
| 输入路径缺失 | 从输入端口到内部寄存器，端口没 `set_input_delay` | `set_input_delay` + `create_clock` |
| 输出路径缺失 | 从内部寄存器到输出端口，没 `set_output_delay` | `set_output_delay` |
| 衍生时钟 | 门控 / 分频产生的时钟没声明 | `create_generated_clock` |
| 异步复位 | 复位信号没做 `set_false_path` 或复位时序约束 | `set_false_path` 或 `set_max_delay` |
| 虚拟时钟 | 外部器件接口没建虚拟时钟模型 | `create_clock -name virt` |
| 纯组合路径 | 输入直通到输出的组合路径 | `set_max_delay` |

**② 四角（multi-corner）必须都过**

单角收敛不等于能跑。FPGA 的延迟随**工艺温度电压**变化，慢角（slow/高温/低压）
和快角（fast/低温/高压）都可能出问题：

- **慢角**：建立时间违例（逻辑太慢）
- **快角**：保持时间违例（逻辑太快，数据跑过头）—— 这个单角跑不出来

Vivado 默认就带四角（typical / slow / fast，各含温度电压组合），判据是
**每个角都 WNS ≥ 0 且 WHS ≥ 0**：

```tcl
# 看每个 corner 的结果，不只看默认那个
report_timing -max_paths 1 -delay_type max    ;# 建立
report_timing -max_paths 1 -delay_type min    ;# 保持
```

报告里四个 corner 的 WNS/WHS 都要 ≥ 0。**只报了一个角的数就是 `UNVERIFIED`**，
不是 PASS。

**③ CDC 必须逐条消账**

CDC 违例不能批量 waiver。每一条跨时钟域路径都要能回答：

| 问题 | 合格答案 |
|---|---|
| 它真的跨域吗 | 是 → 继续；否 → 为什么被工具判成跨域 |
| 用了什么同步手段 | 两级触发器 / 异步 FIFO / 握手 / 格雷码 |
| 同步器本身抗亚稳吗 | 同步级数够（一般 2 级，高频要 3 级）、`ASYNC_REG` 属性加了吗 |
| 数据总线怎么保证 | 总线必须**整体同步**或走异步 FIFO，不能每 bit 各自打两拍 |

判定：CDC 工具报告里每条违例都有**具体归属**（确认安全 / 已修 / 有理由的例外），
不能出现「未审」状态。批量 waiver 等于没做。

## 不收敛怎么办

按顺序判断,**不得一上来就改约束**:

1. **看最差那几条**:跨时钟、组合过长、还是扇出大
2. **设计问题还是约束问题**:漏约束/时钟写错 → 改 `xdc/`;层级太深 → 改设计(流水/拆逻辑/加寄存器)
3. **确实要加例外**:写清理由与谁确认 —— 例外是"这里不必按常规收敛",不是"让报告变绿"

**绝不得为变绿放宽约束。**

## 已收敛:满足了再提高一些

与 `fpga-project-synth` 同一口径:

- 满足要求且**仍有裕量** → 在**仍满足要求**的前提下再提高一些(提目标频率、减逻辑级、继续优化)
- 每压一次回到报告看一眼,**底线是始终满足要求**
- 改时钟目标 → 先改 `doc/spec.md` 并**经用户确认**,不得默默提频
- 裕量很大要不要提,可问用户;不要自作主张改系统目标

## 本环节要跑的命令

报告已有就直接读;要自己跑时在 impl 后的工程里(有 `mcp__vivado__*` 就走 MCP,用法见 `fpga-project-synth` 技能里的 MCP 与批处理一节):

```tcl
report_timing_summary -file <报告路径>
report_timing -max_paths 20 -sort_by slack -file <违例明细路径>
report_clock_interaction -file <时钟交互路径>
report_cdc -file <跨域报告路径>
```

- 只看最差几条,不必逐条罗列
- 命令原文记入 `doc/timing.md`;报告可留在 run 目录,结论写进 `doc/`

## 产物

写 `<用户指定工程目录>/doc/timing.md`:

- 结论(`PASS` / `FAIL` / `BLOCKED` / `UNVERIFIED` / `NOT_APPLICABLE`)+ 报告文件完整路径
- 时钟清单:名字、周期、WNS、是否约束上
- 未约束路径计数
- 最差几条违例简表(起点/终点/裕量/时钟域)
- 例外与理由
- **若做了"再提高一些"**:改了什么、新裕量多少、是否仍满足
- 实测最高频率(如果测了):事实,不是门禁

## 出问题往哪跳

| 现象 | 去哪 |
|---|---|
| 路径太长 / 要插流水 | `fpga-project-rtl` |
| 约束/例外/管脚 | `fpga-project-constraints` |
| 综合结构导致难收 | `fpga-project-synth` / `fpga-project-rtl` |

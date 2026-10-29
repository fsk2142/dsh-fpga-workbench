---
name: fpga-project-board
description: 把 bit/ 中与当前代码对应的 bitstream 下载到板卡验证或固化 Flash 时用。
---

# project-board:上板验证

工程一般都要走到上板(除工程根本不部署到硬件)。但**上板是直接操作硬件的动作**:

- **不自行启动**:用户没说要上板,不得因为"该收尾了"就去连板子
- **动手前核实并请用户确认**:器件/编程器、**`bit/` 归档那份**是否对应当前代码、
  `doc/constraints.md` 管脚与电平是否已核过
- **固化(写 Flash)不可逆**:参数必须经用户确认,不得自行推断
- 板子不在手边就做别的;**不得声称上板通过**

| 东西 | 在哪 |
|---|---|
| bit / ltx | **`bit/`** |
| 原理图 | `sch/` |
| 结论 | `doc/board.md` |

其余工程技能按需并列或回跳,见 `fpga-project-spec`。

## 前置(不满足不得上板)

**软件侧四项**:

1. **`doc/syssim.md` 是 PASS**(仿真验证已通过):**硬门槛**,见下节
2. `doc/timing.md` 是 PASS:时序没过,现象不可信
3. `doc/constraints.md` 管脚逐条核过(`sch/` 原理图),错了会损伤板子
4. 有 bit(**`bit/` 归档**,见 `doc/impl.md`),且与当前代码对应

**硬件侧四项**(每次上板前都要做,不是首次做完就算):

1. **板子在线探测**:hw_server / JTAG chain 能枚举到目标器件
2. **型号核对**:读到的 `IDCODE` / 器件型号要与 `doc/spec.md` 的 part **完全一致**
3. **只允许 JTAG 在线加载**:不写 Flash(固化另走「固化到 Flash」一节),不覆盖既有配置
4. **bit 是最新且匹配**:bit 的生成时间晚于最后一次 RTL/约束改动;bit 的器件与目标板一致

### 四项硬件前置怎么做

| 检查 | 怎么做 | 不通过时 |
|---|---|---|
| **在线探测** | `open_hw_manager` → `connect_hw_server` → `get_hw_targets`,能看到目标 | **停** —— 板子没上电、线没插、驱动没装 |
| **型号核对** | `get_property PART <device>` 或读 `IDCODE`,与 `doc/spec.md` 的 part 比对 | **停** —— 型号不符说明拿错板子或 bit 是别的器件的 |
| **JTAG 在线加载** | `program_hw_devices`(只写器件,**不写 Flash**) | 若误用了 Flash 流程,可能覆盖出厂/既有配置 |
| **bit 新鲜度** | `bit/` 的文件时间 vs `src/rtl/` `xdc/` 最新改动时间 | **停** —— 拿旧 bit 上板,测的是旧设计 |

**为什么这四项是硬性的**:

- **型号不符会烧板**:`xc7a100t` 的 bit 下到 `xc7a35t` 上,配置逻辑完全不同,可能损伤器件
- **旧 bit 上的调试全部作废**:现象对不上代码,定位会一直绕圈
- **Flash 是持久化的**:误写会覆盖设备原有配置,恢复要专用工具

**命令原文记入 `doc/board.md`** —— 尤其是探测结果与读到的 IDCODE/part,那是「这次上的是这块板子」的证据。

### 仿真没通过,不许上板

**上板前必须确认仿真验证通过。** 不是「大概对」「应该行」:
是 `doc/syssim.md` 里的结论为 `PASS`(工程级联仿)且模块级结论齐。

| 情况 | 能不能上板 |
|---|---|
| 联仿 PASS + 时序 PASS + 管脚核过 + 硬件四项过 | ✅ 可以 |
| 联仿 `UNVERIFIED`(没跑完/覆盖不足) | ❌ **先补仿真** |
| 联仿 `FAIL` | ❌ **先修问题** |
| 时序 `FAIL` | ❌ 先收时序 |
| 管脚未核 | ❌ 先核管脚(会损伤硬件) |
| **硬件四项任一不过** | ❌ **停,先解决硬件侧** |

**为什么必须先仿真**:上板调试的成本是仿真的几十倍:没有信号可见性,只能靠改代码、
重新综合、下载,用二分法逼近。**仿真能做的不留到板子上做。**

### 出了问题:先复现,再改,再上板

**不允许不停地上板试找问题。** 每次上板都要满足:

```text
上板发现问题
   ↓
在仿真里复现（必须,否则不知道改得对不对）
   ↓
定位归属：RTL / 测试平台 / 约束 / 实物接线
   ↓
修 —— 修完补测（覆盖率要够，不能只试那一个用例）
   ↓
仿真验证通过
   ↓
才允许二次上板
```

| 阶段 | 要求 |
|---|---|
| **复现** | 在仿真里造出同样的现象;造不出来说明理解还没到,继续查,别急着上板 |
| **定位** | 判断归属(见 `fpga-module-verif` 的差异归属),不要瞎改 |
| **修 + 补测** | 不只是修那一处;补上能覆盖这类问题的用例,**看覆盖率是否够** |
| **回归** | 仿真重跑,原有用例不能倒退 |
| **二次上板** | 只有前面都过了才上 |

**「再烧一次试试」不是调试方法。** 上板次数要能说清每次为什么 ——
说不清就说明还没在桌面侧想明白。

**允许的例外**:只在硬件上才出现的现象(时序裕量、电源、温度、器件特性)。
这类要**先缩小范围**(用 ILA/VIO 抓到具体信号),再判断能否在仿真里构造 ——
**不能构造的要在 `doc/board.md` 写清为什么**,并记录当时抓到的证据。

### 上板前必须过的三项机器检查

这三项都是「仿真里根本看不到、上板才发现」的形态，而且前两项会**损伤硬件**。

**① 引脚与 IO 机器比对(不是人工看)**

```
node project-pin-audit.mjs <工程根> --expect <板级引脚表.csv|.xdc>
```

人工核 200 个引脚必错。脚本逐项比 `PACKAGE_PIN` / `IOSTANDARD` / `DRIVE` / `PULLTYPE`，
并查引脚重复占用。**电平标准不一致是阻塞项**：`LVCMOS18` 配成 `LVCMOS33`
可能把 3.3V 灌进 1.8V 的 bank，直接损伤器件。

期望表两种来源都支持：结构化 CSV/TSV，或上一版工程/板卡例程的 XDC。
两者都没有时脚本会退 2 **明确说缺期望值**，不会假装通过。

**② 配置模式与电源时序**

- **配置模式**确认（JTAG / Master SPI / Slave Serial / BPI）：模式由板上的
  `M[2:0]` 引脚电平决定，写死之前先对着原理图核一遍。选错模式的表现是「下载成功但不启动」。
- **Bank 电压**：每个 bank 的 `VCCO` 必须与分配给它的 IO 标准匹配。混用要在设计阶段就分开。
- **电源时序**：多数 FPGA 要求内核先于 IO 上电（或按手册规定顺序）。上电顺序错会闩锁。
- **配置完成信号**：`DONE` / `INIT_B` 要有可测点，出现「程序跑了但没反应」时先量这两个。

**③ PLL / MMCM 锁定**

`locked` 必须等，不能靠固定延时。判据：复位释放逻辑要**以 `locked` 为条件**，
而不是 `#100; rst_n = 0;`。锁定时间因器件和配置而异（几十微秒到几毫秒），
固定延时在换器件/改参数后就失效。

## 上板分七级(不要一把梭)

**L0 电源配置 → L1 时钟 PLL → L2 复位释放 → L3 寄存器读写 → L4 单通道 → L5 全通道 → L6 满负载**

每一级有明确判据,**不通过就停在那级**,不许跳到下一级。

> ⚠️ **L0 与 L1 绝不允许跳过**:成本最低、信息量最大,却能区分「板子根本没起来」和
> 「逻辑有问题」—— 这两种情况的排查路径完全相反。跳级的代价是只能靠反复改代码重新下载来二分。

**L3 之后再说「功能对不对」。**

| 工具 | 干什么 |
|---|---|
| `project-board-selftest.mjs <工程根>` | 生成 L0–L3 自检 Tcl(`prj/board_selftest.tcl`) |

生成的 Tcl **寄存器地址全是占位符**,用前必须换成真实值;**首次使用请在真实板子上跑一遍** ——
它是按官方 API 写的骨架,未在本机真机验证。

**脚本检查不了的**:电源轨电压、时钟实测频率、配置模式引脚电平、上电时序 —— 这四项必须人工测。

七级的判据表、每级提前准备清单、自检脚本的边界与判据设计:
见 [上板分级流程](references/bringup-levels.md)。

## 内建可观测性

**上板调试的速度取决于你能看到什么,不是多聪明。这是设计输入,写进 SPEC。**

四类(按性价比):**饱和计数器** → **粘滞里程碑位**(含 `wrapped` 标志)→ **心跳** → ILA/VIO。

这一项约占总工时 3–5%,能把上板调试从「周」压到「天」。

**签署判据**:不重新综合、不接外部仪器时,能答出「当前在哪阶段 / 哪个模块异常 /
异常前发生了什么」三问。答不出就是可观测性不足。

四类的具体设计、心跳现象对照表、ILA/VIO 的接入规则:
见 [上板分级流程](references/bringup-levels.md) 的「内建可观测性」。


## 下载

Vivado 硬件管理器(命令原文记入产物;GUI 亦可,写清点了哪几步):

```
connect_hw_server
open_hw_target
# 设备选择与 templates/programming/vivado_program.tcl 同一套逻辑(读 DEVICE_FILTER)
if {[info exists DEVICE_FILTER] && $DEVICE_FILTER ne ""} {
  set devices [get_hw_devices -filter $DEVICE_FILTER]
} else {
  set devices [get_hw_devices]
}
if {[llength $devices] == 0} {
  error "no hardware device matched; check cable, target, and DEVICE_FILTER"
}
if {[llength $devices] > 1} {
  error "multiple hardware devices matched; set DEVICE_FILTER explicitly (e.g. NAME =~ \"*xc7a100t*\")"
}
set device [lindex $devices 0]
current_hw_device $device
refresh_hw_device -update_hw_probes false [current_hw_device]
set_property PROGRAM.FILE {bit/<顶层>.bit} [current_hw_device]
program_hw_devices [current_hw_device]
```

- **确认下载成功**:看输出与器件 `DONE`;要做配置回读用
  `readback_hw_device -force -file <回读文件> [current_hw_device]`,再与 bit 比对
- **不要用不存在的选项**:`program_hw_devices` **没有 `-verify`**;`verify_hw_devices` 是
  eFUSE 加密器件用的,不是通用回读
- 有 ILA/VIO 时用 `bit/<顶层>.ltx`;看波形用已确认脚本起仿真 GUI(见 `fpga-project-syssim`)

**加载方式只有 JTAG 在线加载。** 不写 Flash、不改配置模式引脚 ——
需要掉电保持才走「固化到 Flash」,那是独立动作且需用户确认。

### ILA / VIO:改模块,不要加测试端口

**要探的信号在模块内部有,就在那个模块里挂 ILA/VIO,不为了引出来新增端口。**

```systemverilog
// ❌ 为了调试加端口:接口契约被污染
module dma_ctrl (..., output logic [7:0] dbg_state, output logic dbg_fifo_full);

// ✅ 模块内部挂调试核
module dma_ctrl (...);
`ifdef DEBUG_BUILD
  ila_dma u_ila (.clk(clk), .probe0(state), .probe1(fifo_full));
`endif
```

| 要求 | 为什么 |
|---|---|
| **不加调试端口** | 端口是接口契约,加一个要改 spec、改顶层、改所有例化点;量产删掉又改一遍 |
| **`ifdef DEBUG_BUILD` 包住** | 不包住就进量产版本,占资源、拖时序 |
| **探针信号名与实际内部名一致** | 改名后 ILA 报 `not found`,看不出是探针没连上 |

**「先引出来以后好观察」不成立**:需要时再改模块加探针,不需要时一个都不该有。

**模块的问题要回模块改**:模块是库里的,在工程里加 `ifdef` 探针会让库与工程两份不一致。

## 固化到 Flash(需要掉电保持时)

```
write_cfgmem -force -format MCS -size <容量MB> -interface <SPIx4|BPIx16> \
  -loadbit "up 0x0 bit/<顶层>.bit" <mcs 路径>
```

`-size` / `-interface` 必须与板上 Flash 一致(`sch/` / 手册)—— **写错会损坏 Flash**,不确定就问。

## 判据分两层

**第一层:观察。** ILA/VIO 波形符合预期(握手成对、数据不丢、状态机对)。记触发与文件路径。

**第二层:实测。** 回读数据与 golden 比对一致：这才是**证据**。写法不同而取值等价不算错,
但必须真转成同一口径比过(见 `fpga-module-verif`)。

**人工观察**(相机/示波器/肉眼)单独记,标明人工,**不进自动判据**。

## 判据

- **PASS**:两层都过(波形符合 + 回读一致),且**前置八项全过**(软件四项 + 硬件四项)
- **FAIL**:数据不一致 / 握手卡死 / 输出不对
- **BLOCKED**:板子连不上、cable/驱动、**型号不符**、bit 与器件不匹配
- **UNVERIFIED**:只完成下载或观察,尚未执行足够的实测与独立比对
- **NOT_APPLICABLE**:**只有**工程根本不部署到硬件;没有板子记 `BLOCKED`,不能当 N/A
- 判定词含义见 `fpga-module-verif` 的**状态表**(唯一权威)

**上板轮次要写进报告**:每次上板记「为什么这一次上板、前一次的问题怎么复现与修复的」。
**连续多次上板却说不清每次的动机,就是「不停地上板试」**:那不算调试方法。

## 产物

写 `<用户指定工程目录>/doc/board.md`:

- 结论(`PASS` / `FAIL` / `BLOCKED` / `UNVERIFIED` / `NOT_APPLICABLE`)+ 板子/器件 + **`bit/` 路径**(哪次实现)
- **硬件前置四项结果**:在线探测输出、读到的 part/IDCODE、加载方式(JTAG 在线)、
  bit 时间 vs 源码时间
- **上板前的仿真状态**:`doc/syssim.md` 的结论 + 模块级结论是否齐(上板门槛)
- **上板轮次记录**:第几次、为什么这次上板、前一次的问题怎么复现与修复的
- 下载命令原文 + 成功依据(DONE / 回读路径)
- ILA/VIO:信号、触发、波形路径、所见
- 实测:回读文件 + 与 golden 比对结论
- 人工观察项(标明人工)
- 没验到的部分**写出来**;新文件同步 `doc/files.md`

## 出问题往哪跳

| 现象 | 去哪 |
|---|---|
| 管脚/电平不对 | `fpga-project-constraints` |
| 功能不对 | `fpga-project-rtl` / `fpga-project-syssim` |
| bit 过期/不对 | `fpga-project-impl` |

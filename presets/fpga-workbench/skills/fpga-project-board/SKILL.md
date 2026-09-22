---
name: fpga-project-board
description: 把 bitstream 下载到板子上实测时用:用 bit/ 归档的 bit/ltx 下载与回读、ILA/VIO、回读数据与 golden 比对、必要时固化 Flash。管脚依据 sch/。下载与固化须先确认,结果写 doc/board.md。
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

**spec 定下之后没有固定流程**:本技能与其它工程级技能都是**按需取用**,可并列、可回跳、可只做其中几样;见 `fpga-project-spec`。

## 前置(不满足不得上板)

1. `doc/constraints.md` 管脚逐条核过(`sch/` 原理图)—— 错了会损伤板子
2. `doc/timing.md` 是 PASS —— 时序没过,现象不可信
3. 有 bit(**`bit/` 归档**,见 `doc/impl.md`),且与当前代码对应

## 下载

Vivado 硬件管理器(命令原文记入产物;GUI 亦可,写清点了哪几步):

```
connect_hw_server
open_hw_target
current_hw_device [lindex [get_hw_devices] 0]
refresh_hw_device -update_hw_probes false [current_hw_device]
set_property PROGRAM.FILE {bit/<顶层>.bit} [current_hw_device]
program_hw_devices [current_hw_device]
```

- **确认下载成功**:看输出与器件 `DONE`;要做配置回读用
  `readback_hw_device -force -file <回读文件> [current_hw_device]`,再与 bit 比对
- **不要用不存在的选项**:`program_hw_devices` **没有 `-verify`**;`verify_hw_devices` 是
  eFUSE 加密器件用的,不是通用回读
- 有 ILA/VIO 时用 `bit/<顶层>.ltx`;看波形用已确认脚本起仿真 GUI(见 `fpga-project-syssim`)

## 固化到 Flash(需要掉电保持时)

```
write_cfgmem -force -format MCS -size <容量MB> -interface <SPIx4|BPIx16> \
  -loadbit "up 0x0 bit/<顶层>.bit" <mcs 路径>
```

`-size` / `-interface` 必须与板上 Flash 一致(`sch/` / 手册)—— **写错会损坏 Flash**,不确定就问。

## 判据分两层

**第一层:观察。** ILA/VIO 波形符合预期(握手成对、数据不丢、状态机对)。记触发与文件路径。

**第二层:实测。** 回读数据与 golden 比对一致 —— 这才是**证据**。写法不同而取值等价不算错,
但必须真转成同一口径比过(见 `fpga-module-verif`)。

**人工观察**(相机/示波器/肉眼)单独记,标明人工,**不进自动判据**。

## 判据

- **PASS**:两层都过(波形符合 + 回读一致)
- **FAIL**:数据不一致 / 握手卡死 / 输出不对
- **BLOCKED**:板子连不上、cable/驱动、bit 与器件不匹配
- **UNVERIFIED**:只完成下载或观察,尚未执行足够的实测与独立比对
- **NOT_APPLICABLE**:**只有**工程根本不部署到硬件;没有板子记 `BLOCKED`,不能当 N/A
- 判定词含义见 `fpga-module-verif` 的**状态表**(唯一权威)

## 产物

写 `<用户指定工程目录>/doc/board.md`:

- 结论(`PASS` / `FAIL` / `BLOCKED` / `UNVERIFIED` / `NOT_APPLICABLE`)+ 板子/器件 + **`bit/` 路径**(哪次实现)
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

---
name: fpga-project-board
description: 把 bitstream 下载到板子上做实测验证时用:下载与回读(connect_hw_server / open_hw_target / program_hw_devices)、用 ILA/VIO 抓内部信号、回读数据与基准(golden)比对、写 cfgmem 固化到 Flash。下载与固化均须先确认器件、文件与授权。
---

# project-board:上板验证

工程一般都要走到上板(除工程根本不部署到硬件)。但**上板是直接操作硬件的动作**:

- **不自行启动**:用户没说要上板,不得因为"工程级该收尾了"就去连板子。
- **动手前把这几样核实并请用户确认**:目标器件/编程器是否正确、bit 文件是否由当前这版代码生成、
  管脚与电平是否已核过。固化(写 Flash/配置存储器)是**不可逆的高风险操作** —— 参数(器件型号、
  配置模式、时钟)必须经用户确认,不得自行推断。
- 板子不在手边时,继续做别的开发任务即可;**不得声称上板验证通过**。

## 前置(不满足不得上板)

1. `project/constraints/constraints.md` 里**管脚逐条核过** —— 管脚或电平错了会损伤板子
2. `project/timing/timing.md` 是 PASS —— 时序没过就上板,看到的现象不可信
3. 有 bit 文件(`project/impl/impl.md` 里有路径),且**与当前代码对应**(不是旧版本的残留)

## 本环节要跑的命令

Vivado 硬件管理器里跑(命令原文记入产物;GUI 亦可,但要写清点了哪几步):

```
connect_hw_server
open_hw_target
current_hw_device [lindex [get_hw_devices] 0]
refresh_hw_device -update_hw_probes false [current_hw_device]
set_property PROGRAM.FILE {<bit 路径>} [current_hw_device]
program_hw_devices [current_hw_device]
```

- **确认下载成功**,别只看命令没报错:
  - `program_hw_devices` 的输出与器件的 `DONE` 状态(下载后会置起)
  - 要真做**配置回读**用独立命令 `readback_hw_device -force -file <回读文件> [current_hw_device]`,
    再把回读数据与 bit 比对 —— 这才是"抓配置传输错误"的手段
- **不存在的写法别用**:`program_hw_devices` **没有 `-verify` 选项**;`verify_hw_devices` 是
  给 **eFUSE 加密器件**做密钥/掩码比对的,不是通用回读校验。这两条是查 Vivado 2025.2 的
  命令帮助核实的(踩过一次:技能里曾写 `program_hw_devices -verify`,那是错的)
- 抓到的内部信号要在**波形窗口**细看时,与模块级同一条路:用**已经确认过的那份脚本**起仿真 GUI
  (ModelSim 是 `verif/run.do`,选了 XSim 就是 `xelab` 出来的 snapshot,见 `fpga-module-verif`
  第三步);不要在 `verif/` 里直接开 GUI 加载设计,那会把 TB 的 dump 文件清零

## 固化到 Flash(需要掉电保持时)

```
write_cfgmem -force -format MCS -size <容量MB> -interface <SPIx4|BPIx16> \
  -loadbit "up 0x0 <bit 路径>" <mcs 路径>
```
`-size` 与 `-interface` 必须跟板上的 Flash 一致 —— **写错会损坏那颗 Flash**,
不确定即询问,不得尝试。

## 判据分两层(两层都要,不能只看一层)

**第一层:观察。** ILA / VIO 抓到的波形符合预期:握手成对、数据不丢、状态机按预期走。
记录触发条件与截图/波形文件路径。

**第二层:实测。** 回读数据与 golden 比对一致 —— 这才是**证据**。
"ILA 波形符合预期"属于观察,不构成证据;两者都要写进产物,但要分清。
比对口径与模块级一致:双方只是**写法**不同(进制、大小写、分隔符)而取值等价不算错,
但必须真转成同一口径逐个比过才算过 —— 见 `fpga-module-verif`。

**人工观察**(相机实拍、示波器、肉眼)单独记一栏,注明是人工判断,**不进自动判据**。

## 判据

- **PASS**:两层都过(波形符合 + 回读数据一致)
- **FAIL**:数据不一致 / 握手卡死 / 输出不对
- **BLOCKED**:板子连不上、驱动或 cable 有问题、bit 与板子器件不匹配 → 如实说,不得猜测
- **NOT_APPLICABLE**:**只有**这个工程根本不部署到硬件时才算(纯 IP 交付之类)。
  工程级的常规收尾就是上板 —— 不得以"没有板子"充当 NOT_APPLICABLE,那要记 BLOCKED 并说明
- 判定词本身的含义见 `fpga-module-verif` 的**状态表**(唯一权威);本节只写本环节哪种情况记哪个词

## 产物

写 `<工作区根>/project/board/board.md`:

- 结论(`PASS` / `FAIL` / `BLOCKED` / `UNVERIFIED` / `NOT_APPLICABLE`)

- 结论 + 板子与器件型号 + bit 文件路径(哪一次实现出的)
- 下载命令原文 + 成功依据(DONE 状态 / 回读文件路径)
- ILA/VIO:抓了什么信号、触发条件、波形文件路径、看到了什么
- 实测数据:回读的数据文件 + 与 golden 的比对结论(不一致时以比对结果为准)
- 人工观察项与结论,标明是人工
- 没验到的部分**写出来**

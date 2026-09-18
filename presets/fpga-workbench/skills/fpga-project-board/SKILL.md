---
name: fpga-project-board
description: 把 bitstream 下载到板子上做实测验证时用:下载与回读(connect_hw_server / open_hw_target / program_hw_devices)、用 ILA/VIO 抓内部信号、回读数据跟 golden 比对、写 cfgmem 固化到 Flash。下载与固化都要先确认器件、文件与授权。
---

# project-board:上板验证

做工程一般都要走到上板(除非这个工程根本不部署到硬件)。但**上板是动手碰硬件的动作**:

- **不自行启动**:用户没说要上板,就不要因为"工程级该收尾了"就去连板子。
- **动手前把这几样核实并让用户确认**:目标器件/编程器对不对、bit 文件是不是当前这版代码出来的、
  管脚与电平核过没有。固化(写 Flash/配置存储器)是**不可逆的高风险操作** —— 参数(器件型号、
  配置模式、时钟)必须用户确认,不要自行推断。
- 板子不在手边时,继续做别的开发任务即可;**不要声称上板验证通过**。

## 前置(不满足就别上板)

1. `project/constraints/constraints.md` 里**管脚逐条核过** —— 管脚或电平错了会伤板子
2. `project/timing/timing.md` 是 PASS —— 时序没过就上板,看到的现象不可信
3. 有 bit 文件(`project/impl/impl.md` 里有路径),且**与当前代码对应**(不是旧版本的残留)

## 下载

```
connect_hw_server
open_hw_target
current_hw_device [lindex [get_hw_devices] 0]
refresh_hw_device -update_hw_probes false [current_hw_device]
set_property PROGRAM.FILE {<bit 路径>} [current_hw_device]
program_hw_devices [current_hw_device]
```

- **加 `-verify` 跑一次**(`program_hw_devices -verify`)—— 它能抓出配置数据传输出错,
  省得把传输问题当成逻辑问题查
- GUI 点也行,但**下载命令要记进产物**,不然"当时怎么下的"没人说得清

## 固化到 Flash(需要掉电保持时)

```
write_cfgmem -force -format MCS -size <容量MB> -interface <SPIx4|BPIx16> \
  -loadbit "up 0x0 <bit 路径>" <mcs 路径>
```
`-size` 与 `-interface` 必须跟板上的 Flash 一致 —— **写错会废掉那顆 Flash**,
不确定就问,不要试。

## 判据分两层(两层都要,不能只看一层)

**第一层:看见。** ILA / VIO 抓到的波形符合预期:握手成对、数据不丢、状态机按预期走。
记录触发条件与截图/波形文件路径。

**第二层:实测。** 回读数据与 golden 比对一致 —— 这才是**证据**。
"ILA 看着对"是观察,不是证据;两者都要写进产物,但要分清。

**人工观察**(相机实拍、示波器、肉眼)单独记一栏,注明是人工判断,**不进自动判据**。

## 判据取值

- **PASS**:两层都过(波形符合 + 回读数据一致)
- **FAIL**:数据不一致 / 握手卡死 / 输出不对
- **BLOCKED**:板子连不上、驱动或 cable 有问题、bit 与板子器件不匹配 → 如实说,别猜
- **NOT_APPLICABLE**:**只有**这个工程根本不部署到硬件时才算(纯 IP 交付之类)。
  工程级的常规收尾就是上板 —— 别拿"没有板子"当 NOT_APPLICABLE,那要记 BLOCKED 并说明

## 产物

写 `<工作区根>/project/board/board.md`:

- 结论 + 板子与器件型号 + bit 文件路径(哪一次实现出的)
- 下载命令原文(含 `-verify` 结果)
- ILA/VIO:抓了什么信号、触发条件、波形文件路径、看到了什么
- 实测数据:回读的数据文件 + 与 golden 的比对结论(不一致要比对结果说话)
- 人工观察项与结论,标明是人工
- 没验到的部分**写出来**

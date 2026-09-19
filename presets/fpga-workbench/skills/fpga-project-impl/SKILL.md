---
name: fpga-project-impl
description: 跑 FPGA 工程的实现与出 bitstream 时用:布局布线(implementation)、跑 DRC、看资源占用与实现后的时序摘要、生成 bit/bin;也用于解释实现失败、布线拥塞、DRC 报错。
---

# project-impl:实现与 bitstream

**实现报错可以就地排查**:直接看日志定位、改约束或改代码重跑 —— 其间不必回头把每个模块
环节重跑一遍。只有**正式出 bitstream 验收**时,才要求前置那些东西确实成立。

## 前置(正式出 bitstream 时)

- 集成完成(`project/integrate/`),约束已经核过(`project/constraints/`)
- 模块级的 `lint` / `sim` 都过了 —— 实现一次要几十分钟,不得拿它当验证手段

## 怎么跑

GUI 操作亦可,但**批处理才留下可复现的命令原文**:

```tcl
open_project <工程>
launch_runs impl_1 -to_step write_bitstream -jobs <N>
wait_on_run impl_1
```

跑完后确认 run 状态是 `write_bitstream Complete`,再取 bit:

```
<工程>.runs/impl_1/<顶层>.bit
```

需要 bin 或固化文件时:`write_bitstream -force -bin_file`、`write_cfgmem`(见上板那一环节)。

## 判据

- **PASS**:实现跑完,DRC 没有 Critical Warning 级别的报错,bit 文件产出;
  资源占用与时序摘要都拿得到
- **FAIL**:实现报 error;DRC 有必须处理项;布线失败或拥塞严重
- **BLOCKED**:工程打不开 / 器件没选对 / 约束缺失导致跑不下去
- **NOT_APPLICABLE**:这次不需要 bitstream

**本环节不判定时序是否满足** —— 时序判定在 `fpga-project-timing`。这里只负责
"实现跑出来了、资源多少、bit 在哪"。

## 产物

写 `<工作区根>/project/impl/impl.md`:

- 结论 + 跑过的命令原文(或 GUI 里点的那几步)
- 用的 run 名与策略、耗时
- 资源占用(LUT / FF / BRAM / DSP / IO),与模块级综合时的估算差多少
- 实现后时序摘要的**文件名**(不做判定,判定在下游)
- **bit 文件的完整路径**
- DRC 报出来的项与处理

## 不要做的事

- **不得手改 `.runs/` 里的东西** —— 那是 Vivado 的地盘,下次跑就没了
- 不得把工程目录塞进源码管理;要复现就用 `write_project_tcl` 导出工程脚本
- 实现过了不代表功能对:它只证明"能布下去"

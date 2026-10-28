---
name: fpga-project-synth
description: 对 prj/ 工程执行综合、查看资源和综合后时序摘要时用;实现与 bitstream 转 fpga-project-impl。
---

# project-synth:工程综合

**只做 synthesis**(把 RTL 变成网表)。**布局布线、DRC、出 bit** 在 `fpga-project-impl`;
模块级综合门禁那套在 `fpga-module-synth`(库里的模块)。

| 东西 | 在哪 |
|---|---|
| 工程 | `prj/`(Vivado;源是**引用** `src/` `ip/` `xdc/`) |
| 结论 | `doc/synth.md` |
| 与谁并列 | `rtl` / `sim` / `lint` / `constraints`(综合前尽量都完好,次序不限) |

其余工程技能按需并列或回跳,见 `fpga-project-spec`。

## 前置(正式综合前尽量齐)

1. **`rtl` / `sim` / `xdc` 三处完好**(不必固定先后;见 `fpga-project-spec`)
2. 工程已建、源已**引用**进 `prj/`(见 `fpga-project-integrate`)
3. 需要配套 xdc 的 IP,约束已在 `xdc/`(见 `fpga-project-constraints`)

**就地排查综合报错**可以随时跑;正式记 `PASS` 时再要求前置尽量齐。

## 干什么

```tcl
open_project prj/<工程>
launch_runs synth_1 -jobs <N>
wait_on_run synth_1
```

### 走 MCP 还是走 shell

**有 `mcp__vivado__*` 时优先走 MCP** —— 常驻会话:工程只 `open_project` 一次,后续命令秒级;
shell 的 `vivado -mode batch` 每条命令都要重开 Vivado(30–60 秒启动)。

```
vivado_start(working_dir, session_type)
vivado_execute("open_project prj/<工程>")      ← 单独调用
vivado_execute("launch_runs synth_1 -jobs 4")  ← 单独调用
vivado_execute("wait_on_run synth_1")          ← 单独调用,与上面成对
vivado_status(session_id, action="runs")       ← 隔 30–60 秒查
```

**同一 session 必须串行**;长命令返回 `status: running` 后**不要空闲等**(用子代理并行做别的)。
细节、卡住恢复、`vivado_todos` 用法见 [MCP 与批处理](references/mcp-and-batch.md)。

MCP 不可用时退回 shell(`vivado -mode batch -source prj/run_synth.tcl`),放后台任务别前台死等。

**两种都不改变判据** —— MCP 只是把命令送进 Vivado、把输出送回来,结论仍由你判。

**先看 run 是不是已经新鲜**:`get_property STATUS/PROGRESS/NEEDS_REFRESH [get_runs synth_1]` —— 已经
`Complete!` 且 `NEEDS_REFRESH=0` 说明源码没动,**直接 `open_run synth_1` 出报告就行,不必重跑**
(分类模板 `synthesis/vivado_project_synthesis.tcl` 的 `RESET_POLICY=auto` 就是这么做的;
要拿一次干净结果再 `RESET_POLICY always` 或手工 `reset_run synth_1`)。

1. 跑综合,确认 `synth_1` 状态是 Complete(或如实记失败原因)
2. 看综合日志:IP 有没有起来、有没有多驱动/推断失败/严重 warning
3. 收**资源占用**与综合后**时序摘要**(这里只是**先看一眼**,门禁仍归 `fpga-project-timing`)
4. **时序先过一眼再往上压**(见下节)
5. 有问题按「出问题往哪跳」回去改,不要在本环节改设计

## 综合后先看时序:满足了再提高一些

综合一结束就看**综合后时序摘要**(与 `doc/spec.md` 的时钟目标比):

| 情况 | 怎么做 |
|---|---|
| 已经卡着要求(WNS≈0 或负) | 先收时序:插流水、拆逻辑、改写法(回 `fpga-project-rtl`);**不要**急着提频 |
| **满足要求且还有裕量** | **在仍满足要求的前提下,把性能再提高一些** —— 例如适当提目标频率、压一压周期、或继续减逻辑级;每压一次都回到综合/时序看一眼,**始终以「满足要求」为底线** |
| 明显富余很多 | 可以问用户要不要提频/减资源;用户点头再动 spec 时钟目标 |
| 已经不满足 | 降目标或改设计,先问用户取舍,不要默默放宽约束 |

**底线**:提高性能不得把时序**改到不满足**;改时钟目标要先改 `doc/spec.md` 并经用户确认。

## 判据

- **PASS**:综合 Complete;资源与时序摘要已收;无必须先处理的 error
- **FAIL**:综合 error,或 Critical Warning 已确认会影响功能
- **BLOCKED**:工程打不开 / 器件没对 / IP 或 xdc 缺失导致综合跑不动
- **UNVERIFIED**:只跑了部分 / 没看日志
- **NOT_APPLICABLE**:这次不跑综合

判定词见 `fpga-module-verif` 的**状态表**(唯一权威)。
  · 速记:`PASS`有证据 / `FAIL`真不符 / `BLOCKED`缺条件 / `UNVERIFIED`没验 / `NOT_APPLICABLE`确不适用且不掩盖无法验证

## 产物

写 `<用户指定工程目录>/doc/synth.md`:

- 结论(`PASS` / `FAIL` / `BLOCKED` / `UNVERIFIED` / `NOT_APPLICABLE`)+ 命令原文
- run 名与策略、耗时
- 资源占用(LUT / FF / BRAM / DSP / IO)
- 综合后时序摘要路径(不判定)
- 综合日志路径、关键 warning 与处理

## 出问题往哪跳

| 现象 | 去哪 |
|---|---|
| 推断失败、RTL 写法问题 | `fpga-project-rtl` |
| IP/约束导致综合失败 | `fpga-project-constraints` / `fpga-project-rtl` |
| 源没进工程、顶层没接上 | `fpga-project-integrate` |
| 风格/断言类先收干净 | `fpga-project-lint` |

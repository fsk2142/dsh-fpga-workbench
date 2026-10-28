---
name: fpga-project-impl
description: 工程综合后运行到 route_design 时用;用户需要 bitstream 时继续同一 impl_1 并归档 bit/。
---

# project-impl:布局布线与按需 bitstream

**从综合后接着做**(综合见 `fpga-project-synth`):先完成布局布线(implementation)与 DRC;
用户需要 bitstream 时,再从同一份已完成的 `impl_1` 继续生成 bit/ltx。

**实现报错可以就地排查**:看日志定位、改约束或改代码重跑 —— 不必把每个模块环节重跑一遍。
只有正式出 bitstream 验收时,才启用下文额外的发布前置。

| 东西 | 在哪 |
|---|---|
| 工程 | `prj/`(工具地盘;源是引用 `src/` `ip/` `xdc/`) |
| bit 归档 | **`bit/`**(覆盖、不改名) |
| 结论 | `doc/impl.md` |

## 请求范围

先把用户当前请求归到一个范围,并写进 `doc/impl.md`:

- `route`:跑到 `route_design`,执行 DRC 并生成实现报告
- `bitstream`:完成 `route` 的全部工作,再从同一 `impl_1` 继续生成并归档 bit/ltx

只要求布局布线、DRC 或实现报告时用 `route`;明确要求 bit、ltx、上板或发布产物时用 `bitstream`。

其余工程技能按需并列或回跳,见 `fpga-project-spec`。

## 前置

两个范围都要求:

- **综合已过**(`doc/synth.md`),且综合后时序**先看过一眼**(见 `fpga-project-synth`)
- 集成完成(`doc/integrate.md`),约束已核对(`doc/constraints.md`)

`bitstream` 用于正式验收时还要求:

- **`rtl` / `sim` / `xdc` 尽量完好**(次序不限;见 `fpga-project-spec`)
- **可复用模块**模块级 `rtl` 与 `verif` 是 `PASS` 或有据 `NOT_APPLICABLE` —— 实现一次几十分钟,
  不得拿它当验证手段
- **专用模块**在 `src/sim/` 有 `tb_*` 且跑过一次(标准见 `fpga-project-spec`)

## 本环节要跑的命令

GUI 亦可,但**批处理才留下可复现命令原文**。`route` 范围执行①后停止;
`bitstream` 范围执行①,成功后再执行②。分类模板
`implementation/vivado_implementation.tcl` 与 `bitstream/vivado_bitstream.tcl` 分别对应这两段。有 `mcp__vivado__*` 时优先走 MCP(用法见 `fpga-project-synth` 技能里的 MCP 与批处理一节)。

```tcl
# ① 实现:跑到 route_design 为止(不写 bitstream),并跑 DRC
open_project prj/<工程>
launch_runs impl_1 -to_step route_design -jobs <N>
wait_on_run impl_1
open_run impl_1
report_drc -file doc/impl_drc.rpt          ;# DRC 门:Error 级必须先处理
report_route_status -file doc/impl_route_status.rpt
report_utilization -file doc/impl_utilization.rpt
report_timing_summary -file doc/impl_timing.rpt

# ② 仅 bitstream 范围:从**同一份已完成的 impl_1 继续**,不重新 place/route
launch_runs impl_1 -to_step write_bitstream -jobs <N>
wait_on_run impl_1
```

- `route` 范围不执行 `write_bitstream`;职责分开后,两段才能独立复用与核验。
- `bitstream` 范围执行②前,确认 `impl_1` 是 `Complete!` 且 `NEEDS_REFRESH=0`;
  **源码在实现之后又改过就别继续出 bit**
  —— 那要么拿旧布局布线交差,要么让 Vivado 偷偷重跑一遍实现,两条都不行(回①重跑)。
- `impl_1` 上可以开 `set_property AUTO_INCREMENTAL_CHECKPOINT 1 [get_runs impl_1]`:小改 RTL 时复用
  上一轮 place/route(Vivado 自己判断值不值得)。**正式出图建议关掉**(设 0)拿一次干净结果。

仅在 `bitstream` 范围确认 `write_bitstream Complete` 后取:

```
prj/<工程>.runs/impl_1/<顶层>.bit
prj/<工程>.runs/impl_1/<顶层>.ltx    # 有 ILA/VIO 时
```

需要 bin / 固化文件:`write_bitstream -force -bin_file`、`write_cfgmem`(见 `fpga-project-board`)。

### 归档到 `bit/`

仅在 `bitstream` 范围生成成功后,把 bit 与 ltx **拷到 `bit/`**,覆盖旧文件、
**不改名字**(约定的唯一覆盖点):

```
bit/<顶层>.bit
bit/<顶层>.ltx
```

上板、发布以 `bit/` 为准。拷完在 `doc/impl.md` 写明来源 run 与时间,并更新 `doc/files.md`。

## 判据

- **`route` 范围 `PASS`**:impl 跑到 route、**DRC 无 Error 级项**,资源与时序摘要拿得到
- **`bitstream` 范围 `PASS`**:`route` 判据全部满足,bitstream 生成完成且 bit 已拷入 `bit/`
- 模板日志的 `IMPLEMENTATION_ROUTED` / `BITSTREAM_OUTPUT_GENERATED` 只说明工具跑完出了东西,
  **不能单独证明 `PASS`**
- **FAIL**:实现 error;DRC 有必须处理项;布线失败或拥塞严重
- **BLOCKED**:工程打不开 / 器件不对 / 约束或 IP 不齐跑不下去
- **UNVERIFIED**:所选范围没跑完 / 没看日志
- **NOT_APPLICABLE**:当前任务不涉及布局布线或实现产物,且无需生成新的实现证据

判定词含义见 `fpga-module-verif` 的**状态表**(唯一权威)。
  · 速记:`PASS`=实测通过有证据 / `FAIL`=观察到真不符 / `BLOCKED`=缺条件做不了 / `UNVERIFIED`=没验或覆盖不足 / `NOT_APPLICABLE`=确不适用(不掩盖无法验证)

**本环节不判定时序是否满足** —— 时序判定在 `fpga-project-timing`。

## 产物

写 `<用户指定工程目录>/doc/impl.md`:

- 结论(`PASS` / `FAIL` / `BLOCKED` / `UNVERIFIED` / `NOT_APPLICABLE`)+ 命令原文(或 GUI 步骤)
- 请求范围:`route` 或 `bitstream`
- run 名、策略、耗时
- 资源占用
- 实现后时序摘要**路径**(不判定)
- `bitstream` 范围才记录 **bit 路径**:`prj/` 下 run 里的 + **`bit/` 归档那份**
- DRC 项与处理
- 同步 `doc/files.md`

## 不要做的事

- 不手改 `prj/` 里 `.runs/` / `.cache/`
- 不把 `prj/` 整个塞进源码管理(要复现用 `write_project_tcl`)
- 实现过了 ≠ 功能对(只证明能布下去)

## 出问题往哪跳

| 现象 | 去哪 |
|---|---|
| 布线拥塞 / 结构问题 | `fpga-project-rtl` |
| 约束过紧/管脚 | `fpga-project-constraints` |
| 综合就挂了 | `fpga-project-synth` |

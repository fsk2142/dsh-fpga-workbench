---
name: fpga-project-impl
description: 在 FPGA 工程做布局布线与出 bitstream 时用:synth 之后跑 impl、DRC、出 bit/ltx,并拷进 bit/ 覆盖归档。综合在 fpga-project-synth。结果写 doc/impl.md。
---

# project-impl:布局布线与 bitstream

**从综合后接着做**(综合见 `fpga-project-synth`):布局布线(implementation)、DRC、出 bit/ltx。

**实现报错可以就地排查**:看日志定位、改约束或改代码重跑 —— 不必把每个模块环节重跑一遍。
只有**正式出 bitstream 验收**时,才要求前置确实成立。

| 东西 | 在哪 |
|---|---|
| 工程 | `prj/`(工具地盘;源是引用 `src/` `ip/` `xdc/`) |
| bit 归档 | **`bit/`**(覆盖、不改名) |
| 结论 | `doc/impl.md` |

**spec 定下之后没有固定流程**:本技能与其它工程级技能都是**按需取用**,可并列、可回跳、可只做其中几样;见 `fpga-project-spec`。

## 前置(正式出 bitstream 时)

- **综合已过**(`doc/synth.md`),且综合后时序**先看过一眼**(见 `fpga-project-synth`)
- **`rtl` / `sim` / `xdc` 尽量完好**(次序不限;见 `fpga-project-spec`)
- 集成完成(`doc/integrate.md`),约束核过(`doc/constraints.md`)
- **可复用模块**模块级 `rtl` 与 `verif` 是 `PASS` 或有据 `NOT_APPLICABLE` —— 实现一次几十分钟,
  不得拿它当验证手段
- **专用模块**在 `src/sim/` 有 `tb_*` 且跑过一次(标准见 `fpga-project-spec`)

## 本环节要跑的命令

GUI 亦可,但**批处理才留下可复现命令原文**:

```tcl
open_project prj/<工程>
launch_runs impl_1 -to_step write_bitstream -jobs <N>
wait_on_run impl_1
```

确认 `write_bitstream Complete` 后取:

```
prj/<工程>.runs/impl_1/<顶层>.bit
prj/<工程>.runs/impl_1/<顶层>.ltx    # 有 ILA/VIO 时
```

需要 bin / 固化文件:`write_bitstream -force -bin_file`、`write_cfgmem`(见 `fpga-project-board`)。

### 归档到 `bit/`

**每次实现成功后**,把 bit 与 ltx **拷到 `bit/`**,覆盖旧文件、**不改名字**(约定的唯一覆盖点):

```
bit/<顶层>.bit
bit/<顶层>.ltx
```

上板、发布以 `bit/` 为准。拷完在 `doc/impl.md` 写明来源 run 与时间,并更新 `doc/files.md`。

## 判据

- **PASS**:impl + bitstream 跑完,DRC 无必须处理的 Critical 问题,bit 已拷入 `bit/`;
  资源与时序摘要拿得到
- **FAIL**:实现 error;DRC 有必须处理项;布线失败或拥塞严重
- **BLOCKED**:工程打不开 / 器件不对 / 约束或 IP 不齐跑不下去
- **UNVERIFIED**:没跑完 / 没看日志
- **NOT_APPLICABLE**:这次不需要 bitstream

判定词含义见 `fpga-module-verif` 的**状态表**(唯一权威)。

**本环节不判定时序是否满足** —— 时序判定在 `fpga-project-timing`。

## 产物

写 `<用户指定工程目录>/doc/impl.md`:

- 结论(`PASS` / `FAIL` / `BLOCKED` / `UNVERIFIED` / `NOT_APPLICABLE`)+ 命令原文(或 GUI 步骤)
- run 名、策略、耗时
- 资源占用
- 实现后时序摘要**路径**(不判定)
- **bit 路径**:`prj/` 下 run 里的 + **`bit/` 归档那份**
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

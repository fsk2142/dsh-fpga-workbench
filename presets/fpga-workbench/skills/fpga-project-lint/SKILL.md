---
name: fpga-project-lint
description: 检查 FPGA 工程机械规范、厂商 lint 或编译告警时用;只检查,不修改设计。
---

# project-lint:工程内 lint / 静态检查

**只做检查、不改设计**(改设计回 `fpga-project-rtl` / `fpga-project-syssim`)。
与其它工程级技能无固定先后;综合前尽量干净。

| 查什么 | 在哪 |
|---|---|
| RTL | `src/rtl/`(全部平铺) |
| 仿真文件 | `src/sim/` 的简单 sim + 根 `sim/` 的工程级仿真 |
| 结论 | `doc/lint.md` |

## 前置

1. 有可检查的源
2. 格式约定以**模板**为准(见 `fpga-project-rtl`)

## 干什么

### 1. 机械规范(工程级命令)

```
node "<自带命令目录>\project\project-rtl-check.mjs" <用户指定工程目录>
```

用**工程级**检查器(规则与模块级同源,入口适配 `src/rtl` + `src/sim` + 根 `sim/`),
**不要**拿模块级 `module-rtl-check` 冒充工程级。覆盖端口类型、复位极性、`always_ff`、
`end/else`、断言、Tab、行尾、代码行非英文、测试平台自检等。

### 2. 厂商自带 lint(有就用,没有就跳过)

**工程级优先用厂商自带的 lint / 语法检查**(Vivado、Quartus 等),命令记原文。

**设置里选了「Linter 脚本」就用那份**(字段 `projectLintTemplate`)。本仓库自带
`templates/linter/vivado_rtl_lint.tcl`,已在 Vivado 2025.2 真机验过:

- `-lint` 与 `-rtl` **互斥**,必须拆成两条命令,否则报
  `Command failed: -lint and -rtl are mutually exclusive`
- 正确顺序:`synth_design -lint` 先把结果写成 `doc/vivado_rtl_lint.rpt`,再用 `-rtl` 展开连通性
- **ERROR 判死**;lint 发现的其它问题**逐条列出、不判死**,但要写进结论

**厂商工具没就绪、或没有可用 lint → 本步直接跳过**:产物写「厂商 lint:跳过(无可用工具)」,
**不算 FAIL**,不要硬找第三方替代。

### 3. 结果分流

RTL → `fpga-project-rtl`;tb → `fpga-project-syssim`;接线 → `fpga-project-integrate`。
本技能**不改代码**。

## 判据

- **PASS**:机械规范无阻塞项(或差异已说明);厂商 lint 已跑**或**已记跳过原因
- **FAIL**:机械规范有阻塞项且已定位;或厂商 lint 报了必须处理的 error
  (缺工具跳过**不**因此 FAIL)
- **BLOCKED**:连机械检查都跑不了
- **UNVERIFIED**:只查了部分源码
- **NOT_APPLICABLE**:本次没有源码变更

判定词见 `fpga-module-verif` 的**状态表**(唯一权威)。

## 产物

写 `<用户指定工程目录>/doc/lint.md`:

- 结论(`PASS` / `FAIL` / `BLOCKED` / `UNVERIFIED` / `NOT_APPLICABLE`)+ 命令原文与范围
- **带行号**问题清单(阻塞 / 警告)
- **厂商 lint**:用的哪个 / 或「跳过(无可用工具)」
- 分流结果

## 出问题往哪跳

| 现象 | 去哪 |
|---|---|
| RTL 结构/格式/断言 | `fpga-project-rtl` |
| tb | `fpga-project-syssim` |
| 顶层接线 | `fpga-project-integrate` |
| 约束 | `fpga-project-constraints` |

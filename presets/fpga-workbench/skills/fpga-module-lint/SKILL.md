---
name: fpga-module-lint
description: 写或改 RTL、查编码规范、定位 lint 或编译报错时用:对本 FPGA 模块跑编译器检查、逐条核对规范(文件头、九个小节块、端口类型与对齐、制表符、行尾、设计断言、测试平台自检);也用于只查单个文件或单条告警。
---

# module-lint:编译检查与规范核对

**随时可跑,不必等 RTL 全部写完**:改一个文件即查一个文件,报错先定位再修;完整交付前再跑一次全量。
排查下游问题(仿真失败、综合报错)时可回头补查本环节,但目的是修问题,不是为了"补齐流程"。

建议顺序为 lint 先于仿真(可省下大量仿真排错时间),**但这不构成关卡**:正在排查仿真问题时,不必停下
补 lint。

## 前置

1. 找约定文件 `.fpga-workbench.json`(在模块根;找不到则询问用户,见 `fpga-module-spec`)
2. 读 `spec/spec.md`:接口、判据、器件在其中 —— 规范检查的例外也按它判
3. 确认待查源码(默认 `rtl/` 下的 `.v` / `.sv`,递归)

## 第一步:编译器检查

**用设置中选定的编译器**(会话开头「本机 FPGA 工具链」写明是哪个、路径是什么),下文命令以
Verilator 为例;选的是其它工具则换成其用法。

```powershell
& "<编译器路径>" --lint-only -Wall --top-module <顶层模块名> <文件...>
```

- **只查 `rtl/`**,不把 `ip/` 的仿真模型丢进去
- 报 `module not found`、而该模块定义在 `ip/` 下 —— 属正常现象,它的定义不在 `rtl/` 里。
  做法:把 IP 的端口 wrapper 一起传进去,或临时生成一个只有端口的黑盒 stub 加进命令行。
  **不得为了让 lint 过就改端口**
- 告警必须清零。确需压制的,在源码里**就地豁免**(`/* verilator lint_off XXX */` …
  `/* verilator lint_on XXX */`)并在旁边写明原因;**禁止用 `-Wno-XXX` 全局屏蔽**

## 第二步:逐条对规范

**格式以模板为准** —— RTL / 测试平台 / 约束各有模板,用哪一份看会话开头「本机 FPGA 工具链」的
模板一节(未提供即插件自带那份),**先读模板再对**。核对清单如下。

**机械的部分先用自带命令跑一遍**(路径见会话开头「本模式自带的命令」):

```powershell
node "<自带命令目录>\check-rtl.mjs" <模块目录>
```

文件头、九个小节块、端口类型、复位极性、always_ff、end/else、断言、Tab、行尾、代码行非英文、
测试平台自检 —— 一次查完并给出**行号**。退出码 0 = 没有阻塞项(可能仍有警告) / 1 = 有阻塞项 /
2 = 用法或环境问题。

它判不了的须自行读代码:**一个 always 块里混放不相关信号**、断言写得对不对、命名与结构好坏。

**写 RTL 时就按上述规范写**(照模板改),这里是写完后的核对。

格式类 —— 机械可判:

- 禁 Tab
- 代码行禁非英文(注释例外)
- 行尾统一,一个文件里不许混

结构类 —— 须读代码判定:

- **文件头 11 行**字段齐全:File Name / Module Name / Created Date / Updated Date / Version /
  Author / Copyright / Open Source(专有声明),再跟 2–5 行模块功能说明(数据流、输出格式)
- 开头 `` `resetall `` + `` `timescale `` + `` `default_nettype none ``,结尾把 nettype 收回来
- 端口类型只许 `input wire` / `output logic` / `inout tri`;端口名与类型**对齐到第 69 列**
- `end else begin` 写在同一行
- `always_ff` 只用 `posedge`
- 复位高有效
- **九个小节块一个不少、顺序不变**:Local Parameters / Types / Registers / Combinational Logic /
  Sequential Logic / Functions Module / Task Module / Module Instantiation / Assertions
- 每个 RTL 都要有设计断言,说明写清 Purpose / Trigger / Failure
- **一个 always 块里不混放不相关的信号** —— 除非它们共用同一套控制逻辑(同一状态机、同一事务
  生命周期、同一寄存器组控制)。说不清它们的关系就拆开
- 测试平台必须含 `$fatal` / `$error`:仿真失败要能被自动抓住,不得靠人看波形

## 产物

写 `<阶段根>/lint/lint.md`:

- **结论**:`PASS` / `FAIL` / `BLOCKED` / `NOT_APPLICABLE`
- 跑过的**命令原文**(可直接复制复现)
- 编译器报的 error / warning 逐条处理:改了哪里,或就地豁免的理由
- 逐条规范的核对结果;未通过的写清 `文件:行`
- `BLOCKED` 的情形:verilator 未就绪(设置里标了「未就绪」)→ 如实说明并停下,**不得假装跑过**
- `NOT_APPLICABLE`:`rtl/` 下还没有源码

结论与证据均须能指回去。**未跑 lint 即进仿真,等于把问题推到下游。**

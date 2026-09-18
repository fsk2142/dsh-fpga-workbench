---
name: fpga-lint
description: 写或改 RTL、查编码规范、定位 lint 或编译报错时用:对这个 FPGA 模块跑编译器检查、逐条核对规范(文件头、九个小节块、端口类型与对齐、制表符、行尾、设计断言、测试平台自检)。也可以随时只查一个文件、只看某一条告警。
---

# lint:编译检查与规范核对

**随时可跑,不必等 RTL 全部写完**:改一个文件就查一个文件,报错先定位再修;完整交付前再跑一次
全量。排查下游问题(仿真失败、综合报错)时也可以回头补查这一关 —— 但那是为了修问题,不是为了
"补齐流程"。

建议顺序是 lint 在仿真之前(能省下大量仿真排错时间),**但这不是拦路的关卡**:正在查仿真问题的
时候,不必先停下来补 lint。

## 前置

1. 找约定文件 `.fpga-workbench.json`(在模块根;找不到就问用户,见 `fpga-spec`)
2. 读 `spec/spec.md`:接口、判据、器件在那里 —— 规范检查的例外也要按它判
3. 确认要查的源码(默认 `rtl/` 下的 `.v` / `.sv`,递归)

## 第一步:编译器检查

**用设置里选的那个编译器**(会话开头那段「本机 FPGA 工具链」写了是哪个、路径是什么),
下面的命令以 Verilator 为例;选的是别的工具就换成它的用法。

```powershell
& "<编译器路径>" --lint-only -Wall --top-module <顶层模块名> <文件...>
```

- **只查 `rtl/`**,不要把 `ip/` 的仿真模型丢进去
- 报 `module not found`、而那个模块定义在 `ip/` 下 —— 这是正常的,它的定义不在 rtl/ 里。
  做法:把 IP 的端口 wrapper 一起传进去,或临时生成一个只有端口的黑盒 stub 加进命令行。
  **不要为了让 lint 过就改端口**
- 告警必须清零。确实要压的,在源码里**就地豁免**(`/* verilator lint_off XXX */` …
  `/* verilator lint_on XXX */`)并在旁边写明为什么;**禁止用 `-Wno-XXX` 全局屏蔽**

## 第二步:逐条对规范

**格式以模板为准** —— RTL / 测试平台 / 约束各有模板,用哪一份看会话开头那段「本机 FPGA 工具链」
里的模板那一节(你没提供就写的是插件自带那份),**先读模板再对**。下面是核对清单。

**机械的那部分先用自带命令跑一遍**(路径见会话开头那段「本模式自带的命令」):

```powershell
node "<自带命令目录>\check-rtl.mjs" <模块目录>
```

文件头、九个小节块、端口类型、复位极性、always_ff、end/else、断言、Tab、行尾、代码行非英文、
测试平台自检 —— 一次查完并给出**行号**。退出码 0 = 没有阻塞项(可能仍有警告) / 1 = 有阻塞项 /
2 = 用法或环境问题。

它判不了的,要你自己读:**一个 always 块里混放不相关信号**、断言写得对不对、命名与结构好坏。

**写 RTL 的时候就该照这些写**(照模板改),这里是写完后的核对。

格式类 —— 机械的,一眼能判:

- 禁 Tab
- 代码行禁非英文(注释例外)
- 行尾统一,一个文件里不许混

结构类 —— 要读代码判:

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
- 测试平台必须含 `$fatal` / `$error`:仿真失败要能被自动抓住,不能靠人看波形

## 产物

写 `<阶段根>/lint/lint.md`:

- **结论**:`PASS` / `FAIL` / `BLOCKED` / `NOT_APPLICABLE`
- 跑过的**命令原文**(能直接复制复现)
- 编译器报的 error / warning 逐条处理:改了哪里,或者就地豁免的理由
- 逐条规范的核对结果;没过的写清 `文件:行`
- `BLOCKED` 的情形:verilator 没就绪(设置里标了「未就绪」)→ 如实说明并停下,**不要假装跑过**
- `NOT_APPLICABLE`:`rtl/` 下还没有源码

结论和证据都要能指回去。**没跑 lint 就进仿真,等于把问题推到下游。**

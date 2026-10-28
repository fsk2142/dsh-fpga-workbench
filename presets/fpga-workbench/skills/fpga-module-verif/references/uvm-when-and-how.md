# 什么时候用 UVM，以及怎么用

## 先说结论：UVM 提的是「产能」，不是「发现力」

**UVM 本身不发现 bug** —— 它没有内建任何检查手段。它发现更多 bug，是因为**能跑更多、更随机的激励**。

决定发现率的是这个顺序：

| 手段 | 提升发现率 | 成本 | 说明 |
| --- | --- | --- | --- |
| **独立参考模型** | 最高 | 高 | 但容易与 RTL 同源错误（见下） |
| **SVA 断言** | 高 | **低** | 不重写功能，只陈述不变量 |
| **约束随机 + 多 seed** | 高 | 中 | 撞到人工想不到的组合 |
| CDC 静态检查 | 中高 | 低 | 仿真查不出 |
| 覆盖率驱动补用例 | 中 | 低 | 工具已有 |
| **UVM 框架本身** | **0** | 高 | 只是载体 |

所以：**先有断言和参考模型，再考虑用 UVM 把它们规模化。**

### 关于「参考模型也是自己写的，不也容易错」

对，这叫**同源错误**（common-mode failure）：RTL 作者和模型作者是同一人、同一套理解，
理解错的地方两边都错，测试照样通过。

按可靠性排：

1. **断言（SVA）** —— 最可靠。它不要求你重新实现功能，只要求陈述不变量
   （「`req` 后 3 拍内必须有 `ack`」）。即使功能理解有偏差，协议常识也不会写错。
2. **真实数据当黄金标准** —— 抓包、datasheet 示例、第三方实现（如 TCP 用 scapy 造包）。
   不依赖你的理解。
3. **不同路径实现模型** —— RTL 用 SV、模型用 Python。降低（不是消除）同源错误。
4. 手写参考模型 —— 最直接，也最容易同源错误。

**实用组合**：断言兜时序契约 + 真实数据兜功能 + 覆盖率兜「验够了没」。

## 什么模块值得上 UVM

| 模块类型 | 值得吗 | 理由 |
| --- | --- | --- |
| 总线/协议 IP（AXI 从机、DMA、以太网 MAC、TCP 栈） | ✅ **值得** | 激励空间大（长度/标志/序列号组合），需要随机 |
| 要跨项目复用的 IP | ✅ 值得 | agent 写一次到处用 |
| FIFO / 寄存器 / 简单 FSM | ❌ 不值 | 激励空间小，定向 TB 覆盖边界就够 |
| 单个算术/控制模块 | ❌ 不值 | UVM 会带来 2–3 倍样板代码 |

判断依据：**「人工能想到的用例是否已经基本穷尽」**。穷尽了就别上 UVM。

## 第一步：先自检环境

```
node "<自带命令目录>\module\module-verif-uvm-selftest.mjs"
```

它会查 vsim、UVM 库、C 编译器，然后**编译并跑一个 demo**，确认整条链路真通。

退出码：0 可用 / 1 demo 跑不通 / 2 用法错 / **3 环境缺失（BLOCKED）**。
3 与 1 要分开记 —— **环境缺失不等于设计有问题**。

## 第二步：生成骨架，改两处

```
node "<自带命令目录>\module\module-verif-new.mjs" <模块根> <模块名> --kind uvm
```

它把同目录的 `uvm-selfcheck.sv`（**已验证跑通**的完整骨架，含 demo DUT）复制到
`verif/tb_<snake>.sv`。骨架里没有模块名占位符，所以是纯复制 ——

**你要改的只有两处**：

1. **DUT**：把 `uvm_demo_dut` 换成自己的模块，interface 端口对应改
2. **参考模型**：`demo_scoreboard.write_out()` 里的期望值算法

其余（driver / monitor / env / test / sequence）的结构可以照抄。

> 为什么骨架放 `references/` 而不是 `templates/`：`templates/` 里每一项都是
> 「生成即用、只需填模块名」的填空模板，由 `check-preset-root` 逐一核对；而骨架
> **必然要改**（换 DUT、写参考模型）且要环境就绪。放 references 更诚实 ——
> 它是"起点样例"不是"填空模板"。但你不该为此多走一步手动复制，所以留了
> `--kind uvm` 入口。

## 七个实测坑（ModelSim SE-64 2020.4 + UVM 1.2，2026-10-28）

### 环境类（自检命令能查）

| # | 现象 | 解法 |
| --- | --- | --- |
| ① | `** Fatal: (vsim-7019) Can't locate a C/C++ compiler for 'DPI Export Compilation'` | **只把 gcc 加进 PATH 不够**，必须显式设 `MTI_C_COMPILER=<gcc.exe 路径>` |
| ② | `(vsim-7015) Signature mismatch (0 parameters vs. 1 parameters)`，`uvm-1.1d/.../uvm_svcmd_dpi.svh` 与 `uvm-1.2/...` 互相指责 | `-L` 的 UVM 版本**必须跟 `modelsim.ini` 的 `mtiUvm` 一致**。ini 通常写 `uvm-1.1d`，别硬用 1.2 |
| ③ | 编译期 `Failed to find uvm_pkg` | `vlog` 和 `vsim` **两头都要** `-L`，只给一头不够 |

### 写法类（自检查不出，但 demo 里是正确示范）

| # | 现象 | 解法 |
| --- | --- | --- |
| ④ | `Failed to find 'run_test' in hierarchical name 'run_test'` | **module 里也要 `import uvm_pkg::*`**，只写在 package 里不够 |
| ⑤ | `[RUNPHSTIME] No non-zero delays are allowed before run_test()` | `run_test()` 之前**不能有任何非零延时**；复位要放进 `run_phase` |
| ⑥ | `syntax error, unexpected "SystemVerilog keyword 'expect'"` | `expect` 是 SV 关键字，变量名改用 `exp_acc` 之类 |
| ⑦ | `(vlog-2892) Net type of 'clk' was not explicitly declared` | **UVM 模板里不要用 `` `default_nettype none ``** —— interface 的端口声明会被当成未声明网络 |
| ⑧ | `uvm_analysis_imp_in is not defined` | 一个 scoreboard 接多个 analysis port 时，先 `uvm_analysis_imp_decl(_in)` / `(_out)` |

## scoreboard 的关键设计（最容易做错的地方）

```systemverilog
// ❌ 错：直接拿 DUT 输出当期望值 —— 永远通过
expected = vif.dout;

// ✅ 对：monitor 同时采输入，scoreboard 用输入队列独立算
function void write_in(demo_item tr);  in_q.push_back(tr.din);  endfunction
function void write_out(demo_item tr);
  expected = 8'(exp_acc + in_q.pop_front());   // 与 DUT 是两条不同的路
  if (tr.din !== expected) err_cnt++;
endfunction
```

**为什么 monitor 要采输入**：只采输出的话，期望值只能靠猜，或者退回「拿 DUT 输出当期望值」——
那就变成自己跟自己比。输入队列是独立参考模型的前提。

**零样本必须报错**：`checks == 0` 时打 `NOCHECK` 错误。空跑通过是最危险的假绿
（与 `fpga-module-verif` 的判据一致）。

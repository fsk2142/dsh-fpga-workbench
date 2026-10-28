# Verilator lint：查 ModelSim 编译不报的那些

## 为什么值得单独跑

`vlog` 只报语法与部分语义错。下面这些它**不报**，但 Verilator 报：

| 类别 | 含义 | 常见后果 |
| --- | --- | --- |
| `UNUSEDSIGNAL` | 信号声明了没用 | **多半是拼写错或漏接** |
| `UNDRIVEN` | 没有驱动源 | 恒为 X/Z，静默传播到下游 |
| `WIDTHTRUNC` / `WIDTHEXPAND` | 位宽隐式截断 / 扩展 | 多数溢出 bug 的源头 |
| `LATCH` | `always_comb` 未覆盖全部路径 | 推出锁存器，换器件后行为变 |
| `CASEINCOMPLETE` | case 没覆盖全 | latch 的前兆 |
| `MULTIDRIVEN` / `BLKANDNBLK` / `COMBDLY` | 多驱动 / 组合环 | 综合结果与仿真不一致 |
| `SELRANGE` | 位选越界 | 读/写到不存在的位 |

这些在仿真里可能「碰巧跑对」—— 改参数、换器件时才炸。所以宁可现在看。

## 命令

```
node "<自带命令目录>\module\module-rtl-lint.mjs" <模块根>
```

扫 `<模块根>/rtl` 下所有 `.v` / `.sv`。

**退出码**：0 = 无 error 且无重要 warning；1 = 有问题；2 = 用法错；**3 = 环境不满足（BLOCKED）**。

3 与 1 分开是有意的：**没有 msys2 bash 不等于代码有问题**，别把它当 FAIL 记。

## Windows 上的路径陷阱（实测，2026-10-28）

本机的 Verilator 是 **msys2 包**，它的 `VERILATOR_ROOT` 是 **unix 路径**
（`/mingw64/share/verilator/...`）。三种调用方式实测结果：

| 方式 | 结果 |
| --- | --- |
| `msys2 bash -lc 'export PATH=/mingw64/bin:$PATH && verilator …'` | ✅ **唯一可靠** |
| 直接调 `verilator_bin.exe` | `--version` 能跑，但 lint 报找不到 `verilated_std.sv` |
| perl 包装（Windows 直调） | `Can't exec "verilator_bin"` |

所以命令**固定走 bash**，没 bash 时退 3 并说明原因。设 `VERILATOR_ROOT` 也没用 ——
Verilator 会报 "inconsistent path"（因为它是按自己的安装布局编的）。

## XPM 与 IP：默认忽略缺模块

Vivado 的 XPM（`xpm_fifo_*` / `xpm_cdc_*`）和 IP 核不在 Verilator 库里，会报一堆
`MODMISSING`。默认加 `-Wno-MODMISSING` 忽略，**但输出会明说「缺模块已忽略」** ——
别把那句当成「模块都找到了」。

要用 Verilator 查缺模块（比如怀疑漏了 `add_files`）时加 `--strict-modules`。

## 怎么判

**error** 必须修（多半是语法或不支持的构造）。

**重要 warning 逐条看**，不要一律当噪声 —— 尤其：

- `UNUSEDSIGNAL` 出现在**接口信号**上 → 检查是否拼错或漏连
- `UNDRIVEN` 出现在**输出**上 → 这个输出永远没有有效值
- `WIDTHTRUNC` 出现在**算术/赋值**里 → 确认截断是否符合意图（多数是 bug）
- `LATCH` → `always_comb` / `always @(*)` 有路径没赋值，**必须修**

**风格类**（未计入判定）可以忽略，但输出里会列出类别名，便于判断有没有漏掉重要的。

## 它查不到什么

- **功能对不对**（要用仿真 + 断言 + 比对）
- **时序**（要综合 + `report_timing`）
- **跨时钟域**（Verilator 不查 CDC，那要单独做）
- **XPM / IP 内部**（不在它的库里）

所以 lint 通过 ≠ 设计正确。它是**在仿真之前把低级错误挡掉**，省掉「仿真跑半天发现信号根本没接」这类往返。

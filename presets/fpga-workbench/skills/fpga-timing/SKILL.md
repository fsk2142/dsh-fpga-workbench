---
name: fpga-timing
description: Use when reading an FPGA module's post-synthesis timing report — checking whether the constraints were actually applied, judging whether timing is acceptable, explaining WNS/TNS or unconstrained-path warnings, working out why the report says there is no clock, or looking at CDC crossings. Covers the OBSERVE_ONLY policy, the constraint_status gate and CDC counts. Synthesis itself and review have their own skills.
---

# timing:时序

## 先说清这一关能证明什么

模块级时序是**综合后的估计**(没有布局布线)。所以:

- 这里量的是 `analysis_stage = post_synth` —— **物理实现不在本阶段范围内**
- 参考周期是**分析输入**,不是板级签核目标
- 真正的物理时序要等实现(布局布线)和实际板级约束。**不要把这里的结论说成"时序收敛了"**

## 判据:不是"频率达标",是"约束干净"

接受条件只有这三条:

1. `constraint_status = PASS` —— 约束真的被应用上了
2. 需要的时钟**都在**(缺一个都不行)
3. `missing_clock_count`、`unconstrained_path_count`、`no_clock_path_count` **全为 0**

`timing_exception_count` 记下来供审查;模块级 I/O 延迟属于 `MODULE_SCOPE_NOT_APPLICABLE`。

**没有统一的 200 / 250 / 300 MHz 阈值。** 实测 Fmax 是**记录下来的观察值**,不是门禁 ——
所以不要为了让某个数字好看去改约束。

## 三种容易混的结果

- **有合法时钟、但模块内部没有 setup 路径** → `NOT_APPLICABLE / no_internal_setup_path`。
  这是**正常情况**,不是失败(一个纯组合或纯寄存直通的模块就会这样)
- **报 `no_clock`** → 多半是**约束没被应用**:检查 XDC 里有没有 Tcl 控制流(`if`/`source`/`file`)——
  XDC 会 CRITICAL WARNING 后静默跳过,现象就是"没有时钟";其次检查时钟名是否与器件配置里的写法一致
- **`unconstrained_path_count > 0`** → 有路径没被约束。这算**失败**,不是提醒

## CDC(跨时钟域)

综合后跑 `report_cdc`,记下这几个数:未解决跨时钟、不安全跨时钟、被豁免的跨时钟、时钟域数量。

- **当前不接受 CDC 豁免**:有 waived 计数也算失败
- 命令不可用 → 记 `BLOCKED`,别当成"没有跨域"
- **CDC 永远不降级成"提醒"** —— 跨域没处理就是没处理

## 产物

写 `<阶段根>/timing/timing.md`:

- 结论 + 时序报告的文件名/路径
- 时钟清单:名字、周期、是否被约束到
- WNS / TNS,以及 `unconstrained` / `no_clock` 计数
- CDC 计数
- 违例路径的简表(起点 → 终点 → 裕量),太长就挑最差的几条并说明挑法

**违例不达标时不要改约束去凑数字。** 先判断是设计问题还是约束问题,并说清依据。

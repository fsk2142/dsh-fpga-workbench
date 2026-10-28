# 覆盖率门槛与 waiver

判 `PASS` 要同时满足**两条**门槛：

| 门 | 门槛 | 工具 |
| --- | --- | --- |
| **代码覆盖** | 语句 / 分支 / 状态机状态加权 **≥95%** | `module-verif-coverage.mjs` |
| **功能覆盖(AC)** | **= 100%**（标注「不适用本版本」的可剔除，但要写依据） | `module-verif-ac-trace.mjs` |

## 为什么两者门槛不同

代码覆盖剩下的 5% 通常是复位初始化、断言失败分支、参数化未用分支 —— 强行补到 100%
会写出一堆无意义用例。

但 **AC 不是**：spec 写了 8 条验收条件，覆盖 7.6 条没有意义。`95% × 10 条 AC = 9.5 条`
这个数字本身不可解释。

行业签核惯例把功能覆盖列为最难通过、也最不能打折的一道（见文末「依据」）。

## 类别取舍

| 类别 | 进门槛吗 |
| --- | --- |
| 语句 / 分支 | ✅ |
| 状态机状态 | ✅ |
| 条件 / 表达式 | ❌ 仅参考 |
| 状态机迁移 | ❌ 仅参考 |
| 翻转 / 扩展翻转 | ❌ 仅参考（几乎总是整体 waive） |

`module-verif-coverage.mjs` 会自动把「仅参考」的类别标出来并排除在门槛计算之外。

## 别手数 —— 有命令

```
node "<自带命令目录>\module\module-verif-coverage.mjs" <模块根> [--json]
node "<自带命令目录>\module\module-verif-ac-trace.mjs" <模块根> [--json]
```

前者读 ModelSim 的 `coverage.ucdb` 出代码覆盖率；后者读 spec 的 AC 与 `verif.md`，
列出哪些 AC 在报告里没有记录。**两者未达标都退 1。**

### 覆盖率数据怎么来的

模板（`modelsim_run.do`）的 `COVERAGE 1` 默认开启：

- `vlog` 带 `+cover=sbcef`（编译期统计类别）
- `vsim` 带 `-coverage`
- `run -all` **之前**注册 `coverage save -onexit coverage.ucdb`

**不要手写这套**。尤其 `coverage save` 必须下在 `run -all` 之前 ——
`-c` 模式下 TB 的 `$finish` 会**直接结束 vsim 进程**，之后的任何 Tcl 都不执行。
`onfinish` 看着更直观，但它只接受 `ask/default/exit/final/stop`，挂不了任意命令。

不想收覆盖率时把模板的 `COVERAGE` 设 0 换速度。

## AC 怎么写

`module-verif-ac-trace` **宽松解析**，下面几种都认（关键是能看出「ID + 描述」）：

```markdown
| ID   | 验收条件       | 验证方法 |
| AC-1 | 复位后 q 归零  | 仿真     |

- AC-1: 复位后 q 归零
- AC2 —— 计数到 10 进 DONE
1. AC_3 溢出置 sticky flag
**AC-4** 参数化位宽
AC 5 上电自检
```

ID 允许 `AC-1` / `AC_1` / `AC 1` / `AC1`。「不适用」标记写在**任意一格**都能识别
（描述列、验证方法列都行）。

## 未覆盖的每一处都必须写原因

三类之一：

1. **不可达** —— 有设计依据说明该分支永远不成立（如参数化后 `WIDTH<8` 的复位路径）
2. **防御性** —— 只在非法输入 / 硬件错误时触发，仿真无法构造
3. **待补** —— 本可覆盖但没写用例 → **这种情况不算达标**，仍记 `UNVERIFIED`

## 例外放行(waiver)必须记录三要素

这是**正式决定**，不是打折：

1. **哪个覆盖点**没命中（文件 + 类别 + 数量，或 AC 编号）
2. **为什么**（不可达 / 防御性 —— 要有设计依据）
3. **谁批准的**（用户确认的时间与结论）

写进 `verif.md` 的格式：

```
覆盖率例外:代码 91.3%
  未覆盖:rtl/cnt.sv 语句 3 处(bin 42-44)
  原因: 防御性 —— 只在非法 mode 组合时触发,上游 FSM 不可能产生
  批准: 用户 2026-10-28 确认
```

**「实际使用中不太可能」不是有效理由。**「不太可能」≠「不可达」——
行业规范明确这一点：burst 中途复位这类「罕见」场景，真实系统下电源管理 / 故障
就会触发，该补用例而不是 waive。

## 零样本

**零样本不等于 `PASS`。** `comp.py` 这类脚本报「比较结果相等」只是数据层事实 ——
两边都空、0 个样本时它照样退 0 说「相等」。有效样本是否存在由本技能判，
**样本数为 0 一律不得判 `PASS`**（覆盖率也是 0%）。

## 依据

2026-10-28 查证的行业签核惯例：签核是**多道门同时关闭** —— 代码覆盖、功能覆盖、
断言通过率 100%、零 S1/S2 缺陷、回归针对**冻结的 RTL 提交**全绿。

- 代码覆盖典型目标 90–100%，复杂块 95% + 记录的 waiver
- 功能覆盖通常要求关闭，未关的 bin 要逐个判断「是罕见角落还是真的不可达」
- waiver 必须含「哪个点、为什么、谁批准」，**未经评审的 waiver 是签核风险**

来源：[ChipVerify · Sign-Off Criteria](https://chipverify.com/verification/sign-off-criteria)、
[Verification Academy · 功能覆盖与代码覆盖的关系](https://verificationacademy.com/forums/t/if-both-functional-and-code-coverage-are-100-then-can-we-say-that-the-verification-is-complete/36125/6)

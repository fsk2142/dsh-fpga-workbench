# 覆盖率门槛与 waiver

## 四种覆盖,门槛不同

| 覆盖类型 | 量什么 | 门槛 | 谁统计 |
|---|---|---|---|
| **代码覆盖** | 语句 / 分支 / 状态机状态**被执行的比例** | **默认 ≥95%**,用户可要求更高 | 仿真器(`+cover=sbcef`) |
| **功能覆盖** | `covergroup` / `coverpoint` 定义的**激励空间命中率** | 同代码覆盖（默认 95%） | `covergroup` 由仿真器统计 |
| **AC 追溯** | spec 每条 AC 在 `verif.md` 里有没有交代 | **100%** | `module-verif-ac-trace.mjs` |
| **断言通过率** | SVA 断言整轮未违反 | **100%** | `vsim` 日志 |

**功能覆盖 ≠ AC 追溯。** 这是最容易混的一对:

- **AC 追溯**回答「每条验收条件**有没有被交代**」—— 形式是「AC-3: 用 tb_xxx 验过」
- **功能覆盖**回答「AC 里的**具体取值空间跑全了没**」—— 需要 `covergroup` 显式声明 bin

一条 AC 写成「长度 1~64 的传输都正确」,追溯过了(报告里写了怎么验的),但激励只跑了
长度 1 和 64 两个极端：**AC 追溯照样 100%,功能覆盖却漏了中间 62 个值**。
`covergroup` 才能把这种漏检暴露出来。

## 门槛:默认 95%,不自行加码

**默认 ≥95%**,判 `PASS` 即可。剩下的 5% 通常是复位初始化、断言失败分支、参数化未用分支 ——
强行补到 100% 会写出一堆无意义用例。

**用户要求更高时按用户的口径**,不在技能里预设档位:

| 用户可能的要求 | 怎么执行 |
|---|---|
| 「要到 98%」 | `--threshold 98` |
| 「必须 100%」 | `--threshold 100`;含义是「未覆盖项为零,或每项都有书面 waiver」 |
| 「只关心某个模块」 | 按该模块单独统计,不摊到全模块 |
| 「翻转覆盖也要」 | 加进门槛(默认翻转只报告不计) |
| 没提 | **按 95%,不自行加码** |

**不加码的理由**:把「仿真对、上板错就自动升到 98%」写成规则,等于用历史症状推当前门槛 ——
而该不该加严取决于模块的性质与用途,判断权在用户。

**可以提示用户加严的信号**(只是提示,不是自动升):

- 同一模块反复「仿真对、上板错」 → 激励空间可能没跑全
- 模块有多个工作模式 / 参数化配置 → 主模式覆盖好,旁路组合没跑
- 要进量产或作为可复用 IP 交付 → 用户通常会有更高要求

## 为什么 AC 追溯不能打折

代码覆盖剩下的 5% 往往无害,但 **AC 不是**:spec 写了 8 条验收条件,覆盖 7.6 条没有意义。
`95% × 10 条 AC = 9.5 条` 这个数字本身不可解释。

行业签核惯例把功能覆盖列为最难通过、也最不能打折的一道(见文末「依据」)。

## 类别取舍

| 类别 | 进门槛吗 |
| --- | --- |
| 语句 / 分支 | ✅ |
| 状态机状态 | ✅ |
| 条件 / 表达式 | ❌ 仅参考 |
| 状态机迁移 | ❌ 仅参考 |
| 翻转 / 扩展翻转 | ❌ 仅参考(几乎总是整体 waive) |

`module-verif-coverage.mjs` 会自动把「仅参考」的类别标出并排除在门槛计算之外。

## 别手数：有命令

```
node "<自带命令目录>\module\module-verif-coverage.mjs" <模块根> [--json]
node "<自带命令目录>\module\module-verif-ac-trace.mjs" <模块根> [--json]
```

前者读 ModelSim 的 `coverage.ucdb` 出代码覆盖率;后者读 spec 的 AC 与 `verif.md`,
列出哪些 AC 在报告里没有记录。**两者未达标都退 1。**

## 功能覆盖率怎么落地

在 TB 里声明 `covergroup`,由仿真器统计命中：不是靠人工数:

```systemverilog
covergroup cg_xfer @(posedge clk);
  cp_len: coverpoint len {
            bins one   = {1};
            bins short = {[2:8]};
            bins mid   = {[9:64]};
            bins long  = {[65:$]};
          }
  cp_error: coverpoint err_flag;
  cp_ready: coverpoint ready;
  cx_len_ready: cross cp_len, cp_ready;
endgroup
```

**要写哪些 coverpoint**:

| 维度 | 例 |
|---|---|
| 每个输入的**类别** | 长度区间、模式选择、错误类型 |
| **边界条件** | 空 / 满 / 单元素 / 最大值 / 0 |
| **有关联的信号对** | `len × ready`、`mode × err_flag`(必须用 `cross` 显式列) |

**只写 `coverpoint` 不写 `cross`,漏检最多**：单看每个信号都覆盖了,组合起来却有空缺。

### covergroup 与 `+cover` 是两个开关

**这是容易搞错的地方**:`+cover=sbcef` **只统计代码覆盖,不含 covergroup。**

| 选项 | 统计什么 |
|---|---|
| `+cover=sbcef` | **代码**覆盖:s 语句、b 分支、c 条件、e 表达式、f FSM |
| **covergroup 统计** | **功能**覆盖：由 TB 里的 `covergroup` 定义,需要单独开启 |

**具体开关名以本机 ModelSim/Questa 版本的命令参考为准**(不同版本写法不同,
常见为 `+cover=ug` 或在 `vsim` 时加 covergroup 相关选项)。

**本工具当前状态**:`module-verif-coverage.mjs` 只解析 `=== File:` 段下的代码覆盖类别,
**读不到 covergroup 段**(ModelSim 报告里是独立的 `=== Covergroup:` 段)。
功能覆盖率目前需要**看图工具(coverage report GUI)或手工读报告**,不自动判门槛 ——
这一点在写结论时要如实说明,不要把「代码覆盖达标」写成「覆盖率达标」。

### 覆盖率数据怎么来的

模板(`modelsim_run.do`)的 `COVERAGE 1` 默认开启:

- `vlog` 带 `+cover=sbcef`(编译期统计**代码**覆盖类别)
- `vsim` 带 `-coverage`
- `run -all` **之前**注册 `coverage save -onexit coverage.ucdb`

**不要手写这套**。尤其 `coverage save` 必须下在 `run -all` 之前 ——
`-c` 模式下 TB 的 `$finish` 会**直接结束 vsim 进程**,之后的任何 Tcl 都不执行。
`onfinish` 看着更直观,但它只接受 `ask/default/exit/final/stop`,挂不了任意命令。

不想收覆盖率时把模板的 `COVERAGE` 设 0 换速度。

## AC 怎么写

`module-verif-ac-trace` **宽松解析**,下面几种都认(关键是能看出「ID + 描述」):

```markdown
| ID   | 验收条件       | 验证方法 |
| AC-1 | 复位后 q 归零  | 仿真     |

- AC-1: 复位后 q 归零
- AC2：计数到 10 进 DONE
1. AC_3 溢出置 sticky flag
**AC-4** 参数化位宽
AC 5 上电自检
```

ID 允许 `AC-1` / `AC_1` / `AC 1` / `AC1`。「不适用」标记写在**任意一格**都能识别。

## 未覆盖的每一处都必须写原因

三类之一：

1. **不可达**：有设计依据说明该分支永远不成立(如参数化后 `WIDTH<8` 的复位路径)
2. **防御性**：只在非法输入 / 硬件错误时触发,仿真无法构造
3. **待补**：本可覆盖但没写用例 → **这种情况不算达标**,仍记 `UNVERIFIED`

## 例外放行(waiver)必须记录三要素

这是**正式决定**,不是打折：

1. **哪个覆盖点**没命中(文件 + 类别 + 数量,或 AC 编号)
2. **为什么**(不可达 / 防御性：要有设计依据)
3. **谁批准的**(用户确认的时间与结论)

写进 `verif.md` 的格式：

```
覆盖率例外:代码 91.3%(起步门槛 95% 未达)
  未覆盖:rtl/cnt.sv 语句 3 处(bin 42-44)
  原因: 防御性：只在非法 mode 组合时触发,上游 FSM 不可能产生
  批准: 用户 2026-10-28 确认
```

**「实际使用中不太可能」不是有效理由。**「不太可能」≠「不可达」——
行业规范明确这一点：burst 中途复位这类「罕见」场景,真实系统下电源管理 / 故障
就会触发,该补用例而不是 waive。

## 零样本

**零样本不等于 `PASS`。** `comp.py` 这类脚本报「比较结果相等」只是数据层事实 ——
两边都空、0 个样本时它照样退 0 说「相等」。有效样本是否存在由本技能判,
**样本数为 0 一律不得判 `PASS`**(覆盖率也是 0%)。

## 依据

2026-10-28 查证的行业签核惯例：签核是**多道门同时关闭**：代码覆盖、功能覆盖、
断言通过率 100%、零 S1/S2 缺陷、回归针对**冻结的 RTL 提交**全绿。

- 代码覆盖典型目标 90–100%,复杂块 95% + 记录的 waiver
- 功能覆盖通常要求关闭,未关的 bin 要逐个判断「是罕见角落还是真的不可达」
- waiver 必须含「哪个点、为什么、谁批准」,**未经评审的 waiver 是签核风险**

来源：[ChipVerify · Sign-Off Criteria](https://chipverify.com/verification/sign-off-criteria)、
[Verification Academy · 功能覆盖与代码覆盖的关系](https://verificationacademy.com/forums/t/if-both-functional-and-code-coverage-are-100-then-can-we-say-that-the-verification-is-complete/36125/6)

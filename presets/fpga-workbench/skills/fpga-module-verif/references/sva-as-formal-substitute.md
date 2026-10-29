# 用 SVA 断言替代形式化：本机能跑的高风险路径检查

> 这份文档替代「形式化证明」那一节。
>
> **为什么替代**：JasperGold / VC Formal / SymbiYosys 本机一个都没有，
> 而 ModelSim 的 SVA 断言**能真跑**。给一份跑不了的规则等于没写。

## 形式化证明能做什么，SVA 能做到哪一步

| 能力 | 形式化（JasperGold 等） | SVA + 仿真 | 本机可行 |
|---|---|---|---|
| 证明「永远不进入非法状态」 | ✅ 穷举所有输入序列 | ❌ 只能覆盖跑过的激励 | — |
| 发现「某条路径下会进非法状态」 | ✅ | ✅ **能，只要你跑到那条路径** | ✅ |
| 复位释放瞬间的状态合法性 | ✅ | ✅ 只要激励从复位边界开始 | ✅ |
| 多比特跨域的值一致性 | ✅ | ⚠️ 仿真不建模亚稳态，测不到 | ❌ |

**结论**：SVA 抓不到「穷举才发现的角例」，但能抓到**你写激励时想到的那些**
——而那已经覆盖了复位释放、状态机非法编码、握手超时这类高频问题。

**本机做不到的那一条**（多比特跨域的中间值）**不要用 SVA 假装覆盖**，
它属于 CDC 静态检查的职责，见 `fpga-module-rtl` 技能的
[跨时钟域与复位](../../fpga-module-rtl/references/cdc-and-reset.md)。

## 三条必写的断言

### ① 复位释放后，状态机不得进入非法编码

```systemverilog
// 放在状态机所在模块内
module fsm_assertions (
  input logic       clk,
  input logic       rst_sync_n,
  input logic [2:0] state
);
  // 合法编码 0..5，6 和 7 为非法
  property p_state_legal;
    @(posedge clk) disable iff (!rst_sync_n)
      state <= 3'd5;
  endproperty
  ap_state_legal: assert property (p_state_legal)
    else $error("[SVA] state=%0d 非法编码", state);

  // 复位释放后单拍不得跳转过远（防止从 0 直接跳到 5）
  property p_state_step;
    @(posedge clk) disable iff (!rst_sync_n)
      (state - $past(state)) inside {-1, 0, 1};
  endproperty
  ap_state_step: assert property (p_state_step)
    else $error("[SVA] 状态跳转过远：%0d -> %0d", $past(state), state);
endmodule
```

**注意 `disable iff (!rst_sync_n)`** —— 没有它，复位释放那一拍的 `$past` 是 X，
断言会误报。

### ② 握手不得单边等待

```systemverilog
  // req 拉高后，ack 必须在 N 拍内响应
  property p_handshake_timeout;
    @(posedge clk) disable iff (!rst_sync_n)
      $rose(req) |-> ##[1:HANDSHAKE_TIMEOUT] ack;
  endproperty
  ap_handshake_timeout: assert property (p_handshake_timeout)
    else $error("[SVA] 握手超时：req 拉高 %0d 拍后仍无 ack", HANDSHAKE_TIMEOUT);
```

这是**死锁的唯一可自动化探针** —— 仿真卡死时看这条断言报不报，能立刻区分
「握手没接上」和「别的地方慢」。

### ③ 跨域信号在目的域采样时已稳定

```systemverilog
  // 两级同步器之后的数据，在 valid 有效时必须已稳定 ≥2 拍
  property p_cdc_data_stable;
    @(posedge clk_dst) disable iff (!rst_sync_n)
      valid_sync |-> $stable(data_sync);
  endproperty
  ap_cdc_data_stable: assert property (p_cdc_data_stable)
    else $error("[SVA] 跨域数据在 valid 期间变化");
endmodule
```

**这条只能抓「设计上没hold住」**，抓不到亚稳态本身 —— 仿真不建模亚稳。
它的价值是防止「以为同步了、其实数据在跳」这类结构性错误。

## 怎么写进流程

### 位置

断言写在**被测模块内**或紧随其后的独立模块，不写在 testbench 里 ——
这样综合时可以选择保留（作为 `assert` 综合成逻辑）或排除。

本项目约定：与模块同目录，文件名 `<模块名>_assertions.sv`，
由 `module-verif-new --kind verif` 生成的 TB 自动 `include` 进来。

### 仿真时必须打开

ModelSim 默认就启用 `assert property`（不需要额外选项）。但要确认：

```tcl
# 检查断言是否真的被编译进去了
vsim -c tb -do "run -all"
# 输出里应有 "** Note: ** ASSERT" 或断言失败时的 "** Error"
```

**验证断言本身有效**：故意造一次违规，确认它真的报错。不报错的断言等于没写。

```bash
# 反例验证：把状态机强制改成非法值，断言必须报
node module-verif-xinit.mjs <模块根>    # 先确保仿真正常
# 然后在 TB 里临时加：force dut.state = 3'd7;
```

### 不要靠断言替代激励

断言只在**跑到那条路径时**才检查。状态机卡在 0 不动，`p_state_step` 永远满足，
但它什么都没证明。

所以断言是**补充**，不是替代：

| 手段 | 职责 |
|---|---|
| 激励 + 参考模型 | 功能正确性（该跑的都跑到） |
| 覆盖率 | 证明真的跑遍了 |
| **SVA 断言** | **不变量**（任何时候都不该违反的性质） |
| CDC 静态检查 | 结构正确性（仿真看不到的那部分） |

## 判据

- [ ] 每条断言都**故意违反过一次**，确认它真报错
- [ ] 状态机断言覆盖「非法编码」与「跳转过远」两项
- [ ] 每个握手接口都有超时断言（死锁探针）
- [ ] 跨域数据断言只用在「设计上应 hold」的信号上，不假装覆盖亚稳态
- [ ] 断言失败时的 `$error` 消息**能直接定位问题**（带信号值，不是只说「失败了」）

最后一条常被忽略：`assert property (p) else $error("failed")` 等于没写 ——
上板调试时你需要的是一条能看出「哪个信号、什么值」的消息。

## 本机验证记录

```bash
# ModelSim 2020.4 实测
vlog -sv dut.sv tb.sv          → 通过
vsim -c tb -do "run -all"      → assert property 生效
# 故意 force 非法状态          → ** Error 立即报出
```

实测结果（本仓库 `check-fpga-tools` 里固化了这 5 项）：

| 场景 | 结果 |
|---|---|
| 合法设计 | ✅ 断言不报，退 0 |
| **故意违规（`state=6`）** | ✅ **立刻报 `[SVA] state=6 非法编码`** |
| 是否算 Error | ✅ ModelSim 当 `** Error`，不是静默 Note |
| `vopt -O5` 优化后 | ✅ **断言仍然生效** |
| 反例验证 | ✅ 把断言条件改错后能重现问题 |

**`vopt -O5` 这条特别重要**：批处理模式默认走 `-O5`，
如果断言被优化掉，那它等于只有调试时才有效 —— 实测没有被优化掉。

本机的 `module-verif-new.mjs --kind verif` 生成的 TB 已包含断言骨架，
可以直接往里填三条必写断言。

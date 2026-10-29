---
name: fpga-module-verif
description: 验证 FPGA 模块功能、编写测试平台、运行仿真或独立比对时用;综合与时序转对应技能。
---

# module-verif:验证(跑出数据 → 独立比对 → 判归属)

**验证 = 运行 DUT + 执行独立判据。** 判据可以是参考模型/golden 比对、独立 scoreboard、
断言与协议检查或定向用例。**不得拿 DUT 输出当期望,不得以 0 样本或主观看波形判通过。**

拿不出判据记 `UNVERIFIED`,只有设计依据证明行为确实不适用才记 `NOT_APPLICABLE`。
不一致时先判归属(RTL / 测试平台 / 参照物),修复重跑;无法确认再问用户,不得放宽判据绕过。

## 前置

1. 从 `.fpga-workbench.json` 找模块根;找不到就询问
2. 读 `spec/spec.md` 的接口、时钟、AC、输入/输出路径、格式与「参考资料」
3. 有 Python 原型时优先用其建立独立参考模型/golden;建议读已有 `rtl/lint.md`

## 第一步:写测试平台

```
node "<自带命令目录>\module\module-verif-new.mjs" <模块根> <模块名> --template "<TB 模板路径>"
```

默认落 `verif/tb_<snake>.sv`(`UartRx` → `tb_uart_rx`);`--out` 可换位置。
扩展名跟模板走,先在设置里选对**仿真语言**(`.sv` / `.v` / `.vhd`)。

测试平台三条硬要求(写法在模板里,这里只写判据):

- **失败留可搜标记**:`$fatal(1, ...)` 产生 `** Fatal:` 行。只 `$display` 一句 FAIL 脚本搜不到
- **判定自动做**:每处不符 `$error(...)` 并累计,不靠人看波形
- **超时有人管**:无看门狗时挂死的仿真会一直挂着

结构化自检(握手成对、无 X、计数器不溢出、不死锁)写在 TB 里;**数据对不对不在这里判**。

## 第二步:跑出来(全程命令行)

运行前按选定的仿真器读 [仿真器与厂商库配方](references/simulator-recipes.md) ——
含 ModelSim / QuestaSim / XSim / Verilator 的调用方式与 XPM、厂商原语库处理。

### 先过 X 初态检查

跑仿真前先跑 `node module-verif-xinit.mjs <模块根>`。它查两类源头:

| 类 | 查什么 | 为什么重要 |
|---|---|---|
| A. 寄存器声明初值 | TB 里的 `logic rst_n = 0;` | 让仿真从确定值开始,「依赖初值」的 bug 永远跑不出来 |
| B. 存储器未 X 化 | RTL 里的 `logic [7:0] mem [0:255];` | **仿真器选项覆盖不到 BRAM / FIFO 数组**,X 的第一大来源 |

退 1 时:A 去掉声明处初值、按真实上电顺序驱动;B 用 `` `ifdef SIM_INIT_X `` 包一层,
**FIFO 读写指针也要一起 X 化**。脚本自动豁免 `$readmemh` / `.coe` 的存储器与 `rom` 类表。
**不要用 `force` 绕过**。那等于把要检验的假设又加回去。

判据与三档做法见 [X 初态仿真](references/x-init-simulation.md)。

## 第三步:检查输出与波形

需要落输出、查看波形或复核 dump 文件时，必须读 [输出、波形、独立比对与差异归属](references/comparison-and-evidence.md)，按 spec 的路径与格式处理，不得直接在 `verif/` 里另开 GUI 加载设计。

### 仿真警告

**编译、elaboration、运行期的警告都必须解决,不许留着。**

唯一例外:`rtl/ip/` 下的厂商仿真模型：在 `verif/verif.md` 里单列一节,说明属厂商模型、未修改。

**「仿真跑通了」不等于警告可以不管。** 一条被忽略的警告往往就是上板后的第一个故障。

## 第四步:独立比对并判归属

判定前继续按 [输出、波形、独立比对与差异归属](references/comparison-and-evidence.md) 执行。必须实际比过或执行独立 scoreboard / 断言与协议检查 / 定向用例；不一致时先判断 RTL、测试平台或参照物的归属，无法判定再问用户，不能自行放宽比对口径。

**SVA 断言不能省**。本机没有形式化工具（JasperGold / VC Formal /
SymbiYosys 全无），但 **SVA 在 ModelSim 上实测可用**，包括 `vopt -O5` 优化后仍生效。
三条必写：状态机非法编码、握手超时（死锁探针）、跨域数据稳定。
写法与本机实测记录见 [SVA 替代形式化](references/sva-as-formal-substitute.md)。

**断言写完必须故意违反一次，确认它真报错**：不报错的断言等于没写。

## 状态判定(唯一权威)

**判定词只有这一份定义**：人设、工作区规则、其它技能提到这些词时都引这张表,不再各自复述:

| 状态 | 含义(唯一权威) |
|---|---|
| `PASS` | 对**适用判据**执行了充分验证,并且有证据 |
| `FAIL` | 执行了有效检查,并且观察到**真实不符** |
| `BLOCKED` | 缺工具 / 依赖 / 权限 / 输入,无法继续 |
| `UNVERIFIED` | 尚未执行,或**证据 / 覆盖不足** |
| `NOT_APPLICABLE` | 有明确的设计依据说明该项检查**确实不适用**;**不得用来掩盖"无法验证"** |

**本环节每个词具体对应**:

| 词 | 本环节的判据 |
|---|---|
| `PASS` | 独立判据已执行且覆盖充分(取值逐个等价、**样本数 > 0**);TB 打出成功标记、日志无 `** Error:` / `** Fatal:` / `TB TIMEOUT`。写法不同但取值等价时先转换再比,不为格式卡住 |
| `FAIL` | TB 挂了(`** Error:` / `** Fatal:` / 超时 / 无成功标记),或比对存在不一致(给数量与位置) |
| `BLOCKED` | 仿真器未就绪、参考模型没实现、输入缺失、输出未生成;**退出码非零且日志无仿真结果**(Tcl 级错误) |
| `UNVERIFIED` | `verif/` 下没有 `tb_*`,或样本数为 0 / 覆盖不足 |
| `NOT_APPLICABLE` | 有设计依据说明本来无可验证行为。**拿不出判据是 `UNVERIFIED`,不是 N/A** |

**零样本不等于 `PASS`。** `comp.py` 报「相等」只是数据层事实：两边都空、0 样本时它照样退 0。
**脚本判"相等" ≠ 验证 `PASS`**。

**判成败靠日志与比对结果,不是退出码**:ModelSim 批处理下 `$fatal` 后退出码仍是 0(实测)。
run 模式里的 gate 负责把日志条目变成退出码：**有 gate 的脚本才可按退出码判**。

挂死或超时先查:时钟没起、复位没放、握手没接上、位宽对错。**不得第一反应调大看门狗。**

## 覆盖率门槛

**默认 ≥95%**。用户要求更高(98% / 100%,或指定某类覆盖必须满)时按用户的口径执行;
没有特别要求就按 95% 判,不自行加码。

四种覆盖,量的是不同的事:

| 覆盖类型 | 量什么 | 谁统计 |
|---|---|---|
| **代码覆盖** | 语句 / 分支 / 状态机状态**被执行的比例** | 仿真器(模板 `COVERAGE`)+ `module-verif-coverage.mjs` |
| **功能覆盖** | `covergroup` 定义的**激励空间命中率** | TB 里的 `covergroup`,仿真器统计 |
| **AC 追溯** | spec 每条 AC 在 `verif.md` 里**有没有交代怎么验的** | `module-verif-ac-trace.mjs` |
| **断言通过率** | SVA 断言整轮未违反 | `vsim` 日志 |

**AC 追溯 ≠ 功能覆盖。** 一条 AC 写成「长度 1~64 都正确」,报告里记了怎么验(追溯 100%),
但激励只跑长度 1 和 64：中间 62 个值没覆盖,追溯看不出来,`covergroup` 才能暴露。

### 别手数：有命令

```
node "<自带命令目录>\module\module-verif-coverage.mjs" <模块根>
node "<自带命令目录>\module\module-verif-ac-trace.mjs" <模块根>
```

前者读仿真器的覆盖率数据库;后者核 AC 追溯。**两者未达标都退 1。**

### 未覆盖必须逐条标原因

三类之一:**不可达**(有设计依据说明永远不成立)/ **防御性**(只在非法输入或硬件错误时触发)/
**待补**(本可覆盖但没写用例 → **不算达标**,仍记 `UNVERIFIED`)。

**waiver 三要素**:哪个覆盖点、为什么、谁批准。**「实际使用中不太可能」不是有效理由** ——
「不太可能」≠「不可达」。

**用户要求 100% 时**:100% 的含义是「未覆盖项为零,或每一项都有书面 waiver」,
不是「一行语句都没漏」。

### 功能覆盖率怎么落地

在 TB 里声明 `covergroup`,由仿真器统计：不是靠人工数:

```systemverilog
covergroup cg_xfer @(posedge clk);
  cp_len:   coverpoint len {
              bins one = {1};  bins short = {[2:8]};
              bins mid = {[9:64]};  bins long = {[65:$]};
            }
  cp_ready: coverpoint ready;
  cx_len_ready: cross cp_len, cp_ready;   // 交叉组合必须显式列
endgroup
```

**要写哪些 coverpoint**:每个输入的**类别**(长度区间、模式、错误类型)、每个
**边界条件**(空/满/单元素)、每对**有关联的信号**(用 `cross` 显式列)。
**只写 coverpoint 不写 cross,漏检最多。**

写法细节、类别取舍、`coverage save` 为何必须在 `run -all` 之前 ——
见 [覆盖率门槛与 waiver](references/coverage-and-waivers.md)。

## 要不要上 UVM

**UVM 提的是「产能」不是「发现力」**：它本身不发现 bug,靠的是能跑更多、更随机的激励。
判断依据是「人工能想到的用例是否已基本穷尽」:协议类 IP(总线/DMA/TCP)值得,
FIFO / 寄存器 / 简单 FSM 不值(会带来 2–3 倍样板代码)。

**默认走定向 TB**(99 行、生成即用);确认要 UVM 时走三步:

```
# ① 先确认环境(退 3 = 环境缺失 BLOCKED,与「代码有问题」的 1 分开记)
node "<自带命令目录>\module\module-verif-uvm-selftest.mjs"

# ② 生成骨架(自带 demo DUT,已验证可编译)
node "<自带命令目录>\module\module-verif-new.mjs" <模块根> <模块名> --kind uvm

# ③ 改两处:换掉 demo DUT、把 scoreboard 的期望值算法换成 spec 对应的参考模型
```

骨架不是填空模板：它是**已跑通的起点**,证明环境好、结构对。七个实测坑、scoreboard 的
关键设计、骨架为何放 `references/` 而非 `templates/`：见 [什么时候用 UVM](references/uvm-when-and-how.md)。

**参考模型会错**(同源错误),可靠性排序:**SVA 断言 > 真实数据当黄金标准 >
不同路径实现模型 > 手写模型**。断言不重写功能,只陈述不变量,最不容易错。

## 产物

写 `<模块根>/verif/verif.md`:

- 结论(`PASS` / `FAIL` / `BLOCKED` / `UNVERIFIED` / `NOT_APPLICABLE`)
- 跑过的**命令原文**(或 `run.do` 路径),可直接复制复现
- PASS:PASS 标记那一行原文 / FAIL:错误列表 + 日志路径 + **归属判断** + 改了什么
- 输入 / 输出 / 格式(**照 spec**,改了说明原因)
- 判定手段:文件比对(样本数 + 不一致数与位置 + 模型版本)/ 独立 scoreboard /
  断言与协议检查 / 定向用例
- **覆盖率**(判 `PASS` 必填):数值 + 分母 + 未覆盖项逐条原因。低于 95% 又放行时,
  标 `覆盖率例外` 并写理由与用户确认结果
- 覆盖了哪些 AC、哪些没覆盖(写"未覆盖",不得写"应该没问题")

**报告引用的每个路径都要真的在**：写 `PASS` 前跑一次证据校验:

```
node "<自带命令目录>\module\module-report-check.mjs" <模块根>
```

它核路径存在与内容摘要(不判内容对不对);路径缺失为 FAIL,摘要变化为告警。
报告定稿后加 `--record` 记录当前摘要。已退役路径用普通叙述,不要写成反引号路径。

TB 源码、参考模型与比对脚本、本次结果(日志、波形、输出数据)都放 `verif/`,按文件名区分。

**本环节只证明"逻辑符合参照";时序与上板不在范围内。**

## 本环节要跑的命令(速查)

| 干什么 | 命令 | 在哪一节 |
|---|---|---|
| 起测试平台 | `module-verif-new.mjs <模块根> <模块名> --template "<TB 模板>"` | 第一步 |
| 起仿真脚本 | `module-verif-new.mjs <模块根> --kind sim-run --template "<脚本模板>"`(编译与运行同一份,只起一次) | 第二步 |
| 起比对脚本 | `module-verif-new.mjs <模块根> --kind comp` | 第四步 |
| X 初态检查 | `module-verif-xinit.mjs <模块根>` | 第二步 |
| 跑出来 | ModelSim/QuestaSim:`do run.do compile` 再 `do run.do run`;XSim:`xvlog`/`xelab`/`xsim` | 第二步 |
| 看波形 | `& "<仿真器路径>" -do "do run.do load"`(不加 `-c`) | 第三步 |
| 代码覆盖 | `module-verif-coverage.mjs <模块根>` | 覆盖率门槛 |
| AC 追溯 | `module-verif-ac-trace.mjs <模块根>` | 覆盖率门槛 |
| 核证据路径 | `module-report-check.mjs <模块根>` | 产物(写 `PASS` 之前) |

命令都在 `<自带命令目录>\module\` 下。比对脚本按 spec 约定自己写或复用参考模型,
不是一条固定命令：判法见第四步。

---
name: fpga-module-sim
description: 跑或排查 FPGA 模块的功能仿真时用:写或改测试平台、编译 RTL、命令行跑仿真器、判断一次仿真到底算不算过、或者查为什么失败/挂死/超时。包含测试平台自检契约(err_cnt + $fatal)、看门狗、输出数据格式、日志与波形落在哪。
---

# module-sim:功能仿真

**可以反复进出**:仿真失败 → 改 RTL 或测试平台 → 再跑,想跑几轮跑几轮。一次 FAIL 只是这次
没过,不是"这个环节结束"。工具不可用时也**不要伪造结果** —— 可以读代码、分析原因、写好待跑的
测试平台,并明确说"未验证"。

## 前置

1. 找约定文件 `.fpga-workbench.json`(模块根);找不到就问用户,见 `fpga-module-spec`
2. 读 `spec/spec.md`:接口、时钟、AC、比对方案(输入/输出路径与格式)在那里 —— 测试平台照着它写
3. **建议**先看 `lint/lint.md` 是不是 PASS(先过 lint 能省下大量仿真排错时间)—— 但正在排查
   仿真问题、或用户就是要先看仿真行为时,不必停下来补 lint
4. 测试平台模板路径看会话开头那段「本机 FPGA 工具链」的模板那节(`tb.sv`),照它的格式写

**没有测试平台 ≠ 仿真"不适用"**:如果当前目标就是要验证功能,那这是 `UNVERIFIED` 或
`BLOCKED`(缺工具/缺平台),不是 `NOT_APPLICABLE`。写一个出来通常才是答案。

## 跑一次仿真(全程命令行,不弹图形界面)

**先用设置里选的那个仿真器** —— 看会话开头那段「本机 FPGA 工具链」的**语言与工具**一节,
它写着仿真器是 ModelSim / Vivado XSim / Verilator,以及对应的路径。**不要自己另挑一个。**

**ModelSim / Questa(默认)**

```
cd <阶段根>/verif/sim
vdel -lib work -all          # 有旧 work 库就先删掉,别在残留库里编译
vlib work
vcom -2008 <VHDL 文件...>    # 只有混语言模块才需要
vlog -sv <源码...> <tb_*.sv>
vsim -c -voptargs="+acc=rn" tb_<模块名>
run -all
quit -f
```

**Vivado XSim**(选了它就用 Vivado bin 目录下的这三个命令)

```
cd <阶段根>/verif/sim
xvlog -sv <源码...> <tb_*.sv>
xelab -debug typical tb_<模块名> -s tb_sim
xsim tb_sim -runall
```

**Verilator**(只适合 lint 与快速回归:**没有时序**,不能拿来代替功能仿真)

```
"<verilatorPath>" --binary --timing -Wall --top-module tb_<模块名> <源码...> <tb_*.sv>
./obj_dir/Vtb_<模块名>
```

通用的几条:

- **`-c` / `-runall` 这类批处理开关必须加** —— 不加会弹出图形界面等人操作,无人值守就跑不下去
- **编译顺序:被例化的在前**。文件多了按层级从底往上排;顺序错了编译会报未解析的模块
- 要重复跑就写成一个脚本(`run.do` / `run.tcl`),命令原文跟着进结果文件
- 多个测试平台按 `tb_sub_*` → `tb_*` → `tb_top_*` 的顺序各跑一个进程(每个 `$finish` 结束一个进程)

## 测试平台必须有的三样(缺一样,这次仿真就不算数)

1. **自检**:每处不符 `$error(...)` 并让 `err_cnt = err_cnt + 1`
2. **最终判定**:`err_cnt == 0` 打印成功标记(模板里是 `ALL TESTS PASSED (err_cnt=0)`);
   `err_cnt > 0` 必须 `$fatal(1, ...)` 走**非零退出** ——
   **只 `$display` 一句 FAIL 是不行的**,脚本抓不到失败,这条是硬红线
3. **看门狗**:`initial begin #(CLK_PERIOD * WATCHDOG_CYCLES); $fatal(1, "TB TIMEOUT"); end`
   —— 没有它,挂死的仿真会一直挂着,没人知道

## 输出数据:格式是红线

比对数据(如果这个模块有)写到 `spec` 里确认过的那个路径与格式,**不要自己改文件名或后缀**。

写十六进制要写**大写文本**:`$fwrite`/`$fdisplay` **不许用 `%x` / `%h`** —— 用 `%c` 加 ASCII 运算拼字符
(模板里有 `upnib` 那个函数)。原因很实际:比对按文本逐字节比,`%x` 的宽度与对齐不受你控制。

## 用什么模型

用 `ip/` 里**真实的** IP 仿真模型,不许拿简化版或快速桩顶上。仿真用桩、综合用真 RTL,
两边行为一旦不一致,你会查很久,而且结论不可信。

## 判据

- **PASS**:`err_cnt = 0`,日志里出现成功标记,进程退出码 0
- **FAIL**:非零退出,或日志里出现 `$error` / `$fatal`,或超时 `TB TIMEOUT`
- **BLOCKED**:vsim 没就绪(设置里标了「未就绪」)→ 如实说明并停下,不要假装跑过
- **NOT_APPLICABLE**:`verif/sim/` 下还没有 `tb_*.sv`

挂死或超时时,先怀疑:时钟没起、复位没放、握手没接上、位宽对错。**别第一反应就是调大看门狗。**

## 产物

写 `<阶段根>/sim/sim.md`:

- 结论(`PASS` / `FAIL` / `BLOCKED` / `NOT_APPLICABLE`)
- 跑过的**命令原文**(或那个 `run.do` 的路径),能直接复制复现
- PASS 时:成功标记那一行原文
- FAIL 时:错误列表 + 日志路径 + 你判断的原因(以及改了什么)
- 覆盖了哪些 AC、哪些没覆盖(没覆盖就写"未覆盖",不要写"应该没问题")

日志、波形、输出数据都落 `sim/`,**不要留在 `verif/sim/`** —— 那里只放源码与脚本。

这个阶段只能证明"逻辑符合测试平台"。时序和上板不在这一阶段。

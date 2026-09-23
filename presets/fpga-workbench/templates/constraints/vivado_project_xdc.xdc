# ============================================================================ #
# project.xdc - 工程约束骨架(工程 synth / impl 用)                            #
# ============================================================================ #
# 与模块版(constraints/vivado_module_xdc.xdc)的分工:
#   * 模块版管**一个模块自己的时钟** —— 让模块能单独跑综合与时序,不涉及板级引脚。
#   * 工程版管**整块板子**:全工程的时钟、引脚分配、IO 时序。引脚以 `sch/` 里的原理图为准。
#
# XDC 是**约束文件、不是 Tcl 脚本**:Vivado 只认约束命令(create_clock / set_property ...)。
# 控制流(if / source / file exists)会被当成 CRITICAL WARNING 拒掉、约束被**静默跳过** ——
# 带时钟的设计于是报 "no_clock"。要分支请写 Tcl 脚本去 source 本文件。
#
# 用法:本文件放在工程 `xdc/` 下,由工程引用(external reference),**不要拷进 prj/ 工程目录**。
# 下面每一条都给出可直接打开的写法;**占位内容一律留在注释里**,保证本文件本身能被 read_xdc 接受。
# ============================================================================ #

# ---- 1) 主时钟(按板上的实际频率改周期;写法与模块版一致) ------------------ #
create_clock -period 10.000 -name clk [get_ports clk]

# ---- 2) 由主时钟派生的时钟(用 PLL/MMCM 输出时打开对应一条) ---------------- #
# create_generated_clocks -name -divide_by / derive_pll_clocks 之类的写法按 Vivado 版本选;
# 常用组合:create_clock 打主时钟 + create_generated_clock 描述 PLL 输出。

# ---- 3) 异步复位/异步输入:告诉工具不用做时序检查 -------------------------- #
# set_false_path -from [get_ports rst_n]

# ---- 4) 输入/输出延时(以原理图上的外部器件时序为准) ---------------------- #
# set_input_delay  -clock clk -max 3.000 [get_ports {din[*]}]
# set_input_delay  -clock clk -min 1.000 [get_ports {din[*]}]
# set_output_delay -clock clk -max 3.000 [get_ports {dout[*]}]
# set_output_delay -clock clk -min 1.000 [get_ports {dout[*]}]

# ---- 5) 引脚分配(从 `sch/` 原理图或板卡用户手册抄;**编号必须与 bank 电压对得上**) - #
#   FPGA 侧引脚以封装引脚号(如 F14)或 IO 名称写;电平标准按 bank 的 VCCIO 选。
# set_property -dict {PACKAGE_PIN F14 IOSTANDARD LVCMOS33} [get_ports clk]
# set_property -dict {PACKAGE_PIN G15 IOSTANDARD LVCMOS33} [get_ports rst_n]
# 输出总线逐个引脚写(不要用通配符猜):
# set_property -dict {PACKAGE_PIN A10 IOSTANDARD LVCMOS33} [get_ports {cnt[0]}]
# set_property -dict {PACKAGE_PIN A11 IOSTANDARD LVCMOS33} [get_ports {cnt[1]}]

# ---- 6) 配置引脚与未用引脚(按板子需要打开) -------------------------------- #
# set_property CFGBVS VCCO [current_design]
# set_property CONFIG_VOLTAGE 3.3 [current_design]
# set_property BITSTREAM.CONFIG.UNUSEDPIN PULLNONE [current_design]

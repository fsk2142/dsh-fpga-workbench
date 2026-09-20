# ============================================================================ #
# run.do - <ModuleName> 的批处理仿真(verif 环节)                               #
#                                                                              #
# 跑法(**必须在 verif/ 下**):                                                  #
#   vsim -c -do "do run.do; quit -f"                                           #
#   cwd 必须是 verif/:TB 以相对路径读激励、写数据与逐行 dump。                  #
#                                                                              #
# **这份是 ModelSim / Questa 的**(命令名 vlog/vcom/vsim)。选 XSim 的话不要用它,  #
# 用 `fpga-module-verif` 技能里 XSim 那一节(xvlog/xelab/xsim 三步)。            #
#                                                                              #
# 这是**模板**(用 module-verif-new --kind run-do 起出来)。它把踩过的坑固化了,  #
# 那几段别删 —— 每一段下面都写了为什么:                                        #
#   * 收集**两处**:`rtl/` 下递归收的全部 HDL,**加上 `verif/` 下的 HDL** ——      #
#     厂商原语/IP 仿真库/包文件/辅助模块按 TB 模板与 verif 技能的约定就放        #
#     `verif/` 下,名字不带 `tb_`,TB_PATTERN 收不到;只收 rtl/ 的话一跑就是      #
#     "Module 'xxx' is not defined"。TB 由 TB_PATTERN 点名,按 basename 去重,   #
#     同名只编第一份(rtl/ 优先),不会编两遍。                                   #
#   * 收集时**跳过 `rtl/ip/` 下的 `*_stub.*`**:IP 自带的黑盒 stub 与真模型      #
#     **同名**,放它进编译会**静默覆盖真模型**(vlog 只给 Warning),整轮仿真跑在   #
#     空模块上、还打印成功标记。stub 是留给 lint 用的:原地不动,这里不编它,      #
#     且**把跳过的文件打出来**(不静默跳过)。                                   #
#   * 编译失败**硬失败**:catch 判定 + 非零退出码,绝不带着旧库往下跑。           #
#   * 仿真失败**非零退出码**:`$finish`/`$fatal` 会直接结束 vsim,所以要在         #
#     elaborate 之后 `onfinish stop`,让 `run -all` 之后的判定真的执行。          #
#                                                                              #
# **控制台/日志里的消息一律用英文**:ModelSim 的输出按本地代码页落盘,写中文会    #
# 变成乱码(实测),而 gate 要读这些行。注释用中文没关系(不会被打印)。           #
#                                                                              #
# 库与映射(实测语义,2026-09-20):                                              #
#   * `work` = 本地 `./work` —— ModelSim 的**内置默认映射**,vlog 自己建。       #
#     不 vlib、不 vmap、不往工作区外找库;删了 verif/work 下次自动重建。          #
#   * vendor 库/原语(unisims_ver 等)的映射来自一份 modelsim.ini:优先           #
#     `MODELSIM_INI` 环境变量(设置里填了「库映射文件」就指它),否则用安装目录    #
#     那份。实测:传 `-modelsimini` **不会**回写改坏那份 ini,`work` 仍是本地。   #
#                                                                              #
# 回归旋钮(不用改 TB):`$env:TB_DEFINES = "TB_TAP=7 TB_BP=1"`                    #
# ============================================================================ #
onbreak { resume }
# 任何 Tcl 层错误都算失败:非零退出码,别让"看着跑完了"蒙混过关
onerror { quit -f -code 1 }

# ============================================================================ #
# ==== 可改的地方(默认值就是常规布局,不改也能跑)====                         #
# 下面 5 个 set 是这份脚本**唯一**需要按项目调整的地方,每一项都注明了"是什么/     #
# 默认值什么意思/什么时候要改"。正文一律引用这些变量;不动它们 = 与出厂行为完全   #
# 一致(同样的收集集合、同样的跳过、同样的退出码)。                              #
# ============================================================================ #
# 1) RTL 目录:HDL 源从哪递归收。相对路径按 verif/ 解析,所以默认 ../rtl 就是
#    <模块>/rtl;填绝对路径也认(如 C:/proj/hw/rtl)。
#    什么时候改:HDL 不在 <模块>/rtl 下(共用工程目录、或路径不叫 rtl)。
set RTL_DIR {../rtl}
# 2) TB 匹配模式:在 verif/ 下按这个通配找测试平台。
#    默认 tb_*.sv = TB 叫 tb_*.sv 且落在 verif/ 下(常规布局)。
#    什么时候改:TB 命名不是 tb_ 前缀 / 扩展名不是 .sv;命中多个时仍旧只取排序
#    第一个当顶层,一个都没命中仍旧报错退出 1(与出厂一致,不因旋钮而变)。
set TB_PATTERN {tb_*.sv}
# 3) 顶层模块名覆盖:空 = 从 TB 文件名推导(出厂行为,文件 tb_foo.sv → 顶层 tb_foo)。
#    什么时候改:TB 文件名与里面的顶层模块名对不上(如文件叫 tb_foo.sv、模块叫
#    tb_dut_top),这时填实际模块名,elaborate 才找得到顶层。
set TOP_OVERRIDE {}
# 4) modelsim.ini 覆盖:空 = 走出厂顺序(先环境变量 MODELSIM_INI,再 MODELSIM,
#    都没有才用 ModelSim 安装目录那份)来解析 vendor 库/原语映射。
#    什么时候改:要**钉死**某一份库映射文件,不受环境变量影响。
#    填了但那份文件不存在,仍旧退回安装目录那份 —— 实际用的是哪份看下面
#    `[ME] modelsim.ini:` 那行。
set INI_OVERRIDE {}
# 5) 额外 include 目录:空 = 不传(出厂行为);填了才给 vlog 加 +incdir+。
#    是个 Tcl 列表,多个目录写成 {../inc ../common/inc};相对路径按 verif/ 解析,
#    交给工具前一律转成正斜杠(反斜杠里的 \t/\n 会被当转义吃掉,实测踩过)。
#    什么时候改:TB/RTL 里 `include 的文件不在 verif/ 或 rtl/ 下。
set EXTRA_INCDIRS {}

set SIM_DIR  [file normalize [pwd]]
set RTL_ROOT [file normalize [file join $SIM_DIR $RTL_DIR]]
set TB_FILE  [glob -nocomplain -directory $SIM_DIR $TB_PATTERN]

if {[llength $TB_FILE] == 0} {
    puts "\n\[ME\] ERROR: no $TB_PATTERN in $SIM_DIR"
    quit -f -code 1
}

# ---- 收集 HDL:rtl/ 与 verif/ 两处都收;rtl/ip/ 下的 *_stub.* 不编 --------- #
# 范围**只限 `rtl/ip/` 下**(用户定案):IP 自带的黑盒 stub 与真模型同名,进了
# 编译会静默覆盖真模型;而 `rtl/ipx/` 这种兄弟目录、以及 `rtl/` 别处的文件不替
# 用户判断,照收照编。
# **verif/ 也收**(递归):TB 模板与 verif 技能都把**仿真模型**约定放在 `verif/` 下
# (厂商原语/IP 仿真库/包文件/辅助模块),它们的名字不带 `tb_`,TB_PATTERN 收不到。
set ::SKIPPED_STUBS {}
# 前缀比较要**分隔符无关**:Tcl 的 file normalize 给的是正斜杠路径,而 [file separator]
# 在 Windows 是反斜杠 —— 直接拼会永远对不上(实测踩过:stub 静默不跳了)。
set IP_PREFIX "[string map {\\ /} [file normalize [file join $RTL_ROOT "ip"]]]/"

proc collect_hdl {dir} {
    set result {}
    if {![file exists $dir]} { return $result }
    # `.vhd` 与 `.vhdl` 都认:只认一个的话另一种会被**静默忽略**(实测踩过)
    foreach ext {.sv .v .vhd .vhdl} {
        foreach f [lsort [glob -nocomplain -directory $dir *$ext]] {
            # 只跳 rtl/ip/ 下的 stub:它和真模型同名,进了编译会静默覆盖真模型
            if {[string match "*_stub.*" [file tail $f]] && [string first $::IP_PREFIX [string map {\\ /} $f]] == 0} {
                lappend ::SKIPPED_STUBS $f
                continue
            }
            lappend result $f
        }
    }
    foreach sub [lsort [glob -nocomplain -directory $dir -type d *]] {
        foreach f [collect_hdl $sub] { lappend result $f }
    }
    return $result
}

set rtl_src [collect_hdl $RTL_ROOT]
# TB 由旋钮 2 单独点名(下面拼进来),同一条路径不在这里再收一遍 —— 否则去重会为它
# 自己打一行 "duplicate basename"(看着像有两个文件,其实就一个)
set verif_src {}
foreach f [lsort [collect_hdl $SIM_DIR]] {
    if {[lsearch -exact $TB_FILE $f] < 0} { lappend verif_src $f }
}

if {[llength $::SKIPPED_STUBS] > 0} {
    puts "\n\[ME\] skipped [llength $::SKIPPED_STUBS] stub file(s) under rtl/ip/ (lint use, not simulated):"
    foreach f $::SKIPPED_STUBS { puts "\[ME\]   $f" }
}

# 同名去重:IP 目录里常有同一份厂商文件(去重要打出来,别悄悄丢)。
# 顺序 rtl/ → verif/ → TB(确定性来自各组自己的排序):同一个 basename 两处都有时
# 留下的是 `rtl/` 那份(真源码优先于仿真模型)。**TB 也走这条去重** —— 它被 verif/
# 收一遍、又被 TB_PATTERN 点一遍,只留一份,不会编两次。
set seen {}
set kept {}
foreach f [concat [lsort $rtl_src] $verif_src [lsort $TB_FILE]] {
    set base [file tail $f]
    if {[lsearch -exact $seen $base] >= 0} {
        puts "\[ME\] duplicate basename skipped (kept the first): $f"
        continue
    }
    lappend seen $base
    lappend kept $f
}
set all_src $kept

# 判的是 **rtl/ 侧收上来的** $rtl_src,**不是** $all_src:verif/ 下也可能有 HDL,
# 拿 $all_src 判它永远非空 —— RTL 目录写错(旋钮 1)时会静默只编 TB 与模型、退出 0。
if {[llength $rtl_src] == 0} {
    puts "\n\[ME\] ERROR: no HDL source found under rtl/"
    quit -f -code 1
}

puts "\n\[ME\] Compiling [llength $all_src] file(s):"
foreach f $all_src { puts "\[ME\]   $f" }

# VHDL 归 vcom、其余归 vlog(混语言模块两者都要;原来一律塞给 vlog,VHDL 模块必挂)。
# `.vhd` 与 `.vhdl` 都要归到 vcom —— 收集认得、这里不认的话它会被塞给 vlog 而编译失败
set vhdl_src {}
set hdl_src {}
foreach f $all_src {
    if {[string match "*.vhd" $f] || [string match "*.vhdl" $f]} { lappend vhdl_src $f } else { lappend hdl_src $f }
}

# ---- 库映射文件:优先环境变量,否则安装目录那份 ------------------------- #
# 先用旋钮 4 的覆盖值(空则跳过);再用 `MODELSIM` / `MODELSIM_INI` 环境变量
# (`MODELSIM` 是 ModelSim 自己的变量,指向一份 ini;`MODELSIM_INI` 是本模板的别名,
# 便于"设置里填了「库映射文件」"时直接指过来);两个都没设 → 用安装目录那份。
set INI $INI_OVERRIDE
foreach var {MODELSIM_INI MODELSIM} {
    if {$INI eq "" && [info exists ::env($var)]} {
        set INI [string trim [set ::env($var)]]
    }
}
if {$INI eq "" || ![file exists $INI]} {
    set MTI_ROOT [file dirname [file dirname [file normalize [info nameofexecutable]]]]
    set INI [file join $MTI_ROOT modelsim.ini]
}
# 交给工具的路径**一律转正斜杠**:反斜杠里的 `\t`/`\n` 这类会被工具的参数解析当转义吃掉
# (实测:指向 `C:\...\.tmp\...` 的 ini 会让 vsim 打不开它、退出码 12;安装目录那份恰好没这种序列)
set INI_FWD [string map {\\ /} $INI]
puts "\[ME\] modelsim.ini: $INI_FWD"

# ---- TB 回归旋钮(不改 TB)-------------------------------------------- #
set tb_defs [list]
if {[info exists ::env(TB_DEFINES)]} {
    foreach d [split $::env(TB_DEFINES) " "] {
        if {$d ne ""} { lappend tb_defs "+define+$d" }
    }
}
if {[llength $tb_defs] > 0} { puts "\[ME\] TB defines: $tb_defs" }

# ---- 额外 include 目录(旋钮 5;空 = 一个参数都不加,与出厂行为一致)------ #
# 反斜杠**必须先整串转成正斜杠再拆列表**:`..\rtl` 这种一旦先拆列表,`\r` 就被当
# 转义吃成回车,转义/转换都来不及(实测踩过:vlog 报找不到设计单元 "tl")。
set inc_args [list]
foreach d [string map {\\ /} $EXTRA_INCDIRS] {
    if {$d ne ""} { lappend inc_args "+incdir+$d" }
}
if {[llength $inc_args] > 0} { puts "\[ME\] extra include dirs: $inc_args" }

# ---- 编译:失败即硬失败(catch 是唯一能判定成败的办法)----------------- #
# VHDL 走 vcom(只有混语言模块才会走到这);缺 vcom 的安装会在这里如实报错
if {[llength $vhdl_src] > 0} {
    puts "\[ME\] vcom [llength $vhdl_src] VHDL file(s)"
    if {[catch { vcom -quiet -2008 -work work {*}$vhdl_src } vcom_msg]} {
        puts "\n\[ME\] ERROR: vcom failed - refusing to simulate a stale library"
        puts "\[ME\] $vcom_msg"
        quit -f -code 1
    }
}

if {[catch { vlog -quiet -modelsimini $INI_FWD -sv {*}$tb_defs {*}$inc_args -work work {*}$hdl_src } vlog_msg]} {
    puts "\n\[ME\] ERROR: compilation failed - refusing to simulate a stale library"
    puts "\[ME\] $vlog_msg"
    quit -f -code 1
}

# ---- 仿真 ---------------------------------------------------------------- #
# 顶层模块:旋钮 3 填了就用它,空则从 TB 文件名推导(出厂行为)
if {$TOP_OVERRIDE ne ""} {
    set TOP $TOP_OVERRIDE
} else {
    set TOP [file rootname [file tail [lindex [lsort $TB_FILE] 0]]]
}
if {[catch { vsim -c -modelsimini $INI_FWD -l sim.log -voptargs=+acc=rn $TOP } vsim_msg]} {
    puts "\n\[ME\] ERROR: vsim failed to start: $vsim_msg"
    quit -f -code 1
}

# **必须在 elaborate 之后**:否则 $finish/$fatal 会直接结束会话,下面全成死代码
onfinish stop
run -all

# ---- run-level gate:退出码说了算,不靠"看着跑完了" --------------------- #
set errors 0
set passed 0
if {[file exists sim.log]} {
    set fh [open sim.log r]
    set text [read $fh]
    close $fh
    foreach line [split $text "\n"] {
        if {[string match "** Error*" $line] || [string match "** Fatal*" $line]} { incr errors }
        if {[string match "*ALL TESTS PASSED*" $line]} { incr passed }
    }
}

if {$errors > 0} {
    puts "\n\[ME\] ERROR: $errors Error/Fatal line(s) in sim.log - FAILED"
    quit -f -code 1
}
if {$passed == 0} {
    puts "\n\[ME\] ERROR: no success marker (ALL TESTS PASSED) in sim.log - FAILED"
    quit -f -code 1
}

puts "\n\[ME\] Simulation finished: sim.log + TB dumps in verif/"
quit -f

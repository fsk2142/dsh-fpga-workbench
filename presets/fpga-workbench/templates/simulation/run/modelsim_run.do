# ============================================================================ #
# ModelSim / QuestaSim template -- compile AND run in ONE file (2026-09-23)      #
# ============================================================================ #
# Usage (run from the module verif/ directory, or a project's root sim/):
#   vsim -c -do "do run.do compile; quit -f"
#   vsim -c -do "do run.do run;     quit -f"
#   vsim    -do "do run.do load"      # GUI session: same freshness gate, then load only
# The mode argument is required: guessing it would silently do the wrong thing.
#
# 为什么合成一份(用户口径 2026-09-23):原来 compile/run 两份模板有 41 行逐字重复
#(头部、RTL_DIR 自动识别、根链接拒绝、collect_hdl、ini 解析),而且**采集规则两边一旦不一致,
# run 的新鲜度复核就会误判**(实测:verif/ 下非 tb_* 的参考模型会被 stamp 记入、却被 run 的
# 复核漏掉 → 明明没变也要求重编)。一份文件 + 一个 collect_sources 就没有这个漂移面。
# 边界照旧:compile 只发现+编译、绝不启动仿真;run 只跑既有 work/、绝不编译。
#
# 加速一:编译走 **ModelSim 自己的增量**(`vlog -incr`,默认)。stamp 仍在本地记着上次编译的输入与
#   配置,负责回答"这个 work/ 还算不算当前源码/配置的产物";而"哪些 design unit 真需要重编"交给
#   仿真器 —— 谁 include 了哪个宏、谁 import 了哪个 package,在 Tcl 侧推不准。所以 Verilog/
#   SystemVerilog 是**把完整 source set 交给 vlog -incr**(实测:改了 package 参数会连带重编 import 方;
#   同 mtime 但长度变化的文件它也能看出来);**一个文件都没变时整段跳过 vlog**,零成本。
#   VHDL 一变就全量重编 vcom:VHDL 的 package/entity 依赖在 Tcl 侧同样推不准,少编一个依赖可能拿到
#   **过期的库**(不报错的错),宁可多编。想强制全量重编(不用 -incr):把 FULL_REBUILD 设成 1。
#   编译**顺序**:collector 按完整路径 lsort,所以"package 一定排在 consumer 前面"**不是保证**
#   (`aaa_dut.sv` 会排在 `cfg_pkg.sv` 前面)。不为这个再加一份配置文件(如 compile_order.txt):
#   编译失败时**自动重试一次** —— 失败那趟已经把 package/entity 编进 work/ 了,实测原命令重跑即
#   0 error;两次都失败才报错退 1(真语法错不会因为重试而被判通过)。
# 加速二:编译与 vopt 默认走 -O5。本机 ModelSim 2020.4 的 -help 实测:vlog/vcom/vopt 的
#   -O4 是默认("-O4 Enable most optimizations"),-O5 是"-O5 Enable additional compiler
#   optimizations";modelsim.ini 的 VoptFlow = 1(优化流程本来就开)。想退回工具默认就把
#   OPT_LEVEL 改成 {},完全不优化改成 {-O0}。
# 加速二之二:**批处理不带 `+acc`,只有 GUI `load` 带**(2026-09-24 实测,同一份 work/、同一份脚本、
#   只改这个旋钮;夹具 = 64 个叶子模块 / 20 万拍,本机 ModelSim 2020.4):
#     批处理 voptargs={-O5}           → 1547 ms(热态;首趟含 vopt 1845 ms)
#     voptargs={+acc=rn -O5}          → 4005 ms(热态;首趟 4276 ms) —— **2.3~2.6×**
#   为什么这样分得开:批处理的判据读的是 `sim.log` **文本**(成功标记与 `** Error` 行),自带 TB 写的
#   也**不是**波形而是 $fwrite 数据文件;内部信号可见性只有"人工看波形"才需要,而那件事走 `load`。
#   安全性也实测过:故意失败的断言夹具在**两种**配置下 run 都退 1(去掉 +acc 不会让 $error/断言被
#   优化掉,判据不受影响)。代价:批处理那次跑的模型**没有内部可见性** —— 想事后用 `wlf2vcd` 从
#   批处理的 wlf 出文本波形就不行了,改走 `load`,或临时把 BATCH_VOPT_ARGS 设回 {+acc=rn}。
#   速度收益随设计规模与仿真时长放大;本模板不宣称固定倍数(上表是夹具实测值)。
# 加速三:**头文件(.svh/.vh)进新鲜度集合,但不参与编译**。宏/include 在 vlog 那一步就已经展开,
#   头文件改了却不重编包含它的模块,work/ 就成了"对不上源码的旧库"且**不报错**;而旧版采集器只认
#   .sv/.v/.vhd/.vhdl,头文件根本不进 stamp → run 会把旧 work 判成 current。现在头文件记进 stamp,
#   且**头文件一变就全量重编 Verilog/SystemVerilog**(与 VHDL 同一条理由:依赖推不准,宁可多编;
#   只改头文件不涉及 vcom,所以 VHDL 不会因此被全量重编)。
# 编译身份(compile configuration identity):stamp 里除了每个输入的 mtime/size,还记**配置**
#   —— 仿真器 / modelsim.ini(路径 + mtime + size)/ TB_DEFINES / EXTRA_INCDIRS / VENDOR_LIBS /
#   OPT_LEVEL。**两边都用同一套比对**(config_diff):
#     · run / load:重算后不一致就退 1 要求重编;
#     · compile   :不一致(或证明不了身份)就**清库(work/)+ 全量重编所有语言**。
#   第二条是必须的:只查不编会造成**假新鲜** —— run 因配置变化拒绝 → compile 因源码没变而
#   "Nothing changed" → 却把新身份写进 stamp → 再 run 就放行了,而 work/ 还是旧配置编的
#   (2026-09-24 复核报告 P1,已修)。FULL_REBUILD=1 同样清库:`ifdef 关掉后旧 design unit
#   会残留在 work/ 里,只有清库才能让"当前源码 + 当前配置 = 当前库"三者真的对得上。
#
# Console text stays in English because older ModelSim releases write the local
# code page to transcripts and Chinese gate messages become unreadable.
#
# Knobs (edit this file; the mode comes from the command line):
#   RTL_DIR       HDL root relative to this script. module verif/ layout: {../rtl}
#                 project sim/ layout: {../src/rtl} (auto-switched when the first is missing)
#   FULL_REBUILD  1 = ignore the stamp and compile everything
#   OPT_LEVEL     compile + vopt optimization level. default {-O5}; {} = tool default (-O4)
#   BATCH_VOPT_ARGS  extra vopt args for the batch `run` (default {}: no visibility - the gate reads
#                    sim.log text; measured 2.3~2.6x faster than +acc=rn on this machine)
#   DEBUG_VOPT_ARGS  extra vopt args for the GUI `load` (default {+acc=rn}: keep signals visible)
#   TB_PATTERN    which files count as a testbench (F5-03: tb_notes.txt is not a TB)
#   TOP_OVERRIDE  testbench module to run when more than one TB matches
#   INI_OVERRIDE  force a library mapping file (else MODELSIM_INI env, else install default)
#   EXTRA_INCDIRS extra +incdir+ directories for compilation
#   VENDOR_LIBS   vendor / precompiled libraries, applied to BOTH vlog and vsim -L
#   RESULT_LOG    simulation transcript captured by vsim -l
#   Environment inputs: MODELSIM_INI / MODELSIM / TB_DEFINES
set RTL_DIR        {../rtl}
set FULL_REBUILD   0
set OPT_LEVEL      {-O5}
set BATCH_VOPT_ARGS {}
set DEBUG_VOPT_ARGS {+acc=rn}
set TB_PATTERN     {tb_*.sv tb_*.v tb_*.vhd tb_*.vhdl}
set TOP_OVERRIDE   {}
set INI_OVERRIDE   {}
set EXTRA_INCDIRS  {}
set VENDOR_LIBS    {}
set RESULT_LOG     {sim.log}

# ── 模式:必须显式给(没有参数 / 参数不认识 → 报用法,退 2,绝不猜) ────────────────
if {![info exists 1]} {
  puts "\n\[ME\] ERROR: missing mode argument."
  # 不写 [info script]:在 `do file.do` 环境下它取到的是 vsim 自己,不是脚本名(实测)。
  puts "\[ME\] usage: do run.do compile|run|load"
  puts "\[ME\]   compile - discover and compile sources into local work/ (never simulates)"
  puts "\[ME\]   run     - run the existing work/ library (never compiles)"
  puts "\[ME\]   load    - freshness-check and load work/ for a GUI session (never runs, never quits)"
  quit -f -code 2
}
set MODE [string tolower $1]
if {$MODE ne "compile" && $MODE ne "run" && $MODE ne "load"} {
  puts "\n\[ME\] ERROR: unknown mode '$1' (expected compile, run or load)"
  quit -f -code 2
}

# RTL_DIR default is the module layout {../rtl} (run from <module>/verif/). A project runs this from
# its root sim/, where RTL lives in ../src/rtl - switch only when the configured one is missing.
if {![file isdirectory [file join [pwd] $RTL_DIR]] && [file isdirectory [file join [pwd] ../src/rtl]]} {
  puts "\[ME\] RTL_DIR not found at {../rtl}; using project layout {../src/rtl}"
  set RTL_DIR {../src/rtl}
}

onbreak { resume }
onerror { quit -f -code 1 }

set VERIF_ROOT [file normalize [pwd]]
set RTL_ROOT   [file normalize [file join $VERIF_ROOT $RTL_DIR]]
# 根目录**自己**也不能是链接(E8-04 只挡了递归子目录):`rtl -> 工程外` 会让采集整个跑到外面,
# 结论就不再只覆盖工程内文件(Windows Junction 在 Tcl `file type` 上实测报 link)。
if {[file type $RTL_ROOT] eq "link"} {
  puts "\n\[ME\] ERROR: RTL_ROOT is a symlink/Junction; refusing to follow it: $RTL_ROOT"
  quit -f -code 1
}
set ::SKIPPED_STUBS {}
set ::IP_PREFIX "[string map {\\ /} [file normalize [file join $RTL_ROOT "ip"]]]/"

proc collect_hdl {dir {exts {.sv .v .vhd .vhdl}}} {
  set result {}
  if {![file isdirectory $dir]} { return $result }
  foreach ext $exts {
    foreach f [lsort [glob -nocomplain -directory $dir -type f *$ext]] {
      if {[string match "*_stub.*" [file tail $f]]
          && [string first $::IP_PREFIX [string map {\\ /} $f]] == 0} {
        lappend ::SKIPPED_STUBS $f
        continue
      }
      lappend result $f
    }
  }
  foreach sub [lsort [glob -nocomplain -directory $dir -type d *]] {
    # E8-04:`glob -type d` 也会把**链接目录**算进来 —— 顺着它会收进工程外的 HDL(来源不受控、
    # 证据不可复核),循环链接还会让递归打转。链接目录跳过并点名;跳过链接天然断环。
    if {[file type $sub] eq "link"} {
      puts "\[ME\] SKIP linked dir (not followed): $sub"
      continue
    }
    foreach f [collect_hdl $sub $exts] { lappend result $f }
  }
  return $result
}

proc same_file_content {a b} {
  if {[file size $a] != [file size $b]} { return 0 }
  set fa [open $a r]
  fconfigure $fa -translation binary
  set da [read $fa]
  close $fa
  set fb [open $b r]
  fconfigure $fb -translation binary
  set db [read $fb]
  close $fb
  return [expr {$da eq $db}]
}

# 只认 HDL 测试平台(F5-03):tb_notes.txt / 备份 / 笔记不算 TB
proc collect_tb {root pattern} {
  set tb {}
  foreach pat $pattern {
    foreach f [lsort [glob -nocomplain -directory $root -type f $pat]] { lappend tb $f }
  }
  return [lsort -unique $tb]
}

# **两个模式共用同一套采集规则**(这就是合并的收益):rtl/ + verif/ 的 HDL,同名文件只有内容
# 完全一致才允许去重,内容不同直接拒绝 —— 采集清单与新鲜度复核不可能再对不上。
# 返回 {kept vhdl sv v headers} 五元组:**headers 只进新鲜度集合,不交给 vlog**
# (.svh/.vh 是 include/宏的输入,单独编译它们没有意义;变了就全量重编,见文件头"加速三")。
proc collect_sources {rtl_root verif_root} {
  set rtl_src   [collect_hdl $rtl_root]
  set verif_src [collect_hdl $verif_root]
  set seen {}
  set kept {}
  foreach f [concat [lsort $rtl_src] [lsort $verif_src]] {
    set base [file tail $f]
    set at [lsearch -exact $seen $base]
    if {$at < 0} {
      lappend seen $base
      lappend kept $f
      continue
    }
    set first [lindex $kept $at]
    if {[same_file_content $first $f]} {
      puts "\[ME\] duplicate basename skipped (identical content): $f"
      continue
    }
    puts "\n\[ME\] ERROR: duplicate basename with DIFFERENT content: $base"
    puts "\[ME\]   $first"
    puts "\[ME\]   $f"
    puts "\[ME\] rename one file or remove the stale copy; refusing to hide either source."
    quit -f -code 1
  }
  set vhdl_src {}
  set sv_src {}
  set v_src {}
  foreach f $kept {
    if {[string match "*.vhd" $f] || [string match "*.vhdl" $f]} {
      lappend vhdl_src $f
    } elseif {[string match "*.sv" $f]} {
      lappend sv_src $f
    } else {
      lappend v_src $f
    }
  }
  # 头文件:只收进新鲜度集合(不比对内容、不进 vlog)。同名不同内容的两份头文件不在这里判重 ——
  # `include 到底拿到哪一份由 +incdir+ 搜索顺序决定,那本来就不是本模板能替用户拍板的事。
  set headers [lsort -unique [concat \
    [collect_hdl $rtl_root {.svh .vh}] \
    [collect_hdl $verif_root {.svh .vh}]]]
  return [list $kept $vhdl_src $sv_src $v_src $headers]
}

# 读上一次的编译 stamp:返回 path -> {mtime size}。没有/读不了就当空,于是全部算"变动"。
proc read_stamp {stamp_path} {
  set previous [dict create]
  if {![file isfile $stamp_path]} { return $previous }
  set fh [open $stamp_path r]
  set text [read $fh]
  close $fh
  foreach line [split $text "\n"] {
    set line [string trim $line]
    if {$line eq "" || [string match "#*" $line]} continue
    lassign [split $line "\t"] path mtime size
    if {$path ne ""} { dict set previous $path [list $mtime $size] }
  }
  return $previous
}

# 只读回 stamp 里的 `# cfg` 行(配置身份)。compile 用它判断"要不要清库全量重编"。
proc read_stamp_cfg {stamp_path} {
  set items {}
  if {![file isfile $stamp_path]} { return $items }
  set fh [open $stamp_path r]
  set text [read $fh]
  close $fh
  foreach line [split $text "\n"] {
    set line [string trim $line]
    if {[string match "# cfg *" $line]} { lappend items [string range $line 6 end] }
  }
  return $items
}

# 清空**当前目录下这份** work/ 库(配置变了 / FULL_REBUILD 时用)。
#   * 用 ModelSim 自己的 `vdel -lib work -all` + `vlib work`,不手写递归删除;
#   * work/ 本身是 symlink/Junction 就**拒绝** —— 清库会穿到工程外,那是数据丢失而不是"重建"
#     (与 RTL_ROOT 的链接守卫同一条口径);
#   * 只碰当前工作目录里的 work/,不接受任何路径参数。
proc clean_work_library {} {
  if {[file type work] eq "link"} {
    puts "\n\[ME\] ERROR: work/ is a symlink/Junction; refusing to clean it: [pwd]/work"
    puts "\[ME\] (cleaning through a link would wipe the target outside this project)"
    quit -f -code 1
  }
  # 只有**真是** ModelSim 库时才 vdel:work/ 可能是个空目录 / 只剩我们的 stamp(实测:那种情况下
  # `vdel` 报错退出,而它并不是"清不掉",是"本来就没有库")。库目录带 ModelSim 的 `_info` 标记。
  if {[file isfile [file join work _info]]} {
    if {[catch { vdel -lib work -all } message]} {
      puts "\n\[ME\] ERROR: vdel -lib work -all failed: $message"
      quit -f -code 1
    }
  } else {
    puts "\[ME\] work/ is not a ModelSim library (no _info); recreating it instead of vdel"
  }
  if {[catch { vlib work } message]} {
    puts "\n\[ME\] ERROR: vlib work failed: $message"
    quit -f -code 1
  }
}

# Mapping priority: explicit knob -> selected environment mapping -> simulator install.
# E8-09/A-1: an EXPLICITLY given mapping file must exist - refuse instead of silently falling back
# (otherwise you believe your ini took effect while another one did, and compile/run can even
# disagree with each other).
set INI $INI_OVERRIDE
set INI_EXPLICIT [expr {$INI ne ""}]
foreach var {MODELSIM_INI MODELSIM} {
  if {$INI eq "" && [info exists ::env($var)]} {
    set INI [string trim [set ::env($var)]]
    set INI_EXPLICIT [expr {$INI ne ""}]
  }
}
if {$INI_EXPLICIT && ![file isfile $INI]} {
  puts "\n\[ME\] ERROR: modelsim.ini not found: $INI"
  puts "\[ME\] This was given explicitly (INI_OVERRIDE / MODELSIM_INI / MODELSIM); refusing to fall"
  puts "\[ME\] back to the install default. Fix the path, or clear it to use the default library map."
  quit -f -code 1
}
if {$INI eq "" || ![file isfile $INI]} {
  set MTI_ROOT [file dirname [file dirname [file normalize [info nameofexecutable]]]]
  set INI [file join $MTI_ROOT modelsim.ini]
}
set INI_FWD [string map {\\ /} $INI]
puts "\[ME\] modelsim.ini: $INI_FWD"

# E8(item A-2): one knob for vendor / precompiled libraries, applied to BOTH vlog and vsim -
# leaving one side out can still fail with unresolved vendor references.
set vendor_args {}
foreach lib [split $VENDOR_LIBS " "] {
  if {$lib ne ""} { lappend vendor_args -L $lib }
}

set STAMP_PATH [file join work ".fpga-compile-stamp"]

# 编译一条命令(**失败就再试一次**;命令用 list 构造,所以路径带空格也不会串位):
#   顺序依赖最常见的形态是"先缺后补" —— collector 按完整路径 lsort 排序,`import` 了某个 package 的
#   文件可能排在 package 前面,第一趟 vlog 报 `Could not find the package (...)`;而那一趟**已经先把
#   package 编进 work/ 了**,所以同一条命令再来一次就是 0 error(2026-09-24 实测 ModelSim 2020.4:
#   反序 2 errors → 原命令重跑 0 errors → 库可用)。这里自动重试一次,把这类问题在**一条命令**里
#   消化掉 —— 显式 compile_order 文件因此暂时不必加(真出现 A→B→A 交叉依赖,重试也过不了再说)。
#   真·语法错会**两次都失败**,最终报第二趟的完整错误并退 1(不会因为重试而被判通过)。
proc compile_step {what cmd} {
  if {![catch {uplevel 1 $cmd} message]} { return }
  puts "\n\[ME\] $what: first attempt failed - retrying once (package/entity order cascade?)"
  puts "\[ME\]   [lindex [split $message "\n"] 0]"
  if {![catch {uplevel 1 $cmd} message]} {
    puts "\[ME\] $what: succeeded on the second attempt"
    return
  }
  puts "\n\[ME\] ERROR: $what failed twice - refusing to use a stale library"
  puts "\[ME\] $message"
  quit -f -code 1
}

# ── compile configuration identity(编译配置身份)─────────────────────────────── #
# 编译结果不只取决于源码:**用哪个仿真器 / 哪个 modelsim.ini(以及它有没有被改) / TB_DEFINES /
# EXTRA_INCDIRS / VENDOR_LIBS / OPT_LEVEL** 任何一个变了,work/ 就不再是"当前配置"的产物。
# 实测踩过的形态:把 TB_DEFINES 从 A 改成 B 直接 run —— 源码一个字节没动,work/ 被判 current,
# 跑的是按 A 编出来的库,而且**不报错**。所以这些也进 stamp,run 模式重算比对(比的不是 mtime,
# 是值本身);不一致就退 1 要求重编,绝不静默用旧库。
# 仿真器身份用 `[info nameofexecutable]`:实测 ModelSim 2020.4 给的是 <安装>/win64/vish.exe ——
# 换安装目录 / 换 Questa / 升级版本都会变,而库的兼容性正是跟着它走的。
proc config_identity {} {
  set items {}
  lappend items "exe=[info nameofexecutable]"
  lappend items "ini=$::INI_FWD"
  if {[file isfile $::INI]} {
    lappend items "ini_mtime=[file mtime $::INI]"
    lappend items "ini_size=[file size $::INI]"
  } else {
    lappend items "ini_mtime=-"
    lappend items "ini_size=-"
  }
  lappend items "opt=$::OPT_LEVEL"
  lappend items "defines=[expr {[info exists ::env(TB_DEFINES)] ? $::env(TB_DEFINES) : {}}]"
  lappend items "incdirs=$::EXTRA_INCDIRS"
  lappend items "vendor_libs=$::VENDOR_LIBS"
  return $items
}

# 把 "key=value" 列表变成 dict,好按 key 逐项比对(缺项 / 多项都要能报出来)。
proc config_pairs {items} {
  set out [dict create]
  foreach item $items {
    set at [string first "=" $item]
    if {$at < 0} {
      dict set out $item ""
    } else {
      dict set out [string range $item 0 [expr {$at - 1}]] [string range $item [expr {$at + 1}] end]
    }
  }
  return $out
}

# **两处共用同一套身份比对**:run/load 拿它判"库还算不算当前配置的产物",compile 拿它判
# "要不要清库全量重编"。只有一份实现,新增 identity 字段时不会两边漂移。
# 返回差异描述列表(空 = 一致)。
proc config_diff {old_items new_items} {
  set old [config_pairs $old_items]
  set new [config_pairs $new_items]
  set diff {}
  foreach key [lsort [dict keys $old]] {
    if {![dict exists $new $key]} {
      lappend diff "$key: was '[dict get $old $key]' -> now <absent>"
    } elseif {[dict get $old $key] ne [dict get $new $key]} {
      lappend diff "$key: was '[dict get $old $key]' -> now '[dict get $new $key]'"
    }
  }
  foreach key [lsort [dict keys $new]] {
    if {![dict exists $old $key]} { lappend diff "$key: was <absent> -> now '[dict get $new $key]'" }
  }
  return $diff
}

# ── compile:发现 + **增量**编译,绝不启动仿真 ──────────────────────────────────
if {$MODE eq "compile"} {
  set parts [collect_sources $RTL_ROOT $VERIF_ROOT]
  set kept [lindex $parts 0]
  set vhdl_src [lindex $parts 1]
  set sv_src [lindex $parts 2]
  set v_src [lindex $parts 3]
  set headers [lindex $parts 4]

  if {[llength $kept] == 0} {
    puts "\n\[ME\] ERROR: no HDL source found under rtl/"
    quit -f -code 1
  }
  set tb_files [collect_tb $VERIF_ROOT $TB_PATTERN]
  if {[llength $tb_files] == 0} {
    puts "\n\[ME\] ERROR: no $TB_PATTERN testbench in $VERIF_ROOT"
    quit -f -code 1
  }

  set stub_n [llength $::SKIPPED_STUBS]
  if {$stub_n > 0} {
    puts "\n\[ME\] skipped $stub_n stub file(s) under rtl/ip/ (lint use, not simulated):"
    foreach f $::SKIPPED_STUBS { puts "\[ME\]   $f" }
  }

  set define_args {}
  if {[info exists ::env(TB_DEFINES)]} {
    foreach d [split $::env(TB_DEFINES) " "] {
      if {$d ne ""} { lappend define_args "+define+$d" }
    }
  }
  set inc_args {}
  foreach d [string map {\\ /} $EXTRA_INCDIRS] {
    if {$d ne ""} { lappend inc_args "+incdir+$d" }
  }

  # 增量判定:与上次 stamp 比 (mtime, size)。work/ 不在 → stamp 读不到 → 全都算变动。
  # 头文件也算在内:它们虽然不编译,但决定"work/ 还算不算当前源码的库"。
  set previous [read_stamp $STAMP_PATH]
  set changed {}
  foreach f [concat $kept $headers] {
    if {![dict exists $previous $f]} { lappend changed $f; continue }
    set prev [dict get $previous $f]
    if {[lindex $prev 0] != [file mtime $f] || [lindex $prev 1] != [file size $f]} { lappend changed $f }
  }
  # VHDL 一变 → 全量重编 vcom(依赖推不准,宁可多编,不能拿过期的库)。
  set vhdl_changed 0
  foreach f $vhdl_src { if {[lsearch -exact $changed $f] >= 0} { set vhdl_changed 1; break } }
  # 头文件(.svh/.vh)一变 → 全量重编 Verilog/SystemVerilog:谁 include 了它,在 Tcl 侧推不出来。
  set hdr_changed 0
  foreach f $headers { if {[lsearch -exact $changed $f] >= 0} { set hdr_changed 1; break } }

  set fresh_work 0
  if {![file isdirectory work]} { vlib work; set fresh_work 1 }

  # 配置身份也要进"要不要真编"的判据(2026-09-24 复核报告 P1;这正是**假新鲜**的漏洞):
  # 之前 run 会因配置变化拒绝、compile 却因源码没变而什么都不编,然后把新身份盖进 stamp ——
  # 下一次 run 就放行了,而 work/ 其实还是旧配置编出来的。现在:配置变了(或证明不了身份)
  # 就**清库 + 全量重编** —— 光重编当前文件还不够:`ifdef 关掉之后旧 design unit 会残留在
  # work/ 里,清库才能让"当前源码 + 当前配置 = 当前库"三者真的对得上。
  set cfg_diff {}
  set config_changed 0
  if {!$fresh_work} {
    if {![file isfile $STAMP_PATH]} {
      set config_changed 1
      lappend cfg_diff "<no compile stamp> (library provenance unknown)"
    } elseif {[llength [read_stamp_cfg $STAMP_PATH]] == 0} {
      set config_changed 1
      lappend cfg_diff "<stamp carries no configuration identity> (written by an older template)"
    } else {
      set cfg_diff [config_diff [read_stamp_cfg $STAMP_PATH] [config_identity]]
      if {[llength $cfg_diff] > 0} { set config_changed 1 }
    }
  }
  if {$config_changed || $FULL_REBUILD} {
    clean_work_library
    if {$config_changed} {
      puts "\n\[ME\] compile configuration changed -> cleaning work/ and rebuilding every source:"
      foreach item $cfg_diff { puts "\[ME\]   $item" }
    }
    if {$FULL_REBUILD} { puts "\n\[ME\] FULL_REBUILD=1: cleaning work/ and compiling every source" }
  }
  set force_full [expr {$FULL_REBUILD || $fresh_work || $config_changed}]

  # VHDL:只有 VHDL 变了 / 清库全量才全量;头文件与 vcom 无关,不牵连它。
  if {$force_full || $vhdl_changed} {
    set vhdl_compile $vhdl_src
  } else {
    set vhdl_compile {}
  }
  if {$hdr_changed && !$force_full} {
    puts "\n\[ME\] header (.svh/.vh) changed: recompiling every Verilog/SystemVerilog source"
    puts "\[ME\] (which file includes which header cannot be inferred here; VHDL is untouched)"
  }

  # Verilog/SystemVerilog:**把完整 source set 交给 vlog -incr**(见文件头"加速一")。
  # 只有"这份 type 里一个文件都没变、没有头文件变更、不用清库全量"时才整段跳过。
  set sv_changed 0
  foreach f $sv_src { if {[lsearch -exact $changed $f] >= 0} { set sv_changed 1; break } }
  set v_changed 0
  foreach f $v_src { if {[lsearch -exact $changed $f] >= 0} { set v_changed 1; break } }

  if {$force_full || $hdr_changed || $sv_changed} {
    set sv_compile $sv_src
  } else {
    set sv_compile {}
  }
  if {$force_full || $hdr_changed || $v_changed} {
    set v_compile $v_src
  } else {
    set v_compile {}
  }

  set n_vhdl [llength $vhdl_compile]
  set n_sv   [llength $sv_compile]
  set n_v    [llength $v_compile]
  set opt_note [expr {$OPT_LEVEL eq "" ? "(tool default -O4)" : $OPT_LEVEL}]
  # 清库全量时不带 -incr:库已经空了,没有"可以跳过的旧 unit",带了只会掩盖意图。
  set incr_args {}
  if {!$force_full} { set incr_args {-incr} }
  if {$n_vhdl + $n_sv + $n_v == 0} {
    puts "\n\[ME\] Nothing changed since the last compile ([llength $kept] source(s) up to date)."
    puts "\[ME\] work/ is already current; set FULL_REBUILD 1 to force a full rebuild."
  } else {
    if {[llength $incr_args] > 0} {
      puts "\n\[ME\] vlog -incr: handing [expr {$n_sv + $n_v}] Verilog/SystemVerilog file(s) to ModelSim $opt_note"
      puts "\[ME\]   (it decides which design units need recompiling; unchanged units are skipped)"
    } else {
      puts "\n\[ME\] full rebuild: compiling [expr {$n_vhdl + $n_sv + $n_v}] of [llength $kept] file(s) $opt_note:"
    }
    foreach f [concat $vhdl_compile $sv_compile $v_compile] { puts "\[ME\]   $f" }
    if {$vhdl_changed && !$FULL_REBUILD && [llength $vhdl_src] > $n_vhdl} {
      puts "\[ME\] (VHDL changed: recompiling all [llength $vhdl_src] VHDL file(s) - VHDL deps cannot be inferred here)"
    }
  }

  # .v is Verilog-2001: compiling it with -sv reinterprets identifiers under the SystemVerilog
  # compilation group (an identifier that happens to be an SV keyword changes meaning).
  if {$n_vhdl > 0} {
    compile_step "VHDL compilation" \
      [list vcom -quiet {*}$OPT_LEVEL -2008 -modelsimini $INI_FWD -work work {*}$vhdl_compile]
  }
  if {$n_sv > 0} {
    compile_step "SystemVerilog compilation" \
      [list vlog {*}$incr_args -quiet {*}$OPT_LEVEL -modelsimini $INI_FWD -sv {*}$vendor_args {*}$define_args {*}$inc_args -work work {*}$sv_compile]
  }
  if {$n_v > 0} {
    compile_step "Verilog compilation" \
      [list vlog {*}$incr_args -quiet {*}$OPT_LEVEL -modelsimini $INI_FWD {*}$vendor_args {*}$define_args {*}$inc_args -work work {*}$v_compile]
  }

  # E8-07: record **all** compile inputs (not only the ones just recompiled) so the run mode can tie
  # work/ to the current sources. mtime + size only (portable, no platform hashing); a same-mtime
  # same-size edit could slip through - that is the documented DSH-10 trade.
  set stamp_fh [open $STAMP_PATH w]
  puts $stamp_fh "# compiled [clock format [clock seconds] -format {%Y-%m-%dT%H:%M:%S}]"
  # 配置身份(见 config_identity):run 模式会逐项比对,不一致就要求重编。
  set cfg [config_identity]
  foreach item $cfg { puts $stamp_fh "# cfg $item" }
  # kept = 编译单元;headers = 只参与新鲜度的 include/宏输入(见文件头"加速三")
  foreach f [concat $kept $headers] { puts $stamp_fh "$f\t[file mtime $f]\t[file size $f]" }
  close $stamp_fh
  puts "\[ME\] compile stamp: $STAMP_PATH ([llength $kept] source(s) + [llength $headers] header(s))"
  puts "\[ME\] compile identity:"
  foreach item $cfg { puts "\[ME\]   $item" }

  puts "\n\[ME\] COMPILE PASSED: local work/ is ready"
  quit -f -code 0
}

# ── run:只跑既有 work/,绝不编译 ────────────────────────────────────────────────
if {![file isdirectory work]} {
  puts "\n\[ME\] ERROR: local work/ library is missing - run the compile mode first"
  quit -f -code 1
}
# E8-07: work/ existing is not enough - it must match the CURRENT sources. The compile mode writes a
# stamp (mtime + size per input) plus the source SET; re-check both here and refuse on a mismatch.
# Contract (DSH-10): freshness = source set + mtime + size. It is NOT a content hash.
if {![file isfile $STAMP_PATH]} {
  puts "\n\[ME\] ERROR: no compile stamp in work/ ($STAMP_PATH) - run the compile mode first"
  puts "\[ME\] (without it the library cannot be tied to the current sources; no simulation verdict)"
  quit -f -code 1
}
set stamp_fh [open $STAMP_PATH r]
set stamp_text [read $stamp_fh]
close $stamp_fh
set stale {}
set stamped {}
set stamped_cfg {}
foreach line [split $stamp_text "\n"] {
  set line [string trim $line]
  if {$line eq ""} continue
  # 配置身份行先收走(# cfg <key>=<value>);其余 # 开头的注释直接跳过。
  if {[string match "# cfg *" $line]} {
    lappend stamped_cfg [string range $line 6 end]
    continue
  }
  if {[string match "#*" $line]} continue
  lassign [split $line "\t"] path mtime size
  if {![file isfile $path]} {
    lappend stale "$path (gone)"
    continue
  }
  if {[file mtime $path] != $mtime || [file size $path] != $size} {
    lappend stale "$path (changed after compile)"
  }
  lappend stamped $path
}
# ── 配置身份比对(见 config_identity):值变了就等于换了编译配置,work/ 不再是当前配置的产物 ──
# 旧版模板写的 stamp 里没有这些行:证明不了配置 → 也算不一致(退 1 要求重编),不静默放行。
# 比对用与 compile 同一个 config_diff(只留一份实现)。
if {[llength $stamped_cfg] == 0} {
  puts "\n\[ME\] ERROR: this compile stamp carries no configuration identity (written by an older template)."
  puts "\[ME\] re-run the compile mode: vsim -c -do \"do run.do compile; quit -f\""
  quit -f -code 1
}
set cfg_diff [config_diff $stamped_cfg [config_identity]]
if {[llength $cfg_diff] > 0} {
  puts "\n\[ME\] ERROR: compile configuration changed after the last compile:"
  foreach item $cfg_diff { puts "\[ME\]   $item" }
  puts "\[ME\] the library in work/ was built with a different configuration; refusing to run it."
  puts "\[ME\] re-run: vsim -c -do \"do run.do compile; quit -f\" (that run cleans work/ and rebuilds everything)"
  quit -f -code 1
}
puts "\[ME\] compile identity: matches the last compile ([llength $stamped_cfg] item(s))"
# E8(item A-3): the per-file check cannot notice a NEWLY ADDED source (it only walks the stamped
# list). Re-collect with the SAME shared collector and compare SETS first. 头文件也在集合里 ——
# 新加一个 .svh 同样必须重编,不能被当成"源码没变"。
set cur_parts [collect_sources $RTL_ROOT $VERIF_ROOT]
set cur_sorted [lsort -unique [concat [lindex $cur_parts 0] [lindex $cur_parts 4]]]
set stp_sorted [lsort -unique $stamped]
if {$cur_sorted ne $stp_sorted} {
  puts "\n\[ME\] ERROR: the source set changed since the last compile - re-run the compile mode:"
  foreach f $cur_sorted {
    if {[lsearch -exact $stp_sorted $f] < 0} { puts "\[ME\]   + $f (added)" }
  }
  foreach f $stp_sorted {
    if {[lsearch -exact $cur_sorted $f] < 0} { puts "\[ME\]   - $f (no longer collected)" }
  }
  quit -f -code 1
}
if {[llength $stale] > 0} {
  puts "\n\[ME\] ERROR: work/ does not match the current sources - re-run the compile mode first:"
  foreach f $stale { puts "\[ME\]   $f" }
  quit -f -code 1
}

set TB_FILE [collect_tb $VERIF_ROOT $TB_PATTERN]
if {[llength $TB_FILE] == 0} {
  puts "\n\[ME\] ERROR: no $TB_PATTERN testbench in $VERIF_ROOT"
  quit -f -code 1
}
if {[llength $TB_FILE] > 1 && $TOP_OVERRIDE eq ""} {
  puts "\n\[ME\] ERROR: $TB_PATTERN matched [llength $TB_FILE] testbenches, but TOP_OVERRIDE is empty - refusing to pick one:"
  foreach f $TB_FILE { puts "\[ME\]   $f" }
  puts "\[ME\] set TOP_OVERRIDE to the compiled testbench module for this run."
  quit -f -code 1
}

if {$TOP_OVERRIDE ne ""} {
  set TOP $TOP_OVERRIDE
} else {
  set TOP [file rootname [file tail [lindex $TB_FILE 0]]]
}

# vopt 参数 = 该模式自己的旋钮 + OPT_LEVEL,作为**一个**参数交给 -voptargs。
# 批处理用 BATCH_VOPT_ARGS(默认空:快),GUI load 用 DEBUG_VOPT_ARGS(默认 {+acc=rn}:看得见信号)。
set VOPT_ALL [string trim "$BATCH_VOPT_ARGS $OPT_LEVEL"]

# ── load:同一个新鲜度门,只把设计装进 GUI 会话;绝不 run -all、绝不退出 ──────────────
# 用法是 `vsim -do "do run.do load"`(**不要** -c):父会话是 GUI,这里的 `vsim` 就是"装载设计"这条
# 命令,所以波形/库映射/顶层与 run 模式完全同源。校验没过就退 1,不开一个不可信的 GUI。
if {$MODE eq "load"} {
  set VOPT_ALL [string trim "$DEBUG_VOPT_ARGS $OPT_LEVEL"]
  puts "\[ME\] vsim load (GUI): top=$TOP voptargs={$VOPT_ALL}"
  if {[catch {
    vsim -modelsimini $INI_FWD -lib work {*}$vendor_args -voptargs=$VOPT_ALL $TOP
  } message]} {
    puts "\n\[ME\] ERROR: vsim failed to load the design: $message"
    quit -f -code 1
  }
  puts "\n\[ME\] DESIGN LOADED: $TOP (no run -all, no quit - drive the simulation from the GUI)"
  return
}

puts "\[ME\] vsim: top=$TOP voptargs={$VOPT_ALL}"
if {[catch {
  vsim -c -modelsimini $INI_FWD -lib work {*}$vendor_args -l $RESULT_LOG -voptargs=$VOPT_ALL $TOP
} message]} {
  puts "\n\[ME\] ERROR: vsim failed to start: $message"
  quit -f -code 1
}

# Must be set after elaboration. Otherwise $finish/$fatal terminates the session
# before this run-level gate can inspect the transcript.
onfinish stop
run -all

set errors 0
set passed 0
if {[file isfile $RESULT_LOG]} {
  set fh [open $RESULT_LOG r]
  set text [read $fh]
  close $fh
  foreach line [split $text "\n"] {
    if {[string match "** Error*" $line] || [string match "** Fatal*" $line]} {
      incr errors
    }
    # E8-03:只认**完整成功行**;否定句/自述"没看到 marker"不得算通过
    set raw [string trim $line]
    if {[string match "# *" $raw]} { set raw [string trim [string range $raw 2 end]] }
    if {$raw eq "ALL TESTS PASSED (err_cnt=0)" || $raw eq "ALL TESTS PASSED"} { incr passed }
  }
}

if {$errors > 0} {
  puts "\n\[ME\] ERROR: $errors Error/Fatal line(s) in $RESULT_LOG - FAILED"
  quit -f -code 1
}
if {$passed == 0} {
  puts "\n\[ME\] ERROR: no success marker (ALL TESTS PASSED) in $RESULT_LOG - FAILED"
  quit -f -code 1
}

puts "\n\[ME\] SIMULATION PASSED: $TOP ($RESULT_LOG)"
quit -f -code 0

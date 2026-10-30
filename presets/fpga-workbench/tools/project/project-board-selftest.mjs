#!/usr/bin/env node
/**
 * 上板自检脚本生成器：把 L0–L3 的检查项写成可执行的 Vivado Tcl。
 *
 * ## 为什么不直接做成一键自检
 *
 * 指南 §6.4 给的骨架用 `pyjnius` 调 `hw_server`。**本机没装 pyjnius**，
 * 而 `vivado.bat` 与 `hw_server.bat` 都在 —— 所以这里生成 **Vivado Tcl**，
 * 由 vivado 自己执行，不引入任何额外依赖。
 *
 * 另一个原因：**寄存器映射每个项目都不同**。写一个"通用自检框架"会是纸面规则，
 * 因为它不知道怎么读你的寄存器。这里改成**生成带占位符的模板**，
 * 由使用者填入本项目真实的寄存器地址，然后由 Vivado 执行。
 *
 * ## 生成什么
 *
 * 一个 `.tcl` 文件，包含四段（对应 L0–L3）：
 *
 * - **L0 电源与配置**：读 `DONE` / `INIT_B`；提示手工测电源轨（硬件测量无法脚本化）
 * - **L1 时钟与 PLL**：读 each 时钟域的 `locked` 位
 * - **L2 复位释放**：软复位 → 读各状态机的状态寄存器，比对期望值
 * - **L3 寄存器读写**：写读回环 + 只读常量比对
 *
 * ## 验证状态（诚实标注）
 *
 * **已验证**：生成器的行为 —— 16 项断言覆盖生成路径、工程名提取、TODO 标注、
 * `--out` / `--json` / 错误输入、`--help` 退 0。
 *
 * **未验证**：**生成的 Tcl 脚本本身没有在真机上跑过**。原因：
 *
 * - 本机没有 Vivado 硬件连接（没接板子），`open_hw_manager` 跑不起来
 * - 用 ModelSim 的 Tcl 解释器代跑**不可行** —— 实测两个死结：
 *   ① 引号未闭合时 `info complete` 仍判「完整」（它只看花括号层级）
 *   ② `open_hw_manager` 这类 Vivado 命令在 ModelSim 里必然报
 *      `invalid command name`，假阳性无法区分
 *
 * 所以：**这份 Tcl 是按其官方 API 写的骨架，不是"已验证可跑"的脚本**。
 * 首次使用时请先在真实板子上跑一遍，把报错反馈回来再修。
 *
 * 另外，脚本里的寄存器地址全是占位符（`0x00000000` + `TODO:`）——
 * 每个项目的寄存器映射都不同，这个生成器不可能替你填。
 *
 * ## 判据设计
 *
 * 每段都以明确的 PASS / FAIL 打印，**任一段 FAIL 就停**（不继续跑后面的级）——
 * 这正是指南强调的「L0/L1 失败时，后面几级的结果没有意义」。
 *
 * 退出码：0 = 模板生成成功；2 = 输入错误。
 *
 * ## 用法
 *
 * ```
 * node project-board-selftest.mjs <工程根> [--out <文件>] [--json]
 * ```
 *
 * 生成的文件里所有需要项目填的地方都标了 `TODO:`，并在运行前会检查是否还留着 TODO。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const usage = (code = 2) => {
  const write = code === 0 ? console.log : console.error;
  write("用法：node project-board-selftest.mjs <工程根> [--out <文件>] [--force] [--json]");
  write("");
  write("  生成 L0–L3 的 Vivado Tcl 自检脚本（本机无 pyjnius，故走 Vivado Tcl 路线）。");
  write("  生成后需填入本项目的寄存器地址（文件里标 TODO），再由 vivado 执行。");
  write("");
  write("  --force   目标已存在时也覆盖（默认不覆盖：那是填过参数的模板）");
  write("            覆盖前会留同目录 .bak-<时间戳> 快照，可恢复");
  write("");
  write("退出码：0 生成成功 / 2 输入错误 / 3 目标已存在且未加 --force（未改动任何文件）。");
  process.exit(code);
};

const parseArgs = (argv) => {
  const options = { root: "", out: "", json: false, force: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      options.out = argv[++i] ?? "";
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    // **N-01**：默认不覆盖已存在的目标（那是用户填过的模板）。
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") usage(0);
    rest.push(arg);
  }
  options.root = rest[0] ?? "";
  return options;
};

/**
 * 生成 Tcl 脚本。
 *
 * **为什么用 Tcl 而不是 Python**：`vivado.bat -mode batch -source <脚本>` 是官方支持的
 * 非交互执行方式，不需要装任何 Python 包；而且寄存器读写用的 `create_hw_axi_txn` /
 * `read_hw_axi` 本来就是 Tcl API，绕一层 Python 只是多一个失败点。
 */
const renderTcl = (projectName) => `# ─────────────────────────────────────────────────────────────────────────────
# 上板自检脚本（L0–L3）—— 由 dsh-fpga-workbench 生成
#
# 工程：${projectName}
# 生成时间：${new Date().toISOString()}
#
# ## 使用前必须做的事
#
# 1. 把所有标了 "TODO:" 的地方填成本项目真实的值
# 2. 确认 hw_server 能连上板子（Vivado 硬件管理器能 open_hw_target）
# 3. 运行：
#      vivado -mode batch -source board_selftest.tcl
#
# ## 判据
#
# 任一级 FAIL 就停下 —— L0/L1 没过时，后面几级的结果没有意义。
#
# ## 上板前四项硬件前置（P0）
#
# 每次上板前都要过，不是首次做完就算：
#   P0-1 板子在线：hw_server 能枚举到目标器件
#   P0-2 型号核对：读到的 part / IDCODE 与 doc/spec.md 完全一致
#   P0-3 只允许 JTAG 在线加载：不写 Flash、不改配置模式引脚
#   P0-4 bit 新鲜且匹配：bit 时间晚于最后一次源码改动
#
# P0 任一项不过就直接 exit 1，不进入 L0。
# **型号不符会烧板；旧 bit 上的调试全部作废。**
#
# ## 为什么 L0 的电源要手工测
#
# VCCO / VCCINT 的实际电压只能靠万用表或板载 ADC 读。脚本只能检查
# 那些**设计里有对应寄存器**的电压监测通道；没有就明确说"需手工测"，
# 不假装检查过了。
# ─────────────────────────────────────────────────────────────────────────────

set script_dir [file dirname [file normalize [info script]]]
set fail_count 0

# ── N-02：没证据的项单独计数，不能混进「通过」 ──
#
# 模板里凡是「地址还是占位符」「骨架未包含」这类分支，都不是验证通过，
# 而是**没验**。原来它们只打 WARN 就 continue，fail_count 保持 0，
# 收尾就宣布「L0–L3 全部通过」—— 那是最危险的假绿。
set unverified_count 0
set unverified_levels ""
set highest_verified "无（P0 之后的级都还没验证）"

# ── 上板前四项硬件前置用到的配置（TODO: 全部换成真实值）──────────────────

# 期望的器件型号，必须与 doc/spec.md 的 part 完全一致（如 xc7a100tfgg484-2）
set EXPECTED_PART "TODO:EXPECTED_PART"

# bit 文件路径与源码目录（用于新鲜度检查：bit 必须比最后改的输入新）
#
# 三个目录都要扫：只比 RTL 会漏掉 XDC 管脚/时钟改动与 IP 重新生成 —— 那些同样让 bit 失效。
set BIT_FILE [file join $script_dir ".." "bit" "TODO_TOP.bit"]
set SRC_DIR  [file join $script_dir ".." "src" "rtl"]
set XDC_DIR  [file join $script_dir ".." "xdc"]
set IP_DIR   [file join $script_dir ".." "ip"]

# ── 帮助函数 ────────────────────────────────────────────────────────────────

proc lv {level msg} {
    puts "\\[$level\\] $msg"
}

proc check {cond msg} {
    global fail_count
    if {!$cond} {
        puts "  ** FAIL: $msg"
        incr ::fail_count
    } else {
        puts "  ok: $msg"
    }
}

# **N-02**：记一项「没验」。
#
# 与 check 的区别：check 判的是「验了但不通过」，这个判的是「压根没验」。
# 两者都不能算通过，但原因不同、修法不同，所以分开计。
proc unverified {level msg} {
    global unverified_count unverified_levels highest_verified
    puts "  ?? UNVERIFIED: \\[$level\\] $msg"
    incr ::unverified_count
    if {![string match "*$level*" $unverified_levels]} {
        append unverified_levels "$level "
    }
    # 前面所有级都验过时才更新「最高可确认级别」
    # 这里只记录**本次进入过且没被标记未验证**的最高级，简化处理：不覆盖已记的
    if {$highest_verified eq "无（P0 之后的级都还没验证）"} {
        set highest_verified "P0（上板前四项硬件前置）"
    }
}

proc stop_if_failed {level} {
    global fail_count
    if {$fail_count > 0} {
        puts ""
        puts "\\n\\[$level\\] 有 $fail_count 项失败 —— 不继续后面的级。"
        puts "先修完这一级，否则后面几级的结果没有意义。"
        exit 1
    }
}

# 一级结束时调用：本级若已有未验项，就不该继续往下一级走。
proc gate_if_unverified {level} {
    global unverified_count
    if {$unverified_count > 0} {
        puts ""
        puts "  $level 有未验证项 —— 后续级的结果不可信，提前收尾。"
        return 0
    }
    return 1
}

# ── 连接硬件 ────────────────────────────────────────────────────────────────

lv INFO "连接 hw_server..."
open_hw_manager
connect_hw_server -url localhost:3121 -allow_non_jtag

set targets [get_hw_targets]
if {[llength $targets] == 0} {
    puts "** FAIL: 找不到 hw_target —— 检查 USB/JTAG 连接与 hw_server 是否在跑"
    exit 1
}
current_hw_target [lindex $targets 0]
open_hw_target

set devices [get_hw_devices]
if {[llength $devices] == 0} {
    puts "** FAIL: 找不到 hw_device —— 检查配置模式引脚与电源"
    exit 1
}
set dev [lindex $devices 0]
current_hw_device $dev
puts "  设备：$dev"

# ── P0：上板前四项硬件前置（任一项不过就停）────────────────────────────────
#
# 每次上板前都要过。型号不符会烧板；旧 bit 上的调试全部作废。

lv P0 "上板前四项硬件前置"

# P0-1 在线探测：能枚举到器件（上面已经走到这里，说明 hw_target/devices 都存在）
#
# 注意 check 的参数必须是**已求值的布尔值**。
# "check {表达式}" 传进去的是字符串字面量，if 里会被当成布尔值而抛
# "expected boolean value but got ..."（F-01，已用 tclsh 实测复现）。
# 所以一律写成 "check [expr {...}]"，与本文件后面几段的调用保持一致。
check [expr {[llength $devices] > 0}] "P0-1 板子在线：枚举到 [llength $devices] 个器件"

# P0-2 型号核对：读到的 PART 必须与 doc/spec.md 的 part 完全一致
#
# 为什么必须做：xc7a100t 的 bit 下到 xc7a35t 上，配置逻辑完全不同，可能损伤器件。
if {[string match "TODO*" $EXPECTED_PART]} {
    puts "  ** 跳过：P0-2 未配置 EXPECTED_PART（TODO）—— 上板前必须填上"
    incr ::fail_count
} else {
    if {[catch {set actual_part [get_property PART [current_hw_device]]} err]} {
        puts "  ** FAIL: P0-2 读不到器件 PART：$err"
        incr ::fail_count
    } else {
        check [expr {$actual_part eq $EXPECTED_PART}] \
            "P0-2 型号核对：实际 $actual_part / 期望 $EXPECTED_PART"
    }
}

# P0-3 只允许 JTAG 在线加载：本脚本只做 program_hw_devices（不写 Flash）
#
# 这里只是显式声明口径；真正的加载在下载环节。Flash 固化是独立动作，需用户确认。
lv P0 "P0-3 加载方式：JTAG 在线加载（不写 Flash、不改配置模式引脚）"

# P0-4 bit 新鲜且匹配：bit 的修改时间必须晚于最后一次源码改动
if {![file exists $BIT_FILE]} {
    puts "  ** FAIL: P0-4 找不到 bit：$BIT_FILE"
    incr ::fail_count
} else {
    set bit_mtime [file mtime $BIT_FILE]

    # 递归扫描所有影响 bitstream 的输入：RTL(含子目录)、XDC、IP。
    # 只扫根层会漏掉 src/rtl/core/*.sv 与 xdc/*.xdc 的改动（F-05）。
    #
    # **返回值而不是 upvar**：早先用 upvar 把累加器别名进来、递归时又把别名传下去，
    # 会变成「别名指向自己」而抛错（实测：脚本在 P0-3 之后就无声中断）。
    # 这种"自己传给自己的别名"在 Tcl 里不成立，改成每次返回当前最大值。
    proc newest_mtime {dir} {
        if {![file isdirectory $dir]} { return 0 }
        set acc 0
        foreach f [glob -nocomplain -directory $dir *] {
            if {[file isdirectory $f]} {
                set sub [newest_mtime $f]
                if {$sub > $acc} { set acc $sub }
            } else {
                if {[catch {file mtime $f} m]} { continue }
                if {$m > $acc} { set acc $m }
            }
        }
        return $acc
    }
    set newest_src 0
    foreach input_dir [list $SRC_DIR $XDC_DIR $IP_DIR] {
        set m [newest_mtime $input_dir]
        if {$m > $newest_src} { set newest_src $m }
    }

    if {$newest_src == 0} {
        # **不能跳过**：P0 是硬前置，源码不可读等于无法证明 bit 新鲜（F-04）。
        puts "  ** FAIL: P0-4 找不到任何源码输入（$SRC_DIR / $XDC_DIR / $IP_DIR 都为空或不存在）"
        puts "           无法证明 bit 是最新的 —— 手工确认后把对应目录指对，不要默认放过"
        incr ::fail_count
    } else {
        # **N-08**：这里只能证明「bit 比源码文件新」，证明不了「bit 由这份源码生成」。
        # 真正的来源一致性要靠 bit 归档时的 manifest（见 doc/impl.md 的建议条目）。
        #
        # 时间戳用 file mtime 的原始秒数呈现：clock format 依赖 Tcl 的 init.tcl，
        # 某些精简安装（只带 tclsh 不带库）会报 "invalid command name clock"。
        # 人读的时候对着秒数不方便，但**可读性不该让脚本在关键路径上崩**。
        check [expr {$bit_mtime >= $newest_src}] \
            "P0-4 bit 修改时间晚于源文件（bit=$bit_mtime / src=$newest_src，Unix 秒）"
        puts "       注意：这只说明文件时间新，**不证明** bit 由当前源/约束构建 —— 来源一致性需 bit 归档的 manifest 佐证"
    }
}

stop_if_failed P0

# ── L0：电源与配置 ──────────────────────────────────────────────────────────

lv L0 "电源与配置"

# DONE / INIT_B 是器件的硬件状态，不需要设计里有寄存器
set done_val [get_property REGISTER.IR.BIT12_DONE $dev -quiet]
if {$done_val eq ""} {
    lv WARN "  读不到 DONE —— 这个器件的属性名可能不同，请手工确认"
} else {
    check $done_val "DONE 已拉高（配置完成）"
}

unverified L0 "电源轨实际电压需万用表实测 —— 脚本读不到，这一级没有证据"
    puts "  TODO: 手工测量以下电源轨并填入期望值范围，脚本无法用万用表"
puts "    VCCINT  = ______ V   （期望 ____ ~ ____ V）"
puts "    VCCAUX  = ______ V   （期望 ____ ~ ____ V）"
puts "    VCCO_xx = ______ V   （期望 ____ ~ ____ V）"
puts "  → 若上面任一超范围，在这一级就停，不要往下走。"

stop_if_failed L0

# ── L1：时钟与 PLL ──────────────────────────────────────────────────────────

lv L1 "时钟与 PLL"

# TODO: 填入本项目每个时钟域的 PLL locked 状态寄存器
# 格式：{ 名字 基地址 偏移量 }
set clock_lock_regs {
    {core_clk  0x00000000  0x00}
    {ddr_clk   0x00000000  0x04}
}

set axi_master ""
foreach txn [get_hw_axi_txns -quiet] { delete_hw_axi_txn $txn -quiet }
create_hw_axi_txn -quiet axi_rd [get_hw_axis hw_axi_1] -address 0x0 -type read -len 1

foreach entry $clock_lock_regs {
    lassign $entry name base offset
    if {$base == 0x00000000} {
        unverified L1 "$name: PLL 锁定寄存器地址还是占位符（0x0）—— 这一级没有证据"
        continue
    }
    set addr [expr {$base + $offset}]
    set_hw_axi_txn_addr axi_rd $addr
    run_hw_axi -quiet axi_rd
    set val [get_property DATA [get_hw_axi_txns axi_rd]]
    set locked [expr {$val & 1}]
    check [expr {$locked == 1}] "$name PLL locked（读到 0x[format %08x $val]）"
}

puts "  TODO: 各时钟的实测频率需要示波器/频率计，或用板载频率计数器寄存器："
puts "    TODO: 若设计里有频率计数寄存器，在这里读并比对标称值（误差 < 100 ppm）"

stop_if_failed L1

# ── L2：复位释放 ────────────────────────────────────────────────────────────

lv L2 "复位释放与初始状态"

# TODO: 填入各状态机的状态寄存器
# 格式：{ 名字 基地址 偏移量 期望值 }
set state_regs {
    {main_fsm  0x00000000  0x10  0x0}
    {dma_fsm   0x00000000  0x14  0x0}
}

# 触发软复位（如果设计里有这个寄存器）
set soft_rst_addr 0x00000000
if {$soft_rst_addr != 0x00000000} {
    set_hw_axi_txn_addr axi_rd $soft_rst_addr
    # TODO: 这里应改成 write 事务；骨架用 read 演示流程
    unverified L2 "软复位寄存器地址已填，但写事务需按本项目 AXI 结构实现 —— 复位释放未验证"
} else {
    unverified L2 "未填软复位寄存器地址 —— 复位释放未验证（不能假定）"
}

after 10

foreach entry $state_regs {
    lassign $entry name base offset expected
    if {$base == 0x00000000} {
        unverified L2 "$name: 状态寄存器地址还是占位符 —— 这一级没有证据"
        continue
    }
    set addr [expr {$base + $offset}]
    set_hw_axi_txn_addr axi_rd $addr
    run_hw_axi -quiet axi_rd
    set val [get_property DATA [get_hw_axi_txns axi_rd]]
    check [expr {$val == $expected}] "$name 复位后状态 = 0x[format %x $val]（期望 0x[format %x $expected]）"
}

stop_if_failed L2

# ── L3：寄存器读写 ──────────────────────────────────────────────────────────

lv L3 "寄存器读写"

# TODO: 填入一组安全的测试寄存器（写错不会影响功能的）
# 格式：{ 名字 地址 测试值 }
set test_vectors {
    {scratch0  0x00000000  0xDEADBEEF}
    {scratch1  0x00000000  0x12345678}
}

# TODO: 填入只读常量寄存器
set ro_constants {
    {device_id  0x00000000  0x5A5A0001}
    {version    0x00000000  0x00010000}
}

foreach entry $test_vectors {
    lassign $entry name addr pattern
    if {$addr == 0x00000000} {
        unverified L3 "$name: 地址还是占位符 —— 这一级没有证据"
        continue
    }
    unverified L3 "$name 写读回环需按本项目 AXI 写事务实现（骨架未包含）"
}

foreach entry $ro_constants {
    lassign $entry name addr expected
    if {$addr == 0x00000000} {
        unverified L3 "$name: 地址还是占位符 —— 这一级没有证据"
        continue
    }
    set_hw_axi_txn_addr axi_rd $addr
    run_hw_axi -quiet axi_rd
    set val [get_property DATA [get_hw_axi_txns axi_rd]]
    check [expr {$val == $expected}] "$name = 0x[format %x $val]（期望 0x[format %x $expected]）"
}

stop_if_failed L3

# ── 收尾 ────────────────────────────────────────────────────────────────────

close_hw_target
disconnect_hw_server
close_hw_manager

puts ""
puts "=========================================="

# **N-02：不能只看 fail_count 就宣布「全部通过」。**
#
# 模板里 L0 的电源实测、L1 的 PLL 锁定寄存器、L2 的状态寄存器、L3 的读写向量
# 全都是 TODO 占位。它们走的是 WARN / continue 分支 —— 不进 fail_count，
# 于是原实现会打出「L0–L3 全部通过」，而实际上这些级什么都没验。
#
# 现在的判定分三档：
#   · unverified_count > 0  →  UNVERIFIED：列出哪些级没证据，并说明最高到哪一级
#   · fail_count > 0        →  FAIL（早就在 stop_if_failed 里退出了，这里是兜底）
#   · 两者都为 0            →  PASS：每一级都有真实证据
if {$unverified_count > 0} {
    puts " UNVERIFIED：有 $unverified_count 项必测项没有证据"
    puts " 已跳过的级：$unverified_levels"
    puts " 最高可确认级别：$highest_verified"
    puts ""
    puts " 这些不是「通过」—— 是模板占位还没填。"
    puts " 填入本项目的寄存器地址/测试向量后重跑；或用 LIBRE 工程显式声明某级不适用。"
    puts "=========================================="
    exit 3
}

if {$fail_count > 0} {
    puts " FAIL：$fail_count 项检查不通过（理论上前面已退出，这里是兜底）"
    puts "=========================================="
    exit 1
}

puts " PASS：L0–L3 每一级都有实测证据且通过，可以进入 L4 单通道数据验证"
puts " 注意：本脚本**不检查** Bank/VCCO 电压冲突 —— 那需要器件 pinout，另行核对。"
puts "=========================================="
`;

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.root === "") usage();

  const root = resolve(options.root);
  if (!existsSync(root)) {
    console.error(`工程根不存在：${root}`);
    process.exit(2);
  }

  // 从 .fpga-workbench.json 或目录名取工程名
  let projectName = root.split(/[\\/]/u).pop() ?? "project";
  const marker = join(root, ".fpga-workbench.json");
  if (existsSync(marker)) {
    try {
      const parsed = JSON.parse(readFileSync(marker, "utf8"));
      if (typeof parsed.name === "string" && parsed.name !== "") projectName = parsed.name;
    } catch {
      // marker 坏了不影响生成，用目录名
    }
  }

  // **N-03：名称净化**。工程名来自用户可编辑的 `.fpga-workbench.json`，
  // 原实现直接插进模板的注释行 —— 含换行时第二行就变成了可执行的 Tcl 命令
  // （实测 `{"name":"demo\nputs REVIEW_MARKER"}` 生成出独立的 `puts REVIEW_MARKER`）。
  //
  // 这里只保留**一行可打印文字**：去掉控制字符与换行/回车/Unicode 行分隔符，
  // 再截断到合理长度。名称只是给人看的标识，不需要保留任何特殊字符。
  const rawName = projectName;
  const safeName = String(rawName)
    // 所有 Unicode 行/段分隔符与控制字符 → 单个空格
    .replace(/[\u0000-\u001f\u007f\u2028\u2029\u0085]+/gu, " ")
    // 折叠空白
    .replace(/\s{2,}/gu, " ")
    .trim()
    .slice(0, 120);
  const nameSanitized = safeName !== String(rawName).trim();
  projectName = safeName === "" ? "project" : safeName;

  const outPath = options.out !== "" ? resolve(options.out) : join(root, "prj", "board_selftest.tcl");
  const tcl = renderTcl(projectName);

  mkdirSync(dirname(outPath), { recursive: true });

  // **N-01：不覆盖已有人工修改**。
  //
  // 生成的是**模板**，用户随后要手工填 `EXPECTED_PART`、寄存器地址、测试向量。
  // 原实现无条件 `writeFileSync` —— 第二次生成就把这些全重置回 TODO（实测复现）。
  //
  // 现在：目标已存在时**默认不写**，退 3 并说明怎么覆盖；`--force` 才写，
  // 且写前留同目录 `.bak-<时间戳>` 快照（与仓库其它生成器一致：可恢复、不永久删除）。
  const exists = existsSync(outPath);
  if (exists && !options.force) {
    const message = [
      `目标已存在，未覆盖：${outPath}`,
      "这份 Tcl 是模板，填过 EXPECTED_PART / 寄存器地址 / 测试向量后不该被重置。",
      "要重新生成：显式加 --force（会先留一份 .bak-<时间戳> 快照）。"
    ].join("\n");
    if (options.json) {
      console.log(JSON.stringify({ out: outPath, written: false, reason: "exists", hint: "--force" }, null, 2));
    } else {
      console.log(message);
    }
    process.exit(3);
  }

  /** 覆盖前留快照（可恢复，不删）。 */
  let backupPath;
  if (exists) {
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    backupPath = `${outPath}.bak-${stamp}`;
    copyFileSync(outPath, backupPath);
  }

  writeFileSync(outPath, tcl, "utf8");

  const todoCount = (tcl.match(/TODO:/gu) ?? []).length;

  if (options.json) {
    console.log(JSON.stringify({ projectName, out: outPath, todoCount, bytes: tcl.length }, null, 2));
  } else {
    console.log(`工程：${projectName}`);
    console.log(`已生成：${outPath}`);
    console.log(`  长度：${String(tcl.length)} 字符`);
    console.log(`  待填：${String(todoCount)} 处 TODO（寄存器地址、电源期望值等）`);
    console.log("");
    console.log("下一步：");
    console.log("  1. 编辑该文件，把所有 TODO 换成本项目真实的值");
    console.log("  2. vivado -mode batch -source board_selftest.tcl");
    console.log("");
    console.log("为什么是 Tcl 不是 Python：本机没装 pyjnius，而 vivado.bat 与");
    console.log("hw_server.bat 都在。寄存器读写本来就是 Tcl API，绕 Python 只是多一个失败点。");
  }
};

main();

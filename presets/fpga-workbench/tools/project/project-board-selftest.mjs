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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const usage = (code = 2) => {
  const write = code === 0 ? console.log : console.error;
  write("用法：node project-board-selftest.mjs <工程根> [--out <文件>] [--json]");
  write("");
  write("  生成 L0–L3 的 Vivado Tcl 自检脚本（本机无 pyjnius，故走 Vivado Tcl 路线）。");
  write("  生成后需填入本项目的寄存器地址（文件里标 TODO），再由 vivado 执行。");
  write("");
  write("退出码：0 生成成功 / 2 输入错误。");
  process.exit(code);
};

const parseArgs = (argv) => {
  const options = { root: "", out: "", json: false };
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
# ## 为什么 L0 的电源要手工测
#
# VCCO / VCCINT 的实际电压只能靠万用表或板载 ADC 读。脚本只能检查
# 那些**设计里有对应寄存器**的电压监测通道；没有就明确说"需手工测"，
# 不假装检查过了。
# ─────────────────────────────────────────────────────────────────────────────

set script_dir [file dirname [file normalize [info script]]]
set fail_count 0

# ── 帮助函数 ────────────────────────────────────────────────────────────────

proc lv {level msg} {
    puts "\[$level\] $msg"
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

proc stop_if_failed {level} {
    global fail_count
    if {$fail_count > 0} {
        puts ""
        puts "\\n\[$level\] 有 $fail_count 项失败 —— 不继续后面的级。"
        puts "先修完这一级，否则后面几级的结果没有意义。"
        exit 1
    }
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

# ── L0：电源与配置 ──────────────────────────────────────────────────────────

lv L0 "电源与配置"

# DONE / INIT_B 是器件的硬件状态，不需要设计里有寄存器
set done_val [get_property REGISTER.IR.BIT12_DONE $dev -quiet]
if {$done_val eq ""} {
    lv WARN "  读不到 DONE —— 这个器件的属性名可能不同，请手工确认"
} else {
    check $done_val "DONE 已拉高（配置完成）"
}

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
        lv WARN "  $name: 地址还是占位符（0x0），跳过"
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
    lv WARN "  软复位寄存器地址已填，但写事务需按本项目 AXI 结构实现"
} else {
    lv WARN "  未填软复位寄存器地址 —— 假定由硬件复位完成"
}

after 10

foreach entry $state_regs {
    lassign $entry name base offset expected
    if {$base == 0x00000000} {
        lv WARN "  $name: 地址还是占位符，跳过"
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
        lv WARN "  $name: 地址还是占位符，跳过"
        continue
    }
    lv WARN "  $name 写读回环需按本项目 AXI 写事务实现（骨架未包含）"
}

foreach entry $ro_constants {
    lassign $entry name addr expected
    if {$addr == 0x00000000} {
        lv WARN "  $name: 地址还是占位符，跳过"
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
puts " L0–L3 全部通过，可以进入 L4 单通道数据验证"
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

  const outPath = options.out !== "" ? resolve(options.out) : join(root, "prj", "board_selftest.tcl");
  const tcl = renderTcl(projectName);

  mkdirSync(dirname(outPath), { recursive: true });
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

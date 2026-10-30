# 环境与工具排障

工程根 `AGENTS.fpga.md` 只写行为准则;这些技术细节放这里,遇到时再查。

## 机器级设置不要写进工程脚本

Vivado 的 `general.maxThreads`、自定义板卡的 `board.repoPaths` 放**机器级**:

| 级别 | 路径 |
|---|---|
| 机器级 | `<Vivado>/scripts/Vivado_init.tcl` |
| 用户级 | `~/.Xilinx/Vivado/Vivado_init.tcl` |

它在每个 Vivado 进程(含 `launch_runs` 另起的 run 进程)启动时生效。

ModelSim / Questa 的默认值放 `modelsim.ini`(改了会自动要求重编,编译身份里记着它)。

**`launch_runs -jobs` 管的是并行 run,不是单个 run 的算法线程** —— 这两件事都别在工程 Tcl 里
再设一遍:launcher 脚本里设的 `set_param` **传不到 run 进程**,只会让人误以为生效了。

## Tcl 里的 Windows 路径先归一化

Vivado / ModelSim 的 Tcl 里 `\f` `\v` `\t` `\r` `\b` `\n` **都是转义**:
路径一旦进**双引号字符串**就会被吃掉。

实测:`C:\proj\fpga\verif` 变成 `C:proj<0x0C>pga<0x0B>erif`
(`\f` → 0x0C,`\v` → 0x0B)。

三种做法,任选:

```tcl
# ① 一律写正斜杠
set path C:/proj/fpga/verif

# ② 用花括号(不解释反斜杠)
set path {C:\proj\fpga\verif}

# ③ 拼接之前先归一化
set path [string map {\\ /} $raw_path]
```

**已经转义坏掉的字符串再归一化救不回来** —— 必须在拼接**之前**处理。

**典型翻车点**:把环境变量(如 `APPDATA`)手工拼进 `.tcl`。

## 是环境问题还是设计问题

先按这三条排查,再怀疑 RTL。

### ① `launch_runs` 起的 run 子进程挂死

**现象**:`runme.log` 停在 banner,`wait_on_run` 无限等。

**原因**:受限沙箱下 `ISEWrap.js` 经 WSH `Exec` 要**命名管道**,被挡后子进程起不来。

**两种处理**:

- 给足文件权限,让 run 进程能正常起
- 接受「单进程非工程流」的损失 —— 后者**没有 `impl_1` run state**,
  bitstream 环节会因为找不到 `<TOP>_routed.dcp` 而拒绝

### ② Vivado 写不了 `%APPDATA%\Xilinx`

**现象**:报 `[Common 17-354]` 或 `tclapp::load_apps failed`。

**正解**:设 `XILINX_LOCAL_USER_DATA=NO`(AMD AR 62945,让 TclStore 从安装目录读)。

**不要靠重定向 `APPDATA`** —— 那正是上一个坑的来源。

### ③ MSYS2 装的 Verilator 报找不到 waiver 文件

**现象**:第一步就报 `Cannot find verilated_std_waiver.vlt`。

**正解**:带 `VERILATOR_ROOT=<msys2>/mingw64/share/verilator`;
会话提示的「已就绪工具」里会给推导值。

## 相关

- 复位极性的完整口径(同步/异步、复位作用域):见
  [RTL 规范清单](../../fpga-module-rtl/references/rtl-style-and-checks.md)
- MCP 与批处理的用法:见 `fpga-project-synth` 的 `references/mcp-and-batch.md`

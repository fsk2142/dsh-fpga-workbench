# 兼容性与已知限制

> 这份文档写的是**使用者需要知道的**：插件支持哪些宿主版本、哪些工具真验过、哪些有已知限制。
>
> 自检（`pnpm test`）证明的是"仓库里的东西自洽"，它**跑不到真实客户端** ——
> 两者不是一回事，下面的"已验证 / 未验证"按实际跑过的范围标注。

## 宿主版本

兼容声明是 `engines.dsh: >=0.2.0-rc.2`。宿主判定时带 `includePrerelease`，
所以这一个起点覆盖它之后的**所有**版本（含后续 minor 的 rc / alpha）。

`dsh.compatibility.dshReleases` 里登记的版本会额外跑宿主侧检查；未登记的版本仍可安装，
只是少了那些检查。

## 工具验证范围

| 工具 | 状态 | 说明 |
|---|---|---|
| **ModelSim 2020.4** | ✅ 真机跑过 | 三模式（compile / run / load）、语言分流、显式 ini、`VENDOR_LIBS`、`work/` 与 `.svh` 新鲜度、编译配置身份、`vlog -incr` 宏依赖、反序包依赖自动重试、`+acc` 分流 |
| **Vivado 2025.2** | ✅ 真机跑过 | 模块综合、工程综合（含 run 复用）、工程约束、linter、实现到 route + DRC、bitstream 归档 |
| **QuestaSim** | ⚠️ **未验证** | 实现上与 ModelSim 同级支持，但**没有在真机上跑过** —— 不要当成已验证 |
| **Vivado XSim** | ⚠️ 部分 | 编译与运行脚本已提供，未经全链真机验证 |
| **Verilator** | ✅ 已接入 | 见下节「Verilator 必须带 `VERILATOR_ROOT`」 |
| **Icarus Verilog** | ⚠️ 未验证 | 工具卡片可配置，未做端到端真机验证 |

## 已知限制

### Verilator 必须带 `VERILATOR_ROOT`

MSYS2 或官方二进制装的 Verilator，运行时需要显式指定 `VERILATOR_ROOT`，
否则第一步就报 `Cannot find verilated_std_waiver.vlt`。典型值：

```
VERILATOR_ROOT=C:/msys64/mingw64/share/verilator      # MSYS2
VERILATOR_ROOT=C:/verilator/share/verilator           # 官方解压版
```

原因：安装包里把 root 编成了内部路径（如 `/mingw64/share/verilator`），Windows 上解析不到。
另外那个无扩展名的 Perl 包装脚本在 PowerShell 里跑不起来，所以指向 `verilator_bin.exe` 是唯一可靠组合。

会话提示的「已就绪工具」里会自动给出推导值。

### 受限沙箱下工程模式跑不了

`launch_runs`（模块综合、工程综合、实现、bitstream 四个模板都用到）要另起 run 子进程，
`ISEWrap.js` 经 WSH `Exec` 拉起、依赖命名管道。被沙箱挡住时 `runme.log` 会停在 banner、
`wait_on_run` 无限等。

**给足文件权限即可**。否则只能退化成"单进程非工程流"，而那样没有 `impl_1` run state，
`vivado_bitstream.tcl` 会因为找不到 `<TOP>_routed.dcp` 拒绝。

### Vivado 的 TclStore 需要可写目录

写不了 `%APPDATA%\Xilinx` 时 Vivado 启动就报 `[Common 17-354] Could not open … for writing`
+ `tclapp::load_apps failed`（连 `create_project` 都过不去）。

正解是设 `XILINX_LOCAL_USER_DATA=NO`（AMD AR 62945，让 TclStore 从安装目录加载）。

**不要**靠重定向 `APPDATA` —— 把 Windows 反斜杠路径拼进 Tcl 字符串会被
`\f` / `\v` / `\r` 当转义吃掉。

### GUI 会话的波形装载

`vsim -do "do run.do load"`（**不加** `-c`）用于把设计装进 GUI。无头环境验不了弹窗行为，
只验了同一分支在批处理下的行为（装载成功、不 `run -all`、不退出）。

### `.ltx` 归档

ILA / VIO 的 `.ltx` 归档分支需要设计里真的有那些核，否则不产生该文件。未做端到端验证。

## 沙箱环境下的自检红项

受限沙箱里 `pnpm test` / `pnpm run test:installed` 会报若干项 —— 典型是
`check-toolchain` 的 `queryVersion` 报 `{"error":"EPERM"}`、一致性矩阵报 `(实际 null)`。

原因是 `spawnSync` 默认用管道抓子进程输出，被沙箱挡住（`cmd /c echo hi` 用管道同样 EPERM，
用 `stdio:"ignore"` 就正常）。**同一条命令在放开权限的环境里就是全绿。**

复现时按"环境限制"读，别去改代码。

## 发布前还有哪些没走完

以下是**已知未验证**的项，报 `PARTIAL` 时就指这些：

- QuestaSim 全链（本机没装）
- Vivado XSim 全链
- Icarus Verilog 全链
- GUI 弹窗类交互（无头环境验不了）
- 多器件 JTAG 未设 `DEVICE_FILTER` 时的拒绝行为
- 工程 `sim/` 首次 `run.do compile` + `run.do run`（`RTL_DIR` 确认）

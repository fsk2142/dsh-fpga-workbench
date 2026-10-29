---
name: fpga-project-release
description: 只在用户明确要求交付或发布 FPGA 工程时用;核对上游证据、文件清单与归档完整性。
---

# project-release:发布归档

**只在用户明确要交付/发布时做** —— 实现跑完不等于要发布,不得自动收尾归档。

其余工程技能按需并列或回跳,见 `fpga-project-spec`。

## 前置

1. 上游**都是 `PASS`,或有依据的 `NOT_APPLICABLE`**(`BLOCKED` / `UNVERIFIED` / `FAIL` 不算),
   正式验收口径见 `fpga-project-integrate`:
   综合(`doc/synth.md`)、实现(`doc/impl.md`)、时序(`doc/timing.md`)、
   要上板的还有上板(`doc/board.md`);仿真/约束同理尽量齐
2. 有 bit / ltx(/mcs),**以 `bit/` 归档那份为准**,知道是哪次实现出的
3. **`doc/files.md` 完整对过一遍**(见下)
4. 版本能从文件头读到(读不到不算齐)

## 文件清单对账(发布前必做)

`doc/files.md` 只记**工程里的位置 + 参考来源**(见 `fpga-project-spec`),随时可改。
发布前**完整对一遍**:

- 盘上有、清单没有 → 补一行
- 清单有、路径不在或来源说不清 → 补实或写明缺口
- 对账结果写进 `doc/release.md`

## 一句话判据

**照着归档里的东西,能重建出同一版设计** —— 源码、约束、IP、工具版本、脚本都对得上,
重建结果与签核结论一致。做不到就不算发布完成。

**别把"能重建"说成"bit 逐字节相同"**(工具/种子/时间戳都可能改布局);只有真比过哈希才写一致。

## 归档什么

| 类别 | 具体 | 位置 |
|---|---|---|
| 产物 | bit / ltx /(mcs) | **`bit/`** |
| 报告 | synth / impl / timing / board 等 | `doc/` |
| 约束 | `xdc/` + 管脚对照表 | `xdc/` + `doc/constraints.md` |
| 可复现 | `write_project_tcl` 导出工程脚本 | 归档目录 |
| 源码 | `src/rtl/`、`src/sim/`、`ip/`、根 `sim/` 清单 | `doc/files.md` |
| 参考 | 相关 `sch/`(或指明存档处) | `sch/` |
| 说明 | 本版差异、已知问题 | `doc/release.md` |

**不得把 `prj/` 整个塞进归档** —— 归档"重建脚本 + 源文件清单"即可。

## 版本怎么定

- 顶层文件头版本 = 本版归档版本(不一致是漏改)
- 各文件版本从文件头读,**不得凭记忆写**

## 判据

- **PASS**:各类齐;`files.md` 对过账;能重建;版本对得上;已知问题清楚
- **FAIL**:缺产物或缺可复现脚本;版本对不上;清单有缺口且未说明
- **BLOCKED**:上游不是 `PASS` / 有据 `NOT_APPLICABLE` → **不得强行发布**
- **UNVERIFIED**:清单、重建步骤或归档内容只核对了部分,还不足以证明可重建
- **NOT_APPLICABLE**:这次不发布

判定词含义见 `fpga-module-verif` 的**状态表**(唯一权威)。 *PASS* / *FAIL* / *BLOCKED* / *UNVERIFIED* / *NOT_APPLICABLE* 五个词,含义与用法以那张表为准。

## 产物

写 `<用户指定工程目录>/doc/release.md`:

- 结论(`PASS` / `FAIL` / `BLOCKED` / `UNVERIFIED` / `NOT_APPLICABLE`)+ 版本号 + 日期 + 对应 `bit/` 路径
- **`files.md` 对账结果**(补了什么、还缺什么)
- 各类归档物实际路径
- 复现步骤:从干净目录起按顺序的命令原文
- 模块/文件版本表:版本 + 来源(库/专用)+ 结论(可复用看模块级,专用看 sim 跑过与否)
- 已知问题与未验证项

## 不要做的事

- 不归档整个 `prj/`
- 不在归档里改报告(证据只读)
- 不跳过 `files.md` 对账就写 `PASS`

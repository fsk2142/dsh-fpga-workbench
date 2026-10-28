# 综合怎么跑：MCP 会话与 shell 批处理

两条路都能跑，**有 `mcp__vivado__*` 时优先走 MCP**。

## 为什么优先 MCP

| | MCP | shell `vivado -mode batch` |
| --- | --- | --- |
| Vivado 启动 | **一次**（会话常驻） | **每条命令都重启** 30–60 秒 |
| 工程 | 只 `open_project` 一次 | 每次重开 |
| 中间查询 | 秒级 | 又要重开 |
| 长任务 | `status: running` + 轮询 | 前台阻塞或后台日志 |

综合这种「开工程 → 跑 → 看状态 → 出报告」的多步流程，MCP 省的启动时间就是几倍差距。

## MCP 路径

```
vivado_start(working_dir=<工程根>, session_type="general")
vivado_execute("open_project prj/<工程>")              ← 单独调用
vivado_execute("launch_runs synth_1 -jobs 4")          ← 单独调用
vivado_execute("wait_on_run synth_1")                  ← 单独调用，与上面成对
vivado_status(session_id, action="runs")               ← 隔 30–60 秒查
vivado_log_messages(session_id)                        ← 看告警/错误
```

### 三条硬规则（来自官方 MCP 说明，不是推测）

1. **`launch_runs` 与 `wait_on_run` 必须成对**；`open_project` / `launch_runs` /
   `wait_on_run` / `synth_design` / `source` / `write_bitstream` 都要求**单独一次调用**
   （服务器钩子要求它们在字符串开头），不能和别的命令用分号拼。
2. **同一 session 必须串行**（单线程 TCL）。要并行就跑两个 session，用子代理各管一个。
3. **长命令返回 `status: running` 时不要空闲等** —— 命令仍在 Vivado 里跑。
   用子代理并行读日志 / 看代码 / 准备下一步，自己只隔 30–60 秒轮询 `vivado_status`。

### 卡住与出错

- `vivado_status(action="health")` 检测卡住的 OOC run，会给 recovery 建议
- `vivado_status(action="reset_run", run_name=...)` 重置
- `vivado_status(action="cancel_and_relaunch")` 用更少的并行 job 重启
- 报错告警优先用 `vivado_log_messages`（比肉眼翻日志可靠，也带 `recovery_hint`）

### 3 步以上的任务

用 `vivado_todos` 建计划，IDE 侧边栏可见，用户能看到进度。

## shell 路径（MCP 不可用时）

```powershell
vivado -mode batch -source prj/run_synth.tcl
```

模板 `synthesis/vivado_project_synthesis.tcl` 就是这条路。综合耗时长，**别前台死等**：
放后台任务，跑完再读日志（会话有后台任务机制）。

## 两种都不改变判据

MCP / shell 只是把命令送进 Vivado、把输出送回来 —— **它不判断设计对不对**。
`synth.md` 的结论、资源与时序数字、PASS/FAIL 的判据，照旧走本技能与
`fpga-project-timing` 的规则。

## 文档查询

`vivado_doc_search` 需要**另外装 AMD 文档 MCP server**。没装就说查不了，
**不要凭记忆编文档结论** —— 那比没有结论更糟。

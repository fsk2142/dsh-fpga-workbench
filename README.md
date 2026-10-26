# dsh-fpga-workbench

DSH 的 **FPGA 开发模式**插件：给 agent 加一个「FPGA 开发模式」预设，并在插件页提供工具链配置。

它做两件事：

1. 往 DSH 的预设名单里加「FPGA 开发模式」，新建会话时可选。
2. 在「插件 → dsh-fpga-workbench → 配置」里登记本机工具路径与环节偏好，只交给这个模式的会话。

不注册侧边栏、面板，也不替换官方组件。

## 安装

```powershell
# 从 git 仓库安装
dsh plugin --profile desktop add git+https://github.com/fsk2142/dsh-fpga-workbench.git

# 钉版本
dsh plugin --profile desktop add git+https://github.com/fsk2142/dsh-fpga-workbench.git#v1.0.0

# 从本机源码目录（开发时用，换成实际路径）
dsh plugin --profile desktop add file:<你的克隆目录>
```

装完**重启 DSH Desktop**，新建会话的预设选择器里就有「FPGA 开发模式」。

### 刷新已装副本

```powershell
node tools/install.mjs --check   # 只校验，不动任何东西
node tools/install.mjs           # 不一致时重装
```

`install.mjs` 不先删：旧副本改名为备份再重装，失败则改回。**必须在你自己的终端里跑**（受限沙箱里 pnpm 建不了临时文件）。

若 `dsh plugin add` 被供应链策略挡住（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，它查整个 profile 的锁文件，与本插件无关），改用：

```powershell
node tools/sync-installed.mjs
```

不经过 pnpm，只把包内容写进 `node_modules/<包名>`，不碰 profile 的 `package.json` / 锁文件 / `settings.yaml`。

### 版本

插件自身版本与 DSH 版本无关。兼容声明是 `engines.dsh: >=0.2.0-rc.2`（单一起点；宿主判定带 `includePrerelease`），已实测的版本记在 `package.json` 的 `dsh.compatibility.dshReleases`。

设置页底部有「版本」卡片与「检查更新」按钮：**只有点它才联网**（约 8 秒超时，不带本机信息）；没有 tag 时如实说「没有可比较的版本号」。

## 配置页

三个顶层区：

| 区 | 内容 |
| --- | --- |
| **工具设置** | 按脚本 / 编译 / 仿真 / FPGA 四类登记 Python、Verilator、Icarus、ModelSim、QuestaSim、Vivado XSim、Vivado、Quartus 及自定义工具。每张卡独立设置路径、检测、保存 |
| **模块工具** | 四张能力卡：RTL 编译、仿真测试、脚本验证、综合与门禁 |
| **工程工具** | 三张能力卡：工程主工具、系统仿真、脚本验证 |

每张能力卡可选：

- **`auto`** —— 由 AI 从已就绪工具中判断
- **指定工具** —— 例如 RTL 固定首选 Verilator；未就绪的工具显示但不可选
- **`none`** —— 明确不用

切换能力工具不会清空或改写工具路径，Vivado 与 Quartus、ModelSim 与 XSim 可并存。

语言标准（RTL / 仿真）、仿真库映射（`modelsim.ini`）、用户模板库根目录各自独立成组、按需展开。

### 自检

设置页底部「自检」按钮（点一下才跑，挂载时不请求），按清单核对已装副本的 8 项内容：12 份内置模板文件、7 个自带命令入口及 4 个辅助模块、16 个技能目录及各自的 `SKILL.md` 与 `references/*.md`、运行时子树与 `workspace/AGENTS.fpga.md`、补丁里的预设声明行、设置模型版本、已登记工具路径、用户模板库目录。

结论分 `pass` / `warn` / `fail` 三档，缺哪份文件就点名哪份。**只读**：不写设置、不改文件、不起进程。

## 自带命令

按级别分目录（`module/` 模块级、`project/` 工程级、顶层两级共用），名字带环节前缀。

| 级别 | 环节 | 命令 | 作用 |
| --- | --- | --- | --- |
| 两级共用 | 规格 | `node presets/fpga-workbench/tools/setup-scaffold.mjs <目录> [--kind module\|project]` | 建模块 / 工程骨架（幂等） |
| 模块级 | RTL | `node presets/fpga-workbench/tools/module/module-rtl-new.mjs <模块根> <模块名> --template <模板>` | 按模板起 RTL 文件 |
| 模块级 | RTL | `node presets/fpga-workbench/tools/module/module-rtl-check.mjs <模块目录>` | RTL 机械规范检查 |
| 模块级 | 验证 | `node presets/fpga-workbench/tools/module/module-verif-new.mjs <模块根> <模块名> --template <模板>` | 起 Testbench / 仿真脚本 / 验证脚本 |
| 模块级 | 综合 | `node presets/fpga-workbench/tools/module/module-synth-new.mjs <模块根> <模块名> --template <模板>` | 起约束文件或综合脚本 |
| 模块级 | 验收 | `node presets/fpga-workbench/tools/module/module-report-check.mjs <模块目录> [--json]` | 核报告引用的证据路径是否存在 |
| 工程级 | RTL/lint | `node presets/fpga-workbench/tools/project/project-rtl-check.mjs <工程目录> [--json]` | 检查工程 RTL 与 IP 时序卡 |

脚本只做机械化的事：起模板、建骨架、替占位符、跑固定命令、机械规范检查、把事实摆出来。
**不**决定该走哪个环节、**不**判"算不算过"、**不**做阶段推进。判据写在技能文档里，由 AI 逐条看。

两条宽容规则（不要加严）：

- Tab / 非英文行 / 行尾混用**只算警告**，不阻塞
- 文件头只要求"顶部有分隔条 + 前 15 行字段齐全"；九个小节块只要求名字作为 banner 存在

## 可选的 AMD Vivado MCP

常驻会话式接入（不是批量脚本），需要自行从 AMD 下载，本包**不打包任何二进制**。

1. 下载 `vivado-mcp-server-windows-amd64-*.exe`
2. 在设置页「Vivado MCP」填它的路径，保存
3. 新开 FPGA 会话，工具名形如 `mcp__vivado__*`

留空则该字段不启用，其余功能照常。

## 目录组成

```
package.json             dsh.bundle.patch + dsh.client + exports['./mode']
cordis.patch.yml         profile 层：挂载宿主半侧 + 插入 FPGA 预设声明行
lib/index.js             宿主半侧：设置注册 / 预设同步 / 路径探测 / 只读状态路由 / 版本
lib/mode.js              模式半侧：把工具链交给本模式会话 + 挂 Vivado MCP
lib/mcp.js               Vivado MCP 接入层
lib/version.js           版本比较与检查更新（唯一联网处，只在按钮里）
lib/toolchain.js         字段定义 + 存在性判定 + 提示文案（只用 node 内置模块）
lib/client.js            浏览器半侧：配置页分区
presets/fpga-workbench/
    preset.yml           选择器里的名字与描述
    agent.cordis.yml     模式组装：人设 + 工具行 + 模式半侧 + 技能目录
    skills/              16 个技能，只在本模式可见
    templates/           12 份内置模板
    tools/               自带命令（module/ project/ lib/ + 顶层共用）
tools/                   （不在发布包内）分层自检 + install / sync-installed
```

`lib/` 是可执行 JS，无构建产物，所以 git 装法不需要 `prepare` 步骤。

## 安装形态的三点

1. **不需要构建**。git 装法取仓库的**已跟踪内容**：`tools/` 会带上（仅用于开发自检，不参与加载），本地已忽略的 `.tmp/` 不带。
2. **指定分支或标签**：地址后加 `#`，如 `...#main` 或 `...#v1.0.1`。不打标签就跟 `main` 走，升级时重新 `add`。
3. `pnpm pack` 的 tarball 含 `files` 白名单里的 `lib` / `presets` / `cordis.patch.yml` / `icon.svg`，加上 npm 自动包含的 `package.json` / `README.md` / `LICENSE`；不含根 `tools/` 与 `docs/`。

## 开发

```powershell
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm run build       # tsdown: src/ → lib/
pnpm test            # 源码 13 项 + 宿主 3 项检查
```

改了 `src/` **必须** `pnpm build` 并提交 `lib/` —— 宿主直接读 `lib/index.js`，`git add` 安装不会跑构建。
`pnpm test` 里有 `git diff --exit-code -- lib`，忘了构建会红。

其余开发细节见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)，真机检查清单见 [`docs/CLIENT_CHECKLIST.md`](docs/CLIENT_CHECKLIST.md)。

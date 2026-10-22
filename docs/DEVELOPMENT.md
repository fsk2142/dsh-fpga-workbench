# 开发与发布说明

这里集中放开发自检、发布包边界与历史决策。最终用户的安装与使用说明留在根目录 README。

## 发布：tag 与 Release 都要

**打 tag 只解决"代码有个标记"，建 GitHub Release 才解决"用户看得见改了什么"。**
插件市场读的是 **Releases**，不是 git tag —— 只有 tag 的话，市场里会显示「有新版本」
却说不出更新内容，用户只看到一串 SHA。

发版顺序：

```powershell
git tag -a v0.7.0 -m "…"            # 1. 打 tag
git push origin main v0.7.0         # 2. 推送代码与 tag
# 3. 建 Release（gh CLI 或 GitHub API；正文写用户需要知道的事）
```

`tools/probes/audit-rules.mjs` 会核对这条约定在文档里有没有写（规则 §2.4）。

## 发布包边界

- `@deepseek-ai/schemastery` 使用 peer dependency：宿主已经提供它，插件只声明兼容要求，不触发重复安装或锁文件改动。
- `@deepseek-ai/dsh-settings` 与 `@deepseek-ai/dsh-system-prompt` 的 peer 范围是启动保护；官方兼容性检查读取这些声明。
- `package.json#files` 必须包含 `lib` 与预设的 `skills / templates / tools / workspace` 四棵运行时子树。`agent.cordis.yml` 与 `preset.yml` 是编辑源，由测试与 `cordis.patch.yml` 保持一致，不进入发布包。
- npm 会自动把 `README.md` 与 `package.json` 放进包中；`docs/` 与仓库根 `tools/` 不在发布白名单里。

## 运行时补丁维护

`presets/fpga-workbench/agent.cordis.yml` 是带解释的编辑源，`cordis.patch.yml` 是实际加载的内联副本。为了减小发布体积，运行时补丁不保留只供维护者阅读的 YAML 注释；修改组合后必须运行 `npm test`，由一致性检查防止两份配置漂移。

## 自检

**唯一入口是 `npm test`** —— 它按固定顺序跑源码级与环境级检查,并且**看退出码**,不是看输出里的
`PASS` 字样。这一点有来由:曾经某个 check 打印完 `PASS` 之后又崩了(用了没导入的
`readdirSync`),而我只 grep 输出、把它当成终端的假警报,那个缺陷在仓库里躺了好几轮。

```powershell
npm test                  # 源码级 + 环境级(缺本机 DSH 的记 SKIP,不算失败;不碰厂商工具)
npm run test:installed    # 再加上已装副本比对与加载冒烟
npm run test:vivado       # 按需:真跑一次 Vivado 模块综合(分钟级)
npm run test:safety       # 再加上依赖安全(较慢,要跑两次 pnpm)
node tools/check-all.mjs --list   # 看它到底跑哪些
```

`npm run test:vivado` 是**按需开关**,不在默认 `npm test` 里(它要真起 Vivado,分钟级):
装了 Vivado 就用插件自己的 `module-synth-new` 起脚本、真跑一次模块综合,断言退出码、脚本自己的
PASS 行与资源/时序报告(`check-vivado.mjs`);没装 Vivado 时它打印 **SKIP** 并退出 0 ——
那一行不是"通过",摘要里也照实写。不跑时摘要会写"厂商工具检查未跑(--vivado)"。

想单跑某一项时:

```powershell
node tools/check-toolchain.mjs      # 字段/存在性/警告措辞/两侧契约/提示文案三种状态
node tools/check-load-contract.mjs  # 加载契约:语法/lib 内部 import/bundle 契约/半侧分工(重启前必跑)
node tools/check-fpga-tools.mjs     # 自带命令的判定正确性 + 自带模板自洽 + CLI 退出码
node tools/check-selfcheck.mjs      # 设置页自检的判据:故意少拷模板/技能/引用资源/命令,必须报 fail
node tools/check-preset-root.mjs    # 预设声明行 + 组装结构 + 模式行 + 自带技能
node tools/check-patch-file.mjs     # 补丁字节合法 + 形状
node tools/check-package.mjs        # npm 包内容:files 白名单、必需/禁止进包的文件
node tools/check-mcp.mjs            # Vivado MCP 接入层:设置字段/路径判定/配置形状/挂载位置/许可证边界
node tools/check-mcp-mount.mjs      # MCP 挂载层的并发、幂等、失败清理与卸载(注入假依赖,不起真进程)
node tools/check-version.mjs        # 版本比较 + 检查更新行为(走市场 API)+「不自动联网」的静态守卫
node tools/check-install-hints.mjs  # 缺工具时给的安装指引:覆盖、可执行、两种提示场景
node tools/check-skill-docs.mjs     # 技能文档与代码:文档里给的命令参数必须被代码接受、frontmatter name 对得上
node tools/check-preset-duplicates.mjs # 预设与补丁:无重复注册、两份文件的预设行一一对应、同 id 包名一致
node tools/check-docs.mjs           # 文档准确性:提到的路径/命令/npm script/技能名是否真实存在
node tools/check-vivado.mjs         # 真跑一次 Vivado 模块综合(没装 Vivado 记 SKIP,不是通过)
node tools/check-installed.mjs      # 已装副本与源逐字节一致(支持 DSH_PROFILE_DIR 覆盖)
node tools/smoke-installed.mjs      # 已装副本在真实解析环境里能否加载(装完/重启前跑)
node tools/check-install-safety.mjs # 依赖与锁文件安全:装本插件不动既有依赖(较慢,要跑两次 pnpm)
```

`sync-installed.mjs`(装/同步已装副本;`--prune` 现在只**列出**已装副本里多出来的旧文件、**不删**)、
`install.mjs`(装完自动跑 `smoke-installed`)按需跑。`tools/shipped.mjs` 是内部模块,不是命令。

前 11 项属于源码级(`check-all.mjs` 的 `SOURCE_CHECKS`,但 `check-load-contract` / `check-preset-root` /
`check-patch-file` 需要宿主环境,算宿主级)。后 4 项分别按 `--vivado` / `--installed` / `--safety` 开关打开。

## 一次性排查脚本(`tools/probes/`,已 gitignore)

`tools/probes/` 放的是查具体问题时写的一次性脚本,**不提交**:

| 脚本 | 用途 |
|---|---|
| `probe-mcp-e2e.mjs` | 真起 Vivado → 跑 Tcl → 关闭,验证 MCP 通道能干活(需要 `VIVADO_MCP_EXE`) |
| `probe-mcp-steps.mjs` | 逐场景测挂载的并发/幂等/泄漏 |
| `probe-dsh-mcp-client.mjs` | 验证 `dsh-mcp-client` 把工具注册成 `mcp__vivado__*` |
| `bench-plugin.mjs` | 量加载耗时、内存、包体积 |
| `bench-prompt.mjs` | 解剖会话提示,看每节占多少、哪里重复 |
| `audit-approvals.mjs` | 核对待批准删除请求:目标还在不在、能不能删 |

它们依赖本机的 AMD 二进制与宿主 asar,换台机器未必原样跑得起来 —— 所以是"查问题时用一下",
不是"长期维护的公共接口"。

## 提交历史清理(`scripts/`)

公开仓库的提交信息里不该出现「用户 2026-10-21：…」这类对话框架。`scripts/` 有配套工具,
操作单见 [`SCRUB-COMMIT-HISTORY.md`](SCRUB-COMMIT-HISTORY.md)。

```powershell
node scripts/scrub-history.mjs             # 只读扫描
node scripts/scrub-history.mjs --preview   # 看一条样例的改写前后
node scripts/verify-scrub.mjs              # 全量预演验证(不落盘)
node scripts/scrub-history.mjs --apply     # 真改写(自动建备份分支 + 校验文件未变)
```

**自检自己收尾(零删除)**:会建 fixture 的几项(`check-toolchain` / `check-fpga-tools` / `check-selfcheck`)跑完
**不删** `.tmp/` 下的临时目录,只把残留清单打出来让人自己处置 —— 那一区会一直涨,这是零删除的代价。
`check-selfcheck` 的夹具是**按清单少拷**出来的(不是拷完再删),所以它自己也不删任何东西。

`smoke-installed` 与 `check-installed` 的关系:后者比字节,前者**真的加载一遍** ——
在 profile 的解析环境里 import 宿主半侧、执行客户端 bundle 的工厂函数、用真实设置跑一遍
状态载荷与会话提示段。"文件都对但一加载就炸"只有它能抓住,而那种情况重启后就是黑屏。
`tools/install.mjs` 装完会自动跑它。

宿主检查需要一个能被**当前解释器** `require` 到 `js-yaml` 与 `cordis-plugin-include` 的目录,
而且**版本必须命中 `dsh.compatibility.dshReleases`**。`check-all.mjs` 的选择顺序:

1. **`DSH_APP_DIR`(显式指定)**:给了就用它,不看版本声明(结论会打折,摘要里写明)。
   但**指向无效目录时直接报错退出** —— 以前会悄悄退回自动探测,于是"我测的是指定版本"
   变成假象;打错路径现在会红,不会静默换宿主。
2. **官方桌面端** `%LOCALAPPDATA%\Programs\DeepSeek Harness`:运行时在 `app.asar` 里,
   普通 Node 读不了,所以选中它时改用桌面端自带的 Electron(`ELECTRON_RUN_AS_NODE=1`)跑子检查;
   版本从 asar 头部读出。
3. **npm 全局** `%APPDATA%\npm\node_modules\@deepseek-ai\dsh`(本机实测可能是旧版本)。
4. 旧桌面版默认路径。

只接受版本在声明里的候选;都没有就记 **SKIP** 并打印每个候选的实际版本(不视作通过)。
这条是为了防"机器上另装了一个旧全局 DSH,`npm test` 却报宿主检查通过"。profile 用
`DSH_PROFILE_DIR` 指定。

## 关于界面(已放弃的方案,留作记录)

早期版本尝试过在 UI 上加东西:侧边栏入口行、主区域面板、甚至替换官方会话区。
结论:

- **入口行 / 面板**能做,但对"FPGA 工作模式"这个目标来说是多余的
- **替换官方会话区**做过一版,实机效果远不如官方(要追上得复刻它的 CSS 与交互),
  而且必然改掉官方列表的样子 —— 已回退
- **替换整个侧边栏**机制上做不到:声明一个已被声明的子槽会直接抛错
  (`slot "x" is already declared`),那个错发生在插件加载阶段,**会让桌面端起不来**

那些实现都在 git 历史里(`b3781ff` 是替换版,`7560643` 是回退)。

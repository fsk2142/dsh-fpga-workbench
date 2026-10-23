# scripts/ 目录说明

这里放的是**开发期脚本**，不是插件运行时的一部分（`files` 白名单不含 `scripts/`，
宿主永远不会加载它们）。

## 一、保留在版本库（有长期价值）

| 脚本 | 用途 |
| --- | --- |
| `scrub-history.mjs` | 清理提交历史里的对话痕迹 / 本机路径（`docs/SCRUB-COMMIT-HISTORY.md` 直接引用） |
| `scrub-commit-msg.mjs` | 供 `git filter-branch --msg-filter` 调用的提交信息清理器 |
| `verify-scrub.mjs` | 改写前验证：标题保持原样、正文清干净、提交信息不为空 |

这三个与具体插件无关，任何 DSH 插件仓库都能直接用，所以**留在版本库里**。

## 二、不进版本库（一次性工具，见 `.gitignore`）

- `type-*.mjs` —— 2026-10-22 类型收尾（497 → 0）时逐批改源码的脚本。
- `probe-*.mjs` / `diag-describe-env.mjs` —— 查"宿主有哪些槽位""插件详情页是否可达"
  "`engines.dsh` 无上界怎么写"这类一次性探针。
- `migrate-client-to-esm.mjs` —— 客户端从手写 loader 包装改成标准 ESM。
  **绝不能重跑**（会再套一层包装，`clientExports.apply is not a function`）。

这些的结论都已经落在 git 提交信息与代码注释里；脚本本身依赖本机宿主 asar，
换台机器未必跑得起来。

## 三、已删除（2026-10-23）

TS 迁移期的三个等价验证脚本 —— `verify-behavior-equivalence.mjs` /
`verify-artifact-equivalence.mjs` / `diag-equivalence.mjs` —— 连同它们比较的基准
`lib.handwritten-backup/` 一起删除了。

**理由**：它们**不在 `npm test` 里**（CI 从不跑，只是手动用的临时工具），
而迁移本身已过 7 轮审查（H1-H3 / M1-M8 / L1-L10 / N1-N5 全部闭环）。
真正每次提交都跑的防线是 `tools/check-all.mjs` 的 **1900+ 项断言**。

留着它们反而有害：`lib.handwritten-backup/` 会让人误以为还有第二套实现要维护。

---

## 常规命令

日常只用这几个（都在 `package.json` 里）：

```
pnpm run build      # tsdown:src → lib（改了 src 必须跑）
pnpm run typecheck  # tsc --noEmit
pnpm test           # 源码 12 项 + 宿主 3 项自检
```

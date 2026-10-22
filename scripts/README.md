# scripts/ 目录说明

这里放的是**开发期脚本**，不是插件运行时的一部分（`files` 白名单不含 `scripts/`，
宿主永远不会加载它们）。按用途分三类：

## 一、长期保留（发布/维护要用）

| 脚本 | 用途 |
| --- | --- |
| `verify-behavior-equivalence.mjs` | 迁移后的行为等价验证（57 项：数据表、纯函数、探测、提示、迁移、客户端内容） |
| `verify-artifact-equivalence.mjs` | 产物等价验证（7 个宿主入口的导出是否被新产物全覆盖 + 客户端 loader 包装） |
| `diag-equivalence.mjs` | 上面两个报"不一致"时，定位具体是哪个字段不同 |

这三个是 TS 迁移时建的**安全网**。`lib.handwritten-backup/` 一旦清理，
`diag-equivalence.mjs` 会失效（它比较的就是那份备份）—— 届时一并删掉。

## 二、一次性迁移工具（已完成使命，留档不进 git 历史之外的维护范围）

- `type-toolchain-1..18.mjs`、`type-tlibrary-1..4.mjs`、`type-client-1..9.mjs`、
  `type-index-annotations.mjs`、`type-index-round2.mjs`
  —— 2026-10-22 类型收尾（497 → 0）时逐批改源码的脚本。**保留价值仅在于"当时怎么改的"**，
  已经体现在 git 提交信息里，所以**不进版本库**（见 `.gitignore`）。
- `migrate-client-to-esm.mjs` —— 把客户端从"手写 loader 包装"改成标准 ESM。
  那次改动已完成，且**绝不能重跑**（重跑会再套一层包装，`clientExports.apply is not a function`）。
- `scrub-history.mjs` / `scrub-commit-msg.mjs` / `verify-scrub.mjs`
  —— 清理提交历史里的本机用户名路径（隐私审核）。已完成，保留留档。

## 三、一次性探针（已经回答过问题，不进版本库）

- `probe-slots.mjs` / `probe-plugin-detail.mjs` / `probe-client-slots.mjs`
  —— 查"宿主有哪些客户端槽位""插件详情页是否可达"。
- `probe-engines-range.cjs` —— 实测 `engines.dsh` 无上界写法在宿主 semver 下的真实行为。
- `diag-describe-env.mjs` —— 对比 `describeEnv` 在备份与产物上的输出差异。

结论都已写进提交信息与代码注释；脚本本身依赖本机宿主 asar，换机器未必跑得起来。

---

## 常规命令

日常只用这几个（都在 `package.json` 里）：

```
npm run build       # tsdown:src → lib（改了 src 必须跑）
npm run typecheck   # tsc --noEmit
npm test            # 源码层自检（11 项）+ 宿主层（3 项）
```

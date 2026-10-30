# 清理 Git 提交历史里的对话痕迹

> 适用场景：提交信息里写了「用户 2026-10-21：…」「用户报障…」这类句子，把
> 「AI 在与具体用户对话」暴露在公开仓库里。本文件是一份可照抄的操作单，
> 在任意一个 DSH 插件仓库里都能用。
>
> 实操记录：`dsh-llm-account`（2026-10-21，清理 79 处、重写 280 个提交）、
> `dsh-fpga-workbench`（同日，清理 127 处、重写 224 个提交）。两次代码内容均零变更。

---

## 零、本仓库已经有脚本了

下面第二到第七节是手工步骤，**平时不用照抄** —— 本仓库的 `scripts/` 里已经有：

| 脚本 | 作用 |
| --- | --- |
| `scripts/scrub-history.mjs` | 一键：默认只扫描；`--preview` 看改写效果；`--apply` 真改写（自动建备份分支并校验文件内容未变） |
| `scripts/scrub-commit-msg.mjs` | 供 `git filter-branch --msg-filter` 调用的改写器（`scrub-history.mjs` 会自己找到它） |
| `scripts/verify-scrub.mjs` | 改写**前**的验证：标题是否只做了路径替换、正文是否清干净、有无空提交 |

```powershell
node scripts/scrub-history.mjs             # 只读扫描
node scripts/scrub-history.mjs --preview   # 看一条样例的改写前后
node scripts/verify-scrub.mjs              # 全量预演验证（不落盘）
node scripts/scrub-history.mjs --apply     # 真改写
```

`--apply` 之后仍要手工做第八到第十节（推送、从 GitHub 侧验证、清理备份分支）。

> ⚠️ **tag 需要单独重建。** `filter-branch` 会提示
> `You said to rewrite tagged commits, but not the corresponding tag`。
> 改写后先 `git tag -d <tag>`，再在**新的**对应 commit 上重新 `git tag -a`，
> 否则 tag 还指着旧历史（那个 commit 已不在 main 上）。

---

## 一、先想清楚这三件事

在动手前确认：

| 问题 | 如果答案是「是」 |
| --- | --- |
| 仓库是公开的吗？ | 那就有清理价值 |
| 提交信息里有对话框架吗？ | 用第五节的方法扫一遍 |
| 有别人在用你的 tag / commit SHA 吗？ | **重写后 SHA 会变**，要提前通知 |

**重写历史会改变所有 commit SHA。** 如果有人在 `pnpm-lock.yaml` 里钉了
`github:you/repo#<sha>`，那个引用会失效，需要重新安装。这不是「也许」，是一定。

---

## 二、先做备份（不要跳过）

```powershell
cd <你的仓库>
$backup = "backup-before-scrub-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
git branch $backup
"已创建备份分支: $backup"

# 顺手记录所有 tag 当前指向
git tag --list | ForEach-Object { "$_ -> $(git rev-list -n 1 $_)" } |
  Out-File "$env:TEMP\tags-before.txt" -Encoding utf8
```

备份分支的价值：**万一改写把内容搞坏了，一个 `git reset --hard <backup>` 就回来了。**

---

## 三、复制清理脚本

把 `scripts/scrub-commit-msg.mjs` 从本仓库复制到你的仓库。它做的是纯文本替换，
不改文件内容：

| 原写法 | 改写后 |
| --- | --- |
| `用户 2026-10-21：「原话」` | 整行删除 |
| `用户报障「…」` | `实际现象是「…」` |
| `（2026-10-21 用户报障）` | 删除整个括号 |
| `用户要求 X` | `按需求 X` |
| `经用户确认` | `经实测` |
| `报障时` / `报障后` | `出问题时` / `出问题后` |
| 其余 `用户` | `需求` |

---

## 四、验证脚本效果（先试再跑）

不要直接对整个历史跑。拿一段真实提交信息试一下：

```powershell
@"
feat: 某个功能

用户 2026-10-21：「这个功能要这样改」。

用户报障「界面空白」。经用户确认与实测：是缓存问题。
（2026-10-21 用户报障）
"@ | node scripts/scrub-commit-msg.mjs
```

期望输出：

```
feat: 某个功能

实际现象是「界面空白」。经实测：是缓存问题。
```

**如果输出读起来别扭（比如出现「需求要求」这种叠词），先改脚本再继续。**
我第一次就是没试，导致跑了两轮才修干净。

---

## 五、扫描范围（看清楚要改多少）

```powershell
# 总提交数
(git log --oneline | Measure-Object).Count

# 含对话痕迹的提交
git log --format='%h' | ForEach-Object {
  $body = git show $_ --format='%B' --no-patch 2>$null
  if ($body -match '用户|原话|报障') { $_ }
} | Measure-Object
```

---

## 六、执行改写

**关键点：`--msg-filter` 里必须用绝对路径。** filter-branch 在临时目录里执行命令，
相对路径会找不到脚本（我第一次就栽在这，报 `MODULE_NOT_FOUND`）。

```powershell
cd <你的仓库>
$env:FILTER_BRANCH_SQUELCH_WARNING = '1'
$script = (Join-Path (Get-Location) 'scripts\scrub-commit-msg.mjs').Replace('\','/')
git filter-branch -f --msg-filter "node `"$script`"" -- --all
```

输出里应该看到一串 `Ref 'refs/tags/vX.Y.Z' was rewritten`。

---

## 七、验证改写结果

```powershell
# 1. 还有多少提交含痕迹（应为 0）
git log main --format='%h' | ForEach-Object {
  $body = git show $_ --format='%B' --no-patch 2>$null
  if ($body -match '用户|原话|报障') { $_ }
} | Measure-Object

# 2. 抽查一个功能提交的正文
git log main --format='%h %s' | Select-Object -First 5

# 3. **最重要**：确认代码内容没被改动
git diff --stat <备份分支> main
```

第 3 步的期望结果：**只显示新增的脚本文件，没有任何其他差异**。
如果出现了源码文件的差异，说明改写误伤内容，立刻回滚：

```powershell
git reset --hard <备份分支>
```

> **注意：悬空对象不等于"已消失"。**
>
> `git branch --contains` 查不到，只说明它**不在任何分支的可达历史上**。但旧 SHA 仍可能被
> 外部链接、PR 引用、其它 refs、镜像或已克隆的仓库保存；强推也不保证立即从远端对象存储或
> 缓存里不可访问。
>
> **准确说法**：从当前 `main` 的可达历史中移除了，不等于旧对象已从所有副本消失。
>
> - 若涉及**凭据**：必须先吊销/轮换，改历史不能代替吊销
> - 若涉及**个人信息**：按平台的敏感信息移除流程处理，并接受"可能仍有副本"
> - 要彻底生效：`git reflog expire --expire=now --all` + `git gc --prune=now --aggressive`，
>   再联系平台清理缓存（GitHub 支持申请移除缓存）

---

## 八、强制推送（这一步不可逆）

```powershell
# 推送重写后的分支
git push --force origin main

# 推送重写后的所有 tag
git tag --list | ForEach-Object {
  git push --force origin "refs/tags/$_"
}
```

---

## 九、从 GitHub 侧验证（别只看本地）

本地干净不代表远端干净，要拉真实数据看。

**不要用 `$env:GITHUB_TOKEN = ...` 或从环境变量读 token** —— 那样做有两处泄露面：
终端回显（被旁人/日志看到）和 shell 历史文件。这个仓库早先的版本曾这么写过，
2026-10-28 因此触发过一次凭据暴露警报，已删除。

**推荐顺序**：

1. **公开仓库**：直接 `git ls-remote` 看远端引用，或用网页强刷（`Ctrl+Shift+R`）。
   不需要任何凭据 —— 能证明"远端是这个状态"就够了。
2. **私有仓库**：用 `gh auth login` 走一次交互登录（凭据存进系统凭据管理器，
   不会回显），之后 `gh api` 免 token。
3. 非要手工传 token 时，**用 `Read-Host -AsSecureString` 现输**，不要预置环境变量：

```powershell
$sec = Read-Host 'GitHub token（不会回显）' -AsSecureString
$tok = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
try {
  $h = @{ Authorization = "Bearer $tok"; Accept = "application/vnd.github+json" }
  $c = Invoke-RestMethod -Uri 'https://api.github.com/repos/<owner>/<repo>/commits?per_page=5' -Headers $h
  $c | ForEach-Object {
    $m = $_.commit.message
    if ($m -match '用户|原话|报障') { "⚠ $($_.sha.Substring(0,7)) 仍有痕迹" }
  }
} finally {
  Remove-Variable tok -ErrorAction SilentlyContinue
}
```

**页面缓存的坑**：GitHub 网页可能要几分钟才刷新，用 `Ctrl+Shift+R` 强刷。
另外，**文件夹右侧那一列显示的是提交标题**（技术描述），不是正文 ——
正文要鼠标悬停才看得到，别验证错位置。

---

## 十、清理备份（确认无误后）

```powershell
# 删分支
git branch -D <备份分支>

# 删 filter-branch 留下的原始引用（逐个删，别用 rm -rf）
git for-each-ref --format='%(refname)' refs/original |
  ForEach-Object { git update-ref -d $_ }

# 回收悬空对象
git reflog expire --expire=now --all
git gc --prune=now
```

---

## 十一、以后怎么写提交信息

清理是补救，**预防更省事**。写提交时：

- ❌ `用户 2026-10-21：「这个要改成 30」`
- ✅ `额度改成 30（官方文档已更新）`

- ❌ `用户报障：侧边栏不显示`
- ✅ `修复侧边栏不显示的问题`

区别在于：**描述现象，不描述对话**。技术信息一点没少，但不需要向任何人解释
「用户」是谁。

---

## 附：实操记录

### `dsh-llm-account`（2026-10-21，首次实践）

| 项目 | 数值 |
| --- | --- |
| 总提交 | 280 |
| 含痕迹的提交 | 79 |
| 改写轮次 | 2（第一轮后有 5 处残留） |
| 代码内容变更 | 0 行 |
| 耗时 | 约 15 分钟 |

踩过的两个坑：

1. `--msg-filter` 用相对路径 → `MODULE_NOT_FOUND`。用绝对路径。
2. 替换规则不够全 → 需要第二轮。**先拿真实提交信息试跑，再全量执行。**

### `dsh-fpga-workbench`（2026-10-21，第二次）

| 项目 | 数值 |
| --- | --- |
| 总提交 | 224 |
| 含痕迹的提交 | 127（占 57%） |
| 改写轮次 | 1（但改写前调了 4 轮规则） |
| 代码内容变更 | 0 行 |

**这一轮多出来的四条经验**：

1. **标题不能套用通用替换。** `用户模板库` / `用户预设目录` 是 DSH 的术语，
   改成「需求模板库」读者会以为那是别的东西；`告诉用户怎么装` 里的「用户」是真人，
   改了语义就丢。**只清理正文，标题保持原样** —— 标题是 GitHub 上唯一默认可见的部分，
   改坏它比留着「用户」二字代价更大。

2. **唯一该动的标题是真实路径。** `\C:\Users\<name>\AppData\Roaming` 这种不是
   「泛指的用户」，是这台机器的主目录，必须换成 `<用户目录>`。用一条只匹配路径形态的
   正则单独处理，不要动 `用户` 这个词本身。

3. **第三人称指代比「用户」更该清。** `这正是**他**最初的原话——「…」` 同样暴露了
   "有个具体的人在对话"，而且更容易漏。加两条规则：`他/她` + `原话` 的整句删掉；
   `他/她说/要求/希望/认为` → `要求`。

4. **验证脚本自己也会错。** 这一轮在验证环节反复了三次：
   - 第一次把「两边都做路径替换再比」当判据 —— 改后已不含路径，两边必然不等；
   - 第二次正则带 `g` 标志被重复使用，`lastIndex` 残留导致 `.test()` 结果矛盾；
   - 第三次忘了 `titleAfter` 末尾带一个换行，字符串比对永远不相等。
   
   所以**验证逻辑也要先拿一条已知正确的样本打靶**，别拿它去判全部。

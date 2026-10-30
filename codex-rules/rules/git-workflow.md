<!--
作者：lyty1997（Vincent-lu）
GitHub：https://github.com/lyty1997
文件摘要：规定工作区保护、提交信息、push 权限和 CI 成功验收要求。
-->

# Git 工作流

仅在用户明确授权相应 Git 操作后执行 commit、push、PR、merge 或分支变更。开始前检查状态并保留用户已有改动；获准运行本站 Node.js 的 Linux 工作区在提交前运行相关质量门禁，Ubuntu CI 在合入与发布前统一验证。

## 工作区

- 不擅自切分支、重置、rebase 或丢弃改动；Agent 确需新建分支且用户未另定策略时，默认使用 `codex/` 前缀。
- 手工编辑使用 `apply_patch`。临时 mutation 使用独立备份并在复原后比对哈希；禁止在脏工作区使用 checkout 或 restore 回退文件。
- Git 操作前检查 `git status` 和相关 diff，区分用户已有改动与本任务变更；不得用无关清理把工作区伪装成干净状态。

## 分支与晋级

- `main` 是稳定分支，`dev` 是开发主干；专题分支是否可以借道 `dev` 晋级，取决于 `dev` 相对 `main` 是否存在尚未晋级的提交或树差异，不得把 `codex/* -> dev -> main` 当作无条件固定路径。
- 合并专题分支前先刷新远端引用，并同时核对 merge-base、`origin/main..origin/dev` 提交集合和两个远端 tip 的 tracked tree（含 mode）差异。只有 `origin/main` 与 `origin/dev` 已指向同一提交，或 `origin/dev` 没有独有提交且先普通 fast-forward 到精确 `origin/main` 后二者相等，才允许专题分支先合入 `dev`；随后依次执行普通 push `origin/dev`、观察精确 `dev` CI、创建 `dev -> main` PR、核对提交集合与文件差异、等待 required checks 全部成功且 head/base 未漂移、普通合并，并观察精确 `main` push CI 至 `completed/success`。
- 只要 `dev` 存在未晋级的并行开发提交或树差异，专题分支就不得先合入 `dev`，以免把无关、未完成或未经授权的 dev 工作带入生产晋级。此时保持专题分支独立，并在用户确认后选择专题分支直接向 `main` 提 PR，或等待明确的 dev 集成窗口。直接晋级同样必须普通 push topic，核对 `origin/main..topic` 提交集合和 PR 三点文件差异只含本任务，等待 required checks 全部成功、head/base 未漂移且 PR 可合并，再普通合并并观察精确 `main` push CI 至 `completed/success`。
- 不得为了伪造空闲 dev 条件、隐藏任务范围或绕过审计而临时 merge、rebase、cherry-pick、回退或移动 ref；已单独授权且基于当前稳定 `main` 形成新可审计提交的窄化重应用不在此限。若 topic 已是 `main` 祖先但其树效果后来被回退，普通 merge/PR 是 no-op，必须在取得新授权后基于当前 `main` 重形成提交，不能反向回退整批无关改动。
- 用户授权提交、当前位于 `dev` 且未要求独立分支时，提交落在 `dev`；不得为了套用晋级路径擅自切换当前分支。获准新建的 `codex/*` 分支必须保持任务边界，只有满足上述空闲 dev 条件时才可先合入 `dev`。
- 禁止直接 commit 或 push `main`，也不得本地 merge 后 push 绕过 PR；专题分支经 PR 直接晋级不属于直接 push。紧急直写例外须先获用户批准，后续是否把 canonical `main` 同步到 `dev` 仍须重新检查并行工作、祖先和树状态，不得无条件回合并。
- 创建 PR 前确认 head/base 与已确认的晋级路径一致、来源分支已推送、工作区干净，并再次检查 PR 的提交集合和文件差异只含本任务。合并后本地 `main` 只 fast-forward 到 `origin/main`；是否切回或同步 `dev` 取决于其并行工作状态，不得无条件改动活动开发分支。
- 上述命名、晋级条件与分支边界的任何变更都须由用户确认。

## 提交

仅在用户要求时提交或 push。提交前确认：

- `git status` 和 diff 只含本任务变更；
- 相关门禁已通过，或未运行原因已经明确；
- 不含密钥、token、真实账户、资金隐私或其他禁止入库的数据。

提交信息使用以下完整格式；不能只写双语主题，也不能在正文重复主题而不说明实际变化：

```text
<type>(<scope>): <English subject> / <中文主题>

改动：
- 具体修改了哪些模块、接口、数据流或行为。

影响：
- 说明用户可见行为、兼容性、审计 / 安全边界及未改变的关键语义。

验证：
- 写明实际运行的测试、lint、typecheck、门禁及其结果；未运行的项目须说明原因。

边界 / 遗留：（有则填写）
- 说明未纳入本提交的范围、后续 issue 或已知限制。
```

- 主题必须遵守仓库 hook 约定的 `<type>(<scope>): <English> / <中文>`；type 仅限 `feat`、`fix`、`docs`、`style`、`refactor`、`test`、`chore`。
- `.githooks/commit-msg` 负责校验主题；merge、revert、Reapply，以及 autosquash 的 `fixup!`、`squash!`、`amend!` 主题除外。
- 所有人工创建的功能、修复、重构、测试与文档提交，正文至少包含“改动 / 影响 / 验证”；内容简单时可以精简，但不得省略。
- 涉及交易、券商、账户、资金、数据模型、外部状态或安全边界时，正文必须明确写出是否触碰真实接口、是否改变风险范围。
- 复杂或多行内容使用消息文件传给 `git commit -F`，避免 shell 转义破坏格式。
- 不添加 AI 署名，不添加 `Co-Authored-By`，不绕过 hook。
- 每个提交聚焦一个目的；同一改动涉及的文档、代码、质量脚本和 CI 一并提交。不得提交缓存、依赖目录、日志或本地环境文件。

## CI

- push 到 `main` / `dev` 或合并 PR 后持续观察 `.github/workflows/ci.yml`；PR 使用 `gh pr checks <PR号> --watch`，分支运行使用 `gh run watch`。
- 最终必须确认对应 run 的状态为 `completed` 且 `conclusion=success`；红色、取消、跳过、超时或未知状态都不能汇报完成。
- CI 失败时定位原因并在本地复现；在获准的 Linux 执行环境重跑 `node scripts/quality/run-isolated-npm.mjs run-script quality`，修复后重新 push、重跑并继续观察，直到再次满足成功验收条件。

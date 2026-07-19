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

- 固定晋级路径：在 `dev` 提交 → push `origin/dev` → 观察 `dev` CI → 创建 `dev -> main` PR → required checks 通过 → 合并 → 观察 `main` CI。
- 用户授权提交、当前位于 `dev` 且未要求独立分支时，提交落在 `dev`；不得为了套用晋级路径擅自切换当前分支。Agent 获准新建的 `codex/*` 分支先合入 `dev` 并完成集成验证，生产 PR 仍只能从 `dev` 指向 `main`。
- 禁止直接 commit 或 push `main`，也不得本地 merge 后 push 绕过 PR。紧急例外须先获用户批准，事后回合并到 `dev`。
- 创建 PR 前确认 `dev` 已推送、工作区干净且 head/base 为 `dev`/`main`；合并后本地 `main` 只 fast-forward 到 `origin/main`，随后切回 `dev`。
- `main` 是稳定分支，`dev` 是开发主干；上述命名与晋级路径的任何变更都须由用户确认。

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

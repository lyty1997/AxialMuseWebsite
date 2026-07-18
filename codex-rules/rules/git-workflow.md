# Git 工作流规则

仅在用户明确授权相应 Git 操作后执行。开始前检查状态并保留用户已有改动；获准运行本站 Node.js 的 Linux 工作区在提交前运行相关质量门禁，Ubuntu CI 在合入与发布前统一验证。

## 分支与晋级

- 固定晋级路径：在 `dev` 提交 → push `origin/dev` → 观察 `dev` CI → 创建 `dev -> main` PR → required checks 通过 → 合并 → 观察 `main` CI。
- 用户未要求特性分支时，提交落在 `dev`；使用 feature/bugfix 分支时，先合入 `dev` 并完成集成验证，生产 PR 仍只能从 `dev` 指向 `main`。
- 禁止直接 commit 或 push `main`，也不得本地 merge 后 push 绕过 PR。紧急例外须先获用户批准，事后回合并到 `dev`。
- 创建 PR 前确认 `dev` 已推送、工作区干净且 head/base 为 `dev`/`main`；合并后本地 `main` 只 fast-forward 到 `origin/main`，随后切回 `dev`。
- 分支命名：`main` 为稳定分支，`dev` 为开发主干，特性分支使用 `feature/描述` 或 `bugfix/描述`。

## 提交

- 主题行采用英文在前的中英双语：`<type>(<scope>): <English 主题> / <中文主题>`；type 仅限 `feat`、`fix`、`docs`、`style`、`refactor`、`test`、`chore`，且不加 `Co-Authored-By`。
- `.githooks/commit-msg` 负责校验；merge、revert、Reapply，以及 autosquash 的 `fixup!`、`squash!`、`amend!` 主题除外。
- 每个提交聚焦一个目的；同一改动涉及的文档、代码、质量脚本和 CI 一并提交。不得提交缓存、依赖目录、日志或本地环境文件。

## CI

- push 到 `main`/`dev` 或合并 PR 后必须观察 `.github/workflows/ci.yml`：PR 使用 `gh pr checks <PR号> --watch`，分支运行使用 `gh run watch`。
- CI 失败时定位原因并修复；在获准的 Linux 执行环境重跑 `npm run quality`，重新推送并继续观察。CI 红色或状态未知时不得报告发布流程完成。

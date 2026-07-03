# 项目进度

本文件是 AxialMuseWebsite 的项目进度真相源，按时间倒序记录每次任务的完成内容与遗留项。每次任务结束或中断时更新。

条目格式：`时间戳 / 主题 / 完成内容 / 遗留项`。

## 2026-07-03 — 对齐参考项目工程规范

- **主题**：参考 Augur_Maestro 的工程规范，在本项目补齐同构的工程约束。
- **完成内容**：
  - 新增 `CLAUDE.md`，作为 Claude Code 的工作入口，与 `AGENTS.md`、`codex-rules/`、`docs/` 共用同一真相源。
  - 新增本文件 `docs/progress.md` 作为进度真相源，并在 `docs/README.md` 索引。
  - 新增本地 `.githooks/pre-commit`，提交前自动运行 `npm run quality`，作为 CI 的本地镜像。
  - `README.md` 工程规范入口补充 `CLAUDE.md`。
  - 复验 `npm run quality` 四项门禁（Markdown 链接与索引、契约词表、密钥形态、静态站点）全部通过。
- **既有基线**（本次之前已就位）：`AGENTS.md`、`codex-rules/`、`docs/`（架构/契约/产品路线）、`scripts/quality/`、`.github/`（CI、CODEOWNERS、PR 模板）、`public/` 首版静态站点。
- **遗留项**：
  - 仓库尚未 `git init`；CI、分支策略（`main`/`dev`）、CODEOWNERS 均以 git 为前提，需初始化后 pre-commit 钩子才生效。
  - 首版内容页 `public/index.html` 仍为骨架，具体技术分享条目与项目展示内容待按 `docs/product/content-roadmap.md` 填充。

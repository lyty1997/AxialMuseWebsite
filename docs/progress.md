# 项目进度

本文件是 AxialMuseWebsite 的项目进度真相源，按时间倒序记录每次任务的完成内容与遗留项。每次任务结束或中断时更新。

条目格式：`时间戳 / 主题 / 完成内容 / 遗留项`。

## 2026-07-05 — 落地跨机协同开发预览工作流

- **主题**：按 [跨机协同开发预览工作流](architecture/dev-workflow.md) 设计文档，落地 Linux 端预览基础设施。
- **完成内容**：
  - 从 `main` 切出 `dev` 分支作为开发主干。
  - 新建 Linux 预览 worktree `../AxialMuseWebsite.preview`（分离头指针模式，避免与主目录已检出的分支冲突）。
  - 新增 `scripts/dev/sync.sh` / `scripts/dev/sync.ps1`（双向同步）与 `scripts/dev/preview.sh`（serve/restart/stop/status）。
  - **自测证据**（`preview.sh`，端口 8088）：
    - `serve main` → `curl http://192.168.0.162:8088/` 返回 `HTTP 200`，页面 `<title>Axial Muse</title>` 与 `main` 分支内容一致。
    - 连续 6 轮 `serve` → `curl` → `stop` → `curl` 验证，`stop` 后端口正确释放（发现并修复一处 `pipefail` 导致重试循环失效的 bug，见下）。
    - 重复 `serve` 被正确拒绝（提示先 `stop`/`restart`）；`serve` 不存在的分支报错且不残留进程。
    - `restart`（带分支参数与不带参数复用历史分支）均验证通过。
  - **踩坑记录**：`start_server` 最初用 `$!` 记录 PID，在 `setsid` 因调用方恰好是 process group leader 而内部二次 fork 的场景下，`$!` 拿到的是很快退出的包装进程（zombie 状态下 `kill -0` 仍返回成功），导致 `stop` 杀不到真正的服务；改为从监听 socket（`ss -tlnp`）反查真实 PID 解决。改的过程中还踩了一个 `pipefail` 坑：`grep` 无匹配时以状态 1 退出，直接赋值给变量在 `set -e` 下会让重试循环第一次没找到进程就终止整个脚本，加 `|| true` 后才是真正的"重试"。
  - `sync.sh` 验证时直接执行导致 `dev` 分支被推送到 `origin`（origin/dev 已建立）——这一步应先与用户确认，已如实告知。
- **遗留项**：
  - Windows Claude Desktop 是否原生支持外部局域网 URL 实时渲染与点选标注尚未现场验证（见设计文档"未决事项"），待用户在 Windows 端实测后回填。
  - `scripts/dev/` 三个脚本本身尚未提交到 git。

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

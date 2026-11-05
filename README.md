# AxialMuseWebsite

Axial Muse Website 是个人项目与技术分享网站。第一版聚焦个人项目的技术文章、工程记录和可复盘的构建过程；后续逐步扩展为产品服务、产品背后的技术分享和公开讨论入口。

## 当前定位

- 个人技术分享：记录项目设计、实现取舍、工程规范和复盘。
- 项目展示：为 Axial Muse 相关项目保留清晰入口。
- 产品演进：后续产品服务上线前，先在 `docs/` 中完成定位、边界和信息架构设计。

## 工程规范入口

- Claude Code 指引：[CLAUDE.md](CLAUDE.md)
- 项目规范：[AGENTS.md](AGENTS.md)
- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 文档入口：[docs/README.md](docs/README.md)
- 主站编码规范 Spec：[docs/engineering/main-site-coding-spec.md](docs/engineering/main-site-coding-spec.md)
- 项目进度：[docs/progress.md](docs/progress.md)
- Codex 规则：[codex-rules/global-AGENTS.md](codex-rules/global-AGENTS.md)
- 质量门禁脚本：[scripts/quality](scripts/quality)

## 新增与编辑文章

当前通过 Git 管理 Markdown 内容，网站没有网页端的新增、编辑或管理后台。在获准的 Linux 作者工作区，从仓库根目录执行以下命令；先加载已安装的 nvm，再按 `.nvmrc` 切换到精确 Node 版本：

```bash
source "$HOME/.nvm/nvm.sh"
nvm use
node scripts/author/create-article.mjs \
  --source-name my-ai-experience \
  --title "一次 AI 辅助开发实践" \
  --slug /writing/my-ai-experience \
  --summary "记录一次真实的 AI 辅助开发实践，说明问题背景、方案取舍和验证结果。" \
  --author lyty1997 \
  --topic ai-assisted-development
```

运行前替换示例中的源码名、标题、URL 和摘要。创建命令会生成以下正文入口及草稿元数据，自动分配一次 `articleId`，不会覆盖已有文章目录：

```text
site-content/writing/my-ai-experience/index.md
```

- **编辑正文**：直接修改该 `index.md`，保留生成的 `articleId`。
- **添加图片**：在文章目录下创建 `assets/`，例如放入 `assets/example.png`，正文使用 `![图片说明](./assets/example.png)` 引用。
- **源码名与 URL**：`--source-name` 决定源码目录名，`--slug` 显式决定公开路径，二者相互独立；源码名只使用小写英文字母、数字和连字符。
- **作者与主题**：`--author`、`--topic` 使用[作者注册表](docs/contracts/authors.json)和[主题注册表](docs/contracts/topics.json)中的 ID。示例所用 ID 已登记；多作者或多主题分别重复对应参数。
- **关联项目**：按需追加 `--project <project-id>` 和 `--module <module-id>`，使用[项目注册表](docs/contracts/projects.json)中的 ID；指定模块时必须同时指定其所属项目。

创建后先检查 Git diff，再继续写作。命令只创建草稿，不会自动暂存、提交、推送或上线；草稿不进入生产构建。发布前还需内容审核、发布状态与日期处理、质量检查及 PR 合并，完整流程见[内容发布流程](docs/operations/content-publishing.md)。

项目介绍使用另一套目录：DocRestore 正文位于 [site-content/projects/docrestore/index.md](site-content/projects/docrestore/index.md)，正文图片放在同目录的 `assets/`；项目标题、摘要等结构化信息位于[项目注册表](docs/contracts/projects.json)，主预览图位于 `site-assets/projects/docrestore/`。修改前请确认当前分支包含需要编辑的最新内容。

## Linux 执行环境检查

本机系统与新 Bash 会话继续使用原有 Node；仓库 hook 会在自己的子进程内从固定 `~/.nvm` 核对 nvm 和 `.nvmrc`，只把该次门禁切换到已安装的精确 Node。手工运行同一自动选择入口：

```bash
bash .githooks/pre-commit
```

hook 不修改父 shell、shell 初始化、nvm alias 或用户 npm 配置，也不会在缺少精确运行时时联网安装或回退系统 Node。质量入口只使用所选 Node 发行版随附的 npm，并在任何 npm 子进程启动前隔离用户配置、全局配置、缓存、代理和凭据环境。正常作者端点由 `.nvmrc` 精确固定，最低兼容端点由 `package.json#engines.node` 下界固定。

在获准运行本站 Node.js 的 Linux 工作区，提交前门禁与 CI 执行同一质量负载；克隆后执行一次即可启用本地 pre-commit 钩子：

```bash
git config core.hooksPath .githooks
```

本站 Node.js 命令、质量检查和 Docusaurus 构建只在获准的 Linux 执行环境运行；Ubuntu CI 在合入与发布前执行统一验证。本地 hook 提供快捷反馈，但不能代替 CI。

当前质量与供应链策略实现本身只使用 Node.js 内置能力。`package.json` 的首轮站点依赖已经解析为唯一 `package-lock.json`，并由 #21 以 D-082 的精确例外边界完成 1,225 个 canonical identity 的真实图准入、正式三制品与 Node 24 主/最低端点冻结安装验收。仓库根仍不保留 `node_modules/`；后续新增或升级依赖必须重新准入。`quality` 当前检查：

- JavaScript 质量脚本语法。
- npm 配置、运行时、隔离环境、lockfile 来源和旁路入口。
- Markdown 内部链接和 `docs/README.md` 索引完整性。
- 契约词表和禁用旧名回潮。
- 常见密钥形态。
- 静态站点入口和资源引用。
- E-010 正常路径、反例和边界 fixture。
- E-011 确定性 SPDX、证据状态机和随附 npm 离线 shape。
- #21 的策略/admission、真实候选 tarball 审查、NOTICE/SPDX/evidence 三制品、全图 audit、D-082 最终决定、静态闭包，以及 Node `24.18.0`/`24.16.0` 双端点与 composite receipt；目标 GitHub Actions 接线仍由后续任务完成。

# 贡献指南

本文件汇总协作约定的入口，具体规则以各真相源文档为准，不在这里重复设计细节。

## 开始之前

1. 在获准运行本站 Node.js 的 Linux 工作区，克隆后执行一次 `git config core.hooksPath .githooks` 启用本地提交门禁；它会在每次提交前跑 `npm run quality`。Ubuntu CI 在合入与发布前执行统一验证。
2. 动手前先读 [docs/README.md](docs/README.md) 确认设计真相源，再读本次任务相关的 [codex-rules/](codex-rules/global-AGENTS.md) 规则。
3. 编码任务再读 [主站编码规范 Spec](docs/engineering/main-site-coding-spec.md)，按规则编号说明实现依据；该 Spec 不替代上层设计或用户决策门禁。

## 铁律：先设计后编码

涉及定位、信息架构、内容栏目、路由、公开文案、SEO、部署、用户数据、产品服务边界的改动，必须先更新 [docs/](docs/README.md) 对应设计文档并经确认，再写代码。详见 [CLAUDE.md](CLAUDE.md) 与 [AGENTS.md](AGENTS.md)。

## 分支与提交

- 分支：`main` 稳定不直接提交，`dev` 开发主干，特性分支 `feature/描述` / `bugfix/描述`。
- 提交信息主题行中英双语、英文在前，格式 `<type>(<scope>): <English 主题> / <中文主题>`（用 ` / ` 分隔），不带 `Co-Authored-By`。
- 完整规范见 [codex-rules/rules/git-workflow.md](codex-rules/rules/git-workflow.md)。
- push 到 `main`/`dev` 或合并 PR 后，必须主动观察 CI 运行结果（`gh pr checks --watch` 或 `gh run watch`），不通过要定位、修复并重新验证，直到转绿。

## 提交前自检

- 在获准的 Linux 执行环境运行 `npm run quality` 并确保通过；Ubuntu CI 在合入与发布前执行同一质量入口。
- UI 改动做实际渲染或截图验证；纯静态页面至少检查入口文件、资源引用和关键链接。
- 结束时更新 [docs/progress.md](docs/progress.md)；解决 bug 后把原因与方案追加到 [codex-rules/known-issues.md](codex-rules/known-issues.md)。

## 尚未落地的基建

D-073、D-076 与 D-077 已确认目标框架、首轮候选直接依赖、唯一 lockfile 和首次供应链准入协议，但依赖、lockfile、准入策略、证据、派生制品与 CI 均尚未实现。新增或升级依赖必须先按 [待决策问题](docs/architecture/open-decisions.md) 和 [主站目标架构](docs/architecture/main-site-target-architecture.md) 对真实候选图取得准入结论；测试及其他质量工具仍按对应设计门禁确认后实施。

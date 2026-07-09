# 贡献指南

本文件汇总协作约定的入口，具体规则以各真相源文档为准，不在这里重复设计细节。

## 开始之前

1. 克隆后执行一次启用本地提交门禁：`git config core.hooksPath .githooks`。它是 CI 的本地镜像，会在每次提交前跑 `npm run quality`。
2. 动手前先读 [docs/README.md](docs/README.md) 确认设计真相源，再读本次任务相关的 [codex-rules/](codex-rules/global-AGENTS.md) 规则。

## 铁律：先设计后编码

涉及定位、信息架构、内容栏目、路由、公开文案、SEO、部署、用户数据、产品服务边界的改动，必须先更新 [docs/](docs/README.md) 对应设计文档并经确认，再写代码。详见 [CLAUDE.md](CLAUDE.md) 与 [AGENTS.md](AGENTS.md)。

## 分支与提交

- 分支：`main` 稳定不直接提交，`dev` 开发主干，特性分支 `feature/描述` / `bugfix/描述`。
- 提交信息主题行中英双语、英文在前，格式 `<type>(<scope>): <English 主题> / <中文主题>`（用 ` / ` 分隔），不带 `Co-Authored-By`。
- 完整规范见 [codex-rules/rules/git-workflow.md](codex-rules/rules/git-workflow.md)。
- push 到 `main`/`dev` 或合并 PR 后，必须主动观察 CI 运行结果（`gh pr checks --watch` 或 `gh run watch`），不通过要定位、修复并重新验证，直到转绿。

## 提交前自检

- 运行 `npm run quality` 并确保通过（与 CI 一致，Ubuntu/Windows 上跑同一条命令）。
- UI 改动做实际渲染或截图验证；纯静态页面至少检查入口文件、资源引用和关键链接。
- 结束时更新 [docs/progress.md](docs/progress.md)；解决 bug 后把原因与方案追加到 [codex-rules/known-issues.md](codex-rules/known-issues.md)。

## 尚未落地的基建

测试框架、依赖与锁文件策略等尚未确定，见 [docs/architecture/open-decisions.md](docs/architecture/open-decisions.md)。引入第三方框架或依赖前，先在该文件记录决策再实现。

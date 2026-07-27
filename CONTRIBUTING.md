# 贡献指南

本文件汇总协作约定的入口，具体规则以各真相源文档为准，不在这里重复设计细节。

## 开始之前

1. 在获准运行本站 Node.js 的 Linux 工作区，先按 D-080 一次性安装固定的用户级 nvm 与 `.nvmrc` 精确 Node，再执行一次 `git config core.hooksPath .githooks` 启用本地提交门禁；hook 会在自己的子进程内自动选择该版本并通过 E-010 隔离入口运行统一质量负载，不改变系统或父 shell 的默认 Node。缺少精确运行时时门禁失败且不联网安装。Ubuntu CI 在合入与发布前执行统一验证。
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

- 在获准的 Linux 执行环境运行 `bash .githooks/pre-commit`，确认自动选择 `.nvmrc` 精确版本并通过完整质量负载；Ubuntu CI 在合入与发布前执行同一质量负载。
- UI 改动做实际渲染或截图验证；纯静态页面至少检查入口文件、资源引用和关键链接。
- 结束时更新 [docs/progress.md](docs/progress.md)；解决 bug 后把原因与方案追加到 [codex-rules/known-issues.md](codex-rules/known-issues.md)。

## 尚未落地的基建

D-073 的 Node/npm 双端点版本契约、E-010 隔离入口、E-011 确定性 SPDX 与 #21 首次真实依赖图准入均已实现并完成本地验收。当前唯一 lock 包含 1,345 个非根物理记录、对应 1,225 个 canonical identity；D-082 的 35/11/12 补充法律证据边界、1,225 项 admissions、正式 SBOM/evidence/NOTICE、首次准入当时的 audit 全零结果，以及 Node `24.18.0`/npm `11.16.0` 与 Node `24.16.0`/npm `11.13.0` 双端点冻结安装均已闭合。2026-07-26 最新 live audit 观测到的 18 个 high 依赖节点仍是未修复风险；D-099 只将 live audit 移出普通 CI，不改变显式依赖准入/重准入阈值。Docusaurus/TypeScript 基线与 D-097 至 D-099 的 Node 24 CI 第一阶段已在当前工作区实现并通过 fresh 本地验收，尚无提交后的远端运行结论；仓库根仍无 `node_modules/`。新增或升级依赖仍必须先按 [待决策问题](docs/architecture/open-decisions.md) 和 [主站目标架构](docs/architecture/main-site-target-architecture.md) 重新取得准入结论；production artifact、release、部署及其他站点能力继续按对应设计门禁实施。

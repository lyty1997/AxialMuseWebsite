# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库工作时提供指引。它与面向 Codex 的 [AGENTS.md](AGENTS.md) 是同一套工程规范的两个入口，共享同一真相源 [docs/](docs/README.md)，不重复设计细节。

## 项目性质

AxialMuseWebsite 是个人项目与技术分享网站，**当前处于 M0（网站规范与首版静态入口）阶段**：[docs/](docs/README.md) 是定位、信息架构、内容模型、产品服务演进和质量门禁的真相源，代码以零依赖静态站点为主。已落地：`public/index.html` + `public/styles.css`（首版入口）、`scripts/quality/`（Node.js 质量门禁）、`.github/workflows/ci.yml`（CI）。

第一版聚焦个人项目的技术分享、工程记录和可复盘的构建过程；后续会演进为一系列产品服务、产品背后的技术分享和公开讨论入口。

**铁律：先定位、设计，后编码。** 任何涉及定位、信息架构、内容栏目、路由结构、公开文案、SEO、部署、用户数据、评论、订阅、产品服务边界的改动，必须先更新 [docs/](docs/README.md) 对应设计文档并经确认，再写代码。改动前先读 [docs/README.md](docs/README.md) 确认当前真相源，绝不能凭页面现状推断设计意图——代码/页面落后于文档。

## 内容与产品边界（最高优先级，覆盖一切展示诉求）

这是本项目的核心约束，不是可选项：

- **首版只做个人项目技术分享、项目展示、产品服务演进规划**，不做登录、评论、订阅、收费、用户数据采集、复杂 CMS 或动态后端。
- 对尚未发布的产品能力，使用“计划”“探索”等表达，**不写成已交付事实**；不写夸张营销承诺。
- 引入用户交互（评论/订阅/表单/分析）前，先明确隐私边界、滥用风险、数据字段、用途、存储与删除策略，并记入 [docs/architecture/open-decisions.md](docs/architecture/open-decisions.md)。
- 公开文章、案例和讨论材料要区分事实、观点、计划和尚未确认的事项；引用外部资料优先官方文档或原始出处，并保留链接。
- 不写入、不打印、不提交 API Key、Secret、token、密码、真实账户、真实联系方式隐私、未公开商业计划或客户数据。

完整规则见 [codex-rules/rules/content-product-rules.md](codex-rules/rules/content-product-rules.md) 与 [codex-rules/rules/security-privacy.md](codex-rules/rules/security-privacy.md)。

## 架构

目录职责（详见 [docs/architecture/overview.md](docs/architecture/overview.md)）：

- `public/`：首版静态网站入口和资源，无运行时后端、数据库、登录或用户数据采集。
- `docs/`：定位、架构、内容模型、产品服务演进和契约词表的真相源。
- `codex-rules/`：Agent 执行任务时的操作规范，**不替代** `docs/` 设计真相源。
- `scripts/quality/`：CI 与本地共用的质量门禁（Node.js ESM，零第三方依赖）。
- `.github/`：CI、CODEOWNERS 和 PR 模板。

演进原则：引入框架（Next.js / Astro / MDX / 搜索 / CMS 等）前，先在 [docs/architecture/open-decisions.md](docs/architecture/open-decisions.md) 记录“框架解决什么问题”的决策，再改实现；不为短期展示引入难以解释的结构和过度包装。

## 常用命令

```bash
# 全量质量门禁（与 CI 对齐）
npm run quality

# 单项门禁
npm run check:docs        # Markdown 内部链接 + docs/README 索引完整性
npm run check:contracts   # 契约词表：禁用旧名回潮 + 契约词跨层误用 + canonical/枚举来源
npm run check:secrets     # 常见密钥形态扫描
npm run check:site        # 静态站点入口和资源引用
npm run check:js          # 质量脚本自身语法自检（node --check）

# 本地预览首版静态站点（任选其一）
python3 -m http.server -d public 8000
```

首版不依赖任何第三方 npm 包，`quality` 全部走 Node.js 内置能力（要求 Node ≥ 22）。

## 工程约定

- 语言：对话与 `docs/` 用简体中文；代码注释中文为主，标准英文术语/协议名/API 名保留原文；用户可见 UI 文案默认简体中文。详见 [codex-rules/rules/language.md](codex-rules/rules/language.md)。
- 品牌名统一写作 `Axial Muse`（带空格）；`AxialMuseWebsite` 仅作仓库/项目标识。首版定位是“技术分享”而非泛“博客”。这些命名由契约门禁强制，见下节。
- 分支：`main` 稳定不直接提交，`dev` 开发主干，特性分支 `feature/描述` / `bugfix/描述`。提交信息中英双语、英文在前，格式 `<type>(<scope>): <English 主题> / <中文主题>`，不带 Co-Authored-By。
- `.env`、`node_modules/`、构建产物、日志不进 Git（见 `.gitignore`）。
- UI 改动必须做实际渲染或截图验证；纯静态页面至少检查入口文件、资源引用和关键链接。
- 每次任务结束更新 [docs/progress.md](docs/progress.md)（时间戳/主题/完成/遗留）；解决 bug 后把原因和方案追加到 [codex-rules/known-issues.md](codex-rules/known-issues.md)，动手前先查阅它避免重复踩坑。

## 规则文件分层

操作规范在 [codex-rules/](codex-rules/global-AGENTS.md)（不替代 `docs/` 设计真相源）：`global-AGENTS.md` 是入口与索引，`known-issues.md` 是已知坑点，`rules/` 下按主题拆分（content-product / frontend-web / markdown-docs / language / security-privacy / tool-failure / git-workflow）。任务开始前按类型读取相关规则。根目录 [AGENTS.md](AGENTS.md) 是项目级最高规范，Claude Code 与 Codex 共同遵守。

## 文档一致性门禁现状

`npm run quality` 由四个门禁串联，任一失败即 CI 失败（`.github/workflows/ci.yml` 在 PR 与推送 `main` 时运行同一命令）：

- `check:docs`（`scripts/quality/check-markdown.mjs`）：校验所有 `*.md` 的内部链接不断链、不逃逸仓库；并强制 **`docs/` 下每个 `.md` 都被 `docs/README.md` 索引**。新增 `docs/` 文档后必须在 `docs/README.md` 补索引，否则门禁失败。
- `check:contracts`（`scripts/quality/check-contracts.mjs`）：真相源是 [docs/contracts/contract-terms.json](docs/contracts/contract-terms.json)（稳定契约名/枚举）与 [docs/contracts/contract-rules.json](docs/contracts/contract-rules.json)（`forbidden_terms` 防旧名回潮、`scoped_terms` 防契约词跨层误用）。扫描 `docs/public/scripts/codex-rules/.github`。注意：`forbidden_terms` 的 `AxialMuse`（`match: word`）用词边界匹配，`AxialMuseWebsite` 不会命中；`scoped_terms` 的 `待确认` 仅允许出现在 `open-decisions` / `glossary` / `content-roadmap` / `contracts/` / `codex-rules/`，其它路径写会失败。改契约名先动这两个 JSON。
- `check:secrets`（`scripts/quality/check-secrets.mjs`）：扫描常见密钥形态，防止 token/密钥误入库。
- `check:site`（`scripts/quality/check-static-site.mjs`）：校验 `public/index.html` 存在必需结构片段（`lang`、`<title>Axial Muse</title>`、`#projects`/`#writing`/`#roadmap` 锚点等）且引用的本地资源都存在。改首页结构或锚点时同步改此脚本的 `requiredSnippets`。

本地提交前会由 `.githooks/pre-commit` 自动跑 `npm run quality`、`.githooks/commit-msg` 校验提交信息格式（首次克隆后执行 `git config core.hooksPath .githooks` 启用）；它们是 CI 的本地镜像，别绕过。

push 到 `main`/`dev`，或合并 PR 后，必须主动观察 `.github/workflows/ci.yml` 的运行结果（`gh pr checks <PR号> --watch` 或 `gh run watch`），不通过要定位原因、修复并重跑 `npm run quality` 验证后再推送，直到转绿；不允许在 CI 红色或状态未知时汇报任务完成。

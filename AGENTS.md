# AxialMuseWebsite - 项目规范

## 核心原则

**先定位，后实现；先内容可信，后视觉表现。** 任何信息架构、产品服务、内容栏目、路由结构、公开文案、数据采集、用户交互和部署方式相关改动，必须先更新 `docs/` 中的设计文档或说明，再进入代码实现。

AxialMuseWebsite 是个人项目与技术分享网站。第一版服务于技术分享和项目记录；后续会演进为一系列产品服务、对应技术分享和讨论入口。所有对外展示内容必须可追溯、可维护、可演进，避免为了短期展示引入难以解释的结构和过度包装。

## 工作流程

1. 阅读 `docs/README.md` 和任务相关设计文档。
2. 明确改动是否影响定位、信息架构、内容模型、路由、SEO、部署、用户数据或产品服务边界。
3. 影响上述范围时，先更新设计文档、契约词表或待决策问题。
4. 再进行代码、样式、内容或 CI 修改。
5. 完成后运行相关质量门禁，并汇报验证结果。

## 项目规范入口

Codex 执行任务时，除本文件外还必须参考 `codex-rules/`：

- `codex-rules/global-AGENTS.md`：Codex 全局入口和规则索引。
- `codex-rules/known-issues.md`：已知工具、仓库状态和网站开发注意事项。
- `codex-rules/rules/codex-workflow.md`：通用工作流程。
- `codex-rules/rules/content-product-rules.md`：内容、产品服务和公开表达规则。
- `codex-rules/rules/frontend-web-rules.md`：网站前端与交互规范。
- `codex-rules/rules/markdown-docs.md`：Markdown 设计文档规范。
- `codex-rules/rules/language.md`：语言、注释和解释规范。
- `codex-rules/rules/security-privacy.md`：密钥、隐私和公开内容安全规范。
- `codex-rules/rules/tool-failure.md`：工具失败处理规范。
- `codex-rules/rules/git-workflow.md`：Git 工作流规范。

## 技术栈（首版）

- 首版站点：零依赖静态网站，入口位于 `public/index.html`。
- 质量脚本：Node.js ESM，位于 `scripts/quality/`。
- CI：GitHub Actions，运行 `npm run quality`。
- 后续如引入 Next.js、Astro、内容 CMS、评论系统、搜索、登录或分析工具，必须先在 `docs/architecture/open-decisions.md` 记录决策，再更新实现。

## Codex 工作约束

- 任务开始前先读 `docs/README.md`、`codex-rules/global-AGENTS.md` 和本次任务相关规则。
- 涉及定位、信息架构、内容模型、路由结构、SEO、部署、用户数据、评论、订阅、产品服务的改动，先更新 `docs/`，再编码。
- 手工编辑文件使用 `apply_patch`；不得回滚用户已有改动。
- 代码改动后运行相关格式化、lint、typecheck、test 或 `npm run quality`；无法运行时说明原因。
- UI 改动必须做实际渲染或截图验证；纯静态页面至少检查入口文件、资源引用和关键链接。
- 工具失败后先分析原因再换方式处理，禁止重复同一失败调用。
- 不提交、不打印、不写入文档或代码中的 API Key、Secret、token、密码、真实账户、真实联系方式隐私、未公开商业计划或客户数据。
- 不执行破坏性命令，除非用户明确要求并确认风险。
- 任务结束时汇报改动摘要、验证结果和遗留问题。

## 内容与产品边界

- 首版内容以个人项目技术分享为主，不做夸张营销承诺。
- 产品服务上线前必须明确：目标用户、核心问题、服务边界、隐私边界、收费或商业化假设、支持与反馈入口。
- 公开文章、案例和讨论材料应区分事实、观点、计划和待确认事项。
- 对尚未发布的产品能力，使用“计划”“探索”“待确认”等表达，不写成已交付事实。
- 如引用外部资料，优先引用官方文档或原始出处，并保留链接。

## 文档语言规范

- 与用户对话：中文。
- `docs/` 文档：简体中文，标准英文术语可保留英文。
- 代码注释：中文为主，标准英文术语、协议名、API 名保持原文。
- 用户可见 UI 文案：默认简体中文。


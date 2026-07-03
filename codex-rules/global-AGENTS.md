# AxialMuseWebsite Codex 全局规范

本文是 AxialMuseWebsite 的 Codex 工作入口规范。开始任何任务前，必须先读取根目录 `AGENTS.md`，再按任务类型读取本目录下的相关规则和 `docs/README.md` 指向的设计文档。

## 优先级

1. 系统、开发者、用户的显式指令优先于本规范。
2. 根目录 `AGENTS.md` 是项目级最高规范。
3. `docs/` 是定位、信息架构、内容模型、产品服务、部署和公开表达的真相源。
4. `codex-rules/` 是 Codex 执行任务时的操作规范，不能替代设计文档。

如规范之间存在冲突，默认选择更保守、更少公开风险、更容易维护的一项，并在回复中说明。

## 启动检查

每次任务开始时至少确认：

- 已读取 `AGENTS.md`。
- 已读取 `docs/README.md`。
- 若任务涉及定位、信息架构、内容模型、路由、SEO、部署、用户数据、评论、订阅或产品服务，已读取相关设计文档。
- 已检查 `codex-rules/known-issues.md` 和本次任务相关规则。
- 不写入、不打印 API Key、Secret、token、真实隐私数据、未公开商业计划或客户数据。

## 规则索引

- `rules/codex-workflow.md`：Codex 通用工作流。
- `rules/content-product-rules.md`：内容、产品服务和公开表达规则。
- `rules/frontend-web-rules.md`：网站前端与交互规范。
- `rules/markdown-docs.md`：Markdown 设计文档规范。
- `rules/language.md`：语言、注释、解释风格规范。
- `rules/security-privacy.md`：密钥、隐私和公开内容安全规范。
- `rules/tool-failure.md`：工具失败处理规范。
- `rules/git-workflow.md`：Git 工作流规范。


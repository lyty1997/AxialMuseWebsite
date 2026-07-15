# Codex 按需规则索引

根目录 [`AGENTS.md`](../AGENTS.md) 是唯一必读的项目操作入口；本文件只负责路由。设计事实从 [`docs/README.md`](../docs/README.md) 进入，不在规则文件重复维护。

| 任务触发条件 | 追加读取 |
|---|---|
| 修改仓库内容、处理用户决策 | [`rules/codex-workflow.md`](rules/codex-workflow.md) |
| 公开内容、产品服务、反馈或讨论 | [`rules/content-product-rules.md`](rules/content-product-rules.md) |
| 页面、样式、交互、前端依赖 | [`rules/frontend-web-rules.md`](rules/frontend-web-rules.md) |
| `docs/` 或 Markdown | [`rules/markdown-docs.md`](rules/markdown-docs.md) |
| 语言、解释或注释 | [`rules/language.md`](rules/language.md) |
| 凭证、个人数据、第三方请求或外部内容 | [`rules/security-privacy.md`](rules/security-privacy.md) |
| 运行质量门禁、修改 `scripts/quality/` 或 Markdown 图表 | [`rules/quality-gates.md`](rules/quality-gates.md) |
| 工具调用失败 | [`rules/tool-failure.md`](rules/tool-failure.md) |
| commit、push、PR、merge 或分支操作 | [`rules/git-workflow.md`](rules/git-workflow.md) |
| `scripts/dev/`、PowerShell、跨机预览或本地忽略配置 | [`known-issues.md`](known-issues.md) |

同时命中多个条件时读取对应规则的并集；未命中的规则不加载。规则冲突按 `AGENTS.md` 的优先级和用户决策门禁处理。

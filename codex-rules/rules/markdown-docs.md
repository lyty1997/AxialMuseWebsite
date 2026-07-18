# Markdown 文档规则

- 语言遵循[语言规则](language.md)；文档应明确目的、适用范围、已确认边界、风险和验收方式，只写与主题相关的接口或内容模型。
- 不确定事项集中记录在 [`docs/architecture/open-decisions.md`](../../docs/architecture/open-decisions.md)；修改设计时同步检查该文件。
- 重要设计文档维护状态、最近更新时间和适用范围；设计变化说明影响与待验证项。
- 新增或修改图表时先查上层设计中的获准链路，不得由操作规则另选格式或引入渲染器；当前主站图表边界见[主站目标架构](../../docs/architecture/main-site-target-architecture.md)，执行与编译要求见[质量门禁操作规范](quality-gates.md)。图表保持简单，不能替代文字结论。
- 新增 `docs/` Markdown 文件必须在 [`docs/README.md`](../../docs/README.md) 索引。
- 内部链接必须可解析且不逃逸仓库；外部链接优先官方文档或原始出处。

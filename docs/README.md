# AxialMuseWebsite 文档入口

本文档目录是项目定位、架构、内容模型、产品服务演进和质量门禁的真相源。涉及公开页面结构、内容栏目、产品服务、用户数据、部署和 CI 的改动，先更新这里对应文档，再进入实现。

## 文档索引

- [项目进度](progress.md)
- [架构概览](architecture/overview.md)
- [术语表](architecture/glossary.md)
- [待决策问题](architecture/open-decisions.md)
- [跨机协同开发预览工作流](architecture/dev-workflow.md)
- [内容与产品路线](product/content-roadmap.md)
- [契约词表](contracts/contract-terms.json)
- [契约扫描规则](contracts/contract-rules.json)

## 当前阶段

- 阶段：M0 网站规范与首版静态入口。
- 范围：个人项目技术分享、项目展示、后续产品服务演进规划。
- 非目标：登录、评论、订阅、收费、用户数据采集、复杂 CMS、动态后端。

## 文档维护要求

- 新增 `docs/` 下的 Markdown 文件后，必须在本文件索引。
- 修改路由、导航、内容栏目、产品服务或部署方式时，同步更新相关设计文档。
- 不确定事项写入 [待决策问题](architecture/open-decisions.md)，不要散落在代码注释里。


# AxialMuseWebsite 文档入口

本文档目录是项目定位、架构、内容模型、产品服务演进和质量门禁的真相源。涉及公开页面结构、内容栏目、产品服务、用户数据、部署和 CI 的改动，先更新这里对应文档，再进入实现。

## 文档索引

- [项目进度](progress.md)
- [架构概览](architecture/overview.md)
- [历史 M0 技术选型决策（已被替代）](architecture/technology-selection.md)
- [主站目标架构](architecture/main-site-target-architecture.md)
- [项目体验子域名架构](architecture/project-experience-hosting.md)
- [术语表](architecture/glossary.md)
- [待决策问题](architecture/open-decisions.md)
- [跨机协同开发预览工作流](architecture/dev-workflow.md)
- [主站编码规范 Spec](engineering/main-site-coding-spec.md)
- [主站体验与内容架构](product/site-experience.md)
- [M0 主站实现 Spec](product/m0-main-site-spec.md)
- [内容与产品路线](product/content-roadmap.md)
- [DocRestore 项目展示与未来体验设计](projects/docrestore-experience.md)
- [VibeCoding Project Scaffold 项目展示设计](projects/vibecoding-project-scaffold.md)
- [域名与生产发布设计](operations/domain-deployment.md)
- [内容发布流程](operations/content-publishing.md)
- [自动化维护与运行手册](operations/maintenance.md)
- [生产环境清单](operations/production-inventory.md)
- [契约词表](contracts/contract-terms.json)
- [主站项目目录](contracts/projects.json)
- [作者注册表](contracts/authors.json)
- [主题注册表](contracts/topics.json)
- [永久重定向注册表](contracts/redirects.json)
- [项目体验注册表](contracts/project-experiences.json)
- [契约扫描规则](contracts/contract-rules.json)
- [站点检查规则](contracts/site-checks.json)

## 当前阶段

- 阶段：Docusaurus 静态主站的上层方向和 M0 页面基线已经固定。D-059 至 D-077 约束内容身份、单一 docs 拓扑、Node 24、严格 TypeScript、依赖候选与供应链准入；D-078 授权 Agent 收口 M0 内部工程细节，E-001 至 E-005 已进一步固定项目结构化事实与长文职责拆分、尾斜杠与路由冲突、作者/主题/模块注册表、classic/Infima 最小主题适配，以及 GitHub Actions `build/` artifact 到 TAT 的发布边界。下一步先完成 D-077 的首次联网依赖解析与人工准入，再按[主站编码规范 Spec](engineering/main-site-coding-spec.md)实施；npm 下载、Git 发布、GitHub 凭证、服务器、DNS、证书和生产操作仍需各自授权。
- 范围：静态主站、Git 内容发布、项目展示与入口，以及未来中央账户、评论和独立项目服务的解耦边界。
- 当前非目标：部署登录、评论、订阅、收费、用户数据采集、CMS、站内搜索、动态后端或项目试用环境。

## 文档维护要求

- 新增 `docs/` 下的 Markdown 文件后，必须在本文件索引。
- 修改路由、导航、内容栏目、产品服务或部署方式时，同步更新相关设计文档。
- 不确定事项写入 [待决策问题](architecture/open-decisions.md)，不要散落在代码注释里。

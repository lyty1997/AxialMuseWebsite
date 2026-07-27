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
- [始终公开静态素材注册表](contracts/static-public-assets.json)
- [契约扫描规则](contracts/contract-rules.json)
- [站点检查规则](contracts/site-checks.json)
- [依赖准入策略](contracts/dependency-policy.json)
- [依赖补充法律证据](contracts/dependency-license-evidence.json)
- [精确依赖准入记录](contracts/dependency-admissions.json)

## 当前阶段

- 阶段：Docusaurus 静态主站的上层方向和 M0 多页面基线已经固定。D-059 至 D-080 与 E-001 至 E-016 已约束内容身份、单一 docs 拓扑、Node 24、严格 TypeScript、依赖与供应链、静态构建、完整 Git 历史、同版本服务端 301、production artifact 字节闭包、单一内容装配和作者 Linux 运行时。#9、#10、#21、#22、#11、#23、#5、#6、#7 已分别完成隔离 npm、SPDX/真实依赖图、站点与 TypeScript 基线、测试 runner、内容领域、真实项目正文、媒体和发布态素材门禁的既定闭环；#26 的唯一 docs 实例、真实内容扫描、frontmatter 投影、侧栏、私有日期索引和 production 构建闭环已由提交 `91dd3c7` 进入本分支精确基点并完成远端闭环。本专题分支不包含该基点之后的 #27/#28 实现。
- CI 状态：D-097 至 D-099 已形成第一阶段可信 CI，并依 D-100 的精确基点与本地提交授权纳入专题分支：四个失败关闭 job、三个官方 Action 固定 SHA、Node `24.18.0`/`24.16.0` 双端点、完整 checkout、E-010 隔离安装、独立 `quality`/`typecheck`/`test`/`build`、E-013 历史门禁与静态供应链证据。D-098 已消除私有构建绝对路径进入公开 JavaScript 的问题，D-099 又从普通 push/PR CI 移除 live npm audit；既有 18 个 high 依赖节点仍由 Dependabot Alerts 与人工依赖维护跟踪，不再决定普通 CI 结论，也不表示风险已修复或接受。D-101 只授权把该专题分支非强制推送到 `origin` 同名临时 ref；现有 push 触发器只包含 `main`/`dev`，因此临时 ref 交付本身不产生该提交的远端 run。`main` required checks、immutable production artifact、GitHub `production` environment/审批、TAT/Nginx/DNS/TLS 和定时检查均未完成。现有 CI Action 已准入；依赖变更仍须完成 D-077 的失败关闭审计和正式准入，后续 artifact/upload/deploy 所需 Action、凭证和生产操作也须分别决策与授权。
- 范围：静态主站、Git 内容发布、项目展示与入口，以及未来中央账户、评论和独立项目服务的解耦边界。
- 当前非目标：部署登录、评论、订阅、收费、用户数据采集、CMS、站内搜索、动态后端或项目试用环境。

## 文档维护要求

- 新增 `docs/` 下的 Markdown 文件后，必须在本文件索引。
- 修改路由、导航、内容栏目、产品服务或部署方式时，同步更新相关设计文档。
- 不确定事项写入 [待决策问题](architecture/open-decisions.md)，不要散落在代码注释里。

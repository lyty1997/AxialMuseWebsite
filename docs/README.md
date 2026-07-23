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

- 阶段：Docusaurus 静态主站的上层方向和 M0 多页面基线已经固定。D-059 至 D-077 约束内容身份、单一 docs 拓扑、Node 24、严格 TypeScript、依赖候选与供应链准入；D-078 授权 Agent 收口不改变既定边界的 M0 内部工程细节，D-079 增加 Node 24 测试类型直接候选，D-080 已落地不改变系统默认 Node 的 Linux 作者 nvm/Node 24 与 pre-commit 自动选择边界，E-001 至 E-016 已固定项目内容职责、URL、注册表、主题适配、静态制品交付、主预览 schema、发布态素材白名单、可验收草稿预览、npm 启动前隔离、确定性 SPDX、Node ESM TypeScript 测试、统一结构化 frontmatter 解码、HEAD 可达完整 Git 历史、与静态 payload 同版本激活的服务端 301、production artifact 自包含重建与字节闭包，以及单一内容装配和零公开文档适配。2026-07-19 已建立 [M0 Roadmap #15](https://github.com/lyty1997/AxialMuseWebsite/issues/15) 及 #16 至 #20 阶段父任务；#4 按设计一致性职责验收完成并关闭，#5 至 #14 保留原编号并改为实现期单一不变量任务，#21 至 #43 补齐其余实现、内容、发布、上线和维护任务。#9、#10、#21 已收口隔离 npm、确定性 SPDX 与真实依赖图供应链准入；#22 已由提交 `7cb529c1a68bd1979d8a9b9b6ba8731dc2fe49100` 收口站点/严格 TypeScript scaffold，精确 push CI run `29907159529` 成功后关闭；#11 已由提交 `ca10de5318543b89dd829db24ed2a646c6535a12` 收口 E-012 Node ESM TypeScript 测试入口，精确 push CI run `29913247834` 成功后关闭；#23 已由提交 `49a97bf55e69119b31b03e309fe117c04b767f31` 收口纯内容解码、schema、路径分类和整批领域校验，精确 push CI run `29925256721` 成功后关闭；#5 已由提交 `d4a92ad9b6a024fdf42f5cd35efec5847a15fadb` 收口两份唯一项目正文，精确 push CI run `29931912784` 成功后关闭；#6 已由提交 `8d926ea43e92b4cd49e4a1d541f52105075acf1a` 收口项目主预览 schema 与媒体门禁，精确 push CI run `29939606613` 成功后关闭；#7 已由提交 `7f2115d9f1dc5396ca0c81fc9960223644d79725` 收口 production/preview 临时素材白名单与生产泄漏判定，精确 push CI run `29950131762` 成功并完成[逐条验收回填](https://github.com/lyty1997/AxialMuseWebsite/issues/7#issuecomment-5050422648)后关闭。当前 #26 已在本地实现并继续验收唯一 docs 实例、真实内容扫描、frontmatter 投影、侧栏、私有日期索引，以及候选构建、fresh checker、可回滚切换和最终路径复验的 production 构建闭环；current-only 选项固定为 `includeCurrentVersion: true`、`onlyIncludeVersions: ["current"]`、`tags: false`，不得使用 `disableVersioning: true`。#26 尚未形成远端提交、CI 或 Issue 关闭结论。按 D-091，#26 远端闭环并语义压缩后、#27 启动前提醒切换到 Codex Desktop。目标 GitHub Action/凭证、服务器、DNS、证书和生产操作仍需各自授权。
- 范围：静态主站、Git 内容发布、项目展示与入口，以及未来中央账户、评论和独立项目服务的解耦边界。
- 当前非目标：部署登录、评论、订阅、收费、用户数据采集、CMS、站内搜索、动态后端或项目试用环境。

## 文档维护要求

- 新增 `docs/` 下的 Markdown 文件后，必须在本文件索引。
- 修改路由、导航、内容栏目、产品服务或部署方式时，同步更新相关设计文档。
- 不确定事项写入 [待决策问题](architecture/open-decisions.md)，不要散落在代码注释里。

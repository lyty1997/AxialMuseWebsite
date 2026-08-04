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

- 阶段：Docusaurus 静态主站的上层方向和 M0 多页面基线已经固定。#9、#10、#21、#22、#11、#23、#5、#6、#7、#26、#27 与 #28 已完成各自远端闭环；#25 已合入既有主干，#8 的 preview 候选、草稿/noindex/sitemap 制品门禁、冻结依赖证据与原子 current 切换已进入 `origin/dev`，但仍缺托管机配置、失败注入和真实局域网浏览器验收。当前 `dev` 本地合并候选正在汇合 #12/#24/#32 与 #13/#33/#35/#14/#34 的历史、作者、CI、301、release、服务器 verifier、producer/upload 和受限 dispatch 仓库能力；组合树精确远端 CI 与各 Issue 证据尚未取得。#36 已完成服务器盘点、SSH、OS UFW、软件事务、一次维护重启及 D-130 unit-aware v2 正式只读验收；D-135 receipt 为 `accepted-with-residuals` 且全部当前逐组件 gates 为真、`serverMutationPerformed=false`，D-125、D-129 与 D-132 历史不改写。#36 现在只剩 canonical `main` 前置满足后的 verifier 现场安装，#37 继续暂停。当前两个项目仍为 `planned`，技术文章为零，production 只能输出可信空状态。
- CI 状态：D-097 至 D-102 已形成固定 Action SHA、Node `24.18.0`/`24.16.0` 双端点、完整 checkout、E-010 隔离安装、零依赖 `quality`、安装后 E-013 历史门禁、独立 `typecheck`/`test`/`build` 与静态供应链证据；既有 18 个 high 依赖节点仍按未修复风险跟踪。#14 的 `production-artifact` 只允许 canonical `main` push 并单次上传，#34 仍只是在活动 workflow 外的受限 dispatch 候选，当前没有 `deploy-production`。D-136 第一阶段已获授权；D-137 修正七个未推送提交的邮箱身份后，topic 已以 `e88386b` 普通推送。保留 #8 与 #18 两侧语义的 `dev` 本地合并候选已经通过完整主 Node 门禁；`dev` push CI、`dev -> main` PR checks、合并后的 `main` CI、真实 artifact ID/digest/ZIP 与 `main` required checks 均尚未取得，不得预写成功。
- 范围：静态主站、Git 内容发布、项目展示与入口，以及未来中央账户、评论和独立项目服务的解耦边界。
- 当前非目标：部署登录、评论、订阅、收费、用户数据采集、CMS、站内搜索、动态后端或项目试用环境。

## 文档维护要求

- 新增 `docs/` 下的 Markdown 文件后，必须在本文件索引。
- 修改路由、导航、内容栏目、产品服务或部署方式时，同步更新相关设计文档。
- 不确定事项写入 [待决策问题](architecture/open-decisions.md)，不要散落在代码注释里。

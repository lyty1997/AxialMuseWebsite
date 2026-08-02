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

- 阶段：Docusaurus 静态主站的上层方向和 M0 多页面基线已经固定。#9、#10、#21、#22、#11、#23、#5、#6、#7、#26、#27 与 #28 已完成各自远端闭环；#12、#24 与 #32 已完成专题实现和本地验收，仍依 D-104 等待组合树远端验收。#13 已完成仓库侧 301 与固定镜像真实 Nginx 验收；#33 已推送确定性 release 封装，#35、#14 与 #34 已分别形成本地 verifier、producer/upload 和受限 dispatch 实现，但 canonical `main` 真实 artifact、活动 TAT 与对应 Issue 证据仍待。#36 已完成服务器盘点、旧站清理、控制面基础核验、额外身份可逆禁用、SSH 全局策略、OS UFW 重启前稳态和精确软件事务；D-125 历史回执仍为 `environmental_inconclusive`。D-126 唯一一次只读语义变换探针随后以 `status=complete oracleMatch=true` 证明：现场 current normalized non-vendor 命中冻结 current 基线，固定加入两条公开标准 IPv6 rate-limit 终止规则后命中冻结 oracle。该授权已消费，服务器没有文件、防火墙、reload、重启或再基线写操作；结果关闭当前内容关系缺口，但不证明 initial-enable 的历史因果，也不授权 component-aware transition。#36 下一步须由用户明确接受剩余历史不确定性并单独授权 transition，或选择保持现状；云层单来源收敛、维护重启及后验、verifier 安装和 #37 仍暂停。当前两个项目仍为 `planned`，技术文章为零，production 只能输出可信空状态。
- CI 状态：D-097 至 D-102 已形成第一阶段可信 CI 的专题实现，包括固定 Action SHA、Node `24.18.0`/`24.16.0` 双端点、完整 checkout、隔离安装、零依赖 `quality`、安装后历史门禁及独立 `typecheck`/`test`/`build`。既有 18 个 high 依赖节点仍按未修复风险跟踪。#33 提供 release 字节闭包，#35 保持在 Node-only `quality` 之外；#14 已在本地接入只允许 canonical `main` push 的 `production-artifact` 和单次精确上传，#34 已在活动 workflow 外形成 main 新鲜度、无 Secret 预检与固定 TAT dispatch 候选。Actions 额度已恢复，但 topic 分支不触发 workflow 且按 D-123 暂不开 PR，因此真实 producer run、artifact ID/digest/ZIP 与 `main` required checks 尚未取得。#34 活动接线、#36 的 transition 决策、云层单来源收敛、维护重启后验与 verifier 安装，以及 #37 的 TAT/服务器/Nginx/DNS/TLS 仍未完成。
- 范围：静态主站、Git 内容发布、项目展示与入口，以及未来中央账户、评论和独立项目服务的解耦边界。
- 当前非目标：部署登录、评论、订阅、收费、用户数据采集、CMS、站内搜索、动态后端或项目试用环境。

## 文档维护要求

- 新增 `docs/` 下的 Markdown 文件后，必须在本文件索引。
- 修改路由、导航、内容栏目、产品服务或部署方式时，同步更新相关设计文档。
- 不确定事项写入 [待决策问题](architecture/open-decisions.md)，不要散落在代码注释里。

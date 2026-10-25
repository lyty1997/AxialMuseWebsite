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
- [生产调度接线清单](operations/production-deploy-setup.md)
- [公网 HTTPS 候选与验收清单](operations/public-https-setup.md)
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

- 最新上线核查（D-165 / 2026-10-25）：#37 仅本机发布已完成；根域和 `www` 的现有 A/NS 已复核并匹配服务器。#38 的 DNSSEC 尚待，所有者确认免费套餐无此能力；已授权准备 #39 公网 HTTPS 候选及本地验收，正式上线、DNSSEC 与 Git 发布继续按独立清单审查。以下历史条目的“DNS 未实施”不代表当前 A 记录缺席。

2026-10-25：#34 与 #37 已完成独立现场验收；#37 的实现经 PR #69 进入 `main@27d461b`，六模块与四命令已认证安装，两次 TAT、四次本机激活/兼容切换全部按授权完成，最终 current 停在同一 main。账本、真实 HTTP 与仅本机监听已复核，[关闭证据](https://github.com/lyty1997/AxialMuseWebsite/issues/37#issuecomment-6391457633)已回填。公网监听、DNS/DNSSEC 与正式 TLS 留给 #38；不能据此宣称网站已经公网可用。详见[生产调度接线清单](operations/production-deploy-setup.md)。本轮收尾文档尚在独立工作树，未追加会触发第三笔 TAT 的 main push。

### 2026-10-24 历史阶段快照

以下保留 #37 本机激活前的历史记录；其中尚未完成事项以本节上方最新状态为准。

- 阶段：Docusaurus 静态主站的上层方向和 M0 多页面基线已经固定。#9、#10、#21、#22、#11、#23、#5、#6、#7、#26、#27 与 #28 已完成各自远端闭环；#12、#13、#32、#33、#35 与 #14 已在 canonical `main` 的成功 CI 及真实 artifact 独立复验中完成制品链专题验收；#24 作者工具仍待单独闭环。#34 已在 PR #67/#68、main@441b214 的成功 CI 与独立 TAT 任务/制品后验中完成受限调度验收并关闭；服务器按约定停在 DEPLOY_ACTIVATION_PENDING，站点尚未激活。#36 已完成服务器盘点、旧站清理、控制面基础核验、额外身份可逆禁用、SSH 全局策略、OS UFW 重启前稳态和精确软件事务；D-125 历史回执仍为 `environmental_inconclusive`，不因后续动作改写。D-126 以 `status=complete oracleMatch=true` 关闭当前内容关系缺口后，用户在 D-128 接受剩余历史因果不确定性，并确认腾讯云当时只保留与 OS UFW 匹配的单一 SSH 来源；唯一正式 component-aware transition 返回 `status=complete outcome=committed`，一次性授权已消费且事务清理完成。D-129 的唯一维护重启已经执行，SSH unavailable→available 与 boot 改变已确认，但完整 post-reboot 因冻结 vendor declaration predicate 不满足而保持 `post-reboot-pending`；没有第二次重启、reload、再基线或恢复写入。用户随后在 D-130 确认主机侧未发现问题且当前腾讯云控制面正常。D-132 首轮 formal 失败后，D-133/D-134 完成 unit 归因和 unit-aware v2 修正；D-135 已通过两条 fresh 同 boot 的正式只读观测形成有效 v2 receipt，结果为 `accepted-with-residuals`，全部当前逐组件 gates 为真且 `serverMutationPerformed=false`，不改写 D-129/D-132 历史。#36 后续已完成首次安装；D-159 又从 CI 成功的 canonical `main@a5ad326` 认证五个 blob 并完成 verifier 原子升级及独立现场验收，旧组件与 receipt 保留。WireGuard 严格 SSH 管理通道正常。#37 的生产安装和发布仍未实施。当前两个项目仍为 `planned`，技术文章为零，production 只能输出可信空状态。
- CI 状态：D-097 至 D-102 已形成第一阶段可信 CI 的专题实现，包括固定 Action SHA、Node `24.18.0`/`24.16.0` 双端点、完整 checkout、隔离安装、零依赖 `quality`、安装后历史门禁及独立 `typecheck`/`test`/`build`。既有 18 个 high 依赖节点仍按未修复风险跟踪。#33 的 release 字节闭包和 #14 的 canonical `main` 单次 artifact 上传已经通过真实 ZIP 与独立重建逐文件比对；#35 的 Python verifier 仍保持在 Node-only `quality` 之外。#34 的 main 新鲜度、无 Secret 预检与固定 TAT dispatch 已活动接线；下载器有界等待修复已安装，run 40069951954 attempt 2 六个 job 成功，独立任务以预期 exit 2 停在激活前，18 文件与双摘要一致。Actions 额度已恢复；D-136 已确认以两阶段晋级取代 D-123 面向未来的单 PR 节奏，先让仓库前置进入 canonical `main`，再安装 verifier 并通过后续 evidence 晋级回填；第一阶段 topic -> `dev` -> `main` Git 晋级已获授权并按失败关闭门禁执行。topic 分支不触发 workflow；`main@2ed430a` 的 CI run `38908312695` 已 `completed/success`，五个 job 全部成功；artifact ID、外层 digest、原始 ZIP 和独立重建 release 已逐项验收。#36 已完成 verifier 现场升级及验收；#34 已完成接线与独立验收；#37 的账本、生产安装/激活、Nginx 和 DNS/TLS 仍未完成。D-135 已关闭 D-130 v2 receipt 门禁，D-159 的当前证据不改写此前历史结果。
- 范围：静态主站、Git 内容发布、项目展示与入口，以及未来中央账户、评论和独立项目服务的解耦边界。
- 当前非目标：部署登录、评论、订阅、收费、用户数据采集、CMS、站内搜索、动态后端或项目试用环境。

## 文档维护要求

- 新增 `docs/` 下的 Markdown 文件后，必须在本文件索引。
- 修改路由、导航、内容栏目、产品服务或部署方式时，同步更新相关设计文档。
- 不确定事项写入 [待决策问题](architecture/open-decisions.md)，不要散落在代码注释里。

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
- [AI 编码脚手架文章图表源](engineering/ai-coding-scaffold-diagrams.md)
- [主站体验与内容架构](product/site-experience.md)
- [M0 主站实现 Spec](product/m0-main-site-spec.md)
- [内容与产品路线](product/content-roadmap.md)
- [DocRestore 项目展示与未来体验设计](projects/docrestore-experience.md)
- [VibeCoding Project Scaffold 项目展示设计](projects/vibecoding-project-scaffold.md)
- [域名与生产发布设计](operations/domain-deployment.md)
- [生产调度接线清单](operations/production-deploy-setup.md)
- [公网 HTTPS 候选与验收清单](operations/public-https-setup.md)
- [免费加固与运行观察](operations/production-health.md)
- [内容发布流程](operations/content-publishing.md)
- [自动化维护与运行手册](operations/maintenance.md)
- [生产环境清单](operations/production-inventory.md)
- [契约词表](contracts/contract-terms.json)
- [内容历史同源导入记录](contracts/content-history-imports.json)
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

- 2026-11-14 / #41：生产只读接线及真实手动 daily 82 项、weekly 109 项、monthly 101 项均通过；月度首次失败已追到测试夹具依赖 umask 的根因，经 PR #86 窄化修复并完成 `main@a99e9b7` 实际部署后复验。用户确认收到指定自然失败运行的通知；Issue 已按证据勾选，接线后自然定时成功仍待验收。详见[进度记录](progress.md)。以下为历史阶段快照。

- 2026-11-13 / #41：用户确认取消外链检查；每周保留本站页面与资源、站内链接、robots/sitemap、DNS 及服务器证据。新范围真实每周 109 项通过；每日、每周、每月自动接线候选的 125 项回归和完整隔离 quality 通过。GitHub 维护环境已建立并限定 main，监测策略与核验到期记录已配置；用户要求全部改动 review 通过后才开始定时任务。腾讯云身份、服务器入口、review、实际定时和通知仍须完成与验收；实现尚未提交或部署。见[进度记录](progress.md)及[范围决定](architecture/open-decisions.md#2026-11-13--41-排除外链检查)。以下为历史阶段快照。

- 2026-11-11 / #41：继续完成本地监测候选：服务器随机量/时效与前后快照绑定，每周 DNS/站内及外链检查，月度内容日期/私有到期报告和固定质量命令组合。85 项 Python 监测、十项无依赖月度 fixture 与一项冻结解析器集成通过，完整隔离 quality 通过。只读实测本站 36 个文件及 DNS 符合基线，外链实测保留超时/HTTP 521 的失败回执；#41 仍开放，认证通道、GitHub schedule、真实通知和供应商到期记录未完成。接口与边界见[维护契约](operations/maintenance.md#41-周期组合接口)和[本地进度](progress.md)。

- 2026-11-11 / #40：按用户要求回填并逐字核对[验收证据](https://github.com/lyty1997/AxialMuseWebsite/issues/40#issuecomment-6787165536)，Issue 已以 `completed` 关闭并独立复查。#41 与 #42 的 #40 前置已解除；定时检查/通知和服务器维护仍分别按各自范围验收。以下 2026-11-10 记录为回填前的历史快照。

- 2026-11-10 / #40：明确技术验收通过。既有同版本观察已独立复算，290 次采样覆盖 72 小时 16 秒、零失败/空档；精确 main CI/artifact/deployment、服务器事务/账本与当前身份一致，80 项公网及六页四视口 24 项浏览器检查通过。直连和既有代理路径已复验；多网络 smoke 是建议入口，独立出口身份核验不是额外前置。GitHub 证据尚未回填，详见[终点独立复核](operations/production-health.md#2026-11-10-终点独立复核)。本轮只更新本地验收记录，无 Git 发布或生产配置变更。

- 2026-11-05 / #61：用户确认修订方案 A，本地候选将 CI 从六个声明 job 收敛到四个：dev 仅主 Node 完整集成，PR 双端点及图表，main 图表与最低 Node 前置通过后由 fresh producer 完整重验。主/最低 Node、图表和静态供应链门禁按职责保留，现有部署步骤不变。仓库已为 public，不把 runner 时间变化当作付费额度节省；本轮不提交、推送、触发远端或修改分支保护。设计与本地验收见 [#61 决定](architecture/open-decisions.md#2026-11-05--61-修订方案-a本地实施授权)和[最新进度](progress.md)。

  复审补齐下载器的新旧拓扑兼容候选；新 CI 进入 main 前必须先在旧拓扑下交付、认证安装兼容下载器并独立验证真实下载。2026-11-12 已核实兼容补丁进入 main、认证安装并完成真实下载及独立后验，详见[升级记录](operations/production-deploy-setup.md#2026-11-05--61-下载器兼容升级前置)。四 job workflow 仍待独立晋级和实际 CI 验收。

- 2026-10-31 两阶段公网晋级：用户已授权先修服务器兼容性，再发布已验收 dev 候选。[PR #75](https://github.com/lyty1997/AxialMuseWebsite/pull/75) 已进入 `main@d09f2b5`，六 job/独立制品/TAT 成功，唯一公网模块认证安装和公网 43 项复验通过。当前专题是第二阶段新界面候选，沿用既定生产内容门禁；原 dev 工作区保留。总预算及前置证据见[最新进度](progress.md)，此前“未安装/待授权”均按其历史时间理解，第二阶段完成须以精确 main CI、服务器和公网回执独立确认。

- 2026-10-31 本地集成：按用户要求将 `origin/main@489562e` 合入当前 `dev@e9c06da`，保留两侧历史。整合 main 的生产部署、验证器、命名空间与 CI 门禁，同时保留 dev 的 preview、品牌、搜索、草稿文章和项目叙事；品牌决策按既定映射采用 D-173 至 D-184。当前是本地合并验收阶段，旧未提交 review 修复仍独立保留；本轮没有 push、远端 CI 或部署。以下条目为此前各专题快照，现场状态未在本轮重新核查。

- 2026-10-28 文档复审修正：登记未晋级 dev 的品牌记录编号映射，保留 main/运维原编号；发布说明区分 dev push CI 与 topic PR 检查，配套规则和图同步。历史本机观察已结束，98 个样本原始回执通过，但跨越发布，不能认定当前版本独立通过 24 小时验收；未重开观察。详见[编号协调](architecture/open-decisions.md#未晋级-dev-记录的编号协调)、[晋级流程](architecture/dev-workflow.md#从开发预览晋级到生产)及[观察边界](operations/production-health.md#本轮只读观察)。dev 的九文件引用替换与其他开发仍在隔离候选，本 PR 不晋级其页面、品牌、文章、测试或监测运行代码。

- 2026-10-27 复审修复：发布模块、TAT 解析器和续期 hook 导入根改到独立命名空间，避免阻断 verifier 的闭合成员检查；组合升级、真实自测、幂等复验及旧布局拒绝均已通过。用户已授权在独立专题分支提交并直接向 main 提 PR；尚未合并或生产安装，现有服务器布局不因本条改变。范围与验收见[最新进度](progress.md)。

- D-169 / 2026-10-26：300 秒 HSTS 候选已实现；兼容原关闭/半年模式，严格拒绝未批准期限。默认 Python ops 212 项（209 通过、三个 opt-in 跳过），其中两个真实 Nginx/TLS 场景另行启用通过，完整 quality、Ruff 与原配置逐字节兼容证明通过。生产仍关闭 HSTS；[16 文件候选的晋级/安装清单](operations/production-health.md)单独等待授权，不自动消耗 Git/TAT/reload 额度。

- D-168 / 2026-10-26：用户确认 DNSSEC 暂缓，保留免费 DNS/HTTPS，#38 改按现有 DNS 只读验收收尾；完整 zone 导出保留为未来写入前要求。免费加固与运行监测先推进，具体生产配置、DNS 和 Git/schedule 写入仍待候选审查，见[免费加固与运行观察](operations/production-health.md)。#40 的真实 24 小时观察和 #41/#42 的定时接线不因一次公网成功而完成。以下旧条目的 DNSSEC 强制前置以 D-168 为准。

- 最新上线核查（D-166/D-167 / 2026-10-25）：[PR #70](https://github.com/lyty1997/AxialMuseWebsite/pull/70) 已合并为 `main@2cf04ee`，六项 CI 和唯一新增 TAT 独立成功。`https://www.axialmuse.com/` 的真实证书、14 个文件公网哈希、四主机路由、浏览器及一次正式续期 dry-run 均验收通过；current/账本、六个事务与七次 reload 独立复核一致。已按授权上线可信空状态，无浏览器第三方请求或用户数据采集。详细回执见[公网 HTTPS 验收清单](operations/public-https-setup.md)。#38 的 DNSSEC、HSTS 和 #40 持续健康核查留待独立推进；本次收尾文档只留本地，避免追加 main push/TAT。以下历史条目的“DNS/TLS 未实施”以本条当前证据为准。

2026-10-25：#34 与 #37 已完成独立现场验收；#37 的实现经 PR #69 进入 `main@27d461b`，六模块与四命令已认证安装，两次 TAT、四次本机激活/兼容切换全部按授权完成，最终 current 停在同一 main。账本、真实 HTTP 与仅本机监听已复核，[关闭证据](https://github.com/lyty1997/AxialMuseWebsite/issues/37#issuecomment-6391457633)已回填。公网监听、DNS/DNSSEC 与正式 TLS 留给 #38；不能据此宣称网站已经公网可用。详见[生产调度接线清单](operations/production-deploy-setup.md)。本轮收尾文档尚在独立工作树，未追加会触发第三笔 TAT 的 main push。

### 2026-10-24 历史阶段快照

以下保留 #37 本机激活前的历史记录；其中尚未完成事项以本节上方最新状态为准。

- 阶段：Docusaurus 静态主站的上层方向和 M0 多页面基线已经固定。#9、#10、#21、#22、#11、#23、#5、#6、#7、#26、#27 与 #28 已完成各自远端闭环；#12、#13、#32、#33、#35 与 #14 已在 canonical `main` 的成功 CI 及真实 artifact 独立复验中完成制品链专题验收；#24 作者工具仍待单独闭环。#34 已在 PR #67/#68、main@441b214 的成功 CI 与独立 TAT 任务/制品后验中完成受限调度验收并关闭；服务器按约定停在 DEPLOY_ACTIVATION_PENDING，站点尚未激活。#36 已完成服务器盘点、旧站清理、控制面基础核验、额外身份可逆禁用、SSH 全局策略、OS UFW 重启前稳态和精确软件事务；D-125 历史回执仍为 `environmental_inconclusive`，不因后续动作改写。D-126 以 `status=complete oracleMatch=true` 关闭当前内容关系缺口后，用户在 D-128 接受剩余历史因果不确定性，并确认腾讯云当时只保留与 OS UFW 匹配的单一 SSH 来源；唯一正式 component-aware transition 返回 `status=complete outcome=committed`，一次性授权已消费且事务清理完成。D-129 的唯一维护重启已经执行，SSH unavailable→available 与 boot 改变已确认，但完整 post-reboot 因冻结 vendor declaration predicate 不满足而保持 `post-reboot-pending`；没有第二次重启、reload、再基线或恢复写入。用户随后在 D-130 确认主机侧未发现问题且当前腾讯云控制面正常。D-132 首轮 formal 失败后，D-133/D-134 完成 unit 归因和 unit-aware v2 修正；D-135 已通过两条 fresh 同 boot 的正式只读观测形成有效 v2 receipt，结果为 `accepted-with-residuals`，全部当前逐组件 gates 为真且 `serverMutationPerformed=false`，不改写 D-129/D-132 历史。#36 后续已完成首次安装；D-159 又从 CI 成功的 canonical `main@a5ad326` 认证五个 blob 并完成 verifier 原子升级及独立现场验收，旧组件与 receipt 保留。WireGuard 严格 SSH 管理通道正常。#37 的生产安装和发布仍未实施。当前两个项目仍为 `planned`，技术文章为零，production 只能输出可信空状态。
- CI 状态：D-097 至 D-102 已形成第一阶段可信 CI 的专题实现，包括固定 Action SHA、Node `24.18.0`/`24.16.0` 双端点、完整 checkout、隔离安装、零依赖 `quality`、安装后历史门禁及独立 `typecheck`/`test`/`build`。既有 18 个 high 依赖节点仍按未修复风险跟踪。#33 的 release 字节闭包和 #14 的 canonical `main` 单次 artifact 上传已经通过真实 ZIP 与独立重建逐文件比对；#35 的 Python verifier 仍保持在 Node-only `quality` 之外。#34 的 main 新鲜度、无 Secret 预检与固定 TAT dispatch 已活动接线；下载器有界等待修复已安装，run 40069951954 attempt 2 六个 job 成功，独立任务以预期 exit 2 停在激活前，18 文件与双摘要一致。Actions 额度已恢复；D-136 已确认以两阶段晋级取代 D-123 面向未来的单 PR 节奏，先让仓库前置进入 canonical `main`，再安装 verifier 并通过后续 evidence 晋级回填；第一阶段 topic -> `dev` -> `main` Git 晋级已获授权并按失败关闭门禁执行。topic 分支不触发 workflow；`main@2ed430a` 的 CI run `38908312695` 已 `completed/success`，五个 job 全部成功；artifact ID、外层 digest、原始 ZIP 和独立重建 release 已逐项验收。#36 已完成 verifier 现场升级及验收；#34 已完成接线与独立验收；#37 的账本、生产安装/激活、Nginx 和 DNS/TLS 仍未完成。D-135 已关闭 D-130 v2 receipt 门禁，D-159 的当前证据不改写此前历史结果。
- 范围：静态主站、Git 内容发布、项目展示与入口，以及未来中央账户、评论和独立项目服务的解耦边界。
- 当前非目标：部署登录、评论、订阅、收费、用户数据采集、CMS、独立/第三方搜索服务、动态后端或项目试用环境。D-173 的页头搜索仅在浏览器内匹配同批公开安全展示投影。

## 文档维护要求

- 新增 `docs/` 下的 Markdown 文件后，必须在本文件索引。
- 修改路由、导航、内容栏目、产品服务或部署方式时，同步更新相关设计文档。
- 不确定事项写入 [待决策问题](architecture/open-decisions.md)，不要散落在代码注释里。

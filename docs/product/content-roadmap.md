# 内容与产品路线

状态：active
最近更新：2026-07-19

## M0：个人技术分享入口

技术文章发布状态为 `draft`、`published`、`archived`。`planned` 只表示路线或选题记录，不是文章状态；项目与项目体验继续使用各自独立的状态模型。

目标：

- 展示 Axial Muse 的项目定位。
- 记录个人项目、工程规范和技术取舍。
- 建立可执行的质量门禁，避免文档和页面漂移。
- 完成域名、自动发布、HTTPS、回滚和例行维护闭环。
- 为已具备体验能力的项目建立独立子域名入口和发布隔离。

设计基线：

- [主站体验与内容架构](site-experience.md)
- [主站目标架构](../architecture/main-site-target-architecture.md)
- [M0 主站实现 Spec](m0-main-site-spec.md)
- [项目体验子域名架构](../architecture/project-experience-hosting.md)
- [域名与生产发布设计](../operations/domain-deployment.md)
- [内容发布流程](../operations/content-publishing.md)
- [自动化维护与运行手册](../operations/maintenance.md)

实施任务链由 [M0 Roadmap #15](https://github.com/lyty1997/AxialMuseWebsite/issues/15) 统一汇总，并使用 GitHub 原生 sub-issues 表达阶段与子任务层级。Issue 只跟踪执行状态、依赖和验收证据，不替代上述设计真相源；外部操作仍按各子任务的授权门禁单独确认。

交付阶段：

| 阶段 | 主要工作 | 完成门槛 | GitHub 跟踪 |
|---|---|---|---|
| M0-D 设计评审 | 对齐定位、技术选型、系统架构、主站 Spec、编码 Spec 和生产边界 | #5 至 #14 对应的阻塞实施设计问题均有单一结论，活动真相源无冲突 | [#4（已完成）](https://github.com/lyty1997/AxialMuseWebsite/issues/4) |
| M0-C 内容准备 | 形成 2 个可信项目条目、真实视觉证据和技术分享空状态 | 来源、状态、图片和隐私审核通过；完整文章不阻塞主站上线 | [#17](https://github.com/lyty1997/AxialMuseWebsite/issues/17) |
| M0-I 主站实现 | 按已评审 Spec 实现首页、项目目录与详情、技术分享目录与详情、基础 SEO 和契约门禁 | 质量门禁和桌面/平板/移动渲染通过 | [#16](https://github.com/lyty1997/AxialMuseWebsite/issues/16) |
| M0-P 生产准备 | 加固腾讯云轻量服务器，配置 Nginx、TAT 自动发布和生产清单 | IP/hosts 受控测试、payload/301 同版本发布、逐规则冒烟、只追加 URL 暴露账本、历史 source/target 收敛与 fallback/forward-only 恢复验证通过 | [#18](https://github.com/lyty1997/AxialMuseWebsite/issues/18) |
| M0-L 域名上线 | 配置 DNSPod、HTTPS、DNSSEC、备案页脚和搜索引擎抓取基础 | 上线验收全部通过并观察 24 小时 | [#19](https://github.com/lyty1997/AxialMuseWebsite/issues/19) |
| M0-S 项目展示 | 登记公开仓库与真实视觉证据；视频作为可选增强，不阻塞首版 | 项目说明、源码链接和图片通过事实、隐私、版权及桌面/移动检查 | [#17](https://github.com/lyty1997/AxialMuseWebsite/issues/17) |
| M0-O 运行维护 | 增加定时冒烟、链接、TLS 和 DNS 检查 | 告警路径与恢复演练通过 | [#20](https://github.com/lyty1997/AxialMuseWebsite/issues/20) |

首批内容方向：

- DocRestore：文档照片到 Markdown 的分阶段还原流水线，以及为何首版只展示源码、不开放在线处理。
- VibeCoding Project Scaffold：如何把设计文档、Agent 规则、质量门禁、CI 和 Git hooks 变成新项目的可执行基线。
- 从空仓库开始建立可执行的工程规范。
- 个人项目如何从技术记录演进到产品服务。
- 技术文章中如何区分事实、计划和待确认事项。

M0 退出条件：

- 生产内容与 `main` 一致，发布与回滚可追溯。
- 正式域名、HTTPS、DNSSEC、canonical、`robots.txt` 和 `sitemap.xml` 验证通过。
- ICP 备案、腾讯云接入状态和公开页脚信息核验通过，公安联网备案进入按期处理流程。
- 只有明确批准且状态为 `live` 的项目才配置体验 DNS、Nginx、证书和主站入口；没有在线体验不阻塞主站首版上线。
- DocRestore 首版展示公开仓库，演示视频准备完成后再追加；不创建 `docrestore` 或 API 子域名记录。
- VibeCoding Project Scaffold 展示公开仓库与真实工程证据，不创建体验子域名，也不要求演示视频。
- 首版内容基线为 2 个可信项目条目和真实的技术分享空状态；完整技术文章作为上线后增量，不阻塞 M0。
- 每日、每周和每月维护任务有明确执行与失败通知路径。

## M1：内容扩充与可发现性复评

M0 已经提供项目、文章、模块和受控主题的内容模型，以及项目目录/详情、技术分享目录/详情和基础 SEO。M1 不再重复建设这些能力。

计划方向：

- 继续使用 M0 内容模型发布真实项目资料和技术文章，验证目录、侧栏与三栏阅读流程。
- 只有内容规模或访问者工作流出现可验证需求时，才分别评估搜索、筛选、系列、作者/主题页面、归档或 Feed；评估不等于批准路由、依赖或外部服务。
- 项目在线体验继续按独立项目服务和体验注册表演进，不并入主站静态构建。

进入条件：M0 多页面主站完成上线并积累真实内容。文章数量本身不自动授权新的页面、依赖、浏览器请求或动态服务。

## M2：产品服务与讨论入口

计划能力：

- 增加产品服务页面。
- 增加反馈、讨论或订阅入口。
- 补充隐私说明、服务边界和支持方式。

## 非目标

- 当前不引入登录、支付、评论、用户数据采集或复杂后端。
- 当前不宣称未上线产品能力。

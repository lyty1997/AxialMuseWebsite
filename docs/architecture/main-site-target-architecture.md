# 主站目标架构

状态：active
最近更新：2026-08-03
适用范围：主站内容构建、未来中央账户、评论服务和独立项目服务的职责边界

## 决策依据

本文记录 D-027 至 D-083、D-097 至 D-105 的已确认、替代与重新评审关系，并引用依 D-078 形成的 M0 工程决定：

- D-027：静态主站与动态服务分离；未来使用中央身份服务、独立评论服务和各项目独立服务。
- D-028：技术分享由 Git 管理，并通过静态站点生成器构建；当前不引入私有 CMS。
- D-029：曾选择 Astro 静态输出模式，现已被 D-051 替代；静态生产边界继续有效。
- D-030：普通文章默认使用 Markdown；只有确需文章专属组件时使用 MDX，且只能引用仓库内经过审核的组件。
- D-031：主站承载项目/文章目录与详情，未来项目试用才启用独立项目子域名。
- D-032：文章正文页和项目介绍页采用左侧目录、中间正文、右侧辅助区的经典三栏信息结构。
- D-033：三栏采用文档站式职责，顶部全站导航、左侧同类内容目录和右侧页面标题导航各自分工。
- D-034：三栏采用宽屏完整显示、中等宽度折叠左栏、窄屏折叠两个目录的渐进式响应策略。
- D-035：项目 slug 与文章路径尾段采用手工英文语义标识，发布后保持稳定，改名时永久重定向旧 URL；文章完整字段值形态已被 D-058 部分替代。
- D-036：技术文章采用完整编辑模型，覆盖完整的编辑、关联、SEO、推荐与公开修订能力。
- D-037：技术文章采用分组式 frontmatter，正文与元数据保持单文件，复杂可选元数据按职责嵌套分组。
- D-038：技术文章在 frontmatter 顶层显式保存 `slug`，并以它作为公开 URL 的唯一真相源；值与框架映射语义已被 D-058 部分替代。
- D-039：技术文章使用必填顶层字段 `publicationStatus` 表示发布可见性，不与项目生命周期状态混用。
- D-040：技术文章发布状态只包含 `draft`、`published`、`archived`；`planned` 独立保存在路线或选题记录中。
- D-041：技术文章使用必填 `authors` ID 列表引用 Git 管理的作者注册表，并与未来账户和编辑权限解耦。
- D-042：作者注册表采用单一 JSON 对象，以稳定作者 ID 为对象键。
- D-043：本站首个稳定作者 ID 为 `lyty1997`；个人作者、站点品牌、未来发布组织和未来中央账户相互独立。
- D-044：作者记录使用必填 `displayName` 公开署名，首个作者的初始显示名为 `lyty1997`，且显示名可独立更新。
- D-045：作者注册表首版只包含 `displayName` 与 `links.github`，当前作者的 GitHub 地址为已确认的公开主页。
- D-046：技术文章使用必填 `title` 与单一必填 `summary`；受控 SEO 描述覆盖通过回退和评审门禁防止摘要漂移。
- D-047：文章日期由发布辅助命令按 `Asia/Shanghai` 写入 frontmatter 并提交 Git；CI、构建与服务器不得动态注入。
- D-048：文章不设通用主分类，按“项目-模块-主题标签”组织；组织关系不进入文章 URL。
- D-049：文章只有一个规范目录归属；项目和模块各最多一个，主题为 1-5 个受控 ID，跨项目关系不造成侧栏重复。
- D-050：文章使用必填 `classification` 对象作为项目、模块和主题组织字段的唯一真相源，不在顶层或其他分组复制。
- D-051：静态站点生成器改选 Docusaurus，以复用用户已有的 React 工程栈；生产仍只提供静态构建产物。
- D-052：开源软件采用分层准入；许可证优先级只筛选候选，不替代具体依赖、数据流与运行边界的用户决策。
- D-053：固定首版工程技术基线和 CI/发布门禁能力类别，不把具体版本、依赖、工具、构建位置或可选服务补成已确认实现。
- D-054：项目介绍与技术文章使用单一 docs 内容实例和各自侧栏，首版不启用 blog 或第二个 docs 内容实例。
- D-055：领域内容模型保持唯一可编辑真相源，Docusaurus 等价字段只读直传、必要字段单向派生，不回写或持久化语义副本。
- D-056：曾确认技术文章通过 Docusaurus 官方 `markdown.parseFrontMatter` 调用仓库内纯投影函数；经 D-058 重新开放后，已由 D-059 以更小职责重新确认。
- D-057：曾确认相对未来 docs 内容根的 `writing/` 子树及其全局 frontmatter 分流规则；经 D-058 重新开放后，核心方案已由 D-060 独立重新确认。
- D-058：单一 docs 实例使用根 `routeBasePath`，技术文章直接保存并使用 Docusaurus 原生完整 `slug`，不再派生栏目路径。
- D-059：技术文章 `title` 与完整 `slug` 原生直用；构建内存只派生 `description <- summary` 与草稿状态，其他领域字段不强行映射到不等价的 Docusaurus 字段。
- D-060：相对未来 docs 内容根的 `writing/` 子树是唯一技术文章成员边界，独立于适配器、URL、分类、侧栏和排序。
- D-061：仓库根 `site-content/` 是单一 docs 实例的物理内容根，技术文章边界具体锚定为 `site-content/writing/`。
- D-062：每篇技术文章使用 `site-content/writing/<source-name>/` 独立源码目录，并以 `index.md` 或 `index.mdx` 之一作为唯一正文入口。
- D-063：`<source-name>` 使用作者手工确定、稳定可读且符合固定格式的语义源码名，并采用发布前受控改名、发布后仅限明确授权纠错迁移的规则。
- D-064：技术文章使用不可变 UUIDv7 `articleId` 作为领域身份，Docusaurus 内部采用默认 doc ID、源码相对文章链接和基于 `classification` 的官方侧栏生成器，未来日期索引只从文章显式日期构建期派生。
- D-065：新文章由作者显式运行仓库内 Node.js 创建命令建立，命令在创建唯一正文入口时一次性写入 UUIDv7 `articleId`；Git hook、CI、构建、发布与生产不得自动生成或修复。
- D-066：目标作者与构建工具链统一使用 Node 24 LTS 主版本且最低为 24.16.0，文章 ID 由原生 `node:crypto.randomUUIDv7()` 生成；接受其不保证严格递增的时钟语义，不引入 UUID npm 包。
- D-067：仓库根 `.nvmrc` 是唯一精确执行基线，初始值记录在决策日志；`engines.node` 保持 `>=24.16.0 <25` 兼容边界，Linux 作者环境和 Ubuntu CI/构建 job 分别验证精确基线或最低端点，patch 只通过受审 PR 升级。
- D-068 至 D-071：已撤销，仅在决策日志和进度记录中保留历史。
- D-072：本站作者命令、质量检查与 Docusaurus 构建只在 Linux 执行环境运行，CI 仅使用 Ubuntu；协同客户端边界见[开发预览工作流](dev-workflow.md)。
- D-073：首版固定 Docusaurus `3.10.2` 的 core/classic preset/Faster 同版本拓扑、v4 兼容行为，以及 npm、唯一 `package-lock.json` 与 `npm ci` 冻结安装方向；blog、搜索、分析和其他浏览器外部请求保持关闭。
- D-074：Docusaurus 管理的目标源码采用显式严格 TypeScript，`tsc --noEmit` 类型检查与 Docusaurus build 作为两个独立必需门禁；现有 `.mjs` 质量脚本和未来作者 CLI 不在本决定的迁移范围。
- D-075：采用 Docusaurus 标准入口目录与显式模块边界；跨层只通过按需建立的公共入口导入，框架入口使用默认导出，内部模块使用具名导出，首版不增加自定义路径别名。
- D-076：首轮 React/MDX/TypeScript 与类型工具使用 Docusaurus `3.10.2` 官方模板的候选直接依赖范围；目标 `tsconfig` 继承官方基线并显式收紧本站源码范围、严格度与 TypeScript 6 过渡项。
- D-077：首次依赖解析采用 npm 原生能力与零第三方依赖策略脚本，在脚本禁用、官方 registry-only、实际 tarball 证据、SPDX SBOM、显式漏洞阈值和双端点只读验证下完成失败关闭准入。
- D-078：用户把不改变既定产品、公开事实、静态生产和数据边界的 M0 内部技术与展示细节委托给 Agent 查证、落盘和验证，不再要求逐项用户选择；外部操作、真实依赖最终准入、基础设施、Git 发布、费用、法律和用户数据仍保留原门禁。
- D-079：为严格 TypeScript 的 Node 24 测试确认 `@types/node@^24.0.0` 直接开发候选；它已随 #21 首轮真实图准入，不进入浏览器 bundle。
- D-080：Linux 作者环境以固定用户级 nvm/Node 24 和 pre-commit 子进程自动选择 `.nvmrc`，不改变系统或新 Bash 的默认 Node，不修改 shell 初始化、用户 npm 配置或 nvm default alias。
- D-081：授权 #21 在官方来源、无脚本、私有临时目录和受限日志边界内完成首次真实 lock、tarball、audit、正式三制品与双端点验收，不包含 Git、Action、基础设施或生产操作。
- D-082：批准两项精确传递 override、35/11 项补充法律正文与 12 项精确 owner exception；所有结论继续绑定最终 lock、integrity、admissions、audit 与双端点结果，不形成通用豁免。
- D-083：授权把当前 D-080/#21 完整工作区作为单一提交推送到 `origin/dev`，并观察该提交的现有 CI 至全部成功；不包含 main、PR、Issue、Action 改造、凭证或基础设施操作。
- D-097：授权在工作区建立 Node 24 主/最低端点、完整历史、固定 Action SHA 与静态供应链证据的四 job 可信 CI 第一阶段；不包含 Git 发布、远端门禁、artifact、凭证或基础设施操作。
- D-098：以仅服务端 `postBuild` 复制替代会序列化绝对路径的静态白名单传输方式，并授权在任务专用临时副本完成官方 npm 双端点联网验收。
- D-099：普通 `push`/`pull_request` CI 移除 live npm audit，不引入失败绕过；静态供应链证据仍失败关闭，显式依赖首次准入或依赖图变化后的重准入仍执行受限联网 audit。
- D-100：授权从精确基点 `9df4ba5678fc251d4882df5d5867e6d4990789e7` 创建 `codex/ci-issues-12-32`，只在该专题分支本地提交 CI、#12、#32 与 D-098 闭环；不整合基点后的远端提交，不授权 push、PR 或远端/生产操作。
- D-101：窄幅授权把 `codex/ci-issues-12-32` 非强制推送到 `origin` 同名临时分支并设置 upstream；不触碰 `main`/`dev`，不创建 PR、写 Issue 或操作其他远端与生产状态。
- D-102：保持本地 `quality`/pre-commit 零第三方依赖，把复用冻结 Docusaurus 解析器的 E-013 历史门禁移到 CI 冻结安装后的独立入口。
- D-103：授权把 #24 的作者创建事务、消费者门禁、测试与同步文档作为单一提交纳入当前专题分支，并普通非强制推送到 `origin` 同名临时 ref；不扩大到 PR、Issue、`main`/`dev` 或生产操作。
- D-104：授权同时保留 #27/#28 与 #12/#24/#32 的已验收语义，以普通 merge 纳入 `dev`，完成本地门禁与精确 SHA CI 后，经唯一 `dev -> main` PR 普通合并并验证 `main` CI；不允许 rebase、force push、直接 push `main`、绕过检查或扩大到生产操作。
- D-105：#27/#28 的历史 `main` 晋级授权因并行编号冲突由 D-096 重编号；授权内容不变，且已由 `main@d00000e` 证明完成。
- E-001 至 E-016：在 D-078 范围内固定项目结构化事实与长文职责拆分、叙事单一所有者、尾斜杠及路由闭包、作者/主题/模块注册表、classic/Infima 最小主题适配、项目主预览 schema、发布态素材白名单、局域网草稿候选与失败保留旧预览、npm 启动前隔离、确定性 SPDX、Node ESM TypeScript 测试、HEAD 可达完整 Git 历史门禁、同版本服务端 301、production artifact 自包含重建、单一内容装配与零公开文档适配，以及由 TAT 受限交付最终 release 的工程方案。

决策原文、工程决定、替代关系和保留门禁统一记录在[待决策问题](open-decisions.md)。M0 内部细节按 D-078 执行；未来身份、评论、在线体验、用户数据、外部服务和基础设施操作仍不能从本架构推导授权。

## 要解决的问题

主站当前只是手写静态页面，但目标同时包含持续发布技术文章、展示多个项目，以及未来增加统一账户、评论和项目试用。如果把这些能力放入同一个应用和数据库，任何身份、评论或单个项目的改动都可能扩大主站的发布和故障范围。

目标架构需要同时满足：

- 主站内容可以独立构建、发布、缓存和回滚。
- 只有站点所有者可以编辑并发布技术内容。
- 一个账户未来可以访问全部项目，不为每个项目重复注册。
- 评论故障不能阻止文章和项目介绍被阅读。
- 一个项目的试用服务、数据库或发布失败不能影响其他项目和主站。
- 当前没有试用、登录和评论时，不提前运行对应服务。

## 已确认的逻辑架构

```text
Git 仓库中的内容与页面
          |
          v
  Docusaurus 静态构建
          |
          v
      静态发布产物 ----------> Nginx ----------> 浏览器
                                                |
                       未来按需调用              |
              +---------------------------------+------------------+
              |                                 |                  |
              v                                 v                  v
       中央身份服务                      独立评论服务          独立项目服务
       一个全局账户                      评论数据边界          各自 API/数据
              ^                                                    |
              +---------------- 各项目复用身份 --------------------+
```

该图表达逻辑职责，不代表已经选定协议、域名、数据库、云产品或部署位置。

## 组件职责

| 组件 | 当前阶段 | 目标职责 | 明确不负责 |
|---|---|---|---|
| Docusaurus 主站 | I-04 工作区基线已实现 | 从 Git 内容生成主页、文章、项目目录和项目介绍静态页面，并提供框架标准客户端导航 | 保存账户、评论、上传文件或项目业务数据 |
| Nginx 静态服务 | 尚未部署 | 提供 Docusaurus 构建产物、TLS 终止和静态缓存 | 执行 Docusaurus、身份、评论或项目业务代码 |
| 中央身份服务 | 不部署 | 未来统一注册、登录、账户状态和跨项目身份 | 保存项目业务数据或文章正文 |
| 评论服务 | 不部署 | 未来处理技术分享区评论及其治理流程 | 决定主站内容或承载项目 API |
| 独立项目服务 | 不部署公共试用 | 未来按项目独立提供前端、API、上传和数据能力 | 修改主站发布产物或共享其他项目数据库 |

## Docusaurus 内容拓扑

首版只使用一个 docs 内容实例承载项目介绍与技术文章。实例内保留两套相互独立的导航视图：项目页进入项目侧栏，文章页进入技术分享侧栏；顶部导航继续承担两类内容之间的全站跳转，右侧标题导航继续按当前页面的 `H2/H3` 生成。单一实例不表示项目与文章采用同一种领域 schema，也不允许同一内容因为跨项目关系出现在多个规范侧栏位置。

#22 的 I-04 迁移基线尚无可被真实 schema 验证的 Markdown/MDX，固定版本 docs 插件又拒绝零公开文档实例，因此当时 classic preset 显式设置 `docs: false`，只验证框架、严格 TypeScript、模块边界和最小 production build；这不是当前配置。#23 已实现纯内容门禁，#5 已迁移真实项目正文，#6/#7 已完成媒体领域门禁、双模式静态素材计划与生产泄漏判定并远端闭环；#26 已以 E-016 的 classic-derived preset 远端闭环下述唯一 docs 实例、frontmatter 投影、侧栏、路由与 production 构建。不得恢复条件 `docs:false`，也不得用占位文档、第二内容根、额外实例或 fallback 绕过零公开文档事实。

唯一 docs 实例采用 current-only 配置：`includeCurrentVersion: true`、`onlyIncludeVersions: ["current"]`、`tags: false`。不得使用 `disableVersioning: true`，因为 Docusaurus 3.10.2 在没有版本清单时会拒绝该选项；扫描器还必须拒绝 version roots、localized 第二内容根与 category metadata，确保框架不能从另一棵内容树或目录元数据扩展公开面。

该拓扑的边界如下：

- 不启用 blog 内容实例，因此首版不自动获得或公开时间流、归档、Feed、作者页、主题页和 blog 分页路由。
- 不配置第二个 docs 内容实例，因此项目与技术文章不维护不同的插件 ID、版本目录或版本生命周期。
- 项目介绍与技术文章仍分别遵守 `/projects/` 和 `/writing/` 路由职责；单一实例不得把文件目录变成新的公开 URL 真相源。
- 该选择只减少同一静态主站内的插件与配置边界，不提供独立构建、部署或故障隔离；主站仍生成一个静态 release。
- 未来若出现相互独立的文档版本生命周期，或明确批准时间流、归档、Feed 等产品需求，必须重新评估内容拓扑，并保持既定公开 URL。

单一 docs 实例的 `routeBasePath` 为 `/`，物理内容根为仓库根 `site-content/`。技术文章继续使用 `site-content/writing/<source-name>/index.md|index.mdx` 与 D-059 至 D-067 的身份、投影和作者工具方向；E-001 又把项目正文固定为 `site-content/projects/<project-id>/index.md|index.mdx`，结构化事实由 `projects.json` 唯一拥有，框架字段只在构建内存中派生。E-004 固定首页、项目目录和技术分享目录由 `src/pages/` 提供，详情由同一个 docs 实例提供；项目侧栏与技术分享侧栏都只消费已校验的注册表、内容和当前 `docs[].id`。构建层公共入口只导出 `loadValidatedContent`、`createParseFrontMatter`、`createSidebarItemsGenerator` 与 `createContentDataPlugin`；侧栏稳定名称为 `projectsSidebar`、`writingSidebar`，安全 global data 键为 `projectNavigation`、`writingNavigation`。项目投影只含安全显示用的身份/来源、title/summary、canonical/顺序、状态/日期、可选仓库、主预览公开属性，以及按注册表显式顺序解析到公开文章的相关技术分享标题与规范路径；文章投影只含身份/来源、title/summary、canonical/日期/状态、作者与主题显示名、已合并的 SEO description，以及按 frontmatter 显式顺序解析到当前可见项目或文章的标题与规范路径。该投影不包含正文、原始注册表、未解析关系 ID、推荐、引用、私有索引或字节快照；production 的每个关系目标必须已经公开且与同批投影闭合，不能静默省略。内部 API、错误格式和测试编排属于 D-078 工程实现，不再形成逐项用户门禁；#9/#10/#21/#22/#11/#23/#5/#6/#7/#26/#27/#28 已完成各自实现与远端闭环。#27 已消费该安全投影完成页面、公开表达与关系链接制品闭包，#28 已完成主题、响应式与可访问性验收；#12 历史门禁、#24 作者事务和 #32 workflow 已完成专题实现与本地验收并依 D-104 纳入 `dev` 集成，组合树远端证据仍待精确 SHA 取得；#13 已完成仓库侧 release 输入，#33 已由 `b38354b` 推送 release 封装但无该 ref 远端 CI，#35 已由本地提交 `f7fdc43` 实现但尚未推送，#14 producer/upload 已由本地提交 `7b5cc47` 完成但尚未推送。#8 继续跟踪预览候选，#14 的 canonical `main` 真实 artifact 与 #36/#37 服务器闭环仍待取得。不能把单项闭环或临时 ref 交付等同于全站就绪，Git 提交、push、远端 CI、Issue 关闭、Action 改造和基础设施操作仍以各自授权与实际证据为准。

## 内容字段适配边界

D-055 固定内容模型与框架之间的真相源方向。技术文章继续以 D-038 至 D-050 已确认、并由 D-058 修订 slug 值语义后的领域字段和 Git 注册表作为唯一可编辑来源；Docusaurus 需要的等价或派生元数据只能在构建期从这些输入只读直传或生成。派生结果不回写 Markdown/MDX、注册表或其他已提交文件，Docusaurus 构建产物也不成为编辑来源。

D-058 优先复用 Docusaurus 原生路由字段：技术文章作者直接在源 frontmatter 中填写根相对完整路径，例如 `slug: /writing/dependency-inversion`；单一 docs 实例使用 `routeBasePath: '/'`，默认解析结果中的 `slug` 原样参与路由。该值同时是领域 URL 契约和框架原生字段，不再生成短 slug 到栏目路径的派生值，也不增加第二个路由字段。

D-056 曾把全局 [`markdown.parseFrontMatter`](https://docusaurus.io/docs/api/docusaurus-config#markdown) 与本地纯投影函数固定为技术文章适配执行点；D-058 后该决定因缺少逐字段 fit-gap 而重新开放。D-059 已以更小职责重新确认相同的官方执行点：调用一次 `defaultParseFrontMatter` 后，只对已经被确认属于技术文章的文件执行无副作用纯投影。投影不修改正文或源 frontmatter，不回写文件，也不生成第二棵临时内容树。

D-059 的技术文章核心字段契约经 D-064 补充文章身份后如下：

| 源领域字段 | Docusaurus 构建内存 | 处理规则 |
|---|---|---|
| `title` | 原生 `title` | 原值直传，不重命名、不规范化；本站 schema 必须拒绝缺失或非法值，不能接受框架 fallback 代替必填字段 |
| 完整 `slug` | 原生 `slug` | 按 D-058 原值直传，不补写 `/writing/`，不从文件路径生成 |
| `articleId` | 保留自定义 frontmatter | 作为 UUIDv7 领域身份原值保留，不映射或双写为 Docusaurus 原生 `id`，不参与路由或分类 |
| `summary` | 原生 `description` | 无条件派生 `description = summary`；不得改为 `seo.description ?? summary`，也不得从正文首行推断 |
| `publicationStatus` | 原生 `draft` 行为 | 只有源值为 `draft` 时派生 `draft: true`；`published` 与 `archived` 不映射为 `unlisted` |
| `seo.description`、`seo.socialDescription` | 保留自定义 frontmatter | 不参与原生 `description` 派生；后续页面元数据按 D-046 分别应用回退 |
| `authors`、`publishedAt`、`updatedAt`、`classification` | 保留自定义 frontmatter | 不映射到 blog 字段、`last_update` 或原生 `tags`，由后续已批准的主题、侧栏与校验消费者读取 |

原生 `description` 是所有 Docusaurus 原生消费者共享的公共默认摘要，因此始终等于 `summary`，不是 SEO 覆盖后的最终页面描述。目录或生成索引消费 `description` 时必须仍看到 `summary`；页面 `<head>` 的 meta description 必须遵守 `seo.description -> summary`，分享描述必须遵守 `seo.socialDescription -> seo.description -> summary`。元数据组件由主题层对框架默认标签做单点覆盖和去重，不在正文组件再次输出同名标签。契约测试必须覆盖无覆盖、仅 `seo.description`、仅 `seo.socialDescription`、两者同时存在四种组合；每种组合都必须保证目录摘要仍为 `summary`，且 `<head>` 不出现互相冲突或重复的 meta/OG description 标签。

D-057 曾把 `writing/` 类型边界与 D-056 的全局解析分流绑定，D-058 后该组合被重新开放评审。D-060 独立重新确认类型边界：相对未来单一 Docusaurus docs 内容根，规范化后确实位于 `writing/` 子树内的 Markdown/MDX 构成唯一技术文章成员集合。D-061 随后把该物理内容根固定为仓库根 `site-content/`，因此当前文章候选边界是 `site-content/writing/`；仓库现有设计文档目录 `docs/` 不属于该内容根。

D-062 在这个候选边界内进一步固定合法源码布局：每篇文章位于 `site-content/writing/<source-name>/` 直接子目录，并且正文入口恰好是 `index.md` 或 `index.mdx` 之一。D-060 的宽候选扫描不能因布局收窄而缩小；根级 Markdown/MDX、非 `index` 正文、同目录双入口和额外 Markdown/MDX 仍是文章候选，但必须因违反布局而使未来门禁失败，不能退回普通 doc 或被 include/exclude/partial 绕过。

D-063 进一步把 `<source-name>` 固定为作者手工确定、稳定可读的语义源码名，只用于在 Git、PR 和编辑器中辨识文章目录，不是文章领域身份。它是 `site-content/writing/` 下的单个直接子目录路径段，长度为 1-64 个 ASCII 字符并完整匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`，在当前文章直接子目录命名空间内全局唯一。未来工具可以接收并校验作者输入，但不得从标题、完整 `slug`、`classification`、日期、正文或其他字段自动生成、同步改写或静默纠正。源码名可以恰好与 slug 尾段相同，但不形成等值、派生或持续同步契约。

首次发布前允许在一次受审变更中受控重命名：原子移动完整文章目录，不复制正文入口，同步更新所有旧文件路径和旧 doc ID 消费者，并通过完整静态构建、内部链接与资源断链检查；目录改名不得自动改变 slug。首次发布后禁止日常改名，只有拼写错误或持续造成严重歧义时才可在用户对该次操作明确授权后，以独立迁移使用 `git mv` 改名；公开 slug 与 canonical URL 必须保持不变，全部路径和 doc ID 消费者必须原子更新并通过同等门禁。

D-064 为文章补充独立的稳定领域身份：每个技术文章从创建起在唯一正文入口的顶层 frontmatter 保存必填、全站唯一且终身不可修改或复用的 UUIDv7 `articleId`。articleId、`<source-name>`、完整 `slug`、`classification` 和 Docusaurus doc ID 分别承担领域身份、源码组织、公开 URL、内容组织与框架内部引用职责；它们在领域语义上不得互相替代、建立等值约束或作为另一项的真相源。默认 doc ID 仍由 Docusaurus 按源码路径派生，但只属于当前构建内部引用。未来评论若经独立决策上线，以 articleId 关联文章实体；这不批准评论服务、账户、API、数据库或用户数据处理。

UUIDv7 时间字段只记录生成器在分配 ID 时采用的 Unix 毫秒时间源值，可服务 UUID 值的未来存储索引局部性与技术排序，但不保证真实业务事件顺序，也不是文章创建、发布或更新日期。当前不新增 `createdAt`；不得从 articleId 解码、补写或校验 `publishedAt` 与 `updatedAt`，也不得用 UUID 时间驱动公开日期、SEO、sitemap、列表、侧栏、归档或日期搜索。唯一正文入口同时保存 articleId、当前 slug、发布状态与显式日期，形成唯一可编辑绑定。构建在临时目录从通过 schema 的当前内容重建按 articleId 排序的 JSON 索引，记录只包含 `articleId`、`slug`、`publishedAt` 与 `updatedAt`；生产索引排除 draft，不回写、不提交、不复制到公开 `build/`，只供构建期路由、历史身份与重定向检查消费，不建立运行时缓存。该索引不表示站内搜索、日期筛选、归档路由或搜索依赖已经获批。

D-065 将新文章的正常创建入口固定为作者显式运行的仓库内 Node.js 文章创建命令。命令在同一次作者操作中创建尚不存在的 `site-content/writing/<source-name>/`、D-062 的唯一正文入口和一个符合 D-064 的顶层 articleId；成功结果必须三者齐备，失败必须恢复到调用前状态，不得留下目标文章目录、正文入口或本次创建产生的其他持久化结果。`<source-name>` 仍由作者按 D-063 确定，命令不得从 articleId、标题、slug、分类、日期或正文相互推导、同步改写或静默纠正领域值。普通创建入口不覆盖、修复或轮换既有文章的 articleId，旧文分配由独立迁移处理。

创建命令只写入获准运行本站 Node.js 的 Linux 作者工作区并形成待审 Git diff，不自动暂存、提交、推送或发布。Git hook、PR bot、CI、Docusaurus、预览、发布自动化和生产服务器都不能隐式触发创建命令，也不能补写或修复 articleId；它们只对已提交源内容做只读校验和已批准的构建期派生。D-047 的发布日期辅助命令是独立作者操作，负责显式日期而不生成 articleId；文章创建命令不得读取 UUID 时间写入 `publishedAt` 或 `updatedAt`。

D-066 将获准执行本站命令的作者工作区、仓库质量门禁、CI 与 Docusaurus 静态构建的目标运行时统一为 Node 24 LTS 主版本，最低为 24.16.0；允许范围是 `>=24.16.0 <25`，后续 Node 主版本必须重新确认。D-065 创建命令只通过稳定的 `node:crypto.randomUUIDv7()` 分配 articleId，不引入 `uuid` 或其他 UUID 生成、CLI、校验 npm 包，也不调用仓库外服务。仓库现已建立 `.nvmrc`、封闭 `engines.node` 和 E-010 双端点校验；D-080 已让本地 pre-commit 在子进程使用 `.nvmrc` 精确 Node 24，同时系统和新 Bash 默认仍为 Node `v22.22.0`。D-097 至 D-102 已把 Ubuntu 主质量、最低端点、PlantUML 与静态供应链 job 接到 Node 24、完整 checkout、完整历史门禁和零依赖本地质量入口；任务专用 fresh 副本已完成本地双端点验收，相关实现正依 D-104 纳入 `dev`，组合树远端 CI 仍待精确 SHA 取得。生产请求运行时继续只有 Nginx 静态服务。

原生 UUIDv7 后端依赖非单调系统时钟，本站接受其在同毫秒、时钟回退、跨进程或跨机器时不保证严格递增，不实现计数器、共享状态、重试到大于前值、时间修正或其他单调包装。生成结果仍只承担 D-064 的身份和技术索引局部性，不承担业务排序或日期职责；当前树唯一性、Git 历史不可复用和未授权改写仍由独立门禁处理。

D-067 将仓库根 `.nvmrc` 固定为 Node 精确执行版本的唯一可编辑真相源，初始值只记录在 D-067 决策日志；`package.json#engines.node` 继续保存 `>=24.16.0 <25` 兼容边界，二者分别承担实际执行基线和受支持范围，不能相互覆盖。Linux 作者环境由 nvm 读取 `.nvmrc`，获准的主质量、Ubuntu PlantUML 与 Docusaurus 构建 job 由 `actions/setup-node` 的 `node-version-file` 读取同一值；正常作者和发布必需入口必须先断言实际版本等于 `.nvmrc`，不在 workflow、脚本或活动文档复制当前 patch。浮动的 `24`、`lts/*`、`latest` 与 `check-latest` 均不得代替该精确版本源。

主质量和构建使用当前 `.nvmrc` 精确基线；Ubuntu CI 的最低版本入口先断言实际版本等于 `engines.node` 下界，再与正常入口调用同一质量、Docusaurus 静态构建和行为测试负载。最低版本入口只替换版本断言，不跳过其他检查，不生成发布制品，不触发文章创建或发布；不得提供通用跳过版本检查的开关。只有精确基线下生成并通过门禁的制品可进入发布链。版本契约还必须验证 `.nvmrc` 是范围内的单个非浮动 `24.x.y`，并验证最低版本任务等于 `engines` 下界；这不宣称逐一测试范围内每个 patch。两个封闭入口、共享负载、job 拓扑和错误契约已由 CODE-003/CODE-016 固定，并由 D-097 至 D-102 完成专题接线与本地验收；D-104 要求以合并后的 `dev` 精确 SHA 取得真实 GitHub Actions 证据。

Node 24 安全 patch 被发现后及时通过独立 PR 升级，其他 patch 至少每月检查。升级 PR 先修改 `.nvmrc` 候选值，再分别在候选精确基线和不变的兼容下限运行全部 Ubuntu CI 任务，并通过 PlantUML 与届时全部发布必需门禁；全部成功后才允许合并，不得自动合并。普通 patch PR 不修改 `engines` 或兼容下限；Node 25 或后续主版本、兼容下限或上界调整都必须重新决策。E-005 已把构建固定在 GitHub Actions，生产服务器不安装或运行 Node/npm、不拉取源码。D-073 固定两个 Node 端点随附的 npm、唯一 `package-lock.json` 与冻结安装方向，E-010 要求实际 npm 进程经过隔离入口，CODE-016 固定 job 拓扑；D-080 已固定并验收本地作者 nvm 的精确外部版本、对象与安装校验，#21 又以 Node `24.18.0`/npm `11.16.0` 与 Node `24.16.0`/npm `11.13.0` 实测两个隔离端点读取同一 lock 并保持 manifest/lock 前后哈希不变。D-097 至 D-102 已按官方 release 与 commit 证据准入并固定三个 Action SHA，完成 Node 24 CI 拓扑的专题实现与本地验收；系统默认 Node 22 不因该实现改变，组合 workflow 的远端结论仍待 D-104 的 `dev` 精确 SHA 验证。

D-072 将执行平台收敛为单一路线：作者 Node.js、文章创建与日期辅助命令、仓库质量检查和 Docusaurus 构建只在 Linux 作者/预览环境运行，GitHub Actions 只使用 Ubuntu。生产服务器继续只提供经过验证的静态制品，不运行 Node.js 请求服务。其他客户端只承担不依赖本站 Node.js 工具链的协作操作，具体边界由[开发预览工作流](dev-workflow.md)维护。

D-073 将首版框架与依赖安装边界固定为 Docusaurus `3.10.2`：`@docusaurus/core`、`@docusaurus/preset-classic` 与 `@docusaurus/faster` 使用相同精确版本，配置采用 `future.v4: true`。classic preset 显式关闭 blog，不配置搜索、统计或其他浏览器外部请求；preset 内含能力不等于获准启用。依赖管理只使用 Node 随附的 npm 和仓库唯一 `package-lock.json`；E-010 进一步要求正常验证、CI 与构建都通过隔离 `ci` profile 在全新 cache 中冻结安装，CI npm scripts 通过隔离 `run-script` profile 调用。只有受审依赖变更可以在精确主基线更新清单与 lockfile，最低 Node 端点只读同一 lockfile。该选择减少未来 v4 迁移工作，但把 Faster、严格兼容行为和 preset 的完整安装依赖图纳入首次构建、许可证、漏洞、生命周期脚本、制品网络与真实浏览器验证。

D-073 没有把尚未列明的 React、React DOM、MDX 或其他直接依赖版本补成默认，也没有批准 community plugin、外部服务或用户数据处理。D-076 后续补齐首轮候选直接清单，D-077 又固定首次供应链准入方法；#21 已在 D-081/D-082 边界内把该清单解析为唯一真实 `package-lock.json`，完成 1,225 项精确准入、正式三制品、首次准入当时的 audit 全零和主/最低端点临时冻结安装。2026-07-26 的最新 live audit 已观测到 18 个 high 依赖节点；D-099 只将该结果移出普通 CI 结论，未把风险视为已修复或已接受。#22 已在同一准入图的任务临时副本完成冻结安装、类型检查和真实最小 Docusaurus build；仓库根继续没有 `node_modules/`。#26 的唯一 docs 装配与真实内容制品检查已远端闭环，#27/#28 又完成页面、主题、浏览器网络边界与真实 Chrome 回归。

D-074 将 Docusaurus 管理的目标站点源码统一为严格 TypeScript。站点配置使用 `docusaurus.config.ts`；侧栏配置、侧栏生成器、本地插件、构建期领域适配及其他无 JSX 站点模块使用 `.ts`；页面、主题覆盖和 React 组件在包含 JSX 时使用 `.tsx`。目标 `tsconfig.json` 显式设置 `compilerOptions.strict: true`，上述范围不新增 `.js` 或 `.jsx`；任何例外都必须先回到用户决策门禁。配置、侧栏及其 Node.js 侧模块保持纯 Node.js 执行边界，不导入浏览器 API、React 或 JSX。

Docusaurus 官方说明其构建不使用项目 `tsconfig.json` 完成 TypeScript 类型检查，因此目标 CI 必须把 `tsc --noEmit` 和 Docusaurus build 作为两个独立、失败关闭且都必需的门禁：前者验证目标源码类型，后者验证框架加载与静态制品；任一通过都不能替代另一项。现有 `scripts/quality/*.mjs` 保持迁移前 ESM，不因 D-074 强制改写。D-076 已确认首轮 TypeScript、Docusaurus/React 类型工具和 React/MDX 直接依赖，以及 `tsconfig` 继承与模块解析；这些依赖已随 #21 首轮图准入。#22 已创建根配置、严格 TypeScript scaffold、模块检查器和受控最小 build；#11 已创建独立测试 program，#23 已增加内容领域源码，#26 已远端闭环真实内容装配和 production build，#27/#28 又完成页面、主题与浏览器验收。D-097 至 D-102 已把独立 `quality`、安装后历史门禁、`typecheck`、测试与 production build 接入 Node 24 主/最低端点，并通过专题分支 fresh 副本验收；组合树远端 CI 仍待 `dev` 精确 SHA 证明。lint、formatter 或其他新工具只有出现可验证缺口时才进入 D-077 准入，不能作为模板默认依赖。官方依据：[Docusaurus TypeScript Support](https://docusaurus.io/docs/typescript-support)、[Docusaurus Configuration](https://docusaurus.io/docs/configuration)、[Docusaurus Sidebar](https://docusaurus.io/docs/sidebar)。

D-075 将 CODE-002 的逻辑层映射为首版物理结构：框架入口使用仓库根 `docusaurus.config.ts` 与 `sidebars.ts`；`src/domain/` 只承载领域核心，`src/build/` 承载 Docusaurus 构建适配和本地插件，`src/components/` 承载可复用展示组件，`src/pages/` 承载文件路由页面，`src/theme/` 承载主题覆盖；作者工具位于 `scripts/author/`，质量脚本保持在 `scripts/quality/`。`src/build/` 是受版本控制的构建期源码目录，不是静态产物目录；E-005 已把 Docusaurus 默认 `build/` 固定为目标制品目录。目录名不会改变既有依赖方向，也不建立通用 `shared` 层；`site-content/` 继续是独立内容根，不进入源码模块树。

跨逻辑层依赖必须从被依赖模块的显式公共入口导入，禁止直接引用其内部文件。只有出现真实跨层消费者时才创建对应 `index.ts`，不预建空入口；公共入口逐项写出值导出与类型导出，不使用递归或宽泛 `export *`。同一模块内部使用相对导入。默认导出只用于 Docusaurus 加载器所需的站点配置、侧栏、文件路由页面、主题覆盖和独立本地插件构造器；内部可复用模块使用具名导出，插件静态方法按框架契约具名导出。首版不新增业务路径别名，只能在 Docusaurus 文档定义的对应语义下使用官方别名；官方别名不能绕过跨层公共入口。公共 API、命名、层内子目录与边界测试以[主站编码规范 Spec](../engineering/main-site-coding-spec.md)为实施真相源。M0 不做默认 Swizzle，MDX 只允许从 `src/components/mdx/index.ts` 导入且首版白名单为空。官方依据：[Docusaurus Configuration](https://docusaurus.io/docs/configuration)、[Docusaurus Sidebar](https://docusaurus.io/docs/sidebar)、[Docusaurus Creating Pages](https://docusaurus.io/docs/creating-pages/)、[Docusaurus Plugin Method References](https://docusaurus.io/docs/api/plugin-methods)、[Docusaurus Client architecture](https://docusaurus.io/docs/advanced/client)与[Docusaurus Versioning](https://docusaurus.io/docs/versioning)。

D-076 在 D-073 的三个精确框架包之外确认首轮直接依赖。应用依赖使用 `react@^19.0.0`、`react-dom@^19.0.0` 与 `@mdx-js/react@^3.0.0`；开发依赖使用 `@docusaurus/module-type-aliases@3.10.2`、`@docusaurus/tsconfig@3.10.2`、`@docusaurus/types@3.10.2`、`@types/react@^19.0.0` 与 `typescript@~6.0.2`。D-079 又为 E-012 的严格 Node 24 测试增加 `@types/node@^24.0.0` 直接开发依赖；它只提供 Node 测试类型，不进入浏览器 bundle。版本表达由对应决定拥有，唯一 `package-lock.json` 负责冻结所有范围的实际解析结果。模板示例使用的 `clsx`、`prism-react-renderer` 和仍无直接用途的 `@types/react-dom` 未获新增直接依赖授权。首轮直接与传递图已由 #21 通过 D-052/D-077 的许可证、NOTICE、漏洞、生命周期脚本和分发义务审查；任何后续变化都必须重新准入，不能借“传递依赖”绕过。

目标根 `tsconfig.json` 继承精确 `3.10.2` 的 `@docusaurus/tsconfig`。本站显式覆盖 `baseUrl: "."`、`ignoreDeprecations: "6.0"`、`strict: true` 与 `allowJs: false`，并把首轮 `include` 限定为根 `docusaurus.config.ts`、根 `sidebars.ts`、`src/**/*.ts` 和 `src/**/*.tsx`；`.mjs` 作者/质量/发布 CLI 与 `tests/` 不进入该 program。根 `module: "esnext"`、`moduleResolution: "bundler"`、`noEmit: true` 与 `skipLibCheck: true` 由精确官方基线继承，本站不重复声明。E-012 的独立测试配置只以领域/构建测试为根输入，覆盖为 NodeNext/ES2024、显式 Node types 与临时 emit，再由当前 Node 的 `--test` 直接执行编译后 ESM；进入该执行图的相对导入使用运行时 `.js` 说明符。测试覆盖不改变根 program，也不使用 loader、实验解析或仓库内输出。官方基线的 `@site/*` 映射只服务 Docusaurus 文档定义的框架语义；本站不添加自定义 `paths`，`baseUrl` 也不允许业务裸导入或绕过 D-075 的跨层公共入口。

目标类型检查命令继续显式执行 `tsc --noEmit`，既不能因基线已经设置 `noEmit` 而省略 `--noEmit`，也不能被 Docusaurus build 替代。Docusaurus 3.10 的 `baseUrl` 与 TypeScript 6 的 `ignoreDeprecations: "6.0"` 是相互绑定的过渡兼容项，不是永久站点标准；升级到 TypeScript 7、Docusaurus 4 或改变 `@docusaurus/tsconfig` 基线前必须重新审查并移除不再适用的选项。D-076/D-077 本身只确定候选与准入方法；#21 随后完成唯一 lock、传递图结论和临时双端点冻结安装，#22 已完成配置创建与最小站点迁移，#26 已远端闭环真实内容装配；D-097 至 D-102 已在专题分支接线目标 CI 并完成本地 fresh 验收，现依 D-104 纳入 `dev`，组合树远端运行仍待精确 SHA 证明。官方依据：[Docusaurus TypeScript Support](https://docusaurus.io/docs/typescript-support)、[Docusaurus 3.10.2 TypeScript template](https://github.com/facebook/docusaurus/blob/f37f9035584917a97a260b91fc2842cba4f8b94f/packages/create-docusaurus/templates/classic-typescript/package.json)、[Docusaurus 3.10.2 tsconfig template](https://github.com/facebook/docusaurus/blob/f37f9035584917a97a260b91fc2842cba4f8b94f/packages/docusaurus-tsconfig/tsconfig.json)、[`@docusaurus/tsconfig` 3.10.2 source](https://github.com/facebook/docusaurus/blob/f37f9035584917a97a260b91fc2842cba4f8b94f/packages/docusaurus-tsconfig/tsconfig.json)与[TypeScript 6 `baseUrl` transition](https://github.com/facebook/docusaurus/issues/11893)。

文章创建命令的路径、参数、Markdown 模板、原子文件系统实现、UUID 文本与历史检查、旧文迁移、错误契约和测试由[主站编码规范 Spec](../engineering/main-site-coding-spec.md)固定。命令只使用 Node 24 原生 UUIDv7，不设置 `disableEntropyCache`，不提供交互式猜测、自动发布、Git 操作或 MDX 创建快捷方式。D-080 的作者 Node 运行时已经就绪，#24 也已完成命令、原子事务及消费者只读残留门禁的专题本地验收，正依 D-104 纳入 `dev`；该入口仅供获准作者显式运行，组合树远端 CI 与 Issue 验收仍待取得。

Docusaurus 内部不使用 articleId 代替框架 ID。首版文章不填写原生 frontmatter `id`；默认 doc ID 只在当前构建内作为框架引用，本站不得手工拼接或提交 `writing/<source-name>/index` 这类 doc ID 可编辑映射，也不得将其作为跨构建、跨发布或领域服务的持久身份。Docusaurus 在当前临时目录与静态构建制品中的框架内序列化不构成本站真相源。文章正文引用同一 docs 实例的其他文章时，统一使用带目标实际 `.md` 或 `.mdx` 扩展名的源码相对文件路径；Docusaurus 将链接转换为目标当前 permalink，因此 slug 迁移不要求改写这类链接，而目标源码目录或扩展名变更必须更新全部入站链接并通过断链检查。不得在正文中使用 articleId 自定义协议、doc ID 或硬编码公开 slug 代替该源文件链接。

技术分享侧栏通过官方 `sidebarItemsGenerator` 在构建期读取已通过 schema 的文章元数据，以 `classification` 作为项目、模块和主题组织的唯一真相源，并为每个 `type: 'doc'` 项直接使用插件提供的当前 `docs[].id`。生产侧栏只生成 `published` 与 `archived` 文章项；开发预览可以在独立“草稿”分组显示 draft，但预览制品必须 `noindex` 且不能发布。侧栏顺序固定为“通用技术”在前，随后按项目 `navigationOrder`、模块 `navigationOrder`、文章 `publishedAt` 降序和稳定 `articleId` 兜底；空分组不渲染。项目侧栏按项目 `navigationOrder` 生成。两个生成器都不从 articleId、slug 或路径反推分类，不手工拼接 doc ID，也不提交第二份成员清单；重分类或源码目录改名不得改变 articleId 或公开 slug。

边界内所有候选文件都必须先通过技术文章领域 schema，再应用 D-059 的最小投影；缺少必填字段、枚举非法、注册表引用或跨字段约束失败必须中止构建，不能退回普通 doc，也不能被框架 include/exclude 或 partial 行为绕过本站校验。边界外文件不运行文章 schema 或投影，只确定为“非技术文章”，不自动成为项目介绍、首页或其他类型。

不得增加 `contentType`、独立成员清单或其他并行判据，也不得用字段存在性、`slug`/URL 前缀、侧栏成员、文件名、doc ID 或分类关系反向判型。`writing/` 只决定内容类型，不生成或覆盖完整 `slug`、公开 URL、canonical、分类、侧栏归属或排序；`<source-name>` 也只是稳定可读的仓库组织名，本站不从它生成或校验这些领域语义。Docusaurus 默认 doc ID 受文件路径影响的框架事实不构成本站的领域真相源；D-058 的根相对完整 `slug` 可以在父目录改名时保持公开 URL 不变，但不能使默认 doc ID 稳定。D-064 只允许本站构建期消费者读取插件提供的当前 doc ID；正文链接与侧栏不得手工拼接或提交路径派生 ID 的可编辑映射，也不得把它作为跨构建身份。schema、投影和未来经批准的消费者必须复用同一判型结果。

该方向受以下边界约束：

- `title` 与 `slug` 使用同一个原生字段直传，不创建字段别名、栏目路径派生值或第二份公开 URL。
- 作者只维护已确认的领域来源，不在源 frontmatter 中同时写 `publicationStatus`/`draft`、`summary`/`description`、`classification`/`tags`、本站日期/`last_update` 或第二套作者资料。
- 任何直传或派生都必须保持已确认的稳定 URL、发布状态、摘要与 SEO 回退、显式日期、作者身份和规范分类语义；不得用框架默认推断覆盖这些语义。
- 字段缺失、枚举未知、映射冲突或框架无法保持既定语义时，构建门禁必须失败，不能静默生成另一种公开结果。
- `projects.json` 是项目结构化事实的长期真相源；`site-content/projects/<project-id>/index.md|index.mdx` 是项目长文正文源。两者按 E-001 一对一关联、字段职责互斥，不把项目与文章合并为同一 schema。
- `articleId`、文章文件名、物理目录、doc ID、侧栏和分类均不生成或覆盖原生完整 `slug`；标题、项目或模块变化不要求移动稳定的文章源码目录，也不改变 articleId 或公开 URL。
- 技术文章与项目正文分别使用 `site-content/writing/` 和 `site-content/projects/`。两棵子树都拒绝符号链接、大小写不精确路径、根级正文、非 `index` 正文、双入口和额外 Markdown/MDX；正文同目录素材放入 `assets/`。E-007/E-008 将项目主预览原件固定到 `site-assets/projects/<project-id>/`，始终公开的品牌和根级文件固定到 `static-public/` 并由 `docs/contracts/static-public-assets.json` 逐文件登记公开角色；原件目录不直接成为 Docusaurus 静态目录，受控构建入口按 production/preview 状态生成全新临时白名单树。路径规范化、登记闭合、误放检测、保留名、旧名称复用、孤儿资源和制品泄漏由零第三方依赖质量脚本实现并以 fixture 验证；机器登记不能替代真实内容、隐私和版权审核。
- UUIDv7 articleId、作者显式仓库 Node.js 创建入口与一次性写入、Node 24 LTS 目标基线、原生 `randomUUIDv7()` 后端及非严格递增语义、`.nvmrc` 唯一精确执行基线、`engines` 兼容边界、受控 patch 升级治理、Linux 作者执行环境与 Ubuntu-only CI、源码相对文章链接及基于 `classification` 与当前 doc ID 的侧栏引用方向已经确认；版本文件、E-010 双端点校验、D-080 本地作者运行时、E-012 测试入口和 I-06 纯领域 schema/API 已实现，#26 已远端闭环私有日期索引、真实扫描与只读投影装配。D-097 至 D-102 已实现 E-013 完整历史检查器、pre-write 候选 API、临时 Git DAG fixture、双端点 Ubuntu CI 接线与零依赖本地质量入口；#24 已完成创建命令、候选/终态历史、原子事务和只读消费者接线的专题本地验收。三项现依 D-104 纳入 `dev` 组合树，远端 CI 与 Issue 证据仍待精确 SHA 取得。
- 该适配不启用 `unlisted`、原生 tags、作者页、主题页、时间流、归档路由、Feed 或其他未批准功能。

## 构建与生产边界

已确认的构建边界如下：

1. 站点所有者在 Git 工作流中编辑内容和页面。
2. 发布辅助命令在提交前把确认后的文章日期写入源文件，改动进入 Git diff。
3. CI 与 Docusaurus 只读取并校验内容输入，再生成静态文件，不修改 frontmatter。
4. 生产环境只提供构建产物，不成为内容编辑源。
5. 浏览文章、项目介绍和个人主页不依赖数据库或动态 API。
6. 当前没有登录、评论或试用能力时，页面不得将其表达为已上线功能。

Docusaurus、Node/npm、严格 TypeScript、内容身份和首次供应链协议已由 D-051 至 D-077 固定；D-078 至 D-080 与 E-001 至 E-016 又关闭了 M0 内容、URL、注册表、主题、构建、artifact、预览、素材、供应链、测试、历史、服务端 301 和单一内容装配边界。#9/#10/#21/#22/#11/#23/#5/#6/#7/#26/#27/#28 已完成各自实现与远端闭环；D-097 至 D-103、#12、#24 与 #32 已完成专题实现和本地验收，仍依 D-104 等待组合树远端闭环。#13/#33/#35 已形成 release 输入、封装和服务器 verifier，#14 producer/upload 已完成本地接线。#36 已完成 D-119/D-120 SSH、D-122 OS UFW 重启前稳态和 D-124 软件事务；D-125 的历史正式回执仍为 `environmental_inconclusive`。D-126 以 `status=complete oracleMatch=true` 关闭当前内容关系缺口后，用户在 D-128 接受剩余历史不确定性并确认云层当时为与 OS UFW 匹配的单一 SSH 来源；唯一正式 component-aware transition 返回 `status=complete outcome=committed`，授权已消费且清理完成。D-129 的唯一维护重启已经执行且 boot 改变，但完整 post-reboot 因 vendor declaration predicate 不满足而保持 pending；没有执行第二次重启、reload、再基线或恢复写入。D-130 已记录所有者对当前主机侧与云控制面的正常确认，并完成新的只读逐组件验收源码与本地反例审计；formal receipt 尚未形成。#8 预览、#14 canonical `main` 真实 artifact、#36 的 D-130 receipt 与 verifier 安装，以及 #37 部署仍待；确认前暂停相应服务器动作。服务器、凭证、后续仓库门禁和生产操作仍须取得各自授权；系统默认 Node 22 与 `public/` 只描述迁移期事实。

## 首版工程技术基线

D-053 将已经分散确认的框架、图表、静态服务、发布控制和原生运维能力固定为同一首版基线。这里确认的是职责组合和失败边界，不表示相关软件、配置或服务器已经安装和上线。

| 范围 | 已固定职责 | 仍受门禁约束 |
|---|---|---|
| 站点与内容 | 使用 `.nvmrc` 唯一精确执行基线、`>=24.16.0 <25` 兼容边界与受控升级治理下的 Node 24 LTS 工具链；以 Docusaurus `3.10.2` 的 core/classic preset/Faster 同版本拓扑、v4 兼容行为、npm、唯一 `package-lock.json` 与隔离冻结安装承载可重复静态构建；Docusaurus 管理的目标源码使用显式严格 TypeScript，首轮候选直接依赖与根 `tsconfig` 采用 D-076 的官方基线和本站收紧规则，D-079/E-012 另固定 Node 测试类型候选与临时编译的 Node ESM 测试，并分别通过 `tsc --noEmit`、测试和 Docusaurus build；依赖按 D-077、E-010、E-011 完成官方 registry-only、启动前配置与缓存隔离、无脚本 tarball 证据、确定性 SPDX SBOM、显式漏洞阈值和双端点只读准入；源码采用 D-075 的标准入口目录、跨层公共入口、框架入口默认导出、内部具名导出和无自定义业务别名边界；作者命令、质量与构建负载只在 Linux 执行环境和 Ubuntu CI 运行；项目介绍与技术文章共用单一 docs 内容实例并分别使用各自侧栏；领域内容模型保持唯一可编辑真相源；实例使用根 `routeBasePath` 和仓库根 `site-content/` 物理内容根，文章 `slug` 直接采用原生完整路径；核心字段采用原生精确直用和最小内存适配；`site-content/writing/` 是唯一文章类型边界，每篇文章使用独立源码目录和唯一正文入口，`<source-name>` 采用人工稳定可读命名，UUIDv7 articleId 作为领域身份，作者显式运行仓库 Node.js 创建命令并通过原生 `randomUUIDv7()` 在唯一正文入口中一次写入该 ID，E-013 以 Docusaurus 3.10.2 公共结构化 frontmatter 解析器、HEAD 可达完整 Git 历史和 lineage 父状态 ledger 防止稳定 ID 复用，正文采用源码相对文章链接，技术分享侧栏从 `classification` 和当前 `docs[].id` 构建期派生 | #9/#10 已实现 E-010/E-011；#21 已完成 1,225 个 canonical identity 的真实传递图准入（含 E-013 的 `@docusaurus/utils@3.10.2`）、正式三制品、首次准入当时的 audit 全零和双端点冻结安装；最新 live audit 的 18 个 high 仍是未修复风险。#11/#23/#5/#6/#7/#26/#27/#28 已完成各自实现与远端验收；D-097 至 D-102 的 Node 24 CI、完整历史门禁、固定 Action SHA、静态供应链与零依赖 pre-commit，以及 #24 作者事务已完成专题本地验收并依 D-104 纳入 `dev`，组合树尚无远端 CI 或 Issue 验收证据。#13/#33/#35 已形成 release 输入、封装和本地服务器 verifier，#14 producer/upload 已由本地提交 `7b5cc47` 完成；#8、#14 的真实 Actions artifact 与 #36/#37 继续跟踪下游验收，后续真实用途新增依赖仍受显式重准入门禁 |
| 图表 | 保留仓库现有 PlantUML 源码编译为静态 SVG 的流程 | 不引入 Docusaurus 运行时图表插件或浏览器端渲染；版本升级仍需供应链复核 |
| Web 与 TLS | Ubuntu Server 24.04 LTS 上由 Nginx 提供静态制品，Certbot 通过 ACME HTTP-01 管理证书 | 生产不运行 Docusaurus/Node.js；Ubuntu 官方 apt 的 Certbot 安装与 timer 基线已由 D-124 验收，ACME webroot、证书签发、续期 hook 和 Nginx TLS 配置仍待实施 |
| 发布控制 | GitHub Actions 的 `production-artifact` 在四个 prerequisite job 成功后，对 `main` 精确 SHA 在 fresh runner 自包含重建、重验并封装同版本 payload 与服务端 301 配置；deploy 以只读 GitHub 权限复核 main HEAD/当前 artifact，再经最小权限 CAM 调用固定 TAT command；服务器分别验证外层 artifact 与上传前 release tree 摘要后整版切换不可变 release | E-015 已固定不传递 `website-quality` build、concurrency 不替代 main 新鲜度、producer/deploy token 最小权限和双摘要信任边界；D-110 已准入固定完整 SHA 的官方 upload Action，#14 已由本地提交 `7b5cc47` 接入 producer，但尚无真实 Actions upload。canonical 仓库已只读核验为 public，当前 artifact 读取不配置服务器凭证；OD-009 继续跟踪 environment protection 的方案能力，deploy Action、CAM、TAT 和服务器配置仍需准入与操作授权 |
| 原生运维 | 使用 systemd 管理服务与定时任务，使用 logrotate 或系统日志轮转能力控制技术日志 | 不引入容器、PaaS、编排平台或第三方常驻监控 agent |
| CI 与发布门禁 | 门禁失败阻止发布成功，旧 release 只有通过当前 URL 暴露账本才能继续使用；D-074 的 `tsc --noEmit`、E-012 的 Node ESM 测试与 Docusaurus build 独立必需；E-013 要求所有历史 job 完整 checkout 并拒绝浅仓库；E-014 要求 301 配置与同一 payload 绑定；E-015 要求最终 production build 在同一 job 完整重验、封装和一次上传；普通 CI 对 D-077/E-010/E-011 可静态复核的依赖来源、integrity、许可证、脚本、admissions、SBOM/NOTICE 和 manifest/lock 漂移失败关闭，显式依赖准入/重准入另对 live audit 漏洞阈值与双端点验证失败关闭 | E-010/E-011 与 #21 的真实供应链报告、制品闭包、最终决定、双端点冻结安装和 composite receipt 已通过本地验收；D-097 至 D-102 已完成完整历史、Node 24 CI、固定 Action SHA、静态供应链证据与零依赖本地质量入口的专题实现和 fresh 本地验收，现依 D-104 纳入 `dev`。#13 服务端 301、#33 release 字节闭包、#35 verifier 和 #14 producer/upload 均有仓库侧本地证据；组合树远端 CI/required checks、canonical `main` 真实 artifact 与 30 天 retention 仍待真实验收 |

普通 CI、发布门禁与显式依赖准入合计必须覆盖以下能力类别：

- 锁定依赖、lockfile 一致性、冻结安装和可重复构建。
- Docusaurus 构建、lint、typecheck 与测试，以及 Markdown/MDX frontmatter 与内容模型校验。
- 统一结构化 frontmatter 解码、`HEAD` 可达完整 Git 历史、稳定 articleId/source-name/注册表 ID lineage 不复用，以及浅仓库、local/worktree config 绕过、legacy grafts、partial/promisor/alternate object store、缺失对象和 merge 第二父失败关闭。
- 内部链接、静态资源、公开路由、canonical、sitemap、草稿泄漏、静态重定向 source 缺失、同版本服务端规则和关键公开事实检查。
- PlantUML 源码编译及生成制品一致性。
- 直接与传递依赖的许可证准入（未知或未获批即失败）、第三方声明或 SBOM、Secret 和危险依赖检查；漏洞由显式依赖首次准入/重准入的受限 live audit 与默认分支 Dependabot Alerts 持续发现，普通 `push`/`pull_request` CI 不联网 audit，也不以 registry 可用性或 audit 结果决定 workflow 结论。
- 构建制品的外部网络请求 allowlist，以及基于真实制品验证的 CSP。
- `production-artifact` fresh runner 的精确 SHA、完整历史、冻结安装、完整主端点质量、build tree 摘要、同 job 封装、唯一 artifact ID/digest 输出和无跨 job build fallback。
- 桌面端和移动端真实浏览器、关键链接和可访问性检查。
- 发布后 HTTPS、单跳 301、查询保留、目标 200、关键页面和资源冒烟；只追加 URL 暴露账本中每个历史路径必须可解析，每条历史边的 source/target 必须收敛到同一当前 200。失败时不得把 release 标记为成功；只有通过更新后账本的 fallback 才能自动回滚，否则默认停止或经单独授权进入 forward-only。

首版不增加 CMS、Pagefind 或其他站内搜索、运行时主站后端、数据库、容器、分析、登录、评论或第三方浏览器请求。这些当前非目标不否定已确认的未来解耦服务方向；需要启用时仍须单独完成产品、数据、架构和运维决策。

## 开源依赖分层准入

D-052 约束主站浏览器产物、构建依赖、未来独立服务和开发运维工具，目标是在复用成熟开源能力的同时，保持许可证义务、数据路径和故障边界可追溯。许可证名称本身不能替代维护状态、安全性、资源占用、外部服务条款和退出路径审查。

### 软件分层

| 层级 | 准入规则 | 不得据此推导 |
|---|---|---|
| 主站构建与浏览器产物 | 新增依赖优先 MIT、Apache-2.0、BSD-2-Clause、BSD-3-Clause 或 ISC，并核验锁定版本、直接及传递依赖 | 优先许可证不等于包、版本、preset、插件或组件已经批准 |
| 其他弱 copyleft 或非首选许可 | MPL、LGPL 等按实际链接、修改、分发和替换方式逐项核验 | 不因许可证被 OSI 认可就自动进入浏览器包 |
| 强 copyleft 与复杂许可 | GPL、AGPL、自定义、source-available、双重授权或义务不清的候选不得进入主站浏览器包或静态产物；确有需要时只作为隔离服务候选并单独评估 | 独立部署不消除 AGPL 源码提供等适用义务，也不构成服务选型授权 |
| 社区插件与外部运行时能力 | SDK、iframe、分析、登录、评论、搜索以及浏览器离开本站 origin 的请求必须单独完成产品、数据、CSP、可用性与跨境评审 | MIT 等宽松许可不等于允许处理访问者数据或依赖境外服务 |
| 开发、构建与运维工具 | 按是否复制、修改、分发或进入制品单独登记；不进入发布物的工具与浏览器依赖分层审查 | 现有 Git 等 GPL 工具不因主站前端规则成为违规，也不得被复制进站点制品 |
| 字体、图标与内容素材 | 分别核验字体、内容、商标、肖像和署名要求 | 软件依赖许可证不覆盖图片、视频、外部文档或品牌资产 |

### 每项准入记录

具体依赖进入安装或实现前，至少记录并审核：

- 名称、锁定版本、官方来源和用途。
- 直接依赖与传递依赖的实际许可证文件、SPDX 标识及版权或 NOTICE 要求。
- 所属层级，是否进入浏览器、构建制品、服务器进程或再分发包。
- 浏览器和服务器网络请求、数据字段、处理位置、Cookie/存储以及第三方接收方。
- 维护状态、已知漏洞、安全更新方式和升级责任。
- 资源占用、部署隔离、故障影响、备份以及替换或退出方案。
- 对应用户决策编号、需要履行的署名、许可证文本、源码提供或其他义务。

当前 `package.json` 与唯一 `package-lock.json` 已固定 D-073/D-076/D-079/E-013 的首轮图；`dependency-policy.json`、`dependency-license-evidence.json` 与 `dependency-admissions.json` 精确闭合 1,225 个 canonical identity。D-082 的两项传递 override、35 项 upstream immutable、11 项 tarball section、12 项 owner exception 与 29 项许可证决定已经进入正式证据；首次准入当时对 1,345 个非根物理记录的 audit 各级漏洞计数均为零，但 2026-07-26 最新 live audit 已观测到 18 个 high 依赖节点。D-099 使该结果不再阻断普通 CI，不表示漏洞已修复、已接受或可忽略；显式依赖变化仍须按下述准入闭环通过 audit。仓库已生成正式 SBOM/evidence/NOTICE，并完成 Node 24.18.0/24.16.0 双端点冻结安装与 composite receipt；根目录仍没有 `node_modules/`。D-097 至 D-102 的目标 CI 第一阶段已完成专题实现和 fresh 本地验收并正依 D-104 纳入 `dev`；#28 已完成真实 Chrome 验收，#33/#35/#14 已分别形成 release 封装、服务器 verifier 与 producer/upload 的仓库侧本地实现。尚未完成的是组合树远端 CI/required checks、canonical `main` 真实 artifact 与 30 天 retention，以及服务器 release 闭环。

### 首次依赖准入闭环

1. 只有 D-067/D-073 的主端点可以通过 E-010 的 `run-isolated-npm.mjs resolve-lock`，在全新临时 HOME、空 user/global npmrc、全新 cache 和官方 registry 预检通过后，按已批准 manifest 生成候选 `package-lock.json`；该阶段不得安装到正常工作树、继承用户 npm 配置或缓存、执行依赖代码或生命周期脚本。每次实际解析仍属于外部操作，执行前需要单独授权。
2. 候选图只允许来自官方 npm registry，拒绝 Git、`file:`、本地目录、任意远程 tarball 或其他来源。零第三方依赖策略脚本先检查直接清单、`lockfileVersion: 3`、来源，以及适用节点的 `resolved`、`integrity`、声明许可证和安装脚本标记；缺失、未知或冲突即失败。
3. 在正常安装前，按 lockfile 下载精确 tarball 但不执行其中代码或脚本，复核 integrity，并检查包内实际 `package.json`、`LICENSE`/`LICENCE`/`COPYING`、`NOTICE` 和生命周期脚本内容。许可证缺失、未知、推测性、复杂或未获准时暂停；生命周期脚本默认拒绝，确有构建必要性时必须以精确 `name@version`、脚本内容、风险和证据重新请求用户决定，禁止批量放行。
4. 许可证与脚本人工预审通过后，先把逐包用途、许可澄清、脚本处置、义务、证据摘要和条件决定写成尚未提交的预审 admissions；此时 schema 校验通过只证明字段与候选图闭合，不表示真实图已经最终准入。正式生成入口重新下载同一批精确 tarball，通过隔离 `sbom-native` profile 取得 npm 原生 SPDX 2.3 输入，再按 E-011 规范化易变时间、namespace 和无序集合；固定 npm 生成但不符合 SPDX 2.3 `idstring` 的 package ID 只做逐包证明、全引用一致且碰撞失败的语法合法化，重复物理路径产生的完全相同 relationship triple 在字段与引用验证后收敛为一个集合成员，native `licenseDeclared` 仅在为 `NOASSERTION` 时由同轮 integrity 已验证 tarball 的实际声明补足，任何非空声明冲突仍失败。上述兼容不改变 name/version/purl 或关系语义。随后生成 canonical 但尚未准入的确定性 SPDX JSON SBOM、evidence 与 `THIRD_PARTY_NOTICES`；显式生成命令只接受人工提供的 UTC 秒精度 `createdAt`，CI 和构建不得读取系统时间补齐。随后通过隔离 `audit` profile 运行包含开发依赖的全图审计。`moderate`、`high` 或 `critical` 阻断，`low` 必须报告但不自动阻断；禁止运行 `npm audit fix`，registry 或 audit 服务不可用时失败关闭。最终人工准入结论只能在该漏洞门禁通过后形成；audit 失败时不得提交预审 admissions 或三件套，也不得进入双端点安装。
5. `npm audit` 会向官方 npm registry 发送包名和版本；回退协议可能发送完整 lockfile 树以及 npm/Node/平台/架构/环境元数据。该构建期外发不包含站点文章源码、访问者、账户或评论数据，不产生浏览器外部请求。审计端点、协议或数据字段改变时重新评审。
6. 只有证据齐全、漏洞门禁与最终人工准入结论都通过后，主端点与最低端点才可分别通过 E-010 的隔离 `ci` profile，在各自全新 cache 上读取同一 manifest、lockfile 和项目 npm 配置。两个端点都必须通过执行前后哈希证明 `package.json` 与 `package-lock.json` 未改变；最低端点保持只读且不生成发布制品。workflow 不恢复 npm cache，也不得直接调用 npm 绕过隔离入口。

依赖事实所有权不得重复：`package.json` 只拥有直接依赖意图，`package-lock.json` 拥有完整解析图，人工准入记录只保存无法从二者稳定派生的用途、许可证澄清、脚本处置、义务和决策编号；SPDX SBOM 与 `THIRD_PARTY_NOTICES` 由 lockfile 和 tarball 证据生成并做漂移校验，不能成为人工维护的第二份依赖清单。SPDX evidence 额外保存规范器版本、语义摘要、显式 `createdAt` 和最终文件摘要；namespace 从省略自身后的 canonical 文档摘要确定派生，同一语义在两个空临时目录中必须逐字节一致。当前 admissions schema 和三件套都不保存独立的 audit/最终批准状态，因此最终图准入还必须由同一次受限 audit 证据、显式决定记录和双端点结果共同证明；不能仅因这些仓库文件存在或静态闭包通过就声称已经准入。首版策略实现使用 Node.js 内置能力，Ubuntu 的 `tar` 可作为系统工具；不把许可证扫描器、SBOM 生成器或 GitHub Dependency Review Action 作为首版必需工具，本决定也不授权将其作为可选补充引入。#21 已以真实 lock/tarball/audit、D-082 决定和双端点 composite receipt 形成首轮本地最终准入；D-097 至 D-102 已在专题分支接入普通 CI 的静态供应链证据、完整历史、零依赖本地质量与 production build 检查，并正依 D-104 纳入 `dev`，但不把 live audit 纳入普通 workflow。#14 已由本地提交 `7b5cc47` 接入 production artifact producer/upload，但尚未推送；组合树远端 CI、required checks 和真实 GitHub artifact 仍是发布链下游门禁，不反向改变既有准入结论。

### Docusaurus 许可边界

- Docusaurus 框架代码采用 [MIT License](https://github.com/facebook/docusaurus/blob/main/LICENSE)，允许商用、修改与分发，但分发副本或实质部分时需要保留原版权和许可文本；无需在页面显示 `Powered by Docusaurus`。
- Docusaurus 官方仓库中的文档采用单独的 [CC BY 4.0](https://github.com/facebook/docusaurus/blob/main/LICENSE-docs)，不能把教程、截图或示例文案当成框架代码许可范围内的本站原创内容。
- Docusaurus 名称和 Logo 受 [Meta Open Source Trademark Policy](https://opensource.fb.com/legal/trademark/) 单独约束；本站可以用普通文字作真实技术说明，但不把名称或 Logo 用作 Axial Muse 品牌、产品名或域名。
- Docusaurus 的 MIT 许可不覆盖 npm 传递依赖、社区插件、字体、图标、图片或第三方服务，也不决定 AxialMuseWebsite 自身源码和文章内容的许可证。
- MIT 文本没有 Apache-2.0 式独立、明确的专利许可条款；普通主站不因此暂停选型，未来融资、并购或高价值商业发行时应基于当时锁定版本做正式知识产权尽调。

## 内容格式边界

- 普通技术文章使用 Markdown，保持正文简单、可追溯和可迁移。
- Docusaurus 默认使用 MDX 编译管线处理 Markdown 与 MDX；M0 不启用其他解析模式。“Markdown 默认、MDX 受控例外”是本站的编辑和审核边界，不表示普通文章绕过框架编译管线。
- 框架选择包含 Docusaurus 标准静态页面所需的 React 客户端资源；自定义客户端组件、第三方脚本和外部 SDK 不在本次授权内。
- 只有文章确实需要专属展示或交互组件，且普通 Markdown 无法满足时，才使用 MDX。
- MDX 只能引用仓库内经过审核的组件，不能把任意组件或远程脚本作为内容依赖引入。
- 选择 MDX 不自动批准超出 Docusaurus 框架基线的组件库、自定义浏览器端 JavaScript、第三方服务或运行时 API。
- 未来经审核批准创建的本站可复用 React 组件遵守 D-074 并使用 `.tsx`，按 D-075 位于 `src/components/`；该目录只是通用展示层位置，不构成 MDX 导入白名单，也不批准交互能力或创建任何组件。
- Markdown 与 MDX 应服从同一套完整编辑模型和公开状态规则。
- D-036 已确定模型能力范围；D-037 已确定元数据与正文保持单文件并采用分组式 frontmatter。
- 少量核心字段位于顶层，复杂且可选的元数据按职责嵌套分组，不为每篇文章维护独立 sidecar 文件。
- 文章核心字段、SEO 描述回退、显式日期与“项目-模块-主题标签”组织规则保持不变。E-003 将作者、主题和项目模块分别固定到 `authors.json`、`topics.json` 与 `projects.json#writingModules`；无项目文章投影到“通用技术”，跨项目关系使用 `relations.projects` 且不改变规范归属。主题、作者、系列和归档不生成 M0 独立路由。

MDX 可导入组件的唯一白名单入口是 `src/components/mdx/index.ts`，普通 `src/components/` 组件不会自动开放。M0 白名单为空且不创建 MDX 文章；后续每个新增导出都必须记录用途、交互、外部请求、数据处理和静态失败退化，并接受机器门禁与评审，不安装额外 MDX 集成。

## 数据所有权边界

| 数据类型 | 目标真相源 | 当前状态 |
|---|---|---|
| 技术文章与项目正文 | `site-content/writing/` 和 `site-content/projects/` 中受审 Markdown/MDX | 文章 frontmatter 拥有文章领域字段；项目正文只拥有长文，项目结构化字段由 `projects.json` 拥有；构建期只读投影，不回写 |
| 项目、模块与主题注册信息 | `docs/contracts/projects.json` 与 `docs/contracts/topics.json` | 项目 ID、slug、公开事实、顺序和 `writingModules` 由项目注册表拥有；主题 ID、显示名与顺序由主题注册表拥有 |
| 作者注册表 | `docs/contracts/authors.json` 的对象型 ID 映射 | 稳定作者 ID 为键；`displayName` 必填，`links.github` 对新增作者可选 |
| 构建产物 | GitHub Actions `production-artifact` 对精确 SHA 在 fresh runner 重建并重验的静态 payload 与服务端 301 派生配置 | Docusaurus production build、E-014/E-015 release 封装和 #14 producer/upload 已有仓库侧实现；尚无 canonical `main` 的真实 Actions artifact 或生产发布 |
| 全局账户 | 未来中央身份服务的数据边界 | 不收集账户数据 |
| 技术分享评论 | 未来评论服务的数据边界 | 不收集评论数据 |
| 项目业务与上传数据 | 对应项目服务自己的数据边界 | 不提供公共试用 |

不同服务不得通过共享数据库表实现耦合。未来服务间如何交换用户标识、权限和删除事件，需在身份与数据契约设计中另行确认。

## 路由与项目边界

主站负责提供项目目录和跳转入口，项目介绍与未来试用服务保持不同职责：

- 当前项目只展示真实说明、源码和已准备好的演示材料。
- 当前不创建尚未批准的试用按钮、登录入口或动态 API。
- 未来每个项目可以拥有独立入口、前端、API、数据存储和发布周期。
- 一个项目上线或故障时，不能要求重新部署其他项目或中央身份服务。
- 主站固定使用 `/projects/`、`/projects/<project-slug>/`、`/writing/` 和 `/writing/<article-slug>/` 承载目录与详情。
- 项目介绍位于主站 `/projects/<project-slug>/`，保持可索引的背景和技术内容。
- 项目真正提供试用并另行批准后，才启用 `https://<project-slug>.axialmuse.com/`。
- 当前不创建项目试用 DNS、证书或入口。

### Slug 与稳定 URL

- 项目 slug 与文章 URL 的语义尾段由作者手工确定，不从标题、日期、分类或系列自动生成。
- 技术文章必须在 frontmatter 顶层直接填写 Docusaurus 原生根相对完整 `slug`，例如 `/writing/dependency-inversion`；该字段是文章公开 URL 的唯一真相源。
- 单一 docs 实例使用 `routeBasePath: '/'`，默认解析结果中的文章 `slug` 原样参与路由，不再由适配器补写 `/writing/`。
- 文章文件名和目录只服务仓库组织，不生成或覆盖公开 URL。
- 项目、模块或主题关系发生变化时不得修改或重新生成文章 slug、canonical URL 或公开 URL。
- 项目 slug 与文章 `<article-slug>` 尾段只允许小写 ASCII 字母、数字和连字符；文章完整字段额外包含固定的 `/writing/` 路径结构。
- URL 不增加日期、分类或系列层级。
- slug 在首次发布前确认，发布后保持稳定。
- 确需修改时，旧 URL 必须永久重定向到新 URL，并同步 canonical URL 与站点地图。
- 项目 slug 逐项目登记；`docrestore` 已作为 DocRestore 的示例和目标标识。

精确重定向清单由 `docs/contracts/redirects.json` 保存；E-014 禁止生成会返回 200 的静态跳转页。release 封装器从同一 production `build/` 的公开页面集合派生注册表 301 和无尾斜杠 canonical 301，以确定性运行清单与 Nginx exact-location 配置绑定同一 payload；源重复、目标缺失、活动路由冲突、链、环或静态 source 页面都会失败。服务器在 reload 前把候选的全部规范 200 路径和新增或改指的 registered 301 边只追加到 URL 暴露账本；`canonical-slash` 不单独入边账本，但其 target 已由规范路由预写保护。候选及回滚必须使历史 source 与历史 target 仍收敛到同一当前 200，不能以“目标文件存在”替代该闭包。首次发布新 canonical URL 时，旧 release 通常没有该 target，因此通常只能在单独生产授权下 forward-only 激活。

## 内容详情页布局方向

文章正文页和项目介绍页使用相同的文档站式三栏信息结构：

- 顶部导航负责全站级跳转。
- 文章页左栏显示技术分享目录，项目页左栏显示项目目录，并高亮当前内容。
- 中栏显示当前文章或项目介绍正文。
- 右栏主要显示当前页面 `H2/H3` 标题导航，可在下方显示少量已批准的上下文元数据。
- 短页面没有足够标题时不制造目录，可只显示已有元数据或留空。

文章左栏必须由单一规范组织归属生成：有模块时落在所选项目的该模块下，只有项目时落在项目根级，两者均为空时落在“通用技术”。跨项目相关关系不得让同一文章在多个项目侧栏重复出现。排序固定为“通用技术”优先，再按项目 `navigationOrder`、模块 `navigationOrder`、文章 `publishedAt` 降序和 `articleId` 升序兜底。

目录排序和右栏元数据受后续内容模型约束，不能为了填满侧栏新增未批准字段。D-034 固定渐进式折叠：

- 宽屏显示完整三栏。
- 中等宽度保留正文和右侧标题导航，左栏改为正文上方默认收起的“浏览本栏目”。
- 窄屏使用单栏，“浏览本栏目”和“本页目录”均在正文上方默认收起。
- 优先使用原生可访问折叠控件，不使用遮挡正文的抽屉。
- 首版标题导航只使用静态锚点，不增加依赖客户端 JavaScript 的滚动高亮。
- 精确断点为 `>=1280px` 三栏、`996-1279px` 左栏折叠且保留右栏、`<996px` 两个目录均折叠到正文上方，并通过真实浏览器截图复核。

## 故障与变更隔离

- Docusaurus 构建失败：阻止新静态 release，不影响上一版已发布主站。
- 主站内容错误：只处理主站同版本 payload/301 release，不迁移账户或项目数据库；普通错误只有在 fallback 使 URL 暴露账本全部历史路径仍收敛到当前 200 时才可整版回滚，否则必须保持闭包并向前恢复。
- 身份服务不可用：未来账户操作失败，但公开静态内容仍可阅读。
- 评论服务不可用：未来评论不可加载或提交，但文章正文仍可阅读。
- 单个项目不可用：主站和其他项目继续工作，并能独立隐藏或标记该体验入口。

M0 没有运行时应用服务调用，因此不设计 API 超时、重试或客户端状态探测；构建失败保留上一 release，Nginx reload 与 HTTP 冒烟按 E-014 独立失败关闭，项目体验入口只根据经审核注册表显式显示。未来动态服务的降级文案、探测和重试在对应能力获批时独立设计。

## 安全与隐私边界

- 当前静态阶段不新增账户、评论、表单、分析或上传数据采集。
- Git 仓库和静态产物不能包含密钥、私密账户数据或项目后端凭证。
- 浏览器自动请求第三方或境外 origin 会形成独立数据路径；普通外链与自动加载的脚本、图片、iframe、SDK 或 API 请求必须区分，后者未经单独决策不得引入。
- 未来身份、评论和项目服务分别建立最小权限、日志、备份和数据删除责任。
- 跨子域名会话、Cookie 范围、认证协议、CORS 和 CSRF 防护必须在身份设计中确认。
- 评论字段、公开范围、审核、举报、删除、导出和保留周期必须在评论设计中确认。

## 已接受的影响

### 收益

- 内容发布与动态服务解耦，主站可以保持简单的静态生产请求链路。
- Docusaurus 提供文档页面、侧栏、标题目录和 React 扩展基础，减少自研通用文档站能力。
- 账户、评论和项目服务可以分别选择技术、扩容、维护和回滚。
- Git 保存内容变更、审核和发布时间线，不需要当前维护 CMS 账户与数据库。

### 代价

- Docusaurus 引入 React 客户端资源、前端构建依赖、升级和供应链维护责任。
- 每次新增或升级依赖都增加许可证、传递依赖、NOTICE、漏洞、网络请求和退出路径的审查责任。
- 多个独立服务未来需要清晰的身份、API、错误处理和运维契约。
- Git 发布适合当前单一作者，但不等同于浏览器中的内容后台。
- 解耦不能消除跨服务设计；统一账户和数据删除仍需协议与治理设计。

## 实施门禁

[主站编码规范 Spec](../engineering/main-site-coding-spec.md)是实现、测试和评审的工程入口。D-078 授权范围内的内部 API、命名、脚本路径、schema 代码、边界检查、测试 fixture、错误格式和 CI job 拆分，由实现者依据本架构形成最小可验证闭环，不再逐项请求用户选择；任何工程选择都必须可追溯到 D-xxx/E-xxx、在代码前落入对应 Spec，并以自动化或真实浏览器证据验证。

进入 Docusaurus 代码迁移前仍须完成：

- 复用 #21 已验收的 D-077 零第三方依赖策略、唯一 lock、精确 admissions、正式三制品和双端点结果；不得重新解析或改写依赖图，任何新增或升级先重新准入。
- 继续把 E-001 至 E-016 转化为安全扫描投影、路由检查、主题 fit-gap、侧栏/SEO、素材白名单、局域网候选切换、完整 Git 历史、同版本服务端 301、production build 字节闭包、静态构建和 artifact 制品检查；隔离 npm 与 Node 24 双端点已由 #9 验收，确定性 SPDX 已由 #10 验收，Node ESM 测试已由 #11 验收，内容解码与领域核心已由 #23 验收，两份真实项目正文已由 #5 验收，媒体与静态素材门禁已由 #6/#7 完成远端闭环，#26 已完成内容装配远端闭环，#27 已完成页面与公开表达远端闭环，#28 已完成主题 fit-gap 与真实浏览器验收。#12 历史门禁、#24 作者事务和 #32 workflow 已完成专题实现与本地验收并依 D-104 纳入 `dev`，组合树远端 CI 仍待精确 SHA 取得；#13/#33/#35 已形成 release 输入、封装和服务器 verifier，#14 producer/upload 已由本地提交 `7b5cc47` 完成。其余由 #8、#14 的真实 artifact 验收及 #36/#37 跟踪。
- M0 主站 Spec 已经是 Docusaurus 多页面实现基线；内容所有权、媒体与素材隔离、草稿预览、供应链确定性、Node ESM 测试、完整 Git 历史、服务端 301 和 production artifact 结论已经同步。实现后仍须以 360、768、1024、1440 px 真实截图验证三栏折叠、首页、目录页和详情页。

以下边界不属于 D-078 委托，仍须单独确认或现场核验：新增或变更 npm/Action 的真实依赖图及许可证/脚本例外；GitHub 仓库能力与 Secret；服务器、CAM/TAT、DNS、证书和生产发布操作；公开业务事实、真实截图与法律合规；浏览器第三方请求、费用、账户、评论、用户数据和项目在线体验。M0 不实现系列、主题/作者独立页、归档、筛选、分页、RSS、搜索或独立 `/about/`，出现真实需求时再进入产品决策。

## 当前设计验收

- 已明确 Git 是内容编辑与审核边界，静态产物不是人工编辑源。
- 已明确 Docusaurus 只在构建阶段运行，生产主站不运行 Docusaurus 或 Node.js 服务。
- 已固定 Docusaurus 官方静态能力、现有 PlantUML 静态图表链路、Nginx/Certbot、GitHub Actions/TAT 和 Ubuntu/systemd 原生运维的首版职责组合。
- 已固定 CI 与发布必须覆盖的质量和供应链能力类别、独立 `tsc --noEmit` 与 Docusaurus build，以及 D-077 的首次依赖准入协议；E-005 固定 GitHub Actions 构建默认 `build/`、不可变 artifact 和生产服务器只校验/解包的交付边界，E-014 要求服务端 301 配置与同一 payload 整版激活，E-015 要求 `production-artifact` 在同一 fresh runner 重建、复验、封装并输出唯一 artifact 身份，同时以 root-owned 只追加 URL 暴露账本约束历史 source/target 收敛、兼容 fallback 与 forward-only 恢复。
- 已明确 Docusaurus 管理的目标源码使用显式严格 TypeScript，配置、侧栏、本地插件与适配使用 `.ts`，包含 JSX 的页面、主题覆盖和 React 组件使用 `.tsx`；现有 `.mjs` 质量脚本与未来作者 CLI 不在该迁移范围。
- 已明确开源依赖按浏览器产物、独立服务、工具和素材分层准入，宽松许可证优先不等于具体依赖自动获批。
- 已明确浏览器第三方请求和境外数据路径无论软件许可证为何都必须单独决策。
- 已明确主站、身份、评论和项目服务的逻辑职责互不替代。
- 已明确当前不部署动态服务，也不公开尚未上线的能力。
- 已明确文章默认 Markdown、MDX 受控例外，并限制 MDX 只能引用仓库内经过审核的组件。
- 已明确主站项目/文章路由与未来试用子域名的职责分工。
- 已明确内容详情页采用左侧目录、中间正文、右侧辅助区的三栏方向。
- 已明确文档站式侧栏职责：左侧同类内容目录，右侧当前页面标题导航与少量上下文。
- 已明确三栏使用渐进式折叠，窄屏不保留并排侧栏或遮挡正文的抽屉。
- 已明确项目与文章使用手工英文语义 slug，并通过永久重定向维护已发布 URL。
- 已明确技术文章采用完整编辑模型，同时保留精确字段结构与校验规则的决策门禁。
- 已明确技术文章采用分组式 frontmatter，正文与元数据保持单文件，不引入文章级 sidecar 文件。
- 已明确技术文章使用顶层原生完整 `slug` 作为公开 URL 的唯一真相源，单一 docs 实例使用根 `routeBasePath`，文件路径不参与路由生成。
- 已明确技术文章使用必填顶层字段 `publicationStatus` 表示发布可见性，不复用含义宽泛的生命周期状态。
- 已明确文章发布状态为 `draft`、`published`、`archived`，并把 `planned` 保留在文章集合之外。
- 已明确技术文章通过必填 `authors` ID 列表引用 Git 作者注册表，且作者身份不等于账户或编辑权限。
- 已明确作者注册表是以稳定作者 ID 为键的单一 JSON 对象，不使用每位作者独立文件。
- 已明确本站首个稳定作者 ID 为 `lyty1997`，作者 ID 与显示名、外部账号、品牌和账户身份分离。
- 已明确作者公开显示名与稳定作者 ID 分离，首个作者暂以 `lyty1997` 署名。
- 已明确作者注册表首版不增加简介、头像或其他社交字段，只登记公开显示名与 GitHub 链接。
- 已明确技术文章只维护一份默认摘要，SEO 例外通过固定回退、机器检查和人工复核控制漂移。
- 已明确文章日期保存在 Git 内容中，发布服务器时间不成为文章元数据。
- 已明确目录按项目、模块和主题标签组织，不引入主分类或分类层级 URL。
- 已明确文章只有一个规范目录归属：项目与模块均可为空且各最多一个，模块必须隶属所选项目；无模块时归入项目根级，无项目和模块时归入独立通用分组。
- 已明确主题必填 1-5 个受控 ID，跨项目文章只选一个主项目，其他项目关系不造成多个项目侧栏重复；组织重分类不改变文章 URL。
- 已明确必填 `classification` 是项目、模块和主题字段的唯一组织真相源，不在 frontmatter 顶层或其他分组复制这些字段。
- 已明确 D-059 以原生字段精确直用和两个必要内存派生重新确认 D-056，D-060 以独立的 `writing/` 子树重新确认技术文章类型判据，D-061 把该边界锚定到仓库根 `site-content/writing/`，D-062 固定每文独立源码目录和唯一正文入口，D-063 固定人工稳定可读的 `<source-name>` 格式与受控重命名规则，D-064 固定 UUIDv7 articleId、源码相对文章链接、侧栏身份引用方向及显式日期的未来构建期索引绑定，D-065 固定作者显式仓库 Node.js 创建入口与一次性 ID 写入，D-066 固定 Node 24 LTS 目标工具链、原生 UUIDv7 后端与非严格递增语义，D-067 固定精确执行版本源、最低版本兼容验证和升级治理，D-072 固定 Linux 作者执行环境与 Ubuntu-only CI，D-074 固定 Docusaurus 目标源码的严格 TypeScript 边界与独立类型检查/构建门禁，D-075 固定标准入口目录、跨层公共入口、导出和路径别名边界，D-076 固定首轮直接依赖和 `tsconfig` 基线，D-077 固定首次依赖准入协议，D-080 落地不改变系统默认版本的本地作者 nvm/Node 24 与 hook；D-067/E-010/E-011、#21 的真实图准入与 D-080 作者环境已实现。D-097 至 D-102 已实现历史检查器、pre-write 候选 API、临时 Git DAG fixture、Ubuntu CI 版本门禁、静态供应链与零依赖本地质量入口；#24 文章创建命令与作者入口集成也已完成专题本地验收。三项正依 D-104 纳入 `dev`，组合树远端 CI 与 Issue 证据仍待取得。
- 已通过 D-079/E-012 固定 `@types/node` 的直接开发依赖、独立 NodeNext 测试 program、临时 ESM emit、运行时 `.js` 说明符、`node --test` 和双 Node 端点同负载；依赖已随 #21 准入，配置、runner 与 fixture 已由 #11 实现并远端闭环，D-097 至 D-102 已完成目标 Node 24 CI 迁移的专题实现与本地验收，现依 D-104 纳入 `dev`；组合树远端运行结论仍待精确 SHA 取得。
- 已通过 E-013 固定 Docusaurus 官方公共 frontmatter 解码入口及其直接开发依赖、`HEAD` 可达祖先范围、lineage 父状态 ledger、Git 2.43 协议隔离、partial/promisor/alternate object store 与浅仓库/缺失对象失败关闭、PR merge ref 和完整 checkout；依赖已随 #21 准入，结构化解码适配已由 #23 实现，历史检查器、临时 Git DAG fixture 与 CI 接线已由 D-097 至 D-102 实现并本地验证，#24 作者候选与终态历史集成也已完成专题本地验收；三项正依 D-104 纳入 `dev`，组合树远端 CI 与 Issue 证据仍待取得。
- 已通过 D-078 区分工程委托与用户门禁：M0 内部实现细节由 Agent 查证、落盘并验证，后续外部操作或依赖变更、基础设施、公开事实、数据和未来动态能力仍不得自行扩张。

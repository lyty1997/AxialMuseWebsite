# 主站体验与内容架构

状态：active
最近更新：2026-08-04
适用范围：M0-M2 主站定位、信息架构、内容模型、页面体验与 SEO

## 目的

本文定义访问者如何理解 Axial Muse、如何找到项目与技术分享，以及 Docusaurus 多页面主站的内容职责。迁移前单页只作为当前实现事实；生产发布见 [域名与生产发布](../operations/domain-deployment.md)。

M0 的页面级结构、文案状态、设计令牌、素材、响应式和 Definition of Done 见 [M0 主站实现 Spec](m0-main-site-spec.md)；本文继续作为 M0-M2 产品与信息架构基线。

## 产品定位

Axial Muse 是一条规划中的项目产品线，名称取意于轴心时代涌现的大师与为生活带来美好的 Muse。当前主站仍以个人项目和技术复盘为可信内容基础，并通过 D-141 固定“用全栈技术 + AI，让所有人用上好用的工具，实现生产力平权”的公开愿景。愿景表达建设方向，不把计划中的产品服务描述为已交付能力。首版承担三项职责：

- 让首次访问者在第一屏理解网站主题和当前阶段。
- 用可验证的项目记录展示问题、取舍、实现和复盘。
- 为后续文章体系与产品服务保留稳定入口，但不把计划能力描述为现有能力。

首版不是泛内容聚合页、商业落地页或个人履历堆叠页。页面价值来自真实项目、工程细节和持续更新，而不是宣传性承诺。

## 目标访问者

| 访问者 | 首要问题 | 首版应提供的答案 |
|---|---|---|
| 技术同行 | 这里在研究和构建什么 | 项目摘要、技术取舍、代码或原始资料入口 |
| 潜在协作者 | 是否值得进一步交流 | 作者关注方向、项目状态、可核验成果 |
| 从文章进入的读者 | 这篇内容属于什么上下文 | 所属项目、系列、更新时间和相关内容 |
| 未来产品用户 | 是否已有可使用的服务 | 只展示真实可用状态；计划内容明确标注阶段 |

## 信息架构

### 迁移前的单页骨架（历史）

以下结构只记录迁移前 `public/` 单页骨架的历史职责，不描述当前 Docusaurus 源码或 production build 状态：

1. **首屏**：品牌名、简短定位、一个主要浏览入口。
2. **项目** `#projects`：展示 2-4 个有事实依据的项目条目。
3. **技术分享** `#writing`：展示已发布内容；没有正式文章时显示真实的准备状态，不制造占位成果。
4. **路线** `#roadmap`：区分当前、下一步和探索方向。
5. **关于** `#about`：说明作者关注领域、本站边界和外部公开身份入口。

D-141 将当前主站外壳改为两层：第一层显示品牌 Logo、名称和本地搜索；第二层固定为带图标的“首页”“项目介绍”“踩过的坑”，分别链接 `/`、`/projects/`、`/writing/`。既有 canonical 路由不因展示名称改变。导航不加入“产品服务”、登录或注册，直到对应服务完成边界、数据与隐私说明并具备真实入口。

### 项目体验入口

- 已具备可用体验的项目使用 `https://<project-slug>.axialmuse.com/`。
- 项目条目只有在 [项目体验注册表](../contracts/project-experiences.json) 状态为 `live` 且健康检查通过时显示“在线体验”。
- “在线体验”链接直接进入项目子域名，不使用 iframe；体验页提供返回主站项目说明的入口。
- `planned`、`provisioning`、`paused` 或 `retired` 状态不显示可用体验按钮，避免把计划或故障状态表达成已交付能力。
- 子域名命名、DNS、证书、发布、隐私和下线规则见 [项目体验子域名架构](../architecture/project-experience-hosting.md)。

### 项目演示视频

- 不提供在线体验的项目仍可展示项目说明、公开仓库和经过审核的演示视频；“查看源码”“观看演示”和“在线体验”是三个不同动作，不混用文案。
- 视频使用原生 `<video>` 控件，不自动播放、不使用第三方 iframe，默认只预加载元数据，并提供封面、字幕和文字摘要。
- 视频、封面和字幕未全部就绪时不显示播放器或占位按钮，项目说明与仓库链接仍可独立发布。
- 演示素材只使用可公开样例，发布前逐帧检查凭证、路径、IP、通知、个人信息和第三方版权内容。
- DocRestore 在主站首次上线时只展示公开仓库，演示视频作为素材完成后的增量增强；`docrestore.axialmuse.com` 只保留名称，不创建 DNS 或体验入口。详细契约见 [DocRestore 项目展示与未来体验设计](../projects/docrestore-experience.md)。

### 已确认的多页面路由

D-031 固定主站展示与未来项目试用的 URL 职责。主站承载可索引的项目说明和技术内容；项目真正具备试用能力并另行批准后，才启用独立子域名。

| 页面 | 路由约定 | 作用 |
|---|---|---|
| 首页 | `/` | 品牌入口、精选项目、最新内容 |
| 项目列表 | `/projects/` | 浏览项目 |
| 项目详情 | `/projects/<project-slug>/` | 背景、取舍、成果、复盘、相关内容 |
| 技术分享列表 | `/writing/` | 浏览技术分享 |
| 技术分享详情 | `/writing/<article-slug>/` | 完整正文和内容元数据 |

D-031 已确认这些页面职责与路径命名空间；E-002 进一步固定 `trailingSlash: true`，表中的末尾 `/` 现在属于 canonical URL 契约。内容源中的文章完整 `slug` 和项目短 slug 不保存末尾 `/`，构建链接、canonical、sitemap 与 Nginx 永久重定向统一输出末尾 `/`。E-014 要求 release 封装器从同一 production payload 的实际公开页面派生无斜杠 301，不能依赖静态目录服务的隐式行为。

M0 不提供 `/series/<slug>/`、`/about/`、作者、主题、归档、筛选、分页、RSS 或独立搜索结果路由。D-141 只增加页头纯本地搜索：它在浏览器内对同批 `published`/`archived` 安全展示投影的项目和文章标题、摘要做即时匹配；不索引草稿或计划内容，不发送查询、不持久化、不设置 Cookie，也不依赖第三方服务或后端。

D-035 与 D-058 共同固定当前 slug 规则：

- 项目 slug 与文章 `<article-slug>` 路径段由作者手工确定，不从中文标题、日期、分类或系列自动生成。
- 项目 slug 与文章路径尾段只允许小写 ASCII 字母、数字和连字符，不使用中文、拼音自动转换、空格或下划线。
- 发布前完成确认，发布后保持稳定。
- 确需修改时，为旧 URL 配置永久重定向并同步 canonical URL 与站点地图。
- 项目 slug 逐项目登记；例如 DocRestore 使用 `docrestore`。

D-038 原先确认技术文章必须在 frontmatter 顶层显式填写 `slug`，并以它作为文章公开 URL 的唯一真相源。D-058 保留该原则，但把字段值改为 Docusaurus 原生根相对完整路径，例如 `slug: /writing/dependency-inversion`；单一 docs 实例使用 `routeBasePath: '/'`，不再从短文章标识派生栏目路径。文章文件名和目录不参与路由生成。E-002 要求构建在规范化尾斜杠后检查 pages、docs、静态资源和精确重定向的全站唯一性；已发布 slug 变更必须登记无链无环的永久重定向。E-014 进一步把登记 source 及其无斜杠别名直接指向同一 release 中实际存在的最终 200 页面，不生成静态跳转页。生产暴露账本保存已发布路径和历史 301 边；后续迁移必须让每个历史 source 与曾被缓存的历史 target 仍收敛到同一个当前 200 终点，不能用只含目标文件但丢失旧规则的 release 回滚。


项目子域名只表示实际体验，不承担主站项目介绍：

- 项目介绍：`https://www.axialmuse.com/projects/<project-slug>/`。
- 未来项目试用：`https://<project-slug>.axialmuse.com/`。
- 当前没有已批准的试用服务，不创建项目子域名 DNS、证书或“在线体验”按钮。

### 内容详情页三栏方向

D-032 确认三栏信息结构，D-033 进一步确认文档站式职责：

D-054 进一步确认项目介绍与技术文章由同一个 docs 内容实例承载，但分别关联项目侧栏和技术分享侧栏；首版不启用 blog，也不使用第二个 docs 内容实例。这只固定内容拓扑，不改变下列页面职责或两类内容各自的领域模型。

D-055 进一步确认技术文章的领域内容模型是唯一可编辑真相源；与领域语义完全一致的 Docusaurus 原生字段可以直接使用同一源值，其余字段只有在构建期单向派生。E-001 对项目采用同一防漂移原则：`projects.json` 拥有结构化事实，`site-content/projects/<project-id>/index.md|index.mdx` 只拥有长文，构建内存从注册表派生框架 title、description、完整项目路径和草稿行为，项目正文不得复制这些字段。

D-056 曾确认技术文章通过 Docusaurus 官方 `markdown.parseFrontMatter` 调用仓库内纯投影函数。D-058 证明 `slug` 可以直接使用原生字段后，该执行点被重新开放评审；D-059 随后以更小职责重新确认它：默认解析后的 `title` 与完整 `slug` 原样使用，只在构建内存中从 `summary` 派生原生 `description`，并在 `publicationStatus` 为 `draft` 时派生原生 `draft: true`。投影不修改正文、源 frontmatter 或文件，也不生成临时内容树。

原生 `description` 是供 Docusaurus 原生消费者使用的公共默认摘要，值始终等于 `summary`，不是应用 SEO 覆盖后的最终页面描述。`seo.description` 与 `seo.socialDescription` 继续保留各自的领域职责，不参与该派生；后续页面元数据必须分别实现 D-046 的两条回退链，并保证目录摘要仍来自 `summary`。`authors`、`publishedAt`、`updatedAt` 与 `classification` 保持领域字段，不映射为 `last_update`、`tags` 或 blog 字段；不启用 `unlisted`、原生标签路由或作者页。

D-057 曾把相对未来 docs 内容根的 `writing/` 子树设为技术文章类型边界，并与 D-056 的全局解析分流绑定；D-058 后该组合被重新开放评审。D-060 独立重新确认目录判据：规范化后相对未来 docs 内容根位于 `writing/` 子树内的 Markdown/MDX 是技术文章候选，边界内每个候选都必须通过技术文章 schema，不能因字段缺失或非法而退回普通 doc。D-061 随后把该内容根固定为仓库根 `site-content/`，因此当前文章候选边界为 `site-content/writing/`。D-062 再确认每篇文章使用 `site-content/writing/<source-name>/` 独立源码目录，并以 `index.md` 或 `index.mdx` 之一作为唯一正文入口；D-063 将 `<source-name>` 固定为作者手工确定、稳定可读且满足 1-64 字符 lowercase kebab-case 约束的源码目录名，并规定发布前受控改名、发布后仅在明确授权的纠错迁移中改名；D-064 为每篇文章增加不可变 UUIDv7 `articleId` 领域身份，并确认源码相对文章链接、基于 `classification` 与当前 `docs[].id` 的侧栏派生方向，以及显式日期的未来构建期索引绑定；D-065 将新文章创建固定为作者显式运行仓库内 Node.js 命令，并在创建唯一正文入口时一次性写入 articleId；D-066 将目标工具链固定为 Node 24 LTS，并选择原生 `randomUUIDv7()` 作为非严格递增的生成后端；D-067 再固定 `.nvmrc` 唯一精确执行基线、`engines` 兼容边界、最低端点兼容验证和受控 patch 升级治理；D-072 规定这些作者 Node.js 命令只在 Linux 执行环境运行并由 Ubuntu CI 验证。边界外只表示“不是技术文章”，不能自动解释为项目内容。

`site-content/writing/` 边界独立于 D-059 的投影、公开 URL、侧栏归属和排序；schema、投影和所有消费者必须复用同一判型结果。articleId、文章路径、`<source-name>`、完整 `slug`、分类和当前 doc ID 各自独立。文章不填写原生 `id`，正文使用带扩展名的源码相对链接，侧栏生成器消费当前 `docs[].id`。生产只包含 `published` 与 `archived`；E-009 的静态 development-mode 预览在独立“草稿”分组显示 draft，全站 `noindex, nofollow`、无 sitemap，并且不能成为发布制品。候选失败保留上一活动预览，精确 Docusaurus 版本的 draft 行为由 fixture 验证。E-003/E-004 已固定注册表、排序和响应式投影；公共 API、错误和 fixture 的实现契约见[主站编码规范 Spec](../engineering/main-site-coding-spec.md)。

- 顶部导航负责项目、技术分享等全站级跳转，不与左侧目录重复承担同一职责。
- 文章页左栏显示技术分享目录；项目页左栏显示项目目录；当前内容在目录中保持清晰高亮。
- 中栏显示当前文章或项目介绍正文，是页面主要阅读区域。
- 右栏以当前页面自动生成的 `H2/H3` 标题导航为主，可在下方显示更新时间、所属项目、GitHub 仓库等少量上下文元数据。
- 短页面没有足够标题时不制造无意义目录，可以只显示已有元数据或留空。

项目侧栏与项目列表共用 `projects.json` 的 `navigationOrder` 升序，只包含 `published` 与 `archived`。技术分享侧栏先显示“通用技术”，再按项目顺序分组；项目根级文章先于模块，模块按自身 `navigationOrder` 升序，叶组内按 `publishedAt` 降序和 articleId 升序。topics、相关项目、推荐和物理路径不产生第二个侧栏位置。开发预览的 draft 只进入末尾独立“草稿”组。D-034 固定渐进式折叠策略：

- 宽屏显示完整三栏。
- 中等宽度保留正文与右侧标题导航，左侧目录改为正文上方默认收起的“浏览本栏目”。
- 窄屏使用单栏，“浏览本栏目”和“本页目录”都在正文上方默认收起。
- 优先使用原生可访问折叠控件，不使用遮挡正文的侧滑抽屉。
- `>=1280px` 显示完整三栏；`996-1279px` 折叠左栏并保留右侧标题导航；`<996px` 把两个目录都放到正文上方的可访问折叠区。实现后仍以真实浏览器截图检查正文宽度和无重叠。
- “抽屉”只指 Docusaurus 全局移动导航；项目目录和技术分享目录始终留在详情正常文档流中，不能注入该抽屉。浏览器分数视口不得在相邻断点之间留下目录不可见空档。
- 首版标题导航使用静态锚点，不增加依赖客户端 JavaScript 的滚动跟随高亮。

### M2：产品服务

只有在目标用户、核心问题、服务边界、隐私边界、支持入口和商业化假设均有设计记录后，才能增加 `/services/` 及详情页。讨论、评论、订阅、登录和支付不随页面结构自动引入，分别做独立决策。

### 品牌、首页与公开简介

D-142 覆盖 D-141 的首版 Logo 视觉：标志使用无底框的几何字母 A 表达 Axial，以贯穿字形的青绿色中轴表达稳定能力，以顶部星芒表达 Muse 带来的灵感；只保留石墨色与低饱和青绿色，不再使用轨道、紫色辅助色或深色方形底。第二层三个内容标签的文字、图标、悬停与激活态使用同一青绿色色系，通过饱和度和明度区分状态。D-143 进一步要求首页“品牌含义”和“关于我”等信息块不使用石墨黑底，统一为白色至低饱和青绿色的亮色表面；深色仅保留给正文与需要明确层级的操作元素。标志仍是仓库原生 SVG，不引入远程字体、图标库或第三方脚本。首页首屏突出上述愿景，并继续用真实项目和文章支撑公开表达。

首页底部“关于”使用用户提供的公开简介：作者是一名全栈工程师，覆盖人工智能、系统架构、底层驱动、硬件设计、机械工程、制造工艺，曾在达摩院做系统开发；关注 AI 工程、前沿科技，正在进行多个个人项目开发。本站分享公开项目、技术取舍与复盘，不公开凭证或私有仓库。公开联系入口为 `mailto:lyzimin@outlook.com` 与 `https://github.com/lyty1997`，仅使用克制的 CSS 微动效并尊重 `prefers-reduced-motion`；不得据此扩写履历、客户、成果或未交付能力。

D-144 收口首页重复入口：首页只保留品牌愿景、品牌含义和“关于我”，不再重复展示“项目介绍”“踩过的坑”目录区块，也不再在首屏放置同目标 CTA；两类内容的唯一全局入口是页头第二层标签。GitHub 个人主页只在“关于我”的联系方式中保留一次，页脚仅保留备案链接与版权。

D-145 记录本地视觉审核结果：D-142 的首版几何 A 标志未获用户通过，不能作为最终品牌资产。下一版先提供多组相互独立的仓库原生 SVG 候选，在导航栏实际尺寸与 favicon 小尺寸上共同比较；用户选定前不得替换正式 `assets/brand/axial-muse-mark.svg`，候选也不得进入 production 静态素材。

D-147 已完成候选选择并覆盖 D-142/D-143 的旧视觉：Logo 以 A“轴心之门”为母形，精修为圆润的“光隙 A”，由连续双腿、微弧横梁和中央透明切口组成；A 的顶点与轮廓承担第一识别，光隙表达轴心和灵感，不再添加独立中轴线、星芒或底框。品牌资产保持透明底原生 SVG，以深品牌蓝和交互蓝组成双色标志；页面统一使用米黄色底、暖白内容表面、蓝色导航与交互状态，正文和次要文字使用带蓝相的深色中性色。全站仍只提供亮色主题，不新增远程字体、图标库、第三方脚本或浏览器外部请求。

D-148 继续覆盖 D-147 的标志造型：两座书架式科学大门以低机位仰视透视构成开放顶部的 A，米金弧形流星下移到中下部作为横梁，星芒位于流星头部；铺满画面的深蓝银河繁星只承担品牌背景，不绘制星盘、星座或连线。银河、书架和流星统一使用克制的立体插画质感与蓝米金配色。正式资产按 `clean-vector-redraw` 流程，以颜色分层、连通轮廓提取、平滑和 RDP 简化忠实重绘确认原图，不再用手工简化改变构图、材质或细节；清理后只包含可见矢量图形，不含嵌入位图、外部引用、生成器或编辑器元数据、注释、隐藏图层或不可见追踪图形，并继续同时服务页头 Logo 与 favicon。

D-149 覆盖 D-148 的矢量交付形式：自动矢量化会损失星云、书脊和金属边缘的连续层次，并产生明显色块和噪点，因此正式 Logo 改为保留确认原图完整像素的 1254 × 1254 PNG，只移除 `caBX` 及关联的非图像元数据。净化前后解码像素必须逐像素一致；页头和 favicon 继续共用同一登记资产。

D-150 覆盖 D-149 对旧位图构图的选择：正式 Logo 使用用户本次选定的 1254 × 1254 方形 PNG，以深蓝星空和金色天体网格铺满背景，两座金木色书架式大门形成开放顶部的 A，青蓝与米白弧带穿过中部并在右上形成星芒。文件保持用户提供的原始解码像素和压缩字节，页头与 favicon 继续共用同一登记资产。

D-151 以用户再次选定的同构图新版 PNG 覆盖 D-150 正式字节：两侧书架主体改为更明亮的米金色，深蓝星空、金色天体网格、开放 A、青蓝与米白弧带和右上星芒保持不变。页面布局与品牌资产路径不变，页头与 favicon 继续共用原始 1254 × 1254 PNG。

## 内容模型

> 状态说明：D-036 至 D-067 已固定文章领域、身份、URL、状态、日期、分类与作者工具方向；D-078 将剩余 M0 schema 和实现细节委托给工程判断，E-001 至 E-004 固定项目内容职责、注册表、发现关系、路由和页面投影。下面的字段表是 M0 实现契约，不再是下一轮用户评审候选；具体 TypeScript 类型、错误文本和测试 fixture 由编码 Spec 拥有。

“项目-模块-主题标签”只描述内容组织关系，不改变稳定扁平文章 URL。每篇文章只有一个规范目录归属：`project` 和 `module` 各最多一个，module 必须隶属 project；两者均空时进入虚拟“通用技术”分组。跨项目文章选择一个主项目，其他项目只写入 `relations.projects`，不得导致侧栏重复。项目、模块、主题和作者都引用稳定 ID，显示名与排序可更新但 ID 不复用，重分类不改变 URL。

D-050 将三个组织字段统一放入必填的 `classification` 对象。该对象是唯一真相源，不得在顶层或其他分组复制同一含义。以下只展示结构，占位 ID 不表示已登记内容：

```yaml
classification:
  project: "project-id"
  module: "module-id"
  topics:
    - "topic-id"
```

`classification.project` 和 `classification.module` 可省略；`classification.topics` 必须存在，因此 `classification` 对象本身必填。分组名不等于通用主分类，也不参与路由生成。


### 项目 Project

[主站项目目录](../contracts/projects.json) 是首版项目条目的机器可读真相源；项目展示和项目体验是两层契约。项目可以只有源码、截图或视频而没有在线体验，只有另行登记且通过健康检查的体验才进入 [项目体验注册表](../contracts/project-experiences.json)。

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 全站唯一、稳定的项目标识 |
| `title` | 是 | 公开名称 |
| `slug` | 是 | 稳定项目短标识；构建期唯一派生 `/projects/<slug>`，不从正文路径推断 |
| `navigationOrder` | 是 | 正整数且项目间唯一；只控制项目列表和项目侧栏顺序 |
| `summary` | 是 | 一句话说明解决的问题 |
| `status` | 是 | `active`、`paused`、`completed`、`archived` |
| `publicationStatus` | 是 | `draft`、`planned`、`published`、`archived` |
| `startedAt` | 是 | 开始日期，至少精确到月 |
| `updatedAt` | 是 | 最近实质更新日期 |
| `repositoryUrl` | 否 | 公开源码仓库的完整 HTTPS URL |
| `productionBranch` | 有仓库时 | 用于核对公开事实的稳定分支 |
| `showcaseMode` | 是 | 当前允许的公开动作集合；未就绪增强不能提前写入 |
| `demoVideoStatus` | 有视频计划时 | 素材状态；未完成时禁止页面入口 |
| `experienceRegistryId` | 有保留体验时 | 与项目体验注册表对应的稳定标识 |
| `demoVideoUrl` | 否 | 已审核演示视频的站内路径或完整 HTTPS URL |
| `demoVideoPoster` | 否 | 与视频匹配的 16:9 封面路径 |
| `demoVideoCaptions` | 否 | UTF-8 WebVTT 字幕路径 |
| `relatedWriting` | 否 | 相关技术分享标识列表 |
| `writingModules` | 否 | 项目内写作模块列表；每项包含稳定 `id`、`displayName`、唯一 `navigationOrder` 与状态 |
| `previewImage` | `published`、`archived` | 唯一主预览对象；`draft`、`planned` 可省略且不得使用占位图 |
| `previewImage.sourcePath` | 有主预览时 | 相对 `site-assets/` 的 `projects/<project-id>/<lowercase-kebab-case>.webp`，公开 URL 只由它派生 |
| `previewImage.width` / `height` | 有主预览时 | 固定 `1600` / `1000`，并且必须与 WebP 解码尺寸一致 |
| `previewImage.alt` | 有主预览时 | 非空单行纯文本，最多 160 个 grapheme，说明图片所证明的真实界面或工程状态 |
| `source` | 是 | 支撑注册表结构化事实的设计文档、仓库或原始资料；不作为页面证据清单 |

`problem`、`decisions` 和叙事性 `evidence` 不是项目注册表字段。项目长文位于 `site-content/projects/<project-id>/index.md` 或 `index.mdx`，唯一拥有问题背景、能力与架构、关键取舍、限制、证据说明和复盘正文；其中的证据链接是正文内容，不回填注册表。注册表 `summary` 只拥有列表和元数据使用的一句话摘要，正文不得把它复制为第二个可编辑摘要字段。

项目正文由目录名与注册表稳定 ID 绑定，不保存作者可编辑 frontmatter，也不重复 H1、上表字段或 Docusaurus 派生字段；出现任意 frontmatter key、孤儿正文、未知目录或双入口时自动失败。正文可以正常叙述问题、取舍并链接证据；摘要或结构化事实是否发生不必要的文字重复由内容审查判断，不使用字符串相似度冒充语义校验。

`published` 与 `archived` 项目必须恰有一个正文入口和一个 `previewImage`；`draft` 与 `planned` 可以在准备期没有正文和预览，不会产生生产路由，也不得用占位图满足字段。单对象本身就是主预览选择规则，不增加 `primary`、顺序、公开 URL、审核布尔值或内容哈希副本。主预览固定为非动画 WebP、1600 x 1000、最多 300,000 bytes；扩展名、文件签名、动画状态、实际尺寸和登记尺寸必须一致，`alt` 去除首尾空白后不得为空、包含换行或与项目标题/摘要完全相同。

当前两个项目的唯一叙事正文分别位于 `site-content/projects/docrestore/index.md` 和 `site-content/projects/vibecoding-project-scaffold/index.md`；原过渡章节已经在创建正文的同一变更中替换为正文链接，迁移前后只保留一个可编辑叙事来源。`projects.json` 旧有同名字段删除后不得作为迁移输入重新生成。项目正文同目录素材放在 `assets/`；主预览原件放在 `site-assets/projects/<project-id>/`，始终公开的全站资源放在 `static-public/`，二者均由 E-008 的受控构建入口投影，不能直接配置为未过滤的项目素材目录。体验 URL 与运行状态只从 `project-experiences.json` 派生；只有对应条目为 `live` 且健康检查通过时显示入口，不在项目注册表复制在线布尔值、体验 URL 或体验状态。

### 技术分享 Writing

| 字段 | 必填 | 说明 |
|---|---|---|
| `articleId` | 是 | 全站唯一、终身不可修改或复用的 UUIDv7 文章领域身份；不进入 URL，不映射为 Docusaurus 原生 `id` |
| `title` | 是 | 非空纯文本内容标题 |
| `slug` | 是 | Docusaurus 原生根相对完整文章路径，例如 `/writing/dependency-inversion`；公开 URL 的唯一真相源 |
| `summary` | 是 | 一至两句纯文本摘要；目录、正文导语和默认 SEO/分享描述的单一来源 |
| `publicationStatus` | 是 | `draft`、`published`、`archived`；`planned` 不属于文章状态 |
| `authors` | 是 | 非空的站内作者 ID 列表；首个稳定 ID 为 `lyty1997` |
| `publishedAt` | `published`、`archived` | 首次发布日期，`YYYY-MM-DD`；首次发布后不可修改 |
| `updatedAt` | `published`、`archived` | 最近可见修改日期，`YYYY-MM-DD`；`draft` 可选且不公开 |
| `classification` | 是 | 内容组织唯一分组；不得在顶层或其他分组复制其三个组织字段 |
| `classification.project` | 否 | 0-1 个稳定项目 ID；存在时是文章的主项目 |
| `classification.module` | 否 | 0-1 个稳定模块 ID；仅可与 `classification.project` 同时存在，且必须隶属所选项目 |
| `relations` | 否 | 相关关系分组；`projects` 引用 0-5 个非主项目稳定 ID，`articles` 引用 0-10 个非自身 articleId |
| `series` | M0 禁止 | 只保留未来能力名称；M0 schema 遇到该字段即失败，出现首个真实系列时再定义结构和注册表 |
| `classification.topics` | 是 | 1-5 个受控稳定主题 ID |
| `seo` | 否 | `description` 与 `socialDescription` 覆盖，继续遵守 D-046 回退和去重规则 |
| `recommendation` | 否 | 显式推荐位置与排序；缺省表示不推荐，不从访问数据推断 |
| `revisions` | 否 | 面向读者的实质修订记录，不复制 Git 提交历史 |
| `sources` | 按需 | 外部事实或引用的原始出处；每项包含可读标题和 HTTPS 或仓库相对地址 |

M0 嵌套对象使用以下唯一结构，不接受别名或同义字段：

```yaml
relations:
  projects: ["related-project-id"]
  articles: ["018f0000-0000-7000-8000-000000000000"]
seo:
  description: "可选的搜索摘要覆盖"
  socialDescription: "可选的分享摘要覆盖"
recommendation:
  surfaces: ["home", "writing"]
  priority: 10
revisions:
  - date: "2026-07-18"
    summary: "说明本次面向读者的实质修改"
sources:
  - title: "原始资料标题"
    href: "https://example.test/source"
    accessedAt: "2026-07-18"
```

`relations.projects` 为 0-5 个不重复、非主项目 ID，`relations.articles` 为 0-10 个不重复、非自身且已登记的 articleId；空关系对象禁止提交。`recommendation.surfaces` 为 1-2 个不重复枚举，`priority` 为 1-100 的整数且同一 surface 内不得冲突，数值越小越优先；推荐只控制显式展示，不改变侧栏归属。`revisions` 按 date 严格升序，每项 summary 为 10-200 个 grapheme，日期不得早于 `publishedAt` 或晚于 `updatedAt`。`sources[].title` 为 1-120 个 grapheme，`href` 只接受 HTTPS 或不逃逸仓库的相对路径，`accessedAt` 对外部 HTTPS 来源必填。数组为空时省略整个可选分组。

文章 schema 拒绝未知字段和 Docusaurus 语义副本。`title` 为 1-100 个 Unicode grapheme，`summary` 为 20-200 个 grapheme，SEO 描述覆盖为 20-200 个 grapheme，分享描述覆盖为 20-300 个 grapheme；均须 trim 后非空、单段纯文本。`authors` 为 1-4 个不重复 ID，`classification.topics` 为 1-5 个不重复 ID。长度按 Node.js `Intl.Segmenter` 的 grapheme 计数，不按 UTF-16 code unit、字节或 CSS 截断结果计数；实际搜索摘要仍可能由搜索引擎重写，因此这些边界服务编辑质量和页面布局，不承诺搜索展示长度。

作者注册表位于 `docs/contracts/authors.json`，主题注册表位于 `docs/contracts/topics.json`，两者都使用稳定 ID 到资料对象的映射；项目模块嵌套在 `projects.json#projects[].writingModules` 中。作者记录只允许 1-80 grapheme 的 `displayName` 和可选 `links.github`；主题和模块记录只允许 `displayName`、正整数 `navigationOrder` 与 `active|archived` 状态。ID 完整匹配 lowercase kebab-case，GitHub 链接必须是 `https://github.com/<account>`，悬空引用、重复 ID、同级顺序冲突和未知字段都使构建失败。首版主题只显示为元数据，不生成主题页；新增作者不强制提供 GitHub 链接。

`articleId`、完整 `slug`、`publishedAt` 与 `updatedAt` 保存在同一个唯一正文入口中，形成唯一可编辑绑定。UUIDv7 时间字段只记录生成器在分配 ID 时采用的 Unix 毫秒时间源值，可用于 UUID 值的技术排序与未来存储索引局部性，但不保证真实业务事件顺序，也不是文章创建、发布或更新日期；未来日期筛选或索引只能读取显式 `publishedAt` 与 `updatedAt`。M0 从 `published` 与 `archived` 文章派生仅包含这四个字段的日期索引，按 articleId 确定性排序；它只存在于构建内存和 Docusaurus generated files 中，不提交、不进入 `static/`、不形成公开路由或浏览器数据，draft 不进入索引。当前不新增 `createdAt`，也不批准站内搜索、日期筛选 UI、搜索插件或归档路由。

新文章由作者在获准的 Linux 执行环境显式运行仓库内 `node scripts/author/create-article.mjs` 建立。命令显式接收 source-name、title、完整 slug、summary、至少一个 author 和 topic，以及可选 project/module；M0 只创建 Markdown，不提供 MDX 快捷入口。它在创建唯一正文入口时使用 Node 24.16.0 起提供的原生 `node:crypto.randomUUIDv7()` 生成并一次写入 articleId，正常作者入口必须运行在与仓库 `.nvmrc` 精确一致的 Node 上，结果保留在 Linux 作者工作区供 Git diff 审查。最低版本兼容任务只验证共享负载，不得触发文章创建。命令先完整校验并取得作者锁，在锁内复核工作区并在内存生成 UUID；E-013 的候选历史检查通过后，才在 `site-content/.author-staging-*` 写出完整 draft，flush 后把整个临时目录原子 rename 为目标。失败清理本次结果，质量、预览和构建发现锁或残留 staging 时失败，不读取半成品。命令不从 UUID 推导源码名、slug、分类或日期，不自动暂存、提交、推送或发布。Git hook、CI、Docusaurus 与生产只读校验，不生成或修复；E-013 的同一实现从完整非浅 HEAD 可达 DAG 和当前工作区候选检查 UUID、source-name 与稳定注册表 ID，浅历史、缺失对象、改绑或删除后重引都失败关闭。原生后端不保证严格递增，且不引入 UUID npm 包。E-013 历史质量入口与 pre-write 候选 API 已由 D-097 实现，并依 D-100 纳入本专题分支；#24 已实现 `create-article.mjs` 及其锁、staging、flush、rename、回滚与消费者残留门禁，通过本地 fixture，并依 D-103 获准纳入当前专题分支提交及同名临时 ref。它仍只是尚待远端 CI 与 Issue 验收的显式作者 CLI，不是编辑器、CMS 或公开页面能力。

### 系列 Series

系列只在出现至少两篇具有明确阅读顺序的真实文章时启用，不作为普通标签或第二个规范目录归属。M0 不创建系列注册表、列表页或独立路由；文章 schema 只保留可选关系位置，当前内容不得填写。启用时再根据真实内容补充注册表与迁移，不阻塞 M0 实现。

## 页面与视觉原则

- 视觉语气克制、清晰、可信，以正文、项目证据和阅读层级为中心。
- 首屏直接展示“Axial Muse”和项目驱动的技术分享定位，不放欢迎语或夸张口号。
- 桌面端正文行宽控制在适合长文阅读的范围；移动端不依赖横向滚动。
- 卡片只用于重复项目或内容条目，页面章节本身不做悬浮卡片。
- 使用真实项目截图、界面或结构图表达成果；装饰性图片不能替代证据。
- 动效仅用于状态反馈和层级过渡，并尊重 `prefers-reduced-motion`。
- 颜色、字体、间距和组件状态的最小设计令牌统一定义在 `src/css/custom.css`，使用 `--am-` 前缀；页面和组件只通过同目录 CSS Modules 消费，不为单个区块临时造全局样式。

## 可访问性要求

- 页面可仅用键盘完成导航和链接访问，焦点样式清晰可见。
- 使用语义化标题层级、地标元素和跳过导航链接。
- 正文与交互文本达到 WCAG 2.2 AA 对比度目标。
- 图片必须有与用途一致的替代文本；纯装饰图片使用空替代文本。
- 交互目标在移动端易于点击，文本放大到 200% 时不遮挡或丢失功能。
- 不用颜色作为状态的唯一表达方式。

## SEO 与分享元数据

每个可索引页面至少包含唯一的 `title`、`description`、canonical URL、Open Graph 标题/摘要/图片和正确的 `lang="zh-CN"`。生产 canonical 主机为 `https://www.axialmuse.com/`。M0 在站点根目录发布 `sitemap.xml` 与 `robots.txt`；站点地图列出首页、两个目录页以及所有 `published`/`archived` 项目和文章 canonical，不包含 draft、planned、预览、锚点、重定向源或未来体验子域名。

M0 首页标题精确使用 `Axial Muse | 全栈技术 + AI 的生产力工具`，后续内容页采用“内容标题 | Axial Muse”。预览部署必须 `noindex`，生产部署不得意外继承该设置。项目体验子域名默认 `noindex`，项目背景与技术内容由主站项目页承载；只有体验具备独立可检索内容时才单独开放索引。`robots.txt` 只管理抓取，不承担隐藏敏感内容的职责。

参考：[Google 站点地图指南](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)、[Google robots.txt 指南](https://developers.google.com/search/docs/crawling-indexing/robots/intro)。

## 隐私与外部入口

M0 不使用访问分析、广告、第三方嵌入、评论、订阅或站内表单，不设置 Cookie。关于区展示 GitHub 个人主页 `https://github.com/lyty1997`，仅作为普通公开链接，不包含 GitHub 密码、Token、私有仓库或管理权限。仓库中不保存私人联系方式。

生产站点由 Nginx 自托管。访问日志默认关闭；错误日志和系统认证日志可能包含 IP、时间、请求路径或认证结果，只用于安全与故障处理，保存在腾讯云轻量服务器本地并按 [自动化维护与运行手册](../operations/maintenance.md) 轮转删除，不发送到外部分析服务。

新增任何采集能力前，必须先定义字段、用途、法律依据或同意机制、存储位置、保留周期、导出与删除方法，以及第三方处理方。

## 验收标准

- 首屏能在不滚动时说明品牌、内容主题和主要入口。
- 导航和页面术语与本文一致，计划能力没有写成已交付事实。
- 桌面端与移动端均无文字重叠、溢出或不可访问链接。
- 项目与技术分享条目能追溯到真实资料或明确状态。
- “在线体验”入口只指向已登记、健康且通过 HTTPS 与备案页脚验收的项目子域名。
- 演示视频具备真实成片、封面、字幕、文字摘要和隐私审核记录，不被描述为可交互在线服务。
- 页面元数据、canonical、站点地图和索引策略一致。
- 首版不引入用户数据采集或未经记录的第三方脚本。

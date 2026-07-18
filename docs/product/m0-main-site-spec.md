# M0 主站实现 Spec

状态：active
最近更新：2026-07-18
适用范围：`https://www.axialmuse.com/` 的 Docusaurus 多页面静态主站
实现前置：D-077 首次依赖解析与准入完成；真实公开素材通过事实、隐私和版权检查

## 目的与授权边界

本文把[主站体验设计](site-experience.md)和[主站目标架构](../architecture/main-site-target-architecture.md)转化为 M0 页面、内容、主题和验收契约。D-078 已授权 Agent 在不改变已确认产品方向的前提下决定内部工程与展示细节，因此本文是实现基线，不再因断点、目录生成、字段投影或构建产物等内部细节逐项请求确认。

本文不批准联网安装、Git 发布、服务器、DNS、证书、云资源或生产上线操作，也不批准新增公开业务事实、第三方浏览器请求或用户数据处理。这些事项仍按各自门禁单独授权。

## M0 目标

- 首次访问者能识别“Axial Muse”，理解本站以个人项目为线索公开技术取舍与复盘。
- 项目与技术分享具有独立目录和详情入口，详情页使用文档站式左目录、中正文、右标题导航。
- 公开内容来自 Git 管理的单一事实源，状态、链接、日期和未实现能力表达准确。
- 站点在桌面、平板和手机上可阅读、可键盘操作，不重叠、不产生页面级横向滚动。
- 生产只提供可重复生成的静态文件，不采集用户数据，不依赖运行时后端。

## M0 非目标

- 不建设登录、账户、评论、订阅、反馈表单、支付、分析、Cookie 或用户数据采集。
- 不提供项目在线体验、上传、API 或试用入口；`docrestore.axialmuse.com` 当前不创建。
- 不提供站内搜索、日期筛选、主题页、作者页、系列页、归档页、分页、RSS、独立 `/about/` 页面或内容后台。
- 不启用 blog 插件，不建立第二套项目或文章内容实例。
- 不引入 UI 组件库、图标库、远程字体、第三方脚本或未经 D-077 准入的依赖。
- DocRestore 演示视频不阻塞 M0；素材未完成时不显示播放器、封面占位或观看入口。

## 路由契约

`trailingSlash: true` 是全站规范。源码中的项目短 slug 和文章完整 slug 不带尾斜杠，公开 canonical、站内链接、sitemap 和 Nginx 目录 URL 均带尾斜杠。

| 路由 | 来源 | M0 行为 |
|---|---|---|
| `/` | `src/pages/index.tsx` | 品牌、定位、精选项目、技术分享入口、路线与关于摘要 |
| `/projects/` | `src/pages/projects/index.tsx` | 公开项目目录 |
| `/projects/<project-slug>/` | 单一 docs 实例 + 项目注册表 | `published` 或 `archived` 项目详情 |
| `/writing/` | `src/pages/writing/index.tsx` | 公开文章目录或真实空状态 |
| `/writing/<article-slug>/` | 单一 docs 实例 + 文章 frontmatter | `published` 或 `archived` 文章详情 |

`/assets/`、`/img/`、`/.well-known/`、`robots.txt`、`sitemap.xml` 和 `404.html` 是保留空间。M0 不生成其他内容路由。`onDuplicateRoutes: 'throw'`，broken link 和 broken anchor 均让构建失败。

旧 URL 只允许在 `docs/contracts/redirects.json` 登记精确永久重定向。每项只包含根相对 `from`、根相对 `to` 和非空 `reason`；两条路径都必须以 `/` 开始并遵守页面尾斜杠规范，不接受 origin、查询串、fragment、状态码覆盖或通配。生成结果固定为 301；重定向不得形成自跳转、链或环，源、目标和所有规范化路径必须参与全站冲突检查。

## 内容与投影

### 项目

`docs/contracts/projects.json` 拥有项目的结构化事实，包括 ID、标题、短 slug、摘要、状态、日期、仓库、展示能力、顺序和模块。`site-content/projects/<project-id>/index.md|index.mdx` 只拥有背景、能力、取舍、限制、证据与复盘正文，不重复 H1、摘要、状态、日期、仓库或路由。

构建期以 `projectId` 一对一绑定两者，并在内存中派生 Docusaurus `title`、`description`、完整 slug 和 draft 行为。`published`、`archived` 项目必须恰有一个正文入口；`planned`、`draft` 可暂时没有。孤儿正文、重复字段、未知项目或双入口必须失败。

### 技术文章

文章位于 `site-content/writing/<source-name>/index.md|index.mdx`，完整模型与发布规则见[内容发布流程](../operations/content-publishing.md)。生产只生成 `published` 和 `archived` 的列表、详情及 sitemap 项；draft 仅在开发预览的独立分组可见，并强制 `noindex`。

文章默认使用 Markdown。M0 的 `src/components/mdx/index.ts` 白名单为空，因此首版不发布 MDX 文章。文章局部素材放在同目录 `assets/`，全站公共素材放在 `static/assets/`。

### 注册表与排序

- 作者：`docs/contracts/authors.json`。
- 主题：`docs/contracts/topics.json`，M0 只用于显示和校验，不生成主题路由。
- 项目与项目内模块：`docs/contracts/projects.json` 的 `writingModules`。
- 无项目文章：显示在虚拟分组“通用技术”，不创建伪项目。
- 跨项目关系：可选 `relations.projects`，只生成相关链接，不改变规范归属或重复侧栏入口。

项目目录和侧栏按 `navigationOrder` 升序。技术分享侧栏先显示“通用技术”，再按项目 `navigationOrder`、模块 `navigationOrder` 排序；组内文章按 `publishedAt` 降序，日期相同时按 `articleId` 升序。注册表 ID 使用小写 kebab-case，重复顺序、悬空引用和未知字段均失败。

## 页面规格

### 全站导航

- 文本品牌“Axial Muse”链接到 `/`。
- 一级导航固定为“项目”“技术分享”，分别链接 `/projects/`、`/writing/`。
- “路线”“关于”只在首页存在，导航从其他页面返回 `/#roadmap`、`/#about`。
- GitHub 个人主页放在页头外部链接区域或页脚，地址固定为 `https://github.com/lyty1997`。
- 页头使用 Docusaurus 可访问导航能力；小屏使用框架抽屉，不另造第二套导航状态。

### 首页

首页是主站入口，不是营销落地页。首屏 H1 为“Axial Muse”，支持文案为“围绕个人项目，记录设计、实现、技术取舍与复盘。”；阶段说明为“首版先公开可核验的项目资料和工程记录。产品服务会在边界明确并真实可用后再提供入口。”

首屏不占满视口，在常见 800-900 px 高度中露出下一段项目内容。主动作“浏览项目”链接 `/projects/`。页面不把首屏放入卡片，不使用渐变、装饰光斑、通用图库图或与项目无关的背景图。

首页后续区域依次为：已发布项目摘要、技术分享入口或真实空状态、`#roadmap` 路线、`#about` 关于。项目摘要必须链接项目详情和公开仓库；未发布项目不得出现。技术文章为空时显示：“技术分享正在从项目记录中整理。首批内容发布后会在这里提供可核验的原始资料与实现细节。”

路线只表达“当前：建立可信主站”“下一步：形成技术分享”“探索：产品服务”，不承诺日期。关于正文为：“我关注 AI 工程、知识工作流、开发规范和个人产品构建。本站公开项目、技术取舍与复盘，不公开私人联系方式、凭证或私有仓库。”

### 项目目录

- 标题、摘要和状态来自 `projects.json`，生产只列 `published`、`archived`。
- 每项展示真实预览、标题、状态、摘要、最近实质更新时间和明确动作。
- 项目详情是主动作；“查看源码”是次动作，URL 必须与注册表一致。
- 只有体验注册表为 `live` 且通过生产健康检查时才能显示体验入口；M0 不满足该条件。
- 视觉素材未通过公开性检查时，项目不得改为 `published`，不使用虚构占位图绕过。

### 项目详情

左栏显示项目目录，正文展示项目状态、问题、架构、关键取舍、限制、证据链接与相关技术分享，右栏显示当前正文 H2-H3 标题导航。页面标题、摘要、仓库和状态从注册表投影，正文不得覆盖。

DocRestore 只能表达源码与项目资料已经公开，不得暗示在线体验、上传服务、登录或后端可用。VibeCoding Project Scaffold 只能陈述已由公开仓库或已审核材料支持的能力。

### 技术分享目录

目录按“通用技术 -> 项目 -> 模块”组织，只展示已登记主题标签，不生成筛选器或主题链接。没有公开文章时使用首页相同的真实空状态，不列虚构标题或发布日期。

### 技术文章详情

左栏显示生成的技术分享目录，中栏展示正文，右栏显示 H2-H3 标题导航。页面显示作者、`publishedAt`、`updatedAt`、主题与归档状态；UUIDv7 articleId 不作为主视觉信息，不参与公开日期排序。相关文章只基于显式关系生成，不做浏览器端推荐或行为采集。

### 页脚

页脚展示“2026 Axial Muse”和 ICP 备案号 `沪ICP备2026029086号`，备案号链接 `https://beian.miit.gov.cn/`。公安联网备案号在完成现场核验前不显示占位文本。年份不在构建或浏览器运行时读取系统时间；修改公开年份必须进入源文件和 Git diff。

## 主题与响应式

M0 使用 Docusaurus classic/Infima 的语义、导航和可访问性基础，通过 `themeConfig`、`src/css/custom.css`、CSS custom properties 与页面 CSS Modules 适配品牌。只提供亮色主题，不引入 UI 库，不 eject 主题，不做默认 swizzle；只有现有配置点无法满足已确认需求时，才对锁定版本做最小包装并补契约测试。

### 视觉基线

界面定位为安静、紧凑、可重复使用的工程作品索引。禁止营销式超大口号、装饰性卡片堆叠、渐变背景、模糊光斑、过量阴影和单一色相铺满页面。

| 令牌 | 基线值 | 用途 |
|---|---|---|
| `--am-canvas` | `#f4f6f3` | 页面底色 |
| `--am-surface` | `#ffffff` | 必要表面 |
| `--am-ink` | `#171a1c` | 主文本 |
| `--am-muted` | `#596168` | 辅助文本 |
| `--am-line` | `#cfd6d1` | 分隔和边框 |
| `--am-accent` | `#0b6b5f` | 主动作和焦点 |
| `--am-signal` | `#b94b35` | 少量状态强调 |

使用系统无衬线字体，不加载远程字体；正文 16 px、行高 1.65，正文列最大约 72 个中文字符。字号只在明确媒体查询中切换，不随视口连续缩放；`letter-spacing` 为 `0`。圆角不超过 8 px，默认不用阴影，状态不能只靠颜色表达。

### 三栏折叠

| 视口 | 详情页行为 |
|---|---|
| `>= 1280px` | 左目录、中正文、右标题导航同时显示 |
| `996-1279px` | 左目录折叠到正文上方；中正文与右标题导航显示 |
| `< 996px` | 左目录和右标题导航都折叠到正文上方，正文单列 |

列表页与首页在 320 px 宽度仍须可读且无页面级横向滚动。固定比例素材使用 `aspect-ratio` 和明确尺寸，图片加载、标签或 hover 不得改变布局。M0 不实现滚动高亮、搜索、筛选或分页。

## 素材契约

每个发布项目至少需要一张真实、已脱敏的视觉证据。项目预览优先 WebP，建议 1600 x 1000、单张不超过 300 KB；Open Graph 图建议 1200 x 630、不超过 300 KB；favicon 不超过 50 KB。具体内容必须来自项目真实界面或工程证据，不能用装饰图代替产品证据。

```text
static/assets/
├── brand/
│   ├── favicon.svg
│   └── social-card.webp
└── projects/
    ├── docrestore-preview.webp
    └── project-scaffold-preview.webp
```

文件名使用小写 ASCII 与连字符。生产页面不引用仓库外图片 URL。截图必须移除凭证、真实隐私、用户名、主机名、绝对路径、通知和未授权内容；版权与公开性无法确认时不发布。

## 可访问性与 SEO

- 使用语义化 landmark 和单一 H1；标题层级不因视觉样式跳级。
- 所有动作可用键盘完成，focus-visible 清楚可辨；文本放大 200% 后不截断关键内容。
- 正文、次文本、链接、焦点和状态达到 WCAG 2.2 AA 对比度目标。
- 图片替代文本说明其证明的界面或工程状态，纯装饰资源使用空 `alt`。
- 尊重 `prefers-reduced-motion`；核心内容不依赖动画出现。
- 全站 `lang="zh-CN"`，UTF-8；首页标题为 `Axial Muse | 个人项目与技术分享`。
- 首页 description 为 `Axial Muse 记录个人项目的设计、实现、技术取舍与复盘，公开可核验的源码与工程资料。`
- canonical、Open Graph URL、站内链接和 sitemap 使用 `https://www.axialmuse.com/` 下的规范尾斜杠 URL。
- sitemap 列出所有公开首页、目录、项目详情和文章详情，不包含 draft、planned、预览 URL、锚点或重定向源。
- 预览环境必须 `noindex`，不得把预览 URL 写入 canonical 或 sitemap。

## 性能与运行时边界

- 首页关键内容在 Docusaurus hydration 失败时仍能阅读和导航。
- 不加载第三方字体、分析、广告、视频 iframe、社交组件或运行时 API。
- 图片声明固有尺寸；首屏外图片 lazy-load，LCP 图片按实测决定预加载策略。
- 不含视频时，首页首次传输目标不超过 1.5 MB，单张图片目标不超过 300 KB。
- 浏览器控制台不得出现本站代码导致的错误、404、混合内容或 hydration mismatch。

## 实施顺序

1. 依 D-077 完成首次 npm 解析、人工准入、冻结 lockfile 和供应链证据；该联网步骤另行申请授权。
2. 实现 Node 24、TypeScript、Docusaurus 配置和 schema/注册表只读门禁。
3. 迁移项目结构化事实与正文，完成页面、侧栏、路由和 SEO 投影。
4. 适配主题、响应式、素材和可访问性，不改变公开事实。
5. 运行质量、类型、构建、路由、断链、浏览器和视觉验收。
6. 由 GitHub Actions 从精确 `main` SHA 生成默认 `build/` artifact；Action 与凭证接线另行授权。
7. 服务器、TAT、Nginx、证书、DNS 和生产冒烟按部署 runbook 单独实施与验收。

## Definition of Done

### 内容与页面

- 首页、项目目录、公开项目详情、技术分享目录和公开文章详情按路由契约生成。
- DocRestore 和 VibeCoding Project Scaffold 的公开字段与 `projects.json` 一致；页面不宣称未上线体验。
- 空状态、路线、关于、GitHub 主页和 ICP 备案链接符合本 Spec。
- draft、planned、未审核素材和未登记关系不会进入生产 `build/`、导航或 sitemap。

### 工程

- `npm run quality`、独立 `tsc --noEmit` 和 Docusaurus build 全部通过。
- Node 版本与 `.nvmrc`、`engines.node` 一致，双端点冻结安装和 D-077 供应链门禁通过。
- 路由、尾斜杠、重定向、注册表、schema、历史 articleId、断链和资源路径契约有自动测试。
- `build/` 可由普通静态 HTTP 服务直接提供，生产请求不依赖 Node、npm、源码或构建进程。
- 浏览器网络面板没有未经批准的第三方请求或 Cookie。

### 体验

- 至少检查 360 x 800、768 x 1024、1024 x 768、1440 x 900 四个视口。
- 三栏折叠、导航抽屉、键盘顺序、focus、200% 文本缩放和 reduced motion 验收通过。
- 页面无文字重叠、溢出、页面级横向滚动、动态布局跳动和不可解释空白。
- 项目视觉真实、清晰、已脱敏；控制台无本站代码错误和资源 404。

### 发布准备

- GitHub Actions artifact 绑定精确 `main` SHA，包含可验证摘要和文件清单。
- PR 记录设计依据、质量结果、桌面与移动截图、公开素材来源和未完成项。
- 服务器部署、回滚、HTTPS、备案展示和生产冒烟在独立 runbook 中验收；本 Spec 通过不等于生产上线授权。

## 当前阻塞项

| 项目 | 状态 | 影响 |
|---|---|---|
| M0 内部工程细节 | 已由 D-078 授权并形成 E-001 至 E-005 | 不再逐项阻塞设计或实现 |
| 首次 npm 解析与真实传递图准入 | 尚未执行 | 阻塞 Docusaurus 依赖安装和实现 |
| 两个项目真实视觉证据 | 尚未准备 | 阻塞对应项目改为 `published`，不阻塞框架和空状态实现 |
| DocRestore 演示视频 | 后续增量 | 不阻塞 M0 |
| GitHub Actions、TAT 与凭证接线 | 尚未授权实施 | 阻塞自动部署，不阻塞本地构建 |
| 服务器、DNS、证书与生产核验 | 尚未执行 | 阻塞公开上线，不阻塞主站开发 |
| 公安联网备案信息 | 尚待现场核验 | 核验前不显示占位号 |

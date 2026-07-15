# 项目进度

本文件是 AxialMuseWebsite 的项目进度真相源，按时间倒序记录每次任务的完成内容与遗留项。每次任务结束或中断时更新。

条目格式：`时间戳 / 主题 / 完成内容 / 遗留项`。

## 2026-07-15 — CLAUDE.md 改为导入 AGENTS.md，门禁操作知识归位

- **主题**：用户提出 CLAUDE.md 直接 `@` 导入 AGENTS.md 即可。查证后确认这是 Anthropic 官方文档明确推荐的多 Agent 仓库模式，采纳。
- **完成内容**：
  - `CLAUDE.md` 由 89 行缩为 13 行：一段说明 + `@AGENTS.md` 导入 + 一个只写环境差异的“Claude Code 专属差异”节。规范正文不再有第二份，结构上杜绝漂移。
  - 新增 [`codex-rules/rules/quality-gates.md`](../codex-rules/rules/quality-gates.md)，收纳原先只存在于 CLAUDE.md 的门禁执行层知识：命令、hooks 启用、各门禁执行边界，以及词边界匹配、根目录只扫一层的理由、`gen:diagrams` 不是门禁、“写门禁文档会拦到自己”等坑点。设计层能力清单仍归 `maintenance.md`，本文件不复制。
  - `global-AGENTS.md` 路由表新增一行“运行质量门禁、修改 `scripts/quality/` 或 Markdown 图表”。
  - 修正 `apply_patch` 缺陷：AGENTS.md 要求手工编辑使用 `apply_patch`，但那是 Codex 的工具，Claude Code 没有；纯导入会让 Claude Code 收到无法执行的指令。已在 CLAUDE.md 的专属差异节声明改用 Edit / Write，未改动 AGENTS.md。
- **查证结论**（`https://code.claude.com/docs/en/memory.md`）：Claude Code 只原生读取 `CLAUDE.md`、不自动读 `AGENTS.md`，因此显式导入不会重复加载；官方对“仓库已有 AGENTS.md”的建议正是创建 CLAUDE.md 导入它；导入递归上限为 4 跳；导入在反引号和代码块内不生效，紧跟 blockquote 之后不受影响。
- **纠正上一轮的判断**：先前以“门禁细节别处没有”为由把整段机制留在 CLAUDE.md，查证后只对了一半——能力层清单早已归 `maintenance.md`，目录职责早已归 `overview.md`，真正无归属的只有执行层知识，而它本就该在 `codex-rules/`。这些知识长期只存在于 CLAUDE.md，等于 Codex 从来没拿到过；归位后两个 Agent 都能按需加载。
- **验证证据**：`npm run quality` 五项通过（exit 0）；契约扫描集 45 → 46，确认 `CLAUDE.md` 与新建的 `quality-gates.md` 都在扫描范围内。
- **遗留项**：
  - `@AGENTS.md` 的实际展开只能在新会话用 `/memory` 确认，本次无法自证；若未生效需回退为在 CLAUDE.md 保留必要正文。
  - AGENTS.md 第 30 行的 `apply_patch` 仍是 Codex 专属表述。是否把 AGENTS.md 改成工具无关写法（更彻底，但要动刚定稿的文件）留待决定。

## 2026-07-15 — 固定首版工程技术基线

- **主题**：用户确认把 Docusaurus 官方能力、现有 PlantUML、Nginx/Certbot、GitHub Actions/TAT、Ubuntu/systemd 原生运维和 CI 质量与供应链门禁固定为首版组合。
- **完成内容**：
  - 记录 D-053，固定各组件职责、静态生产边界、发布失败边界和门禁能力类别；明确“官方能力”不等于所有官方插件或可选功能自动获批。
  - 将现有 PlantUML 保持为构建期源码到静态 SVG 的图表链路，不引入浏览器端渲染或 Docusaurus 运行时图表插件。
  - 将 Nginx/Certbot、GitHub Actions 经 CAM 调用固定 TAT command、Ubuntu/systemd/logrotate 统一到目标架构和运行手册，并明确这些仍是设计基线而非已部署事实。
  - 固定依赖与构建、代码与内容、路由与 SEO、许可证/SBOM/漏洞/Secret、制品网络、浏览器与可访问性、CSP、发布后冒烟等门禁类别；具体工具、格式和阈值继续受后续决策门禁约束。
  - 区分迁移前 `npm run quality` 与 Docusaurus 目标门禁，明确当前检查仍不足以证明目标供应链覆盖；生产发布必须等待所有必需 job，包括 PlantUML 编译。
  - 修正 Certbot webroot HTTP-01 与全量 HTTP 跳转的设计冲突：challenge 使用 release 之外的专用 root-owned webroot，其余 HTTP 请求才重定向到 HTTPS。
- **验证结果**：
  - `npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功。
  - `git diff --check` 通过。
  - `npm run check:diagrams` 未运行：本机未设置 `PUML_JAR`，且本次没有修改 PlantUML 源码或生成 SVG。
- **遗留项**：
  - OD-015 仍是下一项阻断性决策：确认单一 docs、多个 docs 或 docs + blog 的内容组织模式；本次没有替代或关闭该门禁。
  - Docusaurus/Node.js 版本、preset/plugin 实例、包管理器与 lockfile、内容目录、字段映射、主题 fit-gap、门禁具体工具与契约格式、构建位置、制品交付和新版主站 Spec 仍待逐项确认。
  - 服务器、GitHub environment、CAM/TAT、Certbot timer、快照和日志轮转仍待现场核验。
  - 本次未安装依赖、未修改页面或质量脚本，未操作服务器、DNS、证书或云资源，也未提交、推送或创建 PR。

## 2026-07-15 — check:contracts 纳入仓库根级文件，堵住漂移缺口

- **主题**：承接上一条的根因——`CLAUDE.md` 的失效副本之所以能一路漂移，是因为 `check:contracts` 的扫描根不含仓库根目录，没有门禁看着它。本次把根级文件纳入扫描。
- **完成内容**：
  - `contract-rules.json` 新增 `scan.include_root_files: true`；`lib/files.mjs` 新增 `listFilesShallow`（只列一层、不递归）；`check-contracts.mjs` 的 `scanFiles` 据此扫描根级文件，并把结果容器换成 `Set` 防重复计数。
  - 扫描集 40 → 45，新增 `AGENTS.md`、`CLAUDE.md`、`README.md`、`CONTRIBUTING.md`、`package.json` 五个根级文件，现状零违规。
  - `CLAUDE.md` 同步更正“根目录不在扫描范围内”这一已失效描述，并说明根目录只扫一层的原因。
- **方案取舍**：先试过把扫描根直接改成 `["."]`，干跑发现会把 **134 个 `.mypy_cache/*.json`** 卷进扫描集。这类本地工具缓存靠自带的嵌套 `.gitignore` 对 git 隐身，但扫描器走文件系统、不读 `.gitignore`，会让门禁范围随各人机器上的残留而变；且引入 Docusaurus 后还会冒出 `.docusaurus/`，靠 `skip_paths` 逐个排除是黑名单打地鼠，漏一个就悄悄失效——与本次要修的病因同构。改用“根目录只扫一层”：目录天然进不来，无需维护排除名单，新增根级文件还能自动纳入、不会漏登记。
- **验证证据**：
  - 现状 `npm run quality` 五项通过（exit 0）。
  - 反向验证：向 `CLAUDE.md` 注入三行违规文本，分别命中 forbidden/literal（定位旧名）、forbidden/word（裸写品牌名）、scoped（越界的受限词），`check:contracts` 如期失败并逐行指名 `CLAUDE.md:91/92/93`，退出码 1；随后 `git checkout --` 还原，`git status` 与 `git diff` 均确认已回到提交版本。
  - 撰写本条目时把违规词原样写进 `docs/progress.md`，被 `check:contracts` 当场拦下（`progress.md:17`）——门禁对既有扫描范围同样有效的顺带实证。
  - 确认扫描集不含 `.mypy_cache`，根级文件恰为上述五个。
- **遗留项**：
  - 受限词的 `allowed_paths` 未把根级文件纳入，因此 `CLAUDE.md` 里描述该规则时无法直接举例写出那个词，只能指向 `contract-rules.json`；如后续觉得别扭，可再决定是否为根级文件开例外。

## 2026-07-15 — CLAUDE.md 对齐 AGENTS.md 重构并清除失效副本

- **主题**：`AGENTS.md` 重构后，`CLAUDE.md` 与之脱节且核心事实已过期，按“瘦身对齐”方向重写：删除与 `docs/` 重复的定位/阶段/内容边界叙述，保留 Claude Code 专属的工具链知识。
- **完成内容**：
  - **修正失效事实**：删除“当前处于 M0 阶段、代码以零依赖静态站点为主”与“引入框架（Next.js / Astro / MDX / CMS）前先记录决策”——D-051 已改选 Docusaurus、D-028 已确认 Git + 静态站点生成器、`technology-selection.md` 已 superseded。阶段描述改为只指向 `docs/README.md`。
  - **补齐阻断性门禁**：新增 OD-014 / OD-015 停工门禁（未决前不进入页面实现或生产配置，并注明以 `open-decisions.md` 当时状态为准）和 D-052 开源依赖分层准入（加包前必读）。
  - **补齐重构新增机制**：指令优先级链、用户决策门禁（推荐≠授权、确认前不得提交推送建 PR、先查证再提问、确认后先复述）、`codex-rules/` 按需路由加载与“禁止批量加载”。
  - **修正门禁描述**：`quality` 由“四个门禁”更正为五项串联并补 `check:js`；补 `codex-workflow.md` 到规则清单；`global-AGENTS.md` 定位由“入口与索引”更正为“只负责路由”；`known-issues.md` 由“动手前先查阅”更正为“仅在涉及 `scripts/dev/`、跨机预览或本地配置时读取”。
  - **补齐目录清单**：新增 `scripts/dev/`、`.githooks/`、`docs/projects/`；预览命令区分临时 8000 与跨机预览 8088 两条链路。
  - 规模 92 行 → 89 行（重复叙述换成指针，换入决策门禁与阻断门禁）；复验 `npm run quality` 五项全部通过（exit 0）。
- **踩坑记录**：根因是 `contract-rules.json` 的扫描根只有 `docs` / `public` / `scripts` / `codex-rules` / `.github`，**根目录的 `CLAUDE.md` 与 `AGENTS.md` 不受契约门禁扫描**，因此手工维护的设计副本漂移后无门禁兜底。已把这一事实写进 `CLAUDE.md` 的门禁章节，作为“不再维护副本、只留指针”的依据。
- **遗留项**：
  - 是否把根目录 `CLAUDE.md`/`AGENTS.md` 纳入 `check:contracts` 扫描根尚未决定；若纳入，需先核查现有措辞是否命中 `scoped_terms`。
  - 本次改动与工作区中其它未提交的 `docs/` 变更尚未提交，提交范围待用户确认。

## 2026-07-15 — 确认开源依赖分层准入

- **主题**：用户确认主站及未来独立服务采用开源依赖分层准入，避免因复用开源组件引入不可追溯的许可证、数据和运行边界。
- **完成内容**：
  - 记录 D-052，确认主站构建与浏览器依赖优先 MIT、Apache-2.0、BSD-2-Clause、BSD-3-Clause 或 ISC，但具体包、版本和传递依赖仍须逐项核验与确认。
  - 区分浏览器产物、弱 copyleft、强 copyleft/复杂许可、独立服务、开发运维工具和内容素材；隔离部署不免除适用的许可证义务。
  - 明确社区插件、SDK、iframe、分析、登录、评论、搜索和浏览器第三方或境外请求不论许可证为何均需单独决策。
  - 记录每项准入所需的版本、来源、许可证、制品位置、网络与数据流、维护安全状态和退出方案，并把机器准入门禁留到首次锁定依赖和构建发布契约时实现。
  - 记录 Docusaurus 代码 MIT、官方文档 CC BY 4.0、Meta 商标政策和传递依赖不受框架许可证覆盖的边界；不据此决定本站源码或文章内容许可证。
  - 修正全局规则中“默认选择更保守方案”与用户决策门禁的冲突，并把 `script-src 'none'` 明确为迁移前骨架 CSP，不把它错误沿用到 Docusaurus 目标产物。
- **遗留项**：
  - Docusaurus 具体版本、preset、插件拓扑、直接与传递依赖仍未批准；Pagefind、CMS、身份、评论、分析和监控等调研候选均未选定。
  - 第一次新增依赖前需要确认 lockfile、准入登记、许可证扫描、第三方声明或 SBOM、构建产物和浏览器网络 allowlist 的具体工具与契约格式。
  - 本次未安装依赖、未修改页面或质量脚本，也未操作服务器、DNS、Git 提交、推送或 PR。

## 2026-07-15 — 主站目标框架改选 Docusaurus

- **主题**：在补做开源文档框架调研后，用户基于已有 React 项目和技术栈复用诉求，确认主站从 Astro 改选 Docusaurus。
- **完成内容**：
  - 记录 D-051，以 Docusaurus 替代 D-029 的 Astro 目标，同时保留 Git 内容、静态构建产物交给 Nginx、生产不运行 Node.js 服务的边界。
  - 明确 Docusaurus 标准 React 客户端资源属于框架基线；自定义客户端组件、第三方脚本和外部 SDK 不在本次授权内。
  - 保留已确认的路由、文档站式三栏、稳定 slug、文章领域字段和“项目-模块-主题标签”组织语义；它们与 Docusaurus 原生字段、侧栏和主题的映射继续等待设计。
  - 将当前 `public/` 明确为迁移前骨架，目标改为可重复生成的 Docusaurus 静态制品，确切输出目录仍待发布契约确认。
  - 保留历史 Astro 决策和进度记录，不把框架迁移改写成原决策从未发生。
- **遗留项**：
  - 首先确认 Docusaurus 使用单一 docs 实例、多个 docs 实例，还是 docs + blog；确认前不配置 preset/plugin、内容目录、路由或侧栏生成。
  - 后续再确认版本与依赖锁定、领域字段单向映射、注册表、主题 fit-gap、构建发布契约和新版主站 Spec。
  - 本次未安装 Docusaurus 或 React，未修改页面、依赖、服务器、DNS、Git 提交、推送或 PR。

## 2026-07-15 — 确认内容路由、文档站式三栏与完整编辑模型

- **主题**：用户确认主站项目/文章目录与详情路由、文档站式三栏结构，并选择技术文章的完整编辑模型。
- **完成内容**：
  - 记录 D-031，明确主站项目介绍与未来项目试用子域名的 URL 职责。
  - 记录 D-032，确认左侧目录、中间正文、右侧辅助区的三栏信息结构。
  - 记录 D-033，明确顶部全站导航、左侧同类内容目录、中间正文和右侧页面标题导航的职责分工。
  - 记录 D-034，确认宽屏三栏、中等宽度折叠左栏、窄屏折叠两个目录的渐进式响应策略。
  - 记录 D-035，确认手工英文语义 slug、稳定 URL 和改名时永久重定向的规则。
  - 记录 D-036，确认技术文章采用完整编辑模型，并保留精确字段结构与校验规则的后续决策门禁。
  - 记录 D-037，确认元数据与正文保持单文件、核心字段位于顶层、复杂可选元数据按职责嵌套分组，不使用文章级 sidecar 文件。
  - 记录 D-038，确认技术文章使用必填的顶层显式 `slug` 作为唯一 URL 真相源，文件名和目录不影响公开路由。
  - 记录 D-039，确认技术文章使用必填顶层字段 `publicationStatus` 表示发布可见性，枚举和 `planned` 归属继续保留为决策项。
  - 记录 D-040，确认文章发布状态只包含 `draft`、`published`、`archived`；`planned` 留在路线或选题记录，不进入文章集合。
  - 记录 D-041，确认技术文章使用必填 `authors` ID 列表引用 Git 作者注册表，并与未来账户和编辑权限解耦。
  - 记录 D-042，确认作者注册表采用单一 JSON 对象，并以稳定作者 ID 作为对象键。
  - 记录 D-043，确认本站首个稳定作者 ID 为 `lyty1997`，并将个人作者、站点品牌、未来发布组织和未来账户分层。
  - 记录 D-044，确认作者记录使用必填 `displayName`，首个作者的初始公开名称为 `lyty1997`，且显示名可独立更新。
  - 记录 D-045，确认作者注册表首版只包含 `displayName` 与 `links.github`，并登记已确认的 GitHub 主页。
  - 记录 D-046，确认必填 `title`、单一必填 `summary`、SEO 描述回退顺序，以及防止摘要重复和漂移的机器与评审门禁。
  - 记录 D-047，确认显式 `publishedAt` 与 `updatedAt`、Asia/Shanghai 发布辅助写入、Git 持久化和 CI/构建只读边界。
  - 记录 D-048，确认文章不设主分类，改按“项目-模块-主题标签”组织，且组织关系不进入 URL。
  - 记录 D-049，确认项目与模块各可选且最多一个、模块严格隶属项目、主题必填 1-5 个受控 ID，并规定单一规范目录归属、通用分组和跨项目不重复侧栏规则。
  - 记录 D-050，确认必填 `classification` 是项目、模块和主题组织字段的唯一分组，并禁止顶层或其他分组中的重复来源。
  - 将单页结构改为迁移前现状，把已确认的多页面路由提升为目标信息架构。
  - 标记旧 M0 Spec 中“不增加详情页”和单页布局规则已被替代。
- **遗留项**：
  - 精确响应式断点、目录分组排序和右栏上下文元数据字段尚待通过内容模型与视觉验证确定。
  - 项目/模块/主题注册表结构与路径、通用分组名称、跨项目相关关系字段、发布辅助命令、作者注册表路径、技术文章其余字段、项目字段、构建发布契约、身份和评论方案仍待逐项确认。
  - 未创建路由或页面组件，未安装依赖，未修改生产环境，也未提交或推送 Git。

## 2026-07-14 — 确认解耦目标架构与 Astro 静态生成

- **主题**：用户确认静态主站与未来动态服务解耦，技术分享采用 Git 管理，并选择 Astro 静态输出。
- **完成内容**：
  - 记录 D-027、D-028、D-029、D-030，明确服务职责边界、Astro 静态生成，以及 Markdown 默认、MDX 受控例外的内容格式策略。
  - 新增主站目标架构文档，说明构建、生产、数据所有权、故障隔离、安全隐私和实施门禁。
  - 将原生 HTML M0 技术选型标为已被替代，并把现有主站 Spec 标为需要适配 Astro 后重新评审。
  - 更新内容发布流程，确认 Git 是编辑审核边界、Astro 产物不是人工编辑源，并增加 MDX 组件审核门禁。
- **遗留项**：
  - 文章字段、MDX 组件登记机制、页面路由、Astro/Node 版本、构建发布契约、身份和评论具体方案尚待逐项确认。
  - 未安装 Astro、未迁移页面、未修改生产环境，也未提交或推送 Git。

## 2026-07-13 — 补齐 M0 技术选型、架构视图与主站实现 Spec

- **主题**：用户指出不能在缺少正式技术选型、架构设计和落盘 Spec 的情况下直接进入主站开发与合并。
- **完成内容**：
  - 新增 M0 技术选型决策，比较原生静态、Astro、Next.js、CMS 和运行时服务，确认首版使用语义化 HTML5、原生 CSS、零运行时 JavaScript 与本地静态资源。
  - 新增 M0 主站实现 Spec，定义页面结构、内容状态、视觉令牌、响应式、交互、素材、可访问性、SEO、性能预算、contract 映射和 Definition of Done。
  - 扩展架构概览，补充决策摘要、数据与请求流、信任边界、故障隔离和架构验收。
  - 统一首版内容、SEO 和 DocRestore 展示状态：完整文章与演示视频不阻塞首次上线，M0 必须发布 `robots.txt` 和 `sitemap.xml`。
  - 将 Git 晋级路径固定为在 `dev` 提交并推送、观察 CI、创建 `dev -> main` PR、合并后观察 `main` CI，禁止直接 push `main`。
- **遗留项**：
  - 用户需评审 M0 技术选型和主站实现 Spec；评审前不修改生产 DNS、服务器或主站页面实现。
  - 两个项目的真实视觉证据仍待准备，阻塞生产发布但不阻塞评审后的 HTML/CSS 结构开发。
  - 服务器现场核验、自动发布脚本、Nginx 配置、证书和 DNS 仍属于后续 M0-P/M0-L 实施范围。


## 2026-07-13 — 登记 VibeCoding Project Scaffold

- **主题**：用户要求在主站增加 VibeCoding Project Scaffold，提供 GitHub 仓库和 `main` 生产分支。
- **完成内容**：
  - 只读核对本地 `project-scaffold` 克隆、origin、README、AGENTS、`package.json` 和 Git 历史，确认初始化、质量门禁、CI、Git hooks、Node.js 与许可证等公开事实。
  - 新增 `docs/projects/vibecoding-project-scaffold.md`，定义项目摘要、问题、取舍、证据、源码 CTA、视觉素材和公开边界。
  - 新增 `docs/contracts/projects.json` 作为主站项目目录，统一登记 DocRestore 和 VibeCoding Project Scaffold。
  - 明确该脚手架只展示“查看源码”，不创建子域名、不提供在线体验，也不要求演示视频。
  - 主站内容模型区分项目目录与体验注册表；演示视频调整为可选增强，不再阻塞首版实现。
  - 同步文档索引、内容路线、契约词表、待决策项和生产清单。
- **遗留项**：
  - 主站实现前需为两个项目准备无敏感信息的真实截图或其他视觉证据。
  - 两个项目当前均为 `publicationStatus: planned`，页面代码、DNS 和服务器未修改。

## 2026-07-13 — DocRestore 改为源码与演示视频展示

- **主题**：用户确认 DocRestore 首版不提供在线体验，自有服务器只用于私有运行和录制，主站展示开源仓库与演示视频。
- **完成内容**：
  - 将 DocRestore 设计改为“项目说明 + GitHub + 演示视频”，明确不部署前端、不公开后端、不创建 `docrestore` 或 API 子域名的 DNS、Nginx 和证书。
  - 注册表保留 `docrestore` 名称，同时设置 `onlineExperience: false` 和 `dnsProvisioning: disabled`，防止后续自动化误部署。
  - 定义原生视频播放器、封面、WebVTT 中文字幕、文字摘要、文件大小目标、加载失败回退和移动端/桌面端要求。
  - 增加逐帧隐私与版权审核，禁止视频出现凭证、路径、IP、通知、真实用户文档或其他未授权内容。
  - 主站内容模型新增仓库、视频、封面和字幕字段；路线图不再要求 DocRestore 在线体验作为首版上线条件。
  - 保留未来在线体验的认证、用户隔离、配额、数据删除和后端生产门禁，但全部冻结，不提前实施。
- **遗留项**：
  - 用户需准备无敏感样例、演示视频、封面、中文字幕和文字摘要。
  - 成片完成后需按文件大小和预计访问量复核是否适合随主站静态托管。
  - 本次仍只更新设计文档与契约，没有修改页面代码、DocRestore 代码、DNS 或服务器。

## 2026-07-13 — 登记 DocRestore 并完成独立上线设计

- **主题**：用户提供首个项目 DocRestore 的子域名、仓库、生产分支、前端构建位置和外部重后端边界。
- **完成内容**：
  - 新增 `docs/projects/docrestore-experience.md`，定义 `docrestore.axialmuse.com` 静态前端与建议的 `api.docrestore.axialmuse.com` 独立后端拓扑。
  - 核对 DocRestore 本地仓库，确认 React/Vite 前端从 `frontend` 构建到 `frontend/dist`，API 当前固定为同源 `/api/v1`，上线前需统一支持经过校验的生产 API Origin。
  - 在项目体验注册表登记 DocRestore 为 `planned`、`noindex`；记录 API、WebSocket、上传和认证为未完成的运行依赖。
  - 明确当前单一设备 Bearer token 不是用户登录，且 token/LLM Key 的浏览器持久化、查询参数认证、全局任务与文件能力不能直接用于公网多用户体验。
  - 定义身份授权、用户数据隔离、CORS/WebSocket Origin、上传配额、保留与删除、LLM 数据传输、后端容量和备案的上线门禁。
  - 同步项目体验架构、生产清单、待决策问题、契约词表和文档索引。
- **遗留项**：
  - 用户需确认外部后端的地域、配置、带宽、备案接入状态和维护责任，以及首次开放范围。
  - 需确定身份方案、数据保留/删除、资源配额和 LLM 凭证模式，并在 DocRestore 仓库先更新设计与实现。
  - 当前只完成文档设计，没有修改 DocRestore 代码、DNS、服务器或主站页面，也未开放在线体验。

## 2026-07-13 — 设计项目体验子域名体系

- **主题**：用户要求为各个项目提供独立体验入口。
- **完成内容**：
  - 新增 `docs/architecture/project-experience-hosting.md`，定义 `<project-slug>.axialmuse.com` 的命名、显式 DNS、精确 Nginx、单项目证书、独立发布、隐私隔离和下线流程。
  - 新增 `docs/contracts/project-experiences.json` 作为项目体验注册表，默认静态发布、`noindex`，当前项目列表为空。
  - 主站项目条目只在体验状态为 `live` 且健康检查通过后显示“在线体验”，体验页必须提供返回主站与备案入口。
  - 同步架构概览、站点体验、内容路线、域名部署、自动维护、生产清单、术语和契约词表。
  - 明确 M0 不使用泛解析、泛域名证书、跨子域 Cookie 或共享项目发布权限，动态项目必须单独设计。
- **遗留项**：
  - 用户需提供首批项目名称、期望子域名、仓库地址、生产分支、构建方式、产物目录和是否需要后端或用户数据。
  - 服务器、DNS 和页面代码尚未实施，继续遵循文档先行顺序。

## 2026-07-13 — 确认公开 GitHub 个人主页

- **主题**：用户确认关于区展示 GitHub 个人主页。
- **完成内容**：
  - 将 `https://github.com/lyty1997` 记录为关于区公开身份入口。
  - 明确该入口只是普通公开链接，不涉及密码、Token、私有仓库或管理权限。
  - 关闭公开身份选择未决项，并同步生产清单与站点体验设计。
- **遗留项**：页面代码尚未实现该链接，随 M0-I 主站实现阶段落地。

## 2026-07-13 — 回填上海生产服务器与 ICP 接入事实

- **主题**：用户补充生产服务器、操作系统、用途、ICP备案号和接入状态，并询问关于区公开 GitHub 的含义。
- **完成内容**：
  - 记录生产服务器位于中国上海，运行 Ubuntu Server 24.04 LTS 64bit，当前为空机且专用于本网站。
  - 记录 ICP 备案号 `沪ICP备2026029086号` 和腾讯云接入成功状态，明确首页底部中央展示与工信部查询链接契约。
  - 将已确认事项从上线前未决项移出，保留控制台与服务器只读核验、公安备案和实例运维状态检查。
  - 明确“公开 GitHub”仅指可选的公开主页或仓库链接，不涉及任何凭证、私有仓库或管理权限。
- **遗留项**：
  - 用户需决定关于区是否展示 GitHub 链接。
  - 实施前需核验实例到期与续费、快照、TAT agent、系统现场状态和公安联网备案状态。

## 2026-07-12 — 根据既有腾讯云资源重定生产部署设计

- **主题**：用户确认正式域名为 `axialmuse.com`，已在腾讯云注册并完成中国大陆备案，同时已购买腾讯云轻量应用服务器；据此替换同日早先的 Cloudflare Pages 默认假设。
- **完成内容**：
  - 重写域名与生产发布设计，改为 DNSPod + 轻量应用服务器 + Nginx + ACME，并明确 `https://www.axialmuse.com/` 为 canonical。
  - 设计 GitHub Actions 通过最小权限 CAM 调用固定 TAT command 的发布链路，避免为自动部署向公网开放 SSH；生产版本采用 SHA 不可变目录和原子 symlink 回滚。
  - 补充轻量防火墙、SSH、Nginx、证书自动续期、服务器快照、DNS、备案接入和公安联网备案要求。
  - 重写自动化维护手册，增加服务器更新、磁盘、套餐流量、TAT、证书和备案检查；Nginx access log 默认关闭，错误与认证日志按期限本地保留。
  - 只读公网查询确认权威 DNS 已是 DNSPod，`@`/`www` 当前无 A/AAAA 且父区无 DS；该状态适合作为服务器配置完成前的 DNS 切换基线。
  - 更新架构概览、术语、路线图、生产清单和待决策问题，不创建外部账号、不连接服务器、不修改 DNS。
- **遗留项**：
  - 上线前需核验轻量实例地域、操作系统、镜像、现有服务、到期日、快照能力与 TAT 状态。
  - 需提供或现场读取完整 ICP 备案号，并确认已完成腾讯云接入备案；网站开通后按要求办理公安联网备案。

## 2026-07-12 — 完成主站、域名上线、内容发布与自动化维护设计

- **主题**：在不进入代码实现和供应商实际操作的前提下，为无建站经验的站点所有者建立从网站设计到域名上线和长期维护的完整设计基线。
- **完成内容**：
  - 新增 `docs/product/site-experience.md`，定义首版定位、访问者、M0-M2 信息架构、项目/技术分享/系列内容模型、视觉原则、可访问性、SEO 与隐私边界。
  - 新增 `docs/operations/domain-deployment.md`，形成 GitHub + Cloudflare Pages + Cloudflare DNS 默认方案，写清账户安全、域名选择、Pages v3 与 Node.js 22 构建契约、DNS/HTTPS/DNSSEC 上线顺序、验收、回滚、迁移和中国大陆部署分支。
  - 新增 `docs/operations/content-publishing.md`，定义内容状态、模板、来源、隐私与版权审核、Git 发布、修订和归档流程。
  - 新增 `docs/operations/maintenance.md` 与 `production-inventory.md`，定义自动门禁、定时检查、备份、权限复核、故障分级、恢复手册和非敏感生产事实清单。
  - 更新文档索引、架构概览、术语、内容路线、契约词表和待决策问题；当时将首版默认生产基线收敛到 Cloudflare Pages。该默认假设已在同日后续任务中被用户确认的腾讯云域名、备案和轻量服务器事实替代。
  - 设计参考了 Cloudflare、Google Search Central、工信部等官方资料；没有创建外部账号、购买域名、修改 DNS、部署生产站点或引入第三方脚本。
- **遗留项**：
  - 用户需先评审并回答 `OD-001` 至 `OD-004`，尤其是域名候选和是否要求中国大陆稳定访问。
  - 设计通过后进入 M0-C 内容准备，再按 M0-I、M0-P、M0-L、M0-O 顺序实现和上线。

## 2026-07-09 — 从 project-scaffold 回填工程脚手架改进

- **主题**：`project-scaffold` 是从本项目抽象出去的通用脚手架，抽象后又自行演进出一批改进（配置驱动、健壮性/安全加固、PlantUML 图表门禁）。对照两边差异，只回填"确实缺、确实适合当前阶段"的部分，按本项目真实上下文改写（非字节级复制）。
- **完成内容**：
  - **修复现存规则违规**：`docs/architecture/overview.md` 原用 Mermaid 画架构图，违反全局规则（禁用 Mermaid，强制 PlantUML）；`docs/architecture/dev-workflow.md` 已有 plantuml 时序图但从未编译校验、未渲染 SVG。新增 `scripts/quality/lib/plantuml.mjs` + `check-diagrams.mjs`（编译校验，独立于 `quality` 之外）+ `render-diagrams.mjs`（本地渲染器），用本机 `java -jar plantuml-1.2026.1.jar` 实测编译通过，`docs/diagrams/*.svg` 落地；CI 新增独立 `diagrams` job（下载并 SHA256 校验官方 jar）。
  - **静态站点检查配置化**：新增 `docs/contracts/site-checks.json`，重写 `check-static-site.mjs` 改为读取配置、入口文件不存在时优雅跳过、资源引用正则更健壮（覆盖单/双引号、跳过 data:/mailto:/锚点等）。
  - **CI 加固**：`push` 触发补上 `dev` 分支（此前只在 `main` push 时跑，与"push 到 main/dev 都要观察 CI"的规则不一致）；`actions/checkout`、`actions/setup-node` 升到 v5；quality job 加 `windows-latest` matrix，呼应真实存在的跨机 Windows/Linux 工作流。
  - **跨机预览脚本安全/健壮性修复**：`preview.sh` 新增端口占用保护（`port_listener_pid`/`pid_is_our_server`），避免误认或误杀同端口上的无关进程；`restart-remote.ps1` 新增分支名白名单 + 仓库路径黑名单校验，修复一个真实的远端命令注入面（此前 `$Branch`/`$RemoteRepoPath` 直接拼进 SSH 命令字符串，无任何字符过滤）。两个脚本改为从新增的 `scripts/dev/dev-workflow.env`（gitignored）读取主机/端口/路径，不再硬编码在已提交脚本里。
  - **其它**：新增 `.gitattributes`（跨平台换行归一化）、`CONTRIBUTING.md`、PR 模板加"对应设计文档"字段。
  - **顺带修复一个 `.gitignore` 漏洞**：`.env`/`.env.*` 模式实际不匹配 `dev-workflow.env` 这个文件名（不以 `.env` 开头），已补充显式规则 `scripts/dev/dev-workflow.env`，并用 `git check-ignore -v` 验证生效。
  - **自测证据**：`npm run quality` 全量通过；`PUML_JAR=... npm run check:diagrams` 通过（2 张图编译成功）且 `gen:diagrams` 幂等（二次运行无新改动）；对当前正在运行的真实预览服务（PID 由旧脚本启动）执行 `preview.sh restart`，新脚本正确识别、停止旧进程并重新拉起，`curl` 确认 HTTP 200；模拟删除 `dev-workflow.env` 验证脚本按预期报错退出而非静默使用错误默认值；`restart-remote.ps1` 的分支名白名单正则用一组通过/拒绝样例验证过滤逻辑正确（本机无 PowerShell，未做端到端执行验证，见遗留项）。
- **未采纳（及理由）**：LICENSE、`.claude/rules/*.md` 项目内镜像——已征询用户明确选择不采纳；`docs/architecture/stack-recipes/`——尚未选定具体技术栈，属于为假设的未来需求预先设计，先不引入；`scripts/init.mjs`/`SCAFFOLD.md`——脚手架自身初始化工具，本项目已初始化，不适用；`.claude/hooks/pre-edit-validate.py` 与项目级 `.claude/settings.json`——确认用户全局配置已提供同等校验，属纯冗余；`.claude/skills/sync-shared-rules/`——是 scaffold 作为"规则同步枢纽"角色专属技能，不适合复制进被同步方。
- **遗留项**：
  - `restart-remote.ps1` 的改动未在真实 Windows PowerShell 环境里端到端执行验证（本次会话在 Linux 上完成，只做了语法层面的正则逻辑验证），建议下次在 Windows 端跑一次 `sync.ps1 -RestartPreview` 完整验证。
  - `docs/diagrams/*.svg` 是本机 JVM 字体度量下的渲染产物，不同机器渲染字节可能不同，属预期行为（见 CLAUDE.md 说明），非缺陷。
  - 尚未实际 `git add` + 提交本次改动，也未推送观察 CI（含新增的 `diagrams` job 与 `windows-latest` matrix 是否真的转绿）。

## 2026-07-05（下午）— 验证跨机协同工作流是否满足实际需求，发现并修正环境假设

- **主题**：用户提出四条具体验收要求（Linux 托管+Windows 窗口渲染、Windows 端凭源码与渲染标注自主改代码并推送重启、双向一键同步、双端用 worktree），要求对照 [跨机协同开发预览工作流](architecture/dev-workflow.md) 和已提交脚本逐条验证是否真能做到，而不是只核对代码是否符合设计文档字面描述。
- **完成内容**：
  - **纠正了一个基础假设**：设计文档原先默认"当前 Claude Code CLI 会话＝Linux 托管机"，实测发现本次会话其实跑在 Windows 机器（hostname `lyty-server`，`192.168.0.163`）上，`192.168.0.162` 是局域网内另一台真实、可 ping 通的 Linux 机器。两者不能划等号，已更新设计文档把"托管角色"与"编码会话所在机器"拆开描述。
  - **实测确认渲染机制**：Windows 端 Claude Desktop 已配对 Chrome 浏览器扩展（`allowAllBrowserActions: true`），实测 `list_connected_browsers` 连接为活跃状态，且成功 `navigate` 到局域网预览地址——不需要设计文档原先设想的 Playwright MCP 回退方案。
  - **搭建 Windows→Linux 的 SSH 免密通道**：发现原有 `~/.ssh/known_hosts` 里 `192.168.0.162` 的指纹只代表"连接过"、不代表"能免密登录"（实测公钥认证被拒）。生成专用密钥对 `id_ed25519_axialmuse_preview`（不复用 GitHub 那把），用户手动把公钥装进 Linux 端 `~/.ssh/authorized_keys` 后验证通过。借这个通道现场确认了 Linux 端仓库真实路径 `~/work/personal_projects/AxiomMind/Axial_Muse/AxialMuseWebsite`，以及 `AxialMuseWebsite.preview` worktree、`preview.sh`/`sync.sh` 确实都在（此前 `progress.md` 的记录是真的，只是这次 Windows 端会话看不到）。
  - **新增 `scripts/dev/restart-remote.ps1`**（Windows 端）：SSH 到 Linux 端执行 `preview.sh restart <分支>`，把"改代码→同步→远程重启"收成一步；`sync.ps1` 新增可选开关 `-RestartPreview` 串联这一步。已实测：从分离头指针 `779407e` 成功拉到 `ee7b400` 并重启监听。
  - **发现并修复真实 bug（不是设计层面，是运行时才会暴露的）**：`sync.ps1` 与新写的 `restart-remote.ps1` 最初都是无 BOM 的 UTF-8，Windows PowerShell 5.1 在这台机器（系统默认代码页 GB2312）上解析时把中文注释解码错乱，报一堆无关的语法错误，导致脚本根本跑不起来。改成带 BOM 的 UTF-8 后正常执行，详见 [known-issues.md](../codex-rules/known-issues.md)。这个坑此前的纯代码审查（不实际执行）完全没发现。
  - 之前一轮（逐条核对 `ee7b400` 是否实现了 `4d169a7`/`985e89f` 设计文档的要求）里也顺手修了两处：`sync.ps1` 三条主 git 命令后补了 `$LASTEXITCODE` 检查（此前失败会被静默吞掉）；`preview.sh restart` 调整成先 `checkout_ref`（含 fetch）成功后再杀旧进程，避免网络抖动时把服务停了却起不来。
  - **网络问题已由用户解决并完成最终闭环验证**：Linux 托管机放行了局域网到 8088 端口的访问（原因确认是主机防火墙只放了 22 端口）。放行后 `Test-NetConnection 192.168.0.162 -Port 8088` 从 Windows 端返回 `TcpTestSucceeded: True`；用已配对的 Chrome 扩展重新 `navigate` 到 `http://192.168.0.162:8088/`，标签页标题变为真实的 `Axial Muse`（不再是连接失败的错误页），`get_page_text` 读到实际正文"Axiom Mind / 围绕 AI、知识工作流和个人产品体系的长期项目集合"。至此四条验收要求（Linux 托管+Windows 渲染、Windows 端凭源码与渲染标注改代码并推送重启、双向一键同步、双端 worktree）全部拿到端到端实测证据，不再只是设计层面的判断。
- **遗留项**：
  - `scripts/dev/restart-remote.ps1`（新增）与 `scripts/dev/sync.ps1`/`scripts/dev/preview.sh`（本轮修复）、`docs/architecture/dev-workflow.md`/本文件/`codex-rules/known-issues.md` 的更新目前都还是工作区改动，尚未提交，等待用户确认后提交。

## 2026-07-05 — 落地跨机协同开发预览工作流

- **主题**：按 [跨机协同开发预览工作流](architecture/dev-workflow.md) 设计文档，落地 Linux 端预览基础设施。
- **完成内容**：
  - 从 `main` 切出 `dev` 分支作为开发主干。
  - 新建 Linux 预览 worktree `../AxialMuseWebsite.preview`（分离头指针模式，避免与主目录已检出的分支冲突）。
  - 新增 `scripts/dev/sync.sh` / `scripts/dev/sync.ps1`（双向同步）与 `scripts/dev/preview.sh`（serve/restart/stop/status）。
  - **自测证据**（`preview.sh`，端口 8088）：
    - `serve main` → `curl http://192.168.0.162:8088/` 返回 `HTTP 200`，页面 `<title>Axial Muse</title>` 与 `main` 分支内容一致。
    - 连续 6 轮 `serve` → `curl` → `stop` → `curl` 验证，`stop` 后端口正确释放（发现并修复一处 `pipefail` 导致重试循环失效的 bug，见下）。
    - 重复 `serve` 被正确拒绝（提示先 `stop`/`restart`）；`serve` 不存在的分支报错且不残留进程。
    - `restart`（带分支参数与不带参数复用历史分支）均验证通过。
  - **踩坑记录**：`start_server` 最初用 `$!` 记录 PID，在 `setsid` 因调用方恰好是 process group leader 而内部二次 fork 的场景下，`$!` 拿到的是很快退出的包装进程（zombie 状态下 `kill -0` 仍返回成功），导致 `stop` 杀不到真正的服务；改为从监听 socket（`ss -tlnp`）反查真实 PID 解决。改的过程中还踩了一个 `pipefail` 坑：`grep` 无匹配时以状态 1 退出，直接赋值给变量在 `set -e` 下会让重试循环第一次没找到进程就终止整个脚本，加 `|| true` 后才是真正的"重试"。
  - `sync.sh` 验证时直接执行导致 `dev` 分支被推送到 `origin`（origin/dev 已建立）——这一步应先与用户确认，已如实告知。
- **遗留项**：
  - Windows Claude Desktop 是否原生支持外部局域网 URL 实时渲染与点选标注尚未现场验证（见设计文档"未决事项"），待用户在 Windows 端实测后回填。
  - `scripts/dev/` 三个脚本本身尚未提交到 git。

## 2026-07-03 — 对齐参考项目工程规范

- **主题**：参考 Augur_Maestro 的工程规范，在本项目补齐同构的工程约束。
- **完成内容**：
  - 新增 `CLAUDE.md`，作为 Claude Code 的工作入口，与 `AGENTS.md`、`codex-rules/`、`docs/` 共用同一真相源。
  - 新增本文件 `docs/progress.md` 作为进度真相源，并在 `docs/README.md` 索引。
  - 新增本地 `.githooks/pre-commit`，提交前自动运行 `npm run quality`，作为 CI 的本地镜像。
  - `README.md` 工程规范入口补充 `CLAUDE.md`。
  - 复验 `npm run quality` 四项门禁（Markdown 链接与索引、契约词表、密钥形态、静态站点）全部通过。
- **既有基线**（本次之前已就位）：`AGENTS.md`、`codex-rules/`、`docs/`（架构/契约/产品路线）、`scripts/quality/`、`.github/`（CI、CODEOWNERS、PR 模板）、`public/` 首版静态站点。
- **遗留项**：
  - 仓库尚未 `git init`；CI、分支策略（`main`/`dev`）、CODEOWNERS 均以 git 为前提，需初始化后 pre-commit 钩子才生效。
  - 首版内容页 `public/index.html` 仍为骨架，具体技术分享条目与项目展示内容待按 `docs/product/content-roadmap.md` 填充。

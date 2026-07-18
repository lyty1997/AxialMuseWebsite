# 主站编码规范 Spec

状态：active
完整度：M0-complete
最近更新：2026-07-18
适用范围：本站仓库内的主站页面与组件、Docusaurus 构建期适配、作者工具、质量脚本，以及这些代码之间的依赖边界

## 目的

本文是从上层设计进入实现的工程入口。它只拥有“代码如何组织、依赖和验证”的规则，不复制内容字段、页面结果、基础设施或发布流程的完整语义。

业务与架构行为仍直接引用原真相源及其 D-xxx 决策编号：

- [主站目标架构](../architecture/main-site-target-architecture.md)
- [主站体验与内容架构](../product/site-experience.md)
- [内容发布流程](../operations/content-publishing.md)
- [自动化维护与运行手册](../operations/maintenance.md)
- [域名与生产发布设计](../operations/domain-deployment.md)
- [待决策问题](../architecture/open-decisions.md)

代码、测试和 PR 对领域行为必须引用上层 D-xxx 或具体章节；`CODE-*` 只标识本文拥有的工程规则。上层决定变化时先修改原真相源，只有代码职责或依赖边界随之变化时才修改本文，不建立逐字段人工双写。

## 非目标

本文不拥有以下事项：

- 技术文章、项目、作者、分类、日期、SEO 或发布状态的字段语义与编辑流程。
- 页面文案、路由产品职责、视觉令牌数值、响应式结果和可访问性验收值。
- Docusaurus、Node.js、Action、npm 包、lockfile、lint、formatter、测试或浏览器工具的上层选型、版本与外部准入。
- 生产 workflow 触发、required check 治理、构建交付、服务器、DNS、证书、Nginx、TAT 或回滚流程；本文只拥有实现这些决定所需的内部接口、脚本和测试布局。
- DocRestore、VibeCoding Project Scaffold、未来中央身份、评论或项目服务独立仓库的内部编码规范。

本文只规定本站代码如何尊重这些上层边界。未完成的产品或技术选择不得由实现细节补成默认方案。

## 上层约束到实现映射

本表只记录代码责任和验证落点，不复述源决定的完整语义。实现与测试必须回到来源读取准确规则。

| 上层来源 | 本站代码责任 | 验证层 | 当前状态 |
|---|---|---|---|
| D-027、D-028、D-051、D-053、D-073 | 静态构建边界、框架与冻结安装基线、主站与动态服务隔离、生产制品不依赖 Node.js 请求服务 | 依赖、构建制品与发布冒烟 | 框架基线已确认，迁移与构建契约尚未完成 |
| D-074 | Docusaurus 目标源码使用严格 TypeScript，类型检查与静态构建相互独立 | `tsc --noEmit` 与 Docusaurus build | 目标已确认，依赖、配置与 CI 接线尚未实现 |
| D-075 | 标准入口目录、跨层公共入口、导出与首版路径别名边界 | 源码结构、导入图与模块契约检查 | 目标已确认，目录与自动检查尚未实现 |
| D-076 | 首轮 React/MDX/TypeScript 与类型工具候选直接依赖、官方 `tsconfig` 继承和本站收紧规则 | 依赖清单、锁文件、TypeScript program 与配置漂移检查 | 目标已确认，机器准入、配置和安装尚未实现 |
| D-077 | 官方 registry-only、无脚本 tarball 证据、许可证与脚本处置、SPDX/NOTICE、漏洞阈值、双端点冻结安装和依赖事实防漂移 | 候选解析、供应链证据、人工准入、派生制品、显式审计与双端点检查 | 协议已确认，策略、记录、真实候选图和 CI 接线尚未实现 |
| D-030 至 D-034、D-058、E-002、E-004 | 路由配置、文档站布局、主题与响应式适配 | 路由制品与真实浏览器 | M0 契约已固定，实现与浏览器 fit-gap 尚未完成 |
| D-035 至 D-050、D-078、E-001、E-003 | 领域 schema、注册表、作者与分类引用、日期、可见性和 SEO 页面适配 | 领域契约、构建制品与浏览器 head | M0 schema 与内部实现契约已固定，注册表和元数据组件尚未实现 |
| D-054 至 D-060、D-078 | 单一 docs 实例、唯一判型、校验先行、只读内存投影与公共 API | 纯逻辑单元测试和 Docusaurus 集成测试 | 公共 API 与错误契约已固定，集成尚未实现 |
| D-061 至 D-064、D-078 | 内容根、源码布局、稳定身份、路径、源码相对链接、日期索引与侧栏 | 路径、身份、链接、索引和侧栏契约测试 | 内部契约已固定，历史检查和生成器尚未实现 |
| D-065 至 D-067、D-072、D-078 | 作者显式创建入口、UUIDv7 后端、版本治理和 Linux/Ubuntu 执行边界 | 作者工具、版本契约和 Ubuntu CI | 命令接口已固定，工具与 Node 24 迁移尚未实现 |
| D-052、D-053、D-073、D-077 | 依赖准入、锁文件、冻结安装、供应链、质量和发布必需门禁 | 依赖、制品、浏览器与发布检查 | 首次准入流程与阈值已确认，策略接口、记录、真实候选图、其他质量工具和 CI 接线尚未完成 |
| D-005 至 D-009 及生产发布设计 | canonical/隐私边界、最小权限发布和静态 release 切换 | 真实制品与生产冒烟 | 构建交付契约和服务器现场核验尚未完成 |
| D-015、D-016 及项目体验架构 | 项目展示不得绕过体验状态与独立部署边界 | 注册表、页面制品与发布权限检查 | 当前项目体验不启用 |

## 当前实现画像

下列是 2026-07-18 可从仓库查证的迁移事实，不代表目标工程已经就绪：

- `package.json` 声明 ESM，现有质量脚本是 `.mjs`，只使用 Node.js 内置能力；D-074 不要求迁移这些脚本。仓库尚未安装 Docusaurus 或其他 npm 依赖，也没有 lockfile。
- `public/` 仍是迁移前手写静态入口；`site-content/`、`.nvmrc`、Docusaurus 配置和目标测试目录尚不存在。
- `npm run check:js` 只对 `package.json` 明列的现有质量脚本执行语法检查，不是全仓 lint。
- `npm run check:docs` 检查 Markdown 内链和 `docs/README.md` 索引；`check:contracts` 检查现有契约词规则；`check:secrets` 是有限扩展名与有限模式的启发式扫描，不等于全仓 Secret 证明。
- `check:site` 只验证迁移前 `site-checks.json` 与手写入口；配置或入口缺失时当前会成功跳过，它尚不识别 Docusaurus 输入。
- PlantUML CI 只证明 Markdown 中的源码可以编译，不证明已提交 SVG 与源码同步；刷新 SVG 当前仍需生成命令和人工 diff 审查。
- `.editorconfig` 定义默认 UTF-8、LF、2 空格和末尾换行；`.gitattributes` 对 PowerShell 另有 CRLF 规则，但 EditorConfig 尚无对应例外。两者统一前不得把 PowerShell 文件格式表述为自动一致。

## 编码规则

### CODE-001 真相源依赖

- 已有机器契约的领域常量、枚举和注册信息必须由实现直接消费；只有设计文档的规则必须在单一实现所有者中编码，并由契约测试引用对应 D-xxx，不得在组件、适配器和测试 fixture 中分别复制。
- 测试可以构造最小样例，但断言必须引用对应 D-xxx 或契约文件，不能把 snapshot 变成新的领域真相源。
- 构建制品、缓存和派生索引不得反向写入领域内容；获批索引必须能从当前源内容重建。

来源：D-028、D-055、D-059、D-060、D-064；[主站目标架构](../architecture/main-site-target-architecture.md)。

### CODE-002 逻辑分层与依赖方向

目标实现按职责分成以下逻辑层，并使用 D-075 确认的首版物理映射：

| 逻辑层 | 首版物理位置 | 负责 | 不得负责 |
|---|---|---|---|
| 领域核心 | `src/domain/` | 文章成员判断、领域校验、投影、分类和可见性等确定性规则 | 文件写入、网络、React、Docusaurus 生命周期、进程退出 |
| 构建适配 | 根 `docusaurus.config.ts`、根 `sidebars.ts`、`src/build/` | 文件读取、frontmatter/Docusaurus 回调、配置、本地插件和领域核心装配 | 复制领域规则、修复源内容 |
| 展示层 | `src/components/`、`src/pages/`、`src/theme/` | React 页面、主题和组件，消费已验证的展示输入 | 直接读取源文件、调用 Node.js 文件/进程 API、保存业务数据 |
| 作者工具 | `scripts/author/` | 作者显式创建或日期操作及其文件系统事务 | 被 Git hook、CI、预览、构建或发布隐式调用 |
| 质量与发布 | 质量脚本使用 `scripts/quality/`；仓库发布辅助脚本使用 `scripts/release/`；工作流使用 `.github/workflows/` | 对源和制品做只读校验，返回失败证据 | 生成、补写、暂存、提交或发布内容身份 |

`src/build/` 是受版本控制的构建期源码，不是 Docusaurus 默认静态产物目录 `build/`。`site-content/` 是内容根，不属于源码模块树。首版不增加职责含混的通用 `shared/` 层；出现新职责时先确认归属，不能通过共享目录绕过依赖方向。

构建适配、作者工具、质量与测试等外层可以依赖稳定领域接口；展示层只消费构建适配提供的已验证展示输入，不直接读取源内容。领域核心不得反向依赖外层、框架或 UI。未来服务通过独立网络契约集成，不得成为主站领域核心的模块依赖。跨逻辑层导入必须经过被依赖模块按需建立的显式公共入口，禁止直接导入其内部文件；同一模块内部使用相对导入。没有真实跨层消费者时不创建空 `index.ts` 或占位目录。

来源：D-027、D-053、D-055、D-059、D-060、D-065、D-075；[主站目标架构](../architecture/main-site-target-architecture.md)。

### CODE-003 确定性与副作用

- 领域核心函数必须使用显式输入和返回值；相同输入产生相同领域结果。
- 文件系统、环境变量、进程退出、网络、系统时间和随机数必须留在明确适配边界，不得隐藏在投影、分类或页面渲染中。
- 已确认的作者日期操作和 UUIDv7 创建入口是受控例外，但仍必须通过显式调用进入，不能由构建或预览触发。
- 不得吞掉异常、把失败改为空集合或通过宽泛 fallback 继续构建；适配层汇总错误时必须保留原始原因和上层已要求的源文件定位。
- 领域校验统一返回 `ValidationResult<T>`：成功为 `{ok: true, value}`，失败为 `{ok: false, issues}`。`ContentIssue` 固定包含 `code`、仓库相对 POSIX `sourcePath`、可选点分 `fieldPath` 和面向作者的中文 `message`；不得把堆栈、绝对路径或原始敏感输入写入 issue。
- `code` 使用稳定的 `CONTENT_<SUBJECT>_<REASON>` 大写下划线格式。issues 依次按 `sourcePath`、`fieldPath`、`code` 的 Unicode code point 升序排列；同一输入不得因文件系统枚举顺序产生不同输出。领域值错误聚合后一次返回，I/O、配置损坏和程序错误抛出带 `cause` 的异常，由命令入口统一格式化并以非零状态退出。

来源：D-047、D-056、D-059、D-060、D-065、D-066。

### CODE-004 结构化输入与路径边界

- 目标领域实现处理 JSON、URL、frontmatter 和文件路径时，应使用获批的结构化解析接口，不用字符串拼接代替语义校验。
- 文章成员、schema、投影和侧栏必须消费同一份路径规范化及成员判断结果，不得各自实现近似规则。
- 内容路径统一转换为相对仓库根的 POSIX `/` 分隔形式；输入绝对路径、反斜杠、空段、`.`、`..`、NUL、控制字符或规范化后逃逸预期根目录时失败。Linux 文件名按大小写精确匹配，不做静默大小写归一化。
- `site-content/` 内拒绝符号链接；扫描器必须同时用词法 `resolve`/`relative` 和现存路径的 `realpath` 证明真实包含关系。`writing/<source-name>/` 继续遵守 D-063；项目正文目录名必须与稳定 project ID 完全一致。已进入 Git 的文章 source-name 和 project ID 目录名不得被其他内容复用，当前树与 Git 历史检查共用同一判定函数。
- 迁移前质量脚本中的 Markdown 字符扫描和 HTML 正则是当前有限实现，不构成目标解析方案先例。

来源：D-038、D-058、D-060 至 D-063。

### CODE-005 Node.js 与模块边界

- 修改现有 Node.js 质量脚本时保持 ESM，使用 `import`/`export`；Node 内置模块使用 `node:` 前缀，不混入 CommonJS。
- 当前脚本继续遵守 `package.json` 的 `type: module`；目标 Node 精确版本只由获批后的 `.nvmrc` 提供，不在代码或本文复制 patch 值。
- 目标依赖解析、lockfile 写入权限和最低端点只读边界直接遵守 D-073 与 D-077。只有主端点能在隔离目录生成候选 lockfile；所有正常安装统一使用 `npm ci --ignore-scripts --audit=false`，代码不得通过安装时 fallback、第二种 lockfile、浮动包管理器、隐式 audit 或生命周期脚本绕过该契约。
- Docusaurus 管理的目标源码统一使用严格 TypeScript：站点配置为 `docusaurus.config.ts`，侧栏、生成器、本地插件、构建期适配和无 JSX 模块使用 `.ts`，包含 JSX 的页面、主题覆盖和 React 组件使用 `.tsx`；目标 `tsconfig.json` 必须显式设置 `strict: true`。
- 上述目标范围不得新增 `.js` 或 `.jsx`，除非先按用户决策门禁批准例外。现有和新增的零依赖作者/质量/发布 CLI 使用 `.mjs`，不进入 Docusaurus TypeScript program；React、领域和构建源码不得借此回退为 JavaScript。
- 目标根 `tsconfig.json` 必须继承精确 `3.10.2` 的 `@docusaurus/tsconfig`，并显式设置 `baseUrl: "."`、`ignoreDeprecations: "6.0"`、`strict: true` 与 `allowJs: false`。首轮 `include` 只能包含根 `docusaurus.config.ts`、根 `sidebars.ts`、`src/**/*.ts` 与 `src/**/*.tsx`；`.mjs` 作者/质量/发布 CLI 不加入该 program。`tests/**/*.ts` 使用独立 `tests/tsconfig.json` 继承根配置并只增加测试输入，不扩大生产源码入口；实际 runner 及其类型只有通过依赖准入后才能接入。
- `module: "esnext"`、`moduleResolution: "bundler"`、`noEmit: true` 与 `skipLibCheck: true` 由上述精确官方基线拥有，本站 `tsconfig.json` 不重复声明。官方基线变化必须作为依赖升级 diff 审查，不能静默接受新的解析或检查行为。
- Node.js 专用模块不得进入浏览器 bundle；展示层不得导入 `node:fs`、`node:path`、`node:process`、`node:child_process` 或作者工具。
- `docusaurus.config.ts`、`sidebars.ts` 及其 Node.js 侧模块不得导入浏览器 API、React 或 JSX。
- 默认导出只用于 Docusaurus 实际加载的框架入口：站点配置、侧栏文件、文件路由页面、主题覆盖和独立本地插件构造器。插件静态方法按框架契约具名导出；其他内部可复用模块只使用具名导出。
- 跨层公共入口必须逐项写明 `export { ... }` 与 `export type { ... }`，不得使用递归或宽泛 `export *` 聚合内部实现。公共入口只暴露真实消费者所需的稳定符号，不作为全目录镜像。
- 首版不配置 `@/`、`@domain`、`@components` 等自定义路径别名，也不在项目 `tsconfig.json` 增加自定义 `paths`。Docusaurus 官方基线提供的 `@site/*` 只在其文档定义的框架语义下使用；`baseUrl` 不允许业务裸导入，也不得借 `@site/*` 或其他官方别名绕过跨层公共入口。主题包装只在 E-004 的真实 fit-gap 门禁通过后使用框架官方别名。
- 目标 `typecheck` 入口显式执行 `tsc --noEmit`，不能只依赖继承的 `noEmit`，也不能由 Docusaurus build 替代。`baseUrl` 与 `ignoreDeprecations: "6.0"` 只允许作为 Docusaurus 3.10/TypeScript 6 的成对过渡配置；升级 TypeScript 7、Docusaurus 4 或更换官方基线前必须重新审查，不能把忽略弃用扩展到其他选项。
- 领域内容实现使用 `src/domain/content/`，其唯一跨层入口为 `src/domain/content/index.ts`。首版入口只导出 `normalizeContentPath`、`classifyContentPath`、`validateProjectCatalog`、`validateArticleSource`、`buildProjectNavigation`、`buildWritingNavigation`、`buildArticleDateIndex`，以及这些函数直接使用的 `ValidationResult`、`ContentIssue` 和输入/输出类型；不得导出文件读取器或 Docusaurus 类型。
- Docusaurus 装配使用 `src/build/content/`，其唯一跨层入口为 `src/build/content/index.ts`，只导出 `loadValidatedContent`、`createParseFrontMatter`、`createSidebarItemsGenerator` 和 `createContentDataPlugin`。文件读取和框架对象转换留在该层；领域入口不得反向导入它。
- 非 React `.ts` 文件使用 lowercase kebab-case；React 组件、组件文件和目录使用 PascalCase；hook 使用 `useXxx.ts`；类型使用 PascalCase，函数和变量使用 lowerCamelCase，布尔值使用 `is`/`has`/`can`/`should` 前缀，只有真正跨调用恒定的值使用 `UPPER_SNAKE_CASE`。测试文件使用与被测模块同名的 `.test.ts`，fixture case 目录使用 lowercase kebab-case。
- 模块边界由零第三方依赖的 `scripts/quality/check-module-boundaries.mjs` 检查，并纳入共享 `quality` 入口与 Ubuntu required check；它至少拒绝跨层深层导入、`export *`、自定义路径别名、浏览器层导入 Node 内置模块及领域层导入 React/Docusaurus。CI 接线是实施任务，不再重新选择这些规则。

来源：D-066、D-067、D-072 至 D-077；当前 `package.json` 和 `scripts/quality/`。

### CODE-006 静态渲染与客户端副作用

- 主站静态内容必须能在无运行时 API 的构建路径中完成渲染；页面不得靠客户端 fetch 才获得文章、项目或导航主体。
- 模块初始化和静态渲染阶段不得直接访问 `window`、`document`、浏览器存储或其他仅客户端对象。
- 获批的客户端行为必须放在明确的客户端边界内，并在 hydration 后执行；不得把第三方请求、数据采集或业务状态藏入通用布局组件。
- 按 E-004 优先使用 Docusaurus 官方配置、Infima 和 CSS；默认不 Swizzle、不 eject。只有真实浏览器 fit-gap 证明这些扩展点无法满足已确认的三栏或可访问性契约时，才允许在精确锁定版本上包装一个最小主题组件，并为该包装增加集成与浏览器回归测试。

来源：D-027、D-029、D-051、D-053；[主站体验与内容架构](../product/site-experience.md)。

### CODE-007 React 组件职责

- 页面和组件只消费显式 props、Docusaurus 已验证元数据或获批上下文，不在渲染过程中解析源文件或重建领域校验。
- 可复用展示组件不得包含项目专属 API、身份、评论或上传逻辑；未来动态能力通过独立集成层进入。
- 普通 Markdown 不得导入组件；MDX 只能从 `src/components/mdx/index.ts` 的显式具名导出中引用仓库内组件，该入口就是首版机器白名单，不再维护第二份手工组件清单。新增导出必须在同一 PR 说明普通 Markdown 不足之处、是否 hydration、外部请求与失败表现；默认组件必须静态可读且不发起网络请求。
- 可复用组件模块使用具名导出；只有 `src/pages/` 文件路由入口与 `src/theme/` 主题覆盖按 Docusaurus 入口契约使用默认导出。每个复用组件位于 `src/components/<PascalCase>/`，实现为 `<PascalCase>.tsx`，局部样式为 `<PascalCase>.module.css`，按真实消费者需要建立 `index.ts`；hook 放在所属组件目录，只有跨组件复用时才进入 `src/components/hooks/`。

来源：D-027、D-029、D-052、D-075；[内容发布流程](../operations/content-publishing.md)。

### CODE-008 样式与资源

- 组件必须消费经产品 Spec 确认的视觉令牌和响应式结果，不得在本规范复制色值、断点或排版数字。
- 全局设计令牌、Infima 变量覆盖和极少量语义元素基线只写入 `src/css/custom.css`；所有本站自定义 CSS 变量使用 `--am-` 前缀。页面和组件样式使用同目录 CSS Modules，禁止把页面布局或组件状态选择器加入全局文件，也禁止 `!important` 作为常规覆盖手段。
- CSS Module 类名使用 lowerCamelCase；状态优先用语义属性或 `data-*`，不把颜色名、像素值或 DOM 层级写入类名。页面样式与入口同目录，例如 `src/pages/projects/index.module.css`。E-004 的三个响应式区间是唯一布局断点来源；局部组件若确需额外容器条件，优先 container query，并以无溢出浏览器证据约束。
- 内容正文同目录资源使用 `site-content/<type>/<entry>/assets/`；列表预览、品牌和跨页面稳定静态资源使用 `static/assets/`。两类资源不得互相复制；文件名使用 lowercase kebab-case 并保留有意义扩展名，注册表或 Markdown 必须显式引用，孤儿资源使质量门禁失败。
- 本地资源必须使用可由构建和质量门禁解析的路径；运行时第三方字体、图片、脚本、播放器或远程资源必须先完成依赖、许可、隐私和网络请求决策。
- UI 代码必须满足产品文档中的语义 HTML、键盘、文本缩放、动效和无重叠要求；验收值直接引用产品文档，不在本文复制。

来源：D-025、D-034、D-052；[主站体验与内容架构](../product/site-experience.md)。

### CODE-009 文件、注释与局部修改

- 普通文本文件遵守根 `.editorconfig`；Git 存储换行遵守 `.gitattributes`。两份配置出现差异时先说明实际行为和验证结果，不把其中一份静默当作全部平台事实。
- 修改只格式化任务涉及的范围，不在功能变更中混入无关的全文件重排。
- 注释默认使用简体中文，只解释必要的原因、边界和非显然契约，不复述代码步骤。
- formatter、lint、导入顺序和自动修复策略完成决策后由可执行配置负责，本文只保留不能被工具改变的工程边界。

来源：当前 `.editorconfig`、`.gitattributes`；[贡献指南](../../CONTRIBUTING.md)。

### CODE-010 依赖、安全与数据

- D-073 与 D-076 明列的包名和 manifest 版本表达共同构成当前获准进入供应链审查的直接清单；具体清单只从这两个上层决定读取，本文不维护第二份版本表。未来唯一 `package-lock.json` 必须精确冻结所有范围的实际解析结果，代码、脚本或模板不得另设依赖版本来源。
- 上述候选仍须在实际安装前按 D-077 对真实直接与传递图取得准入结论。首次候选只允许来自官方 npm registry，拒绝 Git、`file:`、本地目录和任意远程 tarball 来源；不得用镜像、替代源或手工改写 `resolved` 绕过来源检查。
- 供应链策略代码首版只使用 Node.js 内置能力，可调用 Ubuntu `tar` 检查精确 lockfile tarball；不以新增扫描器依赖解决扫描器自身的准入。策略必须在不执行包代码或脚本的条件下校验 integrity、实际 `package.json`、许可证文件、NOTICE 与生命周期脚本内容。
- 许可证证据缺失、未知、推测性、复杂或未获准时失败并暂停人工决定。依赖生命周期脚本默认拒绝；若候选确有构建必要性，只能携带精确 `name@version`、脚本内容、风险与证据重新取得用户确认，不能提供包名模式或全图开关式放行。该阶段只形成许可证与脚本人工预审，不得在漏洞门禁通过前形成最终准入结论。
- `package.json` 只拥有直接依赖意图，`package-lock.json` 只拥有完整解析图；人工准入记录只拥有不能稳定派生的用途、许可证澄清、脚本处置、义务和决策编号。SPDX JSON SBOM 与 `THIRD_PARTY_NOTICES` 必须从 lockfile 和 tarball 证据生成并做漂移检查，不得被手工维护成第二份依赖清单。
- 显式 `npm audit` 必须覆盖完整依赖图和开发依赖；`moderate`、`high`、`critical` 阻断，`low` 报告，禁止 `npm audit fix`，registry/audit 不可用时失败关闭。该构建期请求会把包名和版本发送给官方 npm registry，回退协议可能包含完整 lockfile 树及 npm/Node/平台/架构/环境元数据；不得向审计请求加入站点内容或访问者、账户、评论数据，也不得把它变成浏览器请求。
- 漏洞门禁和最终人工准入都通过后，主端点和最低端点必须用同一 manifest、lockfile 与项目 npm 配置执行 `npm ci --ignore-scripts --audit=false`，并通过执行前后哈希证明 `package.json` 与 `package-lock.json` 未变化；最低端点只验证兼容性，不生成发布制品。
- `clsx`、`prism-react-renderer`、`@types/node`、`@types/react-dom` 及模板、主题或未来源码中的其他包未获新增直接依赖授权；出现真实用途时重新准入，作为候选传递依赖出现时也不能跳过审查。除此之外的 npm 包、Docusaurus 插件、Action、浏览器 SDK、iframe、远程模块或外部服务，在完成逐项准入、记录和用户确认前不得加入。
- 仓库、日志、fixture、截图和静态制品不得包含真实凭证、个人隐私数据、客户数据或未公开商业信息。
- 测试数据使用明确虚构的最小样例；不能用真实账户、token、生产响应或本机隐私路径换取测试便利。
- 新增浏览器外部请求或用户数据处理必须先完成上层安全、隐私、用途、保留和删除决策，不得作为组件实现细节混入。

来源：D-009、D-052、D-053、D-073、D-074、D-076、D-077；[主站目标架构](../architecture/main-site-target-architecture.md)。

### CODE-011 测试分层

测试能力按风险分层。测试源码统一放在根 `tests/`，按 `domain/`、`build/`、`browser/` 和 `fixtures/` 分责；具体第三方测试或浏览器工具只有通过 D-077 后才能写入 manifest 和 lockfile，但这不改变以下目录与证据契约：

| 层级 | 负责验证 | 不应作为唯一证据 |
|---|---|---|
| 领域单元 | 纯规则、边界值、失败分支和无副作用 | 大型 snapshot |
| 适配集成 | Docusaurus 扩展点、输入装配、框架元数据与领域核心协作 | mock 出全部框架行为 |
| 构建制品 | 路由、链接、SEO、可见性、资源、外部请求和 CSP | 仅检查源配置文本 |
| 真实浏览器 | UI、键盘、响应式、可访问性和 hydration | 仅截图像素或仅 DOM snapshot |
| 发布冒烟 | 精确制品、HTTPS、重定向、关键页面与资源 | 本地开发服务器结果 |

- 每个测试必须能指向对应 D-xxx、上层章节或 `CODE-*` 工程规则。
- 修复已复现缺陷时应增加能在修复前失败、修复后通过的回归验证。
- UI 或构建页面输出变更必须运行真实浏览器验证；纯文档、纯质量脚本或不影响页面输出的领域变更不因此强制浏览器测试。
- 领域和构建测试不得写入真实 `site-content/`。内容 fixture 固定放在 `tests/fixtures/content/<case-name>/`，每个 case 使用自含的 `site-content/` 与 `docs/contracts/` 最小树；临时输出只能写入测试进程创建的系统临时目录，并在结束时清理。
- fixture 只使用 `example.test`、固定的合法 UUIDv7、固定日期和明确虚构文本，不包含本机绝对路径、真实账户或凭证。预期结果使用小型结构化 `expected.json` 或字段断言；禁止把整页 HTML、整棵 Docusaurus 数据或大 snapshot 当作主要契约。
- 错误 fixture 以稳定 `ContentIssue.code`、相对路径和字段路径断言，不锁定整段中文 message；排序 fixture 必须故意打乱文件系统输入顺序，证明结果仍确定。

来源：D-053；[自动化维护与运行手册](../operations/maintenance.md)。

### CODE-012 质量入口与评审

- 修改后运行与风险相称且当前可用的本地门禁；不得把当前有限扫描表述为已经覆盖未来 `.ts`、`.tsx`、`.mdx`、样式、Docusaurus 制品或全部 Secret 形态。
- Docusaurus 目标源码必须独立运行 `tsc --noEmit`，Docusaurus build 必须独立验证框架加载和静态制品；两项都是发布必需门禁，任一成功都不能替代另一项。当前仓库尚未接入这两个目标门禁，`npm run quality` 通过不构成完成证据。
- 目标质量门禁必须通过 `scripts/quality/check-module-boundaries.mjs` 失败关闭验证 D-075 的物理层边界、禁止的跨层深层导入、宽泛 `export *` 和未批准自定义路径别名。首版不提供通用忽略开关；框架入口的默认导出和官方别名例外在检查器中按精确路径编码并由 fixture 覆盖。当前仓库尚无该脚本，实施前不能宣称已覆盖。
- 目标质量门禁还必须失败关闭执行 D-077 的候选来源、tarball/integrity、许可证与脚本、SPDX/NOTICE 漂移、显式 audit、双端点冻结安装和 manifest/lock 前后不变检查。当前 `npm run quality` 尚不包含这些能力，其通过不构成供应链准入证据。
- 新增一种源码或制品类型时，必须在同一实施阶段把它纳入获批的 lint、类型检查、测试、Secret、许可证和制品检查；D-074 已固定 `tsc --noEmit` 与 Docusaurus build，D-077 已固定首次供应链准入工具组合和阈值。D-078 允许 Agent 根据真实用途选择其余工具和 CI job 编排，但任何新增包、Action 或联网行为仍须先通过既有供应链与外部操作门禁。
- 合入和发布以前必须以 Ubuntu CI required checks 为准；本地 hook 只提供快速反馈。
- UI 变更附真实浏览器证据；依赖、浏览器请求和数据处理变化必须在 PR 中单独披露。
- PR 必须说明解决的问题、引用的 D-xxx 或 `CODE-*`、修改边界、验证结果和未覆盖风险。实现发现上层决定不足时停止依赖部分并回到决策流程。

来源：D-052、D-053、D-072 至 D-077；[自动化维护与运行手册](../operations/maintenance.md)。

### CODE-013 派生索引与侧栏

- 构建期文章日期索引由 `buildArticleDateIndex` 从已经通过 schema 的 `published` 与 `archived` 文章派生；每项精确包含 `articleId`、`slug`、`publishedAt`、`updatedAt`，按 `articleId` 的 ASCII 升序序列化。M0 仅在构建内存和 Docusaurus generated files 目录中使用 `axial-muse/article-date-index.json`，不得提交、复制到 `static/`、暴露为公开路由或进入浏览器 bundle；draft 不进入索引。
- `sidebars.ts` 的两个稳定 key 固定为 `projectsSidebar` 与 `writingSidebar`，分别只声明 `projects` 和 `writing` 的 autogenerated slice。`createSidebarItemsGenerator` 根据 slice 的 `dirName` 分流，并直接使用当前构建提供的 `docs[].id`；不得手工拼接、提交或缓存 doc ID 清单，也不得把同一 doc 作为 `type: 'doc'` 放进两个侧栏。
- 项目侧栏只包含 `published` 与 `archived` 项目，按 `navigationOrder` 升序排列；项目 ID 仅作为已被唯一性门禁兜住的确定性末级 tie-breaker。列表页消费同一 `buildProjectNavigation` 结果，不单独排序。
- 技术分享侧栏先显示虚拟“通用技术”组，再按项目 `navigationOrder` 升序显示项目组；项目根级文章先于模块，模块按自身 `navigationOrder` 升序。每个叶组内按 `publishedAt` 降序、`articleId` 升序排列，`archived` 以状态标记而不建立第二套排序。开发预览的 draft 只进入末尾独立“草稿”组，按可选 `updatedAt` 降序再按 `articleId` 升序，并且整个预览制品保持 `noindex`。
- `classification` 是文章规范侧栏位置的唯一来源；topics、`relations`、recommendation、文件路径和 slug 都不增加第二位置。生成器必须拒绝未知项目/模块、一个 doc 缺失或重复、注册表条目与 `docs[]` 不能一对一关联及同级顺序冲突。
- `/projects/`、`/writing/` 页面只消费上述已验证导航模型。详情页右栏继续由当前正文 `H2/H3` 静态目录生成；标题数量不足时不补造条目。SEO 标签由 `src/components/SeoMetadata/` 的单一组件合并 title、两条 description 回退、canonical 与 Open Graph，禁止页面和主题各自追加同名标签。

来源：D-033、D-040、D-046、D-049、D-054、D-064、D-078、E-001 至 E-004。

### CODE-014 作者命令

- 新文章入口固定为 `npm run content:new -- --source-name <name> --title <text> --slug </writing/...> --summary <text> --author <id> --topic <id>`，实现文件为 `scripts/author/create-article.mjs`。`--author` 与 `--topic` 可重复，`--project`、`--module` 可选。M0 只创建 `index.md`，不提供 `--format` 或 MDX 快捷入口；未来 MDX 白名单出现真实获批组件后再扩展命令。
- 命令只接受完整非交互参数，先验证全部字段、注册表引用、目标目录不存在、精确 Node 版本和历史名称不可复用，再取得排他作者锁，在同一文件系统的 `site-content/.author-staging-*` 临时目录写入完整 `index.md` 与 UUIDv7，flush 文件和目录后把整个临时目录原子 rename 为目标目录。任一步失败都删除本次临时目录并释放锁；质量、预览和构建发现作者锁或残留 staging 时失败，不读取半成品。不得覆盖、修复或补写既有文章。
- draft 模板不填写 `publishedAt`，不从系统时间、UUID、标题或路径推导任何业务字段；`updatedAt` 也不由创建命令自动写入。命令不运行 Git add/commit/push，不调用发布、预览或构建，也不得被 CI、hook 或 Docusaurus 隐式调用。
- UUIDv7 文本校验同时检查规范小写连字符形式、version 7、RFC variant、当前树唯一和 Git 历史未复用；历史只读检查由 `scripts/quality/check-content-history.mjs` 统一拥有，创建命令调用同一核心规则而不复制正则或 Git 扫描算法。

来源：D-047、D-062 至 D-067、D-072、D-078。

### CODE-015 供应链证据与发布封装

- 供应链可编辑策略位于 `docs/contracts/dependency-policy.json`，只编码 D-052/D-077 已确认的来源、许可证类别、漏洞阈值、脚本默认拒绝、双端点和报告保留规则；精确包人工结论位于 `docs/contracts/dependency-admissions.json`，以 `name@version` 为键，只记录用途、许可证澄清、脚本处置、义务、证据摘要和决定编号。两者都拒绝未知字段。
- 零第三方依赖入口固定为 `scripts/quality/check-supply-chain.mjs` 和 `scripts/quality/generate-supply-chain-artifacts.mjs`，共享实现位于 `scripts/quality/lib/supply-chain/`。前者只读检查 manifest、lockfile、registry 来源、integrity、准入记录与派生制品漂移；后者只在 D-077 获准的隔离审查步骤中读取精确 tarball 证据并生成派生结果，不修改 manifest、lockfile 或人工准入记录。
- 提交的派生证据固定为 `docs/generated/supply-chain/dependency-evidence.json`、`docs/generated/supply-chain/sbom.spdx.json` 和仓库根 `THIRD_PARTY_NOTICES`。生成器输出稳定排序且不写系统时间、本机路径或临时下载位置；tarball 本体、npm cache 和原始 audit 响应不提交。
- 候选解析与 tarball 审查的原始日志、显式 audit JSON 和双端点安装证明作为受限 CI artifact 保留 30 天；报告不得包含 registry 凭证、环境 Secret 或站点内容。准入结论、lockfile、派生证据和 PR 审查记录提供长期追溯，不用延长原始 tarball 保存期。
- Docusaurus 仍只输出默认 `build/`。`scripts/release/package-site.mjs` 在 `dist/release/` 建立临时交付包：`payload/` 是 `build/` 的逐文件复制，`metadata/release.json` 保存固定 schema version、仓库标识、40 位 commit SHA、payload 根和文件清单摘要，`metadata/files.sha256` 保存按相对 POSIX 路径排序的 SHA-256；不得写构建时间、runner 路径或分支浮动名。
- 封装器拒绝符号链接、特殊文件、绝对/父级路径、重复规范化路径、大小写冲突和封装期间源文件变化。`scripts/quality/check-release-package.mjs` 必须从空状态重新计算 `payload/` 清单，并证明它与 `build/`、metadata 和 commit SHA 一致；`dist/` 不提交，也不成为编辑或缓存真相源。
- GitHub artifact 名称固定为 `axial-muse-site-<40-char-sha>`，只上传 `dist/release/`，保留 30 天。服务器先验证 GitHub 元数据与 artifact digest，再验证内部 metadata 和文件清单，只把 `payload/` 原子安装为 `releases/<sha>`；metadata 不进入 Nginx Web Root。

来源：D-052、D-053、D-077、D-078、E-005；[域名与生产发布设计](../operations/domain-deployment.md)。

### CODE-016 M0 工具最小集

- 首版不为格式化或通用 lint 新增第三方包。严格 TypeScript、`scripts/quality/check-module-boundaries.mjs`、结构化 schema/路径检查、现有文档/Secret/PlantUML 门禁和 `git diff --check` 共同承担静态检查；发现这些检查无法表达的真实缺陷类别后，再提出对应工具候选并进入 D-077。
- 领域与构建期纯逻辑测试优先使用 Node 24 内置 `node:test`。`tests/tsconfig.json` 以 Node ESM 方式把测试及其受测 TypeScript 编译到进程创建的临时目录，随后执行 `node --test` 并删除输出；生产 `build/`、源码和内容树不接收测试产物。若精确依赖图证明 Node 类型声明不能由已批准直接清单满足，必须把 `@types/node` 作为有真实源码用途的新直接候选重新走 D-077，不能依赖偶然提升的传递包。
- M0 不在依赖准入前引入 Vitest、Jest、jsdom、Playwright 或可访问性扫描包。React 页面由严格类型、Docusaurus build、构建制品检查和真实 Chrome 的键盘/响应式/网络/控制台人工验收覆盖，截图随 PR 保存；这不是对未来自动浏览器回归工具的永久禁止。
- npm 入口固定为 `typecheck`、`test`、`build`、`check:artifact` 和聚合 `quality`。`quality` 运行只读静态检查、类型检查、测试和 Docusaurus build，但不解析依赖、不下载 tarball、不执行 audit、不封装或发布 release；供应链审查和 `package:artifact` 是显式独立入口，避免普通质量检查产生外部副作用。
- Ubuntu CI 的发布必需 job 固定为 `website-quality`（精确 `.nvmrc`，执行冻结安装与 `quality`）、`node-minimum`（兼容下限，同一共享负载但不上传制品）、`diagrams`（精确 `.nvmrc`，编译并核对 PlantUML SVG）和 `supply-chain`（静态证据漂移、显式全图 audit 与 manifest/lock 不变）。`production-artifact` 只在 `main` 精确 SHA 且四项成功后运行 `package:artifact` 并上传，不作为 PR 的空跑 required check；`deploy-production` 再受 production environment 和操作授权控制。Action 必须在实施时按准入结果固定完整 commit SHA，不能把浮动 tag 写入最终 workflow。

来源：D-053、D-074、D-077、D-078；CODE-003、CODE-010 至 CODE-012。

## 实施前置清单

下列内容影响目标源码结构，必须在依赖代码创建前完成事实查证并写入对应设计。D-078 委托范围内的工程细节由 Agent 形成可验证决定，不再逐项请求用户确认；D-078 排除的外部操作、依赖最终准入、数据与基础设施事项仍执行用户门禁：

1. D-073 至 D-077 已确认框架与冻结安装、严格 TypeScript、模块边界、首轮候选清单及首次供应链准入协议；实际安装前仍须实现 D-077 策略与记录，对真实候选 lockfile 和传递图取得人工通过结论，生成并校验 SBOM/NOTICE，完成显式 audit、双端点失败关闭验证、制品网络检查和浏览器 allowlist。
2. 按 CODE-002 至 CODE-005 创建并机器校验实际 `tsconfig`、公共入口、命名和模块边界脚本；这些是实现任务，不再重新选择目录和 API 契约。
3. 接入 `tsc --noEmit` 与 Docusaurus build，并依据 D-078 选择 formatter、lint、测试、真实浏览器与可访问性工具；新增第三方包或 Action 必须先通过 D-077，不因工具选择已委托而跳过实际准入。
4. 按 E-004 和 CODE-006 至 CODE-008 实现 React、Infima、CSS Modules、令牌与资源边界；只有浏览器 fit-gap 证据允许最小主题包装。
5. 按产品字段表和 CODE-003、CODE-004、CODE-014 实现完整 schema、注册表、路径、错误、作者命令、UUID 历史检查和迁移；公开业务事实和素材仍须由用户提供或确认。
6. 按 CODE-013 实现日期索引、侧栏、列表模型和 SEO 标签合并；构建命令、产物目录与制品交付由 D-078 下的构建发布设计落盘后实现，不授权实际发布或基础设施操作。
7. Ubuntu nvm 与 Action 固定、Node 24 两个版本入口、共享负载、required check 和迁移顺序。

这些事项未完成时，可以维护迁移前静态页、现有质量脚本和设计文档；不得据此创建 Docusaurus 工程骨架、目标内容树或对外宣称目标门禁已经实现。

## 可执行覆盖矩阵

| 规则或事实 | 当前证据 | 自动化状态 |
|---|---|---|
| 文档索引与内部链接 | `npm run check:docs` | 已自动化 |
| 现有契约词规则 | `npm run check:contracts` | 已自动化，范围有限 |
| 现有质量脚本语法 | `npm run check:js` | 已自动化，仅明列 `.mjs` |
| 常见密钥形态 | `npm run check:secrets` | 已自动化，启发式且扩展名有限 |
| 迁移前手写入口 | `npm run check:site` | 已自动化，缺失输入会跳过 |
| PlantUML 源码可编译 | Ubuntu `diagrams` job 或本地 `check:diagrams` | 已自动化 |
| PlantUML SVG 已刷新 | `gen:diagrams` 后人工 diff | 尚无稳定门禁 |
| 通用文件卫生 | `.editorconfig`、`.gitattributes` | 仅配置约定，尚无 CI 检查 |
| 严格 TypeScript 与独立类型检查/构建 | D-074 设计契约 | 目标已确认，当前未实现 |
| 模块目录、公共入口、导出与别名边界 | D-075 设计契约 | 目标已确认，目录和自动检查均未实现 |
| 首轮直接依赖与 `tsconfig` 基线 | D-076 设计契约 | 目标已确认，供应链准入、lockfile、配置与安装均未实现 |
| 首次依赖解析与供应链准入 | D-077 设计契约 | 协议与阈值已确认，策略、记录、真实候选图、派生制品、审计和 CI 均未实现 |
| Docusaurus/React/内容/制品/浏览器契约 | D-078、E-001 至 E-004、CODE-003 至 CODE-014 | 目标已固定，当前未实现 |
| Node 24 精确与最低端点 | 无 `.nvmrc` 或目标 job | 阻塞 |

## 本 Spec 验收

- 本文只拥有代码级职责，不复制上层字段表、页面数值、发布步骤或基础设施命令。
- 每条 `CODE-*` 都给出上层或当前仓库来源；领域测试继续直接引用 D-xxx 与原契约。
- 当前能力、目标约束和实施阻塞明确分开，不把迁移前脚本的有限行为包装为目标方案。
- 新文档已进入 `docs/README.md`，现有 Markdown 内链、契约词、Secret 和静态入口门禁通过。
- 本文不新增第三方依赖、浏览器外部请求或用户数据处理。

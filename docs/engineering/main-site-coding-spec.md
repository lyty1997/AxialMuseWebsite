# 主站编码规范 Spec

状态：active
完整度：M0-design-closed（#9 的 E-010 已闭环；#5 至 #8、#10 至 #14 继续跟踪）
最近更新：2026-07-19
适用范围：本站仓库内的主站页面与组件、Docusaurus 构建期适配、作者工具、质量脚本，以及这些代码之间的依赖边界

## 目的

本文是从上层设计进入实现的工程入口。它只拥有“代码如何组织、依赖和验证”的规则，不复制内容字段、页面结果、基础设施或发布流程的完整语义。

2026-07-18 审查确认的实施契约矛盾由 GitHub Issues #5 至 #14 跟踪。E-006 至 E-015 已补齐内容所有权、主预览、发布态素材、草稿预览、npm 隔离、SPDX 确定化、Node ESM 测试、完整 Git 历史门禁、同版本服务端 301 和 production job 字节所有权；#9 已完成 E-010 实现、fixture 与真实双端点验收，#5 至 #8、#10 至 #14 继续跟踪其余实现，不再代表活动设计缺口。D-078 的委托和已确认上层方向继续有效，但不能代替依赖准入、实现与验证。

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
| D-076、D-079 | 首轮 React/MDX/TypeScript、Node 测试类型候选直接依赖、官方根 `tsconfig` 继承和本站收紧规则 | 依赖清单、锁文件、生产/测试 TypeScript program 与配置漂移检查 | 候选目标已确认，真实依赖准入、配置和安装尚未实现 |
| D-077、E-010、E-011 | 官方 registry-only、启动前 npm 隔离、无脚本 tarball 证据、许可证与脚本处置、确定性 SPDX/NOTICE、漏洞阈值、双端点冻结安装和依赖事实防漂移 | 候选解析、隔离配置、供应链证据、人工准入、派生制品、显式审计与双端点检查 | E-010 隔离入口、版本契约和离线双端点 CLI 已实现；E-011、策略、记录、真实候选图和目标 CI 拓扑尚未实现 |
| D-030 至 D-034、D-058、E-002、E-004、E-014 | 路由配置、文档站布局、主题与响应式适配、同版本服务端 301 | 路由制品、Nginx 派生配置、发布冒烟与真实浏览器 | M0 路由与 301 契约已固定，实现与浏览器 fit-gap 尚未完成 |
| D-035 至 D-050、D-078、E-001、E-003、E-006、E-007 | 领域 schema、注册表、作者与分类引用、项目主预览、日期、可见性和 SEO 页面适配 | 领域契约、媒体字节、构建制品与浏览器 head | 项目叙事和媒体 schema 已收口；注册表、媒体校验和元数据组件尚未实现 |
| D-053、E-008 | 按构建模式生成临时静态白名单树，并从生产制品排除未发布素材 | 源路径、白名单、制品字节和泄漏 fixture | 发布态素材隔离已收口；受控构建入口和检查尚未实现 |
| D-072、E-009 | 在 Linux 对精确远端提交构建含 draft/noindex 的静态候选，并原子切换局域网预览 | Docusaurus 3.10.2 fixture、候选制品、失败保留与真实浏览器 | 预览设计已收口；当前脚本仍直接服务 `public/`，尚未实现 |
| D-054 至 D-060、D-078、D-079、E-006、E-012 | 单一 docs 实例、唯一判型、校验先行、只读内存投影与公共 API | 临时编译后的 Node ESM 纯逻辑测试和 Docusaurus 集成测试 | Node ESM 测试契约已收口；依赖准入、runner、fixture 与集成测试尚未实现 |
| D-061 至 D-064、D-078、E-013 | 内容根、源码布局、稳定身份、路径、源码相对链接、日期索引、侧栏与 HEAD 可达历史 | 路径、身份、历史 DAG、链接、索引和侧栏契约测试 | 完整 Git 历史边界已收口；检查器、作者集成、fixture 与 CI checkout 尚未实现 |
| D-065 至 D-067、D-072、D-078 | 作者显式创建入口、UUIDv7 后端、版本治理和 Linux/Ubuntu 执行边界 | 作者工具、版本契约和 Ubuntu CI | Node 24 版本文件与 E-010 端点校验已实现；作者工具和目标 Ubuntu CI 拓扑尚未实现 |
| D-052、D-053、D-073、D-077、D-079、E-010、E-011、E-014、E-015 | 依赖准入、锁文件、隔离冻结安装、确定性供应链证据、质量、production job 字节闭包和带 301 配置的发布必需门禁 | 依赖、制品、浏览器与发布检查 | E-010 隔离入口已实现；Node 类型候选、确定性证据、301、自包含重建、真实候选图和目标 CI 接线尚未完成 |
| D-005 至 D-009、E-014、E-015 及生产发布设计 | canonical/隐私边界、最小权限发布和 payload/301 同版本 release 切换 | 真实制品与生产冒烟 | 服务端 301 与制品字节所有权已收口，服务器现场核验尚未完成 |
| D-015、D-016 及项目体验架构 | 项目展示不得绕过体验状态与独立部署边界 | 注册表、页面制品与发布权限检查 | 当前项目体验不启用 |

## 当前实现画像

下列是 2026-07-19 可从仓库查证的迁移事实，不代表目标工程已经就绪：

- `package.json` 声明 ESM，现有质量脚本是 `.mjs`，只使用 Node.js 内置能力；D-074 不要求迁移这些脚本。仓库尚未安装 Docusaurus 或其他 npm 依赖，也没有 lockfile。
- `public/` 仍是迁移前手写静态入口；`site-content/` 和 Docusaurus 配置尚不存在。`.nvmrc`、封闭 `engines.node`、E-010 隔离入口及 `tests/build/run-isolated-npm.test.mjs` 已建立。
- `node scripts/quality/check-javascript.mjs` 只对当前仓库内明列范围执行语法检查，不是全仓 lint。
- `node scripts/quality/check-markdown.mjs` 检查 Markdown 内链和 `docs/README.md` 索引；`check-contracts.mjs` 检查现有契约词规则；`check-secrets.mjs` 是有限扩展名与有限模式的启发式扫描，不等于全仓 Secret 证明。
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
| 内容解码适配 | `scripts/content/` | 以 E-013 的 Docusaurus 官方公共解析器把 Markdown/MDX 解码为结构化 frontmatter 与正文，供构建、作者和质量入口复用 | 领域 schema、Git 历史状态、文件写入、框架字段投影 |
| 展示层 | `src/components/`、`src/pages/`、`src/theme/` | React 页面、主题和组件，消费已验证的展示输入 | 直接读取源文件、调用 Node.js 文件/进程 API、保存业务数据 |
| 作者工具 | `scripts/author/` | 作者显式创建或日期操作及其文件系统事务 | 被 Git hook、CI、预览、构建或发布隐式调用 |
| 质量与发布 | 质量脚本使用 `scripts/quality/`；仓库发布辅助脚本使用 `scripts/release/`；工作流使用 `.github/workflows/` | 对源和制品做只读校验，返回失败证据 | 生成、补写、暂存、提交或发布内容身份 |

`src/build/` 是受版本控制的构建期源码，不是 Docusaurus 默认静态产物目录 `build/`。`site-content/` 是内容根，不属于源码模块树。`scripts/content/` 是 E-013 限定的 Node.js 结构化解码适配，不是通用共享层，也不拥有内容规则。首版不增加职责含混的通用 `shared/` 层；出现新职责时先确认归属，不能通过共享目录绕过依赖方向。

构建适配、作者工具、质量与测试等外层可以依赖稳定领域接口；展示层只消费构建适配提供的已验证展示输入，不直接读取源内容。领域核心不得反向依赖外层、框架或 UI。未来服务通过独立网络契约集成，不得成为主站领域核心的模块依赖。跨逻辑层导入必须经过被依赖模块按需建立的显式公共入口，禁止直接导入其内部文件；同一模块内部使用相对导入。没有真实跨层消费者时不创建空 `index.ts` 或占位目录。

来源：D-027、D-053、D-055、D-059、D-060、D-065、D-075、E-013；[主站目标架构](../architecture/main-site-target-architecture.md)。

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
- 当前内容、Docusaurus 回调、作者入口与历史快照都必须调用 `scripts/content/frontmatter.mjs` 的 `decodeFrontMatter`。Docusaurus 回调把框架提供的 `defaultParseFrontMatter` 传入一次；独立 Node 入口使用直接候选 `@docusaurus/utils@3.10.2` 的公开 `DEFAULT_PARSE_FRONT_MATTER`。解析后再分别执行当前完整 schema 或 E-013 的历史最小身份提取，不得以逐行扫描、正则或第二个 YAML/MDX 解析器读取 articleId。
- 文章成员、schema、投影和侧栏必须消费同一份路径规范化及成员判断结果，不得各自实现近似规则。
- 内容路径统一转换为相对仓库根的 POSIX `/` 分隔形式；输入绝对路径、反斜杠、空段、`.`、`..`、NUL、控制字符或规范化后逃逸预期根目录时失败。Linux 文件名按大小写精确匹配，不做静默大小写归一化。
- `site-content/` 内拒绝符号链接；扫描器必须同时用词法 `resolve`/`relative` 和现存路径的 `realpath` 证明真实包含关系。`writing/<source-name>/` 继续遵守 D-063；项目正文目录名必须与稳定 project ID 完全一致。已进入 Git 的文章 source-name 和 E-003 稳定注册表 ID 不得被其他内容复用；当前树、工作区候选和 E-013 的 HEAD 可达历史必须调用 CODE-018 的同一身份提取与状态判定实现。
- 项目正文入口不接受 frontmatter；目录名是正文与注册表 ID 的唯一绑定。项目注册表 schema 必须把 `problem`、`decisions`、`evidence` 及其他未声明字段作为未知字段拒绝，项目正文扫描只自动拒绝可解析的 frontmatter 与 H1；正文中的普通叙事、分节标题、证据链接及其与摘要的自然语义重叠不由字符串启发式误判，是否存在不必要的文字重复由内容审查负责。
- 迁移前质量脚本中的 Markdown 字符扫描和 HTML 正则是当前有限实现，不构成目标解析方案先例。

来源：D-038、D-058、D-060 至 D-063、E-001、E-003、E-006、E-013。

### CODE-005 Node.js 与模块边界

- 修改现有 Node.js 质量脚本时保持 ESM，使用 `import`/`export`；Node 内置模块使用 `node:` 前缀，不混入 CommonJS。
- 当前脚本继续遵守 `package.json` 的 `type: module`；目标 Node 精确版本只由获批后的 `.nvmrc` 提供，不在代码或本文复制 patch 值。
- 目标依赖解析、lockfile 写入权限和最低端点只读边界直接遵守 D-073、D-077 与 E-010。只有主端点能通过隔离 `resolve-lock` profile 生成候选 lockfile；所有正常安装统一通过隔离 `ci` profile，代码不得通过直接调用 npm、安装时 fallback、第二种 lockfile、浮动包管理器、隐式 audit、共享 cache 或生命周期脚本绕过该契约。
- Docusaurus 管理的目标源码统一使用严格 TypeScript：站点配置为 `docusaurus.config.ts`，侧栏、生成器、本地插件、构建期适配和无 JSX 模块使用 `.ts`，包含 JSX 的页面、主题覆盖和 React 组件使用 `.tsx`；目标 `tsconfig.json` 必须显式设置 `strict: true`。
- 上述目标范围不得新增 `.js` 或 `.jsx`，除非先按用户决策门禁批准例外。现有和新增的零依赖作者/质量/发布 CLI 使用 `.mjs`，不进入 Docusaurus TypeScript program；React、领域和构建源码不得借此回退为 JavaScript。
- 目标根 `tsconfig.json` 必须继承精确 `3.10.2` 的 `@docusaurus/tsconfig`，并显式设置 `baseUrl: "."`、`ignoreDeprecations: "6.0"`、`strict: true` 与 `allowJs: false`。首轮 `include` 只能包含根 `docusaurus.config.ts`、根 `sidebars.ts`、`src/**/*.ts` 与 `src/**/*.tsx`；`.mjs` 作者/质量/发布 CLI 和 `tests/` 不加入该生产 program。独立 `tests/tsconfig.json` 按 E-012 继承根配置但覆盖为 NodeNext/ES2024、显式 Node types 和临时 emit；其相对 `include` 值为 `domain/**/*.test.ts` 与 `build/**/*.test.ts`，物理根输入对应 `tests/domain/` 与 `tests/build/`。不得把测试配置回写到根 program，也不得把生产 `noEmit` 当作测试执行输出。
- `module: "esnext"`、`moduleResolution: "bundler"`、`noEmit: true` 与 `skipLibCheck: true` 只由上述精确官方根基线拥有，本站根 `tsconfig.json` 不重复声明；E-012 对独立测试 program 的 NodeNext 与 emit 覆盖不改变该所有权。官方基线变化必须作为依赖升级 diff 审查，不能静默接受新的解析或检查行为。
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
- 内容正文同目录资源使用 `site-content/<type>/<entry>/assets/`；项目主预览原件使用 `site-assets/projects/<project-id>/`；始终允许进入所有构建的品牌和根级静态资源使用 `static-public/`，其中禁止项目、文章或待审核素材。三类资源不得互相复制，文件名使用 lowercase kebab-case 并保留有意义扩展名；正文资源由 Markdown 显式引用，项目预览由 `projects.json.previewImage` 显式引用，孤儿资源使质量门禁失败。
- `previewImage` 只包含 `sourcePath`、`width`、`height`、`alt`；不得加入可派生公开路径、主图布尔值、顺序、审核状态或哈希。校验器必须核对项目状态、固定路径、文件签名、非动画 WebP、精确 1600 x 1000、最多 300,000 bytes、登记尺寸、替代文本以及一对一引用；未知字段失败关闭。
- `scripts/build/build-site.mjs` 是 Docusaurus production/preview 的唯一受控入口。它接受封闭枚举模式，在进程创建的全新系统临时目录生成静态白名单树，并只把规范化绝对路径通过专用环境变量传给 `docusaurus.config.ts`；配置在模式、目录、所有权标记或路径边界缺失时抛错，不回退到仓库 `static/`。入口退出时清理临时树，preview 的持久候选制品由 #8 另行拥有。
- production 白名单由完整 `static-public/` 和 `published`/`archived` 项目的登记预览组成；preview 白名单由完整 `static-public/` 和所有状态中已登记的预览组成。映射固定为 `site-assets/<sourcePath>` 到临时 `assets/<sourcePath>`，最终为 `/assets/<sourcePath>`；`static/`、`public/`、`site-assets/` 原目录都不得出现在目标 `staticDirectories`。
- 本地资源必须使用可由构建和质量门禁解析的路径；运行时第三方字体、图片、脚本、播放器或远程资源必须先完成依赖、许可、隐私和网络请求决策。
- UI 代码必须满足产品文档中的语义 HTML、键盘、文本缩放、动效和无重叠要求；验收值直接引用产品文档，不在本文复制。

来源：D-025、D-034、D-052、E-007、E-008；[主站体验与内容架构](../product/site-experience.md)。

### CODE-009 文件、注释与局部修改

- 普通文本文件遵守根 `.editorconfig`；Git 存储换行遵守 `.gitattributes`。两份配置出现差异时先说明实际行为和验证结果，不把其中一份静默当作全部平台事实。
- 修改只格式化任务涉及的范围，不在功能变更中混入无关的全文件重排。
- 注释默认使用简体中文，只解释必要的原因、边界和非显然契约，不复述代码步骤。
- formatter、lint、导入顺序和自动修复策略完成决策后由可执行配置负责，本文只保留不能被工具改变的工程边界。

来源：当前 `.editorconfig`、`.gitattributes`；[贡献指南](../../CONTRIBUTING.md)。

### CODE-010 依赖、安全与数据

- D-073、D-076、D-079 与 E-013 明列的包名和 manifest 版本表达共同构成当前获准进入供应链审查的直接清单；具体清单只从这些上层决定读取，本文不维护第二份版本表。未来唯一 `package-lock.json` 必须精确冻结所有范围的实际解析结果，代码、脚本或模板不得另设依赖版本来源。
- 根 `.npmrc` 是提交的项目级 npm 配置，schema 只允许 E-010 的九个固定键和值；缺失、重复、未知键、插值、scope、认证、proxy、CA、cache 或路径配置都失败。它不能单独证明隔离，因为 CLI、环境、user/global 与 scoped 配置仍可能覆盖或补充，所有会解析、安装、审计或生成 SBOM 的 npm 进程还必须由隔离入口创建。
- `scripts/quality/run-isolated-npm.mjs` 只接受 `resolve-lock`、`ci`、`audit`、`sbom-native`、`run-script` profile；每个 profile 使用显式命令和参数白名单，拒绝 registry、cache、userconfig、globalconfig、proxy、omit/include、脚本和来源控制等调用者覆盖。共享的环境构造、配置解析和 lock 来源扫描放在 `scripts/quality/lib/supply-chain/`，其他脚本不得复制近似版本。
- 隔离入口在任何 npm 子进程前验证 cwd、精确 Node/npm、项目配置和 manifest 来源；为每次调用创建权限 `0700` 的 HOME、cache、logs、tmp 与空 user/global npmrc。子进程环境按允许键重建，大小写不敏感地删除所有继承的 `npm_config_*`、`NODE_ENV`、HTTP/HTTPS/ALL/NO proxy、`NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE` 与 `SSL_CERT_DIR`；PATH 只含当前 Node 目录、受控本地 bin 和所需 Ubuntu 系统目录。npm CLI 必须由 `process.execPath` 的安装前缀推导绝对路径并证明属于当前发行版，不能通过 PATH、`npx` 或下载 fallback 解析。
- 启动可能联网的 profile 前，入口在同一环境运行离线 `npm config list --json`，只对 E-010 的安全相关字段和模式作失败关闭断言：默认 registry 精确为官方 HTTPS；任何 scoped registry、认证、token、证书或 proxy 键均不存在；cache/userconfig/globalconfig 精确位于本次临时目录；strict SSL、registry host、scripts、audit、fund、update、lockfile 与版本值精确。项目配置未知键与敏感有效键失败；npm 内建的无关默认键不被误判为项目授权，也不能覆盖这些断言。
- 上述候选仍须在实际安装前按 D-077 对真实直接与传递图取得准入结论。首次候选只允许来自官方 npm registry，拒绝 Git、`file:`、本地目录和任意远程 tarball 来源；不得用镜像、替代源或手工改写 `resolved` 绕过来源检查。
- `resolve-lock` 只在主 npm 端点执行 package-lock-only，并显式使用该端点支持的 Git/file/directory/remote 全部禁用参数；最低端点不认识的参数不得写入共享 `.npmrc`。生成后立即由两个端点共用的零依赖扫描器检查 manifest spec、每个 `resolved` 官方 origin、integrity 与 lockfileVersion，再允许隔离 `ci`。每次 ci 使用空 cache，且 manifest/lock 前后摘要不变；setup-node 的 npm cache restore 禁用。
- 供应链策略代码首版只使用 Node.js 内置能力，可调用 Ubuntu `tar` 检查精确 lockfile tarball；不以新增扫描器依赖解决扫描器自身的准入。策略必须在不执行包代码或脚本的条件下校验 integrity、实际 `package.json`、许可证文件、NOTICE 与生命周期脚本内容。
- 精确 tarball 不从 npm cache 读取；内置 HTTPS 只请求已经通过 lock 扫描的官方 `resolved`，拒绝跨 origin 重定向，下载到本次隔离审查区后先核 integrity 再解包。原始 tarball/cache 不提交，删除或按 CODE-015 作为受限 artifact 保留。
- 许可证证据缺失、未知、推测性、复杂或未获准时失败并暂停人工决定。依赖生命周期脚本默认拒绝；若候选确有构建必要性，只能携带精确 `name@version`、脚本内容、风险与证据重新取得用户确认，不能提供包名模式或全图开关式放行。该阶段只形成许可证与脚本人工预审，不得在漏洞门禁通过前形成最终准入结论。
- `package.json` 只拥有直接依赖意图，`package-lock.json` 只拥有完整解析图；人工准入记录只拥有不能稳定派生的用途、许可证澄清、脚本处置、义务和决策编号。SPDX JSON SBOM 与 `THIRD_PARTY_NOTICES` 必须从 lockfile 和 tarball 证据生成并做漂移检查，不得被手工维护成第二份依赖清单。
- 隔离 `audit` profile 必须覆盖完整依赖图和开发依赖；`moderate`、`high`、`critical` 阻断，`low` 报告，禁止 `npm audit fix`，registry/audit 不可用时失败关闭。该构建期请求会把包名和版本发送给官方 npm registry，回退协议可能包含完整 lockfile 树及 npm/Node/平台/架构/环境元数据；不得向审计请求加入站点内容或访问者、账户、评论数据，也不得把它变成浏览器请求。
- 漏洞门禁和最终人工准入都通过后，主端点和最低端点必须用同一 manifest、lockfile 与项目 npm 配置运行隔离 `ci` profile，并通过执行前后哈希证明 `package.json` 与 `package-lock.json` 未变化；每个端点使用全新 cache，最低端点只验证兼容性，不生成发布制品。
- D-079 只把 `@types/node@^24.0.0` 加入直接开发候选，用途限定为 E-012 的 Node 24 测试类型；E-013 只把 `@docusaurus/utils@3.10.2` 加入直接开发候选，用途限定为复用该精确框架版本公开导出的默认结构化 frontmatter 解析器。两者都不得依赖偶然提升的传递副本，也不得进入浏览器 bundle；真实 tarball、许可证、脚本、漏洞和完整传递图仍须通过 D-077。`clsx`、`prism-react-renderer`、`@types/react-dom` 及模板、主题或未来源码中的其他包仍未获新增直接依赖授权；出现真实用途时重新准入，作为候选传递依赖出现时也不能跳过审查。除此之外的 npm 包、Docusaurus 插件、Action、浏览器 SDK、iframe、远程模块或外部服务，在完成逐项准入、记录和用户确认前不得加入。
- 仓库、日志、fixture、截图和静态制品不得包含真实凭证、个人隐私数据、客户数据或未公开商业信息。
- 测试数据使用明确虚构的最小样例；不能用真实账户、token、生产响应或本机隐私路径换取测试便利。
- 新增浏览器外部请求或用户数据处理必须先完成上层安全、隐私、用途、保留和删除决策，不得作为组件实现细节混入。

来源：D-009、D-052、D-053、D-073、D-074、D-076、D-077、D-079、E-010 至 E-013；[主站目标架构](../architecture/main-site-target-architecture.md)。

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
- E-012 的 `scripts/quality/run-tests.mjs` 是领域与构建 TypeScript 测试的唯一入口：用当前 Node 执行本地冻结的 TypeScript CLI，把独立测试 program 输出到本次系统临时目录，再稳定排序并显式传递编译后的 `*.test.js` 给当前 Node `--test`。测试为零、编译失败、执行失败或清理失败均失败关闭；禁止 `npx`、shell、loader、实验性说明符解析、联网 fallback 或仓库内输出。
- 进入测试 Node ESM 图的相对静态 import/export 与动态 import 统一写 `.js` 说明符，目录入口写 `index.js`；Node 内置模块统一写 `node:`，类型专用导入使用 `import type`。无扩展名、`.ts` 运行时说明符、路径别名或依赖目录猜测必须由编译 fixture 拒绝。
- E-012 fixture 至少覆盖合法 `.js` 说明符编译并直接运行、无扩展名编译失败、空测试集失败、编译失败与测试失败后清理、清理失败传播，以及源码、内容树、`build/`、`dist/` 不产生测试文件。主 Node 与最低 Node 端点必须调用同一入口和同一测试集合。
- E-007 媒体 fixture 至少覆盖：公开项目缺预览、未发布项目省略预览、未知媒体字段、跨项目或逃逸路径、重复引用、孤儿文件、符号链接、错误签名、动画 WebP、尺寸或登记值不符、超过字节上限、空白/多行/过长/复述标题的 `alt`。成功 fixture 必须从登记字段得到唯一公开 URL，不允许文件名猜测。
- E-008 构建 fixture 必须用同一最小内容树分别生成 production 与 preview 白名单，断言 production 只含公开状态项目、preview 含全部已登记项目且输出目录彼此隔离；另覆盖 `static-public/` 中误放项目素材、原始静态目录直连、缺失模式或受控临时目录、大小写目标冲突，以及把未发布字节改名后混入 `build/` 的失败路径。
- E-014 重定向 fixture 必须覆盖空注册表、稳定排序、登记 source 有斜杠和无斜杠别名都单跳最终目标、活动页面无斜杠 canonical、查询串保留、目标 payload 页面存在，以及重复/规范化冲突、保留路径、危险字符、静态 source HTML、目标缺失、自跳转、链和环失败。Nginx fixture 断言只产生 exact `location` 与固定 canonical origin，不含 `reason`、regex、`map`、`if`、server 级 `return` 或可变 Host。生产暴露账本 fixture 还必须覆盖：历史 source 被删除、历史 target 404、旧 source 与旧 target 分裂到不同终点、缺少旧规则但碰巧存在目标页面均失败；`/old/ -> /middle/` 后迁移为 `/old/ -> /new/` 与 `/middle/ -> /new/` 的同终点单跳闭包通过；新边预写账本后不存在兼容 fallback 时默认拒绝；账本丢失、损坏、未知字段、非追加改写、写入失败和失败后静默重建均失败关闭。

来源：D-053、D-079、E-012、E-014；[自动化维护与运行手册](../operations/maintenance.md)。

### CODE-012 质量入口与评审

- 修改后运行与风险相称且当前可用的本地门禁；不得把当前有限扫描表述为已经覆盖未来 `.ts`、`.tsx`、`.mdx`、样式、Docusaurus 制品或全部 Secret 形态。
- Docusaurus 目标源码必须独立运行 `tsc --noEmit`，Docusaurus build 必须独立验证框架加载和静态制品；两项都是发布必需门禁，任一成功都不能替代另一项。当前仓库尚未接入这两个目标门禁，现有 E-010 隔离 `quality` 负载通过不构成完成证据。
- 目标质量门禁必须通过 `scripts/quality/check-module-boundaries.mjs` 失败关闭验证 D-075 的物理层边界、禁止的跨层深层导入、宽泛 `export *` 和未批准自定义路径别名。首版不提供通用忽略开关；框架入口的默认导出和官方别名例外在检查器中按精确路径编码并由 fixture 覆盖。当前仓库尚无该脚本，实施前不能宣称已覆盖。
- 目标质量门禁还必须失败关闭执行 D-077 的候选来源、tarball/integrity、许可证与脚本、SPDX/NOTICE 漂移、显式 audit、双端点冻结安装和 manifest/lock 前后不变检查。当前 E-010 隔离 `quality` 负载只实现启动前边界与离线 CLI 验收，不包含这些后续能力，其通过不构成供应链准入证据。
- workflow 与 package script 静态门禁必须拒绝在候选解析、ci、audit、SBOM 和 CI 质量路径中直接调用 npm 绕过 E-010。`run-script` 只允许 CODE-016 的受控质量/构建名称，显式作者命令继续遵守 D-065 的独立本地入口，但不得在其内部解析或安装依赖。
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

- 新文章入口固定为 `node scripts/author/create-article.mjs --source-name <name> --title <text> --slug </writing/...> --summary <text> --author <id> --topic <id>`。`--author` 与 `--topic` 可重复，`--project`、`--module` 可选。M0 只创建 `index.md`，不提供 `--format` 或 MDX 快捷入口；未来 MDX 白名单出现真实获批组件后再扩展命令。
- 命令只接受完整非交互参数，先验证全部字段、注册表引用、目标目录不存在和精确 Node 版本，再取得排他作者锁并重新验证目标与当前工作区。随后只在内存生成 UUIDv7，把显式 source-name、全部字段和新 articleId 投影为候选交给 CODE-018；完整历史与候选同时通过后才能创建同一文件系统内的 `site-content/.author-staging-*` 并写入完整 `index.md`。flush 文件和目录后把整个临时目录原子 rename 为目标目录。任一步失败都删除本次临时目录并释放锁；质量、预览和构建发现作者锁或残留 staging 时失败，不读取半成品。不得覆盖、修复或补写既有文章。
- draft 模板不填写 `publishedAt`，不从系统时间、UUID、标题或路径推导任何业务字段；`updatedAt` 也不由创建命令自动写入。命令不运行 Git add/commit/push，不调用发布、预览或构建，也不得被 CI、hook 或 Docusaurus 隐式调用。
- UUIDv7 文本校验同时检查规范小写连字符形式、version 7、RFC variant、当前树唯一和 Git 历史未复用；历史只读检查由 `scripts/quality/check-content-history.mjs` 统一拥有，创建命令调用 `scripts/quality/lib/content-history.mjs` 的同一候选校验，不复制正则、身份提取、父状态或 Git 扫描算法。

来源：D-047、D-062 至 D-067、D-072、D-078、E-013。

### CODE-015 供应链证据与发布封装

- 供应链可编辑策略位于 `docs/contracts/dependency-policy.json`，只编码 D-052/D-077 已确认的来源、许可证类别、漏洞阈值、脚本默认拒绝、双端点和报告保留规则；精确包人工结论位于 `docs/contracts/dependency-admissions.json`，以 `name@version` 为键，只记录用途、许可证澄清、脚本处置、义务、证据摘要和决定编号。两者都拒绝未知字段。
- 零第三方依赖入口固定为 `scripts/quality/check-supply-chain.mjs` 和 `scripts/quality/generate-supply-chain-artifacts.mjs`，共享实现位于 `scripts/quality/lib/supply-chain/`。前者只读检查 manifest、lockfile、registry 来源、integrity、准入记录与派生制品漂移；后者只在 D-077 获准的隔离审查步骤中读取精确 tarball 证据并生成派生结果，不修改 manifest、lockfile 或人工准入记录。
- 提交的派生证据固定为 `docs/generated/supply-chain/dependency-evidence.json`、`docs/generated/supply-chain/sbom.spdx.json` 和仓库根 `THIRD_PARTY_NOTICES`。生成器输出稳定排序且不读取系统时间、不写本机路径或临时下载位置；tarball 本体、npm cache 和原始 audit 响应不提交。
- SPDX 生成固定为“E-010 隔离 native npm 输出 -> E-011 严格解析与规范化 -> 漂移验证”。规范器只移除 native `creationInfo.created`/`documentNamespace`，加入 `Tool: axial-muse-supply-chain-1.0.0`，按明确 SPDX 无序集合键排序并递归排序对象键；未知数组或 schema 漂移失败，禁止改写包、许可证、关系和校验和语义。
- `dependency-evidence.json.sbom` 精确包含 `normalizerVersion`、`semanticSha256`、`createdAt`、`fileSha256`。首次或语义变化时，显式生成命令要求 `--created-at` UTC 秒精度值；相同语义复用旧值，构建/CI 不读取墙钟补齐。namespace 由省略自身后的 canonical 文档摘要派生为 E-011 固定 HTTPS URI；该 URI 只是 SPDX 标识，不创建公开站点路由。
- 确定性门禁在两个空临时目录分别执行 native SBOM，要求原始 created/UUID 的变化被规范化后输出逐字节相同；随后重算 semantic、document namespace 和最终文件摘要，与 evidence 交叉验证。fixture 覆盖缺失/非法/被覆盖 createdAt、毫秒或非 UTC 时间、含 `#`/非绝对 namespace、native 随机字段、输入顺序变化，以及包或关系变化必须更换 namespace。
- 候选解析与 tarball 审查的原始日志、显式 audit JSON 和双端点安装证明作为受限 CI artifact 保留 30 天；报告不得包含 registry 凭证、环境 Secret 或站点内容。准入结论、lockfile、派生证据和 PR 审查记录提供长期追溯，不用延长原始 tarball 保存期。
- Docusaurus 仍只输出默认 `build/`。`scripts/release/package-site.mjs` 在 `dist/release/` 建立临时交付包：`payload/` 是 E-015 当前 production job 中已重验 `build/` 的逐文件复制；`metadata/runtime-redirects.json` 与 `metadata/nginx/redirects.conf` 按 CODE-019 从同一 build 派生；`metadata/release.json` 保存固定 schema version、仓库标识、40 位 commit SHA、`sourceBuildTreeSha256`、payload 根、源重定向注册表摘要、公开路由集合摘要、两个派生文件摘要、规则数和文件清单摘要。`metadata/files.sha256` 按相对 POSIX 路径排序，覆盖全部 `payload/**` 以及两个可部署派生文件；不得写构建时间、runner 路径、workflow run 或分支浮动名。
- release 封装前必须重新执行发布态资源泄漏门禁：`build/assets/projects/**` 与 production 白名单逐路径、逐字节完全一致，每个公开预览至少被一个 SSR HTML 文件引用；任何未发布预览的派生公开路径不得出现在文本制品中，其源 SHA-256 不得与 `build/` 内任一文件摘要相同。多余、缺失、改名或哈希化泄漏均失败，preview 模式输出禁止作为封装输入。
- 封装器拒绝符号链接、特殊文件、绝对/父级路径、重复规范化路径、大小写冲突和封装期间源文件变化。`scripts/quality/check-release-package.mjs` 必须从空状态重新计算 `payload/` 路由、重定向运行清单、Nginx 配置和全部摘要，证明它们与 `build/`、源注册表、metadata 和 commit SHA 一致；不得只核对已生成配置自身。`dist/` 不提交，也不成为编辑或缓存真相源。
- GitHub artifact 展示名称固定为 `axial-muse-site-<40-char-sha>-<run-id>-<run-attempt>`，只上传 `dist/release/`，保留 30 天；名称不承担身份或选择职责。服务器先验证 GitHub repository、run、artifact ID、`head_sha` 与外层 `artifactDigest`，再按 CODE-020 的稳定文件树格式从解包后的 exact release 独立重算并核对 job 输出的 `releaseContentSha256`，最后验证内部 metadata 和文件清单；两个期望摘要必须作为独立 TAT 参数传入，不能从 artifact 自报字段相互推导。通过后把 `payload/`、运行清单和 Nginx 派生配置安装到同一 `releases/<sha>/payload/` 与非公开 `config/`；其余 metadata 不安装，任何 metadata 都不进入 Nginx Web Root。root-owned 激活包装只能引用同一精确 SHA 的 payload 和配置。

来源：D-052、D-053、D-077、D-078、E-005、E-014；[域名与生产发布设计](../operations/domain-deployment.md)。

### CODE-016 M0 工具最小集

- 首版不为格式化或通用 lint 新增第三方包。严格 TypeScript、`scripts/quality/check-module-boundaries.mjs`、结构化 schema/路径检查、现有文档/Secret/PlantUML 门禁和 `git diff --check` 共同承担静态检查；发现这些检查无法表达的真实缺陷类别后，再提出对应工具候选并进入 D-077。
- 领域与构建期纯逻辑测试固定使用 Node 24 内置 `node:test`，不增加第三方 runner。`tests/tsconfig.json` 与 `scripts/quality/run-tests.mjs` 必须逐项实现 E-012 的 NodeNext/ES2024、临时 emit、显式测试文件、失败关闭清理和 `.js` 说明符契约；生产 `build/`、`dist/`、源码和内容树不接收测试产物。D-079 的 `@types/node` 仍须随真实候选图完成 D-077 准入，未通过前不得以传递提升或手写 ambient declaration 接线。
- M0 不在依赖准入前引入 Vitest、Jest、jsdom、Playwright 或可访问性扫描包。React 页面由严格类型、Docusaurus build、构建制品检查和真实 Chrome 的键盘/响应式/网络/控制台人工验收覆盖，截图随 PR 保存；这不是对未来自动浏览器回归工具的永久禁止。
- npm script 名称固定为 `typecheck`、`test`、`build`、`check:artifact` 和聚合 `quality`。CI 通过 E-010 的 `run-script` profile 调用这些本地脚本；`quality` 运行只读静态检查、类型检查、测试和 Docusaurus production build，但不解析依赖、不下载 tarball、不执行 audit、不封装或发布 release。供应链解析/audit/SBOM 使用各自隔离 profile，`package:artifact` 是显式独立入口，避免普通质量检查产生外部副作用。
- Ubuntu CI 的发布必需 job 固定为 `website-quality`（精确 `.nvmrc`，执行冻结安装与 `quality`）、`node-minimum`（兼容下限，同一共享负载但不上传制品）、`diagrams`（精确 `.nvmrc`，编译并核对 PlantUML SVG）和 `supply-chain`（静态证据漂移、显式全图 audit 与 manifest/lock 不变）。`production-artifact` 只在 canonical 仓库的 `main` 精确 SHA 且四项成功后，按 E-015 在 fresh runner 重新完成主端点冻结安装与完整 `quality`，随即对同一 `build/` 运行 `package:artifact`、独立 release 校验和一次上传；它不作为 PR 的空跑 required check，也不下载 `website-quality` 的 build。`deploy-production` 再受 production environment 和操作授权控制。Action 必须在实施时按准入结果固定完整 commit SHA，不能把浮动 tag 写入最终 workflow。
- 每个执行 `quality` 或 `check-content-history.mjs` 的 job 必须按 E-013 使用准入后固定完整 commit SHA 的 `actions/checkout`，显式设置 `fetch-depth: 0`、`persist-credentials: false`，且不设置 partial/sparse checkout。`pull_request` 保持默认 merge ref，不改为 head SHA；当前与未来的 `website-quality`、`node-minimum` 均适用，不运行历史检查的 `diagrams` 不因此扩大 checkout。检查器仍独立拒绝浅仓库和缺失对象，不能只信 workflow 文本。

来源：D-053、D-074、D-077 至 D-079、E-012、E-013；CODE-003、CODE-010 至 CODE-012、CODE-018。

### CODE-017 局域网预览候选与激活

- `scripts/dev/preview.sh` 只负责远端 ref 获取、目标工具链与本地冻结依赖证明、调用 `scripts/build/build-site.mjs --mode preview`、候选检查、活动 symlink 切换和 Python 服务器所有权；不得复制内容 schema、素材选择或 Docusaurus 配置逻辑。
- `PREVIEW_STATE_DIR` 必须是已存在父目录下的规范化绝对路径，位于仓库、主 worktree、预览 worktree和系统临时目录之外；拒绝符号链接根、跨文件系统 candidates/releases/current、非当前用户拥有或可被 group/other 写入的状态目录。创建的非公开目录使用仅当前用户可读写执行的权限，release 本身不得包含运行 metadata。
- `serve` 与 `restart` 使用同一非阻塞排他锁。分支先通过 Git ref 格式和本站允许字符检查，再以精确远端 heads refspec fetch；只允许 `origin/<branch>`，不得回退到同名本地分支、浮动默认分支或任意 commit 参数。候选身份是 checkout 后的 40 位 commit SHA。
- 构建前必须证明实际 Node 等于 checkout `.nvmrc`、本地 Docusaurus 等依赖已由独立冻结安装准备，并与当前 `package.json`、`package-lock.json` 及 npm 端点证据一致。预览入口只调用本地可执行文件，不用 `npx` 或可下载 fallback；依赖缺失或散列不匹配时失败，不尝试修复。
- 每次在 `candidates/<sha>.<pid>/` 从空状态构建，Docusaurus generated files 与缓存必须清空或隔离，输出不得回落到仓库 `build/`。候选门禁至少验证：活动 SHA marker 与 checkout 一致、所有 HTML 含唯一 `noindex, nofollow`、无 `sitemap.xml`、draft 与 published fixture 路由/侧栏符合 E-009、局域网 host/IP/port 不出现在文本制品、E-008 preview 素材集合准确、无符号链接和特殊文件。
- 候选通过后同文件系统原子 rename 为不可变 `releases/<sha>/`，再通过同目录临时 symlink 加原子 rename 更新 `current`。服务已运行时不重启；不存在服务时只在 `current` 有效后启动。切换前失败不修改 current/PID，切换后 localhost HTTP 冒烟失败恢复旧 symlink；首次激活失败则停止本次新服务。
- `status` 从 `run/` 与 `current` 真实目标分别读取请求分支、worktree HEAD、活动 SHA、mode、PID/URL 和最近失败，不从 branch 文件推断活动制品。日志与错误不得包含绝对工作区之外的隐私路径或环境 Secret；成功激活后可以保留 current 与 previous 两个 release，清理更旧版本失败只告警，不反转成功切换。
- 测试须覆盖 A 运行时 B 成功切换且 PID 不变、fetch/build/依赖/制品失败保留 A、切后冒烟失败恢复 A、首次失败无服务、并发第二调用被拒、非远端 branch、状态目录逃逸和 active/candidate 状态区分。真实验收在 360、768、1024、1440 px 检查 draft 导航、资源、控制台和网络；不新增自动浏览器依赖。

来源：D-072、D-077、E-008、E-009；[跨机协同开发预览工作流](../architecture/dev-workflow.md)。

### CODE-018 完整 Git 历史与身份状态

- CLI 固定为 `scripts/quality/check-content-history.mjs`，共享实现固定为 `scripts/quality/lib/content-history.mjs`，结构化解码适配固定为 `scripts/content/frontmatter.mjs` 并提供相邻 `frontmatter.d.mts` 类型声明；三个 `.mjs` 都加入 `check:js` 明列清单，`quality` 在内容 schema 与构建前执行历史门禁。公开 CLI 不接受 ref、remote、branch、fetch、容错或当前树 fallback 参数；测试通过临时仓库改变 cwd，不给生产入口增加绕过开关。
- Git 子进程环境必须先删除全部继承的 `GIT_*`，再重建 E-013 的七个 Git 环境边界并固定 `LC_ALL=C`。预检顺序固定为：确认 realpath 后的 cwd 等于 non-bare worktree top-level；检查 local config 与 common object directory，拒绝 partial clone、promisor remote/pack 和 alternate object database；确认 `--is-shallow-repository` 精确为 `false`；再解析 `HEAD^{commit}` 并用 `rev-list --topo-order --reverse --parents HEAD` 建立 DAG。空 `GIT_ALLOW_PROTOCOL` 是 Git 2.43 兼容的传输关闭机制；不得调用或依赖当前环境不支持的 `--no-lazy-fetch`。输出不可解析、提交/tree/blob 缺失或任一进程非零立即失败。扫描只读且无网络，不调用 fetch、checkout、reset、update-index 或其他修改仓库状态的命令。
- `scripts/content/frontmatter.mjs` 以结构化解析器拥有 Markdown/MDX frontmatter 解码；当前内容、历史对象和 Docusaurus callback 必须复用该入口。历史身份提取器只读取 E-013 的最小不可变快照，不用当前完整内容 schema 重新裁决旧提交。文章快照要求每个候选目录恰有一个正文入口及一个规范 articleId；注册表快照只读取 project、`(project,module)`、author 与 topic ID。旧提交中尚不存在的内容根、注册表文件或 `writingModules` 按空身份集处理；一旦存在就必须结构化解析并通过最小身份合法性与重复检查，忽略与身份无关的旧字段。当前工作区由正常当前 schema 校验后投影为 `HEAD` 的候选子快照，两条路径必须调用相同的 ID 规范化和重复检测函数。
- 每个提交分别保存当前快照和从父提交合并的历史 ledger，不能用一次全局线性“最后看到”状态替代 DAG。source-name ledger 保存唯一 articleId，articleId 与注册表 ID ledger 分别保存首次引入 commit 作为 lineage origin。ID 首次出现时记录当前 commit；从父历史继承时，全部非空父 origin 必须一致，平行分支独立首次引入同一 ID 因 origin 不同而失败，即使 merge 当前快照只保留一个。合并父对同一 source-name 给出不同 articleId 时也失败；当前 ID 不在任何直接父快照但已在父 ledger 出现时判定为删除后重引。只要 articleId 仍在至少一个直接父快照中且 lineage 唯一，连续修改、正常 merge 和保留 ID 的原子目录改名可以继续；同一快照重复 ID 或 source-name 改绑仍失败。
- author 创建入口在写 staging 前把显式 source-name 与生成的 articleId 作为候选叠加到当前工作区快照并调用同一 ledger；历史不完整、候选冲突或当前树已有错误时不得创建目录。质量检查则校验真实工作区候选，允许普通未提交编辑但不读取 index 代替文件系统。
- fixture 必须建立真实临时 Git DAG，至少覆盖：连续修改、同 lineage 原子改名、同 source-name 换 ID、ID 删除后重引、稳定注册表 ID 删除后重引、平行分支独立首次引入同一 articleId/注册表 ID、同一快照重复 ID、merge 第二父冲突、一个父仍保留文章的正常 merge、depth-1 clone、非 Git/bare 仓库、缺失对象，以及 partial/promisor/alternate object store 在远端 sentinel 未执行前失败。frontmatter fixture 必须证明构建回调、当前扫描和历史扫描对合法、非法及嵌套 YAML 得到相同结构化结果或相同失败；每个失败断言稳定错误 code、相对路径或 commit ID，不锁定本机路径和整段 Git stderr。

来源：D-063、D-064、D-065、D-078、E-003、E-013；CODE-003、CODE-004、CODE-014、CODE-016。

### CODE-019 服务端重定向派生与 release 绑定

- `scripts/release/lib/runtime-redirects.mjs` 是 E-014 路径规范化、公开 HTML 路由提取、规则闭包、稳定序列化与 Nginx 渲染的唯一实现，并提供相邻 `runtime-redirects.d.mts` 供严格 TypeScript 构建适配只读调用。`scripts/release/package-site.mjs` 生成制品，`scripts/quality/check-release-package.mjs` 从原始输入独立重算；两者必须调用同一库，不复制正则、排序、链环检测或配置模板。相关 `.mjs` 均加入 `check:js` 明列清单。
- 生成入口只接受 realpath 后的 production `build/`、仓库固定 `docs/contracts/redirects.json`、精确 40 位 commit SHA 和站点配置中已经校验的 canonical origin；不接受 preview、任意 registry 路径、origin 覆盖、状态码、Nginx 模板或额外规则参数。它从根 `index.html` 与规范子目录 `index.html` 建立公开页面路由集合，单独识别并排除 `404.html`、静态资源和保留文件；每个注册表 `to` 必须一对一映射到当前 payload 页面，每个 `from` 对应的静态 HTML 必须不存在。
- 路径先按 E-014 的正向 allowlist 校验，再构造规则；不对非法输入做 percent decode、Unicode/case 折叠或 slash 修复。每个登记项生成规范 source 与无斜杠别名两个 `registered` 规则，两者直接到最终 `to`；每个根路由以外的活动页面生成一个 `canonical-slash` 规则。合并后按 `from` ASCII 升序，任何 source 重复、规范化碰撞、目标同时为 source、自跳、链或环都以稳定 `RELEASE_REDIRECT_*` code 失败，不能靠后项覆盖前项。
- `runtime-redirects.json` 只含 E-014 固定的三个顶层字段；每个 rule 只含按 `kind`、`from`、`to` 顺序序列化的三个字段。对象键固定顺序、数组按 source 排序、UTF-8、LF、2 空格和单个末尾换行；不读取系统时间，不写绝对路径、commit、`reason` 或摘要。Nginx 文件按相同规则顺序为每条规则生成固定三行 block：exact `location` 起始行、2 空格缩进的 `return 301` 行和闭合行，block 之间不插入源文本；目标 origin 使用已校验常量，查询只通过字面 `$is_args$args` 保留。禁止注释、regex、`map`、`if`、`$host` 或 server 级 `return`。
- `package-site.mjs` 在复制完成且源 build 未变化后生成两个派生文件，再把源注册表原始字节摘要、按公开路由排序后的集合摘要、两个派生文件摘要和规则数写入 `release.json`；`files.sha256` 覆盖 payload 与两个可部署文件。检查器必须重新读取 build 和源注册表生成期望字节，验证 registered 与 canonical-slash 数量、全部摘要和 source 静态页面缺失，并拒绝手工修改 metadata 后自洽但不再可从源重建的 artifact。
- 服务器安装契约不允许重新解释 `redirects.json` 或运行仓库 Node.js：固定发布脚本只校验并复制两个已绑定文件到 release 的非 Web Root `config/`，再生成只含精确 SHA 绝对 payload root 与同 SHA include 的 `site-release.conf`。root-owned `/var/lib/axialmuse/url-exposure-ledger.json` 是独立于 release 的只追加生产证据；固定部署实现必须用结构化 JSON 解析维护它，只接受 E-014 的 `publishedRoutes` 和 `kind: "registered"` 历史边，`canonical-slash` 不入边账本。实现必须拒绝未知字段、非法路径、非 40 位 SHA、重复记录、删除或改写既有记录，并以同目录临时文件、flush 文件与父目录、原子 rename 更新。账本不得进入 artifact、Web Root 或仓库编辑源，也不得从当前配置、注册表或单个 release 自动重建；实施服务器所用的具体结构化解析工具属于服务器软件安装，仍须按部署文档现场核验和授权。
- 兼容检查复用 CODE-019 的路径与 runtime manifest 解析，但不生成或改写候选规则。对候选 payload/rules 定义最多一步的 `resolve(path)`：200 route 返回自身，exact source 返回其当前 200 target，其他失败；账本中每个历史 published route 必须可解析，每条历史 registered edge 的 `from` 与 `to` 必须解析到相同终点。新边可以把既有 source 改指新的最终页面，但旧 target 必须继续为 200 或成为直达同一终点的 source。候选配置先在隔离本机 Nginx 监听地址完成全规则 HTTP 测试；随后把候选全部规范 200 路径和新增/改指的 registered 边作为潜在暴露原子并入账本，再切 `current`、`nginx -t` 和 reload；这使 `canonical-slash` 的 target 也在公网可缓存前得到保护。只有预先选出的 fallback release 也通过并入后账本时才允许自动回滚；没有兼容 fallback 的候选默认失败，显式生产授权选择 forward-only 后，reload 或公网冒烟失败必须保持兼容闭包并向前修复。公网冒烟与账本备份记录都成功后才能标记 deployment 成功。
- 验收 fixture 使用最小真实 Nginx 配置或实施环境的系统 Nginx，证明四个已知 scheme/host server 在 ACME 和未知 Host 边界不变时返回单跳 301、唯一 `Location`、查询串保留和目标 200；`nginx -t`、隔离候选、reload、公网断言、账本更新或兼容性检查任一失败都不得把 release 标记成功。测试必须分别证明“旧 release 有目标页面但缺少历史 source 规则”不可回滚、二次迁移的全部历史路径收敛到同一 200、新页面仅产生 `canonical-slash` 时也会在 reload 前预写 target 并拒绝缺页面的旧 fallback，以及 forward-only 边界不会自动恢复不兼容 release。账本初始化 fixture 只允许“无活动 release 且上线授权明确”的空站点模式，或显式导入可审计既有生产记录；已初始化后的账本缺失不能再走首次模式。

来源：D-005、D-035、D-038、D-053、D-078、E-002、E-005、E-014；CODE-003、CODE-004、CODE-011、CODE-015。

### CODE-020 production build 字节所有权与最终 artifact

- `production-artifact` 是 E-015 唯一可部署 build producer，必须是非 matrix、无 environment、无 repository/environment Secret 的单 job。它与四个 prerequisite job 的 `permissions` 只允许 `contents: read`，未列权限均为 `none`；不得授予任何 write、OIDC 或 attestation scope。它不得配置 `actions/setup-node` cache、调用 cache restore/save Action，或读取任何跨 step、跨 job、跨 run 共享或复用的依赖/build cache；E-010 为本次 job 新建且不复用的私有 npm cache 是冻结安装的必需隔离目录，不属于被禁缓存。workflow 静态门禁要求它直接 `needs` `website-quality`、`node-minimum`、`diagrams`、`supply-chain`，不得使用 `always()`、`continue-on-error` 或自写表达式把非 success 转成可运行；触发谓词只允许 canonical repository 的 `push` `refs/heads/main`，以及保留人工入口时 canonical repository 的 `workflow_dispatch` `refs/heads/main`。PR、fork、Dependabot、`dev`、tag 和其他 dispatch ref 不得生成最终 artifact。
- fresh runner 的 checkout 必须显式精确 `github.sha`、`fetch-depth: 0`、`persist-credentials: false` 且无 partial/sparse 选项；随后验证 `HEAD` 和事件 SHA 相等，并在安装前要求 checkout 中不存在 `build/`、`dist/`。Node/npm 只读 `.nvmrc` 和已准入随附版本；E-010 `ci` profile 使用全新 HOME/config/cache 冻结安装并验证 `package.json`、`package-lock.json` 前后摘要不变，不恢复依赖或 build cache。缺失 lock、浅历史、预存输出、安装失败或任何漂移都失败。
- 同一 job 通过 E-010 `run-script` 执行完整 `quality`；它必须实际生成唯一 production `build/` 并完成 typecheck、E-012 测试、E-013 历史、资源白名单、泄漏和静态制品检查。成功后只允许仓库内零第三方依赖入口依次运行 `package:artifact` 与 `scripts/quality/check-release-package.mjs`；中间不得执行 Action、安装、第二次 build 或其他可写 build 的命令，也没有下载、旧目录或 preview fallback。独立的 minimum、diagram、supply-chain 职责由 prerequisite job 提供，不在此处复制。
- `scripts/quality/lib/file-tree.mjs` 唯一拥有仓库侧 build/release 路径枚举与内容摘要：只接受规范相对 POSIX 普通文件，拒绝符号链接、硬链接、特殊文件、隐藏 path segment、绝对或父级路径、控制字符、重复规范化路径和大小写冲突；按路径原始 UTF-8 字节无符号字典序排列。树摘要输入先写入 ASCII `AXIALMUSE-FILE-TREE-V1` 和单个 `0x00` byte，再顺序写入 records，最后对完整输入计算 SHA-256；每条 record 精确为 8-byte big-endian unsigned path byte length、path UTF-8 原始字节、8-byte big-endian unsigned file byte length、32-byte raw `SHA-256(file bytes)`，摘要输出为 64 位小写十六进制。mtime、uid/gid、mode 和空目录不是内容身份；服务器最终统一目录 `0755`、文件 `0644`。CODE-015、CODE-019、封装器与独立检查器必须调用该库，不复制仓库内文件遍历、排序或摘要算法。这里的“唯一”仅限仓库内实现；跨 TAT 信任边界故意保留第二个 root-owned 服务器 verifier，它不运行或导入仓库 Node 模块，而是按上述 wire format 独立实现。两端必须共享至少一个空文件、非 ASCII UTF-8 path、多文件排序和单字节变化的固定 golden vectors；任一端不接受全部相同向量和负面路径 fixture 就不得接线，借此防止双实现漂移。
- `package-site.mjs` 在复制前、复制完成后和独立校验结束后重算原 build tree；三次摘要必须相同，且逐路径复制得到的 payload tree 必须一一对应。`release.json.sourceBuildTreeSha256` 保存该值。独立校验结束后，零依赖入口以同一文件树格式对 `dist/release/` 内全部普通文件计算 `releaseContentSha256`；该值是 artifact 外的 job output，不写回 release，避免自引用，也不能由 release 内 metadata 自报代替。后台新增、删除、改名、改字节，或检查后替换 build/release 都必须在本地检查或服务器对该期望值的独立比较中失败。`website-quality` 与本 job 对同一 SHA 的输出无需相等，本契约不宣称可复现构建，只证明最终 build 自身经过完整重验。
- 上传步骤只能紧接在 `releaseContentSha256` 计算后执行一次，路径精确为 `dist/release/`，要求 `if-no-files-found: error`、`overwrite: false`、显式不包含隐藏文件，并禁止 glob、多路径、merge 或重复 upload。门禁必须在 Action 前证明 release 无隐藏路径、只有允许文件且摘要未变。Action 的固定源码和 `action.yml` 必须提供不可变 `artifact-id` 与 `artifact-digest` 输出并符合既定 overwrite 语义，不要求 upload Action 承担 download digest mismatch。`artifact-id`、`artifact-digest`、上传前 `release-content-sha256`、repository、run ID、run attempt、commit SHA 映射为彼此独立的 job outputs。展示名含 SHA/run/attempt 仅用于识别，deploy 不得按名称、pattern、latest、URL 或跨 run 查询。
- 上传后，`production-artifact` 必须先用仓库内零依赖步骤验证 Action 输出非空且 artifact ID 为十进制、两个 job output 摘要均为裸 64 位小写十六进制，再映射 job outputs。`deploy-production` 只能直接 `needs` 当前 run 的这些输出，job `permissions` 只允许 `contents: read`、`actions: read`，其余为 `none`；在任何步骤引用 CAM Secret 或调用腾讯云 API 前，它必须用只读 GitHub API 验证当前 canonical `refs/heads/main` 仍等于 `commit-sha`，并复核 repository、run、artifact ID、`head_sha`、未过期状态。REST artifact metadata 的 `digest` 必须逐字节等于 ASCII `sha256:` 拼接裸 `artifact-digest`；缺失、其他算法、重复前缀、大小写或长度异常均失败，不做宽松剥前缀。concurrency 只承担互斥，不承担新鲜度或顺序保证。错误或已移动 main、旧 run 重跑、错误 ID、同名异 ID、过期/删除、外层或内部摘要不符，以及输出来自其他 job/run/repository 时失败，不回退到名称查询、重新构建或服务器现场封装；历史 SHA 恢复必须走另行授权流程。中间质量 build 不上传，也不存在可部署身份。
- fixture 与 workflow 静态检查覆盖 E-015 的全部负面路径：prerequisite failure/skip/cancel、事件或仓库不符、matrix/`always()`/`continue-on-error`、`actions/setup-node` cache、cache restore/save Action、共享或复用的依赖/build cache、浮动 Action、浅 checkout、预存或 preview build、lock 漂移、quality 后与封装期间的文件竞争、独立检查后到 upload 读取前整版替换 release、非法文件/路径、空或多次上传、错误 artifact 输出、过宽 token 权限、旧 run 晚到或重跑、main 移动和 deploy 身份替换；同时以正面 fixture 证明 E-010 为本次 job 创建的全新私有 npm cache不会被误拒。服务器 fixture 必须证明它分别比较 `artifactDigest` 和 artifact 外传入的 `releaseContentSha256`，替换为另一份内部自洽 release 仍失败。Artifact attestation、download-artifact 和额外 OIDC/attestation 权限不属于 M0；未来引入须重新走外部能力与供应链门禁。

来源：D-053、D-077、D-078、E-005、E-010、E-013 至 E-015；CODE-012、CODE-015、CODE-016、CODE-019；[GitHub prerequisite jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs#defining-prerequisite-jobs)、[actions/upload-artifact](https://github.com/actions/upload-artifact)。

## 实施前置清单

下列内容影响目标源码结构，必须在依赖代码创建前完成事实查证并写入对应设计。#9 已完成 E-010 实现与 fixture，#5 至 #8、#10 至 #14 继续跟踪其余实现。D-078 委托范围内的工程细节由 Agent 形成可验证决定，不再逐项请求用户确认；D-078 排除的外部操作、依赖最终准入、数据与基础设施事项仍执行用户门禁：

Roadmap 的实现所有权固定为：I-01 / #9 在隔离入口同一任务中创建 D-067 的 `.nvmrc`、`engines.node` 兼容边界，并以 D-073 主/最低随附 npm 完成离线真实 CLI 验收；I-03 / #21 消费该版本契约完成真实依赖准入；I-04 / #22 不再创建或选择版本文件，只在已验收版本与依赖图上建立 Docusaurus scaffold、严格 TypeScript、模块边界、typecheck 与 build。该调整只消除任务产物倒置，不改变上层版本治理或外部操作授权。

1. 消费已验收的 E-010 隔离入口、项目配置、registry/lock 扫描和双端点版本契约，继续实现 E-011 SPDX 规范化及 D-077 策略与记录；实际联网和安装前，对真实候选 lockfile 和传递图取得人工通过结论，生成并校验 SBOM/NOTICE，完成显式 audit、双端点冻结安装、制品网络检查和浏览器 allowlist。
2. 按 CODE-002 至 CODE-005 创建并机器校验实际 `tsconfig`、公共入口、命名和模块边界脚本；这些是实现任务，不再重新选择目录和 API 契约。
3. 按 D-079/E-012 接入独立 `tsc --noEmit`、临时编译后的 Node ESM 测试与 Docusaurus build；先让 `@types/node` 随真实候选图通过 D-077，再创建测试配置、runner 和 fixture。formatter、lint、真实浏览器与可访问性工具继续依据 D-078 选择；新增第三方包或 Action 必须先通过 D-077，不因工具选择已委托而跳过实际准入。
4. 按 E-007 至 E-009、CODE-008 和 CODE-017 实现主预览 schema、临时静态白名单树、草稿候选、失败保留旧预览和泄漏 fixture；再按 E-004 和 CODE-006 至 CODE-008 实现 React、Infima、CSS Modules 与令牌。只有浏览器 fit-gap 证据允许最小主题包装。
5. 按 E-006/E-007、产品字段表和 CODE-003/CODE-004 实现项目内容、媒体 schema、注册表、路径、错误和迁移；再按 E-013/CODE-018 实现完整历史 ledger、CI checkout 和 fixture，完成后才按 CODE-014 接线作者命令。公开业务事实和素材仍须由用户提供或确认。
6. 按 CODE-013 实现日期索引、侧栏、列表模型和 SEO 标签合并；按 E-014/CODE-019 实现服务端 301 规则、确定性派生文件、release 摘要和 fixture，再按 E-015/CODE-020 实现 production job 自包含重建、字节摘要和最终 artifact 身份；不授权实际发布或基础设施操作。
7. 按 E-013/E-015 接线 Ubuntu nvm 与 Action 固定、Node 24 两个版本入口、共享负载、required check、完整历史、production artifact 和迁移顺序。

这些事项未完成时，可以维护迁移前静态页、现有质量脚本和设计文档；不得据此创建 Docusaurus 工程骨架、目标内容树或对外宣称目标门禁已经实现。

## 可执行覆盖矩阵

| 规则或事实 | 当前证据 | 自动化状态 |
|---|---|---|
| 文档索引与内部链接 | `node scripts/quality/check-markdown.mjs` | 已自动化 |
| 现有契约词规则 | `node scripts/quality/check-contracts.mjs` | 已自动化，范围有限 |
| 现有质量脚本语法 | `node scripts/quality/check-javascript.mjs` | 已自动化，仅明列 `.mjs` |
| npm 启动前隔离、版本与旁路边界 | `node scripts/quality/check-npm-isolation.mjs`、E-010 fixture | 已自动化；真实依赖准入未开始 |
| 常见密钥形态 | `node scripts/quality/check-secrets.mjs` | 已自动化，启发式且扩展名有限 |
| 迁移前手写入口 | `node scripts/quality/check-static-site.mjs` | 已自动化，缺失输入会跳过 |
| PlantUML 源码可编译 | Ubuntu `diagrams` job 或本地 `check:diagrams` | 已自动化 |
| PlantUML SVG 已刷新 | `gen:diagrams` 后人工 diff | 尚无稳定门禁 |
| 通用文件卫生 | `.editorconfig`、`.gitattributes` | 仅配置约定，尚无 CI 检查 |
| 严格 TypeScript 与独立类型检查/构建 | D-074 设计契约 | 目标已确认，当前未实现 |
| 模块目录、公共入口、导出与别名边界 | D-075 设计契约 | 目标已确认，目录和自动检查均未实现 |
| 首轮直接依赖与生产/测试 `tsconfig` 基线 | D-076、D-079、E-012 设计契约 | 候选与配置目标已确认，供应链准入、lockfile、配置与安装均未实现 |
| 首次依赖解析与供应链准入 | D-077 设计契约 | 协议与阈值已确认，策略、记录、真实候选图、派生制品、审计和 CI 均未实现 |
| Node ESM TypeScript 测试 | D-079、E-012、CODE-005/CODE-011/CODE-016 | 设计已确认，依赖准入、runner、fixture 与 CI 均未实现 |
| HEAD 可达完整 Git 历史与稳定 ID | E-013、CODE-018 | 设计已确认，检查器、临时 Git DAG fixture、作者集成与 CI checkout 均未实现 |
| 服务端 301 与同版本 release | E-014、CODE-015/CODE-019 | 设计已确认，生成器、派生配置、摘要、Nginx 冒烟和回滚兼容检查均未实现 |
| Production build 与最终 artifact | E-015、CODE-015/CODE-016/CODE-020 | 设计已确认，自包含重建、树摘要、workflow 门禁、上传和 deploy 输出校验均未实现 |
| Docusaurus/React/内容/制品/浏览器契约 | D-078、E-001 至 E-015、CODE-003 至 CODE-020 | E-010 已实现；其余目标已固定，当前未实现 |
| Node 24 精确与最低端点 | `.nvmrc`、`engines.node`、E-010 双端点离线 CLI | 本地契约与真实 CLI 已验收；目标 Ubuntu jobs 由后续任务接线 |

## 本 Spec 验收

- 本文只拥有代码级职责，不复制上层字段表、页面数值、发布步骤或基础设施命令。
- 每条 `CODE-*` 都给出上层或当前仓库来源；领域测试继续直接引用 D-xxx 与原契约。
- 当前能力、目标约束和实施阻塞明确分开，不把迁移前脚本的有限行为包装为目标方案。
- 新文档已进入 `docs/README.md`，现有 Markdown 内链、契约词、Secret 和静态入口门禁通过。
- 本文不新增第三方依赖、浏览器外部请求或用户数据处理。

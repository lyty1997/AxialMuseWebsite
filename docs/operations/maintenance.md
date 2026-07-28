# 自动化维护与运行手册

状态：draft
最近更新：2026-07-27
适用范围：M0 腾讯云主站与项目体验子域名的自动发布、监测、备份、安全维护与故障处理

## 目的

本文定义 `axialmuse.com` 主站及已登记项目体验上线后的最低运行标准，让日常维护依赖可重复检查和明确告警。首版由 Nginx 承载静态站点与静态项目体验，优先自动化发布、证书、健康检查和备份，不引入应用后端、数据库或第三方页面监测脚本。

D-053 已固定 Docusaurus 官方静态能力、现有 PlantUML、Nginx/Certbot、GitHub Actions/TAT、Ubuntu/systemd 原生运维和 CI 门禁能力类别；D-073 至 D-077 固定框架、工具链、TypeScript、依赖与首次供应链准入边界，D-078 授权内部工程收敛，D-079 固定 Node 测试类型直接候选，E-005 固定静态 artifact 交付链路，E-010 至 E-015 固定 npm 启动前隔离、确定性 SPDX、Node ESM TypeScript 测试、HEAD 可达完整 Git 历史、同版本服务端 301 和 production artifact 自包含字节闭包。仓库已经具有 Docusaurus、真实依赖图和 production build 的本地实现；D-097 又把第一阶段可信 CI 接入当前工作区，D-098 路径传输修复与两个 Node 端点的全新冻结安装、完整代码/构建负载已通过本地验证。D-099 已从普通 push/PR CI 移除 live npm audit，静态供应链证据继续失败关闭；已观测的 18 个 high 依赖节点仍是未修复风险，但不再阻断普通 CI。因此本地第一阶段的确定性负载已通过，真实 GitHub run、required checks、生产 workflow、artifact、environment、服务器配置和定时任务仍未闭合或部署。

## 服务目标

| 指标 | M0 目标 |
|---|---|
| 发布来源 | 仅 GitHub `main` 的精确提交 |
| 恢复时间目标 RTO | 4 小时 |
| 单个静态项目体验 RTO | 8 小时，不影响主站恢复优先级 |
| 恢复点目标 RPO | GitHub 最后一个成功生产提交 |
| 可用性观察 | 每日自动冒烟检查，发布后立即检查 |
| 域名与服务器续费 | 自动续费开启，提前 60/30/7 天人工确认 |
| TLS 告警 | 剩余有效期低于 21 天 |
| 内容复核 | 每月一次 |
| 权限与恢复复核 | 每季度一次 |

这些是个人项目的内部运行目标，不是对外服务等级承诺。

## 自动化流水线

### Pull Request 门禁

每个面向 `dev` 或 `main` 的 PR 必须自动执行：

- JavaScript 语法检查。
- E-010 npm 配置、双端点版本闭包、隔离环境、lockfile 来源与旁路检查。
- Markdown 索引和内部链接检查。
- 契约词表与禁用表达检查。
- 常见密钥形态扫描。
- 静态站点入口、资源和关键锚点检查。
- E-010 正常、异常和边界 fixture。
- PlantUML 图表编译检查。

#### Docusaurus 目标门禁

上述列表描述迁移前骨架已经存在的检查。接入 Docusaurus 后，普通 PR/生产发布与显式依赖准入合计必须实现 D-053 已确认的全部能力类别；每类能力在哪个入口执行由 D-077 与 D-099 的边界决定：

- D-073 的三个 Docusaurus 包保持同一精确版本，仓库只存在一个 `package-lock.json`；正常验证、CI 与构建只能通过 E-010 的隔离 `ci` profile 在全新 cache 中冻结安装并完成可重复 Docusaurus 构建，不能直接调用 npm 或恢复共享 npm cache。
- D-076/D-079 的首轮候选直接依赖名称和 manifest 版本表达必须精确匹配获批清单，其中 `@types/node` 只作为 E-012 测试类型直接开发候选；范围的实际解析结果由唯一 lockfile 冻结。未列直接依赖、候选传递依赖或 lockfile 漂移必须进入 D-052 准入流程，不能因模板存在、传递提升或 ambient 声明而放行。
- 只有主端点可通过 E-010 的隔离 `resolve-lock` profile 解析已批准 manifest；入口在启动 npm 前清除用户与全局配置、共享 cache、代理和自定义 CA 影响，并离线核验官方 registry 与无 scoped/auth 配置。候选 lockfile 必须是版本 3，只能引用官方 npm registry，并由零第三方依赖策略脚本失败关闭检查直接清单、来源、适用节点的 `resolved`/`integrity`、声明许可证与安装脚本标记。
- 正常安装前按 lockfile 获取精确 tarball，但不得执行包代码或脚本；复核 integrity，并检查实际 `package.json`、许可证文件、NOTICE 和生命周期脚本。许可证证据缺失、未知、推测性、复杂或未批准时暂停，生命周期脚本默认拒绝，任何例外必须按精确 `name@version` 重新取得用户确认。
- 候选报告先供人工填写尚未提交的逐包预审 admissions；这些字段只表示许可证、脚本、用途和义务预审已闭合，不表示真实图最终准入。隔离 `sbom-native` profile 只生成 npm 原生 SPDX 2.3 语义输入；E-011 规范器移除原生易变时间与 UUID namespace，按明确无序集合稳定排序，并对固定 npm 生成但不符合 SPDX 2.3 `idstring` 的 package ID 做逐包证明、全引用一致且碰撞失败的语法合法化；固定 npm 因重复物理路径输出的完全相同 relationship triple 只在字段和引用验证后收敛为一个集合成员；lock 缺失许可证而 native 为 `NOASSERTION` 时，只允许同轮 integrity 已验证 tarball 的实际声明补足 canonical `licenseDeclared`，任何非空声明冲突仍失败。随后使用显式 UTC 秒精度 `createdAt` 与 canonical 摘要派生 namespace；name、version、purl 和关系语义不得改变，并生成 canonical 但尚未准入的确定性 SBOM、evidence 与 `THIRD_PARTY_NOTICES`。两个空临时目录的输出必须逐字节相同；CI 和构建不得读取系统时间补齐。`package.json`、lockfile、人工准入记录与派生制品分别只拥有直接意图、完整图、不可派生结论和生成结果，不得相互复制成人工维护的依赖清单。
- 隔离 `audit` profile 只属于显式依赖首次准入或依赖图变化后的重准入，不属于普通 push/PR CI；其全图审计必须包含开发依赖，`moderate`、`high`、`critical` 阻断，`low` 报告，禁止使用审计自动修复子命令，registry/audit 不可用时失败关闭，最终人工图准入结论只能在漏洞门禁通过后形成。audit 失败时不得提交预审 admissions 或三件套，也不得运行双端点 `ci`。当前 admissions schema 和派生制品都不单独编码 audit/最终批准状态，因此最终结论还必须由同一次受限 audit 证据、显式决定记录和双端点结果共同证明，不能由普通 CI 的静态闭包代替。该构建期请求会向官方 npm registry 发送包名和版本，回退协议可能发送完整 lockfile 树及 npm/Node/平台/架构/环境元数据；不包含站点内容或访问者、账户、评论数据，也不产生浏览器请求。
- audit 与显式最终准入决定通过后，首次真实图完整准入使用 `node scripts/quality/run-final-supply-chain-admission.mjs`，并按固定顺序提供候选报告/receipt、原始 audit/receipt 和最终决定五个绝对受限路径；入口不生成或推断人工决定。它先持有并复核五份 `/tmp` 证据、仓库六项供应链固定输入、正式 admissions/evidence/NOTICE/SBOM 及目录链，再调用下层零参数 `run-dual-endpoint-ci.mjs` 核心。双端点命令必须由精确主端点在 Linux x64 运行；它不调用 nvm、不改变本机默认版本、不接触仓库根 `node_modules`，而是在两个私有 `/tmp` project copy 中分别调用 E-010 `ci`。最低 Node 只从固定 Node.js 官方 `24.16.0` Linux x64 制品临时下载；在 64 MiB 上限内核对固定 SHA-256 后，受控系统 tar 只消费该已验证内存快照，archive 在 tar 后仍复核，解压信任树在版本/npm 探针和最低 worker 前后保持同一身份与内容状态。主端点使用当前 Node `24.18.0`/npm `11.16.0`。任一证据、端点、共同输入摘要、根输入复核、临时对象身份复核或安全清理失败都不产生最终成功 receipt。双端点 receipt 和最终 composite receipt 分别保存在 `/tmp` 的 `0700` 目录和 `0600` 文件中；最终 receipt 嵌入无包名准入摘要、完整双端点结果及其摘要，只有命令成功返回的精确 `receipt.json` 才能作为最终 artifact，`receipt.pending` 和 cleanup-uncertain 残留必须拒绝。失败输出只保留受控错误码与泛化说明，普通日志不得包含包名、npm 输出、本机路径或环境值。临时安装树和最低 Node 在先 quarantine、后逐对象证明所有权的清理闭环中删除；显式准入流程的受限证据目标保留期为 30 天，普通 CI 不产生或上传 audit artifact。单独双端点 receipt 只证明安装端点，不构成最终准入。该流程要求仓库根与同 UID 临时区没有并发写者；纯 Node 最后一次身份检查到逐路径删除之间的纳秒级窗口不是可被 receipt 消除的原子隔离。
- 构建配置保持 `future.v4: true` 与 `blog: false`，且不启用搜索、统计或其他未批准的浏览器外部请求。
- Docusaurus 管理的目标源码按 D-076 的官方根 `tsconfig` 继承、显式收紧、首轮 `include` 和无自定义 `paths` 规则独立运行 `tsc --noEmit`；E-012 的测试 program 另行覆盖 NodeNext/ES2024、Node types 与临时 emit，由当前 Node `--test` 直接执行；Docusaurus build 再独立验证框架加载和静态制品。三项都必须通过，不能互相替代。
- 失败关闭检查 D-075 的物理层边界、跨层深层导入、宽泛 `export *` 与未批准自定义路径别名；具体工具和接线按 D-078 在实现前落盘并验证。
- E-012 的 `test` 入口必须在系统临时目录编译并执行领域/构建 TypeScript 测试，稳定显式列出 `*.test.js`，拒绝零测试、无扩展名或 `.ts` 运行时说明符、loader、实验解析、按需下载的包执行器和仓库内 emit，并在主 Node 与最低 Node 端点运行同一测试集合。
- E-013 的历史门禁必须以统一结构化 frontmatter 解码，从完整非浅 Git worktree 扫描当前 `HEAD` 可达祖先和 PR merge commit 两个父历史；拒绝 partial/promisor/alternate object store、缺失对象、任何协议访问、source-name/articleId 改绑或删除后重引、平行分支独立引入同一 ID，以及稳定注册表 ID 重引。不得扫描 `--all`、远端废弃分支或用当前树 fallback 代替历史。
- lint、Markdown/MDX frontmatter 和内容模型校验。
- 内部链接、资源、路由、canonical、sitemap、草稿泄漏和关键公开事实检查；E-014 还要求同一 production payload 派生旧路径/无斜杠 301，拒绝静态 source HTML、缺失目标、链、环和配置注入。
- 发布态项目素材与机器路径白名单检查：根配置固定 `staticDirectories: []`，仅服务端 `postBuild` 从已验证私有临时树复制；`build/assets/projects/**` 与 production 白名单逐路径、逐字节一致，未发布素材的路径/字节，以及仓库根、候选输出、generated files、受控构建与事务临时根等服务端绝对路径及其 JSON/JavaScript slash 转义、单层或双层 percent/file URL、Base64/Base64URL、十六进制等受控常见可逆文本表示均未进入最终文本制品；percent 与十六进制的 ASCII 大小写组合同样阻断。
- PlantUML 编译与静态 SVG 制品检查。
- 许可证准入（未知或未获批即失败）、传递依赖、第三方声明或 SBOM 和 Secret 检查；漏洞检查由显式依赖准入/重准入与 Dependabot Alerts 承担，不在普通 push/PR CI 重复联网。
- 构建制品外部请求 allowlist，以及依据真实制品验证的 CSP。
- 桌面端和移动端真实浏览器、关键链接和可访问性检查。
- 发布后 HTTPS、逐条单跳 301、唯一 `Location`、查询保留、目标 200、关键页面和资源冒烟。

D-077 已固定 npm 原生能力加零第三方依赖策略脚本、SPDX JSON、NOTICE 生成、漏洞阈值、脚本默认拒绝和审计失败关闭边界；E-010/E-011 已进一步固定并实现隔离入口、项目 `.npmrc` schema、临时环境、官方 registry 预检、lock 来源扫描、SPDX 规范化和稳定 evidence。#21 已完成固定策略与 admission schema、真实候选审查、精确 tarball 下载/解析、NOTICE 与 evidence、audit v2 严格解析、正式三制品发布、静态闭包、最终证据持有、双端点冻结安装和 composite receipt 的真实图本地验收。首版仍不引入第三方许可证扫描器、SBOM 生成器或 GitHub Dependency Review Action。

上述实现最初由离线 fixture 验收；D-081/D-082 授权后，真实解析、1,225 项精确候选/admissions、35/11/12 补充法律证据、正式 SBOM/evidence/NOTICE、当时漏洞全零的 audit、最终决定及 Node 24.18.0/24.16.0 双端点证明均已闭合。最初诊断的 20 个 moderate、1 个 high 已由两项精确传递 override 后的首轮最终 lock 和当时 audit 全零结果取代；2026-07-26 后续观测到的 18 个 high 仍是未修复风险，并按 D-099 移出普通 CI 而非视为已解决。后续联网动作继续受官方来源与受限证据边界约束；新增依赖、Action、脚本例外和其他外部操作继续受原门禁约束。缺失输入、零测试、浅/不完整历史、缺失或预存构建制品、静态重定向页、build 竞争修改或 payload/规则摘要不一致必须失败，不能沿用迁移前检查中对不存在入口的跳过行为；所有发布必需 job 通过后，`production-artifact` 才能在 fresh runner 重建、重验并封装最终 build。

D-065 的文章创建命令只允许作者在获准的 Linux 作者环境显式运行；Git hook、CI、预览、发布和生产内容门禁只能失败并定位非法内容，不得生成、修复、暂存或提交。D-066/D-067/D-072/D-073 要求获准作者工具、质量、PlantUML 和构建执行器使用 Node 24，主/最低端点以各自随附 npm 读取同一 lockfile，任何版本、配置、lockfile、外部请求或冻结安装偏离都失败。D-074/D-076 与 D-079/E-012 分别固定生产源码类型和独立测试边界；E-013 至 E-015 固定完整历史、同版本 301 和 production job 自包含重建。D-097 至 D-099 已把 workflow 收敛为固定 SHA 的官方 Action、Node 24 主/最低端点、完整 checkout、E-010 隔离冻结安装、独立 `quality`/`typecheck`/`test`/`build`、E-013 历史门禁、PlantUML 和静态供应链证据四类 job，并依 D-100 纳入专题分支；D-102 把依赖冻结的 E-013 从零第三方依赖 `quality` 拆为两个构建 job 的安装后独立入口，避免无 `node_modules/` 的 pre-commit 被阻断。普通 CI 不运行 live audit。D-101 只授权同名临时 ref 推送，该 ref 不触发现有 `main`/`dev` workflow，因此仍未取得真实 GitHub run。#21 的候选报告、正式三制品、最终决定和真实双端点依赖闭环，以及 TypeScript、E-012 runner、内容解码和模块边界已经完成；#24 作者创建工具也已完成本地验收并依 D-103 获准纳入当前专题分支提交及同名临时 ref，服务端 301、production artifact 和 preview 仍未完成。真实内容树除获准作者显式创建操作外始终只读，本轮未创建真实文章。

D-080 已单独完成当前 Linux 作者用户的固定 nvm/Node 24 安装与本地 pre-commit 自动选择：系统和新 Bash 默认 Node 保持不变，hook 不读取用户 npm `prefix`、不修改 shell 初始化或 alias，缺少精确运行时时失败且不联网。#24 文章创建工具已完成本地验收并依 D-103 获准纳入当前专题分支提交及同名临时 ref；这不改变系统默认 Node，也不等于远端验收或授权创建真实文章。

D-067/D-097 的 Ubuntu CI 边界与当前实施状态如下：

- 主质量 job 在任何质量命令前按 E-013 使用准入后完整 commit SHA 的 `actions/checkout`，设置 `fetch-depth: 0`、`persist-credentials: false` 且不启用 partial/sparse checkout；PR 不覆盖默认 merge ref。随后断言实际 Node 等于 `.nvmrc`、随附 npm 等于 D-073 主基线，并且 `actions/setup-node` 通过 `node-version-file` 消费该文件且不配置 npm cache；除受审依赖变更外只通过 E-010 的隔离 `ci` profile 冻结安装，并证明 `package.json` 与 `package-lock.json` 前后哈希不变。质量与构建 npm scripts 由隔离 `run-script` profile 调用；依赖冻结的 E-013 则由 `node scripts/quality/run-content-history.mjs` 在 `quality` 后独立调用。主基线的发布必需检查整体必须分别包含 D-074 的 `tsc --noEmit`、E-012 的 `test`、E-013 的历史门禁和 Docusaurus build；`website-quality` 的 job-local build 不发布，只有 E-015 的 `production-artifact` 在同一精确基线重新执行完整负载后产生的制品可以发布。Ubuntu PlantUML job 不运行历史门禁，无需为此扩大 checkout。
- Ubuntu CI 的最低版本任务使用与主质量相同的 E-013 完整 checkout，先断言实际 Node 等于 `engines.node` 下界、随附 npm 等于 D-073 最低端点，再对同一 manifest、项目 npm 配置与 `package-lock.json` 运行隔离 `ci` profile，证明 manifest/lock 前后哈希不变，并与主入口通过隔离 `run-script` profile 调用同一共享质量、独立类型检查、同一个 `scripts/quality/run-tests.mjs` 测试入口和静态构建负载，同时直接调用同一个安装后历史入口；它只替换版本断言，不写 lockfile、不跳过其他检查、不产出发布制品，也不触发文章创建或发布。
- 两个入口必须封闭，不得使用通用跳过版本检查的环境变量或参数；版本契约还要验证 `.nvmrc` 是兼容范围内的单个非浮动精确版本，最低版本任务值与 `engines` 下界一致。
- 只有明确的受审依赖变更可以在主基线按 D-077 生成候选 `package-lock.json`；候选经过证据审查和人工准入后，才可与对应 `package.json` 一并进入正常冻结安装。普通作者验证、非依赖 PR、最低端点和发布流程不得改写依赖图。首次迁移必须证明两个 npm 端点能读取同一 lockfile；任一端点失败时阻止迁移并回到依赖决策，不得重写锁文件掩盖不兼容。
- Node 24 安全 patch 被发现后及时发起独立升级 PR；其他 patch 至少每月检查。升级 PR 先修改 `.nvmrc` 候选值，Ubuntu CI 的主任务和最低版本任务、PlantUML 及届时发布必需门禁通过后才允许合并，不得自动合并，也不得在普通 patch PR 中修改 `engines` 边界。

D-097 至 D-099 已在工作区实现三个官方 Action 的精确 commit SHA、Node `24.18.0` 与 `24.16.0` 两个 job、同一隔离负载、D-075 模块边界、E-013 检查器与真实 Git DAG fixture、完整 checkout、四 job 拓扑和静态供应链证据；Ubuntu runner 通过固定 `actions/setup-node` 取得版本，不再引入 nvm 安装步骤。两端已在全新任务私有副本中仅连接官方 npm registry 完成冻结安装，并分别通过 `quality`、`typecheck`、223/223 测试与 production `build`；D-098 的机器路径门禁也已由两个不同私有根的真实 build 验证。此前 live audit 对 1,345 个依赖节点报告 18 个 high、0 个 critical，源于 `brace-expansion` advisory 经 `minimatch`/`serve-handler` 扩散到 Docusaurus 图；D-099 将 live audit 从普通 CI 移除，因此该结果继续作为 Dependabot Alerts 与人工维护跟踪的未修复风险，而不是 CI blocker。仍待闭合的是提交/推送后的真实 GitHub run、required check context 与 branch protection/ruleset，以及 production artifact/upload/deploy；依赖图若发生变化则另须按 D-077 完成失败关闭重准入。`tsc --noEmit`、E-012 测试与 Docusaurus build 的 npm script 名称已由 CODE-016 固定为 `typecheck`、`test` 与 `build`；CI 只经隔离 `run-script` 调用。E-005/E-015 仍要求 `production-artifact` 在 fresh runner 自包含重建、重验和封装，生产服务器不安装 Node/npm、不拉源码、不执行构建；相关上传 Action、artifact 读取边界、凭证、GitHub `production` environment、TAT 和服务器配置仍须另行准入、核验和授权。

影响 UI 的 PR 还必须在 E-009 的局域网静态预览制品完成桌面端、平板端和移动端截图。预览状态须报告活动 artifact SHA 与待验收提交一致；每个 HTML 均为 `noindex, nofollow`、无 sitemap，且 draft 只在“草稿”组可见。M0 没有公网 PR 预览，截图和质量结果共同作为合并证据；当前脚本尚未迁移完成，因此迁移前 `public/` 截图不能作为 Docusaurus 页面验收。

### 生产发布

当前四个 prerequisite 只在工作区形成第一阶段 workflow，尚未成为 `main` required checks；以下 `production-artifact`、上传、`production` environment、CAM/TAT 和服务器步骤仍是目标契约，均未实现或部署。

1. PR required checks 与本地预览验收均通过。
2. PR 合入 `main`。
3. GitHub Actions 对精确 `GITHUB_SHA` 运行 `website-quality`、`node-minimum`、`diagrams`、`supply-chain`；四项必须全部成功，不能用 `always()`、`continue-on-error` 或 skipped 结果绕过。D-099 后 `supply-chain` 的发布必需结论只来自静态供应链证据，普通 CI 不执行 live audit。
4. 非 matrix `production-artifact` 在 fresh runner 对同一 SHA 完整 checkout，验证 `HEAD` 后证明 checkout 中没有预存 `build/`/`dist/`，再以全新隔离 cache 冻结安装，并依次重新执行主端点零第三方依赖 `quality`、独立 E-013 历史入口、`tsc --noEmit`、E-012 Node ESM 测试和 Docusaurus production build，同时完成资源白名单与制品泄漏检查。它不下载 `website-quality` 输出，不读取 preview、原始素材目录或本地旧 build。
5. 同一 job 紧接着对该唯一 `build/` 计算前后树摘要，在 `dist/release/` 生成 `payload/`、确定性 `metadata/runtime-redirects.json`、`metadata/nginx/redirects.conf`、release 身份和逐文件摘要；独立复验后，从 exact release 全文件树计算不写入 artifact 的 `releaseContentSha256`，随即只上传一次并取得外层 `artifactDigest`。`deploy-production` 只消费 artifact ID、两个独立摘要及 repository/run/SHA job outputs，不按名称、latest 或跨 run 搜索。
6. `production` environment job 只以 `contents: read`、`actions: read` 的 `GITHUB_TOKEN` 复核 canonical `refs/heads/main` 仍等于本次 SHA，并验证当前 run/artifact/head SHA/外层 digest；通过前不得引用 CAM Secret 或调用腾讯云 API。随后最小权限 CAM 只向指定 TAT command 传递 workflow run/artifact 标识、提交 SHA、`artifactDigest` 与 `releaseContentSha256`。旧 run 晚到、人工重跑旧 SHA 或 main 已移动都失败；历史恢复另行授权。
7. 服务器从固定仓库读取 artifact 元数据，完成身份、摘要、归档路径安全和内部文件清单校验后，把已验证 `payload/` 与两个可部署派生文件安装到同一 `releases/<sha>/payload/`、`config/`；其余 metadata 不安装，任何 metadata 都不进入 Web Root。服务器不拉取源码、不运行 Node/npm，也不从源码 checkout 执行脚本。
8. root-owned 固定脚本生成只引用同 SHA payload/redirect config 的 `site-release.conf`，并在隔离本机 Nginx 候选上验证全部规则。部署锁内再用 root-owned URL 暴露账本校验每个历史路径可解析、每条历史边的 source/target 收敛到同一当前 200。候选的全部规范 200 路径和新增或改指的 registered 301 边必须在 reload 前只追加到账本；`canonical-slash` 不单独入边账本，但其 canonical target 已由路由预写保护。没有兼容 fallback 时默认停止，只有单独生产授权可选择 forward-only；首次发布新 canonical URL 时通常即属于该情形。
9. 账本预写成功后才切换 `current`、执行 `nginx -t` 和 graceful reload，再逐条检查 301、唯一 `Location`、查询保留、目标 200 与关键静态页面。失败只能整版恢复预选的兼容 release；forward-only 则保持历史闭包并向前修复。成功后核对预写摘要并完成账本备份与部署审计记录，随后才标记 deployment 成功；不得把规范路由延迟到冒烟后追加。
10. GitHub runner 从公网检查 HTTPS、canonical、登记和尾斜杠重定向、关键锚点和资源；发布者记录 run、artifact、payload/规则摘要、账本前后摘要、fallback/forward-only 结论、TAT invocation、部署 SHA、时间和验证结论。

四个 prerequisite 与 `production-artifact` 的 `GITHUB_TOKEN` 仅有 `contents: read`，`deploy-production` 仅有 `contents: read`、`actions: read`，未列权限全部为 `none`；禁止 write、OIDC/attestation scope 和 producer Secret。production environment 限制为 `main`，deployment concurrency 同时只允许一个发布；concurrency 只保证互斥且不保证等待顺序，不能替代 main HEAD 新鲜度检查。CAM 凭证只允许调用和查询指定 command/instance，不允许执行任意命令或管理其他云资源。

项目体验由各自仓库的 production workflow 发布，使用独立 environment、CAM 凭证、TAT command、deploy key、release 目录和 concurrency group。一个项目的发布失败不得占用或回滚主站及其他项目的版本。

### 定时检查

以下计划任务仍未创建；D-097 的四个 CI job 不代表定时维护 workflow 已经存在。

M0 在 GitHub Actions 增加以下计划任务：

| 频率 | 检查 | 失败表现 |
|---|---|---|
| 每日 | 生产首页 HTTPS、scheme/host canonical、登记与尾斜杠 301、标题、canonical、关键锚点和资源 | Workflow 失败并由 GitHub 通知 |
| 每日 | URL 暴露账本可解析、只追加摘要连续，每个历史 source/target 在活动 release 收敛到同一 200 | 停止发布与自动回滚，进入人工恢复 |
| 每日 | TLS 剩余有效期、证书主机名 | 低于 21 天或主机名错误时失败 |
| 每日 | 注册表中所有 `live` 项目体验的 HTTPS、健康路径、返回主站入口和备案页脚 | 任一项目异常时生成失败清单 |
| 每周 | 全站内部链接、公开外链、`robots.txt`、`sitemap.xml` | 生成失败清单 |
| 每周 | `@`/`www` 与已登记项目 DNS、nameserver、DNSSEC | 与生产清单和注册表不一致时失败 |
| 每月 | 内容更新时间、域名/实例到期提醒、仓库全量质量 | 生成维护 Issue 或检查报告 |

GitHub 计划任务可能延迟，不作为分钟级监控。M0 不注入浏览器端监测脚本；需要高频告警时再评估服务端外部监控及其数据边界。

## 服务器例行任务

### 每日

- ACME timer 检查证书续期，续期后先执行 `nginx -t` 再 reload。
- 检查 Nginx、TAT agent、systemd timer、主站及项目证书和磁盘空间。
- 检查系统安全更新失败和异常登录记录。

### 每周

- 应用已验证的安全更新；内核更新需要重启时安排维护窗口，不自动无提示重启。
- 检查 Nginx 错误日志、TAT 失败任务、发布目录数量和磁盘增长。
- 验证 `current`、活动 Nginx 精确 SHA root/include、payload/规则摘要、生产 SHA 与 GitHub deployment 一致。
- 逐项核对 `live` 项目的 current symlink、生产 SHA、注册表与 deployment。

### 每月

- 创建维护前快照或轮换现有快照，遵守轻量实例快照配额。
- 确认轻量实例套餐流量、磁盘、到期日和自动续费状态。
- 检查腾讯云安全通知、GitHub 安全告警和失败 workflow。

## 日志与隐私

自托管 Web 服务会产生技术日志，必须把它作为用户数据边界的一部分，而不能继续宣称“完全没有服务器日志”。M0 采用数据最小化策略：

| 日志 | 可能字段 | 用途 | 存储 | 保留 |
|---|---|---|---|---|
| Nginx access log | IP、时间、方法、路径、状态、User-Agent | M0 默认关闭 | 不落盘 | 无 |
| Nginx error log | IP、时间、路径、错误 | 故障与攻击排查 | 轻量服务器本地，仅管理员可读 | 7 天 |
| SSH/system auth | IP、时间、账号、认证结果 | 账户安全审计 | 轻量服务器本地，仅管理员可读 | 按系统轮转，目标 30 天 |
| TAT 执行记录 | 命令 ID、实例、时间、输出 | 部署和运维审计 | 腾讯云与 GitHub deployment | 腾讯云平台策略 + GitHub 历史 |

- 不把服务器日志发送到第三方分析或日志 SaaS。
- 主站与静态项目体验沿用同一最小日志基线；动态项目必须单独定义日志字段与保留周期。
- 日志不用于用户画像、营销或访问量统计。
- 错误日志中不输出 query 中的 secret、请求头、Cookie 或部署凭证。
- 只有故障、安全事件或法律要求触发人工查看；到期轮转删除。
- 后续若开启访问日志或分析，必须先更新数据字段、用途、保留、删除和隐私说明。

## 监测内容

### 可用性

- `https://www.axialmuse.com/` 最终返回 200。
- HTTP、根域只发生设计中的永久重定向。
- 活动运行清单中的每条规则返回单跳 301 和唯一 canonical `Location`，固定测试查询串保持不变，目标在同一 release 返回 200；登记 source 不返回静态 200 页面。
- root-owned URL 暴露账本的活动摘要与最近成功 deployment 一致；其中每个历史 published route 仍可解析，每条历史 301 边的 source 与 target 在活动 release 收敛到同一当前 200。
- 首页 HTML 包含预期品牌、canonical 和关键结构。
- CSS、图片、favicon、`robots.txt` 与 `sitemap.xml` 可访问。
- 未知 Host 不返回正式站点内容。
- 注册表中所有 `live` 项目体验返回预期健康状态、备案页脚与主站返回入口。

### 域名、备案与证书

- 域名注册、ICP 备案和腾讯云接入状态正常。
- 轻量服务器和域名自动续费开启，支付方式有效。
- nameserver、A 记录和 DNSSEC 与生产清单一致。
- TLS 证书覆盖根域与 `www`，剩余有效期不少于 21 天。
- 每个 `live` 项目子域名拥有独立有效证书，DNS 与注册表一致。
- 页脚 ICP 备案号与官方查询结果一致；取得公安备案后同步展示。

### 内容与搜索

- 生产页面没有 `noindex`。
- canonical 与站点地图只使用 `https://www.axialmuse.com/`。
- 项目体验默认 `noindex`；明确批准索引的项目使用自身主机名 canonical，不进入主站站点地图。
- Search Console 的抓取或索引异常在月度复核中处理，不把收录数量作为内容质量指标。

## 备份与可恢复性

### Git 真相源

源码、公开内容、服务器配置模板、发布脚本、设计文档和 CI 配置由 Git 历史保存，GitHub 是首个远端副本。至少保留一份定期更新的本地 clone；重要生产版本使用 Git tag 或 GitHub deployment 标记。

### 轻量服务器

- 主站 release 优先从对应成功 workflow 的已验证 artifact 恢复，payload、运行清单和 Nginx 配置必须来自同一 SHA。artifact 已过期且该 SHA 仍是 canonical `main` HEAD 时，可以由常规 workflow 重新运行全部 prerequisite，并在新的 `production-artifact` fresh runner 自包含重建和验证。历史 SHA 会被 E-015 新鲜度门禁拒绝；只能经另行授权且尚未设计/实施的历史恢复流程重建，当前手册不承诺普通 rerun 可以恢复。两类路径都不得复用旧 job build、把服务器文件作为内容真相源或在生产服务器重建。
- `/var/lib/axialmuse/url-exposure-ledger.json` 是不能从单个 release 重建的只追加生产证据，由 root-owned 本地备份与系统盘快照双重保护。每次发布记录账本更新前后摘要；恢复必须使用可校验备份并人工核对 deployment 记录，丢失、损坏或摘要断链时禁止发布、回滚和静默重建。
- 每个项目 release 可从各自 Git 精确 SHA 重建，并与主站及其他项目目录隔离。
- Nginx、ACME、systemd、logrotate 和发布脚本配置后续全部在仓库保留无 secret 模板。
- 重大系统更新、Web 服务变更和首次上线前创建系统盘快照。
- 快照随实例销毁，不作为唯一备份；证书私钥可重新签发，不导出到仓库。
- 每季度从干净环境演练“配置服务器 -> 发布 SHA -> 签发证书 -> 冒烟检查”。

### 生产清单

[生产环境清单](production-inventory.md) 记录域名、注册商、DNS、服务器类型、系统版本、canonical、发布方式、备案状态和最近验证日期。公网 IP、实例 ID、账号、SecretKey、SSH 私钥、证书私钥、支付资料和身份材料不写入仓库。

## 变更管理

| 变更 | 前置要求 | 最低验证 |
|---|---|---|
| 内容更新 | 内容发布流程 | 本地预览、链接、事实与隐私审核 |
| UI 更新 | 体验设计更新或一致性确认 | 桌面/移动截图、键盘访问 |
| DNS 修改 | 旧值、目的、TTL 和回滚值 | 修改前后公共解析检查 |
| Nginx 基础模板修改 | 快照或配置备份 | `nginx -t`、四类已知主机、ACME、未知 Host、本机与公网检查 |
| 旧 URL 或 slug 修改 | 同一变更登记重定向与兼容恢复边界 | 单跳 301、查询保留、目标 200、无 source HTML、回滚目标兼容性 |
| 证书修改 | 旧证书仍有效 | 双域名、续期和 reload 测试 |
| 系统更新 | 维护窗口和快照 | 服务、端口、TAT 与站点检查 |
| 新增项目体验 | 注册表、数据边界和项目质量门禁 | DNS、精确 Host、证书、两次发布、一次回滚和主站入口 |
| 暂停/下线体验 | 状态、替代入口和凭证撤销计划 | 主站移除入口、HTTP 状态、DNS 与悬空记录检查 |
| 框架/CMS | 更新架构决策 | 构建、迁移、URL、SEO、回滚测试 |
| 用户交互 | 数据与隐私设计 | 安全、滥用、删除和导出测试 |

生产 DNS、Nginx 和证书一次只改一个逻辑目标。故障中不同时更换 nameserver、Web 服务和发布方式。

## 故障分级

| 级别 | 示例 | 处置目标 |
|---|---|---|
| P0 | 腾讯云/GitHub 账户失控、SecretKey 或私钥公开 | 立即止损、撤销凭证并恢复控制 |
| P1 | 全站不可访问、DNS/TLS/服务器故障 | 4 小时内恢复上一个可用状态 |
| P2 | 页面主要功能损坏、错误内容或备案号缺失 | 当日修复或回滚 |
| P2 | 单个项目体验损坏但主站正常 | 移除主站入口并在 8 小时内恢复或显示维护页 |
| P3 | 单个外链、轻微排版或元数据问题 | 纳入下一次维护 |

## 故障手册

### 构建锁残留（BUILD_LOCKED / CONTENT_SESSION_LOCK）

`scripts/build/build-site.mjs` 以仓库根 `.axial-muse-build.lock`（权限 `0600`，内容为单行 owner 标识、**不含 PID**）作为 owner 绑定的排他构建锁，失败关闭且不自动抢占。构建进程被 `SIGKILL`、断电或异常路径未走到 `releaseBuildLock` 时锁文件会残留，之后每次通过隔离入口运行 `node scripts/quality/run-isolated-npm.mjs run-script build`（及依赖锁身份的内容构建 session）都以 `BUILD_LOCKED` 或 `CONTENT_SESSION_LOCK` 失败。锁文件不记录 PID，因此**只能靠进程检查判断是否为陈旧锁**，不能凭锁文件本身判断。

1. 确认当前确实没有构建在运行：`pgrep -af build-site.mjs`，并核对触发构建的 CI job 或终端。存在活动构建时**不要删锁**，等其结束或正常中止。
2. 确认无活动构建后，删除仓库根的陈旧锁文件：`rm -f .axial-muse-build.lock`。该文件已被 `.gitignore` 忽略，属本地未跟踪临时物，删除不影响任何受版本控制内容。
3. 若同时残留 `.axial-muse-build-retired/`、`.axial-muse-build-candidate-*/`、`.axial-muse-build-backup-*/`，它们会在下一次取得锁后、任何新改动前由构建自身回收，通常无需手动清理；仅在明确不再需要时手动删除。
4. 重跑 `node scripts/quality/run-isolated-npm.mjs run-script build` 确认恢复。
5. 在项目进度记录被中断的原因、影响与预防措施。

### 新部署导致页面损坏

1. 确认 GitHub deployment、TAT invocation、服务器 `current`、活动 Nginx 精确 SHA、payload/规则摘要和 URL 暴露账本摘要。
2. 先用完整账本检查上一成功 release：每个历史 published route 必须可解析，每条历史边的 source/target 必须收敛到同一 200；只有目标文件而缺少 source 规则仍不兼容。兼容时通过固定 rollback command 整版切回并 reload；无兼容 fallback 或已选择 forward-only 时保持账本闭包并制作向前恢复 release。
3. 在 Git revert 问题提交并走正常 PR。
4. 重新部署后完成本机与公网冒烟。
5. 在项目进度记录原因、影响、修复和预防措施。

### 域名无法解析

1. 检查注册状态、实名状态、ICP/接入状态和 nameserver。
2. 从多个公共解析器检查 `A`、`NS`、`DS` 和 `DNSKEY`。
3. 对照 DNS 变更记录回滚本次记录，不重建整个 zone。
4. DNS 正常后再检查轻量防火墙和 Nginx。

### HTTPS 失败

1. 确认证书主机名、有效期、文件权限和系统时间。
2. 检查 80/443、防火墙、ACME timer 与最近续期输出。
3. 运行 `nginx -t`；保留仍有效旧证书，不用 HTTP 暂时绕过。
4. 修复续期后验证双域名和自动 reload。

### 服务器不可用

1. 查看腾讯云实例、电源、套餐、流量、磁盘和 TAT 状态。
2. 文件级故障优先恢复配置或 release；系统级故障再评估快照回滚。
3. 无法恢复时创建新实例，按仓库配置重建并从成功 SHA 发布。
4. 新实例验证通过后才修改 DNS。

### 凭证或账户风险

1. 撤销暴露的 CAM key、GitHub secret、私有仓库 artifact 读取凭证、项目 deploy key、SSH key 和会话。
2. 更换账户密码与双因素恢复材料。
3. 检查 GitHub、腾讯云、TAT、DNS 和系统认证日志。
4. 回滚未授权代码、DNS、TAT command 或服务器配置。
5. 凭证进入 Git 历史时按已泄露处理，不以删除当前文件代替轮换。

## 例行维护日历

### 每次发布

- 观察 GitHub Actions、TAT 和公网冒烟结果。
- 确认生产 SHA、canonical、备案页脚和移动端表现。
- 记录公开内容变化和回滚点。

### 每月

- 复核内容、外链、搜索异常、服务器更新和错误日志。
- 确认域名与轻量实例续费、套餐流量、磁盘和证书状态。
- 检查 GitHub/Tencent Cloud 安全告警和失败任务。
- 检查 Node 24 是否发布新的非安全 patch；需要升级时创建独立 PR，不直接修改主分支或自动合并。

### 每季度

- 审核 GitHub、腾讯云、CAM、TAT command、私有仓库 artifact 读取凭证、项目 deploy key、SSH key 和双因素配置。
- 核对 DNS、服务器配置、备案信息和生产清单。
- 执行一次回滚或重建演练，并记录实际 RTO。

### 每半年

- 复核轻量服务器套餐与内容规模是否匹配。
- 检查供应商价格、限制和产品变更。
- 复核 Docusaurus 迁移、版本升级和内容规模；只有 Git 内容流程被事实证明不适用并经用户确认后才评估 CMS。

## 验收标准

- 所有主站生产版本可追溯到 `main` SHA、workflow run、不可变 artifact、SHA-256 摘要、GitHub deployment 和 TAT invocation。
- 最终 artifact 的 source build 可追溯到同一 `production-artifact` job 的完整主端点质量、build tree 摘要和封装校验；`website-quality` 的 job-local build 不具有部署身份。
- 每个生产版本的 payload、运行重定向清单、Nginx exact-location 配置和活动绝对 root/include 绑定同一 SHA；不存在只切页面或只切规则的成功状态。
- 任何发布必需的质量、供应链、图表或发布后冒烟门禁失败时，release 不得标记成功，上一已验证版本保持可用。
- 已确认的是门禁能力类别、D-074 明确指定的独立 `tsc --noEmit` 与 Docusaurus build、D-075 的模块边界检查目标、D-076/D-079/E-013 的直接依赖、生产/测试 `tsconfig` 基线、E-012 的临时编译 Node ESM 测试、E-013 的统一结构化解码、完整 Git 历史与稳定 ID lineage 状态机、E-014 的同版本服务端 301、E-015 的 production job 字节所有权，以及 D-077 的首次供应链准入工具组合、格式、阈值、外发边界与失败关闭协议。E-010/E-011 与 #21 的真实图准入、正式三制品、当时的 audit 全零和双端点 composite receipt 已完成本地验收；#22/#11 已完成本地站点基线与 E-012 runner 并远端闭环，#23 已完成 E-013 共用解码适配和内容领域核心的本地验收。D-097 的 Node 24 双端点、完整历史检查器与 DAG fixture、完整 checkout、D-098 路径泄漏修复和完整代码/构建本地负载已经验收；D-099 从普通 CI 移除 live audit 后，18 个 high 依赖节点仍是未修复风险但不再阻断本地第一阶段。尚无远端 CI 成功证据，E-014 的生成器/派生配置/Nginx 冒烟/回滚兼容检查、E-015 的封装/upload/deploy、required checks 和 production environment 仍未完成。不能把局部闭环误报为完整远端 CI、发布或生产链路已经完成。
- 自动部署不需要公网部署 SSH；生产服务器不保存主站源码、不安装 Node/npm，也不能执行任意仓库脚本或构建。
- DNS、备案、TLS、服务器和内容都有检查、告警与回滚路径。
- 访问日志默认关闭，保留的技术日志有用途、权限和删除周期。
- 仓库、快照、平台配置与账户恢复材料按不同敏感级别存放。
- 恢复演练能在 RTO/RPO 目标内还原 `https://www.axialmuse.com/`。

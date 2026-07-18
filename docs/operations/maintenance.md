# 自动化维护与运行手册

状态：draft
最近更新：2026-07-18
适用范围：M0 腾讯云主站与项目体验子域名的自动发布、监测、备份、安全维护与故障处理

## 目的

本文定义 `axialmuse.com` 主站及已登记项目体验上线后的最低运行标准，让日常维护依赖可重复检查和明确告警。首版由 Nginx 承载静态站点与静态项目体验，优先自动化发布、证书、健康检查和备份，不引入应用后端、数据库或第三方页面监测脚本。

D-053 已固定 Docusaurus 官方静态能力、现有 PlantUML、Nginx/Certbot、GitHub Actions/TAT、Ubuntu/systemd 原生运维和 CI 门禁能力类别；D-073 至 D-077 固定框架、工具链、TypeScript、依赖与首次供应链准入边界，D-078 授权内部工程收敛，E-005 进一步固定“GitHub Actions 构建默认 `build/` artifact，TAT 受限交付，服务器只校验、解包与切换”的目标链路。这里记录目标运行标准；仓库当前仍是迁移前静态骨架，相关依赖、生产 workflow、artifact、服务器配置和定时任务均不得表述为已经部署。

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
- Markdown 索引和内部链接检查。
- 契约词表与禁用表达检查。
- 常见密钥形态扫描。
- 静态站点入口、资源和关键锚点检查。
- PlantUML 图表编译检查。

#### Docusaurus 目标门禁

上述列表描述迁移前骨架已经存在的检查。接入 Docusaurus 后，PR 与生产发布还必须实现并通过 D-053 已确认的全部能力类别：

- D-073 的三个 Docusaurus 包保持同一精确版本，仓库只存在一个 `package-lock.json`；正常验证、CI 与构建通过 `npm ci --ignore-scripts --audit=false` 冻结安装并完成可重复 Docusaurus 构建。
- D-076 的首轮候选直接依赖名称和 manifest 版本表达必须精确匹配获批清单，范围的实际解析结果由唯一 lockfile 冻结；未列直接依赖、候选传递依赖或 lockfile 漂移必须进入 D-052 准入流程，不能因模板存在而放行。
- 只有主端点可在隔离目录以 `npm install --package-lock-only --ignore-scripts --audit=false` 解析已批准 manifest；候选 lockfile 必须是版本 3，只能引用官方 npm registry，并由零第三方依赖策略脚本失败关闭检查直接清单、来源、适用节点的 `resolved`/`integrity`、声明许可证与安装脚本标记。
- 正常安装前按 lockfile 获取精确 tarball，但不得执行包代码或脚本；复核 integrity，并检查实际 `package.json`、许可证文件、NOTICE 和生命周期脚本。许可证证据缺失、未知、推测性、复杂或未批准时暂停，生命周期脚本默认拒绝，任何例外必须按精确 `name@version` 重新取得用户确认。
- 从 lockfile 与 tarball 证据生成 npm 原生 SPDX JSON SBOM 和 `THIRD_PARTY_NOTICES`，并做漂移检查。`package.json`、lockfile、人工准入记录与两个派生制品分别只拥有直接意图、完整图、不可派生结论和生成结果，不得相互复制成人工维护的依赖清单。
- 显式全图 `npm audit` 必须包含开发依赖；`moderate`、`high`、`critical` 阻断，`low` 报告，禁止 `npm audit fix`，registry/audit 不可用时失败关闭，最终人工准入结论只能在漏洞门禁通过后形成。该构建期请求会向官方 npm registry 发送包名和版本，回退协议可能发送完整 lockfile 树及 npm/Node/平台/架构/环境元数据；不包含站点内容或访问者、账户、评论数据，也不产生浏览器请求。
- 构建配置保持 `future.v4: true` 与 `blog: false`，且不启用搜索、统计或其他未批准的浏览器外部请求。
- Docusaurus 管理的目标源码按 D-076 的官方 `tsconfig` 继承、显式收紧、首轮 `include` 和无自定义 `paths` 规则独立运行 `tsc --noEmit`，Docusaurus build 独立验证框架加载和静态制品；两项都必须通过，不能互相替代。
- 失败关闭检查 D-075 的物理层边界、跨层深层导入、宽泛 `export *` 与未批准自定义路径别名；具体工具和接线按 D-078 在实现前落盘并验证。
- lint、测试、Markdown/MDX frontmatter 和内容模型校验。
- 内部链接、资源、路由、canonical、sitemap、草稿泄漏和关键公开事实检查。
- PlantUML 编译与静态 SVG 制品检查。
- 许可证准入（未知或未获批即失败）、传递依赖、第三方声明或 SBOM、漏洞和 Secret 检查。
- 构建制品外部请求 allowlist，以及依据真实制品验证的 CSP。
- 桌面端和移动端真实浏览器、关键链接和可访问性检查。
- 发布后 HTTPS、重定向、关键页面和资源冒烟。

D-077 已固定 npm 原生能力加零第三方依赖策略脚本、SPDX JSON、NOTICE 生成、漏洞阈值、脚本默认拒绝和审计失败关闭边界；首版不把第三方许可证扫描器、SBOM 生成器或 GitHub Dependency Review Action 作为必需工具，本决定也不授权将它们作为可选补充引入。策略脚本接口、准入记录 schema、派生制品布局、报告保留、CI 接线，以及其他质量扫描器、Action、浏览器工具、例外流程和报告契约，均按 D-078 在依赖实现前落盘；这不免除新增依赖、Action 和外部操作原有准入门禁。当前依赖准入、配置创建、双门禁和模块边界检查均尚未实现。实现时必须把缺失输入或构建制品视为失败，不能沿用迁移前检查中对不存在入口的跳过行为；所有发布必需 job（包括独立类型检查、静态构建和 PlantUML）必须通过后才能触发 production。D-065 的文章创建命令只允许作者在获准的 Linux 作者环境显式运行；Git hook、CI、预览、发布和生产内容门禁发现缺失、非法、重复或被改写的 articleId 时只能失败并定位源文件，不得生成、修复、暂存或提交内容。D-066 的目标迁移必须让获准的作者工具、质量 job、PlantUML job 与 Docusaurus 构建执行器统一使用 Node 24.x 且不低于 24.16.0，并由文章创建命令调用原生 `randomUUIDv7()`。D-067 进一步确认 `.nvmrc` 是正常执行的唯一精确版本源，`engines.node` 表达兼容范围。D-072 已把作者 Node.js、质量和构建负载收敛到 Linux 执行环境与 Ubuntu-only CI。D-073 要求主基线和最低端点使用各自 Node 发行版随附的获批 npm 读取同一 lockfile；任何版本、配置、lockfile、外部请求或冻结安装偏离都必须失败，不能切换包管理器、生成第二种 lockfile 或回退到浮动安装。D-074 进一步要求目标源码显式严格，D-076 又固定其编译配置所有权和 TypeScript 6 过渡边界，不能用 build 成功替代类型检查，也不能静默改变官方继承基线。当前 workflow 已只使用 Ubuntu，但仍是 Node 22 的迁移前实现；版本文件、依赖、lockfile、D-077 策略与证据、TypeScript 配置、双门禁接线、模块边界检查、兼容任务和作者工具迁移均尚未实施。真实内容树始终只读；创建命令的测试入口、隔离方式与契约实现仍由 D-078 收敛，尚未实现。

D-067 的目标 Ubuntu CI 版本入口按以下边界实现：

- 主质量 job、Ubuntu PlantUML job 和未来正式 Docusaurus 构建先断言实际 Node 等于 `.nvmrc`、随附 npm 等于 D-073 主基线，并且 `actions/setup-node` 通过 `node-version-file` 消费该文件；除受审依赖变更外只运行 `npm ci --ignore-scripts --audit=false`，并证明 `package.json` 与 `package-lock.json` 前后哈希不变。主基线的发布必需检查整体必须分别包含 D-074 的 `tsc --noEmit` 与 Docusaurus build；两项具体位于同一还是不同 job 仍待编排，只有该精确基线产生的制品可以发布。
- Ubuntu CI 的最低版本任务先断言实际 Node 等于 `engines.node` 下界、随附 npm 等于 D-073 最低端点，再对同一 manifest、项目 npm 配置与 `package-lock.json` 运行 `npm ci --ignore-scripts --audit=false`，证明 manifest/lock 前后哈希不变，并与主入口调用同一共享质量、独立类型检查、静态构建和行为测试负载；它只替换版本断言，不写 lockfile、不跳过其他检查、不产出发布制品，也不触发文章创建或发布。
- 两个入口必须封闭，不得使用通用跳过版本检查的环境变量或参数；版本契约还要验证 `.nvmrc` 是兼容范围内的单个非浮动精确版本，最低版本任务值与 `engines` 下界一致。
- 只有明确的受审依赖变更可以在主基线按 D-077 生成候选 `package-lock.json`；候选经过证据审查和人工准入后，才可与对应 `package.json` 一并进入正常冻结安装。普通作者验证、非依赖 PR、最低端点和发布流程不得改写依赖图。首次迁移必须证明两个 npm 端点能读取同一 lockfile；任一端点失败时阻止迁移并回到依赖决策，不得重写锁文件掩盖不兼容。
- Node 24 安全 patch 被发现后及时发起独立升级 PR；其他 patch 至少每月检查。升级 PR 先修改 `.nvmrc` 候选值，Ubuntu CI 的主任务和最低版本任务、PlantUML 及届时发布必需门禁通过后才允许合并，不得自动合并，也不得在普通 patch PR 中修改 `engines` 边界。

Ubuntu 所用 nvm 的精确版本与安装校验、Action 的版本与 commit SHA、两个入口和共享负载的具体编排、`tsc --noEmit` 与 Docusaurus build 的 npm script 名称及 job 拆分、D-075 模块边界检查工具与接线、D-077 策略接口/记录 schema/派生制品布局/报告保留/CI 接线、缓存、required check 名称、错误格式及迁移顺序仍待实施。E-005 已确定 Docusaurus 只在 GitHub Actions 的主端点构建默认 `build/`，生产服务器不安装 Node/npm、不拉源码、不执行构建；具体 Action 与 commit SHA、公开或私有 artifact 读取分支、凭证创建、TAT 和服务器配置仍须完成准入、现场核验和操作授权。

影响 UI 的 PR 还必须在现有局域网预览环境完成桌面端和移动端截图。M0 没有公网 PR 预览，截图和质量结果共同作为合并证据。

### 生产发布

1. PR required checks 与本地预览验收均通过。
2. PR 合入 `main`。
3. GitHub Actions 对精确 `GITHUB_SHA` 运行全部发布必需的质量与供应链 job；Docusaurus 迁移后在主端点完成冻结安装、`tsc --noEmit`、Docusaurus build 和制品检查，并只把默认 `build/` 作为 CODE-015 封装器的输入。当前迁移前 workflow 尚未实现这条目标链路。
4. workflow 在 `dist/release/` 生成 `payload/` 与 `metadata/`，将其封装为不可变 artifact，并核对 workflow run、artifact、`head_sha` 和上传摘要。
5. `production` job 通过最小权限 CAM 凭证调用指定 TAT command，只传递 workflow run/artifact 标识、提交 SHA 与预期摘要。
6. 服务器从固定仓库读取 artifact 元数据，完成身份、摘要、归档路径安全和内部文件清单校验后，只把已验证 `payload/` 安装到 `releases/<sha>`；`metadata/` 不进入 Web Root，服务器不拉取源码、不运行 Node/npm，也不从源码 checkout 执行脚本。
7. 本机静态与 Nginx 冒烟通过后原子切换 `current`，失败则自动恢复原 symlink。
8. GitHub runner 从公网检查 HTTPS、canonical、关键锚点和资源；发布者记录 run、artifact、摘要、TAT invocation、部署 SHA、时间和验证结论。

production environment 限制为 `main`，deployment concurrency 同时只允许一个发布。CAM 凭证只允许调用和查询指定 command/instance，不允许执行任意命令或管理其他云资源。

项目体验由各自仓库的 production workflow 发布，使用独立 environment、CAM 凭证、TAT command、deploy key、release 目录和 concurrency group。一个项目的发布失败不得占用或回滚主站及其他项目的版本。

### 定时检查

M0 在 GitHub Actions 增加以下计划任务：

| 频率 | 检查 | 失败表现 |
|---|---|---|
| 每日 | 生产首页 HTTPS 状态、重定向、标题、canonical、关键锚点和资源 | Workflow 失败并由 GitHub 通知 |
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
- 验证当前 symlink、生产 SHA 与 GitHub deployment 一致。
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

- 主站 release 优先从对应成功 workflow 的已验证 artifact 恢复；artifact 已过期时由 GitHub Actions 对同一精确 Git SHA 重新构建和验证，不把服务器文件作为内容真相源，也不在生产服务器重建。
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
| Nginx 修改 | 快照或配置备份 | `nginx -t`、本机与公网检查 |
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

### 新部署导致页面损坏

1. 确认 GitHub deployment、TAT invocation 和服务器当前 SHA。
2. 通过固定 rollback command 切回上一个成功 release。
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
- 任何发布必需的质量、供应链、图表或发布后冒烟门禁失败时，release 不得标记成功，上一已验证版本保持可用。
- 已确认的是门禁能力类别、D-074 明确指定的独立 `tsc --noEmit` 与 Docusaurus build、D-075 的模块边界检查目标、D-076 的候选直接依赖和 `tsconfig` 基线，以及 D-077 的首次供应链准入工具组合、格式、阈值、外发边界与失败关闭协议。D-077 策略、记录、真实候选图、正式 SBOM/NOTICE、审计结果和 CI 覆盖均未实现；其他质量工具与 workflow 编排按 D-078 继续落盘和实施，不能把目标契约误报为已有扫描或当前覆盖。
- 自动部署不需要公网部署 SSH；生产服务器不保存主站源码、不安装 Node/npm，也不能执行任意仓库脚本或构建。
- DNS、备案、TLS、服务器和内容都有检查、告警与回滚路径。
- 访问日志默认关闭，保留的技术日志有用途、权限和删除周期。
- 仓库、快照、平台配置与账户恢复材料按不同敏感级别存放。
- 恢复演练能在 RTO/RPO 目标内还原 `https://www.axialmuse.com/`。

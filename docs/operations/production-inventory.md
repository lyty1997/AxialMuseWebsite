# 生产环境清单

状态：inactive
最近更新：2026-07-29
适用范围：M0 生产环境非敏感事实与验证记录

## 使用规则

本文只记录恢复站点所需的非敏感事实。密码、恢复代码、API token、支付资料、注册人身份信息和个人联系方式不得写入本文或仓库；它们由站点所有者在密码管理器和供应商后台维护。

生产服务器已购买但生产站点尚未启用，未核验字段保持“未设置”或“未核验”。每次域名、DNS、托管或发布分支变化后同步更新，并在变更记录中留下日期与原因。

## 所有权

| 项目 | 当前值 |
|---|---|
| 站点所有者 | 项目所有者 |
| GitHub 仓库 | `https://github.com/lyty1997/AxialMuseWebsite` |
| 生产分支 | `main` |
| 开发主干 | `dev` |
| 域名注册商 | 腾讯云 |
| 权威 DNS | 腾讯云 DNSPod，已通过公共 DNS 核验 |
| 托管平台 | 腾讯云轻量应用服务器 |

## 域名与 DNS

| 项目 | 当前值 | 最近验证 |
|---|---|---|
| 注册域名 | `axialmuse.com` | 用户于 2026-07-12 确认 |
| canonical URL | `https://www.axialmuse.com/` | 设计值，尚未上线验证 |
| nameserver | `broderick.dnspod.net`、`sandpaper.dnspod.net` | 2026-07-12 公共 DNS 查询 |
| DNSSEC | 未启用，父区无 DS | 2026-07-12 公共 DNS 查询 |
| 根域重定向 | 未配置 | - |
| 域名到期日 | 未设置 | - |
| 自动续费 | 未设置 | - |

DNS 记录上线后按以下格式记录用途，不记录仅存在于供应商后台的验证 secret：

| 类型 | 名称 | 目标或用途 | 代理状态 | TTL |
|---|---|---|---|---|
| A | `@` | 当前无记录；上线时指向轻量服务器公网 IPv4 | DNSPod | 计划 600 秒 |
| A | `www` | 当前无记录；上线时指向轻量服务器公网 IPv4 | DNSPod | 计划 600 秒 |
| A | `<project-slug>` | 仅为已批准项目显式创建；当前无记录 | DNSPod | 计划 600 秒 |
| AAAA | `@` / `www` | 当前无记录；M0 不计划启用 | DNSPod | - |

## 腾讯云轻量应用服务器

| 项目 | 当前值 |
|---|---|
| 实例地域 | 中国上海；用户于 2026-07-13 确认，待控制台核验 |
| 操作系统与版本 | Ubuntu Server 24.04 LTS 64bit；待服务器核验 |
| 镜像类型 | Ubuntu Server 系统镜像；具体镜像标识待控制台核验 |
| 当前用途 | 空机，专用于本网站；待服务器只读盘点确认 |
| 公网 IP | 不写入仓库，从腾讯云控制台与 DNS 查询 |
| 实例到期与自动续费 | 未核验 |
| 快照能力 | 未核验 |
| TAT agent | 未核验 |
| Web 服务 | 计划使用 Nginx |
| Web Root | 目标：活动 `site-release.conf` 中 `/srv/axialmuse/releases/<sha>/payload` 的精确绝对路径；`current` 只在配置解析时选代 |
| 生产分支 | `main` |
| 发布方式 | 目标：GitHub Actions 构建不可变 artifact -> 腾讯云 TAT 受限交付 -> 校验后原子 release；尚未实施 |
| 构建位置 | 目标：仅 GitHub Actions 构建；PR/`main` 的 `website-quality` 与 release-eligible `production-artifact` 各自在独立 runner 构建，只有后者对 `main` 精确 SHA fresh rebuild + full quality 的 build 可部署；生产服务器不构建 |
| Build command | 仓库已实现 `build`、`package:artifact` 与 `check:artifact`；后两者复用冻结依赖中的 production checker，并完成确定性封装及外部 `releaseContentSha256` 复验。#14 已在当前工作区把完整顺序接入四个 prerequisite 之后的 `production-artifact` job，但尚无 canonical `main` 真实运行 |
| Output directory | Docusaurus production 输出为默认 `build/`，#33 的临时交付根为 `dist/release/`；`dist/` 不提交。当前公网仍提供迁移前 `public/`，尚未部署 Docusaurus release |
| Artifact 身份 | 仓库侧已实现 40 位提交 SHA、source build tree、内部清单与 artifact 外 `releaseContentSha256`；#14 工作区接线在 upload 前形成 build/release 操作 seal，upload 后复核同一 seal、HEAD blob 与默认 index 状态后，才映射 canonical repository、workflow run ID/attempt、artifact ID 和 GitHub 外层 `artifactDigest` 七项 outputs，展示名不用于选择。由于尚未发生真实 upload，这些 GitHub 服务端身份没有实际值 |
| Artifact 内容 | #33 已实现 `payload/`（已重验 `build/` 的逐文件复制）与 `metadata/`（source build tree、提交标识、release manifest、逐文件 SHA-256、运行重定向清单和 Nginx exact-location 配置）的本地确定性生成与复验；尚无已上传 production artifact |
| 服务器 artifact 校验器 | #35 已由本地提交 `f7fdc43` 实现只使用 Python 3.12 标准库的 `ops/deploy/verify_artifact.py` 与 Node/Python 共享 golden，但尚未推送；本地负向验收不等于服务器安装。#14 真实 ZIP shape 与 #36 `/usr/bin/python3`、root-owned 安装副本、owner/mode 仍待现场复验 |
| 跨 job build 边界 | E-015 固定不上传或下载中间 build artifact；`production-artifact` 在 fresh runner 自包含重建、重验和封装，避免消费其他 job 文件系统 |
| 发布新鲜度 | #34 已在活动 workflow 外实现七项 producer outputs、当前 GitHub context、canonical main/run/artifact/head/digest 的两次 main 交叉核验，以及 main 不取消/生产串行的静态 concurrency 候选；尚未接入真实 workflow/API，concurrency 仍不替代新鲜度 |
| Workflow token | prerequisite 与 #14 producer 的 `contents: read` 已在当前工作区配置，其他 producer scope 为 `none`；#34 静态 deploy fixture 只允许 `contents: read`、`actions: read`，但尚未写入活动 workflow 或真实 environment |
| TAT 调度 | #34 已实现固定 `ap-shanghai`、单 command/instance、五参数 `InvokeCommand` 的 TC3 签名与 dry-run；成功 `status: dispatched` 只记录 invocation ID，不表示 task/部署成功。实际 command/instance、CAM、environment 与 #37 终态查询均未接线 |
| Artifact 读取 | OD-009 待核验；公开仓库无需凭证，私有仓库仅用单仓库 `Actions: read` 细粒度凭证 |
| 服务器发布职责 | #35 只负责从私有 staging 校验外层 `artifactDigest`、安全解包、从 exact release 独立重算 `releaseContentSha256`，并交叉校验元数据、清单、运行规则与提交身份，成功形成 `verified-release`。#37 才在部署锁内复核后安装同 SHA payload/运行清单/Nginx 配置至不可变 release，用 URL 暴露账本验证历史闭包，生成精确 SHA root/include，执行隔离候选测试、`nginx -t`、reload、逐规则冒烟和受控恢复；两者均尚未部署 |
| 活动重定向身份 | #33 的 release metadata 已实现源注册表摘要、公开路由摘要、运行清单摘要、Nginx 配置摘要和规则数；当前尚无已部署活动 release |
| URL 暴露账本 | 目标：`/var/lib/axialmuse/url-exposure-ledger.json`；每次 reload 前只追加候选的全部规范 200 路径和新增或改指的 registered 301 边，`canonical-slash` 不入边账本但 target 由路由预写保护；记录每次 deployment 前后摘要并由 root-owned 备份保护，当前未创建 |
| 回滚兼容谓词 | 目标：每个历史 published route 仍可解析，每条历史 301 边的 source/target 收敛到同一当前 200；只有目标文件但缺少 source 规则不算兼容 |
| 服务器主站工具边界 | 不安装 Node/npm，不拉取主站源码，不从源码 checkout 执行脚本或构建；尚待现场核验与配置 |

## 项目体验子域名

| 项目 | 当前值 |
|---|---|
| 注册表 | `docs/contracts/project-experiences.json` |
| 命名模式 | `https://<project-slug>.axialmuse.com/` |
| 默认发布模式 | `static` |
| 默认索引策略 | `noindex` |
| DNS 策略 | 显式 A 记录，不使用泛解析 |
| Nginx 策略 | 精确 `server_name`，独立 Web Root |
| 证书策略 | 每个项目单独签发单主机证书 |
| 已登记项目数 | 1 |
| 已批准在线体验数 | 0 |
| `live` 项目数 | 0 |

| 项目 | 保留主机名 | 状态 | 当前公开方式 | DNS |
|---|---|---|---|---|
| DocRestore | `docrestore.axialmuse.com` | `planned` / `dnsProvisioning: disabled` | 主站项目说明和 GitHub 仓库；演示视频后续追加 | 禁止创建 |

## 备案与合规

| 项目 | 当前值 |
|---|---|
| ICP 备案 | `沪ICP备2026029086号`；用户于 2026-07-13 确认，待官方查询复核 |
| 腾讯云接入备案 | 用户于 2026-07-13 确认接入成功，待控制台复核 |
| 页脚 ICP 备案号 | 计划展示 `沪ICP备2026029086号` 并链接 `https://beian.miit.gov.cn/` |
| 公安联网备案 | 未核验 |

## 搜索与公开入口

| 项目 | 当前值 |
|---|---|
| 主站项目目录 | `docs/contracts/projects.json`；已登记 2 个项目，均待随主站发布 |
| `robots.txt` | 未发布 |
| `sitemap.xml` | 未发布 |
| Google Search Console | 未设置 |
| 公开身份入口 | GitHub 个人主页 `https://github.com/lyty1997` |
| 访问分析 | 不引入 |

## 日志边界

| 项目 | 当前值 |
|---|---|
| Nginx access log | 计划关闭 |
| Nginx error log | 计划本地保留 7 天 |
| SSH/system auth log | 计划按系统轮转，目标 30 天 |
| 外部日志服务 | 不引入 |

## 最近生产验证

| 检查 | 结果 | 时间 | 对应提交/部署 |
|---|---|---|---|
| DNS | DNSPod NS 有效；`@`/`www` 无 A/AAAA，符合切换前状态 | 2026-07-12 | 公共 DNS 查询 |
| DNSSEC | 父区无 DS，尚未启用 | 2026-07-12 | 公共 DNS 查询 |
| TLS/HTTPS | 无 A/AAAA，暂不具备验证条件 | 2026-07-12 | - |
| 生产冒烟 | 未执行 | - | - |
| 桌面端渲染 | 未执行 | - | - |
| 移动端渲染 | 未执行 | - | - |
| 恢复演练 | 未执行 | - | - |

## 变更记录

| 日期 | 变更 | 原因 | 验证 |
|---|---|---|---|
| 2026-07-29 | 在活动 workflow 外实现 #34 deploy 身份/main 新鲜度、无 Secret 预检、受限 TAT dispatch 与并发静态候选 | 让旧 run、main 漂移或 artifact 身份不匹配在 CAM Secret/Tencent API 前失败，并为 #37 提供 invocation 接口 | 28/28 定向合成 fixture、固定 Node 24.18.0 完整 quality、JavaScript 语法和差异检查通过；没有真实 GitHub API、Secret、TAT invocation、task 终态或生产部署证据 |
| 2026-07-29 | 按 D-110 在工作区接入 canonical `main` push 的 fresh `production-artifact`、固定完整 SHA 的官方 upload Action、单次精确上传和七项校验后 outputs | 闭合 E-015/CODE-020 的最终 build 字节所有权，并为 #34/#35 提供明确的 artifact 身份边界 | 本地静态与合成 fixture 契约已通过；改动尚未提交或推送，且没有 canonical `main` 真实 run、upload、artifact ID/digest、可下载 ZIP、required checks 或 Issue 关闭证据 |
| 2026-07-18 | 记录 E-014 的同版本服务端 301、精确 SHA Web Root/include、只追加 URL 暴露账本、历史 source/target 收敛谓词和 fallback/forward-only 恢复边界 | 静态跳转页无法返回真实 301，请求期 `current` Web Root 会在 graceful reload 中混用新旧代，且只检查目标文件会误放缺少历史 source 规则的回滚 | 设计已落盘；生成器、artifact、账本、Nginx、TAT 和服务器操作均未实施 |
| 2026-07-18 | 记录 E-015 的 production artifact 自包含重建、同 job build tree/封装闭包、唯一 ID/双摘要输出、main HEAD 新鲜度和最小 token 边界 | GitHub jobs 文件系统隔离；直接封装另一个 job 的 `build/` 没有输入，建立中间 handoff 又会增加 Action、归档、重跑和过期协议；concurrency 不保证旧 run 不会晚到 | 设计已落盘；选择在 `production-artifact` fresh runner 重新执行完整主端点质量，不实现中间 build artifact；workflow 与 Action 均未修改 |
| 2026-07-18 | 记录 E-005 的 GitHub Actions `build/` artifact、TAT 受限参数和服务器只校验/解包/切换目标 | D-078 委托内部工程细节后形成静态制品交付决定 | 设计已落盘；Action、凭证、workflow、TAT、服务器与 DNS 操作均未实施，仍需对应准入、核验和授权 |
| 2026-07-13 | DocRestore 改为公开仓库展示，演示视频作为后续增强，明确不提供在线体验 | 用户确认自有后端只用于私有运行和录制，首版不承担公网服务 | 注册表禁止 DNS provisioning；视频素材不阻塞首次上线 |
| 2026-07-13 | 登记 DocRestore 静态前端入口，保持 `planned` 与 `noindex` | 用户提供首个项目、子域名、仓库、分支和外部后端边界 | 已核对本地 README、前端构建配置和相对 API 实现；外部后端与公网认证待决策 |
| 2026-07-13 | 记录上海地域、Ubuntu Server 24.04 LTS 64bit、专用空机、完整 ICP 备案号和接入成功状态 | 用户补充生产事实 | 待腾讯云控制台、官方备案查询与服务器只读核验 |
| 2026-07-13 | 建立项目体验子域名注册、DNS、Nginx、证书与发布基线 | 用户要求为各项目提供体验入口 | 注册表当前为空，待提供首批项目清单 |
| 2026-07-12 | 核验 DNSPod nameserver，确认 A/AAAA/DS 均未配置 | 建立 DNS 切换前基线 | `dig` 公共查询 |
| 2026-07-12 | 记录 `axialmuse.com`、腾讯云注册、ICP 已备案声明和轻量服务器 | 用户提供既有生产资源事实 | 待控制台与服务器现场核验 |
| 2026-07-12 | 建立生产环境清单模板 | 为域名与上线阶段提供非敏感真相源 | 文档质量门禁 |

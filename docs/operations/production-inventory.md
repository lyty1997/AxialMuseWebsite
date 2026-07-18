# 生产环境清单

状态：inactive
最近更新：2026-07-18
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
| Web Root | `/srv/axialmuse/current` |
| 生产分支 | `main` |
| 发布方式 | 目标：GitHub Actions 构建不可变 artifact -> 腾讯云 TAT 受限交付 -> 校验后原子 release；尚未实施 |
| 构建位置 | 目标：仅 GitHub Actions 对 `main` 精确 `GITHUB_SHA` 构建；生产服务器不构建 |
| Build command | 目标：冻结安装、质量、类型检查、Docusaurus build 与制品检查；具体 npm script 尚未实现 |
| Output directory | 目标：Docusaurus 默认 `build/`；当前仓库仍是迁移前 `public/` 骨架 |
| Artifact 身份 | 目标：workflow run ID、artifact ID、40 位提交 SHA、预期 SHA-256 摘要；尚未生成 |
| Artifact 内容 | 目标：`payload/`（`build/` 的已验证复制）与 `metadata/`（提交标识、release manifest、逐文件 SHA-256 清单）；尚未生成 |
| Artifact 读取 | OD-009 待核验；公开仓库无需凭证，私有仓库仅用单仓库 `Actions: read` 细粒度凭证 |
| 服务器发布职责 | 目标：校验元数据、摘要、归档路径与文件清单，解包至 `releases/<sha>` 并切换 `current` |
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
| 2026-07-18 | 记录 E-005 的 GitHub Actions `build/` artifact、TAT 受限参数和服务器只校验/解包/切换目标 | D-078 委托内部工程细节后形成静态制品交付决定 | 设计已落盘；Action、凭证、workflow、TAT、服务器与 DNS 操作均未实施，仍需对应准入、核验和授权 |
| 2026-07-13 | DocRestore 改为公开仓库展示，演示视频作为后续增强，明确不提供在线体验 | 用户确认自有后端只用于私有运行和录制，首版不承担公网服务 | 注册表禁止 DNS provisioning；视频素材不阻塞首次上线 |
| 2026-07-13 | 登记 DocRestore 静态前端入口，保持 `planned` 与 `noindex` | 用户提供首个项目、子域名、仓库、分支和外部后端边界 | 已核对本地 README、前端构建配置和相对 API 实现；外部后端与公网认证待决策 |
| 2026-07-13 | 记录上海地域、Ubuntu Server 24.04 LTS 64bit、专用空机、完整 ICP 备案号和接入成功状态 | 用户补充生产事实 | 待腾讯云控制台、官方备案查询与服务器只读核验 |
| 2026-07-13 | 建立项目体验子域名注册、DNS、Nginx、证书与发布基线 | 用户要求为各项目提供体验入口 | 注册表当前为空，待提供首批项目清单 |
| 2026-07-12 | 核验 DNSPod nameserver，确认 A/AAAA/DS 均未配置 | 建立 DNS 切换前基线 | `dig` 公共查询 |
| 2026-07-12 | 记录 `axialmuse.com`、腾讯云注册、ICP 已备案声明和轻量服务器 | 用户提供既有生产资源事实 | 待控制台与服务器现场核验 |
| 2026-07-12 | 建立生产环境清单模板 | 为域名与上线阶段提供非敏感真相源 | 文档质量门禁 |

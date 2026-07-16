# 域名与生产发布设计

状态：draft
最近更新：2026-07-15
适用范围：M0 腾讯云域名、DNS、轻量应用服务器、HTTPS、自动发布与回滚

## 目的

本文把 `axialmuse.com` 从已注册、已备案状态发布到腾讯云上海轻量应用服务器的过程拆成可验证步骤。服务器基础事实和备案接入状态已经由用户提供；到期日、快照、TAT agent、防火墙和实际系统状态仍需在实施前只读核验。

## 已知事实

- 正式域名：`axialmuse.com`。
- 域名注册商：腾讯云。
- ICP 备案号：`沪ICP备2026029086号`。
- 腾讯云接入备案：用户于 2026-07-13 确认接入成功。
- 生产服务器：腾讯云轻量应用服务器，中国上海地域，Ubuntu Server 24.04 LTS 64bit。
- 服务器用途：当前为空机，专用于本网站生产部署。

以上事实来自用户确认，实施时仍需通过腾讯云控制台和服务器只读命令交叉核验。文档不记录腾讯云账号、实例 ID、公网 IP、密码或密钥；生产事实统一维护在 [生产环境清单](production-inventory.md)。

## 首版生产方案

首版采用以下架构：

- GitHub 仓库继续作为源码、内容和发布历史真相源。
- GitHub Actions 对 PR 和 `main` 运行质量门禁，并通过 GitHub `production` environment 触发生产发布。
- 腾讯云云解析 DNS（DNSPod）管理 `axialmuse.com` 权威解析。
- 腾讯云轻量应用服务器承载 Nginx 和静态文件，不运行应用后端或数据库。
- 已登记的静态项目体验使用 `<project-slug>.axialmuse.com`，共享服务器端口但隔离 Nginx 配置、证书、仓库与发布目录。
- 腾讯云自动化助手 TAT 调用服务器上预先安装的固定发布命令，不为自动部署开放公网 SSH。
- Nginx 提供 HTTPS、根域跳转、安全响应头和静态文件服务。
- Certbot（ACME 客户端）自动签发并续期覆盖 `axialmuse.com` 与 `www.axialmuse.com` 的证书。
- canonical URL 为 `https://www.axialmuse.com/`，根域永久重定向到 `www`。

腾讯云 TAT 是轻量应用服务器原生运维工具，可在不登录服务器、不开放额外入站端口的情况下执行命令，并支持 API 与 CAM 权限控制。参考：[轻量应用服务器使用 TAT](https://cloud.tencent.com/document/product/1207/52631/)、[TAT 访问管理](https://cloud.tencent.com/document/product/1340/56294)。

该方案不引入 CMS、运行时 Node.js 服务、容器、数据库、页面分析脚本、广告或站内 Cookie。

## 生产拓扑

```text
贡献者 -> dev（feature 先合入 dev）-> dev CI -> 本地/局域网预览
                                           |
                                    dev -> main PR
                                           |
                                      合并到 main
                              |
                    GitHub production job
                              |
                 腾讯云 API -> TAT 固定发布命令
                              |
DNSPod -> axialmuse.com -> Nginx -> /srv/axialmuse/current
                                      |
                                      +-> releases/<commit-sha>
DNSPod -> <project>.axialmuse.com -> Nginx -> /srv/axialmuse-experiences/<project>/current
```

## 环境与分支

| 环境 | 来源 | 地址 | 索引策略 | 用途 |
|---|---|---|---|---|
| 本地预览 | 当前工作区 | 现有局域网预览地址 | 不公开 | 开发与视觉验证 |
| PR 验收 | `dev -> main` | 本地预览 `dev` 精确提交 | 不公开 | 生产合并前集成验收 |
| 生产 | `main` 精确提交 | `https://www.axialmuse.com/` | 允许索引 | 对外发布 |

M0 不额外建设公网 staging 子域名，避免增加服务器配置、证书、索引和访问控制成本。需要多人异地审核时再单独设计 staging。

## 服务器基线

### 上线前盘点

已确认基线：

- 实例地域为中国上海。
- 操作系统为 Ubuntu Server 24.04 LTS 64bit，预期 CPU 架构为 `x86_64`。
- 服务器为空机，专用于本网站，不承载其他已知业务。

在安装或删除任何软件前仍需记录：

- `uname`、系统版本和 CPU 架构，确认与已知基线一致。
- 当前监听端口、已安装包、Web 服务和站点目录，确认确为空机状态。
- 系统盘容量、剩余空间、内存和套餐流量。
- 实例到期日、自动续费和快照能力。
- TAT agent 是否在线。

若现场核验发现未知业务、重要数据或系统版本不符，先停止改动并确认原因；不通过重装系统覆盖未知内容。

### 运行组件

| 组件 | 职责 | 约束 |
|---|---|---|
| Nginx | HTTPS、重定向、安全头、静态文件 | 使用系统包；不安装可视化服务器面板 |
| Git | 拉取精确生产提交 | 只读仓库凭证；不保存 GitHub 写权限 |
| Certbot | 签发与续期 TLS 证书 | 使用 webroot HTTP-01；续期后验证并 reload Nginx |
| TAT agent | 接收腾讯云固定运维命令 | 保持在线；命令和实例按 CAM 最小授权 |
| logrotate / systemd | 日志轮转、服务与续期定时器 | 不引入第三方常驻监控 agent |

现有 `public/` 骨架的发布设计不在服务器构建，只导出已经通过门禁的精确提交。Docusaurus 目标改为发布经过验证的静态构建制品；构建位置、制品封装和传输方式由发布契约另行确定。生产服务器在任何方案下都不承担写作或源码编辑，也不得执行未经固定和审核的仓库脚本。

### 目录契约

```text
/srv/axialmuse/
├── repo.git/                 # 只读 bare clone
├── releases/
│   └── <40-char-sha>/        # 不可变静态产物
└── current -> releases/<sha> # Nginx Web Root 指向的原子符号链接
```

- 发布先写入同文件系统的临时目录，校验成功后改名为 SHA 目录，再原子切换 `current`。
- 发布目录不得被 Nginx 或发布流程就地覆盖。
- 默认保留最近 5 个成功版本；当前版本和上一个版本不得被清理。
- 发布脚本与 Nginx 配置后续纳入仓库，安装到服务器的副本由 root 持有且不可被部署凭证修改。

### 配置即代码契约

M0-P 实施时按以下路径纳入仓库；表中路径是设计契约，文件在对应实施步骤完成前可以不存在：

| 计划路径 | 责任 |
|---|---|
| `ops/nginx/axialmuse.conf` | 精确 Host、跳转、Web Root、错误页和缓存规则 |
| `ops/nginx/snippets/security-headers.conf` | CSP、HSTS 以外的安全响应头；HSTS 由启用步骤单独控制 |
| `ops/deploy/deploy.sh` | 校验 SHA、创建 release、冒烟、原子切换和失败回滚 |
| `ops/deploy/rollback.sh` | 只切换到已存在且通过校验的上一 release |
| `ops/systemd/` | 证书检查、服务器健康与维护 timer/service 模板 |
| `ops/logrotate/` | Nginx error log 和认证日志保留策略模板 |
| `.github/workflows/deploy-production.yml` | `main` 精确 SHA 到 TAT 的受限生产发布 |
| `.github/workflows/maintenance.yml` | HTTPS、TLS、链接、DNS 和到期提醒的定时检查 |

- 仓库只保存无 secret 模板；实例 ID、SecretId、SecretKey、deploy key 和证书私钥不得写入这些文件。
- 安装到 `/etc`、`/usr/local/sbin` 和 root 配置目录的副本由 root 持有，发布身份没有修改权限。
- 模板变更先在测试路径执行语法与受控 hosts 验证，再由独立运维步骤安装；网页内容发布不能顺带覆盖系统配置。

## 服务器安全

### 腾讯云与系统防火墙

| 端口 | 来源 | 用途 |
|---|---|---|
| TCP 80 | `0.0.0.0/0` | ACME HTTP-01 与 HTTP 到 HTTPS 跳转 |
| TCP 443 | `0.0.0.0/0` | 正式 HTTPS 访问 |
| TCP 22 | 站点所有者当前公网 IP | 紧急管理；不供自动部署使用 |

未使用端口全部关闭；不公开数据库、服务器面板、开发服务器或预览端口。腾讯云轻量防火墙默认规则可能向所有 IPv4 开放 SSH，实施时必须按最小授权复核。参考：[管理实例防火墙](https://cloud.tencent.com/document/product/1207/44577)。操作系统防火墙使用同等边界，不能只配置其中一层。

### 登录与权限

- 腾讯云主账号开启双因素认证和操作保护，日常使用最小权限子账号。
- SSH 仅允许密钥认证，禁用 root 远程登录和密码认证。
- 管理员、Nginx 与发布脚本使用不同系统身份和文件权限。
- GitHub 只保存专用 CAM 子账号的 SecretId/SecretKey，不保存腾讯云主账号凭证。
- CAM 策略只允许对指定 TAT command 和指定轻量实例执行、查询；不授予任意命令、实例重装、删除或财务权限。
- 只读 GitHub deploy key 仅用于服务器拉取本仓库；不复用个人 SSH 密钥。

## 自动发布契约

### GitHub 侧

生产 workflow 仅由 `main` push 或人工 `workflow_dispatch` 触发，并满足：

- 先运行 `npm run quality`。
- 使用 `production` environment 保存腾讯云部署凭证。
- 使用 concurrency group，任一时刻只允许一个生产发布。
- 将当前 `GITHUB_SHA` 作为唯一发布版本，不发布浮动的“最新 main”。
- TAT 返回成功后，从公网验证 canonical 首页和关键资源。
- 部署失败时 workflow 失败，不把失败提交标记为已发布。

GitHub environment 可以限制部署分支、保护 secrets 并控制并发。参考：[GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)、[GitHub Actions 部署控制](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)。

### TAT 与服务器侧

1. GitHub Actions 使用 `InvokeCommand` 请求执行已开启自定义参数的 `axialmuse-deploy` TAT command，并传入 40 位提交 SHA。
以下第 4-5 步仍描述迁移前 `public/` 骨架。Docusaurus 的构建位置、制品交付和入口校验尚未确认，迁移实现前必须用新的发布契约替换这两步。

2. root 持有的发布入口严格校验 SHA 格式，不接受任意 shell 片段、分支名或路径。
3. bare repo fetch `origin main`，确认目标 SHA 可从 `origin/main` 到达。
4. 当前骨架从目标 SHA 导出 `public/` 到临时目录，不执行仓库内任意脚本。
5. 当前骨架校验 `index.html`、CSS、关键锚点、文件权限和目录大小；Docusaurus 制品的校验入口待发布契约确认。
6. 完成不可变 release，原子切换 `current`。
7. 在服务器本机请求 Nginx 健康地址；失败则切回原 symlink。
8. 返回部署 SHA、前一版本和验证结果，GitHub Actions 再做公网冒烟检查。

TAT 命令输出不得包含 SecretKey、deploy key、证书私钥或腾讯云账号资料。TAT 执行历史不是长期发布账本；GitHub deployment 与项目进度保留正式记录。

TAT `InvokeCommand` 支持对已启用参数的固定 command 传入 JSON 编码参数，并返回 invocation ID；这使部署凭证只需触发既有命令，不需要 `RunCommand` 任意脚本权限。参考：[TAT 触发命令 API](https://cloud.tencent.com/document/api/1340/52678)。

项目体验不复用主站 deploy command。每个项目使用固定仓库、分支、产物目录和目标目录的独立 TAT command，只接受提交 SHA；完整契约见 [项目体验子域名架构](../architecture/project-experience-hosting.md)。

## DNS 设计

保持域名在腾讯云注册，不迁移 nameserver。2026-07-12 公共查询已确认权威 nameserver 为 `broderick.dnspod.net` 与 `sandpaper.dnspod.net`，根域和 `www` 均无 A/AAAA，父区无 DS；上线前仍需在控制台核对 zone 所属账号与记录清单。

| 主机记录 | 类型 | 线路 | 值 | 初始 TTL |
|---|---|---|---|---|
| `@` | A | 默认 | 轻量服务器公网 IPv4 | 600 秒 |
| `www` | A | 默认 | 轻量服务器公网 IPv4 | 600 秒 |
| `<project-slug>` | A | 默认 | 同一轻量服务器公网 IPv4 | 600 秒 |

腾讯云注册域名通常已自动加入云解析 DNS；快速解析可为 `@` 与 `www` 创建 A 记录。参考：[快速添加域名解析](https://cloud.tencent.com/document/product/302/3446/)、[A 记录](https://cloud.tencent.com/document/product/302/3449)。

- 不添加泛解析 `*`。
- 只有 [项目体验注册表](../contracts/project-experiences.json) 中已批准的项目才能创建显式子域名记录。
- 未配置服务器 IPv6、系统防火墙、Nginx 和证书前不添加 AAAA。
- 不覆盖未知 MX、TXT、CAA 或验证记录；修改前导出当前 DNS 清单。
- 稳定观察后可把 TTL 调整到 3600 秒；迁移或故障演练前再提前降低。
- HTTPS 和 DNS 稳定后启用 DNSSEC，并验证 DS、DNSKEY、RRSIG 与公共解析结果。DNSPod 支持 DNSSEC，具体套餐可用性在控制台现场核验。

## Nginx 与 HTTPS

### 主机名行为

- `http://axialmuse.com/.well-known/acme-challenge/*` 与 `http://www.axialmuse.com/.well-known/acme-challenge/*` 只从专用、root-owned 的 Certbot webroot 提供 HTTP-01 token。
- 除上述 challenge 路径外，`http://axialmuse.com/*` 跳转到 `https://www.axialmuse.com/*`。
- 除上述 challenge 路径外，`http://www.axialmuse.com/*` 跳转到 `https://www.axialmuse.com/*`。
- `https://axialmuse.com/*` 跳转到 `https://www.axialmuse.com/*`。
- `https://www.axialmuse.com/*` 提供静态内容。
- `https://<project-slug>.axialmuse.com/*` 由该项目精确 `server_name` 提供独立体验内容。
- 未知 `Host` 不提供站点内容。

所有跳转保留路径和查询参数。主站 Nginx Web Root 只读指向 `/srv/axialmuse/current`；每个项目只读指向 `/srv/axialmuse-experiences/<project-slug>/current`。所有站点关闭目录列表并定义独立错误页，不从 Host 动态拼接磁盘路径。

Certbot challenge webroot 独立于 `/srv/axialmuse/releases` 和 `current`，不允许 Certbot 写入、覆盖或修改不可变站点 release；确切目录、权限和 Nginx location 在部署配置实施前核验并落盘。

### 安全响应头

迁移前 `public/` 骨架的静态响应使用以下基线；实现阶段在 Nginx 模板中保留完整值，并由公网冒烟检查验证：

| 响应头 | 迁移前骨架值或策略 |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `Content-Security-Policy` | 迁移前骨架仅允许本站 HTML、CSS、图片、字体和媒体；禁止脚本、对象、frame、表单提交和跨站连接 |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), geolocation=(), microphone=(), payment=(), usb=()` |
| `X-Frame-Options` | `DENY`，作为旧客户端的 frame 防护补充 |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Strict-Transport-Security` | HTTPS 全链路稳定后启用 `max-age=15552000`；首版不提交 preload |

迁移前骨架 CSP 精确基线为 `default-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self'; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests`。Docusaurus 目标已经接受本站静态产物中的标准 React 客户端资源，因此迁移后不能继续照抄 `script-src 'none'`；必须根据锁定版本的真实构建产物、内联内容和浏览器网络请求设计并验证新版 CSP，再写入构建发布契约。该事实不批准第三方来源，也不得临时使用 `*`、`unsafe-inline` 或 `unsafe-eval` 放宽。

HSTS 的 `includeSubDomains` 只在所有已登记子域名均具备有效 HTTPS 且完成恢复演练后启用。未知或未来子域名不能因提前启用 HSTS 而在尚未签证时失去可控验证路径。

### 缓存与传输

| 资源 | Cache-Control 基线 |
|---|---|
| HTML | `no-cache`，每次可复用缓存但必须重新验证 |
| `robots.txt`、`sitemap.xml` | `public, max-age=300` |
| 未指纹化 CSS、favicon 和图片 | `public, max-age=3600` |
| 内容哈希文件名资源 | `public, max-age=31536000, immutable` |
| MP4、WebVTT 与视频封面 | `public, max-age=86400`；MP4 支持 Range 请求 |
| 错误页 | `no-store` |

Nginx 为 HTML、CSS、XML、SVG、JSON 和 WebVTT 启用 gzip，不重复压缩已压缩图片或视频。响应必须带正确 MIME type 和 `ETag` 或 `Last-Modified`，发布切换后不能让旧 HTML 长时间引用已删除资源。

### 证书策略

首版使用 Certbot（ACME 客户端）自动签发双域名证书，并启用 systemd 定时续期与 deploy hook：

1. DNS 已指向服务器且 80/443 放通。
2. 首次签发同时包含 `axialmuse.com` 和 `www.axialmuse.com`。
3. 每日由 Certbot systemd timer 检查是否需要续期。
4. 续期后执行 `nginx -t`，成功才 reload。
5. 每日外部检查证书剩余有效期，低于 21 天告警。

每个项目子域名单独签发单主机证书，不使用泛域名证书，也不把所有项目加入主站证书。项目证书续期失败不得阻塞主站或其他项目 reload。

不把证书或私钥提交到 Git。腾讯云免费证书当前有效期为 90 天，快速续期相当于重新申请且重新部署；对自管 Nginx 而言，自动化 Certbot 更符合无人值守维护目标。参考：[腾讯云免费证书续期](https://cloud.tencent.com/document/product/400/61353)、[Certbot 文档](https://eff-certbot.readthedocs.io/en/stable/)。

## 备案与公开页脚

已确认 ICP 备案号为 `沪ICP备2026029086号`，腾讯云接入备案成功。上线前仍需在腾讯云备案控制台核验备案状态有效、网站名称与实际公开内容一致，且域名确实关联当前轻量服务器接入信息。

网站开通时，主站与每个公开项目体验首页都必须在底部展示 `沪ICP备2026029086号`，并链接到 [工业和信息化部备案管理系统](https://beian.miit.gov.cn/)。工信部《非经营性互联网信息服务备案管理办法》第十三条明确要求在主页底部中央标明备案编号并提供查询链接。参考：[非经营性互联网信息服务备案管理办法](https://www.miit.gov.cn/gyhxxhb/jgsj/cyzcyfgs/bmgz/xxtxl/art/2024/art_84a0cfa0ebd049bbbe751dca9a008e56.html)。

公安联网备案状态仍需核验；若尚未办理，开站后按上海公安指引通过全国互联网安全管理服务平台提交。取得公安备案号后，在页脚增加对应编号和官方链接。参考：[上海市公安局公开答复](https://gaj.sh.gov.cn/shga/wzShgarxPjxx/getPjPage?pa=4cf1d12909aa5cd6041f6fb5009ad182)。

本站 M0 为非经营性个人技术分享站点。新增收费、交易、经营性服务或受专项许可约束的内容前，必须另行评估许可与产品边界。

## 上线顺序

1. 完成服务器地域、系统、镜像、现有服务和续费盘点。
2. 核验 ICP 备案号、备案内容与腾讯云接入状态。
3. 创建系统盘快照；确认实例套餐支持快照，并记录回滚影响。
4. 加固腾讯云账号、轻量防火墙、SSH 和系统更新策略。
5. 安装并验证 Nginx、Git、Certbot 与 TAT agent。
6. 创建生产目录、只读仓库凭证、root-owned 发布脚本和固定 TAT command。
7. 配置 GitHub `production` environment、最小 CAM 凭证与 deployment workflow。
8. 先通过服务器公网 IP 的受控测试或临时 hosts 验证 Nginx，不提前公开未完成页面。
9. 保存 DNS 旧值，添加或修改 `@` 与 `www` A 记录。
10. 签发证书，验证四种 HTTP/HTTPS 主机名行为和未知 Host 拒绝策略。
11. 从 `main` 走一轮自动发布、失败回滚和上一个版本恢复演练。
12. 发布 canonical、`robots.txt`、`sitemap.xml`、ICP 页脚和安全响应头。
13. 启用 DNSSEC，完成桌面端、移动端、公共解析、TLS 和生产冒烟验证。
14. 连续观察至少 24 小时，更新生产清单；开站后按时完成公安联网备案。

项目体验在主站完成基础上线后按 [项目体验子域名架构](../architecture/project-experience-hosting.md) 逐个接入，不与主站首次 DNS 切换打包执行。

## 上线验收

### DNS 与备案

- `@` 与 `www` A 记录均指向预期轻量服务器公网 IPv4。
- 注册表中状态为 `live` 的项目都有且只有预期的显式 A 记录；不存在泛解析。
- nameserver、DNSSEC 验证链和公共解析结果正确。
- ICP 备案状态、腾讯云接入状态和页脚备案号一致。
- 没有未知泛解析、失效验证记录或被覆盖的邮件记录。

### 服务器与 HTTPS

- 公网只开放设计中的端口，SSH 来源受限。
- Nginx 配置测试通过，未知 Host 不提供正式内容。
- 每个项目使用精确 `server_name` 和独立只读 Web Root，不能读取其他项目 release。
- 四种主机名协议组合最终只落到 canonical URL。
- 证书覆盖根域与 `www`，续期 timer 和 reload hook 验证通过。
- 每个 `live` 项目证书只覆盖对应子域名，并能独立续期和验证。
- 页面无混合内容，安全响应头和缓存策略符合设计。

### 发布与内容

- `npm run quality` 通过，生产 release SHA 与 GitHub deployment 一致。
- 连续两次发布和一次回滚均不产生半更新状态。
- 每个项目可在不修改主站 symlink 的情况下独立发布与回滚。
- 桌面端和移动端实际截图验证通过。
- 生产允许索引，页面包含正确 canonical、站点地图与备案页脚。
- 未出现密钥、私人联系方式、占位成果或未发布能力承诺。

## 回滚与恢复

### 错误发布

发布脚本保留前一版本 symlink。公网冒烟失败时自动切回；人工回滚只能选择 `releases/` 中已验证 SHA，并同步在 GitHub deployment 与项目进度记录原因。

### Nginx 或证书故障

配置变更前运行 `nginx -t` 并保留上一份配置。证书续期失败不删除仍有效证书；修复 ACME 或 DNS 后重新验证。只有系统级损坏且文件级恢复不可行时才回滚快照。

### 服务器故障

GitHub 保存源码与内容，服务器只保存可再生 release。恢复顺序为：新建或恢复轻量实例、应用受控配置、恢复只读仓库、重新签发证书、从已验证 SHA 发布、切换 DNS。M0 目标 RTO 为 4 小时，RPO 为 GitHub 最后一个成功生产提交。

腾讯云快照可用于系统盘故障和错误操作回滚，但销毁实例会同时删除其快照，因此快照不能替代 Git 与配置真相源。参考：[管理快照](https://cloud.tencent.com/document/product/1207/48546/)。

# 项目体验子域名架构

状态：draft
最近更新：2026-07-13
适用范围：M0-M2 项目体验入口、子域名、发布隔离、隐私与下线

## 目的

本文定义如何使用 `https://<project-slug>.axialmuse.com/` 为各个项目提供可直接访问的体验入口，同时保持主站、不同项目和未来动态服务之间的故障与权限边界。

主站负责项目发现、背景说明和技术内容；项目子域名负责实际体验。主站不使用 iframe 嵌入项目体验，也不把所有项目产物混入主站发布目录。

## 首版边界

M0 支持静态项目体验：HTML、CSS、JavaScript、图片和其他可直接由 Nginx 提供的文件。静态体验不在服务器运行构建命令、应用进程或数据库。

以下能力不因创建子域名自动获得，必须为对应项目另写设计后才能上线：

- 服务端运行时、反向代理、容器或常驻进程。
- 登录、评论、上传、表单、支付或用户账号。
- AI API、第三方 API、Secret 或服务端凭证。
- 用户数据、访问分析、跨项目会话或跨子域名 Cookie。
- 需要新闻、教育、医疗、交易等专项许可的内容或服务。

## 域名与命名

项目体验使用一级子域名：

```text
https://<project-slug>.axialmuse.com/
```

`project-slug` 契约：

- 仅使用小写 ASCII 字母、数字和单连字符。
- 以字母开头，以字母或数字结尾，长度 2-32 个字符。
- 与项目稳定标识一致，公开后默认不修改。
- 不使用容易误解为官方基础设施或管理入口的名称。

保留名称：`www`、`api`、`admin`、`auth`、`account`、`assets`、`cdn`、`dev`、`docs`、`mail`、`preview`、`staging`、`static`、`status`、`support`。

项目改名时优先保持原子域名；确需更换时，新旧域名并行验证，旧域名至少保留 90 天永久重定向到主站项目详情页或新体验地址。

## 项目体验注册表

[项目体验注册表](../contracts/project-experiences.json) 是子域名公开事实的机器可读真相源。每个体验至少登记：

| 字段 | 说明 |
|---|---|
| `id` | 稳定体验标识，与保留子域名 slug 一致 |
| `projectId` | 对 `projects.json` 的稳定项目外键；标题、公开仓库和展示方式只从项目注册表读取 |
| `hostname` | 完整体验主机名 |
| `status` | `planned`、`provisioning`、`live`、`paused`、`retired` |
| `dnsProvisioning` | DNS 实施状态；未批准体验使用 `disabled` |
| `deliveryMode` | M0 只允许 `static` |
| `deploymentSource` | 部署源码职责；引用项目仓库时只保存 `kind` 和工作目录，不复制仓库 URL 或生产分支 |
| `qualityCommands` | 发布前必须通过的依赖安装、类型、lint 和测试命令 |
| `buildCommand` | 生成静态产物的命令 |
| `artifactDirectory` | 已构建静态产物目录 |
| `healthPath` | 公网冒烟检查路径，默认 `/` |
| `indexing` | `noindex` 或 `index` |
| `dataBoundary` | 是否收集数据及对应设计文档 |
| `owner` | 维护责任人角色，不记录私人联系方式 |
| `runtimeDependencies` | API、WebSocket、上传与认证等外部运行依赖；存在时必须指向项目专属设计 |

注册表不保存公网 IP、实例 ID、deploy key、CAM Secret、证书私钥或私人仓库凭证。

`deliveryMode: static` 只描述本轻量服务器交付的产物类型，不代表整个项目没有后端。若 `runtimeDependencies` 表明存在 API、上传、登录、WebSocket 或用户数据，项目即使只发布静态前端，也必须完成独立运行、安全和隐私设计后才能进入 `provisioning`。

`status: planned` 且 `dnsProvisioning: disabled` 的条目只用于保留 slug 和维护未来边界，不属于待部署体验。此类项目可以在主站展示仓库、截图或经过审核的演示视频，但不得创建子域名解析、签发证书、部署体验产物或显示“在线体验”按钮。只有 `status: live` 且健康检查通过的条目才能生成体验入口，不再维护第二个在线布尔值。

## DNS 设计

- 每个已批准项目在 DNSPod 创建显式 A 记录，指向当前轻量服务器公网 IPv4。
- 初始 TTL 为 600 秒，稳定后可调整到 3600 秒。
- 不使用 `*.axialmuse.com` 泛解析；未登记名称不得解析到生产服务器。
- 不为未配置 IPv6、Nginx 和证书的项目添加 AAAA。
- 不使用 DNSPod 隐性 URL 转发或 iframe 转发。
- 删除项目记录前先完成主站入口移除、HTTP 下线策略和观察期。

DNSPod 支持用主机记录创建子域名；主机记录可使用字母、数字和短划线。参考：[DNSPod 子域名说明](https://cloud.tencent.com/document/product/302/46277)。

## Nginx 与目录隔离

每个项目使用精确 `server_name`，不使用通配符或从 Host 动态拼接磁盘路径。Nginx 会优先匹配精确名称；未知 Host 继续由默认 server 拒绝。参考：[Nginx server names](https://nginx.org/en/docs/http/server_names.html)、[Nginx 请求处理](https://nginx.org/en/docs/http/request_processing.html)。

目录契约：

```text
/srv/axialmuse-experiences/
└── <project-slug>/
    ├── repo.git/
    ├── releases/
    │   └── <40-char-sha>/
    └── current -> releases/<sha>
```

- 不同项目不共享 release 目录、deploy key 或可写权限。
- Nginx 只读访问 `current`，不允许目录列表。
- 发布采用不可变 SHA 目录和原子 symlink，与主站相互独立。
- 单个项目部署失败只能回滚该项目，不修改主站或其他项目的 symlink。
- 静态项目不得写入服务器磁盘；需要写入能力时退出 M0 静态模式并单独设计。

## HTTPS 证书

- 主站继续使用覆盖根域与 `www` 的证书。
- 每个项目子域名单独签发单主机证书，不把所有项目累积到一个大型 SAN 证书。
- M0 使用 HTTP-01，80 端口保留 ACME challenge 与 HTTPS 重定向。
- 不申请泛域名证书；泛域名证书需要 DNS-01 且会扩大证书私钥影响范围。
- 每个证书使用 systemd timer 自动续期，续期后先 `nginx -t`，成功才 reload。
- 每日检查注册表中所有 `live` 主机的证书主机名与剩余有效期。

Let's Encrypt 建议一般 Web 服务器保留 80 端口并重定向到 HTTPS；HTTP-01 通过该端口完成域名控制验证。参考：[保留 80 端口](https://letsencrypt.org/docs/allow-port-80/)、[Challenge 类型](https://letsencrypt.org/docs/challenge-types/)。

## 发布模型

项目体验由项目自己的 Git 仓库构建和发布，主站仓库只维护入口与注册表。

每个项目使用独立的固定 TAT command：

```text
axialmuse-experience-<project-slug>-deploy
```

该 command 固化项目 ID、仓库、分支、产物目录和服务器目标，只接受 40 位提交 SHA，不接受项目名、仓库 URL、shell 片段或任意路径。对应 GitHub 仓库使用独立 `production` environment 和最小 CAM 凭证，权限只允许调用本项目的 command。

发布步骤：

1. 项目仓库完成自己的 lint、typecheck、test、build 和静态产物检查。
2. GitHub Actions 将精确 SHA 传给该项目固定 TAT command。
3. 服务器确认 SHA 可从登记的生产分支到达。
4. 从可信产物目录创建不可变 release，不执行仓库内任意部署脚本。
5. 校验入口、资源引用、目录大小和文件权限。
6. 原子切换项目 `current`，本机健康检查失败则自动恢复旧 symlink。
7. GitHub runner 验证 HTTPS、预期标题、健康路径和主站返回链接。

## 主站入口与体验页面

- 主站每个项目条目只在注册表状态为 `live` 且最近健康检查通过时显示“在线体验”。
- 链接直接进入项目子域名，不使用 iframe，不伪装成主站内部页面。
- 体验首页提供返回主站对应项目说明的入口。
- 项目暂停时主站移除体验按钮，子域名返回维护状态页，不继续展示损坏界面。
- 主站项目详情是项目背景、证据和技术内容的 canonical 页面；体验子域名默认 `noindex`。
- 只有体验本身具备独立可检索内容、元数据和长期 URL 承诺时，才把 `indexing` 改为 `index`。

## 安全与隐私隔离

- 主站和不同项目不得设置 `Domain=.axialmuse.com` 的共享 Cookie。
- 需要 Cookie 的未来项目使用 host-only Cookie，并优先采用 `__Host-` 前缀、`Secure`、`HttpOnly` 和适当的 `SameSite`。
- 不配置 `Access-Control-Allow-Origin: *.axialmuse.com`；跨来源访问按明确调用方和方法逐项允许。
- 每个项目独立定义 CSP、安全响应头、第三方资源、数据字段和日志边界。
- 静态体验沿用 access log 默认关闭、error log 本地短期保留的 M0 基线。
- 项目不能读取主站或其他项目的部署凭证、release 目录或私有配置。

## 备案与公开信息

每个公开项目子域名的首页底部展示 `沪ICP备2026029086号` 并链接工信部备案管理系统；取得公安备案号后同步展示。项目内容必须与当前备案网站名称、服务内容和非经营性边界一致。

若项目形成独立网站、经营性服务、专项许可内容或不同主体服务，不能仅凭主域名已有备案直接上线；先通过腾讯云备案控制台和主管部门官方要求核验是否需要备案变更、新增网站或其他许可。

## 新项目上线流程

1. 完成项目目标、体验边界、数据边界和维护责任说明。
2. 选择未占用且非保留的 slug，加入注册表，状态为 `planned`。
3. 完成项目仓库质量、构建和静态产物契约。
4. 在服务器创建隔离目录、只读 deploy key 和固定 TAT command。
5. 创建精确 Nginx server block，通过 `nginx -t` 后加载。
6. 用本地 hosts 受控验证 HTTP 行为和未知 Host 隔离。
7. 在 DNSPod 添加显式 A 记录，状态改为 `provisioning`。
8. 签发单主机证书，验证 HTTP 到 HTTPS 和 ACME 自动续期。
9. 从项目生产分支部署两个连续 SHA，并完成一次项目级回滚。
10. 验证备案页脚、返回主站入口、移动端、桌面端和安全响应头。
11. 公网健康检查通过后将状态改为 `live`。
12. 最后在主站显示“在线体验”入口，避免先发布失效链接。

## 暂停与下线

暂停时先把注册表改为 `paused` 并移除主站入口，再显示明确维护页。永久下线时：

1. 将状态改为 `retired` 并记录替代入口。
2. 子域名至少保留 90 天 301 到主站项目详情，或对无替代内容返回 410。
3. 观察外部引用和搜索状态后删除 DNS 记录、Nginx 配置、证书续期任务与服务器 release。
4. 撤销该项目 CAM 凭证、TAT command 和 deploy key。
5. 保留主站项目复盘和 Git 历史，不让子域名悬空指向可被接管的第三方服务。

## 验收标准

- 每个公开子域名在注册表、DNS、Nginx、证书和主站入口中使用同一 slug。
- 未登记子域名不解析，未知 Host 不返回任何项目内容。
- 每个项目可独立发布、回滚、暂停和撤销权限。
- 主站只链接状态为 `live` 且健康的体验。
- 每个体验包含返回主站入口、备案信息、HTTPS 和明确索引策略。
- 项目之间不共享 Cookie、写目录、deploy key、CAM 权限或运行时 Secret。
- 动态能力和用户数据不会借“体验入口”绕过独立设计与审核。

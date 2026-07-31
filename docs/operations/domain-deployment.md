# 域名与生产发布设计

状态：draft
最近更新：2026-07-30
适用范围：M0 腾讯云域名、DNS、轻量应用服务器、HTTPS、自动发布与回滚

## 目的

本文把 `axialmuse.com` 从已注册、已备案状态发布到腾讯云上海轻量应用服务器的过程拆成可验证步骤。服务器侧第一阶段只读盘点、废弃旧站清理、腾讯云控制面基础核验、当前加固前系统盘快照、额外管理身份的可逆禁用和 D-119/D-120 SSH 全局策略已经完成；OS/腾讯云防火墙、重启维护和 verifier/Certbot 安装仍须在实施前分别核验、决定或授权。

## 已知事实

- 正式域名：`axialmuse.com`。
- 域名注册商：腾讯云。
- ICP 备案号：`沪ICP备2026029086号`。
- 腾讯云接入备案：用户于 2026-07-13 确认接入成功。
- 生产服务器：腾讯云轻量应用服务器，中国上海地域，Ubuntu Server 24.04 LTS 64bit。
- 服务器用途：用户此前确认为空机并专用于本网站生产部署；2026-07-29 只读现场盘点发现的既有静态网页已由用户确认为此前部署且可删除，其专属配置和 Web Root 已清理。额外管理身份已经按 D-118 可逆禁用，云代理决定保留，D-119/D-120 SSH 全局策略已达到 `committed_clean`；OS/腾讯云防火墙、维护重启和其余安全基线仍待闭环。

以上事实来自用户确认，实施时仍需通过腾讯云控制台和服务器只读命令交叉核验。文档不记录腾讯云账号、实例 ID、公网 IP、密码或密钥；生产事实统一维护在 [生产环境清单](production-inventory.md)。

## 首版生产方案

首版采用以下架构：

- GitHub 仓库继续作为源码、内容和发布历史真相源。
- GitHub Actions 对 PR 和 `main` 运行质量门禁；只有 `main` 的精确 `GITHUB_SHA` 在主构建端点生成 Docusaurus 默认 `build/`，并通过 GitHub `production` environment 交付不可变 artifact。
- 腾讯云云解析 DNS（DNSPod）管理 `axialmuse.com` 权威解析。
- 腾讯云轻量应用服务器承载 Nginx、静态 payload 和同版本服务端重定向配置，不安装 Node/npm，不拉取主站源码，不从源码 checkout 执行主站脚本或构建，也不运行应用后端或数据库。
- 已登记的静态项目体验使用 `<project-slug>.axialmuse.com`，共享服务器端口但隔离 Nginx 配置、证书、仓库与发布目录。
- 腾讯云自动化助手 TAT 调用服务器上预先安装的固定发布命令，只传递 workflow run、artifact、提交 SHA、GitHub 外层 `artifactDigest` 与上传前 `releaseContentSha256`，不为自动部署开放公网 SSH。
- Nginx 提供 HTTPS、根域/尾斜杠/旧 URL 301、安全响应头和静态文件服务；内容重定向配置与对应 payload 属于同一不可变 release。
- Certbot（ACME 客户端）自动签发并续期覆盖 `axialmuse.com` 与 `www.axialmuse.com` 的证书。
- canonical URL 为 `https://www.axialmuse.com/`，根域永久重定向到 `www`。

腾讯云 TAT 是轻量应用服务器原生运维工具，可在不登录服务器、不开放额外入站端口的情况下执行命令，并支持 API 与 CAM 权限控制。参考：[轻量应用服务器使用 TAT](https://cloud.tencent.com/document/product/1207/52631/)、[TAT 访问管理](https://cloud.tencent.com/document/product/1340/56294)。

该方案不引入 CMS、服务器 Node.js/npm 工具链、容器、数据库、页面分析脚本、广告或站内 Cookie。

## 生产拓扑

```text
贡献者 -> dev（feature 先合入 dev）-> dev CI -> 本地/局域网预览
                                           |
                                    dev -> main PR
                                           |
                                      合并到 main
                              |
          GitHub Actions 对精确 main SHA 构建 build/
                              |
                 不可变 artifact + SHA-256 清单
                              |
       production job -> 腾讯云 API -> TAT 固定发布命令
                              |
             校验、解包 releases/<sha>/{payload,config}
                              |
DNSPod -> axialmuse.com -> Nginx -> releases/<commit-sha>/payload
                                      ^
                                      |
                         current/config 仅在 reload 解析时选代
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
- 操作系统为 Ubuntu Server 24.04 LTS 64bit；2026-07-29 已现场确认 Linux `x86_64` / Debian `amd64`。
- CPU、内存、系统盘与剩余空间、全部监听及其本机进程、已安装的 Web/运行时/下载归档工具、系统服务、账户/权限、SSH 有效配置、操作系统防火墙、本机 TAT、系统 Python 和预期生产目录缺席均已通过严格 host key SSH 与 `sudo -n` 只读命令盘点。用户后续人工控制面核验确认实例规格与生命周期未发现阻断偏差；精确规格和容量只保留在私密现场记录，当前设计不为个人静态站点虚构尚未批准的资源阈值。
- 用户此前确认为空机并专用于本网站；盘点发现的旧静态网页已由用户确认并清理，未发现主站源码、Node/npm、数据库、容器或其他应用内容。额外管理身份与腾讯云代理的首启来源已经归因；用户选择本轮保留 TAT 与腾讯云代理，额外管理身份已经按 D-118 可逆禁用并完成独立后验。

在安装、升级、删除或重启前的控制面与加固状态：

- 用户已于 2026-07-30 提供人工控制面核验的脱敏逐项结论：目标实例与生命周期、快照能力/配额、控制台恢复、TAT/任务、代理保留及 MFA/操作保护未发现阻断偏差；管理入口来源受限，公网 Web 入站尚未开放，未发现其他或 IPv6 入站暴露。通用端口自检警告与当前最小暴露阶段相容，不得为消除警告而扩大开放。
- 控制面另有一条无法逐进程确定归因的历史出带宽告警；只读时间线已排除有意包升级和后续废弃旧站清理，补充内网监控只显示短时入向峰值后恢复，且当前没有持续异常、未知公网/Web 监听或 failed unit。用户按 D-116 明确接受仅限该单次历史告警的残余不确定性，因此它不再阻断 #36；未来复发、持续异常或新未知监听/进程仍须重新失败关闭。
- 用户已按 D-117 创建升级及旧站清理后、加固前的当前系统盘快照，并确认控制台终态成功/正常；该证据未包含恢复演练，后续变更前仍须确认快照存在且状态正常。
- 用户已按 D-118 完成额外管理身份的可逆禁用：移除唯一受控直接 sudo 规则，设置账户过期和不可交互 shell，同时保留账户、home、密钥文件和其他文件；提交前后的独立 SSH/sudo、配置、运行时与文件摘要验收通过。TAT 与腾讯云代理按已确认决定保留。
- D-119/D-120 已以可回退事务完成 SSH 全局策略：root-owned canonical drop-in 明确公钥专用认证、唯一 `.ssh/authorized_keys`、禁止密码/键盘交互/空密码和 root 登录；两条独立严格公钥会话、`sudo -n`、服务、配置树与有效策略后验通过，终态为 `committed_clean`，私有回退状态已清理。既有管理身份、端口、主机密钥、主密钥文件和 sudo 路径保持不变；下一步仍须单独决定并授权 OS/腾讯云防火墙的精确最终规则。
- 用户已确认核验窗口内发生的系统包升级是本人有意操作；当前加固前恢复点已经建立，但仍须取得维护窗口和明确重启授权，才能执行补丁终态所需的重启。精确运行态偏差只保留在私密现场记录，`reboot-required` 不构成自动重启授权。
- 2026-07-30 的继续只读复核确认严格 SSH、`sudo -n`、Nginx、TAT 与 systemd 仍健康，没有 failed unit、未知非本地 TCP 监听或 Web 监听。UFW 已安装但未启用，IPv4/IPv6 INPUT 默认仍为接受；腾讯云本机代理保留的独立来源拒绝链不等于完成端口白名单，因此 OS 防火墙继续失败关闭。Ubuntu 官方自动安全更新服务与定时器已启用且未配置自动重启；本轮刷新后的包索引仍显示三个非内核数据包待升级，当前仍存在维护重启标记。任何包升级、UFW 写入或重启仍须另行授权。

若现场核验发现未知业务、重要数据或系统版本不符，先停止改动并确认原因；不通过重装系统覆盖未知内容。

### 运行组件

| 组件 | 职责 | 约束 |
|---|---|---|
| Nginx | HTTPS、同版本 301、安全头、静态文件 | 系统包已安装并保持 active，当前无活动 server block 或 Web 监听；不安装可视化服务器面板，请求期只引用精确 release SHA |
| 系统下载、归档与哈希工具 | 从固定 GitHub 仓库读取 artifact 元数据，安全解包并校验摘要和文件清单 | 所需系统工具与 root-owned `/usr/bin/python3` 3.12 已现场核验；#35 verifier 不调用 Node/npm，安装副本仍须按下文单独授权 |
| Certbot | 签发与续期 TLS 证书 | 当前未安装；只读模拟确认 Ubuntu 24.04 官方 `certbot` 包可用且最小安装不会移除或替换 SSH、Nginx、TAT 等关键包。#36 只负责安装与 timer 基线，不创建 webroot、不请求证书、不触碰 DNS/TLS；后续使用 webroot HTTP-01，续期后验证并 reload Nginx |
| TAT agent | 接收腾讯云固定运维命令 | 本机 agent 已确认 active/enabled，用户人工控制面核验确认 online 且没有未知任务；固定 command 和 CAM 最小授权归 #34/#37 活动接线，仍待核验 |
| logrotate / systemd | 日志轮转、服务与续期定时器 | 不引入第三方常驻监控 agent |

仓库仍保留迁移前 `public/`；目标机旧静态 Web Root 已于 2026-07-29 按用户授权删除，当前没有活动 Nginx server block，且尚未部署 Docusaurus release。仓库已具备 Docusaurus production `build/`、#13 服务端 301 派生、#33 确定性 `dist/release/` 封装/独立复验，以及 #35 服务器独立 verifier；#35 已形成本地提交 `f7fdc43` 但尚未推送。#14 已由本地提交 `7b5cc47` 按 D-110 把 E-005/E-014/E-015 固定链路接入 `production-artifact`：对 canonical `main` 精确 SHA 在 fresh runner 自包含重建、重验、封装并单次上传，使 release 同时绑定静态 payload 与服务端 301 派生配置。该接线只有本地静态/fixture 契约证据，尚未发生 GitHub-hosted run 或真实 upload，因而没有可部署 Actions artifact、实际 outputs 或 ZIP。#35 独立实现服务器的双摘要、安全解包和内部闭包复验；#37 再消费已验证 staging，完成不可变安装、账本、Nginx 与激活。两者都不允许服务器拉取源码、写作、编辑、安装 Node/npm 或执行构建。

### 目录契约

```text
/srv/axialmuse/
├── staging/                  # artifact 下载与安全解包临时区，不由 Nginx 提供
├── releases/
│   └── <40-char-sha>/        # 已核对 artifact 与逐文件清单的不可变 release
│       ├── payload/          # Docusaurus build 静态文件，唯一 Web Root
│       └── config/           # 不公开的同版本运行清单与 Nginx 配置
│           ├── runtime-redirects.json
│           ├── redirects.conf
│           └── site-release.conf  # root-owned 脚本生成，只含精确 SHA 绝对引用
└── current -> releases/<sha> # 只在配置解析/运维时选择活动 release，不作请求期 root

/var/lib/axialmuse/
└── url-exposure-ledger.json # root-owned 只追加生产 URL/301 暴露证据，非 Web Root
```

- 发布先写入同文件系统的临时目录，校验成功后把 payload 与两个可部署派生文件改名为 SHA release；固定脚本再生成只引用该 release 绝对路径的 `site-release.conf`。
- Actions artifact 的 `release.json` 和 `files.sha256` 只在 `staging/` 验证；已绑定摘要的运行清单与 `redirects.conf` 安装到非 Web Root `config/`，`payload/` 是唯一可公开目录。
- 基础 Nginx 模板通过 `current/config/site-release.conf` 在 `nginx -t`/reload 解析时选择完整代；解析后的 `root` 与 redirect include 都含 40 位 SHA 绝对路径，因此旧 worker 不会随 `current` 改变而读取新 payload。
- 发布目录不得被 Nginx 或发布流程就地覆盖。
- 默认保留最近 5 个成功版本；当前版本、上一兼容版本和仍被 graceful shutdown 旧 worker 使用的版本不得被清理。
- `url-exposure-ledger.json` 不随 release 回滚或清理；它在 reload 前保存候选的全部规范 200 路径和新增或改指的 registered 边，按稳定 schema 原子追加并进入 root-owned 备份；`canonical-slash` 不单独入边账本，但它可能暴露的 canonical target 已由上述路由预写保护。丢失或损坏时停止发布，不用当前 release 或注册表静默重建。
- 当前根域和 `www` 无 A/AAAA；首次上线可在 DNS 开放前、无活动 release 时经一次性上线授权创建空账本。一旦创建，缺失绝不得再被当作首次部署；既有站点迁移只能显式导入可审计的历史路径/重定向并人工复核。
- 发布脚本与 Nginx 配置后续纳入仓库，安装到服务器的副本由 root 持有且不可被部署凭证修改。

### 配置即代码契约

M0-P 实施时按以下路径纳入仓库；表中路径是设计契约，文件在对应实施步骤完成前可以不存在：

| 计划路径 | 责任 |
|---|---|
| `ops/nginx/axialmuse.conf` | 精确 Host、ACME 边界、release include、兜底跳转、错误页和缓存规则 |
| `ops/nginx/snippets/security-headers.conf` | CSP、HSTS 以外的安全响应头；HSTS 由启用步骤单独控制 |
| `ops/deploy/bootstrap_artifact_verifier.py` | 以系统 Python、held directory fd、父目录与持久文件双重非阻塞 `flock`、`renameat2(RENAME_NOREPLACE)`、目录同步和 receipt 状态机完成 verifier 的一次性首次安装或崩溃恢复；不提供 force、replace、cleanup 或目标路径参数，也不作为长期服务器组件安装 |
| `ops/deploy/verify_artifact.py` | 以系统 Python 标准库独立校验外层 artifact、ZIP 路径、完整 release tree、内部 metadata/清单和运行规则，只在全部通过后产生固定 `verified-release/` staging |
| `ops/deploy/deploy.sh` | 编排固定 workflow/artifact 身份与下载并调用独立 verifier；在锁内复核 `verified-release/` 身份和整树摘要后负责不可变安装、暴露账本、精确 SHA 包装、隔离预检、`nginx -t`、reload、冒烟与受控恢复，不重复安全解包或内部清单解析 |
| `ops/deploy/rollback.sh` | 只整版切换到已存在、通过校验且使账本中历史 source/target 收敛到同一当前 200 终点的兼容 release |
| `ops/systemd/` | 证书检查、服务器健康与维护 timer/service 模板 |
| `ops/logrotate/` | Nginx error log 和认证日志保留策略模板 |
| `.github/workflows/ci.yml` 的 `deploy-production` job | 直接消费同一 run 的 `production-artifact` 精确输出，把 `main` 精确 SHA 受限调度到 TAT；不得用独立 workflow 再按名称、latest 或跨 run 查询 artifact |
| `.github/workflows/maintenance.yml` | HTTPS、TLS、链接、DNS 和到期提醒的定时检查 |

- 仓库只保存无 secret 模板；实例 ID、SecretId、SecretKey、私有仓库 artifact 读取凭证和证书私钥不得写入这些文件。
- 安装到 `/etc`、`/usr/local/sbin` 和 root 配置目录的副本由 root 持有，发布身份没有修改权限。
- 模板变更先在测试路径执行语法与受控 hosts 验证，再由独立运维步骤安装；网页内容发布不能顺带覆盖系统配置。

#36 的 verifier 安装目标固定为 `/usr/local/lib/axialmuse/artifact-verifier/`：`axialmuse/` 命名空间和 `artifact-verifier/` 目录均为 `root:root`、mode `0755`，其中 `verify_artifact.py` 为 `root:root`、mode `0755`，相邻 `file-tree-v1-golden.json` 为 `root:root`、mode `0644`；命名空间内另有 root-only、mode `0700` 的 `.bootstrap/` 事务状态目录。安装只允许在 verifier、golden 和一次性 bootstrap runner 所属提交已经进入 canonical `main` 后，从同一精确提交核对三个 Git blob。runner 只作为本次 root 事务的临时执行载荷，不写入正式命名空间；mode `0700` 的私有 source root 必须精确只含 mode `0600` 的 verifier/golden 两个普通单链接文件，只有这两个文件会被复制到候选。除这三个已认证 blob 外，不得传递 `.git`、源码树、Node/npm 或其他仓库文件；临时 runner/source root 的创建、清理和现场执行仍须另行授权。

bootstrap CLI 只接受固定顺序的 `--source-root`、canonical `main` 精确 commit SHA、verifier SHA-256 和 golden SHA-256；正式目标、owner/mode、文件名、状态目录和锁名均不可由参数改变。成功只输出一行脱敏 JSON，区分 `installed`、`recovered` 与 `already-committed`；提交前失败保持 stdout 为空并返回稳定错误码。CLI 参数中的 commit/digest 只绑定本次事务，不自行证明 canonical `main`；调用方必须先通过 GitHub 只读证据和精确 Git blob 完成该外部认证。

bootstrap 必须实现失败关闭的首次安装事务：

1. bootstrap 从已持有的根目录句柄逐级以 `O_DIRECTORY|O_NOFOLLOW` 打开 `/usr`、`/usr/local` 和 `/usr/local/lib`，每级都必须是 root-owned、非链接、group/other 不可写的真实目录，并在整个事务中保持设备/inode 身份；禁止自行创建或替换这些系统目录。在枚举任何事务状态前，固定按“已持有的 `/usr/local/lib` 目录 fd 非阻塞独占 `flock` -> 已持有的 `lib` 句柄下原子创建或 no-follow 打开固定 `.axialmuse-artifact-verifier-bootstrap.lock` -> 固定文件非阻塞独占 `flock`”的顺序取得双锁。固定文件必须是 `root:root`、mode `0600`、单链接空普通文件，必要的首次创建须同步文件和系统父目录；任一锁已占用或运行文件系统不支持目录 `flock` 时都不等待、不降级为单文件锁、不读写候选并失败。目录锁使替换固定文件路径也不能在 fresh-empty 窗口放入第二个协作 bootstrap，持久文件继续提供跨运行审计身份；两个锁都从首次状态枚举持有到提交/隔离结论、最终验收记录和进程返回，并按文件锁、目录锁的逆序释放。崩溃只依赖内核释放锁，锁文件本身持久保留。
2. 在独占锁内按第 7 步状态机确认这是全新安装或唯一可恢复事务；全新安装时正式命名空间 `/usr/local/lib/axialmuse` 必须不存在。bootstrap 只在已持有的 `lib` 句柄下创建同文件系统、不可预测名称、初始 mode `0700` 的候选命名空间，最终一次不覆盖 rename 同时创建 `axialmuse` 父目录和其中的安装目标。
3. 候选命名空间内的 `artifact-verifier/` 只写入两个传递来的普通文件；另建 root-only `.bootstrap/`，保存不含凭证的事务 receipt 和唯一 `prepared` 状态标记。receipt 绑定 schema、canonical `main` 精确提交、两个源摘要、事务随机身份、持久 lock 文件身份，以及候选命名空间、安装目录和文件的设备/inode。创建 receipt 前再次复核 live lock path 与 held lock fd 相同；以后每次打开或重验候选、正式或已提交事务都要求 receipt 的 lock device/inode、held lock fd 和 live lock path 三者一致。lock 路径被替换时不得把新 inode 当作同一事务继续，也不得隔离或覆盖已经提交的正式对象。所有路径都从已持有的目录句柄以 no-follow 方式打开，拒绝链接、特殊文件、额外成员和跨文件系统对象。
4. 候选中的 verifier/golden 逐字节匹配精确 Git blob，设置文件、安装目录、状态目录和候选命名空间的最终 owner/mode，先在候选绝对路径运行同一系统 Python `--self-test`，再复核摘要、单链接普通文件、owner/mode、receipt 与 held-fd 身份；文件、安装目录、状态目录、候选命名空间和系统父目录按顺序同步。任一步失败只可清理仍与 receipt 精确绑定的候选；身份不明时移入 root-only 隔离名或停止等待人工恢复，不递归删除未知对象。
5. bootstrap 从候选命名空间 rename 到正式命名空间前屏蔽 SIGINT/SIGTERM，并保持屏蔽直至提交或完成身份绑定隔离。rename 前在独占锁内重新枚举固定前缀，必须仍只有本事务唯一候选且正式/隔离均不存在；rename 使用不覆盖语义，正式目标竞态出现时保持外部对象不变并失败。rename 后只对 held fd 所绑定的同一目录和成员执行最终路径摘要、owner/mode、无链接与系统 Python 自测；这些检查通过后必须先 fsync 已持有的 `/usr/local/lib` 句柄，使正式命名空间 rename 持久化，成功后才可进入状态提交。任一检查或 fsync 失败/结果不明都不得宣布提交；仅可把 receipt 精确匹配的整个正式命名空间不覆盖地移入 root-only 隔离名，并再次 fsync `/usr/local/lib`，使正式目标恢复为不存在。无法证明隔离 rename 与父目录同步成功时进入恢复状态，不得报告普通失败后盲目重试。
6. 正式 rename 和系统父目录同步均已成功后，在仍持有双锁时再次枚举保留的固定名称/前缀，除锁文件和本事务唯一 `formal + prepared` 外不得存在候选、隔离或其他事务；随后以原子 rename 把唯一状态标记从 `prepared` 转为 `committed` 并 fsync 状态目录。“committed 标记存在且该同步成功”是唯一 commit point。只有已经开始状态标记 rename/fsync、其结果可能不明的失败才可在同一信号屏蔽区执行第 7 步恢复：恢复时看到 `formal + committed` 可完整重验并重新同步，看到同一 `formal + prepared` 可完整重验后重试状态提交。正式 namespace 激活后的摘要、身份、自测、live lock 或系统父目录同步等已知失败仍属于第 5 步，必须隔离，不能仅因当前仍是 `formal + prepared` 就重跑自测并转为成功。不能完成提交恢复时只报告 outcome unknown，下一次仍从 receipt 恢复，不能当作全新安装。commit point 后不再枚举、复核或执行其他会改变安装结论的操作，只在继续持有双锁时写出已提交验收记录并返回；commit 后才到达的 SIGINT/SIGTERM 按已提交成功处理，不能返回会诱导盲目重试的失败结果。
7. 每次启动在取得上述独占锁后，从逐级验证并持有的 `/usr/local/lib` 句柄枚举保留的固定名称/前缀；在这个保留集合内，锁文件是唯一允许的非事务对象，其他对象按下列互斥状态恢复。每个事务对象都必须只有一个 receipt、事务身份一致、只有一个状态标记，且摘要、设备/inode、owner/mode、成员闭包和自测全部匹配：

   - 正式、候选与隔离均不存在：允许开始全新首次安装。
   - 只有一个 `candidate + prepared`：重验候选后执行 candidate -> formal 的不覆盖 rename、fsync 系统父目录、正式路径复核，再提交状态；失败则按同一 receipt 隔离并 fsync 系统父目录。
   - 只有一个 `candidate + committed`：这是正式 rename 的持久化结果不明后候选名回现；重验后执行 candidate -> formal 的不覆盖 rename 并 fsync 系统父目录，再复核正式路径与状态目录，保持 committed，不重复状态提交。
   - 只有 `formal + prepared`：候选 rename 已发生，不再尝试不存在的 candidate；直接重做正式路径复核、fsync 系统父目录，再把状态提交为 committed，失败则整体隔离并同步父目录。
   - 只有 `formal + committed`：重做完整身份、自测与摘要复核并 fsync 状态目录和系统父目录，只认定为同一已提交安装，不覆盖。
   - 任一隔离对象存在、正式与候选并存、多个候选/事务、无标记、双标记、receipt/身份/摘要不符、receipt 绑定的持久 lock inode 已被替换或隔离失败：一律失败并等待人工处置；隔离对象或 lock 身份漂移经独立核验和授权处置前，后续全新 bootstrap 一律拒绝运行。

   进程崩溃、SIGKILL、掉电或任一 fsync 结果不明都只能进入上述状态机，不能使用目录存在性猜测成功，也不能删除或覆盖无法绑定到唯一 receipt 的对象。
8. 首次安装只允许上述“候选完整命名空间 -> `axialmuse` 正式命名空间”事务；不得预先留下空父目录，不就地覆盖。固定 lock 文件及其已写入 receipt 的 device/inode、已提交 receipt 是事务审计状态，不是传递来的仓库文件，安装成功后保留；后续升级、添加其他服务器组件，或替换/清理 lock、receipt、隔离对象必须另行设计和授权。

候选和正式目标的现场自测分别使用各自绝对路径；正式目标验收命令固定为：

```bash
/usr/bin/python3 -I -B /usr/local/lib/axialmuse/artifact-verifier/verify_artifact.py --self-test
```

命令成功、两文件 source/installed 摘要分别相等、解释器/目录/文件 owner/mode 和无链接边界全部通过、root-only receipt 显示同一事务已经越过上述 commit point，才算 #36 安装验收；本设计本身不授权传输或安装。

### #36 Certbot 安装边界

#36 只从 Ubuntu 24.04 已配置的官方 apt 来源安装 `certbot`，使用 `--no-install-recommends`，不引入 snap、Nginx/Apache plugin、第三方 PPA 或其他 ACME 客户端。本轮安装可以创建该系统包自身的配置目录、systemd service/timer 和包管理记录，但不得创建 ACME webroot、证书 lineage、账户、deploy hook 或 Nginx location，不得请求 ACME、修改 DNS/TLS、reload Nginx 或开放 Web 监听。

安装前必须重新模拟精确包计划并确认没有 removal、downgrade 或关键服务包替换；安装后要求 `certbot` 来自预期 Ubuntu 包、CLI 可执行，`certbot.timer` 为 enabled/active，系统中仍没有证书 lineage，Nginx 配置测试、零活动 server block/零 Web 监听、SSH/TAT、systemd failed unit 和软件边界后验不变。正式证书签发、webroot 权限、续期 dry-run 和 deploy hook 验收属于后续 DNS/Nginx/TLS 上线步骤，不以 #36 的安装成功冒充。

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
- canonical 仓库已于 2026-07-29 只读核验为 public，artifact 使用无需凭证的读取路径，服务器不配置私有仓库读取凭证。若未来仓库可见性发生经批准的变化，必须重新设计并授权读取身份，不沿用当前路径隐式降级。

## 自动发布契约

### GitHub 侧

M0 生产 workflow 仅由 canonical repository 的 `main` push 触发，不提供普通 `workflow_dispatch` 发布入口；历史 SHA 恢复必须走另行授权的恢复流程。发布链满足：

- `website-quality`、`node-minimum`、`diagrams` 和 `supply-chain` 对精确 `GITHUB_SHA` 运行各自发布必需门禁；任一 failure、cancelled 或 skipped 都阻止最终 job，禁止 `always()` 或 `continue-on-error` 绕过。D-099 后 `supply-chain` 的普通 CI 结论只来自失败关闭的静态供应链证据，live audit 保留给显式依赖准入/重准入，不属于生产 prerequisite。
- 非 matrix `production-artifact` 在 fresh runner 对同一 SHA 完整 checkout，使用 E-010 为本次 job 新建且不复用的私有 npm cache 冻结安装，并重新执行主端点的零依赖 `quality`、独立 E-013 历史入口、`typecheck`、`test` 与 production `build`，实际生成并重验唯一 production `build/`；它不下载或复用 `website-quality` 的 job-local build，不配置 `actions/setup-node` cache、不调用 cache restore/save Action、不读取任何共享或复用的依赖/build cache，也不接受 preview 或本地旧目录 fallback。
- 上述五个负载成功后立即按 CODE-015/CODE-019/CODE-020 将同一 `build/` 封装为 `payload/`，从同一 payload 路由和源注册表派生 `runtime-redirects.json`、`nginx/redirects.conf`，并附 source build tree、精确提交标识与逐文件 SHA-256 `metadata/`；独立复验后只上传一次精确 `dist/release/`。
- Artifact 展示名含 SHA、run ID 和 run attempt；deploy 只消费 `production-artifact` 输出的唯一 artifact ID、外层 `artifactDigest`、上传前独立计算且不写入 artifact 的 `releaseContentSha256`、repository、run 和 SHA，不按名称、pattern、latest、URL 或跨 run 查询。
- 四个 prerequisite 与 `production-artifact` 的 `GITHUB_TOKEN` 权限仅为 `contents: read`；`deploy-production` 仅为新鲜度和 artifact 元数据复核使用 `contents: read`、`actions: read`，未列权限全部为 `none`，禁止 write、OIDC/attestation scope 和 producer Secret。
- 使用 `production` environment 保存腾讯云部署凭证。`deploy-production` 在引用 CAM Secret 或调用腾讯云 API 前，先用只读 GitHub API 证明 canonical `refs/heads/main` 仍等于本次 SHA，并复核当前 run/artifact/head SHA/digest；失败立即停止。普通人工重跑不能发布旧 SHA，历史恢复必须使用另行授权流程。
- 顶层 CI 对非 `main` 保留旧 run 取消，但不得因后续 push 中断已经运行的 `main` 发布链；生产 job 使用固定 concurrency group 且 `cancel-in-progress: false`，任一时刻只允许一个生产发布。GitHub 不保证等待顺序且可能替换等待中的旧 run，因此 concurrency 不能替代上述 main HEAD 新鲜度检查。
- 将当前 `GITHUB_SHA` 作为唯一发布版本，不发布浮动的“最新 main”。
- 在调用 TAT 前核对 artifact 所属 workflow run、`head_sha` 与外层上传摘要，只向固定 command 分别传递 run/artifact 标识、SHA、`artifactDigest` 和 `releaseContentSha256`，不传递任意下载 URL、shell 片段或路径。
- `InvokeCommand` 返回 invocation ID 只表示调度已被接受，不是部署成功。#37 接线须在同一持有生产 concurrency 的 job 中有界查询精确 command/instance 的 invocation task，只有终态成功且服务器身份、摘要、账本与本机 smoke 结果匹配后，才继续从公网验证 canonical 首页和关键资源。
- 部署失败时 workflow 失败，不把失败提交标记为已发布。

GitHub environment 可以限制部署分支、保护 secrets 并控制并发。参考：[GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)、[GitHub Actions 部署控制](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)。

### TAT 与服务器侧

1. GitHub Actions 使用 `InvokeCommand` 请求执行已开启自定义参数的 `axialmuse-deploy` TAT command，并传入且只传入 `workflowRunId`、`artifactId`、40 位 `commitSha`、GitHub 上传输出的 `artifactDigest` 与上传前 job output `releaseContentSha256`；两个摘要均为不带算法前缀的 64 位小写十六进制且职责不同，不能共用字段。
2. root 持有的发布入口严格校验参数形态，并只访问脚本内固定的 GitHub owner/repository；不接受任意 URL、shell 片段、分支名或文件路径。
3. 服务器从已核验为 public 的 canonical 仓库读取 artifact 元数据且不携带仓库凭证，核对 workflow run、artifact ID、`head_sha` 和未过期状态；REST `digest` 必须精确等于 ASCII `sha256:` 拼接 TAT 的裸 `artifactDigest`，缺失、其他算法、重复前缀、大小写或长度异常均失败，不做宽松归一化。仓库可见性若发生变化必须重新授权，不自动切换到个人或私有仓库凭证。
4. artifact 下载到本次 root-owned、权限 `0700` 的 staging root 固定名、mode `0600` 的 `artifact.zip` 后，`/usr/bin/python3 -I -B` 运行固定 `verify_artifact.py`：先从同一 archive fd 计算裸 SHA-256 并精确核对 `artifactDigest`，再在标准库 ZIP 解析前有界核对 EOCD/ZIP64、成员数和 central directory，随后预扫并安全解包，拒绝绝对路径、父目录逃逸、链接、特殊文件、重复/大小写/前缀冲突、隐藏或非规范路径及非预期归档结构；按 CODE-020 稳定 wire format 从全部 release 普通文件独立重算并核对 artifact 外传入的 `releaseContentSha256`，最后核对内部逐文件 SHA-256 清单、payload/公开路由摘要、运行清单、Nginx 配置、规则数、metadata commit 与 TAT `commitSha`。服务器没有源 `redirects.json`，其摘要只由外传完整 release digest 绑定，不声称在服务器重算。全部通过后，以 `RENAME_NOREPLACE` 形成固定 `verified-release/` 并从正式路径重算整树；入口前已存在或竞态出现的同名对象必须原样保留并失败，本事务失败只清理身份仍可证明的候选/输出。服务器 verifier 与仓库 Node 实现是跨信任边界的两个实现，接线前必须通过 CODE-020 的同一组正向与 Unicode 漂移负面 vectors；服务器不得运行/导入仓库脚本，也不得用 artifact 内自报字段代替任一 TAT 期望值。
5. deploy 在排他锁内复核 `verified-release/` 的 inode 与完整树摘要后，才把 `payload/` 与两个已绑定的可部署派生文件安装到同文件系统临时 release 的 `payload/`、`config/`，校验入口、关键资源、301 source/target、文件权限和目录大小；root-owned 固定脚本只根据已验证 40 位 SHA 生成绝对 payload root 与同 SHA redirect include，不解析源码注册表，也不运行仓库脚本、Node/npm 或构建。
6. 候选在公开激活前用隔离的本机 Nginx 监听地址完成静态检查、全部 exact 301、唯一 `Location`、查询保留和目标 200 行为验证，不只运行 `nginx -t`。
7. 部署排他锁内读取 root-owned 暴露账本，对候选定义最多一步的路径解析：历史规范 200 路径必须仍可解析，每条历史 301 边的 source 与历史 target 必须收敛到同一当前 200。只有目标文件而没有历史 source 规则仍判定不兼容。
8. 候选的全部规范 200 路径，以及新增或改指后可能暴露的 registered 301 边，先并入候选账本；`canonical-slash` 不单独写入边账本，但其 canonical target 必须作为候选规范路由预写。激活前必须选出一个也满足更新后账本的 fallback release。不存在时默认拒绝发布；只有 production environment 的单独授权明确接受 forward-only，才允许在没有自动回滚的情况下继续。首次发布新 canonical URL 时，旧 release 通常没有该 target，因此通常属于此类 forward-only 激活。
9. 先以临时文件、flush 和原子 rename 持久化候选账本，再原子切换 `current`、运行 `nginx -t` 并 graceful reload。旧 worker 继续使用旧 SHA 的 payload/规则，新 worker 同时使用候选 SHA 的 payload/规则；账本预写后的失败不得删除记录来猜测规则尚未暴露。
10. 通过本机与公网冒烟后，核对预写账本摘要并完成 root-owned 备份和部署审计记录，随后才标记 deployment 成功；不得把候选规范路由延迟到冒烟后追加。任一验证或账本步骤失败，只能恢复预先选定的兼容 fallback；forward-only 发布则保持历史闭包并向前修复，不自动切回不兼容 release。
11. 返回 workflow run、artifact、部署 SHA、`artifactDigest`、`releaseContentSha256`、规则摘要、账本前后摘要、fallback/forward-only 结论和验证结果。

TAT 命令输出不得包含 SecretKey、artifact 读取凭证、证书私钥或腾讯云账号资料。TAT 执行历史不是 URL 暴露账本；`/var/lib/axialmuse/url-exposure-ledger.json` 保存服务器强制兼容的只追加事实，GitHub workflow run、artifact 元数据、deployment 与项目进度另行保留发布审计记录。

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

E-014 的 release 配置还在根域和 `www` 的 HTTP/HTTPS 已知主机中加载相同 exact-location 规则：登记旧路径及其无斜杠别名直接替换为最终 canonical 路径，活动页面无斜杠路径直接补成规范路径，全部固定返回 301 并保留查询参数。通用 scheme/host canonical 规则只写在兜底 `location /`，不能使用会在 location 搜索前执行的 server 级 `return`；因此 exact 旧路径可以一步到 `https://www.axialmuse.com<最终路径>`。ACME challenge 仍由专用 location 优先处理，重定向 schema 禁止 `/.well-known/` source。

主站请求期 Web Root 是活动 `site-release.conf` 中带精确 40 位 SHA 的 `/srv/axialmuse/releases/<sha>/payload`，同一配置只 include `/srv/axialmuse/releases/<sha>/config/redirects.conf`；`current` 仅在 Nginx 解析配置时选择版本。项目体验继续只读指向各自独立 release 边界。所有站点关闭目录列表并定义独立错误页，不从 Host 动态拼接磁盘路径。scheme/host 兜底保持当前规范化路径和查询；内容与尾斜杠规则按运行清单替换路径并保留查询，fragment 不会发送到服务器。

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

1. 完成服务器地域、系统、镜像、现有服务和续费盘点；服务器侧与腾讯云控制面基础字段已完成脱敏核验。
2. 核验 ICP 备案号、备案内容与腾讯云接入状态。
3. 创建系统盘快照；实例支持、配额、恢复入口和当前加固前快照成功状态已经确认，恢复或删除仍须另行授权。
4. 复核已提交的 D-119/D-120 SSH 策略，完成腾讯云账号、轻量与 OS 防火墙及系统更新策略的剩余加固。
5. 保留并验证现有 Nginx、TAT agent 与系统下载/归档/哈希/Python 工具，按独立授权安装 Certbot 和上述 verifier/golden；生产不安装 Node/npm，也不为主站准备源码 clone。
6. 由 #37 创建并验收生产 release/current/账本目录、root-owned 发布/回滚脚本、只追加 URL 暴露账本和固定 TAT command；#36 已记录这些目录当前不存在，远端 #36 关闭文字须先与该职责边界同步，不能以缺席冒充 owner/mode 通过。部署脚本必须整版安装 payload/config、生成精确 SHA 包装，并拒绝历史 source/target 不再收敛到同一 200 的回滚。canonical 仓库已核验为 public，服务器不配置 artifact 凭证。
7. 配置通过准入并固定 commit SHA 的 GitHub Actions、四个 prerequisite、E-015 `production-artifact`、`production` environment、最小 CAM 凭证与 deployment workflow；最终 job 不使用 environment/Secret，只有 deploy job 可以读取 CAM 凭证。
8. 先通过服务器公网 IP 的受控测试或临时 hosts 验证 Nginx；使用最小 release 覆盖 exact 301、查询保留、目标 200、ACME 和未知 Host，不提前公开未完成页面。
9. 保存 DNS 旧值，添加或修改 `@` 与 `www` A 记录。
10. 签发证书，验证四种 HTTP/HTTPS 主机名行为、同版本旧路径/尾斜杠 301 和未知 Host 拒绝策略。
11. 从 `main` 走两轮自动发布；先演练无新增永久边的兼容回滚，再证明“有历史 target 但缺 source 规则”的旧 release 会被拒绝，并分别验证有兼容 fallback 和经授权 forward-only 的恢复语义。
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

- 精确 `main` SHA 的冻结安装、质量、类型检查、Docusaurus build 和制品门禁通过；生产 release 的 workflow run、artifact ID、`head_sha`、摘要、内部清单、SHA 与 GitHub deployment 一致。
- `runtime-redirects.json`、`redirects.conf`、源注册表、公开路由集合和 payload 摘要属于同一 release；旧 URL 及其无斜杠别名为单跳 301，查询保留，目标返回 200，source 没有静态 HTML。
- 服务器没有主站源码 clone、Node/npm 或构建步骤，只从固定 GitHub 仓库接收已验证 artifact。
- 连续两次发布和一次兼容回滚均不产生 payload/规则半更新；暴露账本只追加且摘要可追溯，缺少历史 source 规则、让历史 target 失效或不再收敛到同一 200 的旧 release 不能被选为回滚目标。
- 每个项目可在不修改主站 symlink 的情况下独立发布与回滚。
- 桌面端和移动端实际截图验证通过。
- 生产允许索引，页面包含正确 canonical、站点地图与备案页脚。
- 未出现密钥、私人联系方式、占位成果或未发布能力承诺。

## 回滚与恢复

### 错误发布

发布脚本保留前一兼容版本，但“兼容”必须对暴露账本做完整路径解析，不是只检查目标文件。候选失败时，只能整版恢复使每个历史 published route 仍可解析、且每条历史边的 source/target 收敛到同一当前 200 的已验证 SHA；恢复后重新执行 `nginx -t`、graceful reload 和 HTTP 冒烟。候选新增 canonical 路径或新增、改指 registered 301 边后没有这样的 fallback 时默认不激活；如果经单独生产授权选择 forward-only，则暴露账本预写后不再删除记录或回到不兼容旧 release，只能从 Git 产生保持历史闭包的向前恢复 release。GitHub deployment 与项目进度记录失败原因、账本前后摘要、fallback/forward-only 结论和恢复方式。

### Nginx 或证书故障

配置变更前运行 `nginx -t` 并保留上一份配置。证书续期失败不删除仍有效证书；修复 ACME 或 DNS 后重新验证。只有系统级损坏且文件级恢复不可行时才回滚快照。

### 服务器故障

GitHub 保存源码、内容、workflow 记录和有效期内的 artifact，服务器只保存已验证 release。恢复顺序为：新建或恢复轻量实例、应用受控配置、重新签发证书、重新获取对应成功 workflow 的已验证 artifact 并发布、切换 DNS。artifact 已过期且对应 SHA 仍是 canonical `main` HEAD 时，只能由常规 GitHub Actions 对该 SHA 重新构建和验证，不能改由生产服务器构建；此路径和仍有有效 artifact 的路径以 4 小时为 M0 目标 RTO，RPO 为最近一个仍可按上述路径验证的成功生产提交。若 artifact 已过期且最后成功生产 SHA 已成为历史提交，E-015 会拒绝普通 rerun；该灾难恢复场景必须等待另行授权且尚未设计/实施的历史恢复流程，当前不承诺 4 小时 RTO，也不得为满足旧 RPO 绕过 main HEAD 门禁。

腾讯云快照可用于系统盘故障和错误操作回滚，但销毁实例会同时删除其快照，因此快照不能替代 Git 与配置真相源。参考：[管理快照](https://cloud.tencent.com/document/product/1207/48546/)。

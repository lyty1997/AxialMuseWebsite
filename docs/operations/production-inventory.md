# 生产环境清单

状态：inactive
最近更新：2026-08-03
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
| 实例地域 | 中国上海；用户于 2026-07-13 确认，并于 2026-07-30 人工核验同一目标实例、地域/镜像/规格和生命周期未发现阻断偏差 |
| 操作系统与版本 | Ubuntu Server 24.04 LTS 64bit；2026-07-29 通过严格主机密钥校验的 SSH 只读命令核验 |
| 镜像类型 | Ubuntu Server 系统镜像；用户于 2026-07-30 在控制台核验具体镜像与目标实例未发现阻断偏差，精确镜像标识不写入仓库 |
| CPU 与架构 | 2 个在线 CPU，Linux `x86_64` / Debian `amd64`；2026-07-29 服务器只读核验 |
| 内存 | 约 2 GiB；2026-07-29 服务器只读核验，只记录容量，尚无已批准资源阈值 |
| 系统盘 | 50 GB 块设备；2026-07-29 服务器只读核验，用户于 2026-07-30 在控制台复核资源规格未发现阻断偏差；实时使用率和精确控制面值保留在私密现场记录 |
| 当前用途 | 用户确认只读盘点发现的既有静态网页为此前部署且可删除；其专属配置和 Web Root 已于 2026-07-29 清理。主站源码、Node/npm、数据库、容器与其他应用内容未发现；额外管理身份和腾讯云代理的首启来源已经归因，用户选择本轮保留 TAT 与腾讯云代理，额外管理身份已按 D-118 完成可逆禁用 |
| 公网 IP | 不写入仓库，从腾讯云控制台与 DNS 查询 |
| 实例到期与自动续费 | 用户于 2026-07-30 人工核验未发现阻断偏差；精确值不写入仓库 |
| 快照能力与当前恢复点 | 用户于 2026-07-30 人工核验快照支持、配额与控制台恢复入口未发现阻断偏差，D-117 加固前快照保留为历史恢复点；2026-08-02 又为 D-122 已提交的当前加固态创建软件事务前系统盘快照，确认控制台终态正常且恢复通道可用。均未执行恢复演练，精确快照标识不写入仓库，恢复或删除未授权 |
| TAT agent | 目标机本地 agent 已核验为腾讯云组件且 active/enabled，无新增公网监听；用户于 2026-07-30 人工核验控制面 online 且无未知任务，并选择本轮保留 TAT 与腾讯云代理。D-129 新 boot 的脱敏诊断再次确认本地 `tat_agent.service` active/running/enabled；用户又在 D-130 人工确认当前腾讯云控制面正常。该人工确认与本机服务证据分开记录；精确版本、任务和服务姿态保留在私密现场记录 |
| Web 与 TLS 组件 | 既有旧静态站点经用户确认后已删除；D-124 当时的软件后验确认 Nginx 配置测试成功、active 且没有活动 server block 或 TCP 80/443 监听。Ubuntu 官方 Certbot CLI 与 timer 已安装并通过当时的独立后验，timer enabled/active/waiting；没有 ACME 账户、证书或 lineage，本轮未签发或读取证书。D-129 新 boot 的 diagnostic-only remainder 再次证明 Nginx/Certbot/监听当前语义门禁通过，但正式完整后验仍因 vendor/cross-reboot posture 契约 pending；精确版本与其他服务姿态不写入公开仓库 |
| SSH、账户与系统防火墙 | 额外交互账户已归因为首启用户数据创建，并于 2026-07-30 按 D-118 移除唯一受控直接 sudo 规则、设置账户过期和不可交互 shell，同时保留账户/home/密钥及其他文件。D-119/D-120 随后以可回退事务完成 root-owned SSH 全局策略，独立严格公钥会话与最终后验达到 `committed_clean`；既有管理身份、端口、主机密钥、主密钥文件和 sudo 路径未变。D-122 又在目标服务器提交并启用 UFW 最小 IPv4 入站边界，第二条严格 SSH、精确临时状态清理和重启前稳态均通过；D-128 随后把 normalized non-vendor 提交到 frozen oracle 并通过当时的 vendor 安全语义。D-129 唯一重启后，SSH unavailable→available、boot 改变、system running、non-vendor oracle、IPv6 vendor 缺席及防火墙双读稳定已经确认，但 IPv4 `YJ-FIREWALL-INPUT` 声明、引用和规则持续缺席，完整 post-reboot 保持 pending。详细身份、来源和规则正文不写入公开仓库 |
| 腾讯云入站边界 | 用户已手工允许任意 IPv4 来源访问 TCP 80/443；SSH 方案 A 删除额外来源后曾连续三次 TCP 22 建连超时，随后用户恢复此前三条受限云 SSH 规则集合。严格 SSH 恢复后，服务器连接元数据确认实际来源仍对应槽位 2，并与 OS UFW 唯一 SSH 来源规则匹配；用户之后在 D-129 前确认两个额外来源已经再次删除、云层只保留该同源单一 SSH 入口且不增加 IPv6 或其他入站。D-129 没有改写云规则；用户又在 D-130 人工确认当前腾讯云控制面正常，但本记录不自行展开为未逐项复述的精确规则值 |
| 软件与源码边界 | `/root`、`/home`、`/srv`、`/opt`、`/var/www` 与 `/usr/local` 未发现 Node/npm、容器运行时、主站源码 clone、`node_modules` 或 Node manifest；Git 及系统下载、归档、哈希工具已存在 |
| 系统更新 | 只读核验窗口内观察到当前管理身份另行发起并完成系统包升级，用户于 2026-07-30 确认是本人有意执行；关键服务与配置终态复核通过。Ubuntu 官方自动安全更新服务及两个 apt timer 已启用，未配置自动重启。D-124 于 2026-08-02 以单一事务精确升级 `distro-info-data`、`libssl-dev`、`libssl3t64`、`openssl`、`tzdata`、`tzdata-legacy` 六包，并新增七个 Certbot 最小包，零额外、零移除且未执行 `autoremove`；当时的独立软件后验通过。D-129 后来执行唯一维护重启并确认 boot 改变；diagnostic-only remainder 在同一新 boot 证明精确包、自动更新和 `reboot-required` 缺席等当前语义门禁通过，但 vendor/cross-reboot posture 正式契约仍 pending，也没有重新建立基线 |
| 生产目录 | 预期 `/srv/axialmuse` 与 `/var/lib/axialmuse` 现场不存在，该缺席是 #36 的只读基线证据；release/current/账本目录的创建与 owner/mode 验收仍归 #37，远端 #36 关闭文字须先与此边界同步 |
| Web Root | 目标：活动 `site-release.conf` 中 `/srv/axialmuse/releases/<sha>/payload` 的精确绝对路径；`current` 只在配置解析时选代 |
| 生产分支 | `main` |
| 发布方式 | 目标：GitHub Actions 构建不可变 artifact -> 腾讯云 TAT 受限交付 -> 校验后原子 release；尚未实施 |
| 构建位置 | 目标：仅 GitHub Actions 构建；PR/`main` 的 `website-quality` 与 release-eligible `production-artifact` 各自在独立 runner 构建，只有后者对 `main` 精确 SHA fresh rebuild + full quality 的 build 可部署；生产服务器不构建 |
| Build command | 仓库已实现 `build`、`package:artifact` 与 `check:artifact`；后两者复用冻结依赖中的 production checker，并完成确定性封装及外部 `releaseContentSha256` 复验。#14 已由本地提交 `7b5cc47` 把完整顺序接入四个 prerequisite 之后的 `production-artifact` job，但尚无 canonical `main` 真实运行 |
| Output directory | Docusaurus production 输出为默认 `build/`，#33 的临时交付根为 `dist/release/`；`dist/` 不提交。仓库仍保留迁移前 `public/`，目标机旧静态 Web Root 已删除，尚未部署 Docusaurus release |
| Artifact 身份 | 仓库侧已实现 40 位提交 SHA、source build tree、内部清单与 artifact 外 `releaseContentSha256`；#14 本地提交在 upload 前形成 build/release 操作 seal，upload 后复核同一 seal、HEAD blob 与默认 index 状态后，才映射 canonical repository、workflow run ID/attempt、artifact ID 和 GitHub 外层 `artifactDigest` 七项 outputs，展示名不用于选择。由于尚未发生真实 upload，这些 GitHub 服务端身份没有实际值 |
| Artifact 内容 | #33 已实现 `payload/`（已重验 `build/` 的逐文件复制）与 `metadata/`（source build tree、提交标识、release manifest、逐文件 SHA-256、运行重定向清单和 Nginx exact-location 配置）的本地确定性生成与复验；尚无已上传 production artifact |
| 服务器 artifact 校验器 | #35 已由本地提交 `f7fdc43` 实现只使用 Python 3.12 标准库的 `ops/deploy/verify_artifact.py` 与 Node/Python 共享 golden；#36 工作区另有一次性 root bootstrap 候选，但两者都尚未进入 canonical `main`，本地负向验收不等于服务器安装。2026-07-29 已现场确认 `/usr/bin/python3` 为 root-owned 链接并精确解析到兼容的 root-owned Python 3.12；安装目标固定为 `/usr/local/lib/axialmuse/artifact-verifier/` 的 root-owned verifier/golden，bootstrap 只作经摘要认证的瞬时执行器，不安装自身。须待 bootstrap、verifier 与 golden 同一源提交进入 canonical `main`，再以精确提交和三项摘要完成独立认证并取得现场安装授权；#14 真实 ZIP shape 复验仍待 |
| 跨 job build 边界 | E-015 固定不上传或下载中间 build artifact；`production-artifact` 在 fresh runner 自包含重建、重验和封装，避免消费其他 job 文件系统 |
| 发布新鲜度 | #34 已由本地提交 `2c40e87` 在活动 workflow 外实现七项 producer outputs、当前 GitHub context、canonical main/run/artifact/head/digest 的两次 main 交叉核验，以及 main 不取消/生产串行的静态 concurrency 候选；尚未接入真实 workflow/API，concurrency 仍不替代新鲜度 |
| Workflow token | prerequisite 与 #14 producer 的 `contents: read` 已由本地提交 `7b5cc47` 配置，其他 producer scope 为 `none`；#34 本地提交 `2c40e87` 的静态 deploy fixture 只允许 `contents: read`、`actions: read`，但尚未写入活动 workflow 或真实 environment |
| TAT 调度 | #34 已实现固定 `ap-shanghai`、单 command/instance、五参数 `InvokeCommand` 的 TC3 签名与 dry-run；成功 `status: dispatched` 只记录 invocation ID，不表示 task/部署成功。实际 command/instance、CAM、environment 与 #37 终态查询均未接线 |
| Artifact 读取 | 2026-07-29 已只读确认 canonical 仓库为 public、未归档且默认分支为 `main`，当前路径无需服务器 artifact 凭证；GitHub environment protection 的方案能力仍待活动接线前核验 |
| 服务器发布职责 | #35 只负责从私有 staging 校验外层 `artifactDigest`、安全解包、从 exact release 独立重算 `releaseContentSha256`，并交叉校验元数据、清单、运行规则与提交身份，成功形成 `verified-release`。#37 才在部署锁内复核后安装同 SHA payload/运行清单/Nginx 配置至不可变 release，用 URL 暴露账本验证历史闭包，生成精确 SHA root/include，执行隔离候选测试、`nginx -t`、reload、逐规则冒烟和受控恢复；两者均尚未部署 |
| 活动重定向身份 | #33 的 release metadata 已实现源注册表摘要、公开路由摘要、运行清单摘要、Nginx 配置摘要和规则数；当前尚无已部署活动 release |
| URL 暴露账本 | 目标：`/var/lib/axialmuse/url-exposure-ledger.json`；每次 reload 前只追加候选的全部规范 200 路径和新增或改指的 registered 301 边，`canonical-slash` 不入边账本但 target 由路由预写保护；记录每次 deployment 前后摘要并由 root-owned 备份保护，当前未创建 |
| 回滚兼容谓词 | 目标：每个历史 published route 仍可解析，每条历史 301 边的 source/target 收敛到同一当前 200；只有目标文件但缺少 source 规则不算兼容 |
| 服务器主站工具边界 | 不安装 Node/npm，不拉取主站源码，不从源码 checkout 执行脚本或构建；2026-07-29 对登录 home、`/srv`、`/opt`、`/var/www` 与 `/usr/local` 的只读扫描未发现 Node/npm、源码 clone、`node_modules` 或 Node manifest |

### #36 第一阶段服务器只读核验

2026-07-29 经用户授权，只通过已核对主机密钥的 SSH alias 执行非交互、脱敏的服务器侧只读盘点；所有特权读取均使用 `sudo -n`。D-113 的 Agent 探针本身没有安装、升级、删除或编辑软件与文件，没有改变用户、SSH、防火墙、systemd、Nginx、TAT、DNS、TLS 或云资源，也没有运行部署、artifact 校验或 HTTP 冒烟；随后 D-114 另行授权并完成了上文记录的旧静态站点定向清理与 Nginx reload，不扩大到其他状态。继续核验时观察到当前管理身份另行发起的系统包升级已经完成；该动作不属于 D-113 探针或授权，用户后来按 D-115 确认升级是本人有意执行。具体命令、逐项状态和当前安全姿态只保留在私密现场记录；公开仓库不使用复合 SSH 入口的整体退出码替代每个探针的独立证据。

| 核验域 | 公开结论 |
|---|---|
| 系统、架构与资源 | Ubuntu 24.04、`x86_64` / `amd64` 与用户提供的系统基线一致；资源值已记录，控制面实例、规格与生命周期人工核验未发现阻断偏差 |
| 监听、进程、软件与源码边界 | 监听均已映射到本机进程；旧静态网页已由所有者确认并删除，腾讯云代理的本机来源已归因且用户选择本轮保留；Node/npm、数据库、容器、开发服务和主站源码未发现 |
| SSH、管理身份与双层防火墙 | 额外交互身份的创建来源和闲置状态已经查明，D-118 可逆禁用及独立后验已经完成；D-119/D-120 SSH 全局策略已通过两条独立严格公钥会话和最终后验并达到 `committed_clean`。D-122 OS UFW 已按最小 IPv4 边界提交，第二条严格 SSH、提交状态清理及重启前稳态均通过；D-128 component-aware transition 又以 `status=complete outcome=committed` 完成。D-129 唯一重启后，严格 SSH unavailable→available、boot 改变、system running、normalized non-vendor oracle 与防火墙双读稳定已经确认；IPv4 YJ 链声明、引用和规则持续缺席，完整 post-reboot 因而 pending。云层 TCP 80/443 和单一 SSH 来源是重启前最后由用户确认的精确规则事实；用户在 D-130 又人工确认当前腾讯云控制面正常。精确地址、端口与规则正文只保留在私密现场记录 |
| Web、TLS、TAT 与系统运行时 | 旧静态站点已删除；D-124 当时的独立软件后验证明无未知非本地 TCP 监听、Nginx/TAT active、failed unit 为零，Ubuntu 官方 Certbot 七包、CLI/timer 和无 ACME 状态通过。D-129 新 boot 的 diagnostic-only remainder 又在两条间隔 10 秒的新会话中一致证明 Nginx、Certbot、监听、failed units 与本地 TAT 当前语义门禁通过；原正式完整后验仍因 vendor/cross-reboot posture 契约 pending。用户已在 D-130 人工确认当前腾讯云控制面正常，但新 formal receipt 尚未形成。Python 3.12 前置运行时已盘点；verifier bootstrap 只有工作区候选，没有现场安装证据 |
| 系统补丁与重启 | 最近系统包升级后的关键服务和配置复核通过，用户确认升级是本人有意执行；D-117 降为历史恢复点，当前 D-122 加固态软件事务前快照已确认正常且恢复通道可用。Ubuntu 官方自动安全更新服务和两个 apt timer 已启用，未配置自动重启；D-124 精确六包升级与七包新增及当时的独立软件后验已经完成。D-129 的唯一维护重启已经执行，SSH unavailable→available、boot identity 改变和同一新 boot system running 已确认；正式 post 在 vendor declaration predicate 失败，结果保持 `post-reboot-pending`。diagnostic-only remainder 证明 `reboot-required` 缺席、包/自动更新及其余当前语义门禁通过，但重启前后聚合 posture 摘要不等；未重新建立基线，也未第二次重启 |
| 当前恢复点 | 用户确认 D-122 加固态软件事务前系统盘快照在腾讯云控制台为正常，控制台或 TAT 恢复通道可用；未执行恢复演练，恢复或删除仍须另行授权 |
| D-125/D-126/D-128/D-129/D-130 证据与重启门禁 | D-125 正式隔离重建回执按当时 schema 继续保留 `environmental_inconclusive`；TEST-NET 重放支持 initial-enable 到 persisted reload/cold-start 时序作为 103/105 差异的强结构候选。D-126 以唯一一次获准的服务器只读语义变换探针得到 `status=complete oracleMatch=true`，只证明 transition 前的当前内容关系；D-128 在独立授权下执行 component-aware transition 并得到 `status=complete outcome=committed`。D-129 又在独立授权下只执行一次重启；授权已消费，结果因 vendor declaration predicate 不满足而保持 pending。D-130 只新建只读逐组件语义验收源码/契约，已本地审计但 formal 尚未执行，不改写 D-129。上述结果均不追溯证明历史因果；任何第二次重启、服务恢复、再基线、verifier、云规则变更或 #37 都须另行授权 |
| 腾讯云控制面 | 用户于 2026-07-30 提供脱敏逐项结论：实例/生命周期、快照能力/配额、恢复入口、TAT/任务、代理保留和账号保护未发现阻断偏差；2026-08-02 确认 Web IPv4 入站已开放。方案 A 删除额外 SSH 来源并失联后，用户曾恢复此前三条受限规则集合；严格 SSH 成功，服务器实际来源仍是槽位 2 且与 OS UFW 唯一 SSH 来源匹配。用户之后在 D-129 前确认两个额外来源已再次删除、云层只保留该同源单一 SSH 入口；D-128/D-129 没有修改云规则。用户在 D-130 又人工确认按当前主机侧证据未发现问题，且当前腾讯云控制面正常；该结论不是 Agent 从本机进程独立推导的控制面证明。另有一条历史出带宽告警无法确定归因；用户按 D-116 接受仅限该单次告警的残余不确定性，未来复发或持续异常仍重新失败关闭 |

第一阶段结论仍为 **GAP / 失败关闭**，不是 #36 完成证据。旧静态站点、控制面基础核验、当前 D-122 加固态恢复点、额外管理身份的可逆禁用、D-119/D-120 SSH 全局策略、D-122 OS 防火墙重启前稳态、云 Web 入站，以及 D-124 精确软件事务和当时的独立后验已经收敛，TAT 与腾讯云代理按用户决定保留。D-125 正式隔离重建结果为 `environmental_inconclusive`；D-126 只读探针关闭 transition 前的当前内容关系，D-128 唯一正式 component-aware transition 得到 `status=complete outcome=committed`。D-129 随后只执行一次维护重启，确认 SSH unavailable→available、boot 改变和 system running；完整 post-reboot 因 IPv4 YJ vendor 声明、引用和规则缺席而保持 `post-reboot-pending`。用户在 D-130 人工确认当前主机侧无已知问题且腾讯云控制面正常，新只读逐组件源码/契约已本地审计，但 formal receipt 尚未形成。没有第二次重启、UFW reload/再基线、手工补链、腾讯服务重启、云规则或快照操作。#36 仍失败关闭于 D-130 receipt 和 canonical `main` 前置满足后的 verifier 安装；任何恢复、再次重启以及 #37 均须新的明确授权。

在上述正式回执之后，D-125 又开展了不连接服务器、不读取真实配置或使用真实地址的 TEST-NET 补充重放。UFW 0.36.2 源码顺序与非敏感等价配置连续两次复现 initial-enable 103、reload 105：首次 `enable` 先加载当时没有 IPv6 用户规则的 `user6.rules`，logging 随后才把两个标准 IPv6 rate-limit 终止规则写入持久配置，后续 reload/cold-start 才加载它们。等价配置中 IPv4 投影不变、IPv6 只新增这两个规则，IPv6 user input/output/forward 为空，且没有 jump/goto 进入对应 limit 链，因此新增规则在该等价配置下不可达。这只支持首次启用时序作为当前 103/105 mismatch 的强结构候选；重放结果与正式回执仅完成逐链数量绑定，不能证明真实规则内容 exact 一致。现有冻结 transaction/evidence 已按契约清理真实输入，仅余不可逆 hash/摘要，无法再恢复输入完成本机 exact 重放；该路径已经失败关闭，正式 `environmental_inconclusive` 和最早 full-live 摘要的组件缺失残余继续保留。D-126 随后执行了唯一一次获准的只读语义变换探针并返回 `status=complete oracleMatch=true`，闭合当前规范化 non-vendor 与冻结 oracle 的两规则变换关系；它没有传出配置、规则或摘要值，也没有写服务器。用户在 D-128 接受历史不确定性后另行授权并完成 component-aware transition，结果为 `status=complete outcome=committed`；该结果仍不追溯证明历史因果。D-129 后来执行唯一维护重启，原 formal 永久保持 `post-reboot-pending`；当前后续服务器动作须另行授权执行 D-130 formal 并形成 receipt，再按 canonical `main` 前置决定 verifier 安装。

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
| SSH 全局策略 | D-119/D-120 已由两条全新的严格公钥专用会话复核管理身份、`sudo -n`、服务、配置树与全部有效值，事务终态为 `committed_clean` | 2026-07-30 | 脱敏现场验收；不记录主机、账号、IP、指纹或密钥摘要 |
| OS 防火墙 | D-122 已提交 UFW 最小 IPv4 入站边界，完成第二条严格 SSH、事务临时状态精确清理及重启前稳态验收；D-122 验收时，既有腾讯 YJ 链相较该事务写入前保持不变 | 2026-08-01 | 脱敏现场验收；开发机本地 UFW 与腾讯云控制面均未操作 |
| 软件与 Certbot 基线 | D-124 精确完成六包升级与七包新增，零额外、零移除；独立软件后验确认全部十三包、APT 标记、Certbot CLI/官方 timer、无 ACME 状态及既有 SSH/UFW/YJ/Nginx/TAT/监听边界 | 2026-08-02 | 该回执形成时尚未重启、签发证书或安装 verifier；D-129 diagnostic remainder 已通过当前软件语义门禁，D-129 原 formal 保持 pending，D-130 formal receipt 未形成 |
| 云 SSH 管理通道 | 用户在 D-129 前确认此前恢复的两个额外来源已再次删除；当时云层只保留与 OS UFW 唯一 SSH 来源规则匹配的同源管理入口 | 2026-08-03 | D-128 formal 前后的严格 SSH 与 sudo 后验通过；D-129 未修改云规则，用户在 D-130 又人工确认当前腾讯云控制面正常 |
| D-125 UFW 隔离重建 | `enable`、`reload`、`cold-start` 各两次均完成且稳定；三模式归一化规则投影一致，结构计数仅重建侧 IPv6 规则数多 2，但精确归一化规则摘要不匹配，结论为 `environmental_inconclusive` | 2026-08-02 | 取证前后现场归一化投影与 config/package/boot 摘要组相同；随机容器与本地临时敏感配置副本按契约清理。未写服务器、未 reload、未重启、未重新建立基线；敏感转移授权已消费 |
| D-125 TEST-NET 补充候选 | UFW 源码顺序和非敏感等价重放支持 initial-enable 时序作为 103/105 差异的强结构候选；等价配置中 IPv6 只新增两个标准 limit 终止规则，且在无 IPv6 用户规则配置下不可达 | 2026-08-02 | 未连接服务器或读取真实配置；与正式回执仅有逐链数量绑定。冻结证据不含可恢复真实输入且 hash 不可逆，本机 exact 重放已失败关闭；正式回执继续为 `environmental_inconclusive`。后续 D-126 已完成当前内容关系探针 |
| D-126 一次性只读语义变换探针 | `status=complete oracleMatch=true`；当前规范化 non-vendor 投影加入两条公开标准 IPv6 rate-limit 终止规则后精确等于冻结 oracle | 2026-08-02 | 授权已消费；未写服务器、reload、重启或重新建立基线。仅证明当前内容关系，不证明历史因果，也不授权 transition、verifier、云规则变更或 #37 |
| D-128 component-aware transition | `status=complete outcome=committed`；一次受 watchdog 保护的 runtime transition 已提交，normalized non-vendor、vendor 安全语义、UFW、严格 SSH/sudo、服务、监听、配置、包、boot 与零 failed unit 后验通过 | 2026-08-03 | 授权已消费且 cleanup complete；D-125 历史结论不变。未重启、再基线、修改云规则、安装 verifier 或进入 #37 |
| D-129 唯一维护重启与 post-reboot | 唯一重启已执行；SSH unavailable→available、boot 改变和 system running 已确认。正式 post 与一次同 boot resume 均失败于 `remote-vendor-declaration`；多次诊断证明 non-vendor oracle、IPv6 vendor 缺席和双读稳定，但 IPv4 YJ 声明、引用及规则持续缺席。diagnostic-only remainder 以两条间隔 10 秒的新会话通过其余当前语义门禁，重启前后聚合 posture 摘要不等 | 2026-08-03 | 一次性授权已消费，结果保持 `post-reboot-pending` 且 `formalAccepted=false`；未第二次重启、reload/再基线、手工补链、重启腾讯服务或修改云控制面 |
| D-130 只读逐组件 semantic acceptance | 用户确认当前主机侧无已知问题且腾讯云控制面正常；新契约只接受 vendor `fully_absent` 或原严格 `rejecting` 完整态，保留其余逐组件门禁，并把旧 pre/post 聚合不等显式记为 `accepted_residual_unattributed` | 2026-08-03 | 源码、schema 与 partial/换态、systemd 范围、live binding 等反例已通过本地审计；未连接服务器执行 formal，未生成 receipt，不改写 D-129 |
| 生产冒烟 | 未执行 | - | - |
| 桌面端渲染 | 未执行 | - | - |
| 移动端渲染 | 未执行 | - | - |
| 恢复演练 | 未执行 | - | - |

## 变更记录

| 日期 | 变更 | 原因 | 验证 |
|---|---|---|---|
| 2026-08-03 | 按 D-130 固定新的只读逐组件 semantic acceptance 源码与证据契约 | 在保留 D-129 失败历史的同时，以当前逐组件事实验收完整 vendor 状态，并显式接受旧聚合摘要不可再分解的残余 | 所有者人工确认当前主机侧无已知问题且腾讯云控制面正常；源码、schema、live binding、systemd 范围及 vendor partial/换态反例通过本地审计。未连接服务器、未执行 formal、未生成 receipt，也未改写 D-129 或实施任何服务器/云/Git 写操作 |
| 2026-08-03 | 按 D-129 执行唯一维护重启并失败关闭完整 post-reboot | 在 D-128 committed 后验证 OS、软件、服务与双层防火墙跨重启稳态 | fresh preflight 通过后授权永久消费，只发送一次重启；SSH unavailable→available、boot 改变和 system running 已确认。正式 post 与同 boot resume 在 vendor declaration predicate 失败，本地结果保持 pending；diagnostic-only remainder 又在两条间隔 10 秒的新会话中通过其余当前语义门禁，但跨重启 posture 摘要不等且不构成 formal acceptance。未第二次重启、reload、再基线、服务恢复、云规则或快照操作 |
| 2026-08-03 | 按 D-128 完成唯一一次获准的 component-aware transition | 在接受 D-125 历史因果不确定性且云层已为单一 SSH 来源的边界内，把当前 normalized non-vendor 从 frozen current 受控变换到 D-126 已认证的 frozen oracle | 正式结果为 `status=complete outcome=committed`；consumed/result 绑定一致，授权已消费且 cleanup complete。UFW、vendor 语义、严格 SSH/sudo、服务、监听、配置、包、boot 与零 failed unit 后验通过；未重启、再基线、修改云规则、安装 verifier 或进入 #37 |
| 2026-08-02 | 按 D-126 完成唯一一次获准的服务器只读语义变换探针 | 在不传出真实配置、规则或摘要值且不写服务器的边界内，判定当前规范化 non-vendor 投影加两条公开标准规则是否命中冻结 oracle | 固定输出为 `status=complete oracleMatch=true`，授权随一次性消费点永久消费。结果仅证明当前内容关系，不改写 D-125 历史 `environmental_inconclusive`，也不授权 transition、重启、reload、重新建立基线、verifier、云规则变更或 #37 |
| 2026-08-02 | 开展 D-125 的 TEST-NET 非敏感时序候选重放 | 判断正式回执中 103/105 mismatch 是否存在可复现的 UFW 生命周期结构候选，同时避免无依据扩大敏感配置处理 | UFW 0.36.2 源码审计与等价配置候选入口连续两次复现 initial-enable 103、reload 105，IPv4 投影不变且 IPv6 只新增两个标准 rate-limit 终止规则；IPv6 用户规则为空且无 jump/goto 进入 limit 链，故新增规则在等价配置中不可达。它与正式回执仅有逐链数量绑定，不能证明真实规则内容 exact 一致；冻结 transaction/evidence 不含可恢复真实输入，hash 不可逆，本机 exact 重放已经失败关闭。正式 `environmental_inconclusive` 与最早 full-hash 组件证据缺失残余继续保留；该证据缺口随后进入 D-126 当前内容关系探针 |
| 2026-08-02 | 按 D-125 完成一次获准的正式 UFW 隔离重建取证 | 在不写服务器、不 reload、不重启且不重新建立基线的边界内，尝试判定恢复 SSH 后的现场归一化摘要差异能否由冻结环境重建解释 | 固定、无网络、只读根且仅授予 `NET_ADMIN` 的本地容器对三个 UFW 路径各运行两次；六次均完成且稳定，三模式归一化规则投影一致。结构计数的唯一差值是重建侧 IPv6 规则数多 2，但精确归一化规则摘要不匹配，结果为 `environmental_inconclusive`；不能证明服务器漂移或差异唯一来自环境。前后现场归一化投影及 config/package/boot 摘要组相同；随机容器和本地临时敏感配置副本按契约清理。本次敏感转移授权已经消费，后续由 D-126 继续核验当前内容关系 |
| 2026-08-02 | 恢复此前三条受限云 SSH 规则集合，并暂停单来源再次收敛 | 方案 A 删除额外来源后管理通道失联；恢复后又发现完整软件稳态的最终 `live-hash` 与旧证据不一致 | 严格 SSH 成功，服务器实际来源仍对应槽位 2 并匹配 OS UFW 唯一规则。完整 `post-software` 失败于最终 `live-hash`；随后冻结 capture 证明配置、包与 boot 摘要一致，脱敏投影多次稳定且 vendor 的 28 条规则全部为 `REJECT`，但旧证据缺少 vendor/nonvendor 分量，不能严格归因。未执行重启、服务器写操作或 UFW/云规则再改；该证据缺口随后进入 D-125/D-126，云单来源、重启、verifier 与 #37 继续等待 component-aware transition 决定 |
| 2026-08-02 | 用户按云方案 A 删除额外 SSH 来源后，管理通道门禁重新打开 | 删除后连续三次严格 SSH 都在 TCP 22 建连阶段超时，无法证明保留规则仍对应当前开发机出口 | 三次探针均未建立会话、执行服务器命令或触发维护重启。先恢复最后已知可用的受限云规则集合，或精确加入当前开发机实际公网 IPv4；严格 SSH 恢复后从服务器连接元数据识别来源、复跑 `post-software` 并重新收敛单来源。在此之前禁止维护重启、verifier 安装和 #37 |
| 2026-08-02 | 按 D-124 完成六包升级、七包 Certbot 最小安装及独立软件后验 | 在维护重启前把已批准补丁与 ACME 客户端基线收敛为精确、可复核的软件状态 | 最终写前模拟与实际事务均为六升级、七新增、零额外、零移除，未执行 `autoremove`；journald-only 一次性 systemd 单元成功，root 回执提交后由独立 verifier 复核完整 dpkg/auto 状态、Certbot CLI/timer、无 ACME 状态和原有服务/网络边界。未重启、未请求证书、未改 DNS/Nginx/SSH/UFW/TAT |
| 2026-08-01 | 按 D-122 完成目标服务器 UFW 事务、提交后临时状态清理和重启前稳态 | 在保留现有管理通道及腾讯云代理链的前提下，把 OS 入站面收敛为 SSH 单来源与 IPv4 Web 80/443 | 失败尝试均在提交前回滚或经精确闭包恢复；最终事务由第二条全新严格公钥会话通过后提交，专用清理只删除本事务的两个运行时 marker 和 33 个状态成员，随后 SSH、sudo、UFW 双栈默认/规则、YJ 链、Nginx、TAT、监听、包状态和零 failed unit 后验通过。未操作开发机本地 UFW 或腾讯云控制面 |
| 2026-07-30 | 按 D-119/D-120 完成 SSH 全局策略与唯一 `AuthorizedKeysFile .ssh/authorized_keys` 的可回退加固 | 移除密码、键盘交互、空密码、root 登录和未使用 legacy key path 的认证面，同时保持现有管理通道身份 | 前三次均在持久提交点前因 reload 状态尚未收敛而由 300 秒 watchdog 恢复并确认 `baseline_clean`；第四次以不放宽 daemon 身份和服务健康断言的有界收敛门禁通过，随后完成两条独立严格公钥会话、sudo、配置树和完整策略后验，原子同步 canonical drop-in、取消 watchdog 并清理私有状态，终态 `committed_clean` |
| 2026-07-30 | 以可回退事务完成额外高权限交互身份的可逆禁用 | 该首启身份未发现活动用途，继续保留直接管理能力会扩大生产管理面 | D-118 在快照正常后获得精确执行授权；唯一候选、活动引用、业务所有权、特权组和 sudo 图前置门禁通过，移除唯一受控直接 sudo 规则并设置账户过期/不可交互 shell；独立 SSH 在提交窗口验证当前管理 sudo、`sshd -t`、非目标配置和运行时后提交，回执与最终脱敏后验通过，账户/home/密钥/其他文件保留且 home 摘要未变，私有回滚材料已清理 |
| 2026-07-30 | 创建升级及旧站清理后的当前加固前系统盘快照 | 为账户、SSH、OS 防火墙和补丁重启建立受控回退基线 | 用户确认腾讯云控制台终态成功/正常；仅闭合快照存在与状态，未执行恢复演练，也未授权恢复、删除或其他服务器/云写操作 |
| 2026-07-30 | 按 D-116 接受单次历史出带宽告警的残余不确定性 | 现有证据无法逐进程归因，但已排除有意包升级和随后发生的旧站清理，补充内网监控只显示短时入向峰值后恢复，当前无持续异常或未知公网/Web 监听 | 仅解除该既有告警对 #36 的阻断；未来复发、持续高流量、新未知监听/进程或新控制面异常仍重新失败关闭，未授权任何云或服务器写操作 |
| 2026-07-29 | 继续完成 #36 的账户/云代理来源归因和包升级后只读终态复核 | 收敛第一阶段未知身份/进程，并发现核验窗口内独立发生的系统包状态变化 | 额外交互账户归因为首启用户数据，腾讯云代理归因为 cloud-init/Tencent 本地组件且无新增公网监听；升级后 SSH/Nginx/TAT 与 systemd 终态通过，但系统要求重启。精确身份、安全和包值只留私密记录；操作意图、控制面、快照、加固、安装和重启仍暂停 |
| 2026-07-29 | 按 D-114 删除用户确认废弃的旧静态站点、专属 Nginx 配置和启用链接 | 清除 #36 盘点发现且已由所有者确认无须保留的既有内容，同时不扩大到 Nginx 软件、父目录或其他系统状态 | 前置对象、引用和树边界复核通过；`nginx -t`、reload 与独立终态复核通过，三个目标均不存在，父目录保留且为空，Nginx active、server block 为零、TCP 80/443 无监听。首次入口因把父目录链接计数的预期减一误判为漂移而在删除后非零，未重复删除，改由独立只读命令确认真实成功状态 |
| 2026-07-29 | 完成 #36 第一阶段服务器侧只读现场盘点并记录非敏感结果 | 在任何快照、加固或部署前核对空机、系统、监听、身份、软件与运行时基线 | 严格 host key SSH、`sudo -n` 只读命令和脱敏投影均完成；OS/架构与 Node/npm/源码缺席符合预期，但既有未归因服务与文件、管理身份及安全基线存在阻断偏差，云控制面事实仍未核验，未执行任何服务器或云写操作 |
| 2026-07-29 | 在活动 workflow 外实现 #34 deploy 身份/main 新鲜度、无 Secret 预检、受限 TAT dispatch 与并发静态候选 | 让旧 run、main 漂移或 artifact 身份不匹配在 CAM Secret/Tencent API 前失败，并为 #37 提供 invocation 接口 | 28/28 定向合成 fixture、固定 Node 24.18.0 完整 quality、JavaScript 语法和差异检查通过；没有真实 GitHub API、Secret、TAT invocation、task 终态或生产部署证据 |
| 2026-07-29 | 按 D-110 由本地提交 `7b5cc47` 接入 canonical `main` push 的 fresh `production-artifact`、固定完整 SHA 的官方 upload Action、单次精确上传和七项校验后 outputs | 闭合 E-015/CODE-020 的最终 build 字节所有权，并为 #34/#35 提供明确的 artifact 身份边界 | 本地静态与合成 fixture 契约已通过；提交尚未推送，且没有 canonical `main` 真实 run、upload、artifact ID/digest、可下载 ZIP、required checks 或 Issue 关闭证据 |
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

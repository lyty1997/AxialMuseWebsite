# 公网 HTTPS 候选与验收清单

状态：D-166/D-167 的公网 HTTPS、固定发布入口和真实续期演练已验收；以下历史候选、失败与授权清单保留，实际状态以本节执行回执为准。本地收尾尚未追加 Git 发布。
最近更新：2026-10-25
适用范围：#39 双域名 Nginx、ACME、CSP 与本地验收；#38 DNSSEC 后续独立收尾。

2026-10-27 本地兼容修复同步将续期 hook 的 Python 导入根改为 `/usr/local/lib/axialmuse-release`，与发布组件保持一致；现有 hook 尚未迁移。安装目录、TAT 模板变化及受控迁移前置见[命名空间修复候选](production-deploy-setup.md#2026-10-27-命名空间修复候选尚未安装)。历史公网/续期回执不构成本次候选的生产安装证据。

## 2026-10-25 执行回执（仅本地收尾，未追加发布）

最终公网入口为 `https://www.axialmuse.com/`。唯一一次正式签发 exit 0，公开叶证书 SHA-256 为 `215ddd80bfef1ebf99fd5f823716a2d0d578690621a92cac07726bf898f423d0`，到期为 `2027-01-23 13:33:10 UTC`。HTTPS 启用、一次精确身份 prepared 发布和一次 `certbot renew --cert-name axialmuse.com --dry-run --run-deploy-hooks --no-eff-email --config /etc/axialmuse/certbot-contact.ini` 全部成功。续期含 Certbot 自带约 196 秒随机等待，没有第二次调用；本轮新增唯一 root-only hook 成功回执的时间、current、账本和实际加载证书均独立匹配。

续期后最终公网复核：系统信任链与双 SAN 验证通过，14 个 payload 哈希匹配独立下载且由 verifier 完整校验的真实 ZIP；37 个 HTTP 请求覆盖四主机、14 个单跳 301、查询保留、200/404、未知 Host 421 和未知 SNI 拒绝。CSP/安全头、九个指纹资源缓存、MIME、gzip/Vary 与 Range 206 通过，HSTS 关闭，无 Set-Cookie。Chrome 三页 hydration 与客户端跳转通过，29 个请求无外部来源尝试、CSP 违规或浏览器错误；使用系统信任，无 hosts 或证书例外。

最终新 SSH 独立验收：八个组件、十一个未变组件与五份旧入口备份摘要通过；活动 Nginx 七个 include 均来自已知基础配置和精确当前 release。current 仍为 `2cf04ee`，六个事务全部 local-accepted，账本摘要、chain 和两项历史未变。Nginx 与 Certbot timer active/enabled，仅 IPv4 80/443 与本机 18080，没有候选监听残留；四条 UFW 规则完整解析，公网 SSH 未开放，boot 未变，failed unit 为冻结集合的稳定子集。systemd journal 独立计数七次 reload，保守预算预留八次，未使用 prepared 的可选兼容恢复。bootstrap 原件和全部失败记录保留，合成探针已精确移除。

本轮实际为一次新增 TAT、一次正式签发、一次 prepared 发布、一次续期 dry-run、七次 reload，均在 D-166/D-167 范围内。[完整关闭证据](https://github.com/lyty1997/AxialMuseWebsite/issues/39#issuecomment-6399028942)已回填并独立逐字核验，#39 已按 completed 关闭；#38 DNSSEC、HSTS 和 #40 持续健康核查留待各自范围。新启用已授权的 Let’s Encrypt ACME 服务并仅提交所有者私密联系邮箱；未新增浏览器第三方请求、用户数据采集、DNS 写入或付费服务。

[PR #70](https://github.com/lyty1997/AxialMuseWebsite/pull/70) 已在检查通过且 head/base 稳定后合并为 `main@2cf04ee8a781af1181b8e377a395d0a211c27e3e`；[main CI 40201521669](https://github.com/lyty1997/AxialMuseWebsite/actions/runs/40201521669) 六项 job 全部成功。唯一新增 TAT task `invt-0ac1xu07b2` 的完整五参数命令独立匹配，终态 SUCCESS/exit 0。artifact `12602585347` 的 ZIP SHA-256 为 `97ade501105db29f9be1b35c40f6aa6f1d7f9094e1acc658dfe2d113ae0c6273`，release tree 为 `7920f2c59fdd92bc92d09c63f2b6b9ae6bc32acd2f06210552de4604e2f85168`。新 current 的 14 个 payload HTTP 字节匹配，账本 SHA-256 保持 `2bd67fdfc737ea75047eb235cb64495865f5c91ac5d58bf1b2eaf42a2573d4de`，事务数为 5。

四个模块从上述精确 main 经 GitHub 内容、Git blob 与 SHA-256 认证，八个目标已安装；新 SSH 独立检查八个目标、十一个未变组件、五份旧入口备份及四个非法参数拒绝均通过。所有者的联系邮箱文件格式、root:root/0600 独立检查通过，邮箱值没有输出。备份位于 `/var/lib/axialmuse/public-upgrade-2cf04ee8a781af1181b8e377a395d0a211c27e3e/`，权限 0700。

未提交的现场辅助脚本首先因遗漏 `DeploymentState` 导入在任何 bootstrap 写入前停止；独立确认请求回执、配置和 reload 预算均未创建后修正。随后 bootstrap 已安装并 reload，但辅助函数 `http` 遮蔽 `http.client`，探针失败触发已授权恢复；配置移除与本机恢复 reload 均完成。原始错误和恢复结果保留，函数已改名并通过七个针对性边界断言。上述错误属于现场辅助脚本，不是已合并仓库模块的测试结果。

恢复后的历史复核曾确认只有 `127.0.0.1:18080`，公网配置和模式缺席，未申请证书、未执行 prepared 或续期；current、账本和五个事务未变，Nginx 基础文件摘要未变，failed unit 仍为原冻结集合的子集。当时已消耗三次生产 reload（merge TAT、bootstrap、bootstrap 恢复），原上限六次不足以完成剩余步骤并保留兼容恢复额度，因此暂停并请求调整。用户随后在 D-167 明确授权总上限八次，才从独立验证的恢复状态继续，结果见本节上方。没有额外 TAT 或 CI 重跑。

## 不变量与前置

正式内容只由 `https://www.axialmuse.com/` 提供；HTTP 与 HTTPS 根域保留路径、查询串并单跳到 canonical。旧路径和尾斜杠 exact 规则优先，未知 Host/SNI 不提供正式内容。payload、重定向与 CSP 必须来自同一精确 release，公网检查失败仍进入 #37 的完整账本兼容恢复流程。

D-165 已授权候选和本机隔离验收。DNSPod 后台 A 已由所有者核对，公共 A/NS 与服务器匹配；DNSSEC 缺席且免费套餐无此能力，#38 不关闭。原始全量 DNS 清单与旧值仍须在任何写入前私密保存。实际公网、ACME、服务器和 Git 写入另行确认。

## 候选接口

- `ops/deploy/public_site.py`：从已认证 release 的 HTML 计算内联脚本/样式 SHA-256 CSP，拒绝内联事件、未知样式属性和外部主动资源；生成 HTTP/HTTPS 精确主机配置。
- `ops/deploy/public_activation.py`：在既有事务锁内预检候选与兼容 fallback；隔离 HTTPS 使用真实配置和证书。激活时原子替换公网配置，执行 Nginx test/reload、本机及受信 TLS 冒烟。结果仍为 `local-accepted`，不冒充公网验收。
- `ops/deploy/renew_public_certificate.py`：固定双域名、固定 lineage 的 Certbot deploy hook；验证证书/密钥匹配、有效信任链和两个主机名，按共享锁、当前 release/账本和精确配置检查后 test/reload/冒烟；不修改 current 或 URL 账本。
- `release_commands.py`：五个 TAT 参数不变。显式 root-only `public-site.json` 存在才进入公网模式；缺失时若发现公网配置则拒绝，避免悄悄降级为只验本机。

固定生产路径：

| 路径 | 用途与权限 |
|---|---|
| `/var/lib/axialmuse/deployment/public-site.json` | mode `0600`、root:root；当前为 `{"schema":1,"hsts":false}`；D-169 候选兼容原 schema，并新增严格 schema 2 的整数 `hstsMaxAge`（仅 0/300），迁移尚未实施 |
| `/etc/nginx/conf.d/axialmuse-public.conf` | root:root `0644`；整代 root/include/CSP；只在持有发布锁时原子更新 |
| `/etc/nginx/conf.d/axialmuse-acme.conf` | 仅首次 HTTP-01 bootstrap；正式 HTTPS 激活前移出活动配置，保留备份 |
| `/srv/axialmuse-acme` | root:root `0755`，全部祖先可遍历；只服务 `/.well-known/acme-challenge/` 的单个 token，不进入 release 或私有状态目录 |
| `/etc/letsencrypt/live/axialmuse.com` | 固定双域名 lineage，由既有 Certbot 保管，私钥不进入仓库或输出 |
| `/etc/letsencrypt/renewal-hooks/deploy/axialmuse-public` | root-owned 固定 hook；调用认证安装的 Python 模块 |
| `/var/lib/axialmuse/deployment/certificate-renewals` | root-only 只追加 hook 成功回执；绑定时间、current/账本和实际加载的公开证书 SHA-256 |

HTTP bootstrap 对两个精确 Host 只提供 ACME token，其他路径返回 503，未知 Host 返回 421。正式模式只监听 IPv4 80/443；本机 18080 保留，隔离候选使用 18082/18443，全部候选端口只绑定 `127.0.0.1`。无 AAAA、项目域名、通配证书或第三方浏览器来源。

CSP 使用 `default-src 'none'`、本站脚本及实际内联 SHA-256、本站样式及实际内联样式 SHA-256，图片仅本站及 data，连接仅本站；禁用 object、base、form、frame 和事件属性。真实 Docusaurus 制品的隐藏 SVG sprite 使用唯一静态样式属性 `display: none;`，仅此值通过 CSP3 `style-src-attr 'unsafe-hashes'` 与精确 SHA-256 授权；其余样式属性失败关闭，不使用 `unsafe-inline` 或 `unsafe-eval`。CSP 每次从验证后的完整 payload 派生，不修改不可变 release。HSTS 生产仍关闭；D-169 已确认新增 300 秒候选，不使用 preload 或 includeSubDomains，具体安装/reload 待授权。旧 schema 1 的 true 保持历史半年语义，新的 schema 2 不允许任意延长期限，详见[模式兼容与迁移边界](production-health.md)。

所有响应（含重定向/错误）继承安全头。缓存按设计区分 HTML、短期索引、普通资源、指纹资源、媒体；错误为 no-store。gzip 按 MIME 启用且保留 Vary。请求 access log 关闭；候选公开 vhost 将请求 error log 丢弃，避免 URL/query 写入错误日志，配置测试和 reload 的受控诊断继续保留在 root 运维记录。该候选日志取舍须包含在正式安装审查中。

## 正式写入前审查清单

1. 固定精确 main/候选摘要、服务器前态、剩余操作次数、恢复配置、管理通道及完整 DNS 旧值。核对备案/接入和现有云防火墙，不从历史确认推导当前控制面状态。
2. 审查固定路径、认证组件安装清单、模式启用顺序、备份、锁及自动部署衔接；Git main push 将触发 TAT，次数单独计算。
3. 确认 ACME CA、账户联系邮箱、协议接受及 Certificate Transparency 公开域名；不以本次候选授权注册账户或申请正式证书。
4. 先安装经审查的 bootstrap HTTP 配置并用受控 token 验证两个主机，才申请双域名证书。只用 certonly/webroot，不用自动改写 Nginx 的 plugin。
5. 证书验证通过后，在同一受控操作内停用 bootstrap、创建模式文件并安装正式配置；test/reload 后分别从公网和服务器受信 TLS 验证。失败保留证据，按已审查的前态恢复；不把更旧不兼容 release 用作恢复。
6. 正式 Certbot dry-run 使用 `--run-deploy-hooks`，并要求本轮新增且身份/时间匹配的成功回执与实际 TLS 证书摘要；Certbot 官方明确 hook 的非零不一定传播到整体退出码，因此不能只认 Certbot exit 0。dry-run hook 使用活动正式证书，不使用 staging 临时证书。mock 只证明 hook 本地失败语义，不能冒充 ACME 续期演练。到期/续费/恢复责任仍由所有者承担，#40 接收这些证书/回执作为独立健康核查输入。
7. HTTPS 稳定后再回到 #38，确定 DNSSEC 套餐与写入授权；没有 DNSSEC 验收不得关闭 #38。

## 本地独立证据

fixture 测试覆盖 CSP 内容变化、外部脚本/内联属性拒绝、Host/ACME 边界、配置一致性与 hook 失败。显式 opt-in 的固定既有 Nginx 镜像只绑定本机端口，使用临时测试 CA/证书验证四主机、SNI/Host 错配、301 查询保留、200/404、安全头、MIME、gzip、缓存和切换；浏览器验证真实当前制品的 hydration、CSP 违规与网络来源。测试证书不是真实 ACME 证书，本地成功不构成公网成功。

官方行为依据：[Nginx 安全头继承](https://nginx.org/en/docs/http/ngx_http_headers_module.html)、[TLS/SNI 拒绝](https://nginx.org/en/docs/http/ngx_http_ssl_module.html)、[Certbot webroot 与续期 hook](https://eff-certbot.readthedocs.io/en/stable/using.html)。

## 本轮正式执行清单（D-166 已授权）

所有者已确认本节的 Git/公网/ACME 范围、次数和控制面核对项，并选择自己在 root-only 文件填写联系邮箱；来源与排除项见 D-166。邮箱文件未就绪时只暂停账户注册/签发及后续 HTTPS，不阻断已授权的 Git 晋级与独立准备。账户邮箱仅向 ACME 服务提交，不加入 EFF 邮件列表。

2026-10-25 新只读前态：`main` 仍为 `27d461b`，`dev` 仍有九个并行提交；服务器只有本机 18080，Nginx/Certbot timer 为 active/enabled，Certbot `2.9.0` 没有账户、live 或 renewal 项，没有默认联系邮箱。公网配置、模式文件、ACME webroot 和 hook 均不存在；OS UFW active，四条规则完整解析且 IPv4 80/443 已放行。本次没有读取联系地址、密钥或账户内容，没有写入服务器。

### 单一晋级与安装路径

1. 审查本候选及补充授权记录的完整 diff，在精确 main 上形成独立 `codex/*` 分支，排除 dev 并行提交和主工作区已有改动，直接 main PR；不直推 main，不删除分支。required checks 全绿且 PR head/base 稳定时普通合并。观察新 main 的六个 CI job、artifact、独立 TAT task 和本机 current/账本；本步骤最多新增一次 TAT，仍使用旧的仅本机入口。不完整重跑 main CI。
2. 从已成功的精确新 main 认证三个新增模块 `public_site.py`、`public_activation.py`、`renew_public_certificate.py` 和更新后的 `release_commands.py`：GitHub 内容、Git blob ID、SHA-256 与候选逐项匹配。持有既有目录/文件 verifier 双锁，并取得部署状态锁，保留 root-only 原文件/摘要备份后安装四模块（0644）及同一固定入口字节的四命令（0755）。TAT 五参数不变，不改 App、CAM、verifier 或下载器。新 SSH 独立核验八个文件和四个非法参数拒绝。
3. 每个阶段写入前重新核对 boot、服务、模式/配置、当前 release/账本、owner/mode 和预期文件缺席，持有同一组锁；失败或身份不明不自动重试。备份保留在 `/var/lib/axialmuse/public-upgrade-<精确新 main SHA>/`（0700）。所有有意替换只使用已认证内容与固定路径，原 Nginx 基础文件不覆盖。

### HTTP、正式证书与 HTTPS

4. 按批准的联系邮箱方案准备 `/etc/axialmuse/certbot-contact.ini`（root:root/0600，仅一条 `email = <所有者私密填写>`）；只核验字段、owner/mode，地址不进入终端、Git、Issue 或聊天。选择无联系邮箱时明确使用 Certbot 的无邮箱注册选项，不擅自填入 Git noreply 地址。正式服务为 Certbot webroot/HTTP-01 与 Let’s Encrypt；不使用 Nginx 自动配置 plugin。2026-10-25 官方 ACME directory 指向 [Subscriber Agreement v1.8](https://letsencrypt.org/documents/LE-SA-v1.8-July-06-2026.pdf)，注册/签发须由所有者接受；执行前若条款链接变化则停止。两个域名会进入证书透明度日志。本提案不自行代替该授权。
5. 创建 root-owned `/srv/axialmuse-acme/.well-known/acme-challenge`（各级 0755），仅创建明确归属本轮的合成探针文件（0644）。安装精确 bootstrap 配置（0644）：两个 Host 只对单 token 返回固定探针，其他路径 503，未知 Host 421；配置测试及一次受控 reload 后，从服务器与外部访问两个域名，逐项核对 DNS、响应与内容。外部端口不可达或查询不一致即停止，不改云规则，不申请证书。
6. 一次正式签发请求（首次账户创建由同一 Certbot 流程完成），固定 CA、`certbot certonly --webroot`、webroot、`--cert-name axialmuse.com` 和两个 `-d` 域名。使用账户方案确认后的受保护配置，不把邮箱放进可见命令。原始 CA/Certbot 日志仅在服务器 root 运维目录受控保留；只返回脱敏退出状态和公开证书身份。失败不自动重试，不删除账户或失败残留，不签项目/泛域名。
7. 验证证书链、双域名 SAN、密钥匹配、有效期和两个主机名；针对已接受的当前 release 运行隔离本机 HTTP/TLS 候选。在锁内保留 bootstrap 原件，移出活动 conf.d，原子安装正式配置并创建 0600 模式文件（HSTS false），test/reload/本机及外部严格 TLS 验收。整个启用过程不改变 current 或账本。新 SSH 核对精确配置、证书、仅预期 IPv4 80/443 与保留的本机 18080，以及原 Nginx/管理边界。
8. 正式启用失败时，在同一受控恢复中只还原本步骤的精确配置前态、移除仍逐字节绑定的模式/公网配置并恢复 bootstrap，再 test/reload/独立核验；保留正式证书、账户、release、账本和证据。配置身份不明或恢复失败立即停止，不移除未知文件、不退回不兼容 release，不宣称上线成功。

### 发布、续期与关闭

9. 使用新 main 首次 TAT 已安装的相同五字段制品身份，通过固定 `axialmuse-deploy-prepared` 受控执行一次；验证现有安装身份精确相等、公网配置与该 SHA 同代、公开 HTTP/TLS、完整账本和兼容恢复边界。此步骤新增一个既有发布事务，允许内部一次预选兼容恢复；不新建 artifact，不扩大 TAT/CAM 权限。禁止用整轮 CI 重建的不同 artifact 身份覆盖同 SHA 已安装 release。
10. 认证安装 root-owned 的固定 Certbot deploy hook（0755），然后执行一次 `certbot renew --cert-name axialmuse.com --dry-run --run-deploy-hooks`。只有本次产生新的 root-only 成功回执且时间/current/账本/实际 TLS 证书摘要均匹配，才接受续期验收；不只检查 Certbot exit 0。若失败，保留有效证书/配置与失败证据，不自动再申请证书。
11. 外部及浏览器检查四主机、单跳 301/查询串、200/404、CSP/安全头、MIME/缓存/gzip、真实 payload 字节和证书链；日后持续观察与独立健康核查交给 #40。本轮最多一次 TAT、一次正式签发、一次 staging 续期演练、一次固定 prepared 发布；最多六次生产 Nginx reload（bootstrap、正式启用、prepared 发布及一次兼容恢复、续期 hook、一次配置恢复），任一结果不明即停止。
12. 全部独立验收通过后，在 #39 留下命令/退出状态、精确 main/artifact/证书、脱敏回执和下游接口并关闭。收尾文档先留本地，避免为文档追加 main push/TAT；后续晋级另行审查。#38 的 DNSSEC 仍开放，不购买套餐、不改 DNS/NS/DS/AAAA、不配置项目子域名；HSTS 保持关闭，启用另行授权。

正式公网内容启用前，需所有者核对现有 ICP/接入备案仍有效、云端 IPv4 80/443 放行且公网 22 关闭，确认恢复入口可用。当前会话没有对应云控制面或备案连接，不把 OS 防火墙或公共 DNS 查询充当后台证明。请求日志按本候选关闭，保留 root-only 操作/失败记录；不增加服务、分析、Cookie 或其他用户数据处理。

## 正式执行前的历史候选证据

候选基于精确 `main@27d461b` 的独立归档目录，不创建提交、分支或 PR；同时继承 #37 已验证但未发布的三份收尾文档，原工作树不变。新模块、固定命令的模式接线、fixture 与真实 Nginx 验收位于上述接口及 `tests/ops/test_public_site.py`、`tests/ops/test_public_nginx_acceptance.py`。

本地命令为 `/usr/bin/python3 -m unittest discover -s tests/ops -v`，结果 186 项中 184 项通过、2 项 opt-in 跳过；本次新增真实 Nginx 单独使用 `AXIALMUSE_NGINX_ACCEPTANCE=1 /usr/bin/python3 -m unittest discover -s tests/ops -p 'test_public_nginx_acceptance.py' -v`，1 项通过。完整 Node `24.18.0` quality、最终文档/契约/密钥扫描与新增 Python 文件 Ruff 均通过。Python ops 与 opt-in Nginx 继续独立于 Node-only quality，未新增 Actions job 或声称远端 CI 已运行候选。

当前真实 artifact `12580683476` 经 ZIP SHA-256 与既有 verifier 的完整 release 校验后用于本地 TLS/浏览器验收；14 个 payload 的受信测试 TLS/HTTP 字节检查通过。Chrome 的首页、项目、技术分享三页均完成 hydration，客户端跳转正常，29 个观测请求没有外部来源尝试、CSP 违规或浏览器错误。浏览器用临时测试 CA/SPKI，仅证明本地候选，不是真实站点证书。首次 10 秒导航等待超时，保留摘录；增加追踪并调整到 30 秒后独立重跑通过，没有确定首次超时的底层原因。

真实 Nginx 测试覆盖同代 CSP 切换/回滚、失败后兼容恢复、过期/错误主机证书、未知 Host/SNI、ACME 单 token 边界、gzip/Vary、缓存/MIME/Range、续期 hook 的本地路径，以及删除 CSP 的定向 mutation。临时容器结束后不存在。服务器最后只读核查仍仅 `127.0.0.1:18080`，没有公网安装或配置写入。

剩余项：后台全量 DNS 旧值的私密保存、DNSSEC 套餐决定、正式 Git 晋级、认证安装和配置备份、当前云规则与备案/接入核对、ACME 联系方式/协议与正式签发授权、真实 Certbot 续期 dry-run、真实公网/移动端/持续观察。#38/#39 均保持开放；不存在新增第三方运行时服务、生产浏览器外部请求或用户数据处理。

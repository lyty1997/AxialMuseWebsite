# 免费加固与运行观察

状态：D-171 的 300 秒 HSTS 与现有证书 hook 已完成当轮验收；历史本机观察已结束。原始回执通过，窗口跨越发布，不能认定当前版本已独立通过 24 小时验收；新观察未启动
最近更新：2026-10-28
适用范围：#38 收尾、#40 运行观察及 #41/#42 监测候选

## 已确认边界

继续使用免费 DNSPod 和 Let’s Encrypt，不升级套餐、不迁移 NS、不添加 HTTPS 类型记录。DNSSEC 明确延期，未启用不等于验证链成功。#38 仅按已核验现有 A/NS/TTL 收尾；完整 zone 导出尚缺，未来任何 DNS 写入前仍必须私密保存旧值。用户先授权免费加固与运行监测，随后 D-170 明确授权本文件的 16 文件独立晋级、两模块认证安装、一次 TAT 和最多四次 reload。DNS 修改、活动 schedule 和系统定时任务不在本次范围。

## 本轮只读观察

2026-10-28 核对原始 `finished.json`：历史观察从 UTC `2026-10-26T09:38:22.547022+00:00` 至 `2026-10-27T09:38:25.449054+00:00`，共 98 个样本、86402.902 秒、零失败，`samplingGap=false`、`identityDrift=false`、原始 `status=passed`。回执绑定的 baseline SHA-256 为 `7f2f0e73355640b3be9ffc4a124baba611bdcbd76d92565b8ffd960f58fa5783`，与保留文件字节相符；该基线固定为 `main@9e106d5` 的 artifact `12634881728`（run `40287159290`），不是当前版本的独立验收结论。

观察窗口跨越 PR #72 的发布，后续 PR #73 又发布了新版本。公开 payload 相同只能解释为何逐文件检查仍通过，探针回执的 `identityDrift=false` 不等于服务器 current 在整个窗口未变。因此保留原始成功回执及全部样本，不重写为失败，也不将 #40 关闭；当前版本仍需另行取得并核对精确制品与服务器身份后，在新目录启动完整观察。本轮只修正文档，不重开进程、重建基线或触发服务器操作。

D-171 当轮已完成 HSTS/现有证书 hook 验收；该探针未知 Host 的 HSTS 误判修正仍只在本地候选，未随本 PR 晋级。以下为观察要求和此前阶段的原始记录；其中 robots 缺失、HSTS 尚未实施或采样运行中的说法是当时快照，以本节更新和最新进度为准，不能当作当前运行状态。

主要不变量：采样必须匹配固定且已完整校验的生产制品，TLS、HTTP 状态/单跳重定向、查询保留、安全头、逐文件字节与隐藏 metadata 均符合预期；缺证据、身份漂移或任一采样失败须留下失败回执并返回非零，不自动部署或修复。

使用系统 Python 标准库，不安装依赖。基线由 #39 已认证的精确身份、ZIP、逐文件摘要、实际 CSP 和服务器账本摘要生成，保存本机 0600 文件，不把 IP、私密配置或服务器日志写入仓库。公网请求仅到既有根域/www，无访问者埋点和新监控供应商。TLS 使用系统信任并校验主机名，证书少于 21 天失败；响应不自动跟随重定向。采样绑定制品的全部公开 payload，检查 404、未知 Host、canonical、robots/sitemap、备案页脚和无 noindex；字段仅按现有制品事实核验，不把 planned 项目描述成 live。

本机每 15 分钟采样一次、至少覆盖 24 小时；每份回执以 UTC 标时、0600 保存到新的 0700 目录，保留失败状态及相邻采样证据。主机睡眠、进程中断、长采样空档或身份变化不能算连续观察成功。本机后台进程不是服务器常驻监控，也不证明 GitHub schedule 或失败通知可达。观察终点实际到达前，#40 不得标记 24 小时通过；#31 仍开放，页面内容完整闭环和多网络/移动检查各自保留。

本轮还可通过严格 WireGuard SSH 只读复核 current/账本、服务、证书 timer、hook、监听与既有失败身份边界，不触发 TAT、部署、renew 或 reload。

## 免费加固的具体候选

### HSTS

D-169 已确认短期 300 秒试运行：仅根域与 www 的 HTTPS 响应下发，不带 `includeSubDomains` 或 `preload`；经观察后才单独决定延长。新增严格模式 `{"schema":2,"hstsMaxAge":300}`，关闭用 `{"schema":2,"hstsMaxAge":0}`。旧 `{"schema":1,"hsts":false}` 保持关闭，旧 `true` 保持原来的 `max-age=15552000`，不能因代码升级默默改变既有语义。schema 2 只接受整数 0/300，不接受 bool、float、string、额外字段或任意期限。renderer、发布、续期和探针共用严格解析；新代码在旧模式下必须生成与安装前逐字节相同的配置。

不直接手改 Nginx 或模式文件绕开同代配置完整性校验。生产迁移先认证安装候选模块，再在既有 verifier/发布双锁内备份旧模式和精确配置，检查 current/账本未变，验证隔离 HTTP/TLS 候选；随后安装匹配的模式/配置，执行全局测试、受控 reload 及内外探针。失败恢复精确原件，保留请求/失败/恢复回执，未知终态不重试。已缓存策略不会因删除响应头立即消失，恢复可能保留最长 300 秒客户端残留。D-170 已授权下文具体清单，执行前仍须 fresh 前态与阶段门禁；目前尚未执行生产写入。

### CAA

建议在根域新增默认线路、TTL 600 的 `CAA 0 issue "letsencrypt.org"`，让 www 继承，限制未来签发 CA；保持既有 A/NS 不变。它通常还会影响其他子域名的未来签发，未来服务改用其他 CA 时必须先调整；不绑定 ACME account，不增加验证方法限制。该候选只限制 CA，不额外禁止 Let’s Encrypt 签发通配符证书；它不创建任何子域名或项目服务，未来若要限制通配符再单独审查。写入前必须由所有者导出并保管完整 zone、核对不存在需保留的 CAA/CNAME，并确认具体值及继承影响。只回滚本次新增记录，不覆盖其他记录。本轮无 DNSPod 写入连接，不要求聊天发送密钥，不执行变更。参考 [Let’s Encrypt CAA](https://letsencrypt.org/docs/caa/)。

### 活动定时任务与通知

既有设计使用 GitHub 默认 workflow 失败通知；不新增通知供应商，不创建主动发给其他人的消息。本轮先建立可独立运行的只读检查和 fixture。仓库已只读确认 public，按 [GitHub 官方计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)，标准托管 runner 的公共仓库运行免费；不使用大型 runner，也不额外上传长期 artifact/cache。活动 schedule 的频率、预算及通知到达需按 #41 单独接线验收；默认分支 Git 晋级会触发既有生产 CI/TAT，因此不能为了开启监测直接推送文档或 workflow。GitHub schedule 可能延迟，不承诺分钟级监控；默认 schedule 通知关联最后修改 cron 的用户，必须实际核验所有者能收到通知，不能从 workflow 失败推断通知已送达。#42 的 systemd/logrotate/账本备份另有服务器写入门禁。

## 独立验收与证据

检查器应覆盖正常制品，以及错误 payload、错误/重复 Location、近过期证书、失配主机名、缺安全头、错误 canonical、身份漂移、采样空档与实际网络失败。fixture 必须能让错误行为失败，不把完整 CI 代替这些反例。真实公网初次采样、服务器只读复核、开始/截止时间及最终观察状态随后回填；未结束的观察只能报告 running，不能报告 passed。

### 2026-10-26 实际回执

- #38 范围和证据已更新并独立逐字核验，[关闭证据](https://github.com/lyty1997/AxialMuseWebsite/issues/38#issuecomment-6409820383)保留 DNSSEC 未启用及全量 zone 未导出的边界。113 项新 DNS 组合经保留原始四个 UDP 失败的逐项 TCP 补查后全部符合预期；没有 DNS 写入。
- `/usr/bin/python3 -m ops.monitor.public_health --baseline <0600基线> --output <新的0600回执>` 实际 exit 1：42 项中 41 项通过，14 个 payload 哈希通过，唯一失败为 `HEALTH_ROBOTS_MISSING`。这证明 #39 的字节验收与 #40 的发布完整性条件不同；当前制品不包含 robots，不能用完全匹配制品把它掩盖。
- `ops/monitor/public_health.py` 的 20 项独立正常/反例及采样循环检查通过；完整 Python ops 共 206 项，204 通过、两个既有 opt-in 跳过。Ruff、完整 Node quality、253 项 TypeScript 测试和实际 production build 通过。新增 `static-public/robots.txt` 已作为 operational 素材进入注册表，build 中字节精确一致；尚未发布，当前公网仍为 404。
- 绑定制品为 `main@2cf04ee8a781af1181b8e377a395d0a211c27e3e` / run `40201521669` / artifact `12602585347`，ZIP 与整树先经既有 verifier 完整复验。基线在 `/tmp/axial168-health/baseline.json`，初次公网回执在相邻 `initial.json`，均 0600。观察目录 `observation/` 为 0700，进程 PID/输出和逐次回执只保留在本机。
- 首个定时采样始于 `2026-10-26T06:31:43.191051+00:00`（纽约时间 10 月 26 日 02:31:43）；计划每 900 秒一次、至少 86400 秒。已知 robots 失败会保留并继续采样，不能在 24 小时后直接算成功；修复上线后需要为新制品重新认证基线并重新观察。进程中断、机器离线或采样缺口也不能通过。
- 严格 WireGuard SSH 复用只读最终检查 exit 0：精确 current、六事务、两份账本历史、八个安装文件、十一个未变组件和五份旧备份一致；Nginx/Certbot timer、hook、证书、监听/UFW、冻结失败集合和 boot 均通过。历史 reload 仍为七次，本轮零新增。证书剩余约 89.3 天。
- 真实移动 Chrome 390×844：三页 hydration 与客户端导航、29 个请求通过，无外部请求、CSP 违规或浏览器错误；截图已人工查看。证据为 `/tmp/axial168-mobile-browser-receipt.json` 与相邻 PNG/trace。此为开发者网络和模拟移动视口，不代表真实多运营商网络。

### 依赖安全的新事实

只读 GitHub Dependabot API 当前返回未关闭告警共 50 条：critical 4、high 26、medium 15、low 5。它们是告警条数，不是独立可利用漏洞或受影响包的数量；历史“18 个 high”不能当作当前数量。

| 当前锁定路径 | 新核验的告警与修复版本 | 影响边界 |
|---|---|---|
| Docusaurus core → `tinypool@1.1.1` | [worker options](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3)、[run options](https://github.com/advisories/GHSA-85c8-ppgw-ccpr)，完整覆盖需不低于 `2.1.2` | 涉及已有原型污染条件下的 Node worker 执行；具体构建可达性仍待检查，跨主版本不能直接强塞 override |
| Express → `proxy-addr@2.0.7` | [代理信任子网](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)，修复 `2.0.8` | 依赖错误的 IPv4-mapped IPv6 信任子网配置；尚未证明本项目使用该配置 |
| launch-editor → `shell-quote@1.10.0` | [命令引用边界](https://github.com/advisories/GHSA-pqg4-j6r4-53mv)，修复 `1.11.0` | 需要特定组合的攻击者输入进入 Node 命令处理；尚未证明本项目可达 |

GitHub 将这些依赖标为 runtime，不等于 Nginx 生产服务器运行 Node。静态生产边界减少直接暴露，但开发机/CI 和制品供应链风险仍需按正式依赖重准入处理。本轮未执行攻击代码、依赖自动修复、修改 lock/admissions 或把 CI 全绿当成漏洞消失；后续升级必须同时更新准入证据、运行受限 audit 和必要兼容性验证。

## D-169 候选晋级与生产执行清单（D-170 已授权）

用户已在 D-170 明确批准本清单；依次完成精确身份、前态、预算和阶段终态检查后执行，不重复请求同一范围授权。下文“须授权”的规则保留为原门禁，本清单所列动作已获准，范围外仍保持暂停。

候选验证已完成：默认 Python ops 212 项中 209 通过、三个 opt-in 跳过；两个公网真实 Nginx/TLS 场景另行启用并通过，覆盖试运行在发布/回滚/续期中的保持、关闭及错误半年头 mutation。独立旧源比较证明原关闭和半年配置逐字节一致，旧源 SHA-256 与已认证安装源匹配；Ruff、完整 quality 和差异检查通过。首轮 quality 因本文件的受限状态词失败，随后通过直接文档门禁定位并修正，失败日志与修复后全绿日志均保留。具体证据是本机 `/tmp/axial169-ops-tests.log`、`/tmp/axial169-real-nginx.log`、`/tmp/axial169-render-compatibility.json` 与 `/tmp/axial169-quality-after-doc-fix.log`；不将本地验证当作远端 PR/CI 或生产结果。

### 仓库补丁

候选涉及 16 个文件：两份既有部署模块（`public_site.py`、`public_activation.py`），两份既有公网测试，一份新增只读检查器和一份测试，robots 文件及注册表，以及八份文档（包含此前 #39 尚未发布的现场收尾）。不包含依赖 lock/admissions、活动 workflow、dev 并行代码、私密基线或观察回执。

已只读核对 canonical main 为 `2cf04ee8a781af1181b8e377a395d0a211c27e3e`；远端 dev 另有九个 main 未包含的提交。建议把上述候选整理到基于精确当前 main 的独立 `codex/*`，直接向 main 提 PR，保持 dev 原样。实际创建分支、提交、推送、PR 和合并均须取得新的 Git 路径授权；PR 必需检查全绿且 head/base 稳定后才合并。合并会按既有 workflow 自动发起一次 TAT；不能把文档发布视为不触发部署。

### 分阶段现场动作

1. 先等待新 main 的六项 CI 与唯一 TAT 完整成功，验证精确 run/artifact/SHA/双摘要、服务器 current/账本及 robots 200 字节。该次自动部署仍使用旧服务器模块和 schema 1 关闭模式；失败或未知则停止，不先安装或人工重复 CI/TAT。
2. 从同一成功的精确 main 交叉认证 GitHub contents、Git blob 与 SHA-256，生成只包含两份新模块的安装包。在严格 WireGuard SSH 下核验服务器 boot、失败身份、原配置/监听/证书/current/账本与模块旧摘要，持有 verifier 和发布双锁，创建独立 root-only 备份目录，保存原两个模块、模式、配置和逐项摘要。原 #39 备份保持不变。
3. 两个模块安装为 root:root/0644，不改变四个固定命令或续期 hook 文件。先在旧 schema 1 关闭模式下验证导入、原配置逐字节一致和完整内外探针；这一阶段不需要 reload。固定五个 TAT 参数、App/CAM/verifier/下载器和管理网络保持原样。
4. 在双锁和稳定 current/账本下，由新模块构造 schema 2 的 300 秒隔离 HTTP/TLS 候选。候选通过后，保存单次请求记录，再原子替换 0600 模式文件和匹配公网配置，执行全局 `nginx -t`、一次受控 reload 和 worker 切代等待，随后逐字节/单跳/CSP/HSTS/未知 Host/SNI/ACME 边界及公网系统信任校验。不得将模式文件 `hstsMaxAge` 单独改完后交给普通 deploy/renew 去“补齐”。
5. 以现有有效证书运行一次固定续期 hook 验收（匹配固定双域名/lineage），只测试验证与 reload 链，不申请、续期或重签证书；独立核对新 hook 成功回执、300 秒头及未变 current/账本。失败则按预存原件恢复原模式/精确配置并验收，保留全部请求/失败/恢复证据。
6. 用新 main 的真实 ZIP 再次完整认证监测基线，将预期头明确设为 `max-age=300`；公网全检查通过后，保留旧阶段全部失败采样，按精确进程身份停止旧本机采样，创建新目录重开至少 24 小时观察。新阶段未达到时长或出现失败/空档就不能声称 #40 通过，#31 等直接内容前置仍单独核验。

### 动作上限与恢复

建议上限为一次新增 TAT，以及累计最多四次生产 Nginx reload：合并自动部署一次、HSTS 启用一次、现有证书 hook 一次，另留一次精确恢复。自动发布若使用兼容恢复也计入总数，CI/TAT 失败则后续安装不开始。每个 reload 前先核对剩余额度；命令结果未知先保留证据并独立观测，不重复触发。独立 journal 计数与单次请求/结果共同证明总数，不复用 #39 已消费额度。

HSTS 阶段失败时优先恢复备份的旧模式/配置，核对 global test、worker、内外响应和 current/账本未变；已经缓存的 300 秒策略不能承诺立即清除。需要恢复旧模块时必须先确保模式已经回到旧 schema，禁止把旧模块与 schema 2 混装。失败、部分安装或恢复不确定就保留现场并停止；不得自行回滚到不兼容 release、删除 staging/备份、扩额度或重跑 CI。

本清单不包含 CAA/DNS/DNSSEC、证书签发或 renewal dry-run、依赖升级、新供应商、云规则、重启、systemd/logrotate 或活动 schedule/通知写入。当前 4 critical/26 high 告警仍按上节保留，不能以这批候选检查全绿宣称消除；下一轮依赖处理需正式准入和可达性评估。

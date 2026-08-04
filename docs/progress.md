# 项目进度

本文件是 AxialMuseWebsite 的项目进度真相源，按时间倒序记录每次任务的完成内容与遗留项。每次任务结束或中断时更新。

条目格式：`时间戳 / 主题 / 完成内容 / 遗留项`。

## 2026-08-04 — D-136 确认 #36 两阶段晋级方案（第一阶段 Git 已授权）

- **决策**：用户确认方案 A，保留 D-123 的历史事实，但以两阶段晋级取代其面向未来的单 PR 节奏。只读审计证明 canonical `main` 尚不含 bootstrap、verifier 与 golden，而 D-121 要求三者先进入同一 canonical `main` 精确提交才能安装；#36 又属于 #18 完成条件，安装结果还须回填文档，因此不能在“#18 全部完成后才首次合入”的同时只使用一个 PR。
- **阶段边界**：第一阶段按 `codex/* -> dev -> main` 晋级仓库前置，依次要求 topic 提交、`dev` push CI、`dev -> main` PR checks 和合并后的 `main` push CI 成功；当前远端 `dev` 的既有 preview 工作必须保留并解决集成冲突。`production-artifact` 只会在 `main` push 运行，活动 workflow 尚无 `deploy-production`，第一阶段不会自动写服务器。第二阶段从最终 `main` 独立认证三项 Git blob 后，仍须重新确认快照/恢复通道并取得新的服务器写授权，才可执行 D-121 bootstrap；安装完成事实通过后续 evidence 晋级回填，可与 #37/#18 后续批次合并。
- **当前授权**：用户随后明确授权第一阶段 Git 晋级：提交并普通推送当前 topic；保留 `origin/dev` 的既有 #8 工作，在不改变既定设计的边界内解决普通 merge 冲突后推送 `dev`；精确 `dev` CI 全绿后创建并在 checks 全绿且 head/base 未漂移时合并 `dev -> main` PR，再观察精确 `main` CI。禁止 force、rebase、直推 `main` 或绕过失败/跳过的门禁；冲突不能按既定设计消解、CI 红灯或远端漂移时停止。本授权不包含 Issue 写入、服务器或云资源写操作、verifier 安装及 #37。#36 仍只差 verifier 现场安装，#37 继续暂停。

## 2026-08-04 — D-135 D-130 unit-aware v2 formal 通过（#36 仅剩 verifier 现场安装）

- **授权与执行**：用户明确授权执行更新后的 D-130 formal 只读验收。本地先复核 unit-aware v2 候选与三项冻结依赖封印、v1/v2 receipt 缺席并重新通过审计；随后唯一一轮正式入口通过已核对 host key 的公钥 SSH 与 `sudo -n` 完成两条 fresh、同一记录 boot、间隔至少 10 秒的只读语义观测。结果精确为 `status=accepted-with-residuals`、`vendorState=fully_absent`、`aggregateDisposition=accepted_residual_unattributed`，全部逐组件 gates 为真。
- **证据与边界**：私有 ignored 的 `.local/issue-36-ufw/.d130-semantic-acceptance-v2.json` 已以 `0600` 原子生成，并通过独立 live-state、来源封印、字段闭包和 D-129 pending 绑定复验；receipt 记录 `serverMutationPerformed=false` 与两条 fresh session。被接受但不伪归因的残余仅为 vendor component 完全缺席和重启前后聚合 posture 不等。D-129 永久保持 `post-reboot-pending` / `formalAccepted=false`，D-132 历史失败不改写；除正常 SSH/sudo 审计副作用和既定短暂包管理锁外，没有服务器或云资源写操作、第二次重启、reload、恢复、verifier 或 #37。
- **剩余门禁**：D-130 有效 v2 receipt 门禁已经关闭，formal 授权已消费。#36 现在只剩 bootstrap、#35 verifier 与 golden 来自 canonical `main` 同一精确提交后的 verifier 现场安装与验收；该服务器写操作仍须新的明确授权。#37 继续暂停，Git commit/push/PR/merge 与 Issue 写入也未获本轮授权。

## 2026-08-04 — D-134 D-130 unit-aware v2 契约完成本地审计（#36 整体仍为 GAP）

- **授权与范围**：用户只授权在本地修改并审计 D-130 的 unit-aware 验收契约，不授权连接服务器、执行 formal、生成 receipt、修改服务器或云资源、推进 verifier/#37，或执行 Git 发布操作。D-129 继续保持 `post-reboot-pending` / `formalAccepted=false`，D-132 的失败事实不改写。
- **v2 契约**：outer normalizer 现在必须显式接收 unit。`tat_agent.service` 只接受整条记录尾部唯一单值 `status=0`，`unattended-upgrades.service` 只接受唯一数字对；固定字段、顺序、systemd code 枚举、非空时间、数字 PID 与整串边界同时校验，未知 unit、交叉 status、缺失、重复、乱序、额外字段、第二记录、文本/混合 status 和尾随内容均以 `posture-exec-start-shape` 失败关闭。通过值仍规范化为旧稳定表示，只把 TAT 的单值零当作该 unit 的展示等价值；Nginx 既有 inner 单值零/数字对边界不扩大，数字对本身不被解释为成功。
- **证据与本地验收**：policy、remote/local schema、component 域分隔和私有 receipt 路径升级到 v2，入口同时拒绝已有 v1/v2 receipt；receipt 显式携带 unit policy。D-129、remainder 与 D-128 均从同一次 `O_NOFOLLOW` 安全读取的字节计算 seal 并加载，关闭 digest→path load 窗口。正反例覆盖 source call-site、remote v1/错误 policy/challenge、receipt schema/policy/source seal、live binding、vendor partial/换态和 unit grammar mutations；`python3 -B .local/issue-36-ufw/axialmuse-d130-semantic-acceptance.py --audit` 返回 `D130_SEMANTIC_ACCEPTANCE_AUDIT_OK`。本轮没有服务器连接、formal、receipt、重启、reload、恢复或云/Git 写操作。
- **剩余边界**：本地候选通过不等于 D-130 formal acceptance。#36 仍缺另行授权后在同一记录 boot 上形成的有效 v2 receipt，以及 canonical `main` 前置满足后的 verifier 现场安装；#37 继续暂停。

## 2026-08-04 — D-133 当前 ExecStart 形态分类完成（#36 整体仍为 GAP）

- **授权与安全闭包**：用户只授权制作、本地审计并执行一次隐私安全只读分类，不授权修改 D-130 契约、重跑 formal 或任何服务器/云资源写操作。首轮独立复审在远端连接前发现 status 尾部未锚定的误分类并完成修正；最终候选通过固定依赖、同 boot、challenge、干净环境、命令白名单、异常/输出闭包和正反例审计，随后只建立一条新 SSH 会话且没有自动重试。
- **当前分类结果**：同一记录 boot 上，`tat_agent.service` 为 `single-zero`，其 unit、fragment、process 门禁均为真；`unattended-upgrades.service` 为 `numeric-pair`，其 unit、fragment 门禁均为真。没有返回或保存原始 `ExecStart`、路径、PID、cmdline、主机或连接信息。该单次当前观测把后续候选修正范围收窄到 TAT 的 outer normalizer，但不追溯证明 D-132 观测瞬间的历史因果，也不能把 `numeric-pair` 单独解释为成功。
- **剩余边界**：D-133 不是 D-130 formal，没有生成 D-130 或 D-133 receipt，也没有修改 D-129/D-132 历史结果；服务器与云控制面没有除正常 SSH/sudo 审计日志外的写入。D-134 后续已在独立授权下完成 unit-aware v2 本地契约，但仍未运行 formal。#36 仍缺有效 D-130 receipt 和 canonical `main` 前置满足后的 verifier 安装，#37 继续暂停；新的 formal 须另行取得明确授权。

## 2026-08-03 — D-132 首轮 D-130 formal 失败关闭（#36 整体仍为 GAP）

- **授权与执行**：用户明确授权使用既定 ignored 冻结候选执行一轮 D-130 formal，只允许远端状态读取和本地私有 receipt，不授权服务器或云资源写操作。本地审计重新通过；正式入口先完成只读 boot 绑定探针，再进入两条语义观测会话的既定流程。
- **失败事实**：语义观测阶段返回 `D130_SEMANTIC_ACCEPTANCE status=failed code=remote-posture-exec-start-shape`，按契约立即失败关闭；没有生成 `.d130-semantic-acceptance-v1.json`，也没有自动重试。该错误只证明继承的 systemd `ExecStart` 形态谓词未命中。执行后的本地源码审计把触发范围收窄到 outer normalizer 处理的 `unattended-upgrades.service` 或 `tat_agent.service`，而非 Nginx；当前脱敏错误码仍不区分两者，也不能证明实际尾部形态、服务或主机故障，尚未完成的后续门禁同样不能记为通过。
- **边界与遗留**：远端只产生常规 SSH/sudo 审计副作用并短暂持有既有包管理锁，没有修改服务器文件、配置、服务、防火墙、软件或云控制面；没有第二次重启、reload、补链、再基线、恢复、verifier 或 #37。D-129 继续保持 `post-reboot-pending` / `formalAccepted=false`。本次 formal 授权已消费；具体 unit 归因、验收源码/证据契约修正及再次 formal 都须新的决定与授权。#36 仍缺有效 D-130 receipt 和 canonical `main` verifier 现场安装，#37 继续暂停。

## 2026-08-03 — D-130 semantic acceptance 源码与证据契约获准（formal 待形成）

- **所有者当前确认**：用户复核 D-129 的正式失败和 diagnostic-only remainder 后，确认按当前主机侧证据未发现问题，并在腾讯云控制面确认当前状态正常。该结论是用户人工确认，不把本机进程或 TAT 在线当作 Agent 对整个云控制面的独立证明，也不追溯解释 vendor 链缺席。
- **获准契约**：用户选择新建 D-130 逐组件只读语义验收，并接受旧 preflight 只留聚合摘要造成的不可分解历史残余。vendor 只可为 `fully_absent` 或原严格 `rejecting`，任何 partial/换态失败关闭；其他 D-124/D-129 当前语义门禁继续精确执行，systemd 仅接受 Nginx `ExecStart status=0` 的精确成功表示等价。聚合摘要不等只记为 `accepted_residual_unattributed`，不声称匹配、已归因或已重新建立基线。
- **授权和剩余边界**：本轮只授权修改、本地审计 D-130 源码、证据 schema 和反例，不授权连接服务器执行 formal。D-129 的 consumed/result 必须保持 `post-reboot-pending`/`formalAccepted=false`，不执行第二次重启、reload/补链/再基线、服务恢复或云写操作。该时点 D-130 formal receipt 尚未形成；后续 D-132 首轮 formal 的失败关闭见上方独立条目。

## 2026-08-03 — D-129 唯一维护重启已执行，完整 post-reboot 失败关闭（#36 整体仍为 GAP）

- **授权与已执行事实**：用户确认当前快照正常、控制台或 TAT 恢复通道可用后，授权只执行一次维护重启及完整后验。精确冻结候选的 fresh preflight 通过，一次性 guard 随后消费授权并只发送一次重启；严格 SSH 经历不可达再恢复，boot identity 已改变，同一新 boot 的 system state 为 `running`。本地 consumed/result 与原 transaction 绑定，结果保持 `authorizationConsumed=true`、`bootChanged=true`、`sshCycleObserved=true` 和 `outcome=post-reboot-pending`。
- **失败关闭与只读 remainder 证据**：首次正式 post-reboot 与一次同 boot 的只读 resume 均在 `remote-vendor-declaration` 停止。后续多次脱敏采样持续证明防火墙双读稳定、normalized non-vendor 精确命中 frozen oracle、IPv6 vendor 缺席，但 IPv4 `YJ-FIREWALL-INPUT` 的声明、INPUT 引用和规则均缺席；`YDService`/`YDLive` 存在且晚于 UFW 启动，TAT agent active/running/enabled。diagnostic-only remainder 另把 D-124 host-baseline 偏差定位为 Nginx `ExecStart` 成功状态的单值 `0` 表示；只允许 vendor 完全缺席和该精确表示等价后，两条全新严格 SSH 会话间隔 10 秒，一致通过 SSH/UFW/non-vendor oracle/Nginx/TAT/Certbot/systemd/监听/包/自动更新和 `reboot-required` 缺席等当前语义门禁。当前两次 post posture 稳定，但不等于重启前聚合 posture 摘要，无法从原单一摘要继续归因；诊断明确为 `formalAccepted=false`，服务器与本地 guard 均未改变。
- **后续状态**：腾讯云公开资料没有给出空 vendor 链的 boot 常驻或恢复时限契约，因此 D-129 既不能按原冻结谓词验收，也不能据此断言主机安全代理故障。唯一维护重启授权已经永久消费，没有执行第二次重启、UFW reload/再基线、手工补链、腾讯服务重启或云控制面修改。用户后续在 D-130 决策中确认主机侧未发现问题且当前腾讯云控制面正常，并另行授权修改新验收源码与契约；该后续人工确认不改写 D-129 的失败历史。

## 2026-08-03 — D-128 component-aware transition 完成（#36 整体仍为 GAP）

- **决定与当前边界**：用户接受 D-125 对 initial-enable 历史因果继续保持 `environmental_inconclusive`，确认当前加固态快照正常、控制台或 TAT 恢复通道可用，并更正腾讯云当前只保留与 OS UFW 唯一 SSH 用户规则同源的单一管理来源；本轮没有改写云规则。D-126 的 `status=complete oracleMatch=true` 仍只作为 transition 前的当前内容关系证据，不追溯改写历史结论。
- **执行与终态**：完成本地冻结候选、固定 Docker、服务器只读 preflight 和独立复审后，前两次正式入口分别暴露 systemd 255 的 InvocationID 输出和 transient `FragmentPath` 契约差异，均在 `supervision-ready` 前失败关闭且没有消费授权、arm watchdog、reload 或留下事务残余。修正后的候选再次通过完整门禁；新获准的唯一正式调用返回 `status=complete outcome=committed`。本地 consumed/result 绑定一致，`authorizationConsumed=true`、`cleanupComplete=true`；成功路径已完成一次受监督的 UFW runtime transition、component-wise 后验和临时状态清理，没有自动重试、维护重启、重新建立基线、云规则改写、verifier、证书、#37 或 Git 发布操作。
- **剩余门禁**：#36 仍为 GAP。D-128 不构成维护重启授权；下一步须另行授权一次维护重启，并完成重启后的 SSH、`sudo -n`、TAT、Nginx、UFW、Certbot、systemd、监听、包和双层防火墙稳态验收。服务器 artifact verifier 仍须等待 bootstrap、verifier 与 golden 的同一提交进入 canonical `main` 后，再取得独立现场安装授权；#37 继续暂停。

## 2026-08-02 — D-126 一次性只读语义变换探针完成（#36 整体仍为 GAP）

- **授权与执行**：用户授权且只授权一次 D-126 服务器只读语义变换探针；最终预检通过后，唯一正式执行返回固定结果 `status=complete oracleMatch=true`，一次性授权随消费点永久消费。探针没有传出真实配置、规则或摘要值，没有写服务器、reload UFW、重启、重新建立基线、修改云资源、安装 verifier 或进入 #37。
- **结论边界**：结果精确证明当前规范化 non-vendor 投影加入两条公开标准 IPv6 rate-limit 终止规则后等于冻结 oracle，闭合当前内容关系。它不追溯证明最早 full-hash 差异的历史因果，不改写 D-125 的历史 `environmental_inconclusive`，也不把公共 TEST-NET 时序候选升级为历史事实。
- **剩余门禁**：#36 仍为 GAP。下一步须由用户决定并另行授权 component-aware transition；其后才可收敛云 SSH 单来源并复验，再分别推进维护重启与重启后 SSH/TAT/Nginx/UFW/Certbot/systemd/监听/包状态稳态。旧重启授权没有恢复，verifier、云规则变更、DNS/TLS 和 #37 均未授权。

## 2026-08-02 — #36 软件事务与云边界准备（整体仍为 GAP）

- **恢复点与云方案**：D-117 加固前快照降为历史恢复点；用户已为 D-122 提交后的当前加固态创建软件事务前系统盘快照，确认控制台终态正常且恢复通道可用，未授权恢复或删除。腾讯云轻量防火墙已允许任意 IPv4 来源访问 TCP 80/443；用户选择方案 A 并确认删除当时三个受限 SSH 来源中的槽位 1、3、只保留槽位 2，随后三次严格 SSH 在 TCP 22 建连阶段超时。用户之后把刚删除的两条受限规则按原值恢复，新的严格 SSH 会话成功；服务器连接元数据的脱敏分类确认实际来源仍对应槽位 2，且与 OS UFW 唯一 `/32` SSH 用户规则一致。此前超时因此不再解释为来源槽位选错，更可能位于云规则实施或传播窗口，但现有证据不足以断言具体因果。
- **软件事务与独立后验**：D-124 的单一 apt 事务已精确升级 `distro-info-data`、`libssl-dev`、`libssl3t64`、`openssl`、`tzdata`、`tzdata-legacy` 六包，并以 `--no-install-recommends` 新增 Certbot 及其六个固定 Python 依赖，零额外、零移除且没有执行 `autoremove`。最终写前计划、完整重启前 verifier 和 journald-only systemd 单元预检均先通过；实际事务成功后，root-only 回执只作为事务证据，独立 `post-software` verifier 又复核全部十三包、APT auto/manual 标记、Certbot CLI 与官方 timer、无 ACME 状态，以及 SSH、`sudo -n`、UFW 双栈/YJ 链、Nginx、TAT、监听面和零 failed unit。预期终态摘要在写入前由完整 dpkg 清单加获准增量推导，未使用安装后现采值回填。
- **仓库验收**：同步 D-124、生产清单和剩余门禁后，固定 Node `24.18.0` 的完整 `quality` 在宿主执行环境通过。首次受限沙箱运行只在需要创建隔离 Git/npm fixture 的单测失败；同一单测在宿主环境 59/59 通过，随后完整聚合门禁通过，证明该失败来自执行环境限制而非仓库回归。最终文档微调后的 Markdown、契约词、Secret 与差异检查也通过。
- **恢复后复验、隔离取证与当时门禁**：恢复连接后的完整 `post-software` 在最终全量防火墙摘要处以 `live-hash` 失败关闭；冻结 capture 重新证明 UFW 配置、完整已安装包和 boot 摘要仍等于软件后验基线。脱敏组件投影随后证明 non-vendor 摘要保持历史值，腾讯 vendor 分量会在没有本轮服务器写操作时动态变化，但其当前规则仍全部为 `REJECT` 且结构闭合。用户按 D-125 两次明确授权一次性传输同一组 11 个最小配置成员：首轮因私有副本 DAC 边界在序列化前失败并清理；修正为不增加 capability 的 stdin 内存 tar 后，正式重试的 fresh enable、reload、cold start 各运行两次，六次都完成、同路径双读稳定且三模式的归一化规则投影一致。结构计数中，重建的 IPv4 链/规则数和 IPv6 链数均与同窗服务器 non-vendor 投影一致，唯一差值是固定本机隔离环境每次多 2 条 IPv6 规则；完整归一化摘要仍不匹配，不能把真实内容差异缩写成只有这两条，结论只能是 `environmental_inconclusive`，不能证明服务器漂移或静默再基线。整个窗口前后服务器归一化 full/vendor/non-vendor 投影与冻结 capture 均完全相同，全部容器及本机私有配置副本已经删除；服务器没有重启、文件写入、UFW reload、TAT、云规则再修改或 #37。追加传输授权已消费；正式回执及其失败关闭边界保持不变。其后的 D-126 已闭合当前内容关系，但未改写这段历史结论。
- **本地时序候选与后续证据**：固定镜像的 UFW 0.36.2 源码审计和不使用真实地址的 TEST-NET 重放，在公共等价夹具内连续两次精确复现 initial-enable 103、reload 105，要求 IPv4 不变、IPv6 只新增两个标准 rate-limit 终止规则，并证明该无 IPv6 用户规则夹具没有进入 limit 链的 jump/goto，因此新增规则不可达；正式回执中的两次 cold-start 与 reload 完整归一化投影也彼此一致。这为 UFW 首次启用时序提供了强结构候选解释，但当时公共夹具与正式服务器/oracle 之间只能绑定逐链规则数量摘要，不能冒充真实内容等价。现有冻结 transaction/evidence 不含可恢复真实输入，因此本机 exact 重放路径失败关闭；正式 `environmental_inconclusive` 与最早 full-live 缺少 vendor/non-vendor 分量的历史残余继续保留。随后 D-126 以一次性只读探针得到 `oracleMatch=true`，只补足当前内容关系；transition、重启、reload、云 SSH 单来源、重新建立基线、服务器 artifact verifier 与 #37 仍须新的明确决定和授权。

## 2026-08-01 — #36 OS 防火墙提交与重启前稳态（整体仍为 GAP）

- **授权与范围**：按 D-122 只操作腾讯轻量应用服务器的 OS 防火墙，保持 D-119/D-120 SSH 身份与策略、账户/密钥、Nginx、TAT、软件包和腾讯云控制面不变；开发机本地 UFW 从未被操作。目标规则固定为默认拒绝入站、允许出站、禁用 routed，只允许已验证开发机来源访问既有 SSH 端口，并允许任意 IPv4 来源访问 TCP 80/443，不开放 IPv6 或其他入站。用户当时另行授权防火墙验收后的一次维护重启，但没有授权 Certbot 或待升级包；D-125 后预期 postcondition 已改变，这项历史授权不能直接继续使用。
- **失败关闭与修复**：早期尝试分别暴露自动包任务锁竞争、SSH 标准输入被交互式 UFW dry-run 消费、dry-run 会改写 `ufw.conf`、Ubuntu vendor IPv6 规则中合法不存在 `ufw-not-local`，以及提交后清理错误假设 systemd wants 目录必然存在。所有提交前失败均由 watchdog 回滚或通过精确闭包恢复到写入前基线；提交后的目录假设只影响临时状态清理，不改变已经验收并提交的防火墙规则。修复后的冻结脚本与四组本地 fixture 均按事务摘要绑定。
- **提交、清理与稳态**：最终事务启用 UFW 后，第二条全新严格公钥 SSH 会话逐项通过管理身份、`sudo -n`、SSH 策略、TAT、Nginx、failed units、监听面、双栈默认/用户规则和腾讯 YJ 链身份后才提交。包管理锁持有者按其原协议自然退出后，独立审计的清理事务只删除本事务两个运行时 marker 和 33 个精确绑定的状态成员；随后提交后重启前 steady verifier 再次通过。D-122 收口时服务器 UFW 为 active/enabled，目标规则与 vendor 链保持稳定；腾讯云轻量防火墙没有被改动。
- **软件只读计划**：2026-08-01 的新鲜 apt 模拟显示六个升级候选：`distro-info-data`、`libssl-dev`、`libssl3t64`、`openssl`、`tzdata`、`tzdata-legacy`，零新增、零移除；这些升级在本条记录形成时尚未授权。Certbot `--no-install-recommends` 模拟显示新增 `certbot`、`python3-acme`、`python3-certbot`、`python3-configargparse`、`python3-josepy`、`python3-parsedatetime`、`python3-rfc3339` 七包，零升级、零移除，在该时点也尚未授权或安装；后续实际软件事务见 D-124。
- **CI 与当时剩余门禁**：用户确认 GitHub Actions 额度恢复，并要求当前 `codex/issue-18-production-baseline` 暂不合并 `main`，待 #18 完成后一次性开 PR。topic push 本身不触发 workflow，故当时尚无本轮远端 CI 证据。本条记录形成时，#36 合并前仍须由用户手工闭合腾讯云轻量防火墙、决定六个升级候选和 Certbot、执行获准维护重启并完成重启后稳态；这些事项的后续结果见 D-124 至 D-135。D-132 时点仍待首轮 formal 失败后的有效 D-130 receipt，D-135 已关闭该门禁；当前只剩 canonical `main` 前置满足后的 verifier 现场安装。#37 的生产目录、发布、Nginx 站点、DNS/TLS 与公网闭环继续暂停；本轮未引入浏览器请求、访问者数据处理或第三方常驻服务。

## 2026-07-30 — #36 加固前复核与 verifier bootstrap 候选（整体仍为 GAP）

- **继续只读复核**：严格 host key SSH、`sudo -n`、`sshd -t`、Nginx、TAT 与 systemd 仍健康，没有 failed unit、未知非本地 TCP 或 Web 监听。UFW 已安装但 inactive，IPv4/IPv6 INPUT 默认接受；腾讯云代理已有的来源拒绝链不是 OS 端口白名单，因此双层防火墙尚未闭环。自动安全更新服务及两个 apt timer 已启用且未配置自动重启；新鲜包索引仍有三个非内核数据包待升级，`reboot-required` 仍存在。Ubuntu 官方 Certbot 最小安装模拟不删除包或触碰 SSH/Nginx/TAT，但 Certbot 尚未安装；本轮没有执行服务器或云写操作。
- **首次安装器候选**：D-121 固定一次性 Python 3.12 标准库 bootstrap、四参数封闭 CLI、canonical `main` 三 Git blob 外部认证和精确两个 payload 的私有 source root。实现以 held `/usr/local/lib` directory fd 与持久 lock 文件双重非阻塞 `flock` 关闭 fresh-empty 并发窗口，以 receipt `1.1.0` 绑定 lock 与全部事务对象 identity，再用 `renameat2(RENAME_NOREPLACE)`、目录同步、`prepared -> committed` 唯一提交点和五态恢复完成首次安装或失败隔离；runner 自身不安装，生产机仍不接收源码树、Node/npm 或构建环境。
- **故障注入与修复**：对抗审查复现并修复了“正式路径自测首次失败后重试成功仍提交”、post-activation 父目录 `fsync` 被误报为 lock 并留待下次提交、persistent marker `fsync` 错误分类，以及替换 lock inode 后第二 bootstrap 并发进入四项缺陷。当前 23/23 bootstrap 测试及 #35 既有 20/20 verifier 测试通过，覆盖真实 verifier/golden 自测、候选/正式/marker 恢复、正式失败隔离、持久同步结果不明、目录/文件双锁、lock inode 替换、竞态目标、source rebind、身份漂移与 stdout 边界；Ruff、固定 Node `24.18.0` 完整零依赖 `quality` 和差异检查通过。该 Python 入口按设计不加入 Node-only `quality`/pre-commit。
- **剩余门禁**：bootstrap、#35 verifier 与 golden 仍未进入 canonical `main`，当前工作区证据不能授权服务器安装；本轮也没有 commit、push、PR、merge 或 Issue 写入授权。#36 继续失败关闭于 OS/腾讯云防火墙最终规则、允许的 SSH 来源集合、Certbot/待升级包的软件变更、维护重启及重启后验收，以及 verifier 的 canonical-main 前置和现场安装。每次服务器写操作前仍须确认 D-117 快照正常及控制台/TAT 恢复通道可用；#37 的生产目录、发布、Nginx 站点、DNS/TLS 与公网开放继续暂停。未新增第三方运行服务、浏览器请求或访问者数据处理。

## 2026-07-30 — #36 SSH 全局策略加固完成（整体仍为 GAP）

- **范围与决定**：用户按 D-119 授权只实施 SSH 全局策略加固，并按 D-120 选择方案 1，把有效 `AuthorizedKeysFile` 收敛为唯一 `.ssh/authorized_keys`。实施保持既有非 root 管理身份、端口、主机密钥、主密钥文件、`sudo -n`、TAT 与腾讯云代理不变；没有创建 `AllowUsers`，也没有修改账户、密钥、OS/腾讯云防火墙、软件、Nginx、快照或系统重启状态。
- **失败关闭与根因**：前三次正式尝试均在持久提交点前因 graceful reload 后服务状态尚未收敛而停止；独立 300 秒 watchdog 每次都恢复并复验既有基线，清理后状态为 `baseline_clean`，没有遗留已提交候选。脱敏分阶段诊断把根因定位为 systemd reload 后的瞬时状态采样竞态，而不是策略放宽或验证绕过；第四次把单次瞬时采样改为有界收敛门禁，并继续要求服务健康、daemon 身份不变及全部原后验成立。
- **提交与验收**：第四次事务在完整独立后验通过后，才把 pending drop-in 在同一文件系统原子改名并同步为 canonical root-owned drop-in，随后取消 watchdog、清除私有回退材料并达到 `committed_clean`。两条全新的严格公钥专用 SSH 会话分别复核管理身份、`sudo -n`、服务状态、配置树和有效策略；全局策略现明确为 `AuthenticationMethods publickey`、`PubkeyAuthentication yes`、`AuthorizedKeysFile .ssh/authorized_keys`、`PasswordAuthentication no`、`KbdInteractiveAuthentication no`、`PermitEmptyPasswords no` 与 `PermitRootLogin no`。
- **剩余门禁**：D-119/D-120 的 SSH 项已经闭合，但 #36 整体仍为 GAP。OS 与腾讯云防火墙最终规则及验收、维护窗口重启和重启后 SSH/TAT/Nginx/systemd/监听复核、verifier/Certbot 安装验收仍须分别决定和授权；#37 的生产目录、TAT 发布、账本、Nginx 站点、激活与公网闭环继续暂停。现有快照未执行恢复演练，恢复或删除也未授权。

## 2026-07-30 — #36 控制面、加固前快照与额外身份可逆禁用（仍为 GAP）

- **升级意图**：用户确认 2026-07-29 现场核验窗口内观察到的系统包升级是本人有意执行，接受当前已升级包状态；该确认解除异常变更调查分支，但不授权重启。当前加固前恢复点已经建立，维护窗口、明确重启授权和重启后 SSH/TAT/Nginx/systemd/监听复核仍须单独闭环。
- **控制面结论**：用户提供脱敏逐项结果，确认目标实例与生命周期、快照能力/配额、控制台恢复入口、TAT/任务、代理保留及账号保护未发现阻断偏差；管理入口为来源受限状态，公网 Web 入站尚未开放，未发现其他或 IPv6 入站暴露。通用端口自检对这些最小暴露状态给出的警告不要求扩大放行。
- **带宽告警残余风险**：控制面另报告一条历史出带宽告警。只读时间线证明它与有意包升级不重合，废弃旧站清理实际发生在告警之后；补充内网监控只显示短时入向峰值后恢复，历史系统采样未显示持续高出带宽，当前无未知公网/Web 监听或 failed unit。由于没有历史逐进程流量留存，单次告警仍不能确定归因；用户按 D-116 决定不再继续追查并接受仅限该事件的残余不确定性，因此它不再阻断 #36。未来复发、持续异常或新未知监听/进程仍重新失败关闭。
- **加固前快照**：用户按 D-117 为升级及旧站清理后、加固前的当前系统盘创建了新快照，并确认腾讯云控制台终态成功/正常。该证据闭合快照存在与当前状态，不等于恢复演练；精确快照和实例标识不写入仓库，后续每次依赖该回退基线实施变更前仍须确认快照存在且正常。
- **额外管理身份处置**：用户先按 D-118 选择方案 1，随后在确认快照正常后明确授权执行。root-only 事务入口先复核唯一候选、首启来源、无活动会话/进程/定时任务/linger/systemd 引用/业务目录所有权、无特权组和唯一受控直接 sudo 规则，再原子移除该规则、保持密码字段锁定并设置账户过期、把登录 shell 改为系统 `nologin`；账户、home、密钥和其他文件均不删除。事务在 180 秒提交窗口内由第二条 SSH 独立验证当前管理员 `sudo -n`、`sshd -t`、非目标配置、运行时和 sudo 图后才提交；持久化回执确认 `committed` 后清理私有回滚材料。
- **后验与下一门禁**：最终脱敏后验证明目标身份没有活动引用或业务所有权、无特权组或 sudo 能力、shell/过期终态正确，home 仍存在且事务前后摘要一致，passwd/sudoers/sshd 与运行时基线有效；当前管理 SSH/sudo 未受影响。快照仍未授权恢复或删除，重新启用或删除该账户/文件也未授权；SSH 全局策略随后已按 D-119/D-120 达到 `committed_clean`，OS/腾讯云防火墙、软件、服务、维护重启、verifier/Certbot、#37 和 GitHub/Git 操作仍须分别决定和授权。#36 下一项最小门禁应从防火墙最终闭环、维护重启或 verifier 安装中按依赖顺序另行确认，#37 继续暂停。

## 2026-07-29 — #36 生产服务器第一阶段只读核验与废弃旧站清理（GAP，待控制面和加固授权）

- **授权与范围**：在已核对 SSH host key 的生产 alias 上，按 D-113 只使用非交互登录和 `sudo -n` 完成系统/架构/资源、全部监听与进程、软件/服务、账户与权限、SSH 有效配置、操作系统防火墙、TAT/云代理、生产目录、系统 Python 和 verifier 安装前基线的脱敏只读盘点。公网 IP、主机名、用户名、实例 ID、密钥/指纹、来源地址、进程参数和精确可利用安全姿态只留私密现场记录；未访问腾讯云控制面，未调用 tccli/TAT API，未操作 DNS/TLS/artifact/release，也未写入 GitHub Issue、设置或其他远端状态。
- **现场结论**：Ubuntu 24.04、`x86_64` / `amd64` 和 Python 3.12 符合已确认基线；CPU、内存和系统盘容量已记录，但没有已批准阈值且仍待控制面套餐交叉核对。未发现主站源码、Node/npm、`node_modules`、数据库、容器或开发服务。Nginx 与 TAT 本机组件存在；额外交互身份已归因为首启用户数据创建，腾讯云监控/安全/防火墙进程已归因为 cloud-init/Tencent 本地组件且没有新增公网监听，但在该次 2026-07-29 盘点时身份/代理保留、SSH 与系统防火墙仍有阻断性偏差。canonical GitHub 仓库已只读核验为 public；当时控制面地域/镜像/套餐、续费、快照、轻量防火墙、TAT online 和 GitHub environment protection 能力仍未核验。
- **废弃旧站清理**：盘点发现此前部署的独立静态站。用户确认可删除并按 D-114 精确授权 Web Root、专属 Nginx 配置和唯一启用链接的不可恢复清理；前置类型、引用、链接、文件树和文件系统边界均通过，先停用并 `nginx -t`/reload、确认 TCP 80 退出后才删除配置与内容。最终三个目标均不存在，父目录保留且为空，Nginx active、零 server block、TCP 80/443 无监听。首次入口把删除子目录必然造成的父目录链接计数减一误判为漂移，故删除后返回非零；没有重跑删除，独立只读终态复核证明实际成功。
- **继续归因与状态漂移**：后续只读证据确认额外高权限身份当前未发现活跃用途；本机代理来源已解释，控制面核验后用户决定本轮保留 TAT 与腾讯云代理。核验窗口内另观察到当前管理身份发起并完成系统包升级，该动作不由本轮只读探针执行且不在 D-113 授权内；升级后的关键服务与配置复核通过，但补丁终态仍要求单独维护重启。精确认证、授权和补丁姿态只留私密现场记录；升级意图、加固前快照和额外身份处置已分别于 2026-07-30 收敛，维护窗口和重启仍未授权。
- **设计收口与遗留**：服务器 verifier 安装目标固定为 `/usr/local/lib/axialmuse/artifact-verifier/`，只允许在 #35 源提交进入 canonical `main` 后经单独授权传递 verifier/golden 两个精确文件，并以候选预验、身份绑定回退和明确提交点完成首次安装；本轮没有安装。预期 production release/current/账本目录现场不存在，该缺席已作为 #36 基线证据记录，其创建与 owner/mode 验收仍归 #37；远端 #36 关闭文字须先与此边界同步。#36 仍为 GAP：控制面基础结论、历史带宽风险接受、当前加固前快照、额外管理身份处置和 D-119/D-120 SSH 全局策略已经收敛，OS/腾讯云防火墙、维护重启和 verifier/Certbot 安装仍须分别授权；GitHub environment protection 能力也仍待核验，#37 不得提前开始。仓库仅更新非敏感文档，未新增第三方服务、浏览器外部请求或访问者数据处理，也未提交、推送、写 Issue、创建 PR 或合并。

## 2026-07-29 — #34 deploy 身份、新鲜度与受限 TAT 调度（本地候选实现完成，待外部接线授权）

- **范围与决定**：在 `codex/issue-18-production-baseline` 上直接消费 #14 `production-artifact` 的七项 job outputs，只实现仓库内身份/新鲜度核心、受控 GitHub API/TAT HTTPS、TC3-HMAC-SHA256 请求、CLI、合成 API mock 和活动 workflow 之外的静态 job/concurrency fixture。未修改 `.github/workflows/ci.yml`，未创建 `production` environment、variables、Secrets、CAM 策略或 TAT command，也未读取真实凭证或调用腾讯云 API。
- **身份与 Secret 门禁**：核心精确接受 workflow run ID、artifact ID、commit SHA、外层 `artifactDigest`、`releaseContentSha256`、repository 和 run attempt，并与当前 GitHub repository/run/attempt/SHA、canonical `main` push 及只读 API 的 branch/run/artifact 元数据交叉核对；两次读取 main 关闭核验窗口。artifact 必须属于当前 run/repository/head、名称与 ID 精确、非空未过期，REST digest 只能是 `sha256:` 加裸小写摘要。fixture 先在无 CAM Secret 引用的独立 step 完成全量预检，dispatch step 再次核验后才惰性读取 TAT access；任一反例在 Secret loader 和 TAT transport 调用前失败。
- **受限调度与并发候选**：TAT 请求固定上海地域、单一 command/instance、`InvokeCommand` 和 workflow run ID、artifact ID、commit SHA、双摘要五项参数，禁止 `RunCommand`、URL、shell、路径、额外实例/参数和结果不明时自动重试；网络读取有绝对 wall-clock deadline、响应大小/编码/JSON 上限，诊断只保留稳定脱敏 code。成功行固定为 `status: "dispatched"` 与规范 invocation/request ID，只证明调度被 API 接受。静态候选要求非 `main` CI 保留取消、`main` run 不被后续 push 中断，生产 job 固定串行且不取消；新鲜度仍由 job 自证。
- **本地证据与遗留**：五个定向 Node test 文件共 28/28 通过，覆盖 main 移动、错误 run/repository/attempt/head、同名异 ID、过期 artifact、摘要形态、Secret 前置访问、TC3 golden、完整 CLI 环境/signal 映射、动态 target、超时/中断、权限和调度绕过；固定 Node `24.18.0` 的完整零第三方依赖 `quality`、JavaScript/模块/Markdown/契约/Secret 门禁与 `git diff --check` 通过。#34 改动已形成本地提交 `2c40e87`，尚未推送、运行真实 Actions 或回填 Issue。真实接线前须核验 environment 保护、实际 command/instance、五项自定义参数与最小 CAM 权限并再次取得授权；#37 还必须在同一个持有生产 concurrency 的 job 中有界等待精确 TAT task 终态、核验服务器结果并完成本机/公网闭环，因此当前 fixture 不可直接启用为完整部署。

## 2026-07-29 — #14 fresh production-artifact producer（本地实现、验收与提交完成，待推送/真实上传）

- **范围与决定**：在 `codex/issue-18-production-baseline` 上消费 #32 的四个 prerequisite workflow 契约、#13 的同版本运行时 301 和 #33 的确定性 release 封装，按 D-110 只实现 E-015/CODE-020 的最终 producer、单次 upload 与七项 job outputs。#34 继续拥有 deploy 身份与 main HEAD 新鲜度，#35 继续拥有服务器独立 verifier，#36 继续拥有目标机清单与安装验收，#37 继续拥有 environment、TAT、不可变安装、账本、Nginx、激活和公网闭环。
- **workflow 接线**：`.github/workflows/ci.yml` 新增非 matrix、无 environment/Secret、仅 `contents: read` 的 `production-artifact`；它直接依赖四个 prerequisite，只允许 canonical repository 的 `main` push，不新增 `workflow_dispatch`。fresh checkout 在空 `build/`/`dist/` 上以主 Node 和全新 E-010 私有 cache 冻结安装，依次重跑 `quality`、独立历史门禁、`typecheck`、测试、production build、`package:artifact` 与 `check:artifact`。上传前零依赖入口先把 build/release 的内容和操作身份摘要形成当前 step 专用 seal，再使用 D-110 固定完整 commit SHA 的官方 `actions/upload-artifact` 对精确 `dist/release/` 单次上传；post-upload 门禁重新捕获两棵树并与 seal 比较，同时复核 Action 返回值、当前 HEAD 与受控源码 blob，全部通过后才映射 artifact ID/digest、release digest、repository、run ID/attempt 与 commit SHA 七项输出。
- **失败关闭门禁与本地证据**：新增 `check-production-artifact-workspace.mjs`、`prepare-production-artifact-upload.mjs`、`check-production-artifact-outputs.mjs` 及对应零第三方依赖核心，分别拒绝预存输出、隐藏的 index/source 漂移、跨 Action 的 build/release 身份变化和异常输出身份；workflow 静态检查与 `tests/build/production-artifact-*.test.mjs` fixture 覆盖仓库/事件/权限/prerequisite、fresh workspace、命令顺序、单次精确 upload、固定 Action、`assume-unchanged`/`skip-worktree`、build/release 持久替换、上传窗口 A→B→A、HEAD/状态漂移、输出形态及其他篡改反例。当前证据只证明工作区代码和本地合成 fixture 的 build/release/HEAD 七项 outputs 绑定契约，未执行 GitHub-hosted Action，也不能生成 GitHub 服务端 artifact 身份或真实 ZIP。
- **遗留与外部边界**：#14 实现已形成本地提交 `7b5cc47`，尚未推送；远程仓库暂不可用且 GitHub Actions 暂无额度，因此没有 canonical `main` 的真实 producer run、artifact ID/digest、可下载 ZIP、#35 对真实 archive shape 的复验、required checks、Issue 回填或关闭证据。未读取 Secret 或凭证，未创建 environment，未操作服务器、TAT、Nginx、DNS、TLS、账本或生产目录。未来真实上传会把已经验收的公开 payload、非公开 release metadata/Nginx 派生配置和 GitHub 自带 repository/run 元数据交给 GitHub Actions artifact 服务保留 30 天；不包含访问者、账户、评论等用户数据。

## 2026-07-29 — #35 服务器侧独立 artifact verifier（本地实现、验收与提交完成，待推送/远端验收）

- **范围与决定**：在 `codex/issue-18-production-baseline` 上消费 #33 的固定 release wire format，只实现 #35 的 artifact 外层摘要、安全 ZIP 边界、独立整树摘要和内部 metadata/清单/运行规则交叉验证。D-109 固定使用 Ubuntu 24.04 系统 `/usr/bin/python3` 3.12 标准库，生产调用为 `-I -B`；未新增 PyPI/npm 依赖、容器、Action 或服务器软件。#14 仍拥有真实 `production-artifact` producer/upload，#36 仍拥有目标机软件与权限清单，#37 只消费已验证 staging 并负责不可变安装、账本、Nginx、激活、恢复与公网验收。
- **独立校验器**：新增 `ops/deploy/verify_artifact.py`。入口只接受当前身份拥有、权限 `0700` 且初始唯一成员为 mode `0600` 单链接普通 `artifact.zip` 的规范绝对 staging root，以及 artifact 外独立传入的 `artifactDigest`、`releaseContentSha256` 和 `commitSha`。它从同一 `O_NOFOLLOW` fd 先核外层摘要，再在构造 `ZipFile` 前有界解析 EOCD/ZIP64 和最多 64 MiB central directory；预扫拒绝多盘、注释、加密、未知压缩、逃逸、隐藏/非规范路径、链接/特殊成员、重复/大小写/前缀碰撞及文件、目录、路径和字节资源超限。提取使用 descriptor-relative `O_EXCL|O_NOFOLLOW`、逐文件与目录同步，并在任何内部自报字段被信任前独立重算完整 release digest。
- **内部闭包与跨实现契约**：校验器严格复核 `files.sha256`、`release.json`、payload tree、公开 HTML route 摘要、runtime redirect 双形式/完整 canonical-slash/无链环闭包、精确 Nginx 字节和所有 count/digest；源 `redirects.json` 不进入 artifact，因此其摘要只校验形态并由外传 release digest 绑定。共享 golden 已移到 `ops/deploy/file-tree-v1-golden.json`，Node 与 Python 同时消费正向摘要和 Unicode 漂移负例。两端路径字符集固定为 Unicode 15.0 assigned repertoire，并共同限制最多 131,072 个非根目录，消除 Node 24 Unicode 17 与 Python 3.12 Unicode 15 的 NFC/小写判断漂移以及服务器独有目录上限。
- **激活、清理与中断**：正式 staging 只通过 Linux `renameat2(RENAME_NOREPLACE)` 形成，不覆盖并发或预存目标；rename 前后再次捕获整树，必须保持全部 bytes 和非根操作身份。激活、单行成功输出与 commit 状态构成屏蔽 SIGINT/SIGTERM 的线性化区：commit 前中断稳定失败并清理本事务候选，成功行写出后的 pending 中断按已提交成功处理，避免“成功 JSON + 非零退出”。发现预存 `verified-release/` 时原样保留并失败；只有 inode/owner/mode 仍证明属于本事务的候选或已激活输出才可清理，身份不确定时保留现场并报 cleanup 错误。
- **当前证据**：系统 `/usr/bin/python3` 3.12.3 以 `-I -B` 通过 6 组共享 golden self-test 和 20/20 个 artifact verifier 正常/反例测试；固定 Node `24.18.0` 通过共享 file-tree 测试与 52/52 项 release 封装回归。反例覆盖外层/整树/commit 身份替换、ZIP slip/CRC/链接/重复/祖先大小写碰撞、central directory 先验上限、manifest/metadata/规则/Nginx 篡改、staging 权限/硬链接/预存输出、`RENAME_NOREPLACE` 竞态、rename 前改字节、输出失败及 hash/提取/成功输出窗口信号。完整零第三方依赖 `quality`（含 JavaScript、模块、Markdown、契约、Secret、静态站点、重定向、供应链与全部质量 fixtures）、严格 `typecheck`、16 个 TypeScript 测试源的 253/253 Node/真实 Chromium 回归、production `build` 及 `git diff --check` 全部通过。
- **遗留与外部边界**：#35 实现提交 `f7fdc43` 已在本地形成但尚未推送，也没有远端 CI 或 Issue 回填。#14 真实上传后仍须以下载 ZIP 复验 archive shape；#36 仍须在目标 Ubuntu 核验 `/usr/bin/python3`、安装副本的 root ownership/mode 与系统能力；#37 必须在部署锁内重新验证 staging 身份和整树摘要后才可安装。未读取 GitHub 凭证，未下载真实 artifact，未操作服务器、TAT、Nginx、DNS、TLS、账本或生产目录，也未处理用户数据。

## 2026-07-29 — #33 确定性 release 封装与独立复验（已提交推送，待远端 CI/Issue 验收）

- **范围与所有权**：在 `codex/issue-18-production-baseline` 上承接 #13 已完成的 production payload/运行时 301 输入，只实现 E-015/CODE-015/CODE-020 的仓库侧 release wire format、确定性封装和独立复验。#14 继续独占 `production-artifact` producer、upload Action、artifact ID/digest job outputs 与 workflow 触发/权限接线；#35 独占服务器双摘要、安全解包和第二实现摘要复核；#37 独占 verified staging 复核后的 URL 暴露账本、安装、激活、回滚和公网验收。本轮不上传 artifact、不创建或修改 production workflow、不操作服务器、DNS、TLS、CAM/TAT 或 Nginx 现场。
- **规范文件树与 release 内容**：新增零新增 npm 依赖的 `AXIALMUSE-FILE-TREE-V1` 核心，使用域分隔、uint64 大端路径/长度 framing、原始 UTF-8 byte 排序和逐文件 SHA-256 形成 `sourceBuildTreeSha256`/`releaseContentSha256`；共享 golden 覆盖空树、空文件、非 ASCII path、原始 byte 排序和单字节变化。封装器把已重验 `build/` 逐文件复制到 `dist/release/payload/`，从同一 payload/registry 派生运行清单和 Nginx 配置，并生成字段闭合、顺序固定的 `metadata/release.json` 与无自引用的 `metadata/files.sha256`。文件数、深度、段/路径字节、单文件和整树字节上限全部以精确边界 fixture 验收。
- **输入与事务边界**：两个 CLI 都是零参数、规范 cwd、non-bare 干净 Git worktree 和稳定 `HEAD^{commit}` 入口，拒绝 dirty tracked/untracked、非仓库、bare、HEAD 漂移、旧 release、未知 dist 成员和非私有 dist。`dist/`、候选及激活占位目录固定当前 uid/mode `0700`，文件 `0600`；逐文件和自底向上目录 flush 后才经独占空占位激活，并同步父目录。build、registry、candidate、release 和 dist 均捕获字节与 `dev`/`ino`/mode/nlink/uid/gid/size/mtime/ctime 操作证据，新增、删除、改名、改字节、同字节新 inode、A→B→A 或整树替换均失败。失败输出先隔离再按精确 ownership ledger 清理；占位初始化失败、未知成员或身份漂移保持 `RELEASE_PACKAGE_CLEANUP_UNCERTAIN` 并保留现场，不按路径收养或删除外部对象。
- **真实 production verifier**：`package:artifact` 与 `check:artifact` 都先调用 `runProductionArtifactCheck`。该入口只持验证锁并保留既有 build/retired，在新的私有 transaction 中以 fresh Docusaurus `release` phase 绑定当前完整内容/静态素材 input seal，前后断言 seal 后运行既有 production artifact checker，再按操作优先清理临时 root/锁；不执行第二次 build。真实干净临时提交首次验收由此发现并修复“复用原构建 `verify` phase 但成功构建后临时 seal 已清理”的断点，证明默认 CLI 而非测试注入路径可工作。
- **CLI、质量与隔离接线**：新增 `package:artifact` 和 `check:artifact` npm scripts、release/quality CLI、JavaScript 明列语法、模块边界、统一零依赖 `quality` fixture 及 E-010 `run-script` profile。真实 CLI 要求冻结依赖已安装以复用 Docusaurus production checker；文件树/封装核心及其 quality fixture 本身不导入 npm 包，因此无 `node_modules/` 的既有 quality/pre-commit 入口保持可运行。独立 checker 从 build、registry 和磁盘 release 重建全部派生字节，成功 stdout 精确只有 `releaseContentSha256=<64hex>\n`；隔离 runner 的成功摘要改写 stderr，避免污染后续 job output。
- **验收证据**：固定 Node `24.18.0` 下，完整 E-010 `quality`、严格 `typecheck`、16 个 TypeScript 测试源的 253/253 共享测试（含真实 Chrome 回归）、production `build`、JavaScript/模块/Markdown 门禁及 `git diff --check` 全部通过；release 定向 Node 测试为 52/52。另在 `/tmp` 的干净临时 Git 提交和仓库内真实冻结依赖树上实际执行 `production build -> 默认 package:artifact -> 默认 check:artifact`，再通过 E-010 `run-script check:artifact` 精确断言 stdout digest 与 stderr 隔离摘要，完整链路通过；第二份完全不含 `.git`、`node_modules`、`build` 或 `dist` 的临时副本也通过精确 E-010 `run-script quality`，证明既有零依赖 quality/pre-commit 入口未回归。临时提交和摘要只用于本地验收，不是可部署 artifact 身份。
- **遗留与外部边界**：实现提交 `b38354b` 已普通推送到 `origin/codex/issue-18-production-baseline`；该临时 ref 不在现有 workflow 的 `main`/`dev` push 触发范围，因此没有产生该 SHA 的远端 CI，GitHub Issue #33 验收或关闭证据也尚未形成。#14 producer/upload、#35 verifier 和 #37 deploy/服务器闭环继续独立推进；pure Node 最后一次身份检查到路径式 rename/remove 的极窄同 uid 竞态继续以仓库、`dist/` 和任务临时路径无并发写者为硬前置条件。未新增 npm 依赖、Action、外部服务、浏览器外部请求或用户数据处理；本轮真实验收只复用本机已冻结依赖，没有联网下载或向第三方发送站点内容。

## 2026-07-28 — #13 production payload 运行时 301 派生与固定 Nginx Docker 验收（本地完成）

- **范围**：在 `main@195656fcbcf05fe440bc2cf9c64e27f68d2be3ab` 建立的 `codex/issue-18-production-baseline` 上推进 #13。本轮只拥有 E-014/CODE-019 的仓库侧注册表读取、公开 HTML 路由提取、规则闭包、确定性运行清单和 Nginx exact-location 配置派生，以及 D-107 授权的本地固定 digest Docker 真实 Nginx 验收；#33 继续拥有 release 封装、摘要和独立复验，#37 继续拥有服务器账本、候选安装、原子激活与回滚兼容，不把这些后续职责或生产现场验收并入 #13。
- **实现**：新增零第三方依赖的 `scripts/release/lib/runtime-redirects.mjs` 与相邻 TypeScript 声明，严格读取固定 `docs/contracts/redirects.json`，拒绝未知字段、重复 JSON key、非规范/保留路径、重复 source、自跳、链、环、当前静态 source 和 payload 中缺失 target。从同一 production `build/` 的根及子目录 `index.html` 建立规范公开路由，为每项登记生成带/不带尾斜杠的两个直达 `registered` 规则，并为根以外活动页生成 `canonical-slash`；两份输出按 `from` ASCII 排序，JSON 与固定三行 Nginx block 均不含 `reason`、时间、commit、机器路径或可变模板。
- **构建与质量接线**：production artifact checker 已移除第二套 HTML route 解析，改为经严格 TypeScript 适配器消费同一 runtime 实现和实际 payload 路由；零依赖 `quality` 新增真实注册表检查及核心 fixture，模块门禁只允许该精确适配器运行时导入，并由 E-012 临时 emit runner 复制实现、声明和传递 JSON decoder 边界。固定 registry 的质量与 production 两条入口现在共用稳定单链接普通文件读取，拒绝 symlink/hardlink，并按 CODE-003 保留 operation/close cause；compile 只接受严格 parser 产生且深冻结的 registry provenance，关闭 accessor 在校验后注入 Nginx 文本的旁路。
- **真实 Nginx 证据**：D-107 固定 Docker Official Image `nginx:1.28.3-alpine3.23` 的 `linux/amd64` child manifest `sha256:0dcc88822d45581e65ae329f8be769762bf628d3b2bb7d2a077d4aa5c98b30e3`，实际版本探针为 `nginx/1.28.3`。独立入口在空 Docker config、固定本地 socket、`--pull never`、非 root、只读、无 capability、无宿主端口和一次性内部网络下通过真实 `nginx -t`；同一派生 include 与 payload 的 25 项 HTTP/HTTPS 断言覆盖根域/`www` 四个 server、`/old` 与 `/old/`、`/projects`、原始查询串、唯一 `Location`、三个规范 target 200、source HTML 缺失、两个 HTTP ACME 200 和四个未知 Host 404。评审后，Docker/OpenSSL/HTTP/清理命令与 readiness 退避均改为异步可取消编排；SIGINT/SIGTERM 会终止并等待当前操作子进程，随后继续有界清理并以稳定中断错误失败。修复后的真实正常入口再次通过 25 项断言并确认验收容器、网络和临时目录为零残留；真实入口被定向发送 SIGINT 时以稳定中断错误和退出码 1 结束，独立标签复核确认容器与网络为空。中断 fixture 另行覆盖 SIGINT/SIGTERM 与受控资源归零，固定镜像缓存按决定保留。
- **其余本地证据**：精确 Node `24.18.0` 下，零依赖完整 `quality`、严格 `typecheck`、16 个 TypeScript 测试源的 252/252 共享测试及真实 Chromium 回归、production `build`、JavaScript 明列语法、模块边界与 `git diff --check` 均通过。核心 fixture 覆盖空注册表、golden 字节、排序/reason 不变性、双 alias、查询变量、路径/保留空间、重复/链环、source/target payload 闭包、HTML 布局、链接成员、provenance/accessor、稳定 I/O 双故障及 Docker 入口的固定身份、四 server、硬化、无端口、原始 header、异步 readiness 取消、真实父进程 SIGINT/SIGTERM 与统一自动化隔离。真实当前站点 build 派生出 `/`、`/projects/`、`/writing/` 三条公开路由、0 条 `registered` 与 2 条 `canonical-slash`；D-107 的独立非空 Docker fixture 则刻意派生 2 条 `registered` 与 2 条 `canonical-slash`，用于真实引擎行为验收，二者不混作同一输入事实。
- **遗留与交付边界**：#13 的仓库实现和本地真实引擎验收已闭环并形成本地实现提交，但尚无精确远端 CI 或 GitHub Issue 关闭证据；#33 的 release 封装/摘要和 #37 的服务器账本、现场 Nginx、激活、reload、回滚兼容与公网冒烟继续独立实施。本轮唯一新增外部访问是经用户授权从 Docker Hub 官方 registry 显式拉取固定 digest 镜像，传输常规 registry/网络元数据，不发送站点内容或用户数据；未新增 npm 依赖、第三方运行时服务、浏览器外部请求或用户数据处理，未安装宿主机 Nginx，未操作服务器、DNS、TLS 或 GitHub Issue/PR。

## 2026-07-28 — #25 显式文章日期命令（本地实现与 fresh checkout 验收完成）

- **接口与状态机**：已依 D-106/CODE-014 实现 `node scripts/author/set-article-dates.mjs --source-name <name> --action publish|revise`，不增加 npm alias。publish 只接受作者已手工切到 published 且两个日期完全缺失的窄过渡态，以一次 `Asia/Shanghai` 时钟写入相同日期；revise 永不改 `publishedAt`，同日完整校验后保持字节与 mode 不变，跨日只改 `updatedAt`。draft、archived、部分日期、时钟回退、非规范定点布局与自动化环境全部失败关闭。
- **历史与原子事务**：E-013 已增加按 articleId 保存首次规范 `publishedAt` 的 HEAD 可达 DAG ledger，覆盖建立后删除/改值、平行分支冲突、单侧继承和严格日期候选 API。日期写入复用作者/build 双锁和同文件系统 staging；完整 loader 前精确清理受控 staging，后续失败会重建可恢复原件并原子回滚。HEAD、目标、build/author lock、effect-then-throw rename、回滚父目录 flush 与所有权任一无法证明时保留阻断性现场并按 operation-first `AggregateError` 报 `AUTHOR_ROLLBACK`。
- **本地证据**：在只叠加当前完整补丁并复制同一 lockfile 冻结依赖的 fresh checkout 中，显式作者 runner 通过纯日期编辑 7/7、事务故障注入 16/16 与真实临时 Git CLI 1/1；安装后历史入口通过真实 `HEAD` 61 个提交、48/48 DAG fixture 和 2/2 frontmatter 集成；零依赖 `quality`、`typecheck`、共享 `test`（16 个 TypeScript 源、250 个测试）、production `build`、JavaScript 明列语法检查、npm 隔离反例与 `git diff --check` 均通过。真实集成逐阶段证明 publish、同日 revise、跨日 revise、完整历史、精确 Git diff、CI 拒绝和零 residue。
- **交付边界**：当前改动尚未提交或推送，也未取得远端 CI、PR 或 Issue #25 关闭证据；临时分支本地通过不能替代共享分支与远端验收。本轮未增加依赖、第三方服务、浏览器外部请求或用户数据处理。

## 2026-07-28 — #24 作者文章创建事务（临时分支交付，待远端 CI/Issue 验收）

- **主题与入口**：按用户“推进 #24”的要求，在既有 #12/E-013 候选 API 上实现 CODE-014。当前文档真相源把入口固定为 `node scripts/author/create-article.mjs ...`，并由 CODE-016 封闭 package scripts；GitHub #24 旧正文中的 `npm run content:new` 与之冲突，本轮遵循更新后的 docs，不新增 npm alias，也未写回远端 Issue。
- **实现**：新增精确 Linux `.nvmrc` 主端点、完整非交互参数、注册表引用、原生 UUIDv7、确定性 Markdown draft 模板与冻结 frontmatter 回读。事务使用根 `.axial-muse-author.lock`、同文件系统 `.author-staging-<owner>`、文件/目录 flush、整目录 rename、目标实际字节的 I-06/E-013 终态读回和 lock 删除 commit point；正常失败只清理重新证明属于本事务的 inode/bytes，无法证明时保留 lock 并报 `AUTHOR_ROLLBACK`，阻断消费者而不猜测删除现场。
- **并发与消费者边界**：零依赖只读 residue checker 已接入统一 `quality` 和 production build；build 在取得自身 lock 后再次确认作者 residue，作者命令在取得作者 lock 前后拒绝 build lock，关闭双方 preflight 后的内容读写竞争。CI、hook、package script、统一 quality、共享 test 与安装后历史 runner 的静态门禁均拒绝隐式调用真实创建 CLI 或其显式验收 runner。未来 #8 preview 仍须复用同一 checker。
- **验收**：无 `node_modules/` 的根工作区统一 `quality` 已通过；任务专用冻结依赖副本以 Node `24.18.0` 通过作者 runner 自测与单元/故障测试 33/33、真实完整 Git fixture 2/2、安装后历史 fixture 38/38 与冻结解析器 2/2、严格 `typecheck`、13 个 TypeScript source 的 223/223 共享测试及真实 production build。正常 fixture 证明唯一 Git delta、真实 production loader/E-013 读回和静默成功；删除后 source-name 复用由真实历史拒绝。反例覆盖参数/顺序/边界、未知引用、四种既有目标、preflight 与真实并发 lock、build lock 双向竞态、残留 staging、注册表漂移、部分/完整 write、file flush、source 与 destination 目录 flush、rename、终态与 lock release 回滚，以及回滚所有权失效后的 fail-closed residue/operation-first `AggregateError`。系统 Node `22.22.0` 在随机数、lock 和写入前稳定报 `AUTHOR_RUNTIME_NODE`，无绝对路径或堆栈。
- **边界与遗留**：真实 `topics.json` 仍为空，本轮只在临时 Git fixture 登记测试 author/topic；未修改公开注册表、未创建真实文章、未新增依赖/第三方服务/浏览器请求或用户数据处理。D-103 已授权把完整 #24 补丁作为单一提交普通非强制推送到当前专题分支的同名临时 ref；该 ref 不触发现有 CI，#12/#24 的远端 CI/Issue 闭环仍未取得，也未授权同步远端 Issue 文本或状态。

## 2026-07-27 — D-097 至 D-102 可信 CI、#12 与 #32（临时分支交付，待远端 CI 验收）

- **主题与授权边界**：用户确认按“可信 CI → `main` required checks/合并门禁 → immutable production artifact 与 GitHub `production` environment/审批 → TAT/Nginx 部署、回滚、公网冒烟和定时检查”推进；D-100 进一步授权从精确基点 `9df4ba5678fc251d4882df5d5867e6d4990789e7` 创建 `codex/ci-issues-12-32` 并本地提交当前 CI、#12、#32 闭环。D-101 又窄幅授权把该分支普通非强制 push 到 `origin` 同名临时 ref 并设置 upstream；仍不授权 fetch/pull/rebase/merge/force push、PR、Issue 写操作、`main`/`dev` 变更或任何其他远端/生产操作。
- **工作区实现**：`.github/workflows/ci.yml` 已形成失败关闭的 `website-quality`、`node-minimum`、`diagrams`、`supply-chain` 四个 job；三个 GitHub 官方 Action 以已核验 commit SHA 固定，Node `24.18.0`/npm `11.16.0` 与 Node `24.16.0`/npm `11.13.0` 两个构建 job 使用完整 checkout、关闭凭证持久化、E-010 隔离冻结安装，并独立执行零第三方依赖 `quality`、安装后 E-013 历史门禁、`typecheck`、`test`、production `build`。D-102 修复了历史门禁进入 `quality` 后导致无 `node_modules/` 的 pre-commit 失败的问题；真实历史 CLI、38 个 DAG fixture 与 2 个冻结解析器集成 fixture 通过同一安装后入口在双端点失败关闭。工作区同时包含 workflow 字节级契约/逐 job 反例和静态供应链证据；`diagrams` 会在 Java/下载/编译前精确断言实际 Node 等于 `.nvmrc`。
- **当前验证证据**：仓库根保持无 `node_modules/`，真实 pre-commit 由 nvm `0.40.6` 选择 Node `24.18.0` 后通过完整零依赖 `quality`，其中 decoder 13/13、E-010 59/59、#32 workflow fixture 14/14 和 1,225 项供应链静态闭包均通过。两个既有冻结依赖副本分别在 Node `24.18.0`/npm `11.16.0` 与 Node `24.16.0`/npm `11.13.0` 通过安装后独立 E-013 runner：真实 CLI 检查完整 HEAD 可达历史，历史 fixture 38/38，冻结解析器集成 fixture 2/2；最低端点还通过当前完整零依赖 `quality`。D-098 的两个全新任务私有副本此前分别在上述双端点经 E-010 只连接官方 npm registry、使用独立 HOME/config/cache、禁用安装脚本完成同一 lockfile 的冻结安装，各安装 1,298 个包；两端随后均通过当时完整 `quality`、严格 `typecheck`、13 个 TypeScript source 的 223/223 测试和 production `build`。D-099 拆分前又在独立主端点副本通过当时仍内含历史门禁的完整 `quality`（CI 契约 14/14、内容历史 37/37、E-010 58/58）；这些旧计数只记录当时快照，不代表 D-102 当前命令拓扑。安装前后 `package.json` 与 lockfile SHA-256 精确不变，仓库根未生成 `node_modules/` 或构建制品。
- **D-098 处置结果**：公开路径泄漏的根因是 `docusaurus.config.ts` 曾把 E-008 私有绝对 `staticDirectory` 交给固定 Docusaurus 3.10.2，而框架会把完整 `siteConfig` 生成到浏览器模块。方案 1 已实现：保留私有随机白名单树，根配置固定 `staticDirectories: []`，由仅服务端的既有内容插件在 `postBuild` 中逐文件安全复制到候选制品，随后才写私有日期索引与输入 seal；最终 checker 独立拒绝仓库根、generated files、候选输出和受控构建/事务临时路径。两个不同私有根的真实 build 各生成 9 个文件，均无上述路径；本次两端逐文件 SHA-256 恰好一致，但该观察不升级为跨 runner 或长期完整制品可复现保证。
- **联网 audit 事实与 D-099 处置**：官方 npm live audit 已真实执行；当前 1,345 个依赖节点中为 18 个 high、0 个 critical。严格报告只发现一条结构化 advisory（`brace-expansion` 的 `GHSA-mh99-v99m-4gvg`），经 `minimatch`、`serve-handler` 扩散到 Docusaurus 依赖节点；直接受影响根为 `@docusaurus/core` 与 `@docusaurus/preset-classic`，本次 npm 报告对二者均给出 `fixAvailable: false`。原始响应和 receipt 保存在权限 `0700`/`0600` 的任务私有临时目录，普通日志只输出聚合结果。用户随后要求普通 CI 不被 live audit 阻断；D-099 据此把该联网步骤从普通 push/PR workflow 直接移除，没有使用 `continue-on-error` 或改变审计脚本、漏洞阈值。上述 18 个 high 仍是未修复风险，由 Dependabot Alerts 与人工依赖维护跟踪；依赖首次准入或图变化后的重准入仍按 D-077 失败关闭审计。
- **Git 与后续门禁**：D-101 的同名临时 ref 不在现有 workflow 的 `main`/`dev` push 触发范围内；临时分支交付不产生对应新 run，也不替代远端 CI 验收。D-099 不修改 manifest、lockfile、admissions 或供应链制品，也不执行依赖更新；第一阶段仍须以后续获准集成后的真实 GitHub run 验收，随后才能另行决策第二阶段 required checks/ruleset。第三阶段 immutable artifact/上传 Action/`production` environment/审批，以及第四阶段 TAT/Nginx deploy、回滚、公网 smoke 与 scheduled checks 均未实施；preview 不属于本阶段。

## 2026-07-27 — #28 关闭后审查修复与可重复真实浏览器回归（完成）

- **范围与历史基线**：[Issue #28](https://github.com/lyty1997/AxialMuseWebsite/issues/28) 的原实现提交 [`255fe98f494344aca400d5a48a5d19ccb425183d`](https://github.com/lyty1997/AxialMuseWebsite/commit/255fe98f494344aca400d5a48a5d19ccb425183d) 及精确 [CI run 30244831021](https://github.com/lyty1997/AxialMuseWebsite/actions/runs/30244831021) 已完成主题、三档详情布局与原生折叠，状态证据提交 `1f8e71c72b8f5c9f4c3c884265ef01e60a0badb9` 的精确 CI run `30245505827` 也成功。本轮按用户要求审查 #28 新增设计和实现、修复已知问题、补可重复真实浏览器回归并更正完成声明；不抢跑 #8、#12 至 #14，不修改 workflow、依赖图、公开业务事实或基础设施。
- **关闭后缺陷修复**：第一批修复提交 [`6345bb1703000f2f72bcf4a0e71e9b960cf430ab`](https://github.com/lyty1997/AxialMuseWebsite/commit/6345bb1703000f2f72bcf4a0e71e9b960cf430ab) 收口 reduced-motion 被框架高特异度 transition 覆盖、H4-only 页面空 H2/H3 目录壳、正文链接缺少持久非颜色提示、项目目录首图错误 lazy、`996px` 框架/自定义边界错位、非零字距偏离令牌基线、隐式 `/favicon.ico` 404，以及构建后 Infima 双 ID 选择器优先级；其精确 [CI run 30266019758](https://github.com/lyty1997/AxialMuseWebsite/actions/runs/30266019758) 的 `Website quality gates` 与 `Diagram compile check` 均成功。第二批提交 [`e04085b837c93db9f639ab014ad99c829b270194`](https://github.com/lyty1997/AxialMuseWebsite/commit/e04085b837c93db9f639ab014ad99c829b270194) 根据实现前真实基线和锁定 Docusaurus `3.10.2` 源码补齐小屏全站导航 Escape 关闭与焦点归还；它只用同路径 `Navbar/Layout` 包装在 hydration 后调用框架原关闭按钮，不复制导航结构或状态。该提交的精确 [CI run 30270312057](https://github.com/lyty1997/AxialMuseWebsite/actions/runs/30270312057) 同样由两个 jobs 完成且成功。
- **本地代码门禁**：最终树在任务私有 WSL Ubuntu 环境使用 Node `24.18.0` 通过 74 个 TypeScript 文件的模块边界、production 与 tests 两套严格 `tsc --noEmit`，完整 `run-quality.mjs` exit 0。`run-tests.mjs` 共 238 项、237 通过、0 跳过；唯一非零项是 WSL 没有可发现 Chromium 时真实浏览器入口按契约显式返回 `[BROWSER_UNAVAILABLE]`，不是跳过或伪造通过。`package.json` SHA-256 保持 `7b089fd3df1b14f8c7117fa4608d895f5fb7327528281f20274df2e068ccf82c`，`package-lock.json` 保持 `fae564f5a83ceaf4f5d57118192779a2679f5380403d0a79d33f409d75dc01aa`。
- **可重复真实浏览器回归**：`tests/build/browser-regression.ts` 复用 `tests/build/public-presentation-build.test.ts` 的 production 公开内容 fixture，以 Node 内置 WebSocket 直连本机 Chromium DevTools Protocol，不增加 npm 依赖、远程浏览器或下载回退。最终编译入口 SHA-256 为 `7d62100a652784aa1fa47716c599eaae609056694c9fb405caea86b149667641`；Windows Node `24.15.0` / Chrome `150.0.7871.125` 对同一构建制品连续两次通过，11 项回执为 `320px-overflow`、`failed-project-image-layout`、`h4-only-empty-toc`、`hydration-ready`、`keyboard-details`、`keyboard-navbar-escape`、`no-hydration-static-content`、`priority-project-image`、`prose-link-decoration`、`reduced-motion`、`text-only-200-percent`。固定详情路由覆盖 `1440x900`、`1024x768`、`768x1024`、`360x800`，边界另覆盖 `995/996` 与 `1279/1280`；`320x800` 逐页验证 `/`、`/projects/`、`/writing/`。图片请求暂停后强制失败时仍保留 `1600x1000` 的 `8:5` 占位，图片和标题位置变化均不超过 `0.5px`；禁用 JavaScript 时首页主标题/项目动作、详情正文及两个原生目录仍可见，原生目录可由键盘展开；移动导航可由真实 Enter 打开、Escape 关闭并把焦点归还 toggle。正常路径 console、失败请求、HTTP 错误和非本站请求均为零；故障注入只接受精确本地 WebP/JS 失败，且未产生外部请求或页面级溢出。
- **截图回执**：两次运行的截图字节与 SHA-256 完全一致：`1440x900` 为 `32101 / 4bf348d3a0d4159ea1ab077910fe229eea930d621888a8c2151e93baaa845b14`，`1024x768` 为 `23518 / cf91a825b21f5c0f2de8a897fddf5cf0ca17ed337c4ebeb155e37d827002e382`，`768x1024` 为 `24894 / 294d3b683c3d7cb7f0750e1d7a935b5cc6d19456f7a3b188dd87f81981312faa`，`360x800` 为 `15008 / f7299c7fb6b4298c3066d7ff02c80c88f75409def63125403ff711cfdcca6122`，`995x800` 为 `21813 / 4ba71c1e28ff82a4577a33884de0c193cbe74b292505eb81eb8aea46070a3970`，`996x800` 为 `23459 / 59c7aae59d908e5e5e2339b36cdfbd61b71b85bc2228a7be67afcb9f3846a85d`，`1279x800` 为 `25310 / 25894fa99acac41fcb6ba3651a44f6dd2cd762542b1288e2806b739f5744628b`，`1280x800` 为 `28696 / 7e1dbd945dc5006a57400feebe4823ccbb7054e6dbc2fb6eeb483107d60752bb`。回执只含固定 route、视口、字节数和摘要，不持久化截图或本机路径。
- **完整性与遗留**：最终主审查未发现仍属于 #28 的实现或设计缺陷；`DocRoot/Layout`、`DocItem/Layout`、`Navbar/Layout` 三个最小包装和既有内容投影继续作为 #8、#12 至 #14 的稳定接口。截至 #28 闭环时，`.github/workflows/ci.yml` 只运行质量与图表 jobs，尚未执行 TypeScript 测试入口或真实浏览器回归；后续 #32 接线见上方专题分支条目，整合后的远端 run 仍须以 `dev` 精确 SHA 证明。本轮未新增、升级或删除依赖，未引入第三方运行时服务、用户数据处理、workflow 或基础设施变更；`favicon: "data:,"` 只是零字节无品牌素材哨兵。

## 2026-07-26 — #27 远端闭环与关闭后审查补验（完成）

- **前置与范围**：#26 的唯一实现提交 `91dd3c7d4b8553910418119d7ee8e677974fe01a` 已只推送到 `origin/dev`；精确 GitHub Actions run [29970675298](https://github.com/lyty1997/AxialMuseWebsite/actions/runs/29970675298) 为 `completed/success`，逐条验收已回填到 [Issue #26](https://github.com/lyty1997/AxialMuseWebsite/issues/26#issuecomment-5053204249)，Issue 于 2026-07-23 关闭且该提交随后已进入 `main`。用户已按 D-091 切换到 Codex Desktop 并明确要求推进 [Issue #27](https://github.com/lyty1997/AxialMuseWebsite/issues/27)；本轮按 D-092 只实现 M0 首页、目录/详情公开表达、全站导航/页脚和统一 SEO，不抢跑 #28、#8，不创建或合并 `dev -> main` PR，也不操作 workflow、部署或生产基础设施。
- **实现闭环**：首页、`/projects/`、`/writing/` 已使用 Docusaurus 展示层和同一安全 global data 投影；项目与文章目录组件同时支持真实公开详情和当前空状态。全站导航固定项目、技术分享、路线、关于与 GitHub，页脚固定站点名、GitHub、ICP备案和版权。统一 `SeoMetadata` 以站点配置为唯一 origin，固定 title、description、canonical 与 Open Graph；项目/文章主题包装保留官方同路径实现并追加安全显示字段。production checker 已逐页锁定 `zh-CN`、单一 H1、SEO、导航页脚、固定公开文案、目录卡片及卡片外可见内容的精确闭包、详情投影、项目图片、禁用交互和零内容路由集合。
- **真实内容边界**：`docs/contracts/projects.json` 中两个项目均为 `planned` 且没有已批准主预览，当前也没有技术文章。因此 production 只生成 `/`、`/projects/`、`/writing/` 与框架 404，两个目录显示经确认的可信空状态，不生成 planned 项目详情、入口或 sitemap 项；公开项目/文章正常路径由任务自含 fixture 验证。
- **本地验收证据**：本机 WSL Ubuntu 的任务私有副本使用已校验的 Node `24.18.0` / npm `11.16.0` 和官方 registry 冻结安装；安装前后 `package.json` SHA-256 均为 `7b089fd3df1b14f8c7117fa4608d895f5fb7327528281f20274df2e068ccf82c`，`package-lock.json` 均为 `fae564f5a83ceaf4f5d57118192779a2679f5380403d0a79d33f409d75dc01aa`。最终隔离 `quality` 通过并覆盖 67 个 TypeScript 文件、模块边界 fixture 38/38；严格 `typecheck` 通过；15 个 TypeScript 测试源、227/227 子测试通过。新增的真实公开内容测试在任务私有临时镜像中接入一个归档项目、一篇公开文章和一篇归档文章，复用冻结依赖运行原始 production 构建入口，并逐页断言首页、目录、详情主题包装、统一 SEO、sitemap 和 WebP 制品；当前零公开内容的受控 production `build` 及独立最终制品验收同样通过。真实浏览器复核首页、项目页和技术分享页，三条公开路由均为单一 H1、空状态正确，活动 form/input/iframe/video/object/embed 全为 0，控制台日志为空，整页样式资源正常。
- **对抗收口与完整性**：真实构建依次暴露并修复了 TSX 显式 `.js` 说明符无法解析、普通 HTML `id` 未进入 Docusaurus broken-anchor 集合，以及 planned 项目 `showcaseMode=repository` 与合法 `repositoryUrl` 字段名的字节子串误报；最后一项只从未发布证据中排除该精确模式枚举，新增零公开内容回归证明字段名可通过，而 planned 项目的仓库 URL、ID、完整路径、标题、摘要、契约源、加载源路径和正文仍逐项失败关闭。提交前独立审计又发现无链接占位承诺、扩展登录/上传/演示按钮文案和体验域名拒绝异常传播旁路；现已分别由静态页/卡片可见内容闭包、按钮动作上下文词根门禁及 URL 解析后独立拒绝收口，并覆盖 DNS 根点反例。本轮未新增、升级或删除依赖，未引入第三方运行时服务或用户数据处理。
- **远端闭环与关闭后补验**：#27 实现提交 [`4d436c1ea53c957f66f147565bcc96b6c98f8b36`](https://github.com/lyty1997/AxialMuseWebsite/commit/4d436c1ea53c957f66f147565bcc96b6c98f8b36) 已只推送到 `origin/dev`，精确 [CI run 30203875055](https://github.com/lyty1997/AxialMuseWebsite/actions/runs/30203875055) 成功，验收回填后 Issue 于 2026-07-26 关闭。关闭后的审查修复 [`0fb38b20b8b576e53b238ab65f4ed964b52f0728`](https://github.com/lyty1997/AxialMuseWebsite/commit/0fb38b20b8b576e53b238ab65f4ed964b52f0728) 补齐项目/文章安全关系链接投影、展示与 production 制品精确闭包；其精确 [CI run 30229220799](https://github.com/lyty1997/AxialMuseWebsite/actions/runs/30229220799) 的质量和图表 jobs 均成功。随后以该精确远端基线在同 manifest/lock 的任务私有 Ubuntu 独立字节副本中使用 Node `24.18.0` / npm `11.16.0` 复跑隔离 `quality`、严格 `typecheck`、15 个测试源 232/232 子测试和受控 production `build`，全部 exit 0；真实浏览器复核三条实际公开路由的单一 H1、可信空状态、本地制品资源、零活动表面、空 console 和首页无水平溢出。补充证据已回填到 [Issue #27](https://github.com/lyty1997/AxialMuseWebsite/issues/27#issuecomment-5086766689)，#28 已解锁。

## 2026-07-24 — #46 逐项收口与远端闭环（完成）

- **主题**：逐项实现、复核并验收 #46 的原生子 Issue；不把 #8 或相邻未列风险暗中并入本轮。
- **用户授权**：
  - 允许在任务私有 `/tmp` 副本中通过 E-010 联系官方 npm registry，以冻结 lock、禁用 lifecycle scripts 和 audit 的方式安装既有依赖；允许在需要时从 Node.js 官方源下载并校验既定最低端点 Node `24.16.0`，在主/最低端点运行同一测试、类型检查和 production build。不得修改 manifest/lock，不在仓库根创建 `node_modules/`，结束后清理任务副本。
  - 上述验收全绿后，允许提交并推送到 `origin/dev`，观察精确提交 SHA 的 CI，向 #47–#52、#54、#49 和父 #46 回填证据并完成关闭处置；#53 保持 `not planned`，#8 保持在 #16 路线中。
  - 允许把本轮独立审计确认的相邻 operation/close 双故障错误保真风险建立为不挂 #46 的后续 Issue；本轮不暗中修改这些相邻路径。已据此建立 [#55](https://github.com/lyty1997/AxialMuseWebsite/issues/55)，只跟踪 `file-safety.ts` 两个共享同一不变量的安全读取事务边界。
- **已完成的本地证据**：
  - #47 经五轮对抗审计收口；最后一轮额外发现并修复 `debugger`、无分号 static import/named export、无 initializer `let|var` 及 async/generator object method 的 slash-goal 结束态。模块门禁 36/36、真实 49 个 TypeScript 文件、`check:js` mutation 和 5 种换行形态组成的 80/80 独立合法样例通过；仍有词法歧义的受控子集外输入稳定报 `MODULE_BOUNDARY_PARSE`，不再静默吞掉模块 token。
  - #48–#52、#54 的正常与反例 fixture 已实现并独立复核；Node 24 补充运行时验证分别为 32/32、15/15、34/34。
  - E-010 隔离 `quality` 总入口通过，供应链静态闭包仍为 1,225 项；仓库根无 `node_modules` 或构建锁。
  - 任务私有副本已按 E-010 从官方 registry 完成冻结安装；Node `24.18.0` / npm `11.16.0` 与最低 Node `24.16.0` / npm `11.13.0` 对同一工作树分别通过完整 `quality`、严格 `typecheck`、209/209 测试与 production `build`。两端隔离入口均报告官方 registry、全新缓存和隔离配置，安装前后 `package.json` 与 lockfile SHA-256 精确一致；仓库根仍无 `node_modules` 或构建锁。
- **远端闭环**：
  - 实现提交 `c766279a16ec8aa4b4204bd13c5c30b4e4d0dcf5` 已只推送到 `origin/dev`；精确 SHA 的 GitHub Actions run [30099114683](https://github.com/lyty1997/AxialMuseWebsite/actions/runs/30099114683) 为 `completed/success`，`Website quality gates` 与 `Diagram compile check` 均成功。
  - #47–#52、#54 已分别回填独立正常/反例、双 Node、提交与 CI 证据并以 `completed` 关闭；#53 保持 `not planned`。GraphQL 读回确认 #46 的 8 个原生子项已 8/8 完成处置，父 [#46](https://github.com/lyty1997/AxialMuseWebsite/issues/46) 随后以 `completed` 关闭。
- **完整性与后续**：本轮未新增、升级或删除依赖，未引入第三方运行时服务、浏览器外部请求或用户数据处理。#8 继续归 #16 并保持开放；相邻 `file-safety.ts` 风险由独立 [#55](https://github.com/lyty1997/AxialMuseWebsite/issues/55) 跟踪，不属于 #46 的遗留缺陷。

## 2026-07-24 — dev 分支代码审查（#46）、二次复核与拆解

- **主题**：对 `dev` 相对 `main`（7 提交、89 文件、HEAD `91dd3c7`）做代码审查，并逐条对照 `docs/`、真实输入闭包和可达错误路径二次复核；本次只修订跟踪口径和文档，未改源码。
- **完成内容**：
  - **审查方法**：6 个 finder 分角度扫描得 60 候选 → 每个 `(file,line)` 派独立 verifier 复核 → 53 项存活、7 项驳回；再对存活项逐条对照设计真相源。只读代码、不查设计的第一轮在本仓容易把 D-075 分层隔离、D-077 零依赖和 E-016 防漂移形态误判为缺陷，后续审查必须保留设计核对。
  - **二次复核结论**：原“10 项待修缺陷”更正为 **7 项真实缺陷 + 3 项澄清/维护议题**；21 项既定设计的非缺陷结论不变。复核期间另确认 `production-artifact-check.ts:187` 在 operation/close 双故障时丢弃主错误，单建 [#54](https://github.com/lyty1997/AxialMuseWebsite/issues/54)。因此 [#46](https://github.com/lyty1997/AxialMuseWebsite/issues/46) 当前共跟踪 **8 项确认缺陷，其中 1 项为原清单外的后续发现**。
  - **GitHub 处置**：#47–#54 已建立为 #46 的原生子 issue。原清单 7 项缺陷由 #47（覆盖原第 1/7/8 项）、#48、#50、#51、#52 跟踪；#54 跟踪后续独立缺陷。#49 改为低优先级 `enhancement` / hardening；#53 撤回与 HTML 无关的 `spec:401` 依据，改为 `enhancement + question`，不再执行旧“直接合并为单实现”决定；#8 已有父 issue #16，继续用评论与 #46 交叉链接，并把版本级 `noIndex` 澄清为 preview 实现期集成选择，最终制品全页 noindex 且无 sitemap 才是 E-009 验收。
  - **保留的既有决定**：#48 上限取 2048（登记侧复用 `MAX_SOURCE_FILES`）；`deepFreeze`/摘要长度帧去重接受现状；第四节 18 项轻微清理整体推迟，`loader.ts:333` 明确不修。
  - **文档**：本条 progress 已按二次复核口径更正；`docs/operations/maintenance.md` 的“构建锁残留”人工恢复步骤保留，锁语义仍是 E-016 既定设计。
- **遗留项**：
  - 必修缺陷尚未实现，可按 #47 → #51/#54 → #52 → #50 → #48 逐个闭环；#49/#53 不阻塞，#53 是否做共享 tokenizer/event 层维护重构仍需另行确认。
  - #8 仍按既有 roadmap / blocked-by 推进真实 preview；不得把版本 metadata 断言替代最终制品验收。
  - CI 未运行目标 Node 24 `.test.ts` 与真实 `build` 属已声明的迁移前状态，由 #32 跟踪，卡在 GitHub Actions/CI 外部接线授权，不计为本分支新缺陷。

## 2026-07-23 — #7 远端闭环与 #26 本地实现/验收中

- **#7 关闭证据**：I-12 精确提交 `7f2115d9f1dc5396ca0c81fc9960223644d79725` 已只 push 到 `origin/dev`；该 SHA 的 GitHub Actions run `29950131762` 为 `completed/success`。逐条脱敏验收已写入 [GitHub #7 评论](https://github.com/lyty1997/AxialMuseWebsite/issues/7#issuecomment-5050422648)，Issue 随后以 `completed` 关闭。
- **语义压缩与依赖链**：#26 只继承 #7 已验证的 production/preview 静态素材计划、受控构建上下文、未发布正文素材私有快照接口和目的限定的 production 泄漏判定；#26 原子拥有单一 docs 实例、真实内容扫描、frontmatter 投影、侧栏、日期索引、global data 与 production Docusaurus 装配。#8 继续独占 preview `build --dev`、全站 noindex、无 sitemap 和持久候选激活，#33 独占 release 身份、整树摘要与封装。
- **E-016 current-only 实例**：#26 本地实现以 `site-content/` 为唯一 docs 物理根、`routeBasePath: "/"`，选项精确为 `includeCurrentVersion: true`、`onlyIncludeVersions: ["current"]`、`tags: false`。不得使用 `disableVersioning: true`；Docusaurus 3.10.2 在没有版本清单时会拒绝该组合。扫描器同时拒绝 version roots、localized 第二内容根和 category metadata，不能用条件 `docs:false`、占位文档、额外实例或框架默认推断绕过。
- **公共装配契约**：`src/build/content/index.ts` 只公开 `loadValidatedContent`、`createParseFrontMatter`、`createSidebarItemsGenerator` 与 `createContentDataPlugin`；根侧栏稳定名称为 `projectsSidebar`、`writingSidebar`，安全 global data 键为 `projectNavigation`、`writingNavigation`。日期索引只在 browser bundle 完成后的本地插件 `postBuild` 中，以私有临时普通文件写入并原子 rename 到本次 `generatedFilesDir/axial-muse/article-date-index.json`；独立 checker 再按 fresh session 的同一投影逐字节核对。它不能进入最终 `build/`、global data、公开 route 或浏览器 bundle。
- **三阶段 production build**：受控入口在仓库级独占锁内依次完成“候选 Docusaurus build → 候选路径 fresh checker → 可回滚切换并在最终 `build/` 路径再次 fresh verify”。两次 checker 都创建全新 session、重新扫描并核对同一输入摘要；该摘要域分隔合并内容批次与全部公开/未发布静态计划语义、长度和字节摘要，不会在非公开预览换字节后放行旧字节候选。切换不是 POSIX 单 syscall 目录交换。commit point 前任一步失败都恢复调用前的有效 `build/` 或原先不存在状态，并把失败候选移入唯一 retired/quarantine 隔离路径；retired 只能在下一次取得锁后、任何新改动前回收。该流程不生成 #33 的 release 身份、摘要或封装。
- **当前本地验收**：Node `24.18.0` / npm `11.16.0` 与最低 Node `24.16.0` / npm `11.13.0` 已对最终同一快照通过严格 `typecheck`、13 个 TypeScript 测试 source、203/203 个逻辑子测试、完整 `quality`、49 个 TypeScript 文件的模块边界和真实 Docusaurus production build。当前两个 `planned` 项目正文可在不伪造公开 doc、路由或 sitemap 项的前提下完成装配。独立全新 fixture 再以两个公开项目、两篇公开文章和一篇 draft 文章证明 4 条唯一详情路由、两组精确侧栏、4 个 canonical、首页加 4 个详情的 5 项 sitemap、每项目唯一且属性精确的 SSR `<img>`、公开 WebP 源/制品哈希一致、browser global data 只有公开 docs 且 `draftIds: []`、五类 draft token 零泄漏，以及权限 `0600` 且未进入 `build/` 的私有日期索引；最终 fixture build 整树 SHA-256 为 `d240e69ba15e16b3c5a2bb8ad76601339242fb5e43a7ad64a39236acf4d82b75`。重复文章 slug 与缺失公开项目预览均失败关闭并保持旧 build 的摘要和 inode；final verify 建 plan 后对物理静态树改字节、增成员、删成员的确定性 seam 也全部以 `STATIC_ASSET_SOURCE_DRIFT` 拒绝并保留旧 build。PlantUML 3 个源码块编译通过，三份 SVG 重新渲染逐字节无需更新。本节不宣称 #26 已提交、push、取得远端 CI 成功或关闭 Issue。
- **完整性与遗留**：#26 未新增依赖、第三方运行时服务、浏览器外部请求或用户数据处理；最终独立只读审查无 P0/P1/P2。精确提交、`origin/dev` push、精确 SHA CI、验收评论与 Issue 状态仍须在真实发生后完成。

## 2026-07-23 — #6 远端闭环与 #7 本地验收历史快照（后续已远端闭环）

- **#6 关闭证据**：I-11 精确提交 `8d926ea43e92b4cd49e4a1d541f52105075acf1a` 已只 push 到 `origin/dev`；该 SHA 唯一 push CI run `29939606613` 为 `completed/success`，`Website quality gates` 与 `Diagram compile check` 全部成功。双 Node、46/46 子测试、类型与质量证据及 #7 的同次私有字节快照交接已写入 GitHub #6，Issue 于 2026-07-22T16:51:59Z 以 `completed` 关闭；任务临时安装、运行时、WebP 样本与评论草稿随后已清理。
- **#7 当时的依赖与边界**：语义压缩后只继承已验证 `ProjectCatalog`、`validateProjectMedia` 六字段投影和扫描适配同次读取的私有字节快照；当时活动链为 `#6 -> #7 -> #26`。#7 拥有 production/preview 白名单计划、私有临时树与目的限定的 production 素材泄漏判定；#26 拥有共享双模式内容扫描/投影 API、唯一 docs 实例基础装配和 production Docusaurus 接线，#8 消费这些共享结果完成 preview Docusaurus、持久候选与原子切换，#33 独占 release 封装与整树摘要。
- **I-12 工程决定**：原设计无法仅从任意新字节的视觉语义自动判断 `static-public/` 是否误放项目素材。为使“显式登记”可证伪，新增空的 `docs/contracts/static-public-assets.json`，目录文件与登记必须一一对应，角色封闭为 `brand|operational`；再以保留 namespace 和项目/未发布正文素材同字节反查捕获可机械证明的误放。该机制不批准真实素材，也不替代入 Git 前的真实性、凭证、隐私和版权审核。
- **I-12 实现与定向验收**：新增受版本约束的始终公开素材登记、production/preview 不可复用的 `BuildContext`、一次性静态素材计划、私有 byte snapshot、受控物化，以及只产出逐文件路径/长度/SHA-256、未发布泄漏和 SSR 引用证据的 production 素材检查。两个静态素材定向测试文件 70/70 证明 production 只含公开项目、preview 含全部登记预览且输出目录隔离；已执行反例覆盖输入 Proxy/accessor/sparse 漂移、源路径 symlink/realpath/非普通文件/hardlink/大小写、`static-public` 登记闭合与保留 namespace、浏览器丢弃的伪图片 token，以及 production 素材缺失、多余、改字节、未发布 path、跨 64 KiB 分块的改名同字节和通用 draft 文章素材。工作树中的登记当前为空，且未批准任何真实素材；这项仓库事实不冒充带真实素材的正常路径验收。
- **当时的双端点验收**：任务私有候选通过 E-010 从官方 npm registry 冻结安装 1,298 个包且未执行 lifecycle script。Node `24.18.0` / npm `11.16.0` 与最低 Node `24.16.0` / npm `11.13.0` 对当时最终同一代码均通过 9 个 TypeScript source、118/118 子测试、严格 `typecheck` 和完整 `quality`，模块边界覆盖 29 个 TypeScript 文件。两端 production `build` 当时都精确以 `BUILD_PIPELINE_INCOMPLETE` 退出 1，证明 #26 接线前没有静默忽略正文或提前发布素材；该失败码不是 #26 当前本地实现状态。
- **完整性与后续状态**：当时未修改依赖、lockfile、workflow、发布封装或真实内容，也未引入第三方运行时服务、浏览器请求或用户数据处理。依赖边界、代码缺口与 SSR/私有字节对抗三路最终只读审计均无 blocker；#7 后续已按本文件顶部证据完成提交、`origin/dev` push、精确 SHA CI、脱敏验收回填与关闭，#26 已在语义压缩后启动。

## 2026-07-23 — #5 远端闭环与 #6 本地验收闭环

- **#5 关闭证据**：I-10 精确提交 `d4a92ad9b6a024fdf42f5cd35efec5847a15fadb` 已 push 到 `origin/dev`；该 SHA 的 GitHub Actions run `29931912784` 于 2026-07-22 完成，`Website quality gates` 与 `Diagram compile check` 均为 `success`。逐条脱敏验收和下游交接已写入 GitHub #5，Issue 于 2026-07-22T15:13:55Z 以 `completed` 关闭。
- **语义压缩与依赖链**：#6 只继承 #23 的已验证 `ProjectCatalog`、主预览登记字段、稳定 issue 和全有或全无结果，以及 #5 当前两个 `planned` 项目无预览/无素材的真实基线；不继承两项任务的临时安装诊断。活动依赖链收敛为 `#6 -> #7 -> #26`。#7 必须消费已验证 catalog、媒体投影和扫描适配同次安全读取后独占的私有字节快照，不得在校验成功后按路径重读；#26 继续原子拥有唯一 docs 实例、真实扫描、投影、侧栏、路由和构建装配。
- **I-11 公共契约与实现**：新增纯领域 `validateProjectMedia({catalog,sources})`、`ProjectMediaSourceInput`、`ProjectMediaValidationInput` 和稳定深冻结 `ProjectPreviewAsset[]`。完整乱序清单逐项闭合登记路径、缺失、孤儿、重复候选、重复登记、跨项目、路径逃逸、大小写、符号链接、realpath 和普通文件事实；成功结果只投影项目 ID、登记路径、`/assets/<sourcePath>`、1600 x 1000 和 alt，不读文件系统、不回写注册表，也不实现 #7 白名单或 #26 Docusaurus 装配。
- **metadata-first 与字节边界**：扫描输入先提交路径和三项文件事实；只有已证明非符号链接、真实路径在素材根内且为普通文件时才要求同次读取的真实 `Uint8Array`，危险候选必须省略字节，意外携带会失败。属性先通过一次 descriptor 快照拒绝 accessor、非枚举、未知/symbol 和 Proxy trap；TypedArray 使用内建 tag/长度支持跨 realm 真值，300,000 bytes 上限在分配复制前执行，DataView 伪造、revoked Proxy 和超限输入均失败关闭。
- **WebP 与逐条反例**：零依赖解析验证精确 RIFF/WEBP 长度、完整 chunk 遍历、零 padding、唯一静态 VP8/VP8L bitstream、VP8X 首位/保留位/画布、动画标志与 `ANIM`/`ANMF`，并要求非空压缩数据、VP8X 与内部 bitstream 尺寸一致、实际尺寸等于登记值。真实 VP8、VP8L、VP8X 正常路径和当前真实空素材基线通过；header-only、截断、非法长度、重复 bitstream、动画、尺寸冲突、300,001 bytes、危险 symlink 和失败无部分结果均有定向 fixture，完整输出六字段逐项等值且深冻结。
- **双端点验收**：任务私有候选通过 E-010 从官方 npm registry 冻结安装 1,298 个包且未执行 lifecycle script。Node `24.18.0` 与最低 Node `24.16.0` / npm `11.13.0` 对最终同一字节均通过 7 个 TypeScript source、46/46 subtests、严格 `typecheck` 和完整 `quality`；模块边界覆盖 19 个 TypeScript 文件。最低 Node 官方归档为 `31,428,548` bytes，SHA-256 精确为 `d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9`，单顶层、完整运行时树和精确 Node/npm 身份均由仓库检查器复核。两端 production build 都精确以 `BUILD_PIPELINE_INCOMPLETE` 退出 1，证明 #6 未越界吞掉真实正文或提前接管 #26。
- **审计、完整性与遗留**：媒体解析/输入对抗审计和下游范围/TOCTOU 审计复审后均无 P0/P1/P2 或 blocker；当前两个真实项目仍为 `planned`，未新增预览登记或真实素材。工作区与候选的 `package.json`、lockfile、dependency policy/admissions/license evidence、SBOM/evidence 和 `THIRD_PARTY_NOTICES` 摘要逐项一致；仓库根无 `node_modules`/build/dist，候选无 build/dist。未新增、升级或删除依赖，未引入第三方运行时服务、浏览器请求或用户数据处理。#6 当前尚待单一提交、仅 `origin/dev` 推送、精确 SHA CI 成功、脱敏回填与关闭；完成语义压缩前不启动 #7。

## 2026-07-22 — #23 远端闭环与 #5 本地验收闭环

- **#23 关闭证据**：I-06 精确提交 `49a97bf55e69119b31b03e309fe117c04b767f31` 已 push 到 `origin/dev`；该 SHA 的 GitHub Actions run `29925256721` 于 2026-07-22T13:44:57Z 完成，`Website quality gates` 与 `Diagram compile check` 均为 `success`。逐条脱敏验收和下游接口已写入 GitHub #23，Issue 于 2026-07-22T13:47:53Z 以 `completed` 关闭；关闭顺序经再次核对为 CI 成功、验收评论、Issue 关闭。
- **语义压缩与依赖链**：#5 只继承 #23 的结构化解码、路径分类、`validateProjectCatalog`、稳定 `ContentIssue` 和全有或全无结果，不继承其临时安装诊断。#5 与 #6 在依赖图上可并行，但按 D-092 保持逐 Issue 串行；当前链为 `#5 + (#6 -> #7) -> #26`。#26 仍原子拥有唯一 docs 实例、真实扫描、只读投影、侧栏、路由与构建装配；其远端闭环并语义压缩后，启动 #27 前必须按 D-091 提醒切换到 Codex Desktop。
- **I-10 唯一正文迁移**：创建 `site-content/projects/docrestore/index.md` 与 `site-content/projects/vibecoding-project-scaffold/index.md`，正文从 H2 开始且不含 frontmatter、H1、项目 ID、摘要、状态、日期、仓库或路由字段，只拥有问题、能力与架构、关键取舍、当前限制、证据说明和复盘。DocRestore 的处理链、源码优先和素材未完成边界完整迁移；VibeCoding Project Scaffold 的初始化、文档/Agent 规则、零第三方依赖质量基线、CI 与 Git hooks、框架中立取舍和 Apache License 2.0 事实完整迁移，未补写未经确认的许可证动机。两个原设计文档的过渡叙事已在同一变更中替换为正文相对链接，产品体验与 M0 实现 Spec 也同步改为迁移完成状态；`projects.json`、四份注册表、项目状态、日期和素材字段均未改变。
- **定向正常路径与反例**：新增 I-10 仓库级测试，以当前四份注册表和精确两份正文调用 #23 公共领域入口，得到唯一 `projectId`/路径映射；迁移事实锚点与两个链接所有权章节逐项通过。恢复 `problem`、`decisions` 或 `evidence` 会逐字段命中 `CONTENT_PROJECT_FIELD_UNKNOWN` 且不返回 `value`；frontmatter、H1、孤儿正文和 `.md`/`.mdx` 双入口分别稳定失败。主、最低 Node 的统一 `npm test` 均为 6 个 TypeScript source、35/35 subtests，其中 I-10 定向 4/4；真实冻结 `@docusaurus/utils@3.10.2` 解析探针在两端都得到 `registries=4 projectSources=2`。
- **双端点与 fail-loud 构建验收**：任务私有候选按唯一 lock 通过 E-010 从官方 npm registry 冻结安装 1,298 个包，未执行 lifecycle script。Node `24.18.0` 与最低 Node `24.16.0` / npm `11.13.0` 均通过同一 `test`、严格 `typecheck` 和完整 `quality`；统一门禁关键计数为 E-010 58/58、E-011 41/41、E-012 runner 10/10、module boundary 16/16、decoder 14/14。最低 Node 归档从仓库固定的 Node.js 官方 HTTPS URL 直连下载并显式绕过作者环境代理，大小 `31,428,548` 字节、SHA-256 `d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9`，再由仓库加固入口复核摘要、归档布局、运行时树和身份。两端 production build 都以 `BUILD_PIPELINE_INCOMPLETE` 退出 1，这是 #5 的预期通过条件：真实正文在 #26 接线前不得被静默忽略或提前发布。
- **完整性与遗留**：验收前后 `package.json`、lockfile、admissions、license evidence、`THIRD_PARTY_NOTICES` 和 SBOM SHA-256 精确一致；仓库根没有 `node_modules`、顶层 build、dist 或测试 emit，候选也未产生 build/dist。未新增依赖、第三方运行时服务、浏览器请求或用户数据处理。内容事实/所有权审计与契约/测试综合审计均无 blocker；#5 当前尚待单一提交、仅 `origin/dev` 推送、精确 SHA CI 成功、脱敏回填与关闭，在此之前不启动 #6。

## 2026-07-22 — #11 远端闭环与 #23 本地验收闭环

- **#11 关闭证据**：I-05 精确提交 `ca10de5318543b89dd829db24ed2a646c6535a12` 已 push 到 `origin/dev`；该 SHA 的 GitHub Actions run `29913247834` 为 `completed/success`，脱敏验收与 #23 交接已写入 GitHub #11，Issue 以 `completed` 关闭。关闭后本地 `dev` 与 `origin/dev` 一致，工作树干净；进入 #23 前已完成语义压缩。
- **依赖与职责复核**：#23 blocked-by #11，并阻塞 #5/#6/#12/#25。固定 Docusaurus `3.10.2` 已实证拒绝零文档实例，而首批真实项目正文属于 #5 且 #5 又依赖 #23；因此 I-06 只实现无文件系统 I/O 的内容门禁，不用占位文档、第二内容根或条件 fallback 伪造 docs 已接线。依赖链修正为 `#23 -> (#5 + #6 -> #7) -> #26`，由 #26 原子启用唯一 `site-content/` docs 实例、真实扫描、投影、侧栏与路由构建装配。
- **I-06 实现**：新增统一 frontmatter/JSON 解码边界、稳定脱敏 `ContentDecodeError`、仓库相对 POSIX 路径规范化与显式 symlink/realpath 分类，以及项目目录和整批文章领域校验公共入口。注册表、项目、主预览、文章状态日期、作者/主题/项目/模块引用、关系、推荐、修订、来源和项目 `relatedWriting` 都按闭集 schema 聚合校验；任一问题都只返回确定性排序、去重且脱敏的 `ContentIssue`，不返回部分 value。成功对象按稳定键排序并深冻结，不读取文件系统、时间或随机数，也不调用下游投影。结构化 parser 的原始异常按 CODE-003 的窄安全例外替换为无堆栈通用 cause，稳定 code 与脱敏相对路径继续保留。
- **逐条与安全反例**：领域 fixture 覆盖完整合法 planned/published 项目、draft/public 文章、乱序确定性、四类注册表 envelope、未知字段、重复 ID/slug/source、缺失与悬空引用、项目/模块不一致、状态日期、视频三元组、preview、SEO、推荐、关系、revisions、sources、项目正文 frontmatter/H1、路径逃逸、绝对路径、symlink/realpath 和失败无 value。跨批 probe 既聚合可独立检测的重复/冲突，又不把无效成员制造成虚假悬空级联；恶意 key、Map/Date/Proxy、revoked trap、控制字符、非规范 URL/站内路径、typed-array brand/长度伪造和临时绝对路径不会绕过 schema 或进入 field/source/message/stack。H1 线性状态机覆盖有序 quote/list container、fence、HTML block/inline comment、匹配与未匹配跨行 code span、缩进代码和 paragraph continuation。
- **真实解码与双端点验收**：任务私有 `/tmp` 候选通过 E-010 从官方 npm registry 冻结安装 1,298 个包；真实冻结 `@docusaurus/utils` 的默认解析器完成嵌套 YAML 正向、malformed YAML 脱敏反例，以及带引号日期保留为 string、未加引号 YAML timestamp 以 `CONTENT_FRONTMATTER_SHAPE` 失败的公共动态导入回归。最终快照在 Node `24.18.0` 与官方固定摘要 `d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9` 的 Node `24.16.0` 上均通过同一 `npm test`（5 个 TypeScript source、31/31 subtests）、严格 `typecheck`、完整 `quality` 和 production `build`；两端统一质量入口均通过 decoder 14/14、E-010 58/58、E-011 41/41、E-012 runner 10/10、模块边界 16/16 与既有回归。
- **完整性与遗留**：验收前后候选与工作区的 `package.json`、lockfile、admissions、license evidence、`THIRD_PARTY_NOTICES` 和 SBOM SHA-256 精确一致，仓库根没有 `node_modules`、build、dist 或测试 emit；未新增依赖、第三方运行时服务、浏览器请求或用户数据处理。D-089 授权的临时测试与 D-090 授权的单提交、仅 `origin/dev` 推送和精确 SHA CI 跟踪已经记录；#23 在远端成功、Issue 回填/关闭和语义压缩前仍不解锁下游。按 D-091，#26 完成同样闭环后、#27 启动前提醒用户切换到 Codex Desktop。

## 2026-07-22 — #22 远端闭环与 #11 本地验收闭环

- **#22 关闭证据**：I-04 精确提交 `7cb529c1a68bd1979d8a9b9b6ba8731dc2fe49100` 已 push 到 `origin/dev`；该 SHA 唯一相关的 GitHub Actions push run `29907159529` 为 `completed/success`，`Website quality gates` 与 `Diagram compile check` 的全部步骤均成功。脱敏验收与 #11 交接已写入 GitHub #22，Issue 以 `completed` 关闭；本地 `dev`、`origin/dev` 和工作区在关闭后均一致且干净。
- **语义压缩**：#11 只继承 #22 的生产 `tsconfig`、显式 `.mjs` ESM 边界、目录层图、公共入口、稳定错误码和 quality 接线；#22 的 npm 安装诊断、Docusaurus 兼容排查及临时构建过程不再作为活动上下文。依赖链固定为 `#22 -> #11 -> #23`，#23 在本项闭环前保持阻塞。
- **I-05 开工决定**：TypeScript 官方 NodeNext 语义要求普通 `.ts`/`.tsx` 从最近祖先 `package.json#type` 判定 module format；根 manifest 又必须为 I-04 保持无 `type`。因此 E-012 使用精确的 `src/package.json` 与 `tests/package.json` 局部 ESM 源码边界，临时 emit 根另写同样的两键 package；不恢复根 module type，不改变 manifest 依赖、lockfile、Docusaurus 生成目录或浏览器边界。
- **I-05 验收授权**：D-087 允许在任务专用临时副本中通过 E-010 联系官方 npm registry 做冻结安装，并从 Node.js 官方源下载、校验仓库固定摘要的最低端点 Node `24.16.0`。授权只覆盖主/最低端点同负载、约定反例、`typecheck`、production `build` 与清理验收；不包含 Git、CI 或 Issue 写操作。
- **I-05 实现**：新增独立 `tests/tsconfig.json`、局部 ESM package 边界、`tests/domain|build` TypeScript 测试物理层、`scripts/quality/run-tests.mjs` 与唯一 `npm test` 入口；runner 只解析 lock 冻结且未逃逸 `node_modules/typescript` 的 CLI，稳定枚举测试、输出到系统私有临时目录、写入独立 ESM package 后以当前 Node `--test` 显式直跑，并在所有路径清理。模块边界与 quality 接线同步拒绝无扩展名、`.ts`、alias、目录猜测、第三方测试运行时、错误源码扩展与生产层 Node ESM 说明符漂移。真实 npm 安装暴露作者机 `umask 0002` 会合法产生 `typescript/bin/tsc` 的 `0775`；runner 因而接受组模式，仍拒绝 symlink、hardlink、world-writable 与 lock 版本漂移，避免把真实冻结安装误判为非法。
- **双端点正向验收**：任务私有候选通过 E-010 官方 registry 冻结安装 1,298 个包且未执行 lifecycle script；固定归档 `node-v24.16.0-linux-x64.tar.xz` 经仓库加固入口核对 SHA-256 `d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9`、单顶层布局、运行时树与精确 Node `24.16.0` / npm `11.13.0`。同一候选、同一 `npm test` 和同一 `tests/build/site-config.test.ts` 分别在 Node `24.18.0` 与 `24.16.0` 直接执行成功，明确报告 `primary` 与 `minimum`；合法 `.js` 公共入口通过 NodeNext 编译和原生 Node ESM 运行。
- **逐条反例验收**：可恢复临时 mutation 共 9 项全部命中预期：无扩展名、`.ts`、目录猜测与 `@site` alias 均为 `TEST_PROGRAM`；直接 NodeNext 编译分别产生 `TS2835` 与 `TS5097`；空测试集为 `TEST_EMPTY`，真实类型错误为 `TEST_COMPILE`，真实失败测试为 `TEST_EXECUTION`。失败输出保留 `tests/build/site-config.test.ts` 与测试名，不包含任务临时根或 `axial-muse-tests-*`；提交内 15 项模块 fixture 与 10 项 runner fixture 共 25/25 通过，覆盖编译、emit、执行、清理、临时创建及部分创建失败，其中清理失败以 `TEST_CLEANUP` 覆盖原状态。
- **回归与完整性**：同一全新安装上的隔离 `typecheck` 与 production `build` 均成功；最终工作树 pre-commit 在固定 nvm `0.40.6` / Node `24.18.0` 下完整通过，包含文档、Secret、6 个 TypeScript 文件的模块边界、1,225 项供应链静态闭包、E-010 58 项、E-011 41 项、runner 10 项、模块边界 15 项和全部既有回归。安装、双端点、mutation 前后 `package.json` SHA-256 均为 `7b089fd3df1b14f8c7117fa4608d895f5fb7327528281f20274df2e068ccf82c`，`package-lock.json` 仍为 `fae564f5a83ceaf4f5d57118192779a2679f5380403d0a79d33f409d75dc01aa`，NOTICE/evidence/SBOM/admissions 摘要同 #21；候选源码与主工作树摘要一致，仓库根始终没有 `node_modules`、测试 emit、build 或 dist。本项未新增第三方服务、浏览器请求或用户数据处理。
- **Git 与远端授权**：D-088 已授权把当前 I-05 完整变更 commit 并且只 push 到 `origin/dev`，锁定精确 SHA 跟踪现有 CI；失败修复不得越出 #11，CI 成功后按 D-084 评论并关闭 #11。`main`、PR/merge、历史改写、workflow/凭证和生产操作均不在授权内；#23 在远端闭环、可恢复摘要和语义压缩完成前继续保持阻塞。

## 2026-07-22 — #22 Docusaurus 与严格 TypeScript 本地验收闭环

- **主题与依赖边界**：按 Roadmap 的 `#9 + #21 -> #22 -> #11` 链执行 I-04，只消费既有 `.nvmrc`、`engines.node`、唯一 lock 与 #21 准入图；没有新增、升级或删除依赖，没有修改 `package-lock.json` 或供应链制品。D-085 授权只在任务专用临时副本中通过 E-010 联系官方 npm registry 做全新冻结安装和真实构建，不在仓库根创建 `node_modules/`。
- **完成内容**：创建继承官方基线且显式收紧的 `tsconfig.json`、类型化 `docusaurus.config.ts`/`sidebars.ts`、`site-content/projects|writing` 空物理分区、`src/build/site-config/` 公共入口和仅含已确认站点名的最小 `src/pages/index.tsx`；新增受控 production build、`typecheck`/`build`/模块边界 scripts，并把确定性零依赖检查器及 fixture 接入统一质量入口。构建上下文使用同用户私有临时根、随机标记和空静态树，拒绝直接 Docusaurus 绕过、错误 Node、preview、真实内容与静态素材提前进入；Docusaurus persistent cache 显式关闭。
- **真实兼容收口**：实际 build 先暴露三项不能由 mock 发现的问题并按根因修复：正常 Linux 目录的 `nlink` 不能固定为 `1`，文件仍保持单链接检查；固定 docs 插件拒绝零文档，因此 I-04 使用 `docs: false` 而不伪造内容，后续依赖复核已将唯一 `site-content/` docs 实例的原子启用职责固定给真实项目正文与素材接线之后的 #26；根 `package.json#type=module` 会把固定版本生成的 `.docusaurus/client-modules.js` 改判为 ESM，使 CSS `require()` 逃逸到 SSG，因而移除该旧声明并用 `.mjs` 保持仓库 Node 脚本 ESM，检查器用 `MODULE_BOUNDARY_PACKAGE_TYPE` 防漂移。完整 `future.v4: true` 与 `future.faster: true` 保持启用。
- **正向证据**：最终候选在全新 HOME/config/cache 下执行 `npm ci --ignore-scripts --audit=false`，从官方源安装 1,298 个包并退出 0；安装前后 `package.json` SHA-256 均为 `72e44f92feb6796c2dba26dd9cad3001d8ab6ba1189756e0351d4a0377585621`，`package-lock.json` 均为 `fae564f5a83ceaf4f5d57118192779a2679f5380403d0a79d33f409d75dc01aa`。同一全新安装上的隔离 `typecheck` 与 production `build` 均通过；产物只包含 `/`、404、sitemap 与本地 JS/CSS，根 HTML 为 `lang=zh-CN` 且标题为 `Axial Muse`，未检出远程资源标签、分析标识或 Cookie，也未产生 `node_modules/.cache`。
- **反例与回归**：模块边界 11 项 fixture 覆盖合法公共入口以及 `paths`、根 module type、JS/JSX、深导入、`export *`、自定义别名、展示层 Node 内置模块、领域层框架依赖、版本漂移和非静态 dynamic import；构建 4 项 fixture 覆盖参数、主/最低 Node、真实内容和静态素材前置失败。直接 Docusaurus 以 `BUILD_CONTEXT_MODE`、preview 以 `BUILD_MODE_UNAVAILABLE`、系统 Node 22 以 `BUILD_RUNTIME_NODE`、检查器参数以 `MODULE_BOUNDARY_ARGUMENTS` 失败。最终 pre-commit 在 nvm `0.40.6` / Node `24.18.0` 下退出 0，文档、契约、Secret、静态站、1,225 项供应链闭包与全部既有测试均通过。
- **下游与遗留**：#11 只能消费当前生产 `tsconfig`、显式 `.mjs` ESM 边界、目录层图、公共入口、稳定错误码和现有 quality 接线，新增独立测试 program、临时 emit runner 与 fixture；不得改变依赖图、重新启用根 package module type、启用 docs/真实内容、素材白名单、preview 或目标 workflow。D-086 已授权把本项作为完整提交 push 到 `origin/dev` 并跟踪该 SHA 的现有 CI；远端结果不得在运行完成前预先宣告，最终 SHA、run 与结论写入 GitHub #22 的脱敏验收评论。#22 在相关 run 全部成功前保持开放；未引入第三方运行时服务、浏览器请求或用户数据处理。

## 2026-07-22 — 确认 Roadmap Issue 验收写回委托

- **主题**：用户确认从 #21 起，允许 Agent 在每个已拆解 Roadmap Issue 真正通过独立验收后，把脱敏关闭证据与直接下游交接摘要写回对应 GitHub Issue，并以 `completed` 关闭；该委托用于支持按依赖链连续推进和每项之间的语义压缩。
- **授权范围与验证**：每项必须先证明主要不变量、正常路径、至少一个有效反例、相关回归和该项要求的远端证据；关闭后先持久化紧凑交接摘要，再只定向重载直接上游接口、当前设计、源码、测试和工作区差异。证据不全或失败时保持 Issue 开放并停止依赖它的下游。
- **排除项**：不授权创建或改写 Issue 范围，也不授权 commit、push、PR、merge、分支与历史操作、Action/凭证、服务器、TAT、DNS、证书、云资源或生产操作；这些仍按各自门禁单独确认。验收评论不得包含凭证、隐私、受限原始报告或其他敏感内容。
- **当前应用**：#21 已在 Node 24 固定入口完成现态回归，并核对同 SHA 的远端 push/PR CI 成功；授权记录验证通过后先写回并关闭 #21，再以其交接摘要定向进入 #22。

## 2026-07-21 — #21 真实依赖图本地准入闭环

- **主题**：用户批准 D-082 的两项精确传递 override、35 项 immutable upstream 正文、11 项同 tarball 文件区段和 12 项 exact owner exception 后，继续执行 #21 直到真实图满足完整本地验收。本条只宣告仓库实现与真实依赖图本地准入闭环；Git 提交、push、远端 CI、Issue 状态和 Action 修改均须按各自授权与实际记录独立验收，不能由本条推导。
- **图与法律证据**：最终 lock 含 1,345 个非根物理记录，折叠为 1,225 个 canonical identity；`dependency-admissions.json` 与候选报告均精确闭合 1,225 项。D-082 契约固定 35/11/12 三类共 58 项补充法律证据与 29 项精确许可证决定，代码中的 owner exception 集合精确等于用户批准的 12 项；三个有保守或实际 lifecycle 标记的包均为 `ignored`，安装始终使用 `--ignore-scripts`，没有脚本执行例外。许可证证据契约 SHA-256 为 `84cacf1f3eefd0c455e5f1693e5b5b8f7766c5c18c04d6d20c3eb8d914a8b76e`，admissions SHA-256 为 `caafbb7e2c48df45b65bdfbdcaaa02c68ef0df5c21ff0f19bff7e97f239aecea`。
- **正式证据**：正式生成重新下载并逐项复验同一 lock 的精确官方 tarball，在两个全新隔离 workspace 中取得一致的 npm native SPDX 后原子发布三件套；`dependency-evidence.json`、`sbom.spdx.json`、`THIRD_PARTY_NOTICES` SHA-256 分别为 `b1931d00f69c2a88663884b705ec83f74262ead070f17ffcc3545e034d2bfd7e`、`94f406c74a52108e7a4731257cdb9049f66a1d4ae3b1886a2b74c89e024c738b`、`400dc8e21357fb7b389903399cfbb0c048faa0d2d59fad7ff72b6360695b9158`，静态闭包报告 1,225 packages。受限候选报告位于 `/tmp/axial-muse-supply-chain-review-oE4evc/report.json`，SHA-256 为 `c0bfdeb15b66f4a2fc8e1ad04b0746484fd4b1b85e837308499a7a0a70619287`；最终实际 audit 对 1,345 项依赖的 total/info/low/moderate/high/critical 均为 0，原始报告 SHA-256 为 `fe081f418565b7f80a37678130a96aed6b5e689fce15471b24c62b7b37cabf1b`。此前进度条目记录的 20 moderate、1 high 是 override 前的诊断历史，已被最终 lock 与 audit 全零结果取代。
- **最终决定与双端点**：D-082 最终决定 `/tmp/axial-muse-final-decision-iij6iA/final-decision.json` SHA-256 为 `583c6de0ff49d95c8960552e746c043967925f0e583be2049c3c85afd7f1f8f5`。Node `24.18.0`/npm `11.16.0` 与固定官方 Node `24.16.0`/npm `11.13.0` 分别在私有临时目录对同一 manifest/lock 完成冻结安装，前后 SHA-256 不变；dual receipt `/tmp/axial-muse-dual-endpoint-ci-receipt-kJeDgT/receipt.json` SHA-256 为 `8b10371be86d8ead902609722eb2f95382305e80833d29b0179ebb82923b9fef`，最终 composite receipt `/tmp/axial-muse-final-admission-receipt-bDzt8j/receipt.json` SHA-256 为 `3d9d82dfe5411b927db87d31ed250451e07eaeef4a77e2f200be8e93b5bf5567`，两者均为 canonical `status=passed`，目录/文件权限分别为 `0700`/`0600`、单链接且精确唯一成员。
- **真实 npm 兼容收口**：固定 npm 会为合法包名/SemVer 产生不符合 SPDX 2.3 `idstring` 的字符、因重复物理路径重复输出完全相同 relationship triple，并对少数 lock 缺少许可证字段的旧包输出 `NOASSERTION`。实现只在 native 输入边界逐包证明并合法化 ID、在字段/引用验证后收敛完全相同关系、仅用同轮 integrity 已验证 tarball 的实际声明补足 `NOASSERTION`；持久化制品继续严格拒绝非法 ID、重复关系和声明漂移。补充法律文件的 live inspection 携带可校验 `size`，候选/NOTICE 持久化省略该派生字段；中央闭包只为缺失 `size` 的持久化投影按正文 UTF-8 字节数补回，显式错误 size、额外字段、路径、摘要或正文漂移仍失败。此前历史条目中的“完全重复关系一律失败”已由真实 npm shape 的上述受控兼容取代，不改写旧快照。
- **完整本地回归**：精确 Node `24.18.0` / npm `11.16.0` 通过隔离 `run-script quality` 总入口；JavaScript、npm isolation、Markdown、契约、Secret、静态站与供应链静态闭包全部通过，14 个测试文件合计 301/301 通过。隔离入口确认 `registry=official`、`cache=fresh`、`config=isolated`，执行结束后 manifest/lock 与仓库根安装状态均未漂移。
- **遗留边界**：仓库根没有 `node_modules/`，系统与新 Bash 默认 Node 没有改变；本轮只访问官方 npm registry 和固定 Node.js 官方发行制品，不引入浏览器第三方请求、第三方运行时服务或用户数据处理。`/tmp` 决定与 receipt 是本地受限证据；目标 CI artifact retention、Action 固定、required checks、Docusaurus build 及制品网络/浏览器检查仍由后续任务完成，Git 与远端 Issue 状态以各自实际记录为准。完成本轮审核后，#22 可消费已准入图继续建立站点与 TypeScript 基线。

## 2026-07-20 — #21 生成真实 lock 并继续收口候选 tarball 审查

- **主题**：按 D-081 的既有授权继续 #21；不改变系统默认 Node，也不在仓库根安装依赖，由 E-010 受控主端点联系官方 npm registry 生成唯一真实 `package-lock.json`，再以同一 lock 进入精确 tarball 候选审查。本条不宣告候选报告、正式准入或 #21 已完成。
- **已形成事实**：真实 `package-lock.json` 已生成并通过 lockfile v3、官方 `resolved`、integrity、manifest/lock 绑定和文件身份检查；仓库根没有 `node_modules/`。#21 的最终证据持有、双端点编排和 composite receipt 仍是已经落盘并由离线 fixture 验收的实现能力，不是本轮已产生的真实最终证据。
- **真实 tarball 兼容边界**：首次真实候选检查暴露了历史 npm tarball 的受控合法形态；解析器只增加七项窄兼容：POSIX `ustar` 的空 STAR prefix 尾部两个规范非负八进制时间字段、仅 `@types/<name>` 的匹配单一 `<name>` 或 `<name> v<major>.<minor>` legacy 顶层根到 `package/` 的规范化、仅 `uid`/`gid` 的非负 base-256、空/缺失/含边缘空白 `description` 的原样区分、把 lock `hasInstallScript` 视为保守上界、只忽略不影响解包语义的受控历史 `NODETAR.*` PAX 元数据，以及只忽略 `package/test/**/node_modules/**/*.js` 下的普通 resolver 测试夹具。实际脚本未被 lock 标记仍失败，lock 过度标记不构成脚本执行授权；纯空白 description、`NODETAR.path`、非规范索引/空分段、路径逃逸、错误根、其他 base-256 字段、非测试/非 `.js`/法律文件夹具和其他 header/metadata 放宽继续失败关闭。候选/正式复验继续使用任务私有 HTTPS keep-alive Agent，每批最多 4 个 canonical identity 并发，settled 后仍按 canonical 顺序审查、选择错误和清零 Buffer。
- **当前遗留**：真实全图诊断已覆盖全部候选，但 58 个 tarball 未携带受控 LICENSE 文件，另有 98 个 identity 需要许可证政策或精确证据决定，因此尚未形成可供正式准入的候选报告；实际 audit 已产生受限证据并确认 20 个 moderate、1 个 high 阻断。正式 SBOM/evidence/NOTICE、显式最终人工决定、主/最低端点真实 `ci` 和 composite receipt 仍未产生。后续继续在 D-081 的官方来源、无脚本、私有临时目录和受限日志边界内推进；在站点所有者统一确认候选图前不写入政策扩展或具体包准入，也不把真实 lock、诊断或失败 audit 误报为 #21 完成。

## 2026-07-20 — 推进 #21 的 D-077 离线供应链准入实现

- **主题**：消费 #9 的 E-010 隔离/版本契约和 #10 的 E-011 确定性 SPDX，在不访问 npm registry、不下载真实候选 tarball、不执行 audit 或安装依赖的边界内，先完成 #21 可由 fixture 独立验收的策略、证据、报告和闭包实现；本条不宣告 #21 完成。
- **主要不变量**：候选 lock、tarball、npm SPDX 与 audit 都是不可信输入；只有官方来源、精确 integrity、实际包内 metadata/法律文件/脚本、人工 admission 和 canonical 派生制品一一闭合时才可通过。任何 schema、来源、许可证、脚本、NOTICE/evidence、SPDX、audit 计数或发布快照漂移都以稳定 `SUPPLY_CHAIN_*`/既有 `NPM_*`/`SPDX_*` code 失败，受限原始报告不得进入普通日志。
- **完成内容**：写入固定 `dependency-policy.json` 和空的 canonical `dependency-admissions.json`；建立静态闭包检查、候选审查、精确官方 tarball 下载与受控 tar/gzip 解析、长度帧 `THIRD_PARTY_NOTICES` 与逐包 evidence、严格 npm audit v2 解析和受限报告；正式生成入口从同一批 tarball inspection 绑定 admission 摘要与 NOTICE，只把 tarball 声明许可证交给 npm expected graph 交叉校验。HTTP 早退会终止 response；下载前限制 50,000 包并在保留前累计最多 64 MiB inspection，候选 canonical report 和原始 audit JSON 各自限制为 64 MiB，NOTICE 单帧/全文分别限制为 2 MiB/64 MiB。audit 拒绝重复 JSON key、超过 128 层的嵌套、悬空 `via`、伪造 `effects` 反向边和无 advisory 终点的引用图，以完整 `via` 图做 O(V+E) 遍历；只含直接 advisory object 的节点复核最大 severity，含字符串 metavulnerability 引用的父节点则保留 npm affected-range 聚合 severity，并把依赖总数绑定唯一 lock 的非根物理节点。既有 NOTICE/SPDX 在覆盖前验证来源 URL、安装路径、purl、checksum、许可证和精确身份可派生自闭包；固定 npm `11.16.0` 的重复物理节点按 location 顺序选唯一 package 并保留不同 relationship，完全重复关系仍失败关闭。受限候选/audit 报告、双制品与三制品发布以及内外生成锁都以打开句柄绑定创建 inode 和完整 snapshot；失败状态先原子移入唯一 quarantine，只有所有权复核通过才删除。旧 canonical ownership 贯穿 snapshot 到 backup，候选文件保留原始创建 fd；新三件套完整激活后即 committed，后续旧备份清扫失败不再回滚 active。外部不同字节、同字节换 inode 或检查后替换时保留 canonical 或 quarantine 中的可检查状态并失败关闭。固定 npm 的依赖 SPDX homepage 为 `NOASSERTION`、description 缺失；tarball 原始 homepage/description 完整留在 NOTICE/evidence，不声称与 native SPDX 相等。真实全图诊断已覆盖 1,226 个 canonical identity；实际 audit 已生成受限证据并确认 20 个 moderate、1 个 high 阻断，安全 override 只在 `/tmp` 的 seeded lock 探针中证明可清零 audit，尚未获准写入 manifest/lock。仓库仍不存在安装结果、正式逐包准入结论或正式 SBOM/NOTICE。
- **最终证据与安装编排收口**：新增显式最终决定 schema、五份受限证据打开与长期句柄持有、仓库五项固定输入和正式 admissions/evidence/NOTICE/SBOM 的 fd/目录链复核，并把候选报告逐包 evidence 摘要与正式闭包一一绑定；fatal UTF-8、canonical bytes、同 inode 改写、同字节换 inode、目录成员和 A→B→A 漂移均失败关闭。下层双端点核心固定主/最低运行时、Node.js 官方最低制品摘要、已校验内存 archive、完整运行时树证明、两个私有 project copy 与身份证明清理；最终整体入口只消费现有人工决定，比较四项共同输入并生成嵌入无包名准入摘要和完整双端点结果的受限 composite receipt。单独静态闭包、决定文件或双端点 receipt 均不构成最终成功；真实执行仍须取得外部操作授权。
- **离线验收**：此前从无 profile 的系统 Node 22 环境执行真实 pre-commit，hook 已自动选择 nvm `0.40.6` / Node `24.18.0` 并进入统一隔离质量入口；本轮再以精确 Node `24.18.0` 完整执行该聚合。JavaScript、npm isolation、Markdown、契约、Secret 与静态站检查全部通过，E-010 为 58/58、E-011 为 38/38。#21 的 audit artifact、audit parser、candidate review、download、dual endpoint、final evidence、final runner、formal generation、NOTICE、policy、review report 和 tarball 12/12 顶层测试文件合计 172/172 个测试/套件节点通过；连同 E-010/E-011 的 14 文件回归合计 268/268。双端点回归实际派生当前 Node worker，并用 `/usr/bin/tar` 从已验证 stdin/fd 解压离线 fixture；最终证据回归重算逐包 evidence 与决定摘要，最终 runner 回归覆盖三次证据复核、跨阶段绑定、no-replace 成功名、失败清理、cleanup-uncertain 保留和失败日志净化。门禁未访问 npm registry、未安装真实依赖，也未创建 lockfile、正式三制品或 admission 结论；本结果只证明离线实现，不替代真实图验收。
- **遗留边界**：下一阶段仍须先取得 npm 联网授权，再由主端点生成真实 `package-lock.json`、下载并审查精确 tarball、形成尚未提交的逐包许可证/脚本预审 admissions，随后生成 canonical 但尚未准入的正式三制品、运行官方 audit、取得最终人工图准入结论，并让主/最低 npm 端点对同一 lockfile 完成冻结安装与前后哈希验证。audit 失败时不得提交预审 admissions 或三件套，也不得进入双端点安装。当前 schema 与三件套不单独编码 audit/最终批准状态，最终结论须由同一次受限 audit 证据、显式决定记录和双端点结果共同证明；真实图、正式证据、目标 CI artifact retention、Docusaurus build 制品网络检查和浏览器 allowlist 均未完成。当前 evidence 封套也不保存整份 NOTICE 或旧 admissions 摘要；若只改变人工用途、许可证澄清或义务并合法更新 admissions，旧制品不能独立证明旧文案到新决定的历史绑定，扩展该能力须另行演进 schema，不能把本轮闭包表述为已经覆盖。未新增第三方服务、浏览器请求或用户数据处理，也未提交或推送。

## 2026-07-20 — 配置不改变默认版本的 Linux 作者 Node 24 环境

- **主题**：用户确认保留系统与新 Bash 会话的默认 Node 22，仅在用户目录安装精确 nvm/Node 24，并由 pre-commit 子进程自动读取 `.nvmrc` 选择版本；不采用每次提交临时联网下载，也不把 Node 24 设为 nvm default。
- **安装证据**：`~/.nvm` 来自 nvm `v0.40.6` 官方 immutable release，annotated tag object 为 `18f62ba4e8e2148383332fb1ac8b2ff1ee21a263`、peeled commit/HEAD 为 `b6cf55f6adf3b953d0e5e00a4049444e300e3af8`，工作树无内容漂移。nvm 从 Node.js 官方发行源安装 `.nvmrc` 的 Node `24.18.0` / npm `11.16.0`，缓存归档 SHA-256 为 `55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742` 且摘要匹配；安装后删除自动产生的 alias，`default=N/A`。
- **自动化边界**：pre-commit 以 `--no-use` 加载固定 nvm，严格校验 `.nvmrc`、所有权和关键路径权限，再通过 `nvm version`/`nvm which` 只在 hook 子进程 PATH 中选择精确 Node。它不调用会读取用户 npm `prefix` 的 `nvm use`，也不修改父 shell、shell 初始化、用户 npm 配置或 alias；缺少、漂移、非法或宽写时在质量负载前失败，不联网安装或回退系统 Node。
- **验收结果**：无 profile 的干净 Bash 仍解析 `/usr/bin/node` `v22.22.0`，`~/.bashrc` 与 `~/.profile` 哈希和任务前一致；从该系统 Node 22 环境执行真实 pre-commit 后自动选中 nvm `0.40.6` / Node `24.18.0`，JavaScript、npm isolation、Markdown、契约、Secret、静态站检查全部通过，E-010 为 37/37、E-011 为 19/19。hook fixture 另覆盖缺失/漂移 nvm、缺失 Node、非法 `.nvmrc`、宽写目录和逃逸 Node 路径，均未进入质量负载或调用 install/alias。
- **遗留边界**：系统 Node、shell 配置、Ubuntu CI/生产拓扑、最低兼容端点、npm 全局包、站点依赖和用户数据处理均未改变；安装仅访问 nvm 官方 GitHub 仓库与 Node.js 官方发行源。本项不创建、修改或公开任何 GitHub 凭证，也不把本地作者环境验收解释为凭证、CI 或发布接线完成。

## 2026-07-19 — 修复 E-010 迁移期 CI runtime 信任根

- **主题**：首次把 #9、#10 与 Git 规则提交推送到 `dev` 后，run `29690235381` 的 `Website quality gates` 在 E-010 测试加载阶段以 `NPM_CLI_FILE_TRUST` 失败；`Diagram compile check` 同 run 通过。
- **根因**：迁移期 workflow 仍按既定边界使用 `actions/setup-node@v5` 的 Node 22；GitHub hosted toolcache 中随附 npm 关键路径存在 E-010 禁止的硬链接或宽写权限。官方 Node 24.18.0 发行归档在本地同一提交上通过完整质量负载，因此失败来自 CI runtime 文件系统信任形态，不是规则改动、测试语义或 npm workload。
- **修复边界**：保留 Node 22 迁移期聚合负载和 #22 对 Node 24 主/最低入口、Action 固定及完整 CI 拓扑的所有权；不放宽 CLI 信任规则、不跳过测试、不绕过 E-010。`website-quality` 在 setup-node 后先确认当前可执行文件恰好位于 `RUNNER_TOOL_CACHE/node` 下的发行前缀，再把该前缀复制到全新的 runner 私有临时目录，打断源硬链接、移除组/其他用户写权限，并通过 `GITHUB_PATH` 让原质量步骤使用该前缀。来源不匹配、目标预先存在、复制失败或质量门禁失败都直接阻断。
- **本地证据**：以官方 SHA-256 校验通过的 `Node 24.18.0 / npm 11.16.0` 发行版执行同一工作流步骤，并把源 npm CLI 人为置为双链接、`0666`；复制后对应文件为单链接、`0600`，E-010 能从目标前缀派生 npm。该目标前缀的完整隔离质量入口退出 0，E-010 36/36、E-011 19/19。实际 GitHub CI 修复 run 仍须在 push 后观察到 `completed` 且 `conclusion=success` 才能关闭本项。
- **残余边界**：本项不安装依赖、不访问 npm registry、不改变 Node/npm 版本契约、Diagram job、站点运行时、第三方服务或用户数据处理；临时 Node 归档与测试目录在 CI 验收完成后删除。

## 2026-07-19 — 完成 #10 确定性 SPDX 规范化实现

- **主题**：按 Roadmap 串行实现 I-02 / #10；在 #9 的 E-010 隔离 npm 入口上建立确定性 SPDX、显式时间状态机、旧证据复核和两文件一致发布，不提前执行 #21 的真实依赖解析与准入。
- **主要不变量**：相同 npm native SPDX 语义无论原生时间、随机 namespace、对象键和可多值集合顺序如何变化，都必须产生逐字节相同的 canonical SPDX 与 evidence；合法包、checksum 或 relationship 语义变化必须同时改变 semantic 摘要、document namespace 和最终文件摘要。schema、creator、expected graph、旧证据、两次 native 结果、生成输入或发布快照不一致时以稳定 `SPDX_*`/`NPM_LOCK_*` code 失败关闭。
- **完成内容**：
  - 新增 `spdx.mjs` 严格解析 npm 受控 SPDX 2.3 子集，固定 unsigned UTF-8 排序、递归 canonical JSON、单末尾 LF、三段摘要前像、确定性 namespace、显式 `createdAt` 生命周期和固定 evidence 封套；公开生成命令只允许空参数或 `--created-at`，不开放 raw input/output/root/force/now 旁路。
  - 扩展唯一 lock parser 生成内存 expected graph，绑定根包、包身份、路径、resolved、purl、SHA-512 与完整 relationship；按受控 Arborist precedence 处理 peer/peerOptional、prod、optional 与根 dev，并拒绝缺失必需节点。#21 继续负责用真实 tarball evidence 交叉绑定声明许可证并收紧生产投影，不建立第二份依赖清单；后续审查确认固定 npm `11.16.0` 的依赖 SPDX 从 lock virtual tree 生成，homepage/description 不由 lock 提供，因此这两项的 tarball 原始值只进入 NOTICE/evidence，不补写 native SPDX expected graph。
  - 生成器连续调用两次 E-010 `sbom-native` profile，各用全新 HOME/config/cache/log/tmp，要求规范化结果一致；既有制品先按自身 npm creator 自洽复核，只有相同语义才复用旧时间，合法 graph 或 npm patch 变化可携带新时间进入更新分支。
  - 两文件先写入并 fsync 候选目录，再经备份目录切换；生成锁、四个输入摘要、旧/新完整快照、候选文件/目录 fsync 和每次父目录 fsync 均有定向证据。备份丢失或变化时保留可检查状态并报 `SPDX_ARTIFACT_PUBLISH_UNCERTAIN`，不得重新激活已知无效字节或误报恢复。
  - 新增完整 golden、metamorphic、mutation、状态机、旧证据篡改、双 native 漂移、graph A→B、npm patch A→B、发布回滚/不确定状态、锁竞争、激活后输入漂移、真实随附 npm offline shape 等 19 项 E-011 验收；统一质量入口继续独立运行 #9 的 36 项上游回归。
- **验收证据**：
  - 固定 golden：`semanticSha256=490df7add3035780f366e3e3a013d79541502ff67bc9898daa443dd0e94a78b0`，`documentSha256=e353bcf6093a23416a493c4efe155e45b0caf97de89f834c4d9963a1f6816845`，`fileSha256=82a8f8c5f90ef0864c99e0b26ba35acb3741b2b30121df984afbc59159087de2`。
  - Node.js 官方 `SHASUMS256.txt` 再次校验主端点归档 `55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742`、最低端点归档 `d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9`；校验失败的首次 24.18.0 续传文件未执行，完整重下并匹配官方摘要后才验收。
  - 最新字节分别在 `Node 24.18.0 / npm 11.16.0` 与 `Node 24.16.0 / npm 11.13.0` 执行 `node scripts/quality/run-quality.mjs`，两端均退出 0；每端 E-010 36/36、E-011 19/19，通过真实 `npm sbom --package-lock-only --sbom-format=spdx --sbom-type=application --offline` shape。`git diff --check`、核心模块语法和独立对抗式复核也通过，复核未留下 P1/P2。
- **下游交接**：#21 必须复用本项公开生成入口、E-010 profiles、唯一 lock parser、expected graph schema、稳定错误码和 evidence 路径；真实候选图的首次解析、tarball 下载、许可证/NOTICE/脚本检查、显式 audit、NOTICE 生成、双端点冻结安装和最终人工准入仍需单独 npm 联网与准入授权。不得绕过隔离入口、人工编辑 expected graph/SBOM、从墙钟补时间或以本合成 fixture 冒充真实依赖准入完成。
- **残余边界**：目录切换的两个 rename 之间活动作者路径可能短暂 `ENOENT`，不承诺无锁读者路径连续可读或单操作崩溃原子性；生产部署不得并发读取该生成目录。排他锁不约束外部不协作写入者，摘要与快照复核仍存在最后一次检查到文件系统操作之间的极窄竞争窗口。当前未创建真实 `package-lock.json`、正式 SBOM/NOTICE 或依赖准入结论，未访问 npm registry、未安装依赖、未推送或发布。

## 2026-07-19 — 完成 #9 npm 隔离实现并前移版本契约

- **主题**：按 Roadmap 串行实现 I-01 / #9；先完成零依赖 npm 隔离入口与反例门禁，再处理公开 CLI 被后置版本文件阻塞的问题。
- **范围决定**：用户确认方案 A。`.nvmrc`、`package.json#engines.node` 和主/最低 Node/npm 双端点离线真实 CLI 验收从 #22 前移到 #9；#21 把该版本契约作为依赖准入输入，#22 只继续负责 Docusaurus scaffold、严格 TypeScript、模块边界、typecheck 与 build。该调整不改变 D-067/D-073 已确认的版本值或现有 Issue 依赖图。
- **授权边界**：获准更新仓库文档与 GitHub #9/#21/#22，并仅从 Node.js 官方站点把两套 Linux x64 发行归档和校验文件下载到 `/tmp`，校验后离线验收并删除；完整验收和 Issue 关闭后，用户另行授权把本项形成独立 Git 提交。未授权 npm registry、依赖安装、系统级 Node 安装或 Git 推送。
- **主要不变量**：只有由当前 Node 发行版前缀可信派生、且与 `.nvmrc`/`engines.node` 角色及 D-073 随附版本一致的 npm CLI，才能在项目配置、有效配置、空 cache、封闭环境、manifest/lock 来源和 profile 预检全部通过后启动；违反时以稳定 `NPM_*` code 失败，错误不回显原始凭据或敏感配置。
- **完成内容**：
  - 创建 `.nvmrc`、封闭的 `package.json#engines.node` 和九键 `.npmrc`；Node patch 只从 `.nvmrc` 与 `engines` 下界派生，代码只保存 D-073 两个角色的随附 npm 版本，避免第三份 Node patch 真相源。
  - 创建 `scripts/quality/run-isolated-npm.mjs`、`lib/supply-chain/` 隔离实现与五个封闭 profile；隔离 HOME、user/global config、cache、日志、临时目录、PATH、proxy/CA/凭据环境，校验 CLI 信任树、有效配置、registry-only manifest/lock v3，并让 `resolve-lock` 在排他锁与 staging 校验后原子发布候选。
  - 将 JS 语法、隔离门禁、文档、契约、Secret、静态入口和 E-010 测试接入统一零依赖质量负载；pre-commit 使用隔离入口，现有 Node 22 CI 暂时直接运行同一零 npm 聚合负载。操作文档、workflow、hook 与 package script 的包管理器旁路由静态门禁覆盖。
  - `tests/build/run-isolated-npm.test.mjs` 覆盖正常路径以及配置污染、来源漂移、CLI/path/tree 逃逸、环境泄漏、profile 越权、workflow/job 代偿、操作文档旁路、lock 竞争/回滚和输入漂移反例；DocRestore 与 Project Scaffold 自身命令明确不属于本站操作入口扫描范围。
- **验收证据**：
  - 官方 `SHASUMS256.txt` 校验通过：主端点归档 SHA-256 `55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742`，最低端点归档 SHA-256 `d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9`。
  - 主端点 `v24.18.0 / npm 11.16.0` 与最低端点 `v24.16.0 / npm 11.13.0` 分别执行 `node scripts/quality/run-isolated-npm.mjs run-script quality`，均退出 0、36/36 测试通过，并输出 `registry=official, cache=fresh, config=isolated`。
  - 当前工作区 Node 22 执行同一公开入口时退出 1，并在 npm 启动前返回 `[NPM_RUNTIME_NODE]`；独立 `node --test tests/build/run-isolated-npm.test.mjs` 为 36/36，`git diff --check` 通过。
  - 两套官方归档、校验文件、测试临时目录和 Issue 编辑临时文件均已从 `/tmp` 删除；未访问 npm registry、未安装依赖、未创建 lockfile、未修改系统 Node。
- **下游交接**：#21 必须直接消费 `.nvmrc`、`engines.node`、`.npmrc`、`NPM_VERSIONS_BY_ROLE` 与现有 profile/error 契约；首次联网仍需单独授权，只允许主端点经 `resolve-lock` 生成候选，再按 D-077 完成 tarball、许可证、脚本、漏洞、SBOM/NOTICE 和人工准入，最低端点只读同一 lockfile。下游不得复制 Node patch、从 PATH 启动 npm、恢复共享配置/cache、切换 registry/包管理器或把 E-010 单项通过解释为依赖准入完成。
- **残余边界**：仓库内 `resolve-lock` 执行者通过互斥锁串行化；对不遵守该锁的外部写入，发布器会在进入发布和最终 rename 前核对初始 lock 摘要并失败关闭，但标准文件系统原语不能消除最后一次摘要读取与 rename 之间的纳秒级竞争窗口，因此不把它表述为任意外部写入者下的线性一致性。静态旁路扫描覆盖仓库声明式操作入口，但不是任意动态命令执行的安全沙箱。E-011 确定性 SPDX、真实依赖图、冻结安装、Docusaurus/TypeScript、Node 24 Ubuntu CI 拓扑和 Action pinning 尚未实现，由后续 Roadmap 任务负责；#9 已关闭并由当前独立提交收口，#10 尚未启动。本轮未推送或发布。

## 2026-07-19 — 将 M0 设计拆解为可执行父子 Issue Roadmap

- **主题**：按 `codex-rules/rules/issue-task-rules.md` 把已确认 M0 设计拆为一个总父任务、五个阶段父任务和单一不变量子任务；将现有 open issues 纳入真实依赖链，避免编码时重新解释范围或等待最终端到端验收才补证据。
- **完成内容**：
  - 创建 GitHub milestone [M0 静态主站上线](https://github.com/lyty1997/AxialMuseWebsite/milestone/1) 和总父任务 [#15](https://github.com/lyty1997/AxialMuseWebsite/issues/15)；以原生 sub-issues 建立 [#16 M0-I](https://github.com/lyty1997/AxialMuseWebsite/issues/16)、[#17 M0-C/M0-S](https://github.com/lyty1997/AxialMuseWebsite/issues/17)、[#18 M0-P](https://github.com/lyty1997/AxialMuseWebsite/issues/18)、[#19 M0-L](https://github.com/lyty1997/AxialMuseWebsite/issues/19) 和 [#20 M0-O](https://github.com/lyty1997/AxialMuseWebsite/issues/20) 五个阶段父任务。
  - 保留 #5 至 #14 的问题发现历史，把正文顶部改成实现期契约：每项固定主要不变量、设计真相源、对外接口或产物、范围与非范围、最小 `blocked-by / blocks`、正常路径、反例和关闭证据；#13 收窄为仓库侧 301 派生，服务器账本与原子激活独立进入 #37；#14 收窄为 fresh `production-artifact` 字节所有权，deploy 身份与服务器 verifier 分别进入 #34、#35。
  - 新建 #21 至 #43，补齐真实依赖准入、Node/TypeScript 基线、内容领域与作者工具、页面和响应式、两个项目内容包、CI/release、服务器、DNS/TLS、首次上线、定时维护和恢复演练。全部外部联网、GitHub 接线、服务器、TAT、DNS、证书、Git 发布和生产操作继续保留单独授权门禁。
  - #4 的原始职责只是活动设计文档一致性，其验收已完成；在链接新 Roadmap 和保留原始上下文后按 completed 关闭。#5 至 #14 的有效实现范围没有弃做或关闭。
  - M1 只在 M0 上线并积累真实内容后复评可发现性能力，M2 的账户、评论、订阅和用户数据仍需新的产品与隐私决策；本轮没有把它们拆成已授权编码任务。
- **验证结果**：
  - GitHub #4 至 #43 共 40 个里程碑条目，#4 为 closed，#5 至 #43 共 39 个 open；没有缺失 milestone、任务必填段落或父子关系。
  - 五个阶段父任务共挂载 33 个执行子任务；40 条直接依赖边在 `blocked-by` 与 `blocks` 两侧完全对称，拓扑排序覆盖全部 33 个节点且无环。
  - 任务图的最短主链为“npm 隔离/确定性 SPDX -> 真实依赖准入 -> Node/测试/内容/构建 -> 项目内容 -> release/artifact -> 服务器原子激活 -> DNS/HTTPS -> 24 小时观察 -> 自动维护与恢复”。
- **遗留项**：
  - 编码应从可并行、无网络的 #9 和 #10 开始；它们闭环后，#21 的首次 npm 解析、tarball、audit 和双端点安装仍需用户明确授权。
  - 本轮未开始站点实现，未提交、推送或创建 PR，未操作服务器、TAT、DNS、证书或生产环境；外部写入仅限用户已授权的 GitHub milestone、Issue 正文/层级和 #4 关闭操作，未引入新的第三方服务或用户数据处理。

## 2026-07-18 — 独立验收 11 个 open issue 的验收标准

- **主题**：对 [Issues #4 至 #14](https://github.com/lyty1997/AxialMuseWebsite/issues?q=is%3Aissue) 逐条验收其“验收标准”，判定各 issue 当前是否可关闭，并把结论与复核发现留痕到 issue 与本文件。本轮为只读验收，未改动任何设计、代码、配置或基础设施。
- **方法**：22 个 agent 编排（每 issue 一个审计 + 一个对抗式 skeptic 复核，0 分歧）；主会话实测可执行门禁并独立核对 `open-decisions.md`、`scripts/`、`.github/workflows/ci.yml` 与契约数据，凡 owner 评论声称“已落盘 E-xxx/CODE-xxx”的均回文档核验决策存在且覆盖对应验收点。
- **完成内容**：
  - **统一结论：11 个 issue 全部为 DESIGN-COMPLETE / IMPL-PENDING（设计已闭合、实现待落地），无一可关闭。** E-001 至 E-015 / CODE-018 至 CODE-020 已在 `open-decisions.md` 与专题文档中形成单一设计结论，各 issue 的验收标准中“文档一致性 + 门禁通过”类已 MET，“schema 运行时行为 / validator / fixture / CI checkout / 生成器 / Nginx 派生 / 截图验证”类均 DEFERRED —— 因仓库处于纯设计阶段，无 `src/`、`site-content/`、`docusaurus.config.*`、`tests/`、`package-lock.json`，也无 `scripts/build`、`scripts/release`、`scripts/content`、`run-isolated-npm.mjs`、`check-content-history.mjs`。
  - #4 作为“设计闭包”总控项，自身文档同步 4/4 MET，但最终闭包须待 #5–#14 实现落地后回本项复核，故保持开启。
  - 在 #4–#10 各补一条“验收复核结论”评论（#11–#14 已有 owner 的等价评论），记录逐条判定、门禁结果、复核发现与“暂不可关闭、保持开启跟踪实现”的结论。
- **复核发现（实现期 backlog，均不阻断设计闭包）**：
  - **#7**：准则 5“不依赖文件命名约定” 与 “检出混入 `static-public/` 白名单的误放未发布/项目素材” 存在设计张力，未说明如何两全；`site-content/writing/<entry>/assets/` 草稿文章同目录素材的生产不泄漏缺具名反例 fixture；因两项目均 `planned` 且无 `previewImage`，白名单机制当前无真实数据背书。
  - **#9 / #10 / #11**：`CODE-011` 为 E-007/E-008/E-012/E-014 逐条列了必需 fixture，却未给 E-010（供应链，含“恶意 scoped registry”）、SPDX schema/校验和维度反例、跨模块导入等价枚举；fixture 产物 DEFERRED 无误，但“哪些用例必须覆盖”的 fixture 设计契约缺席。
  - **#11**：E-012 定 `sourceMap:false` + finally 无条件清理临时目录，失败时既无 source map 也不留临时 `.js`，与“保留失败诊断”目标相抵，属有意取舍需显式记录。
  - **#12**：`.github/workflows/ci.yml:20,39` 的 `actions/checkout@v5` 未设 `fetch-depth:0`，仍是默认单提交的迁移前实现（E-013:110 已自陈）；历史门禁还前置阻塞于 `@docusaurus/utils@3.10.2` 的 D-077 依赖准入。
  - **#13**：`docs/contracts/redirects.json` 顶层封套字段（`version/kind/status/owner`）在 E-014/CODE-019/m0-spec 中均无 schema 描述，属源契约封套可追溯性缺口（不影响运行时验收）。
  - **#5**：docrestore 过渡段补回旧注册表 `problem/decisions`，vibecoding 未补（其旧 decision“采用 Apache-2.0”只存活于事实表），迁入 `site-content` 前建议内容审查复核两项目一致性；E-006 有意把语义级重复划归人工审查、不做相似度门禁。
- **验证结果**：
  - `git diff --check`、`npm run quality`（js/docs/contracts/secrets/site）均 PASS；`npm run check:diagrams`（`PUML_JAR` 指向本机 plantuml jar）3 个 block 编译通过。
  - 独立 `ls` 确认上述实现产物全部缺失，坐实“设计完整、实现待定”的判定；#4–#10 的 7 条评论均已发布成功。
- **遗留项**：
  - 无 issue 可关闭；11 个全部保持开启跟踪实现。下一门禁仍是 D-077 首次联网依赖解析与真实准入，及 Action/凭证接线、Git 发布授权。
  - 本次未提交、推送、创建或合并 PR，未操作服务器/DNS/云资源；仅新增 7 条 issue 评论并更新本进度文件。

## 2026-07-18 — 建立设计审查跟踪并恢复活动真相源一致性

- **主题**：复核外部代码审查指出的预览、内容所有权、媒体、供应链、测试、Git 历史、301 重定向和制品交接问题，先建立可验收的 Issue，再按依赖顺序逐项补充设计。
- **完成内容**：
  - 核对当前仓库后确认 11 条审查意见均仍成立，在 GitHub 分别创建 [Issues #4 至 #14](https://github.com/lyty1997/AxialMuseWebsite/issues?q=is%3Aissue)，统一保留 P1/P2 优先级、冲突证据、错误后果、设计任务、验收标准和关联顺序。
  - 先处理 #4：把 M0 路线从迁移前单页改为已确认的 Docusaurus 多页面范围，移除 M1 对 M0 内容模型、目录、详情和基础 SEO 的重复规划；将 M1 改为基于真实内容需求再评估可发现性能力。
  - 明确 D-031 的尾斜杠语义已经由 E-002 补充，移除“仍待用户决定”的失效状态；目标架构不再把已经更新的 M0 Spec 列为待更新项。
  - 重新开放 OD-014 的实施设计一致性收口：D-078 的委托和既定上层方向保持有效；不宣告完整设计闭包，也不把 D-077 首次联网依赖解析写成唯一实现阻塞。
  - 完成 #5 的设计归一：以 E-001 为上位结论新增 E-006，项目注册表删除 `problem`/`decisions` 迁移残留并升级契约版本；项目正文最终唯一拥有问题、能力、取舍、限制、证据说明和复盘，自动门禁拒绝 frontmatter 与 H1，普通叙事的重复风险由内容审查处理。正文创建前由两个项目设计文档中的标记章节临时拥有叙事，创建正文的同一提交必须移动内容并把原章节替换为链接；DocRestore 已补回旧注册表中独有的问题和取舍，确保无损迁移。
  - 完成 #6 的设计：新增 E-007 与 `previewImage` 四字段 schema，主预览由注册表显式选择，固定非动画 WebP、1600 x 1000、最多 300,000 bytes，并绑定固有尺寸和替代文本；当前两个 `planned` 项目没有获确认素材，因此不创建占位字段或文件。
  - 完成 #7 的设计：新增 E-008，把项目预览原件、始终公开资源和构建临时白名单树拆开；production 只复制公开状态项目的登记预览，preview 可复制全部已登记预览，生产制品再以路径、字节、SSR 引用、未发布路径和源摘要检查证明没有泄漏。
  - 完成 #8 的设计：新增 E-009，以 Docusaurus `build --dev` 生成含 draft、全站 `noindex, nofollow` 且无 sitemap 的候选静态制品；Python 服务稳定读取 worktree 外 `PREVIEW_STATE_DIR/current`，候选通过后原子切换，fetch、依赖、构建、检查或切后冒烟失败时保留或恢复上一活动 release。预览不安装或解析依赖，不新增常驻服务，也不能进入生产封装。
  - 完成 #9 的设计：新增 E-010，所有候选解析、冻结安装、audit、原生 SBOM 和 CI npm script 都经封闭 profile 的零依赖隔离入口；每次调用使用临时 HOME、空 user/global 配置和全新 cache，联网前离线核验官方 registry、scope、认证、代理和证书边界，拒绝继承当前机器的镜像与共享缓存。
  - 完成 #10 的设计：新增 E-011，把 npm 原生 SPDX 2.3 作为语义输入，规范化原生随机时间、UUID namespace 和无序集合；`createdAt` 只由显式生成参数持久化，namespace 从 canonical 文档摘要确定派生，并以两个空临时目录的逐字节一致性 fixture 防止同一 lockfile 的制品漂移。
  - 完成 #11 的设计：用户选择严格 TypeScript 测试方案，D-079 将 `@types/node@^24.0.0` 加入直接开发候选但保留真实依赖准入门禁；E-012 把测试从根 Docusaurus `bundler`/`noEmit` program 分离到 NodeNext/ES2024 配置，先输出到系统临时目录，再以当前 Node `--test` 执行编译后 ESM，并固定 `.js` 说明符、零测试失败、双 Node 端点同负载和失败清理契约。
  - 完成 #12 的设计：新增 E-013，把稳定身份历史闭包固定为当前 `HEAD` 可达完整 Git DAG；检查器按每个提交的直接父状态维护 source-name 映射及 articleId/注册表 ID 的首次引入 lineage，覆盖原子改名、删除后重引、平行分支独立引入同一 ID 和 merge 第二父冲突。当前内容与历史提取共用 Docusaurus 3.10.2 公共结构化 frontmatter 解析器；`@docusaurus/utils@3.10.2` 只作为后续 D-077 的直接开发候选。Git 2.43 通过空 `GIT_ALLOW_PROTOCOL` 和 partial/promisor/alternate object store 预检保证无协议访问，不依赖不受支持的 `--no-lazy-fetch`。所有运行该门禁的 CI job 必须完整 checkout 且保留 PR merge ref；作者命令复用同一实现，不复制历史算法。
  - 完成 #13 的设计：新增 E-014/CODE-019，`redirects.json` 继续唯一拥有旧 URL 与原因；release 封装器从同一 production payload 的实际公开页面和注册表确定派生运行清单与 Nginx exact-location 配置，不再生成返回 200 的静态跳转页。登记 source 的带斜杠/无斜杠形式与活动页面的无斜杠形式都单跳 canonical 目标并保留查询；路径 allowlist、目标 200、source HTML 缺失、链环/冲突、稳定序列化和配置注入由 fixture 失败关闭。服务器把 payload/config 安装到同一不可变 SHA，Nginx 请求期使用精确 SHA root/include；`current` 只在配置解析时选代。root-owned 只追加 URL 暴露账本在 reload 前预写候选的全部规范路由和新增或改指的 registered 边；`canonical-slash` 不单独入边账本，但其 target 由规范路由预写保护。候选与回滚必须使每个历史 source/target 收敛到同一当前 200。只有兼容 fallback 可自动回滚；首次发布新 canonical URL 时旧 release 通常不兼容，因此默认停止或经单独生产授权进入 forward-only。
  - 完成 #14 的设计：新增 E-015/CODE-020。对比“跨 job 上传已验证 build”和“最终 job 自包含重建”后，选择后者：`website-quality` 保持 PR/`main` required check，但其 job-local build 不具有部署身份；四个 prerequisite 全部成功后，非 matrix `production-artifact` 在 fresh runner 对同一 SHA 完整 checkout、使用全新隔离 cache 冻结安装并重新执行主端点完整 `quality`，随后不插入第三方 Action 或第二次 build，立即对同一 `build/` 计算树摘要、封装、独立复验、计算 artifact 外 `releaseContentSha256` 并一次上传。最终身份绑定 repository、run/attempt、artifact ID、commit SHA、外层 `artifactDigest`、上传前 release tree、source build tree 与内部 metadata；deploy 只能消费该 job outputs，并以仅 `contents: read`/`actions: read` 的权限复核 canonical main HEAD 和当前 artifact 后才引用 CAM Secret。concurrency 只互斥，不替代新鲜度；服务器分别比较两个外传摘要，禁止按名称、latest、跨 run 或本地 fallback 选择。该方案让 `main` 多构建一次，但避免中间 artifact、download Action、归档权限/隐藏文件、重跑和过期协议。
- **验证结果**：
  - `npm run quality` 通过，覆盖现有 JavaScript 语法、Markdown 链接与索引、契约词、Secret 启发式扫描和迁移前静态入口检查。
  - PlantUML 三个活动源码块独立提取并以仓库固定编译器编译通过，`dev-workflow-loop.svg` 已与新的 Docusaurus 候选构建和原子切换流程同步。
  - 定向扫描与独立复核不再发现 Docusaurus 适配未完成、M0 实现单页、M1 才结构化、尾斜杠仍未决、还需更新 M0 Spec，或把 D-077 写成唯一实现阻塞等失效活动表述；#11 相关活动文档不再把 Node ESM 测试或 `@types/node` 直接候选写成未决。#12 的独立审计发现并推动修复了并行 UUID 复用、Git 2.43 惰性拉取隔离、frontmatter 解析所有权和陈旧状态四类缺口；活动文档现统一采用结构化解码、完整非浅 HEAD 可达 DAG、lineage 父状态与 PR merge ref 语义。
  - 通过 npm 官方版本页核对 `@types/node` 仍维护 Node 24 版本线；本次没有因此请求 registry 解析、下载 tarball、创建 lockfile 或接受其真实传递图。
  - 通过 Docusaurus `3.10.2` 精确官方源码核对 `@docusaurus/utils` 公开导出 `DEFAULT_PARSE_FRONT_MATTER`，并确认同版本默认实现使用结构化 gray-matter 解析；该包只进入 D-077 候选，没有安装或解析。当前 Git `2.43.0` 实测不接受 `--no-lazy-fetch`，而空 `GIT_ALLOW_PROTOCOL` 会在尝试本地 file transport 前直接拒绝，因此 E-013 采用后者并先拒绝所有 partial/promisor/alternate object store。
  - 对照 Nginx 官方 `location`、`return`、embedded variables、command-line switches 与 reload 文档，确认 exact location 在规范化 URI 上终止匹配、`$is_args$args` 可显式保留查询、server 级 rewrite 指令会先于 location 搜索、`nginx -t` 只验证语法/引用文件，以及 graceful reload 会让新旧 worker 分别持有完整配置代。第一轮独立只读复核指出 301 客户端缓存无法由服务器回滚撤销；第二轮复核发现“只检查目标存在”会误放缺少历史 source 规则的 release；第三轮复核发现 canonical-slash 可能在公网冒烟前缓存新 target。设计因此改为在 reload 前只追加全部候选规范路由和 registered 边，以 source/target 同终点谓词明确兼容 fallback 与 forward-only 恢复边界。
  - 对照 GitHub 官方 job/prerequisite、upload artifact ID/digest、不可变性、覆盖换 ID、隐藏文件和权限归一化文档，确认独立 job 不能共享本地 `build/`。两轮只读分析分别验证了 handoff 路线的最低安全协议和 fresh rebuild 路线的维护成本；最终采用后者，并明确它保证最终 build 自身完整重验，不虚构两次 runner 输出可复现。
  - #14 最终独立审计先发现“禁止 cache”与 E-010 本次 job 私有 npm cache 的措辞冲突，随后发现旧 run 晚到、上传前 release 期望摘要未穿过 TAT、GitHub token 权限未固定，以及误要求 upload Action 证明 download mismatch 四项闭包缺口。活动文档现统一禁止共享/恢复 cache 而保留全新私有 cache；deploy 在 CAM 前检查 canonical main HEAD；`artifactDigest` 与 artifact 外 `releaseContentSha256` 分别传递并由服务器复算；producer/deploy 只保留所需只读权限。后续官方语义复核又固定 upload/TAT 裸 hex 与 REST `sha256:` 前缀的严格转换，跨信任边界以仓库/服务器双实现和共用 golden vectors 防摘要漂移，并把过期历史 SHA 排除在普通 rerun 与 4 小时 RTO 承诺外。最终只读一致性、官方语义和威胁复核均未发现剩余 P1/P2。
- **遗留项**：
  - #5 至 #14 的设计缺口已收口，Issues 继续保留实现、fixture 与真实验收跟踪；当前下一门禁是 D-077 首次联网解析、真实候选依赖图与 Action 的最终准入，尚未获得下载、安装、workflow 修改、Git 发布或生产操作授权。
  - 本次没有安装依赖、创建 lockfile、执行 npm 联网解析、修改站点代码或基础设施，也未新增第三方服务、浏览器外部请求或用户数据处理；Git 提交、推送、PR 和合并未获本次授权，因此未执行。

## 2026-07-18 — 收口 M0 内部工程设计与实施边界

- **主题**：用户确认总体方向已经足够明确，将 M0 剩余内部技术与展示细节委托给 Agent 根据仓库事实、对应版本官方资料和工程知识判断；外部依赖、公开事实、用户数据、Git 发布和基础设施继续保留门禁。
- **完成内容**：
  - 在 AGENTS 规则和 D-078 中持久化有边界的工程委托；以 E-001 至 E-005 固定项目结构化事实/长文职责拆分、尾斜杠与路由闭包、作者/主题/模块注册表、classic/Infima 最小主题适配和 GitHub Actions artifact 到 TAT 的静态交付边界。
  - 将 M0 Spec 从失效的原生 HTML 单页草案整体改写为 active 的 Docusaurus 多页面基线，固定首页、项目目录/详情、技术分享目录/详情、三栏折叠、内容可见性、SEO、素材和 Definition of Done；M0 明确不生成搜索、主题/作者/系列/归档等未需要路由。
  - 扩充编码 Spec 到 `M0-complete`：固定错误模型、路径与符号链接、公共 API、命名、CSS/资源、测试 fixture、日期索引、侧栏、Markdown 文章命令、供应链证据布局、`payload/ + metadata/` release 封装、最小质量工具和 Ubuntu CI job 拓扑。
  - 新增 `authors.json`、`topics.json`、`redirects.json`，为项目注册表补充 `navigationOrder` 与 `writingModules`；去除项目与体验注册表重复维护的在线布尔、标题、仓库和展示事实，体验入口只由 `live` 状态与健康检查决定。
  - 当时统一架构概览、内容发布、域名部署、维护和生产清单：Docusaurus 默认输出 `build/`，Actions 封装 `dist/release/payload/` 与 `metadata/`，服务器只验证并安装 payload，不安装 Node/npm、不拉源码、不构建；本条的“只安装 payload”后来由 E-014 补充为同一 release 还安装非公开运行重定向配置，生产仍不构建。同步更新并编译目标生产 PlantUML 图。
- **验证结果**：
  - `npm run quality` 通过；当前只覆盖迁移前 JavaScript、Markdown、契约词、Secret 启发式扫描和手写静态入口，不代表 Docusaurus 依赖、类型检查或构建已经实现。
  - 新增和修改的 6 个 JSON 契约均可解析；`git diff --check` 通过；定向扫描未发现 active 设计仍把 D-078 范围内事项写成用户待决策，也未发现旧 `onlineExperience` 双写、失效单页 Spec 或服务器拉源码目标。
  - PlantUML 源码提取与编译 2/2 通过，更新后的目标图为 `payload/ + metadata/` 链路，生成 SVG 与最终源码编译结果一致。
- **遗留项**：
  - 下一实施门禁是 D-077 的首次 npm 联网解析、精确 tarball 证据、真实传递图最终准入和冻结安装；这些外部请求仍需单独授权，本次未下载或安装依赖。
  - 两个项目的真实公开视觉证据仍未准备，阻塞项目改为 `published`，但不阻塞框架、schema、空状态和页面结构实现；DocRestore 视频继续是非阻塞增量。
  - Action commit SHA 与凭证、Git 发布、服务器/TAT、DNS、证书和生产上线仍需各自准入、现场核验和操作授权。
  - 本次未新增站点运行时第三方服务、浏览器外部请求或用户数据处理，未执行提交、推送、PR 或基础设施操作。

## 2026-07-18 — 确认首次依赖解析与供应链准入闭环

- **主题**：用户确认 D-077，采用“npm 原生能力 + 仓库内零第三方依赖策略脚本”完成首轮 Docusaurus 候选依赖的失败关闭准入，不为扫描本身新增第三方供应链依赖。
- **完成内容**：
  - 固定准入顺序：只有主端点可在隔离目录以 `npm install --package-lock-only --ignore-scripts --audit=false` 生成候选 lockfile；正常安装前按精确 tarball 审查 integrity、实际许可证/NOTICE 和生命周期脚本；许可证与脚本人工预审后生成派生制品并通过漏洞门禁，最终人工准入通过后两个 npm 端点才可使用 `npm ci --ignore-scripts --audit=false` 读取同一依赖图并以执行前后哈希证明 manifest/lock 不变。
  - 固定官方 npm registry-only、`lockfileVersion: 3`、许可证证据缺失或不明确即暂停、生命周期脚本默认拒绝且例外逐个 `name@version` 重决策的边界。
  - 固定 npm 原生 SPDX JSON SBOM、生成式 `THIRD_PARTY_NOTICES`、包含开发依赖的显式全图 `npm audit`、`moderate` 及以上阻断、`low` 报告、禁止 `npm audit fix` 及审计服务不可用时失败关闭。
  - 明确 `package.json`、`package-lock.json`、人工准入记录、SBOM 与 NOTICE 的唯一职责和派生关系，禁止人工维护第二份依赖清单；同步更新架构、编码 Spec、运行手册、M0 Spec、文档入口和贡献指南。
  - 记录显式 `npm audit` 向官方 registry 发送依赖包名与版本、回退协议可能发送完整锁定树和构建环境元数据的边界；该批准只用于未来构建/CI，不涉及浏览器、站点内容或访问者、账户、评论数据。
- **验证结果**：
  - 对照 npm 11 官方 `install`、lockfile、`ci`、`sbom`、`audit` 文档及 npm `11.16.0` 的 `allowScripts` 当前行为，确认 `--ignore-scripts` 仍是两个 npm 端点可共同执行的禁脚本基线。
  - `npm run quality` 通过：现有质量脚本语法、Markdown 索引与内链、契约词、Secret 启发式扫描和迁移前静态入口检查全部成功；该结果不表示 D-077 已被当前质量入口实现。
  - `git diff --check` 通过；定向扫描未发现活动文档仍把首次供应链准入协议、SPDX 格式或漏洞阈值整体写成未决。
  - 仓库仍不存在 `package-lock.json`、`node_modules/`、`tsconfig.json`、Docusaurus 配置、正式准入记录、SPDX SBOM 或 `THIRD_PARTY_NOTICES`；本次未修改 PlantUML 源码，因此未运行图表编译或生成 SVG。
- **遗留项**：
  - 零第三方依赖策略脚本的精确路径与接口、准入记录 schema、派生制品布局、报告保留和 CI job 接线仍需实施设计；候选 lockfile、真实传递图、许可证与脚本结论、正式 SBOM/NOTICE、显式 audit 结果、双端点冻结安装和制品/浏览器检查均尚未产生。
  - 首次实际解析、tarball 下载、审查和安装仍须在执行前展示准确操作范围并单独取得授权；本轮未发起 npm registry/audit 请求，未下载或安装依赖，未运行候选生命周期脚本。
  - 本次只更新设计文档，不修改依赖清单、质量脚本或 CI，不创建工程骨架，不操作服务器、DNS、证书或云资源，也未提交、推送、创建或合并 PR。
  - 本次未新增站点运行时第三方服务、浏览器外部请求或用户数据处理。

## 2026-07-18 — 确认 Docusaurus TypeScript 编译与首轮直接依赖基线

- **主题**：用户接受“Docusaurus `3.10.2` 官方 TypeScript 基线继承 + 本站显式收紧”的推荐方案，一次关闭首轮 React/MDX/TypeScript 与类型工具候选直接依赖，以及 `tsconfig` 继承和模块解析的选型空白。
- **完成内容**：
  - 记录 D-076：D-073 的三个框架包继续精确 `3.10.2`；首轮应用候选直接依赖使用 React 19、React DOM 19 与 MDX React 3 的官方模板范围，首轮开发候选直接依赖使用三个精确 `3.10.2` Docusaurus 类型/配置包、React 19 类型和 TypeScript `~6.0.2`；实际解析版本只由未来唯一 `package-lock.json` 冻结。
  - 明确 `clsx`、`prism-react-renderer`、`@types/node`、`@types/react-dom` 及其他模板或未来源码中的包不因此成为新增直接依赖；真实用途出现时重新准入，作为候选传递依赖出现时仍执行 D-052 审查。
  - 固定目标根 `tsconfig.json` 继承精确 `@docusaurus/tsconfig@3.10.2`；本站显式设置 `baseUrl`、TypeScript 6 弃用过渡、严格模式和禁用 JavaScript，并把首轮 program 限定为两个根框架入口与 `src/**/*.ts(x)`。`module`、`moduleResolution`、`noEmit` 和 `skipLibCheck` 由官方基线拥有，本站不重复声明，也不增加自定义 `paths`。
  - 保持 `tsc --noEmit` 与 Docusaurus build 相互独立；记录 TypeScript 7、Docusaurus 4 或官方基线变化会触发重新审查，当前过渡配置不能永久沿用。
  - 将 D-076 传播到主站目标架构、架构概览、M0 Spec、编码 Spec、运行手册和文档入口；保留 D-073、D-074、D-075 及旧进度条目的历史原文，不倒改各决定形成时的授权范围。
- **验证结果**：
  - 对照 Docusaurus `3.10.2` 官方 TypeScript 文档、官方模板与精确提交下的 `@docusaurus/tsconfig` 源码，核对直接依赖范围、继承选项和 TypeScript 6 的 `baseUrl` 过渡行为。
  - `npm run quality` 通过：现有质量脚本语法、Markdown 索引与内链、契约词、Secret 启发式扫描和迁移前静态入口检查全部成功；该结果不表示候选依赖已经准入或目标类型检查已经接线。
  - `git diff --check` 通过；定向扫描未发现活动摘要仍把首轮 TypeScript/类型包版本、`tsconfig` 继承或 module/moduleResolution 写成待决。
  - 仓库仍不存在 `tsconfig.json`、`package-lock.json`、`docusaurus.config.ts`、`sidebars.ts` 或目标 `src/`；本次未修改 PlantUML 源码，因此未运行图表编译或生成 SVG。
- **遗留项**：
  - 首轮候选依赖仍须完成直接登记、候选 lockfile、传递依赖许可证与生命周期脚本扫描、SBOM/第三方声明、制品网络检查及两个 npm 端点读取同一 lockfile 的失败关闭验证；后续真实用途新增依赖继续单独准入。
  - 实际 `tsconfig.json`、依赖、lockfile、双门禁和 CI 接线尚未创建；具体公共 API 与命名、层内子目录、模块边界检查工具、质量工具和构建发布契约仍需后续确认或实施。
  - 本次不安装依赖，不创建配置、目录、工程骨架或源码，不修改服务器、DNS、证书或云资源，也未提交、推送、创建或合并 PR。
  - 本次未新增站点运行时第三方服务、浏览器外部请求或用户数据处理。

## 2026-07-18 — 确认 Docusaurus 模块与目录契约

- **主题**：用户确认采用 Docusaurus 标准入口目录与显式模块边界，使 CODE-002 的逻辑分层能够落实为物理结构，同时避免自定义别名和宽泛 barrel 扩大配置与循环依赖风险。
- **完成内容**：
  - 记录 D-075：仓库根保留未来 `docusaurus.config.ts` 与 `sidebars.ts`；领域核心、构建适配、可复用组件、文件路由页面和主题覆盖分别映射到 `src/domain/`、`src/build/`、`src/components/`、`src/pages/` 与 `src/theme/`；未来作者工具使用 `scripts/author/`，现有质量脚本保持在 `scripts/quality/`。
  - 明确 `src/build/` 是构建期源码目录而非静态产物目录，`site-content/` 不进入源码模块树；不新增职责含混的通用共享层，发布自动化与静态产物目录继续由构建发布契约决定。
  - 固定跨层依赖只能经过按真实需要建立的显式公共入口；不预建空 `index.ts`，公共入口逐项导出值与类型，禁止跨层深层导入及递归或宽泛 `export *`，同一模块内部使用相对导入。
  - 固定默认导出只用于 Docusaurus 实际加载的配置、侧栏、文件路由页面、主题覆盖和独立本地插件构造器；内部复用模块采用具名导出。首版不增加自定义业务路径别名，Docusaurus 官方别名只能按框架语义使用，不能绕过公共入口。
  - 将 D-075 传播到主站目标架构、架构概览、M0 Spec、编码 Spec、内容发布流程、运行手册与文档入口；明确 `src/components/` 只是通用展示组件根，不自动构成 MDX 白名单。
- **验证结果**：
  - 核对 Docusaurus `3.10.2` 官方配置、侧栏、页面、插件、TypeScript、客户端架构与版本化文档，区分框架入口的加载契约和本站内部模块风格。
  - `npm run quality` 通过：现有质量脚本语法、Markdown 索引与内链、契约词、Secret 启发式扫描和迁移前静态入口检查全部成功；该结果不表示 D-075 的未来模块边界检查已经实现。
  - `git diff --check` 通过；定向扫描未发现活动文档仍把模块目录、跨层公共入口、导出和首版自定义别名策略整体写成未决。
  - 仓库仍不存在目标 `src/`、`scripts/author/`、Docusaurus 配置或空公共入口；本次未修改 PlantUML 源码，因此未运行图表编译或生成 SVG。
- **遗留项**：
  - TypeScript 与类型包具体版本、`tsconfig` 继承和 module/moduleResolution、具体公共函数与类型、文件/组件/hook 命名、层内子目录、MDX 白名单、主题 Swizzle、边界检查工具与 CI 接线仍需后续确认或实施。
  - 本次只更新设计，不安装依赖，不创建目标目录、配置、lockfile、工程骨架或源码，不修改服务器、DNS、证书或云资源，也未提交、推送、创建或合并 PR。
  - 本次未新增第三方服务、浏览器外部请求或用户数据处理。

## 2026-07-17 — 确认 Docusaurus 严格 TypeScript 源码边界

- **主题**：用户选择方案 A，将 Docusaurus 管理的目标源码固定为严格 TypeScript，并把类型检查与静态构建设为两个独立必需门禁。
- **完成内容**：
  - 记录 D-074：站点配置、侧栏、生成器、本地插件、构建期适配和无 JSX 站点模块使用 `.ts`，包含 JSX 的页面、主题覆盖和 React 组件使用 `.tsx`；目标 `tsconfig.json` 显式启用 `strict: true`，该范围不新增 `.js` 或 `.jsx`，例外必须重新取得用户确认。
  - 固定 `tsc --noEmit` 与 Docusaurus build 的职责分离：两项都必须失败关闭通过，build 成功不能证明类型检查完成，类型检查成功也不能证明框架加载和静态制品正确。
  - 明确 `docusaurus.config.ts`、`sidebars.ts` 及其 Node.js 侧模块不导入浏览器 API、React 或 JSX；现有 `scripts/quality/*.mjs` 不强制迁移，未来作者 CLI 的语言与接口继续独立决策。
  - 将 D-074 传播到主站目标架构、架构概览、M0 Spec、编码 Spec、内容发布流程、运行手册与文档入口；保留旧进度和历史决策形成时的原始状态，不倒改历史。
  - 明确 TypeScript、Docusaurus/React/Node 类型声明和相关配置包的具体选择与版本尚未获批，`tsconfig` 其余选项、模块公共 API、目录、命名、导出、路径别名、npm script 和 CI job 编排仍受后续决策或依赖准入约束。
- **验证结果**：
  - 核对 Docusaurus `3.10.2` 官方 TypeScript、配置与侧栏文档，确认框架支持 TypeScript 主题组件和 `docusaurus.config.ts`，项目 `tsconfig.json` 不由 Docusaurus build 用于类型检查，侧栏文件在 Node.js 中执行且不能使用浏览器 API、React 或 JSX。
  - `npm run quality` 通过：现有质量脚本语法、Markdown 索引与内链、契约词、Secret 启发式扫描和迁移前静态入口检查全部成功；该结果不包含尚未接入的目标 `tsc --noEmit` 或 Docusaurus build。
  - `git diff --check` 通过；定向扫描确认活动文档不再把 JavaScript/TypeScript 选择或严格度写成未决，也没有把现有 `npm run quality` 误报为目标双门禁。
  - 本次未修改 PlantUML 源码，因此未重复运行图表编译或生成 SVG。
- **遗留项**：
  - 下一项继续确认模块公共 API、目录、命名、导出与路径别名；TypeScript 与类型包具体版本、其余 `tsconfig` 选项、质量工具、CI 接线和构建发布契约仍未完成。
  - 本次只更新设计，不安装依赖，不创建 TypeScript/Docusaurus 配置、lockfile、工程骨架或目标源码，不修改服务器、DNS、证书或云资源，也未提交、推送、创建或合并 PR。
  - 本次未新增第三方服务、浏览器外部请求或用户数据处理。

## 2026-07-17 — 确认 Docusaurus 前瞻稳定依赖基线

- **主题**：用户选择方案 A，固定主站首个 Docusaurus 版本、官方 preset/Faster 拓扑、v4 兼容行为、npm 与冻结安装边界。
- **完成内容**：
  - 记录 D-073：首版精确使用 Docusaurus `3.10.2`，`@docusaurus/core`、`@docusaurus/preset-classic` 与 `@docusaurus/faster` 保持同版，启用 `future.v4: true`；classic preset 显式关闭 blog，不配置搜索、统计或其他浏览器外部请求。
  - 包管理器固定为 Node 随附 npm，仓库未来只提交一个 `package-lock.json`；主基线只有受审依赖变更可以更新清单和 lockfile，其余正常验证、CI 与构建运行 `npm ci`。最低 Node 端点只读同一 lockfile、不发布制品，首次迁移必须失败关闭验证两个 npm 端点的兼容性。
  - 将 D-073 传播到主站目标架构、架构概览、M0 Spec、运行手册、编码 Spec 与文档入口；保留 D-051 至 D-067 形成时的历史未授权范围，不回写旧进度记录。
  - 明确本决定只批准三个 Docusaurus 官方包和安装方向；React、React DOM、MDX 等其余直接依赖版本、传递依赖准入、SBOM/第三方声明工具、构建制品检查和实际迁移仍受后续门禁约束。
- **验证结果**：
  - `npm run quality` 通过：现有质量脚本语法、Markdown 索引与内链、契约词、Secret 启发式扫描和迁移前静态入口检查全部成功。
  - `git diff --check` 通过；定向扫描确认活动摘要不再把 Docusaurus 精确版本、preset、npm、唯一 lockfile 或冻结安装方向写成未决事项，历史决策与旧进度记录保持不变。
  - 本次未修改 PlantUML 源码，因此未重复运行图表编译或生成 SVG。
- **遗留项**：
  - 继续确认工程语言与模块约束、其余直接和传递依赖准入、质量工具、主题组件、内容契约、Node 24/Ubuntu CI 迁移及构建发布契约；完成前不安装 Docusaurus、不创建 lockfile 或工程骨架。
  - 本次未新增第三方服务、浏览器外部请求或用户数据处理，也未修改服务器、DNS、证书或云资源，未提交、推送、创建或合并 PR。

## 2026-07-17 — 将上层设计下沉为主站编码规范 Spec

- **主题**：建立从已确认上层设计进入实现、测试与评审的编码规范入口，同时避免复制真相源造成一致性漂移。
- **完成内容**：
  - 新增 `docs/engineering/main-site-coding-spec.md`，用 D-xxx 映射表说明静态架构、内容、页面、运行时、供应链和发布设计分别落到哪类代码与验证层；领域行为仍直接引用原决策，不在 Spec 复制字段表、页面数值或发布步骤。
  - 固化编码规范自身拥有的真相源依赖、逻辑分层、确定性与副作用、结构化输入、ESM/Node 边界、静态渲染、React 组件、样式资源、文件注释、依赖安全、测试分层和质量评审规则。
  - 记录当前工具的真实覆盖范围：现有语法检查不是全仓 lint，Secret 扫描与静态入口检查范围有限，PlantUML 编译不证明 SVG 同步，PowerShell 的 EditorConfig 与 Git 属性仍有差异；不把迁移前能力包装为目标门禁。
  - 明确 Docusaurus 工程语言、依赖与 lockfile、lint/formatter/test、React/CSS/主题、完整 schema、命令接口、Node 24 CI 和构建发布契约仍属实施阻塞，Spec 不以默认方案替代用户决策。
  - 在 README、文档索引、主站目标架构、贡献入口和前端操作规则建立下游引用；纠正通用 Markdown 规则对图表技术的越权默认，使图表选择继续服从已确认的 PlantUML 构建边界。
- **验证结果**：
  - `npm run quality` 通过：现有质量脚本语法、Markdown 索引与内链、契约词、Secret 启发式扫描和迁移前静态入口检查全部成功。
  - `git diff --check` 通过；定向扫描未发现禁用契约词、一次性“本轮”禁令或把 D-052 已确认误写为具体依赖自动准入。
  - 对照上层设计和当前脚本范围完成只读复核，删除了会形成第二真相源的字段、页面和发布规则副本，并修正领域核心依赖方向与当前门禁覆盖表述。
  - 本次未修改 PlantUML 源码，因此未重复运行图表编译或生成 SVG。
- **遗留项**：
  - 后续仍按 `open-decisions.md` 逐项完成实施阻塞事项；本次未安装依赖，未修改运行时、站点代码、服务器、DNS、证书或云资源。
  - 本次未新增第三方服务、浏览器外部请求或用户数据处理，也未提交、推送、创建或合并 PR。

## 2026-07-17 — 清理失效的非 Linux 作者执行路线

- **主题**：清除已撤销的平台与本地版本工具方案，统一现行架构、操作规则和 CI 的执行边界。
- **完成内容**：
  - 将 `open-decisions.md` 中 D-068 至 D-071 的失效长篇方案压缩为一条撤销记录，并从活动待办中删除其安装、供应链、平台验收和周期维护事项；完整过程继续由本文件与 Git 历史留存。
  - 统一 README、贡献指南、Agent 操作规则、架构、产品 Spec、内容发布和运维文档：本站作者 Node.js 命令、质量检查与 Docusaurus 构建只在 Linux 执行环境运行，GitHub Actions 只使用 Ubuntu。
  - 删除 CI 的多平台矩阵，`website-quality` 直接运行在 `ubuntu-latest`；Node 24 迁移、Action commit SHA 固定和构建发布契约仍按既有门禁后续实施。
  - 删除活动开发工作流中已失效且使用浮动依赖的备用浏览器命令；保留 D-072 已确认的编辑、Git、浏览器审查与远程触发脚本，这些客户端能力不构成第二套构建或发布环境。
- **验证结果**：
  - `npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功。
  - `git diff --check` 通过；定向扫描确认活动架构与待决策清单不再包含已撤销的执行路线或本地版本工具待办。
- **遗留项**：
  - 推送前需核验 GitHub 分支保护是否引用了旧矩阵生成的 required check 名称；本轮未操作 GitHub、服务器、DNS、证书或云资源。
  - 本次未新增第三方服务、浏览器外部请求或用户数据处理，也未提交、推送、创建或合并 PR。

## 2026-07-17 — 纠正 Windows 职责范围并废止 D-068 至 D-071

- **主题**：收敛 Windows 协同边界，避免把普通 Git 协同扩展成额外架构。
- **完成内容**：
  - 记录 D-072：Windows 可以编辑、审查、普通 Git 提交/推送/同步、浏览器验收和远程触发，但不运行本站 Node.js、文章命令、质量检查或 Docusaurus 构建；Linux 执行作者命令，Ubuntu CI 在合入与发布前统一验证。
  - 将 D-068 标记为因错误扩大 Windows 职责而失效；依赖该前提的 D-069、D-070 与 D-071 同步失效，不再形成 mise、Windows Node 版本管理器、Windows CPU 资产或相关维护义务。
  - 保留 D-066 的 Node 24 LTS 与原生 UUIDv7 后端，以及 D-067 在 Linux 作者环境和 Ubuntu CI/构建 job 中的精确基线、兼容边界、最低端点验证与升级治理。
  - 删除人为新增的 Windows CI 与提交门禁待决项；明确 Linux 本地 Node.js hook 只提供快捷反馈，Windows 不复刻该 hook，现有 `windows-latest` 是随目标 Ubuntu CI 迁移移除的遗留 job。
- **验证结果**：
  - `git diff --check` 通过。
  - 在当前 Linux Node `v22.22.0` 迁移前环境中，`npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功。
  - 定向扫描确认活动文档不再把 D-068 至 D-071、Windows 本地 Node 或 mise 写成现行方案，也没有本轮误加的 OD-015/OD-016、Windows 提交门禁待决项、SSH 补丁协议、候选提交状态机或 GitHub Pro 依赖；剩余 Windows CI 命中只存在于醒目标记为失效的历史，或明确限定为待移除的迁移事实。
  - 查明 `.githooks/pre-commit` 当前会运行 `npm run quality`；将它限定为 Linux 本地快捷反馈，没有修改 hook、Windows 脚本或 Git 配置。
- **遗留项**：
  - Node 24 与 Ubuntu CI 迁移、文章创建命令、Docusaurus 精确版本、依赖与构建发布契约仍按原有门禁继续待决或待实施。
  - 本次不安装软件，不修改 CI、脚本、hook、依赖或版本文件，不操作服务器、DNS、证书或云资源，也不提交、推送、创建或合并 PR。

## 2026-07-17 — 确认 mise 官方 Release 精确直下与强完整性门禁（历史记录，已由 D-072 失效）

- **主题**：用户选择方案 A，确认 Windows 作者环境中的 mise 只从官方 immutable GitHub Release 按精确 tag 直接获取，并在安装授权前执行失败即阻断的强发布完整性验证。
- **完成内容**：
  - 记录 D-071：mise 的唯一获准获取渠道是 `jdx/mise` 官方 GitHub 仓库的 immutable Release，并绑定另行批准的精确 tag 和明确资产 URL；禁止 `/releases/latest` 下载选择器、`mise.run`、主分支浮动文件、镜像、Scoop、WinGet、Chocolatey、npm、Cargo、`mise self-update` 及失败后的静默换源。该限制只适用于 mise，不预先决定其他工具的获取渠道。
  - 明确 Windows CPU 架构属于安装前从目标实机查证的环境事实，不是网站设计选择；不得从 Ubuntu、CI 或“64 位”描述猜测 x64/ARM64，具体检测方式仍待后续确认，架构与获批资产不能准确匹配时必须停止。
  - 固定三层安装前门禁：确认精确 tag 属于官方 immutable Release；用后续获准的验证器与独立核验的信任材料验证上游签名 checksum manifest，并使本地 SHA-256 与目标资产摘要完全一致；再验证 GitHub Release attestation 将同一仓库、tag、资产和摘要绑定到该发布。缺失、不一致、不可验证或发生身份漂移时保持原环境，不降级验证或回退其他渠道。
  - 明确 release integrity 不等于源码到二进制的 SLSA build provenance，公开成功 workflow 只能作辅助证据；截至 2026-07-17，在已核查的 `v2026.7.7` 官方 Release 资产与发布资料中未发现独立的制品级 SBOM、SLSA build provenance 或 Windows Authenticode 签名证据，且尚未在目标机检查实际 PE 文件。这些证据缺口和逐版本许可、传递依赖仍须另行准入。
  - 保持 D-070 边界：`v2026.7.7` 仍只是当前候选，不是已安装、获批或永久版本。实际获取前先展示检查时间、精确 tag、官方 Release、明确资产 URL 与实机架构并取得该次获取授权；获取后完成三层验证，再在安装前展示实测校验结果、证据缺口和具体候选准入结论并取得安装授权。
- **验证结果**：
  - 在当前 Node `v22.22.0` 迁移前环境中，`npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功；该结果只验证 D-071 文档一致性，不表示 mise、验证器、PowerShell 7、Node 24 或真实 Windows 路径已经安装或实测。
  - `git diff --check` 通过；活动文档已把“mise 获取渠道与验证强度未决”收窄为“官方 immutable GitHub Release 精确直下与三层门禁已确认，最终版本、实机架构、资产、验证器、信任引导、具体候选的许可/依赖/制品准入结论与证据缺口风险接受，以及安装集成仍待决”，D-069、D-070 决策原文及历史进度保持不变。
  - 仓库扫描确认仍不存在 `.nvmrc`、mise 项目配置或 lockfile、`.tool-versions`、`.node-version` 和 npm lockfile；`package.json`、workflow、脚本、hook、`AGENTS.md` 与 `codex-rules/` 没有因 D-071 发生改动。
- **遗留项**：
  - mise 最终精确版本、EXE/ZIP 资产形态、目标 Windows 实机架构、GPG/Minisign/GitHub CLI 或其他验证器及其版本与来源、完整公钥或 GitHub 信任引导、证据保存、逐版本许可/传递依赖/制品准入和证据缺口风险接受仍待决策与现场查证。
  - 用户级或系统级安装、权限、目录、PATH/shim/Profile、PowerShell 激活与切换、Node 获取与 GPG 信任、网络失败、回退、卸载和人工恢复仍待后续决策；D-071 不提供或批准任何下载、验签、安装、升级或回退命令。
  - 本次不下载或安装 mise、Node、GPG、Minisign、GitHub CLI 或其他软件，不修改用户环境，不创建 `.nvmrc`，不修改代码、依赖、配置、workflow、hook、脚本或公开站点内容，也不提交、推送、创建或合并 PR。
  - 本次不引入站点运行时第三方服务、浏览器外部请求或用户数据处理；未来维护者访问 GitHub Release 只属于作者工具获取路径。

## 2026-07-17 — 确认 mise 受控精确版本滚动治理（历史记录，已由 D-072 失效）

- **主题**：用户在“受控精确版本滚动并接受短暂支持缺口”“发现新版即停用至验证完成”和“自动跟随 latest”之间选择方案 A，确认 mise 自身禁止自动漂移，并通过人工检查、观察和逐版本验证晋级。
- **完成内容**：
  - 记录 D-070：mise 工具版本与 `.nvmrc` 中的 Node 精确版本保持独立；禁止以 `latest` 选择 mise、禁止自动升级，也不允许包管理器常规更新未经审核地改变作者工具。仓库继续不增加 mise 版本文件、项目配置、lockfile 或第二 Node 版本源。
  - 固定维护频率：至少每周一次、并在每次主站正式发布前人工检查 mise 官方 Releases 与安全公告；该义务不批准后台任务、CI job、计划服务或自动网络检查，也不重新启用 D-069 已要求关闭的 mise versions host。
  - 将正式发布前的人工检查写入内容发布与生产发布编号流程；发现新版或安全事项时记录并发起审查，但是否因具体风险阻塞当次站点发布仍须按事实另行确认，不能补成自动发布门禁。
  - 固定普通候选门禁：从官方发布时间起至少观察 24 小时，审查 release notes、breaking changes、安全公告与逐版本准入证据，再在真实 Windows 和 PowerShell 7 上验证准确版本、`mise doctor`、新会话、`.nvmrc` 精确 Node、无项目配置写入以及适用的质量和静态构建；失败时拒绝候选并保持原状态。
  - 固定安全事件入口：Critical/High 且命中 Windows、信任或校验机制、Node backend 或本站实际路径时立即人工审查，但不自动升级、不自动跳过制品完整性和平台/构建验证；是否缩短 24 小时观察期仍须针对该次候选确认。
  - 明确接受 mise 官方只支持 latest 所产生的取舍：上游发布新版至人工批准完成之间，届时已安装的精确版本可能短暂不受支持，不得表述为始终运行受支持版本。
  - 将 `v2026.7.7` 记录为截至 2026-07-17 核查到的安装候选，而非已安装、永久固定或长期支持版本；真正安装前若 latest 已变化，必须暂停并重新确认准确候选，不能静默使用旧候选或新版。
- **验证结果**：
  - 在当前 Node `v22.22.0` 迁移前环境中，`npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功；该结果只验证 D-070 文档一致性，不表示 mise、PowerShell 7、Node 24、GPG 或 Windows 作者链路已经实测。
  - `git diff --check` 通过；活动文档已把“mise 升级策略未决”收窄为“受控滚动已确认、最终安装版本与供应链仍待决”，D-067、D-068、D-069 决策原文及对应历史进度保持不变。
  - 仓库扫描确认仍不存在 `.nvmrc`、mise 项目配置或 lockfile、`.tool-versions`、`.node-version` 和 npm lockfile；`package.json`、workflow、脚本、hook、`AGENTS.md` 与 `codex-rules/` 没有因 D-070 发生改动。
- **遗留项**：
  - mise 的最终安装精确版本、逐版本许可/依赖/制品准入、GitHub Release/Scoop/WinGet 获取渠道、摘要/签名/attestation 验证、Windows CPU 架构与现场状态、安装范围与权限、PATH/shim/Profile、具体切换命令、Node/GPG 信任材料、回退、卸载和失败处置仍需后续决策与实测。
  - `v2026.7.7` 只是当前候选；任何实际安装或版本切换前都必须重新核对 latest，并向用户说明准确目标、证据和影响后取得确认。
  - 本次不安装 mise、Node 或 GPG，不修改用户设置、PATH 或 Profile，不创建 `.nvmrc`，不修改代码、依赖、配置、workflow、hook、脚本或公开站点内容，也不提交、推送、创建或合并 PR。
  - 本次不引入站点运行时第三方服务、浏览器外部请求或用户数据处理；维护者人工访问 mise 官方发布与安全公告只属于未来作者工具维护路径。

## 2026-07-17 — 确认 Windows 作者 mise 受限路线（历史记录，已由 D-072 失效）

- **主题**：用户在“受限使用 mise”和“使用 fnm”之间选择方案 A，确认原生 Windows 作者环境只用 mise 消费仓库根 `.nvmrc`，不采用 mise 的项目配置、任务、环境管理或多工具版本治理。
- **完成内容**：
  - 记录 D-069：mise 只作为 Windows 本地 Node 执行适配器；Ubuntu 作者仍使用 nvm，Windows CI 仍使用 `actions/setup-node`，生产服务器和浏览器制品不引入 mise。
  - 保持 D-067 的单一版本源：未来只在作者用户级启用 Node idiomatic version file 识别，该开关不得保存版本或提交到仓库；仓库不得创建、使用或提交 mise 项目配置、lockfile、任务、环境配置、`.tool-versions`、`.node-version` 或其他第二版本源，也不得运行会写入项目配置的 mise 命令。
  - 明确 D-067 未采用的是“mise 统一全仓版本治理”，D-069 只批准 Windows 本地 `.nvmrc` 适配，两项决定不冲突。
  - 按 D-052 将 MIT 许可的 mise 登记为仅作者机使用、不进入仓库依赖或发布物的开发工具；未来 Windows 用户级设置必须关闭 mise versions host 及随附统计路径，但该约束不等于离线运行或批准其他下载源。
  - 将真实原生 Windows + PowerShell 7 验收和 Node GPG 验证行为核验列为启用前门禁；本轮不授权关闭或弱化验证、静默换源或回退到系统 Node，GPG 缺失或校验失败后的处置仍待后续决策。
- **验证结果**：
  - 在当前 Node `v22.22.0` 迁移前环境中，`npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功；该结果只验证 D-069 文档一致性，不表示 mise、PowerShell 7、Node 24、GPG 或 Windows 作者链路已经实测。
  - `git diff --check` 通过；活动文档已把“Windows 管理器待选择”收窄为“受限 mise 路线已确认、精确版本与安装验收仍待决策”，D-067、D-068 决策原文及对应历史进度保持不变。
  - 仓库扫描确认仍不存在 `.nvmrc`、mise 项目配置或 lockfile、`.tool-versions`、`.node-version` 和 npm lockfile；`package.json`、workflow、脚本与 hook 没有因 D-069 发生改动。
- **遗留项**：
  - Windows CPU 架构、PowerShell 7、现有 Node 与版本管理器、PATH、Profile、GPG、包管理器和权限状态仍需现场核验。
  - mise 的精确版本、逐版本许可与依赖复核、官方获取渠道、mise 制品摘要/签名/attestation 校验、安装范围与管理员权限、PATH/shim/Profile 集成、手动或自动切换、具体命令、Node 来源与 GPG 信任材料、升级、回滚、卸载和失败语义仍需后续决策。
  - 本次不安装 mise、Node 或 GPG，不修改用户设置、PATH 或 Profile，不创建 `.nvmrc`，不修改代码、依赖、`package.json`、workflow、hook、脚本或公开站点内容，也不提交、推送、创建或合并 PR。
  - 本次不引入站点运行时第三方服务、浏览器外部请求或用户数据处理；关闭 mise versions host 只约束未来作者工具的本地网络路径。

## 2026-07-17 — 确认原生 Windows 作者执行环境（历史记录，已由 D-072 失效）

- **主题**：用户在“保留原生 Windows 作者环境”“迁入 WSL2 + nvm”和“取消 Windows 作者执行能力”之间选择方案 A，确认继续使用 Windows 本机 Git 工作区和 PowerShell 承担作者命令、质量检查与未来静态构建。
- **完成内容**：
  - 记录 D-068：Windows 继续作为受支持的原生作者执行环境，不迁入 WSL2，也不降为只负责浏览器审查、同步或远程触发的终端；现有原生 Windows、PowerShell 与本机 Git 协同边界保持有效。
  - 确认未来选定的原生 Windows Node 版本工具必须直接消费仓库根 `.nvmrc`，正常作者入口只运行该精确基线并先断言实际 Node 完全一致；不得增加 `.node-version`、工具专属已提交版本文件、重复当前 patch、浮动版本或从 `engines.node` 推导的第二真相源。
  - 明确 D-067 中的 nvm 只适用于 Ubuntu 作者环境，不自动扩展为或批准名称相近的 Windows 工具；Windows CI 继续由 `actions/setup-node` 管理，兼容下限仍只由 CI 验证，不能用本地 Windows 管理器代替。
  - 保持生产静态边界：D-068 不改变 Nginx 静态服务、构建位置、跨机预览、Git 分支流程、服务器、DNS、证书或云资源。
- **验证结果**：
  - 在当前 Node `v22.22.0` 迁移前环境中，`npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功；该结果只验证 D-068 文档一致性，不表示原生 Windows 管理器、Node 24 或 Docusaurus 构建已经实测。
  - `git diff --check` 通过；活动文档不再把整个 Windows 作者环境列为未决，旧表述只保留在 D-067 决策原文和对应历史进度中。
  - 文档将原先笼统的“Windows 作者环境未决”收窄为“原生 Windows 执行边界已确认，具体版本管理器及供应链契约未决”，并保留 D-067 决策原文和旧进度记录作为历史状态。
  - 当前仓库仍不存在 `.nvmrc`、`site-content/`、lockfile 或 Windows 版本管理器配置；`package.json >=22` 与 CI Node 22 继续是尚未迁移的实现事实。
- **遗留项**：
  - 原生 Windows 版本管理器的选择、精确版本、许可证义务、官方来源、完整性校验、安装范围与管理员权限、PATH 与 PowerShell 集成、手动或自动切换、升级、卸载和失败语义仍需下一项决策。
  - Ubuntu nvm 的精确版本、安装来源与完整性校验，`actions/setup-node` 的版本与 commit SHA，两个封闭入口、共享负载、缓存、required check、job 拓扑、错误格式和实际 Node 24 迁移仍需后续确认。
  - 本次不安装软件、不修改 shell 或 PATH、不创建 `.nvmrc`，不修改代码、依赖、`package.json`、workflow、hook、脚本或内容，也不提交、推送或创建 PR。
  - 本次不引入站点运行时第三方服务、浏览器外部请求或用户数据处理。

## 2026-07-17 — 确认 Node 24 精确版本源与升级治理（Windows 条款已由 D-072 失效）

- **主题**：用户在“.nvmrc 精确固定并受控升级”“mise 统一工具版本”和“跟随 Node 24 最新 patch”之间选择方案 A，确认以仓库版本文件消除作者与 CI 的 Node patch 漂移。
- **状态说明**：本条形成时记录的 Windows CI、双平台任务和 Windows 作者工具内容已由 D-072 失效；当前目标只保留 Linux 作者环境与 Ubuntu CI 部分。
- **完成内容**：
  - 记录 D-067：仓库根 `.nvmrc` 是正常作者、质量和构建的唯一精确 Node 执行版本源，初始值为 `24.18.0`；`package.json#engines.node` 独立保存 D-066 的 `>=24.16.0 <25` 兼容边界，不承担精确版本选择。
  - 确认 Ubuntu 作者环境由 nvm 读取 `.nvmrc`，Ubuntu/Windows 主质量 job、Ubuntu PlantUML job 和未来正式 Docusaurus 构建由 `actions/setup-node` 的 `node-version-file` 读取同一值；正常入口先断言实际 Node 等于 `.nvmrc`，不得在 workflow、脚本或活动文档复制当前 patch，也不得使用 `24`、`lts/*`、`latest` 或 `check-latest` 自动漂移。
  - 确认 Ubuntu/Windows 最低版本入口先断言实际 Node 等于 `engines.node` 下界，再与正常入口调用同一共享质量、未来静态构建和行为测试负载；它只替换版本断言，不跳过其他检查，不生成发布制品，不触发文章创建或发布，也不得通过通用跳过开关削弱正常入口。
  - 增加版本一致性契约：`.nvmrc` 必须是兼容范围内的单个非浮动 `24.x.y`，最低版本任务必须等于 `engines` 下界；持续验证精确基线和最低端点，但不宣称逐一测试范围内每个 patch。
  - 固定升级顺序：安全 patch 被发现后及时发起独立 PR，其他 patch 至少每月检查；PR 先提出 `.nvmrc` 候选值，在候选精确基线和不变兼容下限上分别通过双平台任务，并通过 PlantUML 与届时全部发布必需门禁后才允许合并，不自动合并，也不在普通 patch PR 中修改 `engines` 边界。
  - 保持生产静态边界：D-067 不决定构建位置，不授权在生产服务器安装或运行 Node；当前 Linux `v22.22.0`、`package.json >=22` 和 CI Node 22 仍是尚未迁移的实现事实。
- **验证结果**：
  - 在当前 Node `v22.22.0` 迁移前环境中，`npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功；该结果只验证 D-067 文档一致性，不表示 Node 24、最低端点或 Docusaurus 构建已经实测。
  - `git diff --check` 通过；仓库仍不存在 `.nvmrc`、`site-content/` 和 lockfile，改动范围保持为已有 9 份设计与进度文档。
- **遗留项**：
  - Ubuntu 所用 nvm 的精确版本、安装来源与完整性校验，Windows 作者环境的安装与版本切换方式，`actions/setup-node` 的版本与 commit SHA，两个封闭入口、共享负载、缓存、required check、job 拓扑、错误格式和迁移顺序仍需确认。
  - npm 版本、`packageManager`、lockfile、Docusaurus 精确版本及依赖、构建命令、产物目录和构建位置仍需独立决策；D-067 不批准这些内容。
  - `.nvmrc`、`package.json`、CI、hook、质量规则和作者环境尚未修改，Node 24 双平台与 Docusaurus 契约尚未实测；本次不创建版本文件，不安装 nvm，不修改代码、依赖、配置或 workflow。
  - 本次不引入站点运行时第三方服务、浏览器请求或用户数据处理，不操作服务器、DNS、证书或云资源，也不提交、推送或创建 PR。

## 2026-07-17 — 确认 Node 24 LTS 与原生 UUIDv7 后端（Windows 条款已由 D-072 失效）

- **主题**：用户在“Node 24.16+ 原生 UUIDv7”和“保留 Node 22 并锁定 `uuid` 依赖”之间选择方案 A，确认全仓库目标作者与构建工具链采用 Node 24 LTS，并使用 Node.js 原生 UUIDv7 生成后端。
- **状态说明**：本条形成时记录的 Windows CI 与双平台验证内容已由 D-072 失效；当前目标只在 Linux 作者环境与 Ubuntu CI 执行相关负载。
- **完成内容**：
  - 记录 D-066：首版作者工作区、仓库质量门禁、CI 与 Docusaurus 静态构建统一使用 Node 24 LTS 主版本，最低为 24.16.0；允许范围是 `>=24.16.0 <25`，Node 25、26 或后续主版本不因版本号更高而自动获批。
  - 将 D-065 文章创建命令的生成后端固定为稳定的 `node:crypto.randomUUIDv7()`；不引入 `uuid` 或其他 UUID 生成、CLI、校验 npm 包，也不调用系统 CLI 或仓库外 UUID 服务。
  - 接受原生 API 的非单调时钟语义：同毫秒、时钟回退、跨进程或跨机器场景不保证严格递增，不增加计数器、共享状态、重试到大于前值、时间修正或其他单调包装；articleId 继续不承担业务排序或日期职责。
  - 保留当前树唯一性、Git 历史不可复用、未授权改写检测和 UUID 文本/schema 校验为独立门禁，不把“原生生成”误写为完整校验已经解决。
  - 明确 D-066 是尚未实施的目标：当前 Linux 工作区为 Node `v22.22.0`，`package.json` 仍声明 `>=22`，Ubuntu/Windows 质量 job 与 PlantUML job 仍配置 Node 22；生产继续只由 Nginx 提供静态制品，不运行 Node.js 请求服务。
- **验证结果**：
  - 在当前 Node `v22.22.0` 迁移前环境中，`npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功；该结果不表示 Node 24 迁移或 Docusaurus 契约已经验证。
  - `git diff --check` 通过，且未创建 `site-content/`。
- **遗留项**：
  - Node 24 精确 patch 固定值、版本文件与安装方式、patch 升级节奏、本机和 CI 迁移步骤仍需确认；选定 Docusaurus 精确版本后必须执行的 Ubuntu/Windows 契约测试，其具体实现与执行结果仍待完成。
  - `randomUUIDv7()` 的 `disableEntropyCache` 选项、UUID 文本规范与 schema、当前树和 Git 历史检查、旧文迁移、错误格式与测试实现仍需确认。
  - 文章创建命令名称、路径、参数、交互、模板、Markdown/MDX 选择、原子文件系统实现和完整内容 schema 仍未完成；因此本次不修改本机 Node、`package.json`、CI、Git hook、依赖或 lockfile，不创建命令、内容目录、文章、schema、配置或索引。
  - 本次不引入第三方服务、浏览器请求或用户数据处理，不操作服务器、DNS、证书或云资源，也不提交、推送或创建 PR。

## 2026-07-17 — 确认 UUIDv7 文章创建责任与入口

- **主题**：用户在“仓库内文章创建命令一并生成”“仓库内只生成 ID 后手工粘贴”和“仓库外工具生成”三种入口中选择方案 A，确认由作者显式运行仓库内 Node.js 文章创建命令，并在创建唯一正文入口时一次性写入 UUIDv7 articleId。
- **完成内容**：
  - 记录 D-065：新文章的正常创建入口是作者显式运行的仓库内 Node.js 命令；作者先确定符合 D-063 的 `<source-name>`，命令在同一次创建操作中建立尚不存在的文章目录、D-062 的唯一 `index.md` 或 `index.mdx` 正文入口，并把符合 D-064 的 UUIDv7 作为顶层 `articleId` 写入一次。
  - 固定可观察的完整创建边界：成功结果必须同时具备新目录、唯一正文入口和 articleId；失败必须恢复到调用前状态，不得留下目标文章目录、正文入口或本次创建产生的其他持久化结果。普通创建入口不得覆盖既有目录，也不得为既有文章覆盖、修复、轮换或补写 articleId；旧文分配继续走独立迁移。
  - 明确创建命令不得从 articleId、标题、slug、`classification`、日期、正文或其他字段相互推导、同步改写或静默纠正领域值；命令只写作者工作区供其审查 Git diff，不自动暂存、提交、推送或发布。
  - 将 Git hook、PR bot、CI、Docusaurus、预览、发布自动化和生产服务器限定为只读校验与已批准的构建期派生；缺失、非法、重复或被改写的 articleId 只能使门禁失败，不能触发生成或修复。
  - 保持 D-047 发布日期操作为独立作者职责；文章创建命令不自动调用发布命令，不从 UUID 时间填写 `publishedAt` 或 `updatedAt`，也不自动发布文章。
- **验证结果**：
  - `npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功。
  - `git diff --check` 通过，且未创建 `site-content/`。
- **遗留项**：
  - 创建命令的名称、路径、参数、交互方式、Markdown/MDX 入口选择、文章模板、其他字段输入、文件系统原子实现、错误格式和契约测试仍需确认。
  - UUIDv7 的生成后端、Node.js 版本、npm 依赖与 lockfile、文本规范、同毫秒单调、时钟回退、当前树及 Git 历史查重、历史不可复用检查和旧文迁移仍需确认。
  - 完整 schema、路径规范化与误放检测、保留名与旧名称复用、派生索引、侧栏生成器、文章素材布局和 Docusaurus 构建发布契约仍未完成；因此本次不创建命令、内容目录、文章、schema、配置或索引，不修改依赖、Git hook 或 CI workflow。
  - 本次不引入第三方服务、浏览器请求或用户数据处理，不操作服务器、DNS、证书或云资源，也不提交、推送或创建 PR。

## 2026-07-17 — 确认技术文章稳定身份与内部引用契约

- **主题**：用户确认独立稳定文章身份与 Docusaurus 原生内部引用方案，将 articleId 格式改为 UUIDv7，并确认 UUID 时间只作技术索引、显式日期通过文章源记录绑定并在未来构建期派生索引。
- **完成内容**：
  - 记录 D-064：每篇技术文章从创建起在唯一正文入口顶层保存必填、全站唯一、终身不可修改或复用的 UUIDv7 `articleId`；它不进入 URL，也不生成、覆盖或校验源码目录、完整 slug、canonical、`classification`、Docusaurus doc ID 或侧栏。
  - 将 UUIDv7 时间字段限定为生成器分配 ID 时采用的 Unix 毫秒时间源值，以及 UUID 值的技术排序与未来存储索引用途；它不保证真实业务事件顺序，不新增 `createdAt`，也不解码 UUID 用作文章创建、发布、更新、公开排序、SEO、归档或日期搜索。`publishedAt` 与 `updatedAt` 继续是公开日期唯一真相源。
  - 确认唯一正文入口是 articleId、当前 slug、发布状态、显式日期和正文的唯一可编辑绑定；未来查找索引只能在构建期从已校验文章只读派生，不回写、不手工编辑，也不提交第二份映射。本次不批准索引格式、搜索 UI、插件、外部搜索服务或查询数据采集。
  - 确认首版不填写 Docusaurus 原生 frontmatter `id`；默认 doc ID 只在当前构建内部使用，禁止手工拼接或提交可编辑映射，也不得作为跨构建、跨发布或领域服务的持久身份；Docusaurus 当前临时目录和静态构建制品中的框架内序列化不构成本站真相源。文章正文之间使用带目标实际 `.md` 或 `.mdx` 扩展名的源码相对文件链接。
  - 确认技术分享侧栏由官方 `sidebarItemsGenerator` 在构建期复用文章成员结果，按源 `publicationStatus` 排除生产 draft，再读取已校验的 `classification` 和插件提供的当前 `docs[].id` 生成 `type: 'doc'` 项；不按物理目录、articleId 或 slug 分类，也不提交第二份成员清单。
- **验证结果**：
  - `npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功。
  - `git diff --check` 通过，且未创建 `site-content/`。
- **遗留项**：
  - UUIDv7 的生成命令与实现、文本规范、同毫秒单调与时钟异常处理、历史不可复用检查、旧文迁移和精确错误契约仍需确认。
  - 派生索引的格式、位置、draft 边界、消费者、缓存和公开范围，以及侧栏键名、显示注册表、通用分组名称、排序、折叠、分页、生成器 API 与测试仍需确认。
  - 完整 schema、路径检测、文章素材布局、项目内容来源、Docusaurus 版本与构建发布契约仍未确认；站内搜索、评论、账户、API、数据库与用户数据处理仍未实施或批准。
  - 本次不创建 `site-content/`、文章、索引、schema、配置或代码，不修改依赖或质量脚本，不操作服务器、DNS、证书或云资源，也不提交、推送或创建 PR。

## 2026-07-16 — 确认技术文章语义源码名契约

- **主题**：用户在稳定可读的语义源码名与生成式永久 ID 两种方案中确认方案 A。
- **完成内容**：
  - 记录 D-063：`<source-name>` 由作者手工确定，长度为 1-64 个 ASCII 字符，完整匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`，并在当前 `site-content/writing/` 文章直接子目录命名空间内全局唯一。
  - 明确源码名只为 Git、PR 和编辑器中的人工辨识服务，不是文章领域身份；不得从标题、slug、`classification`、日期或正文自动生成或同步，也不生成、覆盖或校验公开 URL、canonical、分类、侧栏或排序。它可以恰好与 slug 尾段相同，但不建立等值契约。
  - 确认发布前受控改名必须原子移动目录、更新全部路径和 doc ID 消费者并通过构建及断链检查；首次发布后禁止日常改名，只有拼写错误或持续造成严重歧义时才能在用户明确授权后作为独立迁移处理，并保持公开 slug 与 canonical 不变。
  - 记录 Docusaurus 默认 doc ID 仍随父目录路径变化，D-058 的根相对完整 `slug` 保持公开 URL 不变；具体 doc ID、文章间链接与侧栏引用策略继续待决。
- **验证结果**：
  - `npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功。
  - `git diff --check` 通过，且未创建 `site-content/`。
- **遗留项**：
  - `<source-name>` 保留名、旧名称是否允许复用、路径规范化与真实包含算法、符号链接、文件系统大小写处理、历史状态检测和误放错误格式仍需确认。
  - doc ID、文章间链接、侧栏引用、文章素材布局、完整 schema、函数 API、错误契约、测试实现与 Docusaurus 配置仍未确认。
  - 本次不创建 `site-content/`、文章目录或正文，不修改页面、配置、依赖或质量脚本，不操作服务器、DNS、证书或云资源，也不提交、推送或创建 PR。

## 2026-07-16 — 确认技术文章每文独立源码目录

- **主题**：用户在正文平铺、每篇文章独立目录和按项目/模块建立分类目录树三种布局中确认方案 B。
- **完成内容**：
  - 记录 D-062：每篇技术文章位于 `site-content/writing/<source-name>/` 直接子目录，并且恰好使用 `index.md` 或 `index.mdx` 之一作为唯一正文入口。
  - 明确 D-060 的任意深度 Markdown/MDX 候选扫描继续保留；根级文章、非 `index` 正文、双入口和额外 Markdown/MDX 必须在未来门禁中失败，不能通过布局规则逃逸文章校验。
  - 将 `<source-name>` 限定为稳定的仓库组织名；本站不从它生成、覆盖或校验 `slug`、公开 URL、canonical、`classification`、显式 doc ID、侧栏或排序，标题和分类变化不要求移动目录；Docusaurus 默认 doc ID 仍受文件路径影响，具体稳定与引用策略继续待决。
  - 保持 frontmatter 与正文位于唯一入口文件，不引入文章元数据 sidecar，也不借本决定批准自动侧栏或文章本地 React 组件。
- **验证结果**：
  - `npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功。
  - `git diff --check` 通过。
- **遗留项**：
  - `<source-name>` 字符与生成规则、目录重命名流程、路径规范化与包含算法、误放错误格式、符号链接和大小写策略仍需确认。
  - 文章私有与共享素材布局、允许的非 Markdown 文件、PlantUML 的 MDX 支持、doc ID 稳定契约、侧栏、schema、函数 API、错误契约和测试实现仍未确认。
  - 本次不创建 `site-content/`、文章目录或正文，不修改页面、配置、依赖或质量脚本，不操作服务器、DNS、证书或云资源，也不提交、推送或创建 PR。

## 2026-07-16 — 确认 Docusaurus 物理内容根

- **主题**：用户在仓库根 `content/`、仓库根 `site-content/` 与 `src/content/` 三种公开内容根候选中确认方案 B。
- **完成内容**：
  - 记录 D-061：单一 Docusaurus docs 内容实例的仓库相对物理内容根固定为根级 `site-content/`；现有 `docs/` 继续作为内部设计真相源，迁移前 `public/` 不成为目标内容根。
  - 将 D-060 的相对文章类型边界锚定为 `site-content/writing/`；该目录根级及任意深度 Markdown/MDX 继续遵守唯一判型、schema 先行和失败关闭规则。
  - 明确物理目录不生成或覆盖文章 URL、完整 `slug`、canonical、分类、侧栏或排序，也不把 `writing/` 外内容自动解释为项目、首页或其他类型。
  - 保留 D-060“当时未选择物理路径”的历史原文，通过后续 D-061 补充当前权威状态，不改写决策形成过程。
- **验证结果**：
  - `npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功。
  - `git diff --check` 通过。
- **遗留项**：
  - `writing/` 内部组织、文件命名、路径规范化与包含算法、误放检测、符号链接和大小写策略仍需逐项确认。
  - 项目内容来源与位置、首页和列表页来源、完整 schema、函数 API、错误契约、侧栏、SEO、Docusaurus 版本与配置、构建发布契约仍未确认。
  - 本次不创建 `site-content/` 或 `writing/` 目录，不修改页面、配置、依赖或质量脚本，不操作服务器、DNS、证书或云资源，也不提交、推送或创建 PR。

## 2026-07-16 — 重新确认 writing 技术文章类型边界

- **主题**：用户在 `writing/` 子树、显式 `contentType` 字段和独立文章成员清单三种类型判据中再次确认方案 A，并要求继续保留此前重开过程的审计链。
- **完成内容**：
  - 记录 D-060：相对未来单一 Docusaurus docs 内容根，规范化后位于 `writing/` 子树内的 Markdown/MDX 是唯一技术文章成员集合；本次不选择内容根物理路径。
  - 边界内所有候选文件都必须通过技术文章 schema 后再应用 D-059 最小投影；校验失败必须中止构建，不能退回普通 doc，也不能被框架 include/exclude 或 partial 行为绕过。
  - 边界外只确定为非技术文章，不运行文章 schema 或投影，也不自动成为项目介绍、首页或其他内容类型。
  - 不增加 `contentType`、独立成员清单或其他并行判据，不使用字段存在性、`slug`/URL 前缀、侧栏成员、文件名、doc ID 或分类关系反向判型。
  - 明确 `writing/` 只决定内容类型，不生成或覆盖 D-058 的完整 `slug`、公开 URL、canonical、分类、侧栏归属或排序；D-060 与 D-059 解耦成立，schema、投影和未来消费者复用同一判型结果。
  - 保留 D-057 首次确认、D-058 重新开放和 D-059 重新确认字段适配的历史原文；D-060 作为当前类型边界权威，不静默恢复 D-057 的旧绑定关系。
- **验证结果**：
  - `npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功。
  - `git diff --check` 通过。
- **遗留项**：
  - docs 内容根物理路径、`writing/` 内部组织、路径包含与误放检测、完整 schema、函数 API、错误契约和测试实现仍需逐项确认。
  - 项目内容来源与类型判据、侧栏生成、SEO 元数据组件、Docusaurus 版本与配置、构建发布契约仍未确认。
  - 本次不修改页面、配置、依赖或质量脚本，不创建内容根、`writing/` 目录、schema 或文章文件，不操作服务器、DNS、证书或云资源，也不提交、推送或创建 PR。

## 2026-07-16 — 确认技术文章原生优先与最小字段适配

- **主题**：用户在原生优先最小适配、重开领域模型改用框架源字段、预构建规范化内容树三种方案中确认方案 A，并要求把此前重新开放的决定纳入评审。
- **完成内容**：
  - 记录 D-059：默认解析后的 `title` 与 D-058 原生完整 `slug` 直接使用，不重命名、规范化或生成副本；本站 schema 仍负责必填、格式、唯一性与跨字段约束。
  - 构建内存中的原生 `description` 始终由 `summary` 派生；`seo.description` 与 `seo.socialDescription` 不进入该字段，避免 SEO 例外改变目录或其他原生消费者使用的默认摘要。
  - 只有 `publicationStatus: draft` 派生原生 `draft: true`；`published` 与 `archived` 不映射为 `unlisted`。`authors`、`publishedAt`、`updatedAt` 与 `classification` 不映射到 blog 字段、`last_update` 或原生 `tags`。
  - 以更小职责重新确认 D-056 的官方全局 `markdown.parseFrontMatter` 执行点、默认解析器和无副作用纯投影边界；不写回源内容，也不生成临时内容树。
  - 保持 D-057 独立未决：本次不恢复历史 `writing/` 子树，也不选择 `contentType` 或成员清单。在类型判据重新确认前，不实现解析分流、投影函数或文章 schema 分派。
- **查证依据**：
  - [Docusaurus 官方 docs 插件 front matter](https://docusaurus.io/docs/api/plugins/@docusaurus/plugin-content-docs#markdown-front-matter)列出 `title`、`description`、`slug`、`tags`、`draft`、`unlisted` 与 `last_update` 等原生字段及其职责。
  - [Docusaurus 官方全局 Markdown 配置](https://docusaurus.io/docs/api/docusaurus-config#markdown)说明 `parseFrontMatter` 可以调用默认解析器后返回只供本次构建使用的 frontmatter 与正文。
  - 当前官方页面展示的版本不构成本站依赖版本授权；具体版本及其行为仍须在依赖决策后通过契约测试验证。
- **验证结果**：
  - `npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功。
  - `git diff --check` 通过。
- **遗留项**：
  - 下一项单独重新决策 D-057 的技术文章内容类型判据。
  - 完整 schema、函数 API、错误契约、页面 SEO 元数据组件、标签合并与契约测试、项目字段适配、内容根与内部目录、侧栏和主题实现仍需逐项确认；SEO 回退值语义不因此重新开放。
  - 本次不修改页面、配置、依赖或质量脚本，不创建内容目录或文章文件，不操作服务器、DNS、证书或云资源，也不提交、推送或创建 PR。

## 2026-07-16 — 改用 Docusaurus 原生完整 slug 并回退受影响决定

- **主题**：用户确认技术文章直接使用 Docusaurus 原生完整 `slug`，并要求此前受影响的自定义适配与类型分流回退后重新决策。
- **完成内容**：
  - 记录 D-058：单一 docs 实例使用 `routeBasePath: '/'`；技术文章在源 frontmatter 顶层直接填写根相对完整路径，例如 `slug: /writing/dependency-inversion`，默认解析结果原样参与路由，不再派生栏目路径。
  - 将 D-035 的文章完整字段字符语义和 D-038 的值与映射语义标记为被 D-058 部分替代；保留手工语义尾段、稳定 URL、文件路径解耦、永久重定向和项目短 slug 规则。
  - 保留 D-031 的公开路由职责、D-054 的单一 docs 实例和 D-055 的单一可编辑真相源，并补齐 D-054 原先未决的根 `routeBasePath`。
  - 将 D-056、D-057 重新开放评审并暂停实施授权；在完成 Docusaurus docs 原生 frontmatter 逐字段 fit-gap 并由用户重新选择前，不创建解析钩子、投影函数、内容类型目录、schema 分流或相关配置。
  - 区分技术文章原生完整 `slug` 与项目注册表短标识；本次不决定项目介绍继续使用 `projects.json` 还是迁移为 Markdown/MDX，也不决定项目页面如何提供原生路由字段。
- **查证依据**：
  - [Docusaurus 官方 docs 插件配置](https://docusaurus.io/docs/api/plugins/@docusaurus/plugin-content-docs)说明：`routeBasePath` 是实例级路由前缀，使用 `/` 可把 docs 路由放到站点根。
  - [Docusaurus 官方文档路由说明](https://docusaurus.io/docs/create-doc#doc-urls)：frontmatter `slug` 可显式覆盖文件路径生成的 URL，并与实例 `routeBasePath` 组合；因此本方案无需自研路由或 slug 前缀投影。
  - 当前官方文档页面显示的框架版本不构成本站版本选型；具体依赖版本仍受后续准入决策约束。
- **验证结果**：
  - `npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功。
  - `git diff --check` 通过。
- **遗留项**：
  - 下一项先横向核对 Docusaurus 原生 `title`、`description`、`tags`、`draft`、`unlisted`、`last_update` 等字段与本站领域语义，再重新决策 D-056、D-057。
  - 站点级尾斜杠、完整 slug 校验与保留路径、全站路由冲突、内容类型判据、schema 与错误契约仍需逐项确认。
  - 本次不修改页面、配置、依赖或质量脚本，不操作服务器、DNS、证书或云资源，也不提交、推送或创建 PR。

## 2026-07-16 — 确认技术文章的专用源码子树类型边界（后由 D-058 重新开放评审）

- **主题**：用户在专用源目录、显式 `contentType` 字段和独立文章成员清单三种类型识别机制中确认方案 A。
- **完成内容**：
  - 记录 D-057：相对未来单一 docs 内容根的 `writing/` 子树是唯一技术文章类型边界；全局 `markdown.parseFrontMatter` 只对该边界内的 Markdown/MDX 调用技术文章纯投影函数。
  - 明确子树内文件必须按技术文章 schema 校验，缺失或无效字段即中止构建且不得退回普通文档；未知额外字段策略继续留给后续错误契约。子树外内容保持默认解析结果且不自动成为项目内容。
  - 明确目录只识别内容类型，不生成或覆盖 URL、slug、侧栏归属或排序；文章 URL 继续只由源 `slug` 形成 `/writing/<article-slug>/`。
  - 不新增 `contentType` 字段或独立文章成员清单，不借内容类型决策提前确定项目内容来源或项目适配。
- **验证结果**：
  - `npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功。
  - `git diff --check` 通过。
- **遗留项**：
  - 下一轮决策逐字段投影与错误契约；docs 内容根的物理路径、`writing/` 内部目录结构和误放检测继续列在 `open-decisions.md` 的设计评审门禁中。
  - 项目内容来源、项目/模块/主题注册表、通用分组名称、跨项目关系、侧栏生成与排序、主题 fit-gap、具体门禁工具和构建发布契约继续按用户决策门禁逐项处理。
  - 本次不创建内容目录，不修改页面、配置、依赖或质量脚本，不操作服务器、DNS、证书或云资源，也不提交、推送或创建 PR。

## 2026-07-16 — 确认技术文章的 Docusaurus 适配执行点（后由 D-058 重新开放评审）

- **主题**：用户在官方 frontmatter 扩展点、预构建临时内容树和自定义内容插件三种机制中确认方案 A。
- **完成内容**：
  - 记录 D-056：技术文章通过 Docusaurus 官方 `markdown.parseFrontMatter` 调用仓库内纯投影函数，在构建内存中把领域 frontmatter 转换为框架元数据。
  - 固定先调用 `defaultParseFrontMatter`、正文保持不变、投影无文件写入且不生成第二棵临时内容目录的边界；当前不由自定义内容插件接管内容加载。
  - 明确本决定只选择技术文章适配的执行位置，不决定内容类型识别、逐字段映射与回退、函数模块/API、schema、错误契约、项目内容来源或项目适配方式。
  - 经 Docusaurus 官方配置文档核实，`markdown.parseFrontMatter` 接收 `filePath`、`fileContent` 与默认解析器并返回 frontmatter 和正文，能够承载已确认的构建期内存投影方向。
- **验证结果**：
  - `npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功。
  - `git diff --check` 通过。
- **遗留项**：
  - 下一轮继续确认内容类型识别、逐字段投影和错误契约；确认前不编写 Docusaurus 配置或适配代码。
  - 项目内容来源、项目/模块/主题注册表、通用分组名称、跨项目关系、侧栏生成与排序、主题 fit-gap、具体门禁工具和构建发布契约仍待逐项确认。
  - 本次不修改页面、依赖或质量脚本，不操作服务器、DNS、证书或云资源，也不提交、推送或创建 PR。

## 2026-07-16 — 确认领域字段向 Docusaurus 的单向投影方向

- **主题**：用户在领域模型为真相源、Docusaurus 原生字段为真相源和两套字段双写三种方向中确认方案 A。
- **完成内容**：
  - 记录 D-055：技术文章已确认的领域内容模型及其引用的 Git 注册表保持唯一可编辑真相源；Docusaurus 元数据只在构建期只读直传或派生，不回写源内容，也不在已提交文件中持久化语义副本。
  - 明确该方向同样约束后续经用户确认的项目领域来源，但不决定项目介绍长期使用 `projects.json` 还是 Markdown/MDX；`projects.json` 继续作为当前项目公开事实的机器可读来源。
  - 经 Docusaurus 官方文档核实，框架提供构建期 frontmatter 转换扩展能力，方案 A 在技术上可行；本决定不选择具体扩展点、生成中间内容树或逐字段映射。
  - 明确字段方向不启用原生 tags、作者页、主题页或其他未批准路由，也不授权安装 Docusaurus 或新增依赖。
- **验证结果**：
  - `npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功。
- **遗留项**：
  - 下一轮确认逐字段投影与回退、内容类型识别和适配层边界；其中必须保持既定 URL、发布状态、摘要与 SEO、日期、作者和分类语义。
  - 项目内容来源、项目/模块/主题注册表、通用分组名称、跨项目关系、侧栏生成与排序、主题 fit-gap、具体门禁工具和构建发布契约仍待逐项确认。
  - 本次不修改页面、依赖或质量脚本，不操作服务器、DNS、证书或云资源，也不提交、推送或创建 PR。

## 2026-07-15 — 确认 Docusaurus 单一 docs 内容拓扑

- **主题**：用户在单一 docs 实例、多个 docs 实例和 docs + blog 三种互斥方案中确认方案 A。
- **完成内容**：
  - 记录 D-054：项目介绍与技术文章共用单一 docs 内容实例，但分别使用项目侧栏和技术分享侧栏；首版不启用 blog，也不配置第二个 docs 内容实例。
  - 明确单一实例不合并项目与文章领域模型，不改变 `/projects/` 与 `/writing/` 的既定路由职责，也不提供独立构建、部署或故障隔离。
  - 明确首版不自动生成时间流、归档、Feed、作者页、主题页或其他未批准路由；未来出现独立版本生命周期或明确的时间流与 Feed 需求时再重新评估拓扑。
  - 关闭 OD-015，并将当前阻塞范围收敛到 Docusaurus 原生字段单向映射、注册表、内容目录与侧栏生成、主题适配、具体门禁工具和构建发布契约。
- **验证结果**：
  - `npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功。
  - `git diff --check` 通过。
- **遗留项**：
  - 下一轮先确认 Docusaurus 原生字段与本站领域字段的单向映射，禁止为框架便利建立第二份内容真相源。
  - 具体 Docusaurus/Node.js 版本、preset、实例配置、包管理器与 lockfile、内容目录、侧栏文件与生成排序、列表页生成方式、主题 fit-gap、门禁工具、构建位置、制品交付和新版主站 Spec 仍待逐项确认。
  - 本次不安装依赖、不修改页面或质量脚本，不操作服务器、DNS、证书或云资源，也不提交、推送或创建 PR。


## 2026-07-15 — CLAUDE.md 改为导入 AGENTS.md，门禁操作知识归位

- **主题**：用户提出 CLAUDE.md 直接 `@` 导入 AGENTS.md 即可。查证后确认这是 Anthropic 官方文档明确推荐的多 Agent 仓库模式，采纳。
- **完成内容**：
  - `CLAUDE.md` 由 89 行缩为 13 行：一段说明 + `@AGENTS.md` 导入 + 一个只写环境差异的“Claude Code 专属差异”节。规范正文不再有第二份，结构上杜绝漂移。
  - 新增 [`codex-rules/rules/quality-gates.md`](../codex-rules/rules/quality-gates.md)，收纳原先只存在于 CLAUDE.md 的门禁执行层知识：命令、hooks 启用、各门禁执行边界，以及词边界匹配、根目录只扫一层的理由、`gen:diagrams` 不是门禁、“写门禁文档会拦到自己”等坑点。设计层能力清单仍归 `maintenance.md`，本文件不复制。
  - `global-AGENTS.md` 路由表新增一行“运行质量门禁、修改 `scripts/quality/` 或 Markdown 图表”。
  - 修正 `apply_patch` 缺陷：AGENTS.md 要求手工编辑使用 `apply_patch`，但那是 Codex 的工具，Claude Code 没有；纯导入会让 Claude Code 收到无法执行的指令。已在 CLAUDE.md 的专属差异节声明改用 Edit / Write，未改动 AGENTS.md。
- **查证结论**（`https://code.claude.com/docs/en/memory.md`）：Claude Code 只原生读取 `CLAUDE.md`、不自动读 `AGENTS.md`，因此显式导入不会重复加载；官方对“仓库已有 AGENTS.md”的建议正是创建 CLAUDE.md 导入它；导入递归上限为 4 跳；导入在反引号和代码块内不生效，紧跟 blockquote 之后不受影响。
- **纠正上一轮的判断**：先前以“门禁细节别处没有”为由把整段机制留在 CLAUDE.md，查证后只对了一半——能力层清单早已归 `maintenance.md`，目录职责早已归 `overview.md`，真正无归属的只有执行层知识，而它本就该在 `codex-rules/`。这些知识长期只存在于 CLAUDE.md，等于 Codex 从来没拿到过；归位后两个 Agent 都能按需加载。
- **验证证据**：`npm run quality` 五项通过（exit 0）；契约扫描集 45 → 46，确认 `CLAUDE.md` 与新建的 `quality-gates.md` 都在扫描范围内。
- **遗留项**：
  - `@AGENTS.md` 的实际展开只能在新会话用 `/memory` 确认，本次无法自证；若未生效需回退为在 CLAUDE.md 保留必要正文。
  - AGENTS.md 第 30 行的 `apply_patch` 仍是 Codex 专属表述。是否把 AGENTS.md 改成工具无关写法（更彻底，但要动刚定稿的文件）留待决定。

## 2026-07-15 — 固定首版工程技术基线

- **主题**：用户确认把 Docusaurus 官方能力、现有 PlantUML、Nginx/Certbot、GitHub Actions/TAT、Ubuntu/systemd 原生运维和 CI 质量与供应链门禁固定为首版组合。
- **完成内容**：
  - 记录 D-053，固定各组件职责、静态生产边界、发布失败边界和门禁能力类别；明确“官方能力”不等于所有官方插件或可选功能自动获批。
  - 将现有 PlantUML 保持为构建期源码到静态 SVG 的图表链路，不引入浏览器端渲染或 Docusaurus 运行时图表插件。
  - 将 Nginx/Certbot、GitHub Actions 经 CAM 调用固定 TAT command、Ubuntu/systemd/logrotate 统一到目标架构和运行手册，并明确这些仍是设计基线而非已部署事实。
  - 固定依赖与构建、代码与内容、路由与 SEO、许可证/SBOM/漏洞/Secret、制品网络、浏览器与可访问性、CSP、发布后冒烟等门禁类别；具体工具、格式和阈值继续受后续决策门禁约束。
  - 区分迁移前 `npm run quality` 与 Docusaurus 目标门禁，明确当前检查仍不足以证明目标供应链覆盖；生产发布必须等待所有必需 job，包括 PlantUML 编译。
  - 修正 Certbot webroot HTTP-01 与全量 HTTP 跳转的设计冲突：challenge 使用 release 之外的专用 root-owned webroot，其余 HTTP 请求才重定向到 HTTPS。
- **验证结果**：
  - `npm run quality` 通过：JavaScript 语法、Markdown 索引与内链、契约词、Secret 和迁移前静态入口检查全部成功。
  - `git diff --check` 通过。
  - `npm run check:diagrams` 未运行：本机未设置 `PUML_JAR`，且本次没有修改 PlantUML 源码或生成 SVG。
- **遗留项**：
  - OD-015 仍是下一项阻断性决策：确认单一 docs、多个 docs 或 docs + blog 的内容组织模式；本次没有替代或关闭该门禁。
  - Docusaurus/Node.js 版本、preset/plugin 实例、包管理器与 lockfile、内容目录、字段映射、主题 fit-gap、门禁具体工具与契约格式、构建位置、制品交付和新版主站 Spec 仍待逐项确认。
  - 服务器、GitHub environment、CAM/TAT、Certbot timer、快照和日志轮转仍待现场核验。
  - 本次未安装依赖、未修改页面或质量脚本，未操作服务器、DNS、证书或云资源，也未提交、推送或创建 PR。

## 2026-07-15 — check:contracts 纳入仓库根级文件，堵住漂移缺口

- **主题**：承接上一条的根因——`CLAUDE.md` 的失效副本之所以能一路漂移，是因为 `check:contracts` 的扫描根不含仓库根目录，没有门禁看着它。本次把根级文件纳入扫描。
- **完成内容**：
  - `contract-rules.json` 新增 `scan.include_root_files: true`；`lib/files.mjs` 新增 `listFilesShallow`（只列一层、不递归）；`check-contracts.mjs` 的 `scanFiles` 据此扫描根级文件，并把结果容器换成 `Set` 防重复计数。
  - 扫描集 40 → 45，新增 `AGENTS.md`、`CLAUDE.md`、`README.md`、`CONTRIBUTING.md`、`package.json` 五个根级文件，现状零违规。
  - `CLAUDE.md` 同步更正“根目录不在扫描范围内”这一已失效描述，并说明根目录只扫一层的原因。
- **方案取舍**：先试过把扫描根直接改成 `["."]`，干跑发现会把 **134 个 `.mypy_cache/*.json`** 卷进扫描集。这类本地工具缓存靠自带的嵌套 `.gitignore` 对 git 隐身，但扫描器走文件系统、不读 `.gitignore`，会让门禁范围随各人机器上的残留而变；且引入 Docusaurus 后还会冒出 `.docusaurus/`，靠 `skip_paths` 逐个排除是黑名单打地鼠，漏一个就悄悄失效——与本次要修的病因同构。改用“根目录只扫一层”：目录天然进不来，无需维护排除名单，新增根级文件还能自动纳入、不会漏登记。
- **验证证据**：
  - 现状 `npm run quality` 五项通过（exit 0）。
  - 反向验证：向 `CLAUDE.md` 注入三行违规文本，分别命中 forbidden/literal（定位旧名）、forbidden/word（裸写品牌名）、scoped（越界的受限词），`check:contracts` 如期失败并逐行指名 `CLAUDE.md:91/92/93`，退出码 1；随后 `git checkout --` 还原，`git status` 与 `git diff` 均确认已回到提交版本。
  - 撰写本条目时把违规词原样写进 `docs/progress.md`，被 `check:contracts` 当场拦下（`progress.md:17`）——门禁对既有扫描范围同样有效的顺带实证。
  - 确认扫描集不含 `.mypy_cache`，根级文件恰为上述五个。
- **遗留项**：
  - 受限词的 `allowed_paths` 未把根级文件纳入，因此 `CLAUDE.md` 里描述该规则时无法直接举例写出那个词，只能指向 `contract-rules.json`；如后续觉得别扭，可再决定是否为根级文件开例外。

## 2026-07-15 — CLAUDE.md 对齐 AGENTS.md 重构并清除失效副本

- **主题**：`AGENTS.md` 重构后，`CLAUDE.md` 与之脱节且核心事实已过期，按“瘦身对齐”方向重写：删除与 `docs/` 重复的定位/阶段/内容边界叙述，保留 Claude Code 专属的工具链知识。
- **完成内容**：
  - **修正失效事实**：删除“当前处于 M0 阶段、代码以零依赖静态站点为主”与“引入框架（Next.js / Astro / MDX / CMS）前先记录决策”——D-051 已改选 Docusaurus、D-028 已确认 Git + 静态站点生成器、`technology-selection.md` 已 superseded。阶段描述改为只指向 `docs/README.md`。
  - **补齐阻断性门禁**：新增 OD-014 / OD-015 停工门禁（未决前不进入页面实现或生产配置，并注明以 `open-decisions.md` 当时状态为准）和 D-052 开源依赖分层准入（加包前必读）。
  - **补齐重构新增机制**：指令优先级链、用户决策门禁（推荐≠授权、确认前不得提交推送建 PR、先查证再提问、确认后先复述）、`codex-rules/` 按需路由加载与“禁止批量加载”。
  - **修正门禁描述**：`quality` 由“四个门禁”更正为五项串联并补 `check:js`；补 `codex-workflow.md` 到规则清单；`global-AGENTS.md` 定位由“入口与索引”更正为“只负责路由”；`known-issues.md` 由“动手前先查阅”更正为“仅在涉及 `scripts/dev/`、跨机预览或本地配置时读取”。
  - **补齐目录清单**：新增 `scripts/dev/`、`.githooks/`、`docs/projects/`；预览命令区分临时 8000 与跨机预览 8088 两条链路。
  - 规模 92 行 → 89 行（重复叙述换成指针，换入决策门禁与阻断门禁）；复验 `npm run quality` 五项全部通过（exit 0）。
- **踩坑记录**：根因是 `contract-rules.json` 的扫描根只有 `docs` / `public` / `scripts` / `codex-rules` / `.github`，**根目录的 `CLAUDE.md` 与 `AGENTS.md` 不受契约门禁扫描**，因此手工维护的设计副本漂移后无门禁兜底。已把这一事实写进 `CLAUDE.md` 的门禁章节，作为“不再维护副本、只留指针”的依据。
- **遗留项**：
  - 是否把根目录 `CLAUDE.md`/`AGENTS.md` 纳入 `check:contracts` 扫描根尚未决定；若纳入，需先核查现有措辞是否命中 `scoped_terms`。
  - 本次改动与工作区中其它未提交的 `docs/` 变更尚未提交，提交范围待用户确认。

## 2026-07-15 — 确认开源依赖分层准入

- **主题**：用户确认主站及未来独立服务采用开源依赖分层准入，避免因复用开源组件引入不可追溯的许可证、数据和运行边界。
- **完成内容**：
  - 记录 D-052，确认主站构建与浏览器依赖优先 MIT、Apache-2.0、BSD-2-Clause、BSD-3-Clause 或 ISC，但具体包、版本和传递依赖仍须逐项核验与确认。
  - 区分浏览器产物、弱 copyleft、强 copyleft/复杂许可、独立服务、开发运维工具和内容素材；隔离部署不免除适用的许可证义务。
  - 明确社区插件、SDK、iframe、分析、登录、评论、搜索和浏览器第三方或境外请求不论许可证为何均需单独决策。
  - 记录每项准入所需的版本、来源、许可证、制品位置、网络与数据流、维护安全状态和退出方案，并把机器准入门禁留到首次锁定依赖和构建发布契约时实现。
  - 记录 Docusaurus 代码 MIT、官方文档 CC BY 4.0、Meta 商标政策和传递依赖不受框架许可证覆盖的边界；不据此决定本站源码或文章内容许可证。
  - 修正全局规则中“默认选择更保守方案”与用户决策门禁的冲突，并把 `script-src 'none'` 明确为迁移前骨架 CSP，不把它错误沿用到 Docusaurus 目标产物。
- **遗留项**：
  - Docusaurus 具体版本、preset、插件拓扑、直接与传递依赖仍未批准；Pagefind、CMS、身份、评论、分析和监控等调研候选均未选定。
  - 第一次新增依赖前需要确认 lockfile、准入登记、许可证扫描、第三方声明或 SBOM、构建产物和浏览器网络 allowlist 的具体工具与契约格式。
  - 本次未安装依赖、未修改页面或质量脚本，也未操作服务器、DNS、Git 提交、推送或 PR。

## 2026-07-15 — 主站目标框架改选 Docusaurus

- **主题**：在补做开源文档框架调研后，用户基于已有 React 项目和技术栈复用诉求，确认主站从 Astro 改选 Docusaurus。
- **完成内容**：
  - 记录 D-051，以 Docusaurus 替代 D-029 的 Astro 目标，同时保留 Git 内容、静态构建产物交给 Nginx、生产不运行 Node.js 服务的边界。
  - 明确 Docusaurus 标准 React 客户端资源属于框架基线；自定义客户端组件、第三方脚本和外部 SDK 不在本次授权内。
  - 保留已确认的路由、文档站式三栏、稳定 slug、文章领域字段和“项目-模块-主题标签”组织语义；它们与 Docusaurus 原生字段、侧栏和主题的映射继续等待设计。
  - 将当前 `public/` 明确为迁移前骨架，目标改为可重复生成的 Docusaurus 静态制品，确切输出目录仍待发布契约确认。
  - 保留历史 Astro 决策和进度记录，不把框架迁移改写成原决策从未发生。
- **遗留项**：
  - 首先确认 Docusaurus 使用单一 docs 实例、多个 docs 实例，还是 docs + blog；确认前不配置 preset/plugin、内容目录、路由或侧栏生成。
  - 后续再确认版本与依赖锁定、领域字段单向映射、注册表、主题 fit-gap、构建发布契约和新版主站 Spec。
  - 本次未安装 Docusaurus 或 React，未修改页面、依赖、服务器、DNS、Git 提交、推送或 PR。

## 2026-07-15 — 确认内容路由、文档站式三栏与完整编辑模型

- **主题**：用户确认主站项目/文章目录与详情路由、文档站式三栏结构，并选择技术文章的完整编辑模型。
- **完成内容**：
  - 记录 D-031，明确主站项目介绍与未来项目试用子域名的 URL 职责。
  - 记录 D-032，确认左侧目录、中间正文、右侧辅助区的三栏信息结构。
  - 记录 D-033，明确顶部全站导航、左侧同类内容目录、中间正文和右侧页面标题导航的职责分工。
  - 记录 D-034，确认宽屏三栏、中等宽度折叠左栏、窄屏折叠两个目录的渐进式响应策略。
  - 记录 D-035，确认手工英文语义 slug、稳定 URL 和改名时永久重定向的规则。
  - 记录 D-036，确认技术文章采用完整编辑模型，并保留精确字段结构与校验规则的后续决策门禁。
  - 记录 D-037，确认元数据与正文保持单文件、核心字段位于顶层、复杂可选元数据按职责嵌套分组，不使用文章级 sidecar 文件。
  - 记录 D-038，确认技术文章使用必填的顶层显式 `slug` 作为唯一 URL 真相源，文件名和目录不影响公开路由。
  - 记录 D-039，确认技术文章使用必填顶层字段 `publicationStatus` 表示发布可见性，枚举和 `planned` 归属继续保留为决策项。
  - 记录 D-040，确认文章发布状态只包含 `draft`、`published`、`archived`；`planned` 留在路线或选题记录，不进入文章集合。
  - 记录 D-041，确认技术文章使用必填 `authors` ID 列表引用 Git 作者注册表，并与未来账户和编辑权限解耦。
  - 记录 D-042，确认作者注册表采用单一 JSON 对象，并以稳定作者 ID 作为对象键。
  - 记录 D-043，确认本站首个稳定作者 ID 为 `lyty1997`，并将个人作者、站点品牌、未来发布组织和未来账户分层。
  - 记录 D-044，确认作者记录使用必填 `displayName`，首个作者的初始公开名称为 `lyty1997`，且显示名可独立更新。
  - 记录 D-045，确认作者注册表首版只包含 `displayName` 与 `links.github`，并登记已确认的 GitHub 主页。
  - 记录 D-046，确认必填 `title`、单一必填 `summary`、SEO 描述回退顺序，以及防止摘要重复和漂移的机器与评审门禁。
  - 记录 D-047，确认显式 `publishedAt` 与 `updatedAt`、Asia/Shanghai 发布辅助写入、Git 持久化和 CI/构建只读边界。
  - 记录 D-048，确认文章不设主分类，改按“项目-模块-主题标签”组织，且组织关系不进入 URL。
  - 记录 D-049，确认项目与模块各可选且最多一个、模块严格隶属项目、主题必填 1-5 个受控 ID，并规定单一规范目录归属、通用分组和跨项目不重复侧栏规则。
  - 记录 D-050，确认必填 `classification` 是项目、模块和主题组织字段的唯一分组，并禁止顶层或其他分组中的重复来源。
  - 将单页结构改为迁移前现状，把已确认的多页面路由提升为目标信息架构。
  - 标记旧 M0 Spec 中“不增加详情页”和单页布局规则已被替代。
- **遗留项**：
  - 精确响应式断点、目录分组排序和右栏上下文元数据字段尚待通过内容模型与视觉验证确定。
  - 项目/模块/主题注册表结构与路径、通用分组名称、跨项目相关关系字段、发布辅助命令、作者注册表路径、技术文章其余字段、项目字段、构建发布契约、身份和评论方案仍待逐项确认。
  - 未创建路由或页面组件，未安装依赖，未修改生产环境，也未提交或推送 Git。

## 2026-07-14 — 确认解耦目标架构与 Astro 静态生成

- **主题**：用户确认静态主站与未来动态服务解耦，技术分享采用 Git 管理，并选择 Astro 静态输出。
- **完成内容**：
  - 记录 D-027、D-028、D-029、D-030，明确服务职责边界、Astro 静态生成，以及 Markdown 默认、MDX 受控例外的内容格式策略。
  - 新增主站目标架构文档，说明构建、生产、数据所有权、故障隔离、安全隐私和实施门禁。
  - 将原生 HTML M0 技术选型标为已被替代，并把现有主站 Spec 标为需要适配 Astro 后重新评审。
  - 更新内容发布流程，确认 Git 是编辑审核边界、Astro 产物不是人工编辑源，并增加 MDX 组件审核门禁。
- **遗留项**：
  - 文章字段、MDX 组件登记机制、页面路由、Astro/Node 版本、构建发布契约、身份和评论具体方案尚待逐项确认。
  - 未安装 Astro、未迁移页面、未修改生产环境，也未提交或推送 Git。

## 2026-07-13 — 补齐 M0 技术选型、架构视图与主站实现 Spec

- **主题**：用户指出不能在缺少正式技术选型、架构设计和落盘 Spec 的情况下直接进入主站开发与合并。
- **完成内容**：
  - 新增 M0 技术选型决策，比较原生静态、Astro、Next.js、CMS 和运行时服务，确认首版使用语义化 HTML5、原生 CSS、零运行时 JavaScript 与本地静态资源。
  - 新增 M0 主站实现 Spec，定义页面结构、内容状态、视觉令牌、响应式、交互、素材、可访问性、SEO、性能预算、contract 映射和 Definition of Done。
  - 扩展架构概览，补充决策摘要、数据与请求流、信任边界、故障隔离和架构验收。
  - 统一首版内容、SEO 和 DocRestore 展示状态：完整文章与演示视频不阻塞首次上线，M0 必须发布 `robots.txt` 和 `sitemap.xml`。
  - 将 Git 晋级路径固定为在 `dev` 提交并推送、观察 CI、创建 `dev -> main` PR、合并后观察 `main` CI，禁止直接 push `main`。
- **遗留项**：
  - 用户需评审 M0 技术选型和主站实现 Spec；评审前不修改生产 DNS、服务器或主站页面实现。
  - 两个项目的真实视觉证据仍待准备，阻塞生产发布但不阻塞评审后的 HTML/CSS 结构开发。
  - 服务器现场核验、自动发布脚本、Nginx 配置、证书和 DNS 仍属于后续 M0-P/M0-L 实施范围。


## 2026-07-13 — 登记 VibeCoding Project Scaffold

- **主题**：用户要求在主站增加 VibeCoding Project Scaffold，提供 GitHub 仓库和 `main` 生产分支。
- **完成内容**：
  - 只读核对本地 `project-scaffold` 克隆、origin、README、AGENTS、`package.json` 和 Git 历史，确认初始化、质量门禁、CI、Git hooks、Node.js 与许可证等公开事实。
  - 新增 `docs/projects/vibecoding-project-scaffold.md`，定义项目摘要、问题、取舍、证据、源码 CTA、视觉素材和公开边界。
  - 新增 `docs/contracts/projects.json` 作为主站项目目录，统一登记 DocRestore 和 VibeCoding Project Scaffold。
  - 明确该脚手架只展示“查看源码”，不创建子域名、不提供在线体验，也不要求演示视频。
  - 主站内容模型区分项目目录与体验注册表；演示视频调整为可选增强，不再阻塞首版实现。
  - 同步文档索引、内容路线、契约词表、待决策项和生产清单。
- **遗留项**：
  - 主站实现前需为两个项目准备无敏感信息的真实截图或其他视觉证据。
  - 两个项目当前均为 `publicationStatus: planned`，页面代码、DNS 和服务器未修改。

## 2026-07-13 — DocRestore 改为源码与演示视频展示

- **主题**：用户确认 DocRestore 首版不提供在线体验，自有服务器只用于私有运行和录制，主站展示开源仓库与演示视频。
- **完成内容**：
  - 将 DocRestore 设计改为“项目说明 + GitHub + 演示视频”，明确不部署前端、不公开后端、不创建 `docrestore` 或 API 子域名的 DNS、Nginx 和证书。
  - 注册表保留 `docrestore` 名称，同时设置 `onlineExperience: false` 和 `dnsProvisioning: disabled`，防止后续自动化误部署。
  - 定义原生视频播放器、封面、WebVTT 中文字幕、文字摘要、文件大小目标、加载失败回退和移动端/桌面端要求。
  - 增加逐帧隐私与版权审核，禁止视频出现凭证、路径、IP、通知、真实用户文档或其他未授权内容。
  - 主站内容模型新增仓库、视频、封面和字幕字段；路线图不再要求 DocRestore 在线体验作为首版上线条件。
  - 保留未来在线体验的认证、用户隔离、配额、数据删除和后端生产门禁，但全部冻结，不提前实施。
- **遗留项**：
  - 用户需准备无敏感样例、演示视频、封面、中文字幕和文字摘要。
  - 成片完成后需按文件大小和预计访问量复核是否适合随主站静态托管。
  - 本次仍只更新设计文档与契约，没有修改页面代码、DocRestore 代码、DNS 或服务器。

## 2026-07-13 — 登记 DocRestore 并完成独立上线设计

- **主题**：用户提供首个项目 DocRestore 的子域名、仓库、生产分支、前端构建位置和外部重后端边界。
- **完成内容**：
  - 新增 `docs/projects/docrestore-experience.md`，定义 `docrestore.axialmuse.com` 静态前端与建议的 `api.docrestore.axialmuse.com` 独立后端拓扑。
  - 核对 DocRestore 本地仓库，确认 React/Vite 前端从 `frontend` 构建到 `frontend/dist`，API 当前固定为同源 `/api/v1`，上线前需统一支持经过校验的生产 API Origin。
  - 在项目体验注册表登记 DocRestore 为 `planned`、`noindex`；记录 API、WebSocket、上传和认证为未完成的运行依赖。
  - 明确当前单一设备 Bearer token 不是用户登录，且 token/LLM Key 的浏览器持久化、查询参数认证、全局任务与文件能力不能直接用于公网多用户体验。
  - 定义身份授权、用户数据隔离、CORS/WebSocket Origin、上传配额、保留与删除、LLM 数据传输、后端容量和备案的上线门禁。
  - 同步项目体验架构、生产清单、待决策问题、契约词表和文档索引。
- **遗留项**：
  - 用户需确认外部后端的地域、配置、带宽、备案接入状态和维护责任，以及首次开放范围。
  - 需确定身份方案、数据保留/删除、资源配额和 LLM 凭证模式，并在 DocRestore 仓库先更新设计与实现。
  - 当前只完成文档设计，没有修改 DocRestore 代码、DNS、服务器或主站页面，也未开放在线体验。

## 2026-07-13 — 设计项目体验子域名体系

- **主题**：用户要求为各个项目提供独立体验入口。
- **完成内容**：
  - 新增 `docs/architecture/project-experience-hosting.md`，定义 `<project-slug>.axialmuse.com` 的命名、显式 DNS、精确 Nginx、单项目证书、独立发布、隐私隔离和下线流程。
  - 新增 `docs/contracts/project-experiences.json` 作为项目体验注册表，默认静态发布、`noindex`，当前项目列表为空。
  - 主站项目条目只在体验状态为 `live` 且健康检查通过后显示“在线体验”，体验页必须提供返回主站与备案入口。
  - 同步架构概览、站点体验、内容路线、域名部署、自动维护、生产清单、术语和契约词表。
  - 明确 M0 不使用泛解析、泛域名证书、跨子域 Cookie 或共享项目发布权限，动态项目必须单独设计。
- **遗留项**：
  - 用户需提供首批项目名称、期望子域名、仓库地址、生产分支、构建方式、产物目录和是否需要后端或用户数据。
  - 服务器、DNS 和页面代码尚未实施，继续遵循文档先行顺序。

## 2026-07-13 — 确认公开 GitHub 个人主页

- **主题**：用户确认关于区展示 GitHub 个人主页。
- **完成内容**：
  - 将 `https://github.com/lyty1997` 记录为关于区公开身份入口。
  - 明确该入口只是普通公开链接，不涉及密码、Token、私有仓库或管理权限。
  - 关闭公开身份选择未决项，并同步生产清单与站点体验设计。
- **遗留项**：页面代码尚未实现该链接，随 M0-I 主站实现阶段落地。

## 2026-07-13 — 回填上海生产服务器与 ICP 接入事实

- **主题**：用户补充生产服务器、操作系统、用途、ICP备案号和接入状态，并询问关于区公开 GitHub 的含义。
- **完成内容**：
  - 记录生产服务器位于中国上海，运行 Ubuntu Server 24.04 LTS 64bit，当前为空机且专用于本网站。
  - 记录 ICP 备案号 `沪ICP备2026029086号` 和腾讯云接入成功状态，明确首页底部中央展示与工信部查询链接契约。
  - 将已确认事项从上线前未决项移出，保留控制台与服务器只读核验、公安备案和实例运维状态检查。
  - 明确“公开 GitHub”仅指可选的公开主页或仓库链接，不涉及任何凭证、私有仓库或管理权限。
- **遗留项**：
  - 用户需决定关于区是否展示 GitHub 链接。
  - 实施前需核验实例到期与续费、快照、TAT agent、系统现场状态和公安联网备案状态。

## 2026-07-12 — 根据既有腾讯云资源重定生产部署设计

- **主题**：用户确认正式域名为 `axialmuse.com`，已在腾讯云注册并完成中国大陆备案，同时已购买腾讯云轻量应用服务器；据此替换同日早先的 Cloudflare Pages 默认假设。
- **完成内容**：
  - 重写域名与生产发布设计，改为 DNSPod + 轻量应用服务器 + Nginx + ACME，并明确 `https://www.axialmuse.com/` 为 canonical。
  - 设计 GitHub Actions 通过最小权限 CAM 调用固定 TAT command 的发布链路，避免为自动部署向公网开放 SSH；生产版本采用 SHA 不可变目录和原子 symlink 回滚。
  - 补充轻量防火墙、SSH、Nginx、证书自动续期、服务器快照、DNS、备案接入和公安联网备案要求。
  - 重写自动化维护手册，增加服务器更新、磁盘、套餐流量、TAT、证书和备案检查；Nginx access log 默认关闭，错误与认证日志按期限本地保留。
  - 只读公网查询确认权威 DNS 已是 DNSPod，`@`/`www` 当前无 A/AAAA 且父区无 DS；该状态适合作为服务器配置完成前的 DNS 切换基线。
  - 更新架构概览、术语、路线图、生产清单和待决策问题，不创建外部账号、不连接服务器、不修改 DNS。
- **遗留项**：
  - 上线前需核验轻量实例地域、操作系统、镜像、现有服务、到期日、快照能力与 TAT 状态。
  - 需提供或现场读取完整 ICP 备案号，并确认已完成腾讯云接入备案；网站开通后按要求办理公安联网备案。

## 2026-07-12 — 完成主站、域名上线、内容发布与自动化维护设计

- **主题**：在不进入代码实现和供应商实际操作的前提下，为无建站经验的站点所有者建立从网站设计到域名上线和长期维护的完整设计基线。
- **完成内容**：
  - 新增 `docs/product/site-experience.md`，定义首版定位、访问者、M0-M2 信息架构、项目/技术分享/系列内容模型、视觉原则、可访问性、SEO 与隐私边界。
  - 新增 `docs/operations/domain-deployment.md`，形成 GitHub + Cloudflare Pages + Cloudflare DNS 默认方案，写清账户安全、域名选择、Pages v3 与 Node.js 22 构建契约、DNS/HTTPS/DNSSEC 上线顺序、验收、回滚、迁移和中国大陆部署分支。
  - 新增 `docs/operations/content-publishing.md`，定义内容状态、模板、来源、隐私与版权审核、Git 发布、修订和归档流程。
  - 新增 `docs/operations/maintenance.md` 与 `production-inventory.md`，定义自动门禁、定时检查、备份、权限复核、故障分级、恢复手册和非敏感生产事实清单。
  - 更新文档索引、架构概览、术语、内容路线、契约词表和待决策问题；当时将首版默认生产基线收敛到 Cloudflare Pages。该默认假设已在同日后续任务中被用户确认的腾讯云域名、备案和轻量服务器事实替代。
  - 设计参考了 Cloudflare、Google Search Central、工信部等官方资料；没有创建外部账号、购买域名、修改 DNS、部署生产站点或引入第三方脚本。
- **遗留项**：
  - 用户需先评审并回答 `OD-001` 至 `OD-004`，尤其是域名候选和是否要求中国大陆稳定访问。
  - 设计通过后进入 M0-C 内容准备，再按 M0-I、M0-P、M0-L、M0-O 顺序实现和上线。

## 2026-07-09 — 从 project-scaffold 回填工程脚手架改进

- **主题**：`project-scaffold` 是从本项目抽象出去的通用脚手架，抽象后又自行演进出一批改进（配置驱动、健壮性/安全加固、PlantUML 图表门禁）。对照两边差异，只回填"确实缺、确实适合当前阶段"的部分，按本项目真实上下文改写（非字节级复制）。
- **完成内容**：
  - **修复现存规则违规**：`docs/architecture/overview.md` 原用 Mermaid 画架构图，违反全局规则（禁用 Mermaid，强制 PlantUML）；`docs/architecture/dev-workflow.md` 已有 plantuml 时序图但从未编译校验、未渲染 SVG。新增 `scripts/quality/lib/plantuml.mjs` + `check-diagrams.mjs`（编译校验，独立于 `quality` 之外）+ `render-diagrams.mjs`（本地渲染器），用本机 `java -jar plantuml-1.2026.1.jar` 实测编译通过，`docs/diagrams/*.svg` 落地；CI 新增独立 `diagrams` job（下载并 SHA256 校验官方 jar）。
  - **静态站点检查配置化**：新增 `docs/contracts/site-checks.json`，重写 `check-static-site.mjs` 改为读取配置、入口文件不存在时优雅跳过、资源引用正则更健壮（覆盖单/双引号、跳过 data:/mailto:/锚点等）。
  - **CI 加固**：`push` 触发补上 `dev` 分支（此前只在 `main` push 时跑，与"push 到 main/dev 都要观察 CI"的规则不一致）；`actions/checkout`、`actions/setup-node` 升到 v5；quality job 加 `windows-latest` matrix，呼应真实存在的跨机 Windows/Linux 工作流。
  - **跨机预览脚本安全/健壮性修复**：`preview.sh` 新增端口占用保护（`port_listener_pid`/`pid_is_our_server`），避免误认或误杀同端口上的无关进程；`restart-remote.ps1` 新增分支名白名单 + 仓库路径黑名单校验，修复一个真实的远端命令注入面（此前 `$Branch`/`$RemoteRepoPath` 直接拼进 SSH 命令字符串，无任何字符过滤）。两个脚本改为从新增的 `scripts/dev/dev-workflow.env`（gitignored）读取主机/端口/路径，不再硬编码在已提交脚本里。
  - **其它**：新增 `.gitattributes`（跨平台换行归一化）、`CONTRIBUTING.md`、PR 模板加"对应设计文档"字段。
  - **顺带修复一个 `.gitignore` 漏洞**：`.env`/`.env.*` 模式实际不匹配 `dev-workflow.env` 这个文件名（不以 `.env` 开头），已补充显式规则 `scripts/dev/dev-workflow.env`，并用 `git check-ignore -v` 验证生效。
  - **自测证据**：`npm run quality` 全量通过；`PUML_JAR=... npm run check:diagrams` 通过（2 张图编译成功）且 `gen:diagrams` 幂等（二次运行无新改动）；对当前正在运行的真实预览服务（PID 由旧脚本启动）执行 `preview.sh restart`，新脚本正确识别、停止旧进程并重新拉起，`curl` 确认 HTTP 200；模拟删除 `dev-workflow.env` 验证脚本按预期报错退出而非静默使用错误默认值；`restart-remote.ps1` 的分支名白名单正则用一组通过/拒绝样例验证过滤逻辑正确（本机无 PowerShell，未做端到端执行验证，见遗留项）。
- **未采纳（及理由）**：LICENSE、`.claude/rules/*.md` 项目内镜像——已征询用户明确选择不采纳；`docs/architecture/stack-recipes/`——尚未选定具体技术栈，属于为假设的未来需求预先设计，先不引入；`scripts/init.mjs`/`SCAFFOLD.md`——脚手架自身初始化工具，本项目已初始化，不适用；`.claude/hooks/pre-edit-validate.py` 与项目级 `.claude/settings.json`——确认用户全局配置已提供同等校验，属纯冗余；`.claude/skills/sync-shared-rules/`——是 scaffold 作为"规则同步枢纽"角色专属技能，不适合复制进被同步方。
- **遗留项**：
  - `restart-remote.ps1` 的改动未在真实 Windows PowerShell 环境里端到端执行验证（本次会话在 Linux 上完成，只做了语法层面的正则逻辑验证），建议下次在 Windows 端跑一次 `sync.ps1 -RestartPreview` 完整验证。
  - `docs/diagrams/*.svg` 是本机 JVM 字体度量下的渲染产物，不同机器渲染字节可能不同，属预期行为（见 CLAUDE.md 说明），非缺陷。
  - 尚未实际 `git add` + 提交本次改动，也未推送观察 CI（含新增的 `diagrams` job 与 `windows-latest` matrix 是否真的转绿）。

## 2026-07-05（下午）— 验证跨机协同工作流是否满足实际需求，发现并修正环境假设

- **主题**：用户提出四条具体验收要求（Linux 托管+Windows 窗口渲染、Windows 端凭源码与渲染标注自主改代码并推送重启、双向一键同步、双端用 worktree），要求对照 [跨机协同开发预览工作流](architecture/dev-workflow.md) 和已提交脚本逐条验证是否真能做到，而不是只核对代码是否符合设计文档字面描述。
- **完成内容**：
  - **纠正了一个基础假设**：设计文档原先默认"当前 Claude Code CLI 会话＝Linux 托管机"，实测发现本次会话其实跑在 Windows 机器（hostname `lyty-server`，`192.168.0.163`）上，`192.168.0.162` 是局域网内另一台真实、可 ping 通的 Linux 机器。两者不能划等号，已更新设计文档把"托管角色"与"编码会话所在机器"拆开描述。
  - **实测确认渲染机制**：Windows 端 Claude Desktop 已配对 Chrome 浏览器扩展（`allowAllBrowserActions: true`），实测 `list_connected_browsers` 连接为活跃状态，且成功 `navigate` 到局域网预览地址——不需要设计文档原先设想的 Playwright MCP 回退方案。
  - **搭建 Windows→Linux 的 SSH 免密通道**：发现原有 `~/.ssh/known_hosts` 里 `192.168.0.162` 的指纹只代表"连接过"、不代表"能免密登录"（实测公钥认证被拒）。生成专用密钥对 `id_ed25519_axialmuse_preview`（不复用 GitHub 那把），用户手动把公钥装进 Linux 端 `~/.ssh/authorized_keys` 后验证通过。借这个通道现场确认了 Linux 端仓库真实路径 `~/work/personal_projects/AxiomMind/Axial_Muse/AxialMuseWebsite`，以及 `AxialMuseWebsite.preview` worktree、`preview.sh`/`sync.sh` 确实都在（此前 `progress.md` 的记录是真的，只是这次 Windows 端会话看不到）。
  - **新增 `scripts/dev/restart-remote.ps1`**（Windows 端）：SSH 到 Linux 端执行 `preview.sh restart <分支>`，把"改代码→同步→远程重启"收成一步；`sync.ps1` 新增可选开关 `-RestartPreview` 串联这一步。已实测：从分离头指针 `779407e` 成功拉到 `ee7b400` 并重启监听。
  - **发现并修复真实 bug（不是设计层面，是运行时才会暴露的）**：`sync.ps1` 与新写的 `restart-remote.ps1` 最初都是无 BOM 的 UTF-8，Windows PowerShell 5.1 在这台机器（系统默认代码页 GB2312）上解析时把中文注释解码错乱，报一堆无关的语法错误，导致脚本根本跑不起来。改成带 BOM 的 UTF-8 后正常执行，详见 [known-issues.md](../codex-rules/known-issues.md)。这个坑此前的纯代码审查（不实际执行）完全没发现。
  - 之前一轮（逐条核对 `ee7b400` 是否实现了 `4d169a7`/`985e89f` 设计文档的要求）里也顺手修了两处：`sync.ps1` 三条主 git 命令后补了 `$LASTEXITCODE` 检查（此前失败会被静默吞掉）；`preview.sh restart` 调整成先 `checkout_ref`（含 fetch）成功后再杀旧进程，避免网络抖动时把服务停了却起不来。
  - **网络问题已由用户解决并完成最终闭环验证**：Linux 托管机放行了局域网到 8088 端口的访问（原因确认是主机防火墙只放了 22 端口）。放行后 `Test-NetConnection 192.168.0.162 -Port 8088` 从 Windows 端返回 `TcpTestSucceeded: True`；用已配对的 Chrome 扩展重新 `navigate` 到 `http://192.168.0.162:8088/`，标签页标题变为真实的 `Axial Muse`（不再是连接失败的错误页），`get_page_text` 读到实际正文"Axiom Mind / 围绕 AI、知识工作流和个人产品体系的长期项目集合"。至此四条验收要求（Linux 托管+Windows 渲染、Windows 端凭源码与渲染标注改代码并推送重启、双向一键同步、双端 worktree）全部拿到端到端实测证据，不再只是设计层面的判断。
- **遗留项**：
  - `scripts/dev/restart-remote.ps1`（新增）与 `scripts/dev/sync.ps1`/`scripts/dev/preview.sh`（本轮修复）、`docs/architecture/dev-workflow.md`/本文件/`codex-rules/known-issues.md` 的更新目前都还是工作区改动，尚未提交，等待用户确认后提交。

## 2026-07-05 — 落地跨机协同开发预览工作流

- **主题**：按 [跨机协同开发预览工作流](architecture/dev-workflow.md) 设计文档，落地 Linux 端预览基础设施。
- **完成内容**：
  - 从 `main` 切出 `dev` 分支作为开发主干。
  - 新建 Linux 预览 worktree `../AxialMuseWebsite.preview`（分离头指针模式，避免与主目录已检出的分支冲突）。
  - 新增 `scripts/dev/sync.sh` / `scripts/dev/sync.ps1`（双向同步）与 `scripts/dev/preview.sh`（serve/restart/stop/status）。
  - **自测证据**（`preview.sh`，端口 8088）：
    - `serve main` → `curl http://192.168.0.162:8088/` 返回 `HTTP 200`，页面 `<title>Axial Muse</title>` 与 `main` 分支内容一致。
    - 连续 6 轮 `serve` → `curl` → `stop` → `curl` 验证，`stop` 后端口正确释放（发现并修复一处 `pipefail` 导致重试循环失效的 bug，见下）。
    - 重复 `serve` 被正确拒绝（提示先 `stop`/`restart`）；`serve` 不存在的分支报错且不残留进程。
    - `restart`（带分支参数与不带参数复用历史分支）均验证通过。
  - **踩坑记录**：`start_server` 最初用 `$!` 记录 PID，在 `setsid` 因调用方恰好是 process group leader 而内部二次 fork 的场景下，`$!` 拿到的是很快退出的包装进程（zombie 状态下 `kill -0` 仍返回成功），导致 `stop` 杀不到真正的服务；改为从监听 socket（`ss -tlnp`）反查真实 PID 解决。改的过程中还踩了一个 `pipefail` 坑：`grep` 无匹配时以状态 1 退出，直接赋值给变量在 `set -e` 下会让重试循环第一次没找到进程就终止整个脚本，加 `|| true` 后才是真正的"重试"。
  - `sync.sh` 验证时直接执行导致 `dev` 分支被推送到 `origin`（origin/dev 已建立）——这一步应先与用户确认，已如实告知。
- **遗留项**：
  - Windows Claude Desktop 是否原生支持外部局域网 URL 实时渲染与点选标注尚未现场验证（见设计文档"未决事项"），待用户在 Windows 端实测后回填。
  - `scripts/dev/` 三个脚本本身尚未提交到 git。

## 2026-07-03 — 对齐参考项目工程规范

- **主题**：参考 Augur_Maestro 的工程规范，在本项目补齐同构的工程约束。
- **完成内容**：
  - 新增 `CLAUDE.md`，作为 Claude Code 的工作入口，与 `AGENTS.md`、`codex-rules/`、`docs/` 共用同一真相源。
  - 新增本文件 `docs/progress.md` 作为进度真相源，并在 `docs/README.md` 索引。
  - 新增本地 `.githooks/pre-commit`，提交前自动运行 `npm run quality`，作为 CI 的本地镜像。
  - `README.md` 工程规范入口补充 `CLAUDE.md`。
  - 复验 `npm run quality` 四项门禁（Markdown 链接与索引、契约词表、密钥形态、静态站点）全部通过。
- **既有基线**（本次之前已就位）：`AGENTS.md`、`codex-rules/`、`docs/`（架构/契约/产品路线）、`scripts/quality/`、`.github/`（CI、CODEOWNERS、PR 模板）、`public/` 首版静态站点。
- **遗留项**：
  - 仓库尚未 `git init`；CI、分支策略（`main`/`dev`）、CODEOWNERS 均以 git 为前提，需初始化后 pre-commit 钩子才生效。
  - 首版内容页 `public/index.html` 仍为骨架，具体技术分享条目与项目展示内容待按 `docs/product/content-roadmap.md` 填充。

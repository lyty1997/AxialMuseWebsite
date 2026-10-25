# 生产调度接线清单

## 当前验收状态（2026-10-25）

#37 已按 D-163/D-164 完成本机发布与兼容恢复。[PR #69](https://github.com/lyty1997/AxialMuseWebsite/pull/69) 合并为 `main@27d461b9d7d0745343f01b3c491ee68d267b4700`；六模块和四命令已认证安装，旧入口备份保留。run `40146353211` 两个 attempt 均为六 job 成功；第二次实际 TAT task `invt-0ab9kvg3m6` 独立确认 `SUCCESS` / exit 0。四次激活/兼容切换结束后 current 停在该 main，HTTP、账本链、批准消费和历史 staging 保全均已现场验收。

账本摘要为 `2bd67fdfc737ea75047eb235cb64495865f5c91ac5d58bf1b2eaf42a2573d4de`；唯一 Web 监听为 `127.0.0.1:18080`。后续 main push 会由已安装入口尝试完整本机激活，不能继续把 `DEPLOY_ACTIVATION_PENDING` 当作当前成功边界。公网监听、DNS/DNSSEC 与正式 TLS 仍交给 #38；当前只允许报告 `local-accepted`。完整命令、制品身份和验证结果见 [#37 关闭证据](https://github.com/lyty1997/AxialMuseWebsite/issues/37#issuecomment-6391457633)。收尾文档暂未再次晋级，以遵守本轮两次 TAT 上限。

## #34 接线阶段的历史边界

本清单落实 D-160/D-161。只有固定服务器入口完成安装、GitHub 凭证与腾讯云最小权限配置读回、活动 workflow 进入 canonical `main` 后，才可执行一次受控 TAT 调度。调用返回的 `invocation ID` 不代表任务成功或站点已上线。当前固定入口只允许下载并独立验证到私有 staging，随后以 `DEPLOY_ACTIVATION_PENDING` 和非零状态明确停止；这是 #34 调度验收的安全边界，不是 #37 生产激活完成。首次账本、forward-only、Nginx 站点/reload、DNS/TLS 和公开激活仍须分别确认。

活动 `deploy-production` job 随 `main` push 自动触发；合并接线 PR 的那次 `main` push 也会生成新的 artifact 并尝试调用 TAT。必须在合并前完成下方的腾讯云 command/CAM/实例读回及 GitHub environment 核查；PR 检查中的跳过状态不构成生产调度验收。合并后以精确 `main` SHA 的 run、TAT invocation ID 和独立 task 终态分别收据化；首次任务仍按 `DEPLOY_ACTIVATION_PENDING` 预期解释，不将其非零结束写成网站上线成功。

服务器可能在 `deploy-production` job 收尾前开始读取制品。下载器保留整个精确 run 必须 `completed/success` 的要求：仅在相同 run/artifact/attempt/commit/repository 身份全部匹配且 run 为 `in_progress`、conclusion 为 null 时，在 30 秒内、最多 15 次间隔两秒重新读取元数据；每次重新校验完整身份与过期状态，成功前不请求 ZIP。超时以 `ARTIFACT_WORKFLOW_PENDING` 停止，失败、取消、身份漂移或 HTTP 错误立即停止。该只读等待不重发 TAT、不重试下载、不删除失败 staging，也不放宽生产激活边界。修复已随 [PR #68](https://github.com/lyty1997/AxialMuseWebsite/pull/68) 进入 canonical `main@441b214`，在精确 CI 成功后认证安装；[run 40069951954 attempt 2](https://github.com/lyty1997/AxialMuseWebsite/actions/runs/40069951954/attempts/2) 六个 job 成功，独立服务器任务按约定停于 `DEPLOY_ACTIVATION_PENDING`、exit 2，18 个文件与双摘要均验收一致。它完成 #34 接线验收，仍不表示 #37 站点激活。

## #37 本机激活候选与现场执行清单

本节是 D-163 的可审查候选方案，用户已按 D-164 授权其 Git 晋级与受控现场执行；记录时尚未实施生产写入。新站账本从首次 Docusaurus 发布开始，不导入已删除旧站的历史。公网监听、DNS 与正式 TLS 留给 #38；本轮成功状态只允许为 `local-accepted`，不能报告网站已经公网可用。

### 固定组件与写入范围

从本次专题进入 canonical `main` 且 CI 成功的精确提交认证每个源文件 blob 与 SHA-256。新增六个 root:root/0644 模块：`deployment_state.py`、`url_exposure_ledger.py`、`release_install.py`、`nginx_activation.py`、`release_transaction.py`、`release_commands.py`，安装到 `/usr/local/lib/axialmuse/ops/deploy/`。同一 `release_commands.py` 的认证字节作为 root:root/0755 的四个固定命令安装到 `/usr/local/sbin/`：

| 命令 | 固定输入与作用 |
| --- | --- |
| `axialmuse-deploy` | 既有五参数；持锁下载/验证，再安装和本机激活 |
| `axialmuse-deploy-prepared` | 同样五参数；只从确定的私有 staging 重验并激活，不下载、不调用 TAT |
| `axialmuse-rollback` | `--commit-sha <40位SHA>`；只允许历史验收成功且兼容完整账本的已安装代 |
| `axialmuse-deploy-init` | `--new-site-ledger`；仅在 current/releases/账本均缺席时初始化，不覆盖或重建 |

只有既有 `axialmuse-deploy` 会被替换，其旧字节、owner/mode 与摘要须先保存在 root-only 回退目录；其余目标必须不存在。安装前冻结精确源清单和前态摘要，逐项原子安装、同步目录并由新 SSH 会话复核。现有 TAT 参数解析器、保存的 command、GitHub App 凭证、已升级下载器及 verifier 两文件组件不改写。部署与回滚同时取得 verifier 的既有共享锁和新的部署排他锁。

初始化创建 `/srv/axialmuse/releases`（0755）、`/var/lib/axialmuse/deployment`（0700）及规范空账本（0600）。状态目录保留账本连续摘要链、原始初始化标记、安装收据和每个事务的 request/plan/result；任一不完整事务或摘要断链阻断后续入口。所有失败 staging、安装候选与批准消费证据保留，不自动删除。

首次激活在账本预写及 current 切换之后创建 `/etc/nginx/conf.d/axialmuse-local.conf`（root:root/0644），只监听 `127.0.0.1:18080`，access log 关闭，精确 include `current/config/site-release.conf`。隔离候选监听 `127.0.0.1:18081`，验收后结束该候选进程；候选配置保留在私有状态目录。每个 release 中的 wrapper 将 root/include 同时固定到同一个 40 位 SHA。现有 nginx.conf 不覆盖；站点配置一旦存在必须逐字节符合固定模板，否则停止。2026-10-24 只读核查确认上述端口空闲、站点配置缺席、conf.d 已被 nginx.conf 加载；执行前仍须重新核对。

### 一次性批准与失败边界

`deployment/forward-only.json` 必须是 root:root/0600 的单链接普通文件，使用与 `deployment_state.canonical` 相同的 UTF-8/两空格缩进/LF 字节。字段固定为 `id`（32 位小写十六进制）、`identity`（完整五参数的 snake_case 键）、`before` 和 `after`（账本前后 SHA-256）、`expires`（UTC Unix 整数秒）。有效期必须在读取时剩余 0 至 3600 秒之间；具体身份和摘要在准备现场计划时从精确 artifact 与账本计算，不使用 latest。无 Secret 字段。

批准在账本预写前移入该事务的 `approval.json` 并同步两个父目录；历史已消费的 ID 永久拒绝重放。没有兼容 fallback 且批准缺失、过期或不匹配时不切换 current。失败的 forward-only 激活保留已承诺 URL 和候选，不回退不兼容旧代；确认状态完整后，可用新精确身份和新批准向前修复。崩溃留下无终态事务或持久状态不一致时，入口停止并要求人工审计，不能通过删除记录解锁。

### 已授权的受控现场次序（D-164）

1. 将本轮窄化补丁从精确 `main` 整理到独立 `codex/*` 分支，直接向 main 提 PR；不带入 dev 的九个并行提交。PR 检查全绿且 head/base 稳定后合并。该 main push 会新增一次自动 TAT 调度，届时服务器仍为旧准备入口，预期保留 staging 并以 `DEPLOY_ACTIVATION_PENDING` 停止。
2. main CI 完成成功且独立 task/staging 双摘要复核后，认证安装上述组件，显式初始化新站账本。保持原 verifier、下载器、App 凭证、失败 staging 和 Nginx 原配置摘要证据。
3. 以 #34 已验收的 `441b2140ff0bd2e8191c107ce9ebe6f8a92eadee` / run `40069951954` / artifact `12550609976` 的既有 staging 为首次候选；再次验证其 ZIP `e987884970a39eb2e40f516d9561c9ff7ae8e44ada222dcfe49c4ac49a4ff22c` 和 release tree `a4cc5eae66894794a163ec6a6bf72b01419faca9371fff767b19fdbf18350cad`。只有原字节及最新前态一致时，才生成绑定它和精确账本前后摘要的一次性批准，通过 `axialmuse-deploy-prepared` 完成首次本机激活。
4. 先从第 1 步的新 canonical staging 验证 URL 集合与第一代兼容；不能假定“只改运维代码”就可以省略账本与 HTTP 检查。不兼容即停止，不追加 forward-only 授权。确认精确 main 未漂移后，仅完整重跑该 main CI 一次，产生新 attempt/artifact 并通过已安装的新固定入口执行第二次 TAT 调度；独立核对 task 必须 `SUCCESS` / exit 0，且真实 current、HTTP 和账本匹配。之后用固定 rollback 命令回到第一代，再回到本次 canonical 代。整个方案最多新增两次 TAT（合并时旧入口准备一次、安装后完整验收一次），共四次明确的本机激活/切换；不追加其他 main push、重跑或调用。
5. 新 SSH 会话独立复核 current SHA、全部安装文件 owner/mode/摘要、Nginx 只监听本机、实际 200/301/查询与 metadata 404、账本链/备份和四次事务结果。完整证据进入 #37 后才关闭；不能用本地 fixture 或 GitHub CI 替代现场结果。若任一动作状态不明，保留现场并停止，不消耗下一次操作掩盖问题。

上述动作依 D-164 的用户明确授权执行，不由本清单自行扩大边界。不新增第三方服务、CAM 权限、浏览器外部请求或用户数据处理。

## GitHub App：服务器只读制品

1. 在 GitHub 账号 `lyty1997` 下注册专用 **private GitHub App**，关闭 webhook；Repository permissions 只将 **Actions** 设为 **Read-only**（Metadata read 为 GitHub 基础权限），其余保持 No access。不授予组织权限或订阅事件。
2. 安装时选择 **Only select repositories**，只选 `lyty1997/AxialMuseWebsite`。记录数字 App ID 与 installation ID；生成私钥 PEM，通过不经聊天、Issue、PR 或仓库的安全通道送到服务器。
3. 服务器使用 root-owned `/etc/axialmuse/`（mode `0700`），其中 `github-app-private-key.pem`（mode `0400` 或 `0600`）与 `github-app.json`（同权限）分别保存私钥和 `{"appId":"<数字>","installationId":"<数字>"}`。目录和文件必须为 root:root、普通文件、单链接；不要在 shell history、命令行参数、TAT 输出或日志中显示私钥。
4. 固定入口按需用 PEM 签发短时 JWT，再请求仅对 `AxialMuseWebsite`、`actions:read` 的 installation token；读回 token 的仓库和权限后仅访问固定 GitHub API。ZIP 的短时 302 URL 只经 HTTPS 无 Authorization 下载，不保存或输出 URL。若 App 权限、仓库、私钥、时钟或下载行为不符，停止发布。私钥轮换时先验证新 key，再撤销旧 key。

## 腾讯云：TAT 与 CAM

1. 在目标轻量服务器所属地域 `ap-shanghai` 创建一个保存的个人 TAT 命令，名称 `axialmuse-deploy`，类型 `SHELL`，执行用户 `root`，启用自定义参数，内容与仓库 [`tat-command.sh`](../../ops/deploy/tat-command.sh) **逐字节一致**。五个参数名固定为 `workflowRunId`、`artifactId`、`commitSha`、`artifactDigest`、`releaseContentSha256`；不设置默认参数，不设置定时/周期执行器或 COS 输出。创建后只记录 `cmd-...` ID，核对内容、执行用户、参数开关和目标地域。命令必须等待服务器上的固定入口完成安装后才可执行。
2. 建专用 CAM 子账号及 API 密钥，不使用主账号密钥。自定义策略的 `action` 仅为 `tat:InvokeCommand`，`resource` 仅列下列两个精确资源，替换主账号 UIN、实际 command ID、Lighthouse instance ID；不要使用 `*`、`tat:RunCommand`、`tat:CreateCommand`、`tat:ModifyCommand` 或实例管理权限：

   ```json
   {
     "version": "2.0",
     "statement": [{
       "effect": "allow",
       "action": ["tat:InvokeCommand"],
       "resource": [
         "qcs::tat:ap-shanghai:uin/<主账号UIN>:command/<cmd-ID>",
         "qcs::lighthouse:ap-shanghai:uin/<主账号UIN>:instance/<lhins-ID>"
       ]
     }]
   }
   ```

3. 将 SecretId、SecretKey **直接**写入 GitHub `production` environment secrets，名称分别为 `TENCENTCLOUD_SECRET_ID`、`TENCENTCLOUD_SECRET_KEY`；不要经过本地仓库、聊天或日志。environment variables 为 `AXIAL_TAT_REGION=ap-shanghai`、`AXIAL_TAT_COMMAND_ID=<cmd-ID>`、`AXIAL_TAT_INSTANCE_ID=<lhins-ID>`。Environment 仅允许 `main` 分支部署；工作流另用 `GITHUB_TOKEN` 的 `contents:read`、`actions:read` 做只读身份复核。
4. 先核对 CAM 策略、command 内容和精确实例，再由当前 canonical `main` 的成功 run 做一次调度。记录脱敏 invocation ID 和独立 task 终态；任务输出只允许固定状态码，不包含 Secret、token、签名 URL、云账号或私密主机信息。任一结果不明时不自动重试。

依据：[GitHub App 安装令牌](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)、[GitHub artifact 下载权限](https://docs.github.com/en/rest/actions/artifacts)、[腾讯云 TAT CAM 资源粒度](https://cloud.tencent.com/document/product/598/70026) 与 [InvokeCommand](https://cloud.tencent.com/document/product/1340/52678)。

# 生产调度接线清单

本清单落实 D-160/D-161。只有固定服务器入口完成安装、GitHub 凭证与腾讯云最小权限配置读回、活动 workflow 进入 canonical `main` 后，才可执行一次受控 TAT 调度。调用返回的 `invocation ID` 不代表任务成功或站点已上线。当前固定入口只允许下载并独立验证到私有 staging，随后以 `DEPLOY_ACTIVATION_PENDING` 和非零状态明确停止；这是 #34 调度验收的安全边界，不是 #37 生产激活完成。首次账本、forward-only、Nginx 站点/reload、DNS/TLS 和公开激活仍须分别确认。

活动 `deploy-production` job 随 `main` push 自动触发；合并接线 PR 的那次 `main` push 也会生成新的 artifact 并尝试调用 TAT。必须在合并前完成下方的腾讯云 command/CAM/实例读回及 GitHub environment 核查；PR 检查中的跳过状态不构成生产调度验收。合并后以精确 `main` SHA 的 run、TAT invocation ID 和独立 task 终态分别收据化；首次任务仍按 `DEPLOY_ACTIVATION_PENDING` 预期解释，不将其非零结束写成网站上线成功。

服务器可能在 `deploy-production` job 收尾前开始读取制品。下载器的本地修复候选保留整个精确 run 必须 `completed/success` 的要求：仅在相同 run/artifact/attempt/commit/repository 身份全部匹配且 run 为 `in_progress`、conclusion 为 null 时，在 30 秒内、最多 15 次间隔两秒重新读取元数据；每次重新校验完整身份与过期状态，成功前不请求 ZIP。超时以 `ARTIFACT_WORKFLOW_PENDING` 停止，失败、取消、身份漂移或 HTTP 错误立即停止。该只读等待不重发 TAT、不重试下载、不删除失败 staging，也不放宽生产激活边界。此候选仍须完成 Git 晋级、服务器来源认证与安装及新的独立受控验收，尚未部署。

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

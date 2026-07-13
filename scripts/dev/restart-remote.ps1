# 通过 SSH 触发远端 Linux 托管机预览服务重启：只在发起同步的一端用（通常是 Windows）。
# 远端 preview.sh 本身已经封装了 fetch + checkout --detach + 重启的全部逻辑，
# 这里只是把"从这一端喊它跑一次"这一步补上，不重复实现远端逻辑。
# 配置读取顺序：命令行参数 > scripts/dev/dev-workflow.env。
param(
    [string]$Branch,
    [string]$PreviewHost,
    [string]$RemoteRepoPath,
    [string]$RemoteUser,
    [string]$SshKeyName
)
$ErrorActionPreference = "Stop"

$envFile = Join-Path $PSScriptRoot "dev-workflow.env"
$envValues = @{}
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        # 值用非贪婪匹配去掉尾部空白，并剥掉成对的首尾引号，与 Linux 端 preview.sh 的 `source` 语义对齐，
        # 避免手改 env 时写的引号或尾随空格只在 Windows 端把主机名/路径带坏。
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
            $val = $matches[2]
            if ($val -match '^"(.*)"$' -or $val -match "^'(.*)'$") { $val = $matches[1] }
            $envValues[$matches[1]] = $val
        }
    }
}

if (-not $PreviewHost) { $PreviewHost = $envValues["PREVIEW_HOST"] }
if (-not $RemoteRepoPath) { $RemoteRepoPath = $envValues["REMOTE_REPO_PATH"] }
if (-not $RemoteUser) { $RemoteUser = $envValues["REMOTE_USER"] }
if (-not $SshKeyName) { $SshKeyName = $envValues["SSH_KEY_NAME"] }

if (-not $PreviewHost -or -not $RemoteRepoPath) {
    Write-Error "缺少 PreviewHost/RemoteRepoPath：复制 scripts/dev/dev-workflow.env.example 为 dev-workflow.env 并填写，或用 -PreviewHost/-RemoteRepoPath 参数传入"
    exit 1
}

if (-not $Branch) {
    $Branch = (git symbolic-ref --quiet --short HEAD)
    if ($LASTEXITCODE -ne 0 -or -not $Branch) {
        Write-Error "未指定 -Branch 且当前处于分离头指针状态，无法推断分支"
        exit 1
    }
}

# 分支名和仓库路径会拼进远端 shell 命令（单引号包裹），这里做白名单/黑名单校验，
# 防止值里出现单引号等元字符逃逸包裹、造成远端命令注入。
if ($Branch -notmatch '^[A-Za-z0-9._/-]+$') {
    Write-Error "分支名 '$Branch' 含不安全字符，已拒绝"
    exit 1
}
foreach ($ch in @("'", '"', ';', '&', '|', '<', '>', '`', '$', '(', ')', "`n", "`r")) {
    if ($RemoteRepoPath.Contains($ch)) {
        Write-Error "REMOTE_REPO_PATH 含不安全字符，已拒绝：$RemoteRepoPath"
        exit 1
    }
}

# 显式配置了 REMOTE_USER / SSH_KEY_NAME 就用上（兑现 dev-workflow.env 里这两项，
# 避免它们沦为无人消费的死配置）；未配置时退回裸 host，由 ~/.ssh/config 解析用户与密钥
# （见 docs/architecture/dev-workflow.md）。
$target = if ($RemoteUser) { "$RemoteUser@$PreviewHost" } else { $PreviewHost }
$sshArgs = @()
if ($SshKeyName) {
    $keyPath = Join-Path $HOME ".ssh/$SshKeyName"
    $sshArgs += @("-i", $keyPath, "-o", "IdentitiesOnly=yes")
}

Write-Host "== [restart-remote] 通过 SSH 在 $target 上重启预览（分支 $Branch）=="
ssh @sshArgs $target "cd '$RemoteRepoPath' && ./scripts/dev/preview.sh restart '$Branch'"
if ($LASTEXITCODE -ne 0) {
    Write-Error "远端 preview.sh restart 失败（退出码 $LASTEXITCODE）"
    exit 1
}

Write-Host "== [restart-remote] 完成 =="

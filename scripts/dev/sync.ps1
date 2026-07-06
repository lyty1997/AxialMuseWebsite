# 双向同步：git fetch + pull --rebase + 按需 push 当前分支。
# 用于 docs/architecture/dev-workflow.md 描述的 Windows/Linux 协同预览闭环，
# 在 Windows 端 PowerShell 中运行，逻辑与 scripts/dev/sync.sh 保持一致。
# -RestartPreview 是 Windows 独有的可选收尾步骤（默认不开，不影响与 sync.sh 的对等行为）：
# 推送成功后顺带通过 SSH 让 Linux 端的预览服务拉取新提交并重启，实现见 restart-remote.ps1。
param(
    [switch]$RestartPreview
)
$ErrorActionPreference = "Stop"

$repoRoot = (git rev-parse --show-toplevel)
if ($LASTEXITCODE -ne 0) { exit 1 }
Set-Location $repoRoot

$branch = (git symbolic-ref --quiet --short HEAD)
if ($LASTEXITCODE -ne 0 -or -not $branch) {
    Write-Error "当前处于分离头指针状态，sync.ps1 只能在具名分支上运行"
    exit 1
}

Write-Host "== [sync] 分支 $branch：git fetch =="
git fetch origin
if ($LASTEXITCODE -ne 0) {
    Write-Error "git fetch 失败（退出码 $LASTEXITCODE）"
    exit 1
}

git show-ref --quiet "refs/remotes/origin/$branch"
$remoteExists = ($LASTEXITCODE -eq 0)
if ($remoteExists) {
    Write-Host "== [sync] 分支 $branch：git pull --rebase =="
    git pull --rebase origin $branch
    if ($LASTEXITCODE -ne 0) {
        Write-Error "git pull --rebase 失败（退出码 $LASTEXITCODE），可能存在冲突，请手动处理"
        exit 1
    }
} else {
    Write-Host "== [sync] 远端还没有 origin/$branch，跳过 pull =="
}

git rev-parse --quiet --verify '@{u}' | Out-Null
$ahead = 0
if ($LASTEXITCODE -eq 0) {
    $ahead = [int](git rev-list --count '@{u}..HEAD')
}

if ($ahead -gt 0 -or -not $remoteExists) {
    Write-Host "== [sync] 推送 $branch 到 origin（本地领先 $ahead 个提交）=="
    git push --set-upstream origin $branch
    if ($LASTEXITCODE -ne 0) {
        Write-Error "git push 失败（退出码 $LASTEXITCODE）"
        exit 1
    }
} else {
    Write-Host "== [sync] 没有需要推送的本地提交 =="
}

$head = (git rev-parse --short HEAD)
Write-Host "== [sync] 完成，当前 HEAD: $head =="

if ($RestartPreview) {
    & (Join-Path $PSScriptRoot "restart-remote.ps1") -Branch $branch
    if ($LASTEXITCODE -ne 0) { exit 1 }
}

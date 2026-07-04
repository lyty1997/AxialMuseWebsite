# 双向同步：git fetch + pull --rebase + 按需 push 当前分支。
# 用于 docs/architecture/dev-workflow.md 描述的 Windows/Linux 协同预览闭环，
# 在 Windows 端 PowerShell 中运行，逻辑与 scripts/dev/sync.sh 保持一致。
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

git show-ref --quiet "refs/remotes/origin/$branch"
$remoteExists = ($LASTEXITCODE -eq 0)
if ($remoteExists) {
    Write-Host "== [sync] 分支 $branch：git pull --rebase =="
    git pull --rebase origin $branch
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
} else {
    Write-Host "== [sync] 没有需要推送的本地提交 =="
}

$head = (git rev-parse --short HEAD)
Write-Host "== [sync] 完成，当前 HEAD: $head =="

# 通过 SSH 触发远端 Linux 预览服务重启：只在 Windows 端用。
# 远端 preview.sh 本身已经封装了 fetch + checkout --detach + 重启的全部逻辑，
# 这里只是把"从 Windows 一键喊它跑一次"这一步补上，不重复实现远端逻辑。
# 依赖 ~/.ssh/config 里 Host 192.168.0.162 的免密登录（专用密钥 id_ed25519_axialmuse_preview，
# 见 docs/architecture/dev-workflow.md）。
param(
    [string]$Branch,
    [string]$PreviewHost = "192.168.0.162",
    [string]$RemoteRepoPath = "/home/lyty/work/personal_projects/AxiomMind/Axial_Muse/AxialMuseWebsite"
)
$ErrorActionPreference = "Stop"

if (-not $Branch) {
    $Branch = (git symbolic-ref --quiet --short HEAD)
    if ($LASTEXITCODE -ne 0 -or -not $Branch) {
        Write-Error "未指定 -Branch 且当前处于分离头指针状态，无法推断分支"
        exit 1
    }
}

Write-Host "== [restart-remote] 通过 SSH 在 $PreviewHost 上重启预览（分支 $Branch）=="
ssh $PreviewHost "cd '$RemoteRepoPath' && ./scripts/dev/preview.sh restart '$Branch'"
if ($LASTEXITCODE -ne 0) {
    Write-Error "远端 preview.sh restart 失败（退出码 $LASTEXITCODE）"
    exit 1
}

Write-Host "== [restart-remote] 完成 =="

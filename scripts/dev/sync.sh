#!/usr/bin/env bash
# 双向同步：git fetch + pull --rebase + 按需 push 当前分支。
# 用于 docs/architecture/dev-workflow.md 描述的 Windows/Linux 协同预览闭环，
# Linux 端和 Windows 端（Git Bash）均可直接运行。
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "${repo_root}"

branch="$(git symbolic-ref --quiet --short HEAD)" || {
  echo "错误：当前处于分离头指针状态，sync.sh 只能在具名分支上运行" >&2
  exit 1
}

echo "== [sync] 分支 ${branch}：git fetch =="
git fetch origin

if git show-ref --quiet "refs/remotes/origin/${branch}"; then
  echo "== [sync] 分支 ${branch}：git pull --rebase =="
  git pull --rebase origin "${branch}"
  remote_exists=1
else
  echo "== [sync] 远端还没有 origin/${branch}，跳过 pull =="
  remote_exists=0
fi

if git rev-parse --quiet --verify "@{u}" >/dev/null 2>&1; then
  ahead="$(git rev-list --count "@{u}..HEAD")"
else
  ahead=0
fi

if [ "${ahead}" -gt 0 ] || [ "${remote_exists}" -eq 0 ]; then
  echo "== [sync] 推送 ${branch} 到 origin（本地领先 ${ahead} 个提交）=="
  git push --set-upstream origin "${branch}"
else
  echo "== [sync] 没有需要推送的本地提交 =="
fi

echo "== [sync] 完成，当前 HEAD: $(git rev-parse --short HEAD) =="

#!/usr/bin/env bash
# 预览服务脚本：只在 Linux 端使用，操作 ../<仓库名>.preview 这个 worktree。
# 设计见 docs/architecture/dev-workflow.md，按需触发，不做常驻 watcher。
set -euo pipefail

PORT="${PREVIEW_PORT:-8088}"
PREVIEW_HOST="${PREVIEW_HOST:-192.168.0.162}"

repo_root="$(git rev-parse --show-toplevel)"
repo_name="$(basename "${repo_root}")"
preview_dir="$(dirname "${repo_root}")/${repo_name}.preview"
pid_file="${preview_dir}/.preview.pid"
branch_file="${preview_dir}/.preview.branch"
log_file="${preview_dir}/.preview.log"

usage() {
  cat >&2 <<EOF
用法：$(basename "$0") <serve <分支> | restart [分支] | stop | status>
EOF
  exit 1
}

ensure_preview_worktree() {
  if [ ! -d "${preview_dir}" ]; then
    echo "== [preview] 预览 worktree 不存在，创建于 ${preview_dir} =="
    git -C "${repo_root}" worktree add --detach "${preview_dir}" HEAD
  fi
}

is_running() {
  [ -f "${pid_file}" ] || return 1
  local pid
  pid="$(cat "${pid_file}")"
  [ -n "${pid}" ] || return 1
  kill -0 "${pid}" 2>/dev/null || return 1
  grep -q "http.server" "/proc/${pid}/cmdline" 2>/dev/null || return 1
  return 0
}

checkout_ref() {
  local branch="$1"
  echo "== [preview] git fetch origin ${branch} =="
  git -C "${preview_dir}" fetch origin "${branch}"
  if git -C "${preview_dir}" show-ref --quiet "refs/remotes/origin/${branch}"; then
    git -C "${preview_dir}" checkout --detach "origin/${branch}"
  elif git -C "${preview_dir}" show-ref --quiet "refs/heads/${branch}"; then
    git -C "${preview_dir}" checkout --detach "${branch}"
  else
    echo "错误：本地和远端都找不到分支 ${branch}" >&2
    exit 1
  fi
  echo "${branch}" > "${branch_file}"
}

start_server() {
  echo "== [preview] 启动静态服务器，端口 ${PORT} =="
  # 不信任 $!：setsid 在调用方恰好是 process group leader 时会内部再 fork 一次，
  # $! 拿到的会是很快退出的 setsid 包装进程（kill -0 对 zombie 仍返回成功），
  # 而不是真正的 python3 进程，导致后续 stop/restart 杀不到真正的服务。
  # 改成从监听 socket 反查真实 PID；进程绑定端口需要一点时间，所以带重试。
  setsid python3 -m http.server -d "${preview_dir}/public" "${PORT}" \
    >"${log_file}" 2>&1 < /dev/null &
  disown 2>/dev/null || true

  local real_pid=""
  for _ in $(seq 1 20); do
    # 注意：pipefail 下 grep 找不到匹配会以状态 1 退出，若不接 `|| true`，
    # 这个赋值语句在 set -e 下会直接终止脚本，重试循环根本执行不到第二轮。
    real_pid="$(ss -tlnp "( sport = :${PORT} )" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -n1 || true)"
    if [ -n "${real_pid}" ]; then
      break
    fi
    sleep 0.2
  done

  if [ -z "${real_pid}" ]; then
    echo "错误：静态服务器启动失败或未能确认监听端口 ${PORT}，日志如下：" >&2
    tail -n 20 "${log_file}" >&2 || true
    exit 1
  fi
  echo "${real_pid}" > "${pid_file}"
  echo "== [preview] 已启动，PID ${real_pid}，预览地址 http://${PREVIEW_HOST}:${PORT}/ =="
}

stop_server() {
  if is_running; then
    local pid
    pid="$(cat "${pid_file}")"
    echo "== [preview] 停止 PID ${pid} =="
    kill -TERM "${pid}" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "${pid}" 2>/dev/null || break
      sleep 0.3
    done
    kill -0 "${pid}" 2>/dev/null && kill -KILL "${pid}" 2>/dev/null || true
  fi
  rm -f "${pid_file}"
}

cmd="${1:-}"
case "${cmd}" in
  serve)
    branch="${2:-}"
    [ -n "${branch}" ] || usage
    if is_running; then
      echo "错误：预览服务已在运行，先 stop 或改用 restart" >&2
      exit 1
    fi
    ensure_preview_worktree
    checkout_ref "${branch}"
    start_server
    ;;
  restart)
    branch="${2:-}"
    ensure_preview_worktree
    if [ -z "${branch}" ]; then
      [ -f "${branch_file}" ] || { echo "错误：没有历史分支记录，请显式传入分支名" >&2; exit 1; }
      branch="$(cat "${branch_file}")"
    fi
    stop_server
    checkout_ref "${branch}"
    start_server
    ;;
  stop)
    stop_server
    echo "== [preview] 已停止 =="
    ;;
  status)
    if is_running; then
      echo "运行中，PID $(cat "${pid_file}")，分支 $(cat "${branch_file}" 2>/dev/null || echo 未知)，http://${PREVIEW_HOST}:${PORT}/"
    else
      echo "未运行"
    fi
    ;;
  *)
    usage
    ;;
esac

#!/usr/bin/env bash
# Linux 局域网预览控制器：构建已验收 preview release，并原子切换 current。
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${script_dir}/dev-workflow.env"
if [ -f "${env_file}" ]; then
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
fi

PORT="${PREVIEW_PORT:?错误：未设置 PREVIEW_PORT。复制 scripts/dev/dev-workflow.env.example 为 dev-workflow.env 并填写}"
PREVIEW_HOST="${PREVIEW_HOST:?错误：未设置 PREVIEW_HOST，同上}"
STATE_INPUT="${PREVIEW_STATE_DIR:?错误：未设置 PREVIEW_STATE_DIR，同上}"

if ! [[ "${PORT}" =~ ^[1-9][0-9]{0,4}$ ]] || [ "${PORT}" -gt 65535 ]; then
  echo "错误：PREVIEW_PORT 必须是 1..65535。" >&2
  exit 1
fi
if ! [[ "${PREVIEW_HOST}" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "错误：PREVIEW_HOST 只能是受控主机名或 IPv4 地址。" >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
repo_root="$(realpath -- "${repo_root}")"
repo_name="$(basename "${repo_root}")"
preview_dir="$(dirname "${repo_root}")/${repo_name}.preview"
system_tmp="$(node -e 'process.stdout.write(require("node:os").tmpdir())')"
system_tmp="$(realpath -- "${system_tmp}")"

usage() {
  cat >&2 <<EOF
用法：$(basename "$0") <start|serve <分支> | restart [分支] | stop | status>
EOF
  exit 1
}

fail_plain() {
  echo "错误：$1" >&2
  exit 1
}

path_contains() {
  local parent="$1"
  local child="$2"
  [ "${child}" = "${parent}" ] || [[ "${child}" == "${parent}/"* ]]
}

assert_private_directory() {
  local path="$1"
  local label="$2"
  [ -d "${path}" ] || fail_plain "${label} 不存在或不是目录。"
  [ ! -L "${path}" ] || fail_plain "${label} 不得是符号链接。"
  [ "$(realpath -- "${path}")" = "${path}" ] || fail_plain "${label} 必须是规范真实路径。"
  [ "$(stat -c '%u' -- "${path}")" = "$(id -u)" ] || fail_plain "${label} 不属于当前用户。"
  [ "$(stat -c '%a' -- "${path}")" = "700" ] || fail_plain "${label} 权限必须是 0700。"
}

ensure_state_root() {
  [[ "${STATE_INPUT}" = /* ]] || fail_plain "PREVIEW_STATE_DIR 必须是绝对路径。"
  local parent
  parent="$(dirname -- "${STATE_INPUT}")"
  [ -d "${parent}" ] || fail_plain "PREVIEW_STATE_DIR 的父目录必须已存在。"
  [ ! -L "${parent}" ] || fail_plain "PREVIEW_STATE_DIR 的父目录不得是符号链接。"
  parent="$(realpath -- "${parent}")"
  state_root="${parent}/$(basename -- "${STATE_INPUT}")"
  [ "${state_root}" = "${STATE_INPUT}" ] || fail_plain "PREVIEW_STATE_DIR 必须是规范绝对路径。"
  [ ! -L "${state_root}" ] || fail_plain "PREVIEW_STATE_DIR 不得是符号链接。"
  if [ ! -e "${state_root}" ]; then
    mkdir -m 700 -- "${state_root}" 2>/dev/null || [ -d "${state_root}" ]
  fi
  assert_private_directory "${state_root}" "PREVIEW_STATE_DIR"
  if path_contains "${system_tmp}" "${state_root}"; then
    fail_plain "PREVIEW_STATE_DIR 不得位于系统临时目录。"
  fi
  if path_contains "${repo_root}" "${state_root}" || path_contains "${state_root}" "${repo_root}"; then
    fail_plain "PREVIEW_STATE_DIR 不得位于仓库内，也不得包含仓库。"
  fi
  while IFS= read -r worktree; do
    [ -n "${worktree}" ] || continue
    worktree="$(realpath -- "${worktree}")"
    if path_contains "${worktree}" "${state_root}" || path_contains "${state_root}" "${worktree}"; then
      fail_plain "PREVIEW_STATE_DIR 必须位于全部 worktree 之外。"
    fi
  done < <(git -C "${repo_root}" worktree list --porcelain | sed -n 's/^worktree //p')

  for name in candidates releases run logs; do
    local directory="${state_root}/${name}"
    [ ! -L "${directory}" ] || fail_plain "preview ${name} 目录不得是符号链接。"
    if [ ! -e "${directory}" ]; then
      mkdir -m 700 -- "${directory}" 2>/dev/null || [ -d "${directory}" ]
    fi
    assert_private_directory "${directory}" "preview ${name} 目录"
    [ "$(stat -c '%d' -- "${directory}")" = "$(stat -c '%d' -- "${state_root}")" ] \
      || fail_plain "preview candidates/releases/current 必须位于同一文件系统。"
  done
  candidates_dir="${state_root}/candidates"
  releases_dir="${state_root}/releases"
  run_dir="${state_root}/run"
  logs_dir="${state_root}/logs"
  current_link="${state_root}/current"
  pid_file="${run_dir}/server.pid"
  branch_file="${run_dir}/requested-branch"
  head_file="${run_dir}/worktree-head"
  candidate_file="${run_dir}/candidate-sha"
  failure_file="${run_dir}/recent-failure"
  lock_file="${run_dir}/preview.lock"
  server_log="${logs_dir}/server.log"
  operation_log="${logs_dir}/operation.log"
}

try_atomic_write() {
  local target="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp --tmpdir="${run_dir}" ".$(basename -- "${target}").$$.XXXXXXXX.tmp")" \
    || return 1
  (umask 077; printf '%s\n' "${value}" > "${temporary}") 2>/dev/null \
    || return 1
  chmod 600 -- "${temporary}" 2>/dev/null \
    || { rm -f -- "${temporary}" 2>/dev/null || true; return 1; }
  if ! mv -fT -- "${temporary}" "${target}" 2>/dev/null; then
    rm -f -- "${temporary}" 2>/dev/null || true
    return 1
  fi
}

atomic_write() {
  try_atomic_write "$1" "$2" \
    || fail_plain "preview 运行元数据无法原子写入。"
}

record_failure() {
  local code="$1"
  local message="$2"
  atomic_write "${failure_file}" "${code}: ${message}"
  printf '[%s] %s\n' "${code}" "${message}" >&2
}

fail_preview() {
  record_failure "$1" "$2"
  exit 1
}

clear_failure() {
  rm -f -- "${failure_file}"
}

ensure_preview_worktree() {
  if [ ! -d "${preview_dir}" ]; then
    git -C "${repo_root}" worktree add --detach "${preview_dir}" HEAD \
      >/dev/null 2>&1 \
      || fail_preview "PREVIEW_WORKTREE_CREATE" "预览 worktree 创建失败。"
  fi
  [ ! -L "${preview_dir}" ] || fail_preview "PREVIEW_WORKTREE_IDENTITY" "预览 worktree 不得是符号链接。"
  preview_dir="$(realpath -- "${preview_dir}")"
  [ "$(git -C "${preview_dir}" rev-parse --show-toplevel)" = "${preview_dir}" ] \
    || fail_preview "PREVIEW_WORKTREE_IDENTITY" "预览 worktree 身份不合法。"
  local repository_common preview_common
  repository_common="$(realpath -- "$(git -C "${repo_root}" rev-parse --path-format=absolute --git-common-dir)")"
  preview_common="$(realpath -- "$(git -C "${preview_dir}" rev-parse --path-format=absolute --git-common-dir)")"
  [ "${preview_common}" = "${repository_common}" ] \
    || fail_preview "PREVIEW_WORKTREE_IDENTITY" "预览目录不属于当前仓库的同一 Git worktree 集合。"
  if path_contains "${preview_dir}" "${state_root}" || path_contains "${state_root}" "${preview_dir}"; then
    fail_preview "PREVIEW_STATE_PATH" "PREVIEW_STATE_DIR 必须位于预览 worktree 外。"
  fi
}

acquire_preview_lock() {
  if [ -e "${lock_file}" ] && { [ -L "${lock_file}" ] || [ ! -f "${lock_file}" ]; }; then
    fail_preview "PREVIEW_LOCK_IDENTITY" "preview 排他锁不是普通文件。"
  fi
  exec 9>>"${lock_file}"
  chmod 600 -- "${lock_file}"
  flock -n 9 || fail_preview "PREVIEW_LOCKED" "另一个 serve/restart 正在运行。"
}

validate_branch() {
  local branch="$1"
  [ -n "${branch}" ] || fail_preview "PREVIEW_BRANCH" "必须提供远端分支名。"
  [[ "${branch}" =~ ^[A-Za-z0-9._/-]+$ ]] \
    || fail_preview "PREVIEW_BRANCH" "分支名含本站不允许的字符。"
  git check-ref-format --branch "${branch}" >/dev/null 2>&1 \
    || fail_preview "PREVIEW_BRANCH" "分支名不符合 Git ref 格式。"
}

run_quietly() {
  local code="$1"
  local message="$2"
  shift 2
  local raw
  raw="$(mktemp --tmpdir="${run_dir}" ".operation.$$.XXXXXXXX.raw")" \
    || fail_preview "${code}" "${message}"
  chmod 600 -- "${raw}" \
    || { rm -f -- "${raw}" 2>/dev/null || true; fail_preview "${code}" "${message}"; }
  chmod 700 -- "${run_dir}"
  if "$@" >"${raw}" 2>&1; then
    rm -f -- "${raw}"
    atomic_write "${operation_log}" "${code}: success"
    return 0
  fi
  local stable
  stable="$(grep -E '^\[[A-Z0-9_]+\]' "${raw}" | tail -n 1 || true)"
  rm -f -- "${raw}"
  atomic_write "${operation_log}" "${code}: ${stable:-failed}"
  fail_preview "${code}" "${message}"
}

checkout_remote_branch() {
  local branch="$1"
  validate_branch "${branch}"
  atomic_write "${branch_file}" "${branch}"
  run_quietly \
    "PREVIEW_FETCH" \
    "远端分支获取失败，活动预览保持不变。" \
    git -C "${preview_dir}" fetch --no-tags origin \
      "+refs/heads/${branch}:refs/remotes/origin/${branch}"
  git -C "${preview_dir}" show-ref --verify --quiet "refs/remotes/origin/${branch}" \
    || fail_preview "PREVIEW_REMOTE_BRANCH" "origin 上不存在请求分支。"
  run_quietly \
    "PREVIEW_CHECKOUT" \
    "远端精确提交 detached checkout 失败，活动预览保持不变。" \
    git -C "${preview_dir}" checkout --detach "refs/remotes/origin/${branch}"
  checkout_sha="$(git -C "${preview_dir}" rev-parse --verify HEAD)"
  [[ "${checkout_sha}" =~ ^[0-9a-f]{40}$ ]] \
    || fail_preview "PREVIEW_CHECKOUT_SHA" "checkout HEAD 不是 40 位提交 SHA。"
  [ "$(git -C "${preview_dir}" rev-parse --verify "refs/remotes/origin/${branch}")" = "${checkout_sha}" ] \
    || fail_preview "PREVIEW_CHECKOUT_SHA" "checkout HEAD 与精确 origin ref 不一致。"
  [ -z "$(git -C "${preview_dir}" status --porcelain --untracked-files=normal)" ] \
    || fail_preview "PREVIEW_CHECKOUT_DIRTY" "预览 worktree 含 tracked 或未跟踪漂移，拒绝从非精确远端树构建。"
  atomic_write "${head_file}" "${checkout_sha}"
}

verify_dependencies() {
  run_quietly \
    "PREVIEW_DEPENDENCIES" \
    "Node/npm、manifest、lock 或本地冻结依赖证据不匹配；不会自动安装或修复。" \
    node "${preview_dir}/scripts/dev/preview-dependencies.mjs" verify
}

candidate_path=""
cleanup_candidate() {
  [ -n "${candidate_path}" ] || return 0
  [ "$(dirname -- "${candidate_path}")" = "${candidates_dir}" ] || return 0
  [[ "$(basename -- "${candidate_path}")" =~ ^[0-9a-f]{40}\.[1-9][0-9]*$ ]] || return 0
  if [ -d "${candidate_path}" ] && [ ! -L "${candidate_path}" ]; then
    rm -rf -- "${candidate_path}"
  fi
  rm -f -- "${candidate_file}"
}
trap cleanup_candidate EXIT

build_candidate() {
  candidate_path="${candidates_dir}/${checkout_sha}.$$"
  [ ! -e "${candidate_path}" ] \
    || fail_preview "PREVIEW_CANDIDATE_EXISTS" "本次提交与控制进程的候选路径已存在。"
  atomic_write "${candidate_file}" "${checkout_sha}"
  run_quietly \
    "PREVIEW_BUILD" \
    "preview build --dev 或独立制品检查失败，活动预览保持不变。" \
    env \
      PREVIEW_STATE_DIR="${state_root}" \
      AXIAL_MUSE_PREVIEW_CANDIDATE="${candidate_path}" \
      AXIAL_MUSE_PREVIEW_COMMIT_SHA="${checkout_sha}" \
      AXIAL_MUSE_PREVIEW_CONTROLLER_PID="$$" \
      AXIAL_MUSE_PREVIEW_ACCESS_HOST="${PREVIEW_HOST}" \
      AXIAL_MUSE_PREVIEW_ACCESS_PORT="${PORT}" \
      node "${preview_dir}/scripts/build/build-site.mjs" --mode preview
  [ -d "${candidate_path}" ] && [ ! -L "${candidate_path}" ] \
    || fail_preview "PREVIEW_CANDIDATE_IDENTITY" "已验收候选不是普通目录。"
  [ "$(realpath -- "${candidate_path}")" = "${candidate_path}" ] \
    || fail_preview "PREVIEW_CANDIDATE_IDENTITY" "已验收候选路径发生漂移。"
  [ "$(stat -c '%d' -- "${candidate_path}")" = "$(stat -c '%d' -- "${releases_dir}")" ] \
    || fail_preview "PREVIEW_CANDIDATE_DEVICE" "候选与 releases 不在同一文件系统。"
  [ "$(git -C "${preview_dir}" rev-parse --verify HEAD)" = "${checkout_sha}" ] \
    || fail_preview "PREVIEW_CHECKOUT_DRIFT" "候选通过后 worktree HEAD 已变化。"
}

release_target_for_sha() {
  printf 'releases/%s\n' "$1"
}

active_sha_from_current() {
  [ -L "${current_link}" ] || return 1
  local target
  target="$(readlink -- "${current_link}")"
  [[ "${target}" =~ ^releases/([0-9a-f]{40})$ ]] || return 1
  local sha="${BASH_REMATCH[1]}"
  local release="${state_root}/${target}"
  [ -d "${release}" ] && [ ! -L "${release}" ] || return 1
  [ "$(realpath -- "${release}")" = "${releases_dir}/${sha}" ] || return 1
  printf '%s\n' "${sha}"
}

publish_candidate() {
  local release="${releases_dir}/${checkout_sha}"
  [ ! -e "${release}" ] \
    || fail_preview "PREVIEW_RELEASE_EXISTS" "相同提交的不可变 release 已存在但未处于可复用路径。"
  mv -- "${candidate_path}" "${release}" >/dev/null 2>&1 \
    || fail_preview "PREVIEW_RELEASE_MOVE" "已验收候选无法原子移动到 release。"
  candidate_path=""
  rm -f -- "${candidate_file}"
  find -P "${release}" -type f -exec chmod 400 -- {} + >/dev/null 2>&1 \
    && find -P "${release}" -type d -exec chmod 500 -- {} + >/dev/null 2>&1 \
    || fail_preview "PREVIEW_RELEASE_PERMISSION" "release 无法固定为只读目录；尚未切换 current。"
}

remove_inactive_release() {
  local release="$1"
  local name
  name="$(basename -- "${release}")"
  [ "$(dirname -- "${release}")" = "${releases_dir}" ] \
    && [[ "${name}" =~ ^[0-9a-f]{40}$ ]] \
    || fail_preview "PREVIEW_RELEASE_IDENTITY" "待替换 release 不属于受控 releases 根。"
  [ -d "${release}" ] && [ ! -L "${release}" ] \
    && [ "$(realpath -- "${release}")" = "${release}" ] \
    || fail_preview "PREVIEW_RELEASE_IDENTITY" "待替换 release 不是规范普通目录。"
  find -P "${release}" -type d -exec chmod 700 -- {} + \
    && find -P "${release}" -type f -exec chmod 600 -- {} + \
    && rm -rf -- "${release}" \
    || fail_preview "PREVIEW_RELEASE_REPLACE" "既有非活动 release 无法安全替换，活动预览保持不变。"
}

atomic_switch_current() {
  local sha="$1"
  local temporary="${state_root}/.current.$$.$RANDOM.tmp"
  [ ! -e "${temporary}" ] && [ ! -L "${temporary}" ] \
    || fail_preview "PREVIEW_CURRENT_TEMP" "current 临时链接路径已存在。"
  ln -s -- "$(release_target_for_sha "${sha}")" "${temporary}" 2>/dev/null \
    || fail_preview "PREVIEW_CURRENT_TEMP" "current 临时链接无法创建。"
  if ! mv -Tf -- "${temporary}" "${current_link}" 2>/dev/null; then
    rm -f -- "${temporary}" 2>/dev/null || true
    fail_preview "PREVIEW_CURRENT_SWITCH" "current 无法原子切换，原活动链接保持不变。"
  fi
}

pid_is_our_server() {
  local pid="$1"
  [[ "${pid}" =~ ^[1-9][0-9]*$ ]] || return 1
  [ -d "/proc/${pid}" ] || return 1
  [ "$(stat -c '%u' -- "/proc/${pid}")" = "$(id -u)" ] || return 1
  [ "$(realpath -- "/proc/${pid}/cwd" 2>/dev/null || true)" = "${state_root}" ] || return 1
  local arguments
  arguments="$(tr '\0' '\n' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
  grep -Fxq -- "http.server" <<<"${arguments}" || return 1
  grep -Fxq -- "current" <<<"${arguments}" || return 1
  grep -Fxq -- "${PORT}" <<<"${arguments}" || return 1
  return 0
}

process_is_live() {
  local pid="$1"
  [[ "${pid}" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "${pid}" 2>/dev/null || return 1
  local state
  state="$(awk '/^State:/ {print $2}' "/proc/${pid}/status" 2>/dev/null || true)"
  [ -n "${state}" ] && [ "${state}" != "Z" ] && [ "${state}" != "X" ]
}

assert_server_state_safe() {
  if [ ! -e "${pid_file}" ] && [ ! -L "${pid_file}" ]; then
    return 0
  fi
  [ -f "${pid_file}" ] && [ ! -L "${pid_file}" ] \
    || fail_preview "PREVIEW_PID_IDENTITY" "PID 文件不是普通文件。"
  local pid
  pid="$(tr -d '\r\n' < "${pid_file}")"
  [[ "${pid}" =~ ^[1-9][0-9]*$ ]] \
    || fail_preview "PREVIEW_PID_IDENTITY" "PID 文件内容不合法。"
  if ! process_is_live "${pid}"; then
    rm -f -- "${pid_file}"
    return 0
  fi
  pid_is_our_server "${pid}" \
    || fail_preview "PREVIEW_PID_OWNERSHIP" "PID 指向非本站服务；不会覆盖或停止该进程。"
}

terminate_owned_server() {
  local pid="$1"
  process_is_live "${pid}" || return 0
  pid_is_our_server "${pid}" || return 1
  kill -TERM "${pid}" || return 1
  for _ in $(seq 1 20); do
    process_is_live "${pid}" || return 0
    pid_is_our_server "${pid}" || return 1
    sleep 0.2
  done
  process_is_live "${pid}" || return 0
  pid_is_our_server "${pid}" || return 1
  kill -KILL "${pid}" || return 1
  for _ in $(seq 1 10); do
    process_is_live "${pid}" || return 0
    sleep 0.1
  done
  return 1
}

is_running() {
  [ -f "${pid_file}" ] && [ ! -L "${pid_file}" ] || return 1
  local pid
  pid="$(tr -d '\r\n' < "${pid_file}")"
  process_is_live "${pid}" || return 1
  pid_is_our_server "${pid}"
}

port_listener_pid() {
  ss -tlnp "( sport = :${PORT} )" 2>/dev/null \
    | grep -oP 'pid=\K[0-9]+' \
    | head -n 1 \
    || true
}

start_server() {
  local listener
  listener="$(port_listener_pid)"
  if [ -n "${listener}" ]; then
    fail_preview "PREVIEW_PORT_OWNERSHIP" "端口已被进程占用；不会接管或停止该进程。"
  fi
  [ -L "${current_link}" ] && active_sha_from_current >/dev/null \
    || fail_preview "PREVIEW_CURRENT" "只有有效 current release 才能启动静态服务器。"
  if [ -e "${server_log}" ] || [ -L "${server_log}" ]; then
    [ -f "${server_log}" ] && [ ! -L "${server_log}" ] \
      || fail_preview "PREVIEW_SERVER_LOG" "服务日志目标不是普通文件。"
  fi
  (
    cd "${state_root}"
    exec 9>&-
    exec nohup python3 -m http.server \
      --bind 0.0.0.0 --directory current "${PORT}"
  ) >"${server_log}" 2>&1 < /dev/null &
  local spawned_pid="$!"
  chmod 600 -- "${server_log}" 2>/dev/null || true
  local real_pid=""
  for _ in $(seq 1 30); do
    listener="$(port_listener_pid)"
    if [ "${listener}" = "${spawned_pid}" ] && pid_is_our_server "${spawned_pid}"; then
      real_pid="${spawned_pid}"
      break
    fi
    process_is_live "${spawned_pid}" || break
    sleep 0.2
  done
  if [ -z "${real_pid}" ]; then
    if process_is_live "${spawned_pid}"; then
      terminate_owned_server "${spawned_pid}" \
        || fail_preview "PREVIEW_SERVER_OWNERSHIP" "启动失败后无法确认或停止本次服务进程。"
    fi
    fail_preview "PREVIEW_SERVER_START" "静态服务器未能取得端口或确认进程所有权。"
  fi
  if ! try_atomic_write "${pid_file}" "${real_pid}"; then
    terminate_owned_server "${real_pid}" \
      || fail_preview "PREVIEW_SERVER_OWNERSHIP" "PID 写入失败后无法确认或停止本次服务进程。"
    fail_preview "PREVIEW_PID_WRITE" "静态服务器已停止，因为 PID 所有权证据无法原子写入。"
  fi
}

stop_server() {
  assert_server_state_safe
  [ -e "${pid_file}" ] || return 0
  local pid
  pid="$(tr -d '\r\n' < "${pid_file}")"
  if ! process_is_live "${pid}"; then
    rm -f -- "${pid_file}"
    return 0
  fi
  pid_is_our_server "${pid}" \
    || fail_preview "PREVIEW_PID_OWNERSHIP" "PID 指向非本站服务；不会停止该进程。"
  terminate_owned_server "${pid}" \
    || fail_preview "PREVIEW_SERVER_STOP" "服务 PID 漂移或本站服务未能确认停止，PID 证据保持不变。"
  rm -f -- "${pid_file}"
}

smoke_current() {
  PREVIEW_SMOKE_PORT="${PORT}" python3 -c '
import http.client, os
connection = http.client.HTTPConnection("127.0.0.1", int(os.environ["PREVIEW_SMOKE_PORT"]), timeout=5)
connection.request("GET", "/")
response = connection.getresponse()
response.read(1024)
connection.close()
raise SystemExit(0 if response.status == 200 else 1)
' >/dev/null 2>&1
}

cleanup_old_releases() {
  local active_sha="$1"
  local previous_sha="$2"
  local entry
  for entry in "${releases_dir}"/*; do
    [ -e "${entry}" ] || continue
    [ -d "${entry}" ] && [ ! -L "${entry}" ] || {
      echo "警告：发现非普通 release 成员，未自动清理。" >&2
      continue
    }
    local name
    name="$(basename -- "${entry}")"
    [[ "${name}" =~ ^[0-9a-f]{40}$ ]] || {
      echo "警告：发现名称不合法的 release，未自动清理。" >&2
      continue
    }
    if [ "${name}" = "${active_sha}" ] || { [ -n "${previous_sha}" ] && [ "${name}" = "${previous_sha}" ]; }; then
      continue
    fi
    if ! find -P "${entry}" -type d -exec chmod 700 -- {} + \
      || ! find -P "${entry}" -type f -exec chmod 600 -- {} + \
      || ! rm -rf -- "${entry}"; then
      echo "警告：更旧 release 清理失败；成功切换不会反转。" >&2
    fi
  done
}

activate_branch() {
  local branch="$1"
  local require_stopped="$2"
  clear_failure
  assert_server_state_safe
  if [ "${require_stopped}" = "true" ] && is_running; then
    fail_preview "PREVIEW_ALREADY_RUNNING" "serve 只用于首次启动；服务已运行时请使用 restart。"
  fi
  checkout_remote_branch "${branch}"
  verify_dependencies

  local previous_sha=""
  if [ -e "${current_link}" ] || [ -L "${current_link}" ]; then
    previous_sha="$(active_sha_from_current)" \
      || fail_preview "PREVIEW_CURRENT_IDENTITY" "current 不是指向本站不可变 release 的受控链接。"
  fi
  local release="${releases_dir}/${checkout_sha}"
  if [ -e "${release}" ]; then
    [ -d "${release}" ] && [ ! -L "${release}" ] \
      || fail_preview "PREVIEW_RELEASE_IDENTITY" "既有 release 不是普通目录。"
    [ "$(realpath -- "${release}")" = "${release}" ] \
      || fail_preview "PREVIEW_RELEASE_IDENTITY" "既有 release 路径发生漂移。"
  fi
  if [ "${previous_sha}" != "${checkout_sha}" ]; then
    build_candidate
    if [ -e "${release}" ]; then
      remove_inactive_release "${release}"
    fi
    publish_candidate
  fi

  local server_was_running="false"
  if is_running; then
    server_was_running="true"
  fi
  local started_now="false"
  if [ "${server_was_running}" = "false" ] \
    && [ -n "${previous_sha}" ] \
    && [ "${previous_sha}" != "${checkout_sha}" ]; then
    if ! (start_server); then
      exit 1
    fi
    started_now="true"
  fi
  if [ "${previous_sha}" != "${checkout_sha}" ]; then
    if ! (atomic_switch_current "${checkout_sha}"); then
      if [ "${started_now}" = "true" ]; then
        stop_server || true
      fi
      exit 1
    fi
  fi
  if ! is_running; then
    if ! (start_server); then
      if [ -n "${previous_sha}" ] && [ "${previous_sha}" != "${checkout_sha}" ]; then
        (atomic_switch_current "${previous_sha}") || exit 1
      elif [ -z "${previous_sha}" ]; then
        rm -f -- "${current_link}"
      fi
      exit 1
    fi
    started_now="true"
  fi
  if ! smoke_current; then
    local rollback_failed="false"
    if [ -n "${previous_sha}" ] && [ "${previous_sha}" != "${checkout_sha}" ]; then
      if ! (atomic_switch_current "${previous_sha}"); then
        rollback_failed="true"
      fi
    elif [ -z "${previous_sha}" ]; then
      rm -f -- "${current_link}"
    fi
    if [ "${started_now}" = "true" ]; then
      stop_server || true
    fi
    [ "${rollback_failed}" = "false" ] || exit 1
    fail_preview "PREVIEW_SMOKE" "切换后 localhost HTTP 冒烟失败，已恢复上一 current；本次新启的服务已停止。"
  fi
  cleanup_old_releases "${checkout_sha}" "${previous_sha}"
  echo "preview active: branch=${branch} checkout=${checkout_sha} artifact=${checkout_sha} mode=preview pid=$(cat "${pid_file}") url=http://${PREVIEW_HOST}:${PORT}/"
}

status_preview() {
  local requested="未记录"
  local checkout="不可用"
  local active="未激活"
  local pid="未运行"
  local failure="无"
  [ -f "${branch_file}" ] && requested="$(tr -d '\r\n' < "${branch_file}")"
  if [ -d "${preview_dir}" ] && [ ! -L "${preview_dir}" ]; then
    checkout="$(git -C "${preview_dir}" rev-parse --verify HEAD 2>/dev/null || printf '不可用')"
  fi
  if [ -e "${current_link}" ] || [ -L "${current_link}" ]; then
    active="$(active_sha_from_current)" \
      || fail_plain "current 状态损坏，无法安全报告活动制品。"
  fi
  if is_running; then
    pid="$(tr -d '\r\n' < "${pid_file}")"
  fi
  [ -f "${failure_file}" ] && failure="$(tr -d '\r\n' < "${failure_file}")"
  echo "requested_branch=${requested}"
  echo "worktree_head=${checkout}"
  echo "active_artifact_sha=${active}"
  echo "mode=preview"
  echo "pid=${pid}"
  echo "url=http://${PREVIEW_HOST}:${PORT}/"
  echo "recent_failure=${failure}"
}

cmd="${1:-}"
case "${cmd}" in
  start|serve)
    [ "$#" -eq 2 ] || usage
    ensure_state_root
    acquire_preview_lock
    ensure_preview_worktree
    activate_branch "$2" "true"
    ;;
  restart)
    [ "$#" -le 2 ] || usage
    ensure_state_root
    acquire_preview_lock
    ensure_preview_worktree
    branch="${2:-}"
    if [ -z "${branch}" ]; then
      [ -f "${branch_file}" ] && [ ! -L "${branch_file}" ] \
        || fail_preview "PREVIEW_BRANCH" "没有历史请求分支，请显式传入分支名。"
      branch="$(tr -d '\r\n' < "${branch_file}")"
    fi
    activate_branch "${branch}" "false"
    ;;
  stop)
    [ "$#" -eq 1 ] || usage
    ensure_state_root
    acquire_preview_lock
    stop_server
    echo "preview stopped; current release preserved"
    ;;
  status)
    [ "$#" -eq 1 ] || usage
    ensure_state_root
    status_preview
    ;;
  *)
    usage
    ;;
esac

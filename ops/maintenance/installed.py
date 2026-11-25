"""固定的本机维护入口候选；不安装、不重启、不自动退役 release。"""

import contextlib
import grp
import fcntl
import os
import pwd
import subprocess
import sys
from pathlib import Path

from ops.deploy.deployment_state import (
    DeploymentError, DeploymentState, canonical, check_directory, decode, digest, read_file, require, sync_directory,
)
from ops.deploy.release_commands import SITE, STATE, load_verifier, verifier_lock
from ops.deploy.release_install import ReleaseStore
from ops.maintenance.ledger_backup import LedgerBackups
from ops.maintenance.local_state import JOBS, LocalMaintenanceState, safe_code
from ops.maintenance.log_retention import LogArchiveRetention
from ops.maintenance.resources import check_resources
from ops.monitor.bounded_process import ProcessOutputLimit, inherited_lock_fds, retain_locks, run_process


LIB = Path(__file__).resolve().parents[2]
TEMPLATES = LIB / "ops/maintenance/templates"
BACKUPS = Path("/var/backups/axialmuse-ledger")
ENV = {"PATH": "/usr/sbin:/usr/bin:/bin", "LANG": "C"}
LOGROTATE_STATE = Path("/var/lib/logrotate/status")


def run_job(name, *, command=run_process):
    require(name in (*JOBS, "weekly-backup"), "MAINTENANCE_JOBS")
    program = (f"import sys; sys.path.insert(0, {str(LIB)!r}); "
               "from ops.maintenance.installed import worker; "
               "from ops.monitor.bounded_process import retain_locks\n"
               f"with retain_locks({inherited_lock_fds()!r}):\n"
               f" raise SystemExit(worker('{name}'))")
    try:
        result = command(["/usr/bin/python3", "-I", "-B", "-c", program],
                         timeout=120, output_limit=65536, env=ENV)
    except subprocess.TimeoutExpired:
        raise DeploymentError("MAINTENANCE_JOB_TIMEOUT") from None
    except ProcessOutputLimit:
        raise DeploymentError("MAINTENANCE_JOB_OUTPUT") from None
    require(result.returncode in (0, 1), "MAINTENANCE_WORKER_FAILED")
    value = decode(result.stdout)
    require(isinstance(value, dict), "MAINTENANCE_WORKER_RESULT")
    allowed = {"schema", "status", "code"}
    if name == "weekly-backup" and value.get("status") == "ok":
        allowed |= {"snapshot", "snapshotSha256"}
    require(set(value) == allowed and value["schema"] == 1
            and (result.returncode == 0) == (value["status"] == "ok"), "MAINTENANCE_WORKER_RESULT")
    return {key: item for key, item in value.items() if key != "schema"}


def command_ok(arguments, code):
    try:
        result = run_process(arguments, timeout=60, output_limit=65536, env=ENV)
    except subprocess.TimeoutExpired:
        raise DeploymentError(code + "_TIMEOUT") from None
    except ProcessOutputLimit:
        raise DeploymentError(code + "_OUTPUT") from None
    require(result.returncode == 0, code)


def check_log_configuration(store):
    for template, actual in (
        ("nginx.logrotate", "/etc/logrotate.d/nginx"),
        ("rsyslog.logrotate", "/etc/logrotate.d/rsyslog"),
        ("journald-retention.conf", "/etc/systemd/journald.conf.d/axialmuse-retention.conf"),
    ):
        require(read_file(TEMPLATES / template, 0, mode=0o644) == read_file(actual, 0, mode=0o644),
                "MAINTENANCE_LOG_CONFIG")
    effective = run_process(["/usr/bin/systemd-analyze", "cat-config", "systemd/journald.conf"],
                            timeout=15, output_limit=65536, env=ENV)
    require(effective.returncode == 0, "MAINTENANCE_JOURNAL_CONFIG")
    section = None
    settings = {}
    for line in effective.stdout.decode("utf-8").splitlines():
        line = line.strip()
        if line.startswith("["):
            section = line
        elif section == "[Journal]" and line and not line.startswith(("#", ";")) and "=" in line:
            key, value = line.split("=", 1)
            settings[key.strip()] = value.strip()
    require(settings.get("MaxRetentionSec") == "27day" and settings.get("MaxFileSec") == "1day",
            "MAINTENANCE_JOURNAL_CONFIG")
    from ops.deploy.public_activation import PublicNginx, load_public_mode
    from ops.deploy.public_site import PUBLIC_CONFIG
    from ops.deploy.nginx_activation import local_site_config
    with store.state.locked(retirement_aware=True):
        store.state.assert_idle()
        sha = store.current()
        mode = load_public_mode(store.state)
        require(sha is not None and mode is not None, "MAINTENANCE_PUBLIC_MODE")
        # 校验完整已认证配置，而非搜索 access_log off 子串。
        require(read_file(PUBLIC_CONFIG, 0, mode=0o644) == PublicNginx(store, mode=mode).render(sha),
                "MAINTENANCE_PUBLIC_CONFIG")
        require(read_file(Path("/etc/nginx/conf.d/axialmuse-local.conf"), 0, mode=0o644)
                == local_site_config(store.site), "MAINTENANCE_LOCAL_CONFIG")


@contextlib.contextmanager
def logrotate_lock():
    descriptor = os.open(LOGROTATE_STATE, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        held, live = os.fstat(descriptor), LOGROTATE_STATE.lstat()
        require((held.st_dev, held.st_ino) == (live.st_dev, live.st_ino), "MAINTENANCE_LOGROTATE_LOCK")
        with retain_locks((descriptor,)):
            yield
    finally:
        os.close(descriptor)


def logs_job(store):
    check_log_configuration(store)
    adm = grp.getgrnam("adm").gr_gid
    web = pwd.getpwnam("www-data").pw_uid
    syslog = pwd.getpwnam("syslog").pw_uid
    policies = [(Path("/var/log/nginx") / name, web, adm, 4) for name in ("access.log", "error.log")]
    for name in ("syslog", "mail.log", "kern.log", "auth.log", "user.log", "cron.log"):
        active = Path("/var/log") / name
        if os.path.lexists(active) or name in ("syslog", "auth.log") or list(active.parent.glob(name + ".*")):
            policies.append((active, syslog, adm, 27))
    engine = LogArchiveRetention(policies, quarantine=STATE / "log-retention",
                                 writable_group=grp.getgrnam("syslog").gr_gid)
    with logrotate_lock():
        engine.plan()  # 未知对象/权限/时间异常在轮转前暴露。
        engine.recover_pending()  # 未到期的待处理文件也必须先解除源路径绑定。
    command_ok(["/usr/sbin/logrotate", "--force", "--state", str(LOGROTATE_STATE),
                "/etc/logrotate.d/nginx", "/etc/logrotate.d/rsyslog"], "MAINTENANCE_LOGROTATE_FAILED")
    # 系统 logrotate timer 也使用此状态文件的 flock；排除重命名归档的并发。
    with logrotate_lock():
        engine.execute(engine.plan())
    command_ok(["/usr/bin/journalctl", "--rotate"], "MAINTENANCE_JOURNAL_ROTATE")
    command_ok(["/usr/bin/journalctl", "--vacuum-time=27d"], "MAINTENANCE_JOURNAL_VACUUM")


def worker(name):
    try:
        require(os.geteuid() == 0 and name in (*JOBS, "weekly-backup"), "MAINTENANCE_CONTEXT")
        if name == "resources":
            result = check_resources()
            failures = sorted((c for c in result["checks"] if c["level"] != "ok"),
                              key=lambda c: c["level"] != "critical")
            value = {"status": result["status"], "code": failures[0]["code"] if failures else "OK"}
        else:
            state = DeploymentState(STATE)
            if name == "backup":
                from ops.maintenance.weekly_backup import assert_weekly_healthy
                assert_weekly_healthy(state, BACKUPS, force=True)
            elif name == "weekly-backup":
                backups = LedgerBackups(state, BACKUPS)
                snapshot = backups.create()
                backups.prune(snapshot)
                backups.verify(snapshot)
                value = {"status": "ok", "code": "OK", "snapshot": snapshot.name,
                         "snapshotSha256": digest(read_file(snapshot / "backup.json", state.uid, mode=0o600,
                                                            limit=64 * 1024 * 1024))}
            else:
                logs_job(ReleaseStore(SITE, state, load_verifier()))
            if name != "weekly-backup":
                value = {"status": "ok", "code": "OK"}
    except Exception as error:
        value = {"status": "failed", "code": safe_code(error)}
    sys.stdout.buffer.write(canonical({"schema": 1, **value}))
    return 0 if value["status"] == "ok" else 1


def main():
    try:
        require(os.geteuid() == 0 and not sys.argv[1:], "MAINTENANCE_CONTEXT")
        # 子进程继承同一内核锁，不重入 flock；父进程死亡不解除后代的保护。
        state = LocalMaintenanceState(STATE / "maintenance")
        result = state.execute({name: lambda name=name: run_job(name) for name in JOBS}, guard=verifier_lock)
        print(canonical(result).decode(), end="")
        return 0 if result["status"] == "ok" else 1
    except Exception as error:
        print(f"[{safe_code(error)}] 本机维护失败，保留原始状态。", file=sys.stderr)
        return 1


def manage():
    try:
        require(os.geteuid() == 0, "MAINTENANCE_CONTEXT")
        arguments = sys.argv[1:]
        require(arguments in (["--initialize"], ["--enable"])
                or len(arguments) == 2 and arguments[0] == "--ack", "MAINTENANCE_ARGUMENTS")
        with verifier_lock():
            local = LocalMaintenanceState(STATE / "maintenance")
            if arguments == ["--initialize"]:
                # 已完整发布的前序步骤只核验；中断的准备树由原初始化入口续跑。
                from ops.maintenance.weekly_backup import assert_weekly_healthy
                assert_weekly_healthy(DeploymentState(STATE), BACKUPS, force=True)
                if os.path.lexists(local.root):
                    local.check()
                else:
                    local.initialize()
                quarantine = STATE / "log-retention"
                if not os.path.lexists(quarantine):
                    quarantine.mkdir(mode=0o700)
                check_directory(quarantine, 0, 0o700)
                sync_directory(STATE)
            elif arguments == ["--enable"]:
                local.enable()
            else:
                local.acknowledge(arguments[1])
        return 0
    except Exception as error:
        print(f"[{safe_code(error)}] 维护状态操作失败。", file=sys.stderr)
        return 1

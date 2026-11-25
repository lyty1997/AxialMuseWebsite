"""每周账本备份固定入口与只读健康核验；不触发每日日志维护。"""

import os
import sys

from ops.deploy.deployment_state import DeploymentState, canonical, digest, read_file, require
from ops.deploy.release_commands import STATE, verifier_lock
from ops.maintenance.ledger_backup import LedgerBackups
from ops.maintenance.local_state import WeeklyBackupState, safe_code


def assert_weekly_healthy(state, backups, *, force=False, required=False):
    local = WeeklyBackupState(state.home / "ledger-backup-maintenance", state.uid)
    if not force and not required and not os.path.lexists(local.root) and not os.path.lexists(backups):
        return  # 未安装的旧版本仍可监测；任一已安装根缺失则失败。
    require(os.path.lexists(local.root), "MAINTENANCE_BACKUP_STATE_MISSING")
    local.assert_healthy(force=force)
    require(os.path.lexists(backups), "MAINTENANCE_BACKUP_ROOT_MISSING")
    engine = LedgerBackups(state, backups)
    engine.check()
    # 未启用时只核验布局，不能把准备中的安装强行解释为已开始例行备份。
    if force or os.path.lexists(local.root / "enabled"):
        snapshots = engine.snapshots()
        require(snapshots, "MAINTENANCE_BACKUP_MISSING")
        success = local.fresh_success(local.records())
        binding = success["result"]["checks"][1]
        matched = [(path, created) for path, created in snapshots if path.name == binding["snapshot"]]
        require(len(matched) == 1 and success["request"]["started"] <= matched[0][1] <= success["result"]["finished"]
                and digest(read_file(matched[0][0] / "backup.json", state.uid, mode=0o600,
                                     limit=64 * 1024 * 1024)) == binding["snapshotSha256"],
                "MAINTENANCE_BACKUP_RUN_MISSING")
        latest = max(created for _, created in snapshots)
        require(0 <= local.clock() - latest <= local.max_age, "MAINTENANCE_BACKUP_STALE")


def main():
    try:
        require(os.geteuid() == 0 and not sys.argv[1:], "MAINTENANCE_CONTEXT")
        from ops.maintenance.installed import run_job
        local = WeeklyBackupState(STATE / "ledger-backup-maintenance")
        result = local.execute({"resources": lambda: run_job("resources"),
                                "backup": lambda: run_job("weekly-backup")}, guard=verifier_lock)
        print(canonical(result).decode(), end="")
        return 0 if result["status"] == "ok" else 1
    except Exception as error:
        print(f"[{safe_code(error)}] 每周账本备份失败，保留原始状态。", file=sys.stderr)
        return 1


def manage():
    try:
        require(os.geteuid() == 0, "MAINTENANCE_CONTEXT")
        arguments = sys.argv[1:]
        require(arguments in (["--initialize"], ["--enable"])
                or len(arguments) == 2 and arguments[0] == "--ack", "MAINTENANCE_ARGUMENTS")
        from ops.maintenance.installed import BACKUPS
        with verifier_lock():
            state = DeploymentState(STATE)
            local = WeeklyBackupState(STATE / "ledger-backup-maintenance")
            if arguments == ["--initialize"]:
                engine = LedgerBackups(state, BACKUPS)
                if os.path.lexists(BACKUPS):
                    engine.check()
                else:
                    engine.initialize()
                if os.path.lexists(local.root):
                    local.check()
                else:
                    local.initialize()
            elif arguments == ["--enable"]:
                LedgerBackups(state, BACKUPS).check()
                if not os.path.lexists(local.root / "activation.json"):
                    assert_weekly_healthy(state, BACKUPS, force=True)
                # 已发布的启用授权必须可续完；期间新失败由健康门禁继续阻断。
                local.enable()
            else:
                local.acknowledge(arguments[1])
        return 0
    except Exception as error:
        print(f"[{safe_code(error)}] 每周备份状态操作失败。", file=sys.stderr)
        return 1

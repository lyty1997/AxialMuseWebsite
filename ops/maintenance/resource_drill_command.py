"""root 管理演练入口；不授予监测用户管理权限，不执行云调用。"""

import argparse
import os
import re
import sys

from ops.deploy.deployment_state import DeploymentError, DeploymentState, canonical, require
from ops.deploy.release_commands import SITE, STATE, load_verifier, verifier_lock
from ops.deploy.release_install import ReleaseStore
from ops.maintenance.resource_drill import ResourceDrills
from ops.monitor.server_evidence import release_bundle


def runtime_identity():
    guard = sys.modules.get("_axialmuse_runtime")
    require(guard is not None, "MONITOR_DRILL_RUNTIME")
    guard.check_lock()
    require(re.fullmatch(r"[0-9a-f]{64}", guard.root.name), "MONITOR_DRILL_RUNTIME")
    return guard.root.name


def installed_observation(bundle):
    try:
        return ResourceDrills(STATE / "resource-drills").observe(bundle, runtime_identity())
    except Exception as error:
        if isinstance(error, DeploymentError) and str(error) in ("MONITOR_DRILL_FIXTURE", "MONITOR_DRILL_RUNTIME"):
            raise
        raise DeploymentError("MONITOR_DRILL_STATE") from None


def main(arguments=None):
    parser = argparse.ArgumentParser(description="管理有限期资源告警演练。", allow_abbrev=False)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--arm", action="store_true")
    action.add_argument("--status", action="store_true")
    action.add_argument("--disarm")
    parser.add_argument("--scenario")
    parser.add_argument("--ttl-seconds", type=int, default=1800)
    parser.add_argument("--authorization-id")
    args = parser.parse_args(arguments)
    try:
        require(os.geteuid() == 0, "MONITOR_DRILL_CONTEXT")
        require(args.arm or (args.scenario is None and args.authorization_id is None
                            and args.ttl_seconds == 1800), "MONITOR_DRILL_ARGUMENTS")
        with verifier_lock():
            state = DeploymentState(STATE)
            drills = ResourceDrills(STATE / "resource-drills")
            if args.arm:
                store = ReleaseStore(SITE, state, load_verifier())
                # 健康前态与请求发布必须在同一部署锁内；生命周期锁已由稳定入口持有。
                result = release_bundle(store, drill=lambda bundle: drills.arm(
                    args.scenario, args.ttl_seconds, args.authorization_id, {
                        "runtimeSha256": runtime_identity(), "siteIdentity": bundle["snapshot"]["identity"],
                        "ledgerSha256": bundle["snapshot"]["ledgerSha256"]}))
            else:
                with state.locked(retirement_aware=True):
                    # 停用不依赖真实资源、release 或维护状态健康。
                    result = drills.status() if args.status else drills.disarm(args.disarm)
            sys.stdout.buffer.write(canonical(result))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, DeploymentError) and re.fullmatch(
            r"(?:MONITOR|DEPLOY)_[A-Z0-9_]{1,90}", str(error)) else "MONITOR_DRILL_STATE"
        print(f"[{code}] 演练控制失败，保留状态。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

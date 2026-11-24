"""固定 root-only 入口；由受限本机身份通过精确 sudo 规则调用。"""

import sys
from pathlib import Path

from ops.deploy.deployment_state import DeploymentError, DeploymentState
from ops.deploy.release_commands import load_verifier, verifier_lock
from ops.deploy.release_install import ReleaseStore
from ops.monitor.public_health import canonical
from ops.monitor.server_evidence import release_bundle
from ops.maintenance.local_state import safe_code
from ops.maintenance.resources import RESOURCE_FAILURE_CODES
from ops.maintenance.resource_drill_command import installed_observation


def main():
    if sys.argv[1:]:
        return 2
    try:
        state = DeploymentState(Path("/var/lib/axialmuse"))
        with verifier_lock():
            store = ReleaseStore(Path("/srv/axialmuse"), state, load_verifier())
            output = canonical(release_bundle(store, drill=installed_observation))
        if len(output) > 16 * 1024:
            return 1
        sys.stdout.buffer.write(output)
        return 0
    except Exception as error:
        if isinstance(error, DeploymentError):
            if str(error) in RESOURCE_FAILURE_CODES:
                # TAT 的成功传输只承载诊断；客户端必须将此封套转为非零检查。
                sys.stdout.buffer.write(canonical({"schema": 1, "resourceFailure": str(error)}))
                return 0
            code = str(error) if str(error) in ("MONITOR_DRILL_STATE", "MONITOR_DRILL_FIXTURE", "MONITOR_DRILL_RUNTIME") else safe_code(error)
            print(f"[{code}] 只读维护证据失败。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

"""固定退役入口；调用方先持 verifier 生命周期锁，不接受任意计划路径。"""

import os
import re

from ops.deploy.deployment_state import canonical, check_directory, decode, read_file, require, sync_directory, write_new
from ops.deploy.nginx_activation import LocalNginx
from ops.deploy.release_install import sha_valid
from ops.deploy.release_retirement import ReleaseRetirement, initialize_retirements
from ops.deploy.retirement_references import RetirementReferences


def parse_retirement(arguments):
    if arguments == ["--initialize"]:
        return
    require(len(arguments) == 4 and arguments[0] in ("--plan", "--execute")
            and arguments[2] == "--authorization-id", "DEPLOY_ARGUMENTS")
    sha_valid(arguments[1])
    require(re.fullmatch(r"[0-9a-f]{32}", arguments[3]), "DEPLOY_ARGUMENTS")


def retire_command(store, arguments):
    parse_retirement(arguments)
    state = store.state
    plans = state.root / "retirement-plans"
    if arguments == ["--initialize"]:
        with state.locked(retirement_aware=True):
            state.assert_idle()
            state.read_ledger()
            if not plans.exists():
                plans.mkdir(mode=0o700)
                sync_directory(state.root)
            check_directory(plans, state.uid, 0o700)
            require(not os.listdir(plans), "DEPLOY_RETIREMENT_LAYOUT")
            initialize_retirements(state)
        return {"status": "retirement-enabled", "deletedCount": 0}
    authorization_id = arguments[3]
    check_directory(plans, state.uid, 0o700)
    path = plans / f"{authorization_id}.json"
    # release_commands 已持有同一生命周期锁；此处不重复 flock。
    import contextlib
    engine = ReleaseRetirement(store, lifecycle_lock=contextlib.nullcontext,
                               reference_probe=RetirementReferences(store, LocalNginx(store)))
    if arguments[0] == "--plan":
        plan = engine.plan(arguments[1], authorization_id)
        write_new(path, canonical(plan))
        return {"status": "planned", "plan": plan, "deletedCount": 0}
    plan = decode(read_file(path, state.uid, mode=0o600))
    require(plan.get("sha") == arguments[1] and plan.get("authorizationId") == authorization_id,
            "DEPLOY_RETIREMENT_PLAN")
    return engine.execute(plan)

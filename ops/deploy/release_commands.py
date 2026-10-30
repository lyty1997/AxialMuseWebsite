#!/usr/bin/python3 -I
"""固定部署与 SSH 维护入口；运行路径和本机监听不可由 TAT 参数指定。"""

import contextlib
import fcntl
import importlib.util
import os
import signal
import sys
from pathlib import Path

sys.dont_write_bytecode = True
# verifier 保持独占闭合命名空间；发布组件使用同级独立根。
sys.path.insert(0, "/usr/local/lib/axialmuse-release")

from ops.deploy.deployment_state import (  # noqa: E402
    DeploymentError, DeploymentState, canonical, check_directory, identity_valid,
    read_file, require, sync_directory,
)
from ops.deploy.nginx_activation import LocalNginx  # noqa: E402
from ops.deploy.release_install import ReleaseStore, sha_valid  # noqa: E402
from ops.deploy.release_transaction import ReleaseTransaction  # noqa: E402


SITE = Path("/srv/axialmuse")
STATE = Path("/var/lib/axialmuse")
LIB = Path("/usr/local/lib")
VERIFIER = LIB / "axialmuse/artifact-verifier/verify_artifact.py"
LOCK = LIB / ".axialmuse-artifact-verifier-bootstrap.lock"
FLAGS = ("--workflow-run-id", "--artifact-id", "--commit-sha", "--artifact-digest", "--release-content-sha256")
KEYS = ("workflow_run_id", "artifact_id", "commit_sha", "artifact_digest", "release_content_sha256")


def parse_deploy(arguments):
    require(len(arguments) == 10 and tuple(arguments[::2]) == FLAGS, "DEPLOY_ARGUMENTS")
    values = dict(zip(KEYS, arguments[1::2], strict=True))
    identity_valid(values)
    return values


@contextlib.contextmanager
def verifier_lock():
    # 与 #36 bootstrap/upgrade 使用同一目录锁和文件锁，且先锁后加载组件。
    check_directory(LIB, 0)
    parent = os.open(LIB, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    descriptor = None
    try:
        fcntl.flock(parent, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(read_file(LOCK, 0, mode=0o600) == b"", "DEPLOY_VERIFIER_LOCK")
        descriptor = os.open(LOCK, os.O_RDONLY | os.O_NOFOLLOW)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        held, live = os.fstat(descriptor), LOCK.lstat()
        require((held.st_dev, held.st_ino) == (live.st_dev, live.st_ino), "DEPLOY_VERIFIER_LOCK")
        yield
    except BlockingIOError as error:
        raise DeploymentError("DEPLOY_VERIFIER_BUSY") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)


def load_verifier():
    content = read_file(VERIFIER, 0, mode=0o755)
    spec = importlib.util.spec_from_file_location("axialmuse_installed_verifier", VERIFIER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    # 使用已按 owner/mode/单链接稳定读取的字节，不重新按路径打开执行。
    exec(compile(content, str(VERIFIER), "exec"), module.__dict__)
    return module


def interrupted(_number, _frame):
    raise DeploymentError("DEPLOY_INTERRUPTED")


def main(arguments=None, executable=None):
    previous = {}
    try:
        require(os.geteuid() == 0, "DEPLOY_CONTEXT")
        arguments = sys.argv[1:] if arguments is None else arguments
        executable = Path(sys.argv[0]).name if executable is None else executable
        require(executable in ("axialmuse-deploy", "axialmuse-deploy-prepared",
                               "axialmuse-rollback", "axialmuse-deploy-init"),
                "DEPLOY_COMMAND")
        identity = parse_deploy(arguments) if executable in ("axialmuse-deploy", "axialmuse-deploy-prepared") else None
        if executable == "axialmuse-rollback":
            require(len(arguments) == 2 and arguments[0] == "--commit-sha", "DEPLOY_ARGUMENTS")
            sha_valid(arguments[1])
        if executable == "axialmuse-deploy-init":
            require(arguments == ["--new-site-ledger"], "DEPLOY_ARGUMENTS")
        for number in (signal.SIGINT, signal.SIGTERM):
            previous[number] = signal.signal(number, interrupted)
        with verifier_lock():
            state = DeploymentState(STATE)
            check_directory(SITE, 0, 0o755)
            if executable == "axialmuse-deploy-init":
                require(not os.path.lexists(SITE / "current") and not os.path.lexists(SITE / "releases"),
                        "DEPLOY_ALREADY_INITIALIZED")
                state.initialize()
                (SITE / "releases").mkdir(mode=0o755)
                (SITE / "releases").chmod(0o755)
                sync_directory(SITE)
                print(canonical({"status": "initialized-new-site", "publicActivation": False}).decode(), end="")
                return 0
            store = ReleaseStore(SITE, state, load_verifier())
            from ops.deploy.prepare_artifact import prepare_artifact
            from ops.deploy.public_activation import PublicNginx, load_public_mode
            mode = load_public_mode(state)
            options = {"site_configuration": Path("/etc/nginx/conf.d/axialmuse-local.conf")}
            nginx = LocalNginx(store, **options) if mode is None else PublicNginx(store, mode=mode, **options)
            engine = ReleaseTransaction(store, nginx, prepare=prepare_artifact)
            if identity is not None:
                stage = None
                if executable == "axialmuse-deploy-prepared":
                    # 五参数顺序与 staging 命名分别固定，不允许传入任意路径。
                    stage = SITE / "staging" / f"{identity['commit_sha']}-{identity['workflow_run_id']}-{identity['artifact_id']}"
                result = engine.execute(identity=identity, stage=stage)
            else:
                result = engine.execute(rollback_sha=arguments[1])
            print(canonical(result).decode(), end="")
            return 0
    except Exception as error:
        code = str(error) if isinstance(error, DeploymentError) else "DEPLOY_INTERNAL"
        print(f"[{code}] 固定入口失败；保留事务证据。", file=sys.stderr)
        return 1
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


if __name__ == "__main__":
    raise SystemExit(main())

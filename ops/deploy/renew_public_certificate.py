#!/usr/bin/python3 -I
"""固定双域名 Certbot hook；更新证书不改变当前 release 或暴露账本。"""

import os
import secrets
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, "/usr/local/lib/axialmuse")

from ops.deploy.deployment_state import (  # noqa: E402
    DeploymentError, DeploymentState, canonical, check_directory, digest, read_file,
    require, sync_directory, write_new,
)
from ops.deploy.public_activation import PublicNginx, load_public_mode  # noqa: E402
from ops.deploy.public_site import HOSTS, LINEAGE  # noqa: E402
from ops.deploy.release_commands import SITE, STATE, load_verifier, verifier_lock  # noqa: E402
from ops.deploy.release_install import ReleaseStore  # noqa: E402
from ops.deploy.url_exposure_ledger import assert_release_compatible, parse_exposure_ledger  # noqa: E402


def renewal_context(environment):
    domains = environment.get("RENEWED_DOMAINS", "").split()
    require(len(domains) == len(HOSTS) and set(domains) == set(HOSTS), "PUBLIC_RENEW_DOMAINS")
    require(environment.get("RENEWED_LINEAGE") == str(LINEAGE), "PUBLIC_RENEW_LINEAGE")


def renew(store, nginx):
    store.state.assert_idle()
    before = store.state.read_ledger()[0]
    sha = store.current()
    require(sha is not None, "PUBLIC_CURRENT")
    assert_release_compatible(parse_exposure_ledger(before), store.read_view(sha)[0])
    require(read_file(nginx.public_configuration, store.uid, mode=0o644) == nginx.render(sha),
            "PUBLIC_CONFIG_DRIFT")
    # validate 在真正 reload 前检查密钥匹配、信任链/主机名和隔离 HTTPS。
    nginx.validate(sha)
    nginx.activate(sha)
    require(store.current() == sha and store.state.read_ledger()[0] == before, "PUBLIC_RENEW_DRIFT")
    return {"status": "certificate-reload-local-accepted", "currentSha": sha,
            "ledgerSha256": digest(before), "certificateSha256": nginx.certificate_sha256(),
            "publicAcceptance": False}


def record_success(state, result, started):
    directory = state.root / "certificate-renewals"
    if not os.path.lexists(directory):
        directory.mkdir(mode=0o700)
        sync_directory(directory.parent)
    check_directory(directory, state.uid, 0o700)
    write_new(directory / f"{time.time_ns()}-{secrets.token_hex(16)}.json",
              canonical({"schema": 1, "startedNs": started, "completedNs": time.time_ns(), **result}))


def main(arguments=None):
    try:
        require(os.geteuid() == 0, "PUBLIC_CONTEXT")
        require((sys.argv[1:] if arguments is None else arguments) == [], "PUBLIC_ARGUMENTS")
        renewal_context(os.environ)
        started = time.time_ns()
        with verifier_lock():
            state = DeploymentState(STATE)
            with state.locked():
                mode = load_public_mode(state)
                require(mode is not None, "PUBLIC_MODE_MISSING")
                store = ReleaseStore(SITE, state, load_verifier())
                nginx = PublicNginx(store, mode=mode)
                result = renew(store, nginx)
                record_success(state, result, started)
        print('{"status":"certificate-reload-local-accepted","publicAcceptance":false}')
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, DeploymentError) else "PUBLIC_RENEW_INTERNAL"
        print(f"[{code}] 证书 hook 失败；保留当前 release 与诊断。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

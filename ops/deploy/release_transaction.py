"""锁内的发布/回滚事务；失败不删除已承诺 URL 或失败现场。"""

import signal

from ops.deploy import url_exposure_ledger as ledger
from ops.deploy.deployment_state import (
    DeploymentError, canonical, digest, identity_valid, replace_file, require, write_new,
)


class ReleaseTransaction:
    def __init__(self, store, nginx, prepare=None):
        self.store = store
        self.state = store.state
        self.nginx = nginx
        self.prepare = prepare

    def execute(self, *, identity=None, stage=None, rollback_sha=None):
        require((identity is None) != (rollback_sha is None), "DEPLOY_ARGUMENTS")
        if identity is not None:
            identity_valid(identity)
        with self.state.locked():
            self.state.assert_idle()
            before = self.state.read_ledger()[0]
            old_sha = self.store.current()
            successful = self.state.successful_releases()
            request = {"identity": identity, "rollback": rollback_sha,
                       "previous": old_sha, "ledgerBefore": digest(before)}
            transaction = self.state.begin(request)
            fallback = None
            committed_ledger = False
            switched = False
            candidate_sha = rollback_sha or identity["commit_sha"]
            after = before
            try:
                if rollback_sha is None:
                    if stage is None:
                        require(self.prepare is not None, "DEPLOY_ARGUMENTS")
                        stage = self.prepare(**identity)
                    candidate = self.store.install(stage, identity)
                    merged = ledger.merge_candidate_exposure(ledger.parse_exposure_ledger(before), candidate)
                    after = merged.content
                else:
                    require(rollback_sha in successful, "DEPLOY_ROLLBACK_UNACCEPTED")
                    candidate = self.store.read_view(rollback_sha)[0]
                current_ledger = ledger.parse_exposure_ledger(after)
                ledger.assert_release_compatible(current_ledger, candidate)
                self.nginx.validate(candidate_sha)
                candidates = sorted(successful, key=lambda sha: (sha != old_sha, sha))
                for fallback_sha in candidates:
                    old_view = self.store.read_view(fallback_sha)[0]
                    try:
                        ledger.assert_release_compatible(current_ledger, old_view)
                    except ledger.UrlExposureError as error:
                        if error.code not in ("DEPLOY_RELEASE_INCOMPATIBLE_ROUTE", "DEPLOY_RELEASE_INCOMPATIBLE_EDGE"):
                            raise
                    else:
                        self.nginx.validate(fallback_sha)
                        fallback = fallback_sha
                        break
                if fallback is None:
                    require(identity is not None, "DEPLOY_NO_FALLBACK")
                    self.state.consume_approval(transaction, identity, before, after)
                write_new(transaction / "plan.json", canonical({
                    "candidate": candidate_sha, "fallback": fallback,
                    "before": digest(before), "after": digest(after),
                }))
                # 中断仅延后到持久账本与 current 切换结束；SIGKILL 留 pending 阻断后续。
                signals = {signal.SIGINT, signal.SIGTERM}
                previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, signals)
                try:
                    self.state.append_ledger(before, after)
                    committed_ledger = True
                    self.store.switch(candidate_sha, old_sha)
                    switched = True
                finally:
                    signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
                self.nginx.activate(candidate_sha)
                require(self.state.read_ledger()[0] == after, "DEPLOY_LEDGER_DRIFT")
                self.store.read_view(candidate_sha)
                result = {"status": "local-accepted", "sha": candidate_sha,
                          "fallback": fallback, "ledgerBefore": digest(before), "ledgerAfter": digest(after)}
                write_new(transaction / "result.json", canonical(result))
            except Exception as error:
                status = "rejected"
                # 若 switch 的 fsync/后验失败，不能仅凭 Python 布尔值假设未切换。
                try:
                    live = self.store.current()
                    if live == candidate_sha:
                        switched = True
                    require(live in (old_sha, candidate_sha), "DEPLOY_CURRENT_DRIFT")
                    if committed_ledger or switched:
                        require(self.state.read_ledger()[0] == after, "DEPLOY_LEDGER_DRIFT")
                        if fallback is not None:
                            ledger.assert_release_compatible(ledger.parse_exposure_ledger(after),
                                                             self.store.read_view(fallback)[0])
                            self.store.switch(fallback, live)
                            self.nginx.activate(fallback)
                            status = "recovered"
                        else:
                            status = "forward-only-failed"
                    else:
                        # 账本 append 中途失败也必须阻断后续，不能写 rejected 放行。
                        require(self.state.read_ledger()[0] == before, "DEPLOY_LEDGER_DRIFT")
                except Exception:
                    status = "recovery-required"
                code = getattr(error, "code", None)
                if code is None and isinstance(error, DeploymentError):
                    code = str(error)
                if code == "DEPLOY_NGINX_UNCERTAIN":
                    status = "recovery-required"
                # pending 仍在：写入中途留下的成功记录不能遮盖恢复结果。
                replace_file(transaction / "result.json", canonical({
                    "status": status, "code": code or "DEPLOY_INTERNAL",
                    "sha": candidate_sha,
                    "ledgerBefore": digest(before), "ledgerAfter": digest(after),
                }))
                if status != "recovery-required":
                    self.state.complete(transaction)
                raise DeploymentError("DEPLOY_" + status.upper().replace("-", "_")) from error
            # 成功记录已持久化；提交点之后的中断/同步错误不能再回滚。
            self.state.complete(transaction)
            return result

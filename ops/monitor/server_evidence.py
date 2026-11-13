"""在发布锁内生成最小化的只读生产证据；传输和权限由独立接线负责。"""

import re

from ops.deploy import url_exposure_ledger as ledger
from ops.deploy.deployment_state import digest, require
from ops.monitor.public_health import utc


def release_bundle(store):
    """在同一个锁内捕获身份、账本、已验证文件清单和规则。"""
    state = store.state
    with state.locked():
        state.assert_idle()
        content, history_digest, count = state.read_ledger()
        exposure = ledger.parse_exposure_ledger(content)
        sha = store.current()
        require(sha is not None, "MONITOR_CURRENT_MISSING")
        require(sha in state.successful_releases(), "MONITOR_CURRENT_UNACCEPTED")
        view, receipt, _ = store.read_view(sha)
        ledger.assert_release_compatible(exposure, view)
        require(store.current() == sha, "MONITOR_CURRENT_DRIFT")
        require(state.read_ledger() == (content, history_digest, count), "MONITOR_LEDGER_DRIFT")
        result = {
            "schema": 1,
            "identity": receipt["identity"],
            "ledgerSha256": digest(content),
            "ledgerHistorySha256": history_digest,
            "ledgerHistoryEntries": count,
            "publishedRoutes": [route.path for route in exposure.published_routes],
            "redirectEdges": [{"from": edge.source, "to": edge.target} for edge in exposure.redirect_edges],
        }
        files = {}
        for name, expected in receipt["files"].items():
            if not name.startswith("payload/"):
                continue
            path = name[len("payload/"):]
            if path == "index.html":
                path = "/"
            elif path.endswith("/index.html"):
                path = "/" + path[:-len("index.html")]
            else:
                path = "/" + path
            require(path not in files, "MONITOR_PAYLOAD_DUPLICATE")
            files[path] = expected
        rules = {rule.source: rule.target for rule in view.rules}
        require(len(rules) == len(view.rules), "MONITOR_RULE_DUPLICATE")
        return {"schema": 1, "observedAtUtc": utc(), "snapshot": result,
                "release": {"files": files, "pages": list(view.published_routes), "rules": rules}}


def snapshot(store):
    return release_bundle(store)["snapshot"]


def challenged_snapshot(store, challenge):
    require(isinstance(challenge, str) and re.fullmatch(r"[0-9a-f]{64}", challenge), "MONITOR_CHALLENGE")
    result = snapshot(store)
    return {"schema": 1, "challenge": challenge, "observedAtUtc": utc(), "snapshot": result}

"""组合新鲜服务器证据与公网检查；认证传输由显式 reader 提供。"""

import re
import secrets
import time
from datetime import datetime

from ops.monitor.public_health import (
    HealthError, canonical, digest, require, sample, utc, validate_baseline,
)


def validate_evidence(envelope, challenge, baseline, now):
    require(isinstance(envelope, dict) and set(envelope) == {"schema", "challenge", "observedAtUtc", "snapshot"}
            and type(envelope["schema"]) is int and envelope["schema"] == 1, "MONITOR_ENVELOPE")
    require(envelope["challenge"] == challenge, "MONITOR_CHALLENGE")
    observed = envelope["observedAtUtc"]
    require(isinstance(observed, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)",
                                                    observed), "MONITOR_EVIDENCE_TIME")
    try:
        timestamp = datetime.fromisoformat(observed).timestamp()
    except ValueError:
        raise HealthError("MONITOR_EVIDENCE_TIME") from None
    require(0 <= now - timestamp <= 120, "MONITOR_EVIDENCE_STALE")
    value = envelope["snapshot"]
    require(isinstance(value, dict) and set(value) == {
        "schema", "identity", "ledgerSha256", "ledgerHistorySha256", "ledgerHistoryEntries",
        "publishedRoutes", "redirectEdges",
    } and type(value["schema"]) is int and value["schema"] == 1, "MONITOR_SNAPSHOT")
    require(value["identity"] == baseline["identity"], "MONITOR_BASELINE_IDENTITY")
    require(value["ledgerSha256"] == baseline["ledgerSha256"], "MONITOR_BASELINE_LEDGER")
    require(isinstance(value["ledgerHistorySha256"], str)
            and re.fullmatch(r"[0-9a-f]{64}", value["ledgerHistorySha256"])
            and type(value["ledgerHistoryEntries"]) is int and value["ledgerHistoryEntries"] > 0,
            "MONITOR_HISTORY")
    routes, edges = value["publishedRoutes"], value["redirectEdges"]
    require(isinstance(routes, list) and 0 < len(routes) <= 10000
            and all(isinstance(path, str) for path in routes) and len(set(routes)) == len(routes), "MONITOR_ROUTES")

    def resolve(path):
        require(isinstance(path, str), "MONITOR_ROUTES")
        target = baseline["rules"].get(path, path)
        require(target in baseline["pages"], "MONITOR_ROUTE_UNRESOLVED")
        return target

    for path in routes:
        resolve(path)
    require(set(baseline["pages"]) <= set(routes), "MONITOR_ROUTE_UNEXPOSED")
    require(isinstance(edges, list) and len(edges) <= 10000, "MONITOR_EDGES")
    seen = set()
    for edge in edges:
        require(isinstance(edge, dict) and set(edge) == {"from", "to"}, "MONITOR_EDGES")
        require(resolve(edge["from"]) == resolve(edge["to"]), "MONITOR_EDGE_DIVERGED")
        pair = edge["from"], edge["to"]
        require(pair not in seen, "MONITOR_EDGES")
        seen.add(pair)
    return value


def run_bound_sample(baseline, read_evidence, *, probe=sample, now=time.time, **options):
    """reader 必须使用已认证通道；只在本轮收到且匹配的证据上调用 probe。"""
    validate_baseline(baseline)
    checks = []
    receipt = {"schema": 1, "observedAtUtc": utc(), "identity": baseline["identity"],
               "baselineSha256": digest(canonical(baseline)), "serverLedgerInspected": False,
               "mutationsPerformed": False}

    def evidence(phase):
        challenge = secrets.token_hex(32)
        envelope = read_evidence(challenge)
        value = validate_evidence(envelope, challenge, baseline, now())
        receipt["serverEvidence" + phase.title() + "Sha256"] = digest(canonical(envelope))
        return value

    def failure(phase, error):
        checks.append({"check": phase, "status": "failed",
                       "code": str(error) if isinstance(error, HealthError) else "MONITOR_EVIDENCE_FAILED"})

    try:
        before = evidence("before")
        checks.append({"check": "server-evidence:before", "status": "passed"})
    except Exception as error:
        failure("server-evidence:before", error)
    else:
        try:
            public = probe(baseline, **options)
            require(public["identity"] == baseline["identity"]
                    and public["baselineSha256"] == receipt["baselineSha256"]
                    and public["serverLedgerInspected"] is False, "MONITOR_PROBE_IDENTITY")
            public_checks = public["checks"]
            require(isinstance(public_checks, list)
                    and all(isinstance(c, dict) and c.get("status") in ("passed", "failed") for c in public_checks),
                    "MONITOR_PROBE_RESULT")
            count = sum(c["status"] == "failed" for c in public_checks)
            require(public["checkCount"] == len(public_checks) and public["failedCount"] == count
                    and public["status"] == ("failed" if count else "passed"), "MONITOR_PROBE_RESULT")
            receipt.update(public)
            checks.extend(public_checks)
        except Exception as error:
            failure("public-probe", error)
        try:
            after = evidence("after")
            require(after == before, "MONITOR_SNAPSHOT_DRIFT")
            receipt["serverLedgerInspected"] = True
            receipt["serverSnapshotSha256"] = digest(canonical(after))
            checks.append({"check": "server-evidence:after", "status": "passed"})
        except Exception as error:
            failure("server-evidence:after", error)
    failed_count = sum(c["status"] == "failed" for c in checks)
    receipt.update({"status": "failed" if failed_count else "passed", "checks": checks,
                    "failedCount": failed_count, "checkCount": len(checks), "completedAtUtc": utc()})
    return receipt

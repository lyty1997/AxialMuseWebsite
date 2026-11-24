"""资源诊断封闭协议；共享工件只保留可验证的最小字段。"""

import re
import copy
from datetime import datetime, timezone

from ops.maintenance.resources import RESOURCE_FAILURE_CODES
from ops.monitor.public_health import HealthError, canonical, digest, require


PHASES = ("bootstrap", "before", "after", "monthly-final")
SCENARIOS = {name: "MAINTENANCE_" + name.upper().replace("-", "_")
             for name in ("disk-used-warning", "disk-used-critical", "disk-free-warning",
                          "disk-free-critical", "inode-used-warning", "inode-used-critical")}
DRILL_KEYS = {"id", "scenario", "requestSha256", "runtimeSha256", "siteIdentity", "ledgerSha256", "simulated"}


def matches(value, pattern):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def sha256(value):
    return matches(value, r"[0-9a-f]{64}")


def timestamp(value):
    require(matches(value, r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)"),
            "MONITOR_EVIDENCE_TIME")
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        raise HealthError("MONITOR_EVIDENCE_TIME") from None


def identity_valid(value):
    require(isinstance(value, dict) and set(value) == {
        "workflow_run_id", "artifact_id", "commit_sha", "artifact_digest", "release_content_sha256"},
        "MONITOR_DRILL_IDENTITY")
    for key, item in value.items():
        pattern = r"[1-9][0-9]{0,15}" if key.endswith("_id") else (
            r"[0-9a-f]{40}" if key == "commit_sha" else r"[0-9a-f]{64}")
        require(matches(item, pattern) and (not key.endswith("_id") or int(item) <= 9007199254740991),
                "MONITOR_DRILL_IDENTITY")


def drill_valid(value):
    require(isinstance(value, dict) and set(value) == DRILL_KEYS
            and matches(value["id"], r"[0-9a-f]{32}") and value["simulated"] is True
            and isinstance(value["scenario"], str) and value["scenario"] in SCENARIOS
            and all(sha256(value[key]) for key in ("requestSha256", "runtimeSha256", "ledgerSha256")),
            "MONITOR_DRILL_ENVELOPE")
    identity_valid(value["siteIdentity"])


def transport_valid(value):
    require(isinstance(value, dict) and set(value) == {
        "schema", "invocationId", "commandId", "instanceId", "createdTime", "commandSha256", "outputSha256"}
        and type(value["schema"]) is int and value["schema"] == 1
        and matches(value["invocationId"], r"inv-[a-z0-9]{8,64}")
        and matches(value["commandId"], r"cmd-[a-z0-9]{8,64}")
        and matches(value["instanceId"], r"(?:lhins|ins)-[a-z0-9]{8,64}")
        and sha256(value["commandSha256"]) and sha256(value["outputSha256"]), "MONITOR_TAT_EVIDENCE")
    timestamp(value["createdTime"])


class ResourceDiagnostic(HealthError):
    def __init__(self, code, diagnostic, simulated):
        super().__init__(code)
        self.diagnostic = diagnostic
        self.simulated = simulated


def failed_check(name, error, fallback):
    result = {"check": name, "status": "failed",
              "code": str(error) if isinstance(error, HealthError) else fallback}
    if isinstance(error, ResourceDiagnostic):
        key = "drillObservationSha256" if error.simulated else "resourceObservationSha256"
        result[key] = digest(canonical(error.diagnostic))
    return result


class Observations:
    def __init__(self):
        self.server_reads = []
        self.resources = []
        self.drills = []

    def authenticated(self, phase, evidence):
        require(phase in PHASES, "MONITOR_PHASE")
        transport_valid(evidence)
        return {"phase": phase, "transportEvidenceSha256": digest(canonical(evidence))}

    def failure(self, bundle, phase, evidence, received_at, baseline=None):
        link = self.authenticated(phase, evidence)
        require(isinstance(bundle, dict), "MONITOR_BUNDLE")
        if "resourceFailure" not in bundle:
            return link
        code = bundle["resourceFailure"]
        require(type(bundle.get("schema")) is int and isinstance(code, str) and code in RESOURCE_FAILURE_CODES,
                "MONITOR_BUNDLE")
        simulated = bundle["schema"] == 2
        if simulated:
            require(set(bundle) == {"schema", "observedAtUtc", "resourceFailure", "drill"}, "MONITOR_DRILL_ENVELOPE")
            drill_valid(bundle["drill"])
            require(code == SCENARIOS[bundle["drill"]["scenario"]], "MONITOR_DRILL_SCENARIO")
            require(-5 <= received_at - timestamp(bundle["observedAtUtc"]) <= 120, "MONITOR_EVIDENCE_STALE")
            if baseline is not None:
                require(bundle["drill"]["siteIdentity"] == baseline["identity"], "MONITOR_BASELINE_IDENTITY")
                require(bundle["drill"]["ledgerSha256"] == baseline["ledgerSha256"], "MONITOR_BASELINE_LEDGER")
            diagnostic = {**link, "observedAtUtc": bundle["observedAtUtc"], "resourceFailure": code,
                          "drill": copy.deepcopy(bundle["drill"])}
            self.drills.append(diagnostic)
        else:
            require(bundle["schema"] == 1 and set(bundle) == {"schema", "resourceFailure"}, "MONITOR_BUNDLE")
            level = "warning" if code.endswith("_WARNING") else "critical" if code.endswith("_CRITICAL") else "unknown"
            diagnostic = {**link, "resourceFailure": code, "level": level, "scope": "root-filesystem",
                          "receivedAtUtc": datetime.fromtimestamp(received_at, timezone.utc).isoformat()}
            self.resources.append(diagnostic)
        self.server_reads.append(link)
        raise ResourceDiagnostic(code, diagnostic, simulated)

    def merge(self, receipt):
        receipt.update(serverReadEvidence=self.server_reads, resourceObservations=self.resources,
                       drillObservations=self.drills)
        # 收集器是运行级失败事实；上层异常处理或后续健康不能将它清除。
        for diagnostic, simulated in [(d, False) for d in self.resources] + [(d, True) for d in self.drills]:
            key = "drillObservationSha256" if simulated else "resourceObservationSha256"
            fingerprint = digest(canonical(diagnostic))
            if not any(check.get(key) == fingerprint for check in receipt["checks"]):
                receipt["checks"].append(failed_check("resource:" + diagnostic["phase"],
                    ResourceDiagnostic(diagnostic["resourceFailure"], diagnostic, simulated), "MONITOR_RESOURCE"))
        receipt["checkCount"] = len(receipt["checks"])
        receipt["failedCount"] = sum(c["status"] == "failed" for c in receipt["checks"])
        receipt["status"] = "failed" if receipt["failedCount"] else "passed"
        return receipt

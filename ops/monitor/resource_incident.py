"""人工事件记录的本地校验模型；不写仓库、不建 Issue、不执行处置。"""

import copy

from ops.monitor.public_health import canonical, daily_check_names, digest, require, utc, validate_baseline
from ops.monitor.resource_protocol import identity_valid, matches, sha256, timestamp
from ops.maintenance.resources import RESOURCE_FAILURE_CODES


TRANSITIONS = {
    "open": {"acknowledged"}, "acknowledged": {"investigating"},
    "investigating": {"mitigating", "verifying"}, "mitigating": {"investigating", "verifying"},
    "verifying": {"investigating"}, "recovered": {"investigating"}, "closed": set(),
}


def validate_recovery(receipt, proof, *, baseline=None):
    """proof 是维护者完成独立核验后的记录，不能代替实际调用或私有证据。"""
    require(isinstance(proof, dict) and set(proof) == {
        "runId", "runAttempt", "receiptSha256", "incidentContextSha256",
        "inFlightEvidenceSha256", "identityEvidenceSha256",
        "actionsFinished", "inFlightVerified", "freshAfterReconciliation", "identityVerified",
        "runtimeVerified", "ledgerVerified"}, "INCIDENT_RECOVERY_PROOF")
    require(all(proof[key] is True for key in ("actionsFinished", "inFlightVerified", "freshAfterReconciliation",
                "identityVerified", "runtimeVerified", "ledgerVerified"))
            and all(sha256(proof[key]) for key in ("receiptSha256", "incidentContextSha256",
                    "inFlightEvidenceSha256", "identityEvidenceSha256"))
            and all(matches(proof[key], r"[1-9][0-9]{0,19}") for key in ("runId", "runAttempt")),
            "INCIDENT_RECOVERY_PROOF")
    require(isinstance(receipt, dict) and type(receipt.get("schema")) is int and receipt["schema"] == 1
            and receipt.get("period") == "daily"
            and receipt.get("status") == "passed" and receipt.get("resourceObservations") == []
            and receipt.get("drillObservations") == [] and receipt.get("serverLedgerInspected") is True
            and matches(receipt.get("workflowSourceSha"), r"[0-9a-f]{40}")
            and sha256(receipt.get("baselineSha256")), "INCIDENT_RECOVERY_RECEIPT")
    identity_valid(receipt.get("identity"))
    validate_baseline(baseline)
    require(receipt["baselineSha256"] == digest(canonical(baseline))
            and receipt["identity"] == baseline["identity"], "INCIDENT_RECOVERY_BASELINE")
    checks = receipt.get("checks")
    require(isinstance(checks, list) and len(checks) > 0
            and all(isinstance(c, dict) and isinstance(c.get("check"), str)
                    and c.get("status") == "passed" for c in checks)
            and type(receipt.get("failedCount")) is int and receipt["failedCount"] == 0
            and type(receipt.get("checkCount")) is int and receipt["checkCount"] == len(checks),
            "INCIDENT_RECOVERY_RECEIPT")
    required = daily_check_names(baseline) | {"server-evidence:before", "server-evidence:after", "project-experiences"}
    require({c["check"] for c in checks} == required and len(checks) == len(required),
            "INCIDENT_RECOVERY_RECEIPT")
    require(timestamp(receipt.get("completedAtUtc")) >= timestamp(receipt.get("observedAtUtc")),
            "INCIDENT_RECOVERY_FRESHNESS")
    reads = receipt.get("serverReadEvidence")
    require(isinstance(reads, list) and len(reads) == 3 and all(isinstance(r, dict) and set(r) == {
        "phase", "transportEvidenceSha256"} and sha256(r["transportEvidenceSha256"]) for r in reads)
        and [r["phase"] for r in reads] == ["bootstrap", "before", "after"]
        and len({r["transportEvidenceSha256"] for r in reads}) == 3, "INCIDENT_RECOVERY_READS")
    require(digest(canonical(receipt)) == proof["receiptSha256"], "INCIDENT_RECOVERY_DIGEST")


class IncidentJournal:
    def __init__(self, incident_id, *, previous=None):
        require(matches(incident_id, r"resource-(?:[1-9][0-9]{0,19}-[1-9][0-9]{0,19}|manual-[0-9a-f]{32})"),
                "INCIDENT_ID")
        require(previous is None or matches(previous,
                r"resource-(?:[1-9][0-9]{0,19}-[1-9][0-9]{0,19}|manual-[0-9a-f]{32})"), "INCIDENT_ID")
        self.record = {"incidentId": incident_id, "scope": "root-filesystem", "state": "open",
                       "notification": "pending", "previousIncidentId": previous, "highestLevel": "unknown",
                       "latestLevel": "unknown", "observations": [], "history": [], "orderingPending": False}

    def append(self, kind, value):
        self.record["history"].append({"atUtc": utc(), "kind": kind, "value": copy.deepcopy(value)})

    def observe(self, run_id, attempt, diagnostic, *, ordering="current"):
        require(all(matches(v, r"[1-9][0-9]{0,19}") for v in (run_id, attempt))
                and ordering in ("current", "historical", "unknown"), "INCIDENT_OBSERVATION")
        require(isinstance(diagnostic, dict) and set(diagnostic) == {
            "phase", "resourceFailure", "level", "scope", "receivedAtUtc", "transportEvidenceSha256"}
            and diagnostic["scope"] == self.record["scope"]
            and diagnostic["phase"] in ("bootstrap", "before", "after", "monthly-final")
            and isinstance(diagnostic["resourceFailure"], str) and diagnostic["resourceFailure"] in RESOURCE_FAILURE_CODES
            and sha256(diagnostic["transportEvidenceSha256"]), "INCIDENT_OBSERVATION")
        timestamp(diagnostic["receivedAtUtc"])
        code = diagnostic["resourceFailure"]
        expected = "warning" if code.endswith("_WARNING") else "critical" if code.endswith("_CRITICAL") else "unknown"
        require(diagnostic["level"] == expected, "INCIDENT_OBSERVATION")
        observation = {"runId": run_id, "runAttempt": attempt, **copy.deepcopy(diagnostic)}
        key = (run_id, attempt, diagnostic["phase"], diagnostic["transportEvidenceSha256"])
        for old in self.record["observations"]:
            if key == (old["runId"], old["runAttempt"], old["phase"], old["transportEvidenceSha256"]):
                require(old == observation, "INCIDENT_OBSERVATION_DRIFT")
                return
        require(self.record["state"] != "closed" or ordering != "current", "INCIDENT_RECURRENCE_NEW_ID")
        self.record["observations"].append(observation)
        ranks = {"unknown": 0, "warning": 1, "critical": 2}
        if ranks[expected] > ranks[self.record["highestLevel"]]:
            self.record["highestLevel"] = expected
        if ordering != "historical":
            self.record["latestLevel"] = expected
            if self.record["state"] in ("recovered", "closed"):
                self.record["state"] = "investigating"
        if ordering == "unknown":
            self.record["orderingPending"] = True
        self.append("observation", {"key": list(key), "ordering": ordering})

    def notification(self, state, evidence_sha):
        require(state in ("received", "not-confirmed") and sha256(evidence_sha), "INCIDENT_NOTIFICATION")
        self.record["notification"] = state
        self.append("notification", {"state": state, "evidenceSha256": evidence_sha})

    def transition(self, state, evidence_sha):
        require(state in TRANSITIONS[self.record["state"]] and sha256(evidence_sha)
                and bool(self.record["observations"]), "INCIDENT_TRANSITION")
        self.record["state"] = state
        self.append("state", {"state": state, "evidenceSha256": evidence_sha})

    def reconcile(self, evidence_sha):
        require(sha256(evidence_sha), "INCIDENT_RECONCILIATION")
        self.record["orderingPending"] = False
        self.append("reconciliation", {"evidenceSha256": evidence_sha})

    def recovery_context(self):
        return digest(canonical(self.record))

    def recover(self, receipt, proof, *, baseline=None):
        require(self.record["state"] == "verifying" and self.record["orderingPending"] is False,
                "INCIDENT_RECOVERY_STATE")
        validate_recovery(receipt, proof, baseline=baseline)
        require(proof["incidentContextSha256"] == self.recovery_context(), "INCIDENT_RECOVERY_CONTEXT")
        for event in self.record["history"]:
            if event["kind"] == "recovery":
                consumed = event["value"]["proof"]
                require(proof["receiptSha256"] != consumed["receiptSha256"]
                        and (proof["runId"], proof["runAttempt"]) != (consumed["runId"], consumed["runAttempt"]),
                        "INCIDENT_RECOVERY_REUSED")
            elif (event["kind"] == "reconciliation"
                  or event["kind"] == "observation" and event["value"]["ordering"] != "historical"
                  or event["kind"] == "state" and event["value"]["state"] == "verifying"):
                require(timestamp(receipt["observedAtUtc"]) >= timestamp(event["atUtc"]),
                        "INCIDENT_RECOVERY_FRESHNESS")
        self.record["state"] = "recovered"
        self.record["latestLevel"] = "ok"
        self.append("recovery", {"proof": proof, "workflowSourceSha": receipt["workflowSourceSha"]})

    def close(self, checklist, evidence_sha, *, notification_issue=None):
        require(self.record["state"] == "recovered" and isinstance(checklist, dict) and set(checklist) == {
            "serviceImpactEnded", "observationsReconciled", "authorizationRecorded", "causeAndRisksRecorded"}
            and all(v is True for v in checklist.values()) and sha256(evidence_sha), "INCIDENT_CLOSE")
        require(self.record["notification"] == "received" or matches(notification_issue, r"monitor-[A-Za-z0-9-]{1,80}"),
                "INCIDENT_NOTIFICATION_OPEN")
        self.record["state"] = "closed"
        self.append("close", {"evidenceSha256": evidence_sha, "notificationIssue": notification_issue, "checklist": checklist})

    def snapshot(self):
        return copy.deepcopy(self.record)

    @classmethod
    def restore(cls, record, *, recovery_receipts=None, recovery_baselines=None):
        """按原追加顺序重放；恢复结论必须重新核验已保全的真实回执。"""
        require(isinstance(record, dict) and isinstance(record.get("history"), list)
                and isinstance(record.get("observations"), list), "INCIDENT_SNAPSHOT")
        journal = cls(record.get("incidentId"), previous=record.get("previousIncidentId"))
        for event in record["history"]:
            require(isinstance(event, dict) and set(event) == {"atUtc", "kind", "value"}
                    and isinstance(event["value"], dict), "INCIDENT_SNAPSHOT")
            timestamp(event["atUtc"])
            value = event["value"]
            if event["kind"] == "observation":
                observations = [d for d in record["observations"] if isinstance(d, dict) and [
                    d.get("runId"), d.get("runAttempt"), d.get("phase"), d.get("transportEvidenceSha256")] == value.get("key")]
                require(len(observations) == 1, "INCIDENT_SNAPSHOT")
                observation = dict(observations[0])
                run, attempt = observation.pop("runId"), observation.pop("runAttempt")
                journal.observe(run, attempt, observation, ordering=value.get("ordering"))
            elif event["kind"] == "notification":
                journal.notification(value.get("state"), value.get("evidenceSha256"))
            elif event["kind"] == "state":
                journal.transition(value.get("state"), value.get("evidenceSha256"))
            elif event["kind"] == "reconciliation":
                journal.reconcile(value.get("evidenceSha256"))
            elif event["kind"] == "recovery":
                proof = value.get("proof")
                require(isinstance(proof, dict) and isinstance(recovery_receipts, dict)
                        and proof.get("receiptSha256") in recovery_receipts, "INCIDENT_RECOVERY_ARCHIVE")
                receipt = recovery_receipts[proof["receiptSha256"]]
                require(isinstance(receipt, dict) and isinstance(recovery_baselines, dict)
                        and isinstance(receipt.get("baselineSha256"), str)
                        and receipt["baselineSha256"] in recovery_baselines, "INCIDENT_RECOVERY_ARCHIVE")
                journal.recover(receipt, proof, baseline=recovery_baselines[receipt["baselineSha256"]])
            elif event["kind"] == "close":
                journal.close(value.get("checklist"), value.get("evidenceSha256"),
                              notification_issue=value.get("notificationIssue"))
            else:
                require(False, "INCIDENT_SNAPSHOT")
            require(journal.record["history"][-1]["value"] == value, "INCIDENT_SNAPSHOT")
            journal.record["history"][-1] = copy.deepcopy(event)
        require(journal.snapshot() == record, "INCIDENT_SNAPSHOT")
        return journal

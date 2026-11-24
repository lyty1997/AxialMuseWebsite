"""人工事件样例的接手、归并、恢复与关闭门禁；不写外部状态。"""

import copy
import json
import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timedelta, timezone

from ops.monitor.public_health import HealthError, canonical, digest
from ops.monitor.public_health import private_json, write_receipt
from ops.monitor.resource_incident import IncidentJournal, validate_recovery
import test_resource_alerts as alert_fixtures


class ResourceIncidentTests(unittest.TestCase):
    def setUp(self):
        self.fixture = alert_fixtures.ResourceAlertTests()
        self.fixture.setUp()
        self.healthy = self.fixture.execute("daily", [self.fixture.base.bundle] * 3)
        self.healthy["workflowSourceSha"] = "f" * 40
        self.proof = {"runId": "20", "runAttempt": "1", "receiptSha256": digest(canonical(self.healthy)),
                      "inFlightEvidenceSha256": "a" * 64, "identityEvidenceSha256": "b" * 64,
                      "actionsFinished": True, "inFlightVerified": True, "freshAfterReconciliation": True,
                      "identityVerified": True, "runtimeVerified": True, "ledgerVerified": True}
        self.checklist = {"serviceImpactEnded": True, "observationsReconciled": True,
                          "authorizationRecorded": True, "causeAndRisksRecorded": True}
        self.journal = IncidentJournal("resource-10-1")
        self.baseline = self.fixture.base.baseline

    def prepare_recovery(self, *, journal=None, run_id="20", attempt="1"):
        self.healthy = self.fixture.execute("daily", [self.fixture.base.bundle] * 3)
        self.healthy["workflowSourceSha"] = "f" * 40
        self.proof.update(runId=run_id, runAttempt=attempt, receiptSha256=digest(canonical(self.healthy)),
                          incidentContextSha256=(journal or self.journal).recovery_context())

    def recover(self, receipt=None, proof=None, *, journal=None):
        (journal or self.journal).recover(self.healthy if receipt is None else receipt,
                                        self.proof if proof is None else proof, baseline=self.baseline)

    def restore(self, record, *, receipts=None, baselines=None):
        return IncidentJournal.restore(record,
            recovery_receipts={self.proof["receiptSha256"]: self.healthy} if receipts is None else receipts,
            recovery_baselines={digest(canonical(self.baseline)): self.baseline} if baselines is None else baselines)

    def diagnostic(self, code="MAINTENANCE_DISK_FREE_WARNING", fingerprint="c" * 64):
        return {"phase": "bootstrap", "resourceFailure": code,
                "level": "critical" if code.endswith("CRITICAL") else "warning",
                "scope": "root-filesystem", "receivedAtUtc": datetime.now(timezone.utc).isoformat(),
                "transportEvidenceSha256": fingerprint}

    def acknowledge(self):
        self.journal.observe("10", "1", self.diagnostic())
        self.journal.transition("acknowledged", "a" * 64)
        self.journal.transition("investigating", "b" * 64)

    def test_complete_real_failure_ack_mitigation_health_close_and_serialized_history(self):
        # 先从真实 statvfs 判定取得 schema 1，经 runner 相同接收路径产生真实观察。
        from types import SimpleNamespace
        from ops.maintenance.resources import check_resources, GIB
        value = SimpleNamespace(f_blocks=1000, f_bavail=200, f_frsize=GIB, f_files=1000, f_favail=500)
        resources = check_resources(statvfs=lambda _: value)
        code = next(c["code"] for c in resources["checks"] if c["level"] != "ok")
        receipt = self.fixture.execute("daily", [{"schema": 1, "resourceFailure": code}])
        self.journal.observe("10", "1", receipt["resourceObservations"][0])
        self.journal.notification("received", "d" * 64)
        self.assertEqual(self.journal.snapshot()["state"], "open")
        self.journal.transition("acknowledged", "a" * 64)
        self.journal.transition("investigating", "b" * 64)
        self.journal.transition("mitigating", "c" * 64)
        self.journal.transition("verifying", "d" * 64)
        self.prepare_recovery()
        self.recover()
        self.assertEqual(self.journal.snapshot()["latestLevel"], "ok")
        self.journal.close(self.checklist, "e" * 64)
        record = json.loads(canonical(self.journal.snapshot()))
        self.assertEqual(record["state"], "closed")
        self.assertEqual(record["highestLevel"], "warning")
        self.assertEqual(record["history"][-1]["kind"], "close")
        self.assertEqual(len(record["observations"]), 1)
        restored = self.restore(record)
        self.assertEqual(restored.snapshot(), record)
        with self.assertRaisesRegex(HealthError, "INCIDENT_RECOVERY_ARCHIVE"):
            IncidentJournal.restore(record)

    def test_interrupted_manual_record_restores_from_private_bytes_without_erasing_failure(self):
        self.acknowledge()
        original = self.journal.snapshot()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "incident.json"
            write_receipt(path, original)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            restored = IncidentJournal.restore(private_json(path))
        self.assertEqual(restored.snapshot(), original)
        restored.transition("verifying", "d" * 64)
        self.prepare_recovery(journal=restored)
        self.recover(journal=restored)
        self.assertEqual(restored.snapshot()["observations"], original["observations"])
        changed = copy.deepcopy(original)
        changed["state"] = "closed"
        with self.assertRaisesRegex(HealthError, "INCIDENT_SNAPSHOT"):
            IncidentJournal.restore(changed)

    def test_duplicate_escalation_and_warning_do_not_erase_original_or_recover(self):
        self.acknowledge()
        first = self.journal.snapshot()["observations"][0]
        self.journal.observe("10", "1", {k: v for k, v in first.items() if k not in ("runId", "runAttempt")})
        self.assertEqual(len(self.journal.snapshot()["observations"]), 1)
        self.journal.observe("11", "1", self.diagnostic("MAINTENANCE_INODE_USED_CRITICAL", "d" * 64))
        self.journal.observe("12", "1", self.diagnostic(fingerprint="e" * 64))
        record = self.journal.snapshot()
        self.assertEqual(record["highestLevel"], "critical")
        self.assertEqual(record["latestLevel"], "warning")
        self.assertEqual(record["state"], "investigating")
        self.assertEqual(record["observations"][0], first)

    def test_missing_fields_bad_receipts_identity_unknown_order_and_unfinished_actions_block_recovery(self):
        self.acknowledge()
        self.journal.transition("verifying", "a" * 64)
        self.prepare_recovery()
        for kind in ("missing-drills", "missing-resources", "warning", "failed-check", "identity", "reads", "digest"):
            receipt = copy.deepcopy(self.healthy)
            if kind == "missing-drills":
                del receipt["drillObservations"]
            elif kind == "missing-resources":
                del receipt["resourceObservations"]
            elif kind == "warning":
                receipt["resourceObservations"] = [self.diagnostic()]
            elif kind == "failed-check":
                receipt["checks"][0]["status"] = "failed"
            elif kind == "identity":
                receipt["identity"]["commit_sha"] = "invalid"
            elif kind == "reads":
                receipt["serverReadEvidence"][2] = receipt["serverReadEvidence"][1]
            else:
                receipt["completedAtUtc"] = "changed"
            with self.subTest(kind=kind), self.assertRaises(HealthError):
                self.recover(receipt)
        for flag in ("actionsFinished", "inFlightVerified", "freshAfterReconciliation", "identityVerified", "runtimeVerified", "ledgerVerified"):
            with self.subTest(flag=flag), self.assertRaises(HealthError):
                self.recover(proof={**self.proof, flag: False})
        self.journal.observe("11", "1", self.diagnostic(fingerprint="d" * 64), ordering="unknown")
        with self.assertRaisesRegex(HealthError, "INCIDENT_RECOVERY_STATE"):
            self.recover()
        self.journal.reconcile("e" * 64)
        self.prepare_recovery()
        self.recover()

    def test_notification_missing_can_only_close_resource_with_separate_open_record(self):
        self.acknowledge()
        self.journal.transition("verifying", "a" * 64)
        self.prepare_recovery()
        self.recover()
        with self.assertRaisesRegex(HealthError, "INCIDENT_NOTIFICATION_OPEN"):
            self.journal.close(self.checklist, "e" * 64)
        self.journal.close(self.checklist, "e" * 64, notification_issue="monitor-fixture-open")
        self.assertEqual(self.journal.snapshot()["notification"], "pending")

    def test_late_failure_historical_and_recurrence_have_different_effect(self):
        self.acknowledge()
        self.journal.notification("received", "a" * 64)
        self.journal.transition("verifying", "a" * 64)
        self.prepare_recovery()
        self.recover()
        self.journal.close(self.checklist, "e" * 64)
        self.journal.observe("11", "1", self.diagnostic(fingerprint="d" * 64), ordering="historical")
        self.assertEqual(self.journal.snapshot()["state"], "closed")
        with self.assertRaisesRegex(HealthError, "INCIDENT_RECURRENCE_NEW_ID"):
            self.journal.observe("21", "1", self.diagnostic(fingerprint="f" * 64))
        recurrence = IncidentJournal("resource-21-1", previous="resource-10-1")
        recurrence.observe("21", "1", self.diagnostic(fingerprint="f" * 64))
        self.assertEqual(recurrence.snapshot()["previousIncidentId"], "resource-10-1")

    def test_simulated_diagnostic_and_disarm_are_never_real_recovery(self):
        with self.assertRaises(HealthError):
            self.journal.observe("10", "1", self.fixture.drill())
        self.acknowledge()
        self.journal.transition("verifying", "a" * 64)
        self.prepare_recovery()
        with self.assertRaises(HealthError):
            self.recover({"state": "inactive", "disarmReceiptSha256": "d" * 64})

    def test_recurrence_rejects_previously_consumed_recovery(self):
        self.acknowledge()
        self.journal.transition("verifying", "a" * 64)
        self.prepare_recovery()
        self.recover()
        self.journal.observe("21", "1", self.diagnostic("MAINTENANCE_INODE_USED_CRITICAL", "e" * 64))
        self.journal.transition("verifying", "a" * 64)
        before = self.journal.snapshot()
        with self.assertRaisesRegex(HealthError, "INCIDENT_RECOVERY_CONTEXT"):
            self.recover()
        self.assertEqual(self.journal.snapshot(), before)
        with self.assertRaisesRegex(HealthError, "INCIDENT_RECOVERY_REUSED"):
            self.recover(proof={**self.proof, "incidentContextSha256": self.journal.recovery_context()})
        self.assertEqual(self.journal.snapshot(), before)

    def test_server_only_receipt_cannot_replace_complete_daily(self):
        self.acknowledge()
        self.journal.transition("verifying", "a" * 64)
        self.prepare_recovery()
        receipt = copy.deepcopy(self.healthy)
        receipt["checks"] = [c for c in receipt["checks"] if c["check"] in {
            "server-evidence:before", "server-evidence:after", "project-experiences"}]
        receipt["checkCount"] = len(receipt["checks"])
        proof = {**self.proof, "receiptSha256": digest(canonical(receipt))}
        before = self.journal.snapshot()
        with self.assertRaisesRegex(HealthError, "INCIDENT_RECOVERY_RECEIPT"):
            self.recover(receipt, proof)
        self.assertEqual(self.journal.snapshot(), before)

    def test_every_daily_check_is_required_and_cannot_be_replaced_by_duplicate_or_unknown(self):
        self.acknowledge()
        self.journal.transition("verifying", "a" * 64)
        self.prepare_recovery()
        before = self.journal.snapshot()
        for index, check in enumerate(self.healthy["checks"]):
            for mutation in ("delete", "duplicate", "unknown"):
                with self.subTest(check=check["check"], mutation=mutation):
                    receipt = copy.deepcopy(self.healthy)
                    if mutation == "delete":
                        del receipt["checks"][index]
                    elif mutation == "duplicate":
                        receipt["checks"][index] = copy.deepcopy(receipt["checks"][(index + 1) % len(receipt["checks"])])
                    else:
                        receipt["checks"][index]["check"] = "unknown-check"
                    receipt["checkCount"] = len(receipt["checks"])
                    proof = {**self.proof, "receiptSha256": digest(canonical(receipt))}
                    with self.assertRaisesRegex(HealthError, "INCIDENT_RECOVERY_RECEIPT"):
                        self.recover(receipt, proof)
                    self.assertEqual(self.journal.snapshot(), before)
        receipt = copy.deepcopy(self.healthy)
        receipt["checks"].append(copy.deepcopy(receipt["checks"][0]))
        receipt["checkCount"] += 1
        with self.assertRaisesRegex(HealthError, "INCIDENT_RECOVERY_RECEIPT"):
            self.recover(receipt, {**self.proof, "receiptSha256": digest(canonical(receipt))})

    def test_missing_wrong_or_tampered_baseline_blocks_validation_and_restore(self):
        self.acknowledge()
        self.journal.transition("verifying", "a" * 64)
        self.prepare_recovery()
        changed = copy.deepcopy(self.baseline)
        changed["files"].pop("/robots.txt")
        wrong_identity = copy.deepcopy(self.baseline)
        wrong_identity["identity"]["commit_sha"] = "e" * 40
        for baseline in (None, changed, wrong_identity):
            with self.subTest(baseline=baseline is None), self.assertRaises(HealthError):
                self.journal.recover(self.healthy, self.proof, baseline=baseline)
        receipt = {**self.healthy, "identity": wrong_identity["identity"]}
        with self.assertRaisesRegex(HealthError, "INCIDENT_RECOVERY_BASELINE"):
            self.recover(receipt, {**self.proof, "receiptSha256": digest(canonical(receipt))})
        # 即使同步篡改基线摘要，也不能让原检查集合冒充另一基线。
        receipt = {**self.healthy, "baselineSha256": digest(canonical(changed))}
        with self.assertRaisesRegex(HealthError, "INCIDENT_RECOVERY_RECEIPT"):
            validate_recovery(receipt, {**self.proof, "receiptSha256": digest(canonical(receipt))}, baseline=changed)
        self.recover()
        record = self.journal.snapshot()
        for baselines in ({}, {digest(canonical(self.baseline)): changed}):
            with self.subTest(archive=bool(baselines)), self.assertRaises(HealthError):
                self.restore(record, baselines=baselines)

    def test_required_public_checks_follow_expanded_baseline(self):
        from ops.monitor.public_health import sample
        from test_public_health import Fixture, NOW
        fixture = Fixture()
        fixture.bodies["/extra.txt"] = b"extra"
        fixture.baseline["files"]["/extra.txt"] = digest(b"extra")
        fixture.baseline["pages"] = [*fixture.baseline["pages"], "/extra/"]
        fixture.bodies["/extra/"] = fixture.bodies["/"].replace(b'href="https://www.axialmuse.com/"',
                                                              b'href="https://www.axialmuse.com/extra/"')
        fixture.baseline["files"]["/extra/"] = digest(fixture.bodies["/extra/"])
        fixture.baseline["rules"]["/old-extra"] = "/extra/"
        fixture.bodies["/sitemap.xml"] = fixture.bodies["/sitemap.xml"].replace(
            b"</urlset>", b"<url><loc>https://www.axialmuse.com/extra/</loc></url></urlset>")
        fixture.baseline["files"]["/sitemap.xml"] = digest(fixture.bodies["/sitemap.xml"])
        self.acknowledge()
        self.journal.transition("verifying", "a" * 64)
        self.prepare_recovery()
        public = sample(fixture.baseline, fixture, now=NOW)
        self.assertEqual(public["status"], "passed")
        receipt = {**self.healthy, "baselineSha256": public["baselineSha256"], "checks": [
            *public["checks"], *(c for c in self.healthy["checks"] if c["check"] in {
                "server-evidence:before", "server-evidence:after", "project-experiences"})]}
        receipt["checkCount"] = len(receipt["checks"])
        proof = {**self.proof, "receiptSha256": digest(canonical(receipt))}
        validate_recovery(receipt, proof, baseline=fixture.baseline)
        for name in ("payload:/extra.txt", "payload:/extra/", "page:/extra/",
                     "redirect:0:axialmuse.com:/old-extra", "redirect:1:www.axialmuse.com:/old-extra"):
            changed = copy.deepcopy(receipt)
            changed["checks"] = [c for c in changed["checks"] if c["check"] != name]
            changed["checkCount"] = len(changed["checks"])
            with self.subTest(name=name), self.assertRaisesRegex(HealthError, "INCIDENT_RECOVERY_RECEIPT"):
                validate_recovery(changed, {**proof, "receiptSha256": digest(canonical(changed))}, baseline=fixture.baseline)

    def test_new_observation_reconciliation_or_verification_round_invalidates_proof(self):
        self.acknowledge()
        self.journal.transition("verifying", "a" * 64)
        self.prepare_recovery()
        original = self.journal.snapshot()
        for mutation in ("observation", "reconciliation", "round", "incident"):
            journal = self.restore(original)
            if mutation == "observation":
                journal.observe("11", "1", self.diagnostic(fingerprint="d" * 64))
            elif mutation == "reconciliation":
                journal.reconcile("e" * 64)
            elif mutation == "round":
                journal.transition("investigating", "a" * 64)
                journal.transition("verifying", "a" * 64)
            else:
                journal = IncidentJournal("resource-11-1")
                journal.observe("11", "1", self.diagnostic())
                journal.transition("acknowledged", "a" * 64)
                journal.transition("investigating", "a" * 64)
                journal.transition("verifying", "a" * 64)
            before = journal.snapshot()
            with self.subTest(mutation=mutation), self.assertRaisesRegex(HealthError, "INCIDENT_RECOVERY_CONTEXT"):
                self.recover(journal=journal)
            self.assertEqual(journal.snapshot(), before)
        # 重复送达同一观察不产生新轮次，也不会使已核验证据失效。
        first = original["observations"][0]
        self.journal.observe("10", "1", {k: v for k, v in first.items() if k not in ("runId", "runAttempt")})
        self.recover()

    def test_rebinding_does_not_make_pre_verification_or_pre_reconciliation_sample_fresh(self):
        self.acknowledge()
        self.journal.transition("verifying", "a" * 64)
        self.prepare_recovery()
        for boundary in ("verification", "reconciliation", "observation"):
            if boundary == "reconciliation":
                self.journal.reconcile("a" * 64)
            elif boundary == "observation":
                self.journal.observe("11", "1", self.diagnostic(fingerprint="d" * 64))
            gate = datetime.fromisoformat(self.journal.snapshot()["history"][-1]["atUtc"])
            receipt = {**self.healthy, "observedAtUtc": (gate - timedelta(seconds=1)).isoformat()}
            proof = {**self.proof, "incidentContextSha256": self.journal.recovery_context(),
                     "receiptSha256": digest(canonical(receipt))}
            before = self.journal.snapshot()
            with self.subTest(boundary=boundary), self.assertRaisesRegex(HealthError, "INCIDENT_RECOVERY_FRESHNESS"):
                self.recover(receipt, proof)
            self.assertEqual(self.journal.snapshot(), before)
        self.prepare_recovery()
        receipt = {**self.healthy, "completedAtUtc": "2000-01-01T00:00:00Z"}
        with self.assertRaisesRegex(HealthError, "INCIDENT_RECOVERY_FRESHNESS"):
            self.recover(receipt, {**self.proof, "receiptSha256": digest(canonical(receipt))})
        self.recover()

    def test_recurrence_needs_new_run_and_receipt_and_survives_replay(self):
        self.acknowledge()
        self.journal.transition("verifying", "a" * 64)
        self.prepare_recovery()
        self.recover()
        old_receipt, old_proof = copy.deepcopy(self.healthy), dict(self.proof)
        self.journal.observe("21", "1", self.diagnostic("MAINTENANCE_INODE_USED_CRITICAL", "e" * 64))
        self.journal.transition("verifying", "a" * 64)
        self.prepare_recovery(run_id="22")
        with self.assertRaisesRegex(HealthError, "INCIDENT_RECOVERY_REUSED"):
            self.recover(old_receipt, {**old_proof, "runId": "22", "incidentContextSha256": self.journal.recovery_context()})
        with self.assertRaisesRegex(HealthError, "INCIDENT_RECOVERY_REUSED"):
            self.recover(proof={**self.proof, "runId": "20"})
        # 同一 run 的新 attempt 有独立新回执时允许使用。
        self.prepare_recovery(run_id="20", attempt="2")
        self.recover()
        record = json.loads(canonical(self.journal.snapshot()))
        restored = self.restore(record, receipts={old_proof["receiptSha256"]: old_receipt,
                                                 self.proof["receiptSha256"]: self.healthy})
        self.assertEqual(restored.snapshot(), record)
        restored.observe("23", "1", self.diagnostic(fingerprint="f" * 64))
        restored.transition("verifying", "a" * 64)
        self.prepare_recovery(journal=restored, run_id="24")
        with self.assertRaisesRegex(HealthError, "INCIDENT_RECOVERY_REUSED"):
            self.recover(proof={**self.proof, "runId": "20", "runAttempt": "1"}, journal=restored)
        self.recover(journal=restored)


if __name__ == "__main__":
    unittest.main()

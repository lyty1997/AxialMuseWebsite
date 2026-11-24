"""四阶段资源诊断、回执过滤及真实/演练并存的行为反例。"""

import copy
import io
import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from ops.monitor import public_health
from ops.monitor.maintenance_runner import failure, main, public_receipt, run_maintenance, verified_source_sha
from ops.monitor.periodic import run_period
from ops.monitor.public_health import HealthError, canonical, digest, write_receipt
from ops.monitor.resource_protocol import Observations
import test_maintenance_runner as runner_fixtures
from test_public_health import Fixture


class ResourceAlertTests(unittest.TestCase):
    def setUp(self):
        self.base = runner_fixtures.MaintenanceRunnerTests()
        self.base.setUp()

    def drill(self, identifier="1" * 32):
        return {"schema": 2, "observedAtUtc": datetime.now(timezone.utc).isoformat(),
                "resourceFailure": "MAINTENANCE_DISK_FREE_WARNING", "drill": {
                    "id": identifier, "scenario": "disk-free-warning", "requestSha256": "a" * 64,
                    "runtimeSha256": "b" * 64, "siteIdentity": self.base.baseline["identity"],
                    "ledgerSha256": self.base.baseline["ledgerSha256"], "simulated": True}}

    def transport(self, values, *, before_read=None):
        values = iter(values)
        class Transport:
            def __init__(self):
                self.count = 0
            def fetch_observation(inner):
                inner.count += 1
                if before_read is not None:
                    before_read(inner.count)
                payload = next(values)
                return {"payload": copy.deepcopy(payload), "evidence": {
                    "schema": 1, "invocationId": f"inv-{inner.count:08d}", "commandId": "cmd-abcdefgh",
                    "instanceId": "lhins-abcdefgh", "createdTime": datetime.now(timezone.utc).isoformat(),
                    "commandSha256": "a" * 64, "outputSha256": digest(canonical(payload))}}
        return Transport()

    def execute(self, period, values, *, public_failure=False, before_read=None):
        observations = Observations()
        fixture = Fixture()
        fixture.certificate["notAfter"] = (datetime.now(timezone.utc) + timedelta(days=90)).strftime("%b %d %H:%M:%S %Y GMT")
        if public_failure:
            fixture.bodies["/"] += b"changed public payload"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "docs/contracts").mkdir(parents=True)
            (root / "docs/contracts/project-experiences.json").write_text(json.dumps({
                "kind": "axial_muse_project_experiences", "experiences": []}))
            (root / ".nvmrc").write_text("24.18.0\n")
            report = root / "monthly.json"
            def command(args, **_kwargs):
                output = b"v24.18.0\n" if "--version" in args else (
                    (self.base.baseline["identity"]["commit_sha"] + "\n").encode() if "rev-parse" in args else b"")
                if "scripts/maintenance/monthly-report.mjs" in args:
                    checks = [{"check": "expiry:" + key, "status": "passed"} for key in ("verification", "domain", "instance")]
                    write_receipt(report, {"schema": 1, "scope": "local-checkout", "status": "passed", "checks": checks,
                                           "checkCount": 3, "failedCount": 0, "content": []})
                return subprocess.CompletedProcess(args, 0, output, b"")
            def runner(*args, **kwargs):
                return run_period(*args, command_runner=command, **kwargs)
            try:
                with patch.object(public_health, "Transport", return_value=fixture):
                    receipt = run_maintenance(period, self.transport(values, before_read=before_read), self.base.policy, root=root,
                        node="/fixture/node", expiry=root / "expiry.json", monthly_output=report,
                        observations=observations, runner=runner)
            except Exception as error:
                receipt = failure(period, error)
        return public_receipt(observations.merge(receipt))

    def test_all_four_phases_preserve_real_and_drill_evidence_and_failure(self):
        for simulated in (False, True):
            for index, phase in enumerate(("bootstrap", "before", "after", "monthly-final")):
                with self.subTest(simulated=simulated, phase=phase):
                    diagnostic = self.drill() if simulated else {"schema": 1, "resourceFailure": "MAINTENANCE_INODE_USED_CRITICAL"}
                    receipt = self.execute("monthly" if index == 3 else "daily", [self.base.bundle] * index + [diagnostic])
                    self.assertEqual(receipt["status"], "failed")
                    key = "drillObservations" if simulated else "resourceObservations"
                    values = receipt[key]
                    self.assertEqual(len(values), 1)
                    self.assertEqual(values[0]["phase"], phase)
                    self.assertEqual(len(receipt["serverReadEvidence"]), index + 1)
                    checksum_key = "drillObservationSha256" if simulated else "resourceObservationSha256"
                    self.assertTrue(any(c.get(checksum_key) == digest(canonical(values[0])) for c in receipt["checks"]))
                    if index == 3:
                        self.assertEqual(receipt["localQualityCommandsExecuted"], 6)
                        self.assertTrue(any(c["check"] == "monthly-command:build" for c in receipt["checks"]))

    def test_invalid_drill_never_gets_legitimate_identity(self):
        for kind in ("extra", "scenario", "boolean", "identity", "ledger", "old", "runtime"):
            bundle = self.drill()
            if kind == "extra":
                bundle["extra"] = "private"
            elif kind == "scenario":
                bundle["drill"]["scenario"] = "inode-used-critical"
            elif kind == "boolean":
                bundle["drill"]["simulated"] = 1
            elif kind == "identity":
                bundle["drill"]["siteIdentity"] = {**bundle["drill"]["siteIdentity"], "commit_sha": "f" * 40}
            elif kind == "ledger":
                bundle["drill"]["ledgerSha256"] = "f" * 64
            elif kind == "runtime":
                bundle["drill"]["runtimeSha256"] = "not-a-digest"
            else:
                bundle["observedAtUtc"] = (datetime.now(timezone.utc) - timedelta(seconds=121)).isoformat()
            with self.subTest(kind=kind):
                receipt = self.execute("daily", [self.base.bundle, bundle])
                self.assertEqual(receipt["status"], "failed")
                self.assertEqual(receipt["drillObservations"], [])
                self.assertEqual(len(receipt["serverReadEvidence"]), 1)

    def test_different_drills_and_later_real_failure_survive_top_level_error(self):
        collector = Observations()
        transport = self.transport([self.drill(), self.drill("2" * 32), {"schema": 1, "resourceFailure": "MAINTENANCE_RESOURCE_READ"}])
        for phase in ("bootstrap", "before", "after"):
            observation = transport.fetch_observation()
            with self.assertRaises(HealthError):
                collector.failure(observation["payload"], phase, observation["evidence"], datetime.now(timezone.utc).timestamp())
        receipt = public_receipt(collector.merge(failure("daily", RuntimeError("private body"))))
        self.assertEqual([d["drill"]["id"] for d in receipt["drillObservations"]], ["1" * 32, "2" * 32])
        self.assertEqual(len(receipt["resourceObservations"]), 1)
        self.assertEqual(receipt["resourceObservations"][0]["level"], "unknown")
        self.assertEqual(receipt["failedCount"], 4)
        self.assertNotIn("private body", json.dumps(receipt))

    def test_healthy_run_has_explicit_empty_arrays_and_three_authenticated_reads(self):
        read_times = []
        receipt = self.execute("daily", [self.base.bundle] * 3,
                               before_read=lambda _count: read_times.append(datetime.now(timezone.utc)))
        self.assertEqual(receipt["status"], "passed")
        self.assertEqual(receipt["resourceObservations"], [])
        self.assertEqual(receipt["drillObservations"], [])
        self.assertEqual([d["phase"] for d in receipt["serverReadEvidence"]], ["bootstrap", "before", "after"])
        self.assertLessEqual(datetime.fromisoformat(receipt["startedAtUtc"]), read_times[0])
        self.assertLessEqual(read_times[0], datetime.fromisoformat(receipt["observedAtUtc"]))
        self.assertLessEqual(read_times[-1], datetime.fromisoformat(receipt["completedAtUtc"]))
        for token in ("lhins-abcdefgh", "cmd-abcdefgh", "inv-00000001"):
            self.assertNotIn(token, json.dumps(receipt))

    def test_public_failure_and_after_drill_are_both_preserved(self):
        receipt = self.execute("daily", [self.base.bundle, self.base.bundle, self.drill()], public_failure=True)
        self.assertEqual(receipt["status"], "failed")
        self.assertEqual(receipt["drillObservations"][0]["phase"], "after")
        codes = {c.get("code") for c in receipt["checks"]}
        self.assertIn("HEALTH_PAYLOAD_IDENTITY", codes)
        self.assertIn("MAINTENANCE_DISK_FREE_WARNING", codes)

    def test_receipt_projection_rejects_unknown_nested_fields(self):
        receipt = self.execute("daily", [self.drill()])
        receipt["drillObservations"][0]["private"] = "must not publish"
        with self.assertRaisesRegex(HealthError, "MONITOR_RECEIPT_DIAGNOSTIC"):
            public_receipt(receipt)

    def test_missing_arrays_cannot_be_projected_as_healthy_empty_arrays(self):
        receipt = self.execute("daily", [self.base.bundle] * 3)
        for field in ("drillObservations", "resourceObservations", "serverReadEvidence"):
            changed = copy.deepcopy(receipt)
            del changed[field]
            with self.subTest(field=field), self.assertRaisesRegex(HealthError, "MONITOR_RECEIPT_DIAGNOSTIC"):
                public_receipt(changed)

    def test_cli_drill_is_nonzero_and_writes_summary_without_private_identifiers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output, summary = root / "receipt.json", root / "summary.md"
            environment = {"MONITOR_POLICY_JSON": json.dumps(self.base.policy), "GITHUB_STEP_SUMMARY": str(summary),
                           "MONITOR_TAT_COMMAND_ID": "cmd-abcdefgh", "MONITOR_TAT_INSTANCE_ID": "lhins-abcdefgh"}
            with patch.dict(os.environ, environment, clear=True), \
                    patch("ops.monitor.maintenance_runner.TatTransport", return_value=self.transport([self.drill()])), \
                    patch("ops.monitor.maintenance_runner.verified_source_sha", return_value="f" * 40), \
                    patch("sys.stdout", new_callable=io.StringIO) as log:
                status = main(["--period", "daily", "--root", str(root), "--output", str(output)])
            receipt = json.loads(output.read_bytes())
            self.assertEqual(status, 1)
            self.assertEqual(receipt["workflowSourceSha"], "f" * 40)
            self.assertEqual(receipt["drillObservations"][0]["drill"]["siteIdentity"]["commit_sha"], "a" * 40)
            self.assertIn("受控演练", summary.read_text())
            self.assertIn("1" * 32, log.getvalue())
            self.assertNotIn("lhins-abcdefgh", summary.read_text() + log.getvalue())

    def test_collector_freezes_diagnostics_against_later_payload_mutation(self):
        observation = self.transport([self.drill()]).fetch_observation()
        collector = Observations()
        with self.assertRaises(HealthError):
            collector.failure(observation["payload"], "bootstrap", observation["evidence"], datetime.now(timezone.utc).timestamp())
        observation["payload"]["drill"]["id"] = "2" * 32
        self.assertEqual(collector.drills[0]["drill"]["id"], "1" * 32)

    def test_workflow_source_must_match_checkout_independent_of_site_identity(self):
        for source, head, valid in (("f" * 40, "f" * 40, True), ("f" * 40, "e" * 40, False), ("invalid", "f" * 40, False)):
            result = subprocess.CompletedProcess([], 0, (head + "\n").encode(), b"")
            with self.subTest(source=source, head=head), patch.dict("os.environ", {"GITHUB_SHA": source}), \
                    patch("ops.monitor.maintenance_runner.run_process", return_value=result):
                if valid:
                    self.assertEqual(verified_source_sha(Path("/fixture")), source)
                else:
                    with self.assertRaisesRegex(HealthError, "MONITOR_SOURCE_IDENTITY"):
                        verified_source_sha(Path("/fixture"))

    def test_cli_receipt_write_failure_is_nonzero_and_does_not_claim_evidence(self):
        with tempfile.TemporaryDirectory() as directory, patch("ops.monitor.maintenance_runner.write_receipt", side_effect=OSError), \
                patch("sys.stdout", new_callable=io.StringIO) as stream:
            status = main(["--period", "daily", "--root", directory, "--output", directory + "/receipt.json"])
        self.assertEqual(status, 1)
        self.assertIn("MONITOR_RECEIPT_WRITE", stream.getvalue())


if __name__ == "__main__":
    unittest.main()

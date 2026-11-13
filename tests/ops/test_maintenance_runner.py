"""动态基线、云证据新鲜度和失败回执的端到端边界。"""

import copy
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from ops.monitor import dns_health, public_health
from ops.monitor.maintenance_runner import baseline_from_bundle, main, public_receipt, run_maintenance
from ops.monitor.periodic import run_period
from ops.monitor.public_health import HealthError, write_receipt
from test_public_health import Fixture


class MaintenanceRunnerTests(unittest.TestCase):
    def setUp(self):
        fixture = Fixture()
        self.baseline = fixture.baseline
        self.policy = {key: self.baseline[key] for key in ("schema", "csp", "hsts", "addressDigest",
                                                           "minimumCertificateDays")}
        self.snapshot = {"schema": 1, "identity": self.baseline["identity"],
                         "ledgerSha256": self.baseline["ledgerSha256"], "ledgerHistorySha256": "f" * 64,
                         "ledgerHistoryEntries": 2, "publishedRoutes": self.baseline["pages"], "redirectEdges": []}
        self.bundle = {"schema": 1, "observedAtUtc": datetime.now(timezone.utc).isoformat(),
                       "snapshot": self.snapshot, "release": {key: self.baseline[key]
                                                               for key in ("files", "pages", "rules")}}

    def test_fresh_bundle_and_independent_policy_build_expected_baseline(self):
        self.assertEqual(baseline_from_bundle(self.bundle, self.policy, datetime.now(timezone.utc).timestamp()),
                         self.baseline)

    def test_expired_future_invalid_policy_and_noncanonical_files_fail(self):
        for mutation in ("old", "future", "policy", "identity", "file", "extra"):
            with self.subTest(mutation=mutation):
                bundle, policy = copy.deepcopy(self.bundle), copy.deepcopy(self.policy)
                if mutation == "old":
                    bundle["observedAtUtc"] = (datetime.now(timezone.utc) - timedelta(seconds=121)).isoformat()
                elif mutation == "future":
                    bundle["observedAtUtc"] = (datetime.now(timezone.utc) + timedelta(seconds=6)).isoformat()
                elif mutation == "policy":
                    policy["minimumCertificateDays"] = 0
                elif mutation == "identity":
                    bundle["snapshot"]["identity"]["commit_sha"] = "not-a-sha"
                elif mutation == "file":
                    bundle["release"]["files"]["/../secret"] = "a" * 64
                else:
                    bundle["release"]["ignored"] = True
                with self.assertRaises(HealthError):
                    baseline_from_bundle(bundle, policy, datetime.now(timezone.utc).timestamp())

    def test_every_read_rejects_changed_identity_ledger_or_release(self):
        for kind in ("identity", "ledger", "files", "rules", "history"):
            with self.subTest(kind=kind):
                changed = copy.deepcopy(self.bundle)
                if kind == "identity":
                    changed["snapshot"]["identity"]["commit_sha"] = "b" * 40
                elif kind == "ledger":
                    changed["snapshot"]["ledgerSha256"] = "a" * 64
                elif kind == "files":
                    changed["release"]["files"]["/"] = "a" * 64
                elif kind == "rules":
                    changed["release"]["rules"] = {}
                else:
                    changed["snapshot"]["ledgerHistorySha256"] = "a" * 64
                class Transport:
                    def __init__(self, first, second):
                        self.values = iter((first, second))
                    def fetch(self):
                        return next(self.values)
                def runner(_period, _baseline, reader, **_kwargs):
                    reader("1" * 64)
                with self.assertRaisesRegex(HealthError, "MONITOR_SNAPSHOT_DRIFT"):
                    run_maintenance("daily", Transport(self.bundle, changed), self.policy, root=Path("/fixture"),
                                    runner=runner)

    def test_bootstrap_wall_clock_jump_and_slow_fetch_are_rejected(self):
        class Transport:
            def fetch(inner_self):
                return self.bundle
        for walls, monotonic, code in (([1000, 1000], [0, 121], "MONITOR_EVIDENCE_TIMEOUT"),
                                       ([1000, 1010], [0, 0], "MONITOR_CLOCK_DRIFT")):
            with self.subTest(code=code):
                with self.assertRaisesRegex(HealthError, code):
                    run_maintenance("daily", Transport(), self.policy, root=Path("/fixture"),
                                    now=iter(walls).__next__, monotonic=iter(monotonic).__next__)

    def test_missing_configuration_creates_failed_receipt_without_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            with patch.dict(os.environ, {}, clear=True), redirect_stdout(io.StringIO()):
                status = main(["--period", "daily", "--root", str(Path(directory)), "--output", str(path)])
            self.assertEqual(status, 1)
            receipt = json.loads(path.read_text())
            self.assertEqual(receipt["status"], "failed")
            self.assertEqual(receipt["checks"][0]["check"], "monitor-bootstrap")
            self.assertFalse(receipt["serverLedgerInspected"])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_shared_receipt_excludes_private_expiry_and_unknown_fields(self):
        receipt = {"schema": 1, "period": "monthly", "status": "failed", "failedCount": 1, "checkCount": 1,
                   "content": [{"private": "secret"}], "checks": [{"check": "expiry:domain", "status": "failed",
                   "code": "MONTHLY_EXPIRY_APPROACHING", "daysRemaining": 3, "private": "secret"}]}
        projected = public_receipt(receipt)
        self.assertEqual(projected["checks"], [{"check": "expiry:domain", "status": "failed",
                                                "code": "MONTHLY_EXPIRY_APPROACHING"}])
        self.assertNotIn("secret", json.dumps(projected))
        self.assertNotIn("daysRemaining", json.dumps(projected))

    def test_weekly_cli_runs_full_binding_without_external_links(self):
        fixture = Fixture()
        fixture.certificate["notAfter"] = (datetime.now(timezone.utc) + timedelta(days=90)).strftime(
            "%b %d %H:%M:%S %Y GMT")
        class Transport:
            def fetch(inner_self):
                value = copy.deepcopy(self.bundle)
                value["observedAtUtc"] = datetime.now(timezone.utc).isoformat()
                return value
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "docs/contracts").mkdir(parents=True)
            (root / "docs/contracts/project-experiences.json").write_text(json.dumps({
                "kind": "axial_muse_project_experiences", "experiences": [{"status": "planned"}]}))
            output = root / "receipt.json"
            environment = {"MONITOR_POLICY_JSON": json.dumps(self.policy), "MONITOR_TAT_SECRET_ID": "fake-id",
                           "MONITOR_TAT_SECRET_KEY": "fake-key", "MONITOR_TAT_COMMAND_ID": "cmd-abcdefgh",
                           "MONITOR_TAT_INSTANCE_ID": "lhins-abcdefgh"}
            with patch.dict(os.environ, environment, clear=True), \
                    patch("ops.monitor.maintenance_runner.TatTransport", return_value=Transport()), \
                    patch.object(public_health, "Transport", return_value=fixture), \
                    patch.object(dns_health, "check_dns", return_value=[{"check": "dns-weekly:fixture", "status": "passed"}]), \
                    redirect_stdout(io.StringIO()):
                result = main(["--period", "weekly", "--root", str(root), "--output", str(output)])
                self.assertNotIn("MONITOR_TAT_SECRET_KEY", os.environ)
            receipt = json.loads(output.read_text())
            self.assertEqual(result, 0)
            self.assertEqual(receipt["status"], "passed")
            self.assertTrue(receipt["serverLedgerInspected"])
            self.assertTrue({"server-evidence:before", "server-evidence:after", "internal-links",
                             "dns-weekly:fixture", "project-experiences"} <= {c["check"] for c in receipt["checks"]})
            self.assertNotIn("fake-key", json.dumps(receipt))
            self.assertFalse(any(c["check"].startswith("external") for c in receipt["checks"]))

    def test_monthly_missing_expiry_is_failed_without_fabricated_date(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "receipt.json"
            environment = {"PATH": os.environ.get("PATH", ""), "MONITOR_POLICY_JSON": json.dumps(self.policy),
                           "MONITOR_TAT_COMMAND_ID": "cmd-abcdefgh", "MONITOR_TAT_INSTANCE_ID": "lhins-abcdefgh",
                           "MONITOR_TAT_SECRET_ID": "fake-id", "MONITOR_TAT_SECRET_KEY": "fake-key"}
            with patch.dict(os.environ, environment, clear=True), redirect_stdout(io.StringIO()):
                result = main(["--period", "monthly", "--root", str(root), "--output", str(output),
                               "--monthly-output", str(root / "monthly.json")])
            receipt = json.loads(output.read_text())
            self.assertEqual(result, 1)
            self.assertEqual(receipt["checks"][0]["code"], "MONITOR_EXPIRY")
            self.assertFalse((root / "monthly.json.expiry.json").exists())

    def test_monthly_complete_chain_rechecks_server_after_quality(self):
        fixture = Fixture()
        fixture.certificate["notAfter"] = (datetime.now(timezone.utc) + timedelta(days=90)).strftime(
            "%b %d %H:%M:%S %Y GMT")
        reads, commands = [], []
        class Transport:
            def fetch(inner_self):
                reads.append(len(reads))
                value = copy.deepcopy(self.bundle)
                value["observedAtUtc"] = datetime.now(timezone.utc).isoformat()
                return value
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "docs/contracts").mkdir(parents=True)
            (root / ".nvmrc").write_text("24.18.0\n")
            (root / "docs/contracts/project-experiences.json").write_text(json.dumps({
                "kind": "axial_muse_project_experiences", "experiences": [{"status": "planned"}]}))
            report_path = root / "monthly.json"
            def command(args, **_kwargs):
                commands.append(args)
                if "--version" in args:
                    stdout = b"v24.18.0\n"
                elif "rev-parse" in args:
                    stdout = (self.baseline["identity"]["commit_sha"] + "\n").encode()
                else:
                    stdout = b""
                if "scripts/maintenance/monthly-report.mjs" in args:
                    checks = [{"check": "expiry:" + item, "status": "passed"}
                              for item in ("verification", "domain", "instance")]
                    write_receipt(report_path, {"schema": 1, "scope": "local-checkout", "status": "passed",
                                               "checks": checks, "checkCount": 3, "failedCount": 0, "content": []})
                return subprocess.CompletedProcess(args, 0, stdout, b"")
            def runner(period, baseline, reader, **kwargs):
                return run_period(period, baseline, reader, command_runner=command, **kwargs)
            with patch.object(public_health, "Transport", return_value=fixture):
                result = run_maintenance("monthly", Transport(), self.policy, root=root, node="/fixture/node",
                                         expiry=root / "expiry.json", monthly_output=report_path, runner=runner)
            self.assertEqual(result["status"], "passed")
            self.assertEqual(len(reads), 4)
            self.assertEqual(result["checks"][-1]["check"], "monthly-final-evidence")
            self.assertEqual(result["localQualityCommandsExecuted"], 6)
            self.assertTrue(result["serverLedgerInspected"])
            self.assertGreater(len(commands), 6)


if __name__ == "__main__":
    unittest.main()

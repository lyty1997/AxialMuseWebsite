"""真实子进程清理及周期组合；月度命令计划使用本地 fixture。"""

import copy
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from ops.monitor import bounded_process
from ops.monitor.periodic import run_command, run_period
from ops.monitor.public_health import HealthError, canonical, digest, utc, write_receipt
from test_public_health import Fixture


class CommandProcessTests(unittest.TestCase):
    def test_timeout_and_interrupt_kill_descendants_and_reap_parent(self):
        for mode in ("timeout", "exited-parent", "interrupt", "terminate"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="axial-command-") as directory:
                ready, late = Path(directory) / "ready", Path(directory) / "late"
                child = ("import os,signal,sys,time; from pathlib import Path; "
                         "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                         "Path(sys.argv[1] + '.pending').write_text(str(os.getpid())); "
                         "os.replace(sys.argv[1] + '.pending', sys.argv[1]); time.sleep(10); "
                         "Path(sys.argv[2]).write_text('unexpected late write')")
                parent = ("import os,subprocess,sys,time; "
                          "subprocess.Popen([sys.executable, '-c', sys.argv[1], *sys.argv[2:]]); "
                          + ("os._exit(0)" if mode == "exited-parent" else "time.sleep(60)"))
                original_popen = subprocess.Popen
                original_selector = bounded_process.selectors.DefaultSelector
                processes = []

                def start(*args, **kwargs):
                    process = original_popen(*args, **kwargs)
                    processes.append(process)
                    return process

                def select_factory():
                    selector = original_selector()
                    if mode in ("interrupt", "terminate"):
                        select = selector.select

                        def interrupted(*args, **kwargs):
                            selector.select = select
                            deadline = time.monotonic() + 5
                            while not ready.exists() and time.monotonic() < deadline:
                                time.sleep(0.01)
                            self.assertTrue(ready.exists())
                            if mode == "terminate":
                                self.assertNotEqual(signal.getsignal(signal.SIGTERM), signal.SIG_DFL)
                                signal.raise_signal(signal.SIGTERM)
                            raise KeyboardInterrupt
                        selector.select = interrupted
                    return selector

                try:
                    previous_handler = signal.getsignal(signal.SIGTERM)
                    with patch("ops.monitor.periodic.subprocess.Popen", side_effect=start), \
                            patch.object(bounded_process.selectors, "DefaultSelector", side_effect=select_factory):
                        error = (SystemExit if mode == "terminate" else
                                 KeyboardInterrupt if mode == "interrupt" else subprocess.TimeoutExpired)
                        with self.assertRaises(error) as caught:
                            run_command([sys.executable, "-c", parent, child, str(ready), str(late)],
                                        cwd=directory, env=os.environ.copy(), timeout=2)
                    if mode == "terminate":
                        self.assertEqual(caught.exception.code, 128 + signal.SIGTERM)
                    self.assertEqual(signal.getsignal(signal.SIGTERM), previous_handler)
                    self.assertTrue(ready.exists())
                    child_pid = int(ready.read_text())
                    # 孤儿可能短暂保留为 zombie；它已终止，不能继续执行或写入。
                    deadline = time.monotonic() + 3
                    while True:
                        path = Path(f"/proc/{child_pid}/stat")
                        try:
                            state = path.read_text().rsplit(")", 1)[1].split()[0]
                        except (FileNotFoundError, ProcessLookupError):
                            break
                        if state == "Z":
                            break
                        self.assertLess(time.monotonic(), deadline, "后代仍在执行")
                        time.sleep(0.01)
                    self.assertFalse(late.exists())
                    self.assertIsNotNone(processes[0].returncode)
                finally:
                    for process in processes:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.wait()

    def test_success_returns_captured_bytes_and_exit_status(self):
        with tempfile.TemporaryDirectory(prefix="axial-command-") as directory:
            result = run_command([sys.executable, "-c", "import sys; print('out'); print('err', file=sys.stderr)"],
                                 cwd=directory, env=os.environ.copy(), timeout=5)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"out\n", b"err\n"))


class PeriodicTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="axial-periodic-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "repo"
        self.root.mkdir()
        (self.root / ".nvmrc").write_text("24.18.0\n")
        (self.root / "docs/contracts").mkdir(parents=True)
        self.registry = self.root / "docs/contracts/project-experiences.json"
        self.registry.write_text(json.dumps({"kind": "axial_muse_project_experiences", "experiences": [
            {"status": "planned", "hostname": "planned.example"}]}))
        self.baseline = Fixture().baseline
        self.output = Path(self.temporary.name) / "monthly.json"
        self.snapshot = {"schema": 1, "identity": self.baseline["identity"],
                         "ledgerSha256": self.baseline["ledgerSha256"], "ledgerHistorySha256": "f" * 64,
                         "ledgerHistoryEntries": 2, "publishedRoutes": self.baseline["pages"], "redirectEdges": []}
        self.receipt = {"schema": 1, "status": "passed", "checks": [], "failedCount": 0, "checkCount": 0,
                        "serverSnapshotSha256": digest(canonical(self.snapshot)), "serverLedgerInspected": True,
                        "identity": self.baseline["identity"], "mutationsPerformed": False}
        self.probe = Mock(side_effect=lambda *_args, **_kwargs: copy.deepcopy(self.receipt))
        self.commands = []
        self.environments = []
        self.break_step = None
        self.error = None
        self.dirty = False
        self.omit_expiry = False
        self.report_failures = []
        self.report_mutation = lambda report: None
        self.report_exit = None

    def read(self, challenge):
        return {"schema": 1, "challenge": challenge, "observedAtUtc": utc(), "snapshot": self.snapshot}

    def command(self, args, **kwargs):
        self.commands.append(args)
        self.environments.append(kwargs["env"])
        self.assertEqual(kwargs["timeout"], 2700)
        self.assertNotIn("shell", kwargs)
        if self.break_step and self.break_step in args:
            if self.error:
                raise self.error
            return subprocess.CompletedProcess(args, 1, b"private failure", b"private stderr")
        stdout = b""
        if "--version" in args:
            stdout = b"v24.18.0\n"
        if "rev-parse" in args:
            stdout = (self.baseline["identity"]["commit_sha"] + "\n").encode()
        if "status" in args and self.dirty:
            stdout = b" M source.ts\n"
        if "scripts/maintenance/monthly-report.mjs" in args:
            report = {"schema": 1, "scope": "local-checkout", "status": "passed", "failedCount": 0,
                      "checkCount": 0 if self.omit_expiry else 3, "content": [], "checks": [] if self.omit_expiry else [
                          {"check": "expiry:" + name, "status": "passed"} for name in ("verification", "domain", "instance")]}
            for name, code in self.report_failures:
                if name.startswith("content:"):
                    _, kind, identity = name.split(":")
                    report["content"].append({"kind": kind, "id": identity})
                    report["checks"].append({"check": name, "status": "passed"})
                next(check for check in report["checks"] if check["check"] == name).update(status="failed", code=code)
            report.update(failedCount=len(self.report_failures), checkCount=len(report["checks"]),
                          status="failed" if self.report_failures else "passed")
            self.report_mutation(report)
            write_receipt(self.output, report)
            return subprocess.CompletedProcess(args, self.report_exit if self.report_exit is not None else
                                               (1 if self.report_failures else 0), b"", b"")
        return subprocess.CompletedProcess(args, 0, stdout, b"")

    def monthly(self):
        return run_period("monthly", self.baseline, self.read, root=self.root, node="/fixture/node",
                          expiry=Path(self.temporary.name) / "private.json", monthly_output=self.output,
                          probe_runner=self.probe, command_runner=self.command)

    def test_daily_and_weekly_select_exact_features(self):
        for period, expected in (("daily", {}), ("weekly", {"internal_links": True, "dns": True, "external_links": True})):
            with self.subTest(period=period):
                result = run_period(period, self.baseline, self.read, root=self.root, probe_runner=self.probe)
                self.probe.assert_called_with(self.baseline, self.read, **expected)
                self.assertEqual(result["period"], period)
                self.assertFalse(result["productionMutationsPerformed"])

    def test_normal_monthly_plan_runs_every_required_command_in_order(self):
        result = self.monthly()
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["localQualityCommandsExecuted"], 6)
        phases = [r["check"] for r in result["checks"] if r["check"].startswith("monthly-command:")]
        self.assertEqual(phases, ["monthly-command:" + p for p in (
            "runtime", "source", "clean", "install", "report", "quality", "history", "typecheck", "test", "build",
            "source-final", "clean-final")])
        self.assertIn(["/fixture/node", "scripts/quality/run-isolated-npm.mjs", "ci"], self.commands)
        self.assertIn(["/fixture/node", "scripts/quality/run-isolated-npm.mjs", "run-script", "build"], self.commands)
        self.assertEqual(result["checks"][-1]["check"], "monthly-final-evidence")

    def test_no_credentials_node_options_or_proxy_leak_to_monthly_commands(self):
        with patch.dict(os.environ, {"MONITOR_PRIVATE_KEY": "private", "NODE_OPTIONS": "--require private",
                                     "HTTPS_PROXY": "https://secret.invalid/", "GITHUB_TOKEN": "private"}):
            self.monthly()
        self.assertTrue(self.environments)
        for environment in self.environments:
            self.assertTrue({"MONITOR_PRIVATE_KEY", "NODE_OPTIONS", "HTTPS_PROXY", "GITHUB_TOKEN"}.isdisjoint(environment))

    def test_failed_public_checks_prevent_all_monthly_commands(self):
        self.receipt.update(status="failed", failedCount=1, checkCount=1,
                            checks=[{"check": "fixture-public", "status": "failed", "code": "HEALTH_REDIRECT"}])
        result = self.monthly()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.commands, [])
        self.assertEqual(result["checks"][0]["code"], "HEALTH_REDIRECT")

    def test_install_failure_stops_report_and_quality_and_redacts_output(self):
        self.break_step = "ci"
        result = self.monthly()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.commands[-1][-1], "ci")
        self.assertEqual(result["localQualityCommandsExecuted"], 1)
        self.assertNotIn("private", str(result))
        self.assertEqual(result["checks"][-1]["code"], "PERIODIC_COMMAND_FAILED")

    def test_quality_failure_stops_history_typecheck_test_and_build(self):
        self.break_step = "quality"
        result = self.monthly()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.commands[-1][-1], "quality")

    def test_actual_quality_output_overflow_stops_monthly_and_retains_redacted_receipt(self):
        def command(args, **kwargs):
            if args[-1] == "quality":
                self.commands.append(args)
                return run_command([sys.executable, "-c", "import os; os.write(1,b'private'*3000000)"], **kwargs)
            return self.command(args, **kwargs)

        result = run_period("monthly", self.baseline, self.read, root=self.root, node="/fixture/node",
                            expiry=self.root / "private.json", monthly_output=self.output,
                            probe_runner=self.probe, command_runner=command)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["checks"][-1]["code"], "PERIODIC_OUTPUT_LIMIT")
        self.assertEqual(self.commands[-1][-1], "quality")
        self.assertFalse(any("scripts/quality/run-content-history.mjs" in args for args in self.commands))
        self.assertNotIn("private", json.dumps(result))
        self.assertEqual(result["failedCount"], sum(c["status"] == "failed" for c in result["checks"]))

    def test_failed_report_preserves_specific_checks_and_stops_quality(self):
        for name, code in (("expiry:domain", "MONTHLY_EXPIRY_APPROACHING"),
                           ("expiry:instance", "MONTHLY_EXPIRED"),
                           ("expiry:verification", "MONTHLY_EXPIRY_VERIFICATION"),
                           ("content:project:fixture", "MONTHLY_CONTENT_FUTURE")):
            with self.subTest(code=code):
                self.report_failures = [(name, code)]
                result = self.monthly()
                self.assertEqual(result["status"], "failed")
                self.assertIn({"check": name, "status": "failed", "code": code}, result["checks"])
                self.assertIn("scripts/maintenance/monthly-report.mjs", self.commands[-1])
                self.assertEqual(result["localQualityCommandsExecuted"], 1)
                self.assertEqual(result["failedCount"], sum(c["status"] == "failed" for c in result["checks"]))
                self.assertEqual(result["checkCount"], len(result["checks"]))
                self.output.unlink()

    def test_report_exit_and_structure_must_agree_before_merge(self):
        mutations = (lambda report: report.update(failedCount=0),
                     lambda report: report.update(status="passed"),
                     lambda report: report["checks"].pop(),
                     lambda report: report["checks"][-2].update(code="invalid"))
        self.report_failures = [("expiry:domain", "MONTHLY_EXPIRY_APPROACHING")]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.report_mutation = mutation
                result = self.monthly()
                self.assertEqual(result["checks"][-1]["code"], "PERIODIC_MONTHLY_REPORT")
                self.assertNotIn("content", result)
                self.output.unlink()
        self.report_mutation = lambda report: None
        for failures, exit_code in (([], 1), (self.report_failures, 0)):
            with self.subTest(exit_code=exit_code):
                self.report_failures, self.report_exit = failures, exit_code
                result = self.monthly()
                self.assertEqual(result["checks"][-1]["code"], "PERIODIC_MONTHLY_REPORT")
                self.assertNotIn("content", result)
                self.output.unlink()

    def test_report_failure_without_file_stops_without_inventing_checks(self):
        self.break_step = "scripts/maintenance/monthly-report.mjs"
        result = self.monthly()
        self.assertEqual(result["status"], "failed")
        self.assertNotIn("content", result)
        self.assertEqual(result["localQualityCommandsExecuted"], 1)
        self.assertIn(self.break_step, self.commands[-1])

    def test_timeout_and_start_error_are_explicit_nonzero_results(self):
        for error, code in ((subprocess.TimeoutExpired("fixture", 2700), "PERIODIC_COMMAND_TIMEOUT"),
                            (FileNotFoundError("private path"), "PERIODIC_COMMAND_START")):
            with self.subTest(code=code):
                self.break_step, self.error = "--version", error
                result = self.monthly()
                self.assertEqual(result["checks"][-1]["code"], code)

    def test_dirty_checkout_stops_before_dependency_install(self):
        self.dirty = True
        result = self.monthly()
        self.assertEqual(result["checks"][-1]["code"], "PERIODIC_DIRTY_SOURCE")
        self.assertEqual(self.commands[-1][0], "git")

    def test_old_output_or_missing_required_expiry_checks_cannot_pass(self):
        write_receipt(self.output, {})
        result = self.monthly()
        self.assertEqual(result["checks"][-1]["code"], "PERIODIC_OUTPUT_EXISTS")
        self.assertEqual(self.commands, [])
        self.output.unlink()
        self.omit_expiry = True
        result = self.monthly()
        self.assertEqual(result["checks"][-1]["code"], "PERIODIC_MONTHLY_REPORT")

    def test_monthly_endpoint_identity_drift_cannot_be_hidden_by_quality_success(self):
        def reader(challenge):
            value = self.read(challenge)
            value["snapshot"] = {**self.snapshot, "ledgerHistoryEntries": 3}
            return value
        result = run_period("monthly", self.baseline, reader, root=self.root, node="/fixture/node",
                            expiry=Path(self.temporary.name) / "private.json", monthly_output=self.output,
                            probe_runner=self.probe, command_runner=self.command)
        self.assertEqual(result["checks"][-1]["code"], "MONITOR_SNAPSHOT_DRIFT")
        self.assertEqual(result["status"], "failed")

    def test_unknown_period_cannot_fall_back_to_daily(self):
        with self.assertRaisesRegex(HealthError, "PERIODIC_PERIOD"):
            run_period("hourly", self.baseline, self.read, probe_runner=self.probe)
        self.probe.assert_not_called()

    def test_new_live_project_or_missing_registry_cannot_be_silently_skipped(self):
        self.registry.write_text(json.dumps({"kind": "axial_muse_project_experiences", "experiences": [
            {"status": "live", "hostname": "unmonitored.example"}]}))
        result = run_period("daily", self.baseline, self.read, root=self.root, probe_runner=self.probe)
        self.assertEqual(result["checks"][0]["code"], "PERIODIC_LIVE_EXPERIENCE_UNSUPPORTED")
        self.registry.unlink()
        result = run_period("daily", self.baseline, self.read, root=self.root, probe_runner=self.probe)
        self.assertEqual(result["checks"][0]["code"], "PERIODIC_PROJECT_REGISTRY")
        self.probe.assert_not_called()

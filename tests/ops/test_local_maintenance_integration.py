"""退役→一致备份/日志→持久维护结果→原监测入口的最短组合。"""

import contextlib
import io
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from ops.deploy.deployment_state import DeploymentError, write_new
from ops.deploy.release_retirement import ReleaseRetirement, initialize_retirements
from ops.maintenance.installed import run_job
from ops.maintenance.ledger_backup import LedgerBackups
from ops.maintenance.local_state import LocalMaintenanceState
from ops.maintenance.log_retention import LogArchiveRetention
from ops.monitor.bounded_process import ProcessOutputLimit
from ops.monitor.server_evidence import release_bundle
from ops.monitor import installed_snapshot
from test_artifact_verifier import default_rules
from test_release_transaction import ReleaseFixture


class LocalMaintenanceIntegrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="axial-maintenance-chain-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.fixture = f = ReleaseFixture(self.root)
        for sha, registered in (("a" * 40, False), ("b" * 40, True)):
            stage, identity = f.stage(sha, rules=default_rules() if registered else default_rules()[2:])
            f.approve(identity, registered=registered)
            f.engine.execute(stage=stage, identity=identity)
        with f.state.locked():
            initialize_retirements(f.state)
        retirement = ReleaseRetirement(f.store, lifecycle_lock=contextlib.nullcontext,
            reference_probe=lambda: {"schema": 1, "protected": ["b" * 40], "evidence": "e" * 64})
        retirement.execute(retirement.plan("a" * 40, "d" * 32))
        self.backups = LedgerBackups(f.state, self.root / "backups")
        self.backups.initialize()
        logs = self.root / "logs"
        logs.mkdir(mode=0o755)
        active = logs / "error.log"
        write_new(active, b"", 0o640)
        self.archive = logs / "error.log.14.gz"
        write_new(self.archive, b"synthetic", 0o640)
        os.utime(self.archive, (time.time() - 90 * 86400,) * 2)
        self.logs = LogArchiveRetention([(active, os.getuid(), os.getgid(), 4)], uid=os.getuid())
        self.local = LocalMaintenanceState(f.state.home / "maintenance", os.getuid())
        self.local.initialize()

        def backup():
            self.backups.prune(self.backups.create())
            return {"status": "ok", "code": "OK"}

        def logs_job():
            self.logs.execute(self.logs.plan())
            return {"status": "ok", "code": "OK"}

        self.jobs = {"resources": lambda: {"status": "ok", "code": "OK"},
                     "backup": backup, "logs": logs_job}

    def snapshot_command(self):
        output = io.BytesIO()
        errors = io.StringIO()
        with patch.object(installed_snapshot, "DeploymentState", return_value=self.fixture.state), \
                patch.object(installed_snapshot, "ReleaseStore", return_value=self.fixture.store), \
                patch.object(installed_snapshot, "verifier_lock", contextlib.nullcontext), \
                patch.object(installed_snapshot, "load_verifier", return_value=None), \
                patch.object(installed_snapshot, "installed_observation", side_effect=lambda bundle: bundle), \
                patch.object(installed_snapshot.sys, "argv", ["axialmuse-monitor-snapshot"]), \
                patch.object(installed_snapshot.sys, "stdout", SimpleNamespace(buffer=output)), \
                contextlib.redirect_stderr(errors):
            status = installed_snapshot.main()
        return status, output.getvalue(), errors.getvalue()

    def test_green_chain_failure_latch_and_explicit_recovery_through_original_monitor(self):
        baseline = release_bundle(self.fixture.store)["snapshot"]
        self.assertEqual(self.local.execute(self.jobs)["status"], "ok")
        self.local.enable()
        self.assertEqual(release_bundle(self.fixture.store)["snapshot"], baseline)
        self.assertEqual(self.snapshot_command()[0], 0)
        self.assertFalse(self.archive.exists())
        snapshot = self.backups.snapshots()[-1][0]
        self.assertEqual(self.backups.restore_isolated(snapshot, self.root / "restored"), self.fixture.state.read_ledger())
        write_new(self.archive, b"synthetic", 0o666)
        failed = self.local.execute(self.jobs)
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["checks"][2]["code"], "MAINTENANCE_LOG_FILE")
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOCAL_FAILED"):
            release_bundle(self.fixture.store)
        status, stdout, stderr = self.snapshot_command()
        self.assertEqual(status, 1)
        self.assertEqual(stdout, b"")
        self.assertIn("MAINTENANCE_LOCAL_FAILED", stderr)
        self.archive.chmod(0o640)
        self.local.execute(self.jobs)
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOCAL_FAILED"):
            release_bundle(self.fixture.store)
        self.local.acknowledge(failed["id"])
        self.assertEqual(release_bundle(self.fixture.store)["snapshot"], baseline)

    def test_lifecycle_lock_failure_is_persisted_before_any_job_can_write(self):
        @contextlib.contextmanager
        def busy():
            raise DeploymentError("DEPLOY_VERIFIER_BUSY")
            yield

        result = self.local.execute(self.jobs, guard=busy)
        self.assertEqual(result["checks"][0]["code"], "DEPLOY_VERIFIER_BUSY")
        self.assertEqual(self.backups.snapshots(), [])
        self.assertTrue(self.archive.exists())
        self.assertEqual(self.local.records()[0]["result"]["status"], "failed")

    def test_worker_timeout_and_output_excess_become_nonzero_durable_results(self):
        for error, code in ((subprocess.TimeoutExpired("fixture", 1), "MAINTENANCE_JOB_TIMEOUT"),
                            (ProcessOutputLimit(), "MAINTENANCE_JOB_OUTPUT")):
            with self.subTest(code=code):
                def failed_command(*_args, **_kwargs):
                    raise error
                jobs = {**self.jobs, "resources": lambda: run_job("resources", command=failed_command)}
                result = self.local.execute(jobs)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["checks"][0]["code"], code)
                self.assertEqual(self.backups.snapshots(), [])

    def test_monitor_does_not_ignore_pending_even_with_a_new_success(self):
        self.local.execute(self.jobs)
        self.local.enable()
        def interrupted():
            raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.local.execute({**self.jobs, "backup": interrupted})
        self.local.execute(self.jobs)
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOCAL_PENDING"):
            release_bundle(self.fixture.store)


class MaintenanceTemplateTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("systemd-analyze"), "需要 systemd-analyze")
    def test_real_systemd_verifies_service_timer_in_isolated_root(self):
        templates = Path(__file__).resolve().parents[2] / "ops/maintenance/templates"
        with tempfile.TemporaryDirectory(prefix="axial-systemd-root-") as temporary:
            root = Path(temporary)
            units = root / "etc/systemd/system"
            units.mkdir(parents=True)
            for name in ("axialmuse-local-maintenance.service", "axialmuse-local-maintenance.timer"):
                (units / name).write_bytes((templates / name).read_bytes())
            for target in ("sysinit", "basic", "shutdown", "timers", "local-fs"):
                (units / f"{target}.target").write_text("[Unit]\nDescription=Fixture\n")
            binary = root / "usr/local/sbin/axialmuse-local-maintenance"
            binary.parent.mkdir(parents=True)
            binary.write_text("#!/bin/sh\nexit 0\n")
            binary.chmod(0o755)
            result = subprocess.run([shutil.which("systemd-analyze"), "--root=" + str(root), "--man=no", "verify",
                "axialmuse-local-maintenance.service", "axialmuse-local-maintenance.timer"],
                capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr.decode())


if __name__ == "__main__":
    unittest.main()

"""退役→一致备份/日志→持久维护结果→原监测入口的最短组合。"""

import contextlib
import configparser
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
from ops.maintenance.local_state import LocalMaintenanceState, WeeklyBackupState
from ops.maintenance import installed, weekly_backup
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
                patch("ops.monitor.server_evidence.assert_weekly_healthy"), \
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
            names = ("axialmuse-local-maintenance.service", "axialmuse-local-maintenance.timer",
                     "axialmuse-ledger-backup.service", "axialmuse-ledger-backup.timer")
            for name in names:
                (units / name).write_bytes((templates / name).read_bytes())
            for target in ("sysinit", "basic", "shutdown", "timers", "local-fs"):
                (units / f"{target}.target").write_text("[Unit]\nDescription=Fixture\n")
            binary = root / "usr/local/sbin/axialmuse-local-maintenance"
            binary.parent.mkdir(parents=True)
            binary.write_text("#!/bin/sh\nexit 0\n")
            binary.chmod(0o755)
            weekly_binary = binary.with_name("axialmuse-ledger-backup")
            weekly_binary.write_text("#!/bin/sh\nexit 0\n")
            weekly_binary.chmod(0o755)
            result = subprocess.run([shutil.which("systemd-analyze"), "--root=" + str(root), "--man=no", "verify",
                *names],
                capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr.decode())


class WeeklyBackupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="axial-weekly-backup-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.fixture = ReleaseFixture(self.root)
        stage, identity = self.fixture.stage("a" * 40)
        self.fixture.approve(identity)
        self.fixture.engine.execute(stage=stage, identity=identity)
        self.now = int(time.time())
        self.local = WeeklyBackupState(self.fixture.state.home / "ledger-backup-maintenance",
                                       os.getuid(), clock=lambda: self.now)
        self.local.initialize()
        self.backups = LedgerBackups(self.fixture.state, self.root / "backups", clock=lambda: self.now)
        self.backups.initialize()
        self.jobs = {"resources": lambda: {"status": "ok", "code": "OK"}, "backup": self.backup}

    def backup(self):
        self.backups.prune(self.backups.create())
        return {"status": "ok", "code": "OK"}

    def healthy(self, *, force=False):
        with patch.object(weekly_backup, "WeeklyBackupState", return_value=self.local), \
                patch.object(weekly_backup, "LedgerBackups", return_value=self.backups):
            weekly_backup.assert_weekly_healthy(self.fixture.state, self.backups.root, force=force)

    def test_weekly_boundary_old_daily_gate_and_read_only_monitor(self):
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_SUCCESS_MISSING"):
            self.healthy(force=True)
        self.local.execute(self.jobs)
        self.local.enable()
        daily = LocalMaintenanceState(self.root / "daily", os.getuid(), clock=lambda: self.now)
        daily.initialize()
        daily.execute({name: self.jobs["resources"] for name in daily.jobs})
        daily.enable()
        original = self.fixture.state.read_ledger()
        self.now += 7 * 86400
        self.healthy()
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_STALE"):
            daily.assert_healthy()  # 仅改旧 timer 会在下一周前错误判过期。
        self.assertEqual(len(self.backups.snapshots()), 1)
        self.now += 86400
        self.healthy()
        self.now += 1
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_STALE"):
            self.healthy()
        self.assertEqual(self.fixture.state.read_ledger(), original)

    def test_two_distinct_weeks_restore_and_retention(self):
        self.local.execute(self.jobs)
        self.local.enable()
        first = self.backups.snapshots()[0][0]
        self.now += 7 * 86400
        self.local.execute(self.jobs)
        self.healthy()
        self.assertEqual(len(self.backups.snapshots()), 2)
        self.assertEqual(self.backups.restore_isolated(first, self.root / "restored"),
                         self.fixture.state.read_ledger())
        for _ in range(5):
            self.now += 7 * 86400
            self.local.execute(self.jobs)
        self.healthy()
        snapshots = self.backups.snapshots()
        self.assertFalse(first.exists())
        self.assertEqual(len(snapshots), 6)  # 恰好 35 天的边界副本仍保留。

    def test_missing_latest_backup_cannot_use_previous_week_as_success(self):
        self.local.execute(self.jobs)
        self.local.enable()
        first = self.backups.snapshots()[0][0]
        self.now += 7 * 86400
        self.local.execute(self.jobs)
        second = next(path for path, _ in self.backups.snapshots() if path != first)
        second.rename(self.root / "removed-latest")
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BACKUP_RUN_MISSING"):
            self.healthy()

    def test_resource_failure_and_pending_cannot_be_hidden_by_success(self):
        self.local.execute(self.jobs)
        self.local.enable()
        failed = self.local.execute({**self.jobs, "resources": lambda: {
            "status": "failed", "code": "MAINTENANCE_DISK_FREE_WARNING"}})
        self.assertEqual(failed["checks"][1]["status"], "blocked")
        self.assertEqual(len(self.backups.snapshots()), 1)
        self.now += 1
        self.local.execute(self.jobs)
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOCAL_FAILED"):
            self.healthy()
        self.local.acknowledge(failed["id"])
        self.healthy()
        def interrupted():
            raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.local.execute({**self.jobs, "backup": interrupted})
        self.local.execute(self.jobs)
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOCAL_PENDING"):
            self.healthy()

    def test_missing_roots_corrupt_copy_and_wrong_profile_fail_closed(self):
        self.local.execute(self.jobs)
        self.local.enable()
        snapshot = self.backups.snapshots()[0][0]
        content = (snapshot / "backup.json").read_bytes()
        (snapshot / "backup.json").write_bytes(b"corrupt")
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BACKUP_DIGEST"):
            self.healthy()
        (snapshot / "backup.json").write_bytes(content)
        moved = self.local.root.with_name("held-weekly-state")
        self.local.root.rename(moved)
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BACKUP_STATE_MISSING"):
            self.healthy()
        moved.rename(self.local.root)
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_SCHEMA"):
            LocalMaintenanceState(self.local.root, os.getuid(), clock=lambda: self.now).check()
        self.backups.root.rename(self.root / "held-backups")
        with self.assertRaises(DeploymentError):
            self.healthy()

    def test_daily_backup_slot_does_not_create_or_prune(self):
        self.local.execute(self.jobs)
        self.local.enable()
        output = io.BytesIO()
        with patch.object(installed, "STATE", self.fixture.state.home), \
                patch.object(installed, "BACKUPS", self.backups.root), \
                patch.object(installed, "DeploymentState", return_value=self.fixture.state), \
                patch.object(installed.os, "geteuid", return_value=0), \
                patch.object(installed.sys, "stdout", SimpleNamespace(buffer=output)), \
                patch.object(weekly_backup, "WeeklyBackupState", return_value=self.local), \
                patch.object(weekly_backup, "LedgerBackups", return_value=self.backups), \
                patch.object(LedgerBackups, "create", side_effect=AssertionError("daily write")), \
                patch.object(LedgerBackups, "prune", side_effect=AssertionError("daily prune")):
            self.assertEqual(installed.worker("backup"), 0)
            self.assertEqual(installed.worker("backup"), 0)
        self.assertEqual(len(self.backups.snapshots()), 1)

    def test_weekly_entry_runs_only_resources_and_backup(self):
        output = io.StringIO()
        calls = []
        def job(name):
            calls.append(name)
            return self.backup() if name == "weekly-backup" else self.jobs["resources"]()
        with patch.object(weekly_backup.sys, "argv", ["axialmuse-ledger-backup"]), \
                patch.object(weekly_backup.os, "geteuid", return_value=0), \
                patch.object(weekly_backup, "WeeklyBackupState", return_value=self.local), \
                patch.object(weekly_backup, "verifier_lock", contextlib.nullcontext), \
                patch.object(installed, "run_job", side_effect=job), contextlib.redirect_stdout(output):
            self.assertEqual(weekly_backup.main(), 0)
        self.assertEqual(calls, ["resources", "weekly-backup"])
        self.assertEqual(len(self.backups.snapshots()), 1)

    def test_launcher_failure_is_recorded_in_weekly_state(self):
        from ops import runtime_bootstrap
        errors = io.StringIO()
        with patch.object(runtime_bootstrap.sys, "argv", ["bootstrap", "axialmuse-ledger-backup"]), \
                patch.object(runtime_bootstrap, "launch", side_effect=BlockingIOError()), \
                patch.object(runtime_bootstrap, "record_maintenance_failure") as record, \
                contextlib.redirect_stderr(errors):
            self.assertEqual(runtime_bootstrap.main(), 1)
        record.assert_called_once_with("DEPLOY_VERIFIER_BUSY",
            root=Path("/var/lib/axialmuse/ledger-backup-maintenance"))

    def test_weekly_initialize_only_creates_its_own_roots(self):
        self.local.root.rename(self.local.root.with_name("held-state"))
        self.backups.root.rename(self.root / "held-backups")
        with patch.object(weekly_backup.sys, "argv", ["axialmuse-ledger-backup-state", "--initialize"]), \
                patch.object(weekly_backup.os, "geteuid", return_value=0), \
                patch.object(weekly_backup, "DeploymentState", return_value=self.fixture.state), \
                patch.object(weekly_backup, "WeeklyBackupState", return_value=self.local), \
                patch.object(weekly_backup, "verifier_lock", contextlib.nullcontext), \
                patch.object(weekly_backup, "LedgerBackups", return_value=self.backups), \
                patch.object(installed, "BACKUPS", self.backups.root), \
                patch.object(installed, "logs_job", side_effect=AssertionError("unexpected log cleanup")):
            self.assertEqual(weekly_backup.manage(), 0)
        self.local.check()
        self.backups.check()
        self.assertEqual(self.local.records(), [])
        self.assertEqual(self.backups.snapshots(), [])
        self.assertFalse((self.fixture.state.home / "maintenance").exists())
        self.assertFalse((self.fixture.state.home / "log-retention").exists())

    def test_weekly_enable_resumes_durable_activation(self):
        from ops.maintenance import local_state
        self.local.execute(self.jobs)
        with patch.object(local_state.os, "replace", side_effect=OSError("interrupted activation")):
            with self.assertRaises(OSError):
                self.local.enable()
        with patch.object(weekly_backup.sys, "argv", ["axialmuse-ledger-backup-state", "--enable"]), \
                patch.object(weekly_backup.os, "geteuid", return_value=0), \
                patch.object(weekly_backup, "WeeklyBackupState", return_value=self.local), \
                patch.object(weekly_backup, "verifier_lock", contextlib.nullcontext), \
                patch.object(weekly_backup, "LedgerBackups", return_value=self.backups):
            self.assertEqual(weekly_backup.manage(), 0)
        self.healthy()

    def test_snapshot_monitor_propagates_weekly_failure(self):
        self.local.execute(self.jobs)
        self.local.enable()
        with patch("ops.monitor.server_evidence.assert_weekly_healthy", side_effect=lambda *a, **k: self.healthy()):
            baseline = release_bundle(self.fixture.store)["snapshot"]
            self.assertEqual(release_bundle(self.fixture.store)["snapshot"], baseline)
            self.local.execute({**self.jobs, "backup": lambda: {
                "status": "failed", "code": "MAINTENANCE_BACKUP_DIGEST"}})
            with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOCAL_FAILED"):
                release_bundle(self.fixture.store)

    def test_installed_monitor_rejects_both_backup_roots_missing(self):
        self.local.execute(self.jobs)
        self.local.enable()
        self.local.root.rename(self.local.root.with_name("held-state"))
        self.backups.root.rename(self.root / "held-backups")
        with patch.object(weekly_backup, "WeeklyBackupState", return_value=self.local):
            with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BACKUP_STATE_MISSING"):
                weekly_backup.assert_weekly_healthy(self.fixture.state, self.backups.root, required=True)
        with patch("ops.monitor.installed_snapshot.release_bundle", side_effect=DeploymentError("MAINTENANCE_BACKUP_STATE_MISSING")) as probe, \
                patch("ops.monitor.installed_snapshot.DeploymentState", return_value=self.fixture.state), \
                patch("ops.monitor.installed_snapshot.ReleaseStore", return_value=self.fixture.store), \
                patch("ops.monitor.installed_snapshot.load_verifier", return_value=None), \
                patch("ops.monitor.installed_snapshot.verifier_lock", contextlib.nullcontext), \
                patch.object(installed_snapshot.sys, "argv", ["axialmuse-monitor-snapshot"]), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(installed_snapshot.main(), 1)
        self.assertIs(probe.call_args.kwargs["weekly_required"], True)

    @unittest.skipUnless(shutil.which("systemd-analyze"), "需要 systemd-analyze")
    def test_real_weekly_calendar_keeps_seven_day_interval(self):
        timer = Path(__file__).resolve().parents[2] / "ops/maintenance/templates/axialmuse-ledger-backup.timer"
        config = configparser.ConfigParser(interpolation=None)
        config.read(timer)
        result = subprocess.run([shutil.which("systemd-analyze"), "calendar", "--iterations=2",
                                 "--base-time=2026-11-25 00:00:00 UTC", config["Timer"]["OnCalendar"]],
                                capture_output=True, timeout=15, env={**os.environ, "TZ": "UTC"})
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertIn("2026-11-30 22:17:00", result.stdout.decode())
        self.assertIn("2026-12-07 22:17:00", result.stdout.decode())


if __name__ == "__main__":
    unittest.main()

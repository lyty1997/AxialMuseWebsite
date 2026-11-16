"""例行失败不可被后续成功覆盖；启用、时效、锁与中断的持久证据。"""

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from ops.deploy.deployment_state import DeploymentError, canonical, write_new
from ops.maintenance.local_state import JOBS, LocalMaintenanceState
from ops import runtime_bootstrap


class LocalMaintenanceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="axial-local-maintenance-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.now = int(time.time())
        self.state = LocalMaintenanceState(self.root / "maintenance", os.getuid(), clock=lambda: self.now)
        self.state.initialize()
        self.jobs = {name: lambda: {"status": "ok", "code": "OK"} for name in JOBS}

    def test_enable_only_after_success_and_reject_stale(self):
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_SUCCESS_MISSING"):
            self.state.enable()
        self.assertEqual(self.state.execute(self.jobs)["status"], "ok")
        self.state.enable()
        self.state.assert_healthy()
        self.now += 25 * 3600
        self.state.assert_healthy()
        self.now += 1
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_STALE"):
            self.state.assert_healthy()

    def test_resource_failure_blocks_writes_and_later_success_does_not_clear_failure(self):
        self.state.execute(self.jobs)
        self.state.enable()
        writes = []
        jobs = {"resources": lambda: {"status": "failed", "code": "MAINTENANCE_DISK_FREE_CRITICAL"},
                "backup": lambda: writes.append("backup"), "logs": lambda: writes.append("logs")}
        failed = self.state.execute(jobs)
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(writes, [])
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_ACK"):
            self.state.acknowledge(failed["id"])  # 同秒旧成功不能充当修复后成功。
        self.state.execute(self.jobs)
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOCAL_FAILED"):
            self.state.assert_healthy()
        self.state.acknowledge(failed["id"])
        self.state.assert_healthy()

    def test_interrupt_keeps_pending_visible_even_after_next_success(self):
        self.state.execute(self.jobs)
        self.state.enable()
        def interrupted():
            raise KeyboardInterrupt()
        jobs = {**self.jobs, "backup": interrupted}
        with self.assertRaises(KeyboardInterrupt):
            self.state.execute(jobs)
        self.state.execute(self.jobs)
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOCAL_PENDING"):
            self.state.assert_healthy()
        pending = next(r for r in self.state.records() if r["result"] is None)
        self.state.acknowledge(pending["id"])
        self.state.assert_healthy()

    def test_lock_error_and_permission_drift_fail_without_new_success(self):
        self.state.execute(self.jobs)
        self.state.enable()
        with self.state.locked():
            with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BUSY"):
                self.state.execute(self.jobs)
        request = next((self.state.root / "runs").glob("*/request.json"))
        request.chmod(0o644)
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_MODE"):
            self.state.assert_healthy()

    def test_invalid_result_and_job_exception_fail_without_private_details(self):
        def private_error():
            raise OSError("private diagnostic must not leave process")
        result = self.state.execute({**self.jobs, "backup": private_error, "logs": lambda: {"status": "ok", "code": "bad"}})
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["checks"][1]["code"], "MAINTENANCE_INTERNAL")
        self.assertEqual(result["checks"][2]["code"], "MAINTENANCE_JOB_RESULT")
        self.assertNotIn("private diagnostic", str(self.state.records()))

    def test_old_installation_and_not_yet_enabled_layout_do_not_write(self):
        missing = LocalMaintenanceState(self.root / "absent", os.getuid())
        missing.assert_healthy()
        self.assertFalse(missing.root.exists())
        self.state.assert_healthy()
        self.assertFalse((self.state.root / "enabled").exists())

    def test_tampered_ack_cannot_cover_a_different_result(self):
        self.state.execute(self.jobs)
        failed = self.state.execute({**self.jobs, "logs": lambda: {"status": "failed", "code": "MAINTENANCE_LOG_FAILED"}})
        self.state.execute(self.jobs)
        self.state.acknowledge(failed["id"])
        ack = self.state.root / "runs" / failed["id"] / "ack.json"
        ack.write_bytes(canonical({"schema": 1, "requestSha256": "f" * 64,
                                  "resultSha256": "f" * 64, "acknowledged": self.now}))
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_ACK"):
            self.state.enable()

    def test_unknown_objects_fail_closed(self):
        write_new(self.state.root / "unknown", b"unknown")
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LAYOUT"):
            self.state.execute(self.jobs)

    def test_request_publication_interrupts_never_start_work_or_poison_next_run(self):
        from ops.maintenance import local_state
        for point in ("write_new", "rename_new"):
            calls = []
            jobs = {name: lambda: calls.append("work") or {"status": "ok", "code": "OK"} for name in JOBS}
            with self.subTest(point=point), patch.object(local_state, point, side_effect=OSError("power loss")):
                with self.assertRaises(OSError):
                    self.state.execute(jobs)
            self.assertEqual(calls, [])
            self.assertEqual(self.state.records(), [])
        success = self.state.execute(self.jobs)
        self.assertEqual(success["status"], "ok")
        self.assertEqual(len(self.state.records()), 1)

    def test_partial_preparation_is_not_a_run_but_unknown_objects_are_rejected(self):
        directory = self.state.root / "runs" / (".preparing-" + "f" * 32)
        directory.mkdir(mode=0o700)
        write_new(directory / "request.json", b'{"partial')
        self.assertEqual(self.state.execute(self.jobs)["status"], "ok")
        write_new(directory / "result.json", b"unknown")
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LAYOUT"):
            self.state.records()

    def test_initialization_is_published_whole_and_resumes_after_torn_writes(self):
        from ops.deploy import deployment_state
        for failure in (1, 2):
            root = self.root / f"new-{failure}"
            state = LocalMaintenanceState(root, os.getuid(), clock=lambda: self.now)
            original = deployment_state.write_new
            calls = 0
            def torn(path, content, *args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == failure:
                    original(path, content[:1], *args, **kwargs)
                    raise OSError("power loss")
                return original(path, content, *args, **kwargs)
            with patch.object(deployment_state, "write_new", torn):
                with self.assertRaises(OSError):
                    state.initialize()
            self.assertFalse(root.exists())
            state.initialize()
            self.assertEqual(state.execute(self.jobs)["status"], "ok")

    def test_activation_interrupt_can_resume_but_is_never_reported_healthy(self):
        self.state.execute(self.jobs)
        with patch("ops.maintenance.local_state.os.replace", side_effect=OSError("power loss")):
            with self.assertRaises(OSError):
                self.state.enable()
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_ACTIVATION"):
            self.state.assert_healthy()
        self.state.enable()
        self.state.assert_healthy()

    def test_import_time_failure_is_not_hidden_by_next_success_and_can_be_acknowledged(self):
        self.state.execute(self.jobs)
        self.state.enable()
        identifier = runtime_bootstrap.record_maintenance_failure(
            "DEPLOY_VERIFIER_BUSY", root=self.state.root, uid=os.getuid(), clock=lambda: self.now)
        self.state.execute(self.jobs)
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BOOTSTRAP_FAILED"):
            self.state.assert_healthy()
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_ACK"):
            self.state.acknowledge(identifier)
        self.now += 2
        self.state.execute(self.jobs)
        self.state.acknowledge(identifier)
        self.state.assert_healthy()

    def test_activation_resume_with_new_failure_completes_but_health_stays_failed(self):
        self.state.execute(self.jobs)
        with patch("ops.maintenance.local_state.os.replace", side_effect=OSError("power loss")):
            with self.assertRaises(OSError):
                self.state.enable()
        runtime_bootstrap.record_maintenance_failure(
            "DEPLOY_RUNTIME_INTEGRITY", root=self.state.root, uid=os.getuid(), clock=lambda: self.now)
        self.state.enable()
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BOOTSTRAP_FAILED"):
            self.state.assert_healthy()

    def test_launch_receipt_directory_loss_cannot_restore_a_legacy_bypass(self):
        self.state.execute(self.jobs)
        self.state.enable()
        (self.state.root / "launch-failures").rmdir()
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LAYOUT"):
            self.state.assert_healthy()

    def test_enabled_marker_or_lock_loss_does_not_restore_legacy_bypass(self):
        self.state.execute(self.jobs)
        self.state.enable()
        enabled = self.state.root / "enabled"
        original = enabled.read_bytes()
        enabled.unlink()
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_ACTIVATION"):
            self.state.assert_healthy()
        write_new(enabled, original)
        (self.state.root / "lock").unlink()
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LAYOUT"):
            self.state.assert_healthy()


if __name__ == "__main__":
    unittest.main()

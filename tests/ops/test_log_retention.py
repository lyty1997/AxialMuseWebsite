"""时间推进、空活动日志和真实 logrotate；不读取任何生产日志。"""

import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from ops.deploy.deployment_state import DeploymentError, write_new
from ops.maintenance.log_retention import LogArchiveRetention


class LogRetentionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="axial-log-retention-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.active = self.root / "error.log"
        write_new(self.active, b"", 0o640)
        self.archive = self.root / "error.log.14.gz"
        write_new(self.archive, b"synthetic log", 0o640)
        self.now = int(time.time()) + 1
        os.utime(self.archive, (self.now - 90 * 86400,) * 2)
        self.engine = LogArchiveRetention([(self.active, os.getuid(), os.getgid(), 4)],
                                         uid=os.getuid(), clock=lambda: self.now)

    def test_old_archive_removed_even_when_current_log_empty(self):
        plan = self.engine.plan()
        self.assertEqual([p["path"] for p in plan["files"]], [str(self.archive)])
        self.assertEqual(self.engine.execute(plan)["deletedArchives"], 1)
        self.assertEqual(self.active.stat().st_size, 0)
        self.assertFalse(self.archive.exists())

    def test_clock_advance_expires_archive_without_log_write(self):
        os.utime(self.archive, (self.now - 3 * 86400,) * 2)
        self.assertEqual(self.engine.plan()["files"], [])
        self.now += 86400
        self.assertEqual(self.engine.execute(self.engine.plan())["deletedArchives"], 1)

    def test_mutation_permission_unknown_name_and_future_timestamp_fail(self):
        plan = self.engine.plan()
        self.archive.write_bytes(b"changed")
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOG_DRIFT"):
            self.engine.execute(plan)
        self.archive.chmod(0o666)
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOG_FILE"):
            self.engine.plan()
        self.archive.chmod(0o640)
        self.archive.rename(self.root / "error.log.old")
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOG_UNKNOWN"):
            self.engine.plan()
        (self.root / "error.log.old").rename(self.archive)
        os.utime(self.archive, (self.now + 1,) * 2)
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOG_TIME"):
            self.engine.plan()

    @unittest.skipUnless(shutil.which("logrotate"), "需要实际 logrotate")
    def test_real_force_rotation_rotates_empty_file_with_ifempty(self):
        self.archive.unlink()
        config = self.root / "rotate.conf"
        state = self.root / "rotate.state"
        config.write_text(f"{self.active} {{\n daily\n rotate 4\n maxage 4\n ifempty\n nocompress\n create 0640\n}}\n")
        result = subprocess.run([shutil.which("logrotate"), "-f", "-s", str(state), str(config)],
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertTrue((self.root / "error.log.1").exists())
        self.assertTrue(self.active.exists())

    def test_symlink_and_expired_plan_cannot_delete(self):
        plan = self.engine.plan()
        self.now = plan["expires"]
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOG_PLAN"):
            self.engine.execute(plan)
        self.now = plan["created"]
        self.archive.unlink()
        self.archive.symlink_to(self.active)
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOG_FILE"):
            self.engine.plan()

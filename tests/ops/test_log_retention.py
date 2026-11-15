"""时间推进、空活动日志和真实 logrotate；不读取任何生产日志。"""

import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def test_existing_writer_is_preserved_and_released_file_can_be_recovered(self):
        plan = self.engine.plan()
        with self.archive.open("ab") as writer:
            with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOG_OPEN"):
                self.engine.execute(plan)
            writer.write(b"fresh")
            writer.flush()
            location = next(self.engine.quarantine.glob("*/data"))
            self.assertEqual(location.read_bytes(), b"synthetic logfresh")
        # 新写入不能被旧年龄授权覆盖；后续重新达到期限才可清理。
        self.assertEqual(self.engine.plan()["files"], [])
        self.now += 5 * 86400
        self.assertEqual(self.engine.execute(self.engine.plan())["deletedArchives"], 1)

    def test_late_nonblocking_open_is_rejected_by_kernel_lease(self):
        original = Path.unlink
        attempts = []
        def attempt(path, *args, **kwargs):
            if path.name == "data":
                # SIGIO 在 Python 层处理前，内核也必须拒绝此非阻塞 open。
                try:
                    fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
                except (BlockingIOError, DeploymentError):
                    attempts.append("blocked")
                    raise DeploymentError("MAINTENANCE_LOG_OPEN")
                else:
                    os.close(fd)
                    self.fail("租约没有保护最终 unlink")
            return original(path, *args, **kwargs)
        with patch.object(Path, "unlink", attempt):
            with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOG_OPEN"):
                self.engine.execute(self.engine.plan())
        self.assertEqual(attempts, ["blocked"])
        self.assertTrue(next(self.engine.quarantine.glob("*/data")).exists())

    def test_quarantine_move_interrupt_and_unknown_object_remain_visible(self):
        with patch("ops.maintenance.log_retention.rename_new", side_effect=OSError("power loss")):
            with self.assertRaises(OSError):
                self.engine.execute(self.engine.plan())
        self.assertTrue(self.archive.exists())
        self.assertEqual(self.engine.execute(self.engine.plan())["deletedArchives"], 1)
        write_new(self.engine.quarantine / "unknown", b"unknown")
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOG_QUARANTINE"):
            self.engine.plan()

    def test_templates_do_not_delete_outside_guarded_retention(self):
        templates = Path(__file__).resolve().parents[2] / "ops/maintenance/templates"
        for name in ("nginx", "rsyslog"):
            config = (templates / f"{name}.logrotate").read_text().splitlines()
            self.assertIn("    rotate -1", config)
            self.assertIn("    nocompress", config)
            self.assertFalse(any(line.strip().startswith("maxage") for line in config))
        self.assertIn("    su root syslog", (templates / "rsyslog.logrotate").read_text().splitlines())

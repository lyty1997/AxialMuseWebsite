"""时间推进、空活动日志和真实 logrotate；不读取任何生产日志。"""

import fcntl
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from ops.deploy.deployment_state import DeploymentError, write_new
from ops.maintenance import installed
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

    @unittest.skipUnless(shutil.which("logrotate"), "需要实际 logrotate")
    def rerun_after_interrupted_request(self, *, fresh=False, interrupt="move", rotated_while_down=False):
        self.archive = self.archive.rename(self.root / "error.log.1")
        target = ("ops.maintenance.log_retention.rename_new" if interrupt == "move"
                  else "ops.maintenance.log_retention.exclusive_inodes")
        with patch(target, side_effect=OSError("power loss")):
            with self.assertRaises(OSError):
                self.engine.execute(self.engine.plan())
        data = next(self.engine.quarantine.glob("*/data"), self.archive)
        if fresh:
            data.write_bytes(b"fresh log")
            os.utime(data, (self.now,) * 2)
        config = self.root / "rotate.conf"
        state = self.root / "rotate.state"
        write_new(state, b"", 0o600)
        config.write_text(f"{self.active} {{\n daily\n rotate -1\n ifempty\n nocompress\n create 0640\n}}\n")

        def command(arguments, code):
            if arguments[0] == "/usr/sbin/logrotate":
                if code != "external":
                    for record, _days in self.engine.pending():
                        self.assertEqual(Path(record["location"]).parent.parent, self.engine.quarantine,
                                         "待隔离请求未在轮转前进入私有目录")
                result = subprocess.run([shutil.which("logrotate"), "-f", "-s", str(state), str(config)],
                                        capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr.decode())

        if rotated_while_down:
            command(["/usr/sbin/logrotate"], "external")
            pending = self.engine.pending()
            self.assertEqual(pending[0][0]["location"], str(self.root / "error.log.2"))

        original_open = os.open

        def open_state(path, *args, **kwargs):
            return original_open(state if str(path) == "/var/lib/logrotate/status" else path, *args, **kwargs)

        with patch.object(installed, "check_log_configuration"), \
                patch.object(installed, "LogArchiveRetention", return_value=self.engine), \
                patch.object(installed, "LOGROTATE_STATE", state, create=True), \
                patch.object(installed.os, "open", side_effect=open_state), \
                patch.object(installed, "command_ok", side_effect=command):
            installed.logs_job(None)
        self.assertEqual(self.engine.plan()["files"], [])
        self.assertTrue((self.root / "error.log.1").exists())
        self.assertEqual((self.root / "error.log.1").read_bytes(), b"")
        if fresh:
            pending = self.engine.pending()
            self.assertEqual(len(pending), 1)
            self.assertNotEqual(pending[0][0]["location"], pending[0][0]["path"])
            self.assertEqual(Path(pending[0][0]["location"]).read_bytes(), b"fresh log")
            self.now += 5 * 86400
            self.engine.execute(self.engine.plan())
        self.assertEqual(self.engine.pending(), [])

    def test_installed_rerun_recovers_published_request_before_real_rotation(self):
        self.rerun_after_interrupted_request()

    def test_recently_written_pending_source_is_isolated_before_rotation_and_retained(self):
        self.rerun_after_interrupted_request(fresh=True)

    def test_already_moved_pending_file_survives_rotation_and_is_recovered(self):
        self.rerun_after_interrupted_request(fresh=True, interrupt="lease")

    def test_external_timer_rotation_during_interruption_recovers_original_inode(self):
        self.rerun_after_interrupted_request(rotated_while_down=True)

    def test_external_timer_rotation_preserves_recent_pending_and_new_archives(self):
        self.rerun_after_interrupted_request(fresh=True, rotated_while_down=True)

    def test_rotation_lock_conflict_and_pending_drift_stop_before_rotation(self):
        state = self.root / "rotate.state"
        write_new(state, b"", 0o600)
        with patch.object(installed, "check_log_configuration"), \
                patch.object(installed, "LogArchiveRetention", return_value=self.engine), \
                patch.object(installed, "LOGROTATE_STATE", state), \
                patch.object(installed, "command_ok") as command:
            with state.open("rb") as owner:
                fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(BlockingIOError):
                    installed.logs_job(None)
                command.assert_not_called()
            with patch("ops.maintenance.log_retention.rename_new", side_effect=OSError("power loss")):
                with self.assertRaises(OSError):
                    self.engine.execute(self.engine.plan())
            self.archive.rename(self.root / "replaced-archive")
            write_new(self.archive, b"different inode", 0o640)
            with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOG_DRIFT"):
                installed.logs_job(None)
            command.assert_not_called()

    def test_replaced_rotation_state_cannot_leave_us_holding_obsolete_lock(self):
        state = self.root / "rotate.state"
        write_new(state, b"", 0o600)
        flock = fcntl.flock

        def replace(fd, operation):
            flock(fd, operation)
            state.rename(self.root / "old.state")
            write_new(state, b"", 0o600)

        with patch.object(installed, "LOGROTATE_STATE", state), \
                patch.object(installed.fcntl, "flock", side_effect=replace):
            with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_LOGROTATE_LOCK"):
                with installed.logrotate_lock():
                    self.fail("取得旧 inode 锁后不得继续")

    def test_templates_do_not_delete_outside_guarded_retention(self):
        templates = Path(__file__).resolve().parents[2] / "ops/maintenance/templates"
        for name in ("nginx", "rsyslog"):
            config = (templates / f"{name}.logrotate").read_text().splitlines()
            self.assertIn("    rotate -1", config)
            self.assertIn("    nocompress", config)
            self.assertFalse(any(line.strip().startswith("maxage") for line in config))
        self.assertIn("    su root syslog", (templates / "rsyslog.logrotate").read_text().splitlines())

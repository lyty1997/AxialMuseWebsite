"""备份原子发布、旧副本保护及隔离恢复，不读写真实运维状态。"""

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from ops.deploy.deployment_state import DeploymentError
from ops.maintenance import ledger_backup
from ops.maintenance.ledger_backup import LedgerBackups
from test_release_transaction import ReleaseFixture


class LedgerBackupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="axial-ledger-backup-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.fixture = ReleaseFixture(self.root)
        stage, identity = self.fixture.stage("a" * 40)
        self.fixture.approve(identity)
        self.fixture.engine.execute(stage=stage, identity=identity)
        self.now = int(time.time())
        self.backups = LedgerBackups(self.fixture.state, self.root / "backups", clock=lambda: self.now)
        self.backups.initialize()

    def test_consistent_snapshot_and_isolated_restore_match_entire_chain(self):
        before = self.fixture.state.read_ledger()
        snapshot = self.backups.create()
        self.assertEqual(self.backups.verify(snapshot)[1], before)
        self.assertEqual(self.backups.restore_isolated(snapshot, self.root / "restored"), before)
        self.assertEqual(self.fixture.state.read_ledger(), before)
        self.assertEqual(snapshot.stat().st_mode & 0o777, 0o700)
        self.assertEqual((snapshot / "backup.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.backups.prune(snapshot)["verifiedBackups"], 1)
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_RESTORE_DESTINATION"):
            self.backups.restore_isolated(snapshot, self.fixture.home)

    def test_independent_location_and_explicit_initialization(self):
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BACKUP_LOCATION"):
            LedgerBackups(self.fixture.state, self.fixture.state.root / "backup")
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BACKUP_INITIALIZED"):
            self.backups.initialize()
        fresh = LedgerBackups(self.fixture.state, self.root / "not-initialized")
        with self.assertRaises(FileNotFoundError):
            fresh.create()
        self.assertFalse(fresh.root.exists())

    def test_retention_requires_new_verified_copy_and_keeps_at_least_two(self):
        first = self.backups.create()
        self.now += 40 * 86400
        second = self.backups.create()
        self.backups.prune(second)
        self.assertTrue(first.exists())
        self.now += 40 * 86400
        third = self.backups.create()
        result = self.backups.prune(third)
        self.assertEqual(result["verifiedBackups"], 2)
        self.assertFalse(first.exists())
        self.assertTrue(second.exists())
        self.assertTrue(third.exists())

    def test_corrupt_new_copy_never_deletes_old_backup(self):
        first = self.backups.create()
        self.now += 40 * 86400
        second = self.backups.create()
        self.now += 40 * 86400
        third = self.backups.create()
        (third / "backup.json").write_bytes(b"corrupted")
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BACKUP_DIGEST"):
            self.backups.prune(third)
        self.assertTrue(first.exists())
        self.assertTrue(second.exists())

    def test_prune_recovers_after_each_persistent_step(self):
        steps = (
            ("rename", "ops.maintenance.ledger_backup.rename_new", ledger_backup.rename_new,
             lambda path: True),
            ("rename-before-sync", "ops.deploy.release_install.sync_directory", ledger_backup.sync_directory,
             lambda path: path.name.startswith("backups-")),
            ("rename-sync", "ops.deploy.release_install.sync_directory", ledger_backup.sync_directory,
             lambda path: path.name.startswith("backups-")),
            ("backup.json", "pathlib.Path.unlink", Path.unlink,
             lambda path: path.name == "backup.json"),
            ("file-sync", "ops.maintenance.ledger_backup.sync_directory", ledger_backup.sync_directory,
             lambda path: path.name.startswith(".deleting-") and (path / "sha256").exists()),
            ("last-file-sync", "ops.maintenance.ledger_backup.sync_directory", ledger_backup.sync_directory,
             lambda path: path.name.startswith(".deleting-") and not (path / "sha256").exists()),
            ("sha256", "pathlib.Path.unlink", Path.unlink,
             lambda path: path.name == "sha256"),
            ("rmdir", "pathlib.Path.rmdir", Path.rmdir,
             lambda path: path.name.startswith(".deleting-")),
            ("root-sync", "ops.maintenance.ledger_backup.sync_directory", ledger_backup.sync_directory,
             lambda path: path.name.startswith("backups-") and not list(path.glob(".deleting-*"))),
        )
        for label, target, original, matches in steps:
            with self.subTest(step=label):
                backups = LedgerBackups(self.fixture.state, self.root / f"backups-{label}", clock=lambda: self.now)
                backups.initialize()
                first = backups.create()
                self.now += 40 * 86400
                second = backups.create()
                self.now += 40 * 86400
                third = backups.create()

                def interrupted(path, *args, **kwargs):
                    if label == "rename-before-sync" and matches(path):
                        raise KeyboardInterrupt("injected before rename sync")
                    result = original(path, *args, **kwargs)
                    if matches(path):
                        raise KeyboardInterrupt("injected after " + label)
                    return result

                with patch(target, interrupted):
                    with self.assertRaises(KeyboardInterrupt):
                        backups.prune(third)
                self.assertEqual([path for path, _ in backups.snapshots()], [second, third])
                self.assertEqual(backups.verify(second)[1], self.fixture.state.read_ledger())
                self.assertEqual(backups.verify(third)[1], self.fixture.state.read_ledger())
                self.assertFalse(first.exists())
                # 使用下一轮实际入口：先创建新副本，再恢复清理。
                result = backups.prune(backups.create())
                self.assertEqual(result["status"], "ok")
                self.assertEqual(result["verifiedBackups"], 2)
                self.assertEqual(list(backups.root.glob(".deleting-*")), [])

    def retired_fixture(self, label):
        backups = LedgerBackups(self.fixture.state, self.root / f"retired-{label}", clock=lambda: self.now)
        backups.initialize()
        first = backups.create()
        self.now += 40 * 86400
        second = backups.create()
        self.now += 40 * 86400
        third = backups.create()
        retired = first.with_name(".deleting-" + first.name)
        ledger_backup.rename_new(first, retired)
        return backups, retired, second, third

    def test_recovery_accepts_only_known_partial_contents_and_counts_verified_copies(self):
        for remaining in ((), ("backup.json",), ("sha256",), ("backup.json", "sha256")):
            with self.subTest(remaining=remaining):
                backups, retired, second, third = self.retired_fixture(str(len(remaining)) + "-" + "-".join(remaining))
                for name in ("backup.json", "sha256"):
                    if name not in remaining:
                        (retired / name).unlink()
                self.assertEqual([path for path, _ in backups.snapshots()], [second, third])
                result = backups.prune(third)
                self.assertEqual(result, {"status": "ok", "deletedBackups": 1, "verifiedBackups": 2})
                self.assertFalse(retired.exists())
                self.assertEqual(backups.prune(third)["deletedBackups"], 0)

    def test_recovery_requires_fresh_valid_copy_two_snapshots_and_durable_retirement(self):
        backups, retired, second, third = self.retired_fixture("gates")
        before = {name: (retired / name).read_bytes() for name in ("backup.json", "sha256")}
        with backups.locked():
            with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BACKUP_BUSY"):
                backups.prune(third)
        with patch("ops.maintenance.ledger_backup.sync_directory", side_effect=OSError("injected fsync")):
            with self.assertRaisesRegex(OSError, "injected fsync"):
                backups.prune(third)
        self.assertEqual({name: (retired / name).read_bytes() for name in before}, before)
        self.now += 26 * 3600 + 1
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BACKUP_FRESH"):
            backups.prune(third)
        self.now -= 26 * 3600 + 1
        original = (third / "backup.json").read_bytes()
        (third / "backup.json").write_bytes(b"corrupted")
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BACKUP_DIGEST"):
            backups.prune(third)
        (third / "backup.json").write_bytes(original)
        # 模拟独立丢失一个保留副本；待删除目录仍不得继续删除。
        second.rename(self.root / "saved-second")
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BACKUP_RETENTION"):
            backups.prune(third)
        self.assertEqual({name: (retired / name).read_bytes() for name in before}, before)

    def test_recovery_rejects_unknown_members_links_permissions_and_corruption(self):
        cases = ("unknown", "nested", "symlink", "hardlink", "directory-mode", "file-mode",
                 "bundle", "digest", "remaining-bundle", "remaining-digest", "directory-link")
        for case in cases:
            with self.subTest(case=case):
                backups, retired, second, third = self.retired_fixture(case)
                outside = self.root / ("outside-" + case)
                outside.write_bytes((retired / "sha256").read_bytes())
                outside.chmod(0o600)
                outside_before = outside.read_bytes()
                if case == "unknown":
                    (retired / "unknown").write_bytes(b"preserve")
                elif case == "nested":
                    (retired / "nested").mkdir(mode=0o700)
                elif case in ("symlink", "hardlink"):
                    (retired / "sha256").unlink()
                    if case == "symlink":
                        (retired / "sha256").symlink_to(outside)
                    else:
                        os.link(outside, retired / "sha256")
                elif case == "directory-mode":
                    retired.chmod(0o755)
                elif case == "file-mode":
                    (retired / "sha256").chmod(0o644)
                elif case in ("bundle", "remaining-bundle"):
                    (retired / "backup.json").write_bytes(b"{}\n")
                    if case == "remaining-bundle":
                        (retired / "sha256").unlink()
                elif case in ("digest", "remaining-digest"):
                    (retired / "sha256").write_bytes(b"0" * 64 + b"\n" if case == "digest" else b"invalid\n")
                    if case == "remaining-digest":
                        (retired / "backup.json").unlink()
                else:
                    moved = self.root / "moved-retired"
                    retired.rename(moved)
                    retired.symlink_to(moved, target_is_directory=True)
                with self.assertRaises((DeploymentError, OSError)):
                    backups.prune(third)
                self.assertTrue(os.path.lexists(retired))
                self.assertEqual(outside.read_bytes(), outside_before)
                self.assertEqual(backups.verify(second)[1], self.fixture.state.read_ledger())
                self.assertEqual(backups.verify(third)[1], self.fixture.state.read_ledger())

    def test_formal_damage_and_unknown_retirement_names_still_block_all_deletion(self):
        for case in ("formal-damage", "unknown-name", "duplicate-original"):
            with self.subTest(case=case):
                backups, retired, second, third = self.retired_fixture(case)
                before = {name: (retired / name).read_bytes() for name in ("backup.json", "sha256")}
                if case == "formal-damage":
                    (second / "backup.json").unlink()
                elif case == "unknown-name":
                    renamed = retired.with_name(".deleting-unknown")
                    retired.rename(renamed)
                    retired = renamed
                else:
                    original = retired.with_name(retired.name.removeprefix(".deleting-"))
                    original.mkdir(mode=0o700)
                    for name, content in before.items():
                        ledger_backup.write_new(original / name, content)
                with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BACKUP_FILES"):
                    backups.prune(third)
                self.assertEqual({name: (retired / name).read_bytes() for name in before}, before)
                self.assertEqual(backups.verify(third)[1], self.fixture.state.read_ledger())

    def test_interrupted_copy_is_not_usable_and_previous_remains(self):
        first = self.backups.create()
        with patch("ops.maintenance.ledger_backup.rename_new", side_effect=OSError("injected")):
            with self.assertRaises(OSError):
                self.backups.create()
        self.assertEqual([path for path, _ in self.backups.snapshots()], [first])
        self.assertEqual(len(list(self.backups.root.glob(".pending-*"))), 1)
        self.now += 40 * 86400
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BACKUP_FRESH"):
            self.backups.prune(first)
        self.assertTrue(first.exists())

    def test_lock_competition_and_broken_source_do_not_publish(self):
        with self.fixture.state.locked():
            with self.assertRaisesRegex(DeploymentError, "DEPLOY_LOCK_BUSY"):
                self.backups.create()
        with self.backups.locked():
            with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BACKUP_BUSY"):
                self.backups.create()
        self.assertEqual(self.backups.snapshots(), [])
        (self.fixture.state.history / "00000001.json").write_bytes(b"{}\n")
        with self.assertRaises(DeploymentError):
            self.backups.create()
        self.assertEqual(self.backups.snapshots(), [])

    def test_mode_symlink_unknown_and_future_time_fail(self):
        snapshot = self.backups.create()
        (snapshot / "backup.json").chmod(0o644)
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_MODE"):
            self.backups.verify(snapshot)
        (snapshot / "backup.json").chmod(0o600)
        self.now -= 1
        with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BACKUP_TIME"):
            self.backups.verify(snapshot)
        self.now += 1
        outside = self.root / "outside"
        outside.write_bytes(b"private")
        (snapshot / "sha256").unlink()
        (snapshot / "sha256").symlink_to(outside)
        with self.assertRaises(OSError):
            self.backups.verify(snapshot)


if __name__ == "__main__":
    unittest.main()

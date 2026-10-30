"""账本磁盘故障、锁与一次性批准的独立证据。"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from ops.deploy import deployment_state as state
from ops.deploy import url_exposure_ledger as ledger


IDENTITY = {"workflow_run_id": "1", "artifact_id": "2", "commit_sha": "a" * 40,
            "artifact_digest": "b" * 64, "release_content_sha256": "c" * 64}


class DeploymentStateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="axial-state-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.store = state.DeploymentState(self.home, os.getuid())
        self.store.initialize()
        self.before = self.store.read_ledger()[0]
        self.after = ledger.serialize_exposure_ledger(ledger.ExposureLedger(
            (ledger.PublishedRoute("/", "a" * 40),), (),
        ))

    def test_append_backup_chain_and_idempotence(self):
        with self.store.locked():
            self.store.append_ledger(self.before, self.after)
            self.assertEqual(self.store.read_ledger()[0], self.after)
            self.assertEqual(self.store.read_ledger()[2], 2)
            self.store.append_ledger(self.after, self.after)
            self.assertEqual(self.store.read_ledger()[2], 2)
            with self.assertRaises(ledger.UrlExposureError):
                self.store.append_ledger(self.after, self.before)

    def test_missing_ledger_never_reinitializes(self):
        self.store.ledger_path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.store.read_ledger()
        with self.assertRaises(FileExistsError):
            self.store.initialize()
        self.assertFalse(self.store.ledger_path.exists())

    def test_second_initializer_does_not_overwrite(self):
        with self.assertRaises(state.DeploymentError):
            self.store.initialize()
        self.assertEqual(self.store.read_ledger()[0], self.before)

    def test_crash_between_backup_and_head_blocks(self):
        with patch.object(state, "replace_file", side_effect=OSError("injected")):
            with self.assertRaises(OSError):
                self.store.append_ledger(self.before, self.after)
        with self.assertRaisesRegex(state.DeploymentError, "DEPLOY_LEDGER_HEAD"):
            self.store.read_ledger()

    def test_chain_gap_and_nonappend_are_rejected(self):
        self.store.append_ledger(self.before, self.after)
        event = self.store.history / "00000001.json"
        event.rename(self.store.history / "00000002.json")
        with self.assertRaisesRegex(state.DeploymentError, "DEPLOY_LEDGER_CHAIN"):
            self.store.read_ledger()

    def test_changed_history_hash_is_rejected(self):
        self.store.append_ledger(self.before, self.after)
        event = self.store.history / "00000001.json"
        value = state.decode(event.read_bytes())
        value["previous"] = "d" * 64
        event.write_bytes(state.canonical(value))
        with self.assertRaisesRegex(state.DeploymentError, "DEPLOY_LEDGER_CHAIN"):
            self.store.read_ledger()

    def test_lock_contention_and_pending_transaction_block(self):
        with self.store.locked():
            with self.assertRaisesRegex(state.DeploymentError, "DEPLOY_LOCK_BUSY"):
                with self.store.locked():
                    self.fail("lock granted twice")
            self.store.begin({"test": True})
            with self.assertRaisesRegex(state.DeploymentError, "DEPLOY_RECOVERY_REQUIRED"):
                self.store.assert_idle()

    def approval(self, **changes):
        result = {"id": "d" * 32, "identity": IDENTITY, "before": state.digest(self.before),
                  "after": state.digest(self.after), "expires": 2000}
        result.update(changes)
        state.write_new(self.store.root / "forward-only.json", state.canonical(result))

    def test_pending_overrides_success_until_complete(self):
        transaction = self.store.begin({"test": True})
        state.write_new(transaction / "result.json", state.canonical({
            "status": "local-accepted", "sha": "a" * 40,
        }))
        with self.assertRaisesRegex(state.DeploymentError, "DEPLOY_RECOVERY_REQUIRED"):
            self.store.assert_idle()
        self.store.complete(transaction)
        self.store.assert_idle()
        self.assertEqual(self.store.successful_releases(), {"a" * 40})

    def test_legacy_completed_transaction_remains_readable(self):
        transaction = self.store.transactions / ("a" * 32)
        transaction.mkdir(mode=0o700)
        state.write_new(transaction / "result.json", state.canonical({
            "status": "local-accepted", "sha": "b" * 40,
        }))
        self.store.assert_idle()
        self.assertEqual(self.store.successful_releases(), {"b" * 40})

    def test_recovery_required_result_cannot_complete(self):
        transaction = self.store.begin({"test": True})
        state.write_new(transaction / "result.json", state.canonical({"status": "recovery-required"}))
        with self.assertRaisesRegex(state.DeploymentError, "DEPLOY_RECOVERY_REQUIRED"):
            self.store.complete(transaction)
        self.assertTrue((transaction / "pending").exists())

    def test_approval_is_consumed_and_id_cannot_be_replayed(self):
        transaction = self.store.begin({"test": True})
        self.approval()
        self.store.consume_approval(transaction, IDENTITY, self.before, self.after, now=1000)
        self.assertFalse((self.store.root / "forward-only.json").exists())
        self.assertTrue((transaction / "approval.json").exists())
        self.approval()
        with self.assertRaisesRegex(state.DeploymentError, "DEPLOY_APPROVAL_REPLAY"):
            self.store.consume_approval(transaction, IDENTITY, self.before, self.after, now=1000)

    def test_approval_wrong_binding_and_expiry_preserve_source(self):
        transaction = self.store.begin({"test": True})
        for mutation in ({"before": "e" * 64}, {"after": "e" * 64},
                         {"expires": 1000}, {"expires": 5000}, {"expires": True},
                         {"identity": {**IDENTITY, "artifact_id": "3"}}):
            with self.subTest(mutation=mutation):
                self.approval(**mutation)
                with self.assertRaises(state.DeploymentError):
                    self.store.consume_approval(transaction, IDENTITY, self.before, self.after, now=1000)
                (self.store.root / "forward-only.json").unlink()
                self.assertFalse((transaction / "approval.json").exists())

    def test_symlink_and_world_readable_approval_rejected(self):
        transaction = self.store.begin({"test": True})
        self.approval()
        source = self.store.root / "forward-only.json"
        source.chmod(0o644)
        with self.assertRaisesRegex(state.DeploymentError, "DEPLOY_MODE"):
            self.store.consume_approval(transaction, IDENTITY, self.before, self.after, now=1000)
        source.unlink()
        source.symlink_to(self.store.ledger_path)
        with self.assertRaises(OSError):
            self.store.consume_approval(transaction, IDENTITY, self.before, self.after, now=1000)


if __name__ == "__main__":
    unittest.main()

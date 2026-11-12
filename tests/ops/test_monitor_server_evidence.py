"""以真实隔离部署状态检查只读证据和失败边界。"""

import tempfile
import unittest
from unittest.mock import patch

from ops.deploy.deployment_state import DeploymentError, digest, write_new
from ops.monitor.server_evidence import challenged_snapshot, snapshot
from test_release_transaction import ReleaseFixture


class ServerEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="axial-monitor-")
        self.addCleanup(self.temporary.cleanup)
        self.fixture = ReleaseFixture(self.temporary.name)

    def deploy(self):
        stage, identity = self.fixture.stage("a" * 40)
        self.fixture.approve(identity)
        self.fixture.engine.execute(identity=identity, stage=stage)
        return identity

    def test_snapshot_binds_installed_identity_and_ledger(self):
        identity = self.deploy()
        before = self.fixture.state.read_ledger()[0]
        result = snapshot(self.fixture.store)
        self.assertEqual(result["identity"], identity)
        self.assertEqual(result["ledgerSha256"], digest(before))
        self.assertIn("/", result["publishedRoutes"])
        self.assertEqual(self.fixture.state.read_ledger()[0], before)

    def test_missing_current_and_pending_transaction_fail(self):
        with self.assertRaisesRegex(DeploymentError, "MONITOR_CURRENT_MISSING"):
            snapshot(self.fixture.store)
        self.deploy()
        directory = self.fixture.state.transactions / ("f" * 32)
        directory.mkdir(mode=0o700)
        write_new(directory / "pending", b"")
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RECOVERY_REQUIRED"):
            snapshot(self.fixture.store)

    def test_modified_ledger_fails_closed(self):
        self.deploy()
        self.fixture.state.ledger_path.write_bytes(b"{}\n")
        with self.assertRaises(DeploymentError):
            snapshot(self.fixture.store)

    def test_current_drift_and_busy_lock_fail(self):
        self.deploy()
        with patch.object(self.fixture.store, "current", side_effect=["a" * 40, "b" * 40]):
            with self.assertRaisesRegex(DeploymentError, "MONITOR_CURRENT_DRIFT"):
                snapshot(self.fixture.store)
        with self.fixture.state.locked():
            with self.assertRaisesRegex(DeploymentError, "DEPLOY_LOCK_BUSY"):
                snapshot(self.fixture.store)

    def test_ledger_history_drift_fails_even_when_content_is_unchanged(self):
        self.deploy()
        original = self.fixture.state.read_ledger()
        for changed in ((original[0], "f" * 64, original[2]),
                        (original[0], original[1], original[2] + 1)):
            with self.subTest(changed=changed[1:]):
                with patch.object(self.fixture.state, "read_ledger", side_effect=[original, changed]):
                    with self.assertRaisesRegex(DeploymentError, "MONITOR_LEDGER_DRIFT"):
                        snapshot(self.fixture.store)

    def test_challenge_envelope_binds_real_store_snapshot(self):
        identity = self.deploy()
        envelope = challenged_snapshot(self.fixture.store, "1" * 64)
        self.assertEqual(envelope["challenge"], "1" * 64)
        self.assertEqual(envelope["snapshot"]["identity"], identity)
        self.assertRegex(envelope["observedAtUtc"], r"\+00:00$")
        with self.assertRaisesRegex(DeploymentError, "MONITOR_CHALLENGE"):
            challenged_snapshot(self.fixture.store, "invalid")

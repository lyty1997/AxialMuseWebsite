"""以真实隔离部署状态检查只读证据和失败边界。"""

import io
import json
import tempfile
import unittest
from contextlib import nullcontext
from unittest.mock import patch
from types import SimpleNamespace

from ops.deploy.deployment_state import DeploymentError, digest, write_new
from ops.monitor.server_evidence import challenged_snapshot, release_bundle, snapshot
from ops.monitor import installed_snapshot
from ops.maintenance.resources import GIB, check_resources
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

    def test_release_bundle_uses_verified_current_payload_and_rules(self):
        identity = self.deploy()
        bundle = release_bundle(self.fixture.store)
        _, receipt, _ = self.fixture.store.read_view(identity["commit_sha"])
        self.assertEqual(bundle["snapshot"]["identity"], identity)
        self.assertEqual(bundle["release"]["pages"], list(receipt["routes"]))
        self.assertEqual(bundle["release"]["files"]["/"], receipt["files"]["payload/index.html"])
        self.assertTrue(all(path.startswith("/") for path in bundle["release"]["files"]))
        self.assertNotIn("/config/site-release.conf", bundle["release"]["files"])
        self.assertEqual(bundle["release"]["rules"]["/projects"], "/projects/")

    def test_release_bundle_rejects_tampered_release(self):
        self.deploy()
        path = self.fixture.store.releases / ("a" * 40) / "payload/index.html"
        path.write_bytes(b"tampered")
        with self.assertRaises(DeploymentError):
            release_bundle(self.fixture.store)

    def test_real_thresholds_block_read_only_snapshot_and_prioritize_critical(self):
        self.deploy()
        for available, inode, code in ((200, 500, "MAINTENANCE_DISK_USED_WARNING"),
                                       (201, 100, "MAINTENANCE_INODE_USED_CRITICAL"),
                                       (200, 100, "MAINTENANCE_INODE_USED_CRITICAL")):
            value = SimpleNamespace(f_blocks=1000, f_bavail=available, f_frsize=GIB,
                                    f_files=1000, f_favail=inode)
            result = check_resources(statvfs=lambda _: value)
            with self.subTest(code=code), patch("ops.monitor.server_evidence.check_resources", return_value=result):
                with self.assertRaisesRegex(DeploymentError, code):
                    release_bundle(self.fixture.store)


class InstalledResourceFailureTests(unittest.TestCase):
    def test_only_known_resource_failure_is_encoded_without_private_data(self):
        for code in ("MAINTENANCE_DISK_FREE_WARNING", "MAINTENANCE_RESOURCE_DATA"):
            stream = io.BytesIO()
            with self.subTest(code=code), patch.object(installed_snapshot.sys, "argv", ["snapshot"]), \
                    patch.object(installed_snapshot.sys, "stdout", SimpleNamespace(buffer=stream)), \
                    patch.object(installed_snapshot, "verifier_lock", return_value=nullcontext()), \
                    patch.object(installed_snapshot, "load_verifier"), \
                    patch.object(installed_snapshot, "release_bundle", side_effect=DeploymentError(code)):
                self.assertEqual(installed_snapshot.main(), 0)
                self.assertEqual(json.loads(stream.getvalue()), {"schema": 1, "resourceFailure": code})

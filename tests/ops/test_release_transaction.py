"""真实磁盘安装与失败注入；HTTP 行为另由真实 Nginx 验收覆盖。"""

import os
import tempfile
import time
import unittest
import signal
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

from ops.deploy.deployment_state import DeploymentError, DeploymentState, canonical, digest, write_new
from ops.deploy.release_install import ReleaseStore
from ops.deploy.release_transaction import ReleaseTransaction
from ops.deploy import url_exposure_ledger as ledger
from test_artifact_verifier import VERIFIER, build_release, write_archive


class NginxDouble:
    def __init__(self):
        self.events = []
        self.fail = None

    def validate(self, sha):
        self.events.append(("validate", sha))
        if self.fail == ("validate", sha):
            raise DeploymentError("DEPLOY_NGINX_COMMAND")

    def activate(self, sha):
        self.events.append(("activate", sha))
        if self.fail == ("activate", sha):
            raise DeploymentError("DEPLOY_HTTP_SMOKE")


class ReleaseFixture:
    def __init__(self, root):
        self.root = Path(root)
        self.home = self.root / "state"
        self.site = self.root / "site"
        self.home.mkdir(mode=0o700)
        self.site.mkdir(mode=0o755)
        (self.site / "releases").mkdir(mode=0o755)
        (self.site / "staging").mkdir(mode=0o700)
        self.state = DeploymentState(self.home, os.getuid())
        self.state.initialize()
        self.store = ReleaseStore(self.site, self.state, VERIFIER)
        self.nginx = NginxDouble()
        self.engine = ReleaseTransaction(self.store, self.nginx)

    def stage(self, sha, **kwargs):
        files = build_release(commit_sha=sha, **kwargs)
        directory = self.site / "staging" / f"{sha}-1-2"
        directory.mkdir(mode=0o700)
        hashes = write_archive(directory, files)
        verified = directory / "verified-release"
        verified.mkdir(mode=0o700)
        for path, content in files.items():
            output = verified / path
            output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            write_new(output, content)
        for parent, _, _ in os.walk(verified):
            os.chmod(parent, 0o700)
        identity = {"workflow_run_id": "1", "artifact_id": "2", "commit_sha": sha,
                    "artifact_digest": hashes["artifactDigest"],
                    "release_content_sha256": hashes["releaseContentSha256"]}
        return directory, identity

    def approve(self, identity, *, registered=True):
        before = self.state.read_ledger()[0]
        from test_artifact_verifier import canonical_json, default_rules
        runtime = canonical_json({"schemaVersion": "1.0.0", "canonicalOrigin": ledger.CANONICAL_ORIGIN,
                                  "rules": default_rules() if registered else default_rules()[2:]})
        view = ledger.make_release_view(commit_sha=identity["commit_sha"],
                                       published_routes=("/", "/projects/"), runtime_content=runtime)
        after = ledger.merge_candidate_exposure(ledger.parse_exposure_ledger(before), view).content
        write_new(self.state.root / "forward-only.json", canonical({
            "id": identity["commit_sha"][:32], "identity": identity, "before": digest(before),
            "after": digest(after), "expires": int(time.time()) + 600,
        }))


class ReleaseTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="axial-release-")
        self.addCleanup(self.temporary.cleanup)
        self.fixture = ReleaseFixture(self.temporary.name)
        self.first = "a" * 40
        self.second = "b" * 40

    def deploy_first(self):
        stage, identity = self.fixture.stage(self.first)
        self.fixture.approve(identity)
        return self.fixture.engine.execute(identity=identity, stage=stage)

    def test_install_and_compatible_rollback_keep_payload_config_one_sha(self):
        self.assertEqual(self.deploy_first()["status"], "local-accepted")
        before = self.fixture.state.read_ledger()[0]
        stage, identity = self.fixture.stage(self.second, payload_index=b"second\n")
        result = self.fixture.engine.execute(identity=identity, stage=stage)
        self.assertEqual(result["fallback"], self.first)
        self.assertEqual(self.fixture.store.current(), self.second)
        result = self.fixture.engine.execute(rollback_sha=self.first)
        self.assertEqual(result["status"], "local-accepted")
        self.assertEqual(self.fixture.store.current(), self.first)
        self.assertEqual(self.fixture.state.read_ledger()[0], before)
        installed = self.fixture.site / "releases" / self.first
        self.assertFalse((installed / "metadata").exists())
        self.assertIn(self.first, (installed / "config/site-release.conf").read_text())

    def test_missing_approval_rejects_before_ledger_or_current(self):
        stage, identity = self.fixture.stage(self.first)
        before = self.fixture.state.read_ledger()[0]
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_REJECTED"):
            self.fixture.engine.execute(identity=identity, stage=stage)
        self.assertIsNone(self.fixture.store.current())
        self.assertEqual(self.fixture.state.read_ledger()[0], before)
        self.assertTrue((stage / "verified-release").exists())

    def test_bad_digest_fails_before_install(self):
        stage, identity = self.fixture.stage(self.first)
        identity["release_content_sha256"] = "0" * 64
        with self.assertRaises(DeploymentError):
            self.fixture.engine.execute(identity=identity, stage=stage)
        self.assertEqual(list(self.fixture.store.releases.iterdir()), [])

    def test_incompatible_rollback_retains_history(self):
        from test_artifact_verifier import default_rules
        stage, identity = self.fixture.stage(self.first, rules=default_rules()[2:])
        self.fixture.approve(identity, registered=False)
        self.fixture.engine.execute(identity=identity, stage=stage)
        stage, identity = self.fixture.stage(self.second)
        self.fixture.approve(identity)
        self.fixture.engine.execute(identity=identity, stage=stage)
        before = self.fixture.state.read_ledger()[0]
        with self.assertRaises(DeploymentError):
            self.fixture.engine.execute(rollback_sha=self.first)
        self.assertEqual(self.fixture.store.current(), self.second)
        self.assertEqual(self.fixture.state.read_ledger()[0], before)

    def test_smoke_failure_recovers_entire_compatible_release(self):
        self.deploy_first()
        stage, identity = self.fixture.stage(self.second, payload_index=b"second\n")
        self.fixture.nginx.fail = ("activate", self.second)
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RECOVERED"):
            self.fixture.engine.execute(identity=identity, stage=stage)
        self.assertEqual(self.fixture.store.current(), self.first)
        self.assertEqual(self.fixture.nginx.events[-1], ("activate", self.first))

    def test_first_forward_only_failure_preserves_commitment_and_current(self):
        stage, identity = self.fixture.stage(self.first)
        self.fixture.approve(identity)
        self.fixture.nginx.fail = ("activate", self.first)
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_FORWARD_ONLY_FAILED"):
            self.fixture.engine.execute(identity=identity, stage=stage)
        self.assertEqual(self.fixture.store.current(), self.first)
        self.assertTrue(ledger.parse_exposure_ledger(self.fixture.state.read_ledger()[0]).published_routes)
        self.assertFalse((self.fixture.state.root / "forward-only.json").exists())
        # 已知失败可以使用新身份和新批准向前修复，不能把失败代自动当 fallback。
        stage, identity = self.fixture.stage(self.second, payload_index=b"repaired\n")
        self.fixture.approve(identity)
        result = self.fixture.engine.execute(identity=identity, stage=stage)
        self.assertEqual(result["status"], "local-accepted")
        self.assertIsNone(result["fallback"])
        self.assertEqual(self.fixture.store.current(), self.second)

    def test_ledger_write_failure_never_switches(self):
        stage, identity = self.fixture.stage(self.first)
        self.fixture.approve(identity)
        with patch("ops.deploy.deployment_state.replace_file", side_effect=OSError("injected")):
            with self.assertRaisesRegex(DeploymentError, "DEPLOY_RECOVERY_REQUIRED"):
                self.fixture.engine.execute(identity=identity, stage=stage)
        self.assertIsNone(self.fixture.store.current())
        with self.assertRaises(DeploymentError):
            self.fixture.state.assert_idle()

    def test_modified_installed_release_cannot_be_rolled_back(self):
        self.deploy_first()
        path = self.fixture.site / "releases" / self.first / "payload/index.html"
        path.write_bytes(b"tampered\n")
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RELEASE_DIGEST"):
            self.fixture.store.read_view(self.first)

    def test_existing_release_is_never_overwritten(self):
        self.deploy_first()
        stage = self.fixture.site / "staging" / f"{self.first}-1-2"
        _, receipt, capture = self.fixture.store.read_view(self.first)
        self.fixture.store.install(stage, receipt["identity"])
        self.assertEqual(self.fixture.store.read_view(self.first)[2], capture)

    def test_explicit_retry_after_approval_reuses_exact_immutable_install(self):
        stage, identity = self.fixture.stage(self.first)
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_REJECTED"):
            self.fixture.engine.execute(identity=identity, stage=stage)
        before = self.fixture.store.read_view(self.first)[2]
        self.fixture.approve(identity)
        result = self.fixture.engine.execute(identity=identity, stage=stage)
        self.assertEqual(result["status"], "local-accepted")
        self.assertEqual(self.fixture.store.read_view(self.first)[2], before)

    def test_staging_mutation_fails_and_preserves_original_active_release(self):
        self.deploy_first()
        stage, identity = self.fixture.stage(self.second)
        original = VERIFIER._read_captured_file
        def mutate(fd, capture, path, limit):
            content = original(fd, capture, path, limit)
            if path == "payload/index.html":
                (stage / "verified-release/payload/index.html").write_bytes(b"changed\n")
            return content
        with patch.object(VERIFIER, "_read_captured_file", side_effect=mutate):
            with self.assertRaises(DeploymentError):
                self.fixture.engine.execute(identity=identity, stage=stage)
        self.assertEqual(self.fixture.store.current(), self.first)
        self.assertFalse((self.fixture.store.releases / self.second).exists())

    def test_real_sigkill_leaves_pending_and_blocks_next_deploy(self):
        self.deploy_first()
        stage, identity = self.fixture.stage(self.second)
        # 子进程在切换后、reload 前被真实 SIGKILL；只读重开必须看到未完成事务。
        code = r'''
import os, signal, sys
from pathlib import Path
sys.path.insert(0, 'tests/ops')
from test_artifact_verifier import VERIFIER
from ops.deploy.deployment_state import DeploymentState
from ops.deploy.release_install import ReleaseStore
from ops.deploy.release_transaction import ReleaseTransaction
from test_release_transaction import NginxDouble
root=Path(sys.argv[1])
state=DeploymentState(root/'state', os.getuid())
store=ReleaseStore(root/'site', state, VERIFIER)
nginx=NginxDouble()
nginx.activate=lambda sha: os.kill(os.getpid(), signal.SIGKILL)
import json
ReleaseTransaction(store, nginx).execute(identity=json.loads(sys.argv[3]), stage=Path(sys.argv[2]))
'''
        import json
        result = subprocess.run([sys.executable, "-c", code, self.temporary.name, str(stage), json.dumps(identity)],
                                capture_output=True, timeout=20)
        self.assertEqual(result.returncode, -signal.SIGKILL)
        self.assertEqual(self.fixture.store.current(), self.second)
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RECOVERY_REQUIRED"):
            self.fixture.state.assert_idle()


if __name__ == "__main__":
    unittest.main()

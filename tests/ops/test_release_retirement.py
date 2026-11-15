"""真实 release/事务磁盘夹具；保留历史、删除生命周期和授权缺失反例。"""

import contextlib
import copy
import os
import shutil
import tempfile
import subprocess
import time
import unittest
from unittest.mock import patch

from ops.deploy import url_exposure_ledger as ledger
from ops.deploy.deployment_state import DeploymentError, RETIREMENT_PROTOCOL_ID, canonical, decode, digest, write_new
from ops.deploy.release_retirement import ReleaseRetirement, initialize_retirements, retired_records
from ops.monitor.server_evidence import release_bundle
from test_artifact_verifier import canonical_json, default_rules
from test_release_transaction import ReleaseFixture


class ReleaseRetirementTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="axial-retirement-")
        self.addCleanup(temporary.cleanup)
        self.fixture = f = ReleaseFixture(temporary.name)
        self.old, self.current, self.next = (character * 40 for character in "abc")
        stage, identity = f.stage(self.old, rules=default_rules()[2:])
        f.approve(identity, registered=False)
        f.engine.execute(stage=stage, identity=identity)
        stage, identity = f.stage(self.current)
        f.approve(identity)
        f.engine.execute(stage=stage, identity=identity)
        with f.state.locked():
            initialize_retirements(f.state)
        self.protected = []
        self.evidence = "e" * 64
        self.now = int(time.time())
        self.outer_held = False

        @contextlib.contextmanager
        def lifecycle():
            self.assertFalse(self.outer_held)
            self.outer_held = True
            try:
                yield
            finally:
                self.outer_held = False

        def probe():
            self.assertTrue(self.outer_held)
            return {"schema": 1, "protected": sorted(self.protected), "evidence": self.evidence}

        self.engine = ReleaseRetirement(f.store, lifecycle_lock=lifecycle,
                                        reference_probe=probe, clock=lambda: self.now)
        self.plan = self.engine.plan(self.old, "d" * 32)

    def test_retirement_preserves_audit_and_allows_compatible_publish_and_rollback(self):
        f = self.fixture
        audit_before = {p: p.read_bytes() for p in f.state.root.rglob("*") if p.is_file()}
        self.assertEqual(self.engine.execute(self.plan)["status"], "retired")
        self.assertFalse((f.store.releases / self.old).exists())
        self.assertEqual(f.state.successful_releases(), {self.old, self.current})
        self.assertEqual(f.state.available_releases(), {self.current})
        for path, content in audit_before.items():
            self.assertEqual(path.read_bytes(), content, str(path))
        stage, identity = f.stage(self.next)
        self.assertEqual(f.engine.execute(stage=stage, identity=identity)["fallback"], self.current)
        self.assertEqual(f.engine.execute(rollback_sha=self.current)["status"], "local-accepted")
        self.assertEqual(release_bundle(f.store)["snapshot"]["identity"]["commit_sha"], self.current)

    def test_original_forward_only_failure_passes_only_after_explicit_retirement(self):
        f = self.fixture
        self.engine.execute(self.plan)
        rules = sorted(default_rules() + [
            {"kind": "registered", "from": "/another-old", "to": "/projects/"},
            {"kind": "registered", "from": "/another-old/", "to": "/projects/"},
        ], key=lambda rule: rule["from"])
        stage, identity = f.stage(self.next, rules=rules)
        before = f.state.read_ledger()[0]
        view = ledger.make_release_view(commit_sha=self.next, published_routes=("/", "/projects/"),
            runtime_content=canonical_json({"schemaVersion": "1.0.0", "canonicalOrigin": ledger.CANONICAL_ORIGIN,
                                           "rules": rules}))
        after = ledger.merge_candidate_exposure(ledger.parse_exposure_ledger(before), view).content
        write_new(f.state.root / "forward-only.json", canonical({
            "id": "f" * 32, "identity": identity, "before": digest(before), "after": digest(after),
            "expires": int(time.time()) + 600,
        }))
        result = f.engine.execute(stage=stage, identity=identity)
        self.assertEqual(result["status"], "local-accepted")
        self.assertIsNone(result["fallback"])
        self.assertFalse((f.state.root / "forward-only.json").exists())

    def test_unrecorded_missing_release_blocks_even_with_usable_fallback(self):
        f = self.fixture
        shutil.rmtree(f.store.releases / self.old)
        before = f.state.read_ledger()
        stage, identity = f.stage(self.next)
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RELEASE_MISSING"):
            f.engine.execute(stage=stage, identity=identity)
        self.assertEqual(f.state.read_ledger(), before)
        self.assertEqual(f.store.current(), self.current)
        self.assertNotIn(self.next, f.state.successful_releases())

    def test_retired_sha_refused_by_read_install_rollback_and_monitor(self):
        f = self.fixture
        self.engine.execute(self.plan)
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RELEASE_RETIRED"):
            f.store.read_view(self.old)
        stage = next((f.site / "staging").glob(self.old + "-*"))
        receipt = decode((f.state.root / "releases" / f"{self.old}.json").read_bytes())
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RELEASE_RETIRED"):
            f.store.install(stage, receipt["identity"])
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_REJECTED"):
            f.engine.execute(rollback_sha=self.old)
        (f.site / "current").unlink()
        os.symlink("releases/" + self.old, f.site / "current")
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RELEASE_RETIRED"):
            release_bundle(f.store)

    def test_current_compatible_and_referenced_versions_protected(self):
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_CURRENT"):
            self.engine.plan(self.current, "d" * 32)
        self.protected = [self.old]
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_REFERENCED"):
            self.engine.execute(self.plan)
        self.protected = []
        f = self.fixture
        stage, identity = f.stage(self.next)
        f.engine.execute(stage=stage, identity=identity)
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_COMPATIBLE"):
            self.engine.plan(self.current, "d" * 32)

    def test_expired_and_changed_reference_plans_cannot_retire(self):
        for now in (self.plan["created"] - 1, self.plan["expires"], self.plan["expires"] + 3600):
            with self.subTest(now=now):
                self.now = now
                with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_EXPIRED"):
                    self.engine.execute(self.plan)
                self.assertEqual(retired_records(self.fixture.state), {})
                self.assertTrue((self.fixture.store.releases / self.old).exists())
        self.now = self.plan["created"]
        self.evidence = "f" * 64
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_DRIFT"):
            self.engine.execute(self.plan)
        self.assertEqual(retired_records(self.fixture.state), {})

    def test_plan_bound_to_current_ledger_receipt_and_target_inode(self):
        for field, value in (("inode", self.plan["inode"] + 1), ("ledgerSha256", "f" * 64),
                             ("receiptSha256", "f" * 64), ("acceptedTransaction", "0" * 32)):
            with self.subTest(field=field):
                plan = copy.deepcopy(self.plan)
                plan[field] = value
                with self.assertRaises((DeploymentError, FileNotFoundError)):
                    self.engine.execute(plan)
                self.assertEqual(retired_records(self.fixture.state), {})

    def test_lock_conflict_has_no_write(self):
        with self.fixture.state.locked(retirement_aware=True):
            with self.assertRaisesRegex(DeploymentError, "DEPLOY_LOCK_BUSY"):
                self.engine.execute(self.plan)
        self.assertEqual(retired_records(self.fixture.state), {})

    def test_publication_failure_does_not_change_available_set(self):
        with patch("ops.deploy.release_retirement.rename_new", side_effect=OSError("injected")):
            with self.assertRaises(OSError):
                self.engine.execute(self.plan)
        self.assertEqual(self.fixture.state.available_releases(), {self.old, self.current})
        self.assertTrue((self.fixture.store.releases / self.old).exists())
        self.engine.execute(self.plan)
        self.assertEqual(self.fixture.state.available_releases(), {self.current})

    def test_interrupt_after_record_excludes_release_and_resumes_partial_deletion(self):
        directory = self.fixture.store.site / ".retired" / self.old
        real_rmtree = shutil.rmtree

        def partial_delete(path):
            self.assertEqual(self.fixture.state.available_releases(), {self.current})
            (path / "payload/index.html").unlink()
            raise OSError("injected")

        with patch("ops.deploy.release_retirement.shutil.rmtree", side_effect=partial_delete) as mocked:
            mocked.avoids_symlink_attacks = real_rmtree.avoids_symlink_attacks
            with self.assertRaises(OSError):
                self.engine.execute(self.plan)
        self.assertTrue(directory.exists())
        self.assertEqual(self.fixture.state.available_releases(), {self.current})
        record = self.fixture.state.root / "retirements" / f"{self.old}.json"
        committed = record.read_bytes()
        self.now = self.plan["expires"] + 3600
        self.assertEqual(self.engine.execute(self.plan)["status"], "retired")
        self.assertFalse(directory.exists())
        self.assertEqual(self.engine.execute(self.plan)["status"], "retired")
        self.assertEqual(record.read_bytes(), committed)

    def test_expired_recovery_rechecks_plan_and_references(self):
        real_rmtree = shutil.rmtree
        with patch("ops.deploy.release_retirement.shutil.rmtree", side_effect=OSError("injected")) as mocked:
            mocked.avoids_symlink_attacks = real_rmtree.avoids_symlink_attacks
            with self.assertRaises(OSError):
                self.engine.execute(self.plan)
        directory = self.engine.location(self.old)
        self.now = self.plan["expires"] + 3600
        changed = copy.deepcopy(self.plan)
        changed["authorizationId"] = "0" * 32
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_DRIFT"):
            self.engine.execute(changed)
        self.protected = [self.old]
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_REFERENCED"):
            self.engine.execute(self.plan)
        self.protected = []
        self.evidence = "f" * 64
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_DRIFT"):
            self.engine.execute(self.plan)
        self.assertTrue(directory.exists())
        self.evidence = "e" * 64
        self.assertEqual(self.engine.execute(self.plan)["status"], "retired")
        self.assertFalse(directory.exists())

    def test_partial_deletion_rejects_new_files_symlinks_or_changed_content(self):
        real_rmtree = shutil.rmtree
        with patch("ops.deploy.release_retirement.shutil.rmtree", side_effect=OSError("injected")) as mocked:
            mocked.avoids_symlink_attacks = real_rmtree.avoids_symlink_attacks
            with self.assertRaises(OSError):
                self.engine.execute(self.plan)
        self.now = self.plan["expires"] + 3600
        directory = self.engine.location(self.old)
        write_new(directory / "unexpected", b"unknown", 0o644)
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_EXTRA"):
            self.engine.execute(self.plan)
        (directory / "unexpected").unlink()
        file = directory / "payload/index.html"
        original = file.read_bytes()
        file.write_bytes(b"drift")
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_DRIFT"):
            self.engine.execute(self.plan)
        file.unlink()
        file.symlink_to(directory / "payload/projects/index.html")
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_FILE"):
            self.engine.execute(self.plan)
        file.unlink()
        write_new(file, original, 0o644)
        self.engine.execute(self.plan)

    def test_catalog_corruption_and_missing_halves_fail_closed(self):
        self.engine.execute(self.plan)
        record = self.fixture.state.root / "retirements" / f"{self.old}.json"
        content = record.read_bytes()
        record.write_bytes(b"{}\n")
        with self.assertRaises(DeploymentError):
            self.fixture.state.available_releases()
        record.write_bytes(content)
        marker = self.fixture.state.root / "retirement-schema"
        marker.unlink()
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_LAYOUT"):
            self.fixture.store.current()

    def test_changed_context_can_reauthorize_cleanup_without_changing_retirement_fact(self):
        real_rmtree = shutil.rmtree
        with patch("ops.deploy.release_retirement.shutil.rmtree", side_effect=OSError("power loss")) as mocked:
            mocked.avoids_symlink_attacks = real_rmtree.avoids_symlink_attacks
            with self.assertRaises(OSError):
                self.engine.execute(self.plan)
        record = self.fixture.state.root / "retirements" / f"{self.old}.json"
        original = record.read_bytes()
        stage, identity = self.fixture.stage(self.next)
        self.fixture.engine.execute(stage=stage, identity=identity)
        self.evidence = "f" * 64
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_DRIFT"):
            self.engine.execute(self.plan)
        plan = self.engine.plan(self.old, "e" * 32)
        self.assertEqual(plan["schema"], 2)
        self.assertEqual(plan["retirementSha256"], digest(original))
        self.assertEqual(self.engine.execute(plan)["status"], "retired")
        self.assertEqual(record.read_bytes(), original)
        self.assertFalse(self.engine.location(self.old).exists())
        self.assertEqual(self.fixture.state.available_releases(), {self.current, self.next})
        self.assertTrue((self.fixture.state.root / "retirement-cleanups" / ("e" * 32 + ".json")).exists())

    def test_new_reference_after_probe_blocks_kernel_deletion(self):
        original = self.engine.remaining
        held = []
        self.addCleanup(lambda: [f.close() for f in held])
        def open_after_check(plan):
            result = original(plan)
            if self.engine.location(self.old).parent.name == ".retired" and not held:
                held.append((self.engine.location(self.old) / "payload/index.html").open("rb"))
            return result
        with patch.object(self.engine, "remaining", open_after_check):
            with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_REFERENCED"):
                self.engine.execute(self.plan)
        self.assertTrue(self.engine.location(self.old).exists())
        for stream in held:
            stream.close()
        self.assertEqual(self.engine.execute(self.plan)["status"], "retired")

    def test_file_open_after_final_original_probe_must_prevent_deletion(self):
        original = self.engine.remaining
        calls, held = [], []
        self.addCleanup(lambda: [stream.close() for stream in held])
        def raced(plan):
            result = original(plan)
            calls.append(True)
            if len(calls) == 2:
                public = self.fixture.store.releases / self.old
                directory = public if public.exists() else self.fixture.store.site / ".retired" / self.old
                held.append((directory / "payload/index.html").open("rb"))
            return result
        with patch.object(self.engine, "remaining", raced):
            with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_REFERENCED"):
                self.engine.execute(self.plan)
        self.assertTrue(held[0].read())

    @unittest.skipUnless(os.environ.get("AXIALMUSE_NGINX_ACCEPTANCE") == "1", "需显式启用现有 Docker 镜像")
    def test_real_unprivileged_process_cannot_reopen_isolated_tree(self):
        image = "docker.io/library/nginx@sha256:0dcc88822d45581e65ae329f8be769762bf628d3b2bb7d2a077d4aa5c98b30e3"
        def probe(path):
            return subprocess.run(["docker", "run", "--rm", "--network", "none", "--user", "65534:65534",
                "--entrypoint", "/bin/sh", "--mount", f"type=bind,src={self.fixture.site},dst=/site,readonly",
                image, "-c", 'test -r "$1"', "sh", path], capture_output=True, timeout=30).returncode
        self.assertEqual(probe(f"/site/releases/{self.old}/payload/index.html"), 0)
        original = self.engine.remaining
        seen = []
        def after_isolation(plan):
            result = original(plan)
            if self.engine.location(self.old).parent.name == ".retired" and not seen:
                seen.append(True)
                self.assertNotEqual(probe(f"/site/releases/{self.old}/payload/index.html"), 0)
                self.assertNotEqual(probe(f"/site/.retired/{self.old}/payload/index.html"), 0)
            return result
        with patch.object(self.engine, "remaining", after_isolation):
            self.engine.execute(self.plan)
        self.assertEqual(seen, [True])

    def test_old_installation_read_does_not_initialize_retirement_catalog(self):
        root = self.fixture.state.root
        (root / "retirement-schema").unlink()
        (root / "retirements").rmdir()
        protocol = self.fixture.state.transactions / RETIREMENT_PROTOCOL_ID
        (protocol / "result.json").unlink()
        protocol.rmdir()
        self.assertEqual(self.fixture.state.available_releases(), {self.old, self.current})
        self.assertFalse((root / "retirement-schema").exists())
        self.assertFalse((root / "retirements").exists())

    def test_protocol_initialization_resumes_every_file_publication_boundary(self):
        from ops.deploy import release_retirement
        for failure in range(1, 4):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as root:
                fixture = ReleaseFixture(root)
                original = release_retirement.publish_new
                calls = 0
                def interrupted(*args, **kwargs):
                    nonlocal calls
                    calls += 1
                    if calls == failure:
                        raise OSError("power loss")
                    return original(*args, **kwargs)
                with fixture.state.locked(retirement_aware=True):
                    with patch.object(release_retirement, "publish_new", interrupted):
                        with self.assertRaises(OSError):
                            initialize_retirements(fixture.state)
                    with self.assertRaises(DeploymentError):
                        fixture.state.assert_idle()
                    initialize_retirements(fixture.state)
                    fixture.state.assert_idle()
                self.assertEqual(fixture.state.successful_releases(), set())

    def test_protocol_recovery_rejects_unknown_transaction_members(self):
        protocol = self.fixture.state.transactions / RETIREMENT_PROTOCOL_ID
        (protocol / "pending").write_bytes(b"")
        (protocol / "pending").chmod(0o600)
        write_new(protocol / "unknown", b"unknown")
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_PROTOCOL"):
            initialize_retirements(self.fixture.state)

    def test_completed_protocol_marker_loss_is_not_reconstructed_as_interruption(self):
        (self.fixture.state.root / "retirement-schema").unlink()
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_PROTOCOL"):
            initialize_retirements(self.fixture.state)

    def test_unupgraded_call_path_refuses_initialized_retirement_protocol(self):
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_PROTOCOL_UNSUPPORTED"):
            with self.fixture.state.locked():
                self.fail("旧调用方式不应进入临界区")
        with self.fixture.state.locked(retirement_aware=True):
            self.fixture.state.assert_idle()

    def test_lost_protocol_or_removed_catalog_does_not_restore_legacy_availability(self):
        root = self.fixture.state.root
        (root / "retirement-schema").unlink()
        (root / "retirements").rmdir()
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_PROTOCOL"):
            self.fixture.state.retired_releases()


if __name__ == "__main__":
    unittest.main()

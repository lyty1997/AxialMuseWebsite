import errno
import fcntl
import hashlib
import importlib.util
import io
import json
import os
import signal
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
UPGRADER_PATH = (
    REPOSITORY_ROOT / "ops" / "deploy" / "upgrade_artifact_verifier.py"
)
SPEC = importlib.util.spec_from_file_location(
    "axial_muse_artifact_verifier_upgrade",
    UPGRADER_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("无法加载 artifact verifier upgrader。")
UPGRADER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = UPGRADER
SPEC.loader.exec_module(UPGRADER)
BOOTSTRAP = UPGRADER.BOOTSTRAP


OLD_COMMIT = "a" * 40
NEW_COMMIT = "d" * 40
OLD_VERIFIER = b"#!/usr/bin/python3\n# old verifier fixture\n"
OLD_GOLDEN = b'{"fixture":"old-golden"}\n'
NEW_VERIFIER = b"#!/usr/bin/python3\n# new verifier fixture\n"
NEW_GOLDEN = b'{"fixture":"new-golden"}\n'


def sha256(value):
    return hashlib.sha256(value).hexdigest()


class SimulatedCrash(BaseException):
    pass


class UpgradeFixture:
    def __init__(self, temporary_root):
        self.root = Path(temporary_root) / "system-root"
        self.lib = self.root / "usr" / "local" / "lib"
        self.lib.mkdir(parents=True)
        for path in (
            self.root,
            self.root / "usr",
            self.root / "usr" / "local",
            self.lib,
        ):
            path.chmod(0o755)

        self.bootstrap_source = Path(temporary_root) / "bootstrap-source"
        self.bootstrap_source.mkdir(mode=0o700)
        self._write_private_source(
            self.bootstrap_source / BOOTSTRAP.VERIFIER_BASENAME,
            OLD_VERIFIER,
        )
        self._write_private_source(
            self.bootstrap_source / BOOTSTRAP.GOLDEN_BASENAME,
            OLD_GOLDEN,
        )

        self.upgrade_source = Path(temporary_root) / "upgrade-source"
        self.upgrade_source.mkdir(mode=0o700)
        self._write_private_source(
            self.upgrade_source / UPGRADER.VERIFIER_BASENAME,
            NEW_VERIFIER,
        )
        self._write_private_source(
            self.upgrade_source / UPGRADER.GOLDEN_BASENAME,
            NEW_GOLDEN,
        )
        self.manifest = UPGRADER._canonical_json(
            {
                "component": UPGRADER.COMPONENT,
                "files": [
                    {
                        "mode": "0644",
                        "path": UPGRADER.GOLDEN_BASENAME,
                        "sha256": sha256(NEW_GOLDEN),
                        "size": len(NEW_GOLDEN),
                    },
                    {
                        "mode": "0755",
                        "path": UPGRADER.VERIFIER_BASENAME,
                        "sha256": sha256(NEW_VERIFIER),
                        "size": len(NEW_VERIFIER),
                    },
                ],
                "interfaceVersion": UPGRADER.INTERFACE_VERSION,
                "repository": UPGRADER.REPOSITORY,
                "schemaVersion": UPGRADER.MANIFEST_SCHEMA_VERSION,
                "selfTest": {
                    "schemaVersion": UPGRADER.SELF_TEST_SCHEMA_VERSION,
                    "wireMagic": UPGRADER.FILE_TREE_WIRE_MAGIC,
                },
            }
        )
        self._write_private_source(
            self.upgrade_source / UPGRADER.MANIFEST_BASENAME,
            self.manifest,
        )
        self.self_test_paths = []

    @staticmethod
    def _write_private_source(path, content):
        path.write_bytes(content)
        path.chmod(0o600)

    @property
    def namespace(self):
        return self.lib / BOOTSTRAP.FORMAL_NAMESPACE

    @property
    def formal(self):
        return self.namespace / BOOTSTRAP.INSTALL_DIRECTORY

    @property
    def genesis_receipt(self):
        return (
            self.namespace
            / BOOTSTRAP.STATE_DIRECTORY
            / BOOTSTRAP.RECEIPT_BASENAME
        )

    @property
    def lock(self):
        return self.lib / BOOTSTRAP.LOCK_BASENAME

    @property
    def upgrade_root(self):
        return self.namespace / UPGRADER.UPGRADE_ROOT_BASENAME

    def self_test(self, system_python, verifier_path):
        if system_python != "/fixture/python3":
            raise AssertionError("unexpected system Python")
        path = Path(verifier_path)
        verifier = path.read_bytes()
        golden_descriptor = getattr(
            verifier_path,
            "golden_descriptor",
            None,
        )
        golden_path = (
            path.with_name(UPGRADER.GOLDEN_BASENAME)
            if golden_descriptor is None
            else Path(f"/proc/self/fd/{golden_descriptor}")
        )
        golden = golden_path.read_bytes()
        if (verifier, golden) not in (
            (OLD_VERIFIER, OLD_GOLDEN),
            (NEW_VERIFIER, NEW_GOLDEN),
        ):
            raise AssertionError("mixed or unknown component")
        self.self_test_paths.append(path)
        return {
            "schemaVersion": UPGRADER.SELF_TEST_SCHEMA_VERSION,
            "wireMagic": UPGRADER.FILE_TREE_WIRE_MAGIC,
            "vectorCount": 6,
        }

    def install(self):
        return BOOTSTRAP.bootstrap_artifact_verifier(
            source_root=str(self.bootstrap_source),
            expected_commit_sha=OLD_COMMIT,
            expected_verifier_sha256=sha256(OLD_VERIFIER),
            expected_golden_sha256=sha256(OLD_GOLDEN),
            _root_path=str(self.root),
            _expected_uid=os.getuid(),
            _expected_gid=os.getgid(),
            _system_python="/fixture/python3",
            _self_test_runner=self.self_test,
            _transaction_id_factory=lambda: "b" * 32,
            _enforce_runtime=False,
        )

    @property
    def genesis_sha256(self):
        return sha256(self.genesis_receipt.read_bytes())

    @property
    def options(self):
        return {
            "source_root": str(self.upgrade_source),
            "expected_current_receipt_sha256": self.genesis_sha256,
            "expected_target_commit_sha": NEW_COMMIT,
            "expected_target_manifest_sha256": sha256(self.manifest),
            "_root_path": str(self.root),
            "_expected_uid": os.getuid(),
            "_expected_gid": os.getgid(),
            "_system_python": "/fixture/python3",
            "_self_test_runner": self.self_test,
            "_transaction_id_factory": lambda: "c" * 32,
            "_enforce_runtime": False,
        }

    def run(self, **overrides):
        options = self.options
        options.update(overrides)
        return UPGRADER.upgrade_artifact_verifier(**options)

    def configure_target(self, verifier, golden):
        self._write_private_source(
            self.upgrade_source / UPGRADER.VERIFIER_BASENAME,
            verifier,
        )
        self._write_private_source(
            self.upgrade_source / UPGRADER.GOLDEN_BASENAME,
            golden,
        )
        self.manifest = UPGRADER._canonical_json(
            {
                "component": UPGRADER.COMPONENT,
                "files": [
                    {
                        "mode": "0644",
                        "path": UPGRADER.GOLDEN_BASENAME,
                        "sha256": sha256(golden),
                        "size": len(golden),
                    },
                    {
                        "mode": "0755",
                        "path": UPGRADER.VERIFIER_BASENAME,
                        "sha256": sha256(verifier),
                        "size": len(verifier),
                    },
                ],
                "interfaceVersion": UPGRADER.INTERFACE_VERSION,
                "repository": UPGRADER.REPOSITORY,
                "schemaVersion": UPGRADER.MANIFEST_SCHEMA_VERSION,
                "selfTest": {
                    "schemaVersion": UPGRADER.SELF_TEST_SCHEMA_VERSION,
                    "wireMagic": UPGRADER.FILE_TREE_WIRE_MAGIC,
                },
            }
        )
        self._write_private_source(
            self.upgrade_source / UPGRADER.MANIFEST_BASENAME,
            self.manifest,
        )
        return sha256(self.manifest)

    def event_directories(self):
        if not self.upgrade_root.exists():
            return []
        return sorted(path for path in self.upgrade_root.iterdir())

    def replace_live_lib(self):
        displaced = self.lib.with_name("lib-displaced")
        self.lib.rename(displaced)
        self.lib.mkdir(mode=0o755)
        replacement_namespace = self.lib / UPGRADER.FORMAL_NAMESPACE
        replacement_namespace.mkdir(mode=0o755)
        replacement_formal = replacement_namespace / UPGRADER.INSTALL_DIRECTORY
        replacement_formal.mkdir(mode=0o755)
        verifier = replacement_formal / UPGRADER.VERIFIER_BASENAME
        verifier.write_bytes(OLD_VERIFIER)
        verifier.chmod(0o755)
        golden = replacement_formal / UPGRADER.GOLDEN_BASENAME
        golden.write_bytes(OLD_GOLDEN)
        golden.chmod(0o644)
        replacement_lock = self.lib / UPGRADER.LOCK_BASENAME
        replacement_lock.write_bytes(b"")
        replacement_lock.chmod(0o600)
        (replacement_namespace / "external-owner").write_bytes(b"keep\n")
        return displaced


class ArtifactVerifierUpgradeTests(unittest.TestCase):
    maxDiff = None

    def assert_upgrade_error(self, code, callback):
        with self.assertRaises(UPGRADER.VerifierUpgradeError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_repository_manifest_binds_current_component_bytes(self):
        manifest_path = UPGRADER_PATH.with_name(UPGRADER.MANIFEST_BASENAME)
        manifest_bytes = manifest_path.read_bytes()
        spec = UPGRADER._parse_manifest(
            manifest_bytes,
            sha256(manifest_bytes),
            NEW_COMMIT,
        )
        self.assertEqual(spec["commitSha"], NEW_COMMIT)
        for file_spec in spec["files"]:
            content = UPGRADER_PATH.with_name(file_spec["path"]).read_bytes()
            self.assertEqual(len(content), file_spec["size"])
            self.assertEqual(sha256(content), file_spec["sha256"])

    def test_upgrade_exchanges_component_retains_genesis_and_is_idempotent(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            genesis_bytes = fixture.genesis_receipt.read_bytes()
            genesis_inode = fixture.genesis_receipt.stat().st_ino
            lock_inode = fixture.lock.stat().st_ino
            old_component_inode = fixture.formal.stat().st_ino
            output = io.StringIO()

            result = fixture.run(success_stream=output)

            self.assertEqual(result["disposition"], "upgraded")
            self.assertEqual(json.loads(output.getvalue()), result)
            self.assertEqual(output.getvalue().count("\n"), 1)
            self.assertEqual(
                (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                NEW_VERIFIER,
            )
            self.assertEqual(
                (fixture.formal / UPGRADER.GOLDEN_BASENAME).read_bytes(),
                NEW_GOLDEN,
            )
            event = fixture.event_directories()[0]
            slot = event / UPGRADER.SLOT_BASENAME
            self.assertEqual(slot.stat().st_ino, old_component_inode)
            self.assertEqual(
                (slot / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                OLD_VERIFIER,
            )
            self.assertTrue((event / UPGRADER.COMMITTED_BASENAME).is_file())
            self.assertEqual(fixture.genesis_receipt.read_bytes(), genesis_bytes)
            self.assertEqual(fixture.genesis_receipt.stat().st_ino, genesis_inode)
            self.assertEqual(fixture.lock.stat().st_ino, lock_inode)
            self.assertEqual(stat.S_IMODE(fixture.upgrade_root.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(event.stat().st_mode), 0o700)
            self.assertEqual(
                stat.S_IMODE((event / UPGRADER.RECEIPT_BASENAME).stat().st_mode),
                0o600,
            )

            formal_inode = fixture.formal.stat().st_ino
            receipt_bytes = (event / UPGRADER.RECEIPT_BASENAME).read_bytes()
            second_output = io.StringIO()
            second = fixture.run(
                expected_current_receipt_sha256=result[
                    "componentReceiptSha256"
                ],
                success_stream=second_output,
            )
            self.assertEqual(second["disposition"], "already-current")
            self.assertEqual(fixture.formal.stat().st_ino, formal_inode)
            self.assertEqual(
                (event / UPGRADER.RECEIPT_BASENAME).read_bytes(),
                receipt_bytes,
            )
            self.assertEqual(len(fixture.event_directories()), 1)

            old_formal_inode = fixture.formal.stat().st_ino
            with self.assertRaises(BOOTSTRAP.VerifierBootstrapError):
                fixture.install()
            self.assertEqual(fixture.formal.stat().st_ino, old_formal_inode)

    def test_event_marker_and_lifecycle_identities_are_revalidated(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            result = fixture.run()
            marker = (
                fixture.event_directories()[0]
                / UPGRADER.COMMITTED_BASENAME
            )
            marker.chmod(0o644)
            self.assert_upgrade_error(
                "VERIFIER_UPGRADE_STATE",
                lambda: fixture.run(
                    expected_current_receipt_sha256=result[
                        "componentReceiptSha256"
                    ]
                ),
            )

        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            fixture.run()
            receipt_path = (
                fixture.event_directories()[0]
                / UPGRADER.RECEIPT_BASENAME
            )
            receipt = json.loads(receipt_path.read_bytes())
            receipt["identities"]["namespace"]["inode"] += 1
            modified = UPGRADER._canonical_json(receipt)
            receipt_path.write_bytes(modified)
            self.assert_upgrade_error(
                "VERIFIER_UPGRADE_RECEIPT",
                lambda: fixture.run(
                    expected_current_receipt_sha256=sha256(modified)
                ),
            )

    def test_bootstrap_reserved_sibling_states_block_before_upgrade_state(self):
        reserved_names = (
            f"{BOOTSTRAP.CANDIDATE_PREFIX}{'e' * 32}",
            f"{BOOTSTRAP.ISOLATION_PREFIX}{'f' * 32}",
            ".axialmuse-artifact-verifier-unknown",
        )
        for reserved_name in reserved_names:
            with self.subTest(reserved_name=reserved_name), tempfile.TemporaryDirectory(
                prefix="axial-muse-upgrade-test-"
            ) as temporary_root:
                fixture = UpgradeFixture(temporary_root)
                fixture.install()
                (fixture.lib / reserved_name).mkdir(mode=0o700)

                with self.assertRaises(
                    BOOTSTRAP.VerifierBootstrapError
                ) as caught:
                    fixture.run()

                self.assertEqual(
                    caught.exception.code,
                    "VERIFIER_BOOTSTRAP_STATE",
                )
                self.assertFalse(fixture.upgrade_root.exists())

    def test_detached_upgrade_root_or_event_never_reports_success(self):
        for stage in ("upgrade-root", "event"):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory(
                prefix="axial-muse-upgrade-test-"
            ) as temporary_root:
                fixture = UpgradeFixture(temporary_root)
                fixture.install()
                original_mark = UPGRADER._mark_event
                detached = None

                def mark_then_detach(event, target_marker):
                    nonlocal detached
                    original_mark(event, target_marker)
                    if target_marker != UPGRADER.COMMITTED_BASENAME:
                        return
                    if stage == "upgrade-root":
                        detached = fixture.namespace / "detached-upgrades"
                        fixture.upgrade_root.rename(detached)
                        fixture.upgrade_root.mkdir(mode=0o700)
                    else:
                        canonical_event = fixture.event_directories()[0]
                        detached = fixture.namespace / "detached-event"
                        canonical_event.rename(detached)
                        canonical_event.mkdir(mode=0o700)

                with mock.patch.object(
                    UPGRADER,
                    "_mark_event",
                    side_effect=mark_then_detach,
                ):
                    self.assert_upgrade_error(
                        "VERIFIER_UPGRADE_OUTCOME_UNKNOWN",
                        fixture.run,
                    )

                self.assertIsNotNone(detached)
                self.assertEqual(
                    (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                    NEW_VERIFIER,
                )
                if stage == "upgrade-root":
                    committed_event = next(detached.iterdir())
                else:
                    committed_event = detached
                self.assertTrue(
                    (committed_event / UPGRADER.COMMITTED_BASENAME).is_file()
                )

    def test_final_live_descent_rejects_late_committed_event_detach(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            original_discover = BOOTSTRAP._discover_state
            detached = None

            def discover_then_detach(tree):
                nonlocal detached
                result = original_discover(tree)
                events = fixture.event_directories()
                if (
                    detached is None
                    and events
                    and (events[0] / UPGRADER.COMMITTED_BASENAME).exists()
                ):
                    detached = fixture.namespace / "late-detached-event"
                    events[0].rename(detached)
                return result

            with mock.patch.object(
                BOOTSTRAP,
                "_discover_state",
                side_effect=discover_then_detach,
            ):
                self.assert_upgrade_error(
                    "VERIFIER_UPGRADE_OUTCOME_UNKNOWN",
                    fixture.run,
                )

            self.assertIsNotNone(detached)
            self.assertEqual(fixture.event_directories(), [])
            self.assertTrue(
                (detached / UPGRADER.COMMITTED_BASENAME).is_file()
            )

    def test_post_marker_formal_drift_never_reports_success(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            original_mark = UPGRADER._mark_event

            def mark_then_drift(event, target_marker):
                original_mark(event, target_marker)
                if target_marker == UPGRADER.COMMITTED_BASENAME:
                    (
                        fixture.formal / UPGRADER.VERIFIER_BASENAME
                    ).write_bytes(NEW_VERIFIER + b"post-marker drift\n")

            with mock.patch.object(
                UPGRADER,
                "_mark_event",
                side_effect=mark_then_drift,
            ):
                self.assert_upgrade_error(
                    "VERIFIER_UPGRADE_OUTCOME_UNKNOWN",
                    fixture.run,
                )

            event = fixture.event_directories()[0]
            self.assertTrue((event / UPGRADER.COMMITTED_BASENAME).is_file())
            self.assertNotEqual(
                (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                NEW_VERIFIER,
            )

    def test_live_lib_swap_before_or_after_exchange_never_commits(self):
        for stage in ("before-exchange", "after-exchange"):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory(
                prefix="axial-muse-upgrade-test-"
            ) as temporary_root:
                fixture = UpgradeFixture(temporary_root)
                fixture.install()
                displaced = None

                if stage == "before-exchange":
                    original = UPGRADER._validate_event_pair

                    def swap_after_preflight(*arguments, **keywords):
                        nonlocal displaced
                        result = original(*arguments, **keywords)
                        if displaced is None and arguments[-1] == "from-to":
                            displaced = fixture.replace_live_lib()
                        return result

                    patcher = mock.patch.object(
                        UPGRADER,
                        "_validate_event_pair",
                        side_effect=swap_after_preflight,
                    )
                else:
                    original = UPGRADER._rename_exchange

                    def exchange_then_swap(*arguments, **keywords):
                        nonlocal displaced
                        result = original(*arguments, **keywords)
                        if displaced is None:
                            displaced = fixture.replace_live_lib()
                        return result

                    patcher = mock.patch.object(
                        UPGRADER,
                        "_rename_exchange",
                        side_effect=exchange_then_swap,
                    )

                with patcher:
                    self.assert_upgrade_error(
                        "VERIFIER_UPGRADE_OUTCOME_UNKNOWN",
                        fixture.run,
                    )
                self.assertIsNotNone(displaced)
                self.assertEqual(
                    (
                        fixture.formal / UPGRADER.VERIFIER_BASENAME
                    ).read_bytes(),
                    OLD_VERIFIER,
                )
                self.assertEqual(
                    (
                        fixture.namespace / "external-owner"
                    ).read_bytes(),
                    b"keep\n",
                )
                held_namespace = displaced / UPGRADER.FORMAL_NAMESPACE
                held_formal = held_namespace / UPGRADER.INSTALL_DIRECTORY
                self.assertEqual(
                    (held_formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                    OLD_VERIFIER,
                )
                events = sorted(
                    (
                        held_namespace / UPGRADER.UPGRADE_ROOT_BASENAME
                    ).iterdir()
                )
                self.assertEqual(len(events), 1)
                self.assertTrue(
                    (events[0] / UPGRADER.ROLLED_BACK_BASENAME).is_file()
                )
                self.assertFalse(
                    (events[0] / UPGRADER.COMMITTED_BASENAME).exists()
                )

    def test_late_live_lib_detach_in_final_descent_never_reports_success(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            original_discover = BOOTSTRAP._discover_state
            committed_discovers = 0
            displaced = None

            def discover_then_replace_lib(tree):
                nonlocal committed_discovers, displaced
                result = original_discover(tree)
                events = fixture.event_directories()
                if events and (
                    events[0] / UPGRADER.COMMITTED_BASENAME
                ).exists():
                    committed_discovers += 1
                    if committed_discovers == 2:
                        displaced = fixture.replace_live_lib()
                return result

            with mock.patch.object(
                BOOTSTRAP,
                "_discover_state",
                side_effect=discover_then_replace_lib,
            ):
                self.assert_upgrade_error(
                    "VERIFIER_UPGRADE_OUTCOME_UNKNOWN",
                    fixture.run,
                )

            self.assertEqual(committed_discovers, 2)
            self.assertIsNotNone(displaced)
            held_formal = (
                displaced
                / UPGRADER.FORMAL_NAMESPACE
                / UPGRADER.INSTALL_DIRECTORY
            )
            self.assertEqual(
                (held_formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                NEW_VERIFIER,
            )

    def test_genesis_state_replacement_during_upgrade_never_commits(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            state = fixture.namespace / BOOTSTRAP.STATE_DIRECTORY
            original_state_inode = state.stat().st_ino
            detached = fixture.namespace / "detached-genesis"
            replaced = False

            def replace_genesis_after_candidate_test(system_python, verifier_path):
                nonlocal replaced
                result = fixture.self_test(system_python, verifier_path)
                if not replaced and Path(verifier_path).read_bytes() == NEW_VERIFIER:
                    state.rename(detached)
                    state.mkdir(mode=0o700)
                    for basename in (
                        BOOTSTRAP.RECEIPT_BASENAME,
                        BOOTSTRAP.COMMITTED_BASENAME,
                    ):
                        target = state / basename
                        target.write_bytes((detached / basename).read_bytes())
                        target.chmod(0o600)
                    replaced = True
                return result

            self.assert_upgrade_error(
                "VERIFIER_UPGRADE_OUTCOME_UNKNOWN",
                lambda: fixture.run(
                    _self_test_runner=replace_genesis_after_candidate_test
                ),
            )

            self.assertTrue(replaced)
            self.assertNotEqual(state.stat().st_ino, original_state_inode)
            self.assertEqual(
                (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                OLD_VERIFIER,
            )

    def test_post_exchange_sync_failure_rolls_back_and_is_classified(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            original_fsync = os.fsync
            failures = 0

            def fail_first_post_exchange_event_sync(descriptor):
                nonlocal failures
                events = fixture.event_directories()
                if (
                    failures == 0
                    and events
                    and (
                        fixture.formal / UPGRADER.VERIFIER_BASENAME
                    ).read_bytes()
                    == NEW_VERIFIER
                    and os.fstat(descriptor).st_ino == events[0].stat().st_ino
                ):
                    failures += 1
                    raise OSError(errno.EIO, "controlled post-exchange sync")
                return original_fsync(descriptor)

            with mock.patch.object(
                UPGRADER.os,
                "fsync",
                side_effect=fail_first_post_exchange_event_sync,
            ):
                self.assert_upgrade_error(
                    "VERIFIER_UPGRADE_COMMIT",
                    fixture.run,
                )

            self.assertEqual(failures, 1)
            self.assertEqual(
                (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                OLD_VERIFIER,
            )
            event = fixture.event_directories()[0]
            self.assertTrue((event / UPGRADER.ROLLED_BACK_BASENAME).is_file())

    def test_complete_prepared_parent_sync_failure_rolls_back(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            original_fsync = os.fsync
            failures = 0

            def fail_complete_prepared_namespace_sync(descriptor):
                nonlocal failures
                events = fixture.event_directories()
                if (
                    failures == 0
                    and events
                    and (events[0] / UPGRADER.PREPARED_BASENAME).exists()
                    and os.fstat(descriptor).st_ino
                    == fixture.namespace.stat().st_ino
                ):
                    failures += 1
                    raise OSError(errno.EIO, "controlled prepared sync")
                return original_fsync(descriptor)

            with mock.patch.object(
                UPGRADER.os,
                "fsync",
                side_effect=fail_complete_prepared_namespace_sync,
            ):
                self.assert_upgrade_error(
                    "VERIFIER_UPGRADE_COMMIT",
                    fixture.run,
                )

            self.assertEqual(failures, 1)
            event = fixture.event_directories()[0]
            self.assertTrue((event / UPGRADER.ROLLED_BACK_BASENAME).is_file())
            self.assertEqual(
                (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                OLD_VERIFIER,
            )

    def test_complete_prepared_upgrade_root_sync_is_retried_after_rollback(self):
        for persistent in (False, True):
            with self.subTest(persistent=persistent), tempfile.TemporaryDirectory(
                prefix="axial-muse-upgrade-test-"
            ) as temporary_root:
                fixture = UpgradeFixture(temporary_root)
                fixture.install()
                original_fsync = os.fsync
                failures = 0

                def fail_upgrade_root_sync(descriptor):
                    nonlocal failures
                    events = fixture.event_directories()
                    if (
                        events
                        and (
                            (events[0] / UPGRADER.PREPARED_BASENAME).exists()
                            or (
                                events[0] / UPGRADER.ROLLED_BACK_BASENAME
                            ).exists()
                        )
                        and os.fstat(descriptor).st_ino
                        == fixture.upgrade_root.stat().st_ino
                        and (persistent or failures == 0)
                    ):
                        failures += 1
                        raise OSError(
                            errno.EIO,
                            "controlled upgrade-root sync",
                        )
                    return original_fsync(descriptor)

                with mock.patch.object(
                    UPGRADER.os,
                    "fsync",
                    side_effect=fail_upgrade_root_sync,
                ):
                    self.assert_upgrade_error(
                        (
                            "VERIFIER_UPGRADE_OUTCOME_UNKNOWN"
                            if persistent
                            else "VERIFIER_UPGRADE_COMMIT"
                        ),
                        fixture.run,
                    )

                self.assertEqual(failures, 2 if persistent else 1)
                event = fixture.event_directories()[0]
                self.assertTrue(
                    (event / UPGRADER.ROLLED_BACK_BASENAME).is_file()
                )
                self.assertEqual(
                    (
                        fixture.formal / UPGRADER.VERIFIER_BASENAME
                    ).read_bytes(),
                    OLD_VERIFIER,
                )

    def test_new_upgrade_root_sync_failure_is_classified_and_retryable(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            original_fsync = os.fsync
            failures = 0
            descriptors_before = len(os.listdir("/proc/self/fd"))

            def fail_new_upgrade_root_parent_sync(descriptor):
                nonlocal failures
                if (
                    failures == 0
                    and fixture.upgrade_root.exists()
                    and fixture.event_directories() == []
                    and os.fstat(descriptor).st_ino
                    == fixture.namespace.stat().st_ino
                ):
                    failures += 1
                    raise OSError(errno.EIO, "controlled upgrade-root sync")
                return original_fsync(descriptor)

            with mock.patch.object(
                UPGRADER.os,
                "fsync",
                side_effect=fail_new_upgrade_root_parent_sync,
            ):
                self.assert_upgrade_error(
                    "VERIFIER_UPGRADE_COMMIT",
                    fixture.run,
                )

            self.assertEqual(failures, 1)
            self.assertEqual(
                len(os.listdir("/proc/self/fd")),
                descriptors_before,
            )
            self.assertEqual(fixture.event_directories(), [])
            result = fixture.run()
            self.assertEqual(result["disposition"], "upgraded")

    def test_rollback_sync_failure_is_outcome_unknown_not_internal(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            original_pair = UPGRADER._validate_event_pair
            original_exchange = UPGRADER._rename_exchange
            original_fsync = os.fsync
            exchange_count = 0

            def count_exchange(*arguments, **keywords):
                nonlocal exchange_count
                result = original_exchange(*arguments, **keywords)
                exchange_count += 1
                return result

            def fail_after_exchange(*arguments, **keywords):
                if arguments[-1] == "to-from":
                    UPGRADER._fail(
                        "VERIFIER_UPGRADE_TREE",
                        "event/post-exchange",
                    )
                return original_pair(*arguments, **keywords)

            def fail_rollback_sync(descriptor):
                if exchange_count >= 2:
                    raise OSError(errno.EIO, "controlled rollback sync")
                return original_fsync(descriptor)

            with (
                mock.patch.object(
                    UPGRADER,
                    "_rename_exchange",
                    side_effect=count_exchange,
                ),
                mock.patch.object(
                    UPGRADER,
                    "_validate_event_pair",
                    side_effect=fail_after_exchange,
                ),
                mock.patch.object(
                    UPGRADER.os,
                    "fsync",
                    side_effect=fail_rollback_sync,
                ),
            ):
                self.assert_upgrade_error(
                    "VERIFIER_UPGRADE_OUTCOME_UNKNOWN",
                    fixture.run,
                )

            self.assertEqual(exchange_count, 2)
            self.assertEqual(
                (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                OLD_VERIFIER,
            )
            self.assertTrue(
                (
                    fixture.event_directories()[0]
                    / UPGRADER.PREPARED_BASENAME
                ).is_file()
            )

    def test_candidate_and_already_current_self_test_drift_are_rejected(self):
        def drift_after_success(fixture):
            def runner(system_python, verifier_path):
                result = fixture.self_test(system_python, verifier_path)
                path = Path(verifier_path)
                if path.read_bytes() == NEW_VERIFIER:
                    path.write_bytes(NEW_VERIFIER + b"transient")
                    path.write_bytes(NEW_VERIFIER)
                return result

            return runner

        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            self.assert_upgrade_error(
                "VERIFIER_UPGRADE_TREE",
                lambda: fixture.run(
                    _self_test_runner=drift_after_success(fixture)
                ),
            )
            partial_event = fixture.event_directories()[0]
            self.assertFalse(
                (partial_event / UPGRADER.PREPARED_BASENAME).exists()
            )

        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            committed = fixture.run()
            self.assert_upgrade_error(
                "VERIFIER_UPGRADE_TREE",
                lambda: fixture.run(
                    expected_current_receipt_sha256=committed[
                        "componentReceiptSha256"
                    ],
                    _self_test_runner=drift_after_success(fixture),
                ),
            )
            self.assertEqual(len(fixture.event_directories()), 1)

    def test_immediate_rollback_requires_canonical_rolled_back_binding(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            original_rollback = UPGRADER._rollback_prepared
            detached = fixture.namespace / "detached-immediate-rollback"

            def fail_formal_self_test(system_python, verifier_path):
                result = fixture.self_test(system_python, verifier_path)
                if (
                    Path(verifier_path).resolve().parent == fixture.formal
                    and Path(verifier_path).read_bytes() == NEW_VERIFIER
                ):
                    UPGRADER._fail(
                        "VERIFIER_UPGRADE_SELF_TEST",
                        "self-test/result",
                    )
                return result

            def rollback_then_detach(*arguments, **keywords):
                result = original_rollback(*arguments, **keywords)
                fixture.upgrade_root.rename(detached)
                fixture.upgrade_root.mkdir(mode=0o700)
                return result

            with mock.patch.object(
                UPGRADER,
                "_rollback_prepared",
                side_effect=rollback_then_detach,
            ):
                self.assert_upgrade_error(
                    "VERIFIER_UPGRADE_OUTCOME_UNKNOWN",
                    lambda: fixture.run(
                        _self_test_runner=fail_formal_self_test
                    ),
                )

            self.assertEqual(fixture.event_directories(), [])
            event = next(detached.iterdir())
            self.assertTrue((event / UPGRADER.ROLLED_BACK_BASENAME).is_file())

    def test_real_component_uses_held_fds_and_system_python_self_test(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            manifest_path = UPGRADER_PATH.with_name(
                UPGRADER.MANIFEST_BASENAME
            )
            fixture.manifest = manifest_path.read_bytes()
            for basename in (
                UPGRADER.MANIFEST_BASENAME,
                UPGRADER.GOLDEN_BASENAME,
                UPGRADER.VERIFIER_BASENAME,
            ):
                source = UPGRADER_PATH.with_name(basename)
                target = fixture.upgrade_source / basename
                target.write_bytes(source.read_bytes())
                target.chmod(0o600)

            result = fixture.run(
                _system_python="/usr/bin/python3",
                _self_test_runner=BOOTSTRAP._default_self_test_runner,
            )

            self.assertEqual(result["disposition"], "upgraded")
            self.assertEqual(
                (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                UPGRADER_PATH.with_name(
                    UPGRADER.VERIFIER_BASENAME
                ).read_bytes(),
            )
            event = fixture.event_directories()[0]
            receipt = json.loads(
                (event / UPGRADER.RECEIPT_BASENAME).read_bytes()
            )
            self.assertEqual(
                receipt["upgraderSha256"],
                sha256(UPGRADER_PATH.read_bytes()),
            )
            self.assertEqual(
                receipt["bootstrapRunnerSha256"],
                sha256(UPGRADER.BOOTSTRAP_PATH.read_bytes()),
            )
            self.assertEqual(
                receipt["to"]["manifestSha256"],
                sha256(fixture.manifest),
            )

    def test_stale_cas_and_invalid_source_do_not_create_upgrade_state(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            self.assert_upgrade_error(
                "VERIFIER_UPGRADE_STATE",
                lambda: fixture.run(
                    expected_current_receipt_sha256="0" * 64
                ),
            )
            self.assertFalse(fixture.upgrade_root.exists())
            self.assertEqual(
                (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                OLD_VERIFIER,
            )

        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            extra = fixture.upgrade_source / "extra"
            fixture._write_private_source(extra, b"extra\n")
            self.assert_upgrade_error(
                "VERIFIER_UPGRADE_SOURCE",
                fixture.run,
            )
            self.assertFalse(fixture.upgrade_root.exists())

    def test_prepared_recovery_requires_cas_and_not_target_source(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            with mock.patch.object(
                UPGRADER,
                "_activate_event",
                side_effect=SimulatedCrash(),
            ):
                with self.assertRaises(SimulatedCrash):
                    fixture.run()
            event = fixture.event_directories()[0]
            self.assertTrue((event / UPGRADER.PREPARED_BASENAME).is_file())
            fixture._write_private_source(
                fixture.upgrade_source / "unexpected",
                b"invalid source layout\n",
            )

            self.assert_upgrade_error(
                "VERIFIER_UPGRADE_STATE",
                lambda: fixture.run(
                    expected_current_receipt_sha256="0" * 64
                ),
            )
            self.assertTrue((event / UPGRADER.PREPARED_BASENAME).is_file())

            self.assert_upgrade_error(
                "VERIFIER_UPGRADE_ROLLED_BACK",
                fixture.run,
            )
            self.assertTrue((event / UPGRADER.ROLLED_BACK_BASENAME).is_file())
            self.assertEqual(
                (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                OLD_VERIFIER,
            )

    def test_prepared_recovery_requires_canonical_binding_before_and_after(self):
        for stage in ("before-rollback", "after-rollback"):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory(
                prefix="axial-muse-upgrade-test-"
            ) as temporary_root:
                fixture = UpgradeFixture(temporary_root)
                fixture.install()
                with mock.patch.object(
                    UPGRADER,
                    "_activate_event",
                    side_effect=SimulatedCrash(),
                ):
                    with self.assertRaises(SimulatedCrash):
                        fixture.run()
                detached = fixture.namespace / f"detached-{stage}"

                if stage == "before-rollback":
                    original = UPGRADER._load_event_chain

                    def load_then_detach(*arguments, **keywords):
                        result = original(*arguments, **keywords)
                        fixture.upgrade_root.rename(detached)
                        fixture.upgrade_root.mkdir(mode=0o700)
                        return result

                    patcher = mock.patch.object(
                        UPGRADER,
                        "_load_event_chain",
                        side_effect=load_then_detach,
                    )
                    expected_code = "VERIFIER_UPGRADE_STATE"
                    expected_marker = UPGRADER.PREPARED_BASENAME
                else:
                    original = UPGRADER._rollback_prepared

                    def rollback_then_detach(*arguments, **keywords):
                        result = original(*arguments, **keywords)
                        fixture.upgrade_root.rename(detached)
                        fixture.upgrade_root.mkdir(mode=0o700)
                        return result

                    patcher = mock.patch.object(
                        UPGRADER,
                        "_rollback_prepared",
                        side_effect=rollback_then_detach,
                    )
                    expected_code = "VERIFIER_UPGRADE_OUTCOME_UNKNOWN"
                    expected_marker = UPGRADER.ROLLED_BACK_BASENAME

                with patcher:
                    self.assert_upgrade_error(expected_code, fixture.run)

                self.assertEqual(fixture.event_directories(), [])
                detached_event = next(detached.iterdir())
                self.assertTrue(
                    (detached_event / expected_marker).is_file()
                )

    def test_long_event_chain_keeps_only_bounded_event_handles(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            head = fixture.genesis_sha256

            def generic_self_test(_system_python, _verifier_path):
                return {
                    "schemaVersion": UPGRADER.SELF_TEST_SCHEMA_VERSION,
                    "wireMagic": UPGRADER.FILE_TREE_WIRE_MAGIC,
                    "vectorCount": 6,
                }

            for index in range(1, 9):
                manifest_sha256 = fixture.configure_target(
                    f"#!/usr/bin/python3\n# verifier {index}\n".encode(),
                    f'{{"golden":{index}}}\n'.encode(),
                )
                result = fixture.run(
                    expected_current_receipt_sha256=head,
                    expected_target_commit_sha=f"{index:040x}",
                    expected_target_manifest_sha256=manifest_sha256,
                    _self_test_runner=generic_self_test,
                )
                head = result["componentReceiptSha256"]

            manifest_sha256 = fixture.configure_target(
                b"#!/usr/bin/python3\n# verifier final\n",
                b'{"golden":"final"}\n',
            )
            original_open_event = UPGRADER._open_event
            live_handles = 0
            maximum_live_handles = 0

            def track_open_event(*arguments, **keywords):
                nonlocal live_handles, maximum_live_handles
                event = original_open_event(*arguments, **keywords)
                original_close = event.close
                closed = False
                live_handles += 1
                maximum_live_handles = max(maximum_live_handles, live_handles)

                def tracked_close():
                    nonlocal closed, live_handles
                    if closed:
                        return
                    closed = True
                    try:
                        original_close()
                    finally:
                        live_handles -= 1

                event.close = tracked_close
                return event

            with mock.patch.object(
                UPGRADER,
                "_open_event",
                side_effect=track_open_event,
            ):
                result = fixture.run(
                    expected_current_receipt_sha256=head,
                    expected_target_commit_sha="9" * 40,
                    expected_target_manifest_sha256=manifest_sha256,
                    _self_test_runner=generic_self_test,
                )

            self.assertEqual(result["disposition"], "upgraded")
            self.assertEqual(live_handles, 0)
            self.assertLessEqual(maximum_live_handles, 2)

    def test_formal_self_test_failure_rolls_back_and_blocks_new_event(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()

            def fail_new_formal(system_python, verifier_path):
                result = fixture.self_test(system_python, verifier_path)
                path = Path(verifier_path)
                if (
                    path.resolve().parent == fixture.formal
                    and path.read_bytes() == NEW_VERIFIER
                ):
                    UPGRADER._fail(
                        "VERIFIER_UPGRADE_SELF_TEST",
                        "self-test/result",
                    )
                return result

            self.assert_upgrade_error(
                "VERIFIER_UPGRADE_SELF_TEST",
                lambda: fixture.run(_self_test_runner=fail_new_formal),
            )
            self.assertEqual(
                (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                OLD_VERIFIER,
            )
            event = fixture.event_directories()[0]
            self.assertTrue((event / UPGRADER.ROLLED_BACK_BASENAME).is_file())
            self.assertEqual(
                (
                    event
                    / UPGRADER.SLOT_BASENAME
                    / UPGRADER.VERIFIER_BASENAME
                ).read_bytes(),
                NEW_VERIFIER,
            )
            self.assert_upgrade_error("VERIFIER_UPGRADE_STATE", fixture.run)
            self.assertEqual(len(fixture.event_directories()), 1)

    def test_crash_after_exchange_recovers_only_by_rolling_back(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            original_exchange = UPGRADER._rename_exchange

            def exchange_then_crash(*arguments, **keywords):
                original_exchange(*arguments, **keywords)
                raise SimulatedCrash()

            with mock.patch.object(
                UPGRADER,
                "_rename_exchange",
                side_effect=exchange_then_crash,
            ):
                with self.assertRaises(SimulatedCrash):
                    fixture.run()

            event = fixture.event_directories()[0]
            self.assertTrue((event / UPGRADER.PREPARED_BASENAME).is_file())
            self.assertEqual(
                (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                NEW_VERIFIER,
            )
            self.assert_upgrade_error(
                "VERIFIER_UPGRADE_ROLLED_BACK",
                fixture.run,
            )
            self.assertEqual(
                (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                OLD_VERIFIER,
            )
            self.assertTrue((event / UPGRADER.ROLLED_BACK_BASENAME).is_file())

    def test_crash_before_exchange_recovers_only_by_rolling_back(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()

            with mock.patch.object(
                UPGRADER,
                "_activate_event",
                side_effect=SimulatedCrash(),
            ):
                with self.assertRaises(SimulatedCrash):
                    fixture.run()

            event = fixture.event_directories()[0]
            self.assertTrue((event / UPGRADER.PREPARED_BASENAME).is_file())
            self.assertEqual(
                (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                OLD_VERIFIER,
            )
            self.assertEqual(
                (
                    event
                    / UPGRADER.SLOT_BASENAME
                    / UPGRADER.VERIFIER_BASENAME
                ).read_bytes(),
                NEW_VERIFIER,
            )
            self.assert_upgrade_error(
                "VERIFIER_UPGRADE_ROLLED_BACK",
                fixture.run,
            )
            self.assertTrue((event / UPGRADER.ROLLED_BACK_BASENAME).is_file())

    def test_commit_marker_outcome_unknown_recovers_forward(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            original_fsync = os.fsync
            failures = 0

            def fail_first_committed_event_sync(descriptor):
                nonlocal failures
                events = fixture.event_directories()
                if events:
                    event = events[0]
                    if (
                        (event / UPGRADER.COMMITTED_BASENAME).exists()
                        and os.fstat(descriptor).st_ino == event.stat().st_ino
                        and failures == 0
                    ):
                        failures += 1
                        raise OSError(errno.EIO, "controlled event fsync")
                return original_fsync(descriptor)

            with mock.patch.object(
                UPGRADER.os,
                "fsync",
                side_effect=fail_first_committed_event_sync,
            ):
                result = fixture.run()
            self.assertEqual(failures, 1)
            self.assertEqual(result["disposition"], "recovered")
            self.assertEqual(
                (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                NEW_VERIFIER,
            )
            self.assertTrue(
                (
                    fixture.event_directories()[0]
                    / UPGRADER.COMMITTED_BASENAME
                ).is_file()
            )

    def test_persistent_committed_marker_sync_is_outcome_unknown(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            original_fsync = os.fsync
            failures = 0

            def fail_committed_event_sync(descriptor):
                nonlocal failures
                events = fixture.event_directories()
                if events:
                    event = events[0]
                    if (
                        (event / UPGRADER.COMMITTED_BASENAME).exists()
                        and os.fstat(descriptor).st_ino == event.stat().st_ino
                    ):
                        failures += 1
                        raise OSError(errno.EIO, "persistent event fsync")
                return original_fsync(descriptor)

            with mock.patch.object(
                UPGRADER.os,
                "fsync",
                side_effect=fail_committed_event_sync,
            ):
                self.assert_upgrade_error(
                    "VERIFIER_UPGRADE_OUTCOME_UNKNOWN",
                    fixture.run,
                )
            self.assertGreaterEqual(failures, 2)
            event = fixture.event_directories()[0]
            self.assertTrue((event / UPGRADER.COMMITTED_BASENAME).is_file())
            self.assertEqual(
                (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                NEW_VERIFIER,
            )

    def test_lock_contention_fails_before_state_creation(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-upgrade-test-"
        ) as temporary_root:
            fixture = UpgradeFixture(temporary_root)
            fixture.install()
            descriptor = os.open(fixture.lock, os.O_RDWR)
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                with self.assertRaises(BOOTSTRAP.VerifierBootstrapError) as caught:
                    fixture.run()
                self.assertEqual(caught.exception.code, "VERIFIER_BOOTSTRAP_LOCK")
            finally:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)
            self.assertFalse(fixture.upgrade_root.exists())

    def test_pending_interrupt_is_delivered_after_error_rollback(self):
        for signal_number in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal_number=signal_number), tempfile.TemporaryDirectory(
                prefix="axial-muse-upgrade-test-"
            ) as temporary_root:
                fixture = UpgradeFixture(temporary_root)
                fixture.install()
                previous, signal_state = UPGRADER._install_signal_handlers()
                original_pair = UPGRADER._validate_event_pair
                sent = False

                def interrupt_preflight(*arguments, **keywords):
                    nonlocal sent
                    if not sent:
                        sent = True
                        os.kill(os.getpid(), signal_number)
                        UPGRADER._fail(
                            "VERIFIER_UPGRADE_TREE",
                            "event/preflight",
                        )
                    return original_pair(*arguments, **keywords)

                try:
                    with mock.patch.object(
                        UPGRADER,
                        "_validate_event_pair",
                        side_effect=interrupt_preflight,
                    ):
                        self.assert_upgrade_error(
                            "VERIFIER_UPGRADE_INTERRUPTED",
                            lambda: fixture.run(_signal_state=signal_state),
                        )
                finally:
                    UPGRADER._restore_signal_handlers(previous)
                self.assertEqual(
                    (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                    OLD_VERIFIER,
                )
                self.assertTrue(
                    (
                        fixture.event_directories()[0]
                        / UPGRADER.ROLLED_BACK_BASENAME
                    ).is_file()
                )

    def test_masked_real_interrupt_after_prepare_observes_commit(self):
        for signal_number in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal_number=signal_number), tempfile.TemporaryDirectory(
                prefix="axial-muse-upgrade-test-"
            ) as temporary_root:
                fixture = UpgradeFixture(temporary_root)
                fixture.install()
                previous, signal_state = UPGRADER._install_signal_handlers()
                original_pair = UPGRADER._validate_event_pair
                sent = False

                def interrupt_preflight(*arguments, **keywords):
                    nonlocal sent
                    if not sent:
                        sent = True
                        os.kill(os.getpid(), signal_number)
                    return original_pair(*arguments, **keywords)

                try:
                    with mock.patch.object(
                        UPGRADER,
                        "_validate_event_pair",
                        side_effect=interrupt_preflight,
                    ):
                        result = fixture.run(_signal_state=signal_state)
                finally:
                    UPGRADER._restore_signal_handlers(previous)
                self.assertTrue(sent)
                self.assertEqual(result["disposition"], "upgraded")
                self.assertEqual(
                    (fixture.formal / UPGRADER.VERIFIER_BASENAME).read_bytes(),
                    NEW_VERIFIER,
                )

    def test_cli_rejects_force_cleanup_and_reordering(self):
        valid = [
            "--source-root",
            "/private/source",
            "--expected-current-receipt-sha256",
            "1" * 64,
            "--expected-target-commit-sha",
            NEW_COMMIT,
            "--expected-target-manifest-sha256",
            "2" * 64,
        ]
        self.assertEqual(
            UPGRADER._parse_cli_arguments(valid)["--source-root"],
            "/private/source",
        )
        for invalid in (
            valid[:-2],
            [*valid, "--force", "yes"],
            [*valid, "--cleanup", "yes"],
            [*valid[2:4], *valid[:2], *valid[4:]],
        ):
            with self.subTest(invalid=invalid):
                self.assert_upgrade_error(
                    "VERIFIER_UPGRADE_ARGUMENT",
                    lambda invalid=invalid: UPGRADER._parse_cli_arguments(
                        invalid
                    ),
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)

import contextlib
import errno
import fcntl
import hashlib
import importlib.util
import io
import json
import os
import signal
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP_PATH = (
    REPOSITORY_ROOT / "ops" / "deploy" / "bootstrap_artifact_verifier.py"
)
SPEC = importlib.util.spec_from_file_location(
    "axial_muse_artifact_verifier_bootstrap",
    BOOTSTRAP_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("无法加载 artifact verifier bootstrap。")
BOOTSTRAP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BOOTSTRAP)

COMMIT_SHA = "a" * 40
VERIFIER_BYTES = b"#!/usr/bin/python3\n# verifier fixture\n"
GOLDEN_BYTES = b'{"fixture":"golden"}\n'


def sha256(value):
    return hashlib.sha256(value).hexdigest()


class SimulatedCrash(BaseException):
    pass


class BrokenStream:
    def write(self, _value):
        raise BrokenPipeError("fixture")

    def flush(self):
        raise BrokenPipeError("fixture")


class BootstrapFixture:
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

        self.source = Path(temporary_root) / "source"
        self.source.mkdir(mode=0o700)
        self.verifier_source = (
            self.source / BOOTSTRAP.VERIFIER_BASENAME
        )
        self.golden_source = self.source / BOOTSTRAP.GOLDEN_BASENAME
        self.verifier_source.write_bytes(VERIFIER_BYTES)
        self.golden_source.write_bytes(GOLDEN_BYTES)
        self.verifier_source.chmod(0o600)
        self.golden_source.chmod(0o600)
        self.self_test_paths = []

    @property
    def formal(self):
        return self.lib / BOOTSTRAP.FORMAL_NAMESPACE

    @property
    def lock(self):
        return self.lib / BOOTSTRAP.LOCK_BASENAME

    @property
    def options(self):
        return {
            "source_root": str(self.source),
            "expected_commit_sha": COMMIT_SHA,
            "expected_verifier_sha256": sha256(VERIFIER_BYTES),
            "expected_golden_sha256": sha256(GOLDEN_BYTES),
            "_root_path": str(self.root),
            "_expected_uid": os.getuid(),
            "_expected_gid": os.getgid(),
            "_system_python": "/fixture/python3",
            "_self_test_runner": self.self_test,
            "_transaction_id_factory": lambda: "b" * 32,
            "_enforce_runtime": False,
        }

    def self_test(self, system_python, verifier_path):
        self.assert_self_test_path(system_python, verifier_path)
        self.self_test_paths.append(Path(verifier_path))
        return {
            "schemaVersion": "1.0.0",
            "wireMagic": "AXIALMUSE-FILE-TREE-V1",
            "vectorCount": 6,
        }

    def assert_self_test_path(self, system_python, verifier_path):
        if system_python != "/fixture/python3":
            raise AssertionError("unexpected Python path")
        path = Path(verifier_path)
        if path.name != BOOTSTRAP.VERIFIER_BASENAME:
            raise AssertionError("unexpected verifier path")
        if path.read_bytes() != VERIFIER_BYTES:
            raise AssertionError("unexpected verifier bytes")
        sibling = path.with_name(BOOTSTRAP.GOLDEN_BASENAME)
        if sibling.read_bytes() != GOLDEN_BYTES:
            raise AssertionError("unexpected golden bytes")

    def run(self, **overrides):
        values = self.options
        values.update(overrides)
        return BOOTSTRAP.bootstrap_artifact_verifier(**values)

    def reserved_names(self):
        return sorted(
            path.name
            for path in self.lib.iterdir()
            if (
                path.name == BOOTSTRAP.FORMAL_NAMESPACE
                or path.name.startswith(
                    ".axialmuse-artifact-verifier-"
                )
            )
        )


class ArtifactVerifierBootstrapTests(unittest.TestCase):
    def assert_error(self, code, operation):
        with self.assertRaises(BOOTSTRAP.VerifierBootstrapError) as captured:
            operation()
        self.assertEqual(captured.exception.code, code)
        return captured.exception

    def test_fresh_install_commits_exact_tree_and_is_idempotent(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            output = io.StringIO()
            result = fixture.run(success_stream=output)

            self.assertEqual(result["status"], "committed")
            self.assertEqual(result["disposition"], "installed")
            self.assertEqual(result["commitSha"], COMMIT_SHA)
            self.assertEqual(json.loads(output.getvalue()), result)
            self.assertEqual(output.getvalue().count("\n"), 1)
            self.assertEqual(
                fixture.reserved_names(),
                [
                    BOOTSTRAP.LOCK_BASENAME,
                    BOOTSTRAP.FORMAL_NAMESPACE,
                ],
            )

            install = fixture.formal / BOOTSTRAP.INSTALL_DIRECTORY
            state = fixture.formal / BOOTSTRAP.STATE_DIRECTORY
            self.assertEqual(
                sorted(path.name for path in install.iterdir()),
                [
                    BOOTSTRAP.GOLDEN_BASENAME,
                    BOOTSTRAP.VERIFIER_BASENAME,
                ],
            )
            self.assertEqual(
                sorted(path.name for path in state.iterdir()),
                [
                    BOOTSTRAP.COMMITTED_BASENAME,
                    BOOTSTRAP.RECEIPT_BASENAME,
                ],
            )
            self.assertEqual(
                (install / BOOTSTRAP.VERIFIER_BASENAME).read_bytes(),
                VERIFIER_BYTES,
            )
            self.assertEqual(
                (install / BOOTSTRAP.GOLDEN_BASENAME).read_bytes(),
                GOLDEN_BYTES,
            )
            expected_modes = {
                fixture.formal: 0o755,
                install: 0o755,
                state: 0o700,
                install / BOOTSTRAP.VERIFIER_BASENAME: 0o755,
                install / BOOTSTRAP.GOLDEN_BASENAME: 0o644,
                state / BOOTSTRAP.RECEIPT_BASENAME: 0o600,
                state / BOOTSTRAP.COMMITTED_BASENAME: 0o600,
                fixture.lock: 0o600,
            }
            for path, mode in expected_modes.items():
                with self.subTest(path=path):
                    metadata = path.stat(follow_symlinks=False)
                    self.assertEqual(stat.S_IMODE(metadata.st_mode), mode)
                    self.assertEqual(metadata.st_uid, os.getuid())
                    self.assertEqual(metadata.st_gid, os.getgid())
            receipt = json.loads(
                (state / BOOTSTRAP.RECEIPT_BASENAME).read_text(
                    encoding="ascii"
                )
            )
            self.assertEqual(
                receipt["schemaVersion"],
                BOOTSTRAP.RECEIPT_SCHEMA_VERSION,
            )
            self.assertEqual(
                receipt["lockIdentity"],
                {
                    "device": fixture.lock.stat().st_dev,
                    "inode": fixture.lock.stat().st_ino,
                },
            )
            verifier_inode = (
                install / BOOTSTRAP.VERIFIER_BASENAME
            ).stat().st_ino
            committed_inode = (
                state / BOOTSTRAP.COMMITTED_BASENAME
            ).stat().st_ino

            second_output = io.StringIO()
            second = fixture.run(success_stream=second_output)
            self.assertEqual(second["disposition"], "already-committed")
            self.assertEqual(
                (install / BOOTSTRAP.VERIFIER_BASENAME).stat().st_ino,
                verifier_inode,
            )
            self.assertEqual(
                (state / BOOTSTRAP.COMMITTED_BASENAME).stat().st_ino,
                committed_inode,
            )
            self.assertEqual(len(fixture.self_test_paths), 3)

    def test_source_root_is_closed_stable_and_digest_bound(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            (fixture.source / "extra.txt").write_text(
                "unexpected",
                encoding="utf-8",
            )
            (fixture.source / "extra.txt").chmod(0o600)
            self.assert_error(
                "VERIFIER_BOOTSTRAP_SOURCE",
                fixture.run,
            )
            self.assertFalse(fixture.lock.exists())

        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            options = {
                "expected_verifier_sha256": "0" * 64,
            }
            self.assert_error(
                "VERIFIER_BOOTSTRAP_SOURCE",
                lambda: fixture.run(**options),
            )
            self.assertFalse(fixture.lock.exists())

        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            fixture.verifier_source.chmod(0o644)
            self.assert_error(
                "VERIFIER_BOOTSTRAP_SOURCE",
                fixture.run,
            )
            self.assertFalse(fixture.lock.exists())

    def test_real_verifier_and_golden_pass_system_python_self_test(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            verifier_bytes = (
                REPOSITORY_ROOT
                / "ops"
                / "deploy"
                / BOOTSTRAP.VERIFIER_BASENAME
            ).read_bytes()
            golden_bytes = (
                REPOSITORY_ROOT
                / "ops"
                / "deploy"
                / BOOTSTRAP.GOLDEN_BASENAME
            ).read_bytes()
            fixture.verifier_source.write_bytes(verifier_bytes)
            fixture.golden_source.write_bytes(golden_bytes)
            fixture.verifier_source.chmod(0o600)
            fixture.golden_source.chmod(0o600)

            result = fixture.run(
                expected_verifier_sha256=sha256(verifier_bytes),
                expected_golden_sha256=sha256(golden_bytes),
                _system_python="/usr/bin/python3",
                _self_test_runner=BOOTSTRAP._default_self_test_runner,
            )
            self.assertEqual(result["status"], "committed")
            self.assertEqual(result["disposition"], "installed")

    def test_source_symlink_and_hardlink_are_rejected(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            outside = Path(temporary_root) / "outside-verifier"
            outside.write_bytes(VERIFIER_BYTES)
            outside.chmod(0o600)
            fixture.verifier_source.unlink()
            fixture.verifier_source.symlink_to(outside)
            self.assert_error(
                "VERIFIER_BOOTSTRAP_SOURCE",
                fixture.run,
            )

        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            fixture.verifier_source.unlink()
            os.mkfifo(fixture.verifier_source, mode=0o600)
            self.assert_error(
                "VERIFIER_BOOTSTRAP_SOURCE",
                fixture.run,
            )

        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            outside = Path(temporary_root) / "outside-verifier"
            os.link(fixture.verifier_source, outside)
            self.assert_error(
                "VERIFIER_BOOTSTRAP_SOURCE",
                fixture.run,
            )

    def test_source_rebind_race_reports_source_error(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            original_read_all = BOOTSTRAP._read_all
            replaced = False
            displaced = Path(temporary_root) / "displaced-verifier"
            replacement = Path(temporary_root) / "replacement-verifier"
            replacement.write_bytes(VERIFIER_BYTES)
            replacement.chmod(0o600)

            def replace_after_source_read(
                descriptor,
                maximum_bytes,
                code,
                source_path,
            ):
                nonlocal replaced
                result = original_read_all(
                    descriptor,
                    maximum_bytes,
                    code,
                    source_path,
                )
                if (
                    not replaced
                    and source_path
                    == f"source/{BOOTSTRAP.VERIFIER_BASENAME}"
                ):
                    replaced = True
                    fixture.verifier_source.rename(displaced)
                    fixture.verifier_source.symlink_to(replacement)
                return result

            with mock.patch.object(
                BOOTSTRAP,
                "_read_all",
                side_effect=replace_after_source_read,
            ):
                error = self.assert_error(
                    "VERIFIER_BOOTSTRAP_SOURCE",
                    fixture.run,
                )
            self.assertTrue(replaced)
            self.assertEqual(
                error.source_path,
                f"source/{BOOTSTRAP.VERIFIER_BASENAME}",
            )
            self.assertFalse(fixture.lock.exists())

    def test_lock_contention_fails_before_state_enumeration(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            fixture.lock.write_bytes(b"")
            fixture.lock.chmod(0o600)
            descriptor = os.open(fixture.lock, os.O_RDWR)
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                with mock.patch.object(
                    BOOTSTRAP,
                    "_discover_state",
                    side_effect=AssertionError("state read before lock"),
                ) as discover:
                    self.assert_error(
                        "VERIFIER_BOOTSTRAP_LOCK",
                        fixture.run,
                    )
                discover.assert_not_called()
            finally:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)

    def test_parent_directory_lock_prevents_replacement_bypass(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            fixture.lock.write_bytes(b"")
            fixture.lock.chmod(0o600)
            directory_descriptor = os.open(
                fixture.lib,
                os.O_RDONLY | os.O_DIRECTORY,
            )
            fcntl.flock(
                directory_descriptor,
                fcntl.LOCK_EX | fcntl.LOCK_NB,
            )
            displaced_lock = Path(temporary_root) / "displaced-lock"
            fixture.lock.rename(displaced_lock)
            fixture.lock.write_bytes(b"")
            fixture.lock.chmod(0o600)
            try:
                with mock.patch.object(
                    BOOTSTRAP,
                    "_discover_state",
                    side_effect=AssertionError(
                        "state read before parent lock"
                    ),
                ) as discover:
                    self.assert_error(
                        "VERIFIER_BOOTSTRAP_LOCK",
                        fixture.run,
                    )
                discover.assert_not_called()
                self.assertFalse(fixture.formal.exists())
                self.assertFalse(
                    any(
                        name.startswith(BOOTSTRAP.CANDIDATE_PREFIX)
                        for name in fixture.reserved_names()
                    )
                )
            finally:
                fcntl.flock(directory_descriptor, fcntl.LOCK_UN)
                os.close(directory_descriptor)

            self.assertEqual(
                fixture.run()["disposition"],
                "installed",
            )

    def test_lock_path_replacement_cannot_admit_nested_bootstrap(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            original_reverify = BOOTSTRAP._reverify_lock
            nested_errors = []
            replaced = False

            def replace_after_live_check(tree, lock_descriptor):
                nonlocal replaced
                original_reverify(tree, lock_descriptor)
                prepared = (
                    fixture.formal
                    / BOOTSTRAP.STATE_DIRECTORY
                    / BOOTSTRAP.PREPARED_BASENAME
                )
                if not replaced and prepared.exists():
                    replaced = True
                    displaced = Path(temporary_root) / "displaced-lock"
                    fixture.lock.rename(displaced)
                    fixture.lock.write_bytes(b"")
                    fixture.lock.chmod(0o600)
                    try:
                        fixture.run()
                    except BOOTSTRAP.VerifierBootstrapError as error:
                        nested_errors.append(error.code)
                    else:
                        nested_errors.append("unexpected-success")

            with mock.patch.object(
                BOOTSTRAP,
                "_reverify_lock",
                side_effect=replace_after_live_check,
            ):
                self.assert_error(
                    "VERIFIER_BOOTSTRAP_ISOLATE",
                    fixture.run,
                )
            self.assertTrue(replaced)
            self.assertEqual(
                nested_errors,
                ["VERIFIER_BOOTSTRAP_LOCK"],
            )
            state = fixture.formal / BOOTSTRAP.STATE_DIRECTORY
            self.assertTrue(
                (state / BOOTSTRAP.PREPARED_BASENAME).is_file()
            )
            self.assertFalse(
                (state / BOOTSTRAP.COMMITTED_BASENAME).exists()
            )
            self.assert_error(
                "VERIFIER_BOOTSTRAP_LOCK",
                fixture.run,
            )

    def test_candidate_prepared_recovers_after_crash_before_activation(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            original = BOOTSTRAP._rename_noreplace_at

            def crash_before_activation(*arguments, **keywords):
                if (
                    arguments[1].startswith(BOOTSTRAP.CANDIDATE_PREFIX)
                    and arguments[3] == BOOTSTRAP.FORMAL_NAMESPACE
                ):
                    raise SimulatedCrash()
                return original(*arguments, **keywords)

            with mock.patch.object(
                BOOTSTRAP,
                "_rename_noreplace_at",
                side_effect=crash_before_activation,
            ):
                with self.assertRaises(SimulatedCrash):
                    fixture.run()
            candidate_names = [
                name
                for name in fixture.reserved_names()
                if name.startswith(BOOTSTRAP.CANDIDATE_PREFIX)
            ]
            self.assertEqual(len(candidate_names), 1)
            candidate_state = (
                fixture.lib
                / candidate_names[0]
                / BOOTSTRAP.STATE_DIRECTORY
            )
            self.assertTrue(
                (candidate_state / BOOTSTRAP.PREPARED_BASENAME).is_file()
            )

            result = fixture.run()
            self.assertEqual(result["disposition"], "recovered")
            self.assertTrue(fixture.formal.is_dir())
            self.assertFalse(
                any(
                    name.startswith(BOOTSTRAP.CANDIDATE_PREFIX)
                    for name in fixture.reserved_names()
                )
            )

    def test_formal_prepared_recovers_after_crash_before_marker_commit(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            with mock.patch.object(
                BOOTSTRAP,
                "_commit_marker",
                side_effect=SimulatedCrash(),
            ):
                with self.assertRaises(SimulatedCrash):
                    fixture.run()
            state = fixture.formal / BOOTSTRAP.STATE_DIRECTORY
            self.assertTrue(
                (state / BOOTSTRAP.PREPARED_BASENAME).is_file()
            )
            self.assertFalse(
                (state / BOOTSTRAP.COMMITTED_BASENAME).exists()
            )

            result = fixture.run()
            self.assertEqual(result["disposition"], "recovered")
            self.assertTrue(
                (state / BOOTSTRAP.COMMITTED_BASENAME).is_file()
            )
            self.assertFalse(
                (state / BOOTSTRAP.PREPARED_BASENAME).exists()
            )

    def test_candidate_committed_recovers_without_replacing_marker_inode(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)

            with mock.patch.object(
                BOOTSTRAP,
                "_rename_noreplace_at",
                side_effect=SimulatedCrash(),
            ):
                with self.assertRaises(SimulatedCrash):
                    fixture.run()
            candidate_name = next(
                name
                for name in fixture.reserved_names()
                if name.startswith(BOOTSTRAP.CANDIDATE_PREFIX)
            )
            state = (
                fixture.lib
                / candidate_name
                / BOOTSTRAP.STATE_DIRECTORY
            )
            prepared = state / BOOTSTRAP.PREPARED_BASENAME
            committed = state / BOOTSTRAP.COMMITTED_BASENAME
            prepared.rename(committed)
            marker_inode = committed.stat().st_ino

            result = fixture.run()
            self.assertEqual(result["disposition"], "recovered")
            formal_marker = (
                fixture.formal
                / BOOTSTRAP.STATE_DIRECTORY
                / BOOTSTRAP.COMMITTED_BASENAME
            )
            self.assertEqual(formal_marker.stat().st_ino, marker_inode)

    def test_self_test_failure_isolates_bound_prepared_candidate(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)

            def fail_self_test(_python, _path):
                BOOTSTRAP._fail(
                    "VERIFIER_BOOTSTRAP_SELF_TEST",
                    "self-test/result",
                )

            self.assert_error(
                "VERIFIER_BOOTSTRAP_SELF_TEST",
                lambda: fixture.run(_self_test_runner=fail_self_test),
            )
            self.assertFalse(fixture.formal.exists())
            isolation_names = [
                name
                for name in fixture.reserved_names()
                if name.startswith(BOOTSTRAP.ISOLATION_PREFIX)
            ]
            self.assertEqual(len(isolation_names), 1)
            self.assert_error(
                "VERIFIER_BOOTSTRAP_STATE",
                fixture.run,
            )

    def test_formal_self_test_failure_is_not_masked_by_retry(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            calls = []

            def fail_first_formal_self_test(system_python, verifier_path):
                fixture.assert_self_test_path(system_python, verifier_path)
                calls.append(Path(verifier_path))
                if len(calls) == 2:
                    BOOTSTRAP._fail(
                        "VERIFIER_BOOTSTRAP_SELF_TEST",
                        "self-test/result",
                    )
                return {
                    "schemaVersion": "1.0.0",
                    "wireMagic": "AXIALMUSE-FILE-TREE-V1",
                    "vectorCount": 6,
                }

            self.assert_error(
                "VERIFIER_BOOTSTRAP_SELF_TEST",
                lambda: fixture.run(
                    _self_test_runner=fail_first_formal_self_test
                ),
            )
            self.assertEqual(len(calls), 2)
            self.assertTrue(
                calls[0].parts[-3].startswith(BOOTSTRAP.CANDIDATE_PREFIX)
            )
            self.assertEqual(calls[1].parts[-3], BOOTSTRAP.FORMAL_NAMESPACE)
            self.assertFalse(fixture.formal.exists())
            isolation_names = [
                name
                for name in fixture.reserved_names()
                if name.startswith(BOOTSTRAP.ISOLATION_PREFIX)
            ]
            self.assertEqual(len(isolation_names), 1)
            isolation = fixture.lib / isolation_names[0]
            self.assertEqual(stat.S_IMODE(isolation.stat().st_mode), 0o700)
            state = isolation / BOOTSTRAP.STATE_DIRECTORY
            self.assertTrue(
                (state / BOOTSTRAP.PREPARED_BASENAME).is_file()
            )
            self.assertFalse(
                (state / BOOTSTRAP.COMMITTED_BASENAME).exists()
            )
            receipt = json.loads(
                (state / BOOTSTRAP.RECEIPT_BASENAME).read_text(
                    encoding="ascii"
                )
            )
            self.assertEqual(
                receipt["namespaceIdentity"]["inode"],
                isolation.stat().st_ino,
            )
            self.assertEqual(
                sha256(
                    (
                        isolation
                        / BOOTSTRAP.INSTALL_DIRECTORY
                        / BOOTSTRAP.VERIFIER_BASENAME
                    ).read_bytes()
                ),
                sha256(VERIFIER_BYTES),
            )
            self.assert_error("VERIFIER_BOOTSTRAP_STATE", fixture.run)

    def test_post_activation_parent_fsync_error_isolates(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            original_fsync = os.fsync
            injected = False

            def fail_first_formal_parent_sync(descriptor):
                nonlocal injected
                if (
                    not injected
                    and fixture.formal.exists()
                    and os.fstat(descriptor).st_ino
                    == fixture.lib.stat().st_ino
                ):
                    injected = True
                    raise OSError(errno.EIO, "fixture")
                return original_fsync(descriptor)

            with mock.patch.object(
                BOOTSTRAP.os,
                "fsync",
                side_effect=fail_first_formal_parent_sync,
            ):
                self.assert_error(
                    "VERIFIER_BOOTSTRAP_COMMIT",
                    fixture.run,
                )
            self.assertTrue(injected)
            self.assertFalse(fixture.formal.exists())
            isolation_names = [
                name
                for name in fixture.reserved_names()
                if name.startswith(BOOTSTRAP.ISOLATION_PREFIX)
            ]
            self.assertEqual(len(isolation_names), 1)
            state = (
                fixture.lib
                / isolation_names[0]
                / BOOTSTRAP.STATE_DIRECTORY
            )
            self.assertTrue(
                (state / BOOTSTRAP.PREPARED_BASENAME).is_file()
            )
            self.assertFalse(
                (state / BOOTSTRAP.COMMITTED_BASENAME).exists()
            )
            self.assert_error("VERIFIER_BOOTSTRAP_STATE", fixture.run)

    def test_activation_collision_preserves_external_target(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            original = BOOTSTRAP._rename_noreplace_at
            external_inode = {}

            def create_collision(*arguments, **keywords):
                if (
                    arguments[1].startswith(BOOTSTRAP.CANDIDATE_PREFIX)
                    and arguments[3] == BOOTSTRAP.FORMAL_NAMESPACE
                ):
                    fixture.formal.mkdir()
                    sentinel = fixture.formal / "external"
                    sentinel.write_text("keep", encoding="utf-8")
                    external_inode["value"] = fixture.formal.stat().st_ino
                return original(*arguments, **keywords)

            with mock.patch.object(
                BOOTSTRAP,
                "_rename_noreplace_at",
                side_effect=create_collision,
            ):
                self.assert_error(
                    "VERIFIER_BOOTSTRAP_COMMIT",
                    fixture.run,
                )
            self.assertEqual(
                fixture.formal.stat().st_ino,
                external_inode["value"],
            )
            self.assertEqual(
                (fixture.formal / "external").read_text(encoding="utf-8"),
                "keep",
            )
            self.assertEqual(
                len(
                    [
                        name
                        for name in fixture.reserved_names()
                        if name.startswith(BOOTSTRAP.ISOLATION_PREFIX)
                    ]
                ),
                1,
            )

    def test_committed_marker_error_recovers_as_success(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            original = BOOTSTRAP._commit_marker
            calls = 0

            def fail_after_commit(transaction):
                nonlocal calls
                calls += 1
                original(transaction)
                BOOTSTRAP._fail(
                    "VERIFIER_BOOTSTRAP_COMMIT",
                    "commit/fixture",
                )

            with mock.patch.object(
                BOOTSTRAP,
                "_commit_marker",
                side_effect=fail_after_commit,
            ):
                result = fixture.run()
            self.assertEqual(calls, 1)
            self.assertEqual(result["status"], "committed")
            self.assertTrue(
                (
                    fixture.formal
                    / BOOTSTRAP.STATE_DIRECTORY
                    / BOOTSTRAP.COMMITTED_BASENAME
                ).is_file()
            )

    def test_persistent_committed_marker_fsync_is_commit_error(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            original_fsync = os.fsync
            failures = 0

            def fail_committed_state_sync(descriptor):
                nonlocal failures
                committed = (
                    fixture.formal
                    / BOOTSTRAP.STATE_DIRECTORY
                    / BOOTSTRAP.COMMITTED_BASENAME
                )
                state = fixture.formal / BOOTSTRAP.STATE_DIRECTORY
                if (
                    committed.exists()
                    and state.exists()
                    and os.fstat(descriptor).st_ino == state.stat().st_ino
                ):
                    failures += 1
                    raise OSError(errno.EIO, "fixture")
                return original_fsync(descriptor)

            with mock.patch.object(
                BOOTSTRAP.os,
                "fsync",
                side_effect=fail_committed_state_sync,
            ):
                self.assert_error(
                    "VERIFIER_BOOTSTRAP_COMMIT",
                    fixture.run,
                )
            self.assertEqual(failures, 2)
            state = fixture.formal / BOOTSTRAP.STATE_DIRECTORY
            self.assertTrue(
                (state / BOOTSTRAP.COMMITTED_BASENAME).is_file()
            )
            self.assertFalse(
                (state / BOOTSTRAP.PREPARED_BASENAME).exists()
            )
            self.assertFalse(
                any(
                    name.startswith(BOOTSTRAP.ISOLATION_PREFIX)
                    for name in fixture.reserved_names()
                )
            )
            self.assertEqual(
                fixture.run()["disposition"],
                "already-committed",
            )

    def test_committed_install_is_not_failed_by_broken_stdout(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            result = fixture.run(success_stream=BrokenStream())
            self.assertEqual(result["status"], "committed")
            self.assertTrue(fixture.formal.is_dir())
            self.assertEqual(
                fixture.run()["disposition"],
                "already-committed",
            )

    def test_committed_lock_inode_replacement_fails_closed(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            fixture.run()
            state = fixture.formal / BOOTSTRAP.STATE_DIRECTORY
            receipt_path = state / BOOTSTRAP.RECEIPT_BASENAME
            marker_path = state / BOOTSTRAP.COMMITTED_BASENAME
            identities = {
                "formal": fixture.formal.stat().st_ino,
                "receipt": receipt_path.stat().st_ino,
                "marker": marker_path.stat().st_ino,
            }
            displaced_lock = Path(temporary_root) / "displaced-lock"
            fixture.lock.rename(displaced_lock)
            fixture.lock.write_bytes(b"")
            fixture.lock.chmod(0o600)

            error = self.assert_error(
                "VERIFIER_BOOTSTRAP_LOCK",
                fixture.run,
            )
            self.assertEqual(error.source_path, "state/lock-identity")
            self.assertEqual(fixture.formal.stat().st_ino, identities["formal"])
            self.assertEqual(receipt_path.stat().st_ino, identities["receipt"])
            self.assertEqual(marker_path.stat().st_ino, identities["marker"])
            self.assertFalse(
                any(
                    name.startswith(BOOTSTRAP.ISOLATION_PREFIX)
                    for name in fixture.reserved_names()
                )
            )

    def test_committed_tree_drift_fails_without_isolation_or_overwrite(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            fixture.run()
            verifier = (
                fixture.formal
                / BOOTSTRAP.INSTALL_DIRECTORY
                / BOOTSTRAP.VERIFIER_BASENAME
            )
            original_inode = verifier.stat().st_ino
            verifier.write_bytes(b"changed\n")
            verifier.chmod(0o755)

            error = self.assert_error(
                "VERIFIER_BOOTSTRAP_RECEIPT",
                fixture.run,
            )
            self.assertEqual(error.source_path, "transaction/receipt")
            self.assertEqual(verifier.stat().st_ino, original_inode)
            self.assertFalse(
                any(
                    name.startswith(BOOTSTRAP.ISOLATION_PREFIX)
                    for name in fixture.reserved_names()
                )
            )

    def test_system_lib_path_swap_is_detected_before_commit(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            swapped = False
            old_lib = fixture.lib.with_name("lib-held")

            def swap_path(system_python, verifier_path):
                nonlocal swapped
                fixture.assert_self_test_path(system_python, verifier_path)
                if not swapped:
                    swapped = True
                    fixture.lib.rename(old_lib)
                    fixture.lib.mkdir(mode=0o755)
                    (fixture.lib / "external").write_text(
                        "keep",
                        encoding="utf-8",
                    )
                return {
                    "schemaVersion": "1.0.0",
                    "wireMagic": "AXIALMUSE-FILE-TREE-V1",
                    "vectorCount": 6,
                }

            self.assert_error(
                "VERIFIER_BOOTSTRAP_PARENT",
                lambda: fixture.run(_self_test_runner=swap_path),
            )
            self.assertEqual(
                (fixture.lib / "external").read_text(encoding="utf-8"),
                "keep",
            )
            self.assertFalse((fixture.lib / BOOTSTRAP.FORMAL_NAMESPACE).exists())

    def test_preexisting_formal_namespace_is_preserved(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            fixture.formal.mkdir()
            sentinel = fixture.formal / "external"
            sentinel.write_text("keep", encoding="utf-8")
            inode = fixture.formal.stat().st_ino
            self.assert_error(
                "VERIFIER_BOOTSTRAP_TREE",
                fixture.run,
            )
            self.assertEqual(fixture.formal.stat().st_ino, inode)
            self.assertEqual(
                sentinel.read_text(encoding="utf-8"),
                "keep",
            )

    def test_real_interrupt_before_commit_isolates_and_restores_handlers(self):
        for signal_number in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal_number=signal_number), tempfile.TemporaryDirectory(
                prefix="axial-muse-bootstrap-test-"
            ) as temporary_root:
                fixture = BootstrapFixture(temporary_root)
                previous, signal_state = BOOTSTRAP._install_signal_handlers()

                def interrupt_self_test(_python, _path):
                    os.kill(os.getpid(), signal_number)
                    raise AssertionError("signal handler must interrupt self-test")

                try:
                    error = self.assert_error(
                        "VERIFIER_BOOTSTRAP_INTERRUPTED",
                        lambda: fixture.run(
                            _self_test_runner=interrupt_self_test,
                            _signal_state=signal_state,
                        ),
                    )
                finally:
                    BOOTSTRAP._restore_signal_handlers(previous)

                self.assertEqual(error.source_path, "process/signal")
                self.assertFalse(fixture.formal.exists())
                isolation_names = [
                    name
                    for name in fixture.reserved_names()
                    if name.startswith(BOOTSTRAP.ISOLATION_PREFIX)
                ]
                self.assertEqual(len(isolation_names), 1)
                self.assertEqual(
                    stat.S_IMODE((fixture.lib / isolation_names[0]).stat().st_mode),
                    0o700,
                )
                self.assert_error("VERIFIER_BOOTSTRAP_STATE", fixture.run)
                for installed_signal, handler in previous.items():
                    self.assertIs(signal.getsignal(installed_signal), handler)

    def test_masked_interrupts_are_delayed_until_commit(self):
        for signal_number in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal_number=signal_number), tempfile.TemporaryDirectory(
                prefix="axial-muse-bootstrap-test-"
            ) as temporary_root:
                fixture = BootstrapFixture(temporary_root)
                previous, signal_state = BOOTSTRAP._install_signal_handlers()
                calls = []

                def interrupt_formal_self_test(system_python, verifier_path):
                    fixture.assert_self_test_path(system_python, verifier_path)
                    calls.append(Path(verifier_path))
                    if Path(verifier_path).parts[-3] == BOOTSTRAP.FORMAL_NAMESPACE:
                        os.kill(os.getpid(), signal_number)
                    return {
                        "schemaVersion": "1.0.0",
                        "wireMagic": "AXIALMUSE-FILE-TREE-V1",
                        "vectorCount": 6,
                    }

                try:
                    result = fixture.run(
                        _self_test_runner=interrupt_formal_self_test,
                        _signal_state=signal_state,
                    )
                finally:
                    BOOTSTRAP._restore_signal_handlers(previous)

                self.assertEqual(result["status"], "committed")
                self.assertTrue(signal_state["commitCompleted"])
                self.assertTrue(
                    (
                        fixture.formal
                        / BOOTSTRAP.STATE_DIRECTORY
                        / BOOTSTRAP.COMMITTED_BASENAME
                    ).is_file()
                )
                self.assertEqual(len(calls), 2)

    def test_real_interrupt_after_durable_commit_is_success(self):
        for signal_number in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal_number=signal_number), tempfile.TemporaryDirectory(
                prefix="axial-muse-bootstrap-test-"
            ) as temporary_root:
                fixture = BootstrapFixture(temporary_root)
                previous, signal_state = BOOTSTRAP._install_signal_handlers()
                original_commit = BOOTSTRAP._commit_marker
                sent = False

                def commit_then_signal(transaction):
                    nonlocal sent
                    original_commit(transaction)
                    sent = True
                    os.kill(os.getpid(), signal_number)

                try:
                    with mock.patch.object(
                        BOOTSTRAP,
                        "_commit_marker",
                        side_effect=commit_then_signal,
                    ):
                        result = fixture.run(_signal_state=signal_state)
                finally:
                    BOOTSTRAP._restore_signal_handlers(previous)

                self.assertTrue(sent)
                self.assertEqual(result["status"], "committed")
                self.assertTrue(signal_state["commitCompleted"])
                self.assertTrue(
                    (
                        fixture.formal
                        / BOOTSTRAP.STATE_DIRECTORY
                        / BOOTSTRAP.COMMITTED_BASENAME
                    ).is_file()
                )

    def test_post_activation_failure_stays_masked_through_isolation(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            original_mask = BOOTSTRAP.signal.pthread_sigmask
            original_rename = BOOTSTRAP._rename_noreplace_at
            original_isolate = BOOTSTRAP._isolate_transaction
            mask_before = original_mask(signal.SIG_BLOCK, ())
            events = []
            self_test_calls = 0

            def record_mask(operation, signals):
                events.append(("mask", operation, frozenset(signals)))
                return original_mask(operation, signals)

            def record_rename(*arguments, **keywords):
                result = original_rename(*arguments, **keywords)
                if arguments[3] == BOOTSTRAP.FORMAL_NAMESPACE:
                    events.append(("activated",))
                return result

            def fail_formal_self_test(system_python, verifier_path):
                nonlocal self_test_calls
                fixture.assert_self_test_path(system_python, verifier_path)
                self_test_calls += 1
                if self_test_calls == 2:
                    BOOTSTRAP._fail(
                        "VERIFIER_BOOTSTRAP_SELF_TEST",
                        "self-test/result",
                    )
                return {
                    "schemaVersion": "1.0.0",
                    "wireMagic": "AXIALMUSE-FILE-TREE-V1",
                    "vectorCount": 6,
                }

            def record_isolate(*arguments, **keywords):
                current = original_mask(signal.SIG_BLOCK, ())
                self.assertTrue(BOOTSTRAP.INTERRUPT_SIGNALS.issubset(current))
                result = original_isolate(*arguments, **keywords)
                events.append(("isolated",))
                return result

            with (
                mock.patch.object(
                    BOOTSTRAP.signal,
                    "pthread_sigmask",
                    side_effect=record_mask,
                ),
                mock.patch.object(
                    BOOTSTRAP,
                    "_rename_noreplace_at",
                    side_effect=record_rename,
                ),
                mock.patch.object(
                    BOOTSTRAP,
                    "_isolate_transaction",
                    side_effect=record_isolate,
                ),
            ):
                self.assert_error(
                    "VERIFIER_BOOTSTRAP_SELF_TEST",
                    lambda: fixture.run(
                        _self_test_runner=fail_formal_self_test
                    ),
                )

            activated_index = events.index(("activated",))
            isolated_index = events.index(("isolated",))
            self.assertFalse(
                any(
                    event[0] == "mask" and event[1] == signal.SIG_SETMASK
                    for event in events[activated_index:isolated_index]
                )
            )
            self.assertFalse(fixture.formal.exists())
            self.assertEqual(
                original_mask(signal.SIG_BLOCK, ()),
                mask_before,
            )

    def test_keyboard_interrupt_observes_commit_boundary(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)

            def interrupt_self_test(_python, _path):
                raise KeyboardInterrupt()

            self.assert_error(
                "VERIFIER_BOOTSTRAP_INTERRUPTED",
                lambda: fixture.run(_self_test_runner=interrupt_self_test),
            )
            self.assertFalse(fixture.formal.exists())
            self.assertTrue(
                any(
                    name.startswith(BOOTSTRAP.ISOLATION_PREFIX)
                    for name in fixture.reserved_names()
                )
            )

        with tempfile.TemporaryDirectory(
            prefix="axial-muse-bootstrap-test-"
        ) as temporary_root:
            fixture = BootstrapFixture(temporary_root)
            original_commit = BOOTSTRAP._commit_marker

            def commit_then_interrupt(transaction):
                original_commit(transaction)
                raise KeyboardInterrupt()

            with mock.patch.object(
                BOOTSTRAP,
                "_commit_marker",
                side_effect=commit_then_interrupt,
            ):
                result = fixture.run()
            self.assertEqual(result["status"], "committed")
            self.assertTrue(
                (
                    fixture.formal
                    / BOOTSTRAP.STATE_DIRECTORY
                    / BOOTSTRAP.COMMITTED_BASENAME
                ).is_file()
            )

    def test_signal_handler_install_rolls_back_partial_failure(self):
        before = {
            signal_number: signal.getsignal(signal_number)
            for signal_number in BOOTSTRAP.INTERRUPT_SIGNALS
        }
        original_signal = signal.signal
        calls = 0

        def fail_second_install(signal_number, handler):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("controlled handler install failure")
            return original_signal(signal_number, handler)

        with mock.patch.object(
            BOOTSTRAP.signal,
            "signal",
            side_effect=fail_second_install,
        ):
            with self.assertRaises(OSError):
                BOOTSTRAP._install_signal_handlers()

        self.assertGreaterEqual(calls, 3)
        for signal_number, handler in before.items():
            self.assertIs(signal.getsignal(signal_number), handler)

    def test_main_installs_and_restores_signal_handlers(self):
        arguments = [
            "--source-root",
            "/private/source",
            "--expected-commit-sha",
            COMMIT_SHA,
            "--expected-verifier-sha256",
            "1" * 64,
            "--expected-golden-sha256",
            "2" * 64,
        ]
        for signal_number in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal_number=signal_number):
                def sentinel_handler(_signal_number, _frame):
                    return None

                original_handler = signal.signal(
                    signal_number,
                    sentinel_handler,
                )
                standard_output = io.StringIO()
                standard_error = io.StringIO()

                def interrupt_entry(**_keywords):
                    os.kill(os.getpid(), signal_number)
                    raise AssertionError("installed handler must interrupt entry")

                try:
                    with (
                        mock.patch.object(
                            BOOTSTRAP,
                            "bootstrap_artifact_verifier",
                            side_effect=interrupt_entry,
                        ),
                        contextlib.redirect_stdout(standard_output),
                        contextlib.redirect_stderr(standard_error),
                    ):
                        exit_code = BOOTSTRAP.main(arguments)
                    self.assertEqual(exit_code, 1)
                    self.assertEqual(standard_output.getvalue(), "")
                    self.assertRegex(
                        standard_error.getvalue(),
                        r"^\[VERIFIER_BOOTSTRAP_INTERRUPTED\] "
                        r"\(process/signal\) .+\n$",
                    )
                    self.assertIs(
                        signal.getsignal(signal_number),
                        sentinel_handler,
                    )
                finally:
                    signal.signal(signal_number, original_handler)

    def test_default_self_test_runner_classifies_keyboard_interrupt(self):
        with mock.patch.object(
            BOOTSTRAP.subprocess,
            "Popen",
            side_effect=KeyboardInterrupt(),
        ):
            error = self.assert_error(
                "VERIFIER_BOOTSTRAP_INTERRUPTED",
                lambda: BOOTSTRAP._default_self_test_runner(
                    "/usr/bin/python3",
                    "/private/verify_artifact.py",
                ),
            )
        self.assertEqual(error.source_path, "process/keyboard-interrupt")

    def test_fixed_cli_and_failure_diagnostic_are_closed(self):
        valid = [
            "--source-root",
            "/private/source",
            "--expected-commit-sha",
            COMMIT_SHA,
            "--expected-verifier-sha256",
            "1" * 64,
            "--expected-golden-sha256",
            "2" * 64,
        ]
        self.assertEqual(
            BOOTSTRAP._parse_cli_arguments(valid)["--source-root"],
            "/private/source",
        )
        for invalid in (
            valid[:-2],
            [*valid, "--force", "yes"],
            [
                "--expected-commit-sha",
                COMMIT_SHA,
                *valid[:2],
                *valid[4:],
            ],
        ):
            with self.subTest(invalid=invalid):
                self.assert_error(
                    "VERIFIER_BOOTSTRAP_ARGUMENT",
                    lambda invalid=invalid: BOOTSTRAP._parse_cli_arguments(
                        invalid
                    ),
                )

        standard_output = io.StringIO()
        standard_error = io.StringIO()
        failure = BOOTSTRAP.VerifierBootstrapError(
            "VERIFIER_BOOTSTRAP_SOURCE",
            "/private/source",
            cause=RuntimeError("/private/detail"),
        )
        with (
            mock.patch.object(
                BOOTSTRAP,
                "bootstrap_artifact_verifier",
                side_effect=failure,
            ),
            contextlib.redirect_stdout(standard_output),
            contextlib.redirect_stderr(standard_error),
        ):
            exit_code = BOOTSTRAP.main(valid)
        self.assertEqual(exit_code, 1)
        self.assertEqual(standard_output.getvalue(), "")
        self.assertRegex(
            standard_error.getvalue(),
            r"^\[VERIFIER_BOOTSTRAP_SOURCE\] \(bootstrap/unknown\) .+\n$",
        )
        self.assertNotIn("/private/", standard_error.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)

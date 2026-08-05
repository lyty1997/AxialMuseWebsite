import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import warnings
import zipfile
from pathlib import Path
from unittest import mock


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
VERIFIER_PATH = REPOSITORY_ROOT / "ops" / "deploy" / "verify_artifact.py"
FILE_TREE_MODULE_URL = (
    REPOSITORY_ROOT / "scripts" / "quality" / "lib" / "file-tree.mjs"
).as_uri()
SYSTEM_PYTHON = "/usr/bin/python3"
COMMIT_SHA = "a" * 40
REDIRECT_REGISTRY_SHA256 = "b" * 64

SPEC = importlib.util.spec_from_file_location(
    "axial_muse_server_artifact_verifier",
    VERIFIER_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("无法加载服务器 artifact verifier。")
VERIFIER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = VERIFIER
SPEC.loader.exec_module(VERIFIER)


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def digest_records(files, *, strip_prefix=None):
    records = []
    for path, content in files.items():
        normalized_path = path
        if strip_prefix is not None:
            prefix = f"{strip_prefix}/"
            if not path.startswith(prefix):
                continue
            normalized_path = path[len(prefix):]
        records.append((normalized_path.encode("utf-8"), content))
    records.sort(key=lambda item: item[0])
    digest = hashlib.sha256()
    digest.update(b"AXIALMUSE-FILE-TREE-V1\x00")
    for path_bytes, content in records:
        digest.update(struct.pack(">Q", len(path_bytes)))
        digest.update(path_bytes)
        digest.update(struct.pack(">Q", len(content)))
        digest.update(hashlib.sha256(content).digest())
    return digest.hexdigest()


def digest_public_routes(routes):
    digest = hashlib.sha256()
    digest.update(b"AXIALMUSE-PUBLIC-ROUTES-V1\x00")
    for route in routes:
        encoded = route.encode("utf-8")
        digest.update(struct.pack(">Q", len(encoded)))
        digest.update(encoded)
    return digest.hexdigest()


def canonical_json(value):
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            indent=2,
            separators=(",", ": "),
        )
        + "\n"
    ).encode("utf-8")


def render_nginx(rules):
    return "".join(
        f"location = {rule['from']} {{\n"
        f"  return 301 https://www.axialmuse.com{rule['to']}$is_args$args;\n"
        "}\n"
        for rule in rules
    ).encode("ascii")


def default_rules():
    return [
        {"kind": "registered", "from": "/old", "to": "/projects/"},
        {"kind": "registered", "from": "/old/", "to": "/projects/"},
        {
            "kind": "canonical-slash",
            "from": "/projects",
            "to": "/projects/",
        },
    ]


def build_release(
    *,
    payload_index=b"<!doctype html>\n",
    rules=None,
    nginx_override=None,
    commit_sha=COMMIT_SHA,
    metadata_transform=None,
    manifest_transform=None,
    release_json_override=None,
):
    rules = default_rules() if rules is None else rules
    payload = {
        "payload/assets/app.js": b'console.log("fixture");\n',
        "payload/index.html": payload_index,
        "payload/projects/index.html": b"<!doctype html><title>projects</title>\n",
        "payload/sitemap.xml": b'<?xml version="1.0"?><urlset></urlset>\n',
    }
    runtime = canonical_json(
        {
            "schemaVersion": "1.0.0",
            "canonicalOrigin": "https://www.axialmuse.com",
            "rules": rules,
        }
    )
    nginx = render_nginx(rules) if nginx_override is None else nginx_override
    manifest_files = {
        **payload,
        "metadata/runtime-redirects.json": runtime,
        "metadata/nginx/redirects.conf": nginx,
    }
    manifest_entries = [
        (path, sha256(content))
        for path, content in sorted(
            manifest_files.items(),
            key=lambda item: item[0].encode("utf-8"),
        )
    ]
    if manifest_transform is not None:
        manifest_entries = manifest_transform(manifest_entries)
    manifest = "".join(
        f"{digest}  {path}\n"
        for path, digest in manifest_entries
    ).encode("utf-8")
    metadata = {
        "schemaVersion": "1.0.0",
        "repository": "lyty1997/AxialMuseWebsite",
        "commitSha": commit_sha,
        "payloadRoot": "payload",
        "sourceBuildTreeSha256": digest_records(payload, strip_prefix="payload"),
        "redirectRegistrySha256": REDIRECT_REGISTRY_SHA256,
        "publicRoutesSha256": digest_public_routes(("/", "/projects/")),
        "runtimeRedirectsSha256": sha256(runtime),
        "nginxRedirectsSha256": sha256(nginx),
        "registeredRuleCount": sum(
            1 for rule in rules if rule["kind"] == "registered"
        ),
        "canonicalSlashRuleCount": sum(
            1 for rule in rules if rule["kind"] == "canonical-slash"
        ),
        "ruleCount": len(rules),
        "filesSha256": sha256(manifest),
        "fileCount": len(manifest_entries),
    }
    if metadata_transform is not None:
        metadata = metadata_transform(metadata)
    release_json = (
        canonical_json(metadata)
        if release_json_override is None
        else release_json_override
    )
    return {
        **manifest_files,
        "metadata/files.sha256": manifest,
        "metadata/release.json": release_json,
    }


def write_archive(
    staging_root,
    release_files,
    *,
    extra_entries=(),
    compression=zipfile.ZIP_DEFLATED,
):
    archive_path = staging_root / "artifact.zip"
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(archive_path, "w", compression=compression) as archive:
            for path, content in release_files.items():
                archive.writestr(path, content)
            for value in extra_entries:
                if len(value) == 2:
                    path, content = value
                    archive.writestr(path, content)
                else:
                    info, content = value
                    archive.writestr(info, content)
    os.chmod(archive_path, 0o600)
    return {
        "artifactDigest": sha256(archive_path.read_bytes()),
        "releaseContentSha256": digest_records(release_files),
    }


class StagingFixture:
    def __init__(self, temporary_root, release_files=None, **archive_options):
        self.root = Path(temporary_root) / "staging"
        self.root.mkdir(mode=0o700)
        self.release_files = (
            build_release() if release_files is None else release_files
        )
        self.identity = write_archive(
            self.root,
            self.release_files,
            **archive_options,
        )

    @property
    def verified_root(self):
        return self.root / "verified-release"

    def verify(self, **overrides):
        options = {
            "staging_root": str(self.root),
            "expected_artifact_digest": self.identity["artifactDigest"],
            "expected_release_content_sha256": self.identity[
                "releaseContentSha256"
            ],
            "expected_commit_sha": COMMIT_SHA,
        }
        options.update(overrides)
        return VERIFIER.verify_artifact(**options)

    def cli_arguments(self, **overrides):
        values = {
            "artifact": self.identity["artifactDigest"],
            "release": self.identity["releaseContentSha256"],
            "commit": COMMIT_SHA,
        }
        values.update(overrides)
        return [
            SYSTEM_PYTHON,
            "-I",
            "-B",
            str(VERIFIER_PATH),
            "--staging-root",
            str(self.root),
            "--expected-artifact-digest",
            values["artifact"],
            "--expected-release-content-sha256",
            values["release"],
            "--expected-commit-sha",
            values["commit"],
        ]


class ArtifactVerifierTests(unittest.TestCase):
    maxDiff = None

    def assert_error(self, code, callback):
        with self.assertRaises(VERIFIER.ServerArtifactError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def assert_single_candidate_residue(self, staging_root):
        candidates = sorted(
            path
            for path in staging_root.iterdir()
            if path.name.startswith(".verify-candidate-")
        )
        self.assertEqual(len(candidates), 1)
        self.assertTrue(candidates[0].is_dir())
        return candidates[0]

    def test_system_python_self_test_consumes_shared_golden(self):
        result = subprocess.run(
            [
                SYSTEM_PYTHON,
                "-I",
                "-B",
                str(VERIFIER_PATH),
                "--self-test",
            ],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(
            json.loads(result.stdout),
            {
                "schemaVersion": "1.0.0",
                "wireMagic": "AXIALMUSE-FILE-TREE-V1",
                "vectorCount": 6,
            },
        )
        self.assertEqual(result.stdout.count("\n"), 1)

    def test_descriptor_file_tree_capture_preserves_utf8_contract(self):
        golden = json.loads(
            VERIFIER_PATH.with_name("file-tree-v1-golden.json").read_text(
                encoding="utf-8"
            )
        )
        vector = next(
            item
            for item in golden["vectors"]
            if item["name"] == "raw-utf8-byte-order"
        )
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            root = Path(temporary_root) / "tree"
            root.mkdir(mode=0o700)
            for file in vector["files"]:
                path = root / file["path"]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(base64.b64decode(file["contentBase64"]))
            descriptor = os.open(
                root,
                os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
            )
            try:
                capture = VERIFIER._capture_file_tree(descriptor, "release")
            finally:
                os.close(descriptor)
            self.assertEqual(capture.tree_sha256, vector["treeSha256"])

        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            root = Path(temporary_root) / "tree"
            root.mkdir(mode=0o700)
            descriptor = os.open(
                root,
                os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
            )
            invalid_descriptor = os.open(
                b"invalid-\xff.txt",
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC,
                0o600,
                dir_fd=descriptor,
            )
            os.close(invalid_descriptor)
            try:
                self.assert_error(
                    "SERVER_ARTIFACT_FILE_TREE",
                    lambda: VERIFIER._capture_file_tree(
                        descriptor,
                        "release",
                    ),
                )
            finally:
                os.close(descriptor)

    def test_valid_archive_matches_node_tree_and_produces_verified_staging(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            result = fixture.verify()
            self.assertTrue(fixture.verified_root.is_dir())
            self.assertFalse(
                any(
                    entry.name.startswith(".verify-candidate-")
                    for entry in fixture.root.iterdir()
                )
            )
            self.assertEqual(result["artifactDigest"], fixture.identity["artifactDigest"])
            self.assertEqual(
                result["releaseContentSha256"],
                fixture.identity["releaseContentSha256"],
            )
            self.assertEqual(result["commitSha"], COMMIT_SHA)
            self.assertEqual(result["releaseFileCount"], len(fixture.release_files))
            self.assertEqual(result["payloadFileCount"], 4)
            self.assertEqual(result["publicRouteCount"], 2)
            self.assertEqual(result["registeredRuleCount"], 2)
            self.assertEqual(result["canonicalSlashRuleCount"], 1)
            self.assertEqual(result["ruleCount"], 3)

            node_program = (
                f"import {{captureFileTree}} from {json.dumps(FILE_TREE_MODULE_URL)};"
                "const capture=captureFileTree({root:process.argv[1],"
                "sourcePath:'verified-release'});"
                "process.stdout.write(JSON.stringify({"
                "treeSha256:capture.treeSha256,"
                "records:capture.records.map(({path,byteLength,sha256})=>"
                "({path,byteLength,sha256}))}));"
            )
            node_result = subprocess.run(
                [
                    "node",
                    "--input-type=module",
                    "--eval",
                    node_program,
                    str(fixture.verified_root),
                ],
                cwd=REPOSITORY_ROOT,
                check=False,
                capture_output=True,
                text=True,
                timeout=20,
            )
            self.assertEqual(node_result.returncode, 0, node_result.stderr)
            node_capture = json.loads(node_result.stdout)
            self.assertEqual(
                node_capture["treeSha256"],
                result["releaseContentSha256"],
            )
            self.assertEqual(
                [record["path"] for record in node_capture["records"]],
                sorted(fixture.release_files, key=lambda value: value.encode("utf-8")),
            )

    def test_cli_success_is_one_structured_line(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            result = subprocess.run(
                fixture.cli_arguments(),
                cwd=REPOSITORY_ROOT,
                check=False,
                capture_output=True,
                text=True,
                timeout=20,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
            self.assertEqual(result.stdout.count("\n"), 1)
            output = json.loads(result.stdout)
            self.assertEqual(tuple(output.keys()), (
                "schemaVersion",
                "commitSha",
                "artifactDigest",
                "releaseContentSha256",
                "sourceBuildTreeSha256",
                "redirectRegistrySha256",
                "publicRoutesSha256",
                "runtimeRedirectsSha256",
                "nginxRedirectsSha256",
                "filesSha256",
                "releaseFileCount",
                "payloadFileCount",
                "publicRouteCount",
                "registeredRuleCount",
                "canonicalSlashRuleCount",
                "ruleCount",
            ))
            self.assertTrue(fixture.verified_root.is_dir())

    def test_wrong_outer_digest_stops_before_invalid_zip_and_leaves_no_output(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            staging = Path(temporary_root) / "staging"
            staging.mkdir(mode=0o700)
            (staging / "artifact.zip").write_bytes(b"not a zip")
            os.chmod(staging / "artifact.zip", 0o600)
            self.assert_error(
                "SERVER_ARTIFACT_DIGEST",
                lambda: VERIFIER.verify_artifact(
                    staging_root=str(staging),
                    expected_artifact_digest="0" * 64,
                    expected_release_content_sha256="1" * 64,
                    expected_commit_sha=COMMIT_SHA,
                ),
            )
            self.assertFalse((staging / "verified-release").exists())
            self.assertEqual(
                sorted(path.name for path in staging.iterdir()),
                ["artifact.zip"],
            )

    def test_internally_consistent_other_release_cannot_replace_external_digest(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as first_root, tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as second_root:
            first = StagingFixture(first_root)
            second = StagingFixture(
                second_root,
                release_files=build_release(
                    payload_index=b"<!doctype html><title>other</title>\n"
                ),
            )
            self.assertNotEqual(
                first.identity["releaseContentSha256"],
                second.identity["releaseContentSha256"],
            )
            self.assert_error(
                "SERVER_ARTIFACT_RELEASE_DIGEST",
                lambda: second.verify(
                    expected_release_content_sha256=first.identity[
                        "releaseContentSha256"
                    ],
                ),
            )
            self.assertFalse(second.verified_root.exists())
            self.assert_single_candidate_residue(second.root)

    def test_zip_slip_absolute_backslash_and_empty_directory_are_rejected(self):
        cases = (
            ("../escape", b"escape", "SERVER_ARTIFACT_ARCHIVE_PATH"),
            ("/absolute", b"absolute", "SERVER_ARTIFACT_ARCHIVE_PATH"),
            (
                "payload\\windows.txt",
                b"windows",
                "SERVER_ARTIFACT_ARCHIVE_PATH",
            ),
            ("payload/empty/", b"", "SERVER_ARTIFACT_LAYOUT"),
        )
        for path, content, expected_code in cases:
            with self.subTest(path=path), tempfile.TemporaryDirectory(
                prefix="axial-muse-server-artifact-test-"
            ) as temporary_root:
                fixture = StagingFixture(
                    temporary_root,
                    extra_entries=((path, content),),
                )
                self.assert_error(
                    expected_code,
                    fixture.verify,
                )
                self.assertFalse(fixture.verified_root.exists())

    def test_symlink_duplicate_and_case_collision_are_rejected(self):
        symlink = zipfile.ZipInfo("payload/link")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        cases = (
            ((symlink, b"index.html"),),
            (("payload/index.html", b"duplicate"),),
            (("payload/INDEX.HTML", b"case"),),
            (("payload/Assets/other.js", b"ancestor case"),),
        )
        expected_codes = (
            "SERVER_ARTIFACT_ARCHIVE_ENTRY",
            "SERVER_ARTIFACT_ARCHIVE_PATH",
            "SERVER_ARTIFACT_ARCHIVE_PATH",
            "SERVER_ARTIFACT_ARCHIVE_PATH",
        )
        for entries, expected_code in zip(cases, expected_codes, strict=True):
            with self.subTest(expected_code=expected_code), tempfile.TemporaryDirectory(
                prefix="axial-muse-server-artifact-test-"
            ) as temporary_root:
                fixture = StagingFixture(
                    temporary_root,
                    extra_entries=entries,
                )
                self.assert_error(expected_code, fixture.verify)
                self.assertFalse(fixture.verified_root.exists())

    def test_corrupt_crc_preserves_private_candidate_and_blocks_retry(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            archive_path = fixture.root / "artifact.zip"
            archive_bytes = bytearray(archive_path.read_bytes())
            central_offset = archive_bytes.find(b"PK\x01\x02")
            self.assertNotEqual(central_offset, -1)
            archive_bytes[central_offset + 16] ^= 0x01
            archive_path.write_bytes(archive_bytes)
            os.chmod(archive_path, 0o600)
            fixture.identity["artifactDigest"] = sha256(archive_bytes)

            self.assert_error("SERVER_ARTIFACT_EXTRACT", fixture.verify)
            self.assert_single_candidate_residue(fixture.root)
            self.assert_error("SERVER_ARTIFACT_STAGING", fixture.verify)

    def test_central_directory_limit_precedes_zipfile_construction(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            with (
                mock.patch.object(
                    VERIFIER,
                    "MAX_CENTRAL_DIRECTORY_BYTES",
                    1,
                ),
                mock.patch.object(
                    VERIFIER.zipfile,
                    "ZipFile",
                    side_effect=AssertionError(
                        "ZipFile must not parse an oversized central directory"
                    ),
                ),
            ):
                self.assert_error(
                    "SERVER_ARTIFACT_ARCHIVE_LIMIT",
                    fixture.verify,
                )
            self.assertEqual(
                sorted(path.name for path in fixture.root.iterdir()),
                ["artifact.zip"],
            )

    def test_wrong_commit_and_duplicate_metadata_key_are_rejected(self):
        duplicate_release = build_release()
        original = duplicate_release["metadata/release.json"]
        duplicate_release["metadata/release.json"] = original.replace(
            b'{\n  "schemaVersion": "1.0.0",',
            b'{\n  "schemaVersion": "1.0.0",\n  "schemaVersion": "1.0.0",',
            1,
        )
        cases = (
            (
                build_release(commit_sha="c" * 40),
                "SERVER_ARTIFACT_METADATA",
            ),
            (
                duplicate_release,
                "SERVER_ARTIFACT_METADATA",
            ),
        )
        for release_files, expected_code in cases:
            with self.subTest(expected_code=expected_code), tempfile.TemporaryDirectory(
                prefix="axial-muse-server-artifact-test-"
            ) as temporary_root:
                fixture = StagingFixture(
                    temporary_root,
                    release_files=release_files,
                )
                self.assert_error(expected_code, fixture.verify)
                self.assertFalse(fixture.verified_root.exists())

    def test_manifest_missing_member_and_extra_release_member_are_rejected(self):
        missing_manifest_entry = build_release(
            manifest_transform=lambda entries: entries[:-1],
        )
        extra_release_member = build_release()
        extra_release_member["metadata/extra.txt"] = b"extra\n"
        cases = (
            (
                missing_manifest_entry,
                "SERVER_ARTIFACT_MANIFEST",
            ),
            (
                extra_release_member,
                "SERVER_ARTIFACT_LAYOUT",
            ),
        )
        for release_files, expected_code in cases:
            with self.subTest(expected_code=expected_code), tempfile.TemporaryDirectory(
                prefix="axial-muse-server-artifact-test-"
            ) as temporary_root:
                fixture = StagingFixture(
                    temporary_root,
                    release_files=release_files,
                )
                self.assert_error(expected_code, fixture.verify)
                self.assertFalse(fixture.verified_root.exists())

    def test_runtime_pair_canonical_closure_and_nginx_bytes_are_rejected(self):
        cases = (
            (
                build_release(rules=default_rules()[1:]),
                "SERVER_ARTIFACT_REDIRECTS",
            ),
            (
                build_release(rules=default_rules()[:-1]),
                "SERVER_ARTIFACT_REDIRECTS",
            ),
            (
                build_release(
                    nginx_override=(
                        render_nginx(default_rules())
                        .replace(b"return 301", b"return 302", 1)
                    )
                ),
                "SERVER_ARTIFACT_NGINX",
            ),
        )
        for release_files, expected_code in cases:
            with self.subTest(expected_code=expected_code), tempfile.TemporaryDirectory(
                prefix="axial-muse-server-artifact-test-"
            ) as temporary_root:
                fixture = StagingFixture(
                    temporary_root,
                    release_files=release_files,
                )
                self.assert_error(expected_code, fixture.verify)
                self.assertFalse(fixture.verified_root.exists())

    def test_staging_permissions_hardlinked_archive_and_existing_output_fail_closed(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            os.chmod(fixture.root, 0o755)
            self.assert_error("SERVER_ARTIFACT_STAGING", fixture.verify)
            self.assertFalse(fixture.verified_root.exists())

        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            outside_link = Path(temporary_root) / "artifact-hardlink"
            os.link(fixture.root / "artifact.zip", outside_link)
            self.assert_error("SERVER_ARTIFACT_ARCHIVE", fixture.verify)
            self.assertFalse(fixture.verified_root.exists())

        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            fixture.verified_root.mkdir(mode=0o700)
            marker = fixture.verified_root / "owner-marker"
            marker.write_text("external\n", encoding="utf-8")
            self.assert_error("SERVER_ARTIFACT_STAGING", fixture.verify)
            self.assertEqual(marker.read_text(encoding="utf-8"), "external\n")

    def test_success_output_failure_preserves_private_transaction_residue(self):
        class FailingOutput:
            def write(self, _value):
                raise OSError("controlled output failure")

            def flush(self):
                raise AssertionError("flush must not follow failed write")

        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            self.assert_error(
                "SERVER_ARTIFACT_ACTIVATE",
                lambda: fixture.verify(success_stream=FailingOutput()),
            )
            self.assertEqual(
                sorted(path.name for path in fixture.root.iterdir()),
                ["artifact.zip", "verified-release"],
            )
            self.assert_error("SERVER_ARTIFACT_STAGING", fixture.verify)

    def test_activation_is_noreplace_and_rechecks_bytes_after_rename(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            original_rename = VERIFIER._rename_noreplace_at
            target_identity = {}

            def race_target(directory_descriptor, source_name, target_name):
                self.assertEqual(
                    os.fstat(directory_descriptor).st_ino,
                    fixture.root.stat().st_ino,
                )
                fixture.verified_root.mkdir(mode=0o700)
                target_identity["before"] = fixture.verified_root.stat().st_ino
                return original_rename(
                    directory_descriptor,
                    source_name,
                    target_name,
                )

            with mock.patch.object(
                VERIFIER,
                "_rename_noreplace_at",
                side_effect=race_target,
            ):
                self.assert_error("SERVER_ARTIFACT_ACTIVATE", fixture.verify)
            self.assertTrue(fixture.verified_root.is_dir())
            self.assertEqual(
                os.lstat(fixture.verified_root).st_ino,
                target_identity["before"],
            )
            self.assertEqual(
                sorted(
                    path.name
                    for path in fixture.root.iterdir()
                    if not path.name.startswith(".verify-candidate-")
                ),
                ["artifact.zip", "verified-release"],
            )
            self.assert_single_candidate_residue(fixture.root)

        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            original_rename = VERIFIER._rename_noreplace_at

            def mutate_before_rename(
                directory_descriptor,
                source_name,
                target_name,
            ):
                (fixture.root / source_name / "payload" / "index.html").write_bytes(
                    b"changed after final candidate capture\n"
                )
                return original_rename(
                    directory_descriptor,
                    source_name,
                    target_name,
                )

            with mock.patch.object(
                VERIFIER,
                "_rename_noreplace_at",
                side_effect=mutate_before_rename,
            ):
                self.assert_error("SERVER_ARTIFACT_CHANGED", fixture.verify)
            self.assertEqual(
                sorted(path.name for path in fixture.root.iterdir()),
                ["artifact.zip", "verified-release"],
            )

    def test_staging_parent_swap_after_sync_preserves_held_residue(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            original_fsync = os.fsync
            staging_inode = fixture.root.stat().st_ino
            displaced = Path(temporary_root) / "displaced-staging"
            replacement_marker = b"external replacement\n"
            swapped = False

            def swap_after_staging_sync(descriptor):
                nonlocal swapped
                result = original_fsync(descriptor)
                if (
                    not swapped
                    and stat.S_ISDIR(os.fstat(descriptor).st_mode)
                    and os.fstat(descriptor).st_ino == staging_inode
                    and sorted(os.listdir(descriptor))
                    == ["artifact.zip", "verified-release"]
                ):
                    swapped = True
                    fixture.root.rename(displaced)
                    fixture.root.mkdir(mode=0o700)
                    replacement_artifact = fixture.root / "artifact.zip"
                    replacement_artifact.write_bytes(
                        (displaced / "artifact.zip").read_bytes()
                    )
                    replacement_artifact.chmod(0o600)
                    fixture.verified_root.mkdir(mode=0o700)
                    (fixture.verified_root / "owner-marker").write_bytes(
                        replacement_marker
                    )
                return result

            with mock.patch.object(
                VERIFIER.os,
                "fsync",
                side_effect=swap_after_staging_sync,
            ):
                self.assert_error("SERVER_ARTIFACT_CHANGED", fixture.verify)

            self.assertTrue(swapped)
            self.assertEqual(
                sorted(path.name for path in displaced.iterdir()),
                ["artifact.zip", "verified-release"],
            )
            self.assertEqual(
                (fixture.verified_root / "owner-marker").read_bytes(),
                replacement_marker,
            )

    def test_staging_parent_swap_before_activation_uses_held_parent_only(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            displaced = Path(temporary_root) / "displaced-staging"
            replacement_marker = b"external pre-activation replacement\n"
            original_rename = VERIFIER._rename_noreplace_at

            def swap_before_activation(
                directory_descriptor,
                source_name,
                target_name,
            ):
                self.assertEqual(
                    os.fstat(directory_descriptor).st_ino,
                    fixture.root.stat().st_ino,
                )
                fixture.root.rename(displaced)
                fixture.root.mkdir(mode=0o700)
                replacement_artifact = fixture.root / "artifact.zip"
                replacement_artifact.write_bytes(
                    (displaced / "artifact.zip").read_bytes()
                )
                replacement_artifact.chmod(0o600)
                fixture.verified_root.mkdir(mode=0o700)
                (fixture.verified_root / "owner-marker").write_bytes(
                    replacement_marker
                )
                return original_rename(
                    directory_descriptor,
                    source_name,
                    target_name,
                )

            with mock.patch.object(
                VERIFIER,
                "_rename_noreplace_at",
                side_effect=swap_before_activation,
            ):
                self.assert_error("SERVER_ARTIFACT_CHANGED", fixture.verify)

            self.assertEqual(
                sorted(path.name for path in displaced.iterdir()),
                ["artifact.zip", "verified-release"],
            )
            self.assertEqual(
                (fixture.verified_root / "owner-marker").read_bytes(),
                replacement_marker,
            )

    def test_output_failure_residue_stays_anchored_after_parent_swap(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            displaced = Path(temporary_root) / "displaced-staging"
            replacement_marker = b"external output replacement\n"

            class SwappingOutput:
                def write(self, _value):
                    fixture.root.rename(displaced)
                    fixture.root.mkdir(mode=0o700)
                    replacement_artifact = fixture.root / "artifact.zip"
                    replacement_artifact.write_bytes(
                        (displaced / "artifact.zip").read_bytes()
                    )
                    replacement_artifact.chmod(0o600)
                    fixture.verified_root.mkdir(mode=0o700)
                    (fixture.verified_root / "owner-marker").write_bytes(
                        replacement_marker
                    )
                    raise OSError("controlled output failure")

                def flush(self):
                    raise AssertionError("flush must not follow failed write")

            self.assert_error(
                "SERVER_ARTIFACT_ACTIVATE",
                lambda: fixture.verify(success_stream=SwappingOutput()),
            )
            self.assertEqual(
                sorted(path.name for path in displaced.iterdir()),
                ["artifact.zip", "verified-release"],
            )
            self.assertEqual(
                (fixture.verified_root / "owner-marker").read_bytes(),
                replacement_marker,
            )

    def test_candidate_creation_failure_preserves_held_transaction_after_swap(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            original_list = VERIFIER._list_directory_bytes
            displaced = Path(temporary_root) / "displaced-candidate"
            replacement_marker = b"external candidate replacement\n"
            swapped = False

            def swap_candidate_before_creation_cleanup(descriptor):
                nonlocal swapped
                candidates = [
                    path
                    for path in fixture.root.iterdir()
                    if path.name.startswith(".verify-candidate-")
                ]
                if (
                    not swapped
                    and len(candidates) == 1
                    and os.fstat(descriptor).st_ino
                    == candidates[0].stat().st_ino
                ):
                    owned = candidates[0] / "owned"
                    owned.mkdir(mode=0o700)
                    (owned / "content").write_bytes(b"transaction-owned\n")
                    candidate_name = candidates[0].name
                    candidates[0].rename(displaced)
                    replacement = fixture.root / candidate_name
                    replacement.mkdir(mode=0o700)
                    (replacement / "owner-marker").write_bytes(
                        replacement_marker
                    )
                    swapped = True
                    raise OSError("controlled candidate basename swap")
                return original_list(descriptor)

            with mock.patch.object(
                VERIFIER,
                "_list_directory_bytes",
                side_effect=swap_candidate_before_creation_cleanup,
            ):
                self.assert_error("SERVER_ARTIFACT_CLEANUP", fixture.verify)

            self.assertTrue(swapped)
            self.assertEqual(
                (displaced / "owned" / "content").read_bytes(),
                b"transaction-owned\n",
            )
            replacement = next(
                path
                for path in fixture.root.iterdir()
                if path.name.startswith(".verify-candidate-")
            )
            self.assertEqual(
                (replacement / "owner-marker").read_bytes(),
                replacement_marker,
            )

    def test_residue_audit_never_adopts_replacement_after_identity_check(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            staging = Path(temporary_root) / "staging"
            staging.mkdir(mode=0o700)
            transaction = staging / VERIFIER.VERIFIED_RELEASE_BASENAME
            transaction.mkdir(mode=0o700)
            owned = transaction / "owned"
            owned.mkdir(mode=0o700)
            (owned / "content").write_bytes(b"transaction-owned\n")
            displaced = Path(temporary_root) / "displaced-verified-release"
            replacement_marker = b"external verified replacement\n"
            parent_descriptor = os.open(
                staging,
                os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
            )
            transaction_descriptor = os.open(
                transaction,
                os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
            )
            expected_identity = VERIFIER._directory_ownership_identity(
                os.fstat(transaction_descriptor)
            )
            original_fstat = os.fstat
            swapped = False

            def swap_after_cleanup_identity_check(descriptor):
                nonlocal swapped
                metadata = original_fstat(descriptor)
                if not swapped and descriptor == transaction_descriptor:
                    transaction.rename(displaced)
                    transaction.mkdir(mode=0o700)
                    (transaction / "owner-marker").write_bytes(
                        replacement_marker
                    )
                    swapped = True
                return metadata

            try:
                with mock.patch.object(
                    VERIFIER.os,
                    "fstat",
                    side_effect=swap_after_cleanup_identity_check,
                ):
                    self.assert_error(
                        "SERVER_ARTIFACT_CLEANUP",
                        lambda: VERIFIER._safe_preserve_tree(
                            parent_descriptor,
                            VERIFIER.VERIFIED_RELEASE_BASENAME,
                            transaction_descriptor,
                            expected_identity,
                        ),
                    )
            finally:
                os.close(transaction_descriptor)
                os.close(parent_descriptor)

            self.assertTrue(swapped)
            self.assertEqual(
                (displaced / "owned" / "content").read_bytes(),
                b"transaction-owned\n",
            )
            self.assertEqual(
                (transaction / "owner-marker").read_bytes(),
                replacement_marker,
            )

    def test_residue_audit_never_removes_empty_root_replacement_after_check(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            staging = Path(temporary_root) / "staging"
            staging.mkdir(mode=0o700)
            transaction = staging / VERIFIER.VERIFIED_RELEASE_BASENAME
            transaction.mkdir(mode=0o700)
            displaced = Path(temporary_root) / "displaced-verified-release"
            parent_descriptor = os.open(
                staging,
                os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
            )
            transaction_descriptor = os.open(
                transaction,
                os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
            )
            expected_identity = VERIFIER._directory_ownership_identity(
                os.fstat(transaction_descriptor)
            )
            original_stat = os.stat
            original_rename = os.rename
            swapped = False

            def swap_after_root_binding_check(path, *arguments, **keywords):
                nonlocal swapped
                metadata = original_stat(path, *arguments, **keywords)
                if (
                    not swapped
                    and path == VERIFIER.VERIFIED_RELEASE_BASENAME
                    and keywords.get("dir_fd") == parent_descriptor
                ):
                    original_rename(transaction, displaced)
                    transaction.mkdir(mode=0o700)
                    swapped = True
                return metadata

            try:
                with (
                    mock.patch.object(
                        VERIFIER.os,
                        "stat",
                        side_effect=swap_after_root_binding_check,
                    ),
                    mock.patch.object(
                        VERIFIER.os,
                        "unlink",
                        side_effect=AssertionError(
                            "residue audit must not unlink any pathname"
                        ),
                    ),
                    mock.patch.object(
                        VERIFIER.os,
                        "rmdir",
                        side_effect=AssertionError(
                            "residue audit must not remove any directory"
                        ),
                    ),
                    mock.patch.object(
                        VERIFIER.os,
                        "rename",
                        side_effect=AssertionError(
                            "residue audit must not rename any pathname"
                        ),
                    ),
                    mock.patch.object(
                        VERIFIER,
                        "_rename_noreplace_at",
                        side_effect=AssertionError(
                            "residue audit must not invoke renameat2"
                        ),
                    ),
                ):
                    VERIFIER._safe_preserve_tree(
                        parent_descriptor,
                        VERIFIER.VERIFIED_RELEASE_BASENAME,
                        transaction_descriptor,
                        expected_identity,
                    )
            finally:
                os.close(transaction_descriptor)
                os.close(parent_descriptor)

            self.assertTrue(swapped)
            self.assertTrue(transaction.is_dir())
            self.assertEqual(list(transaction.iterdir()), [])
            self.assertTrue(displaced.is_dir())
            self.assertEqual(list(displaced.iterdir()), [])

    def test_residue_audit_never_unlinks_internal_file_replacement_after_check(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            staging = Path(temporary_root) / "staging"
            staging.mkdir(mode=0o700)
            transaction = staging / VERIFIER.VERIFIED_RELEASE_BASENAME
            transaction.mkdir(mode=0o700)
            transaction_file = transaction / "payload.txt"
            transaction_bytes = b"transaction-owned\n"
            replacement_bytes = b"external replacement\n"
            transaction_file.write_bytes(transaction_bytes)
            displaced_file = Path(temporary_root) / "displaced-payload.txt"
            parent_descriptor = os.open(
                staging,
                os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
            )
            transaction_descriptor = os.open(
                transaction,
                os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
            )
            expected_identity = VERIFIER._directory_ownership_identity(
                os.fstat(transaction_descriptor)
            )
            original_stat = os.stat
            original_rename = os.rename
            file_stat_calls = 0
            swapped = False

            def swap_after_file_binding_check(path, *arguments, **keywords):
                nonlocal file_stat_calls, swapped
                metadata = original_stat(path, *arguments, **keywords)
                if (
                    path == b"payload.txt"
                    and keywords.get("dir_fd") == transaction_descriptor
                ):
                    file_stat_calls += 1
                    if file_stat_calls == 2:
                        original_rename(transaction_file, displaced_file)
                        transaction_file.write_bytes(replacement_bytes)
                        swapped = True
                return metadata

            try:
                with (
                    mock.patch.object(
                        VERIFIER.os,
                        "stat",
                        side_effect=swap_after_file_binding_check,
                    ),
                    mock.patch.object(
                        VERIFIER.os,
                        "unlink",
                        side_effect=AssertionError(
                            "residue audit must not unlink any pathname"
                        ),
                    ),
                    mock.patch.object(
                        VERIFIER.os,
                        "rmdir",
                        side_effect=AssertionError(
                            "residue audit must not remove any directory"
                        ),
                    ),
                    mock.patch.object(
                        VERIFIER.os,
                        "rename",
                        side_effect=AssertionError(
                            "residue audit must not rename any pathname"
                        ),
                    ),
                    mock.patch.object(
                        VERIFIER,
                        "_rename_noreplace_at",
                        side_effect=AssertionError(
                            "residue audit must not invoke renameat2"
                        ),
                    ),
                ):
                    VERIFIER._safe_preserve_tree(
                        parent_descriptor,
                        VERIFIER.VERIFIED_RELEASE_BASENAME,
                        transaction_descriptor,
                        expected_identity,
                    )
            finally:
                os.close(transaction_descriptor)
                os.close(parent_descriptor)

            self.assertTrue(swapped)
            self.assertEqual(transaction_file.read_bytes(), replacement_bytes)
            self.assertEqual(displaced_file.read_bytes(), transaction_bytes)

    def test_signal_during_hash_is_not_reclassified(self):
        class SignalReadStream:
            def __init__(self, wrapped):
                self.wrapped = wrapped
                self.sent = False

            def read(self, *arguments):
                if not self.sent:
                    self.sent = True
                    os.kill(os.getpid(), signal.SIGTERM)
                return self.wrapped.read(*arguments)

            def __getattr__(self, name):
                return getattr(self.wrapped, name)

        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            original_open = VERIFIER._open_stable_artifact

            def open_signalling_stream(staging_descriptor):
                stream, identity = original_open(staging_descriptor)
                return SignalReadStream(stream), identity

            standard_output = io.StringIO()
            standard_error = io.StringIO()
            with (
                mock.patch.object(
                    VERIFIER,
                    "_open_stable_artifact",
                    side_effect=open_signalling_stream,
                ),
                contextlib.redirect_stdout(standard_output),
                contextlib.redirect_stderr(standard_error),
            ):
                exit_code = VERIFIER.main(fixture.cli_arguments()[4:])

            self.assertEqual(exit_code, 1)
            self.assertEqual(standard_output.getvalue(), "")
            self.assertRegex(
                standard_error.getvalue(),
                r"^\[SERVER_ARTIFACT_INTERRUPTED\] \(process/signal\) .+\n$",
            )
            self.assertEqual(
                sorted(path.name for path in fixture.root.iterdir()),
                ["artifact.zip"],
            )

    def test_signal_during_extraction_preserves_private_candidate(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            entered_extract = threading.Event()
            signal_sent = threading.Event()
            original_extract = VERIFIER._extract_archive

            def wait_for_signal(*arguments):
                entered_extract.set()
                signal_sent.wait(timeout=10)
                return original_extract(*arguments)

            def send_signal():
                if entered_extract.wait(timeout=10):
                    os.kill(os.getpid(), signal.SIGTERM)
                    signal_sent.set()

            sender = threading.Thread(target=send_signal, daemon=True)
            standard_output = io.StringIO()
            standard_error = io.StringIO()
            sender.start()
            with (
                mock.patch.object(
                    VERIFIER,
                    "_extract_archive",
                    side_effect=wait_for_signal,
                ),
                contextlib.redirect_stdout(standard_output),
                contextlib.redirect_stderr(standard_error),
            ):
                exit_code = VERIFIER.main(fixture.cli_arguments()[4:])
            sender.join(timeout=10)

            self.assertFalse(sender.is_alive())
            self.assertEqual(exit_code, 1)
            self.assertEqual(standard_output.getvalue(), "")
            self.assertRegex(
                standard_error.getvalue(),
                r"^\[SERVER_ARTIFACT_INTERRUPTED\] \(process/signal\) .+\n$",
            )
            self.assert_single_candidate_residue(fixture.root)

    def test_signal_after_success_write_observes_committed_result(self):
        class SignalAfterWrite(io.StringIO):
            def __init__(self):
                super().__init__()
                self.sent = False

            def write(self, value):
                result = super().write(value)
                if not self.sent:
                    self.sent = True
                    os.kill(os.getpid(), signal.SIGTERM)
                return result

        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            standard_output = SignalAfterWrite()
            standard_error = io.StringIO()
            with (
                contextlib.redirect_stdout(standard_output),
                contextlib.redirect_stderr(standard_error),
            ):
                exit_code = VERIFIER.main(fixture.cli_arguments()[4:])

            self.assertEqual(exit_code, 0)
            self.assertEqual(standard_error.getvalue(), "")
            self.assertEqual(standard_output.getvalue().count("\n"), 1)
            self.assertEqual(
                json.loads(standard_output.getvalue())["commitSha"],
                COMMIT_SHA,
            )
            self.assertTrue(fixture.verified_root.is_dir())

    def test_cli_failure_is_nonzero_silent_on_stdout_and_redacts_paths(self):
        with tempfile.TemporaryDirectory(
            prefix="axial-muse-server-artifact-test-"
        ) as temporary_root:
            fixture = StagingFixture(temporary_root)
            result = subprocess.run(
                fixture.cli_arguments(artifact="0" * 64),
                cwd=REPOSITORY_ROOT,
                check=False,
                capture_output=True,
                text=True,
                timeout=20,
            )
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            self.assertRegex(
                result.stderr,
                r"^\[SERVER_ARTIFACT_DIGEST\] \(artifact\.zip\) .+\n$",
            )
            self.assertNotIn(temporary_root, result.stderr)
            self.assertNotIn("/tmp/", result.stderr)
            self.assertNotIn("/home/", result.stderr)
            self.assertFalse(fixture.verified_root.exists())

    def test_cli_rejects_argument_reordering_and_prefixed_digests(self):
        invalid_argument_sets = (
            ["--expected-commit-sha", COMMIT_SHA],
            [
                "--staging-root",
                "/not-used",
                "--expected-artifact-digest",
                f"sha256:{'0' * 64}",
                "--expected-release-content-sha256",
                "1" * 64,
                "--expected-commit-sha",
                COMMIT_SHA,
            ],
        )
        for arguments in invalid_argument_sets:
            with self.subTest(arguments=arguments):
                result = subprocess.run(
                    [
                        SYSTEM_PYTHON,
                        "-I",
                        "-B",
                        str(VERIFIER_PATH),
                        *arguments,
                    ],
                    cwd=REPOSITORY_ROOT,
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=20,
                )
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
                self.assertRegex(
                    result.stderr,
                    r"^\[SERVER_ARTIFACT_ARGUMENT\] ",
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)

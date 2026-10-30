import os
import pathlib
import tempfile
import types
import unittest
from unittest import mock

from ops.deploy import prepare_artifact


VALUES = {
    "workflow_run_id": "39250991872",
    "artifact_id": "12185473878",
    "commit_sha": "a" * 40,
    "artifact_digest": "b" * 64,
    "release_content_sha256": "c" * 64,
}


class PrepareArtifactTests(unittest.TestCase):
    @staticmethod
    def root_lstat(path):
        result = os.stat(path, follow_symlinks=False)
        return types.SimpleNamespace(st_mode=result.st_mode, st_uid=0)

    def test_success_only_makes_private_verified_staging(self):
        with tempfile.TemporaryDirectory(prefix="axial-prepare-") as temporary:
            parent = pathlib.Path(temporary)
            parent.chmod(0o700)
            observed = []

            def fetcher(**inputs):
                observed.append(inputs)
                inputs["destination"].write(b"archive")

            def verifier(arguments, **options):
                stage = pathlib.Path(arguments[arguments.index("--staging-root") + 1])
                (stage / "verified-release").mkdir(mode=0o700)
                return types.SimpleNamespace(returncode=0)

            with (
                mock.patch.object(prepare_artifact, "STAGING_PARENT", str(parent)),
                mock.patch.object(prepare_artifact.os, "geteuid", return_value=0),
                mock.patch.object(prepare_artifact.os, "lstat", side_effect=self.root_lstat),
            ):
                stage = prepare_artifact.prepare_artifact(
                    **VALUES,
                    token_provider=lambda: "ghs_" + "x" * 32,
                    fetcher=fetcher,
                    verifier_runner=verifier,
                )
            self.assertEqual(len(observed), 1)
            self.assertEqual((pathlib.Path(stage) / "artifact.zip").read_bytes(), b"archive")
            self.assertTrue((pathlib.Path(stage) / "verified-release").is_dir())
            self.assertEqual(list(parent.iterdir()), [pathlib.Path(stage)])

    def test_bad_identity_fails_before_token_or_disk_write(self):
        with tempfile.TemporaryDirectory(prefix="axial-prepare-") as temporary:
            parent = pathlib.Path(temporary)
            parent.chmod(0o700)
            with (
                mock.patch.object(prepare_artifact, "STAGING_PARENT", str(parent)),
                mock.patch.object(prepare_artifact.os, "geteuid", return_value=0),
                mock.patch.object(prepare_artifact.os, "lstat", side_effect=self.root_lstat),
            ):
                with self.assertRaises(prepare_artifact.PrepareArtifactError):
                    prepare_artifact.prepare_artifact(
                        **{**VALUES, "commit_sha": "../bad"},
                        token_provider=lambda: self.fail("token requested"),
                    )
            self.assertEqual(list(parent.iterdir()), [])


if __name__ == "__main__":
    unittest.main()

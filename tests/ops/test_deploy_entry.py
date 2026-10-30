import contextlib
import io
import unittest

from ops.deploy import deploy


VALUES = [
    "--workflow-run-id", "39250991872",
    "--artifact-id", "12185473878",
    "--commit-sha", "a" * 40,
    "--artifact-digest", "b" * 64,
    "--release-content-sha256", "c" * 64,
]


class DeployEntryTests(unittest.TestCase):
    def test_valid_identity_only_prepares_and_returns_pending(self):
        observed = []
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            result = deploy.main(VALUES, prepare=lambda **values: observed.append(values))
        self.assertEqual(result, 2)
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0]["artifact_id"], "12185473878")
        self.assertIn("DEPLOY_ACTIVATION_PENDING", errors.getvalue())

    def test_extra_or_reordered_arguments_never_prepare(self):
        for values in (VALUES + ["--extra", "bad"], VALUES[2:] + VALUES[:2]):
            with self.subTest(values=values[:2]):
                errors = io.StringIO()
                with contextlib.redirect_stderr(errors):
                    result = deploy.main(
                        values, prepare=lambda **inputs: self.fail("prepared")
                    )
                self.assertEqual(result, 1)
                self.assertIn("DEPLOY_ARGUMENTS", errors.getvalue())


if __name__ == "__main__":
    unittest.main()

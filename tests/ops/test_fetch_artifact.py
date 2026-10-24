import hashlib
import io
import json
import unittest
import urllib.error

from ops.deploy import fetch_artifact


RUN_ID = "39250991872"
ARTIFACT_ID = "12185473878"
SHA = "a" * 40
ZIP = b"example-archive"
DIGEST = hashlib.sha256(ZIP).hexdigest()
SIGNED = "https://example.blob.core.windows.net/path?sig=private"


class Response:
    def __init__(self, content, status=200):
        self.stream = io.BytesIO(content)
        self.status = status

    def read(self, amount=-1):
        return self.stream.read(amount)

    def __enter__(self):
        return self

    def __exit__(self, exception_type, exception, traceback):
        pass


class FakeOpener:
    def __init__(self, *, digest=DIGEST, signed=SIGNED,
                 workflows=None, artifacts=None):
        self.digest = digest
        self.signed = signed
        self.requests = []
        self.workflows = list(workflows or [{}])
        self.artifacts = list(artifacts or [{}])
        self.workflow_reads = 0
        self.artifact_reads = 0

    def open(self, request, timeout):
        self.requests.append(request)
        url = request.full_url
        if url.endswith("/zip"):
            raise urllib.error.HTTPError(
                url, 302, "Found", {"Location": self.signed}, None
            )
        if url == SIGNED:
            return Response(ZIP)
        if url.endswith("/actions/artifacts/" + ARTIFACT_ID):
            content = {
                "id": int(ARTIFACT_ID),
                "expired": False,
                "name": f"axial-muse-site-{SHA}-{RUN_ID}-1",
                "digest": "sha256:" + self.digest,
                "size_in_bytes": len(ZIP),
                "workflow_run": {
                    "id": int(RUN_ID), "head_sha": SHA, "head_branch": "main",
                    "repository_id": 123, "head_repository_id": 123,
                },
            }
            content.update(self.artifacts[min(self.artifact_reads, len(self.artifacts) - 1)])
            self.artifact_reads += 1
        else:
            content = {
                "id": int(RUN_ID),
                "run_attempt": 1,
                "head_sha": SHA,
                "head_branch": "main",
                "event": "push",
                "status": "completed",
                "conclusion": "success",
                "repository": {"full_name": "lyty1997/AxialMuseWebsite", "id": 123},
            }
            content.update(self.workflows[min(self.workflow_reads, len(self.workflows) - 1)])
            self.workflow_reads += 1
        return Response(json.dumps(content).encode("ascii"))


class FetchArtifactTests(unittest.TestCase):
    def fetch(self, opener, output, **options):
        return fetch_artifact.fetch_exact_artifact(
            workflow_run_id=RUN_ID, artifact_id=ARTIFACT_ID, commit_sha=SHA,
            artifact_digest=DIGEST, destination=output,
            token="ghs_" + "x" * 32, opener=opener, **options,
        )

    def assert_no_zip_request(self, opener, output):
        self.assertFalse(any(r.full_url.endswith('/zip') or r.full_url == SIGNED
                             for r in opener.requests))
        self.assertEqual(output.getvalue(), b'')

    def test_waits_for_same_run_success_before_requesting_zip(self):
        opener = FakeOpener(workflows=[
            {"status": "in_progress", "conclusion": None}, {},
        ])
        output, sleeps = io.BytesIO(), []

        def wait(seconds):
            self.assert_no_zip_request(opener, output)
            sleeps.append(seconds)

        self.assertEqual(self.fetch(opener, output, sleeper=wait), len(ZIP))
        self.assertEqual(sleeps, [2])
        self.assertEqual(opener.artifact_reads, 2)
        self.assertEqual(opener.workflow_reads, 2)
        self.assertEqual(output.getvalue(), ZIP)
        self.assertNotIn('Authorization', opener.requests[-1].headers)

    def test_pending_run_has_hard_poll_limit_and_no_download(self):
        opener = FakeOpener(workflows=[{"status": "in_progress", "conclusion": None}])
        output, sleeps = io.BytesIO(), []
        with self.assertRaisesRegex(fetch_artifact.ArtifactFetchError,
                                    '^ARTIFACT_WORKFLOW_PENDING$'):
            self.fetch(opener, output, sleeper=sleeps.append, clock=lambda: 0)
        self.assertEqual(len(sleeps), 15)
        self.assertEqual(opener.workflow_reads, 16)
        self.assert_no_zip_request(opener, output)

    def test_pending_run_has_elapsed_time_limit(self):
        opener = FakeOpener(workflows=[{"status": "in_progress", "conclusion": None}])
        output, now = io.BytesIO(), [0]

        def wait(seconds):
            now[0] += seconds + 31

        with self.assertRaisesRegex(fetch_artifact.ArtifactFetchError,
                                    '^ARTIFACT_WORKFLOW_PENDING$'):
            self.fetch(opener, output, sleeper=wait, clock=lambda: now[0])
        self.assertEqual(opener.workflow_reads, 1)
        self.assert_no_zip_request(opener, output)

    def test_failed_cancelled_or_unknown_run_never_waits_or_downloads(self):
        for changes in [
            {"conclusion": "failure"}, {"conclusion": "cancelled"},
            {"conclusion": "timed_out"}, {"status": "queued", "conclusion": None},
            {"status": "in_progress", "conclusion": "success"},
        ]:
            with self.subTest(changes=changes):
                opener, output, sleeps = FakeOpener(workflows=[changes]), io.BytesIO(), []
                with self.assertRaisesRegex(fetch_artifact.ArtifactFetchError,
                                            '^ARTIFACT_IDENTITY$'):
                    self.fetch(opener, output, sleeper=sleeps.append)
                self.assertEqual(sleeps, [])
                self.assert_no_zip_request(opener, output)

    def test_every_poll_revalidates_identity_and_expiry(self):
        for workflow, artifact in [
            ({"run_attempt": 2}, {}), ({"head_sha": "b" * 40}, {}),
            ({"id": 1}, {}), ({"event": "pull_request"}, {}),
            ({"repository": {"id": 123, "full_name": "other/repo"}}, {}),
            ({}, {"expired": True}), ({}, {"digest": "sha256:" + "0" * 64}),
            ({}, {"id": 1}), ({}, {"name": "different"}),
        ]:
            with self.subTest(workflow=workflow, artifact=artifact):
                opener = FakeOpener(workflows=[
                    {"status": "in_progress", "conclusion": None}, workflow,
                ], artifacts=[{}, artifact])
                output, sleeps = io.BytesIO(), []
                with self.assertRaisesRegex(fetch_artifact.ArtifactFetchError,
                                            '^ARTIFACT_IDENTITY$'):
                    self.fetch(opener, output, sleeper=sleeps.append)
                self.assertEqual(sleeps, [2])
                self.assert_no_zip_request(opener, output)

    def test_metadata_http_failure_is_not_retried(self):
        class FailingOpener(FakeOpener):
            def open(self, request, timeout):
                self.requests.append(request)
                raise urllib.error.URLError('private-transport-error')

        opener, output, sleeps = FailingOpener(), io.BytesIO(), []
        with self.assertRaisesRegex(fetch_artifact.ArtifactFetchError,
                                    '^ARTIFACT_METADATA_HTTP$'):
            self.fetch(opener, output, sleeper=sleeps.append)
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(sleeps, [])
        self.assert_no_zip_request(opener, output)

    def test_exact_archive_is_streamed_without_auth_on_signed_url(self):
        opener = FakeOpener()
        output = io.BytesIO()
        self.assertEqual(fetch_artifact.fetch_exact_artifact(
            workflow_run_id=RUN_ID,
            artifact_id=ARTIFACT_ID,
            commit_sha=SHA,
            artifact_digest=DIGEST,
            destination=output,
            token="ghs_" + "x" * 32,
            opener=opener,
        ), len(ZIP))
        self.assertEqual(output.getvalue(), ZIP)
        self.assertEqual(len(opener.requests), 4)
        self.assertNotIn("Authorization", opener.requests[-1].headers)

    def test_wrong_digest_and_unsafe_redirect_fail_closed(self):
        for opener in (
            FakeOpener(digest="0" * 64),
            FakeOpener(signed="https://127.0.0.1/private"),
        ):
            with self.assertRaises(fetch_artifact.ArtifactFetchError):
                fetch_artifact.fetch_exact_artifact(
                    workflow_run_id=RUN_ID,
                    artifact_id=ARTIFACT_ID,
                    commit_sha=SHA,
                    artifact_digest=DIGEST,
                    destination=io.BytesIO(),
                    token="ghs_" + "x" * 32,
                    opener=opener,
                )

    def test_short_destination_write_fails_closed(self):
        class ShortWriter:
            def write(self, chunk):
                return len(chunk) - 1

        with self.assertRaises(fetch_artifact.ArtifactFetchError) as error:
            fetch_artifact.fetch_exact_artifact(
                workflow_run_id=RUN_ID,
                artifact_id=ARTIFACT_ID,
                commit_sha=SHA,
                artifact_digest=DIGEST,
                destination=ShortWriter(),
                token="ghs_" + "x" * 32,
                opener=FakeOpener(),
            )
        self.assertEqual(str(error.exception), "ARTIFACT_ZIP_WRITE")


if __name__ == "__main__":
    unittest.main()

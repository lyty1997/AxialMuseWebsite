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
    def __init__(self, *, digest=DIGEST, signed=SIGNED):
        self.digest = digest
        self.signed = signed
        self.requests = []

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
        return Response(json.dumps(content).encode("ascii"))


class FetchArtifactTests(unittest.TestCase):
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

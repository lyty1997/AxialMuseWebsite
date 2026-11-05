import hashlib
import io
import json
from pathlib import Path
import re
import unittest
import urllib.error

from ops.deploy import fetch_artifact


RUN_ID = "39250991872"
ARTIFACT_ID = "12185473878"
SHA = "a" * 40
ZIP = b"example-archive"
DIGEST = hashlib.sha256(ZIP).hexdigest()
SIGNED = "https://example.blob.core.windows.net/path?sig=private"
JOB_NAMES = (
    "Website quality gates", "Minimum Node compatibility", "Diagram compile check",
    "Supply chain evidence", "Production artifact",
)
LAYERED_JOB_NAMES = (
    "Website quality gates", "Minimum Node compatibility", "Production artifact",
)


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
    def __init__(self, *, digest=DIGEST, signed=SIGNED, job_names=JOB_NAMES):
        self.digest = digest
        self.signed = signed
        self.requests = []
        self.workflow_changes = {}
        self.fresh_changes = {}
        self.artifact_changes = {}
        self.fresh_artifact_changes = {}
        self.artifact_reads = 0
        self.workflow_reads = 0
        self.jobs = [dict(id=index, name=name, run_id=int(RUN_ID), head_sha=SHA,
                          status="completed", conclusion="success")
                     for index, name in enumerate(job_names, 1)]
        self.jobs_changes = {}

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
            self.artifact_reads += 1
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
                **self.artifact_changes,
                **(self.fresh_artifact_changes if self.artifact_reads > 1 else {}),
            }
        elif "/jobs?" in url:
            content = {"total_count": len(self.jobs), "jobs": self.jobs,
                       **self.jobs_changes}
        else:
            self.workflow_reads += 1
            content = {
                "id": int(RUN_ID),
                "run_attempt": 1,
                "name": "CI", "path": ".github/workflows/ci.yml",
                "head_sha": SHA,
                "head_branch": "main",
                "event": "push",
                "status": "completed",
                "conclusion": "success",
                "repository": {"full_name": "lyty1997/AxialMuseWebsite", "id": 123},
                **self.workflow_changes,
                **(self.fresh_changes if self.workflow_reads > 1 else {}),
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
        self.assertEqual(len(opener.requests), 7)
        self.assertNotIn("Authorization", opener.requests[-1].headers)

    def fetch(self, opener):
        return fetch_artifact.fetch_exact_artifact(
            workflow_run_id=RUN_ID, artifact_id=ARTIFACT_ID, commit_sha=SHA,
            artifact_digest=DIGEST, destination=io.BytesIO(),
            token="ghs_" + "x" * 32, opener=opener,
        )

    def test_running_dispatch_does_not_wait_for_workflow_completion(self):
        opener = FakeOpener()
        opener.workflow_changes = {"status": "in_progress", "conclusion": None}
        opener.jobs.append(dict(id=99, name="Deploy production", run_id=int(RUN_ID),
                                head_sha=SHA, status="in_progress", conclusion=None))
        self.assertEqual(self.fetch(opener), len(ZIP))
        self.assertIn("/attempts/1/jobs?per_page=100", opener.requests[2].full_url)

    def test_both_complete_topologies_download_while_deployment_is_running(self):
        for names in (JOB_NAMES, LAYERED_JOB_NAMES):
            with self.subTest(names=names):
                opener = FakeOpener(job_names=names)
                opener.workflow_changes = {"status": "in_progress", "conclusion": None}
                opener.jobs.append(dict(id=99, name="Deploy production", run_id=int(RUN_ID),
                                        head_sha=SHA, status="in_progress", conclusion=None))
                output = io.BytesIO()
                self.assertEqual(fetch_artifact.fetch_exact_artifact(
                    workflow_run_id=RUN_ID, artifact_id=ARTIFACT_ID, commit_sha=SHA,
                    artifact_digest=DIGEST, destination=output,
                    token="ghs_" + "x" * 32, opener=opener,
                ), len(ZIP))
                self.assertEqual(output.getvalue(), ZIP)
                self.assertEqual(len(opener.requests), 7)
                self.assertIn("/attempts/1/jobs?per_page=100", opener.requests[2].full_url)
                self.assertNotIn("Authorization", opener.requests[-1].headers)

    def test_repository_workflow_producer_prerequisites_can_be_downloaded(self):
        # 从实际 workflow 读取名称与 needs，防止 CI 改名/删 job 后下载器再次失配。
        source = (Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml").read_text()
        blocks = dict(re.findall(r"^  ([a-z-]+):\n(.*?)(?=^  [a-z-]+:|\Z)",
                                 source, re.MULTILINE | re.DOTALL))
        producer = blocks["production-artifact"]
        needs = re.search(r"^    needs:\n((?:      - [a-z-]+\n)+)", producer, re.MULTILINE)
        self.assertIsNotNone(needs)
        job_ids = re.findall(r"      - ([a-z-]+)", needs[1]) + ["production-artifact"]
        names = tuple(re.search(r"^    name: (.+)$", blocks[job_id], re.MULTILINE)[1]
                      for job_id in job_ids)
        self.assertIn(set(names), (set(JOB_NAMES), set(LAYERED_JOB_NAMES)))
        opener = FakeOpener(job_names=names)
        opener.workflow_changes = {"status": "in_progress", "conclusion": None}
        self.assertEqual(self.fetch(opener), len(ZIP))

    def test_prerequisites_and_producer_must_each_be_successful_and_unique(self):
        for names in (JOB_NAMES, LAYERED_JOB_NAMES):
            self.assert_jobs_reject_mutations(names)

    def assert_jobs_reject_mutations(self, names):
        for name in names:
            for mutation in ("missing", "duplicate", "failure", "cancelled", "skipped", "pending", "sha", "run"):
                with self.subTest(topology=names, name=name, mutation=mutation):
                    opener = FakeOpener(job_names=names)
                    job = next(job for job in opener.jobs if job["name"] == name)
                    if mutation == "missing":
                        opener.jobs.remove(job)
                    elif mutation == "duplicate":
                        opener.jobs.append({**job, "id": 98})
                    elif mutation == "pending":
                        job.update(status="in_progress", conclusion=None)
                    elif mutation == "sha":
                        job["head_sha"] = "b" * 40
                    elif mutation == "run":
                        job["run_id"] += 1
                    else:
                        job["conclusion"] = mutation
                    code = ("ARTIFACT_JOBS" if mutation in ("duplicate", "sha", "run")
                            else "ARTIFACT_PRODUCER_NOT_READY")
                    with self.assertRaisesRegex(fetch_artifact.ArtifactFetchError, f"^{code}$"):
                        self.fetch(opener)
                    self.assertEqual(len(opener.requests), 3)
                    self.assertFalse(any(request.full_url.endswith("/zip") for request in opener.requests))

    def test_attempt_drift_bad_workflow_and_incomplete_job_listing_reject(self):
        for workflow, fresh, jobs in (
            ({}, {"run_attempt": 2}, {}),
            ({}, {"status": "completed", "conclusion": "failure"}, {}),
            ({"status": "queued", "conclusion": None}, {}, {}),
            ({"status": "in_progress", "conclusion": "success"}, {}, {}),
            ({"path": "other.yml"}, {}, {}),
            ({}, {}, {"total_count": 101}),
            ({}, {}, {"jobs": None}),
        ):
            with self.subTest(workflow=workflow, fresh=fresh, jobs=jobs):
                opener = FakeOpener()
                opener.workflow_changes, opener.fresh_changes, opener.jobs_changes = workflow, fresh, jobs
                with self.assertRaises(fetch_artifact.ArtifactFetchError):
                    self.fetch(opener)
                self.assertFalse(any(request.full_url.endswith("/zip") for request in opener.requests))

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

    def test_identity_expiry_and_transport_errors_never_download(self):
        for workflow, artifact in (
            ({"head_sha": "b" * 40}, {}), ({"id": 1}, {}),
            ({"event": "pull_request"}, {}),
            ({"repository": {"id": 123, "full_name": "other/repo"}}, {}),
            ({}, {"expired": True}), ({}, {"id": 1}), ({}, {"name": "different"}),
            ({"conclusion": "cancelled"}, {}), ({"conclusion": "timed_out"}, {}),
        ):
            with self.subTest(workflow=workflow, artifact=artifact):
                opener = FakeOpener()
                opener.workflow_changes, opener.artifact_changes = workflow, artifact
                with self.assertRaisesRegex(fetch_artifact.ArtifactFetchError, "^ARTIFACT_IDENTITY$"):
                    self.fetch(opener)
                self.assertFalse(any(request.full_url.endswith("/zip") for request in opener.requests))
        class FailingOpener(FakeOpener):
            def open(self, request, timeout):
                self.requests.append(request)
                raise urllib.error.URLError("transport failed")
        opener = FailingOpener()
        with self.assertRaisesRegex(fetch_artifact.ArtifactFetchError, "^ARTIFACT_METADATA_HTTP$"):
            self.fetch(opener)
        self.assertEqual(len(opener.requests), 1)

    def test_artifact_expiry_or_identity_drift_after_jobs_is_rechecked(self):
        for changes in ({"expired": True}, {"id": 1}, {"name": "different"},
                        {"digest": "sha256:" + "0" * 64}):
            with self.subTest(changes=changes):
                opener = FakeOpener()
                opener.fresh_artifact_changes = changes
                with self.assertRaisesRegex(fetch_artifact.ArtifactFetchError, "^ARTIFACT_IDENTITY$"):
                    self.fetch(opener)
                self.assertFalse(any(request.full_url.endswith("/zip") for request in opener.requests))

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

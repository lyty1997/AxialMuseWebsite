"""从固定 GitHub API 取精确制品，令牌不随重定向泄露。"""

import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request


from ops.deploy.github_app_auth import API_VERSION


API_ROOT = "https://api.github.com/repos/lyty1997/AxialMuseWebsite"
MAX_METADATA_BYTES = 64 * 1024
MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024
READ_SIZE = 64 * 1024
WORKFLOW_WAIT_SECONDS = 30
WORKFLOW_POLL_SECONDS = 2
WORKFLOW_MAX_POLLS = 15
DECIMAL = re.compile(r"[1-9][0-9]{0,15}\Z", re.ASCII)
SHA = re.compile(r"[0-9a-f]{40}\Z", re.ASCII)
DIGEST = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)


class ArtifactFetchError(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _request(url, token=None):
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "AxialMuseWebsite-artifact-reader",
        "X-GitHub-Api-Version": API_VERSION,
    }
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(url, headers=headers)


def _read_metadata(url, token, *, opener=_OPENER, timeout=20):
    try:
        with opener.open(_request(url, token), timeout=timeout) as response:
            if response.status != 200:
                raise ArtifactFetchError("ARTIFACT_METADATA_HTTP")
            raw = response.read(MAX_METADATA_BYTES + 1)
        if len(raw) > MAX_METADATA_BYTES:
            raise ArtifactFetchError("ARTIFACT_METADATA_SIZE")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ArtifactFetchError("ARTIFACT_METADATA_SHAPE")
        return value
    except (OSError, urllib.error.URLError, ValueError) as error:
        raise ArtifactFetchError("ARTIFACT_METADATA_HTTP") from error


def _signed_download_url(url, token, *, opener=_OPENER):
    try:
        with opener.open(_request(url, token), timeout=20):
            raise ArtifactFetchError("ARTIFACT_REDIRECT_STATUS")
    except urllib.error.HTTPError as error:
        if error.code != 302:
            raise ArtifactFetchError("ARTIFACT_REDIRECT_STATUS") from error
        location = error.headers.get("Location")
    except (OSError, urllib.error.URLError) as error:
        raise ArtifactFetchError("ARTIFACT_REDIRECT_STATUS") from error
    if not isinstance(location, str) or len(location) > 8192:
        raise ArtifactFetchError("ARTIFACT_REDIRECT_URL")
    try:
        parsed = urllib.parse.urlsplit(location)
        hostname = parsed.hostname or ""
        port = parsed.port
    except ValueError as error:
        raise ArtifactFetchError("ARTIFACT_REDIRECT_URL") from error
    if (
        parsed.scheme != "https"
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
        or parsed.fragment
        or not hostname.endswith(".blob.core.windows.net")
        or hostname == ".blob.core.windows.net"
    ):
        raise ArtifactFetchError("ARTIFACT_REDIRECT_URL")
    return location


def _validate_identity(metadata, workflow, *, workflow_run_id, artifact_id,
                       commit_sha, artifact_digest):
    relationship = metadata.get("workflow_run")
    size = metadata.get("size_in_bytes")
    repository = workflow.get("repository")
    attempt = workflow.get("run_attempt")
    repository_id = repository.get("id") if isinstance(repository, dict) else None
    if (
        metadata.get("id") != int(artifact_id)
        or metadata.get("expired") is not False
        or metadata.get("digest") != f"sha256:{artifact_digest}"
        or not isinstance(size, int)
        or isinstance(size, bool)
        or size < 1
        or size > MAX_ZIP_BYTES
        or not isinstance(relationship, dict)
        or relationship.get("id") != int(workflow_run_id)
        or relationship.get("head_sha") != commit_sha
        or relationship.get("head_branch") != "main"
        or not isinstance(attempt, int)
        or isinstance(attempt, bool)
        or attempt < 1
        or metadata.get("name") != (
            f"axial-muse-site-{commit_sha}-{workflow_run_id}-{attempt}"
        )
        or workflow.get("id") != int(workflow_run_id)
        or workflow.get("head_sha") != commit_sha
        or workflow.get("head_branch") != "main"
        or workflow.get("event") != "push"
        or not isinstance(repository, dict)
        or repository.get("full_name") != "lyty1997/AxialMuseWebsite"
        or not isinstance(repository_id, int)
        or relationship.get("repository_id") != repository_id
        or relationship.get("head_repository_id") != repository_id
    ):
        raise ArtifactFetchError("ARTIFACT_IDENTITY")
    return size


def _metadata_timeout(deadline, clock):
    remaining = deadline - clock()
    if remaining <= 0:
        raise ArtifactFetchError("ARTIFACT_WORKFLOW_PENDING")
    return min(20, remaining)


def fetch_exact_artifact(*, workflow_run_id, artifact_id, commit_sha,
                         artifact_digest, destination, token,
                         opener=_OPENER, sleeper=time.sleep,
                         clock=time.monotonic):
    if (
        not isinstance(workflow_run_id, str)
        or DECIMAL.fullmatch(workflow_run_id) is None
        or not isinstance(artifact_id, str)
        or DECIMAL.fullmatch(artifact_id) is None
        or not isinstance(commit_sha, str)
        or SHA.fullmatch(commit_sha) is None
        or not isinstance(artifact_digest, str)
        or DIGEST.fullmatch(artifact_digest) is None
        or not isinstance(token, str)
        or len(token) < 16
        or not hasattr(destination, "write")
    ):
        raise ArtifactFetchError("ARTIFACT_INPUT")
    artifact_url = f"{API_ROOT}/actions/artifacts/{artifact_id}"
    workflow_url = f"{API_ROOT}/actions/runs/{workflow_run_id}"
    deadline = clock() + WORKFLOW_WAIT_SECONDS
    for poll in range(WORKFLOW_MAX_POLLS + 1):
        metadata = _read_metadata(
            artifact_url, token, opener=opener,
            timeout=_metadata_timeout(deadline, clock),
        )
        workflow = _read_metadata(
            workflow_url, token, opener=opener,
            timeout=_metadata_timeout(deadline, clock),
        )
        size = _validate_identity(
            metadata, workflow, workflow_run_id=workflow_run_id,
            artifact_id=artifact_id, commit_sha=commit_sha,
            artifact_digest=artifact_digest,
        )
        _metadata_timeout(deadline, clock)
        if (
            workflow.get("status") == "completed"
            and workflow.get("conclusion") == "success"
        ):
            break
        if (
            workflow.get("status") != "in_progress"
            or "conclusion" not in workflow
            or workflow["conclusion"] is not None
        ):
            raise ArtifactFetchError("ARTIFACT_IDENTITY")
        if poll == WORKFLOW_MAX_POLLS:
            raise ArtifactFetchError("ARTIFACT_WORKFLOW_PENDING")
        sleeper(min(WORKFLOW_POLL_SECONDS, _metadata_timeout(deadline, clock)))
    location = _signed_download_url(
        f"{artifact_url}/zip", token, opener=opener
    )
    count = 0
    digest = hashlib.sha256()
    try:
        signed_request = urllib.request.Request(
            location,
            headers={"User-Agent": "AxialMuseWebsite-artifact-reader"},
        )
        with opener.open(signed_request, timeout=30) as response:
            if response.status != 200:
                raise ArtifactFetchError("ARTIFACT_ZIP_HTTP")
            while True:
                chunk = response.read(READ_SIZE)
                if not chunk:
                    break
                count += len(chunk)
                if count > size or count > MAX_ZIP_BYTES:
                    raise ArtifactFetchError("ARTIFACT_ZIP_SIZE")
                digest.update(chunk)
                if destination.write(chunk) != len(chunk):
                    raise ArtifactFetchError("ARTIFACT_ZIP_WRITE")
    except (OSError, urllib.error.URLError) as error:
        raise ArtifactFetchError("ARTIFACT_ZIP_HTTP") from error
    if count != size or digest.hexdigest() != artifact_digest:
        raise ArtifactFetchError("ARTIFACT_ZIP_DIGEST")
    return count

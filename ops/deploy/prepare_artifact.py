"""固定服务器入口的制品准备阶段；成功只产生私有 verified staging。"""

import os
import re
import stat
import subprocess

from ops.deploy.fetch_artifact import fetch_exact_artifact
from ops.deploy.github_app_auth import create_installation_token


STAGING_PARENT = "/srv/axialmuse/staging"
VERIFIER = "/usr/local/lib/axialmuse/artifact-verifier/verify_artifact.py"
PYTHON = "/usr/bin/python3"
DECIMAL = re.compile(r"[1-9][0-9]{0,15}\Z", re.ASCII)
COMMIT = re.compile(r"[0-9a-f]{40}\Z", re.ASCII)
DIGEST = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)


class PrepareArtifactError(Exception):
    pass


def _check_private_directory(path):
    try:
        metadata = os.lstat(path)
    except OSError as error:
        raise PrepareArtifactError("DEPLOY_STAGING_PARENT") from error
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != 0
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise PrepareArtifactError("DEPLOY_STAGING_PARENT")


def prepare_artifact(*, workflow_run_id, artifact_id, commit_sha,
                     artifact_digest, release_content_sha256,
                     token_provider=create_installation_token,
                     fetcher=fetch_exact_artifact,
                     verifier_runner=subprocess.run):
    if os.geteuid() != 0:
        raise PrepareArtifactError("DEPLOY_CONTEXT")
    _check_private_directory(STAGING_PARENT)
    if (
        not isinstance(workflow_run_id, str)
        or DECIMAL.fullmatch(workflow_run_id) is None
        or not isinstance(artifact_id, str)
        or DECIMAL.fullmatch(artifact_id) is None
        or not isinstance(commit_sha, str)
        or COMMIT.fullmatch(commit_sha) is None
        or not isinstance(artifact_digest, str)
        or DIGEST.fullmatch(artifact_digest) is None
        or not isinstance(release_content_sha256, str)
        or DIGEST.fullmatch(release_content_sha256) is None
    ):
        raise PrepareArtifactError("DEPLOY_INPUT")
    basename = f"{commit_sha}-{workflow_run_id}-{artifact_id}"
    token = token_provider()
    staging_root = f"{STAGING_PARENT}/{basename}"
    try:
        os.mkdir(staging_root, 0o700)
        _check_private_directory(staging_root)
        artifact_path = f"{staging_root}/artifact.zip"
        descriptor = os.open(
            artifact_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
        )
        with os.fdopen(descriptor, "wb") as output:
            fetcher(
                workflow_run_id=workflow_run_id,
                artifact_id=artifact_id,
                commit_sha=commit_sha,
                artifact_digest=artifact_digest,
                destination=output,
                token=token,
            )
            output.flush()
            os.fsync(output.fileno())
        result = verifier_runner(
            [
                PYTHON, "-I", "-B", VERIFIER,
                "--staging-root", staging_root,
                "--expected-artifact-digest", artifact_digest,
                "--expected-release-content-sha256", release_content_sha256,
                "--expected-commit-sha", commit_sha,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=300,
            env={"HOME": "/var/lib/axialmuse", "LANG": "C", "LC_ALL": "C"},
        )
        if result.returncode != 0:
            raise PrepareArtifactError("DEPLOY_VERIFY")
        verified = os.lstat(f"{staging_root}/verified-release")
        if (
            not stat.S_ISDIR(verified.st_mode)
            or verified.st_uid != 0
            or stat.S_IMODE(verified.st_mode) != 0o700
        ):
            raise PrepareArtifactError("DEPLOY_VERIFY")
        return staging_root
    except FileExistsError as error:
        raise PrepareArtifactError("DEPLOY_STAGE_EXISTS") from error
    except PrepareArtifactError:
        raise
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PrepareArtifactError("DEPLOY_PREPARE") from error

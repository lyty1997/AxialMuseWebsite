"""为固定仓库的 artifact 下载签发短时、只读 GitHub App 令牌。"""

import base64
import datetime
import json
import os
import re
import stat
import subprocess
import time
import urllib.error
import urllib.request


APP_CONFIG = "/etc/axialmuse/github-app.json"
APP_PRIVATE_KEY = "/etc/axialmuse/github-app-private-key.pem"
INSTALLATION_API = "https://api.github.com/app/installations/{installation_id}/access_tokens"
REPOSITORY_NAME = "AxialMuseWebsite"
API_VERSION = "2022-11-28"
MAX_CONFIG_BYTES = 1024
MAX_KEY_BYTES = 16 * 1024
MAX_TOKEN_RESPONSE_BYTES = 8192
POSITIVE_ID = re.compile(r"[1-9][0-9]{0,15}\Z", re.ASCII)


class GitHubAppAuthError(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _read_root_file(path, limit):
    descriptor = None
    try:
        directory = os.lstat("/etc/axialmuse")
        if (
            not stat.S_ISDIR(directory.st_mode)
            or directory.st_uid != 0
            or stat.S_IMODE(directory.st_mode) != 0o700
        ):
            raise GitHubAppAuthError("GITHUB_APP_FILE")
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != 0
            or before.st_nlink != 1
            or stat.S_IMODE(before.st_mode) not in (0o400, 0o600)
            or before.st_size < 1
            or before.st_size > limit
        ):
            raise GitHubAppAuthError("GITHUB_APP_FILE")
        content = os.read(descriptor, limit + 1)
        after = os.fstat(descriptor)
        if (
            len(content) != before.st_size
            or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
        ):
            raise GitHubAppAuthError("GITHUB_APP_FILE")
        return content
    except OSError as error:
        raise GitHubAppAuthError("GITHUB_APP_FILE") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)


def read_app_identity():
    try:
        identity = json.loads(_read_root_file(APP_CONFIG, MAX_CONFIG_BYTES))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GitHubAppAuthError("GITHUB_APP_CONFIG") from error
    if (
        not isinstance(identity, dict)
        or set(identity) != {"appId", "installationId"}
        or any(
            not isinstance(identity[field], str)
            or POSITIVE_ID.fullmatch(identity[field]) is None
            for field in ("appId", "installationId")
        )
    ):
        raise GitHubAppAuthError("GITHUB_APP_CONFIG")
    return identity


def _base64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=")


def build_app_jwt(app_id, *, now=None, sign=None):
    if POSITIVE_ID.fullmatch(app_id) is None:
        raise GitHubAppAuthError("GITHUB_APP_CONFIG")
    current = int(time.time() if now is None else now)
    if current < 1_700_000_000:
        raise GitHubAppAuthError("GITHUB_APP_CLOCK")
    header = _base64url(b'{"alg":"RS256","typ":"JWT"}')
    payload = _base64url(json.dumps(
        {"iat": current - 60, "exp": current + 540, "iss": app_id},
        separators=(",", ":"),
    ).encode("ascii"))
    message = header + b"." + payload
    signature = (sign or _sign_with_openssl)(message)
    if not isinstance(signature, bytes) or not signature:
        raise GitHubAppAuthError("GITHUB_APP_SIGNATURE")
    return (message + b"." + _base64url(signature)).decode("ascii")


def _sign_with_openssl(message):
    _read_root_file(APP_PRIVATE_KEY, MAX_KEY_BYTES)
    try:
        result = subprocess.run(
            ["/usr/bin/openssl", "dgst", "-sha256", "-sign", APP_PRIVATE_KEY],
            input=message,
            capture_output=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GitHubAppAuthError("GITHUB_APP_SIGNATURE") from error
    if result.returncode != 0 or not result.stdout:
        raise GitHubAppAuthError("GITHUB_APP_SIGNATURE")
    return result.stdout


def create_installation_token(*, identity=None, request=None, now=None, sign=None):
    if os.geteuid() != 0:
        raise GitHubAppAuthError("GITHUB_APP_CONTEXT")
    identity = read_app_identity() if identity is None else identity
    if (
        not isinstance(identity, dict)
        or set(identity) != {"appId", "installationId"}
        or any(
            not isinstance(identity[field], str)
            or POSITIVE_ID.fullmatch(identity[field]) is None
            for field in ("appId", "installationId")
        )
    ):
        raise GitHubAppAuthError("GITHUB_APP_CONFIG")
    jwt = build_app_jwt(identity["appId"], now=now, sign=sign)
    body = json.dumps({
        "repositories": [REPOSITORY_NAME],
        "permissions": {"actions": "read"},
    }, separators=(",", ":")).encode("ascii")
    endpoint = INSTALLATION_API.format(installation_id=identity["installationId"])
    operation = request or _request_token
    response = operation(endpoint, jwt, body)
    if (
        not isinstance(response, dict)
        or not isinstance(response.get("token"), str)
        or len(response["token"]) < 16
        or len(response["token"]) > 4096
        or re.search(r"[\x00-\x20\x7f]", response["token"])
        or response.get("permissions") not in (
            {"actions": "read"},
            {"actions": "read", "metadata": "read"},
        )
        or not isinstance(response.get("repositories"), list)
        or len(response["repositories"]) != 1
        or not isinstance(response["repositories"][0], dict)
        or response["repositories"][0].get("full_name")
        != "lyty1997/AxialMuseWebsite"
        or not isinstance(response.get("expires_at"), str)
    ):
        raise GitHubAppAuthError("GITHUB_APP_SCOPE")
    try:
        expires_at = datetime.datetime.fromisoformat(
            response["expires_at"].replace("Z", "+00:00")
        )
        current = datetime.datetime.now(datetime.timezone.utc)
        if (
            expires_at.tzinfo is None
            or expires_at - current < datetime.timedelta(minutes=5)
            or expires_at - current > datetime.timedelta(minutes=65)
        ):
            raise GitHubAppAuthError("GITHUB_APP_EXPIRY")
    except ValueError as error:
        raise GitHubAppAuthError("GITHUB_APP_EXPIRY") from error
    return response["token"]


def _request_token(endpoint, jwt, body):
    operation = urllib.request.Request(
        endpoint,
        data=body,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {jwt}",
            "Content-Type": "application/json",
            "User-Agent": "AxialMuseWebsite-artifact-reader",
            "X-GitHub-Api-Version": API_VERSION,
        },
        method="POST",
    )
    try:
        with _OPENER.open(operation, timeout=20) as response:
            if response.status != 201:
                raise GitHubAppAuthError("GITHUB_APP_TOKEN")
            raw = response.read(MAX_TOKEN_RESPONSE_BYTES + 1)
        if len(raw) > MAX_TOKEN_RESPONSE_BYTES:
            raise GitHubAppAuthError("GITHUB_APP_TOKEN")
        return json.loads(raw)
    except (OSError, urllib.error.URLError, ValueError) as error:
        raise GitHubAppAuthError("GITHUB_APP_TOKEN") from error

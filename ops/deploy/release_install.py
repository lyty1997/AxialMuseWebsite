"""消费已验证 staging，安装同 SHA payload/config 并保留私有身份收据。"""

import ctypes
import errno
import os
import re
import secrets
import stat
from pathlib import Path

from ops.deploy.deployment_state import (
    DeploymentError, canonical, check_directory, decode, digest, identity_valid,
    read_file, require, sync_directory, write_new,
)
from ops.deploy.url_exposure_ledger import make_release_view


def sha_valid(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value), "DEPLOY_SHA")


def site_config(root, sha):
    sha_valid(sha)
    require(re.fullmatch(r"/[A-Za-z0-9_./-]+", str(root)), "DEPLOY_PATH")
    directory = Path(root) / sha
    return (f"root {directory}/payload;\n"
            f"include {directory}/config/redirects.conf;\n").encode()


def rename_new(source, target):
    library = ctypes.CDLL(None, use_errno=True)
    result = library.renameat2(-100, os.fsencode(source), -100, os.fsencode(target), 1)
    if result != 0:
        error = ctypes.get_errno()
        raise DeploymentError("DEPLOY_RELEASE_EXISTS" if error == errno.EEXIST else "DEPLOY_RENAME")
    sync_directory(Path(target).parent)


class ReleaseStore:
    def __init__(self, site, state, verifier):
        self.site = Path(site)
        self.releases = self.site / "releases"
        self.state = state
        self.uid = state.uid
        self.verifier = verifier

    def capture(self, path):
        check_directory(path, self.uid)
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            capture = self.verifier._capture_file_tree(fd, "release")
            require(os.fstat(fd).st_ino == path.lstat().st_ino, "DEPLOY_DRIFT")
            return capture
        finally:
            os.close(fd)

    def read_view(self, sha):
        sha_valid(sha)
        directory = self.releases / sha
        check_directory(directory, self.uid, 0o755)
        receipt = decode(read_file(self.state.root / "releases" / f"{sha}.json", self.uid, mode=0o600))
        require(set(receipt) == {"identity", "files", "routes"}, "DEPLOY_RELEASE_RECEIPT")
        identity_valid(receipt["identity"])
        require(receipt["identity"]["commit_sha"] == sha, "DEPLOY_RELEASE_RECEIPT")
        capture = self.capture(directory)
        actual = {record.path: record.sha256 for record in capture.records}
        require(actual == receipt["files"], "DEPLOY_RELEASE_DIGEST")
        for parent, folders, files in os.walk(directory, followlinks=False):
            check_directory(parent, self.uid, 0o755)
            for folder in folders:
                check_directory(Path(parent) / folder, self.uid, 0o755)
            for filename in files:
                metadata = (Path(parent) / filename).lstat()
                require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == self.uid
                        and metadata.st_nlink == 1 and stat.S_IMODE(metadata.st_mode) == 0o644,
                        "DEPLOY_RELEASE_MODE")
        require(read_file(directory / "config/site-release.conf", self.uid) == site_config(self.releases, sha),
                "DEPLOY_RELEASE_CONFIG")
        runtime = read_file(directory / "config/runtime-redirects.json", self.uid)
        view = make_release_view(commit_sha=sha, published_routes=receipt["routes"], runtime_content=runtime)
        require(self.capture(directory) == capture, "DEPLOY_DRIFT")
        return view, receipt, capture

    def install(self, stage, identity):
        identity_valid(identity)
        stage = Path(stage)
        check_directory(stage, self.uid, 0o700)
        require(stage.name == "-".join(identity[key] for key in ("commit_sha", "workflow_run_id", "artifact_id")),
                "DEPLOY_STAGE_IDENTITY")
        archive = read_file(stage / "artifact.zip", self.uid, limit=512 * 1024 * 1024, mode=0o600)
        require(digest(archive) == identity["artifact_digest"], "DEPLOY_ARCHIVE_DIGEST")
        del archive
        source = stage / "verified-release"
        check_directory(source, self.uid, 0o700)
        check_directory(self.releases, self.uid, 0o755)
        fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            before = self.verifier._capture_file_tree(fd, "release")
            require(before.tree_sha256 == identity["release_content_sha256"], "DEPLOY_RELEASE_DIGEST")
            self.verifier._validate_release(fd, before, identity["commit_sha"])
            require(self.verifier._capture_file_tree(fd, "release") == before, "DEPLOY_DRIFT")
            sha = identity["commit_sha"]
            destination = self.releases / sha
            if os.path.lexists(destination):
                view, receipt, _ = self.read_view(sha)
                require(receipt["identity"] == identity, "DEPLOY_RELEASE_EXISTS")
                require(self.verifier._capture_file_tree(fd, "release") == before, "DEPLOY_DRIFT")
                # 原样复验已有精确身份，允许审批补齐后的显式重入；绝不覆盖 release。
                return view
            temporary = self.releases / f".candidate-{secrets.token_hex(16)}"
            temporary.mkdir(mode=0o700)
            expected = {}
            runtime = None
            routes = []
            for record in before.records:
                if record.path.startswith("payload/"):
                    target = record.path
                    if target.endswith("/index.html"):
                        routes.append("/" + target[len("payload/"):-len("index.html")])
                elif record.path == "metadata/runtime-redirects.json":
                    target = "config/runtime-redirects.json"
                elif record.path == "metadata/nginx/redirects.conf":
                    target = "config/redirects.conf"
                else:
                    continue
                metadata = (source / record.path).lstat()
                require(metadata.st_uid == self.uid and not metadata.st_mode & 0o022,
                        "DEPLOY_OWNER")
                content = self.verifier._read_captured_file(fd, before, record.path, record.byte_length)
                require(digest(content) == record.sha256, "DEPLOY_RELEASE_DIGEST")
                if target == "config/runtime-redirects.json":
                    runtime = content
                path = temporary / target
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                write_new(path, content, 0o644)
                expected[target] = digest(content)
            require(runtime is not None, "DEPLOY_RELEASE_CONFIG")
            view = make_release_view(commit_sha=sha, published_routes=sorted(routes), runtime_content=runtime)
            wrapper = site_config(self.releases, sha)
            write_new(temporary / "config/site-release.conf", wrapper, 0o644)
            expected["config/site-release.conf"] = digest(wrapper)
            for parent, _, _ in os.walk(temporary, topdown=False):
                os.chmod(parent, 0o755)
                sync_directory(parent)
            require(self.verifier._capture_file_tree(fd, "release") == before, "DEPLOY_DRIFT")
            require((source.lstat().st_dev, source.lstat().st_ino)
                    == (os.fstat(fd).st_dev, os.fstat(fd).st_ino), "DEPLOY_DRIFT")
            actual = {record.path: record.sha256 for record in self.capture(temporary).records}
            require(actual == expected, "DEPLOY_RELEASE_DIGEST")
            rename_new(temporary, destination)
            receipt = {"identity": identity, "files": expected, "routes": list(view.published_routes)}
            write_new(self.state.root / "releases" / f"{sha}.json", canonical(receipt))
            self.read_view(sha)
            return view
        finally:
            os.close(fd)

    def current(self):
        path = self.site / "current"
        if not os.path.lexists(path):
            return None
        metadata = path.lstat()
        require(stat.S_ISLNK(metadata.st_mode) and metadata.st_uid == self.uid, "DEPLOY_CURRENT")
        target = os.readlink(path)
        require(re.fullmatch(r"releases/[0-9a-f]{40}", target), "DEPLOY_CURRENT")
        sha = target.split("/")[1]
        self.read_view(sha)
        return sha

    def switch(self, sha, expected):
        self.read_view(sha)
        require(self.current() == expected, "DEPLOY_CURRENT_DRIFT")
        temporary = self.site / f".current-{secrets.token_hex(16)}"
        os.symlink(f"releases/{sha}", temporary)
        os.replace(temporary, self.site / "current")
        sync_directory(self.site)
        require(self.current() == sha, "DEPLOY_CURRENT_DRIFT")

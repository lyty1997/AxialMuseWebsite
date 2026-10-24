"""部署私有状态：只追加账本、事务阻断和一次性批准。"""

import contextlib
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import time
from pathlib import Path

from ops.deploy import url_exposure_ledger as ledger


class DeploymentError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise DeploymentError(code)


def canonical(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def digest(content):
    return hashlib.sha256(content).hexdigest()


def decode(content):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "DEPLOY_STATE_JSON")
            result[key] = value
        return result
    try:
        value = json.loads(content, object_pairs_hook=pairs)
        require(canonical(value) == content, "DEPLOY_STATE_JSON")
        return value
    except (ValueError, UnicodeError) as error:
        raise DeploymentError("DEPLOY_STATE_JSON") from error


def check_directory(path, uid, mode=None):
    path = Path(path)
    require(path.is_absolute(), "DEPLOY_PATH")
    # 全部祖先禁止 symlink；生产入口的固定根目录另由安装后验认证。
    for item in (path, *path.parents):
        metadata = item.lstat()
        require(stat.S_ISDIR(metadata.st_mode), "DEPLOY_DIRECTORY")
        require(metadata.st_uid in (0, uid), "DEPLOY_OWNER")
        require(not metadata.st_mode & 0o022 or item == Path("/tmp"), "DEPLOY_MODE")
    metadata = path.stat()
    require(metadata.st_uid == uid and metadata.st_gid == (0 if uid == 0 else os.getegid()), "DEPLOY_OWNER")
    if mode is not None:
        require(stat.S_IMODE(metadata.st_mode) == mode, "DEPLOY_MODE")


def read_file(path, uid, limit=8 * 1024 * 1024, mode=None):
    path = Path(path)
    check_directory(path.parent, uid)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, "DEPLOY_FILE")
        require(before.st_uid == uid and before.st_gid == (0 if uid == 0 else os.getegid())
                and not before.st_mode & 0o022, "DEPLOY_OWNER")
        require(before.st_size <= limit, "DEPLOY_FILE_SIZE")
        if mode is not None:
            require(stat.S_IMODE(before.st_mode) == mode, "DEPLOY_MODE")
        with os.fdopen(os.dup(descriptor), "rb") as stream:
            content = stream.read(limit + 1)
        after = os.fstat(descriptor)
        def identity(s):
            return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(identity(before) == identity(after) == identity(path.lstat()), "DEPLOY_DRIFT")
        require(len(content) == before.st_size, "DEPLOY_DRIFT")
        return content
    finally:
        os.close(descriptor)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_new(path, content, mode=0o600):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(content)
        stream.flush()
        os.fchmod(stream.fileno(), mode)
        os.fsync(stream.fileno())
    sync_directory(Path(path).parent)


def replace_file(path, content):
    path = Path(path)
    temporary = path.with_name(f".{path.name}-{secrets.token_hex(16)}")
    write_new(temporary, content)
    os.replace(temporary, path)
    sync_directory(path.parent)


def identity_valid(identity):
    require(isinstance(identity, dict) and set(identity) == {
        "workflow_run_id", "artifact_id", "commit_sha", "artifact_digest",
        "release_content_sha256",
    }, "DEPLOY_IDENTITY")
    for key, value in identity.items():
        pattern = r"[1-9][0-9]{0,15}" if key.endswith("_id") else (
            r"[0-9a-f]{40}" if key == "commit_sha" else r"[0-9a-f]{64}"
        )
        require(isinstance(value, str) and re.fullmatch(pattern, value), "DEPLOY_IDENTITY")
        if key.endswith("_id"):
            require(int(value) <= 9007199254740991, "DEPLOY_IDENTITY")


class DeploymentState:
    def __init__(self, home, uid=0):
        self.home = Path(home)
        self.root = self.home / "deployment"
        self.history = self.root / "ledger-history"
        self.transactions = self.root / "transactions"
        self.ledger_path = self.home / "url-exposure-ledger.json"
        self.uid = uid

    def initialize(self):
        """仅由显式初始化命令调用；任何已存在/半初始化状态都不覆盖。"""
        check_directory(self.home, self.uid)
        require(not os.path.lexists(self.ledger_path), "DEPLOY_ALREADY_INITIALIZED")
        self.root.mkdir(mode=0o700)
        sync_directory(self.home)
        self.history.mkdir(mode=0o700)
        self.transactions.mkdir(mode=0o700)
        (self.root / "releases").mkdir(mode=0o700)
        empty = ledger.serialize_exposure_ledger(ledger.empty_exposure_ledger())
        write_new(self.history / "00000000.json", canonical({
            "previous": None, "ledger": decode(empty),
        }))
        write_new(self.ledger_path, empty)
        write_new(self.root / "initialized", digest(empty).encode() + b"\n")
        write_new(self.root / "lock", b"")
        sync_directory(self.root)

    @contextlib.contextmanager
    def locked(self):
        check_directory(self.root, self.uid, 0o700)
        read_file(self.root / "initialized", self.uid, mode=0o600)
        path = self.root / "lock"
        require(read_file(path, self.uid, mode=0o600) == b"", "DEPLOY_LOCK")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise DeploymentError("DEPLOY_LOCK_BUSY") from error
            held = os.fstat(fd)
            live = path.lstat()
            require((held.st_dev, held.st_ino) == (live.st_dev, live.st_ino), "DEPLOY_LOCK")
            yield
        finally:
            os.close(fd)

    def read_ledger(self):
        check_directory(self.history, self.uid, 0o700)
        names = sorted(os.listdir(self.history))
        require(names and names == [f"{i:08d}.json" for i in range(len(names))], "DEPLOY_LEDGER_CHAIN")
        previous_digest = None
        previous_ledger = ledger.empty_exposure_ledger()
        for index, name in enumerate(names):
            content = read_file(self.history / name, self.uid, mode=0o600)
            event = decode(content)
            require(set(event) == {"previous", "ledger"} and event["previous"] == previous_digest,
                    "DEPLOY_LEDGER_CHAIN")
            current = ledger.parse_exposure_ledger(canonical(event["ledger"]))
            if index == 0:
                require(current == ledger.empty_exposure_ledger(), "DEPLOY_LEDGER_GENESIS")
                require(read_file(self.root / "initialized", self.uid, mode=0o600)
                        == digest(canonical(event["ledger"])).encode() + b"\n", "DEPLOY_LEDGER_GENESIS")
            ledger.assert_ledger_append_only(previous_ledger, current)
            previous_ledger, previous_digest = current, digest(content)
        live = read_file(self.ledger_path, self.uid, mode=0o600)
        require(live == ledger.serialize_exposure_ledger(previous_ledger), "DEPLOY_LEDGER_HEAD")
        return live, previous_digest, len(names)

    def append_ledger(self, before, after):
        live, previous, count = self.read_ledger()
        require(live == before, "DEPLOY_LEDGER_DRIFT")
        ledger.assert_ledger_append_only(ledger.parse_exposure_ledger(before),
                                       ledger.parse_exposure_ledger(after))
        if before == after:
            return
        # 先备份再切换；两步之间崩溃会形成显式不一致，由人工恢复。
        write_new(self.history / f"{count:08d}.json", canonical({
            "previous": previous, "ledger": decode(after),
        }))
        replace_file(self.ledger_path, after)
        require(self.read_ledger()[0] == after, "DEPLOY_LEDGER_HEAD")

    def assert_idle(self):
        check_directory(self.transactions, self.uid, 0o700)
        for name in os.listdir(self.transactions):
            require(re.fullmatch(r"[0-9a-f]{32}", name), "DEPLOY_TRANSACTION")
            directory = self.transactions / name
            check_directory(directory, self.uid, 0o700)
            require((directory / "result.json").exists(), "DEPLOY_RECOVERY_REQUIRED")
            result = decode(read_file(directory / "result.json", self.uid, mode=0o600))
            require(result.get("status") in ("local-accepted", "recovered", "rejected", "forward-only-failed"),
                    "DEPLOY_RECOVERY_REQUIRED")

    def successful_releases(self):
        self.assert_idle()
        shas = set()
        for directory in self.transactions.iterdir():
            result = decode(read_file(directory / "result.json", self.uid, mode=0o600))
            if result["status"] == "local-accepted":
                sha = result.get("sha")
                require(isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha), "DEPLOY_TRANSACTION")
                shas.add(sha)
        return shas

    def begin(self, request):
        self.assert_idle()
        directory = self.transactions / secrets.token_hex(16)
        directory.mkdir(mode=0o700)
        sync_directory(self.transactions)
        write_new(directory / "request.json", canonical(request))
        return directory

    def consume_approval(self, transaction, identity, before, after, now=None):
        identity_valid(identity)
        now = time.time() if now is None else now
        source = self.root / "forward-only.json"
        approval = decode(read_file(source, self.uid, mode=0o600))
        require(set(approval) == {"id", "identity", "before", "after", "expires"}, "DEPLOY_APPROVAL")
        require(isinstance(approval["id"], str) and re.fullmatch(r"[0-9a-f]{32}", approval["id"]),
                "DEPLOY_APPROVAL")
        require(approval["identity"] == identity and approval["before"] == digest(before)
                and approval["after"] == digest(after), "DEPLOY_APPROVAL_IDENTITY")
        expires = approval["expires"]
        require(type(expires) is int and now < expires <= now + 3600, "DEPLOY_APPROVAL_EXPIRED")
        for entry in self.transactions.iterdir():
            prior = entry / "approval.json"
            if prior.exists():
                used = decode(read_file(prior, self.uid, mode=0o600))
                require(used["id"] != approval["id"], "DEPLOY_APPROVAL_REPLAY")
        require(not os.path.lexists(transaction / "approval.json"), "DEPLOY_APPROVAL_REPLAY")
        os.rename(source, transaction / "approval.json")
        sync_directory(transaction)
        sync_directory(self.root)
        return approval["id"]

import contextlib
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import re
import secrets
import selectors
import signal
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


EXPECTED_PYTHON = (3, 12)
EXPECTED_PYTHON_REALPATH = "/usr/bin/python3.12"
REPOSITORY = "lyty1997/AxialMuseWebsite"
RECEIPT_SCHEMA_VERSION = "1.1.0"
SELF_TEST_SCHEMA_VERSION = "1.0.0"
FILE_TREE_WIRE_MAGIC = "AXIALMUSE-FILE-TREE-V1"

FORMAL_NAMESPACE = "axialmuse"
INSTALL_DIRECTORY = "artifact-verifier"
STATE_DIRECTORY = ".bootstrap"
VERIFIER_BASENAME = "verify_artifact.py"
GOLDEN_BASENAME = "file-tree-v1-golden.json"
RECEIPT_BASENAME = "receipt.json"
PREPARED_BASENAME = "prepared"
COMMITTED_BASENAME = "committed"
LOCK_BASENAME = ".axialmuse-artifact-verifier-bootstrap.lock"
CANDIDATE_PREFIX = ".axialmuse-artifact-verifier-candidate-"
ISOLATION_PREFIX = ".axialmuse-artifact-verifier-isolated-"

MAX_VERIFIER_BYTES = 8 * 1024 * 1024
MAX_GOLDEN_BYTES = 8 * 1024 * 1024
MAX_RECEIPT_BYTES = 64 * 1024
MAX_SELF_TEST_OUTPUT_BYTES = 64 * 1024
SELF_TEST_TIMEOUT_SECONDS = 30
RENAME_NOREPLACE = 1
INTERRUPT_SIGNALS = frozenset((signal.SIGINT, signal.SIGTERM))

HEX_40_PATTERN = re.compile(r"^[0-9a-f]{40}$", re.ASCII)
HEX_64_PATTERN = re.compile(r"^[0-9a-f]{64}$", re.ASCII)
TRANSACTION_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$", re.ASCII)

ERROR_MESSAGES = {
    "VERIFIER_BOOTSTRAP_RUNTIME": "bootstrap 运行时不符合固定 Ubuntu Python 基线。",
    "VERIFIER_BOOTSTRAP_ARGUMENT": "bootstrap 参数不符合固定接口。",
    "VERIFIER_BOOTSTRAP_SOURCE": "bootstrap 源文件身份或摘要不合法。",
    "VERIFIER_BOOTSTRAP_PARENT": "系统安装父目录不符合安全边界。",
    "VERIFIER_BOOTSTRAP_LOCK": "bootstrap 无法取得唯一安装锁。",
    "VERIFIER_BOOTSTRAP_STATE": "bootstrap 事务状态不唯一或不可自动恢复。",
    "VERIFIER_BOOTSTRAP_RECEIPT": "bootstrap receipt 不符合当前安装身份。",
    "VERIFIER_BOOTSTRAP_TREE": "bootstrap 管理的目录或文件树不合法。",
    "VERIFIER_BOOTSTRAP_SELF_TEST": "候选 verifier 自测未通过。",
    "VERIFIER_BOOTSTRAP_COMMIT": "bootstrap 无法完成不覆盖提交。",
    "VERIFIER_BOOTSTRAP_ISOLATE": "失败事务无法按身份隔离。",
    "VERIFIER_BOOTSTRAP_INTERRUPTED": "bootstrap 在提交前被中断。",
}


class VerifierBootstrapError(Exception):
    def __init__(self, code, source_path, *, cause=None):
        super().__init__(ERROR_MESSAGES.get(code, "verifier bootstrap 失败。"))
        self.code = code
        self.source_path = _safe_source_path(source_path)
        self.cause = cause
        self.__traceback__ = None


@dataclass(frozen=True)
class SourceBlob:
    basename: str
    content: bytes
    sha256: str


@dataclass(frozen=True)
class SystemDirectory:
    descriptor: int
    source_path: str
    identity: tuple


@dataclass
class SystemTree:
    root: SystemDirectory
    usr: SystemDirectory
    local: SystemDirectory
    lib: SystemDirectory
    root_path: Path
    lib_path: Path
    expected_uid: int
    expected_gid: int


@dataclass
class OpenTransaction:
    name: str
    marker_name: str
    receipt: dict
    namespace_descriptor: int
    install_descriptor: int
    state_descriptor: int
    verifier_descriptor: int
    golden_descriptor: int
    receipt_descriptor: int
    marker_descriptor: int
    namespace_operational_identity: tuple
    verifier_operational_identity: tuple
    golden_operational_identity: tuple
    receipt_operational_identity: tuple
    marker_operational_identity: tuple
    descriptors: tuple

    def close(self):
        for descriptor in reversed(self.descriptors):
            try:
                os.close(descriptor)
            except OSError:
                pass


def _safe_source_path(value):
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 256
        or value.startswith("/")
        or "\\" in value
        or any(ord(character) < 0x20 for character in value)
    ):
        return "bootstrap/unknown"
    segments = value.split("/")
    if any(segment in ("", ".", "..") for segment in segments):
        return "bootstrap/unknown"
    return value


def _fail(code, source_path, cause=None):
    raise VerifierBootstrapError(code, source_path, cause=cause)


def format_verifier_bootstrap_error(error):
    if not isinstance(error, VerifierBootstrapError):
        return (
            "[VERIFIER_BOOTSTRAP_INTERNAL] "
            "verifier bootstrap 发生未分类错误；底层细节已抑制。"
        )
    return f"[{error.code}] ({error.source_path}) {error}"


def _operational_identity(metadata):
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_nlink,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _directory_identity(metadata):
    return (
        metadata.st_dev,
        metadata.st_ino,
        stat.S_IFMT(metadata.st_mode),
        stat.S_IMODE(metadata.st_mode),
        metadata.st_uid,
        metadata.st_gid,
    )


def _receipt_identity(metadata):
    return {
        "device": metadata.st_dev,
        "inode": metadata.st_ino,
    }


def _assert_runtime():
    if (
        sys.platform != "linux"
        or sys.version_info[:2] != EXPECTED_PYTHON
        or os.path.realpath(sys.executable) != EXPECTED_PYTHON_REALPATH
        or os.geteuid() != 0
    ):
        _fail("VERIFIER_BOOTSTRAP_RUNTIME", "runtime/python")


def _assert_hex(value, pattern, source_path):
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        _fail("VERIFIER_BOOTSTRAP_ARGUMENT", source_path)
    return value


def _read_all(descriptor, maximum_bytes, code, source_path):
    try:
        metadata_before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata_before.st_mode)
            or metadata_before.st_nlink != 1
            or metadata_before.st_size < 0
            or metadata_before.st_size > maximum_bytes
        ):
            _fail(code, source_path)
        os.lseek(descriptor, 0, os.SEEK_SET)
        chunks = []
        total = 0
        while True:
            chunk = os.read(descriptor, min(64 * 1024, maximum_bytes + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > maximum_bytes:
                _fail(code, source_path)
        metadata_after = os.fstat(descriptor)
        if (
            _operational_identity(metadata_before)
            != _operational_identity(metadata_after)
            or total != metadata_before.st_size
        ):
            _fail(code, source_path)
        return b"".join(chunks), metadata_after
    except VerifierBootstrapError:
        raise
    except OSError as cause:
        _fail(code, source_path, cause)


def _capture_source_file(
    directory_descriptor,
    basename,
    expected_sha256,
    maximum_bytes,
):
    source_path = f"source/{basename}"
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(
            basename,
            flags,
            dir_fd=directory_descriptor,
        )
    except OSError as cause:
        _fail("VERIFIER_BOOTSTRAP_SOURCE", source_path, cause)
    try:
        content, metadata = _read_all(
            descriptor,
            maximum_bytes,
            "VERIFIER_BOOTSTRAP_SOURCE",
            source_path,
        )
        if (
            stat.S_IMODE(metadata.st_mode) != 0o600
            or hashlib.sha256(content).hexdigest() != expected_sha256
        ):
            _fail("VERIFIER_BOOTSTRAP_SOURCE", source_path)
        rebound = _open_file_at(
            directory_descriptor,
            basename,
            source_path,
            code="VERIFIER_BOOTSTRAP_SOURCE",
        )
        try:
            if (
                _operational_identity(os.fstat(rebound))
                != _operational_identity(metadata)
            ):
                _fail("VERIFIER_BOOTSTRAP_SOURCE", source_path)
        finally:
            os.close(rebound)
        return SourceBlob(
            basename=basename,
            content=content,
            sha256=expected_sha256,
        )
    finally:
        os.close(descriptor)


def _capture_sources(
    source_root,
    expected_verifier_sha256,
    expected_golden_sha256,
):
    if (
        not isinstance(source_root, str)
        or not os.path.isabs(source_root)
        or os.path.normpath(source_root) != source_root
    ):
        _fail("VERIFIER_BOOTSTRAP_ARGUMENT", "source/root")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(source_root, flags)
    except OSError as cause:
        _fail("VERIFIER_BOOTSTRAP_SOURCE", "source/root", cause)
    try:
        metadata_before = os.fstat(descriptor)
        expected_members = (GOLDEN_BASENAME, VERIFIER_BASENAME)
        if (
            not stat.S_ISDIR(metadata_before.st_mode)
            or stat.S_IMODE(metadata_before.st_mode) != 0o700
            or _list_directory(
                descriptor,
                "VERIFIER_BOOTSTRAP_SOURCE",
                "source/root",
            )
            != expected_members
        ):
            _fail("VERIFIER_BOOTSTRAP_SOURCE", "source/root")
        verifier = _capture_source_file(
            descriptor,
            VERIFIER_BASENAME,
            expected_verifier_sha256,
            MAX_VERIFIER_BYTES,
        )
        golden = _capture_source_file(
            descriptor,
            GOLDEN_BASENAME,
            expected_golden_sha256,
            MAX_GOLDEN_BYTES,
        )
        metadata_after = os.fstat(descriptor)
        try:
            path_metadata = os.stat(source_root, follow_symlinks=False)
        except OSError as cause:
            _fail("VERIFIER_BOOTSTRAP_SOURCE", "source/root", cause)
        if (
            _operational_identity(metadata_before)
            != _operational_identity(metadata_after)
            or metadata_after.st_dev != path_metadata.st_dev
            or metadata_after.st_ino != path_metadata.st_ino
            or _list_directory(
                descriptor,
                "VERIFIER_BOOTSTRAP_SOURCE",
                "source/root",
            )
            != expected_members
        ):
            _fail("VERIFIER_BOOTSTRAP_SOURCE", "source/root")
        return verifier, golden
    finally:
        os.close(descriptor)


def _open_directory(path_or_name, source_path, *, directory_descriptor=None):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        return os.open(
            path_or_name,
            flags,
            dir_fd=directory_descriptor,
        )
    except OSError as cause:
        _fail("VERIFIER_BOOTSTRAP_PARENT", source_path, cause)


def _assert_system_directory(
    descriptor,
    source_path,
    *,
    expected_uid,
    expected_gid,
):
    try:
        metadata = os.fstat(descriptor)
    except OSError as cause:
        _fail("VERIFIER_BOOTSTRAP_PARENT", source_path, cause)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != expected_uid
        or metadata.st_gid != expected_gid
        or stat.S_IMODE(metadata.st_mode) & 0o022
    ):
        _fail("VERIFIER_BOOTSTRAP_PARENT", source_path)
    return SystemDirectory(
        descriptor=descriptor,
        source_path=source_path,
        identity=_directory_identity(metadata),
    )


@contextlib.contextmanager
def _open_system_tree(root_path, *, expected_uid, expected_gid):
    root = Path(root_path)
    if not root.is_absolute():
        _fail("VERIFIER_BOOTSTRAP_ARGUMENT", "runtime/root")
    descriptors = []
    try:
        root_descriptor = _open_directory(str(root), "system/root")
        descriptors.append(root_descriptor)
        root_directory = _assert_system_directory(
            root_descriptor,
            "system/root",
            expected_uid=expected_uid,
            expected_gid=expected_gid,
        )

        usr_descriptor = _open_directory(
            "usr",
            "system/usr",
            directory_descriptor=root_descriptor,
        )
        descriptors.append(usr_descriptor)
        usr_directory = _assert_system_directory(
            usr_descriptor,
            "system/usr",
            expected_uid=expected_uid,
            expected_gid=expected_gid,
        )

        local_descriptor = _open_directory(
            "local",
            "system/usr-local",
            directory_descriptor=usr_descriptor,
        )
        descriptors.append(local_descriptor)
        local_directory = _assert_system_directory(
            local_descriptor,
            "system/usr-local",
            expected_uid=expected_uid,
            expected_gid=expected_gid,
        )

        lib_descriptor = _open_directory(
            "lib",
            "system/usr-local-lib",
            directory_descriptor=local_descriptor,
        )
        descriptors.append(lib_descriptor)
        lib_directory = _assert_system_directory(
            lib_descriptor,
            "system/usr-local-lib",
            expected_uid=expected_uid,
            expected_gid=expected_gid,
        )

        yield SystemTree(
            root=root_directory,
            usr=usr_directory,
            local=local_directory,
            lib=lib_directory,
            root_path=root,
            lib_path=root / "usr" / "local" / "lib",
            expected_uid=expected_uid,
            expected_gid=expected_gid,
        )
    finally:
        for descriptor in reversed(descriptors):
            try:
                os.close(descriptor)
            except OSError:
                pass


def _reverify_system_tree(tree):
    for directory in (tree.root, tree.usr, tree.local, tree.lib):
        try:
            metadata = os.fstat(directory.descriptor)
        except OSError as cause:
            _fail(
                "VERIFIER_BOOTSTRAP_PARENT",
                directory.source_path,
                cause,
            )
        if _directory_identity(metadata) != directory.identity:
            _fail("VERIFIER_BOOTSTRAP_PARENT", directory.source_path)
    descriptors = []
    try:
        fresh_root = _open_directory(str(tree.root_path), "system/root")
        descriptors.append(fresh_root)
        fresh_usr = _open_directory(
            "usr",
            "system/usr",
            directory_descriptor=fresh_root,
        )
        descriptors.append(fresh_usr)
        fresh_local = _open_directory(
            "local",
            "system/usr-local",
            directory_descriptor=fresh_usr,
        )
        descriptors.append(fresh_local)
        fresh_lib = _open_directory(
            "lib",
            "system/usr-local-lib",
            directory_descriptor=fresh_local,
        )
        descriptors.append(fresh_lib)
        for descriptor, expected in zip(
            (fresh_root, fresh_usr, fresh_local, fresh_lib),
            (tree.root, tree.usr, tree.local, tree.lib),
            strict=True,
        ):
            if _directory_identity(os.fstat(descriptor)) != expected.identity:
                _fail(
                    "VERIFIER_BOOTSTRAP_PARENT",
                    expected.source_path,
                )
    finally:
        for descriptor in reversed(descriptors):
            try:
                os.close(descriptor)
            except OSError:
                pass


def _reverify_lock(tree, descriptor):
    try:
        metadata = os.fstat(descriptor)
        rebound = _open_file_at(
            tree.lib.descriptor,
            LOCK_BASENAME,
            "state/lock",
        )
        try:
            rebound_metadata = os.fstat(rebound)
        finally:
            os.close(rebound)
    except VerifierBootstrapError:
        raise
    except OSError as cause:
        _fail("VERIFIER_BOOTSTRAP_LOCK", "state/lock", cause)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != tree.expected_uid
        or metadata.st_gid != tree.expected_gid
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_size != 0
        or _operational_identity(metadata)
        != _operational_identity(rebound_metadata)
    ):
        _fail("VERIFIER_BOOTSTRAP_LOCK", "state/lock")


@contextlib.contextmanager
def _acquire_lock(tree):
    descriptor = None
    directory_locked = False
    try:
        try:
            fcntl.flock(
                tree.lib.descriptor,
                fcntl.LOCK_EX | fcntl.LOCK_NB,
            )
            directory_locked = True
        except OSError as cause:
            if cause.errno in (errno.EACCES, errno.EAGAIN):
                _fail("VERIFIER_BOOTSTRAP_LOCK", "state/parent-lock")
            _fail(
                "VERIFIER_BOOTSTRAP_LOCK",
                "state/parent-lock",
                cause,
            )
        _reverify_system_tree(tree)

        flags = os.O_RDWR | os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        created = False
        try:
            descriptor = os.open(
                LOCK_BASENAME,
                flags | os.O_CREAT | os.O_EXCL,
                0o600,
                dir_fd=tree.lib.descriptor,
            )
            created = True
        except FileExistsError:
            try:
                descriptor = os.open(
                    LOCK_BASENAME,
                    flags,
                    dir_fd=tree.lib.descriptor,
                )
            except OSError as cause:
                _fail("VERIFIER_BOOTSTRAP_LOCK", "state/lock", cause)
        except OSError as cause:
            _fail("VERIFIER_BOOTSTRAP_LOCK", "state/lock", cause)

        try:
            try:
                if created:
                    os.fchown(
                        descriptor,
                        tree.expected_uid,
                        tree.expected_gid,
                    )
                    os.fchmod(descriptor, 0o600)
                    os.fsync(descriptor)
                    os.fsync(tree.lib.descriptor)
                metadata = os.fstat(descriptor)
                if (
                    not stat.S_ISREG(metadata.st_mode)
                    or metadata.st_nlink != 1
                    or metadata.st_uid != tree.expected_uid
                    or metadata.st_gid != tree.expected_gid
                    or stat.S_IMODE(metadata.st_mode) != 0o600
                    or metadata.st_size != 0
                ):
                    _fail("VERIFIER_BOOTSTRAP_LOCK", "state/lock")
                try:
                    fcntl.flock(
                        descriptor,
                        fcntl.LOCK_EX | fcntl.LOCK_NB,
                    )
                except OSError as cause:
                    if cause.errno in (errno.EACCES, errno.EAGAIN):
                        _fail(
                            "VERIFIER_BOOTSTRAP_LOCK",
                            "state/lock",
                        )
                    raise
                metadata_after = os.fstat(descriptor)
                if (
                    _operational_identity(metadata)
                    != _operational_identity(metadata_after)
                ):
                    _fail("VERIFIER_BOOTSTRAP_LOCK", "state/lock")
                _reverify_lock(tree, descriptor)
            except VerifierBootstrapError:
                raise
            except OSError as cause:
                _fail("VERIFIER_BOOTSTRAP_LOCK", "state/lock", cause)
            yield descriptor
        finally:
            if descriptor is not None:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_UN)
                except OSError:
                    pass
                os.close(descriptor)
    finally:
        if directory_locked:
            try:
                fcntl.flock(tree.lib.descriptor, fcntl.LOCK_UN)
            except OSError:
                pass


def _write_all(descriptor, content, code, source_path):
    offset = 0
    try:
        while offset < len(content):
            written = os.write(descriptor, content[offset:])
            if written <= 0:
                raise OSError(errno.EIO, "short write")
            offset += written
    except OSError as cause:
        _fail(code, source_path, cause)


def _create_file(
    directory_descriptor,
    basename,
    content,
    mode,
    tree,
    source_path,
):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(
            basename,
            flags,
            0o600,
            dir_fd=directory_descriptor,
        )
    except OSError as cause:
        _fail("VERIFIER_BOOTSTRAP_TREE", source_path, cause)
    try:
        _write_all(
            descriptor,
            content,
            "VERIFIER_BOOTSTRAP_TREE",
            source_path,
        )
        os.fchown(descriptor, tree.expected_uid, tree.expected_gid)
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_uid != tree.expected_uid
            or metadata.st_gid != tree.expected_gid
            or stat.S_IMODE(metadata.st_mode) != mode
            or metadata.st_size != len(content)
        ):
            _fail("VERIFIER_BOOTSTRAP_TREE", source_path)
        return metadata
    except VerifierBootstrapError:
        raise
    except OSError as cause:
        _fail("VERIFIER_BOOTSTRAP_TREE", source_path, cause)
    finally:
        os.close(descriptor)


def _mkdir_at(parent_descriptor, name, mode, tree, source_path):
    try:
        os.mkdir(name, 0o700, dir_fd=parent_descriptor)
        descriptor = _open_directory(
            name,
            source_path,
            directory_descriptor=parent_descriptor,
        )
        os.fchown(descriptor, tree.expected_uid, tree.expected_gid)
        os.fchmod(descriptor, mode)
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != tree.expected_uid
            or metadata.st_gid != tree.expected_gid
            or stat.S_IMODE(metadata.st_mode) != mode
        ):
            _fail("VERIFIER_BOOTSTRAP_TREE", source_path)
        return descriptor, metadata
    except VerifierBootstrapError:
        raise
    except OSError as cause:
        _fail("VERIFIER_BOOTSTRAP_TREE", source_path, cause)


def _canonical_json(value):
    return (
        json.dumps(
            value,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("ascii")


def _build_receipt(
    *,
    transaction_id,
    candidate_name,
    expected_commit_sha,
    verifier_sha256,
    golden_sha256,
    namespace_metadata,
    install_metadata,
    state_metadata,
    verifier_metadata,
    golden_metadata,
    lock_metadata,
):
    return {
        "candidateName": candidate_name,
        "commitSha": expected_commit_sha,
        "formalName": FORMAL_NAMESPACE,
        "goldenIdentity": _receipt_identity(golden_metadata),
        "goldenSha256": golden_sha256,
        "installDirectoryIdentity": _receipt_identity(install_metadata),
        "lockIdentity": _receipt_identity(lock_metadata),
        "namespaceIdentity": _receipt_identity(namespace_metadata),
        "repository": REPOSITORY,
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "stateDirectoryIdentity": _receipt_identity(state_metadata),
        "transactionId": transaction_id,
        "verifierIdentity": _receipt_identity(verifier_metadata),
        "verifierSha256": verifier_sha256,
    }


def _create_prepared_candidate(
    tree,
    verifier_source,
    golden_source,
    expected_commit_sha,
    *,
    lock_descriptor,
    transaction_id_factory,
):
    transaction_id = transaction_id_factory()
    if (
        not isinstance(transaction_id, str)
        or TRANSACTION_ID_PATTERN.fullmatch(transaction_id) is None
    ):
        _fail("VERIFIER_BOOTSTRAP_STATE", "state/transaction-id")
    candidate_name = f"{CANDIDATE_PREFIX}{transaction_id}"
    namespace_descriptor = None
    install_descriptor = None
    state_descriptor = None
    try:
        _reverify_lock(tree, lock_descriptor)
        try:
            lock_metadata = os.fstat(lock_descriptor)
        except OSError as cause:
            _fail("VERIFIER_BOOTSTRAP_LOCK", "state/lock", cause)
        namespace_descriptor, namespace_metadata = _mkdir_at(
            tree.lib.descriptor,
            candidate_name,
            0o700,
            tree,
            "candidate/namespace",
        )
        os.fsync(tree.lib.descriptor)
        install_descriptor, install_metadata = _mkdir_at(
            namespace_descriptor,
            INSTALL_DIRECTORY,
            0o700,
            tree,
            "candidate/install-directory",
        )
        state_descriptor, state_metadata = _mkdir_at(
            namespace_descriptor,
            STATE_DIRECTORY,
            0o700,
            tree,
            "candidate/state-directory",
        )

        verifier_metadata = _create_file(
            install_descriptor,
            VERIFIER_BASENAME,
            verifier_source.content,
            0o755,
            tree,
            "candidate/verifier",
        )
        golden_metadata = _create_file(
            install_descriptor,
            GOLDEN_BASENAME,
            golden_source.content,
            0o644,
            tree,
            "candidate/golden",
        )
        receipt = _build_receipt(
            transaction_id=transaction_id,
            candidate_name=candidate_name,
            expected_commit_sha=expected_commit_sha,
            verifier_sha256=verifier_source.sha256,
            golden_sha256=golden_source.sha256,
            namespace_metadata=namespace_metadata,
            install_metadata=install_metadata,
            state_metadata=state_metadata,
            verifier_metadata=verifier_metadata,
            golden_metadata=golden_metadata,
            lock_metadata=lock_metadata,
        )
        _create_file(
            state_descriptor,
            RECEIPT_BASENAME,
            _canonical_json(receipt),
            0o600,
            tree,
            "candidate/receipt",
        )
        _create_file(
            state_descriptor,
            PREPARED_BASENAME,
            b"",
            0o600,
            tree,
            "candidate/prepared",
        )

        os.fchmod(install_descriptor, 0o755)
        os.fchmod(namespace_descriptor, 0o755)
        os.fsync(install_descriptor)
        os.fsync(state_descriptor)
        os.fsync(namespace_descriptor)
        os.fsync(tree.lib.descriptor)
        return candidate_name
    except VerifierBootstrapError:
        raise
    except OSError as cause:
        _fail("VERIFIER_BOOTSTRAP_TREE", "candidate/create", cause)
    finally:
        for descriptor in (
            state_descriptor,
            install_descriptor,
            namespace_descriptor,
        ):
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass


def _list_directory(descriptor, code, source_path):
    try:
        return tuple(sorted(os.listdir(descriptor)))
    except OSError as cause:
        _fail(code, source_path, cause)


def _discover_state(tree):
    names = _list_directory(
        tree.lib.descriptor,
        "VERIFIER_BOOTSTRAP_STATE",
        "state/system-lib",
    )
    candidates = tuple(
        name for name in names if name.startswith(CANDIDATE_PREFIX)
    )
    isolations = tuple(
        name for name in names if name.startswith(ISOLATION_PREFIX)
    )
    unknown_reserved = tuple(
        name
        for name in names
        if name.startswith(".axialmuse-artifact-verifier-")
        and name != LOCK_BASENAME
        and name not in candidates
        and name not in isolations
    )
    formal_present = FORMAL_NAMESPACE in names
    if (
        unknown_reserved
        or isolations
        or len(candidates) > 1
        or (formal_present and candidates)
    ):
        _fail("VERIFIER_BOOTSTRAP_STATE", "state/layout")
    if formal_present:
        return ("formal", FORMAL_NAMESPACE)
    if candidates:
        return ("candidate", candidates[0])
    return ("empty", None)


def _open_file_at(
    directory_descriptor,
    basename,
    source_path,
    *,
    code="VERIFIER_BOOTSTRAP_TREE",
):
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        return os.open(
            basename,
            flags,
            dir_fd=directory_descriptor,
        )
    except OSError as cause:
        _fail(code, source_path, cause)


def _assert_managed_directory(
    descriptor,
    *,
    mode,
    tree,
    source_path,
):
    try:
        metadata = os.fstat(descriptor)
    except OSError as cause:
        _fail("VERIFIER_BOOTSTRAP_TREE", source_path, cause)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != tree.expected_uid
        or metadata.st_gid != tree.expected_gid
        or stat.S_IMODE(metadata.st_mode) != mode
    ):
        _fail("VERIFIER_BOOTSTRAP_TREE", source_path)
    return metadata


def _assert_managed_file(
    descriptor,
    *,
    mode,
    maximum_bytes,
    tree,
    source_path,
):
    content, metadata = _read_all(
        descriptor,
        maximum_bytes,
        "VERIFIER_BOOTSTRAP_TREE",
        source_path,
    )
    if (
        metadata.st_uid != tree.expected_uid
        or metadata.st_gid != tree.expected_gid
        or stat.S_IMODE(metadata.st_mode) != mode
    ):
        _fail("VERIFIER_BOOTSTRAP_TREE", source_path)
    return content, metadata


def _parse_receipt(content):
    try:
        value = json.loads(content.decode("ascii"))
    except (UnicodeDecodeError, json.JSONDecodeError) as cause:
        _fail("VERIFIER_BOOTSTRAP_RECEIPT", "state/receipt", cause)
    expected_keys = tuple(
        sorted(
            (
                "candidateName",
                "commitSha",
                "formalName",
                "goldenIdentity",
                "goldenSha256",
                "installDirectoryIdentity",
                "lockIdentity",
                "namespaceIdentity",
                "repository",
                "schemaVersion",
                "stateDirectoryIdentity",
                "transactionId",
                "verifierIdentity",
                "verifierSha256",
            )
        )
    )
    if not isinstance(value, dict) or tuple(value.keys()) != expected_keys:
        _fail("VERIFIER_BOOTSTRAP_RECEIPT", "state/receipt")
    transaction_id = value["transactionId"]
    if (
        value["schemaVersion"] != RECEIPT_SCHEMA_VERSION
        or value["repository"] != REPOSITORY
        or value["formalName"] != FORMAL_NAMESPACE
        or not isinstance(transaction_id, str)
        or TRANSACTION_ID_PATTERN.fullmatch(transaction_id) is None
        or value["candidateName"] != f"{CANDIDATE_PREFIX}{transaction_id}"
        or HEX_40_PATTERN.fullmatch(value["commitSha"]) is None
        or HEX_64_PATTERN.fullmatch(value["verifierSha256"]) is None
        or HEX_64_PATTERN.fullmatch(value["goldenSha256"]) is None
    ):
        _fail("VERIFIER_BOOTSTRAP_RECEIPT", "state/receipt")
    for field in (
        "namespaceIdentity",
        "installDirectoryIdentity",
        "stateDirectoryIdentity",
        "verifierIdentity",
        "goldenIdentity",
        "lockIdentity",
    ):
        identity = value[field]
        if (
            not isinstance(identity, dict)
            or tuple(identity.keys()) != ("device", "inode")
            or not isinstance(identity["device"], int)
            or identity["device"] < 0
            or not isinstance(identity["inode"], int)
            or identity["inode"] <= 0
        ):
            _fail("VERIFIER_BOOTSTRAP_RECEIPT", "state/receipt")
    if content != _canonical_json(value):
        _fail("VERIFIER_BOOTSTRAP_RECEIPT", "state/receipt")
    return value


def _identity_matches(metadata, receipt_identity):
    return _receipt_identity(metadata) == receipt_identity


def _assert_receipt_lock_identity(receipt, lock_descriptor):
    try:
        metadata = os.fstat(lock_descriptor)
    except OSError as cause:
        _fail("VERIFIER_BOOTSTRAP_LOCK", "state/lock-identity", cause)
    if not _identity_matches(metadata, receipt["lockIdentity"]):
        _fail("VERIFIER_BOOTSTRAP_LOCK", "state/lock-identity")


def _open_transaction(
    tree,
    name,
    *,
    expected_commit_sha,
    expected_verifier_sha256,
    expected_golden_sha256,
    lock_descriptor,
):
    descriptors = []
    try:
        namespace_descriptor = _open_directory(
            name,
            "transaction/namespace",
            directory_descriptor=tree.lib.descriptor,
        )
        descriptors.append(namespace_descriptor)
        namespace_metadata = _assert_managed_directory(
            namespace_descriptor,
            mode=0o755,
            tree=tree,
            source_path="transaction/namespace",
        )
        if _list_directory(
            namespace_descriptor,
            "VERIFIER_BOOTSTRAP_TREE",
            "transaction/namespace",
        ) != (STATE_DIRECTORY, INSTALL_DIRECTORY):
            _fail("VERIFIER_BOOTSTRAP_TREE", "transaction/namespace")

        install_descriptor = _open_directory(
            INSTALL_DIRECTORY,
            "transaction/install-directory",
            directory_descriptor=namespace_descriptor,
        )
        descriptors.append(install_descriptor)
        install_metadata = _assert_managed_directory(
            install_descriptor,
            mode=0o755,
            tree=tree,
            source_path="transaction/install-directory",
        )
        if _list_directory(
            install_descriptor,
            "VERIFIER_BOOTSTRAP_TREE",
            "transaction/install-directory",
        ) != (GOLDEN_BASENAME, VERIFIER_BASENAME):
            _fail("VERIFIER_BOOTSTRAP_TREE", "transaction/install-directory")

        state_descriptor = _open_directory(
            STATE_DIRECTORY,
            "transaction/state-directory",
            directory_descriptor=namespace_descriptor,
        )
        descriptors.append(state_descriptor)
        state_metadata = _assert_managed_directory(
            state_descriptor,
            mode=0o700,
            tree=tree,
            source_path="transaction/state-directory",
        )
        state_members = _list_directory(
            state_descriptor,
            "VERIFIER_BOOTSTRAP_TREE",
            "transaction/state-directory",
        )
        prepared_members = (PREPARED_BASENAME, RECEIPT_BASENAME)
        committed_members = (COMMITTED_BASENAME, RECEIPT_BASENAME)
        if state_members == prepared_members:
            marker_name = PREPARED_BASENAME
        elif state_members == committed_members:
            marker_name = COMMITTED_BASENAME
        else:
            _fail("VERIFIER_BOOTSTRAP_STATE", "transaction/state-marker")

        verifier_descriptor = _open_file_at(
            install_descriptor,
            VERIFIER_BASENAME,
            "transaction/verifier",
        )
        descriptors.append(verifier_descriptor)
        golden_descriptor = _open_file_at(
            install_descriptor,
            GOLDEN_BASENAME,
            "transaction/golden",
        )
        descriptors.append(golden_descriptor)
        receipt_descriptor = _open_file_at(
            state_descriptor,
            RECEIPT_BASENAME,
            "transaction/receipt",
        )
        descriptors.append(receipt_descriptor)
        marker_descriptor = _open_file_at(
            state_descriptor,
            marker_name,
            "transaction/state-marker",
        )
        descriptors.append(marker_descriptor)

        verifier_content, verifier_metadata = _assert_managed_file(
            verifier_descriptor,
            mode=0o755,
            maximum_bytes=MAX_VERIFIER_BYTES,
            tree=tree,
            source_path="transaction/verifier",
        )
        golden_content, golden_metadata = _assert_managed_file(
            golden_descriptor,
            mode=0o644,
            maximum_bytes=MAX_GOLDEN_BYTES,
            tree=tree,
            source_path="transaction/golden",
        )
        receipt_content, _receipt_metadata = _assert_managed_file(
            receipt_descriptor,
            mode=0o600,
            maximum_bytes=MAX_RECEIPT_BYTES,
            tree=tree,
            source_path="transaction/receipt",
        )
        marker_content, _marker_metadata = _assert_managed_file(
            marker_descriptor,
            mode=0o600,
            maximum_bytes=0,
            tree=tree,
            source_path="transaction/state-marker",
        )
        if marker_content != b"":
            _fail("VERIFIER_BOOTSTRAP_STATE", "transaction/state-marker")

        receipt = _parse_receipt(receipt_content)
        if (
            receipt["commitSha"] != expected_commit_sha
            or receipt["verifierSha256"] != expected_verifier_sha256
            or receipt["goldenSha256"] != expected_golden_sha256
            or (
                name != FORMAL_NAMESPACE
                and name != receipt["candidateName"]
                and name
                != f"{ISOLATION_PREFIX}{receipt['transactionId']}"
            )
            or hashlib.sha256(verifier_content).hexdigest()
            != expected_verifier_sha256
            or hashlib.sha256(golden_content).hexdigest()
            != expected_golden_sha256
            or not _identity_matches(
                namespace_metadata,
                receipt["namespaceIdentity"],
            )
            or not _identity_matches(
                install_metadata,
                receipt["installDirectoryIdentity"],
            )
            or not _identity_matches(
                state_metadata,
                receipt["stateDirectoryIdentity"],
            )
            or not _identity_matches(
                verifier_metadata,
                receipt["verifierIdentity"],
            )
            or not _identity_matches(
                golden_metadata,
                receipt["goldenIdentity"],
            )
            or any(
                metadata.st_dev != os.fstat(tree.lib.descriptor).st_dev
                for metadata in (
                    namespace_metadata,
                    install_metadata,
                    state_metadata,
                    verifier_metadata,
                    golden_metadata,
                    _receipt_metadata,
                    _marker_metadata,
                )
            )
        ):
            _fail("VERIFIER_BOOTSTRAP_RECEIPT", "transaction/receipt")
        _reverify_lock(tree, lock_descriptor)
        _assert_receipt_lock_identity(receipt, lock_descriptor)

        return OpenTransaction(
            name=name,
            marker_name=marker_name,
            receipt=receipt,
            namespace_descriptor=namespace_descriptor,
            install_descriptor=install_descriptor,
            state_descriptor=state_descriptor,
            verifier_descriptor=verifier_descriptor,
            golden_descriptor=golden_descriptor,
            receipt_descriptor=receipt_descriptor,
            marker_descriptor=marker_descriptor,
            namespace_operational_identity=_operational_identity(
                namespace_metadata
            ),
            verifier_operational_identity=_operational_identity(
                verifier_metadata
            ),
            golden_operational_identity=_operational_identity(
                golden_metadata
            ),
            receipt_operational_identity=_operational_identity(
                _receipt_metadata
            ),
            marker_operational_identity=_operational_identity(
                _marker_metadata
            ),
            descriptors=tuple(descriptors),
        )
    except BaseException:
        for descriptor in reversed(descriptors):
            try:
                os.close(descriptor)
            except OSError:
                pass
        raise


def _assert_path_identity(parent_descriptor, basename, held_descriptor, source_path):
    descriptor = _open_file_at(parent_descriptor, basename, source_path)
    try:
        if (
            os.fstat(descriptor).st_dev,
            os.fstat(descriptor).st_ino,
        ) != (
            os.fstat(held_descriptor).st_dev,
            os.fstat(held_descriptor).st_ino,
        ):
            _fail("VERIFIER_BOOTSTRAP_TREE", source_path)
    finally:
        os.close(descriptor)


def _default_self_test_runner(system_python, verifier_path):
    process = None
    try:
        process = subprocess.Popen(
            [
                system_python,
                "-I",
                "-B",
                str(verifier_path),
                "--self-test",
            ],
            cwd="/",
            env={
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                "PATH": "/usr/bin:/bin",
            },
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            close_fds=True,
            start_new_session=True,
        )
        streams = {
            process.stdout: bytearray(),
            process.stderr: bytearray(),
        }
        selector = selectors.DefaultSelector()
        try:
            for stream in streams:
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ)
            deadline = time.monotonic() + SELF_TEST_TIMEOUT_SECONDS
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(
                        process.args,
                        SELF_TEST_TIMEOUT_SECONDS,
                    )
                events = selector.select(min(remaining, 0.25))
                if not events and process.poll() is not None:
                    continue
                for key, _mask in events:
                    stream = key.fileobj
                    try:
                        chunk = os.read(stream.fileno(), 64 * 1024)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(stream)
                        continue
                    streams[stream].extend(chunk)
                    if (
                        len(streams[stream])
                        > MAX_SELF_TEST_OUTPUT_BYTES
                    ):
                        raise ValueError("self-test output limit")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(
                    process.args,
                    SELF_TEST_TIMEOUT_SECONDS,
                )
            return_code = process.wait(timeout=remaining)
            standard_output = bytes(streams[process.stdout])
            standard_error = bytes(streams[process.stderr])
        finally:
            selector.close()
    except BaseException as cause:
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except OSError:
                pass
            try:
                if process.poll() is None:
                    process.wait(timeout=1)
            except BaseException:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except OSError:
                    pass
                try:
                    process.wait(timeout=5)
                except BaseException:
                    pass
        if isinstance(cause, VerifierBootstrapError):
            raise
        _fail("VERIFIER_BOOTSTRAP_SELF_TEST", "self-test/process", cause)
    finally:
        if process is not None:
            for stream in (process.stdout, process.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
    if (
        return_code != 0
        or standard_error != b""
        or not standard_output.endswith(b"\n")
        or standard_output.count(b"\n") != 1
        or len(standard_output) > MAX_SELF_TEST_OUTPUT_BYTES
    ):
        _fail("VERIFIER_BOOTSTRAP_SELF_TEST", "self-test/result")
    try:
        value = json.loads(standard_output.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as cause:
        _fail("VERIFIER_BOOTSTRAP_SELF_TEST", "self-test/result", cause)
    if (
        not isinstance(value, dict)
        or tuple(value.keys())
        != ("schemaVersion", "wireMagic", "vectorCount")
        or value["schemaVersion"] != SELF_TEST_SCHEMA_VERSION
        or value["wireMagic"] != FILE_TREE_WIRE_MAGIC
        or not isinstance(value["vectorCount"], int)
        or value["vectorCount"] <= 0
    ):
        _fail("VERIFIER_BOOTSTRAP_SELF_TEST", "self-test/result")
    return value


def _revalidate_transaction(
    tree,
    transaction,
    *,
    expected_commit_sha,
    expected_verifier_sha256,
    expected_golden_sha256,
    system_python,
    self_test_runner,
    lock_descriptor,
    run_self_test=True,
):
    _assert_receipt_lock_identity(transaction.receipt, lock_descriptor)
    current = _open_transaction(
        tree,
        transaction.name,
        expected_commit_sha=expected_commit_sha,
        expected_verifier_sha256=expected_verifier_sha256,
        expected_golden_sha256=expected_golden_sha256,
        lock_descriptor=lock_descriptor,
    )
    try:
        if (
            current.receipt != transaction.receipt
            or current.marker_name != transaction.marker_name
            or _operational_identity(
                os.fstat(transaction.namespace_descriptor)
            )
            != transaction.namespace_operational_identity
            or _operational_identity(
                os.fstat(transaction.verifier_descriptor)
            )
            != transaction.verifier_operational_identity
            or _operational_identity(
                os.fstat(transaction.golden_descriptor)
            )
            != transaction.golden_operational_identity
            or _operational_identity(
                os.fstat(transaction.receipt_descriptor)
            )
            != transaction.receipt_operational_identity
            or _operational_identity(
                os.fstat(transaction.marker_descriptor)
            )
            != transaction.marker_operational_identity
            or os.fstat(current.namespace_descriptor).st_dev
            != os.fstat(transaction.namespace_descriptor).st_dev
            or os.fstat(current.namespace_descriptor).st_ino
            != os.fstat(transaction.namespace_descriptor).st_ino
            or os.fstat(current.verifier_descriptor).st_dev
            != os.fstat(transaction.verifier_descriptor).st_dev
            or os.fstat(current.verifier_descriptor).st_ino
            != os.fstat(transaction.verifier_descriptor).st_ino
            or os.fstat(current.golden_descriptor).st_dev
            != os.fstat(transaction.golden_descriptor).st_dev
            or os.fstat(current.golden_descriptor).st_ino
            != os.fstat(transaction.golden_descriptor).st_ino
        ):
            _fail("VERIFIER_BOOTSTRAP_TREE", "transaction/identity")
    finally:
        current.close()
    _assert_path_identity(
        transaction.install_descriptor,
        VERIFIER_BASENAME,
        transaction.verifier_descriptor,
        "transaction/verifier",
    )
    _assert_path_identity(
        transaction.install_descriptor,
        GOLDEN_BASENAME,
        transaction.golden_descriptor,
        "transaction/golden",
    )
    if run_self_test:
        self_test_runner(
            system_python,
            tree.lib_path
            / transaction.name
            / INSTALL_DIRECTORY
            / VERIFIER_BASENAME,
        )
        _revalidate_transaction(
            tree,
            transaction,
            expected_commit_sha=expected_commit_sha,
            expected_verifier_sha256=expected_verifier_sha256,
            expected_golden_sha256=expected_golden_sha256,
            system_python=system_python,
            self_test_runner=self_test_runner,
            lock_descriptor=lock_descriptor,
            run_self_test=False,
        )


def _rename_noreplace_at(
    source_directory_descriptor,
    source_name,
    target_directory_descriptor,
    target_name,
    *,
    code,
    source_path,
):
    try:
        library = ctypes.CDLL(None, use_errno=True)
        renameat2 = library.renameat2
        renameat2.argtypes = (
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        )
        renameat2.restype = ctypes.c_int
        result = renameat2(
            source_directory_descriptor,
            os.fsencode(source_name),
            target_directory_descriptor,
            os.fsencode(target_name),
            RENAME_NOREPLACE,
        )
        if result != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number))
    except (AttributeError, OSError) as cause:
        _fail(code, source_path, cause)


@contextlib.contextmanager
def _block_interrupts():
    try:
        previous_mask = signal.pthread_sigmask(
            signal.SIG_BLOCK,
            INTERRUPT_SIGNALS,
        )
    except (AttributeError, OSError, ValueError) as cause:
        _fail("VERIFIER_BOOTSTRAP_RUNTIME", "runtime/signal-mask", cause)
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


def _sync_commit_descriptor(descriptor, source_path):
    try:
        os.fsync(descriptor)
    except OSError as cause:
        _fail("VERIFIER_BOOTSTRAP_COMMIT", source_path, cause)


def _commit_marker(transaction):
    _rename_noreplace_at(
        transaction.state_descriptor,
        PREPARED_BASENAME,
        transaction.state_descriptor,
        COMMITTED_BASENAME,
        code="VERIFIER_BOOTSTRAP_COMMIT",
        source_path="commit/state-marker",
    )
    transaction.marker_name = COMMITTED_BASENAME
    transaction.marker_operational_identity = _operational_identity(
        os.fstat(transaction.marker_descriptor)
    )
    _sync_commit_descriptor(
        transaction.state_descriptor,
        "commit/state-directory",
    )


def _isolate_transaction(
    tree,
    transaction,
    *,
    expected_commit_sha,
    expected_verifier_sha256,
    expected_golden_sha256,
    system_python,
    self_test_runner,
    lock_descriptor,
):
    isolation_name = (
        f"{ISOLATION_PREFIX}{transaction.receipt['transactionId']}"
    )
    try:
        _revalidate_transaction(
            tree,
            transaction,
            expected_commit_sha=expected_commit_sha,
            expected_verifier_sha256=expected_verifier_sha256,
            expected_golden_sha256=expected_golden_sha256,
            system_python=system_python,
            self_test_runner=self_test_runner,
            lock_descriptor=lock_descriptor,
            run_self_test=False,
        )
        os.fchmod(transaction.namespace_descriptor, 0o700)
        os.fsync(transaction.namespace_descriptor)
        transaction.namespace_operational_identity = _operational_identity(
            os.fstat(transaction.namespace_descriptor)
        )
        _rename_noreplace_at(
            tree.lib.descriptor,
            transaction.name,
            tree.lib.descriptor,
            isolation_name,
            code="VERIFIER_BOOTSTRAP_ISOLATE",
            source_path="isolate/namespace",
        )
        transaction.name = isolation_name
        os.fsync(tree.lib.descriptor)
    except VerifierBootstrapError as cause:
        if cause.code == "VERIFIER_BOOTSTRAP_ISOLATE":
            raise
        _fail("VERIFIER_BOOTSTRAP_ISOLATE", "isolate/namespace", cause)
    except OSError as cause:
        _fail("VERIFIER_BOOTSTRAP_ISOLATE", "isolate/namespace", cause)


def _result_for(receipt, disposition):
    return {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "status": "committed",
        "disposition": disposition,
        "transactionId": receipt["transactionId"],
        "commitSha": receipt["commitSha"],
        "verifierSha256": receipt["verifierSha256"],
        "goldenSha256": receipt["goldenSha256"],
    }


def _emit_json_line(stream, value):
    stream.write(
        json.dumps(
            value,
            ensure_ascii=True,
            separators=(",", ":"),
        )
        + "\n"
    )
    stream.flush()


def _finish_committed(
    transaction,
    signal_state,
    success_stream,
    disposition,
):
    signal_state["commitCompleted"] = True
    result = _result_for(transaction.receipt, disposition)
    if success_stream is not None:
        try:
            _emit_json_line(success_stream, result)
        except Exception:
            pass
    return result


def _synchronize_marker_view(transaction, current):
    transaction.marker_name = current.marker_name
    try:
        transaction.marker_operational_identity = _operational_identity(
            os.fstat(transaction.marker_descriptor)
        )
    except OSError as cause:
        _fail("VERIFIER_BOOTSTRAP_COMMIT", "commit/state-marker", cause)


def _recover_commit_transition(
    tree,
    transaction,
    *,
    expected_commit_sha,
    expected_verifier_sha256,
    expected_golden_sha256,
    system_python,
    self_test_runner,
    signal_state,
    success_stream,
    lock_descriptor,
):
    recovered_kind, recovered_name = _discover_state(tree)
    if (
        recovered_kind != "formal"
        or recovered_name != FORMAL_NAMESPACE
    ):
        _fail("VERIFIER_BOOTSTRAP_COMMIT", "commit/recovery-layout")
    recovered = _open_transaction(
        tree,
        FORMAL_NAMESPACE,
        expected_commit_sha=expected_commit_sha,
        expected_verifier_sha256=expected_verifier_sha256,
        expected_golden_sha256=expected_golden_sha256,
        lock_descriptor=lock_descriptor,
    )
    try:
        _synchronize_marker_view(transaction, recovered)
        _revalidate_transaction(
            tree,
            recovered,
            expected_commit_sha=expected_commit_sha,
            expected_verifier_sha256=expected_verifier_sha256,
            expected_golden_sha256=expected_golden_sha256,
            system_python=system_python,
            self_test_runner=self_test_runner,
            lock_descriptor=lock_descriptor,
        )
        _sync_commit_descriptor(
            tree.lib.descriptor,
            "commit/recovery-parent",
        )
        if recovered.marker_name == PREPARED_BASENAME:
            _reverify_system_tree(tree)
            _reverify_lock(tree, lock_descriptor)
            state_kind, state_name = _discover_state(tree)
            if (
                state_kind != "formal"
                or state_name != FORMAL_NAMESPACE
            ):
                _fail(
                    "VERIFIER_BOOTSTRAP_STATE",
                    "commit/recovery-layout",
                )
            _revalidate_transaction(
                tree,
                recovered,
                expected_commit_sha=expected_commit_sha,
                expected_verifier_sha256=expected_verifier_sha256,
                expected_golden_sha256=expected_golden_sha256,
                system_python=system_python,
                self_test_runner=self_test_runner,
                lock_descriptor=lock_descriptor,
                run_self_test=False,
            )
            try:
                _commit_marker(recovered)
            finally:
                _synchronize_marker_view(transaction, recovered)
        elif recovered.marker_name == COMMITTED_BASENAME:
            _sync_commit_descriptor(
                recovered.state_descriptor,
                "commit/recovery-state",
            )
        else:
            _fail(
                "VERIFIER_BOOTSTRAP_STATE",
                "commit/recovery-marker",
            )
        return _finish_committed(
            recovered,
            signal_state,
            success_stream,
            "recovered",
        )
    finally:
        recovered.close()


def _resume_transaction(
    tree,
    transaction,
    *,
    expected_commit_sha,
    expected_verifier_sha256,
    expected_golden_sha256,
    system_python,
    self_test_runner,
    signal_state,
    success_stream,
    lock_descriptor,
    disposition,
):
    _revalidate_transaction(
        tree,
        transaction,
        expected_commit_sha=expected_commit_sha,
        expected_verifier_sha256=expected_verifier_sha256,
        expected_golden_sha256=expected_golden_sha256,
        system_python=system_python,
        self_test_runner=self_test_runner,
        lock_descriptor=lock_descriptor,
    )

    if (
        transaction.name == FORMAL_NAMESPACE
        and transaction.marker_name == COMMITTED_BASENAME
    ):
        _reverify_system_tree(tree)
        _reverify_lock(tree, lock_descriptor)
        _sync_commit_descriptor(
            transaction.state_descriptor,
            "commit/recovery-state",
        )
        _sync_commit_descriptor(
            tree.lib.descriptor,
            "commit/recovery-parent",
        )
        return _finish_committed(
            transaction,
            signal_state,
            success_stream,
            disposition,
        )

    with _block_interrupts():
        commit_transition_started = False
        try:
            _reverify_system_tree(tree)
            _reverify_lock(tree, lock_descriptor)
            if transaction.name != FORMAL_NAMESPACE:
                state_kind, state_name = _discover_state(tree)
                if state_kind != "candidate" or state_name != transaction.name:
                    _fail("VERIFIER_BOOTSTRAP_STATE", "commit/preflight")
                _rename_noreplace_at(
                    tree.lib.descriptor,
                    transaction.name,
                    tree.lib.descriptor,
                    FORMAL_NAMESPACE,
                    code="VERIFIER_BOOTSTRAP_COMMIT",
                    source_path="commit/namespace",
                )
                transaction.name = FORMAL_NAMESPACE
                transaction.namespace_operational_identity = (
                    _operational_identity(
                        os.fstat(transaction.namespace_descriptor)
                    )
                )
                _sync_commit_descriptor(
                    tree.lib.descriptor,
                    "commit/namespace-parent",
                )
                _revalidate_transaction(
                    tree,
                    transaction,
                    expected_commit_sha=expected_commit_sha,
                    expected_verifier_sha256=expected_verifier_sha256,
                    expected_golden_sha256=expected_golden_sha256,
                    system_python=system_python,
                    self_test_runner=self_test_runner,
                    lock_descriptor=lock_descriptor,
                )
            else:
                _sync_commit_descriptor(
                    tree.lib.descriptor,
                    "commit/namespace-parent",
                )

            state_kind, state_name = _discover_state(tree)
            if state_kind != "formal" or state_name != FORMAL_NAMESPACE:
                _fail("VERIFIER_BOOTSTRAP_STATE", "commit/final-layout")

            if transaction.marker_name == PREPARED_BASENAME:
                _reverify_system_tree(tree)
                _reverify_lock(tree, lock_descriptor)
                _revalidate_transaction(
                    tree,
                    transaction,
                    expected_commit_sha=expected_commit_sha,
                    expected_verifier_sha256=expected_verifier_sha256,
                    expected_golden_sha256=expected_golden_sha256,
                    system_python=system_python,
                    self_test_runner=self_test_runner,
                    lock_descriptor=lock_descriptor,
                    run_self_test=False,
                )
                commit_transition_started = True
                _commit_marker(transaction)
            elif transaction.marker_name == COMMITTED_BASENAME:
                commit_transition_started = True
                _sync_commit_descriptor(
                    transaction.state_descriptor,
                    "commit/recovery-state",
                )
            else:
                _fail("VERIFIER_BOOTSTRAP_STATE", "commit/state-marker")
            return _finish_committed(
                transaction,
                signal_state,
                success_stream,
                disposition,
            )
        except VerifierBootstrapError as error:
            if signal_state["commitCompleted"]:
                return _finish_committed(
                    transaction,
                    signal_state,
                    success_stream,
                    disposition,
                )
            if not commit_transition_started:
                raise error
            return _recover_commit_transition(
                tree,
                transaction,
                expected_commit_sha=expected_commit_sha,
                expected_verifier_sha256=expected_verifier_sha256,
                expected_golden_sha256=expected_golden_sha256,
                system_python=system_python,
                self_test_runner=self_test_runner,
                signal_state=signal_state,
                success_stream=success_stream,
                lock_descriptor=lock_descriptor,
            )


def bootstrap_artifact_verifier(
    *,
    source_root,
    expected_commit_sha,
    expected_verifier_sha256,
    expected_golden_sha256,
    success_stream=None,
    _root_path="/",
    _expected_uid=0,
    _expected_gid=0,
    _system_python="/usr/bin/python3",
    _self_test_runner=_default_self_test_runner,
    _transaction_id_factory=lambda: secrets.token_hex(16),
    _enforce_runtime=True,
    _signal_state=None,
):
    if _enforce_runtime:
        _assert_runtime()
    expected_commit_sha = _assert_hex(
        expected_commit_sha,
        HEX_40_PATTERN,
        "arguments/commit-sha",
    )
    expected_verifier_sha256 = _assert_hex(
        expected_verifier_sha256,
        HEX_64_PATTERN,
        "arguments/verifier-sha256",
    )
    expected_golden_sha256 = _assert_hex(
        expected_golden_sha256,
        HEX_64_PATTERN,
        "arguments/golden-sha256",
    )
    signal_state = (
        {"commitCompleted": False}
        if _signal_state is None
        else _signal_state
    )

    verifier_source, golden_source = _capture_sources(
        source_root,
        expected_verifier_sha256,
        expected_golden_sha256,
    )

    with _open_system_tree(
        _root_path,
        expected_uid=_expected_uid,
        expected_gid=_expected_gid,
    ) as tree:
        with _acquire_lock(tree) as lock_descriptor:
            _reverify_system_tree(tree)
            _reverify_lock(tree, lock_descriptor)
            state_kind, state_name = _discover_state(tree)
            if state_kind == "empty":
                disposition = "installed"
                state_name = _create_prepared_candidate(
                    tree,
                    verifier_source,
                    golden_source,
                    expected_commit_sha,
                    lock_descriptor=lock_descriptor,
                    transaction_id_factory=_transaction_id_factory,
                )
                state_kind = "candidate"
            elif state_kind == "formal":
                disposition = "recovered"
            else:
                disposition = "recovered"
            if state_kind not in ("candidate", "formal") or state_name is None:
                _fail("VERIFIER_BOOTSTRAP_STATE", "state/layout")

            transaction = _open_transaction(
                tree,
                state_name,
                expected_commit_sha=expected_commit_sha,
                expected_verifier_sha256=expected_verifier_sha256,
                expected_golden_sha256=expected_golden_sha256,
                lock_descriptor=lock_descriptor,
            )
            if (
                state_kind == "formal"
                and transaction.marker_name == COMMITTED_BASENAME
            ):
                disposition = "already-committed"
            try:
                try:
                    return _resume_transaction(
                        tree,
                        transaction,
                        expected_commit_sha=expected_commit_sha,
                        expected_verifier_sha256=expected_verifier_sha256,
                        expected_golden_sha256=expected_golden_sha256,
                        system_python=_system_python,
                        self_test_runner=_self_test_runner,
                        signal_state=signal_state,
                        success_stream=success_stream,
                        lock_descriptor=lock_descriptor,
                        disposition=disposition,
                    )
                except VerifierBootstrapError:
                    if (
                        not signal_state["commitCompleted"]
                        and transaction.marker_name == PREPARED_BASENAME
                        and not transaction.name.startswith(ISOLATION_PREFIX)
                    ):
                        with _block_interrupts():
                            _isolate_transaction(
                                tree,
                                transaction,
                                expected_commit_sha=expected_commit_sha,
                                expected_verifier_sha256=(
                                    expected_verifier_sha256
                                ),
                                expected_golden_sha256=(
                                    expected_golden_sha256
                                ),
                                system_python=_system_python,
                                self_test_runner=_self_test_runner,
                                lock_descriptor=lock_descriptor,
                            )
                    raise
            finally:
                transaction.close()


def _parse_cli_arguments(arguments):
    expected_flags = (
        "--source-root",
        "--expected-commit-sha",
        "--expected-verifier-sha256",
        "--expected-golden-sha256",
    )
    if len(arguments) != len(expected_flags) * 2:
        _fail("VERIFIER_BOOTSTRAP_ARGUMENT", "arguments")
    values = {}
    for index, expected_flag in enumerate(expected_flags):
        flag = arguments[index * 2]
        value = arguments[index * 2 + 1]
        if flag != expected_flag or not isinstance(value, str) or not value:
            _fail("VERIFIER_BOOTSTRAP_ARGUMENT", "arguments")
        values[expected_flag] = value
    return values


def _install_signal_handlers():
    previous = {}
    state = {"commitCompleted": False}

    def interrupt_handler(_signal_number, _frame):
        if state["commitCompleted"]:
            return
        _fail("VERIFIER_BOOTSTRAP_INTERRUPTED", "process/signal")

    for signal_number in INTERRUPT_SIGNALS:
        previous[signal_number] = signal.signal(
            signal_number,
            interrupt_handler,
        )
    return previous, state


def _restore_signal_handlers(previous):
    for signal_number, handler in previous.items():
        signal.signal(signal_number, handler)


def main(arguments=None):
    arguments = list(sys.argv[1:] if arguments is None else arguments)
    previous_handlers = {}
    signal_state = {"commitCompleted": False}
    try:
        previous_handlers, signal_state = _install_signal_handlers()
        values = _parse_cli_arguments(arguments)
        bootstrap_artifact_verifier(
            source_root=values["--source-root"],
            expected_commit_sha=values["--expected-commit-sha"],
            expected_verifier_sha256=values[
                "--expected-verifier-sha256"
            ],
            expected_golden_sha256=values[
                "--expected-golden-sha256"
            ],
            success_stream=sys.stdout,
            _signal_state=signal_state,
        )
        return 0
    except VerifierBootstrapError as error:
        if signal_state["commitCompleted"]:
            return 0
        try:
            sys.stderr.write(f"{format_verifier_bootstrap_error(error)}\n")
            sys.stderr.flush()
        except Exception:
            pass
        return 1
    except BaseException:
        if signal_state["commitCompleted"]:
            return 0
        try:
            sys.stderr.write(
                "[VERIFIER_BOOTSTRAP_INTERNAL] "
                "verifier bootstrap 发生未分类错误；底层细节已抑制。\n"
            )
            sys.stderr.flush()
        except Exception:
            pass
        return 1
    finally:
        if previous_handlers:
            try:
                _restore_signal_handlers(previous_handlers)
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())

import contextlib
import ctypes
import errno
import hashlib
import importlib.util
import json
import os
import re
import secrets
import signal
import stat
import sys
from dataclasses import dataclass
from pathlib import Path


BOOTSTRAP_PATH = Path(__file__).resolve().with_name(
    "bootstrap_artifact_verifier.py"
)
BOOTSTRAP_SPEC = importlib.util.spec_from_file_location(
    "axial_muse_artifact_verifier_bootstrap_for_upgrade",
    BOOTSTRAP_PATH,
)
if BOOTSTRAP_SPEC is None or BOOTSTRAP_SPEC.loader is None:
    raise RuntimeError("无法加载 artifact verifier bootstrap 依赖。")
BOOTSTRAP = importlib.util.module_from_spec(BOOTSTRAP_SPEC)
BOOTSTRAP_SPEC.loader.exec_module(BOOTSTRAP)


SCHEMA_VERSION = "1.0.0"
MANIFEST_SCHEMA_VERSION = "1.0.0"
REPOSITORY = "lyty1997/AxialMuseWebsite"
COMPONENT = "artifact-verifier"
INTERFACE_VERSION = "1.0.0"
SELF_TEST_SCHEMA_VERSION = "1.0.0"
FILE_TREE_WIRE_MAGIC = "AXIALMUSE-FILE-TREE-V1"

FORMAL_NAMESPACE = BOOTSTRAP.FORMAL_NAMESPACE
INSTALL_DIRECTORY = BOOTSTRAP.INSTALL_DIRECTORY
STATE_DIRECTORY = BOOTSTRAP.STATE_DIRECTORY
LOCK_BASENAME = BOOTSTRAP.LOCK_BASENAME
GENESIS_RECEIPT_BASENAME = BOOTSTRAP.RECEIPT_BASENAME
GENESIS_COMMITTED_BASENAME = BOOTSTRAP.COMMITTED_BASENAME
VERIFIER_BASENAME = BOOTSTRAP.VERIFIER_BASENAME
GOLDEN_BASENAME = BOOTSTRAP.GOLDEN_BASENAME
MANIFEST_BASENAME = "artifact-verifier-component.json"
UPGRADE_ROOT_BASENAME = ".artifact-verifier-upgrades"
SLOT_BASENAME = "slot"
RECEIPT_BASENAME = "receipt.json"
PREPARED_BASENAME = "prepared"
COMMITTED_BASENAME = "committed"
ROLLED_BACK_BASENAME = "rolled-back"

MAX_COMPONENT_FILE_BYTES = 8 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
MAX_RECEIPT_BYTES = 256 * 1024
RENAME_NOREPLACE = 1
RENAME_EXCHANGE = 2
INTERRUPT_SIGNALS = frozenset((signal.SIGINT, signal.SIGTERM))

HEX_40_PATTERN = re.compile(r"^[0-9a-f]{40}$", re.ASCII)
HEX_64_PATTERN = re.compile(r"^[0-9a-f]{64}$", re.ASCII)
TRANSACTION_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$", re.ASCII)
EVENT_NAME_PATTERN = re.compile(
    r"^(?P<sequence>[0-9]{8})-(?P<transaction>[0-9a-f]{32})$",
    re.ASCII,
)

EXPECTED_COMPONENT_FILES = (
    (GOLDEN_BASENAME, "0644"),
    (VERIFIER_BASENAME, "0755"),
)

ERROR_MESSAGES = {
    "VERIFIER_UPGRADE_RUNTIME": "verifier upgrader 运行时不符合固定 Ubuntu Python 基线。",
    "VERIFIER_UPGRADE_ARGUMENT": "verifier upgrader 参数不符合固定接口。",
    "VERIFIER_UPGRADE_SOURCE": "升级源目录、文件身份或摘要不合法。",
    "VERIFIER_UPGRADE_MANIFEST": "组件 manifest 不符合固定闭包。",
    "VERIFIER_UPGRADE_STATE": "组件升级事务状态不唯一或不可继续。",
    "VERIFIER_UPGRADE_RECEIPT": "组件升级 receipt 或 lineage 不合法。",
    "VERIFIER_UPGRADE_TREE": "当前、候选或保留组件树不合法。",
    "VERIFIER_UPGRADE_SELF_TEST": "组件自测未通过。",
    "VERIFIER_UPGRADE_COMMIT": "组件升级无法形成持久提交。",
    "VERIFIER_UPGRADE_ROLLED_BACK": "未提交升级已恢复旧组件并记录回滚。",
    "VERIFIER_UPGRADE_OUTCOME_UNKNOWN": "升级状态无法由 receipt 与双路径身份唯一判定。",
    "VERIFIER_UPGRADE_INTERRUPTED": "组件升级在提交前被中断。",
}


class VerifierUpgradeError(Exception):
    def __init__(self, code, source_path, *, cause=None):
        super().__init__(ERROR_MESSAGES.get(code, "verifier 组件升级失败。"))
        self.code = code
        self.source_path = _safe_source_path(source_path)
        self.cause = cause
        self.__traceback__ = None


@dataclass(frozen=True)
class SourceFile:
    basename: str
    content: bytes
    sha256: str


@dataclass(frozen=True)
class HeldSelfTestTarget:
    verifier_descriptor: int
    golden_descriptor: int

    @property
    def inherited_descriptors(self):
        return (self.verifier_descriptor, self.golden_descriptor)

    def __fspath__(self):
        return f"/proc/self/fd/{self.verifier_descriptor}"


@dataclass
class ComponentHandle:
    descriptor: int
    file_descriptors: dict
    directory_identity: dict
    file_identities: dict
    directory_operational_identity: tuple
    file_operational_identities: dict
    descriptors: tuple

    def close(self):
        for descriptor in reversed(self.descriptors):
            try:
                os.close(descriptor)
            except OSError:
                pass


@dataclass
class EventHandle:
    name: str
    descriptor: int
    receipt: dict
    receipt_bytes: bytes
    receipt_sha256: str
    marker: str
    slot: ComponentHandle

    def close(self):
        self.slot.close()
        try:
            os.close(self.descriptor)
        except OSError:
            pass


@dataclass(frozen=True)
class EventBinding:
    name: str
    directory_identity: dict
    receipt_sha256: str
    marker: str
    slot_directory_identity: dict


def _safe_source_path(value):
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 256
        or value.startswith("/")
        or "\\" in value
        or any(ord(character) < 0x20 for character in value)
    ):
        return "upgrade/unknown"
    if any(segment in ("", ".", "..") for segment in value.split("/")):
        return "upgrade/unknown"
    return value


def _fail(code, source_path, cause=None):
    raise VerifierUpgradeError(code, source_path, cause=cause)


def format_verifier_upgrade_error(error):
    if isinstance(error, VerifierUpgradeError):
        return f"[{error.code}] ({error.source_path}) {error}"
    if isinstance(error, BOOTSTRAP.VerifierBootstrapError):
        return BOOTSTRAP.format_verifier_bootstrap_error(error)
    return (
        "[VERIFIER_UPGRADE_INTERNAL] "
        "verifier 组件升级发生未分类错误；底层细节已抑制。"
    )


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


def _strict_json(raw_bytes, code, source_path):
    def reject_duplicate_pairs(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate key")
            value[key] = item
        return value

    try:
        value = json.loads(
            raw_bytes.decode("ascii"),
            object_pairs_hook=reject_duplicate_pairs,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as cause:
        _fail(code, source_path, cause)
    if _canonical_json(value) != raw_bytes:
        _fail(code, source_path)
    return value


def _identity(metadata):
    return {"device": metadata.st_dev, "inode": metadata.st_ino}


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


def _assert_runtime():
    if (
        sys.platform != "linux"
        or sys.version_info[:2] != BOOTSTRAP.EXPECTED_PYTHON
        or os.path.realpath(sys.executable)
        != BOOTSTRAP.EXPECTED_PYTHON_REALPATH
        or os.geteuid() != 0
    ):
        _fail("VERIFIER_UPGRADE_RUNTIME", "runtime/python")


def _assert_hex(value, pattern, source_path):
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        _fail("VERIFIER_UPGRADE_ARGUMENT", source_path)
    return value


def _read_file_at(
    parent_descriptor,
    basename,
    *,
    maximum_bytes,
    expected_mode,
    expected_uid,
    expected_gid,
    code,
    source_path,
):
    descriptor = None
    try:
        path_before = os.stat(
            basename,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
        descriptor = os.open(
            basename,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            dir_fd=parent_descriptor,
        )
        before = os.fstat(descriptor)
        if (
            _operational_identity(path_before) != _operational_identity(before)
            or not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_uid != expected_uid
            or before.st_gid != expected_gid
            or stat.S_IMODE(before.st_mode) != expected_mode
            or before.st_size < 0
            or before.st_size > maximum_bytes
        ):
            raise ValueError("file identity is invalid")
        chunks = []
        total = 0
        while total < before.st_size:
            chunk = os.read(
                descriptor,
                min(64 * 1024, before.st_size - total),
            )
            if not chunk:
                raise ValueError("file ended during read")
            chunks.append(chunk)
            total += len(chunk)
        if os.read(descriptor, 1):
            raise ValueError("file grew during read")
        after = os.fstat(descriptor)
        path_after = os.stat(
            basename,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
        if (
            _operational_identity(before) != _operational_identity(after)
            or _operational_identity(after) != _operational_identity(path_after)
            or total != before.st_size
        ):
            raise ValueError("file changed during read")
        return b"".join(chunks), descriptor, after
    except VerifierUpgradeError:
        if descriptor is not None:
            os.close(descriptor)
        raise
    except Exception as cause:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        _fail(code, source_path, cause)


def _validate_component_spec(value, source_path):
    expected_keys = (
        "commitSha",
        "files",
        "interfaceVersion",
        "manifestSha256",
        "provenance",
        "selfTest",
    )
    if not isinstance(value, dict) or tuple(value.keys()) != expected_keys:
        _fail("VERIFIER_UPGRADE_RECEIPT", source_path)
    if (
        HEX_40_PATTERN.fullmatch(value["commitSha"] or "") is None
        or HEX_64_PATTERN.fullmatch(value["manifestSha256"] or "") is None
        or value["provenance"]
        not in ("bootstrap-receipt-v1", "component-manifest-v1")
        or value["interfaceVersion"] != INTERFACE_VERSION
        or value["selfTest"]
        != {
            "schemaVersion": SELF_TEST_SCHEMA_VERSION,
            "wireMagic": FILE_TREE_WIRE_MAGIC,
        }
        or not isinstance(value["files"], list)
        or len(value["files"]) != len(EXPECTED_COMPONENT_FILES)
    ):
        _fail("VERIFIER_UPGRADE_RECEIPT", source_path)
    expected_paths = tuple(path for path, _mode in EXPECTED_COMPONENT_FILES)
    actual_paths = []
    for item in value["files"]:
        if (
            not isinstance(item, dict)
            or tuple(item.keys()) != ("mode", "path", "sha256", "size")
            or item["mode"] not in ("0644", "0755")
            or not isinstance(item["path"], str)
            or HEX_64_PATTERN.fullmatch(item["sha256"] or "") is None
            or not isinstance(item["size"], int)
            or isinstance(item["size"], bool)
            or item["size"] < 0
            or item["size"] > MAX_COMPONENT_FILE_BYTES
        ):
            _fail("VERIFIER_UPGRADE_RECEIPT", source_path)
        actual_paths.append(item["path"])
    if tuple(actual_paths) != expected_paths:
        _fail("VERIFIER_UPGRADE_RECEIPT", source_path)
    for item, (_path, expected_mode) in zip(
        value["files"],
        EXPECTED_COMPONENT_FILES,
        strict=True,
    ):
        if item["mode"] != expected_mode:
            _fail("VERIFIER_UPGRADE_RECEIPT", source_path)
    return value


def _parse_manifest(raw_bytes, expected_sha256, expected_commit_sha):
    if hashlib.sha256(raw_bytes).hexdigest() != expected_sha256:
        _fail("VERIFIER_UPGRADE_MANIFEST", "source/manifest")
    value = _strict_json(
        raw_bytes,
        "VERIFIER_UPGRADE_MANIFEST",
        "source/manifest",
    )
    if (
        not isinstance(value, dict)
        or tuple(value.keys())
        != (
            "component",
            "files",
            "interfaceVersion",
            "repository",
            "schemaVersion",
            "selfTest",
        )
        or value["schemaVersion"] != MANIFEST_SCHEMA_VERSION
        or value["repository"] != REPOSITORY
        or value["component"] != COMPONENT
        or value["interfaceVersion"] != INTERFACE_VERSION
        or value["selfTest"]
        != {
            "schemaVersion": SELF_TEST_SCHEMA_VERSION,
            "wireMagic": FILE_TREE_WIRE_MAGIC,
        }
        or not isinstance(value["files"], list)
        or len(value["files"]) != len(EXPECTED_COMPONENT_FILES)
    ):
        _fail("VERIFIER_UPGRADE_MANIFEST", "source/manifest")
    files = []
    for item, (expected_path, expected_mode) in zip(
        value["files"],
        EXPECTED_COMPONENT_FILES,
        strict=True,
    ):
        if (
            not isinstance(item, dict)
            or tuple(item.keys()) != ("mode", "path", "sha256", "size")
            or item["path"] != expected_path
            or item["mode"] != expected_mode
            or HEX_64_PATTERN.fullmatch(item["sha256"] or "") is None
            or not isinstance(item["size"], int)
            or isinstance(item["size"], bool)
            or item["size"] < 0
            or item["size"] > MAX_COMPONENT_FILE_BYTES
        ):
            _fail("VERIFIER_UPGRADE_MANIFEST", "source/manifest")
        files.append(dict(item))
    return {
        "commitSha": expected_commit_sha,
        "files": files,
        "interfaceVersion": value["interfaceVersion"],
        "manifestSha256": expected_sha256,
        "provenance": "component-manifest-v1",
        "selfTest": dict(value["selfTest"]),
    }


def _capture_sources(
    source_root,
    expected_manifest_sha256,
    expected_commit_sha,
):
    descriptor = None
    file_descriptors = []
    try:
        if (
            not isinstance(source_root, str)
            or not os.path.isabs(source_root)
            or os.path.normpath(source_root) != source_root
            or os.path.realpath(source_root) != source_root
        ):
            _fail("VERIFIER_UPGRADE_ARGUMENT", "source/root")
        path_before = os.lstat(source_root)
        descriptor = os.open(
            source_root,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        )
        held = os.fstat(descriptor)
        expected_members = tuple(
            sorted(
                (MANIFEST_BASENAME, GOLDEN_BASENAME, VERIFIER_BASENAME)
            )
        )
        if (
            not stat.S_ISDIR(held.st_mode)
            or _identity(path_before) != _identity(held)
            or held.st_uid != os.geteuid()
            or stat.S_IMODE(held.st_mode) != 0o700
            or tuple(sorted(os.listdir(descriptor))) != expected_members
        ):
            _fail("VERIFIER_UPGRADE_SOURCE", "source/root")
        manifest_bytes, manifest_descriptor, _metadata = _read_file_at(
            descriptor,
            MANIFEST_BASENAME,
            maximum_bytes=MAX_MANIFEST_BYTES,
            expected_mode=0o600,
            expected_uid=os.geteuid(),
            expected_gid=os.getegid(),
            code="VERIFIER_UPGRADE_SOURCE",
            source_path="source/manifest",
        )
        file_descriptors.append(manifest_descriptor)
        spec = _parse_manifest(
            manifest_bytes,
            expected_manifest_sha256,
            expected_commit_sha,
        )
        sources = {}
        for file_spec in spec["files"]:
            content, file_descriptor, metadata = _read_file_at(
                descriptor,
                file_spec["path"],
                maximum_bytes=MAX_COMPONENT_FILE_BYTES,
                expected_mode=0o600,
                expected_uid=os.geteuid(),
                expected_gid=os.getegid(),
                code="VERIFIER_UPGRADE_SOURCE",
                source_path=f"source/{file_spec['path']}",
            )
            file_descriptors.append(file_descriptor)
            digest = hashlib.sha256(content).hexdigest()
            if (
                digest != file_spec["sha256"]
                or metadata.st_size != file_spec["size"]
            ):
                _fail(
                    "VERIFIER_UPGRADE_SOURCE",
                    f"source/{file_spec['path']}",
                )
            sources[file_spec["path"]] = SourceFile(
                basename=file_spec["path"],
                content=content,
                sha256=digest,
            )
        if tuple(sorted(os.listdir(descriptor))) != expected_members:
            _fail("VERIFIER_UPGRADE_SOURCE", "source/root")
        return spec, sources
    finally:
        for file_descriptor in reversed(file_descriptors):
            try:
                os.close(file_descriptor)
            except OSError:
                pass
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _open_directory_at(
    parent_descriptor,
    basename,
    *,
    mode,
    expected_uid,
    expected_gid,
    code,
    source_path,
):
    descriptor = None
    try:
        path_metadata = os.stat(
            basename,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
        descriptor = os.open(
            basename,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=parent_descriptor,
        )
        held_metadata = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(path_metadata.st_mode)
            or not stat.S_ISDIR(held_metadata.st_mode)
            or _identity(path_metadata) != _identity(held_metadata)
            or held_metadata.st_uid != expected_uid
            or held_metadata.st_gid != expected_gid
            or stat.S_IMODE(held_metadata.st_mode) != mode
        ):
            raise ValueError("directory identity is invalid")
        return descriptor, held_metadata
    except Exception as cause:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if isinstance(cause, VerifierUpgradeError):
            raise
        _fail(code, source_path, cause)


def _open_component(
    parent_descriptor,
    basename,
    spec,
    *,
    expected_uid,
    expected_gid,
    source_path,
):
    descriptors = []
    file_descriptors = {}
    file_identities = {}
    try:
        descriptor, metadata = _open_directory_at(
            parent_descriptor,
            basename,
            mode=0o755,
            expected_uid=expected_uid,
            expected_gid=expected_gid,
            code="VERIFIER_UPGRADE_TREE",
            source_path=source_path,
        )
        descriptors.append(descriptor)
        expected_members = tuple(item["path"] for item in spec["files"])
        if tuple(sorted(os.listdir(descriptor))) != expected_members:
            _fail("VERIFIER_UPGRADE_TREE", source_path)
        for file_spec in spec["files"]:
            content, file_descriptor, file_metadata = _read_file_at(
                descriptor,
                file_spec["path"],
                maximum_bytes=MAX_COMPONENT_FILE_BYTES,
                expected_mode=int(file_spec["mode"], 8),
                expected_uid=expected_uid,
                expected_gid=expected_gid,
                code="VERIFIER_UPGRADE_TREE",
                source_path=f"{source_path}/{file_spec['path']}",
            )
            descriptors.append(file_descriptor)
            file_descriptors[file_spec["path"]] = file_descriptor
            file_identities[file_spec["path"]] = _identity(file_metadata)
            if (
                len(content) != file_spec["size"]
                or hashlib.sha256(content).hexdigest()
                != file_spec["sha256"]
            ):
                _fail(
                    "VERIFIER_UPGRADE_TREE",
                    f"{source_path}/{file_spec['path']}",
                )
        if tuple(sorted(os.listdir(descriptor))) != expected_members:
            _fail("VERIFIER_UPGRADE_TREE", source_path)
        return ComponentHandle(
            descriptor=descriptor,
            file_descriptors=file_descriptors,
            directory_identity=_identity(metadata),
            file_identities=file_identities,
            directory_operational_identity=_operational_identity(metadata),
            file_operational_identities={
                path: _operational_identity(os.fstat(file_descriptor))
                for path, file_descriptor in file_descriptors.items()
            },
            descriptors=tuple(descriptors),
        )
    except BaseException:
        for held_descriptor in reversed(descriptors):
            try:
                os.close(held_descriptor)
            except OSError:
                pass
        raise


def _component_identity(handle):
    return {
        "directory": dict(handle.directory_identity),
        "files": {
            path: dict(identity)
            for path, identity in sorted(handle.file_identities.items())
        },
    }


def _assert_component_identity(handle, expected, source_path):
    if _component_identity(handle) != expected:
        _fail("VERIFIER_UPGRADE_TREE", source_path)


def _read_held_file(descriptor, size, source_path):
    chunks = []
    offset = 0
    try:
        while offset < size:
            chunk = os.pread(descriptor, min(64 * 1024, size - offset), offset)
            if not chunk:
                raise ValueError("file ended during held read")
            chunks.append(chunk)
            offset += len(chunk)
        if os.pread(descriptor, 1, size):
            raise ValueError("file grew during held read")
    except Exception as cause:
        _fail("VERIFIER_UPGRADE_TREE", source_path, cause)
    return b"".join(chunks)


def _reverify_component_handle(
    handle,
    spec,
    expected,
    source_path,
    *,
    allow_directory_metadata_change=False,
):
    _assert_component_identity(handle, expected, source_path)
    try:
        directory_before = os.fstat(handle.descriptor)
        expected_members = tuple(item["path"] for item in spec["files"])
        if (
            _identity(directory_before) != expected["directory"]
            or not stat.S_ISDIR(directory_before.st_mode)
            or stat.S_IMODE(directory_before.st_mode) != 0o755
            or (
                not allow_directory_metadata_change
                and _operational_identity(directory_before)
                != handle.directory_operational_identity
            )
            or tuple(sorted(os.listdir(handle.descriptor))) != expected_members
        ):
            raise ValueError("component directory changed")
        for file_spec in spec["files"]:
            path = file_spec["path"]
            descriptor = handle.file_descriptors[path]
            before = os.fstat(descriptor)
            path_metadata = os.stat(
                path,
                dir_fd=handle.descriptor,
                follow_symlinks=False,
            )
            if (
                _operational_identity(before)
                != handle.file_operational_identities[path]
                or _operational_identity(path_metadata)
                != _operational_identity(before)
                or not stat.S_ISREG(before.st_mode)
                or before.st_nlink != 1
                or before.st_uid != directory_before.st_uid
                or before.st_gid != directory_before.st_gid
                or stat.S_IMODE(before.st_mode) != int(file_spec["mode"], 8)
                or before.st_size != file_spec["size"]
            ):
                raise ValueError("component file changed")
            content = _read_held_file(
                descriptor,
                file_spec["size"],
                f"{source_path}/{path}",
            )
            after = os.fstat(descriptor)
            rebound = os.stat(
                path,
                dir_fd=handle.descriptor,
                follow_symlinks=False,
            )
            if (
                hashlib.sha256(content).hexdigest() != file_spec["sha256"]
                or _operational_identity(after)
                != handle.file_operational_identities[path]
                or _operational_identity(rebound)
                != _operational_identity(after)
            ):
                raise ValueError("component file changed during held read")
        directory_after = os.fstat(handle.descriptor)
        if (
            _operational_identity(directory_after)
            != _operational_identity(directory_before)
            or tuple(sorted(os.listdir(handle.descriptor))) != expected_members
        ):
            raise ValueError("component directory changed during held read")
        if allow_directory_metadata_change:
            handle.directory_operational_identity = _operational_identity(
                directory_after
            )
    except VerifierUpgradeError:
        raise
    except Exception as cause:
        _fail("VERIFIER_UPGRADE_TREE", source_path, cause)


def _event_binding(event):
    return EventBinding(
        name=event.name,
        directory_identity=_identity(os.fstat(event.descriptor)),
        receipt_sha256=event.receipt_sha256,
        marker=event.marker,
        slot_directory_identity=_path_component_identity(
            event.descriptor,
            SLOT_BASENAME,
        ),
    )


def _assert_live_lifecycle_binding(
    tree,
    namespace_descriptor,
    lock_descriptor,
    upgrade_root_descriptor=None,
    event_bindings=(),
    formal_spec=None,
    formal_identity=None,
    genesis_receipt_bytes=None,
):
    fresh_namespace_descriptor = None
    fresh_upgrade_root_descriptor = None
    fresh_lock_descriptor = None
    try:
        with BOOTSTRAP._open_system_tree(
            str(tree.root_path),
            expected_uid=tree.expected_uid,
            expected_gid=tree.expected_gid,
        ) as fresh_tree:
            if any(
                fresh_directory.identity != held_directory.identity
                for fresh_directory, held_directory in zip(
                    (
                        fresh_tree.root,
                        fresh_tree.usr,
                        fresh_tree.local,
                        fresh_tree.lib,
                    ),
                    (tree.root, tree.usr, tree.local, tree.lib),
                    strict=True,
                )
            ):
                BOOTSTRAP._fail(
                    "VERIFIER_BOOTSTRAP_PARENT",
                    "system/usr-local-lib",
                )
            lock_bytes, fresh_lock_descriptor, fresh_lock_metadata = (
                _read_file_at(
                    fresh_tree.lib.descriptor,
                    LOCK_BASENAME,
                    maximum_bytes=0,
                    expected_mode=0o600,
                    expected_uid=tree.expected_uid,
                    expected_gid=tree.expected_gid,
                    code="VERIFIER_UPGRADE_STATE",
                    source_path="state/lock",
                )
            )
            if (
                lock_bytes
                or _operational_identity(fresh_lock_metadata)
                != _operational_identity(os.fstat(lock_descriptor))
                or BOOTSTRAP._discover_state(fresh_tree)
                != ("formal", FORMAL_NAMESPACE)
            ):
                _fail("VERIFIER_UPGRADE_STATE", "state/system-lib")
            fresh_namespace_descriptor, _metadata = _open_directory_at(
                fresh_tree.lib.descriptor,
                FORMAL_NAMESPACE,
                mode=0o755,
                expected_uid=tree.expected_uid,
                expected_gid=tree.expected_gid,
                code="VERIFIER_UPGRADE_STATE",
                source_path="state/namespace",
            )
            if _identity(os.fstat(fresh_namespace_descriptor)) != _identity(
                os.fstat(namespace_descriptor)
            ):
                _fail("VERIFIER_UPGRADE_STATE", "state/namespace")
            if genesis_receipt_bytes is not None:
                fresh_genesis_bytes, _receipt, _spec = _load_genesis(
                    fresh_tree,
                    fresh_namespace_descriptor,
                    fresh_lock_descriptor,
                )
                if fresh_genesis_bytes != genesis_receipt_bytes:
                    _fail("VERIFIER_UPGRADE_RECEIPT", "genesis/live-binding")
            if (formal_spec is None) != (formal_identity is None):
                _fail("VERIFIER_UPGRADE_STATE", "state/formal-binding")
            if formal_spec is not None:
                _validate_current_component(
                    fresh_tree,
                    fresh_namespace_descriptor,
                    formal_spec,
                    formal_identity,
                )
            if upgrade_root_descriptor is None:
                if event_bindings:
                    _fail("VERIFIER_UPGRADE_STATE", "state/upgrades")
            else:
                fresh_upgrade_root_descriptor, _metadata = _open_directory_at(
                    fresh_namespace_descriptor,
                    UPGRADE_ROOT_BASENAME,
                    mode=0o700,
                    expected_uid=tree.expected_uid,
                    expected_gid=tree.expected_gid,
                    code="VERIFIER_UPGRADE_STATE",
                    source_path="state/upgrades",
                )
                if _identity(
                    os.fstat(fresh_upgrade_root_descriptor)
                ) != _identity(os.fstat(upgrade_root_descriptor)):
                    _fail("VERIFIER_UPGRADE_STATE", "state/upgrades")
                expected_names = tuple(
                    binding.name for binding in event_bindings
                )
                if (
                    tuple(sorted(os.listdir(fresh_upgrade_root_descriptor)))
                    != expected_names
                ):
                    _fail("VERIFIER_UPGRADE_STATE", "state/upgrades")
                for binding in event_bindings:
                    fresh_event = _open_event(
                        fresh_upgrade_root_descriptor,
                        binding.name,
                        fresh_tree,
                    )
                    try:
                        if (
                            _identity(os.fstat(fresh_event.descriptor))
                            != binding.directory_identity
                            or fresh_event.receipt_sha256
                            != binding.receipt_sha256
                            or fresh_event.marker != binding.marker
                            or fresh_event.slot.directory_identity
                            != binding.slot_directory_identity
                        ):
                            _fail(
                                "VERIFIER_UPGRADE_STATE",
                                "state/event-binding",
                            )
                    finally:
                        fresh_event.close()
        BOOTSTRAP._reverify_system_tree(tree)
        BOOTSTRAP._reverify_lock(tree, lock_descriptor)
    finally:
        if fresh_lock_descriptor is not None:
            try:
                os.close(fresh_lock_descriptor)
            except OSError:
                pass
        if fresh_upgrade_root_descriptor is not None:
            try:
                os.close(fresh_upgrade_root_descriptor)
            except OSError:
                pass
        if fresh_namespace_descriptor is not None:
            try:
                os.close(fresh_namespace_descriptor)
            except OSError:
                pass


def _reverify_lifecycle(
    tree,
    namespace_descriptor,
    lock_descriptor,
    upgrade_root_descriptor=None,
    event_bindings=(),
    formal_spec=None,
    formal_identity=None,
    genesis_receipt_bytes=None,
):
    for _sample in range(2):
        _assert_live_lifecycle_binding(
            tree,
            namespace_descriptor,
            lock_descriptor,
            upgrade_root_descriptor,
            event_bindings,
            formal_spec,
            formal_identity,
            genesis_receipt_bytes,
        )


def _run_self_test(runner, system_python, component):
    target = HeldSelfTestTarget(
        verifier_descriptor=component.file_descriptors[VERIFIER_BASENAME],
        golden_descriptor=component.file_descriptors[GOLDEN_BASENAME],
    )
    try:
        value = runner(system_python, target)
    except VerifierUpgradeError:
        raise
    except KeyboardInterrupt as cause:
        _fail("VERIFIER_UPGRADE_INTERRUPTED", "process/keyboard-interrupt", cause)
    except BaseException as cause:
        _fail("VERIFIER_UPGRADE_SELF_TEST", "self-test/process", cause)
    if value != {
        "schemaVersion": SELF_TEST_SCHEMA_VERSION,
        "wireMagic": FILE_TREE_WIRE_MAGIC,
        "vectorCount": 6,
    }:
        _fail("VERIFIER_UPGRADE_SELF_TEST", "self-test/result")
    return value


def _load_genesis(tree, namespace_descriptor, lock_descriptor):
    state_descriptor = None
    receipt_descriptor = None
    marker_descriptor = None
    try:
        state_descriptor, state_metadata = _open_directory_at(
            namespace_descriptor,
            STATE_DIRECTORY,
            mode=0o700,
            expected_uid=tree.expected_uid,
            expected_gid=tree.expected_gid,
            code="VERIFIER_UPGRADE_RECEIPT",
            source_path="genesis/state",
        )
        if tuple(sorted(os.listdir(state_descriptor))) != (
            GENESIS_COMMITTED_BASENAME,
            GENESIS_RECEIPT_BASENAME,
        ):
            _fail("VERIFIER_UPGRADE_RECEIPT", "genesis/state")
        receipt_bytes, receipt_descriptor, receipt_metadata = _read_file_at(
            state_descriptor,
            GENESIS_RECEIPT_BASENAME,
            maximum_bytes=BOOTSTRAP.MAX_RECEIPT_BYTES,
            expected_mode=0o600,
            expected_uid=tree.expected_uid,
            expected_gid=tree.expected_gid,
            code="VERIFIER_UPGRADE_RECEIPT",
            source_path="genesis/receipt",
        )
        marker_bytes, marker_descriptor, marker_metadata = _read_file_at(
            state_descriptor,
            GENESIS_COMMITTED_BASENAME,
            maximum_bytes=0,
            expected_mode=0o600,
            expected_uid=tree.expected_uid,
            expected_gid=tree.expected_gid,
            code="VERIFIER_UPGRADE_RECEIPT",
            source_path="genesis/committed",
        )
        if marker_bytes != b"":
            _fail("VERIFIER_UPGRADE_RECEIPT", "genesis/committed")
        receipt = BOOTSTRAP._parse_receipt(receipt_bytes)
        namespace_metadata = os.fstat(namespace_descriptor)
        lock_metadata = os.fstat(lock_descriptor)
        if (
            receipt["schemaVersion"] != BOOTSTRAP.RECEIPT_SCHEMA_VERSION
            or receipt["formalName"] != FORMAL_NAMESPACE
            or receipt["repository"] != REPOSITORY
            or receipt["namespaceIdentity"] != _identity(namespace_metadata)
            or receipt["stateDirectoryIdentity"] != _identity(state_metadata)
            or receipt["lockIdentity"] != _identity(lock_metadata)
            or receipt_metadata.st_dev != namespace_metadata.st_dev
            or marker_metadata.st_dev != namespace_metadata.st_dev
        ):
            _fail("VERIFIER_UPGRADE_RECEIPT", "genesis/receipt")
        provisional_spec = {
            "commitSha": receipt["commitSha"],
            "files": [
                {
                    "mode": mode,
                    "path": path,
                    "sha256": (
                        receipt["goldenSha256"]
                        if path == GOLDEN_BASENAME
                        else receipt["verifierSha256"]
                    ),
                    "size": None,
                }
                for path, mode in EXPECTED_COMPONENT_FILES
            ],
            "interfaceVersion": INTERFACE_VERSION,
            "manifestSha256": hashlib.sha256(receipt_bytes).hexdigest(),
            "provenance": "bootstrap-receipt-v1",
            "selfTest": {
                "schemaVersion": SELF_TEST_SCHEMA_VERSION,
                "wireMagic": FILE_TREE_WIRE_MAGIC,
            },
        }
        return receipt_bytes, receipt, provisional_spec
    finally:
        for descriptor in (
            marker_descriptor,
            receipt_descriptor,
            state_descriptor,
        ):
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass


def _complete_genesis_spec(provisional_spec, parent_descriptor, component_name):
    return {
        **provisional_spec,
        "files": [
            {
                **item,
                "size": _component_file_size(
                    parent_descriptor,
                    component_name,
                    item["path"],
                ),
            }
            for item in provisional_spec["files"]
        ],
    }


def _assert_genesis_spec(spec, provisional_spec, receipt, genesis_sha256):
    if (
        spec["commitSha"] != provisional_spec["commitSha"]
        or spec["interfaceVersion"] != INTERFACE_VERSION
        or spec["manifestSha256"] != genesis_sha256
        or spec["provenance"] != "bootstrap-receipt-v1"
        or spec["selfTest"] != provisional_spec["selfTest"]
        or any(
            actual["path"] != expected["path"]
            or actual["mode"] != expected["mode"]
            or actual["sha256"] != expected["sha256"]
            or not isinstance(actual["size"], int)
            or isinstance(actual["size"], bool)
            or actual["size"] < 0
            for actual, expected in zip(
                spec["files"],
                provisional_spec["files"],
                strict=True,
            )
        )
    ):
        _fail("VERIFIER_UPGRADE_RECEIPT", "genesis/lineage")
    expected_identities = {
        "directory": receipt["installDirectoryIdentity"],
        "files": {
            GOLDEN_BASENAME: receipt["goldenIdentity"],
            VERIFIER_BASENAME: receipt["verifierIdentity"],
        },
    }
    return expected_identities


def _component_file_size(namespace_descriptor, component_name, file_name):
    component_descriptor = None
    try:
        component_descriptor = os.open(
            component_name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=namespace_descriptor,
        )
        return os.stat(
            file_name,
            dir_fd=component_descriptor,
            follow_symlinks=False,
        ).st_size
    finally:
        if component_descriptor is not None:
            os.close(component_descriptor)


def _read_runner_digest(path):
    descriptor = None
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
        )
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size > MAX_COMPONENT_FILE_BYTES
        ):
            _fail("VERIFIER_UPGRADE_SOURCE", "runner/identity")
        digest = hashlib.sha256()
        total = 0
        while total < before.st_size:
            chunk = os.read(descriptor, min(64 * 1024, before.st_size - total))
            if not chunk:
                _fail("VERIFIER_UPGRADE_SOURCE", "runner/identity")
            digest.update(chunk)
            total += len(chunk)
        if os.read(descriptor, 1) or _operational_identity(before) != _operational_identity(
            os.fstat(descriptor)
        ):
            _fail("VERIFIER_UPGRADE_SOURCE", "runner/identity")
        return digest.hexdigest()
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _create_directory_at(
    parent_descriptor,
    basename,
    mode,
    tree,
    source_path,
):
    descriptor = None
    try:
        os.mkdir(basename, 0o700, dir_fd=parent_descriptor)
        descriptor = os.open(
            basename,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=parent_descriptor,
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
            _fail("VERIFIER_UPGRADE_TREE", source_path)
        return descriptor, metadata
    except BaseException as cause:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if isinstance(cause, VerifierUpgradeError):
            raise
        _fail("VERIFIER_UPGRADE_TREE", source_path, cause)


def _open_upgrade_root(tree, namespace_descriptor, *, create):
    try:
        return _open_directory_at(
            namespace_descriptor,
            UPGRADE_ROOT_BASENAME,
            mode=0o700,
            expected_uid=tree.expected_uid,
            expected_gid=tree.expected_gid,
            code="VERIFIER_UPGRADE_STATE",
            source_path="state/upgrades",
        )[0]
    except VerifierUpgradeError as error:
        if not isinstance(error.cause, FileNotFoundError):
            raise
    if not create:
        return None
    descriptor, _metadata = _create_directory_at(
        namespace_descriptor,
        UPGRADE_ROOT_BASENAME,
        0o700,
        tree,
        "state/upgrades",
    )
    try:
        os.fsync(namespace_descriptor)
    except OSError as cause:
        try:
            os.close(descriptor)
        except OSError:
            pass
        _fail("VERIFIER_UPGRADE_COMMIT", "state/upgrades", cause)
    return descriptor


def _write_file_at(
    parent_descriptor,
    basename,
    content,
    mode,
    tree,
    source_path,
):
    descriptor = None
    try:
        descriptor = os.open(
            basename,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | os.O_NOFOLLOW
            | os.O_CLOEXEC,
            0o600,
            dir_fd=parent_descriptor,
        )
        offset = 0
        while offset < len(content):
            written = os.write(descriptor, content[offset:])
            if written <= 0:
                raise OSError(errno.EIO, "short write")
            offset += written
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
            _fail("VERIFIER_UPGRADE_TREE", source_path)
        return metadata
    except VerifierUpgradeError:
        raise
    except Exception as cause:
        _fail("VERIFIER_UPGRADE_TREE", source_path, cause)
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _rename_at(
    source_parent,
    source_name,
    target_parent,
    target_name,
    flags,
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
        ctypes.set_errno(0)
        result = renameat2(
            source_parent,
            os.fsencode(source_name),
            target_parent,
            os.fsencode(target_name),
            flags,
        )
        if result != 0:
            error_number = ctypes.get_errno() or errno.EIO
            raise OSError(error_number, os.strerror(error_number))
    except Exception as cause:
        _fail(code, source_path, cause)


def _rename_exchange(
    namespace_descriptor,
    transaction_descriptor,
):
    _rename_at(
        transaction_descriptor,
        SLOT_BASENAME,
        namespace_descriptor,
        INSTALL_DIRECTORY,
        RENAME_EXCHANGE,
        "VERIFIER_UPGRADE_COMMIT",
        "commit/exchange",
    )


def _parse_receipt(raw_bytes):
    value = _strict_json(
        raw_bytes,
        "VERIFIER_UPGRADE_RECEIPT",
        "event/receipt",
    )
    expected_keys = (
        "bootstrapRunnerSha256",
        "component",
        "from",
        "fromComponentReceiptSha256",
        "genesisReceiptSha256",
        "identities",
        "operation",
        "previousEventReceiptSha256",
        "repository",
        "schemaVersion",
        "selfTestResult",
        "sequence",
        "to",
        "transactionId",
        "upgraderSha256",
    )
    if not isinstance(value, dict) or tuple(value.keys()) != expected_keys:
        _fail("VERIFIER_UPGRADE_RECEIPT", "event/receipt")
    if (
        value["schemaVersion"] != SCHEMA_VERSION
        or value["repository"] != REPOSITORY
        or value["component"] != COMPONENT
        or value["operation"] != "upgrade"
        or not isinstance(value["sequence"], int)
        or isinstance(value["sequence"], bool)
        or value["sequence"] <= 0
        or TRANSACTION_ID_PATTERN.fullmatch(value["transactionId"] or "")
        is None
        or any(
            HEX_64_PATTERN.fullmatch(value[field] or "") is None
            for field in (
                "bootstrapRunnerSha256",
                "fromComponentReceiptSha256",
                "genesisReceiptSha256",
                "previousEventReceiptSha256",
                "upgraderSha256",
            )
        )
        or value["selfTestResult"]
        != {
            "schemaVersion": SELF_TEST_SCHEMA_VERSION,
            "vectorCount": 6,
            "wireMagic": FILE_TREE_WIRE_MAGIC,
        }
    ):
        _fail("VERIFIER_UPGRADE_RECEIPT", "event/receipt")
    _validate_component_spec(value["from"], "event/from")
    _validate_component_spec(value["to"], "event/to")
    identities = value["identities"]
    if (
        not isinstance(identities, dict)
        or tuple(identities.keys())
        != ("fromComponent", "lock", "namespace", "toComponent", "transaction")
    ):
        _fail("VERIFIER_UPGRADE_RECEIPT", "event/identities")
    for field in ("lock", "namespace", "transaction"):
        _validate_identity(identities[field], "event/identities")
    for field in ("fromComponent", "toComponent"):
        _validate_component_identity(identities[field])
    return value


def _validate_identity(value, source_path):
    if (
        not isinstance(value, dict)
        or tuple(value.keys()) != ("device", "inode")
        or not isinstance(value["device"], int)
        or value["device"] < 0
        or not isinstance(value["inode"], int)
        or value["inode"] <= 0
    ):
        _fail("VERIFIER_UPGRADE_RECEIPT", source_path)


def _validate_component_identity(value):
    if (
        not isinstance(value, dict)
        or tuple(value.keys()) != ("directory", "files")
        or not isinstance(value["files"], dict)
        or tuple(value["files"].keys())
        != tuple(path for path, _mode in EXPECTED_COMPONENT_FILES)
    ):
        _fail("VERIFIER_UPGRADE_RECEIPT", "event/identities")
    _validate_identity(value["directory"], "event/identities")
    for identity in value["files"].values():
        _validate_identity(identity, "event/identities")


def _event_marker(transaction_descriptor):
    names = tuple(sorted(os.listdir(transaction_descriptor)))
    markers = tuple(
        name
        for name in (PREPARED_BASENAME, COMMITTED_BASENAME, ROLLED_BACK_BASENAME)
        if name in names
    )
    expected = tuple(sorted((SLOT_BASENAME, RECEIPT_BASENAME, *markers)))
    if len(markers) != 1 or names != expected:
        _fail("VERIFIER_UPGRADE_STATE", "event/layout")
    return markers[0]


def _open_event(
    upgrade_root_descriptor,
    name,
    tree,
):
    transaction_descriptor = None
    receipt_descriptor = None
    marker_descriptor = None
    slot = None
    try:
        transaction_descriptor, transaction_metadata = _open_directory_at(
            upgrade_root_descriptor,
            name,
            mode=0o700,
            expected_uid=tree.expected_uid,
            expected_gid=tree.expected_gid,
            code="VERIFIER_UPGRADE_STATE",
            source_path="event/transaction",
        )
        marker = _event_marker(transaction_descriptor)
        marker_bytes, marker_descriptor, _marker_metadata = _read_file_at(
            transaction_descriptor,
            marker,
            maximum_bytes=0,
            expected_mode=0o600,
            expected_uid=tree.expected_uid,
            expected_gid=tree.expected_gid,
            code="VERIFIER_UPGRADE_STATE",
            source_path="event/marker",
        )
        if marker_bytes != b"":
            _fail("VERIFIER_UPGRADE_STATE", "event/marker")
        receipt_bytes, receipt_descriptor, _metadata = _read_file_at(
            transaction_descriptor,
            RECEIPT_BASENAME,
            maximum_bytes=MAX_RECEIPT_BYTES,
            expected_mode=0o600,
            expected_uid=tree.expected_uid,
            expected_gid=tree.expected_gid,
            code="VERIFIER_UPGRADE_RECEIPT",
            source_path="event/receipt",
        )
        receipt = _parse_receipt(receipt_bytes)
        expected_name = (
            f"{receipt['sequence']:08d}-{receipt['transactionId']}"
        )
        if (
            name != expected_name
            or receipt["identities"]["transaction"]
            != _identity(transaction_metadata)
        ):
            _fail("VERIFIER_UPGRADE_RECEIPT", "event/receipt")
        slot_directory_identity = _path_component_identity(
            transaction_descriptor,
            SLOT_BASENAME,
        )
        from_identity = receipt["identities"]["fromComponent"]["directory"]
        to_identity = receipt["identities"]["toComponent"]["directory"]
        if marker == COMMITTED_BASENAME and slot_directory_identity == from_identity:
            slot_spec = receipt["from"]
            expected_slot_identity = receipt["identities"]["fromComponent"]
        elif (
            marker == ROLLED_BACK_BASENAME
            and slot_directory_identity == to_identity
        ):
            slot_spec = receipt["to"]
            expected_slot_identity = receipt["identities"]["toComponent"]
        elif marker == PREPARED_BASENAME and slot_directory_identity in (
            from_identity,
            to_identity,
        ):
            if slot_directory_identity == from_identity:
                slot_spec = receipt["from"]
                expected_slot_identity = receipt["identities"]["fromComponent"]
            else:
                slot_spec = receipt["to"]
                expected_slot_identity = receipt["identities"]["toComponent"]
        else:
            _fail("VERIFIER_UPGRADE_OUTCOME_UNKNOWN", "event/slot")
        slot = _open_component(
            transaction_descriptor,
            SLOT_BASENAME,
            slot_spec,
            expected_uid=tree.expected_uid,
            expected_gid=tree.expected_gid,
            source_path="event/slot",
        )
        _assert_component_identity(slot, expected_slot_identity, "event/slot")
        result = EventHandle(
            name=name,
            descriptor=transaction_descriptor,
            receipt=receipt,
            receipt_bytes=receipt_bytes,
            receipt_sha256=hashlib.sha256(receipt_bytes).hexdigest(),
            marker=marker,
            slot=slot,
        )
        slot = None
        transaction_descriptor = None
        return result
    finally:
        if slot is not None:
            slot.close()
        if marker_descriptor is not None:
            try:
                os.close(marker_descriptor)
            except OSError:
                pass
        if receipt_descriptor is not None:
            try:
                os.close(receipt_descriptor)
            except OSError:
                pass
        if transaction_descriptor is not None:
            try:
                os.close(transaction_descriptor)
            except OSError:
                pass


def _load_event_chain(
    upgrade_root_descriptor,
    namespace_descriptor,
    lock_descriptor,
    tree,
    genesis_sha256,
    genesis_spec,
    genesis_identity,
):
    names = tuple(sorted(os.listdir(upgrade_root_descriptor)))
    if any(EVENT_NAME_PATTERN.fullmatch(name) is None for name in names):
        _fail("VERIFIER_UPGRADE_STATE", "state/upgrades")
    events = []
    bindings = []
    event_head = genesis_sha256
    component_head = genesis_sha256
    active_spec = genesis_spec
    active_identity = genesis_identity
    try:
        for index, name in enumerate(names, start=1):
            event = _open_event(upgrade_root_descriptor, name, tree)
            events.append(event)
            receipt = event.receipt
            if (
                receipt["sequence"] != index
                or receipt["genesisReceiptSha256"] != genesis_sha256
                or receipt["previousEventReceiptSha256"] != event_head
                or receipt["fromComponentReceiptSha256"] != component_head
                or receipt["from"] != active_spec
                or receipt["identities"]["fromComponent"]
                != active_identity
                or receipt["identities"]["namespace"]
                != _identity(os.fstat(namespace_descriptor))
                or receipt["identities"]["lock"]
                != _identity(os.fstat(lock_descriptor))
                or (
                    event.marker
                    in (PREPARED_BASENAME, ROLLED_BACK_BASENAME)
                    and index != len(names)
                )
            ):
                _fail("VERIFIER_UPGRADE_RECEIPT", "event/lineage")
            event_head = event.receipt_sha256
            if event.marker == COMMITTED_BASENAME:
                component_head = event.receipt_sha256
                active_spec = receipt["to"]
                active_identity = receipt["identities"]["toComponent"]
            bindings.append(_event_binding(event))
            if index != len(names):
                event.close()
                events.pop()
        return (
            events,
            tuple(bindings),
            event_head,
            component_head,
            active_spec,
            active_identity,
        )
    except BaseException:
        for event in reversed(events):
            event.close()
        raise


def _create_event(
    *,
    tree,
    namespace_descriptor,
    upgrade_root_descriptor,
    lock_descriptor,
    sequence,
    transaction_id,
    previous_event_sha256,
    component_head_sha256,
    genesis_sha256,
    from_spec,
    from_component,
    to_spec,
    sources,
    system_python,
    self_test_runner,
    upgrader_sha256,
    bootstrap_sha256,
    previous_event_bindings,
    genesis_receipt_bytes,
):
    if TRANSACTION_ID_PATTERN.fullmatch(transaction_id or "") is None:
        _fail("VERIFIER_UPGRADE_STATE", "event/transaction-id")
    name = f"{sequence:08d}-{transaction_id}"
    transaction_descriptor = None
    slot_descriptor = None
    slot_component = None
    prepared_event = None
    try:
        transaction_descriptor, transaction_metadata = _create_directory_at(
            upgrade_root_descriptor,
            name,
            0o700,
            tree,
            "event/transaction",
        )
        slot_descriptor, _slot_metadata = _create_directory_at(
            transaction_descriptor,
            SLOT_BASENAME,
            0o755,
            tree,
            "event/slot",
        )
        for file_spec in to_spec["files"]:
            _write_file_at(
                slot_descriptor,
                file_spec["path"],
                sources[file_spec["path"]].content,
                int(file_spec["mode"], 8),
                tree,
                f"event/slot/{file_spec['path']}",
            )
        os.fsync(slot_descriptor)
        os.fsync(transaction_descriptor)
        slot_component = _open_component(
            transaction_descriptor,
            SLOT_BASENAME,
            to_spec,
            expected_uid=tree.expected_uid,
            expected_gid=tree.expected_gid,
            source_path="event/slot",
        )
        slot_identity = _component_identity(slot_component)
        self_test_result = _run_self_test(
            self_test_runner,
            system_python,
            slot_component,
        )
        _reverify_component_handle(
            slot_component,
            to_spec,
            slot_identity,
            "event/slot",
        )
        receipt = {
            "bootstrapRunnerSha256": bootstrap_sha256,
            "component": COMPONENT,
            "from": from_spec,
            "fromComponentReceiptSha256": component_head_sha256,
            "genesisReceiptSha256": genesis_sha256,
            "identities": {
                "fromComponent": _component_identity(from_component),
                "lock": _identity(os.fstat(lock_descriptor)),
                "namespace": _identity(os.fstat(namespace_descriptor)),
                "toComponent": slot_identity,
                "transaction": _identity(transaction_metadata),
            },
            "operation": "upgrade",
            "previousEventReceiptSha256": previous_event_sha256,
            "repository": REPOSITORY,
            "schemaVersion": SCHEMA_VERSION,
            "selfTestResult": self_test_result,
            "sequence": sequence,
            "to": to_spec,
            "transactionId": transaction_id,
            "upgraderSha256": upgrader_sha256,
        }
        receipt_bytes = _canonical_json(receipt)
        _write_file_at(
            transaction_descriptor,
            RECEIPT_BASENAME,
            receipt_bytes,
            0o600,
            tree,
            "event/receipt",
        )
        _write_file_at(
            transaction_descriptor,
            PREPARED_BASENAME,
            b"",
            0o600,
            tree,
            "event/prepared",
        )
        prepared_event = EventHandle(
            name=name,
            descriptor=transaction_descriptor,
            receipt=receipt,
            receipt_bytes=receipt_bytes,
            receipt_sha256=hashlib.sha256(receipt_bytes).hexdigest(),
            marker=PREPARED_BASENAME,
            slot=slot_component,
        )
        transaction_descriptor = None
        slot_component = None
        os.close(slot_descriptor)
        slot_descriptor = None
        os.fsync(prepared_event.descriptor)
        os.fsync(upgrade_root_descriptor)
        os.fsync(namespace_descriptor)
        result = prepared_event
        prepared_event = None
        return result
    except BaseException as caught:
        if prepared_event is not None:
            try:
                _rollback_prepared(
                    tree,
                    namespace_descriptor,
                    prepared_event,
                    upgrade_root_descriptor,
                )
                _reverify_lifecycle(
                    tree,
                    namespace_descriptor,
                    lock_descriptor,
                    upgrade_root_descriptor,
                    (
                        *previous_event_bindings,
                        _event_binding(prepared_event),
                    ),
                    from_spec,
                    _component_identity(from_component),
                    genesis_receipt_bytes,
                )
            except BaseException as recovery_cause:
                _fail(
                    "VERIFIER_UPGRADE_OUTCOME_UNKNOWN",
                    "event/persist-recovery",
                    recovery_cause,
                )
            finally:
                prepared_event.close()
                prepared_event = None
            if isinstance(caught, KeyboardInterrupt):
                _fail(
                    "VERIFIER_UPGRADE_INTERRUPTED",
                    "process/keyboard-interrupt",
                    caught,
                )
            if isinstance(caught, OSError):
                _fail("VERIFIER_UPGRADE_COMMIT", "event/persist", caught)
        elif isinstance(caught, OSError):
            _fail("VERIFIER_UPGRADE_COMMIT", "event/create", caught)
        raise
    finally:
        if slot_component is not None:
            slot_component.close()
        if slot_descriptor is not None:
            try:
                os.close(slot_descriptor)
            except OSError:
                pass
        if transaction_descriptor is not None:
            try:
                os.close(transaction_descriptor)
            except OSError:
                pass


def _path_component_identity(parent_descriptor, basename):
    try:
        metadata = os.stat(
            basename,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
    except Exception as cause:
        _fail("VERIFIER_UPGRADE_OUTCOME_UNKNOWN", "recovery/layout", cause)
    return _identity(metadata)


def _mapping_for_event(namespace_descriptor, event):
    formal_identity = _path_component_identity(
        namespace_descriptor,
        INSTALL_DIRECTORY,
    )
    slot_identity = _path_component_identity(event.descriptor, SLOT_BASENAME)
    from_identity = event.receipt["identities"]["fromComponent"]["directory"]
    to_identity = event.receipt["identities"]["toComponent"]["directory"]
    if formal_identity == from_identity and slot_identity == to_identity:
        return "from-to"
    if formal_identity == to_identity and slot_identity == from_identity:
        return "to-from"
    _fail("VERIFIER_UPGRADE_OUTCOME_UNKNOWN", "recovery/layout")


def _mark_event(event, target_marker):
    _rename_at(
        event.descriptor,
        PREPARED_BASENAME,
        event.descriptor,
        target_marker,
        RENAME_NOREPLACE,
        "VERIFIER_UPGRADE_COMMIT",
        "commit/marker",
    )
    event.marker = target_marker
    try:
        os.fsync(event.descriptor)
    except OSError as cause:
        _fail("VERIFIER_UPGRADE_COMMIT", "commit/state-directory", cause)


def _validate_event_pair(
    tree,
    namespace_descriptor,
    event,
    mapping,
):
    formal_spec = event.receipt["from"] if mapping == "from-to" else event.receipt["to"]
    slot_spec = event.receipt["to"] if mapping == "from-to" else event.receipt["from"]
    formal_expected = (
        event.receipt["identities"]["fromComponent"]
        if mapping == "from-to"
        else event.receipt["identities"]["toComponent"]
    )
    slot_expected = (
        event.receipt["identities"]["toComponent"]
        if mapping == "from-to"
        else event.receipt["identities"]["fromComponent"]
    )
    formal = None
    slot = None
    try:
        formal = _open_component(
            namespace_descriptor,
            INSTALL_DIRECTORY,
            formal_spec,
            expected_uid=tree.expected_uid,
            expected_gid=tree.expected_gid,
            source_path="current/component",
        )
        slot = _open_component(
            event.descriptor,
            SLOT_BASENAME,
            slot_spec,
            expected_uid=tree.expected_uid,
            expected_gid=tree.expected_gid,
            source_path="event/slot",
        )
        _assert_component_identity(formal, formal_expected, "current/component")
        _assert_component_identity(slot, slot_expected, "event/slot")
    finally:
        if formal is not None:
            formal.close()
        if slot is not None:
            slot.close()


def _validate_current_component(
    tree,
    namespace_descriptor,
    spec,
    expected_identity,
):
    component = _open_component(
        namespace_descriptor,
        INSTALL_DIRECTORY,
        spec,
        expected_uid=tree.expected_uid,
        expected_gid=tree.expected_gid,
        source_path="current/component",
    )
    try:
        _assert_component_identity(
            component,
            expected_identity,
            "current/component",
        )
        _reverify_component_handle(
            component,
            spec,
            expected_identity,
            "current/component",
        )
    finally:
        component.close()


def _rollback_prepared(
    tree,
    namespace_descriptor,
    event,
    upgrade_root_descriptor,
):
    try:
        mapping = _mapping_for_event(namespace_descriptor, event)
        if mapping == "to-from":
            _rename_exchange(namespace_descriptor, event.descriptor)
            os.fsync(event.descriptor)
            os.fsync(namespace_descriptor)
        _validate_event_pair(tree, namespace_descriptor, event, "from-to")
        _mark_event(event, ROLLED_BACK_BASENAME)
        os.fsync(upgrade_root_descriptor)
        os.fsync(namespace_descriptor)
    except (VerifierUpgradeError, BOOTSTRAP.VerifierBootstrapError, OSError) as cause:
        if (
            isinstance(cause, VerifierUpgradeError)
            and cause.code == "VERIFIER_UPGRADE_OUTCOME_UNKNOWN"
        ):
            raise
        _fail("VERIFIER_UPGRADE_OUTCOME_UNKNOWN", "recovery/rollback", cause)


@contextlib.contextmanager
def _block_interrupts():
    try:
        previous = signal.pthread_sigmask(signal.SIG_BLOCK, INTERRUPT_SIGNALS)
    except (AttributeError, OSError, ValueError) as cause:
        _fail("VERIFIER_UPGRADE_RUNTIME", "runtime/signal-mask", cause)
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def _result(receipt, receipt_sha256, disposition):
    return {
        "schemaVersion": SCHEMA_VERSION,
        "status": "committed",
        "disposition": disposition,
        "componentReceiptSha256": receipt_sha256,
        "commitSha": receipt["to"]["commitSha"],
        "manifestSha256": receipt["to"]["manifestSha256"],
    }


def _emit_json_line(stream, value):
    stream.write(
        json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n"
    )
    stream.flush()


def _finish_committed(event, signal_state, success_stream, disposition):
    signal_state["commitCompleted"] = True
    result = _result(event.receipt, event.receipt_sha256, disposition)
    if success_stream is not None:
        try:
            _emit_json_line(success_stream, result)
        except BaseException:
            pass
    return result


def _recover_prepared(
    tree,
    namespace_descriptor,
    event,
    lock_descriptor,
    upgrade_root_descriptor,
    event_bindings,
    genesis_receipt_bytes,
):
    with _block_interrupts():
        mapping = _mapping_for_event(namespace_descriptor, event)
        if mapping == "from-to":
            formal_spec = event.receipt["from"]
            formal_identity = event.receipt["identities"]["fromComponent"]
        else:
            formal_spec = event.receipt["to"]
            formal_identity = event.receipt["identities"]["toComponent"]
        _reverify_lifecycle(
            tree,
            namespace_descriptor,
            lock_descriptor,
            upgrade_root_descriptor,
            event_bindings,
            formal_spec,
            formal_identity,
            genesis_receipt_bytes,
        )
        _rollback_prepared(
            tree,
            namespace_descriptor,
            event,
            upgrade_root_descriptor,
        )
        try:
            _reverify_lifecycle(
                tree,
                namespace_descriptor,
                lock_descriptor,
                upgrade_root_descriptor,
                (*event_bindings[:-1], _event_binding(event)),
                event.receipt["from"],
                event.receipt["identities"]["fromComponent"],
                genesis_receipt_bytes,
            )
        except BaseException as cause:
            _fail(
                "VERIFIER_UPGRADE_OUTCOME_UNKNOWN",
                "recovery/live-binding",
                cause,
            )
    _fail("VERIFIER_UPGRADE_ROLLED_BACK", "recovery/prepared")


def _activate_event(
    *,
    tree,
    namespace_descriptor,
    event,
    lock_descriptor,
    upgrade_root_descriptor,
    previous_event_bindings,
    system_python,
    self_test_runner,
    signal_state,
    success_stream,
    genesis_receipt_bytes,
):
    def reverify_lifecycle():
        mapping = _mapping_for_event(namespace_descriptor, event)
        if mapping == "from-to":
            formal_spec = event.receipt["from"]
            formal_identity = event.receipt["identities"]["fromComponent"]
        else:
            formal_spec = event.receipt["to"]
            formal_identity = event.receipt["identities"]["toComponent"]
        _reverify_lifecycle(
            tree,
            namespace_descriptor,
            lock_descriptor,
            upgrade_root_descriptor,
            (*previous_event_bindings, _event_binding(event)),
            formal_spec,
            formal_identity,
            genesis_receipt_bytes,
        )

    with _block_interrupts():
        try:
            reverify_lifecycle()
            _validate_event_pair(tree, namespace_descriptor, event, "from-to")
            reverify_lifecycle()
            _rename_exchange(namespace_descriptor, event.descriptor)
            os.fsync(event.descriptor)
            os.fsync(namespace_descriptor)
            reverify_lifecycle()
            _validate_event_pair(tree, namespace_descriptor, event, "to-from")
            _reverify_component_handle(
                event.slot,
                event.receipt["to"],
                event.receipt["identities"]["toComponent"],
                "current/component",
                allow_directory_metadata_change=True,
            )
            _run_self_test(
                self_test_runner,
                system_python,
                event.slot,
            )
            _reverify_component_handle(
                event.slot,
                event.receipt["to"],
                event.receipt["identities"]["toComponent"],
                "current/component",
            )
            _validate_event_pair(tree, namespace_descriptor, event, "to-from")
            reverify_lifecycle()
            _mark_event(event, COMMITTED_BASENAME)
            _reverify_component_handle(
                event.slot,
                event.receipt["to"],
                event.receipt["identities"]["toComponent"],
                "current/component",
            )
            _validate_event_pair(tree, namespace_descriptor, event, "to-from")
            reverify_lifecycle()
            return _finish_committed(
                event,
                signal_state,
                success_stream,
                "upgraded",
            )
        except (Exception, KeyboardInterrupt) as caught:
            try:
                marker = _event_marker(event.descriptor)
            except VerifierUpgradeError as marker_error:
                _fail(
                    "VERIFIER_UPGRADE_OUTCOME_UNKNOWN",
                    "recovery/marker",
                    marker_error,
                )
            if marker == COMMITTED_BASENAME:
                try:
                    _validate_event_pair(
                        tree,
                        namespace_descriptor,
                        event,
                        "to-from",
                    )
                    _reverify_component_handle(
                        event.slot,
                        event.receipt["to"],
                        event.receipt["identities"]["toComponent"],
                        "current/component",
                    )
                    reverify_lifecycle()
                    os.fsync(event.descriptor)
                    os.fsync(namespace_descriptor)
                    reverify_lifecycle()
                except BaseException as cause:
                    _fail(
                        "VERIFIER_UPGRADE_OUTCOME_UNKNOWN",
                        "recovery/committed",
                        cause,
                    )
                return _finish_committed(
                    event,
                    signal_state,
                    success_stream,
                    "recovered",
                )
            if marker != PREPARED_BASENAME:
                _fail("VERIFIER_UPGRADE_OUTCOME_UNKNOWN", "recovery/marker")
            _rollback_prepared(
                tree,
                namespace_descriptor,
                event,
                upgrade_root_descriptor,
            )
            try:
                _reverify_lifecycle(
                    tree,
                    namespace_descriptor,
                    lock_descriptor,
                    upgrade_root_descriptor,
                    (
                        *previous_event_bindings,
                        _event_binding(event),
                    ),
                    event.receipt["from"],
                    event.receipt["identities"]["fromComponent"],
                    genesis_receipt_bytes,
                )
            except BaseException as recovery_cause:
                _fail(
                    "VERIFIER_UPGRADE_OUTCOME_UNKNOWN",
                    "recovery/live-binding",
                    recovery_cause,
                )
            if isinstance(caught, KeyboardInterrupt):
                _fail(
                    "VERIFIER_UPGRADE_INTERRUPTED",
                    "process/keyboard-interrupt",
                    caught,
                )
            if isinstance(caught, OSError):
                _fail("VERIFIER_UPGRADE_COMMIT", "commit/sync", caught)
            raise caught


def upgrade_artifact_verifier(
    *,
    source_root,
    expected_current_receipt_sha256,
    expected_target_commit_sha,
    expected_target_manifest_sha256,
    success_stream=None,
    _root_path="/",
    _expected_uid=0,
    _expected_gid=0,
    _system_python="/usr/bin/python3",
    _self_test_runner=BOOTSTRAP._default_self_test_runner,
    _transaction_id_factory=lambda: secrets.token_hex(16),
    _enforce_runtime=True,
    _signal_state=None,
):
    if _enforce_runtime:
        _assert_runtime()
    expected_current_receipt_sha256 = _assert_hex(
        expected_current_receipt_sha256,
        HEX_64_PATTERN,
        "arguments/current-receipt",
    )
    expected_target_commit_sha = _assert_hex(
        expected_target_commit_sha,
        HEX_40_PATTERN,
        "arguments/target-commit",
    )
    expected_target_manifest_sha256 = _assert_hex(
        expected_target_manifest_sha256,
        HEX_64_PATTERN,
        "arguments/target-manifest",
    )
    signal_state = (
        {"commitCompleted": False}
        if _signal_state is None
        else _signal_state
    )
    with BOOTSTRAP._open_system_tree(
        _root_path,
        expected_uid=_expected_uid,
        expected_gid=_expected_gid,
    ) as tree:
        with BOOTSTRAP._acquire_lock(tree) as lock_descriptor:
            BOOTSTRAP._reverify_system_tree(tree)
            BOOTSTRAP._reverify_lock(tree, lock_descriptor)
            if BOOTSTRAP._discover_state(tree) != (
                "formal",
                FORMAL_NAMESPACE,
            ):
                _fail("VERIFIER_UPGRADE_STATE", "state/system-lib")
            namespace_descriptor, _namespace_metadata = _open_directory_at(
                tree.lib.descriptor,
                FORMAL_NAMESPACE,
                mode=0o755,
                expected_uid=tree.expected_uid,
                expected_gid=tree.expected_gid,
                code="VERIFIER_UPGRADE_STATE",
                source_path="state/namespace",
            )
            upgrade_root_descriptor = None
            events = []
            event_bindings = ()
            current_component = None
            try:
                _reverify_lifecycle(
                    tree,
                    namespace_descriptor,
                    lock_descriptor,
                )
                (
                    genesis_bytes,
                    genesis_receipt,
                    provisional_genesis_spec,
                ) = _load_genesis(
                    tree,
                    namespace_descriptor,
                    lock_descriptor,
                )
                genesis_sha256 = hashlib.sha256(genesis_bytes).hexdigest()
                upgrade_root_descriptor = _open_upgrade_root(
                    tree,
                    namespace_descriptor,
                    create=False,
                )
                if upgrade_root_descriptor is None:
                    genesis_spec = _complete_genesis_spec(
                        provisional_genesis_spec,
                        namespace_descriptor,
                        INSTALL_DIRECTORY,
                    )
                    genesis_identity = _assert_genesis_spec(
                        genesis_spec,
                        provisional_genesis_spec,
                        genesis_receipt,
                        genesis_sha256,
                    )
                    events = []
                    event_bindings = ()
                    event_head = genesis_sha256
                    component_head = genesis_sha256
                    active_spec = genesis_spec
                    active_identity = genesis_identity
                else:
                    event_names = tuple(
                        sorted(os.listdir(upgrade_root_descriptor))
                    )
                    if not event_names:
                        genesis_spec = _complete_genesis_spec(
                            provisional_genesis_spec,
                            namespace_descriptor,
                            INSTALL_DIRECTORY,
                        )
                        genesis_identity = _assert_genesis_spec(
                            genesis_spec,
                            provisional_genesis_spec,
                            genesis_receipt,
                            genesis_sha256,
                        )
                    else:
                        first_event = _open_event(
                            upgrade_root_descriptor,
                            event_names[0],
                            tree,
                        )
                        try:
                            genesis_spec = first_event.receipt["from"]
                            genesis_identity = _assert_genesis_spec(
                                genesis_spec,
                                provisional_genesis_spec,
                                genesis_receipt,
                                genesis_sha256,
                            )
                            if (
                                first_event.receipt["identities"][
                                    "fromComponent"
                                ]
                                != genesis_identity
                            ):
                                _fail(
                                    "VERIFIER_UPGRADE_RECEIPT",
                                    "genesis/lineage",
                                )
                        finally:
                            first_event.close()
                    (
                        events,
                        event_bindings,
                        event_head,
                        component_head,
                        active_spec,
                        active_identity,
                    ) = _load_event_chain(
                        upgrade_root_descriptor,
                        namespace_descriptor,
                        lock_descriptor,
                        tree,
                        genesis_sha256,
                        genesis_spec,
                        genesis_identity,
                    )
                if events and events[-1].marker == ROLLED_BACK_BASENAME:
                    _fail("VERIFIER_UPGRADE_STATE", "state/rolled-back-tail")
                if component_head != expected_current_receipt_sha256:
                    _fail("VERIFIER_UPGRADE_STATE", "state/current-head")
                if events and events[-1].marker == PREPARED_BASENAME:
                    _recover_prepared(
                        tree,
                        namespace_descriptor,
                        events[-1],
                        lock_descriptor,
                        upgrade_root_descriptor,
                        event_bindings,
                        genesis_bytes,
                    )
                _reverify_lifecycle(
                    tree,
                    namespace_descriptor,
                    lock_descriptor,
                    upgrade_root_descriptor,
                    event_bindings,
                    active_spec,
                    active_identity,
                    genesis_bytes,
                )
                for event in reversed(events):
                    event.close()
                events.clear()
                target_spec, sources = _capture_sources(
                    source_root,
                    expected_target_manifest_sha256,
                    expected_target_commit_sha,
                )
                upgrader_sha256 = _read_runner_digest(Path(__file__).resolve())
                bootstrap_sha256 = _read_runner_digest(BOOTSTRAP_PATH)
                current_component = _open_component(
                    namespace_descriptor,
                    INSTALL_DIRECTORY,
                    active_spec,
                    expected_uid=tree.expected_uid,
                    expected_gid=tree.expected_gid,
                    source_path="current/component",
                )
                _assert_component_identity(
                    current_component,
                    active_identity,
                    "current/component",
                )
                if active_spec == target_spec:
                    _reverify_lifecycle(
                        tree,
                        namespace_descriptor,
                        lock_descriptor,
                        upgrade_root_descriptor,
                        event_bindings,
                        active_spec,
                        active_identity,
                        genesis_bytes,
                    )
                    _run_self_test(
                        _self_test_runner,
                        _system_python,
                        current_component,
                    )
                    _reverify_component_handle(
                        current_component,
                        active_spec,
                        active_identity,
                        "current/component",
                    )
                    _validate_current_component(
                        tree,
                        namespace_descriptor,
                        active_spec,
                        active_identity,
                    )
                    _reverify_lifecycle(
                        tree,
                        namespace_descriptor,
                        lock_descriptor,
                        upgrade_root_descriptor,
                        event_bindings,
                        active_spec,
                        active_identity,
                        genesis_bytes,
                    )
                    result = {
                        "schemaVersion": SCHEMA_VERSION,
                        "status": "committed",
                        "disposition": "already-current",
                        "componentReceiptSha256": component_head,
                        "commitSha": active_spec["commitSha"],
                        "manifestSha256": active_spec["manifestSha256"],
                    }
                    signal_state["commitCompleted"] = True
                    if success_stream is not None:
                        try:
                            _emit_json_line(success_stream, result)
                        except BaseException:
                            pass
                    return result
                if upgrade_root_descriptor is None:
                    upgrade_root_descriptor = _open_upgrade_root(
                        tree,
                        namespace_descriptor,
                        create=True,
                    )
                transaction_id = _transaction_id_factory()
                with _block_interrupts():
                    event = _create_event(
                        tree=tree,
                        namespace_descriptor=namespace_descriptor,
                        upgrade_root_descriptor=upgrade_root_descriptor,
                        lock_descriptor=lock_descriptor,
                        sequence=len(event_bindings) + 1,
                        transaction_id=transaction_id,
                        previous_event_sha256=event_head,
                        component_head_sha256=component_head,
                        genesis_sha256=genesis_sha256,
                        from_spec=active_spec,
                        from_component=current_component,
                        to_spec=target_spec,
                        sources=sources,
                        system_python=_system_python,
                        self_test_runner=_self_test_runner,
                        upgrader_sha256=upgrader_sha256,
                        bootstrap_sha256=bootstrap_sha256,
                        previous_event_bindings=event_bindings,
                        genesis_receipt_bytes=genesis_bytes,
                    )
                    events.append(event)
                    return _activate_event(
                        tree=tree,
                        namespace_descriptor=namespace_descriptor,
                        event=event,
                        lock_descriptor=lock_descriptor,
                        upgrade_root_descriptor=upgrade_root_descriptor,
                        previous_event_bindings=event_bindings,
                        system_python=_system_python,
                        self_test_runner=_self_test_runner,
                        signal_state=signal_state,
                        success_stream=success_stream,
                        genesis_receipt_bytes=genesis_bytes,
                    )
            finally:
                if current_component is not None:
                    current_component.close()
                for event in reversed(events):
                    event.close()
                if upgrade_root_descriptor is not None:
                    try:
                        os.close(upgrade_root_descriptor)
                    except OSError:
                        pass
                try:
                    os.close(namespace_descriptor)
                except OSError:
                    pass


def _parse_cli_arguments(arguments):
    expected_flags = (
        "--source-root",
        "--expected-current-receipt-sha256",
        "--expected-target-commit-sha",
        "--expected-target-manifest-sha256",
    )
    if len(arguments) != len(expected_flags) * 2:
        _fail("VERIFIER_UPGRADE_ARGUMENT", "arguments")
    values = {}
    for index, expected_flag in enumerate(expected_flags):
        flag = arguments[index * 2]
        value = arguments[index * 2 + 1]
        if flag != expected_flag or not isinstance(value, str) or not value:
            _fail("VERIFIER_UPGRADE_ARGUMENT", "arguments")
        values[expected_flag] = value
    return values


def _install_signal_handlers():
    previous = {}
    state = {"commitCompleted": False}

    def interrupt_handler(_signal_number, _frame):
        if state["commitCompleted"]:
            return
        _fail("VERIFIER_UPGRADE_INTERRUPTED", "process/signal")

    try:
        for signal_number in sorted(INTERRUPT_SIGNALS):
            previous[signal_number] = signal.signal(
                signal_number,
                interrupt_handler,
            )
    except BaseException:
        for signal_number, handler in reversed(tuple(previous.items())):
            try:
                signal.signal(signal_number, handler)
            except BaseException:
                pass
        raise
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
        upgrade_artifact_verifier(
            source_root=values["--source-root"],
            expected_current_receipt_sha256=values[
                "--expected-current-receipt-sha256"
            ],
            expected_target_commit_sha=values[
                "--expected-target-commit-sha"
            ],
            expected_target_manifest_sha256=values[
                "--expected-target-manifest-sha256"
            ],
            success_stream=sys.stdout,
            _signal_state=signal_state,
        )
        return 0
    except (VerifierUpgradeError, BOOTSTRAP.VerifierBootstrapError) as error:
        if signal_state["commitCompleted"]:
            return 0
        try:
            sys.stderr.write(f"{format_verifier_upgrade_error(error)}\n")
            sys.stderr.flush()
        except Exception:
            pass
        return 1
    except BaseException:
        if signal_state["commitCompleted"]:
            return 0
        try:
            sys.stderr.write(
                "[VERIFIER_UPGRADE_INTERNAL] "
                "verifier 组件升级发生未分类错误；底层细节已抑制。\n"
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

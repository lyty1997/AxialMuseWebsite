import base64
import binascii
import ctypes
import errno
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import stat
import struct
import sys
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path


FILE_TREE_WIRE_MAGIC = "AXIALMUSE-FILE-TREE-V1"
PUBLIC_ROUTES_WIRE_MAGIC = "AXIALMUSE-PUBLIC-ROUTES-V1"
FILE_TREE_MAX_FILES = 65_536
FILE_TREE_MAX_DEPTH = 64
FILE_TREE_MAX_SEGMENT_BYTES = 255
FILE_TREE_MAX_PATH_BYTES = 4_096
FILE_TREE_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
FILE_TREE_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024
MAX_METADATA_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_DIRECTORIES = FILE_TREE_MAX_FILES * 2
MAX_ARCHIVE_MEMBERS = FILE_TREE_MAX_FILES + MAX_ARCHIVE_DIRECTORIES
MAX_DIRECTORY_ENTRY_COMPRESSED_BYTES = 1_024
MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024
READ_CHUNK_BYTES = 64 * 1024

ARTIFACT_BASENAME = "artifact.zip"
VERIFIED_RELEASE_BASENAME = "verified-release"
RELEASE_SCHEMA_VERSION = "1.0.0"
RELEASE_REPOSITORY = "lyty1997/AxialMuseWebsite"
RELEASE_PAYLOAD_ROOT = "payload"
RELEASE_JSON_PATH = "metadata/release.json"
RELEASE_FILES_PATH = "metadata/files.sha256"
RELEASE_RUNTIME_REDIRECTS_PATH = "metadata/runtime-redirects.json"
RELEASE_NGINX_REDIRECTS_PATH = "metadata/nginx/redirects.conf"
RUNTIME_REDIRECT_SCHEMA_VERSION = "1.0.0"
CANONICAL_ORIGIN = "https://www.axialmuse.com"

HEX_64_PATTERN = re.compile(r"^[0-9a-f]{64}$", re.ASCII)
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$", re.ASCII)
CANONICAL_PAGE_PATH_PATTERN = re.compile(
    r"^/(?:[a-z0-9]+(?:-[a-z0-9]+)*/)*$",
    re.ASCII,
)
RULE_SOURCE_PATH_PATTERN = re.compile(
    r"^/(?:[a-z0-9]+(?:-[a-z0-9]+)*/)*"
    r"[a-z0-9]+(?:-[a-z0-9]+)*/?$",
    re.ASCII,
)
HTML_SUFFIX_PATTERN = re.compile(r"\.(?:html?|xhtml)$", re.IGNORECASE | re.ASCII)
RESERVED_ROUTE_PREFIXES = ("/assets", "/img", "/.well-known")
RESERVED_ROUTE_FILES = frozenset(("/404.html", "/robots.txt", "/sitemap.xml"))
RELEASE_METADATA_KEYS = (
    "schemaVersion",
    "repository",
    "commitSha",
    "payloadRoot",
    "sourceBuildTreeSha256",
    "redirectRegistrySha256",
    "publicRoutesSha256",
    "runtimeRedirectsSha256",
    "nginxRedirectsSha256",
    "registeredRuleCount",
    "canonicalSlashRuleCount",
    "ruleCount",
    "filesSha256",
    "fileCount",
)
RUNTIME_METADATA_KEYS = ("schemaVersion", "canonicalOrigin", "rules")
RUNTIME_RULE_KEYS = ("kind", "from", "to")
ALLOWED_COMPRESSION = frozenset((zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED))
HARDLINK_EXTRA_FIELD_IDS = frozenset((0x000D, 0x756E))
EXPECTED_PYTHON = (3, 12)
EXPECTED_PYTHON_REALPATH = "/usr/bin/python3.12"
GOLDEN_BASENAME = "file-tree-v1-golden.json"
PATH_UNICODE_VERSION = "15.0.0"
INTERRUPT_SIGNALS = frozenset((signal.SIGINT, signal.SIGTERM))
SELF_TEST_GOLDEN_FD_ENVIRONMENT = "AXIALMUSE_SELF_TEST_GOLDEN_FD"
RENAME_NOREPLACE = 1
ZIP_EOCD_SIGNATURE = b"PK\x05\x06"
ZIP64_EOCD_SIGNATURE = b"PK\x06\x06"
ZIP64_LOCATOR_SIGNATURE = b"PK\x06\x07"
ZIP_CENTRAL_SIGNATURE = b"PK\x01\x02"
ZIP_LOCAL_SIGNATURE = b"PK\x03\x04"

ERROR_MESSAGES = {
    "SERVER_ARTIFACT_RUNTIME": "服务器 verifier 运行时不符合固定 Ubuntu Python 基线。",
    "SERVER_ARTIFACT_ARGUMENT": "服务器 verifier 参数不符合固定接口。",
    "SERVER_ARTIFACT_STAGING": "staging root 的身份、权限或成员不合法。",
    "SERVER_ARTIFACT_ARCHIVE": "artifact 不是稳定的单链接普通 ZIP 文件。",
    "SERVER_ARTIFACT_DIGEST": "artifact 外层摘要与独立期望值不一致。",
    "SERVER_ARTIFACT_ARCHIVE_FORMAT": "artifact ZIP 结构或编码不合法。",
    "SERVER_ARTIFACT_ARCHIVE_PATH": "artifact ZIP 含不规范或越界路径。",
    "SERVER_ARTIFACT_ARCHIVE_ENTRY": "artifact ZIP 含链接、特殊或不受支持的成员。",
    "SERVER_ARTIFACT_ARCHIVE_LIMIT": "artifact ZIP 超出受控资源上限。",
    "SERVER_ARTIFACT_EXTRACT": "artifact 无法完整、安全地提取到私有候选。",
    "SERVER_ARTIFACT_FILE_TREE": "release 文件树不符合规范 wire contract。",
    "SERVER_ARTIFACT_RELEASE_DIGEST": "release 整树摘要与 artifact 外独立期望值不一致。",
    "SERVER_ARTIFACT_LAYOUT": "release 文件集合不符合固定布局。",
    "SERVER_ARTIFACT_MANIFEST": "内部逐文件清单与 release 文件集合不一致。",
    "SERVER_ARTIFACT_METADATA": "release metadata 与已验证输入或派生证据不一致。",
    "SERVER_ARTIFACT_ROUTES": "payload 公开路由集合或摘要不合法。",
    "SERVER_ARTIFACT_REDIRECTS": "运行时重定向清单不符合规则闭包。",
    "SERVER_ARTIFACT_NGINX": "Nginx 配置无法由已验证规则精确重建。",
    "SERVER_ARTIFACT_CHANGED": "artifact、staging 或 release 在验证期间发生变化。",
    "SERVER_ARTIFACT_ACTIVATE": "已验证 staging 无法原子形成。",
    "SERVER_ARTIFACT_CLEANUP": "失败候选身份不确定或无法安全清理。",
    "SERVER_ARTIFACT_INTERRUPTED": "服务器 verifier 被中断，未形成已验证 staging。",
}


class ServerArtifactError(Exception):
    def __init__(self, code, source_path, *, cause=None):
        super().__init__(ERROR_MESSAGES.get(code, "服务器 artifact 校验失败。"))
        self.code = code
        self.source_path = _safe_source_path(source_path)
        self.cause = cause
        self.__traceback__ = None


@dataclass(frozen=True)
class FileRecord:
    path: str
    byte_length: int
    sha256: str


@dataclass(frozen=True)
class FileTreeCapture:
    root_identity: tuple
    records: tuple
    operational_entries: tuple
    tree_sha256: str


@dataclass(frozen=True)
class ArchiveEntry:
    info: zipfile.ZipInfo
    path: str
    is_directory: bool


@dataclass(frozen=True)
class ArchivePlan:
    entries: tuple
    directories: tuple
    files: tuple


@dataclass(frozen=True)
class ZipEnvelope:
    member_count: int
    central_directory_size: int
    central_directory_offset: int


def _safe_source_path(value):
    if not isinstance(value, str) or not value or len(value) > FILE_TREE_MAX_PATH_BYTES:
        return "artifact/unknown"
    if value.startswith("/") or "\\" in value or _contains_control(value):
        return "artifact/unknown"
    segments = value.split("/")
    if any(segment in ("", ".", "..") for segment in segments):
        return "artifact/unknown"
    return value


def _fail(code, source_path, cause=None):
    raise ServerArtifactError(code, source_path, cause=cause)


def format_server_artifact_error(error):
    if not isinstance(error, ServerArtifactError):
        return (
            "[SERVER_ARTIFACT_INTERNAL] "
            "服务器 artifact 校验发生未分类错误；底层细节已抑制。"
        )
    return f"[{error.code}] ({error.source_path}) {error}"


def _contains_control(value):
    return any(
        ord(character) <= 0x1F
        or 0x7F <= ord(character) <= 0x9F
        or ord(character) in (0x2028, 0x2029)
        for character in value
    )


def _assert_runtime():
    if (
        sys.platform != "linux"
        or sys.version_info[:2] != EXPECTED_PYTHON
        or os.path.realpath(sys.executable) != EXPECTED_PYTHON_REALPATH
    ):
        _fail("SERVER_ARTIFACT_RUNTIME", "runtime/python")


def _assert_hex(value, source_path):
    if not isinstance(value, str) or HEX_64_PATTERN.fullmatch(value) is None:
        _fail("SERVER_ARTIFACT_ARGUMENT", source_path)
    return value


def _assert_commit(value, source_path):
    if not isinstance(value, str) or COMMIT_PATTERN.fullmatch(value) is None:
        _fail("SERVER_ARTIFACT_ARGUMENT", source_path)
    return value


def _stat_identity(metadata):
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


def _directory_ownership_identity(metadata):
    return (
        metadata.st_dev,
        metadata.st_ino,
        stat.S_IFMT(metadata.st_mode),
        stat.S_IMODE(metadata.st_mode),
        metadata.st_uid,
        metadata.st_gid,
    )


def _same_file_identity(left, right):
    return _stat_identity(left) == _stat_identity(right)


def _list_directory_bytes(descriptor):
    names = []
    for name in os.listdir(descriptor):
        encoded = os.fsencode(name)
        encoded.decode("utf-8", "strict")
        names.append(encoded)
    return tuple(sorted(names))


def _open_owned_private_directory(path):
    descriptor = None
    try:
        if (
            not isinstance(path, str)
            or not os.path.isabs(path)
            or os.path.normpath(path) != path
            or os.path.realpath(path) != path
        ):
            raise ValueError("staging root is not canonical")
        path_before = os.lstat(path)
        descriptor = os.open(
            path,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        )
        held_metadata = os.fstat(descriptor)
        path_after = os.lstat(path)
        expected_identity = _directory_ownership_identity(held_metadata)
        if (
            stat.S_ISLNK(path_before.st_mode)
            or not stat.S_ISDIR(path_before.st_mode)
            or not stat.S_ISDIR(held_metadata.st_mode)
            or stat.S_ISLNK(path_after.st_mode)
            or not stat.S_ISDIR(path_after.st_mode)
            or _directory_ownership_identity(path_before) != expected_identity
            or _directory_ownership_identity(path_after) != expected_identity
            or held_metadata.st_uid != os.geteuid()
            or stat.S_IMODE(held_metadata.st_mode) != 0o700
            or _list_directory_bytes(descriptor)
            != (ARTIFACT_BASENAME.encode("ascii"),)
        ):
            raise ValueError("staging root ownership is invalid")
        result = (descriptor, expected_identity)
        descriptor = None
        return result
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_STAGING", "staging", cause)
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _assert_staging_root_identity(
    path,
    held_descriptor,
    expected,
    expected_members,
):
    fresh_descriptor = None
    try:
        held_metadata = os.fstat(held_descriptor)
        path_before = os.lstat(path)
        fresh_descriptor = os.open(
            path,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        )
        fresh_metadata = os.fstat(fresh_descriptor)
        held_members = _list_directory_bytes(held_descriptor)
        fresh_members = _list_directory_bytes(fresh_descriptor)
        path_after = os.lstat(path)
        if (
            not stat.S_ISDIR(held_metadata.st_mode)
            or not stat.S_ISDIR(fresh_metadata.st_mode)
            or stat.S_ISLNK(path_before.st_mode)
            or not stat.S_ISDIR(path_before.st_mode)
            or stat.S_ISLNK(path_after.st_mode)
            or not stat.S_ISDIR(path_after.st_mode)
            or any(
                _directory_ownership_identity(metadata) != expected
                for metadata in (
                    held_metadata,
                    path_before,
                    fresh_metadata,
                    path_after,
                )
            )
            or held_members != tuple(sorted(expected_members))
            or fresh_members != held_members
        ):
            raise ValueError("staging root changed")
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_CHANGED", "staging", cause)
    finally:
        if fresh_descriptor is not None:
            try:
                os.close(fresh_descriptor)
            except OSError as cause:
                _fail("SERVER_ARTIFACT_CHANGED", "staging", cause)


def _open_stable_artifact(staging_descriptor):
    descriptor = None
    stream = None
    try:
        basename = ARTIFACT_BASENAME.encode("ascii")
        path_metadata = os.stat(
            basename,
            dir_fd=staging_descriptor,
            follow_symlinks=False,
        )
        if (
            stat.S_ISLNK(path_metadata.st_mode)
            or not stat.S_ISREG(path_metadata.st_mode)
            or path_metadata.st_nlink != 1
            or path_metadata.st_uid != os.geteuid()
            or stat.S_IMODE(path_metadata.st_mode) != 0o600
        ):
            raise ValueError("artifact path identity is invalid")
        descriptor = os.open(
            basename,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            dir_fd=staging_descriptor,
        )
        descriptor_metadata = os.fstat(descriptor)
        if not _same_file_identity(path_metadata, descriptor_metadata):
            raise ValueError("artifact changed before open")
        stream = os.fdopen(descriptor, "rb", closefd=True)
        descriptor = None
        return stream, _stat_identity(descriptor_metadata)
    except Exception as cause:
        if stream is not None:
            try:
                stream.close()
            except Exception:
                pass
        elif descriptor is not None:
            try:
                os.close(descriptor)
            except Exception:
                pass
        if isinstance(cause, ServerArtifactError):
            raise
        _fail("SERVER_ARTIFACT_ARCHIVE", ARTIFACT_BASENAME, cause)


def _assert_artifact_identity(staging_descriptor, stream, expected):
    try:
        descriptor_metadata = os.fstat(stream.fileno())
        path_metadata = os.stat(
            ARTIFACT_BASENAME.encode("ascii"),
            dir_fd=staging_descriptor,
            follow_symlinks=False,
        )
        if (
            _stat_identity(descriptor_metadata) != expected
            or _stat_identity(path_metadata) != expected
            or not stat.S_ISREG(descriptor_metadata.st_mode)
            or descriptor_metadata.st_nlink != 1
        ):
            raise ValueError("artifact identity changed")
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_CHANGED", ARTIFACT_BASENAME, cause)


def _hash_open_stream(stream):
    digest = hashlib.sha256()
    try:
        stream.seek(0)
        while True:
            chunk = stream.read(READ_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
        stream.seek(0)
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_ARCHIVE", ARTIFACT_BASENAME, cause)
    return digest.hexdigest()


def _read_exact_at(stream, offset, length, source_path):
    try:
        if (
            not isinstance(offset, int)
            or not isinstance(length, int)
            or offset < 0
            or length < 0
        ):
            raise ValueError("invalid bounded ZIP read")
        stream.seek(offset)
        value = stream.read(length)
        if len(value) != length:
            raise ValueError("truncated ZIP structure")
        return value
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_ARCHIVE_FORMAT", source_path, cause)


def _preflight_zip_envelope(stream):
    source_path = "artifact.zip#envelope"
    try:
        metadata = os.fstat(stream.fileno())
        archive_size = metadata.st_size
        if archive_size < 22:
            raise ValueError("ZIP is smaller than EOCD")

        eocd_offset = archive_size - 22
        eocd = _read_exact_at(stream, eocd_offset, 22, source_path)
        (
            signature,
            disk_number,
            central_disk_number,
            disk_member_count,
            member_count_16,
            central_size_32,
            central_offset_32,
            comment_length,
        ) = struct.unpack("<4sHHHHIIH", eocd)
        if (
            signature != ZIP_EOCD_SIGNATURE
            or comment_length != 0
            or disk_number != 0
            or central_disk_number != 0
        ):
            raise ValueError("unsupported EOCD")

        uses_zip64 = (
            disk_member_count == 0xFFFF
            or member_count_16 == 0xFFFF
            or central_size_32 == 0xFFFFFFFF
            or central_offset_32 == 0xFFFFFFFF
        )
        central_end = eocd_offset
        if uses_zip64:
            locator_offset = eocd_offset - 20
            locator = _read_exact_at(stream, locator_offset, 20, source_path)
            (
                locator_signature,
                zip64_disk_number,
                zip64_eocd_offset,
                zip64_disk_count,
            ) = struct.unpack("<4sIQI", locator)
            if (
                locator_signature != ZIP64_LOCATOR_SIGNATURE
                or zip64_disk_number != 0
                or zip64_disk_count != 1
            ):
                raise ValueError("unsupported ZIP64 locator")
            zip64_header = _read_exact_at(
                stream,
                zip64_eocd_offset,
                56,
                source_path,
            )
            (
                zip64_signature,
                zip64_record_size,
                _made_by_version,
                _required_version,
                zip64_disk,
                zip64_central_disk,
                zip64_disk_members,
                zip64_member_count,
                zip64_central_size,
                zip64_central_offset,
            ) = struct.unpack("<4sQHHIIQQQQ", zip64_header)
            if (
                zip64_signature != ZIP64_EOCD_SIGNATURE
                or zip64_record_size != 44
                or zip64_disk != 0
                or zip64_central_disk != 0
                or zip64_disk_members != zip64_member_count
                or zip64_eocd_offset + 56 != locator_offset
            ):
                raise ValueError("unsupported ZIP64 EOCD")
            if (
                disk_member_count != 0xFFFF
                and disk_member_count != zip64_disk_members
            ) or (
                member_count_16 != 0xFFFF
                and member_count_16 != zip64_member_count
            ) or (
                central_size_32 != 0xFFFFFFFF
                and central_size_32 != zip64_central_size
            ) or (
                central_offset_32 != 0xFFFFFFFF
                and central_offset_32 != zip64_central_offset
            ):
                raise ValueError("ZIP64 values disagree with EOCD")
            member_count = zip64_member_count
            central_size = zip64_central_size
            central_offset = zip64_central_offset
            central_end = zip64_eocd_offset
        else:
            if disk_member_count != member_count_16:
                raise ValueError("multi-disk ZIP is unsupported")
            member_count = member_count_16
            central_size = central_size_32
            central_offset = central_offset_32

        if (
            member_count <= 0
            or member_count > MAX_ARCHIVE_MEMBERS
            or central_size < member_count * 46
            or central_size > MAX_CENTRAL_DIRECTORY_BYTES
            or central_offset < 4
            or central_offset + central_size != central_end
        ):
            _fail("SERVER_ARTIFACT_ARCHIVE_LIMIT", source_path)
        if (
            _read_exact_at(stream, 0, 4, source_path) != ZIP_LOCAL_SIGNATURE
            or _read_exact_at(stream, central_offset, 4, source_path)
            != ZIP_CENTRAL_SIGNATURE
        ):
            raise ValueError("ZIP boundaries are not canonical")
        stream.seek(0)
        return ZipEnvelope(
            member_count=member_count,
            central_directory_size=central_size,
            central_directory_offset=central_offset,
        )
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_ARCHIVE_FORMAT", source_path, cause)


def _validate_relative_path(
    value,
    source_path,
    *,
    error_code="SERVER_ARTIFACT_ARCHIVE_PATH",
):
    if not isinstance(value, str) or not value:
        _fail(error_code, source_path)
    try:
        path_bytes = value.encode("utf-8", "strict")
    except UnicodeError as cause:
        _fail(error_code, source_path, cause)
    if (
        value.startswith("/")
        or "\\" in value
        or _contains_control(value)
        or any(
            unicodedata.category(character) == "Cn"
            for character in value
        )
        or unicodedata.normalize("NFC", value) != value
        or len(path_bytes) > FILE_TREE_MAX_PATH_BYTES
    ):
        _fail(error_code, source_path)
    segments = value.split("/")
    if not segments or len(segments) > FILE_TREE_MAX_DEPTH:
        _fail(error_code, source_path)
    for segment in segments:
        try:
            segment_bytes = segment.encode("utf-8", "strict")
        except UnicodeError as cause:
            _fail(error_code, source_path, cause)
        if (
            not segment
            or segment in (".", "..")
            or segment.startswith(".")
            or "/" in segment
            or "\\" in segment
            or _contains_control(segment)
            or unicodedata.normalize("NFC", segment) != segment
            or len(segment_bytes) > FILE_TREE_MAX_SEGMENT_BYTES
        ):
            _fail(error_code, source_path)
    return path_bytes


def _parse_extra_field_ids(extra, source_path):
    offset = 0
    identifiers = []
    while offset < len(extra):
        if len(extra) - offset < 4:
            _fail("SERVER_ARTIFACT_ARCHIVE_FORMAT", source_path)
        identifier, length = struct.unpack_from("<HH", extra, offset)
        offset += 4
        if len(extra) - offset < length:
            _fail("SERVER_ARTIFACT_ARCHIVE_FORMAT", source_path)
        identifiers.append(identifier)
        offset += length
    return tuple(identifiers)


def _validate_archive_member_type(info, is_directory, source_path):
    unix_mode = (info.external_attr >> 16) & 0xFFFF
    member_type = stat.S_IFMT(unix_mode)
    if is_directory:
        if (
            info.file_size != 0
            or info.compress_size < 0
            or info.compress_size > MAX_DIRECTORY_ENTRY_COMPRESSED_BYTES
        ):
            _fail("SERVER_ARTIFACT_ARCHIVE_ENTRY", source_path)
        if member_type not in (0, stat.S_IFDIR):
            _fail("SERVER_ARTIFACT_ARCHIVE_ENTRY", source_path)
    elif member_type not in (0, stat.S_IFREG):
        _fail("SERVER_ARTIFACT_ARCHIVE_ENTRY", source_path)
    extra_ids = _parse_extra_field_ids(info.extra, source_path)
    if any(identifier in HARDLINK_EXTRA_FIELD_IDS for identifier in extra_ids):
        _fail("SERVER_ARTIFACT_ARCHIVE_ENTRY", source_path)


def _plan_archive(archive, envelope):
    try:
        infos = archive.infolist()
        if archive.comment:
            _fail("SERVER_ARTIFACT_ARCHIVE_FORMAT", "artifact.zip#comment")
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_ARCHIVE_FORMAT", ARTIFACT_BASENAME, cause)
    if (
        not isinstance(envelope, ZipEnvelope)
        or len(infos) != envelope.member_count
        or len(infos) > MAX_ARCHIVE_MEMBERS
    ):
        _fail("SERVER_ARTIFACT_ARCHIVE_LIMIT", "artifact.zip#members")

    entries = []
    exact_paths = set()
    folded_paths = set()
    file_paths = set()
    directory_paths = set()
    total_bytes = 0
    file_count = 0

    for index, info in enumerate(infos):
        source_path = f"artifact.zip#entries[{index}]"
        try:
            original_name = info.orig_filename
            decoded_name = info.filename
        except ServerArtifactError:
            raise
        except Exception as cause:
            _fail("SERVER_ARTIFACT_ARCHIVE_FORMAT", source_path, cause)
        if (
            not isinstance(original_name, str)
            or original_name != decoded_name
            or "\x00" in original_name
            or not original_name
            or bool(info.comment)
            or (info.flag_bits & 0x1) != 0
            or (info.flag_bits & 0x40) != 0
            or info.compress_type not in ALLOWED_COMPRESSION
        ):
            _fail("SERVER_ARTIFACT_ARCHIVE_ENTRY", source_path)
        if any(ord(character) > 0x7F for character in original_name):
            if (info.flag_bits & 0x800) == 0:
                _fail("SERVER_ARTIFACT_ARCHIVE_PATH", source_path)

        is_directory = original_name.endswith("/")
        path = original_name[:-1] if is_directory else original_name
        if not path or (is_directory and original_name.endswith("//")):
            _fail("SERVER_ARTIFACT_ARCHIVE_PATH", source_path)
        path_bytes = _validate_relative_path(path, source_path)
        segments = path.split("/")
        if segments[0] not in ("payload", "metadata"):
            _fail("SERVER_ARTIFACT_ARCHIVE_PATH", source_path)
        if not is_directory and len(segments) < 2:
            _fail("SERVER_ARTIFACT_ARCHIVE_PATH", source_path)
        _validate_archive_member_type(info, is_directory, source_path)

        exact_key = path_bytes
        folded_key = path.lower()
        if exact_key in exact_paths or folded_key in folded_paths:
            _fail("SERVER_ARTIFACT_ARCHIVE_PATH", source_path)
        exact_paths.add(exact_key)
        folded_paths.add(folded_key)

        if is_directory:
            directory_paths.add(path)
        else:
            file_paths.add(path)
            file_count += 1
            if file_count > FILE_TREE_MAX_FILES:
                _fail("SERVER_ARTIFACT_ARCHIVE_LIMIT", source_path)
            if info.file_size < 0 or info.file_size > FILE_TREE_MAX_FILE_BYTES:
                _fail("SERVER_ARTIFACT_ARCHIVE_LIMIT", source_path)
            total_bytes += info.file_size
            if total_bytes > FILE_TREE_MAX_TOTAL_BYTES:
                _fail("SERVER_ARTIFACT_ARCHIVE_LIMIT", source_path)
        entries.append(ArchiveEntry(info=info, path=path, is_directory=is_directory))

    if not file_paths:
        _fail("SERVER_ARTIFACT_LAYOUT", "release")
    for path in file_paths:
        segments = path.split("/")
        for index in range(1, len(segments)):
            ancestor = "/".join(segments[:index])
            if ancestor in file_paths:
                _fail("SERVER_ARTIFACT_ARCHIVE_PATH", "artifact.zip#prefix")
    file_directories = set()
    for path in file_paths:
        segments = path.split("/")
        file_directories.update(
            "/".join(segments[:index])
            for index in range(1, len(segments))
        )
    for path in directory_paths:
        if path in file_paths:
            _fail("SERVER_ARTIFACT_ARCHIVE_PATH", "artifact.zip#prefix")
        if path not in file_directories:
            _fail("SERVER_ARTIFACT_LAYOUT", "artifact.zip#empty-directory")

    implicit_directories = file_directories | directory_paths
    if len(implicit_directories) > MAX_ARCHIVE_DIRECTORIES:
        _fail("SERVER_ARTIFACT_ARCHIVE_LIMIT", "artifact.zip#directories")

    semantic_paths = {}
    folded_semantic_paths = {}

    def register_semantic_path(path, kind):
        existing_kind = semantic_paths.get(path)
        if existing_kind is not None and existing_kind != kind:
            _fail("SERVER_ARTIFACT_ARCHIVE_PATH", "artifact.zip#prefix")
        folded_path = path.lower()
        existing_path = folded_semantic_paths.get(folded_path)
        if existing_path is not None and existing_path != path:
            _fail("SERVER_ARTIFACT_ARCHIVE_PATH", "artifact.zip#case-collision")
        semantic_paths[path] = kind
        folded_semantic_paths[folded_path] = path

    for path in implicit_directories:
        register_semantic_path(path, "directory")
    for path in file_paths:
        register_semantic_path(path, "file")

    directories = tuple(
        sorted(
            implicit_directories,
            key=lambda value: (value.count("/"), value.encode("utf-8")),
        )
    )
    files = tuple(
        sorted(
            (entry for entry in entries if not entry.is_directory),
            key=lambda entry: entry.path.encode("utf-8"),
        )
    )
    return ArchivePlan(
        entries=tuple(entries),
        directories=directories,
        files=files,
    )


def _open_relative_directory(root_descriptor, segments, *, create):
    descriptor = os.dup(root_descriptor)
    try:
        for segment in segments:
            segment_bytes = segment.encode("utf-8")
            if create:
                try:
                    os.mkdir(segment_bytes, 0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            next_descriptor = os.open(
                segment_bytes,
                os.O_RDONLY
                | os.O_DIRECTORY
                | os.O_NOFOLLOW
                | os.O_CLOEXEC,
                dir_fd=descriptor,
            )
            metadata = os.fstat(next_descriptor)
            if (
                not stat.S_ISDIR(metadata.st_mode)
                or stat.S_ISLNK(metadata.st_mode)
                or metadata.st_uid != os.geteuid()
                or stat.S_IMODE(metadata.st_mode) != 0o700
            ):
                os.close(next_descriptor)
                raise ValueError("relative directory identity is invalid")
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _ensure_relative_directory(root_descriptor, relative_path):
    descriptor = _open_relative_directory(
        root_descriptor,
        relative_path.split("/"),
        create=True,
    )
    os.close(descriptor)


def _write_all(descriptor, chunk):
    offset = 0
    while offset < len(chunk):
        written = os.write(descriptor, chunk[offset:])
        if written <= 0:
            raise OSError("short write")
        offset += written


def _extract_file(archive, entry, root_descriptor):
    segments = entry.path.split("/")
    parent_descriptor = None
    output_descriptor = None
    try:
        parent_descriptor = _open_relative_directory(
            root_descriptor,
            segments[:-1],
            create=False,
        )
        output_descriptor = os.open(
            segments[-1].encode("utf-8"),
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | os.O_NOFOLLOW
            | os.O_CLOEXEC,
            0o600,
            dir_fd=parent_descriptor,
        )
        byte_length = 0
        with archive.open(entry.info, "r") as source:
            while True:
                chunk = source.read(READ_CHUNK_BYTES)
                if not chunk:
                    break
                byte_length += len(chunk)
                if (
                    byte_length > entry.info.file_size
                    or byte_length > FILE_TREE_MAX_FILE_BYTES
                ):
                    _fail("SERVER_ARTIFACT_ARCHIVE_LIMIT", "artifact.zip#entry")
                _write_all(output_descriptor, chunk)
        if byte_length != entry.info.file_size:
            raise ValueError("extracted byte length differs from central directory")
        os.fchmod(output_descriptor, 0o600)
        os.fsync(output_descriptor)
        metadata = os.fstat(output_descriptor)
        path_metadata = os.stat(
            segments[-1].encode("utf-8"),
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_uid != os.geteuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or not _same_file_identity(metadata, path_metadata)
            or metadata.st_size != byte_length
        ):
            raise ValueError("extracted file identity is invalid")
    except ServerArtifactError:
        raise
    except (OSError, RuntimeError, ValueError, zipfile.BadZipFile) as cause:
        _fail("SERVER_ARTIFACT_EXTRACT", "artifact.zip#entry", cause)
    finally:
        if output_descriptor is not None:
            try:
                os.close(output_descriptor)
            except OSError as cause:
                _fail("SERVER_ARTIFACT_EXTRACT", "artifact.zip#entry", cause)
        if parent_descriptor is not None:
            try:
                os.close(parent_descriptor)
            except OSError as cause:
                _fail("SERVER_ARTIFACT_EXTRACT", "artifact.zip#entry", cause)


def _fsync_directory_tree(root_descriptor, directory_paths):
    try:
        for relative_path in sorted(
            directory_paths,
            key=lambda value: value.count("/"),
            reverse=True,
        ):
            descriptor = _open_relative_directory(
                root_descriptor,
                relative_path.split("/"),
                create=False,
            )
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        os.fsync(root_descriptor)
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_EXTRACT", "verified-candidate", cause)


def _extract_archive(archive, plan, candidate_descriptor):
    try:
        for directory in plan.directories:
            _ensure_relative_directory(candidate_descriptor, directory)
        for entry in plan.entries:
            if not entry.is_directory:
                continue
            try:
                with archive.open(entry.info, "r") as source:
                    if source.read(1):
                        raise ValueError("directory entry produced content")
            except (
                OSError,
                RuntimeError,
                ValueError,
                zipfile.BadZipFile,
            ) as cause:
                _fail("SERVER_ARTIFACT_EXTRACT", "artifact.zip#directory", cause)
        for entry in plan.files:
            _extract_file(archive, entry, candidate_descriptor)
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_EXTRACT", "verified-candidate", cause)
    _fsync_directory_tree(candidate_descriptor, plan.directories)


def _read_stable_file(parent_descriptor, basename, source_path):
    descriptor = None
    try:
        path_before = os.stat(
            basename,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
        if (
            stat.S_ISLNK(path_before.st_mode)
            or not stat.S_ISREG(path_before.st_mode)
            or path_before.st_nlink != 1
            or path_before.st_size > FILE_TREE_MAX_FILE_BYTES
        ):
            raise ValueError("file is not an ordinary single-link member")
        descriptor = os.open(
            basename,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            dir_fd=parent_descriptor,
        )
        descriptor_before = os.fstat(descriptor)
        if not _same_file_identity(path_before, descriptor_before):
            raise ValueError("file changed before read")
        digest = hashlib.sha256()
        expected_bytes = descriptor_before.st_size
        byte_length = 0
        while byte_length < expected_bytes:
            chunk = os.read(
                descriptor,
                min(READ_CHUNK_BYTES, expected_bytes - byte_length),
            )
            if not chunk:
                raise ValueError("file ended during read")
            digest.update(chunk)
            byte_length += len(chunk)
        if os.read(descriptor, 1):
            raise ValueError("file grew during read")
        descriptor_after = os.fstat(descriptor)
        path_after = os.stat(
            basename,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
        if (
            not _same_file_identity(descriptor_before, descriptor_after)
            or not _same_file_identity(descriptor_after, path_after)
            or byte_length != expected_bytes
        ):
            raise ValueError("file changed while read")
        return FileRecord(
            path="",
            byte_length=byte_length,
            sha256=digest.hexdigest(),
        ), _stat_identity(descriptor_after)
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_FILE_TREE", source_path, cause)
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError as cause:
                _fail("SERVER_ARTIFACT_FILE_TREE", source_path, cause)


def digest_file_tree_records(records):
    if not isinstance(records, (list, tuple)) or len(records) > FILE_TREE_MAX_FILES:
        _fail("SERVER_ARTIFACT_FILE_TREE", "file-tree")
    normalized = []
    exact_paths = set()
    folded_paths = set()
    directories = set()
    total_bytes = 0
    for index, record in enumerate(records):
        source_path = f"file-tree/records[{index}]"
        if not isinstance(record, FileRecord):
            _fail("SERVER_ARTIFACT_FILE_TREE", source_path)
        path_bytes = _validate_relative_path(
            record.path,
            source_path,
            error_code="SERVER_ARTIFACT_FILE_TREE",
        )
        if (
            not isinstance(record.byte_length, int)
            or isinstance(record.byte_length, bool)
            or record.byte_length < 0
            or record.byte_length > FILE_TREE_MAX_FILE_BYTES
            or not isinstance(record.sha256, str)
            or HEX_64_PATTERN.fullmatch(record.sha256) is None
        ):
            _fail("SERVER_ARTIFACT_FILE_TREE", source_path)
        folded_path = record.path.lower()
        if path_bytes in exact_paths or folded_path in folded_paths:
            _fail("SERVER_ARTIFACT_FILE_TREE", source_path)
        exact_paths.add(path_bytes)
        folded_paths.add(folded_path)
        segments = record.path.split("/")
        for path_index in range(1, len(segments)):
            directories.add("/".join(segments[:path_index]))
            if len(directories) > MAX_ARCHIVE_DIRECTORIES:
                _fail("SERVER_ARTIFACT_FILE_TREE", source_path)
        total_bytes += record.byte_length
        if total_bytes > FILE_TREE_MAX_TOTAL_BYTES:
            _fail("SERVER_ARTIFACT_FILE_TREE", source_path)
        normalized.append((path_bytes, record))
    normalized.sort(key=lambda item: item[0])
    digest = hashlib.sha256()
    digest.update(FILE_TREE_WIRE_MAGIC.encode("ascii"))
    digest.update(b"\x00")
    for path_bytes, record in normalized:
        digest.update(struct.pack(">Q", len(path_bytes)))
        digest.update(path_bytes)
        digest.update(struct.pack(">Q", record.byte_length))
        digest.update(bytes.fromhex(record.sha256))
    return digest.hexdigest()


def _capture_file_tree(root_descriptor, source_path):
    try:
        root_metadata = os.fstat(root_descriptor)
        if not stat.S_ISDIR(root_metadata.st_mode):
            raise ValueError("file tree root is not an ordinary directory")
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_FILE_TREE", source_path, cause)

    records = []
    operational_entries = []
    exact_paths = set()
    folded_paths = set()
    directory_count = 0
    total_bytes = 0

    def walk(directory_descriptor, segments):
        nonlocal directory_count, total_bytes
        try:
            directory_before = os.fstat(directory_descriptor)
            if not stat.S_ISDIR(directory_before.st_mode):
                raise ValueError("tree member is not a directory")
            names_before = _list_directory_bytes(directory_descriptor)
        except ServerArtifactError:
            raise
        except Exception as cause:
            _fail("SERVER_ARTIFACT_FILE_TREE", source_path, cause)

        for name_bytes in names_before:
            try:
                name = name_bytes.decode("utf-8", "strict")
            except UnicodeError as cause:
                _fail("SERVER_ARTIFACT_FILE_TREE", source_path, cause)
            relative_path = "/".join((*segments, name))
            path_bytes = _validate_relative_path(
                relative_path,
                source_path,
                error_code="SERVER_ARTIFACT_FILE_TREE",
            )
            folded_path = relative_path.lower()
            if path_bytes in exact_paths or folded_path in folded_paths:
                _fail("SERVER_ARTIFACT_FILE_TREE", source_path)
            exact_paths.add(path_bytes)
            folded_paths.add(folded_path)
            try:
                metadata = os.stat(
                    name_bytes,
                    dir_fd=directory_descriptor,
                    follow_symlinks=False,
                )
            except ServerArtifactError:
                raise
            except Exception as cause:
                _fail("SERVER_ARTIFACT_FILE_TREE", source_path, cause)
            if stat.S_ISLNK(metadata.st_mode):
                _fail("SERVER_ARTIFACT_FILE_TREE", source_path)
            if stat.S_ISDIR(metadata.st_mode):
                directory_count += 1
                if directory_count > MAX_ARCHIVE_DIRECTORIES:
                    _fail("SERVER_ARTIFACT_FILE_TREE", source_path)
                child_descriptor = None
                try:
                    child_descriptor = os.open(
                        name_bytes,
                        os.O_RDONLY
                        | os.O_DIRECTORY
                        | os.O_NOFOLLOW
                        | os.O_CLOEXEC,
                        dir_fd=directory_descriptor,
                    )
                    if not _same_file_identity(
                        metadata,
                        os.fstat(child_descriptor),
                    ):
                        raise ValueError("directory changed before open")
                    walk(child_descriptor, (*segments, name))
                except ServerArtifactError:
                    raise
                except Exception as cause:
                    _fail("SERVER_ARTIFACT_FILE_TREE", source_path, cause)
                finally:
                    if child_descriptor is not None:
                        try:
                            os.close(child_descriptor)
                        except OSError as cause:
                            _fail(
                                "SERVER_ARTIFACT_FILE_TREE",
                                source_path,
                                cause,
                            )
                continue
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                _fail("SERVER_ARTIFACT_FILE_TREE", source_path)
            if len(records) >= FILE_TREE_MAX_FILES:
                _fail("SERVER_ARTIFACT_FILE_TREE", source_path)
            file_record, file_identity = _read_stable_file(
                directory_descriptor,
                name_bytes,
                source_path,
            )
            total_bytes += file_record.byte_length
            if total_bytes > FILE_TREE_MAX_TOTAL_BYTES:
                _fail("SERVER_ARTIFACT_FILE_TREE", source_path)
            records.append(
                FileRecord(
                    path=relative_path,
                    byte_length=file_record.byte_length,
                    sha256=file_record.sha256,
                )
            )
            operational_entries.append(("file", relative_path, file_identity))

        try:
            names_after = _list_directory_bytes(directory_descriptor)
            directory_after = os.fstat(directory_descriptor)
            if (
                names_after != names_before
                or not _same_file_identity(directory_before, directory_after)
            ):
                raise ValueError("directory changed while enumerating")
        except ServerArtifactError:
            raise
        except Exception as cause:
            _fail("SERVER_ARTIFACT_FILE_TREE", source_path, cause)
        operational_entries.append(
            (
                "directory",
                "/".join(segments),
                _stat_identity(directory_after),
                tuple(names_after),
            )
        )

    walk(root_descriptor, ())
    normalized_records = tuple(sorted(records, key=lambda item: item.path.encode("utf-8")))
    return FileTreeCapture(
        root_identity=_stat_identity(root_metadata),
        records=normalized_records,
        operational_entries=tuple(operational_entries),
        tree_sha256=digest_file_tree_records(normalized_records),
    )


def _read_captured_file(
    root_descriptor,
    capture,
    relative_path,
    maximum_bytes,
):
    record = next(
        (item for item in capture.records if item.path == relative_path),
        None,
    )
    if record is None or record.byte_length > maximum_bytes:
        _fail("SERVER_ARTIFACT_LAYOUT", relative_path)
    segments = relative_path.split("/")
    parent_descriptor = None
    descriptor = None
    try:
        parent_descriptor = _open_relative_directory(
            root_descriptor,
            segments[:-1],
            create=False,
        )
        basename = segments[-1].encode("utf-8")
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
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size != record.byte_length
            or not _same_file_identity(path_before, before)
        ):
            raise ValueError("captured file identity is invalid")
        chunks = []
        byte_length = 0
        digest = hashlib.sha256()
        while byte_length < record.byte_length:
            chunk = os.read(
                descriptor,
                min(READ_CHUNK_BYTES, record.byte_length - byte_length),
            )
            if not chunk:
                raise ValueError("captured file ended during read")
            chunks.append(chunk)
            digest.update(chunk)
            byte_length += len(chunk)
        if os.read(descriptor, 1):
            raise ValueError("captured file grew during read")
        after = os.fstat(descriptor)
        path_after = os.stat(
            basename,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
        if (
            not _same_file_identity(before, after)
            or not _same_file_identity(after, path_after)
            or digest.hexdigest() != record.sha256
            or byte_length != record.byte_length
        ):
            raise ValueError("captured file changed")
        return b"".join(chunks)
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_CHANGED", relative_path, cause)
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError as cause:
                _fail("SERVER_ARTIFACT_CHANGED", relative_path, cause)
        if parent_descriptor is not None:
            try:
                os.close(parent_descriptor)
            except OSError as cause:
                _fail("SERVER_ARTIFACT_CHANGED", relative_path, cause)


def _strict_json_loads(raw_bytes, source_path):
    if not isinstance(raw_bytes, bytes) or len(raw_bytes) > MAX_METADATA_BYTES:
        _fail("SERVER_ARTIFACT_METADATA", source_path)
    try:
        text = raw_bytes.decode("utf-8", "strict")
        if text.startswith("\ufeff"):
            raise ValueError("JSON must not contain BOM")

        def object_pairs(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("duplicate JSON key")
                result[key] = value
            return result

        def reject_constant(value):
            raise ValueError(f"non-finite JSON number: {value}")

        return json.loads(
            text,
            object_pairs_hook=object_pairs,
            parse_constant=reject_constant,
        )
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_METADATA", source_path, cause)


def _canonical_json_bytes(value):
    try:
        return (
            json.dumps(
                value,
                ensure_ascii=False,
                indent=2,
                separators=(",", ": "),
            )
            + "\n"
        ).encode("utf-8", "strict")
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_METADATA", "metadata/json", cause)


def _is_safe_integer(value):
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= 9_007_199_254_740_991
    )


def _assert_exact_keys(value, keys, code, source_path):
    if not isinstance(value, dict) or tuple(value.keys()) != tuple(keys):
        _fail(code, source_path)


def _parse_files_manifest(raw_bytes):
    if not raw_bytes or len(raw_bytes) > MAX_METADATA_BYTES:
        _fail("SERVER_ARTIFACT_MANIFEST", RELEASE_FILES_PATH)
    if not raw_bytes.endswith(b"\n") or b"\r" in raw_bytes:
        _fail("SERVER_ARTIFACT_MANIFEST", RELEASE_FILES_PATH)
    entries = []
    exact_paths = set()
    folded_paths = set()
    previous_path_bytes = None
    for index, line in enumerate(raw_bytes.splitlines(keepends=True)):
        source_path = f"{RELEASE_FILES_PATH}#entries[{index}]"
        match = re.fullmatch(rb"([0-9a-f]{64})  ([^\r\n]+)\n", line)
        if match is None:
            _fail("SERVER_ARTIFACT_MANIFEST", source_path)
        try:
            path = match.group(2).decode("utf-8", "strict")
        except UnicodeError as cause:
            _fail("SERVER_ARTIFACT_MANIFEST", source_path, cause)
        path_bytes = _validate_relative_path(
            path,
            source_path,
            error_code="SERVER_ARTIFACT_MANIFEST",
        )
        folded_path = path.lower()
        if (
            path_bytes in exact_paths
            or folded_path in folded_paths
            or (
                previous_path_bytes is not None
                and previous_path_bytes >= path_bytes
            )
        ):
            _fail("SERVER_ARTIFACT_MANIFEST", source_path)
        exact_paths.add(path_bytes)
        folded_paths.add(folded_path)
        previous_path_bytes = path_bytes
        entries.append((path, match.group(1).decode("ascii")))
    if len(entries) > FILE_TREE_MAX_FILES:
        _fail("SERVER_ARTIFACT_MANIFEST", RELEASE_FILES_PATH)
    return tuple(entries)


def _is_reserved_route(route):
    if route in RESERVED_ROUTE_FILES:
        return True
    return any(
        route == prefix
        or route == f"{prefix}/"
        or route.startswith(f"{prefix}/")
        for prefix in RESERVED_ROUTE_PREFIXES
    )


def _assert_canonical_page_route(route, source_path, *, allow_root):
    if (
        not isinstance(route, str)
        or (not allow_root and route == "/")
        or CANONICAL_PAGE_PATH_PATTERN.fullmatch(route) is None
        or _is_reserved_route(route)
    ):
        _fail("SERVER_ARTIFACT_REDIRECTS", source_path)
    return route


def _collect_public_routes(payload_records):
    routes = set()
    for record in payload_records:
        relative_path = record.path
        basename = relative_path.rsplit("/", 1)[-1]
        if HTML_SUFFIX_PATTERN.search(basename) is None:
            continue
        if not relative_path.endswith(".html"):
            _fail("SERVER_ARTIFACT_ROUTES", f"payload/{relative_path}")
        if relative_path == "404.html":
            continue
        if relative_path == "index.html":
            route = "/"
        elif relative_path.endswith("/index.html"):
            route = f"/{relative_path[:-len('index.html')]}"
        else:
            _fail("SERVER_ARTIFACT_ROUTES", f"payload/{relative_path}")
        if (
            CANONICAL_PAGE_PATH_PATTERN.fullmatch(route) is None
            or _is_reserved_route(route)
            or route in routes
        ):
            _fail("SERVER_ARTIFACT_ROUTES", f"payload/{relative_path}")
        routes.add(route)
    if "/" not in routes:
        _fail("SERVER_ARTIFACT_ROUTES", "payload/index.html")
    return tuple(sorted(routes, key=lambda value: value.encode("utf-8")))


def _digest_public_routes(routes):
    digest = hashlib.sha256()
    digest.update(PUBLIC_ROUTES_WIRE_MAGIC.encode("ascii"))
    digest.update(b"\x00")
    previous = None
    for route in routes:
        route_bytes = route.encode("utf-8")
        if previous is not None and previous >= route_bytes:
            _fail("SERVER_ARTIFACT_ROUTES", "payload#routes")
        previous = route_bytes
        digest.update(struct.pack(">Q", len(route_bytes)))
        digest.update(route_bytes)
    return digest.hexdigest()


def _validate_runtime_redirects(raw_bytes, public_routes):
    runtime = _strict_json_loads(raw_bytes, RELEASE_RUNTIME_REDIRECTS_PATH)
    _assert_exact_keys(
        runtime,
        RUNTIME_METADATA_KEYS,
        "SERVER_ARTIFACT_REDIRECTS",
        RELEASE_RUNTIME_REDIRECTS_PATH,
    )
    if (
        runtime["schemaVersion"] != RUNTIME_REDIRECT_SCHEMA_VERSION
        or runtime["canonicalOrigin"] != CANONICAL_ORIGIN
        or not isinstance(runtime["rules"], list)
    ):
        _fail("SERVER_ARTIFACT_REDIRECTS", RELEASE_RUNTIME_REDIRECTS_PATH)
    if _canonical_json_bytes(runtime) != raw_bytes:
        _fail("SERVER_ARTIFACT_REDIRECTS", RELEASE_RUNTIME_REDIRECTS_PATH)

    rules = []
    sources = set()
    previous_source = None
    public_route_set = set(public_routes)
    registered_groups = {}
    canonical_rules = {}
    for index, rule in enumerate(runtime["rules"]):
        source_path = f"{RELEASE_RUNTIME_REDIRECTS_PATH}#rules[{index}]"
        _assert_exact_keys(
            rule,
            RUNTIME_RULE_KEYS,
            "SERVER_ARTIFACT_REDIRECTS",
            source_path,
        )
        kind = rule["kind"]
        source = rule["from"]
        target = rule["to"]
        if (
            kind not in ("registered", "canonical-slash")
            or not isinstance(source, str)
            or RULE_SOURCE_PATH_PATTERN.fullmatch(source) is None
            or _is_reserved_route(source)
        ):
            _fail("SERVER_ARTIFACT_REDIRECTS", source_path)
        _assert_canonical_page_route(target, source_path, allow_root=True)
        if source == target or source in sources:
            _fail("SERVER_ARTIFACT_REDIRECTS", source_path)
        if previous_source is not None and previous_source.encode("ascii") >= source.encode("ascii"):
            _fail("SERVER_ARTIFACT_REDIRECTS", source_path)
        if source in public_route_set or target not in public_route_set:
            _fail("SERVER_ARTIFACT_REDIRECTS", source_path)
        sources.add(source)
        previous_source = source
        if kind == "canonical-slash":
            if source.endswith("/") or target != f"{source}/":
                _fail("SERVER_ARTIFACT_REDIRECTS", source_path)
            canonical_rules[source] = target
        else:
            canonical_source = source if source.endswith("/") else f"{source}/"
            group = registered_groups.setdefault(canonical_source, [])
            group.append((source, target))
        rules.append((kind, source, target))

    if any(target in sources for _, _, target in rules):
        _fail("SERVER_ARTIFACT_REDIRECTS", RELEASE_RUNTIME_REDIRECTS_PATH)
    expected_canonical = {
        route[:-1]: route
        for route in public_routes
        if route != "/"
    }
    if canonical_rules != expected_canonical:
        _fail("SERVER_ARTIFACT_REDIRECTS", RELEASE_RUNTIME_REDIRECTS_PATH)
    for canonical_source, group in registered_groups.items():
        if len(group) != 2:
            _fail("SERVER_ARTIFACT_REDIRECTS", RELEASE_RUNTIME_REDIRECTS_PATH)
        paths = {source for source, _ in group}
        targets = {target for _, target in group}
        if (
            paths != {canonical_source[:-1], canonical_source}
            or len(targets) != 1
        ):
            _fail("SERVER_ARTIFACT_REDIRECTS", RELEASE_RUNTIME_REDIRECTS_PATH)

    registered_rule_count = sum(1 for kind, _, _ in rules if kind == "registered")
    canonical_rule_count = len(rules) - registered_rule_count
    nginx_bytes = "".join(
        f"location = {source} {{\n"
        f"  return 301 {CANONICAL_ORIGIN}{target}$is_args$args;\n"
        "}\n"
        for _, source, target in rules
    ).encode("ascii")
    return {
        "rules": tuple(rules),
        "nginxBytes": nginx_bytes,
        "registeredRuleCount": registered_rule_count,
        "canonicalSlashRuleCount": canonical_rule_count,
        "ruleCount": len(rules),
    }


def _validate_release(candidate_descriptor, release_capture, expected_commit):
    actual_paths = {record.path for record in release_capture.records}
    required_metadata = {
        RELEASE_JSON_PATH,
        RELEASE_FILES_PATH,
        RELEASE_RUNTIME_REDIRECTS_PATH,
        RELEASE_NGINX_REDIRECTS_PATH,
    }
    if not required_metadata.issubset(actual_paths):
        _fail("SERVER_ARTIFACT_LAYOUT", "release")
    if any(
        not (
            path.startswith("payload/")
            or path in required_metadata
        )
        for path in actual_paths
    ):
        _fail("SERVER_ARTIFACT_LAYOUT", "release")
    if (
        "payload/index.html" not in actual_paths
        or "payload/sitemap.xml" not in actual_paths
    ):
        _fail("SERVER_ARTIFACT_LAYOUT", "payload")

    manifest_bytes = _read_captured_file(
        candidate_descriptor,
        release_capture,
        RELEASE_FILES_PATH,
        MAX_METADATA_BYTES,
    )
    manifest_entries = _parse_files_manifest(manifest_bytes)
    manifest_paths = {path for path, _ in manifest_entries}
    expected_manifest_paths = actual_paths - {RELEASE_JSON_PATH, RELEASE_FILES_PATH}
    if manifest_paths != expected_manifest_paths:
        _fail("SERVER_ARTIFACT_MANIFEST", RELEASE_FILES_PATH)
    records_by_path = {record.path: record for record in release_capture.records}
    for path, expected_sha256 in manifest_entries:
        if records_by_path[path].sha256 != expected_sha256:
            _fail("SERVER_ARTIFACT_MANIFEST", path)
    if any(
        not (
            path.startswith("payload/")
            or path
            in (
                RELEASE_RUNTIME_REDIRECTS_PATH,
                RELEASE_NGINX_REDIRECTS_PATH,
            )
        )
        for path in manifest_paths
    ):
        _fail("SERVER_ARTIFACT_MANIFEST", RELEASE_FILES_PATH)

    payload_descriptor = None
    try:
        payload_descriptor = _open_relative_directory(
            candidate_descriptor,
            [RELEASE_PAYLOAD_ROOT],
            create=False,
        )
        payload_capture = _capture_file_tree(
            payload_descriptor,
            RELEASE_PAYLOAD_ROOT,
        )
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_LAYOUT", RELEASE_PAYLOAD_ROOT, cause)
    finally:
        if payload_descriptor is not None:
            try:
                os.close(payload_descriptor)
            except OSError as cause:
                _fail("SERVER_ARTIFACT_LAYOUT", RELEASE_PAYLOAD_ROOT, cause)
    prefixed_payload_records = tuple(
        FileRecord(
            path=f"payload/{record.path}",
            byte_length=record.byte_length,
            sha256=record.sha256,
        )
        for record in payload_capture.records
    )
    release_payload_records = tuple(
        record
        for record in release_capture.records
        if record.path.startswith("payload/")
    )
    if prefixed_payload_records != release_payload_records:
        _fail("SERVER_ARTIFACT_LAYOUT", "payload")

    public_routes = _collect_public_routes(payload_capture.records)
    public_routes_sha256 = _digest_public_routes(public_routes)
    runtime_bytes = _read_captured_file(
        candidate_descriptor,
        release_capture,
        RELEASE_RUNTIME_REDIRECTS_PATH,
        MAX_METADATA_BYTES,
    )
    nginx_bytes = _read_captured_file(
        candidate_descriptor,
        release_capture,
        RELEASE_NGINX_REDIRECTS_PATH,
        MAX_METADATA_BYTES,
    )
    runtime = _validate_runtime_redirects(runtime_bytes, public_routes)
    if runtime["nginxBytes"] != nginx_bytes:
        _fail("SERVER_ARTIFACT_NGINX", RELEASE_NGINX_REDIRECTS_PATH)

    metadata_bytes = _read_captured_file(
        candidate_descriptor,
        release_capture,
        RELEASE_JSON_PATH,
        MAX_METADATA_BYTES,
    )
    metadata = _strict_json_loads(metadata_bytes, RELEASE_JSON_PATH)
    _assert_exact_keys(
        metadata,
        RELEASE_METADATA_KEYS,
        "SERVER_ARTIFACT_METADATA",
        RELEASE_JSON_PATH,
    )
    if _canonical_json_bytes(metadata) != metadata_bytes:
        _fail("SERVER_ARTIFACT_METADATA", RELEASE_JSON_PATH)
    if (
        metadata["schemaVersion"] != RELEASE_SCHEMA_VERSION
        or metadata["repository"] != RELEASE_REPOSITORY
        or metadata["payloadRoot"] != RELEASE_PAYLOAD_ROOT
        or metadata["commitSha"] != expected_commit
        or COMMIT_PATTERN.fullmatch(metadata["commitSha"] or "") is None
    ):
        _fail("SERVER_ARTIFACT_METADATA", RELEASE_JSON_PATH)
    digest_fields = (
        "sourceBuildTreeSha256",
        "redirectRegistrySha256",
        "publicRoutesSha256",
        "runtimeRedirectsSha256",
        "nginxRedirectsSha256",
        "filesSha256",
    )
    if any(
        not isinstance(metadata[field], str)
        or HEX_64_PATTERN.fullmatch(metadata[field]) is None
        for field in digest_fields
    ):
        _fail("SERVER_ARTIFACT_METADATA", RELEASE_JSON_PATH)
    count_fields = (
        "registeredRuleCount",
        "canonicalSlashRuleCount",
        "ruleCount",
        "fileCount",
    )
    if any(not _is_safe_integer(metadata[field]) for field in count_fields):
        _fail("SERVER_ARTIFACT_METADATA", RELEASE_JSON_PATH)
    if (
        metadata["sourceBuildTreeSha256"] != payload_capture.tree_sha256
        or metadata["publicRoutesSha256"] != public_routes_sha256
        or metadata["runtimeRedirectsSha256"]
        != hashlib.sha256(runtime_bytes).hexdigest()
        or metadata["nginxRedirectsSha256"]
        != hashlib.sha256(nginx_bytes).hexdigest()
        or metadata["filesSha256"]
        != hashlib.sha256(manifest_bytes).hexdigest()
        or metadata["fileCount"] != len(manifest_entries)
        or metadata["registeredRuleCount"] != runtime["registeredRuleCount"]
        or metadata["canonicalSlashRuleCount"]
        != runtime["canonicalSlashRuleCount"]
        or metadata["ruleCount"] != runtime["ruleCount"]
        or metadata["registeredRuleCount"]
        + metadata["canonicalSlashRuleCount"]
        != metadata["ruleCount"]
    ):
        _fail("SERVER_ARTIFACT_METADATA", RELEASE_JSON_PATH)

    return {
        "commitSha": metadata["commitSha"],
        "sourceBuildTreeSha256": payload_capture.tree_sha256,
        "redirectRegistrySha256": metadata["redirectRegistrySha256"],
        "publicRoutesSha256": public_routes_sha256,
        "runtimeRedirectsSha256": metadata["runtimeRedirectsSha256"],
        "nginxRedirectsSha256": metadata["nginxRedirectsSha256"],
        "filesSha256": metadata["filesSha256"],
        "releaseFileCount": len(release_capture.records),
        "payloadFileCount": len(payload_capture.records),
        "publicRouteCount": len(public_routes),
        "registeredRuleCount": runtime["registeredRuleCount"],
        "canonicalSlashRuleCount": runtime["canonicalSlashRuleCount"],
        "ruleCount": runtime["ruleCount"],
    }


def _candidate_identity(
    parent_descriptor,
    basename,
    held_descriptor,
):
    try:
        path_metadata = os.stat(
            basename,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
        held_metadata = os.fstat(held_descriptor)
        identity = _directory_ownership_identity(held_metadata)
        if (
            stat.S_ISLNK(path_metadata.st_mode)
            or not stat.S_ISDIR(path_metadata.st_mode)
            or not stat.S_ISDIR(held_metadata.st_mode)
            or path_metadata.st_uid != os.geteuid()
            or stat.S_IMODE(path_metadata.st_mode) != 0o700
            or _directory_ownership_identity(path_metadata) != identity
        ):
            raise ValueError("candidate root is not private")
        return identity
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_EXTRACT", "verified-candidate", cause)


def _safe_remove_tree(
    parent_descriptor,
    basename,
    held_descriptor,
    expected_identity,
):
    try:
        if not (
            basename == VERIFIED_RELEASE_BASENAME
            or basename.startswith(".verify-candidate-")
        ):
            raise ValueError("cleanup basename is outside transaction namespace")
        try:
            metadata = os.stat(
                basename,
                dir_fd=parent_descriptor,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            return
        held_metadata = os.fstat(held_descriptor)
        if (
            stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISDIR(metadata.st_mode)
            or _directory_ownership_identity(metadata) != expected_identity
            or _directory_ownership_identity(held_metadata)
            != expected_identity
            or not shutil.rmtree.avoids_symlink_attacks
        ):
            raise ValueError("cleanup root identity is uncertain")
        shutil.rmtree(basename, dir_fd=parent_descriptor)
        try:
            os.stat(
                basename,
                dir_fd=parent_descriptor,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            pass
        else:
            raise ValueError("cleanup target still exists")
        os.fsync(parent_descriptor)
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_CLEANUP", "verified-candidate", cause)


def _create_candidate(staging_descriptor):
    candidate_name = None
    candidate_descriptor = None
    try:
        for _attempt in range(128):
            candidate_name = f".verify-candidate-{secrets.token_hex(16)}"
            try:
                os.mkdir(candidate_name, 0o700, dir_fd=staging_descriptor)
                break
            except FileExistsError:
                candidate_name = None
        if candidate_name is None:
            raise FileExistsError("candidate namespace exhausted")
        candidate_descriptor = os.open(
            candidate_name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=staging_descriptor,
        )
        os.fchmod(candidate_descriptor, 0o700)
        identity = _candidate_identity(
            staging_descriptor,
            candidate_name,
            candidate_descriptor,
        )
        if _list_directory_bytes(candidate_descriptor):
            raise ValueError("new candidate is not empty")
        result = (candidate_name, candidate_descriptor, identity)
        candidate_descriptor = None
        return result
    except Exception as cause:
        if candidate_name is not None:
            try:
                if candidate_descriptor is None:
                    candidate_descriptor = os.open(
                        candidate_name,
                        os.O_RDONLY
                        | os.O_DIRECTORY
                        | os.O_NOFOLLOW
                        | os.O_CLOEXEC,
                        dir_fd=staging_descriptor,
                    )
                identity = _candidate_identity(
                    staging_descriptor,
                    candidate_name,
                    candidate_descriptor,
                )
                _safe_remove_tree(
                    staging_descriptor,
                    candidate_name,
                    candidate_descriptor,
                    identity,
                )
            except ServerArtifactError as cleanup_error:
                raise cleanup_error from cause
        if isinstance(cause, ServerArtifactError):
            raise
        _fail("SERVER_ARTIFACT_EXTRACT", "verified-candidate", cause)
    finally:
        if candidate_descriptor is not None:
            try:
                os.close(candidate_descriptor)
            except OSError:
                pass


def _emit_json_line(stream, value):
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    stream.write(f"{encoded}\n")
    stream.flush()


def _rename_noreplace_at(
    directory_descriptor,
    source_name,
    target_name,
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
            directory_descriptor,
            os.fsencode(source_name),
            directory_descriptor,
            os.fsencode(target_name),
            RENAME_NOREPLACE,
        )
        if result != 0:
            error_number = ctypes.get_errno()
            if error_number == 0:
                error_number = errno.EIO
            raise OSError(
                error_number,
                os.strerror(error_number),
                VERIFIED_RELEASE_BASENAME,
            )
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_ACTIVATE", VERIFIED_RELEASE_BASENAME, cause)


def _capture_survived_activation(before, after):
    if (
        not isinstance(before, FileTreeCapture)
        or not isinstance(after, FileTreeCapture)
        or before.records != after.records
        or before.tree_sha256 != after.tree_sha256
    ):
        return False

    def without_root(capture):
        return tuple(
            entry
            for entry in capture.operational_entries
            if not (entry[0] == "directory" and entry[1] == "")
        )

    return without_root(before) == without_root(after)


def verify_artifact(
    *,
    staging_root,
    expected_artifact_digest,
    expected_release_content_sha256,
    expected_commit_sha,
    success_stream=None,
    _signal_state=None,
):
    _assert_runtime()
    expected_artifact_digest = _assert_hex(
        expected_artifact_digest,
        "arguments/expected-artifact-digest",
    )
    expected_release_content_sha256 = _assert_hex(
        expected_release_content_sha256,
        "arguments/expected-release-content-sha256",
    )
    expected_commit_sha = _assert_commit(
        expected_commit_sha,
        "arguments/expected-commit-sha",
    )
    staging_descriptor = None
    staging_identity = None
    artifact_stream = None
    artifact_identity = None
    candidate_name = None
    candidate_descriptor = None
    candidate_identity = None
    activated_output_owned = False
    committed = False
    previous_signal_mask = None
    try:
        staging_descriptor, staging_identity = _open_owned_private_directory(
            staging_root
        )
        artifact_stream, artifact_identity = _open_stable_artifact(
            staging_descriptor
        )
        artifact_digest = _hash_open_stream(artifact_stream)
        if artifact_digest != expected_artifact_digest:
            _fail("SERVER_ARTIFACT_DIGEST", ARTIFACT_BASENAME)
        _assert_artifact_identity(
            staging_descriptor,
            artifact_stream,
            artifact_identity,
        )
        envelope = _preflight_zip_envelope(artifact_stream)
        try:
            archive = zipfile.ZipFile(artifact_stream, mode="r")
        except ServerArtifactError:
            raise
        except Exception as cause:
            _fail("SERVER_ARTIFACT_ARCHIVE_FORMAT", ARTIFACT_BASENAME, cause)
        with archive:
            plan = _plan_archive(archive, envelope)
            (
                candidate_name,
                candidate_descriptor,
                candidate_identity,
            ) = _create_candidate(staging_descriptor)
            _assert_staging_root_identity(
                staging_root,
                staging_descriptor,
                staging_identity,
                (
                    ARTIFACT_BASENAME.encode("ascii"),
                    candidate_name.encode("ascii"),
                ),
            )
            _extract_archive(archive, plan, candidate_descriptor)

        _assert_artifact_identity(
            staging_descriptor,
            artifact_stream,
            artifact_identity,
        )
        release_before = _capture_file_tree(candidate_descriptor, "release")
        if release_before.tree_sha256 != expected_release_content_sha256:
            _fail("SERVER_ARTIFACT_RELEASE_DIGEST", "release")
        validated = _validate_release(
            candidate_descriptor,
            release_before,
            expected_commit_sha,
        )
        release_after = _capture_file_tree(candidate_descriptor, "release")
        if release_after != release_before:
            _fail("SERVER_ARTIFACT_CHANGED", "release")
        _assert_artifact_identity(
            staging_descriptor,
            artifact_stream,
            artifact_identity,
        )
        _assert_staging_root_identity(
            staging_root,
            staging_descriptor,
            staging_identity,
            (
                ARTIFACT_BASENAME.encode("ascii"),
                candidate_name.encode("ascii"),
            ),
        )
        try:
            os.stat(
                VERIFIED_RELEASE_BASENAME,
                dir_fd=staging_descriptor,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            pass
        else:
            _fail("SERVER_ARTIFACT_STAGING", VERIFIED_RELEASE_BASENAME)

        result = {
            "schemaVersion": "1.0.0",
            "commitSha": validated["commitSha"],
            "artifactDigest": artifact_digest,
            "releaseContentSha256": release_after.tree_sha256,
            "sourceBuildTreeSha256": validated["sourceBuildTreeSha256"],
            "redirectRegistrySha256": validated["redirectRegistrySha256"],
            "publicRoutesSha256": validated["publicRoutesSha256"],
            "runtimeRedirectsSha256": validated["runtimeRedirectsSha256"],
            "nginxRedirectsSha256": validated["nginxRedirectsSha256"],
            "filesSha256": validated["filesSha256"],
            "releaseFileCount": validated["releaseFileCount"],
            "payloadFileCount": validated["payloadFileCount"],
            "publicRouteCount": validated["publicRouteCount"],
            "registeredRuleCount": validated["registeredRuleCount"],
            "canonicalSlashRuleCount": validated["canonicalSlashRuleCount"],
            "ruleCount": validated["ruleCount"],
        }
        try:
            previous_signal_mask = signal.pthread_sigmask(
                signal.SIG_BLOCK,
                INTERRUPT_SIGNALS,
            )
            activation_before = _capture_file_tree(
                candidate_descriptor,
                "release",
            )
            if activation_before != release_after:
                _fail("SERVER_ARTIFACT_CHANGED", "release")
            _rename_noreplace_at(
                staging_descriptor,
                candidate_name,
                VERIFIED_RELEASE_BASENAME,
            )
            candidate_name = VERIFIED_RELEASE_BASENAME
            activated_output_owned = True
            if (
                _candidate_identity(
                    staging_descriptor,
                    VERIFIED_RELEASE_BASENAME,
                    candidate_descriptor,
                )
                != candidate_identity
            ):
                _fail("SERVER_ARTIFACT_ACTIVATE", VERIFIED_RELEASE_BASENAME)
            _assert_staging_root_identity(
                staging_root,
                staging_descriptor,
                staging_identity,
                (
                    ARTIFACT_BASENAME.encode("ascii"),
                    VERIFIED_RELEASE_BASENAME.encode("ascii"),
                ),
            )
            activated_release = _capture_file_tree(
                candidate_descriptor,
                VERIFIED_RELEASE_BASENAME,
            )
            if not _capture_survived_activation(
                activation_before,
                activated_release,
            ):
                _fail("SERVER_ARTIFACT_CHANGED", VERIFIED_RELEASE_BASENAME)
            os.fsync(staging_descriptor)
            _assert_artifact_identity(
                staging_descriptor,
                artifact_stream,
                artifact_identity,
            )
            if (
                _candidate_identity(
                    staging_descriptor,
                    VERIFIED_RELEASE_BASENAME,
                    candidate_descriptor,
                )
                != candidate_identity
            ):
                _fail("SERVER_ARTIFACT_CHANGED", VERIFIED_RELEASE_BASENAME)
            _assert_staging_root_identity(
                staging_root,
                staging_descriptor,
                staging_identity,
                (
                    ARTIFACT_BASENAME.encode("ascii"),
                    VERIFIED_RELEASE_BASENAME.encode("ascii"),
                ),
            )
            if success_stream is not None:
                _emit_json_line(success_stream, result)
            committed = True
            if _signal_state is not None:
                _signal_state["commitCompleted"] = True
            return result
        except ServerArtifactError:
            raise
        except Exception as cause:
            _fail("SERVER_ARTIFACT_ACTIVATE", VERIFIED_RELEASE_BASENAME, cause)
    finally:
        close_error = None
        if artifact_stream is not None:
            try:
                artifact_stream.close()
            except Exception as cause:
                close_error = cause
        cleanup_error = None
        if not committed:
            try:
                if (
                    staging_descriptor is not None
                    and candidate_name is not None
                    and candidate_descriptor is not None
                    and candidate_identity is not None
                ):
                    if (
                        activated_output_owned
                        and candidate_name != VERIFIED_RELEASE_BASENAME
                    ):
                        _fail(
                            "SERVER_ARTIFACT_CLEANUP",
                            "verified-candidate",
                        )
                    _safe_remove_tree(
                        staging_descriptor,
                        candidate_name,
                        candidate_descriptor,
                        candidate_identity,
                    )
            except ServerArtifactError as error:
                cleanup_error = error
        descriptor_close_error = None
        for descriptor in (candidate_descriptor, staging_descriptor):
            if descriptor is None:
                continue
            try:
                os.close(descriptor)
            except OSError as cause:
                if descriptor_close_error is None:
                    descriptor_close_error = cause
        if previous_signal_mask is not None:
            signal.pthread_sigmask(
                signal.SIG_SETMASK,
                previous_signal_mask,
            )
        if cleanup_error is not None:
            raise cleanup_error
        if close_error is not None and not committed:
            _fail("SERVER_ARTIFACT_ARCHIVE", ARTIFACT_BASENAME, close_error)
        if descriptor_close_error is not None and not committed:
            _fail(
                "SERVER_ARTIFACT_CLEANUP",
                "verified-candidate",
                descriptor_close_error,
            )


def _load_golden_vectors():
    descriptor = None
    try:
        inherited = os.environ.get(SELF_TEST_GOLDEN_FD_ENVIRONMENT)
        proc_match = re.fullmatch(r"/proc/self/fd/([0-9]+)", __file__)
        if inherited is None:
            golden_path = Path(__file__).resolve().with_name(GOLDEN_BASENAME)
            if golden_path.is_symlink() or not golden_path.is_file():
                raise ValueError("golden file is not ordinary")
            descriptor = os.open(
                golden_path,
                os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            )
        else:
            if (
                proc_match is None
                or re.fullmatch(r"[0-9]+", inherited) is None
                or str(int(inherited)) != inherited
                or int(inherited) == int(proc_match.group(1))
            ):
                raise ValueError("inherited golden descriptor is invalid")
            verifier_metadata = os.fstat(int(proc_match.group(1)))
            descriptor = os.dup(int(inherited))
            golden_metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(verifier_metadata.st_mode)
                or verifier_metadata.st_nlink != 1
                or not stat.S_ISREG(golden_metadata.st_mode)
                or golden_metadata.st_nlink != 1
                or verifier_metadata.st_dev != golden_metadata.st_dev
            ):
                raise ValueError("inherited self-test files are invalid")
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size < 0
            or before.st_size > FILE_TREE_MAX_FILE_BYTES
        ):
            raise ValueError("golden file is not ordinary")
        chunks = []
        total = 0
        while total < before.st_size:
            chunk = os.pread(
                descriptor,
                min(READ_CHUNK_BYTES, before.st_size - total),
                total,
            )
            if not chunk:
                raise ValueError("golden file ended during read")
            chunks.append(chunk)
            total += len(chunk)
        if os.pread(descriptor, 1, total):
            raise ValueError("golden file grew during read")
        after = os.fstat(descriptor)
        if (
            _stat_identity(before) != _stat_identity(after)
            or total != before.st_size
        ):
            raise ValueError("golden file changed during read")
        raw_bytes = b"".join(chunks)
        value = json.loads(raw_bytes.decode("utf-8", "strict"))
    except ServerArtifactError:
        raise
    except Exception as cause:
        _fail("SERVER_ARTIFACT_FILE_TREE", "self-test/golden", cause)
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError as cause:
                _fail(
                    "SERVER_ARTIFACT_FILE_TREE",
                    "self-test/golden",
                    cause,
                )
    if (
        not isinstance(value, dict)
        or tuple(value.keys())
        != (
            "wireMagic",
            "pathUnicodeVersion",
            "vectors",
            "invalidVectors",
        )
        or value["wireMagic"] != FILE_TREE_WIRE_MAGIC
        or value["pathUnicodeVersion"] != PATH_UNICODE_VERSION
        or not isinstance(value["vectors"], list)
        or not value["vectors"]
        or not isinstance(value["invalidVectors"], list)
        or not value["invalidVectors"]
    ):
        _fail("SERVER_ARTIFACT_FILE_TREE", "self-test/golden")
    return value


def run_self_test(*, success_stream=None):
    _assert_runtime()
    golden = _load_golden_vectors()
    observed = {}
    for index, vector in enumerate(golden["vectors"]):
        source_path = f"self-test/vectors[{index}]"
        if (
            not isinstance(vector, dict)
            or tuple(vector.keys()) != ("name", "files", "treeSha256")
            or not isinstance(vector["name"], str)
            or not vector["name"]
            or not isinstance(vector["files"], list)
            or not isinstance(vector["treeSha256"], str)
            or HEX_64_PATTERN.fullmatch(vector["treeSha256"]) is None
        ):
            _fail("SERVER_ARTIFACT_FILE_TREE", source_path)
        records = []
        for file_index, file_value in enumerate(vector["files"]):
            file_source = f"{source_path}/files[{file_index}]"
            if (
                not isinstance(file_value, dict)
                or tuple(file_value.keys()) != ("path", "contentBase64")
                or not isinstance(file_value["path"], str)
                or not isinstance(file_value["contentBase64"], str)
            ):
                _fail("SERVER_ARTIFACT_FILE_TREE", file_source)
            try:
                content = base64.b64decode(
                    file_value["contentBase64"],
                    validate=True,
                )
            except (ValueError, binascii.Error) as cause:
                _fail("SERVER_ARTIFACT_FILE_TREE", file_source, cause)
            records.append(
                FileRecord(
                    path=file_value["path"],
                    byte_length=len(content),
                    sha256=hashlib.sha256(content).hexdigest(),
                )
            )
        actual = digest_file_tree_records(records)
        if actual != vector["treeSha256"] or vector["name"] in observed:
            _fail("SERVER_ARTIFACT_FILE_TREE", source_path)
        observed[vector["name"]] = actual
    if (
        observed.get("single-byte-a") is None
        or observed.get("single-byte-b") is None
        or observed["single-byte-a"] == observed["single-byte-b"]
    ):
        _fail("SERVER_ARTIFACT_FILE_TREE", "self-test/mutation")
    for index, vector in enumerate(golden["invalidVectors"]):
        source_path = f"self-test/invalid-vectors[{index}]"
        if (
            not isinstance(vector, dict)
            or tuple(vector.keys()) != ("name", "files")
            or not isinstance(vector["name"], str)
            or not vector["name"]
            or not isinstance(vector["files"], list)
            or not vector["files"]
        ):
            _fail("SERVER_ARTIFACT_FILE_TREE", source_path)
        records = []
        for file_index, file_value in enumerate(vector["files"]):
            file_source = f"{source_path}/files[{file_index}]"
            if (
                not isinstance(file_value, dict)
                or tuple(file_value.keys()) != ("path", "contentBase64")
                or not isinstance(file_value["path"], str)
                or not isinstance(file_value["contentBase64"], str)
            ):
                _fail("SERVER_ARTIFACT_FILE_TREE", file_source)
            try:
                content = base64.b64decode(
                    file_value["contentBase64"],
                    validate=True,
                )
            except (ValueError, binascii.Error) as cause:
                _fail("SERVER_ARTIFACT_FILE_TREE", file_source, cause)
            records.append(
                FileRecord(
                    path=file_value["path"],
                    byte_length=len(content),
                    sha256=hashlib.sha256(content).hexdigest(),
                )
            )
        try:
            digest_file_tree_records(records)
        except ServerArtifactError as error:
            if error.code == "SERVER_ARTIFACT_FILE_TREE":
                continue
            raise
        _fail("SERVER_ARTIFACT_FILE_TREE", source_path)
    result = {
        "schemaVersion": "1.0.0",
        "wireMagic": FILE_TREE_WIRE_MAGIC,
        "vectorCount": len(golden["vectors"]),
    }
    if success_stream is not None:
        _emit_json_line(success_stream, result)
    return result


def _parse_cli_arguments(arguments):
    if arguments == ["--self-test"]:
        return {"selfTest": True}
    expected_flags = (
        "--staging-root",
        "--expected-artifact-digest",
        "--expected-release-content-sha256",
        "--expected-commit-sha",
    )
    if len(arguments) != len(expected_flags) * 2:
        _fail("SERVER_ARTIFACT_ARGUMENT", "arguments")
    values = {}
    for index, expected_flag in enumerate(expected_flags):
        flag = arguments[index * 2]
        value = arguments[index * 2 + 1]
        if flag != expected_flag or not isinstance(value, str) or not value:
            _fail("SERVER_ARTIFACT_ARGUMENT", "arguments")
        values[expected_flag] = value
    return {
        "selfTest": False,
        "stagingRoot": values["--staging-root"],
        "expectedArtifactDigest": values["--expected-artifact-digest"],
        "expectedReleaseContentSha256": values[
            "--expected-release-content-sha256"
        ],
        "expectedCommitSha": values["--expected-commit-sha"],
    }


def _install_signal_handlers():
    previous = {}
    state = {"commitCompleted": False}

    def interrupt_handler(_signal_number, _frame):
        if state["commitCompleted"]:
            return
        _fail("SERVER_ARTIFACT_INTERRUPTED", "process/signal")

    for signal_number in (signal.SIGINT, signal.SIGTERM):
        previous[signal_number] = signal.signal(signal_number, interrupt_handler)
    return previous, state


def _restore_signal_handlers(previous):
    for signal_number, handler in previous.items():
        signal.signal(signal_number, handler)


def main(arguments=None):
    arguments = list(sys.argv[1:] if arguments is None else arguments)
    previous_handlers = {}
    signal_state = None
    try:
        previous_handlers, signal_state = _install_signal_handlers()
        options = _parse_cli_arguments(arguments)
        if options["selfTest"]:
            run_self_test(success_stream=sys.stdout)
        else:
            verify_artifact(
                staging_root=options["stagingRoot"],
                expected_artifact_digest=options["expectedArtifactDigest"],
                expected_release_content_sha256=options[
                    "expectedReleaseContentSha256"
                ],
                expected_commit_sha=options["expectedCommitSha"],
                success_stream=sys.stdout,
                _signal_state=signal_state,
            )
        return 0
    except ServerArtifactError as error:
        try:
            sys.stderr.write(f"{format_server_artifact_error(error)}\n")
            sys.stderr.flush()
        except Exception:
            pass
        return 1
    except BaseException:
        try:
            sys.stderr.write(
                "[SERVER_ARTIFACT_INTERNAL] "
                "服务器 artifact 校验发生未分类错误；底层细节已抑制。\n"
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

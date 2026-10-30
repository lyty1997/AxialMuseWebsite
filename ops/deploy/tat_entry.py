"""将 TAT 脚本尾段视为数据，校验后只调用固定发布入口。"""

import os
import re
import stat
import sys


MAX_COMMAND_BYTES = 2048
DEPLOY_ENTRY = "/usr/local/sbin/axialmuse-deploy"
PREFIX = (
    b"#!/bin/sh\n"
    b'exec /usr/bin/python3 -I -B /usr/local/lib/axialmuse-release/tat-entry.py 3<"$0"\n'
    b"exit 127\n"
    b"# AXIALMUSE-TAT-PARAMETERS-V1\n"
)
SUFFIX = b"# AXIALMUSE-TAT-END\n"
FIELDS = (
    ("workflowRunId", re.compile(rb"[1-9][0-9]{0,15}")),
    ("artifactId", re.compile(rb"[1-9][0-9]{0,15}")),
    ("commitSha", re.compile(rb"[0-9a-f]{40}")),
    ("artifactDigest", re.compile(rb"[0-9a-f]{64}")),
    ("releaseContentSha256", re.compile(rb"[0-9a-f]{64}")),
)


class TatEntryError(Exception):
    pass


def parse_command_data(content):
    if (
        not isinstance(content, bytes)
        or len(content) > MAX_COMMAND_BYTES
        or not content.startswith(PREFIX)
        or not content.endswith(SUFFIX)
    ):
        raise TatEntryError("TAT_ENTRY_SHAPE")
    body = content[len(PREFIX):-len(SUFFIX)]
    lines = body.split(b"\n")
    if len(lines) != len(FIELDS) + 1 or lines[-1] != b"":
        raise TatEntryError("TAT_ENTRY_SHAPE")

    values = {}
    for line, (name, pattern) in zip(lines[:-1], FIELDS, strict=True):
        expected_prefix = name.encode("ascii") + b"="
        if not line.startswith(expected_prefix):
            raise TatEntryError("TAT_ENTRY_SHAPE")
        value = line[len(expected_prefix):]
        if pattern.fullmatch(value) is None:
            raise TatEntryError("TAT_ENTRY_INPUT")
        if name in ("workflowRunId", "artifactId"):
            number = int(value)
            if number > 9007199254740991 or str(number).encode("ascii") != value:
                raise TatEntryError("TAT_ENTRY_INPUT")
        values[name] = value.decode("ascii")
    return values


def read_command_fd(descriptor=3):
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size > MAX_COMMAND_BYTES
        ):
            raise TatEntryError("TAT_ENTRY_SOURCE")
        content = os.read(descriptor, MAX_COMMAND_BYTES + 1)
        after = os.fstat(descriptor)
        if (
            len(content) != before.st_size
            or len(content) > MAX_COMMAND_BYTES
            or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
        ):
            raise TatEntryError("TAT_ENTRY_SOURCE")
        return content
    except TatEntryError:
        raise
    except OSError as error:
        raise TatEntryError("TAT_ENTRY_SOURCE") from error


def main():
    try:
        if sys.argv != [sys.argv[0]] or os.geteuid() != 0:
            raise TatEntryError("TAT_ENTRY_CONTEXT")
        values = parse_command_data(read_command_fd())
        arguments = [
            DEPLOY_ENTRY,
            "--workflow-run-id", values["workflowRunId"],
            "--artifact-id", values["artifactId"],
            "--commit-sha", values["commitSha"],
            "--artifact-digest", values["artifactDigest"],
            "--release-content-sha256", values["releaseContentSha256"],
        ]
        os.execve(DEPLOY_ENTRY, arguments, {
            "HOME": "/var/lib/axialmuse",
            "LANG": "C",
            "LC_ALL": "C",
            "PATH": "/usr/bin:/bin",
            "TZ": "UTC",
        })
    except TatEntryError as error:
        print(f"[{error}] TAT 参数未通过固定入口。", file=sys.stderr)
    except OSError:
        print("[TAT_ENTRY_EXEC] 固定发布入口不可用。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

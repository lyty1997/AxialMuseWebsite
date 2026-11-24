#!/usr/bin/python3 -I
"""稳定启动器仅用标准库；版本根在加载任何业务模块前固定。

此文件独立认证安装。版本目录不原位修改、不在旧进程退出前回收。
"""

import contextlib
import fcntl
import hashlib
import importlib
import json
import os
import re
import stat
import sys
import time
from pathlib import Path


LIB = Path("/usr/local/lib")
POINTER = LIB / "axialmuse-release"
VERSIONS = LIB / "axialmuse-runtimes"
LOCK = LIB / ".axialmuse-artifact-verifier-bootstrap.lock"
ENTRY = {
    "axialmuse-deploy": ("ops.deploy.release_commands", "main"),
    "axialmuse-deploy-prepared": ("ops.deploy.release_commands", "main"),
    "axialmuse-rollback": ("ops.deploy.release_commands", "main"),
    "axialmuse-deploy-init": ("ops.deploy.release_commands", "main"),
    "axialmuse-release-retire": ("ops.deploy.release_commands", "main"),
    "axialmuse-monitor-snapshot": ("ops.monitor.installed_snapshot", "main"),
    "axialmuse-resource-drill": ("ops.maintenance.resource_drill_command", "main"),
    "axialmuse-local-maintenance": ("ops.maintenance.installed", "main"),
    "axialmuse-maintenance-state": ("ops.maintenance.installed", "manage"),
    "axialmuse-public-renew": ("ops.deploy.renew_public_certificate", "main"),
}


def ensure(condition):
    if not condition:
        raise RuntimeError("DEPLOY_RUNTIME_INTEGRITY")


def directory(path, uid, mode=None):
    for item in (path, *path.parents):
        value = item.lstat()
        ensure(stat.S_ISDIR(value.st_mode) and value.st_uid in (0, uid)
               and (not value.st_mode & 0o022 or item == Path("/tmp")))
    if mode is not None:
        ensure(stat.S_IMODE(path.lstat().st_mode) == mode)


def content(path, uid):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        ensure(stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1
               and stat.S_IMODE(before.st_mode) == 0o644 and before.st_size <= 8 * 1024 * 1024)
        with os.fdopen(os.dup(descriptor), "rb") as stream:
            data = stream.read(8 * 1024 * 1024 + 1)
        def identity(value):
            return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
                    value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        ensure(identity(os.fstat(descriptor)) == identity(before) == identity(path.lstat())
               and len(data) == before.st_size)
        return data
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def lifecycle(lib=LIB, lock=LOCK, *, uid=0):
    directory(lib, uid)
    descriptors = []
    try:
        for path, flags in ((lib, os.O_DIRECTORY), (lock, 0)):
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | flags)
            descriptors.append(fd)
            value = os.fstat(fd)
            ensure(value.st_uid == uid)
            if path == lock:
                ensure(stat.S_ISREG(value.st_mode) and value.st_nlink == 1
                       and stat.S_IMODE(value.st_mode) == 0o600 and value.st_size == 0)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            ensure((value.st_dev, value.st_ino) == (path.lstat().st_dev, path.lstat().st_ino))
        def check_lock():
            for path, fd in zip((lib, lock), descriptors):
                value, live = os.fstat(fd), path.lstat()
                ensure((value.st_dev, value.st_ino) == (live.st_dev, live.st_ino))
        check_lock.lock_fds = tuple(descriptors)
        yield check_lock
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def runtime(pointer=POINTER, versions=VERSIONS, *, uid=0):
    directory(versions, uid, 0o755)
    value = pointer.lstat()
    ensure(stat.S_ISLNK(value.st_mode) and value.st_uid == uid)
    target = Path(os.readlink(pointer))
    ensure(target.is_absolute() and target.parent == versions and re.fullmatch(r"[0-9a-f]{64}", target.name))
    directory(target, uid, 0o755)
    raw = content(target / "runtime.json", uid)
    ensure(hashlib.sha256(raw).hexdigest() == target.name)
    manifest = json.loads(raw)
    ensure(isinstance(manifest, dict) and manifest and len(manifest) <= 256)
    actual = set()
    for parent, folders, files in os.walk(target, followlinks=False):
        directory(Path(parent), uid, 0o755)
        for name in folders:
            directory(Path(parent) / name, uid, 0o755)
        for name in files:
            path = Path(parent) / name
            if path == target / "runtime.json":
                continue
            relative = path.relative_to(target).as_posix()
            ensure(relative in manifest)
            ensure(hashlib.sha256(content(path, uid)).hexdigest() == manifest[relative])
            actual.add(relative)
    ensure(actual == set(manifest))
    return target


def launch(command, arguments, *, lib=LIB, pointer=POINTER, versions=VERSIONS, lock=LOCK, uid=0):
    ensure(os.geteuid() == uid and command in ENTRY)
    # 固定入口为隔离的新解释器；拒绝已加载其他代际的解释器复用此入口。
    ensure(not any(name == "ops" or name.startswith("ops.") for name in sys.modules))
    with lifecycle(lib, lock, uid=uid) as check_lock:
        root = runtime(pointer, versions, uid=uid)
        sys.path.insert(0, str(root))
        guard = type(sys)("_axialmuse_runtime")
        guard.check_lock, guard.root = check_lock, root
        guard.lock_fds = check_lock.lock_fds
        sys.modules[guard.__name__] = guard
        sys.argv = [command, *arguments]
        module, function = ENTRY[command]
        return getattr(importlib.import_module(module), function)()


def record_maintenance_failure(code, *, root=Path("/var/lib/axialmuse/maintenance"), uid=0, clock=time.time):
    """导入前失败也必须留证；此稳定格式独立于业务模块，仅维护写入口调用。"""
    directory(root, uid, 0o700)
    target = root / "launch-failures"
    directory(target, uid, 0o700)
    ensure(code in ("DEPLOY_VERIFIER_BUSY", "DEPLOY_RUNTIME_INTEGRITY"))
    identifier = os.urandom(16).hex()
    # 目录名本身就是完整失败事实；mkdir 后任意中断都不会留下半写 JSON。
    failure = target / f"{identifier}-{int(clock())}-{code}"
    failure.mkdir(mode=0o700)
    directory(failure, uid, 0o700)
    descriptor = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return identifier


def main():
    command = sys.argv[1] if len(sys.argv) >= 2 else None
    try:
        ensure(len(sys.argv) >= 2)
        return launch(sys.argv[1], sys.argv[2:])
    except BlockingIOError:
        if command == "axialmuse-local-maintenance":
            try:
                record_maintenance_failure("DEPLOY_VERIFIER_BUSY")
            except Exception:
                print("[MAINTENANCE_LAUNCH_RECEIPT_FAILED] 启动失败回执未完成。", file=sys.stderr)
        print("[DEPLOY_VERIFIER_BUSY] 生命周期被占用。", file=sys.stderr)
    except Exception:
        if command == "axialmuse-local-maintenance":
            try:
                record_maintenance_failure("DEPLOY_RUNTIME_INTEGRITY")
            except Exception:
                print("[MAINTENANCE_LAUNCH_RECEIPT_FAILED] 启动失败回执未完成。", file=sys.stderr)
        print("[DEPLOY_RUNTIME_INTEGRITY] 组件加载失败。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    raise SystemExit(main())

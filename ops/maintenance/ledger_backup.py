"""账本与全部历史的独立快照；验证新副本后才可回收旧副本。"""

import contextlib
import fcntl
import os
import re
import secrets
import time
from pathlib import Path

from ops.deploy import url_exposure_ledger as ledger
from ops.deploy.deployment_state import (
    DeploymentState, canonical, check_directory, decode, digest, read_file,
    initialize_layout, require, sync_directory, write_new,
)
from ops.deploy.release_install import rename_new


MARKER = b"axialmuse-ledger-backup-v1\n"
LIMIT = 64 * 1024 * 1024


def verify_bundle(content):
    value = decode(content)
    require(isinstance(value, dict) and set(value) == {"schema", "created", "initialized", "ledger", "history"}
            and value["schema"] == 1 and type(value["created"]) is int and value["created"] >= 0
            and isinstance(value["initialized"], str) and re.fullmatch(r"[0-9a-f]{64}\n", value["initialized"])
            and isinstance(value["history"], list) and 0 < len(value["history"]) <= 4096,
            "MAINTENANCE_BACKUP_SCHEMA")
    previous = None
    previous_ledger = ledger.empty_exposure_ledger()
    for index, event in enumerate(value["history"]):
        require(isinstance(event, dict) and set(event) == {"previous", "ledger"} and event["previous"] == previous,
                "MAINTENANCE_BACKUP_CHAIN")
        current = ledger.parse_exposure_ledger(canonical(event["ledger"]))
        if index == 0:
            require(current == ledger.empty_exposure_ledger()
                    and value["initialized"] == digest(canonical(event["ledger"])) + "\n",
                    "MAINTENANCE_BACKUP_GENESIS")
        ledger.assert_ledger_append_only(previous_ledger, current)
        previous, previous_ledger = digest(canonical(event)), current
    require(ledger.parse_exposure_ledger(canonical(value["ledger"])) == previous_ledger,
            "MAINTENANCE_BACKUP_HEAD")
    return value, (canonical(value["ledger"]), previous, len(value["history"]))


class LedgerBackups:
    def __init__(self, state, root, *, clock=time.time):
        self.state = state
        self.root = Path(root)
        self.clock = clock
        require(self.root.is_absolute() and not self.root.is_relative_to(state.home)
                and not state.home.is_relative_to(self.root), "MAINTENANCE_BACKUP_LOCATION")

    def initialize(self):
        require(not os.path.lexists(self.root), "MAINTENANCE_BACKUP_INITIALIZED")
        initialize_layout(self.root, self.state.uid, {"backup-schema": MARKER, "lock": b""})

    def check(self):
        check_directory(self.root, self.state.uid, 0o700)
        require(read_file(self.root / "backup-schema", self.state.uid, mode=0o600) == MARKER,
                "MAINTENANCE_BACKUP_SCHEMA")
        require(read_file(self.root / "lock", self.state.uid, mode=0o600) == b"", "MAINTENANCE_BACKUP_LOCK")

    @contextlib.contextmanager
    def locked(self):
        self.check()
        path = self.root / "lock"
        require(read_file(path, self.state.uid, mode=0o600) == b"", "MAINTENANCE_BACKUP_LOCK")
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                require(False, "MAINTENANCE_BACKUP_BUSY")
            held, live = os.fstat(descriptor), path.lstat()
            require((held.st_dev, held.st_ino) == (live.st_dev, live.st_ino), "MAINTENANCE_BACKUP_LOCK")
            yield
        finally:
            os.close(descriptor)

    def verify(self, directory):
        self.check()
        directory = Path(directory)
        require(directory.parent == self.root, "MAINTENANCE_BACKUP_LOCATION")
        check_directory(directory, self.state.uid, 0o700)
        require(set(os.listdir(directory)) == {"backup.json", "sha256"}, "MAINTENANCE_BACKUP_FILES")
        content = read_file(directory / "backup.json", self.state.uid, mode=0o600, limit=LIMIT)
        require(read_file(directory / "sha256", self.state.uid, mode=0o600) == digest(content).encode() + b"\n",
                "MAINTENANCE_BACKUP_DIGEST")
        value, result = verify_bundle(content)
        require(value["created"] <= self.clock(), "MAINTENANCE_BACKUP_TIME")
        return value, result

    def snapshots(self):
        return self._inventory()[0]

    def _check_deleting(self, directory):
        require(re.fullmatch(r"\.deleting-[0-9]{12}-[0-9a-f]{32}", directory.name),
                "MAINTENANCE_BACKUP_FILES")
        check_directory(directory, self.state.uid, 0o700)
        require(not os.path.lexists(self.root / directory.name.removeprefix(".deleting-")),
                "MAINTENANCE_BACKUP_FILES")
        members = set(os.listdir(directory))
        require(members <= {"backup.json", "sha256"}, "MAINTENANCE_BACKUP_FILES")
        content = {name: read_file(directory / name, self.state.uid, mode=0o600, limit=LIMIT)
                   for name in members}
        if "backup.json" in content:
            value, _ = verify_bundle(content["backup.json"])
            require(directory.name.removeprefix(".deleting-")[:12] == f"{value['created']:012d}"
                    and value["created"] <= self.clock(), "MAINTENANCE_BACKUP_TIME")
        if "sha256" in content:
            require(re.fullmatch(rb"[0-9a-f]{64}\n", content["sha256"]), "MAINTENANCE_BACKUP_DIGEST")
            if "backup.json" in content:
                require(content["sha256"] == digest(content["backup.json"]).encode() + b"\n",
                        "MAINTENANCE_BACKUP_DIGEST")
        return members

    def _inventory(self):
        self.check()
        snapshots, deleting = [], []
        for directory in sorted(self.root.iterdir()):
            if directory.name in ("backup-schema", "lock"):
                continue
            if re.fullmatch(r"\.pending-[0-9a-f]{32}", directory.name):
                check_directory(directory, self.state.uid, 0o700)
                continue  # 中断现场保留；绝不当作已发布备份。
            if re.fullmatch(r"\.deleting-[0-9]{12}-[0-9a-f]{32}", directory.name):
                self._check_deleting(directory)
                deleting.append(directory)
                continue
            require(re.fullmatch(r"[0-9]{12}-[0-9a-f]{32}", directory.name), "MAINTENANCE_BACKUP_FILES")
            value, _ = self.verify(directory)
            require(directory.name[:12] == f"{value['created']:012d}", "MAINTENANCE_BACKUP_TIME")
            snapshots.append((directory, value["created"]))
        return snapshots, deleting

    def create(self):
        with self.locked(), self.state.locked(retirement_aware=True):
            self.state.assert_idle()
            before = self.state.read_ledger()
            require(before[2] <= 4096, "MAINTENANCE_BACKUP_SIZE")
            history = []
            size = len(before[0])
            for index in range(before[2]):
                raw = read_file(self.state.history / f"{index:08d}.json", self.state.uid, mode=0o600)
                size += len(raw)
                require(size <= LIMIT // 2, "MAINTENANCE_BACKUP_SIZE")
                history.append(decode(raw))
            created = int(self.clock())
            content = canonical({"schema": 1, "created": created,
                "initialized": read_file(self.state.root / "initialized", self.state.uid, mode=0o600).decode("ascii"),
                "ledger": decode(before[0]),
                "history": history})
            require(len(content) <= LIMIT, "MAINTENANCE_BACKUP_SIZE")
            require(verify_bundle(content)[1] == before, "MAINTENANCE_BACKUP_DRIFT")
            require(self.state.read_ledger() == before, "MAINTENANCE_BACKUP_DRIFT")
            temporary = self.root / f".pending-{secrets.token_hex(16)}"
            temporary.mkdir(mode=0o700)
            sync_directory(self.root)
            write_new(temporary / "backup.json", content)
            write_new(temporary / "sha256", digest(content).encode() + b"\n")
            self.verify(temporary)
            require(self.state.read_ledger() == before, "MAINTENANCE_BACKUP_DRIFT")
            final = self.root / f"{created:012d}-{secrets.token_hex(16)}"
            rename_new(temporary, final)
            self.verify(final)
            return final

    def prune(self, new_snapshot):
        with self.locked():
            return self._prune(Path(new_snapshot))

    def _prune(self, new_snapshot):
        snapshots, deleting = self._inventory()  # 任何损坏先失败，删除前完整验证。
        by_path = dict(snapshots)
        require(new_snapshot in by_path and by_path[new_snapshot] == max(by_path.values())
                and 0 <= self.clock() - by_path[new_snapshot] <= 26 * 3600,
                "MAINTENANCE_BACKUP_FRESH")
        self.verify(new_snapshot)
        require(not deleting or len(snapshots) >= 2, "MAINTENANCE_BACKUP_RETENTION")
        protected = {new_snapshot}
        protected.update(path for path, _ in sorted(
            ((path, created) for path, created in snapshots if path != new_snapshot),
            key=lambda item: (item[1], item[0]), reverse=True)[:1])
        candidates = [(path, created) for path, created in snapshots if path not in protected
                      if created < self.clock() - 35 * 86400]
        deleted = 0
        for path in deleting:
            self._delete_retired(path)
            deleted += 1
        for path, _ in candidates:
            self.verify(path)
            retired = self.root / f".deleting-{path.name}"
            rename_new(path, retired)
            self._delete_retired(retired)
            deleted += 1
        return {"status": "ok", "deletedBackups": deleted, "verifiedBackups": len(snapshots) - len(candidates)}

    def _delete_retired(self, directory):
        members = self._check_deleting(directory)
        # 恢复时也先持久化待删除名称，避免上次改名未同步就开始删文件。
        sync_directory(self.root)
        for name in ("backup.json", "sha256"):
            if name in members:
                (directory / name).unlink()
                sync_directory(directory)
        directory.rmdir()
        sync_directory(self.root)

    def restore_isolated(self, snapshot, destination):
        """只写新目录的验证接口；不替换任何现有状态，不提供生产恢复入口。"""
        value, expected = self.verify(snapshot)
        destination = Path(destination)
        require(destination.is_absolute() and not destination.is_relative_to(self.state.home)
                and not destination.is_relative_to(self.root) and not os.path.lexists(destination),
                "MAINTENANCE_RESTORE_DESTINATION")
        check_directory(destination.parent, self.state.uid)
        destination.mkdir(mode=0o700)
        restored = DeploymentState(destination, self.state.uid)
        restored.root.mkdir(mode=0o700)
        restored.history.mkdir(mode=0o700)
        write_new(restored.root / "initialized", value["initialized"].encode("ascii"))
        write_new(restored.ledger_path, canonical(value["ledger"]))
        for index, event in enumerate(value["history"]):
            write_new(restored.history / f"{index:08d}.json", canonical(event))
        require(restored.read_ledger() == expected, "MAINTENANCE_RESTORE_DRIFT")
        return expected

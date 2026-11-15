"""元数据保留策略；私有隔离及内核租约共同保护实际删除。"""

import os
import re
import secrets
import stat
import time
from pathlib import Path

from ops.deploy.deployment_state import (
    canonical, check_directory, decode, publish_new, read_file, require, sync_directory,
)
from ops.deploy.inode_guard import exclusive_inodes
from ops.deploy.release_install import rename_new


def safe_directory(path, uid, writable_group=None):
    for item in (path, *path.parents):
        value = item.lstat()
        trusted = (item == Path("/var/log") and writable_group is not None
                   and value.st_gid == writable_group and not value.st_mode & 0o002)
        require(stat.S_ISDIR(value.st_mode) and value.st_uid in (0, uid)
                and (not value.st_mode & 0o022 or item == Path("/tmp") or trusted),
                "MAINTENANCE_LOG_DIRECTORY")
    require(path.lstat().st_uid == uid, "MAINTENANCE_LOG_DIRECTORY")


class LogArchiveRetention:
    def __init__(self, policies, *, uid=0, clock=time.time, quarantine=None, writable_group=None):
        self.policies, self.uid, self.clock = policies, uid, clock
        self.quarantine = Path(quarantine) if quarantine is not None else Path(policies[0][0]).parent / ".retention"
        self.writable_group = writable_group

    def policy(self, source):
        matches = [(owner, group, days) for active, owner, group, days in self.policies
                   if source.parent == Path(active).parent
                   and re.fullmatch(re.escape(Path(active).name) + r"\.[1-9][0-9]*(?:\.gz)?", source.name)]
        require(len(matches) == 1, "MAINTENANCE_LOG_UNKNOWN")
        return matches[0]

    def metadata(self, path, source):
        owner, group, days = self.policy(source)
        value = path.lstat()
        require(stat.S_ISREG(value.st_mode) and value.st_nlink == 1 and value.st_uid == owner
                and value.st_gid == group and stat.S_IMODE(value.st_mode) == 0o640, "MAINTENANCE_LOG_FILE")
        require(0 <= value.st_mtime_ns <= self.clock() * 1e9, "MAINTENANCE_LOG_TIME")
        return {"path": str(source), "location": str(path), "device": value.st_dev, "inode": value.st_ino,
                "size": value.st_size, "mtime": value.st_mtime_ns, "ctime": value.st_ctime_ns}, days

    def pending(self):
        if not os.path.lexists(self.quarantine):
            return []
        check_directory(self.quarantine, self.uid, 0o700)
        result = []
        for directory in sorted(self.quarantine.iterdir()):
            require(re.fullmatch(r"[0-9a-f]{32}", directory.name), "MAINTENANCE_LOG_QUARANTINE")
            check_directory(directory, self.uid, 0o700)
            entries = set(os.listdir(directory))
            prepared = {n for n in entries if re.fullmatch(r"\.prepared-[0-9a-f]{32}\.json", n)}
            require(entries - prepared <= {"request.json", "data", "sealed"}, "MAINTENANCE_LOG_QUARANTINE")
            for name in prepared:
                read_file(directory / name, self.uid, mode=0o600)
            if "request.json" not in entries:
                require(entries == prepared, "MAINTENANCE_LOG_QUARANTINE")
                continue  # 发布请求前从不移动源文件。
            record = decode(read_file(directory / "request.json", self.uid, mode=0o600))
            require(isinstance(record, dict) and set(record) == {"source", "device", "inode"}
                    and isinstance(record["source"], str) and Path(record["source"]).is_absolute()
                    and type(record["device"]) is int and type(record["inode"]) is int,
                    "MAINTENANCE_LOG_QUARANTINE")
            source = Path(record["source"])
            self.policy(source)
            safe_directory(source.parent, self.uid, self.writable_group)
            if "sealed" in entries:
                require(read_file(directory / "sealed", self.uid, mode=0o600) == b"", "MAINTENANCE_LOG_QUARANTINE")
                if "data" not in entries:
                    continue
            if "data" in entries:
                location = directory / "data"
            else:
                # 中断后系统轮转器可能先改了序号；请求绑定 inode，而非可复用的路径。
                base = re.sub(r"\.[1-9][0-9]*(?:\.gz)?$", "", source.name)
                matches = []
                for path in source.parent.iterdir():
                    if re.fullmatch(re.escape(base) + r"\.[1-9][0-9]*(?:\.gz)?", path.name):
                        value = path.lstat()
                        if (value.st_dev, value.st_ino) == (record["device"], record["inode"]):
                            matches.append(path)
                require(len(matches) == 1, "MAINTENANCE_LOG_DRIFT")
                location = matches[0]
            metadata, days = self.metadata(location, source)
            require((metadata["device"], metadata["inode"]) == (record["device"], record["inode"]),
                    "MAINTENANCE_LOG_DRIFT")
            result.append((metadata, days))
        return result

    def expired(self):
        records = self.pending()
        pending_sources = {r["location"] for r, _ in records}
        seen = set()
        for active, owner, group, days in self.policies:
            active = Path(active)
            require(active.is_absolute() and active not in seen and type(days) is int and days > 0,
                    "MAINTENANCE_LOG_POLICY")
            seen.add(active)
            safe_directory(active.parent, self.uid, self.writable_group)
            value = active.lstat()
            require(stat.S_ISREG(value.st_mode) and value.st_nlink == 1 and value.st_uid == owner
                    and value.st_gid == group and stat.S_IMODE(value.st_mode) == 0o640, "MAINTENANCE_LOG_FILE")
            for path in sorted(active.parent.iterdir()):
                if path.name.startswith(active.name + ".") and str(path) not in pending_sources:
                    records.append(self.metadata(path, path))
        return sorted((r for r, days in records if r["mtime"] <= (self.clock() - days * 86400) * 1e9),
                      key=lambda r: (r["path"], r["location"]))

    def plan(self):
        created = int(self.clock())
        return {"schema": 1, "created": created, "expires": created + 600, "files": self.expired()}

    def recover_pending(self):
        """调用者持轮转锁；全部源路径请求先隔离，年龄只控制最终删除。"""
        for record, _days in self.pending():
            self.isolate(record)

    def isolate(self, record):
        source, location = Path(record["path"]), Path(record["location"])
        if location.parent != source.parent:
            require(location.name == "data" and location.parent.parent == self.quarantine,
                    "MAINTENANCE_LOG_QUARANTINE")
            # 前次可能在 rename 后、源目录 fsync 前中断；删除前补齐两端持久性。
            sync_directory(source.parent)
            sync_directory(location.parent)
            return location
        if not self.quarantine.exists():
            check_directory(self.quarantine.parent, self.uid)
            self.quarantine.mkdir(mode=0o700)
            sync_directory(self.quarantine.parent)
        check_directory(self.quarantine, self.uid, 0o700)
        require(self.quarantine.stat().st_dev == location.lstat().st_dev, "MAINTENANCE_LOG_FILESYSTEM")
        request = {"source": str(source), "device": record["device"], "inode": record["inode"]}
        directory = next((p for p in self.quarantine.iterdir() if (p / "request.json").exists()
                          and not (p / "data").exists() and not (p / "sealed").exists()
                          and decode(read_file(p / "request.json", self.uid, mode=0o600)) == request), None)
        if directory is None:
            directory = self.quarantine / secrets.token_hex(16)
            directory.mkdir(mode=0o700)
            sync_directory(self.quarantine)
            publish_new(directory / "request.json", canonical(request))
        destination = directory / "data"
        rename_new(location, destination)
        sync_directory(source.parent)
        return destination

    def execute(self, plan):
        require(isinstance(plan, dict) and set(plan) == {"schema", "created", "expires", "files"}
                and plan["schema"] == 1 and type(plan["created"]) is int and type(plan["expires"]) is int
                and 0 < plan["expires"] - plan["created"] <= 600
                and plan["created"] <= self.clock() < plan["expires"], "MAINTENANCE_LOG_PLAN")
        require(self.expired() == plan["files"], "MAINTENANCE_LOG_DRIFT")
        deleted = 0
        for record in plan["files"]:
            location = self.isolate(record)
            with exclusive_inodes([location], code="MAINTENANCE_LOG_OPEN"):
                current, _ = self.metadata(location, Path(record["path"]))
                # rename 会改变 ctime；字节、时间、身份仍须符合原计划。
                require(all(current[k] == record[k] for k in ("device", "inode", "size", "mtime")),
                        "MAINTENANCE_LOG_DRIFT")
                sealed = location.parent / "sealed"
                if not sealed.exists():
                    publish_new(sealed, b"")
                sync_directory(location.parent)
                location.unlink()
                sync_directory(location.parent)
                deleted += 1
        return {"status": "ok", "deletedArchives": deleted}

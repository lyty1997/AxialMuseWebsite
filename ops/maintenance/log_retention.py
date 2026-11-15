"""归档年龄独立于 logrotate 是否因空日志跳过；只读元数据，不读日志正文。"""

import os
import re
import stat
import time
from pathlib import Path

from ops.deploy.deployment_state import require, sync_directory


def safe_directory(path, uid):
    for item in (path, *path.parents):
        value = item.lstat()
        require(stat.S_ISDIR(value.st_mode) and value.st_uid in (0, uid)
                and (not value.st_mode & 0o022 or item == Path("/tmp")), "MAINTENANCE_LOG_DIRECTORY")
    require(path.lstat().st_uid == uid, "MAINTENANCE_LOG_DIRECTORY")


class LogArchiveRetention:
    def __init__(self, policies, *, uid=0, clock=time.time):
        # policies: (固定活动路径, 服务文件 uid, gid, 归档天数)，来自安装配置。
        self.policies = policies
        self.uid = uid
        self.clock = clock

    def expired(self):
        now = self.clock()
        records = []
        seen = set()
        for active, owner, group, days in self.policies:
            active = Path(active)
            require(active.is_absolute() and active not in seen and type(days) is int and days > 0,
                    "MAINTENANCE_LOG_POLICY")
            seen.add(active)
            safe_directory(active.parent, self.uid)
            require(os.path.lexists(active), "MAINTENANCE_LOG_ACTIVE_MISSING")
            for path in sorted(active.parent.iterdir()):
                if path.name != active.name and not path.name.startswith(active.name + "."):
                    continue
                archive = path.name != active.name
                require(not archive or re.fullmatch(re.escape(active.name) + r"\.[1-9][0-9]*(?:\.gz)?", path.name),
                        "MAINTENANCE_LOG_UNKNOWN")
                value = path.lstat()
                require(stat.S_ISREG(value.st_mode) and value.st_nlink == 1
                        and value.st_uid == owner and value.st_gid == group
                        and stat.S_IMODE(value.st_mode) == 0o640, "MAINTENANCE_LOG_FILE")
                require(0 <= value.st_mtime_ns <= self.clock() * 1e9, "MAINTENANCE_LOG_TIME")
                if archive and value.st_mtime_ns <= (now - days * 86400) * 1e9:
                    records.append({"path": str(path), "device": value.st_dev, "inode": value.st_ino,
                                    "size": value.st_size, "mtime": value.st_mtime_ns, "ctime": value.st_ctime_ns})
        return records

    def plan(self):
        created = int(self.clock())
        return {"schema": 1, "created": created, "expires": created + 600, "files": self.expired()}

    def execute(self, plan):
        require(isinstance(plan, dict) and set(plan) == {"schema", "created", "expires", "files"}
                and plan["schema"] == 1 and type(plan["created"]) is int and type(plan["expires"]) is int
                and 0 < plan["expires"] - plan["created"] <= 600
                and plan["created"] <= self.clock() < plan["expires"], "MAINTENANCE_LOG_PLAN")
        require(self.expired() == plan["files"], "MAINTENANCE_LOG_DRIFT")
        deleted = 0
        for record in plan["files"]:
            path = Path(record["path"])
            safe_directory(path.parent, self.uid)
            # root 控制父目录；服务进程仍可能写旧 fd，删除前再次核对元数据。
            value = path.lstat()
            require((value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
                    == tuple(record[k] for k in ("device", "inode", "size", "mtime", "ctime")),
                    "MAINTENANCE_LOG_DRIFT")
            path.unlink()
            sync_directory(path.parent)
            deleted += 1
        return {"status": "ok", "deletedArchives": deleted}

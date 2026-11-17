"""资源阈值只报告状态，不通过删除日志、release 或备份修复容量。"""

import os

from ops.deploy.deployment_state import require


GIB = 1024 ** 3
RESOURCE_FAILURE_CODES = frozenset(
    {"MAINTENANCE_RESOURCE_READ", "MAINTENANCE_RESOURCE_DATA"}
    | {f"MAINTENANCE_{dimension}_{level}" for dimension in ("DISK_USED", "DISK_FREE", "INODE_USED")
       for level in ("WARNING", "CRITICAL")}
)


def check_resources(path="/", *, statvfs=os.statvfs):
    try:
        value = statvfs(path)
    except OSError:
        return {"status": "failed", "checks": [{"id": "resources", "level": "critical",
                                                "code": "MAINTENANCE_RESOURCE_READ"}]}
    fields = (value.f_blocks, value.f_bavail, value.f_frsize, value.f_files, value.f_favail)
    require(all(type(n) is int and n >= 0 for n in fields)
            and value.f_blocks > 0 and value.f_frsize > 0 and value.f_files > 0
            and value.f_bavail <= value.f_blocks and value.f_favail <= value.f_files,
            "MAINTENANCE_RESOURCE_DATA")
    # 用整数比较，临界值不受浮点四舍五入影响；保留块不算可用空间。
    dimensions = (
        ("disk-used", (value.f_blocks - value.f_bavail) * 100, value.f_blocks * 80, value.f_blocks * 90),
        ("disk-free", -(value.f_bavail * value.f_frsize), -2 * GIB, -GIB),
        ("inode-used", (value.f_files - value.f_favail) * 100, value.f_files * 80, value.f_files * 90),
    )
    checks = []
    for name, actual, warning, critical in dimensions:
        level = "critical" if actual >= critical else "warning" if actual >= warning else "ok"
        checks.append({"id": name, "level": level,
                       "code": "OK" if level == "ok" else "MAINTENANCE_" + name.upper().replace("-", "_") + "_" + level.upper()})
    return {"status": "ok" if all(c["level"] == "ok" for c in checks) else "failed", "checks": checks}

"""默认关闭的演练控制；持久停用先于移除标记，读取端从不写状态。"""

import contextlib
import fcntl
import os
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from ops.deploy.deployment_state import (
    canonical, check_directory, decode, digest, identity_valid, initialize_layout, publish_new,
    read_file, require, sync_directory, write_new,
)
from ops.deploy.release_install import rename_new
from ops.maintenance.resources import GIB, check_resources
from ops.monitor.bounded_process import retain_locks
from ops.monitor.resource_protocol import SCENARIOS, timestamp


MARKER = b"axialmuse-resource-drills-v1\n"
REQUEST_KEYS = {"schema", "drillId", "authorizationId", "scenario", "runtimeSha256", "siteIdentity", "ledgerSha256",
                "bootId", "createdAtUtc", "expiresAtUtc", "startedBoottimeNs", "deadlineBoottimeNs"}


def boot_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()


def boottime():
    return time.clock_gettime_ns(time.CLOCK_BOOTTIME)


def valid(value, pattern):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def utc_at(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat()


def fixture_failure(scenario):
    require(isinstance(scenario, str) and scenario in SCENARIOS, "MONITOR_DRILL_SCENARIO")
    # 三个维度分开越界；不接收路径或任意容量输入。
    values = dict(f_blocks=1000, f_bavail=500, f_frsize=GIB, f_files=1000, f_favail=500)
    if scenario.startswith("disk-used"):
        values["f_bavail"] = 200 if scenario.endswith("warning") else 100
    elif scenario.startswith("disk-free"):
        values.update(f_blocks=4, f_bavail=2 if scenario.endswith("warning") else 1)
    else:
        values["f_favail"] = 200 if scenario.endswith("warning") else 100
    result = check_resources(statvfs=lambda _: SimpleNamespace(**values))
    failures = [c["code"] for c in result["checks"] if c["level"] != "ok"]
    require(result["status"] == "failed" and failures == [SCENARIOS[scenario]], "MONITOR_DRILL_FIXTURE")
    return failures[0]


class ResourceDrills:
    def __init__(self, root, uid=0, *, wall=time.time, elapsed=boottime, boot=boot_id):
        self.root, self.uid = Path(root), uid
        self.wall, self.elapsed, self.boot = wall, elapsed, boot

    def initialize(self):
        initialize_layout(self.root, self.uid, {"schema": MARKER, "lock": b""}, ("requests",))

    def check(self):
        check_directory(self.root, self.uid, 0o700)
        names = set(os.listdir(self.root))
        prepared = {n for n in names if valid(n, r"\.prepared-[0-9a-f]{32}\.json")}
        require(names - prepared in ({"schema", "lock", "requests"}, {"schema", "lock", "requests", "active.json"}),
                "MONITOR_DRILL_STATE")
        for name in prepared:
            read_file(self.root / name, self.uid, mode=0o600)
        require(read_file(self.root / "schema", self.uid, mode=0o600) == MARKER
                and read_file(self.root / "lock", self.uid, mode=0o600) == b"", "MONITOR_DRILL_STATE")
        check_directory(self.root / "requests", self.uid, 0o700)

    @contextlib.contextmanager
    def locked(self):
        self.check()
        path = self.root / "lock"
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                require(False, "MONITOR_DRILL_BUSY")
            require((os.fstat(fd).st_dev, os.fstat(fd).st_ino) == (path.lstat().st_dev, path.lstat().st_ino),
                    "MONITOR_DRILL_STATE")
            self.check()
            with retain_locks((fd,)):
                yield
        finally:
            os.close(fd)

    def records(self):
        records = {}
        authorizations = set()
        for folder in (self.root / "requests").iterdir():
            check_directory(folder, self.uid, 0o700)
            if valid(folder.name, r"\.preparing-[0-9a-f]{32}"):
                require(set(os.listdir(folder)) <= {"request.json"}, "MONITOR_DRILL_STATE")
                if os.path.lexists(folder / "request.json"):
                    read_file(folder / "request.json", self.uid, mode=0o600)
                continue
            require(valid(folder.name, r"[0-9a-f]{32}"), "MONITOR_DRILL_STATE")
            names = set(os.listdir(folder))
            prepared = {n for n in names if valid(n, r"\.prepared-[0-9a-f]{32}\.json")}
            require(names - prepared in ({"request.json"}, {"request.json", "disarm.json"}), "MONITOR_DRILL_STATE")
            for name in prepared:
                read_file(folder / name, self.uid, mode=0o600)
            raw = read_file(folder / "request.json", self.uid, mode=0o600)
            request = decode(raw)
            self.validate_request(request, folder.name)
            require(request["authorizationId"] not in authorizations, "MONITOR_DRILL_STATE")
            authorizations.add(request["authorizationId"])
            receipt, receipt_sha = None, None
            if "disarm.json" in names:
                content = read_file(folder / "disarm.json", self.uid, mode=0o600)
                receipt = decode(content)
                require(isinstance(receipt, dict) and set(receipt) == {
                    "schema", "drillId", "requestSha256", "disarmedAtUtc", "bootId", "disarmedBoottimeNs"}
                    and type(receipt["schema"]) is int and receipt["schema"] == 1
                    and receipt["drillId"] == folder.name and receipt["requestSha256"] == digest(raw)
                    and valid(receipt["bootId"], r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
                    and type(receipt["disarmedBoottimeNs"]) is int and receipt["disarmedBoottimeNs"] >= 0,
                    "MONITOR_DRILL_STATE")
                timestamp(receipt["disarmedAtUtc"])
                receipt_sha = digest(content)
            records[folder.name] = {"request": request, "requestSha256": digest(raw),
                                    "receipt": receipt, "disarmReceiptSha256": receipt_sha}
        return records

    def validate_request(self, request, identifier):
        require(isinstance(request, dict) and set(request) == REQUEST_KEYS
                and type(request["schema"]) is int and request["schema"] == 1
                and request["drillId"] == identifier
                and valid(request["authorizationId"], r"[A-Za-z0-9][A-Za-z0-9_.-]{0,95}")
                and isinstance(request["scenario"], str) and request["scenario"] in SCENARIOS
                and all(valid(request[k], r"[0-9a-f]{64}") for k in ("runtimeSha256", "ledgerSha256"))
                and valid(request["bootId"], r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
                and all(type(request[k]) is int and request[k] >= 0 for k in ("startedBoottimeNs", "deadlineBoottimeNs")),
                "MONITOR_DRILL_STATE")
        identity_valid(request["siteIdentity"])
        ttl_ns = request["deadlineBoottimeNs"] - request["startedBoottimeNs"]
        ttl = timestamp(request["expiresAtUtc"]) - timestamp(request["createdAtUtc"])
        require(1 <= ttl <= 1800 and ttl_ns == int(ttl * 1_000_000_000), "MONITOR_DRILL_STATE")

    def active(self, records):
        path = self.root / "active.json"
        if not os.path.lexists(path):
            return None
        value = decode(read_file(path, self.uid, mode=0o600))
        require(isinstance(value, dict) and set(value) == {"drillId", "requestSha256"}
                and valid(value["drillId"], r"[0-9a-f]{32}") and value["drillId"] in records
                and records[value["drillId"]]["requestSha256"] == value["requestSha256"], "MONITOR_DRILL_STATE")
        return records[value["drillId"]]

    def effective(self, record, binding=None):
        request = record["request"]
        if record["receipt"] is not None:
            return False
        current_boot, current_elapsed, current_wall = self.boot(), self.elapsed(), self.wall()
        if current_boot != request["bootId"]:
            return False
        require(current_elapsed >= request["startedBoottimeNs"], "MONITOR_DRILL_STATE")
        return (timestamp(request["createdAtUtc"]) <= current_wall < timestamp(request["expiresAtUtc"])
                and current_elapsed < request["deadlineBoottimeNs"]
                and (binding is None or all(request[key] == binding[key]
                     for key in ("runtimeSha256", "siteIdentity", "ledgerSha256"))))

    def arm(self, scenario, ttl, authorization, binding):
        require(type(ttl) is int and 1 <= ttl <= 1800 and isinstance(scenario, str) and scenario in SCENARIOS
                and valid(authorization, r"[A-Za-z0-9][A-Za-z0-9_.-]{0,95}"), "MONITOR_DRILL_ARGUMENTS")
        require(isinstance(binding, dict) and set(binding) == {"runtimeSha256", "siteIdentity", "ledgerSha256"}
                and all(valid(binding[key], r"[0-9a-f]{64}") for key in ("runtimeSha256", "ledgerSha256")),
                "MONITOR_DRILL_ARGUMENTS")
        identity_valid(binding["siteIdentity"])
        with self.locked():
            records = self.records()
            active = self.active(records)
            for record in records.values():
                request = record["request"]
                if request["authorizationId"] == authorization:
                    require(request["scenario"] == scenario
                            and request["deadlineBoottimeNs"] - request["startedBoottimeNs"] == ttl * 1_000_000_000
                            and all(request[key] == binding[key] for key in binding), "MONITOR_DRILL_REPLAY")
                    return record
            require(active is None, "MONITOR_DRILL_ACTIVE")
            identifier = secrets.token_hex(16)
            wall, elapsed = self.wall(), self.elapsed()
            request = {"schema": 1, "drillId": identifier, "authorizationId": authorization, "scenario": scenario,
                       **binding, "bootId": self.boot(), "createdAtUtc": utc_at(wall), "expiresAtUtc": utc_at(wall + ttl),
                       "startedBoottimeNs": elapsed, "deadlineBoottimeNs": elapsed + ttl * 1_000_000_000}
            self.validate_request(request, identifier)
            preparing = self.root / "requests" / (".preparing-" + identifier)
            preparing.mkdir(mode=0o700)
            sync_directory(preparing.parent)
            write_new(preparing / "request.json", canonical(request))
            rename_new(preparing, preparing.with_name(identifier))
            publish_new(self.root / "active.json", canonical({"drillId": identifier, "requestSha256": digest(canonical(request))}))
            return self.records()[identifier]

    def disarm(self, identifier):
        require(valid(identifier, r"[0-9a-f]{32}"), "MONITOR_DRILL_ARGUMENTS")
        with self.locked():
            records = self.records()
            active = self.active(records)
            require(identifier in records, "MONITOR_DRILL_UNKNOWN")
            record = records[identifier]
            if record["receipt"] is None:
                receipt = {"schema": 1, "drillId": identifier, "requestSha256": record["requestSha256"],
                           "disarmedAtUtc": utc_at(self.wall()), "bootId": self.boot(), "disarmedBoottimeNs": self.elapsed()}
                publish_new(self.root / "requests" / identifier / "disarm.json", canonical(receipt))
            if active is not None and active["request"]["drillId"] == identifier:
                (self.root / "active.json").unlink()
                sync_directory(self.root)
            return self.records()[identifier]

    def status(self):
        with self.locked():
            records = self.records()
            record = self.active(records)
            if record is None:
                return {"state": "inactive", "disarmedRequests": [
                    {"drillId": identifier, "requestSha256": record["requestSha256"],
                     "disarmReceiptSha256": record["disarmReceiptSha256"]}
                    for identifier, record in sorted(records.items()) if record["receipt"] is not None]}
            request = record["request"]
            state = "disarmed" if record["receipt"] else "active" if self.effective(record) else "expired"
            remaining = min(timestamp(request["expiresAtUtc"]) - self.wall(),
                            (request["deadlineBoottimeNs"] - self.elapsed()) / 1_000_000_000)
            return {"state": state, "drillId": request["drillId"], "requestSha256": record["requestSha256"],
                    "scenario": request["scenario"], "remainingSeconds": max(0, int(remaining)) if state == "active" else 0,
                    "disarmReceiptSha256": record["disarmReceiptSha256"], "bindingVerified": False}

    def observe(self, bundle, runtime_sha):
        with self.locked():
            record = self.active(self.records())
            binding = {"runtimeSha256": runtime_sha, "siteIdentity": bundle["snapshot"]["identity"],
                       "ledgerSha256": bundle["snapshot"]["ledgerSha256"]}
            if record is None or not self.effective(record, binding):
                return bundle
            request = record["request"]
            code = fixture_failure(request["scenario"])
            return {"schema": 2, "observedAtUtc": utc_at(self.wall()), "resourceFailure": code, "drill": {
                "id": request["drillId"], "scenario": request["scenario"], "requestSha256": record["requestSha256"],
                **binding, "simulated": True}}

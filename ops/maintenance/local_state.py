"""例行维护持久回执；后来的成功不得覆盖尚未处理的失败或中断。"""

import contextlib
import fcntl
import os
import re
import secrets
import time
from pathlib import Path

from ops.deploy.deployment_state import (
    DeploymentError, canonical, check_directory, decode, digest, read_file,
    initialize_layout, publish_new, require, sync_directory, write_new,
)
from ops.deploy.release_install import rename_new
from ops.monitor.bounded_process import retain_locks


MARKER = b"axialmuse-local-maintenance-v2\n"
ACTIVE_MARKER = b"axialmuse-local-maintenance-enabled-v2\n"
JOBS = ("resources", "backup", "logs")


def safe_code(error):
    code = str(error) if isinstance(error, DeploymentError) else getattr(error, "code", "MAINTENANCE_INTERNAL")
    return code if isinstance(code, str) and re.fullmatch(r"(?:MAINTENANCE|DEPLOY)_[A-Z0-9_]{1,90}", code) else "MAINTENANCE_INTERNAL"


class LocalMaintenanceState:
    def __init__(self, root, uid=0, *, clock=time.time):
        self.root = Path(root)
        self.uid = uid
        self.clock = clock

    def initialize(self):
        initialize_layout(self.root, self.uid, {"lock": b"", "schema": MARKER}, ("runs", "launch-failures"))

    def check(self, *, activating=False):
        check_directory(self.root, self.uid, 0o700)
        entries = set(os.listdir(self.root))
        prepared = {n for n in entries if re.fullmatch(r"\.prepared-[0-9a-f]{32}\.json", n)}
        for name in prepared:
            read_file(self.root / name, self.uid, mode=0o600)
        entries -= prepared
        require({"schema", "lock", "runs", "launch-failures"} <= entries <= {
            "schema", "lock", "runs", "enabled", "activation.json", "launch-failures"},
                "MAINTENANCE_LAYOUT")
        marker = read_file(self.root / "schema", self.uid, mode=0o600)
        require(marker in (MARKER, ACTIVE_MARKER), "MAINTENANCE_SCHEMA")
        require(marker != ACTIVE_MARKER or "activation.json" in entries, "MAINTENANCE_ACTIVATION")
        pending = marker == MARKER and "activation.json" in entries
        require(not pending or activating, "MAINTENANCE_ACTIVATION")
        require((marker == ACTIVE_MARKER) == ("enabled" in entries)
                or pending and activating, "MAINTENANCE_ACTIVATION")
        if "activation.json" in entries:
            raw = read_file(self.root / "activation.json", self.uid, mode=0o600)
            activation = decode(raw)
            require(isinstance(activation, dict) and set(activation) == {"schema", "enabled"}
                    and activation["schema"] == 1 and type(activation["enabled"]) is int
                    and 0 <= activation["enabled"] <= self.clock(), "MAINTENANCE_ACTIVATION")
            if marker == ACTIVE_MARKER:
                require(read_file(self.root / "enabled", self.uid, mode=0o600) == raw,
                        "MAINTENANCE_ACTIVATION")
        require(read_file(self.root / "lock", self.uid, mode=0o600) == b"", "MAINTENANCE_LOCK")
        check_directory(self.root / "runs", self.uid, 0o700)
        check_directory(self.root / "launch-failures", self.uid, 0o700)

    @contextlib.contextmanager
    def locked(self, *, activating=False):
        self.check(activating=activating)
        path = self.root / "lock"
        require(read_file(path, self.uid, mode=0o600) == b"", "MAINTENANCE_LOCK")
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                require(False, "MAINTENANCE_BUSY")
            held, live = os.fstat(descriptor), path.lstat()
            require((held.st_dev, held.st_ino) == (live.st_dev, live.st_ino), "MAINTENANCE_LOCK")
            with retain_locks((descriptor,)):
                yield
        finally:
            os.close(descriptor)

    def records(self, *, activating=False):
        self.check(activating=activating)
        records = []
        generations = set()
        for directory in sorted((self.root / "runs").iterdir()):
            if re.fullmatch(r"\.preparing-[0-9a-f]{32}", directory.name):
                # 此命名空间从不执行任务；崩溃准备文件留作审计，不计为运行。
                check_directory(directory, self.uid, 0o700)
                require(set(os.listdir(directory)) <= {"request.json"}, "MAINTENANCE_LAYOUT")
                if os.path.lexists(directory / "request.json"):
                    read_file(directory / "request.json", self.uid, mode=0o600)
                continue
            require(re.fullmatch(r"[0-9a-f]{32}", directory.name), "MAINTENANCE_LAYOUT")
            check_directory(directory, self.uid, 0o700)
            entries = set(os.listdir(directory))
            prepared = {name for name in entries if re.fullmatch(r"\.prepared-[0-9a-f]{32}\.json", name)}
            require(entries - prepared <= {"request.json", "result.json", "ack.json"}, "MAINTENANCE_LAYOUT")
            for name in prepared:
                read_file(directory / name, self.uid, mode=0o600)
            raw = read_file(directory / "request.json", self.uid, mode=0o600)
            request = decode(raw)
            require(isinstance(request, dict) and set(request) == {"schema", "id", "started", "generation"}
                    and request["schema"] == 1 and request["id"] == directory.name
                    and type(request["started"]) is int and 0 <= request["started"] <= self.clock()
                    and type(request["generation"]) is int and request["generation"] > 0
                    and request["generation"] not in generations,
                    "MAINTENANCE_REQUEST")
            generations.add(request["generation"])
            result = None
            result_sha = None
            if os.path.lexists(directory / "result.json"):
                content = read_file(directory / "result.json", self.uid, mode=0o600)
                result_sha = digest(content)
                result = decode(content)
                require(isinstance(result, dict) and set(result) == {"schema", "requestSha256", "finished", "status", "checks"}
                        and result["schema"] == 1 and result["requestSha256"] == digest(raw)
                        and type(result["finished"]) is int
                        and request["started"] <= result["finished"] <= self.clock()
                        and isinstance(result["checks"], list) and len(result["checks"]) == len(JOBS),
                        "MAINTENANCE_RESULT")
                for expected, check in zip(JOBS, result["checks"]):
                    require(isinstance(check, dict) and set(check) == {"id", "status", "code"}
                            and check["id"] == expected and check["status"] in ("ok", "failed", "blocked")
                            and isinstance(check["code"], str)
                            and re.fullmatch(r"(?:OK|(?:MAINTENANCE|DEPLOY)_[A-Z0-9_]{1,90})", check["code"])
                            and (check["status"] == "ok") == (check["code"] == "OK"), "MAINTENANCE_RESULT")
                require(result["status"] == ("ok" if all(c["status"] == "ok" for c in result["checks"]) else "failed"),
                        "MAINTENANCE_RESULT")
            acknowledged = False
            if os.path.lexists(directory / "ack.json"):
                ack = decode(read_file(directory / "ack.json", self.uid, mode=0o600))
                require(isinstance(ack, dict) and set(ack) == {"schema", "requestSha256", "resultSha256", "acknowledged"}
                        and ack["schema"] == 1 and ack["requestSha256"] == digest(raw)
                        and ack["resultSha256"] == result_sha and type(ack["acknowledged"]) is int
                        and (result["finished"] if result else request["started"]) <= ack["acknowledged"] <= self.clock(),
                        "MAINTENANCE_ACK")
                acknowledged = True
            records.append({"id": directory.name, "request": request, "requestSha256": digest(raw),
                            "result": result, "resultSha256": result_sha, "acknowledged": acknowledged})
        return records

    def execute(self, jobs, *, guard=contextlib.nullcontext):
        require(set(jobs) == set(JOBS), "MAINTENANCE_JOBS")
        with self.locked(), contextlib.ExitStack() as guards:
            records = self.records()  # 未知对象不被新的成功遮蔽。
            directory = self.root / "runs" / secrets.token_hex(16)
            preparing = directory.with_name(".preparing-" + directory.name)
            preparing.mkdir(mode=0o700)
            sync_directory(preparing.parent)
            request = canonical({"schema": 1, "id": directory.name, "started": int(self.clock()),
                                 "generation": max((r["request"]["generation"] for r in records), default=0) + 1})
            write_new(preparing / "request.json", request)
            rename_new(preparing, directory)
            checks = []
            blocked = False
            for name in JOBS:
                check = {"id": name, "status": "blocked", "code": "MAINTENANCE_PREREQUISITE"}
                if not blocked:
                    try:
                        if name == "resources":
                            # 先持久请求再尝试生命周期锁，锁失败也必须留回执。
                            guards.enter_context(guard())
                        value = jobs[name]()
                        require(isinstance(value, dict) and set(value) == {"status", "code"}
                                and value["status"] in ("ok", "failed")
                                and isinstance(value["code"], str)
                                and re.fullmatch(r"(?:OK|(?:MAINTENANCE|DEPLOY)_[A-Z0-9_]{1,90})", value["code"])
                                and (value["status"] == "ok") == (value["code"] == "OK"), "MAINTENANCE_JOB_RESULT")
                        check = {"id": name, **value}
                    except Exception as error:
                        check = {"id": name, "status": "failed", "code": safe_code(error)}
                checks.append(check)
                # 首项资源门禁失败后不再写备份或清理；其他独立单元可继续留证。
                if name == "resources" and check["status"] != "ok":
                    blocked = True
            result = {"schema": 1, "requestSha256": digest(request), "finished": int(self.clock()),
                      "status": "ok" if all(c["status"] == "ok" for c in checks) else "failed", "checks": checks}
            publish_new(directory / "result.json", canonical(result))
            return {"id": directory.name, **result}

    def fresh_success(self, records):
        successful = [r for r in records if r["result"] and r["result"]["status"] == "ok"]
        require(successful, "MAINTENANCE_SUCCESS_MISSING")
        latest = max(successful, key=lambda r: r["request"]["generation"])
        require(0 <= self.clock() - latest["result"]["finished"] <= 25 * 3600, "MAINTENANCE_STALE")
        return latest

    def enable(self):
        with self.locked(activating=True):
            activation = self.root / "activation.json"
            if not os.path.lexists(activation):
                self.assert_healthy(force=True, activating=True)
                publish_new(activation, canonical({"schema": 1, "enabled": int(self.clock())}))
            raw = read_file(activation, self.uid, mode=0o600)
            value = decode(raw)
            require(isinstance(value, dict) and set(value) == {"schema", "enabled"} and value["schema"] == 1
                    and type(value["enabled"]) is int and 0 <= value["enabled"] <= self.clock(),
                    "MAINTENANCE_ACTIVATION")
            enabled = self.root / "enabled"
            if os.path.lexists(enabled):
                require(read_file(enabled, self.uid, mode=0o600) == raw, "MAINTENANCE_ACTIVATION")
            else:
                publish_new(enabled, raw)
            temporary = self.root / f".prepared-{secrets.token_hex(16)}.json"
            write_new(temporary, ACTIVE_MARKER)
            os.replace(temporary, self.root / "schema")
            sync_directory(self.root)

    def acknowledge(self, run_id):
        require(isinstance(run_id, str) and re.fullmatch(r"[0-9a-f]{32}", run_id), "MAINTENANCE_ACK")
        with self.locked():
            records = self.records()
            latest = self.fresh_success(records)
            selected = next((r for r in records if r["id"] == run_id), None)
            if selected is None:
                failures = self.launch_failures()
                selected = next((r for r in failures if r["id"] == run_id), None)
                require(selected is not None and latest["request"]["started"] > selected["started"],
                        "MAINTENANCE_ACK")
                directory = self.root / "launch-failures" / f"{run_id}-{selected['started']}-{selected['code']}"
                publish_new(directory / "ack.json", canonical({
                    "schema": 1, "failureSha256": selected["sha256"], "successId": latest["id"],
                    "acknowledged": int(self.clock()),
                }))
                return
            require(selected is not None and (selected["result"] is None or selected["result"]["status"] == "failed")
                    and selected["request"]["generation"] < latest["request"]["generation"], "MAINTENANCE_ACK")
            publish_new(self.root / "runs" / run_id / "ack.json", canonical({
                "schema": 1, "requestSha256": selected["requestSha256"], "resultSha256": selected["resultSha256"],
                "acknowledged": int(self.clock()),
            }))

    def launch_failures(self):
        directory = self.root / "launch-failures"
        check_directory(directory, self.uid, 0o700)
        result = []
        for path in sorted(directory.iterdir()):
            match = re.fullmatch(r"([0-9a-f]{32})-([0-9]{1,12})-(DEPLOY_VERIFIER_BUSY|DEPLOY_RUNTIME_INTEGRITY)", path.name)
            require(match is not None, "MAINTENANCE_LAUNCH_RECEIPT")
            check_directory(path, self.uid, 0o700)
            entries = set(os.listdir(path))
            prepared = {n for n in entries if re.fullmatch(r"\.prepared-[0-9a-f]{32}\.json", n)}
            require(entries - prepared <= {"ack.json"}, "MAINTENANCE_LAYOUT")
            for name in prepared:
                read_file(path / name, self.uid, mode=0o600)
            failure = {"schema": 1, "id": match[1], "started": int(match[2]), "code": match[3]}
            require(0 <= failure["started"] <= self.clock(), "MAINTENANCE_LAUNCH_RECEIPT")
            raw = canonical(failure)
            ack_path = path / "ack.json"
            acknowledged = False
            if os.path.lexists(ack_path):
                ack = decode(read_file(ack_path, self.uid, mode=0o600))
                require(isinstance(ack, dict) and set(ack) == {"schema", "failureSha256", "successId", "acknowledged"}
                        and ack["schema"] == 1 and ack["failureSha256"] == digest(raw)
                        and type(ack["acknowledged"]) is int
                        and failure["started"] <= ack["acknowledged"] <= self.clock(), "MAINTENANCE_ACK")
                success = next((r for r in self.records() if r["id"] == ack["successId"]), None)
                require(success is not None and success["result"] is not None and success["result"]["status"] == "ok"
                        and success["request"]["started"] > failure["started"]
                        and success["result"]["finished"] <= ack["acknowledged"], "MAINTENANCE_ACK")
                acknowledged = True
            result.append({**failure, "sha256": digest(raw), "acknowledged": acknowledged})
        return result

    def assert_healthy(self, *, force=False, activating=False):
        if not force and not os.path.lexists(self.root):
            return
        self.check(activating=activating)
        enabled = self.root / "enabled"
        if not force and not os.path.lexists(enabled):
            return
        if os.path.lexists(enabled):
            value = decode(read_file(enabled, self.uid, mode=0o600))
            require(isinstance(value, dict) and set(value) == {"schema", "enabled"} and value["schema"] == 1
                    and type(value["enabled"]) is int and 0 <= value["enabled"] <= self.clock(), "MAINTENANCE_SCHEMA")
        records = self.records(activating=activating)
        self.fresh_success(records)
        require(all(r["result"] is not None or r["acknowledged"] for r in records), "MAINTENANCE_LOCAL_PENDING")
        require(all(r["result"] is None or r["result"]["status"] == "ok" or r["acknowledged"] for r in records),
                "MAINTENANCE_LOCAL_FAILED")
        require(all(r["acknowledged"] for r in self.launch_failures()), "MAINTENANCE_BOOTSTRAP_FAILED")

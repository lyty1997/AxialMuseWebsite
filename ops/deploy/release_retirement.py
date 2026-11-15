"""显式 release 退役：不可变事实先提交，再删除已认证的文件。

本模块不提供不带引用保护的生产删除入口。调用者必须持有生命周期锁，
并注入可信的引用探针；安装与生产接线另行审查。
"""

import contextlib
import os
import re
import secrets
import shutil
import stat
import time
from pathlib import Path, PurePosixPath

from ops.deploy import url_exposure_ledger as ledger
from ops.deploy.deployment_state import (
    RETIREMENT_PROTOCOL_ID, RETIREMENT_PROTOCOL_RESULT, RETIREMENT_SCHEMA,
    canonical, check_directory, decode, digest, identity_valid, read_file,
    require, sync_directory, write_new,
)
from ops.deploy.release_install import rename_new, sha_valid


MARKER = RETIREMENT_SCHEMA
PLAN_KEYS = {"schema", "authorizationId", "sha", "currentIdentity", "ledgerSha256",
             "historySha256", "historyEntries", "receiptSha256", "acceptedTransaction",
             "device", "inode", "referenceSha256", "created", "expires"}


def validate_plan(plan):
    require(isinstance(plan, dict) and set(plan) == PLAN_KEYS and plan["schema"] == 1,
            "DEPLOY_RETIREMENT_PLAN")
    sha_valid(plan["sha"])
    identity_valid(plan["currentIdentity"])
    for key in ("authorizationId", "acceptedTransaction"):
        require(isinstance(plan[key], str) and re.fullmatch(r"[0-9a-f]{32}", plan[key]),
                "DEPLOY_RETIREMENT_PLAN")
    for key in ("ledgerSha256", "historySha256", "receiptSha256", "referenceSha256"):
        require(isinstance(plan[key], str) and re.fullmatch(r"[0-9a-f]{64}", plan[key]),
                "DEPLOY_RETIREMENT_PLAN")
    for key in ("historyEntries", "device", "inode", "created", "expires"):
        require(type(plan[key]) is int and plan[key] >= (1 if key in ("historyEntries", "inode") else 0),
                "DEPLOY_RETIREMENT_PLAN")
    require(0 < plan["expires"] - plan["created"] <= 3600, "DEPLOY_RETIREMENT_PLAN")
    require(plan["sha"] != plan["currentIdentity"]["commit_sha"], "DEPLOY_RETIREMENT_CURRENT")


def initialize_retirements(state):
    """须显式调用并持有部署锁；只允许恢复空目录的启用中断。"""
    state.assert_idle()
    state.read_ledger()
    directory = state.root / "retirements"
    marker = state.root / "retirement-schema"
    require(not os.path.lexists(marker), "DEPLOY_RETIREMENT_INITIALIZED")
    protocol = state.transactions / RETIREMENT_PROTOCOL_ID
    require(not os.path.lexists(protocol), "DEPLOY_RETIREMENT_PROTOCOL")
    if os.path.lexists(directory):
        check_directory(directory, state.uid, 0o700)
        require(not os.listdir(directory), "DEPLOY_RETIREMENT_LAYOUT")
    else:
        directory.mkdir(mode=0o700)
        sync_directory(state.root)
    protocol.mkdir(mode=0o700)
    sync_directory(state.transactions)
    write_new(protocol / "pending", b"")
    write_new(protocol / "result.json", canonical(RETIREMENT_PROTOCOL_RESULT))
    write_new(marker, MARKER)
    (protocol / "pending").unlink()
    sync_directory(protocol)
    state.validate_retirement_protocol()


def retired_records(state):
    directory = state.root / "retirements"
    marker = state.root / "retirement-schema"
    if not os.path.lexists(marker) and not os.path.lexists(directory):
        require(not os.path.lexists(state.transactions / RETIREMENT_PROTOCOL_ID), "DEPLOY_RETIREMENT_PROTOCOL")
        return {}  # 仅兼容尚未启用的旧部署，普通读取绝不初始化。
    require(os.path.lexists(marker) and os.path.lexists(directory), "DEPLOY_RETIREMENT_LAYOUT")
    require(read_file(marker, state.uid, mode=0o600) == MARKER, "DEPLOY_RETIREMENT_SCHEMA")
    check_directory(directory, state.uid, 0o700)
    state.validate_retirement_protocol()
    _, _, count = state.read_ledger()
    result = {}
    authorization_ids = set()
    for name in sorted(os.listdir(directory)):
        path = directory / name
        if re.fullmatch(r"\.prepared-[0-9a-f]{32}\.json", name):
            # 崩溃可能留下部分准备文件；只检查资源边界，不将其解释成事实。
            read_file(path, state.uid, mode=0o600)
            continue
        require(re.fullmatch(r"[0-9a-f]{40}\.json", name), "DEPLOY_RETIREMENT_LAYOUT")
        plan = decode(read_file(path, state.uid, mode=0o600))
        validate_plan(plan)
        sha = name[:-5]
        require(plan["sha"] == sha and plan["historyEntries"] <= count,
                "DEPLOY_RETIREMENT_HISTORY")
        event = read_file(state.history / f"{plan['historyEntries'] - 1:08d}.json", state.uid, mode=0o600)
        require(digest(event) == plan["historySha256"]
                and digest(canonical(decode(event)["ledger"])) == plan["ledgerSha256"],
                "DEPLOY_RETIREMENT_HISTORY")
        receipt = read_file(state.root / "releases" / f"{sha}.json", state.uid, mode=0o600)
        require(digest(receipt) == plan["receiptSha256"], "DEPLOY_RETIREMENT_RECEIPT")
        accepted = decode(read_file(state.transactions / plan["acceptedTransaction"] / "result.json",
                                    state.uid, mode=0o600))
        require(accepted.get("status") == "local-accepted" and accepted.get("sha") == sha,
                "DEPLOY_RETIREMENT_HISTORY")
        require(plan["authorizationId"] not in authorization_ids, "DEPLOY_RETIREMENT_REPLAY")
        authorization_ids.add(plan["authorizationId"])
        result[sha] = plan
    return result


class ReleaseRetirement:
    """计划与执行均按 生命周期锁→部署锁 顺序；引用快照必须重现。"""

    def __init__(self, store, *, lifecycle_lock, reference_probe, clock=time.time):
        require(callable(lifecycle_lock) and callable(reference_probe), "DEPLOY_RETIREMENT_GUARD")
        self.store = store
        self.state = store.state
        self.lifecycle_lock = lifecycle_lock
        self.reference_probe = reference_probe
        self.clock = clock

    @contextlib.contextmanager
    def locked(self):
        with self.lifecycle_lock(), self.state.locked(retirement_aware=True):
            self.state.assert_idle()
            yield

    def references(self, sha):
        snapshot = self.reference_probe()
        require(isinstance(snapshot, dict) and set(snapshot) == {"schema", "protected", "evidence"}
                and snapshot["schema"] == 1 and isinstance(snapshot["protected"], list)
                and isinstance(snapshot["evidence"], str)
                and re.fullmatch(r"[0-9a-f]{64}", snapshot["evidence"]), "DEPLOY_RETIREMENT_REFERENCES")
        for protected in snapshot["protected"]:
            sha_valid(protected)
        require(snapshot["protected"] == sorted(set(snapshot["protected"])), "DEPLOY_RETIREMENT_REFERENCES")
        require(sha not in snapshot["protected"], "DEPLOY_RETIREMENT_REFERENCED")
        return digest(canonical(snapshot))

    def context(self, sha):
        current = self.store.current()
        require(current is not None and current != sha, "DEPLOY_RETIREMENT_CURRENT")
        require(current in self.state.available_releases(), "DEPLOY_RETIREMENT_UNACCEPTED")
        identity = self.store.read_view(current)[1]["identity"]
        content, history, count = self.state.read_ledger()
        return {"currentIdentity": identity, "ledgerSha256": digest(content),
                "historySha256": history, "historyEntries": count,
                "referenceSha256": self.references(sha)}

    def plan(self, sha, authorization_id, *, lifetime=600):
        sha_valid(sha)
        require(type(lifetime) is int and 0 < lifetime <= 3600, "DEPLOY_RETIREMENT_PLAN")
        with self.locked():
            require(os.path.lexists(self.state.root / "retirement-schema"), "DEPLOY_RETIREMENT_DISABLED")
            require(sha in self.state.available_releases(), "DEPLOY_RETIREMENT_UNACCEPTED")
            context = self.context(sha)
            view, _, _ = self.store.read_view(sha)
            try:
                ledger.assert_release_compatible(ledger.parse_exposure_ledger(self.state.read_ledger()[0]), view)
            except ledger.UrlExposureError as error:
                require(error.code in ("DEPLOY_RELEASE_INCOMPATIBLE_ROUTE", "DEPLOY_RELEASE_INCOMPATIBLE_EDGE"),
                        "DEPLOY_RETIREMENT_COMPATIBILITY")
            else:
                require(False, "DEPLOY_RETIREMENT_COMPATIBLE")
            metadata = (self.store.releases / sha).lstat()
            now = int(self.clock())
            plan = {"schema": 1, "authorizationId": authorization_id, "sha": sha,
                    **context, "receiptSha256": digest(read_file(
                        self.state.root / "releases" / f"{sha}.json", self.state.uid, mode=0o600)),
                    "acceptedTransaction": next(p.name for p in sorted(self.state.transactions.iterdir())
                        if decode(read_file(p / "result.json", self.state.uid, mode=0o600)).get("status") == "local-accepted"
                        and decode(read_file(p / "result.json", self.state.uid, mode=0o600)).get("sha") == sha),
                    "device": metadata.st_dev, "inode": metadata.st_ino,
                    "created": now, "expires": now + lifetime}
            validate_plan(plan)
            require(authorization_id not in {p["authorizationId"] for p in retired_records(self.state).values()},
                    "DEPLOY_RETIREMENT_REPLAY")
            return plan

    def remaining(self, plan):
        """断点重试只容许原始清单的子集，拒绝未知路径或内容。"""
        directory = self.store.releases / plan["sha"]
        if not os.path.lexists(directory):
            return False
        check_directory(directory, self.state.uid, 0o755)
        metadata = directory.lstat()
        require((metadata.st_dev, metadata.st_ino) == (plan["device"], plan["inode"]),
                "DEPLOY_RETIREMENT_DRIFT")
        receipt = decode(read_file(self.state.root / "releases" / f"{plan['sha']}.json",
                                   self.state.uid, mode=0o600))
        files = receipt["files"]
        folders = {str(parent) for name in files for parent in PurePosixPath(name).parents}
        for parent, directories, names in os.walk(directory, followlinks=False):
            check_directory(parent, self.state.uid, 0o755)
            for name in directories:
                child = Path(parent) / name
                require(child.relative_to(directory).as_posix() in folders, "DEPLOY_RETIREMENT_EXTRA")
                check_directory(child, self.state.uid, 0o755)
            for name in names:
                child = Path(parent) / name
                relative = child.relative_to(directory).as_posix()
                require(relative in files, "DEPLOY_RETIREMENT_EXTRA")
                metadata = child.lstat()
                require(stat.S_ISREG(metadata.st_mode), "DEPLOY_RETIREMENT_FILE")
                require(digest(read_file(child, self.state.uid, limit=128 * 1024 * 1024, mode=0o644))
                        == files[relative], "DEPLOY_RETIREMENT_DRIFT")
        return True

    def execute(self, plan):
        validate_plan(plan)
        with self.locked():
            records = retired_records(self.state)
            prior = records.get(plan["sha"])
            require(prior is None or prior == plan, "DEPLOY_RETIREMENT_DRIFT")
            if prior is None:
                # 有效期只约束首次提交；已持久化事实的恢复仍须通过下方全部复核。
                require(plan["created"] <= self.clock() < plan["expires"], "DEPLOY_RETIREMENT_EXPIRED")
            context = self.context(plan["sha"])
            require(all(plan[key] == value for key, value in context.items()), "DEPLOY_RETIREMENT_DRIFT")
            if prior is None:
                # 不能仅信任传入计划：按原有效期重建并核对每个不可变绑定。
                self.remaining(plan)
                self._recheck(plan)
                temporary = self.state.root / "retirements" / f".prepared-{secrets.token_hex(16)}.json"
                write_new(temporary, canonical(plan))
                rename_new(temporary, temporary.parent / f"{plan['sha']}.json")
            if self.remaining(plan):
                require(shutil.rmtree.avoids_symlink_attacks, "DEPLOY_RETIREMENT_PLATFORM")
                shutil.rmtree(self.store.releases / plan["sha"])
                sync_directory(self.store.releases)
            require(plan["sha"] in retired_records(self.state), "DEPLOY_RETIREMENT_COMMIT")
            return {"status": "retired", "sha": plan["sha"], "authorizationId": plan["authorizationId"]}

    def _recheck(self, plan):
        # plan() 获取相同锁，不可递归调用；在锁内核验初次退役的完整对象。
        sha = plan["sha"]
        require(sha in self.state.available_releases(), "DEPLOY_RETIREMENT_UNACCEPTED")
        view = self.store.read_view(sha)[0]
        try:
            ledger.assert_release_compatible(ledger.parse_exposure_ledger(self.state.read_ledger()[0]), view)
        except ledger.UrlExposureError as error:
            require(error.code in ("DEPLOY_RELEASE_INCOMPATIBLE_ROUTE", "DEPLOY_RELEASE_INCOMPATIBLE_EDGE"),
                    "DEPLOY_RETIREMENT_COMPATIBILITY")
        else:
            require(False, "DEPLOY_RETIREMENT_COMPATIBLE")
        require(digest(read_file(self.state.root / "releases" / f"{sha}.json", self.state.uid, mode=0o600))
                == plan["receiptSha256"], "DEPLOY_RETIREMENT_RECEIPT")
        require(plan["authorizationId"] not in {p["authorizationId"] for p in retired_records(self.state).values()},
                "DEPLOY_RETIREMENT_REPLAY")
        event = decode(read_file(self.state.transactions / plan["acceptedTransaction"] / "result.json",
                                 self.state.uid, mode=0o600))
        require(event.get("status") == "local-accepted" and event.get("sha") == sha,
                "DEPLOY_RETIREMENT_HISTORY")
        return plan

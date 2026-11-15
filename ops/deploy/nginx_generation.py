"""认证激活完成后记录进程代际，不用实时时钟估算 worker 的配置版本。"""

import re

from ops.deploy.deployment_state import canonical, digest, read_file, replace_file, require


def activation_record(nginx, configuration):
    store = nginx.store
    sha = store.current()
    require(sha is not None, "DEPLOY_RETIREMENT_CURRENT")
    current = (store.site / "current").lstat()
    pid = read_file(nginx.active_pid, store.uid, limit=64)
    require(re.fullmatch(rb"[1-9][0-9]*\n", pid), "DEPLOY_RETIREMENT_PROCESS")
    master = int(pid)
    master_identity = nginx.process_identity(master)
    workers = nginx.workers(master)
    require(type(master_identity) is int and master_identity > 0 and workers
            and all(type(start) is int and start > 0 for start in workers.values()), "DEPLOY_RETIREMENT_PROCESS")
    boot = nginx.process_reader("/proc/sys/kernel/random/boot_id").decode("ascii")
    require(re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\n", boot), "DEPLOY_RETIREMENT_BOOT")
    return {"schema": 1, "boot": boot.strip(), "master": [master, master_identity],
            "workers": [list(item) for item in sorted(workers.items())],
            "current": {"sha": sha, "device": current.st_dev, "inode": current.st_ino,
                        "ctime": current.st_ctime_ns, "mtime": current.st_mtime_ns},
            "identitySha256": digest(canonical(store.read_view(sha)[1]["identity"])),
            "configurationSha256": digest(configuration[0].encode()), "files": configuration[1]}


def record_activation(nginx, sha, configuration, master, master_identity):
    from ops.deploy.retirement_references import RetirementReferences
    require(RetirementReferences(nginx.store, nginx).configuration() == configuration,
            "DEPLOY_RETIREMENT_CONFIG_DRIFT")
    record = activation_record(nginx, configuration)
    require(record["current"]["sha"] == sha and record["master"] == [master, master_identity],
            "DEPLOY_RETIREMENT_PROCESS_DRIFT")
    replace_file(nginx.store.state.root / "nginx-generation.json", canonical(record))

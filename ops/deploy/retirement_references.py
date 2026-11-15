"""只读引用保护；无打开文件不能证明旧 Nginx worker 已释放内存配置。"""

import os
import re
from pathlib import Path

from ops.deploy.deployment_state import canonical, decode, digest, read_file, require
from ops.monitor.bounded_process import run_process


class RetirementReferences:
    def __init__(self, store, nginx, *, proc=Path("/proc"), command=None):
        self.store = store
        self.nginx = nginx
        self.proc = Path(proc)
        self.command = command or getattr(nginx, "capture_command", None) or run_process

    def process(self, pid):
        content = (self.proc / str(pid) / "stat").read_bytes()
        fields = content.rsplit(b")", 1)[1].split()
        require(len(fields) >= 20 and fields[0] != b"Z", "DEPLOY_RETIREMENT_PROCESS")
        return int(fields[19])

    def configuration(self):
        result = self.command(["/usr/sbin/nginx", "-T", "-c", str(self.nginx.active_config)],
                              output_limit=8 * 1024 * 1024, timeout=30,
                              env={"PATH": "/usr/sbin:/usr/bin:/bin", "LANG": "C"})
        require(result.returncode == 0, "DEPLOY_RETIREMENT_CONFIG")
        output = result.stdout.decode("utf-8", errors="strict")
        names = re.findall(r"^# configuration file (/[A-Za-z0-9_./-]+):$", output, re.MULTILINE)
        require(names and str(self.nginx.active_config) in names, "DEPLOY_RETIREMENT_CONFIG")
        evidence = {}
        changed = 0
        for name in sorted(set(names)):
            path = Path(name).resolve(strict=True)
            content = read_file(path, self.store.uid)
            metadata = path.lstat()
            evidence[name] = {"sha256": digest(content), "ctime": metadata.st_ctime_ns,
                              "mtime": metadata.st_mtime_ns, "inode": metadata.st_ino,
                              "device": metadata.st_dev}
            changed = max(changed, metadata.st_ctime_ns, metadata.st_mtime_ns)
        return output, evidence, changed

    def __call__(self):
        output, configs, config_changed = self.configuration()
        changed = config_changed
        protected = set()
        base = str(self.store.releases)
        pattern = re.compile(re.escape(base) + r"/([0-9a-f]{40})(?=/|\s|;|$)")

        def protect(value):
            protected.update(pattern.findall(value))

        protect(output)
        # absolute root/alias 可能通过站点外的符号链接间接引用旧目录。
        for match in re.finditer(r"\b(root|alias)\s+([^;\n]+);", output):
            value = match[2].strip().strip('"\'')
            require(value.startswith("/") and "$" not in value and not re.search(r"\s", value),
                    "DEPLOY_RETIREMENT_CONFIG_DYNAMIC")
            protect(str(Path(value).resolve(strict=True)))
        current = self.store.site / "current"
        sha = self.store.current()
        require(sha is not None, "DEPLOY_RETIREMENT_CURRENT")
        protected.add(sha)
        current_stat = current.lstat()
        changed = max(changed, current_stat.st_ctime_ns, current_stat.st_mtime_ns)
        for parent, directories, files in os.walk(self.store.site, followlinks=False):
            for name in directories + files:
                path = Path(parent) / name
                if path.is_symlink():
                    protect(str(path.resolve(strict=True)))
        pid = read_file(self.nginx.active_pid, self.store.uid, limit=64)
        require(re.fullmatch(rb"[1-9][0-9]*\n", pid), "DEPLOY_RETIREMENT_PROCESS")
        master = int(pid)
        master_identity = self.process(master)
        children_path = self.proc / str(master) / "task" / str(master) / "children"
        children = children_path.read_bytes()
        require(re.fullmatch(rb"(?:[1-9][0-9]*\s*)+", children), "DEPLOY_RETIREMENT_PROCESS")
        workers = {int(p): self.process(int(p)) for p in children.split()}
        from ops.deploy.nginx_generation import activation_record
        generation_path = self.store.state.root / "nginx-generation.json"
        require(os.path.lexists(generation_path), "DEPLOY_RETIREMENT_GENERATION_MISSING")
        generation = activation_record(self.nginx, (output, configs, config_changed))
        require(generation == decode(read_file(generation_path, self.store.uid, mode=0o600))
                and generation["master"] == [master, master_identity]
                and generation["workers"] == [list(item) for item in sorted(workers.items())],
                "DEPLOY_RETIREMENT_WORKER_GENERATION")
        references = []
        nginx_pids = set()
        for directory in sorted(self.proc.iterdir()):
            if not directory.name.isdecimal():
                continue
            try:
                fields = (directory / "stat").read_bytes().rsplit(b")", 1)[1].split()
                # 内核线程及 zombie 没有用户空间引用；不以 exe 的 ENOENT
                # 猜测这一事实，否则活进程的读取失败会被误判成安全。
                if fields[0] == b"Z" or int(fields[6]) & 0x00200000:
                    continue
                # 不读取命令行或环境；只保留匹配站点路径的引用摘要。
                executable = os.readlink(directory / "exe")
                if Path(executable).name == "nginx":
                    nginx_pids.add(int(directory.name))
                values = [os.readlink(directory / "cwd")]
                values.extend(os.readlink(p) for p in (directory / "fd").iterdir())
                with (directory / "maps").open("rb") as stream:
                    mappings = stream.read(8 * 1024 * 1024 + 1)
                require(len(mappings) <= 8 * 1024 * 1024, "DEPLOY_RETIREMENT_PROCESS_SIZE")
                values.append(mappings.decode("utf-8", errors="strict"))
                matches = sorted({sha for value in values for sha in pattern.findall(value)})
                if matches:
                    protected.update(matches)
                    references.append([int(directory.name), self.process(int(directory.name)), matches])
            except FileNotFoundError:
                # 只忽略确已退出的进程；活进程 fd 消失需要重新取证。
                require(not directory.exists(), "DEPLOY_RETIREMENT_PROCESS_DRIFT")
        require(nginx_pids == {master, *workers}, "DEPLOY_RETIREMENT_OTHER_NGINX")
        require(self.process(master) == master_identity and children_path.read_bytes() == children
                and {p: self.process(p) for p in workers} == workers, "DEPLOY_RETIREMENT_PROCESS_DRIFT")
        require(self.configuration() == (output, configs, config_changed), "DEPLOY_RETIREMENT_CONFIG_DRIFT")
        require(self.store.current() == sha and read_file(self.nginx.active_pid, self.store.uid, limit=64) == pid,
                "DEPLOY_RETIREMENT_CURRENT_DRIFT")
        require(current.lstat() == current_stat, "DEPLOY_RETIREMENT_CURRENT_DRIFT")
        return {"schema": 1, "protected": sorted(protected), "evidence": digest(canonical({
            "config": configs, "output": digest(output.encode()), "master": [master, master_identity],
            "workers": sorted(workers.items()), "references": references,
            "currentInode": current.lstat().st_ino, "changed": changed,
        }))}

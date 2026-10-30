"""仅本机的隔离候选和活动 Nginx；HTTP 探针从不跟随公网 Location。"""

import contextlib
import http.client
import os
import re
import secrets
import subprocess
import time
from pathlib import Path
from urllib.parse import quote

from ops.deploy.deployment_state import (
    DeploymentError, check_directory, digest, read_file, require, sync_directory, write_new,
)


def local_config(include, pid, port):
    for path in (include, pid):
        require(re.fullmatch(r"/[A-Za-z0-9_./-]+", str(path)), "DEPLOY_NGINX_PATH")
    require(type(port) is int and 1024 <= port <= 65535, "DEPLOY_NGINX_PORT")
    return (
        "worker_processes 1;\n"
        f"pid {pid};\nerror_log stderr crit;\n"
        "events { worker_connections 128; }\n"
        "http { access_log off; default_type text/html;\n"
        f"client_body_temp_path {Path(pid).parent}/client-body;\n"
        f"proxy_temp_path {Path(pid).parent}/proxy;\n"
        f"fastcgi_temp_path {Path(pid).parent}/fastcgi;\n"
        f"uwsgi_temp_path {Path(pid).parent}/uwsgi;\n"
        f"scgi_temp_path {Path(pid).parent}/scgi;\n"
        f"server {{ listen 127.0.0.1:{port}; server_name www.axialmuse.com;\n"
        f"include {include};\n"
        "index index.html; autoindex off;\n"
        "location / { try_files $uri $uri/ =404; }\n"
        "} }\n"
    ).encode()


def run_command(arguments):
    result = subprocess.run(arguments, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            timeout=30, check=False, env={"PATH": "/usr/sbin:/usr/bin:/bin", "LANG": "C"})
    require(result.returncode == 0, "DEPLOY_NGINX_COMMAND")


def local_site_config(site, port=18080):
    require(re.fullmatch(r"/[A-Za-z0-9_./-]+", str(site)), "DEPLOY_NGINX_PATH")
    require(type(port) is int and 1024 <= port <= 65535, "DEPLOY_NGINX_PORT")
    return (
        f"server {{\n    listen 127.0.0.1:{port};\n"
        "    server_name www.axialmuse.com;\n    access_log off;\n"
        f"    include {site}/current/config/site-release.conf;\n"
        "    index index.html;\n    autoindex off;\n"
        "    location / { try_files $uri $uri/ =404; }\n}\n"
    ).encode()


class LocalNginx:
    def __init__(self, store, run=run_command, active_port=18080, candidate_port=18081,
                 active_config=Path("/etc/nginx/nginx.conf"), reload_command=None,
                 site_configuration=None, active_pid=Path("/run/nginx.pid"), process_reader=None):
        self.store = store
        self.run = run
        self.active_port = active_port
        self.candidate_port = candidate_port
        self.active_config = Path(active_config)
        self.reload_command = reload_command or ["/usr/bin/systemctl", "reload", "nginx"]
        self.site_configuration = site_configuration
        self.active_pid = Path(active_pid)
        self.process_reader = process_reader or (lambda path: Path(path).read_bytes())

    def process_identity(self, pid):
        try:
            fields = self.process_reader(f"/proc/{pid}/stat").rsplit(b")", 1)[1].split()
            return None if fields[0] == b"Z" else int(fields[19])
        except FileNotFoundError:
            return None

    def workers(self, pid):
        content = self.process_reader(f"/proc/{pid}/task/{pid}/children")
        require(re.fullmatch(rb"(?:[0-9]+\s*)*", content), "DEPLOY_NGINX_PROCESS")
        return {int(child): self.process_identity(int(child)) for child in content.split()}

    def wait_old_workers(self, master, master_identity, previous):
        deadline = time.monotonic() + 15
        while True:
            require(self.process_identity(master) == master_identity, "DEPLOY_NGINX_MASTER")
            remaining = any(identity is not None and self.process_identity(pid) == identity
                            for pid, identity in previous.items())
            if not remaining and self.workers(master):
                return
            require(time.monotonic() < deadline, "DEPLOY_NGINX_WORKERS")
            time.sleep(0.05)

    def request(self, port, path):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        try:
            connection.request("GET", path, headers={"Host": "www.axialmuse.com", "Connection": "close"})
            response = connection.getresponse()
            # 文件上限由 verifier 控制；响应额外限制以拒绝错误服务的无界数据。
            body = response.read(128 * 1024 * 1024 + 1)
            require(len(body) <= 128 * 1024 * 1024, "DEPLOY_HTTP_SIZE")
            return response.status, response.getheaders(), body
        finally:
            connection.close()

    def smoke(self, sha, port):
        view, receipt, _ = self.store.read_view(sha)
        for path, expected in receipt["files"].items():
            if not path.startswith("payload/"):
                continue
            url = "/" + path[len("payload/"):]
            if url.endswith("/index.html"):
                url = url[:-len("index.html")]
            status, headers, body = self.request(port, quote(url, safe="/"))
            require(status == 200 and digest(body) == expected
                    and not any(key.lower() == "location" for key, _ in headers), "DEPLOY_HTTP_PAYLOAD")
        for rule in view.rules:
            for query in ("", "?axial=one%20two&repeat=1&repeat=2"):
                status, headers, _ = self.request(port, rule.source + query)
                locations = [value for key, value in headers if key.lower() == "location"]
                require(status == 301 and locations == ["https://www.axialmuse.com" + rule.target + query],
                        "DEPLOY_HTTP_REDIRECT")
                status, _, _ = self.request(port, rule.target + query)
                require(status == 200, "DEPLOY_HTTP_TARGET")
        for path in ("/metadata/release.json", "/config/site-release.conf", "/does-not-exist/"):
            require(self.request(port, path)[0] == 404, "DEPLOY_HTTP_EXPOSURE")

    def wait_smoke(self, sha, port):
        # graceful reload 是异步的；每次请求新连接，直到整套断言属于同一代。
        deadline = time.monotonic() + 10
        while True:
            try:
                self.smoke(sha, port)
                return
            except (OSError, http.client.HTTPException, DeploymentError) as error:
                if isinstance(error, DeploymentError) and not str(error).startswith("DEPLOY_HTTP_"):
                    raise
                if time.monotonic() >= deadline:
                    raise DeploymentError("DEPLOY_HTTP_SMOKE") from None
                time.sleep(0.1)

    @contextlib.contextmanager
    def candidate(self, sha):
        directory = self.store.state.root / f"nginx-{secrets.token_hex(16)}"
        directory.mkdir(mode=0o755)
        configuration = directory / "nginx.conf"
        pid = directory / "nginx.pid"
        write_new(configuration, local_config(
            self.store.releases / sha / "config/site-release.conf", pid, self.candidate_port,
        ), 0o644)
        command = ["/usr/sbin/nginx", "-p", str(directory), "-c", str(configuration)]
        started = False
        try:
            self.run(command + ["-t"])
            # 启动失败也可能留下进程；pid 现场保留供审查，不盲目再次启动。
            self.run(command)
            started = True
            self.wait_smoke(sha, self.candidate_port)
            yield
        finally:
            if started:
                try:
                    self.run(command + ["-s", "quit"])
                    deadline = time.monotonic() + 10
                    while os.path.lexists(pid):
                        require(time.monotonic() < deadline, "DEPLOY_NGINX_STOP")
                        time.sleep(0.05)
                except Exception as error:
                    raise DeploymentError("DEPLOY_NGINX_UNCERTAIN") from error
            elif os.path.lexists(pid):
                raise DeploymentError("DEPLOY_NGINX_UNCERTAIN")
            sync_directory(directory)

    def validate(self, sha):
        with self.candidate(sha):
            pass

    def activate(self, sha):
        if self.site_configuration is not None:
            content = local_site_config(self.store.site, self.active_port)
            path = Path(self.site_configuration)
            check_directory(path.parent, self.store.uid, 0o755)
            if not os.path.lexists(path):
                # 首次 current 完成后才安装引用它的 server block，不预装无效 include。
                write_new(path, content, 0o644)
            require(read_file(path, self.store.uid, mode=0o644) == content, "DEPLOY_NGINX_CONFIG_DRIFT")
        pid_content = read_file(self.active_pid, self.store.uid, limit=64)
        require(re.fullmatch(rb"[1-9][0-9]*\n", pid_content), "DEPLOY_NGINX_PROCESS")
        master = int(pid_content)
        master_identity = self.process_identity(master)
        require(master_identity is not None, "DEPLOY_NGINX_MASTER")
        previous = self.workers(master)
        self.run(["/usr/sbin/nginx", "-t", "-c", str(self.active_config)])
        self.run(self.reload_command)
        self.wait_old_workers(master, master_identity, previous)
        self.wait_smoke(sha, self.active_port)

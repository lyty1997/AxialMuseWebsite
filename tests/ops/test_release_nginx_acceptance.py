"""固定已有镜像上的真实 Nginx 发布/回滚验收；显式 opt-in，不拉取镜像。"""

import os
import secrets
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path

from ops.deploy.deployment_state import DeploymentError, write_new
from ops.deploy.nginx_activation import LocalNginx, local_config
from ops.deploy.release_transaction import ReleaseTransaction
from test_release_transaction import ReleaseFixture


IMAGE = "docker.io/library/nginx@sha256:0dcc88822d45581e65ae329f8be769762bf628d3b2bb7d2a077d4aa5c98b30e3"


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


@unittest.skipUnless(os.environ.get("AXIALMUSE_NGINX_ACCEPTANCE") == "1", "需显式启用本机 Docker 验收")
class RealNginxTests(unittest.TestCase):
    def test_real_install_activate_rollback_and_reload_failure(self):
        with tempfile.TemporaryDirectory(prefix="axial-nginx-") as temporary:
            root = Path(temporary)
            fixture = ReleaseFixture(root)
            name = "axial-37-" + secrets.token_hex(8)
            active_port, candidate_port = free_port(), free_port()
            self.assertNotEqual(active_port, candidate_port)
            base = ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock"]
            environment = {"PATH": "/usr/bin:/bin", "HOME": str(root), "LANG": "C"}
            def command(args):
                result = subprocess.run(args, capture_output=True, timeout=30, env=environment)
                if result.returncode:
                    # 仅隔离 fixture 的 Nginx 错误，不涉及生产配置或凭证。
                    raise AssertionError(result.stderr.decode()[:2000])
                return result
            command(base + ["run", "--detach", "--pull", "never", "--name", name,
                            "--network", "host", "--read-only", "--cap-drop", "ALL", "--pids-limit", "64",
                            "--user", f"{os.getuid()}:{os.getgid()}", "--volume", f"{root}:{root}",
                            "--entrypoint", "/bin/sh", IMAGE, "-c", "exec sleep 600"])
            try:
                config = root / "active.conf"
                pid = root / "active.pid"
                # 与服务器一致：首次无 server block，切换 current 后安装精确 include。
                conf_d = root / "conf.d"
                conf_d.mkdir(mode=0o755)
                template = local_config(fixture.site / "current/config/site-release.conf", pid, active_port)
                content = template.split(b"server {", 1)[0] + f"include {conf_d}/*.conf;\n}}\n".encode()
                write_new(config, content, 0o644)
                nginx_command = ["/usr/sbin/nginx", "-p", str(root), "-c", str(config)]
                def run(args):
                    command(base + ["exec", name] + args)
                def process_reader(path):
                    result = subprocess.run(base + ["exec", name, "cat", path], capture_output=True,
                                            timeout=10, env=environment)
                    if result.returncode:
                        if b"No such file or directory" in result.stderr:
                            raise FileNotFoundError(path)
                        raise AssertionError("isolated process probe failed")
                    return result.stdout
                run(nginx_command)
                adapter = LocalNginx(fixture.store, run=run, active_port=active_port,
                                     candidate_port=candidate_port, active_config=config,
                                     reload_command=nginx_command + ["-s", "reload"],
                                     site_configuration=conf_d / "axialmuse-local.conf",
                                     active_pid=pid, process_reader=process_reader)
                engine = ReleaseTransaction(fixture.store, adapter)
                first, second, third = "a" * 40, "b" * 40, "c" * 40
                stage, identity = fixture.stage(first, payload_index=b"FIRST GENERATION\n")
                fixture.approve(identity)
                self.assertEqual(engine.execute(identity=identity, stage=stage)["status"], "local-accepted")
                before = fixture.state.read_ledger()[0]
                stage, identity = fixture.stage(second, payload_index=b"SECOND GENERATION\n")
                self.assertEqual(engine.execute(identity=identity, stage=stage)["fallback"], first)
                self.assertEqual(adapter.request(active_port, "/")[2], b"SECOND GENERATION\n")
                engine.execute(rollback_sha=first)
                self.assertEqual(adapter.request(active_port, "/")[2], b"FIRST GENERATION\n")
                self.assertEqual(fixture.state.read_ledger()[0], before)
                original_activate = adapter.activate
                def fail_once(sha):
                    if sha == third:
                        raise DeploymentError("DEPLOY_NGINX_COMMAND")
                    original_activate(sha)
                adapter.activate = fail_once
                stage, identity = fixture.stage(third, payload_index=b"THIRD GENERATION\n")
                with self.assertRaisesRegex(DeploymentError, "DEPLOY_RECOVERED"):
                    engine.execute(identity=identity, stage=stage)
                self.assertEqual(adapter.request(active_port, "/")[2], b"FIRST GENERATION\n")
                self.assertEqual(fixture.store.current(), first)
                self.assertEqual(fixture.state.read_ledger()[0], before)
                self.assertEqual(adapter.request(active_port, "/metadata/release.json")[0], 404)
                adapter.activate = original_activate
                original_run = adapter.run
                def invalid_candidate(args):
                    if args[-1] == "-t" and str(fixture.state.root) in args[args.index("-c") + 1]:
                        Path(args[args.index("-c") + 1]).write_text("invalid_directive;\n")
                    original_run(args)
                adapter.run = invalid_candidate
                stage, identity = fixture.stage("d" * 40, payload_index=b"BAD CONFIG CANDIDATE\n")
                with self.assertRaisesRegex(DeploymentError, "DEPLOY_REJECTED"):
                    engine.execute(identity=identity, stage=stage)
                self.assertEqual(fixture.store.current(), first)
                self.assertEqual(fixture.state.read_ledger()[0], before)
                run(nginx_command + ["-s", "quit"])
            finally:
                command(base + ["rm", "--force", name])


if __name__ == "__main__":
    unittest.main()

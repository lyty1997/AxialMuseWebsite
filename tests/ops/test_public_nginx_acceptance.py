"""固定已有 Nginx 镜像和临时 CA 上的 HTTP/TLS 独立验收，不访问 ACME。"""

import gzip
import os
import secrets
import ssl
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from ops.deploy.deployment_state import DeploymentError, write_new
from ops.deploy.nginx_activation import local_site_config
from ops.deploy.public_activation import PublicNginx
from ops.deploy.public_site import bootstrap_config, content_hash
from ops.deploy.release_transaction import ReleaseTransaction
from ops.deploy.renew_public_certificate import renew
from test_release_nginx_acceptance import IMAGE, free_port
from test_release_transaction import ReleaseFixture


def command(arguments):
    result = subprocess.run(arguments, capture_output=True, timeout=30,
                            env={"PATH": "/usr/bin:/bin", "LANG": "C"})
    if result.returncode:
        raise AssertionError(result.stderr.decode()[:2000])
    return result


def test_certificate(root, *, name="good", domains="DNS:axialmuse.com,DNS:www.axialmuse.com", days="2"):
    lineage = root / name
    lineage.mkdir(mode=0o700)
    ca, ca_key = root / "ca.pem", root / "ca.key"
    if not ca.exists():
        command(["/usr/bin/openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
                 "-nodes", "-keyout", str(ca_key), "-out", str(ca), "-days", "2",
                 "-subj", "/CN=Axial local fixture CA", "-addext", "basicConstraints=critical,CA:TRUE"])
    csr = lineage / "request.csr"
    command(["/usr/bin/openssl", "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
             "-nodes", "-keyout", str(lineage / "privkey.pem"), "-out", str(csr), "-subj", "/CN=axialmuse.com"])
    extension = lineage / "extensions.cnf"
    write_new(extension, (f"subjectAltName={domains}\nextendedKeyUsage=serverAuth\n"
                          "basicConstraints=critical,CA:FALSE\n").encode(), 0o644)
    command(["/usr/bin/openssl", "x509", "-req", "-in", str(csr), "-CA", str(ca), "-CAkey", str(ca_key),
             "-CAcreateserial", "-days", days, "-out", str(lineage / "fullchain.pem"), "-extfile", str(extension)])
    return lineage, ca


class PublicFixture:
    def __init__(self, root):
        self.root = Path(root)
        self.root.chmod(0o755)
        self.fixture = ReleaseFixture(root)
        self.sha = "a" * 40
        body = b"<!doctype html><html><head><script>abc</script></head><body>" + b"fixture " * 100 + b"</body></html>"
        stage, identity = self.fixture.stage(self.sha, payload_index=body)
        self.fixture.approve(identity)
        self.fixture.engine.execute(identity=identity, stage=stage)
        self.lineage, ca = test_certificate(self.root)
        ports = set()
        while len(ports) < 5:
            ports.add(free_port())
        local, http, https, candidate_http, candidate_https = sorted(ports)
        self.base = ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock"]
        self.name = "axial-39-" + secrets.token_hex(8)
        self.conf_d = self.root / "conf.d"
        self.conf_d.mkdir(mode=0o755)
        webroot = self.root / "acme-webroot"
        (webroot / ".well-known/acme-challenge").mkdir(parents=True, mode=0o755)
        for path in (webroot, webroot / ".well-known", webroot / ".well-known/acme-challenge"):
            path.chmod(0o755)
        write_new(webroot / ".well-known/acme-challenge/test-token", b"fixture-token\n", 0o644)
        config, pid = self.root / "nginx.conf", self.root / "nginx.pid"
        write_new(config, (
            f"worker_processes 1; pid {pid}; error_log stderr crit;\n"
            "events { worker_connections 128; }\nhttp { access_log off; include /etc/nginx/mime.types;\n"
            + "".join(f"{kind}_temp_path {self.root}/{kind};\n" for kind in
                      ("client_body", "proxy", "fastcgi", "uwsgi", "scgi"))
            + f"include {self.conf_d}/*.conf;\n}}\n"
        ).encode(), 0o644)
        self.nginx_command = ["/usr/sbin/nginx", "-p", str(self.root), "-c", str(config)]
        def run(args):
            if args[0] == "/usr/bin/openssl":
                result = subprocess.run(args, capture_output=True, timeout=30)
                if result.returncode:
                    raise DeploymentError("TEST_CERTIFICATE_REJECTED")
            else:
                command(self.base + ["exec", self.name] + args)
        def process_reader(path):
            result = subprocess.run(self.base + ["exec", self.name, "cat", path], capture_output=True, timeout=10)
            if result.returncode:
                if b"No such file or directory" in result.stderr:
                    raise FileNotFoundError(path)
                raise AssertionError("fixture process read failed")
            return result.stdout
        self.adapter = PublicNginx(
            self.fixture.store, mode={"schema": 1, "hsts": False},
            public_configuration=self.conf_d / "public.conf", webroot=webroot, lineage=self.lineage,
            http_port=http, https_port=https, candidate_http=candidate_http, candidate_https=candidate_https,
            tls_context=ssl.create_default_context(cafile=ca), ca_file=ca, run=run,
            public_address="127.0.0.1",
            active_port=local, candidate_port=free_port(), active_config=config, active_pid=pid,
            site_configuration=self.conf_d / "local.conf", process_reader=process_reader,
            reload_command=self.nginx_command + ["-s", "reload"],
        )
        write_new(self.adapter.site_configuration, local_site_config(self.fixture.site, local), 0o644)
        write_new(self.adapter.public_configuration, self.adapter.render(self.sha), 0o644)

    def start(self):
        command(self.base + ["run", "--detach", "--pull", "never", "--name", self.name,
                             "--network", "host", "--read-only", "--cap-drop", "ALL", "--pids-limit", "64",
                             "--user", f"{os.getuid()}:{os.getgid()}", "--volume", f"{self.root}:{self.root}",
                             "--entrypoint", "/bin/sh", IMAGE, "-c", "exec sleep 600"])
        self.adapter.run(self.nginx_command + ["-t"])
        self.adapter.run(self.nginx_command)

    def stop(self):
        command(self.base + ["rm", "--force", self.name])


@unittest.skipUnless(os.environ.get("AXIALMUSE_NGINX_ACCEPTANCE") == "1", "需显式启用本机 Docker 验收")
class PublicRealNginxTests(unittest.TestCase):
    def test_tls_hosts_csp_cache_bootstrap_and_compatible_recovery(self):
        with tempfile.TemporaryDirectory(prefix="axial-public-nginx-") as directory:
            fixture = PublicFixture(directory)
            try:
                fixture.start()
                adapter, store = fixture.adapter, fixture.fixture.store
                adapter.validate(fixture.sha)
                adapter.public_smoke(fixture.sha)
                def request(path, **kwargs):
                    return adapter.public_request(adapter.https_port, "www.axialmuse.com", path, tls=True, **kwargs)
                code, headers, body = request("/", headers={"Accept-Encoding": "gzip"})
                self.assertEqual(code, 200)
                self.assertIn(("Content-Encoding", "gzip"), headers)
                self.assertIn(("Vary", "Accept-Encoding"), headers)
                self.assertIn(("Cache-Control", "no-cache"), headers)
                self.assertIn(b"fixture", gzip.decompress(body))
                code, headers, _ = request("/assets/app.js")
                self.assertEqual(code, 200)
                self.assertIn(("Content-Type", "application/javascript"), headers)
                self.assertIn(("Cache-Control", "public, max-age=3600"), headers)
                code, headers, body = request("/assets/app.js", headers={"Range": "bytes=0-3"})
                self.assertEqual((code, len(body)), (206, 4))
                code, headers, _ = request("/sitemap.xml")
                self.assertEqual(code, 200)
                self.assertIn(("Cache-Control", "public, max-age=300"), headers)
                before = fixture.fixture.state.read_ledger()[0]
                engine = ReleaseTransaction(store, adapter)
                stage, identity = fixture.fixture.stage("b" * 40, payload_index=b"<script>next</script>SECOND")
                engine.execute(identity=identity, stage=stage)
                csp = dict(request("/")[1])["Content-Security-Policy"]
                self.assertIn(content_hash("next"), csp)
                self.assertNotIn(content_hash("abc"), csp)
                engine.execute(rollback_sha=fixture.sha)
                self.assertIn(content_hash("abc"), dict(request("/")[1])["Content-Security-Policy"])
                self.assertEqual(fixture.fixture.state.read_ledger()[0], before)
                original = adapter.public_smoke
                def fail_new(sha, **kwargs):
                    if sha == "c" * 40 and not kwargs.get("candidate"):
                        raise DeploymentError("TEST_PUBLIC_SMOKE_FAILED")
                    original(sha, **kwargs)
                stage, identity = fixture.fixture.stage("c" * 40, payload_index=b"THIRD")
                with patch.object(adapter, "public_smoke", side_effect=fail_new):
                    with self.assertRaisesRegex(DeploymentError, "DEPLOY_RECOVERED"):
                        engine.execute(identity=identity, stage=stage)
                self.assertEqual(store.current(), fixture.sha)
                adapter.public_smoke(fixture.sha)
                renew(store, adapter)
                wrong, _ = test_certificate(fixture.root, name="wrong", domains="DNS:wrong.invalid")
                old_lineage = adapter.lineage
                adapter.lineage = wrong
                with self.assertRaisesRegex(DeploymentError, "PUBLIC_CERTIFICATE_CHAIN"):
                    adapter.check_certificate()
                expired, _ = test_certificate(fixture.root, name="expired", days="-1")
                adapter.lineage = expired
                with self.assertRaisesRegex(DeploymentError, "PUBLIC_CERTIFICATE_CHAIN"):
                    adapter.check_certificate()
                adapter.lineage = old_lineage
                adapter.public_smoke(fixture.sha)
                # 定向 mutation：删除 CSP 必须让真实响应验收变红。
                clean = adapter.public_configuration.read_bytes()
                changed = b"\n".join(line for line in clean.split(b"\n") if b"add_header Content-Security-Policy" not in line)
                adapter.public_configuration.write_bytes(changed)
                adapter.run(fixture.nginx_command + ["-s", "reload"])
                with self.assertRaisesRegex(DeploymentError, "PUBLIC_SECURITY_HEADERS"):
                    for _ in range(100):
                        if "Content-Security-Policy" not in dict(request("/")[1]):
                            adapter.public_smoke(fixture.sha)
                        time.sleep(0.02)
                    self.fail("mutated configuration did not become observable")
                adapter.public_configuration.write_bytes(clean)
                adapter.activate(fixture.sha)
                # bootstrap 仅挑战可用，其他路径不提前提供站点。
                adapter.run(fixture.nginx_command + ["-s", "quit"])
                deadline = time.monotonic() + 10
                while fixture.adapter.active_pid.exists():
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.02)
                adapter.public_configuration.write_bytes(bootstrap_config(adapter.webroot, f"127.0.0.1:{adapter.http_port}"))
                adapter.run(fixture.nginx_command)
                self.assertEqual(adapter.public_request(adapter.http_port, "www.axialmuse.com", "/")[0], 503)
                for host in ("axialmuse.com", "www.axialmuse.com"):
                    self.assertEqual(adapter.public_request(adapter.http_port, host, "/.well-known/acme-challenge/test-token")[2], b"fixture-token\n")
                    self.assertEqual(adapter.public_request(adapter.http_port, host, "/.well-known/acme-challenge/nested/test-token")[0], 404)
                self.assertEqual(adapter.public_request(adapter.http_port, "unknown.invalid", "/.well-known/acme-challenge/test-token")[0], 421)
            finally:
                fixture.stop()


if __name__ == "__main__":
    unittest.main()

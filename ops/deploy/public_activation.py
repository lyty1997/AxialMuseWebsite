"""在既有发布锁和恢复事务内检验、切换同代公网配置。"""

import contextlib
import http.client
import os
import re
import secrets
import ssl
import time
from pathlib import Path
from urllib.parse import quote

from ops.deploy.deployment_state import (
    DeploymentError, check_directory, decode, digest, read_file, require, sync_directory, write_new,
)
from ops.deploy.nginx_activation import LocalNginx
from ops.deploy.public_site import (
    CANONICAL, HOSTS, LINEAGE, PUBLIC_CONFIG, SECURITY, WEBROOT, csp_for_store, public_config,
    public_hsts_max_age,
)


def load_public_mode(state, configuration=PUBLIC_CONFIG):
    path = state.root / "public-site.json"
    if not os.path.lexists(path):
        require(not os.path.lexists(configuration), "PUBLIC_MODE_MISSING")
        return None
    mode = decode(read_file(path, state.uid, mode=0o600))
    public_hsts_max_age(mode)
    return mode


class PublicNginx(LocalNginx):
    def __init__(self, store, *, mode, public_configuration=PUBLIC_CONFIG, webroot=WEBROOT,
                 lineage=LINEAGE, http_port=80, https_port=443, candidate_http=18082,
                 candidate_https=18443, public_address="0.0.0.0", tls_context=None, ca_file=None, **kwargs):
        super().__init__(store, **kwargs)
        public_hsts_max_age(mode)
        self.mode = dict(mode)
        self.public_configuration = Path(public_configuration)
        self.webroot = Path(webroot)
        self.lineage = Path(lineage)
        self.http_port, self.https_port = http_port, https_port
        self.candidate_http, self.candidate_https = candidate_http, candidate_https
        require(public_address in ("0.0.0.0", "127.0.0.1"), "PUBLIC_LISTEN")
        self.public_address = public_address
        self.tls_context = tls_context or ssl.create_default_context()
        require(self.tls_context.verify_mode == ssl.CERT_REQUIRED and self.tls_context.check_hostname,
                "PUBLIC_TLS_CONTEXT")
        self.ca_file = ca_file

    def render(self, sha, *, candidate=False):
        return public_config(
            self.store, sha, hsts_max_age=public_hsts_max_age(self.mode), webroot=self.webroot, lineage=self.lineage,
            http=f"127.0.0.1:{self.candidate_http}" if candidate else f"{self.public_address}:{self.http_port}",
            https=f"127.0.0.1:{self.candidate_https}" if candidate else f"{self.public_address}:{self.https_port}",
        )

    def check_certificate(self):
        # 只把固定文件路径传给命令，不把证书或私钥字节写入输出。
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        try:
            context.load_cert_chain(self.lineage / "fullchain.pem", self.lineage / "privkey.pem")
        except (OSError, ssl.SSLError) as error:
            raise DeploymentError("PUBLIC_CERTIFICATE_KEY") from error
        for host in HOSTS:
            command = ["/usr/bin/openssl", "verify", "-purpose", "sslserver", "-verify_hostname", host]
            if self.ca_file is not None:
                command += ["-CAfile", str(self.ca_file)]
            command += ["-untrusted", str(self.lineage / "fullchain.pem"), str(self.lineage / "fullchain.pem")]
            try:
                self.run(command)
            except Exception as error:
                raise DeploymentError("PUBLIC_CERTIFICATE_CHAIN") from error

    def certificate_sha256(self):
        # fullchain 是公开证书；只解析第一个 PEM block，不读取或返回私钥。
        with (self.lineage / "fullchain.pem").open("rb") as source:
            content = source.read(512 * 1024 + 1)
        require(len(content) <= 512 * 1024, "PUBLIC_CERTIFICATE_SIZE")
        leaf = re.match(rb"-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----", content)
        require(leaf is not None, "PUBLIC_CERTIFICATE_FORMAT")
        return digest(ssl.PEM_cert_to_DER_cert(leaf.group().decode("ascii")))

    def public_request(self, port, host, path, *, tls=False, sni=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            connection.connect()
            if tls:
                connection.sock = self.tls_context.wrap_socket(connection.sock, server_hostname=sni or host)
                names = connection.sock.getpeercert().get("subjectAltName", ())
                require(len(names) == len(HOSTS) and set(names) == {("DNS", h) for h in HOSTS},
                        "PUBLIC_CERTIFICATE_NAMES")
                require(digest(connection.sock.getpeercert(binary_form=True)) == self.certificate_sha256(),
                        "PUBLIC_CERTIFICATE_LOADED")
            connection.request("GET", path, headers={"Host": host, "Connection": "close", **(headers or {})})
            response = connection.getresponse()
            body = response.read(128 * 1024 * 1024 + 1)
            require(len(body) <= 128 * 1024 * 1024, "PUBLIC_HTTP_SIZE")
            return response.status, response.getheaders(), body
        finally:
            connection.close()

    def public_smoke(self, sha, *, candidate=False):
        http = self.candidate_http if candidate else self.http_port
        https = self.candidate_https if candidate else self.https_port
        view, receipt, _ = self.store.read_view(sha)
        expected_csp = csp_for_store(self.store, sha)

        def checked(port, host, path, tls):
            code, headers, body = self.public_request(port, host, path, tls=tls)
            for name, value in {**SECURITY, "Content-Security-Policy": expected_csp}.items():
                require([v for k, v in headers if k.lower() == name.lower()] == [value], "PUBLIC_SECURITY_HEADERS")
            hsts = [v for k, v in headers if k.lower() == "strict-transport-security"]
            age = public_hsts_max_age(self.mode)
            require(hsts == ([f"max-age={age}"] if tls and age else []), "PUBLIC_HSTS")
            return code, headers, body

        rules = {rule.source: rule.target for rule in view.rules}
        for tls, port in ((False, http), (True, https)):
            for host in HOSTS:
                for source in sorted(set(("/", "/does-not-exist/")) | set(rules)):
                    query = "?axial=one%20two&repeat=1&repeat=2"
                    code, headers, body = checked(port, host, source + query, tls)
                    if source in rules or not tls or host == "axialmuse.com":
                        target = rules.get(source, source)
                        require(code == 301 and [v for k, v in headers if k.lower() == "location"]
                                == [CANONICAL + target + query], "PUBLIC_REDIRECT")
                    elif source == "/does-not-exist/":
                        require(code == 404, "PUBLIC_HTTP_EXPOSURE")
                        require([v for k, v in headers if k.lower() == "cache-control"] == ["no-store"],
                                "PUBLIC_CACHE")
                    else:
                        require(code == 200 and body, "PUBLIC_HTTP_PAYLOAD")
        for name, expected in receipt["files"].items():
            if not name.startswith("payload/"):
                continue
            path = "/" + name[len("payload/"):]
            if path.endswith("/index.html"):
                path = path[:-len("index.html")]
            code, _, body = checked(https, "www.axialmuse.com", quote(path, safe="/"), True)
            require(code == 200 and digest(body) == expected, "PUBLIC_HTTP_PAYLOAD")
        for path in ("/metadata/release.json", "/config/site-release.conf"):
            require(checked(https, "www.axialmuse.com", path, True)[0] == 404, "PUBLIC_HTTP_EXPOSURE")
        require(checked(http, "unknown.invalid", "/", False)[0] == 421, "PUBLIC_HOST")
        require(self.public_request(https, "unknown.invalid", "/", tls=True,
                                    sni="www.axialmuse.com")[0] == 421, "PUBLIC_HOST")
        try:
            self.public_request(https, "www.axialmuse.com", "/", tls=True, sni="unknown.invalid")
        except ssl.SSLError:
            pass
        else:
            raise DeploymentError("PUBLIC_SNI")

    @contextlib.contextmanager
    def public_candidate(self, sha):
        directory = self.store.state.root / f"https-{secrets.token_hex(16)}"
        directory.mkdir(mode=0o755)
        pid, configuration = directory / "nginx.pid", directory / "nginx.conf"
        content = (
            f"worker_processes 1; pid {pid}; error_log stderr crit;\n"
            "events { worker_connections 128; }\nhttp { access_log off; include /etc/nginx/mime.types;\n"
            + "".join(f"{kind}_temp_path {directory}/{kind};\n" for kind in
                      ("client_body", "proxy", "fastcgi", "uwsgi", "scgi"))
        ).encode() + self.render(sha, candidate=True) + b"}\n"
        write_new(configuration, content, 0o644)
        command = ["/usr/sbin/nginx", "-p", str(directory), "-c", str(configuration)]
        started = False
        try:
            self.run(command + ["-t"])
            self.run(command)
            started = True
            self.public_smoke(sha, candidate=True)
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
        self.check_certificate()
        check_directory(self.webroot, self.store.uid, 0o755)
        # worker 读取挑战文件时已经降权，不能把 webroot 放在 root-only 状态树内。
        require(all(path.stat().st_mode & 0o001 for path in (self.webroot, *self.webroot.parents)),
                "PUBLIC_WEBROOT_TRAVERSE")
        # 已启用模式必须有受管公网配置；首次启用由单独安装事务完成。
        current = self.store.current()
        require(current is not None and read_file(self.public_configuration, self.store.uid, mode=0o644)
                == self.render(current), "PUBLIC_CONFIG_DRIFT")
        super().validate(sha)
        with self.public_candidate(sha):
            pass

    def activate(self, sha):
        path = self.public_configuration
        check_directory(path.parent, self.store.uid, 0o755)
        read_file(path, self.store.uid, mode=0o644)
        temporary = path.parent / f".axial-public-{secrets.token_hex(16)}"
        write_new(temporary, self.render(sha), 0o644)
        os.replace(temporary, path)
        sync_directory(path.parent)
        super().activate(sha)
        self.public_smoke(sha)

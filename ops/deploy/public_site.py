"""从完整且已认证的同代 payload 派生 CSP 和固定公网 Nginx 配置。"""

import base64
import hashlib
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

from ops.deploy.deployment_state import digest, read_file, require
from ops.deploy.release_install import sha_valid


CANONICAL = "https://www.axialmuse.com"
HOSTS = ("axialmuse.com", "www.axialmuse.com")
WEBROOT = Path("/srv/axialmuse-acme")
LINEAGE = Path("/etc/letsencrypt/live/axialmuse.com")
PUBLIC_CONFIG = Path("/etc/nginx/conf.d/axialmuse-public.conf")
LEGACY_HSTS_SECONDS = 15552000
TRIAL_HSTS_SECONDS = 300
SECURITY = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
}


def safe_path(value):
    value = str(value)
    require(re.fullmatch(r"/[A-Za-z0-9_./-]+", value)
            and ".." not in Path(value).parts, "PUBLIC_PATH")
    return value


def local_resource(value):
    if not isinstance(value, str) or not value or "\\" in value or any(ord(char) < 32 for char in value):
        return False
    parsed = urlsplit(value)
    return not parsed.netloc and not parsed.scheme or (
        parsed.scheme == "https" and parsed.netloc == "www.axialmuse.com")


def content_hash(value):
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    return "'sha256-" + base64.b64encode(hashlib.sha256(normalized.encode()).digest()).decode() + "'"


class InlinePolicy(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.active = None
        self.fragments = []
        self.scripts = set()
        self.styles = set()
        self.style_attributes = set()

    def handle_starttag(self, tag, attributes):
        require(len({name for name, _ in attributes}) == len(attributes), "PUBLIC_HTML_ATTRIBUTES")
        attrs = dict(attributes)
        require(not any(name.startswith("on") for name in attrs), "PUBLIC_INLINE_ATTRIBUTE")
        if "style" in attrs:
            # 锁定版本 Docusaurus 的隐藏 SVG sprite 使用这一个静态属性。
            # CSP3 精确哈希只允许该字节值；未知属性必须重新审查。
            require(tag == "svg" and attrs["style"] == "display: none;", "PUBLIC_INLINE_ATTRIBUTE")
            self.style_attributes.add(content_hash(attrs["style"]))
        require(tag not in ("base", "iframe", "object", "embed", "form"), "PUBLIC_HTML_ELEMENT")
        if tag == "script" and "src" in attrs:
            require(local_resource(attrs["src"]), "PUBLIC_EXTERNAL_RESOURCE")
        if tag == "link" and set((attrs.get("rel") or "").lower().split()) & {
            "stylesheet", "preload", "modulepreload", "prefetch", "preconnect", "dns-prefetch",
        }:
            require(local_resource(attrs.get("href") or ""), "PUBLIC_EXTERNAL_RESOURCE")
        if tag in ("script", "style"):
            require(self.active is None, "PUBLIC_HTML_ELEMENT")
            self.active = (tag, "src" in attrs)
            self.fragments = []

    def handle_startendtag(self, tag, attributes):
        self.handle_starttag(tag, attributes)
        self.handle_endtag(tag)

    def handle_data(self, data):
        if self.active is not None:
            self.fragments.append(data)

    def handle_endtag(self, tag):
        if self.active is not None and tag == self.active[0]:
            content = "".join(self.fragments)
            if not self.active[1] and content:
                (self.scripts if tag == "script" else self.styles).add(content_hash(content))
            self.active = None
            self.fragments = []


def csp_for_store(store, sha):
    _, receipt, before = store.read_view(sha)
    scripts, styles, style_attributes = set(), set(), set()
    for name, expected in receipt["files"].items():
        if not name.startswith("payload/") or not name.endswith(".html"):
            continue
        raw = read_file(store.releases / sha / name, store.uid, limit=16 * 1024 * 1024)
        require(digest(raw) == expected, "PUBLIC_PAYLOAD_DRIFT")
        parser = InlinePolicy()
        parser.feed(raw.decode("utf-8", errors="strict"))
        parser.close()
        require(parser.active is None, "PUBLIC_HTML_ELEMENT")
        scripts.update(parser.scripts)
        styles.update(parser.styles)
        style_attributes.update(parser.style_attributes)
    require(store.capture(store.releases / sha) == before, "PUBLIC_PAYLOAD_DRIFT")
    require(len(scripts) + len(styles) <= 64, "PUBLIC_CSP_LIMIT")
    directives = [
        "default-src 'none'",
        "script-src 'self'" + (" " + " ".join(sorted(scripts)) if scripts else ""),
        "script-src-attr 'none'",
        "style-src 'self'" + (" " + " ".join(sorted(styles)) if styles else ""),
        "style-src-attr " + ("'unsafe-hashes' " + " ".join(sorted(style_attributes))
                             if style_attributes else "'none'"),
        "img-src 'self' data:", "font-src 'self'",
        "media-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'",
        "form-action 'none'", "frame-ancestors 'none'", "upgrade-insecure-requests",
    ]
    return "; ".join(directives)


def public_hsts_max_age(mode):
    require(isinstance(mode, dict) and type(mode.get("schema")) is int, "PUBLIC_MODE")
    if mode["schema"] == 1:
        require(set(mode) == {"schema", "hsts"} and type(mode["hsts"]) is bool, "PUBLIC_MODE")
        return LEGACY_HSTS_SECONDS if mode["hsts"] else 0
    require(mode["schema"] == 2 and set(mode) == {"schema", "hstsMaxAge"}
            and type(mode["hstsMaxAge"]) is int
            and mode["hstsMaxAge"] in (0, TRIAL_HSTS_SECONDS), "PUBLIC_MODE")
    return mode["hstsMaxAge"]


def security_headers(csp, hsts=False, *, hsts_max_age=None):
    require(isinstance(csp, str) and not any(char in csp for char in ('"', "\n", "\r", "$", "\\")),
            "PUBLIC_CSP")
    require(type(hsts) is bool, "PUBLIC_MODE")
    if hsts_max_age is None:
        age = LEGACY_HSTS_SECONDS if hsts else 0
    else:
        require(not hsts and type(hsts_max_age) is int
                and hsts_max_age in (0, TRIAL_HSTS_SECONDS, LEGACY_HSTS_SECONDS), "PUBLIC_MODE")
        age = hsts_max_age
    headers = dict(SECURITY, **{"Content-Security-Policy": csp})
    if age:
        headers["Strict-Transport-Security"] = f"max-age={age}"
    return "".join(f'    add_header {key} "{value}" always;\n' for key, value in headers.items())


def host_guard(host):
    escaped = host.replace(".", r"\.")
    return f'    if ($http_host !~* "^{escaped}(:[0-9]+)?$") {{ return 421; }}\n'


def challenge(webroot):
    return (
        "    location ^~ /.well-known/acme-challenge/ {\n"
        '        if ($uri !~ "^/\\.well-known/acme-challenge/[A-Za-z0-9_-]+$") { return 404; }\n'
        f"        root {safe_path(webroot)};\n"
        "        default_type text/plain; try_files $uri =404;\n    }\n"
    )


def bootstrap_config(webroot=WEBROOT, listen="0.0.0.0:80"):
    require(re.fullmatch(r"(?:127\.0\.0\.1|0\.0\.0\.0):[0-9]+", listen), "PUBLIC_LISTEN")
    text = f"server {{ listen {listen} default_server; server_name _; access_log off; error_log /dev/null crit; return 421; }}\n"
    for host in HOSTS:
        text += (
            f"server {{ listen {listen}; server_name {host}; access_log off; error_log /dev/null crit;\n"
            + host_guard(host) + challenge(webroot)
            + "    location / { return 503; }\n}\n"
        )
    return text.encode()


def public_config(store, sha, *, hsts=False, hsts_max_age=None, webroot=WEBROOT, lineage=LINEAGE,
                  http="0.0.0.0:80", https="0.0.0.0:443"):
    sha_valid(sha)
    for listen in (http, https):
        require(re.fullmatch(r"(?:127\.0\.0\.1|0\.0\.0\.0):[0-9]+", listen), "PUBLIC_LISTEN")
    require(http != https, "PUBLIC_LISTEN")
    include = safe_path(store.releases / sha / "config/site-release.conf")
    csp = csp_for_store(store, sha)
    headers = security_headers(csp)
    secure_headers = security_headers(csp, hsts, hsts_max_age=hsts_max_age)
    cert = safe_path(Path(lineage) / "fullchain.pem")
    key = safe_path(Path(lineage) / "privkey.pem")
    # 用 map 处理缓存，避免 location 中 add_header 覆盖整套安全头继承。
    text = (
        "map $uri $axial_resource_cache {\n"
        '    default "public, max-age=3600";\n'
        '    /robots.txt "public, max-age=300"; /sitemap.xml "public, max-age=300";\n'
        '    ~*\\.(mp4|vtt)$ "public, max-age=86400";\n'
        '    "~*\\.[0-9a-f]{8,}\\.(js|css|svg|png|jpe?g|webp|woff2?)$" "public, max-age=31536000, immutable";\n'
        '    ~*(/|\\.html)$ "no-cache";\n}\n'
        'map $status $axial_cache { default $axial_resource_cache; ~^[45] "no-store"; }\n'
        f"server {{ listen {http} default_server; server_name _; access_log off; error_log /dev/null crit;\n"
        + headers + '    add_header Cache-Control "no-store" always;\n    return 421;\n}\n'
        + f"server {{ listen {https} ssl default_server; server_name _; access_log off; error_log /dev/null crit;\n"
        + headers + '    add_header Cache-Control "no-store" always;\n'
        + "    ssl_protocols TLSv1.2 TLSv1.3; ssl_reject_handshake on; return 421;\n}\n"
    )
    for host in HOSTS:
        text += (
            f"server {{ listen {http}; server_name {host}; access_log off; error_log /dev/null crit;\n"
            + host_guard(host) + headers
            + '    add_header Cache-Control "no-store" always;\n'
            + f"    include {include};\n" + challenge(webroot)
            + f"    location / {{ return 301 {CANONICAL}$request_uri; }}\n}}\n"
        )
    for host in HOSTS:
        text += (
            f"server {{ listen {https} ssl; server_name {host}; access_log off; error_log /dev/null crit;\n"
            + host_guard(host)
            + "    ssl_protocols TLSv1.2 TLSv1.3; ssl_session_tickets off;\n"
            + f"    ssl_certificate {cert}; ssl_certificate_key {key};\n"
            + secure_headers + "    add_header Cache-Control $axial_cache always;\n"
            + f"    include {include};\n    index index.html; autoindex off;\n"
        )
        if host == "axialmuse.com":
            text += f"    location / {{ return 301 {CANONICAL}$request_uri; }}\n"
        else:
            text += (
                "    etag on; log_not_found off;\n"
                "    gzip on; gzip_vary on; gzip_min_length 256;\n"
                "    gzip_types text/css application/javascript application/json application/xml text/xml image/svg+xml text/vtt;\n"
                "    location / { try_files $uri $uri/ =404; }\n"
            )
        text += "}\n"
    return text.encode()

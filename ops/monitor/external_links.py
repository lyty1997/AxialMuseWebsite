"""检查已认证页面的公开 Web 外链；所有跳转重新验证，诊断不包含 href。"""

import http.client
import ipaddress
import json
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import time
from urllib.parse import quote, urlsplit, urlunsplit

if __package__:
    from ops.monitor.bounded_process import ProcessOutputLimit, run_process
    from ops.monitor.internal_links import Links
    from ops.monitor.public_health import HealthError, require
    from ops.monitor.web_urls import internal_target, web_target
else:
    from bounded_process import ProcessOutputLimit, run_process
    from internal_links import Links
    from public_health import HealthError, require
    from web_urls import internal_target, web_target


class ExternalStatusError(HealthError):
    def __init__(self, status):
        super().__init__("LINK_EXTERNAL_STATUS")
        self.status = status


def normalize(url, *, base=None):
    try:
        parsed = web_target(url, base)
        require(parsed is not None, "LINK_EXTERNAL_URL")
    except (ValueError, UnicodeError):
        raise HealthError("LINK_EXTERNAL_URL") from None
    path = quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
    query = quote(parsed.query, safe="/%?:@!$&'()*+,;=-._~")
    return urlunsplit((parsed.scheme, parsed.netloc, path, query, ""))


class Transport:
    def request(self, url, method, *, deadline):
        require(time.monotonic() < deadline, "LINK_EXTERNAL_BUDGET")
        try:
            # 独立解释器隔离不可取消的 getaddrinfo 及逐字节延长的响应头读取。
            result = run_process(
                [sys.executable, str(Path(__file__).resolve()), "--request"],
                input=json.dumps([url, method]).encode("utf-8"), output_limit=8 * 1024 * 1024, deadline=deadline,
                env={"PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8"})
        except ProcessOutputLimit:
            raise HealthError("LINK_EXTERNAL_RESPONSE_SIZE") from None
        except subprocess.TimeoutExpired:
            # 唯一请求进程已终止并回收；该进程不派生后代。
            raise HealthError("LINK_EXTERNAL_BUDGET") from None
        require(time.monotonic() < deadline, "LINK_EXTERNAL_BUDGET")
        require(result.returncode == 0, "LINK_EXTERNAL_REQUEST")
        response = json.loads(result.stdout)
        if "code" in response:
            raise HealthError(response["code"])
        return response["status"], response["headers"]

    def request_once(self, url, method):
        """仅供隔离请求进程使用；总时限由父进程强制执行。"""
        parsed = urlsplit(normalize(url))
        require(method in ("HEAD", "GET"), "LINK_EXTERNAL_METHOD")
        host, port = parsed.hostname, 443 if parsed.scheme == "https" else 80
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        require(bool(addresses) and len(addresses) <= 64, "LINK_EXTERNAL_DNS")
        for family, _, _, _, address in addresses:
            target = ipaddress.ip_address(address[0])
            require(family in (socket.AF_INET, socket.AF_INET6)
                    and target.is_global and not target.is_multicast and not target.is_reserved
                    and (target.version != 6 or not (target.ipv4_mapped or target.sixtofour or target.teredo)),
                    "LINK_EXTERNAL_ADDRESS")
        connection = (http.client.HTTPSConnection(host, timeout=10, context=ssl.create_default_context())
                      if parsed.scheme == "https" else http.client.HTTPConnection(host, timeout=10))
        family, kind, protocol, _, address = addresses[0]
        raw = socket.socket(family, kind, protocol)
        try:
            raw.settimeout(10)
            raw.connect(address)
            # 固定到已经验证的地址，SNI 与证书仍按 URL 的原始主机名校验。
            connection.sock = (ssl.create_default_context().wrap_socket(raw, server_hostname=host)
                               if parsed.scheme == "https" else raw)
            target = parsed.path + ("?" + parsed.query if parsed.query else "")
            connection.request(method, target, headers={"Connection": "close", "User-Agent": "AxialMuse-health/1"})
            response = connection.getresponse()
            return response.status, response.getheaders()
        finally:
            connection.close()
            raw.close()


def check_target(url, transport, deadline):
    current = normalize(url)
    visited = set()
    for hop in range(6):
        require(time.monotonic() < deadline, "LINK_EXTERNAL_BUDGET")
        require(current not in visited, "LINK_EXTERNAL_LOOP")
        visited.add(current)
        status, headers = transport.request(current, "HEAD", deadline=deadline)
        if status in (405, 501):
            require(time.monotonic() < deadline, "LINK_EXTERNAL_BUDGET")
            status, headers = transport.request(current, "GET", deadline=deadline)
        if 200 <= status < 300:
            require(time.monotonic() < deadline, "LINK_EXTERNAL_BUDGET")
            return
        if status not in (301, 302, 303, 307, 308):
            raise ExternalStatusError(status)
        locations = [value for key, value in headers if key.lower() == "location"]
        require(len(locations) == 1 and bool(locations[0]), "LINK_EXTERNAL_LOCATION")
        require(hop < 5, "LINK_EXTERNAL_REDIRECT_LIMIT")
        destination = normalize(locations[0], base=current)
        require(not (urlsplit(current).scheme == "https" and urlsplit(destination).scheme != "https"),
                "LINK_EXTERNAL_DOWNGRADE")
        current = destination


class PageLinks(Links):
    def handle_starttag(self, tag, attrs):
        require(tag != "base", "LINK_EXTERNAL_BASE")
        super().handle_starttag(tag, attrs)


def check_external_links(pages, origin_url, transport=None):
    transport = transport or Transport()
    targets = {}
    results = []
    for path, body in pages.items():
        parser = PageLinks()
        parser.feed(body.decode("utf-8", errors="strict"))
        parser.close()
        for index, href in enumerate(parser.hrefs):
            try:
                parsed = web_target(href, origin_url + path)
                if parsed is None or internal_target(parsed, origin_url):
                    continue
                normalized = normalize(parsed.geturl())
                targets.setdefault(normalized, []).append((path, index))
            except (HealthError, ValueError, UnicodeError):
                results.append({"check": f"external-link:{path}:{index}", "status": "failed",
                                "code": "LINK_EXTERNAL_URL"})
    require(len(targets) <= 256, "LINK_EXTERNAL_LIMIT")
    deadline = time.monotonic() + 300
    for url, sources in targets.items():
        try:
            check_target(url, transport, deadline)
            result = {"status": "passed"}
        except Exception as error:
            code = error_code(error)
            result = {"status": "failed", "code": code}
            if isinstance(error, ExternalStatusError):
                result["httpStatus"] = error.status
        results.extend({"check": f"external-link:{path}:{index}", **result} for path, index in sources)
    return results


def error_code(error):
    return str(error) if isinstance(error, HealthError) else "LINK_EXTERNAL_" + {
        ssl.SSLCertVerificationError: "TLS", socket.gaierror: "DNS", TimeoutError: "TIMEOUT",
    }.get(type(error), "REQUEST")


def request_main():
    try:
        url, method = json.loads(sys.stdin.buffer.read(65537))
        status, headers = Transport().request_once(url, method)
        response = {"status": status, "headers": headers}
    except Exception as error:
        response = {"code": error_code(error)}
    sys.stdout.write(json.dumps(response))


if __name__ == "__main__":
    require(sys.argv[1:] == ["--request"], "LINK_EXTERNAL_METHOD")
    request_main()

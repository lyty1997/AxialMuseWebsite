"""仅检查固定公网主机；绑定已验收制品，失败留证，不部署或自动修复。"""

import argparse
import hashlib
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import stat
import time
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote
from xml.etree import ElementTree


HOSTS = ("axialmuse.com", "www.axialmuse.com")
ORIGIN = "https://www.axialmuse.com"
LIMIT = 16 * 1024 * 1024
QUERY = "?axial=one%20two&repeat=1&repeat=2"
SECURITY = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
}


class HealthError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise HealthError(code)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def utc():
    return datetime.now(timezone.utc).isoformat()


def address_digest(addresses):
    return digest(canonical(sorted({str(ipaddress.IPv4Address(a)) for a in addresses})))


def private_json(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1, "HEALTH_INPUT_MODE")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            raw = stream.read(LIMIT + 1)
        require(len(raw) <= LIMIT, "HEALTH_INPUT_SIZE")
        def pairs(items):
            require(len(items) == len(dict(items)), "HEALTH_DUPLICATE_KEY")
            return dict(items)
        return json.loads(raw, object_pairs_hook=pairs)
    finally:
        os.close(descriptor)


def write_receipt(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(canonical(value))
        stream.flush()
        os.fsync(stream.fileno())


def validate_baseline(value):
    require(isinstance(value, dict) and set(value) == {
        "schema", "identity", "files", "pages", "rules", "csp", "hsts", "addressDigest",
        "ledgerSha256", "minimumCertificateDays",
    }, "HEALTH_BASELINE")
    require(type(value["schema"]) is int and value["schema"] == 1, "HEALTH_BASELINE")
    identity = value["identity"]
    require(isinstance(identity, dict) and set(identity) == {
        "workflow_run_id", "artifact_id", "commit_sha", "artifact_digest", "release_content_sha256",
    }, "HEALTH_IDENTITY")
    for key in ("workflow_run_id", "artifact_id"):
        require(isinstance(identity[key], str) and re.fullmatch(r"[1-9][0-9]*", identity[key]), "HEALTH_IDENTITY")
    for key, size in (("commit_sha", 40), ("artifact_digest", 64), ("release_content_sha256", 64)):
        require(isinstance(identity[key], str) and re.fullmatch(r"[0-9a-f]{" + str(size) + "}", identity[key]),
                "HEALTH_IDENTITY")
    for key in ("addressDigest", "ledgerSha256"):
        require(isinstance(value[key], str) and re.fullmatch(r"[0-9a-f]{64}", value[key]), "HEALTH_BASELINE")
    require(type(value["minimumCertificateDays"]) is int and value["minimumCertificateDays"] == 21,
            "HEALTH_CERTIFICATE_POLICY")
    require(value["hsts"] is None or (isinstance(value["hsts"], str)
            and re.fullmatch(r"max-age=[1-9][0-9]*", value["hsts"])), "HEALTH_HSTS_POLICY")
    require(isinstance(value["csp"], str) and value["csp"].startswith("default-src 'none'")
            and not any(x in value["csp"] for x in ("\r", "\n", "unsafe-inline", "unsafe-eval")),
            "HEALTH_CSP_POLICY")
    files = value["files"]
    require(isinstance(files, dict) and files and len(files) <= 10000, "HEALTH_FILES")
    for name, expected in files.items():
        require(isinstance(name, str) and name.startswith("/") and "//" not in name
                and not any(part in (".", "..") for part in name.split("/"))
                and re.fullmatch(r"/[A-Za-z0-9_./~%-]*", name)
                and isinstance(expected, str) and re.fullmatch(r"[0-9a-f]{64}", expected), "HEALTH_FILES")
    pages = value["pages"]
    require(isinstance(pages, list) and pages and len(pages) == len(set(pages))
            and {"/", "/projects/", "/writing/"} <= set(pages)
            and all(isinstance(p, str) and p in files and re.fullmatch(r"/(?:[a-z0-9-]+/)*", p)
                    for p in pages), "HEALTH_PAGES")
    require("/sitemap.xml" in files, "HEALTH_FILES")
    require(isinstance(value["rules"], dict), "HEALTH_RULES")
    for source, target in value["rules"].items():
        require(isinstance(source, str) and re.fullmatch(r"/[a-z0-9/-]+", source)
                and not source.startswith("//") and ".." not in source
                and target in pages and source != target, "HEALTH_RULES")
    return value


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.canonicals = []
        self.noindex = False
        self.icp = False

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "link" and "canonical" in attrs.get("rel", "").lower().split():
            self.canonicals.append(attrs.get("href"))
        if tag == "meta" and (attrs.get("name", "").lower() == "robots"
                              or "bot" in attrs.get("name", "").lower()):
            directives = re.split(r"[\s,]+", attrs.get("content", "").lower())
            self.noindex |= bool({"noindex", "none"} & set(directives))
        if tag == "a" and attrs.get("href") in ("https://beian.miit.gov.cn/", "https://beian.miit.gov.cn"):
            self.icp = True


def check_page(body, path):
    text = body.decode("utf-8")
    page = Page()
    page.feed(text)
    require(page.canonicals == [ORIGIN + path], "HEALTH_CANONICAL")
    require(not page.noindex, "HEALTH_NOINDEX")
    require(page.icp and "沪ICP备2026029086号" in text, "HEALTH_ICP")


def check_robots(body):
    text = body.decode("utf-8")
    fields = [tuple(part.strip() for part in line.split(":", 1))
              for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    require(fields == [("User-agent", "*"), ("Allow", "/"), ("Sitemap", ORIGIN + "/sitemap.xml")],
            "HEALTH_ROBOTS_POLICY")


def header_values(headers, key):
    return [v for k, v in headers if k.lower() == key.lower()]


class Transport:
    def addresses(self, host):
        return {r[4][0] for r in socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)}

    def request(self, secure, host, path, host_header=None):
        require(type(secure) is bool and host in HOSTS, "HEALTH_TARGET")
        require(path.startswith("/") and not path.startswith("//")
                and not any(ord(c) < 32 or ord(c) == 127 for c in path), "HEALTH_TARGET")
        connection = (http.client.HTTPSConnection(host, timeout=10, context=ssl.create_default_context())
                      if secure else http.client.HTTPConnection(host, timeout=10))
        try:
            connection.connect()
            certificate = connection.sock.getpeercert() if secure else None
            connection.request("GET", path, headers={"Connection": "close", "Host": host_header or host})
            response = connection.getresponse()
            body = response.read(LIMIT + 1)
            require(len(body) <= LIMIT, "HEALTH_RESPONSE_SIZE")
            return response.status, response.getheaders(), body, certificate
        finally:
            connection.close()


def sample(baseline, transport=None, now=None):
    validate_baseline(baseline)
    observed_at = utc()
    transport = transport or Transport()
    now = time.time() if now is None else now
    checks = []
    bodies = {}
    certificates = []

    def attempt(name, action):
        try:
            action()
            checks.append({"check": name, "status": "passed"})
        except Exception as error:
            code = str(error) if isinstance(error, HealthError) else "HEALTH_" + {
                ssl.SSLCertVerificationError: "TLS", socket.gaierror: "DNS",
                TimeoutError: "TIMEOUT", UnicodeError: "ENCODING",
            }.get(type(error), "CHECK_FAILED")
            checks.append({"check": name, "status": "failed", "code": code})

    def checked(secure, host, path, host_header=None):
        status, headers, body, certificate = transport.request(secure, host, path, host_header)
        if secure:
            require(isinstance(certificate, dict), "HEALTH_CERTIFICATE")
            require(len(certificate.get("subjectAltName", ())) == 2
                    and set(certificate["subjectAltName"]) == {("DNS", h) for h in HOSTS}, "HEALTH_CERTIFICATE_NAMES")
            remaining = (ssl.cert_time_to_seconds(certificate["notAfter"]) - now) / 86400
            require(remaining >= baseline["minimumCertificateDays"], "HEALTH_CERTIFICATE_EXPIRY")
            certificates.append(round(remaining, 2))
        for key, value in {**SECURITY, "Content-Security-Policy": baseline["csp"]}.items():
            require(header_values(headers, key) == [value], "HEALTH_HEADERS")
        expected_hsts = [baseline["hsts"]] if secure and baseline["hsts"] else []
        require(header_values(headers, "Strict-Transport-Security") == expected_hsts, "HEALTH_HSTS")
        require(not header_values(headers, "Set-Cookie"), "HEALTH_COOKIE")
        require(not any("noindex" in h.lower() or re.search(r"\bnone\b", h.lower())
                        for h in header_values(headers, "X-Robots-Tag")), "HEALTH_NOINDEX")
        return status, headers, body

    for host in HOSTS:
        def dns(host=host):
            require(address_digest(transport.addresses(host)) == baseline["addressDigest"], "HEALTH_DNS_TARGET")
        attempt("dns:" + host, dns)

    for path, expected in baseline["files"].items():
        def payload(path=path, expected=expected):
            status, _, body = checked(True, HOSTS[1], quote(path, safe="/"))
            require(status == 200, "HEALTH_PAYLOAD_STATUS")
            require(digest(body) == expected, "HEALTH_PAYLOAD_IDENTITY")
            bodies[path] = body
        attempt("payload:" + path, payload)

    for path in baseline["pages"]:
        def page(path=path):
            require(path in bodies, "HEALTH_PAGE_MISSING")
            check_page(bodies[path], path)
        attempt("page:" + path, page)

    for secure in (False, True):
        for host in HOSTS:
            for path in sorted(set(("/", "/does-not-exist/")) | set(baseline["rules"])):
                def redirect(secure=secure, host=host, path=path):
                    status, headers, _ = checked(secure, host, path + QUERY)
                    if path in baseline["rules"] or not secure or host == HOSTS[0]:
                        require(status == 301 and header_values(headers, "Location")
                                == [ORIGIN + baseline["rules"].get(path, path) + QUERY], "HEALTH_REDIRECT")
                    else:
                        require(status == (200 if path == "/" else 404), "HEALTH_STATUS")
                attempt(f"redirect:{int(secure)}:{host}:{path}", redirect)

    def robots():
        status, headers, body = checked(True, HOSTS[1], "/robots.txt")
        require(status == 200, "HEALTH_ROBOTS_MISSING")
        require(header_values(headers, "Content-Type")[0].split(";")[0] == "text/plain", "HEALTH_ROBOTS_MIME")
        check_robots(body)
    attempt("robots", robots)

    def sitemap():
        require("/sitemap.xml" in bodies, "HEALTH_SITEMAP_MISSING")
        root = ElementTree.fromstring(bodies["/sitemap.xml"])
        locations = [e.text for e in root.findall("{http://www.sitemaps.org/schemas/sitemap/0.9}url/"
                                                "{http://www.sitemaps.org/schemas/sitemap/0.9}loc")]
        require(len(locations) == len(set(locations)) and set(locations)
                == {ORIGIN + p for p in baseline["pages"]}, "HEALTH_SITEMAP")
    attempt("sitemap", sitemap)

    for path in ("/metadata/release.json", "/config/site-release.conf", "/does-not-exist/"):
        def hidden(path=path):
            require(checked(True, HOSTS[1], path)[0] == 404, "HEALTH_METADATA_EXPOSURE")
        attempt("hidden:" + path, hidden)
    for secure in (False, True):
        def unknown(secure=secure):
            require(checked(secure, HOSTS[1], "/", host_header="unknown.invalid")[0] == 421, "HEALTH_HOST")
        attempt("unknown-host:" + str(int(secure)), unknown)

    failures = [c for c in checks if c["status"] == "failed"]
    return {"schema": 1, "status": "failed" if failures else "passed", "observedAtUtc": observed_at,
            "completedAtUtc": utc(),
            "baselineSha256": digest(canonical(baseline)), "identity": baseline["identity"],
            "checks": checks, "failedCount": len(failures), "checkCount": len(checks),
            "certificateDaysRemaining": min(certificates) if certificates else None,
            "expectedPayloadCount": len(baseline["files"]), "payloadHashesPassed": len(bodies),
            "serverLedgerInspected": False, "mutationsPerformed": False}


def observation_result(samples, *, duration=86400, interval=900):
    require(samples and duration >= 0 and interval > 0, "HEALTH_OBSERVATION_INPUT")
    times = [datetime.fromisoformat(s["observedAtUtc"]).timestamp() for s in samples]
    require(all(t2 > t1 for t1, t2 in zip(times, times[1:])), "HEALTH_OBSERVATION_ORDER")
    identity = samples[0]["baselineSha256"]
    failures = sum(s["status"] != "passed" for s in samples)
    drift = any(s["baselineSha256"] != identity for s in samples)
    gaps = any(t2 - t1 > interval + 120 for t1, t2 in zip(times, times[1:]))
    elapsed = times[-1] - times[0]
    return {"schema": 1, "status": "failed" if failures or drift or gaps else (
        "passed" if elapsed >= duration else "running"), "samples": len(samples),
        "failedSamples": failures, "identityDrift": drift, "samplingGap": gaps,
        "observedSeconds": round(elapsed, 3), "requiredSeconds": duration,
        "startUtc": samples[0]["observedAtUtc"], "lastUtc": samples[-1]["observedAtUtc"],
        "baselineSha256": identity, "mutationsPerformed": False}


def observe(baseline, output, *, duration=86400, interval=900):
    output = Path(output)
    output.mkdir(mode=0o700)
    started = time.monotonic()
    write_receipt(output / "started.json", {"status": "running", "startedAtUtc": utc(),
                  "durationSeconds": duration, "intervalSeconds": interval,
                  "baselineSha256": digest(canonical(baseline)), "localSamplerOnly": True})
    samples = []
    try:
        while True:
            receipt = sample(baseline)
            samples.append(receipt)
            write_receipt(output / f"sample-{len(samples):04}.json", receipt)
            print(json.dumps({"sample": len(samples), "status": receipt["status"],
                              "failedCount": receipt["failedCount"], "observedAtUtc": receipt["observedAtUtc"]}), flush=True)
            span = (datetime.fromisoformat(samples[-1]["observedAtUtc"])
                    - datetime.fromisoformat(samples[0]["observedAtUtc"])).total_seconds()
            if time.monotonic() - started >= duration and span >= duration:
                break
            next_tick = min(started + len(samples) * interval, started + duration)
            time.sleep(max(0, next_tick - time.monotonic()))
    except BaseException:
        write_receipt(output / "interrupted.json", {"status": "interrupted", "atUtc": utc(),
                      "samples": len(samples), "continuousObservationPassed": False})
        raise
    summary = observation_result(samples, duration=duration, interval=interval)
    write_receipt(output / "finished.json", summary)
    return summary


def main(arguments=None):
    parser = argparse.ArgumentParser(description="固定站点只读公网健康检查；失败非零，日志脱敏。")
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--observe", action="store_true")
    args = parser.parse_args(arguments)
    try:
        baseline = validate_baseline(private_json(args.baseline))
        receipt = observe(baseline, args.output) if args.observe else sample(baseline)
        if not args.observe:
            write_receipt(args.output, receipt)
        print(json.dumps({k: receipt[k] for k in ("status",)
                          + (("failedSamples", "samples") if args.observe else ("failedCount", "checkCount"))}))
        return 0 if receipt["status"] == "passed" else 1
    except Exception as error:
        code = str(error) if isinstance(error, HealthError) else "HEALTH_EXECUTION_FAILED"
        print(json.dumps({"status": "failed", "code": code}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

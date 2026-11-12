"""外链检查的故障、脱敏和地址固定边界；不访问真实外站。"""

import json
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

from ops.monitor import bounded_process, external_links, public_health
from ops.monitor.external_links import Transport, check_external_links, normalize
from ops.monitor.public_health import HealthError, ORIGIN
from test_public_health import Fixture, NOW


class FixtureTransport:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def request(self, url, method, *, deadline):
        self.calls.append((url, method))
        value = self.responses.get((url, method), self.responses.get(url))
        if isinstance(value, Exception):
            raise value
        return value


class ExternalLinksTests(unittest.TestCase):
    def run_links(self, html, responses):
        self.transport = FixtureTransport(responses)
        self.checks = check_external_links({"/": html.encode()}, ORIGIN, self.transport)
        return [r.get("code") for r in self.checks if r["status"] == "failed"]

    def test_unique_web_targets_and_all_sources_are_reported(self):
        html = ('<a href="https://outside.example/x#one">1</a>'
                '<a href="https://outside.example/x#two">2</a>'
                '<a href="/projects/">local</a><a href="mailto:x@example.com">mail</a>')
        self.assertEqual(self.run_links(html, {"https://outside.example/x": (200, [])}), [])
        self.assertEqual(self.transport.calls, [("https://outside.example/x", "HEAD")])
        self.assertEqual(len(self.checks), 2)

    def test_redirect_chain_and_head_unsupported_get(self):
        responses = {"https://outside.example/": (301, [("Location", "/new")]),
                     ("https://outside.example/new", "HEAD"): (405, []),
                     ("https://outside.example/new", "GET"): (204, [])}
        self.assertEqual(self.run_links('<a href="https://outside.example/">x</a>', responses), [])
        self.assertEqual(self.transport.calls[-1], ("https://outside.example/new", "GET"))

    def test_forbidden_not_found_rate_limited_and_server_errors_fail_without_retry(self):
        for status in (403, 404, 429, 500, 503):
            with self.subTest(status=status):
                self.assertEqual(self.run_links('<a href="https://outside.example/">x</a>',
                                               {"https://outside.example/": (status, [])}), ["LINK_EXTERNAL_STATUS"])
                self.assertEqual(len(self.transport.calls), 1)
                self.assertEqual(self.checks[0]["httpStatus"], status)

    def test_bad_location_loop_downgrade_and_redirect_limit(self):
        cases = (([("Location", "/"), ("location", "/x")], "LINK_EXTERNAL_LOCATION"),
                 ([], "LINK_EXTERNAL_LOCATION"), ([("Location", "/")], "LINK_EXTERNAL_LOOP"),
                 ([("Location", "http://outside.example/")], "LINK_EXTERNAL_DOWNGRADE"),
                 ([("Location", "https:///missing")], "LINK_EXTERNAL_URL"),
                 ([("Location", "//outside.example:80/")], "LINK_EXTERNAL_URL"),
                 ([("Location", "/new\n")], "LINK_EXTERNAL_URL"),
                 ([("Location", "https://user:secret@outside.example/")], "LINK_EXTERNAL_URL"))
        for headers, code in cases:
            with self.subTest(code=code):
                self.assertEqual(self.run_links('<a href="https://outside.example/">x</a>',
                                               {"https://outside.example/": (302, headers)}), [code])
        responses = {"https://outside.example/" + (str(i) if i else ""): (302, [("Location", "/" + str(i + 1))])
                     for i in range(7)}
        self.assertEqual(self.run_links('<a href="https://outside.example/">x</a>', responses),
                         ["LINK_EXTERNAL_REDIRECT_LIMIT"])
        self.assertEqual(len(self.transport.calls), 6)

    def test_sensitive_href_and_exception_are_not_in_diagnostics(self):
        self.assertEqual(self.run_links('<a href="https://outside.example/private?token=secret">x</a>',
                         {"https://outside.example/private?token=secret": RuntimeError("private exception")}),
                         ["LINK_EXTERNAL_REQUEST"])
        self.assertNotIn("secret", json.dumps(self.checks))
        self.assertNotIn("private", json.dumps(self.checks))
        self.assertEqual(self.checks[0]["check"], "external-link:/:0")

    def test_certificate_and_timeout_errors_fail(self):
        for error, code in ((ssl.SSLCertVerificationError("private"), "LINK_EXTERNAL_TLS"),
                            (TimeoutError("private"), "LINK_EXTERNAL_TIMEOUT")):
            self.assertEqual(self.run_links('<a href="https://outside.example/">x</a>',
                                           {"https://outside.example/": error}), [code])

    def test_base_and_unbounded_target_list_fail_before_requests(self):
        transport = FixtureTransport({})
        for html, code in (('<base href="https://wrong.example/">', "LINK_EXTERNAL_BASE"),
                           (''.join(f'<a href="https://outside.example/{i}">x</a>' for i in range(257)),
                            "LINK_EXTERNAL_LIMIT")):
            with self.assertRaisesRegex(HealthError, code):
                check_external_links({"/": html.encode()}, ORIGIN, transport)
        self.assertEqual(transport.calls, [])

    def test_time_budget_failure_is_reported_for_remaining_targets(self):
        transport = FixtureTransport({"https://outside.example/": (200, [])})
        with patch.object(external_links.time, "monotonic", side_effect=[0, 301]):
            checks = check_external_links({"/": b'<a href="https://outside.example/">x</a>'}, ORIGIN, transport)
        self.assertEqual(checks[0]["code"], "LINK_EXTERNAL_BUDGET")
        self.assertEqual(transport.calls, [])

    def test_missing_authenticated_page_prevents_all_external_requests(self):
        fixture = Fixture()
        fixture.bodies["/projects/"] = b"modified"
        with patch.object(external_links, "check_external_links") as check:
            receipt = public_health.sample(fixture.baseline, fixture, now=NOW, external_links=True)
        check.assert_not_called()
        self.assertIn("HEALTH_PAGE_MISSING", [c.get("code") for c in receipt["checks"]])

    def test_external_failure_propagates_through_public_sample(self):
        fixture = Fixture()
        failure = {"check": "external-link:/:0", "status": "failed", "code": "LINK_EXTERNAL_STATUS"}
        with patch.object(external_links, "check_external_links", return_value=[failure]):
            receipt = public_health.sample(fixture.baseline, fixture, now=NOW, external_links=True)
        self.assertEqual(receipt["status"], "failed")
        self.assertIn(failure, receipt["checks"])
        self.assertIn({"check": "external-links", "status": "failed", "code": "HEALTH_EXTERNAL_LINKS"}, receipt["checks"])


class TransportBoundaryTests(unittest.TestCase):
    def test_url_rejects_credentials_ports_controls_and_normalizes_unicode(self):
        for url in ("https://user:secret@example.com/", "https://example.com:444/", "file:///tmp/x",
                    "https://example.com/\r\nx", "https://example.com/\\x"):
            with self.assertRaises(HealthError):
                normalize(url)
        self.assertEqual(normalize("https://outside.example/中文#fragment"),
                         "https://outside.example/%E4%B8%AD%E6%96%87")

    def test_private_reserved_and_mixed_addresses_never_connect(self):
        for address in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "192.0.2.1", "::1", "fc00::1",
                        "224.0.0.1", "ff0e::1", "64:ff9b::7f00:1", "2002:7f00:1::", "::ffff:127.0.0.1"):
            with self.subTest(address=address):
                family = socket.AF_INET6 if ":" in address else socket.AF_INET
                records = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", 443)),
                           (family, socket.SOCK_STREAM, 6, "", (address, 443))]
                with patch.object(external_links.socket, "getaddrinfo", return_value=records), \
                        patch.object(external_links.socket, "socket") as create:
                    with self.assertRaisesRegex(HealthError, "LINK_EXTERNAL_ADDRESS"):
                        Transport().request_once("https://outside.example/", "HEAD")
                create.assert_not_called()

    def test_connect_uses_only_resolved_address_and_original_tls_name(self):
        records = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", 443))]
        connection = MagicMock()
        connection.getresponse.return_value.status = 200
        connection.getresponse.return_value.getheaders.return_value = []
        context = MagicMock()
        with patch.object(external_links.socket, "getaddrinfo", return_value=records) as resolve, \
                patch.object(external_links.socket, "socket") as create, \
                patch.object(external_links.ssl, "create_default_context", return_value=context), \
                patch.object(external_links.http.client, "HTTPSConnection", return_value=connection):
            self.assertEqual(Transport().request_once("https://outside.example/?x=1", "HEAD"), (200, []))
        resolve.assert_called_once()
        create.return_value.connect.assert_called_once_with(("93.184.215.14", 443))
        context.wrap_socket.assert_called_once_with(create.return_value, server_hostname="outside.example")
        self.assertIs(connection.sock, context.wrap_socket.return_value)
        sent_headers = connection.request.call_args.kwargs["headers"]
        self.assertNotIn("Cookie", sent_headers)
        self.assertNotIn("Referer", sent_headers)

    def test_redirect_to_private_address_rechecks_destination(self):
        records = [[(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]
                   for address in ("93.184.215.14", "127.0.0.1")]
        connection = MagicMock()
        connection.getresponse.return_value.status = 302
        connection.getresponse.return_value.getheaders.return_value = [("Location", "https://127.0.0.1/")]
        with patch.object(external_links.socket, "getaddrinfo", side_effect=records) as resolve, \
                patch.object(external_links.socket, "socket") as create, \
                patch.object(external_links.ssl, "create_default_context"), \
                patch.object(external_links.http.client, "HTTPSConnection", return_value=connection):
            transport = Transport()
            with patch.object(transport, "request", side_effect=lambda url, method, **kw:
                              transport.request_once(url, method)):
                checks = check_external_links({"/": b'<a href="https://outside.example/">x</a>'}, ORIGIN, transport)
        self.assertEqual(checks[0]["code"], "LINK_EXTERNAL_ADDRESS")
        self.assertEqual(resolve.call_count, 2)
        create.assert_called_once()


class DeadlineProcessTests(unittest.TestCase):
    """使用真实子进程和本机 socket，验证阻塞取消而非只比较时钟。"""

    def run_worker(self, setup, *, budget=0.75, interrupt=False):
        processes = []
        popen = subprocess.Popen
        original_selector = bounded_process.selectors.DefaultSelector
        # 只在子进程内替换网络来源，仍执行实际请求入口和父进程超时清理。
        script = ("from ops.monitor import external_links as m\n"
                  "import socket, time\n" + setup + "\nm.request_main()\n")

        def launch(args, **kwargs):
            self.assertEqual(args[1:], [str(external_links.Path(external_links.__file__).resolve()), "--request"])
            process = popen([sys.executable, "-c", script], **kwargs)
            processes.append(process)
            return process

        def select_factory():
            selector = original_selector()
            if interrupt:
                select = selector.select

                def interrupted(*args, **kwargs):
                    selector.select = select
                    raise KeyboardInterrupt

                selector.select = interrupted
            return selector

        started = time.monotonic()
        with patch.object(external_links.subprocess, "Popen", side_effect=launch), \
                patch.object(bounded_process.selectors, "DefaultSelector", side_effect=select_factory):
            try:
                response = Transport().request("http://outside.example/private?token=secret", "HEAD",
                                               deadline=started + budget)
                return response
            finally:
                self.elapsed = time.monotonic() - started
                self.assertLess(self.elapsed, 3)
                self.assertEqual(len(processes), 1)
                self.assertIsNotNone(processes[0].returncode)
                self.assertIsNotNone(processes[0].poll())
                self.returncode = processes[0].returncode

    def test_blocked_dns_is_killed_and_reaped_with_stable_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            ready = external_links.Path(directory) / "resolving"
            setup = (f"def blocked(*a, **kw):\n    m.Path({str(ready)!r}).touch()\n    time.sleep(30)\n"
                     "socket.getaddrinfo = blocked")
            with self.assertRaisesRegex(HealthError, "^LINK_EXTERNAL_BUDGET$"):
                self.run_worker(setup)
            self.assertTrue(ready.exists())
        self.assertGreaterEqual(self.elapsed, 0.65)
        self.assertLess(self.returncode, 0)

    def test_slow_response_headers_cannot_extend_total_deadline(self):
        with socket.socket() as server:
            server.bind(("127.0.0.1", 0))
            server.listen(1)
            server.settimeout(3)
            accepted = threading.Event()
            disconnected = threading.Event()

            def drip():
                try:
                    peer, _ = server.accept()
                    with peer:
                        peer.settimeout(2)
                        peer.recv(8192)
                        accepted.set()
                        for byte in b"HTTP/1.1 200 OK\r\nX-Slow: " + b"x" * 200:
                            peer.sendall(bytes([byte]))
                            if disconnected.wait(0.02):
                                break
                except (BrokenPipeError, ConnectionResetError):
                    disconnected.set()

            worker = threading.Thread(target=drip)
            worker.start()
            port = server.getsockname()[1]
            setup = ("socket.getaddrinfo = lambda *a, **kw: "
                     "[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.215.14', 80))]\n"
                     "original = socket.socket\n"
                     "class LocalSocket(original):\n"
                     f"    def connect(self, address): return super().connect(('127.0.0.1', {port}))\n"
                     "socket.socket = LocalSocket")
            try:
                with self.assertRaisesRegex(HealthError, "^LINK_EXTERNAL_BUDGET$"):
                    self.run_worker(setup)
                self.assertTrue(accepted.is_set())
                self.assertTrue(disconnected.wait(2))
            finally:
                disconnected.set()
                worker.join(3)
                self.assertFalse(worker.is_alive())

    def test_worker_returns_success_and_redacts_network_exceptions(self):
        self.assertEqual(self.run_worker("m.Transport.request_once = lambda *a: (204, [])", budget=2), (204, []))
        for exception, code in (("socket.gaierror('secret')", "DNS"),
                                ("TimeoutError('secret')", "TIMEOUT"),
                                ("m.ssl.SSLCertVerificationError('secret')", "TLS"),
                                ("RuntimeError('secret')", "REQUEST")):
            with self.subTest(code=code), self.assertRaisesRegex(HealthError, "^LINK_EXTERNAL_" + code + "$"):
                self.run_worker("def fail(*a): raise " + exception + "\nm.Transport.request_once = fail", budget=2)

    def test_python_interrupt_kills_and_reaps_worker_before_propagating(self):
        with self.assertRaises(KeyboardInterrupt):
            self.run_worker("time.sleep(30)", interrupt=True)
        self.assertLess(self.returncode, 0)

    def test_actual_worker_entry_preserves_address_validation(self):
        with self.assertRaisesRegex(HealthError, "^LINK_EXTERNAL_ADDRESS$"):
            Transport().request("http://127.0.0.1/private?token=secret", "HEAD", deadline=time.monotonic() + 2)

    def test_redirect_and_get_share_deadline_and_expired_targets_do_not_start(self):
        deadlines = []
        transport = FixtureTransport({})

        def request(url, method, *, deadline):
            deadlines.append(deadline)
            if len(deadlines) == 1:
                return 302, [("Location", "/new")]
            if len(deadlines) == 2:
                return 405, []
            raise HealthError("LINK_EXTERNAL_BUDGET")

        transport.request = request
        pages = {"/": b'<a href="http://outside.example/">a</a><a href="http://other.example/">b</a>'}
        with patch.object(external_links.time, "monotonic", side_effect=[0, 0, 1, 2, 301]):
            checks = check_external_links(pages, ORIGIN, transport)
        self.assertEqual(deadlines, [300, 300, 300])
        self.assertEqual([c["code"] for c in checks], ["LINK_EXTERNAL_BUDGET"] * 2)
        self.assertNotIn("outside.example", json.dumps(checks))
        with patch.object(external_links.subprocess, "Popen") as launch:
            with self.assertRaisesRegex(HealthError, "LINK_EXTERNAL_BUDGET"):
                Transport().request("http://outside.example/", "HEAD", deadline=time.monotonic() - 1)
        launch.assert_not_called()

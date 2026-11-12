"""同一 URL 在两个检查入口中具有相同有效性，分流不能掩盖非法输入。"""

import json
import unittest
from unittest.mock import patch

from ops.monitor import external_links, public_health
from ops.monitor.external_links import check_external_links
from ops.monitor.internal_links import check_internal_links
from ops.monitor.public_health import ORIGIN, digest
from ops.monitor.web_urls import web_target
from test_public_health import Fixture, NOW


class AcceptedTransport:
    def __init__(self):
        self.calls = []

    def request(self, url, method, *, deadline):
        self.calls.append(url)
        return 204, []


class WebUrlTests(unittest.TestCase):
    def test_protocol_port_matrix_is_invariant_under_host_replacement(self):
        for scheme in ("http", "https"):
            for port in ("", ":80", ":443", ":8080", ":bad", ":"):
                valid = port in ("", ":80" if scheme == "http" else ":443")
                for host in ("www.axialmuse.com", "axialmuse.com", "outside.example"):
                    with self.subTest(scheme=scheme, port=port, host=host):
                        pages = {"/": f'<a href="{scheme}://{host}{port}/?private=value#top">x</a>'
                                 '<h1 id="top">home</h1>'}
                        pages = {path: body.encode() for path, body in pages.items()}
                        internal = check_internal_links(pages, {"/"}, {}, ORIGIN)
                        transport = AcceptedTransport()
                        external = check_external_links(pages, ORIGIN, transport)
                        self.assertEqual(bool(internal), not valid)
                        self.assertEqual(any(c["status"] == "failed" for c in external), not valid)
                        self.assertEqual(len(transport.calls), int(valid and host == "outside.example"))
                        self.assertNotIn("private", json.dumps(internal + external))

    def test_resolution_authority_controls_and_fragment_share_one_policy(self):
        for href in ("https://user:secret@www.axialmuse.com/", "//www.axialmuse.com:80/",
                     "https://www.axialmuse.com/\n", "https://www.axialmuse.com/\\x",
                     "https:///missing", "//", "https://[bad]/", "https://www.axialmuse.com:99999/"):
            with self.subTest(href=href):
                with self.assertRaises(ValueError):
                    web_target(href, ORIGIN + "/projects/")
        for href in ("../#top", "https://WWW.AXIALMUSE.COM:443/#top", "//axialmuse.com:443/#top"):
            with self.subTest(href=href):
                target = web_target(href, ORIGIN + "/projects/")
                self.assertEqual((target.path, target.fragment), ("/", "top"))
        self.assertIsNone(web_target("mailto:x@example.com", ORIGIN))

    def test_base_is_rejected_by_both_entries(self):
        pages = {"/": b'<base href="https://outside.example/"><a href="/">x</a>'}
        self.assertEqual(check_internal_links(pages, {"/"}, {}, ORIGIN)[0]["code"], "LINK_BASE")
        transport = AcceptedTransport()
        with self.assertRaisesRegex(public_health.HealthError, "LINK_EXTERNAL_BASE"):
            check_external_links(pages, ORIGIN, transport)
        self.assertEqual(transport.calls, [])

    def test_bad_internal_web_url_fails_combined_public_sample(self):
        fixture = Fixture()
        fixture.bodies["/"] += b'<a href="https://www.axialmuse.com:80/?private=value">bad</a>'
        fixture.baseline["files"]["/"] = digest(fixture.bodies["/"])
        transport = AcceptedTransport()
        with patch.object(external_links, "Transport", return_value=transport):
            receipt = public_health.sample(fixture.baseline, fixture, now=NOW,
                                          internal_links=True, external_links=True)
        codes = {c.get("code") for c in receipt["checks"]}
        self.assertEqual(receipt["status"], "failed")
        self.assertTrue({"LINK_INVALID", "HEALTH_INTERNAL_LINKS", "LINK_EXTERNAL_URL", "HEALTH_EXTERNAL_LINKS"} <= codes)
        self.assertNotIn("private", json.dumps(receipt))
        self.assertFalse(any("axialmuse.com:80" in url for url in transport.calls))

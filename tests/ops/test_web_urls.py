"""站内 URL 解析边界与组合失败；外站链接不发起请求。"""

import json
import unittest
from ops.monitor import public_health
from ops.monitor.internal_links import check_internal_links
from ops.monitor.public_health import ORIGIN, digest
from ops.monitor.web_urls import web_target
from test_public_health import Fixture, NOW


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
                        self.assertEqual(bool(internal), not valid)
                        self.assertNotIn("private", json.dumps(internal))

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

    def test_base_is_rejected_before_internal_resolution(self):
        pages = {"/": b'<base href="https://outside.example/"><a href="/">x</a>'}
        self.assertEqual(check_internal_links(pages, {"/"}, {}, ORIGIN)[0]["code"], "LINK_BASE")

    def test_bad_internal_web_url_fails_combined_public_sample(self):
        fixture = Fixture()
        fixture.bodies["/"] += b'<a href="https://www.axialmuse.com:80/?private=value">bad</a>'
        fixture.baseline["files"]["/"] = digest(fixture.bodies["/"])
        receipt = public_health.sample(fixture.baseline, fixture, now=NOW, internal_links=True)
        codes = {c.get("code") for c in receipt["checks"]}
        self.assertEqual(receipt["status"], "failed")
        self.assertTrue({"LINK_INVALID", "HEALTH_INTERNAL_LINKS"} <= codes)
        self.assertNotIn("private", json.dumps(receipt))

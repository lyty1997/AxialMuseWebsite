"""站内链接的自包含正反例，不访问公网。"""

import unittest

from ops.monitor.internal_links import check_internal_links
from ops.monitor.public_health import ORIGIN


class InternalLinksTests(unittest.TestCase):
    def setUp(self):
        self.pages = {
            "/": b'<a href="/projects#details">project</a><a href="https://outside.invalid/x">external</a>',
            "/projects/": b'<h1 id="details">Project</h1><a href="/#top">home</a>',
        }
        self.pages["/"] += b'<div id="top"></div>'
        self.files = {"/", "/projects/", "/asset.pdf"}
        self.redirects = {"/projects": "/projects/"}

    def test_valid_links_and_redirect_fragment(self):
        self.assertEqual(check_internal_links(self.pages, self.files, self.redirects, ORIGIN), [])

    def test_missing_target_and_anchor_report_without_href(self):
        self.pages["/"] += b'<a href="/missing?private=value">x</a><a href="/projects/#absent">x</a>'
        failures = check_internal_links(self.pages, self.files, self.redirects, ORIGIN)
        self.assertEqual([item["code"] for item in failures], ["LINK_TARGET_MISSING", "LINK_FRAGMENT_MISSING"])
        self.assertNotIn("private", str(failures))

    def test_encoded_fragment_and_same_page(self):
        self.pages["/"] += b'<a href="#t%6fp">x</a>'
        self.assertEqual(check_internal_links(self.pages, self.files, self.redirects, ORIGIN), [])

    def test_invalid_port_is_failure(self):
        self.pages["/"] += b'<a href="https://www.axialmuse.com:bad/">x</a>'
        self.assertEqual(check_internal_links(self.pages, self.files, self.redirects, ORIGIN)[0]["code"], "LINK_INVALID")


if __name__ == "__main__":
    unittest.main()

"""检查已取得的公开页面之间的链接；不发起网络请求。"""

from html.parser import HTMLParser
from urllib.parse import unquote

if __package__:
    from ops.monitor.web_urls import internal_target, web_target
else:
    from web_urls import internal_target, web_target


class Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids = set()
        self.hrefs = []
        self.has_base = False

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "base":
            self.has_base = True
        if attrs.get("id"):
            self.ids.add(attrs["id"])
        if tag == "a":
            if attrs.get("name"):
                self.ids.add(attrs["name"])
            if attrs.get("href"):
                self.hrefs.append(attrs["href"])


def check_internal_links(pages, files, redirects, origin_url):
    """返回脱敏失败清单；输入必须来自已认证且完整取得的同一批制品。"""
    parsed = {}
    for path, body in pages.items():
        parser = Links()
        parser.feed(body.decode("utf-8", errors="strict"))
        parser.close()
        parsed[path] = parser
    failures = []
    for source, page in parsed.items():
        if page.has_base:
            failures.append({"source": source, "linkIndex": 0, "code": "LINK_BASE"})
            continue
        for index, href in enumerate(page.hrefs):
            try:
                target = web_target(href, origin_url + source)
                if target is None or not internal_target(target, origin_url):
                    continue
                path = unquote(target.path, errors="strict") or "/"
                path = redirects.get(path, path)
                if path not in files:
                    code = "LINK_TARGET_MISSING"
                elif target.fragment and (path not in parsed or unquote(target.fragment, errors="strict") not in parsed[path].ids):
                    code = "LINK_FRAGMENT_MISSING"
                else:
                    continue
            except (ValueError, UnicodeError):
                code = "LINK_INVALID"
            failures.append({"source": source, "linkIndex": index, "code": code})
    return failures

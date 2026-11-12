"""Web 链接统一校验；通过后才能决定站内路径检查或外部请求。"""

from urllib.parse import urljoin, urlsplit

if __package__:
    from ops.monitor.public_health import HOSTS
else:
    from public_health import HOSTS


def web_target(reference, base=None):
    if not isinstance(reference, str) or len(reference) > 4096 or any(
            ord(c) < 33 or ord(c) == 127 or c == "\\" for c in reference):
        raise ValueError("invalid reference")
    initial = urlsplit(reference)
    if ((initial.scheme in ("http", "https") or reference.startswith("//")) and not initial.netloc):
        raise ValueError("missing authority")
    target = urlsplit(urljoin(base, reference) if base else reference)
    if target.scheme not in ("http", "https"):
        return None
    if (not target.hostname or target.username is not None or target.password is not None
            or target.port not in (None, 443 if target.scheme == "https" else 80)
            or target.netloc.endswith(":")):
        raise ValueError("invalid authority")
    host = target.hostname.encode("idna").decode("ascii").lower()
    authority = "[" + host + "]" if ":" in host else host
    return target._replace(netloc=authority)


def internal_target(target, origin_url):
    return target.hostname in (*HOSTS, urlsplit(origin_url).hostname)

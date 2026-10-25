import hashlib
import json
import re
from dataclasses import dataclass


LEDGER_SCHEMA_VERSION = "1.0.0"
RUNTIME_SCHEMA_VERSION = "1.0.0"
CANONICAL_ORIGIN = "https://www.axialmuse.com"

COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$", re.ASCII)
CANONICAL_PAGE_PATH_PATTERN = re.compile(
    r"^/(?:[a-z0-9]+(?:-[a-z0-9]+)*/)*$",
    re.ASCII,
)
RULE_SOURCE_PATH_PATTERN = re.compile(
    r"^/(?:[a-z0-9]+(?:-[a-z0-9]+)*/)*"
    r"[a-z0-9]+(?:-[a-z0-9]+)*/?$",
    re.ASCII,
)
RESERVED_ROUTE_PREFIXES = ("/assets", "/img", "/.well-known")
RESERVED_ROUTE_FILES = frozenset(("/404.html", "/robots.txt", "/sitemap.xml"))

LEDGER_KEYS = (
    "schemaVersion",
    "canonicalOrigin",
    "publishedRoutes",
    "redirectEdges",
)
PUBLISHED_ROUTE_KEYS = ("path", "firstRelease")
REDIRECT_EDGE_KEYS = ("kind", "from", "to", "firstRelease")
RUNTIME_KEYS = ("schemaVersion", "canonicalOrigin", "rules")
RUNTIME_RULE_KEYS = ("kind", "from", "to")

ERROR_MESSAGES = {
    "DEPLOY_LEDGER_JSON": "URL 暴露账本不是严格 UTF-8 JSON。",
    "DEPLOY_LEDGER_SCHEMA": "URL 暴露账本不符合固定 schema。",
    "DEPLOY_LEDGER_CANONICAL": "URL 暴露账本不是规范稳定字节。",
    "DEPLOY_LEDGER_ROUTE": "URL 暴露账本含非法或非稳定路由事实。",
    "DEPLOY_LEDGER_EDGE": "URL 暴露账本含非法或非稳定重定向事实。",
    "DEPLOY_LEDGER_CYCLE": "URL 暴露账本含循环的历史重定向事实。",
    "DEPLOY_LEDGER_NON_APPEND": "URL 暴露账本删除或改写了已有事实。",
    "DEPLOY_RELEASE_COMMIT": "候选 release commit SHA 不合法。",
    "DEPLOY_RELEASE_ROUTES": "候选 release 的公开路由集合不合法。",
    "DEPLOY_RELEASE_RUNTIME_JSON": "候选运行清单不是严格 UTF-8 JSON。",
    "DEPLOY_RELEASE_RUNTIME_SCHEMA": "候选运行清单不符合固定 schema。",
    "DEPLOY_RELEASE_RUNTIME_CANONICAL": "候选运行清单不是规范稳定字节。",
    "DEPLOY_RELEASE_RUNTIME_RULE": "候选运行清单不符合单跳规则闭包。",
    "DEPLOY_RELEASE_INCOMPATIBLE_ROUTE": "候选无法解析历史公开路由。",
    "DEPLOY_RELEASE_INCOMPATIBLE_EDGE": "候选无法让历史重定向边收敛到同一 200。",
}


class UrlExposureError(Exception):
    def __init__(self, code, source_path):
        super().__init__(ERROR_MESSAGES.get(code, "URL 暴露账本校验失败。"))
        self.code = code
        self.source_path = _safe_source_path(source_path)
        self.__traceback__ = None


@dataclass(frozen=True)
class PublishedRoute:
    path: str
    first_release: str


@dataclass(frozen=True)
class RedirectEdge:
    kind: str
    source: str
    target: str
    first_release: str


@dataclass(frozen=True)
class ExposureLedger:
    published_routes: tuple
    redirect_edges: tuple


@dataclass(frozen=True)
class RuntimeRule:
    kind: str
    source: str
    target: str


@dataclass(frozen=True)
class ReleaseView:
    commit_sha: str
    published_routes: tuple
    rules: tuple


@dataclass(frozen=True)
class LedgerMergeResult:
    ledger: ExposureLedger
    content: bytes
    before_sha256: str
    after_sha256: str
    changed: bool


class _DuplicateJsonKey(ValueError):
    pass


def _safe_source_path(value):
    if not isinstance(value, str) or not value or len(value) > 512:
        return "ledger/unknown"
    if value.startswith("/") or "\\" in value:
        return "ledger/unknown"
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        return "ledger/unknown"
    if any(segment in ("", ".", "..") for segment in value.split("/")):
        return "ledger/unknown"
    return value


def _fail(code, source_path):
    raise UrlExposureError(code, source_path)


def format_url_exposure_error(error):
    if not isinstance(error, UrlExposureError):
        return (
            "[DEPLOY_LEDGER_INTERNAL] "
            "URL 暴露账本校验发生未分类错误；底层细节已抑制。"
        )
    return f"[{error.code}] ({error.source_path}) {error}"


def _object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateJsonKey(key)
        result[key] = value
    return result


def _reject_json_constant(_value):
    raise ValueError("non-finite JSON number")


def _strict_json_loads(content, error_code, source_path):
    if not isinstance(content, bytes):
        _fail(error_code, source_path)
    try:
        text = content.decode("utf-8", errors="strict")
        return json.loads(
            text,
            object_pairs_hook=_object_pairs,
            parse_constant=_reject_json_constant,
        )
    except UrlExposureError:
        raise
    except Exception:
        _fail(error_code, source_path)


def _canonical_json_bytes(value):
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            indent=2,
            separators=(",", ": "),
        )
        + "\n"
    ).encode("utf-8")


def _assert_exact_keys(value, expected, code, source_path):
    if not isinstance(value, dict) or tuple(value.keys()) != expected:
        _fail(code, source_path)


def _assert_commit(value, code, source_path):
    if not isinstance(value, str) or COMMIT_PATTERN.fullmatch(value) is None:
        _fail(code, source_path)
    return value


def _is_reserved_route(value):
    if value in RESERVED_ROUTE_FILES:
        return True
    return any(
        value == prefix
        or value == f"{prefix}/"
        or value.startswith(f"{prefix}/")
        for prefix in RESERVED_ROUTE_PREFIXES
    )


def _assert_canonical_route(value, code, source_path):
    if (
        not isinstance(value, str)
        or CANONICAL_PAGE_PATH_PATTERN.fullmatch(value) is None
        or _is_reserved_route(value)
    ):
        _fail(code, source_path)
    return value


def _assert_rule_source(value, code, source_path):
    if (
        not isinstance(value, str)
        or RULE_SOURCE_PATH_PATTERN.fullmatch(value) is None
        or _is_reserved_route(value)
    ):
        _fail(code, source_path)
    return value


def empty_exposure_ledger():
    return ExposureLedger(published_routes=(), redirect_edges=())


def _ledger_value(ledger):
    return {
        "schemaVersion": LEDGER_SCHEMA_VERSION,
        "canonicalOrigin": CANONICAL_ORIGIN,
        "publishedRoutes": [
            {
                "path": route.path,
                "firstRelease": route.first_release,
            }
            for route in ledger.published_routes
        ],
        "redirectEdges": [
            {
                "kind": edge.kind,
                "from": edge.source,
                "to": edge.target,
                "firstRelease": edge.first_release,
            }
            for edge in ledger.redirect_edges
        ],
    }


def serialize_exposure_ledger(ledger):
    _validate_exposure_ledger(ledger)
    return _canonical_json_bytes(_ledger_value(ledger))


def _validate_exposure_ledger(ledger):
    if not isinstance(ledger, ExposureLedger):
        _fail("DEPLOY_LEDGER_SCHEMA", "ledger")

    previous_path = None
    published_paths = set()
    for index, route in enumerate(ledger.published_routes):
        source_path = f"ledger/publishedRoutes/{index}"
        if not isinstance(route, PublishedRoute):
            _fail("DEPLOY_LEDGER_ROUTE", source_path)
        _assert_canonical_route(route.path, "DEPLOY_LEDGER_ROUTE", source_path)
        _assert_commit(
            route.first_release,
            "DEPLOY_LEDGER_ROUTE",
            source_path,
        )
        if previous_path is not None and route.path <= previous_path:
            _fail("DEPLOY_LEDGER_ROUTE", source_path)
        previous_path = route.path
        published_paths.add(route.path)

    previous_edge_key = None
    graph = {}
    for index, edge in enumerate(ledger.redirect_edges):
        source_path = f"ledger/redirectEdges/{index}"
        if not isinstance(edge, RedirectEdge) or edge.kind != "registered":
            _fail("DEPLOY_LEDGER_EDGE", source_path)
        _assert_rule_source(edge.source, "DEPLOY_LEDGER_EDGE", source_path)
        _assert_canonical_route(edge.target, "DEPLOY_LEDGER_EDGE", source_path)
        _assert_commit(
            edge.first_release,
            "DEPLOY_LEDGER_EDGE",
            source_path,
        )
        if edge.source == edge.target or edge.target not in published_paths:
            _fail("DEPLOY_LEDGER_EDGE", source_path)
        edge_key = (edge.source, edge.target, edge.kind)
        if previous_edge_key is not None and edge_key <= previous_edge_key:
            _fail("DEPLOY_LEDGER_EDGE", source_path)
        previous_edge_key = edge_key
        graph.setdefault(edge.source, set()).add(edge.target)

    _assert_acyclic_redirect_graph(graph)


def _assert_acyclic_redirect_graph(graph):
    indegree = {}
    for source, targets in graph.items():
        indegree.setdefault(source, 0)
        for target in targets:
            indegree[target] = indegree.get(target, 0) + 1

    pending = [path for path, count in indegree.items() if count == 0]
    visited_count = 0
    while pending:
        source = pending.pop()
        visited_count += 1
        for target in graph.get(source, ()):
            indegree[target] -= 1
            if indegree[target] == 0:
                pending.append(target)

    if visited_count != len(indegree):
        _fail("DEPLOY_LEDGER_CYCLE", "ledger/redirectEdges")


def parse_exposure_ledger(content):
    value = _strict_json_loads(
        content,
        "DEPLOY_LEDGER_JSON",
        "ledger/url-exposure-ledger.json",
    )
    _assert_exact_keys(
        value,
        LEDGER_KEYS,
        "DEPLOY_LEDGER_SCHEMA",
        "ledger/url-exposure-ledger.json",
    )
    if (
        value["schemaVersion"] != LEDGER_SCHEMA_VERSION
        or value["canonicalOrigin"] != CANONICAL_ORIGIN
        or not isinstance(value["publishedRoutes"], list)
        or not isinstance(value["redirectEdges"], list)
    ):
        _fail("DEPLOY_LEDGER_SCHEMA", "ledger/url-exposure-ledger.json")

    published_routes = []
    for index, item in enumerate(value["publishedRoutes"]):
        source_path = f"ledger/publishedRoutes/{index}"
        _assert_exact_keys(
            item,
            PUBLISHED_ROUTE_KEYS,
            "DEPLOY_LEDGER_ROUTE",
            source_path,
        )
        published_routes.append(
            PublishedRoute(
                path=item["path"],
                first_release=item["firstRelease"],
            )
        )

    redirect_edges = []
    for index, item in enumerate(value["redirectEdges"]):
        source_path = f"ledger/redirectEdges/{index}"
        _assert_exact_keys(
            item,
            REDIRECT_EDGE_KEYS,
            "DEPLOY_LEDGER_EDGE",
            source_path,
        )
        redirect_edges.append(
            RedirectEdge(
                kind=item["kind"],
                source=item["from"],
                target=item["to"],
                first_release=item["firstRelease"],
            )
        )

    ledger = ExposureLedger(
        published_routes=tuple(published_routes),
        redirect_edges=tuple(redirect_edges),
    )
    _validate_exposure_ledger(ledger)
    if serialize_exposure_ledger(ledger) != content:
        _fail(
            "DEPLOY_LEDGER_CANONICAL",
            "ledger/url-exposure-ledger.json",
        )
    return ledger


def _validate_published_routes(published_routes):
    if not isinstance(published_routes, (tuple, list)):
        _fail("DEPLOY_RELEASE_ROUTES", "release/publishedRoutes")
    normalized = tuple(published_routes)
    previous = None
    for index, path in enumerate(normalized):
        _assert_canonical_route(
            path,
            "DEPLOY_RELEASE_ROUTES",
            f"release/publishedRoutes/{index}",
        )
        if previous is not None and path <= previous:
            _fail(
                "DEPLOY_RELEASE_ROUTES",
                f"release/publishedRoutes/{index}",
            )
        previous = path
    if not normalized or normalized[0] != "/":
        _fail("DEPLOY_RELEASE_ROUTES", "release/publishedRoutes")
    return normalized


def _validate_runtime_rules(rules, published_routes):
    route_set = set(published_routes)
    sources = set()
    previous_source = None
    registered = {}
    canonical = {}

    for index, rule in enumerate(rules):
        source_path = f"release/runtime/rules/{index}"
        if not isinstance(rule, RuntimeRule):
            _fail("DEPLOY_RELEASE_RUNTIME_RULE", source_path)
        if rule.kind not in ("registered", "canonical-slash"):
            _fail("DEPLOY_RELEASE_RUNTIME_RULE", source_path)
        _assert_rule_source(
            rule.source,
            "DEPLOY_RELEASE_RUNTIME_RULE",
            source_path,
        )
        _assert_canonical_route(
            rule.target,
            "DEPLOY_RELEASE_RUNTIME_RULE",
            source_path,
        )
        if (
            previous_source is not None
            and rule.source <= previous_source
        ):
            _fail("DEPLOY_RELEASE_RUNTIME_RULE", source_path)
        if (
            rule.source in route_set
            or rule.target not in route_set
            or rule.source == rule.target
        ):
            _fail("DEPLOY_RELEASE_RUNTIME_RULE", source_path)
        previous_source = rule.source
        sources.add(rule.source)
        if rule.kind == "registered":
            registered[rule.source] = rule.target
        else:
            if (
                rule.target == "/"
                or not rule.target.endswith("/")
                or rule.source != rule.target[:-1]
            ):
                _fail("DEPLOY_RELEASE_RUNTIME_RULE", source_path)
            canonical[rule.source] = rule.target

    if any(rule.target in sources for rule in rules):
        _fail("DEPLOY_RELEASE_RUNTIME_RULE", "release/runtime/rules")

    for source, target in registered.items():
        canonical_source = source if source.endswith("/") else f"{source}/"
        alias_source = canonical_source[:-1]
        if (
            registered.get(canonical_source) != target
            or registered.get(alias_source) != target
        ):
            _fail("DEPLOY_RELEASE_RUNTIME_RULE", "release/runtime/rules")

    expected_canonical = {
        route[:-1]: route
        for route in published_routes
        if route != "/"
    }
    if canonical != expected_canonical:
        _fail("DEPLOY_RELEASE_RUNTIME_RULE", "release/runtime/rules")


def make_release_view(*, commit_sha, published_routes, runtime_content):
    commit_sha = _assert_commit(
        commit_sha,
        "DEPLOY_RELEASE_COMMIT",
        "release/commitSha",
    )
    published_routes = _validate_published_routes(published_routes)
    value = _strict_json_loads(
        runtime_content,
        "DEPLOY_RELEASE_RUNTIME_JSON",
        "release/runtime-redirects.json",
    )
    _assert_exact_keys(
        value,
        RUNTIME_KEYS,
        "DEPLOY_RELEASE_RUNTIME_SCHEMA",
        "release/runtime-redirects.json",
    )
    if (
        value["schemaVersion"] != RUNTIME_SCHEMA_VERSION
        or value["canonicalOrigin"] != CANONICAL_ORIGIN
        or not isinstance(value["rules"], list)
    ):
        _fail(
            "DEPLOY_RELEASE_RUNTIME_SCHEMA",
            "release/runtime-redirects.json",
        )

    rules = []
    for index, item in enumerate(value["rules"]):
        source_path = f"release/runtime/rules/{index}"
        _assert_exact_keys(
            item,
            RUNTIME_RULE_KEYS,
            "DEPLOY_RELEASE_RUNTIME_RULE",
            source_path,
        )
        rules.append(
            RuntimeRule(
                kind=item["kind"],
                source=item["from"],
                target=item["to"],
            )
        )

    release = ReleaseView(
        commit_sha=commit_sha,
        published_routes=published_routes,
        rules=tuple(rules),
    )
    _validate_runtime_rules(release.rules, release.published_routes)
    if _canonical_json_bytes(value) != runtime_content:
        _fail(
            "DEPLOY_RELEASE_RUNTIME_CANONICAL",
            "release/runtime-redirects.json",
        )
    return release


def _resolve_release_path(release, path):
    if path in release.published_routes:
        return path
    targets = {
        rule.source: rule.target
        for rule in release.rules
    }
    return targets.get(path)


def assert_ledger_append_only(before, after):
    """持久化前比较完整事实；规范 JSON 本身不能证明历史未被改写。"""
    _validate_exposure_ledger(before)
    _validate_exposure_ledger(after)
    after_routes = {route.path: route for route in after.published_routes}
    after_edges = {
        (edge.source, edge.target, edge.kind): edge
        for edge in after.redirect_edges
    }
    for index, route in enumerate(before.published_routes):
        if after_routes.get(route.path) != route:
            _fail("DEPLOY_LEDGER_NON_APPEND", f"ledger/publishedRoutes/{index}")
    for index, edge in enumerate(before.redirect_edges):
        if after_edges.get((edge.source, edge.target, edge.kind)) != edge:
            _fail("DEPLOY_LEDGER_NON_APPEND", f"ledger/redirectEdges/{index}")
    return True


def assert_release_compatible(ledger, release):
    _validate_exposure_ledger(ledger)
    if not isinstance(release, ReleaseView):
        _fail("DEPLOY_RELEASE_RUNTIME_SCHEMA", "release")
    _assert_commit(
        release.commit_sha,
        "DEPLOY_RELEASE_COMMIT",
        "release/commitSha",
    )
    _validate_published_routes(release.published_routes)
    _validate_runtime_rules(release.rules, release.published_routes)

    for index, route in enumerate(ledger.published_routes):
        if _resolve_release_path(release, route.path) is None:
            _fail(
                "DEPLOY_RELEASE_INCOMPATIBLE_ROUTE",
                f"ledger/publishedRoutes/{index}",
            )

    for index, edge in enumerate(ledger.redirect_edges):
        source_target = _resolve_release_path(release, edge.source)
        historical_target = _resolve_release_path(release, edge.target)
        if (
            source_target is None
            or historical_target is None
            or source_target != historical_target
        ):
            _fail(
                "DEPLOY_RELEASE_INCOMPATIBLE_EDGE",
                f"ledger/redirectEdges/{index}",
            )
    return True


def merge_candidate_exposure(ledger, release):
    _validate_exposure_ledger(ledger)
    assert_release_compatible(ledger, release)
    before_content = serialize_exposure_ledger(ledger)

    routes_by_path = {
        route.path: route
        for route in ledger.published_routes
    }
    for path in release.published_routes:
        routes_by_path.setdefault(
            path,
            PublishedRoute(path=path, first_release=release.commit_sha),
        )

    edges_by_key = {
        (edge.source, edge.target, edge.kind): edge
        for edge in ledger.redirect_edges
    }
    for rule in release.rules:
        if rule.kind != "registered":
            continue
        key = (rule.source, rule.target, rule.kind)
        edges_by_key.setdefault(
            key,
            RedirectEdge(
                kind=rule.kind,
                source=rule.source,
                target=rule.target,
                first_release=release.commit_sha,
            ),
        )

    merged = ExposureLedger(
        published_routes=tuple(
            routes_by_path[path]
            for path in sorted(routes_by_path)
        ),
        redirect_edges=tuple(
            edges_by_key[key]
            for key in sorted(edges_by_key)
        ),
    )
    after_content = serialize_exposure_ledger(merged)
    assert_ledger_append_only(ledger, merged)
    assert_release_compatible(merged, release)
    return LedgerMergeResult(
        ledger=merged,
        content=after_content,
        before_sha256=hashlib.sha256(before_content).hexdigest(),
        after_sha256=hashlib.sha256(after_content).hexdigest(),
        changed=before_content != after_content,
    )


def prepare_candidate_ledger(
    *,
    ledger_content,
    commit_sha,
    published_routes,
    runtime_content,
):
    ledger = parse_exposure_ledger(ledger_content)
    release = make_release_view(
        commit_sha=commit_sha,
        published_routes=published_routes,
        runtime_content=runtime_content,
    )
    return merge_candidate_exposure(ledger, release)

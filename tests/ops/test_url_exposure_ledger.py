import hashlib
import importlib.util
import json
import sys
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
LEDGER_PATH = REPOSITORY_ROOT / "ops" / "deploy" / "url_exposure_ledger.py"
VERIFIER_PATH = REPOSITORY_ROOT / "ops" / "deploy" / "verify_artifact.py"
SPEC = importlib.util.spec_from_file_location(
    "axial_muse_url_exposure_ledger",
    LEDGER_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("无法加载 URL 暴露账本核心。")
LEDGER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = LEDGER
SPEC.loader.exec_module(LEDGER)

VERIFIER_SPEC = importlib.util.spec_from_file_location(
    "axial_muse_artifact_verifier_for_ledger_test",
    VERIFIER_PATH,
)
if VERIFIER_SPEC is None or VERIFIER_SPEC.loader is None:
    raise RuntimeError("无法加载服务器 artifact verifier。")
VERIFIER = importlib.util.module_from_spec(VERIFIER_SPEC)
sys.modules[VERIFIER_SPEC.name] = VERIFIER
VERIFIER_SPEC.loader.exec_module(VERIFIER)


FIRST_SHA = "a" * 40
SECOND_SHA = "b" * 40
THIRD_SHA = "c" * 40


def canonical_json(value):
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            indent=2,
            separators=(",", ": "),
        )
        + "\n"
    ).encode("utf-8")


def runtime_content(routes, registered=()):
    rules = []
    for source, target in registered:
        canonical_source = source if source.endswith("/") else f"{source}/"
        rules.extend(
            (
                {
                    "kind": "registered",
                    "from": canonical_source[:-1],
                    "to": target,
                },
                {
                    "kind": "registered",
                    "from": canonical_source,
                    "to": target,
                },
            )
        )
    for route in routes:
        if route == "/":
            continue
        rules.append(
            {
                "kind": "canonical-slash",
                "from": route[:-1],
                "to": route,
            }
        )
    rules.sort(key=lambda rule: rule["from"])
    return canonical_json(
        {
            "schemaVersion": "1.0.0",
            "canonicalOrigin": "https://www.axialmuse.com",
            "rules": rules,
        }
    )


def release(commit_sha, routes, registered=()):
    return LEDGER.make_release_view(
        commit_sha=commit_sha,
        published_routes=routes,
        runtime_content=runtime_content(routes, registered),
    )


def empty_bytes():
    return LEDGER.serialize_exposure_ledger(LEDGER.empty_exposure_ledger())


class UrlExposureLedgerTests(unittest.TestCase):
    def test_empty_ledger_has_stable_canonical_bytes(self):
        expected = canonical_json(
            {
                "schemaVersion": "1.0.0",
                "canonicalOrigin": "https://www.axialmuse.com",
                "publishedRoutes": [],
                "redirectEdges": [],
            }
        )
        self.assertEqual(empty_bytes(), expected)
        self.assertEqual(
            LEDGER.parse_exposure_ledger(expected),
            LEDGER.empty_exposure_ledger(),
        )

    def test_first_merge_is_append_only_and_idempotent(self):
        candidate = release(
            FIRST_SHA,
            ("/", "/a/"),
            (("/legacy/", "/a/"),),
        )
        initial = LEDGER.empty_exposure_ledger()
        first = LEDGER.merge_candidate_exposure(initial, candidate)
        second = LEDGER.merge_candidate_exposure(first.ledger, candidate)

        self.assertTrue(first.changed)
        self.assertFalse(second.changed)
        self.assertEqual(first.content, second.content)
        self.assertEqual(first.after_sha256, second.after_sha256)
        self.assertEqual(
            first.before_sha256,
            hashlib.sha256(empty_bytes()).hexdigest(),
        )
        self.assertEqual(
            [(item.path, item.first_release) for item in first.ledger.published_routes],
            [("/", FIRST_SHA), ("/a/", FIRST_SHA)],
        )
        self.assertEqual(
            [
                (item.source, item.target, item.first_release)
                for item in first.ledger.redirect_edges
            ],
            [
                ("/legacy", "/a/", FIRST_SHA),
                ("/legacy/", "/a/", FIRST_SHA),
            ],
        )

    def test_second_migration_preserves_old_facts_and_converges(self):
        first_release = release(
            FIRST_SHA,
            ("/", "/a/"),
            (("/legacy/", "/a/"),),
        )
        first = LEDGER.merge_candidate_exposure(
            LEDGER.empty_exposure_ledger(),
            first_release,
        )
        second_release = release(
            SECOND_SHA,
            ("/", "/b/"),
            (
                ("/a/", "/b/"),
                ("/legacy/", "/b/"),
            ),
        )
        second = LEDGER.merge_candidate_exposure(first.ledger, second_release)

        self.assertTrue(LEDGER.assert_release_compatible(second.ledger, second_release))
        self.assertEqual(
            [(item.path, item.first_release) for item in second.ledger.published_routes],
            [
                ("/", FIRST_SHA),
                ("/a/", FIRST_SHA),
                ("/b/", SECOND_SHA),
            ],
        )
        self.assertIn(
            ("/legacy/", "/a/", FIRST_SHA),
            [
                (item.source, item.target, item.first_release)
                for item in second.ledger.redirect_edges
            ],
        )
        self.assertIn(
            ("/legacy/", "/b/", SECOND_SHA),
            [
                (item.source, item.target, item.first_release)
                for item in second.ledger.redirect_edges
            ],
        )

    def test_reverse_migration_cannot_create_historical_cycle(self):
        first_release = release(
            FIRST_SHA,
            ("/", "/a/"),
            (("/b/", "/a/"),),
        )
        first = LEDGER.merge_candidate_exposure(
            LEDGER.empty_exposure_ledger(),
            first_release,
        )
        reverse_release = release(
            SECOND_SHA,
            ("/", "/b/"),
            (("/a/", "/b/"),),
        )

        with self.assertRaises(LEDGER.UrlExposureError) as captured:
            LEDGER.merge_candidate_exposure(first.ledger, reverse_release)
        self.assertEqual(captured.exception.code, "DEPLOY_LEDGER_CYCLE")

    def test_missing_historical_source_fails_even_when_target_is_200(self):
        initial_release = release(
            FIRST_SHA,
            ("/", "/a/"),
            (("/legacy/", "/a/"),),
        )
        ledger = LEDGER.merge_candidate_exposure(
            LEDGER.empty_exposure_ledger(),
            initial_release,
        ).ledger
        missing_source = release(SECOND_SHA, ("/", "/a/"))

        with self.assertRaises(LEDGER.UrlExposureError) as captured:
            LEDGER.assert_release_compatible(ledger, missing_source)
        self.assertEqual(
            captured.exception.code,
            "DEPLOY_RELEASE_INCOMPATIBLE_EDGE",
        )

    def test_historical_target_404_fails_before_edge_can_be_accepted(self):
        initial_release = release(
            FIRST_SHA,
            ("/", "/a/"),
            (("/legacy/", "/a/"),),
        )
        ledger = LEDGER.merge_candidate_exposure(
            LEDGER.empty_exposure_ledger(),
            initial_release,
        ).ledger
        missing_target = release(
            SECOND_SHA,
            ("/", "/b/"),
            (("/legacy/", "/b/"),),
        )

        with self.assertRaises(LEDGER.UrlExposureError) as captured:
            LEDGER.assert_release_compatible(ledger, missing_target)
        self.assertEqual(
            captured.exception.code,
            "DEPLOY_RELEASE_INCOMPATIBLE_ROUTE",
        )

    def test_historical_source_and_target_must_resolve_to_same_200(self):
        initial_release = release(
            FIRST_SHA,
            ("/", "/a/"),
            (("/legacy/", "/a/"),),
        )
        ledger = LEDGER.merge_candidate_exposure(
            LEDGER.empty_exposure_ledger(),
            initial_release,
        ).ledger
        split_release = release(
            SECOND_SHA,
            ("/", "/b/", "/c/"),
            (
                ("/a/", "/c/"),
                ("/legacy/", "/b/"),
            ),
        )

        with self.assertRaises(LEDGER.UrlExposureError) as captured:
            LEDGER.assert_release_compatible(ledger, split_release)
        self.assertEqual(
            captured.exception.code,
            "DEPLOY_RELEASE_INCOMPATIBLE_EDGE",
        )

    def test_canonical_slash_adds_target_route_but_not_ledger_edge(self):
        candidate = release(SECOND_SHA, ("/", "/new/"))
        merged = LEDGER.merge_candidate_exposure(
            LEDGER.empty_exposure_ledger(),
            candidate,
        )
        self.assertEqual(
            [item.path for item in merged.ledger.published_routes],
            ["/", "/new/"],
        )
        self.assertEqual(merged.ledger.redirect_edges, ())

        old_release = release(FIRST_SHA, ("/",))
        with self.assertRaises(LEDGER.UrlExposureError) as captured:
            LEDGER.assert_release_compatible(merged.ledger, old_release)
        self.assertEqual(
            captured.exception.code,
            "DEPLOY_RELEASE_INCOMPATIBLE_ROUTE",
        )

    def test_prepare_candidate_ledger_returns_bound_digests(self):
        result = LEDGER.prepare_candidate_ledger(
            ledger_content=empty_bytes(),
            commit_sha=FIRST_SHA,
            published_routes=("/", "/a/"),
            runtime_content=runtime_content(
                ("/", "/a/"),
                (("/legacy/", "/a/"),),
            ),
        )
        self.assertEqual(
            result.before_sha256,
            hashlib.sha256(empty_bytes()).hexdigest(),
        )
        self.assertEqual(
            result.after_sha256,
            hashlib.sha256(result.content).hexdigest(),
        )
        self.assertEqual(
            LEDGER.parse_exposure_ledger(result.content),
            result.ledger,
        )

    def test_ledger_rejects_duplicate_keys_unknown_fields_and_noncanonical_bytes(self):
        duplicate = (
            b'{"schemaVersion":"1.0.0","schemaVersion":"1.0.0",'
            b'"canonicalOrigin":"https://www.axialmuse.com",'
            b'"publishedRoutes":[],"redirectEdges":[]}'
        )
        with self.assertRaises(LEDGER.UrlExposureError) as captured:
            LEDGER.parse_exposure_ledger(duplicate)
        self.assertEqual(captured.exception.code, "DEPLOY_LEDGER_JSON")

        unknown = {
            "schemaVersion": "1.0.0",
            "canonicalOrigin": "https://www.axialmuse.com",
            "publishedRoutes": [],
            "redirectEdges": [],
            "extra": True,
        }
        with self.assertRaises(LEDGER.UrlExposureError) as captured:
            LEDGER.parse_exposure_ledger(canonical_json(unknown))
        self.assertEqual(captured.exception.code, "DEPLOY_LEDGER_SCHEMA")

        compact = json.dumps(
            {
                "schemaVersion": "1.0.0",
                "canonicalOrigin": "https://www.axialmuse.com",
                "publishedRoutes": [],
                "redirectEdges": [],
            },
            separators=(",", ":"),
        ).encode("ascii")
        with self.assertRaises(LEDGER.UrlExposureError) as captured:
            LEDGER.parse_exposure_ledger(compact)
        self.assertEqual(captured.exception.code, "DEPLOY_LEDGER_CANONICAL")

    def test_ledger_rejects_unsorted_or_rewritten_fact_shapes(self):
        unsorted_routes = canonical_json(
            {
                "schemaVersion": "1.0.0",
                "canonicalOrigin": "https://www.axialmuse.com",
                "publishedRoutes": [
                    {"path": "/b/", "firstRelease": FIRST_SHA},
                    {"path": "/a/", "firstRelease": FIRST_SHA},
                ],
                "redirectEdges": [],
            }
        )
        with self.assertRaises(LEDGER.UrlExposureError) as captured:
            LEDGER.parse_exposure_ledger(unsorted_routes)
        self.assertEqual(captured.exception.code, "DEPLOY_LEDGER_ROUTE")

        target_not_published = canonical_json(
            {
                "schemaVersion": "1.0.0",
                "canonicalOrigin": "https://www.axialmuse.com",
                "publishedRoutes": [
                    {"path": "/", "firstRelease": FIRST_SHA},
                ],
                "redirectEdges": [
                    {
                        "kind": "registered",
                        "from": "/legacy",
                        "to": "/missing/",
                        "firstRelease": FIRST_SHA,
                    }
                ],
            }
        )
        with self.assertRaises(LEDGER.UrlExposureError) as captured:
            LEDGER.parse_exposure_ledger(target_not_published)
        self.assertEqual(captured.exception.code, "DEPLOY_LEDGER_EDGE")

    def test_runtime_rejects_missing_alias_chain_and_canonical_gap(self):
        missing_alias = canonical_json(
            {
                "schemaVersion": "1.0.0",
                "canonicalOrigin": "https://www.axialmuse.com",
                "rules": [
                    {"kind": "canonical-slash", "from": "/a", "to": "/a/"},
                    {"kind": "registered", "from": "/legacy/", "to": "/a/"},
                ],
            }
        )
        with self.assertRaises(LEDGER.UrlExposureError) as captured:
            LEDGER.make_release_view(
                commit_sha=FIRST_SHA,
                published_routes=("/", "/a/"),
                runtime_content=missing_alias,
            )
        self.assertEqual(
            captured.exception.code,
            "DEPLOY_RELEASE_RUNTIME_RULE",
        )

        chain = canonical_json(
            {
                "schemaVersion": "1.0.0",
                "canonicalOrigin": "https://www.axialmuse.com",
                "rules": [
                    {"kind": "registered", "from": "/a", "to": "/b/"},
                    {"kind": "registered", "from": "/a/", "to": "/b/"},
                    {"kind": "canonical-slash", "from": "/b", "to": "/b/"},
                    {"kind": "registered", "from": "/legacy", "to": "/a/"},
                    {"kind": "registered", "from": "/legacy/", "to": "/a/"},
                ],
            }
        )
        with self.assertRaises(LEDGER.UrlExposureError) as captured:
            LEDGER.make_release_view(
                commit_sha=SECOND_SHA,
                published_routes=("/", "/b/"),
                runtime_content=chain,
            )
        self.assertEqual(
            captured.exception.code,
            "DEPLOY_RELEASE_RUNTIME_RULE",
        )

        missing_canonical = canonical_json(
            {
                "schemaVersion": "1.0.0",
                "canonicalOrigin": "https://www.axialmuse.com",
                "rules": [],
            }
        )
        with self.assertRaises(LEDGER.UrlExposureError) as captured:
            LEDGER.make_release_view(
                commit_sha=THIRD_SHA,
                published_routes=("/", "/new/"),
                runtime_content=missing_canonical,
            )
        self.assertEqual(
            captured.exception.code,
            "DEPLOY_RELEASE_RUNTIME_RULE",
        )

    def test_runtime_rejects_noncanonical_bytes_and_error_is_redacted(self):
        compact = json.dumps(
            {
                "schemaVersion": "1.0.0",
                "canonicalOrigin": "https://www.axialmuse.com",
                "rules": [],
            },
            separators=(",", ":"),
        ).encode("ascii")
        with self.assertRaises(LEDGER.UrlExposureError) as captured:
            LEDGER.make_release_view(
                commit_sha=FIRST_SHA,
                published_routes=("/",),
                runtime_content=compact,
            )
        self.assertEqual(
            captured.exception.code,
            "DEPLOY_RELEASE_RUNTIME_CANONICAL",
        )
        diagnostic = LEDGER.format_url_exposure_error(captured.exception)
        self.assertEqual(
            diagnostic,
            "[DEPLOY_RELEASE_RUNTIME_CANONICAL] "
            "(release/runtime-redirects.json) "
            "候选运行清单不是规范稳定字节。",
        )
        self.assertNotIn(str(REPOSITORY_ROOT), diagnostic)

    def test_reserved_route_contract_matches_server_verifier(self):
        corpus = (
            "/assets",
            "/assets/",
            "/assets/nested/",
            "/img",
            "/img/",
            "/img/nested/",
            "/.well-known",
            "/.well-known/acme-challenge/",
            "/404.html",
            "/robots.txt",
            "/sitemap.xml",
            "/",
            "/asset/",
            "/images/",
            "/assets-old/",
        )
        self.assertEqual(
            [LEDGER._is_reserved_route(path) for path in corpus],
            [VERIFIER._is_reserved_route(path) for path in corpus],
        )

    def test_reserved_routes_cannot_enter_release_or_ledger(self):
        for reserved_route in ("/assets/", "/img/", "/assets/nested/"):
            with self.subTest(route=reserved_route):
                with self.assertRaises(LEDGER.UrlExposureError) as captured:
                    release(FIRST_SHA, ("/", reserved_route))
                self.assertEqual(
                    captured.exception.code,
                    "DEPLOY_RELEASE_ROUTES",
                )

        for reserved_source in ("/assets/", "/img/"):
            with self.subTest(source=reserved_source):
                with self.assertRaises(LEDGER.UrlExposureError) as captured:
                    release(
                        FIRST_SHA,
                        ("/", "/a/"),
                        ((reserved_source, "/a/"),),
                    )
                self.assertEqual(
                    captured.exception.code,
                    "DEPLOY_RELEASE_RUNTIME_RULE",
                )

        reserved_ledger = canonical_json(
            {
                "schemaVersion": "1.0.0",
                "canonicalOrigin": "https://www.axialmuse.com",
                "publishedRoutes": [
                    {"path": "/", "firstRelease": FIRST_SHA},
                    {"path": "/a/", "firstRelease": FIRST_SHA},
                ],
                "redirectEdges": [
                    {
                        "kind": "registered",
                        "from": "/assets",
                        "to": "/a/",
                        "firstRelease": FIRST_SHA,
                    }
                ],
            }
        )
        with self.assertRaises(LEDGER.UrlExposureError) as captured:
            LEDGER.parse_exposure_ledger(reserved_ledger)
        self.assertEqual(captured.exception.code, "DEPLOY_LEDGER_EDGE")

        allowed = release(
            FIRST_SHA,
            ("/", "/asset/", "/assets-old/", "/images/"),
        )
        self.assertEqual(
            allowed.published_routes,
            ("/", "/asset/", "/assets-old/", "/images/"),
        )


if __name__ == "__main__":
    unittest.main()

"""以独立构造的规范账本验证只追加边界，不依赖 merge 生成反例。"""

import dataclasses
import unittest

from test_url_exposure_ledger import FIRST_SHA, SECOND_SHA, LEDGER


class LedgerAppendOnlyTests(unittest.TestCase):
    def setUp(self):
        self.before = LEDGER.ExposureLedger(
            published_routes=(
                LEDGER.PublishedRoute("/", FIRST_SHA),
                LEDGER.PublishedRoute("/a/", FIRST_SHA),
                LEDGER.PublishedRoute("/unused/", FIRST_SHA),
            ),
            redirect_edges=(
                LEDGER.RedirectEdge("registered", "/old", "/a/", FIRST_SHA),
                LEDGER.RedirectEdge("registered", "/old/", "/a/", FIRST_SHA),
            ),
        )

    def assert_rejected(self, after):
        # 反例均能独立通过 schema/规范字节校验，只有历史比较才能拒绝。
        parsed = LEDGER.parse_exposure_ledger(LEDGER.serialize_exposure_ledger(after))
        with self.assertRaises(LEDGER.UrlExposureError) as captured:
            LEDGER.assert_ledger_append_only(self.before, parsed)
        self.assertEqual(captured.exception.code, "DEPLOY_LEDGER_NON_APPEND")

    def test_same_facts_and_additions_pass(self):
        self.assertTrue(LEDGER.assert_ledger_append_only(self.before, self.before))
        after = dataclasses.replace(
            self.before,
            published_routes=self.before.published_routes + (
                LEDGER.PublishedRoute("/z/", SECOND_SHA),
            ),
            redirect_edges=self.before.redirect_edges + (
                LEDGER.RedirectEdge("registered", "/previous", "/z/", SECOND_SHA),
            ),
        )
        self.assertTrue(LEDGER.assert_ledger_append_only(self.before, after))

    def test_route_deletion_fails_even_without_an_edge(self):
        self.assert_rejected(dataclasses.replace(
            self.before, published_routes=self.before.published_routes[:-1],
        ))

    def test_each_historical_edge_is_required(self):
        for index in range(len(self.before.redirect_edges)):
            with self.subTest(index=index):
                self.assert_rejected(dataclasses.replace(
                    self.before,
                    redirect_edges=tuple(
                        edge for offset, edge in enumerate(self.before.redirect_edges)
                        if offset != index
                    ),
                ))

    def test_first_release_cannot_be_rewritten(self):
        for field in ("published_routes", "redirect_edges"):
            entries = getattr(self.before, field)
            for index in range(len(entries)):
                with self.subTest(field=field, index=index):
                    changed = tuple(
                        dataclasses.replace(entry, first_release=SECOND_SHA)
                        if offset == index else entry
                        for offset, entry in enumerate(entries)
                    )
                    self.assert_rejected(dataclasses.replace(self.before, **{field: changed}))

    def test_retargeting_cannot_replace_old_edge(self):
        changed = tuple(
            dataclasses.replace(edge, target="/unused/")
            for edge in self.before.redirect_edges
        )
        self.assert_rejected(dataclasses.replace(self.before, redirect_edges=changed))

    def test_empty_replacement_fails(self):
        self.assert_rejected(LEDGER.empty_exposure_ledger())


if __name__ == "__main__":
    unittest.main()

"""生产证据的当前轮绑定、漂移及公网失败保留；认证 transport 另行验收。"""

import copy
import unittest
from datetime import datetime, timezone
from unittest.mock import Mock

from ops.monitor.bound_probe import run_bound_sample
from ops.monitor.public_health import sample
from test_public_health import Fixture, NOW


class BoundProbeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()
        self.snapshot = {"schema": 1, "identity": self.fixture.baseline["identity"],
                         "ledgerSha256": self.fixture.baseline["ledgerSha256"],
                         "ledgerHistorySha256": "a" * 64, "ledgerHistoryEntries": 2,
                         "publishedRoutes": self.fixture.pages, "redirectEdges": [{"from": "/projects", "to": "/projects/"}]}
        self.challenges = []
        self.transform = lambda _index, value: value
        self.probe = Mock(side_effect=lambda baseline, **options: sample(baseline, self.fixture, now=NOW, **options))

    def read(self, challenge):
        self.challenges.append(challenge)
        value = {"schema": 1, "challenge": challenge,
                 "observedAtUtc": datetime.fromtimestamp(NOW, timezone.utc).isoformat(),
                 "snapshot": copy.deepcopy(self.snapshot)}
        return self.transform(len(self.challenges), value)

    def run_probe(self, **options):
        return run_bound_sample(self.fixture.baseline, self.read, probe=self.probe, now=lambda: NOW, **options)

    def test_before_and_after_fresh_evidence_bind_the_real_public_probe(self):
        result = self.run_probe(internal_links=True)
        self.assertEqual(result["status"], "passed")
        self.assertTrue(result["serverLedgerInspected"])
        self.assertEqual(len(self.challenges), 2)
        self.assertNotEqual(*self.challenges)
        self.assertNotEqual(result["serverEvidenceBeforeSha256"], result["serverEvidenceAfterSha256"])
        self.probe.assert_called_once_with(self.fixture.baseline, internal_links=True)

    def test_replayed_nonce_and_stale_or_future_timestamp_block_network(self):
        for field, value, code in (("challenge", "f" * 64, "MONITOR_CHALLENGE"),
                                   ("observedAtUtc", "2000-01-01T00:00:00Z", "MONITOR_EVIDENCE_STALE"),
                                   ("observedAtUtc", "2100-01-01T00:00:00Z", "MONITOR_EVIDENCE_STALE"),
                                   ("observedAtUtc", "2026-11-11T00:00:00", "MONITOR_EVIDENCE_TIME")):
            with self.subTest(field=field, code=code):
                self.transform = lambda _index, item: {**item, field: value}
                result = self.run_probe()
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["checks"][0]["code"], code)
                self.probe.assert_not_called()

    def test_identity_and_ledger_disagree_before_probe(self):
        for field, value, code in (("identity", {}, "MONITOR_BASELINE_IDENTITY"),
                                   ("ledgerSha256", "f" * 64, "MONITOR_BASELINE_LEDGER")):
            with self.subTest(field=field):
                old = self.snapshot[field]
                self.snapshot[field] = value
                result = self.run_probe()
                self.snapshot[field] = old
                self.assertEqual(result["checks"][0]["code"], code)
                self.probe.assert_not_called()

    def test_post_probe_history_drift_is_not_hidden_by_green_public_checks(self):
        def transform(index, item):
            if index == 2:
                item["snapshot"]["ledgerHistorySha256"] = "f" * 64
            return item
        self.transform = transform
        result = self.run_probe()
        self.assertFalse(result["serverLedgerInspected"])
        self.assertEqual(result["checks"][-1]["code"], "MONITOR_SNAPSHOT_DRIFT")
        self.assertEqual(result["failedCount"], 1)

    def test_bad_public_payload_is_retained_and_endpoint_evidence_is_still_read(self):
        self.fixture.bodies["/"] = b"changed"
        result = self.run_probe()
        self.assertEqual(len(self.challenges), 2)
        self.assertTrue(result["serverLedgerInspected"])
        self.assertEqual(result["status"], "failed")
        self.assertIn("HEALTH_PAYLOAD_IDENTITY", [c.get("code") for c in result["checks"]])

    def test_unresolved_historical_routes_or_divergent_edges_fail(self):
        for field, value, code in (("publishedRoutes", ["/missing/"], "MONITOR_ROUTE_UNRESOLVED"),
                                   ("redirectEdges", [{"from": "/projects/", "to": "/writing/"}], "MONITOR_EDGE_DIVERGED"),
                                   ("redirectEdges", self.snapshot["redirectEdges"] * 2, "MONITOR_EDGES")):
            with self.subTest(field=field, code=code):
                old = self.snapshot[field]
                self.snapshot[field] = value
                result = self.run_probe()
                self.snapshot[field] = old
                self.assertEqual(result["checks"][0]["code"], code)
                self.probe.assert_not_called()

    def test_reader_transport_error_is_redacted_and_never_falls_back_to_baseline(self):
        reader = Mock(side_effect=RuntimeError("private credentials in error"))
        result = run_bound_sample(self.fixture.baseline, reader, probe=self.probe)
        self.assertEqual(result["checks"][0]["code"], "MONITOR_EVIDENCE_FAILED")
        self.assertNotIn("private", str(result))
        self.probe.assert_not_called()

    def test_current_canonical_page_missing_from_exposure_ledger_fails(self):
        self.snapshot["publishedRoutes"] = ["/"]
        result = self.run_probe()
        self.assertEqual(result["checks"][0]["code"], "MONITOR_ROUTE_UNEXPOSED")
        self.probe.assert_not_called()

    def test_malformed_probe_result_fails_and_still_reads_endpoint_evidence(self):
        self.probe.side_effect = None
        self.probe.return_value = {"identity": self.fixture.baseline["identity"], "baselineSha256": "f" * 64,
                                   "serverLedgerInspected": False}
        result = self.run_probe()
        self.assertEqual(result["status"], "failed")
        self.assertIn("MONITOR_PROBE_IDENTITY", [c.get("code") for c in result["checks"]])
        self.assertEqual(len(self.challenges), 2)

    def test_mismatching_probe_counts_cannot_manufacture_a_pass(self):
        self.probe.side_effect = lambda baseline: {**sample(baseline, self.fixture, now=NOW), "failedCount": 1}
        result = self.run_probe()
        self.assertEqual(result["status"], "failed")
        self.assertIn("MONITOR_PROBE_RESULT", [c.get("code") for c in result["checks"]])

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

    def test_subsecond_server_clock_lead_does_not_reject_current_evidence(self):
        self.transform = lambda _index, item: {
            **item, "observedAtUtc": datetime.fromtimestamp(NOW + 0.5, timezone.utc).isoformat()}
        result = self.run_probe()
        self.assertEqual(result["status"], "passed")
        self.assertTrue(result["serverLedgerInspected"])
        self.assertEqual(len(self.challenges), 2)

    def test_clock_skew_and_age_boundaries_do_not_extend_old_evidence_lifetime(self):
        for offset, passed in ((-120, True), (-120.001, False), (-119.999, True),
                               (0, True), (4.999, True), (5, True), (5.001, False)):
            with self.subTest(offset=offset):
                self.transform = lambda _index, item: {
                    **item, "observedAtUtc": datetime.fromtimestamp(NOW + offset, timezone.utc).isoformat()}
                result = run_bound_sample(self.fixture.baseline, self.read, probe=self.probe,
                                          now=lambda: NOW, monotonic=lambda: 10)
                self.assertEqual(result["status"], "passed" if passed else "failed")
                if not passed:
                    self.assertEqual(result["checks"][0]["code"], "MONITOR_EVIDENCE_STALE")
                    self.probe.assert_not_called()
                self.probe.reset_mock()

    def test_read_timeout_cannot_be_hidden_by_a_fresh_remote_timestamp(self):
        for elapsed in (120, 120.001, -1, float("nan"), float("inf")):
            with self.subTest(elapsed=elapsed):
                self.transform = lambda _index, item: {
                    **item, "observedAtUtc": datetime.fromtimestamp(NOW + 120, timezone.utc).isoformat()}
                self.probe.reset_mock()
                # 两轮读取各自受 120 秒单调时限约束；固定当前 UTC 防止对端重打时间戳绕过。
                ticks = Mock(side_effect=[0, elapsed, 0, elapsed])
                walls = Mock(side_effect=[NOW, NOW + 120, NOW, NOW + 120])
                result = run_bound_sample(self.fixture.baseline, self.read, probe=self.probe,
                                          now=walls, monotonic=ticks)
                if elapsed == 120:
                    self.assertEqual(result["status"], "passed")
                else:
                    self.assertEqual(result["checks"][0]["code"], "MONITOR_EVIDENCE_TIMEOUT")
                    self.probe.assert_not_called()

    def test_wall_clock_steps_cannot_hide_elapsed_time_or_create_fresh_evidence(self):
        for step in (-6, 6, float("nan"), float("inf")):
            with self.subTest(step=step):
                self.probe.reset_mock()
                result = run_bound_sample(self.fixture.baseline, self.read, probe=self.probe,
                                          now=Mock(side_effect=[NOW, NOW + 1 + step]),
                                          monotonic=Mock(side_effect=[0, 1]))
                self.assertEqual(result["checks"][0]["code"], "MONITOR_CLOCK_DRIFT")
                self.probe.assert_not_called()

    def test_small_local_clock_step_does_not_rebase_remote_age(self):
        self.transform = lambda _index, item: {
            **item, "observedAtUtc": datetime.fromtimestamp(NOW - 120, timezone.utc).isoformat()}
        result = run_bound_sample(self.fixture.baseline, self.read, probe=self.probe,
                                  now=Mock(side_effect=[NOW, NOW - 4]),
                                  monotonic=Mock(side_effect=[0, 1]))
        self.assertEqual(result["checks"][0]["code"], "MONITOR_EVIDENCE_STALE")
        self.probe.assert_not_called()

    def test_endpoint_clock_error_is_retained_after_successful_public_checks(self):
        def transform(index, item):
            if index == 2:
                item["observedAtUtc"] = datetime.fromtimestamp(NOW + 5.001, timezone.utc).isoformat()
            return item
        self.transform = transform
        result = run_bound_sample(self.fixture.baseline, self.read, probe=self.probe,
                                  now=lambda: NOW, monotonic=lambda: 10)
        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["serverLedgerInspected"])
        self.assertEqual(result["checks"][-1]["check"], "server-evidence:after")
        self.assertEqual(result["checks"][-1]["code"], "MONITOR_EVIDENCE_STALE")
        self.probe.assert_called_once()

    def test_clock_tolerance_does_not_allow_replayed_challenge(self):
        self.transform = lambda _index, item: {
            **item, "challenge": "f" * 64,
            "observedAtUtc": datetime.fromtimestamp(NOW + 0.5, timezone.utc).isoformat()}
        result = self.run_probe()
        self.assertEqual(result["checks"][0]["code"], "MONITOR_CHALLENGE")
        self.probe.assert_not_called()

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

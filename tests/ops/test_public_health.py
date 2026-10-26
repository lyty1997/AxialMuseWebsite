"""独立公网 fixture：身份、TLS、重定向、SEO 和观察时间边界必须可变红。"""

import copy
import json
import os
import ssl
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from ops.monitor.public_health import (
    HOSTS, ORIGIN, QUERY, SECURITY, HealthError, address_digest, check_robots,
    digest, main, observation_result, observe, private_json, sample, validate_baseline, write_receipt,
)


NOW = 1800000000
ROBOTS = ("User-agent: *\nAllow: /\nSitemap: " + ORIGIN + "/sitemap.xml\n").encode()


class Fixture:
    def __init__(self):
        self.pages = ["/", "/projects/", "/writing/"]
        self.bodies = {path: (
            '<!doctype html><html><head><link rel="canonical" href="' + ORIGIN + path
            + '"></head><body><a href="https://beian.miit.gov.cn/">沪ICP备2026029086号</a></body></html>'
        ).encode() for path in self.pages}
        self.bodies["/sitemap.xml"] = ('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                                      + ''.join('<url><loc>' + ORIGIN + path + '</loc></url>' for path in self.pages)
                                      + '</urlset>').encode()
        self.bodies["/robots.txt"] = ROBOTS
        self.baseline = {
            "schema": 1, "identity": {"workflow_run_id": "123", "artifact_id": "456", "commit_sha": "a" * 40,
                                     "artifact_digest": "b" * 64, "release_content_sha256": "c" * 64},
            "files": {path: digest(body) for path, body in self.bodies.items()}, "pages": self.pages,
            "rules": {"/projects": "/projects/"}, "csp": "default-src 'none'; script-src 'self'",
            "hsts": None, "addressDigest": address_digest(["192.0.2.10"]),
            "ledgerSha256": "d" * 64, "minimumCertificateDays": 21,
        }
        self.certificate = {"subjectAltName": tuple(("DNS", h) for h in HOSTS),
                            "notAfter": ssl.cert_time_to_seconds.__name__}
        self.expiry(90)
        self.transform = lambda secure, host, path, result: result

    def expiry(self, days):
        self.certificate["notAfter"] = datetime.fromtimestamp(NOW + days * 86400, timezone.utc).strftime(
            "%b %d %H:%M:%S %Y GMT")

    def addresses(self, _host):
        return {"192.0.2.10"}

    def request(self, secure, host, path, host_header=None):
        headers = list({**SECURITY, "Content-Security-Policy": self.baseline["csp"]}.items())
        if secure and self.baseline["hsts"]:
            headers.append(("Strict-Transport-Security", self.baseline["hsts"]))
        clean = path.split("?", 1)[0]
        suffix = "?" + path.split("?", 1)[1] if "?" in path else ""
        body = self.bodies.get(clean, b"missing")
        if host_header == "unknown.invalid":
            status = 421
        elif clean in self.baseline["rules"] or not secure or host == HOSTS[0]:
            status = 301
            headers.append(("Location", ORIGIN + self.baseline["rules"].get(clean, clean) + suffix))
        else:
            status = 200 if clean in self.bodies else 404
        if clean == "/robots.txt":
            headers.append(("Content-Type", "text/plain"))
        result = status, headers, body, self.certificate if secure else None
        return self.transform(secure, host, path, result)


class PublicHealthTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()

    def run_sample(self):
        return sample(self.fixture.baseline, self.fixture, now=NOW)

    def assert_code(self, receipt, code):
        self.assertEqual(receipt["status"], "failed")
        self.assertIn(code, [c.get("code") for c in receipt["checks"]])

    def test_complete_fixture_and_query_preservation(self):
        result = self.run_sample()
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["payloadHashesPassed"], 5)
        self.assertEqual(result["certificateDaysRemaining"], 90)
        self.assertFalse(result["serverLedgerInspected"])

    def test_trial_policy_accepts_exact_300_and_detects_legacy_duration(self):
        self.fixture.baseline["hsts"] = "max-age=300"
        self.assertEqual(self.run_sample()["status"], "passed")
        def legacy(secure, host, path, result):
            status, headers, body, certificate = result
            headers = [(k, "max-age=15552000" if k == "Strict-Transport-Security" else v)
                       for k, v in headers]
            return status, headers, body, certificate
        self.fixture.transform = legacy
        self.assert_code(self.run_sample(), "HEALTH_HSTS")

    def test_payload_byte_change_is_identity_failure(self):
        self.fixture.bodies["/"] += b"modified"
        self.assert_code(self.run_sample(), "HEALTH_PAYLOAD_IDENTITY")

    def test_wrong_dns_target_is_redacted(self):
        self.fixture.addresses = lambda _host: {"192.0.2.99"}
        result = self.run_sample()
        self.assert_code(result, "HEALTH_DNS_TARGET")
        self.assertNotIn("192.0.2.99", json.dumps(result))

    def test_near_expiry_and_wrong_names_fail(self):
        self.fixture.expiry(20)
        self.assert_code(self.run_sample(), "HEALTH_CERTIFICATE_EXPIRY")
        self.fixture.expiry(90)
        self.fixture.certificate["subjectAltName"] = (("DNS", "outside.invalid"),)
        self.assert_code(self.run_sample(), "HEALTH_CERTIFICATE_NAMES")

    def test_missing_robots_cannot_be_hidden_by_existing_artifact(self):
        del self.fixture.bodies["/robots.txt"]
        del self.fixture.baseline["files"]["/robots.txt"]
        self.assert_code(self.run_sample(), "HEALTH_ROBOTS_MISSING")

    def test_noindex_canonical_and_icp_fail_with_updated_byte_baseline(self):
        original = self.fixture.bodies["/"]
        for changed, code in (
            (original.replace(b'</head>', b'<meta name="robots" content="noindex"></head>'), "HEALTH_NOINDEX"),
            (original.replace(ORIGIN.encode(), b'https://outside.invalid'), "HEALTH_CANONICAL"),
            (original.replace('沪ICP备2026029086号'.encode(), b'unknown'), "HEALTH_ICP"),
        ):
            self.fixture.bodies["/"] = changed
            self.fixture.baseline["files"]["/"] = digest(changed)
            self.assert_code(self.run_sample(), code)

    def test_redirect_wrong_target_duplicate_location_and_lost_query(self):
        for locations in ([('Location', 'https://outside.invalid/')],
                          [('Location', ORIGIN + '/projects/' + QUERY)] * 2,
                          [('Location', ORIGIN + '/projects/')]):
            def mutate(secure, host, path, result):
                status, headers, body, certificate = result
                if path.startswith('/projects?'):
                    headers = [(k, v) for k, v in headers if k.lower() != 'location'] + locations
                return status, headers, body, certificate
            self.fixture.transform = mutate
            self.assert_code(self.run_sample(), "HEALTH_REDIRECT")

    def test_removed_headers_unexpected_hsts_cookie_and_server_error(self):
        mutations = (
            (lambda h: [(k, v) for k, v in h if k != 'Content-Security-Policy'], "HEALTH_HEADERS"),
            (lambda h: h + [('Strict-Transport-Security', 'max-age=300')], "HEALTH_HSTS"),
            (lambda h: h + [('Set-Cookie', 'sensitive=must-not-appear')], "HEALTH_COOKIE"),
        )
        for change, code in mutations:
            self.fixture.transform = lambda secure, host, path, r: (r[0], change(r[1]), r[2], r[3])
            result = self.run_sample()
            self.assert_code(result, code)
            self.assertNotIn('sensitive', json.dumps(result))
        self.fixture.transform = lambda secure, host, path, r: (500, r[1], r[2], r[3])
        self.assert_code(self.run_sample(), "HEALTH_PAYLOAD_STATUS")

    def test_network_failure_does_not_print_exception_values_or_pass(self):
        def broken(*args):
            raise OSError("private-address-or-credential")
        self.fixture.request = broken
        result = self.run_sample()
        self.assert_code(result, "HEALTH_CHECK_FAILED")
        self.assertNotIn("private-address-or-credential", json.dumps(result))

    def test_sitemap_extra_url_is_rejected_even_with_updated_hash(self):
        self.fixture.bodies['/sitemap.xml'] = self.fixture.bodies['/sitemap.xml'].replace(
            b'</urlset>', b'<url><loc>https://outside.invalid/</loc></url></urlset>')
        self.fixture.baseline['files']['/sitemap.xml'] = digest(self.fixture.bodies['/sitemap.xml'])
        self.assert_code(self.run_sample(), 'HEALTH_SITEMAP')

    def test_robots_deny_and_missing_declaration_fail(self):
        check_robots(ROBOTS)
        for body in (b'User-agent: *\nDisallow: /\n', b'', b'<html>not robots</html>'):
            with self.assertRaises(HealthError):
                check_robots(body)

    def test_baseline_policy_cannot_weaken_or_change_target(self):
        for key, value in (('minimumCertificateDays', 0), ('files', {'/../secret': 'a' * 64}),
                           ('hsts', 'max-age=300; includeSubDomains'), ('csp', "default-src *")):
            baseline = copy.deepcopy(self.fixture.baseline)
            baseline[key] = value
            with self.assertRaises(HealthError):
                validate_baseline(baseline)

    def test_private_input_duplicate_key_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'baseline.json'
            write_receipt(path, self.fixture.baseline)
            self.assertEqual(private_json(path), self.fixture.baseline)
            with self.assertRaises(FileExistsError):
                write_receipt(path, {})
            os.chmod(path, 0o644)
            with self.assertRaisesRegex(HealthError, 'HEALTH_INPUT_MODE'):
                private_json(path)
            os.chmod(path, 0o600)
            path.write_bytes(b'{"schema":1,"schema":1}')
            with self.assertRaisesRegex(HealthError, 'HEALTH_DUPLICATE_KEY'):
                private_json(path)

    def test_cli_returns_nonzero_for_real_check_failure(self):
        with tempfile.TemporaryDirectory() as root:
            baseline = Path(root) / 'baseline.json'
            output = Path(root) / 'result.json'
            write_receipt(baseline, self.fixture.baseline)
            failed = self.run_sample()
            failed['status'] = 'failed'
            failed['failedCount'] = 1
            with patch('ops.monitor.public_health.sample', return_value=failed):
                self.assertEqual(main(['--baseline', str(baseline), '--output', str(output)]), 1)
            self.assertEqual(private_json(output)['status'], 'failed')

    def test_registered_real_robots_matches_public_policy(self):
        root = Path(__file__).resolve().parents[2]
        registry = json.loads((root / 'docs/contracts/static-public-assets.json').read_text())
        self.assertIn({'sourcePath': 'robots.txt', 'role': 'operational'}, registry['assets'])
        check_robots((root / 'static-public/robots.txt').read_bytes())


class ObservationTests(unittest.TestCase):
    def receipts(self, count=97):
        start = datetime(2026, 10, 26, tzinfo=timezone.utc)
        return [{'observedAtUtc': (start + timedelta(seconds=i * 900)).isoformat(),
                 'baselineSha256': 'a' * 64, 'status': 'passed'} for i in range(count)]

    def test_single_or_short_observation_is_running_not_passed(self):
        for count in (1, 2, 96):
            self.assertEqual(observation_result(self.receipts(count))['status'], 'running')

    def test_24_hours_passes_only_with_all_success_and_no_gaps(self):
        self.assertEqual(observation_result(self.receipts())['status'], 'passed')
        for kind in ('failure', 'gap', 'drift'):
            receipts = self.receipts()
            if kind == 'failure':
                receipts[25]['status'] = 'failed'
            elif kind == 'gap':
                del receipts[25]
            else:
                receipts[25]['baselineSha256'] = 'b' * 64
            self.assertEqual(observation_result(receipts)['status'], 'failed')

    def test_non_increasing_or_empty_evidence_fails(self):
        for receipts in ([], self.receipts(2)[::-1], self.receipts(1) * 2):
            with self.assertRaises(HealthError):
                observation_result(receipts)

    def test_sampler_keeps_failed_samples_and_runs_until_actual_duration(self):
        clock = [0]
        def sleep(seconds):
            clock[0] += seconds
        def snapshot(_baseline):
            return {'observedAtUtc': datetime.fromtimestamp(NOW + clock[0], timezone.utc).isoformat(),
                    'status': 'failed' if clock[0] == 0 else 'passed',
                    'failedCount': 1 if clock[0] == 0 else 0,
                    'baselineSha256': 'a' * 64}
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / 'observation'
            with patch('ops.monitor.public_health.time.monotonic', side_effect=lambda: clock[0]), \
                    patch('ops.monitor.public_health.time.sleep', side_effect=sleep), \
                    patch('ops.monitor.public_health.sample', side_effect=snapshot):
                result = observe(Fixture().baseline, directory, duration=1800, interval=900)
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['samples'], 3)
            self.assertEqual(result['observedSeconds'], 1800)
            self.assertEqual(private_json(directory / 'sample-0001.json')['status'], 'failed')
            self.assertEqual(private_json(directory / 'sample-0003.json')['status'], 'passed')
            self.assertEqual(private_json(directory / 'finished.json'), result)

    def test_sampler_interruption_retains_prior_receipt_and_cannot_finish_passed(self):
        first = {'observedAtUtc': datetime.fromtimestamp(NOW, timezone.utc).isoformat(),
                 'status': 'passed', 'failedCount': 0, 'baselineSha256': 'a' * 64}
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / 'observation'
            with patch('ops.monitor.public_health.time.sleep'), \
                    patch('ops.monitor.public_health.sample', side_effect=[first, OSError('fixture')]), \
                    self.assertRaises(OSError):
                observe(Fixture().baseline, directory)
            self.assertEqual(private_json(directory / 'sample-0001.json'), first)
            self.assertFalse((directory / 'finished.json').exists())
            self.assertFalse(private_json(directory / 'interrupted.json')['continuousObservationPassed'])


if __name__ == '__main__':
    unittest.main()

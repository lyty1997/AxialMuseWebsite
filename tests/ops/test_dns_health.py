"""每周 DNS 的自包含应答与 dig 入口反例，不依赖真实解析服务。"""

import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from ops.monitor import dns_health, public_health
from ops.monitor.dns_health import NAMESERVERS, PARENT, ZONE, Transport, check_dns, parse_response
from ops.monitor.public_health import HOSTS, HealthError, address_digest
from test_public_health import Fixture, NOW


def response(name, kind, *, values=(), zone=ZONE, aa=False):
    return {"flags": {"qr", "aa"} if aa else {"qr", "ra"},
            "answer": [(name, kind, (value,)) for value in values],
            "authority": [] if values else [(zone, "SOA", ("ns.example.", "hostmaster.example.",
                                                         "1", "2", "3", "4", "5"))]}


class FixtureDNS:
    def __init__(self):
        self.transform = lambda _name, _kind, _server, result: result
        self.calls = []

    def query(self, name, kind, server=None):
        self.calls.append((name, kind, server))
        if name == PARENT:
            result = response(name, kind, values=("a.parent.example.", "b.parent.example."))
        elif kind == "NS":
            result = response(name, kind, values=sorted(NAMESERVERS), aa=server in NAMESERVERS)
            if server == "a.parent.example.":
                result["authority"], result["answer"] = result["answer"], []
        else:
            result = response(name, kind, values=("192.0.2.10",) if kind == "A" else (),
                              zone=PARENT if kind == "DS" else ZONE, aa=server is not None)
        return self.transform(name, kind, server, copy.deepcopy(result))


class DNSHealthTests(unittest.TestCase):
    def setUp(self):
        self.fixture = FixtureDNS()
        self.baseline = {"addressDigest": address_digest(["192.0.2.10"])}

    def codes(self):
        return [c["code"] for c in check_dns(self.baseline, self.fixture) if c["status"] == "failed"]

    def test_complete_fixture_covers_every_source_and_type(self):
        self.assertEqual(self.codes(), [])
        for server in (None, *NAMESERVERS):
            self.assertIn((ZONE, "NS", server), self.fixture.calls)
            for host in HOSTS:
                for kind in ("A", "AAAA", "CNAME"):
                    self.assertIn((host + ".", kind, server), self.fixture.calls)
        for server in NAMESERVERS:
            self.assertIn((ZONE, "DNSKEY", server), self.fixture.calls)
        self.assertIn((ZONE, "DS", "a.parent.example."), self.fixture.calls)

    def test_changed_addresses_nameserver_and_unsigned_policy_fail(self):
        cases = (("A", "192.0.2.99", "DNS_ADDRESS"), ("NS", "wrong.example.", "DNS_NAMESERVERS"),
                 ("AAAA", "2001:db8::1", "DNS_UNEXPECTED_AAAA"),
                 ("CNAME", "alias.example.", "DNS_UNEXPECTED_CNAME"),
                 ("DNSKEY", "unapproved-key", "DNS_UNEXPECTED_DNSKEY"),
                 ("DS", "unapproved-ds", "DNS_UNEXPECTED_DS"))
        for kind, value, code in cases:
            with self.subTest(kind=kind):
                self.fixture.transform = lambda name, k, server, result: (
                    response(name, k, values=(value,), aa=server is not None) if k == kind and name != PARENT
                    else result)
                self.assertIn(code, self.codes())

    def test_missing_aa_or_soa_is_never_accepted_as_nodata(self):
        for part, code in (("flags", "DNS_NOT_AUTHORITATIVE"), ("authority", "DNS_NEGATIVE_PROOF")):
            with self.subTest(part=part):
                def transform(_name, kind, server, result):
                    if kind == "AAAA" and server is not None:
                        result[part] = {"qr"} if part == "flags" else []
                    return result
                self.fixture.transform = transform
                self.assertIn(code, self.codes())

    def test_recursive_nodata_without_soa_still_requires_authoritative_proof(self):
        def transform(_name, kind, server, result):
            if kind == "CNAME" and server is None:
                result["authority"] = []
            return result
        self.fixture.transform = transform
        self.assertEqual(self.codes(), [])
        for server in NAMESERVERS:
            self.assertIn((ZONE, "DNSKEY", server), self.fixture.calls)

    def test_parent_stale_ds_and_wrong_zone_soa_fail(self):
        def transform(_name, kind, _server, result):
            if kind == "DS":
                result["authority"][0] = (ZONE, "SOA", result["authority"][0][2])
            return result
        self.fixture.transform = transform
        self.assertIn("DNS_NEGATIVE_PROOF", self.codes())

    def test_recursive_referral_is_not_nodata(self):
        def transform(_name, kind, server, result):
            if kind == "AAAA" and server is None:
                result["authority"] = [(ZONE, "NS", ("another.example.",))]
            return result
        self.fixture.transform = transform
        self.assertIn("DNS_REFERRAL", self.codes())

    def test_malformed_parent_discovery_and_delegation_fail(self):
        for discovery in (True, False):
            with self.subTest(discovery=discovery):
                def transform(name, _kind, server, result):
                    if discovery and name == PARENT:
                        result["answer"] = []
                    if not discovery and server == "a.parent.example.":
                        if result["authority"] and result["authority"][0][1] == "NS":
                            result["authority"].pop()
                    return result
                self.fixture.transform = transform
                self.assertIn("DNS_PARENT_DISCOVERY" if discovery else "DNS_DELEGATION", self.codes())

    def test_one_failed_authority_remains_failed_and_diagnostics_are_redacted(self):
        def transform(_name, _kind, server, result):
            if server == sorted(NAMESERVERS)[0]:
                raise RuntimeError("sensitive-diagnostic-192.0.2.10")
            return result
        self.fixture.transform = transform
        checks = check_dns(self.baseline, self.fixture)
        self.assertTrue(any(c["status"] == "passed" for c in checks))
        self.assertTrue(any(c.get("code") == "DNS_CHECK_FAILED" for c in checks))
        self.assertNotIn("sensitive", json.dumps(checks))
        self.assertNotIn("192.0.2.10", json.dumps(checks))

    def test_weekly_failure_makes_real_public_entry_return_nonzero(self):
        fixture = Fixture()
        failure = [{"check": "dns-weekly:parent:DS", "status": "failed", "code": "DNS_UNEXPECTED_DS"}]
        with tempfile.TemporaryDirectory() as directory:
            baseline, output = Path(directory) / "baseline.json", Path(directory) / "result.json"
            baseline.write_text(json.dumps(fixture.baseline))
            baseline.chmod(0o600)
            with patch.object(public_health, "Transport", return_value=fixture), \
                    patch.object(public_health.time, "time", return_value=NOW), \
                    patch.object(dns_health, "check_dns", return_value=failure):
                self.assertEqual(public_health.main(["--baseline", str(baseline), "--output", str(output),
                                                     "--dns", "--internal-links"]), 1)
            receipt = json.loads(output.read_text())
            self.assertEqual(receipt["dnsPolicy"], "deferred-unsigned")
            self.assertIn(failure[0], receipt["checks"])
            self.assertEqual(receipt["payloadHashesPassed"], len(fixture.bodies))

    def test_dns_cannot_be_silently_ignored_in_observation_mode(self):
        with patch.object(public_health, "private_json") as load:
            self.assertEqual(public_health.main(["--baseline", "unused", "--output", "unused",
                                                 "--observe", "--dns"]), 1)
            load.assert_not_called()

    def test_existing_single_probe_does_not_start_optional_weekly_dns(self):
        fixture = Fixture()
        with patch.object(dns_health, "check_dns") as check:
            receipt = public_health.sample(fixture.baseline, fixture, now=NOW)
        check.assert_not_called()
        self.assertEqual(receipt["status"], "passed")
        self.assertEqual(receipt["dnsPolicy"], "not-inspected")


DIG = """;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 123
;; flags: qr aa; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 0

;; QUESTION SECTION:
;axialmuse.com. IN A

;; ANSWER SECTION:
axialmuse.com. 600 IN A 192.0.2.10
"""


class DigBoundaryTests(unittest.TestCase):
    def test_record_parser_and_whitespace(self):
        result = parse_response(DIG.replace(" IN ", "\tIN\t"), ZONE, "A")
        self.assertEqual(result["answer"], [(ZONE, "A", ("192.0.2.10",))])
        self.assertIn("aa", result["flags"])

    def test_status_question_count_and_truncation_mutations(self):
        for text in (DIG.replace("NOERROR", "SERVFAIL"), DIG.replace("NOERROR", "NXDOMAIN"),
                     DIG.replace("qr aa", "qr aa tc"), DIG.replace("ANSWER: 1", "ANSWER: 2"),
                     DIG.replace(";axialmuse.com.", ";other.example."), DIG + DIG,
                     DIG.replace("600 IN", "broken IN"), DIG.replace(";; QUESTION SECTION:", "")):
            with self.subTest(text=text):
                with self.assertRaises(HealthError):
                    parse_response(text, ZONE, "A")

    def test_nonzero_transport_and_timeout_do_not_become_empty_records(self):
        for error in (subprocess.CompletedProcess([], 9, b"", b"private"),
                      subprocess.TimeoutExpired("dig", 8), FileNotFoundError("private")):
            with self.subTest(error=type(error).__name__):
                with patch.object(dns_health, "run_process") as run:
                    if isinstance(error, Exception):
                        run.side_effect = error
                    else:
                        run.return_value = error
                    with self.assertRaisesRegex(HealthError, "DNS_(TRANSPORT|TIMEOUT)"):
                        Transport().query(ZONE, "A")

    def test_fixed_command_ignores_digrc_and_never_uses_shell(self):
        with patch.object(dns_health, "run_process", return_value=subprocess.CompletedProcess(
                [], 0, DIG.encode(), b"")) as run:
            Transport().query(ZONE, "A", sorted(NAMESERVERS)[0])
        args, kwargs = run.call_args
        self.assertEqual(args[0][0:3], ["/usr/bin/dig", "-r", "-4"])
        for option in ("+tcp", "+tries=1", "+nosearch", "+norecurse", "+nomultiline"):
            self.assertIn(option, args[0])
        self.assertNotIn("shell", kwargs)
        self.assertEqual(kwargs["timeout"], 8)
        self.assertEqual(kwargs["output_limit"], 65536)
        self.assertEqual(kwargs["env"]["LC_ALL"], "C")

    def test_unapproved_query_rejected_before_start(self):
        for name, kind, server in (("-q", "A", None), (ZONE, "AXFR", None), (ZONE, "A", "@bad")):
            with patch.object(dns_health, "run_process") as run:
                with self.assertRaisesRegex(HealthError, "DNS_QUERY"):
                    Transport().query(name, kind, server)
                run.assert_not_called()

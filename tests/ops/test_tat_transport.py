"""固定监测云命令的身份、终态和输出反例；不调用真实云接口。"""

import base64
import copy
import json
import subprocess
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

from ops.monitor.public_health import HealthError
from ops.monitor.bounded_process import ProcessOutputLimit
from ops.monitor.tat_transport import COMMAND, COMMAND_SHA256, TatTransport, authorization, decode_json


def b64(value):
    return base64.b64encode(value).decode()


class TatTransportTests(unittest.TestCase):
    def setUp(self):
        self.command_id, self.instance_id, self.invocation_id = "cmd-abcdefgh", "lhins-abcdefgh", "inv-abcdefgh"
        self.command = {"CommandId": self.command_id, "EnableParameter": False, "CommandType": "SHELL",
                        "Username": "axial-monitor", "Content": b64(COMMAND), "OutputCOSBucketUrl": "",
                        "Timeout": 30, "WorkingDirectory": "/"}
        self.document = {"CommandType": "SHELL", "Username": "axial-monitor", "Content": b64(COMMAND),
                         "OutputCOSBucketUrl": "", "Timeout": 30, "WorkingDirectory": "/"}
        self.task = {"InvocationId": self.invocation_id, "CommandId": self.command_id,
                     "InstanceId": self.instance_id, "TaskStatus": "SUCCESS", "CommandDocument": self.document,
                     "CreatedTime": datetime.now(timezone.utc).isoformat(),
                     "TaskResult": {"ExitCode": 0, "Dropped": 0, "Output": b64(b'{"schema":1}')}}
        self.calls = []

    def invoke(self, action, body, _deadline):
        self.calls.append((action, body))
        if action == "DescribeCommands":
            return {"TotalCount": 1, "CommandSet": [copy.deepcopy(self.command)]}
        if action == "InvokeCommand":
            return {"InvocationId": self.invocation_id}
        return {"TotalCount": 1, "InvocationTaskSet": [copy.deepcopy(self.task)]}

    def transport(self):
        return TatTransport(self.command_id, self.instance_id, COMMAND_SHA256, "fixture-id", "fixture-key",
                            call=self.invoke, sleep=lambda _seconds: None)

    def test_tc3_signature_matches_independent_existing_implementation(self):
        actual = authorization("DescribeCommands", b"{}", "AKIDEXAMPLE00000000",
                               "exampleSecretKey0000000000000000", 1785326400)
        self.assertEqual(actual, "TC3-HMAC-SHA256 Credential=AKIDEXAMPLE00000000/2026-07-29/tat/tc3_request, "
                         "SignedHeaders=content-type;host;x-tc-action, "
                         "Signature=c605dc4cd75d6e61eb9c005366f33c59829c6b9ac055ee2f2dfdadfc43363199")

    def test_exact_command_and_invocation_return_decoded_evidence(self):
        self.assertEqual(self.transport().fetch(), {"schema": 1})
        self.assertEqual([call[0] for call in self.calls],
                         ["DescribeCommands", "InvokeCommand", "DescribeInvocationTasks"])
        self.assertEqual(self.calls[1][1], {"CommandId": self.command_id, "InstanceIds": [self.instance_id]})
        self.assertTrue(self.calls[2][1]["HideOutput"] is False)

    def test_untrusted_command_never_invoked(self):
        for key, value in (("Content", b64(b"modified")), ("EnableParameter", True),
                           ("Username", "root"), ("CommandType", "BAT"),
                           ("Timeout", 61), ("WorkingDirectory", "/tmp"),
                           ("OutputCOSBucketUrl", "https://outside.invalid/")):
            with self.subTest(key=key):
                self.calls.clear()
                old = self.command[key]
                self.command[key] = value
                try:
                    with self.assertRaisesRegex(HealthError, "MONITOR_TAT_COMMAND"):
                        self.transport().fetch()
                    self.assertEqual([call[0] for call in self.calls], ["DescribeCommands"])
                finally:
                    self.command[key] = old

    def test_failed_wrong_identity_truncated_and_mutated_execution_are_rejected(self):
        mutations = (
            ("TaskStatus", "FAILED"), ("InvocationId", "inv-wrongxxx"),
            ("CommandId", "cmd-wrongxxx"), ("InstanceId", "lhins-wrongxxx"),
            ("TaskResult", {"ExitCode": 0, "Dropped": 1, "Output": b64(b'{}')}),
            ("TaskResult", {"ExitCode": 1, "Dropped": 0, "Output": b64(b'{}')}),
            ("TaskResult", {"ExitCode": False, "Dropped": 0, "Output": b64(b'{}')}),
            ("CommandDocument", {**self.document, "Content": b64(b"modified")}),
            ("CommandDocument", {**self.document, "Username": "root"}),
        )
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                old = self.task[key]
                self.task[key] = value
                try:
                    with self.assertRaises(HealthError):
                        self.transport().fetch()
                finally:
                    self.task[key] = old

    def test_duplicate_or_oversize_output_and_unknown_identity_are_rejected(self):
        for output in (b'{"schema":1,"schema":2}', b' ' * (16 * 1024 + 1)):
            self.task["TaskResult"]["Output"] = b64(output)
            with self.assertRaises(HealthError):
                self.transport().fetch()
        with self.assertRaises(HealthError):
            TatTransport(self.command_id, self.instance_id, "f" * 64, "id", "key")
        with self.assertRaises(HealthError):
            decode_json(b'{"duplicate":1,"duplicate":2}')

    def test_old_or_future_invocation_timestamp_cannot_be_replayed(self):
        for offset in (-60, 60):
            with self.subTest(offset=offset):
                self.task["CreatedTime"] = (datetime.now(timezone.utc) + timedelta(seconds=offset)).isoformat()
                with self.assertRaisesRegex(HealthError, "MONITOR_TAT_FRESHNESS"):
                    self.transport().fetch()

    def test_pending_task_is_bounded_by_monotonic_deadline(self):
        self.task["TaskStatus"] = "RUNNING"
        current = [0]
        def sleep(seconds):
            current[0] += seconds
        transport = self.transport()
        transport.clock = lambda: current[0]
        transport.sleep = Mock(side_effect=sleep)
        with self.assertRaisesRegex(HealthError, "MONITOR_TAT_TIMEOUT"):
            transport.fetch()
        self.assertGreater(transport.sleep.call_count, 0)
        self.assertEqual(current[0], 80)

    def test_cloud_worker_keeps_credentials_off_argv_and_environment(self):
        def worker(arguments, **kwargs):
            self.assertNotIn("fixture-id", str(arguments))
            self.assertNotIn("fixture-key", str(arguments))
            self.assertNotIn("fixture-key", str(kwargs["env"]))
            self.assertEqual(json.loads(kwargs["input"])["secretKey"], "fixture-key")
            return subprocess.CompletedProcess(arguments, 0, b'{"response":{"ok":true}}', b"")
        with patch("ops.monitor.tat_transport.run_process", side_effect=worker):
            self.assertEqual(self.transport()._call("DescribeCommands", {}, 100), {"ok": True})

    def test_cloud_worker_timeout_and_output_limit_have_distinct_codes(self):
        for error, code in ((subprocess.TimeoutExpired("fixture", 1), "MONITOR_TAT_TIMEOUT"),
                            (ProcessOutputLimit(), "MONITOR_TAT_RESPONSE_SIZE")):
            with self.subTest(code=code), patch("ops.monitor.tat_transport.run_process", side_effect=error):
                with self.assertRaisesRegex(HealthError, code):
                    self.transport()._call("DescribeCommands", {}, 100)


if __name__ == "__main__":
    unittest.main()

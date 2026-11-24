"""直接运行 workflow 内嵌查询，验证分页、隐私及错误分支，不调用云 API。"""

import copy
import io
import json
import re
import subprocess
import textwrap
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch


WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/tat-read-only.yml"
QUERY = textwrap.dedent(re.search(
    r"          /usr/bin/python3 -B -c '\n(.*?)          '\n",
    WORKFLOW.read_text(), re.DOTALL).group(1))
INSTANCE = "lhins-abcdefgh"


def task(index, status="SUCCESS"):
    return {"InvocationTaskId": f"invt-{index:08d}", "InstanceId": INSTANCE,
            "TaskStatus": status, "CommandDocument": {"Content": "private-command"},
            "TaskResult": {"Output": "private-output"}}


class TatReadOnlyWorkflowTests(unittest.TestCase):
    def test_shell_quoting_and_missing_secrets_fail_before_cloud_access(self):
        command = textwrap.dedent(WORKFLOW.read_text().split("        run: |\n", 1)[1])
        result = subprocess.run(["/bin/bash", "-c", command], capture_output=True, timeout=10,
                                cwd=WORKFLOW.parents[2], env={"PATH": "/usr/bin:/bin"})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"TAT_READ_ONLY_QUERY_FAILED\n")

    def execute(self, pages, *, clock=None, environment=None):
        out, error = io.StringIO(), io.StringIO()
        values = {"TAT_SECRET_ID": "fixture-id", "TAT_SECRET_KEY": "fixture-key",
                  "TAT_INSTANCE_ID": INSTANCE}
        if environment is not None:
            values = environment
        with patch.dict("os.environ", values, clear=True), \
                patch("ops.monitor.tat_transport.request_once", side_effect=pages) as request, \
                patch("time.monotonic", side_effect=clock) if clock is not None else \
                patch("time.monotonic", return_value=0), \
                redirect_stdout(out), redirect_stderr(error):
            try:
                exec(compile(QUERY, str(WORKFLOW), "exec"), {})
                code = 0
            except SystemExit as result:
                code = result.code
        return code, out.getvalue(), error.getvalue(), request.call_args_list

    def assert_failed(self, result):
        code, out, error, _ = result
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertEqual(error, "TAT_READ_ONLY_QUERY_FAILED\n")

    def test_multiple_pages_are_read_only_filtered_and_projected_to_counts(self):
        pages = [{"TotalCount": 21, "InvocationTaskSet": [task(i) for i in range(20)]},
                 {"TotalCount": 21, "InvocationTaskSet": [task(20, "RUNNING")]}]
        code, out, error, calls = self.execute(pages)
        self.assertEqual((code, error), (0, ""))
        self.assertEqual(json.loads(out), {"status": "queried", "visibleTaskCount": 21,
                                         "states": {"SUCCESS": 20, "RUNNING": 1}})
        for index, call in enumerate(calls):
            self.assertEqual(call.args[:3], ("DescribeInvocationTasks", {
                "Filters": [{"Name": "instance-id", "Values": [INSTANCE]}],
                "HideOutput": True, "Limit": 20, "Offset": index * 20}, "ap-shanghai"))
        for private in (INSTANCE, "invt-", "private-command", "private-output", "fixture-id", "fixture-key"):
            self.assertNotIn(private, out + error)

    def test_empty_visible_inventory_is_queried_without_claiming_recovery(self):
        code, out, error, calls = self.execute([{"TotalCount": 0, "InvocationTaskSet": []}])
        self.assertEqual((code, error, len(calls)), (0, "", 1))
        self.assertEqual(json.loads(out), {"status": "queried", "visibleTaskCount": 0, "states": {}})

    def test_drift_repeated_tasks_and_empty_intermediate_page_fail(self):
        first = {"TotalCount": 2, "InvocationTaskSet": [task(0)]}
        for second in ({"TotalCount": 3, "InvocationTaskSet": [task(1)]},
                       {"TotalCount": 2, "InvocationTaskSet": [task(0)]},
                       {"TotalCount": 2, "InvocationTaskSet": []}):
            with self.subTest(second=second):
                self.assert_failed(self.execute([first, second]))

    def test_invalid_results_and_wrong_identity_or_state_fail_without_leaking(self):
        invalid = [None, {}, {"TotalCount": True, "InvocationTaskSet": []},
                   {"TotalCount": -1, "InvocationTaskSet": []},
                   {"TotalCount": 0, "InvocationTaskSet": [task(0)]},
                   {"TotalCount": 1, "InvocationTaskSet": "private-output"},
                   {"TotalCount": 21, "InvocationTaskSet": [task(i) for i in range(21)]}]
        for field, value in (("InstanceId", "lhins-otherone"), ("TaskStatus", "private-output"),
                             ("TaskStatus", []), ("InvocationTaskId", "invalid")):
            changed = {**task(0), field: value}
            invalid.append({"TotalCount": 1, "InvocationTaskSet": [changed]})
        invalid.extend([{"TotalCount": 1, "InvocationTaskSet": [None]},
                        {"TotalCount": 2, "InvocationTaskSet": [task(0), task(0)]}])
        for value in invalid:
            with self.subTest(value=value):
                self.assert_failed(self.execute([copy.deepcopy(value)]))

    def test_timeout_before_or_after_request_fails(self):
        for clock, calls in (([0, 240], 0), ([0, 0, 240], 1)):
            result = self.execute([{"TotalCount": 0, "InvocationTaskSet": []}], clock=clock)
            self.assert_failed(result)
            self.assertEqual(len(result[3]), calls)

    def test_missing_configuration_and_api_errors_do_not_leak(self):
        result = self.execute([], environment={})
        self.assert_failed(result)
        self.assertEqual(len(result[3]), 0)
        result = self.execute([RuntimeError("private-output fixture-key")])
        self.assert_failed(result)

    def test_documented_timeout_and_cancel_states_are_counted(self):
        states = ("PENDING", "DELIVERING", "DELIVER_DELAYED", "DELIVER_FAILED", "START_FAILED",
                  "RUNNING", "SUCCESS", "FAILED", "TIMEOUT", "TASK_TIMEOUT", "CANCELLING",
                  "CANCELLED", "TERMINATED")
        code, out, error, _ = self.execute([{"TotalCount": len(states),
            "InvocationTaskSet": [task(i, state) for i, state in enumerate(states)]}])
        self.assertEqual((code, error), (0, ""))
        self.assertEqual(json.loads(out)["states"], dict.fromkeys(states, 1))


if __name__ == "__main__":
    unittest.main()

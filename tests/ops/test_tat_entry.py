import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

from ops.deploy import tat_entry


ROOT = pathlib.Path(__file__).resolve().parents[2]
TEMPLATE = (ROOT / "ops/deploy/tat-command.sh").read_bytes()
VALUES = {
    "workflowRunId": "39250991872",
    "artifactId": "12185473878",
    "commitSha": "a" * 40,
    "artifactDigest": "b" * 64,
    "releaseContentSha256": "c" * 64,
}


def substitute(values):
    result = TEMPLATE
    for name, value in values.items():
        result = result.replace(
            ("{{" + name + "}}").encode("ascii"),
            value.encode("utf-8"),
        )
    return result


class TatEntryTests(unittest.TestCase):
    def test_exact_template_accepts_only_five_bounded_fields(self):
        self.assertEqual(tat_entry.parse_command_data(substitute(VALUES)), VALUES)
        self.assertEqual(TEMPLATE[:len(tat_entry.PREFIX)], tat_entry.PREFIX)
        self.assertTrue(TEMPLATE.endswith(tat_entry.SUFFIX))

    def test_injected_or_malformed_fields_fail_before_deploy(self):
        for field, value in (
            ("workflowRunId", "0"),
            ("workflowRunId", "01"),
            ("workflowRunId", "9007199254740992"),
            ("artifactId", "1\ncommand=bad"),
            ("commitSha", "A" * 40),
            ("artifactDigest", "b" * 63),
            ("artifactDigest", "b" * 64 + "' ; bad"),
            ("releaseContentSha256", "$(bad)"),
        ):
            with self.subTest(field=field, value=value[:20]):
                candidate = substitute({**VALUES, field: value})
                with self.assertRaises(tat_entry.TatEntryError):
                    tat_entry.parse_command_data(candidate)
        for candidate in (
            substitute(VALUES).replace(b"exit 127\n", b""),
            substitute(VALUES).replace(b"# AXIALMUSE-TAT-END\n", b""),
            substitute(VALUES) + b"extra\n",
            substitute(VALUES).replace(b"artifactId=", b"artifactID="),
        ):
            with self.assertRaises(tat_entry.TatEntryError):
                tat_entry.parse_command_data(candidate)

    def test_shell_never_interprets_parameter_tail_even_with_newline_injection(self):
        with tempfile.TemporaryDirectory(prefix="axial-tat-tail-") as temporary:
            root = pathlib.Path(temporary)
            sentinel = root / "injected"
            stub = root / "entry.py"
            stub.write_text("import os\nprint('fixed-entry')\nprint(len(os.read(3, 4096)))\n")
            script = root / "tat-command.sh"
            candidate = substitute({
                **VALUES,
                "workflowRunId": (
                    "1\n"
                    + "echo injected > " + str(sentinel) + "\n"
                ),
            })
            candidate = candidate.replace(
                b"/usr/local/lib/axialmuse/tat-entry.py",
                str(stub).encode("ascii"),
                1,
            )
            script.write_bytes(candidate)
            result = subprocess.run(
                ["/bin/sh", str(script)],
                capture_output=True,
                check=False,
                timeout=5,
            )
            self.assertEqual(result.returncode, 0)
            self.assertTrue(result.stdout.startswith(b"fixed-entry\n"))
            self.assertFalse(sentinel.exists())

    def test_root_entry_executes_only_fixed_program_with_exact_fields(self):
        with (
            mock.patch.object(tat_entry.os, "geteuid", return_value=0),
            mock.patch.object(tat_entry, "read_command_fd", return_value=substitute(VALUES)),
            mock.patch.object(tat_entry.os, "execve", side_effect=OSError) as execute,
            mock.patch.object(tat_entry.sys, "argv", ["tat_entry.py"]),
            mock.patch.object(tat_entry.sys, "stderr"),
        ):
            self.assertEqual(tat_entry.main(), 1)
        program, arguments, environment = execute.call_args.args
        self.assertEqual(program, "/usr/local/sbin/axialmuse-deploy")
        self.assertEqual(arguments, [
            program,
            "--workflow-run-id", VALUES["workflowRunId"],
            "--artifact-id", VALUES["artifactId"],
            "--commit-sha", VALUES["commitSha"],
            "--artifact-digest", VALUES["artifactDigest"],
            "--release-content-sha256", VALUES["releaseContentSha256"],
        ])
        self.assertEqual(set(environment), {"HOME", "LANG", "LC_ALL", "PATH", "TZ"})


if __name__ == "__main__":
    unittest.main()

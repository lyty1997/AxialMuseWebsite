"""固定退役入口的真实磁盘组合链；不访问生产目录或 Nginx。"""

import contextlib
import io
import os
import stat
import tempfile
import unittest
from unittest.mock import Mock, patch

from ops.deploy import release_commands, retirement_commands
from ops.deploy.deployment_state import DeploymentError, canonical, decode, write_new
from test_artifact_verifier import default_rules
from test_release_transaction import ReleaseFixture


class RetirementArgumentsTests(unittest.TestCase):
    def test_only_fixed_actions_full_sha_and_authorization_id_are_accepted(self):
        sha, authorization = "a" * 40, "d" * 32
        for arguments in (["--initialize"],
                          ["--plan", sha, "--authorization-id", authorization],
                          ["--execute", sha, "--authorization-id", authorization]):
            with self.subTest(arguments=arguments):
                retirement_commands.parse_retirement(arguments)
        for arguments in ([], ["--initialize", "--force"],
                          ["--delete", sha, "--authorization-id", authorization],
                          ["--plan", sha[:7], "--authorization-id", authorization],
                          ["--plan", "../" + sha, "--authorization-id", authorization],
                          ["--plan", sha, "--path", authorization],
                          ["--execute", sha, "--authorization-id", "../" + authorization],
                          ["--execute", sha, "--authorization-id", "D" * 32],
                          ["--execute", sha, "--authorization-id", authorization[:-1]],
                          ["--plan", sha, "--authorization-id", authorization, "--force"]):
            with self.subTest(arguments=arguments), self.assertRaises(DeploymentError):
                retirement_commands.parse_retirement(arguments)


class RetirementCommandsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="axial-retire-command-")
        self.addCleanup(temporary.cleanup)
        self.fixture = f = ReleaseFixture(temporary.name)
        self.old, self.current = (character * 40 for character in "ab")
        for sha, rules, registered in ((self.old, default_rules()[2:], False),
                                       (self.current, default_rules(), True)):
            stage, identity = f.stage(sha, rules=rules)
            f.approve(identity, registered=registered)
            f.engine.execute(stage=stage, identity=identity)
        self.authorization = "d" * 32
        self.plans = f.state.root / "retirement-plans"
        self.plan_path = self.plans / f"{self.authorization}.json"
        self.outer_held = False

        def references():
            self.assertTrue(self.outer_held, "引用检查必须位于生命周期锁内")
            return {"schema": 1, "protected": [self.current], "evidence": "e" * 64}

        self.probe = Mock(side_effect=references)

    @contextlib.contextmanager
    def lifecycle(self):
        self.assertFalse(self.outer_held, "命令不得重复获取生命周期锁")
        self.outer_held = True
        try:
            yield
        finally:
            self.outer_held = False

    def arguments(self, action, *, sha=None, authorization=None):
        return [action, sha or self.old, "--authorization-id", authorization or self.authorization]

    def invoke(self, arguments):
        with self.lifecycle(), patch.object(retirement_commands, "RetirementReferences", return_value=self.probe):
            return retirement_commands.retire_command(self.fixture.store, arguments)

    def audit(self):
        root = self.fixture.state.root
        return {path.relative_to(root): path.read_bytes() for path in root.rglob("*")
                if path.is_file() and not path.is_relative_to(self.plans)}

    def assert_untouched(self, audit):
        self.assertTrue((self.fixture.store.releases / self.old).is_dir())
        self.assertEqual(self.fixture.store.current(), self.current)
        self.assertEqual(self.fixture.state.available_releases(), {self.old, self.current})
        self.assertEqual(self.audit(), audit)

    def initialize(self):
        return self.invoke(["--initialize"])

    def plan(self):
        self.initialize()
        return self.invoke(self.arguments("--plan"))["plan"]

    def test_initialize_creates_private_state_without_changing_ledger_or_success_history(self):
        before = self.audit()
        self.assertEqual(self.initialize(), {"status": "retirement-enabled", "deletedCount": 0})
        self.assertEqual(stat.S_IMODE(self.plans.stat().st_mode), 0o700)
        self.assertEqual(list(self.plans.iterdir()), [])
        for path, content in before.items():
            self.assertEqual((self.fixture.state.root / path).read_bytes(), content)
        self.assertEqual(self.fixture.state.successful_releases(), {self.old, self.current})
        self.probe.assert_not_called()

    def test_repeated_initialization_is_rejected_without_changing_state(self):
        self.initialize()
        before = self.audit()
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_INITIALIZED"):
            self.initialize()
        self.assert_untouched(before)

    def test_initialization_rejects_nonempty_plan_directory(self):
        self.plans.mkdir(mode=0o700)
        write_new(self.plan_path, b"existing plan\n")
        before = self.audit()
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_LAYOUT"):
            self.initialize()
        self.assertFalse((self.fixture.state.root / "retirement-schema").exists())
        self.assertEqual(self.plan_path.read_bytes(), b"existing plan\n")
        self.assert_untouched(before)

    def test_dry_plan_is_private_canonical_and_preserves_target_and_audit(self):
        self.initialize()
        before = self.audit()
        result = self.invoke(self.arguments("--plan"))
        self.assertEqual(result["status"], "planned")
        self.assertEqual(result["deletedCount"], 0)
        self.assertEqual(result["plan"]["sha"], self.old)
        self.assertEqual(result["plan"]["authorizationId"], self.authorization)
        self.assertEqual(self.plan_path.read_bytes(), canonical(result["plan"]))
        self.assertEqual(stat.S_IMODE(self.plan_path.stat().st_mode), 0o600)
        self.assertEqual(self.plan_path.stat().st_nlink, 1)
        self.assert_untouched(before)

    def test_plan_cannot_overwrite_an_existing_authorization(self):
        self.plan()
        original = self.plan_path.read_bytes(), self.plan_path.stat().st_ino
        before = self.audit()
        with self.assertRaises(FileExistsError):
            self.invoke(self.arguments("--plan"))
        self.assertEqual((self.plan_path.read_bytes(), self.plan_path.stat().st_ino), original)
        self.assert_untouched(before)

    def test_execute_reads_saved_plan_and_preserves_historical_audit(self):
        plan = self.plan()
        before = self.audit()
        self.assertEqual(self.invoke(self.arguments("--execute")),
                         {"status": "retired", "sha": self.old, "authorizationId": self.authorization})
        self.assertFalse((self.fixture.store.releases / self.old).exists())
        self.assertEqual(self.fixture.store.current(), self.current)
        self.assertEqual(self.fixture.state.successful_releases(), {self.old, self.current})
        self.assertEqual(self.fixture.state.available_releases(), {self.current})
        for path, content in before.items():
            self.assertEqual((self.fixture.state.root / path).read_bytes(), content)
        record = self.fixture.state.root / "retirements" / f"{self.old}.json"
        self.assertEqual(decode(record.read_bytes()), plan)
        self.assertEqual(self.plan_path.read_bytes(), canonical(plan))

    def test_execute_rejects_cli_sha_or_authorization_that_differs_from_saved_plan(self):
        self.plan()
        alternate = "f" * 32
        write_new(self.plans / f"{alternate}.json", self.plan_path.read_bytes())
        before = self.audit()
        for arguments in (self.arguments("--execute", sha=self.current),
                          self.arguments("--execute", authorization=alternate)):
            with self.subTest(arguments=arguments), \
                    self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_PLAN"):
                self.invoke(arguments)
            self.assert_untouched(before)

    def test_execute_rejects_missing_plan_without_creating_one(self):
        self.initialize()
        before = self.audit()
        with self.assertRaises(FileNotFoundError):
            self.invoke(self.arguments("--execute"))
        self.assertFalse(self.plan_path.exists())
        self.assert_untouched(before)

    def test_execute_rejects_corrupt_or_incomplete_plan_without_retiring_target(self):
        self.plan()
        before = self.audit()
        for content in (b"not json\n", canonical({}), b'{"schema":1,"schema":1}'):
            with self.subTest(content=content):
                self.plan_path.write_bytes(content)
                with self.assertRaises(DeploymentError):
                    self.invoke(self.arguments("--execute"))
                self.assert_untouched(before)

    def test_execute_rejects_public_permissions_or_linked_plan(self):
        self.plan()
        before = self.audit()
        self.plan_path.chmod(0o644)
        with self.assertRaises(DeploymentError):
            self.invoke(self.arguments("--execute"))
        self.assert_untouched(before)
        self.plan_path.chmod(0o600)
        alternate = self.plans / "original.json"
        self.plan_path.rename(alternate)
        for kind, error in (("symlink", OSError), ("hardlink", DeploymentError)):
            with self.subTest(kind=kind):
                if kind == "hardlink":
                    os.link(alternate, self.plan_path)
                else:
                    self.plan_path.symlink_to(alternate)
                try:
                    with self.assertRaises(error):
                        self.invoke(self.arguments("--execute"))
                    self.assert_untouched(before)
                finally:
                    self.plan_path.unlink()

    def test_real_root_entry_dispatches_initialize_plan_execute_under_lifecycle_lock(self):
        f = self.fixture

        def load():
            self.assertTrue(self.outer_held)
            return f.store.verifier

        with patch.object(release_commands.os, "geteuid", return_value=0), \
                patch.object(release_commands, "verifier_lock", self.lifecycle), \
                patch.object(release_commands, "STATE", f.state.root), \
                patch.object(release_commands, "SITE", f.site), \
                patch.object(release_commands, "DeploymentState", return_value=f.state), \
                patch.object(release_commands, "check_directory") as check, \
                patch.object(release_commands, "load_verifier", side_effect=load), \
                patch.object(retirement_commands, "RetirementReferences", return_value=self.probe):
            for arguments, status in ((["--initialize"], "retirement-enabled"),
                                      (self.arguments("--plan"), "planned"),
                                      (self.arguments("--execute"), "retired")):
                with self.subTest(status=status), contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(release_commands.main(arguments, "axialmuse-release-retire"), 0)
                    self.assertEqual(decode(output.getvalue().encode())["status"], status)
                if status == "planned":
                    before = self.audit()
                    with contextlib.redirect_stdout(io.StringIO()) as output, \
                            contextlib.redirect_stderr(io.StringIO()) as error:
                        missing = self.arguments("--execute", authorization="f" * 32)
                        self.assertEqual(release_commands.main(missing, "axialmuse-release-retire"), 1)
                    self.assertEqual(output.getvalue(), "")
                    self.assertIn("[DEPLOY_INTERNAL]", error.getvalue())
                    self.assert_untouched(before)
            check.assert_called_with(f.site, 0, 0o755)
        self.assertFalse((f.store.releases / self.old).exists())
        self.assertEqual(f.state.available_releases(), {self.current})


if __name__ == "__main__":
    unittest.main()

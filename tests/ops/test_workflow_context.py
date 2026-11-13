"""检查 monitor runner 上下文和私有 Node 运行时边界。"""

import os
import tempfile
import unittest
from pathlib import Path

from ops.monitor.workflow_context import prepare_node, verify_context


class WorkflowContextTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="monitor-runtime-")
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.cache = root / "cache"
        self.runner_temp = root / "temp"
        self.runner_temp.mkdir()
        self.bin = self.cache / "node/24.18.0/x64/bin"
        self.bin.mkdir(parents=True)
        self.node = self.bin / "node"
        self.node.write_text("fixture")
        self.node.chmod(0o777)
        self.output = root / "github-path"
        self.output.touch()
        self.env = {"GITHUB_REPOSITORY": "lyty1997/AxialMuseWebsite", "GITHUB_REF": "refs/heads/main",
                    "RUNNER_TOOL_CACHE": str(self.cache), "RUNNER_TEMP": str(self.runner_temp),
                    "GITHUB_PATH": str(self.output)}

    def test_only_canonical_repository_and_main_are_allowed(self):
        verify_context(self.env)
        for key, value in (("GITHUB_REPOSITORY", "other/repo"), ("GITHUB_REF", "refs/heads/dev")):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "MONITOR_CONTEXT"):
                verify_context({**self.env, key: value})

    def test_copies_trusted_runtime_and_protects_target_without_mutating_source(self):
        prepare_node(self.env, which=lambda _: str(self.node))
        target = self.runner_temp / "axial-monitor-node-runtime"
        self.assertEqual((target / "bin/node").read_text(), "fixture")
        self.assertEqual(target.stat().st_mode & 0o777, 0o700)
        self.assertEqual((target / "bin/node").stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.node.stat().st_mode & 0o777, 0o777)
        self.assertEqual(self.output.read_text(), str(target / "bin") + "\n")
        with self.assertRaisesRegex(ValueError, "MONITOR_NODE_EXISTS"):
            prepare_node(self.env, which=lambda _: str(self.node))
        self.assertEqual(self.output.read_text(), str(target / "bin") + "\n")

    def test_rejects_runtime_outside_cache_and_missing_node(self):
        outside = self.runner_temp / "node"
        outside.write_text("fixture")
        with self.assertRaisesRegex(ValueError, "MONITOR_NODE_PATH"):
            prepare_node(self.env, which=lambda _: str(outside))
        with self.assertRaisesRegex(ValueError, "MONITOR_NODE"):
            prepare_node(self.env, which=lambda _: None)
        self.assertFalse(os.path.lexists(self.runner_temp / "axial-monitor-node-runtime"))
        self.assertEqual(self.output.read_text(), "")


if __name__ == "__main__":
    unittest.main()

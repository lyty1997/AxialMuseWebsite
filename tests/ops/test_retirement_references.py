"""模拟 proc 文件系统验证旧 worker 的内存引用，不能仅检查打开的 fd。"""

import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from ops.deploy.deployment_state import DeploymentError, write_new
from ops.deploy.retirement_references import RetirementReferences
from ops.deploy.nginx_generation import record_activation
from ops.deploy.release_retirement import initialize_retirements
from test_release_transaction import ReleaseFixture


class RetirementReferenceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="axial-reference-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.fixture = ReleaseFixture(root)
        stage, identity = self.fixture.stage("a" * 40)
        self.fixture.approve(identity)
        self.fixture.engine.execute(stage=stage, identity=identity)
        self.proc = root / "proc"
        self.proc.mkdir()
        self.config = root / "nginx.conf"
        write_new(self.config, f"http {{ server {{ root {self.fixture.site}/current/payload; }} }}\n".encode())
        self.pid = root / "pid"
        write_new(self.pid, b"100\n")
        self.process(100, 1)
        self.process(200, 500500)
        children = self.proc / "100/task/100"
        children.mkdir(parents=True)
        (children / "children").write_bytes(b"200 ")
        boot = self.proc / "sys/kernel/random"
        boot.mkdir(parents=True)
        (boot / "boot_id").write_bytes(b"11111111-2222-3333-4444-555555555555\n")
        self.output = f"# configuration file {self.config}:\n".encode() + self.config.read_bytes()

        def command(*_args, **_kwargs):
            return subprocess.CompletedProcess([], 0, self.output, b"")

        self.nginx = SimpleNamespace(store=self.fixture.store, active_config=self.config, active_pid=self.pid,
                                     capture_command=command)
        self.probe = RetirementReferences(self.fixture.store, self.nginx, proc=self.proc, command=command)
        self.nginx.process_identity = self.probe.process
        self.nginx.workers = lambda pid: {int(p): self.probe.process(int(p)) for p in
            (self.proc / str(pid) / "task" / str(pid) / "children").read_bytes().split()}
        self.nginx.process_reader = lambda path: (self.proc / path.removeprefix("/proc/")).read_bytes()
        with self.fixture.state.locked():
            initialize_retirements(self.fixture.state)
        self.seal()

    def seal(self):
        record_activation(self.nginx, "a" * 40, self.probe.configuration(), 100, 1)

    def process(self, pid, start):
        directory = self.proc / str(pid)
        directory.mkdir(exist_ok=True)
        fields = ["S"] + ["0"] * 18 + [str(start)]
        (directory / "stat").write_text(f"{pid} (nginx worker) " + " ".join(fields))
        (directory / "fd").mkdir(exist_ok=True)
        (directory / "maps").write_bytes(b"")
        for name, target in (("exe", "/usr/sbin/nginx"), ("cwd", "/")):
            path = directory / name
            if path.is_symlink():
                path.unlink()
            path.symlink_to(target)

    def test_current_config_and_worker_snapshot_is_stable_and_minimal(self):
        first = self.probe()
        self.assertEqual(first["protected"], ["a" * 40])
        self.assertEqual(first, self.probe())
        self.assertNotIn(str(self.config), str(first))

    def test_old_worker_blocks_without_any_open_release_file(self):
        self.process(200, 499900)
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_WORKER_GENERATION"):
            self.probe()

    def test_explicit_config_fd_and_symbolic_references_are_protected(self):
        old = "b" * 40
        path = self.fixture.store.releases / old
        path.mkdir()
        (path / "payload").mkdir()
        # 配置正文、fd、站点符号链接分别独立保护。
        for mode in ("config", "fd", "symlink"):
            with self.subTest(mode=mode):
                self.output = f"# configuration file {self.config}:\n".encode()
                if mode == "config":
                    self.output += f"root {path}/payload;\n".encode()
                elif mode == "fd":
                    (self.proc / "200/fd/3").symlink_to(path / "payload/index.html")
                else:
                    (self.fixture.site / "pinned").symlink_to(path)
                self.seal()
                self.assertIn(old, self.probe()["protected"])
                if mode == "fd":
                    (self.proc / "200/fd/3").unlink()
        (self.fixture.site / "pinned").unlink()

    def test_other_nginx_instance_and_dynamic_root_refused(self):
        self.process(300, 500500)
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_OTHER_NGINX"):
            self.probe()
        import shutil
        shutil.rmtree(self.proc / "300")
        self.output += b"root $document_root;\n"
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_CONFIG_DYNAMIC"):
            self.probe()

    def test_running_process_with_unreadable_reference_is_not_ignored(self):
        (self.proc / "200/exe").unlink()
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_PROCESS_DRIFT"):
            self.probe()

    def test_changed_configuration_is_not_returned_as_stable(self):
        calls = []

        def command(*_args, **_kwargs):
            calls.append(1)
            return subprocess.CompletedProcess([], 0, self.output + (b"\n" if len(calls) == 2 else b""), b"")

        self.probe.command = command
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_CONFIG_DRIFT"):
            self.probe()

    def test_missing_generation_and_boot_change_are_not_inferred_from_file_time(self):
        generation = self.fixture.state.root / "nginx-generation.json"
        original = generation.read_bytes()
        generation.unlink()
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_GENERATION_MISSING"):
            self.probe()
        write_new(generation, original)
        (self.proc / "sys/kernel/random/boot_id").write_bytes(b"aaaaaaaa-2222-3333-4444-555555555555\n")
        with self.assertRaisesRegex(DeploymentError, "DEPLOY_RETIREMENT_WORKER_GENERATION"):
            self.probe()


if __name__ == "__main__":
    unittest.main()

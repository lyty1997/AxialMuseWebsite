"""固定命令语法和执行前边界，不依赖生产凭证。"""

import contextlib
import fcntl
import io
import hashlib
import json
import os
import select
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from ops.deploy import release_commands as command
from ops.deploy.deployment_state import DeploymentError
from ops.deploy.nginx_activation import LocalNginx, local_site_config
from ops import runtime_bootstrap
from ops.monitor.bounded_process import inherited_lock_fds, run_process


class RuntimeLoadingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="axial-runtime-")
        self.addCleanup(temporary.cleanup)
        self.lib = Path(temporary.name)
        self.versions = self.lib / "versions"
        self.versions.mkdir(mode=0o755)
        self.pointer = self.lib / "active"
        self.lock = self.lib / "lock"
        self.lock.write_bytes(b"")
        self.lock.chmod(0o600)

    def cohort(self, version, extra=None):
        source = {
            "ops/deploy/release_commands.py": (
                f"import sys\nVERSION = {version!r}\nprint('loaded', flush=True)\n"
                "def main():\n print('ready', flush=True)\n sys.stdin.read(1)\n"
                " from ops.deploy.helper import VERSION as lazy\n"
                " print(VERSION + ':' + lazy, flush=True)\n return 0\n"),
            "ops/deploy/helper.py": f"VERSION = {version!r}\n",
        }
        source.update(extra or {})
        manifest = json.dumps({name: hashlib.sha256(code.encode()).hexdigest() for name, code in source.items()},
                              sort_keys=True).encode()
        root = self.versions / hashlib.sha256(manifest).hexdigest()
        root.mkdir(mode=0o755)
        for name, code in source.items():
            target = root / name
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            for folder in (root / "ops", root / "ops/deploy"):
                folder.chmod(0o755)
            target.write_text(code)
            target.chmod(0o644)
        (root / "runtime.json").write_bytes(manifest)
        (root / "runtime.json").chmod(0o644)
        return root

    def process(self):
        script = ("import importlib.util; "
                  f"s=importlib.util.spec_from_file_location('bootstrap', {runtime_bootstrap.__file__!r}); "
                  "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
                  f"raise SystemExit(m.launch('axialmuse-deploy', [], lib=m.Path({str(self.lib)!r}), "
                  f"pointer=m.Path({str(self.pointer)!r}), versions=m.Path({str(self.versions)!r}), "
                  f"lock=m.Path({str(self.lock)!r}), uid={os.getuid()}))")
        child = subprocess.Popen(["/usr/bin/python3", "-I", "-B", "-c", script],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def cleanup():
            if child.poll() is None:
                child.kill()
            child.communicate()
        self.addCleanup(cleanup)
        return child

    def test_real_process_locks_before_import_and_pins_lazy_import_root(self):
        first, second = self.cohort("old"), self.cohort("new")
        self.pointer.symlink_to(first)
        child = self.process()
        self.assertTrue(select.select([child.stdout], [], [], 10)[0], "入口未到达加载屏障")
        loaded = child.stdout.readline()
        self.assertEqual(loaded, b"loaded\n", child.stderr.read() if not loaded else b"")
        ready = child.stdout.readline()
        self.assertEqual(ready, b"ready\n", child.stderr.read() if not ready else b"")
        with self.assertRaises(BlockingIOError):
            with runtime_bootstrap.lifecycle(self.lib, self.lock, uid=os.getuid()):
                self.fail("安装锁不应穿过活动进程")
        # 即便模拟不遵守安装锁的指针切换，已启动进程也只能加载同一代际。
        self.pointer.unlink()
        self.pointer.symlink_to(second)
        output, errors = child.communicate(b"x", timeout=10)
        self.assertEqual(child.returncode, 0, errors)
        self.assertEqual(output, b"old:old\n")

    def test_busy_and_corrupt_runtime_never_import_business_code(self):
        root = self.cohort("bad")
        self.pointer.symlink_to(root)
        with runtime_bootstrap.lifecycle(self.lib, self.lock, uid=os.getuid()):
            output, _ = self.process().communicate(b"x", timeout=10)
            self.assertEqual(output, b"")
        (root / "ops/deploy/helper.py").write_text("VERSION = 'tampered'\n")
        child = self.process()
        output, _ = child.communicate(b"x", timeout=10)
        self.assertEqual(output, b"")
        self.assertNotEqual(child.returncode, 0)

    def test_killed_maintenance_parent_and_worker_cannot_release_live_descendant_locks(self):
        repository = Path(__file__).resolve().parents[2]
        source = {p.relative_to(repository).as_posix(): p.read_text()
                  for p in (repository / "ops").rglob("*.py")}
        ready = self.lib / "writer-ready"
        stop = self.lib / "stop"
        progress = self.lib / "progress"
        worker_pid = self.lib / "worker-pid"
        local_root = self.lib / "maintenance"
        writer = ("import os,time; from pathlib import Path; "
                  f"Path({str(ready)!r}).write_text(str(os.getpid()))\n"
                  f"while not Path({str(stop)!r}).exists():\n"
                  f" Path({str(progress)!r}).write_text(str(time.monotonic_ns()))\n time.sleep(.01)\n")
        source["ops/maintenance/installed.py"] += (
            "\ndef worker(name):\n"
            f" Path({str(worker_pid)!r}).write_text(str(os.getpid()))\n"
            f" result = run_process(['/usr/bin/python3', '-c', {writer!r}], timeout=30, output_limit=1024)\n"
            " sys.stdout.buffer.write(canonical({'schema': 1, 'status': 'ok', 'code': 'OK'}))\n"
            " return result.returncode\n")
        source["ops/deploy/release_commands.py"] += (
            "\ndef main():\n"
            " from ops.maintenance.installed import run_job\n"
            " from ops.maintenance.local_state import LocalMaintenanceState, JOBS\n"
            f" state = LocalMaintenanceState(Path({str(local_root)!r}), os.getuid())\n"
            " state.initialize()\n"
            " state.execute({name: lambda: run_job('resources') for name in JOBS}, guard=verifier_lock)\n"
            " return 0\n")
        root = self.cohort("maintenance", source)
        self.pointer.symlink_to(root)
        parent = self.process()

        def finish():
            stop.touch()
            for marker in (worker_pid, ready):
                if marker.exists():
                    try:
                        os.killpg(int(marker.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        self.addCleanup(finish)
        deadline = time.monotonic() + 10
        while not progress.exists():
            self.assertIsNone(parent.poll(), "维护父进程提前退出")
            self.assertLess(time.monotonic(), deadline, "工作进程未到达写入屏障")
            time.sleep(.01)
        parent.kill()
        parent.wait(timeout=5)
        from ops.maintenance.local_state import LocalMaintenanceState
        local = LocalMaintenanceState(local_root, os.getuid())
        for kill_worker in (False, True):
            with self.subTest(kill_worker=kill_worker):
                if kill_worker:
                    os.kill(int(worker_pid.read_text()), signal.SIGKILL)
                previous = progress.read_bytes()
                deadline = time.monotonic() + 3
                while progress.read_bytes() == previous:
                    self.assertLess(time.monotonic(), deadline, "存活后代未继续工作")
                    time.sleep(.01)
                with self.assertRaises(BlockingIOError):
                    with runtime_bootstrap.lifecycle(self.lib, self.lock, uid=os.getuid()):
                        self.fail("仍在写入的后代丢失了生命周期锁")
                for path in (self.lib, self.lock):
                    fd = os.open(path, os.O_RDONLY)
                    try:
                        with self.assertRaises(BlockingIOError):
                            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    finally:
                        os.close(fd)
                with self.assertRaisesRegex(DeploymentError, "MAINTENANCE_BUSY"):
                    with local.locked():
                        self.fail("仍在写入的后代丢失了维护锁")
        stop.touch()
        deadline = time.monotonic() + 5
        while True:
            try:
                with runtime_bootstrap.lifecycle(self.lib, self.lock, uid=os.getuid()):
                    with local.locked():
                        break
            except (BlockingIOError, DeploymentError):
                self.assertLess(time.monotonic(), deadline, "后代退出后仍残留锁")
                time.sleep(.01)


class ReleaseCommandsTests(unittest.TestCase):
    def test_compatibility_entry_passes_both_acquired_locks_to_subcommands(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = root / "lock"
            lock.write_bytes(b"")
            lock.chmod(0o600)
            check_directory, read_file = command.check_directory, command.read_file
            with patch.object(command, "LIB", root), patch.object(command, "LOCK", lock), \
                    patch.object(command, "check_directory", side_effect=lambda p, _uid: check_directory(p, os.getuid())), \
                    patch.object(command, "read_file", side_effect=lambda p, _uid, **kw: read_file(p, os.getuid(), **kw)):
                with command.verifier_lock():
                    descriptors = inherited_lock_fds()
                    self.assertEqual(len(descriptors), 2)
                    source = f"import os; [os.fstat(fd) for fd in {descriptors!r}]; print('inherited')"
                    result = run_process(["/usr/bin/python3", "-c", source], timeout=5, output_limit=128)
                    self.assertEqual((result.returncode, result.stdout), (0, b"inherited\n"))
                self.assertEqual(inherited_lock_fds(), ())

    def test_exact_five_parameters_and_no_path_or_shell_inputs(self):
        values = ["1", "2", "a" * 40, "b" * 64, "c" * 64]
        args = [value for pair in zip(command.FLAGS, values) for value in pair]
        self.assertEqual(command.parse_deploy(args)["artifact_id"], "2")
        for wrong in (args + ["--path", "/tmp"], args[2:] + args[:2],
                      args[:1] + ["1;id"] + args[2:], args[:5] + ["../bad"] + args[6:]):
            with self.assertRaises(DeploymentError):
                command.parse_deploy(wrong)

    def test_nonroot_fails_without_lock_or_download(self):
        output = io.StringIO()
        with patch.object(command.os, "geteuid", return_value=1000), \
                patch.object(command, "verifier_lock", side_effect=AssertionError("lock reached")), \
                contextlib.redirect_stderr(output):
            self.assertEqual(command.main([], "axialmuse-deploy"), 1)
        self.assertIn("DEPLOY_CONTEXT", output.getvalue())

    def test_invalid_root_invocation_fails_before_lock(self):
        for executable, args in (("axialmuse-rollback", ["--commit-sha", "latest"]),
                                 ("axialmuse-deploy-init", []), ("arbitrary", []),
                                 ("axialmuse-release-retire", ["--initialize", "--force"]),
                                 ("axialmuse-release-retire", ["--execute", "../bad", "--authorization-id", "a" * 32])):
            with self.subTest(executable=executable), \
                    patch.object(command.os, "geteuid", return_value=0), \
                    patch.object(command, "verifier_lock", side_effect=AssertionError("lock reached")), \
                    contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(command.main(args, executable), 1)

    def test_initial_site_block_is_loopback_only_and_same_current_include(self):
        content = local_site_config("/srv/axialmuse").decode()
        self.assertEqual(content.count("listen "), 1)
        self.assertIn("listen 127.0.0.1:18080;", content)
        self.assertIn("include /srv/axialmuse/current/config/site-release.conf;", content)
        self.assertIn("access_log off;", content)
        self.assertNotIn("return 301", content)

    def test_new_workers_do_not_hide_old_generation_still_alive(self):
        nginx = LocalNginx(None)
        old_worker = iter((200, None))
        def identity(pid):
            return 100 if pid == 1 else next(old_worker)
        with patch.object(nginx, "process_identity", side_effect=identity), \
                patch.object(nginx, "workers", return_value={3: 300}), \
                patch("ops.deploy.nginx_activation.time.sleep") as sleep:
            nginx.wait_old_workers(1, 100, {2: 200})
        sleep.assert_called_once()

    def test_replaced_master_is_not_a_successful_reload(self):
        nginx = LocalNginx(None)
        with patch.object(nginx, "process_identity", return_value=101):
            with self.assertRaisesRegex(DeploymentError, "DEPLOY_NGINX_MASTER"):
                nginx.wait_old_workers(1, 100, {2: 200})


if __name__ == "__main__":
    unittest.main()

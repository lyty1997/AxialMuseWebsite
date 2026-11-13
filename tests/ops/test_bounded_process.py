"""以真实生产者证明容量/时限在执行中生效，并检查终止后的可观察残留。"""

import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from ops.monitor import bounded_process, dns_health
from ops.monitor.bounded_process import ProcessOutputLimit, run_process
from ops.monitor.periodic import OUTPUT_LIMIT, run_command
from ops.monitor.public_health import HealthError


class BoundedProcessTests(unittest.TestCase):
    def run_python(self, source, **kwargs):
        return run_process([sys.executable, "-c", source], output_limit=kwargs.pop("output_limit", OUTPUT_LIMIT),
                           timeout=kwargs.pop("timeout", 5), **kwargs)

    def assert_stopped(self, pid):
        deadline = time.monotonic() + 3
        while True:
            try:
                state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
            except (FileNotFoundError, ProcessLookupError):
                return
            if state == "Z":
                return
            self.assertLess(time.monotonic(), deadline, "进程仍在执行")
            time.sleep(0.01)

    def test_combined_limit_is_inclusive_and_binary_streams_preserve_exit_status(self):
        half = OUTPUT_LIMIT // 2
        result = self.run_python(f"import os; os.write(1,b'\\x00'*{half}); os.write(2,b'\\xff'*{half}); raise SystemExit(7)")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (7, b"\x00" * half, b"\xff" * half))

    def test_overflow_stops_producer_before_it_can_finish_or_write_marker(self):
        for stream in ("stdout", "stderr", "combined"):
            with self.subTest(stream=stream), tempfile.TemporaryDirectory() as directory:
                marker = Path(directory) / "finished"
                writes = ("os.write(1,block); os.write(2,block)" if stream == "combined" else
                          "; ".join([f"os.write({1 if stream == 'stdout' else 2},block)"] * 2))
                source = ("import os,time; from pathlib import Path; block=b'x'*(8*1024*1024); "
                          + writes + f"; Path({str(marker)!r}).touch(); time.sleep(30)")
                started = time.monotonic()
                with self.assertRaisesRegex(HealthError, "^PERIODIC_OUTPUT_LIMIT$"):
                    run_command([sys.executable, "-c", source], cwd=directory, env=os.environ.copy(), timeout=5)
                self.assertLess(time.monotonic() - started, 3)
                self.assertFalse(marker.exists())

    def test_one_byte_over_combined_limit_is_failure_not_truncated_success(self):
        with self.assertRaises(ProcessOutputLimit):
            self.run_python("import os; os.write(1,b'a'*1024); os.write(2,b'b'*1025)", output_limit=2048)

    def test_concurrent_streams_and_large_stdin_do_not_deadlock(self):
        data = b"input" * 100000
        source = ("import os,sys,threading; "
                  "t=threading.Thread(target=lambda:os.write(2,b'e'*200000)); t.start(); "
                  "os.write(1,b'o'*200000); data=sys.stdin.buffer.read(); os.write(1,data); t.join()")
        result = self.run_python(source, input=data)
        self.assertEqual(result.stdout, b"o" * 200000 + data)
        self.assertEqual(result.stderr, b"e" * 200000)
        self.assertEqual(result.returncode, 0)

    def test_no_input_is_eof_not_an_interactive_wait(self):
        result = self.run_python("import sys; print(len(sys.stdin.buffer.read()))")
        self.assertEqual(result.stdout, b"0\n")

    def test_shared_deadline_covers_silence_drip_closed_pipes_and_blocked_stdin(self):
        cases = (("import time; time.sleep(30)", None),
                 ("import os,time; os.close(1); os.close(2); time.sleep(30)", None),
                 ("import os,time\nwhile True: os.write(1,b'x'); time.sleep(.02)", None),
                 ("import time; time.sleep(30)", b"x" * 500000))
        popen = subprocess.Popen
        for source, data in cases:
            processes = []

            def start(*args, **kwargs):
                process = popen(*args, **kwargs)
                processes.append(process)
                return process

            with self.subTest(source=source, stdin=data is not None):
                started = time.monotonic()
                with patch.object(bounded_process.subprocess, "Popen", side_effect=start):
                    with self.assertRaises(subprocess.TimeoutExpired):
                        self.run_python(source, input=data, timeout=0.5)
                self.assertLess(time.monotonic() - started, 3)
                self.assertLess(processes[0].returncode, 0)
                self.assert_stopped(processes[0].pid)

    def test_overflow_kills_same_group_descendants_even_after_parent_exits(self):
        for parent_exits in (True, False):
            with self.subTest(parent_exits=parent_exits), tempfile.TemporaryDirectory() as directory:
                ready, late = Path(directory) / "ready", Path(directory) / "late"
                child = ("import os,signal,time; from pathlib import Path; "
                         "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                         f"Path({str(ready)!r}).write_text(str(os.getpid())); time.sleep(.1); "
                         f"os.write(2,b'x'*16000000); Path({str(late)!r}).touch(); time.sleep(30)")
                parent = ("import os,subprocess,sys,time; "
                          f"subprocess.Popen([sys.executable,'-c',{child!r}]); "
                          + ("os._exit(0)" if parent_exits else "time.sleep(30)"))
                processes = []
                popen = subprocess.Popen

                def start(*args, **kwargs):
                    process = popen(*args, **kwargs)
                    processes.append(process)
                    return process

                try:
                    with patch.object(bounded_process.subprocess, "Popen", side_effect=start):
                        with self.assertRaises(ProcessOutputLimit):
                            self.run_python(parent, output_limit=65536)
                    self.assertTrue(ready.exists())
                    self.assert_stopped(int(ready.read_text()))
                    self.assertIsNotNone(processes[0].returncode)
                    self.assertFalse(late.exists())
                finally:
                    for process in processes:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.wait()

    def test_spawn_time_does_not_reset_deadline_and_expired_request_never_starts(self):
        popen = subprocess.Popen

        def delayed(*args, **kwargs):
            time.sleep(.15)
            return popen(*args, **kwargs)

        with patch.object(bounded_process.subprocess, "Popen", side_effect=delayed):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.run_python("import time; time.sleep(30)", timeout=.1)
        with patch.object(bounded_process.subprocess, "Popen") as start:
            with self.assertRaises(subprocess.TimeoutExpired):
                run_process([sys.executable], output_limit=1, deadline=time.monotonic() - 1)
            start.assert_not_called()

    def test_dns_adapter_enforces_output_cap_with_stable_redacted_failure(self):
        popen = subprocess.Popen
        processes = []

        def start(args, **kwargs):
            process = popen([sys.executable, "-c",
                             "import os,time; os.write(2,b'private'*3000000); time.sleep(30)"], **kwargs)
            processes.append(process)
            return process

        with patch.object(bounded_process.subprocess, "Popen", side_effect=start):
            with self.assertRaisesRegex(HealthError, "^DNS_RESPONSE_SIZE$"):
                dns_health.Transport().query("axialmuse.com.", "A")
            self.assertLess(processes[-1].returncode, 0)

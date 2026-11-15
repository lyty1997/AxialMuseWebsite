"""监测进程的执行中边界：合并输出容量、绝对时限及异常进程组回收。"""

import contextlib
import contextvars
import math
import os
import selectors
import signal
import subprocess
import sys
import threading
import time


class ProcessOutputLimit(Exception):
    pass


_LOCK_FDS = contextvars.ContextVar("process_lock_fds", default=())


@contextlib.contextmanager
def retain_locks(descriptors):
    """登记已持有的锁供子命令继承；此处不解锁、不关闭调用者的描述符。"""
    descriptors = tuple(descriptors)
    for fd in descriptors:
        if type(fd) is not int or fd < 3:
            raise ValueError("invalid process lock descriptor")
        os.fstat(fd)
    token = _LOCK_FDS.set(tuple(sorted(set((*_LOCK_FDS.get(), *descriptors)))))
    try:
        yield
    finally:
        _LOCK_FDS.reset(token)


def inherited_lock_fds():
    descriptors = _LOCK_FDS.get()
    runtime = sys.modules.get("_axialmuse_runtime")
    if runtime is not None:
        runtime.check_lock()
        # 旧启动器缺少契约时必须失败，不能只保证父进程持锁。
        descriptors = (*descriptors, *runtime.lock_fds)
    for fd in descriptors:
        os.fstat(fd)
    return tuple(sorted(set(descriptors)))


def run_process(arguments, *, output_limit, timeout=None, deadline=None, cwd=None, env=None, input=None):
    if type(output_limit) is not int or output_limit < 0 or (input is not None and not isinstance(input, bytes)):
        raise ValueError("invalid process limits")
    if timeout is not None:
        deadline = min(deadline, time.monotonic() + timeout) if deadline is not None else time.monotonic() + timeout
    if deadline is None or not math.isfinite(deadline):
        raise ValueError("missing finite deadline")

    def remaining():
        duration = deadline - time.monotonic()
        if duration <= 0:
            raise subprocess.TimeoutExpired(arguments, timeout)
        return duration

    def terminate(number, _frame):
        raise SystemExit(128 + number)

    remaining()
    previous = None
    if threading.current_thread() is threading.main_thread() and signal.getsignal(signal.SIGTERM) == signal.SIG_DFL:
        previous = signal.signal(signal.SIGTERM, terminate)
    try:
        process = subprocess.Popen(arguments, cwd=cwd, env=env, start_new_session=True,
                                   pass_fds=inherited_lock_fds(),
                                   stdin=subprocess.DEVNULL if input is None else subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        stdout, stderr = bytearray(), bytearray()
        total = 0
        try:
            with selectors.DefaultSelector() as selector:
                for pipe, buffer in ((process.stdout, stdout), (process.stderr, stderr)):
                    os.set_blocking(pipe.fileno(), False)
                    selector.register(pipe, selectors.EVENT_READ, buffer)
                pending = memoryview(input or b"")
                if process.stdin is not None:
                    if pending:
                        os.set_blocking(process.stdin.fileno(), False)
                        selector.register(process.stdin, selectors.EVENT_WRITE)
                    else:
                        process.stdin.close()
                while selector.get_map():
                    for key, events in selector.select(remaining()):
                        remaining()
                        try:
                            if events & selectors.EVENT_WRITE:
                                try:
                                    sent = os.write(key.fd, pending[:65536])
                                    pending = pending[sent:]
                                except BrokenPipeError:
                                    pending = pending[len(pending):]
                                if not pending:
                                    selector.unregister(key.fileobj)
                                    key.fileobj.close()
                            else:
                                chunk = os.read(key.fd, min(65536, output_limit - total + 1))
                                if not chunk:
                                    selector.unregister(key.fileobj)
                                    key.fileobj.close()
                                    continue
                                total += len(chunk)
                                if total > output_limit:
                                    raise ProcessOutputLimit()
                                key.data.extend(chunk)
                        except BlockingIOError:
                            continue
                # EOF 不代表进程退出；继续受原截止时间约束。
                process.wait(timeout=remaining())
                remaining()
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            # 失败后不再缓存输出，也不等待持管道后代的 EOF。
            for pipe in (process.stdin, process.stdout, process.stderr):
                if pipe is not None:
                    pipe.close()
            process.wait()
            raise
        finally:
            for pipe in (process.stdin, process.stdout, process.stderr):
                if pipe is not None:
                    pipe.close()
    finally:
        if previous is not None:
            signal.signal(signal.SIGTERM, previous)
    return subprocess.CompletedProcess(arguments, process.returncode, bytes(stdout), bytes(stderr))

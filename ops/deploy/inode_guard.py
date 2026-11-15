"""Linux inode 写租约：已有 fd/mmap 则拒绝，新 open 请求触发中断。

只用于已移入私有命名空间的文件。flock 是协作锁，不能替代此处的内核排他。
"""

import contextlib
import fcntl
import os
import signal
import stat

from ops.deploy.deployment_state import DeploymentError, require


@contextlib.contextmanager
def exclusive_inodes(paths, *, code):
    descriptors = []
    def interrupted(_number, _frame):
        raise DeploymentError(code)
    previous = signal.signal(signal.SIGIO, interrupted)
    try:
        for path in paths:
            descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
            descriptors.append(descriptor)
            value = os.fstat(descriptor)
            require(stat.S_ISREG(value.st_mode) and value.st_nlink == 1, code)
            require((value.st_dev, value.st_ino) == (path.lstat().st_dev, path.lstat().st_ino), code)
            fcntl.fcntl(descriptor, fcntl.F_SETOWN, os.getpid())
            try:
                fcntl.fcntl(descriptor, fcntl.F_SETLEASE, fcntl.F_WRLCK)
            except OSError as error:
                raise DeploymentError(code) from error
        yield
    finally:
        # 解除租约不需要额外 open；不能在失败清理阶段再次被租约信号打断。
        signal.signal(signal.SIGIO, signal.SIG_IGN)
        for descriptor in reversed(descriptors):
            os.close(descriptor)
        signal.signal(signal.SIGIO, previous)

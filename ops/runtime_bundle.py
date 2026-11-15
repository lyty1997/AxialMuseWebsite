"""本地构造不可变组件树；不切换生产入口，也不认证 Git/CI 来源。"""

import argparse
import hashlib
import json
import os
import stat
import tempfile
from pathlib import Path


def bundle(source, versions):
    source, versions = Path(source).resolve(strict=True), Path(versions).resolve(strict=True)
    members = sorted(p for p in (source / "ops").rglob("*")
                     if p.is_file() and (p.suffix == ".py" or "templates" in p.parts))
    content = {}
    for path in members:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or path.resolve() != path:
            raise ValueError("DEPLOY_RUNTIME_SOURCE")
        content[path.relative_to(source).as_posix()] = path.read_bytes()
    # 云端保存的 TAT 命令固定此路径；解析器只用标准库并最终 exec 固定入口。
    content["tat-entry.py"] = content["ops/deploy/tat_entry.py"]
    manifest = json.dumps({name: hashlib.sha256(raw).hexdigest() for name, raw in content.items()},
                          sort_keys=True, separators=(",", ":")).encode()
    target = versions / hashlib.sha256(manifest).hexdigest()
    if target.exists():
        raise FileExistsError("DEPLOY_RUNTIME_EXISTS")
    # 完整构造后单次发布；从不修改同名版本目录。
    staging = Path(tempfile.mkdtemp(prefix=".preparing-", dir=versions))
    for name, raw in {**content, "runtime.json": manifest}.items():
        path = staging / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fchmod(stream.fileno(), 0o644)
            os.fsync(stream.fileno())
    for parent, directories, _ in os.walk(staging, topdown=False):
        os.chmod(parent, 0o755)
        fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    # rename 只发生在调用者独占的新输出目录中，生产发布另需生命周期锁。
    os.rename(staging, target)
    fd = os.open(versions, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()
    output = Path(arguments.output).absolute()
    output.mkdir(mode=0o755)  # 拒绝复用任何既有输出位置。
    output.chmod(0o755)
    print(bundle(Path(__file__).resolve().parent.parent, output))


if __name__ == "__main__":
    main()

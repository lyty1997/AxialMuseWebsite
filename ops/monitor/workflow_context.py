"""监测 workflow 固定仓库/分支检查及月度 Node 运行时准备。"""

import os
import shutil
import stat
import sys
from pathlib import Path


def verify_context(environment):
    if (environment.get("GITHUB_REPOSITORY") != "lyty1997/AxialMuseWebsite"
            or environment.get("GITHUB_REF") != "refs/heads/main"):
        raise ValueError("MONITOR_CONTEXT")


def prepare_node(environment, *, which=shutil.which):
    node_name = which("node")
    if not node_name:
        raise ValueError("MONITOR_NODE")
    source = Path(node_name).resolve(strict=True)
    prefix = source.parent.parent
    tool_cache = Path(environment["RUNNER_TOOL_CACHE"]).resolve(strict=True)
    temporary = Path(environment["RUNNER_TEMP"]).resolve(strict=True)
    if (source != prefix / "bin/node" or prefix.parent.parent != tool_cache / "node"
            or not source.is_file() or not temporary.is_dir()):
        raise ValueError("MONITOR_NODE_PATH")
    target = temporary / "axial-monitor-node-runtime"
    if os.path.lexists(target):
        raise ValueError("MONITOR_NODE_EXISTS")
    shutil.copytree(prefix, target, symlinks=True)
    os.chmod(target, 0o700)
    for parent, directories, files in os.walk(target, followlinks=False):
        for item in [Path(parent), *(Path(parent) / name for name in directories + files)]:
            if not item.is_symlink():
                os.chmod(item, stat.S_IMODE(item.stat().st_mode) & ~0o022)
    with open(environment["GITHUB_PATH"], "a", encoding="utf-8") as path_file:
        path_file.write(str(target / "bin") + "\n")


def main(arguments=None):
    arguments = sys.argv[1:] if arguments is None else arguments
    try:
        if arguments == ["verify"]:
            verify_context(os.environ)
        elif arguments == ["prepare-node"]:
            verify_context(os.environ)
            prepare_node(os.environ)
        else:
            return 2
        return 0
    except Exception:
        print("MONITOR_WORKFLOW_CONTEXT_FAILED", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

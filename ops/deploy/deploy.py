#!/usr/bin/python3 -I
"""固定 TAT 发布入口；当前授权仅允许私有制品预备。"""

import sys


# -I 不读取 PYTHONPATH；生产组件只从 root-owned 固定路径导入。
sys.path.insert(0, "/usr/local/lib/axialmuse-release")

from ops.deploy.fetch_artifact import ArtifactFetchError  # noqa: E402
from ops.deploy.github_app_auth import GitHubAppAuthError  # noqa: E402
from ops.deploy.prepare_artifact import (  # noqa: E402
    PrepareArtifactError,
    prepare_artifact,
)


FLAGS = (
    "--workflow-run-id",
    "--artifact-id",
    "--commit-sha",
    "--artifact-digest",
    "--release-content-sha256",
)


def parse_inputs(arguments):
    if len(arguments) != len(FLAGS) * 2:
        raise PrepareArtifactError("DEPLOY_ARGUMENTS")
    values = []
    for offset, flag in enumerate(FLAGS):
        if arguments[offset * 2] != flag:
            raise PrepareArtifactError("DEPLOY_ARGUMENTS")
        values.append(arguments[offset * 2 + 1])
    return dict(zip((
        "workflow_run_id",
        "artifact_id",
        "commit_sha",
        "artifact_digest",
        "release_content_sha256",
    ), values, strict=True))


def main(arguments=None, prepare=prepare_artifact):
    try:
        if arguments is None:
            arguments = sys.argv[1:]
        inputs = parse_inputs(arguments)
        prepare(**inputs)
        print("[DEPLOY_ACTIVATION_PENDING] 制品已进入私有验证区；生产激活尚未授权。", file=sys.stderr)
        return 2
    except (PrepareArtifactError, ArtifactFetchError, GitHubAppAuthError) as error:
        print(f"[{error}] 固定发布入口失败关闭。", file=sys.stderr)
    except Exception:
        print("[DEPLOY_INTERNAL] 固定发布入口发生未分类错误。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

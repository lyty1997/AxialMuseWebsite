import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {
  checkProductionArtifactWorkspace,
  ProductionArtifactWorkspaceError,
} from "../../scripts/quality/lib/production-artifact-workspace.mjs";

function runGit(root, arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
}

function createRepository(root) {
  runGit(root, ["init", "--quiet"]);
  writeFileSync(join(root, "tracked.txt"), "initial\n", "utf8");
  runGit(root, ["add", "tracked.txt"]);
  runGit(root, [
    "-c",
    "user.name=Axial Muse Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  return runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
}

function canonicalEnvironment(commitSha, overrides = {}) {
  return {
    ...process.env,
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "lyty1997/AxialMuseWebsite",
    GITHUB_SHA: commitSha,
    ...overrides,
  };
}

function withRepository(callback) {
  const lexicalRoot = mkdtempSync(join(
    tmpdir(),
    "axial-muse-production-workspace-",
  ));
  const root = realpathSync(lexicalRoot);
  try {
    const commitSha = createRepository(root);
    return callback({commitSha, root});
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

function expectCode(callback, code) {
  assert.throws(
    callback,
    (error) => (
      error instanceof ProductionArtifactWorkspaceError
      && error.code === code
    ),
  );
}

test("E-015 fresh production workspace accepts exact clean main commit", () => {
  withRepository(({commitSha, root}) => {
    assert.deepEqual(
      checkProductionArtifactWorkspace({
        root,
        cwd: root,
        environment: canonicalEnvironment(commitSha),
      }),
      {
        commitSha,
        repository: "lyty1997/AxialMuseWebsite",
      },
    );
  });
});

test("E-015 fresh production workspace rejects event and SHA drift", () => {
  withRepository(({commitSha, root}) => {
    for (const [environment, code] of [
      [
        canonicalEnvironment(commitSha, {GITHUB_EVENT_NAME: "pull_request"}),
        "PRODUCTION_ARTIFACT_WORKSPACE_EVENT",
      ],
      [
        canonicalEnvironment(commitSha, {GITHUB_REF: "refs/heads/dev"}),
        "PRODUCTION_ARTIFACT_WORKSPACE_EVENT",
      ],
      [
        canonicalEnvironment(commitSha, {
          GITHUB_REPOSITORY: "fork/AxialMuseWebsite",
        }),
        "PRODUCTION_ARTIFACT_WORKSPACE_EVENT",
      ],
      [
        canonicalEnvironment("a".repeat(40)),
        "PRODUCTION_ARTIFACT_WORKSPACE_SHA",
      ],
      [
        canonicalEnvironment("main"),
        "PRODUCTION_ARTIFACT_WORKSPACE_SHA",
      ],
    ]) {
      expectCode(
        () => checkProductionArtifactWorkspace({
          root,
          cwd: root,
          environment,
        }),
        code,
      );
    }
  });
});

test("E-015 preflight rejects dirty tracked and untracked worktrees", () => {
  withRepository(({commitSha, root}) => {
    const environment = canonicalEnvironment(commitSha);
    writeFileSync(join(root, "tracked.txt"), "changed\n", "utf8");
    expectCode(
      () => checkProductionArtifactWorkspace({
        root,
        cwd: root,
        environment,
      }),
      "PRODUCTION_ARTIFACT_WORKSPACE_DIRTY",
    );
    writeFileSync(join(root, "tracked.txt"), "initial\n", "utf8");
    writeFileSync(join(root, "untracked.txt"), "untracked\n", "utf8");
    expectCode(
      () => checkProductionArtifactWorkspace({
        root,
        cwd: root,
        environment,
      }),
      "PRODUCTION_ARTIFACT_WORKSPACE_DIRTY",
    );
  });
});

test("E-015 preflight rejects assume-unchanged and skip-worktree flags", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    withRepository(({commitSha, root}) => {
      runGit(root, ["update-index", flag, "tracked.txt"]);
      writeFileSync(join(root, "tracked.txt"), "hidden change\n", "utf8");
      expectCode(
        () => checkProductionArtifactWorkspace({
          root,
          cwd: root,
          environment: canonicalEnvironment(commitSha),
        }),
        "PRODUCTION_ARTIFACT_WORKSPACE_DIRTY",
      );
    });
  }
});

test("E-015 preflight rejects every pre-existing build or dist object", () => {
  const fixtures = [
    ["build", "file"],
    ["build", "directory"],
    ["build", "symlink"],
    ["build", "dangling"],
    ["dist", "file"],
    ["dist", "dangling"],
  ];
  for (const [name, kind] of fixtures) {
    withRepository(({commitSha, root}) => {
      const path = join(root, name);
      if (kind === "file") {
        writeFileSync(path, "old output\n", "utf8");
      } else if (kind === "directory") {
        mkdirSync(path);
      } else if (kind === "symlink") {
        symlinkSync(join(root, "tracked.txt"), path);
      } else {
        symlinkSync(join(root, "missing-output"), path);
      }
      expectCode(
        () => checkProductionArtifactWorkspace({
          root,
          cwd: root,
          environment: canonicalEnvironment(commitSha),
        }),
        "PRODUCTION_ARTIFACT_WORKSPACE_OUTPUT",
      );
    });
  }
});

test("E-015 preflight rejects a shallow repository", () => {
  const source = realpathSync(mkdtempSync(join(
    tmpdir(),
    "axial-muse-production-source-",
  )));
  const cloneParent = realpathSync(mkdtempSync(join(
    tmpdir(),
    "axial-muse-production-clone-",
  )));
  const clone = join(cloneParent, "worktree");
  try {
    createRepository(source);
    writeFileSync(join(source, "tracked.txt"), "second\n", "utf8");
    runGit(source, ["add", "tracked.txt"]);
    runGit(source, [
      "-c",
      "user.name=Axial Muse Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "second",
    ]);
    runGit(cloneParent, [
      "clone",
      "--quiet",
      "--depth=1",
      `file://${source}`,
      clone,
    ]);
    const canonicalClone = realpathSync(clone);
    const commitSha = runGit(
      canonicalClone,
      ["rev-parse", "--verify", "HEAD^{commit}"],
    ).trim();
    expectCode(
      () => checkProductionArtifactWorkspace({
        root: canonicalClone,
        cwd: canonicalClone,
        environment: canonicalEnvironment(commitSha),
      }),
      "PRODUCTION_ARTIFACT_WORKSPACE_SHALLOW",
    );
  } finally {
    rmSync(source, {recursive: true, force: true});
    rmSync(cloneParent, {recursive: true, force: true});
  }
});

test("E-015 preflight propagates a git status failure", () => {
  withRepository(({commitSha, root}) => {
    const spawnProcess = (command, arguments_, options) => {
      if (arguments_[0] === "status") {
        return {
          error: undefined,
          signal: null,
          status: 1,
          stderr: Buffer.alloc(0),
          stdout: Buffer.alloc(0),
        };
      }
      return spawnSync(command, arguments_, options);
    };
    expectCode(
      () => checkProductionArtifactWorkspace({
        root,
        cwd: root,
        environment: canonicalEnvironment(commitSha),
        spawnProcess,
      }),
      "PRODUCTION_ARTIFACT_WORKSPACE_GIT",
    );
  });
});

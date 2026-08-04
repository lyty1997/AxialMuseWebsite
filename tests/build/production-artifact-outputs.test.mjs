import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {
  appendProductionArtifactOutputs,
  appendProductionArtifactUploadSeal,
  assertProductionArtifactBinding,
  captureProductionArtifactUploadSeal,
  ProductionArtifactOutputError,
  renderProductionArtifactOutputs,
  renderProductionArtifactUploadSeal,
  validateProductionArtifactOutputs,
  validateProductionArtifactUploadSeal,
} from "../../scripts/quality/lib/production-artifact-outputs.mjs";
import {captureFileTree} from "../../scripts/quality/lib/file-tree.mjs";
import {
  readProductionArtifactOutputEnvironment,
  readProductionArtifactUploadSealEnvironment,
  runProductionArtifactOutputCli,
} from "../../scripts/quality/check-production-artifact-outputs.mjs";
import {
  runPrepareProductionArtifactUploadCli,
} from "../../scripts/quality/prepare-production-artifact-upload.mjs";

const VALID = Object.freeze({
  artifactDigest: "a".repeat(64),
  artifactId: "123456789",
  commitSha: "c".repeat(40),
  releaseContentSha256: "b".repeat(64),
  repository: "lyty1997/AxialMuseWebsite",
  runAttempt: "2",
  runId: "987654321",
});

const VALID_SEAL = Object.freeze({
  buildOperationalSha256: "d".repeat(64),
  releaseContentSha256: VALID.releaseContentSha256,
  releaseOperationalSha256: "e".repeat(64),
});

function expectCode(callback, code) {
  assert.throws(
    callback,
    (error) => (
      error instanceof ProductionArtifactOutputError
      && error.code === code
    ),
  );
}

function withTemporaryDirectory(callback) {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-artifact-output-"));
  chmodSync(root, 0o700);
  try {
    return callback(root);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

function environmentFor(outputPath, overrides = {}) {
  return {
    AXIAL_ARTIFACT_DIGEST: VALID.artifactDigest,
    AXIAL_ARTIFACT_ID: VALID.artifactId,
    AXIAL_BUILD_OPERATIONAL_SHA256: VALID_SEAL.buildOperationalSha256,
    AXIAL_COMMIT_SHA: VALID.commitSha,
    AXIAL_RELEASE_CONTENT_SHA256: VALID.releaseContentSha256,
    AXIAL_RELEASE_OPERATIONAL_SHA256:
      VALID_SEAL.releaseOperationalSha256,
    AXIAL_REPOSITORY: VALID.repository,
    AXIAL_RUN_ATTEMPT: VALID.runAttempt,
    AXIAL_RUN_ID: VALID.runId,
    GITHUB_OUTPUT: outputPath,
    ...overrides,
  };
}

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

function withBoundRelease(callback) {
  const parent = realpathSync(mkdtempSync(join(
    tmpdir(),
    "axial-muse-artifact-binding-",
  )));
  const root = join(parent, "repository");
  const outputPath = join(parent, "github-output");
  mkdirSync(root);
  writeFileSync(outputPath, "", {encoding: "utf8", mode: 0o600});
  try {
    runGit(root, ["init", "--quiet"]);
    writeFileSync(join(root, ".gitignore"), "build/\ndist/\n", "utf8");
    writeFileSync(join(root, "tracked.txt"), "initial\n", "utf8");
    runGit(root, ["add", ".gitignore", "tracked.txt"]);
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
    const commitSha = runGit(
      root,
      ["rev-parse", "--verify", "HEAD^{commit}"],
    ).trim();
    const buildRoot = join(root, "build");
    mkdirSync(buildRoot);
    writeFileSync(
      join(buildRoot, "index.html"),
      "<!doctype html>\n",
      "utf8",
    );
    const sourceBuildTreeSha256 = captureFileTree({
      root: buildRoot,
      sourcePath: "build",
    }).treeSha256;
    const releaseRoot = join(root, "dist", "release");
    mkdirSync(join(releaseRoot, "metadata"), {recursive: true});
    mkdirSync(join(releaseRoot, "payload"));
    writeFileSync(
      join(releaseRoot, "metadata", "release.json"),
      `${JSON.stringify({commitSha, sourceBuildTreeSha256}, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      join(releaseRoot, "payload", "index.html"),
      "<!doctype html>\n",
      "utf8",
    );
    const releaseContentSha256 = captureFileTree({
      root: releaseRoot,
      sourcePath: "dist/release",
    }).treeSha256;
    const identity = Object.freeze({
      ...VALID,
      commitSha,
      releaseContentSha256,
    });
    const uploadSeal = captureProductionArtifactUploadSeal({
      root,
      cwd: root,
      environment: process.env,
      releaseContentSha256,
      commitSha,
    });
    const environment = environmentFor(outputPath, {
      AXIAL_BUILD_OPERATIONAL_SHA256:
        uploadSeal.buildOperationalSha256,
      AXIAL_COMMIT_SHA: commitSha,
      AXIAL_RELEASE_CONTENT_SHA256: releaseContentSha256,
      AXIAL_RELEASE_OPERATIONAL_SHA256:
        uploadSeal.releaseOperationalSha256,
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "lyty1997/AxialMuseWebsite",
      GITHUB_SHA: commitSha,
    });
    return callback({
      buildRoot,
      commitSha,
      environment,
      identity,
      outputPath,
      releaseRoot,
      root,
      uploadSeal,
    });
  } finally {
    rmSync(parent, {recursive: true, force: true});
  }
}

test("CODE-020 validates and renders seven independent outputs", () => {
  assert.deepEqual(validateProductionArtifactOutputs({...VALID}), VALID);
  assert.equal(
    renderProductionArtifactOutputs(VALID),
    `artifact-id=${VALID.artifactId}\n`
      + `artifact-digest=${VALID.artifactDigest}\n`
      + `release-content-sha256=${VALID.releaseContentSha256}\n`
      + `repository=${VALID.repository}\n`
      + `run-id=${VALID.runId}\n`
      + `run-attempt=${VALID.runAttempt}\n`
      + `commit-sha=${VALID.commitSha}\n`,
  );
  assert.deepEqual(
    validateProductionArtifactUploadSeal({...VALID_SEAL}),
    VALID_SEAL,
  );
  assert.equal(
    renderProductionArtifactUploadSeal(VALID_SEAL),
    `release-content-sha256=${VALID_SEAL.releaseContentSha256}\n`
      + `build-operational-sha256=${VALID_SEAL.buildOperationalSha256}\n`
      + `release-operational-sha256=${VALID_SEAL.releaseOperationalSha256}\n`,
  );
});

test("CODE-020 rejects missing, extra and malformed output identities", () => {
  const {artifactId: _artifactId, ...missing} = VALID;
  expectCode(
    () => validateProductionArtifactOutputs(missing),
    "PRODUCTION_ARTIFACT_OUTPUT_INPUT",
  );
  expectCode(
    () => validateProductionArtifactOutputs({...VALID, extra: "value"}),
    "PRODUCTION_ARTIFACT_OUTPUT_INPUT",
  );
  for (const [field, value] of [
    ["artifactId", ""],
    ["artifactId", "0"],
    ["artifactId", "01"],
    ["artifactId", "1\nartifact-digest=forged"],
    ["runId", "-1"],
    ["runAttempt", "1.0"],
  ]) {
    expectCode(
      () => validateProductionArtifactOutputs({...VALID, [field]: value}),
      "PRODUCTION_ARTIFACT_OUTPUT_IDENTITY",
    );
  }
});

test("CODE-020 rejects prefixed, uppercase and wrong-length digests", () => {
  for (const [field, value] of [
    ["artifactDigest", `sha256:${"a".repeat(64)}`],
    ["artifactDigest", "A".repeat(64)],
    ["artifactDigest", "a".repeat(63)],
    ["releaseContentSha256", ""],
    ["releaseContentSha256", "B".repeat(64)],
  ]) {
    expectCode(
      () => validateProductionArtifactOutputs({...VALID, [field]: value}),
      "PRODUCTION_ARTIFACT_OUTPUT_DIGEST",
    );
  }
});

test("CODE-020 rejects wrong repository and commit identity", () => {
  expectCode(
    () => validateProductionArtifactOutputs({
      ...VALID,
      repository: "fork/AxialMuseWebsite",
    }),
    "PRODUCTION_ARTIFACT_OUTPUT_REPOSITORY",
  );
  for (const commitSha of [
    "",
    "C".repeat(40),
    "c".repeat(39),
    `c${"\n"}${"c".repeat(39)}`,
  ]) {
    expectCode(
      () => validateProductionArtifactOutputs({...VALID, commitSha}),
      "PRODUCTION_ARTIFACT_OUTPUT_COMMIT",
    );
  }
});

test("CODE-020 appends validated outputs to the owned regular runner file", () => {
  withTemporaryDirectory((root) => {
    const outputPath = join(root, "github-output");
    writeFileSync(outputPath, "existing=value\n", {encoding: "utf8", mode: 0o600});
    assert.deepEqual(
      appendProductionArtifactOutputs(outputPath, VALID),
      VALID,
    );
    assert.equal(
      readFileSync(outputPath, "utf8"),
      `existing=value\n${renderProductionArtifactOutputs(VALID)}`,
    );
    assert.deepEqual(
      appendProductionArtifactUploadSeal(outputPath, VALID_SEAL),
      VALID_SEAL,
    );
    assert.equal(
      readFileSync(outputPath, "utf8"),
      `existing=value\n${renderProductionArtifactOutputs(VALID)}`
        + renderProductionArtifactUploadSeal(VALID_SEAL),
    );
  });
});

test("CODE-020 output writer rejects symlinks and non-canonical paths", () => {
  withTemporaryDirectory((root) => {
    const target = join(root, "target");
    const link = join(root, "link");
    writeFileSync(target, "", {encoding: "utf8", mode: 0o600});
    symlinkSync(target, link);
    expectCode(
      () => appendProductionArtifactOutputs(link, VALID),
      "PRODUCTION_ARTIFACT_OUTPUT_FILE",
    );
    expectCode(
      () => appendProductionArtifactOutputs("relative-output", VALID),
      "PRODUCTION_ARTIFACT_OUTPUT_FILE",
    );
  });
});

test("CODE-020 CLI environment mapping is closed and writes no stdout contract", () => {
  withBoundRelease(({
    environment,
    identity,
    outputPath,
    root,
    uploadSeal,
  }) => {
    assert.deepEqual(
      readProductionArtifactOutputEnvironment(environment),
      identity,
    );
    assert.deepEqual(
      readProductionArtifactUploadSealEnvironment(environment),
      uploadSeal,
    );
    assert.deepEqual(
      runProductionArtifactOutputCli({
        arguments_: [],
        environment,
        root,
        cwd: root,
      }),
      identity,
    );
    assert.equal(
      readFileSync(outputPath, "utf8"),
      renderProductionArtifactOutputs(identity),
    );
    expectCode(
      () => runProductionArtifactOutputCli({
        arguments_: ["unexpected"],
        environment,
        root,
        cwd: root,
      }),
      "PRODUCTION_ARTIFACT_OUTPUT_INPUT",
    );
  });
});

test("CODE-020 pre-upload CLI writes the cross-Action operational seal", () => {
  withBoundRelease(({
    environment,
    outputPath,
    uploadSeal,
    root,
  }) => {
    assert.deepEqual(
      runPrepareProductionArtifactUploadCli({
        arguments_: [],
        environment,
        root,
        cwd: root,
      }),
      uploadSeal,
    );
    assert.equal(
      readFileSync(outputPath, "utf8"),
      renderProductionArtifactUploadSeal(uploadSeal),
    );
  });
});

test("CODE-020 post-upload binding accepts the exact HEAD and release tree", () => {
  withBoundRelease(({environment, identity, root, uploadSeal}) => {
    assert.deepEqual(
      assertProductionArtifactBinding({
        root,
        cwd: root,
        environment,
        identity,
        uploadSeal,
      }),
      identity,
    );
  });
});

test("CODE-020 post-upload binding rejects a clean local commit drift", () => {
  withBoundRelease(({
    environment,
    identity,
    outputPath,
    root,
  }) => {
    writeFileSync(join(root, "tracked.txt"), "second\n", "utf8");
    runGit(root, ["add", "tracked.txt"]);
    runGit(root, [
      "-c",
      "user.name=Axial Muse Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "second",
    ]);
    expectCode(
      () => runProductionArtifactOutputCli({
        arguments_: [],
        environment,
        root,
        cwd: root,
      }),
      "PRODUCTION_ARTIFACT_OUTPUT_COMMIT_BINDING",
    );
    assert.equal(readFileSync(outputPath, "utf8"), "");
  });
});

test("CODE-020 post-upload binding rejects hidden tracked source drift", () => {
  withBoundRelease(({
    environment,
    identity,
    outputPath,
    root,
  }) => {
    runGit(root, [
      "update-index",
      "--assume-unchanged",
      "tracked.txt",
    ]);
    writeFileSync(join(root, "tracked.txt"), "hidden mutation\n", "utf8");
    expectCode(
      () => runProductionArtifactOutputCli({
        arguments_: [],
        environment,
        root,
        cwd: root,
      }),
      "PRODUCTION_ARTIFACT_OUTPUT_COMMIT_BINDING",
    );
    assert.deepEqual(identity.commitSha, environment.AXIAL_COMMIT_SHA);
    assert.equal(readFileSync(outputPath, "utf8"), "");
  });
});

test("CODE-020 post-upload binding rejects persistent release replacement", () => {
  withBoundRelease(({
    environment,
    identity,
    outputPath,
    releaseRoot,
    root,
  }) => {
    writeFileSync(
      join(releaseRoot, "payload", "index.html"),
      "<!doctype html><p>replaced</p>\n",
      "utf8",
    );
    expectCode(
      () => runProductionArtifactOutputCli({
        arguments_: [],
        environment,
        root,
        cwd: root,
      }),
      "PRODUCTION_ARTIFACT_OUTPUT_RELEASE_CHANGED",
    );
    assert.equal(readFileSync(outputPath, "utf8"), "");
  });
});

test("CODE-020 cross-Action seal rejects release A-B-A replacement", () => {
  withBoundRelease(({
    environment,
    outputPath,
    releaseRoot,
    root,
  }) => {
    const path = join(releaseRoot, "payload", "index.html");
    writeFileSync(path, "<!doctype html><p>uploaded B</p>\n", "utf8");
    writeFileSync(path, "<!doctype html>\n", "utf8");
    expectCode(
      () => runProductionArtifactOutputCli({
        arguments_: [],
        environment,
        root,
        cwd: root,
      }),
      "PRODUCTION_ARTIFACT_OUTPUT_RELEASE_CHANGED",
    );
    assert.equal(readFileSync(outputPath, "utf8"), "");
  });
});

test("CODE-020 post-upload binding rejects persistent build replacement", () => {
  withBoundRelease(({
    buildRoot,
    environment,
    outputPath,
    root,
  }) => {
    writeFileSync(
      join(buildRoot, "index.html"),
      "<!doctype html><p>replaced build</p>\n",
      "utf8",
    );
    expectCode(
      () => runProductionArtifactOutputCli({
        arguments_: [],
        environment,
        root,
        cwd: root,
      }),
      "PRODUCTION_ARTIFACT_OUTPUT_BUILD_CHANGED",
    );
    assert.equal(readFileSync(outputPath, "utf8"), "");
  });
});

test("CODE-020 post-upload binding rejects transient build A-B-A mutation", () => {
  withBoundRelease(({
    buildRoot,
    environment,
    identity,
    root,
    uploadSeal,
  }) => {
    let mutated = false;
    const spawnProcess = (command, arguments_, options) => {
      if (!mutated && arguments_[0] === "rev-parse") {
        mutated = true;
        const path = join(buildRoot, "index.html");
        writeFileSync(path, "<!doctype html><p>transient</p>\n", "utf8");
        writeFileSync(path, "<!doctype html>\n", "utf8");
      }
      return spawnSync(command, arguments_, options);
    };
    expectCode(
      () => assertProductionArtifactBinding({
        root,
        cwd: root,
        environment,
        identity,
        uploadSeal,
        spawnProcess,
      }),
      "PRODUCTION_ARTIFACT_OUTPUT_BUILD_CHANGED",
    );
    assert.equal(mutated, true);
  });
});

test("CODE-020 post-upload binding rejects self-consistent wrong metadata commit", () => {
  withBoundRelease(({
    environment,
    identity,
    outputPath,
    releaseRoot,
    root,
  }) => {
    writeFileSync(
      join(releaseRoot, "metadata", "release.json"),
      `${JSON.stringify({
        commitSha: "d".repeat(40),
        sourceBuildTreeSha256: captureFileTree({
          root: join(root, "build"),
          sourcePath: "build",
        }).treeSha256,
      }, null, 2)}\n`,
      "utf8",
    );
    const releaseContentSha256 = captureFileTree({
      root: releaseRoot,
      sourcePath: "dist/release",
    }).treeSha256;
    const changedEnvironment = {
      ...environment,
      AXIAL_RELEASE_CONTENT_SHA256: releaseContentSha256,
    };
    expectCode(
      () => runProductionArtifactOutputCli({
        arguments_: [],
        environment: changedEnvironment,
        root,
        cwd: root,
      }),
      "PRODUCTION_ARTIFACT_OUTPUT_COMMIT_BINDING",
    );
    assert.notEqual(identity.releaseContentSha256, releaseContentSha256);
    assert.equal(readFileSync(outputPath, "utf8"), "");
  });
});

test("CODE-020 CLI fails closed when an Action output is absent", () => {
  withTemporaryDirectory((root) => {
    const outputPath = join(root, "github-output");
    writeFileSync(outputPath, "", {encoding: "utf8", mode: 0o600});
    const environment = environmentFor(outputPath);
    delete environment.AXIAL_ARTIFACT_DIGEST;
    expectCode(
      () => runProductionArtifactOutputCli({
        arguments_: [],
        environment,
      }),
      "PRODUCTION_ARTIFACT_OUTPUT_DIGEST",
    );
    assert.equal(readFileSync(outputPath, "utf8"), "");
  });
});

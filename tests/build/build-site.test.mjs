import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {
  abortBuildTransaction,
  assertBuildModeAvailable,
  assertSupportedNodeVersion,
  beginBuildTransaction,
  BuildSiteError,
  candidateOutputPath,
  captureCandidateBuildEvidence,
  parseBuildArguments,
  publishCandidateBuild,
  runProductionArtifactCheck,
  runProductionBuild,
} from "../../scripts/build/build-site.mjs";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

function hasBuildCode(code) {
  return (error) => error instanceof BuildSiteError && error.code === code;
}

function writeFixture(root, relativePath, contents = "") {
  const path = resolve(root, relativePath);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, contents, "utf8");
}

test("I-12 构建参数封闭解析 production/preview 且 preview 执行仍由 #8 失败关闭", () => {
  assert.deepEqual(parseBuildArguments(["--mode", "production"]), {mode: "production"});
  assert.deepEqual(parseBuildArguments(["--mode", "preview"]), {mode: "preview"});
  assert.doesNotThrow(() => assertBuildModeAvailable("production"));
  assert.throws(() => assertBuildModeAvailable("preview"), hasBuildCode("BUILD_MODE_UNAVAILABLE"));
  assert.throws(() => parseBuildArguments([]), hasBuildCode("BUILD_ARGUMENTS"));
  assert.throws(
    () => parseBuildArguments(["--mode", "other"]),
    hasBuildCode("BUILD_MODE"),
  );
});

test("D-067 构建入口只接受主 Node 与 engines 下界", () => {
  assert.equal(
    assertSupportedNodeVersion({root: PROJECT_ROOT, nodeVersion: "24.18.0"}),
    "primary",
  );
  assert.equal(
    assertSupportedNodeVersion({root: PROJECT_ROOT, nodeVersion: "24.16.0"}),
    "minimum",
  );
  assert.throws(
    () => assertSupportedNodeVersion({root: PROJECT_ROOT, nodeVersion: "22.22.0"}),
    hasBuildCode("BUILD_RUNTIME_NODE"),
  );
});

test("CODE-014 production build 在读取内容前拒绝作者 lock", () => {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-build-author-lock-"));
  try {
    mkdirSync(resolve(root, "site-content/writing"), {recursive: true});
    writeFixture(root, ".axial-muse-author.lock", "fixture\n");
    assert.throws(
      () => runProductionBuild({root}),
      hasBuildCode("BUILD_AUTHOR_TRANSACTION"),
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("CODE-014 production build 持有 build lock 后二次拒绝并发作者 lock", () => {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-build-author-race-"));
  let hookCalls = 0;
  try {
    writeFixture(root, ".nvmrc", readFileSync(resolve(PROJECT_ROOT, ".nvmrc")));
    writeFixture(
      root,
      "package.json",
      readFileSync(resolve(PROJECT_ROOT, "package.json")),
    );
    mkdirSync(resolve(root, "site-content/writing"), {recursive: true});
    assert.throws(
      () => runProductionBuild({
        root,
        testHooks: {
          afterBuildLockAcquired() {
            hookCalls += 1;
            assert.equal(
              existsSync(resolve(root, ".axial-muse-build.lock")),
              true,
            );
            writeFixture(root, ".axial-muse-author.lock", "fixture\n");
          },
        },
      }),
      hasBuildCode("BUILD_AUTHOR_TRANSACTION"),
    );
    assert.equal(hookCalls, 1);
    assert.equal(existsSync(resolve(root, ".axial-muse-build.lock")), false);
    assert.equal(
      readFileSync(resolve(root, ".axial-muse-author.lock"), "utf8"),
      "fixture\n",
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("#33 production artifact checker 只持验证锁并保留既有 retired 状态", () => {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-production-check-"));
  try {
    writeFixture(root, ".nvmrc", readFileSync(resolve(PROJECT_ROOT, ".nvmrc")));
    writeFixture(
      root,
      "package.json",
      readFileSync(resolve(PROJECT_ROOT, "package.json")),
    );
    mkdirSync(resolve(root, "site-content/writing"), {recursive: true});
    writeFixture(root, "build/index.html", "<!doctype html>\n");
    writeFixture(root, ".axial-muse-build-retired/identity.txt", "retired\n");
    writeFixture(
      root,
      "node_modules/@docusaurus/core/bin/docusaurus.mjs",
      [
        "import {writeFileSync} from \"node:fs\";",
        "import {resolve} from \"node:path\";",
        "if (process.argv.slice(2).join(\" \") !== \"axial-muse:check-production\") process.exit(9);",
        "const transactionRoot = process.env.AXIAL_MUSE_BUILD_TRANSACTION_ROOT;",
        "writeFileSync(resolve(transactionRoot, \".axial-muse-content-input-seal\"), [",
        "  \"axial-muse-content-input-v1\",",
        "  \"owner:\" + process.env.AXIAL_MUSE_BUILD_OWNER,",
        "  \"sha256:\" + \"f\".repeat(64),",
        "  \"\",",
        "].join(\"\\n\"), {encoding: \"utf8\", flag: \"wx\", mode: 0o600});",
        "writeFileSync(\"production-check-call.json\", JSON.stringify({",
        "  phase: process.env.AXIAL_MUSE_BUILD_PHASE,",
        "  output: process.env.AXIAL_MUSE_BUILD_OUTPUT,",
        "  transactionRoot,",
        "}));",
      ].join("\n"),
    );

    assert.equal(runProductionArtifactCheck({root}), undefined);
    const call = JSON.parse(
      readFileSync(resolve(root, "production-check-call.json"), "utf8"),
    );
    assert.deepEqual(
      {phase: call.phase, output: call.output},
      {phase: "release", output: resolve(root, "build")},
    );
    assert.equal(existsSync(call.transactionRoot), false);
    assert.equal(existsSync(resolve(root, ".axial-muse-build.lock")), false);
    assert.equal(
      readFileSync(
        resolve(root, ".axial-muse-build-retired/identity.txt"),
        "utf8",
      ),
      "retired\n",
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("#33 production artifact checker 拒绝退出 0 但未生成输入 seal 的空操作", () => {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-production-check-no-seal-"));
  try {
    writeFixture(root, ".nvmrc", readFileSync(resolve(PROJECT_ROOT, ".nvmrc")));
    writeFixture(
      root,
      "package.json",
      readFileSync(resolve(PROJECT_ROOT, "package.json")),
    );
    mkdirSync(resolve(root, "site-content/writing"), {recursive: true});
    writeFixture(root, "build/index.html", "<!doctype html>\n");
    writeFixture(
      root,
      "node_modules/@docusaurus/core/bin/docusaurus.mjs",
      [
        "import {writeFileSync} from \"node:fs\";",
        "if (process.argv.slice(2).join(\" \") !== \"axial-muse:check-production\") process.exit(9);",
        "writeFileSync(\"production-check-call.json\", JSON.stringify({",
        "  transactionRoot: process.env.AXIAL_MUSE_BUILD_TRANSACTION_ROOT,",
        "}));",
      ].join("\n"),
    );

    assert.throws(
      () => runProductionArtifactCheck({root}),
      hasBuildCode("BUILD_ARTIFACT_CHECK_SEAL"),
    );
    const call = JSON.parse(
      readFileSync(resolve(root, "production-check-call.json"), "utf8"),
    );
    assert.equal(existsSync(call.transactionRoot), false);
    assert.equal(existsSync(resolve(root, ".axial-muse-build.lock")), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("#33 production artifact checker 拒绝不属于当前 owner 的输入 seal", () => {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-production-check-wrong-seal-"));
  try {
    writeFixture(root, ".nvmrc", readFileSync(resolve(PROJECT_ROOT, ".nvmrc")));
    writeFixture(
      root,
      "package.json",
      readFileSync(resolve(PROJECT_ROOT, "package.json")),
    );
    mkdirSync(resolve(root, "site-content/writing"), {recursive: true});
    writeFixture(root, "build/index.html", "<!doctype html>\n");
    writeFixture(
      root,
      "node_modules/@docusaurus/core/bin/docusaurus.mjs",
      [
        "import {writeFileSync} from \"node:fs\";",
        "import {resolve} from \"node:path\";",
        "if (process.argv.slice(2).join(\" \") !== \"axial-muse:check-production\") process.exit(9);",
        "const transactionRoot = process.env.AXIAL_MUSE_BUILD_TRANSACTION_ROOT;",
        "writeFileSync(resolve(transactionRoot, \".axial-muse-content-input-seal\"), [",
        "  \"axial-muse-content-input-v1\",",
        "  \"owner:not-current-owner\",",
        "  \"sha256:\" + \"f\".repeat(64),",
        "  \"\",",
        "].join(\"\\n\"), {encoding: \"utf8\", flag: \"wx\", mode: 0o600});",
      ].join("\n"),
    );

    assert.throws(
      () => runProductionArtifactCheck({root}),
      hasBuildCode("BUILD_ARTIFACT_CHECK_SEAL"),
    );
    assert.equal(existsSync(resolve(root, ".axial-muse-build.lock")), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("E-016 候选路径由仓库根与本次 owner 唯一决定", () => {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-build-output-"));
  const owner = "a".repeat(64);
  try {
    assert.equal(
      candidateOutputPath(root, owner),
      resolve(root, `.axial-muse-build-candidate-${owner}`),
    );
    assert.throws(
      () => candidateOutputPath(root, "not-an-owner"),
      hasBuildCode("BUILD_OWNER"),
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("E-016 三阶段通过后切换 build、固定保留 retired 且提交后无临时路径", () => {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-build-publish-"));
  const owner = "b".repeat(64);
  const candidate = candidateOutputPath(root, owner);
  try {
    writeFixture(root, "build/identity.txt", "old\n");
    const transaction = beginBuildTransaction({root, owner});
    writeFixture(candidate, "identity.txt", "new\n");
    const evidence = captureCandidateBuildEvidence(transaction);
    let verifyCalls = 0;
    publishCandidateBuild({
      transaction,
      expectedCandidateEvidence: evidence,
      verifyActivatedBuild() {
        verifyCalls += 1;
        assert.equal(readFileSync(resolve(root, "build/identity.txt"), "utf8"), "new\n");
      },
    });
    assert.equal(verifyCalls, 1);
    assert.equal(readFileSync(resolve(root, "build/identity.txt"), "utf8"), "new\n");
    assert.equal(
      readFileSync(resolve(root, ".axial-muse-build-retired/identity.txt"), "utf8"),
      "old\n",
    );
    assert.equal(existsSync(candidate), false);
    assert.equal(
      existsSync(resolve(root, `.axial-muse-build-backup-${owner}`)),
      false,
    );
    assert.equal(existsSync(resolve(root, ".axial-muse-build.lock")), false);
    assert.equal(existsSync(transaction.transactionRoot), false);

    const next = beginBuildTransaction({root, owner: "d".repeat(64)});
    assert.equal(existsSync(resolve(root, ".axial-muse-build-retired")), false);
    abortBuildTransaction(next);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("E-016 发布锁排除并发事务且失败尝试不触碰当前 build", () => {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-build-conflict-"));
  const firstOwner = "c".repeat(64);
  try {
    writeFixture(root, "build/identity.txt", "old\n");
    const first = beginBuildTransaction({root, owner: firstOwner});
    assert.throws(
      () => beginBuildTransaction({root, owner: "e".repeat(64)}),
      hasBuildCode("BUILD_LOCKED"),
    );
    assert.equal(readFileSync(resolve(root, "build/identity.txt"), "utf8"), "old\n");
    abortBuildTransaction(first);
    assert.equal(existsSync(resolve(root, ".axial-muse-build.lock")), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("E-016 第二次 rename 前失败会恢复旧 build 并把失败候选移入 retired", () => {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-build-second-rename-"));
  const owner = "f".repeat(64);
  try {
    writeFixture(root, "build/identity.txt", "old\n");
    const transaction = beginBuildTransaction({
      root,
      owner,
      testHooks: {
        beforeCandidateActivation() {
          throw new Error("fixture second rename failure");
        },
      },
    });
    writeFixture(transaction.candidatePath, "identity.txt", "new\n");
    const evidence = captureCandidateBuildEvidence(transaction);
    assert.throws(
      () => publishCandidateBuild({
        transaction,
        expectedCandidateEvidence: evidence,
        verifyActivatedBuild() {},
      }),
      hasBuildCode("BUILD_PUBLISH"),
    );
    assert.equal(readFileSync(resolve(root, "build/identity.txt"), "utf8"), "old\n");
    assert.equal(
      readFileSync(resolve(root, ".axial-muse-build-retired/identity.txt"), "utf8"),
      "new\n",
    );
    assert.equal(existsSync(transaction.candidatePath), false);
    assert.equal(existsSync(resolve(root, `.axial-muse-build-backup-${owner}`)), false);
    assert.equal(existsSync(resolve(root, ".axial-muse-build.lock")), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("E-016 candidate 激活后即使只改同一路径正文 bytes 也会回滚", () => {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-build-mutation-"));
  const owner = "1".repeat(64);
  let verifyCalls = 0;
  try {
    writeFixture(root, "build/identity.txt", "old\n");
    const transaction = beginBuildTransaction({
      root,
      owner,
      testHooks: {
        afterCandidateActivation() {
          writeFileSync(resolve(root, "build/identity.txt"), "tampered-body\n", "utf8");
        },
      },
    });
    writeFixture(transaction.candidatePath, "identity.txt", "new-body\n");
    const evidence = captureCandidateBuildEvidence(transaction);
    assert.throws(
      () => publishCandidateBuild({
        transaction,
        expectedCandidateEvidence: evidence,
        verifyActivatedBuild() {
          verifyCalls += 1;
        },
      }),
      hasBuildCode("BUILD_CANDIDATE_CHANGED"),
    );
    assert.equal(verifyCalls, 0);
    assert.equal(readFileSync(resolve(root, "build/identity.txt"), "utf8"), "old\n");
    assert.equal(
      readFileSync(resolve(root, ".axial-muse-build-retired/identity.txt"), "utf8"),
      "tampered-body\n",
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("E-016 post-switch fresh checker 失败会恢复旧 build", () => {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-build-post-check-"));
  const owner = "2".repeat(64);
  try {
    writeFixture(root, "build/identity.txt", "old\n");
    const transaction = beginBuildTransaction({root, owner});
    writeFixture(transaction.candidatePath, "identity.txt", "new\n");
    const evidence = captureCandidateBuildEvidence(transaction);
    assert.throws(
      () => publishCandidateBuild({
        transaction,
        expectedCandidateEvidence: evidence,
        verifyActivatedBuild() {
          throw new BuildSiteError("FIXTURE_POST_CHECK", "fixture checker failure");
        },
      }),
      hasBuildCode("FIXTURE_POST_CHECK"),
    );
    assert.equal(readFileSync(resolve(root, "build/identity.txt"), "utf8"), "old\n");
    assert.equal(
      readFileSync(resolve(root, ".axial-muse-build-retired/identity.txt"), "utf8"),
      "new\n",
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("E-016 retired 回收失败发生在任何 current/candidate 改动之前", () => {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-build-retired-failure-"));
  const owner = "3".repeat(64);
  try {
    writeFixture(root, "build/identity.txt", "old\n");
    writeFixture(root, ".axial-muse-build-retired/identity.txt", "previous\n");
    assert.throws(
      () => beginBuildTransaction({
        root,
        owner,
        testHooks: {
          beforeRetiredReclaim() {
            throw new Error("fixture reclaim failure");
          },
        },
      }),
      hasBuildCode("BUILD_RETIRED_RECLAIM"),
    );
    assert.equal(readFileSync(resolve(root, "build/identity.txt"), "utf8"), "old\n");
    assert.equal(
      readFileSync(resolve(root, ".axial-muse-build-retired/identity.txt"), "utf8"),
      "previous\n",
    );
    assert.equal(existsSync(resolve(root, ".axial-muse-build.lock")), false);
    assert.equal(existsSync(candidateOutputPath(root, owner)), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("E-016 commit lock 释放失败仍在锁内回滚并隔离新候选", () => {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-build-lock-release-"));
  const owner = "4".repeat(64);
  let releaseCalls = 0;
  try {
    writeFixture(root, "build/identity.txt", "old\n");
    const transaction = beginBuildTransaction({
      root,
      owner,
      testHooks: {
        beforeLockRelease() {
          releaseCalls += 1;
          throw new Error("fixture release failure");
        },
      },
    });
    writeFixture(transaction.candidatePath, "identity.txt", "new\n");
    const evidence = captureCandidateBuildEvidence(transaction);
    assert.throws(
      () => publishCandidateBuild({
        transaction,
        expectedCandidateEvidence: evidence,
        verifyActivatedBuild() {},
      }),
      hasBuildCode("BUILD_PUBLISH"),
    );
    assert.equal(releaseCalls, 1);
    assert.equal(readFileSync(resolve(root, "build/identity.txt"), "utf8"), "old\n");
    assert.equal(
      readFileSync(resolve(root, ".axial-muse-build-retired/identity.txt"), "utf8"),
      "new\n",
    );
    assert.equal(existsSync(resolve(root, ".axial-muse-build.lock")), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("E-016 commit fault hook 修改 active build 会在解锁前被发现并回滚", () => {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-build-final-evidence-"));
  const owner = "5".repeat(64);
  try {
    writeFixture(root, "build/identity.txt", "old\n");
    const transaction = beginBuildTransaction({
      root,
      owner,
      testHooks: {
        beforeLockRelease() {
          writeFileSync(
            resolve(root, "build/identity.txt"),
            "tampered-after-check\n",
            "utf8",
          );
        },
      },
    });
    writeFixture(transaction.candidatePath, "identity.txt", "checked\n");
    const evidence = captureCandidateBuildEvidence(transaction);
    assert.throws(
      () => publishCandidateBuild({
        transaction,
        expectedCandidateEvidence: evidence,
        verifyActivatedBuild() {},
      }),
      hasBuildCode("BUILD_CANDIDATE_CHANGED"),
    );
    assert.equal(readFileSync(resolve(root, "build/identity.txt"), "utf8"), "old\n");
    assert.equal(
      readFileSync(resolve(root, ".axial-muse-build-retired/identity.txt"), "utf8"),
      "tampered-after-check\n",
    );
    assert.equal(existsSync(resolve(root, ".axial-muse-build.lock")), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

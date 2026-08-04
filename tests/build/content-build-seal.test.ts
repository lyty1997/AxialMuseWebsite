import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import test from "node:test";
import {
  combineContentBuildInputDigests,
  createContentBuildSealController,
} from "../../src/build/content/build-seal.js";
import {ContentBuildError} from "../../src/build/content/errors.js";

const OWNER = "a".repeat(64);
const DIGEST = "b".repeat(64);
const OTHER_DIGEST = "c".repeat(64);

function assertContentCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => (
    error instanceof ContentBuildError && error.code === code
  );
}

function createFixture(): Readonly<{
  repositoryRoot: string;
  transactionRoot: string;
  environment: NodeJS.ProcessEnv;
}> {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "axial-muse-seal-repository-"));
  const transactionRoot = mkdtempSync(join(tmpdir(), "axial-muse-build-transaction-"));
  chmodSync(repositoryRoot, 0o700);
  chmodSync(transactionRoot, 0o700);
  writeFileSync(resolve(repositoryRoot, ".axial-muse-build.lock"), `${OWNER}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(resolve(repositoryRoot, ".axial-muse-build.lock"), 0o600);
  writeFileSync(
    resolve(transactionRoot, ".axial-muse-build-transaction-owner"),
    `production:${OWNER}\n`,
    {encoding: "utf8", mode: 0o600},
  );
  chmodSync(
    resolve(transactionRoot, ".axial-muse-build-transaction-owner"),
    0o600,
  );
  return Object.freeze({
    repositoryRoot,
    transactionRoot,
    environment: {
      AXIAL_MUSE_BUILD_TRANSACTION_ROOT: transactionRoot,
    },
  });
}

test("E-016 完整输入摘要以具名域和顺序绑定 content/static 两个摘要", () => {
  const combined = combineContentBuildInputDigests(DIGEST, OTHER_DIGEST);
  assert.match(combined, /^[0-9a-f]{64}$/u);
  assert.equal(
    combineContentBuildInputDigests(DIGEST, OTHER_DIGEST),
    combined,
  );
  assert.notEqual(
    combineContentBuildInputDigests(OTHER_DIGEST, DIGEST),
    combined,
  );
  assert.throws(
    () => combineContentBuildInputDigests("invalid", OTHER_DIGEST),
    assertContentCode("CONTENT_INPUT_DIGEST"),
  );
});

test("E-016 build postBuild 唯一写入 owner-bound 完整输入 seal，check/verify 逐次断言", () => {
  const fixture = createFixture();
  let currentnessChecks = 0;
  try {
    const build = createContentBuildSealController({
      repositoryRoot: fixture.repositoryRoot,
      mode: "production",
      owner: OWNER,
      phase: "build",
      inputDigest: DIGEST,
      environment: fixture.environment,
      assertInputsCurrent() {
        currentnessChecks += 1;
      },
    });
    build.write();
    assert.equal(currentnessChecks, 1);
    assert.equal(
      readFileSync(
        resolve(fixture.transactionRoot, ".axial-muse-content-input-seal"),
        "utf8",
      ),
      [
        "axial-muse-content-input-v1",
        `owner:${OWNER}`,
        `sha256:${DIGEST}`,
        "",
      ].join("\n"),
    );
    assert.throws(() => build.write(), assertContentCode("CONTENT_SESSION_TRANSACTION"));

    for (const phase of ["check", "verify"] as const) {
      const checker = createContentBuildSealController({
        repositoryRoot: fixture.repositoryRoot,
        mode: "production",
        owner: OWNER,
        phase,
        inputDigest: DIGEST,
        environment: fixture.environment,
        assertInputsCurrent() {
          currentnessChecks += 1;
        },
      });
      checker.assert();
    }
    assert.equal(currentnessChecks, 4);
  } finally {
    rmSync(fixture.repositoryRoot, {recursive: true, force: true});
    rmSync(fixture.transactionRoot, {recursive: true, force: true});
  }
});

test("#33 release 验证事务建立临时 seal 并拒绝同字节换 inode", () => {
  const fixture = createFixture();
  let currentnessChecks = 0;
  try {
    const release = createContentBuildSealController({
      repositoryRoot: fixture.repositoryRoot,
      mode: "production",
      owner: OWNER,
      phase: "release",
      inputDigest: DIGEST,
      environment: fixture.environment,
      assertInputsCurrent() {
        currentnessChecks += 1;
      },
    });
    release.write();
    release.assert();
    assert.equal(currentnessChecks, 2);

    const sealPath = resolve(
      fixture.transactionRoot,
      ".axial-muse-content-input-seal",
    );
    const originalBytes = readFileSync(sealPath);
    renameSync(
      sealPath,
      resolve(fixture.repositoryRoot, "original-input-seal"),
    );
    writeFileSync(sealPath, originalBytes, {mode: 0o600});
    chmodSync(sealPath, 0o600);
    assert.throws(
      () => release.assert(),
      assertContentCode("CONTENT_SESSION_TRANSACTION_IDENTITY"),
    );
  } finally {
    rmSync(fixture.repositoryRoot, {recursive: true, force: true});
    rmSync(fixture.transactionRoot, {recursive: true, force: true});
  }
});

test("E-016 build/check 间只变更正文 bytes 导致完整 input digest seal 失败关闭", () => {
  const fixture = createFixture();
  try {
    createContentBuildSealController({
      repositoryRoot: fixture.repositoryRoot,
      mode: "production",
      owner: OWNER,
      phase: "build",
      inputDigest: DIGEST,
      environment: fixture.environment,
      assertInputsCurrent() {},
    }).write();
    const changedBody = createContentBuildSealController({
      repositoryRoot: fixture.repositoryRoot,
      mode: "production",
      owner: OWNER,
      phase: "check",
      inputDigest: OTHER_DIGEST,
      environment: fixture.environment,
      assertInputsCurrent() {},
    });
    assert.throws(
      () => changedBody.assert(),
      assertContentCode("CONTENT_INPUT_SEAL"),
    );
  } finally {
    rmSync(fixture.repositoryRoot, {recursive: true, force: true});
    rmSync(fixture.transactionRoot, {recursive: true, force: true});
  }
});

test("E-016 seal 每次使用前重验 lock、权限和私有根精确成员集合", () => {
  const fixture = createFixture();
  try {
    createContentBuildSealController({
      repositoryRoot: fixture.repositoryRoot,
      mode: "production",
      owner: OWNER,
      phase: "build",
      inputDigest: DIGEST,
      environment: fixture.environment,
      assertInputsCurrent() {},
    }).write();
    const checker = createContentBuildSealController({
      repositoryRoot: fixture.repositoryRoot,
      mode: "production",
      owner: OWNER,
      phase: "check",
      inputDigest: DIGEST,
      environment: fixture.environment,
      assertInputsCurrent() {},
    });
    writeFileSync(resolve(fixture.transactionRoot, "unexpected"), "forged\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    assert.throws(
      () => checker.assert(),
      assertContentCode("CONTENT_SESSION_TRANSACTION"),
    );
    rmSync(resolve(fixture.transactionRoot, "unexpected"));
    const lockPath = resolve(fixture.repositoryRoot, ".axial-muse-build.lock");
    renameSync(lockPath, resolve(fixture.repositoryRoot, ".replaced-build-lock"));
    writeFileSync(lockPath, `${OWNER}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    assert.throws(
      () => checker.assert(),
      assertContentCode("CONTENT_SESSION_LOCK_IDENTITY"),
    );
  } finally {
    rmSync(fixture.repositoryRoot, {recursive: true, force: true});
    rmSync(fixture.transactionRoot, {recursive: true, force: true});
  }
});

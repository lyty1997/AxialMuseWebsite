import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {once} from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import test from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {
  captureFrozenInstalledTreeEvidence,
  parsePreviewDependencyArguments,
  PreviewDependencyError,
} from "../../scripts/dev/preview-dependencies.mjs";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const PREVIEW_SCRIPT = resolve(PROJECT_ROOT, "scripts/dev/preview.sh");

function hasDependencyCode(code) {
  return (error) => error instanceof PreviewDependencyError && error.code === code;
}

function runCommand(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    ...options,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commitFixture(repoRoot, message, contents) {
  writeFileSync(resolve(repoRoot, "fixture.txt"), `${contents}\n`, {mode: 0o600});
  runCommand("git", ["-C", repoRoot, "add", "fixture.txt"]);
  runCommand("git", [
    "-C",
    repoRoot,
    "-c",
    "user.name=Preview Test",
    "-c",
    "user.email=preview-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
  return runCommand("git", ["-C", repoRoot, "rev-parse", "HEAD"]);
}

function createGitFixture(fixtureRoot) {
  const repoRoot = resolve(fixtureRoot, "repo");
  const originRoot = resolve(fixtureRoot, "origin.git");
  mkdirSync(repoRoot, {mode: 0o700});
  runCommand("git", ["-C", repoRoot, "init", "--quiet"]);
  const firstSha = commitFixture(repoRoot, "fixture one", "one");
  runCommand("git", ["-C", repoRoot, "branch", "preview-one"]);
  const secondSha = commitFixture(repoRoot, "fixture two", "two");
  runCommand("git", ["-C", repoRoot, "branch", "preview-two"]);
  const thirdSha = commitFixture(repoRoot, "fixture three", "three");
  runCommand("git", ["-C", repoRoot, "branch", "preview-three"]);
  runCommand("git", ["clone", "--bare", "--quiet", repoRoot, originRoot]);
  runCommand("git", ["-C", repoRoot, "remote", "add", "origin", originRoot]);
  return Object.freeze({firstSha, originRoot, repoRoot, secondSha, thirdSha});
}

function writeExecutable(path, source) {
  writeFileSync(path, `${source}\n`, {mode: 0o700});
  chmodSync(path, 0o700);
}

function createPreviewCommandFixtures(fixtureRoot) {
  const binRoot = resolve(fixtureRoot, "bin");
  mkdirSync(binRoot, {mode: 0o700});
  writeExecutable(resolve(binRoot, "node"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'case "${1:-}" in',
    "  */scripts/dev/preview-dependencies.mjs)",
    '    [ "${2:-}" = "verify" ]',
    "    exit 0",
    "    ;;",
    "  */scripts/build/build-site.mjs)",
    '    if [ -n "${PREVIEW_TEST_FAIL_SHA:-}" ] \\',
    '      && [ "${PREVIEW_TEST_FAIL_SHA}" = "${AXIAL_MUSE_PREVIEW_COMMIT_SHA:-}" ]; then',
    '      echo "[TEST_BUILD_FAILED] injected preview build failure" >&2',
    "      exit 1",
    "    fi",
    '    mkdir -m 700 -- "${AXIAL_MUSE_PREVIEW_CANDIDATE}"',
    '    printf \'<!doctype html><meta name="robots" content="noindex,nofollow"><p>%s</p>\\n\' \\',
    '      "${AXIAL_MUSE_PREVIEW_COMMIT_SHA}" \\',
    '      > "${AXIAL_MUSE_PREVIEW_CANDIDATE}/index.html"',
    '    chmod 600 -- "${AXIAL_MUSE_PREVIEW_CANDIDATE}/index.html"',
    "    exit 0",
    "    ;;",
    "esac",
    'exec "${PREVIEW_TEST_REAL_NODE:?}" "$@"',
  ].join("\n"));
  writeExecutable(resolve(binRoot, "python3"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'if [ "${1:-}" = "-c" ] && [ "${PREVIEW_TEST_SMOKE_FAIL:-false}" = "true" ]; then',
    "  exit 1",
    "fi",
    'exec "${PREVIEW_TEST_REAL_PYTHON3:?}" "$@"',
  ].join("\n"));
  writeExecutable(resolve(binRoot, "ss"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "for process_root in /proc/[0-9]*; do",
    '  pid="${process_root#/proc/}"',
    '  [ "$(readlink -- "${process_root}/cwd" 2>/dev/null || true)" = "${PREVIEW_STATE_DIR}" ] \\',
    "    || continue",
    '  arguments="$(tr \'\\0\' \'\\n\' < "${process_root}/cmdline" 2>/dev/null || true)"',
    '  grep -Fxq -- "http.server" <<<"${arguments}" || continue',
    '  grep -Fxq -- "current" <<<"${arguments}" || continue',
    '  grep -Fxq -- "${PREVIEW_PORT}" <<<"${arguments}" || continue',
    '  exec 8<>"/dev/tcp/127.0.0.1/${PREVIEW_PORT}" 2>/dev/null || continue',
    "  exec 8>&-",
    '  printf \'LISTEN 0 5 0.0.0.0:%s 0.0.0.0:* users:(("python3",pid=%s,fd=3))\\n\' \\',
    '    "${PREVIEW_PORT}" "${pid}"',
    "  exit 0",
    "done",
  ].join("\n"));
  return binRoot;
}

async function unusedLocalPort() {
  const server = createServer();
  server.unref();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const port = address.port;
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise());
  });
  return port;
}

function previewEnvironment({
  binRoot,
  port,
  runtimeTemporaryRoot,
  stateRoot,
  overrides = {},
}) {
  return {
    ...process.env,
    PATH: `${binRoot}:${process.env.PATH}`,
    PREVIEW_HOST: "127.0.0.1",
    PREVIEW_PORT: String(port),
    PREVIEW_STATE_DIR: stateRoot,
    PREVIEW_TEST_FAIL_SHA: "",
    PREVIEW_TEST_REAL_NODE: process.execPath,
    PREVIEW_TEST_REAL_PYTHON3: runCommand("which", ["python3"]),
    PREVIEW_TEST_SMOKE_FAIL: "false",
    TMPDIR: runtimeTemporaryRoot,
    ...overrides,
  };
}

function runPreview(repoRoot, environment, ...arguments_) {
  return spawnSync("bash", [PREVIEW_SCRIPT, ...arguments_], {
    cwd: repoRoot,
    encoding: "utf8",
    env: environment,
    timeout: 30_000,
  });
}

function assertPreviewSuccess(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
}

function assertPreviewFailure(result, code) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`\\[${code}\\]`, "u"));
}

function readStateValue(stateRoot, name) {
  return readFileSync(resolve(stateRoot, "run", name), "utf8").trim();
}

function activeSha(stateRoot) {
  const target = readlinkSync(resolve(stateRoot, "current"));
  const match = /^releases\/([0-9a-f]{40})$/u.exec(target);
  assert.notEqual(match, null);
  return match[1];
}

function terminateFixtureServer(stateRoot) {
  const pidPath = resolve(stateRoot, "run", "server.pid");
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function makeFixtureTreeRemovable(path) {
  if (!existsSync(path)) return;
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) return;
  if (!metadata.isDirectory()) {
    chmodSync(path, 0o600);
    return;
  }
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) {
    makeFixtureTreeRemovable(resolve(path, name));
  }
}

async function waitForPath(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for fixture path: ${path}`);
}

test("E-009 preview 冻结依赖命令只接受 prepare/verify", () => {
  assert.deepEqual(parsePreviewDependencyArguments(["prepare"]), {command: "prepare"});
  assert.deepEqual(parsePreviewDependencyArguments(["verify"]), {command: "verify"});
  assert.throws(
    () => parsePreviewDependencyArguments([]),
    hasDependencyCode("PREVIEW_DEPENDENCY_ARGUMENTS"),
  );
  assert.throws(
    () => parsePreviewDependencyArguments(["verify", "extra"]),
    hasDependencyCode("PREVIEW_DEPENDENCY_ARGUMENTS"),
  );
});

test("E-009 preview.sh 通过 Bash 静态语法检查", {
  skip: process.platform !== "linux",
}, () => {
  const result = spawnSync("bash", ["-n", PREVIEW_SCRIPT], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
});

test("E-009 自包含安装树可形成逐字节冻结证据并识别漂移", {
  skip: process.platform !== "linux",
}, () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "axial-muse-preview-tree-"));
  const nodeModulesRoot = resolve(fixtureRoot, "node_modules");
  const packageRoot = resolve(nodeModulesRoot, "demo");
  const binRoot = resolve(nodeModulesRoot, ".bin");
  const executablePath = resolve(packageRoot, "cli.mjs");
  try {
    mkdirSync(packageRoot, {mode: 0o700, recursive: true});
    mkdirSync(binRoot, {mode: 0o700});
    writeFileSync(executablePath, "export default 'before';\n", {mode: 0o600});
    symlinkSync("../demo/cli.mjs", resolve(binRoot, "demo"));

    const before = captureFrozenInstalledTreeEvidence(nodeModulesRoot);
    assert.equal(before.treeEntryCount, 4);
    assert.match(before.treeSha256, /^[0-9a-f]{64}$/u);
    assert.equal(Object.isFrozen(before), true);

    writeFileSync(executablePath, "export default 'after';\n", {mode: 0o600});
    const after = captureFrozenInstalledTreeEvidence(nodeModulesRoot);
    assert.equal(after.treeEntryCount, before.treeEntryCount);
    assert.notEqual(after.treeSha256, before.treeSha256);
  } finally {
    rmSync(fixtureRoot, {recursive: true, force: true});
  }
});

test("E-009 preview 控制器保持服务 PID 并在构建、冒烟与锁失败时保留活动 release", {
  skip: process.platform !== "linux",
  timeout: 45_000,
}, async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "axial-muse-preview-controller-"));
  const runtimeTemporaryRoot = resolve(fixtureRoot, "runtime-tmp");
  const mainStateRoot = resolve(fixtureRoot, "state-main");
  const firstBuildFailureRoot = resolve(fixtureRoot, "state-first-build-failure");
  const firstSmokeFailureRoot = resolve(fixtureRoot, "state-first-smoke-failure");
  const stateRoots = [
    mainStateRoot,
    firstBuildFailureRoot,
    firstSmokeFailureRoot,
  ];
  let lockHolder;
  let lockHoldPath;
  try {
    mkdirSync(runtimeTemporaryRoot, {mode: 0o700});
    const gitFixture = createGitFixture(fixtureRoot);
    const binRoot = createPreviewCommandFixtures(fixtureRoot);
    const mainEnvironment = previewEnvironment({
      binRoot,
      port: await unusedLocalPort(),
      runtimeTemporaryRoot,
      stateRoot: mainStateRoot,
    });

    const firstServe = runPreview(
      gitFixture.repoRoot,
      mainEnvironment,
      "serve",
      "preview-one",
    );
    assertPreviewSuccess(firstServe);
    assert.equal(activeSha(mainStateRoot), gitFixture.firstSha);
    const stablePid = readStateValue(mainStateRoot, "server.pid");

    const restart = runPreview(
      gitFixture.repoRoot,
      mainEnvironment,
      "restart",
      "preview-two",
    );
    assertPreviewSuccess(restart);
    assert.equal(activeSha(mainStateRoot), gitFixture.secondSha);
    assert.equal(readStateValue(mainStateRoot, "server.pid"), stablePid);

    const buildFailure = runPreview(
      gitFixture.repoRoot,
      {
        ...mainEnvironment,
        PREVIEW_TEST_FAIL_SHA: gitFixture.firstSha,
      },
      "restart",
      "preview-one",
    );
    assertPreviewFailure(buildFailure, "PREVIEW_BUILD");
    assert.equal(activeSha(mainStateRoot), gitFixture.secondSha);
    assert.equal(readStateValue(mainStateRoot, "server.pid"), stablePid);

    const smokeFailure = runPreview(
      gitFixture.repoRoot,
      {
        ...mainEnvironment,
        PREVIEW_TEST_SMOKE_FAIL: "true",
      },
      "restart",
      "preview-three",
    );
    assertPreviewFailure(smokeFailure, "PREVIEW_SMOKE");
    assert.equal(activeSha(mainStateRoot), gitFixture.secondSha);
    assert.equal(readStateValue(mainStateRoot, "server.pid"), stablePid);

    const lockFile = resolve(mainStateRoot, "run", "preview.lock");
    const lockReadyPath = resolve(fixtureRoot, "lock-ready");
    lockHoldPath = resolve(fixtureRoot, "lock-hold");
    writeFileSync(lockHoldPath, "hold\n", {mode: 0o600});
    lockHolder = spawn("flock", [
      "-n",
      lockFile,
      "bash",
      "-c",
      'touch "$1"; while [ -e "$2" ]; do sleep 0.05; done',
      "preview-lock-holder",
      lockReadyPath,
      lockHoldPath,
    ], {
      cwd: gitFixture.repoRoot,
      env: mainEnvironment,
      stdio: "ignore",
    });
    await waitForPath(lockReadyPath);
    const lockFailure = runPreview(
      gitFixture.repoRoot,
      mainEnvironment,
      "restart",
      "preview-one",
    );
    assertPreviewFailure(lockFailure, "PREVIEW_LOCKED");
    assert.equal(activeSha(mainStateRoot), gitFixture.secondSha);
    assert.equal(readStateValue(mainStateRoot, "server.pid"), stablePid);
    const lockExit = once(lockHolder, "exit");
    unlinkSync(lockHoldPath);
    lockHoldPath = undefined;
    const [lockStatus] = await lockExit;
    assert.equal(lockStatus, 0);
    lockHolder = undefined;

    const firstBuildFailureEnvironment = previewEnvironment({
      binRoot,
      port: await unusedLocalPort(),
      runtimeTemporaryRoot,
      stateRoot: firstBuildFailureRoot,
      overrides: {PREVIEW_TEST_FAIL_SHA: gitFixture.firstSha},
    });
    const firstBuildFailure = runPreview(
      gitFixture.repoRoot,
      firstBuildFailureEnvironment,
      "serve",
      "preview-one",
    );
    assertPreviewFailure(firstBuildFailure, "PREVIEW_BUILD");
    assert.equal(existsSync(resolve(firstBuildFailureRoot, "current")), false);
    assert.equal(
      existsSync(resolve(firstBuildFailureRoot, "run", "server.pid")),
      false,
    );

    const firstSmokeFailureEnvironment = previewEnvironment({
      binRoot,
      port: await unusedLocalPort(),
      runtimeTemporaryRoot,
      stateRoot: firstSmokeFailureRoot,
      overrides: {PREVIEW_TEST_SMOKE_FAIL: "true"},
    });
    const firstSmokeFailure = runPreview(
      gitFixture.repoRoot,
      firstSmokeFailureEnvironment,
      "serve",
      "preview-one",
    );
    assertPreviewFailure(firstSmokeFailure, "PREVIEW_SMOKE");
    assert.equal(existsSync(resolve(firstSmokeFailureRoot, "current")), false);
    assert.equal(
      existsSync(resolve(firstSmokeFailureRoot, "run", "server.pid")),
      false,
    );

    const stop = runPreview(gitFixture.repoRoot, mainEnvironment, "stop");
    assertPreviewSuccess(stop);
    assert.equal(existsSync(resolve(mainStateRoot, "run", "server.pid")), false);
  } finally {
    if (lockHoldPath && existsSync(lockHoldPath)) unlinkSync(lockHoldPath);
    if (lockHolder && lockHolder.exitCode === null) {
      const lockExit = once(lockHolder, "exit");
      lockHolder.kill("SIGTERM");
      await lockExit.catch(() => {});
    }
    for (const stateRoot of stateRoots) terminateFixtureServer(stateRoot);
    await delay(100);
    makeFixtureTreeRemovable(fixtureRoot);
    rmSync(fixtureRoot, {recursive: true, force: true});
  }
});

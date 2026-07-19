import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  readAndValidateManifest,
  validateRuntimeContract,
} from "./config.mjs";
import { NPM_VERSIONS_BY_ROLE } from "./contracts.mjs";
import { deriveNpmCli } from "./environment.mjs";
import { fail, NpmIsolationError } from "./errors.mjs";
import {
  buildExpectedSpdxGraph,
  hashProjectFile,
  readAndValidateLockfile,
} from "./lockfile.mjs";
import { runIsolatedNpm } from "./runner.mjs";
import {
  normalizeNpmSpdx,
  parseSpdxJson,
  validateCanonicalSpdxArtifacts,
  validateCreatedAt,
} from "./spdx.mjs";

export const SPDX_ARTIFACT_FILES = Object.freeze([
  "dependency-evidence.json",
  "sbom.spdx.json",
]);

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertDirectory(path, code) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(code, "供应链 artifact 目录不可读。" );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(code, "供应链 artifact 路径必须是普通目录。" );
  }
}

function readRegularArtifact(path, code) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(code, "供应链 artifact 文件不可读。" );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail(code, "供应链 artifact 必须是单链接普通文件。" );
  }
  return readFileSync(path, "utf8");
}

function readArtifactSnapshot(artifactDirectory) {
  if (!existsSync(artifactDirectory)) return null;
  assertDirectory(artifactDirectory, "SPDX_EVIDENCE_INVALID");
  const entries = readdirSync(artifactDirectory).sort();
  if (entries.join("\n") !== [...SPDX_ARTIFACT_FILES].sort().join("\n")) {
    fail("SPDX_EVIDENCE_INVALID", "供应链 artifact 目录文件集合不完整。" );
  }
  return {
    evidenceBytes: readRegularArtifact(
      join(artifactDirectory, "dependency-evidence.json"),
      "SPDX_EVIDENCE_INVALID",
    ),
    sbomBytes: readRegularArtifact(
      join(artifactDirectory, "sbom.spdx.json"),
      "SPDX_EVIDENCE_INVALID",
    ),
  };
}

function snapshotsEqual(left, right) {
  if (left === null || right === null) return left === right;
  return left.evidenceBytes === right.evidenceBytes && left.sbomBytes === right.sbomBytes;
}

function hashGenerationInputs(root) {
  return {
    lockfile: hashProjectFile(root, "package-lock.json"),
    manifest: hashProjectFile(root, "package.json"),
    npmrc: hashProjectFile(root, ".npmrc"),
    nvmrc: hashProjectFile(root, ".nvmrc"),
  };
}

function assertGenerationInputsUnchanged(root, expected) {
  let actual;
  try {
    actual = hashGenerationInputs(root);
  } catch {
    fail("SPDX_INPUT_CONCURRENT_CHANGE", "SPDX 生成输入在执行期间变得不可读。" );
  }
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      fail("SPDX_INPUT_CONCURRENT_CHANGE", "SPDX 生成输入在执行期间发生变化。" );
    }
  }
}

function acquireGenerationLock(parent, artifactDirectory) {
  const lockPath = join(parent, `.${basename(artifactDirectory)}.generation.lock`);
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch {
    fail("SPDX_GENERATION_LOCKED", "已有供应链 artifact 生成任务持有排他锁。" );
  }
  return { descriptor, lockPath };
}

function releaseGenerationLock(lock) {
  try {
    closeSync(lock.descriptor);
    unlinkSync(lock.lockPath);
  } catch {
    fail("SPDX_GENERATION_LOCK_CLEANUP", "供应链 artifact 生成锁无法清理。" );
  }
}

function writeCandidateFile(path, text, syncFile) {
  const descriptor = openSync(path, "wx", 0o644);
  try {
    writeFileSync(descriptor, text, "utf8");
    syncFile(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function publishSpdxArtifacts({
  artifactDirectory,
  result,
  expectedPrevious,
  afterBackup = null,
  afterActivate = null,
  syncCandidateDirectory = fsyncDirectory,
  syncFile = fsyncSync,
  syncParentDirectory = fsyncDirectory,
}) {
  const parent = dirname(artifactDirectory);
  assertDirectory(parent, "SPDX_ARTIFACT_PARENT");
  const current = readArtifactSnapshot(artifactDirectory);
  if (!snapshotsEqual(current, expectedPrevious)) {
    fail("SPDX_ARTIFACT_CONCURRENT_CHANGE", "供应链 artifact 在生成期间被其他写入者修改。" );
  }
  const candidate = mkdtempSync(join(parent, `.${basename(artifactDirectory)}.candidate-`));
  const backup = join(parent, `.${basename(artifactDirectory)}.backup`);
  let activated = false;
  let backedUp = false;
  try {
    writeCandidateFile(join(candidate, "dependency-evidence.json"), result.evidenceBytes, syncFile);
    writeCandidateFile(join(candidate, "sbom.spdx.json"), result.bytes, syncFile);
    syncCandidateDirectory(candidate);
    if (existsSync(backup)) {
      fail("SPDX_ARTIFACT_STALE_BACKUP", "检测到未清理的供应链 artifact 备份。" );
    }
    if (existsSync(artifactDirectory)) {
      renameSync(artifactDirectory, backup);
      backedUp = true;
      syncParentDirectory(parent);
      if (afterBackup) afterBackup();
      if (!snapshotsEqual(readArtifactSnapshot(backup), expectedPrevious)) {
        fail("SPDX_ARTIFACT_CONCURRENT_CHANGE", "供应链 artifact 在最终激活窗口发生变化。" );
      }
    }
    renameSync(candidate, artifactDirectory);
    activated = true;
    syncParentDirectory(parent);
    if (afterActivate) afterActivate();
    const expectedActive = {
      evidenceBytes: result.evidenceBytes,
      sbomBytes: result.bytes,
    };
    if (!snapshotsEqual(readArtifactSnapshot(artifactDirectory), expectedActive)) {
      fail("SPDX_ARTIFACT_CONCURRENT_CHANGE", "新供应链 artifact 在激活后发生变化。" );
    }
    if (backedUp) {
      rmSync(backup, { recursive: true });
      syncParentDirectory(parent);
      backedUp = false;
    }
  } catch (error) {
    try {
      if (backedUp && !existsSync(backup)) {
        fail("SPDX_ARTIFACT_PUBLISH_UNCERTAIN", "artifact 发布失败且旧备份已经不可用。" );
      }
      if (backedUp && !snapshotsEqual(readArtifactSnapshot(backup), expectedPrevious)) {
        fail("SPDX_ARTIFACT_PUBLISH_UNCERTAIN", "artifact 发布失败且旧备份已经发生变化。" );
      }
      if (activated && existsSync(artifactDirectory)) {
        rmSync(artifactDirectory, { recursive: true });
      }
      if (backedUp && existsSync(backup)) {
        renameSync(backup, artifactDirectory);
        backedUp = false;
      }
      if (existsSync(candidate)) rmSync(candidate, { recursive: true });
      syncParentDirectory(parent);
    } catch {
      fail("SPDX_ARTIFACT_PUBLISH_UNCERTAIN", "artifact 发布失败且无法确认旧状态已恢复。" );
    }
    if (error instanceof NpmIsolationError) throw error;
    fail("SPDX_ARTIFACT_PUBLISH", "artifact 发布失败，旧状态已恢复。" );
  }
}

export function parseGenerateSupplyChainArguments(arguments_) {
  if (!Array.isArray(arguments_)) {
    fail("SPDX_ARGUMENTS", "供应链生成参数必须是 array。" );
  }
  if (arguments_.length === 0) return { createdAt: null };
  if (arguments_.length !== 2 || arguments_[0] !== "--created-at") {
    fail("SPDX_ARGUMENTS", "只允许可选的 --created-at <UTC秒精度时间>。" );
  }
  return { createdAt: validateCreatedAt(arguments_[1]) };
}

export function generateSupplyChainArtifacts({
  root,
  createdAt = null,
  artifactDirectory = resolve(root, "docs/generated/supply-chain"),
  runProcess,
  temporaryParent = "/tmp",
  npmVersionsByRole = NPM_VERSIONS_BY_ROLE,
  nodeVersion = process.versions.node,
  runIsolated = runIsolatedNpm,
  afterActivate = null,
}) {
  const canonicalRoot = resolve(root);
  const parent = dirname(artifactDirectory);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  assertDirectory(parent, "SPDX_ARTIFACT_PARENT");
  const generationLock = acquireGenerationLock(parent, artifactDirectory);
  let pendingError;
  try {
    readAndValidateLockfile(canonicalRoot, readAndValidateManifest(canonicalRoot));
    const inputHashes = hashGenerationInputs(canonicalRoot);
    const manifest = readAndValidateManifest(canonicalRoot);
    const lockfile = readAndValidateLockfile(canonicalRoot, manifest);
    assertGenerationInputsUnchanged(canonicalRoot, inputHashes);
    const expectedGraph = buildExpectedSpdxGraph(lockfile, manifest);
    const npmRuntime = deriveNpmCli(process.execPath);
    if (nodeVersion !== process.versions.node) {
      fail("NPM_RUNTIME_PROCESS", "声明的 Node 版本与当前进程不一致。" );
    }
    const runtime = validateRuntimeContract({
      root: canonicalRoot,
      nodeVersion,
      npmVersion: npmRuntime.npmVersion,
      manifest,
      npmVersionsByRole,
    });
    if (runtime.role !== "primary") {
      fail("SPDX_PRIMARY_ONLY", "确定性 SPDX 只允许 .nvmrc 主端点生成。" );
    }

    const previousSnapshot = readArtifactSnapshot(artifactDirectory);
    const previous = previousSnapshot
      ? validateCanonicalSpdxArtifacts({
        sbomBytes: previousSnapshot.sbomBytes,
        evidenceBytes: previousSnapshot.evidenceBytes,
        npmVersion: npmRuntime.npmVersion,
      })
      : null;

    const normalized = [];
    for (let index = 0; index < 2; index += 1) {
      assertGenerationInputsUnchanged(canonicalRoot, inputHashes);
      const nativeResult = runIsolated({
        root: canonicalRoot,
        profile: "sbom-native",
        runProcess,
        nodeVersion,
        npmVersionsByRole,
        temporaryParent,
      });
      if (
        nativeResult.runtime?.role !== "primary"
        || nativeResult.runtime?.npmVersion !== npmRuntime.npmVersion
      ) {
        fail("SPDX_PRIMARY_ONLY", "native SPDX 结果不属于当前主 npm 端点。" );
      }
      normalized.push(normalizeNpmSpdx({
        nativeDocument: parseSpdxJson(nativeResult.stdout),
        expectedGraph,
        npmVersion: npmRuntime.npmVersion,
        previousSbomEvidence: previous?.sbomEvidence ?? null,
        createdAt,
      }));
      assertGenerationInputsUnchanged(canonicalRoot, inputHashes);
    }
    if (
      normalized[0].bytes !== normalized[1].bytes
      || normalized[0].evidenceBytes !== normalized[1].evidenceBytes
      || normalized[0].semanticBytes !== normalized[1].semanticBytes
    ) {
      fail("SPDX_DETERMINISM_MISMATCH", "两个全新隔离 workspace 的 canonical SPDX 不一致。" );
    }
    assertGenerationInputsUnchanged(canonicalRoot, inputHashes);
    publishSpdxArtifacts({
      artifactDirectory,
      result: normalized[0],
      expectedPrevious: previousSnapshot,
      afterActivate: () => {
        if (afterActivate) afterActivate();
        assertGenerationInputsUnchanged(canonicalRoot, inputHashes);
      },
    });
    return normalized[0];
  } catch (error) {
    pendingError = error;
    throw error;
  } finally {
    try {
      releaseGenerationLock(generationLock);
    } catch (cleanupError) {
      if (pendingError instanceof NpmIsolationError) {
        fail("SPDX_GENERATION_CLEANUP_AFTER_FAILURE", `${pendingError.code} 后生成锁清理失败。`);
      }
      throw cleanupError;
    }
  }
}

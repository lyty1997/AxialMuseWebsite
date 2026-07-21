import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  readAndValidateManifest,
  validateRuntimeContract,
} from "./config.mjs";
import {
  validateAdmissionClosure,
} from "./admission.mjs";
import { validateSupplyChainClosure } from "./check.mjs";
import { NPM_VERSIONS_BY_ROLE } from "./contracts.mjs";
import { deriveNpmCli } from "./environment.mjs";
import { fail, NpmIsolationError } from "./errors.mjs";
import {
  buildExpectedSpdxGraph,
  hashProjectFile,
  readAndValidateLockfile,
} from "./lockfile.mjs";
import { readAndValidateDependencyLicenseEvidence } from "./license-evidence.mjs";
import { captureCurrentSupplyChainInputReceipt } from "./input-receipt.mjs";
import {
  createNoticeRecordFromTarballInspection,
  renderThirdPartyNotices,
  validateSpdxNoticesSelfClosure,
} from "./notices.mjs";
import {
  readAndValidateDependencyAdmissions,
  readAndValidateDependencyPolicy,
} from "./policy.mjs";
import { createSupplyChainReviewReport } from "./review-report.mjs";
import { runIsolatedNpm } from "./runner.mjs";
import {
  canonicalJsonBytes,
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
  if (!pathExists(artifactDirectory, "SPDX_EVIDENCE_INVALID")) return null;
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

function hashGenerationInputs(root, { includeReviewedEvidence = false } = {}) {
  const hashes = {
    lockfile: hashProjectFile(root, "package-lock.json"),
    manifest: hashProjectFile(root, "package.json"),
    npmrc: hashProjectFile(root, ".npmrc"),
    nvmrc: hashProjectFile(root, ".nvmrc"),
  };
  if (includeReviewedEvidence) {
    hashes.admissions = hashProjectFile(
      root,
      "docs/contracts/dependency-admissions.json",
    );
    hashes.licenseEvidence = hashProjectFile(
      root,
      "docs/contracts/dependency-license-evidence.json",
    );
    hashes.policy = hashProjectFile(root, "docs/contracts/dependency-policy.json");
  }
  return hashes;
}

function assertGenerationInputsUnchanged(root, expected) {
  let actual;
  try {
    actual = hashGenerationInputs(root, {
      includeReviewedEvidence: Object.hasOwn(expected, "admissions"),
    });
  } catch {
    fail("SPDX_INPUT_CONCURRENT_CHANGE", "SPDX 生成输入在执行期间变得不可读。" );
  }
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      fail("SPDX_INPUT_CONCURRENT_CHANGE", "SPDX 生成输入在执行期间发生变化。" );
    }
  }
}

function samePathIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function cleanupGenerationLockPath(lock, syncDirectoryPath) {
  let closed = false;
  let quarantineDirectory = null;
  try {
    const descriptorStat = fstatSync(lock.descriptor);
    const canonicalStat = lstatSync(lock.lockPath);
    if (
      !canonicalStat.isFile()
      || canonicalStat.isSymbolicLink()
      || canonicalStat.nlink !== 1
      || !samePathIdentity(descriptorStat, canonicalStat)
    ) {
      fail(
        "SPDX_GENERATION_LOCK_CLEANUP",
        "供应链 artifact 生成锁已被替换；外部 canonical marker 已保留。",
      );
    }
    quarantineDirectory = mkdtempSync(join(
      lock.parent,
      `.${basename(lock.lockPath)}.cleanup-`,
    ));
    const quarantinePath = join(quarantineDirectory, basename(lock.lockPath));
    renameSync(lock.lockPath, quarantinePath);
    syncDirectoryPath(lock.parent);
    syncDirectoryPath(quarantineDirectory);
    const pathStat = lstatSync(quarantinePath);
    if (
      !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || pathStat.nlink !== 1
      || !samePathIdentity(descriptorStat, pathStat)
    ) {
      fail(
        "SPDX_GENERATION_LOCK_CLEANUP",
        "供应链 artifact 生成锁在清理窗口被替换；隔离 marker 已保留。",
      );
    }
    closeSync(lock.descriptor);
    closed = true;
    unlinkSync(quarantinePath);
    syncDirectoryPath(quarantineDirectory);
    rmSync(quarantineDirectory, { recursive: true });
    syncDirectoryPath(lock.parent);
  } catch (error) {
    if (!closed) {
      try {
        closeSync(lock.descriptor);
      } catch {
        // 下面统一报告清理失败，且不删除身份不明的同名或隔离路径。
      }
    }
    if (error?.code === "SPDX_GENERATION_LOCK_CLEANUP") throw error;
    fail("SPDX_GENERATION_LOCK_CLEANUP", "供应链 artifact 生成锁无法安全清理。" );
  }
}

function acquireGenerationLock(
  parent,
  artifactDirectory,
  syncDirectoryPath = fsyncDirectory,
) {
  const lockPath = join(parent, `.${basename(artifactDirectory)}.generation.lock`);
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
    const descriptorStat = fstatSync(descriptor);
    if (
      !descriptorStat.isFile()
      || descriptorStat.nlink !== 1
      || (descriptorStat.mode & 0o777) !== 0o600
      || (typeof process.getuid === "function" && descriptorStat.uid !== process.getuid())
    ) {
      fail("SPDX_GENERATION_LOCK_ACQUIRE", "供应链 artifact 生成锁类型、所有权或权限不受控。" );
    }
    fsyncSync(descriptor);
    syncDirectoryPath(parent);
  } catch (error) {
    if (descriptor === undefined) {
      if (error?.code === "EEXIST") {
        fail("SPDX_GENERATION_LOCKED", "已有供应链 artifact 生成任务持有排他锁。" );
      }
      fail("SPDX_GENERATION_LOCK_ACQUIRE", "供应链 artifact 生成锁无法创建。" );
    }
    try {
      cleanupGenerationLockPath({ descriptor, lockPath, parent }, syncDirectoryPath);
    } catch (cleanupError) {
      if (cleanupError?.code === "SPDX_GENERATION_LOCK_CLEANUP") throw cleanupError;
      fail("SPDX_GENERATION_LOCK_CLEANUP", "失败的供应链 artifact 生成锁无法安全清理。" );
    }
    if (error instanceof NpmIsolationError) throw error;
    fail("SPDX_GENERATION_LOCK_ACQUIRE", "供应链 artifact 生成锁无法持久化。" );
  }
  return { descriptor, lockPath, parent };
}

function releaseGenerationLock(lock, syncDirectoryPath = fsyncDirectory) {
  cleanupGenerationLockPath(lock, syncDirectoryPath);
}

function writeOwnedCandidateFile(path, text, syncFile) {
  const descriptor = openSync(path, "wx", 0o644);
  try {
    writeFileSync(descriptor, text, "utf8");
    syncFile(descriptor);
    const identity = pathIdentityFromStat(fstatSync(descriptor));
    if (!pathIdentitiesEqual(identity, capturePathIdentity(path, "notice"))) {
      fail(
        "SPDX_ARTIFACT_PUBLISH_UNCERTAIN",
        "供应链候选文件在写入所有权核验前被替换；外部 inode 已保留。",
      );
    }
    return { descriptor, identity };
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // 原始写入 fd 无法继续持有；路径状态由上层按不确定失败保留。
    }
    throw error;
  }
}

function pathExists(path, code) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail(code, "供应链 artifact 路径状态不可读。" );
  }
}

function noticeBytesBuffer(value, code) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  fail(code, "THIRD_PARTY_NOTICES 必须以 string 或 Buffer 提供。" );
}

function readNoticeSnapshot(noticePath) {
  if (!pathExists(noticePath, "SPDX_EVIDENCE_INVALID")) return null;
  let stat;
  try {
    stat = lstatSync(noticePath);
  } catch {
    fail("SPDX_EVIDENCE_INVALID", "THIRD_PARTY_NOTICES 不可读。" );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail("SPDX_EVIDENCE_INVALID", "THIRD_PARTY_NOTICES 必须是单链接普通文件。" );
  }
  return readFileSync(noticePath);
}

function noticeSnapshotsEqual(left, right) {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function capturePathIdentity(path, kind, code = "SPDX_ARTIFACT_PUBLISH_UNCERTAIN") {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(code, "供应链发布路径身份不可读。" );
  }
  const validType = kind === "artifact" ? stat.isDirectory() : stat.isFile();
  if (
    !validType
    || stat.isSymbolicLink()
    || (kind === "notice" && stat.nlink !== 1)
  ) {
    fail(code, "供应链发布路径类型或链接状态不受控。" );
  }
  return pathIdentityFromStat(stat);
}

function pathIdentityFromStat(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    modeType: stat.mode & 0o170000,
    nlink: stat.nlink,
    uid: stat.uid,
  };
}

function holdPublishedPath(path, kind, code = "SPDX_ARTIFACT_PUBLISH_UNCERTAIN") {
  let descriptor;
  try {
    const flags = constants.O_RDONLY
      | constants.O_NOFOLLOW
      | (kind === "artifact" ? constants.O_DIRECTORY : 0);
    descriptor = openSync(path, flags);
    const descriptorStat = fstatSync(descriptor);
    const descriptorIdentity = pathIdentityFromStat(descriptorStat);
    const pathIdentity = capturePathIdentity(path, kind, code);
    if (!pathIdentitiesEqual(descriptorIdentity, pathIdentity)) {
      fail(code, "供应链发布路径在取得所有权句柄期间发生变化。" );
    }
    return { descriptor, identity: descriptorIdentity };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 下面统一按无法取得受控所有权句柄失败。
      }
    }
    if (error instanceof NpmIsolationError) throw error;
    fail(code, "供应链发布路径无法取得受控所有权句柄。" );
  }
}

function holdArtifactFiles(ownership, path) {
  const files = [];
  try {
    for (const name of SPDX_ARTIFACT_FILES) {
      files.push({
        name,
        ownership: holdPublishedPath(join(path, name), "notice"),
      });
    }
  } catch (error) {
    for (const file of files) releasePublishedPath(file.ownership);
    throw error;
  }
  attachArtifactFiles(ownership, files);
}

function attachArtifactFiles(ownership, files) {
  ownership.artifactFiles = files;
  ownership.identity.artifactFileIdentities = Object.fromEntries(files.map((file) => [
    file.name,
    file.ownership.identity,
  ]));
}

function writeOwnedArtifactFiles(ownership, path, snapshot, syncFile) {
  const bytesByName = {
    "dependency-evidence.json": snapshot.evidenceBytes,
    "sbom.spdx.json": snapshot.sbomBytes,
  };
  const files = [];
  try {
    for (const name of SPDX_ARTIFACT_FILES) {
      files.push({
        name,
        ownership: writeOwnedCandidateFile(join(path, name), bytesByName[name], syncFile),
      });
    }
  } catch (error) {
    for (const file of files) releasePublishedPath(file.ownership);
    throw error;
  }
  attachArtifactFiles(ownership, files);
}

function holdPublishedSnapshot(path, kind, code) {
  if (!pathExists(path, code)) return { ownership: null, snapshot: null };
  let ownership = null;
  try {
    ownership = holdPublishedPath(path, kind, code);
    if (kind === "artifact") holdArtifactFiles(ownership, path);
    const snapshot = kind === "artifact"
      ? readArtifactSnapshot(path)
      : readNoticeSnapshot(path);
    assertOwnedPublishedPath({ identity: ownership.identity, kind, path, snapshot });
    return { ownership, snapshot };
  } catch (error) {
    releasePublishedPath(ownership);
    throw error;
  }
}

function releasePublishedPath(ownership) {
  if (Array.isArray(ownership?.artifactFiles)) {
    for (const file of ownership.artifactFiles) releasePublishedPath(file.ownership);
    ownership.artifactFiles = null;
  }
  if (ownership?.descriptor === undefined || ownership.descriptor === null) return;
  closeSync(ownership.descriptor);
  ownership.descriptor = null;
}

function pathIdentitiesEqual(left, right) {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino
    && left.modeType === right.modeType
    && left.nlink === right.nlink
    && left.uid === right.uid;
}

function assertOwnedPublishedPath({ identity, kind, path, snapshot }) {
  const actualIdentity = capturePathIdentity(path, kind);
  const snapshotMatches = kind === "artifact"
    ? snapshotsEqual(readArtifactSnapshot(path), snapshot)
    : noticeSnapshotsEqual(readNoticeSnapshot(path), snapshot);
  const artifactFilesMatch = kind !== "artifact"
    || (
      identity?.artifactFileIdentities !== undefined
      && SPDX_ARTIFACT_FILES.every((name) => pathIdentitiesEqual(
        capturePathIdentity(join(path, name), "notice"),
        identity.artifactFileIdentities[name],
      ))
    );
  if (
    !pathIdentitiesEqual(actualIdentity, identity)
    || !snapshotMatches
    || !artifactFilesMatch
  ) {
    fail(
      "SPDX_ARTIFACT_PUBLISH_UNCERTAIN",
      "供应链发布路径不再属于本次候选，当前状态与备份均保留。",
    );
  }
}

function quarantineOwnedPublishedPath({
  afterOwnershipCheck = null,
  identity,
  kind,
  path,
  snapshot,
  syncParentDirectory,
}) {
  assertOwnedPublishedPath({ identity, kind, path, snapshot });
  if (afterOwnershipCheck) afterOwnershipCheck(kind);
  const parent = dirname(path);
  const quarantineDirectory = mkdtempSync(join(
    parent,
    `.${basename(path)}.rollback-`,
  ));
  const quarantinePath = join(quarantineDirectory, basename(path));
  syncParentDirectory(parent);
  renameSync(path, quarantinePath);
  syncParentDirectory(parent);
  syncParentDirectory(quarantineDirectory);
  const quarantineDirectoryIdentity = capturePathIdentity(
    quarantineDirectory,
    "artifact",
  );
  assertOwnedPublishedPath({
    identity,
    kind,
    path: quarantinePath,
    snapshot,
  });
  if (pathExists(path, "SPDX_ARTIFACT_PUBLISH_UNCERTAIN")) {
    fail(
      "SPDX_ARTIFACT_PUBLISH_UNCERTAIN",
      "供应链发布目标在回滚摘离后被外部写入者占用；隔离状态与备份均保留。",
    );
  }
  return {
    directory: quarantineDirectory,
    directoryIdentity: quarantineDirectoryIdentity,
    identity,
    kind,
    parent,
    path: quarantinePath,
    snapshot,
  };
}

function removeOwnedQuarantine(quarantine, syncParentDirectory) {
  assertOwnedPublishedPath(quarantine);
  const directoryIdentity = capturePathIdentity(quarantine.directory, "artifact");
  if (
    !pathIdentitiesEqual(directoryIdentity, quarantine.directoryIdentity)
    || readdirSync(quarantine.directory).join("\n") !== basename(quarantine.path)
  ) {
    fail("SPDX_ARTIFACT_PUBLISH_UNCERTAIN", "供应链回滚隔离目录发生变化。" );
  }
  rmSync(quarantine.directory, { recursive: true });
  syncParentDirectory(quarantine.parent);
}

function removeOwnedPrivateDirectory(path, identity, snapshot, syncParentDirectory) {
  if (!pathExists(path, "SPDX_ARTIFACT_PUBLISH_UNCERTAIN")) return;
  assertOwnedPublishedPath({ identity, kind: "artifact", path, snapshot });
  rmSync(path, { recursive: true });
  syncParentDirectory(dirname(path));
}

function removeOwnedEmptyPrivateDirectory(path, identity, syncParentDirectory) {
  if (!pathExists(path, "SPDX_ARTIFACT_PUBLISH_UNCERTAIN")) return;
  if (
    !pathIdentitiesEqual(capturePathIdentity(path, "artifact"), identity)
    || readdirSync(path).length !== 0
  ) {
    fail("SPDX_ARTIFACT_PUBLISH_UNCERTAIN", "供应链空候选目录已被替换或写入。" );
  }
  rmdirSync(path);
  syncParentDirectory(dirname(path));
}

function removeOwnedNoticeCandidateDirectory({
  directory,
  directoryIdentity,
  noticeOwnership,
  noticePath,
  noticeSnapshot,
  syncParentDirectory,
}) {
  if (!pathExists(directory, "SPDX_ARTIFACT_PUBLISH_UNCERTAIN")) return;
  if (
    noticeOwnership === null
    || !pathIdentitiesEqual(capturePathIdentity(directory, "artifact"), directoryIdentity)
    || readdirSync(directory).join("\n") !== basename(noticePath)
  ) {
    fail("SPDX_ARTIFACT_PUBLISH_UNCERTAIN", "供应链 NOTICE 候选目录无法证明连续所有权。" );
  }
  assertOwnedPublishedPath({
    identity: noticeOwnership.identity,
    kind: "notice",
    path: noticePath,
    snapshot: noticeSnapshot,
  });
  rmSync(directory, { recursive: true });
  syncParentDirectory(dirname(directory));
}

function restoreArtifactSnapshot({
  path,
  snapshot,
  syncCandidateDirectory,
  syncFile,
  syncParentDirectory,
}) {
  mkdirSync(path, { mode: 0o755 });
  const ownership = holdPublishedPath(path, "artifact");
  try {
    writeOwnedArtifactFiles(ownership, path, snapshot, syncFile);
    syncCandidateDirectory(path);
    assertOwnedPublishedPath({ identity: ownership.identity, kind: "artifact", path, snapshot });
    syncParentDirectory(dirname(path));
    return ownership.identity;
  } finally {
    releasePublishedPath(ownership);
  }
}

function restoreNoticeSnapshot({ path, snapshot, syncFile, syncParentDirectory }) {
  const ownership = writeOwnedCandidateFile(path, snapshot, syncFile);
  try {
    assertOwnedPublishedPath({
      identity: ownership.identity,
      kind: "notice",
      path,
      snapshot,
    });
    syncParentDirectory(dirname(path));
    return ownership.identity;
  } finally {
    releasePublishedPath(ownership);
  }
}

function publishSpdxArtifactsWithNotice({
  artifactDirectory,
  result,
  expectedPrevious,
  noticePath,
  noticeBytes,
  expectedPreviousNotice,
  afterBackup,
  afterActivate,
  afterRollbackOwnershipCheck,
  syncCandidateDirectory,
  syncFile,
  syncParentDirectory,
}) {
  const canonicalArtifactDirectory = resolve(artifactDirectory);
  const canonicalNoticePath = resolve(noticePath);
  if (
    canonicalNoticePath === canonicalArtifactDirectory
    || canonicalNoticePath.startsWith(`${canonicalArtifactDirectory}${sep}`)
  ) {
    fail("SPDX_ARTIFACT_NOTICE_ARGUMENTS", "THIRD_PARTY_NOTICES 不得位于 SPDX artifact 目录内。" );
  }

  const artifactParent = dirname(canonicalArtifactDirectory);
  const noticeParent = dirname(canonicalNoticePath);
  assertDirectory(artifactParent, "SPDX_ARTIFACT_PARENT");
  assertDirectory(noticeParent, "SPDX_ARTIFACT_PARENT");

  const expectedNotice = expectedPreviousNotice === null
    ? null
    : noticeBytesBuffer(expectedPreviousNotice, "SPDX_ARTIFACT_NOTICE_ARGUMENTS");
  const nextNotice = noticeBytesBuffer(noticeBytes, "SPDX_ARTIFACT_NOTICE_ARGUMENTS");
  let currentArtifactOwnership = null;
  let currentNoticeOwnership = null;
  let current;
  let currentNotice;
  try {
    const artifactState = holdPublishedSnapshot(
      canonicalArtifactDirectory,
      "artifact",
      "SPDX_EVIDENCE_INVALID",
    );
    currentArtifactOwnership = artifactState.ownership;
    current = artifactState.snapshot;
    const noticeState = holdPublishedSnapshot(
      canonicalNoticePath,
      "notice",
      "SPDX_EVIDENCE_INVALID",
    );
    currentNoticeOwnership = noticeState.ownership;
    currentNotice = noticeState.snapshot;
  } catch (error) {
    releasePublishedPath(currentArtifactOwnership);
    releasePublishedPath(currentNoticeOwnership);
    throw error;
  }
  if (
    !snapshotsEqual(current, expectedPrevious)
    || !noticeSnapshotsEqual(currentNotice, expectedNotice)
  ) {
    releasePublishedPath(currentArtifactOwnership);
    releasePublishedPath(currentNoticeOwnership);
    fail("SPDX_ARTIFACT_CONCURRENT_CHANGE", "供应链三件套在生成期间被其他写入者修改。" );
  }

  const artifactBackup = join(
    artifactParent,
    `.${basename(canonicalArtifactDirectory)}.backup`,
  );
  const noticeBackup = join(noticeParent, `.${basename(canonicalNoticePath)}.backup`);
  if (resolve(artifactBackup) === resolve(noticeBackup)) {
    releasePublishedPath(currentArtifactOwnership);
    releasePublishedPath(currentNoticeOwnership);
    fail("SPDX_ARTIFACT_NOTICE_ARGUMENTS", "SPDX 与 NOTICE 备份路径发生冲突。" );
  }

  let artifactCandidate = null;
  let noticeCandidateDirectory = null;
  try {
    artifactCandidate = mkdtempSync(join(
      artifactParent,
      `.${basename(canonicalArtifactDirectory)}.candidate-`,
    ));
    noticeCandidateDirectory = mkdtempSync(join(
      noticeParent,
      `.${basename(canonicalNoticePath)}.candidate-`,
    ));
  } catch {
    releasePublishedPath(currentArtifactOwnership);
    releasePublishedPath(currentNoticeOwnership);
    currentArtifactOwnership = null;
    currentNoticeOwnership = null;
    try {
      if (artifactCandidate !== null) {
        rmSync(artifactCandidate, { recursive: true });
        syncParentDirectory(artifactParent);
      }
      if (noticeCandidateDirectory !== null) {
        rmSync(noticeCandidateDirectory, { recursive: true });
        syncParentDirectory(noticeParent);
      }
    } catch {
      fail("SPDX_ARTIFACT_PUBLISH_UNCERTAIN", "三件套候选路径创建失败且无法确认清理结果。" );
    }
    fail("SPDX_ARTIFACT_PUBLISH", "三件套候选路径无法创建，旧状态未修改。" );
  }
  const noticeCandidate = join(noticeCandidateDirectory, basename(canonicalNoticePath));
  let artifactCandidateOwnership = null;
  let artifactCandidateIdentity = null;
  let noticeCandidateDirectoryOwnership = null;
  let noticeCandidateDirectoryIdentity = null;
  try {
    artifactCandidateOwnership = holdPublishedPath(artifactCandidate, "artifact");
    artifactCandidateIdentity = artifactCandidateOwnership.identity;
    noticeCandidateDirectoryOwnership = holdPublishedPath(
      noticeCandidateDirectory,
      "artifact",
    );
    noticeCandidateDirectoryIdentity = noticeCandidateDirectoryOwnership.identity;
  } catch (error) {
    releasePublishedPath(artifactCandidateOwnership);
    releasePublishedPath(noticeCandidateDirectoryOwnership);
    releasePublishedPath(currentArtifactOwnership);
    releasePublishedPath(currentNoticeOwnership);
    throw error;
  }
  const expectedActive = {
    evidenceBytes: result.evidenceBytes,
    sbomBytes: result.bytes,
  };

  let artifactActivated = false;
  let artifactBackedUp = false;
  let committed = false;
  let noticeActivated = false;
  let noticeBackedUp = false;
  let artifactBackupIdentity = null;
  let noticeBackupIdentity = null;
  let noticeCandidateIdentity = null;
  let artifactBackupOwnership = null;
  let noticeBackupOwnership = null;
  let noticeCandidateOwnership = null;
  try {
    writeOwnedArtifactFiles(
      artifactCandidateOwnership,
      artifactCandidate,
      expectedActive,
      syncFile,
    );
    noticeCandidateOwnership = writeOwnedCandidateFile(noticeCandidate, nextNotice, syncFile);
    noticeCandidateIdentity = noticeCandidateOwnership.identity;
    syncCandidateDirectory(artifactCandidate);
    syncCandidateDirectory(noticeCandidateDirectory);
    assertOwnedPublishedPath({
      identity: artifactCandidateIdentity,
      kind: "artifact",
      path: artifactCandidate,
      snapshot: expectedActive,
    });
    assertOwnedPublishedPath({
      identity: noticeCandidateIdentity,
      kind: "notice",
      path: noticeCandidate,
      snapshot: nextNotice,
    });

    if (
      pathExists(artifactBackup, "SPDX_ARTIFACT_STALE_BACKUP")
      || pathExists(noticeBackup, "SPDX_ARTIFACT_STALE_BACKUP")
    ) {
      fail("SPDX_ARTIFACT_STALE_BACKUP", "检测到未清理的供应链三件套备份。" );
    }

    if (current !== null) {
      assertOwnedPublishedPath({
        identity: currentArtifactOwnership.identity,
        kind: "artifact",
        path: canonicalArtifactDirectory,
        snapshot: current,
      });
      renameSync(canonicalArtifactDirectory, artifactBackup);
      artifactBackedUp = true;
      artifactBackupOwnership = currentArtifactOwnership;
      currentArtifactOwnership = null;
      artifactBackupIdentity = artifactBackupOwnership.identity;
      syncParentDirectory(artifactParent);
      assertOwnedPublishedPath({
        identity: artifactBackupIdentity,
        kind: "artifact",
        path: artifactBackup,
        snapshot: current,
      });
    }
    if (currentNotice !== null) {
      assertOwnedPublishedPath({
        identity: currentNoticeOwnership.identity,
        kind: "notice",
        path: canonicalNoticePath,
        snapshot: currentNotice,
      });
      renameSync(canonicalNoticePath, noticeBackup);
      noticeBackedUp = true;
      noticeBackupOwnership = currentNoticeOwnership;
      currentNoticeOwnership = null;
      noticeBackupIdentity = noticeBackupOwnership.identity;
      syncParentDirectory(noticeParent);
      assertOwnedPublishedPath({
        identity: noticeBackupIdentity,
        kind: "notice",
        path: noticeBackup,
        snapshot: currentNotice,
      });
    }
    if (afterBackup) afterBackup();

    if (artifactBackedUp) {
      assertOwnedPublishedPath({
        identity: artifactBackupIdentity,
        kind: "artifact",
        path: artifactBackup,
        snapshot: expectedPrevious,
      });
    }
    if (noticeBackedUp) {
      assertOwnedPublishedPath({
        identity: noticeBackupIdentity,
        kind: "notice",
        path: noticeBackup,
        snapshot: expectedNotice,
      });
    }
    if (
      (!artifactBackedUp && readArtifactSnapshot(canonicalArtifactDirectory) !== null)
      || (!noticeBackedUp && readNoticeSnapshot(canonicalNoticePath) !== null)
    ) {
      fail("SPDX_ARTIFACT_CONCURRENT_CHANGE", "供应链三件套在最终激活窗口发生变化。" );
    }

    // 两个 parent 之间没有跨目录原子提交；逐项持久化并以完整 snapshot/备份回滚收口。
    renameSync(artifactCandidate, canonicalArtifactDirectory);
    artifactActivated = true;
    syncParentDirectory(artifactParent);
    renameSync(noticeCandidate, canonicalNoticePath);
    noticeActivated = true;
    syncParentDirectory(noticeParent);
    removeOwnedEmptyPrivateDirectory(
      noticeCandidateDirectory,
      noticeCandidateDirectoryIdentity,
      syncParentDirectory,
    );
    if (afterActivate) afterActivate();

    assertOwnedPublishedPath({
      identity: artifactCandidateIdentity,
      kind: "artifact",
      path: canonicalArtifactDirectory,
      snapshot: expectedActive,
    });
    assertOwnedPublishedPath({
      identity: noticeCandidateIdentity,
      kind: "notice",
      path: canonicalNoticePath,
      snapshot: nextNotice,
    });
    committed = true;

    if (artifactBackedUp) {
      const quarantine = quarantineOwnedPublishedPath({
        identity: artifactBackupIdentity,
        kind: "artifact",
        path: artifactBackup,
        snapshot: expectedPrevious,
        syncParentDirectory,
      });
      removeOwnedQuarantine(quarantine, syncParentDirectory);
      artifactBackedUp = false;
    }
    if (noticeBackedUp) {
      const quarantine = quarantineOwnedPublishedPath({
        identity: noticeBackupIdentity,
        kind: "notice",
        path: noticeBackup,
        snapshot: expectedNotice,
        syncParentDirectory,
      });
      removeOwnedQuarantine(quarantine, syncParentDirectory);
      noticeBackedUp = false;
    }
  } catch (error) {
    if (committed) {
      fail(
        "SPDX_ARTIFACT_PUBLISH_UNCERTAIN",
        "新供应链三件套已完整激活，但旧备份清理失败；active canonical 与残余状态均保留。",
      );
    }
    try {
      if (artifactBackedUp) {
        assertOwnedPublishedPath({
          identity: artifactBackupIdentity,
          kind: "artifact",
          path: artifactBackup,
          snapshot: expectedPrevious,
        });
      }
      if (noticeBackedUp) {
        assertOwnedPublishedPath({
          identity: noticeBackupIdentity,
          kind: "notice",
          path: noticeBackup,
          snapshot: expectedNotice,
        });
      }

      if (artifactActivated) {
        assertOwnedPublishedPath({
          identity: artifactCandidateIdentity,
          kind: "artifact",
          path: canonicalArtifactDirectory,
          snapshot: expectedActive,
        });
      }
      if (noticeActivated) {
        assertOwnedPublishedPath({
          identity: noticeCandidateIdentity,
          kind: "notice",
          path: canonicalNoticePath,
          snapshot: nextNotice,
        });
      }

      const artifactQuarantine = artifactActivated
        ? quarantineOwnedPublishedPath({
          afterOwnershipCheck: afterRollbackOwnershipCheck,
          identity: artifactCandidateIdentity,
          kind: "artifact",
          path: canonicalArtifactDirectory,
          snapshot: expectedActive,
          syncParentDirectory,
        })
        : null;
      const noticeQuarantine = noticeActivated
        ? quarantineOwnedPublishedPath({
          afterOwnershipCheck: afterRollbackOwnershipCheck,
          identity: noticeCandidateIdentity,
          kind: "notice",
          path: canonicalNoticePath,
          snapshot: nextNotice,
          syncParentDirectory,
        })
        : null;

      if (artifactBackedUp) {
        restoreArtifactSnapshot({
          path: canonicalArtifactDirectory,
          snapshot: expectedPrevious,
          syncCandidateDirectory,
          syncFile,
          syncParentDirectory,
        });
      }
      if (noticeBackedUp) {
        restoreNoticeSnapshot({
          path: canonicalNoticePath,
          snapshot: expectedNotice,
          syncFile,
          syncParentDirectory,
        });
      }
      if (
        !snapshotsEqual(readArtifactSnapshot(canonicalArtifactDirectory), expectedPrevious)
        || !noticeSnapshotsEqual(readNoticeSnapshot(canonicalNoticePath), expectedNotice)
      ) {
        fail("SPDX_ARTIFACT_PUBLISH_UNCERTAIN", "三件套回滚后的旧状态不完整。" );
      }

      if (artifactBackedUp) {
        const quarantine = quarantineOwnedPublishedPath({
          identity: artifactBackupIdentity,
          kind: "artifact",
          path: artifactBackup,
          snapshot: expectedPrevious,
          syncParentDirectory,
        });
        removeOwnedQuarantine(quarantine, syncParentDirectory);
        artifactBackedUp = false;
      }
      if (noticeBackedUp) {
        const quarantine = quarantineOwnedPublishedPath({
          identity: noticeBackupIdentity,
          kind: "notice",
          path: noticeBackup,
          snapshot: expectedNotice,
          syncParentDirectory,
        });
        removeOwnedQuarantine(quarantine, syncParentDirectory);
        noticeBackedUp = false;
      }
      if (artifactQuarantine) {
        removeOwnedQuarantine(artifactQuarantine, syncParentDirectory);
      }
      if (noticeQuarantine) {
        removeOwnedQuarantine(noticeQuarantine, syncParentDirectory);
      }
      removeOwnedPrivateDirectory(
        artifactCandidate,
        artifactCandidateIdentity,
        expectedActive,
        syncParentDirectory,
      );
      removeOwnedNoticeCandidateDirectory({
        directory: noticeCandidateDirectory,
        directoryIdentity: noticeCandidateDirectoryIdentity,
        noticeOwnership: noticeCandidateOwnership,
        noticePath: noticeCandidate,
        noticeSnapshot: nextNotice,
        syncParentDirectory,
      });
    } catch {
      fail("SPDX_ARTIFACT_PUBLISH_UNCERTAIN", "三件套发布失败且无法确认全部旧状态已恢复。" );
    }
    if (error instanceof NpmIsolationError) throw error;
    fail("SPDX_ARTIFACT_PUBLISH", "三件套发布失败，旧状态已恢复。" );
  } finally {
    releasePublishedPath(artifactBackupOwnership);
    releasePublishedPath(artifactCandidateOwnership);
    releasePublishedPath(currentArtifactOwnership);
    releasePublishedPath(currentNoticeOwnership);
    releasePublishedPath(noticeBackupOwnership);
    releasePublishedPath(noticeCandidateOwnership);
    releasePublishedPath(noticeCandidateDirectoryOwnership);
  }
}

export function publishSpdxArtifacts({
  artifactDirectory,
  result,
  expectedPrevious,
  noticePath = undefined,
  noticeBytes = undefined,
  expectedPreviousNotice = undefined,
  afterBackup = null,
  afterActivate = null,
  afterRollbackOwnershipCheck = null,
  syncCandidateDirectory = fsyncDirectory,
  syncFile = fsyncSync,
  syncParentDirectory = fsyncDirectory,
}) {
  const noticeArguments = [noticePath, noticeBytes, expectedPreviousNotice];
  const noticeArgumentCount = noticeArguments.filter((value) => value !== undefined).length;
  if (noticeArgumentCount !== 0 && noticeArgumentCount !== noticeArguments.length) {
    fail(
      "SPDX_ARTIFACT_NOTICE_ARGUMENTS",
      "noticePath、noticeBytes 与 expectedPreviousNotice 必须同时提供。",
    );
  }
  if (noticeArgumentCount === noticeArguments.length) {
    return publishSpdxArtifactsWithNotice({
      artifactDirectory,
      result,
      expectedPrevious,
      noticePath,
      noticeBytes,
      expectedPreviousNotice,
      afterBackup,
      afterActivate,
      afterRollbackOwnershipCheck,
      syncCandidateDirectory,
      syncFile,
      syncParentDirectory,
    });
  }
  const parent = dirname(artifactDirectory);
  assertDirectory(parent, "SPDX_ARTIFACT_PARENT");
  const currentState = holdPublishedSnapshot(
    artifactDirectory,
    "artifact",
    "SPDX_EVIDENCE_INVALID",
  );
  let currentOwnership = currentState.ownership;
  const current = currentState.snapshot;
  if (!snapshotsEqual(current, expectedPrevious)) {
    releasePublishedPath(currentOwnership);
    fail("SPDX_ARTIFACT_CONCURRENT_CHANGE", "供应链 artifact 在生成期间被其他写入者修改。" );
  }
  let candidate;
  try {
    candidate = mkdtempSync(join(parent, `.${basename(artifactDirectory)}.candidate-`));
  } catch (error) {
    releasePublishedPath(currentOwnership);
    throw error;
  }
  let candidateOwnership;
  let candidateIdentity;
  try {
    candidateOwnership = holdPublishedPath(candidate, "artifact");
    candidateIdentity = candidateOwnership.identity;
  } catch (error) {
    releasePublishedPath(currentOwnership);
    throw error;
  }
  const backup = join(parent, `.${basename(artifactDirectory)}.backup`);
  const expectedActive = {
    evidenceBytes: result.evidenceBytes,
    sbomBytes: result.bytes,
  };
  let activated = false;
  let backedUp = false;
  let backupIdentity = null;
  let backupOwnership = null;
  try {
    writeOwnedArtifactFiles(candidateOwnership, candidate, expectedActive, syncFile);
    syncCandidateDirectory(candidate);
    assertOwnedPublishedPath({
      identity: candidateIdentity,
      kind: "artifact",
      path: candidate,
      snapshot: expectedActive,
    });
    if (existsSync(backup)) {
      fail("SPDX_ARTIFACT_STALE_BACKUP", "检测到未清理的供应链 artifact 备份。" );
    }
    if (current !== null) {
      assertOwnedPublishedPath({
        identity: currentOwnership.identity,
        kind: "artifact",
        path: artifactDirectory,
        snapshot: current,
      });
      renameSync(artifactDirectory, backup);
      backedUp = true;
      backupOwnership = currentOwnership;
      currentOwnership = null;
      backupIdentity = backupOwnership.identity;
      syncParentDirectory(parent);
      assertOwnedPublishedPath({
        identity: backupIdentity,
        kind: "artifact",
        path: backup,
        snapshot: current,
      });
      if (afterBackup) afterBackup();
      assertOwnedPublishedPath({
        identity: backupIdentity,
        kind: "artifact",
        path: backup,
        snapshot: expectedPrevious,
      });
    } else if (readArtifactSnapshot(artifactDirectory) !== null) {
      fail("SPDX_ARTIFACT_CONCURRENT_CHANGE", "供应链 artifact 在最终激活窗口发生变化。" );
    }
    renameSync(candidate, artifactDirectory);
    activated = true;
    syncParentDirectory(parent);
    if (afterActivate) afterActivate();
    assertOwnedPublishedPath({
      identity: candidateIdentity,
      kind: "artifact",
      path: artifactDirectory,
      snapshot: expectedActive,
    });
    if (backedUp) {
      const quarantine = quarantineOwnedPublishedPath({
        identity: backupIdentity,
        kind: "artifact",
        path: backup,
        snapshot: expectedPrevious,
        syncParentDirectory,
      });
      removeOwnedQuarantine(quarantine, syncParentDirectory);
      backedUp = false;
    }
  } catch (error) {
    try {
      if (backedUp) {
        assertOwnedPublishedPath({
          identity: backupIdentity,
          kind: "artifact",
          path: backup,
          snapshot: expectedPrevious,
        });
      }
      const activeQuarantine = activated
        ? quarantineOwnedPublishedPath({
          afterOwnershipCheck: afterRollbackOwnershipCheck,
          identity: candidateIdentity,
          kind: "artifact",
          path: artifactDirectory,
          snapshot: expectedActive,
          syncParentDirectory,
        })
        : null;
      if (backedUp) {
        restoreArtifactSnapshot({
          path: artifactDirectory,
          snapshot: expectedPrevious,
          syncCandidateDirectory,
          syncFile,
          syncParentDirectory,
        });
      }
      if (!snapshotsEqual(readArtifactSnapshot(artifactDirectory), expectedPrevious)) {
        fail("SPDX_ARTIFACT_PUBLISH_UNCERTAIN", "artifact 回滚后的旧状态不完整。" );
      }
      if (backedUp) {
        const backupQuarantine = quarantineOwnedPublishedPath({
          identity: backupIdentity,
          kind: "artifact",
          path: backup,
          snapshot: expectedPrevious,
          syncParentDirectory,
        });
        removeOwnedQuarantine(backupQuarantine, syncParentDirectory);
        backedUp = false;
      }
      if (activeQuarantine) {
        removeOwnedQuarantine(activeQuarantine, syncParentDirectory);
      }
      removeOwnedPrivateDirectory(candidate, candidateIdentity, expectedActive, syncParentDirectory);
    } catch {
      fail("SPDX_ARTIFACT_PUBLISH_UNCERTAIN", "artifact 发布失败且无法确认旧状态已恢复。" );
    }
    if (error instanceof NpmIsolationError) throw error;
    fail("SPDX_ARTIFACT_PUBLISH", "artifact 发布失败，旧状态已恢复。" );
  } finally {
    releasePublishedPath(backupOwnership);
    releasePublishedPath(candidateOwnership);
    releasePublishedPath(currentOwnership);
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
  noticePath = resolve(root, "THIRD_PARTY_NOTICES"),
  tarballInspections = null,
  licenseEvidence = null,
  runProcess,
  temporaryParent = "/tmp",
  npmVersionsByRole = NPM_VERSIONS_BY_ROLE,
  nodeVersion = process.versions.node,
  runIsolated = runIsolatedNpm,
  afterActivate = null,
  syncGenerationLockDirectory = fsyncDirectory,
}) {
  const canonicalRoot = resolve(root);
  const reviewedEvidence = tarballInspections !== null;
  if (reviewedEvidence && !Array.isArray(tarballInspections)) {
    fail("SPDX_TARBALL_INSPECTIONS", "正式供应链生成必须提供 tarball inspections array。" );
  }
  if (!reviewedEvidence && licenseEvidence !== null) {
    fail("SPDX_LICENSE_EVIDENCE_INPUT", "非正式 SPDX 生成不接受补充许可证证据。" );
  }
  const parent = dirname(artifactDirectory);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  assertDirectory(parent, "SPDX_ARTIFACT_PARENT");
  const generationLock = acquireGenerationLock(
    parent,
    artifactDirectory,
    syncGenerationLockDirectory,
  );
  let pendingError;
  try {
    readAndValidateLockfile(canonicalRoot, readAndValidateManifest(canonicalRoot));
    if (reviewedEvidence) {
      readAndValidateDependencyPolicy(canonicalRoot);
      readAndValidateDependencyAdmissions(canonicalRoot);
      readAndValidateDependencyLicenseEvidence(canonicalRoot);
    }
    const inputHashes = hashGenerationInputs(canonicalRoot, {
      includeReviewedEvidence: reviewedEvidence,
    });
    const manifest = readAndValidateManifest(canonicalRoot);
    const lockfile = readAndValidateLockfile(canonicalRoot, manifest);
    const policy = reviewedEvidence
      ? readAndValidateDependencyPolicy(canonicalRoot)
      : null;
    const admissions = reviewedEvidence
      ? readAndValidateDependencyAdmissions(canonicalRoot)
      : null;
    const validatedLicenseEvidence = reviewedEvidence
      ? readAndValidateDependencyLicenseEvidence(canonicalRoot)
      : null;
    if (
      reviewedEvidence
      && canonicalJsonBytes(validatedLicenseEvidence) !== canonicalJsonBytes(licenseEvidence)
    ) {
      fail("SPDX_LICENSE_EVIDENCE_INPUT", "正式生成传入的许可证证据与仓库 canonical 契约不一致。" );
    }
    assertGenerationInputsUnchanged(canonicalRoot, inputHashes);
    let lockedPackages = null;
    let noticeBytes = null;
    let expectedGraph;
    if (reviewedEvidence) {
      lockedPackages = validateAdmissionClosure({ lockfile, manifest, admissions });
      const receipt = captureCurrentSupplyChainInputReceipt({
        nodeVersion,
        npmVersionsByRole,
        root: canonicalRoot,
      });
      assertGenerationInputsUnchanged(canonicalRoot, inputHashes);
      const review = createSupplyChainReviewReport({
        inspections: tarballInspections,
        licenseEvidence: validatedLicenseEvidence,
        lockedPackages,
        policy,
        receipt,
      });
      const inspectionByIdentity = new Map(tarballInspections.map((inspection) => [
        inspection.identity,
        inspection,
      ]));
      for (const package_ of review.packages) {
        if (package_.licensePolicy.classification === "blocked") {
          fail(
            package_.licensePolicy.code,
            `${package_.identity} 的声明许可证未通过固定策略。`,
          );
        }
        if (admissions.packages[package_.identity].evidenceSha256 !== package_.evidenceSha256) {
          fail(
            "SUPPLY_CHAIN_NOTICE_EVIDENCE",
            `${package_.identity} 的 admission evidence 摘要与本轮 tarball 不一致。`,
          );
        }
      }
      const noticeRecords = lockedPackages.map((lockedPackage) => (
        createNoticeRecordFromTarballInspection({
          admission: admissions.packages[lockedPackage.identity],
          inspection: inspectionByIdentity.get(lockedPackage.identity),
          lockedPackage,
        })
      ));
      noticeBytes = renderThirdPartyNotices(noticeRecords);
      expectedGraph = buildExpectedSpdxGraph(lockfile, manifest, {
        packageMetadataByIdentity: new Map(noticeRecords.map((record) => [
          record.identity,
          record,
        ])),
        requirePackageMetadata: true,
      });
    } else {
      expectedGraph = buildExpectedSpdxGraph(lockfile, manifest);
    }
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
    const previousNotice = reviewedEvidence ? readNoticeSnapshot(noticePath) : null;
    if (
      reviewedEvidence
      && ((previousSnapshot === null) !== (previousNotice === null))
    ) {
      fail(
        "SPDX_EVIDENCE_INVALID",
        "正式供应链旧制品必须同时包含 SPDX 两文件与 THIRD_PARTY_NOTICES。",
      );
    }
    const previous = previousSnapshot
      ? validateCanonicalSpdxArtifacts({
        sbomBytes: previousSnapshot.sbomBytes,
        evidenceBytes: previousSnapshot.evidenceBytes,
        npmVersion: npmRuntime.npmVersion,
      })
      : null;
    if (previousNotice !== null) {
      validateSpdxNoticesSelfClosure({
        bytes: previousNotice,
        document: previous.document,
      });
    }

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
    if (reviewedEvidence) {
      validateSupplyChainClosure({
        admissions,
        evidenceBytes: normalized[0].evidenceBytes,
        lockfile,
        licenseEvidence: validatedLicenseEvidence,
        manifest,
        noticeBytes,
        npmVersion: npmRuntime.npmVersion,
        policy,
        sbomBytes: normalized[0].bytes,
      });
    }
    assertGenerationInputsUnchanged(canonicalRoot, inputHashes);
    publishSpdxArtifacts({
      artifactDirectory,
      result: normalized[0],
      expectedPrevious: previousSnapshot,
      ...(reviewedEvidence ? {
        expectedPreviousNotice: previousNotice,
        noticeBytes,
        noticePath,
      } : {}),
      afterActivate: () => {
        if (afterActivate) afterActivate();
        assertGenerationInputsUnchanged(canonicalRoot, inputHashes);
        if (reviewedEvidence) {
          const active = readArtifactSnapshot(artifactDirectory);
          const activeNotice = readNoticeSnapshot(noticePath);
          if (active === null || activeNotice === null) {
            fail("SPDX_ARTIFACT_CONCURRENT_CHANGE", "激活后的供应链三件套不完整。" );
          }
          validateSupplyChainClosure({
            admissions,
            evidenceBytes: active.evidenceBytes,
            lockfile,
            licenseEvidence: validatedLicenseEvidence,
            manifest,
            noticeBytes: activeNotice,
            npmVersion: npmRuntime.npmVersion,
            policy,
            sbomBytes: active.sbomBytes,
          });
        }
      },
    });
    return {
      ...normalized[0],
      ...(reviewedEvidence ? { noticeBytes } : {}),
    };
  } catch (error) {
    pendingError = error;
    throw error;
  } finally {
    try {
      releaseGenerationLock(generationLock, syncGenerationLockDirectory);
    } catch (cleanupError) {
      if (pendingError instanceof NpmIsolationError) {
        fail("SPDX_GENERATION_CLEANUP_AFTER_FAILURE", `${pendingError.code} 后生成锁清理失败。`);
      }
      throw cleanupError;
    }
  }
}

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  assertNoCompetingPackageManagerInputs,
  readAndValidateManifest,
  validateProjectNpmrc,
  validateRuntimeContract,
} from "./config.mjs";
import { NPM_VERSIONS_BY_ROLE } from "./contracts.mjs";
import { deriveNpmCli } from "./environment.mjs";
import { NpmIsolationError, fail } from "./errors.mjs";
import {
  collectLockedPackages,
  readAndValidateLockfile,
} from "./lockfile.mjs";
import {
  assertSupplyChainInputReceiptCurrent,
  captureSupplyChainInputHashes,
  createSupplyChainInputReceipt,
  supplyChainInputReceiptBytes,
  supplyChainInputReceiptSha256,
} from "./input-receipt.mjs";
import { readAndValidateDependencyPolicy } from "./policy.mjs";
import { readAndValidateDependencyLicenseEvidence } from "./license-evidence.mjs";
import {
  renderSupplyChainReviewReport,
  validateSupplyChainReviewInspection,
} from "./review-report.mjs";
import {
  downloadRegistryTarball,
  reviewLockedPackageTarballs,
} from "./tarball-download.mjs";

const REPORT_DIRECTORY_PREFIX = "axial-muse-supply-chain-review-";
const REPORT_FILE_NAME = "report.json";
const RECEIPT_FILE_NAME = "receipt.json";
const CLEANUP_QUARANTINE_PREFIX = ".axial-muse-supply-chain-review-cleanup-";

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

function statIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & 0o177777,
    nlink: stat.nlink,
    uid: stat.uid,
  };
}

function identitiesEqual(left, right) {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid;
}

function sameCreatedObject(left, right) {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino
    && (left.mode & 0o170000) === (right.mode & 0o170000)
    && left.nlink === right.nlink
    && left.uid === right.uid;
}

function sameOwnedInode(left, right) {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid;
}

function validateOwnedStat(stat, { directory, mode }) {
  return !stat.isSymbolicLink()
    && (directory ? stat.isDirectory() : stat.isFile())
    && (stat.mode & 0o777) === mode
    && (!directory ? stat.nlink === 1 : stat.nlink >= 2)
    && (typeof process.getuid !== "function" || stat.uid === process.getuid());
}

function refreshHeldDirectoryIdentity(path, ownership, expectedNlink, code) {
  let descriptorStat;
  let pathStat;
  try {
    descriptorStat = fstatSync(ownership.descriptor);
    pathStat = lstatSync(path);
  } catch {
    fail(code, "候选审查 quarantine 目录身份无法复核。");
  }
  const descriptorIdentity = statIdentity(descriptorStat);
  const pathIdentity = statIdentity(pathStat);
  if (
    !validateOwnedStat(descriptorStat, { directory: true, mode: 0o700 })
    || !validateOwnedStat(pathStat, { directory: true, mode: 0o700 })
    || descriptorIdentity.nlink !== expectedNlink
    || pathIdentity.nlink !== expectedNlink
    || !sameOwnedInode(descriptorIdentity, ownership.identity)
    || !identitiesEqual(descriptorIdentity, pathIdentity)
  ) {
    fail(code, "候选审查 quarantine 目录在链接数变化期间被替换。");
  }
  ownership.identity = descriptorIdentity;
}

function openOwnedPath(path, { createdIdentity, directory, mode, code }) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      (directory ? constants.O_RDONLY : constants.O_RDWR)
        | constants.O_NOFOLLOW
        | (directory ? constants.O_DIRECTORY : 0),
    );
    const openedBeforeMode = statIdentity(fstatSync(descriptor));
    if (createdIdentity !== undefined && !sameCreatedObject(openedBeforeMode, createdIdentity)) {
      fail(code, "候选审查临时路径在创建后、取得句柄前被替换。");
    }
    fchmodSync(descriptor, mode);
    const descriptorStat = fstatSync(descriptor);
    const pathStat = lstatSync(path);
    if (
      !validateOwnedStat(descriptorStat, { directory, mode })
      || !validateOwnedStat(pathStat, { directory, mode })
      || !identitiesEqual(statIdentity(descriptorStat), statIdentity(pathStat))
    ) {
      fail(code, "候选审查临时路径类型、权限、链接或所有者不受控。");
    }
    return {
      descriptor,
      identity: statIdentity(descriptorStat),
      snapshot: null,
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 下面统一按无法取得所有权句柄失败。
      }
    }
    if (error instanceof NpmIsolationError) throw error;
    fail(code, "候选审查临时路径无法取得受控所有权句柄。");
  }
}

function assertHeldPath(path, ownership, { directory, mode, code }) {
  let descriptorStat;
  let pathStat;
  try {
    descriptorStat = fstatSync(ownership.descriptor);
    pathStat = lstatSync(path);
  } catch {
    fail(code, "候选审查临时路径所有权无法复核。");
  }
  if (
    !validateOwnedStat(descriptorStat, { directory, mode })
    || !validateOwnedStat(pathStat, { directory, mode })
    || !identitiesEqual(statIdentity(descriptorStat), ownership.identity)
    || !identitiesEqual(statIdentity(pathStat), ownership.identity)
  ) {
    fail(code, "候选审查临时路径不再属于本次任务。");
  }
}

function descriptorMatchesSnapshot(ownership) {
  if (!Buffer.isBuffer(ownership.snapshot)) return false;
  const actual = Buffer.alloc(ownership.snapshot.length);
  let offset = 0;
  try {
    while (offset < actual.length) {
      const count = readSync(
        ownership.descriptor,
        actual,
        offset,
        actual.length - offset,
        offset,
      );
      if (count === 0) return false;
      offset += count;
    }
    return fstatSync(ownership.descriptor).size === ownership.snapshot.length
      && actual.equals(ownership.snapshot);
  } finally {
    actual.fill(0);
  }
}

function closeOwnership(ownership) {
  if (ownership?.descriptor === null || ownership?.descriptor === undefined) return;
  closeSync(ownership.descriptor);
  ownership.descriptor = null;
  if (Buffer.isBuffer(ownership.snapshot)) ownership.snapshot.fill(0);
  ownership.snapshot = null;
}

function closeOwnershipQuietly(ownership) {
  try {
    closeOwnership(ownership);
  } catch {
    if (Buffer.isBuffer(ownership?.snapshot)) ownership.snapshot.fill(0);
    if (ownership) {
      ownership.descriptor = null;
      ownership.snapshot = null;
    }
  }
}

function resolveTemporaryParent(temporaryParent) {
  if (typeof temporaryParent !== "string" || temporaryParent === "") {
    fail("SUPPLY_CHAIN_REVIEW_TEMP_PARENT", "候选审查临时父目录不合法。");
  }
  let canonicalTmp;
  let parent;
  try {
    canonicalTmp = realpathSync("/tmp");
    parent = realpathSync(temporaryParent);
  } catch {
    fail("SUPPLY_CHAIN_REVIEW_TEMP_PARENT", "候选审查临时父目录不可用。");
  }
  let parentStat;
  try {
    parentStat = lstatSync(parent);
  } catch {
    fail("SUPPLY_CHAIN_REVIEW_TEMP_PARENT", "候选审查临时父目录不可确认。");
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !isInside(canonicalTmp, parent)) {
    fail("SUPPLY_CHAIN_REVIEW_TEMP_PARENT", "候选审查报告只能创建在 /tmp 的真实目录内。");
  }
  return parent;
}

function createReviewDirectory(temporaryParent, syncDirectoryPath) {
  const parent = resolveTemporaryParent(temporaryParent);
  let directory;
  let directoryOwnership = null;
  try {
    directory = mkdtempSync(join(parent, REPORT_DIRECTORY_PREFIX));
    const createdIdentity = statIdentity(lstatSync(directory));
    directoryOwnership = openOwnedPath(directory, {
      code: "SUPPLY_CHAIN_REVIEW_TEMP_PERMISSIONS",
      createdIdentity,
      directory: true,
      mode: 0o700,
    });
    syncDirectoryPath(directory);
    syncDirectoryPath(parent);
  } catch (error) {
    if (directory !== undefined && directoryOwnership !== null) {
      try {
        cleanupReviewDirectory({
          directory,
          directoryOwnership,
          parent,
          receiptOwnership: null,
          receiptPath: null,
          reportOwnership: null,
          reportPath: null,
        }, syncDirectoryPath);
      } catch (cleanupError) {
        if (cleanupError instanceof NpmIsolationError) throw cleanupError;
        fail(
          "SUPPLY_CHAIN_REVIEW_CLEANUP_UNCERTAIN",
          "候选审查临时目录创建失败且无法确认清理所有权。",
        );
      }
    } else if (directory !== undefined) {
      fail(
        "SUPPLY_CHAIN_REVIEW_CLEANUP_UNCERTAIN",
        "候选审查临时目录创建后未能取得所有权句柄；路径已保留。",
      );
    }
    if (error instanceof NpmIsolationError) throw error;
    fail("SUPPLY_CHAIN_REVIEW_TEMP_CREATE", "候选审查临时目录创建失败。");
  }
  return {
    directory,
    directoryOwnership,
    parent,
    receiptOwnership: null,
    receiptPath: null,
    reportOwnership: null,
    reportPath: null,
  };
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    fsyncSync(descriptor);
  } catch {
    fail("SUPPLY_CHAIN_REVIEW_REPORT_SYNC", "候选审查报告目录同步失败。");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertReviewStateOwned(state, code) {
  assertHeldPath(state.directory, state.directoryOwnership, {
    code,
    directory: true,
    mode: 0o700,
  });
  const expectedEntries = [
    ...(state.receiptOwnership === null ? [] : [RECEIPT_FILE_NAME]),
    ...(state.reportOwnership === null ? [] : [REPORT_FILE_NAME]),
  ].sort();
  let entries;
  try {
    entries = readdirSync(state.directory).sort();
  } catch {
    fail(code, "候选审查报告目录内容无法复核。");
  }
  if (
    entries.length !== expectedEntries.length
    || entries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    fail(code, "候选审查报告目录包含不属于本次任务的内容。");
  }
  if (state.reportOwnership !== null) {
    assertHeldPath(state.reportPath, state.reportOwnership, {
      code,
      directory: false,
      mode: 0o600,
    });
    if (!descriptorMatchesSnapshot(state.reportOwnership)) {
      fail(code, "候选审查报告字节在所有权核验期间发生变化。");
    }
  }
  if (state.receiptOwnership !== null) {
    assertHeldPath(state.receiptPath, state.receiptOwnership, {
      code,
      directory: false,
      mode: 0o600,
    });
    if (!descriptorMatchesSnapshot(state.receiptOwnership)) {
      fail(code, "候选审查 receipt 字节在所有权核验期间发生变化。");
    }
  }
}

function writePrivateArtifacts(state, reportBytes, receiptBytes, syncDirectoryPath) {
  if (
    typeof reportBytes !== "string"
    || reportBytes === ""
    || !reportBytes.endsWith("\n")
    || typeof receiptBytes !== "string"
    || receiptBytes === ""
    || !receiptBytes.endsWith("\n")
  ) {
    fail("SUPPLY_CHAIN_REVIEW_REPORT_BYTES", "候选审查报告不是 canonical JSON 文本。");
  }
  const reportPath = join(state.directory, REPORT_FILE_NAME);
  try {
    const descriptor = openSync(
      reportPath,
      constants.O_RDWR
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    state.reportPath = reportPath;
    state.reportOwnership = {
      descriptor,
      identity: statIdentity(fstatSync(descriptor)),
      snapshot: Buffer.from(reportBytes, "utf8"),
    };
    fchmodSync(descriptor, 0o600);
    const descriptorStat = fstatSync(descriptor);
    if (!validateOwnedStat(descriptorStat, { directory: false, mode: 0o600 })) {
      fail(
        "SUPPLY_CHAIN_REVIEW_REPORT_PERMISSIONS",
        "候选审查报告类型、权限、链接或所有者不受控。",
      );
    }
    state.reportOwnership.identity = statIdentity(descriptorStat);
    writeFileSync(descriptor, reportBytes, "utf8");
    fsyncSync(descriptor);

    const receiptPath = join(state.directory, RECEIPT_FILE_NAME);
    const receiptDescriptor = openSync(
      receiptPath,
      constants.O_RDWR
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    state.receiptPath = receiptPath;
    state.receiptOwnership = {
      descriptor: receiptDescriptor,
      identity: statIdentity(fstatSync(receiptDescriptor)),
      snapshot: Buffer.from(receiptBytes, "utf8"),
    };
    fchmodSync(receiptDescriptor, 0o600);
    const receiptDescriptorStat = fstatSync(receiptDescriptor);
    if (!validateOwnedStat(receiptDescriptorStat, { directory: false, mode: 0o600 })) {
      fail(
        "SUPPLY_CHAIN_REVIEW_REPORT_PERMISSIONS",
        "候选审查 receipt 类型、权限、链接或所有者不受控。",
      );
    }
    state.receiptOwnership.identity = statIdentity(receiptDescriptorStat);
    writeFileSync(receiptDescriptor, receiptBytes, "utf8");
    fsyncSync(receiptDescriptor);
  } catch (error) {
    if (error instanceof NpmIsolationError) throw error;
    fail("SUPPLY_CHAIN_REVIEW_REPORT_WRITE", "候选审查报告写入或同步失败。");
  }
  syncDirectoryPath(state.directory);
  syncDirectoryPath(state.parent);
  assertReviewStateOwned(state, "SUPPLY_CHAIN_REVIEW_REPORT_UNCERTAIN");
  return { receiptPath: state.receiptPath, reportPath };
}

function cleanupReviewDirectory(state, syncDirectoryPath) {
  let quarantineDirectory = null;
  let quarantineOwnership = null;
  try {
    quarantineDirectory = mkdtempSync(join(state.parent, CLEANUP_QUARANTINE_PREFIX));
    const createdIdentity = statIdentity(lstatSync(quarantineDirectory));
    quarantineOwnership = openOwnedPath(quarantineDirectory, {
      code: "SUPPLY_CHAIN_REVIEW_CLEANUP_UNCERTAIN",
      createdIdentity,
      directory: true,
      mode: 0o700,
    });
    const quarantinePath = join(quarantineDirectory, basename(state.directory));
    renameSync(state.directory, quarantinePath);
    syncDirectoryPath(state.parent);
    fsyncSync(quarantineOwnership.descriptor);
    refreshHeldDirectoryIdentity(
      quarantineDirectory,
      quarantineOwnership,
      3,
      "SUPPLY_CHAIN_REVIEW_CLEANUP_UNCERTAIN",
    );

    assertHeldPath(quarantineDirectory, quarantineOwnership, {
      code: "SUPPLY_CHAIN_REVIEW_CLEANUP_UNCERTAIN",
      directory: true,
      mode: 0o700,
    });
    assertHeldPath(quarantinePath, state.directoryOwnership, {
      code: "SUPPLY_CHAIN_REVIEW_CLEANUP_UNCERTAIN",
      directory: true,
      mode: 0o700,
    });
    const expectedEntries = [
      ...(state.receiptOwnership === null ? [] : [RECEIPT_FILE_NAME]),
      ...(state.reportOwnership === null ? [] : [REPORT_FILE_NAME]),
    ].sort();
    const entries = readdirSync(quarantinePath).sort();
    if (
      entries.length !== expectedEntries.length
      || entries.some((entry, index) => entry !== expectedEntries[index])
    ) {
      fail(
        "SUPPLY_CHAIN_REVIEW_CLEANUP_UNCERTAIN",
        "候选审查隔离目录包含不属于本次任务的内容；当前状态已保留。",
      );
    }
    const ownedFiles = [
      ...(state.reportOwnership === null ? [] : [{
        name: REPORT_FILE_NAME,
        ownership: state.reportOwnership,
        ownershipKey: "reportOwnership",
      }]),
      ...(state.receiptOwnership === null ? [] : [{
        name: RECEIPT_FILE_NAME,
        ownership: state.receiptOwnership,
        ownershipKey: "receiptOwnership",
      }]),
    ];
    for (const file of ownedFiles) {
      const quarantineFilePath = join(quarantinePath, file.name);
      assertHeldPath(quarantineFilePath, file.ownership, {
        code: "SUPPLY_CHAIN_REVIEW_CLEANUP_UNCERTAIN",
        directory: false,
        mode: 0o600,
      });
      if (!descriptorMatchesSnapshot(file.ownership)) {
        fail(
          "SUPPLY_CHAIN_REVIEW_CLEANUP_UNCERTAIN",
          "候选审查隔离制品字节发生变化；外部状态已保留。",
        );
      }
    }
    for (const file of ownedFiles) {
      unlinkSync(join(quarantinePath, file.name));
      fsyncSync(state.directoryOwnership.descriptor);
      closeOwnership(file.ownership);
      state[file.ownershipKey] = null;
    }
    rmdirSync(quarantinePath);
    fsyncSync(quarantineOwnership.descriptor);
    closeOwnership(state.directoryOwnership);
    state.directoryOwnership = null;
    refreshHeldDirectoryIdentity(
      quarantineDirectory,
      quarantineOwnership,
      2,
      "SUPPLY_CHAIN_REVIEW_CLEANUP_UNCERTAIN",
    );
    if (readdirSync(quarantineDirectory).length !== 0) {
      fail(
        "SUPPLY_CHAIN_REVIEW_CLEANUP_UNCERTAIN",
        "候选审查 quarantine 包含来源不明的额外内容。",
      );
    }
    assertHeldPath(quarantineDirectory, quarantineOwnership, {
      code: "SUPPLY_CHAIN_REVIEW_CLEANUP_UNCERTAIN",
      directory: true,
      mode: 0o700,
    });
    rmdirSync(quarantineDirectory);
    syncDirectoryPath(state.parent);
    closeOwnership(quarantineOwnership);
  } catch (error) {
    closeOwnershipQuietly(state.reportOwnership);
    closeOwnershipQuietly(state.receiptOwnership);
    closeOwnershipQuietly(state.directoryOwnership);
    closeOwnershipQuietly(quarantineOwnership);
    if (
      error instanceof NpmIsolationError
      && error.code === "SUPPLY_CHAIN_REVIEW_CLEANUP_UNCERTAIN"
    ) {
      throw error;
    }
    fail(
      "SUPPLY_CHAIN_REVIEW_CLEANUP_UNCERTAIN",
      "候选审查失败状态无法安全隔离并确认所有权；未知状态已保留。",
    );
  }
}

function removeFailedReviewDirectory(state, originalError, syncDirectoryPath) {
  cleanupReviewDirectory(state, syncDirectoryPath);
  throw originalError;
}

export function parseCandidateReviewArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length !== 0) {
    fail("SUPPLY_CHAIN_REVIEW_ARGUMENTS", "候选审查入口不接受任何参数。");
  }
  return {};
}

export async function reviewSupplyChainCandidates({
  root,
  temporaryParent = "/tmp",
  npmVersionsByRole = NPM_VERSIONS_BY_ROLE,
  nodeVersion = process.versions.node,
  reviewTarballs = reviewLockedPackageTarballs,
  download = downloadRegistryTarball,
  syncDirectoryPath = syncDirectory,
} = {}) {
  if (
    typeof root !== "string"
    || root === ""
    || typeof reviewTarballs !== "function"
    || typeof download !== "function"
    || typeof syncDirectoryPath !== "function"
  ) {
    fail("SUPPLY_CHAIN_REVIEW_ORCHESTRATION", "候选审查编排输入不合法。");
  }
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(resolve(root));
  } catch {
    fail("SUPPLY_CHAIN_REVIEW_ROOT", "候选审查仓库根目录不可用。");
  }

  const inputHashes = captureSupplyChainInputHashes(canonicalRoot);
  validateProjectNpmrc(canonicalRoot);
  const manifest = readAndValidateManifest(canonicalRoot);
  assertNoCompetingPackageManagerInputs(canonicalRoot);
  const resolvedNpmRuntime = deriveNpmCli(process.execPath);
  if (
    resolvedNpmRuntime === null
    || typeof resolvedNpmRuntime !== "object"
    || typeof resolvedNpmRuntime.npmVersion !== "string"
  ) {
    fail("SUPPLY_CHAIN_REVIEW_RUNTIME", "候选审查无法确认当前 npm 端点。");
  }
  if (nodeVersion !== process.versions.node) {
    fail("NPM_RUNTIME_PROCESS", "声明的 Node 版本与当前进程不一致。");
  }
  const runtime = validateRuntimeContract({
    root: canonicalRoot,
    nodeVersion,
    npmVersion: resolvedNpmRuntime.npmVersion,
    manifest,
    npmVersionsByRole,
  });
  if (runtime.role !== "primary") {
    fail("SUPPLY_CHAIN_REVIEW_PRIMARY_ONLY", "候选审查只允许 .nvmrc 主端点执行。");
  }
  const lockfile = readAndValidateLockfile(canonicalRoot, manifest);
  const policy = readAndValidateDependencyPolicy(canonicalRoot);
  const licenseEvidence = readAndValidateDependencyLicenseEvidence(canonicalRoot);
  const lockedPackages = collectLockedPackages(lockfile, manifest);
  const receipt = createSupplyChainInputReceipt({ inputs: inputHashes, runtime });
  const assertInputsUnchanged = () => assertSupplyChainInputReceiptCurrent({
    code: "SUPPLY_CHAIN_REVIEW_INPUT_DRIFT",
    npmVersionsByRole,
    receipt,
    requiredRole: "primary",
    root: canonicalRoot,
  });
  assertInputsUnchanged();

  const reviewState = createReviewDirectory(temporaryParent, syncDirectoryPath);
  try {
    const guardedDownload = async (lockedPackage, downloadOptions) => {
      assertInputsUnchanged();
      let bytes;
      try {
        bytes = await download(lockedPackage, downloadOptions);
        assertInputsUnchanged();
        return bytes;
      } catch (error) {
        if (Buffer.isBuffer(bytes)) bytes.fill(0);
        throw error;
      }
    };
    assertInputsUnchanged();
    const inspections = await reviewTarballs({
      download: guardedDownload,
      licenseEvidence,
      lockedPackages,
      validateInspection: validateSupplyChainReviewInspection,
    });
    assertInputsUnchanged();
    const reportBytes = renderSupplyChainReviewReport({
      inspections,
      licenseEvidence,
      lockedPackages,
      policy,
      receipt,
    });
    const receiptBytes = supplyChainInputReceiptBytes(receipt);
    assertInputsUnchanged();
    const { receiptPath, reportPath } = writePrivateArtifacts(
      reviewState,
      reportBytes,
      receiptBytes,
      syncDirectoryPath,
    );
    assertInputsUnchanged();
    assertReviewStateOwned(reviewState, "SUPPLY_CHAIN_REVIEW_REPORT_UNCERTAIN");
    closeOwnership(reviewState.reportOwnership);
    reviewState.reportOwnership = null;
    closeOwnership(reviewState.receiptOwnership);
    reviewState.receiptOwnership = null;
    closeOwnership(reviewState.directoryOwnership);
    reviewState.directoryOwnership = null;
    return {
      packageCount: lockedPackages.length,
      receiptPath,
      reportPath,
      receiptSha256: supplyChainInputReceiptSha256(receipt),
    };
  } catch (error) {
    removeFailedReviewDirectory(reviewState, error, syncDirectoryPath);
  }
}

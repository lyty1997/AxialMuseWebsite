import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { validateAdmissionClosure } from "./admission.mjs";
import {
  assertNoCompetingPackageManagerInputs,
  readAndValidateManifest,
  validateProjectNpmrc,
  validateRuntimeContract,
} from "./config.mjs";
import { NPM_VERSIONS_BY_ROLE } from "./contracts.mjs";
import { deriveNpmCli } from "./environment.mjs";
import { fail } from "./errors.mjs";
import {
  hashProjectFile,
  readAndValidateLockfile,
} from "./lockfile.mjs";
import { readAndValidateDependencyLicenseEvidence } from "./license-evidence.mjs";
import {
  readAndValidateDependencyAdmissions,
  readAndValidateDependencyPolicy,
} from "./policy.mjs";
import { generateSupplyChainArtifacts } from "./sbom-artifacts.mjs";
import {
  downloadRegistryTarball,
  reviewLockedPackageTarballs,
} from "./tarball-download.mjs";

const FORMAL_INPUT_PATHS = Object.freeze([
  ".npmrc",
  ".nvmrc",
  "docs/contracts/dependency-admissions.json",
  "docs/contracts/dependency-license-evidence.json",
  "docs/contracts/dependency-policy.json",
  "package-lock.json",
  "package.json",
]);

function hashFormalInputs(root) {
  return Object.fromEntries(FORMAL_INPUT_PATHS.map((relativePath) => [
    relativePath,
    hashProjectFile(root, relativePath),
  ]));
}

function assertFormalInputsUnchanged(root, expected) {
  try {
    assertNoCompetingPackageManagerInputs(root);
    for (const relativePath of FORMAL_INPUT_PATHS) {
      if (hashProjectFile(root, relativePath) !== expected[relativePath]) {
        fail("SPDX_INPUT_CONCURRENT_CHANGE", "正式供应链生成期间固定输入发生变化。" );
      }
    }
  } catch (error) {
    if (error?.code === "SPDX_INPUT_CONCURRENT_CHANGE") throw error;
    fail("SPDX_INPUT_CONCURRENT_CHANGE", "正式供应链生成期间固定输入不可读或发生变化。" );
  }
}

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function cleanupFormalGenerationLock(lock) {
  let closed = false;
  try {
    const descriptorStat = fstatSync(lock.descriptor);
    const canonicalStat = lstatSync(lock.path);
    if (
      !canonicalStat.isFile()
      || canonicalStat.isSymbolicLink()
      || canonicalStat.nlink !== 1
      || descriptorStat.dev !== canonicalStat.dev
      || descriptorStat.ino !== canonicalStat.ino
    ) {
      fail(
        "SPDX_FORMAL_GENERATION_LOCK_CLEANUP",
        "正式供应链生成锁已被替换；外部 canonical marker 已保留。",
      );
    }
    const quarantineDirectory = mkdtempSync(join(
      lock.parent,
      `.${basename(lock.path)}.cleanup-`,
    ));
    const quarantinePath = join(quarantineDirectory, basename(lock.path));
    renameSync(lock.path, quarantinePath);
    syncDirectory(lock.parent);
    syncDirectory(quarantineDirectory);
    const pathStat = lstatSync(quarantinePath);
    if (
      !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || pathStat.nlink !== 1
      || descriptorStat.dev !== pathStat.dev
      || descriptorStat.ino !== pathStat.ino
    ) {
      fail(
        "SPDX_FORMAL_GENERATION_LOCK_CLEANUP",
        "正式供应链生成锁在清理窗口被替换；隔离 marker 已保留。",
      );
    }
    closeSync(lock.descriptor);
    closed = true;
    unlinkSync(quarantinePath);
    syncDirectory(quarantineDirectory);
    rmSync(quarantineDirectory, { recursive: true });
    syncDirectory(lock.parent);
  } catch (error) {
    if (!closed) {
      try {
        closeSync(lock.descriptor);
      } catch {
        // 下面统一以锁清理失败结束，且不会删除身份不明的路径。
      }
    }
    if (error?.code === "SPDX_FORMAL_GENERATION_LOCK_CLEANUP") throw error;
    fail("SPDX_FORMAL_GENERATION_LOCK_CLEANUP", "正式供应链生成锁无法安全清理。" );
  }
}

function acquireFormalGenerationLock(root) {
  const parent = resolve(root, "docs/generated");
  try {
    mkdirSync(parent, { recursive: true, mode: 0o755 });
    const parentStat = lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      fail("SPDX_FORMAL_GENERATION_LOCK", "正式供应链生成锁父目录不受控。" );
    }
  } catch (error) {
    if (error?.code === "SPDX_FORMAL_GENERATION_LOCK") throw error;
    fail("SPDX_FORMAL_GENERATION_LOCK", "正式供应链生成锁父目录不可用。" );
  }
  const path = resolve(parent, ".supply-chain.formal.lock");
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(path, "wx", 0o600);
    created = true;
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile()
      || stat.nlink !== 1
      || (stat.mode & 0o777) !== 0o600
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      fail("SPDX_FORMAL_GENERATION_LOCK", "正式供应链生成锁类型或权限不受控。" );
    }
    fsyncSync(descriptor);
    syncDirectory(parent);
  } catch (error) {
    if (descriptor !== undefined && created) {
      cleanupFormalGenerationLock({ descriptor, parent, path });
    }
    if (error?.code === "SPDX_FORMAL_GENERATION_LOCK") throw error;
    fail("SPDX_FORMAL_GENERATION_LOCKED", "已有正式供应链生成任务持有排他锁。" );
  }
  return { descriptor, parent, path };
}

function releaseFormalGenerationLock(lock) {
  cleanupFormalGenerationLock(lock);
}

export async function generateReviewedSupplyChainArtifacts({
  root,
  createdAt = null,
  npmVersionsByRole = NPM_VERSIONS_BY_ROLE,
  nodeVersion = process.versions.node,
  reviewTarballs = reviewLockedPackageTarballs,
  download = downloadRegistryTarball,
  generate = generateSupplyChainArtifacts,
  ...generationOptions
} = {}) {
  if (
    typeof root !== "string"
    || root === ""
    || typeof reviewTarballs !== "function"
    || typeof download !== "function"
    || typeof generate !== "function"
  ) {
    fail("SPDX_FORMAL_GENERATION_INPUT", "正式供应链生成编排输入不合法。" );
  }
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(resolve(root));
  } catch {
    fail("SPDX_FORMAL_GENERATION_ROOT", "正式供应链生成仓库根目录不可用。" );
  }
  let canonicalCwd;
  try {
    canonicalCwd = realpathSync(resolve(process.cwd()));
  } catch {
    fail("NPM_ROOT_CWD", "正式供应链生成无法确认当前工作目录。" );
  }
  if (canonicalCwd !== canonicalRoot) {
    fail("NPM_ROOT_CWD", "正式供应链生成必须从仓库根目录启动。" );
  }

  const inputHashes = hashFormalInputs(canonicalRoot);
  validateProjectNpmrc(canonicalRoot);
  assertNoCompetingPackageManagerInputs(canonicalRoot);
  const manifest = readAndValidateManifest(canonicalRoot);
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
    fail("SPDX_PRIMARY_ONLY", "正式供应链生成只允许 .nvmrc 主端点执行。" );
  }
  const lockfile = readAndValidateLockfile(canonicalRoot, manifest);
  readAndValidateDependencyPolicy(canonicalRoot);
  const licenseEvidence = readAndValidateDependencyLicenseEvidence(canonicalRoot);
  const admissions = readAndValidateDependencyAdmissions(canonicalRoot);
  const lockedPackages = validateAdmissionClosure({ lockfile, manifest, admissions });
  assertFormalInputsUnchanged(canonicalRoot, inputHashes);
  const formalLock = acquireFormalGenerationLock(canonicalRoot);
  let pendingError;
  try {
    const guardedDownload = async (lockedPackage, downloadOptions) => {
      assertFormalInputsUnchanged(canonicalRoot, inputHashes);
      let bytes;
      try {
        bytes = await download(lockedPackage, downloadOptions);
        assertFormalInputsUnchanged(canonicalRoot, inputHashes);
        return bytes;
      } catch (error) {
        if (Buffer.isBuffer(bytes)) bytes.fill(0);
        throw error;
      }
    };
    const inspections = await reviewTarballs({
      download: guardedDownload,
      licenseEvidence,
      lockedPackages,
    });
    assertFormalInputsUnchanged(canonicalRoot, inputHashes);
    return await generate({
      ...generationOptions,
      createdAt,
      nodeVersion,
      npmVersionsByRole,
      root: canonicalRoot,
      licenseEvidence,
      tarballInspections: inspections,
    });
  } catch (error) {
    pendingError = error;
    throw error;
  } finally {
    try {
      releaseFormalGenerationLock(formalLock);
    } catch {
      if (pendingError?.code) {
        fail(
          "SPDX_FORMAL_GENERATION_LOCK_CLEANUP_AFTER_FAILURE",
          `${pendingError.code} 后正式生成锁清理失败。`,
        );
      }
      fail("SPDX_FORMAL_GENERATION_LOCK_CLEANUP", "正式生成完成后锁清理失败。" );
    }
  }
}

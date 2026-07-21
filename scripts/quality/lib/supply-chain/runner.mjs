import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertParsedNpmAuditResultAllowed,
  parseNpmAuditResult,
} from "./audit.mjs";
import { NPM_VERSIONS_BY_ROLE } from "./contracts.mjs";
import {
  assertNoCompetingPackageManagerInputs,
  readAndValidateManifest,
  validateProjectNpmrc,
  validateRuntimeContract,
} from "./config.mjs";
import {
  assertEnvironmentIsClosed,
  createIsolationWorkspace,
  deriveNpmCli,
  parseAndValidateEffectiveConfig,
  removeIsolationWorkspace,
} from "./environment.mjs";
import { fail, NpmIsolationError } from "./errors.mjs";
import {
  hashProjectFile,
  readAndValidateLockfile,
  readAndValidateLockfileSource,
} from "./lockfile.mjs";
import { readAndValidateDependencyPolicy } from "./policy.mjs";
import { buildProfileArguments, profileRequiresLockfile } from "./profiles.mjs";

function validateRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    fail("NPM_ROOT_ABSOLUTE", "npm 隔离入口只接受仓库规范绝对根目录。" );
  }
  let canonicalRoot;
  let canonicalCwd;
  try {
    canonicalRoot = realpathSync(root);
    canonicalCwd = realpathSync(process.cwd());
  } catch {
    fail("NPM_ROOT_REALPATH", "仓库根目录或当前工作目录无法规范化。" );
  }
  if (canonicalRoot !== root || canonicalCwd !== canonicalRoot) {
    fail("NPM_ROOT_CWD", "必须从真实仓库根目录执行 npm 隔离入口。" );
  }
  return canonicalRoot;
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

function assertLocalBinConfined(root) {
  const nodeModules = join(root, "node_modules");
  if (!existsSync(nodeModules)) return;

  let nodeModulesStat;
  let canonicalNodeModules;
  try {
    nodeModulesStat = lstatSync(nodeModules);
    canonicalNodeModules = realpathSync(nodeModules);
  } catch {
    fail("NPM_LOCAL_BIN_PATH", "node_modules 路径无法规范化。" );
  }
  if (
    !nodeModulesStat.isDirectory()
    || nodeModulesStat.isSymbolicLink()
    || !isInside(root, canonicalNodeModules)
  ) {
    fail("NPM_LOCAL_BIN_ESCAPE", "node_modules 必须是仓库内的真实目录。" );
  }

  const localBin = join(nodeModules, ".bin");
  if (!existsSync(localBin)) return;
  const localBinStat = lstatSync(localBin);
  if (!localBinStat.isDirectory() || localBinStat.isSymbolicLink()) {
    fail("NPM_LOCAL_BIN_ESCAPE", "node_modules/.bin 必须是仓库内的真实目录。" );
  }
  for (const entry of readdirSync(localBin, { withFileTypes: true })) {
    const entryPath = join(localBin, entry.name);
    let target;
    try {
      target = realpathSync(entryPath);
    } catch {
      fail("NPM_LOCAL_BIN_PATH", "node_modules/.bin 包含无法解析的入口。" );
    }
    if ((!entry.isFile() && !entry.isSymbolicLink()) || !isInside(canonicalNodeModules, target)) {
      fail("NPM_LOCAL_BIN_ESCAPE", "node_modules/.bin 入口逃逸仓库依赖树。" );
    }
  }
}

function runChild(
  runProcess,
  executable,
  arguments_,
  options,
  phase,
  { allowedStatuses = [0] } = {},
) {
  const result = runProcess(executable, arguments_, {
    ...options,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result?.error) {
    fail(`NPM_${phase}_SPAWN`, `${phase} 子进程无法启动。`);
  }
  if (
    typeof result?.status !== "number"
    || !allowedStatuses.includes(result.status)
    || (result.signal !== undefined && result.signal !== null)
  ) {
    fail(`NPM_${phase}_FAILED`, `${phase} 子进程以非零状态退出。`);
  }
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function assertUnchanged(root, before, relativePath, optional = false) {
  const after = hashProjectFile(root, relativePath, { optional });
  if (after !== before) {
    fail("NPM_INPUT_DRIFT", `${relativePath} 在隔离 npm profile 执行期间发生变化。`);
  }
}

function assertProjectInputsUnchanged(root, hashes, manifest, { allowOverrideDrift = false } = {}) {
  assertUnchanged(root, hashes.npmrc, ".npmrc");
  assertUnchanged(root, hashes.nvmrc, ".nvmrc");
  assertUnchanged(root, hashes.manifest, "package.json");
  assertUnchanged(root, hashes.lockfile, "package-lock.json", true);
  if (hashes.dependencyPolicy !== null) {
    assertUnchanged(
      root,
      hashes.dependencyPolicy,
      "docs/contracts/dependency-policy.json",
    );
  }
  assertNoCompetingPackageManagerInputs(root);
  validateProjectNpmrc(root);
  readAndValidateManifest(root);
  if (hashes.lockfile !== null) {
    readAndValidateLockfile(root, manifest, { allowOverrideDrift });
  }
}

function createStagedInputRoot(workspace, root, {
  directoryName,
  errorCode,
  expectedHashes,
  requireLockfile,
}) {
  const stagedRoot = join(workspace.paths.root, directoryName);
  mkdirSync(stagedRoot, { mode: 0o700 });
  chmodSync(stagedRoot, 0o700);
  copyFileSync(join(root, "package.json"), join(stagedRoot, "package.json"));
  copyFileSync(join(root, ".npmrc"), join(stagedRoot, ".npmrc"));
  if (existsSync(join(root, "package-lock.json"))) {
    copyFileSync(join(root, "package-lock.json"), join(stagedRoot, "package-lock.json"));
    chmodSync(join(stagedRoot, "package-lock.json"), 0o600);
  }
  chmodSync(join(stagedRoot, "package.json"), 0o600);
  chmodSync(join(stagedRoot, ".npmrc"), 0o600);
  const hashes = {
    npmrc: hashProjectFile(stagedRoot, ".npmrc"),
    manifest: hashProjectFile(stagedRoot, "package.json"),
    lockfile: hashProjectFile(stagedRoot, "package-lock.json", { optional: true }),
  };
  if (
    hashes.npmrc !== expectedHashes.npmrc
    || hashes.manifest !== expectedHashes.manifest
    || hashes.lockfile !== expectedHashes.lockfile
    || (requireLockfile && hashes.lockfile === null)
  ) {
    fail(errorCode, "npm 暂存输入与本次运行最初验证的根输入不一致。" );
  }
  return { root: stagedRoot, hashes };
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function pathExists(path, code) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail(code, "受控发布路径状态不可读。" );
  }
}

function identityFromStat(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    modeType: stat.mode & 0o170000,
    mode: stat.mode & 0o777,
    nlink: stat.nlink,
    uid: stat.uid,
  };
}

function identitiesEqual(left, right) {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino
    && left.modeType === right.modeType
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid;
}

function assertControlledFileStat(stat, code, { expectedMode = null } = {}) {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (expectedMode !== null && (stat.mode & 0o777) !== expectedMode)
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    fail(code, "受控发布文件的类型、权限、链接数或所有权不合法。" );
  }
}

function readDescriptorSnapshot(descriptor, code) {
  let stat;
  try {
    stat = fstatSync(descriptor);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
      fail(code, "受控发布文件大小不合法。" );
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail(code, "受控发布文件快照读取不完整。" );
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (!identitiesEqual(identityFromStat(stat), identityFromStat(after)) || after.size !== stat.size) {
      fail(code, "受控发布文件在快照读取期间发生变化。" );
    }
    return bytes;
  } catch (error) {
    if (error instanceof NpmIsolationError) throw error;
    fail(code, "受控发布文件快照无法读取。" );
  }
}

function capturePathIdentity(path, code, { expectedMode = null, expectedNlink = 1 } = {}) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(code, "受控发布文件路径身份不可读。" );
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== expectedNlink
    || (expectedMode !== null && (stat.mode & 0o777) !== expectedMode)
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    fail(code, "受控发布文件路径类型、权限、链接数或所有权不合法。" );
  }
  return identityFromStat(stat);
}

function holdOwnedFile(path, code, { expectedMode = null } = {}) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptorStat = fstatSync(descriptor);
    assertControlledFileStat(descriptorStat, code, { expectedMode });
    const identity = identityFromStat(descriptorStat);
    if (!identitiesEqual(identity, capturePathIdentity(path, code, { expectedMode }))) {
      fail(code, "受控发布文件在取得所有权句柄期间发生变化。" );
    }
    const ownership = {
      descriptor,
      identity,
      path,
      snapshot: readDescriptorSnapshot(descriptor, code),
    };
    assertOwnedFile(ownership, path, code);
    return ownership;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 统一以无法取得受控所有权句柄失败，且不按路径删除任何对象。
      }
    }
    if (error instanceof NpmIsolationError) throw error;
    fail(code, "受控发布文件无法取得所有权句柄。" );
  }
}

function createOwnedFile(path, bytes, mode, code, syncFile = fsyncSync) {
  const ownership = {
    descriptor: null,
    identity: null,
    path,
    snapshot: Buffer.from(bytes),
  };
  try {
    ownership.descriptor = openSync(
      path,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_RDWR
        | constants.O_NOFOLLOW,
      mode,
    );
    fchmodSync(ownership.descriptor, mode);
    const initialStat = fstatSync(ownership.descriptor);
    assertControlledFileStat(initialStat, code, { expectedMode: mode });
    ownership.identity = identityFromStat(initialStat);
    if (!identitiesEqual(
      ownership.identity,
      capturePathIdentity(path, code, { expectedMode: mode }),
    )) {
      fail(code, "受控候选文件在创建窗口发生变化。" );
    }
    writeFileSync(ownership.descriptor, ownership.snapshot);
    syncFile(ownership.descriptor);
    updateOwnedFileLinkCount(ownership, 1, code);
    assertOwnedFile(ownership, path, code);
    return ownership;
  } catch (error) {
    error.ownedFile = ownership;
    throw error;
  }
}

function assertOwnedFile(ownership, path, code) {
  let descriptorIdentity;
  try {
    descriptorIdentity = identityFromStat(fstatSync(ownership.descriptor));
  } catch {
    fail(code, "受控发布文件描述符状态不可读。" );
  }
  const pathIdentity = capturePathIdentity(path, code, {
    expectedMode: ownership.identity.mode,
    expectedNlink: ownership.identity.nlink,
  });
  const snapshot = readDescriptorSnapshot(ownership.descriptor, code);
  if (
    !identitiesEqual(descriptorIdentity, ownership.identity)
    || !identitiesEqual(pathIdentity, ownership.identity)
    || !snapshot.equals(ownership.snapshot)
  ) {
    fail(code, "受控发布文件不再属于本任务；外部状态已保留。" );
  }
}

function updateOwnedFileLinkCount(ownership, expectedNlink, code) {
  let nextIdentity;
  try {
    nextIdentity = identityFromStat(fstatSync(ownership.descriptor));
  } catch {
    fail(code, "受控发布文件的链接数转换无法读取。" );
  }
  const previousIdentity = ownership.identity;
  if (
    nextIdentity.dev !== previousIdentity.dev
    || nextIdentity.ino !== previousIdentity.ino
    || nextIdentity.modeType !== previousIdentity.modeType
    || nextIdentity.mode !== previousIdentity.mode
    || nextIdentity.uid !== previousIdentity.uid
    || nextIdentity.nlink !== expectedNlink
    || !readDescriptorSnapshot(ownership.descriptor, code).equals(ownership.snapshot)
  ) {
    fail(code, "受控发布文件的链接数或文件身份发生了非预期变化。" );
  }
  ownership.identity = nextIdentity;
}

function releaseOwnedFile(ownership) {
  if (ownership?.descriptor === null || ownership?.descriptor === undefined) return;
  try {
    closeSync(ownership.descriptor);
  } finally {
    ownership.descriptor = null;
  }
}

function holdQuarantineDirectory(path, code) {
  let descriptor;
  try {
    chmodSync(path, 0o700);
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const descriptorStat = fstatSync(descriptor);
    const pathStat = lstatSync(path);
    const descriptorIdentity = identityFromStat(descriptorStat);
    const pathIdentity = identityFromStat(pathStat);
    if (
      !descriptorStat.isDirectory()
      || descriptorStat.isSymbolicLink()
      || (descriptorStat.mode & 0o777) !== 0o700
      || (typeof process.getuid === "function" && descriptorStat.uid !== process.getuid())
      || !identitiesEqual(descriptorIdentity, pathIdentity)
      || readdirSync(path).length !== 0
    ) {
      fail(code, "发布隔离目录的类型、权限、所有权或初始状态不受控。" );
    }
    return { descriptor, identity: descriptorIdentity, path };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 统一以隔离目录无法持有失败，且不递归删除身份不明的路径。
      }
    }
    if (error instanceof NpmIsolationError) throw error;
    fail(code, "发布隔离目录无法取得受控所有权句柄。" );
  }
}

function assertOwnedQuarantineDirectory(directory, expectedEntry, code) {
  let descriptorIdentity;
  let pathIdentity;
  try {
    descriptorIdentity = identityFromStat(fstatSync(directory.descriptor));
    pathIdentity = identityFromStat(lstatSync(directory.path));
  } catch {
    fail(code, "发布隔离目录状态不可读。" );
  }
  if (
    !identitiesEqual(descriptorIdentity, directory.identity)
    || !identitiesEqual(pathIdentity, directory.identity)
    || readdirSync(directory.path).join("\n") !== (expectedEntry ?? "")
  ) {
    fail(code, "发布隔离目录已被替换或写入外部内容。" );
  }
}

function quarantineOwnedFile({
  ownership,
  path,
  code,
  afterOwnershipCheck = null,
  guardCurrent = null,
  syncParentDirectory = fsyncDirectory,
}) {
  assertOwnedFile(ownership, path, code);
  if (guardCurrent) guardCurrent();
  if (afterOwnershipCheck) afterOwnershipCheck(path);
  if (guardCurrent) guardCurrent();
  const parent = dirname(path);
  let directory = null;
  try {
    const directoryPath = mkdtempSync(join(
      parent,
      `.${basename(path)}.quarantine-`,
    ));
    directory = holdQuarantineDirectory(directoryPath, code);
    const quarantinePath = join(directory.path, basename(path));
    syncParentDirectory(parent);
    if (guardCurrent) guardCurrent();
    assertOwnedFile(ownership, path, code);
    assertOwnedQuarantineDirectory(directory, null, code);
    const previousNlink = ownership.identity.nlink;
    linkSync(path, quarantinePath);
    updateOwnedFileLinkCount(ownership, previousNlink + 1, code);
    assertOwnedFile(ownership, path, code);
    assertOwnedFile(ownership, quarantinePath, code);
    syncParentDirectory(parent);
    syncParentDirectory(directory.path);
    if (guardCurrent) guardCurrent();
    assertOwnedFile(ownership, path, code);
    assertOwnedFile(ownership, quarantinePath, code);
    assertOwnedQuarantineDirectory(directory, basename(quarantinePath), code);
    unlinkSync(path);
    updateOwnedFileLinkCount(ownership, previousNlink, code);
    assertOwnedFile(ownership, quarantinePath, code);
    syncParentDirectory(parent);
    syncParentDirectory(directory.path);
    if (guardCurrent) guardCurrent();
    assertOwnedFile(ownership, quarantinePath, code);
    assertOwnedQuarantineDirectory(directory, basename(quarantinePath), code);
    if (pathExists(path, code)) {
      fail(code, "受控路径摘离后被外部写入者占用；隔离状态已保留。" );
    }
    return { directory, ownership, parent, path: quarantinePath };
  } catch (error) {
    if (directory?.descriptor !== null && directory?.descriptor !== undefined) {
      try {
        closeSync(directory.descriptor);
        directory.descriptor = null;
      } catch {
        // 隔离状态仍保留；上层统一报告不确定失败。
      }
    }
    throw error;
  }
}

function removeOwnedQuarantine(
  quarantine,
  code,
  {
    keepOwnershipOpen = false,
    guardCurrent = null,
    remainingPath = null,
    syncParentDirectory = fsyncDirectory,
  } = {},
) {
  if (keepOwnershipOpen && typeof remainingPath !== "string") {
    fail(code, "保留受控文件句柄时必须声明唯一剩余路径。" );
  }
  assertOwnedFile(quarantine.ownership, quarantine.path, code);
  if (guardCurrent) guardCurrent();
  assertOwnedQuarantineDirectory(
    quarantine.directory,
    basename(quarantine.path),
    code,
  );
  if (keepOwnershipOpen) {
    assertOwnedFile(quarantine.ownership, remainingPath, code);
  }
  if (guardCurrent) guardCurrent();
  const previousNlink = quarantine.ownership.identity.nlink;
  unlinkSync(quarantine.path);
  syncParentDirectory(quarantine.directory.path);
  if (guardCurrent) guardCurrent();
  assertOwnedQuarantineDirectory(quarantine.directory, null, code);
  updateOwnedFileLinkCount(
    quarantine.ownership,
    previousNlink - 1,
    code,
  );
  if (keepOwnershipOpen) {
    assertOwnedFile(quarantine.ownership, remainingPath, code);
  } else {
    releaseOwnedFile(quarantine.ownership);
  }
  closeSync(quarantine.directory.descriptor);
  quarantine.directory.descriptor = null;
  rmdirSync(quarantine.directory.path);
  syncParentDirectory(quarantine.parent);
}

function cleanupOwnedPath({
  ownership,
  path,
  code,
  afterOwnershipCheck = null,
  guardCurrent = null,
  keepOwnershipOpen = false,
  remainingPath = null,
  syncParentDirectory = fsyncDirectory,
}) {
  if (!ownership || ownership.descriptor === null) return;
  const quarantine = quarantineOwnedFile({
    ownership,
    path,
    code,
    afterOwnershipCheck,
    guardCurrent,
    syncParentDirectory,
  });
  try {
    removeOwnedQuarantine(quarantine, code, {
      keepOwnershipOpen,
      guardCurrent,
      remainingPath,
      syncParentDirectory,
    });
  } catch (error) {
    if (
      quarantine.directory.descriptor !== null
      && quarantine.directory.descriptor !== undefined
    ) {
      try {
        closeSync(quarantine.directory.descriptor);
        quarantine.directory.descriptor = null;
      } catch {
        // 隔离状态仍保留；上层统一报告不确定失败。
      }
    }
    throw error;
  }
}

function resolverLockOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("NPM_RESOLVE_LOCK_OPTIONS", "解析锁清理选项必须是 object。" );
  }
  for (const name of ["afterOwnershipCheck", "syncParentDirectory"]) {
    if (options[name] !== undefined && typeof options[name] !== "function") {
      fail("NPM_RESOLVE_LOCK_OPTIONS", `解析锁清理选项 ${name} 必须是函数。`);
    }
  }
  return options;
}

function acquireResolverLock(root) {
  const path = join(root, ".e010-resolve-lock");
  let ownership = null;
  try {
    ownership = createOwnedFile(
      path,
      Buffer.from(`${process.pid}\n`, "utf8"),
      0o600,
      "NPM_RESOLVE_LOCK_CREATE",
    );
    fsyncDirectory(root);
    assertOwnedFile(ownership, path, "NPM_RESOLVE_LOCK_CREATE");
    return { ...ownership, parent: root };
  } catch (error) {
    ownership ??= error?.ownedFile ?? null;
    if (ownership?.descriptor !== null && ownership?.identity !== null) {
      try {
        cleanupOwnedPath({
          ownership,
          path,
          code: "NPM_RESOLVE_LOCK_CREATE_CLEANUP",
        });
      } catch {
        releaseOwnedFile(ownership);
        fail("NPM_RESOLVE_LOCK_CREATE_CLEANUP", "解析锁创建失败且无法安全清理本次残留。" );
      }
    } else {
      releaseOwnedFile(ownership);
    }
    if (error?.code === "EEXIST") {
      fail("NPM_RESOLVE_CONCURRENT", "已有 resolve-lock 操作或未清理的解析锁。" );
    }
    if (error instanceof NpmIsolationError) throw error;
    fail("NPM_RESOLVE_LOCK_CREATE", "resolve-lock 排他锁无法创建或持久化。" );
  }
}

function releaseResolverLock(lock, root, options = {}) {
  const validatedOptions = resolverLockOptions(options);
  try {
    cleanupOwnedPath({
      ownership: lock,
      path: lock.path,
      code: "NPM_RESOLVE_LOCK_CLEANUP",
      afterOwnershipCheck: validatedOptions.afterOwnershipCheck ?? null,
      syncParentDirectory: validatedOptions.syncParentDirectory ?? fsyncDirectory,
    });
  } catch (error) {
    releaseOwnedFile(lock);
    if (error instanceof NpmIsolationError && error.code === "NPM_RESOLVE_LOCK_CLEANUP") {
      throw error;
    }
    fail("NPM_RESOLVE_LOCK_CLEANUP", "resolve-lock 排他锁无法安全清理。" );
  }
}

function holdExpectedLockfile(root, expectedLockHash) {
  const target = join(root, "package-lock.json");
  const exists = pathExists(target, "NPM_LOCK_CONCURRENT_CHANGE");
  if ((expectedLockHash === null) !== !exists) {
    fail("NPM_LOCK_CONCURRENT_CHANGE", "根 package-lock.json 在发布窗口发生变化。" );
  }
  if (!exists) return null;
  const ownership = holdOwnedFile(target, "NPM_LOCK_CONCURRENT_CHANGE");
  const actualHash = createHash("sha256").update(ownership.snapshot).digest("hex");
  if (actualHash !== expectedLockHash) {
    releaseOwnedFile(ownership);
    fail("NPM_LOCK_CONCURRENT_CHANGE", "根 package-lock.json 在发布窗口发生变化。" );
  }
  return ownership;
}

function assertExpectedTargetState(target, ownership) {
  if (ownership === null) {
    if (pathExists(target, "NPM_LOCK_CONCURRENT_CHANGE")) {
      fail("NPM_LOCK_CONCURRENT_CHANGE", "根 package-lock.json 在发布窗口发生变化。" );
    }
    return;
  }
  assertOwnedFile(ownership, target, "NPM_LOCK_CONCURRENT_CHANGE");
}

export function publishLockfile(candidateText, root, {
  afterBackup = null,
  afterBackupCleanupOwnershipCheck = null,
  afterCandidateCleanupOwnershipCheck = null,
  afterCandidateSync = null,
  afterRename = null,
  afterRollbackOwnershipCheck = null,
  afterTargetOwnershipCheck = null,
  beforeTargetUnlink = null,
  beforeRename = null,
  expectedLockHash = hashProjectFile(root, "package-lock.json", { optional: true }),
  syncFile = fsyncSync,
  syncParentDirectory = fsyncDirectory,
} = {}) {
  for (const [name, callback] of Object.entries({
    afterBackup,
    afterBackupCleanupOwnershipCheck,
    afterCandidateCleanupOwnershipCheck,
    afterCandidateSync,
    afterRename,
    afterRollbackOwnershipCheck,
    afterTargetOwnershipCheck,
    beforeTargetUnlink,
    beforeRename,
    syncFile,
    syncParentDirectory,
  })) {
    if (callback !== null && typeof callback !== "function") {
      fail("NPM_LOCK_PUBLISH_OPTIONS", `lockfile 发布选项 ${name} 必须是函数或 null。`);
    }
  }
  const target = join(root, "package-lock.json");
  const temporary = join(root, `.package-lock.json.e010-${process.pid}.tmp`);
  const backup = join(root, `.package-lock.json.e010-${process.pid}.backup`);
  let currentOwnership = holdExpectedLockfile(root, expectedLockHash);
  const previousSnapshot = currentOwnership?.snapshot ?? null;
  for (const residualPath of [temporary, backup]) {
    if (pathExists(residualPath, "NPM_LOCK_PUBLISH")) {
      releaseOwnedFile(currentOwnership);
      fail("NPM_LOCK_PUBLISH", "检测到未清理的 lockfile 候选或备份；外部路径已保留。" );
    }
  }

  let candidateOwnership = null;
  let restoredOwnership = null;
  let backupOwnership = null;
  let activated = false;
  let backedUp = false;
  let candidateTemporaryPresent = false;
  let committed = false;
  try {
    try {
      candidateOwnership = createOwnedFile(
        temporary,
        Buffer.from(candidateText, "utf8"),
        0o644,
        "NPM_LOCK_PUBLISH_UNCERTAIN",
        syncFile,
      );
      candidateTemporaryPresent = true;
    } catch (error) {
      candidateOwnership = error?.ownedFile ?? candidateOwnership;
      candidateTemporaryPresent = Boolean(
        candidateOwnership?.descriptor !== null
        && candidateOwnership?.descriptor !== undefined
        && candidateOwnership?.identity !== null,
      );
      throw error;
    }
    if (afterCandidateSync) afterCandidateSync(temporary);
    assertOwnedFile(candidateOwnership, temporary, "NPM_LOCK_PUBLISH_UNCERTAIN");
    if (beforeRename) beforeRename();
    assertExpectedTargetState(target, currentOwnership);

    if (afterTargetOwnershipCheck) afterTargetOwnershipCheck(target);
    if (currentOwnership !== null) {
      const previousNlink = currentOwnership.identity.nlink;
      linkSync(target, backup);
      updateOwnedFileLinkCount(
        currentOwnership,
        previousNlink + 1,
        "NPM_LOCK_PUBLISH_UNCERTAIN",
      );
      assertOwnedFile(currentOwnership, target, "NPM_LOCK_PUBLISH_UNCERTAIN");
      assertOwnedFile(currentOwnership, backup, "NPM_LOCK_PUBLISH_UNCERTAIN");
      backupOwnership = currentOwnership;
      currentOwnership = null;
      backedUp = true;
      syncParentDirectory(root);
      assertOwnedFile(backupOwnership, target, "NPM_LOCK_PUBLISH_UNCERTAIN");
      assertOwnedFile(backupOwnership, backup, "NPM_LOCK_PUBLISH_UNCERTAIN");
      if (beforeTargetUnlink) beforeTargetUnlink(target);
      assertOwnedFile(backupOwnership, target, "NPM_LOCK_PUBLISH_UNCERTAIN");
      assertOwnedFile(backupOwnership, backup, "NPM_LOCK_PUBLISH_UNCERTAIN");
      unlinkSync(target);
      updateOwnedFileLinkCount(
        backupOwnership,
        previousNlink,
        "NPM_LOCK_PUBLISH_UNCERTAIN",
      );
      syncParentDirectory(root);
      assertOwnedFile(
        backupOwnership,
        backup,
        "NPM_LOCK_PUBLISH_UNCERTAIN",
      );
      if (afterBackup) afterBackup(backup);
      assertOwnedFile(
        backupOwnership,
        backup,
        "NPM_LOCK_PUBLISH_UNCERTAIN",
      );
      if (pathExists(target, "NPM_LOCK_PUBLISH_UNCERTAIN")) {
        fail(
          "NPM_LOCK_PUBLISH_UNCERTAIN",
          "旧 lockfile 摘离后 canonical target 被外部写入者占用。",
        );
      }
    }

    // hardlink 为候选激活与旧 target 摘离都提供 no-replace 目标语义。
    const candidateTemporaryNlink = candidateOwnership.identity.nlink;
    linkSync(temporary, target);
    activated = true;
    updateOwnedFileLinkCount(
      candidateOwnership,
      candidateTemporaryNlink + 1,
      "NPM_LOCK_PUBLISH_UNCERTAIN",
    );
    assertOwnedFile(candidateOwnership, temporary, "NPM_LOCK_PUBLISH_UNCERTAIN");
    assertOwnedFile(candidateOwnership, target, "NPM_LOCK_PUBLISH_UNCERTAIN");
    cleanupOwnedPath({
      ownership: candidateOwnership,
      path: temporary,
      code: "NPM_LOCK_PUBLISH_UNCERTAIN",
      afterOwnershipCheck: afterCandidateCleanupOwnershipCheck,
      keepOwnershipOpen: true,
      remainingPath: target,
      syncParentDirectory,
    });
    candidateTemporaryPresent = false;
    assertOwnedFile(candidateOwnership, target, "NPM_LOCK_PUBLISH_UNCERTAIN");
    syncParentDirectory(root);
    if (afterRename) afterRename();
    assertOwnedFile(candidateOwnership, target, "NPM_LOCK_PUBLISH_UNCERTAIN");
    syncParentDirectory(root);
    assertOwnedFile(candidateOwnership, target, "NPM_LOCK_PUBLISH_UNCERTAIN");
    committed = true;

    if (backedUp) {
      cleanupOwnedPath({
        ownership: backupOwnership,
        path: backup,
        code: "NPM_LOCK_PUBLISH_CLEANUP",
        afterOwnershipCheck: afterBackupCleanupOwnershipCheck,
        guardCurrent: () => assertOwnedFile(
          candidateOwnership,
          target,
          "NPM_LOCK_PUBLISH_UNCERTAIN",
        ),
        syncParentDirectory,
      });
      backedUp = false;
      backupOwnership = null;
    }
    syncParentDirectory(root);
    assertOwnedFile(
      candidateOwnership,
      target,
      "NPM_LOCK_PUBLISH_CLEANUP",
    );
  } catch (error) {
    if (committed) {
      releaseOwnedFile(backupOwnership);
      releaseOwnedFile(candidateOwnership);
      releaseOwnedFile(currentOwnership);
      if (
        error instanceof NpmIsolationError
        && (
          error.code === "NPM_LOCK_PUBLISH_CLEANUP"
          || error.code === "NPM_LOCK_PUBLISH_UNCERTAIN"
        )
      ) {
        throw error;
      }
      fail(
        "NPM_LOCK_PUBLISH_CLEANUP",
        "lockfile 已完整发布，但旧备份无法安全清理；active 与残留状态均已保留。",
      );
    }

    let uncertain = false;
    let activeQuarantine = null;
    const preserveConcurrentTarget = (
      error instanceof NpmIsolationError
      && error.code === "NPM_LOCK_CONCURRENT_CHANGE"
      && !activated
      && !backedUp
    );
    if (activated) {
      try {
        activeQuarantine = quarantineOwnedFile({
          ownership: candidateOwnership,
          path: target,
          code: "NPM_LOCK_PUBLISH_UNCERTAIN",
          afterOwnershipCheck: afterRollbackOwnershipCheck,
          syncParentDirectory,
        });
        activated = false;
      } catch {
        uncertain = true;
      }
    }

    if (!preserveConcurrentTarget && backedUp) {
      try {
        if (pathExists(target, "NPM_LOCK_PUBLISH_UNCERTAIN")) {
          assertOwnedFile(
            backupOwnership,
            target,
            "NPM_LOCK_PUBLISH_UNCERTAIN",
          );
        } else {
          const previousNlink = backupOwnership.identity.nlink;
          linkSync(backup, target);
          updateOwnedFileLinkCount(
            backupOwnership,
            previousNlink + 1,
            "NPM_LOCK_PUBLISH_UNCERTAIN",
          );
          assertOwnedFile(backupOwnership, backup, "NPM_LOCK_PUBLISH_UNCERTAIN");
          assertOwnedFile(backupOwnership, target, "NPM_LOCK_PUBLISH_UNCERTAIN");
        }
        cleanupOwnedPath({
          ownership: backupOwnership,
          path: backup,
          code: "NPM_LOCK_PUBLISH_UNCERTAIN",
          keepOwnershipOpen: true,
          remainingPath: target,
          syncParentDirectory,
        });
        restoredOwnership = backupOwnership;
        backupOwnership = null;
        backedUp = false;
        syncParentDirectory(root);
        assertOwnedFile(restoredOwnership, target, "NPM_LOCK_PUBLISH_UNCERTAIN");
      } catch {
        uncertain = true;
      }
    } else if (
      !preserveConcurrentTarget
      && previousSnapshot === null
      && pathExists(target, "NPM_LOCK_PUBLISH_UNCERTAIN")
    ) {
      uncertain = true;
    }

    if (activeQuarantine !== null) {
      try {
        const keepCandidateOwnership = candidateTemporaryPresent;
        removeOwnedQuarantine(
          activeQuarantine,
          "NPM_LOCK_PUBLISH_UNCERTAIN",
          {
            keepOwnershipOpen: keepCandidateOwnership,
            remainingPath: keepCandidateOwnership ? temporary : null,
            syncParentDirectory,
          },
        );
        activeQuarantine = null;
        if (!keepCandidateOwnership) candidateOwnership = null;
      } catch {
        uncertain = true;
      }
    }

    if (candidateTemporaryPresent) {
      try {
        cleanupOwnedPath({
          ownership: candidateOwnership,
          path: temporary,
          code: "NPM_LOCK_PUBLISH_UNCERTAIN",
          afterOwnershipCheck: afterCandidateCleanupOwnershipCheck,
          syncParentDirectory,
        });
        candidateTemporaryPresent = false;
        candidateOwnership = null;
      } catch {
        uncertain = true;
      }
    }

    try {
      if (preserveConcurrentTarget) {
        // 发布尚未改变 canonical/backup；外部并发 target 按契约原样保留。
      } else if (previousSnapshot === null) {
        if (pathExists(target, "NPM_LOCK_PUBLISH_UNCERTAIN")) uncertain = true;
      } else if (backedUp) {
        uncertain = true;
      } else if (restoredOwnership !== null) {
        assertOwnedFile(restoredOwnership, target, "NPM_LOCK_PUBLISH_UNCERTAIN");
      } else if (currentOwnership !== null) {
        assertOwnedFile(currentOwnership, target, "NPM_LOCK_PUBLISH_UNCERTAIN");
      } else {
        uncertain = true;
      }
    } catch {
      uncertain = true;
    }

    releaseOwnedFile(activeQuarantine?.ownership);
    releaseOwnedFile(backupOwnership);
    releaseOwnedFile(candidateOwnership);
    releaseOwnedFile(currentOwnership);
    releaseOwnedFile(restoredOwnership);

    if (uncertain) {
      fail(
        "NPM_LOCK_PUBLISH_UNCERTAIN",
        "lockfile 发布失败且无法确认旧状态已完整恢复；外部或隔离状态已保留。",
      );
    }
    if (error instanceof NpmIsolationError) throw error;
    fail("NPM_LOCK_PUBLISH", "已验证候选 lockfile 发布失败，旧状态已恢复。" );
  } finally {
    releaseOwnedFile(backupOwnership);
    releaseOwnedFile(candidateOwnership);
    releaseOwnedFile(currentOwnership);
    releaseOwnedFile(restoredOwnership);
  }
}

export function runIsolatedNpm({
  root,
  profile,
  scriptName = null,
  runProcess = spawnSync,
  nodeVersion = process.versions.node,
  npmVersionsByRole = NPM_VERSIONS_BY_ROLE,
  onAuditResult = null,
  publishCandidate = publishLockfile,
  resolverLockCleanupOptions = {},
  temporaryParent = "/tmp",
}) {
  resolverLockOptions(resolverLockCleanupOptions);
  if (onAuditResult !== null && typeof onAuditResult !== "function") {
    fail("NPM_AUDIT_CALLBACK", "npm audit 结果回调必须是可信函数或 null。");
  }
  if (onAuditResult !== null && profile !== "audit") {
    fail("NPM_AUDIT_CALLBACK_SCOPE", "npm audit 结果回调只允许用于 audit profile。");
  }
  const canonicalRoot = validateRoot(root);
  assertNoCompetingPackageManagerInputs(canonicalRoot);
  validateProjectNpmrc(canonicalRoot);
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
  const workloadArguments = buildProfileArguments({
    profile,
    scriptName,
    runtimeRole: runtime.role,
    manifest,
  });

  let validatedLockfile = null;
  if (profileRequiresLockfile(profile) || (profile === "resolve-lock" && existsSync(join(canonicalRoot, "package-lock.json")))) {
    validatedLockfile = readAndValidateLockfile(canonicalRoot, manifest, {
      allowOverrideDrift: profile === "resolve-lock",
    });
  }
  let auditPolicy = null;
  let auditPolicyHash = null;
  if (profile === "audit") {
    readAndValidateDependencyPolicy(canonicalRoot);
    auditPolicyHash = hashProjectFile(
      canonicalRoot,
      "docs/contracts/dependency-policy.json",
    );
    auditPolicy = readAndValidateDependencyPolicy(canonicalRoot);
    assertUnchanged(
      canonicalRoot,
      auditPolicyHash,
      "docs/contracts/dependency-policy.json",
    );
  }
  const rootHashes = {
    npmrc: hashProjectFile(canonicalRoot, ".npmrc"),
    nvmrc: hashProjectFile(canonicalRoot, ".nvmrc"),
    manifest: hashProjectFile(canonicalRoot, "package.json"),
    lockfile: hashProjectFile(canonicalRoot, "package-lock.json", { optional: true }),
    dependencyPolicy: auditPolicyHash,
  };

  let workspace;
  let resolverLock;
  let pendingError;
  try {
    if (profile === "resolve-lock") resolverLock = acquireResolverLock(canonicalRoot);
    workspace = createIsolationWorkspace({
      root: canonicalRoot,
      nodeExecutable: npmRuntime.nodeExecutable,
      temporaryParent,
    });
    assertEnvironmentIsClosed(workspace.environment, {
      paths: workspace.paths,
      root: canonicalRoot,
      nodeExecutable: npmRuntime.nodeExecutable,
    });

    const childOptions = {
      cwd: canonicalRoot,
      env: workspace.environment,
    };
    const configResult = runChild(
      runProcess,
      npmRuntime.nodeExecutable,
      [npmRuntime.npmCli, "config", "list", "--json"],
      childOptions,
      "CONFIG_PREFLIGHT",
    );
    parseAndValidateEffectiveConfig(configResult.stdout, workspace.paths);
    if (readdirSync(workspace.paths.cache).length !== 0) {
      fail("NPM_CACHE_PREWARMED", "实际 npm 工作负载启动前隔离 cache 已含内容。" );
    }
    assertProjectInputsUnchanged(canonicalRoot, rootHashes, manifest, {
      allowOverrideDrift: profile === "resolve-lock",
    });
    if (profile === "run-script") assertLocalBinConfined(canonicalRoot);

    const inputStage = profile === "resolve-lock"
      ? createStagedInputRoot(workspace, canonicalRoot, {
        directoryName: "resolve-root",
        errorCode: "NPM_RESOLVE_STAGE_COPY",
        expectedHashes: rootHashes,
        requireLockfile: false,
      })
      : profile === "audit"
        ? createStagedInputRoot(workspace, canonicalRoot, {
          directoryName: "audit-root",
          errorCode: "NPM_AUDIT_STAGE_COPY",
          expectedHashes: rootHashes,
          requireLockfile: true,
        })
        : null;
    const workloadRoot = inputStage?.root ?? canonicalRoot;
    if (inputStage) {
      validateProjectNpmrc(workloadRoot);
      const stagedManifest = readAndValidateManifest(workloadRoot);
      if (existsSync(join(workloadRoot, "package-lock.json"))) {
        readAndValidateLockfile(workloadRoot, stagedManifest, {
          allowOverrideDrift: profile === "resolve-lock",
        });
      }
    }
    let workloadResult;
    let workloadError;
    try {
      workloadResult = runChild(
        runProcess,
        npmRuntime.nodeExecutable,
        [npmRuntime.npmCli, ...workloadArguments],
        { ...childOptions, cwd: workloadRoot },
        "WORKLOAD",
        profile === "audit" ? { allowedStatuses: [0, 1] } : undefined,
      );
    } catch (error) {
      workloadError = error;
    }

    const postCheckErrors = [];
    for (const check of [
      () => assertProjectInputsUnchanged(canonicalRoot, rootHashes, manifest, {
        allowOverrideDrift: profile === "resolve-lock",
      }),
      ...(inputStage ? [
        () => assertUnchanged(inputStage.root, inputStage.hashes.npmrc, ".npmrc"),
        () => assertUnchanged(inputStage.root, inputStage.hashes.manifest, "package.json"),
        ...(profile === "audit" ? [
          () => assertUnchanged(inputStage.root, inputStage.hashes.lockfile, "package-lock.json"),
        ] : []),
        () => assertNoCompetingPackageManagerInputs(inputStage.root),
      ] : []),
    ]) {
      try {
        check();
      } catch (error) {
        postCheckErrors.push(error);
      }
    }
    if (postCheckErrors.length > 0) throw postCheckErrors[0];
    if (workloadError) throw workloadError;

    const audit = profile === "audit"
      ? parseNpmAuditResult({
        result: workloadResult,
        policy: auditPolicy,
        expectedDependencyCount: Object.keys(validatedLockfile.packages).length - 1,
      })
      : null;
    if (audit && onAuditResult) {
      onAuditResult({
        audit: structuredClone(audit),
        stdout: workloadResult.stdout,
      });
    }
    if (audit) assertParsedNpmAuditResultAllowed(audit);

    if (profile === "resolve-lock") {
      const candidate = readAndValidateLockfileSource(
        workloadRoot,
        manifest,
      );
      assertProjectInputsUnchanged(canonicalRoot, rootHashes, manifest, {
        allowOverrideDrift: true,
      });
      publishCandidate(candidate.text, canonicalRoot, {
        expectedLockHash: rootHashes.lockfile,
      });
    }
    return {
      profile,
      runtime,
      arguments: workloadArguments,
      stdout: workloadResult.stdout,
      stderr: workloadResult.stderr,
      ...(audit ? { audit } : {}),
    };
  } catch (error) {
    pendingError = error;
    throw error;
  } finally {
    let cleanupError;
    if (workspace) {
      try {
        removeIsolationWorkspace(workspace.paths.root);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (resolverLock) {
      try {
        releaseResolverLock(
          resolverLock,
          canonicalRoot,
          resolverLockCleanupOptions,
        );
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) {
      if (pendingError instanceof NpmIsolationError) {
        fail("NPM_CLEANUP_AFTER_FAILURE", `${pendingError.code} 后隔离资源清理失败。`);
      }
      throw cleanupError;
    }
  }
}

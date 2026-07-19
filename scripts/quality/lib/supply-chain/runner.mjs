import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
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

function runChild(runProcess, executable, arguments_, options, phase) {
  const result = runProcess(executable, arguments_, {
    ...options,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result?.error) {
    fail(`NPM_${phase}_SPAWN`, `${phase} 子进程无法启动。`);
  }
  if (typeof result?.status !== "number" || result.status !== 0 || result.signal) {
    fail(`NPM_${phase}_FAILED`, `${phase} 子进程以非零状态退出。`);
  }
  return {
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

function assertProjectInputsUnchanged(root, hashes, manifest) {
  assertUnchanged(root, hashes.npmrc, ".npmrc");
  assertUnchanged(root, hashes.nvmrc, ".nvmrc");
  assertUnchanged(root, hashes.manifest, "package.json");
  assertUnchanged(root, hashes.lockfile, "package-lock.json", true);
  assertNoCompetingPackageManagerInputs(root);
  validateProjectNpmrc(root);
  readAndValidateManifest(root);
  if (hashes.lockfile !== null) readAndValidateLockfile(root, manifest);
}

function createResolveRoot(workspace, root) {
  const resolveRoot = join(workspace.paths.root, "resolve-root");
  mkdirSync(resolveRoot, { mode: 0o700 });
  chmodSync(resolveRoot, 0o700);
  copyFileSync(join(root, "package.json"), join(resolveRoot, "package.json"));
  copyFileSync(join(root, ".npmrc"), join(resolveRoot, ".npmrc"));
  if (existsSync(join(root, "package-lock.json"))) {
    copyFileSync(join(root, "package-lock.json"), join(resolveRoot, "package-lock.json"));
    chmodSync(join(resolveRoot, "package-lock.json"), 0o600);
  }
  chmodSync(join(resolveRoot, "package.json"), 0o600);
  chmodSync(join(resolveRoot, ".npmrc"), 0o600);
  const hashes = {
    npmrc: hashProjectFile(resolveRoot, ".npmrc"),
    manifest: hashProjectFile(resolveRoot, "package.json"),
    lockfile: hashProjectFile(resolveRoot, "package-lock.json", { optional: true }),
  };
  if (
    hashes.npmrc !== hashProjectFile(root, ".npmrc")
    || hashes.manifest !== hashProjectFile(root, "package.json")
    || hashes.lockfile !== hashProjectFile(root, "package-lock.json", { optional: true })
  ) {
    fail("NPM_RESOLVE_STAGE_COPY", "resolve-lock 暂存输入与已验证根输入不一致。" );
  }
  return { root: resolveRoot, hashes };
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function acquireResolverLock(root) {
  const path = join(root, ".e010-resolve-lock");
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, `${process.pid}\n`, "utf8");
    fsyncSync(descriptor);
  } catch (error) {
    const created = descriptor !== undefined;
    if (created) {
      try {
        closeSync(descriptor);
        if (existsSync(path)) unlinkSync(path);
      } catch {
        fail("NPM_RESOLVE_LOCK_CREATE_CLEANUP", "解析锁创建失败且无法清理本次残留。" );
      }
    }
    if (!created && error?.code === "EEXIST") {
      fail("NPM_RESOLVE_CONCURRENT", "已有 resolve-lock 操作或未清理的解析锁。" );
    }
    fail("NPM_RESOLVE_LOCK_CREATE", "resolve-lock 排他锁无法创建或持久化。" );
  }
  return { descriptor, path };
}

function releaseResolverLock(lock, root) {
  try {
    closeSync(lock.descriptor);
    unlinkSync(lock.path);
    fsyncDirectory(root);
  } catch {
    fail("NPM_RESOLVE_LOCK_CLEANUP", "resolve-lock 排他锁无法清理。" );
  }
}

function assertExpectedLockfile(root, expectedLockHash) {
  let actualLockHash;
  try {
    actualLockHash = hashProjectFile(root, "package-lock.json", { optional: true });
  } catch {
    fail("NPM_LOCK_CONCURRENT_CHANGE", "根 package-lock.json 在发布窗口发生变化。");
  }
  if (actualLockHash !== expectedLockHash) {
    fail("NPM_LOCK_CONCURRENT_CHANGE", "根 package-lock.json 在发布窗口发生变化。");
  }
}

export function publishLockfile(candidateText, root, {
  afterRename = null,
  beforeRename = null,
  expectedLockHash = hashProjectFile(root, "package-lock.json", { optional: true }),
} = {}) {
  const target = join(root, "package-lock.json");
  const temporary = join(root, `.package-lock.json.e010-${process.pid}.tmp`);
  const backup = join(root, `.package-lock.json.e010-${process.pid}.backup`);
  let descriptor;
  let renamed = false;
  let backedUp = false;
  assertExpectedLockfile(root, expectedLockHash);
  try {
    if (existsSync(target)) {
      linkSync(target, backup);
      backedUp = true;
    }
    descriptor = openSync(temporary, "wx", 0o644);
    writeFileSync(descriptor, candidateText, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (beforeRename) beforeRename();
    assertExpectedLockfile(root, expectedLockHash);
    renameSync(temporary, target);
    renamed = true;
    if (afterRename) afterRename();
    fsyncDirectory(root);
    if (backedUp) {
      unlinkSync(backup);
      backedUp = false;
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    if (renamed) {
      try {
        if (backedUp && existsSync(backup)) {
          renameSync(backup, target);
          backedUp = false;
        } else if (!backedUp && existsSync(target)) {
          unlinkSync(target);
        }
        fsyncDirectory(root);
      } catch {
        fail("NPM_LOCK_PUBLISH_UNCERTAIN", "lockfile 发布失败且无法确认根文件是否已恢复。" );
      }
    }
    if (backedUp && existsSync(backup)) {
      try {
        unlinkSync(backup);
      } catch {
        fail("NPM_LOCK_PUBLISH_CLEANUP", "lockfile 发布失败且临时备份无法清理。" );
      }
    }
    if (error instanceof NpmIsolationError && error.code === "NPM_LOCK_CONCURRENT_CHANGE") {
      throw error;
    }
    fail("NPM_LOCK_PUBLISH", "已验证候选 lockfile 发布失败，根文件已恢复。" );
  }
}

export function runIsolatedNpm({
  root,
  profile,
  scriptName = null,
  runProcess = spawnSync,
  nodeVersion = process.versions.node,
  npmVersionsByRole = NPM_VERSIONS_BY_ROLE,
  publishCandidate = publishLockfile,
  temporaryParent = "/tmp",
}) {
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

  if (profileRequiresLockfile(profile) || (profile === "resolve-lock" && existsSync(join(canonicalRoot, "package-lock.json")))) {
    readAndValidateLockfile(canonicalRoot, manifest);
  }
  const rootHashes = {
    npmrc: hashProjectFile(canonicalRoot, ".npmrc"),
    nvmrc: hashProjectFile(canonicalRoot, ".nvmrc"),
    manifest: hashProjectFile(canonicalRoot, "package.json"),
    lockfile: hashProjectFile(canonicalRoot, "package-lock.json", { optional: true }),
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
    assertProjectInputsUnchanged(canonicalRoot, rootHashes, manifest);
    if (profile === "run-script") assertLocalBinConfined(canonicalRoot);

    const resolveStage = profile === "resolve-lock"
      ? createResolveRoot(workspace, canonicalRoot)
      : null;
    const workloadRoot = resolveStage?.root ?? canonicalRoot;
    if (profile === "resolve-lock") {
      validateProjectNpmrc(workloadRoot);
      const stagedManifest = readAndValidateManifest(workloadRoot);
      if (existsSync(join(workloadRoot, "package-lock.json"))) {
        readAndValidateLockfile(workloadRoot, stagedManifest);
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
      );
    } catch (error) {
      workloadError = error;
    }

    const postCheckErrors = [];
    for (const check of [
      () => assertProjectInputsUnchanged(canonicalRoot, rootHashes, manifest),
      ...(resolveStage ? [
        () => assertUnchanged(resolveStage.root, resolveStage.hashes.npmrc, ".npmrc"),
        () => assertUnchanged(resolveStage.root, resolveStage.hashes.manifest, "package.json"),
        () => assertNoCompetingPackageManagerInputs(resolveStage.root),
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

    if (profile === "resolve-lock") {
      const candidate = readAndValidateLockfileSource(
        workloadRoot,
        manifest,
      );
      assertProjectInputsUnchanged(canonicalRoot, rootHashes, manifest);
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
        releaseResolverLock(resolverLock, canonicalRoot);
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

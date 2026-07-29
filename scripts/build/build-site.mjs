import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {basename, dirname, isAbsolute, join, relative, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {createHash, randomBytes} from "node:crypto";
import {spawnSync} from "node:child_process";
import {assertNoAuthorTransactionResidue} from "../author/lib/transaction-state.mjs";
import {projectRoot} from "../quality/lib/files.mjs";
import {buildQualityChildEnvironment} from "../quality/lib/process-environment.mjs";
import {
  readAndValidateManifest,
  readAndValidateRuntimeContract,
} from "../quality/lib/supply-chain/config.mjs";

const ROOT = projectRoot();
const OWNER_FILE_NAME = ".axial-muse-build-owner";
const OWNER_PATTERN = /^[0-9a-f]{64}$/u;
const TRANSACTION_ROOT_PREFIX = "axial-muse-build-transaction-";
const TRANSACTION_OWNER_FILE = ".axial-muse-build-transaction-owner";
const INPUT_SEAL_FILE = ".axial-muse-content-input-seal";
const GENERATED_FILES_DIRECTORY = "generated";
const BUILD_LOCK_FILE = ".axial-muse-build.lock";
const RETIRED_BUILD_NAME = ".axial-muse-build-retired";
const PREVIEW_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const PREVIEW_PID_PATTERN = /^[1-9][0-9]*$/u;
const PREVIEW_STATE_ENV = "PREVIEW_STATE_DIR";
const PREVIEW_CANDIDATE_ENV = "AXIAL_MUSE_PREVIEW_CANDIDATE";
const PREVIEW_SHA_ENV = "AXIAL_MUSE_PREVIEW_COMMIT_SHA";
const PREVIEW_CONTROLLER_PID_ENV = "AXIAL_MUSE_PREVIEW_CONTROLLER_PID";
const PREVIEW_ACCESS_HOST_ENV = "AXIAL_MUSE_PREVIEW_ACCESS_HOST";
const PREVIEW_ACCESS_PORT_ENV = "AXIAL_MUSE_PREVIEW_ACCESS_PORT";
const PREVIEW_CONFIG_CHUNK_PATTERN = /^config---[a-z0-9-]+$/u;
const transactionStates = new WeakMap();

export class BuildSiteError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "BuildSiteError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new BuildSiteError(code, message, options);
}

export function formatBuildSiteError(error) {
  if (error instanceof BuildSiteError) {
    return `[${error.code}] ${error.message}`;
  }
  return "[BUILD_INTERNAL] 构建入口发生未分类错误；详细堆栈已抑制，避免泄露本机路径或环境信息。";
}

export function parseBuildArguments(arguments_) {
  if (
    !Array.isArray(arguments_)
    || arguments_.length !== 2
    || arguments_[0] !== "--mode"
  ) {
    fail("BUILD_ARGUMENTS", "构建入口只接受 --mode <mode>。");
  }
  if (arguments_[1] !== "production" && arguments_[1] !== "preview") {
    fail("BUILD_MODE", "未知构建模式。");
  }
  return Object.freeze({mode: arguments_[1]});
}

export function assertBuildModeAvailable(mode) {
  if (mode !== "production" && mode !== "preview") {
    fail("BUILD_MODE", "未知构建模式。");
  }
}

export function assertSupportedNodeVersion({
  root = ROOT,
  nodeVersion = process.versions.node,
} = {}) {
  const manifest = readAndValidateManifest(root);
  const contract = readAndValidateRuntimeContract({root, manifest});
  const role = Object.entries(contract.nodeVersionsByRole)
    .find(([, version]) => version === nodeVersion)?.[0];
  if (role === undefined) {
    fail("BUILD_RUNTIME_NODE", "当前 Node 不属于 .nvmrc 主端点或 engines 下界端点。");
  }
  return role;
}

function resolveDocusaurusCli(root) {
  const require = createRequire(import.meta.url);
  let cliPath;
  try {
    cliPath = require.resolve("@docusaurus/core/bin/docusaurus.mjs", {
      paths: [root],
    });
  } catch (error) {
    fail("BUILD_DEPENDENCIES", "本地冻结的 Docusaurus CLI 不可用。", {cause: error});
  }
  const expectedPackageRoot = realpathSync(
    resolve(root, "node_modules", "@docusaurus", "core"),
  );
  const realCliPath = realpathSync(cliPath);
  const relativeCliPath = relative(expectedPackageRoot, realCliPath);
  if (
    relativeCliPath === ""
    || relativeCliPath.startsWith("..")
    || resolve(expectedPackageRoot, relativeCliPath) !== realCliPath
    || !lstatSync(realCliPath).isFile()
  ) {
    fail("BUILD_DEPENDENCIES", "Docusaurus CLI 逃逸已冻结的本地包目录。");
  }
  return realCliPath;
}

function assertOwner(owner) {
  if (typeof owner !== "string" || !OWNER_PATTERN.test(owner)) {
    fail("BUILD_OWNER", "构建所有权标识不合法。");
  }
}

function assertCanonicalRoot(root) {
  try {
    if (resolve(root) !== root || realpathSync(root) !== root) {
      throw new TypeError("non-canonical root");
    }
    const metadata = lstatSync(root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new TypeError("invalid root");
    }
  } catch (error) {
    fail("BUILD_ROOT", "仓库根不是规范真实目录。", {cause: error});
  }
}

function assertAuthorTransactionClear(root) {
  try {
    assertNoAuthorTransactionResidue({root});
  } catch (cause) {
    fail(
      "BUILD_AUTHOR_TRANSACTION",
      "作者事务仍在进行或存在未核对残留，production build 已在内容读取前停止。",
      {cause},
    );
  }
}

function isPathWithin(root, path) {
  const relation = relative(root, path);
  return relation === ""
    || (!relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && relation !== ".."
      && !isAbsolute(relation));
}

function privateDirectoryEvidence(path, code, message) {
  try {
    const metadata = lstatSync(path);
    if (
      metadata.isSymbolicLink()
      || !metadata.isDirectory()
      || (metadata.mode & 0o777) !== 0o700
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || realpathSync(path) !== path
    ) throw new TypeError("private directory identity mismatch");
    return metadata;
  } catch (error) {
    fail(code, message, {cause: error});
  }
}

export function readPreviewBuildRequest({
  root = ROOT,
  environment = process.env,
  systemTemporaryRoot = realpathSync(tmpdir()),
} = {}) {
  assertCanonicalRoot(root);
  const stateInput = environment[PREVIEW_STATE_ENV];
  const candidateInput = environment[PREVIEW_CANDIDATE_ENV];
  const commitSha = environment[PREVIEW_SHA_ENV];
  const controllerPid = environment[PREVIEW_CONTROLLER_PID_ENV];
  const accessHost = environment[PREVIEW_ACCESS_HOST_ENV];
  const accessPort = environment[PREVIEW_ACCESS_PORT_ENV];
  if (
    typeof stateInput !== "string"
    || !isAbsolute(stateInput)
    || resolve(stateInput) !== stateInput
    || typeof candidateInput !== "string"
    || !isAbsolute(candidateInput)
    || !PREVIEW_SHA_PATTERN.test(commitSha ?? "")
    || !PREVIEW_PID_PATTERN.test(controllerPid ?? "")
    || typeof accessHost !== "string"
    || !/^[A-Za-z0-9.-]+$/u.test(accessHost)
    || typeof accessPort !== "string"
    || !/^[1-9][0-9]{0,4}$/u.test(accessPort)
    || Number(accessPort) > 65_535
  ) {
    fail("BUILD_PREVIEW_ENV", "preview 构建请求缺少封闭的候选、提交或访问身份。");
  }
  const rootMetadata = privateDirectoryEvidence(
    stateInput,
    "BUILD_PREVIEW_STATE_IDENTITY",
    "preview 状态根不是当前用户私有的规范目录。",
  );
  const stateRoot = realpathSync(stateInput);
  const temporaryRoot = realpathSync(systemTemporaryRoot);
  if (
    stateRoot !== stateInput
    || isPathWithin(root, stateRoot)
    || isPathWithin(stateRoot, root)
    || isPathWithin(temporaryRoot, stateRoot)
  ) {
    fail("BUILD_PREVIEW_STATE_PATH", "preview 状态根不得位于仓库或系统临时目录内。");
  }
  const directories = ["candidates", "releases", "run", "logs"].map((name) => {
    const path = resolve(stateRoot, name);
    const metadata = privateDirectoryEvidence(
      path,
      "BUILD_PREVIEW_STATE_IDENTITY",
      "preview 状态子目录不是当前用户私有的规范目录。",
    );
    if (metadata.dev !== rootMetadata.dev) {
      fail("BUILD_PREVIEW_STATE_DEVICE", "preview 状态目录必须位于同一文件系统。");
    }
    return path;
  });
  const candidatesRoot = directories[0];
  const expectedCandidate = resolve(
    candidatesRoot,
    `${commitSha}.${controllerPid}`,
  );
  if (candidateInput !== expectedCandidate || resolve(candidateInput) !== candidateInput) {
    fail("BUILD_PREVIEW_CANDIDATE_PATH", "preview 候选路径不属于当前提交与控制进程。");
  }
  if (entryExists(candidateInput)) {
    fail("BUILD_PREVIEW_CANDIDATE_EXISTS", "preview 候选必须从不存在的空路径开始构建。");
  }
  return Object.freeze({
    accessHost,
    accessPort,
    candidatePath: candidateInput,
    candidatesRoot,
    commitSha,
    controllerPid,
    stateRoot,
  });
}

export function candidateOutputPath(root, owner) {
  assertCanonicalRoot(root);
  assertOwner(owner);
  return resolve(root, `.axial-muse-build-candidate-${owner}`);
}

function backupOutputPath(root, owner) {
  assertCanonicalRoot(root);
  assertOwner(owner);
  return resolve(root, `.axial-muse-build-backup-${owner}`);
}

function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function retiredOutputPath(root) {
  assertCanonicalRoot(root);
  return resolve(root, RETIRED_BUILD_NAME);
}

function lockOutputPath(root) {
  assertCanonicalRoot(root);
  return resolve(root, BUILD_LOCK_FILE);
}

function assertDirectChild(path, root, expectedName, code) {
  if (
    dirname(path) !== root
    || basename(path) !== expectedName
    || resolve(root, expectedName) !== path
  ) {
    fail(code, "构建事务路径不属于仓库根的精确受控成员。");
  }
}

function assertOwnedDirectory(path, code, message) {
  try {
    const metadata = lstatSync(path);
    if (
      metadata.isSymbolicLink()
      || !metadata.isDirectory()
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) throw new TypeError("invalid owned directory");
  } catch (error) {
    fail(code, message, {cause: error});
  }
}

function removeManagedDirectory(path, root, expectedName) {
  assertDirectChild(path, root, expectedName, "BUILD_CLEANUP_TARGET");
  if (!entryExists(path)) return;
  assertOwnedDirectory(path, "BUILD_CLEANUP_TARGET", "待清理构建路径不是自有普通目录。");
  rmSync(path, {recursive: true, force: false});
}

function createBuildContext(mode, owner) {
  assertOwner(owner);
  const temporaryRoot = realpathSync(tmpdir());
  const buildRoot = mkdtempSync(join(temporaryRoot, "axial-muse-build-"));
  chmodSync(buildRoot, 0o700);
  const staticDirectory = resolve(buildRoot, "static");
  mkdirSync(staticDirectory, {mode: 0o700});
  chmodSync(staticDirectory, 0o700);
  const ownerPath = resolve(buildRoot, OWNER_FILE_NAME);
  writeFileSync(ownerPath, `${mode}:${owner}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(ownerPath, 0o600);
  return {buildRoot, mode, owner};
}

function cleanupBuildContext(context) {
  try {
    rmSync(context.buildRoot, {recursive: true, force: false});
  } catch (error) {
    fail("BUILD_CLEANUP", "临时构建上下文清理失败。", {cause: error});
  }
}

function createTransactionRoot(mode, owner) {
  const temporaryRoot = realpathSync(tmpdir());
  let transactionRoot;
  try {
    transactionRoot = mkdtempSync(join(temporaryRoot, TRANSACTION_ROOT_PREFIX));
    chmodSync(transactionRoot, 0o700);
    const markerPath = resolve(transactionRoot, TRANSACTION_OWNER_FILE);
    writeFileSync(markerPath, `${mode}:${owner}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(markerPath, 0o600);
    const generatedFilesDirectory = resolve(
      transactionRoot,
      GENERATED_FILES_DIRECTORY,
    );
    mkdirSync(generatedFilesDirectory, {mode: 0o700});
    chmodSync(generatedFilesDirectory, 0o700);
    return transactionRoot;
  } catch (error) {
    if (transactionRoot !== undefined) {
      try {
        rmSync(transactionRoot, {recursive: true, force: false});
      } catch {
        // 原始创建失败优先；随机私有根不会被当作仓库发布目标。
      }
    }
    fail("BUILD_TRANSACTION_ROOT", "无法创建 owner 绑定的私有 transaction 根。", {
      cause: error,
    });
  }
}

function runDocusaurusPhase({
  root,
  cliPath,
  context,
  transactionRoot,
  outputPath,
  phase,
  arguments: arguments_,
  failureCode,
  failureMessage,
  previewRequest,
}) {
  let result;
  let phaseError;
  const generatedFilesDirectory = resolve(
    transactionRoot,
    GENERATED_FILES_DIRECTORY,
  );
  try {
    result = spawnSync(process.execPath, [cliPath, ...arguments_], {
      cwd: root,
      env: {
        ...buildQualityChildEnvironment(),
        NODE_ENV: "production",
        DOCUSAURUS_NO_PERSISTENT_CACHE: "1",
        DOCUSAURUS_GENERATED_FILES_DIR_NAME: generatedFilesDirectory,
        AXIAL_MUSE_BUILD_MODE: context.mode,
        AXIAL_MUSE_BUILD_ROOT: context.buildRoot,
        AXIAL_MUSE_BUILD_GENERATED_FILES: generatedFilesDirectory,
        AXIAL_MUSE_BUILD_OWNER: context.owner,
        AXIAL_MUSE_BUILD_PHASE: phase,
        AXIAL_MUSE_BUILD_OUTPUT: outputPath,
        AXIAL_MUSE_BUILD_TRANSACTION_ROOT: transactionRoot,
        ...(previewRequest === undefined
          ? {}
          : {
              PREVIEW_STATE_DIR: previewRequest.stateRoot,
              AXIAL_MUSE_PREVIEW_CANDIDATE: previewRequest.candidatePath,
              AXIAL_MUSE_PREVIEW_COMMIT_SHA: previewRequest.commitSha,
              AXIAL_MUSE_PREVIEW_CONTROLLER_PID: previewRequest.controllerPid,
              AXIAL_MUSE_PREVIEW_ACCESS_HOST: previewRequest.accessHost,
              AXIAL_MUSE_PREVIEW_ACCESS_PORT: previewRequest.accessPort,
            }),
      },
      stdio: "inherit",
    });
    if (result.error || result.signal || result.status !== 0) {
      phaseError = new BuildSiteError(failureCode, failureMessage, {
        cause: result.error,
      });
    }
  } catch (error) {
    phaseError = new BuildSiteError(failureCode, failureMessage, {cause: error});
  } finally {
    try {
      cleanupBuildContext(context);
    } catch (error) {
      phaseError = phaseError === undefined
        ? error
        : new BuildSiteError(
            "BUILD_PHASE_CLEANUP",
            "Docusaurus phase 与其私有构建上下文清理同时失败。",
            {cause: new AggregateError([phaseError, error])},
          );
    }
  }
  if (phaseError !== undefined) throw phaseError;
}

function fileIdentity(metadata) {
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    linkCount: metadata.nlink,
    owner: metadata.uid,
    group: metadata.gid,
    size: metadata.size,
    modifiedAtNanoseconds: metadata.mtimeNs,
    changedAtNanoseconds: metadata.ctimeNs,
  });
}

function sameFileIdentity(left, right) {
  return (
    left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.linkCount === right.linkCount
    && left.owner === right.owner
    && left.group === right.group
    && left.size === right.size
    && left.modifiedAtNanoseconds === right.modifiedAtNanoseconds
    && left.changedAtNanoseconds === right.changedAtNanoseconds
  );
}

function assertPrivateFileMetadata(metadata) {
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || (metadata.mode & 0o777n) !== 0o600n
    || metadata.nlink !== 1n
    || (
      typeof process.getuid === "function"
      && metadata.uid !== BigInt(process.getuid())
    )
  ) throw new TypeError("private file identity mismatch");
}

function readStablePrivateFile(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptorBefore = fstatSync(descriptor, {bigint: true});
    const pathBefore = lstatSync(path, {bigint: true});
    assertPrivateFileMetadata(descriptorBefore);
    assertPrivateFileMetadata(pathBefore);
    const identity = fileIdentity(descriptorBefore);
    if (!sameFileIdentity(identity, fileIdentity(pathBefore))) {
      throw new TypeError("private file path identity mismatch");
    }
    const bytes = readFileSync(descriptor);
    const descriptorAfter = fstatSync(descriptor, {bigint: true});
    const pathAfter = lstatSync(path, {bigint: true});
    if (
      !sameFileIdentity(identity, fileIdentity(descriptorAfter))
      || !sameFileIdentity(identity, fileIdentity(pathAfter))
      || BigInt(bytes.byteLength) !== identity.size
    ) throw new TypeError("private file changed while reading");
    return {bytes, identity};
  } finally {
    closeSync(descriptor);
  }
}

function readStableOwnedFile(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptorBefore = fstatSync(descriptor, {bigint: true});
    const pathBefore = lstatSync(path, {bigint: true});
    assertTreeEntry(descriptorBefore, "file");
    assertTreeEntry(pathBefore, "file");
    if (
      (descriptorBefore.mode & 0o022n) !== 0n
      || (pathBefore.mode & 0o022n) !== 0n
    ) throw new TypeError("owned file permission or size mismatch");
    const identity = fileIdentity(descriptorBefore);
    if (!sameFileIdentity(identity, fileIdentity(pathBefore))) {
      throw new TypeError("owned file path identity mismatch");
    }
    const bytes = readFileSync(descriptor);
    const descriptorAfter = fstatSync(descriptor, {bigint: true});
    const pathAfter = lstatSync(path, {bigint: true});
    if (
      !sameFileIdentity(identity, fileIdentity(descriptorAfter))
      || !sameFileIdentity(identity, fileIdentity(pathAfter))
      || BigInt(bytes.byteLength) !== identity.size
    ) throw new TypeError("owned file changed while reading");
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function strictUtf8(bytes) {
  const value = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
  if (!Buffer.from(value, "utf8").equals(bytes)) {
    throw new TypeError("file is not canonical UTF-8");
  }
  return value;
}

function configChunkNames(routesChunkNames) {
  if (
    routesChunkNames === null
    || typeof routesChunkNames !== "object"
    || Array.isArray(routesChunkNames)
  ) throw new TypeError("route chunk map must be an object");
  const names = new Set();
  for (const route of Object.values(routesChunkNames)) {
    if (route === null || typeof route !== "object" || Array.isArray(route)) {
      throw new TypeError("route chunk entry must be an object");
    }
    if (!Object.hasOwn(route, "config")) continue;
    if (
      typeof route.config !== "string"
      || !PREVIEW_CONFIG_CHUNK_PATTERN.test(route.config)
    ) throw new TypeError("route config chunk name is invalid");
    names.add(route.config);
  }
  if (names.size === 0) throw new TypeError("route config chunk set is empty");
  return [...names].sort();
}

function configModuleIsMerged(mainSource, chunkName) {
  const moduleHeader = (
    /(?:^|\n)"[^"\n]*\/generated\/docusaurus\.config\.mjs"\s*\(/u.test(mainSource)
    || /(?:^|\n)\/\*\*\*\/ "[^"\n]*\/generated\/docusaurus\.config\.mjs"/u.test(mainSource)
  );
  if (!moduleHeader) return false;
  const registryShapes = Object.freeze([
    Object.freeze({
      marker: `"${chunkName}"`,
      alias: '"@generated/docusaurus.config"',
    }),
    Object.freeze({
      marker: `\\"${chunkName}\\"`,
      alias: '\\"@generated/docusaurus.config\\"',
    }),
  ]);
  for (const {marker, alias} of registryShapes) {
    let offset = 0;
    while (offset < mainSource.length) {
      const index = mainSource.indexOf(marker, offset);
      if (index === -1) break;
      const entry = mainSource.slice(index, index + 2_048);
      const importIndex = entry.indexOf("Promise.resolve(/* import() */)");
      const configModuleIndex = entry.indexOf(
        "generated/docusaurus.config.mjs",
        importIndex,
      );
      const aliasIndex = entry.indexOf(alias, configModuleIndex);
      const resolvedConfigModuleIndex = entry.indexOf(
        "generated/docusaurus.config.mjs",
        aliasIndex + alias.length,
      );
      if (
        importIndex !== -1
        && configModuleIndex !== -1
        && aliasIndex !== -1
        && resolvedConfigModuleIndex !== -1
      ) return true;
      offset = index + marker.length;
    }
  }
  return false;
}

function assertCanonicalOwnedDirectory(path) {
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || (metadata.mode & 0o022) !== 0
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    || realpathSync(path) !== path
  ) throw new TypeError("owned directory identity mismatch");
}

export function materializePreviewConfigChunks({
  candidatePath,
  generatedFilesDirectory,
} = {}) {
  try {
    if (
      typeof candidatePath !== "string"
      || !isAbsolute(candidatePath)
      || resolve(candidatePath) !== candidatePath
      || typeof generatedFilesDirectory !== "string"
      || !isAbsolute(generatedFilesDirectory)
      || resolve(generatedFilesDirectory) !== generatedFilesDirectory
    ) throw new TypeError("preview config chunk paths are invalid");
    assertCanonicalOwnedDirectory(candidatePath);
    assertCanonicalOwnedDirectory(generatedFilesDirectory);
    const routesSource = strictUtf8(readStableOwnedFile(
      resolve(generatedFilesDirectory, "routesChunkNames.json"),
    ));
    const names = configChunkNames(JSON.parse(routesSource));
    const mainSource = strictUtf8(readStableOwnedFile(
      resolve(candidatePath, "main.js"),
    ));
    const chunkGlobals = new Set(
      [...mainSource.matchAll(/self\["(webpackChunk[A-Za-z0-9_]+)"\]/gu)]
        .map((match) => match[1]),
    );
    if (chunkGlobals.size !== 1) throw new TypeError("webpack chunk global is ambiguous");
    const chunkGlobal = [...chunkGlobals][0];
    const materialized = [];
    for (const name of names) {
      const path = resolve(candidatePath, `${name}.js`);
      if (dirname(path) !== candidatePath) throw new TypeError("config chunk path escaped");
      try {
        readStableOwnedFile(path);
        continue;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (!configModuleIsMerged(mainSource, name)) {
        throw new TypeError("missing config chunk module is not merged into main bundle");
      }
      const contents = Buffer.from(
        `(self["${chunkGlobal}"] = self["${chunkGlobal}"] || []).push([["${name}"],{}]);\n`,
        "utf8",
      );
      const descriptor = openSync(
        path,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | constants.O_NOFOLLOW,
        0o644,
      );
      try {
        writeFileSync(descriptor, contents);
        fchmodSync(descriptor, 0o644);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      const actual = readStableOwnedFile(path);
      if (!actual.equals(contents)) throw new TypeError("config chunk bytes drifted");
      materialized.push(name);
    }
    if (materialized.length > 0) {
      const descriptor = openSync(
        candidatePath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
    return Object.freeze(materialized);
  } catch (error) {
    fail(
      "BUILD_PREVIEW_CONFIG_CHUNK",
      "Docusaurus development build 的合并 config chunk 无法安全闭合。",
      {cause: error},
    );
  }
}

function acquireBuildLock(root, owner) {
  const path = lockOutputPath(root);
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDWR
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("BUILD_LOCKED", "已有排他构建事务持有发布锁。", {cause: error});
    }
    fail("BUILD_LOCK", "无法唯一获取排他构建事务锁。", {cause: error});
  }
  try {
    chmodSync(path, 0o600);
    writeFileSync(descriptor, `${owner}\n`, {encoding: "utf8"});
    fsyncSync(descriptor);
    const metadata = fstatSync(descriptor, {bigint: true});
    assertPrivateFileMetadata(metadata);
    return {path, descriptor, identity: fileIdentity(metadata)};
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // 后续仍按精确 lock path 回收。
    }
    try {
      unlinkSync(path);
    } catch {
      // 创建阶段失败会以 BUILD_LOCK 失败关闭。
    }
    fail("BUILD_LOCK", "排他构建事务锁身份初始化失败。", {cause: error});
  }
}

function assertBuildLock(state) {
  try {
    const current = readStablePrivateFile(state.lock.path);
    if (
      current.bytes.toString("utf8") !== `${state.owner}\n`
      || !sameFileIdentity(current.identity, state.lock.identity)
    ) throw new TypeError("build lock identity mismatch");
  } catch (error) {
    fail("BUILD_LOCK_IDENTITY", "排他构建事务锁在提交前发生变化。", {cause: error});
  }
}

function releaseBuildLock(state) {
  assertBuildLock(state);
  if (state.lock.descriptor !== undefined) {
    closeSync(state.lock.descriptor);
    state.lock.descriptor = undefined;
  }
  try {
    unlinkSync(state.lock.path);
  } catch (error) {
    fail("BUILD_LOCK_RELEASE", "排他构建事务锁未能释放。", {cause: error});
  }
}

function validateTestHooks(value) {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("BUILD_TEST_HOOKS", "构建事务测试钩子结构不合法。");
  }
  const allowed = new Set([
    "afterBuildLockAcquired",
    "afterCandidateActivation",
    "beforeCandidateActivation",
    "beforeLockRelease",
    "beforeRetiredReclaim",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) || typeof value[key] !== "function") {
      fail("BUILD_TEST_HOOKS", "构建事务测试钩子字段不合法。");
    }
  }
  return Object.freeze({...value});
}

function transactionState(transaction) {
  const state = transactionStates.get(transaction);
  if (state === undefined) {
    fail("BUILD_TRANSACTION_IDENTITY", "构建事务对象不具有本进程来源。");
  }
  return state;
}

function assertActiveTransaction(transaction) {
  const state = transactionState(transaction);
  if (state.status !== "active") {
    fail("BUILD_TRANSACTION_STATE", "构建事务已结束或尚未激活。");
  }
  assertBuildLock(state);
  return state;
}

function validateTransactionRoot(state) {
  const transactionRoot = state.transactionRoot;
  if (transactionRoot === undefined) return;
  try {
    const rootMetadata = lstatSync(transactionRoot);
    const temporaryRoot = realpathSync(tmpdir());
    if (
      rootMetadata.isSymbolicLink()
      || !rootMetadata.isDirectory()
      || (rootMetadata.mode & 0o777) !== 0o700
      || (typeof process.getuid === "function" && rootMetadata.uid !== process.getuid())
      || realpathSync(transactionRoot) !== transactionRoot
      || dirname(transactionRoot) !== temporaryRoot
      || !basename(transactionRoot).startsWith(TRANSACTION_ROOT_PREFIX)
    ) throw new TypeError("transaction root identity mismatch");
    const entries = readdirSync(transactionRoot).sort();
    const allowedEntries = [GENERATED_FILES_DIRECTORY, TRANSACTION_OWNER_FILE];
    if (entries.includes(INPUT_SEAL_FILE)) allowedEntries.push(INPUT_SEAL_FILE);
    if (entries.join("\n") !== allowedEntries.sort().join("\n")) {
      throw new TypeError("transaction root member mismatch");
    }
    const marker = readStablePrivateFile(resolve(transactionRoot, TRANSACTION_OWNER_FILE));
    if (marker.bytes.toString("utf8") !== `${state.mode}:${state.owner}\n`) {
      throw new TypeError("transaction owner marker mismatch");
    }
    const generatedPath = resolve(transactionRoot, GENERATED_FILES_DIRECTORY);
    const generatedMetadata = lstatSync(generatedPath);
    if (
      generatedMetadata.isSymbolicLink()
      || !generatedMetadata.isDirectory()
      || (generatedMetadata.mode & 0o777) !== 0o700
      || (typeof process.getuid === "function" && generatedMetadata.uid !== process.getuid())
      || realpathSync(generatedPath) !== generatedPath
    ) throw new TypeError("transaction generated files identity mismatch");
    if (entries.includes(INPUT_SEAL_FILE)) {
      readStablePrivateFile(resolve(transactionRoot, INPUT_SEAL_FILE));
    }
  } catch (error) {
    fail("BUILD_TRANSACTION_ROOT_IDENTITY", "私有 transaction 根在提交前发生变化。", {
      cause: error,
    });
  }
}

function cleanupTransactionRoot(state) {
  if (state.transactionRoot === undefined) return;
  validateTransactionRoot(state);
  try {
    rmSync(state.transactionRoot, {recursive: true, force: false});
    state.transactionRoot = undefined;
  } catch (error) {
    fail("BUILD_TRANSACTION_ROOT_CLEANUP", "私有 transaction 根清理失败。", {
      cause: error,
    });
  }
}

export function beginBuildTransaction({root, owner, testHooks} = {}) {
  assertCanonicalRoot(root);
  assertOwner(owner);
  const hooks = validateTestHooks(testHooks);
  const lock = acquireBuildLock(root, owner);
  const state = {
    root,
    owner,
    mode: "production",
    hooks,
    lock,
    status: "starting",
    transactionRoot: undefined,
  };
  try {
    const retiredPath = retiredOutputPath(root);
    if (entryExists(retiredPath)) {
      try {
        hooks.beforeRetiredReclaim?.();
        removeManagedDirectory(retiredPath, root, RETIRED_BUILD_NAME);
      } catch (error) {
        fail("BUILD_RETIRED_RECLAIM", "上次 retired 构建未能在本次改动前回收。", {
          cause: error,
        });
      }
    }
    const candidatePath = candidateOutputPath(root, owner);
    const backupPath = backupOutputPath(root, owner);
    if (entryExists(candidatePath)) {
      fail("BUILD_CANDIDATE_EXISTS", "本次候选制品路径在事务开始前已存在。");
    }
    if (entryExists(backupPath)) {
      fail("BUILD_BACKUP_EXISTS", "本次备份路径在事务开始前已存在。");
    }
    state.transactionRoot = createTransactionRoot("production", owner);
    state.status = "active";
    const transaction = Object.freeze({
      root,
      owner,
      candidatePath,
      transactionRoot: state.transactionRoot,
    });
    transactionStates.set(transaction, state);
    return transaction;
  } catch (error) {
    let rollbackError;
    try {
      cleanupTransactionRoot(state);
      releaseBuildLock(state);
    } catch (candidateRollbackError) {
      rollbackError = candidateRollbackError;
    }
    if (rollbackError !== undefined) {
      fail("BUILD_TRANSACTION_BEGIN_ROLLBACK", "事务开始失败且锁或私有根回收失败。", {
        cause: rollbackError,
      });
    }
    throw error;
  }
}

function beginPreviewBuildTransaction({root, owner, request}) {
  assertCanonicalRoot(root);
  assertOwner(owner);
  if (
    request === null
    || typeof request !== "object"
    || request.candidatePath !== resolve(
      request.candidatesRoot,
      `${request.commitSha}.${request.controllerPid}`,
    )
    || entryExists(request.candidatePath)
  ) {
    fail("BUILD_PREVIEW_CANDIDATE_PATH", "preview 候选事务输入不合法。");
  }
  const lock = acquireBuildLock(root, owner);
  const state = {
    root,
    owner,
    mode: "preview",
    hooks: Object.freeze({}),
    lock,
    status: "starting",
    transactionRoot: undefined,
    request,
  };
  try {
    state.transactionRoot = createTransactionRoot("preview", owner);
    state.status = "active";
    const transaction = Object.freeze({
      root,
      owner,
      candidatePath: request.candidatePath,
      transactionRoot: state.transactionRoot,
    });
    transactionStates.set(transaction, state);
    return transaction;
  } catch (error) {
    let rollbackError;
    try {
      cleanupTransactionRoot(state);
      releaseBuildLock(state);
    } catch (candidateRollbackError) {
      rollbackError = candidateRollbackError;
    }
    if (rollbackError !== undefined) {
      fail("BUILD_PREVIEW_BEGIN_ROLLBACK", "preview 事务开始失败且私有状态未完整回收。", {
        cause: rollbackError,
      });
    }
    throw error;
  }
}

function hashFrame(hash, label, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  hash.update(`${label}:${bytes.byteLength}:`, "utf8");
  hash.update(bytes);
}

function assertTreeEntry(metadata, expectedType) {
  const matches = expectedType === "directory"
    ? metadata.isDirectory()
    : metadata.isFile();
  if (
    metadata.isSymbolicLink()
    || !matches
    || (expectedType === "file" && metadata.nlink !== 1n)
    || (
      typeof process.getuid === "function"
      && metadata.uid !== BigInt(process.getuid())
    )
  ) throw new TypeError("build tree entry identity mismatch");
}

function identityFrame(identity, includeMutableRootFields = true) {
  const stable = [
    identity.device,
    identity.inode,
    identity.mode,
    identity.linkCount,
    identity.owner,
    identity.group,
  ];
  if (includeMutableRootFields) {
    stable.push(
      identity.size,
      identity.modifiedAtNanoseconds,
      identity.changedAtNanoseconds,
    );
  }
  return stable.map(String).join(":");
}

function captureBuildTree(path, root, expectedName) {
  assertDirectChild(path, root, expectedName, "BUILD_TREE_PATH");
  const hash = createHash("sha256");
  hashFrame(hash, "version", "axial-muse-build-tree-v1");
  let entryCount = 0;

  const walk = (directory, relativePath, isRoot) => {
    const beforeMetadata = lstatSync(directory, {bigint: true});
    assertTreeEntry(beforeMetadata, "directory");
    const beforeIdentity = fileIdentity(beforeMetadata);
    const names = readdirSync(directory).sort();
    hashFrame(hash, "directory-path", relativePath);
    hashFrame(hash, "directory-identity", identityFrame(beforeIdentity, !isRoot));
    hashFrame(hash, "directory-members", names.join("\n"));
    entryCount += 1;
    for (const name of names) {
      const childPath = resolve(directory, name);
      const childRelativePath = relativePath === "" ? name : `${relativePath}/${name}`;
      const childMetadata = lstatSync(childPath, {bigint: true});
      if (childMetadata.isDirectory() && !childMetadata.isSymbolicLink()) {
        walk(childPath, childRelativePath, false);
        continue;
      }
      assertTreeEntry(childMetadata, "file");
      const descriptor = openSync(
        childPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const descriptorBefore = fstatSync(descriptor, {bigint: true});
        assertTreeEntry(descriptorBefore, "file");
        const identity = fileIdentity(descriptorBefore);
        if (!sameFileIdentity(identity, fileIdentity(childMetadata))) {
          throw new TypeError("build file path identity changed before read");
        }
        const bytes = readFileSync(descriptor);
        const descriptorAfter = fstatSync(descriptor, {bigint: true});
        const pathAfter = lstatSync(childPath, {bigint: true});
        if (
          !sameFileIdentity(identity, fileIdentity(descriptorAfter))
          || !sameFileIdentity(identity, fileIdentity(pathAfter))
          || BigInt(bytes.byteLength) !== identity.size
        ) throw new TypeError("build file changed while read");
        hashFrame(hash, "file-path", childRelativePath);
        hashFrame(hash, "file-identity", identityFrame(identity));
        hashFrame(hash, "file-bytes", bytes);
        entryCount += 1;
      } finally {
        closeSync(descriptor);
      }
    }
    const afterNames = readdirSync(directory).sort();
    const afterIdentity = fileIdentity(lstatSync(directory, {bigint: true}));
    if (
      names.join("\n") !== afterNames.join("\n")
      || !sameFileIdentity(beforeIdentity, afterIdentity)
    ) throw new TypeError("build directory changed while captured");
  };

  walk(path, "", true);
  const rootIdentity = fileIdentity(lstatSync(path, {bigint: true}));
  return Object.freeze({
    device: rootIdentity.device,
    inode: rootIdentity.inode,
    digest: hash.digest("hex"),
    entryCount,
  });
}

function captureManagedBuildTree(path, root, expectedName, code, message) {
  try {
    return captureBuildTree(path, root, expectedName);
  } catch (error) {
    fail(code, message, {cause: error});
  }
}

function sameBuildTreeEvidence(left, right) {
  return (
    left !== null
    && right !== null
    && typeof left === "object"
    && typeof right === "object"
    && left.device === right.device
    && left.inode === right.inode
    && left.digest === right.digest
    && left.entryCount === right.entryCount
  );
}

function assertBuildTreeEvidence(path, root, expectedName, expected, code) {
  const current = captureManagedBuildTree(
    path,
    root,
    expectedName,
    code,
    "构建制品树无法形成稳定证据。",
  );
  if (!sameBuildTreeEvidence(current, expected)) {
    fail(code, "构建制品树与上一验收阶段的身份或完整 bytes 不一致。");
  }
}

export function captureCandidateBuildEvidence(transaction) {
  const state = assertActiveTransaction(transaction);
  if (state.mode === "preview") {
    try {
      if (
        dirname(transaction.candidatePath) !== state.request.candidatesRoot
        || basename(transaction.candidatePath)
          !== `${state.request.commitSha}.${state.request.controllerPid}`
        || realpathSync(transaction.candidatePath) !== transaction.candidatePath
      ) throw new TypeError("preview candidate identity mismatch");
      return captureBuildTree(
        transaction.candidatePath,
        state.request.candidatesRoot,
        `${state.request.commitSha}.${state.request.controllerPid}`,
      );
    } catch (error) {
      fail("BUILD_PREVIEW_CANDIDATE", "preview 候选制品目录无法形成稳定证据。", {
        cause: error,
      });
    }
  }
  return captureManagedBuildTree(
    transaction.candidatePath,
    state.root,
    basename(transaction.candidatePath),
    "BUILD_CANDIDATE",
    "候选制品目录无法形成稳定证据。",
  );
}

function removePreviewCandidate(state) {
  const path = state.request.candidatePath;
  if (!entryExists(path)) return;
  if (
    dirname(path) !== state.request.candidatesRoot
    || basename(path) !== `${state.request.commitSha}.${state.request.controllerPid}`
  ) {
    fail("BUILD_PREVIEW_CLEANUP_TARGET", "preview 候选清理目标身份不合法。");
  }
  assertOwnedDirectory(
    path,
    "BUILD_PREVIEW_CLEANUP_TARGET",
    "preview 候选清理目标不是自有普通目录。",
  );
  if (realpathSync(path) !== path) {
    fail("BUILD_PREVIEW_CLEANUP_TARGET", "preview 候选清理目标不是规范真实目录。");
  }
  rmSync(path, {recursive: true, force: false});
}

function abortPreviewBuildTransaction(transaction) {
  const state = assertActiveTransaction(transaction);
  let operationError;
  try {
    removePreviewCandidate(state);
  } catch (error) {
    operationError = error;
  }
  try {
    finalizeAbortedTransaction(state);
  } catch (error) {
    operationError = operationError === undefined
      ? error
      : new AggregateError([operationError, error]);
  }
  if (operationError !== undefined) {
    fail("BUILD_PREVIEW_ABORT", "preview 失败候选或私有事务未能完整回收。", {
      cause: operationError,
    });
  }
}

function completePreviewBuildTransaction(transaction, expectedEvidence) {
  const state = assertActiveTransaction(transaction);
  if (state.mode !== "preview") {
    fail("BUILD_PREVIEW_TRANSACTION", "production 事务不能作为 preview 候选完成。");
  }
  const current = captureCandidateBuildEvidence(transaction);
  if (!sameBuildTreeEvidence(current, expectedEvidence)) {
    fail("BUILD_PREVIEW_CANDIDATE_CHANGED", "preview 候选在独立验收后发生漂移。");
  }
  cleanupTransactionRoot(state);
  releaseBuildLock(state);
  state.status = "committed";
}

function quarantineCandidatePath(state, path) {
  if (!entryExists(path)) return;
  const retiredPath = retiredOutputPath(state.root);
  if (entryExists(retiredPath)) {
    fail("BUILD_QUARANTINE_CONFLICT", "失败候选无法进入唯一 retired 隔离路径。");
  }
  renameSync(path, retiredPath);
}

function finalizeAbortedTransaction(state) {
  let finalizationError;
  try {
    cleanupTransactionRoot(state);
  } catch (error) {
    finalizationError = error;
  }
  try {
    releaseBuildLock(state);
  } catch (error) {
    if (finalizationError === undefined) finalizationError = error;
  }
  if (finalizationError !== undefined) throw finalizationError;
  state.status = "aborted";
}

export function abortBuildTransaction(transaction) {
  const state = assertActiveTransaction(transaction);
  if (state.mode !== "production") {
    fail("BUILD_TRANSACTION_MODE", "preview 事务必须使用独立候选回收路径。");
  }
  const backupPath = backupOutputPath(state.root, state.owner);
  if (entryExists(backupPath)) {
    fail("BUILD_ABORT_STATE", "发布前事务出现不应存在的 backup，拒绝猜测恢复。");
  }
  try {
    quarantineCandidatePath(state, transaction.candidatePath);
    finalizeAbortedTransaction(state);
  } catch (error) {
    fail("BUILD_ABORT_ROLLBACK", "失败事务未能完整隔离候选并释放私有状态。", {
      cause: error,
    });
  }
}

function rollbackPublishedCandidate(state, locations, oldEvidence) {
  const buildPath = resolve(state.root, "build");
  const candidatePath = candidateOutputPath(state.root, state.owner);
  const backupPath = backupOutputPath(state.root, state.owner);
  const retiredPath = retiredOutputPath(state.root);

  if (locations.old === "retired") {
    renameSync(retiredPath, backupPath);
    locations.old = "backup";
  }
  if (locations.new === "build") {
    if (entryExists(buildPath)) {
      renameSync(buildPath, candidatePath);
      locations.new = "candidate";
    } else {
      locations.new = "missing";
    }
  }
  if (locations.old === "backup") {
    renameSync(backupPath, buildPath);
    locations.old = "build";
  }
  if (oldEvidence !== undefined) {
    assertBuildTreeEvidence(
      buildPath,
      state.root,
      "build",
      oldEvidence,
      "BUILD_PUBLISH_ROLLBACK",
    );
  } else if (entryExists(buildPath)) {
    fail("BUILD_PUBLISH_ROLLBACK", "首次发布回滚后 build 本应保持不存在。");
  }
  if (locations.new === "candidate") {
    quarantineCandidatePath(state, candidatePath);
    locations.new = "retired";
  }
  if (entryExists(candidatePath) || entryExists(backupPath)) {
    fail("BUILD_PUBLISH_ROLLBACK", "发布回滚遗留 candidate 或 backup 路径。");
  }
  finalizeAbortedTransaction(state);
}

export function publishCandidateBuild({
  transaction,
  expectedCandidateEvidence,
  verifyActivatedBuild,
}) {
  const state = assertActiveTransaction(transaction);
  if (state.mode !== "production") {
    fail("BUILD_TRANSACTION_MODE", "preview 事务不得发布到仓库 build/。");
  }
  if (typeof verifyActivatedBuild !== "function") {
    fail("BUILD_POST_SWITCH_CHECK", "发布事务缺少 post-switch fresh checker。");
  }
  const candidatePath = candidateOutputPath(state.root, state.owner);
  const backupPath = backupOutputPath(state.root, state.owner);
  const retiredPath = retiredOutputPath(state.root);
  const buildPath = resolve(state.root, "build");
  if (entryExists(retiredPath)) {
    fail("BUILD_RETIRED_CONFLICT", "发布前 retired 路径必须已在事务开始时回收。");
  }
  if (entryExists(backupPath)) {
    fail("BUILD_BACKUP_EXISTS", "发布前 backup 路径必须不存在。");
  }
  assertBuildTreeEvidence(
    candidatePath,
    state.root,
    basename(candidatePath),
    expectedCandidateEvidence,
    "BUILD_CANDIDATE_CHANGED",
  );

  const hadBuild = entryExists(buildPath);
  const oldEvidence = hadBuild
    ? captureManagedBuildTree(
        buildPath,
        state.root,
        "build",
        "BUILD_EXISTING_OUTPUT",
        "既有 build 不是稳定自有制品树。",
      )
    : undefined;
  const locations = {
    old: hadBuild ? "build" : "missing",
    new: "candidate",
  };
  try {
    if (hadBuild) {
      renameSync(buildPath, backupPath);
      locations.old = "backup";
    }
    state.hooks.beforeCandidateActivation?.();
    assertBuildTreeEvidence(
      candidatePath,
      state.root,
      basename(candidatePath),
      expectedCandidateEvidence,
      "BUILD_CANDIDATE_CHANGED",
    );
    renameSync(candidatePath, buildPath);
    locations.new = "build";
    assertBuildTreeEvidence(
      buildPath,
      state.root,
      "build",
      expectedCandidateEvidence,
      "BUILD_CANDIDATE_CHANGED",
    );
    state.hooks.afterCandidateActivation?.();
    assertBuildTreeEvidence(
      buildPath,
      state.root,
      "build",
      expectedCandidateEvidence,
      "BUILD_CANDIDATE_CHANGED",
    );
    const verification = verifyActivatedBuild();
    if (verification !== undefined) {
      fail("BUILD_POST_SWITCH_CHECK", "post-switch checker 必须同步完成并返回 undefined。");
    }
    assertBuildTreeEvidence(
      buildPath,
      state.root,
      "build",
      expectedCandidateEvidence,
      "BUILD_CANDIDATE_CHANGED",
    );
    cleanupTransactionRoot(state);
    if (hadBuild) {
      renameSync(backupPath, retiredPath);
      locations.old = "retired";
      assertBuildTreeEvidence(
        retiredPath,
        state.root,
        RETIRED_BUILD_NAME,
        oldEvidence,
        "BUILD_RETIRED_IDENTITY",
      );
    }
    state.hooks.beforeLockRelease?.();
    if (hadBuild) {
      assertBuildTreeEvidence(
        retiredPath,
        state.root,
        RETIRED_BUILD_NAME,
        oldEvidence,
        "BUILD_RETIRED_IDENTITY",
      );
    }
    assertBuildTreeEvidence(
      buildPath,
      state.root,
      "build",
      expectedCandidateEvidence,
      "BUILD_CANDIDATE_CHANGED",
    );
    releaseBuildLock(state);
    state.status = "committed";
  } catch (error) {
    try {
      rollbackPublishedCandidate(state, locations, oldEvidence);
    } catch (rollbackError) {
      fail("BUILD_PUBLISH_ROLLBACK", "候选发布失败且调用前 build 未能完整恢复。", {
        cause: rollbackError,
      });
    }
    if (error instanceof BuildSiteError) throw error;
    fail("BUILD_PUBLISH", "候选制品事务发布失败，调用前 build 已恢复。", {
      cause: error,
    });
  }
}

export function runProductionBuild({root = ROOT, testHooks} = {}) {
  assertCanonicalRoot(root);
  assertAuthorTransactionClear(root);
  assertSupportedNodeVersion({root});
  const owner = randomBytes(32).toString("hex");
  let transaction;
  try {
    transaction = beginBuildTransaction({root, owner, testHooks});
    // 与作者命令形成双锁交叉复核：build 持锁后再次确认作者锁不存在，
    // 作者命令也会在持有作者锁后拒绝本 build lock。
    transactionState(transaction).hooks.afterBuildLockAcquired?.();
    assertAuthorTransactionClear(root);
    const cliPath = resolveDocusaurusCli(root);
    runDocusaurusPhase({
      root,
      cliPath,
      context: createBuildContext("production", owner),
      transactionRoot: transaction.transactionRoot,
      outputPath: transaction.candidatePath,
      phase: "build",
      arguments: ["build", "--out-dir", transaction.candidatePath],
      failureCode: "BUILD_DOCUSARUS",
      failureMessage: "Docusaurus production candidate build 失败。",
    });
    const candidateEvidence = captureCandidateBuildEvidence(transaction);
    runDocusaurusPhase({
      root,
      cliPath,
      context: createBuildContext("production", owner),
      transactionRoot: transaction.transactionRoot,
      outputPath: transaction.candidatePath,
      phase: "check",
      arguments: ["axial-muse:check-production"],
      failureCode: "BUILD_ARTIFACT_CHECK",
      failureMessage: "production candidate 独立制品验收失败。",
    });
    assertBuildTreeEvidence(
      transaction.candidatePath,
      root,
      basename(transaction.candidatePath),
      candidateEvidence,
      "BUILD_CANDIDATE_CHANGED",
    );
    publishCandidateBuild({
      transaction,
      expectedCandidateEvidence: candidateEvidence,
      verifyActivatedBuild() {
        runDocusaurusPhase({
          root,
          cliPath,
          context: createBuildContext("production", owner),
          transactionRoot: transaction.transactionRoot,
          outputPath: resolve(root, "build"),
          phase: "verify",
          arguments: ["axial-muse:check-production"],
          failureCode: "BUILD_POST_SWITCH_CHECK",
          failureMessage: "已切换 build 的 fresh checker 验收失败。",
        });
      },
    });
  } catch (error) {
    if (
      transaction !== undefined
      && transactionStates.get(transaction)?.status === "active"
    ) {
      try {
        abortBuildTransaction(transaction);
      } catch (abortError) {
        fail("BUILD_ABORT_ROLLBACK", "构建失败且事务隔离/回收未完整完成。", {
          cause: abortError,
        });
      }
    }
    throw error;
  }
}

export function runPreviewBuild({
  root = ROOT,
  environment = process.env,
} = {}) {
  assertCanonicalRoot(root);
  assertAuthorTransactionClear(root);
  const role = assertSupportedNodeVersion({root});
  if (role !== "primary") {
    fail("BUILD_PREVIEW_RUNTIME_NODE", "preview 只接受与 checkout .nvmrc 精确一致的主 Node 端点。");
  }
  const request = readPreviewBuildRequest({root, environment});
  const cliPath = resolveDocusaurusCli(root);
  const owner = randomBytes(32).toString("hex");
  let transaction;
  try {
    transaction = beginPreviewBuildTransaction({root, owner, request});
    runDocusaurusPhase({
      root,
      cliPath,
      context: createBuildContext("preview", owner),
      transactionRoot: transaction.transactionRoot,
      outputPath: transaction.candidatePath,
      phase: "build",
      arguments: ["build", "--dev", "--out-dir", transaction.candidatePath],
      failureCode: "BUILD_PREVIEW_DOCUSAURUS",
      failureMessage: "Docusaurus preview candidate build 失败。",
      previewRequest: request,
    });
    validateTransactionRoot(assertActiveTransaction(transaction));
    materializePreviewConfigChunks({
      candidatePath: transaction.candidatePath,
      generatedFilesDirectory: resolve(
        transaction.transactionRoot,
        GENERATED_FILES_DIRECTORY,
      ),
    });
    const evidence = captureCandidateBuildEvidence(transaction);
    runDocusaurusPhase({
      root,
      cliPath,
      context: createBuildContext("preview", owner),
      transactionRoot: transaction.transactionRoot,
      outputPath: transaction.candidatePath,
      phase: "check",
      arguments: ["axial-muse:check-preview"],
      failureCode: "BUILD_PREVIEW_ARTIFACT_CHECK",
      failureMessage: "preview candidate 独立制品验收失败。",
      previewRequest: request,
    });
    completePreviewBuildTransaction(transaction, evidence);
  } catch (error) {
    if (
      transaction !== undefined
      && transactionStates.get(transaction)?.status === "active"
    ) {
      try {
        abortPreviewBuildTransaction(transaction);
      } catch (abortError) {
        fail("BUILD_PREVIEW_ABORT", "preview 构建失败且候选/私有状态未完整回收。", {
          cause: abortError,
        });
      }
    }
    throw error;
  }
}

function runCli() {
  try {
    const {mode} = parseBuildArguments(process.argv.slice(2));
    assertBuildModeAvailable(mode);
    if (mode === "production") runProductionBuild();
    else runPreviewBuild();
  } catch (error) {
    console.error(formatBuildSiteError(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}

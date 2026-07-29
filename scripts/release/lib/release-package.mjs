import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  resolve,
} from "node:path";
import {
  captureFileTree,
  compareFileTreePaths,
  FILE_TREE_MAX_DEPTH,
  FILE_TREE_MAX_FILES,
  FILE_TREE_MAX_PATH_BYTES,
  FILE_TREE_MAX_SEGMENT_BYTES,
  fileTreeContentsEqual,
  fileTreeOperationallyEqual,
  fileTreeRootIdentityEqual,
  FileTreeError,
} from "../../quality/lib/file-tree.mjs";
import {
  CANONICAL_ORIGIN,
  collectPublicHtmlRoutes,
  compileRuntimeRedirectArtifacts,
  readRedirectRegistrySnapshotFromRepositoryRoot,
  REDIRECT_REGISTRY_SOURCE_PATH,
  RuntimeRedirectError,
} from "./runtime-redirects.mjs";

export const RELEASE_SCHEMA_VERSION = "1.0.0";
export const RELEASE_REPOSITORY = "lyty1997/AxialMuseWebsite";
export const RELEASE_PAYLOAD_ROOT = "payload";
export const RELEASE_ROOT_RELATIVE_PATH = "dist/release";
export const RELEASE_JSON_PATH = "metadata/release.json";
export const RELEASE_FILES_PATH = "metadata/files.sha256";
export const RELEASE_RUNTIME_REDIRECTS_PATH =
  "metadata/runtime-redirects.json";
export const RELEASE_NGINX_REDIRECTS_PATH =
  "metadata/nginx/redirects.conf";
export const PUBLIC_ROUTES_WIRE_MAGIC = "AXIALMUSE-PUBLIC-ROUTES-V1";

const BUILD_ROOT_RELATIVE_PATH = "build";
const DIST_ROOT_RELATIVE_PATH = "dist";
const RELEASE_CANDIDATE_PREFIX = ".release-candidate-";
const RELEASE_FAILED_PREFIX = ".release-failed-";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const UNKNOWN_SOURCE_PATH = "release/unknown";
const CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const ERROR_MESSAGES = Object.freeze({
  RELEASE_PACKAGE_INPUT: "release 封装输入不合法。",
  RELEASE_PACKAGE_ROOT: "仓库或 release 路径不符合固定布局。",
  RELEASE_PACKAGE_WORKSPACE: "release 入口必须从干净的规范 Git worktree 运行。",
  RELEASE_PACKAGE_COMMIT: "release 提交身份不合法或在操作期间漂移。",
  RELEASE_PACKAGE_BUILD: "production build 无法形成稳定 release 输入。",
  RELEASE_PACKAGE_PRODUCTION: "release 输入不符合 production build 最小形态。",
  RELEASE_PACKAGE_REGISTRY: "重定向注册表在 release 操作期间漂移。",
  RELEASE_PACKAGE_REDIRECTS: "运行时重定向派生失败。",
  RELEASE_PACKAGE_DIST: "dist 不是空且受控的 release 父目录。",
  RELEASE_PACKAGE_COPY: "payload 无法与 source build 逐路径逐字节绑定。",
  RELEASE_PACKAGE_WRITE: "release metadata 无法完整写入。",
  RELEASE_PACKAGE_LAYOUT: "release 文件集合不符合固定布局。",
  RELEASE_PACKAGE_DERIVED: "release 派生文件无法从 source build 重建。",
  RELEASE_PACKAGE_MANIFEST: "release 文件清单与实际可部署文件不一致。",
  RELEASE_PACKAGE_METADATA: "release metadata 与原始输入和派生摘要不一致。",
  RELEASE_PACKAGE_CHANGED: "build、registry 或 release 在复验期间发生变化。",
  RELEASE_PACKAGE_ACTIVATE: "release 候选无法原子激活。",
  RELEASE_PACKAGE_CLEANUP: "失败 release 候选无法确认清理。",
  RELEASE_PACKAGE_CLEANUP_UNCERTAIN:
    "失败 release 的身份已漂移，无法安全清理。",
});

function isSafeSourcePath(value) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= 4_096
    && !value.startsWith("/")
    && !URL_SCHEME_PATTERN.test(value)
    && !value.includes("\\")
    && !CONTROL_CHARACTER_PATTERN.test(value)
    && value.split("/").every((segment) => (
      segment.length > 0
      && segment !== "."
      && segment !== ".."
    ))
  );
}

export class ReleasePackageError extends Error {
  constructor(code, sourcePath = UNKNOWN_SOURCE_PATH, options = {}) {
    super(ERROR_MESSAGES[code] ?? "release 封装或复验失败。", {
      cause: options.cause,
    });
    this.name = "ReleasePackageError";
    this.code = code;
    this.sourcePath = isSafeSourcePath(sourcePath)
      ? sourcePath
      : UNKNOWN_SOURCE_PATH;
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: undefined,
      writable: false,
    });
  }
}

function fail(code, sourcePath, cause) {
  throw new ReleasePackageError(code, sourcePath, {cause});
}

export function formatReleasePackageError(error) {
  if (!(error instanceof ReleasePackageError)) {
    return "[RELEASE_PACKAGE_INTERNAL] release 处理发生未分类错误；底层细节已抑制。";
  }
  return `[${error.code}] (${error.sourcePath}) ${error.message}`;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readDataProperties(value, allowedKeys, requiredKeys, sourcePath) {
  let descriptors;
  let keys;
  try {
    if (!isPlainRecord(value)) throw new TypeError("not a plain record");
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(descriptors);
  } catch (cause) {
    fail("RELEASE_PACKAGE_INPUT", sourcePath, cause);
  }
  if (
    keys.some((key) => (
      typeof key !== "string"
      || !allowedKeys.includes(key)
      || !Object.hasOwn(descriptors[key], "value")
    ))
    || requiredKeys.some((key) => !keys.includes(key))
  ) {
    fail("RELEASE_PACKAGE_INPUT", sourcePath);
  }
  return Object.freeze(Object.fromEntries(
    allowedKeys
      .filter((key) => keys.includes(key))
      .map((key) => [key, descriptors[key].value]),
  ));
}

function normalizeHooks(value, allowedKeys, sourcePath) {
  if (value === undefined) return Object.freeze({});
  const hooks = readDataProperties(value, allowedKeys, [], sourcePath);
  if (Object.values(hooks).some((hook) => typeof hook !== "function")) {
    fail("RELEASE_PACKAGE_INPUT", sourcePath);
  }
  return hooks;
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertCanonicalDirectory(path, sourcePath) {
  try {
    if (
      typeof path !== "string"
      || !isAbsolute(path)
      || resolve(path) !== path
      || realpathSync(path) !== path
    ) {
      throw new TypeError("directory is not canonical");
    }
    const metadata = lstatSync(path, {bigint: true});
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new TypeError("directory is not ordinary");
    }
    return Object.freeze({
      device: metadata.dev,
      inode: metadata.ino,
    });
  } catch (cause) {
    fail("RELEASE_PACKAGE_ROOT", sourcePath, cause);
  }
}

function assertCanonicalRepositoryRoot(repositoryRoot) {
  return assertCanonicalDirectory(repositoryRoot, "repository");
}

function assertDirectChild(path, parent, name, sourcePath) {
  if (
    resolve(parent, name) !== path
    || dirname(path) !== parent
    || basename(path) !== name
  ) {
    fail("RELEASE_PACKAGE_ROOT", sourcePath);
  }
}

function gitEnvironment() {
  const environment = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP"]) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  return Object.freeze({
    ...environment,
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
  });
}

function runGit(repositoryRoot, arguments_, spawnProcess) {
  let result;
  try {
    result = spawnProcess(
      "git",
      ["-C", repositoryRoot, "-c", "core.commitGraph=false", ...arguments_],
      {
        cwd: repositoryRoot,
        env: gitEnvironment(),
        encoding: "utf8",
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: 10_000,
        windowsHide: true,
      },
    );
  } catch (cause) {
    fail("RELEASE_PACKAGE_WORKSPACE", "git", cause);
  }
  if (
    result === null
    || typeof result !== "object"
    || result.error
    || result.signal
    || result.status !== 0
    || typeof result.stdout !== "string"
    || typeof result.stderr !== "string"
  ) {
    fail("RELEASE_PACKAGE_WORKSPACE", "git", result?.error);
  }
  return result.stdout;
}

export function captureReleaseRepositoryState({
  repositoryRoot,
  spawnProcess = spawnSync,
} = {}) {
  assertCanonicalRepositoryRoot(repositoryRoot);
  if (typeof spawnProcess !== "function") {
    fail("RELEASE_PACKAGE_INPUT", "git");
  }
  const topLevel = runGit(
    repositoryRoot,
    ["rev-parse", "--show-toplevel"],
    spawnProcess,
  );
  const bare = runGit(
    repositoryRoot,
    ["rev-parse", "--is-bare-repository"],
    spawnProcess,
  );
  const inside = runGit(
    repositoryRoot,
    ["rev-parse", "--is-inside-work-tree"],
    spawnProcess,
  );
  const commitSha = runGit(
    repositoryRoot,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    spawnProcess,
  );
  const status = runGit(
    repositoryRoot,
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    spawnProcess,
  );
  if (
    topLevel !== `${repositoryRoot}\n`
    || bare !== "false\n"
    || inside !== "true\n"
    || !COMMIT_PATTERN.test(commitSha.trim())
    || commitSha !== `${commitSha.trim()}\n`
    || status !== ""
  ) {
    fail("RELEASE_PACKAGE_WORKSPACE", "git");
  }
  return Object.freeze({commitSha: commitSha.trim()});
}

function assertRepositoryStateUnchanged(initial, current) {
  if (
    !isPlainRecord(initial)
    || !isPlainRecord(current)
    || initial.commitSha !== current.commitSha
    || !COMMIT_PATTERN.test(initial.commitSha ?? "")
  ) {
    fail("RELEASE_PACKAGE_COMMIT", "git/HEAD");
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeUint64(hash, value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  hash.update(bytes);
}

export function digestPublicRoutes(publicRoutes) {
  if (!Array.isArray(publicRoutes)) {
    fail("RELEASE_PACKAGE_INPUT", "build#publicRoutes");
  }
  const routes = [...publicRoutes];
  if (
    routes.some((route) => (
      typeof route !== "string"
      || route.length === 0
      || !route.startsWith("/")
      || route.includes("\\")
      || CONTROL_CHARACTER_PATTERN.test(route)
    ))
  ) {
    fail("RELEASE_PACKAGE_INPUT", "build#publicRoutes");
  }
  routes.sort(compareFileTreePaths);
  if (
    new Set(routes).size !== routes.length
    || routes.some((route, index) => route !== publicRoutes[index])
  ) {
    fail("RELEASE_PACKAGE_INPUT", "build#publicRoutes");
  }
  const hash = createHash("sha256");
  hash.update(PUBLIC_ROUTES_WIRE_MAGIC, "ascii");
  hash.update(Buffer.from([0]));
  for (const route of routes) {
    const bytes = Buffer.from(route, "utf8");
    writeUint64(hash, bytes.byteLength);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function validateManifestEntry(entry, index) {
  const sourcePath = `${RELEASE_FILES_PATH}#entries[${index}]`;
  const values = readDataProperties(
    entry,
    ["path", "sha256"],
    ["path", "sha256"],
    sourcePath,
  );
  const segments = typeof values.path === "string"
    ? values.path.split("/")
    : [];
  const pathBytes = typeof values.path === "string"
    ? Buffer.from(values.path, "utf8")
    : Buffer.alloc(0);
  if (
    typeof values.path !== "string"
    || values.path.length === 0
    || values.path.startsWith("/")
    || values.path.includes("\\")
    || values.path.normalize("NFC") !== values.path
    || pathBytes.toString("utf8") !== values.path
    || pathBytes.byteLength > FILE_TREE_MAX_PATH_BYTES
    || CONTROL_CHARACTER_PATTERN.test(values.path)
    || segments.length > FILE_TREE_MAX_DEPTH
    || segments.some((segment) => (
      segment.length === 0
      || segment === "."
      || segment === ".."
      || segment.startsWith(".")
      || Buffer.byteLength(segment, "utf8") > FILE_TREE_MAX_SEGMENT_BYTES
    ))
    || typeof values.sha256 !== "string"
    || !HEX_64_PATTERN.test(values.sha256)
  ) {
    fail("RELEASE_PACKAGE_INPUT", sourcePath);
  }
  return Object.freeze({path: values.path, sha256: values.sha256});
}

export function renderFilesManifest(entries) {
  if (!Array.isArray(entries) || entries.length > FILE_TREE_MAX_FILES) {
    fail("RELEASE_PACKAGE_INPUT", RELEASE_FILES_PATH);
  }
  const normalized = entries.map(validateManifestEntry)
    .sort((left, right) => compareFileTreePaths(left.path, right.path));
  const seen = new Set();
  const folded = new Set();
  let outputBytes = 0;
  for (const entry of normalized) {
    const foldedPath = entry.path.toLowerCase();
    if (seen.has(entry.path) || folded.has(foldedPath)) {
      fail("RELEASE_PACKAGE_INPUT", entry.path);
    }
    seen.add(entry.path);
    folded.add(foldedPath);
    outputBytes += 64 + 2 + Buffer.byteLength(entry.path, "utf8") + 1;
    if (outputBytes > MAX_METADATA_BYTES) {
      fail("RELEASE_PACKAGE_WRITE", RELEASE_FILES_PATH);
    }
  }
  const value = normalized
    .map((entry) => `${entry.sha256}  ${entry.path}\n`)
    .join("");
  const bytes = Buffer.from(value, "utf8");
  if (
    bytes.byteLength !== outputBytes
    || bytes.byteLength > MAX_METADATA_BYTES
  ) {
    fail("RELEASE_PACKAGE_WRITE", RELEASE_FILES_PATH);
  }
  return Object.freeze({
    bytes,
    entries: Object.freeze(normalized),
  });
}

function validateReleaseMetadata(metadata) {
  const sourcePath = RELEASE_JSON_PATH;
  const keys = [
    "schemaVersion",
    "repository",
    "commitSha",
    "payloadRoot",
    "sourceBuildTreeSha256",
    "redirectRegistrySha256",
    "publicRoutesSha256",
    "runtimeRedirectsSha256",
    "nginxRedirectsSha256",
    "registeredRuleCount",
    "canonicalSlashRuleCount",
    "ruleCount",
    "filesSha256",
    "fileCount",
  ];
  const values = readDataProperties(metadata, keys, keys, sourcePath);
  if (
    values.schemaVersion !== RELEASE_SCHEMA_VERSION
    || values.repository !== RELEASE_REPOSITORY
    || !COMMIT_PATTERN.test(values.commitSha ?? "")
    || values.payloadRoot !== RELEASE_PAYLOAD_ROOT
    || [
      values.sourceBuildTreeSha256,
      values.redirectRegistrySha256,
      values.publicRoutesSha256,
      values.runtimeRedirectsSha256,
      values.nginxRedirectsSha256,
      values.filesSha256,
    ].some((value) => typeof value !== "string" || !HEX_64_PATTERN.test(value))
    || [
      values.registeredRuleCount,
      values.canonicalSlashRuleCount,
      values.ruleCount,
      values.fileCount,
    ].some((value) => !Number.isSafeInteger(value) || value < 0)
    || (
      values.registeredRuleCount + values.canonicalSlashRuleCount
      !== values.ruleCount
    )
  ) {
    fail("RELEASE_PACKAGE_INPUT", sourcePath);
  }
  return values;
}

export function renderReleaseMetadata(metadata) {
  const values = validateReleaseMetadata(metadata);
  return Buffer.from(`${JSON.stringify(values, null, 2)}\n`, "utf8");
}

function registrySnapshotsEqual(left, right) {
  return (
    left.rawSha256 === right.rawSha256
    && left.byteLength === right.byteLength
    && left.operationalSha256 === right.operationalSha256
  );
}

function captureRegistry(repositoryRoot) {
  try {
    return readRedirectRegistrySnapshotFromRepositoryRoot(repositoryRoot);
  } catch (cause) {
    if (cause instanceof RuntimeRedirectError) {
      fail("RELEASE_PACKAGE_REGISTRY", cause.sourcePath, cause);
    }
    fail("RELEASE_PACKAGE_REGISTRY", REDIRECT_REGISTRY_SOURCE_PATH, cause);
  }
}

function deriveRedirects(buildRoot, registrySnapshot) {
  try {
    return compileRuntimeRedirectArtifacts({
      publicRoutes: collectPublicHtmlRoutes(buildRoot),
      registry: registrySnapshot.registry,
      canonicalOrigin: CANONICAL_ORIGIN,
    });
  } catch (cause) {
    if (cause instanceof RuntimeRedirectError) {
      fail("RELEASE_PACKAGE_REDIRECTS", cause.sourcePath, cause);
    }
    fail("RELEASE_PACKAGE_REDIRECTS", BUILD_ROOT_RELATIVE_PATH, cause);
  }
}

function captureTree(root, sourcePath, errorCode) {
  try {
    return captureFileTree({root, sourcePath});
  } catch (cause) {
    if (cause instanceof FileTreeError) {
      fail(errorCode, cause.sourcePath, cause);
    }
    fail(errorCode, sourcePath, cause);
  }
}

function assertProductionBuildShape(buildCapture) {
  const paths = new Set(buildCapture.records.map((record) => record.path));
  if (!paths.has("index.html") || !paths.has("sitemap.xml")) {
    fail("RELEASE_PACKAGE_PRODUCTION", BUILD_ROOT_RELATIVE_PATH);
  }
}

function runProductionBuildVerification(
  verifyProductionBuild,
  repositoryRoot,
  expectedBuild,
  expectedRegistry,
) {
  let result;
  try {
    result = verifyProductionBuild(Object.freeze({repositoryRoot}));
  } catch (cause) {
    fail("RELEASE_PACKAGE_PRODUCTION", BUILD_ROOT_RELATIVE_PATH, cause);
  }
  if (result !== undefined) {
    fail("RELEASE_PACKAGE_PRODUCTION", BUILD_ROOT_RELATIVE_PATH);
  }
  const buildAfter = captureTree(
    resolve(repositoryRoot, BUILD_ROOT_RELATIVE_PATH),
    BUILD_ROOT_RELATIVE_PATH,
    "RELEASE_PACKAGE_PRODUCTION",
  );
  const registryAfter = captureRegistry(repositoryRoot);
  if (
    !fileTreeOperationallyEqual(expectedBuild, buildAfter)
    || !registrySnapshotsEqual(expectedRegistry, registryAfter)
  ) {
    fail("RELEASE_PACKAGE_PRODUCTION", BUILD_ROOT_RELATIVE_PATH);
  }
}

function ensurePrivateDirectory(
  path,
  expectedParent,
  expectedName,
  sourcePath,
  ownership,
  relativePath,
) {
  assertDirectChild(path, expectedParent, expectedName, sourcePath);
  try {
    mkdirSync(path, {mode: 0o700});
    const identity = secureOwnedDirectory(
      path,
      sourcePath,
      "RELEASE_PACKAGE_WRITE",
    );
    recordOwnedDirectory(ownership, relativePath, identity, sourcePath);
  } catch (cause) {
    if (cause instanceof ReleasePackageError) throw cause;
    fail("RELEASE_PACKAGE_WRITE", sourcePath, cause);
  }
}

function ensurePayloadParent(payloadRoot, relativePath, ownership) {
  const segments = relativePath.split("/").slice(0, -1);
  let current = payloadRoot;
  const ownedSegments = [RELEASE_PAYLOAD_ROOT];
  for (const segment of segments) {
    const next = resolve(current, segment);
    ownedSegments.push(segment);
    const ownedRelativePath = ownedSegments.join("/");
    if (!pathExists(next)) {
      try {
        mkdirSync(next, {mode: 0o700});
        const identity = secureOwnedDirectory(
          next,
          `${RELEASE_PAYLOAD_ROOT}/${relativePath}`,
          "RELEASE_PACKAGE_COPY",
        );
        recordOwnedDirectory(
          ownership,
          ownedRelativePath,
          identity,
          `${RELEASE_PAYLOAD_ROOT}/${relativePath}`,
        );
      } catch (cause) {
        if (cause instanceof ReleasePackageError) throw cause;
        fail("RELEASE_PACKAGE_COPY", `${RELEASE_PAYLOAD_ROOT}/${relativePath}`, cause);
      }
    }
    try {
      assertOwnedDirectoryAtPath(
        next,
        ownership.directories.get(ownedRelativePath),
        `${RELEASE_PAYLOAD_ROOT}/${relativePath}`,
        "RELEASE_PACKAGE_COPY",
      );
    } catch (cause) {
      if (cause instanceof ReleasePackageError) throw cause;
      fail("RELEASE_PACKAGE_COPY", `${RELEASE_PAYLOAD_ROOT}/${relativePath}`, cause);
    }
    current = next;
  }
}

function syncOrdinaryFile(path, sourcePath) {
  let descriptor;
  let identity;
  let operationError;
  try {
    if (realpathSync(path) !== path) {
      throw new TypeError("file path traverses a symbolic link");
    }
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = fstatSync(descriptor, {bigint: true});
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.nlink !== 1n
    ) {
      throw new TypeError("file is not a single-link regular file");
    }
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    const after = fstatSync(descriptor, {bigint: true});
    const pathAfter = lstatSync(path, {bigint: true});
    if (
      !sameFileIdentity(fileIdentity(after), fileIdentity(pathAfter))
      || realpathSync(path) !== path
      || (after.mode & 0o777n) !== 0o600n
    ) {
      throw new TypeError("file ownership changed while syncing");
    }
    identity = fileIdentity(after);
  } catch (cause) {
    operationError = cause;
  }
  let closeError;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (cause) {
      closeError = cause;
    }
  }
  if (
    operationError !== undefined
    || closeError !== undefined
    || identity === undefined
  ) {
    const cause = operationError !== undefined && closeError !== undefined
      ? new AggregateError([operationError, closeError])
      : operationError ?? closeError;
    fail("RELEASE_PACKAGE_COPY", sourcePath, cause);
  }
  return identity;
}

function writeCanonicalFile(path, bytes, sourcePath) {
  let descriptor;
  let identity;
  let operationError;
  try {
    if (!Buffer.isBuffer(bytes) || bytes.byteLength > MAX_METADATA_BYTES) {
      throw new TypeError("canonical bytes exceed metadata boundary");
    }
    descriptor = openSync(
      path,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    const descriptorMetadata = fstatSync(descriptor, {bigint: true});
    const pathMetadata = lstatSync(path, {bigint: true});
    if (
      descriptorMetadata.isSymbolicLink()
      || !descriptorMetadata.isFile()
      || descriptorMetadata.nlink !== 1n
      || pathMetadata.isSymbolicLink()
      || !pathMetadata.isFile()
      || pathMetadata.nlink !== 1n
      || descriptorMetadata.dev !== pathMetadata.dev
      || descriptorMetadata.ino !== pathMetadata.ino
      || descriptorMetadata.size !== BigInt(bytes.byteLength)
      || (descriptorMetadata.mode & 0o777n) !== 0o600n
    ) {
      throw new TypeError("canonical file identity mismatch");
    }
    identity = fileIdentity(descriptorMetadata);
  } catch (cause) {
    operationError = cause;
  }
  let closeError;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (cause) {
      closeError = cause;
    }
  }
  if (
    operationError !== undefined
    || closeError !== undefined
    || identity === undefined
  ) {
    const cause = operationError !== undefined && closeError !== undefined
      ? new AggregateError([operationError, closeError])
      : operationError ?? closeError;
    fail("RELEASE_PACKAGE_WRITE", sourcePath, cause);
  }
  return identity;
}

function copyPayload(
  buildRoot,
  payloadRoot,
  buildCapture,
  hooks,
  ownership,
) {
  for (const record of buildCapture.records) {
    const source = resolve(buildRoot, record.path);
    const target = resolve(payloadRoot, record.path);
    ensurePayloadParent(payloadRoot, record.path, ownership);
    const ownedRelativePath = `${RELEASE_PAYLOAD_ROOT}/${record.path}`;
    try {
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      hooks.afterTargetCopiedBeforeSync?.(Object.freeze({
        relativePath: record.path,
      }));
      const identity = syncOrdinaryFile(target, ownedRelativePath);
      recordOwnedFile(
        ownership,
        ownedRelativePath,
        identity,
        ownedRelativePath,
      );
    } catch (cause) {
      if (cause instanceof ReleasePackageError) throw cause;
      fail("RELEASE_PACKAGE_COPY", ownedRelativePath, cause);
    }
    hooks.afterFileCopied?.(Object.freeze({relativePath: record.path}));
    assertOwnedFileAtPath(
      target,
      ownership.files.get(ownedRelativePath),
      ownedRelativePath,
      "RELEASE_PACKAGE_COPY",
    );
  }
}

function createManifestEntries(payloadCapture, redirects) {
  return Object.freeze([
    ...payloadCapture.records.map((record) => Object.freeze({
      path: `${RELEASE_PAYLOAD_ROOT}/${record.path}`,
      sha256: record.sha256,
    })),
    Object.freeze({
      path: RELEASE_RUNTIME_REDIRECTS_PATH,
      sha256: sha256(Buffer.from(redirects.runtimeRedirectsJson, "utf8")),
    }),
    Object.freeze({
      path: RELEASE_NGINX_REDIRECTS_PATH,
      sha256: sha256(Buffer.from(redirects.nginxRedirectsConfig, "utf8")),
    }),
  ]);
}

function expectedMetadata({
  commitSha,
  buildCapture,
  registrySnapshot,
  redirects,
  filesManifest,
}) {
  return Object.freeze({
    schemaVersion: RELEASE_SCHEMA_VERSION,
    repository: RELEASE_REPOSITORY,
    commitSha,
    payloadRoot: RELEASE_PAYLOAD_ROOT,
    sourceBuildTreeSha256: buildCapture.treeSha256,
    redirectRegistrySha256: registrySnapshot.rawSha256,
    publicRoutesSha256: digestPublicRoutes(redirects.publicRoutes),
    runtimeRedirectsSha256: sha256(
      Buffer.from(redirects.runtimeRedirectsJson, "utf8"),
    ),
    nginxRedirectsSha256: sha256(
      Buffer.from(redirects.nginxRedirectsConfig, "utf8"),
    ),
    registeredRuleCount: redirects.registeredRuleCount,
    canonicalSlashRuleCount: redirects.canonicalSlashRuleCount,
    ruleCount: redirects.rules.length,
    filesSha256: sha256(filesManifest.bytes),
    fileCount: filesManifest.entries.length,
  });
}

function expectedReleasePaths(buildCapture) {
  return Object.freeze([
    ...buildCapture.records.map((record) => (
      `${RELEASE_PAYLOAD_ROOT}/${record.path}`
    )),
    RELEASE_RUNTIME_REDIRECTS_PATH,
    RELEASE_NGINX_REDIRECTS_PATH,
    RELEASE_JSON_PATH,
    RELEASE_FILES_PATH,
  ].sort(compareFileTreePaths));
}

function assertReleaseLayout(releaseCapture, buildCapture) {
  const expected = expectedReleasePaths(buildCapture);
  const actual = releaseCapture.records.map((record) => record.path);
  if (
    actual.length !== expected.length
    || actual.some((path, index) => path !== expected[index])
  ) {
    fail("RELEASE_PACKAGE_LAYOUT", RELEASE_ROOT_RELATIVE_PATH);
  }
}

function readCapturedReleaseFile(releaseRoot, releaseCapture, relativePath) {
  const record = releaseCapture.records.find((entry) => entry.path === relativePath);
  if (record === undefined || record.byteLength > MAX_METADATA_BYTES) {
    fail("RELEASE_PACKAGE_LAYOUT", relativePath);
  }
  const path = resolve(releaseRoot, relativePath);
  let descriptor;
  let bytes;
  let operationError;
  try {
    if (realpathSync(path) !== path) {
      throw new TypeError("release file traverses symbolic link");
    }
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor, {bigint: true});
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || before.nlink !== 1n
      || before.size !== BigInt(record.byteLength)
    ) {
      throw new TypeError("release file identity mismatch");
    }
    bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, {bigint: true});
    const pathAfter = lstatSync(path, {bigint: true});
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.mode !== after.mode
      || before.nlink !== after.nlink
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || after.dev !== pathAfter.dev
      || after.ino !== pathAfter.ino
      || after.mode !== pathAfter.mode
      || after.nlink !== pathAfter.nlink
      || after.size !== pathAfter.size
      || sha256(bytes) !== record.sha256
    ) {
      throw new TypeError("release file changed while read");
    }
  } catch (cause) {
    operationError = cause;
  }
  let closeError;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (cause) {
      closeError = cause;
    }
  }
  if (
    operationError !== undefined
    || closeError !== undefined
    || bytes === undefined
  ) {
    const cause = operationError !== undefined && closeError !== undefined
      ? new AggregateError([operationError, closeError])
      : operationError ?? closeError;
    fail("RELEASE_PACKAGE_LAYOUT", relativePath, cause);
  }
  return bytes;
}

function assertBytesEqual(actual, expected, code, sourcePath) {
  if (
    actual.byteLength !== expected.byteLength
    || !actual.equals(expected)
  ) {
    fail(code, sourcePath);
  }
}

function verifyReleaseAt({
  repositoryRoot,
  releaseRoot,
  commitSha,
  sourcePath,
}) {
  if (!COMMIT_PATTERN.test(commitSha)) {
    fail("RELEASE_PACKAGE_COMMIT", "git/HEAD");
  }
  assertCanonicalDirectory(releaseRoot, sourcePath);
  const buildRoot = resolve(repositoryRoot, BUILD_ROOT_RELATIVE_PATH);
  assertDirectChild(
    buildRoot,
    repositoryRoot,
    BUILD_ROOT_RELATIVE_PATH,
    BUILD_ROOT_RELATIVE_PATH,
  );
  assertCanonicalDirectory(buildRoot, BUILD_ROOT_RELATIVE_PATH);

  const buildBefore = captureTree(
    buildRoot,
    BUILD_ROOT_RELATIVE_PATH,
    "RELEASE_PACKAGE_BUILD",
  );
  assertProductionBuildShape(buildBefore);
  const registryBefore = captureRegistry(repositoryRoot);
  const redirects = deriveRedirects(buildRoot, registryBefore);
  const releaseBefore = captureTree(
    releaseRoot,
    sourcePath,
    "RELEASE_PACKAGE_LAYOUT",
  );
  assertReleaseLayout(releaseBefore, buildBefore);
  const payloadRoot = resolve(releaseRoot, RELEASE_PAYLOAD_ROOT);
  assertCanonicalDirectory(payloadRoot, RELEASE_PAYLOAD_ROOT);
  const payloadCapture = captureTree(
    payloadRoot,
    RELEASE_PAYLOAD_ROOT,
    "RELEASE_PACKAGE_COPY",
  );
  if (!fileTreeContentsEqual(buildBefore, payloadCapture)) {
    fail("RELEASE_PACKAGE_COPY", RELEASE_PAYLOAD_ROOT);
  }

  const expectedRuntime = Buffer.from(redirects.runtimeRedirectsJson, "utf8");
  const expectedNginx = Buffer.from(redirects.nginxRedirectsConfig, "utf8");
  assertBytesEqual(
    readCapturedReleaseFile(
      releaseRoot,
      releaseBefore,
      RELEASE_RUNTIME_REDIRECTS_PATH,
    ),
    expectedRuntime,
    "RELEASE_PACKAGE_DERIVED",
    RELEASE_RUNTIME_REDIRECTS_PATH,
  );
  assertBytesEqual(
    readCapturedReleaseFile(
      releaseRoot,
      releaseBefore,
      RELEASE_NGINX_REDIRECTS_PATH,
    ),
    expectedNginx,
    "RELEASE_PACKAGE_DERIVED",
    RELEASE_NGINX_REDIRECTS_PATH,
  );

  const filesManifest = renderFilesManifest(
    createManifestEntries(payloadCapture, redirects),
  );
  assertBytesEqual(
    readCapturedReleaseFile(
      releaseRoot,
      releaseBefore,
      RELEASE_FILES_PATH,
    ),
    filesManifest.bytes,
    "RELEASE_PACKAGE_MANIFEST",
    RELEASE_FILES_PATH,
  );
  const releaseMetadata = renderReleaseMetadata(expectedMetadata({
    commitSha,
    buildCapture: buildBefore,
    registrySnapshot: registryBefore,
    redirects,
    filesManifest,
  }));
  assertBytesEqual(
    readCapturedReleaseFile(
      releaseRoot,
      releaseBefore,
      RELEASE_JSON_PATH,
    ),
    releaseMetadata,
    "RELEASE_PACKAGE_METADATA",
    RELEASE_JSON_PATH,
  );

  const buildAfter = captureTree(
    buildRoot,
    BUILD_ROOT_RELATIVE_PATH,
    "RELEASE_PACKAGE_CHANGED",
  );
  const registryAfter = captureRegistry(repositoryRoot);
  const releaseAfter = captureTree(
    releaseRoot,
    sourcePath,
    "RELEASE_PACKAGE_CHANGED",
  );
  if (
    !fileTreeOperationallyEqual(buildBefore, buildAfter)
    || !registrySnapshotsEqual(registryBefore, registryAfter)
    || !fileTreeOperationallyEqual(releaseBefore, releaseAfter)
  ) {
    fail("RELEASE_PACKAGE_CHANGED", sourcePath);
  }
  return Object.freeze({
    buildCapture: buildAfter,
    registrySnapshot: registryAfter,
    releaseCapture: releaseAfter,
    redirects,
  });
}

function directoryIdentityFromMetadata(metadata) {
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    owner: metadata.uid,
    group: metadata.gid,
  });
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
    left !== undefined
    && right !== undefined
    && left.device === right.device
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

function sameFileOwnership(left, right) {
  return (
    left !== undefined
    && right !== undefined
    && left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.linkCount === right.linkCount
    && left.owner === right.owner
    && left.group === right.group
  );
}

function directoryIdentity(
  path,
  sourcePath,
  errorCode = "RELEASE_PACKAGE_ROOT",
) {
  try {
    const metadata = lstatSync(path, {bigint: true});
    if (
      metadata.isSymbolicLink()
      || !metadata.isDirectory()
      || realpathSync(path) !== path
      || (metadata.mode & 0o777n) !== 0o700n
      || (
        typeof process.getuid === "function"
        && metadata.uid !== BigInt(process.getuid())
      )
    ) {
      throw new TypeError("directory identity mismatch");
    }
    return directoryIdentityFromMetadata(metadata);
  } catch (cause) {
    fail(errorCode, sourcePath, cause);
  }
}

function sameDirectoryIdentity(left, right) {
  return (
    left !== undefined
    && right !== undefined
    && left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.owner === right.owner
    && left.group === right.group
  );
}

function sameDirectoryObject(left, right) {
  return (
    left !== undefined
    && right !== undefined
    && left.device === right.device
    && left.inode === right.inode
    && left.owner === right.owner
    && left.group === right.group
  );
}

function secureOwnedDirectory(path, sourcePath, errorCode) {
  let descriptor;
  let identity;
  let operationError;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    fchmodSync(descriptor, 0o700);
    fsyncSync(descriptor);
    const descriptorMetadata = fstatSync(descriptor, {bigint: true});
    const pathMetadata = lstatSync(path, {bigint: true});
    if (
      descriptorMetadata.isSymbolicLink()
      || !descriptorMetadata.isDirectory()
      || pathMetadata.isSymbolicLink()
      || !pathMetadata.isDirectory()
      || realpathSync(path) !== path
      || (descriptorMetadata.mode & 0o777n) !== 0o700n
      || !sameDirectoryIdentity(
        directoryIdentityFromMetadata(descriptorMetadata),
        directoryIdentityFromMetadata(pathMetadata),
      )
    ) {
      throw new TypeError("owned directory identity mismatch");
    }
    identity = directoryIdentityFromMetadata(descriptorMetadata);
  } catch (cause) {
    operationError = cause;
  }
  let closeError;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (cause) {
      closeError = cause;
    }
  }
  if (
    operationError !== undefined
    || closeError !== undefined
    || identity === undefined
  ) {
    const cause = operationError !== undefined && closeError !== undefined
      ? new AggregateError([operationError, closeError])
      : operationError ?? closeError;
    fail(errorCode, sourcePath, cause);
  }
  return identity;
}

function createCandidateOwnership(candidate) {
  return {
    directories: new Map([["", candidate.identity]]),
    files: new Map(),
    rootIdentity: candidate.identity,
  };
}

function recordOwnedDirectory(
  ownership,
  relativePath,
  identity,
  sourcePath,
) {
  const existing = ownership.directories.get(relativePath);
  if (
    ownership.files.has(relativePath)
    || (
      existing !== undefined
      && !sameDirectoryIdentity(existing, identity)
    )
  ) {
    fail("RELEASE_PACKAGE_WRITE", sourcePath);
  }
  ownership.directories.set(relativePath, identity);
}

function recordOwnedFile(
  ownership,
  relativePath,
  identity,
  sourcePath,
) {
  if (
    ownership.directories.has(relativePath)
    || ownership.files.has(relativePath)
  ) {
    fail("RELEASE_PACKAGE_WRITE", sourcePath);
  }
  ownership.files.set(relativePath, identity);
}

function assertOwnedDirectoryAtPath(
  path,
  expected,
  sourcePath,
  errorCode,
) {
  if (expected === undefined) fail(errorCode, sourcePath);
  const actual = directoryIdentity(path, sourcePath, errorCode);
  if (!sameDirectoryIdentity(expected, actual)) {
    fail(errorCode, sourcePath);
  }
}

function assertOwnedFileAtPath(
  path,
  expected,
  sourcePath,
  errorCode,
  ownershipOnly = false,
) {
  try {
    if (expected === undefined || realpathSync(path) !== path) {
      throw new TypeError("owned file path mismatch");
    }
    const metadata = lstatSync(path, {bigint: true});
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.nlink !== 1n
      || !(
        ownershipOnly
          ? sameFileOwnership(expected, fileIdentity(metadata))
          : sameFileIdentity(expected, fileIdentity(metadata))
      )
    ) {
      throw new TypeError("owned file identity mismatch");
    }
  } catch (cause) {
    fail(errorCode, sourcePath, cause);
  }
}

function decodeOwnedEntryName(bytes) {
  const name = bytes.toString("utf8");
  if (
    name.length === 0
    || !Buffer.from(name, "utf8").equals(bytes)
    || name.includes("/")
  ) {
    throw new TypeError("owned entry name is not canonical UTF-8");
  }
  return name;
}

function assertCandidateOwnership(
  root,
  ownership,
  errorCode,
  sourcePath = RELEASE_ROOT_RELATIVE_PATH,
  ownershipOnly = false,
) {
  try {
    assertOwnedDirectoryAtPath(
      root,
      ownership.rootIdentity,
      sourcePath,
      errorCode,
    );
    const seenDirectories = new Set([""]);
    const seenFiles = new Set();
    const walk = (directory, parentRelativePath) => {
      const names = readdirSync(directory, {encoding: "buffer"})
        .map((value) => Buffer.from(value))
        .sort((left, right) => Buffer.compare(left, right));
      for (const bytes of names) {
        const name = decodeOwnedEntryName(bytes);
        const relativePath = parentRelativePath === ""
          ? name
          : `${parentRelativePath}/${name}`;
        const path = resolve(directory, name);
        const metadata = lstatSync(path, {bigint: true});
        if (metadata.isSymbolicLink()) {
          throw new TypeError("owned tree contains a symbolic link");
        }
        if (metadata.isDirectory()) {
          assertOwnedDirectoryAtPath(
            path,
            ownership.directories.get(relativePath),
            sourcePath,
            errorCode,
          );
          seenDirectories.add(relativePath);
          walk(path, relativePath);
          continue;
        }
        if (metadata.isFile()) {
          assertOwnedFileAtPath(
            path,
            ownership.files.get(relativePath),
            sourcePath,
            errorCode,
            ownershipOnly,
          );
          seenFiles.add(relativePath);
          continue;
        }
        throw new TypeError("owned tree contains a special file");
      }
    };
    walk(root, "");
    if (
      seenDirectories.size !== ownership.directories.size
      || seenFiles.size !== ownership.files.size
    ) {
      throw new TypeError("owned tree member set mismatch");
    }
  } catch (cause) {
    if (cause instanceof ReleasePackageError) throw cause;
    fail(errorCode, sourcePath, cause);
  }
}

function syncOwnedDirectories(root, ownership, errorCode) {
  const relativePaths = [...ownership.directories.keys()].sort((left, right) => (
    right.split("/").length - left.split("/").length
    || compareFileTreePaths(left, right)
  ));
  for (const relativePath of relativePaths) {
    const path = relativePath === "" ? root : resolve(root, relativePath);
    const sourcePath = relativePath === ""
      ? RELEASE_ROOT_RELATIVE_PATH
      : relativePath;
    let descriptor;
    let operationError;
    try {
      assertOwnedDirectoryAtPath(
        path,
        ownership.directories.get(relativePath),
        sourcePath,
        errorCode,
      );
      descriptor = openSync(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      fsyncSync(descriptor);
      assertOwnedDirectoryAtPath(
        path,
        ownership.directories.get(relativePath),
        sourcePath,
        errorCode,
      );
    } catch (cause) {
      operationError = cause;
    }
    let closeError;
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (cause) {
        closeError = cause;
      }
    }
    if (operationError !== undefined || closeError !== undefined) {
      const cause = operationError !== undefined && closeError !== undefined
        ? new AggregateError([operationError, closeError])
        : operationError ?? closeError;
      fail(errorCode, sourcePath, cause);
    }
  }
}

function syncKnownDirectory(path, expected, sourcePath, errorCode) {
  let descriptor;
  let operationError;
  try {
    assertOwnedDirectoryAtPath(path, expected, sourcePath, errorCode);
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    fsyncSync(descriptor);
    assertOwnedDirectoryAtPath(path, expected, sourcePath, errorCode);
  } catch (cause) {
    operationError = cause;
  }
  let closeError;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (cause) {
      closeError = cause;
    }
  }
  if (operationError !== undefined || closeError !== undefined) {
    const cause = operationError !== undefined && closeError !== undefined
      ? new AggregateError([operationError, closeError])
      : operationError ?? closeError;
    fail(errorCode, sourcePath, cause);
  }
}

function syncCanonicalDirectory(path, sourcePath, errorCode) {
  let descriptor;
  let operationError;
  try {
    if (realpathSync(path) !== path) {
      throw new TypeError("directory is not canonical");
    }
    const pathBefore = lstatSync(path, {bigint: true});
    if (pathBefore.isSymbolicLink() || !pathBefore.isDirectory()) {
      throw new TypeError("directory is not ordinary");
    }
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const descriptorBefore = fstatSync(descriptor, {bigint: true});
    fsyncSync(descriptor);
    const descriptorAfter = fstatSync(descriptor, {bigint: true});
    const pathAfter = lstatSync(path, {bigint: true});
    const identities = [
      directoryIdentityFromMetadata(pathBefore),
      directoryIdentityFromMetadata(descriptorBefore),
      directoryIdentityFromMetadata(descriptorAfter),
      directoryIdentityFromMetadata(pathAfter),
    ];
    if (
      identities.some((identity) => (
        !sameDirectoryIdentity(identities[0], identity)
      ))
      || realpathSync(path) !== path
    ) {
      throw new TypeError("directory identity changed while syncing");
    }
  } catch (cause) {
    operationError = cause;
  }
  let closeError;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (cause) {
      closeError = cause;
    }
  }
  if (operationError !== undefined || closeError !== undefined) {
    const cause = operationError !== undefined && closeError !== undefined
      ? new AggregateError([operationError, closeError])
      : operationError ?? closeError;
    fail(errorCode, sourcePath, cause);
  }
}

function captureDirectoryOperation(
  path,
  expected,
  expectedMember,
  sourcePath,
  errorCode,
) {
  try {
    assertOwnedDirectoryAtPath(path, expected, sourcePath, errorCode);
    const before = lstatSync(path, {bigint: true});
    const members = readdirSync(path, {encoding: "buffer"});
    if (
      members.length !== 1
      || !Buffer.from(members[0]).equals(Buffer.from(expectedMember, "utf8"))
    ) {
      throw new TypeError("directory member set mismatch");
    }
    const after = lstatSync(path, {bigint: true});
    const beforeOperation = Object.freeze({
      identity: directoryIdentityFromMetadata(before),
      linkCount: before.nlink,
      size: before.size,
      modifiedAtNanoseconds: before.mtimeNs,
      changedAtNanoseconds: before.ctimeNs,
    });
    const afterOperation = Object.freeze({
      identity: directoryIdentityFromMetadata(after),
      linkCount: after.nlink,
      size: after.size,
      modifiedAtNanoseconds: after.mtimeNs,
      changedAtNanoseconds: after.ctimeNs,
    });
    if (!sameDirectoryOperation(beforeOperation, afterOperation)) {
      throw new TypeError("directory changed while captured");
    }
    return afterOperation;
  } catch (cause) {
    if (cause instanceof ReleasePackageError) throw cause;
    fail(errorCode, sourcePath, cause);
  }
}

function sameDirectoryOperation(left, right) {
  return (
    sameDirectoryIdentity(left.identity, right.identity)
    && left.linkCount === right.linkCount
    && left.size === right.size
    && left.modifiedAtNanoseconds === right.modifiedAtNanoseconds
    && left.changedAtNanoseconds === right.changedAtNanoseconds
  );
}

function prepareDistRoot(repositoryRoot) {
  const distRoot = resolve(repositoryRoot, DIST_ROOT_RELATIVE_PATH);
  assertDirectChild(
    distRoot,
    repositoryRoot,
    DIST_ROOT_RELATIVE_PATH,
    DIST_ROOT_RELATIVE_PATH,
  );
  let created = false;
  let identity;
  let initialIdentity;
  try {
    if (!pathExists(distRoot)) {
      mkdirSync(distRoot, {mode: 0o700});
      created = true;
      const initialMetadata = lstatSync(distRoot, {bigint: true});
      if (
        initialMetadata.isSymbolicLink()
        || !initialMetadata.isDirectory()
        || realpathSync(distRoot) !== distRoot
        || (
          typeof process.getuid === "function"
          && initialMetadata.uid !== BigInt(process.getuid())
        )
      ) {
        throw new TypeError("dist creation identity mismatch");
      }
      initialIdentity = directoryIdentityFromMetadata(initialMetadata);
    }
    identity = created
      ? secureOwnedDirectory(
          distRoot,
          DIST_ROOT_RELATIVE_PATH,
          "RELEASE_PACKAGE_DIST",
        )
      : directoryIdentity(
          distRoot,
          DIST_ROOT_RELATIVE_PATH,
          "RELEASE_PACKAGE_DIST",
        );
    if (readdirSync(distRoot).length !== 0) {
      throw new TypeError("dist root is not empty");
    }
  } catch (cause) {
    let cleanupError;
    if (created) {
      try {
        if (!pathExists(distRoot)) {
          fail(
            "RELEASE_PACKAGE_CLEANUP_UNCERTAIN",
            DIST_ROOT_RELATIVE_PATH,
          );
        }
        const currentMetadata = lstatSync(distRoot, {bigint: true});
        const currentIdentity = directoryIdentityFromMetadata(currentMetadata);
        if (
          initialIdentity === undefined
          || currentMetadata.isSymbolicLink()
          || !currentMetadata.isDirectory()
          || realpathSync(distRoot) !== distRoot
          || !sameDirectoryObject(initialIdentity, currentIdentity)
          || readdirSync(distRoot).length !== 0
        ) {
          fail(
            "RELEASE_PACKAGE_CLEANUP_UNCERTAIN",
            DIST_ROOT_RELATIVE_PATH,
          );
        }
        rmdirSync(distRoot);
        syncCanonicalDirectory(
          repositoryRoot,
          "repository",
          "RELEASE_PACKAGE_CLEANUP",
        );
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError !== undefined) {
      fail(
        cleanupError instanceof ReleasePackageError
          ? cleanupError.code
          : "RELEASE_PACKAGE_CLEANUP",
        DIST_ROOT_RELATIVE_PATH,
        new AggregateError([cause, cleanupError]),
      );
    }
    if (cause instanceof ReleasePackageError) throw cause;
    fail("RELEASE_PACKAGE_DIST", DIST_ROOT_RELATIVE_PATH, cause);
  }
  return Object.freeze({distRoot, created, identity});
}

function createCandidate(distState) {
  let path;
  let initialIdentity;
  try {
    path = mkdtempSync(resolve(distState.distRoot, RELEASE_CANDIDATE_PREFIX));
    if (
      dirname(path) !== distState.distRoot
      || !basename(path).startsWith(RELEASE_CANDIDATE_PREFIX)
    ) {
      throw new TypeError("candidate path mismatch");
    }
    const initialMetadata = lstatSync(path, {bigint: true});
    if (
      initialMetadata.isSymbolicLink()
      || !initialMetadata.isDirectory()
      || realpathSync(path) !== path
      || (
        typeof process.getuid === "function"
        && initialMetadata.uid !== BigInt(process.getuid())
      )
    ) {
      throw new TypeError("candidate creation identity mismatch");
    }
    initialIdentity = directoryIdentityFromMetadata(initialMetadata);
    return Object.freeze({
      path,
      identity: secureOwnedDirectory(
        path,
        RELEASE_ROOT_RELATIVE_PATH,
        "RELEASE_PACKAGE_WRITE",
      ),
    });
  } catch (cause) {
    let cleanupError;
    if (path !== undefined) {
      try {
        if (!pathExists(path)) {
          fail(
            "RELEASE_PACKAGE_CLEANUP_UNCERTAIN",
            RELEASE_ROOT_RELATIVE_PATH,
          );
        }
        const currentMetadata = lstatSync(path, {bigint: true});
        const currentIdentity = directoryIdentityFromMetadata(currentMetadata);
        if (
          initialIdentity === undefined
          || currentMetadata.isSymbolicLink()
          || !currentMetadata.isDirectory()
          || realpathSync(path) !== path
          || !sameDirectoryObject(initialIdentity, currentIdentity)
          || readdirSync(path).length !== 0
        ) {
          fail(
            "RELEASE_PACKAGE_CLEANUP_UNCERTAIN",
            RELEASE_ROOT_RELATIVE_PATH,
          );
        }
        rmdirSync(path);
        syncKnownDirectory(
          distState.distRoot,
          distState.identity,
          DIST_ROOT_RELATIVE_PATH,
          "RELEASE_PACKAGE_CLEANUP",
        );
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError !== undefined) {
      fail(
        cleanupError instanceof ReleasePackageError
          ? cleanupError.code
          : "RELEASE_PACKAGE_CLEANUP",
        RELEASE_ROOT_RELATIVE_PATH,
        new AggregateError([cause, cleanupError]),
      );
    }
    if (cause instanceof ReleasePackageError) throw cause;
    fail("RELEASE_PACKAGE_WRITE", RELEASE_ROOT_RELATIVE_PATH, cause);
  }
}

function removeCreatedDistRoot(distState) {
  if (!distState.created) return;
  if (!pathExists(distState.distRoot)) {
    fail("RELEASE_PACKAGE_CLEANUP_UNCERTAIN", DIST_ROOT_RELATIVE_PATH);
  }
  try {
    assertOwnedDirectoryAtPath(
      distState.distRoot,
      distState.identity,
      DIST_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_CLEANUP_UNCERTAIN",
    );
  } catch (cause) {
    if (cause instanceof ReleasePackageError) throw cause;
    fail(
      "RELEASE_PACKAGE_CLEANUP_UNCERTAIN",
      DIST_ROOT_RELATIVE_PATH,
      cause,
    );
  }
  try {
    if (readdirSync(distState.distRoot).length !== 0) {
      fail(
        "RELEASE_PACKAGE_CLEANUP_UNCERTAIN",
        DIST_ROOT_RELATIVE_PATH,
      );
    }
  } catch (cause) {
    if (cause instanceof ReleasePackageError) throw cause;
    fail(
      "RELEASE_PACKAGE_CLEANUP_UNCERTAIN",
      DIST_ROOT_RELATIVE_PATH,
      cause,
    );
  }
  try {
    rmdirSync(distState.distRoot);
    syncCanonicalDirectory(
      dirname(distState.distRoot),
      "repository",
      "RELEASE_PACKAGE_CLEANUP",
    );
  } catch (cause) {
    if (cause instanceof ReleasePackageError) throw cause;
    fail("RELEASE_PACKAGE_CLEANUP", DIST_ROOT_RELATIVE_PATH, cause);
  }
}

function createActivationReservation(
  releaseRoot,
  distState,
  afterCreated,
) {
  let created = false;
  let initialIdentity;
  try {
    mkdirSync(releaseRoot, {mode: 0o700});
    created = true;
    const initialMetadata = lstatSync(releaseRoot, {bigint: true});
    if (
      initialMetadata.isSymbolicLink()
      || !initialMetadata.isDirectory()
      || realpathSync(releaseRoot) !== releaseRoot
      || (
        typeof process.getuid === "function"
        && initialMetadata.uid !== BigInt(process.getuid())
      )
    ) {
      throw new TypeError("activation reservation identity mismatch");
    }
    initialIdentity = directoryIdentityFromMetadata(initialMetadata);
    afterCreated?.();
    const identity = secureOwnedDirectory(
      releaseRoot,
      RELEASE_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_ACTIVATE",
    );
    if (readdirSync(releaseRoot).length !== 0) {
      throw new TypeError("activation reservation is not empty");
    }
    syncKnownDirectory(
      distState.distRoot,
      distState.identity,
      DIST_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_ACTIVATE",
    );
    return Object.freeze({identity});
  } catch (cause) {
    let cleanupError;
    if (created) {
      try {
        if (!pathExists(releaseRoot)) {
          fail(
            "RELEASE_PACKAGE_CLEANUP_UNCERTAIN",
            RELEASE_ROOT_RELATIVE_PATH,
          );
        }
        const currentMetadata = lstatSync(releaseRoot, {bigint: true});
        const currentIdentity = directoryIdentityFromMetadata(currentMetadata);
        if (
          initialIdentity === undefined
          || currentMetadata.isSymbolicLink()
          || !currentMetadata.isDirectory()
          || realpathSync(releaseRoot) !== releaseRoot
          || !sameDirectoryObject(initialIdentity, currentIdentity)
          || readdirSync(releaseRoot).length !== 0
        ) {
          fail(
            "RELEASE_PACKAGE_CLEANUP_UNCERTAIN",
            RELEASE_ROOT_RELATIVE_PATH,
          );
        }
        rmdirSync(releaseRoot);
        syncKnownDirectory(
          distState.distRoot,
          distState.identity,
          DIST_ROOT_RELATIVE_PATH,
          "RELEASE_PACKAGE_CLEANUP",
        );
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError !== undefined) {
      fail(
        cleanupError instanceof ReleasePackageError
          ? cleanupError.code
          : "RELEASE_PACKAGE_CLEANUP",
        RELEASE_ROOT_RELATIVE_PATH,
        new AggregateError([cause, cleanupError]),
      );
    }
    if (cause instanceof ReleasePackageError) throw cause;
    fail("RELEASE_PACKAGE_ACTIVATE", RELEASE_ROOT_RELATIVE_PATH, cause);
  }
}

function removeActivationReservation(
  releaseRoot,
  reservation,
  distState,
) {
  if (reservation === undefined) return;
  try {
    if (!pathExists(releaseRoot)) {
      fail("RELEASE_PACKAGE_CLEANUP_UNCERTAIN", RELEASE_ROOT_RELATIVE_PATH);
    }
    assertOwnedDirectoryAtPath(
      releaseRoot,
      reservation.identity,
      RELEASE_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_CLEANUP_UNCERTAIN",
    );
    if (readdirSync(releaseRoot).length !== 0) {
      fail("RELEASE_PACKAGE_CLEANUP_UNCERTAIN", RELEASE_ROOT_RELATIVE_PATH);
    }
    rmdirSync(releaseRoot);
    syncKnownDirectory(
      distState.distRoot,
      distState.identity,
      DIST_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_CLEANUP",
    );
  } catch (cause) {
    if (cause instanceof ReleasePackageError) throw cause;
    fail("RELEASE_PACKAGE_CLEANUP", RELEASE_ROOT_RELATIVE_PATH, cause);
  }
}

function cleanupFailedOutput({
  distState,
  candidate,
  ownership,
  activated,
  activationReservation,
  releaseRoot,
}) {
  let cleanupError;
  try {
    const currentPath = activated ? releaseRoot : candidate.path;
    if (!pathExists(currentPath)) {
      fail("RELEASE_PACKAGE_CLEANUP_UNCERTAIN", RELEASE_ROOT_RELATIVE_PATH);
    }
    const current = directoryIdentity(
      currentPath,
      RELEASE_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_CLEANUP_UNCERTAIN",
    );
    if (!sameDirectoryIdentity(candidate.identity, current)) {
      fail("RELEASE_PACKAGE_CLEANUP_UNCERTAIN", RELEASE_ROOT_RELATIVE_PATH);
    }
    const failedPath = resolve(
      distState.distRoot,
      `${RELEASE_FAILED_PREFIX}${basename(candidate.path).slice(RELEASE_CANDIDATE_PREFIX.length)}`,
    );
    if (pathExists(failedPath)) {
      fail("RELEASE_PACKAGE_CLEANUP_UNCERTAIN", RELEASE_ROOT_RELATIVE_PATH);
    }
    renameSync(currentPath, failedPath);
    syncKnownDirectory(
      distState.distRoot,
      distState.identity,
      DIST_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_CLEANUP_UNCERTAIN",
    );
    assertCandidateOwnership(
      failedPath,
      ownership,
      "RELEASE_PACKAGE_CLEANUP_UNCERTAIN",
      RELEASE_ROOT_RELATIVE_PATH,
      true,
    );
    rmSync(failedPath, {recursive: true, force: false, maxRetries: 0});
    if (pathExists(failedPath)) {
      fail("RELEASE_PACKAGE_CLEANUP", RELEASE_ROOT_RELATIVE_PATH);
    }
    syncKnownDirectory(
      distState.distRoot,
      distState.identity,
      DIST_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_CLEANUP",
    );
    if (!activated) {
      removeActivationReservation(
        releaseRoot,
        activationReservation,
        distState,
      );
    }
    removeCreatedDistRoot(distState);
  } catch (cause) {
    cleanupError = cause;
  }
  if (cleanupError !== undefined) throw cleanupError;
}

export function packageSite(options) {
  const values = readDataProperties(
    options,
    ["repositoryRoot", "testHooks", "verifyProductionBuild"],
    ["repositoryRoot", "verifyProductionBuild"],
    UNKNOWN_SOURCE_PATH,
  );
  if (typeof values.verifyProductionBuild !== "function") {
    fail("RELEASE_PACKAGE_INPUT", BUILD_ROOT_RELATIVE_PATH);
  }
  const hooks = normalizeHooks(
    values.testHooks,
    [
      "afterInitialBuildCapture",
      "afterDistPrepared",
      "afterCandidateCreated",
      "afterTargetCopiedBeforeSync",
      "afterFileCopied",
      "afterPayloadCopy",
      "afterArtifactsWritten",
      "beforeActivation",
      "afterActivationReservationCreated",
      "afterActivationReservation",
      "afterActivation",
    ],
    RELEASE_ROOT_RELATIVE_PATH,
  );
  assertCanonicalRepositoryRoot(values.repositoryRoot);
  const buildRoot = resolve(values.repositoryRoot, BUILD_ROOT_RELATIVE_PATH);
  assertDirectChild(
    buildRoot,
    values.repositoryRoot,
    BUILD_ROOT_RELATIVE_PATH,
    BUILD_ROOT_RELATIVE_PATH,
  );
  assertCanonicalDirectory(buildRoot, BUILD_ROOT_RELATIVE_PATH);
  const initialRepositoryState = captureReleaseRepositoryState({
    repositoryRoot: values.repositoryRoot,
  });
  const initialBuild = captureTree(
    buildRoot,
    BUILD_ROOT_RELATIVE_PATH,
    "RELEASE_PACKAGE_BUILD",
  );
  assertProductionBuildShape(initialBuild);
  const initialRegistry = captureRegistry(values.repositoryRoot);
  runProductionBuildVerification(
    values.verifyProductionBuild,
    values.repositoryRoot,
    initialBuild,
    initialRegistry,
  );
  hooks.afterInitialBuildCapture?.();

  let distState;
  let candidate;
  let releaseRoot;
  let ownership;
  let activated = false;
  let activationReservation;
  try {
    distState = prepareDistRoot(values.repositoryRoot);
    if (distState.created) {
      syncCanonicalDirectory(
        values.repositoryRoot,
        "repository",
        "RELEASE_PACKAGE_WRITE",
      );
    }
    hooks.afterDistPrepared?.();
    candidate = createCandidate(distState);
    releaseRoot = resolve(distState.distRoot, "release");
    assertDirectChild(
      releaseRoot,
      distState.distRoot,
      "release",
      RELEASE_ROOT_RELATIVE_PATH,
    );
    ownership = createCandidateOwnership(candidate);
    syncKnownDirectory(
      distState.distRoot,
      distState.identity,
      DIST_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_WRITE",
    );
    const distCandidateOperation = captureDirectoryOperation(
      distState.distRoot,
      distState.identity,
      basename(candidate.path),
      DIST_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_CHANGED",
    );
    hooks.afterCandidateCreated?.();
    const payloadRoot = resolve(candidate.path, RELEASE_PAYLOAD_ROOT);
    const metadataRoot = resolve(candidate.path, "metadata");
    ensurePrivateDirectory(
      payloadRoot,
      candidate.path,
      RELEASE_PAYLOAD_ROOT,
      RELEASE_PAYLOAD_ROOT,
      ownership,
      RELEASE_PAYLOAD_ROOT,
    );
    ensurePrivateDirectory(
      metadataRoot,
      candidate.path,
      "metadata",
      "metadata",
      ownership,
      "metadata",
    );
    const nginxRoot = resolve(metadataRoot, "nginx");
    ensurePrivateDirectory(
      nginxRoot,
      metadataRoot,
      "nginx",
      "metadata/nginx",
      ownership,
      "metadata/nginx",
    );

    copyPayload(
      buildRoot,
      payloadRoot,
      initialBuild,
      hooks,
      ownership,
    );
    hooks.afterPayloadCopy?.();
    assertCandidateOwnership(
      candidate.path,
      ownership,
      "RELEASE_PACKAGE_COPY",
    );
    const buildAfterCopy = captureTree(
      buildRoot,
      BUILD_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_COPY",
    );
    const payloadCapture = captureTree(
      payloadRoot,
      RELEASE_PAYLOAD_ROOT,
      "RELEASE_PACKAGE_COPY",
    );
    if (
      !fileTreeOperationallyEqual(initialBuild, buildAfterCopy)
      || !fileTreeContentsEqual(initialBuild, payloadCapture)
    ) {
      fail("RELEASE_PACKAGE_COPY", RELEASE_PAYLOAD_ROOT);
    }

    const redirects = deriveRedirects(buildRoot, initialRegistry);
    const runtimeBytes = Buffer.from(redirects.runtimeRedirectsJson, "utf8");
    const nginxBytes = Buffer.from(redirects.nginxRedirectsConfig, "utf8");
    recordOwnedFile(
      ownership,
      RELEASE_RUNTIME_REDIRECTS_PATH,
      writeCanonicalFile(
      resolve(candidate.path, RELEASE_RUNTIME_REDIRECTS_PATH),
      runtimeBytes,
      RELEASE_RUNTIME_REDIRECTS_PATH,
      ),
      RELEASE_RUNTIME_REDIRECTS_PATH,
    );
    recordOwnedFile(
      ownership,
      RELEASE_NGINX_REDIRECTS_PATH,
      writeCanonicalFile(
      resolve(candidate.path, RELEASE_NGINX_REDIRECTS_PATH),
      nginxBytes,
      RELEASE_NGINX_REDIRECTS_PATH,
      ),
      RELEASE_NGINX_REDIRECTS_PATH,
    );
    const filesManifest = renderFilesManifest(
      createManifestEntries(payloadCapture, redirects),
    );
    recordOwnedFile(
      ownership,
      RELEASE_FILES_PATH,
      writeCanonicalFile(
      resolve(candidate.path, RELEASE_FILES_PATH),
      filesManifest.bytes,
      RELEASE_FILES_PATH,
      ),
      RELEASE_FILES_PATH,
    );
    const metadata = expectedMetadata({
      commitSha: initialRepositoryState.commitSha,
      buildCapture: initialBuild,
      registrySnapshot: initialRegistry,
      redirects,
      filesManifest,
    });
    recordOwnedFile(
      ownership,
      RELEASE_JSON_PATH,
      writeCanonicalFile(
      resolve(candidate.path, RELEASE_JSON_PATH),
      renderReleaseMetadata(metadata),
      RELEASE_JSON_PATH,
      ),
      RELEASE_JSON_PATH,
    );
    hooks.afterArtifactsWritten?.();
    assertCandidateOwnership(
      candidate.path,
      ownership,
      "RELEASE_PACKAGE_CHANGED",
    );
    syncOwnedDirectories(
      candidate.path,
      ownership,
      "RELEASE_PACKAGE_WRITE",
    );

    const verified = verifyReleaseAt({
      repositoryRoot: values.repositoryRoot,
      releaseRoot: candidate.path,
      commitSha: initialRepositoryState.commitSha,
      sourcePath: RELEASE_ROOT_RELATIVE_PATH,
    });
    if (
      !fileTreeOperationallyEqual(initialBuild, verified.buildCapture)
      || !registrySnapshotsEqual(initialRegistry, verified.registrySnapshot)
      || !sameDirectoryIdentity(
        candidate.identity,
        verified.releaseCapture.rootIdentity,
      )
    ) {
      fail("RELEASE_PACKAGE_CHANGED", RELEASE_ROOT_RELATIVE_PATH);
    }
    hooks.beforeActivation?.();
    const buildBeforeActivation = captureTree(
      buildRoot,
      BUILD_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_CHANGED",
    );
    const registryBeforeActivation = captureRegistry(values.repositoryRoot);
    const candidateBeforeActivation = captureTree(
      candidate.path,
      RELEASE_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_CHANGED",
    );
    if (
      !fileTreeOperationallyEqual(initialBuild, buildBeforeActivation)
      || !registrySnapshotsEqual(initialRegistry, registryBeforeActivation)
      || !sameDirectoryIdentity(
        candidate.identity,
        candidateBeforeActivation.rootIdentity,
      )
      || !fileTreeOperationallyEqual(
        verified.releaseCapture,
        candidateBeforeActivation,
      )
      || pathExists(releaseRoot)
    ) {
      fail("RELEASE_PACKAGE_CHANGED", RELEASE_ROOT_RELATIVE_PATH);
    }
    assertCandidateOwnership(
      candidate.path,
      ownership,
      "RELEASE_PACKAGE_CHANGED",
    );
    syncOwnedDirectories(
      candidate.path,
      ownership,
      "RELEASE_PACKAGE_WRITE",
    );
    const distBeforeActivation = captureDirectoryOperation(
      distState.distRoot,
      distState.identity,
      basename(candidate.path),
      DIST_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_CHANGED",
    );
    if (!sameDirectoryOperation(distCandidateOperation, distBeforeActivation)) {
      fail("RELEASE_PACKAGE_CHANGED", DIST_ROOT_RELATIVE_PATH);
    }
    activationReservation = createActivationReservation(
      releaseRoot,
      distState,
      hooks.afterActivationReservationCreated,
    );
    hooks.afterActivationReservation?.();
    assertOwnedDirectoryAtPath(
      releaseRoot,
      activationReservation.identity,
      RELEASE_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_ACTIVATE",
    );
    if (readdirSync(releaseRoot).length !== 0) {
      fail("RELEASE_PACKAGE_ACTIVATE", RELEASE_ROOT_RELATIVE_PATH);
    }

    try {
      renameSync(candidate.path, releaseRoot);
      activated = true;
    } catch (cause) {
      fail("RELEASE_PACKAGE_ACTIVATE", RELEASE_ROOT_RELATIVE_PATH, cause);
    }
    syncKnownDirectory(
      distState.distRoot,
      distState.identity,
      DIST_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_ACTIVATE",
    );
    const distActivatedOperation = captureDirectoryOperation(
      distState.distRoot,
      distState.identity,
      "release",
      DIST_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_ACTIVATE",
    );
    const activatedBaseline = captureTree(
      releaseRoot,
      RELEASE_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_ACTIVATE",
    );
    if (
      !fileTreeRootIdentityEqual(
        candidateBeforeActivation,
        activatedBaseline,
      )
      || !sameDirectoryIdentity(
        candidate.identity,
        activatedBaseline.rootIdentity,
      )
      || !fileTreeContentsEqual(
        candidateBeforeActivation,
        activatedBaseline,
      )
    ) {
      fail("RELEASE_PACKAGE_ACTIVATE", RELEASE_ROOT_RELATIVE_PATH);
    }
    hooks.afterActivation?.();
    const activeCapture = captureTree(
      releaseRoot,
      RELEASE_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_ACTIVATE",
    );
    if (!fileTreeOperationallyEqual(activatedBaseline, activeCapture)) {
      fail("RELEASE_PACKAGE_ACTIVATE", RELEASE_ROOT_RELATIVE_PATH);
    }
    assertCandidateOwnership(
      releaseRoot,
      ownership,
      "RELEASE_PACKAGE_ACTIVATE",
    );
    const distFinalOperation = captureDirectoryOperation(
      distState.distRoot,
      distState.identity,
      "release",
      DIST_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_ACTIVATE",
    );
    if (!sameDirectoryOperation(distActivatedOperation, distFinalOperation)) {
      fail("RELEASE_PACKAGE_ACTIVATE", DIST_ROOT_RELATIVE_PATH);
    }
    const finalBuildCapture = captureTree(
      buildRoot,
      BUILD_ROOT_RELATIVE_PATH,
      "RELEASE_PACKAGE_CHANGED",
    );
    const finalRegistrySnapshot = captureRegistry(values.repositoryRoot);
    if (
      !fileTreeOperationallyEqual(initialBuild, finalBuildCapture)
      || !registrySnapshotsEqual(initialRegistry, finalRegistrySnapshot)
    ) {
      fail("RELEASE_PACKAGE_CHANGED", RELEASE_ROOT_RELATIVE_PATH);
    }
    const finalRepositoryState = captureReleaseRepositoryState({
      repositoryRoot: values.repositoryRoot,
    });
    assertRepositoryStateUnchanged(
      initialRepositoryState,
      finalRepositoryState,
    );
    return Object.freeze({
      commitSha: initialRepositoryState.commitSha,
      sourceBuildTreeSha256: initialBuild.treeSha256,
      releaseFileCount: activeCapture.fileCount,
    });
  } catch (operationError) {
    let cleanupError;
    try {
      if (
        distState !== undefined
        && candidate !== undefined
        && ownership !== undefined
        && releaseRoot !== undefined
      ) {
        cleanupFailedOutput({
          distState,
          candidate,
          ownership,
          activated,
          activationReservation,
          releaseRoot,
        });
      } else if (distState !== undefined) {
        removeCreatedDistRoot(distState);
      }
    } catch (cause) {
      cleanupError = cause;
    }
    if (cleanupError !== undefined) {
      fail(
        cleanupError instanceof ReleasePackageError
          ? cleanupError.code
          : "RELEASE_PACKAGE_CLEANUP",
        RELEASE_ROOT_RELATIVE_PATH,
        new AggregateError([operationError, cleanupError]),
      );
    }
    if (operationError instanceof ReleasePackageError) throw operationError;
    fail("RELEASE_PACKAGE_WRITE", RELEASE_ROOT_RELATIVE_PATH, operationError);
  }
}

export function checkReleasePackage(options) {
  const values = readDataProperties(
    options,
    ["repositoryRoot", "testHooks", "verifyProductionBuild"],
    ["repositoryRoot", "verifyProductionBuild"],
    UNKNOWN_SOURCE_PATH,
  );
  if (typeof values.verifyProductionBuild !== "function") {
    fail("RELEASE_PACKAGE_INPUT", BUILD_ROOT_RELATIVE_PATH);
  }
  const hooks = normalizeHooks(
    values.testHooks,
    ["afterValidation"],
    RELEASE_ROOT_RELATIVE_PATH,
  );
  assertCanonicalRepositoryRoot(values.repositoryRoot);
  const distRoot = resolve(values.repositoryRoot, DIST_ROOT_RELATIVE_PATH);
  const releaseRoot = resolve(values.repositoryRoot, RELEASE_ROOT_RELATIVE_PATH);
  assertDirectChild(
    distRoot,
    values.repositoryRoot,
    DIST_ROOT_RELATIVE_PATH,
    DIST_ROOT_RELATIVE_PATH,
  );
  assertCanonicalDirectory(distRoot, DIST_ROOT_RELATIVE_PATH);
  assertDirectChild(
    releaseRoot,
    distRoot,
    "release",
    RELEASE_ROOT_RELATIVE_PATH,
  );
  const distIdentity = directoryIdentity(
    distRoot,
    DIST_ROOT_RELATIVE_PATH,
    "RELEASE_PACKAGE_DIST",
  );
  const initialDistOperation = captureDirectoryOperation(
    distRoot,
    distIdentity,
    "release",
    DIST_ROOT_RELATIVE_PATH,
    "RELEASE_PACKAGE_DIST",
  );
  const initialRepositoryState = captureReleaseRepositoryState({
    repositoryRoot: values.repositoryRoot,
  });
  const initialBuildCapture = captureTree(
    resolve(values.repositoryRoot, BUILD_ROOT_RELATIVE_PATH),
    BUILD_ROOT_RELATIVE_PATH,
    "RELEASE_PACKAGE_BUILD",
  );
  assertProductionBuildShape(initialBuildCapture);
  const initialRegistrySnapshot = captureRegistry(values.repositoryRoot);
  runProductionBuildVerification(
    values.verifyProductionBuild,
    values.repositoryRoot,
    initialBuildCapture,
    initialRegistrySnapshot,
  );
  const verified = verifyReleaseAt({
    repositoryRoot: values.repositoryRoot,
    releaseRoot,
    commitSha: initialRepositoryState.commitSha,
    sourcePath: RELEASE_ROOT_RELATIVE_PATH,
  });
  if (
    !fileTreeOperationallyEqual(
      initialBuildCapture,
      verified.buildCapture,
    )
    || !registrySnapshotsEqual(
      initialRegistrySnapshot,
      verified.registrySnapshot,
    )
  ) {
    fail("RELEASE_PACKAGE_CHANGED", RELEASE_ROOT_RELATIVE_PATH);
  }
  hooks.afterValidation?.();
  const finalBuildCapture = captureTree(
    resolve(values.repositoryRoot, BUILD_ROOT_RELATIVE_PATH),
    BUILD_ROOT_RELATIVE_PATH,
    "RELEASE_PACKAGE_CHANGED",
  );
  const finalRegistrySnapshot = captureRegistry(values.repositoryRoot);
  const finalReleaseCapture = captureTree(
    releaseRoot,
    RELEASE_ROOT_RELATIVE_PATH,
    "RELEASE_PACKAGE_CHANGED",
  );
  const finalDistOperation = captureDirectoryOperation(
    distRoot,
    distIdentity,
    "release",
    DIST_ROOT_RELATIVE_PATH,
    "RELEASE_PACKAGE_CHANGED",
  );
  if (
    !fileTreeOperationallyEqual(
      verified.buildCapture,
      finalBuildCapture,
    )
    || !registrySnapshotsEqual(
      verified.registrySnapshot,
      finalRegistrySnapshot,
    )
    || !fileTreeOperationallyEqual(
      verified.releaseCapture,
      finalReleaseCapture,
    )
    || !sameDirectoryOperation(
      initialDistOperation,
      finalDistOperation,
    )
  ) {
    fail("RELEASE_PACKAGE_CHANGED", RELEASE_ROOT_RELATIVE_PATH);
  }
  const finalRepositoryState = captureReleaseRepositoryState({
    repositoryRoot: values.repositoryRoot,
  });
  assertRepositoryStateUnchanged(
    initialRepositoryState,
    finalRepositoryState,
  );
  return Object.freeze({
    commitSha: initialRepositoryState.commitSha,
    releaseContentSha256: finalReleaseCapture.treeSha256,
    releaseFileCount: finalReleaseCapture.fileCount,
    sourceBuildTreeSha256: verified.buildCapture.treeSha256,
  });
}

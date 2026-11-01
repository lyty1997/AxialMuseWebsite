import {createHash, randomBytes} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {basename, dirname, isAbsolute, relative, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {projectRoot} from "../quality/lib/files.mjs";
import {
  readAndValidateManifest,
  readRegularProjectFile,
  validateRuntimeContract,
} from "../quality/lib/supply-chain/config.mjs";
import {deriveNpmCli} from "../quality/lib/supply-chain/environment.mjs";
import {
  readAndValidateLockfileSource,
} from "../quality/lib/supply-chain/lockfile.mjs";

const ROOT = projectRoot();
const EVIDENCE_FILE = ".axial-muse-preview-dependencies.json";

export class PreviewDependencyError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "PreviewDependencyError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new PreviewDependencyError(code, message, options);
}

export function formatPreviewDependencyError(error) {
  return error instanceof PreviewDependencyError
    ? `[${error.code}] ${error.message}`
    : "[PREVIEW_DEPENDENCY_INTERNAL] 冻结依赖证明失败；详细路径与环境信息已抑制。";
}

export function parsePreviewDependencyArguments(arguments_) {
  if (
    !Array.isArray(arguments_)
    || arguments_.length !== 1
    || (arguments_[0] !== "prepare" && arguments_[0] !== "verify")
  ) {
    fail("PREVIEW_DEPENDENCY_ARGUMENTS", "只接受 prepare 或 verify 子命令。");
  }
  return Object.freeze({command: arguments_[0]});
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashFrame(hash, type, path, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  hash.update(`${type}:${Buffer.byteLength(path, "utf8")}:${path}:${bytes.byteLength}:`, "utf8");
  hash.update(bytes);
  hash.update("\n", "utf8");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function canonicalJsonBytes(value) {
  return `${JSON.stringify(canonicalJson(value), null, 2)}\n`;
}

function assertCanonicalRoot(root) {
  try {
    const metadata = lstatSync(root);
    if (
      !isAbsolute(root)
      || resolve(root) !== root
      || metadata.isSymbolicLink()
      || !metadata.isDirectory()
      || realpathSync(root) !== root
    ) throw new TypeError("invalid repository root");
  } catch (error) {
    fail("PREVIEW_DEPENDENCY_ROOT", "仓库根不是规范普通目录。", {cause: error});
  }
}

function assertPrivateInstalledEntry(path, expectedType, nodeModulesRoot) {
  try {
    const metadata = lstatSync(path);
    const typeMatches = expectedType === "directory"
      ? metadata.isDirectory()
      : metadata.isFile();
    const canonical = realpathSync(path);
    const relation = relative(nodeModulesRoot, canonical);
    if (
      metadata.isSymbolicLink()
      || !typeMatches
      || (metadata.mode & 0o022) !== 0
      || (expectedType === "file" && metadata.nlink !== 1)
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || relation === ""
      || relation === ".."
      || relation.startsWith("../")
      || relation.startsWith("..\\")
      || isAbsolute(relation)
    ) throw new TypeError("installed entry identity mismatch");
  } catch (error) {
    fail("PREVIEW_DEPENDENCY_TREE", "本地冻结依赖树含缺失、链接或可被其他主体写入的成员。", {
      cause: error,
    });
  }
}

function readStableInstalledFile(path, nodeModulesRoot) {
  assertPrivateInstalledEntry(path, "file", nodeModulesRoot);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.mode !== after.mode
      || before.size !== after.size
      || bytes.byteLength !== before.size
    ) throw new TypeError("installed evidence changed while read");
    return bytes;
  } catch (error) {
    fail("PREVIEW_DEPENDENCY_READ", "本地冻结依赖证据无法稳定读取。", {cause: error});
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sameEntryIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertFrozenTreeEntry(metadata, expectedType) {
  const typeMatches = expectedType === "directory"
    ? metadata.isDirectory()
    : metadata.isFile();
  if (
    metadata.isSymbolicLink()
    || !typeMatches
    || (metadata.mode & 0o022n) !== 0n
    || (expectedType === "file" && metadata.nlink !== 1n)
    || (
      typeof process.getuid === "function"
      && metadata.uid !== BigInt(process.getuid())
    )
  ) {
    throw new TypeError("frozen tree entry identity mismatch");
  }
}

export function captureFrozenInstalledTreeEvidence(nodeModulesRoot) {
  const hash = createHash("sha256");
  let entryCount = 0;
  const visit = (directory, relativeDirectory) => {
    const directoryBefore = lstatSync(directory, {bigint: true});
    assertFrozenTreeEntry(directoryBefore, "directory");
    const names = readdirSync(directory).sort();
    for (const name of names) {
      const relativePath = relativeDirectory === ""
        ? name
        : `${relativeDirectory}/${name}`;
      if (relativePath === EVIDENCE_FILE) continue;
      const path = resolve(directory, name);
      if (dirname(path) !== directory) {
        throw new TypeError("frozen tree lexical path escaped");
      }
      const before = lstatSync(path, {bigint: true});
      if (before.isDirectory() && !before.isSymbolicLink()) {
        assertFrozenTreeEntry(before, "directory");
        hashFrame(hash, "directory", relativePath, before.mode & 0o777n);
        entryCount += 1;
        visit(path, relativePath);
      } else if (before.isFile() && !before.isSymbolicLink()) {
        assertFrozenTreeEntry(before, "file");
        const bytes = readStableInstalledFile(path, nodeModulesRoot);
        const after = lstatSync(path, {bigint: true});
        assertFrozenTreeEntry(after, "file");
        if (!sameEntryIdentity(before, after)) {
          throw new TypeError("frozen file drifted while hashed");
        }
        hashFrame(
          hash,
          "file",
          relativePath,
          `${before.mode & 0o777n}:${bytes.byteLength}:${sha256(bytes)}`,
        );
        entryCount += 1;
      } else if (before.isSymbolicLink()) {
        const segments = relativePath.split("/");
        const target = readlinkSync(path);
        const canonical = realpathSync(path);
        const relation = relative(nodeModulesRoot, canonical);
        const after = lstatSync(path, {bigint: true});
        if (
          segments.at(-2) !== ".bin"
          || typeof process.getuid === "function"
            && before.uid !== BigInt(process.getuid())
          || isAbsolute(target)
          || relation === ""
          || relation === ".."
          || relation.startsWith("../")
          || relation.startsWith("..\\")
          || isAbsolute(relation)
          || !sameEntryIdentity(before, after)
          || readlinkSync(path) !== target
        ) {
          throw new TypeError("frozen executable link identity mismatch");
        }
        hashFrame(hash, "symlink", relativePath, target);
        entryCount += 1;
      } else {
        throw new TypeError("frozen tree contains a special entry");
      }
    }
    const directoryAfter = lstatSync(directory, {bigint: true});
    assertFrozenTreeEntry(directoryAfter, "directory");
    if (!sameEntryIdentity(directoryBefore, directoryAfter)) {
      throw new TypeError("frozen directory drifted while hashed");
    }
  };
  try {
    visit(nodeModulesRoot, "");
  } catch (error) {
    fail("PREVIEW_DEPENDENCY_TREE", "本地冻结依赖树无法形成逐字节稳定证据。", {
      cause: error,
    });
  }
  return Object.freeze({
    treeEntryCount: entryCount,
    treeSha256: hash.digest("hex"),
  });
}

function packageNameFromPath(packagePath) {
  const segments = packagePath.split("/");
  const last = segments.at(-1);
  const parent = segments.at(-2);
  return parent?.startsWith("@") ? `${parent}/${last}` : last;
}

function parseJsonObject(bytes, code) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(code, "冻结依赖证据不是合法 JSON。", {cause: error});
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, "冻结依赖证据顶层必须是 object。");
  }
  return value;
}

function assertInstalledGraph(root, lockfile) {
  const nodeModulesInput = resolve(root, "node_modules");
  let nodeModulesRoot;
  try {
    const metadata = lstatSync(nodeModulesInput);
    if (
      metadata.isSymbolicLink()
      || !metadata.isDirectory()
      || (metadata.mode & 0o022) !== 0
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) throw new TypeError("node_modules identity mismatch");
    nodeModulesRoot = realpathSync(nodeModulesInput);
    if (nodeModulesRoot !== nodeModulesInput) throw new TypeError("node_modules alias");
  } catch (error) {
    fail("PREVIEW_DEPENDENCY_TREE", "node_modules 不是当前用户的规范冻结依赖目录。", {
      cause: error,
    });
  }
  const hiddenLockPath = resolve(nodeModulesRoot, ".package-lock.json");
  const hiddenLockBytes = readStableInstalledFile(hiddenLockPath, nodeModulesRoot);
  const hiddenLock = parseJsonObject(hiddenLockBytes, "PREVIEW_DEPENDENCY_HIDDEN_LOCK");
  if (
    hiddenLock.lockfileVersion !== 3
    || hiddenLock.packages === null
    || typeof hiddenLock.packages !== "object"
    || Array.isArray(hiddenLock.packages)
  ) {
    fail("PREVIEW_DEPENDENCY_HIDDEN_LOCK", "npm 隐藏 lock 没有形成 lockfileVersion=3 的安装证据。");
  }
  const installedPaths = Object.keys(hiddenLock.packages).sort();
  const lockedPaths = new Set(Object.keys(lockfile.packages).filter((path) => path !== ""));
  if (
    installedPaths.length === 0
    || installedPaths.some((path) => !lockedPaths.has(path))
  ) {
    fail("PREVIEW_DEPENDENCY_HIDDEN_LOCK", "npm 隐藏 lock 含空集合或根 lock 未登记成员。");
  }
  for (const packagePath of installedPaths) {
    const hiddenEntry = hiddenLock.packages[packagePath];
    const lockedEntry = lockfile.packages[packagePath];
    if (
      hiddenEntry === null
      || typeof hiddenEntry !== "object"
      || Array.isArray(hiddenEntry)
      || lockedEntry === null
      || typeof lockedEntry !== "object"
      || Array.isArray(lockedEntry)
      || hiddenEntry.version !== lockedEntry.version
    ) {
      fail("PREVIEW_DEPENDENCY_HIDDEN_LOCK", "npm 隐藏 lock 与根 lock 的包版本不一致。");
    }
    const packageRoot = resolve(root, packagePath);
    assertPrivateInstalledEntry(packageRoot, "directory", nodeModulesRoot);
    const packageBytes = readStableInstalledFile(
      resolve(packageRoot, "package.json"),
      nodeModulesRoot,
    );
    const packageMetadata = parseJsonObject(
      packageBytes,
      "PREVIEW_DEPENDENCY_PACKAGE_METADATA",
    );
    const expectedName = lockedEntry.name ?? packageNameFromPath(packagePath);
    if (
      packageMetadata.name !== expectedName
      || packageMetadata.version !== lockedEntry.version
    ) {
      fail("PREVIEW_DEPENDENCY_PACKAGE_METADATA", "已安装包身份与根 lock 不一致。");
    }
  }
  return Object.freeze({
    hiddenLockSha256: sha256(hiddenLockBytes),
    nodeModulesRoot,
    packageCount: installedPaths.length,
  });
}

export function createPreviewDependencyEvidence({
  root = ROOT,
  nodeExecutable = process.execPath,
  nodeVersion = process.versions.node,
  deriveNpm = deriveNpmCli,
} = {}) {
  assertCanonicalRoot(root);
  const manifestText = readRegularProjectFile(root, "package.json", "NPM_MANIFEST_FILE");
  const manifest = readAndValidateManifest(root);
  const {lockfile, text: lockfileText} = readAndValidateLockfileSource(root, manifest);
  const npmRuntime = deriveNpm(nodeExecutable);
  const runtime = validateRuntimeContract({
    root,
    nodeVersion,
    npmVersion: npmRuntime.npmVersion,
    manifest,
  });
  if (runtime.role !== "primary" || nodeVersion !== process.versions.node) {
    fail("PREVIEW_DEPENDENCY_RUNTIME", "preview 冻结依赖只接受 checkout .nvmrc 的主 Node/npm 端点。");
  }
  const installed = assertInstalledGraph(root, lockfile);
  const docusaurusPath = resolve(
    installed.nodeModulesRoot,
    "@docusaurus/core/bin/docusaurus.mjs",
  );
  assertPrivateInstalledEntry(docusaurusPath, "file", installed.nodeModulesRoot);
  const frozenTree = captureFrozenInstalledTreeEvidence(installed.nodeModulesRoot);
  return Object.freeze({
    kind: "axial_muse_preview_dependency_evidence",
    version: 2,
    nodeVersion: runtime.nodeVersion,
    npmVersion: runtime.npmVersion,
    manifestSha256: sha256(Buffer.from(manifestText, "utf8")),
    lockfileSha256: sha256(Buffer.from(lockfileText, "utf8")),
    hiddenLockSha256: installed.hiddenLockSha256,
    packageCount: installed.packageCount,
    treeEntryCount: frozenTree.treeEntryCount,
    treeSha256: frozenTree.treeSha256,
  });
}

function evidencePath(root) {
  return resolve(root, "node_modules", EVIDENCE_FILE);
}

function writeEvidence(root, evidence) {
  const target = evidencePath(root);
  const temporary = resolve(
    dirname(target),
    `.${EVIDENCE_FILE}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let descriptor;
  let renamed = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, canonicalJsonBytes(evidence), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    renamed = true;
  } catch (error) {
    fail("PREVIEW_DEPENDENCY_EVIDENCE_WRITE", "preview 冻结依赖证据无法原子写入。", {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!renamed) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          // 原始写入错误优先，临时文件仍位于私有 node_modules。
        }
      }
    }
  }
}

function verifyEvidence(root, expected) {
  const path = evidencePath(root);
  const nodeModulesRoot = realpathSync(resolve(root, "node_modules"));
  const actualBytes = readStableInstalledFile(path, nodeModulesRoot);
  if (actualBytes.toString("utf8") !== canonicalJsonBytes(expected)) {
    fail("PREVIEW_DEPENDENCY_EVIDENCE_MISMATCH", "冻结依赖证据与当前 manifest、lock、Node/npm 或安装树不匹配。");
  }
}

export function runPreviewDependencyCommand({
  root = ROOT,
  command,
} = {}) {
  const evidence = createPreviewDependencyEvidence({root});
  if (command === "prepare") {
    writeEvidence(root, evidence);
  } else if (command === "verify") {
    verifyEvidence(root, evidence);
  } else {
    fail("PREVIEW_DEPENDENCY_ARGUMENTS", "只接受 prepare 或 verify 子命令。");
  }
  return evidence;
}

function runCli() {
  try {
    const {command} = parsePreviewDependencyArguments(process.argv.slice(2));
    const evidence = runPreviewDependencyCommand({command});
    process.stdout.write(
      `preview frozen dependencies ${command === "prepare" ? "prepared" : "verified"}: ${evidence.packageCount} packages\n`,
    );
  } catch (error) {
    console.error(formatPreviewDependencyError(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}

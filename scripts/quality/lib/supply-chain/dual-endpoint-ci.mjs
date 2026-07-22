import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request as requestHttps } from "node:https";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { rootCertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { NPM_VERSIONS_BY_ROLE } from "./contracts.mjs";
import { deriveNpmCli } from "./environment.mjs";
import { fail, NpmIsolationError } from "./errors.mjs";
import { canonicalJsonBytes } from "./spdx.mjs";

export const DUAL_ENDPOINT_CI_INPUT_PATHS = Object.freeze([
  ".npmrc",
  ".nvmrc",
  "package-lock.json",
  "package.json",
]);

export const DUAL_ENDPOINT_CI_RUNTIME = Object.freeze({
  primary: Object.freeze({
    nodeVersion: "24.18.0",
    npmVersion: NPM_VERSIONS_BY_ROLE.primary,
  }),
  minimum: Object.freeze({
    nodeVersion: "24.16.0",
    npmVersion: NPM_VERSIONS_BY_ROLE.minimum,
  }),
});

export const MINIMUM_NODE_DISTRIBUTION = Object.freeze({
  archiveFileName: "node-v24.16.0-linux-x64.tar.xz",
  expectedTopDirectory: "node-v24.16.0-linux-x64",
  maxBytes: 64 * 1024 * 1024,
  sha256: "d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9",
  url: "https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-x64.tar.xz",
});

export const DUAL_ENDPOINT_CI_RECEIPT_ENVELOPE = Object.freeze({
  version: "0.1.0",
  kind: "axial_muse_dual_endpoint_ci_receipt",
  status: "passed",
  owner: "AxialMuseWebsite",
});

const SYSTEM_TAR = "/usr/bin/tar";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_TREE_ENTRIES = 250_000;
const MAX_RUNTIME_TREE_DEPTH = 128;
const MAX_WORKER_OUTPUT_BYTES = 1024 * 1024;
const HEX_64 = /^[0-9a-f]{64}$/;
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const RESPONSE_HEADER_VALUE = /^[\x20-\x7e]+$/;
const WORKER_PATH = fileURLToPath(new URL("../../run-dual-endpoint-ci-worker.mjs", import.meta.url));
const MINIMUM_RUNTIME_ATTESTATIONS = new WeakMap();

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, code, label) {
  if (!isPlainObject(value)) fail(code, `${label} 必须是 object。`);
  const actual = Object.keys(value).sort(compareBytes);
  const wanted = [...expected].sort(compareBytes);
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    fail(code, `${label} 字段集合不受支持。`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function pathExists(path, code) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail(code, "受控路径状态不可读。");
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function ownerIsCurrent(stat) {
  return typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid());
}

function statIdentity(stat, { includeContentState = false } = {}) {
  const identity = {
    dev: stat.dev,
    ino: stat.ino,
    modeType: stat.mode & 0o170000n,
    mode: stat.mode & 0o777n,
    nlink: stat.nlink,
    uid: stat.uid,
  };
  if (includeContentState) {
    identity.size = stat.size;
    identity.mtimeNs = stat.mtimeNs;
    identity.ctimeNs = stat.ctimeNs;
  }
  return identity;
}

function identitiesEqual(left, right) {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length
    && leftKeys.every((key) => left[key] === right[key]);
}

function stableDirectoryIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    modeType: stat.mode & 0o170000n,
    mode: stat.mode & 0o777n,
    uid: stat.uid,
  };
}

function assertPrivateDirectoryStat(stat, code) {
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777n) !== 0o700n
    || !ownerIsCurrent(stat)
  ) {
    fail(code, "私有临时目录的类型、权限或所有者不受控。");
  }
}

function holdOwnedDirectory(path, code, { relativePath = "" } = {}) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const descriptorStat = fstatSync(descriptor, { bigint: true });
    const pathStat = lstatSync(path, { bigint: true });
    assertPrivateDirectoryStat(descriptorStat, code);
    assertPrivateDirectoryStat(pathStat, code);
    const identity = stableDirectoryIdentity(descriptorStat);
    if (!identitiesEqual(identity, stableDirectoryIdentity(pathStat))) {
      fail(code, "私有临时目录在取得所有权句柄期间发生变化。");
    }
    return { descriptor, identity, path, relativePath };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 上层会保留身份不明的路径，不按路径清理。
      }
    }
    if (error instanceof NpmIsolationError) throw error;
    fail(code, "私有临时目录无法取得所有权句柄。");
  }
}

function assertOwnedDirectory(directory, path, code) {
  let descriptorStat;
  let pathStat;
  try {
    descriptorStat = fstatSync(directory.descriptor, { bigint: true });
    pathStat = lstatSync(path, { bigint: true });
  } catch {
    fail(code, "受控临时目录身份不可读。");
  }
  assertPrivateDirectoryStat(descriptorStat, code);
  assertPrivateDirectoryStat(pathStat, code);
  if (
    !identitiesEqual(directory.identity, stableDirectoryIdentity(descriptorStat))
    || !identitiesEqual(directory.identity, stableDirectoryIdentity(pathStat))
  ) {
    fail(code, "受控临时目录已被替换或改变权限。");
  }
}

function createOwnedWorkspace(temporaryParent, prefix) {
  let canonicalTmp;
  let parent;
  try {
    canonicalTmp = realpathSync("/tmp");
    parent = realpathSync(temporaryParent);
  } catch {
    fail("DUAL_ENDPOINT_CI_TEMP_PARENT", "双端点临时父目录不可用。");
  }
  if (!isInside(canonicalTmp, parent)) {
    fail("DUAL_ENDPOINT_CI_TEMP_PARENT", "双端点临时父目录必须位于 /tmp。" );
  }
  let rootPath;
  try {
    rootPath = mkdtempSync(join(parent, prefix));
    chmodSync(rootPath, 0o700);
    const root = holdOwnedDirectory(rootPath, "DUAL_ENDPOINT_CI_WORKSPACE_CREATE");
    fsyncDirectory(parent);
    return {
      cleaned: false,
      directories: [root],
      files: [],
      parent,
      root,
      rootPath,
    };
  } catch (error) {
    if (error instanceof NpmIsolationError) throw error;
    fail("DUAL_ENDPOINT_CI_WORKSPACE_CREATE", "双端点临时 workspace 无法安全创建。");
  }
}

function createOwnedSubdirectory(workspace, relativePath) {
  if (
    typeof relativePath !== "string"
    || relativePath === ""
    || isAbsolute(relativePath)
    || relativePath.split(sep).some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("DUAL_ENDPOINT_CI_WORKSPACE_CREATE", "临时子目录相对路径不合法。");
  }
  const path = resolve(workspace.rootPath, relativePath);
  if (!isInside(workspace.rootPath, path)) {
    fail("DUAL_ENDPOINT_CI_WORKSPACE_CREATE", "临时子目录逃逸 workspace。");
  }
  try {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
    const owned = holdOwnedDirectory(path, "DUAL_ENDPOINT_CI_WORKSPACE_CREATE", {
      relativePath,
    });
    workspace.directories.push(owned);
    return owned;
  } catch (error) {
    if (error instanceof NpmIsolationError) throw error;
    fail("DUAL_ENDPOINT_CI_WORKSPACE_CREATE", "临时 project workspace 无法安全创建。");
  }
}

function readDescriptorBytes(descriptor, code, maxBytes = MAX_INPUT_BYTES) {
  let before;
  try {
    before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.size < 1n
      || before.size > BigInt(maxBytes)
      || !ownerIsCurrent(before)
    ) {
      fail(code, "受控文件的类型、大小或所有者不合法。");
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail(code, "受控文件读取不完整。");
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!identitiesEqual(
      statIdentity(before, { includeContentState: true }),
      statIdentity(after, { includeContentState: true }),
    )) {
      bytes.fill(0);
      fail(code, "受控文件在读取期间发生变化。");
    }
    return bytes;
  } catch (error) {
    if (error instanceof NpmIsolationError) throw error;
    fail(code, "受控文件无法安全读取。");
  }
}

function holdRootInput(root, relativePath) {
  const path = resolve(root, relativePath);
  if (!isInside(root, path)) {
    fail("DUAL_ENDPOINT_CI_INPUT_FILE", "双端点固定输入逃逸仓库根目录。");
  }
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptorStat = fstatSync(descriptor, { bigint: true });
    const pathStat = lstatSync(path, { bigint: true });
    if (
      !descriptorStat.isFile()
      || descriptorStat.isSymbolicLink()
      || descriptorStat.nlink !== 1n
      || !ownerIsCurrent(descriptorStat)
      || !identitiesEqual(statIdentity(descriptorStat), statIdentity(pathStat))
    ) {
      fail("DUAL_ENDPOINT_CI_INPUT_FILE", `${relativePath} 不是受控仓库普通文件。`);
    }
    const bytes = readDescriptorBytes(descriptor, "DUAL_ENDPOINT_CI_INPUT_FILE");
    return {
      bytes,
      descriptor,
      hash: sha256(bytes),
      identity: statIdentity(descriptorStat),
      path,
      relativePath,
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 只关闭句柄，不按路径改动仓库输入。
      }
    }
    if (error instanceof NpmIsolationError) throw error;
    fail("DUAL_ENDPOINT_CI_INPUT_FILE", `缺少或无法安全读取 ${relativePath}。`);
  }
}

function captureRootInputs(root) {
  const inputs = [];
  try {
    for (const relativePath of DUAL_ENDPOINT_CI_INPUT_PATHS) {
      inputs.push(holdRootInput(root, relativePath));
    }
    if (inputs.find((input) => input.relativePath === ".nvmrc")?.bytes.toString("utf8") !== "24.18.0\n") {
      fail("DUAL_ENDPOINT_CI_INPUT_CONTRACT", ".nvmrc 不属于双端点精确主基线。");
    }
    return inputs;
  } catch (error) {
    for (const input of inputs) {
      closeSync(input.descriptor);
      input.bytes.fill(0);
    }
    throw error;
  }
}

function assertRootInputsCurrent(inputs) {
  for (const input of inputs) {
    let descriptorStat;
    let pathStat;
    try {
      descriptorStat = fstatSync(input.descriptor, { bigint: true });
      pathStat = lstatSync(input.path, { bigint: true });
    } catch {
      fail("DUAL_ENDPOINT_CI_INPUT_DRIFT", "双端点固定输入路径在执行期间不可读。");
    }
    if (
      !identitiesEqual(input.identity, statIdentity(descriptorStat))
      || !identitiesEqual(input.identity, statIdentity(pathStat))
    ) {
      fail("DUAL_ENDPOINT_CI_INPUT_DRIFT", "双端点固定输入在执行期间被替换。");
    }
    const bytes = readDescriptorBytes(input.descriptor, "DUAL_ENDPOINT_CI_INPUT_DRIFT");
    const currentHash = sha256(bytes);
    bytes.fill(0);
    if (currentHash !== input.hash) {
      fail("DUAL_ENDPOINT_CI_INPUT_DRIFT", "双端点固定输入在执行期间发生字节漂移。");
    }
  }
}

function releaseRootInputs(inputs) {
  for (const input of inputs) {
    try {
      closeSync(input.descriptor);
    } finally {
      input.bytes.fill(0);
    }
  }
}

function assertRootNodeModulesAbsent(root) {
  const path = join(root, "node_modules");
  if (pathExists(path, "DUAL_ENDPOINT_CI_ROOT_NODE_MODULES")) {
    fail(
      "DUAL_ENDPOINT_CI_ROOT_NODE_MODULES",
      "仓库根 node_modules 必须在双端点冻结安装前后均不存在；现有路径已保留。",
    );
  }
}

function createOwnedFile(workspace, path, bytes, mode = 0o600) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || !isInside(workspace.rootPath, path)) {
    fail("DUAL_ENDPOINT_CI_WORKSPACE_FILE", "受控临时文件输入不合法。");
  }
  let descriptor;
  let owned;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_RDWR
        | constants.O_NOFOLLOW,
      mode,
    );
    fchmodSync(descriptor, mode);
    owned = {
      bytes: Buffer.alloc(0),
      descriptor,
      identity: statIdentity(fstatSync(descriptor, { bigint: true })),
      path,
      relativePath: relative(workspace.rootPath, path),
    };
    workspace.files.push(owned);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    owned.bytes = Buffer.from(bytes);
    const descriptorStat = fstatSync(descriptor, { bigint: true });
    const pathStat = lstatSync(path, { bigint: true });
    owned.identity = statIdentity(descriptorStat);
    if (
      !descriptorStat.isFile()
      || descriptorStat.isSymbolicLink()
      || descriptorStat.nlink !== 1n
      || (descriptorStat.mode & 0o777n) !== BigInt(mode)
      || !ownerIsCurrent(descriptorStat)
      || !identitiesEqual(owned.identity, statIdentity(pathStat))
    ) {
      fail("DUAL_ENDPOINT_CI_WORKSPACE_FILE", "受控临时文件身份不合法。");
    }
    return owned;
  } catch (error) {
    if (error instanceof NpmIsolationError) throw error;
    fail("DUAL_ENDPOINT_CI_WORKSPACE_FILE", "受控临时文件无法创建或持久化。");
  }
}

function assertOwnedFileCurrent(file, path, code) {
  let descriptorStat;
  let pathStat;
  try {
    descriptorStat = fstatSync(file.descriptor, { bigint: true });
    pathStat = lstatSync(path, { bigint: true });
  } catch {
    fail(code, "受控临时文件身份不可读。");
  }
  if (
    !identitiesEqual(file.identity, statIdentity(descriptorStat))
    || !identitiesEqual(file.identity, statIdentity(pathStat))
  ) {
    fail(code, "受控临时文件已被替换。");
  }
  const bytes = readDescriptorBytes(file.descriptor, code, MINIMUM_NODE_DISTRIBUTION.maxBytes);
  const expected = file.bytes;
  const equal = bytes.equals(expected);
  bytes.fill(0);
  if (!equal) fail(code, "受控临时文件字节发生漂移。");
}

function assertOwnedFileIdentity(file, path, code) {
  let descriptorStat;
  let pathStat;
  try {
    descriptorStat = fstatSync(file.descriptor, { bigint: true });
    pathStat = lstatSync(path, { bigint: true });
  } catch {
    fail(code, "受控临时文件身份不可读。");
  }
  if (
    !descriptorStat.isFile()
    || descriptorStat.isSymbolicLink()
    || descriptorStat.nlink !== 1n
    || !ownerIsCurrent(descriptorStat)
    || !identitiesEqual(file.identity, statIdentity(descriptorStat))
    || !identitiesEqual(file.identity, statIdentity(pathStat))
  ) {
    fail(code, "受控临时文件不再属于本任务。");
  }
}

function createProjectCopy(workspace, ownedDirectory, inputs) {
  for (const input of inputs) {
    createOwnedFile(
      workspace,
      join(ownedDirectory.path, input.relativePath),
      input.bytes,
      0o600,
    );
  }
  fsyncDirectory(ownedDirectory.path);
  return ownedDirectory.path;
}

function projectInputHashes(projectRoot, workspace) {
  const hashOwnedProjectFile = (name) => {
    const path = join(projectRoot, name);
    const file = workspace.files.find((candidate) => candidate.path === path);
    if (!file) {
      fail("DUAL_ENDPOINT_CI_PROJECT_INPUT", "临时 project 缺少持有的固定输入。");
    }
    assertOwnedFileIdentity(file, path, "DUAL_ENDPOINT_CI_PROJECT_INPUT");
    const bytes = readDescriptorBytes(
      file.descriptor,
      "DUAL_ENDPOINT_CI_PROJECT_INPUT",
    );
    const hash = sha256(bytes);
    bytes.fill(0);
    return hash;
  };
  return {
    manifestSha256: hashOwnedProjectFile("package.json"),
    lockfileSha256: hashOwnedProjectFile("package-lock.json"),
  };
}

function singleHeader(headers, name) {
  const value = headers?.[name];
  if (value === undefined) return null;
  if (Array.isArray(value) || typeof value !== "string" || !RESPONSE_HEADER_VALUE.test(value)) {
    fail("DUAL_ENDPOINT_CI_DOWNLOAD_RESPONSE", "Node.js 制品响应头不合法。");
  }
  return value;
}

function terminateResponse(response) {
  for (const name of ["abort", "destroy"]) {
    try {
      response?.[name]?.();
    } catch {
      // 提前失败后只尽力终止响应，不覆盖原始稳定错误。
    }
  }
  try {
    response?.body?.destroy?.();
  } catch {
    // 同上。
  }
}

function defaultNodeRequest({ timeoutMs, url }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const request = requestHttps({
      ca: rootCertificates,
      hostname: url.hostname,
      method: "GET",
      path: url.pathname,
      port: 443,
      protocol: "https:",
      rejectUnauthorized: true,
      servername: url.hostname,
    }, (response) => {
      if (settled) {
        response.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        abort: () => response.destroy(),
        body: response,
        destroy: () => response.destroy(),
        headers: response.headers,
        statusCode: response.statusCode,
        url: url.href,
      });
    });
    const timer = setTimeout(() => {
      request.destroy(new Error("controlled Node.js distribution request timeout"));
    }, timeoutMs);
    timer.unref();
    request.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    });
    request.end();
  });
}

export async function downloadMinimumNodeArchive({
  calculateSha256 = sha256,
  request = defaultNodeRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof request !== "function" || typeof calculateSha256 !== "function") {
    fail("DUAL_ENDPOINT_CI_DOWNLOAD_OPTIONS", "Node.js 制品 request 与摘要器必须是函数。");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    fail("DUAL_ENDPOINT_CI_DOWNLOAD_OPTIONS", "Node.js 制品 timeout 超出受控范围。");
  }
  const url = new URL(MINIMUM_NODE_DISTRIBUTION.url);
  if (
    url.protocol !== "https:"
    || url.hostname !== "nodejs.org"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || url.href !== MINIMUM_NODE_DISTRIBUTION.url
  ) {
    fail("DUAL_ENDPOINT_CI_DOWNLOAD_SOURCE", "最低 Node.js 固定制品 URL 不合法。");
  }
  let response;
  try {
    response = await request({ timeoutMs, url });
  } catch (error) {
    if (error instanceof NpmIsolationError) throw error;
    fail("DUAL_ENDPOINT_CI_DOWNLOAD_NETWORK", "最低 Node.js 官方制品请求失败。");
  }

  let declaredLength = null;
  try {
    if (
      !isPlainObject(response)
      || response.statusCode !== 200
      || response.url !== url.href
      || typeof response.body?.[Symbol.asyncIterator] !== "function"
    ) {
      fail("DUAL_ENDPOINT_CI_DOWNLOAD_RESPONSE", "最低 Node.js 制品响应状态或来源不受支持。");
    }
    if (singleHeader(response.headers, "location") !== null) {
      fail("DUAL_ENDPOINT_CI_DOWNLOAD_REDIRECT", "最低 Node.js 制品响应不允许 redirect。");
    }
    const encoding = singleHeader(response.headers, "content-encoding");
    if (encoding !== null && encoding !== "identity") {
      fail("DUAL_ENDPOINT_CI_DOWNLOAD_RESPONSE", "最低 Node.js 制品响应不允许内容编码。");
    }
    const length = singleHeader(response.headers, "content-length");
    if (length !== null) {
      if (!/^(?:0|[1-9]\d*)$/.test(length)) {
        fail("DUAL_ENDPOINT_CI_DOWNLOAD_RESPONSE", "最低 Node.js 制品 content-length 不规范。");
      }
      declaredLength = Number(length);
      if (
        !Number.isSafeInteger(declaredLength)
        || declaredLength < 1
        || declaredLength > MINIMUM_NODE_DISTRIBUTION.maxBytes
      ) {
        fail("DUAL_ENDPOINT_CI_DOWNLOAD_LIMIT", "最低 Node.js 制品声明长度超限。");
      }
    }
  } catch (error) {
    terminateResponse(response);
    throw error;
  }

  const chunks = [];
  let received = 0;
  let bodyTimer;
  try {
    const collect = async () => {
      for await (const chunkInput of response.body) {
        if (!(Buffer.isBuffer(chunkInput) || chunkInput instanceof Uint8Array)) {
          fail("DUAL_ENDPOINT_CI_DOWNLOAD_RESPONSE", "最低 Node.js 制品响应块不是 bytes。");
        }
        const chunk = Buffer.from(chunkInput);
        received += chunk.length;
        if (received > MINIMUM_NODE_DISTRIBUTION.maxBytes) {
          fail("DUAL_ENDPOINT_CI_DOWNLOAD_LIMIT", "最低 Node.js 制品响应超过 64 MiB。");
        }
        chunks.push(chunk);
      }
    };
    const timeout = new Promise((_, rejectPromise) => {
      bodyTimer = setTimeout(() => {
        terminateResponse(response);
        rejectPromise(new NpmIsolationError(
          "DUAL_ENDPOINT_CI_DOWNLOAD_TIMEOUT",
          "最低 Node.js 制品响应超时。",
        ));
      }, timeoutMs);
      bodyTimer.unref();
    });
    await Promise.race([collect(), timeout]);
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    terminateResponse(response);
    if (error instanceof NpmIsolationError) throw error;
    fail("DUAL_ENDPOINT_CI_DOWNLOAD_NETWORK", "最低 Node.js 制品响应读取失败。");
  } finally {
    if (bodyTimer !== undefined) clearTimeout(bodyTimer);
  }
  if (received === 0 || (declaredLength !== null && received !== declaredLength)) {
    for (const chunk of chunks) chunk.fill(0);
    terminateResponse(response);
    fail("DUAL_ENDPOINT_CI_DOWNLOAD_RESPONSE", "最低 Node.js 制品响应长度不一致。");
  }
  const archive = Buffer.concat(chunks, received);
  for (const chunk of chunks) chunk.fill(0);
  let archiveSha256;
  try {
    archiveSha256 = calculateSha256(archive);
  } catch (error) {
    archive.fill(0);
    if (error instanceof NpmIsolationError) throw error;
    fail("DUAL_ENDPOINT_CI_DOWNLOAD_INTEGRITY", "最低 Node.js 制品 SHA-256 无法计算。");
  }
  if (archiveSha256 !== MINIMUM_NODE_DISTRIBUTION.sha256) {
    archive.fill(0);
    fail("DUAL_ENDPOINT_CI_DOWNLOAD_INTEGRITY", "最低 Node.js 制品 SHA-256 不匹配。");
  }
  return archive;
}

function validateSystemTar(path = SYSTEM_TAR) {
  if (path !== SYSTEM_TAR) {
    fail("DUAL_ENDPOINT_CI_TAR_TOOL", "最低 Node.js 只能由固定 /usr/bin/tar 解压。");
  }
  let stat;
  let canonical;
  try {
    stat = lstatSync(path, { bigint: true });
    canonical = realpathSync(path);
  } catch {
    fail("DUAL_ENDPOINT_CI_TAR_TOOL", "固定系统 tar 不可用。");
  }
  if (
    canonical !== SYSTEM_TAR
    || !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1n
    || (stat.mode & 0o111n) === 0n
    || (stat.mode & 0o022n) !== 0n
  ) {
    fail("DUAL_ENDPOINT_CI_TAR_TOOL", "固定系统 tar 的路径、类型或权限不受控。");
  }
  return canonical;
}

function assertRuntimeTreeEntry(stat, code) {
  if (!ownerIsCurrent(stat)) fail(code, "最低 Node.js 解压树包含其他所有者对象。");
  if (stat.isDirectory() || stat.isFile()) {
    if ((stat.mode & 0o022n) !== 0n) {
      fail(code, "最低 Node.js 解压树包含可被其他主体写入的对象。");
    }
    if (stat.isFile() && stat.nlink !== 1n) {
      fail(code, "最低 Node.js 解压树包含硬链接文件。");
    }
    return;
  }
  if (!stat.isSymbolicLink()) {
    fail(code, "最低 Node.js 解压树包含特殊文件。");
  }
}

export function validateExtractedRuntimeTree(runtimeRoot) {
  let root;
  try {
    root = realpathSync(runtimeRoot);
  } catch {
    fail("DUAL_ENDPOINT_CI_RUNTIME_TREE", "最低 Node.js 解压根目录不可用。");
  }
  if (root !== resolve(runtimeRoot)) {
    fail("DUAL_ENDPOINT_CI_RUNTIME_TREE", "最低 Node.js 解压根目录不能是链接。");
  }
  const pending = [{ depth: 0, path: root }];
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.depth > MAX_RUNTIME_TREE_DEPTH) {
      fail("DUAL_ENDPOINT_CI_RUNTIME_TREE", "最低 Node.js 解压树深度超限。");
    }
    const currentStat = lstatSync(current.path, { bigint: true });
    assertRuntimeTreeEntry(currentStat, "DUAL_ENDPOINT_CI_RUNTIME_TREE");
    if (!currentStat.isDirectory()) continue;
    const children = readdirSync(current.path).sort(compareBytes);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      entries += 1;
      if (entries > MAX_RUNTIME_TREE_ENTRIES) {
        fail("DUAL_ENDPOINT_CI_RUNTIME_TREE", "最低 Node.js 解压树条目数量超限。");
      }
      const child = join(current.path, children[index]);
      const childStat = lstatSync(child, { bigint: true });
      assertRuntimeTreeEntry(childStat, "DUAL_ENDPOINT_CI_RUNTIME_TREE");
      if (childStat.isSymbolicLink()) {
        const targetText = readlinkSync(child);
        if (targetText.includes("\0") || isAbsolute(targetText)) {
          fail("DUAL_ENDPOINT_CI_RUNTIME_TREE", "最低 Node.js 解压树链接目标不受控。");
        }
        let target;
        try {
          target = realpathSync(child);
        } catch {
          fail("DUAL_ENDPOINT_CI_RUNTIME_TREE", "最低 Node.js 解压树包含悬空链接。");
        }
        if (!isInside(root, target)) {
          fail("DUAL_ENDPOINT_CI_RUNTIME_TREE", "最低 Node.js 解压树链接逃逸运行时根目录。");
        }
      } else if (childStat.isDirectory()) {
        pending.push({ depth: current.depth + 1, path: child });
      }
    }
  }
  return root;
}

function captureMinimumRuntimeTreeState(runtimeRoot) {
  const canonicalRoot = validateExtractedRuntimeTree(runtimeRoot);
  const entries = [];
  const pending = [{ depth: 0, path: canonicalRoot, relativePath: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.depth > MAX_RUNTIME_TREE_DEPTH) {
      fail("DUAL_ENDPOINT_CI_MINIMUM_RUNTIME_DRIFT", "最低 Node.js 信任树深度超限。");
    }
    const stat = lstatSync(current.path, { bigint: true });
    assertRuntimeTreeEntry(stat, "DUAL_ENDPOINT_CI_MINIMUM_RUNTIME_DRIFT");
    const type = stat.isDirectory()
      ? "directory"
      : stat.isFile()
        ? "file"
        : "symlink";
    const entry = {
      identity: statIdentity(stat, { includeContentState: true }),
      relativePath: current.relativePath,
      type,
      ...(type === "symlink" ? { target: readlinkSync(current.path) } : {}),
    };
    entries.push(entry);
    if (entries.length > MAX_RUNTIME_TREE_ENTRIES) {
      fail("DUAL_ENDPOINT_CI_MINIMUM_RUNTIME_DRIFT", "最低 Node.js 信任树条目数量超限。");
    }
    if (type !== "directory") continue;
    const children = readdirSync(current.path).sort(compareBytes);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const name = children[index];
      pending.push({
        depth: current.depth + 1,
        path: join(current.path, name),
        relativePath: current.relativePath === ""
          ? name
          : join(current.relativePath, name),
      });
    }
  }
  return entries;
}

function assertMinimumRuntimeTreeStateCurrent(runtimeRoot, expected) {
  const actual = captureMinimumRuntimeTreeState(runtimeRoot);
  if (actual.length !== expected.length) {
    fail("DUAL_ENDPOINT_CI_MINIMUM_RUNTIME_DRIFT", "最低 Node.js 信任树成员发生漂移。");
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (
      actual[index].relativePath !== expected[index].relativePath
      || actual[index].type !== expected[index].type
      || actual[index].target !== expected[index].target
      || !identitiesEqual(actual[index].identity, expected[index].identity)
    ) {
      fail("DUAL_ENDPOINT_CI_MINIMUM_RUNTIME_DRIFT", "最低 Node.js 信任树在验证后被替换或修改。");
    }
  }
}

export function inspectAndAttestMinimumRuntime({
  inspectRuntime = inspectMinimumRuntime,
  runtimeRoot,
} = {}) {
  if (typeof inspectRuntime !== "function" || typeof runtimeRoot !== "string") {
    fail("DUAL_ENDPOINT_CI_MINIMUM_RUNTIME", "最低 Node.js 运行时见证输入不合法。");
  }
  const trustState = captureMinimumRuntimeTreeState(runtimeRoot);
  let runtime;
  try {
    runtime = inspectRuntime({ runtimeRoot });
  } finally {
    // 即使版本探针失败，也必须先证明探针窗口没有改变已捕获的信任树。
    assertMinimumRuntimeTreeStateCurrent(runtimeRoot, trustState);
  }
  MINIMUM_RUNTIME_ATTESTATIONS.set(runtime, {
    root: runtimeRoot,
    state: trustState,
  });
  return runtime;
}

function assertTarExecutionInputsCurrent({
  archiveBytes,
  archiveDescriptor,
  archivePath,
  archiveStat,
  extractDescriptor,
  extractRoot,
  extractStat,
}) {
  let afterArchiveStat;
  let afterArchivePathStat;
  let afterExtractStat;
  let afterExtractPathStat;
  try {
    afterArchiveStat = fstatSync(archiveDescriptor, { bigint: true });
    afterArchivePathStat = lstatSync(archivePath, { bigint: true });
    afterExtractStat = fstatSync(extractDescriptor, { bigint: true });
    afterExtractPathStat = lstatSync(extractRoot, { bigint: true });
  } catch {
    fail(
      "DUAL_ENDPOINT_CI_TAR_INPUT",
      "最低 Node.js archive 或解压目录在 tar 执行期间不可读。",
    );
  }
  if (
    !identitiesEqual(
      statIdentity(archiveStat, { includeContentState: true }),
      statIdentity(afterArchiveStat, { includeContentState: true }),
    )
    || !identitiesEqual(statIdentity(afterArchiveStat), statIdentity(afterArchivePathStat))
    || !identitiesEqual(stableDirectoryIdentity(extractStat), stableDirectoryIdentity(afterExtractStat))
    || !identitiesEqual(
      stableDirectoryIdentity(afterExtractStat),
      stableDirectoryIdentity(afterExtractPathStat),
    )
  ) {
    fail(
      "DUAL_ENDPOINT_CI_TAR_INPUT",
      "最低 Node.js archive 或解压目录在 tar 执行期间被替换。",
    );
  }
  const afterArchiveBytes = readDescriptorBytes(
    archiveDescriptor,
    "DUAL_ENDPOINT_CI_TAR_INPUT",
    MINIMUM_NODE_DISTRIBUTION.maxBytes,
  );
  try {
    if (!afterArchiveBytes.equals(archiveBytes)) {
      fail(
        "DUAL_ENDPOINT_CI_TAR_INPUT",
        "最低 Node.js archive 在 tar 执行期间发生字节漂移。",
      );
    }
  } finally {
    afterArchiveBytes.fill(0);
  }
}

export function extractMinimumNodeArchive({
  archivePath,
  calculateSha256 = sha256,
  extractRoot,
  runProcess = spawnSync,
  tarPath = SYSTEM_TAR,
} = {}) {
  if (
    typeof archivePath !== "string"
    || typeof extractRoot !== "string"
    || !isAbsolute(archivePath)
    || !isAbsolute(extractRoot)
    || typeof runProcess !== "function"
    || typeof calculateSha256 !== "function"
  ) {
    fail("DUAL_ENDPOINT_CI_TAR_INPUT", "最低 Node.js 解压输入不合法。");
  }
  let archiveDescriptor;
  let extractDescriptor;
  let extractStat;
  let archiveStat;
  try {
    archiveDescriptor = openSync(
      archivePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    extractDescriptor = openSync(
      extractRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    extractStat = lstatSync(extractRoot, { bigint: true });
    archiveStat = lstatSync(archivePath, { bigint: true });
  } catch {
    if (archiveDescriptor !== undefined) closeSync(archiveDescriptor);
    if (extractDescriptor !== undefined) closeSync(extractDescriptor);
    fail("DUAL_ENDPOINT_CI_TAR_INPUT", "最低 Node.js archive 或解压目录不可用。");
  }
  try {
    const openedArchiveStat = fstatSync(archiveDescriptor, { bigint: true });
    const openedExtractStat = fstatSync(extractDescriptor, { bigint: true });
    assertPrivateDirectoryStat(extractStat, "DUAL_ENDPOINT_CI_TAR_INPUT");
    assertPrivateDirectoryStat(openedExtractStat, "DUAL_ENDPOINT_CI_TAR_INPUT");
    if (
      !identitiesEqual(
        stableDirectoryIdentity(extractStat),
        stableDirectoryIdentity(openedExtractStat),
      )
      || !archiveStat.isFile()
      || archiveStat.isSymbolicLink()
      || archiveStat.nlink !== 1n
      || archiveStat.size < 1n
      || archiveStat.size > BigInt(MINIMUM_NODE_DISTRIBUTION.maxBytes)
      || !ownerIsCurrent(archiveStat)
      || !identitiesEqual(statIdentity(archiveStat), statIdentity(openedArchiveStat))
      || readdirSync(extractRoot).length !== 0
    ) {
      fail("DUAL_ENDPOINT_CI_TAR_INPUT", "最低 Node.js archive 或解压目录状态不受控。");
    }
    const archiveBytes = readDescriptorBytes(
      archiveDescriptor,
      "DUAL_ENDPOINT_CI_TAR_INPUT",
      MINIMUM_NODE_DISTRIBUTION.maxBytes,
    );
    try {
      const archiveSha256 = calculateSha256(archiveBytes);
      if (archiveSha256 !== MINIMUM_NODE_DISTRIBUTION.sha256) {
        fail("DUAL_ENDPOINT_CI_DOWNLOAD_INTEGRITY", "落盘的最低 Node.js 制品 SHA-256 不匹配。");
      }
      const executable = validateSystemTar(tarPath);
      let processError = null;
      let result;
      try {
        result = runProcess(executable, [
          "--extract",
          "--xz",
          "--file",
          "-",
          "--directory",
          "/proc/self/fd/3",
          "--no-same-owner",
          "--no-same-permissions",
        ], {
          cwd: extractRoot,
          encoding: "utf8",
          env: {
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            PATH: "/usr/bin:/bin",
          },
          input: archiveBytes,
          maxBuffer: MAX_WORKER_OUTPUT_BYTES,
          stdio: ["pipe", "pipe", "pipe", extractDescriptor],
          windowsHide: true,
        });
      } catch (error) {
        processError = error;
      }
      assertTarExecutionInputsCurrent({
        archiveBytes,
        archiveDescriptor,
        archivePath,
        archiveStat: openedArchiveStat,
        extractDescriptor,
        extractRoot,
        extractStat: openedExtractStat,
      });
      if (processError instanceof NpmIsolationError) throw processError;
      if (processError || result?.error || result?.status !== 0 || result?.signal) {
        fail("DUAL_ENDPOINT_CI_TAR_FAILED", "固定系统 tar 解压最低 Node.js 制品失败。");
      }
    } finally {
      archiveBytes.fill(0);
    }
  } catch (error) {
    if (error instanceof NpmIsolationError) throw error;
    fail("DUAL_ENDPOINT_CI_TAR_FAILED", "固定系统 tar 无法启动。");
  } finally {
    closeSync(archiveDescriptor);
    closeSync(extractDescriptor);
  }
  const entries = readdirSync(extractRoot);
  if (
    entries.length !== 1
    || entries[0] !== MINIMUM_NODE_DISTRIBUTION.expectedTopDirectory
  ) {
    fail("DUAL_ENDPOINT_CI_TAR_LAYOUT", "最低 Node.js 制品没有形成单一预期顶层目录。");
  }
  const runtimeRoot = join(extractRoot, MINIMUM_NODE_DISTRIBUTION.expectedTopDirectory);
  const runtimeStat = lstatSync(runtimeRoot, { bigint: true });
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
    fail("DUAL_ENDPOINT_CI_TAR_LAYOUT", "最低 Node.js 预期顶层不是普通目录。");
  }
  validateExtractedRuntimeTree(runtimeRoot);
  return runtimeRoot;
}

function probeNodeVersion(nodeExecutable, runProcess = spawnSync) {
  const result = runProcess(nodeExecutable, [
    "--eval",
    "process.stdout.write(process.versions.node)",
  ], {
    cwd: dirname(nodeExecutable),
    encoding: "utf8",
    env: {
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    },
    maxBuffer: 1024,
    windowsHide: true,
  });
  if (
    result?.error
    || result?.status !== 0
    || result?.signal
    || result.stderr !== ""
    || !EXACT_VERSION.test(result.stdout ?? "")
  ) {
    fail("DUAL_ENDPOINT_CI_MINIMUM_RUNTIME", "最低 Node.js 版本探针失败。");
  }
  return result.stdout;
}

export function inspectMinimumRuntime({
  runtimeRoot,
  runProcess = spawnSync,
} = {}) {
  const canonicalRoot = validateExtractedRuntimeTree(runtimeRoot);
  const nodeExecutable = join(canonicalRoot, "bin/node");
  let nodeStat;
  try {
    nodeStat = lstatSync(nodeExecutable, { bigint: true });
  } catch {
    fail("DUAL_ENDPOINT_CI_MINIMUM_RUNTIME", "最低 Node.js 缺少 bin/node。");
  }
  if (
    !nodeStat.isFile()
    || nodeStat.isSymbolicLink()
    || nodeStat.nlink !== 1n
    || (nodeStat.mode & 0o111n) === 0n
    || (nodeStat.mode & 0o022n) !== 0n
  ) {
    fail("DUAL_ENDPOINT_CI_MINIMUM_RUNTIME", "最低 Node.js bin/node 类型或权限不受控。");
  }
  const npm = deriveNpmCli(nodeExecutable);
  const nodeVersion = probeNodeVersion(npm.nodeExecutable, runProcess);
  if (
    nodeVersion !== DUAL_ENDPOINT_CI_RUNTIME.minimum.nodeVersion
    || npm.npmVersion !== DUAL_ENDPOINT_CI_RUNTIME.minimum.npmVersion
  ) {
    fail("DUAL_ENDPOINT_CI_MINIMUM_RUNTIME", "最低 Node/npm 精确版本不匹配。");
  }
  return Object.freeze({
    nodeExecutable: npm.nodeExecutable,
    nodeVersion,
    npmVersion: npm.npmVersion,
    role: "minimum",
  });
}

export function verifyPrimaryRuntime({
  architecture = process.arch,
  nodeExecutable = process.execPath,
  nodeVersion = process.versions.node,
  platform = process.platform,
} = {}) {
  if (platform !== "linux" || architecture !== "x64") {
    fail("DUAL_ENDPOINT_CI_HOST_PLATFORM", "双端点父入口只支持 Linux x64。");
  }
  const npm = deriveNpmCli(nodeExecutable);
  if (
    nodeVersion !== process.versions.node
    || npm.nodeExecutable !== realpathSync(process.execPath)
    || nodeVersion !== DUAL_ENDPOINT_CI_RUNTIME.primary.nodeVersion
    || npm.npmVersion !== DUAL_ENDPOINT_CI_RUNTIME.primary.npmVersion
  ) {
    fail("DUAL_ENDPOINT_CI_HOST_RUNTIME", "父入口必须由精确主 Node/npm 端点运行。");
  }
  return Object.freeze({
    nodeExecutable: npm.nodeExecutable,
    nodeVersion,
    npmVersion: npm.npmVersion,
    role: "primary",
  });
}

async function defaultPrepareMinimumRuntime({ extractRoot, workspace }) {
  const archive = await downloadMinimumNodeArchive();
  let archiveFile;
  try {
    archiveFile = createOwnedFile(
      workspace,
      join(workspace.rootPath, MINIMUM_NODE_DISTRIBUTION.archiveFileName),
      archive,
      0o600,
    );
  } finally {
    archive.fill(0);
  }
  const runtimeRoot = extractMinimumNodeArchive({
    archivePath: archiveFile.path,
    extractRoot,
  });
  return inspectAndAttestMinimumRuntime({ runtimeRoot });
}

function validateEndpointRuntime(value, role, code) {
  assertExactKeys(
    value,
    ["nodeExecutable", "nodeVersion", "npmVersion", "role"],
    code,
    `${role} runtime`,
  );
  const expected = DUAL_ENDPOINT_CI_RUNTIME[role];
  if (
    value.role !== role
    || value.nodeVersion !== expected.nodeVersion
    || value.npmVersion !== expected.npmVersion
    || typeof value.nodeExecutable !== "string"
    || !isAbsolute(value.nodeExecutable)
  ) {
    fail(code, `${role} Node/npm 运行时不匹配。`);
  }
  return value;
}

export function validateWorkerResult(value, role) {
  const code = role === "primary"
    ? "DUAL_ENDPOINT_CI_PRIMARY_FAILED"
    : "DUAL_ENDPOINT_CI_MINIMUM_FAILED";
  assertExactKeys(
    value,
    ["nodeVersion", "npmVersion", "role"],
    code,
    `${role} worker result`,
  );
  const expected = DUAL_ENDPOINT_CI_RUNTIME[role];
  if (
    value.role !== role
    || value.nodeVersion !== expected.nodeVersion
    || value.npmVersion !== expected.npmVersion
  ) {
    fail(code, `${role} worker 没有证明精确 Node/npm 端点。`);
  }
  return Object.freeze({
    nodeVersion: value.nodeVersion,
    npmVersion: value.npmVersion,
    role: value.role,
  });
}

function parseWorkerOutput(text, role) {
  const code = role === "primary"
    ? "DUAL_ENDPOINT_CI_PRIMARY_FAILED"
    : "DUAL_ENDPOINT_CI_MINIMUM_FAILED";
  if (
    typeof text !== "string"
    || text === ""
    || Buffer.byteLength(text, "utf8") > MAX_WORKER_OUTPUT_BYTES
  ) {
    fail(code, `${role} worker 输出为空或超限。`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(code, `${role} worker 输出不是合法 JSON。`);
  }
  const validated = validateWorkerResult(value, role);
  if (canonicalJsonBytes(validated) !== text) {
    fail(code, `${role} worker 输出不是 canonical JSON。`);
  }
  return validated;
}

function defaultRunWorker({ nodeExecutable, projectRoot, role }) {
  const result = spawnSync(nodeExecutable, [WORKER_PATH], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    },
    maxBuffer: MAX_WORKER_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (result?.error || result?.status !== 0 || result?.signal || result.stderr !== "") {
    const code = role === "primary"
      ? "DUAL_ENDPOINT_CI_PRIMARY_FAILED"
      : "DUAL_ENDPOINT_CI_MINIMUM_FAILED";
    fail(code, `${role} 冻结安装 worker 失败；子进程输出已抑制。`);
  }
  return parseWorkerOutput(result.stdout, role);
}

function snapshotCleanupTree(root) {
  const snapshots = [];
  const walk = (path, relativePath, depth) => {
    if (depth > MAX_RUNTIME_TREE_DEPTH * 4) {
      fail("DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN", "临时 workspace 深度超出安全清理上限。");
    }
    let stat;
    try {
      stat = lstatSync(path, { bigint: true });
    } catch {
      fail("DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN", "临时 workspace 清理快照不可读。");
    }
    if (!ownerIsCurrent(stat)) {
      fail("DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN", "临时 workspace 出现非本任务所有者对象。");
    }
    let type;
    if (stat.isDirectory() && !stat.isSymbolicLink()) type = "directory";
    else if (stat.isFile() && !stat.isSymbolicLink()) type = "file";
    else if (stat.isSymbolicLink()) type = "symlink";
    else fail("DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN", "临时 workspace 出现特殊对象。");

    if (type === "directory") {
      let names;
      try {
        names = readdirSync(path).sort(compareBytes);
      } catch {
        fail("DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN", "临时 workspace 目录无法枚举。");
      }
      for (const name of names) {
        const childRelative = relativePath === "" ? name : join(relativePath, name);
        walk(join(path, name), childRelative, depth + 1);
      }
    }
    snapshots.push({
      identity: type === "directory"
        ? stableDirectoryIdentity(stat)
        : statIdentity(stat, { includeContentState: true }),
      path,
      relativePath,
      type,
    });
    if (snapshots.length > MAX_RUNTIME_TREE_ENTRIES * 4) {
      fail("DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN", "临时 workspace 条目数量超出安全清理上限。");
    }
  };
  walk(root, "", 0);
  return snapshots;
}

function assertCleanupSnapshotCurrent(snapshots) {
  const current = snapshotCleanupTree(snapshots.at(-1).path);
  if (current.length !== snapshots.length) {
    fail("DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN", "临时 workspace 在清理前出现条目漂移。");
  }
  for (let index = 0; index < snapshots.length; index += 1) {
    const expected = snapshots[index];
    const actual = current[index];
    if (
      expected.relativePath !== actual.relativePath
      || expected.type !== actual.type
      || !identitiesEqual(expected.identity, actual.identity)
    ) {
      fail("DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN", "临时 workspace 在清理前被替换或修改。");
    }
  }
}

function closeWorkspaceDescriptors(workspace) {
  for (const file of workspace.files) {
    if (file.descriptor === null) continue;
    try {
      closeSync(file.descriptor);
    } catch {
      // 清理失败路径统一保留隔离状态并报告 uncertain。
    }
    file.descriptor = null;
    file.bytes.fill(0);
  }
  for (const directory of workspace.directories) {
    if (directory.descriptor === null) continue;
    try {
      closeSync(directory.descriptor);
    } catch {
      // 同上。
    }
    directory.descriptor = null;
  }
}

function cleanupOwnedWorkspace(workspace, {
  afterOwnershipCheck = null,
  afterTreeSnapshot = null,
} = {}) {
  if (workspace.cleaned) return;
  if (
    (afterOwnershipCheck !== null && typeof afterOwnershipCheck !== "function")
    || (afterTreeSnapshot !== null && typeof afterTreeSnapshot !== "function")
  ) {
    fail("DUAL_ENDPOINT_CI_CLEANUP_OPTIONS", "workspace 清理测试钩子必须是函数或 null。");
  }
  let quarantinePath;
  let quarantineDirectory = null;
  try {
    assertOwnedDirectory(
      workspace.root,
      workspace.rootPath,
      "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN",
    );
    for (const file of workspace.files) {
      assertOwnedFileIdentity(file, file.path, "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN");
    }
    if (afterOwnershipCheck) afterOwnershipCheck(workspace.rootPath);
    assertOwnedDirectory(
      workspace.root,
      workspace.rootPath,
      "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN",
    );
    for (const file of workspace.files) {
      assertOwnedFileIdentity(file, file.path, "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN");
    }
    const quarantineDirectoryPath = mkdtempSync(join(
      workspace.parent,
      ".axial-muse-dual-endpoint-ci-quarantine-",
    ));
    chmodSync(quarantineDirectoryPath, 0o700);
    quarantineDirectory = holdOwnedDirectory(
      quarantineDirectoryPath,
      "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN",
    );
    fsyncDirectory(workspace.parent);
    if (readdirSync(quarantineDirectoryPath).length !== 0) {
      fail("DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN", "新建 quarantine 目录不是空目录。");
    }
    quarantinePath = join(quarantineDirectoryPath, basename(workspace.rootPath));
    renameSync(workspace.rootPath, quarantinePath);
    fsyncDirectory(workspace.parent);
    fsyncDirectory(quarantineDirectoryPath);
    assertOwnedDirectory(
      quarantineDirectory,
      quarantineDirectoryPath,
      "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN",
    );
    if (readdirSync(quarantineDirectoryPath).join("\n") !== basename(quarantinePath)) {
      fail("DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN", "quarantine 目录成员集合发生漂移。");
    }
    assertOwnedDirectory(
      workspace.root,
      quarantinePath,
      "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN",
    );
    if (pathExists(workspace.rootPath, "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN")) {
      fail("DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN", "workspace 摘离后原路径被外部对象占用。");
    }

    for (const directory of workspace.directories) {
      const path = directory.relativePath === ""
        ? quarantinePath
        : join(quarantinePath, directory.relativePath);
      assertOwnedDirectory(directory, path, "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN");
    }
    for (const file of workspace.files) {
      const path = join(quarantinePath, file.relativePath);
      assertOwnedFileIdentity(file, path, "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN");
    }

    const snapshots = snapshotCleanupTree(quarantinePath);
    if (afterTreeSnapshot) afterTreeSnapshot({ quarantinePath, snapshots });
    assertCleanupSnapshotCurrent(snapshots);

    const heldDirectories = new Map(workspace.directories.map((directory) => [
      directory.relativePath,
      directory,
    ]));
    for (const file of workspace.files) {
      closeSync(file.descriptor);
      file.descriptor = null;
      file.bytes.fill(0);
    }
    for (const snapshot of snapshots) {
      const currentStat = lstatSync(snapshot.path, { bigint: true });
      const identity = snapshot.type === "directory"
        ? stableDirectoryIdentity(currentStat)
        : statIdentity(currentStat, { includeContentState: true });
      if (!identitiesEqual(identity, snapshot.identity)) {
        fail("DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN", "临时对象在逐项清理窗口发生变化。");
      }
      if (snapshot.type === "directory") {
        const held = heldDirectories.get(snapshot.relativePath);
        if (held?.descriptor !== null && held?.descriptor !== undefined) {
          assertOwnedDirectory(held, snapshot.path, "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN");
          closeSync(held.descriptor);
          held.descriptor = null;
        }
        rmdirSync(snapshot.path);
      } else {
        unlinkSync(snapshot.path);
      }
    }
    assertOwnedDirectory(
      quarantineDirectory,
      quarantineDirectoryPath,
      "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN",
    );
    if (readdirSync(quarantineDirectoryPath).length !== 0) {
      fail("DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN", "任务 workspace 删除后 quarantine 仍有未知成员。");
    }
    closeSync(quarantineDirectory.descriptor);
    quarantineDirectory.descriptor = null;
    rmdirSync(quarantineDirectoryPath);
    fsyncDirectory(workspace.parent);
    if (
      pathExists(workspace.rootPath, "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN")
      || pathExists(quarantinePath, "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN")
      || pathExists(quarantineDirectoryPath, "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN")
    ) {
      fail("DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN", "临时 workspace 清理后路径被外部对象占用。");
    }
    workspace.cleaned = true;
  } catch (error) {
    closeWorkspaceDescriptors(workspace);
    if (quarantineDirectory?.descriptor !== null && quarantineDirectory?.descriptor !== undefined) {
      try {
        closeSync(quarantineDirectory.descriptor);
        quarantineDirectory.descriptor = null;
      } catch {
        // quarantine 保留，统一报告 cleanup uncertain。
      }
    }
    if (error instanceof NpmIsolationError && error.code === "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN") {
      throw error;
    }
    fail(
      "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN",
      "临时 workspace 无法在所有权证明下安全清理；隔离或外部状态已保留。",
    );
  }
}

function createEndpointReceipt(role, runtime, before, after) {
  return {
    role,
    nodeVersion: runtime.nodeVersion,
    npmVersion: runtime.npmVersion,
    before: {
      lockfileSha256: before.lockfileSha256,
      manifestSha256: before.manifestSha256,
    },
    after: {
      lockfileSha256: after.lockfileSha256,
      manifestSha256: after.manifestSha256,
    },
  };
}

export function validateDualEndpointCiReceipt(value) {
  assertExactKeys(
    value,
    ["endpoints", "inputs", "kind", "owner", "status", "version"],
    "DUAL_ENDPOINT_CI_RECEIPT_SCHEMA",
    "双端点 receipt",
  );
  for (const [key, expected] of Object.entries(DUAL_ENDPOINT_CI_RECEIPT_ENVELOPE)) {
    if (value[key] !== expected) {
      fail("DUAL_ENDPOINT_CI_RECEIPT_SCHEMA", `双端点 receipt ${key} 不受支持。`);
    }
  }
  assertExactKeys(
    value.inputs,
    DUAL_ENDPOINT_CI_INPUT_PATHS,
    "DUAL_ENDPOINT_CI_RECEIPT_SCHEMA",
    "双端点 receipt inputs",
  );
  for (const path of DUAL_ENDPOINT_CI_INPUT_PATHS) {
    if (!HEX_64.test(value.inputs[path] ?? "")) {
      fail("DUAL_ENDPOINT_CI_RECEIPT_SCHEMA", "双端点 receipt 输入摘要不合法。");
    }
  }
  if (!Array.isArray(value.endpoints) || value.endpoints.length !== 2) {
    fail("DUAL_ENDPOINT_CI_RECEIPT_SCHEMA", "双端点 receipt 必须精确包含两个端点。");
  }
  const expectedRoles = ["primary", "minimum"];
  const endpoints = value.endpoints.map((endpoint, index) => {
    const role = expectedRoles[index];
    assertExactKeys(
      endpoint,
      ["after", "before", "nodeVersion", "npmVersion", "role"],
      "DUAL_ENDPOINT_CI_RECEIPT_SCHEMA",
      `双端点 receipt ${role}`,
    );
    if (
      endpoint.role !== role
      || endpoint.nodeVersion !== DUAL_ENDPOINT_CI_RUNTIME[role].nodeVersion
      || endpoint.npmVersion !== DUAL_ENDPOINT_CI_RUNTIME[role].npmVersion
    ) {
      fail("DUAL_ENDPOINT_CI_RECEIPT_SCHEMA", "双端点 receipt 运行时不匹配。");
    }
    for (const phase of ["before", "after"]) {
      assertExactKeys(
        endpoint[phase],
        ["lockfileSha256", "manifestSha256"],
        "DUAL_ENDPOINT_CI_RECEIPT_SCHEMA",
        `双端点 receipt ${role}.${phase}`,
      );
      if (
        !HEX_64.test(endpoint[phase].lockfileSha256 ?? "")
        || !HEX_64.test(endpoint[phase].manifestSha256 ?? "")
      ) {
        fail("DUAL_ENDPOINT_CI_RECEIPT_SCHEMA", "双端点 receipt 前后摘要不合法。");
      }
    }
    if (
      endpoint.before.lockfileSha256 !== endpoint.after.lockfileSha256
      || endpoint.before.manifestSha256 !== endpoint.after.manifestSha256
      || endpoint.before.lockfileSha256 !== value.inputs["package-lock.json"]
      || endpoint.before.manifestSha256 !== value.inputs["package.json"]
    ) {
      fail("DUAL_ENDPOINT_CI_RECEIPT_SCHEMA", "双端点 receipt 没有证明相同输入前后不变。");
    }
    return createEndpointReceipt(
      role,
      endpoint,
      endpoint.before,
      endpoint.after,
    );
  });
  return {
    ...DUAL_ENDPOINT_CI_RECEIPT_ENVELOPE,
    inputs: Object.fromEntries(DUAL_ENDPOINT_CI_INPUT_PATHS.map((path) => [
      path,
      value.inputs[path],
    ])),
    endpoints,
  };
}

export function dualEndpointCiReceiptBytes(receipt) {
  return canonicalJsonBytes(validateDualEndpointCiReceipt(receipt));
}

function persistReceipt(receipt, temporaryParent) {
  const workspace = createOwnedWorkspace(
    temporaryParent,
    "axial-muse-dual-endpoint-ci-receipt-",
  );
  let file;
  try {
    const bytes = Buffer.from(dualEndpointCiReceiptBytes(receipt), "utf8");
    file = createOwnedFile(
      workspace,
      join(workspace.rootPath, "receipt.json"),
      bytes,
      0o600,
    );
    bytes.fill(0);
    fsyncDirectory(workspace.rootPath);
    fsyncDirectory(workspace.parent);
    assertOwnedDirectory(
      workspace.root,
      workspace.rootPath,
      "DUAL_ENDPOINT_CI_RECEIPT_WRITE",
    );
    assertOwnedFileCurrent(file, file.path, "DUAL_ENDPOINT_CI_RECEIPT_WRITE");
    const persistedBytes = readDescriptorBytes(
      file.descriptor,
      "DUAL_ENDPOINT_CI_RECEIPT_WRITE",
    );
    let parsed;
    try {
      parsed = JSON.parse(persistedBytes.toString("utf8"));
    } finally {
      persistedBytes.fill(0);
    }
    if (dualEndpointCiReceiptBytes(parsed) !== dualEndpointCiReceiptBytes(receipt)) {
      fail("DUAL_ENDPOINT_CI_RECEIPT_WRITE", "双端点 receipt 落盘字节复核失败。");
    }
    closeWorkspaceDescriptors(workspace);
    return file.path;
  } catch (error) {
    try {
      cleanupOwnedWorkspace(workspace);
    } catch {
      fail(
        "DUAL_ENDPOINT_CI_RECEIPT_CLEANUP_UNCERTAIN",
        "双端点 receipt 写入失败且无法安全清理本次残留。",
      );
    }
    if (error instanceof NpmIsolationError) throw error;
    fail("DUAL_ENDPOINT_CI_RECEIPT_WRITE", "双端点 receipt 无法安全持久化。");
  }
}

function canonicalRootPath(root) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    fail("DUAL_ENDPOINT_CI_ROOT", "双端点仓库根目录必须是绝对路径。");
  }
  let canonical;
  try {
    canonical = realpathSync(root);
  } catch {
    fail("DUAL_ENDPOINT_CI_ROOT", "双端点仓库根目录不可用。");
  }
  if (canonical !== root) {
    fail("DUAL_ENDPOINT_CI_ROOT", "双端点仓库根目录必须是规范路径。");
  }
  return canonical;
}

function normalizeEndpointFailure(error, role) {
  const code = role === "primary"
    ? "DUAL_ENDPOINT_CI_PRIMARY_FAILED"
    : "DUAL_ENDPOINT_CI_MINIMUM_FAILED";
  if (error instanceof NpmIsolationError && error.code === code) return error;
  return new NpmIsolationError(code, `${role} 冻结安装失败；详细子进程输出已抑制。`);
}

export async function runDualEndpointCi({
  afterCleanupOwnershipCheck = null,
  afterCleanupTreeSnapshot = null,
  afterInputSnapshot = null,
  prepareMinimumRuntime = defaultPrepareMinimumRuntime,
  root,
  runWorker = defaultRunWorker,
  temporaryParent = "/tmp",
  verifyHostRuntime = verifyPrimaryRuntime,
} = {}) {
  for (const [name, callback] of Object.entries({
    afterCleanupOwnershipCheck,
    afterCleanupTreeSnapshot,
    afterInputSnapshot,
    prepareMinimumRuntime,
    runWorker,
    verifyHostRuntime,
  })) {
    if (callback !== null && typeof callback !== "function") {
      fail("DUAL_ENDPOINT_CI_OPTIONS", `双端点选项 ${name} 必须是函数或 null。`);
    }
  }
  const canonicalRoot = canonicalRootPath(root);
  assertRootNodeModulesAbsent(canonicalRoot);

  let primaryRuntime;
  try {
    primaryRuntime = validateEndpointRuntime(
      verifyHostRuntime(),
      "primary",
      "DUAL_ENDPOINT_CI_HOST_RUNTIME",
    );
  } catch (error) {
    if (error instanceof NpmIsolationError) throw error;
    fail("DUAL_ENDPOINT_CI_HOST_RUNTIME", "主 Node/npm 运行时验证失败。");
  }

  const inputs = captureRootInputs(canonicalRoot);
  let workspace;
  let operationError = null;
  let cleanupError = null;
  let postCleanupError = null;
  let endpointReceipts;
  try {
    if (afterInputSnapshot) afterInputSnapshot({ root: canonicalRoot });
    assertRootInputsCurrent(inputs);
    assertRootNodeModulesAbsent(canonicalRoot);

    workspace = createOwnedWorkspace(
      temporaryParent,
      "axial-muse-dual-endpoint-ci-",
    );
    const primaryProjectDirectory = createOwnedSubdirectory(workspace, "primary-project");
    const minimumProjectDirectory = createOwnedSubdirectory(workspace, "minimum-project");
    const minimumExtractDirectory = createOwnedSubdirectory(workspace, "minimum-runtime");
    const primaryProject = createProjectCopy(workspace, primaryProjectDirectory, inputs);
    const minimumProject = createProjectCopy(workspace, minimumProjectDirectory, inputs);

    const primaryBefore = projectInputHashes(primaryProject, workspace);
    let primaryResult;
    try {
      primaryResult = validateWorkerResult(await runWorker({
        nodeExecutable: primaryRuntime.nodeExecutable,
        projectRoot: primaryProject,
        role: "primary",
      }), "primary");
    } catch (error) {
      throw normalizeEndpointFailure(error, "primary");
    }
    const primaryAfter = projectInputHashes(primaryProject, workspace);
    if (
      primaryBefore.manifestSha256 !== primaryAfter.manifestSha256
      || primaryBefore.lockfileSha256 !== primaryAfter.lockfileSha256
    ) {
      fail("DUAL_ENDPOINT_CI_PRIMARY_DRIFT", "主端点临时 manifest/lock 发生漂移。");
    }

    let minimumRuntime;
    let minimumRuntimeAttestation;
    try {
      const preparedMinimumRuntime = await prepareMinimumRuntime({
        extractRoot: minimumExtractDirectory.path,
        workspace,
      });
      minimumRuntime = validateEndpointRuntime(
        preparedMinimumRuntime,
        "minimum",
        "DUAL_ENDPOINT_CI_MINIMUM_RUNTIME",
      );
      minimumRuntimeAttestation = MINIMUM_RUNTIME_ATTESTATIONS.get(preparedMinimumRuntime) ?? {
        root: minimumExtractDirectory.path,
        state: captureMinimumRuntimeTreeState(minimumExtractDirectory.path),
      };
      assertMinimumRuntimeTreeStateCurrent(
        minimumRuntimeAttestation.root,
        minimumRuntimeAttestation.state,
      );
    } catch (error) {
      if (error instanceof NpmIsolationError) throw error;
      fail("DUAL_ENDPOINT_CI_MINIMUM_RUNTIME", "最低 Node/npm 临时运行时准备失败。");
    }
    if (!isInside(minimumExtractDirectory.path, minimumRuntime.nodeExecutable)) {
      fail("DUAL_ENDPOINT_CI_MINIMUM_RUNTIME", "最低 Node 可执行文件逃逸临时运行时目录。");
    }

    const minimumBefore = projectInputHashes(minimumProject, workspace);
    let minimumResult;
    let minimumWorkerError = null;
    assertMinimumRuntimeTreeStateCurrent(
      minimumRuntimeAttestation.root,
      minimumRuntimeAttestation.state,
    );
    try {
      minimumResult = validateWorkerResult(await runWorker({
        nodeExecutable: minimumRuntime.nodeExecutable,
        projectRoot: minimumProject,
        role: "minimum",
      }), "minimum");
    } catch (error) {
      minimumWorkerError = normalizeEndpointFailure(error, "minimum");
    }
    assertMinimumRuntimeTreeStateCurrent(
      minimumRuntimeAttestation.root,
      minimumRuntimeAttestation.state,
    );
    if (minimumWorkerError) throw minimumWorkerError;
    const minimumAfter = projectInputHashes(minimumProject, workspace);
    if (
      minimumBefore.manifestSha256 !== minimumAfter.manifestSha256
      || minimumBefore.lockfileSha256 !== minimumAfter.lockfileSha256
    ) {
      fail("DUAL_ENDPOINT_CI_MINIMUM_DRIFT", "最低端点临时 manifest/lock 发生漂移。");
    }

    assertRootInputsCurrent(inputs);
    assertRootNodeModulesAbsent(canonicalRoot);
    endpointReceipts = [
      createEndpointReceipt("primary", primaryResult, primaryBefore, primaryAfter),
      createEndpointReceipt("minimum", minimumResult, minimumBefore, minimumAfter),
    ];
  } catch (error) {
    operationError = error;
  } finally {
    if (workspace) {
      try {
        cleanupOwnedWorkspace(workspace, {
          afterOwnershipCheck: afterCleanupOwnershipCheck,
          afterTreeSnapshot: afterCleanupTreeSnapshot,
        });
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      assertRootInputsCurrent(inputs);
      assertRootNodeModulesAbsent(canonicalRoot);
    } catch (error) {
      postCleanupError = error;
    }
    releaseRootInputs(inputs);
  }

  if (cleanupError) {
    if (operationError || postCleanupError) {
      fail(
        "DUAL_ENDPOINT_CI_CLEANUP_AFTER_FAILURE",
        "双端点执行失败后临时 workspace 无法安全清理；隔离状态已保留。",
      );
    }
    throw cleanupError;
  }
  if (postCleanupError) throw postCleanupError;
  if (operationError) throw operationError;

  const receipt = validateDualEndpointCiReceipt({
    ...DUAL_ENDPOINT_CI_RECEIPT_ENVELOPE,
    inputs: Object.fromEntries(inputs.map((input) => [input.relativePath, input.hash])),
    endpoints: endpointReceipts,
  });
  const receiptPath = persistReceipt(receipt, temporaryParent);
  return Object.freeze({ receipt, receiptPath });
}

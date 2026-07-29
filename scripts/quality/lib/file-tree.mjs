import {createHash} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {isAbsolute, relative, resolve, sep} from "node:path";

export const FILE_TREE_WIRE_MAGIC = "AXIALMUSE-FILE-TREE-V1";
export const FILE_TREE_MAX_FILES = 65_536;
export const FILE_TREE_MAX_DEPTH = 64;
export const FILE_TREE_MAX_SEGMENT_BYTES = 255;
export const FILE_TREE_MAX_PATH_BYTES = 4_096;
export const FILE_TREE_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const FILE_TREE_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;

const UNKNOWN_SOURCE_PATH = "release/unknown";
const OPERATION_WIRE_MAGIC = "AXIALMUSE-FILE-TREE-OPERATION-V1";
const READ_CHUNK_BYTES = 64 * 1024;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/u;
const CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const UTF8_DECODER = new TextDecoder("utf-8", {fatal: true});
const UTF8_ENCODER = new TextEncoder();
const VALID_CAPTURES = new WeakSet();
const ERROR_MESSAGES = Object.freeze({
  FILE_TREE_INPUT: "文件树输入不合法。",
  FILE_TREE_ROOT: "文件树根不是规范普通目录。",
  FILE_TREE_READ: "文件树无法形成稳定读取证据。",
  FILE_TREE_ENTRY: "文件树含不受支持的文件系统成员。",
  FILE_TREE_PATH: "文件树路径不符合规范 POSIX 相对路径契约。",
  FILE_TREE_PATH_COLLISION: "文件树路径发生规范化或大小写冲突。",
  FILE_TREE_LIMIT: "文件树超出受控资源上限。",
  FILE_TREE_CAPTURE: "文件树快照不属于规范实现。",
});

function isSafeSourcePath(value) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= FILE_TREE_MAX_PATH_BYTES
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

export class FileTreeError extends Error {
  constructor(code, sourcePath = UNKNOWN_SOURCE_PATH, options = {}) {
    super(ERROR_MESSAGES[code] ?? "文件树处理失败。", {cause: options.cause});
    this.name = "FileTreeError";
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
  throw new FileTreeError(code, sourcePath, {cause});
}

export function formatFileTreeError(error) {
  if (!(error instanceof FileTreeError)) {
    return "[FILE_TREE_INTERNAL] 文件树处理发生未分类错误；底层细节已抑制。";
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
    fail("FILE_TREE_INPUT", sourcePath, cause);
  }
  if (
    keys.some((key) => (
      typeof key !== "string"
      || !allowedKeys.includes(key)
      || !Object.hasOwn(descriptors[key], "value")
    ))
    || requiredKeys.some((key) => !keys.includes(key))
  ) {
    fail("FILE_TREE_INPUT", sourcePath);
  }
  return Object.freeze(Object.fromEntries(
    allowedKeys
      .filter((key) => keys.includes(key))
      .map((key) => [key, descriptors[key].value]),
  ));
}

function normalizeHooks(value, sourcePath) {
  if (value === undefined) return Object.freeze({});
  const hooks = readDataProperties(
    value,
    ["afterDirectoryRead", "afterFileRead", "beforeDirectoryRecheck"],
    [],
    sourcePath,
  );
  if (Object.values(hooks).some((hook) => typeof hook !== "function")) {
    fail("FILE_TREE_INPUT", sourcePath);
  }
  return hooks;
}

function toPosix(value) {
  return value.split(sep).join("/");
}

function encodeUtf8(value, sourcePath) {
  let bytes;
  try {
    bytes = UTF8_ENCODER.encode(value);
    if (UTF8_DECODER.decode(bytes) !== value) {
      throw new TypeError("path is not lossless UTF-8");
    }
  } catch (cause) {
    fail("FILE_TREE_PATH", sourcePath, cause);
  }
  return bytes;
}

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function decodeEntryName(bytes, sourcePath) {
  let name;
  try {
    name = UTF8_DECODER.decode(bytes);
  } catch (cause) {
    fail("FILE_TREE_PATH", sourcePath, cause);
  }
  const encoded = encodeUtf8(name, sourcePath);
  if (!sameBytes(bytes, encoded)) fail("FILE_TREE_PATH", sourcePath);
  return name;
}

function assertCanonicalSegment(name, bytes, sourcePath) {
  if (
    bytes.byteLength === 0
    || bytes.byteLength > FILE_TREE_MAX_SEGMENT_BYTES
    || name === "."
    || name === ".."
    || name.startsWith(".")
    || name.includes("/")
    || name.includes("\\")
    || CONTROL_CHARACTER_PATTERN.test(name)
    || name.normalize("NFC") !== name
  ) {
    fail("FILE_TREE_PATH", sourcePath);
  }
}

function assertCanonicalRelativePath(value, sourcePath) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.startsWith("/")
    || value.includes("\\")
    || CONTROL_CHARACTER_PATTERN.test(value)
    || value.normalize("NFC") !== value
  ) {
    fail("FILE_TREE_PATH", sourcePath);
  }
  const segments = value.split("/");
  if (
    segments.length === 0
    || segments.length > FILE_TREE_MAX_DEPTH
    || segments.some((segment) => (
      segment.length === 0
      || segment === "."
      || segment === ".."
      || segment.startsWith(".")
    ))
  ) {
    fail("FILE_TREE_PATH", sourcePath);
  }
  const pathBytes = encodeUtf8(value, sourcePath);
  if (pathBytes.byteLength > FILE_TREE_MAX_PATH_BYTES) {
    fail("FILE_TREE_LIMIT", sourcePath);
  }
  for (const segment of segments) {
    const segmentBytes = encodeUtf8(segment, sourcePath);
    assertCanonicalSegment(segment, segmentBytes, sourcePath);
  }
  return pathBytes;
}

export function compareFileTreePaths(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    fail("FILE_TREE_INPUT", UNKNOWN_SOURCE_PATH);
  }
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function identityOf(metadata) {
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

function sameIdentity(left, right) {
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

function assertDirectoryMetadata(metadata) {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new TypeError("not an ordinary directory");
  }
}

function assertFileMetadata(metadata) {
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1n
  ) {
    throw new TypeError("not a single-link regular file");
  }
}

function writeUint64(hash, value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  hash.update(bytes);
}

function writeOperationFrame(hash, label, value) {
  const labelBytes = Buffer.from(label, "utf8");
  const valueBytes = Buffer.from(value, "utf8");
  writeUint64(hash, labelBytes.byteLength);
  hash.update(labelBytes);
  writeUint64(hash, valueBytes.byteLength);
  hash.update(valueBytes);
}

function writeIdentityFrame(hash, kind, relativePath, identity) {
  writeOperationFrame(hash, "kind", kind);
  writeOperationFrame(hash, "path", relativePath);
  for (const [name, value] of Object.entries(identity)) {
    writeOperationFrame(hash, name, value.toString(10));
  }
}

function readStableFileDigest(path, sourcePath, hooks, relativePath) {
  let descriptor;
  let result;
  let operationError;
  try {
    const realPathBefore = realpathSync(path);
    if (realPathBefore !== path) {
      throw new TypeError("file path traverses a symbolic link");
    }
    const pathBefore = lstatSync(path, {bigint: true});
    assertFileMetadata(pathBefore);
    if (pathBefore.size > BigInt(FILE_TREE_MAX_FILE_BYTES)) {
      fail("FILE_TREE_LIMIT", sourcePath);
    }
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const descriptorBefore = fstatSync(descriptor, {bigint: true});
    assertFileMetadata(descriptorBefore);
    const identity = identityOf(descriptorBefore);
    if (!sameIdentity(identityOf(pathBefore), identity)) {
      throw new TypeError("file identity changed before read");
    }

    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const expectedBytes = Number(identity.size);
    let offset = 0;
    while (offset < expectedBytes) {
      const requested = Math.min(chunk.byteLength, expectedBytes - offset);
      const bytesRead = readSync(descriptor, chunk, 0, requested, offset);
      if (bytesRead <= 0) throw new TypeError("file ended during read");
      hash.update(chunk.subarray(0, bytesRead));
      chunk.fill(0, 0, bytesRead);
      offset += bytesRead;
    }
    if (readSync(descriptor, chunk, 0, 1, offset) !== 0) {
      throw new TypeError("file grew during read");
    }
    chunk.fill(0);
    hooks.afterFileRead?.(Object.freeze({relativePath}));

    const descriptorAfter = fstatSync(descriptor, {bigint: true});
    const pathAfter = lstatSync(path, {bigint: true});
    const realPathAfter = realpathSync(path);
    assertFileMetadata(descriptorAfter);
    assertFileMetadata(pathAfter);
    if (
      !sameIdentity(identity, identityOf(descriptorAfter))
      || !sameIdentity(identity, identityOf(pathAfter))
      || realPathAfter !== path
      || realPathAfter !== realPathBefore
      || offset !== expectedBytes
    ) {
      throw new TypeError("file identity changed while read");
    }
    result = Object.freeze({
      byteLength: expectedBytes,
      identity,
      sha256: hash.digest("hex"),
    });
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
  if (operationError !== undefined || closeError !== undefined || result === undefined) {
    if (operationError instanceof FileTreeError && closeError === undefined) {
      throw operationError;
    }
    const cause = operationError !== undefined && closeError !== undefined
      ? new AggregateError([operationError, closeError])
      : operationError ?? closeError;
    fail("FILE_TREE_READ", sourcePath, cause);
  }
  return result;
}

function validateRecord(record, index) {
  const sourcePath = `release/file-tree#records[${index}]`;
  const values = readDataProperties(
    record,
    ["path", "byteLength", "sha256"],
    ["path", "byteLength", "sha256"],
    sourcePath,
  );
  const pathBytes = assertCanonicalRelativePath(values.path, sourcePath);
  if (
    Number.isSafeInteger(values.byteLength)
    && values.byteLength > FILE_TREE_MAX_FILE_BYTES
  ) {
    fail("FILE_TREE_LIMIT", sourcePath);
  }
  if (
    !Number.isSafeInteger(values.byteLength)
    || values.byteLength < 0
    || values.byteLength > FILE_TREE_MAX_FILE_BYTES
    || typeof values.sha256 !== "string"
    || !HEX_64_PATTERN.test(values.sha256)
  ) {
    fail("FILE_TREE_INPUT", sourcePath);
  }
  return Object.freeze({
    path: values.path,
    pathBytes,
    byteLength: values.byteLength,
    sha256: values.sha256,
  });
}

function normalizeRecords(records) {
  if (!Array.isArray(records)) {
    fail("FILE_TREE_INPUT", "release/file-tree");
  }
  if (records.length > FILE_TREE_MAX_FILES) {
    fail("FILE_TREE_LIMIT", "release/file-tree");
  }
  const normalized = records.map(validateRecord)
    .sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
  const exactBytes = new Set();
  const folded = new Set();
  let totalBytes = 0;
  for (const record of normalized) {
    const byteKey = Buffer.from(record.path, "utf8").toString("hex");
    const foldedPath = record.path.toLowerCase();
    if (exactBytes.has(byteKey) || folded.has(foldedPath)) {
      fail("FILE_TREE_PATH_COLLISION", record.path);
    }
    exactBytes.add(byteKey);
    folded.add(foldedPath);
    totalBytes += record.byteLength;
    if (totalBytes > FILE_TREE_MAX_TOTAL_BYTES) {
      fail("FILE_TREE_LIMIT", record.path);
    }
  }
  return Object.freeze(normalized.map((record) => Object.freeze({
    path: record.path,
    byteLength: record.byteLength,
    sha256: record.sha256,
  })));
}

export function digestFileTreeRecords(records) {
  const normalized = normalizeRecords(records);
  const hash = createHash("sha256");
  hash.update(FILE_TREE_WIRE_MAGIC, "ascii");
  hash.update(Buffer.from([0]));
  for (const record of normalized) {
    const pathBytes = Buffer.from(record.path, "utf8");
    writeUint64(hash, pathBytes.byteLength);
    hash.update(pathBytes);
    writeUint64(hash, record.byteLength);
    hash.update(Buffer.from(record.sha256, "hex"));
  }
  return hash.digest("hex");
}

function readDirectoryNames(directory, sourcePath) {
  let names;
  try {
    names = readdirSync(directory, {encoding: "buffer"});
  } catch (cause) {
    fail("FILE_TREE_READ", sourcePath, cause);
  }
  return names.map((bytes) => Buffer.from(bytes))
    .sort((left, right) => Buffer.compare(left, right));
}

function sameNameList(left, right) {
  return (
    left.length === right.length
    && left.every((name, index) => sameBytes(name, right[index]))
  );
}

function diagnosticPath(rootLabel, relativePath) {
  return relativePath.length === 0
    ? rootLabel
    : `${rootLabel}/${relativePath}`;
}

function assertCanonicalRoot(root, sourcePath) {
  try {
    if (
      typeof root !== "string"
      || !isAbsolute(root)
      || resolve(root) !== root
      || realpathSync(root) !== root
    ) {
      throw new TypeError("root is not canonical");
    }
    const metadata = lstatSync(root, {bigint: true});
    assertDirectoryMetadata(metadata);
    return identityOf(metadata);
  } catch (cause) {
    fail("FILE_TREE_ROOT", sourcePath, cause);
  }
}

export function captureFileTree(options) {
  const values = readDataProperties(
    options,
    ["root", "sourcePath", "testHooks"],
    ["root", "sourcePath"],
    UNKNOWN_SOURCE_PATH,
  );
  if (!isSafeSourcePath(values.sourcePath)) {
    fail("FILE_TREE_INPUT", UNKNOWN_SOURCE_PATH);
  }
  const hooks = normalizeHooks(values.testHooks, values.sourcePath);
  const initialRootIdentity = assertCanonicalRoot(
    values.root,
    values.sourcePath,
  );
  const operationalHash = createHash("sha256");
  operationalHash.update(OPERATION_WIRE_MAGIC, "ascii");
  operationalHash.update(Buffer.from([0]));
  const records = [];
  const exactPaths = new Set();
  const foldedPaths = new Set();
  let totalBytes = 0;

  const walk = (directory, segments) => {
    const relativeDirectory = segments.join("/");
    const directorySourcePath = diagnosticPath(
      values.sourcePath,
      relativeDirectory,
    );
    let beforeIdentity;
    try {
      if (realpathSync(directory) !== directory) {
        throw new TypeError("directory path traverses a symbolic link");
      }
      const metadata = lstatSync(directory, {bigint: true});
      assertDirectoryMetadata(metadata);
      beforeIdentity = identityOf(metadata);
    } catch (cause) {
      fail("FILE_TREE_ENTRY", directorySourcePath, cause);
    }
    const namesBefore = readDirectoryNames(directory, directorySourcePath);
    hooks.afterDirectoryRead?.(Object.freeze({
      relativePath: relativeDirectory,
    }));
    for (const nameBytes of namesBefore) {
      const fallbackSourcePath = directorySourcePath;
      const name = decodeEntryName(nameBytes, fallbackSourcePath);
      const relativePath = [...segments, name].join("/");
      const sourcePath = diagnosticPath(values.sourcePath, relativePath);
      assertCanonicalSegment(name, nameBytes, sourcePath);
      if (segments.length + 1 > FILE_TREE_MAX_DEPTH) {
        fail("FILE_TREE_LIMIT", sourcePath);
      }
      const pathBytes = assertCanonicalRelativePath(relativePath, sourcePath);
      const foldedPath = relativePath.toLowerCase();
      if (exactPaths.has(relativePath) || foldedPaths.has(foldedPath)) {
        fail("FILE_TREE_PATH_COLLISION", sourcePath);
      }
      exactPaths.add(relativePath);
      foldedPaths.add(foldedPath);

      const path = resolve(directory, name);
      if (
        toPosix(relative(values.root, path)) !== relativePath
        || !path.startsWith(`${values.root}${sep}`)
      ) {
        fail("FILE_TREE_PATH", sourcePath);
      }
      let metadata;
      try {
        metadata = lstatSync(path, {bigint: true});
      } catch (cause) {
        fail("FILE_TREE_ENTRY", sourcePath, cause);
      }
      if (metadata.isSymbolicLink()) {
        fail("FILE_TREE_ENTRY", sourcePath);
      }
      if (metadata.isDirectory()) {
        walk(path, [...segments, name]);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1n) {
        fail("FILE_TREE_ENTRY", sourcePath);
      }
      if (records.length >= FILE_TREE_MAX_FILES) {
        fail("FILE_TREE_LIMIT", sourcePath);
      }
      const file = readStableFileDigest(
        path,
        sourcePath,
        hooks,
        relativePath,
      );
      totalBytes += file.byteLength;
      if (totalBytes > FILE_TREE_MAX_TOTAL_BYTES) {
        fail("FILE_TREE_LIMIT", sourcePath);
      }
      records.push(Object.freeze({
        path: relativePath,
        byteLength: file.byteLength,
        sha256: file.sha256,
      }));
      writeIdentityFrame(
        operationalHash,
        "file",
        relativePath,
        file.identity,
      );
      if (pathBytes.byteLength > FILE_TREE_MAX_PATH_BYTES) {
        fail("FILE_TREE_LIMIT", sourcePath);
      }
    }

    hooks.beforeDirectoryRecheck?.(Object.freeze({
      relativePath: relativeDirectory,
    }));
    let afterIdentity;
    let namesAfter;
    try {
      namesAfter = readDirectoryNames(directory, directorySourcePath);
      if (realpathSync(directory) !== directory) {
        throw new TypeError("directory path changed");
      }
      const metadata = lstatSync(directory, {bigint: true});
      assertDirectoryMetadata(metadata);
      afterIdentity = identityOf(metadata);
    } catch (cause) {
      if (cause instanceof FileTreeError) throw cause;
      fail("FILE_TREE_READ", directorySourcePath, cause);
    }
    if (
      !sameIdentity(beforeIdentity, afterIdentity)
      || !sameNameList(namesBefore, namesAfter)
    ) {
      fail("FILE_TREE_READ", directorySourcePath);
    }
    writeIdentityFrame(
      operationalHash,
      "directory",
      relativeDirectory,
      afterIdentity,
    );
  };

  walk(values.root, []);
  const finalRootIdentity = assertCanonicalRoot(values.root, values.sourcePath);
  if (!sameIdentity(initialRootIdentity, finalRootIdentity)) {
    fail("FILE_TREE_READ", values.sourcePath);
  }
  const normalizedRecords = normalizeRecords(records);
  const capture = Object.freeze({
    rootIdentity: finalRootIdentity,
    records: normalizedRecords,
    fileCount: normalizedRecords.length,
    totalBytes,
    treeSha256: digestFileTreeRecords(normalizedRecords),
    operationalSha256: operationalHash.digest("hex"),
  });
  VALID_CAPTURES.add(capture);
  return capture;
}

function assertCapture(value) {
  if (!isPlainRecord(value) || !VALID_CAPTURES.has(value)) {
    fail("FILE_TREE_CAPTURE", UNKNOWN_SOURCE_PATH);
  }
}

export function fileTreeContentsEqual(left, right) {
  assertCapture(left);
  assertCapture(right);
  return (
    left.treeSha256 === right.treeSha256
    && left.fileCount === right.fileCount
    && left.totalBytes === right.totalBytes
    && left.records.length === right.records.length
    && left.records.every((record, index) => {
      const other = right.records[index];
      return (
        other !== undefined
        && record.path === other.path
        && record.byteLength === other.byteLength
        && record.sha256 === other.sha256
      );
    })
  );
}

export function fileTreeOperationallyEqual(left, right) {
  assertCapture(left);
  assertCapture(right);
  return (
    fileTreeContentsEqual(left, right)
    && left.operationalSha256 === right.operationalSha256
    && sameIdentity(left.rootIdentity, right.rootIdentity)
  );
}

export function fileTreeRootIdentityEqual(left, right) {
  assertCapture(left);
  assertCapture(right);
  return (
    left.rootIdentity.device === right.rootIdentity.device
    && left.rootIdentity.inode === right.rootIdentity.inode
  );
}

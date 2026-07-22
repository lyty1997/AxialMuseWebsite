import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
  DUAL_ENDPOINT_CI_INPUT_PATHS,
  dualEndpointCiReceiptBytes,
  runDualEndpointCi,
  validateDualEndpointCiReceipt,
} from "./dual-endpoint-ci.mjs";
import { fail, NpmIsolationError } from "./errors.mjs";
import {
  finalAdmissionEvidenceSummaryBytes,
  openFinalAdmissionEvidence,
  validateFinalAdmissionEvidenceSummary,
} from "./final-admission.mjs";
import { canonicalJsonBytes } from "./spdx.mjs";
import { assertNoDuplicateJsonKeys } from "./strict-json.mjs";

const MAX_FINAL_RECEIPT_BYTES = 32 * 1024;
const RECEIPT_DIRECTORY_PREFIX = "axial-muse-final-admission-receipt-";
const PENDING_RECEIPT_NAME = "receipt.pending";
const FINAL_RECEIPT_NAME = "receipt.json";
const HEX_64 = /^[0-9a-f]{64}$/;
const FINAL_RECEIPT_KEYS = Object.freeze([
  "admissionEvidence",
  "dualEndpointReceipt",
  "dualEndpointReceiptSha256",
  "envelope",
]);
const ENVELOPE_KEYS = Object.freeze(["kind", "owner", "status", "version"]);

export const FINAL_ADMISSION_RECEIPT_ENVELOPE = Object.freeze({
  version: "0.1.0",
  kind: "axial_muse_supply_chain_final_admission_receipt",
  status: "passed",
  owner: "AxialMuseWebsite",
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
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

function cloneEnvelope() {
  return {
    version: FINAL_ADMISSION_RECEIPT_ENVELOPE.version,
    kind: FINAL_ADMISSION_RECEIPT_ENVELOPE.kind,
    status: FINAL_ADMISSION_RECEIPT_ENVELOPE.status,
    owner: FINAL_ADMISSION_RECEIPT_ENVELOPE.owner,
  };
}

function validateEnvelope(value) {
  const code = "FINAL_ADMISSION_RECEIPT_SCHEMA";
  assertExactKeys(value, ENVELOPE_KEYS, code, "$receipt.envelope");
  for (const [key, expected] of Object.entries(FINAL_ADMISSION_RECEIPT_ENVELOPE)) {
    if (value[key] !== expected) {
      fail(code, `最终准入 receipt envelope.${key} 不受支持。`);
    }
  }
  return cloneEnvelope();
}

function assertReceiptBindings(admissionEvidence, dualEndpointReceipt) {
  if (admissionEvidence.candidateReceiptSha256 !== admissionEvidence.auditReceiptSha256) {
    fail(
      "FINAL_ADMISSION_RECEIPT_BINDING",
      "最终准入 receipt 的候选与 audit 输入 receipt 不一致。",
    );
  }
  for (const path of DUAL_ENDPOINT_CI_INPUT_PATHS) {
    if (admissionEvidence.inputs[path] !== dualEndpointReceipt.inputs[path]) {
      fail(
        "FINAL_ADMISSION_RECEIPT_BINDING",
        "最终准入证据与双端点冻结安装没有绑定相同固定输入。",
      );
    }
  }
}

export function validateFinalAdmissionReceipt(value) {
  const code = "FINAL_ADMISSION_RECEIPT_SCHEMA";
  assertExactKeys(value, FINAL_RECEIPT_KEYS, code, "$receipt");
  const envelope = validateEnvelope(value.envelope);
  if (
    isPlainObject(value.admissionEvidence)
    && typeof value.admissionEvidence.candidateReceiptSha256 === "string"
    && typeof value.admissionEvidence.auditReceiptSha256 === "string"
    && value.admissionEvidence.candidateReceiptSha256
      !== value.admissionEvidence.auditReceiptSha256
  ) {
    fail(
      "FINAL_ADMISSION_RECEIPT_BINDING",
      "最终准入 receipt 的候选与 audit 输入 receipt 不一致。",
    );
  }
  const admissionEvidence = validateFinalAdmissionEvidenceSummary(value.admissionEvidence);
  const dualEndpointReceipt = validateDualEndpointCiReceipt(value.dualEndpointReceipt);
  if (!HEX_64.test(value.dualEndpointReceiptSha256 ?? "")) {
    fail(code, "最终准入 receipt 的双端点摘要必须是 lowercase SHA-256。");
  }
  const expectedDualSha256 = sha256(dualEndpointCiReceiptBytes(dualEndpointReceipt));
  if (value.dualEndpointReceiptSha256 !== expectedDualSha256) {
    fail(
      "FINAL_ADMISSION_RECEIPT_BINDING",
      "最终准入 receipt 的双端点 canonical 摘要不一致。",
    );
  }
  assertReceiptBindings(admissionEvidence, dualEndpointReceipt);
  return {
    envelope,
    admissionEvidence,
    dualEndpointReceipt,
    dualEndpointReceiptSha256: expectedDualSha256,
  };
}

export function createFinalAdmissionReceipt({
  admissionEvidence,
  dualEndpointReceipt,
  ...unknownOptions
} = {}) {
  if (Object.keys(unknownOptions).length !== 0) {
    fail("FINAL_ADMISSION_RECEIPT_SCHEMA", "最终准入 receipt 创建参数包含未知字段。");
  }
  const validatedDualReceipt = validateDualEndpointCiReceipt(dualEndpointReceipt);
  return validateFinalAdmissionReceipt({
    envelope: FINAL_ADMISSION_RECEIPT_ENVELOPE,
    admissionEvidence,
    dualEndpointReceipt: validatedDualReceipt,
    dualEndpointReceiptSha256: sha256(dualEndpointCiReceiptBytes(validatedDualReceipt)),
  });
}

function checkedCanonicalReceiptBytes(receipt) {
  const bytes = canonicalJsonBytes(validateFinalAdmissionReceipt(receipt));
  if (
    Buffer.byteLength(bytes, "utf8") > MAX_FINAL_RECEIPT_BYTES
    || new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(bytes, "utf8")) !== bytes
  ) {
    fail("FINAL_ADMISSION_RECEIPT_BYTES", "最终准入 receipt 超过 32 KiB 或 UTF-8 非法。");
  }
  return bytes;
}

export function renderFinalAdmissionReceipt(receipt) {
  return checkedCanonicalReceiptBytes(receipt);
}

function decodeReceiptInput(input) {
  let bytes;
  if (typeof input === "string") {
    bytes = Buffer.from(input, "utf8");
  } else if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    bytes = Buffer.from(input);
  } else {
    fail("FINAL_ADMISSION_RECEIPT_BYTES", "最终准入 receipt 必须是 UTF-8 字节。");
  }
  if (bytes.length === 0 || bytes.length > MAX_FINAL_RECEIPT_BYTES) {
    bytes.fill(0);
    fail("FINAL_ADMISSION_RECEIPT_BYTES", "最终准入 receipt 字节为空或超过 32 KiB。");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    bytes.fill(0);
    fail("FINAL_ADMISSION_RECEIPT_BYTES", "最终准入 receipt 不是合法 UTF-8。");
  }
  if (typeof input === "string" && text !== input) {
    bytes.fill(0);
    fail("FINAL_ADMISSION_RECEIPT_BYTES", "最终准入 receipt 字符串不是稳定 UTF-8。");
  }
  bytes.fill(0);
  return text;
}

export function parseFinalAdmissionReceipt(input) {
  const text = decodeReceiptInput(input);
  assertNoDuplicateJsonKeys(text, {
    duplicateCode: "FINAL_ADMISSION_RECEIPT_BYTES",
    invalidCode: "FINAL_ADMISSION_RECEIPT_BYTES",
    label: "最终准入 receipt",
  });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("FINAL_ADMISSION_RECEIPT_BYTES", "最终准入 receipt 不是合法 JSON。");
  }
  const receipt = validateFinalAdmissionReceipt(parsed);
  if (renderFinalAdmissionReceipt(receipt) !== text) {
    fail("FINAL_ADMISSION_RECEIPT_BYTES", "最终准入 receipt 不是 canonical JSON 字节。");
  }
  return receipt;
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function ownerIsCurrent(stat) {
  return typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid());
}

function directoryIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    modeType: stat.mode & 0o170000n,
    mode: stat.mode & 0o777n,
    nlink: stat.nlink,
    uid: stat.uid,
  };
}

function fileIdentity(stat) {
  return {
    ...directoryIdentity(stat),
    size: stat.size,
    ctimeNs: stat.ctimeNs,
    mtimeNs: stat.mtimeNs,
  };
}

function sameIdentity(left, right) {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length
    && leftKeys.every((key) => left[key] === right[key]);
}

function sameOwnedInode(stat, identity) {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && (stat.mode & 0o170000n) === identity.modeType
    && (stat.mode & 0o777n) === 0o600n
    && stat.dev === identity.dev
    && stat.ino === identity.ino
    && stat.uid === identity.uid
    && ownerIsCurrent(stat);
}

function assertPrivateDirectoryStat(stat, code) {
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777n) !== 0o700n
    || !ownerIsCurrent(stat)
  ) {
    fail(code, "最终准入 receipt 目录类型、权限或所有者不受控。");
  }
}

function closeQuietly(descriptor) {
  if (descriptor === null || descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    // 清理阶段统一由所有权复核结果决定是否可删除路径。
  }
}

function fsyncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(descriptor);
  } finally {
    closeQuietly(descriptor);
  }
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail("FINAL_ADMISSION_RECEIPT_CLEANUP_UNCERTAIN", "最终准入 receipt 路径状态不可读。");
  }
}

function resolveTemporaryParent(temporaryParent) {
  if (
    typeof temporaryParent !== "string"
    || !isAbsolute(temporaryParent)
    || resolve(temporaryParent) !== temporaryParent
  ) {
    fail("FINAL_ADMISSION_RECEIPT_TEMP", "最终准入 receipt 临时父目录必须是绝对规范路径。");
  }
  let canonicalTmp;
  let parent;
  let stat;
  try {
    canonicalTmp = realpathSync("/tmp");
    parent = realpathSync(temporaryParent);
    stat = lstatSync(temporaryParent, { bigint: true });
  } catch {
    fail("FINAL_ADMISSION_RECEIPT_TEMP", "最终准入 receipt 临时父目录不可用。");
  }
  if (
    parent !== temporaryParent
    || !isInside(canonicalTmp, parent)
    || !stat.isDirectory()
    || stat.isSymbolicLink()
  ) {
    fail("FINAL_ADMISSION_RECEIPT_TEMP", "最终准入 receipt 临时父目录不受控。");
  }
  return parent;
}

function assertDirectoryCurrent(state, expectedEntries, code) {
  let descriptorStat;
  let pathStat;
  let entries;
  try {
    descriptorStat = fstatSync(state.directoryDescriptor, { bigint: true });
    pathStat = lstatSync(state.directoryPath, { bigint: true });
    entries = readdirSync(state.directoryPath).sort(compareBytes);
  } catch {
    fail(code, "最终准入 receipt 目录身份不可复核。");
  }
  assertPrivateDirectoryStat(descriptorStat, code);
  assertPrivateDirectoryStat(pathStat, code);
  if (
    !sameIdentity(directoryIdentity(descriptorStat), state.directoryIdentity)
    || !sameIdentity(directoryIdentity(pathStat), state.directoryIdentity)
    || entries.length !== expectedEntries.length
    || entries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    fail(code, "最终准入 receipt 目录身份或精确成员发生漂移。");
  }
}

function readDescriptorBytes(descriptor, size, code) {
  if (size < 1n || size > BigInt(MAX_FINAL_RECEIPT_BYTES)) {
    fail(code, "最终准入 receipt 持有字节为空或超限。");
  }
  const bytes = Buffer.alloc(Number(size));
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail(code, "最终准入 receipt 持有字节读取不完整。");
      offset += count;
    }
    return bytes;
  } catch (error) {
    bytes.fill(0);
    if (error instanceof NpmIsolationError) throw error;
    fail(code, "最终准入 receipt 持有字节不可读。");
  }
}

function refreshFileIdentity(state, expectedLinkCount, code) {
  const file = state.file;
  let descriptorStat;
  const pathStats = [];
  try {
    descriptorStat = fstatSync(file.descriptor, { bigint: true });
    for (const path of file.paths) pathStats.push(lstatSync(path, { bigint: true }));
  } catch {
    fail(code, "最终准入 receipt 文件身份不可复核。");
  }
  if (
    file.paths.length !== expectedLinkCount
    || !sameOwnedInode(descriptorStat, file.baseIdentity)
    || descriptorStat.nlink !== BigInt(expectedLinkCount)
    || descriptorStat.size !== BigInt(file.bytes.length)
    || pathStats.some((stat) => (
      !sameOwnedInode(stat, file.baseIdentity)
      || !sameIdentity(fileIdentity(stat), fileIdentity(descriptorStat))
    ))
  ) {
    fail(code, "最终准入 receipt 文件已被替换、链接或改变。");
  }
  file.identity = fileIdentity(descriptorStat);
}

function assertFileCurrent(state, code) {
  const file = state.file;
  if (!file || !Buffer.isBuffer(file.bytes) || file.bytes.length === 0) {
    fail(code, "最终准入 receipt 文件尚未形成可复核快照。");
  }
  refreshFileIdentity(state, file.paths.length, code);
  const held = readDescriptorBytes(file.descriptor, BigInt(file.bytes.length), code);
  try {
    if (!held.equals(file.bytes)) {
      fail(code, "最终准入 receipt 持有字节发生漂移。");
    }
    const finalStat = fstatSync(file.descriptor, { bigint: true });
    if (!sameIdentity(fileIdentity(finalStat), file.identity)) {
      fail(code, "最终准入 receipt 在复核期间发生漂移。");
    }
  } finally {
    held.fill(0);
  }
}

function assertWorkspaceCurrent(state, code) {
  const entries = state.file.paths.map((path) => path.slice(state.directoryPath.length + 1))
    .sort(compareBytes);
  assertDirectoryCurrent(state, entries, code);
  assertFileCurrent(state, code);
}

function createReceiptWorkspace(temporaryParent) {
  const parent = resolveTemporaryParent(temporaryParent);
  let directoryPath;
  let directoryDescriptor;
  let initialIdentity;
  try {
    directoryPath = mkdtempSync(join(parent, RECEIPT_DIRECTORY_PREFIX));
    initialIdentity = directoryIdentity(lstatSync(directoryPath, { bigint: true }));
    chmodSync(directoryPath, 0o700);
    const pathStat = lstatSync(directoryPath, { bigint: true });
    initialIdentity = directoryIdentity(pathStat);
    assertPrivateDirectoryStat(pathStat, "FINAL_ADMISSION_RECEIPT_WRITE");
    directoryDescriptor = openSync(
      directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const descriptorStat = fstatSync(directoryDescriptor, { bigint: true });
    if (!sameIdentity(directoryIdentity(descriptorStat), initialIdentity)) {
      fail("FINAL_ADMISSION_RECEIPT_WRITE", "最终准入 receipt 目录在创建后被替换。");
    }
    fsyncDirectory(parent);
    return {
      committed: false,
      directoryDescriptor,
      directoryIdentity: initialIdentity,
      directoryPath,
      file: null,
      parent,
      released: false,
    };
  } catch (error) {
    closeQuietly(directoryDescriptor);
    if (directoryPath && !initialIdentity) {
      fail(
        "FINAL_ADMISSION_RECEIPT_CLEANUP_UNCERTAIN",
        "最终准入 receipt 目录已创建但无法取得可清理身份。",
      );
    }
    if (directoryPath && initialIdentity) {
      try {
        const stat = lstatSync(directoryPath, { bigint: true });
        if (
          sameIdentity(directoryIdentity(stat), initialIdentity)
          && readdirSync(directoryPath).length === 0
        ) {
          rmdirSync(directoryPath);
          fsyncDirectory(parent);
        } else {
          fail(
            "FINAL_ADMISSION_RECEIPT_CLEANUP_UNCERTAIN",
            "最终准入 receipt 目录创建失败且残留身份不确定。",
          );
        }
      } catch (cleanupError) {
        if (
          cleanupError instanceof NpmIsolationError
          && cleanupError.code === "FINAL_ADMISSION_RECEIPT_CLEANUP_UNCERTAIN"
        ) {
          throw cleanupError;
        }
        fail(
          "FINAL_ADMISSION_RECEIPT_CLEANUP_UNCERTAIN",
          "最终准入 receipt 目录创建失败且无法安全清理。",
        );
      }
    }
    if (error instanceof NpmIsolationError) throw error;
    fail("FINAL_ADMISSION_RECEIPT_WRITE", "最终准入 receipt 目录无法安全创建。");
  }
}

function cleanupReceiptWorkspace(state) {
  if (!state || state.released) return;
  const code = "FINAL_ADMISSION_RECEIPT_CLEANUP_UNCERTAIN";
  try {
    const expectedEntries = state.file === null
      ? []
      : state.file.paths.map((path) => path.slice(state.directoryPath.length + 1))
        .sort(compareBytes);
    assertDirectoryCurrent(state, expectedEntries, code);
    if (state.file !== null) {
      const descriptorStat = fstatSync(state.file.descriptor, { bigint: true });
      if (
        state.file.paths.length < 1
        || !sameOwnedInode(descriptorStat, state.file.baseIdentity)
        || descriptorStat.nlink !== BigInt(state.file.paths.length)
      ) {
        fail(code, "最终准入 receipt 文件不再属于本任务。");
      }
      for (const path of state.file.paths) {
        const pathStat = lstatSync(path, { bigint: true });
        if (!sameIdentity(fileIdentity(pathStat), fileIdentity(descriptorStat))) {
          fail(code, "最终准入 receipt 路径已被外部对象替换。");
        }
      }
      for (const path of [...state.file.paths].reverse()) {
        unlinkSync(path);
        state.file.paths = state.file.paths.filter((candidate) => candidate !== path);
      }
      const unlinkedStat = fstatSync(state.file.descriptor, { bigint: true });
      if (!sameOwnedInode(unlinkedStat, state.file.baseIdentity) || unlinkedStat.nlink !== 0n) {
        fail(code, "最终准入 receipt 文件摘除后所有权不确定。");
      }
      closeSync(state.file.descriptor);
      state.file.descriptor = null;
      state.file.bytes.fill(0);
    }
    assertDirectoryCurrent(state, [], code);
    closeSync(state.directoryDescriptor);
    state.directoryDescriptor = null;
    rmdirSync(state.directoryPath);
    fsyncDirectory(state.parent);
    if (pathExists(state.directoryPath)) {
      fail(code, "最终准入 receipt 目录清理后被外部对象占用。");
    }
    state.released = true;
  } catch (error) {
    closeQuietly(state.file?.descriptor);
    if (state.file) {
      state.file.descriptor = null;
      if (Buffer.isBuffer(state.file.bytes)) state.file.bytes.fill(0);
    }
    closeQuietly(state.directoryDescriptor);
    state.directoryDescriptor = null;
    if (error instanceof NpmIsolationError && error.code === code) throw error;
    fail(code, "最终准入 receipt 失败残留无法在所有权证明下安全清理。");
  }
}

function stageFinalAdmissionReceipt(receipt, {
  syncFile = fsyncSync,
  temporaryParent = "/tmp",
} = {}) {
  if (typeof syncFile !== "function") {
    fail("FINAL_ADMISSION_OPTIONS", "最终准入 receipt syncFile 测试依赖不合法。");
  }
  const text = renderFinalAdmissionReceipt(receipt);
  const bytes = Buffer.from(text, "utf8");
  let state;
  try {
    state = createReceiptWorkspace(temporaryParent);
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
  const pendingPath = join(state.directoryPath, PENDING_RECEIPT_NAME);
  let descriptor;
  try {
    descriptor = openSync(
      pendingPath,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_RDWR
        | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    const initialStat = fstatSync(descriptor, { bigint: true });
    if (
      !initialStat.isFile()
      || initialStat.isSymbolicLink()
      || initialStat.nlink !== 1n
      || (initialStat.mode & 0o777n) !== 0o600n
      || !ownerIsCurrent(initialStat)
    ) {
      fail("FINAL_ADMISSION_RECEIPT_WRITE", "最终准入 receipt pending 文件不受控。");
    }
    state.file = {
      baseIdentity: directoryIdentity(initialStat),
      bytes,
      descriptor,
      identity: fileIdentity(initialStat),
      paths: [pendingPath],
    };
    descriptor = null;
    writeFileSync(state.file.descriptor, bytes);
    refreshFileIdentity(state, 1, "FINAL_ADMISSION_RECEIPT_WRITE");
    syncFile(state.file.descriptor);
    fsyncDirectory(state.directoryPath);
    assertWorkspaceCurrent(state, "FINAL_ADMISSION_RECEIPT_WRITE");
    const persisted = readDescriptorBytes(
      state.file.descriptor,
      BigInt(state.file.bytes.length),
      "FINAL_ADMISSION_RECEIPT_WRITE",
    );
    try {
      const parsed = parseFinalAdmissionReceipt(persisted);
      if (renderFinalAdmissionReceipt(parsed) !== text) {
        fail("FINAL_ADMISSION_RECEIPT_WRITE", "最终准入 receipt pending 字节复核失败。");
      }
    } finally {
      persisted.fill(0);
    }
    return state;
  } catch (error) {
    closeQuietly(descriptor);
    try {
      cleanupReceiptWorkspace(state);
    } catch (cleanupError) {
      bytes.fill(0);
      throw cleanupError;
    }
    bytes.fill(0);
    if (error instanceof NpmIsolationError) throw error;
    fail("FINAL_ADMISSION_RECEIPT_WRITE", "最终准入 receipt 无法安全持久化。");
  }
}

function publishStagedReceipt(state) {
  const code = "FINAL_ADMISSION_RECEIPT_WRITE";
  const pendingPath = join(state.directoryPath, PENDING_RECEIPT_NAME);
  const finalPath = join(state.directoryPath, FINAL_RECEIPT_NAME);
  assertWorkspaceCurrent(state, code);
  try {
    linkSync(pendingPath, finalPath);
    state.file.paths.push(finalPath);
    refreshFileIdentity(state, 2, code);
    fsyncDirectory(state.directoryPath);
    assertWorkspaceCurrent(state, code);
    unlinkSync(pendingPath);
    state.file.paths = [finalPath];
    refreshFileIdentity(state, 1, code);
    state.committed = true;
    fsyncDirectory(state.directoryPath);
    fsyncDirectory(state.parent);
    assertWorkspaceCurrent(state, code);
    return finalPath;
  } catch (error) {
    if (error instanceof NpmIsolationError) throw error;
    fail(code, "最终准入 receipt 无法以 no-replace 语义发布。");
  }
}

function releaseCommittedReceipt(state) {
  assertWorkspaceCurrent(state, "FINAL_ADMISSION_RECEIPT_WRITE");
  closeSync(state.file.descriptor);
  state.file.descriptor = null;
  state.file.bytes.fill(0);
  closeSync(state.directoryDescriptor);
  state.directoryDescriptor = null;
  state.released = true;
}

function canonicalRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root) {
    fail("FINAL_ADMISSION_ROOT", "最终准入编排仓库根目录必须是绝对规范路径。");
  }
  let canonical;
  try {
    canonical = realpathSync(root);
  } catch {
    fail("FINAL_ADMISSION_ROOT", "最终准入编排仓库根目录不可用。");
  }
  if (canonical !== root) {
    fail("FINAL_ADMISSION_ROOT", "最终准入编排仓库根目录不是规范真实路径。");
  }
  return canonical;
}

function assertEvidenceInterface(evidence) {
  if (
    !isPlainObject(evidence)
    || typeof evidence.assertCurrent !== "function"
    || typeof evidence.close !== "function"
    || !Object.hasOwn(evidence, "summary")
  ) {
    fail("FINAL_ADMISSION_ORCHESTRATION", "最终准入证据句柄接口不合法。");
  }
}

function assertEvidenceCurrent(evidence, expectedBytes = null) {
  const returned = evidence.assertCurrent();
  const summary = validateFinalAdmissionEvidenceSummary(returned);
  const currentBytes = finalAdmissionEvidenceSummaryBytes(summary);
  const heldBytes = finalAdmissionEvidenceSummaryBytes(
    validateFinalAdmissionEvidenceSummary(evidence.summary),
  );
  if (currentBytes !== heldBytes || (expectedBytes !== null && currentBytes !== expectedBytes)) {
    fail("FINAL_ADMISSION_EVIDENCE_DRIFT", "最终准入证据摘要在编排期间发生漂移。");
  }
  return Object.freeze({ bytes: currentBytes, summary });
}

function validateDualResult(result) {
  if (
    !isPlainObject(result)
    || !Object.hasOwn(result, "receipt")
    || typeof result.receiptPath !== "string"
    || !isAbsolute(result.receiptPath)
    || resolve(result.receiptPath) !== result.receiptPath
  ) {
    fail("FINAL_ADMISSION_DUAL_RESULT", "双端点冻结安装结果接口不合法。");
  }
  return Object.freeze({
    receipt: validateDualEndpointCiReceipt(result.receipt),
    receiptPath: result.receiptPath,
  });
}

function normalizeOrchestrationError(error) {
  if (error instanceof NpmIsolationError) return error;
  return new NpmIsolationError(
    "FINAL_ADMISSION_ORCHESTRATION",
    "最终供应链准入编排失败；内部细节已抑制。",
  );
}

export async function runFinalSupplyChainAdmission({
  root,
  candidateReportPath,
  candidateReceiptPath,
  auditRawPath,
  auditReceiptPath,
  finalDecisionPath,
  temporaryParent = "/tmp",
  openEvidence = openFinalAdmissionEvidence,
  runDual = runDualEndpointCi,
  syncFile = fsyncSync,
  afterReceiptStaged = null,
  beforeReceiptPublish = null,
  ...unknownOptions
} = {}) {
  if (
    Object.keys(unknownOptions).length !== 0
    || typeof openEvidence !== "function"
    || typeof runDual !== "function"
    || typeof syncFile !== "function"
    || (afterReceiptStaged !== null && typeof afterReceiptStaged !== "function")
    || (beforeReceiptPublish !== null && typeof beforeReceiptPublish !== "function")
  ) {
    fail("FINAL_ADMISSION_OPTIONS", "最终供应链准入编排选项不合法。");
  }
  const canonicalProjectRoot = canonicalRoot(root);
  let evidence = null;
  let staged = null;
  let result = null;
  let failure = null;
  try {
    evidence = openEvidence({
      root: canonicalProjectRoot,
      candidateReportPath,
      candidateReceiptPath,
      auditRawPath,
      auditReceiptPath,
      finalDecisionPath,
    });
    assertEvidenceInterface(evidence);
    const initialEvidence = assertEvidenceCurrent(evidence);
    const dualResult = validateDualResult(await runDual({
      root: canonicalProjectRoot,
      temporaryParent,
    }));
    const receipt = createFinalAdmissionReceipt({
      admissionEvidence: initialEvidence.summary,
      dualEndpointReceipt: dualResult.receipt,
    });
    assertEvidenceCurrent(evidence, initialEvidence.bytes);
    staged = stageFinalAdmissionReceipt(receipt, { syncFile, temporaryParent });
    if (afterReceiptStaged) afterReceiptStaged(Object.freeze({
      directoryPath: staged.directoryPath,
      pendingPath: staged.file.paths[0],
    }));
    if (beforeReceiptPublish) beforeReceiptPublish(Object.freeze({
      directoryPath: staged.directoryPath,
      finalPath: join(staged.directoryPath, FINAL_RECEIPT_NAME),
      pendingPath: staged.file.paths[0],
    }));
    assertWorkspaceCurrent(staged, "FINAL_ADMISSION_RECEIPT_WRITE");
    assertEvidenceCurrent(evidence, initialEvidence.bytes);
    const receiptPath = publishStagedReceipt(staged);
    result = Object.freeze({
      dualEndpointReceiptPath: dualResult.receiptPath,
      receipt,
      receiptPath,
    });
  } catch (error) {
    failure = normalizeOrchestrationError(error);
  } finally {
    if (evidence !== null) {
      try {
        evidence.close();
      } catch (error) {
        if (failure === null) {
          failure = new NpmIsolationError(
            "FINAL_ADMISSION_EVIDENCE_CLOSE",
            "最终准入证据句柄无法完整关闭。",
          );
        }
      }
    }
  }

  if (failure !== null) {
    if (staged !== null) {
      try {
        cleanupReceiptWorkspace(staged);
      } catch (cleanupError) {
        throw cleanupError;
      }
    }
    throw failure;
  }

  try {
    releaseCommittedReceipt(staged);
  } catch (error) {
    try {
      cleanupReceiptWorkspace(staged);
    } catch (cleanupError) {
      throw cleanupError;
    }
    throw normalizeOrchestrationError(error);
  }
  return result;
}

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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
  hashProjectFile,
  readAndValidateLockfile,
} from "./lockfile.mjs";
import { readAndValidateDependencyLicenseEvidence } from "./license-evidence.mjs";
import { readAndValidateDependencyPolicy } from "./policy.mjs";
import { canonicalJsonBytes } from "./spdx.mjs";
import { assertNoDuplicateJsonKeys } from "./strict-json.mjs";

export const SUPPLY_CHAIN_INPUT_PATHS = Object.freeze([
  ".npmrc",
  ".nvmrc",
  "docs/contracts/dependency-license-evidence.json",
  "docs/contracts/dependency-policy.json",
  "package-lock.json",
  "package.json",
]);

export const SUPPLY_CHAIN_INPUT_RECEIPT_ENVELOPE = Object.freeze({
  version: "0.1.0",
  kind: "axial_muse_supply_chain_input_receipt",
  status: "candidate-input",
  owner: "AxialMuseWebsite",
});

const RECEIPT_KEYS = Object.freeze([
  "inputs",
  "kind",
  "owner",
  "runtime",
  "status",
  "version",
]);
const RUNTIME_KEYS = Object.freeze(["nodeVersion", "npmVersion", "role"]);
const HEX_64 = /^[0-9a-f]{64}$/;
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const MAX_RECEIPT_BYTES = 32 * 1024;

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, pointer, code) {
  if (!isPlainObject(value)) {
    fail(code, `${pointer} 必须是 object。`);
  }
  const actual = Object.keys(value).sort(compareBytes);
  const wanted = [...expected].sort(compareBytes);
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    fail(code, `${pointer} 字段集合不符合候选图 receipt schema。`);
  }
}

function cloneReceipt(value) {
  return {
    version: value.version,
    kind: value.kind,
    status: value.status,
    owner: value.owner,
    inputs: Object.fromEntries(SUPPLY_CHAIN_INPUT_PATHS.map((path) => [
      path,
      value.inputs[path],
    ])),
    runtime: {
      role: value.runtime.role,
      nodeVersion: value.runtime.nodeVersion,
      npmVersion: value.runtime.npmVersion,
    },
  };
}

export function validateSupplyChainInputReceipt(
  value,
  { code = "SUPPLY_CHAIN_RECEIPT_SCHEMA" } = {},
) {
  assertExactKeys(value, RECEIPT_KEYS, "$receipt", code);
  for (const [key, expected] of Object.entries(SUPPLY_CHAIN_INPUT_RECEIPT_ENVELOPE)) {
    if (value[key] !== expected) {
      fail(code, `候选图 receipt ${key} 不受支持。`);
    }
  }
  assertExactKeys(value.inputs, SUPPLY_CHAIN_INPUT_PATHS, "$receipt.inputs", code);
  for (const path of SUPPLY_CHAIN_INPUT_PATHS) {
    if (!HEX_64.test(value.inputs[path] ?? "")) {
      fail(code, `$receipt.inputs.${path} 必须是 lowercase SHA-256。`);
    }
  }
  assertExactKeys(value.runtime, RUNTIME_KEYS, "$receipt.runtime", code);
  if (
    (value.runtime.role !== "primary" && value.runtime.role !== "minimum")
    || !EXACT_VERSION.test(value.runtime.nodeVersion ?? "")
    || !EXACT_VERSION.test(value.runtime.npmVersion ?? "")
  ) {
    fail(code, "候选图 receipt runtime 必须包含精确角色与 Node/npm 版本。");
  }
  return cloneReceipt(value);
}

export function createSupplyChainInputReceipt({ inputs, runtime } = {}) {
  return validateSupplyChainInputReceipt({
    ...SUPPLY_CHAIN_INPUT_RECEIPT_ENVELOPE,
    inputs,
    runtime,
  });
}

export function captureSupplyChainInputHashes(root) {
  return Object.fromEntries(SUPPLY_CHAIN_INPUT_PATHS.map((relativePath) => [
    relativePath,
    hashProjectFile(root, relativePath),
  ]));
}

export function supplyChainInputReceiptBytes(receipt) {
  return canonicalJsonBytes(validateSupplyChainInputReceipt(receipt));
}

export function supplyChainInputReceiptSha256(receipt) {
  return createHash("sha256")
    .update(supplyChainInputReceiptBytes(receipt), "utf8")
    .digest("hex");
}

export function assertSupplyChainInputReceiptCurrent({
  root,
  receipt,
  npmVersionsByRole = NPM_VERSIONS_BY_ROLE,
  requiredRole = null,
  code = "SUPPLY_CHAIN_RECEIPT_DRIFT",
  ...unknownOptions
} = {}) {
  if (Object.keys(unknownOptions).length !== 0) {
    fail(code, "候选图 receipt 当前状态复核包含未知选项。");
  }
  let expected;
  let actual;
  try {
    expected = validateSupplyChainInputReceipt(receipt, { code });
    actual = captureCurrentSupplyChainInputReceiptUnchecked({
      root,
      npmVersionsByRole,
      nodeVersion: process.versions.node,
      requiredRole,
      code,
    });
  } catch (error) {
    if (error instanceof NpmIsolationError && error.code === code) throw error;
    fail(code, "候选图 receipt 对应的固定输入不可读或发生漂移。");
  }
  try {
    if (supplyChainInputReceiptBytes(actual) !== supplyChainInputReceiptBytes(expected)) {
      fail(code, "候选图 receipt 与当前固定输入或运行时不一致。");
    }
  } catch (error) {
    if (error instanceof NpmIsolationError && error.code === code) throw error;
    fail(code, "候选图 receipt 与当前固定输入或运行时不一致。");
  }
  return expected;
}

function captureCurrentSupplyChainInputReceiptUnchecked({
  root,
  npmVersionsByRole = NPM_VERSIONS_BY_ROLE,
  nodeVersion = process.versions.node,
  requiredRole = "primary",
  code = "SUPPLY_CHAIN_RECEIPT_DRIFT",
} = {}) {
  if (typeof root !== "string" || root === "") {
    fail(code, "候选图 receipt 仓库根目录不合法。");
  }
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(resolve(root));
  } catch {
    fail(code, "候选图 receipt 仓库根目录不可用。");
  }
  const inputs = captureSupplyChainInputHashes(canonicalRoot);
  validateProjectNpmrc(canonicalRoot);
  const manifest = readAndValidateManifest(canonicalRoot);
  assertNoCompetingPackageManagerInputs(canonicalRoot);
  const npmRuntime = deriveNpmCli(process.execPath);
  if (nodeVersion !== process.versions.node) {
    fail("NPM_RUNTIME_PROCESS", "声明的 Node 版本与当前进程不一致。");
  }
  const runtime = validateRuntimeContract({
    root: canonicalRoot,
    nodeVersion,
    npmVersion: npmRuntime.npmVersion,
    manifest,
    npmVersionsByRole,
  });
  if (requiredRole !== null && runtime.role !== requiredRole) {
    fail("SUPPLY_CHAIN_RECEIPT_RUNTIME", "候选图 receipt 不属于要求的运行时角色。");
  }
  readAndValidateLockfile(canonicalRoot, manifest);
  readAndValidateDependencyLicenseEvidence(canonicalRoot);
  readAndValidateDependencyPolicy(canonicalRoot);
  const receipt = createSupplyChainInputReceipt({ inputs, runtime });
  const finalInputs = captureSupplyChainInputHashes(canonicalRoot);
  if (canonicalJsonBytes(inputs) !== canonicalJsonBytes(finalInputs)) {
    fail(code, "候选图 receipt 固定输入在取证期间发生漂移。");
  }
  return receipt;
}

export function captureCurrentSupplyChainInputReceipt(options = {}) {
  const receipt = captureCurrentSupplyChainInputReceiptUnchecked({
    ...options,
    code: "SUPPLY_CHAIN_RECEIPT_DRIFT",
  });
  return assertSupplyChainInputReceiptCurrent({
    root: options.root,
    receipt,
    npmVersionsByRole: options.npmVersionsByRole,
    requiredRole: options.requiredRole ?? "primary",
  });
}

export function parseSupplyChainInputReceipt(text) {
  if (
    typeof text !== "string"
    || text === ""
    || Buffer.byteLength(text, "utf8") > MAX_RECEIPT_BYTES
  ) {
    fail("SUPPLY_CHAIN_RECEIPT_BYTES", "候选图 receipt 字节为空或超限。");
  }
  assertNoDuplicateJsonKeys(text, {
    duplicateCode: "SUPPLY_CHAIN_RECEIPT_BYTES",
    invalidCode: "SUPPLY_CHAIN_RECEIPT_BYTES",
    label: "候选图 receipt",
  });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("SUPPLY_CHAIN_RECEIPT_BYTES", "候选图 receipt 不是合法 JSON。");
  }
  const receipt = validateSupplyChainInputReceipt(parsed, {
    code: "SUPPLY_CHAIN_RECEIPT_SCHEMA",
  });
  if (canonicalJsonBytes(receipt) !== text) {
    fail("SUPPLY_CHAIN_RECEIPT_BYTES", "候选图 receipt 不是 canonical JSON 字节。");
  }
  return receipt;
}

function pathIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & 0o177777,
    nlink: stat.nlink,
    size: stat.size,
    uid: stat.uid,
  };
}

function identitiesEqual(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function readAndVerifyRestrictedSupplyChainInputReceipt({
  path,
  root,
  npmVersionsByRole = NPM_VERSIONS_BY_ROLE,
  nodeVersion = process.versions.node,
  requiredRole = "primary",
} = {}) {
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) {
    fail("SUPPLY_CHAIN_RECEIPT_FILE", "受限候选图 receipt 路径必须是绝对路径。");
  }
  let canonicalTmp;
  let canonicalPath;
  let directoryStat;
  let pathStat;
  try {
    pathStat = lstatSync(path);
    canonicalTmp = realpathSync("/tmp");
    canonicalPath = realpathSync(path);
    directoryStat = lstatSync(dirname(canonicalPath));
  } catch {
    fail("SUPPLY_CHAIN_RECEIPT_FILE", "受限候选图 receipt 路径不可读。");
  }
  if (
    pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || pathStat.nlink !== 1
    || (pathStat.mode & 0o777) !== 0o600
    || directoryStat.isSymbolicLink()
    || !directoryStat.isDirectory()
    || (directoryStat.mode & 0o777) !== 0o700
    || !isInside(canonicalTmp, canonicalPath)
    || (typeof process.getuid === "function"
      && (pathStat.uid !== process.getuid() || directoryStat.uid !== process.getuid()))
  ) {
    fail("SUPPLY_CHAIN_RECEIPT_FILE", "受限候选图 receipt 类型、权限或所有者不受控。");
  }

  let descriptor;
  let text;
  try {
    descriptor = openSync(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = pathIdentity(fstatSync(descriptor));
    if (!identitiesEqual(openedBefore, pathIdentity(pathStat))) {
      fail("SUPPLY_CHAIN_RECEIPT_FILE", "受限候选图 receipt 在打开期间被替换。");
    }
    if (openedBefore.size === 0 || openedBefore.size > MAX_RECEIPT_BYTES) {
      fail("SUPPLY_CHAIN_RECEIPT_FILE", "受限候选图 receipt 文件为空或超过 32 KiB 上限。");
    }
    text = readFileSync(descriptor, "utf8");
    const openedAfter = pathIdentity(fstatSync(descriptor));
    const currentPath = pathIdentity(lstatSync(canonicalPath));
    if (
      !identitiesEqual(openedBefore, openedAfter)
      || !identitiesEqual(openedAfter, currentPath)
    ) {
      fail("SUPPLY_CHAIN_RECEIPT_FILE", "受限候选图 receipt 在读取期间发生变化。");
    }
  } catch (error) {
    if (error instanceof NpmIsolationError) throw error;
    fail("SUPPLY_CHAIN_RECEIPT_FILE", "受限候选图 receipt 无法安全读取。");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  const receipt = parseSupplyChainInputReceipt(text);
  const current = captureCurrentSupplyChainInputReceipt({
    root,
    npmVersionsByRole,
    nodeVersion,
    requiredRole,
  });
  if (supplyChainInputReceiptBytes(receipt) !== supplyChainInputReceiptBytes(current)) {
    fail("SUPPLY_CHAIN_RECEIPT_DRIFT", "受限候选图 receipt 与当前候选图输入不一致。");
  }
  return Object.freeze({
    path: canonicalPath,
    receipt,
    receiptSha256: supplyChainInputReceiptSha256(receipt),
  });
}

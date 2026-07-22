import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { parseNpmAuditReport } from "./audit.mjs";
import { checkSupplyChain } from "./check.mjs";
import { readAndValidateManifest } from "./config.mjs";
import { NPM_VERSIONS_BY_ROLE } from "./contracts.mjs";
import { NpmIsolationError, fail } from "./errors.mjs";
import {
  assertSupplyChainInputReceiptCurrent,
  parseSupplyChainInputReceipt,
  SUPPLY_CHAIN_INPUT_PATHS,
  supplyChainInputReceiptBytes,
} from "./input-receipt.mjs";
import { collectLockedPackages, readAndValidateLockfile } from "./lockfile.mjs";
import {
  classifyExactPackageLicenseForReport,
  readAndValidateDependencyLicenseEvidence,
  validateDependencyLicenseEvidenceGraph,
  validatePackageLicenseEvidence,
} from "./license-evidence.mjs";
import { packageEvidenceSha256FromTarballInspection } from "./notices.mjs";
import { readAndValidateDependencyPolicy } from "./policy.mjs";
import { canonicalJsonBytes } from "./spdx.mjs";
import { assertNoDuplicateJsonKeys } from "./strict-json.mjs";

const MAX_REVIEW_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_AUDIT_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 32 * 1024;
const MAX_DECISION_BYTES = 32 * 1024;
const MAX_PROJECT_FILE_BYTES = 64 * 1024 * 1024;
const HEX_64 = /^[0-9a-f]{64}$/;
const DECISION_ID = /^D-[0-9]{3}$/;
const UTC_SECOND = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const DECISION_HASH_KEYS = Object.freeze([
  "admissionsSha256",
  "auditRawSha256",
  "auditReceiptSha256",
  "candidateReceiptSha256",
  "candidateReportSha256",
  "dependencyEvidenceSha256",
  "noticesSha256",
  "sbomSha256",
]);
const DECISION_KEYS = Object.freeze([
  "version",
  "kind",
  "status",
  "owner",
  "decisionId",
  "decidedAt",
  ...DECISION_HASH_KEYS,
]);
const FORMAL_ARTIFACT_PATHS = Object.freeze({
  admissionsSha256: "docs/contracts/dependency-admissions.json",
  dependencyEvidenceSha256: "docs/generated/supply-chain/dependency-evidence.json",
  noticesSha256: "THIRD_PARTY_NOTICES",
  sbomSha256: "docs/generated/supply-chain/sbom.spdx.json",
});
const PROJECT_DIRECTORY_PATHS = Object.freeze([
  "",
  "docs",
  "docs/contracts",
  "docs/generated",
  "docs/generated/supply-chain",
]);
const CANDIDATE_REPORT_KEYS = Object.freeze([
  "kind",
  "owner",
  "packages",
  "receipt",
  "status",
  "version",
]);
const CANDIDATE_PACKAGE_KEYS = Object.freeze([
  "bindingGyp",
  "description",
  "effectiveInstallScripts",
  "evidenceSha256",
  "gypfile",
  "homepage",
  "identity",
  "implicitNodeGyp",
  "integrity",
  "licenseDeclared",
  "licenseFiles",
  "licensePolicy",
  "noticeFiles",
  "packageJsonSha256",
  "resolved",
]);
const CANDIDATE_LEGAL_FILE_KEYS = Object.freeze(["path", "rawSha256", "text"]);
const CANDIDATE_INSTALL_SCRIPT_NAMES = new Set(["preinstall", "install", "postinstall"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SUMMARY_ENVELOPE = Object.freeze({
  version: "0.1.0",
  kind: "axial_muse_final_admission_evidence",
  status: "approved",
  owner: "AxialMuseWebsite",
});
const SUMMARY_AUDIT_KEYS = Object.freeze([
  "critical",
  "dependencyTotal",
  "high",
  "info",
  "low",
  "moderate",
  "outcome",
  "total",
]);
const SUMMARY_KEYS = Object.freeze([
  "admissionsSha256",
  "audit",
  "auditRawSha256",
  "auditReceiptSha256",
  "candidatePackageCount",
  "candidateReceiptSha256",
  "candidateReportSha256",
  "decidedAt",
  "decisionId",
  "dependencyEvidenceSha256",
  "finalDecisionSha256",
  "inputs",
  "kind",
  "noticesSha256",
  "owner",
  "sbomSha256",
  "status",
  "version",
]);

export const FINAL_ADMISSION_DECISION_ENVELOPE = Object.freeze({
  version: "0.1.0",
  kind: "axial_muse_final_admission_decision",
  status: "approved",
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
    fail(code, `${pointer} 字段集合不符合最终准入 schema。`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes, code, label) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    fail(code, `${label} 不是合法 UTF-8 字节。`);
  }
}

function cloneDecision(value) {
  return {
    version: value.version,
    kind: value.kind,
    status: value.status,
    owner: value.owner,
    decisionId: value.decisionId,
    decidedAt: value.decidedAt,
    ...Object.fromEntries(DECISION_HASH_KEYS.map((key) => [key, value[key]])),
  };
}

export function validateFinalAdmissionDecision(value) {
  const code = "FINAL_ADMISSION_DECISION_SCHEMA";
  assertExactKeys(value, DECISION_KEYS, "$decision", code);
  for (const [key, expected] of Object.entries(FINAL_ADMISSION_DECISION_ENVELOPE)) {
    if (value[key] !== expected) {
      fail(code, `最终准入决定 ${key} 不受支持。`);
    }
  }
  if (!DECISION_ID.test(value.decisionId ?? "")) {
    fail(code, "最终准入决定 decisionId 必须是 D-xxx。");
  }
  if (!UTC_SECOND.test(value.decidedAt ?? "")) {
    fail(code, "最终准入决定 decidedAt 必须是 UTC 秒精度时间。");
  }
  const parsedTime = new Date(value.decidedAt);
  if (
    Number.isNaN(parsedTime.getTime())
    || parsedTime.toISOString().replace(".000Z", "Z") !== value.decidedAt
  ) {
    fail(code, "最终准入决定 decidedAt 不是有效的 UTC 秒精度时间。");
  }
  for (const key of DECISION_HASH_KEYS) {
    if (!HEX_64.test(value[key] ?? "")) {
      fail(code, `最终准入决定 ${key} 必须是 lowercase SHA-256。`);
    }
  }
  return cloneDecision(value);
}

export function renderFinalAdmissionDecision(value) {
  return canonicalJsonBytes(validateFinalAdmissionDecision(value));
}

export function parseFinalAdmissionDecision(text) {
  if (
    typeof text !== "string"
    || text === ""
    || Buffer.byteLength(text, "utf8") > MAX_DECISION_BYTES
  ) {
    fail("FINAL_ADMISSION_DECISION_BYTES", "最终准入决定字节为空或超过 32 KiB。" );
  }
  assertNoDuplicateJsonKeys(text, {
    duplicateCode: "FINAL_ADMISSION_DECISION_BYTES",
    invalidCode: "FINAL_ADMISSION_DECISION_BYTES",
    label: "最终准入决定",
  });
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("FINAL_ADMISSION_DECISION_BYTES", "最终准入决定不是合法 JSON。" );
  }
  const decision = validateFinalAdmissionDecision(value);
  if (renderFinalAdmissionDecision(decision) !== text) {
    fail("FINAL_ADMISSION_DECISION_BYTES", "最终准入决定不是 canonical JSON 字节。" );
  }
  return decision;
}

function validateNonnegativeCount(value, pointer) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("FINAL_ADMISSION_SUMMARY_SCHEMA", `${pointer} 必须是非负安全整数。`);
  }
  return value;
}

export function validateFinalAdmissionEvidenceSummary(value) {
  const code = "FINAL_ADMISSION_SUMMARY_SCHEMA";
  assertExactKeys(value, SUMMARY_KEYS, "$summary", code);
  for (const [key, expected] of Object.entries(SUMMARY_ENVELOPE)) {
    if (value[key] !== expected) {
      fail(code, `最终准入证据摘要 ${key} 不受支持。`);
    }
  }
  if (!DECISION_ID.test(value.decisionId ?? "") || !UTC_SECOND.test(value.decidedAt ?? "")) {
    fail(code, "最终准入证据摘要的决定身份或时间不合法。");
  }
  const decidedAt = new Date(value.decidedAt);
  if (
    Number.isNaN(decidedAt.getTime())
    || decidedAt.toISOString().replace(".000Z", "Z") !== value.decidedAt
  ) {
    fail(code, "最终准入证据摘要的决定时间不是有效 UTC 秒精度时间。" );
  }
  for (const key of [...DECISION_HASH_KEYS, "finalDecisionSha256"]) {
    if (!HEX_64.test(value[key] ?? "")) {
      fail(code, `最终准入证据摘要 ${key} 必须是 lowercase SHA-256。`);
    }
  }
  assertExactKeys(value.inputs, SUPPLY_CHAIN_INPUT_PATHS, "$summary.inputs", code);
  for (const path of SUPPLY_CHAIN_INPUT_PATHS) {
    if (!HEX_64.test(value.inputs[path] ?? "")) {
      fail(code, `最终准入证据摘要 inputs.${path} 必须是 lowercase SHA-256。`);
    }
  }
  assertExactKeys(value.audit, SUMMARY_AUDIT_KEYS, "$summary.audit", code);
  if (value.audit.outcome !== "pass") {
    fail(code, "最终准入证据摘要只接受 audit outcome=pass。" );
  }
  const audit = {
    outcome: "pass",
    dependencyTotal: validateNonnegativeCount(
      value.audit.dependencyTotal,
      "$summary.audit.dependencyTotal",
    ),
    total: validateNonnegativeCount(value.audit.total, "$summary.audit.total"),
    info: validateNonnegativeCount(value.audit.info, "$summary.audit.info"),
    low: validateNonnegativeCount(value.audit.low, "$summary.audit.low"),
    moderate: validateNonnegativeCount(value.audit.moderate, "$summary.audit.moderate"),
    high: validateNonnegativeCount(value.audit.high, "$summary.audit.high"),
    critical: validateNonnegativeCount(value.audit.critical, "$summary.audit.critical"),
  };
  if (value.candidateReceiptSha256 !== value.auditReceiptSha256) {
    fail(code, "最终准入证据摘要要求 candidate/audit receipt hash 完全一致。" );
  }
  if (audit.moderate !== 0 || audit.high !== 0 || audit.critical !== 0) {
    fail(code, "最终准入证据摘要不允许 moderate/high/critical 漏洞。" );
  }
  if (
    audit.info + audit.low + audit.moderate + audit.high + audit.critical
    !== audit.total
  ) {
    fail(code, "最终准入证据摘要的漏洞分级计数与 total 不一致。" );
  }
  const candidatePackageCount = validateNonnegativeCount(
    value.candidatePackageCount,
    "$summary.candidatePackageCount",
  );
  if (
    audit.total > candidatePackageCount
    || candidatePackageCount > audit.dependencyTotal
    || audit.total > audit.dependencyTotal
    || ((candidatePackageCount === 0) !== (audit.dependencyTotal === 0))
  ) {
    fail(
      code,
      "最终准入证据摘要的候选包、漏洞与审计依赖计数不自洽。",
    );
  }
  const expectedFinalDecisionSha256 = sha256(renderFinalAdmissionDecision({
    ...FINAL_ADMISSION_DECISION_ENVELOPE,
    decisionId: value.decisionId,
    decidedAt: value.decidedAt,
    ...Object.fromEntries(DECISION_HASH_KEYS.map((key) => [key, value[key]])),
  }));
  if (value.finalDecisionSha256 !== expectedFinalDecisionSha256) {
    fail(code, "最终准入证据摘要的 finalDecisionSha256 与决定语义不一致。");
  }
  return {
    ...SUMMARY_ENVELOPE,
    decisionId: value.decisionId,
    decidedAt: value.decidedAt,
    ...Object.fromEntries(DECISION_HASH_KEYS.map((key) => [key, value[key]])),
    finalDecisionSha256: value.finalDecisionSha256,
    inputs: Object.fromEntries(SUPPLY_CHAIN_INPUT_PATHS.map((path) => [
      path,
      value.inputs[path],
    ])),
    candidatePackageCount,
    audit,
  };
}

export function finalAdmissionEvidenceSummaryBytes(summary) {
  return canonicalJsonBytes(validateFinalAdmissionEvidenceSummary(summary));
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function statIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    uid: stat.uid,
    size: stat.size,
    ctimeNs: stat.ctimeNs,
    mtimeNs: stat.mtimeNs,
  };
}

function identitiesEqual(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function validateDirectoryStat(stat) {
  return stat.isDirectory()
    && !stat.isSymbolicLink()
    && (stat.mode & 0o777n) === 0o700n
    && (typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid()));
}

function validateFileStat(stat, maximumBytes) {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.nlink === 1n
    && (stat.mode & 0o777n) === 0o600n
    && stat.size > 0n
    && stat.size <= BigInt(maximumBytes)
    && (typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid()));
}

function validateProjectDirectoryStat(stat) {
  return stat.isDirectory()
    && !stat.isSymbolicLink()
    && (typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid()));
}

function validateProjectFileStat(stat, maximumBytes) {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.nlink === 1n
    && stat.size > 0n
    && stat.size <= BigInt(maximumBytes)
    && (typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid()));
}

function closeQuietly(descriptor) {
  if (descriptor === null || descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    // 释放阶段不能掩盖原始校验错误。
  }
}

function readDescriptorBytes(descriptor, size, code) {
  const length = Number(size);
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    let count;
    try {
      count = readSync(descriptor, bytes, offset, length - offset, offset);
    } catch {
      bytes.fill(0);
      fail(code, "最终准入证据句柄无法读取。" );
    }
    if (count === 0) {
      bytes.fill(0);
      fail(code, "最终准入证据在读取期间被截断。" );
    }
    offset += count;
  }
  return bytes;
}

function openRestrictedDirectory(path, expectedEntries) {
  let canonicalTmp;
  let canonicalPath;
  let pathStat;
  let descriptor;
  try {
    if (
      typeof path !== "string"
      || !isAbsolute(path)
      || resolve(path) !== path
    ) {
      fail("FINAL_ADMISSION_PATH", "最终准入证据目录必须使用绝对规范路径。" );
    }
    canonicalTmp = realpathSync("/tmp");
    canonicalPath = realpathSync(path);
    pathStat = lstatSync(path, { bigint: true });
    if (
      canonicalPath !== path
      || canonicalPath === canonicalTmp
      || !isInside(canonicalTmp, canonicalPath)
      || !validateDirectoryStat(pathStat)
    ) {
      fail("FINAL_ADMISSION_DIRECTORY", "最终准入证据目录类型、权限或所有者不受控。" );
    }
    descriptor = openSync(
      canonicalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
    );
    const descriptorStat = fstatSync(descriptor, { bigint: true });
    const entries = readdirSync(canonicalPath).sort(compareBytes);
    const finalPathStat = lstatSync(canonicalPath, { bigint: true });
    if (
      !validateDirectoryStat(descriptorStat)
      || !validateDirectoryStat(finalPathStat)
      || !identitiesEqual(statIdentity(descriptorStat), statIdentity(pathStat))
      || !identitiesEqual(statIdentity(finalPathStat), statIdentity(pathStat))
      || entries.length !== expectedEntries.length
      || entries.some((entry, index) => entry !== expectedEntries[index])
    ) {
      fail("FINAL_ADMISSION_DIRECTORY", "最终准入证据目录身份或精确内容闭包不受控。" );
    }
    return {
      descriptor,
      driftCode: "FINAL_ADMISSION_EVIDENCE_DRIFT",
      entries: Object.freeze([...expectedEntries]),
      identity: statIdentity(finalPathStat),
      label: "最终准入证据目录",
      path: canonicalPath,
      validateStat: validateDirectoryStat,
    };
  } catch (error) {
    closeQuietly(descriptor);
    if (error instanceof NpmIsolationError) throw error;
    fail("FINAL_ADMISSION_DIRECTORY", "最终准入证据目录无法安全打开。" );
  }
}

function openRestrictedFile(path, directory, expectedName, maximumBytes) {
  let descriptor;
  let bytes;
  try {
    if (
      typeof path !== "string"
      || !isAbsolute(path)
      || resolve(path) !== path
      || dirname(path) !== directory.path
      || basename(path) !== expectedName
      || realpathSync(path) !== path
    ) {
      fail("FINAL_ADMISSION_PATH", `最终准入证据路径必须精确指向 ${expectedName}。`);
    }
    const pathStat = lstatSync(path, { bigint: true });
    if (!validateFileStat(pathStat, maximumBytes)) {
      fail("FINAL_ADMISSION_FILE", `最终准入证据 ${expectedName} 类型、权限或所有者不受控。`);
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = fstatSync(descriptor, { bigint: true });
    if (
      !validateFileStat(openedStat, maximumBytes)
      || !identitiesEqual(statIdentity(openedStat), statIdentity(pathStat))
    ) {
      fail("FINAL_ADMISSION_FILE", `最终准入证据 ${expectedName} 在打开期间被替换。`);
    }
    bytes = readDescriptorBytes(
      descriptor,
      openedStat.size,
      "FINAL_ADMISSION_FILE",
    );
    const finalDescriptorStat = fstatSync(descriptor, { bigint: true });
    const finalPathStat = lstatSync(path, { bigint: true });
    if (
      !validateFileStat(finalDescriptorStat, maximumBytes)
      || !validateFileStat(finalPathStat, maximumBytes)
      || !identitiesEqual(statIdentity(finalDescriptorStat), statIdentity(openedStat))
      || !identitiesEqual(statIdentity(finalPathStat), statIdentity(openedStat))
    ) {
      bytes.fill(0);
      fail("FINAL_ADMISSION_FILE", `最终准入证据 ${expectedName} 在读取期间发生变化。`);
    }
    return {
      bytes,
      descriptor,
      driftCode: "FINAL_ADMISSION_EVIDENCE_DRIFT",
      identity: statIdentity(finalDescriptorStat),
      label: `最终准入证据 ${expectedName}`,
      maximumBytes,
      path,
      validateStat: (stat) => validateFileStat(stat, maximumBytes),
    };
  } catch (error) {
    if (bytes !== undefined) bytes.fill(0);
    closeQuietly(descriptor);
    if (error instanceof NpmIsolationError) throw error;
    fail("FINAL_ADMISSION_FILE", `最终准入证据 ${expectedName} 无法安全打开。`);
  }
}

function openProjectDirectory(root, relativePath) {
  const path = resolve(root, relativePath);
  let descriptor;
  try {
    if (!isInside(root, path) || realpathSync(path) !== path) {
      fail("FINAL_ADMISSION_PROJECT_DIRECTORY", `${relativePath || "."} 目录路径不受控。`);
    }
    const pathStat = lstatSync(path, { bigint: true });
    if (!validateProjectDirectoryStat(pathStat)) {
      fail("FINAL_ADMISSION_PROJECT_DIRECTORY", `${relativePath || "."} 不是受控仓库目录。`);
    }
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
    );
    const descriptorStat = fstatSync(descriptor, { bigint: true });
    const entries = readdirSync(path).sort(compareBytes);
    const finalPathStat = lstatSync(path, { bigint: true });
    if (
      !validateProjectDirectoryStat(descriptorStat)
      || !validateProjectDirectoryStat(finalPathStat)
      || !identitiesEqual(statIdentity(descriptorStat), statIdentity(pathStat))
      || !identitiesEqual(statIdentity(finalPathStat), statIdentity(pathStat))
    ) {
      fail("FINAL_ADMISSION_PROJECT_DIRECTORY", `${relativePath || "."} 目录在打开期间漂移。`);
    }
    return {
      descriptor,
      driftCode: "FINAL_ADMISSION_FORMAL_DRIFT",
      entries: Object.freeze(entries),
      identity: statIdentity(finalPathStat),
      label: `仓库目录 ${relativePath || "."}`,
      path,
      validateStat: validateProjectDirectoryStat,
    };
  } catch (error) {
    closeQuietly(descriptor);
    if (error instanceof NpmIsolationError) throw error;
    fail("FINAL_ADMISSION_PROJECT_DIRECTORY", `${relativePath || "."} 目录无法安全打开。`);
  }
}

function openProjectFile(root, relativePath, driftCode) {
  const path = resolve(root, relativePath);
  let descriptor;
  let bytes;
  try {
    if (!isInside(root, path) || realpathSync(path) !== path) {
      fail("FINAL_ADMISSION_PROJECT_FILE", `${relativePath} 文件路径不受控。`);
    }
    const pathStat = lstatSync(path, { bigint: true });
    if (!validateProjectFileStat(pathStat, MAX_PROJECT_FILE_BYTES)) {
      fail("FINAL_ADMISSION_PROJECT_FILE", `${relativePath} 不是受控仓库文件。`);
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptorStat = fstatSync(descriptor, { bigint: true });
    if (
      !validateProjectFileStat(descriptorStat, MAX_PROJECT_FILE_BYTES)
      || !identitiesEqual(statIdentity(descriptorStat), statIdentity(pathStat))
    ) {
      fail("FINAL_ADMISSION_PROJECT_FILE", `${relativePath} 在打开期间被替换。`);
    }
    bytes = readDescriptorBytes(
      descriptor,
      descriptorStat.size,
      "FINAL_ADMISSION_PROJECT_FILE",
    );
    const finalDescriptorStat = fstatSync(descriptor, { bigint: true });
    const finalPathStat = lstatSync(path, { bigint: true });
    if (
      !validateProjectFileStat(finalDescriptorStat, MAX_PROJECT_FILE_BYTES)
      || !validateProjectFileStat(finalPathStat, MAX_PROJECT_FILE_BYTES)
      || !identitiesEqual(statIdentity(finalDescriptorStat), statIdentity(descriptorStat))
      || !identitiesEqual(statIdentity(finalPathStat), statIdentity(descriptorStat))
    ) {
      bytes.fill(0);
      fail("FINAL_ADMISSION_PROJECT_FILE", `${relativePath} 在读取期间发生变化。`);
    }
    return {
      bytes,
      descriptor,
      driftCode,
      identity: statIdentity(finalDescriptorStat),
      label: `仓库文件 ${relativePath}`,
      maximumBytes: MAX_PROJECT_FILE_BYTES,
      path,
      relativePath,
      validateStat: (stat) => validateProjectFileStat(stat, MAX_PROJECT_FILE_BYTES),
    };
  } catch (error) {
    if (bytes !== undefined) bytes.fill(0);
    closeQuietly(descriptor);
    if (error instanceof NpmIsolationError) throw error;
    fail("FINAL_ADMISSION_PROJECT_FILE", `${relativePath} 无法安全打开。`);
  }
}

function assertDirectoryCurrent(directory) {
  let descriptorStat;
  let pathStat;
  let entries;
  try {
    descriptorStat = fstatSync(directory.descriptor, { bigint: true });
    pathStat = lstatSync(directory.path, { bigint: true });
    entries = readdirSync(directory.path).sort(compareBytes);
  } catch {
    fail(directory.driftCode, `${directory.label} 不再可复核。`);
  }
  if (
    !directory.validateStat(descriptorStat)
    || !directory.validateStat(pathStat)
    || !identitiesEqual(statIdentity(descriptorStat), directory.identity)
    || !identitiesEqual(statIdentity(pathStat), directory.identity)
    || entries.length !== directory.entries.length
    || entries.some((entry, index) => entry !== directory.entries[index])
  ) {
    fail(directory.driftCode, `${directory.label} 身份或内容发生漂移。`);
  }
}

function assertFileCurrent(file) {
  let descriptorStat;
  let pathStat;
  try {
    descriptorStat = fstatSync(file.descriptor, { bigint: true });
    pathStat = lstatSync(file.path, { bigint: true });
  } catch {
    fail(file.driftCode, `${file.label} 不再可复核。`);
  }
  if (
    !file.validateStat(descriptorStat)
    || !file.validateStat(pathStat)
    || !identitiesEqual(statIdentity(descriptorStat), file.identity)
    || !identitiesEqual(statIdentity(pathStat), file.identity)
  ) {
    fail(file.driftCode, `${file.label} 身份发生漂移。`);
  }
  const current = readDescriptorBytes(
    file.descriptor,
    descriptorStat.size,
    file.driftCode,
  );
  try {
    const finalDescriptorStat = fstatSync(file.descriptor, { bigint: true });
    const finalPathStat = lstatSync(file.path, { bigint: true });
    if (
      !current.equals(file.bytes)
      || !identitiesEqual(statIdentity(finalDescriptorStat), file.identity)
      || !identitiesEqual(statIdentity(finalPathStat), file.identity)
    ) {
      fail(file.driftCode, `${file.label} 字节发生漂移。`);
    }
  } finally {
    current.fill(0);
  }
}

function closeHeldState(state) {
  for (const file of state.files ?? []) {
    closeQuietly(file.descriptor);
    file.descriptor = null;
    file.bytes.fill(0);
  }
  for (const directory of state.directories ?? []) {
    closeQuietly(directory.descriptor);
    directory.descriptor = null;
  }
  state.files = [];
  state.directories = [];
  state.auditReceipt = null;
  state.candidatePackages = null;
  state.candidateReceipt = null;
  state.formalArtifactHashes = null;
  state.inputHashes = null;
  state.closed = true;
}

function assertHeldStateCurrent(state) {
  if (state.closed) {
    fail("FINAL_ADMISSION_CLOSED", "最终准入证据句柄已经关闭。" );
  }
  for (const directory of state.directories) assertDirectoryCurrent(directory);
  for (const file of state.files) assertFileCurrent(file);
}

function parseCandidateReport(bytes) {
  const text = decodeUtf8(
    bytes,
    "FINAL_ADMISSION_CANDIDATE_REPORT",
    "候选审查报告",
  );
  assertNoDuplicateJsonKeys(text, {
    duplicateCode: "FINAL_ADMISSION_CANDIDATE_REPORT",
    invalidCode: "FINAL_ADMISSION_CANDIDATE_REPORT",
    label: "候选审查报告",
  });
  try {
    return JSON.parse(text);
  } catch {
    fail("FINAL_ADMISSION_CANDIDATE_REPORT", "候选审查报告不是合法 JSON。" );
  }
}

function sortedCandidateScripts(value, pointer) {
  if (!isPlainObject(value)) {
    fail("FINAL_ADMISSION_CANDIDATE_REPORT", `${pointer} 不是 object。`);
  }
  const entries = Object.entries(value);
  for (const [name, command] of entries) {
    if (
      !CANDIDATE_INSTALL_SCRIPT_NAMES.has(name)
      || typeof command !== "string"
      || command === ""
      || command.includes("\0")
    ) {
      fail("FINAL_ADMISSION_CANDIDATE_REPORT", `${pointer} 包含非法生命周期脚本。`);
    }
  }
  return Object.fromEntries(entries.sort(([left], [right]) => compareBytes(left, right)));
}

function validateCandidateLegalFiles(value, pointer, { requireNonEmpty }) {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
    fail("FINAL_ADMISSION_CANDIDATE_REPORT", `${pointer} 必须是${requireNonEmpty ? "非空" : ""} array。`);
  }
  for (const [index, file] of value.entries()) {
    const filePointer = `${pointer}[${index}]`;
    assertExactKeys(
      file,
      CANDIDATE_LEGAL_FILE_KEYS,
      filePointer,
      "FINAL_ADMISSION_CANDIDATE_REPORT",
    );
    if (
      typeof file.path !== "string"
      || file.path === ""
      || typeof file.text !== "string"
      || file.text === ""
      || !HEX_64.test(file.rawSha256 ?? "")
    ) {
      fail("FINAL_ADMISSION_CANDIDATE_REPORT", `${filePointer} 法律文件证据不自洽。`);
    }
  }
}

function validateCandidatePackage(package_, lockedPackage, policy, licenseEvidence, index) {
  const pointer = `$candidate.packages[${index}]`;
  assertExactKeys(
    package_,
    CANDIDATE_PACKAGE_KEYS,
    pointer,
    "FINAL_ADMISSION_CANDIDATE_REPORT",
  );
  if (
    package_.identity !== lockedPackage.identity
    || package_.resolved !== lockedPackage.resolved
    || package_.integrity !== lockedPackage.integrity
    || !HEX_64.test(package_.packageJsonSha256 ?? "")
    || !HEX_64.test(package_.evidenceSha256 ?? "")
  ) {
    fail("FINAL_ADMISSION_CANDIDATE_REPORT", `${pointer} 与当前 lock 身份或证据不一致。`);
  }
  if (
    typeof package_.licenseDeclared !== "string"
    || package_.licenseDeclared === ""
    || (package_.homepage !== null && typeof package_.homepage !== "string")
    || (package_.description !== null && typeof package_.description !== "string")
    || typeof package_.bindingGyp !== "boolean"
    || (package_.gypfile !== null && typeof package_.gypfile !== "boolean")
    || typeof package_.implicitNodeGyp !== "boolean"
  ) {
    fail("FINAL_ADMISSION_CANDIDATE_REPORT", `${pointer} 包元数据 schema 不合法。`);
  }
  assertExactKeys(
    package_.licensePolicy,
    ["classification", "code"],
    `${pointer}.licensePolicy`,
    "FINAL_ADMISSION_CANDIDATE_REPORT",
  );
  const licensePackage = {
    identity: package_.identity,
    integrity: package_.integrity,
    licenseDeclared: package_.licenseDeclared,
    resolved: package_.resolved,
  };
  const { licenseConcluded: _licenseConcluded, ...expectedLicensePolicy } =
    classifyExactPackageLicenseForReport({
      evidence: licenseEvidence,
      package_: licensePackage,
      policy,
    });
  if (
    package_.licensePolicy.classification !== expectedLicensePolicy.classification
    || package_.licensePolicy.code !== expectedLicensePolicy.code
  ) {
    fail("FINAL_ADMISSION_CANDIDATE_REPORT", `${pointer}.licensePolicy 与当前策略不一致。`);
  }
  const scripts = sortedCandidateScripts(
    package_.effectiveInstallScripts,
    `${pointer}.effectiveInstallScripts`,
  );
  if (Object.keys(scripts).length > 0 && !lockedPackage.hasInstallScript) {
    fail("FINAL_ADMISSION_CANDIDATE_REPORT", `${pointer} 生命周期脚本见证未被 lock 标记。`);
  }
  validateCandidateLegalFiles(package_.licenseFiles, `${pointer}.licenseFiles`, {
    requireNonEmpty: false,
  });
  validateCandidateLegalFiles(package_.noticeFiles, `${pointer}.noticeFiles`, {
    requireNonEmpty: false,
  });
  validatePackageLicenseEvidence({
    evidence: licenseEvidence,
    licenseFiles: package_.licenseFiles.map((file) => ({
      ...file,
      size: Buffer.byteLength(file.text, "utf8"),
    })),
    package_: licensePackage,
  });
  let recomputedEvidenceSha256;
  try {
    recomputedEvidenceSha256 = packageEvidenceSha256FromTarballInspection({
      inspection: {
        bindingGyp: package_.bindingGyp,
        description: package_.description,
        effectiveInstallScripts: scripts,
        gypfile: package_.gypfile,
        homepage: package_.homepage,
        identity: package_.identity,
        implicitNodeGyp: package_.implicitNodeGyp,
        integrity: package_.integrity,
        licenseDeclared: package_.licenseDeclared,
        licenseFiles: package_.licenseFiles,
        noticeFiles: package_.noticeFiles,
        packageJsonSha256: package_.packageJsonSha256,
      },
      lockedPackage,
    });
  } catch {
    fail(
      "FINAL_ADMISSION_CANDIDATE_REPORT",
      `${pointer} 无法重建规范 package evidence。`,
    );
  }
  if (recomputedEvidenceSha256 !== package_.evidenceSha256) {
    fail(
      "FINAL_ADMISSION_CANDIDATE_REPORT",
      `${pointer}.evidenceSha256 与候选报告语义字段不一致。`,
    );
  }
}

function validateCandidateReport({ bytes, licenseEvidence, lockedPackages, policy, receipt }) {
  const parsed = parseCandidateReport(bytes);
  try {
    assertExactKeys(
      parsed,
      CANDIDATE_REPORT_KEYS,
      "$candidate",
      "FINAL_ADMISSION_CANDIDATE_REPORT",
    );
    if (
      parsed.version !== "0.2.0"
      || parsed.kind !== "axial_muse_supply_chain_review_report"
      || parsed.status !== "candidate"
      || parsed.owner !== "AxialMuseWebsite"
      || !Array.isArray(parsed.packages)
    ) {
      fail("FINAL_ADMISSION_CANDIDATE_REPORT", "候选审查报告 packages 必须是 array。" );
    }
    if (supplyChainInputReceiptBytes(parsed.receipt) !== supplyChainInputReceiptBytes(receipt)) {
      fail("FINAL_ADMISSION_RECEIPT_MISMATCH", "候选审查报告内嵌 receipt 与 sidecar 不一致。" );
    }
    const expectedPackages = [...lockedPackages].sort((left, right) => (
      compareBytes(left.identity, right.identity)
    ));
    if (parsed.packages.length !== expectedPackages.length) {
      fail("FINAL_ADMISSION_CANDIDATE_REPORT", "候选审查报告与当前 lock 包集合不闭合。" );
    }
    const licensePackages = [];
    for (const [index, package_] of parsed.packages.entries()) {
      validateCandidatePackage(
        package_,
        expectedPackages[index],
        policy,
        licenseEvidence,
        index,
      );
      licensePackages.push({
        identity: package_.identity,
        integrity: package_.integrity,
        licenseDeclared: package_.licenseDeclared,
        resolved: package_.resolved,
      });
    }
    validateDependencyLicenseEvidenceGraph({
      evidence: licenseEvidence,
      packages: licensePackages,
    });
  } catch (error) {
    if (error instanceof NpmIsolationError) throw error;
    fail("FINAL_ADMISSION_CANDIDATE_REPORT", "候选审查报告无法按当前图复验。" );
  }
  const canonical = Buffer.from(canonicalJsonBytes(parsed), "utf8");
  try {
    if (!canonical.equals(bytes)) {
      fail("FINAL_ADMISSION_CANDIDATE_REPORT", "候选审查报告不是 canonical JSON 字节。" );
    }
  } finally {
    canonical.fill(0);
  }
  return parsed;
}

function assertReceiptCurrent(root, receipt, npmVersionsByRole) {
  return assertSupplyChainInputReceiptCurrent({
    code: "FINAL_ADMISSION_RECEIPT_DRIFT",
    npmVersionsByRole,
    receipt,
    requiredRole: "primary",
    root,
  });
}

function invokeClosureCheck(checkClosure, root) {
  let result;
  try {
    result = checkClosure({ root });
  } catch (error) {
    if (error instanceof NpmIsolationError) throw error;
    fail("FINAL_ADMISSION_FORMAL_CLOSURE", "正式供应链三件套闭包检查失败。" );
  }
  if (result !== null && typeof result === "object" && typeof result.then === "function") {
    fail("FINAL_ADMISSION_FORMAL_CLOSURE", "正式供应链三件套闭包检查必须同步完成。" );
  }
  return result;
}

function assertCandidateFormalClosure(result, candidatePackages) {
  const admissions = result?.admissions;
  const formalPackages = admissions?.packages;
  if (!isPlainObject(admissions) || !isPlainObject(formalPackages)) {
    fail(
      "FINAL_ADMISSION_CANDIDATE_FORMAL_DRIFT",
      "正式闭包结果缺少可复核的 admissions.packages。",
    );
  }
  const candidateBindings = candidatePackages.map((package_) => [
    package_.identity,
    package_.evidenceSha256,
  ]).sort(([left], [right]) => compareBytes(left, right));
  const formalBindings = Object.entries(formalPackages).map(([identity, admission]) => [
    identity,
    admission?.evidenceSha256,
  ]).sort(([left], [right]) => compareBytes(left, right));
  if (
    candidateBindings.length !== formalBindings.length
    || candidateBindings.some(([identity, evidenceSha256], index) => (
      identity !== formalBindings[index]?.[0]
      || evidenceSha256 !== formalBindings[index]?.[1]
      || !HEX_64.test(evidenceSha256 ?? "")
    ))
  ) {
    fail(
      "FINAL_ADMISSION_CANDIDATE_FORMAL_DRIFT",
      "候选审查 identity/evidenceSha256 与正式 admissions 不逐包闭合。",
    );
  }
}

function hashesFromHeldFiles(filesByRelativePath, paths) {
  return Object.fromEntries(paths.map((path) => [
    path,
    sha256(filesByRelativePath.get(path).bytes),
  ]));
}

function assertHeldInputReceipt(receipt, inputHashes) {
  for (const path of SUPPLY_CHAIN_INPUT_PATHS) {
    if (receipt.inputs[path] !== inputHashes[path]) {
      fail("FINAL_ADMISSION_RECEIPT_DRIFT", `持有输入 ${path} 与 receipt 不一致。`);
    }
  }
}

function assertDecisionBindings(decision, expected) {
  for (const key of DECISION_HASH_KEYS) {
    if (decision[key] !== expected[key]) {
      fail("FINAL_ADMISSION_DECISION_DRIFT", `最终准入决定 ${key} 与持有证据不一致。`);
    }
  }
}

function freezeSummary(summary) {
  const validated = validateFinalAdmissionEvidenceSummary(summary);
  Object.freeze(validated.audit);
  Object.freeze(validated.inputs);
  return Object.freeze(validated);
}

function assertEvidenceCurrent(state) {
  assertHeldStateCurrent(state);
  assertHeldInputReceipt(state.candidateReceipt, state.inputHashes);
  assertHeldInputReceipt(state.auditReceipt, state.inputHashes);
  assertReceiptCurrent(state.root, state.candidateReceipt, state.npmVersionsByRole);
  assertReceiptCurrent(state.root, state.auditReceipt, state.npmVersionsByRole);
  const closure = invokeClosureCheck(state.checkClosure, state.root);
  assertCandidateFormalClosure(closure, state.candidatePackages);
  assertHeldStateCurrent(state);
  assertReceiptCurrent(state.root, state.candidateReceipt, state.npmVersionsByRole);
  assertReceiptCurrent(state.root, state.auditReceipt, state.npmVersionsByRole);
  assertHeldInputReceipt(state.candidateReceipt, state.inputHashes);
  assertHeldInputReceipt(state.auditReceipt, state.inputHashes);
  assertHeldStateCurrent(state);
  return state.summary;
}

export function openFinalAdmissionEvidence({
  root,
  candidateReportPath,
  candidateReceiptPath,
  auditRawPath,
  auditReceiptPath,
  finalDecisionPath,
  npmVersionsByRole = NPM_VERSIONS_BY_ROLE,
  checkClosure = checkSupplyChain,
  ...unknownOptions
} = {}) {
  if (
    typeof root !== "string"
    || root === ""
    || typeof checkClosure !== "function"
    || Object.keys(unknownOptions).length !== 0
  ) {
    fail("FINAL_ADMISSION_INPUT", "最终准入证据链输入不合法。" );
  }
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(resolve(root));
  } catch {
    fail("FINAL_ADMISSION_INPUT", "最终准入证据链仓库根目录不可用。" );
  }
  const evidencePaths = [
    candidateReportPath,
    candidateReceiptPath,
    auditRawPath,
    auditReceiptPath,
    finalDecisionPath,
  ];
  if (evidencePaths.some((path) => typeof path !== "string" || !isAbsolute(path))) {
    fail("FINAL_ADMISSION_PATH", "最终准入证据必须提供五个绝对 /tmp 文件路径。" );
  }
  const candidateDirectoryPath = dirname(candidateReportPath ?? "");
  const auditDirectoryPath = dirname(auditRawPath ?? "");
  const decisionDirectoryPath = dirname(finalDecisionPath ?? "");
  if (
    dirname(candidateReceiptPath ?? "") !== candidateDirectoryPath
    || dirname(auditReceiptPath ?? "") !== auditDirectoryPath
    || new Set([
      candidateDirectoryPath,
      auditDirectoryPath,
      decisionDirectoryPath,
    ]).size !== 3
  ) {
    fail("FINAL_ADMISSION_PATH", "候选、audit 与最终决定必须位于三个独立受限目录。" );
  }

  const state = {
    auditReceipt: null,
    candidatePackages: null,
    candidateReceipt: null,
    checkClosure,
    closed: false,
    directories: [],
    files: [],
    formalArtifactHashes: null,
    inputHashes: null,
    npmVersionsByRole,
    root: canonicalRoot,
    summary: null,
  };
  try {
    const candidateDirectory = openRestrictedDirectory(candidateDirectoryPath, [
      "receipt.json",
      "report.json",
    ]);
    state.directories.push(candidateDirectory);
    const auditDirectory = openRestrictedDirectory(auditDirectoryPath, [
      "raw-audit.json",
      "receipt.json",
    ]);
    state.directories.push(auditDirectory);
    const decisionDirectory = openRestrictedDirectory(decisionDirectoryPath, [
      "final-decision.json",
    ]);
    state.directories.push(decisionDirectory);

    const candidateReport = openRestrictedFile(
      candidateReportPath,
      candidateDirectory,
      "report.json",
      MAX_REVIEW_REPORT_BYTES,
    );
    state.files.push(candidateReport);
    const candidateReceiptFile = openRestrictedFile(
      candidateReceiptPath,
      candidateDirectory,
      "receipt.json",
      MAX_RECEIPT_BYTES,
    );
    state.files.push(candidateReceiptFile);
    const auditRaw = openRestrictedFile(
      auditRawPath,
      auditDirectory,
      "raw-audit.json",
      MAX_AUDIT_REPORT_BYTES,
    );
    state.files.push(auditRaw);
    const auditReceiptFile = openRestrictedFile(
      auditReceiptPath,
      auditDirectory,
      "receipt.json",
      MAX_RECEIPT_BYTES,
    );
    state.files.push(auditReceiptFile);
    const finalDecisionFile = openRestrictedFile(
      finalDecisionPath,
      decisionDirectory,
      "final-decision.json",
      MAX_DECISION_BYTES,
    );
    state.files.push(finalDecisionFile);

    for (const relativePath of PROJECT_DIRECTORY_PATHS) {
      state.directories.push(openProjectDirectory(canonicalRoot, relativePath));
    }
    const filesByRelativePath = new Map();
    const formalPaths = new Set(Object.values(FORMAL_ARTIFACT_PATHS));
    for (const relativePath of [
      ...SUPPLY_CHAIN_INPUT_PATHS,
      ...Object.values(FORMAL_ARTIFACT_PATHS),
    ]) {
      const file = openProjectFile(
        canonicalRoot,
        relativePath,
        formalPaths.has(relativePath)
          ? "FINAL_ADMISSION_FORMAL_DRIFT"
          : "FINAL_ADMISSION_RECEIPT_DRIFT",
      );
      state.files.push(file);
      filesByRelativePath.set(relativePath, file);
    }
    state.inputHashes = hashesFromHeldFiles(
      filesByRelativePath,
      SUPPLY_CHAIN_INPUT_PATHS,
    );
    state.formalArtifactHashes = Object.fromEntries(
      Object.entries(FORMAL_ARTIFACT_PATHS).map(([key, relativePath]) => [
        key,
        sha256(filesByRelativePath.get(relativePath).bytes),
      ]),
    );
    assertHeldStateCurrent(state);

    const candidateReceipt = parseSupplyChainInputReceipt(
      decodeUtf8(
        candidateReceiptFile.bytes,
        "FINAL_ADMISSION_RECEIPT_BYTES",
        "候选 receipt",
      ),
    );
    const auditReceipt = parseSupplyChainInputReceipt(
      decodeUtf8(
        auditReceiptFile.bytes,
        "FINAL_ADMISSION_RECEIPT_BYTES",
        "audit receipt",
      ),
    );
    if (!candidateReceiptFile.bytes.equals(auditReceiptFile.bytes)) {
      fail("FINAL_ADMISSION_RECEIPT_MISMATCH", "候选与 audit receipt 字节不一致。" );
    }
    assertHeldInputReceipt(candidateReceipt, state.inputHashes);
    assertHeldInputReceipt(auditReceipt, state.inputHashes);
    if (candidateReceipt.runtime.role !== "primary" || auditReceipt.runtime.role !== "primary") {
      fail("FINAL_ADMISSION_RECEIPT_MISMATCH", "最终准入证据只接受 primary runtime receipt。" );
    }
    assertReceiptCurrent(canonicalRoot, candidateReceipt, npmVersionsByRole);
    assertReceiptCurrent(canonicalRoot, auditReceipt, npmVersionsByRole);
    state.candidateReceipt = candidateReceipt;
    state.auditReceipt = auditReceipt;

    const manifest = readAndValidateManifest(canonicalRoot);
    const lockfile = readAndValidateLockfile(canonicalRoot, manifest);
    const lockedPackages = collectLockedPackages(lockfile, manifest);
    const policy = readAndValidateDependencyPolicy(canonicalRoot);
    const licenseEvidence = readAndValidateDependencyLicenseEvidence(canonicalRoot);
    const review = validateCandidateReport({
      bytes: candidateReport.bytes,
      licenseEvidence,
      lockedPackages,
      policy,
      receipt: candidateReceipt,
    });
    if (!Buffer.from(supplyChainInputReceiptBytes(review.receipt), "utf8")
      .equals(candidateReceiptFile.bytes)) {
      fail("FINAL_ADMISSION_RECEIPT_MISMATCH", "候选报告内嵌 receipt 与 sidecar 字节不一致。" );
    }
    state.candidatePackages = review.packages.map((package_) => Object.freeze({
      evidenceSha256: package_.evidenceSha256,
      identity: package_.identity,
    }));
    Object.freeze(state.candidatePackages);

    const audit = parseNpmAuditReport({
      expectedDependencyCount: Object.keys(lockfile.packages).length - 1,
      policy,
      stdout: decodeUtf8(
        auditRaw.bytes,
        "FINAL_ADMISSION_AUDIT_BYTES",
        "npm audit 原始报告",
      ),
    });
    if (audit.outcome !== "pass" || audit.blocking.length !== 0) {
      fail("FINAL_ADMISSION_AUDIT_BLOCKED", "最终准入只接受漏洞策略 outcome=pass 的 audit 证据。" );
    }

    const decision = parseFinalAdmissionDecision(decodeUtf8(
      finalDecisionFile.bytes,
      "FINAL_ADMISSION_DECISION_BYTES",
      "最终准入决定",
    ));
    const formalArtifactHashes = state.formalArtifactHashes;
    const expectedBindings = {
      admissionsSha256: formalArtifactHashes.admissionsSha256,
      auditRawSha256: sha256(auditRaw.bytes),
      auditReceiptSha256: sha256(auditReceiptFile.bytes),
      candidateReceiptSha256: sha256(candidateReceiptFile.bytes),
      candidateReportSha256: sha256(candidateReport.bytes),
      dependencyEvidenceSha256: formalArtifactHashes.dependencyEvidenceSha256,
      noticesSha256: formalArtifactHashes.noticesSha256,
      sbomSha256: formalArtifactHashes.sbomSha256,
    };
    assertDecisionBindings(decision, expectedBindings);
    state.summary = freezeSummary({
      ...SUMMARY_ENVELOPE,
      decisionId: decision.decisionId,
      decidedAt: decision.decidedAt,
      ...expectedBindings,
      finalDecisionSha256: sha256(finalDecisionFile.bytes),
      inputs: Object.fromEntries(SUPPLY_CHAIN_INPUT_PATHS.map((path) => [
        path,
        state.inputHashes[path],
      ])),
      candidatePackageCount: review.packages.length,
      audit: {
        outcome: audit.outcome,
        dependencyTotal: audit.metadata.dependencies.total,
        total: audit.metadata.vulnerabilities.total,
        info: audit.metadata.vulnerabilities.info,
        low: audit.metadata.vulnerabilities.low,
        moderate: audit.metadata.vulnerabilities.moderate,
        high: audit.metadata.vulnerabilities.high,
        critical: audit.metadata.vulnerabilities.critical,
      },
    });
    assertEvidenceCurrent(state);

    return Object.freeze({
      assertCurrent() {
        return assertEvidenceCurrent(state);
      },
      close() {
        if (!state.closed) closeHeldState(state);
      },
      summary: state.summary,
    });
  } catch (error) {
    closeHeldState(state);
    throw error;
  }
}

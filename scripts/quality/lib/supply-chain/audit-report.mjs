import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { NpmIsolationError, fail } from "./errors.mjs";
import {
  supplyChainInputReceiptBytes,
  supplyChainInputReceiptSha256,
  validateSupplyChainInputReceipt,
} from "./input-receipt.mjs";
import { assertNoDuplicateJsonKeys } from "./strict-json.mjs";

const REPORT_DIRECTORY_PREFIX = "axial-muse-npm-audit-";
const REPORT_FILE_NAME = "raw-audit.json";
const RECEIPT_FILE_NAME = "receipt.json";
const CLEANUP_QUARANTINE_PREFIX = ".axial-muse-npm-audit-cleanup-";
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const SEVERITIES = Object.freeze(["info", "low", "moderate", "high", "critical"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function resolveTemporaryParent(temporaryParent) {
  if (typeof temporaryParent !== "string" || temporaryParent === "") {
    fail("SUPPLY_CHAIN_AUDIT_REPORT_TEMP", "npm audit 报告临时父目录不合法。");
  }
  let canonicalTmp;
  let parent;
  try {
    canonicalTmp = realpathSync("/tmp");
    parent = realpathSync(temporaryParent);
  } catch {
    fail("SUPPLY_CHAIN_AUDIT_REPORT_TEMP", "npm audit 报告临时父目录不可用。");
  }
  let stat;
  try {
    stat = lstatSync(parent);
  } catch {
    fail("SUPPLY_CHAIN_AUDIT_REPORT_TEMP", "npm audit 报告临时父目录不可确认。");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isInside(canonicalTmp, parent)) {
    fail("SUPPLY_CHAIN_AUDIT_REPORT_TEMP", "npm audit 报告只能创建在 /tmp 的真实目录内。");
  }
  return parent;
}

function statIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & 0o177777,
    nlink: stat.nlink,
    uid: stat.uid,
  };
}

function identitiesEqual(left, right) {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid;
}

function sameCreatedObject(left, right) {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino
    && (left.mode & 0o170000) === (right.mode & 0o170000)
    && left.nlink === right.nlink
    && left.uid === right.uid;
}

function sameOwnedInode(left, right) {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid;
}

function validateOwnedStat(stat, { directory, mode }) {
  return !stat.isSymbolicLink()
    && (directory ? stat.isDirectory() : stat.isFile())
    && (stat.mode & 0o777) === mode
    && (!directory ? stat.nlink === 1 : stat.nlink >= 2)
    && (typeof process.getuid !== "function" || stat.uid === process.getuid());
}

function openOwnedPath(path, { createdIdentity, directory, mode, code }) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      (directory ? constants.O_RDONLY : constants.O_RDWR)
        | constants.O_NOFOLLOW
        | (directory ? constants.O_DIRECTORY : 0),
    );
    const openedBeforeMode = statIdentity(fstatSync(descriptor));
    if (createdIdentity !== undefined && !sameCreatedObject(openedBeforeMode, createdIdentity)) {
      fail(code, "npm audit 报告路径在创建后、取得句柄前被替换。");
    }
    fchmodSync(descriptor, mode);
    const descriptorStat = fstatSync(descriptor);
    const pathStat = lstatSync(path);
    if (
      !validateOwnedStat(descriptorStat, { directory, mode })
      || !validateOwnedStat(pathStat, { directory, mode })
      || !identitiesEqual(statIdentity(descriptorStat), statIdentity(pathStat))
    ) {
      fail(code, "npm audit 报告路径类型、权限、链接或所有者不受控。");
    }
    return {
      descriptor,
      identity: statIdentity(descriptorStat),
      snapshot: null,
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 下面统一按无法取得所有权句柄失败。
      }
    }
    if (error instanceof NpmIsolationError) throw error;
    fail(code, "npm audit 报告路径无法取得受控所有权句柄。");
  }
}

function assertHeldPath(path, ownership, { directory, mode, code }) {
  let descriptorStat;
  let pathStat;
  try {
    descriptorStat = fstatSync(ownership.descriptor);
    pathStat = lstatSync(path);
  } catch {
    fail(code, "npm audit 报告路径所有权无法复核。");
  }
  if (
    !validateOwnedStat(descriptorStat, { directory, mode })
    || !validateOwnedStat(pathStat, { directory, mode })
    || !identitiesEqual(statIdentity(descriptorStat), ownership.identity)
    || !identitiesEqual(statIdentity(pathStat), ownership.identity)
  ) {
    fail(code, "npm audit 报告路径不再属于本次任务。");
  }
}

function refreshHeldDirectoryIdentity(path, ownership, expectedNlink, code) {
  let descriptorStat;
  let pathStat;
  try {
    descriptorStat = fstatSync(ownership.descriptor);
    pathStat = lstatSync(path);
  } catch {
    fail(code, "npm audit quarantine 目录身份无法复核。");
  }
  const descriptorIdentity = statIdentity(descriptorStat);
  const pathIdentity = statIdentity(pathStat);
  if (
    !validateOwnedStat(descriptorStat, { directory: true, mode: 0o700 })
    || !validateOwnedStat(pathStat, { directory: true, mode: 0o700 })
    || descriptorIdentity.nlink !== expectedNlink
    || pathIdentity.nlink !== expectedNlink
    || !sameOwnedInode(descriptorIdentity, ownership.identity)
    || !identitiesEqual(descriptorIdentity, pathIdentity)
  ) {
    fail(code, "npm audit quarantine 目录在链接数变化期间被替换。");
  }
  ownership.identity = descriptorIdentity;
}

function descriptorMatchesSnapshot(ownership) {
  if (!Buffer.isBuffer(ownership.snapshot)) return false;
  const actual = Buffer.alloc(ownership.snapshot.length);
  let offset = 0;
  try {
    while (offset < actual.length) {
      const count = readSync(
        ownership.descriptor,
        actual,
        offset,
        actual.length - offset,
        offset,
      );
      if (count === 0) return false;
      offset += count;
    }
    return fstatSync(ownership.descriptor).size === ownership.snapshot.length
      && actual.equals(ownership.snapshot);
  } finally {
    actual.fill(0);
  }
}

function closeOwnership(ownership) {
  if (ownership?.descriptor === null || ownership?.descriptor === undefined) return;
  closeSync(ownership.descriptor);
  ownership.descriptor = null;
  if (Buffer.isBuffer(ownership.snapshot)) ownership.snapshot.fill(0);
  ownership.snapshot = null;
}

function closeOwnershipQuietly(ownership) {
  try {
    closeOwnership(ownership);
  } catch {
    if (Buffer.isBuffer(ownership?.snapshot)) ownership.snapshot.fill(0);
    if (ownership) {
      ownership.descriptor = null;
      ownership.snapshot = null;
    }
  }
}

function syncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
    fsyncSync(descriptor);
  } catch {
    fail("SUPPLY_CHAIN_AUDIT_REPORT_SYNC", "npm audit 报告目录无法持久化同步。");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateCount(value, pointer) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("SUPPLY_CHAIN_AUDIT_REPORT_INPUT", `${pointer} 必须是非负安全整数。`);
  }
  return value;
}

export function buildAuditAggregate(audit) {
  if (
    !isPlainObject(audit)
    || audit.auditReportVersion !== 2
    || (audit.outcome !== "pass" && audit.outcome !== "blocked")
    || (audit.exitCode !== 0 && audit.exitCode !== 1)
    || !isPlainObject(audit.metadata)
    || !isPlainObject(audit.metadata.dependencies)
    || !isPlainObject(audit.metadata.vulnerabilities)
    || !Array.isArray(audit.reportOnly)
    || !Array.isArray(audit.blocking)
  ) {
    fail("SUPPLY_CHAIN_AUDIT_REPORT_INPUT", "已解析 npm audit 结果不符合报告输入契约。");
  }
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [
    severity,
    validateCount(
      audit.metadata.vulnerabilities[severity],
      `audit.metadata.vulnerabilities.${severity}`,
    ),
  ]));
  const total = validateCount(
    audit.metadata.vulnerabilities.total,
    "audit.metadata.vulnerabilities.total",
  );
  const dependencyTotal = validateCount(
    audit.metadata.dependencies.total,
    "audit.metadata.dependencies.total",
  );
  if (
    SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0) !== total
    || audit.reportOnly.length + audit.blocking.length !== total
    || (audit.outcome === "pass") !== (audit.blocking.length === 0)
    || (audit.exitCode === 0) !== (audit.blocking.length === 0)
  ) {
    fail("SUPPLY_CHAIN_AUDIT_REPORT_INPUT", "已解析 npm audit 聚合与分类不一致。");
  }
  return Object.freeze({
    auditReportVersion: 2,
    outcome: audit.outcome,
    exitCode: audit.exitCode,
    dependencyTotal,
    total,
    info: counts.info,
    low: counts.low,
    moderate: counts.moderate,
    high: counts.high,
    critical: counts.critical,
    reportOnly: audit.reportOnly.length,
    blocking: audit.blocking.length,
  });
}

function validateRawAuditBytes(stdout, aggregate) {
  if (typeof stdout !== "string" || stdout.length === 0) {
    fail("SUPPLY_CHAIN_AUDIT_REPORT_INPUT", "原始 npm audit JSON 为空或不是字符串。");
  }
  const bytes = Buffer.from(stdout, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_REPORT_BYTES) {
    fail("SUPPLY_CHAIN_AUDIT_REPORT_INPUT", "原始 npm audit JSON 超出受控大小。");
  }
  let raw;
  assertNoDuplicateJsonKeys(stdout, {
    duplicateCode: "SUPPLY_CHAIN_AUDIT_REPORT_INPUT",
    invalidCode: "SUPPLY_CHAIN_AUDIT_REPORT_INPUT",
    label: "原始 npm audit JSON",
  });
  try {
    raw = JSON.parse(stdout);
  } catch {
    fail("SUPPLY_CHAIN_AUDIT_REPORT_INPUT", "原始 npm audit JSON 无法解析。");
  }
  const counts = raw?.metadata?.vulnerabilities;
  if (
    !isPlainObject(raw)
    || raw.auditReportVersion !== aggregate.auditReportVersion
    || !isPlainObject(raw.vulnerabilities)
    || !isPlainObject(counts)
    || !isPlainObject(raw.metadata.dependencies)
    || raw.metadata.dependencies.total !== aggregate.dependencyTotal
    || counts.total !== aggregate.total
    || Object.keys(raw.vulnerabilities).length !== aggregate.total
    || SEVERITIES.some((severity) => counts[severity] !== aggregate[severity])
  ) {
    fail("SUPPLY_CHAIN_AUDIT_REPORT_INPUT", "原始 npm audit JSON 与已解析聚合不一致。");
  }
  return bytes;
}

function assertReportStateOwned(state, code) {
  assertHeldPath(state.directory, state.directoryOwnership, {
    code,
    directory: true,
    mode: 0o700,
  });
  const expectedEntries = [
    ...(state.receiptOwnership === null ? [] : [RECEIPT_FILE_NAME]),
    ...(state.reportOwnership === null ? [] : [REPORT_FILE_NAME]),
  ].sort();
  let entries;
  try {
    entries = readdirSync(state.directory).sort();
  } catch {
    fail(code, "npm audit 报告目录内容无法复核。");
  }
  if (
    entries.length !== expectedEntries.length
    || entries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    fail(code, "npm audit 报告目录包含不属于本次任务的内容。");
  }
  if (state.reportOwnership !== null) {
    assertHeldPath(state.reportPath, state.reportOwnership, {
      code,
      directory: false,
      mode: 0o600,
    });
    if (!descriptorMatchesSnapshot(state.reportOwnership)) {
      fail(code, "npm audit 报告字节在所有权核验期间发生变化。");
    }
  }
  if (state.receiptOwnership !== null) {
    assertHeldPath(state.receiptPath, state.receiptOwnership, {
      code,
      directory: false,
      mode: 0o600,
    });
    if (!descriptorMatchesSnapshot(state.receiptOwnership)) {
      fail(code, "npm audit receipt 字节在所有权核验期间发生变化。");
    }
  }
}

function removeUnfinishedReport(state, syncDirectoryPath) {
  let quarantineDirectory = null;
  let quarantineOwnership = null;
  try {
    quarantineDirectory = mkdtempSync(join(state.parent, CLEANUP_QUARANTINE_PREFIX));
    const createdIdentity = statIdentity(lstatSync(quarantineDirectory));
    quarantineOwnership = openOwnedPath(quarantineDirectory, {
      code: "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
      createdIdentity,
      directory: true,
      mode: 0o700,
    });
    const quarantinePath = join(quarantineDirectory, basename(state.directory));
    renameSync(state.directory, quarantinePath);
    syncDirectoryPath(state.parent);
    fsyncSync(quarantineOwnership.descriptor);
    refreshHeldDirectoryIdentity(
      quarantineDirectory,
      quarantineOwnership,
      3,
      "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
    );
    assertHeldPath(quarantineDirectory, quarantineOwnership, {
      code: "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
      directory: true,
      mode: 0o700,
    });
    assertHeldPath(quarantinePath, state.directoryOwnership, {
      code: "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
      directory: true,
      mode: 0o700,
    });
    const expectedEntries = [
      ...(state.receiptOwnership === null ? [] : [RECEIPT_FILE_NAME]),
      ...(state.reportOwnership === null ? [] : [REPORT_FILE_NAME]),
    ].sort();
    const entries = readdirSync(quarantinePath).sort();
    if (
      entries.length !== expectedEntries.length
      || entries.some((entry, index) => entry !== expectedEntries[index])
    ) {
      fail(
        "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
        "npm audit 隔离目录包含不属于本次任务的内容；当前状态已保留。",
      );
    }
    if (state.reportOwnership !== null) {
      const quarantineReportPath = join(quarantinePath, REPORT_FILE_NAME);
      assertHeldPath(quarantineReportPath, state.reportOwnership, {
        code: "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
        directory: false,
        mode: 0o600,
      });
      if (!descriptorMatchesSnapshot(state.reportOwnership)) {
        fail(
          "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
          "npm audit 隔离报告字节发生变化；外部状态已保留。",
        );
      }
      unlinkSync(quarantineReportPath);
      fsyncSync(state.directoryOwnership.descriptor);
      closeOwnership(state.reportOwnership);
      state.reportOwnership = null;
    }
    if (state.receiptOwnership !== null) {
      const quarantineReceiptPath = join(quarantinePath, RECEIPT_FILE_NAME);
      assertHeldPath(quarantineReceiptPath, state.receiptOwnership, {
        code: "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
        directory: false,
        mode: 0o600,
      });
      if (!descriptorMatchesSnapshot(state.receiptOwnership)) {
        fail(
          "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
          "npm audit 隔离 receipt 字节发生变化；外部状态已保留。",
        );
      }
      unlinkSync(quarantineReceiptPath);
      fsyncSync(state.directoryOwnership.descriptor);
      closeOwnership(state.receiptOwnership);
      state.receiptOwnership = null;
    }
    rmdirSync(quarantinePath);
    fsyncSync(quarantineOwnership.descriptor);
    closeOwnership(state.directoryOwnership);
    state.directoryOwnership = null;
    refreshHeldDirectoryIdentity(
      quarantineDirectory,
      quarantineOwnership,
      2,
      "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
    );
    if (readdirSync(quarantineDirectory).length !== 0) {
      fail(
        "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
        "npm audit quarantine 包含来源不明的额外内容。",
      );
    }
    assertHeldPath(quarantineDirectory, quarantineOwnership, {
      code: "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
      directory: true,
      mode: 0o700,
    });
    rmdirSync(quarantineDirectory);
    syncDirectoryPath(state.parent);
    closeOwnership(quarantineOwnership);
  } catch (error) {
    closeOwnershipQuietly(state.reportOwnership);
    closeOwnershipQuietly(state.receiptOwnership);
    closeOwnershipQuietly(state.directoryOwnership);
    closeOwnershipQuietly(quarantineOwnership);
    if (
      error instanceof NpmIsolationError
      && error.code === "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN"
    ) {
      throw error;
    }
    fail(
      "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
      "未完成 npm audit 报告无法安全隔离并确认所有权；未知状态已保留。",
    );
  }
}

export function writeRestrictedAuditReport({
  audit,
  receipt,
  stdout,
  temporaryParent = "/tmp",
} = {}, {
  syncFile = fsyncSync,
  syncDirectoryPath = syncDirectory,
} = {}) {
  if (typeof syncFile !== "function" || typeof syncDirectoryPath !== "function") {
    fail("SUPPLY_CHAIN_AUDIT_REPORT_ORCHESTRATION", "npm audit 报告写入依赖不合法。");
  }
  const aggregate = buildAuditAggregate(audit);
  const bytes = validateRawAuditBytes(stdout, aggregate);
  const validatedReceipt = validateSupplyChainInputReceipt(receipt, {
    code: "SUPPLY_CHAIN_AUDIT_REPORT_INPUT",
  });
  const receiptText = supplyChainInputReceiptBytes(validatedReceipt);
  const receiptBytes = Buffer.from(receiptText, "utf8");
  const parent = resolveTemporaryParent(temporaryParent);
  const state = {
    directory: null,
    directoryOwnership: null,
    parent,
    receiptOwnership: null,
    receiptPath: null,
    reportOwnership: null,
    reportPath: null,
  };
  let complete = false;
  try {
    state.directory = mkdtempSync(join(parent, REPORT_DIRECTORY_PREFIX));
    const createdDirectoryIdentity = statIdentity(lstatSync(state.directory));
    state.directoryOwnership = openOwnedPath(state.directory, {
      code: "SUPPLY_CHAIN_AUDIT_REPORT_PERMISSIONS",
      createdIdentity: createdDirectoryIdentity,
      directory: true,
      mode: 0o700,
    });
    state.reportPath = join(state.directory, REPORT_FILE_NAME);
    const descriptor = openSync(
      state.reportPath,
      constants.O_RDWR
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    state.reportOwnership = {
      descriptor,
      identity: statIdentity(fstatSync(descriptor)),
      snapshot: Buffer.from(bytes),
    };
    fchmodSync(descriptor, 0o600);
    const descriptorStat = fstatSync(descriptor);
    if (!validateOwnedStat(descriptorStat, { directory: false, mode: 0o600 })) {
      fail(
        "SUPPLY_CHAIN_AUDIT_REPORT_PERMISSIONS",
        "npm audit 报告类型、权限、链接或所有者不受控。",
      );
    }
    state.reportOwnership.identity = statIdentity(descriptorStat);
    writeFileSync(descriptor, bytes);
    syncFile(descriptor);
    state.receiptPath = join(state.directory, RECEIPT_FILE_NAME);
    const receiptDescriptor = openSync(
      state.receiptPath,
      constants.O_RDWR
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    state.receiptOwnership = {
      descriptor: receiptDescriptor,
      identity: statIdentity(fstatSync(receiptDescriptor)),
      snapshot: Buffer.from(receiptBytes),
    };
    fchmodSync(receiptDescriptor, 0o600);
    const receiptDescriptorStat = fstatSync(receiptDescriptor);
    if (!validateOwnedStat(receiptDescriptorStat, { directory: false, mode: 0o600 })) {
      fail(
        "SUPPLY_CHAIN_AUDIT_REPORT_PERMISSIONS",
        "npm audit receipt 类型、权限、链接或所有者不受控。",
      );
    }
    state.receiptOwnership.identity = statIdentity(receiptDescriptorStat);
    writeFileSync(receiptDescriptor, receiptBytes);
    syncFile(receiptDescriptor);
    syncDirectoryPath(state.directory);
    syncDirectoryPath(parent);
    assertReportStateOwned(state, "SUPPLY_CHAIN_AUDIT_REPORT_UNCERTAIN");
    const rawSha256 = createHash("sha256").update(bytes).digest("hex");
    closeOwnership(state.reportOwnership);
    state.reportOwnership = null;
    closeOwnership(state.receiptOwnership);
    state.receiptOwnership = null;
    closeOwnership(state.directoryOwnership);
    state.directoryOwnership = null;
    complete = true;
    return Object.freeze({
      aggregate,
      directory: state.directory,
      path: state.reportPath,
      rawSha256,
      receiptPath: state.receiptPath,
      receiptSha256: supplyChainInputReceiptSha256(validatedReceipt),
    });
  } catch (error) {
    if (!complete && state.directory !== null && state.directoryOwnership !== null) {
      removeUnfinishedReport(state, syncDirectoryPath);
    } else if (!complete && state.directory !== null) {
      fail(
        "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
        "npm audit 报告目录创建后未能取得所有权句柄；路径已保留。",
      );
    }
    if (error instanceof NpmIsolationError) throw error;
    fail("SUPPLY_CHAIN_AUDIT_REPORT_WRITE", "npm audit 报告写入或同步失败。");
  }
}

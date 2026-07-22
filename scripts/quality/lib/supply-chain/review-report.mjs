import { createHash } from "node:crypto";
import { fail } from "./errors.mjs";
import { validateSupplyChainInputReceipt } from "./input-receipt.mjs";
import { exactPackageIdentity } from "./lockfile.mjs";
import {
  classifyExactPackageLicenseForReport,
  validateDependencyLicenseEvidenceGraph,
  validateDependencyLicenseEvidenceObject,
  validatePackageLicenseEvidence,
} from "./license-evidence.mjs";
import {
  packageEvidenceObjectFromTarballInspection,
  packageEvidenceSha256FromTarballInspection,
} from "./notices.mjs";
import { validateDependencyPolicyObject } from "./policy.mjs";
import { canonicalJsonBytes } from "./spdx.mjs";

const MAX_PACKAGES = 50_000;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;
const SHA512_INTEGRITY = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
const LOCKED_PACKAGE_KEYS = Object.freeze([
  "hasInstallScript",
  "identity",
  "integrity",
  "name",
  "paths",
  "resolved",
  "version",
]);
const INSPECTION_KEYS = Object.freeze([
  "actualHasInstallScript",
  "bindingGyp",
  "description",
  "effectiveInstallScripts",
  "entryCount",
  "gypfile",
  "homepage",
  "identity",
  "implicitNodeGyp",
  "integrity",
  "integritySha512",
  "licenseDeclared",
  "licenseFiles",
  "noticeFiles",
  "packageJsonSha256",
  "scripts",
  "scriptsSha256",
]);
const LEGAL_FILE_KEYS = Object.freeze(["path", "rawSha256", "size", "text"]);
const INSTALL_SCRIPT_NAMES = Object.freeze(["preinstall", "install", "postinstall"]);
function failReportLimit() {
  fail("SUPPLY_CHAIN_REVIEW_LIMIT", "候选审查报告超过受控字节上限。" );
}

function addMeasuredBytes(state, count) {
  if (!Number.isSafeInteger(count) || count < 0 || count > state.remaining) {
    failReportLimit();
  }
  state.total += count;
  state.remaining -= count;
}

function measureJsonString(value, state) {
  addMeasuredBytes(state, 2);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      addMeasuredBytes(state, 2);
    } else if (code <= 0x1f) {
      addMeasuredBytes(
        state,
        code === 0x08
          || code === 0x09
          || code === 0x0a
          || code === 0x0c
          || code === 0x0d
          ? 2
          : 6,
      );
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        addMeasuredBytes(state, 4);
        index += 1;
      } else {
        addMeasuredBytes(state, 6);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      addMeasuredBytes(state, 6);
    } else if (code <= 0x7f) {
      addMeasuredBytes(state, 1);
    } else if (code <= 0x7ff) {
      addMeasuredBytes(state, 2);
    } else {
      addMeasuredBytes(state, 3);
    }
  }
}

function measureCanonicalJsonValue(value, depth, state) {
  if (typeof value === "string") {
    measureJsonString(value, state);
    return;
  }
  if (value === null) {
    addMeasuredBytes(state, 4);
    return;
  }
  if (typeof value === "boolean") {
    addMeasuredBytes(state, value ? 4 : 5);
    return;
  }
  if (typeof value === "number") {
    addMeasuredBytes(state, Buffer.byteLength(JSON.stringify(value), "utf8"));
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      addMeasuredBytes(state, 2);
      return;
    }
    addMeasuredBytes(state, 2);
    for (const [index, child] of value.entries()) {
      addMeasuredBytes(state, (depth + 1) * 2);
      measureCanonicalJsonValue(child, depth + 1, state);
      if (index < value.length - 1) addMeasuredBytes(state, 1);
      addMeasuredBytes(state, 1);
    }
    addMeasuredBytes(state, depth * 2 + 1);
    return;
  }

  if (!isPlainObject(value)) {
    fail("SUPPLY_CHAIN_REVIEW_INPUT", "候选审查报告包含不可序列化值。" );
  }
  const keys = Object.keys(value).sort(compareBytes);
  if (keys.length === 0) {
    addMeasuredBytes(state, 2);
    return;
  }
  addMeasuredBytes(state, 2);
  for (const [index, key] of keys.entries()) {
    addMeasuredBytes(state, (depth + 1) * 2);
    measureJsonString(key, state);
    addMeasuredBytes(state, 2);
    measureCanonicalJsonValue(value[key], depth + 1, state);
    if (index < keys.length - 1) addMeasuredBytes(state, 1);
    addMeasuredBytes(state, 1);
  }
  addMeasuredBytes(state, depth * 2 + 1);
}

function canonicalJsonByteLengthWithin(value, depth, limit) {
  const state = { remaining: limit, total: 0 };
  measureCanonicalJsonValue(value, depth, state);
  return state.total;
}

export const SUPPLY_CHAIN_REVIEW_REPORT_ENVELOPE = Object.freeze({
  version: "0.2.0",
  kind: "axial_muse_supply_chain_review_report",
  status: "candidate",
  owner: "AxialMuseWebsite",
});

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, pointer) {
  if (!isPlainObject(value)) {
    fail("SUPPLY_CHAIN_REVIEW_INPUT", `${pointer} 必须是 object。`);
  }
  const actual = Object.keys(value).sort(compareBytes);
  const wanted = [...expected].sort(compareBytes);
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    fail("SUPPLY_CHAIN_REVIEW_INPUT", `${pointer} 字段集合不符合候选审查输入 schema。`);
  }
}

function lockedPathPackageName(path, pointer) {
  if (
    typeof path !== "string"
    || path === ""
    || path.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    fail("SUPPLY_CHAIN_REVIEW_INPUT", `${pointer} 不是受控 node_modules 路径。`);
  }
  const segments = path.split("/");
  let index = 0;
  let packageName = null;
  while (index < segments.length) {
    if (segments[index] !== "node_modules") {
      fail("SUPPLY_CHAIN_REVIEW_INPUT", `${pointer} 不是受控 node_modules 路径。`);
    }
    index += 1;
    if ((segments[index] ?? "").startsWith("@")) {
      const scope = segments[index];
      const name = segments[index + 1];
      packageName = `${scope}/${name ?? ""}`;
      index += 2;
    } else {
      packageName = segments[index] ?? "";
      index += 1;
    }
    try {
      exactPackageIdentity(packageName, "0.0.0");
    } catch {
      fail("SUPPLY_CHAIN_REVIEW_INPUT", `${pointer} 包含非法包名。`);
    }
  }
  return packageName;
}

function validateLockedPackage(value, index) {
  const pointer = `$lockedPackages[${index}]`;
  assertExactKeys(value, LOCKED_PACKAGE_KEYS, pointer);
  const identity = exactPackageIdentity(value.name, value.version);
  if (value.identity !== identity || typeof value.hasInstallScript !== "boolean") {
    fail("SUPPLY_CHAIN_REVIEW_DRIFT", `${pointer} 身份或脚本标记发生漂移。`);
  }
  const integrityMatch = SHA512_INTEGRITY.exec(value.integrity ?? "");
  const integrityDigest = integrityMatch === null
    ? null
    : Buffer.from(integrityMatch[1], "base64");
  if (
    integrityDigest === null
    || integrityDigest.length !== 64
    || integrityDigest.toString("base64") !== integrityMatch[1]
  ) {
    fail("SUPPLY_CHAIN_REVIEW_INPUT", `${pointer}.integrity 不是 canonical SHA-512 SRI。`);
  }
  if (!Array.isArray(value.paths) || value.paths.length === 0) {
    fail("SUPPLY_CHAIN_REVIEW_INPUT", `${pointer}.paths 必须是非空 array。`);
  }
  const paths = value.paths.map((path, pathIndex) => {
    const pathPointer = `${pointer}.paths[${pathIndex}]`;
    // npm registry alias 的安装路径使用依赖键，canonical 身份来自已验证 lock entry.name。
    lockedPathPackageName(path, pathPointer);
    return path;
  });
  const sortedPaths = [...paths].sort(compareBytes);
  if (
    new Set(paths).size !== paths.length
    || paths.some((path, pathIndex) => path !== sortedPaths[pathIndex])
  ) {
    fail("SUPPLY_CHAIN_REVIEW_INPUT", `${pointer}.paths 必须按 UTF-8 字节排序且不重复。`);
  }
  return {
    hasInstallScript: value.hasInstallScript,
    identity,
    integrity: value.integrity,
    integritySha512: integrityDigest.toString("hex"),
    name: value.name,
    paths,
    resolved: value.resolved,
    version: value.version,
  };
}

function validateScriptSnapshot(value, pointer) {
  if (!isPlainObject(value)) {
    fail("SUPPLY_CHAIN_REVIEW_INPUT", `${pointer} 必须是 object。`);
  }
  const entries = Object.entries(value).sort(([left], [right]) => compareBytes(left, right));
  for (const [name, command] of entries) {
    if (
      name === ""
      || /[\u0000-\u001f\u007f]/u.test(name)
      || typeof command !== "string"
      || command.includes("\0")
    ) {
      fail("SUPPLY_CHAIN_REVIEW_INPUT", `${pointer} 包含非法 script。`);
    }
  }
  return Object.fromEntries(entries);
}

function scriptsSha256(scripts) {
  return createHash("sha256")
    .update(`${JSON.stringify(scripts, null, 2)}\n`, "utf8")
    .digest("hex");
}

function validateLegalInspectionFiles(value, pointer, { requireNonEmpty }) {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
    fail("SUPPLY_CHAIN_REVIEW_INPUT", `${pointer} 必须是${requireNonEmpty ? "非空" : ""} array。`);
  }
  for (const [index, file] of value.entries()) {
    assertExactKeys(file, LEGAL_FILE_KEYS, `${pointer}[${index}]`);
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || !HEX_64.test(file.rawSha256 ?? "")) {
      fail("SUPPLY_CHAIN_REVIEW_INPUT", `${pointer}[${index}] 的原始文件证据不完整。`);
    }
  }
}

function expectedEffectiveInstallScripts(inspection, scripts) {
  const expected = {};
  for (const name of INSTALL_SCRIPT_NAMES) {
    if (scripts[name]) expected[name] = scripts[name];
  }
  if (inspection.implicitNodeGyp) expected.install = "node-gyp rebuild";
  return Object.fromEntries(Object.entries(expected).sort(([left], [right]) => compareBytes(left, right)));
}

function validateInspection(value, index, lockedPackage) {
  const pointer = `$inspections[${index}]`;
  assertExactKeys(value, INSPECTION_KEYS, pointer);
  if (value.identity !== lockedPackage.identity || value.integrity !== lockedPackage.integrity) {
    fail("SUPPLY_CHAIN_REVIEW_DRIFT", `${pointer} 与 ${lockedPackage.identity} 的 lock 证据不一致。`);
  }
  if (
    typeof value.actualHasInstallScript !== "boolean"
    || !Number.isSafeInteger(value.entryCount)
    || value.entryCount <= 0
    || !HEX_128.test(value.integritySha512 ?? "")
    || !HEX_64.test(value.scriptsSha256 ?? "")
  ) {
    fail("SUPPLY_CHAIN_REVIEW_INPUT", `${pointer} 缺少严格 tarball 审查元数据。`);
  }
  if (value.integritySha512 !== lockedPackage.integritySha512) {
    fail("SUPPLY_CHAIN_REVIEW_DRIFT", `${pointer}.integritySha512 与 lock integrity 不一致。`);
  }
  const scripts = validateScriptSnapshot(value.scripts, `${pointer}.scripts`);
  if (value.scriptsSha256 !== scriptsSha256(scripts)) {
    fail("SUPPLY_CHAIN_REVIEW_DRIFT", `${pointer}.scriptsSha256 与 scripts 不一致。`);
  }
  validateLegalInspectionFiles(value.licenseFiles, `${pointer}.licenseFiles`, {
    requireNonEmpty: false,
  });
  validateLegalInspectionFiles(value.noticeFiles, `${pointer}.noticeFiles`, {
    requireNonEmpty: false,
  });

  const evidence = packageEvidenceObjectFromTarballInspection({
    inspection: value,
    lockedPackage,
  });
  const expectedInstallScripts = expectedEffectiveInstallScripts(value, scripts);
  if (
    canonicalJsonBytes(evidence.install.scripts) !== canonicalJsonBytes(expectedInstallScripts)
    || Object.values(evidence.install.scripts).some((command) => command.length === 0)
  ) {
    fail("SUPPLY_CHAIN_REVIEW_DRIFT", `${pointer}.effectiveInstallScripts 与 package scripts/gyp 证据不一致。`);
  }
  const actualHasInstallScript = Object.keys(evidence.install.scripts).length > 0;
  if (
    value.actualHasInstallScript !== actualHasInstallScript
    || (actualHasInstallScript && !lockedPackage.hasInstallScript)
  ) {
    fail("SUPPLY_CHAIN_REVIEW_DRIFT", `${pointer} 的有效安装脚本未被 lock 标记。`);
  }
  return evidence;
}

export function validateSupplyChainReviewInspection({ inspection, lockedPackage }) {
  const validatedLockedPackage = validateLockedPackage(lockedPackage, 0);
  return validateInspection(inspection, 0, validatedLockedPackage);
}

function exactIdentityMap(values, type) {
  const byIdentity = new Map();
  for (const [index, value] of values.entries()) {
    const identity = value?.identity;
    if (typeof identity !== "string" || identity === "") {
      fail("SUPPLY_CHAIN_REVIEW_INPUT", `$${type}[${index}].identity 缺失。`);
    }
    if (byIdentity.has(identity)) {
      fail("SUPPLY_CHAIN_REVIEW_DUPLICATE", `${type} 包含重复身份 ${identity}。`);
    }
    byIdentity.set(identity, { index, value });
  }
  return byIdentity;
}

export function createSupplyChainReviewReport(input) {
  assertExactKeys(
    input,
    ["inspections", "licenseEvidence", "lockedPackages", "policy", "receipt"],
    "$review",
  );
  const { lockedPackages, inspections, policy } = input;
  if (
    !Array.isArray(lockedPackages)
    || !Array.isArray(inspections)
    || lockedPackages.length > MAX_PACKAGES
    || inspections.length > MAX_PACKAGES
  ) {
    fail("SUPPLY_CHAIN_REVIEW_INPUT", "lockedPackages/inspections 必须是受控 array。" );
  }
  const validatedPolicy = validateDependencyPolicyObject(policy);
  const validatedLicenseEvidence = validateDependencyLicenseEvidenceObject(
    input.licenseEvidence,
  );
  const receipt = validateSupplyChainInputReceipt(input.receipt, {
    code: "SUPPLY_CHAIN_REVIEW_INPUT",
  });
  const lockedByIdentity = exactIdentityMap(lockedPackages, "lockedPackages");
  const inspectionsByIdentity = exactIdentityMap(inspections, "inspections");
  const lockedIdentities = [...lockedByIdentity.keys()].sort(compareBytes);
  const inspectionIdentities = [...inspectionsByIdentity.keys()].sort(compareBytes);
  if (
    lockedIdentities.length !== inspectionIdentities.length
    || lockedIdentities.some((identity, index) => identity !== inspectionIdentities[index])
  ) {
    fail("SUPPLY_CHAIN_REVIEW_CLOSURE", "tarball inspections 必须与 lockedPackages 一一闭合。" );
  }

  const packages = [];
  const licenseEvidencePackages = [];
  let reportBytes = canonicalJsonByteLengthWithin({
    ...SUPPLY_CHAIN_REVIEW_REPORT_ENVELOPE,
    packages: [],
    receipt,
  }, 0, MAX_REPORT_BYTES - 1) + 1;
  for (const identity of lockedIdentities) {
    const lockedEntry = lockedByIdentity.get(identity);
    const inspectionEntry = inspectionsByIdentity.get(identity);
    const lockedPackage = validateLockedPackage(lockedEntry.value, lockedEntry.index);
    const evidence = validateInspection(
      inspectionEntry.value,
      inspectionEntry.index,
      lockedPackage,
    );
    const evidenceSha256 = packageEvidenceSha256FromTarballInspection({
      inspection: inspectionEntry.value,
      lockedPackage,
    });
    const licensePackage = {
      identity: evidence.identity,
      integrity: evidence.source.integrity,
      licenseDeclared: evidence.legal.licenseDeclared,
      resolved: evidence.source.resolved,
    };
    validatePackageLicenseEvidence({
      evidence: validatedLicenseEvidence,
      licenseFiles: inspectionEntry.value.licenseFiles,
      package_: licensePackage,
    });
    licenseEvidencePackages.push(licensePackage);
    const packageReport = {
      identity: evidence.identity,
      resolved: evidence.source.resolved,
      integrity: evidence.source.integrity,
      packageJsonSha256: evidence.manifest.packageJsonSha256,
      evidenceSha256,
      licenseDeclared: evidence.legal.licenseDeclared,
      licensePolicy: (() => {
        const { licenseConcluded: _licenseConcluded, ...classification } =
          classifyExactPackageLicenseForReport({
            evidence: validatedLicenseEvidence,
            package_: licensePackage,
            policy: validatedPolicy,
          });
        return classification;
      })(),
      homepage: evidence.manifest.homepage,
      description: evidence.manifest.description,
      bindingGyp: evidence.install.bindingGyp,
      gypfile: evidence.install.gypfile,
      implicitNodeGyp: evidence.install.implicitNodeGyp,
      effectiveInstallScripts: evidence.install.scripts,
      licenseFiles: evidence.legal.licenseFiles,
      noticeFiles: evidence.legal.noticeFiles,
    };
    const arrayGrowthBytes = packages.length === 0 ? 8 : 6;
    if (arrayGrowthBytes > MAX_REPORT_BYTES - reportBytes) failReportLimit();
    const packageBytes = canonicalJsonByteLengthWithin(
      packageReport,
      2,
      MAX_REPORT_BYTES - reportBytes - arrayGrowthBytes,
    );
    reportBytes += arrayGrowthBytes + packageBytes;
    packages.push(packageReport);
  }
  validateDependencyLicenseEvidenceGraph({
    evidence: validatedLicenseEvidence,
    packages: licenseEvidencePackages,
  });

  return {
    ...SUPPLY_CHAIN_REVIEW_REPORT_ENVELOPE,
    packages,
    receipt,
  };
}

export function renderSupplyChainReviewReport(input) {
  const bytes = canonicalJsonBytes(createSupplyChainReviewReport(input));
  if (Buffer.byteLength(bytes, "utf8") > MAX_REPORT_BYTES) {
    failReportLimit();
  }
  return bytes;
}

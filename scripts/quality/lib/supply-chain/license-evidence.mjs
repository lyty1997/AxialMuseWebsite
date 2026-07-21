import { createHash } from "node:crypto";
import { readRegularProjectFile } from "./config.mjs";
import { fail, NpmIsolationError } from "./errors.mjs";
import { exactPackageIdentity } from "./lockfile.mjs";
import { classifyLicenseExpression } from "./policy.mjs";
import { canonicalJsonBytes } from "./spdx.mjs";
import { assertNoDuplicateJsonKeys } from "./strict-json.mjs";

export const DEPENDENCY_LICENSE_EVIDENCE_PATH =
  "docs/contracts/dependency-license-evidence.json";
export const D082_LICENSE_EVIDENCE_SHA256 =
  "84cacf1f3eefd0c455e5f1693e5b5b8f7766c5c18c04d6d20c3eb8d914a8b76e";

export const D082_OWNER_EXCEPTION_IDENTITIES = Object.freeze([
  "@jsonjoy.com/json-pointer@1.0.2",
  "@pnpm/config.env-replace@1.1.0",
  "@pnpm/network.ca-file@1.0.2",
  "@swc/counter@0.1.3",
  "@tybys/wasm-util@0.10.3",
  "boolbase@1.0.0",
  "cacheable-request@10.2.14",
  "eastasianwidth@0.2.0",
  "format@0.2.2",
  "glob-to-regex.js@1.2.0",
  "keyv@4.5.4",
  "svg-parser@2.0.4",
]);

const ENVELOPE = Object.freeze({
  version: "0.1.0",
  kind: "axial_muse_dependency_license_evidence",
  status: "active",
  owner: "AxialMuseWebsite",
  decisionId: "D-082",
});
const EVIDENCE_TYPES = new Set([
  "owner-exception",
  "tarball-reviewed-section",
  "upstream-immutable",
]);
const HEX_40 = /^[0-9a-f]{40}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const SHA512_INTEGRITY = /^sha512-([A-Za-z0-9+/]+={0,2})$/u;
const SAFE_LINE = /^[^\u0000-\u001f\u007f]+$/u;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const OWNER_RISK = "missing-independent-complete-legal-text";
const ALLOWED_CONCLUSIONS = new Set([
  "Apache-2.0",
  "Apache-2.0 AND MIT",
  "BSD-2-Clause",
  "CC-BY-4.0",
  "ISC",
  "MIT",
  "Python-2.0",
]);

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, pointer, code = "SUPPLY_CHAIN_LICENSE_EVIDENCE_SCHEMA") {
  if (!isPlainObject(value)) fail(code, `${pointer} 必须是 object。`);
  const actual = Object.keys(value).sort(compareBytes);
  const wanted = [...expected].sort(compareBytes);
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    fail(code, `${pointer} 字段集合不受支持。`);
  }
}

function safeLine(value, pointer, { maxLength = 1000 } = {}) {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length === 0
    || value.length > maxLength
    || !SAFE_LINE.test(value)
  ) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_SCHEMA", `${pointer} 必须是受控非空单行文本。`);
  }
  return value;
}

function hasIsolatedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalIdentity(identity) {
  if (typeof identity !== "string") {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_IDENTITY", "补充证据键必须是精确包身份。");
  }
  const separator = identity.lastIndexOf("@");
  const name = identity.slice(0, separator);
  const version = identity.slice(separator + 1);
  if (exactPackageIdentity(name, version) !== identity) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_IDENTITY", `${identity} 不是规范 name@version。`);
  }
  return { identity, name, version };
}

function validateResolved(value, { identity, name, version }, pointer) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_SOURCE", `${pointer} 不是合法 URL。`);
  }
  const tarballName = name.includes("/") ? name.split("/")[1] : name;
  if (
    url.href !== value
    || url.origin !== "https://registry.npmjs.org"
    || url.pathname !== `/${name}/-/${tarballName}-${version}.tgz`
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_SOURCE", `${identity} 的 resolved 未绑定官方精确 tarball。`);
  }
  return value;
}

function validateIntegrity(value, pointer) {
  const match = SHA512_INTEGRITY.exec(value ?? "");
  const digest = match === null ? null : Buffer.from(match[1], "base64");
  if (
    digest === null
    || digest.length !== 64
    || digest.toString("base64") !== match[1]
  ) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_INTEGRITY", `${pointer} 不是 canonical SHA-512 SRI。`);
  }
  return value;
}

function validateSafeRelativePath(value, pointer, { prefix = null } = {}) {
  const path = safeLine(value, pointer);
  if (
    path.includes("\\")
    || (prefix !== null && !path.startsWith(prefix))
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_SOURCE", `${pointer} 不是受控相对路径。`);
  }
  return path;
}

function validateEvidenceText(value, pointer, expectedSha256) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\r")
    || hasIsolatedSurrogate(value)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_TEXT", `${pointer} 不是受控 LF UTF-8 法律文本。`);
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_SOURCE_BYTES) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_LIMIT", `${pointer} 超过补充证据字节上限。`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedSha256) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_HASH", `${pointer} 与声明的正文摘要不一致。`);
  }
  return value;
}

function validateUpstreamSource(value, pointer) {
  assertExactKeys(
    value,
    ["path", "rawSha256", "repository", "revision", "text"],
    pointer,
  );
  let repository;
  try {
    repository = new URL(value.repository);
  } catch {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_SOURCE", `${pointer}.repository 不是合法 URL。`);
  }
  if (
    repository.href !== value.repository
    || repository.protocol !== "https:"
    || repository.hostname !== "github.com"
    || repository.port !== ""
    || repository.username !== ""
    || repository.password !== ""
    || repository.search !== ""
    || repository.hash !== ""
    || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository.pathname)
  ) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_SOURCE", `${pointer}.repository 不是 canonical GitHub 仓库。`);
  }
  if (!HEX_40.test(value.revision ?? "") || !HEX_64.test(value.rawSha256 ?? "")) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_SOURCE", `${pointer} 缺少 immutable revision 或源摘要。`);
  }
  const path = validateSafeRelativePath(value.path, `${pointer}.path`);
  const text = validateEvidenceText(value.text, `${pointer}.text`, value.rawSha256);
  return {
    repository: value.repository,
    revision: value.revision,
    path,
    rawSha256: value.rawSha256,
    text,
  };
}

function validateTarballSource(value, pointer) {
  assertExactKeys(
    value,
    [
      "endByte",
      "fileRawSha256",
      "path",
      "sectionRawSha256",
      "startByte",
      "text",
    ],
    pointer,
  );
  const path = validateSafeRelativePath(value.path, `${pointer}.path`, { prefix: "package/" });
  if (
    !HEX_64.test(value.fileRawSha256 ?? "")
    || !HEX_64.test(value.sectionRawSha256 ?? "")
    || !Number.isSafeInteger(value.startByte)
    || !Number.isSafeInteger(value.endByte)
    || value.startByte < 0
    || value.endByte <= value.startByte
    || value.endByte - value.startByte > MAX_SOURCE_BYTES
  ) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_SOURCE", `${pointer} 的 tarball 字节区间或摘要不合法。`);
  }
  const text = validateEvidenceText(
    value.text,
    `${pointer}.text`,
    value.sectionRawSha256,
  );
  if (Buffer.byteLength(text, "utf8") !== value.endByte - value.startByte) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_SOURCE", `${pointer} 的区间长度与正文不一致。`);
  }
  return {
    path,
    fileRawSha256: value.fileRawSha256,
    startByte: value.startByte,
    endByte: value.endByte,
    sectionRawSha256: value.sectionRawSha256,
    text,
  };
}

function validateOwnerSource(value, pointer) {
  assertExactKeys(value, ["risk"], pointer);
  if (value.risk !== OWNER_RISK) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_OWNER", `${pointer}.risk 不属于 D-082 精确例外。`);
  }
  return { risk: OWNER_RISK };
}

function validateBindingFields(value, identity, pointer) {
  const parsedIdentity = canonicalIdentity(identity);
  return {
    resolved: validateResolved(value.resolved, parsedIdentity, `${pointer}.resolved`),
    integrity: validateIntegrity(value.integrity, `${pointer}.integrity`),
    licenseDeclared: safeLine(value.licenseDeclared, `${pointer}.licenseDeclared`, {
      maxLength: 200,
    }),
    licenseConcluded: (() => {
      const conclusion = safeLine(
        value.licenseConcluded,
        `${pointer}.licenseConcluded`,
        { maxLength: 200 },
      );
      if (!ALLOWED_CONCLUSIONS.has(conclusion)) {
        fail(
          "SUPPLY_CHAIN_LICENSE_EVIDENCE_DECISION",
          `${pointer}.licenseConcluded 不属于 D-082 获准结论。`,
        );
      }
      return conclusion;
    })(),
    decisionId: (() => {
      if (value.decisionId !== "D-082") {
        fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_DECISION", `${pointer}.decisionId 必须是 D-082。`);
      }
      return value.decisionId;
    })(),
  };
}

function validateLegalEvidenceRecord(value, identity, pointer) {
  assertExactKeys(
    value,
    [
      "decisionId",
      "evidenceType",
      "integrity",
      "limitations",
      "licenseConcluded",
      "licenseDeclared",
      "resolved",
      "source",
    ],
    pointer,
  );
  if (!EVIDENCE_TYPES.has(value.evidenceType)) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_SCHEMA", `${pointer}.evidenceType 不受支持。`);
  }
  if (
    value.evidenceType === "owner-exception"
    && !D082_OWNER_EXCEPTION_IDENTITIES.includes(identity)
  ) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_OWNER", `${identity} 不属于 D-082 owner exception。`);
  }
  const binding = validateBindingFields(value, identity, pointer);
  const limitations = safeLine(value.limitations, `${pointer}.limitations`, {
    maxLength: 2000,
  });
  const source = value.evidenceType === "upstream-immutable"
    ? validateUpstreamSource(value.source, `${pointer}.source`)
    : value.evidenceType === "tarball-reviewed-section"
      ? validateTarballSource(value.source, `${pointer}.source`)
      : validateOwnerSource(value.source, `${pointer}.source`);
  return { ...binding, evidenceType: value.evidenceType, limitations, source };
}

function validateLicenseDecision(value, identity, pointer) {
  assertExactKeys(
    value,
    [
      "decisionId",
      "integrity",
      "licenseConcluded",
      "licenseDeclared",
      "resolved",
    ],
    pointer,
  );
  return validateBindingFields(value, identity, pointer);
}

function validateIdentityMap(value, pointer, validateRecord) {
  if (!isPlainObject(value)) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_SCHEMA", `${pointer} 必须是 object。`);
  }
  const entries = Object.entries(value).sort(([left], [right]) => compareBytes(left, right));
  return Object.fromEntries(entries.map(([identity, record]) => [
    canonicalIdentity(identity).identity,
    validateRecord(record, identity, `${pointer}.${identity}`),
  ]));
}

export function validateDependencyLicenseEvidenceObject(value) {
  assertExactKeys(
    value,
    [
      "decisionId",
      "kind",
      "legalEvidence",
      "licenseDecisions",
      "owner",
      "status",
      "version",
    ],
    "$licenseEvidence",
  );
  for (const [key, expected] of Object.entries(ENVELOPE)) {
    if (value[key] !== expected) {
      fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_SCHEMA", `$licenseEvidence.${key} 不受支持。`);
    }
  }
  const legalEvidence = validateIdentityMap(
    value.legalEvidence,
    "$licenseEvidence.legalEvidence",
    validateLegalEvidenceRecord,
  );
  const licenseDecisions = validateIdentityMap(
    value.licenseDecisions,
    "$licenseEvidence.licenseDecisions",
    validateLicenseDecision,
  );
  const overlap = Object.keys(legalEvidence).filter((identity) => (
    Object.hasOwn(licenseDecisions, identity)
  ));
  if (overlap.length !== 0) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_DUPLICATE", "法律证据与许可证结论不能重复声明同一 identity。");
  }
  return {
    ...ENVELOPE,
    legalEvidence,
    licenseDecisions,
  };
}

export function readAndValidateDependencyLicenseEvidence(root) {
  const text = readRegularProjectFile(
    root,
    DEPENDENCY_LICENSE_EVIDENCE_PATH,
    "SUPPLY_CHAIN_LICENSE_EVIDENCE_FILE",
  );
  assertNoDuplicateJsonKeys(text, {
    duplicateCode: "SUPPLY_CHAIN_LICENSE_EVIDENCE_JSON",
    invalidCode: "SUPPLY_CHAIN_LICENSE_EVIDENCE_JSON",
    label: "依赖补充法律证据",
  });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_JSON", "依赖补充法律证据不是合法 JSON。");
  }
  const evidence = validateDependencyLicenseEvidenceObject(parsed);
  if (canonicalJsonBytes(evidence) !== text) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_CANONICAL", "依赖补充法律证据必须是 canonical JSON 字节。");
  }
  const evidenceCount = Object.keys(evidence.legalEvidence).length;
  const decisionCount = Object.keys(evidence.licenseDecisions).length;
  if (evidenceCount !== 0 || decisionCount !== 0) {
    const typeCounts = Object.values(evidence.legalEvidence).reduce((counts, record) => {
      counts[record.evidenceType] += 1;
      return counts;
    }, {
      "owner-exception": 0,
      "tarball-reviewed-section": 0,
      "upstream-immutable": 0,
    });
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    if (
      evidenceCount !== 58
      || decisionCount !== 29
      || typeCounts["upstream-immutable"] !== 35
      || typeCounts["tarball-reviewed-section"] !== 11
      || typeCounts["owner-exception"] !== 12
      || digest !== D082_LICENSE_EVIDENCE_SHA256
    ) {
      fail(
        "SUPPLY_CHAIN_LICENSE_EVIDENCE_SCOPE",
        "非空 D-082 契约必须精确等于用户批准的 35/11/12 证据与 29 项许可证决定投影。",
      );
    }
    assertD082OwnerExceptionSet(evidence);
  }
  return evidence;
}

function assertDecisionBinding(decision, package_, code) {
  if (
    decision.resolved !== package_.resolved
    || decision.integrity !== package_.integrity
    || decision.licenseDeclared !== package_.licenseDeclared
  ) {
    fail(code, `${package_.identity} 的 D-082 许可证决定与当前精确证据不一致。`);
  }
}

function expectedSupplementFile(record) {
  if (record.evidenceType === "owner-exception") return null;
  if (record.evidenceType === "upstream-immutable") {
    const repository = new URL(record.source.repository);
    return {
      path: [
        "supplement",
        "upstream",
        ...repository.pathname.slice(1).split("/"),
        record.source.revision,
        record.source.path,
      ].join("/"),
      rawSha256: record.source.rawSha256,
      size: Buffer.byteLength(record.source.text, "utf8"),
      text: record.source.text,
    };
  }
  return {
    path: `supplement/tarball/${record.source.path.slice("package/".length)}#bytes-${record.source.startByte}-${record.source.endByte}`,
    rawSha256: record.source.sectionRawSha256,
    size: Buffer.byteLength(record.source.text, "utf8"),
    text: record.source.text,
  };
}

function normalizeSupplementFileForClosure(file, identity) {
  if (!isPlainObject(file)) {
    fail(
      "SUPPLY_CHAIN_LICENSE_EVIDENCE_CLOSURE",
      `${identity} 的补充法律正文记录不是 object。`,
    );
  }
  const actualKeys = Object.keys(file).sort(compareBytes);
  const persistedKeys = ["path", "rawSha256", "text"].sort(compareBytes);
  const inspectionKeys = [...persistedKeys, "size"].sort(compareBytes);
  const hasPersistedKeys = (
    actualKeys.length === persistedKeys.length
    && actualKeys.every((key, index) => key === persistedKeys[index])
  );
  const hasInspectionKeys = (
    actualKeys.length === inspectionKeys.length
    && actualKeys.every((key, index) => key === inspectionKeys[index])
  );
  if (
    (!hasPersistedKeys && !hasInspectionKeys)
    || typeof file.path !== "string"
    || typeof file.rawSha256 !== "string"
    || typeof file.text !== "string"
  ) {
    fail(
      "SUPPLY_CHAIN_LICENSE_EVIDENCE_CLOSURE",
      `${identity} 的补充法律正文记录字段不受支持。`,
    );
  }
  const derivedSize = Buffer.byteLength(file.text, "utf8");
  if (
    hasInspectionKeys
    && (!Number.isSafeInteger(file.size) || file.size !== derivedSize)
  ) {
    fail(
      "SUPPLY_CHAIN_LICENSE_EVIDENCE_CLOSURE",
      `${identity} 的补充法律正文 size 与正文不一致。`,
    );
  }
  return {
    path: file.path,
    rawSha256: file.rawSha256,
    size: derivedSize,
    text: file.text,
  };
}

export function validatePackageLicenseEvidence({ package_, licenseFiles, evidence }) {
  if (!Array.isArray(licenseFiles)) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_CLOSURE", `${package_.identity} 的 licenseFiles 不是 array。`);
  }
  const record = evidence.legalEvidence[package_.identity] ?? null;
  const supplementalFiles = licenseFiles.filter((file) => (
    typeof file?.path === "string" && file.path.startsWith("supplement/")
  ));
  if (record === null) {
    if (licenseFiles.length === 0 || supplementalFiles.length !== 0) {
      fail(
        "SUPPLY_CHAIN_LICENSE_EVIDENCE_CLOSURE",
        `${package_.identity} 缺少 tarball 法律文件且没有精确补充证据。`,
      );
    }
    return null;
  }
  assertDecisionBinding(record, package_, "SUPPLY_CHAIN_LICENSE_EVIDENCE_DRIFT");
  const expected = expectedSupplementFile(record);
  if (expected === null) {
    if (licenseFiles.length !== 0) {
      fail(
        "SUPPLY_CHAIN_LICENSE_EVIDENCE_CLOSURE",
        `${package_.identity} 的 owner exception 不允许伪造法律文件。`,
      );
    }
    return record;
  }
  if (
    licenseFiles.length !== 1
    || supplementalFiles.length !== 1
    || canonicalJsonBytes(normalizeSupplementFileForClosure(
      licenseFiles[0],
      package_.identity,
    )) !== canonicalJsonBytes(expected)
  ) {
    fail(
      "SUPPLY_CHAIN_LICENSE_EVIDENCE_CLOSURE",
      `${package_.identity} 的补充法律正文与 D-082 契约不一致。`,
    );
  }
  return record;
}

export function ownerExceptionAdmissionClarification(record) {
  if (
    record === null
    || typeof record !== "object"
    || record.evidenceType !== "owner-exception"
    || record.source?.risk !== OWNER_RISK
    || typeof record.limitations !== "string"
    || record.limitations.length === 0
  ) {
    fail(
      "SUPPLY_CHAIN_LICENSE_OWNER_RISK",
      "owner exception 无法形成精确 admissions 风险投影。",
    );
  }
  return `D-082 exact owner exception (risk: ${record.source.risk}): ${record.limitations}`;
}

export function validateDependencyLicenseEvidenceGraph({ evidence, packages }) {
  if (!Array.isArray(packages)) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_CLOSURE", "许可证证据闭包需要精确包数组。");
  }
  const byIdentity = new Map();
  for (const package_ of packages) {
    if (
      package_ === null
      || typeof package_ !== "object"
      || typeof package_.identity !== "string"
      || byIdentity.has(package_.identity)
    ) {
      fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_CLOSURE", "许可证证据闭包包含非法或重复包身份。");
    }
    byIdentity.set(package_.identity, package_);
  }
  for (const [identity, decision] of [
    ...Object.entries(evidence.legalEvidence),
    ...Object.entries(evidence.licenseDecisions),
  ]) {
    const package_ = byIdentity.get(identity);
    if (package_ === undefined) {
      fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_STALE", `${identity} 不在当前唯一 lock 图中。`);
    }
    assertDecisionBinding(decision, package_, "SUPPLY_CHAIN_LICENSE_EVIDENCE_DRIFT");
  }
  return byIdentity;
}

export function classifyExactPackageLicense({ package_, policy, evidence }) {
  const decision = evidence.legalEvidence[package_.identity]
    ?? evidence.licenseDecisions[package_.identity]
    ?? null;
  if (decision !== null) {
    assertDecisionBinding(decision, package_, "SUPPLY_CHAIN_LICENSE_DECISION_DRIFT");
    return {
      classification: "review-required",
      licenseConcluded: decision.licenseConcluded,
    };
  }
  return {
    classification: classifyLicenseExpression(package_.licenseDeclared, policy),
    licenseConcluded: package_.licenseDeclared,
  };
}

export function classifyExactPackageLicenseForReport({ package_, policy, evidence }) {
  try {
    return {
      ...classifyExactPackageLicense({ package_, policy, evidence }),
      code: null,
    };
  } catch (error) {
    if (
      error instanceof NpmIsolationError
      && [
        "SUPPLY_CHAIN_LICENSE_COMPOUND",
        "SUPPLY_CHAIN_LICENSE_CUSTOM",
        "SUPPLY_CHAIN_LICENSE_DENIED",
        "SUPPLY_CHAIN_LICENSE_UNKNOWN",
      ].includes(error.code)
    ) {
      return { classification: "blocked", code: error.code, licenseConcluded: null };
    }
    throw error;
  }
}

export function assertD082OwnerExceptionSet(evidence) {
  const actual = Object.entries(evidence.legalEvidence)
    .filter(([, record]) => record.evidenceType === "owner-exception")
    .map(([identity]) => identity)
    .sort(compareBytes);
  const expected = [...D082_OWNER_EXCEPTION_IDENTITIES].sort(compareBytes);
  if (
    actual.length !== expected.length
    || actual.some((identity, index) => identity !== expected[index])
  ) {
    fail(
      "SUPPLY_CHAIN_LICENSE_EVIDENCE_OWNER_SET",
      "owner exception 必须精确等于 D-082 的 12 个 identity。",
    );
  }
}

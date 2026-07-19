import { createHash } from "node:crypto";
import { fail } from "./errors.mjs";

export const SPDX_NORMALIZER_VERSION = "axial-muse-supply-chain-1.0.0";
export const SPDX_NAMESPACE_PREFIX = "https://www.axialmuse.com/spdx/npm/axial-muse-website/";

const DOCUMENT_KEYS = Object.freeze([
  "SPDXID",
  "creationInfo",
  "dataLicense",
  "documentDescribes",
  "documentNamespace",
  "name",
  "packages",
  "relationships",
  "spdxVersion",
]);
const CREATION_KEYS = Object.freeze(["created", "creators"]);
const PACKAGE_REQUIRED_KEYS = Object.freeze([
  "SPDXID",
  "downloadLocation",
  "externalRefs",
  "filesAnalyzed",
  "homepage",
  "licenseDeclared",
  "name",
  "packageFileName",
  "versionInfo",
]);
const PACKAGE_OPTIONAL_KEYS = Object.freeze([
  "checksums",
  "description",
  "primaryPackagePurpose",
]);
const RELATIONSHIP_KEYS = Object.freeze([
  "relatedSpdxElement",
  "relationshipType",
  "spdxElementId",
]);
const CHECKSUM_KEYS = Object.freeze(["algorithm", "checksumValue"]);
const EXTERNAL_REF_KEYS = Object.freeze([
  "referenceCategory",
  "referenceLocator",
  "referenceType",
]);
const EXPECTED_GRAPH_KEYS = Object.freeze(["packages", "relationships"]);
const EXPECTED_PACKAGE_KEYS = Object.freeze([
  "SPDXID",
  "checksums",
  "downloadLocation",
  "name",
  "packageFileName",
  "purl",
  "versionInfo",
]);
const EXPECTED_PACKAGE_OPTIONAL_KEYS = Object.freeze([
  "description",
  "homepage",
  "licenseDeclared",
]);
const EVIDENCE_KEYS = Object.freeze([
  "kind",
  "owner",
  "sbom",
  "status",
  "version",
]);
const SBOM_EVIDENCE_KEYS = Object.freeze([
  "createdAt",
  "fileSha256",
  "normalizerVersion",
  "semanticSha256",
]);
const RELATIONSHIP_TYPES = new Set([
  "DEPENDENCY_OF",
  "DESCRIBES",
  "DEV_DEPENDENCY_OF",
  "OPTIONAL_DEPENDENCY_OF",
  "PREREQUISITE_FOR",
]);
const SPDX_ID = /^SPDXRef-[A-Za-z0-9.-]+$/;
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NATIVE_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const PERSISTED_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const SHA512_HEX = /^[0-9a-f]{128}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/;
const ASCII_KEY = /^[\x20-\x7e]+$/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, pointer) {
  if (!isPlainObject(value)) {
    fail("SPDX_SCHEMA_INVALID", `${pointer} 必须是 object。`);
  }
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sortedKeys(keys) {
  return [...keys].sort(compareBytes);
}

function assertKeys(value, required, optional, pointer) {
  assertObject(value, pointer);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("SPDX_SCHEMA_INVALID", `${pointer}.${key} 不属于受控 npm SPDX schema。`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail("SPDX_SCHEMA_INVALID", `${pointer}.${key} 缺失。`);
    }
  }
}

function assertString(value, pointer, { allowEmpty = false } = {}) {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value.trim() !== value
    || (!allowEmpty && !SAFE_TEXT.test(value))
    || (allowEmpty && value !== "" && !SAFE_TEXT.test(value))
  ) {
    fail("SPDX_SCHEMA_INVALID", `${pointer} 不是合法字符串。`);
  }
  return value;
}

function assertArray(value, pointer, { nonEmpty = true } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    fail("SPDX_SCHEMA_INVALID", `${pointer} 必须是${nonEmpty ? "非空" : ""} array。`);
  }
  return value;
}

function assertSpdxId(value, pointer) {
  assertString(value, pointer);
  if (!SPDX_ID.test(value)) {
    fail("SPDX_SCHEMA_INVALID", `${pointer} 不是合法 SPDXID。`);
  }
  return value;
}

function assertExactVersion(value, pointer) {
  assertString(value, pointer);
  if (!EXACT_VERSION.test(value)) {
    fail("SPDX_SCHEMA_INVALID", `${pointer} 不是精确版本。`);
  }
  return value;
}

function assertValidDate(value, pattern, code, message) {
  if (typeof value !== "string" || !pattern.test(value) || Number.isNaN(Date.parse(value))) {
    fail(code, message);
  }
  const parsed = new Date(value);
  const normalized = parsed.toISOString();
  if (pattern === PERSISTED_UTC && normalized !== value.replace("Z", ".000Z")) {
    fail(code, message);
  }
  const nativePrefix = value.replace(/(?:\.\d+)?Z$/, "");
  if (pattern === NATIVE_UTC && !normalized.startsWith(nativePrefix)) {
    fail(code, message);
  }
  return value;
}

export function validateCreatedAt(value) {
  return assertValidDate(
    value,
    PERSISTED_UTC,
    "SPDX_CREATED_AT_INVALID",
    "createdAt 必须是合法 UTC 秒精度时间。",
  );
}

function validateNativeCreated(value) {
  return assertValidDate(
    value,
    NATIVE_UTC,
    "SPDX_SCHEMA_INVALID",
    "creationInfo.created 不是合法 UTC 时间。",
  );
}

function validateNativeNamespace(value) {
  assertString(value, "$.documentNamespace");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("SPDX_NAMESPACE_INVALID", "native documentNamespace 不是绝对 URI。");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    fail("SPDX_NAMESPACE_INVALID", "native documentNamespace 超出受控 URI 边界。");
  }
  return value;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isPlainObject(value)) return value;
  const entries = [];
  for (const key of sortedKeys(Object.keys(value))) {
    if (!ASCII_KEY.test(key)) {
      fail("SPDX_SCHEMA_INVALID", "canonical object key 必须是 ASCII。");
    }
    entries.push([key, canonicalValue(value[key])]);
  }
  return Object.fromEntries(entries);
}

export function canonicalJsonBytes(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sortAndRejectDuplicates(values, keyFor, pointer) {
  const keyed = values.map((value) => ({ key: keyFor(value), value }));
  keyed.sort((left, right) => {
    for (let index = 0; index < left.key.length; index += 1) {
      const compared = compareBytes(left.key[index], right.key[index]);
      if (compared !== 0) return compared;
    }
    return 0;
  });
  for (let index = 1; index < keyed.length; index += 1) {
    if (
      keyed[index - 1].key.length === keyed[index].key.length
      && keyed[index].key.every((part, partIndex) => part === keyed[index - 1].key[partIndex])
    ) {
      fail("SPDX_COLLECTION_DUPLICATE", `${pointer} 包含重复身份。`);
    }
  }
  return keyed.map(({ value }) => value);
}

function rejectDuplicateIdentity(values, identityFor, pointer) {
  const seen = new Set();
  for (const value of values) {
    const identity = identityFor(value);
    if (seen.has(identity)) {
      fail("SPDX_COLLECTION_DUPLICATE", `${pointer} 包含重复身份。`);
    }
    seen.add(identity);
  }
}

function validateChecksum(value, pointer) {
  assertKeys(value, CHECKSUM_KEYS, [], pointer);
  if (value.algorithm !== "SHA512" || typeof value.checksumValue !== "string" || !SHA512_HEX.test(value.checksumValue)) {
    fail("SPDX_SCHEMA_INVALID", `${pointer} 必须是 lowercase SHA512 checksum。`);
  }
  return {
    algorithm: value.algorithm,
    checksumValue: value.checksumValue,
  };
}

function validateChecksums(value, pointer, { allowEmpty = false, optional = false } = {}) {
  if (value === undefined && optional) return [];
  const checksums = assertArray(value, pointer, { nonEmpty: !allowEmpty }).map((checksum, index) => (
    validateChecksum(checksum, `${pointer}[${index}]`)
  ));
  rejectDuplicateIdentity(checksums, (checksum) => checksum.algorithm, pointer);
  return sortAndRejectDuplicates(
    checksums,
    (checksum) => [checksum.algorithm, checksum.checksumValue],
    pointer,
  );
}

function validateExternalRef(value, pointer) {
  assertKeys(value, EXTERNAL_REF_KEYS, [], pointer);
  if (value.referenceCategory !== "PACKAGE-MANAGER" || value.referenceType !== "purl") {
    fail("SPDX_SCHEMA_INVALID", `${pointer} 不是 npm package-manager purl。`);
  }
  assertString(value.referenceLocator, `${pointer}.referenceLocator`);
  if (!value.referenceLocator.startsWith("pkg:npm/") || /\s/.test(value.referenceLocator)) {
    fail("SPDX_SCHEMA_INVALID", `${pointer}.referenceLocator 不是受控 npm purl。`);
  }
  return {
    referenceCategory: value.referenceCategory,
    referenceLocator: value.referenceLocator,
    referenceType: value.referenceType,
  };
}

function validateExternalRefs(value, pointer) {
  const refs = assertArray(value, pointer).map((reference, index) => (
    validateExternalRef(reference, `${pointer}[${index}]`)
  ));
  if (refs.length !== 1) {
    fail("SPDX_SCHEMA_INVALID", `${pointer} 必须精确包含一个 npm purl。`);
  }
  return sortAndRejectDuplicates(
    refs,
    (reference) => [
      reference.referenceCategory,
      reference.referenceType,
      reference.referenceLocator,
    ],
    pointer,
  );
}

function validateExpectedPackage(value, pointer) {
  assertKeys(value, EXPECTED_PACKAGE_KEYS, EXPECTED_PACKAGE_OPTIONAL_KEYS, pointer);
  const result = {
    SPDXID: assertSpdxId(value.SPDXID, `${pointer}.SPDXID`),
    checksums: validateChecksums(value.checksums, `${pointer}.checksums`, { allowEmpty: true }),
    downloadLocation: assertString(value.downloadLocation, `${pointer}.downloadLocation`),
    name: assertString(value.name, `${pointer}.name`),
    packageFileName: assertString(value.packageFileName, `${pointer}.packageFileName`, { allowEmpty: true }),
    purl: assertString(value.purl, `${pointer}.purl`),
    versionInfo: assertExactVersion(value.versionInfo, `${pointer}.versionInfo`),
  };
  for (const key of EXPECTED_PACKAGE_OPTIONAL_KEYS) {
    if (value[key] !== undefined) {
      result[key] = assertString(value[key], `${pointer}.${key}`);
    }
  }
  return result;
}

export function validateExpectedSpdxGraph(value) {
  assertKeys(value, EXPECTED_GRAPH_KEYS, [], "$expectedGraph");
  const packages = assertArray(value.packages, "$expectedGraph.packages").map((package_, index) => (
    validateExpectedPackage(package_, `$expectedGraph.packages[${index}]`)
  ));
  const sortedPackages = sortAndRejectDuplicates(
    packages,
    (package_) => [package_.SPDXID],
    "$expectedGraph.packages",
  );
  const roots = sortedPackages.filter((package_) => package_.packageFileName === "");
  if (roots.length !== 1) {
    fail("SPDX_GRAPH_MISMATCH", "expected graph 必须精确包含一个根包。");
  }
  const packageIds = sortedPackages.map((package_) => package_.SPDXID);
  const relationships = assertArray(value.relationships, "$expectedGraph.relationships")
    .map((relationship, index) => (
      validateRelationship(relationship, `$expectedGraph.relationships[${index}]`, packageIds)
    ));
  const sortedRelationships = sortAndRejectDuplicates(
    relationships,
    (relationship) => [
      relationship.spdxElementId,
      relationship.relationshipType,
      relationship.relatedSpdxElement,
    ],
    "$expectedGraph.relationships",
  );
  const expectedDescribes = sortedRelationships.filter((relationship) => (
    relationship.spdxElementId === "SPDXRef-DOCUMENT"
    && relationship.relationshipType === "DESCRIBES"
    && relationship.relatedSpdxElement === roots[0].SPDXID
  ));
  if (expectedDescribes.length !== 1) {
    fail("SPDX_GRAPH_MISMATCH", "expected graph 必须精确描述根包。");
  }
  return {
    packages: sortedPackages,
    relationships: sortedRelationships,
  };
}

function validatePackage(value, pointer) {
  assertKeys(value, PACKAGE_REQUIRED_KEYS, PACKAGE_OPTIONAL_KEYS, pointer);
  const result = {
    SPDXID: assertSpdxId(value.SPDXID, `${pointer}.SPDXID`),
    downloadLocation: assertString(value.downloadLocation, `${pointer}.downloadLocation`),
    externalRefs: validateExternalRefs(value.externalRefs, `${pointer}.externalRefs`),
    filesAnalyzed: value.filesAnalyzed,
    homepage: assertString(value.homepage, `${pointer}.homepage`),
    licenseDeclared: assertString(value.licenseDeclared, `${pointer}.licenseDeclared`),
    name: assertString(value.name, `${pointer}.name`),
    packageFileName: assertString(value.packageFileName, `${pointer}.packageFileName`, { allowEmpty: true }),
    versionInfo: assertExactVersion(value.versionInfo, `${pointer}.versionInfo`),
  };
  if (value.filesAnalyzed !== false) {
    fail("SPDX_SCHEMA_INVALID", `${pointer}.filesAnalyzed 必须为 false。`);
  }
  if (value.checksums !== undefined) {
    result.checksums = validateChecksums(value.checksums, `${pointer}.checksums`);
  }
  if (value.description !== undefined) {
    result.description = assertString(value.description, `${pointer}.description`);
  }
  if (value.primaryPackagePurpose !== undefined) {
    result.primaryPackagePurpose = assertString(value.primaryPackagePurpose, `${pointer}.primaryPackagePurpose`);
    if (result.primaryPackagePurpose !== "APPLICATION") {
      fail("SPDX_SCHEMA_INVALID", `${pointer}.primaryPackagePurpose 超出 npm application 子集。`);
    }
  }
  return result;
}

function validateRelationship(value, pointer, packageIds) {
  assertKeys(value, RELATIONSHIP_KEYS, [], pointer);
  const relationship = {
    relatedSpdxElement: assertSpdxId(value.relatedSpdxElement, `${pointer}.relatedSpdxElement`),
    relationshipType: assertString(value.relationshipType, `${pointer}.relationshipType`),
    spdxElementId: assertSpdxId(value.spdxElementId, `${pointer}.spdxElementId`),
  };
  if (!RELATIONSHIP_TYPES.has(relationship.relationshipType)) {
    fail("SPDX_SCHEMA_INVALID", `${pointer}.relationshipType 超出 npm native 子集。`);
  }
  const known = new Set(["SPDXRef-DOCUMENT", ...packageIds]);
  if (!known.has(relationship.spdxElementId) || !known.has(relationship.relatedSpdxElement)) {
    fail("SPDX_GRAPH_MISMATCH", `${pointer} 引用了未知 SPDXID。`);
  }
  return relationship;
}

function comparePackageWithExpectation(package_, expected) {
  for (const key of ["SPDXID", "name", "versionInfo", "packageFileName", "downloadLocation"]) {
    if (package_[key] !== expected[key]) {
      fail("SPDX_GRAPH_MISMATCH", `${package_.SPDXID}.${key} 与 expected graph 不一致。`);
    }
  }
  const actualChecksums = package_.checksums ?? [];
  if (canonicalJsonBytes(actualChecksums) !== canonicalJsonBytes(expected.checksums)) {
    fail("SPDX_GRAPH_MISMATCH", `${package_.SPDXID}.checksums 与 lock/tarball evidence 不一致。`);
  }
  if (package_.externalRefs[0].referenceLocator !== expected.purl) {
    fail("SPDX_GRAPH_MISMATCH", `${package_.SPDXID}.externalRefs 与 lock 身份不一致。`);
  }
  for (const key of EXPECTED_PACKAGE_OPTIONAL_KEYS) {
    if (expected[key] !== undefined && package_[key] !== expected[key]) {
      fail("SPDX_GRAPH_MISMATCH", `${package_.SPDXID}.${key} 与 tarball evidence 不一致。`);
    }
  }
  if (expected.packageFileName === "") {
    if (package_.primaryPackagePurpose !== "APPLICATION") {
      fail("SPDX_GRAPH_MISMATCH", `${package_.SPDXID} 根包必须声明 APPLICATION purpose。`);
    }
  } else if (package_.primaryPackagePurpose !== undefined) {
    fail("SPDX_GRAPH_MISMATCH", `${package_.SPDXID} 依赖包不得声明 primary purpose。`);
  }
}

function validateAndNormalizeNativeDocument(nativeDocument, expectedGraph, npmVersion) {
  assertKeys(nativeDocument, DOCUMENT_KEYS, [], "$");
  if (
    nativeDocument.spdxVersion !== "SPDX-2.3"
    || nativeDocument.dataLicense !== "CC0-1.0"
    || nativeDocument.SPDXID !== "SPDXRef-DOCUMENT"
  ) {
    fail("SPDX_SCHEMA_INVALID", "SPDX 文档头不属于受控 SPDX 2.3 子集。" );
  }
  validateNativeNamespace(nativeDocument.documentNamespace);
  assertKeys(nativeDocument.creationInfo, CREATION_KEYS, [], "$.creationInfo");
  validateNativeCreated(nativeDocument.creationInfo.created);
  assertExactVersion(npmVersion, "$runtime.npmVersion");
  const npmCreator = `Tool: npm/cli-${npmVersion}`;
  const creators = assertArray(nativeDocument.creationInfo.creators, "$.creationInfo.creators")
    .map((creator, index) => assertString(creator, `$.creationInfo.creators[${index}]`));
  if (
    creators.length !== 1
    || creators[0] !== npmCreator
    || creators.includes(`Tool: ${SPDX_NORMALIZER_VERSION}`)
  ) {
    fail("SPDX_CREATOR_MISMATCH", "native creator 与当前受控 npm 端点不一致。" );
  }

  const packages = assertArray(nativeDocument.packages, "$.packages")
    .map((package_, index) => validatePackage(package_, `$.packages[${index}]`));
  const sortedPackages = sortAndRejectDuplicates(
    packages,
    (package_) => [
      package_.SPDXID,
      package_.name,
      package_.versionInfo,
      package_.packageFileName,
      package_.downloadLocation,
    ],
    "$.packages",
  );
  rejectDuplicateIdentity(sortedPackages, (package_) => package_.SPDXID, "$.packages");
  if (sortedPackages.length !== expectedGraph.packages.length) {
    fail("SPDX_GRAPH_MISMATCH", "native package 集合与 expected graph 数量不一致。" );
  }
  const expectedById = new Map(expectedGraph.packages.map((package_) => [package_.SPDXID, package_]));
  const expectedRoot = expectedGraph.packages.find((package_) => package_.packageFileName === "");
  if (nativeDocument.name !== `${expectedRoot.name}@${expectedRoot.versionInfo}`) {
    fail("SPDX_GRAPH_MISMATCH", "SPDX 文档名称与 expected graph 根包不一致。" );
  }
  for (const package_ of sortedPackages) {
    const expected = expectedById.get(package_.SPDXID);
    if (!expected) {
      fail("SPDX_GRAPH_MISMATCH", `${package_.SPDXID} 不在 expected graph 中。`);
    }
    comparePackageWithExpectation(package_, expected);
  }

  const packageIds = sortedPackages.map((package_) => package_.SPDXID);
  const documentDescribes = assertArray(nativeDocument.documentDescribes, "$.documentDescribes")
    .map((id, index) => assertSpdxId(id, `$.documentDescribes[${index}]`));
  const sortedDescribes = sortAndRejectDuplicates(
    documentDescribes,
    (id) => [id],
    "$.documentDescribes",
  );
  if (sortedDescribes.length !== 1 || sortedDescribes[0] !== expectedRoot.SPDXID) {
    fail("SPDX_GRAPH_MISMATCH", "documentDescribes 必须精确指向 expected graph 根包。" );
  }

  const relationships = assertArray(nativeDocument.relationships, "$.relationships")
    .map((relationship, index) => (
      validateRelationship(relationship, `$.relationships[${index}]`, packageIds)
    ));
  const sortedRelationships = sortAndRejectDuplicates(
    relationships,
    (relationship) => [
      relationship.spdxElementId,
      relationship.relationshipType,
      relationship.relatedSpdxElement,
    ],
    "$.relationships",
  );
  const describesRelationship = sortedRelationships.filter((relationship) => (
    relationship.spdxElementId === "SPDXRef-DOCUMENT"
    && relationship.relationshipType === "DESCRIBES"
    && relationship.relatedSpdxElement === sortedDescribes[0]
  ));
  if (describesRelationship.length !== 1) {
    fail("SPDX_GRAPH_MISMATCH", "relationships 缺少唯一 DOCUMENT DESCRIBES 根包关系。" );
  }
  if (canonicalJsonBytes(sortedRelationships) !== canonicalJsonBytes(expectedGraph.relationships)) {
    fail("SPDX_GRAPH_MISMATCH", "relationships 与 lock expected graph 不一致。" );
  }

  return {
    SPDXID: nativeDocument.SPDXID,
    creationInfo: {
      creators: [npmCreator, `Tool: ${SPDX_NORMALIZER_VERSION}`].sort(compareBytes),
    },
    dataLicense: nativeDocument.dataLicense,
    documentDescribes: sortedDescribes,
    name: nativeDocument.name,
    packages: sortedPackages,
    relationships: sortedRelationships,
    spdxVersion: nativeDocument.spdxVersion,
  };
}

function validateSbomEvidence(value) {
  assertKeys(value, SBOM_EVIDENCE_KEYS, [], "$evidence.sbom");
  if (value.normalizerVersion !== SPDX_NORMALIZER_VERSION) {
    fail("SPDX_EVIDENCE_INVALID", "evidence normalizerVersion 不受支持。" );
  }
  if (!HEX_64.test(value.semanticSha256 ?? "") || !HEX_64.test(value.fileSha256 ?? "")) {
    fail("SPDX_EVIDENCE_INVALID", "evidence 摘要格式非法。" );
  }
  validateCreatedAt(value.createdAt);
  return cloneValue(value);
}

function validateEvidenceEnvelope(value) {
  assertKeys(value, EVIDENCE_KEYS, [], "$evidence");
  if (
    value.version !== "0.1.0"
    || value.kind !== "axial_muse_dependency_evidence"
    || value.status !== "active"
    || value.owner !== "AxialMuseWebsite"
  ) {
    fail("SPDX_EVIDENCE_INVALID", "dependency evidence 封套不受支持。" );
  }
  return {
    version: value.version,
    kind: value.kind,
    status: value.status,
    owner: value.owner,
    sbom: validateSbomEvidence(value.sbom),
  };
}

function chooseCreatedAt(semanticSha256, previousSbomEvidence, createdAt) {
  if (!previousSbomEvidence) {
    if (createdAt === undefined || createdAt === null) {
      fail("SPDX_CREATED_AT_REQUIRED", "首次生成 SPDX 必须显式提供 --created-at。" );
    }
    return validateCreatedAt(createdAt);
  }
  const previous = validateSbomEvidence(previousSbomEvidence);
  if (previous.semanticSha256 === semanticSha256) {
    if (createdAt !== undefined && createdAt !== null) {
      fail("SPDX_CREATED_AT_UNEXPECTED", "相同语义必须省略 --created-at 并复用既有值。" );
    }
    return previous.createdAt;
  }
  if (createdAt === undefined || createdAt === null) {
    fail("SPDX_CREATED_AT_REQUIRED", "SPDX 语义变化时必须显式提供新的 --created-at。" );
  }
  const next = validateCreatedAt(createdAt);
  if (next === previous.createdAt) {
    fail("SPDX_CREATED_AT_REUSED", "SPDX 语义变化时不得复用既有 createdAt。" );
  }
  return next;
}

export function parseSpdxJson(text, code = "SPDX_INPUT_INVALID") {
  if (typeof text !== "string" || text.length === 0) {
    fail(code, "SPDX JSON 输入为空。" );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(code, "SPDX JSON 输入无法解析。" );
  }
  if (!isPlainObject(value)) {
    fail(code, "SPDX JSON 顶层必须是 object。" );
  }
  return value;
}

export function normalizeNpmSpdx({
  nativeDocument,
  expectedGraph: expectedGraphInput,
  npmVersion,
  previousSbomEvidence = null,
  createdAt = null,
}) {
  const expectedGraph = validateExpectedSpdxGraph(expectedGraphInput);
  const semanticDocument = validateAndNormalizeNativeDocument(
    cloneValue(nativeDocument),
    expectedGraph,
    npmVersion,
  );
  const semanticBytes = canonicalJsonBytes({
    normalizerVersion: SPDX_NORMALIZER_VERSION,
    document: semanticDocument,
  });
  const semanticSha256 = sha256(semanticBytes);
  const selectedCreatedAt = chooseCreatedAt(
    semanticSha256,
    previousSbomEvidence,
    createdAt,
  );
  const documentWithoutNamespace = cloneValue(semanticDocument);
  documentWithoutNamespace.creationInfo.created = selectedCreatedAt;
  const documentBytes = canonicalJsonBytes(documentWithoutNamespace);
  const documentSha256 = sha256(documentBytes);
  const document = cloneValue(documentWithoutNamespace);
  document.documentNamespace = `${SPDX_NAMESPACE_PREFIX}${documentSha256}`;
  const bytes = canonicalJsonBytes(document);
  const sbomEvidence = {
    normalizerVersion: SPDX_NORMALIZER_VERSION,
    semanticSha256,
    createdAt: selectedCreatedAt,
    fileSha256: sha256(bytes),
  };
  const evidence = {
    version: "0.1.0",
    kind: "axial_muse_dependency_evidence",
    status: "active",
    owner: "AxialMuseWebsite",
    sbom: sbomEvidence,
  };
  return {
    bytes,
    document,
    documentSha256,
    evidence,
    evidenceBytes: canonicalJsonBytes(evidence),
    sbomEvidence,
    semanticBytes,
  };
}

export function validateCanonicalSpdxArtifacts({
  sbomBytes,
  evidenceBytes,
  expectedGraph: expectedGraphInput = null,
  npmVersion,
}) {
  const document = parseSpdxJson(sbomBytes, "SPDX_EVIDENCE_INVALID");
  const evidence = validateEvidenceEnvelope(parseSpdxJson(evidenceBytes, "SPDX_EVIDENCE_INVALID"));
  if (canonicalJsonBytes(document) !== sbomBytes || canonicalJsonBytes(evidence) !== evidenceBytes) {
    fail("SPDX_EVIDENCE_INVALID", "既有 SPDX 或 evidence 不是 canonical 字节。" );
  }
  if (!PERSISTED_UTC.test(document.creationInfo?.created ?? "")) {
    fail("SPDX_CREATED_AT_INVALID", "既有 SPDX created 不是 UTC 秒精度。" );
  }
  const namespace = document.documentNamespace;
  if (
    typeof namespace !== "string"
    || !namespace.startsWith(SPDX_NAMESPACE_PREFIX)
    || !HEX_64.test(namespace.slice(SPDX_NAMESPACE_PREFIX.length))
  ) {
    fail("SPDX_NAMESPACE_MISMATCH", "既有 SPDX namespace 不属于 canonical 前缀。" );
  }
  const stableCreator = `Tool: ${SPDX_NORMALIZER_VERSION}`;
  const creators = document.creationInfo?.creators;
  if (!Array.isArray(creators) || creators.filter((creator) => creator === stableCreator).length !== 1) {
    fail("SPDX_CREATOR_MISMATCH", "既有 SPDX 缺少唯一稳定 creator。" );
  }
  const nativeLike = cloneValue(document);
  const nativeCreators = creators.filter((creator) => creator !== stableCreator);
  nativeLike.creationInfo.creators = nativeCreators;
  const selfGraph = {
    packages: Array.isArray(document.packages)
      ? document.packages.map((package_) => ({
        SPDXID: package_.SPDXID,
        checksums: package_.checksums ?? [],
        downloadLocation: package_.downloadLocation,
        name: package_.name,
        packageFileName: package_.packageFileName,
        purl: package_.externalRefs?.[0]?.referenceLocator,
        versionInfo: package_.versionInfo,
      }))
      : [],
    relationships: Array.isArray(document.relationships)
      ? cloneValue(document.relationships)
      : [],
  };
  let validationNpmVersion = npmVersion;
  if (expectedGraphInput === null) {
    const match = /^Tool: npm\/cli-(.+)$/.exec(nativeCreators[0] ?? "");
    if (nativeCreators.length !== 1 || match === null || !EXACT_VERSION.test(match[1])) {
      fail("SPDX_CREATOR_MISMATCH", "既有 SPDX npm creator 无法自洽验证。");
    }
    validationNpmVersion = match[1];
  }
  const expectedGraph = validateExpectedSpdxGraph(expectedGraphInput ?? selfGraph);
  const semanticDocument = validateAndNormalizeNativeDocument(
    nativeLike,
    expectedGraph,
    validationNpmVersion,
  );
  const semanticBytes = canonicalJsonBytes({
    normalizerVersion: SPDX_NORMALIZER_VERSION,
    document: semanticDocument,
  });
  const semanticSha256 = sha256(semanticBytes);
  if (evidence.sbom.semanticSha256 !== semanticSha256) {
    fail("SPDX_SEMANTIC_MISMATCH", "既有 SPDX semanticSha256 与 evidence 不一致。" );
  }
  if (evidence.sbom.createdAt !== document.creationInfo.created) {
    fail("SPDX_EVIDENCE_INVALID", "既有 SPDX created 与 evidence 不一致。" );
  }
  const withoutNamespace = cloneValue(document);
  delete withoutNamespace.documentNamespace;
  const documentSha256 = sha256(canonicalJsonBytes(withoutNamespace));
  if (namespace !== `${SPDX_NAMESPACE_PREFIX}${documentSha256}`) {
    fail("SPDX_NAMESPACE_MISMATCH", "既有 SPDX namespace 与 canonical document 摘要不一致。" );
  }
  if (evidence.sbom.fileSha256 !== sha256(sbomBytes)) {
    fail("SPDX_FILE_HASH_MISMATCH", "既有 SPDX fileSha256 与 evidence 不一致。" );
  }
  return {
    document,
    documentSha256,
    evidence,
    sbomEvidence: evidence.sbom,
    semanticBytes,
  };
}

import { fail } from "./errors.mjs";
import { validateDependencyPolicyObject } from "./policy.mjs";
import { assertNoDuplicateJsonKeys } from "./strict-json.mjs";

const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PACKAGE_COMPONENT = /^[a-z0-9][a-z0-9._-]*$/;
const SCOPE_COMPONENT = /^@[a-z0-9][a-z0-9._-]*$/;
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CWE = /^CWE-[1-9]\d*$/;
const SEVERITIES = Object.freeze(["info", "low", "moderate", "high", "critical"]);
const SEVERITY_RANK = new Map(SEVERITIES.map((severity, index) => [severity, index]));
const TOP_LEVEL_KEYS = Object.freeze(["auditReportVersion", "metadata", "vulnerabilities"]);
const METADATA_KEYS = Object.freeze(["dependencies", "vulnerabilities"]);
const DEPENDENCY_COUNT_KEYS = Object.freeze([
  "dev",
  "optional",
  "peer",
  "peerOptional",
  "prod",
  "total",
]);
const VULNERABILITY_COUNT_KEYS = Object.freeze([
  "critical",
  "high",
  "info",
  "low",
  "moderate",
  "total",
]);
const VULNERABILITY_KEYS = Object.freeze([
  "effects",
  "fixAvailable",
  "isDirect",
  "name",
  "nodes",
  "range",
  "severity",
  "via",
]);
const ADVISORY_REQUIRED_KEYS = Object.freeze([
  "dependency",
  "name",
  "range",
  "severity",
  "source",
  "title",
  "url",
]);
const ADVISORY_OPTIONAL_KEYS = Object.freeze(["cwe", "cvss"]);
const CVSS_KEYS = Object.freeze(["score", "vectorString"]);
const FIX_AVAILABLE_KEYS = Object.freeze(["isSemVerMajor", "name", "version"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertExactKeys(value, required, optional, pointer) {
  if (!isPlainObject(value)) {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer} 必须是 object。`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer}.${key} 不属于 npm audit v2 schema。`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer}.${key} 缺失。`);
    }
  }
}

function assertSafeString(value, pointer, { maxLength = 4096 } = {}) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
    || !SAFE_TEXT.test(value)
  ) {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer} 必须是受控非空字符串。`);
  }
  return value;
}

function assertPackageName(value, pointer) {
  const name = assertSafeString(value, pointer, { maxLength: 214 });
  if (!PACKAGE_NAME.test(name)) {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer} 不是规范 npm 包名。`);
  }
  return name;
}

function assertSeverity(value, pointer) {
  if (!SEVERITY_RANK.has(value)) {
    fail("SUPPLY_CHAIN_AUDIT_SEVERITY", `${pointer} 不是 npm audit v2 已知 severity。`);
  }
  return value;
}

function assertNonnegativeInteger(value, pointer) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer} 必须是非负安全整数。`);
  }
  return value;
}

function normalizeCounts(value, keys, pointer) {
  assertExactKeys(value, keys, [], pointer);
  return Object.fromEntries(keys.map((key) => [
    key,
    assertNonnegativeInteger(value[key], `${pointer}.${key}`),
  ]));
}

function normalizeStringSet(value, pointer, validate, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    fail(
      "SUPPLY_CHAIN_AUDIT_SCHEMA",
      `${pointer} 必须是${nonEmpty ? "非空" : ""} array。`,
    );
  }
  const normalized = value.map((entry, index) => validate(entry, `${pointer}[${index}]`));
  const sorted = [...normalized].sort(compareUtf8);
  if (new Set(sorted).size !== sorted.length) {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer} 包含重复值。`);
  }
  return sorted;
}

function normalizeNodeLocation(value, pointer) {
  const location = assertSafeString(value, pointer, { maxLength: 4096 });
  if (location.includes("\\")) {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer} 不是受控 node_modules 相对路径。`);
  }
  const segments = location.split("/");
  let index = 0;
  while (index < segments.length) {
    if (segments[index] !== "node_modules") {
      fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer} 不是受控 node_modules 相对路径。`);
    }
    index += 1;
    if (SCOPE_COMPONENT.test(segments[index] ?? "")) {
      if (!PACKAGE_COMPONENT.test(segments[index + 1] ?? "")) {
        fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer} 不是完整 scoped package 路径。`);
      }
      index += 2;
    } else if (PACKAGE_COMPONENT.test(segments[index] ?? "")) {
      index += 1;
    } else {
      fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer} 不是受控 package 路径。`);
    }
  }
  return location;
}

function normalizeUrl(value, pointer) {
  const text = assertSafeString(value, pointer, { maxLength: 4096 });
  let url;
  try {
    url = new URL(text);
  } catch {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer} 不是绝对 HTTPS URL。`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer} 不是无凭据 HTTPS URL。`);
  }
  return text;
}

function normalizeCvss(value, pointer) {
  assertExactKeys(value, CVSS_KEYS, [], pointer);
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 10) {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer}.score 必须在 0 至 10 之间。`);
  }
  const vectorString = value.vectorString === null
    ? null
    : assertSafeString(value.vectorString, `${pointer}.vectorString`, { maxLength: 1000 });
  return {
    score: value.score,
    vectorString,
  };
}

function normalizeAdvisory(value, pointer, vulnerabilityName) {
  assertExactKeys(value, ADVISORY_REQUIRED_KEYS, ADVISORY_OPTIONAL_KEYS, pointer);
  const source = assertNonnegativeInteger(value.source, `${pointer}.source`);
  if (source === 0) {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer}.source 必须是正整数 advisory ID。`);
  }
  const name = assertPackageName(value.name, `${pointer}.name`);
  if (name !== vulnerabilityName) {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer}.name 与所属 vulnerability 不一致。`);
  }
  const advisory = {
    dependency: assertPackageName(value.dependency, `${pointer}.dependency`),
    name,
    range: assertSafeString(value.range, `${pointer}.range`),
    severity: assertSeverity(value.severity, `${pointer}.severity`),
    source,
    title: assertSafeString(value.title, `${pointer}.title`, { maxLength: 10000 }),
    url: normalizeUrl(value.url, `${pointer}.url`),
  };
  if (value.cwe !== undefined) {
    advisory.cwe = normalizeStringSet(
      value.cwe,
      `${pointer}.cwe`,
      (entry, entryPointer) => {
        const cwe = assertSafeString(entry, entryPointer, { maxLength: 100 });
        if (!CWE.test(cwe)) {
          fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${entryPointer} 不是规范 CWE 标识。`);
        }
        return cwe;
      },
    );
  }
  if (value.cvss !== undefined) {
    advisory.cvss = normalizeCvss(value.cvss, `${pointer}.cvss`);
  }
  return advisory;
}

function normalizeVia(value, pointer, vulnerabilityName) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer} 必须是非空 array。`);
  }
  const entries = value.map((entry, index) => {
    const entryPointer = `${pointer}[${index}]`;
    return typeof entry === "string"
      ? assertPackageName(entry, entryPointer)
      : normalizeAdvisory(entry, entryPointer, vulnerabilityName);
  });
  const keyed = entries.map((entry) => ({
    entry,
    key: typeof entry === "string"
      ? `0\0${entry}`
      : `1\0${String(entry.source).padStart(16, "0")}`,
  })).sort((left, right) => compareUtf8(left.key, right.key));
  for (let index = 1; index < keyed.length; index += 1) {
    if (keyed[index - 1].key === keyed[index].key) {
      fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer} 包含重复 advisory。`);
    }
  }
  return keyed.map(({ entry }) => entry);
}

function normalizeFixAvailable(value, pointer) {
  if (typeof value === "boolean") return value;
  assertExactKeys(value, FIX_AVAILABLE_KEYS, [], pointer);
  const version = assertSafeString(value.version, `${pointer}.version`, { maxLength: 200 });
  if (!EXACT_VERSION.test(version)) {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer}.version 不是精确版本。`);
  }
  if (typeof value.isSemVerMajor !== "boolean") {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer}.isSemVerMajor 必须是 boolean。`);
  }
  return {
    isSemVerMajor: value.isSemVerMajor,
    name: assertPackageName(value.name, `${pointer}.name`),
    version,
  };
}

function normalizeVulnerability(value, pointer, key) {
  assertExactKeys(value, VULNERABILITY_KEYS, [], pointer);
  const name = assertPackageName(value.name, `${pointer}.name`);
  if (name !== key) {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer}.name 与 vulnerabilities key 不一致。`);
  }
  if (typeof value.isDirect !== "boolean") {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${pointer}.isDirect 必须是 boolean。`);
  }
  return {
    effects: normalizeStringSet(value.effects, `${pointer}.effects`, assertPackageName),
    fixAvailable: normalizeFixAvailable(value.fixAvailable, `${pointer}.fixAvailable`),
    isDirect: value.isDirect,
    name,
    nodes: normalizeStringSet(
      value.nodes,
      `${pointer}.nodes`,
      normalizeNodeLocation,
      { nonEmpty: true },
    ),
    range: assertSafeString(value.range, `${pointer}.range`),
    severity: assertSeverity(value.severity, `${pointer}.severity`),
    via: normalizeVia(value.via, `${pointer}.via`, name),
  };
}

function validateVulnerabilityReferences(vulnerabilities) {
  const byName = new Map(vulnerabilities.map((vulnerability) => [vulnerability.name, vulnerability]));
  const viaEdges = new Set();
  const effectEdges = new Set();
  const dependentsByCause = new Map(vulnerabilities.map((vulnerability) => [
    vulnerability.name,
    [],
  ]));
  const reachesAdvisory = new Set(vulnerabilities
    .filter((vulnerability) => vulnerability.via.some((via) => typeof via !== "string"))
    .map((vulnerability) => vulnerability.name));
  for (const vulnerability of vulnerabilities) {
    const directAdvisorySeverities = [];
    let hasMetavulnerabilityReference = false;
    for (const via of vulnerability.via) {
      if (typeof via === "string") {
        const referenced = byName.get(via);
        if (!referenced) {
          fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${vulnerability.name}.via 引用了未知 vulnerability。`);
        }
        hasMetavulnerabilityReference = true;
        viaEdges.add(`${vulnerability.name}\0${via}`);
        dependentsByCause.get(via).push(vulnerability.name);
      } else {
        directAdvisorySeverities.push(via.severity);
      }
    }
    for (const effect of vulnerability.effects) {
      if (!byName.has(effect)) {
        fail("SUPPLY_CHAIN_AUDIT_SCHEMA", `${vulnerability.name}.effects 引用了未知 vulnerability。`);
      }
      effectEdges.add(`${effect}\0${vulnerability.name}`);
    }
    if (!hasMetavulnerabilityReference) {
      const maximum = directAdvisorySeverities.reduce((current, severity) => (
        SEVERITY_RANK.get(severity) > SEVERITY_RANK.get(current) ? severity : current
      ));
      if (vulnerability.severity !== maximum) {
        fail("SUPPLY_CHAIN_AUDIT_SEVERITY", `${vulnerability.name}.severity 与直接 advisory 最大 severity 不一致。`);
      }
    }
  }
  if ([...effectEdges].some((edge) => !viaEdges.has(edge))) {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", "vulnerability effects 包含没有对应 via 的反向边。" );
  }
  const advisoryQueue = [...reachesAdvisory];
  for (let index = 0; index < advisoryQueue.length; index += 1) {
    for (const dependent of dependentsByCause.get(advisoryQueue[index])) {
      if (reachesAdvisory.has(dependent)) continue;
      reachesAdvisory.add(dependent);
      advisoryQueue.push(dependent);
    }
  }
  if (reachesAdvisory.size !== vulnerabilities.length) {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", "metavulnerability 引用分量未闭合到真实 advisory。" );
  }
}

function normalizeVulnerabilities(value) {
  if (!isPlainObject(value)) {
    fail("SUPPLY_CHAIN_AUDIT_SCHEMA", "$.vulnerabilities 必须是 object。");
  }
  const vulnerabilities = Object.entries(value).map(([key, vulnerability]) => {
    assertPackageName(key, `$.vulnerabilities.${key}`);
    return normalizeVulnerability(vulnerability, `$.vulnerabilities.${key}`, key);
  }).sort((left, right) => compareUtf8(left.name, right.name));
  validateVulnerabilityReferences(vulnerabilities);
  return vulnerabilities;
}

function validateMetadataCounts(metadata, vulnerabilities) {
  const actual = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const vulnerability of vulnerabilities) actual[vulnerability.severity] += 1;
  for (const severity of SEVERITIES) {
    if (metadata.vulnerabilities[severity] !== actual[severity]) {
      fail("SUPPLY_CHAIN_AUDIT_METADATA", `metadata.vulnerabilities.${severity} 与漏洞集合不一致。`);
    }
  }
  const summed = SEVERITIES.reduce(
    (total, severity) => total + metadata.vulnerabilities[severity],
    0,
  );
  if (metadata.vulnerabilities.total !== summed || summed !== vulnerabilities.length) {
    fail("SUPPLY_CHAIN_AUDIT_METADATA", "metadata.vulnerabilities.total 与漏洞集合不一致。");
  }
}

function classifyVulnerabilities(vulnerabilities, policy) {
  const blocking = new Set(policy.audit.blockingSeverities);
  const reportOnly = new Set(policy.audit.reportOnlySeverities);
  const result = {
    blocking: [],
    reportOnly: [],
  };
  const assertClassified = (severity, pointer) => {
    if (!blocking.has(severity) && !reportOnly.has(severity)) {
      fail("SUPPLY_CHAIN_AUDIT_SEVERITY", `${pointer} 未被 dependency policy 分类。`);
    }
  };
  for (const vulnerability of vulnerabilities) {
    assertClassified(vulnerability.severity, `${vulnerability.name}.severity`);
    for (const [index, via] of vulnerability.via.entries()) {
      if (typeof via !== "string") {
        assertClassified(via.severity, `${vulnerability.name}.via[${index}].severity`);
      }
    }
    const finding = { name: vulnerability.name, severity: vulnerability.severity };
    if (blocking.has(vulnerability.severity)) result.blocking.push(finding);
    else result.reportOnly.push(finding);
  }
  return result;
}

function parseAuditJson(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0) {
    fail("SUPPLY_CHAIN_AUDIT_JSON", "npm audit --json stdout 为空或不是字符串。");
  }
  assertNoDuplicateJsonKeys(stdout, {
    duplicateCode: "SUPPLY_CHAIN_AUDIT_SCHEMA",
    invalidCode: "SUPPLY_CHAIN_AUDIT_JSON",
    label: "npm audit JSON",
  });
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    fail("SUPPLY_CHAIN_AUDIT_JSON", "npm audit --json stdout 无法解析。");
  }
  return value;
}

export function parseNpmAuditReport({ stdout, policy, expectedDependencyCount = null }) {
  const validatedPolicy = validateDependencyPolicyObject(policy);
  const value = parseAuditJson(stdout);
  assertExactKeys(value, TOP_LEVEL_KEYS, [], "$");
  if (value.auditReportVersion !== 2) {
    fail("SUPPLY_CHAIN_AUDIT_VERSION", "npm audit report 必须精确为 auditReportVersion 2。");
  }
  assertExactKeys(value.metadata, METADATA_KEYS, [], "$.metadata");
  const metadata = {
    dependencies: normalizeCounts(
      value.metadata.dependencies,
      DEPENDENCY_COUNT_KEYS,
      "$.metadata.dependencies",
    ),
    vulnerabilities: normalizeCounts(
      value.metadata.vulnerabilities,
      VULNERABILITY_COUNT_KEYS,
      "$.metadata.vulnerabilities",
    ),
  };
  const vulnerabilities = normalizeVulnerabilities(value.vulnerabilities);
  validateMetadataCounts(metadata, vulnerabilities);
  if (
    expectedDependencyCount !== null
    && (
      !Number.isSafeInteger(expectedDependencyCount)
      || expectedDependencyCount < 0
      || metadata.dependencies.total !== expectedDependencyCount
    )
  ) {
    fail(
      "SUPPLY_CHAIN_AUDIT_DEPENDENCY_CLOSURE",
      "metadata.dependencies.total 与唯一 lockfile 的非根节点数不一致。",
    );
  }
  const classified = classifyVulnerabilities(vulnerabilities, validatedPolicy);
  return {
    auditReportVersion: 2,
    blocking: classified.blocking,
    metadata,
    outcome: classified.blocking.length === 0 ? "pass" : "blocked",
    reportOnly: classified.reportOnly,
    vulnerabilities,
  };
}

export function parseNpmAuditResult({ result, policy, expectedDependencyCount = null }) {
  if (!isPlainObject(result)) {
    fail("SUPPLY_CHAIN_AUDIT_PROCESS", "npm audit 进程结果必须是 object。");
  }
  if (result.error !== undefined && result.error !== null) {
    fail("SUPPLY_CHAIN_AUDIT_PROCESS", "npm audit 子进程无法启动。");
  }
  if (result.signal !== undefined && result.signal !== null) {
    fail("SUPPLY_CHAIN_AUDIT_PROCESS", "npm audit 子进程被 signal 终止。");
  }
  if (result.status !== 0 && result.status !== 1) {
    fail("SUPPLY_CHAIN_AUDIT_PROCESS", "npm audit 子进程退出状态不受支持。");
  }
  const report = parseNpmAuditReport({
    stdout: result.stdout,
    policy,
    expectedDependencyCount,
  });
  const expectedStatus = report.blocking.length === 0 ? 0 : 1;
  if (result.status !== expectedStatus) {
    fail("SUPPLY_CHAIN_AUDIT_EXIT_MISMATCH", "npm audit 退出状态与已解析漏洞阈值不一致。");
  }
  return {
    auditReportVersion: report.auditReportVersion,
    blocking: report.blocking,
    exitCode: result.status,
    metadata: report.metadata,
    outcome: report.outcome,
    reportOnly: report.reportOnly,
    vulnerabilities: report.vulnerabilities,
  };
}

export function assertParsedNpmAuditResultAllowed(report) {
  if (!isPlainObject(report) || !Array.isArray(report.blocking)) {
    fail("SUPPLY_CHAIN_AUDIT_PROCESS", "已解析 npm audit 结果结构无效。");
  }
  if (report.blocking.length > 0) {
    fail(
      "SUPPLY_CHAIN_AUDIT_BLOCKED",
      `npm audit 发现 ${report.blocking.length} 个 moderate/high/critical 漏洞。`,
    );
  }
  return report;
}

export function assertNpmAuditResultAllowed({
  result,
  policy,
  expectedDependencyCount = null,
}) {
  const report = parseNpmAuditResult({ result, policy, expectedDependencyCount });
  return assertParsedNpmAuditResultAllowed(report);
}

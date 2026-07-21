import { canonicalJsonBytes } from "./spdx.mjs";
import { readRegularProjectFile } from "./config.mjs";
import { fail } from "./errors.mjs";
import { exactPackageIdentity } from "./lockfile.mjs";

const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const DECISION_ID = /^D-[0-9]{3}$/;
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const ADMISSION_KEYS = Object.freeze([
  "decisionId",
  "evidenceSha256",
  "licenseClarification",
  "obligations",
  "purpose",
  "scriptDisposition",
]);
const SCRIPT_DISPOSITIONS = new Set(["absent", "ignored", "approved-exception"]);

export const EXPECTED_DEPENDENCY_POLICY = Object.freeze({
  version: "0.1.0",
  kind: "axial_muse_dependency_policy",
  status: "active",
  owner: "AxialMuseWebsite",
  registry: {
    origin: "https://registry.npmjs.org/",
    sourceTypes: ["registry"],
    lockfileVersion: 3,
  },
  licenses: {
    preferred: [
      "0BSD",
      "Apache-2.0",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "BlueOak-1.0.0",
      "CC0-1.0",
      "ISC",
      "MIT",
      "MIT-0",
    ],
    reviewRequired: [
      "LGPL-2.0-only",
      "LGPL-2.0-or-later",
      "LGPL-2.1-only",
      "LGPL-2.1-or-later",
      "LGPL-3.0-only",
      "LGPL-3.0-or-later",
      "MPL-1.0",
      "MPL-1.1",
      "MPL-2.0",
    ],
    deniedPrefixes: ["AGPL-", "GPL-"],
    compound: "deny",
    custom: "deny",
    unknown: "deny",
  },
  lifecycleScripts: {
    default: "deny",
    exceptionScope: "exact-package-user-decision",
  },
  audit: {
    includeDevelopment: true,
    blockingSeverities: ["moderate", "high", "critical"],
    reportOnlySeverities: ["low"],
    fix: "forbidden",
  },
  endpoints: {
    roles: ["primary", "minimum"],
    minimumMode: "read-only",
  },
  reports: {
    visibility: "restricted",
    retentionDays: 30,
  },
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseJsonObject(text, relativePath, code) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(code, `${relativePath} 不是合法 JSON。`);
  }
  if (!isPlainObject(value)) {
    fail(code, `${relativePath} 顶层必须是 object。`);
  }
  return value;
}

function assertExactKeys(value, expected, pointer, code) {
  if (!isPlainObject(value)) {
    fail(code, `${pointer} 必须是 object。`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    fail(code, `${pointer} 字段集合不符合固定 schema。`);
  }
}

function assertSafeString(value, pointer, code, { maxLength = 1000 } = {}) {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length === 0
    || value.length > maxLength
    || !SAFE_TEXT.test(value)
  ) {
    fail(code, `${pointer} 必须是受控非空字符串。`);
  }
  return value;
}

function parseAdmissionIdentity(identity) {
  if (typeof identity !== "string" || identity.includes("\0")) {
    fail("SUPPLY_CHAIN_ADMISSION_IDENTITY", "准入记录键必须是精确 name@version。");
  }
  const separator = identity.lastIndexOf("@");
  const name = identity.slice(0, separator);
  const version = identity.slice(separator + 1);
  if (!PACKAGE_NAME.test(name) || !EXACT_VERSION.test(version)) {
    fail("SUPPLY_CHAIN_ADMISSION_IDENTITY", `${identity} 不是精确 name@version。`);
  }
  if (exactPackageIdentity(name, version) !== identity) {
    fail("SUPPLY_CHAIN_ADMISSION_IDENTITY", `${identity} 不是规范依赖身份。`);
  }
  return { identity, name, version };
}

export function validateDependencyPolicyObject(value) {
  assertExactKeys(
    value,
    [
      "version",
      "kind",
      "status",
      "owner",
      "registry",
      "licenses",
      "lifecycleScripts",
      "audit",
      "endpoints",
      "reports",
    ],
    "$policy",
    "SUPPLY_CHAIN_POLICY_SCHEMA",
  );
  if (canonicalJsonBytes(value) !== canonicalJsonBytes(EXPECTED_DEPENDENCY_POLICY)) {
    fail("SUPPLY_CHAIN_POLICY_DRIFT", "dependency policy 偏离 D-052/D-077 固定边界。");
  }
  return structuredClone(value);
}

export function readAndValidateDependencyPolicy(root) {
  const relativePath = "docs/contracts/dependency-policy.json";
  const text = readRegularProjectFile(root, relativePath, "SUPPLY_CHAIN_POLICY_FILE");
  const value = parseJsonObject(
    text,
    relativePath,
    "SUPPLY_CHAIN_POLICY_JSON",
  );
  const policy = validateDependencyPolicyObject(value);
  if (canonicalJsonBytes(policy) !== text) {
    fail("SUPPLY_CHAIN_POLICY_CANONICAL", "dependency policy 必须是 canonical JSON 字节。");
  }
  return policy;
}

export function validateDependencyAdmissionsObject(value) {
  assertExactKeys(
    value,
    ["version", "kind", "status", "owner", "packages"],
    "$admissions",
    "SUPPLY_CHAIN_ADMISSION_SCHEMA",
  );
  if (
    value.version !== "0.1.0"
    || value.kind !== "axial_muse_dependency_admissions"
    || value.status !== "active"
    || value.owner !== "AxialMuseWebsite"
  ) {
    fail("SUPPLY_CHAIN_ADMISSION_SCHEMA", "dependency admissions 封套不受支持。");
  }
  if (!isPlainObject(value.packages)) {
    fail("SUPPLY_CHAIN_ADMISSION_SCHEMA", "$admissions.packages 必须是 object。");
  }

  const packages = [];
  for (const [identity, admission] of Object.entries(value.packages)) {
    parseAdmissionIdentity(identity);
    assertExactKeys(
      admission,
      ADMISSION_KEYS,
      `$admissions.packages.${identity}`,
      "SUPPLY_CHAIN_ADMISSION_SCHEMA",
    );
    const purpose = assertSafeString(
      admission.purpose,
      `$admissions.packages.${identity}.purpose`,
      "SUPPLY_CHAIN_ADMISSION_SCHEMA",
    );
    const licenseClarification = assertSafeString(
      admission.licenseClarification,
      `$admissions.packages.${identity}.licenseClarification`,
      "SUPPLY_CHAIN_ADMISSION_SCHEMA",
    );
    const decisionId = assertSafeString(
      admission.decisionId,
      `$admissions.packages.${identity}.decisionId`,
      "SUPPLY_CHAIN_ADMISSION_SCHEMA",
      { maxLength: 200 },
    );
    if (!DECISION_ID.test(decisionId)) {
      fail(
        "SUPPLY_CHAIN_ADMISSION_DECISION",
        `$admissions.packages.${identity}.decisionId 必须引用 D-xxx 决定。`,
      );
    }
    if (!SCRIPT_DISPOSITIONS.has(admission.scriptDisposition)) {
      fail(
        "SUPPLY_CHAIN_ADMISSION_SCHEMA",
        `$admissions.packages.${identity}.scriptDisposition 不受支持。`,
      );
    }
    if (!HEX_64.test(admission.evidenceSha256 ?? "")) {
      fail(
        "SUPPLY_CHAIN_ADMISSION_SCHEMA",
        `$admissions.packages.${identity}.evidenceSha256 必须是 lowercase SHA-256。`,
      );
    }
    if (!Array.isArray(admission.obligations)) {
      fail(
        "SUPPLY_CHAIN_ADMISSION_SCHEMA",
        `$admissions.packages.${identity}.obligations 必须是 array。`,
      );
    }
    const obligations = admission.obligations.map((obligation, index) => assertSafeString(
      obligation,
      `$admissions.packages.${identity}.obligations[${index}]`,
      "SUPPLY_CHAIN_ADMISSION_SCHEMA",
    ));
    const sortedObligations = [...obligations].sort((left, right) => Buffer.compare(
      Buffer.from(left, "utf8"),
      Buffer.from(right, "utf8"),
    ));
    if (
      new Set(obligations).size !== obligations.length
      || obligations.some((obligation, index) => obligation !== sortedObligations[index])
    ) {
      fail(
        "SUPPLY_CHAIN_ADMISSION_SCHEMA",
        `$admissions.packages.${identity}.obligations 必须按 UTF-8 字节排序且不重复。`,
      );
    }
    packages.push([identity, {
      purpose,
      licenseClarification,
      scriptDisposition: admission.scriptDisposition,
      obligations,
      evidenceSha256: admission.evidenceSha256,
      decisionId,
    }]);
  }
  packages.sort((left, right) => Buffer.compare(
    Buffer.from(left[0], "utf8"),
    Buffer.from(right[0], "utf8"),
  ));
  return {
    version: value.version,
    kind: value.kind,
    status: value.status,
    owner: value.owner,
    packages: Object.fromEntries(packages),
  };
}

export function readAndValidateDependencyAdmissions(root) {
  const relativePath = "docs/contracts/dependency-admissions.json";
  const text = readRegularProjectFile(root, relativePath, "SUPPLY_CHAIN_ADMISSION_FILE");
  const value = parseJsonObject(
    text,
    relativePath,
    "SUPPLY_CHAIN_ADMISSION_JSON",
  );
  const admissions = validateDependencyAdmissionsObject(value);
  if (canonicalJsonBytes(admissions) !== text) {
    fail("SUPPLY_CHAIN_ADMISSION_CANONICAL", "dependency admissions 必须是 canonical JSON 字节。");
  }
  return admissions;
}

export function classifyLicenseExpression(expression, policy) {
  const value = assertSafeString(
    expression,
    "$spdx.packages[].licenseDeclared",
    "SUPPLY_CHAIN_LICENSE_UNKNOWN",
    { maxLength: 200 },
  );
  if (/\s|[()]/.test(value)) {
    fail("SUPPLY_CHAIN_LICENSE_COMPOUND", `复合许可证表达 ${value} 未获准。`);
  }
  if (value.startsWith("LicenseRef-") || value.includes(":LicenseRef-")) {
    fail("SUPPLY_CHAIN_LICENSE_CUSTOM", `自定义许可证 ${value} 未获准。`);
  }
  if (policy.licenses.deniedPrefixes.some((prefix) => value.startsWith(prefix))) {
    fail("SUPPLY_CHAIN_LICENSE_DENIED", `许可证 ${value} 不得进入主站静态分发图。`);
  }
  if (policy.licenses.preferred.includes(value)) return "preferred";
  if (policy.licenses.reviewRequired.includes(value)) return "review-required";
  fail("SUPPLY_CHAIN_LICENSE_UNKNOWN", `许可证 ${value} 不在已确认类别中。`);
}

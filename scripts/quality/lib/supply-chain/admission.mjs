import { collectLockedPackages, exactPackageIdentity } from "./lockfile.mjs";
import { fail } from "./errors.mjs";
import {
  classifyExactPackageLicense,
  ownerExceptionAdmissionClarification,
  validateDependencyLicenseEvidenceGraph,
} from "./license-evidence.mjs";

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertExactIdentitySet(actual, expected, code, message) {
  const left = [...actual].sort(compareBytes);
  const right = [...expected].sort(compareBytes);
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    fail(code, message);
  }
}

export function validateAdmissionClosure({ lockfile, manifest, admissions }) {
  const lockedPackages = collectLockedPackages(lockfile, manifest);
  const lockedIdentities = lockedPackages.map((package_) => package_.identity);
  const admittedIdentities = Object.keys(admissions.packages);
  assertExactIdentitySet(
    admittedIdentities,
    lockedIdentities,
    "SUPPLY_CHAIN_ADMISSION_CLOSURE",
    "dependency admissions 必须与 lock 中的精确第三方包一一对应。",
  );

  for (const package_ of lockedPackages) {
    const admission = admissions.packages[package_.identity];
    if (admission.scriptDisposition === "approved-exception") {
      fail(
        "SUPPLY_CHAIN_SCRIPT_EXECUTION_UNSUPPORTED",
        `${package_.identity} 记录了脚本执行例外，但当前冻结安装只允许 --ignore-scripts。`,
      );
    }
    const expectedDisposition = package_.hasInstallScript ? "ignored" : "absent";
    if (admission.scriptDisposition !== expectedDisposition) {
      fail(
        "SUPPLY_CHAIN_SCRIPT_MISMATCH",
        `${package_.identity} 的 lock 脚本标记与人工处置不一致。`,
      );
    }
  }
  return lockedPackages;
}

export function validateSpdxLicenseClosure({
  document,
  lockedPackages,
  admissions,
  licenseEvidence,
  policy,
}) {
  if (!Array.isArray(document?.packages)) {
    fail("SUPPLY_CHAIN_SPDX_PACKAGES", "canonical SPDX 缺少 packages array。");
  }
  const packagesByIdentity = new Map();
  for (const package_ of document.packages) {
    if (package_.packageFileName === "") continue;
    const identity = exactPackageIdentity(package_.name, package_.versionInfo);
    if (packagesByIdentity.has(identity)) {
      fail("SUPPLY_CHAIN_SPDX_PACKAGES", `${identity} 在 canonical SPDX 中重复。`);
    }
    packagesByIdentity.set(identity, package_);
  }
  assertExactIdentitySet(
    packagesByIdentity.keys(),
    lockedPackages.map((package_) => package_.identity),
    "SUPPLY_CHAIN_SPDX_CLOSURE",
    "canonical SPDX 的第三方包集合与 lock 不一致。",
  );

  const classifications = {};
  const licensePackages = [];
  for (const package_ of lockedPackages) {
    const spdxPackage = packagesByIdentity.get(package_.identity);
    const licensePackage = {
      identity: package_.identity,
      integrity: package_.integrity,
      licenseDeclared: spdxPackage.licenseDeclared,
      resolved: package_.resolved,
    };
    licensePackages.push(licensePackage);
    const { classification, licenseConcluded } = classifyExactPackageLicense({
      evidence: licenseEvidence,
      package_: licensePackage,
      policy,
    });
    const admission = admissions.packages[package_.identity];
    const legalEvidence = licenseEvidence.legalEvidence[package_.identity] ?? null;
    if (
      legalEvidence?.evidenceType === "owner-exception"
      && (
        admission.decisionId !== legalEvidence.decisionId
        || admission.licenseClarification
          !== ownerExceptionAdmissionClarification(legalEvidence)
      )
    ) {
      fail(
        "SUPPLY_CHAIN_LICENSE_OWNER_RISK",
        `${package_.identity} 的 owner exception 风险没有精确投影到 admissions。`,
      );
    }
    if (
      classification === "review-required"
      && (
        admission.licenseClarification.length === 0
        || admission.decisionId.length === 0
      )
    ) {
      fail(
        "SUPPLY_CHAIN_LICENSE_REVIEW_REQUIRED",
        `${package_.identity} 的许可证必须有精确人工复核决定。`,
      );
    }
    classifications[package_.identity] = {
      classification,
      licenseConcluded,
      licenseDeclared: spdxPackage.licenseDeclared,
    };
  }
  validateDependencyLicenseEvidenceGraph({
    evidence: licenseEvidence,
    packages: licensePackages,
  });
  return classifications;
}

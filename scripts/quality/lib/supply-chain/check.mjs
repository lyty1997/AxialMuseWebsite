import { NPM_VERSIONS_BY_ROLE } from "./contracts.mjs";
import {
  readAndValidateManifest,
  readAndValidateRuntimeContract,
  readRegularProjectFile,
  readRegularProjectFileBytes,
  validateProjectNpmrc,
} from "./config.mjs";
import {
  buildExpectedSpdxGraph,
  readAndValidateLockfile,
} from "./lockfile.mjs";
import {
  readAndValidateDependencyLicenseEvidence,
  validateDependencyLicenseEvidenceGraph,
  validatePackageLicenseEvidence,
} from "./license-evidence.mjs";
import {
  readAndValidateDependencyAdmissions,
  readAndValidateDependencyPolicy,
} from "./policy.mjs";
import {
  validateAdmissionClosure,
  validateSpdxLicenseClosure,
} from "./admission.mjs";
import { validateCanonicalSpdxArtifacts } from "./spdx.mjs";
import {
  parseThirdPartyNotices,
  validateNoticesClosure,
} from "./notices.mjs";

export function checkSupplyChain({ root }) {
  validateProjectNpmrc(root);
  const manifest = readAndValidateManifest(root);
  readAndValidateRuntimeContract({ root, manifest });
  const policy = readAndValidateDependencyPolicy(root);
  const admissions = readAndValidateDependencyAdmissions(root);
  const licenseEvidence = readAndValidateDependencyLicenseEvidence(root);
  const lockfile = readAndValidateLockfile(root, manifest);
  const noticeBytes = readRegularProjectFileBytes(
    root,
    "THIRD_PARTY_NOTICES",
    "SUPPLY_CHAIN_NOTICE_FILE",
  );
  const sbomBytes = readRegularProjectFile(
    root,
    "docs/generated/supply-chain/sbom.spdx.json",
    "SUPPLY_CHAIN_SBOM_FILE",
  );
  const evidenceBytes = readRegularProjectFile(
    root,
    "docs/generated/supply-chain/dependency-evidence.json",
    "SUPPLY_CHAIN_EVIDENCE_FILE",
  );
  return validateSupplyChainClosure({
    admissions,
    evidenceBytes,
    lockfile,
    licenseEvidence,
    manifest,
    noticeBytes,
    npmVersion: NPM_VERSIONS_BY_ROLE.primary,
    policy,
    sbomBytes,
  });
}

export function validateSupplyChainClosure({
  admissions,
  evidenceBytes,
  lockfile,
  licenseEvidence,
  manifest,
  noticeBytes,
  npmVersion,
  policy,
  sbomBytes,
}) {
  const lockedPackages = validateAdmissionClosure({
    lockfile,
    manifest,
    admissions,
  });
  const parsedNotices = parseThirdPartyNotices(noticeBytes);
  const licenseEvidencePackages = parsedNotices.map((record) => ({
    identity: record.identity,
    integrity: record.integrity,
    licenseDeclared: record.licenseDeclared,
    resolved: record.resolved,
  }));
  validateDependencyLicenseEvidenceGraph({
    evidence: licenseEvidence,
    packages: licenseEvidencePackages,
  });
  for (const [index, record] of parsedNotices.entries()) {
    validatePackageLicenseEvidence({
      evidence: licenseEvidence,
      licenseFiles: record.licenseFiles,
      package_: licenseEvidencePackages[index],
    });
  }
  const expectedGraph = buildExpectedSpdxGraph(lockfile, manifest, {
    packageMetadataByIdentity: new Map(parsedNotices.map((record) => [record.identity, record])),
    requirePackageMetadata: true,
  });
  const canonical = validateCanonicalSpdxArtifacts({
    sbomBytes,
    evidenceBytes,
    expectedGraph,
    npmVersion,
  });
  const licenses = validateSpdxLicenseClosure({
    document: canonical.document,
    lockedPackages,
    admissions,
    licenseEvidence,
    policy,
  });
  const notices = validateNoticesClosure({
    bytes: noticeBytes,
    lockedPackages,
    document: canonical.document,
    admissions,
  });
  return {
    admissions,
    evidence: canonical.evidence,
    licenses,
    lockedPackages,
    notices,
    policy,
  };
}

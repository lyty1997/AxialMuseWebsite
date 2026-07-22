export function emptyDependencyLicenseEvidence() {
  return {
    decisionId: "D-082",
    kind: "axial_muse_dependency_license_evidence",
    legalEvidence: {},
    licenseDecisions: {},
    owner: "AxialMuseWebsite",
    status: "active",
    version: "0.1.0",
  };
}

export function ownerExceptionRecord(lockedPackage, {
  licenseConcluded = "MIT",
  licenseDeclared = "MIT",
} = {}) {
  return {
    decisionId: "D-082",
    evidenceType: "owner-exception",
    integrity: lockedPackage.integrity,
    limitations: "Exact D-082 exception: this release lacks independent complete legal text.",
    licenseConcluded,
    licenseDeclared,
    resolved: lockedPackage.resolved,
    source: {
      risk: "missing-independent-complete-legal-text",
    },
  };
}

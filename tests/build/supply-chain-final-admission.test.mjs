import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PROJECT_NPM_CONFIG } from "../../scripts/quality/lib/supply-chain/contracts.mjs";
import { deriveNpmCli } from "../../scripts/quality/lib/supply-chain/environment.mjs";
import { NpmIsolationError } from "../../scripts/quality/lib/supply-chain/errors.mjs";
import {
  FINAL_ADMISSION_DECISION_ENVELOPE,
  openFinalAdmissionEvidence,
  parseFinalAdmissionDecision,
  renderFinalAdmissionDecision,
  validateFinalAdmissionEvidenceSummary,
  validateFinalAdmissionDecision,
} from "../../scripts/quality/lib/supply-chain/final-admission.mjs";
import {
  captureCurrentSupplyChainInputReceipt,
  supplyChainInputReceiptBytes,
} from "../../scripts/quality/lib/supply-chain/input-receipt.mjs";
import { EXPECTED_DEPENDENCY_POLICY } from "../../scripts/quality/lib/supply-chain/policy.mjs";
import { renderSupplyChainReviewReport } from "../../scripts/quality/lib/supply-chain/review-report.mjs";
import { canonicalJsonBytes } from "../../scripts/quality/lib/supply-chain/spdx.mjs";
import { emptyDependencyLicenseEvidence } from "./supply-chain-license-evidence-fixture.mjs";

function clone(value) {
  return structuredClone(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function npmrcText() {
  return `${Object.entries(PROJECT_NPM_CONFIG)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeRestricted(path, bytes) {
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function legalFile(path, text) {
  const bytes = Buffer.from(text, "utf8");
  return {
    path,
    rawSha256: sha256(bytes),
    size: bytes.length,
    text,
  };
}

function lockedPackage({ hasInstallScript = false } = {}) {
  return {
    hasInstallScript,
    identity: "alpha@1.0.0",
    integrity: `sha512-${Buffer.alloc(64, 0x31).toString("base64")}`,
    name: "alpha",
    paths: ["node_modules/alpha"],
    resolved: "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz",
    version: "1.0.0",
  };
}

function inspectionFor(locked, {
  description = "Synthetic final-admission fixture.",
  scripts = {},
} = {}) {
  const effectiveInstallScripts = Object.fromEntries(
    Object.entries(scripts).filter(([name]) => (
      name === "preinstall" || name === "install" || name === "postinstall"
    )),
  );
  return {
    actualHasInstallScript: Object.keys(effectiveInstallScripts).length > 0,
    bindingGyp: false,
    description,
    effectiveInstallScripts,
    entryCount: 3,
    gypfile: null,
    homepage: "https://example.test/alpha",
    identity: locked.identity,
    implicitNodeGyp: false,
    integrity: locked.integrity,
    integritySha512: Buffer.from(
      locked.integrity.slice("sha512-".length),
      "base64",
    ).toString("hex"),
    licenseDeclared: "MIT",
    licenseFiles: [legalFile("package/LICENSE", "Synthetic license text.\n")],
    noticeFiles: [],
    packageJsonSha256: sha256("synthetic alpha package.json\n"),
    scripts,
    scriptsSha256: sha256(`${JSON.stringify(scripts, null, 2)}\n`),
  };
}

function auditVulnerability() {
  return {
    name: "alpha",
    severity: "moderate",
    isDirect: true,
    via: [{
      source: 1001,
      name: "alpha",
      dependency: "alpha",
      title: "Synthetic moderate advisory",
      url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
      severity: "moderate",
      cwe: ["CWE-79"],
      cvss: {
        score: 6.5,
        vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L",
      },
      range: "<2.0.0",
    }],
    effects: [],
    range: "<2.0.0",
    nodes: ["node_modules/alpha"],
    fixAvailable: false,
  };
}

function auditReport({ blocked = false } = {}) {
  return {
    auditReportVersion: 2,
    vulnerabilities: blocked ? { alpha: auditVulnerability() } : {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: blocked ? 1 : 0,
        high: 0,
        critical: 0,
        total: blocked ? 1 : 0,
      },
      dependencies: {
        prod: 1,
        dev: 0,
        optional: 0,
        peer: 0,
        peerOptional: 0,
        total: 1,
      },
    },
  };
}

function decisionBindings(fixture) {
  return {
    admissionsSha256: sha256(readFileSync(fixture.formal.admissions)),
    auditRawSha256: sha256(readFileSync(fixture.paths.auditRawPath)),
    auditReceiptSha256: sha256(readFileSync(fixture.paths.auditReceiptPath)),
    candidateReceiptSha256: sha256(readFileSync(fixture.paths.candidateReceiptPath)),
    candidateReportSha256: sha256(readFileSync(fixture.paths.candidateReportPath)),
    dependencyEvidenceSha256: sha256(readFileSync(fixture.formal.evidence)),
    noticesSha256: sha256(readFileSync(fixture.formal.notices)),
    sbomSha256: sha256(readFileSync(fixture.formal.sbom)),
  };
}

function rewriteDecision(fixture, overrides = {}) {
  const decision = {
    ...FINAL_ADMISSION_DECISION_ENVELOPE,
    decisionId: "D-077",
    decidedAt: "2026-07-20T00:00:00Z",
    ...decisionBindings(fixture),
    ...overrides,
  };
  writeRestricted(
    fixture.paths.finalDecisionPath,
    renderFinalAdmissionDecision(decision),
  );
  fixture.decision = decision;
  return decision;
}

function createFixture({
  description = "Synthetic final-admission fixture.",
  lockHasInstallScript,
  scripts = {},
} = {}) {
  const outer = mkdtempSync("/tmp/axial-muse-final-admission-test-");
  const root = join(outer, "project");
  const candidateDirectory = join(outer, "candidate");
  const auditDirectory = join(outer, "audit");
  const decisionDirectory = join(outer, "decision");
  for (const directory of [root, candidateDirectory, auditDirectory, decisionDirectory]) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  mkdirSync(join(root, "docs", "contracts"), { recursive: true });
  mkdirSync(join(root, "docs", "generated", "supply-chain"), { recursive: true });

  const actualHasInstallScript = ["preinstall", "install", "postinstall"]
    .some((name) => Object.hasOwn(scripts, name));
  const hasInstallScript = lockHasInstallScript ?? actualHasInstallScript;
  const locked = lockedPackage({ hasInstallScript });
  const manifest = {
    name: "final-admission-fixture",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: { alpha: "1.0.0" },
    engines: {
      node: `>=${process.versions.node} <${Number(process.versions.node.split(".")[0]) + 1}`,
    },
  };
  const lockfile = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages: {
      "": {
        name: manifest.name,
        version: manifest.version,
        dependencies: clone(manifest.dependencies),
      },
      "node_modules/alpha": {
        version: locked.version,
        resolved: locked.resolved,
        integrity: locked.integrity,
        ...(hasInstallScript ? { hasInstallScript: true } : {}),
      },
    },
  };
  writeJson(join(root, "package.json"), manifest);
  writeJson(join(root, "package-lock.json"), lockfile);
  writeFileSync(join(root, ".npmrc"), npmrcText(), "utf8");
  writeFileSync(join(root, ".nvmrc"), `${process.versions.node}\n`, "utf8");
  writeFileSync(
    join(root, "docs", "contracts", "dependency-policy.json"),
    canonicalJsonBytes(EXPECTED_DEPENDENCY_POLICY),
    "utf8",
  );
  const licenseEvidence = emptyDependencyLicenseEvidence();
  writeFileSync(
    join(root, "docs", "contracts", "dependency-license-evidence.json"),
    canonicalJsonBytes(licenseEvidence),
    "utf8",
  );

  const formal = {
    admissions: join(root, "docs", "contracts", "dependency-admissions.json"),
    evidence: join(root, "docs", "generated", "supply-chain", "dependency-evidence.json"),
    notices: join(root, "THIRD_PARTY_NOTICES"),
    sbom: join(root, "docs", "generated", "supply-chain", "sbom.spdx.json"),
  };
  writeFileSync(formal.admissions, canonicalJsonBytes({ fixture: "admissions" }), "utf8");
  writeFileSync(formal.evidence, canonicalJsonBytes({ fixture: "evidence" }), "utf8");
  writeFileSync(formal.notices, "Synthetic THIRD_PARTY_NOTICES fixture.\n", "utf8");
  writeFileSync(formal.sbom, canonicalJsonBytes({ fixture: "sbom" }), "utf8");

  const npmVersion = deriveNpmCli(process.execPath).npmVersion;
  const npmVersionsByRole = { minimum: "0.0.0", primary: npmVersion };
  const receipt = captureCurrentSupplyChainInputReceipt({
    npmVersionsByRole,
    root,
  });
  const paths = {
    auditRawPath: join(auditDirectory, "raw-audit.json"),
    auditReceiptPath: join(auditDirectory, "receipt.json"),
    candidateReportPath: join(candidateDirectory, "report.json"),
    candidateReceiptPath: join(candidateDirectory, "receipt.json"),
    finalDecisionPath: join(decisionDirectory, "final-decision.json"),
  };
  writeRestricted(paths.candidateReportPath, renderSupplyChainReviewReport({
    inspections: [inspectionFor(locked, { description, scripts })],
    licenseEvidence,
    lockedPackages: [locked],
    policy: clone(EXPECTED_DEPENDENCY_POLICY),
    receipt,
  }));
  writeRestricted(paths.candidateReceiptPath, supplyChainInputReceiptBytes(receipt));
  writeRestricted(paths.auditRawPath, `${JSON.stringify(auditReport())}\n`);
  writeRestricted(paths.auditReceiptPath, supplyChainInputReceiptBytes(receipt));

  const fixture = {
    decision: null,
    formal,
    npmVersionsByRole,
    outer,
    paths,
    receipt,
    root,
  };
  rewriteDecision(fixture);
  return fixture;
}

function cleanupFixture(fixture) {
  rmSync(fixture.outer, { recursive: true, force: true });
}

function expectCode(action, code) {
  assert.throws(
    action,
    (error) => error instanceof NpmIsolationError && error.code === code,
  );
}

function closureResult(fixture, evidenceOverride = null) {
  const report = JSON.parse(readFileSync(fixture.paths.candidateReportPath, "utf8"));
  return {
    admissions: {
      packages: Object.fromEntries(report.packages.map((package_) => [
        package_.identity,
        {
          evidenceSha256: evidenceOverride ?? package_.evidenceSha256,
        },
      ])),
    },
  };
}

function openFixture(fixture, checkClosure = () => closureResult(fixture)) {
  return openFinalAdmissionEvidence({
    root: fixture.root,
    ...fixture.paths,
    npmVersionsByRole: fixture.npmVersionsByRole,
    checkClosure,
  });
}

test("D-077 final admission evidence chain", async (suite) => {
  await suite.test("validates an explicit canonical decision without creating approval", () => {
    const fixture = createFixture();
    try {
      assert.deepEqual(validateFinalAdmissionDecision(fixture.decision), fixture.decision);
      const bytes = renderFinalAdmissionDecision(fixture.decision);
      assert.deepEqual(parseFinalAdmissionDecision(bytes), fixture.decision);
      assert.equal(bytes, canonicalJsonBytes(fixture.decision));

      const unknown = { ...fixture.decision, approvedByAgent: true };
      expectCode(
        () => validateFinalAdmissionDecision(unknown),
        "FINAL_ADMISSION_DECISION_SCHEMA",
      );
      const millisecond = { ...fixture.decision, decidedAt: "2026-07-20T00:00:00.000Z" };
      expectCode(
        () => validateFinalAdmissionDecision(millisecond),
        "FINAL_ADMISSION_DECISION_SCHEMA",
      );
      expectCode(
        () => parseFinalAdmissionDecision(JSON.stringify(fixture.decision)),
        "FINAL_ADMISSION_DECISION_BYTES",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("holds all five artifacts and returns only a package-name-free summary", () => {
    const fixture = createFixture();
    let closureChecks = 0;
    let evidence;
    try {
      evidence = openFixture(fixture, () => {
        closureChecks += 1;
        return closureResult(fixture);
      });
      assert.equal(evidence.summary.status, "approved");
      assert.equal(evidence.summary.candidatePackageCount, 1);
      assert.equal(evidence.summary.audit.outcome, "pass");
      assert.equal(evidence.summary.audit.dependencyTotal, 1);
      assert.equal(JSON.stringify(evidence.summary).includes("alpha"), false);
      assert.deepEqual(evidence.assertCurrent(), evidence.summary);
      assert.equal(closureChecks, 2);
      evidence.close();
      expectCode(() => evidence.assertCurrent(), "FINAL_ADMISSION_CLOSED");
    } finally {
      evidence?.close();
      cleanupFixture(fixture);
    }
  });

  await suite.test("uses the real formal-closure checker unless a test injection is explicit", () => {
    const fixture = createFixture();
    try {
      assert.throws(
        () => openFinalAdmissionEvidence({
          root: fixture.root,
          ...fixture.paths,
          npmVersionsByRole: fixture.npmVersionsByRole,
        }),
        (error) => error instanceof NpmIsolationError
          && error.code === "SUPPLY_CHAIN_ADMISSION_SCHEMA",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("fails closed when any required evidence is missing", () => {
    const fixture = createFixture();
    try {
      unlinkSync(fixture.paths.auditRawPath);
      expectCode(() => openFixture(fixture), "FINAL_ADMISSION_DIRECTORY");
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("requires byte-identical candidate and audit receipts", () => {
    const fixture = createFixture();
    try {
      const mismatched = clone(fixture.receipt);
      mismatched.inputs["package.json"] = "f".repeat(64);
      writeRestricted(
        fixture.paths.auditReceiptPath,
        supplyChainInputReceiptBytes(mismatched),
      );
      rewriteDecision(fixture);
      expectCode(() => openFixture(fixture), "FINAL_ADMISSION_RECEIPT_MISMATCH");
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("requires the candidate report embedded receipt to equal its sidecar", () => {
    const fixture = createFixture();
    try {
      const report = JSON.parse(readFileSync(fixture.paths.candidateReportPath, "utf8"));
      report.receipt.inputs["package.json"] = "e".repeat(64);
      writeRestricted(
        fixture.paths.candidateReportPath,
        canonicalJsonBytes(report),
      );
      rewriteDecision(fixture);
      expectCode(() => openFixture(fixture), "FINAL_ADMISSION_RECEIPT_MISMATCH");
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("rejects a policy-blocked audit even when the decision hashes it", () => {
    const fixture = createFixture();
    try {
      writeRestricted(
        fixture.paths.auditRawPath,
        `${JSON.stringify(auditReport({ blocked: true }))}\n`,
      );
      rewriteDecision(fixture);
      expectCode(() => openFixture(fixture), "FINAL_ADMISSION_AUDIT_BLOCKED");
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("rejects a canonical decision whose evidence hash drifts", () => {
    const fixture = createFixture();
    try {
      rewriteDecision(fixture, { candidateReportSha256: "0".repeat(64) });
      expectCode(() => openFixture(fixture), "FINAL_ADMISSION_DECISION_DRIFT");
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("binds every candidate identity and evidence hash to formal admissions", () => {
    const fixture = createFixture();
    try {
      expectCode(
        () => openFixture(fixture, () => closureResult(fixture, "f".repeat(64))),
        "FINAL_ADMISSION_CANDIDATE_FORMAL_DRIFT",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("recomputes candidate evidence instead of trusting its embedded hash", () => {
    const fixture = createFixture();
    try {
      const report = JSON.parse(readFileSync(fixture.paths.candidateReportPath, "utf8"));
      report.packages[0].description = "Tampered after tarball inspection.";
      writeRestricted(fixture.paths.candidateReportPath, canonicalJsonBytes(report));
      rewriteDecision(fixture);
      expectCode(() => openFixture(fixture), "FINAL_ADMISSION_CANDIDATE_REPORT");
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("accepts a non-lifecycle scripts witness without inventing install scripts", () => {
    const fixture = createFixture({ scripts: { test: "node --test" } });
    let evidence;
    try {
      evidence = openFixture(fixture);
      assert.equal(evidence.summary.candidatePackageCount, 1);
      assert.equal(evidence.summary.status, "approved");
    } finally {
      evidence?.close();
      cleanupFixture(fixture);
    }
  });

  await suite.test("preserves empty and edge-spaced descriptions through final admission", () => {
    for (const description of ["", "  Synthetic final description.  "]) {
      const fixture = createFixture({
        description,
        lockHasInstallScript: true,
      });
      let evidence;
      try {
        const report = JSON.parse(readFileSync(fixture.paths.candidateReportPath, "utf8"));
        assert.equal(report.packages[0].description, description);
        assert.deepEqual(report.packages[0].effectiveInstallScripts, {});
        evidence = openFixture(fixture);
        assert.equal(evidence.summary.status, "approved");
      } finally {
        evidence?.close();
        cleanupFixture(fixture);
      }
    }
  });

  await suite.test("rejects effective scripts after the current lock marker is removed", () => {
    const fixture = createFixture({
      lockHasInstallScript: true,
      scripts: { install: "node install.js" },
    });
    try {
      const lockPath = join(fixture.root, "package-lock.json");
      const lockfile = JSON.parse(readFileSync(lockPath, "utf8"));
      delete lockfile.packages["node_modules/alpha"].hasInstallScript;
      writeJson(lockPath, lockfile);

      const receipt = captureCurrentSupplyChainInputReceipt({
        npmVersionsByRole: fixture.npmVersionsByRole,
        root: fixture.root,
      });
      const report = JSON.parse(readFileSync(fixture.paths.candidateReportPath, "utf8"));
      report.receipt = receipt;
      writeRestricted(fixture.paths.candidateReportPath, canonicalJsonBytes(report));
      writeRestricted(
        fixture.paths.candidateReceiptPath,
        supplyChainInputReceiptBytes(receipt),
      );
      writeRestricted(
        fixture.paths.auditReceiptPath,
        supplyChainInputReceiptBytes(receipt),
      );
      fixture.receipt = receipt;
      rewriteDecision(fixture);

      expectCode(() => openFixture(fixture), "FINAL_ADMISSION_CANDIDATE_REPORT");
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("rejects malformed UTF-8 in candidate, audit, receipt, and decision bytes", () => {
    const malformed = Buffer.from([0xc3, 0x28]);
    const cases = [
      {
        code: "FINAL_ADMISSION_CANDIDATE_REPORT",
        mutate(fixture) {
          writeRestricted(fixture.paths.candidateReportPath, malformed);
          rewriteDecision(fixture);
        },
      },
      {
        code: "FINAL_ADMISSION_AUDIT_BYTES",
        mutate(fixture) {
          writeRestricted(fixture.paths.auditRawPath, malformed);
          rewriteDecision(fixture);
        },
      },
      {
        code: "FINAL_ADMISSION_RECEIPT_BYTES",
        mutate(fixture) {
          writeRestricted(fixture.paths.candidateReceiptPath, malformed);
          rewriteDecision(fixture);
        },
      },
      {
        code: "FINAL_ADMISSION_RECEIPT_BYTES",
        mutate(fixture) {
          writeRestricted(fixture.paths.auditReceiptPath, malformed);
          rewriteDecision(fixture);
        },
      },
      {
        code: "FINAL_ADMISSION_DECISION_BYTES",
        mutate(fixture) {
          writeRestricted(fixture.paths.finalDecisionPath, malformed);
        },
      },
    ];
    for (const testCase of cases) {
      const fixture = createFixture();
      try {
        testCase.mutate(fixture);
        expectCode(() => openFixture(fixture), testCase.code);
      } finally {
        cleanupFixture(fixture);
      }
    }
  });

  await suite.test("detects formal same-inode A-to-B-to-A mutation during closure", () => {
    const fixture = createFixture();
    let closureChecks = 0;
    let evidence;
    try {
      evidence = openFixture(fixture, () => {
        closureChecks += 1;
        if (closureChecks === 2) {
          const original = readFileSync(fixture.formal.evidence);
          writeFileSync(fixture.formal.evidence, "temporary formal mutation\n", "utf8");
          writeFileSync(fixture.formal.evidence, original);
        }
        return closureResult(fixture);
      });
      expectCode(() => evidence.assertCurrent(), "FINAL_ADMISSION_FORMAL_DRIFT");
    } finally {
      evidence?.close();
      cleanupFixture(fixture);
    }
  });

  await suite.test("detects formal rename A-to-B-to-A mutation during closure", () => {
    const fixture = createFixture();
    const alternate = join(
      fixture.root,
      "docs",
      "generated",
      "supply-chain",
      "dependency-evidence.swap",
    );
    let closureChecks = 0;
    let evidence;
    try {
      evidence = openFixture(fixture, () => {
        closureChecks += 1;
        if (closureChecks === 2) {
          renameSync(fixture.formal.evidence, alternate);
          renameSync(alternate, fixture.formal.evidence);
        }
        return closureResult(fixture);
      });
      expectCode(() => evidence.assertCurrent(), "FINAL_ADMISSION_FORMAL_DRIFT");
    } finally {
      evidence?.close();
      cleanupFixture(fixture);
    }
  });

  await suite.test("detects held supply-input A-to-B-to-A mutation", () => {
    const fixture = createFixture();
    const manifestPath = join(fixture.root, "package.json");
    let evidence;
    try {
      evidence = openFixture(fixture);
      const original = readFileSync(manifestPath);
      writeFileSync(manifestPath, "temporary input mutation\n", "utf8");
      writeFileSync(manifestPath, original);
      expectCode(() => evidence.assertCurrent(), "FINAL_ADMISSION_RECEIPT_DRIFT");
    } finally {
      evidence?.close();
      cleanupFixture(fixture);
    }
  });

  await suite.test("summary validation rejects receipt divergence and blocking severities", () => {
    const fixture = createFixture();
    let evidence;
    try {
      evidence = openFixture(fixture);
      const receiptMismatch = clone(evidence.summary);
      receiptMismatch.auditReceiptSha256 = "f".repeat(64);
      expectCode(
        () => validateFinalAdmissionEvidenceSummary(receiptMismatch),
        "FINAL_ADMISSION_SUMMARY_SCHEMA",
      );

      const blocking = clone(evidence.summary);
      blocking.audit.moderate = 1;
      blocking.audit.total = 1;
      expectCode(
        () => validateFinalAdmissionEvidenceSummary(blocking),
        "FINAL_ADMISSION_SUMMARY_SCHEMA",
      );

      const impossiblePackageCount = clone(evidence.summary);
      impossiblePackageCount.candidatePackageCount = 2;
      expectCode(
        () => validateFinalAdmissionEvidenceSummary(impossiblePackageCount),
        "FINAL_ADMISSION_SUMMARY_SCHEMA",
      );

      const impossibleEmptyCandidate = clone(evidence.summary);
      impossibleEmptyCandidate.candidatePackageCount = 0;
      expectCode(
        () => validateFinalAdmissionEvidenceSummary(impossibleEmptyCandidate),
        "FINAL_ADMISSION_SUMMARY_SCHEMA",
      );

      const impossibleVulnerabilityCount = clone(evidence.summary);
      impossibleVulnerabilityCount.audit.low = 2;
      impossibleVulnerabilityCount.audit.total = 2;
      expectCode(
        () => validateFinalAdmissionEvidenceSummary(impossibleVulnerabilityCount),
        "FINAL_ADMISSION_SUMMARY_SCHEMA",
      );

      const impossibleDecisionHash = clone(evidence.summary);
      impossibleDecisionHash.finalDecisionSha256 = "f".repeat(64);
      expectCode(
        () => validateFinalAdmissionEvidenceSummary(impossibleDecisionHash),
        "FINAL_ADMISSION_SUMMARY_SCHEMA",
      );
    } finally {
      evidence?.close();
      cleanupFixture(fixture);
    }
  });

  await suite.test("detects same-inode A-to-B-to-A mutation from held metadata", () => {
    const fixture = createFixture();
    let evidence;
    try {
      evidence = openFixture(fixture);
      const original = readFileSync(fixture.paths.candidateReportPath);
      writeFileSync(fixture.paths.candidateReportPath, "temporary mutation\n", "utf8");
      writeFileSync(fixture.paths.candidateReportPath, original);
      expectCode(() => evidence.assertCurrent(), "FINAL_ADMISSION_EVIDENCE_DRIFT");
    } finally {
      evidence?.close();
      cleanupFixture(fixture);
    }
  });

  await suite.test("detects same-byte inode replacement instead of trusting the path", () => {
    const fixture = createFixture();
    let evidence;
    try {
      evidence = openFixture(fixture);
      const original = readFileSync(fixture.paths.auditReceiptPath);
      unlinkSync(fixture.paths.auditReceiptPath);
      writeRestricted(fixture.paths.auditReceiptPath, original);
      expectCode(() => evidence.assertCurrent(), "FINAL_ADMISSION_EVIDENCE_DRIFT");
    } finally {
      evidence?.close();
      cleanupFixture(fixture);
    }
  });

  await suite.test("rejects loose permissions and extra restricted-directory entries", () => {
    const loose = createFixture();
    try {
      chmodSync(loose.paths.candidateReportPath, 0o644);
      expectCode(() => openFixture(loose), "FINAL_ADMISSION_FILE");
    } finally {
      cleanupFixture(loose);
    }

    const extra = createFixture();
    try {
      writeRestricted(join(extra.outer, "candidate", "unexpected.json"), "{}\n");
      expectCode(() => openFixture(extra), "FINAL_ADMISSION_DIRECTORY");
    } finally {
      cleanupFixture(extra);
    }
  });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateAdmissionClosure, validateSpdxLicenseClosure } from "../../scripts/quality/lib/supply-chain/admission.mjs";
import { checkSupplyChain } from "../../scripts/quality/lib/supply-chain/check.mjs";
import {
  NPM_VERSIONS_BY_ROLE,
  PROJECT_NPM_CONFIG,
} from "../../scripts/quality/lib/supply-chain/contracts.mjs";
import { NpmIsolationError } from "../../scripts/quality/lib/supply-chain/errors.mjs";
import {
  buildExpectedSpdxGraph,
  collectLockedPackages,
} from "../../scripts/quality/lib/supply-chain/lockfile.mjs";
import { ownerExceptionAdmissionClarification } from "../../scripts/quality/lib/supply-chain/license-evidence.mjs";
import {
  EXPECTED_DEPENDENCY_POLICY,
  readAndValidateDependencyAdmissions,
  readAndValidateDependencyPolicy,
  validateDependencyAdmissionsObject,
  validateDependencyPolicyObject,
} from "../../scripts/quality/lib/supply-chain/policy.mjs";
import {
  packageEvidenceSha256,
  renderThirdPartyNotices,
} from "../../scripts/quality/lib/supply-chain/notices.mjs";
import {
  canonicalJsonBytes,
  normalizeNpmSpdx,
} from "../../scripts/quality/lib/supply-chain/spdx.mjs";
import {
  emptyDependencyLicenseEvidence,
  ownerExceptionRecord,
} from "./supply-chain-license-evidence-fixture.mjs";

const TEST_DIRECTORY = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PROJECT_ROOT = resolve(TEST_DIRECTORY, "../..");
const SPDX_FIXTURES = resolve(TEST_DIRECTORY, "../fixtures/supply-chain/spdx");
const POLICY_PATH = resolve(PROJECT_ROOT, "docs/contracts/dependency-policy.json");

function clone(value) {
  return structuredClone(value);
}

function expectCode(action, code) {
  assert.throws(action, (error) => error instanceof NpmIsolationError && error.code === code);
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function writeCanonicalJson(path, value) {
  writeText(path, canonicalJsonBytes(value));
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function legalFile(path, text) {
  return { path, rawSha256: sha256(text), text };
}

function manifestFixture() {
  return {
    name: "e011-fixture",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: { alpha: "1.2.3" },
    devDependencies: { "@scope/beta": "2.0.0" },
    engines: { node: ">=24.16.0 <25" },
  };
}

function lockfileFixture(manifest = manifestFixture()) {
  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages: {
      "": {
        name: manifest.name,
        version: manifest.version,
        dependencies: clone(manifest.dependencies),
        devDependencies: clone(manifest.devDependencies),
      },
      "node_modules/alpha": {
        version: "1.2.3",
        resolved: "https://registry.npmjs.org/alpha/-/alpha-1.2.3.tgz",
        integrity: `sha512-${Buffer.alloc(64, 0xaa).toString("base64")}`,
      },
      "node_modules/@scope/beta": {
        version: "2.0.0",
        resolved: "https://registry.npmjs.org/@scope/beta/-/beta-2.0.0.tgz",
        integrity: `sha512-${Buffer.alloc(64, 0xbb).toString("base64")}`,
        hasInstallScript: true,
      },
    },
  };
}

function admissionFixture(overrides = {}) {
  const admissions = {
    kind: "axial_muse_dependency_admissions",
    owner: "AxialMuseWebsite",
    packages: {
      "@scope/beta@2.0.0": {
        decisionId: "D-999",
        evidenceSha256: "b".repeat(64),
        licenseClarification: "Synthetic Apache-2.0 package metadata and license evidence agree.",
        obligations: ["Retain copyright and license text."],
        purpose: "Synthetic scoped development dependency.",
        scriptDisposition: "ignored",
      },
      "alpha@1.2.3": {
        decisionId: "D-999",
        evidenceSha256: "a".repeat(64),
        licenseClarification: "Synthetic MIT package metadata and license evidence agree.",
        obligations: ["Retain copyright and license text."],
        purpose: "Synthetic direct runtime dependency.",
        scriptDisposition: "absent",
      },
    },
    status: "active",
    version: "0.1.0",
    ...overrides,
  };
  if (overrides.packages === undefined) {
    for (const record of noticeRecordsFixture(admissions)) {
      admissions.packages[record.identity].evidenceSha256 = packageEvidenceSha256(record);
    }
  }
  return admissions;
}

function noticeRecordsFixture(admissions) {
  const records = [
    {
      bindingGyp: false,
      description: "Synthetic alpha package",
      gypfile: null,
      homepage: "https://example.test/alpha",
      identity: "alpha@1.2.3",
      implicitNodeGyp: false,
      installScripts: {},
      integrity: `sha512-${Buffer.alloc(64, 0xaa).toString("base64")}`,
      licenseDeclared: "MIT",
      licenseFiles: [legalFile("package/LICENSE", "Synthetic MIT license text.\n")],
      noticeFiles: [],
      packageJsonSha256: "1".repeat(64),
      resolved: "https://registry.npmjs.org/alpha/-/alpha-1.2.3.tgz",
    },
    {
      bindingGyp: false,
      description: null,
      gypfile: null,
      homepage: "NOASSERTION",
      identity: "@scope/beta@2.0.0",
      implicitNodeGyp: false,
      installScripts: { install: "node-gyp rebuild" },
      integrity: `sha512-${Buffer.alloc(64, 0xbb).toString("base64")}`,
      licenseDeclared: "Apache-2.0",
      licenseFiles: [legalFile("package/LICENSE", "Synthetic Apache-2.0 license text.\n")],
      noticeFiles: [legalFile("package/NOTICE", "Synthetic NOTICE text.\n")],
      packageJsonSha256: "2".repeat(64),
      resolved: "https://registry.npmjs.org/@scope/beta/-/beta-2.0.0.tgz",
    },
  ];
  return records.map((record) => ({
    ...record,
    decisionId: admissions.packages[record.identity].decisionId,
    licenseClarification: admissions.packages[record.identity].licenseClarification,
    obligations: clone(admissions.packages[record.identity].obligations),
    purpose: admissions.packages[record.identity].purpose,
    scriptDisposition: admissions.packages[record.identity].scriptDisposition,
  }));
}

function expectedNpmrc() {
  return `${Object.entries(PROJECT_NPM_CONFIG).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function canonicalSpdxArtifacts({ admissions, lockfile, manifest }) {
  const noticeRecords = noticeRecordsFixture(admissions);
  const expectedGraph = buildExpectedSpdxGraph(lockfile, manifest, {
    packageMetadataByIdentity: new Map(noticeRecords.map((record) => [
      record.identity,
      record,
    ])),
    requirePackageMetadata: true,
  });
  const nativeDocument = JSON.parse(readFileSync(join(SPDX_FIXTURES, "native-a.json"), "utf8"));
  const alpha = nativeDocument.packages.find((package_) => package_.name === "alpha");
  delete alpha.description;
  alpha.homepage = "NOASSERTION";
  return normalizeNpmSpdx({
    nativeDocument,
    expectedGraph,
    npmVersion: NPM_VERSIONS_BY_ROLE.primary,
    createdAt: "2026-07-19T10:11:12Z",
  });
}

function createProjectFixture() {
  const outer = mkdtempSync("/tmp/axial-muse-d077-policy-");
  const root = join(outer, "project");
  mkdirSync(root);
  const manifest = manifestFixture();
  const lockfile = lockfileFixture(manifest);
  const admissions = admissionFixture();
  const spdx = canonicalSpdxArtifacts({ admissions, lockfile, manifest });
  writeCanonicalJson(join(root, "package.json"), manifest);
  writeJson(join(root, "package-lock.json"), lockfile);
  writeText(join(root, ".npmrc"), expectedNpmrc());
  writeText(join(root, ".nvmrc"), "24.18.0\n");
  writeText(
    join(root, "docs/contracts/dependency-policy.json"),
    readFileSync(POLICY_PATH, "utf8"),
  );
  writeCanonicalJson(
    join(root, "docs/contracts/dependency-license-evidence.json"),
    emptyDependencyLicenseEvidence(),
  );
  writeCanonicalJson(
    join(root, "docs/contracts/dependency-admissions.json"),
    admissions,
  );
  writeText(
    join(root, "docs/generated/supply-chain/dependency-evidence.json"),
    spdx.evidenceBytes,
  );
  writeText(
    join(root, "docs/generated/supply-chain/sbom.spdx.json"),
    spdx.bytes,
  );
  writeText(
    join(root, "THIRD_PARTY_NOTICES"),
    renderThirdPartyNotices(noticeRecordsFixture(admissions)),
  );
  return { outer, root, manifest, lockfile };
}

function withProjectFixture(action) {
  const fixture = createProjectFixture();
  try {
    return action(fixture);
  } finally {
    rmSync(fixture.outer, { recursive: true, force: true });
  }
}

function canonicalSpdxFixture() {
  const manifest = manifestFixture();
  const lockfile = lockfileFixture(manifest);
  const admissions = admissionFixture();
  return canonicalSpdxArtifacts({ admissions, lockfile, manifest }).document;
}

test("D-077 static supply-chain policy contract", async (suite) => {
  await suite.test("accepts only the exact canonical policy and admission schemas", () => {
    assert.deepEqual(
      validateDependencyPolicyObject(clone(EXPECTED_DEPENDENCY_POLICY)),
      EXPECTED_DEPENDENCY_POLICY,
    );
    assert.deepEqual(
      validateDependencyAdmissionsObject(admissionFixture()),
      admissionFixture(),
    );
    withProjectFixture(({ root }) => {
      assert.equal(readAndValidateDependencyPolicy(root).registry.origin, "https://registry.npmjs.org/");
      assert.equal(Object.keys(readAndValidateDependencyAdmissions(root).packages).length, 2);
    });
  });

  await suite.test("rejects policy schema, value and canonical byte drift", () => {
    const unknown = clone(EXPECTED_DEPENDENCY_POLICY);
    unknown.allowMirror = true;
    expectCode(() => validateDependencyPolicyObject(unknown), "SUPPLY_CHAIN_POLICY_SCHEMA");

    const weakened = clone(EXPECTED_DEPENDENCY_POLICY);
    weakened.audit.blockingSeverities = ["high", "critical"];
    expectCode(() => validateDependencyPolicyObject(weakened), "SUPPLY_CHAIN_POLICY_DRIFT");

    const scriptAllow = clone(EXPECTED_DEPENDENCY_POLICY);
    scriptAllow.lifecycleScripts.default = "allow";
    expectCode(() => validateDependencyPolicyObject(scriptAllow), "SUPPLY_CHAIN_POLICY_DRIFT");

    withProjectFixture(({ root }) => {
      const path = join(root, "docs/contracts/dependency-policy.json");
      const canonical = readFileSync(path, "utf8");
      writeText(path, canonical.replace("\n", "\r\n"));
      expectCode(() => readAndValidateDependencyPolicy(root), "SUPPLY_CHAIN_POLICY_CANONICAL");
    });
  });

  await suite.test("rejects malformed admission identities, decisions, obligations and bytes", () => {
    const range = admissionFixture();
    range.packages["alpha@^1.2.3"] = range.packages["alpha@1.2.3"];
    delete range.packages["alpha@1.2.3"];
    expectCode(() => validateDependencyAdmissionsObject(range), "SUPPLY_CHAIN_ADMISSION_IDENTITY");

    const decision = admissionFixture();
    decision.packages["alpha@1.2.3"].decisionId = "TODO";
    expectCode(() => validateDependencyAdmissionsObject(decision), "SUPPLY_CHAIN_ADMISSION_DECISION");

    const obligations = admissionFixture();
    obligations.packages["alpha@1.2.3"].obligations = ["z", "a"];
    expectCode(() => validateDependencyAdmissionsObject(obligations), "SUPPLY_CHAIN_ADMISSION_SCHEMA");

    const unknown = admissionFixture();
    unknown.packages["alpha@1.2.3"].approved = true;
    expectCode(() => validateDependencyAdmissionsObject(unknown), "SUPPLY_CHAIN_ADMISSION_SCHEMA");

    withProjectFixture(({ root }) => {
      const path = join(root, "docs/contracts/dependency-admissions.json");
      const canonical = readFileSync(path, "utf8");
      writeText(path, canonical.replace(
        '"kind": "axial_muse_dependency_admissions",',
        '"kind": "axial_muse_dependency_admissions",\n  "kind": "axial_muse_dependency_admissions",',
      ));
      expectCode(() => readAndValidateDependencyAdmissions(root), "SUPPLY_CHAIN_ADMISSION_CANONICAL");
    });
  });

  await suite.test("binds admissions exactly to the unique lock inventory and script markers", () => {
    const manifest = manifestFixture();
    const lockfile = lockfileFixture(manifest);
    const admissions = validateDependencyAdmissionsObject(admissionFixture());
    assert.equal(validateAdmissionClosure({ lockfile, manifest, admissions }).length, 2);

    const missing = validateDependencyAdmissionsObject(admissionFixture());
    delete missing.packages["alpha@1.2.3"];
    expectCode(
      () => validateAdmissionClosure({ lockfile, manifest, admissions: missing }),
      "SUPPLY_CHAIN_ADMISSION_CLOSURE",
    );

    const scriptMismatch = validateDependencyAdmissionsObject(admissionFixture());
    scriptMismatch.packages["@scope/beta@2.0.0"].scriptDisposition = "absent";
    expectCode(
      () => validateAdmissionClosure({ lockfile, manifest, admissions: scriptMismatch }),
      "SUPPLY_CHAIN_SCRIPT_MISMATCH",
    );

    const exception = validateDependencyAdmissionsObject(admissionFixture());
    exception.packages["@scope/beta@2.0.0"].scriptDisposition = "approved-exception";
    expectCode(
      () => validateAdmissionClosure({ lockfile, manifest, admissions: exception }),
      "SUPPLY_CHAIN_SCRIPT_EXECUTION_UNSUPPORTED",
    );
  });

  await suite.test("aggregates identical physical nodes into the pinned npm SPDX projection", () => {
    const manifest = manifestFixture();
    const lockfile = lockfileFixture(manifest);
    const nestedPath = "node_modules/container/node_modules/alpha";
    lockfile.packages[nestedPath] = clone(
      lockfile.packages["node_modules/alpha"],
    );
    const inventory = collectLockedPackages(lockfile, manifest);
    assert.deepEqual(
      inventory.find((package_) => package_.identity === "alpha@1.2.3").paths,
      ["node_modules/alpha", nestedPath],
    );

    const graph = buildExpectedSpdxGraph(lockfile, manifest);
    const alphaPackages = graph.packages.filter((package_) => package_.name === "alpha");
    assert.equal(alphaPackages.length, 1);
    assert.equal(alphaPackages[0].packageFileName, "node_modules/alpha");

    const reordered = clone(lockfile);
    const rootEntry = reordered.packages[""];
    const dependencyEntries = Object.entries(reordered.packages)
      .filter(([path]) => path !== "")
      .reverse();
    reordered.packages = Object.fromEntries([["", rootEntry], ...dependencyEntries]);
    assert.deepEqual(buildExpectedSpdxGraph(reordered, manifest), graph);

    for (const mutate of [
      (entry) => {
        entry.resolved = "https://REGISTRY.NPMJS.ORG/alpha/-/alpha-1.2.3.tgz";
      },
      (entry) => {
        entry.integrity = `sha512-${Buffer.alloc(64, 0xdd).toString("base64")}`;
      },
      (entry) => {
        entry.hasInstallScript = true;
      },
    ]) {
      const conflict = clone(lockfile);
      mutate(conflict.packages[nestedPath]);
      expectCode(
        () => buildExpectedSpdxGraph(conflict, manifest),
        "NPM_LOCK_PACKAGE_IDENTITY",
      );
    }
  });

  await suite.test("classifies preferred and reviewed licenses while denying unsafe expressions", () => {
    const manifest = manifestFixture();
    const lockfile = lockfileFixture(manifest);
    const lockedPackages = collectLockedPackages(lockfile, manifest);
    const admissions = validateDependencyAdmissionsObject(admissionFixture());
    const policy = validateDependencyPolicyObject(clone(EXPECTED_DEPENDENCY_POLICY));
    const licenseEvidence = emptyDependencyLicenseEvidence();
    const document = canonicalSpdxFixture();
    const accepted = validateSpdxLicenseClosure({
      admissions,
      document,
      licenseEvidence,
      lockedPackages,
      policy,
    });
    assert.equal(accepted["alpha@1.2.3"].classification, "preferred");

    const ownerEvidence = emptyDependencyLicenseEvidence();
    const alpha = lockedPackages.find((package_) => package_.identity === "alpha@1.2.3");
    const ownerRecord = ownerExceptionRecord(alpha);
    ownerEvidence.legalEvidence[alpha.identity] = ownerRecord;
    const ownerAdmissions = validateDependencyAdmissionsObject(admissionFixture());
    ownerAdmissions.packages[alpha.identity].decisionId = ownerRecord.decisionId;
    ownerAdmissions.packages[alpha.identity].licenseClarification =
      ownerExceptionAdmissionClarification(ownerRecord);
    assert.equal(
      validateSpdxLicenseClosure({
        admissions: ownerAdmissions,
        document,
        licenseEvidence: ownerEvidence,
        lockedPackages,
        policy,
      })[alpha.identity].classification,
      "review-required",
    );

    const missingOwnerRisk = clone(ownerAdmissions);
    missingOwnerRisk.packages[alpha.identity].licenseClarification =
      "D-082 exact owner exception without the bound residual risk.";
    expectCode(
      () => validateSpdxLicenseClosure({
        admissions: missingOwnerRisk,
        document,
        licenseEvidence: ownerEvidence,
        lockedPackages,
        policy,
      }),
      "SUPPLY_CHAIN_LICENSE_OWNER_RISK",
    );

    const wrongOwnerDecision = clone(ownerAdmissions);
    wrongOwnerDecision.packages[alpha.identity].decisionId = "D-999";
    expectCode(
      () => validateSpdxLicenseClosure({
        admissions: wrongOwnerDecision,
        document,
        licenseEvidence: ownerEvidence,
        lockedPackages,
        policy,
      }),
      "SUPPLY_CHAIN_LICENSE_OWNER_RISK",
    );

    const newlyPreferred = clone(document);
    newlyPreferred.packages.find((package_) => package_.name === "alpha").licenseDeclared =
      "BlueOak-1.0.0";
    assert.equal(
      validateSpdxLicenseClosure({
        admissions,
        document: newlyPreferred,
        licenseEvidence,
        lockedPackages,
        policy,
      })["alpha@1.2.3"].classification,
      "preferred",
    );

    const reviewed = clone(document);
    reviewed.packages.find((package_) => package_.name === "alpha").licenseDeclared = "MPL-2.0";
    assert.equal(
      validateSpdxLicenseClosure({
        admissions,
        document: reviewed,
        licenseEvidence,
        lockedPackages,
        policy,
      })["alpha@1.2.3"].classification,
      "review-required",
    );

    for (const [license, code] of [
      ["GPL-3.0-only", "SUPPLY_CHAIN_LICENSE_DENIED"],
      ["MIT OR Apache-2.0", "SUPPLY_CHAIN_LICENSE_COMPOUND"],
      ["LicenseRef-Synthetic", "SUPPLY_CHAIN_LICENSE_CUSTOM"],
      ["Zlib", "SUPPLY_CHAIN_LICENSE_UNKNOWN"],
    ]) {
      const rejected = clone(document);
      rejected.packages.find((package_) => package_.name === "alpha").licenseDeclared = license;
      expectCode(
        () => validateSpdxLicenseClosure({
          admissions,
          document: rejected,
          licenseEvidence,
          lockedPackages,
          policy,
        }),
        code,
      );
    }
  });

  await suite.test("verifies the complete lock, admission and canonical SPDX closure offline", () => {
    withProjectFixture(({ root }) => {
      const result = checkSupplyChain({ root });
      assert.equal(result.lockedPackages.length, 2);
      assert.deepEqual(Object.keys(result.licenses).sort(), ["@scope/beta@2.0.0", "alpha@1.2.3"]);
    });
  });

  await suite.test("fails on missing packages and mixed SPDX/evidence snapshots", () => {
    withProjectFixture(({ root }) => {
      const path = join(root, "docs/contracts/dependency-admissions.json");
      const admissions = admissionFixture();
      delete admissions.packages["alpha@1.2.3"];
      writeCanonicalJson(path, admissions);
      expectCode(() => checkSupplyChain({ root }), "SUPPLY_CHAIN_ADMISSION_CLOSURE");
    });

    withProjectFixture(({ root }) => {
      const path = join(root, "docs/generated/supply-chain/sbom.spdx.json");
      const document = JSON.parse(readFileSync(path, "utf8"));
      document.packages.find((package_) => package_.name === "alpha").licenseDeclared = "ISC";
      writeCanonicalJson(path, document);
      expectCode(() => checkSupplyChain({ root }), "SPDX_GRAPH_MISMATCH");
    });
  });
});

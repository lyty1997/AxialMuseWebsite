import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { NpmIsolationError } from "../../scripts/quality/lib/supply-chain/errors.mjs";
import {
  createSupplyChainInputReceipt,
  SUPPLY_CHAIN_INPUT_PATHS,
} from "../../scripts/quality/lib/supply-chain/input-receipt.mjs";
import {
  validateDependencyLicenseEvidenceObject,
  validatePackageLicenseEvidence,
} from "../../scripts/quality/lib/supply-chain/license-evidence.mjs";
import { packageEvidenceSha256FromTarballInspection } from "../../scripts/quality/lib/supply-chain/notices.mjs";
import { EXPECTED_DEPENDENCY_POLICY } from "../../scripts/quality/lib/supply-chain/policy.mjs";
import {
  createSupplyChainReviewReport,
  renderSupplyChainReviewReport,
  SUPPLY_CHAIN_REVIEW_REPORT_ENVELOPE,
} from "../../scripts/quality/lib/supply-chain/review-report.mjs";
import { canonicalJsonBytes } from "../../scripts/quality/lib/supply-chain/spdx.mjs";
import {
  emptyDependencyLicenseEvidence,
  ownerExceptionRecord,
} from "./supply-chain-license-evidence-fixture.mjs";

function clone(value) {
  return structuredClone(value);
}

function expectCode(action, code) {
  assert.throws(action, (error) => error instanceof NpmIsolationError && error.code === code);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  )));
}

function scriptsSha256(scripts) {
  return sha256Bytes(`${JSON.stringify(sortedObject(scripts), null, 2)}\n`);
}

function identityParts(identity) {
  const separator = identity.lastIndexOf("@");
  return {
    name: identity.slice(0, separator),
    version: identity.slice(separator + 1),
  };
}

function lockedPackage(identity, { hasInstallScript = false, digestByte = 0x11 } = {}) {
  const { name, version } = identityParts(identity);
  const tarName = name.includes("/") ? name.split("/")[1] : name;
  return {
    hasInstallScript,
    identity,
    integrity: `sha512-${Buffer.alloc(64, digestByte).toString("base64")}`,
    name,
    paths: [`node_modules/${name}`],
    resolved: `https://registry.npmjs.org/${name}/-/${tarName}-${version}.tgz`,
    version,
  };
}

function legalFile(path, text) {
  const bytes = Buffer.from(text, "utf8");
  return {
    path,
    rawSha256: sha256Bytes(bytes),
    size: bytes.length,
    text,
  };
}

function upstreamEvidenceRecord(locked, text) {
  return {
    decisionId: "D-082",
    evidenceType: "upstream-immutable",
    integrity: locked.integrity,
    limitations: "Synthetic immutable upstream legal evidence fixture.",
    licenseConcluded: "MIT",
    licenseDeclared: "MIT",
    resolved: locked.resolved,
    source: {
      path: "LICENSE",
      rawSha256: sha256Bytes(text),
      repository: "https://github.com/example/example",
      revision: "a".repeat(40),
      text,
    },
  };
}

function upstreamSupplementFile(record, { includeSize = true } = {}) {
  const file = {
    path: `supplement/upstream/example/example/${record.source.revision}/LICENSE`,
    rawSha256: record.source.rawSha256,
    text: record.source.text,
  };
  if (includeSize) file.size = Buffer.byteLength(file.text, "utf8");
  return file;
}

function tarballEvidenceRecord(locked, text) {
  const size = Buffer.byteLength(text, "utf8");
  return {
    decisionId: "D-082",
    evidenceType: "tarball-reviewed-section",
    integrity: locked.integrity,
    limitations: "Synthetic reviewed tarball section fixture.",
    licenseConcluded: "MIT",
    licenseDeclared: "MIT",
    resolved: locked.resolved,
    source: {
      endByte: size,
      fileRawSha256: "b".repeat(64),
      path: "package/README.md",
      sectionRawSha256: sha256Bytes(text),
      startByte: 0,
      text,
    },
  };
}

function tarballSupplementFile(record, { includeSize = true } = {}) {
  const file = {
    path: `supplement/tarball/README.md#bytes-0-${record.source.endByte}`,
    rawSha256: record.source.sectionRawSha256,
    text: record.source.text,
  };
  if (includeSize) file.size = Buffer.byteLength(file.text, "utf8");
  return file;
}

function inspectionFor(locked, overrides = {}) {
  const scripts = sortedObject(overrides.scripts ?? {});
  const implicitNodeGyp = overrides.implicitNodeGyp ?? false;
  const effectiveInstallScripts = {};
  for (const name of ["preinstall", "install", "postinstall"]) {
    if (scripts[name]) effectiveInstallScripts[name] = scripts[name];
  }
  if (implicitNodeGyp) effectiveInstallScripts.install = "node-gyp rebuild";
  const integritySha512 = Buffer.from(
    locked.integrity.slice("sha512-".length),
    "base64",
  ).toString("hex");
  const inspection = {
    actualHasInstallScript: Object.keys(effectiveInstallScripts).length > 0,
    bindingGyp: overrides.bindingGyp ?? implicitNodeGyp,
    description: Object.hasOwn(overrides, "description")
      ? overrides.description
      : `Synthetic review fixture for ${locked.identity}.`,
    effectiveInstallScripts: sortedObject(effectiveInstallScripts),
    entryCount: 3,
    gypfile: overrides.gypfile ?? null,
    homepage: overrides.homepage ?? `https://example.test/${encodeURIComponent(locked.identity)}`,
    identity: locked.identity,
    implicitNodeGyp,
    integrity: locked.integrity,
    integritySha512,
    licenseDeclared: overrides.licenseDeclared ?? "MIT",
    licenseFiles: [legalFile("package/LICENSE", overrides.licenseText ?? "Synthetic license text.\n")],
    noticeFiles: overrides.noticeFiles ?? [legalFile("package/NOTICE", "Synthetic notice text.\n")],
    packageJsonSha256: sha256Bytes(`package.json:${locked.identity}`),
    scripts,
    scriptsSha256: scriptsSha256(scripts),
  };
  return Object.assign(inspection, clone(overrides.inspection ?? {}));
}

function reviewInput(packages) {
  return {
    inspections: packages.map(({ inspection }) => inspection),
    licenseEvidence: emptyDependencyLicenseEvidence(),
    lockedPackages: packages.map(({ locked }) => locked),
    policy: clone(EXPECTED_DEPENDENCY_POLICY),
    receipt: createSupplyChainInputReceipt({
      inputs: Object.fromEntries(SUPPLY_CHAIN_INPUT_PATHS.map((path) => [
        path,
        sha256Bytes(`synthetic:${path}`),
      ])),
      runtime: {
        role: "primary",
        nodeVersion: "24.18.0",
        npmVersion: "11.16.0",
      },
    }),
  };
}

function packageFixture(identity, options = {}) {
  const locked = lockedPackage(identity, options);
  return {
    inspection: inspectionFor(locked, options),
    locked,
  };
}

test("D-077 deterministic supply-chain candidate review report", async (suite) => {
  await suite.test("emits a fixed canonical envelope and unsigned UTF-8 identity order", () => {
    const zeta = packageFixture("zeta@1.0.0", { digestByte: 0x22 });
    const alpha = packageFixture("@scope/alpha@2.0.0", {
      digestByte: 0x33,
      licenseDeclared: "Apache-2.0",
    });
    const firstInput = reviewInput([zeta, alpha]);
    firstInput.inspections.reverse();
    const before = clone(firstInput);
    const report = createSupplyChainReviewReport(firstInput);
    const bytes = renderSupplyChainReviewReport(firstInput);

    assert.deepEqual(firstInput, before);
    assert.deepEqual(
      {
        version: report.version,
        kind: report.kind,
        status: report.status,
        owner: report.owner,
      },
      SUPPLY_CHAIN_REVIEW_REPORT_ENVELOPE,
    );
    assert.deepEqual(report.packages.map(({ identity }) => identity), [
      "@scope/alpha@2.0.0",
      "zeta@1.0.0",
    ]);
    assert.deepEqual(report.receipt, firstInput.receipt);
    assert.equal(bytes, canonicalJsonBytes(report));
    assert.ok(bytes.endsWith("\n"));
    assert.deepEqual(JSON.parse(bytes), report);

    const reorderedInput = reviewInput([alpha, zeta]);
    reorderedInput.inspections.reverse();
    assert.equal(renderSupplyChainReviewReport(reorderedInput), bytes);
  });

  await suite.test("accepts a validated npm registry alias path while retaining canonical identity", () => {
    const alias = packageFixture("@scope/actual@2.3.4");
    alias.locked.paths = ["node_modules/compat-name"];
    const report = createSupplyChainReviewReport(reviewInput([alias]));
    assert.equal(report.packages[0].identity, "@scope/actual@2.3.4");

    const malformedPath = reviewInput([alias]);
    malformedPath.lockedPackages[0].paths = ["node_modules/compat-name/escape"];
    expectCode(
      () => createSupplyChainReviewReport(malformedPath),
      "SUPPLY_CHAIN_REVIEW_INPUT",
    );
  });

  await suite.test("binds the sole NOTICE evidence digest and changes it for evidence mutation", () => {
    const fixture = packageFixture("alpha@1.2.3");
    const input = reviewInput([fixture]);
    const report = createSupplyChainReviewReport(input);
    assert.equal(
      report.packages[0].evidenceSha256,
      packageEvidenceSha256FromTarballInspection({
        inspection: fixture.inspection,
        lockedPackage: fixture.locked,
      }),
    );
    assert.deepEqual(report.packages[0].licenseFiles, [{
      path: fixture.inspection.licenseFiles[0].path,
      rawSha256: fixture.inspection.licenseFiles[0].rawSha256,
      text: fixture.inspection.licenseFiles[0].text,
    }]);

    const changed = clone(input);
    changed.inspections[0].homepage = "https://example.test/changed";
    const changedReport = createSupplyChainReviewReport(changed);
    assert.notEqual(changedReport.packages[0].evidenceSha256, report.packages[0].evidenceSha256);
    assert.equal(input.inspections[0].homepage, fixture.inspection.homepage);
  });

  await suite.test("allows empty licenseFiles only for an exact D-082 owner exception", () => {
    const ownerException = packageFixture("boolbase@1.0.0");
    ownerException.inspection.licenseFiles = [];
    const accepted = reviewInput([ownerException]);
    accepted.licenseEvidence.legalEvidence[ownerException.locked.identity] = ownerExceptionRecord(
      ownerException.locked,
    );
    const report = createSupplyChainReviewReport(accepted);
    assert.deepEqual(report.packages[0].licenseFiles, []);
    assert.deepEqual(report.packages[0].licensePolicy, {
      classification: "review-required",
      code: null,
    });

    const unadmitted = packageFixture("arbitrary-package@1.0.0");
    unadmitted.inspection.licenseFiles = [];
    expectCode(
      () => createSupplyChainReviewReport(reviewInput([unadmitted])),
      "SUPPLY_CHAIN_LICENSE_EVIDENCE_CLOSURE",
    );
  });

  await suite.test("closes supplemental evidence across inspection and persisted file projections", () => {
    const fixture = packageFixture("alpha@1.2.3");
    const record = upstreamEvidenceRecord(fixture.locked, "Synthetic upstream MIT text.\n");
    fixture.inspection.licenseFiles = [upstreamSupplementFile(record)];
    const input = reviewInput([fixture]);
    input.licenseEvidence.legalEvidence[fixture.locked.identity] = record;
    const report = createSupplyChainReviewReport(input);
    const package_ = {
      identity: fixture.locked.identity,
      integrity: fixture.locked.integrity,
      licenseDeclared: fixture.inspection.licenseDeclared,
      resolved: fixture.locked.resolved,
    };

    assert.deepEqual(report.packages[0].licenseFiles, [
      upstreamSupplementFile(record, { includeSize: false }),
    ]);
    assert.equal(validatePackageLicenseEvidence({
      evidence: input.licenseEvidence,
      licenseFiles: report.packages[0].licenseFiles,
      package_,
    }), record);

    const wrongSize = upstreamSupplementFile(record);
    wrongSize.size += 1;
    const invalidFiles = [
      wrongSize,
      {
        ...upstreamSupplementFile(record, { includeSize: false }),
        unexpected: true,
      },
      {
        ...upstreamSupplementFile(record, { includeSize: false }),
        path: "supplement/upstream/example/example/wrong/LICENSE",
      },
      {
        ...upstreamSupplementFile(record, { includeSize: false }),
        rawSha256: "f".repeat(64),
      },
      {
        ...upstreamSupplementFile(record, { includeSize: false }),
        text: `${record.source.text}changed\n`,
      },
    ];
    for (const file of invalidFiles) expectCode(
      () => validatePackageLicenseEvidence({
        evidence: input.licenseEvidence,
        licenseFiles: [file],
        package_,
      }),
      "SUPPLY_CHAIN_LICENSE_EVIDENCE_CLOSURE",
    );
  });

  await suite.test("closes reviewed tarball sections in live and persisted projections", () => {
    const fixture = packageFixture("alpha@1.2.3");
    const record = tarballEvidenceRecord(fixture.locked, "Synthetic tarball MIT section.\n");
    const persistedFile = tarballSupplementFile(record, { includeSize: false });
    const package_ = {
      identity: fixture.locked.identity,
      integrity: fixture.locked.integrity,
      licenseDeclared: fixture.inspection.licenseDeclared,
      resolved: fixture.locked.resolved,
    };
    const evidence = emptyDependencyLicenseEvidence();
    evidence.legalEvidence[fixture.locked.identity] = record;

    assert.equal(validatePackageLicenseEvidence({
      evidence,
      licenseFiles: [tarballSupplementFile(record)],
      package_,
    }), record);
    assert.equal(validatePackageLicenseEvidence({
      evidence,
      licenseFiles: [persistedFile],
      package_,
    }), record);
  });

  await suite.test("does not generalize the 12 D-082 owner exceptions by license or risk text", () => {
    const arbitrary = packageFixture("arbitrary-package@1.0.0");
    const evidence = emptyDependencyLicenseEvidence();
    evidence.legalEvidence[arbitrary.locked.identity] = ownerExceptionRecord(arbitrary.locked);
    expectCode(
      () => validateDependencyLicenseEvidenceObject(evidence),
      "SUPPLY_CHAIN_LICENSE_EVIDENCE_OWNER",
    );
  });

  await suite.test("preserves effective install and implicit node-gyp evidence", () => {
    const scripted = packageFixture("scripted@1.0.0", {
      hasInstallScript: true,
      scripts: {
        postinstall: "node postinstall.js",
        preinstall: "node preinstall.js",
        prepare: "node prepare.js",
      },
    });
    const implicit = packageFixture("native@2.0.0", {
      bindingGyp: true,
      hasInstallScript: true,
      implicitNodeGyp: true,
      scripts: { prepare: "node prepare.js" },
    });
    const report = createSupplyChainReviewReport(reviewInput([scripted, implicit]));
    const byIdentity = new Map(report.packages.map((package_) => [package_.identity, package_]));

    assert.deepEqual(byIdentity.get("scripted@1.0.0").effectiveInstallScripts, {
      postinstall: "node postinstall.js",
      preinstall: "node preinstall.js",
    });
    assert.deepEqual(byIdentity.get("native@2.0.0").effectiveInstallScripts, {
      install: "node-gyp rebuild",
    });
    assert.equal(byIdentity.get("native@2.0.0").bindingGyp, true);
    assert.equal(byIdentity.get("native@2.0.0").gypfile, null);
    assert.equal(byIdentity.get("native@2.0.0").implicitNodeGyp, true);
  });

  await suite.test("preserves empty description and accepts only conservative lock script overstatement", () => {
    const empty = packageFixture("alpha@1.2.3", {
      description: "",
      hasInstallScript: true,
    });
    const absent = packageFixture("alpha@1.2.3", {
      description: null,
      hasInstallScript: true,
    });
    const edgeWhitespace = "  Synthetic review description.  ";
    const edgeSpaced = packageFixture("alpha@1.2.3", {
      description: edgeWhitespace,
      hasInstallScript: true,
    });
    const emptyReport = createSupplyChainReviewReport(reviewInput([empty]));
    const absentReport = createSupplyChainReviewReport(reviewInput([absent]));
    const edgeReport = createSupplyChainReviewReport(reviewInput([edgeSpaced]));
    assert.equal(emptyReport.packages[0].description, "");
    assert.equal(absentReport.packages[0].description, null);
    assert.equal(edgeReport.packages[0].description, edgeWhitespace);
    assert.deepEqual(emptyReport.packages[0].effectiveInstallScripts, {});
    assert.notEqual(
      emptyReport.packages[0].evidenceSha256,
      absentReport.packages[0].evidenceSha256,
    );

    const unmarked = reviewInput([packageFixture("scripted-unmarked@1.0.0", {
      scripts: { install: "node install.js" },
    })]);
    expectCode(
      () => createSupplyChainReviewReport(unmarked),
      "SUPPLY_CHAIN_REVIEW_DRIFT",
    );
  });

  await suite.test("records stable blocked license codes without losing the candidate graph", () => {
    const fixtures = [
      packageFixture("preferred@1.0.0", { licenseDeclared: "MIT" }),
      packageFixture("review@1.0.0", { licenseDeclared: "MPL-2.0" }),
      packageFixture("denied@1.0.0", { licenseDeclared: "GPL-3.0-only" }),
      packageFixture("compound@1.0.0", { licenseDeclared: "MIT OR Apache-2.0" }),
      packageFixture("custom@1.0.0", { licenseDeclared: "LicenseRef-Synthetic" }),
      packageFixture("unknown@1.0.0", { licenseDeclared: "Unlicense" }),
    ];
    const report = createSupplyChainReviewReport(reviewInput(fixtures));
    const classifications = Object.fromEntries(report.packages.map((package_) => [
      package_.identity,
      package_.licensePolicy,
    ]));

    assert.deepEqual(classifications, {
      "compound@1.0.0": {
        classification: "blocked",
        code: "SUPPLY_CHAIN_LICENSE_COMPOUND",
      },
      "custom@1.0.0": {
        classification: "blocked",
        code: "SUPPLY_CHAIN_LICENSE_CUSTOM",
      },
      "denied@1.0.0": {
        classification: "blocked",
        code: "SUPPLY_CHAIN_LICENSE_DENIED",
      },
      "preferred@1.0.0": { classification: "preferred", code: null },
      "review@1.0.0": { classification: "review-required", code: null },
      "unknown@1.0.0": {
        classification: "blocked",
        code: "SUPPLY_CHAIN_LICENSE_UNKNOWN",
      },
    });
    assert.equal(report.packages.length, fixtures.length);
  });

  await suite.test("fails closed on duplicate, missing, unknown and drifted inputs", () => {
    const alpha = packageFixture("alpha@1.2.3");
    const beta = packageFixture("beta@2.0.0", { digestByte: 0x44 });
    const base = reviewInput([alpha, beta]);

    const duplicateLock = clone(base);
    duplicateLock.lockedPackages.push(clone(duplicateLock.lockedPackages[0]));
    expectCode(
      () => createSupplyChainReviewReport(duplicateLock),
      "SUPPLY_CHAIN_REVIEW_DUPLICATE",
    );
    const duplicateInspection = clone(base);
    duplicateInspection.inspections.push(clone(duplicateInspection.inspections[0]));
    expectCode(
      () => createSupplyChainReviewReport(duplicateInspection),
      "SUPPLY_CHAIN_REVIEW_DUPLICATE",
    );
    const missing = clone(base);
    missing.inspections.pop();
    expectCode(() => createSupplyChainReviewReport(missing), "SUPPLY_CHAIN_REVIEW_CLOSURE");
    const unknown = clone(base);
    unknown.inspections[1] = packageFixture("unknown@9.0.0").inspection;
    expectCode(() => createSupplyChainReviewReport(unknown), "SUPPLY_CHAIN_REVIEW_CLOSURE");

    const driftedIntegrity = clone(base);
    driftedIntegrity.inspections[0].integrity = beta.locked.integrity;
    expectCode(
      () => createSupplyChainReviewReport(driftedIntegrity),
      "SUPPLY_CHAIN_REVIEW_DRIFT",
    );
    const driftedScript = clone(base);
    driftedScript.inspections[0].scripts.prepare = "node changed.js";
    expectCode(
      () => createSupplyChainReviewReport(driftedScript),
      "SUPPLY_CHAIN_REVIEW_DRIFT",
    );
    const unknownField = clone(base);
    unknownField.inspections[0].unexpected = true;
    expectCode(() => createSupplyChainReviewReport(unknownField), "SUPPLY_CHAIN_REVIEW_INPUT");
    expectCode(
      () => createSupplyChainReviewReport({ ...base, unexpected: true }),
      "SUPPLY_CHAIN_REVIEW_INPUT",
    );
    const missingReceipt = clone(base);
    delete missingReceipt.receipt;
    expectCode(
      () => createSupplyChainReviewReport(missingReceipt),
      "SUPPLY_CHAIN_REVIEW_INPUT",
    );
    const unknownReceiptField = clone(base);
    unknownReceiptField.receipt.runtime.channel = "lts";
    expectCode(
      () => createSupplyChainReviewReport(unknownReceiptField),
      "SUPPLY_CHAIN_REVIEW_INPUT",
    );
    const uppercaseReceiptHash = clone(base);
    uppercaseReceiptHash.receipt.inputs["package-lock.json"] = (
      uppercaseReceiptHash.receipt.inputs["package-lock.json"].toUpperCase()
    );
    expectCode(
      () => createSupplyChainReviewReport(uppercaseReceiptHash),
      "SUPPLY_CHAIN_REVIEW_INPUT",
    );
  });

  await suite.test("rejects an oversized report while packages are still being collected", () => {
    const text = "x".repeat(2 * 1024 * 1024);
    const rawSha256 = sha256Bytes(text);
    const largeLicenseFiles = Array.from({ length: 8 }, (_, index) => ({
      path: `package/LICENSE-${String(index).padStart(2, "0")}`,
      rawSha256,
      size: Buffer.byteLength(text, "utf8"),
      text,
    }));
    const fixtures = Array.from({ length: 4 }, (_, index) => {
      const fixture = packageFixture(`large-${String(index).padStart(2, "0")}@1.0.0`);
      fixture.inspection.licenseFiles = largeLicenseFiles;
      fixture.inspection.noticeFiles = [];
      return fixture;
    });
    const sentinel = packageFixture("zz-sentinel@1.0.0");
    let sentinelValidated = false;
    Object.defineProperty(sentinel.inspection, "entryCount", {
      configurable: true,
      enumerable: true,
      get() {
        sentinelValidated = true;
        return 3;
      },
    });

    expectCode(
      () => createSupplyChainReviewReport(reviewInput([...fixtures, sentinel])),
      "SUPPLY_CHAIN_REVIEW_LIMIT",
    );
    assert.equal(sentinelValidated, false);
  });

  await suite.test("propagates non-license policy errors", () => {
    const input = reviewInput([packageFixture("alpha@1.2.3")]);
    input.policy.reports.retentionDays = 31;
    expectCode(() => createSupplyChainReviewReport(input), "SUPPLY_CHAIN_POLICY_DRIFT");
  });
});

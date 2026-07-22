import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  buildAuditAggregate,
  writeRestrictedAuditReport,
} from "../../scripts/quality/lib/supply-chain/audit-report.mjs";
import { parseNpmAuditResult } from "../../scripts/quality/lib/supply-chain/audit.mjs";
import { PROJECT_NPM_CONFIG } from "../../scripts/quality/lib/supply-chain/contracts.mjs";
import { deriveNpmCli } from "../../scripts/quality/lib/supply-chain/environment.mjs";
import { NpmIsolationError } from "../../scripts/quality/lib/supply-chain/errors.mjs";
import {
  assertSupplyChainInputReceiptCurrent,
  captureCurrentSupplyChainInputReceipt,
  createSupplyChainInputReceipt,
  parseSupplyChainInputReceipt,
  readAndVerifyRestrictedSupplyChainInputReceipt,
  supplyChainInputReceiptBytes,
  supplyChainInputReceiptSha256,
  SUPPLY_CHAIN_INPUT_PATHS,
} from "../../scripts/quality/lib/supply-chain/input-receipt.mjs";
import { EXPECTED_DEPENDENCY_POLICY } from "../../scripts/quality/lib/supply-chain/policy.mjs";
import { canonicalJsonBytes } from "../../scripts/quality/lib/supply-chain/spdx.mjs";
import {
  parseSupplyChainAuditArguments,
  runSupplyChainAudit,
} from "../../scripts/quality/run-supply-chain-audit.mjs";
import { emptyDependencyLicenseEvidence } from "./supply-chain-license-evidence-fixture.mjs";

const SEVERITIES = Object.freeze(["info", "low", "moderate", "high", "critical"]);
const TEST_RECEIPT = createSupplyChainInputReceipt({
  inputs: Object.fromEntries(SUPPLY_CHAIN_INPUT_PATHS.map((path) => [
    path,
    createHash("sha256").update(`synthetic:${path}`).digest("hex"),
  ])),
  runtime: {
    role: "primary",
    nodeVersion: "24.18.0",
    npmVersion: "11.16.0",
  },
});

function vulnerability(name, severity) {
  return {
    name,
    severity,
    isDirect: true,
    via: [{
      source: 1001,
      name,
      dependency: name,
      title: `Synthetic ${severity} advisory for ${name}`,
      url: "https://github.com/advisories/GHSA-synthetic-1001",
      severity,
      range: "<2.0.0",
    }],
    effects: [],
    range: "<2.0.0",
    nodes: [`node_modules/${name}`],
    fixAvailable: false,
  };
}

function auditReport(vulnerabilities = {}) {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const value of Object.values(vulnerabilities)) counts[value.severity] += 1;
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: {
        ...counts,
        total: Object.keys(vulnerabilities).length,
      },
      dependencies: {
        prod: 1,
        dev: 1,
        optional: 0,
        peer: 0,
        peerOptional: 0,
        total: 2,
      },
    },
  };
}

function parsedCase(severity = null) {
  const vulnerabilities = severity === null
    ? {}
    : { [`${severity}-package`]: vulnerability(`${severity}-package`, severity) };
  const stdout = `${JSON.stringify(auditReport(vulnerabilities))}\n`;
  const status = severity === "moderate" ? 1 : 0;
  const audit = parseNpmAuditResult({
    result: { status, signal: null, stdout, stderr: "raw audit stderr must stay private\n" },
    policy: structuredClone(EXPECTED_DEPENDENCY_POLICY),
  });
  return { audit, stdout };
}

function captureError() {
  let text = "";
  return {
    stream: { write: (chunk) => { text += chunk; } },
    text: () => text,
  };
}

function runAudit(options = {}) {
  return runSupplyChainAudit({
    captureReceipt: () => structuredClone(TEST_RECEIPT),
    assertReceiptCurrent: ({ receipt }) => {
      assert.deepEqual(receipt, TEST_RECEIPT);
      return receipt;
    },
    ...options,
  });
}

function writeAuditReport(input, options) {
  return writeRestrictedAuditReport({
    ...input,
    receipt: structuredClone(TEST_RECEIPT),
  }, options);
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createReceiptProject() {
  const outer = mkdtempSync("/tmp/axial-muse-receipt-reader-test-");
  const root = join(outer, "project");
  mkdirSync(join(root, "docs", "contracts"), { recursive: true, mode: 0o700 });
  const manifest = {
    name: "receipt-reader-fixture",
    version: "1.0.0",
    private: true,
    type: "module",
    engines: {
      node: `>=${process.versions.node} <${Number(process.versions.node.split(".")[0]) + 1}`,
    },
  };
  writeJson(join(root, "package.json"), manifest);
  writeJson(join(root, "package-lock.json"), {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages: {
      "": {
        name: manifest.name,
        version: manifest.version,
      },
    },
  });
  writeFileSync(
    join(root, ".npmrc"),
    `${Object.entries(PROJECT_NPM_CONFIG)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    "utf8",
  );
  writeFileSync(join(root, ".nvmrc"), `${process.versions.node}\n`, "utf8");
  writeFileSync(
    join(root, "docs", "contracts", "dependency-policy.json"),
    canonicalJsonBytes(EXPECTED_DEPENDENCY_POLICY),
    "utf8",
  );
  writeFileSync(
    join(root, "docs", "contracts", "dependency-license-evidence.json"),
    canonicalJsonBytes(emptyDependencyLicenseEvidence()),
    "utf8",
  );
  const npmVersionsByRole = {
    minimum: "0.0.0",
    primary: deriveNpmCli(process.execPath).npmVersion,
  };
  return { npmVersionsByRole, outer, root };
}

function artifactFromLog(log) {
  const [line] = log.trim().split("\n");
  return JSON.parse(line);
}

function fakeIsolatedRun({ audit, stdout, blocked = false }) {
  return ({ onAuditResult, profile, scriptName }) => {
    assert.equal(profile, "audit");
    assert.equal(scriptName, null);
    onAuditResult({ audit: structuredClone(audit), stdout });
    if (blocked) {
      throw new NpmIsolationError(
        "SUPPLY_CHAIN_AUDIT_BLOCKED",
        "npm audit 发现 1 个 moderate/high/critical 漏洞。",
      );
    }
    return { profile: "audit", audit };
  };
}

function findNestedFiles(root, name) {
  const matches = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) matches.push(...findNestedFiles(path, name));
    else if (entry.isFile() && entry.name === name) matches.push(path);
  }
  return matches;
}

test("D-077 restricted npm audit artifact", async (suite) => {
  await suite.test("retains clean, low and blocked raw reports with private permissions", () => {
    const outer = mkdtempSync("/tmp/axial-muse-audit-report-test-");
    try {
      for (const severity of [null, "low", "moderate"]) {
        const fixture = parsedCase(severity);
        const logged = captureError();
        const exitCode = runAudit({
          root: "/synthetic/project",
          temporaryParent: outer,
          runIsolated: fakeIsolatedRun({
            ...fixture,
            blocked: severity === "moderate",
          }),
          standardError: logged.stream,
        });
        assert.equal(exitCode, severity === "moderate" ? 1 : 0);
        const summary = artifactFromLog(logged.text());
        assert.deepEqual(summary.aggregate, buildAuditAggregate(fixture.audit));
        assert.equal(readFileSync(summary.artifactPath, "utf8"), fixture.stdout);
        assert.equal(
          readFileSync(summary.receiptPath, "utf8"),
          supplyChainInputReceiptBytes(TEST_RECEIPT),
        );
        assert.equal(summary.receiptSha256, supplyChainInputReceiptSha256(TEST_RECEIPT));
        assert.equal(lstatSync(dirname(summary.artifactPath)).mode & 0o777, 0o700);
        assert.equal(lstatSync(summary.artifactPath).mode & 0o777, 0o600);
        assert.equal(lstatSync(summary.receiptPath).mode & 0o777, 0o600);
        assert.deepEqual(readdirSync(dirname(summary.artifactPath)).sort(), [
          "raw-audit.json",
          "receipt.json",
        ]);
        assert.ok(!logged.text().includes(`${severity}-package`));
        assert.ok(!logged.text().includes("Synthetic"));
        assert.ok(!logged.text().includes("raw audit stderr"));
      }
      assert.equal(readdirSync(outer).length, 3);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  await suite.test("reads a canonical restricted receipt and rejects current-graph drift", () => {
    const project = createReceiptProject();
    try {
      const fixture = parsedCase();
      const receipt = captureCurrentSupplyChainInputReceipt({
        npmVersionsByRole: project.npmVersionsByRole,
        root: project.root,
      });
      const artifact = writeRestrictedAuditReport({
        audit: fixture.audit,
        receipt,
        stdout: fixture.stdout,
        temporaryParent: project.outer,
      });
      const verified = readAndVerifyRestrictedSupplyChainInputReceipt({
        npmVersionsByRole: project.npmVersionsByRole,
        path: artifact.receiptPath,
        root: project.root,
      });
      assert.deepEqual(verified.receipt, receipt);
      assert.equal(verified.receiptSha256, artifact.receiptSha256);

      const forgedMinimum = structuredClone(receipt);
      forgedMinimum.runtime.role = "minimum";
      assert.throws(
        () => assertSupplyChainInputReceiptCurrent({
          code: "SUPPLY_CHAIN_RECEIPT_DRIFT",
          npmVersionsByRole: project.npmVersionsByRole,
          receipt: forgedMinimum,
          requiredRole: null,
          root: project.root,
        }),
        (error) => error instanceof NpmIsolationError
          && error.code === "SUPPLY_CHAIN_RECEIPT_DRIFT",
      );

      const forgedVersion = structuredClone(receipt);
      forgedVersion.runtime.npmVersion = "0.0.0";
      assert.throws(
        () => assertSupplyChainInputReceiptCurrent({
          code: "SUPPLY_CHAIN_RECEIPT_DRIFT",
          npmVersionsByRole: {
            ...project.npmVersionsByRole,
            primary: "0.0.0",
          },
          receipt: forgedVersion,
          requiredRole: "primary",
          root: project.root,
        }),
        (error) => error instanceof NpmIsolationError
          && error.code === "SUPPLY_CHAIN_RECEIPT_DRIFT",
      );

      const oversizedDirectory = join(project.outer, "oversized-receipt");
      const oversizedPath = join(oversizedDirectory, "receipt.json");
      mkdirSync(oversizedDirectory, { mode: 0o700 });
      writeFileSync(oversizedPath, "x".repeat(32 * 1024 + 1), { mode: 0o600 });
      assert.throws(
        () => readAndVerifyRestrictedSupplyChainInputReceipt({
          npmVersionsByRole: project.npmVersionsByRole,
          path: oversizedPath,
          root: project.root,
        }),
        (error) => error instanceof NpmIsolationError
          && error.code === "SUPPLY_CHAIN_RECEIPT_FILE",
      );

      const lockPath = join(project.root, "package-lock.json");
      writeFileSync(lockPath, `${readFileSync(lockPath, "utf8")} `, "utf8");
      assert.throws(
        () => readAndVerifyRestrictedSupplyChainInputReceipt({
          npmVersionsByRole: project.npmVersionsByRole,
          path: artifact.receiptPath,
          root: project.root,
        }),
        (error) => error instanceof NpmIsolationError
          && error.code === "SUPPLY_CHAIN_RECEIPT_DRIFT",
      );
    } finally {
      rmSync(project.outer, { recursive: true, force: true });
    }
  });

  await suite.test("rejects missing, unknown, duplicate and non-canonical receipt fields", () => {
    const missing = structuredClone(TEST_RECEIPT);
    delete missing.runtime.npmVersion;
    const unknown = structuredClone(TEST_RECEIPT);
    unknown.inputs["npm-shrinkwrap.json"] = "0".repeat(64);
    const uppercase = structuredClone(TEST_RECEIPT);
    uppercase.inputs["package.json"] = uppercase.inputs["package.json"].toUpperCase();
    for (const receipt of [missing, unknown, uppercase]) {
      assert.throws(
        () => parseSupplyChainInputReceipt(canonicalJsonBytes(receipt)),
        (error) => error instanceof NpmIsolationError
          && error.code === "SUPPLY_CHAIN_RECEIPT_SCHEMA",
      );
    }
    const canonical = supplyChainInputReceiptBytes(TEST_RECEIPT);
    const duplicate = canonical.replace(
      '  "owner": "AxialMuseWebsite",',
      '  "owner": "shadow",\n  "owner": "AxialMuseWebsite",',
    );
    assert.throws(
      () => parseSupplyChainInputReceipt(duplicate),
      (error) => error instanceof NpmIsolationError
        && error.code === "SUPPLY_CHAIN_RECEIPT_BYTES",
    );
    assert.throws(
      () => parseSupplyChainInputReceipt(JSON.stringify(TEST_RECEIPT)),
      (error) => error instanceof NpmIsolationError
        && error.code === "SUPPLY_CHAIN_RECEIPT_BYTES",
    );
  });

  await suite.test("rechecks the receipt after the trusted audit callback", () => {
    const outer = mkdtempSync("/tmp/axial-muse-audit-receipt-drift-test-");
    const fixture = parsedCase("low");
    const logged = captureError();
    let checks = 0;
    try {
      const exitCode = runAudit({
        assertReceiptCurrent: ({ receipt }) => {
          assert.deepEqual(receipt, TEST_RECEIPT);
          checks += 1;
          if (checks >= 3) {
            throw new NpmIsolationError(
              "SUPPLY_CHAIN_AUDIT_INPUT_DRIFT",
              "synthetic fixed input drift",
            );
          }
          return receipt;
        },
        root: "/synthetic/project",
        runIsolated: fakeIsolatedRun(fixture),
        standardError: logged.stream,
        temporaryParent: outer,
      });
      assert.equal(exitCode, 1);
      assert.ok(checks >= 3);
      assert.ok(logged.text().includes("[SUPPLY_CHAIN_AUDIT_INPUT_DRIFT]"));
      const summary = artifactFromLog(logged.text());
      assert.equal(summary.receiptSha256, supplyChainInputReceiptSha256(TEST_RECEIPT));
      assert.equal(readFileSync(summary.receiptPath, "utf8"), supplyChainInputReceiptBytes(TEST_RECEIPT));
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  await suite.test("does not invent reports for parse, network or input-drift failures", () => {
    const outer = mkdtempSync("/tmp/axial-muse-audit-no-report-test-");
    try {
      const invalidJson = ({ onAuditResult }) => {
        const audit = parseNpmAuditResult({
          result: { status: 1, signal: null, stdout: "not-json\n", stderr: "private\n" },
          policy: structuredClone(EXPECTED_DEPENDENCY_POLICY),
        });
        onAuditResult({ audit, stdout: "not-json\n" });
      };
      for (const [runIsolated, expectedCode] of [
        [invalidJson, "SUPPLY_CHAIN_AUDIT_JSON"],
        [() => {
          throw new NpmIsolationError(
            "NPM_WORKLOAD_FAILED",
            "network failed for private-package advisory raw stderr",
          );
        }, "NPM_WORKLOAD_FAILED"],
        [() => { throw new NpmIsolationError("NPM_INPUT_DRIFT", "input changed"); }, "NPM_INPUT_DRIFT"],
      ]) {
        let writes = 0;
        const logged = captureError();
        const exitCode = runAudit({
          root: "/synthetic/project",
          temporaryParent: outer,
          runIsolated,
          writeReport: () => { writes += 1; },
          standardError: logged.stream,
        });
        assert.equal(exitCode, 1);
        assert.equal(writes, 0);
        assert.ok(logged.text().includes(`[${expectedCode}]`));
        assert.ok(!logged.text().includes("artifactPath"));
        assert.ok(!logged.text().includes("private-package"));
        assert.ok(!logged.text().includes("raw stderr"));
      }
      assert.deepEqual(readdirSync(outer), []);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  await suite.test("fails closed when the trusted callback cannot write", () => {
    const fixture = parsedCase("low");
    const logged = captureError();
    let continued = false;
    const exitCode = runAudit({
      root: "/synthetic/project",
      runIsolated: ({ onAuditResult }) => {
        onAuditResult({ audit: fixture.audit, stdout: fixture.stdout });
        continued = true;
      },
      writeReport: () => {
        throw new NpmIsolationError(
          "SUPPLY_CHAIN_AUDIT_REPORT_WRITE",
          "synthetic private-package advisory write failure",
        );
      },
      standardError: logged.stream,
    });
    assert.equal(exitCode, 1);
    assert.equal(continued, false);
    assert.ok(logged.text().includes("[SUPPLY_CHAIN_AUDIT_REPORT_WRITE]"));
    assert.ok(!logged.text().includes("artifactPath"));
    assert.ok(!logged.text().includes("low-package"));
    assert.ok(!logged.text().includes("private-package"));
  });

  await suite.test("rejects a writer result with a missing receipt artifact", () => {
    const fixture = parsedCase("low");
    const logged = captureError();
    let continued = false;
    const exitCode = runAudit({
      root: "/synthetic/project",
      runIsolated: ({ onAuditResult }) => {
        onAuditResult({ audit: fixture.audit, stdout: fixture.stdout });
        continued = true;
      },
      standardError: logged.stream,
      writeReport: () => ({
        aggregate: buildAuditAggregate(fixture.audit),
        directory: "/tmp/synthetic",
        path: "/tmp/synthetic/raw-audit.json",
        rawSha256: "0".repeat(64),
      }),
    });
    assert.equal(exitCode, 1);
    assert.equal(continued, false);
    assert.ok(logged.text().includes("[SUPPLY_CHAIN_AUDIT_ARTIFACT_SCHEMA]"));
    assert.ok(!logged.text().includes("artifactPath"));
    assert.ok(!logged.text().includes("low-package"));
  });

  await suite.test("rejects arguments before invoking npm or creating an artifact", () => {
    assert.throws(
      () => parseSupplyChainAuditArguments(["--output", "/tmp/report.json"]),
      (error) => error instanceof NpmIsolationError
        && error.code === "SUPPLY_CHAIN_AUDIT_ARGUMENTS",
    );
    let invoked = false;
    const logged = captureError();
    assert.equal(runAudit({
      arguments_: ["unexpected"],
      runIsolated: () => { invoked = true; },
      standardError: logged.stream,
    }), 1);
    assert.equal(invoked, false);
    assert.ok(logged.text().includes("[SUPPLY_CHAIN_AUDIT_ARGUMENTS]"));
    assert.ok(!logged.text().includes("artifactPath"));
  });

  await suite.test("validates raw bytes before creating its private directory", () => {
    const outer = mkdtempSync("/tmp/axial-muse-audit-invalid-raw-test-");
    try {
      const fixture = parsedCase();
      assert.throws(
        () => writeAuditReport({
          audit: fixture.audit,
          stdout: "{}\n",
          temporaryParent: outer,
        }),
        (error) => error instanceof NpmIsolationError
          && error.code === "SUPPLY_CHAIN_AUDIT_REPORT_INPUT",
      );
      assert.deepEqual(readdirSync(outer), []);

      const mismatchedDependencyReport = auditReport();
      mismatchedDependencyReport.metadata.dependencies.total = 0;
      assert.throws(
        () => writeAuditReport({
          audit: fixture.audit,
          stdout: `${JSON.stringify(mismatchedDependencyReport)}\n`,
          temporaryParent: outer,
        }),
        (error) => error instanceof NpmIsolationError
          && error.code === "SUPPLY_CHAIN_AUDIT_REPORT_INPUT",
      );
      assert.deepEqual(readdirSync(outer), []);

      assert.throws(
        () => writeAuditReport({
          audit: fixture.audit,
          stdout: fixture.stdout,
          temporaryParent: outer,
        }, {
          syncFile: () => { throw new Error("synthetic fsync failure"); },
        }),
        (error) => error instanceof NpmIsolationError
          && error.code === "SUPPLY_CHAIN_AUDIT_REPORT_WRITE",
      );
      assert.deepEqual(readdirSync(outer), []);

      const syncedDirectories = [];
      assert.throws(
        () => writeAuditReport({
          audit: fixture.audit,
          stdout: fixture.stdout,
          temporaryParent: outer,
        }, {
          syncDirectoryPath: (path) => { syncedDirectories.push(path); },
          syncFile: () => { throw new Error("synthetic durable cleanup failure"); },
        }),
        (error) => error instanceof NpmIsolationError
          && error.code === "SUPPLY_CHAIN_AUDIT_REPORT_WRITE",
      );
      assert.deepEqual(syncedDirectories, [outer, outer]);
      assert.deepEqual(readdirSync(outer), []);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  await suite.test("preserves a failure-window replacement instead of unlinking it", () => {
    const outer = mkdtempSync("/tmp/axial-muse-audit-replacement-test-");
    const fixture = parsedCase();
    let replacementIdentity = null;
    const marker = Buffer.from("EXTERNAL-REPLACEMENT\n", "utf8");
    try {
      assert.throws(
        () => writeAuditReport({
          audit: fixture.audit,
          stdout: fixture.stdout,
          temporaryParent: outer,
        }, {
          syncFile: () => {
            const [directoryName] = readdirSync(outer);
            const reportPath = join(outer, directoryName, "raw-audit.json");
            unlinkSync(reportPath);
            writeFileSync(reportPath, marker, { mode: 0o600 });
            const stat = lstatSync(reportPath);
            replacementIdentity = { dev: stat.dev, ino: stat.ino };
            throw new Error("synthetic write failure after replacement");
          },
        }),
        (error) => error instanceof NpmIsolationError
          && error.code === "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
      );
      const retained = findNestedFiles(outer, "raw-audit.json");
      assert.equal(retained.length, 1);
      const retainedStat = lstatSync(retained[0]);
      assert.deepEqual(
        { dev: retainedStat.dev, ino: retainedStat.ino },
        replacementIdentity,
      );
      assert.deepEqual(readFileSync(retained[0]), marker);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  await suite.test("does not adopt a same-byte report replacement in the success window", () => {
    const outer = mkdtempSync("/tmp/axial-muse-audit-success-replacement-test-");
    const fixture = parsedCase();
    let syncCalls = 0;
    let replacementIdentity = null;
    const expected = Buffer.from(fixture.stdout, "utf8");
    try {
      assert.throws(
        () => writeAuditReport({
          audit: fixture.audit,
          stdout: fixture.stdout,
          temporaryParent: outer,
        }, {
          syncDirectoryPath: () => {
            syncCalls += 1;
            if (syncCalls === 1) {
              const [directoryName] = readdirSync(outer);
              const reportPath = join(outer, directoryName, "raw-audit.json");
              unlinkSync(reportPath);
              writeFileSync(reportPath, expected, { mode: 0o600 });
              const stat = lstatSync(reportPath);
              replacementIdentity = { dev: stat.dev, ino: stat.ino };
            }
          },
        }),
        (error) => error instanceof NpmIsolationError
          && error.code === "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
      );
      const retained = findNestedFiles(outer, "raw-audit.json");
      assert.equal(retained.length, 1);
      const retainedStat = lstatSync(retained[0]);
      assert.deepEqual(
        { dev: retainedStat.dev, ino: retainedStat.ino },
        replacementIdentity,
      );
      assert.deepEqual(readFileSync(retained[0]), expected);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  await suite.test("does not adopt or delete a same-byte receipt replacement", () => {
    const outer = mkdtempSync("/tmp/axial-muse-audit-receipt-replacement-test-");
    const fixture = parsedCase();
    let syncCalls = 0;
    let replacementIdentity = null;
    const expected = Buffer.from(supplyChainInputReceiptBytes(TEST_RECEIPT), "utf8");
    try {
      assert.throws(
        () => writeAuditReport({
          audit: fixture.audit,
          stdout: fixture.stdout,
          temporaryParent: outer,
        }, {
          syncDirectoryPath: () => {
            syncCalls += 1;
            if (syncCalls === 1) {
              const [directoryName] = readdirSync(outer);
              const receiptPath = join(outer, directoryName, "receipt.json");
              unlinkSync(receiptPath);
              writeFileSync(receiptPath, expected, { mode: 0o600 });
              const stat = lstatSync(receiptPath);
              replacementIdentity = { dev: stat.dev, ino: stat.ino };
            }
          },
        }),
        (error) => error instanceof NpmIsolationError
          && error.code === "SUPPLY_CHAIN_AUDIT_REPORT_CLEANUP_UNCERTAIN",
      );
      const retained = findNestedFiles(outer, "receipt.json");
      assert.equal(retained.length, 1);
      const retainedStat = lstatSync(retained[0]);
      assert.deepEqual(
        { dev: retainedStat.dev, ino: retainedStat.ino },
        replacementIdentity,
      );
      assert.deepEqual(readFileSync(retained[0]), expected);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

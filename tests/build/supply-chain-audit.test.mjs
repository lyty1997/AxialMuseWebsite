import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNpmAuditResultAllowed,
  parseNpmAuditReport,
  parseNpmAuditResult,
} from "../../scripts/quality/lib/supply-chain/audit.mjs";
import { NpmIsolationError } from "../../scripts/quality/lib/supply-chain/errors.mjs";
import { EXPECTED_DEPENDENCY_POLICY } from "../../scripts/quality/lib/supply-chain/policy.mjs";

const SEVERITIES = ["info", "low", "moderate", "high", "critical"];

function clone(value) {
  return structuredClone(value);
}

function expectCode(action, code) {
  assert.throws(action, (error) => error instanceof NpmIsolationError && error.code === code);
}

function advisory(name, severity, source = 1001) {
  return {
    source,
    name,
    dependency: name,
    title: `Synthetic ${severity} advisory for ${name}`,
    url: `https://github.com/advisories/GHSA-${source}`,
    severity,
    cwe: ["CWE-79", "CWE-89"],
    cvss: {
      score: severity === "critical" ? 9.8 : 6.5,
      vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L",
    },
    range: "<2.0.0",
  };
}

function vulnerability(name, severity, overrides = {}) {
  return {
    name,
    severity,
    isDirect: false,
    via: [advisory(name, severity)],
    effects: [],
    range: "<2.0.0",
    nodes: [`node_modules/${name}`],
    fixAvailable: false,
    ...overrides,
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
        prod: 2,
        dev: 3,
        optional: 0,
        peer: 1,
        peerOptional: 0,
        total: 6,
      },
    },
  };
}

function metavulnerabilityReport() {
  const referenced = vulnerability("serialize-javascript", "high", {
    effects: ["webpack"],
  });
  const meta = vulnerability("webpack", "moderate", {
    via: ["serialize-javascript"],
    fixAvailable: {
      name: "webpack",
      version: "6.0.0",
      isSemVerMajor: true,
    },
  });
  return auditReport({
    webpack: meta,
    "serialize-javascript": referenced,
  });
}

function processResult(report, status) {
  return {
    status,
    signal: null,
    stdout: `${JSON.stringify(report)}\n`,
    stderr: "",
  };
}

function parseReport(report) {
  return parseNpmAuditReport({
    stdout: `${JSON.stringify(report)}\n`,
    policy: clone(EXPECTED_DEPENDENCY_POLICY),
  });
}

test("D-077 npm audit v2 parser", async (suite) => {
  await suite.test("accepts a clean report and low findings without blocking", () => {
    const clean = assertNpmAuditResultAllowed({
      result: processResult(auditReport(), 0),
      policy: clone(EXPECTED_DEPENDENCY_POLICY),
    });
    assert.equal(clean.outcome, "pass");
    assert.deepEqual(clean.blocking, []);
    assert.deepEqual(clean.reportOnly, []);

    const lowReport = auditReport({
      "low-package": vulnerability("low-package", "low", { isDirect: true }),
    });
    const low = assertNpmAuditResultAllowed({
      result: processResult(lowReport, 0),
      policy: clone(EXPECTED_DEPENDENCY_POLICY),
    });
    assert.equal(low.outcome, "pass");
    assert.deepEqual(low.reportOnly, [{ name: "low-package", severity: "low" }]);
  });

  await suite.test("preserves and parses stdout from the expected nonzero vulnerability exit", () => {
    const report = auditReport({
      "moderate-package": vulnerability("moderate-package", "moderate"),
      "high-package": vulnerability("high-package", "high"),
      "critical-package": vulnerability("critical-package", "critical"),
    });
    const parsed = parseNpmAuditResult({
      result: processResult(report, 1),
      policy: clone(EXPECTED_DEPENDENCY_POLICY),
    });
    assert.equal(parsed.exitCode, 1);
    assert.equal(parsed.outcome, "blocked");
    assert.deepEqual(parsed.blocking, [
      { name: "critical-package", severity: "critical" },
      { name: "high-package", severity: "high" },
      { name: "moderate-package", severity: "moderate" },
    ]);
    expectCode(
      () => assertNpmAuditResultAllowed({
        result: processResult(report, 1),
        policy: clone(EXPECTED_DEPENDENCY_POLICY),
      }),
      "SUPPLY_CHAIN_AUDIT_BLOCKED",
    );
  });

  await suite.test("normalizes package, node, CWE and advisory ordering deterministically", () => {
    const alpha = vulnerability("alpha", "low", {
      via: [advisory("alpha", "low", 2002), advisory("alpha", "low", 1001)],
      nodes: ["node_modules/container/node_modules/alpha", "node_modules/alpha"],
    });
    alpha.via[0].cwe = ["CWE-89", "CWE-79"];
    const beta = vulnerability("beta", "low");
    const first = auditReport({ beta, alpha });
    const second = auditReport({ alpha: clone(alpha), beta: clone(beta) });
    second.vulnerabilities.alpha.via.reverse();
    second.vulnerabilities.alpha.nodes.reverse();
    second.vulnerabilities.alpha.via[1].cwe.reverse();

    const normalizedFirst = parseReport(first);
    const normalizedSecond = parseReport(second);
    assert.deepEqual(normalizedFirst, normalizedSecond);
    assert.deepEqual(normalizedFirst.vulnerabilities.map(({ name }) => name), ["alpha", "beta"]);
    assert.deepEqual(
      normalizedFirst.vulnerabilities[0].via.map(({ source }) => source),
      [1001, 2002],
    );
  });

  await suite.test("accepts lower-severity npm v2 metavulnerability references and structured fixes", () => {
    const parsed = parseReport(metavulnerabilityReport());
    assert.deepEqual(parsed.vulnerabilities.map(({ name, severity }) => ({ name, severity })), [
      { name: "serialize-javascript", severity: "high" },
      { name: "webpack", severity: "moderate" },
    ]);
    assert.deepEqual(parsed.vulnerabilities[1].via, ["serialize-javascript"]);
    assert.deepEqual(parsed.vulnerabilities[1].fixAvailable, {
      isSemVerMajor: true,
      name: "webpack",
      version: "6.0.0",
    });

    const omittedReverseIndex = metavulnerabilityReport();
    omittedReverseIndex.vulnerabilities["serialize-javascript"].effects = [];
    assert.equal(parseReport(omittedReverseIndex).vulnerabilities.length, 2);
  });

  await suite.test("requires top severity to equal the maximum when every via is a direct advisory", () => {
    const direct = vulnerability("direct", "high", {
      via: [
        advisory("direct", "low", 1001),
        advisory("direct", "high", 2002),
      ],
    });
    assert.equal(parseReport(auditReport({ direct })).vulnerabilities[0].severity, "high");

    const mismatched = clone(direct);
    mismatched.severity = "moderate";
    expectCode(
      () => parseReport(auditReport({ direct: mismatched })),
      "SUPPLY_CHAIN_AUDIT_SEVERITY",
    );

    const overstated = clone(direct);
    overstated.severity = "critical";
    expectCode(
      () => parseReport(auditReport({ direct: overstated })),
      "SUPPLY_CHAIN_AUDIT_SEVERITY",
    );
  });

  await suite.test("uses direct advisory severity as a lower bound for mixed via", () => {
    const cause = vulnerability("cause", "low", { effects: ["mixed"] });
    const mixed = vulnerability("mixed", "low", {
      via: ["cause", advisory("mixed", "critical", 2002)],
    });
    expectCode(
      () => assertNpmAuditResultAllowed({
        result: processResult(auditReport({ cause, mixed }), 0),
        policy: clone(EXPECTED_DEPENDENCY_POLICY),
      }),
      "SUPPLY_CHAIN_AUDIT_SEVERITY",
    );

    const severeCause = vulnerability("cause", "critical", { effects: ["mixed"] });
    const compatibleMixed = vulnerability("mixed", "high", {
      via: ["cause", advisory("mixed", "low", 2002)],
    });
    const parsed = parseReport(auditReport({ cause: severeCause, mixed: compatibleMixed }));
    assert.deepEqual(parsed.vulnerabilities.map(({ name, severity }) => ({ name, severity })), [
      { name: "cause", severity: "critical" },
      { name: "mixed", severity: "high" },
    ]);
  });

  await suite.test("requires every metavulnerability chain to terminate at an advisory", () => {
    const selfCycle = auditReport({
      alpha: vulnerability("alpha", "low", { effects: ["alpha"], via: ["alpha"] }),
    });
    expectCode(() => parseReport(selfCycle), "SUPPLY_CHAIN_AUDIT_SCHEMA");

    const twoNodeCycle = auditReport({
      alpha: vulnerability("alpha", "low", { effects: ["beta"], via: ["beta"] }),
      beta: vulnerability("beta", "low", { effects: ["alpha"], via: ["alpha"] }),
    });
    expectCode(() => parseReport(twoNodeCycle), "SUPPLY_CHAIN_AUDIT_SCHEMA");

    const terminalCycle = auditReport({
      alpha: vulnerability("alpha", "low", {
        effects: [],
        via: ["beta", advisory("alpha", "low")],
      }),
      beta: vulnerability("beta", "low", { effects: [], via: ["alpha"] }),
    });
    assert.equal(parseReport(terminalCycle).vulnerabilities.length, 2);
  });

  await suite.test("resolves a long reverse-ordered metavulnerability chain", () => {
    const count = 4096;
    const names = Array.from(
      { length: count },
      (_, index) => `chain-${String(index).padStart(4, "0")}`,
    );
    const vulnerabilities = Object.fromEntries(names.map((name, index) => [
      name,
      vulnerability(name, "low", {
        effects: index === 0 ? [] : [names[index - 1]],
        via: index === names.length - 1
          ? [advisory(name, "low")]
          : [names[index + 1]],
      }),
    ]));

    const parsed = parseReport(auditReport(vulnerabilities));
    assert.equal(parsed.vulnerabilities.length, count);
    assert.equal(parsed.vulnerabilities[0].name, names[0]);
    assert.equal(parsed.vulnerabilities.at(-1).name, names.at(-1));
  });

  await suite.test("fails closed on malformed JSON, schema drift and audit report versions", () => {
    expectCode(
      () => parseNpmAuditReport({ stdout: "not-json\n", policy: clone(EXPECTED_DEPENDENCY_POLICY) }),
      "SUPPLY_CHAIN_AUDIT_JSON",
    );

    const errorResponse = {
      message: "synthetic audit endpoint failure",
      statusCode: 503,
    };
    expectCode(
      () => parseNpmAuditResult({
        result: processResult(errorResponse, 1),
        policy: clone(EXPECTED_DEPENDENCY_POLICY),
      }),
      "SUPPLY_CHAIN_AUDIT_SCHEMA",
    );

    const version = auditReport();
    version.auditReportVersion = 1;
    expectCode(() => parseReport(version), "SUPPLY_CHAIN_AUDIT_VERSION");

    const unknown = auditReport();
    unknown.extra = true;
    expectCode(() => parseReport(unknown), "SUPPLY_CHAIN_AUDIT_SCHEMA");

    const nestedUnknown = auditReport({ alpha: vulnerability("alpha", "low") });
    nestedUnknown.vulnerabilities.alpha.advisoryCount = 1;
    expectCode(() => parseReport(nestedUnknown), "SUPPLY_CHAIN_AUDIT_SCHEMA");

    const duplicateAdvisory = auditReport({ alpha: vulnerability("alpha", "low") });
    const duplicate = clone(duplicateAdvisory.vulnerabilities.alpha.via[0]);
    duplicate.title = "Conflicting duplicate source";
    duplicateAdvisory.vulnerabilities.alpha.via.push(duplicate);
    expectCode(() => parseReport(duplicateAdvisory), "SUPPLY_CHAIN_AUDIT_SCHEMA");

    const invalidNode = auditReport({ alpha: vulnerability("alpha", "low") });
    invalidNode.vulnerabilities.alpha.nodes = ["node_modules/@scope"];
    expectCode(() => parseReport(invalidNode), "SUPPLY_CHAIN_AUDIT_SCHEMA");
  });

  await suite.test("rejects duplicate JSON keys before last-key-wins parsing", () => {
    const report = auditReport({ alpha: vulnerability("alpha", "low") });
    const raw = JSON.stringify(report);
    const duplicateTopLevel = raw.replace(
      '"vulnerabilities":{"alpha":',
      '"vulnerabilities":{"shadow":{}},"vulnerabilities":{"alpha":',
    );
    const duplicateVulnerabilityField = raw.replace(
      '"alpha":{"name":"alpha"',
      '"alpha":{"name":"shadow","name":"alpha"',
    );
    const duplicateMetadataCount = raw.replace(
      '"info":0,"low":1',
      '"info":0,"low":99,"low":1',
    );
    for (const stdout of [
      duplicateTopLevel,
      duplicateVulnerabilityField,
      duplicateMetadataCount,
    ]) {
      expectCode(
        () => parseNpmAuditReport({
          stdout: `${stdout}\n`,
          policy: clone(EXPECTED_DEPENDENCY_POLICY),
        }),
        "SUPPLY_CHAIN_AUDIT_SCHEMA",
      );
    }
  });

  await suite.test("fails closed on unknown or policy-unclassified severities", () => {
    const unknown = auditReport({ alpha: vulnerability("alpha", "low") });
    unknown.vulnerabilities.alpha.severity = "urgent";
    unknown.metadata.vulnerabilities.low = 0;
    unknown.metadata.vulnerabilities.total = 1;
    expectCode(() => parseReport(unknown), "SUPPLY_CHAIN_AUDIT_SEVERITY");

    const unknownMeta = metavulnerabilityReport();
    unknownMeta.vulnerabilities.webpack.severity = "urgent";
    expectCode(() => parseReport(unknownMeta), "SUPPLY_CHAIN_AUDIT_SEVERITY");

    const info = auditReport({ alpha: vulnerability("alpha", "info") });
    expectCode(() => parseReport(info), "SUPPLY_CHAIN_AUDIT_SEVERITY");

    const aggregateMismatch = auditReport({ alpha: vulnerability("alpha", "high") });
    aggregateMismatch.vulnerabilities.alpha.severity = "critical";
    aggregateMismatch.metadata.vulnerabilities.high = 0;
    aggregateMismatch.metadata.vulnerabilities.critical = 1;
    expectCode(() => parseReport(aggregateMismatch), "SUPPLY_CHAIN_AUDIT_SEVERITY");
  });

  await suite.test("fails closed on metadata drift and invalid vulnerability references", () => {
    const counts = auditReport({ alpha: vulnerability("alpha", "low") });
    counts.metadata.vulnerabilities.low = 0;
    expectCode(() => parseReport(counts), "SUPPLY_CHAIN_AUDIT_METADATA");

    const total = auditReport({ alpha: vulnerability("alpha", "low") });
    total.metadata.vulnerabilities.total = 2;
    expectCode(() => parseReport(total), "SUPPLY_CHAIN_AUDIT_METADATA");

    const metaCounts = metavulnerabilityReport();
    metaCounts.metadata.vulnerabilities.moderate = 0;
    metaCounts.metadata.vulnerabilities.high = 2;
    expectCode(() => parseReport(metaCounts), "SUPPLY_CHAIN_AUDIT_METADATA");

    const effectsOnly = metavulnerabilityReport();
    effectsOnly.vulnerabilities.webpack.effects = ["serialize-javascript"];
    expectCode(() => parseReport(effectsOnly), "SUPPLY_CHAIN_AUDIT_SCHEMA");

    const unknownEffect = metavulnerabilityReport();
    unknownEffect.vulnerabilities["serialize-javascript"].effects = ["missing-package"];
    expectCode(() => parseReport(unknownEffect), "SUPPLY_CHAIN_AUDIT_SCHEMA");

    const unknownVia = auditReport({
      wrapper: vulnerability("wrapper", "high", { via: ["missing-package"] }),
    });
    expectCode(() => parseReport(unknownVia), "SUPPLY_CHAIN_AUDIT_SCHEMA");

    const truncatedDependencies = auditReport();
    truncatedDependencies.metadata.dependencies.total = 0;
    expectCode(
      () => parseNpmAuditReport({
        stdout: `${JSON.stringify(truncatedDependencies)}\n`,
        policy: clone(EXPECTED_DEPENDENCY_POLICY),
        expectedDependencyCount: 6,
      }),
      "SUPPLY_CHAIN_AUDIT_DEPENDENCY_CLOSURE",
    );
  });

  await suite.test("fails closed on process errors and exit/report mismatches", () => {
    const clean = auditReport();
    const blocked = auditReport({ alpha: vulnerability("alpha", "moderate") });
    for (const result of [
      { ...processResult(clean, 0), error: new Error("synthetic spawn failure") },
      { ...processResult(clean, 0), signal: "SIGTERM" },
      processResult(clean, 2),
    ]) {
      expectCode(
        () => parseNpmAuditResult({ result, policy: clone(EXPECTED_DEPENDENCY_POLICY) }),
        "SUPPLY_CHAIN_AUDIT_PROCESS",
      );
    }
    expectCode(
      () => parseNpmAuditResult({
        result: processResult(clean, 1),
        policy: clone(EXPECTED_DEPENDENCY_POLICY),
      }),
      "SUPPLY_CHAIN_AUDIT_EXIT_MISMATCH",
    );
    expectCode(
      () => parseNpmAuditResult({
        result: processResult(blocked, 0),
        policy: clone(EXPECTED_DEPENDENCY_POLICY),
      }),
      "SUPPLY_CHAIN_AUDIT_EXIT_MISMATCH",
    );
  });
});

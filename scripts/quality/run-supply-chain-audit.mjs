import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fail, NpmIsolationError } from "./lib/supply-chain/errors.mjs";
import { writeRestrictedAuditReport } from "./lib/supply-chain/audit-report.mjs";
import {
  assertSupplyChainInputReceiptCurrent,
  captureCurrentSupplyChainInputReceipt,
} from "./lib/supply-chain/input-receipt.mjs";
import { runIsolatedNpm } from "./lib/supply-chain/runner.mjs";

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));

export function parseSupplyChainAuditArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length !== 0) {
    fail("SUPPLY_CHAIN_AUDIT_ARGUMENTS", "供应链 audit 入口不接受任何参数。");
  }
  return {};
}

function formatArtifactSummary(artifact) {
  return JSON.stringify({
    artifactPath: artifact.path,
    aggregate: artifact.aggregate,
    receiptPath: artifact.receiptPath,
    receiptSha256: artifact.receiptSha256,
  });
}

function validateArtifactSummary(artifact) {
  const expectedKeys = [
    "aggregate",
    "directory",
    "path",
    "rawSha256",
    "receiptPath",
    "receiptSha256",
  ];
  const aggregateKeys = [
    "auditReportVersion",
    "blocking",
    "critical",
    "dependencyTotal",
    "exitCode",
    "high",
    "info",
    "low",
    "moderate",
    "outcome",
    "reportOnly",
    "total",
  ];
  if (
    artifact === null
    || typeof artifact !== "object"
    || Array.isArray(artifact)
    || Object.keys(artifact).sort().join("\n") !== expectedKeys.sort().join("\n")
    || artifact.aggregate === null
    || typeof artifact.aggregate !== "object"
    || Array.isArray(artifact.aggregate)
    || Object.keys(artifact.aggregate).sort().join("\n") !== aggregateKeys.sort().join("\n")
    || typeof artifact.directory !== "string"
    || !isAbsolute(artifact.directory)
    || artifact.path !== join(artifact.directory, "raw-audit.json")
    || artifact.receiptPath !== join(artifact.directory, "receipt.json")
    || !/^[0-9a-f]{64}$/u.test(artifact.rawSha256 ?? "")
    || !/^[0-9a-f]{64}$/u.test(artifact.receiptSha256 ?? "")
  ) {
    fail("SUPPLY_CHAIN_AUDIT_ARTIFACT_SCHEMA", "npm audit 受限制品摘要不符合固定 schema。");
  }
  for (const key of aggregateKeys.filter((key) => key !== "outcome")) {
    if (!Number.isSafeInteger(artifact.aggregate[key]) || artifact.aggregate[key] < 0) {
      fail("SUPPLY_CHAIN_AUDIT_ARTIFACT_SCHEMA", "npm audit 聚合摘要包含非法计数。");
    }
  }
  if (artifact.aggregate.outcome !== "pass" && artifact.aggregate.outcome !== "blocked") {
    fail("SUPPLY_CHAIN_AUDIT_ARTIFACT_SCHEMA", "npm audit 聚合摘要 outcome 不受支持。");
  }
  return artifact;
}

function formatAuditFailure(error) {
  const code = error instanceof NpmIsolationError
      && /^[A-Z][A-Z0-9_]{1,127}$/u.test(error.code)
    ? error.code
    : "SUPPLY_CHAIN_AUDIT_INTERNAL";
  return `[${code}] 供应链 audit 未通过；详细响应和子进程输出已抑制。`;
}

export function runSupplyChainAudit({
  arguments_ = [],
  root = ROOT,
  temporaryParent = "/tmp",
  runIsolated = runIsolatedNpm,
  writeReport = writeRestrictedAuditReport,
  captureReceipt = captureCurrentSupplyChainInputReceipt,
  assertReceiptCurrent = assertSupplyChainInputReceiptCurrent,
  standardError = process.stderr,
} = {}) {
  let artifact = null;
  let receipt = null;
  try {
    parseSupplyChainAuditArguments(arguments_);
    if (
      typeof runIsolated !== "function"
      || typeof writeReport !== "function"
      || typeof captureReceipt !== "function"
      || typeof assertReceiptCurrent !== "function"
    ) {
      fail("SUPPLY_CHAIN_AUDIT_ORCHESTRATION", "供应链 audit 编排依赖不合法。");
    }
    receipt = captureReceipt({ root });
    const assertInputsUnchanged = () => assertReceiptCurrent({
      code: "SUPPLY_CHAIN_AUDIT_INPUT_DRIFT",
      receipt,
      requiredRole: "primary",
      root,
    });
    assertInputsUnchanged();
    runIsolated({
      root,
      profile: "audit",
      scriptName: null,
      onAuditResult: (result) => {
        if (artifact !== null) {
          fail("SUPPLY_CHAIN_AUDIT_REPORT_DUPLICATE", "npm audit 结果回调被重复调用。");
        }
        assertInputsUnchanged();
        artifact = validateArtifactSummary(
          writeReport({ ...result, receipt, temporaryParent }),
        );
        assertInputsUnchanged();
      },
    });
    assertInputsUnchanged();
    if (artifact === null) {
      fail("SUPPLY_CHAIN_AUDIT_REPORT_MISSING", "npm audit 成功但未形成受限报告。");
    }
    standardError.write(`${formatArtifactSummary(artifact)}\n`);
    return 0;
  } catch (error) {
    let failure = error;
    if (receipt !== null && typeof assertReceiptCurrent === "function") {
      try {
        assertReceiptCurrent({
          code: "SUPPLY_CHAIN_AUDIT_INPUT_DRIFT",
          receipt,
          requiredRole: "primary",
          root,
        });
      } catch (driftError) {
        failure = driftError;
      }
    }
    if (artifact !== null) {
      standardError.write(`${formatArtifactSummary(artifact)}\n`);
    }
    standardError.write(`${formatAuditFailure(failure)}\n`);
    return 1;
  }
}

function runCli() {
  process.exitCode = runSupplyChainAudit({ arguments_: process.argv.slice(2) });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}

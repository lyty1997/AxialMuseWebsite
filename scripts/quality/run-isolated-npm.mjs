import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatIsolationError } from "./lib/supply-chain/errors.mjs";
import { parseProfileArguments } from "./lib/supply-chain/profiles.mjs";
import { runIsolatedNpm } from "./lib/supply-chain/runner.mjs";

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));

function formatAuditAggregate(audit) {
  const vulnerabilities = audit.metadata.vulnerabilities;
  return JSON.stringify({
    auditReportVersion: audit.auditReportVersion,
    outcome: audit.outcome,
    total: vulnerabilities.total,
    info: vulnerabilities.info,
    low: vulnerabilities.low,
    moderate: vulnerabilities.moderate,
    high: vulnerabilities.high,
    critical: vulnerabilities.critical,
    reportOnly: audit.reportOnly.length,
    blocking: audit.blocking.length,
  });
}

export function writeIsolatedNpmResult(result, {
  standardError = process.stderr,
  standardOutput = process.stdout,
} = {}) {
  if (result.profile === "audit") {
    standardError.write(
      `Isolated npm audit passed: ${formatAuditAggregate(result.audit)} (registry=official, cache=fresh, config=isolated).\n`,
    );
    return;
  }

  if (result.stdout) standardOutput.write(result.stdout);
  if (result.stderr) standardError.write(result.stderr);
  const summary = `Isolated npm profile passed: ${result.profile} (registry=official, cache=fresh, config=isolated).\n`;
  if (result.profile === "sbom-native") {
    standardError.write(summary);
  } else {
    standardOutput.write(summary);
  }
}

function runCli() {
  try {
    const request = parseProfileArguments(process.argv.slice(2));
    const result = runIsolatedNpm({ root: ROOT, ...request });
    writeIsolatedNpmResult(result);
  } catch (error) {
    console.error(formatIsolationError(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}

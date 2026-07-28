import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "./lib/files.mjs";
import { buildQualityChildEnvironment } from "./lib/process-environment.mjs";

const ROOT = projectRoot();
const CHILD_ENVIRONMENT = buildQualityChildEnvironment();
export const QUALITY_COMMANDS = Object.freeze([
  ["scripts/quality/check-author-transaction.mjs"],
  ["scripts/quality/check-javascript.mjs"],
  ["scripts/quality/check-module-boundaries.mjs"],
  ["scripts/quality/check-npm-isolation.mjs"],
  ["scripts/quality/check-ci-workflow.mjs"],
  ["scripts/quality/check-markdown.mjs"],
  ["scripts/quality/check-contracts.mjs"],
  ["scripts/quality/check-secrets.mjs"],
  ["scripts/quality/check-static-site.mjs"],
  ["scripts/quality/check-runtime-redirects.mjs"],
  ["scripts/quality/check-supply-chain.mjs"],
  ["--test", "tests/build/run-isolated-npm.test.mjs"],
  ["--test", "tests/build/ci-workflow.test.mjs"],
  ["--test", "tests/build/deterministic-spdx.test.mjs"],
  ["--test", "tests/build/supply-chain-audit-report.test.mjs"],
  ["--test", "tests/build/supply-chain-audit.test.mjs"],
  ["--test", "tests/build/supply-chain-candidate-review.test.mjs"],
  ["--test", "tests/build/supply-chain-download.test.mjs"],
  ["--test", "tests/build/supply-chain-dual-endpoint-ci.test.mjs"],
  ["--test", "tests/build/supply-chain-final-admission.test.mjs"],
  ["--test", "tests/build/supply-chain-final-admission-runner.test.mjs"],
  ["--test", "tests/build/supply-chain-generation.test.mjs"],
  ["--test", "tests/build/supply-chain-notices.test.mjs"],
  ["--test", "tests/build/supply-chain-policy.test.mjs"],
  ["--test", "tests/build/supply-chain-review-report.test.mjs"],
  ["--test", "tests/build/supply-chain-tarball.test.mjs"],
  ["--test", "tests/build/run-tests.test.mjs"],
  ["--test", "tests/build/module-boundaries.test.mjs"],
  ["--test", "tests/build/content-decoders.test.mjs"],
  ["--test", "tests/build/runtime-redirects.test.mjs"],
  ["--test", "tests/build/build-site.test.mjs"],
  ["--test", "tests/build/author-transaction.test.mjs"],
].map((command) => Object.freeze(command)));

export function runQuality() {
  for (const arguments_ of QUALITY_COMMANDS) {
    const normalized = arguments_.map((argument) => argument.startsWith("-") ? argument : resolve(ROOT, argument));
    const result = spawnSync(process.execPath, normalized, {
      cwd: ROOT,
      env: CHILD_ENVIRONMENT,
      stdio: "inherit",
    });
    if (result.error || result.status !== 0 || result.signal) {
      console.error(`Quality command failed: node ${arguments_.join(" ")}`);
      return 1;
    }
  }
  console.log("Quality checks passed.");
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runQuality();
}

import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { projectRoot } from "./lib/files.mjs";
import { buildQualityChildEnvironment } from "./lib/process-environment.mjs";

const ROOT = projectRoot();
const FILES = [
  "scripts/quality/lib/files.mjs",
  "scripts/quality/lib/plantuml.mjs",
  "scripts/quality/lib/process-environment.mjs",
  "scripts/quality/lib/supply-chain/admission.mjs",
  "scripts/quality/lib/supply-chain/audit-report.mjs",
  "scripts/quality/lib/supply-chain/audit.mjs",
  "scripts/quality/lib/supply-chain/bypass.mjs",
  "scripts/quality/lib/supply-chain/candidate-review.mjs",
  "scripts/quality/lib/supply-chain/check.mjs",
  "scripts/quality/lib/supply-chain/config.mjs",
  "scripts/quality/lib/supply-chain/contracts.mjs",
  "scripts/quality/lib/supply-chain/dual-endpoint-ci.mjs",
  "scripts/quality/lib/supply-chain/environment.mjs",
  "scripts/quality/lib/supply-chain/errors.mjs",
  "scripts/quality/lib/supply-chain/final-admission.mjs",
  "scripts/quality/lib/supply-chain/final-admission-runner.mjs",
  "scripts/quality/lib/supply-chain/formal-generation.mjs",
  "scripts/quality/lib/supply-chain/input-receipt.mjs",
  "scripts/quality/lib/supply-chain/license-evidence.mjs",
  "scripts/quality/lib/supply-chain/lockfile.mjs",
  "scripts/quality/lib/supply-chain/notices.mjs",
  "scripts/quality/lib/supply-chain/policy.mjs",
  "scripts/quality/lib/supply-chain/profiles.mjs",
  "scripts/quality/lib/supply-chain/runner.mjs",
  "scripts/quality/lib/supply-chain/review-report.mjs",
  "scripts/quality/lib/supply-chain/sbom-artifacts.mjs",
  "scripts/quality/lib/supply-chain/spdx.mjs",
  "scripts/quality/lib/supply-chain/strict-json.mjs",
  "scripts/quality/lib/supply-chain/tarball-download.mjs",
  "scripts/quality/lib/supply-chain/tarball.mjs",
  "scripts/quality/check-javascript.mjs",
  "scripts/quality/check-npm-isolation.mjs",
  "scripts/quality/check-markdown.mjs",
  "scripts/quality/check-contracts.mjs",
  "scripts/quality/check-secrets.mjs",
  "scripts/quality/check-supply-chain.mjs",
  "scripts/quality/check-static-site.mjs",
  "scripts/quality/check-diagrams.mjs",
  "scripts/quality/render-diagrams.mjs",
  "scripts/quality/check-module-boundaries.mjs",
  "scripts/build/build-site.mjs",
  "scripts/quality/generate-supply-chain-artifacts.mjs",
  "scripts/quality/review-supply-chain-candidates.mjs",
  "scripts/quality/run-dual-endpoint-ci-worker.mjs",
  "scripts/quality/run-dual-endpoint-ci.mjs",
  "scripts/quality/run-final-supply-chain-admission.mjs",
  "scripts/quality/run-isolated-npm.mjs",
  "scripts/quality/run-supply-chain-audit.mjs",
  "scripts/quality/run-quality.mjs",
  "tests/build/deterministic-spdx.test.mjs",
  "tests/build/run-isolated-npm.test.mjs",
  "tests/build/supply-chain-audit-report.test.mjs",
  "tests/build/supply-chain-audit.test.mjs",
  "tests/build/supply-chain-candidate-review.test.mjs",
  "tests/build/supply-chain-download.test.mjs",
  "tests/build/supply-chain-dual-endpoint-ci.test.mjs",
  "tests/build/supply-chain-final-admission.test.mjs",
  "tests/build/supply-chain-final-admission-runner.test.mjs",
  "tests/build/supply-chain-generation.test.mjs",
  "tests/build/supply-chain-license-evidence-fixture.mjs",
  "tests/build/supply-chain-notices.test.mjs",
  "tests/build/supply-chain-policy.test.mjs",
  "tests/build/supply-chain-review-report.test.mjs",
  "tests/build/supply-chain-tarball.test.mjs",
  "tests/build/module-boundaries.test.mjs",
  "tests/build/build-site.test.mjs",
].map((path) => resolve(ROOT, path));
const CHILD_ENVIRONMENT = buildQualityChildEnvironment();

for (const path of FILES) {
  const result = spawnSync(process.execPath, ["--check", path], {
    cwd: ROOT,
    env: CHILD_ENVIRONMENT,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0 || result.signal) {
    console.error(`JavaScript syntax check failed: ${relative(ROOT, path)}`);
    process.exit(1);
  }
}

console.log("JavaScript syntax checks passed.");

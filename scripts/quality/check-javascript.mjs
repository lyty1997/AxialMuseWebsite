import {spawnSync} from "node:child_process";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {projectRoot} from "./lib/files.mjs";
import {buildQualityChildEnvironment} from "./lib/process-environment.mjs";

const ROOT = projectRoot();
export const JAVASCRIPT_SOURCE_FILES = Object.freeze([
  "scripts/quality/lib/files.mjs",
  "scripts/quality/lib/plantuml.mjs",
  "scripts/quality/lib/process-environment.mjs",
  "scripts/quality/lib/ci-workflow.mjs",
  "scripts/quality/lib/content-history.mjs",
  "scripts/author/lib/transaction-state.mjs",
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
  "scripts/content/frontmatter.mjs",
  "scripts/content/json.mjs",
  "scripts/author/create-article.mjs",
  "scripts/author/run-create-article-tests.mjs",
  "scripts/quality/check-javascript.mjs",
  "scripts/quality/check-ci-workflow.mjs",
  "scripts/quality/check-author-transaction.mjs",
  "scripts/quality/check-content-history.mjs",
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
  "scripts/quality/run-content-history.mjs",
  "scripts/quality/run-quality.mjs",
  "scripts/quality/run-tests.mjs",
  "tests/build/deterministic-spdx.test.mjs",
  "tests/build/ci-workflow.test.mjs",
  "tests/build/content-frontmatter-integration.test.mjs",
  "tests/build/content-history.test.mjs",
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
  "tests/build/content-decoders.test.mjs",
  "tests/build/build-site.test.mjs",
  "tests/build/author-transaction.test.mjs",
  "tests/build/run-create-article-tests.test.mjs",
  "tests/build/create-article.test.mjs",
  "tests/build/create-article.integration.test.mjs",
  "tests/build/run-tests.test.mjs",
]);
const CHILD_ENVIRONMENT = buildQualityChildEnvironment();

export function checkJavaScriptSyntax({
  root = ROOT,
  spawnProcess = spawnSync,
  standardOutput = process.stdout,
  standardError = process.stderr,
} = {}) {
  for (const sourcePath of JAVASCRIPT_SOURCE_FILES) {
    const path = resolve(root, sourcePath);
    const result = spawnProcess(process.execPath, ["--check", path], {
      cwd: root,
      env: CHILD_ENVIRONMENT,
      stdio: "inherit",
    });
    if (result.error || result.status !== 0 || result.signal) {
      standardError.write(`JavaScript syntax check failed: ${sourcePath}\n`);
      return Object.freeze({ok: false, sourcePath});
    }
  }
  standardOutput.write("JavaScript syntax checks passed.\n");
  return Object.freeze({ok: true});
}

function runCli() {
  if (!checkJavaScriptSyntax().ok) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}

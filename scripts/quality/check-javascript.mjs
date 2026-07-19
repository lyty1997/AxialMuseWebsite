import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { projectRoot } from "./lib/files.mjs";
import { buildQualityChildEnvironment } from "./lib/process-environment.mjs";

const ROOT = projectRoot();
const FILES = [
  "scripts/quality/lib/files.mjs",
  "scripts/quality/lib/plantuml.mjs",
  "scripts/quality/lib/process-environment.mjs",
  "scripts/quality/lib/supply-chain/bypass.mjs",
  "scripts/quality/lib/supply-chain/config.mjs",
  "scripts/quality/lib/supply-chain/contracts.mjs",
  "scripts/quality/lib/supply-chain/environment.mjs",
  "scripts/quality/lib/supply-chain/errors.mjs",
  "scripts/quality/lib/supply-chain/lockfile.mjs",
  "scripts/quality/lib/supply-chain/profiles.mjs",
  "scripts/quality/lib/supply-chain/runner.mjs",
  "scripts/quality/check-javascript.mjs",
  "scripts/quality/check-npm-isolation.mjs",
  "scripts/quality/check-markdown.mjs",
  "scripts/quality/check-contracts.mjs",
  "scripts/quality/check-secrets.mjs",
  "scripts/quality/check-static-site.mjs",
  "scripts/quality/check-diagrams.mjs",
  "scripts/quality/render-diagrams.mjs",
  "scripts/quality/run-isolated-npm.mjs",
  "scripts/quality/run-quality.mjs",
  "tests/build/run-isolated-npm.test.mjs",
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

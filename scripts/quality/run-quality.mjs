import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "./lib/files.mjs";
import { buildQualityChildEnvironment } from "./lib/process-environment.mjs";

const ROOT = projectRoot();
const CHILD_ENVIRONMENT = buildQualityChildEnvironment();
export const QUALITY_COMMANDS = Object.freeze([
  ["scripts/quality/check-javascript.mjs"],
  ["scripts/quality/check-npm-isolation.mjs"],
  ["scripts/quality/check-markdown.mjs"],
  ["scripts/quality/check-contracts.mjs"],
  ["scripts/quality/check-secrets.mjs"],
  ["scripts/quality/check-static-site.mjs"],
  ["--test", "tests/build/run-isolated-npm.test.mjs"],
  ["--test", "tests/build/deterministic-spdx.test.mjs"],
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

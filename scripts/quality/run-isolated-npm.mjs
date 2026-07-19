import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatIsolationError } from "./lib/supply-chain/errors.mjs";
import { parseProfileArguments } from "./lib/supply-chain/profiles.mjs";
import { runIsolatedNpm } from "./lib/supply-chain/runner.mjs";

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));

try {
  const request = parseProfileArguments(process.argv.slice(2));
  const result = runIsolatedNpm({ root: ROOT, ...request });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const summary = `Isolated npm profile passed: ${result.profile} (registry=official, cache=fresh, config=isolated).\n`;
  if (result.profile === "sbom-native" || result.profile === "audit") {
    process.stderr.write(summary);
  } else {
    process.stdout.write(summary);
  }
} catch (error) {
  console.error(formatIsolationError(error));
  process.exitCode = 1;
}

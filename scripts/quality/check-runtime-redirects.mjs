import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {
  formatRuntimeRedirectError,
  readRedirectRegistry,
} from "../release/lib/runtime-redirects.mjs";

export function checkRuntimeRedirectRegistry({
  standardOutput = process.stdout,
  standardError = process.stderr,
} = {}) {
  try {
    const registry = readRedirectRegistry();
    standardOutput.write(
      `Runtime redirect registry check passed: ${registry.redirects.length} registered redirect(s).\n`,
    );
    return Object.freeze({ok: true, redirectCount: registry.redirects.length});
  } catch (error) {
    standardError.write(`${formatRuntimeRedirectError(error)}\n`);
    return Object.freeze({ok: false});
  }
}

function runCli() {
  if (process.argv.length !== 2) {
    console.error("[RELEASE_REDIRECT_ARGUMENTS] 重定向注册表检查入口不接受参数。");
    process.exitCode = 1;
    return;
  }
  if (!checkRuntimeRedirectRegistry().ok) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}

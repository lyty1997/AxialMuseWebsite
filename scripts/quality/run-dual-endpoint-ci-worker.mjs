#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJsonBytes } from "./lib/supply-chain/spdx.mjs";
import { formatSupplyChainError, fail } from "./lib/supply-chain/errors.mjs";
import { runIsolatedNpm } from "./lib/supply-chain/runner.mjs";

export function runDualEndpointCiWorker({
  cwd = process.cwd(),
  runNpm = runIsolatedNpm,
} = {}) {
  if (typeof cwd !== "string" || cwd === "" || typeof runNpm !== "function") {
    fail("DUAL_ENDPOINT_CI_WORKER_INPUT", "双端点内部 worker 输入不合法。");
  }
  let root;
  try {
    root = realpathSync(cwd);
  } catch {
    fail("DUAL_ENDPOINT_CI_WORKER_ROOT", "双端点内部 worker 工作目录不可用。");
  }
  const result = runNpm({ root, profile: "ci" });
  const runtime = result?.runtime;
  if (
    runtime === null
    || typeof runtime !== "object"
    || Array.isArray(runtime)
    || (runtime.role !== "primary" && runtime.role !== "minimum")
    || typeof runtime.nodeVersion !== "string"
    || typeof runtime.npmVersion !== "string"
  ) {
    fail("DUAL_ENDPOINT_CI_WORKER_RESULT", "隔离 ci 没有返回精确运行时证明。");
  }
  return Object.freeze({
    nodeVersion: runtime.nodeVersion,
    npmVersion: runtime.npmVersion,
    role: runtime.role,
  });
}

export function main(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    fail("DUAL_ENDPOINT_CI_WORKER_ARGUMENTS", "双端点内部 worker 不接受参数。");
  }
  process.stdout.write(canonicalJsonBytes(runDualEndpointCiWorker()));
}

if (
  process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error(formatSupplyChainError(error));
    process.exitCode = 1;
  }
}

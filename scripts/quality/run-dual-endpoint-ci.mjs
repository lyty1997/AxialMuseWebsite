#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { projectRoot } from "./lib/files.mjs";
import { runDualEndpointCi } from "./lib/supply-chain/dual-endpoint-ci.mjs";
import { fail, formatSupplyChainError } from "./lib/supply-chain/errors.mjs";

export async function main(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    fail("DUAL_ENDPOINT_CI_ARGUMENTS", "双端点冻结安装入口不接受参数。");
  }
  const result = await runDualEndpointCi({ root: realpathSync(projectRoot()) });
  console.log(`双端点冻结安装通过；受限 receipt：${result.receiptPath}`);
  return result;
}

if (
  process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    await main();
  } catch (error) {
    console.error(formatSupplyChainError(error));
    process.exitCode = 1;
  }
}

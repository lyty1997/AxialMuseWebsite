import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "./lib/files.mjs";
import { checkSupplyChain } from "./lib/supply-chain/check.mjs";
import { fail, formatSupplyChainError } from "./lib/supply-chain/errors.mjs";

export function main(arguments_ = process.argv.slice(2)) {
  try {
    if (!Array.isArray(arguments_) || arguments_.length !== 0) {
      fail("SUPPLY_CHAIN_ARGUMENTS", "静态供应链检查不接受参数。");
    }
    const result = checkSupplyChain({ root: projectRoot() });
    console.log(`Supply-chain static checks passed: ${result.lockedPackages.length} packages.`);
    return 0;
  } catch (error) {
    console.error(formatSupplyChainError(error));
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}

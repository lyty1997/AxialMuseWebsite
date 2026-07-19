import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "./lib/files.mjs";
import { formatSupplyChainError } from "./lib/supply-chain/errors.mjs";
import {
  generateSupplyChainArtifacts,
  parseGenerateSupplyChainArguments,
} from "./lib/supply-chain/sbom-artifacts.mjs";

export function main(arguments_ = process.argv.slice(2)) {
  try {
    const { createdAt } = parseGenerateSupplyChainArguments(arguments_);
    generateSupplyChainArtifacts({
      root: projectRoot(),
      createdAt,
    });
    console.log("Deterministic SPDX artifacts generated.");
    return 0;
  } catch (error) {
    console.error(formatSupplyChainError(error));
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}

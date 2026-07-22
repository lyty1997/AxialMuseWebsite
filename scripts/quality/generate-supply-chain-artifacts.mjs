import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "./lib/files.mjs";
import { formatSupplyChainError } from "./lib/supply-chain/errors.mjs";
import { generateReviewedSupplyChainArtifacts } from "./lib/supply-chain/formal-generation.mjs";
import {
  parseGenerateSupplyChainArguments,
} from "./lib/supply-chain/sbom-artifacts.mjs";

export async function main(arguments_ = process.argv.slice(2)) {
  try {
    const { createdAt } = parseGenerateSupplyChainArguments(arguments_);
    await generateReviewedSupplyChainArtifacts({
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
  process.exitCode = await main();
}

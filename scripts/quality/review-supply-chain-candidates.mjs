import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "./lib/files.mjs";
import {
  parseCandidateReviewArguments,
  reviewSupplyChainCandidates,
} from "./lib/supply-chain/candidate-review.mjs";
import { NpmIsolationError } from "./lib/supply-chain/errors.mjs";

function formatCandidateReviewFailure(error) {
  const code = error instanceof NpmIsolationError
      && /^[A-Z][A-Z0-9_]{1,127}$/u.test(error.code)
    ? error.code
    : "SUPPLY_CHAIN_REVIEW_INTERNAL";
  return `[${code}] 候选供应链审查未通过；详细错误与报告内容已抑制。`;
}

export async function main(arguments_ = process.argv.slice(2), {
  root = projectRoot(),
  runReview = reviewSupplyChainCandidates,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    parseCandidateReviewArguments(arguments_);
    const result = await runReview({ root });
    if (
      result === null
      || typeof result !== "object"
      || typeof result.reportPath !== "string"
      || result.reportPath === ""
      || /[\u0000-\u001f\u007f]/u.test(result.reportPath)
      || typeof result.receiptPath !== "string"
      || result.receiptPath === ""
      || /[\u0000-\u001f\u007f]/u.test(result.receiptPath)
      || result.receiptPath === result.reportPath
      || dirname(result.receiptPath) !== dirname(result.reportPath)
      || !Number.isSafeInteger(result.packageCount)
      || result.packageCount < 0
      || result.packageCount > 50_000
      || !/^[0-9a-f]{64}$/u.test(result.receiptSha256 ?? "")
    ) {
      throw new TypeError("candidate review result summary is invalid");
    }
    stdout.write(
      `Restricted candidate report: ${result.reportPath}; receipt: ${result.receiptPath}; receipt SHA-256: ${result.receiptSha256}\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(`${formatCandidateReviewFailure(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}

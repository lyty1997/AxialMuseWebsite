import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {
  assertNoAuthorTransactionResidue,
  formatAuthorTransactionStateError,
} from "../author/lib/transaction-state.mjs";
import {projectRoot} from "./lib/files.mjs";

const ROOT = projectRoot();

export function checkAuthorTransaction({root = ROOT} = {}) {
  assertNoAuthorTransactionResidue({root});
  return Object.freeze({ok: true});
}

function runCli() {
  try {
    checkAuthorTransaction();
    console.log("Author transaction residue checks passed.");
  } catch (error) {
    console.error(formatAuthorTransactionStateError(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}

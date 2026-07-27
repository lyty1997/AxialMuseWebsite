import {realpathSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {
  checkContentHistory,
  formatContentHistoryError,
} from "./lib/content-history.mjs";

async function main(arguments_ = process.argv.slice(2)) {
  try {
    const result = await checkContentHistory({arguments_});
    console.log(
      `Content history checks passed: commits=${result.commitCount}, articles=${result.articleCount}, registry-identities=${result.registryIdentityCount}.`,
    );
  } catch (error) {
    console.error(formatContentHistoryError(error));
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}

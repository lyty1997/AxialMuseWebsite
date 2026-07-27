import {realpathSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
  checkCiWorkflow,
  formatCiWorkflowError,
} from "./lib/ci-workflow.mjs";

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));

function main(arguments_ = process.argv.slice(2)) {
  try {
    if (!Array.isArray(arguments_) || arguments_.length !== 0) {
      throw new TypeError("CI workflow 入口不接受参数。");
    }
    const result = checkCiWorkflow(ROOT);
    console.log(
      `CI workflow contract passed: jobs=${result.jobCount}, pinned-actions=${result.actionCount}.`,
    );
  } catch (error) {
    console.error(formatCiWorkflowError(error));
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}

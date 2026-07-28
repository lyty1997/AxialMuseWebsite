import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {buildQualityChildEnvironment} from "../quality/lib/process-environment.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TEST_FILES = Object.freeze([
  "tests/build/article-date-edit.test.mjs",
  "tests/build/set-article-dates.test.mjs",
  "tests/build/set-article-dates.integration.test.mjs",
]);
const AUTOMATION_KEYS = Object.freeze([
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_JOB",
  "GITHUB_WORKFLOW",
  "RUNNER_OS",
]);

function fail(message, reportError) {
  reportError(`[AUTHOR_DATE_TEST] ${message}`);
  return 1;
}

export function runSetArticleDatesTests({
  arguments_ = process.argv.slice(2),
  environmentSource = process.env,
  nodeVersion = process.versions.node,
  platform = process.platform,
  reportError = console.error,
  reportSuccess = console.log,
  root = ROOT,
  spawnProcess = spawnSync,
} = {}) {
  if (!Array.isArray(arguments_) || arguments_.length !== 0) {
    return fail("作者日期验收入口不接受参数。", reportError);
  }
  try {
    if (
      environmentSource === null
      || typeof environmentSource !== "object"
      || AUTOMATION_KEYS.some((key) => (
        typeof environmentSource[key] === "string"
        && environmentSource[key] !== ""
        && environmentSource[key].toLowerCase() !== "false"
      ))
    ) {
      return fail("作者日期验收入口不得由自动化环境触发。", reportError);
    }
  } catch {
    return fail("作者日期验收入口不得由自动化环境触发。", reportError);
  }
  let expectedNode;
  try {
    expectedNode = readFileSync(resolve(root, ".nvmrc"), "utf8");
  } catch {
    return fail("无法读取作者日期验收所需的 .nvmrc。", reportError);
  }
  if (platform !== "linux" || expectedNode !== `${nodeVersion}\n`) {
    return fail(
      "作者日期验收只允许在 .nvmrc 精确 Linux 主端点运行。",
      reportError,
    );
  }
  const childEnvironment = buildQualityChildEnvironment(environmentSource);

  for (const sourcePath of TEST_FILES) {
    const result = spawnProcess(
      process.execPath,
      ["--test", resolve(root, sourcePath)],
      {
        cwd: root,
        env: childEnvironment,
        stdio: "inherit",
      },
    );
    if (
      result?.error
      || result?.status !== 0
      || (result?.signal !== null && result?.signal !== undefined)
    ) {
      return fail(`作者日期验收失败；source=${sourcePath}`, reportError);
    }
  }
  reportSuccess("Author set-article-dates tests passed.");
  return 0;
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = runSetArticleDatesTests();
}

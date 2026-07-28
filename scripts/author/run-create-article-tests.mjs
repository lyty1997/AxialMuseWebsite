import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {buildQualityChildEnvironment} from "../quality/lib/process-environment.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TEST_FILES = Object.freeze([
  "tests/build/create-article.test.mjs",
  "tests/build/create-article.integration.test.mjs",
]);

function fail(message, reportError) {
  reportError(`[AUTHOR_TEST] ${message}`);
  return 1;
}

export function runCreateArticleTests({
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
    return fail("作者命令验收入口不接受参数。", reportError);
  }
  let expectedNode;
  try {
    expectedNode = readFileSync(resolve(root, ".nvmrc"), "utf8");
  } catch {
    return fail("无法读取作者命令验收所需的 .nvmrc。", reportError);
  }
  if (platform !== "linux" || expectedNode !== `${nodeVersion}\n`) {
    return fail(
      "作者命令验收只允许在 .nvmrc 精确 Linux 主端点运行。",
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
      return fail(`作者命令验收失败；source=${sourcePath}`, reportError);
    }
  }
  reportSuccess("Author create-article tests passed.");
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runCreateArticleTests();
}

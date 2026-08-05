import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {
  createGitHubRequester,
  readBoundedEnvironment,
  readProductionDeployContext,
  readProductionDeployInputs,
} from "./dispatch-production.mjs";
import {formatProductionDeployError} from "./lib/production-deploy.mjs";
import {
  verifyProductionDeployIdentity,
} from "./lib/production-deploy-identity.mjs";

export async function runCheckProductionDeployIdentityCli({
  arguments_: arguments_ = process.argv.slice(2),
  environment = process.env,
  standardOutput = process.stdout,
  standardError = process.stderr,
  signal,
  requestGitHubJson,
  nowMilliseconds = Date.now(),
} = {}) {
  if (!Array.isArray(arguments_) || arguments_.length !== 0) {
    standardError.write(
      "[PRODUCTION_DEPLOY_ARGUMENTS] production deploy 身份检查不接受命令行参数。\n",
    );
    return 1;
  }
  try {
    const token = readBoundedEnvironment(
      environment,
      "AXIAL_GITHUB_TOKEN",
      {maximum: 16_384, minimum: 16, secret: true},
    );
    const identity = await verifyProductionDeployIdentity({
      nowMilliseconds,
      rawContext: readProductionDeployContext(environment),
      rawInputs: readProductionDeployInputs(environment),
      requestJson: requestGitHubJson
        ?? createGitHubRequester({signal, token}),
    });
    standardOutput.write(`${JSON.stringify({
      artifactId: identity.artifactId,
      commitSha: identity.commitSha,
      status: "verified",
      workflowRunId: identity.workflowRunId,
    })}\n`);
    return 0;
  } catch (error) {
    standardError.write(`${formatProductionDeployError(error)}\n`);
    return 1;
  }
}

async function runMain() {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    process.exitCode = await runCheckProductionDeployIdentityCli({
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await runMain();
}

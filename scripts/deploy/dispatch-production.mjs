import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {requestBoundedJson} from "./lib/bounded-json-http.mjs";
import {
  dispatchProductionDeployment,
  formatProductionDeployError,
  ProductionDeployError,
} from "./lib/production-deploy.mjs";
import {
  PRODUCTION_DEPLOY_REPOSITORY,
} from "./lib/production-deploy-identity.mjs";

export const GITHUB_API_HOSTNAME = "api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_MAX_RESPONSE_BYTES = 1024 * 1024;
const TAT_MAX_RESPONSE_BYTES = 64 * 1024;

export function readBoundedEnvironment(environment, name, {
  minimum = 1,
  maximum = 16_384,
  secret = false,
} = {}) {
  const value = environment[name];
  if (
    typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || /[\0\r\n]/u.test(value)
    || (secret && /[\x00-\x20\x7f]/u.test(value))
  ) {
    throw new ProductionDeployError(`PRODUCTION_DEPLOY_ENV_${name}`);
  }
  return value;
}

export function readProductionDeployInputs(environment) {
  return Object.freeze({
    artifactDigest: readBoundedEnvironment(
      environment,
      "AXIAL_ARTIFACT_DIGEST",
      {maximum: 64},
    ),
    artifactId: readBoundedEnvironment(
      environment,
      "AXIAL_ARTIFACT_ID",
      {maximum: 16},
    ),
    commitSha: readBoundedEnvironment(
      environment,
      "AXIAL_COMMIT_SHA",
      {maximum: 40},
    ),
    releaseContentSha256: readBoundedEnvironment(
      environment,
      "AXIAL_RELEASE_CONTENT_SHA256",
      {maximum: 64},
    ),
    repository: readBoundedEnvironment(
      environment,
      "AXIAL_REPOSITORY",
      {maximum: 128},
    ),
    runAttempt: readBoundedEnvironment(
      environment,
      "AXIAL_RUN_ATTEMPT",
      {maximum: 16},
    ),
    workflowRunId: readBoundedEnvironment(
      environment,
      "AXIAL_WORKFLOW_RUN_ID",
      {maximum: 16},
    ),
  });
}

export function readProductionDeployContext(environment) {
  return Object.freeze({
    eventName: readBoundedEnvironment(environment, "GITHUB_EVENT_NAME", {
      maximum: 32,
    }),
    ref: readBoundedEnvironment(environment, "GITHUB_REF", {maximum: 128}),
    repository: readBoundedEnvironment(
      environment,
      "GITHUB_REPOSITORY",
      {maximum: 128},
    ),
    runAttempt: readBoundedEnvironment(
      environment,
      "GITHUB_RUN_ATTEMPT",
      {maximum: 16},
    ),
    runId: readBoundedEnvironment(environment, "GITHUB_RUN_ID", {maximum: 16}),
    sha: readBoundedEnvironment(environment, "GITHUB_SHA", {maximum: 40}),
    workflow: readBoundedEnvironment(
      environment,
      "GITHUB_WORKFLOW",
      {maximum: 64},
    ),
  });
}

function readTatAccess(environment) {
  return Object.freeze({
    config: Object.freeze({
      commandId: readBoundedEnvironment(
        environment,
        "AXIAL_TAT_COMMAND_ID",
        {maximum: 68},
      ),
      instanceId: readBoundedEnvironment(
        environment,
        "AXIAL_TAT_INSTANCE_ID",
        {maximum: 70},
      ),
      region: readBoundedEnvironment(
        environment,
        "AXIAL_TAT_REGION",
        {maximum: 32},
      ),
    }),
    credentials: Object.freeze({
      secretId: readBoundedEnvironment(
        environment,
        "TENCENTCLOUD_SECRET_ID",
        {maximum: 256, minimum: 16, secret: true},
      ),
      secretKey: readBoundedEnvironment(
        environment,
        "TENCENTCLOUD_SECRET_KEY",
        {maximum: 256, minimum: 16, secret: true},
      ),
    }),
  });
}

export function createGitHubRequester({token, signal}) {
  return async (path) => {
    if (
      typeof path !== "string"
      || !path.startsWith(`/repos/${PRODUCTION_DEPLOY_REPOSITORY}/`)
    ) {
      throw new ProductionDeployError("PRODUCTION_DEPLOY_GITHUB_PATH");
    }
    return requestBoundedJson({
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "AxialMuseWebsite-production-deploy",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      hostname: GITHUB_API_HOSTNAME,
      maxResponseBytes: GITHUB_MAX_RESPONSE_BYTES,
      path,
      signal,
    });
  };
}

export async function runDispatchProductionCli({
  arguments_: arguments_ = process.argv.slice(2),
  environment = process.env,
  standardOutput = process.stdout,
  standardError = process.stderr,
  signal,
  requestGitHubJson,
  requestTatJson = requestBoundedJson,
  nowMilliseconds = Date.now(),
} = {}) {
  if (!Array.isArray(arguments_) || arguments_.length !== 0) {
    standardError.write(
      "[PRODUCTION_DEPLOY_ARGUMENTS] production deploy 不接受命令行参数。\n",
    );
    return 1;
  }
  try {
    const token = readBoundedEnvironment(
      environment,
      "AXIAL_GITHUB_TOKEN",
      {maximum: 16_384, minimum: 16, secret: true},
    );
    const result = await dispatchProductionDeployment({
      invokeTat: (request) => requestTatJson({
        ...request,
        maxResponseBytes: TAT_MAX_RESPONSE_BYTES,
        signal,
      }),
      loadTatAccess: () => readTatAccess(environment),
      nowMilliseconds,
      rawContext: readProductionDeployContext(environment),
      rawInputs: readProductionDeployInputs(environment),
      requestGitHubJson: requestGitHubJson
        ?? createGitHubRequester({signal, token}),
    });
    standardOutput.write(`${JSON.stringify(result)}\n`);
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
    process.exitCode = await runDispatchProductionCli({
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

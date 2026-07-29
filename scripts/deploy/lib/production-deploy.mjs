import {BoundedJsonHttpError} from "./bounded-json-http.mjs";
import {
  ProductionDeployIdentityError,
  verifyProductionDeployIdentity,
} from "./production-deploy-identity.mjs";
import {
  buildTatInvokeRequest,
  TencentTatError,
  validateTatInvokeResponse,
} from "./tencent-tat.mjs";

export class ProductionDeployError extends Error {
  constructor(code) {
    super("production deploy 编排失败。");
    this.name = "ProductionDeployError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: undefined,
      writable: false,
    });
  }
}

function fail(code) {
  throw new ProductionDeployError(code);
}

function isKnownError(error) {
  return (
    error instanceof ProductionDeployError
    || error instanceof ProductionDeployIdentityError
    || error instanceof TencentTatError
  );
}

export async function dispatchProductionDeployment({
  rawInputs,
  rawContext,
  requestGitHubJson,
  loadTatAccess,
  invokeTat,
  nowMilliseconds = Date.now(),
} = {}) {
  if (
    typeof loadTatAccess !== "function"
    || typeof invokeTat !== "function"
    || !Number.isSafeInteger(nowMilliseconds)
    || nowMilliseconds <= 0
  ) {
    fail("PRODUCTION_DEPLOY_OPTIONS");
  }
  const identity = await verifyProductionDeployIdentity({
    nowMilliseconds,
    rawContext,
    rawInputs,
    requestJson: requestGitHubJson,
  });

  let access;
  try {
    access = await loadTatAccess();
  } catch (error) {
    if (isKnownError(error)) throw error;
    fail("PRODUCTION_DEPLOY_TAT_ACCESS");
  }
  if (
    access === null
    || typeof access !== "object"
    || Array.isArray(access)
    || Object.keys(access).sort().join("\n") !== "config\ncredentials"
  ) {
    fail("PRODUCTION_DEPLOY_TAT_ACCESS");
  }

  const request = buildTatInvokeRequest({
    config: access.config,
    credentials: access.credentials,
    identity,
    timestampSeconds: Math.floor(nowMilliseconds / 1000),
  });
  let response;
  try {
    response = await invokeTat(request);
  } catch (error) {
    if (isKnownError(error)) throw error;
    if (error instanceof BoundedJsonHttpError) {
      fail(
        error.code === "HTTP_ABORTED"
          ? "PRODUCTION_DEPLOY_INTERRUPTED"
          : "PRODUCTION_DEPLOY_TAT_TRANSPORT",
      );
    }
    fail("PRODUCTION_DEPLOY_TAT_TRANSPORT");
  }
  if (
    response === null
    || typeof response !== "object"
    || Array.isArray(response)
    || response.statusCode !== 200
    || !Object.hasOwn(response, "value")
  ) {
    fail("PRODUCTION_DEPLOY_TAT_HTTP");
  }
  const invocation = validateTatInvokeResponse(response.value);
  return Object.freeze({
    artifactId: identity.artifactId,
    commitSha: identity.commitSha,
    invocationId: invocation.invocationId,
    requestId: invocation.requestId,
    status: "dispatched",
    workflowRunId: identity.workflowRunId,
  });
}

export function formatProductionDeployError(error) {
  const code = (
    error instanceof ProductionDeployError
    || error instanceof ProductionDeployIdentityError
    || error instanceof TencentTatError
  )
    ? error.code
    : "PRODUCTION_DEPLOY_INTERNAL";
  const context = error instanceof TencentTatError
    ? error.safeContext
    : undefined;
  const suffix = context !== undefined && Object.keys(context).length > 0
    ? ` (${Object.entries(context)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")})`
    : "";
  return `[${code}] production deploy 已失败关闭${suffix}。`;
}

export const PRODUCTION_DEPLOY_REPOSITORY = "lyty1997/AxialMuseWebsite";
export const PRODUCTION_DEPLOY_BRANCH = "main";
export const PRODUCTION_DEPLOY_REF = "refs/heads/main";
export const PRODUCTION_DEPLOY_WORKFLOW = "CI";
export const PRODUCTION_DEPLOY_WORKFLOW_PATH = ".github/workflows/ci.yml";

const INPUT_KEYS = Object.freeze([
  "artifactDigest",
  "artifactId",
  "commitSha",
  "releaseContentSha256",
  "repository",
  "runAttempt",
  "workflowRunId",
]);
const CONTEXT_KEYS = Object.freeze([
  "eventName",
  "ref",
  "repository",
  "runAttempt",
  "runId",
  "sha",
  "workflow",
]);
const LOWER_SHA256 = /^[0-9a-f]{64}$/u;
const LOWER_COMMIT_SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const API_TIMESTAMP = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/u;
const MAX_CLOCK_SKEW_MILLISECONDS = 5 * 60 * 1000;

export class ProductionDeployIdentityError extends Error {
  constructor(code) {
    super("production deploy 身份核验失败。");
    this.name = "ProductionDeployIdentityError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: undefined,
      writable: false,
    });
  }
}

function fail(code) {
  throw new ProductionDeployIdentityError(code);
}

function isPlainObject(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  return Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

function parsePositiveDecimal(value, code) {
  if (
    typeof value !== "string"
    || !POSITIVE_DECIMAL.test(value)
    || value.length > 16
  ) {
    fail(code);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || String(number) !== value) {
    fail(code);
  }
  return Object.freeze({number, value});
}

function assertApiPositiveInteger(value, expected, code) {
  if (
    !Number.isSafeInteger(value)
    || value <= 0
    || value !== expected.number
  ) {
    fail(code);
  }
}

function parseApiTimestamp(value, code) {
  if (typeof value !== "string" || API_TIMESTAMP.exec(value) === null) {
    fail(code);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString().replace(".000Z", "Z") !== value
  ) {
    fail(code);
  }
  return milliseconds;
}

function assertRepository(value, code) {
  if (
    !isPlainObject(value)
    || value.full_name !== PRODUCTION_DEPLOY_REPOSITORY
    || !Number.isSafeInteger(value.id)
    || value.id <= 0
  ) {
    fail(code);
  }
  return value.id;
}

export function parseProductionDeployInputs(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, INPUT_KEYS)) {
    fail("PRODUCTION_DEPLOY_INPUT");
  }
  if (
    typeof value.commitSha !== "string"
    || !LOWER_COMMIT_SHA.test(value.commitSha)
    || typeof value.artifactDigest !== "string"
    || !LOWER_SHA256.test(value.artifactDigest)
    || typeof value.releaseContentSha256 !== "string"
    || !LOWER_SHA256.test(value.releaseContentSha256)
    || value.repository !== PRODUCTION_DEPLOY_REPOSITORY
  ) {
    fail("PRODUCTION_DEPLOY_INPUT_IDENTITY");
  }
  const workflowRunId = parsePositiveDecimal(
    value.workflowRunId,
    "PRODUCTION_DEPLOY_INPUT_IDENTITY",
  );
  const artifactId = parsePositiveDecimal(
    value.artifactId,
    "PRODUCTION_DEPLOY_INPUT_IDENTITY",
  );
  const runAttempt = parsePositiveDecimal(
    value.runAttempt,
    "PRODUCTION_DEPLOY_INPUT_IDENTITY",
  );
  return Object.freeze({
    artifactDigest: value.artifactDigest,
    artifactId: artifactId.value,
    artifactIdNumber: artifactId.number,
    commitSha: value.commitSha,
    releaseContentSha256: value.releaseContentSha256,
    repository: value.repository,
    runAttempt: runAttempt.value,
    runAttemptNumber: runAttempt.number,
    workflowRunId: workflowRunId.value,
    workflowRunIdNumber: workflowRunId.number,
  });
}

export function parseProductionDeployContext(value, inputs) {
  if (
    !isPlainObject(value)
    || !hasExactKeys(value, CONTEXT_KEYS)
    || value.repository !== PRODUCTION_DEPLOY_REPOSITORY
    || value.eventName !== "push"
    || value.ref !== PRODUCTION_DEPLOY_REF
    || value.workflow !== PRODUCTION_DEPLOY_WORKFLOW
    || value.sha !== inputs.commitSha
    || value.repository !== inputs.repository
  ) {
    fail("PRODUCTION_DEPLOY_CONTEXT");
  }
  const runId = parsePositiveDecimal(value.runId, "PRODUCTION_DEPLOY_CONTEXT");
  const runAttempt = parsePositiveDecimal(
    value.runAttempt,
    "PRODUCTION_DEPLOY_CONTEXT",
  );
  if (runId.value !== inputs.workflowRunId) {
    fail("PRODUCTION_DEPLOY_CONTEXT");
  }
  if (runAttempt.value !== inputs.runAttempt) {
    fail("PRODUCTION_DEPLOY_CONTEXT");
  }
  return Object.freeze({
    eventName: value.eventName,
    ref: value.ref,
    repository: value.repository,
    runAttempt: runAttempt.value,
    runAttemptNumber: runAttempt.number,
    runId: runId.value,
    runIdNumber: runId.number,
    sha: value.sha,
    workflow: value.workflow,
  });
}

export function assertProductionMainResponse(value, commitSha) {
  if (
    !isPlainObject(value)
    || value.name !== PRODUCTION_DEPLOY_BRANCH
    || !isPlainObject(value.commit)
    || typeof value.commit.sha !== "string"
    || !LOWER_COMMIT_SHA.test(value.commit.sha)
  ) {
    fail("PRODUCTION_DEPLOY_MAIN_RESPONSE");
  }
  if (value.commit.sha !== commitSha) {
    fail("PRODUCTION_DEPLOY_MAIN_STALE");
  }
}

export function assertProductionRunResponse(value, inputs, context) {
  if (!isPlainObject(value)) fail("PRODUCTION_DEPLOY_RUN_RESPONSE");
  const repositoryId = assertRepository(
    value.repository,
    "PRODUCTION_DEPLOY_RUN_REPOSITORY",
  );
  const headRepositoryId = assertRepository(
    value.head_repository,
    "PRODUCTION_DEPLOY_RUN_REPOSITORY",
  );
  assertApiPositiveInteger(
    value.id,
    {number: inputs.workflowRunIdNumber},
    "PRODUCTION_DEPLOY_RUN_IDENTITY",
  );
  if (
    repositoryId !== headRepositoryId
    || value.run_attempt !== context.runAttemptNumber
    || value.name !== PRODUCTION_DEPLOY_WORKFLOW
    || value.path !== PRODUCTION_DEPLOY_WORKFLOW_PATH
    || value.event !== "push"
    || value.head_branch !== PRODUCTION_DEPLOY_BRANCH
    || value.head_sha !== inputs.commitSha
    || value.status !== "in_progress"
    || value.conclusion !== null
  ) {
    fail("PRODUCTION_DEPLOY_RUN_IDENTITY");
  }
  return Object.freeze({headRepositoryId, repositoryId});
}

export function assertProductionArtifactResponse(
  value,
  inputs,
  context,
  runIdentity,
  nowMilliseconds,
) {
  if (!isPlainObject(value) || !isPlainObject(value.workflow_run)) {
    fail("PRODUCTION_DEPLOY_ARTIFACT_RESPONSE");
  }
  assertApiPositiveInteger(
    value.id,
    {number: inputs.artifactIdNumber},
    "PRODUCTION_DEPLOY_ARTIFACT_IDENTITY",
  );
  const expectedName = `axial-muse-site-${inputs.commitSha}-${inputs.workflowRunId}-${context.runAttempt}`;
  if (
    value.name !== expectedName
    || !Number.isSafeInteger(value.size_in_bytes)
    || value.size_in_bytes <= 0
    || value.expired !== false
    || value.workflow_run.id !== inputs.workflowRunIdNumber
    || value.workflow_run.repository_id !== runIdentity.repositoryId
    || value.workflow_run.head_repository_id !== runIdentity.headRepositoryId
    || value.workflow_run.head_branch !== PRODUCTION_DEPLOY_BRANCH
    || value.workflow_run.head_sha !== inputs.commitSha
  ) {
    fail("PRODUCTION_DEPLOY_ARTIFACT_IDENTITY");
  }
  if (value.digest !== `sha256:${inputs.artifactDigest}`) {
    fail("PRODUCTION_DEPLOY_ARTIFACT_DIGEST");
  }
  const createdAt = parseApiTimestamp(
    value.created_at,
    "PRODUCTION_DEPLOY_ARTIFACT_TIME",
  );
  const expiresAt = parseApiTimestamp(
    value.expires_at,
    "PRODUCTION_DEPLOY_ARTIFACT_TIME",
  );
  if (
    !Number.isSafeInteger(nowMilliseconds)
    || createdAt > nowMilliseconds + MAX_CLOCK_SKEW_MILLISECONDS
    || expiresAt <= nowMilliseconds
    || expiresAt <= createdAt
  ) {
    fail("PRODUCTION_DEPLOY_ARTIFACT_EXPIRED");
  }
  return Object.freeze({
    artifactName: expectedName,
    createdAt: value.created_at,
    expiresAt: value.expires_at,
    sizeInBytes: value.size_in_bytes,
  });
}

async function requestIdentityResource(requestJson, path, responseCode) {
  let response;
  try {
    response = await requestJson(path);
  } catch (error) {
    if (error instanceof ProductionDeployIdentityError) throw error;
    if (error?.code === "HTTP_ABORTED") {
      fail("PRODUCTION_DEPLOY_INTERRUPTED");
    }
    fail("PRODUCTION_DEPLOY_GITHUB_API");
  }
  if (
    !isPlainObject(response)
    || response.statusCode !== 200
    || !Object.hasOwn(response, "value")
  ) {
    fail(responseCode);
  }
  return response.value;
}

export async function verifyProductionDeployIdentity({
  rawInputs,
  rawContext,
  requestJson,
  nowMilliseconds = Date.now(),
} = {}) {
  if (typeof requestJson !== "function") fail("PRODUCTION_DEPLOY_GITHUB_API");
  const inputs = parseProductionDeployInputs(rawInputs);
  const context = parseProductionDeployContext(rawContext, inputs);
  const mainPath = `/repos/${PRODUCTION_DEPLOY_REPOSITORY}/branches/${PRODUCTION_DEPLOY_BRANCH}`;
  const runPath = `/repos/${PRODUCTION_DEPLOY_REPOSITORY}/actions/runs/${inputs.workflowRunId}`;
  const artifactPath = `/repos/${PRODUCTION_DEPLOY_REPOSITORY}/actions/artifacts/${inputs.artifactId}`;

  assertProductionMainResponse(
    await requestIdentityResource(
      requestJson,
      mainPath,
      "PRODUCTION_DEPLOY_MAIN_RESPONSE",
    ),
    inputs.commitSha,
  );
  const runIdentity = assertProductionRunResponse(
    await requestIdentityResource(
      requestJson,
      runPath,
      "PRODUCTION_DEPLOY_RUN_RESPONSE",
    ),
    inputs,
    context,
  );
  const artifact = assertProductionArtifactResponse(
    await requestIdentityResource(
      requestJson,
      artifactPath,
      "PRODUCTION_DEPLOY_ARTIFACT_RESPONSE",
    ),
    inputs,
    context,
    runIdentity,
    nowMilliseconds,
  );
  assertProductionMainResponse(
    await requestIdentityResource(
      requestJson,
      mainPath,
      "PRODUCTION_DEPLOY_MAIN_RESPONSE",
    ),
    inputs.commitSha,
  );

  return Object.freeze({
    artifactDigest: inputs.artifactDigest,
    artifactId: inputs.artifactId,
    artifactName: artifact.artifactName,
    commitSha: inputs.commitSha,
    releaseContentSha256: inputs.releaseContentSha256,
    repository: context.repository,
    runAttempt: inputs.runAttempt,
    workflowRunId: inputs.workflowRunId,
  });
}

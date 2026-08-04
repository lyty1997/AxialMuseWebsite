import assert from "node:assert/strict";
import test from "node:test";
import {
  runCheckProductionDeployIdentityCli,
} from "../../scripts/deploy/check-production-deploy-identity.mjs";
import {
  runDispatchProductionCli,
} from "../../scripts/deploy/dispatch-production.mjs";
import {
  dispatchProductionDeployment,
  formatProductionDeployError,
  ProductionDeployError,
} from "../../scripts/deploy/lib/production-deploy.mjs";

const NOW = Date.parse("2026-07-29T12:00:00Z");
const INPUTS = Object.freeze({
  artifactDigest: "a".repeat(64),
  artifactId: "123456789",
  commitSha: "c".repeat(40),
  releaseContentSha256: "b".repeat(64),
  repository: "lyty1997/AxialMuseWebsite",
  runAttempt: "1",
  workflowRunId: "29913247834",
});
const CONTEXT = Object.freeze({
  eventName: "push",
  ref: "refs/heads/main",
  repository: INPUTS.repository,
  runAttempt: INPUTS.runAttempt,
  runId: INPUTS.workflowRunId,
  sha: INPUTS.commitSha,
  workflow: "CI",
});
const ACCESS = Object.freeze({
  config: Object.freeze({
    commandId: "cmd-abcdefgh",
    instanceId: "lhins-abcdefgh",
    region: "ap-shanghai",
  }),
  credentials: Object.freeze({
    secretId: "AKIDEXAMPLE00000000",
    secretKey: "exampleSecretKey0000000000000000",
  }),
});

function dispatchEnvironment() {
  return {
    AXIAL_ARTIFACT_DIGEST: INPUTS.artifactDigest,
    AXIAL_ARTIFACT_ID: INPUTS.artifactId,
    AXIAL_COMMIT_SHA: INPUTS.commitSha,
    AXIAL_GITHUB_TOKEN: "github-token-example-0000000000",
    AXIAL_RELEASE_CONTENT_SHA256: INPUTS.releaseContentSha256,
    AXIAL_REPOSITORY: INPUTS.repository,
    AXIAL_RUN_ATTEMPT: INPUTS.runAttempt,
    AXIAL_TAT_COMMAND_ID: ACCESS.config.commandId,
    AXIAL_TAT_INSTANCE_ID: ACCESS.config.instanceId,
    AXIAL_TAT_REGION: ACCESS.config.region,
    AXIAL_WORKFLOW_RUN_ID: INPUTS.workflowRunId,
    GITHUB_EVENT_NAME: CONTEXT.eventName,
    GITHUB_REF: CONTEXT.ref,
    GITHUB_REPOSITORY: CONTEXT.repository,
    GITHUB_RUN_ATTEMPT: CONTEXT.runAttempt,
    GITHUB_RUN_ID: CONTEXT.runId,
    GITHUB_SHA: CONTEXT.sha,
    GITHUB_WORKFLOW: CONTEXT.workflow,
    TENCENTCLOUD_SECRET_ID: ACCESS.credentials.secretId,
    TENCENTCLOUD_SECRET_KEY: ACCESS.credentials.secretKey,
  };
}

function branch(sha = INPUTS.commitSha) {
  return {commit: {sha}, name: "main"};
}

function run() {
  return {
    conclusion: null,
    event: "push",
    head_branch: "main",
    head_repository: {
      full_name: CONTEXT.repository,
      id: 998877,
    },
    head_sha: INPUTS.commitSha,
    id: Number(INPUTS.workflowRunId),
    name: "CI",
    path: ".github/workflows/ci.yml",
    repository: {
      full_name: CONTEXT.repository,
      id: 998877,
    },
    run_attempt: 1,
    status: "in_progress",
  };
}

function artifact() {
  return {
    created_at: "2026-07-29T11:00:00Z",
    digest: `sha256:${INPUTS.artifactDigest}`,
    expired: false,
    expires_at: "2026-08-28T11:00:00Z",
    id: Number(INPUTS.artifactId),
    name: `axial-muse-site-${INPUTS.commitSha}-${INPUTS.workflowRunId}-1`,
    size_in_bytes: 123_456,
    workflow_run: {
      head_branch: "main",
      head_repository_id: 998877,
      head_sha: INPUTS.commitSha,
      id: Number(INPUTS.workflowRunId),
      repository_id: 998877,
    },
  };
}

function createGitHubRequester({
  firstBranch = branch(),
  workflowRun = run(),
  artifactValue = artifact(),
  finalBranch = branch(),
} = {}) {
  const values = [
    {statusCode: 200, value: firstBranch},
    {statusCode: 200, value: workflowRun},
    {statusCode: 200, value: artifactValue},
    {statusCode: 200, value: finalBranch},
  ];
  let index = 0;
  return async () => {
    const value = values[index];
    index += 1;
    return value;
  };
}

test("#34 dispatches exactly once only after the complete identity check", async () => {
  const events = [];
  let capturedRequest;
  const requestGitHub = createGitHubRequester();
  const result = await dispatchProductionDeployment({
    invokeTat: async (request) => {
      events.push("invoke");
      capturedRequest = request;
      return {
        statusCode: 200,
        value: {
          Response: {
            InvocationId: "inv-8xgjrytm",
            RequestId: "41417f50-51b5-4c8d-85b7-f6c508cb228f",
          },
        },
      };
    },
    loadTatAccess: () => {
      events.push("credentials");
      return ACCESS;
    },
    nowMilliseconds: NOW,
    rawContext: {...CONTEXT},
    rawInputs: {...INPUTS},
    requestGitHubJson: async (path) => {
      events.push(path);
      return requestGitHub(path);
    },
  });
  assert.deepEqual(result, {
    artifactId: INPUTS.artifactId,
    commitSha: INPUTS.commitSha,
    invocationId: "inv-8xgjrytm",
    requestId: "41417f50-51b5-4c8d-85b7-f6c508cb228f",
    status: "dispatched",
    workflowRunId: INPUTS.workflowRunId,
  });
  assert.deepEqual(events.slice(-2), ["credentials", "invoke"]);
  assert.equal(events.filter((event) => event === "credentials").length, 1);
  assert.equal(events.filter((event) => event === "invoke").length, 1);
  assert.equal(capturedRequest.headers["X-TC-Action"], "InvokeCommand");
});

test("#34 main movement stops before credentials and TAT transport", async () => {
  let credentialCalls = 0;
  let tatCalls = 0;
  await assert.rejects(
    () => dispatchProductionDeployment({
      invokeTat: async () => {
        tatCalls += 1;
      },
      loadTatAccess: () => {
        credentialCalls += 1;
        return ACCESS;
      },
      nowMilliseconds: NOW,
      rawContext: {...CONTEXT},
      rawInputs: {...INPUTS},
      requestGitHubJson: createGitHubRequester({
        finalBranch: branch("d".repeat(40)),
      }),
    }),
    (error) => error.code === "PRODUCTION_DEPLOY_MAIN_STALE",
  );
  assert.equal(credentialCalls, 0);
  assert.equal(tatCalls, 0);
});

test("#34 malformed artifact stops before credentials and TAT transport", async () => {
  let credentialCalls = 0;
  let tatCalls = 0;
  const malformed = artifact();
  malformed.digest = `sha512:${INPUTS.artifactDigest}`;
  await assert.rejects(
    () => dispatchProductionDeployment({
      invokeTat: async () => {
        tatCalls += 1;
      },
      loadTatAccess: () => {
        credentialCalls += 1;
        return ACCESS;
      },
      nowMilliseconds: NOW,
      rawContext: {...CONTEXT},
      rawInputs: {...INPUTS},
      requestGitHubJson: createGitHubRequester({artifactValue: malformed}),
    }),
    (error) => error.code === "PRODUCTION_DEPLOY_ARTIFACT_DIGEST",
  );
  assert.equal(credentialCalls, 0);
  assert.equal(tatCalls, 0);
});

test("#34 never retries an ambiguous TAT transport failure", async () => {
  let calls = 0;
  await assert.rejects(
    () => dispatchProductionDeployment({
      invokeTat: async () => {
        calls += 1;
        throw new Error("outcome unknown");
      },
      loadTatAccess: () => ACCESS,
      nowMilliseconds: NOW,
      rawContext: {...CONTEXT},
      rawInputs: {...INPUTS},
      requestGitHubJson: createGitHubRequester(),
    }),
    (error) => (
      error instanceof ProductionDeployError
      && error.code === "PRODUCTION_DEPLOY_TAT_TRANSPORT"
    ),
  );
  assert.equal(calls, 1);
});

test("#34 diagnostics do not render remote messages or unexpected errors", () => {
  const unexpected = new Error(
    "SecretKey=not-for-output Authorization=not-for-output",
  );
  assert.equal(
    formatProductionDeployError(unexpected),
    "[PRODUCTION_DEPLOY_INTERNAL] production deploy 已失败关闭。",
  );
  assert.equal(
    formatProductionDeployError(
      new ProductionDeployError("PRODUCTION_DEPLOY_TAT_TRANSPORT"),
    ),
    "[PRODUCTION_DEPLOY_TAT_TRANSPORT] production deploy 已失败关闭。",
  );
});

test("#34 complete dispatch CLI maps the closed environment and signal once", async () => {
  const controller = new AbortController();
  const output = [];
  const errors = [];
  let tatCalls = 0;
  let tatOptions;
  const status = await runDispatchProductionCli({
    arguments_: [],
    environment: dispatchEnvironment(),
    nowMilliseconds: NOW,
    requestGitHubJson: createGitHubRequester(),
    requestTatJson: async (options) => {
      tatCalls += 1;
      tatOptions = options;
      return {
        statusCode: 200,
        value: {
          Response: {
            InvocationId: "inv-8xgjrytm",
            RequestId: "41417f50-51b5-4c8d-85b7-f6c508cb228f",
          },
        },
      };
    },
    signal: controller.signal,
    standardError: {write(value) { errors.push(value); }},
    standardOutput: {write(value) { output.push(value); }},
  });
  assert.equal(status, 0, errors.join(""));
  assert.deepEqual(errors, []);
  assert.equal(tatCalls, 1);
  assert.equal(tatOptions.signal, controller.signal);
  assert.equal(tatOptions.maxResponseBytes, 64 * 1024);
  assert.equal(tatOptions.hostname, "tat.tencentcloudapi.com");
  assert.equal(tatOptions.headers["X-TC-Region"], ACCESS.config.region);
  assert.equal(
    tatOptions.headers.Authorization.includes(
      `Credential=${ACCESS.credentials.secretId}/`,
    ),
    true,
  );
  assert.deepEqual(JSON.parse(tatOptions.body), {
    CommandId: ACCESS.config.commandId,
    InstanceIds: [ACCESS.config.instanceId],
    Parameters: JSON.stringify({
      workflowRunId: INPUTS.workflowRunId,
      artifactId: INPUTS.artifactId,
      commitSha: INPUTS.commitSha,
      artifactDigest: INPUTS.artifactDigest,
      releaseContentSha256: INPUTS.releaseContentSha256,
    }),
  });
  assert.deepEqual(JSON.parse(output.join("")), {
    artifactId: INPUTS.artifactId,
    commitSha: INPUTS.commitSha,
    invocationId: "inv-8xgjrytm",
    requestId: "41417f50-51b5-4c8d-85b7-f6c508cb228f",
    status: "dispatched",
    workflowRunId: INPUTS.workflowRunId,
  });
});

test("#34 complete dispatch CLI keeps TAT access lazy after stale identity", async () => {
  const accessed = [];
  const environment = new Proxy(dispatchEnvironment(), {
    get(target, property) {
      accessed.push(property);
      if (
        property === "TENCENTCLOUD_SECRET_ID"
        || property === "TENCENTCLOUD_SECRET_KEY"
        || property === "AXIAL_TAT_COMMAND_ID"
        || property === "AXIAL_TAT_INSTANCE_ID"
        || property === "AXIAL_TAT_REGION"
      ) {
        throw new Error("stale dispatch touched TAT access");
      }
      return Reflect.get(target, property);
    },
  });
  const output = [];
  const errors = [];
  let tatCalls = 0;
  const status = await runDispatchProductionCli({
    arguments_: [],
    environment,
    nowMilliseconds: NOW,
    requestGitHubJson: createGitHubRequester({
      finalBranch: branch("d".repeat(40)),
    }),
    requestTatJson: async () => {
      tatCalls += 1;
    },
    standardError: {write(value) { errors.push(value); }},
    standardOutput: {write(value) { output.push(value); }},
  });
  assert.equal(status, 1);
  assert.deepEqual(output, []);
  assert.deepEqual(errors, [
    "[PRODUCTION_DEPLOY_MAIN_STALE] production deploy 已失败关闭。\n",
  ]);
  assert.equal(tatCalls, 0);
  assert.equal(
    accessed.some((property) => String(property).includes("TAT")
      || String(property).includes("TENCENT")),
    false,
  );
});

test("#34 complete dispatch CLI does not retry or expose TAT transport errors", async () => {
  const output = [];
  const errors = [];
  let tatCalls = 0;
  const status = await runDispatchProductionCli({
    arguments_: [],
    environment: dispatchEnvironment(),
    nowMilliseconds: NOW,
    requestGitHubJson: createGitHubRequester(),
    requestTatJson: async () => {
      tatCalls += 1;
      throw new Error(
        "SecretKey=not-for-output Authorization=not-for-output",
      );
    },
    standardError: {write(value) { errors.push(value); }},
    standardOutput: {write(value) { output.push(value); }},
  });
  assert.equal(status, 1);
  assert.equal(tatCalls, 1);
  assert.deepEqual(output, []);
  assert.deepEqual(errors, [
    "[PRODUCTION_DEPLOY_TAT_TRANSPORT] production deploy 已失败关闭。\n",
  ]);
});

test("#34 preliminary workflow step verifies identity without reading CAM/TAT fields", async () => {
  const accessed = [];
  const environmentValues = dispatchEnvironment();
  delete environmentValues.AXIAL_TAT_COMMAND_ID;
  delete environmentValues.AXIAL_TAT_INSTANCE_ID;
  delete environmentValues.AXIAL_TAT_REGION;
  delete environmentValues.TENCENTCLOUD_SECRET_ID;
  delete environmentValues.TENCENTCLOUD_SECRET_KEY;
  const environment = new Proxy(environmentValues, {
    get(target, property) {
      accessed.push(property);
      if (
        property === "TENCENTCLOUD_SECRET_ID"
        || property === "TENCENTCLOUD_SECRET_KEY"
        || property === "AXIAL_TAT_COMMAND_ID"
        || property === "AXIAL_TAT_INSTANCE_ID"
        || property === "AXIAL_TAT_REGION"
      ) {
        throw new Error("pre-secret step touched TAT access");
      }
      return Reflect.get(target, property);
    },
  });
  const output = [];
  const errors = [];
  const status = await runCheckProductionDeployIdentityCli({
    arguments_: [],
    environment,
    nowMilliseconds: NOW,
    requestGitHubJson: createGitHubRequester(),
    standardError: {write(value) { errors.push(value); }},
    standardOutput: {write(value) { output.push(value); }},
  });
  assert.equal(status, 0, errors.join(""));
  assert.deepEqual(errors, []);
  assert.deepEqual(JSON.parse(output.join("")), {
    artifactId: INPUTS.artifactId,
    commitSha: INPUTS.commitSha,
    status: "verified",
    workflowRunId: INPUTS.workflowRunId,
  });
  assert.equal(
    accessed.some((property) => String(property).includes("TAT")
      || String(property).includes("TENCENT")),
    false,
  );
});

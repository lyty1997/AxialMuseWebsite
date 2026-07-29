import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProductionDeployContext,
  parseProductionDeployInputs,
  ProductionDeployIdentityError,
  verifyProductionDeployIdentity,
} from "../../scripts/deploy/lib/production-deploy-identity.mjs";

const NOW = Date.parse("2026-07-29T12:00:00Z");
const VALID_INPUTS = Object.freeze({
  artifactDigest: "a".repeat(64),
  artifactId: "123456789",
  commitSha: "c".repeat(40),
  releaseContentSha256: "b".repeat(64),
  repository: "lyty1997/AxialMuseWebsite",
  runAttempt: "1",
  workflowRunId: "29913247834",
});
const VALID_CONTEXT = Object.freeze({
  eventName: "push",
  ref: "refs/heads/main",
  repository: VALID_INPUTS.repository,
  runAttempt: VALID_INPUTS.runAttempt,
  runId: VALID_INPUTS.workflowRunId,
  sha: VALID_INPUTS.commitSha,
  workflow: "CI",
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function branch(sha = VALID_INPUTS.commitSha) {
  return {
    commit: {sha},
    name: "main",
    protected: true,
  };
}

function workflowRun() {
  return {
    conclusion: null,
    event: "push",
    head_branch: "main",
    head_repository: {
      full_name: VALID_CONTEXT.repository,
      id: 998877,
    },
    head_sha: VALID_INPUTS.commitSha,
    id: Number(VALID_INPUTS.workflowRunId),
    name: "CI",
    path: ".github/workflows/ci.yml",
    repository: {
      full_name: VALID_CONTEXT.repository,
      id: 998877,
    },
    run_attempt: 1,
    status: "in_progress",
  };
}

function artifact() {
  return {
    created_at: "2026-07-29T11:00:00Z",
    digest: `sha256:${VALID_INPUTS.artifactDigest}`,
    expired: false,
    expires_at: "2026-08-28T11:00:00Z",
    id: Number(VALID_INPUTS.artifactId),
    name: `axial-muse-site-${VALID_INPUTS.commitSha}-${VALID_INPUTS.workflowRunId}-1`,
    size_in_bytes: 123_456,
    workflow_run: {
      head_branch: "main",
      head_repository_id: 998877,
      head_sha: VALID_INPUTS.commitSha,
      id: Number(VALID_INPUTS.workflowRunId),
      repository_id: 998877,
    },
  };
}

function response(value, statusCode = 200) {
  return Object.freeze({statusCode, value});
}

function createRequester(values, calls = []) {
  let index = 0;
  return async (path) => {
    calls.push(path);
    const value = values[index];
    index += 1;
    if (value instanceof Error) throw value;
    return value;
  };
}

function validResponses({
  firstBranch = branch(),
  run = workflowRun(),
  artifactValue = artifact(),
  finalBranch = branch(),
} = {}) {
  return [
    response(firstBranch),
    response(run),
    response(artifactValue),
    response(finalBranch),
  ];
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => (
    error instanceof ProductionDeployIdentityError
    && error.code === code
    && error.stack === undefined
  ));
}

async function expectRejectCode(callback, code) {
  await assert.rejects(callback, (error) => (
    error instanceof ProductionDeployIdentityError
    && error.code === code
    && error.stack === undefined
  ));
}

test("#34 accepts seven canonical producer outputs and canonical run context", () => {
  const inputs = parseProductionDeployInputs({...VALID_INPUTS});
  assert.equal(inputs.workflowRunIdNumber, Number(VALID_INPUTS.workflowRunId));
  assert.equal(inputs.artifactIdNumber, Number(VALID_INPUTS.artifactId));
  const context = parseProductionDeployContext({...VALID_CONTEXT}, inputs);
  assert.equal(context.runAttemptNumber, 1);

  for (const invalid of [
    {...VALID_INPUTS, extra: "forged"},
    (() => {
      const value = {...VALID_INPUTS};
      delete value.artifactId;
      return value;
    })(),
    {...VALID_INPUTS, artifactId: "01"},
    {...VALID_INPUTS, artifactId: "0"},
    {...VALID_INPUTS, workflowRunId: "-1"},
    {...VALID_INPUTS, commitSha: "C".repeat(40)},
    {...VALID_INPUTS, artifactDigest: `sha256:${"a".repeat(64)}`},
    {...VALID_INPUTS, artifactDigest: "A".repeat(64)},
    {...VALID_INPUTS, releaseContentSha256: "b".repeat(63)},
    {...VALID_INPUTS, repository: "attacker/fork"},
    {...VALID_INPUTS, runAttempt: "01"},
  ]) {
    expectCode(
      () => parseProductionDeployInputs(invalid),
      Object.hasOwn(invalid, "extra") || !Object.hasOwn(invalid, "artifactId")
        ? "PRODUCTION_DEPLOY_INPUT"
        : "PRODUCTION_DEPLOY_INPUT_IDENTITY",
    );
  }

  for (const invalid of [
    {...VALID_CONTEXT, repository: "attacker/fork"},
    {...VALID_CONTEXT, eventName: "workflow_dispatch"},
    {...VALID_CONTEXT, ref: "refs/heads/dev"},
    {...VALID_CONTEXT, sha: "d".repeat(40)},
    {...VALID_CONTEXT, runId: "29913247835"},
    {...VALID_CONTEXT, runAttempt: "01"},
    {...VALID_CONTEXT, workflow: "Deploy"},
    {...VALID_CONTEXT, extra: "forged"},
  ]) {
    expectCode(
      () => parseProductionDeployContext(invalid, inputs),
      "PRODUCTION_DEPLOY_CONTEXT",
    );
  }
});

test("#34 verifies main, exact run, exact artifact ID and rechecks main", async () => {
  const calls = [];
  const identity = await verifyProductionDeployIdentity({
    nowMilliseconds: NOW,
    rawContext: {...VALID_CONTEXT},
    rawInputs: {...VALID_INPUTS},
    requestJson: createRequester(validResponses(), calls),
  });
  assert.deepEqual(identity, {
    artifactDigest: VALID_INPUTS.artifactDigest,
    artifactId: VALID_INPUTS.artifactId,
    artifactName: `axial-muse-site-${VALID_INPUTS.commitSha}-${VALID_INPUTS.workflowRunId}-1`,
    commitSha: VALID_INPUTS.commitSha,
    releaseContentSha256: VALID_INPUTS.releaseContentSha256,
    repository: VALID_CONTEXT.repository,
    runAttempt: VALID_INPUTS.runAttempt,
    workflowRunId: VALID_INPUTS.workflowRunId,
  });
  assert.deepEqual(calls, [
    "/repos/lyty1997/AxialMuseWebsite/branches/main",
    `/repos/lyty1997/AxialMuseWebsite/actions/runs/${VALID_INPUTS.workflowRunId}`,
    `/repos/lyty1997/AxialMuseWebsite/actions/artifacts/${VALID_INPUTS.artifactId}`,
    "/repos/lyty1997/AxialMuseWebsite/branches/main",
  ]);
});

test("#34 rejects main movement before or during identity verification", async () => {
  await expectRejectCode(
    () => verifyProductionDeployIdentity({
      nowMilliseconds: NOW,
      rawContext: {...VALID_CONTEXT},
      rawInputs: {...VALID_INPUTS},
      requestJson: createRequester(validResponses({
        firstBranch: branch("d".repeat(40)),
      })),
    }),
    "PRODUCTION_DEPLOY_MAIN_STALE",
  );
  await expectRejectCode(
    () => verifyProductionDeployIdentity({
      nowMilliseconds: NOW,
      rawContext: {...VALID_CONTEXT},
      rawInputs: {...VALID_INPUTS},
      requestJson: createRequester(validResponses({
        finalBranch: branch("d".repeat(40)),
      })),
    }),
    "PRODUCTION_DEPLOY_MAIN_STALE",
  );
});

test("#34 rejects wrong repository, run, attempt, workflow and head identity", async () => {
  const mutations = [
    (value) => { value.id += 1; },
    (value) => { value.repository.full_name = "attacker/fork"; },
    (value) => { value.head_repository.id += 1; },
    (value) => { value.run_attempt = 2; },
    (value) => { value.name = "Other"; },
    (value) => { value.path = ".github/workflows/other.yml"; },
    (value) => { value.event = "workflow_dispatch"; },
    (value) => { value.head_branch = "dev"; },
    (value) => { value.head_sha = "d".repeat(40); },
    (value) => { value.status = "completed"; value.conclusion = "success"; },
  ];
  for (const mutate of mutations) {
    const value = clone(workflowRun());
    mutate(value);
    await expectRejectCode(
      () => verifyProductionDeployIdentity({
        nowMilliseconds: NOW,
        rawContext: {...VALID_CONTEXT},
        rawInputs: {...VALID_INPUTS},
        requestJson: createRequester(validResponses({run: value})),
      }),
      value.repository.full_name === "attacker/fork"
        ? "PRODUCTION_DEPLOY_RUN_REPOSITORY"
        : "PRODUCTION_DEPLOY_RUN_IDENTITY",
    );
  }
});

test("#34 rejects same-name different-ID, cross-run and expired artifacts", async () => {
  const identityMutations = [
    (value) => { value.id += 1; },
    (value) => { value.name = "axial-muse-site-forged"; },
    (value) => { value.size_in_bytes = 0; },
    (value) => { value.expired = true; },
    (value) => { value.workflow_run.id += 1; },
    (value) => { value.workflow_run.repository_id += 1; },
    (value) => { value.workflow_run.head_repository_id += 1; },
    (value) => { value.workflow_run.head_branch = "dev"; },
    (value) => { value.workflow_run.head_sha = "d".repeat(40); },
  ];
  for (const mutate of identityMutations) {
    const value = clone(artifact());
    mutate(value);
    await expectRejectCode(
      () => verifyProductionDeployIdentity({
        nowMilliseconds: NOW,
        rawContext: {...VALID_CONTEXT},
        rawInputs: {...VALID_INPUTS},
        requestJson: createRequester(validResponses({artifactValue: value})),
      }),
      "PRODUCTION_DEPLOY_ARTIFACT_IDENTITY",
    );
  }

  for (const digest of [
    undefined,
    VALID_INPUTS.artifactDigest,
    `sha256:sha256:${VALID_INPUTS.artifactDigest}`,
    `SHA256:${VALID_INPUTS.artifactDigest}`,
    `sha512:${VALID_INPUTS.artifactDigest}`,
    `sha256:${"A".repeat(64)}`,
  ]) {
    const value = artifact();
    value.digest = digest;
    await expectRejectCode(
      () => verifyProductionDeployIdentity({
        nowMilliseconds: NOW,
        rawContext: {...VALID_CONTEXT},
        rawInputs: {...VALID_INPUTS},
        requestJson: createRequester(validResponses({artifactValue: value})),
      }),
      "PRODUCTION_DEPLOY_ARTIFACT_DIGEST",
    );
  }

  for (const mutate of [
    (value) => { value.expires_at = "2026-07-29T12:00:00Z"; },
    (value) => { value.expires_at = "2026-07-29T10:00:00Z"; },
    (value) => { value.created_at = "2026-07-29T12:06:00Z"; },
    (value) => { value.created_at = "not-a-date"; },
    (value) => { value.expires_at = "2026-02-29T00:00:00Z"; },
  ]) {
    const value = artifact();
    mutate(value);
    await expectRejectCode(
      () => verifyProductionDeployIdentity({
        nowMilliseconds: NOW,
        rawContext: {...VALID_CONTEXT},
        rawInputs: {...VALID_INPUTS},
        requestJson: createRequester(validResponses({artifactValue: value})),
      }),
      value.created_at === "not-a-date" || value.expires_at === "2026-02-29T00:00:00Z"
        ? "PRODUCTION_DEPLOY_ARTIFACT_TIME"
        : "PRODUCTION_DEPLOY_ARTIFACT_EXPIRED",
    );
  }
});

test("#34 fails closed on GitHub API transport, status and response shape", async () => {
  await expectRejectCode(
    () => verifyProductionDeployIdentity({
      nowMilliseconds: NOW,
      rawContext: {...VALID_CONTEXT},
      rawInputs: {...VALID_INPUTS},
      requestJson: createRequester([new Error("token should not leak")]),
    }),
    "PRODUCTION_DEPLOY_GITHUB_API",
  );
  await expectRejectCode(
    () => verifyProductionDeployIdentity({
      nowMilliseconds: NOW,
      rawContext: {...VALID_CONTEXT},
      rawInputs: {...VALID_INPUTS},
      requestJson: createRequester([response({message: "Not Found"}, 404)]),
    }),
    "PRODUCTION_DEPLOY_MAIN_RESPONSE",
  );
  await expectRejectCode(
    () => verifyProductionDeployIdentity({
      nowMilliseconds: NOW,
      rawContext: {...VALID_CONTEXT},
      rawInputs: {...VALID_INPUTS},
      requestJson: createRequester([response({name: "main"})]),
    }),
    "PRODUCTION_DEPLOY_MAIN_RESPONSE",
  );
});

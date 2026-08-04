import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTatInvokeRequest,
  buildTatParameters,
  parseTatConfig,
  parseTatCredentials,
  TencentTatError,
  validateTatInvokeResponse,
} from "../../scripts/deploy/lib/tencent-tat.mjs";

const IDENTITY = Object.freeze({
  artifactDigest: "a".repeat(64),
  artifactId: "123456789",
  artifactName: `axial-muse-site-${"c".repeat(40)}-29913247834-1`,
  commitSha: "c".repeat(40),
  releaseContentSha256: "b".repeat(64),
  repository: "lyty1997/AxialMuseWebsite",
  runAttempt: "1",
  workflowRunId: "29913247834",
});
const CONFIG = Object.freeze({
  commandId: "cmd-abcdefgh",
  instanceId: "lhins-abcdefgh",
  region: "ap-shanghai",
});
const CREDENTIALS = Object.freeze({
  secretId: "AKIDEXAMPLE00000000",
  secretKey: "exampleSecretKey0000000000000000",
});
const TIMESTAMP_SECONDS = 1_785_326_400;

function expectCode(callback, code) {
  assert.throws(callback, (error) => (
    error instanceof TencentTatError
    && error.code === code
    && error.stack === undefined
  ));
}

test("#34 TAT parameters contain exactly the five frozen deployment fields", () => {
  assert.deepEqual(buildTatParameters({...IDENTITY}), {
    workflowRunId: IDENTITY.workflowRunId,
    artifactId: IDENTITY.artifactId,
    commitSha: IDENTITY.commitSha,
    artifactDigest: IDENTITY.artifactDigest,
    releaseContentSha256: IDENTITY.releaseContentSha256,
  });
  for (const invalid of [
    {...IDENTITY, extra: "forged"},
    {...IDENTITY, repository: "attacker/fork"},
    {...IDENTITY, artifactId: "01"},
    {...IDENTITY, artifactName: "same-name-is-not-identity"},
    {...IDENTITY, artifactDigest: `sha256:${IDENTITY.artifactDigest}`},
  ]) {
    expectCode(
      () => buildTatParameters(invalid),
      "PRODUCTION_DEPLOY_TAT_IDENTITY",
    );
  }
});

test("#34 builds one fixed-instance InvokeCommand request and TC3 golden", () => {
  const request = buildTatInvokeRequest({
    config: {...CONFIG},
    credentials: {...CREDENTIALS},
    identity: {...IDENTITY},
    timestampSeconds: TIMESTAMP_SECONDS,
  });
  assert.deepEqual(
    JSON.parse(request.body),
    {
      CommandId: CONFIG.commandId,
      InstanceIds: [CONFIG.instanceId],
      Parameters: JSON.stringify({
        workflowRunId: IDENTITY.workflowRunId,
        artifactId: IDENTITY.artifactId,
        commitSha: IDENTITY.commitSha,
        artifactDigest: IDENTITY.artifactDigest,
        releaseContentSha256: IDENTITY.releaseContentSha256,
      }),
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.parse(request.body).Parameters),
    {
      workflowRunId: IDENTITY.workflowRunId,
      artifactId: IDENTITY.artifactId,
      commitSha: IDENTITY.commitSha,
      artifactDigest: IDENTITY.artifactDigest,
      releaseContentSha256: IDENTITY.releaseContentSha256,
    },
  );
  assert.equal(request.hostname, "tat.tencentcloudapi.com");
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/");
  assert.equal(request.headers["X-TC-Action"], "InvokeCommand");
  assert.equal(request.headers["X-TC-Version"], "2020-10-28");
  assert.equal(request.headers["X-TC-Region"], "ap-shanghai");
  assert.equal(request.headers["X-TC-Timestamp"], String(TIMESTAMP_SECONDS));
  assert.equal(
    request.headers.Authorization,
    "TC3-HMAC-SHA256 Credential=AKIDEXAMPLE00000000/2026-07-29/tat/tc3_request, "
      + "SignedHeaders=content-type;host;x-tc-action, "
      + "Signature=a8f0a1af324b4d7de772447c425b8f2f54b58fd24b75fc86c17c7f87355ed347",
  );
  assert.equal(request.body.includes(CREDENTIALS.secretId), false);
  assert.equal(request.body.includes(CREDENTIALS.secretKey), false);
  assert.equal(/\bRunCommand\b|https?:\/\/|(?:^|["'])\/(?:srv|tmp|var)\//u.test(request.body), false);
});

test("#34 refuses dynamic region, command, instance, credentials and extras", () => {
  assert.deepEqual(parseTatConfig({...CONFIG}), CONFIG);
  assert.deepEqual(parseTatCredentials({...CREDENTIALS}), CREDENTIALS);
  for (const invalid of [
    {...CONFIG, region: "ap-guangzhou"},
    {...CONFIG, commandId: "cmd-../../forged"},
    {...CONFIG, instanceId: "ins-abcdefgh"},
    {...CONFIG, extra: "forged"},
  ]) {
    expectCode(
      () => parseTatConfig(invalid),
      "PRODUCTION_DEPLOY_TAT_CONFIG",
    );
  }
  for (const invalid of [
    {...CREDENTIALS, secretId: ""},
    {...CREDENTIALS, secretKey: "line\nbreak"},
    {...CREDENTIALS, extra: "forged"},
  ]) {
    expectCode(
      () => parseTatCredentials(invalid),
      "PRODUCTION_DEPLOY_TAT_CREDENTIALS",
    );
  }
});

test("#34 accepts only canonical invocation response and keeps API diagnostics safe", () => {
  assert.deepEqual(
    validateTatInvokeResponse({
      Response: {
        InvocationId: "inv-8xgjrytm",
        RequestId: "41417f50-51b5-4c8d-85b7-f6c508cb228f",
      },
    }),
    {
      invocationId: "inv-8xgjrytm",
      requestId: "41417f50-51b5-4c8d-85b7-f6c508cb228f",
    },
  );
  for (const invalid of [
    {},
    {Response: {}},
    {Response: {
      InvocationId: "inv-8xgjrytm",
      RequestId: "41417f50-51b5-4c8d-85b7-f6c508cb228f",
      extra: "forged",
    }},
    {Response: {
      InvocationId: "not-an-invocation",
      RequestId: "41417f50-51b5-4c8d-85b7-f6c508cb228f",
    }},
  ]) {
    expectCode(
      () => validateTatInvokeResponse(invalid),
      "PRODUCTION_DEPLOY_TAT_RESPONSE",
    );
  }
  assert.throws(
    () => validateTatInvokeResponse({
      Response: {
        Error: {
          Code: "UnauthorizedOperation",
          Message: "SecretKey=must-not-be-rendered",
        },
        RequestId: "41417f50-51b5-4c8d-85b7-f6c508cb228f",
      },
    }),
    (error) => {
      assert.equal(error.code, "PRODUCTION_DEPLOY_TAT_API");
      assert.deepEqual(error.safeContext, {
        apiCode: "UnauthorizedOperation",
        requestId: "41417f50-51b5-4c8d-85b7-f6c508cb228f",
      });
      assert.equal(error.message.includes("must-not-be-rendered"), false);
      return true;
    },
  );
});

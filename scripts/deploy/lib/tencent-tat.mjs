import {
  createHash,
  createHmac,
} from "node:crypto";
import {PRODUCTION_DEPLOY_REPOSITORY} from "./production-deploy-identity.mjs";

export const TAT_HOSTNAME = "tat.tencentcloudapi.com";
export const TAT_SERVICE = "tat";
export const TAT_ACTION = "InvokeCommand";
export const TAT_VERSION = "2020-10-28";
export const TAT_REGION = "ap-shanghai";
export const TAT_CONTENT_TYPE = "application/json; charset=utf-8";

const ALGORITHM = "TC3-HMAC-SHA256";
const SIGNED_HEADERS = "content-type;host;x-tc-action";
const CONFIG_KEYS = Object.freeze(["commandId", "instanceId", "region"]);
const CREDENTIAL_KEYS = Object.freeze(["secretId", "secretKey"]);
const IDENTITY_KEYS = Object.freeze([
  "artifactDigest",
  "artifactId",
  "artifactName",
  "commitSha",
  "releaseContentSha256",
  "repository",
  "runAttempt",
  "workflowRunId",
]);
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const LOWER_COMMIT_SHA = /^[0-9a-f]{40}$/u;
const LOWER_SHA256 = /^[0-9a-f]{64}$/u;
const COMMAND_ID = /^cmd-[a-z0-9]{8,64}$/u;
const LIGHTHOUSE_INSTANCE_ID = /^lhins-[a-z0-9]{8,64}$/u;
const INVOCATION_ID = /^inv-[a-z0-9]{8,64}$/u;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const API_ERROR_CODE = /^[A-Za-z][A-Za-z0-9.]{0,127}$/u;

export class TencentTatError extends Error {
  constructor(code, safeContext = undefined) {
    super("腾讯云 TAT InvokeCommand 失败。");
    this.name = "TencentTatError";
    this.code = code;
    this.safeContext = safeContext;
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: undefined,
      writable: false,
    });
  }
}

function fail(code, safeContext) {
  throw new TencentTatError(code, safeContext);
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

function isBoundedSecret(value) {
  return (
    typeof value === "string"
    && value.length >= 16
    && value.length <= 256
    && !/[\0-\x20\x7f]/u.test(value)
  );
}

function validateIdentity(identity) {
  if (
    !isPlainObject(identity)
    || !hasExactKeys(identity, IDENTITY_KEYS)
    || identity.repository !== PRODUCTION_DEPLOY_REPOSITORY
    || typeof identity.artifactId !== "string"
    || !POSITIVE_DECIMAL.test(identity.artifactId)
    || typeof identity.workflowRunId !== "string"
    || !POSITIVE_DECIMAL.test(identity.workflowRunId)
    || typeof identity.runAttempt !== "string"
    || !POSITIVE_DECIMAL.test(identity.runAttempt)
    || typeof identity.commitSha !== "string"
    || !LOWER_COMMIT_SHA.test(identity.commitSha)
    || typeof identity.artifactDigest !== "string"
    || !LOWER_SHA256.test(identity.artifactDigest)
    || typeof identity.releaseContentSha256 !== "string"
    || !LOWER_SHA256.test(identity.releaseContentSha256)
    || identity.artifactName
      !== `axial-muse-site-${identity.commitSha}-${identity.workflowRunId}-${identity.runAttempt}`
  ) {
    fail("PRODUCTION_DEPLOY_TAT_IDENTITY");
  }
  return identity;
}

export function parseTatConfig(value) {
  if (
    !isPlainObject(value)
    || !hasExactKeys(value, CONFIG_KEYS)
    || value.region !== TAT_REGION
    || typeof value.commandId !== "string"
    || !COMMAND_ID.test(value.commandId)
    || typeof value.instanceId !== "string"
    || !LIGHTHOUSE_INSTANCE_ID.test(value.instanceId)
  ) {
    fail("PRODUCTION_DEPLOY_TAT_CONFIG");
  }
  return Object.freeze({
    commandId: value.commandId,
    instanceId: value.instanceId,
    region: value.region,
  });
}

export function parseTatCredentials(value) {
  if (
    !isPlainObject(value)
    || !hasExactKeys(value, CREDENTIAL_KEYS)
    || !isBoundedSecret(value.secretId)
    || !isBoundedSecret(value.secretKey)
  ) {
    fail("PRODUCTION_DEPLOY_TAT_CREDENTIALS");
  }
  return Object.freeze({
    secretId: value.secretId,
    secretKey: value.secretKey,
  });
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmacSha256(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

export function createTc3Authorization({
  action,
  contentType,
  host,
  payload,
  secretId,
  secretKey,
  service,
  timestampSeconds,
} = {}) {
  if (
    typeof action !== "string"
    || !/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(action)
    || typeof contentType !== "string"
    || contentType !== TAT_CONTENT_TYPE
    || typeof host !== "string"
    || !/^[a-z0-9.-]+$/u.test(host)
    || typeof payload !== "string"
    || Buffer.byteLength(payload, "utf8") > 128 * 1024
    || typeof service !== "string"
    || !/^[a-z][a-z0-9]{0,31}$/u.test(service)
    || !Number.isSafeInteger(timestampSeconds)
    || timestampSeconds <= 0
    || !isBoundedSecret(secretId)
    || !isBoundedSecret(secretKey)
  ) {
    fail("PRODUCTION_DEPLOY_TAT_SIGNING_INPUT");
  }
  const date = new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:${contentType.toLowerCase()}\n`
    + `host:${host.toLowerCase()}\n`
    + `x-tc-action:${action.toLowerCase()}\n`;
  const canonicalRequest = "POST\n/\n\n"
    + `${canonicalHeaders}\n`
    + `${SIGNED_HEADERS}\n`
    + sha256Hex(payload);
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `${ALGORITHM}\n`
    + `${timestampSeconds}\n`
    + `${credentialScope}\n`
    + sha256Hex(canonicalRequest);
  const secretDate = hmacSha256(`TC3${secretKey}`, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = createHmac("sha256", secretSigning)
    .update(stringToSign, "utf8")
    .digest("hex");
  return `${ALGORITHM} Credential=${secretId}/${credentialScope}, `
    + `SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`;
}

export function buildTatParameters(identity) {
  const validated = validateIdentity(identity);
  return Object.freeze({
    workflowRunId: validated.workflowRunId,
    artifactId: validated.artifactId,
    commitSha: validated.commitSha,
    artifactDigest: validated.artifactDigest,
    releaseContentSha256: validated.releaseContentSha256,
  });
}

export function buildTatInvokeRequest({
  identity,
  config,
  credentials,
  timestampSeconds,
} = {}) {
  const validatedConfig = parseTatConfig(config);
  const validatedCredentials = parseTatCredentials(credentials);
  const parameters = buildTatParameters(identity);
  const body = JSON.stringify({
    CommandId: validatedConfig.commandId,
    InstanceIds: [validatedConfig.instanceId],
    Parameters: JSON.stringify(parameters),
  });
  const authorization = createTc3Authorization({
    action: TAT_ACTION,
    contentType: TAT_CONTENT_TYPE,
    host: TAT_HOSTNAME,
    payload: body,
    secretId: validatedCredentials.secretId,
    secretKey: validatedCredentials.secretKey,
    service: TAT_SERVICE,
    timestampSeconds,
  });
  return Object.freeze({
    body,
    headers: Object.freeze({
      Authorization: authorization,
      "Content-Type": TAT_CONTENT_TYPE,
      Host: TAT_HOSTNAME,
      "X-TC-Action": TAT_ACTION,
      "X-TC-Region": validatedConfig.region,
      "X-TC-Timestamp": String(timestampSeconds),
      "X-TC-Version": TAT_VERSION,
    }),
    hostname: TAT_HOSTNAME,
    method: "POST",
    path: "/",
  });
}

export function validateTatInvokeResponse(value) {
  if (!isPlainObject(value) || !isPlainObject(value.Response)) {
    fail("PRODUCTION_DEPLOY_TAT_RESPONSE");
  }
  const response = value.Response;
  if (isPlainObject(response.Error)) {
    const apiCode = response.Error.Code;
    const requestId = response.RequestId;
    const safeContext = Object.freeze({
      ...(typeof apiCode === "string" && API_ERROR_CODE.test(apiCode)
        ? {apiCode}
        : {}),
      ...(typeof requestId === "string" && REQUEST_ID.test(requestId)
        ? {requestId}
        : {}),
    });
    fail("PRODUCTION_DEPLOY_TAT_API", safeContext);
  }
  if (
    !hasExactKeys(response, ["InvocationId", "RequestId"])
    || typeof response.InvocationId !== "string"
    || !INVOCATION_ID.test(response.InvocationId)
    || typeof response.RequestId !== "string"
    || !REQUEST_ID.test(response.RequestId)
  ) {
    fail("PRODUCTION_DEPLOY_TAT_RESPONSE");
  }
  return Object.freeze({
    invocationId: response.InvocationId,
    requestId: response.RequestId,
  });
}

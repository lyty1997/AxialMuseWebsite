import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import {isAbsolute, resolve} from "node:path";
import {decodeJsonDocument} from "../../content/json.mjs";
import {
  captureFileTree,
  fileTreeContentsEqual,
  fileTreeOperationallyEqual,
} from "./file-tree.mjs";
import {
  assertProductionArtifactTrackedSource,
  runProductionArtifactGit,
} from "./production-artifact-workspace.mjs";

export const PRODUCTION_ARTIFACT_REPOSITORY = "lyty1997/AxialMuseWebsite";

const INPUT_KEYS = Object.freeze([
  "artifactDigest",
  "artifactId",
  "commitSha",
  "releaseContentSha256",
  "repository",
  "runAttempt",
  "runId",
]);

const UPLOAD_SEAL_INPUT_KEYS = Object.freeze([
  "buildOperationalSha256",
  "releaseContentSha256",
  "releaseOperationalSha256",
]);

const OUTPUT_FIELDS = Object.freeze([
  Object.freeze(["artifact-id", "artifactId"]),
  Object.freeze(["artifact-digest", "artifactDigest"]),
  Object.freeze(["release-content-sha256", "releaseContentSha256"]),
  Object.freeze(["repository", "repository"]),
  Object.freeze(["run-id", "runId"]),
  Object.freeze(["run-attempt", "runAttempt"]),
  Object.freeze(["commit-sha", "commitSha"]),
]);

export class ProductionArtifactOutputError extends Error {
  constructor(code) {
    super("production artifact output 契约检查失败。");
    this.name = "ProductionArtifactOutputError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: undefined,
      writable: false,
    });
  }
}

function fail(code) {
  throw new ProductionArtifactOutputError(code);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value) {
  if (
    !isPlainRecord(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(INPUT_KEYS)
  ) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_INPUT");
  }
}

function isPositiveDecimal(value) {
  return typeof value === "string" && /^[1-9][0-9]*$/u.test(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

export function validateProductionArtifactOutputs(value) {
  assertExactKeys(value);
  if (
    !isPositiveDecimal(value.artifactId)
    || !isPositiveDecimal(value.runId)
    || !isPositiveDecimal(value.runAttempt)
  ) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_IDENTITY");
  }
  if (
    !isSha256(value.artifactDigest)
    || !isSha256(value.releaseContentSha256)
  ) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_DIGEST");
  }
  if (value.repository !== PRODUCTION_ARTIFACT_REPOSITORY) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_REPOSITORY");
  }
  if (
    typeof value.commitSha !== "string"
    || !/^[0-9a-f]{40}$/u.test(value.commitSha)
  ) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_COMMIT");
  }
  return Object.freeze({
    artifactDigest: value.artifactDigest,
    artifactId: value.artifactId,
    commitSha: value.commitSha,
    releaseContentSha256: value.releaseContentSha256,
    repository: value.repository,
    runAttempt: value.runAttempt,
    runId: value.runId,
  });
}

export function renderProductionArtifactOutputs(value) {
  const validated = validateProductionArtifactOutputs(value);
  return OUTPUT_FIELDS
    .map(([outputName, inputName]) => `${outputName}=${validated[inputName]}\n`)
    .join("");
}

export function validateProductionArtifactUploadSeal(value) {
  if (
    !isPlainRecord(value)
    || JSON.stringify(Object.keys(value).sort())
      !== JSON.stringify(UPLOAD_SEAL_INPUT_KEYS)
    || !isSha256(value.buildOperationalSha256)
    || !isSha256(value.releaseContentSha256)
    || !isSha256(value.releaseOperationalSha256)
  ) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_UPLOAD_SEAL");
  }
  return Object.freeze({
    buildOperationalSha256: value.buildOperationalSha256,
    releaseContentSha256: value.releaseContentSha256,
    releaseOperationalSha256: value.releaseOperationalSha256,
  });
}

export function renderProductionArtifactUploadSeal(value) {
  const validated = validateProductionArtifactUploadSeal(value);
  return `release-content-sha256=${validated.releaseContentSha256}\n`
    + `build-operational-sha256=${validated.buildOperationalSha256}\n`
    + `release-operational-sha256=${validated.releaseOperationalSha256}\n`;
}

function assertBindingRoot(root, cwd) {
  try {
    const metadata = lstatSync(root);
    if (
      typeof root !== "string"
      || resolve(root) !== root
      || realpathSync(root) !== root
      || realpathSync(cwd) !== root
      || metadata.isSymbolicLink()
      || !metadata.isDirectory()
    ) {
      fail("PRODUCTION_ARTIFACT_OUTPUT_BINDING");
    }
  } catch (error) {
    if (error instanceof ProductionArtifactOutputError) throw error;
    fail("PRODUCTION_ARTIFACT_OUTPUT_BINDING");
  }
}

function singleGitLine(value) {
  if (
    typeof value !== "string"
    || !value.endsWith("\n")
    || value.slice(0, -1).includes("\n")
    || value.includes("\r")
    || value.includes("\0")
  ) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_COMMIT_BINDING");
  }
  return value.slice(0, -1);
}

function releaseMetadataBytes(releaseRoot, capture) {
  const relativePath = "metadata/release.json";
  const record = capture.records.find((candidate) => (
    candidate.path === relativePath
  ));
  if (record === undefined || record.byteLength > 1024 * 1024) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_RELEASE_CHANGED");
  }
  const path = resolve(releaseRoot, relativePath);
  let bytes;
  try {
    const metadata = lstatSync(path);
    if (
      realpathSync(path) !== path
      || metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.nlink !== 1
    ) {
      fail("PRODUCTION_ARTIFACT_OUTPUT_RELEASE_CHANGED");
    }
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof ProductionArtifactOutputError) throw error;
    fail("PRODUCTION_ARTIFACT_OUTPUT_RELEASE_CHANGED");
  }
  if (
    bytes.length !== record.byteLength
    || createHash("sha256").update(bytes).digest("hex") !== record.sha256
  ) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_RELEASE_CHANGED");
  }
  return bytes;
}

function captureBoundTree(root, sourcePath, errorCode) {
  try {
    return captureFileTree({root, sourcePath});
  } catch {
    fail(errorCode);
  }
}

function captureProductionArtifactState({
  root,
  cwd,
  environment,
  releaseContentSha256,
  commitSha,
  spawnProcess,
}) {
  if (!isSha256(releaseContentSha256)) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_RELEASE_CHANGED");
  }
  if (
    typeof commitSha !== "string"
    || !/^[0-9a-f]{40}$/u.test(commitSha)
  ) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_COMMIT_BINDING");
  }
  assertBindingRoot(root, cwd);
  const buildRoot = resolve(root, "build");
  const releaseRoot = resolve(root, "dist", "release");
  let initialBuildCapture;
  let initialCapture;
  let metadata;
  try {
    initialCapture = captureBoundTree(
      releaseRoot,
      "dist/release",
      "PRODUCTION_ARTIFACT_OUTPUT_RELEASE_CHANGED",
    );
    if (initialCapture.treeSha256 !== releaseContentSha256) {
      fail("PRODUCTION_ARTIFACT_OUTPUT_RELEASE_CHANGED");
    }
    metadata = decodeJsonDocument({
      bytes: releaseMetadataBytes(releaseRoot, initialCapture),
      sourcePath: "dist/release/metadata/release.json",
    });
    if (
      typeof metadata.sourceBuildTreeSha256 !== "string"
      || !isSha256(metadata.sourceBuildTreeSha256)
    ) {
      fail("PRODUCTION_ARTIFACT_OUTPUT_BUILD_CHANGED");
    }
    initialBuildCapture = captureBoundTree(
      buildRoot,
      "build",
      "PRODUCTION_ARTIFACT_OUTPUT_BUILD_CHANGED",
    );
    if (
      initialBuildCapture.treeSha256 !== metadata.sourceBuildTreeSha256
    ) {
      fail("PRODUCTION_ARTIFACT_OUTPUT_BUILD_CHANGED");
    }
  } catch (error) {
    if (error instanceof ProductionArtifactOutputError) throw error;
    fail("PRODUCTION_ARTIFACT_OUTPUT_RELEASE_CHANGED");
  }
  if (metadata.commitSha !== commitSha) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_COMMIT_BINDING");
  }
  let headSha;
  let status;
  try {
    headSha = singleGitLine(runProductionArtifactGit(
      root,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      {environment, spawnProcess},
    ));
    status = runProductionArtifactGit(
      root,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {environment, spawnProcess},
    );
    assertProductionArtifactTrackedSource(root, {
      environment,
      spawnProcess,
    });
  } catch {
    fail("PRODUCTION_ARTIFACT_OUTPUT_COMMIT_BINDING");
  }
  if (headSha !== commitSha || status !== "") {
    fail("PRODUCTION_ARTIFACT_OUTPUT_COMMIT_BINDING");
  }
  let finalBuildCapture;
  let finalCapture;
  finalBuildCapture = captureBoundTree(
    buildRoot,
    "build",
    "PRODUCTION_ARTIFACT_OUTPUT_BUILD_CHANGED",
  );
  finalCapture = captureBoundTree(
    releaseRoot,
    "dist/release",
    "PRODUCTION_ARTIFACT_OUTPUT_RELEASE_CHANGED",
  );
  if (
    finalBuildCapture.treeSha256 !== metadata.sourceBuildTreeSha256
    || !fileTreeContentsEqual(initialBuildCapture, finalBuildCapture)
    || !fileTreeOperationallyEqual(initialBuildCapture, finalBuildCapture)
  ) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_BUILD_CHANGED");
  }
  if (
    finalCapture.treeSha256 !== releaseContentSha256
    || !fileTreeContentsEqual(initialCapture, finalCapture)
    || !fileTreeOperationallyEqual(initialCapture, finalCapture)
  ) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_RELEASE_CHANGED");
  }
  return Object.freeze({
    buildCapture: finalBuildCapture,
    releaseCapture: finalCapture,
  });
}

export function captureProductionArtifactUploadSeal({
  root,
  cwd = process.cwd(),
  environment = process.env,
  releaseContentSha256,
  commitSha,
  spawnProcess = spawnSync,
} = {}) {
  const state = captureProductionArtifactState({
    root,
    cwd,
    environment,
    releaseContentSha256,
    commitSha,
    spawnProcess,
  });
  return validateProductionArtifactUploadSeal({
    buildOperationalSha256: state.buildCapture.operationalSha256,
    releaseContentSha256,
    releaseOperationalSha256: state.releaseCapture.operationalSha256,
  });
}

export function assertProductionArtifactBinding({
  root,
  cwd = process.cwd(),
  environment = process.env,
  identity,
  uploadSeal,
  spawnProcess = spawnSync,
} = {}) {
  const validated = validateProductionArtifactOutputs(identity);
  const validatedSeal = validateProductionArtifactUploadSeal(uploadSeal);
  if (
    validatedSeal.releaseContentSha256
    !== validated.releaseContentSha256
  ) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_UPLOAD_SEAL");
  }
  const state = captureProductionArtifactState({
    root,
    cwd,
    environment,
    releaseContentSha256: validated.releaseContentSha256,
    commitSha: validated.commitSha,
    spawnProcess,
  });
  if (
    state.buildCapture.operationalSha256
    !== validatedSeal.buildOperationalSha256
  ) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_BUILD_CHANGED");
  }
  if (
    state.releaseCapture.operationalSha256
    !== validatedSeal.releaseOperationalSha256
  ) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_RELEASE_CHANGED");
  }
  return validated;
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size;
}

function assertOutputFile(path, expectedUserId) {
  let canonicalPath;
  let metadata;
  try {
    canonicalPath = realpathSync(path);
    metadata = lstatSync(path);
  } catch {
    fail("PRODUCTION_ARTIFACT_OUTPUT_FILE");
  }
  if (
    canonicalPath !== path
    || metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1
    || metadata.uid !== expectedUserId
  ) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_FILE");
  }
  return metadata;
}

function appendOutputBytes(path, bytes, {
  userId = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  if (
    typeof path !== "string"
    || path === ""
    || path.includes("\0")
    || !isAbsolute(path)
    || !Number.isSafeInteger(userId)
    || userId < 0
  ) {
    fail("PRODUCTION_ARTIFACT_OUTPUT_FILE");
  }
  const initial = assertOutputFile(path, userId);
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(descriptor);
    if (!sameIdentity(initial, opened)) {
      fail("PRODUCTION_ARTIFACT_OUTPUT_FILE");
    }
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
      );
      if (written <= 0) fail("PRODUCTION_ARTIFACT_OUTPUT_WRITE");
      offset += written;
    }
    fsyncSync(descriptor);
    const finalPath = lstatSync(path);
    const finalDescriptor = fstatSync(descriptor);
    if (
      finalPath.dev !== finalDescriptor.dev
      || finalPath.ino !== finalDescriptor.ino
      || finalPath.uid !== userId
      || finalPath.nlink !== 1
      || !finalPath.isFile()
      || finalPath.size !== initial.size + bytes.length
    ) {
      fail("PRODUCTION_ARTIFACT_OUTPUT_WRITE");
    }
  } catch (error) {
    if (error instanceof ProductionArtifactOutputError) throw error;
    fail("PRODUCTION_ARTIFACT_OUTPUT_WRITE");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 当前 job 已失败或即将失败；关闭错误不得覆盖既有稳定错误。
      }
    }
  }
}

export function appendProductionArtifactOutputs(path, value, options) {
  const validated = validateProductionArtifactOutputs(value);
  appendOutputBytes(
    path,
    Buffer.from(renderProductionArtifactOutputs(validated), "utf8"),
    options,
  );
  return validated;
}

export function appendProductionArtifactUploadSeal(path, value, options) {
  const validated = validateProductionArtifactUploadSeal(value);
  appendOutputBytes(
    path,
    Buffer.from(renderProductionArtifactUploadSeal(validated), "utf8"),
    options,
  );
  return validated;
}

export function formatProductionArtifactOutputError(error) {
  const code = error instanceof ProductionArtifactOutputError
    && /^PRODUCTION_ARTIFACT_OUTPUT_[A-Z_]{2,64}$/u.test(error.code)
    ? error.code
    : "PRODUCTION_ARTIFACT_OUTPUT_INTERNAL";
  return `[${code}] production artifact outputs 未通过。`;
}

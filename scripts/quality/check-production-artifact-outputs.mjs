import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {projectRoot} from "./lib/files.mjs";
import {
  appendProductionArtifactOutputs,
  assertProductionArtifactBinding,
  formatProductionArtifactOutputError,
  ProductionArtifactOutputError,
} from "./lib/production-artifact-outputs.mjs";

const ROOT = projectRoot();

const ENVIRONMENT_FIELDS = Object.freeze({
  artifactDigest: "AXIAL_ARTIFACT_DIGEST",
  artifactId: "AXIAL_ARTIFACT_ID",
  commitSha: "AXIAL_COMMIT_SHA",
  releaseContentSha256: "AXIAL_RELEASE_CONTENT_SHA256",
  repository: "AXIAL_REPOSITORY",
  runAttempt: "AXIAL_RUN_ATTEMPT",
  runId: "AXIAL_RUN_ID",
});

const UPLOAD_SEAL_ENVIRONMENT_FIELDS = Object.freeze({
  buildOperationalSha256: "AXIAL_BUILD_OPERATIONAL_SHA256",
  releaseContentSha256: "AXIAL_RELEASE_CONTENT_SHA256",
  releaseOperationalSha256: "AXIAL_RELEASE_OPERATIONAL_SHA256",
});

export function readProductionArtifactOutputEnvironment(environment) {
  if (
    environment === null
    || typeof environment !== "object"
    || Array.isArray(environment)
  ) {
    throw new ProductionArtifactOutputError(
      "PRODUCTION_ARTIFACT_OUTPUT_INPUT",
    );
  }
  return Object.fromEntries(
    Object.entries(ENVIRONMENT_FIELDS).map(([field, name]) => [
      field,
      typeof environment[name] === "string" ? environment[name] : null,
    ]),
  );
}

export function readProductionArtifactUploadSealEnvironment(environment) {
  if (
    environment === null
    || typeof environment !== "object"
    || Array.isArray(environment)
  ) {
    throw new ProductionArtifactOutputError(
      "PRODUCTION_ARTIFACT_OUTPUT_INPUT",
    );
  }
  return Object.fromEntries(
    Object.entries(UPLOAD_SEAL_ENVIRONMENT_FIELDS)
      .map(([field, name]) => [
        field,
        typeof environment[name] === "string" ? environment[name] : null,
      ]),
  );
}

export function runProductionArtifactOutputCli({
  arguments_ = process.argv.slice(2),
  environment = process.env,
  root = ROOT,
  cwd = process.cwd(),
} = {}) {
  if (!Array.isArray(arguments_) || arguments_.length !== 0) {
    throw new ProductionArtifactOutputError(
      "PRODUCTION_ARTIFACT_OUTPUT_INPUT",
    );
  }
  const identity = readProductionArtifactOutputEnvironment(environment);
  const uploadSeal = readProductionArtifactUploadSealEnvironment(environment);
  assertProductionArtifactBinding({
    root,
    cwd,
    environment,
    identity,
    uploadSeal,
  });
  return appendProductionArtifactOutputs(
    environment.GITHUB_OUTPUT,
    identity,
  );
}

function runCli() {
  try {
    runProductionArtifactOutputCli();
  } catch (error) {
    console.error(formatProductionArtifactOutputError(error));
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runCli();
}

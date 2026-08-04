import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {projectRoot} from "./lib/files.mjs";
import {
  appendProductionArtifactUploadSeal,
  captureProductionArtifactUploadSeal,
  formatProductionArtifactOutputError,
  ProductionArtifactOutputError,
  PRODUCTION_ARTIFACT_REPOSITORY,
} from "./lib/production-artifact-outputs.mjs";

const ROOT = projectRoot();

export function runPrepareProductionArtifactUploadCli({
  arguments_ = process.argv.slice(2),
  environment = process.env,
  root = ROOT,
  cwd = process.cwd(),
} = {}) {
  if (
    !Array.isArray(arguments_)
    || arguments_.length !== 0
    || environment === null
    || typeof environment !== "object"
    || Array.isArray(environment)
    || environment.GITHUB_REPOSITORY !== PRODUCTION_ARTIFACT_REPOSITORY
    || environment.GITHUB_EVENT_NAME !== "push"
    || environment.GITHUB_REF !== "refs/heads/main"
    || environment.GITHUB_SHA !== environment.AXIAL_COMMIT_SHA
  ) {
    throw new ProductionArtifactOutputError(
      "PRODUCTION_ARTIFACT_OUTPUT_UPLOAD_SEAL",
    );
  }
  const seal = captureProductionArtifactUploadSeal({
    root,
    cwd,
    environment,
    releaseContentSha256: environment.AXIAL_RELEASE_CONTENT_SHA256,
    commitSha: environment.AXIAL_COMMIT_SHA,
  });
  return appendProductionArtifactUploadSeal(
    environment.GITHUB_OUTPUT,
    seal,
  );
}

function runCli() {
  try {
    runPrepareProductionArtifactUploadCli();
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

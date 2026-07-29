import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {projectRoot} from "./lib/files.mjs";
import {
  checkProductionArtifactWorkspace,
  formatProductionArtifactWorkspaceError,
  ProductionArtifactWorkspaceError,
} from "./lib/production-artifact-workspace.mjs";

const ROOT = projectRoot();

export function runProductionArtifactWorkspaceCli({
  arguments_ = process.argv.slice(2),
  root = ROOT,
  cwd = process.cwd(),
  environment = process.env,
} = {}) {
  if (!Array.isArray(arguments_) || arguments_.length !== 0) {
    throw new ProductionArtifactWorkspaceError(
      "PRODUCTION_ARTIFACT_WORKSPACE_INPUT",
    );
  }
  return checkProductionArtifactWorkspace({
    root,
    cwd,
    environment,
  });
}

function runCli() {
  try {
    runProductionArtifactWorkspaceCli();
  } catch (error) {
    console.error(formatProductionArtifactWorkspaceError(error));
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runCli();
}

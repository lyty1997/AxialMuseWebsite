import {lstatSync, realpathSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {runProductionArtifactCheck} from "../build/build-site.mjs";
import {
  checkReleasePackage,
  formatReleasePackageError,
  ReleasePackageError,
} from "../release/lib/release-package.mjs";
import {projectRoot} from "./lib/files.mjs";

const ROOT = projectRoot();

export function assertCheckReleaseArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length !== 0) {
    throw new ReleasePackageError(
      "RELEASE_PACKAGE_INPUT",
      "release/arguments",
    );
  }
}

export function assertCheckReleaseWorkspace({
  root = ROOT,
  cwd = process.cwd(),
} = {}) {
  try {
    const realRoot = realpathSync(root);
    const realCwd = realpathSync(cwd);
    const metadata = lstatSync(realRoot);
    if (
      realRoot !== root
      || realCwd !== realRoot
      || metadata.isSymbolicLink()
      || !metadata.isDirectory()
    ) {
      throw new TypeError("release checker workspace mismatch");
    }
  } catch (cause) {
    throw new ReleasePackageError(
      "RELEASE_PACKAGE_WORKSPACE",
      "repository",
      {cause},
    );
  }
}

export function runCheckReleaseCli({
  arguments_ = process.argv.slice(2),
  root = ROOT,
  cwd = process.cwd(),
  standardOutput = process.stdout,
  verifyProductionBuild = ({repositoryRoot}) => (
    runProductionArtifactCheck({root: repositoryRoot})
  ),
} = {}) {
  assertCheckReleaseArguments(arguments_);
  assertCheckReleaseWorkspace({root, cwd});
  const result = checkReleasePackage({
    repositoryRoot: root,
    verifyProductionBuild,
  });
  standardOutput.write(
    `releaseContentSha256=${result.releaseContentSha256}\n`,
  );
  return result;
}

function runCli() {
  try {
    runCheckReleaseCli();
  } catch (error) {
    console.error(formatReleasePackageError(error));
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runCli();
}

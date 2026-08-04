import {lstatSync, realpathSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {runProductionArtifactCheck} from "../build/build-site.mjs";
import {projectRoot} from "../quality/lib/files.mjs";
import {
  formatReleasePackageError,
  packageSite,
  ReleasePackageError,
} from "./lib/release-package.mjs";

const ROOT = projectRoot();

export function assertPackageSiteArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length !== 0) {
    throw new ReleasePackageError(
      "RELEASE_PACKAGE_INPUT",
      "release/arguments",
    );
  }
}

export function assertPackageSiteWorkspace({
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
      throw new TypeError("release CLI workspace mismatch");
    }
  } catch (cause) {
    throw new ReleasePackageError(
      "RELEASE_PACKAGE_WORKSPACE",
      "repository",
      {cause},
    );
  }
}

export function runPackageSiteCli({
  arguments_ = process.argv.slice(2),
  root = ROOT,
  cwd = process.cwd(),
  standardOutput = process.stdout,
  verifyProductionBuild = ({repositoryRoot}) => (
    runProductionArtifactCheck({root: repositoryRoot})
  ),
} = {}) {
  assertPackageSiteArguments(arguments_);
  assertPackageSiteWorkspace({root, cwd});
  const result = packageSite({
    repositoryRoot: root,
    verifyProductionBuild,
  });
  standardOutput.write(
    "Release package created: "
      + `commitSha=${result.commitSha} `
      + `sourceBuildTreeSha256=${result.sourceBuildTreeSha256}\n`,
  );
  return result;
}

function runCli() {
  try {
    runPackageSiteCli();
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

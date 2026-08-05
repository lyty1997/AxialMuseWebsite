import {dirname, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {
  formatNginxDockerAcceptanceError,
  runNginxDockerAcceptance,
} from "./lib/nginx-docker-acceptance.mjs";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export async function runCli() {
  try {
    const result = await runNginxDockerAcceptance({
      repositoryRoot: REPOSITORY_ROOT,
    });
    console.log(
      "Nginx runtime redirect acceptance passed: "
      + `image=${result.imageDigest}; `
      + `platform=${result.platform}; `
      + `nginx=${result.nginxVersion}; `
      + `registered=${result.registeredRuleCount}; `
      + `canonicalSlash=${result.canonicalSlashRuleCount}; `
      + `httpAssertions=${result.assertionCount}; `
      + "temporaryResources=removed; imageCache=retained.",
    );
    return 0;
  } catch (error) {
    console.error(formatNginxDockerAcceptanceError(error));
    return 1;
  }
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = await runCli();
}

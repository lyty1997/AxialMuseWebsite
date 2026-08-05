import {
  CANONICAL_ORIGIN,
  collectPublicHtmlRoutes,
  compileRuntimeRedirectArtifacts,
  readRedirectRegistryFromRepositoryRoot,
  RuntimeRedirectError,
  type RuntimeRedirectArtifacts,
} from "../../../scripts/release/lib/runtime-redirects.mjs";
import {failContentBuild} from "./errors.js";

export {CANONICAL_ORIGIN};

const REGISTRY_SOURCE_PATH = "docs/contracts/redirects.json";

function failFromRuntimeRedirect(error: unknown): never {
  if (error instanceof RuntimeRedirectError) {
    failContentBuild(
      "CONTENT_ARTIFACT_REDIRECTS",
      "production payload 的运行时重定向契约未通过。",
      {
        cause: error,
        sourcePath: error.sourcePath,
        upstreamCode: error.code,
      },
    );
  }
  failContentBuild(
    "CONTENT_ARTIFACT_REDIRECTS",
    "production payload 的运行时重定向检查发生未分类错误。",
    {
      cause: error,
      sourcePath: REGISTRY_SOURCE_PATH,
      upstreamCode: "RELEASE_REDIRECT_INTERNAL",
    },
  );
}

export function deriveProductionRuntimeRedirects(
  repositoryRoot: string,
  buildDirectory: string,
): RuntimeRedirectArtifacts {
  try {
    return compileRuntimeRedirectArtifacts({
      publicRoutes: collectPublicHtmlRoutes(buildDirectory),
      registry: readRedirectRegistryFromRepositoryRoot(repositoryRoot),
      canonicalOrigin: CANONICAL_ORIGIN,
    });
  } catch (error) {
    failFromRuntimeRedirect(error);
  }
}

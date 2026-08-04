import type {LoadContext} from "@docusaurus/types";
import {lstatSync, realpathSync} from "node:fs";
import {basename, isAbsolute, resolve} from "node:path";
import {readBuildContext} from "../site-config/index.js";
import {prepareStaticAssetPlan} from "../static-assets/index.js";
import type {StaticAssetPlan} from "../static-assets/index.js";
import {
  assertStaticAssetPlanInputsCurrent,
  getStaticAssetPlanInputDigest,
} from "../static-assets/plan.js";
import {
  combineContentBuildInputDigests,
  createContentBuildSealController,
} from "./build-seal.js";
import type {
  CurrentDocsContentSnapshot,
  DocusaurusDocsAdapterSession,
} from "./docs-adapter.js";
import {failContentBuild} from "./errors.js";
import {createParseFrontMatter} from "./frontmatter-projection.js";
import {
  assertLoadedContentFilesCurrent,
  getLoadedContentPrivateState,
  loadValidatedContent,
} from "./loader.js";
import {createSidebarItemsGenerator} from "./sidebar-generator.js";
import type {LoadedValidatedContent} from "./types.js";

const PHASE_ENV = "AXIAL_MUSE_BUILD_PHASE";
const OUTPUT_ENV = "AXIAL_MUSE_BUILD_OUTPUT";
const validatedContentBuildSessions = new WeakSet<object>();

export type ContentBuildPhase = "build" | "check" | "verify" | "release";

export interface ContentBuildSession {
  readonly content: LoadedValidatedContent;
  readonly staticPlan: StaticAssetPlan;
  readonly phase: ContentBuildPhase;
  readonly outputDirectory: string;
  readonly docsAdapterSession: DocusaurusDocsAdapterSession;
  publishStaticAssets(buildDirectory: string): void;
  writeBuildSeal(): void;
  assertBuildSeal(): void;
}

export function assertContentBuildSession(
  value: unknown,
): asserts value is ContentBuildSession {
  if (
    value === null
    || typeof value !== "object"
    || !Object.isFrozen(value)
    || !validatedContentBuildSessions.has(value)
  ) {
    failContentBuild(
      "CONTENT_PLUGIN_SESSION_PROVENANCE",
      "内容数据插件只接受本次完整构建创建的 session。",
      {sourcePath: "site-content"},
    );
  }
}

function readPhaseAndOutput(
  repositoryRoot: string,
  mode: "production" | "preview",
  owner: string,
  environment: NodeJS.ProcessEnv,
): Readonly<{phase: ContentBuildPhase; outputDirectory: string}> {
  const phase = environment[PHASE_ENV];
  const output = environment[OUTPUT_ENV];
  let expectedName: string | undefined;
  let expectedOutput: string | undefined;
  if (mode === "production") {
    expectedName = phase === "verify" || phase === "release"
      ? "build"
      : `.axial-muse-build-candidate-${owner}`;
    expectedOutput = resolve(repositoryRoot, expectedName);
  } else {
    const stateRoot = environment.PREVIEW_STATE_DIR;
    const candidate = environment.AXIAL_MUSE_PREVIEW_CANDIDATE;
    const commitSha = environment.AXIAL_MUSE_PREVIEW_COMMIT_SHA;
    const controllerPid = environment.AXIAL_MUSE_PREVIEW_CONTROLLER_PID;
    if (
      (phase !== "build" && phase !== "check")
      || typeof stateRoot !== "string"
      || !isAbsolute(stateRoot)
      || realpathSync(stateRoot) !== stateRoot
      || typeof candidate !== "string"
      || !isAbsolute(candidate)
      || !/^[0-9a-f]{40}$/u.test(commitSha ?? "")
      || !/^[1-9][0-9]*$/u.test(controllerPid ?? "")
    ) {
      failContentBuild("CONTENT_SESSION_PREVIEW_ENV", "preview 内容构建身份不完整。", {
        sourcePath: "build",
      });
    }
    expectedName = `${commitSha}.${controllerPid}`;
    expectedOutput = resolve(stateRoot, "candidates", expectedName);
    if (candidate !== expectedOutput) {
      failContentBuild("CONTENT_SESSION_PREVIEW_ENV", "preview 候选不属于当前提交与控制进程。", {
        sourcePath: "build",
      });
    }
  }
  if (
    (
      phase !== "build"
      && phase !== "check"
      && phase !== "verify"
      && phase !== "release"
    )
    || typeof output !== "string"
    || !isAbsolute(output)
    || basename(output) !== expectedName
    || output !== expectedOutput
  ) {
    failContentBuild("CONTENT_SESSION_ENV", "内容构建阶段或候选输出身份不合法。", {
      sourcePath: "build",
    });
  }
  try {
    const metadata = lstatSync(output);
    if (phase === "build") {
      failContentBuild("CONTENT_SESSION_OUTPUT_EXISTS", "build 候选目录在构建前必须不存在。", {
        sourcePath: "build",
      });
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      failContentBuild("CONTENT_SESSION_OUTPUT", "待检查候选不是普通目录。", {
        sourcePath: "build",
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (phase === "check" || phase === "verify" || phase === "release") {
      failContentBuild("CONTENT_SESSION_OUTPUT", "验收阶段缺少待检查制品。", {
        sourcePath: "build",
      });
    }
  }
  return Object.freeze({phase, outputDirectory: output});
}

function docSource(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "source");
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function assertExactSources(
  values: readonly unknown[],
  expected: ReadonlySet<string>,
  code: string,
): void {
  const actual = new Set<string>();
  for (const value of values) {
    const source = docSource(value);
    if (source === undefined || actual.has(source) || !expected.has(source)) {
      failContentBuild(code, "官方 docs 内容集合与唯一投影不一致。", {
        sourcePath: source?.startsWith("@site/") ? source.slice(6) : "site-content",
      });
    }
    actual.add(source);
  }
  if (actual.size !== expected.size || [...expected].some((source) => !actual.has(source))) {
    failContentBuild(code, "官方 docs 内容集合缺少已验证成员。", {
      sourcePath: "site-content",
    });
  }
}

function expectedDocsVersion(
  content: LoadedValidatedContent,
): DocusaurusDocsAdapterSession["expectedVersion"] {
  const contentPath = resolve(content.repositoryRoot, "site-content");
  const sidebarFilePath = resolve(content.repositoryRoot, "sidebars.ts");
  try {
    const contentMetadata = lstatSync(contentPath);
    const sidebarMetadata = lstatSync(sidebarFilePath);
    if (
      contentMetadata.isSymbolicLink()
      || !contentMetadata.isDirectory()
      || sidebarMetadata.isSymbolicLink()
      || !sidebarMetadata.isFile()
      || realpathSync(contentPath) !== contentPath
      || realpathSync(sidebarFilePath) !== sidebarFilePath
    ) {
      throw new TypeError("docs version paths are not unique physical entries");
    }
  } catch (error) {
    failContentBuild(
      "CONTENT_DOCS_VERSION_ROOT",
      "唯一 docs 内容根或侧栏文件不是仓库内规范物理成员。",
      {cause: error, sourcePath: "site-content"},
    );
  }
  return Object.freeze({
    path: "/",
    contentPath,
    sidebarFilePath,
  });
}

function createDocsAdapterSession(content: LoadedValidatedContent): DocusaurusDocsAdapterSession {
  return Object.freeze({
    mode: content.mode,
    expectedVersion: expectedDocsVersion(content),
    assertCurrentDocsContent(snapshot: CurrentDocsContentSnapshot): void {
      assertLoadedContentFilesCurrent(content);
      const publicSources = new Set<string>();
      const unpublishedSources = new Set<string>();
      for (const source of content.sources) {
        const alias = `@site/${source.sourcePath}`;
        const isPublic = source.kind === "project"
          ? content.projectNavigation.some((project) => project.sourcePath === source.sourcePath)
          : content.articles.some((article) => (
              article.sourcePath === source.sourcePath
              && article.publicationStatus !== "draft"
            ));
        (isPublic ? publicSources : unpublishedSources).add(alias);
      }
      if (content.mode === "production") {
        assertExactSources(snapshot.docs, publicSources, "CONTENT_DOCS_PUBLIC_SET");
        assertExactSources(snapshot.drafts, unpublishedSources, "CONTENT_DOCS_DRAFT_SET");
      } else {
        assertExactSources(
          snapshot.docs,
          new Set([...publicSources, ...unpublishedSources]),
          "CONTENT_DOCS_PREVIEW_SET",
        );
        assertExactSources(snapshot.drafts, new Set(), "CONTENT_DOCS_PREVIEW_DRAFT_SET");
      }
    },
  });
}

export async function createContentBuildSession(
  context: LoadContext,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ContentBuildSession> {
  const buildContext = readBuildContext(environment);
  if (
    context.siteDir !== resolve(context.siteDir)
    || realpathSync(context.siteDir) !== context.siteDir
  ) {
    failContentBuild("CONTENT_SESSION_ROOT", "Docusaurus siteDir 不是规范绝对仓库根。", {
      sourcePath: "site-content",
    });
  }
  const {phase, outputDirectory} = readPhaseAndOutput(
    context.siteDir,
    buildContext.mode,
    buildContext.owner,
    environment,
  );
  const content = await loadValidatedContent({
    repositoryRoot: context.siteDir,
    mode: buildContext.mode,
  });
  const privateState = getLoadedContentPrivateState(content);
  let staticPlan: StaticAssetPlan | undefined;
  try {
    staticPlan = prepareStaticAssetPlan({
      mode: content.mode,
      repositoryRoot: content.repositoryRoot,
      catalog: content.catalog,
      staticPublicRegistry: content.staticPublicRegistry,
      unpublishedAssets: privateState.unpublishedAssets,
    });
  } finally {
    for (const asset of privateState.unpublishedAssets) asset.bytes.fill(0);
  }
  try {
    const sealController = createContentBuildSealController({
      repositoryRoot: context.siteDir,
      mode: buildContext.mode,
      owner: buildContext.owner,
      phase,
      inputDigest: combineContentBuildInputDigests(
        privateState.inputDigest,
        getStaticAssetPlanInputDigest(staticPlan),
      ),
      environment,
      assertInputsCurrent(): void {
        assertLoadedContentFilesCurrent(content);
        assertStaticAssetPlanInputsCurrent(staticPlan);
      },
    });
    staticPlan.materialize(buildContext);
    context.siteConfig.markdown.parseFrontMatter = createParseFrontMatter(content);
    const session = Object.freeze({
      content,
      staticPlan,
      phase,
      outputDirectory,
      docsAdapterSession: createDocsAdapterSession(content),
      publishStaticAssets(buildDirectory: string): void {
        if (
          phase !== "build"
          || resolve(buildDirectory) !== outputDirectory
        ) {
          failContentBuild(
            "CONTENT_STATIC_PUBLISH_PHASE",
            "静态白名单只允许发布到当前 build 候选。",
            {sourcePath: "build"},
          );
        }
        staticPlan.publish(buildContext, outputDirectory);
      },
      writeBuildSeal: sealController.write,
      assertBuildSeal: sealController.assert,
    });
    validatedContentBuildSessions.add(session);
    return session;
  } catch (error) {
    staticPlan.dispose();
    throw error;
  }
}

export function sessionSidebarItemsGenerator(session: ContentBuildSession) {
  return createSidebarItemsGenerator(session.content);
}

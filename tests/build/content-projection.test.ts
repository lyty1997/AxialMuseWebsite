import assert from "node:assert/strict";
import fs, {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import test from "node:test";
import {
  createContentDataPlugin,
  createParseFrontMatter,
  createSidebarItemsGenerator,
  loadValidatedContent,
} from "../../src/build/content/index.js";
import {createContentDataPluginForTest} from "../../src/build/content/content-data-plugin.js";
import {
  assertLoadedContentFilesCurrent,
  getLoadedContentPrivateState,
  loadValidatedContentWithParser,
} from "../../src/build/content/loader.js";
import {
  createProjectPreviewRemarkPluginForTest,
} from "../../src/build/content/project-preview-projection.js";

const ARTICLE_DATE_INDEX_SOURCE_PATH = "axial-muse/article-date-index.json";
const ARTICLE_IDS = Object.freeze({
  published: "018f0000-0000-7000-8000-000000000001",
  archived: "018f0000-0000-7000-8000-000000000002",
  draft: "018f0000-0000-7000-8000-000000000003",
});

interface FixtureOptions {
  readonly draftPreview?: boolean;
  readonly duplicateArticleRoute?: boolean;
}

type LoadedContent = Awaited<ReturnType<typeof loadValidatedContent>>;
type FileSystemOverrides = Partial<Pick<
  typeof fs,
  "closeSync" | "readFileSync" | "renameSync" | "unlinkSync"
>>;

let fileSystemOverridesActive = false;

async function withFileSystemOverrides<T>(
  overrides: FileSystemOverrides,
  action: () => T | Promise<T>,
): Promise<T> {
  assert.equal(fileSystemOverridesActive, false);
  const originals: Required<FileSystemOverrides> = {
    closeSync: fs.closeSync,
    readFileSync: fs.readFileSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
  };
  fileSystemOverridesActive = true;
  try {
    Object.assign(fs, overrides);
    syncBuiltinESMExports();
    return await action();
  } finally {
    try {
      Object.assign(fs, originals);
      syncBuiltinESMExports();
    } finally {
      fileSystemOverridesActive = false;
    }
  }
}

function writeJson(repositoryRoot: string, sourcePath: string, value: unknown): void {
  const absolutePath = resolve(repositoryRoot, sourcePath);
  mkdirSync(resolve(absolutePath, ".."), {recursive: true, mode: 0o700});
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function writeText(repositoryRoot: string, sourcePath: string, value: string): void {
  const absolutePath = resolve(repositoryRoot, sourcePath);
  mkdirSync(resolve(absolutePath, ".."), {recursive: true, mode: 0o700});
  writeFileSync(absolutePath, value, {encoding: "utf8", mode: 0o600});
}

function replaceWithSameBytes(absolutePath: string): void {
  const bytes = readFileSync(absolutePath);
  const replacementPath = `${absolutePath}.replacement`;
  writeFileSync(replacementPath, bytes, {mode: 0o600});
  renameSync(replacementPath, absolutePath);
}

function projectRecord(
  id: string,
  title: string,
  navigationOrder: number,
  publicationStatus: "draft" | "published" | "archived",
  writingModules: readonly Record<string, unknown>[] = [],
  hasPreview = publicationStatus === "published" || publicationStatus === "archived",
): Record<string, unknown> {
  return {
    id,
    title,
    slug: id,
    navigationOrder,
    summary: `Traceable project summary for ${id} with sufficient fixture evidence.`,
    status: publicationStatus === "archived" ? "archived" : "active",
    publicationStatus,
    startedAt: "2026-01",
    updatedAt: "2026-07-20",
    repositoryUrl: `https://example.com/${id}`,
    productionBranch: "main",
    showcaseMode: "repository",
    writingModules,
    ...(hasPreview
      ? {
          previewImage: {
            sourcePath: `projects/${id}/overview.webp`,
            width: 1600,
            height: 1000,
            alt: `${title} interface with independently verified fixture evidence`,
          },
        }
      : {}),
    source: [`docs/projects/${id}.md`],
  };
}

function articleFrontMatter(
  articleId: string,
  title: string,
  slug: string,
  publicationStatus: "draft" | "published" | "archived",
  options: Readonly<{
    publishedAt?: string;
    updatedAt?: string;
    project?: string;
    module?: string;
  }> = {},
): string {
  const frontMatter = {
    articleId,
    title,
    slug,
    summary: `A traceable technical article for ${title} with sufficient fixture evidence.`,
    publicationStatus,
    authors: ["example-author"],
    ...(options.publishedAt === undefined ? {} : {publishedAt: options.publishedAt}),
    ...(options.updatedAt === undefined ? {} : {updatedAt: options.updatedAt}),
    classification: {
      ...(options.project === undefined ? {} : {project: options.project}),
      ...(options.module === undefined ? {} : {module: options.module}),
      topics: ["architecture"],
    },
  };
  return `---
${JSON.stringify(frontMatter)}
---
## 技术问题

独立正文指纹 ${articleId.slice(-4)} 保留可复核的实现与测试证据。
`;
}

function parseFixtureFrontMatter({
  fileContent,
}: Readonly<{fileContent: string; filePath: string}>) {
  if (!fileContent.startsWith("---\n")) {
    return {frontMatter: {}, content: fileContent};
  }
  const closing = fileContent.indexOf("\n---\n", 4);
  assert.notEqual(closing, -1);
  return {
    frontMatter: JSON.parse(fileContent.slice(4, closing)),
    content: fileContent.slice(closing + 5),
  };
}

function loadFixtureContent(
  input: Parameters<typeof loadValidatedContent>[0],
): ReturnType<typeof loadValidatedContent> {
  return loadValidatedContentWithParser(input, parseFixtureFrontMatter);
}

function createFixture(options: FixtureOptions = {}): string {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "axial-muse-content-projection-"));
  chmodSync(repositoryRoot, 0o700);
  mkdirSync(resolve(repositoryRoot, "site-content/projects"), {recursive: true, mode: 0o700});
  mkdirSync(resolve(repositoryRoot, "site-content/writing"), {recursive: true, mode: 0o700});

  writeJson(repositoryRoot, "docs/contracts/projects.json", {
    version: "0.3.0",
    kind: "axial_muse_projects",
    status: "active",
    owner: "AxialMuseWebsite",
    lifecycleStatusValues: ["active", "paused", "completed", "archived"],
    publicationStatusValues: ["draft", "planned", "published", "archived"],
    showcaseModes: ["repository", "repository-and-video"],
    projects: [
      projectRecord(
        "draft-project",
        "Draft Project",
        30,
        "draft",
        [],
        options.draftPreview === true,
      ),
      projectRecord("published-project", "Published Project", 20, "published", [{
        id: "architecture-module",
        displayName: "架构模块",
        navigationOrder: 10,
        status: "active",
      }]),
      projectRecord("archived-project", "Archived Project", 10, "archived"),
    ],
  });
  writeJson(repositoryRoot, "docs/contracts/authors.json", {
    version: "0.1.0",
    kind: "axial_muse_authors",
    status: "active",
    owner: "AxialMuseWebsite",
    authors: {
      "example-author": {displayName: "示例作者"},
    },
  });
  writeJson(repositoryRoot, "docs/contracts/topics.json", {
    version: "0.1.0",
    kind: "axial_muse_topics",
    status: "active",
    owner: "AxialMuseWebsite",
    topics: {
      architecture: {
        displayName: "架构",
        navigationOrder: 10,
        status: "active",
      },
    },
  });
  writeJson(repositoryRoot, "docs/contracts/project-experiences.json", {
    version: "0.1.0",
    kind: "axial_muse_project_experiences",
    status: "active",
    owner: "AxialMuseWebsite",
    canonicalDomain: "axialmuse.com",
    defaultDeliveryMode: "static",
    defaultIndexing: "noindex",
    statusValues: ["planned", "provisioning", "live", "paused", "retired"],
    deliveryModes: ["static"],
    reservedSubdomains: [
      "www", "api", "admin", "auth", "account", "assets", "cdn", "dev",
      "docs", "mail", "preview", "staging", "static", "status", "support",
    ],
    experiences: [],
  });
  writeJson(repositoryRoot, "docs/contracts/static-public-assets.json", {
    version: "0.1.0",
    kind: "axial_muse_static_public_assets",
    status: "active",
    owner: "AxialMuseWebsite",
    roleValues: ["brand", "operational"],
    assets: [],
  });

  for (const projectId of ["archived-project", "draft-project", "published-project"]) {
    writeText(
      repositoryRoot,
      `site-content/projects/${projectId}/index.md`,
      `## ${projectId}\n\n项目正文提供稳定且可复核的实现证据。\n`,
    );
  }
  writeText(
    repositoryRoot,
    "site-content/writing/published-article/index.md",
    articleFrontMatter(
      ARTICLE_IDS.published,
      "Published Article",
      "/writing/published-article",
      "published",
      {publishedAt: "2026-07-10", updatedAt: "2026-07-20"},
    ),
  );
  writeText(
    repositoryRoot,
    "site-content/writing/archived-article/index.md",
    articleFrontMatter(
      ARTICLE_IDS.archived,
      "Archived Article",
      "/writing/archived-article",
      "archived",
      {
        publishedAt: "2026-07-11",
        updatedAt: "2026-07-19",
        project: "published-project",
        module: "architecture-module",
      },
    ),
  );
  writeText(
    repositoryRoot,
    "site-content/writing/draft-article/index.md",
    articleFrontMatter(
      ARTICLE_IDS.draft,
      "Draft Article",
      options.duplicateArticleRoute === true
        ? "/writing/published-article"
        : "/writing/draft-article",
      "draft",
      {updatedAt: "2026-07-21", project: "draft-project"},
    ),
  );
  return repositoryRoot;
}

async function withFixture(
  action: (repositoryRoot: string) => Promise<void>,
  options: FixtureOptions = {},
): Promise<void> {
  const repositoryRoot = createFixture(options);
  try {
    await action(repositoryRoot);
  } finally {
    rmSync(repositoryRoot, {recursive: true, force: true});
  }
}

function assertBuildError(
  expectedCode: string,
  expectedUpstreamCode?: string,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "ContentBuildError");
    const value = error as Error & Readonly<{code?: string; upstreamCode?: string}>;
    assert.equal(value.code, expectedCode);
    if (expectedUpstreamCode !== undefined) {
      assert.equal(value.upstreamCode, expectedUpstreamCode);
    }
    return true;
  };
}

function assertBuildErrorCause(
  expectedCode: string,
  expectedSourcePath: string,
  assertCause: (cause: unknown) => void,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assertBuildError(expectedCode)(error);
    const value = error as Error & Readonly<{
      cause?: unknown;
      sourcePath?: string;
    }>;
    assert.equal(value.sourcePath, expectedSourcePath);
    assertCause(value.cause);
    return true;
  };
}

function assertAggregateCause(
  cause: unknown,
  operationError: unknown,
  secondaryError: unknown,
): void {
  assert.ok(cause instanceof AggregateError);
  assert.equal(cause.errors.length, 2);
  assert.strictEqual(cause.errors[0], operationError);
  assert.strictEqual(cause.errors[1], secondaryError);
}

function publicSourcePaths(content: LoadedContent): ReadonlySet<string> {
  return new Set([
    ...content.projectNavigation.map((project) => project.sourcePath),
    ...content.articles
      .filter((article) => article.publicationStatus !== "draft")
      .map((article) => article.sourcePath),
  ]);
}

function frameworkDocs(
  content: LoadedContent,
): Array<Readonly<Record<string, unknown>>> {
  const visible = content.mode === "preview"
    ? new Set(content.sources.map((source) => source.sourcePath))
    : publicSourcePaths(content);
  return content.sources
    .filter((source) => visible.has(source.sourcePath))
    .map((source, index) => ({
      id: `framework-generated-${index}-${source.kind}`,
      title: source.sourcePath,
      frontMatter: {},
      source: `@site/${source.sourcePath}`,
      sourceDirName: source.sourcePath.split("/").slice(0, -1).join("/"),
      sidebarPosition: undefined,
    }));
}

function sidebarArguments(
  content: LoadedContent,
  dirName: "projects" | "writing",
  docs = frameworkDocs(content),
): Record<string, unknown> {
  return {
    item: {type: "autogenerated", dirName},
    version: {
      versionName: "current",
      contentPath: `${content.repositoryRoot}/site-content`,
    },
    docs,
    categoriesMetadata: {},
    defaultSidebarItemsGenerator: async () => [],
    isCategoryIndex: () => false,
    numberPrefixParser: {parse: (value: string) => ({filename: value})},
  };
}

function docIdBySource(
  docs: readonly Readonly<Record<string, unknown>>[],
): ReadonlyMap<string, string> {
  return new Map(docs.map((doc) => [
    String(doc.source).slice("@site/".length),
    String(doc.id),
  ]));
}

function projectPreviewManifestFiles(content: LoadedContent) {
  return content.catalog.projects.flatMap((project) => {
    const preview = project.previewImage;
    const visible = content.mode === "preview"
      || project.publicationStatus === "published"
      || project.publicationStatus === "archived";
    if (preview === undefined || !visible) return [];
    return [{
      kind: "project-preview" as const,
      sourcePath: `site-assets/${preview.sourcePath}`,
      targetPath: `assets/${preview.sourcePath}`,
      publicUrl: `/assets/${preview.sourcePath}`,
      projectId: project.id,
    }];
  });
}

function projectPreviewSession(
  content: LoadedContent,
  files = projectPreviewManifestFiles(content),
) {
  return {
    content,
    staticPlan: {
      manifest: {
        mode: content.mode,
        files,
        excludedFiles: [],
      },
    },
  } as never;
}

interface ArtifactSidebarLink {
  readonly href: string;
  readonly label: string;
}

function artifactNavigationLabel(
  item: Readonly<{title: string; publicationStatus: string}>,
): string {
  return item.publicationStatus === "archived"
    ? `${item.title}（归档）`
    : item.title;
}

function artifactProjectSidebar(content: LoadedContent): readonly ArtifactSidebarLink[] {
  return content.projectNavigation.map((item) => ({
    href: item.canonicalPath,
    label: artifactNavigationLabel(item),
  }));
}

function artifactWritingSidebar(content: LoadedContent): readonly ArtifactSidebarLink[] {
  return content.writingNavigation.flatMap((group) => {
    if (group.kind === "general" || group.kind === "draft") {
      return group.articles.map((item) => ({
        href: item.canonicalPath,
        label: artifactNavigationLabel(item),
      }));
    }
    return [
      ...group.rootArticles.map((item) => ({
        href: item.canonicalPath,
        label: artifactNavigationLabel(item),
      })),
      ...group.modules.flatMap((module) => module.articles.map((item) => ({
        href: item.canonicalPath,
        label: artifactNavigationLabel(item),
      }))),
    ];
  });
}

function escapeFixtureHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function artifactSidebarHtml(
  links: readonly ArtifactSidebarLink[],
  categoryLabel?: string,
): string {
  const leaves = links.map((link) => (
    `<li class="theme-doc-sidebar-item-link theme-doc-sidebar-item-link-level-2 menu__list-item">`
    + `<a class="menu__link" href="${escapeFixtureHtml(link.href)}">`
    + `<span class="linkLabel_fixture">${escapeFixtureHtml(link.label)}</span></a>`
  )).join("");
  const menu = categoryLabel === undefined
    ? leaves
    : `<li class="theme-doc-sidebar-item-category theme-doc-sidebar-item-category-level-1 menu__list-item">`
      + `<div class="menu__list-item-collapsible"><a class="menu__link menu__link--sublist" role="button" href="${escapeFixtureHtml(links[0]?.href ?? "/")}">`
      + `<span>${escapeFixtureHtml(categoryLabel)}</span></a></div><ul class="menu__list">${leaves}</ul>`;
  return `<aside class="theme-doc-sidebar-container docSidebarContainer_fixture">`
    + `<nav aria-label="Docs sidebar" class="menu thin-scrollbar">`
    + `<ul class="theme-doc-sidebar-menu menu__list">${menu}</ul></nav></aside>`;
}

function artifactPageHtml(route: string, sidebar = ""): string {
  return "<!doctype html><html><head>"
    + `<link rel="canonical" href="https://www.axialmuse.com${route}">`
    + `</head><body><a href="/unrelated/">全页无关链接</a>${sidebar}`
    + "<main>fixture</main></body></html>";
}

function artifactHtmlPath(route: string): string {
  return route === "/" ? "index.html" : `${route.slice(1)}index.html`;
}

function createArtifactFixture(
  repositoryRoot: string,
  content: LoadedContent,
): Readonly<{buildDirectory: string; generatedFilesDirectory: string}> {
  writeText(repositoryRoot, "src/pages/index.tsx", "export default function Home() { return null; }\n");
  writeText(repositoryRoot, "src/pages/projects.tsx", "export default function Projects() { return null; }\n");
  writeText(repositoryRoot, "src/pages/writing.tsx", "export default function Writing() { return null; }\n");
  const buildDirectory = resolve(repositoryRoot, "artifact-build");
  mkdirSync(buildDirectory, {recursive: true, mode: 0o700});
  const projectSidebar = artifactProjectSidebar(content);
  const writingSidebar = artifactWritingSidebar(content);
  const pageRoutes = ["/", "/projects/", "/writing/"];
  const detailRoutes = [
    ...projectSidebar.map((link) => link.href),
    ...writingSidebar.map((link) => link.href),
  ];
  for (const route of [...pageRoutes, ...detailRoutes]) {
    const sidebar = projectSidebar.some((link) => link.href === route)
      ? artifactSidebarHtml(projectSidebar)
      : writingSidebar.some((link) => link.href === route)
        ? artifactSidebarHtml(writingSidebar, "技术分享")
        : "";
    writeText(buildDirectory, artifactHtmlPath(route), artifactPageHtml(route, sidebar));
  }
  writeText(buildDirectory, "404.html", "<!doctype html><html><body>404</body></html>");
  const expectedUrls = [...pageRoutes, ...detailRoutes]
    .map((route) => `https://www.axialmuse.com${route}`)
    .sort();
  writeText(
    buildDirectory,
    "sitemap.xml",
    `<?xml version="1.0"?><urlset>${expectedUrls.map((url) => (
      `<url><loc>${url}</loc></url>`
    )).join("")}</urlset>\n`,
  );
  const published = content.articleDateIndex[0];
  assert.ok(published);
  writeText(
    buildDirectory,
    "assets/js/main.fixture.js",
    `self.normalArticle={articleId:"${published.articleId}",title:"Normal detail",slug:"${published.slug}",summary:"public",publicationStatus:"published",publishedAt:"${published.publishedAt}",updatedAt:"${published.updatedAt}",classification:{topics:[]}};\n`,
  );
  const generatedFilesDirectory = resolve(repositoryRoot, ".docusaurus");
  mkdirSync(resolve(generatedFilesDirectory, "axial-muse"), {
    recursive: true,
    mode: 0o700,
  });
  writeText(
    generatedFilesDirectory,
    "axial-muse/article-date-index.json",
    `${JSON.stringify(content.articleDateIndex, null, 2)}\n`,
  );
  return {buildDirectory, generatedFilesDirectory};
}

async function invokeArtifactCheck(
  content: LoadedContent,
  buildDirectory: string,
  generatedFilesDirectory: string,
  options: Readonly<{
    failSealAssertionAt?: number;
    trace?: {sealAssertions: number; staticAssertions: number; disposals: number};
  }> = {},
): Promise<Readonly<{
  sealAssertions: number;
  staticAssertions: number;
  disposals: number;
}>> {
  const trace = options.trace ?? {
    sealAssertions: 0,
    staticAssertions: 0,
    disposals: 0,
  };
  const staticPlan = Object.freeze({
    manifest: Object.freeze({mode: "production", files: [], excludedFiles: []}),
    materialize() {
      throw new Error("artifact fixture must not materialize");
    },
    assertProductionBuild(actual: string) {
      assert.equal(actual, buildDirectory);
      trace.staticAssertions += 1;
    },
    dispose() {
      trace.disposals += 1;
    },
  });
  const session = Object.freeze({
    content,
    docsAdapterSession: Object.freeze({}),
    outputDirectory: buildDirectory,
    phase: "check" as const,
    staticPlan,
    writeBuildSeal() {
      throw new Error("check fixture must not write seal");
    },
    assertBuildSeal() {
      trace.sealAssertions += 1;
      if (trace.sealAssertions === options.failSealAssertionAt) {
        throw new Error("fixture build seal drift");
      }
    },
  });
  const pluginModule = createContentDataPluginForTest(session as never);
  const plugin = await pluginModule({generatedFilesDir: generatedFilesDirectory} as never, undefined);
  assert.ok(plugin?.extendCli);
  let action: (() => Promise<void>) | undefined;
  const command = {
    description() {
      return command;
    },
    action(callback: () => Promise<void>) {
      action = callback;
      return command;
    },
  };
  plugin.extendCli({
    command(name: string) {
      assert.equal(name, "axial-muse:check-production");
      return command;
    },
  } as never);
  assert.ok(action);
  await action();
  return Object.freeze({...trace});
}

test("E-016 loader 每次形成唯一深冻结链，production/preview 投影不复用或回退", async () => {
  await withFixture(async (repositoryRoot) => {
    const production = await loadFixtureContent({repositoryRoot, mode: "production"});
    const preview = await loadFixtureContent({repositoryRoot, mode: "preview"});

    assert.notEqual(production, preview);
    assert.notEqual(production.catalog, preview.catalog);
    assert.notEqual(production.articles, preview.articles);
    assert.equal(Object.isFrozen(production), true);
    assert.equal(Object.isFrozen(production.catalog), true);
    assert.equal(Object.isFrozen(production.articles), true);
    assert.deepEqual(
      production.projectNavigation.map((project) => [
        project.projectId,
        project.publicationStatus,
      ]),
      [
        ["archived-project", "archived"],
        ["published-project", "published"],
      ],
    );
    assert.deepEqual(production.writingNavigation.map((group) => group.kind), [
      "general",
      "project",
    ]);
    assert.deepEqual(preview.writingNavigation.map((group) => group.kind), [
      "general",
      "project",
      "draft",
    ]);
    const draftGroup = preview.writingNavigation.at(-1);
    assert.ok(draftGroup?.kind === "draft");
    assert.deepEqual(
      draftGroup.articles.map((article) => article.articleId),
      [ARTICLE_IDS.draft],
    );
    assert.deepEqual(production.articleDateIndex, preview.articleDateIndex);
    assert.deepEqual(
      production.articleDateIndex.map((entry) => entry.articleId),
      [ARTICLE_IDS.published, ARTICLE_IDS.archived],
    );

    const forged = structuredClone(production);
    assert.throws(
      () => createParseFrontMatter(forged),
      assertBuildError("CONTENT_BUILD_PROVENANCE"),
    );
    assert.throws(
      () => createSidebarItemsGenerator(forged),
      assertBuildError("CONTENT_BUILD_PROVENANCE"),
    );
    assert.throws(
      () => createContentDataPlugin(Object.freeze({content: production}) as never),
      assertBuildError("CONTENT_PLUGIN_SESSION_PROVENANCE"),
    );
    assert.throws(
      () => createContentDataPluginForTest(Object.freeze({content: forged}) as never),
      assertBuildError("CONTENT_BUILD_PROVENANCE"),
    );
  });
});

test("E-016 loader 先捕获整批字节，解析期间后续正文漂移不能形成混合快照", async () => {
  await withFixture(async (repositoryRoot) => {
    const targetPath = resolve(
      repositoryRoot,
      "site-content/writing/published-article/index.md",
    );
    const original = readFileSync(targetPath, "utf8");
    let parserCalls = 0;
    let observedCapturedTarget = false;
    await assert.rejects(
      () => loadValidatedContentWithParser(
        {repositoryRoot, mode: "production"},
        (input) => {
          if (parserCalls === 0) {
            writeFileSync(targetPath, `${original}\n解析期间漂移。\n`, {
              encoding: "utf8",
              mode: 0o600,
            });
          }
          parserCalls += 1;
          if (input.filePath === targetPath) {
            observedCapturedTarget = true;
            assert.equal(input.fileContent, original);
          }
          return parseFixtureFrontMatter(input);
        },
      ),
      assertBuildError("CONTENT_LOAD_SNAPSHOT_DRIFT"),
    );
    assert.equal(observedCapturedTarget, true);
    assert.equal(parserCalls, 6);
  });
});

test("E-016 loader 扫描结束拒绝同字节 registry 替换与内容目录成员漂移", async () => {
  await withFixture(async (repositoryRoot) => {
    const registryPath = resolve(repositoryRoot, "docs/contracts/projects.json");
    let replaced = false;
    await assert.rejects(
      () => loadValidatedContentWithParser(
        {repositoryRoot, mode: "production"},
        (input) => {
          if (!replaced) {
            replaced = true;
            replaceWithSameBytes(registryPath);
          }
          return parseFixtureFrontMatter(input);
        },
      ),
      assertBuildError("CONTENT_LOAD_SNAPSHOT_DRIFT"),
    );
    assert.equal(replaced, true);
  });

  await withFixture(async (repositoryRoot) => {
    let inserted = false;
    await assert.rejects(
      () => loadValidatedContentWithParser(
        {repositoryRoot, mode: "production"},
        (input) => {
          if (!inserted) {
            inserted = true;
            mkdirSync(
              resolve(repositoryRoot, "site-content/writing/injected-member"),
              {mode: 0o700},
            );
          }
          return parseFixtureFrontMatter(input);
        },
      ),
      assertBuildError("CONTENT_LOAD_SNAPSHOT_DRIFT"),
    );
    assert.equal(inserted, true);
  });
});

test("E-016 loader 拒绝 projects 下未登记或残留的空实体目录", async () => {
  await withFixture(async (repositoryRoot) => {
    mkdirSync(
      resolve(repositoryRoot, "site-content/projects/unregistered-empty"),
      {mode: 0o700},
    );
    await assert.rejects(
      () => loadFixtureContent({repositoryRoot, mode: "production"}),
      assertBuildError("CONTENT_LOAD_LAYOUT"),
    );
  });
});

test("E-016 loader 拒绝经父目录 symlink 进入替代注册表根", async () => {
  await withFixture(async (repositoryRoot) => {
    const docsRoot = resolve(repositoryRoot, "docs");
    const alternateDocsRoot = resolve(repositoryRoot, "alternate-docs-root");
    renameSync(docsRoot, alternateDocsRoot);
    symlinkSync(alternateDocsRoot, docsRoot, "dir");
    await assert.rejects(
      () => loadFixtureContent({repositoryRoot, mode: "production"}),
      assertBuildError("CONTENT_LOAD_CONTRACT_ROOT"),
    );
  });
});

test("E-016 loader 关闭 MDX 二次读取并只允许同实体正文素材", async () => {
  for (const fixture of [
    {
      body: 'import Home from "../../../src/pages/index.tsx";\n\n<Home />\n',
      extension: "mdx",
    },
    {body: "## 漂移表达式\n\n{Date.now()}\n", extension: "mdx"},
    {body: "## 普通 Markdown 漂移表达式\n\n{Date.now()}\n", extension: "md"},
    {body: '<img src="https://example.test/outside.png" alt="x" />\n', extension: "mdx"},
    {body: '<img src="../../../outside.png" alt="x" />\n', extension: "mdx"},
    {body: '<iframe src="https://example.test/embed"></iframe>\n', extension: "mdx"},
    {body: "\\" + '`<img src="https://example.test/escaped.png" />`\n', extension: "mdx"},
    {body: "``` `\n<img src=\"https://example.test/info.png\" />\n```\n", extension: "mdx"},
    {body: "paragraph\n    <img src=\"https://example.test/indented.png\" />\n", extension: "mdx"},
    {body: "paragraph\n\t<img src=\"https://example.test/tabbed.png\" />\n", extension: "mdx"},
    {
      body: "` unmatched\n# New block\n<img src=\"https://example.test/cross-block.png\" />\n`\n",
      extension: "mdx",
    },
    {
      body: "- ```mdx\n  safe\n<img src=\"https://example.test/list-exit.png\" />\n```\n",
      extension: "mdx",
    },
    {
      body: "> ```mdx\n> safe\n<img src=\"https://example.test/quote-exit.png\" />\n> ```\n",
      extension: "mdx",
    },
  ]) {
    await withFixture(async (repositoryRoot) => {
      const markdownPath = resolve(
        repositoryRoot,
        "site-content/projects/published-project/index.md",
      );
      const mdxPath = resolve(
        repositoryRoot,
        "site-content/projects/published-project/index.mdx",
      );
      const targetPath = fixture.extension === "mdx" ? mdxPath : markdownPath;
      if (fixture.extension === "mdx") renameSync(markdownPath, mdxPath);
      writeFileSync(targetPath, fixture.body, {encoding: "utf8", mode: 0o600});
      await assert.rejects(
        () => loadFixtureContent({repositoryRoot, mode: "production"}),
        assertBuildError("CONTENT_LOAD_DEPENDENCY"),
      );
    });
  }

  for (const image of [
    "../../../outside.png",
    "https://example.com/not-approved.png",
    "../other-entry/assets/evidence.png",
  ]) {
    await withFixture(async (repositoryRoot) => {
      writeText(
        repositoryRoot,
        "site-content/projects/published-project/index.md",
        `## 不安全图片\n\n![证据](${image})\n`,
      );
      await assert.rejects(
        () => loadFixtureContent({repositoryRoot, mode: "production"}),
        assertBuildError("CONTENT_LOAD_DEPENDENCY"),
      );
    });
  }

  for (const referenceImage of [
    "![证据][outside]\n\n[outside]: ../../../outside.png\n",
    "![outside]\n\n[outside]: ../../../outside.png\n",
    "![outside][]\n\n[outside]: ../../../outside.png\n",
    "![证据][outside]\n\n[outside]: ../../../outside.png\n[outside]: assets/evidence.txt\n",
  ]) {
    await withFixture(async (repositoryRoot) => {
      writeText(
        repositoryRoot,
        "site-content/projects/published-project/index.md",
        `## 不安全引用图片\n\n${referenceImage}`,
      );
      await assert.rejects(
        () => loadFixtureContent({repositoryRoot, mode: "production"}),
        assertBuildError("CONTENT_LOAD_DEPENDENCY"),
      );
    });
  }

  await withFixture(async (repositoryRoot) => {
    writeText(
      repositoryRoot,
      "site-content/projects/published-project/index.md",
      "## 合法依赖\n\n[设计证据](../../../docs/projects/evidence.md)\n\n"
        + "![同实体素材](assets/evidence.txt \"可复核截图\")\n\n"
        + "![参考素材][shot]\n\n[shot]: assets/evidence.txt\n\n"
        + "<https://example.com/evidence>\n\n"
        + "纯文本 import(\"package-name\") 与 require(\"package-name\") 不执行模块读取。\n\n"
        + "行内代码 `{expression}`、`<img src=\"outside\" />` 与 `import(\"outside\")` 只作示例。\n\n"
        + "转义表达式 \\{literal\\} 与转义标签 \\<literal> 只作文本。\n\n"
        + "> ```mdx\n> <Demo source=\"../../../outside\" />\n> ```\n\n"
        + "- ```mdx\n  import Nested from '../../../outside.js';\n  ```\n\n"
        + "```mdx\nimport Ignored from '../../../outside.js';\n"
        + "![代码示例](../../../outside.png)\n```\n",
    );
    writeText(
      repositoryRoot,
      "site-content/projects/published-project/assets/evidence.txt",
      "stable asset evidence\n",
    );
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    assert.equal(content.projectNavigation.length, 2);
  });

  for (const orphanBody of [
    "## 代码中的路径不是引用\n\n```text\nassets/evidence.txt\n```\n",
    "## 普通文本也不是引用\n\n路径字符串 assets/evidence.txt 仅用于说明。\n",
  ]) {
    await withFixture(async (repositoryRoot) => {
      writeText(
        repositoryRoot,
        "site-content/projects/published-project/index.md",
        orphanBody,
      );
      writeText(
        repositoryRoot,
        "site-content/projects/published-project/assets/evidence.txt",
        "stable asset evidence\n",
      );
      await assert.rejects(
        () => loadFixtureContent({repositoryRoot, mode: "production"}),
        assertBuildError("CONTENT_LOAD_ASSET_ORPHAN"),
      );
    });
  }

  await withFixture(async (repositoryRoot) => {
    for (const [projectId, bytes] of [
      ["published-project", "public attachment bytes\n"],
      ["draft-project", "private attachment bytes\n"],
    ] as const) {
      writeText(
        repositoryRoot,
        `site-content/projects/${projectId}/index.md`,
        `## ${projectId}\n\n[同名附件](assets/shared-evidence.txt)\n`,
      );
      writeText(
        repositoryRoot,
        `site-content/projects/${projectId}/assets/shared-evidence.txt`,
        bytes,
      );
    }
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const unpublished = getLoadedContentPrivateState(content).unpublishedAssets;
    assert.equal(unpublished.length, 1);
    assert.equal(unpublished[0]?.publicPath, null);
  });
});

test("E-016 私有完整输入 digest 跨 mode 稳定并覆盖 body-only 漂移", async () => {
  await withFixture(async (repositoryRoot) => {
    const production = await loadFixtureContent({repositoryRoot, mode: "production"});
    const preview = await loadFixtureContent({repositoryRoot, mode: "preview"});
    const productionState = getLoadedContentPrivateState(production);
    const previewState = getLoadedContentPrivateState(preview);
    assert.match(productionState.inputDigest, /^[0-9a-f]{64}$/u);
    assert.equal(productionState.inputDigest, previewState.inputDigest);
    assert.equal(Object.isFrozen(productionState), true);
    assert.equal(Object.isFrozen(productionState.sourceFileIdentities), true);
    assert.equal(productionState.sourceFileIdentities.length, production.sources.length);
    assert.equal(Object.hasOwn(production, "inputDigest"), false);

    const sourcePath = resolve(
      repositoryRoot,
      "site-content/projects/published-project/index.md",
    );
    const original = readFileSync(sourcePath, "utf8");
    writeFileSync(sourcePath, `${original}\n仅正文发生变化。\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const changed = await loadFixtureContent({repositoryRoot, mode: "production"});
    assert.notEqual(
      getLoadedContentPrivateState(changed).inputDigest,
      productionState.inputDigest,
    );
  });
});

test("E-016 临界 currentness 覆盖 registry、目录、asset 与替代 docs 根", async () => {
  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    replaceWithSameBytes(resolve(repositoryRoot, "docs/contracts/topics.json"));
    assert.throws(
      () => assertLoadedContentFilesCurrent(content),
      assertBuildError("CONTENT_BUILD_SOURCE_DRIFT"),
    );
  });

  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    mkdirSync(resolve(repositoryRoot, "site-content/projects/late-member"), {mode: 0o700});
    assert.throws(
      () => assertLoadedContentFilesCurrent(content),
      assertBuildError("CONTENT_BUILD_SOURCE_DRIFT"),
    );
  });

  await withFixture(async (repositoryRoot) => {
    writeText(
      repositoryRoot,
      "site-content/projects/published-project/index.md",
      "## published-project\n\n[可复核附件](assets/evidence.txt)\n",
    );
    writeText(
      repositoryRoot,
      "site-content/projects/published-project/assets/evidence.txt",
      "stable asset evidence\n",
    );
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    replaceWithSameBytes(resolve(
      repositoryRoot,
      "site-content/projects/published-project/assets/evidence.txt",
    ));
    assert.throws(
      () => assertLoadedContentFilesCurrent(content),
      assertBuildError("CONTENT_BUILD_SOURCE_DRIFT"),
    );
  });

  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    writeText(repositoryRoot, "versions.json", "[]\n");
    assert.throws(
      () => assertLoadedContentFilesCurrent(content),
      assertBuildError("CONTENT_BUILD_SOURCE_DRIFT"),
    );
  });
});

test("E-016 front matter 只调用一次默认解析器并强制投影受控字段", async () => {
  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "preview"});
    const parseFrontMatter = createParseFrontMatter(content);

    const parse = async (sourcePath: string) => {
      const source = content.sources.find((entry) => entry.sourcePath === sourcePath);
      assert.ok(source);
      let calls = 0;
      const result = await parseFrontMatter({
        filePath: source.absolutePath,
        fileContent: source.fileContent,
        async defaultParseFrontMatter({filePath, fileContent}) {
          calls += 1;
          assert.equal(filePath, source.absolutePath);
          assert.equal(fileContent, source.fileContent);
          return {frontMatter: source.frontMatter, content: source.content};
        },
      });
      assert.equal(calls, 1);
      assert.equal(result.content, source.content);
      return {result, source};
    };

    const publishedProject = await parse(
      "site-content/projects/published-project/index.md",
    );
    assert.deepEqual(publishedProject.result.frontMatter, {
      title: "Published Project",
      description: "Traceable project summary for published-project with sufficient fixture evidence.",
      slug: "/projects/published-project",
    });

    const draftProject = await parse("site-content/projects/draft-project/index.md");
    assert.deepEqual(draftProject.result.frontMatter, {
      title: "Draft Project",
      description: "Traceable project summary for draft-project with sufficient fixture evidence.",
      slug: "/projects/draft-project",
      draft: true,
    });

    const publishedArticle = await parse(
      "site-content/writing/published-article/index.md",
    );
    const publishedDomain = content.articles.find(
      (article) => article.articleId === ARTICLE_IDS.published,
    );
    assert.ok(publishedDomain);
    assert.deepEqual(publishedArticle.result.frontMatter, {
      ...publishedArticle.source.frontMatter,
      description: publishedDomain.summary,
    });

    const draftArticle = await parse("site-content/writing/draft-article/index.md");
    const draftDomain = content.articles.find(
      (article) => article.articleId === ARTICLE_IDS.draft,
    );
    assert.ok(draftDomain);
    assert.deepEqual(draftArticle.result.frontMatter, {
      ...draftArticle.source.frontMatter,
      description: draftDomain.summary,
      draft: true,
    });

    let forgedParserCalls = 0;
    await assert.rejects(
      () => parseFrontMatter({
        filePath: publishedArticle.source.absolutePath,
        fileContent: `${publishedArticle.source.fileContent}\nforged`,
        async defaultParseFrontMatter() {
          forgedParserCalls += 1;
          return {frontMatter: {}, content: "forged"};
        },
      }),
      assertBuildError("CONTENT_PROJECTION_SNAPSHOT"),
    );
    assert.equal(forgedParserCalls, 0);

    let driftParserCalls = 0;
    await assert.rejects(
      () => parseFrontMatter({
        filePath: publishedArticle.source.absolutePath,
        fileContent: publishedArticle.source.fileContent,
        async defaultParseFrontMatter() {
          driftParserCalls += 1;
          return {
            frontMatter: {...publishedArticle.source.frontMatter, slug: "/writing/forged"},
            content: publishedArticle.source.content,
          };
        },
      }),
      assertBuildError("CONTENT_PROJECTION_PARSE_DRIFT"),
    );
    assert.equal(driftParserCalls, 1);
  });
});

test("E-016 front matter 回调前后拒绝同字节替换与符号链接", async () => {
  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const source = content.sources.find(
      (entry) => entry.sourcePath === "site-content/writing/published-article/index.md",
    );
    assert.ok(source);
    const parseFrontMatter = createParseFrontMatter(content);
    replaceWithSameBytes(source.absolutePath);
    let parserCalls = 0;
    await assert.rejects(
      () => parseFrontMatter({
        filePath: source.absolutePath,
        fileContent: source.fileContent,
        async defaultParseFrontMatter() {
          parserCalls += 1;
          return {frontMatter: source.frontMatter, content: source.content};
        },
      }),
      assertBuildError("CONTENT_BUILD_SOURCE_DRIFT"),
    );
    assert.equal(parserCalls, 0);
  });

  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const source = content.sources.find(
      (entry) => entry.sourcePath === "site-content/writing/published-article/index.md",
    );
    assert.ok(source);
    const parseFrontMatter = createParseFrontMatter(content);
    const sameBytesTarget = resolve(repositoryRoot, "same-byte-source.md");
    writeFileSync(sameBytesTarget, source.fileContent, {encoding: "utf8", mode: 0o600});
    rmSync(source.absolutePath);
    symlinkSync(sameBytesTarget, source.absolutePath);
    let parserCalls = 0;
    await assert.rejects(
      () => parseFrontMatter({
        filePath: source.absolutePath,
        fileContent: source.fileContent,
        async defaultParseFrontMatter() {
          parserCalls += 1;
          return {frontMatter: source.frontMatter, content: source.content};
        },
      }),
      assertBuildError("CONTENT_BUILD_SOURCE_DRIFT"),
    );
    assert.equal(parserCalls, 0);
  });

  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const source = content.sources.find(
      (entry) => entry.sourcePath === "site-content/writing/published-article/index.md",
    );
    assert.ok(source);
    const parseFrontMatter = createParseFrontMatter(content);
    let parserCalls = 0;
    await assert.rejects(
      () => parseFrontMatter({
        filePath: source.absolutePath,
        fileContent: source.fileContent,
        async defaultParseFrontMatter() {
          parserCalls += 1;
          replaceWithSameBytes(source.absolutePath);
          return {frontMatter: source.frontMatter, content: source.content};
        },
      }),
      assertBuildError("CONTENT_BUILD_SOURCE_DRIFT"),
    );
    assert.equal(parserCalls, 1);
  });
});

test("D-093 项目主预览只从同一 production session 注入一次无样式 SSR AST", async () => {
  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const plugin = createProjectPreviewRemarkPluginForTest(
      projectPreviewSession(content),
    );
    const transform = plugin();
    const source = content.sources.find((entry) => (
      entry.sourcePath === "site-content/projects/published-project/index.md"
    ));
    assert.ok(source);
    const originalChild = {type: "heading", depth: 2, children: []};
    const tree = {type: "root", children: [originalChild]};

    transform(tree, {path: source.absolutePath});

    assert.equal(tree.children.length, 2);
    assert.equal(tree.children[1], originalChild);
    assert.deepEqual(tree.children[0], {
      type: "mdxJsxFlowElement",
      name: "img",
      attributes: [
        {
          type: "mdxJsxAttribute",
          name: "src",
          value: "/assets/projects/published-project/overview.webp",
        },
        {
          type: "mdxJsxAttribute",
          name: "alt",
          value: "Published Project interface with independently verified fixture evidence",
        },
        {type: "mdxJsxAttribute", name: "width", value: "1600"},
        {type: "mdxJsxAttribute", name: "height", value: "1000"},
      ],
      children: [],
    });
    assert.deepEqual(Object.keys(tree.children[0] as object).sort(), [
      "attributes",
      "children",
      "name",
      "type",
    ]);
    assert.throws(
      () => transform(tree, {path: source.absolutePath}),
      assertBuildError("CONTENT_PROJECT_PREVIEW_AST"),
    );

    for (const sourcePath of [
      "site-content/projects/draft-project/index.md",
      "site-content/writing/published-article/index.md",
    ]) {
      const unprojected = content.sources.find((entry) => entry.sourcePath === sourcePath);
      assert.ok(unprojected);
      const untouched = {type: "root", children: [{type: "paragraph"}]};
      transform(untouched, {path: unprojected.absolutePath});
      assert.deepEqual(untouched.children, [{type: "paragraph"}]);
    }
  }, {draftPreview: true});
});

test("D-093 preview 保留未发布登记预览，production 不生成第二来源", async () => {
  await withFixture(async (repositoryRoot) => {
    const preview = await loadFixtureContent({repositoryRoot, mode: "preview"});
    const transform = createProjectPreviewRemarkPluginForTest(
      projectPreviewSession(preview),
    )();
    const draft = preview.sources.find((entry) => (
      entry.sourcePath === "site-content/projects/draft-project/index.md"
    ));
    assert.ok(draft);
    const tree = {type: "root", children: [] as unknown[]};
    transform(tree, {path: draft.absolutePath});
    assert.equal(tree.children.length, 1);
    assert.deepEqual(
      (tree.children[0] as {attributes: readonly unknown[]}).attributes,
      [
        {
          type: "mdxJsxAttribute",
          name: "src",
          value: "/assets/projects/draft-project/overview.webp",
        },
        {
          type: "mdxJsxAttribute",
          name: "alt",
          value: "Draft Project interface with independently verified fixture evidence",
        },
        {type: "mdxJsxAttribute", name: "width", value: "1600"},
        {type: "mdxJsxAttribute", name: "height", value: "1000"},
      ],
    );
  }, {draftPreview: true});
});

test("D-093 双模式允许无详情的未发布预览，但不伪造项目正文", async () => {
  await withFixture(async (repositoryRoot) => {
    rmSync(
      resolve(repositoryRoot, "site-content/projects/draft-project"),
      {recursive: true},
    );
    for (const mode of ["production", "preview"] as const) {
      const content = await loadFixtureContent({repositoryRoot, mode});
      const plugin = createProjectPreviewRemarkPluginForTest(
        projectPreviewSession(content),
      );
      const published = content.sources.find((entry) => (
        entry.sourcePath === "site-content/projects/published-project/index.md"
      ));
      assert.ok(published);
      assert.equal(
        content.sources.some((entry) => entry.projectId === "draft-project"),
        false,
      );
      const tree = {type: "root", children: [] as unknown[]};
      plugin()(tree, {path: published.absolutePath});
      assert.equal(tree.children.length, 1);
    }
  }, {draftPreview: true});
});

test("D-093 主预览错误 owner、第二清单与第二正文来源全部失败关闭", async () => {
  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const files = projectPreviewManifestFiles(content);
    const first = files[0];
    assert.ok(first);

    const wrongOwner = files.map((file, index) => (
      index === 0
        ? {...file, sourcePath: "site-assets/projects/not-the-owner/overview.webp"}
        : file
    ));
    assert.throws(
      () => createProjectPreviewRemarkPluginForTest(
        projectPreviewSession(content, wrongOwner),
      ),
      assertBuildError("CONTENT_PROJECT_PREVIEW_OWNER"),
    );

    assert.throws(
      () => createProjectPreviewRemarkPluginForTest(
        projectPreviewSession(content, [...files, {...first}]),
      ),
      assertBuildError("CONTENT_PROJECT_PREVIEW_MANIFEST"),
    );

    const transform = createProjectPreviewRemarkPluginForTest(
      projectPreviewSession(content),
    )();
    assert.throws(
      () => transform(
        {type: "root", children: []},
        {path: resolve(repositoryRoot, "site-content/projects/published-project/copy.md")},
      ),
      assertBuildError("CONTENT_PROJECT_PREVIEW_DOC_SOURCE"),
    );
  });
});

test("CODE-013 sidebar 只消费当前 docs[].id，并保持 production/preview 状态边界", async () => {
  await withFixture(async (repositoryRoot) => {
    for (const mode of ["production", "preview"] as const) {
      const content = await loadFixtureContent({repositoryRoot, mode});
      const generator = createSidebarItemsGenerator(content);
      const docs = frameworkDocs(content);
      const ids = docIdBySource(docs);
      const projects = await generator(sidebarArguments(content, "projects", docs) as never);
      assert.deepEqual(projects, [
        {
          type: "doc",
          id: ids.get("site-content/projects/archived-project/index.md"),
          label: "Archived Project（归档）",
        },
        {
          type: "doc",
          id: ids.get("site-content/projects/published-project/index.md"),
        },
      ]);

      const writing = await generator(sidebarArguments(content, "writing", docs) as never);
      const expected = [
        {
          type: "category",
          label: "通用技术",
          collapsed: false,
          collapsible: true,
          items: [{
            type: "doc",
            id: ids.get("site-content/writing/published-article/index.md"),
          }],
        },
        {
          type: "category",
          label: "Published Project",
          collapsed: false,
          collapsible: true,
          items: [{
            type: "category",
            label: "架构模块",
            collapsed: false,
            collapsible: true,
            items: [{
              type: "doc",
              id: ids.get("site-content/writing/archived-article/index.md"),
              label: "Archived Article（归档）",
            }],
          }],
        },
        ...(mode === "preview"
          ? [{
              type: "category",
              label: "草稿",
              collapsed: false,
              collapsible: true,
              items: [{
                type: "doc",
                id: ids.get("site-content/writing/draft-article/index.md"),
              }],
            }]
          : []),
      ];
      assert.deepEqual(writing, expected);
      assert.equal(JSON.stringify(writing).includes("sourceDirName"), false);
    }
  });
});

test("E-016 sidebar 对重复 ID、同源第二 ID、错误 owner、缺失或手工注入 doc 全部失败关闭", async () => {
  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const generator = createSidebarItemsGenerator(content);
    const canonicalDocs = frameworkDocs(content);

    const duplicateId = canonicalDocs.map((doc) => ({...doc}));
    assert.ok(duplicateId[0] && duplicateId[1]);
    duplicateId[1].id = duplicateId[0].id;
    await assert.rejects(
      async () => generator(sidebarArguments(content, "writing", duplicateId) as never),
      assertBuildError("CONTENT_SIDEBAR_DOC_OWNERSHIP"),
    );

    const secondIdForSameSource = {
      ...canonicalDocs[0],
      id: `${String(canonicalDocs[0].id)}-second`,
    };
    await assert.rejects(
      async () => generator(sidebarArguments(
        content,
        "writing",
        [...canonicalDocs, secondIdForSameSource],
      ) as never),
      assertBuildError("CONTENT_SIDEBAR_DOC_OWNERSHIP"),
    );

    const wrongOwner = canonicalDocs.map((doc) => ({...doc}));
    assert.ok(wrongOwner[0]);
    wrongOwner[0].source = "@site/site-content/writing/not-owned/index.md";
    await assert.rejects(
      async () => generator(sidebarArguments(content, "writing", wrongOwner) as never),
      assertBuildError("CONTENT_SIDEBAR_DOC_OWNERSHIP"),
    );

    await assert.rejects(
      async () => generator(
        sidebarArguments(content, "writing", canonicalDocs.slice(1)) as never,
      ),
      assertBuildError("CONTENT_SIDEBAR_DOC_SET"),
    );

    const manualDoc = {
      ...canonicalDocs[0],
      id: "manually-injected-doc-id",
      source: "@site/site-content/writing/manually-injected/index.md",
    };
    await assert.rejects(
      async () => generator(sidebarArguments(
        content,
        "writing",
        [...canonicalDocs, manualDoc],
      ) as never),
      assertBuildError("CONTENT_SIDEBAR_DOC_OWNERSHIP"),
    );

    const firstSource = content.sources[0];
    assert.ok(firstSource);
    replaceWithSameBytes(firstSource.absolutePath);
    await assert.rejects(
      async () => generator(sidebarArguments(content, "writing", canonicalDocs) as never),
      assertBuildError("CONTENT_BUILD_SOURCE_DRIFT"),
    );
  });
});

test("E-016 重复文章 route 在 loader 内原子失败并保留上游稳定 code", async () => {
  await withFixture(async (repositoryRoot) => {
    await assert.rejects(
      () => loadFixtureContent({repositoryRoot, mode: "production"}),
      assertBuildError("CONTENT_LOAD_ARTICLES", "CONTENT_ARTICLE_SLUG_DUPLICATE"),
    );
  }, {duplicateArticleRoute: true});
});

test("E-016 保留 namespace 在领域入口即失败，不能进入 route 闭包", async () => {
  for (const slug of [
    "/assets/private",
    "/img/private",
    "/.well-known/private",
    "/robots.txt",
    "/sitemap.xml",
    "/404.html",
  ]) {
    await withFixture(async (repositoryRoot) => {
      const sourcePath = resolve(
        repositoryRoot,
        "site-content/writing/published-article/index.md",
      );
      writeFileSync(
        sourcePath,
        readFileSync(sourcePath, "utf8").replace(
          '"slug":"/writing/published-article"',
          `"slug":${JSON.stringify(slug)}`,
        ),
        {encoding: "utf8", mode: 0o600},
      );
      await assert.rejects(
        () => loadFixtureContent({repositoryRoot, mode: "production"}),
        assertBuildError("CONTENT_LOAD_ARTICLES", "CONTENT_ARTICLE_FIELD_INVALID"),
      );
    });
  }
});

test("E-016 日期索引只在 postBuild 原子写入私有 generated files", async () => {
  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const outputDirectory = resolve(repositoryRoot, "artifact-build");
    const generatedFilesDirectory = resolve(repositoryRoot, ".docusaurus");
    mkdirSync(outputDirectory, {mode: 0o700});
    mkdirSync(generatedFilesDirectory, {mode: 0o700});
    let sealWrites = 0;
    const session = Object.freeze({
      content,
      docsAdapterSession: Object.freeze({}),
      outputDirectory,
      phase: "build" as const,
      staticPlan: Object.freeze({}),
      writeBuildSeal() {
        sealWrites += 1;
      },
      assertBuildSeal() {
        throw new Error("build fixture must not assert seal");
      },
    });
    const pluginModule = createContentDataPluginForTest(session as never);
    const plugin = await pluginModule({generatedFilesDir: generatedFilesDirectory} as never, undefined);
    assert.ok(plugin);

    let createDataCalls = 0;
    const globalData: unknown[] = [];
    let addRouteCalls = 0;
    await plugin.contentLoaded?.({
      actions: {
        async createData() {
          createDataCalls += 1;
          return "/generated/unexpected";
        },
        setGlobalData(value: unknown) {
          globalData.push(value);
        },
        addRoute() {
          addRouteCalls += 1;
        },
      },
      content: undefined,
    } as never);

    assert.equal(addRouteCalls, 0);
    assert.equal(createDataCalls, 0);
    assert.deepEqual(globalData, [{
      projectNavigation: content.projectNavigation,
      writingNavigation: content.writingNavigation,
    }]);
    assert.equal(Object.hasOwn(globalData[0] as object, "articleDateIndex"), false);
    assert.equal(Object.hasOwn(plugin, "routes"), false);
    await plugin.postBuild?.({outDir: outputDirectory} as never);
    const privateIndex = readFileSync(
      resolve(generatedFilesDirectory, "axial-muse/article-date-index.json"),
      "utf8",
    );
    assert.equal(privateIndex, `${JSON.stringify(content.articleDateIndex, null, 2)}\n`);
    assert.equal(privateIndex.includes(ARTICLE_IDS.draft), false);
    assert.equal(sealWrites, 1);
  });
});

test("CODE-003 私有日期索引写入保留 operation 与 cleanup 双故障 cause", async () => {
  for (const failureMode of ["operation-only", "dual"] as const) {
    await withFixture(async (repositoryRoot) => {
      const content = await loadFixtureContent({repositoryRoot, mode: "production"});
      const outputDirectory = resolve(repositoryRoot, "artifact-build");
      const generatedFilesDirectory = resolve(repositoryRoot, ".docusaurus");
      mkdirSync(outputDirectory, {mode: 0o700});
      mkdirSync(generatedFilesDirectory, {mode: 0o700});
      let sealWrites = 0;
      const session = Object.freeze({
        content,
        docsAdapterSession: Object.freeze({}),
        outputDirectory,
        phase: "build" as const,
        staticPlan: Object.freeze({}),
        writeBuildSeal() {
          sealWrites += 1;
        },
        assertBuildSeal() {
          throw new Error("build fixture must not assert seal");
        },
      });
      const pluginModule = createContentDataPluginForTest(session as never);
      const plugin = await pluginModule(
        {generatedFilesDir: generatedFilesDirectory} as never,
        undefined,
      );
      const postBuild = plugin?.postBuild;
      assert.ok(postBuild);

      const operationError = new Error(`fixture ${failureMode} rename failure`);
      const cleanupError = new Error("fixture cleanup failure");
      const realUnlinkSync = fs.unlinkSync;
      let cleanupCalls = 0;
      await withFileSystemOverrides({
        renameSync: (() => {
          throw operationError;
        }) as typeof fs.renameSync,
        unlinkSync: ((path: Parameters<typeof fs.unlinkSync>[0]) => {
          cleanupCalls += 1;
          if (failureMode === "dual") throw cleanupError;
          realUnlinkSync(path);
        }) as typeof fs.unlinkSync,
      }, async () => {
        await assert.rejects(
          async () => postBuild({outDir: outputDirectory} as never),
          assertBuildErrorCause(
            "CONTENT_PLUGIN_DATE_INDEX",
            ARTICLE_DATE_INDEX_SOURCE_PATH,
            (cause) => {
              if (failureMode === "dual") {
                assertAggregateCause(cause, operationError, cleanupError);
              } else {
                assert.strictEqual(cause, operationError);
              }
            },
          ),
        );
      });
      assert.equal(cleanupCalls, 1);
      assert.equal(sealWrites, 0);
    });
  }
});

test("CODE-003 production artifact 稳定读取保留 operation 与 close 双故障 cause", async () => {
  for (const failureMode of ["operation-only", "close-only", "dual"] as const) {
    await withFixture(async (repositoryRoot) => {
      const content = await loadFixtureContent({repositoryRoot, mode: "production"});
      const fixture = createArtifactFixture(repositoryRoot, content);
      const operationError = new Error(`fixture ${failureMode} read failure`);
      const closeError = new Error(`fixture ${failureMode} close failure`);
      const realCloseSync = fs.closeSync;
      let closeCalls = 0;
      const trace = {sealAssertions: 0, staticAssertions: 0, disposals: 0};
      const overrides: FileSystemOverrides = {
        closeSync: ((descriptor: number) => {
          closeCalls += 1;
          realCloseSync(descriptor);
          if (failureMode !== "operation-only") throw closeError;
        }) as typeof fs.closeSync,
        ...(failureMode === "close-only"
          ? {}
          : {
              readFileSync: (() => {
                throw operationError;
              }) as typeof fs.readFileSync,
            }),
      };
      await withFileSystemOverrides(overrides, async () => {
        await assert.rejects(
          () => invokeArtifactCheck(
            content,
            fixture.buildDirectory,
            fixture.generatedFilesDirectory,
            {trace},
          ),
          assertBuildErrorCause(
            "CONTENT_ARTIFACT_READ",
            ARTICLE_DATE_INDEX_SOURCE_PATH,
            (cause) => {
              if (failureMode === "operation-only") {
                assert.strictEqual(cause, operationError);
              } else if (failureMode === "close-only") {
                assert.strictEqual(cause, closeError);
              } else {
                assertAggregateCause(cause, operationError, closeError);
              }
            },
          ),
        );
      });
      assert.equal(closeCalls, 1);
      assert.deepEqual(trace, {
        sealAssertions: 1,
        staticAssertions: 0,
        disposals: 1,
      });
    });
  }
});

test("E-016 production artifact 只验收内容详情 canonical/sidebar 并保持页面元数据下游边界", async () => {
  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const fixture = createArtifactFixture(repositoryRoot, content);
    const rootPath = resolve(fixture.buildDirectory, "index.html");
    writeFileSync(
      rootPath,
      readFileSync(rootPath, "utf8").replace(
        '<link rel="canonical" href="https://www.axialmuse.com/">',
        "",
      ).replace("</html>", ""),
      {encoding: "utf8", mode: 0o600},
    );
    assert.deepEqual(
      await invokeArtifactCheck(
        content,
        fixture.buildDirectory,
        fixture.generatedFilesDirectory,
      ),
      {sealAssertions: 2, staticAssertions: 2, disposals: 1},
    );
  });

  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const fixture = createArtifactFixture(repositoryRoot, content);
    const trace = {sealAssertions: 0, staticAssertions: 0, disposals: 0};
    await assert.rejects(
      () => invokeArtifactCheck(
        content,
        fixture.buildDirectory,
        fixture.generatedFilesDirectory,
        {failSealAssertionAt: 2, trace},
      ),
      /fixture build seal drift/u,
    );
    assert.deepEqual(trace, {
      sealAssertions: 2,
      staticAssertions: 2,
      disposals: 1,
    });
  });

  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const fixture = createArtifactFixture(repositoryRoot, content);
    const projectSidebar = artifactProjectSidebar(content);
    const target = projectSidebar[0];
    assert.ok(target);
    const wrongLabel = projectSidebar.map((link, index) => (
      index === 0 ? {...link, label: `${link.label}（错误）`} : link
    ));
    writeText(
      fixture.buildDirectory,
      artifactHtmlPath(target.href),
      artifactPageHtml(target.href, artifactSidebarHtml(wrongLabel)),
    );
    await assert.rejects(
      () => invokeArtifactCheck(
        content,
        fixture.buildDirectory,
        fixture.generatedFilesDirectory,
      ),
      assertBuildError("CONTENT_ARTIFACT_SIDEBAR_SET"),
    );
  });

  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const fixture = createArtifactFixture(repositoryRoot, content);
    const projectSidebar = artifactProjectSidebar(content);
    const target = projectSidebar[0];
    assert.ok(target);
    writeText(
      fixture.buildDirectory,
      artifactHtmlPath(target.href),
      artifactPageHtml(target.href, artifactSidebarHtml(projectSidebar.slice(1))),
    );
    await assert.rejects(
      () => invokeArtifactCheck(
        content,
        fixture.buildDirectory,
        fixture.generatedFilesDirectory,
      ),
      assertBuildError("CONTENT_ARTIFACT_SIDEBAR_SET"),
    );
  });

  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const fixture = createArtifactFixture(repositoryRoot, content);
    const target = artifactProjectSidebar(content)[0];
    assert.ok(target);
    writeText(
      fixture.buildDirectory,
      artifactHtmlPath(target.href),
      artifactPageHtml(
        target.href,
        artifactSidebarHtml(artifactWritingSidebar(content), "技术分享"),
      ),
    );
    await assert.rejects(
      () => invokeArtifactCheck(
        content,
        fixture.buildDirectory,
        fixture.generatedFilesDirectory,
      ),
      assertBuildError("CONTENT_ARTIFACT_SIDEBAR_SET"),
    );
  });

  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const fixture = createArtifactFixture(repositoryRoot, content);
    const target = artifactProjectSidebar(content)[0];
    assert.ok(target);
    writeText(
      fixture.buildDirectory,
      artifactHtmlPath(target.href),
      artifactPageHtml(target.href),
    );
    await assert.rejects(
      () => invokeArtifactCheck(
        content,
        fixture.buildDirectory,
        fixture.generatedFilesDirectory,
      ),
      assertBuildError("CONTENT_ARTIFACT_SIDEBAR_STRUCTURE"),
    );
  });
});

test("E-016 production artifact sitemap URL 集合拒绝缺失与额外成员", async () => {
  for (const mutation of ["missing", "extra"] as const) {
    await withFixture(async (repositoryRoot) => {
      const content = await loadFixtureContent({repositoryRoot, mode: "production"});
      const fixture = createArtifactFixture(repositoryRoot, content);
      const sitemapPath = resolve(fixture.buildDirectory, "sitemap.xml");
      const sitemap = readFileSync(sitemapPath, "utf8");
      const project = content.projectNavigation[0];
      assert.ok(project);
      const expectedMember = `<url><loc>https://www.axialmuse.com${project.canonicalPath}</loc></url>`;
      const mutated = mutation === "missing"
        ? sitemap.replace(expectedMember, "")
        : sitemap.replace(
            "</urlset>",
            "<url><loc>https://www.axialmuse.com/unexpected/</loc></url></urlset>",
          );
      assert.notEqual(mutated, sitemap);
      writeFileSync(sitemapPath, mutated, {encoding: "utf8", mode: 0o600});
      await assert.rejects(
        () => invokeArtifactCheck(
          content,
          fixture.buildDirectory,
          fixture.generatedFilesDirectory,
        ),
        assertBuildError("CONTENT_ARTIFACT_SITEMAP_SET"),
      );
    });
  }
});

test("E-016 production artifact 拒绝重排私有索引进入任意后缀制品", async () => {
  for (const carrier of ["html", "js", "map", "json", "txt", "css", "bin"] as const) {
    await withFixture(async (repositoryRoot) => {
      const content = await loadFixtureContent({repositoryRoot, mode: "production"});
      const fixture = createArtifactFixture(repositoryRoot, content);
      const entry = content.articleDateIndex[0];
      assert.ok(entry);
      const reordered = `{"updatedAt":"${entry.updatedAt}","articleId":"${entry.articleId}","publishedAt":"${entry.publishedAt}","slug":"${entry.slug}"}`;
      if (carrier === "html") {
        writeText(
          fixture.buildDirectory,
          "index.html",
          artifactPageHtml("/").replace(
            "</body>",
            `<script type="application/json">[${reordered}]</script></body>`,
          ),
        );
      } else if (carrier === "js") {
        writeText(
          fixture.buildDirectory,
          "assets/js/main.fixture.js",
          `self.privateIndex=[${reordered}];\n`,
        );
      } else if (carrier === "map") {
        writeText(
          fixture.buildDirectory,
          "assets/js/main.fixture.js.map",
          `${JSON.stringify({
            version: 3,
            sources: ["fixture.ts"],
            names: [],
            mappings: "",
            sourcesContent: [`export const value=[${reordered}];`],
          })}\n`,
        );
      } else if (carrier === "json") {
        writeText(
          fixture.buildDirectory,
          "assets/data/renamed-content.fixture.json",
          `[${reordered}]\n`,
        );
      } else {
        writeText(
          fixture.buildDirectory,
          `assets/data/renamed-content.fixture.${carrier}`,
          `[${reordered}]\n`,
        );
      }
      await assert.rejects(
        () => invokeArtifactCheck(
          content,
          fixture.buildDirectory,
          fixture.generatedFilesDirectory,
        ),
        assertBuildError("CONTENT_ARTIFACT_PRIVATE_INDEX"),
      );
    });
  }

  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const fixture = createArtifactFixture(repositoryRoot, content);
    writeText(
      fixture.buildDirectory,
      "assets/js/article-date-index.fixture.js",
      "self.unrelated=true;\n",
    );
    await assert.rejects(
      () => invokeArtifactCheck(
        content,
        fixture.buildDirectory,
        fixture.generatedFilesDirectory,
      ),
      assertBuildError("CONTENT_ARTIFACT_PRIVATE_INDEX"),
    );
  });
});

test("E-016 production artifact 拒绝父目录 symlink 提供私有日期索引", async () => {
  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const fixture = createArtifactFixture(repositoryRoot, content);
    const privateDirectory = resolve(fixture.generatedFilesDirectory, "axial-muse");
    const outsideDirectory = resolve(repositoryRoot, "outside-private-index");
    renameSync(privateDirectory, outsideDirectory);
    symlinkSync(outsideDirectory, privateDirectory, "dir");
    await assert.rejects(
      () => invokeArtifactCheck(
        content,
        fixture.buildDirectory,
        fixture.generatedFilesDirectory,
      ),
      assertBuildError("CONTENT_ARTIFACT_PRIVATE_INDEX"),
    );
  });
});

test("E-016 production artifact 不接受注释或脚本伪造 canonical、sidebar、sitemap", async () => {
  for (const inert of ["comment", "script"] as const) {
    await withFixture(async (repositoryRoot) => {
      const content = await loadFixtureContent({repositoryRoot, mode: "production"});
      const fixture = createArtifactFixture(repositoryRoot, content);
      const target = artifactProjectSidebar(content)[0];
      assert.ok(target);
      const targetPath = resolve(fixture.buildDirectory, artifactHtmlPath(target.href));
      const canonical = `<link rel="canonical" href="https://www.axialmuse.com${target.href}">`;
      const wrapper = inert === "comment"
        ? `<!--${canonical}-->`
        : `<script type="application/json">${canonical}</script>`;
      writeFileSync(
        targetPath,
        readFileSync(targetPath, "utf8").replace(canonical, wrapper),
        {encoding: "utf8", mode: 0o600},
      );
      await assert.rejects(
        () => invokeArtifactCheck(
          content,
          fixture.buildDirectory,
          fixture.generatedFilesDirectory,
        ),
        assertBuildError("CONTENT_ARTIFACT_CANONICAL"),
      );
    });
  }

  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const fixture = createArtifactFixture(repositoryRoot, content);
    const target = artifactProjectSidebar(content)[0];
    assert.ok(target);
    const targetPath = resolve(fixture.buildDirectory, artifactHtmlPath(target.href));
    const canonical = `<link rel="canonical" href="https://www.axialmuse.com${target.href}">`;
    writeFileSync(
      targetPath,
      readFileSync(targetPath, "utf8")
        .replace(canonical, "")
        .replace("<main>", `${canonical}<main>`),
      {encoding: "utf8", mode: 0o600},
    );
    await assert.rejects(
      () => invokeArtifactCheck(
        content,
        fixture.buildDirectory,
        fixture.generatedFilesDirectory,
      ),
      assertBuildError("CONTENT_ARTIFACT_CANONICAL"),
    );
  });

  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const fixture = createArtifactFixture(repositoryRoot, content);
    const target = artifactProjectSidebar(content)[0];
    assert.ok(target);
    const targetPath = resolve(fixture.buildDirectory, artifactHtmlPath(target.href));
    const canonical = `<link rel="canonical" href="https://www.axialmuse.com${target.href}">`;
    writeFileSync(
      targetPath,
      readFileSync(targetPath, "utf8").replace(
        canonical,
        `<link rel="canonical" href="https://wrong.example/" href="https://www.axialmuse.com${target.href}">`,
      ),
      {encoding: "utf8", mode: 0o600},
    );
    await assert.rejects(
      () => invokeArtifactCheck(
        content,
        fixture.buildDirectory,
        fixture.generatedFilesDirectory,
      ),
      assertBuildError("CONTENT_ARTIFACT_HTML_STRUCTURE"),
    );
  });

  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const fixture = createArtifactFixture(repositoryRoot, content);
    const target = artifactProjectSidebar(content)[0];
    assert.ok(target);
    const sidebar = artifactSidebarHtml(artifactProjectSidebar(content)).replace(
      `href="${target.href}"`,
      `href="/wrong/" href="${target.href}"`,
    );
    writeText(
      fixture.buildDirectory,
      artifactHtmlPath(target.href),
      artifactPageHtml(target.href, sidebar),
    );
    await assert.rejects(
      () => invokeArtifactCheck(
        content,
        fixture.buildDirectory,
        fixture.generatedFilesDirectory,
      ),
      assertBuildError("CONTENT_ARTIFACT_HTML_STRUCTURE"),
    );
  });

  for (const inert of ["comment", "script"] as const) {
    await withFixture(async (repositoryRoot) => {
      const content = await loadFixtureContent({repositoryRoot, mode: "production"});
      const fixture = createArtifactFixture(repositoryRoot, content);
      const target = artifactProjectSidebar(content)[0];
      assert.ok(target);
      const sidebar = artifactSidebarHtml(artifactProjectSidebar(content));
      const wrapper = inert === "comment"
        ? `<!--${sidebar}-->`
        : `<script type="application/json">${sidebar}</script>`;
      writeText(
        fixture.buildDirectory,
        artifactHtmlPath(target.href),
        artifactPageHtml(target.href, wrapper),
      );
      await assert.rejects(
        () => invokeArtifactCheck(
          content,
          fixture.buildDirectory,
          fixture.generatedFilesDirectory,
        ),
        assertBuildError("CONTENT_ARTIFACT_SIDEBAR_STRUCTURE"),
      );
    });
  }

  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const fixture = createArtifactFixture(repositoryRoot, content);
    const sitemap = readFileSync(resolve(fixture.buildDirectory, "sitemap.xml"), "utf8")
      .replaceAll("<loc>", "<!--<loc>")
      .replaceAll("</loc>", "</loc>-->");
    writeText(fixture.buildDirectory, "sitemap.xml", sitemap);
    await assert.rejects(
      () => invokeArtifactCheck(
        content,
        fixture.buildDirectory,
        fixture.generatedFilesDirectory,
      ),
      assertBuildError("CONTENT_ARTIFACT_SITEMAP"),
    );
  });
});

test("E-016 production artifact 的 HTML5 结构不能由受禁上下文或畸形 token 伪造", async () => {
  const mutations: readonly ((input: string, canonical: string, sidebar: string) => string)[] = [
    (input, canonical) => input.replace(canonical, `<div>${canonical}</div>`),
    (input, _canonical, sidebar) => input.replace(sidebar, `<select>${sidebar}</select>`),
    (input, canonical) => input.replace(canonical, `<!-->${canonical}-->`),
    (input, _canonical, sidebar) => input.replace(
      sidebar,
      `<svg><foreignObject>${sidebar}</foreignObject></svg>`,
    ),
    (input) => input.replace("<!doctype html>", "<!doctype html fixture>"),
    (input) => `<!BOGUS>${input}`,
  ];
  for (const mutate of mutations) {
    await withFixture(async (repositoryRoot) => {
      const content = await loadFixtureContent({repositoryRoot, mode: "production"});
      const fixture = createArtifactFixture(repositoryRoot, content);
      const target = artifactProjectSidebar(content)[0];
      assert.ok(target);
      const targetPath = resolve(fixture.buildDirectory, artifactHtmlPath(target.href));
      const input = readFileSync(targetPath, "utf8");
      const canonical = `<link rel="canonical" href="https://www.axialmuse.com${target.href}">`;
      const sidebar = artifactSidebarHtml(artifactProjectSidebar(content));
      writeFileSync(targetPath, mutate(input, canonical, sidebar), {
        encoding: "utf8",
        mode: 0o600,
      });
      await assert.rejects(
        () => invokeArtifactCheck(
          content,
          fixture.buildDirectory,
          fixture.generatedFilesDirectory,
        ),
        assertBuildError("CONTENT_ARTIFACT_HTML_STRUCTURE"),
      );
    });
  }
});

test("E-016 production artifact 解码受控 entity 后再校验 canonical、sidebar 与 noindex", async () => {
  for (const mutation of ["encoded-canonical", "nbsp-canonical", "encoded-sidebar"] as const) {
    await withFixture(async (repositoryRoot) => {
      const content = await loadFixtureContent({repositoryRoot, mode: "production"});
      const fixture = createArtifactFixture(repositoryRoot, content);
      const target = artifactProjectSidebar(content)[0];
      assert.ok(target);
      const targetPath = resolve(fixture.buildDirectory, artifactHtmlPath(target.href));
      const canonical = `<link rel="canonical" href="https://www.axialmuse.com${target.href}">`;
      const sidebar = artifactSidebarHtml(artifactProjectSidebar(content));
      const input = readFileSync(targetPath, "utf8");
      const output = mutation === "encoded-canonical"
        ? input.replace(
            "</head>",
            `<link rel="alternate canon&#105;cal" href="https://wrong.example/"></head>`,
          )
        : mutation === "nbsp-canonical"
          ? input.replace(canonical, canonical.replace("canonical", "alternate\u00a0canonical"))
          : input.replace(
              "<main>",
              `${sidebar.replace(
                "theme-doc-sidebar-container",
                "theme-doc-sidebar&#45;container",
              )}<main>`,
            );
      writeFileSync(targetPath, output, {encoding: "utf8", mode: 0o600});
      await assert.rejects(
        () => invokeArtifactCheck(
          content,
          fixture.buildDirectory,
          fixture.generatedFilesDirectory,
        ),
        assertBuildError(
          mutation === "encoded-sidebar"
            ? "CONTENT_ARTIFACT_SIDEBAR_STRUCTURE"
            : "CONTENT_ARTIFACT_CANONICAL",
        ),
      );
    });
  }

  for (const meta of [
    '<meta name="googlebot-news" content="no&#105;ndex">',
    '<meta name="robots" content="none">',
  ]) {
    await withFixture(async (repositoryRoot) => {
      const content = await loadFixtureContent({repositoryRoot, mode: "production"});
      const fixture = createArtifactFixture(repositoryRoot, content);
      const rootPath = resolve(fixture.buildDirectory, "index.html");
      writeFileSync(
        rootPath,
        readFileSync(rootPath, "utf8").replace("</head>", `${meta}</head>`),
        {encoding: "utf8", mode: 0o600},
      );
      await assert.rejects(
        () => invokeArtifactCheck(
          content,
          fixture.buildDirectory,
          fixture.generatedFilesDirectory,
        ),
        assertBuildError("CONTENT_ARTIFACT_NOINDEX"),
      );
    });
  }
});

test("E-016 production artifact 拒绝大小写 HTML 旁路与非受控 sitemap XML", async () => {
  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const fixture = createArtifactFixture(repositoryRoot, content);
    writeText(fixture.buildDirectory, "orphan.HTML", artifactPageHtml("/orphan/"));
    await assert.rejects(
      () => invokeArtifactCheck(
        content,
        fixture.buildDirectory,
        fixture.generatedFilesDirectory,
      ),
      assertBuildError("CONTENT_ARTIFACT_ROUTE_SET"),
    );
  });

  for (const mutate of [
    (input: string) => input.replace("<urlset>", "<urlset foo=>"),
    (input: string) => input.replace("?><urlset>", `?>\u00a0<urlset>`),
    (input: string) => input.replace("</url>", "<changefreq>&bogus;</changefreq></url>"),
  ]) {
    await withFixture(async (repositoryRoot) => {
      const content = await loadFixtureContent({repositoryRoot, mode: "production"});
      const fixture = createArtifactFixture(repositoryRoot, content);
      const sitemapPath = resolve(fixture.buildDirectory, "sitemap.xml");
      writeFileSync(sitemapPath, mutate(readFileSync(sitemapPath, "utf8")), {
        encoding: "utf8",
        mode: 0o600,
      });
      await assert.rejects(
        () => invokeArtifactCheck(
          content,
          fixture.buildDirectory,
          fixture.generatedFilesDirectory,
        ),
        assertBuildError("CONTENT_ARTIFACT_SITEMAP"),
      );
    });
  }
});

test("E-016 production artifact 跨任意文件拒绝 draft/planned 身份、摘要与正文", async () => {
  for (const leak of ["article-id", "article-summary", "article-body", "project-title"] as const) {
    await withFixture(async (repositoryRoot) => {
      const content = await loadFixtureContent({repositoryRoot, mode: "production"});
      const fixture = createArtifactFixture(repositoryRoot, content);
      const draftArticle = content.articles.find((article) => (
        article.publicationStatus === "draft"
      ));
      const draftSource = content.sources.find((source) => (
        source.kind === "article" && source.sourceName === draftArticle?.sourceName
      ));
      const draftProject = content.catalog.projects.find((project) => (
        project.publicationStatus === "draft"
      ));
      assert.ok(draftArticle);
      assert.ok(draftSource);
      assert.ok(draftProject);
      const bodyMarker = draftSource.content.split(/\r?\n/u).find((line) => (
        line.includes("独立正文指纹")
      ));
      assert.ok(bodyMarker);
      const value = leak === "article-id"
        ? draftArticle.articleId
        : leak === "article-summary"
          ? draftArticle.summary
          : leak === "article-body"
            ? bodyMarker
            : draftProject.title;
      writeText(
        fixture.buildDirectory,
        `assets/data/unpublished-${leak}.${leak === "article-body" ? "bin" : "txt"}`,
        `${value}\n`,
      );
      await assert.rejects(
        () => invokeArtifactCheck(
          content,
          fixture.buildDirectory,
          fixture.generatedFilesDirectory,
        ),
        assertBuildError("CONTENT_ARTIFACT_UNPUBLISHED"),
      );
    });
  }

  for (const transformed of [
    {
      source: "**UNIQUE-DRAFT-SEMANTIC-SECRET**",
      artifact: "UNIQUE-DRAFT-SEMANTIC-SECRET",
    },
    {
      source: "ENTITY-DRAFT&amp;SEMANTIC-SECRET",
      artifact: "ENTITY-DRAFT&SEMANTIC-SECRET",
    },
  ]) {
    await withFixture(async (repositoryRoot) => {
      const sourcePath = resolve(
        repositoryRoot,
        "site-content/writing/draft-article/index.md",
      );
      writeFileSync(
        sourcePath,
        readFileSync(sourcePath, "utf8").replace(
          /独立正文指纹[^\n]+/u,
          transformed.source,
        ),
        {encoding: "utf8", mode: 0o600},
      );
      const content = await loadFixtureContent({repositoryRoot, mode: "production"});
      const fixture = createArtifactFixture(repositoryRoot, content);
      writeText(
        fixture.buildDirectory,
        "assets/data/rendered-draft-fragment.txt",
        `${transformed.artifact}\n`,
      );
      await assert.rejects(
        () => invokeArtifactCheck(
          content,
          fixture.buildDirectory,
          fixture.generatedFilesDirectory,
        ),
        assertBuildError("CONTENT_ARTIFACT_UNPUBLISHED"),
      );
    });
  }
});

test("E-016 production artifact 拒绝 Markdown 渲染、链接目标与 HTML 转义后的未发布语义", async () => {
  for (const transformed of [
    {
      source: "alpha-one **beta-two** gamma-three",
      artifact: "<p>alpha-one <strong>beta-two</strong> gamma-three</p>",
    },
    {
      source: "[read](https://secret-example.invalid/private)",
      artifact: '<a href="https://secret-example.invalid/private">read</a>',
    },
    {
      source: "Private & Roadmap Secret",
      artifact: "<title>Private &amp; Roadmap Secret</title>",
    },
  ]) {
    await withFixture(async (repositoryRoot) => {
      const sourcePath = resolve(
        repositoryRoot,
        "site-content/writing/draft-article/index.md",
      );
      const original = readFileSync(sourcePath, "utf8");
      const changed = transformed.artifact.startsWith("<title>")
        ? original.replace('"title":"Draft Article"', `"title":${JSON.stringify(transformed.source)}`)
        : original.replace(/独立正文指纹[^\n]+/u, transformed.source);
      writeFileSync(sourcePath, changed, {encoding: "utf8", mode: 0o600});
      const content = await loadFixtureContent({repositoryRoot, mode: "production"});
      const fixture = createArtifactFixture(repositoryRoot, content);
      const rootPath = resolve(fixture.buildDirectory, "index.html");
      writeFileSync(
        rootPath,
        readFileSync(rootPath, "utf8").replace("</main>", `${transformed.artifact}</main>`),
        {encoding: "utf8", mode: 0o600},
      );
      await assert.rejects(
        () => invokeArtifactCheck(
          content,
          fixture.buildDirectory,
          fixture.generatedFilesDirectory,
        ),
        assertBuildError("CONTENT_ARTIFACT_UNPUBLISHED"),
      );
    });
  }
});

test("E-016 production artifact 不把未发布正文中的框架通用词误判为泄漏", async () => {
  await withFixture(async (repositoryRoot) => {
    const sourcePath = resolve(
      repositoryRoot,
      "site-content/writing/draft-article/index.md",
    );
    writeFileSync(
      sourcePath,
      readFileSync(sourcePath, "utf8").replace(
        /独立正文指纹[^\n]+/u,
        "Markdown JavaScript WebSocket Docusaurus",
      ),
      {encoding: "utf8", mode: 0o600},
    );
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const fixture = createArtifactFixture(repositoryRoot, content);
    writeText(
      fixture.buildDirectory,
      "assets/js/framework-vocabulary.txt",
      "Markdown docs\nJavaScript runtime\nWebSocket transport\nDocusaurus framework\n",
    );
    assert.deepEqual(
      await invokeArtifactCheck(
        content,
        fixture.buildDirectory,
        fixture.generatedFilesDirectory,
      ),
      {sealAssertions: 2, staticAssertions: 2, disposals: 1},
    );
  });
});

test("E-016 production artifact 对过短未发布正文因不可证分离而失败关闭", async () => {
  await withFixture(async (repositoryRoot) => {
    const sourcePath = resolve(
      repositoryRoot,
      "site-content/writing/draft-article/index.md",
    );
    writeFileSync(
      sourcePath,
      readFileSync(sourcePath, "utf8").replace(/独立正文指纹[^\n]+/u, "abc"),
      {encoding: "utf8", mode: 0o600},
    );
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const fixture = createArtifactFixture(repositoryRoot, content);
    await assert.rejects(
      () => invokeArtifactCheck(
        content,
        fixture.buildDirectory,
        fixture.generatedFilesDirectory,
      ),
      assertBuildError("CONTENT_ARTIFACT_UNPUBLISHED_EVIDENCE"),
    );
  });
});

test("E-016 production artifact 精确校验私有日期索引与当前内容", async () => {
  await withFixture(async (repositoryRoot) => {
    const content = await loadFixtureContent({repositoryRoot, mode: "production"});
    const fixture = createArtifactFixture(repositoryRoot, content);
    writeText(
      fixture.generatedFilesDirectory,
      "axial-muse/article-date-index.json",
      "[]\n",
    );
    await assert.rejects(
      () => invokeArtifactCheck(
        content,
        fixture.buildDirectory,
        fixture.generatedFilesDirectory,
      ),
      assertBuildError("CONTENT_ARTIFACT_PRIVATE_INDEX"),
    );
  });
});

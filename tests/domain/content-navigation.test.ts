import assert from "node:assert/strict";
import test from "node:test";
import {
  buildArticleDateIndex,
  buildProjectNavigation,
  buildWritingNavigation,
  validateArticleSource,
  validateProjectCatalog,
} from "../../src/domain/content/index.js";
import type {
  Article,
  ArticleSourceInput,
  ContentIssue,
  ProjectCatalog,
  ProjectCatalogInput,
  ValidationResult,
} from "../../src/domain/content/index.js";

const LIFECYCLE_STATUSES = ["active", "paused", "completed", "archived"];
const PUBLICATION_STATUSES = ["draft", "planned", "published", "archived"];
const SHOWCASE_MODES = ["repository", "repository-and-video"];
const EXPERIENCE_STATUSES = ["planned", "provisioning", "live", "paused", "retired"];
const RESERVED_SUBDOMAINS = [
  "www",
  "api",
  "admin",
  "auth",
  "account",
  "assets",
  "cdn",
  "dev",
  "docs",
  "mail",
  "preview",
  "staging",
  "static",
  "status",
  "support",
];

const ARTICLE_IDS = Object.freeze({
  generalOlder: "018f0000-0000-7000-8000-000000000001",
  generalNewer: "018f0000-0000-7000-8000-000000000002",
  projectRoot: "018f0000-0000-7000-8000-000000000003",
  laterModule: "018f0000-0000-7000-8000-000000000004",
  earlierModuleFirst: "018f0000-0000-7000-8000-000000000005",
  draftUndated: "018f0000-0000-7000-8000-000000000006",
  draftOlder: "018f0000-0000-7000-8000-000000000007",
  draftNewer: "018f0000-0000-7000-8000-000000000008",
  archivedProject: "018f0000-0000-7000-8000-000000000009",
  privateProject: "018f0000-0000-7000-8000-00000000000a",
  earlierModuleSecond: "018f0000-0000-7000-8000-00000000000b",
});

type ProjectPublicationStatus = "draft" | "planned" | "published" | "archived";

function projectRecord(
  id: string,
  title: string,
  navigationOrder: number,
  publicationStatus: ProjectPublicationStatus,
  writingModules: readonly Record<string, unknown>[] = [],
  relatedWriting: readonly string[] = [],
): Record<string, unknown> {
  const isPublic = publicationStatus === "published" || publicationStatus === "archived";
  return {
    id,
    title,
    slug: id,
    navigationOrder,
    summary: `Traceable implementation summary for ${id} with enough factual detail.`,
    status: publicationStatus === "archived" ? "archived" : "active",
    publicationStatus,
    startedAt: "2026-01",
    updatedAt: "2026-07-20",
    repositoryUrl: `https://example.com/${id}`,
    productionBranch: "main",
    showcaseMode: "repository",
    writingModules,
    ...(relatedWriting.length === 0 ? {} : {relatedWriting}),
    ...(isPublic
      ? {
          previewImage: {
            sourcePath: `projects/${id}/overview.webp`,
            width: 1600,
            height: 1000,
            alt: `${title} interface with verified navigation evidence`,
          },
        }
      : {}),
    source: [`docs/projects/${id}.md`],
  };
}

function projectSource(id: string): ProjectCatalogInput["projectSources"][number] {
  return {
    sourcePath: `site-content/projects/${id}/index.md`,
    isSymbolicLink: false,
    isRealPathWithinRoot: true,
    frontMatter: {},
    content: "## 可复核说明\n\n项目正文提供稳定的导航验收证据。\n",
  };
}

function createCatalogInput(): ProjectCatalogInput {
  return {
    projects: {
      sourcePath: "docs/contracts/projects.json",
      value: {
        version: "0.3.0",
        kind: "axial_muse_projects",
        status: "active",
        owner: "AxialMuseWebsite",
        lifecycleStatusValues: [...LIFECYCLE_STATUSES],
        publicationStatusValues: [...PUBLICATION_STATUSES],
        showcaseModes: [...SHOWCASE_MODES],
        projects: [
          projectRecord("empty-published", "Empty Published", 40, "published"),
          projectRecord("private-planned", "Private Planned", 30, "planned"),
          projectRecord("zeta-published", "Zeta Published", 20, "published", [
            {
              id: "later-module",
              displayName: "后置模块",
              navigationOrder: 20,
              status: "active",
            },
            {
              id: "earlier-module",
              displayName: "前置模块",
              navigationOrder: 10,
              status: "active",
            },
            {
              id: "empty-module",
              displayName: "空模块",
              navigationOrder: 30,
              status: "active",
            },
          ]),
          projectRecord("alpha-archived", "Alpha Archived", 10, "archived"),
        ],
      },
    },
    authors: {
      sourcePath: "docs/contracts/authors.json",
      value: {
        version: "0.1.0",
        kind: "axial_muse_authors",
        status: "active",
        owner: "AxialMuseWebsite",
        authors: {
          "example-author": {displayName: "示例作者"},
          "second-author": {displayName: "第二作者"},
        },
      },
    },
    topics: {
      sourcePath: "docs/contracts/topics.json",
      value: {
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
          performance: {
            displayName: "性能",
            navigationOrder: 20,
            status: "active",
          },
        },
      },
    },
    experiences: {
      sourcePath: "docs/contracts/project-experiences.json",
      value: {
        version: "0.1.0",
        kind: "axial_muse_project_experiences",
        status: "active",
        owner: "AxialMuseWebsite",
        canonicalDomain: "axialmuse.com",
        defaultDeliveryMode: "static",
        defaultIndexing: "noindex",
        statusValues: [...EXPERIENCE_STATUSES],
        deliveryModes: ["static"],
        reservedSubdomains: [...RESERVED_SUBDOMAINS],
        experiences: [],
      },
    },
    projectSources: [
      projectSource("zeta-published"),
      projectSource("empty-published"),
      projectSource("alpha-archived"),
    ],
  };
}

function articleSource(
  sourceName: string,
  articleId: string,
  publicationStatus: "draft" | "published" | "archived",
  options: Readonly<{
    publishedAt?: string;
    updatedAt?: string;
    project?: string;
    module?: string;
    authors?: readonly string[];
    topics?: readonly string[];
    seo?: Readonly<{
      description?: string;
      socialDescription?: string;
    }>;
    relations?: Readonly<{
      projects?: readonly string[];
      articles?: readonly string[];
    }>;
  }> = {},
): ArticleSourceInput {
  return {
    sourcePath: `site-content/writing/${sourceName}/index.md`,
    isSymbolicLink: false,
    isRealPathWithinRoot: true,
    frontMatter: {
      articleId,
      title: sourceName.split("-").map((part) => (
        part.charAt(0).toUpperCase() + part.slice(1)
      )).join(" "),
      slug: `/writing/${sourceName}`,
      summary: `A traceable technical article for ${sourceName} with sufficient validation detail.`,
      publicationStatus,
      authors: options.authors ?? ["example-author"],
      ...(options.publishedAt === undefined ? {} : {publishedAt: options.publishedAt}),
      ...(options.updatedAt === undefined ? {} : {updatedAt: options.updatedAt}),
      classification: {
        ...(options.project === undefined ? {} : {project: options.project}),
        ...(options.module === undefined ? {} : {module: options.module}),
        topics: options.topics ?? ["architecture"],
      },
      ...(options.seo === undefined ? {} : {seo: options.seo}),
      ...(options.relations === undefined ? {} : {relations: options.relations}),
    },
    content: "## 技术问题\n\n正文保留可复核的实现与测试证据。\n",
  };
}

function createArticleSources(): ArticleSourceInput[] {
  return [
    articleSource(
      "draft-without-date",
      ARTICLE_IDS.draftUndated,
      "draft",
    ),
    articleSource(
      "later-module-article",
      ARTICLE_IDS.laterModule,
      "published",
      {
        publishedAt: "2026-07-12",
        updatedAt: "2026-07-20",
        project: "zeta-published",
        module: "later-module",
        authors: ["second-author", "example-author"],
        topics: ["performance", "architecture"],
        seo: {
          description: "A focused metadata description for the module boundary article.",
          socialDescription: "A separate social description for sharing the module boundary article.",
        },
      },
    ),
    articleSource(
      "general-newer",
      ARTICLE_IDS.generalNewer,
      "archived",
      {
        publishedAt: "2026-07-15",
        updatedAt: "2026-07-19",
        seo: {
          description: "A focused metadata description for the archived general article.",
        },
      },
    ),
    articleSource(
      "earlier-module-second",
      ARTICLE_IDS.earlierModuleSecond,
      "archived",
      {
        publishedAt: "2026-07-10",
        updatedAt: "2026-07-18",
        project: "zeta-published",
        module: "earlier-module",
      },
    ),
    articleSource(
      "project-root",
      ARTICLE_IDS.projectRoot,
      "published",
      {
        publishedAt: "2026-07-13",
        updatedAt: "2026-07-20",
        project: "zeta-published",
        seo: {
          socialDescription: "A focused social description for the project root article.",
        },
      },
    ),
    articleSource(
      "draft-newer",
      ARTICLE_IDS.draftNewer,
      "draft",
      {updatedAt: "2026-07-20", project: "private-planned"},
    ),
    articleSource(
      "general-older",
      ARTICLE_IDS.generalOlder,
      "published",
      {publishedAt: "2026-07-01", updatedAt: "2026-07-16"},
    ),
    articleSource(
      "archived-project-root",
      ARTICLE_IDS.archivedProject,
      "archived",
      {
        publishedAt: "2026-07-11",
        updatedAt: "2026-07-17",
        project: "alpha-archived",
      },
    ),
    articleSource(
      "earlier-module-first",
      ARTICLE_IDS.earlierModuleFirst,
      "published",
      {
        publishedAt: "2026-07-10",
        updatedAt: "2026-07-18",
        project: "zeta-published",
        module: "earlier-module",
      },
    ),
    articleSource(
      "draft-older",
      ARTICLE_IDS.draftOlder,
      "draft",
      {updatedAt: "2026-07-10"},
    ),
  ];
}

function expectSuccess<T>(result: ValidationResult<T>): T {
  if (!result.ok) {
    assert.fail(`预期成功，实际问题：${result.issues.map((issue) => (
      `${issue.code}@${issue.fieldPath ?? issue.sourcePath}`
    )).join(", ")}`);
  }
  return result.value;
}

function expectFailure<T>(
  result: ValidationResult<T>,
  expectedCode: string,
): readonly ContentIssue[] {
  if (result.ok) assert.fail("预期失败，实际返回了 value。");
  assert.equal(Object.hasOwn(result, "value"), false);
  assert.ok(
    result.issues.some((issue) => issue.code === expectedCode),
    `缺少问题码 ${expectedCode}；实际为 ${result.issues.map((issue) => issue.code).join(", ")}`,
  );
  return result.issues;
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value as Record<string, unknown>)) {
    assertDeepFrozen(child, seen);
  }
}

function createValidatedCatalog(): ProjectCatalog {
  return expectSuccess(validateProjectCatalog(createCatalogInput()));
}

function createValidatedArticles(
  catalog: ProjectCatalog,
  sources: readonly ArticleSourceInput[] = createArticleSources(),
): readonly Article[] {
  return expectSuccess(validateArticleSource({catalog, sources}));
}

test("CODE-013 项目与技术分享导航按显式顺序稳定派生并省略空组", () => {
  const catalog = createValidatedCatalog();
  const sources = createArticleSources();
  const articles = createValidatedArticles(catalog, sources);

  const projects = expectSuccess(buildProjectNavigation({catalog, articles}));
  assert.deepEqual(projects, [
    {
      projectId: "alpha-archived",
      sourcePath: "site-content/projects/alpha-archived/index.md",
      title: "Alpha Archived",
      summary: "Traceable implementation summary for alpha-archived with enough factual detail.",
      canonicalPath: "/projects/alpha-archived/",
      navigationOrder: 10,
      status: "archived",
      publicationStatus: "archived",
      updatedAt: "2026-07-20",
      repositoryUrl: "https://example.com/alpha-archived",
      relatedWriting: [],
      previewImage: {
        publicUrl: "/assets/projects/alpha-archived/overview.webp",
        width: 1600,
        height: 1000,
        alt: "Alpha Archived interface with verified navigation evidence",
      },
    },
    {
      projectId: "zeta-published",
      sourcePath: "site-content/projects/zeta-published/index.md",
      title: "Zeta Published",
      summary: "Traceable implementation summary for zeta-published with enough factual detail.",
      canonicalPath: "/projects/zeta-published/",
      navigationOrder: 20,
      status: "active",
      publicationStatus: "published",
      updatedAt: "2026-07-20",
      repositoryUrl: "https://example.com/zeta-published",
      relatedWriting: [],
      previewImage: {
        publicUrl: "/assets/projects/zeta-published/overview.webp",
        width: 1600,
        height: 1000,
        alt: "Zeta Published interface with verified navigation evidence",
      },
    },
    {
      projectId: "empty-published",
      sourcePath: "site-content/projects/empty-published/index.md",
      title: "Empty Published",
      summary: "Traceable implementation summary for empty-published with enough factual detail.",
      canonicalPath: "/projects/empty-published/",
      navigationOrder: 40,
      status: "active",
      publicationStatus: "published",
      updatedAt: "2026-07-20",
      repositoryUrl: "https://example.com/empty-published",
      relatedWriting: [],
      previewImage: {
        publicUrl: "/assets/projects/empty-published/overview.webp",
        width: 1600,
        height: 1000,
        alt: "Empty Published interface with verified navigation evidence",
      },
    },
  ]);
  assert.deepEqual(
    Object.keys(projects[0]?.previewImage ?? {}),
    ["publicUrl", "width", "height", "alt"],
  );

  const production = expectSuccess(buildWritingNavigation({
    mode: "production",
    catalog,
    articles,
  }));
  assert.deepEqual(production.map((group) => (
    group.kind === "project" ? `${group.kind}:${group.projectId}` : group.kind
  )), ["general", "project:alpha-archived", "project:zeta-published"]);

  const general = production[0];
  assert.ok(general?.kind === "general");
  assert.deepEqual(
    general.articles.map((article) => [article.articleId, article.publicationStatus]),
    [
      [ARTICLE_IDS.generalNewer, "archived"],
      [ARTICLE_IDS.generalOlder, "published"],
    ],
  );
  const archivedGeneral = general.articles[0];
  const publishedGeneral = general.articles[1];
  assert.ok(archivedGeneral !== undefined && publishedGeneral !== undefined);
  assert.deepEqual(archivedGeneral.authors, [{id: "example-author", displayName: "示例作者"}]);
  assert.deepEqual(archivedGeneral.topics, [{id: "architecture", displayName: "架构"}]);
  assert.deepEqual(archivedGeneral.seo, {
    description: "A focused metadata description for the archived general article.",
    socialDescription: "A focused metadata description for the archived general article.",
  });
  assert.deepEqual(publishedGeneral.seo, {
    description: publishedGeneral.summary,
    socialDescription: publishedGeneral.summary,
  });
  assert.deepEqual(publishedGeneral.relatedProjects, []);
  assert.deepEqual(publishedGeneral.relatedArticles, []);

  const archivedProject = production[1];
  assert.ok(archivedProject?.kind === "project");
  assert.deepEqual(
    archivedProject.rootArticles.map((article) => article.articleId),
    [ARTICLE_IDS.archivedProject],
  );
  assert.deepEqual(archivedProject.modules, []);

  const publishedProject = production[2];
  assert.ok(publishedProject?.kind === "project");
  assert.deepEqual(
    publishedProject.rootArticles.map((article) => article.articleId),
    [ARTICLE_IDS.projectRoot],
  );
  assert.deepEqual(publishedProject.rootArticles[0]?.seo, {
    description: publishedProject.rootArticles[0]?.summary,
    socialDescription: "A focused social description for the project root article.",
  });
  assert.deepEqual(
    publishedProject.modules.map((module) => [
      module.moduleId,
      module.articles.map((article) => article.articleId),
    ]),
    [
      ["earlier-module", [ARTICLE_IDS.earlierModuleFirst, ARTICLE_IDS.earlierModuleSecond]],
      ["later-module", [ARTICLE_IDS.laterModule]],
    ],
  );
  const laterModuleArticle = publishedProject.modules[1]?.articles[0];
  assert.ok(laterModuleArticle !== undefined);
  assert.deepEqual(laterModuleArticle.authors, [
    {id: "second-author", displayName: "第二作者"},
    {id: "example-author", displayName: "示例作者"},
  ]);
  assert.deepEqual(laterModuleArticle.topics, [
    {id: "performance", displayName: "性能"},
    {id: "architecture", displayName: "架构"},
  ]);
  assert.deepEqual(laterModuleArticle.seo, {
    description: "A focused metadata description for the module boundary article.",
    socialDescription: "A separate social description for sharing the module boundary article.",
  });
  assert.equal(JSON.stringify(production).includes("empty-published"), false);
  assert.equal(JSON.stringify(production).includes("empty-module"), false);
  assert.equal(JSON.stringify(production).includes("正文保留可复核"), false);
  assert.doesNotMatch(JSON.stringify(production), /draft-(?:newer|older|without-date)|private-planned/u);

  const reversedArticles = createValidatedArticles(catalog, [...sources].reverse());
  assert.deepEqual(
    buildWritingNavigation({mode: "production", catalog, articles: reversedArticles}),
    buildWritingNavigation({mode: "production", catalog, articles}),
  );
  assertDeepFrozen(projects);
  assertDeepFrozen(production);
});

test("CODE-013 preview 草稿仅在末组出现，有日期优先且无日期稳定排末尾", () => {
  const catalog = createValidatedCatalog();
  const articles = createValidatedArticles(catalog);
  const production = expectSuccess(buildWritingNavigation({mode: "production", catalog, articles}));
  assert.equal(production.some((group) => group.kind === "draft"), false);

  const preview = expectSuccess(buildWritingNavigation({mode: "preview", catalog, articles}));
  const draftGroup = preview.at(-1);
  assert.ok(draftGroup?.kind === "draft");
  assert.deepEqual(draftGroup.articles.map((article) => article.articleId), [
    ARTICLE_IDS.draftNewer,
    ARTICLE_IDS.draftOlder,
    ARTICLE_IDS.draftUndated,
  ]);
  assert.equal(Object.hasOwn(draftGroup.articles[2] ?? {}, "updatedAt"), false);
  assert.deepEqual(draftGroup.articles[0]?.authors, [
    {id: "example-author", displayName: "示例作者"},
  ]);
  assert.deepEqual(draftGroup.articles[0]?.topics, [
    {id: "architecture", displayName: "架构"},
  ]);
  assert.deepEqual(draftGroup.articles[0]?.seo, {
    description: draftGroup.articles[0]?.summary,
    socialDescription: draftGroup.articles[0]?.summary,
  });
  assert.equal(
    preview.slice(0, -1).some((group) => (
      "articles" in group
      && group.articles.some((article) => article.publicationStatus === "draft")
    )),
    false,
  );
});

test("CODE-013 显式关联只投影当前可见目标的标题与规范路径并保留源顺序", () => {
  const catalogInput = createCatalogInput();
  const projectsDocument = catalogInput.projects.value as {
    projects: Array<Record<string, unknown>>;
  };
  const archivedProject = projectsDocument.projects.find(
    (project) => project.id === "alpha-archived",
  );
  assert.ok(archivedProject);
  archivedProject.relatedWriting = [
    ARTICLE_IDS.generalOlder,
    ARTICLE_IDS.generalNewer,
  ];
  const catalog = expectSuccess(validateProjectCatalog(catalogInput));
  const sources = createArticleSources();
  const generalNewer = sources.find(
    (source) => (
      (source.frontMatter as Record<string, unknown>).articleId
      === ARTICLE_IDS.generalNewer
    ),
  );
  const draftUndated = sources.find(
    (source) => (
      (source.frontMatter as Record<string, unknown>).articleId
      === ARTICLE_IDS.draftUndated
    ),
  );
  assert.ok(generalNewer);
  assert.ok(draftUndated);
  (generalNewer.frontMatter as Record<string, unknown>).relations = {
    projects: ["zeta-published", "alpha-archived"],
    articles: [ARTICLE_IDS.generalOlder, ARTICLE_IDS.projectRoot],
  };
  (draftUndated.frontMatter as Record<string, unknown>).relations = {
    projects: ["private-planned"],
    articles: [ARTICLE_IDS.draftOlder, ARTICLE_IDS.generalOlder],
  };
  const articles = createValidatedArticles(catalog, sources);

  const projects = expectSuccess(buildProjectNavigation({catalog, articles}));
  assert.deepEqual(projects[0]?.relatedWriting, [
    {
      title: "General Older",
      canonicalPath: "/writing/general-older/",
    },
    {
      title: "General Newer",
      canonicalPath: "/writing/general-newer/",
    },
  ]);

  const production = expectSuccess(buildWritingNavigation({
    mode: "production",
    catalog,
    articles,
  }));
  const projectedGeneralNewer = production
    .flatMap((group) => group.kind === "general" ? group.articles : [])
    .find((article) => article.articleId === ARTICLE_IDS.generalNewer);
  assert.ok(projectedGeneralNewer);
  assert.deepEqual(projectedGeneralNewer.relatedProjects, [
    {
      title: "Zeta Published",
      canonicalPath: "/projects/zeta-published/",
    },
    {
      title: "Alpha Archived",
      canonicalPath: "/projects/alpha-archived/",
    },
  ]);
  assert.deepEqual(projectedGeneralNewer.relatedArticles, [
    {
      title: "General Older",
      canonicalPath: "/writing/general-older/",
    },
    {
      title: "Project Root",
      canonicalPath: "/writing/project-root/",
    },
  ]);

  const preview = expectSuccess(buildWritingNavigation({
    mode: "preview",
    catalog,
    articles,
  }));
  const draftGroup = preview.at(-1);
  assert.ok(draftGroup?.kind === "draft");
  const projectedDraft = draftGroup.articles.find(
    (article) => article.articleId === ARTICLE_IDS.draftUndated,
  );
  assert.ok(projectedDraft);
  assert.deepEqual(projectedDraft.relatedProjects, []);
  assert.deepEqual(projectedDraft.relatedArticles, [
    {
      title: "Draft Older",
      canonicalPath: "/writing/draft-older/",
    },
    {
      title: "General Older",
      canonicalPath: "/writing/general-older/",
    },
  ]);
  assertDeepFrozen(projects);
  assertDeepFrozen(production);
  assertDeepFrozen(preview);
});

test("CODE-013 日期索引只有公开文章、字段精确且按 articleId ASCII 排序", () => {
  const catalog = createValidatedCatalog();
  const articles = createValidatedArticles(catalog);
  const index = expectSuccess(buildArticleDateIndex({articles}));
  const excludedIds = new Set<string>([
    ARTICLE_IDS.draftUndated,
    ARTICLE_IDS.draftOlder,
    ARTICLE_IDS.draftNewer,
    ARTICLE_IDS.privateProject,
  ]);
  const expectedIds = Object.values(ARTICLE_IDS)
    .filter((articleId) => !excludedIds.has(articleId))
    .sort();
  assert.deepEqual(index.map((entry) => entry.articleId), expectedIds);
  for (const entry of index) {
    assert.deepEqual(Object.keys(entry), ["articleId", "slug", "publishedAt", "updatedAt"]);
  }
  assertDeepFrozen(index);
});

test("E-016 空文章成功批次生成空导航与空日期索引，不补造分组", () => {
  const catalog = createValidatedCatalog();
  const articles = createValidatedArticles(catalog, []);
  assert.deepEqual(expectSuccess(buildWritingNavigation({mode: "production", catalog, articles})), []);
  assert.deepEqual(expectSuccess(buildWritingNavigation({mode: "preview", catalog, articles})), []);
  assert.deepEqual(expectSuccess(buildArticleDateIndex({articles})), []);
});

test("E-016 catalog、文章 clone/伪造及跨 catalog 混用均按稳定 issue 失败关闭", () => {
  const catalog = createValidatedCatalog();
  const articles = createValidatedArticles(catalog);
  const clonedCatalog = structuredClone(catalog);
  const clonedArticles = structuredClone(articles);

  expectFailure(
    buildProjectNavigation({catalog: clonedCatalog, articles}),
    "CONTENT_NAVIGATION_CATALOG_INVALID",
  );
  expectFailure(
    buildProjectNavigation({catalog, articles: clonedArticles}),
    "CONTENT_NAVIGATION_ARTICLES_INVALID",
  );
  expectFailure(
    buildWritingNavigation({mode: "production", catalog, articles: clonedArticles}),
    "CONTENT_NAVIGATION_ARTICLES_INVALID",
  );
  expectFailure(
    buildWritingNavigation({mode: "production", catalog, articles: [...articles]}),
    "CONTENT_NAVIGATION_ARTICLES_INVALID",
  );
  expectFailure(
    buildArticleDateIndex({articles: clonedArticles}),
    "CONTENT_NAVIGATION_ARTICLES_INVALID",
  );

  const equivalentCatalog = createValidatedCatalog();
  expectFailure(
    buildWritingNavigation({mode: "production", catalog: equivalentCatalog, articles}),
    "CONTENT_NAVIGATION_ARTICLES_INVALID",
  );
  expectFailure(
    buildProjectNavigation({
      catalog: structuredClone(catalog) as ProjectCatalog,
      articles,
    }),
    "CONTENT_NAVIGATION_CATALOG_INVALID",
  );
});

test("E-016 公开文章归属未公开项目时在领域入口原子失败且诊断不泄露标题", () => {
  const catalog = createValidatedCatalog();
  const privateArticle = articleSource(
    "public-under-private-project",
    ARTICLE_IDS.privateProject,
    "published",
    {
      publishedAt: "2026-07-20",
      updatedAt: "2026-07-21",
      project: "private-planned",
    },
  );
  const issues = expectFailure(
    validateArticleSource({catalog, sources: [privateArticle]}),
    "CONTENT_ARTICLE_PROJECT_UNPUBLISHED",
  );
  assert.equal(
    issues.some((issue) => (
      issue.sourcePath === privateArticle.sourcePath
      && issue.fieldPath === "classification.project"
    )),
    true,
  );
  assert.doesNotMatch(JSON.stringify(issues), /Private Planned/u);
});

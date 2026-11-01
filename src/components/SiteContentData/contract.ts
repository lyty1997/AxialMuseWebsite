export interface SiteProjectPreviewImage {
  readonly publicUrl: string;
  readonly width: 1600;
  readonly height: 1000;
  readonly alt: string;
}

export interface SiteContentLink {
  readonly title: string;
  readonly canonicalPath: string;
}

export interface SiteProject {
  readonly projectId: string;
  readonly sourcePath: string;
  readonly title: string;
  readonly summary: string;
  readonly canonicalPath: string;
  readonly navigationOrder: number;
  readonly status: "active" | "paused" | "completed" | "archived";
  readonly publicationStatus: "draft" | "planned" | "published" | "archived";
  readonly updatedAt: string;
  readonly repositoryUrl?: string;
  readonly relatedWriting: readonly SiteContentLink[];
  readonly previewImage?: SiteProjectPreviewImage;
}

export interface SiteArticleAuthor {
  readonly id: string;
  readonly displayName: string;
}

export interface SiteArticleTopic {
  readonly id: string;
  readonly displayName: string;
}

export interface SiteArticleSeo {
  readonly description: string;
  readonly socialDescription: string;
}

interface SiteArticleBase {
  readonly articleId: string;
  readonly sourcePath: string;
  readonly title: string;
  readonly summary: string;
  readonly canonicalPath: string;
  readonly authors: readonly SiteArticleAuthor[];
  readonly topics: readonly SiteArticleTopic[];
  readonly seo: SiteArticleSeo;
  readonly relatedProjects: readonly SiteContentLink[];
  readonly relatedArticles: readonly SiteContentLink[];
}

export interface SitePublicArticle extends SiteArticleBase {
  readonly publicationStatus: "published" | "archived";
  readonly publishedAt: string;
  readonly updatedAt: string;
}

export interface SiteDraftArticle extends SiteArticleBase {
  readonly publicationStatus: "draft";
  readonly updatedAt?: string;
}

export type SiteArticle = SitePublicArticle | SiteDraftArticle;

export interface SiteGeneralWritingGroup {
  readonly kind: "general";
  readonly label: "通用技术";
  readonly articles: readonly SitePublicArticle[];
}

export interface SiteModuleWritingGroup {
  readonly kind: "module";
  readonly moduleId: string;
  readonly label: string;
  readonly navigationOrder: number;
  readonly articles: readonly SitePublicArticle[];
}

export interface SiteProjectWritingGroup {
  readonly kind: "project";
  readonly projectId: string;
  readonly label: string;
  readonly navigationOrder: number;
  readonly rootArticles: readonly SitePublicArticle[];
  readonly modules: readonly SiteModuleWritingGroup[];
}

export interface SiteDraftWritingGroup {
  readonly kind: "draft";
  readonly label: "草稿";
  readonly articles: readonly SiteDraftArticle[];
}

export type SiteWritingGroup =
  | SiteGeneralWritingGroup
  | SiteProjectWritingGroup
  | SiteDraftWritingGroup;

export interface SiteContentData {
  readonly projectNavigation: readonly SiteProject[];
  readonly writingNavigation: readonly SiteWritingGroup[];
}

export type SiteContentDetail =
  | Readonly<{kind: "project"; item: SiteProject}>
  | Readonly<{kind: "article"; item: SiteArticle}>;

type JsonRecord = Readonly<Record<string, unknown>>;

const PROJECT_STATUSES = new Set(["active", "paused", "completed", "archived"]);
const PROJECT_PUBLICATION_STATUSES = new Set([
  "draft",
  "planned",
  "published",
  "archived",
]);
const PUBLIC_ARTICLE_STATUSES = new Set(["published", "archived"]);

function fail(fieldPath: string): never {
  throw new Error(
    `[SITE_CONTENT_DATA_INVALID] 安全展示投影不符合约定：${fieldPath}。`,
  );
}

function record(value: unknown, fieldPath: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(fieldPath);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  allowed: readonly string[],
  fieldPath: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) fail(fieldPath);
}

function array(value: unknown, fieldPath: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(fieldPath);
  return value;
}

function string(
  value: unknown,
  fieldPath: string,
  options: Readonly<{allowEmpty?: boolean}> = {},
): string {
  if (
    typeof value !== "string"
    || (options.allowEmpty !== true && value.trim().length === 0)
  ) {
    fail(fieldPath);
  }
  return value;
}

function positiveInteger(value: unknown, fieldPath: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(fieldPath);
  return value as number;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  fieldPath: string,
): T {
  const candidate = string(value, fieldPath);
  if (!allowed.has(candidate)) fail(fieldPath);
  return candidate as T;
}

function canonicalPath(value: unknown, fieldPath: string): string {
  const candidate = string(value, fieldPath);
  if (
    candidate !== "/"
    && !/^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)+$/u.test(candidate)
  ) {
    fail(fieldPath);
  }
  return candidate;
}

function sourcePath(value: unknown, fieldPath: string): string {
  const candidate = string(value, fieldPath);
  if (
    candidate.startsWith("/")
    || candidate.includes("\\")
    || candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(fieldPath);
  }
  return candidate;
}

function httpsUrl(value: unknown, fieldPath: string): string {
  const candidate = string(value, fieldPath);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    fail(fieldPath);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hash !== ""
  ) {
    fail(fieldPath);
  }
  return candidate;
}

function assetUrl(value: unknown, fieldPath: string): string {
  const candidate = string(value, fieldPath);
  if (
    !candidate.startsWith("/assets/")
    || candidate.includes("\\")
    || candidate.includes("?")
    || candidate.includes("#")
    || candidate.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    fail(fieldPath);
  }
  return candidate;
}

function date(value: unknown, fieldPath: string): string {
  const candidate = string(value, fieldPath);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) fail(fieldPath);
  return candidate;
}

function readContentLinks(
  value: unknown,
  fieldPath: string,
  kind: "project" | "article",
  maximum: 5 | 10,
): readonly SiteContentLink[] {
  const entries = array(value, fieldPath);
  if (entries.length > maximum) fail(fieldPath);
  const routes = new Set<string>();
  return entries.map((entry, index) => {
    const itemPath = `${fieldPath}.${index}`;
    const candidate = record(entry, itemPath);
    exactKeys(candidate, ["title", "canonicalPath"], itemPath);
    const route = canonicalPath(
      candidate.canonicalPath,
      `${itemPath}.canonicalPath`,
    );
    const routePattern = kind === "project"
      ? /^\/projects\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/u
      : /^\/writing\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/u;
    if (!routePattern.test(route) || routes.has(route)) {
      fail(`${itemPath}.canonicalPath`);
    }
    routes.add(route);
    return {
      title: string(candidate.title, `${itemPath}.title`),
      canonicalPath: route,
    };
  });
}

function readProject(value: unknown, fieldPath: string): SiteProject {
  const candidate = record(value, fieldPath);
  exactKeys(candidate, [
    "projectId",
    "sourcePath",
    "title",
    "summary",
    "canonicalPath",
    "navigationOrder",
    "status",
    "publicationStatus",
    "updatedAt",
    "repositoryUrl",
    "relatedWriting",
    "previewImage",
  ], fieldPath);
  const publicationStatus = enumValue<SiteProject["publicationStatus"]>(
    candidate.publicationStatus,
    PROJECT_PUBLICATION_STATUSES,
    `${fieldPath}.publicationStatus`,
  );
  const preview = candidate.previewImage === undefined
    ? undefined
    : record(candidate.previewImage, `${fieldPath}.previewImage`);
  if (preview !== undefined) {
    exactKeys(
      preview,
      ["publicUrl", "width", "height", "alt"],
      `${fieldPath}.previewImage`,
    );
    const width = positiveInteger(preview.width, `${fieldPath}.previewImage.width`);
    const height = positiveInteger(preview.height, `${fieldPath}.previewImage.height`);
    if (width !== 1600 || height !== 1000) fail(`${fieldPath}.previewImage`);
  } else if (publicationStatus === "published" || publicationStatus === "archived") {
    fail(`${fieldPath}.previewImage`);
  }
  const projectCanonicalPath = canonicalPath(
    candidate.canonicalPath,
    `${fieldPath}.canonicalPath`,
  );
  if (!/^\/projects\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/u.test(projectCanonicalPath)) {
    fail(`${fieldPath}.canonicalPath`);
  }
  return {
    projectId: string(candidate.projectId, `${fieldPath}.projectId`),
    sourcePath: sourcePath(candidate.sourcePath, `${fieldPath}.sourcePath`),
    title: string(candidate.title, `${fieldPath}.title`),
    summary: string(candidate.summary, `${fieldPath}.summary`),
    canonicalPath: projectCanonicalPath,
    navigationOrder: positiveInteger(
      candidate.navigationOrder,
      `${fieldPath}.navigationOrder`,
    ),
    status: enumValue<SiteProject["status"]>(
      candidate.status,
      PROJECT_STATUSES,
      `${fieldPath}.status`,
    ),
    publicationStatus,
    updatedAt: date(candidate.updatedAt, `${fieldPath}.updatedAt`),
    ...(candidate.repositoryUrl === undefined
      ? {}
      : {repositoryUrl: httpsUrl(candidate.repositoryUrl, `${fieldPath}.repositoryUrl`)}),
    relatedWriting: readContentLinks(
      candidate.relatedWriting,
      `${fieldPath}.relatedWriting`,
      "article",
      10,
    ),
    ...(preview === undefined
      ? {}
      : {
          previewImage: {
            publicUrl: assetUrl(preview.publicUrl, `${fieldPath}.previewImage.publicUrl`),
            width: 1600 as const,
            height: 1000 as const,
            alt: string(preview.alt, `${fieldPath}.previewImage.alt`),
          },
        }),
  };
}

function readAuthors(value: unknown, fieldPath: string): readonly SiteArticleAuthor[] {
  return array(value, fieldPath).map((entry, index) => {
    const candidate = record(entry, `${fieldPath}.${index}`);
    exactKeys(candidate, ["id", "displayName"], `${fieldPath}.${index}`);
    return {
      id: string(candidate.id, `${fieldPath}.${index}.id`),
      displayName: string(candidate.displayName, `${fieldPath}.${index}.displayName`),
    };
  });
}

function readTopics(value: unknown, fieldPath: string): readonly SiteArticleTopic[] {
  return array(value, fieldPath).map((entry, index) => {
    const candidate = record(entry, `${fieldPath}.${index}`);
    exactKeys(candidate, ["id", "displayName"], `${fieldPath}.${index}`);
    return {
      id: string(candidate.id, `${fieldPath}.${index}.id`),
      displayName: string(candidate.displayName, `${fieldPath}.${index}.displayName`),
    };
  });
}

function readArticle(
  value: unknown,
  fieldPath: string,
  expectedStatus: "public" | "draft",
): SiteArticle {
  const candidate = record(value, fieldPath);
  exactKeys(candidate, [
    "articleId",
    "sourcePath",
    "title",
    "summary",
    "canonicalPath",
    "publicationStatus",
    "publishedAt",
    "updatedAt",
    "authors",
    "topics",
    "seo",
    "relatedProjects",
    "relatedArticles",
  ], fieldPath);
  const publicationStatus = expectedStatus === "draft"
    ? enumValue<"draft">(
        candidate.publicationStatus,
        new Set(["draft"]),
        `${fieldPath}.publicationStatus`,
      )
    : enumValue<"published" | "archived">(
        candidate.publicationStatus,
        PUBLIC_ARTICLE_STATUSES,
        `${fieldPath}.publicationStatus`,
      );
  const seo = record(candidate.seo, `${fieldPath}.seo`);
  exactKeys(
    seo,
    ["description", "socialDescription"],
    `${fieldPath}.seo`,
  );
  const articleCanonicalPath = canonicalPath(
    candidate.canonicalPath,
    `${fieldPath}.canonicalPath`,
  );
  if (!/^\/writing\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/u.test(articleCanonicalPath)) {
    fail(`${fieldPath}.canonicalPath`);
  }
  const authors = readAuthors(candidate.authors, `${fieldPath}.authors`);
  const topics = readTopics(candidate.topics, `${fieldPath}.topics`);
  if (authors.length === 0) fail(`${fieldPath}.authors`);
  if (topics.length === 0) fail(`${fieldPath}.topics`);
  const base = {
    articleId: string(candidate.articleId, `${fieldPath}.articleId`),
    sourcePath: sourcePath(candidate.sourcePath, `${fieldPath}.sourcePath`),
    title: string(candidate.title, `${fieldPath}.title`),
    summary: string(candidate.summary, `${fieldPath}.summary`),
    canonicalPath: articleCanonicalPath,
    authors,
    topics,
    seo: {
      description: string(seo.description, `${fieldPath}.seo.description`),
      socialDescription: string(
        seo.socialDescription,
        `${fieldPath}.seo.socialDescription`,
      ),
    },
    relatedProjects: readContentLinks(
      candidate.relatedProjects,
      `${fieldPath}.relatedProjects`,
      "project",
      5,
    ),
    relatedArticles: readContentLinks(
      candidate.relatedArticles,
      `${fieldPath}.relatedArticles`,
      "article",
      10,
    ),
  };
  if (publicationStatus === "draft") {
    if (candidate.publishedAt !== undefined) fail(`${fieldPath}.publishedAt`);
    return {
      ...base,
      publicationStatus,
      ...(candidate.updatedAt === undefined
        ? {}
        : {updatedAt: date(candidate.updatedAt, `${fieldPath}.updatedAt`)}),
    };
  }
  return {
    ...base,
    publicationStatus,
    publishedAt: date(candidate.publishedAt, `${fieldPath}.publishedAt`),
    updatedAt: date(candidate.updatedAt, `${fieldPath}.updatedAt`),
  };
}

function readPublicArticles(
  value: unknown,
  fieldPath: string,
): readonly SitePublicArticle[] {
  return array(value, fieldPath).map((entry, index) => (
    readArticle(entry, `${fieldPath}.${index}`, "public") as SitePublicArticle
  ));
}

function readWritingGroup(value: unknown, fieldPath: string): SiteWritingGroup {
  const candidate = record(value, fieldPath);
  const kind = string(candidate.kind, `${fieldPath}.kind`);
  if (kind === "general") {
    exactKeys(candidate, ["kind", "label", "articles"], fieldPath);
    if (candidate.label !== "通用技术") fail(`${fieldPath}.label`);
    return {
      kind,
      label: "通用技术",
      articles: readPublicArticles(candidate.articles, `${fieldPath}.articles`),
    };
  }
  if (kind === "draft") {
    exactKeys(candidate, ["kind", "label", "articles"], fieldPath);
    if (candidate.label !== "草稿") fail(`${fieldPath}.label`);
    return {
      kind,
      label: "草稿",
      articles: array(candidate.articles, `${fieldPath}.articles`).map(
        (entry, index) => (
          readArticle(entry, `${fieldPath}.articles.${index}`, "draft") as SiteDraftArticle
        ),
      ),
    };
  }
  if (kind !== "project") fail(`${fieldPath}.kind`);
  exactKeys(candidate, [
    "kind",
    "projectId",
    "label",
    "navigationOrder",
    "rootArticles",
    "modules",
  ], fieldPath);
  return {
    kind,
    projectId: string(candidate.projectId, `${fieldPath}.projectId`),
    label: string(candidate.label, `${fieldPath}.label`),
    navigationOrder: positiveInteger(
      candidate.navigationOrder,
      `${fieldPath}.navigationOrder`,
    ),
    rootArticles: readPublicArticles(
      candidate.rootArticles,
      `${fieldPath}.rootArticles`,
    ),
    modules: array(candidate.modules, `${fieldPath}.modules`).map((entry, index) => {
      const module = record(entry, `${fieldPath}.modules.${index}`);
      exactKeys(module, [
        "kind",
        "moduleId",
        "label",
        "navigationOrder",
        "articles",
      ], `${fieldPath}.modules.${index}`);
      if (module.kind !== "module") fail(`${fieldPath}.modules.${index}.kind`);
      return {
        kind: "module",
        moduleId: string(module.moduleId, `${fieldPath}.modules.${index}.moduleId`),
        label: string(module.label, `${fieldPath}.modules.${index}.label`),
        navigationOrder: positiveInteger(
          module.navigationOrder,
          `${fieldPath}.modules.${index}.navigationOrder`,
        ),
        articles: readPublicArticles(
          module.articles,
          `${fieldPath}.modules.${index}.articles`,
        ),
      };
    }),
  };
}

export function readSiteContentData(value: unknown): SiteContentData {
  const candidate = record(value, "root");
  exactKeys(candidate, ["projectNavigation", "writingNavigation"], "root");
  const projectNavigation = array(
    candidate.projectNavigation,
    "projectNavigation",
  ).map((entry, index) => readProject(entry, `projectNavigation.${index}`));
  const writingNavigation = array(
    candidate.writingNavigation,
    "writingNavigation",
  ).map((entry, index) => readWritingGroup(entry, `writingNavigation.${index}`));

  const routes = new Set<string>(["/", "/projects/", "/writing/"]);
  for (const project of projectNavigation) {
    if (routes.has(project.canonicalPath)) fail("projectNavigation.canonicalPath");
    routes.add(project.canonicalPath);
  }
  for (const article of siteArticles({projectNavigation, writingNavigation})) {
    if (routes.has(article.canonicalPath)) fail("writingNavigation.canonicalPath");
    routes.add(article.canonicalPath);
  }
  const projectsByRoute = new Map(
    projectNavigation.map((project) => [project.canonicalPath, project]),
  );
  const articles = siteArticles({projectNavigation, writingNavigation});
  const articlesByRoute = new Map(
    articles.map((article) => [article.canonicalPath, article]),
  );
  const assertResolvedLinks = (
    links: readonly SiteContentLink[],
    targets: ReadonlyMap<
      string,
      Readonly<{title: string; publicationStatus: string}>
    >,
    fieldPath: string,
    selfPath?: string,
    requirePublicTarget = false,
  ): void => {
    for (const [index, link] of links.entries()) {
      const target = targets.get(link.canonicalPath);
      if (
        target === undefined
        || target.title !== link.title
        || link.canonicalPath === selfPath
        || (requirePublicTarget && target.publicationStatus === "draft")
      ) {
        fail(`${fieldPath}.${index}`);
      }
    }
  };
  for (const [projectIndex, project] of projectNavigation.entries()) {
    assertResolvedLinks(
      project.relatedWriting,
      articlesByRoute,
      `projectNavigation.${projectIndex}.relatedWriting`,
      undefined,
      project.publicationStatus === "published"
        || project.publicationStatus === "archived",
    );
  }
  for (const [articleIndex, article] of articles.entries()) {
    assertResolvedLinks(
      article.relatedProjects,
      projectsByRoute,
      `articles.${articleIndex}.relatedProjects`,
    );
    assertResolvedLinks(
      article.relatedArticles,
      articlesByRoute,
      `articles.${articleIndex}.relatedArticles`,
      article.canonicalPath,
      article.publicationStatus !== "draft",
    );
  }
  return {projectNavigation, writingNavigation};
}

export function siteArticles(data: SiteContentData): readonly SiteArticle[] {
  const articles: SiteArticle[] = [];
  for (const group of data.writingNavigation) {
    if (group.kind === "general" || group.kind === "draft") {
      articles.push(...group.articles);
      continue;
    }
    articles.push(
      ...group.rootArticles,
      ...group.modules.flatMap((module) => module.articles),
    );
  }
  return articles;
}

export function canonicalizeSitePathname(pathname: string): string {
  if (pathname === "/") return pathname;
  if (
    !pathname.startsWith("/")
    || pathname.includes("\\")
    || pathname.includes("?")
    || pathname.includes("#")
    || pathname.includes("//")
  ) {
    throw new Error("[SITE_CONTENT_ROUTE_INVALID] 当前页面路径不规范。");
  }
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

export function findSiteContentDetail(
  data: SiteContentData,
  pathname: string,
): SiteContentDetail {
  const route = canonicalizeSitePathname(pathname);
  const project = data.projectNavigation.find((item) => item.canonicalPath === route);
  if (project !== undefined) return {kind: "project", item: project};
  const article = siteArticles(data).find((item) => item.canonicalPath === route);
  if (article !== undefined) return {kind: "article", item: article};
  throw new Error("[SITE_CONTENT_ROUTE_UNKNOWN] 当前详情路由不属于安全展示投影。");
}

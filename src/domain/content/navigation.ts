import {isValidatedArticleCollection} from "./article-source.js";
import {isValidatedProjectCatalog} from "./project-catalog.js";
import type {
  Article,
  ArticleAuthorNavigationItem,
  ArticleDateIndexEntry,
  ArticleDateIndexInput,
  ArticleSeoNavigationInput,
  ArticleTopicNavigationItem,
  DraftArticleNavigationItem,
  ModuleWritingGroup,
  Project,
  ProjectNavigationInput,
  ProjectNavigationItem,
  ProjectWritingGroup,
  PublicArticleNavigationItem,
  ValidationResult,
  WritingNavigationGroup,
  WritingNavigationInput,
} from "./types.js";
import {
  compareCodePoints,
  failure,
  isRecord,
  IssueCollector,
  success,
} from "./validation.js";

const PROJECTS_PATH = "docs/contracts/projects.json";
const WRITING_ROOT = "site-content/writing";
const PUBLICATION_STATUSES = ["published", "archived"] as const;

type PublicArticle = Article & Readonly<{
  publicationStatus: "published" | "archived";
  publishedAt: string;
  updatedAt: string;
}>;

type PublicProject = Project & Readonly<{
  publicationStatus: "published" | "archived";
}>;

interface ArticleDisplayProjection {
  readonly authors: readonly ArticleAuthorNavigationItem[];
  readonly topics: readonly ArticleTopicNavigationItem[];
  readonly seo: ArticleSeoNavigationInput;
}

interface ArticleDisplayIndexes {
  readonly authors: ReadonlyMap<string, Readonly<{id: string; displayName: string}>>;
  readonly topics: ReadonlyMap<string, Readonly<{id: string; displayName: string}>>;
}

function isPublicProject(project: Project): project is PublicProject {
  return PUBLICATION_STATUSES.includes(
    project.publicationStatus as typeof PUBLICATION_STATUSES[number],
  );
}

function isPublicArticle(article: Article): article is PublicArticle {
  return PUBLICATION_STATUSES.includes(
    article.publicationStatus as typeof PUBLICATION_STATUSES[number],
  );
}

function canonicalProjectPath(slug: string): string {
  return `/projects/${slug}/`;
}

function canonicalArticlePath(slug: string): string {
  return `${slug}/`;
}

function comparePublicArticles(left: PublicArticle, right: PublicArticle): number {
  return compareCodePoints(right.publishedAt, left.publishedAt)
    || compareCodePoints(left.articleId, right.articleId);
}

function compareDraftArticles(left: Article, right: Article): number {
  if (left.updatedAt !== undefined && right.updatedAt === undefined) return -1;
  if (left.updatedAt === undefined && right.updatedAt !== undefined) return 1;
  if (left.updatedAt !== undefined && right.updatedAt !== undefined) {
    const dateOrder = compareCodePoints(right.updatedAt, left.updatedAt);
    if (dateOrder !== 0) return dateOrder;
  }
  return compareCodePoints(left.articleId, right.articleId);
}

function createArticleDisplayIndexes(input: WritingNavigationInput): ArticleDisplayIndexes {
  return {
    authors: new Map(input.catalog.authors.map((author) => [author.id, author])),
    topics: new Map(input.catalog.topics.map((topic) => [topic.id, topic])),
  };
}

function resolveArticleDisplayProjection(
  article: Article,
  indexes: ArticleDisplayIndexes,
  collector: IssueCollector,
): ArticleDisplayProjection | undefined {
  const authors: ArticleAuthorNavigationItem[] = [];
  for (const authorId of article.authors) {
    const author = indexes.authors.get(authorId);
    if (author === undefined) {
      collector.add(
        "CONTENT_NAVIGATION_AUTHOR_UNKNOWN",
        article.sourcePath,
        "authors",
        "文章显示投影引用了未登记作者。",
      );
      continue;
    }
    authors.push({id: author.id, displayName: author.displayName});
  }

  const topics: ArticleTopicNavigationItem[] = [];
  for (const topicId of article.classification.topics) {
    const topic = indexes.topics.get(topicId);
    if (topic === undefined) {
      collector.add(
        "CONTENT_NAVIGATION_TOPIC_UNKNOWN",
        article.sourcePath,
        "classification.topics",
        "文章显示投影引用了未登记主题。",
      );
      continue;
    }
    topics.push({id: topic.id, displayName: topic.displayName});
  }

  if (
    authors.length !== article.authors.length
    || topics.length !== article.classification.topics.length
  ) {
    return undefined;
  }
  const description = article.seo?.description ?? article.summary;
  return {
    authors,
    topics,
    seo: {
      description,
      socialDescription: article.seo?.socialDescription ?? description,
    },
  };
}

function toPublicNavigationItem(
  article: PublicArticle,
  indexes: ArticleDisplayIndexes,
  collector: IssueCollector,
): PublicArticleNavigationItem | undefined {
  const display = resolveArticleDisplayProjection(article, indexes, collector);
  if (display === undefined) return undefined;
  return {
    articleId: article.articleId,
    sourcePath: article.sourcePath,
    title: article.title,
    summary: article.summary,
    canonicalPath: canonicalArticlePath(article.slug),
    publicationStatus: article.publicationStatus,
    publishedAt: article.publishedAt,
    updatedAt: article.updatedAt,
    ...display,
  };
}

function toDraftNavigationItem(
  article: Article,
  indexes: ArticleDisplayIndexes,
  collector: IssueCollector,
): DraftArticleNavigationItem | undefined {
  const display = resolveArticleDisplayProjection(article, indexes, collector);
  if (display === undefined) return undefined;
  return {
    articleId: article.articleId,
    sourcePath: article.sourcePath,
    title: article.title,
    summary: article.summary,
    canonicalPath: canonicalArticlePath(article.slug),
    publicationStatus: "draft",
    ...(article.updatedAt === undefined ? {} : {updatedAt: article.updatedAt}),
    ...display,
  };
}

function addCatalogIssue(collector: IssueCollector): void {
  collector.add(
    "CONTENT_NAVIGATION_CATALOG_INVALID",
    PROJECTS_PATH,
    undefined,
    "导航派生只接受当前领域校验成功的项目目录。",
  );
}

function addArticleCollectionIssue(collector: IssueCollector): void {
  collector.add(
    "CONTENT_NAVIGATION_ARTICLES_INVALID",
    WRITING_ROOT,
    undefined,
    "派生模型只接受与当前项目目录一起校验成功的文章集合。",
  );
}

export function buildProjectNavigation(
  input: ProjectNavigationInput,
): ValidationResult<readonly ProjectNavigationItem[]> {
  const collector = new IssueCollector();
  if (!isRecord(input) || !isValidatedProjectCatalog(input.catalog)) {
    addCatalogIssue(collector);
    return failure(collector);
  }

  const sourceByProjectId = new Map(
    input.catalog.projectSources.map((source) => [source.projectId, source.sourcePath]),
  );
  const items: ProjectNavigationItem[] = [];
  for (const project of input.catalog.projects) {
    if (!isPublicProject(project)) continue;
    const sourcePath = sourceByProjectId.get(project.id);
    if (sourcePath === undefined) {
      collector.add(
        "CONTENT_PROJECT_NAVIGATION_SOURCE_MISSING",
        PROJECTS_PATH,
        `projectsById.${project.id}.publicationStatus`,
        "公开项目缺少已验证的唯一正文入口。",
      );
      continue;
    }
    if (project.previewImage === undefined) {
      collector.add(
        "CONTENT_PROJECT_NAVIGATION_DISPLAY_INVALID",
        PROJECTS_PATH,
        `projectsById.${project.id}.publicationStatus`,
        "公开项目缺少已验证的主预览显示输入。",
      );
      continue;
    }
    items.push({
      projectId: project.id,
      sourcePath,
      title: project.title,
      summary: project.summary,
      canonicalPath: canonicalProjectPath(project.slug),
      navigationOrder: project.navigationOrder,
      status: project.status,
      publicationStatus: project.publicationStatus,
      updatedAt: project.updatedAt,
      ...(project.repositoryUrl === undefined ? {} : {repositoryUrl: project.repositoryUrl}),
      previewImage: {
        publicUrl: `/assets/${project.previewImage.sourcePath}`,
        width: project.previewImage.width,
        height: project.previewImage.height,
        alt: project.previewImage.alt,
      },
    });
  }

  if (collector.hasIssues()) return failure(collector);
  items.sort((left, right) => (
    left.navigationOrder - right.navigationOrder
    || compareCodePoints(left.projectId, right.projectId)
  ));
  return success(items);
}

function validateWritingInput(
  input: WritingNavigationInput,
  collector: IssueCollector,
): input is WritingNavigationInput {
  if (!isRecord(input)) {
    addCatalogIssue(collector);
    return false;
  }
  if (!isValidatedProjectCatalog(input.catalog)) addCatalogIssue(collector);
  if (
    !isValidatedArticleCollection(
      input.articles,
      isValidatedProjectCatalog(input.catalog) ? input.catalog : undefined,
    )
  ) {
    addArticleCollectionIssue(collector);
  }
  if (input.mode !== "production" && input.mode !== "preview") {
    collector.add(
      "CONTENT_NAVIGATION_MODE_INVALID",
      WRITING_ROOT,
      "mode",
      "导航构建模式必须是 production 或 preview。",
    );
  }
  return !collector.hasIssues();
}

export function buildWritingNavigation(
  input: WritingNavigationInput,
): ValidationResult<readonly WritingNavigationGroup[]> {
  const collector = new IssueCollector();
  if (!validateWritingInput(input, collector)) return failure(collector);

  const projectsById = new Map(input.catalog.projects.map((project) => [project.id, project]));
  const publicArticles = input.articles.filter(isPublicArticle);
  if (input.mode === "production") {
    for (const article of publicArticles) {
      const projectId = article.classification.project;
      if (projectId === undefined) continue;
      const project = projectsById.get(projectId);
      if (project === undefined || !isPublicProject(project)) {
        collector.add(
          "CONTENT_WRITING_PROJECT_UNPUBLISHED",
          article.sourcePath,
          "classification.project",
          "公开文章不能归入未公开项目。",
        );
      }
    }
  }
  if (collector.hasIssues()) return failure(collector);

  const displayIndexes = createArticleDisplayIndexes(input);
  const groups: WritingNavigationGroup[] = [];
  const general = publicArticles
    .filter((article) => article.classification.project === undefined)
    .sort(comparePublicArticles)
    .flatMap((article) => {
      const item = toPublicNavigationItem(article, displayIndexes, collector);
      return item === undefined ? [] : [item];
    });
  if (general.length > 0) {
    groups.push({kind: "general", label: "通用技术", articles: general});
  }

  const projectGroups: ProjectWritingGroup[] = [];
  for (const project of input.catalog.projects) {
    const projectArticles = publicArticles.filter(
      (article) => article.classification.project === project.id,
    );
    if (projectArticles.length === 0) continue;

    const rootArticles = projectArticles
      .filter((article) => article.classification.module === undefined)
      .sort(comparePublicArticles)
      .flatMap((article) => {
        const item = toPublicNavigationItem(article, displayIndexes, collector);
        return item === undefined ? [] : [item];
      });
    const modules: ModuleWritingGroup[] = project.writingModules
      .flatMap((module) => {
        const articles = projectArticles
          .filter((article) => article.classification.module === module.id)
          .sort(comparePublicArticles)
          .flatMap((article) => {
            const item = toPublicNavigationItem(article, displayIndexes, collector);
            return item === undefined ? [] : [item];
          });
        return articles.length === 0
          ? []
          : [{
              kind: "module" as const,
              moduleId: module.id,
              label: module.displayName,
              navigationOrder: module.navigationOrder,
              articles,
            }];
      })
      .sort((left, right) => (
        left.navigationOrder - right.navigationOrder
        || compareCodePoints(left.moduleId, right.moduleId)
      ));
    projectGroups.push({
      kind: "project",
      projectId: project.id,
      label: project.title,
      navigationOrder: project.navigationOrder,
      rootArticles,
      modules,
    });
  }
  projectGroups.sort((left, right) => (
    left.navigationOrder - right.navigationOrder
    || compareCodePoints(left.projectId, right.projectId)
  ));
  groups.push(...projectGroups);

  if (input.mode === "preview") {
    const drafts = input.articles
      .filter((article) => article.publicationStatus === "draft")
      .sort(compareDraftArticles)
      .flatMap((article) => {
        const item = toDraftNavigationItem(article, displayIndexes, collector);
        return item === undefined ? [] : [item];
      });
    if (drafts.length > 0) {
      groups.push({kind: "draft", label: "草稿", articles: drafts});
    }
  }

  if (collector.hasIssues()) return failure(collector);
  return success(groups);
}

export function buildArticleDateIndex(
  input: ArticleDateIndexInput,
): ValidationResult<readonly ArticleDateIndexEntry[]> {
  const collector = new IssueCollector();
  if (!isRecord(input) || !isValidatedArticleCollection(input.articles)) {
    addArticleCollectionIssue(collector);
    return failure(collector);
  }
  const entries = input.articles
    .filter(isPublicArticle)
    .sort((left, right) => compareCodePoints(left.articleId, right.articleId))
    .map((article) => ({
      articleId: article.articleId,
      slug: article.slug,
      publishedAt: article.publishedAt,
      updatedAt: article.updatedAt,
    }));
  return success(entries);
}

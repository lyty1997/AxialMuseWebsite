import {classifyContentPath} from "./content-path.js";
import type {
  Article,
  ArticleClassification,
  ArticleRecommendation,
  ArticleReferenceSource,
  ArticleRelations,
  ArticleRevision,
  ArticleSeo,
  ArticleSourceInput,
  ArticleValidationInput,
  ProjectCatalog,
  ValidationResult,
} from "./types.js";
import {
  compareCodePoints,
  exactObjectKeys,
  failure,
  isDate,
  isHttpsUrl,
  isIntegerInRange,
  isKebabId,
  isRecord,
  isRepositoryRelativePath,
  isSingleLineText,
  isUniqueStringArray,
  isUuidV7,
  IssueCollector,
  success,
} from "./validation.js";

const WRITING_ROOT = "site-content/writing";
const PROJECTS_PATH = "docs/contracts/projects.json";
const PUBLICATION_STATUSES = ["draft", "published", "archived"] as const;
const RECOMMENDATION_SURFACES = ["home", "writing"] as const;
const ARTICLE_FIELDS = [
  "articleId",
  "title",
  "slug",
  "summary",
  "publicationStatus",
  "authors",
  "publishedAt",
  "updatedAt",
  "classification",
  "relations",
  "seo",
  "recommendation",
  "revisions",
  "sources",
] as const;
const REQUIRED_ARTICLE_FIELDS = [
  "articleId",
  "title",
  "slug",
  "summary",
  "publicationStatus",
  "authors",
  "classification",
] as const;

type PublicationStatus = Article["publicationStatus"];

interface ArticleProbe {
  readonly sourcePath: string;
  readonly articleId?: string;
  readonly slug?: string;
  readonly relatedArticleIds: readonly string[];
  readonly recommendation?: ArticleRecommendation;
}

function addInvalidField(
  collector: IssueCollector,
  sourcePath: string,
  fieldPath: string,
  message: string,
): void {
  collector.add("CONTENT_ARTICLE_FIELD_INVALID", sourcePath, fieldPath, message);
}

function validateReferenceIds(
  value: unknown,
  minimum: number,
  maximum: number,
  sourcePath: string,
  fieldPath: string,
  collector: IssueCollector,
): string[] {
  if (!isUniqueStringArray(value, minimum, maximum, isKebabId)) {
    addInvalidField(
      collector,
      sourcePath,
      fieldPath,
      `字段必须是 ${minimum}-${maximum} 个不重复 lowercase kebab-case ID。`,
    );
    return [];
  }
  return [...value];
}

function validateAuthors(
  value: unknown,
  catalog: ProjectCatalog,
  sourcePath: string,
  collector: IssueCollector,
): string[] {
  const authors = validateReferenceIds(value, 1, 4, sourcePath, "authors", collector);
  const knownAuthors = new Set(catalog.authors.map((author) => author.id));
  for (const [index, authorId] of authors.entries()) {
    if (!knownAuthors.has(authorId)) {
      collector.add(
        "CONTENT_ARTICLE_AUTHOR_UNKNOWN",
        sourcePath,
        `authors.${index}`,
        "文章引用了未登记作者。",
      );
    }
  }
  return authors;
}

function validateClassification(
  value: unknown,
  catalog: ProjectCatalog,
  sourcePath: string,
  collector: IssueCollector,
): ArticleClassification | undefined {
  if (!isRecord(value)) {
    addInvalidField(collector, sourcePath, "classification", "classification 必须是 object。");
    return undefined;
  }
  exactObjectKeys(
    value,
    ["project", "module", "topics"],
    ["topics"],
    collector,
    sourcePath,
    "classification",
    "ARTICLE",
  );

  const hasProjectField = Object.hasOwn(value, "project");
  let project: string | undefined;
  if (hasProjectField) {
    if (!isKebabId(value.project)) {
      addInvalidField(collector, sourcePath, "classification.project", "主项目 ID 非法。");
    } else if (!catalog.projects.some((entry) => entry.id === value.project)) {
      collector.add(
        "CONTENT_ARTICLE_PROJECT_UNKNOWN",
        sourcePath,
        "classification.project",
        "文章引用了未登记主项目。",
      );
    } else {
      project = value.project;
    }
  }

  let module: string | undefined;
  if (Object.hasOwn(value, "module")) {
    if (!isKebabId(value.module)) {
      addInvalidField(collector, sourcePath, "classification.module", "写作模块 ID 非法。");
    } else if (!hasProjectField) {
      collector.add(
        "CONTENT_ARTICLE_MODULE_WITHOUT_PROJECT",
        sourcePath,
        "classification.module",
        "写作模块不能脱离主项目。",
      );
    } else if (project === undefined) {
      collector.add(
        "CONTENT_ARTICLE_MODULE_PROJECT_INVALID",
        sourcePath,
        "classification.module",
        "写作模块无法绑定到非法主项目引用。",
      );
    } else {
      const owner = catalog.projects.find((entry) => entry.id === project);
      if (!owner?.writingModules.some((entry) => entry.id === value.module)) {
        collector.add(
          "CONTENT_ARTICLE_MODULE_UNKNOWN",
          sourcePath,
          "classification.module",
          "写作模块不属于所选主项目。",
        );
      } else {
        module = value.module;
      }
    }
  }

  const topics = validateReferenceIds(
    value.topics,
    1,
    5,
    sourcePath,
    "classification.topics",
    collector,
  );
  const knownTopics = new Set(catalog.topics.map((topic) => topic.id));
  for (const [index, topicId] of topics.entries()) {
    if (!knownTopics.has(topicId)) {
      collector.add(
        "CONTENT_ARTICLE_TOPIC_UNKNOWN",
        sourcePath,
        `classification.topics.${index}`,
        "文章引用了未登记主题。",
      );
    }
  }

  if (topics.length === 0) return undefined;
  return {
    ...(project === undefined ? {} : {project}),
    ...(module === undefined ? {} : {module}),
    topics,
  };
}

function validateRelations(
  value: unknown,
  articleId: unknown,
  classification: ArticleClassification | undefined,
  catalog: ProjectCatalog,
  sourcePath: string,
  collector: IssueCollector,
): ArticleRelations | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    addInvalidField(collector, sourcePath, "relations", "relations 必须是非空 object。");
    return undefined;
  }
  exactObjectKeys(
    value,
    ["projects", "articles"],
    [],
    collector,
    sourcePath,
    "relations",
    "ARTICLE",
  );

  let projects: string[] | undefined;
  if (Object.hasOwn(value, "projects")) {
    const validated = validateReferenceIds(
      value.projects,
      1,
      5,
      sourcePath,
      "relations.projects",
      collector,
    );
    const knownProjects = new Set(catalog.projects.map((project) => project.id));
    for (const [index, projectId] of validated.entries()) {
      if (!knownProjects.has(projectId)) {
        collector.add(
          "CONTENT_ARTICLE_RELATED_PROJECT_UNKNOWN",
          sourcePath,
          `relations.projects.${index}`,
          "文章引用了未登记相关项目。",
        );
      }
      if (projectId === classification?.project) {
        collector.add(
          "CONTENT_ARTICLE_RELATED_PROJECT_MAIN",
          sourcePath,
          `relations.projects.${index}`,
          "相关项目不得重复主项目。",
        );
      }
    }
    projects = validated;
  }

  let articles: string[] | undefined;
  if (Object.hasOwn(value, "articles")) {
    if (!isUniqueStringArray(value.articles, 1, 10, isUuidV7)) {
      addInvalidField(
        collector,
        sourcePath,
        "relations.articles",
        "相关文章必须是 1-10 个不重复 UUIDv7。",
      );
    } else {
      articles = [...value.articles];
      for (const [index, relatedId] of articles.entries()) {
        if (relatedId === articleId) {
          collector.add(
            "CONTENT_ARTICLE_RELATION_SELF",
            sourcePath,
            `relations.articles.${index}`,
            "文章不得引用自身。",
          );
        }
      }
    }
  }

  if ((projects?.length ?? 0) + (articles?.length ?? 0) === 0) {
    addInvalidField(collector, sourcePath, "relations", "空关系对象或空关系数组必须省略。");
    return undefined;
  }
  return {
    ...(projects === undefined ? {} : {projects}),
    ...(articles === undefined ? {} : {articles}),
  };
}

function validateSeo(
  value: unknown,
  summary: unknown,
  sourcePath: string,
  collector: IssueCollector,
): ArticleSeo | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    addInvalidField(collector, sourcePath, "seo", "seo 必须是非空 object。");
    return undefined;
  }
  exactObjectKeys(
    value,
    ["description", "socialDescription"],
    [],
    collector,
    sourcePath,
    "seo",
    "ARTICLE",
  );
  const hasDescription = Object.hasOwn(value, "description");
  const hasSocialDescription = Object.hasOwn(value, "socialDescription");
  if (!hasDescription && !hasSocialDescription) {
    addInvalidField(collector, sourcePath, "seo", "空 SEO 覆盖对象必须省略。");
    return undefined;
  }

  let description: string | undefined;
  if (hasDescription) {
    if (!isSingleLineText(value.description, 20, 200)) {
      addInvalidField(collector, sourcePath, "seo.description", "搜索摘要覆盖不符合纯文本或长度约束。");
    } else if (value.description === summary) {
      collector.add(
        "CONTENT_ARTICLE_SEO_REDUNDANT",
        sourcePath,
        "seo.description",
        "搜索摘要覆盖不得复制默认摘要。",
      );
    } else {
      description = value.description;
    }
  }

  let socialDescription: string | undefined;
  if (hasSocialDescription) {
    if (!isSingleLineText(value.socialDescription, 20, 300)) {
      addInvalidField(collector, sourcePath, "seo.socialDescription", "分享摘要覆盖不符合纯文本或长度约束。");
    } else if (value.socialDescription === (description ?? summary)) {
      collector.add(
        "CONTENT_ARTICLE_SEO_REDUNDANT",
        sourcePath,
        "seo.socialDescription",
        "分享摘要覆盖不得复制实际回退值。",
      );
    } else {
      socialDescription = value.socialDescription;
    }
  }
  return {
    ...(description === undefined ? {} : {description}),
    ...(socialDescription === undefined ? {} : {socialDescription}),
  };
}

function validateRecommendation(
  value: unknown,
  sourcePath: string,
  collector: IssueCollector,
): ArticleRecommendation | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    addInvalidField(collector, sourcePath, "recommendation", "recommendation 必须是 object。");
    return undefined;
  }
  exactObjectKeys(
    value,
    ["surfaces", "priority"],
    ["surfaces", "priority"],
    collector,
    sourcePath,
    "recommendation",
    "ARTICLE",
  );
  const surfaces = Array.isArray(value.surfaces)
    && value.surfaces.length >= 1
    && value.surfaces.length <= 2
    && value.surfaces.every((surface) => RECOMMENDATION_SURFACES.includes(surface as typeof RECOMMENDATION_SURFACES[number]))
    && new Set(value.surfaces).size === value.surfaces.length
      ? value.surfaces as Array<typeof RECOMMENDATION_SURFACES[number]>
      : undefined;
  if (surfaces === undefined) {
    addInvalidField(collector, sourcePath, "recommendation.surfaces", "推荐位置必须是 1-2 个不重复允许枚举。");
  }
  if (!isIntegerInRange(value.priority, 1, 100)) {
    addInvalidField(collector, sourcePath, "recommendation.priority", "推荐顺序必须是 1-100 的整数。");
  }
  return surfaces !== undefined && isIntegerInRange(value.priority, 1, 100)
    ? {surfaces: [...surfaces], priority: value.priority}
    : undefined;
}

function validateRevisions(
  value: unknown,
  publicationStatus: unknown,
  publishedAt: unknown,
  updatedAt: unknown,
  sourcePath: string,
  collector: IssueCollector,
): ArticleRevision[] | undefined {
  if (value === undefined) return undefined;
  if (publicationStatus === "draft") {
    collector.add(
      "CONTENT_ARTICLE_DATE_STATE",
      sourcePath,
      "revisions",
      "草稿不得登记面向读者的发布后修订记录。",
    );
  }
  if (!Array.isArray(value) || value.length === 0) {
    addInvalidField(collector, sourcePath, "revisions", "revisions 必须是非空数组。");
    return undefined;
  }
  const revisions: ArticleRevision[] = [];
  let previousDate: string | undefined;
  for (const [index, raw] of value.entries()) {
    const field = `revisions.${index}`;
    if (!isRecord(raw)) {
      addInvalidField(collector, sourcePath, field, "修订记录必须是 object。");
      continue;
    }
    exactObjectKeys(raw, ["date", "summary"], ["date", "summary"], collector, sourcePath, field, "ARTICLE");
    if (!isDate(raw.date)) {
      collector.add("CONTENT_ARTICLE_DATE_INVALID", sourcePath, `${field}.date`, "修订日期非法。");
    }
    if (!isSingleLineText(raw.summary, 10, 200)) {
      addInvalidField(collector, sourcePath, `${field}.summary`, "修订摘要不符合纯文本或长度约束。");
    }
    if (isDate(raw.date)) {
      if (previousDate !== undefined && raw.date <= previousDate) {
        collector.add("CONTENT_ARTICLE_REVISION_ORDER", sourcePath, `${field}.date`, "修订日期必须严格升序。");
      }
      if (isDate(publishedAt) && raw.date < publishedAt) {
        collector.add("CONTENT_ARTICLE_REVISION_RANGE", sourcePath, `${field}.date`, "修订日期早于首次发布日期。");
      }
      if (isDate(updatedAt) && raw.date > updatedAt) {
        collector.add("CONTENT_ARTICLE_REVISION_RANGE", sourcePath, `${field}.date`, "修订日期晚于最近更新日期。");
      }
      previousDate = raw.date;
    }
    if (isDate(raw.date) && isSingleLineText(raw.summary, 10, 200)) {
      revisions.push({date: raw.date, summary: raw.summary});
    }
  }
  return revisions;
}

function validateSources(
  value: unknown,
  sourcePath: string,
  collector: IssueCollector,
): ArticleReferenceSource[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    addInvalidField(collector, sourcePath, "sources", "sources 必须是非空数组。");
    return undefined;
  }
  const sources: ArticleReferenceSource[] = [];
  for (const [index, raw] of value.entries()) {
    const field = `sources.${index}`;
    if (!isRecord(raw)) {
      addInvalidField(collector, sourcePath, field, "来源记录必须是 object。");
      continue;
    }
    exactObjectKeys(raw, ["title", "href", "accessedAt"], ["title", "href"], collector, sourcePath, field, "ARTICLE");
    const isExternal = isHttpsUrl(raw.href);
    const isRelative = isRepositoryRelativePath(raw.href);
    if (!isSingleLineText(raw.title, 1, 120)) {
      addInvalidField(collector, sourcePath, `${field}.title`, "来源标题不符合纯文本或长度约束。");
    }
    if (!isExternal && !isRelative) {
      addInvalidField(collector, sourcePath, `${field}.href`, "来源地址必须是 HTTPS 或安全仓库相对路径。");
    }
    if (isExternal && !Object.hasOwn(raw, "accessedAt")) {
      collector.add("CONTENT_ARTICLE_SOURCE_DATE_REQUIRED", sourcePath, `${field}.accessedAt`, "外部来源必须登记访问日期。");
    }
    if (Object.hasOwn(raw, "accessedAt") && !isDate(raw.accessedAt)) {
      collector.add("CONTENT_ARTICLE_DATE_INVALID", sourcePath, `${field}.accessedAt`, "来源访问日期非法。");
    }
    if (
      isSingleLineText(raw.title, 1, 120)
      && (isExternal || isRelative)
      && (!Object.hasOwn(raw, "accessedAt") || isDate(raw.accessedAt))
      && (!isExternal || Object.hasOwn(raw, "accessedAt"))
    ) {
      sources.push({
        title: raw.title,
        href: raw.href as string,
        ...(typeof raw.accessedAt === "string" ? {accessedAt: raw.accessedAt} : {}),
      });
    }
  }
  return sources;
}

function validateDates(
  raw: Record<string, unknown>,
  sourcePath: string,
  collector: IssueCollector,
): void {
  const status = raw.publicationStatus;
  const hasPublishedAt = Object.hasOwn(raw, "publishedAt");
  const hasUpdatedAt = Object.hasOwn(raw, "updatedAt");
  if (hasPublishedAt && !isDate(raw.publishedAt)) {
    collector.add("CONTENT_ARTICLE_DATE_INVALID", sourcePath, "publishedAt", "首次发布日期非法。");
  }
  if (hasUpdatedAt && !isDate(raw.updatedAt)) {
    collector.add("CONTENT_ARTICLE_DATE_INVALID", sourcePath, "updatedAt", "最近更新日期非法。");
  }
  if (status === "draft") {
    if (hasPublishedAt) {
      collector.add("CONTENT_ARTICLE_DATE_STATE", sourcePath, "publishedAt", "草稿不得登记首次发布日期。");
    }
    return;
  }
  if (status !== "published" && status !== "archived") return;
  if (!hasPublishedAt) {
    collector.add("CONTENT_ARTICLE_DATE_REQUIRED", sourcePath, "publishedAt", "公开文章必须登记首次发布日期。");
  }
  if (!hasUpdatedAt) {
    collector.add("CONTENT_ARTICLE_DATE_REQUIRED", sourcePath, "updatedAt", "公开文章必须登记最近更新日期。");
  }
  if (isDate(raw.publishedAt) && isDate(raw.updatedAt) && raw.updatedAt < raw.publishedAt) {
    collector.add("CONTENT_ARTICLE_DATE_ORDER", sourcePath, "updatedAt", "最近更新日期早于首次发布日期。");
  }
}

function buildArticleProbe(
  frontMatter: unknown,
  sourcePath: string,
): ArticleProbe {
  if (!isRecord(frontMatter)) return {sourcePath, relatedArticleIds: []};
  const articleId = isUuidV7(frontMatter.articleId)
    ? frontMatter.articleId
    : undefined;
  const slug = typeof frontMatter.slug === "string"
    && /^\/writing\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(frontMatter.slug)
      ? frontMatter.slug
      : undefined;
  const relatedArticleIds = isRecord(frontMatter.relations)
    && isUniqueStringArray(frontMatter.relations.articles, 1, 10, isUuidV7)
      ? [...frontMatter.relations.articles]
      : [];
  const recommendation = isRecord(frontMatter.recommendation)
    && Array.isArray(frontMatter.recommendation.surfaces)
    && frontMatter.recommendation.surfaces.length >= 1
    && frontMatter.recommendation.surfaces.length <= 2
    && frontMatter.recommendation.surfaces.every((surface) => (
      RECOMMENDATION_SURFACES.includes(surface as typeof RECOMMENDATION_SURFACES[number])
    ))
    && new Set(frontMatter.recommendation.surfaces).size === frontMatter.recommendation.surfaces.length
    && isIntegerInRange(frontMatter.recommendation.priority, 1, 100)
      ? {
          surfaces: [...frontMatter.recommendation.surfaces] as Array<typeof RECOMMENDATION_SURFACES[number]>,
          priority: frontMatter.recommendation.priority,
        }
      : undefined;
  return {
    sourcePath,
    ...(articleId === undefined ? {} : {articleId}),
    ...(slug === undefined ? {} : {slug}),
    relatedArticleIds,
    ...(recommendation === undefined ? {} : {recommendation}),
  };
}

function validateArticle(
  source: ArticleValidationInput["sources"][number],
  sourceName: string,
  catalog: ProjectCatalog,
  sourcePath: string,
  collector: IssueCollector,
): Article | undefined {
  if (!isRecord(source.frontMatter)) {
    collector.add("CONTENT_ARTICLE_FRONTMATTER_INVALID", sourcePath, undefined, "文章 frontmatter 必须解码为 object。");
    return undefined;
  }
  const raw = source.frontMatter;
  exactObjectKeys(raw, ARTICLE_FIELDS, REQUIRED_ARTICLE_FIELDS, collector, sourcePath, "", "ARTICLE");
  if (!isUuidV7(raw.articleId)) addInvalidField(collector, sourcePath, "articleId", "articleId 必须是规范 UUIDv7。");
  if (!isSingleLineText(raw.title, 1, 100)) addInvalidField(collector, sourcePath, "title", "文章标题不符合纯文本或长度约束。");
  if (typeof raw.slug !== "string" || !/^\/writing\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(raw.slug)) {
    addInvalidField(collector, sourcePath, "slug", "文章 slug 必须是无尾斜杠的 /writing/<lowercase-kebab-case>。");
  }
  if (!isSingleLineText(raw.summary, 20, 200)) addInvalidField(collector, sourcePath, "summary", "文章摘要不符合纯文本或长度约束。");
  if (!PUBLICATION_STATUSES.includes(raw.publicationStatus as PublicationStatus)) {
    collector.add("CONTENT_ARTICLE_STATE_INVALID", sourcePath, "publicationStatus", "文章发布状态不属于允许枚举。");
  }
  const authors = validateAuthors(raw.authors, catalog, sourcePath, collector);
  const classification = validateClassification(raw.classification, catalog, sourcePath, collector);
  validateDates(raw, sourcePath, collector);
  const relations = validateRelations(raw.relations, raw.articleId, classification, catalog, sourcePath, collector);
  const seo = validateSeo(raw.seo, raw.summary, sourcePath, collector);
  const recommendation = validateRecommendation(raw.recommendation, sourcePath, collector);
  const revisions = validateRevisions(raw.revisions, raw.publicationStatus, raw.publishedAt, raw.updatedAt, sourcePath, collector);
  const sources = validateSources(raw.sources, sourcePath, collector);
  if (typeof source.content !== "string" || source.content.trim() === "") {
    collector.add("CONTENT_ARTICLE_BODY_INVALID", sourcePath, undefined, "文章正文不得为空。");
  }

  if (collector.hasIssues()) return undefined;
  return {
    sourcePath,
    sourceName,
    articleId: raw.articleId as string,
    title: raw.title as string,
    slug: raw.slug as string,
    summary: raw.summary as string,
    publicationStatus: raw.publicationStatus as PublicationStatus,
    authors,
    ...(typeof raw.publishedAt === "string" ? {publishedAt: raw.publishedAt} : {}),
    ...(typeof raw.updatedAt === "string" ? {updatedAt: raw.updatedAt} : {}),
    classification: classification as ArticleClassification,
    ...(relations === undefined ? {} : {relations}),
    ...(seo === undefined ? {} : {seo}),
    ...(recommendation === undefined ? {} : {recommendation}),
    ...(revisions === undefined ? {} : {revisions}),
    ...(sources === undefined ? {} : {sources}),
    content: source.content,
  };
}

function addDuplicateIssues(
  probes: readonly ArticleProbe[],
  key: "articleId" | "slug",
  code: string,
  collector: IssueCollector,
): void {
  const groups = new Map<string, ArticleProbe[]>();
  for (const probe of probes) {
    const value = probe[key];
    if (value === undefined) continue;
    const group = groups.get(value) ?? [];
    group.push(probe);
    groups.set(value, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const probe of group) {
      collector.add(code, probe.sourcePath, key, `${key} 在当前文章集合中重复。`);
    }
  }
}

function validateArticleRelations(
  probes: readonly ArticleProbe[],
  collector: IssueCollector,
): void {
  const articleIds = new Set(
    probes.flatMap((probe) => probe.articleId === undefined ? [] : [probe.articleId]),
  );
  for (const probe of probes) {
    for (const [index, relatedId] of probe.relatedArticleIds.entries()) {
      if (!articleIds.has(relatedId)) {
        collector.add(
          "CONTENT_ARTICLE_RELATION_UNKNOWN",
          probe.sourcePath,
          `relations.articles.${index}`,
          "文章引用了当前集合中不存在的相关文章。",
        );
      }
    }
  }
}

function validateProjectWritingReferences(
  catalog: ProjectCatalog,
  probes: readonly ArticleProbe[],
  collector: IssueCollector,
): void {
  const articleIds = new Set(
    probes.flatMap((probe) => probe.articleId === undefined ? [] : [probe.articleId]),
  );
  for (const project of catalog.projects) {
    for (const [articleIndex, articleId] of project.relatedWriting.entries()) {
      if (!articleIds.has(articleId)) {
        collector.add(
          "CONTENT_PROJECT_WRITING_UNKNOWN",
          PROJECTS_PATH,
          `projectsById.${project.id}.relatedWriting.${articleIndex}`,
          "项目引用了当前文章集合中不存在的 articleId。",
        );
      }
    }
  }
}

function validateRecommendationConflicts(
  probes: readonly ArticleProbe[],
  collector: IssueCollector,
): void {
  const groups = new Map<string, ArticleProbe[]>();
  for (const probe of probes) {
    if (probe.recommendation === undefined) continue;
    for (const surface of probe.recommendation.surfaces) {
      const identity = `${surface}\u0000${probe.recommendation.priority}`;
      const group = groups.get(identity) ?? [];
      group.push(probe);
      groups.set(identity, group);
    }
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const probe of group) {
      collector.add(
        "CONTENT_ARTICLE_RECOMMENDATION_CONFLICT",
        probe.sourcePath,
        "recommendation.priority",
        "同一推荐位置存在重复 priority。",
      );
    }
  }
}

function hasCatalogShape(value: unknown): value is ProjectCatalog {
  return isRecord(value)
    && Array.isArray(value.projects)
    && value.projects.every((project) => (
      isRecord(project)
      && typeof project.id === "string"
      && Array.isArray(project.relatedWriting)
      && project.relatedWriting.every((articleId) => typeof articleId === "string")
      && Array.isArray(project.writingModules)
      && project.writingModules.every((module) => isRecord(module) && typeof module.id === "string")
    ))
    && Array.isArray(value.authors)
    && value.authors.every((author) => isRecord(author) && typeof author.id === "string")
    && Array.isArray(value.topics)
    && value.topics.every((topic) => isRecord(topic) && typeof topic.id === "string")
    && Array.isArray(value.experiences)
    && Array.isArray(value.projectSources);
}

function isArticleSourceInput(value: unknown): value is ArticleSourceInput {
  return isRecord(value)
    && typeof value.sourcePath === "string"
    && typeof value.isSymbolicLink === "boolean"
    && typeof value.isRealPathWithinRoot === "boolean"
    && Object.hasOwn(value, "frontMatter")
    && typeof value.content === "string";
}

export function validateArticleSource(
  input: ArticleValidationInput,
): ValidationResult<readonly Article[]> {
  const collector = new IssueCollector();
  if (!isRecord(input) || !hasCatalogShape(input.catalog)) {
    collector.add("CONTENT_ARTICLE_CATALOG_INVALID", WRITING_ROOT, undefined, "文章校验需要完整且已验证的项目目录。");
    return failure(collector);
  }
  if (!Array.isArray(input.sources)) {
    collector.add("CONTENT_ARTICLE_SOURCE_INVALID", WRITING_ROOT, undefined, "文章候选必须是数组。");
    return failure(collector);
  }

  const articles: Article[] = [];
  const probes: ArticleProbe[] = [];
  const pathsBySourceName = new Map<string, string[]>();
  for (const source of input.sources) {
    if (!isArticleSourceInput(source)) {
      collector.add("CONTENT_ARTICLE_SOURCE_INVALID", WRITING_ROOT, undefined, "文章候选必须是 object。");
      continue;
    }
    const classification = classifyContentPath(source);
    if (!classification.ok) {
      collector.merge(classification.issues);
      continue;
    }
    if (classification.value.kind !== "article") {
      collector.add("CONTENT_ARTICLE_PATH_LAYOUT", classification.value.sourcePath, undefined, "文章候选不是合法文章入口。");
      continue;
    }
    const paths = pathsBySourceName.get(classification.value.sourceName) ?? [];
    paths.push(classification.value.sourcePath);
    pathsBySourceName.set(classification.value.sourceName, paths);
    probes.push(buildArticleProbe(source.frontMatter, classification.value.sourcePath));

    const sourceCollector = new IssueCollector();
    const article = validateArticle(
      source,
      classification.value.sourceName,
      input.catalog,
      classification.value.sourcePath,
      sourceCollector,
    );
    collector.merge(sourceCollector.sorted());
    if (article !== undefined) articles.push(article);
  }

  for (const paths of pathsBySourceName.values()) {
    if (paths.length < 2) continue;
    for (const sourcePath of paths) {
      collector.add("CONTENT_ARTICLE_SOURCE_DUPLICATE", sourcePath, undefined, "同一 source-name 同时存在多个文章入口。");
    }
  }
  addDuplicateIssues(probes, "articleId", "CONTENT_ARTICLE_ID_DUPLICATE", collector);
  addDuplicateIssues(probes, "slug", "CONTENT_ARTICLE_SLUG_DUPLICATE", collector);
  validateArticleRelations(probes, collector);
  validateProjectWritingReferences(input.catalog, probes, collector);
  validateRecommendationConflicts(probes, collector);

  if (collector.hasIssues()) return failure(collector);
  return success([...articles].sort((left, right) => compareCodePoints(left.articleId, right.articleId)));
}

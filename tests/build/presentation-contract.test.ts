import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSeoMetadata,
} from "../../src/components/SeoMetadata/contract.js";
import {
  findSiteContentDetail,
  readSiteContentData,
  siteArticles,
} from "../../src/components/SiteContentData/contract.js";

const CANONICAL_ORIGIN = "https://www.axialmuse.com";

const PROJECT = Object.freeze({
  projectId: "published-project",
  sourcePath: "site-content/projects/published-project/index.md",
  title: "Published Project",
  summary: "A verified project summary.",
  canonicalPath: "/projects/published-project/",
  navigationOrder: 10,
  status: "active",
  publicationStatus: "published",
  updatedAt: "2026-07-20",
  repositoryUrl: "https://github.com/example/published-project",
  relatedWriting: Object.freeze([Object.freeze({
    title: "Published Article",
    canonicalPath: "/writing/published-article/",
  })]),
  previewImage: Object.freeze({
    publicUrl: "/assets/projects/published-project/overview.webp",
    width: 1600,
    height: 1000,
    alt: "Published project interface",
  }),
});

const ARTICLE = Object.freeze({
  articleId: "018f0000-0000-7000-8000-000000000001",
  sourcePath: "site-content/writing/published-article/index.md",
  title: "Published Article",
  summary: "A verified article summary.",
  canonicalPath: "/writing/published-article/",
  publicationStatus: "published",
  publishedAt: "2026-07-10",
  updatedAt: "2026-07-20",
  authors: Object.freeze([
    Object.freeze({id: "example-author", displayName: "示例作者"}),
  ]),
  topics: Object.freeze([
    Object.freeze({id: "architecture", displayName: "架构"}),
  ]),
  seo: Object.freeze({
    description: "A search description.",
    socialDescription: "A social description.",
  }),
  relatedProjects: Object.freeze([Object.freeze({
    title: "Published Project",
    canonicalPath: "/projects/published-project/",
  })]),
  relatedArticles: Object.freeze([]),
});

function contentInput(): Record<string, unknown> {
  return structuredClone({
    projectNavigation: [PROJECT],
    writingNavigation: [{
      kind: "general",
      label: "通用技术",
      articles: [ARTICLE],
    }],
  });
}

test("CODE-007 SEO 合并固定规范 URL，并只从安全站内图片生成 og:image", () => {
  assert.deepEqual(
    resolveSeoMetadata({
      origin: CANONICAL_ORIGIN,
      title: "项目 | Axial Muse",
      description: "搜索描述",
      socialDescription: "分享描述",
      canonicalPath: "/projects/",
      type: "website",
    }),
    {
      title: "项目 | Axial Muse",
      description: "搜索描述",
      socialDescription: "分享描述",
      canonicalPath: "/projects/",
      type: "website",
      canonicalUrl: `${CANONICAL_ORIGIN}/projects/`,
    },
  );
  assert.deepEqual(
    resolveSeoMetadata({
      origin: CANONICAL_ORIGIN,
      title: "Published Project | Axial Muse",
      description: "搜索描述",
      socialDescription: "分享描述",
      canonicalPath: "/projects/published-project/",
      type: "website",
      imagePath: "/assets/projects/published-project/overview.webp",
    }),
    {
      title: "Published Project | Axial Muse",
      description: "搜索描述",
      socialDescription: "分享描述",
      canonicalPath: "/projects/published-project/",
      type: "website",
      imagePath: "/assets/projects/published-project/overview.webp",
      canonicalUrl: `${CANONICAL_ORIGIN}/projects/published-project/`,
      imageUrl: `${CANONICAL_ORIGIN}/assets/projects/published-project/overview.webp`,
    },
  );
});

test("CODE-007 SEO 合并拒绝空文本、无尾斜杠路由与外部或占位图片", () => {
  const base = {
    origin: CANONICAL_ORIGIN,
    title: "项目 | Axial Muse",
    description: "搜索描述",
    socialDescription: "分享描述",
    canonicalPath: "/projects/",
    type: "website" as const,
  };
  for (const input of [
    {...base, title: ""},
    {...base, description: " 搜索描述"},
    {...base, canonicalPath: "/projects"},
    {...base, canonicalPath: "https://wrong.example/projects/"},
    {...base, origin: "http://www.axialmuse.com"},
    {...base, origin: "https://www.axialmuse.com/extra"},
    {...base, imagePath: "https://wrong.example/preview.webp"},
    {...base, imagePath: "/assets/../private.webp"},
    {...base, imagePath: "/assets/placeholder.webp?pending=true"},
  ]) {
    assert.throws(() => resolveSeoMetadata(input), /\[SEO_METADATA_INVALID\]/u);
  }
});

test("CODE-007 安全 global data 只提供列表与当前详情所需显示字段", () => {
  const data = readSiteContentData(contentInput());
  assert.equal(data.projectNavigation.length, 1);
  assert.equal(siteArticles(data).length, 1);
  assert.deepEqual(data.projectNavigation[0]?.relatedWriting, [
    {
      title: ARTICLE.title,
      canonicalPath: ARTICLE.canonicalPath,
    },
  ]);
  assert.deepEqual(siteArticles(data)[0]?.relatedProjects, [
    {
      title: PROJECT.title,
      canonicalPath: PROJECT.canonicalPath,
    },
  ]);
  assert.deepEqual(
    findSiteContentDetail(data, "/projects/published-project"),
    {kind: "project", item: data.projectNavigation[0]},
  );
  assert.deepEqual(
    findSiteContentDetail(data, "/writing/published-article/"),
    {kind: "article", item: siteArticles(data)[0]},
  );
  assert.throws(
    () => findSiteContentDetail(data, "/projects/unknown/"),
    /\[SITE_CONTENT_ROUTE_UNKNOWN\]/u,
  );
});

test("CODE-007 安全 global data 对畸形字段、非规范路由与跨类型重复路由失败关闭", () => {
  const invalidStatus = contentInput();
  const project = (invalidStatus.projectNavigation as Array<Record<string, unknown>>)[0];
  assert.ok(project);
  project.publicationStatus = "private";
  assert.throws(
    () => readSiteContentData(invalidStatus),
    /\[SITE_CONTENT_DATA_INVALID\]/u,
  );

  const plannedPreview = contentInput();
  const plannedProject = (
    plannedPreview.projectNavigation as Array<Record<string, unknown>>
  )[0];
  assert.ok(plannedProject);
  plannedProject.publicationStatus = "planned";
  delete plannedProject.previewImage;
  assert.equal(
    readSiteContentData(plannedPreview).projectNavigation[0]?.publicationStatus,
    "planned",
  );

  const invalidImage = contentInput();
  const preview = (
    (invalidImage.projectNavigation as Array<Record<string, unknown>>)[0]
      ?.previewImage as Record<string, unknown>
  );
  preview.publicUrl = "https://wrong.example/overview.webp";
  assert.throws(
    () => readSiteContentData(invalidImage),
    /\[SITE_CONTENT_DATA_INVALID\]/u,
  );

  const unexpectedField = contentInput();
  unexpectedField.privateDateIndex = [{articleId: ARTICLE.articleId}];
  assert.throws(
    () => readSiteContentData(unexpectedField),
    /\[SITE_CONTENT_DATA_INVALID\]/u,
  );

  for (const canonicalPath of [
    "/projects/",
    "/projects/nested/detail/",
  ]) {
    const invalidProjectRoute = contentInput();
    const project = (
      invalidProjectRoute.projectNavigation as Array<Record<string, unknown>>
    )[0];
    assert.ok(project);
    project.canonicalPath = canonicalPath;
    assert.throws(
      () => readSiteContentData(invalidProjectRoute),
      /\[SITE_CONTENT_DATA_INVALID\]/u,
    );
  }

  for (const canonicalPath of [
    "/writing/",
    "/writing/nested/detail/",
  ]) {
    const invalidArticleRoute = contentInput();
    const article = (
      (invalidArticleRoute.writingNavigation as Array<Record<string, unknown>>)[0]
        ?.articles as Array<Record<string, unknown>>
    )[0];
    assert.ok(article);
    article.canonicalPath = canonicalPath;
    assert.throws(
      () => readSiteContentData(invalidArticleRoute),
      /\[SITE_CONTENT_DATA_INVALID\]/u,
    );
  }

  const duplicateRoute = contentInput();
  const article = (
    (duplicateRoute.writingNavigation as Array<Record<string, unknown>>)[0]
      ?.articles as Array<Record<string, unknown>>
  )[0];
  assert.ok(article);
  article.canonicalPath = PROJECT.canonicalPath;
  assert.throws(
    () => readSiteContentData(duplicateRoute),
    /\[SITE_CONTENT_DATA_INVALID\]/u,
  );
});

test("CODE-007 安全关联链接拒绝悬空、跨类型、标题漂移、重复、自身与原始 ID", () => {
  const relationCases = [
    (input: Record<string, unknown>) => {
      const project = (
        input.projectNavigation as Array<Record<string, unknown>>
      )[0];
      assert.ok(project);
      project.relatedWriting = [{
        title: ARTICLE.title,
        canonicalPath: "/writing/missing/",
      }];
    },
    (input: Record<string, unknown>) => {
      const project = (
        input.projectNavigation as Array<Record<string, unknown>>
      )[0];
      assert.ok(project);
      project.relatedWriting = [{
        title: PROJECT.title,
        canonicalPath: PROJECT.canonicalPath,
      }];
    },
    (input: Record<string, unknown>) => {
      const project = (
        input.projectNavigation as Array<Record<string, unknown>>
      )[0];
      assert.ok(project);
      project.relatedWriting = [{
        title: "错误标题",
        canonicalPath: ARTICLE.canonicalPath,
      }];
    },
    (input: Record<string, unknown>) => {
      const project = (
        input.projectNavigation as Array<Record<string, unknown>>
      )[0];
      assert.ok(project);
      project.relatedWriting = [
        {
          title: ARTICLE.title,
          canonicalPath: ARTICLE.canonicalPath,
        },
        {
          title: ARTICLE.title,
          canonicalPath: ARTICLE.canonicalPath,
        },
      ];
    },
    (input: Record<string, unknown>) => {
      const article = (
        (input.writingNavigation as Array<Record<string, unknown>>)[0]
          ?.articles as Array<Record<string, unknown>>
      )[0];
      assert.ok(article);
      article.relatedArticles = [{
        title: ARTICLE.title,
        canonicalPath: ARTICLE.canonicalPath,
      }];
    },
    (input: Record<string, unknown>) => {
      const article = (
        (input.writingNavigation as Array<Record<string, unknown>>)[0]
          ?.articles as Array<Record<string, unknown>>
      )[0];
      assert.ok(article);
      article.relatedProjects = [{
        articleId: ARTICLE.articleId,
        title: PROJECT.title,
        canonicalPath: PROJECT.canonicalPath,
      }];
    },
  ];
  for (const mutate of relationCases) {
    const input = contentInput();
    mutate(input);
    assert.throws(
      () => readSiteContentData(input),
      /\[SITE_CONTENT_DATA_INVALID\]/u,
    );
  }

  const publicToDraft = contentInput();
  const navigation = publicToDraft.writingNavigation as Array<Record<string, unknown>>;
  const publicArticle = (
    navigation[0]?.articles as Array<Record<string, unknown>>
  )[0];
  assert.ok(publicArticle);
  publicArticle.relatedArticles = [{
    title: "Draft Article",
    canonicalPath: "/writing/draft-article/",
  }];
  navigation.push({
    kind: "draft",
    label: "草稿",
    articles: [{
      ...structuredClone(ARTICLE),
      articleId: "018f0000-0000-7000-8000-000000000002",
      sourcePath: "site-content/writing/draft-article/index.md",
      title: "Draft Article",
      canonicalPath: "/writing/draft-article/",
      publicationStatus: "draft",
      publishedAt: undefined,
      relatedProjects: [],
      relatedArticles: [],
    }],
  });
  assert.throws(
    () => readSiteContentData(publicToDraft),
    /\[SITE_CONTENT_DATA_INVALID\]/u,
  );
});

test("CODE-007 安全关联链接分别执行项目、文章的数量上限", () => {
  const relatedArticles = Array.from({length: 11}, (_, offset) => {
    const index = offset + 1;
    const suffix = String(index).padStart(2, "0");
    return {
      ...structuredClone(ARTICLE),
      articleId: `018f0000-0000-7000-8000-${String(index + 10).padStart(12, "0")}`,
      sourcePath: `site-content/writing/related-${suffix}/index.md`,
      title: `Related Article ${suffix}`,
      canonicalPath: `/writing/related-${suffix}/`,
      relatedProjects: [],
      relatedArticles: [],
    };
  });
  const relatedArticleLinks = relatedArticles.map((article) => ({
    title: article.title,
    canonicalPath: article.canonicalPath,
  }));

  const projectTooMany = contentInput();
  const projectWritingGroup = (
    projectTooMany.writingNavigation as Array<Record<string, unknown>>
  )[0];
  const project = (
    projectTooMany.projectNavigation as Array<Record<string, unknown>>
  )[0];
  assert.ok(projectWritingGroup);
  assert.ok(project);
  (projectWritingGroup.articles as Array<Record<string, unknown>>)
    .push(...relatedArticles);
  project.relatedWriting = relatedArticleLinks;
  assert.throws(
    () => readSiteContentData(projectTooMany),
    /\[SITE_CONTENT_DATA_INVALID\]/u,
  );

  const articleTooMany = contentInput();
  const articleWritingGroup = (
    articleTooMany.writingNavigation as Array<Record<string, unknown>>
  )[0];
  assert.ok(articleWritingGroup);
  const article = (
    articleWritingGroup.articles as Array<Record<string, unknown>>
  )[0];
  assert.ok(article);
  (articleWritingGroup.articles as Array<Record<string, unknown>>)
    .push(...relatedArticles);
  article.relatedArticles = relatedArticleLinks;
  assert.throws(
    () => readSiteContentData(articleTooMany),
    /\[SITE_CONTENT_DATA_INVALID\]/u,
  );

  const relatedProjects = Array.from({length: 6}, (_, offset) => {
    const index = offset + 1;
    const suffix = String(index).padStart(2, "0");
    return {
      ...structuredClone(PROJECT),
      projectId: `related-project-${suffix}`,
      sourcePath: `site-content/projects/related-project-${suffix}/index.md`,
      title: `Related Project ${suffix}`,
      canonicalPath: `/projects/related-project-${suffix}/`,
      navigationOrder: 100 + index,
      relatedWriting: [],
    };
  });
  const relatedProjectLinks = relatedProjects.map((target) => ({
    title: target.title,
    canonicalPath: target.canonicalPath,
  }));
  const articleProjectsTooMany = contentInput();
  (articleProjectsTooMany.projectNavigation as Array<Record<string, unknown>>)
    .push(...relatedProjects);
  const publicWritingGroup = (
    articleProjectsTooMany.writingNavigation as Array<Record<string, unknown>>
  )[0];
  assert.ok(publicWritingGroup);
  const publicArticle = (
    publicWritingGroup.articles as Array<Record<string, unknown>>
  )[0];
  assert.ok(publicArticle);
  publicArticle.relatedProjects = relatedProjectLinks;
  assert.throws(
    () => readSiteContentData(articleProjectsTooMany),
    /\[SITE_CONTENT_DATA_INVALID\]/u,
  );
});

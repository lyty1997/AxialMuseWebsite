import assert from "node:assert/strict";
import test from "node:test";
import {
  validateArticleSource,
  validateProjectCatalog,
} from "../../src/domain/content/index.js";
import type {
  Article,
  ArticleSourceInput,
  ProjectCatalog,
  ProjectCatalogInput,
  ValidationResult,
} from "../../src/domain/content/index.js";

const ARTICLE_A_ID = "018f0000-0000-7000-8000-000000000001";
const ARTICLE_B_ID = "018f0000-0000-7000-8000-000000000002";
const ARTICLE_C_ID = "018f0000-0000-7000-8000-000000000003";

function makeCatalog(
  relatedWriting: readonly string[] = [],
  publicationStatuses: readonly ["planned" | "published", "planned" | "published"] = [
    "planned",
    "planned",
  ],
): ProjectCatalog {
  const projects = [
    {
      id: "project-one",
      title: "Project One",
      slug: "project-one",
      navigationOrder: 10,
      summary: "这是一个用于验证文章领域关系的完整项目摘要。",
      status: "active",
      publicationStatus: publicationStatuses[0],
      startedAt: "2026-01",
      updatedAt: "2026-07-18",
      repositoryUrl: "https://example.test/project-one",
      productionBranch: "main",
      showcaseMode: "repository",
      ...(publicationStatuses[0] === "published" ? {
        previewImage: {
          sourcePath: "projects/project-one/overview.webp",
          width: 1600,
          height: 1000,
          alt: "Project One 可复核主预览",
        },
      } : {}),
      ...(relatedWriting.length === 0 ? {} : {relatedWriting}),
      writingModules: [
        {
          id: "module-one",
          displayName: "模块一",
          navigationOrder: 10,
          status: "active",
        },
      ],
      source: ["docs/projects/project-one.md"],
    },
    {
      id: "project-two",
      title: "Project Two",
      slug: "project-two",
      navigationOrder: 20,
      summary: "这是另一个用于验证跨项目关系的完整项目摘要。",
      status: "active",
      publicationStatus: publicationStatuses[1],
      startedAt: "2026-02",
      updatedAt: "2026-07-18",
      repositoryUrl: "https://example.test/project-two",
      productionBranch: "main",
      showcaseMode: "repository",
      ...(publicationStatuses[1] === "published" ? {
        previewImage: {
          sourcePath: "projects/project-two/overview.webp",
          width: 1600,
          height: 1000,
          alt: "Project Two 可复核主预览",
        },
      } : {}),
      writingModules: [],
      source: ["docs/projects/project-two.md"],
    },
  ];
  const input: ProjectCatalogInput = {
    projects: {
      sourcePath: "docs/contracts/projects.json",
      value: {
        version: "0.3.0",
        kind: "axial_muse_projects",
        status: "active",
        owner: "AxialMuseWebsite",
        lifecycleStatusValues: ["active", "paused", "completed", "archived"],
        publicationStatusValues: ["draft", "planned", "published", "archived"],
        showcaseModes: ["repository", "repository-and-video"],
        projects,
      },
    },
    authors: {
      sourcePath: "docs/contracts/authors.json",
      value: {
        version: "0.1.0",
        kind: "axial_muse_authors",
        status: "active",
        owner: "AxialMuseWebsite",
        authors: {"author-one": {displayName: "作者一"}},
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
          "topic-one": {
            displayName: "主题一",
            navigationOrder: 10,
            status: "active",
          },
          "topic-archived": {
            displayName: "旧主题",
            navigationOrder: 20,
            status: "archived",
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
        statusValues: ["planned", "provisioning", "live", "paused", "retired"],
        deliveryModes: ["static"],
        reservedSubdomains: [
          "www", "api", "admin", "auth", "account", "assets", "cdn", "dev",
          "docs", "mail", "preview", "staging", "static", "status", "support",
        ],
        experiences: [],
      },
    },
    projectSources: projects
      .filter((project) => project.publicationStatus === "published")
      .map((project) => ({
        sourcePath: `site-content/projects/${project.id}/index.md`,
        isSymbolicLink: false,
        isRealPathWithinRoot: true,
        frontMatter: {},
        content: "## 可复核说明\n\n项目正文提供稳定的文章关系验收证据。\n",
      })),
  };
  const result = validateProjectCatalog(input);
  if (!result.ok) {
    assert.fail(`项目目录 fixture 无效：${result.issues.map((issue) => issue.code).join(", ")}`);
  }
  return result.value;
}

function makeFrontMatter(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    articleId: ARTICLE_A_ID,
    title: "依赖倒置的工程实践",
    slug: "/writing/dependency-inversion",
    summary: "通过一个可复核的最小案例说明依赖倒置如何改善工程边界。",
    publicationStatus: "draft",
    authors: ["author-one"],
    classification: {topics: ["topic-one"]},
    ...overrides,
  };
}

function makeSource(
  sourceName: string,
  frontMatter: unknown = makeFrontMatter(),
  extension: ".md" | ".mdx" = ".md",
): ArticleSourceInput {
  return {
    sourcePath: `site-content/writing/${sourceName}/index${extension}`,
    isSymbolicLink: false,
    isRealPathWithinRoot: true,
    frontMatter,
    content: "## 问题\n\n正文内容。\n",
  };
}

function expectSuccess(result: ValidationResult<readonly Article[]>): readonly Article[] {
  if (!result.ok) {
    assert.fail(`预期成功，实际问题码：${result.issues.map((issue) => issue.code).join(", ")}`);
  }
  return result.value;
}

function expectFailure(
  result: ValidationResult<readonly Article[]>,
  expectedCodes: readonly string[],
): void {
  if (result.ok) assert.fail("预期整批失败，实际返回了领域值。");
  const codes = new Set(result.issues.map((issue) => issue.code));
  for (const code of expectedCodes) {
    assert.ok(codes.has(code), `缺少预期问题码 ${code}`);
  }
  assert.equal(Object.hasOwn(result, "value"), false);
}

test("I-06 通用草稿、项目文章与完整公开文章形成确定且深冻结的领域值", () => {
  const draft = makeSource("dependency-inversion");
  const published = makeSource(
    "module-boundaries",
    makeFrontMatter({
      articleId: ARTICLE_B_ID,
      title: "模块边界的确定性校验",
      slug: "/writing/module-boundaries",
      publicationStatus: "published",
      publishedAt: "2026-07-10",
      updatedAt: "2026-07-18",
      classification: {
        project: "project-one",
        module: "module-one",
        topics: ["topic-one", "topic-archived"],
      },
      relations: {projects: ["project-two"]},
      seo: {
        description: "以稳定错误与模块图证明工程边界能够自动执行并持续复核。",
        socialDescription: "一份面向分享场景的模块边界实践摘要，保留可追溯的验收证据。",
      },
      recommendation: {surfaces: ["home", "writing"], priority: 10},
      revisions: [
        {date: "2026-07-10", summary: "首次发布可复核的实现与测试。"},
        {date: "2026-07-18", summary: "补充确定性错误排序与边界说明。"},
      ],
      sources: [
        {
          title: "外部规范资料",
          href: "https://example.test/specification",
          accessedAt: "2026-07-18",
        },
        {title: "仓库设计文档", href: "docs/engineering/main-site-coding-spec.md"},
      ],
    }),
    ".mdx",
  );

  const first = validateArticleSource({
    catalog: makeCatalog([], ["published", "published"]),
    sources: [published, draft],
  });
  const second = validateArticleSource({
    catalog: makeCatalog([], ["published", "published"]),
    sources: [draft, published],
  });
  assert.deepEqual(first, second);
  const articles = expectSuccess(first);
  assert.deepEqual(articles.map((article) => article.articleId), [ARTICLE_A_ID, ARTICLE_B_ID]);
  assert.equal(articles[1]?.classification.module, "module-one");
  assert.equal(articles[1]?.sources?.length, 2);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(articles));
  assert.ok(Object.isFrozen(articles[1]?.classification));
  assert.ok(Object.isFrozen(articles[1]?.revisions));
  assert.ok(Object.isFrozen(articles[1]?.relations));
  assert.ok(Object.isFrozen(articles[1]?.seo));
  assert.ok(Object.isFrozen(articles[1]?.recommendation));
  assert.ok(Object.isFrozen(articles[1]?.sources));
});

test("I-06 未知字段、悬空分类、非法状态和日期原子失败", () => {
  const invalid = makeSource("invalid-article", makeFrontMatter({
    articleId: "not-a-uuid",
    series: "forbidden",
    publicationStatus: "planned",
    authors: ["unknown-author"],
    publishedAt: "2026-02-30",
    classification: {
      project: "unknown-project",
      module: "module-one",
      topics: ["unknown-topic"],
    },
  }));
  const result = validateArticleSource({
    catalog: makeCatalog(),
    sources: [makeSource("valid-article"), invalid],
  });
  expectFailure(result, [
    "CONTENT_ARTICLE_FIELD_UNKNOWN",
    "CONTENT_ARTICLE_FIELD_INVALID",
    "CONTENT_ARTICLE_STATE_INVALID",
    "CONTENT_ARTICLE_DATE_INVALID",
    "CONTENT_ARTICLE_AUTHOR_UNKNOWN",
    "CONTENT_ARTICLE_PROJECT_UNKNOWN",
    "CONTENT_ARTICLE_MODULE_PROJECT_INVALID",
    "CONTENT_ARTICLE_TOPIC_UNKNOWN",
  ]);
});

test("I-06 重复入口、身份、slug 与推荐顺序冲突稳定失败", () => {
  const first = makeSource("first", makeFrontMatter({
    recommendation: {surfaces: ["home"], priority: 10},
  }));
  const second = makeSource("second", makeFrontMatter({
    recommendation: {surfaces: ["home"], priority: 10},
  }));
  const duplicateEntry = makeSource(
    "first",
    makeFrontMatter({
      articleId: ARTICLE_C_ID,
      slug: "/writing/third",
    }),
    ".mdx",
  );
  const result = validateArticleSource({catalog: makeCatalog(), sources: [second, duplicateEntry, first]});
  expectFailure(result, [
    "CONTENT_ARTICLE_SOURCE_DUPLICATE",
    "CONTENT_ARTICLE_ID_DUPLICATE",
    "CONTENT_ARTICLE_SLUG_DUPLICATE",
    "CONTENT_ARTICLE_RECOMMENDATION_CONFLICT",
  ]);
  if (!result.ok) {
    const identities = result.issues.map(({sourcePath, fieldPath, code}) => ({sourcePath, fieldPath, code}));
    const reversed = validateArticleSource({catalog: makeCatalog(), sources: [first, duplicateEntry, second]});
    if (reversed.ok) assert.fail("倒序输入不得改变失败结果。");
    assert.deepEqual(
      identities,
      reversed.issues.map(({sourcePath, fieldPath, code}) => ({sourcePath, fieldPath, code})),
    );
  }
});

test("E-016 重复 articleId 的状态不参与可见性级联且不受输入顺序影响", () => {
  const draftTarget = makeSource("duplicate-draft");
  const publishedTarget = makeSource("duplicate-published", makeFrontMatter({
    title: "重复公开目标",
    slug: "/writing/duplicate-published",
    publicationStatus: "published",
    publishedAt: "2026-07-10",
    updatedAt: "2026-07-18",
  }));
  const publicReference = makeSource("public-reference", makeFrontMatter({
    articleId: ARTICLE_B_ID,
    title: "公开引用目标",
    slug: "/writing/public-reference",
    publicationStatus: "published",
    publishedAt: "2026-07-11",
    updatedAt: "2026-07-18",
    relations: {articles: [ARTICLE_A_ID]},
  }));
  const catalog = makeCatalog([], ["published", "published"]);
  const forward = validateArticleSource({
    catalog,
    sources: [draftTarget, publishedTarget, publicReference],
  });
  const reverse = validateArticleSource({
    catalog,
    sources: [publishedTarget, draftTarget, publicReference],
  });
  expectFailure(forward, ["CONTENT_ARTICLE_ID_DUPLICATE"]);
  expectFailure(reverse, ["CONTENT_ARTICLE_ID_DUPLICATE"]);
  if (!forward.ok && !reverse.ok) {
    const identity = (result: typeof forward) => result.ok ? [] : result.issues.map((issue) => (
      [issue.sourcePath, issue.fieldPath, issue.code]
    ));
    assert.deepEqual(identity(forward), identity(reverse));
    assert.equal(forward.issues.some((issue) => issue.code.endsWith("_UNPUBLISHED")), false);
  }
});

test("E-016 重复 articleId 含非法状态时不得制造可见性伪级联", () => {
  const draftTarget = makeSource("duplicate-draft");
  const invalidTarget = makeSource("duplicate-invalid", makeFrontMatter({
    title: "重复非法目标",
    slug: "/writing/duplicate-invalid",
    publicationStatus: "planned",
  }));
  const publicReference = makeSource("public-reference", makeFrontMatter({
    articleId: ARTICLE_B_ID,
    title: "公开引用目标",
    slug: "/writing/public-reference",
    publicationStatus: "published",
    publishedAt: "2026-07-11",
    updatedAt: "2026-07-18",
    relations: {articles: [ARTICLE_A_ID]},
  }));
  const catalog = makeCatalog([ARTICLE_A_ID], ["published", "published"]);
  const forward = validateArticleSource({
    catalog,
    sources: [draftTarget, invalidTarget, publicReference],
  });
  const reverse = validateArticleSource({
    catalog,
    sources: [invalidTarget, draftTarget, publicReference],
  });
  expectFailure(forward, ["CONTENT_ARTICLE_ID_DUPLICATE", "CONTENT_ARTICLE_STATE_INVALID"]);
  expectFailure(reverse, ["CONTENT_ARTICLE_ID_DUPLICATE", "CONTENT_ARTICLE_STATE_INVALID"]);
  if (!forward.ok && !reverse.ok) {
    const identity = (result: typeof forward) => result.ok ? [] : result.issues.map((issue) => (
      [issue.sourcePath, issue.fieldPath, issue.code]
    ));
    assert.deepEqual(identity(forward), identity(reverse));
    assert.equal(forward.issues.some((issue) => issue.code.endsWith("_UNPUBLISHED")), false);
  }
});

test("I-06 文章关系拒绝自身与悬空引用，项目 relatedWriting 也必须闭合", () => {
  const self = makeSource("self-reference", makeFrontMatter({
    relations: {articles: [ARTICLE_A_ID, ARTICLE_B_ID]},
  }));
  const result = validateArticleSource({
    catalog: makeCatalog([ARTICLE_C_ID]),
    sources: [self],
  });
  expectFailure(result, [
    "CONTENT_ARTICLE_RELATION_SELF",
    "CONTENT_ARTICLE_RELATION_UNKNOWN",
    "CONTENT_PROJECT_WRITING_UNKNOWN",
  ]);

  const unknown = makeSource("unknown-reference", makeFrontMatter({
    relations: {articles: [ARTICLE_B_ID]},
  }));
  expectFailure(
    validateArticleSource({catalog: makeCatalog(), sources: [unknown]}),
    ["CONTENT_ARTICLE_RELATION_UNKNOWN"],
  );
});

test("CODE-003 relations 只为真实空输入报告省略要求", () => {
  const relationIssues = (relations: unknown) => {
    const result = validateArticleSource({
      catalog: makeCatalog(),
      sources: [makeSource("relation-diagnostics", makeFrontMatter({relations}))],
    });
    if (result.ok) assert.fail("关系诊断 fixture 必须失败。");
    return result.issues.filter((issue) => issue.fieldPath?.startsWith("relations"));
  };
  const hasEmptyRelationDiagnostic = (
    issues: ReturnType<typeof relationIssues>,
  ): boolean => issues.some((issue) => (
    issue.fieldPath === "relations"
    && issue.message === "空关系对象或空关系数组必须省略。"
  ));

  for (const relations of [{}, {projects: []}, {articles: []}]) {
    const issues = relationIssues(relations);
    assert.equal(hasEmptyRelationDiagnostic(issues), true);
  }

  const projectOverflow = relationIssues({
    projects: ["one", "two", "three", "four", "five", "six"],
  });
  assert.deepEqual(
    projectOverflow.map(({fieldPath, message}) => ({fieldPath, message})),
    [{
      fieldPath: "relations.projects",
      message: "字段必须是 1-5 个不重复 lowercase kebab-case ID。",
    }],
  );
  assert.equal(hasEmptyRelationDiagnostic(projectOverflow), false);

  const articleOverflow = relationIssues({
    articles: Array.from({length: 11}, (_, index) => (
      `018f0000-0000-7000-8000-${String(index + 16).padStart(12, "0")}`
    )),
  });
  assert.deepEqual(
    articleOverflow.map(({fieldPath, message}) => ({fieldPath, message})),
    [{
      fieldPath: "relations.articles",
      message: "相关文章必须是 1-10 个不重复 UUIDv7。",
    }],
  );
  assert.equal(hasEmptyRelationDiagnostic(articleOverflow), false);
});

test("E-016 公开文章与项目不得把未发布关系带入 production 模型", () => {
  const draft = makeSource("dependency-inversion");
  const published = makeSource("public-reference", makeFrontMatter({
    articleId: ARTICLE_B_ID,
    title: "公开关系可见性校验",
    slug: "/writing/public-reference",
    publicationStatus: "published",
    publishedAt: "2026-07-10",
    updatedAt: "2026-07-18",
    classification: {project: "project-one", topics: ["topic-one"]},
    relations: {
      projects: ["project-two"],
      articles: [ARTICLE_A_ID],
    },
  }));
  const unpublishedOwner = makeSource("unpublished-owner", makeFrontMatter({
    articleId: ARTICLE_C_ID,
    title: "未发布归属可见性校验",
    slug: "/writing/unpublished-owner",
    publicationStatus: "published",
    publishedAt: "2026-07-11",
    updatedAt: "2026-07-18",
    classification: {project: "project-two", topics: ["topic-one"]},
  }));
  const result = validateArticleSource({
    catalog: makeCatalog([ARTICLE_A_ID], ["published", "planned"]),
    sources: [draft, published, unpublishedOwner],
  });
  expectFailure(result, [
    "CONTENT_ARTICLE_PROJECT_UNPUBLISHED",
    "CONTENT_ARTICLE_RELATED_PROJECT_UNPUBLISHED",
    "CONTENT_ARTICLE_RELATION_UNPUBLISHED",
    "CONTENT_PROJECT_WRITING_UNPUBLISHED",
  ]);
});

test("I-06 日期、SEO、推荐、修订与来源的边界错误都失败关闭", () => {
  const invalid = makeSource("nested-invalid", makeFrontMatter({
    publicationStatus: "published",
    publishedAt: "2026-07-18",
    updatedAt: "2026-07-10",
    seo: {
      description: "通过一个可复核的最小案例说明依赖倒置如何改善工程边界。",
      socialDescription: "过短",
    },
    recommendation: {surfaces: ["home", "home"], priority: 101},
    revisions: [
      {date: "2026-07-18", summary: "这是一条足够长的修订摘要。"},
      {date: "2026-07-17", summary: "这也是一条足够长的修订摘要。"},
    ],
    sources: [
      {title: "不安全来源", href: "http://example.test/source"},
      {title: "外部来源", href: "https://example.test/source"},
      {title: "逃逸来源", href: "../private/source.md"},
    ],
  }));
  const result = validateArticleSource({catalog: makeCatalog(), sources: [invalid]});
  expectFailure(result, [
    "CONTENT_ARTICLE_DATE_ORDER",
    "CONTENT_ARTICLE_SEO_REDUNDANT",
    "CONTENT_ARTICLE_FIELD_INVALID",
    "CONTENT_ARTICLE_REVISION_ORDER",
    "CONTENT_ARTICLE_REVISION_RANGE",
    "CONTENT_ARTICLE_SOURCE_DATE_REQUIRED",
  ]);
});

test("I-06 草稿日期状态、空可选分组与冗余主项目关系失败", () => {
  const invalid = makeSource("draft-invalid", makeFrontMatter({
    publishedAt: "2026-07-18",
    classification: {project: "project-one", topics: ["topic-one"]},
    relations: {projects: ["project-one"]},
    seo: {},
    revisions: [],
    sources: [],
  }));
  expectFailure(
    validateArticleSource({catalog: makeCatalog(), sources: [invalid]}),
    [
      "CONTENT_ARTICLE_DATE_STATE",
      "CONTENT_ARTICLE_RELATED_PROJECT_MAIN",
      "CONTENT_ARTICLE_FIELD_INVALID",
    ],
  );
});

test("I-06 非法路径、符号链接与空正文不得保留其他合法文章", () => {
  const symbolic = {
    ...makeSource("symbolic"),
    isSymbolicLink: true,
  };
  const empty = {
    ...makeSource("empty-body", makeFrontMatter({
      articleId: ARTICLE_B_ID,
      slug: "/writing/empty-body",
    })),
    content: "   ",
  };
  const realpathEscape = {
    ...makeSource("realpath-escape", makeFrontMatter({
      articleId: ARTICLE_C_ID,
      slug: "/writing/realpath-escape",
    })),
    isRealPathWithinRoot: false,
  };
  const absolutePath = {
    ...makeSource("absolute-path", makeFrontMatter({
      articleId: "018f0000-0000-7000-8000-000000000004",
      slug: "/writing/absolute-path",
    })),
    sourcePath: "/private/site-content/writing/absolute-path/index.md",
  };
  const result = validateArticleSource({
    catalog: makeCatalog(),
    sources: [makeSource("valid"), symbolic, empty, realpathEscape, absolutePath],
  });
  expectFailure(result, [
    "CONTENT_PATH_INVALID",
    "CONTENT_PATH_SYMBOLIC_LINK",
    "CONTENT_PATH_REALPATH_ESCAPE",
    "CONTENT_ARTICLE_BODY_INVALID",
  ]);
  if (!result.ok) {
    assert.doesNotMatch(JSON.stringify(result.issues), /\/private/u);
  }
});

test("I-06 可独立识别的跨批重复继续聚合，非法成员不会制造假悬空", () => {
  const first = makeSource("first-probe", makeFrontMatter({
    relations: {articles: [ARTICLE_B_ID]},
  }));
  const second = makeSource("second-probe", makeFrontMatter({
    articleId: ARTICLE_B_ID,
    slug: "/writing/second-probe",
    summary: "过短",
  }));
  const noCascade = validateArticleSource({catalog: makeCatalog(), sources: [first, second]});
  expectFailure(noCascade, ["CONTENT_ARTICLE_FIELD_INVALID"]);
  if (!noCascade.ok) {
    assert.equal(noCascade.issues.some((issue) => issue.code === "CONTENT_ARTICLE_RELATION_UNKNOWN"), false);
  }

  const duplicateWithLocalError = makeSource("duplicate-probe", makeFrontMatter({summary: "过短"}));
  const duplicateResult = validateArticleSource({
    catalog: makeCatalog(),
    sources: [makeSource("valid-probe"), duplicateWithLocalError],
  });
  expectFailure(duplicateResult, [
    "CONTENT_ARTICLE_FIELD_INVALID",
    "CONTENT_ARTICLE_ID_DUPLICATE",
    "CONTENT_ARTICLE_SLUG_DUPLICATE",
  ]);
});

test("I-06 恶意未知 key 与伪仓库路径只产生脱敏稳定诊断", () => {
  const secretKey = "\nTOKEN=do-not-expose";
  const malicious = makeFrontMatter({
    [secretKey]: true,
    sources: [
      {title: "Windows 绝对路径", href: "C:/private/source.md"},
      {title: "边缘空白路径", href: " docs/source.md "},
      {title: "伪协议路径", href: "file:private-source"},
    ],
  });
  const result = validateArticleSource({catalog: makeCatalog(), sources: [makeSource("malicious", malicious)]});
  expectFailure(result, ["CONTENT_ARTICLE_FIELD_UNKNOWN", "CONTENT_ARTICLE_FIELD_INVALID"]);
  if (!result.ok) {
    const text = JSON.stringify(result.issues);
    assert.doesNotMatch(text, /TOKEN|do-not-expose|C:\/|file:private/u);
    assert.ok(result.issues.some((issue) => (
      issue.code === "CONTENT_ARTICLE_FIELD_UNKNOWN"
      && issue.fieldPath === "unknownField"
    )));
  }
});

test("I-06 畸形 catalog 与缺少 project 的 module 返回稳定 issue 而不抛裸异常", () => {
  const malformedCatalog = {
    projects: [],
    authors: [null],
    topics: [],
    experiences: [],
    projectSources: [],
  };
  const malformed = validateArticleSource({
    catalog: malformedCatalog as unknown as ProjectCatalog,
    sources: [makeSource("malformed-catalog")],
  });
  expectFailure(malformed, ["CONTENT_ARTICLE_CATALOG_INVALID"]);

  const moduleWithoutProject = makeSource("module-without-project", makeFrontMatter({
    classification: {module: "module-one", topics: ["topic-one"]},
  }));
  expectFailure(
    validateArticleSource({catalog: makeCatalog(), sources: [moduleWithoutProject]}),
    ["CONTENT_ARTICLE_MODULE_WITHOUT_PROJECT"],
  );
});

test("E-016 文章批次只接受同次 validateProjectCatalog 返回对象的 provenance", () => {
  const catalog = makeCatalog();
  for (const [label, forged] of [
    ["深克隆", structuredClone(catalog)],
    ["浅克隆", {...catalog}],
  ] as const) {
    expectFailure(
      validateArticleSource({
        catalog: forged as ProjectCatalog,
        sources: [makeSource(`forged-${label === "深克隆" ? "deep" : "shallow"}`)],
      }),
      ["CONTENT_ARTICLE_CATALOG_INVALID"],
    );
  }
});

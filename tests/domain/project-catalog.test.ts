import assert from "node:assert/strict";
import test from "node:test";
import {validateProjectCatalog} from "../../src/domain/content/index.js";
import type {
  ContentIssue,
  ProjectCatalog,
  ProjectCatalogInput,
  ProjectSourceInput,
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

const FENCED_HEADING_BODY = `## 项目说明

正文只描述问题、取舍与证据，不重复注册表字段。

    <h1>根缩进代码中的原生标题只是示例</h1>

跨行代码跨度 \`<h1>
仍然不是标题</h1>\` 结束。

\`\`\`md
# 围栏内的 ATX H1 只是示例
围栏内的 Setext H1
===================
<h1>围栏内的原生标题</h1>
\`\`\`

> \`\`\`md
> # 引用围栏内的 H1 也只是示例
> \`\`\`

- \`\`\`md
  # 列表围栏内的 H1 也只是示例
  \`\`\`

      <h1>列表缩进代码中的原生标题只是示例</h1>
`;

type RegistryName = "projects" | "authors" | "topics" | "experiences";

function createValidInput(): ProjectCatalogInput {
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
          {
            id: "alpha-lab",
            title: "Alpha Lab",
            slug: "alpha-lab",
            navigationOrder: 1,
            summary: "A planned project with enough factual detail for validation.",
            status: "active",
            publicationStatus: "planned",
            startedAt: "2026-01",
            updatedAt: "2026-07-01",
            repositoryUrl: "https://github.com/example/alpha-lab",
            productionBranch: "main",
            showcaseMode: "repository",
            experienceRegistryId: "alpha-lab",
            writingModules: [
              {
                id: "architecture",
                displayName: "Architecture",
                navigationOrder: 1,
                status: "active",
              },
            ],
            source: ["docs/projects/alpha-lab.md"],
          },
          {
            id: "beta-site",
            title: "Beta Site",
            slug: "beta-site",
            navigationOrder: 2,
            summary: "A published project with independently traceable implementation evidence.",
            status: "active",
            publicationStatus: "published",
            startedAt: "2025-12-15",
            updatedAt: "2026-07-02",
            repositoryUrl: "https://github.com/example/beta-site",
            productionBranch: "release/site",
            showcaseMode: "repository",
            previewImage: {
              sourcePath: "projects/beta-site/hero.webp",
              width: 1600,
              height: 1000,
              alt: "Beta Site dashboard showing validated publication evidence",
            },
            source: ["https://example.com/evidence/beta-site"],
          },
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
          "example-author": {
            displayName: "Example Author",
            links: {github: "https://github.com/example-author"},
          },
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
            displayName: "Architecture",
            navigationOrder: 1,
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
        experiences: [
          {
            id: "alpha-lab",
            projectId: "alpha-lab",
            hostname: "alpha-lab.axialmuse.com",
            status: "planned",
            dnsProvisioning: "disabled",
            deliveryMode: "static",
            deploymentSource: {
              kind: "project-repository",
              workingDirectory: "site",
            },
            qualityCommands: ["npm test"],
            buildCommand: "npm run build",
            artifactDirectory: "build",
            healthPath: "/",
            indexing: "noindex",
            dataBoundary: "docs/contracts/project-experiences.json",
            owner: "AxialMuseWebsite",
          },
        ],
      },
    },
    projectSources: [
      {
        sourcePath: "site-content/projects/alpha-lab/index.md",
        isSymbolicLink: false,
        isRealPathWithinRoot: true,
        frontMatter: {},
        content: FENCED_HEADING_BODY,
      },
      {
        sourcePath: "site-content/projects/beta-site/index.mdx",
        isSymbolicLink: false,
        isRealPathWithinRoot: true,
        frontMatter: {},
        content: "## Published evidence\n\nThe evidence remains in the project body.\n",
      },
    ],
  };
}

function registryValue(
  input: ProjectCatalogInput,
  name: RegistryName,
): Record<string, unknown> {
  return input[name].value as Record<string, unknown>;
}

function projects(input: ProjectCatalogInput): Array<Record<string, unknown>> {
  return registryValue(input, "projects").projects as Array<Record<string, unknown>>;
}

function experiences(input: ProjectCatalogInput): Array<Record<string, unknown>> {
  return registryValue(input, "experiences").experiences as Array<Record<string, unknown>>;
}

function project(input: ProjectCatalogInput, id: string): Record<string, unknown> {
  const found = projects(input).find((entry) => entry.id === id);
  assert.ok(found, `测试夹具缺少项目 ${id}`);
  return found;
}

function projectSource(input: ProjectCatalogInput, id: string): ProjectSourceInput {
  const found = input.projectSources.find((entry) => (
    entry.sourcePath.startsWith(`site-content/projects/${id}/`)
  ));
  assert.ok(found, `测试夹具缺少项目正文 ${id}`);
  return found;
}

function mutableSources(input: ProjectCatalogInput): ProjectSourceInput[] {
  return input.projectSources as unknown as ProjectSourceInput[];
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value as Record<string, unknown>)) {
    assertDeepFrozen(child, seen);
  }
}

function expectSuccess(result: ValidationResult<ProjectCatalog>): ProjectCatalog {
  if (!result.ok) {
    assert.fail(`预期成功，实际问题码：${result.issues.map((issue) => issue.code).join(", ")}`);
  }
  assertDeepFrozen(result);
  return result.value;
}

function expectFailure(
  result: ValidationResult<ProjectCatalog>,
  requiredCodes: readonly string[],
): readonly ContentIssue[] {
  if (result.ok) assert.fail("预期失败，实际返回了项目目录值。");
  assert.equal(Object.hasOwn(result, "value"), false);
  assertDeepFrozen(result);
  for (const code of requiredCodes) {
    assert.ok(
      result.issues.some((issue) => issue.code === code),
      `缺少预期问题码 ${code}；实际为 ${result.issues.map((issue) => issue.code).join(", ")}`,
    );
  }
  return result.issues;
}

function assertIssue(
  issues: readonly ContentIssue[],
  code: string,
  fieldPath: string,
): void {
  assert.ok(
    issues.some((issue) => issue.code === code && issue.fieldPath === fieldPath),
    `缺少 ${code} @ ${fieldPath}`,
  );
}

test("I-06 planned/published 最小自含 catalog 稳定排序并深冻结", () => {
  const canonical = expectSuccess(validateProjectCatalog(createValidInput()));
  assert.deepEqual(canonical.projects.map((entry) => entry.id), ["alpha-lab", "beta-site"]);
  assert.deepEqual(canonical.projectSources.map((entry) => entry.projectId), ["alpha-lab", "beta-site"]);
  assert.deepEqual(canonical.experiences.map((entry) => entry.id), ["alpha-lab"]);

  const reversed = createValidInput();
  projects(reversed).reverse();
  mutableSources(reversed).reverse();
  const reversedValue = expectSuccess(validateProjectCatalog(reversed));
  assert.deepEqual(reversedValue, canonical);
});

test("I-06 四份注册表封套与未知字段分别失败关闭", () => {
  const contracts = [
    ["projects", "CONTENT_PROJECT_REGISTRY_ENVELOPE", "CONTENT_PROJECT_REGISTRY_FIELD_UNKNOWN"],
    ["authors", "CONTENT_AUTHOR_REGISTRY_ENVELOPE", "CONTENT_AUTHOR_REGISTRY_FIELD_UNKNOWN"],
    ["topics", "CONTENT_TOPIC_REGISTRY_ENVELOPE", "CONTENT_TOPIC_REGISTRY_FIELD_UNKNOWN"],
    ["experiences", "CONTENT_EXPERIENCE_REGISTRY_ENVELOPE", "CONTENT_EXPERIENCE_REGISTRY_FIELD_UNKNOWN"],
  ] as const;

  for (const [name, envelopeCode, unknownCode] of contracts) {
    const input = createValidInput();
    const value = registryValue(input, name);
    value.owner = "AnotherOwner";
    value.unexpected = true;
    const issues = expectFailure(validateProjectCatalog(input), [envelopeCode, unknownCode]);
    assertIssue(issues, envelopeCode, "owner");
    assertIssue(issues, unknownCode, "unexpected");
  }
});

test("I-06 项目重复 ID、slug 与同级 navigationOrder 双向定位", () => {
  const duplicateIdInput = createValidInput();
  const duplicate = structuredClone(project(duplicateIdInput, "alpha-lab"));
  duplicate.slug = "alpha-copy";
  duplicate.navigationOrder = 3;
  projects(duplicateIdInput).push(duplicate);
  const duplicateIdIssues = expectFailure(
    validateProjectCatalog(duplicateIdInput),
    ["CONTENT_PROJECT_ID_DUPLICATE"],
  );
  assert.equal(
    duplicateIdIssues.filter((issue) => issue.code === "CONTENT_PROJECT_ID_DUPLICATE").length,
    2,
  );

  const duplicateSlugInput = createValidInput();
  project(duplicateSlugInput, "beta-site").slug = "alpha-lab";
  const duplicateSlugIssues = expectFailure(
    validateProjectCatalog(duplicateSlugInput),
    ["CONTENT_PROJECT_SLUG_DUPLICATE"],
  );
  assert.equal(
    duplicateSlugIssues.filter((issue) => issue.code === "CONTENT_PROJECT_SLUG_DUPLICATE").length,
    2,
  );

  const duplicateOrderInput = createValidInput();
  project(duplicateOrderInput, "beta-site").navigationOrder = 1;
  const duplicateOrderIssues = expectFailure(
    validateProjectCatalog(duplicateOrderInput),
    ["CONTENT_PROJECT_ORDER_DUPLICATE"],
  );
  assert.equal(
    duplicateOrderIssues.filter((issue) => issue.code === "CONTENT_PROJECT_ORDER_DUPLICATE").length,
    2,
  );
});

test("I-06 未知项目与反向不一致的 experience 外键都失败", () => {
  const unknownProject = createValidInput();
  experiences(unknownProject)[0].projectId = "missing-project";
  expectFailure(validateProjectCatalog(unknownProject), [
    "CONTENT_EXPERIENCE_PROJECT_UNKNOWN",
    "CONTENT_PROJECT_EXPERIENCE_UNKNOWN",
  ]);

  const reversedOwner = createValidInput();
  experiences(reversedOwner)[0].projectId = "beta-site";
  expectFailure(validateProjectCatalog(reversedOwner), [
    "CONTENT_PROJECT_EXPERIENCE_UNKNOWN",
    "CONTENT_PROJECT_EXPERIENCE_REQUIRED",
  ]);
});

test("I-06 项目正文拒绝 frontmatter 与三类 H1，围栏示例不误报", () => {
  expectSuccess(validateProjectCatalog(createValidInput()));

  const frontMatterInput = createValidInput();
  (projectSource(frontMatterInput, "beta-site") as unknown as {frontMatter: unknown}).frontMatter = {
    title: "不得复制注册表字段",
  };
  expectFailure(
    validateProjectCatalog(frontMatterInput),
    ["CONTENT_PROJECT_FRONTMATTER_FORBIDDEN"],
  );

  for (const nonRecord of [
    new Map([["title", "隐藏字段"]]),
    new Date(0),
  ]) {
    const input = createValidInput();
    (projectSource(input, "beta-site") as unknown as {frontMatter: unknown}).frontMatter = nonRecord;
    expectFailure(
      validateProjectCatalog(input),
      ["CONTENT_PROJECT_FRONTMATTER_INVALID"],
    );
  }

  const headings = [
    "# 不允许的 ATX H1\n",
    "不允许的 Setext H1\n==================\n",
    "<h1>不允许的原生 H1</h1>\n",
    "> # 引用中的 ATX H1\n",
    "> 引用中的 Setext H1\n> ==================\n",
    "- # 列表中的 ATX H1\n",
    "- 列表中的 Setext H1\n  ==================\n",
    "- - 嵌套列表中的 Setext H1\n    ==================\n",
    "- 父列表\n\n    # 空行后的列表 ATX H1\n",
    "> ```md\n> 未闭合围栏\n\n# 引用结束后的真实 H1\n",
    "> <!--\n> 未闭合注释\n\n# 引用结束后的真实 H1\n",
    "- ```md\n  代码\n- # 同级列表项中的真实 H1\n",
    "foo `<h1>未匹配反引号后的原生 H1</h1>\n",
    "foo `\n<h1>跨行未匹配反引号后的原生 H1</h1>\n` end\n",
    "foo <!--\n# 未闭合行内注释后的 ATX H1\n",
    "foo <!-- x\n<h1>未闭合行内注释后的原生 H1</h1>\n",
    "foo <!-- x\nbar <h1>无结束标记的伪注释后仍是原生 H1</h1>\n",
    "foo <!-- x\n未闭合行内注释后的 Setext H1\n=====\n",
    "正文段落\n    <h1>段落续行中的原生 H1</h1>\n",
  ];
  for (const content of headings) {
    const input = createValidInput();
    (projectSource(input, "beta-site") as unknown as {content: string}).content = content;
    expectFailure(validateProjectCatalog(input), ["CONTENT_PROJECT_H1_FORBIDDEN"]);
  }

  const codeAndCommentExamples = [
    "```md\n代码\n> # 根围栏内仍是代码\n",
    "<!--\n> # 根注释内仍是注释\n-->\n",
    "<!--\n--> # 结束标记所在行仍属于 HTML block\n",
    "<!--\n--> <h1>结束标记所在行仍属于 HTML block</h1>\n",
    "<!--\n--> 标题文字\n=====\n",
    "- > ```md\n  > # list 后 quote 围栏内仍是代码\n  > ```\n",
    "\n    <h1>前置空行后的缩进代码</h1>\n",
  ];
  for (const content of codeAndCommentExamples) {
    const input = createValidInput();
    (projectSource(input, "beta-site") as unknown as {content: string}).content = content;
    expectSuccess(validateProjectCatalog(input));
  }
});

test("I-06 孤儿、双入口与公开项目缺正文分别失败", () => {
  const orphan = createValidInput();
  mutableSources(orphan).push({
    sourcePath: "site-content/projects/orphan-project/index.md",
    isSymbolicLink: false,
    isRealPathWithinRoot: true,
    frontMatter: {},
    content: "## Orphan project\n",
  });
  expectFailure(validateProjectCatalog(orphan), ["CONTENT_PROJECT_SOURCE_ORPHAN"]);

  const duplicate = createValidInput();
  mutableSources(duplicate).push({
    ...projectSource(duplicate, "beta-site"),
    sourcePath: "site-content/projects/beta-site/index.md",
  });
  const duplicateIssues = expectFailure(validateProjectCatalog(duplicate), [
    "CONTENT_PROJECT_SOURCE_DUPLICATE",
    "CONTENT_PROJECT_SOURCE_REQUIRED",
  ]);
  assert.equal(
    duplicateIssues.filter((issue) => issue.code === "CONTENT_PROJECT_SOURCE_DUPLICATE").length,
    2,
  );

  const missing = createValidInput();
  const missingPublishedBody: ProjectCatalogInput = {
    ...missing,
    projectSources: missing.projectSources.filter((entry) => !entry.sourcePath.includes("/beta-site/")),
  };
  expectFailure(
    validateProjectCatalog(missingPublishedBody),
    ["CONTENT_PROJECT_SOURCE_REQUIRED"],
  );
});

test("I-06 preview 绑定、体验状态与项目 source 路径均失败关闭", () => {
  const preview = createValidInput();
  const previewImage = project(preview, "beta-site").previewImage as Record<string, unknown>;
  previewImage.sourcePath = "projects/alpha-lab/hero.webp";
  const previewIssues = expectFailure(validateProjectCatalog(preview), [
    "CONTENT_PROJECT_PREVIEW_PATH",
    "CONTENT_PROJECT_PREVIEW_REQUIRED",
  ]);
  assertIssue(previewIssues, "CONTENT_PROJECT_PREVIEW_PATH", "projects.1.previewImage.sourcePath");

  const state = createValidInput();
  experiences(state)[0].status = "live";
  const stateIssues = expectFailure(
    validateProjectCatalog(state),
    ["CONTENT_EXPERIENCE_STATE_INVALID"],
  );
  assertIssue(stateIssues, "CONTENT_EXPERIENCE_STATE_INVALID", "experiences.0.dnsProvisioning");

  const source = createValidInput();
  project(source, "alpha-lab").source = ["../private/evidence.md"];
  const sourceIssues = expectFailure(
    validateProjectCatalog(source),
    ["CONTENT_PROJECT_FIELD_INVALID"],
  );
  assertIssue(sourceIssues, "CONTENT_PROJECT_FIELD_INVALID", "projects.0.source.0");
});

test("I-06 approved 视频三元组及其缺项、状态和路径边界", () => {
  const approved = createValidInput();
  const approvedProject = project(approved, "beta-site");
  approvedProject.showcaseMode = "repository-and-video";
  approvedProject.demoVideoStatus = "approved";
  approvedProject.demoVideoUrl = "/assets/projects/beta-site/demo.mp4";
  approvedProject.demoVideoPoster = "/assets/projects/beta-site/demo-poster.webp";
  approvedProject.demoVideoCaptions = "/assets/projects/beta-site/demo.zh-CN.vtt";
  expectSuccess(validateProjectCatalog(approved));

  const incomplete = structuredClone(approved);
  delete project(incomplete, "beta-site").demoVideoCaptions;
  const incompleteIssues = expectFailure(
    validateProjectCatalog(incomplete),
    ["CONTENT_PROJECT_VIDEO_INCOMPLETE", "CONTENT_PROJECT_VIDEO_STATE"],
  );
  assertIssue(
    incompleteIssues,
    "CONTENT_PROJECT_VIDEO_INCOMPLETE",
    "projects.1.demoVideoUrl",
  );

  const stateMismatch = structuredClone(approved);
  project(stateMismatch, "beta-site").demoVideoStatus = "review-pending";
  project(stateMismatch, "beta-site").showcaseMode = "repository";
  const stateIssues = expectFailure(
    validateProjectCatalog(stateMismatch),
    ["CONTENT_PROJECT_VIDEO_STATE"],
  );
  assertIssue(
    stateIssues,
    "CONTENT_PROJECT_VIDEO_STATE",
    "projects.1.demoVideoStatus",
  );

  const invalidPaths = structuredClone(approved);
  const invalidProject = project(invalidPaths, "beta-site");
  invalidProject.demoVideoUrl = "http://example.com/demo.mp4";
  invalidProject.demoVideoPoster = "../private/poster.webp";
  invalidProject.demoVideoCaptions = "/assets/projects/beta-site/%2e%2e/private.vtt";
  const pathIssues = expectFailure(
    validateProjectCatalog(invalidPaths),
    ["CONTENT_PROJECT_FIELD_INVALID"],
  );
  for (const fieldPath of [
    "projects.1.demoVideoUrl",
    "projects.1.demoVideoPoster",
    "projects.1.demoVideoCaptions",
  ]) {
    assertIssue(pathIssues, "CONTENT_PROJECT_FIELD_INVALID", fieldPath);
  }
});

test("I-06 productionBranch 拒绝 Git 不接受的隐藏、lock 与 HEAD", () => {
  for (const productionBranch of ["release/.hidden", "foo.lock/bar", "HEAD"]) {
    const input = createValidInput();
    project(input, "alpha-lab").productionBranch = productionBranch;
    const issues = expectFailure(
      validateProjectCatalog(input),
      ["CONTENT_PROJECT_FIELD_INVALID"],
    );
    assertIssue(
      issues,
      "CONTENT_PROJECT_FIELD_INVALID",
      "projects.0.productionBranch",
    );
  }
});

test("I-06 HTTPS 与站内路径拒绝非规范等价写法", () => {
  for (const repositoryUrl of [
    "https:example.com/repository",
    "https://example.com\\repository",
    "https://example.com:443/repository",
  ]) {
    const input = createValidInput();
    project(input, "alpha-lab").repositoryUrl = repositoryUrl;
    const issues = expectFailure(
      validateProjectCatalog(input),
      ["CONTENT_PROJECT_FIELD_INVALID"],
    );
    assertIssue(issues, "CONTENT_PROJECT_FIELD_INVALID", "projects.0.repositoryUrl");
  }

  for (const captionsPath of [
    "/assets/projects/alpha-lab/%2e%2e/private.vtt",
    "/assets/projects/alpha-lab/demo.vtt ",
    "/assets/projects/alpha-lab /demo.vtt",
    "/assets/projects/alpha-lab/demo caption.vtt",
    "/assets/projects/alpha-lab/demo\u00a0caption.vtt",
  ]) {
    const input = createValidInput();
    const target = project(input, "alpha-lab");
    target.showcaseMode = "repository-and-video";
    target.demoVideoStatus = "approved";
    target.demoVideoUrl = "/assets/projects/alpha-lab/demo.mp4";
    target.demoVideoPoster = "/assets/projects/alpha-lab/demo.webp";
    target.demoVideoCaptions = captionsPath;
    const issues = expectFailure(
      validateProjectCatalog(input),
      ["CONTENT_PROJECT_FIELD_INVALID"],
    );
    assertIssue(issues, "CONTENT_PROJECT_FIELD_INVALID", "projects.0.demoVideoCaptions");
  }
});

test("I-06 无效非 ID 字段不制造跨注册表伪悬空", () => {
  const input = createValidInput();
  project(input, "alpha-lab").title = "";
  const issues = expectFailure(
    validateProjectCatalog(input),
    ["CONTENT_PROJECT_FIELD_INVALID"],
  );
  assertIssue(issues, "CONTENT_PROJECT_FIELD_INVALID", "projects.0.title");
  assert.equal(
    issues.some((issue) => [
      "CONTENT_EXPERIENCE_PROJECT_UNKNOWN",
      "CONTENT_PROJECT_EXPERIENCE_UNKNOWN",
      "CONTENT_PROJECT_EXPERIENCE_REQUIRED",
    ].includes(issue.code)),
    false,
  );
});

test("I-06 单行文本拒绝 C1 与 Unicode 行段分隔符", () => {
  for (const unsafeCharacter of ["\u0085", "\u2028", "\u2029"]) {
    const input = createValidInput();
    project(input, "alpha-lab").title = `Alpha${unsafeCharacter}Lab`;
    const issues = expectFailure(
      validateProjectCatalog(input),
      ["CONTENT_PROJECT_FIELD_INVALID"],
    );
    assertIssue(issues, "CONTENT_PROJECT_FIELD_INVALID", "projects.0.title");
  }
});

test("I-06 体验 ID 遵守项目 slug、保留名与项目一致性", () => {
  for (const invalidId of ["www", "1alpha"]) {
    const input = createValidInput();
    experiences(input)[0].id = invalidId;
    experiences(input)[0].hostname = `${invalidId}.axialmuse.com`;
    const issues = expectFailure(
      validateProjectCatalog(input),
      ["CONTENT_EXPERIENCE_FIELD_INVALID"],
    );
    assertIssue(issues, "CONTENT_EXPERIENCE_FIELD_INVALID", "experiences.0.id");
  }

  const mismatch = createValidInput();
  experiences(mismatch)[0].projectId = "beta-site";
  const mismatchIssues = expectFailure(
    validateProjectCatalog(mismatch),
    ["CONTENT_EXPERIENCE_PROJECT_MISMATCH"],
  );
  assertIssue(
    mismatchIssues,
    "CONTENT_EXPERIENCE_PROJECT_MISMATCH",
    "experiences.0.projectId",
  );
});

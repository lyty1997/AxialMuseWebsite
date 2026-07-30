import assert from "node:assert/strict";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import test from "node:test";
import {validateProjectCatalog} from "../../src/domain/content/index.js";
import type {
  ContentIssue,
  ProjectCatalog,
  ProjectCatalogInput,
  ProjectSourceInput,
  RegistryDocumentInput,
  ValidationResult,
} from "../../src/domain/content/index.js";

const ROOT = process.cwd();
const CONTENT_ROOT = realpathSync(resolve(ROOT, "site-content"));
const PROJECT_SOURCE_PATHS = [
  "site-content/projects/docrestore/index.md",
  "site-content/projects/vibecoding-project-scaffold/index.md",
] as const;

function readRegistry(sourcePath: string): RegistryDocumentInput {
  return {
    sourcePath,
    value: JSON.parse(readFileSync(resolve(ROOT, sourcePath), "utf8")) as unknown,
  };
}

function isWithinContentRoot(path: string): boolean {
  const pathFromRoot = relative(CONTENT_ROOT, path);
  return pathFromRoot !== ""
    && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot);
}

function readProjectSource(sourcePath: string): ProjectSourceInput {
  const absolutePath = resolve(ROOT, sourcePath);
  const metadata = lstatSync(absolutePath);
  assert.equal(metadata.isSymbolicLink(), false, `${sourcePath} 不得是符号链接`);
  assert.equal(metadata.isFile(), true, `${sourcePath} 必须是普通文件`);
  const realPath = realpathSync(absolutePath);
  assert.equal(isWithinContentRoot(realPath), true, `${sourcePath} 必须位于真实内容根内`);
  const content = readFileSync(realPath, "utf8");
  assert.equal(content.charCodeAt(0) === 0xfeff, false, `${sourcePath} 不得含 BOM`);
  assert.doesNotMatch(content, /^---(?:\r?\n|$)/u, `${sourcePath} 不得声明 frontmatter`);
  return {
    sourcePath,
    isSymbolicLink: false,
    isRealPathWithinRoot: true,
    frontMatter: {},
    content,
  };
}

function createRepositoryInput(): ProjectCatalogInput {
  return {
    projects: readRegistry("docs/contracts/projects.json"),
    authors: readRegistry("docs/contracts/authors.json"),
    topics: readRegistry("docs/contracts/topics.json"),
    experiences: readRegistry("docs/contracts/project-experiences.json"),
    projectSources: PROJECT_SOURCE_PATHS.map(readProjectSource),
  };
}

function expectSuccess(result: ValidationResult<ProjectCatalog>): ProjectCatalog {
  if (!result.ok) {
    assert.fail(`预期迁移成功，实际问题码：${result.issues.map((issue) => issue.code).join(", ")}`);
  }
  return result.value;
}

function expectFailure(
  result: ValidationResult<ProjectCatalog>,
  code: string,
  fieldPath?: string,
): readonly ContentIssue[] {
  if (result.ok) assert.fail("预期迁移门禁失败，实际返回了部分或完整目录值。");
  assert.equal(Object.hasOwn(result, "value"), false);
  assert.ok(result.issues.some((issue) => (
    issue.code === code && (fieldPath === undefined || issue.fieldPath === fieldPath)
  )), `缺少 ${code}${fieldPath === undefined ? "" : ` @ ${fieldPath}`}`);
  return result.issues;
}

function rawProjects(input: ProjectCatalogInput): Array<Record<string, unknown>> {
  const value = input.projects.value;
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  const projects = (value as Record<string, unknown>).projects;
  assert.ok(Array.isArray(projects));
  return projects as Array<Record<string, unknown>>;
}

function mutableSources(input: ProjectCatalogInput): ProjectSourceInput[] {
  return input.projectSources as unknown as ProjectSourceInput[];
}

function h2Section(markdown: string, heading: string): string {
  const marker = `## ${heading}\n`;
  const start = markdown.indexOf(marker);
  assert.notEqual(start, -1, `缺少 H2：${heading}`);
  const contentStart = start + marker.length;
  const next = markdown.indexOf("\n## ", contentStart);
  return markdown.slice(contentStart, next === -1 ? markdown.length : next).trim();
}

test("I-10 两份真实正文与四份注册表形成唯一且完整的迁移目录", () => {
  const catalog = expectSuccess(validateProjectCatalog(createRepositoryInput()));
  assert.deepEqual(
    catalog.projects.map(({id}) => id),
    ["docrestore", "vibecoding-project-scaffold"],
  );
  assert.deepEqual(
    catalog.projectSources.map(({projectId, sourcePath}) => ({projectId, sourcePath})),
    [
      {
        projectId: "docrestore",
        sourcePath: "site-content/projects/docrestore/index.md",
      },
      {
        projectId: "vibecoding-project-scaffold",
        sourcePath: "site-content/projects/vibecoding-project-scaffold/index.md",
      },
    ],
  );
});

test("I-10 迁移事实留在正文，原过渡章节只保留所有权链接", () => {
  const docrestoreBody = readFileSync(resolve(ROOT, PROJECT_SOURCE_PATHS[0]), "utf8");
  for (const fact of [
    "连续拍摄的文档照片重新组织成可审阅、可编辑的结果",
    "OCR、清洗去重、隐私处理、LLM 与输出",
    "当前没有公共在线体验",
    "主预览、演示视频、封面和字幕尚未通过本站公开性审核",
  ]) assert.match(docrestoreBody, new RegExp(fact, "u"));

  const scaffoldBody = readFileSync(resolve(ROOT, PROJECT_SOURCE_PATHS[1]), "utf8");
  for (const fact of [
    "新项目通常缺少统一的设计真相源、Agent 执行规则和自动质量门禁",
    "scripts/init.mjs",
    "不绑定前端或后端框架",
    "Node.js 内置能力",
    "Apache License 2.0",
    "Git hooks",
  ]) assert.match(scaffoldBody, new RegExp(fact.replaceAll(".", "\\."), "u"));

  const docrestoreDesign = readFileSync(
    resolve(ROOT, "docs/projects/docrestore-experience.md"),
    "utf8",
  );
  assert.equal(
    h2Section(docrestoreDesign, "主站项目正文"),
    "问题、能力、取舍、限制、证据说明与复盘只在[主站项目正文](../../site-content/projects/docrestore/index.md)中维护。本文继续拥有在线体验、数据和安全门禁，不复制主站叙事。",
  );

  const scaffoldDesign = readFileSync(
    resolve(ROOT, "docs/projects/vibecoding-project-scaffold.md"),
    "utf8",
  );
  assert.equal(
    h2Section(scaffoldDesign, "主站项目正文"),
    "问题、能力、取舍、限制、证据说明与复盘只在[主站项目正文](../../site-content/projects/vibecoding-project-scaffold/index.md)中维护。本文继续拥有仓库事实、页面动作、视觉证据、公开边界和验收门禁，不复制主站叙事。",
  );
});

test("I-10 注册表恢复旧叙事字段时逐项失败且不返回目录值", () => {
  const legacyValues: Readonly<Record<string, unknown>> = {
    problem: "不得恢复问题叙事字段",
    decisions: ["不得恢复取舍叙事字段"],
    evidence: ["不得恢复证据叙事字段"],
  };
  for (const [field, value] of Object.entries(legacyValues)) {
    const input = createRepositoryInput();
    rawProjects(input)[0][field] = value;
    expectFailure(
      validateProjectCatalog(input),
      "CONTENT_PROJECT_FIELD_UNKNOWN",
      `projects.0.${field}`,
    );
  }
});

test("I-10 真实迁移输入的 frontmatter、H1、孤儿和双入口反例稳定失败", () => {
  const frontMatter = createRepositoryInput();
  (mutableSources(frontMatter)[0] as unknown as {frontMatter: unknown}).frontMatter = {
    title: "不得复制结构化标题",
  };
  expectFailure(validateProjectCatalog(frontMatter), "CONTENT_PROJECT_FRONTMATTER_FORBIDDEN");

  const h1 = createRepositoryInput();
  (mutableSources(h1)[0] as unknown as {content: string}).content = "# 不允许的 H1\n";
  expectFailure(validateProjectCatalog(h1), "CONTENT_PROJECT_H1_FORBIDDEN");

  const orphan = createRepositoryInput();
  mutableSources(orphan).push({
    sourcePath: "site-content/projects/orphan-project/index.md",
    isSymbolicLink: false,
    isRealPathWithinRoot: true,
    frontMatter: {},
    content: "## 孤儿正文\n",
  });
  expectFailure(validateProjectCatalog(orphan), "CONTENT_PROJECT_SOURCE_ORPHAN");

  const duplicate = createRepositoryInput();
  mutableSources(duplicate).push({
    ...duplicate.projectSources[0],
    sourcePath: "site-content/projects/docrestore/index.mdx",
  });
  const issues = expectFailure(
    validateProjectCatalog(duplicate),
    "CONTENT_PROJECT_SOURCE_DUPLICATE",
  );
  assert.equal(
    issues.filter((issue) => issue.code === "CONTENT_PROJECT_SOURCE_DUPLICATE").length,
    2,
  );
});

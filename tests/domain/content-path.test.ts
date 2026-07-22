import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyContentPath,
  normalizeContentPath,
} from "../../src/domain/content/index.js";
import type {
  ContentPathClassification,
  ValidationResult,
} from "../../src/domain/content/index.js";

function expectSuccess<T>(result: ValidationResult<T>): T {
  if (!result.ok) {
    assert.fail(`预期成功，实际问题码：${result.issues.map((issue) => issue.code).join(", ")}`);
  }
  return result.value;
}

function expectFailure<T>(
  result: ValidationResult<T>,
  expectedCodes: readonly string[],
): void {
  if (result.ok) {
    assert.fail("预期失败，实际返回了领域值。");
  }
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    expectedCodes,
  );
}

function classify(
  sourcePath: string,
  facts: Readonly<{
    isSymbolicLink?: boolean;
    isRealPathWithinRoot?: boolean;
  }> = {},
): ValidationResult<ContentPathClassification> {
  return classifyContentPath({
    sourcePath,
    isSymbolicLink: facts.isSymbolicLink ?? false,
    isRealPathWithinRoot: facts.isRealPathWithinRoot ?? true,
  });
}

test("I-06 合法项目、文章与正文资源路径得到唯一分类", () => {
  const projectPath = "site-content/projects/docrestore/index.md";
  const articlePath = "site-content/writing/dependency-inversion/index.mdx";
  const articleAssetPath = "site-content/writing/dependency-inversion/assets/flow-diagram.svg";
  const projectAssetPath = "site-content/projects/docrestore/assets/architecture.svg";

  assert.equal(expectSuccess(normalizeContentPath(projectPath)), projectPath);
  assert.deepEqual(expectSuccess(classify(projectPath)), {
    kind: "project",
    sourcePath: projectPath,
    projectId: "docrestore",
    extension: ".md",
  });
  assert.deepEqual(expectSuccess(classify(articlePath)), {
    kind: "article",
    sourcePath: articlePath,
    sourceName: "dependency-inversion",
    extension: ".mdx",
  });
  assert.deepEqual(expectSuccess(classify(articleAssetPath)), {
    kind: "other",
    sourcePath: articleAssetPath,
  });
  assert.deepEqual(expectSuccess(classify(projectAssetPath)), {
    kind: "other",
    sourcePath: projectAssetPath,
  });
});

test("I-06 路径规范化拒绝绝对、反斜杠、空段、点段、控制字符与大小写漂移", () => {
  const invalidPaths = [
    "/site-content/writing/example/index.md",
    "C:/site-content/writing/example/index.md",
    "site-content\\writing\\example\\index.md",
    "site-content/writing//index.md",
    "site-content/writing/example/",
    "site-content/./writing/example/index.md",
    "site-content/writing/../example/index.md",
    "site-content/writing/example/index.\u0000md",
    "site-content/writing/example/index.\u0085md",
    "site-content/writing/example/index.\u2028md",
    "site-content/writing/example/index.\u2029md",
    "Site-content/writing/example/index.md",
  ];

  for (const sourcePath of invalidPaths) {
    const result = normalizeContentPath(sourcePath);
    expectFailure(result, ["CONTENT_PATH_INVALID"]);
    if (!result.ok) {
      assert.equal(result.issues[0]?.sourcePath, "site-content");
      assert.equal(result.issues[0]?.fieldPath, "sourcePath");
    }
  }
});

test("I-06 writing 布局拒绝根级、嵌套、非 index、额外 Markdown 与大小写漂移", () => {
  const invalidArticlePaths = [
    "site-content/writing/index.md",
    "site-content/writing/dependency-inversion/readme.md",
    "site-content/writing/guides/dependency-inversion/index.md",
    "site-content/writing/dependency-inversion/assets/notes.md",
    "site-content/writing/Dependency-Inversion/index.md",
    "site-content/writing/dependency-inversion/index.MD",
  ];

  for (const sourcePath of invalidArticlePaths) {
    expectFailure(classify(sourcePath), ["CONTENT_ARTICLE_PATH_LAYOUT"]);
  }
});

test("I-06 projects 布局拒绝根级、嵌套、非 index、额外 Markdown 与大小写漂移", () => {
  const invalidProjectPaths = [
    "site-content/projects/index.mdx",
    "site-content/projects/docrestore/readme.mdx",
    "site-content/projects/archive/docrestore/index.mdx",
    "site-content/projects/docrestore/assets/notes.mdx",
    "site-content/projects/DocRestore/index.mdx",
    "site-content/projects/docrestore/index.MDX",
  ];

  for (const sourcePath of invalidProjectPaths) {
    expectFailure(classify(sourcePath), ["CONTENT_PROJECT_PATH_LAYOUT"]);
  }
});

test("I-06 符号链接与 realpath 包含事实分别失败且不得返回分类", () => {
  const sourcePath = "site-content/writing/dependency-inversion/index.md";

  expectFailure(
    classify(sourcePath, {isSymbolicLink: true}),
    ["CONTENT_PATH_SYMBOLIC_LINK"],
  );
  expectFailure(
    classify(sourcePath, {isRealPathWithinRoot: false}),
    ["CONTENT_PATH_REALPATH_ESCAPE"],
  );
  expectFailure(
    classify(sourcePath, {
      isSymbolicLink: true,
      isRealPathWithinRoot: false,
    }),
    ["CONTENT_PATH_REALPATH_ESCAPE", "CONTENT_PATH_SYMBOLIC_LINK"],
  );
});

test("I-06 多重路径错误按稳定键排序并深冻结成功与失败结果", () => {
  const input = Object.freeze({
    sourcePath: "/site-content/writing/dependency-inversion/index.md",
    isSymbolicLink: true,
    isRealPathWithinRoot: false,
  });
  const first = classifyContentPath(input);
  const second = classifyContentPath(input);

  assert.deepEqual(first, second);
  expectFailure(first, [
    "CONTENT_PATH_REALPATH_ESCAPE",
    "CONTENT_PATH_SYMBOLIC_LINK",
    "CONTENT_PATH_INVALID",
  ]);
  assert.ok(Object.isFrozen(first));
  if (!first.ok) {
    assert.ok(Object.isFrozen(first.issues));
    assert.ok(first.issues.every((issue) => Object.isFrozen(issue)));
    assert.deepEqual(
      first.issues.map(({sourcePath, fieldPath, code}) => ({
        sourcePath,
        fieldPath,
        code,
      })),
      [
        {
          sourcePath: "site-content",
          fieldPath: undefined,
          code: "CONTENT_PATH_REALPATH_ESCAPE",
        },
        {
          sourcePath: "site-content",
          fieldPath: undefined,
          code: "CONTENT_PATH_SYMBOLIC_LINK",
        },
        {
          sourcePath: "site-content",
          fieldPath: "sourcePath",
          code: "CONTENT_PATH_INVALID",
        },
      ],
    );
  }

  const successful = classify("site-content/projects/docrestore/index.mdx");
  assert.ok(Object.isFrozen(successful));
  if (successful.ok) {
    assert.ok(Object.isFrozen(successful.value));
  }
});

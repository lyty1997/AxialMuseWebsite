import type {
  ContentPathClassification,
  ContentPathInput,
  ValidationResult,
} from "./types.js";
import {
  failure,
  isKebabId,
  IssueCollector,
  success,
} from "./validation.js";

const CONTENT_ROOT = "site-content";
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export function normalizeContentPath(sourcePath: string): ValidationResult<string> {
  const collector = new IssueCollector();
  const isWindowsAbsolute = /^[A-Za-z]:\//u.test(sourcePath);
  const segments = typeof sourcePath === "string" ? sourcePath.split("/") : [];
  const isValid = typeof sourcePath === "string"
    && sourcePath.length > 0
    && !sourcePath.startsWith("/")
    && !isWindowsAbsolute
    && !sourcePath.includes("\\")
    && !CONTROL_PATTERN.test(sourcePath)
    && segments.length >= 2
    && segments[0] === CONTENT_ROOT
    && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");

  if (!isValid) {
    collector.add(
      "CONTENT_PATH_INVALID",
      CONTENT_ROOT,
      "sourcePath",
      "内容路径必须是 site-content 下的仓库相对 POSIX 路径。",
    );
    return failure(collector);
  }
  return success(sourcePath);
}

function isMarkdownCandidate(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdx");
}

export function classifyContentPath(
  input: ContentPathInput,
): ValidationResult<ContentPathClassification> {
  const collector = new IssueCollector();
  const normalized = normalizeContentPath(input.sourcePath);
  if (!normalized.ok) collector.merge(normalized.issues);
  const diagnosticPath = normalized.ok ? normalized.value : CONTENT_ROOT;

  if (input.isSymbolicLink !== false) {
    collector.add(
      "CONTENT_PATH_SYMBOLIC_LINK",
      diagnosticPath,
      undefined,
      "site-content 内不允许符号链接。",
    );
  }
  if (input.isRealPathWithinRoot !== true) {
    collector.add(
      "CONTENT_PATH_REALPATH_ESCAPE",
      diagnosticPath,
      undefined,
      "内容真实路径未被证明位于 site-content 根内。",
    );
  }
  if (!normalized.ok) return failure(collector);

  const sourcePath = normalized.value;
  const segments = sourcePath.split("/");
  const section = segments[1];
  const fileName = segments.at(-1) ?? "";
  if (section !== "projects" && section !== "writing") {
    return collector.hasIssues()
      ? failure(collector)
      : success({kind: "other", sourcePath});
  }

  if (!isMarkdownCandidate(fileName)) {
    return collector.hasIssues()
      ? failure(collector)
      : success({kind: "other", sourcePath});
  }

  const isExactExtension = fileName === "index.md" || fileName === "index.mdx";
  const identity = segments[2];
  if (segments.length !== 4 || !isExactExtension || !isKebabId(identity)) {
    collector.add(
      section === "writing"
        ? "CONTENT_ARTICLE_PATH_LAYOUT"
        : "CONTENT_PROJECT_PATH_LAYOUT",
      sourcePath,
      undefined,
      section === "writing"
        ? "文章必须位于 writing/<source-name>/index.md|index.mdx。"
        : "项目正文必须位于 projects/<project-id>/index.md|index.mdx。",
    );
    return failure(collector);
  }

  if (collector.hasIssues()) return failure(collector);
  const extension = fileName === "index.md" ? ".md" : ".mdx";
  return section === "writing"
    ? success({kind: "article", sourcePath, sourceName: identity, extension})
    : success({kind: "project", sourcePath, projectId: identity, extension});
}

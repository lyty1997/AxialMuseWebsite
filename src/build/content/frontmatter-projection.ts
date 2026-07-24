import type {ParseFrontMatter} from "@docusaurus/types";
import {decodeFrontMatter} from "./content-decoders.js";
import {failContentBuild} from "./errors.js";
import {
  assertLoadedContentSourceCurrent,
  assertLoadedValidatedContent,
} from "./loader.js";
import type {ContentSourceSnapshot, LoadedValidatedContent} from "./types.js";

function structuredEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => structuredEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left as Record<string, unknown>).sort();
  const rightKeys = Object.keys(right as Record<string, unknown>).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index]
      && structuredEqual(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      )
    ));
}

function projectProject(
  content: LoadedValidatedContent,
  source: ContentSourceSnapshot,
): Record<string, unknown> {
  const project = content.catalog.projects.find((entry) => entry.id === source.projectId);
  if (project === undefined) {
    failContentBuild("CONTENT_PROJECTION_PROJECT", "项目正文无法关联唯一注册表项目。", {
      sourcePath: source.sourcePath,
    });
  }
  return {
    title: project.title,
    description: project.summary,
    slug: `/projects/${project.slug}`,
    ...(["draft", "planned"].includes(project.publicationStatus)
      ? {draft: true}
      : {}),
  };
}

function projectArticle(
  content: LoadedValidatedContent,
  source: ContentSourceSnapshot,
): Record<string, unknown> {
  const article = content.articles.find((entry) => entry.sourcePath === source.sourcePath);
  if (article === undefined) {
    failContentBuild("CONTENT_PROJECTION_ARTICLE", "文章正文无法关联唯一领域文章。", {
      sourcePath: source.sourcePath,
    });
  }
  return {
    ...source.frontMatter,
    description: article.summary,
    ...(article.publicationStatus === "draft" ? {draft: true} : {}),
  };
}

export function createParseFrontMatter(
  content: LoadedValidatedContent,
): ParseFrontMatter {
  assertLoadedValidatedContent(content);
  const byAbsolutePath = new Map(content.sources.map((source) => [source.absolutePath, source]));
  return async ({filePath, fileContent, defaultParseFrontMatter}) => {
    const source = byAbsolutePath.get(filePath);
    if (source === undefined) {
      failContentBuild("CONTENT_PROJECTION_SNAPSHOT", "框架解析输入不属于预扫描内容快照。", {
        sourcePath: "site-content",
      });
    }
    assertLoadedContentSourceCurrent(content, source.sourcePath);
    if (typeof defaultParseFrontMatter !== "function") {
      failContentBuild("CONTENT_PROJECTION_PARSER", "Docusaurus 默认解析器不可用。", {
        sourcePath: source.sourcePath,
      });
    }
    if (fileContent !== source.fileContent) {
      failContentBuild("CONTENT_PROJECTION_SNAPSHOT", "框架解析输入不属于预扫描内容快照。", {
        sourcePath: source.sourcePath,
      });
    }
    let decoded: Awaited<ReturnType<typeof decodeFrontMatter>>;
    try {
      decoded = await decodeFrontMatter({
        filePath,
        fileContent,
        sourcePath: source.sourcePath,
        parser: defaultParseFrontMatter,
      });
    } finally {
      assertLoadedContentSourceCurrent(content, source.sourcePath);
    }
    if (
      decoded.content !== source.content
      || !structuredEqual(decoded.frontMatter, source.frontMatter)
    ) {
      failContentBuild("CONTENT_PROJECTION_PARSE_DRIFT", "框架解析结果与预扫描结构化快照漂移。", {
        sourcePath: source.sourcePath,
      });
    }
    return {
      frontMatter: source.kind === "project"
        ? projectProject(content, source)
        : projectArticle(content, source),
      content: decoded.content,
    };
  };
}

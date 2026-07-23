import type {PluginOptions} from "@docusaurus/plugin-content-docs";
import type {
  DraftArticleNavigationItem,
  ModuleWritingGroup,
  ProjectWritingGroup,
  PublicArticleNavigationItem,
  WritingNavigationGroup,
} from "../../domain/content/index.js";
import {failContentBuild} from "./errors.js";
import {
  assertLoadedContentFilesCurrent,
  assertLoadedValidatedContent,
} from "./loader.js";
import type {LoadedValidatedContent} from "./types.js";

type SidebarItemsGeneratorOption = NonNullable<PluginOptions["sidebarItemsGenerator"]>;
type SidebarItemsGeneratorArguments = Parameters<SidebarItemsGeneratorOption>[0];
type SidebarItemsGeneratorDoc = SidebarItemsGeneratorArguments["docs"][number];
type NormalizedSidebar = Awaited<ReturnType<SidebarItemsGeneratorOption>>;

function sourcePathFromAlias(source: string): string | undefined {
  return source.startsWith("@site/site-content/") ? source.slice("@site/".length) : undefined;
}

function docItem(
  item: PublicArticleNavigationItem | DraftArticleNavigationItem,
  docsBySource: ReadonlyMap<string, SidebarItemsGeneratorDoc>,
): NormalizedSidebar[number] {
  const doc = docsBySource.get(item.sourcePath);
  if (doc === undefined) {
    failContentBuild("CONTENT_SIDEBAR_DOC_MISSING", "导航条目缺少当前框架 doc。", {
      sourcePath: item.sourcePath,
    });
  }
  return {
    type: "doc",
    id: doc.id,
    ...(item.publicationStatus === "archived" ? {label: `${item.title}（归档）`} : {}),
  };
}

function category(
  label: string,
  items: NormalizedSidebar,
): NormalizedSidebar[number] {
  return {
    type: "category",
    label,
    collapsed: false,
    collapsible: true,
    items,
  };
}

function moduleCategory(
  group: ModuleWritingGroup,
  docsBySource: ReadonlyMap<string, SidebarItemsGeneratorDoc>,
): NormalizedSidebar[number] {
  return category(
    group.label,
    group.articles.map((article) => docItem(article, docsBySource)),
  );
}

function projectWritingCategory(
  group: ProjectWritingGroup,
  docsBySource: ReadonlyMap<string, SidebarItemsGeneratorDoc>,
): NormalizedSidebar[number] {
  const items: NormalizedSidebar = [
    ...group.rootArticles.map((article) => docItem(article, docsBySource)),
    ...group.modules.map((module) => moduleCategory(module, docsBySource)),
  ];
  return category(group.label, items);
}

function buildWritingSidebar(
  groups: readonly WritingNavigationGroup[],
  docsBySource: ReadonlyMap<string, SidebarItemsGeneratorDoc>,
): NormalizedSidebar {
  return groups.map((group) => {
    if (group.kind === "general") {
      return category(
        group.label,
        group.articles.map((article) => docItem(article, docsBySource)),
      );
    }
    if (group.kind === "project") return projectWritingCategory(group, docsBySource);
    return category(
      group.label,
      group.articles.map((article) => docItem(article, docsBySource)),
    );
  });
}

function expectedVisibleSources(content: LoadedValidatedContent): ReadonlySet<string> {
  if (content.mode === "preview") {
    return new Set(content.sources.map((source) => source.sourcePath));
  }
  const projects = new Set(content.projectNavigation.map((item) => item.sourcePath));
  const articles = content.articles
    .filter((article) => article.publicationStatus !== "draft")
    .map((article) => article.sourcePath);
  return new Set([...projects, ...articles]);
}

function bindFrameworkDocs(
  content: LoadedValidatedContent,
  docs: readonly SidebarItemsGeneratorDoc[],
): ReadonlyMap<string, SidebarItemsGeneratorDoc> {
  const expected = expectedVisibleSources(content);
  const bySource = new Map<string, SidebarItemsGeneratorDoc>();
  const ids = new Set<string>();
  try {
    for (const doc of docs) {
      if (
        doc === null
        || typeof doc !== "object"
        || typeof doc.id !== "string"
        || doc.id.length === 0
        || typeof doc.source !== "string"
      ) {
        failContentBuild("CONTENT_SIDEBAR_DOC_SHAPE", "Docusaurus sidebar doc 结构不合法。", {
          sourcePath: "site-content",
        });
      }
      const sourcePath = sourcePathFromAlias(doc.source);
      if (
        sourcePath === undefined
        || !expected.has(sourcePath)
        || bySource.has(sourcePath)
        || ids.has(doc.id)
      ) {
        failContentBuild("CONTENT_SIDEBAR_DOC_OWNERSHIP", "框架 docs 与已验证内容不能一一对应。", {
          sourcePath: sourcePath ?? "site-content",
        });
      }
      bySource.set(sourcePath, doc);
      ids.add(doc.id);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "ContentBuildError") throw error;
    failContentBuild("CONTENT_SIDEBAR_DOC_SHAPE", "Docusaurus sidebar docs 无法安全读取。", {
      cause: error,
      sourcePath: "site-content",
    });
  }
  if (bySource.size !== expected.size || [...expected].some((source) => !bySource.has(source))) {
    failContentBuild("CONTENT_SIDEBAR_DOC_SET", "框架 docs 集合与可见内容集合不闭合。", {
      sourcePath: "site-content",
    });
  }
  return bySource;
}

export function createSidebarItemsGenerator(
  content: LoadedValidatedContent,
): SidebarItemsGeneratorOption {
  assertLoadedValidatedContent(content);
  return async (input) => {
    assertLoadedContentFilesCurrent(content);
    const {item, version, docs, categoriesMetadata} = input;
    if (
      version.versionName !== "current"
      || version.contentPath !== `${content.repositoryRoot}/site-content`
      || Object.keys(categoriesMetadata).length !== 0
    ) {
      failContentBuild("CONTENT_SIDEBAR_VERSION", "侧栏只接受 current 非版本化内容与空分类 metadata。", {
        sourcePath: "site-content",
      });
    }
    const docsBySource = bindFrameworkDocs(content, docs);
    if (item.dirName === "projects") {
      return content.projectNavigation.map((project) => {
        const doc = docsBySource.get(project.sourcePath);
        if (doc === undefined) {
          failContentBuild("CONTENT_SIDEBAR_DOC_MISSING", "项目侧栏缺少当前框架 doc。", {
            sourcePath: project.sourcePath,
          });
        }
        return {
          type: "doc" as const,
          id: doc.id,
          ...(project.publicationStatus === "archived"
            ? {label: `${project.title}（归档）`}
            : {}),
        };
      });
    }
    if (item.dirName === "writing") {
      return buildWritingSidebar(content.writingNavigation, docsBySource);
    }
    failContentBuild("CONTENT_SIDEBAR_SLICE", "未知 autogenerated sidebar slice。", {
      sourcePath: "sidebars.ts",
    });
  };
}

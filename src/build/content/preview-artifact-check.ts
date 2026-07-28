import {resolve} from "node:path";
import {
  scanBuildTree,
} from "../static-assets/file-safety.js";
import type {
  BuildFileEvidence,
} from "../static-assets/file-safety.js";
import type {StaticAssetPlan} from "../static-assets/index.js";
import {failContentBuild} from "./errors.js";
import {
  activeHtmlMarkup,
  assertCanonical,
  assertPrivateDateIndex,
  expectedPageRoutes,
  extractSidebarLinks,
  hasPrivateDateIndexSignature,
  htmlAttributes,
  readStableTextFile,
  routeFromHtmlPath,
  sameTreeEvidence,
  visibleHtmlSemanticText,
} from "./production-artifact-check.js";
import type {LoadedValidatedContent} from "./types.js";

const TEXT_ARTIFACT_SUFFIXES = Object.freeze([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".xml",
]);

function canonicalRoute(value: string): string {
  return value === "/" || value.endsWith("/") ? value : `${value}/`;
}

function expectedPreviewRoutes(content: LoadedValidatedContent): readonly string[] {
  const routes = new Set(expectedPageRoutes(content.repositoryRoot));
  for (const source of content.sources) {
    if (source.kind !== "project") continue;
    const project = content.catalog.projects.find((entry) => entry.id === source.projectId);
    if (project === undefined) {
      failContentBuild("CONTENT_PREVIEW_ROUTE_MODEL", "preview 项目正文缺少唯一注册表路由。", {
        sourcePath: source.sourcePath,
      });
    }
    routes.add(`/projects/${project.slug}/`);
  }
  for (const article of content.articles) routes.add(canonicalRoute(article.slug));
  return Object.freeze([...routes].sort());
}

function navigationLabel(
  item: Readonly<{title: string; publicationStatus: string}>,
): string {
  if (item.publicationStatus === "archived") return `${item.title}（归档）`;
  return item.title;
}

function projectNavigationLabel(
  item: Readonly<{title: string; publicationStatus: string}>,
): string {
  if (item.publicationStatus === "archived") return `${item.title}（归档）`;
  if (item.publicationStatus === "draft") return `${item.title}（草稿）`;
  if (item.publicationStatus === "planned") return `${item.title}（计划）`;
  return item.title;
}

function expectedProjectSidebar(
  content: LoadedValidatedContent,
): readonly Readonly<{href: string; label: string}>[] {
  return Object.freeze(content.projectNavigation.map((item) => Object.freeze({
    href: item.canonicalPath,
    label: projectNavigationLabel(item),
  })));
}

function expectedWritingSidebar(
  content: LoadedValidatedContent,
): readonly Readonly<{href: string; label: string}>[] {
  const links: Array<Readonly<{href: string; label: string}>> = [];
  for (const group of content.writingNavigation) {
    if (group.kind === "general" || group.kind === "draft") {
      links.push(...group.articles.map((item) => Object.freeze({
        href: item.canonicalPath,
        label: navigationLabel(item),
      })));
      continue;
    }
    links.push(...group.rootArticles.map((item) => Object.freeze({
      href: item.canonicalPath,
      label: navigationLabel(item),
    })));
    for (const module of group.modules) {
      links.push(...module.articles.map((item) => Object.freeze({
        href: item.canonicalPath,
        label: navigationLabel(item),
      })));
    }
  }
  return Object.freeze(links);
}

function assertSidebar(
  html: string,
  expected: readonly Readonly<{href: string; label: string}>[],
  sourcePath: string,
): void {
  if (expected.length === 0) return;
  const actual = extractSidebarLinks(html, sourcePath);
  if (
    actual.length !== expected.length
    || actual.some((link, index) => {
      const candidate = expected[index];
      return candidate === undefined
        || candidate.href !== link.href
        || candidate.label !== link.label;
    })
  ) {
    failContentBuild(
      "CONTENT_PREVIEW_SIDEBAR_SET",
      "preview 文档侧栏与含草稿的唯一导航投影不一致。",
      {sourcePath},
    );
  }
}

export function assertPreviewIndexing(html: string, sourcePath: string): void {
  const metas = [...html.matchAll(/<meta(?=[\t\n\f\r />])[^>]*>/giu)]
    .map((match) => htmlAttributes(match[0], sourcePath))
    .filter((attributes) => (
      (attributes.get("name") ?? "").toLowerCase() === "robots"
    ));
  const directives = metas.length === 1
    ? (metas[0]?.get("content") ?? "")
      .toLowerCase()
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "")
      .sort()
    : [];
  if (
    metas.length !== 1
    || directives.length !== 2
    || directives[0] !== "nofollow"
    || directives[1] !== "noindex"
  ) {
    failContentBuild(
      "CONTENT_PREVIEW_NOINDEX",
      "preview 每个 HTML 必须恰有一条 noindex, nofollow robots 指令。",
      {sourcePath},
    );
  }
}

function isTextArtifact(path: string): boolean {
  const lower = path.toLowerCase();
  return TEXT_ARTIFACT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function forbiddenAccessValues(environment: NodeJS.ProcessEnv): readonly string[] {
  const host = environment.AXIAL_MUSE_PREVIEW_ACCESS_HOST;
  const port = environment.AXIAL_MUSE_PREVIEW_ACCESS_PORT;
  if (
    typeof host !== "string"
    || !/^[A-Za-z0-9.-]+$/u.test(host)
    || typeof port !== "string"
    || !/^[1-9][0-9]{0,4}$/u.test(port)
    || Number(port) > 65_535
  ) {
    failContentBuild("CONTENT_PREVIEW_ACCESS_ENV", "preview 访问 host/port 证据不完整。", {
      sourcePath: "build",
    });
  }
  const values = new Set([
    host,
    port,
    `${host}:${port}`,
    `http://${host}`,
    `https://${host}`,
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  return Object.freeze([...values]);
}

function readArtifactText(
  buildDirectory: string,
  file: BuildFileEvidence,
): string {
  return readStableTextFile(
    resolve(buildDirectory, file.relativePath),
    `build/${file.relativePath}`,
    file,
  );
}

export function assertPreviewArtifact(
  content: LoadedValidatedContent,
  staticPlan: StaticAssetPlan,
  buildDirectory: string,
  generatedFilesDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (content.mode !== "preview") {
    failContentBuild("CONTENT_PREVIEW_MODE", "preview checker 只接受 preview 内容投影。", {
      sourcePath: "build",
    });
  }
  const privateIndexEvidence = assertPrivateDateIndex(
    content,
    generatedFilesDirectory,
  );
  staticPlan.assertPreviewBuild(buildDirectory);
  const evidence = scanBuildTree(buildDirectory, [], [], []);
  const sitemap = evidence.files.find((file) => (
    /(?:^|\/)sitemap(?:[-_.][^/]*)?(?:\.xml(?:\.gz)?|\.txt)?$/u.test(
      file.relativePath.toLowerCase(),
    )
  ));
  if (sitemap !== undefined) {
    failContentBuild("CONTENT_PREVIEW_SITEMAP", "preview 制品不得生成 sitemap。", {
      sourcePath: `build/${sitemap.relativePath}`,
    });
  }
  if (evidence.files.some((file) => {
    const lower = file.relativePath.toLowerCase();
    return (lower.endsWith(".html") && !file.relativePath.endsWith(".html"))
      || lower.endsWith(".htm")
      || lower.endsWith(".xhtml");
  })) {
    failContentBuild("CONTENT_PREVIEW_ROUTE_SET", "preview 制品含不受控的 HTML 后缀。", {
      sourcePath: "build",
    });
  }

  const forbidden = forbiddenAccessValues(environment);
  for (const file of evidence.files.filter((candidate) => isTextArtifact(candidate.relativePath))) {
    const text = readArtifactText(buildDirectory, file);
    if (forbidden.some((value) => text.includes(value))) {
      failContentBuild(
        "CONTENT_PREVIEW_ACCESS_LEAK",
        "preview 制品写入了仅属于局域网访问配置的 host 或 port。",
        {sourcePath: `build/${file.relativePath}`},
      );
    }
    if (hasPrivateDateIndexSignature(text, content)) {
      failContentBuild(
        "CONTENT_ARTIFACT_PRIVATE_INDEX",
        "私有日期索引结构进入 preview Web Root。",
        {sourcePath: `build/${file.relativePath}`},
      );
    }
  }

  const expectedRoutes = expectedPreviewRoutes(content);
  const expectedRouteSet = new Set(expectedRoutes);
  const projectRoutes = new Set(content.sources
    .filter((source) => source.kind === "project")
    .map((source) => {
      const project = content.catalog.projects.find((entry) => entry.id === source.projectId);
      return project === undefined ? "" : `/projects/${project.slug}/`;
    })
    .filter((route) => route !== ""));
  const writingRoutes = new Set(content.articles.map((article) => canonicalRoute(article.slug)));
  const projectSidebar = expectedProjectSidebar(content);
  const writingSidebar = expectedWritingSidebar(content);
  const draftGroup = content.writingNavigation.find((group) => group.kind === "draft");
  const actualRoutes: string[] = [];
  for (const file of evidence.files.filter((candidate) => candidate.relativePath.endsWith(".html"))) {
    const sourcePath = `build/${file.relativePath}`;
    const activeHtml = activeHtmlMarkup(
      readArtifactText(buildDirectory, file),
      sourcePath,
    );
    assertPreviewIndexing(activeHtml, sourcePath);
    const route = routeFromHtmlPath(file.relativePath);
    if (route === undefined) continue;
    actualRoutes.push(route);
    if (!expectedRouteSet.has(route)) continue;
    assertCanonical(activeHtml, route, sourcePath);
    if (projectRoutes.has(route)) assertSidebar(activeHtml, projectSidebar, sourcePath);
    if (writingRoutes.has(route)) {
      assertSidebar(activeHtml, writingSidebar, sourcePath);
      if (
        draftGroup !== undefined
        && !visibleHtmlSemanticText(activeHtml).includes("草稿")
      ) {
        failContentBuild(
          "CONTENT_PREVIEW_DRAFT_GROUP",
          "preview 技术文章详情缺少可见的草稿侧栏组。",
          {sourcePath},
        );
      }
    }
  }
  actualRoutes.sort();
  if (
    actualRoutes.length !== expectedRoutes.length
    || actualRoutes.some((route, index) => route !== expectedRoutes[index])
  ) {
    failContentBuild(
      "CONTENT_PREVIEW_ROUTE_SET",
      "preview HTML 路由集合与含草稿的唯一内容投影不一致。",
      {sourcePath: "build"},
    );
  }
  staticPlan.assertPreviewBuild(buildDirectory);
  const finalEvidence = scanBuildTree(buildDirectory, [], [], []);
  if (!sameTreeEvidence(evidence, finalEvidence)) {
    failContentBuild("CONTENT_PREVIEW_DRIFT", "preview 制品在检查期间发生漂移。", {
      sourcePath: "build",
    });
  }
  assertPrivateDateIndex(content, generatedFilesDirectory, privateIndexEvidence);
}

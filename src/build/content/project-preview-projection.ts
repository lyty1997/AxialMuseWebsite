import type {Project, PreviewImage} from "../../domain/content/index.js";
import type {StaticAssetManifestFile} from "../static-assets/index.js";
import {failContentBuild} from "./errors.js";
import {
  assertLoadedContentSourceCurrent,
  assertLoadedValidatedContent,
} from "./loader.js";
import {
  assertContentBuildSession,
} from "./session.js";
import type {ContentBuildSession} from "./session.js";
import type {
  ContentSourceSnapshot,
  LoadedValidatedContent,
} from "./types.js";

interface ProjectPreviewBinding {
  readonly preview: PreviewImage;
  readonly publicUrl: string;
}

interface MdxJsxAttribute {
  readonly type: "mdxJsxAttribute";
  readonly name: "src" | "alt" | "width" | "height";
  readonly value: string;
}

interface MdxJsxImageNode {
  readonly type: "mdxJsxFlowElement";
  readonly name: "img";
  readonly attributes: readonly MdxJsxAttribute[];
  readonly children: readonly [];
}

interface MarkdownRoot {
  readonly type: "root";
  readonly children: unknown[];
}

interface VFileLike {
  readonly path?: unknown;
}

export type ProjectPreviewRemarkTransformer = (
  tree: unknown,
  file: unknown,
) => void;

export type ProjectPreviewRemarkPlugin = () => ProjectPreviewRemarkTransformer;

function isPublicProject(project: Project): boolean {
  return project.publicationStatus === "published"
    || project.publicationStatus === "archived";
}

function expectedPreviewProjects(
  content: LoadedValidatedContent,
): readonly Project[] {
  return content.catalog.projects.filter((project) => (
    project.previewImage !== undefined
    && (content.mode === "preview" || isPublicProject(project))
  ));
}

function projectSources(
  content: LoadedValidatedContent,
): ReadonlyMap<string, ContentSourceSnapshot> {
  const sources = new Map<string, ContentSourceSnapshot>();
  for (const source of content.sources) {
    if (source.kind !== "project") continue;
    if (source.projectId === undefined || sources.has(source.projectId)) {
      failContentBuild(
        "CONTENT_PROJECT_PREVIEW_SOURCE",
        "项目主预览投影要求每个项目只绑定一个已验证正文来源。",
        {sourcePath: source.sourcePath},
      );
    }
    sources.set(source.projectId, source);
  }
  for (const projectSource of content.catalog.projectSources) {
    const source = sources.get(projectSource.projectId);
    if (
      source === undefined
      || source.sourcePath !== projectSource.sourcePath
    ) {
      failContentBuild(
        "CONTENT_PROJECT_PREVIEW_SOURCE",
        "项目目录正文与同批内容来源不能一一对应。",
        {sourcePath: "site-content/projects"},
      );
    }
  }
  if (sources.size !== content.catalog.projectSources.length) {
    failContentBuild(
      "CONTENT_PROJECT_PREVIEW_SOURCE",
      "项目主预览投影缺少已验证的唯一项目正文来源。",
      {sourcePath: "site-content/projects"},
    );
  }
  return sources;
}

function previewManifestFiles(
  session: ContentBuildSession,
): ReadonlyMap<string, StaticAssetManifestFile & Readonly<{kind: "project-preview"}>> {
  const {content, staticPlan} = session;
  if (staticPlan.manifest.mode !== content.mode) {
    failContentBuild(
      "CONTENT_PROJECT_PREVIEW_MANIFEST",
      "项目主预览投影与静态素材计划的构建模式不一致。",
      {sourcePath: "site-assets"},
    );
  }
  const files = new Map<
    string,
    StaticAssetManifestFile & Readonly<{kind: "project-preview"}>
  >();
  for (const file of staticPlan.manifest.files) {
    if (file.kind !== "project-preview") continue;
    if (files.has(file.projectId)) {
      failContentBuild(
        "CONTENT_PROJECT_PREVIEW_MANIFEST",
        "同一项目存在第二份主预览公开投影。",
        {sourcePath: "site-assets"},
      );
    }
    files.set(file.projectId, file);
  }
  return files;
}

function createBindings(
  session: ContentBuildSession,
): ReadonlyMap<string, ProjectPreviewBinding> {
  const {content} = session;
  assertLoadedValidatedContent(content);
  const sources = projectSources(content);
  const manifests = previewManifestFiles(session);
  const expectedProjects = expectedPreviewProjects(content);
  const expectedIds = new Set(expectedProjects.map((project) => project.id));
  if (
    manifests.size !== expectedIds.size
    || [...manifests.keys()].some((projectId) => !expectedIds.has(projectId))
  ) {
    failContentBuild(
      "CONTENT_PROJECT_PREVIEW_MANIFEST",
      "静态素材计划中的项目主预览集合与当前可见内容不一致。",
      {sourcePath: "site-assets"},
    );
  }

  const bindings = new Map<string, ProjectPreviewBinding>();
  for (const project of expectedProjects) {
    const preview = project.previewImage;
    const source = sources.get(project.id);
    const manifest = manifests.get(project.id);
    if (preview === undefined || manifest === undefined) {
      failContentBuild(
        "CONTENT_PROJECT_PREVIEW_MANIFEST",
        "可见项目缺少同批已验证的主预览公开投影。",
        {sourcePath: "site-assets"},
      );
    }
    const expectedSourcePath = `site-assets/${preview.sourcePath}`;
    const expectedTargetPath = `assets/${preview.sourcePath}`;
    const expectedPublicUrl = `/${expectedTargetPath}`;
    if (
      manifest.sourcePath !== expectedSourcePath
      || manifest.targetPath !== expectedTargetPath
      || manifest.publicUrl !== expectedPublicUrl
    ) {
      failContentBuild(
        "CONTENT_PROJECT_PREVIEW_OWNER",
        "项目主预览公开路径没有唯一绑定当前项目的已验证登记。",
        {sourcePath: source?.sourcePath ?? "docs/contracts/projects.json"},
      );
    }
    if (source === undefined) {
      if (content.mode === "production" && isPublicProject(project)) {
        failContentBuild(
          "CONTENT_PROJECT_PREVIEW_SOURCE",
          "公开项目主预览缺少已验证的唯一详情正文来源。",
          {sourcePath: "site-content/projects"},
        );
      }
      continue;
    }
    if (bindings.has(source.absolutePath)) {
      failContentBuild(
        "CONTENT_PROJECT_PREVIEW_SOURCE",
        "第二个项目主预览试图复用同一正文来源。",
        {sourcePath: source.sourcePath},
      );
    }
    bindings.set(source.absolutePath, Object.freeze({
      preview,
      publicUrl: manifest.publicUrl,
    }));
  }
  return bindings;
}

function readMarkdownRoot(value: unknown): MarkdownRoot {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (value as {type?: unknown}).type !== "root"
    || !Array.isArray((value as {children?: unknown}).children)
  ) {
    failContentBuild(
      "CONTENT_PROJECT_PREVIEW_AST",
      "项目主预览只能注入 Docusaurus 提供的 Markdown root。",
      {sourcePath: "site-content"},
    );
  }
  return value as MarkdownRoot;
}

function readVFilePath(value: unknown): string {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("vfile is not an object");
    }
    const first = (value as VFileLike).path;
    const second = (value as VFileLike).path;
    if (typeof first !== "string" || first === "" || first !== second) {
      throw new TypeError("vfile path is not a stable string");
    }
    return first;
  } catch (error) {
    failContentBuild(
      "CONTENT_PROJECT_PREVIEW_DOC_SOURCE",
      "Markdown 编译输入缺少稳定的已验证正文路径。",
      {cause: error, sourcePath: "site-content"},
    );
  }
}

function imageNode(binding: ProjectPreviewBinding): MdxJsxImageNode {
  return {
    type: "mdxJsxFlowElement",
    name: "img",
    attributes: [
      {type: "mdxJsxAttribute", name: "src", value: binding.publicUrl},
      {type: "mdxJsxAttribute", name: "alt", value: binding.preview.alt},
      {type: "mdxJsxAttribute", name: "width", value: String(binding.preview.width)},
      {type: "mdxJsxAttribute", name: "height", value: String(binding.preview.height)},
    ],
    children: [],
  };
}

function createProjectPreviewRemarkPluginModule(
  session: ContentBuildSession,
): ProjectPreviewRemarkPlugin {
  const sourcesByAbsolutePath = new Map(
    session.content.sources.map((source) => [source.absolutePath, source]),
  );
  const bindings = createBindings(session);
  const transformedRoots = new WeakSet<object>();
  return function projectPreviewRemarkPlugin() {
    return (tree, file) => {
      const root = readMarkdownRoot(tree);
      if (transformedRoots.has(root)) {
        failContentBuild(
          "CONTENT_PROJECT_PREVIEW_AST",
          "同一 Markdown tree 不得重复注入项目主预览。",
          {sourcePath: "site-content"},
        );
      }
      transformedRoots.add(root);
      const absolutePath = readVFilePath(file);
      const source = sourcesByAbsolutePath.get(absolutePath);
      if (source === undefined) {
        failContentBuild(
          "CONTENT_PROJECT_PREVIEW_DOC_SOURCE",
          "Markdown 编译输入不属于当前已验证内容批次。",
          {sourcePath: "site-content"},
        );
      }
      assertLoadedContentSourceCurrent(session.content, source.sourcePath);
      const binding = bindings.get(absolutePath);
      if (binding !== undefined) root.children.unshift(imageNode(binding));
      assertLoadedContentSourceCurrent(session.content, source.sourcePath);
    };
  };
}

export function createProjectPreviewRemarkPlugin(
  session: ContentBuildSession,
): ProjectPreviewRemarkPlugin {
  assertContentBuildSession(session);
  return createProjectPreviewRemarkPluginModule(session);
}

export function createProjectPreviewRemarkPluginForTest(
  session: ContentBuildSession,
): ProjectPreviewRemarkPlugin {
  assertLoadedValidatedContent(session.content);
  return createProjectPreviewRemarkPluginModule(session);
}

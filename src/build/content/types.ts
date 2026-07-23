import type {
  Article,
  ArticleDateIndexEntry,
  ProjectCatalog,
  ProjectNavigationItem,
  RegistryDocumentInput,
  WritingNavigationGroup,
} from "../../domain/content/index.js";
import type {UnpublishedAssetSnapshotInput} from "../static-assets/index.js";

export type ContentBuildMode = "production" | "preview";

export interface ContentSourceSnapshot {
  readonly kind: "project" | "article";
  readonly sourcePath: string;
  readonly absolutePath: string;
  readonly fileContent: string;
  readonly frontMatter: Readonly<Record<string, unknown>>;
  readonly content: string;
  readonly projectId?: string;
  readonly sourceName?: string;
}

export interface LoadedValidatedContent {
  readonly mode: ContentBuildMode;
  readonly repositoryRoot: string;
  readonly catalog: ProjectCatalog;
  readonly articles: readonly Article[];
  readonly projectNavigation: readonly ProjectNavigationItem[];
  readonly writingNavigation: readonly WritingNavigationGroup[];
  readonly articleDateIndex: readonly ArticleDateIndexEntry[];
  readonly staticPublicRegistry: RegistryDocumentInput;
  readonly sources: readonly ContentSourceSnapshot[];
}

export interface LoadValidatedContentInput {
  readonly repositoryRoot: string;
  readonly mode: ContentBuildMode;
}

export interface ContentFileIdentitySnapshot {
  readonly sourcePath: string;
  readonly absolutePath: string;
  readonly realPath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly linkCount: bigint;
  readonly owner: bigint;
  readonly group: bigint;
  readonly size: bigint;
  readonly modifiedAtNanoseconds: bigint;
  readonly changedAtNanoseconds: bigint;
}

export interface ContentDirectoryIdentitySnapshot {
  readonly identity: ContentFileIdentitySnapshot;
  readonly names: readonly string[];
}

export interface LoadedContentPrivateState {
  readonly unpublishedAssets: readonly UnpublishedAssetSnapshotInput[];
  readonly sourceFileIdentities: readonly ContentFileIdentitySnapshot[];
  readonly fileIdentities: readonly ContentFileIdentitySnapshot[];
  readonly directories: readonly ContentDirectoryIdentitySnapshot[];
  readonly inputDigest: string;
}

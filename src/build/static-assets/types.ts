import type {
  ProjectCatalog,
  RegistryDocumentInput,
} from "../../domain/content/index.js";
import type {BuildContext} from "../site-config/index.js";

export type StaticAssetMode = "production" | "preview";
export type StaticPublicAssetRole = "brand" | "operational";

export interface UnpublishedAssetSnapshotInput {
  readonly sourcePath: string;
  readonly publicPath: string;
  readonly bytes: Uint8Array;
}

export interface PrepareStaticAssetPlanInput {
  readonly mode: StaticAssetMode;
  readonly repositoryRoot: string;
  readonly catalog: ProjectCatalog;
  readonly staticPublicRegistry: RegistryDocumentInput;
  readonly unpublishedAssets?: readonly UnpublishedAssetSnapshotInput[];
}

export type StaticAssetManifestFile = Readonly<{
  kind: "static-public";
  sourcePath: string;
  targetPath: string;
  publicUrl: string;
  role: StaticPublicAssetRole;
}> | Readonly<{
  kind: "project-preview";
  sourcePath: string;
  targetPath: string;
  publicUrl: string;
  projectId: string;
}>;

export interface StaticAssetExcludedFile {
  readonly kind: "project-preview" | "article-asset";
  readonly sourcePath: string;
  readonly publicUrl: string;
}

export interface StaticAssetManifest {
  readonly mode: StaticAssetMode;
  readonly files: readonly StaticAssetManifestFile[];
  readonly excludedFiles: readonly StaticAssetExcludedFile[];
}

export interface StaticAssetPlan {
  readonly manifest: StaticAssetManifest;
  materialize(buildContext: BuildContext): StaticAssetManifest;
  assertProductionBuild(buildDirectory: string): void;
  dispose(): void;
}

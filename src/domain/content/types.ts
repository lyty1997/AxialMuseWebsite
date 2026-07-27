export interface ContentIssue {
  readonly code: string;
  readonly sourcePath: string;
  readonly fieldPath?: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | Readonly<{ok: true; value: T}>
  | Readonly<{ok: false; issues: readonly ContentIssue[]}>;

export interface ContentPathInput {
  readonly sourcePath: string;
  readonly isSymbolicLink: boolean;
  readonly isRealPathWithinRoot: boolean;
}

export type ContentPathClassification =
  | Readonly<{
      kind: "project";
      sourcePath: string;
      projectId: string;
      extension: ".md" | ".mdx";
    }>
  | Readonly<{
      kind: "article";
      sourcePath: string;
      sourceName: string;
      extension: ".md" | ".mdx";
    }>
  | Readonly<{
      kind: "other";
      sourcePath: string;
    }>;

export interface RegistryDocumentInput {
  readonly sourcePath: string;
  readonly value: unknown;
}

export interface ProjectSourceInput extends ContentPathInput {
  readonly frontMatter: unknown;
  readonly content: string;
}

export interface ArticleSourceInput extends ContentPathInput {
  readonly frontMatter: unknown;
  readonly content: string;
}

export interface Author {
  readonly id: string;
  readonly displayName: string;
  readonly githubUrl?: string;
}

export interface Topic {
  readonly id: string;
  readonly displayName: string;
  readonly navigationOrder: number;
  readonly status: "active" | "archived";
}

export interface WritingModule {
  readonly id: string;
  readonly displayName: string;
  readonly navigationOrder: number;
  readonly status: "active" | "archived";
}

export interface PreviewImage {
  readonly sourcePath: string;
  readonly width: 1600;
  readonly height: 1000;
  readonly alt: string;
}

export interface ProjectMediaSourceInput {
  readonly sourcePath: string;
  readonly isSymbolicLink: boolean;
  readonly isRealPathWithinRoot: boolean;
  readonly isRegularFile: boolean;
  readonly bytes?: Uint8Array;
}

export interface ProjectPreviewAsset {
  readonly projectId: string;
  readonly sourcePath: string;
  readonly publicUrl: string;
  readonly width: 1600;
  readonly height: 1000;
  readonly alt: string;
}

export interface Project {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly navigationOrder: number;
  readonly summary: string;
  readonly status: "active" | "paused" | "completed" | "archived";
  readonly publicationStatus: "draft" | "planned" | "published" | "archived";
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly repositoryUrl?: string;
  readonly productionBranch?: string;
  readonly showcaseMode: "repository" | "repository-and-video";
  readonly demoVideoStatus?: "asset-pending" | "review-pending" | "approved";
  readonly experienceRegistryId?: string;
  readonly demoVideoUrl?: string;
  readonly demoVideoPoster?: string;
  readonly demoVideoCaptions?: string;
  readonly relatedWriting: readonly string[];
  readonly writingModules: readonly WritingModule[];
  readonly previewImage?: PreviewImage;
  readonly source: readonly string[];
}

export interface ProjectExperience {
  readonly id: string;
  readonly projectId: string;
  readonly hostname: string;
  readonly status: "planned" | "provisioning" | "live" | "paused" | "retired";
  readonly dnsProvisioning: "disabled" | "pending" | "active" | "removed";
  readonly deliveryMode: "static";
  readonly indexing: "noindex" | "index";
  readonly healthPath: string;
}

export interface ProjectSource {
  readonly projectId: string;
  readonly sourcePath: string;
  readonly content: string;
}

export interface ProjectCatalog {
  readonly projects: readonly Project[];
  readonly authors: readonly Author[];
  readonly topics: readonly Topic[];
  readonly experiences: readonly ProjectExperience[];
  readonly projectSources: readonly ProjectSource[];
}

export interface ProjectCatalogInput {
  readonly projects: RegistryDocumentInput;
  readonly authors: RegistryDocumentInput;
  readonly topics: RegistryDocumentInput;
  readonly experiences: RegistryDocumentInput;
  readonly projectSources: readonly ProjectSourceInput[];
}

export interface ProjectMediaValidationInput {
  readonly catalog: ProjectCatalog;
  readonly sources: readonly ProjectMediaSourceInput[];
}

export interface ArticleClassification {
  readonly project?: string;
  readonly module?: string;
  readonly topics: readonly string[];
}

export interface ArticleRelations {
  readonly projects?: readonly string[];
  readonly articles?: readonly string[];
}

export interface ArticleSeo {
  readonly description?: string;
  readonly socialDescription?: string;
}

export interface ArticleRecommendation {
  readonly surfaces: readonly ("home" | "writing")[];
  readonly priority: number;
}

export interface ArticleRevision {
  readonly date: string;
  readonly summary: string;
}

export interface ArticleReferenceSource {
  readonly title: string;
  readonly href: string;
  readonly accessedAt?: string;
}

export interface Article {
  readonly sourcePath: string;
  readonly sourceName: string;
  readonly articleId: string;
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  readonly publicationStatus: "draft" | "published" | "archived";
  readonly authors: readonly string[];
  readonly publishedAt?: string;
  readonly updatedAt?: string;
  readonly classification: ArticleClassification;
  readonly relations?: ArticleRelations;
  readonly seo?: ArticleSeo;
  readonly recommendation?: ArticleRecommendation;
  readonly revisions?: readonly ArticleRevision[];
  readonly sources?: readonly ArticleReferenceSource[];
  readonly content: string;
}

export interface ArticleValidationInput {
  readonly catalog: ProjectCatalog;
  readonly sources: readonly ArticleSourceInput[];
}

export type ContentBuildMode = "production" | "preview";

export interface ContentNavigationLink {
  readonly title: string;
  readonly canonicalPath: string;
}

export interface ProjectNavigationInput {
  readonly catalog: ProjectCatalog;
  readonly articles: readonly Article[];
}

export interface ProjectNavigationPreviewImage {
  readonly publicUrl: string;
  readonly width: 1600;
  readonly height: 1000;
  readonly alt: string;
}

export interface ProjectNavigationItem {
  readonly projectId: string;
  readonly sourcePath: string;
  readonly title: string;
  readonly summary: string;
  readonly canonicalPath: string;
  readonly navigationOrder: number;
  readonly status: "active" | "paused" | "completed" | "archived";
  readonly publicationStatus: "published" | "archived";
  readonly updatedAt: string;
  readonly repositoryUrl?: string;
  readonly relatedWriting: readonly ContentNavigationLink[];
  readonly previewImage: ProjectNavigationPreviewImage;
}

export interface WritingNavigationInput {
  readonly mode: ContentBuildMode;
  readonly catalog: ProjectCatalog;
  readonly articles: readonly Article[];
}

export interface ArticleAuthorNavigationItem {
  readonly id: string;
  readonly displayName: string;
}

export interface ArticleTopicNavigationItem {
  readonly id: string;
  readonly displayName: string;
}

export interface ArticleSeoNavigationInput {
  readonly description: string;
  readonly socialDescription: string;
}

export interface PublicArticleNavigationItem {
  readonly articleId: string;
  readonly sourcePath: string;
  readonly title: string;
  readonly summary: string;
  readonly canonicalPath: string;
  readonly publicationStatus: "published" | "archived";
  readonly publishedAt: string;
  readonly updatedAt: string;
  readonly authors: readonly ArticleAuthorNavigationItem[];
  readonly topics: readonly ArticleTopicNavigationItem[];
  readonly seo: ArticleSeoNavigationInput;
  readonly relatedProjects: readonly ContentNavigationLink[];
  readonly relatedArticles: readonly ContentNavigationLink[];
}

export interface DraftArticleNavigationItem {
  readonly articleId: string;
  readonly sourcePath: string;
  readonly title: string;
  readonly summary: string;
  readonly canonicalPath: string;
  readonly publicationStatus: "draft";
  readonly updatedAt?: string;
  readonly authors: readonly ArticleAuthorNavigationItem[];
  readonly topics: readonly ArticleTopicNavigationItem[];
  readonly seo: ArticleSeoNavigationInput;
  readonly relatedProjects: readonly ContentNavigationLink[];
  readonly relatedArticles: readonly ContentNavigationLink[];
}

export interface GeneralWritingGroup {
  readonly kind: "general";
  readonly label: "通用技术";
  readonly articles: readonly PublicArticleNavigationItem[];
}

export interface ModuleWritingGroup {
  readonly kind: "module";
  readonly moduleId: string;
  readonly label: string;
  readonly navigationOrder: number;
  readonly articles: readonly PublicArticleNavigationItem[];
}

export interface ProjectWritingGroup {
  readonly kind: "project";
  readonly projectId: string;
  readonly label: string;
  readonly navigationOrder: number;
  readonly rootArticles: readonly PublicArticleNavigationItem[];
  readonly modules: readonly ModuleWritingGroup[];
}

export interface DraftWritingGroup {
  readonly kind: "draft";
  readonly label: "草稿";
  readonly articles: readonly DraftArticleNavigationItem[];
}

export type WritingNavigationGroup =
  | GeneralWritingGroup
  | ProjectWritingGroup
  | DraftWritingGroup;

export interface ArticleDateIndexInput {
  readonly articles: readonly Article[];
}

export interface ArticleDateIndexEntry {
  readonly articleId: string;
  readonly slug: string;
  readonly publishedAt: string;
  readonly updatedAt: string;
}

export const RUNTIME_REDIRECT_SCHEMA_VERSION: "1.0.0";
export const REDIRECT_REGISTRY_VERSION: "0.1.0";
export const CANONICAL_ORIGIN: "https://www.axialmuse.com";
export const REDIRECT_REGISTRY_SOURCE_PATH: "docs/contracts/redirects.json";

export type RuntimeRedirectKind = "registered" | "canonical-slash";

declare const validatedRedirectRegistry: unique symbol;

export interface RedirectRegistryEntry {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

export interface RedirectRegistry {
  readonly [validatedRedirectRegistry]: true;
  readonly version: "0.1.0";
  readonly kind: "axial_muse_redirects";
  readonly status: "active";
  readonly owner: "AxialMuseWebsite";
  readonly redirects: readonly RedirectRegistryEntry[];
}

export interface RedirectRegistrySnapshot {
  readonly registry: RedirectRegistry;
  readonly rawSha256: string;
  readonly byteLength: number;
  readonly operationalSha256: string;
}

export interface RuntimeRedirectRule {
  readonly kind: RuntimeRedirectKind;
  readonly from: string;
  readonly to: string;
}

export interface RuntimeRedirectManifest {
  readonly schemaVersion: "1.0.0";
  readonly canonicalOrigin: "https://www.axialmuse.com";
  readonly rules: readonly RuntimeRedirectRule[];
}

export interface RuntimeRedirectArtifacts {
  readonly publicRoutes: readonly string[];
  readonly rules: readonly RuntimeRedirectRule[];
  readonly manifest: RuntimeRedirectManifest;
  readonly runtimeRedirectsJson: string;
  readonly nginxRedirectsConfig: string;
  readonly registeredRuleCount: number;
  readonly canonicalSlashRuleCount: number;
}

export class RuntimeRedirectError extends Error {
  readonly code: string;
  readonly sourcePath: string;
}

export function formatRuntimeRedirectError(error: unknown): string;

export function parseRedirectRegistry(bytes: Uint8Array): RedirectRegistry;

export function readRedirectRegistry(): RedirectRegistry;

export function readRedirectRegistryFromRepositoryRoot(
  repositoryRoot: string,
): RedirectRegistry;

export function readRedirectRegistrySnapshotFromRepositoryRoot(
  repositoryRoot: string,
): RedirectRegistrySnapshot;

export function publicRouteFromHtmlPath(
  relativePath: string,
): string | undefined;

export function collectPublicHtmlRoutes(
  buildRoot: string,
): readonly string[];

export function compileRuntimeRedirectArtifacts(options: Readonly<{
  publicRoutes: readonly string[];
  registry: RedirectRegistry;
  canonicalOrigin: "https://www.axialmuse.com";
}>): RuntimeRedirectArtifacts;

export function deriveRuntimeRedirectArtifacts(options: Readonly<{
  buildRoot: string;
  commitSha: string;
  canonicalOrigin: "https://www.axialmuse.com";
}>): RuntimeRedirectArtifacts;

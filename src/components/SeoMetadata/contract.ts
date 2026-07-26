export interface SeoMetadataValues {
  readonly title: string;
  readonly description: string;
  readonly socialDescription: string;
  readonly canonicalPath: string;
  readonly type: "website" | "article";
  readonly imagePath?: string;
}

export interface SeoMetadataInput extends SeoMetadataValues {
  readonly origin: string;
}

export interface ResolvedSeoMetadata extends SeoMetadataValues {
  readonly canonicalUrl: string;
  readonly imageUrl?: string;
}

function fail(field: keyof SeoMetadataInput): never {
  throw new Error(`[SEO_METADATA_INVALID] ${field} 不符合公开页面元数据契约。`);
}

function origin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("origin");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
    || (value !== parsed.origin && value !== `${parsed.origin}/`)
  ) {
    fail("origin");
  }
  return parsed.origin;
}

function text(value: string, field: "title" | "description" | "socialDescription"): string {
  if (value.trim().length === 0 || value !== value.trim()) fail(field);
  return value;
}

function canonicalPath(value: string): string {
  if (
    value !== "/"
    && !/^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)+$/u.test(value)
  ) {
    fail("canonicalPath");
  }
  return value;
}

function imagePath(value: string): string {
  if (
    !value.startsWith("/assets/")
    || value.includes("\\")
    || value.includes("?")
    || value.includes("#")
    || value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    fail("imagePath");
  }
  return value;
}

export function resolveSeoMetadata(input: SeoMetadataInput): ResolvedSeoMetadata {
  const canonicalOrigin = origin(input.origin);
  const path = canonicalPath(input.canonicalPath);
  const image = input.imagePath === undefined ? undefined : imagePath(input.imagePath);
  if (input.type !== "website" && input.type !== "article") fail("type");
  return {
    title: text(input.title, "title"),
    description: text(input.description, "description"),
    socialDescription: text(input.socialDescription, "socialDescription"),
    canonicalPath: path,
    type: input.type,
    ...(image === undefined ? {} : {imagePath: image}),
    canonicalUrl: `${canonicalOrigin}${path}`,
    ...(image === undefined ? {} : {imageUrl: `${canonicalOrigin}${image}`}),
  };
}

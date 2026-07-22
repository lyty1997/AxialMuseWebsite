import type {RegistryDocumentInput} from "../../domain/content/index.js";
import type {StaticPublicAssetRole} from "./types.js";
import {compareUtf8} from "./file-safety.js";
import {failStaticAsset} from "./errors.js";
import {isDeepFrozenPlainData} from "./plain-data.js";

const REGISTRY_PATH = "docs/contracts/static-public-assets.json";
const ENVELOPE_KEYS = Object.freeze([
  "version",
  "kind",
  "status",
  "owner",
  "roleValues",
  "assets",
]);
const ENTRY_KEYS = Object.freeze(["sourcePath", "role"]);
const ROLE_VALUES = Object.freeze(["brand", "operational"] as const);
const SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/u;

export interface StaticPublicRegistryEntry {
  readonly sourcePath: string;
  readonly role: StaticPublicAssetRole;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

function isSafeRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > 512
    || value.startsWith("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  return segments.every((segment, index) => (
    segment === ".well-known" && index === 0
      ? true
      : index === segments.length - 1
        ? FILE_PATTERN.test(segment)
        : SEGMENT_PATTERN.test(segment)
  ));
}

function roleMatchesPath(role: StaticPublicAssetRole, sourcePath: string): boolean {
  if (role === "brand") {
    return sourcePath.startsWith("assets/brand/")
      || /^favicon\.[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(sourcePath);
  }
  return sourcePath === "robots.txt" || sourcePath.startsWith(".well-known/");
}

function assertAllowedOutputPath(sourcePath: string): void {
  if (
    sourcePath === "sitemap.xml"
    || sourcePath.endsWith(".html")
    || sourcePath.startsWith("assets/projects/")
    || sourcePath.startsWith("assets/writing/")
  ) {
    failStaticAsset(
      "STATIC_ASSET_PUBLIC_RESERVED_PATH",
      "始终公开素材不得占用项目、文章或框架输出空间。",
      {sourcePath: `static-public/${sourcePath}`},
    );
  }
}

export function decodeStaticPublicRegistry(
  input: RegistryDocumentInput,
): readonly StaticPublicRegistryEntry[] {
  if (
    input === null
    || typeof input !== "object"
    || input.sourcePath !== REGISTRY_PATH
    || !isDeepFrozenPlainData(input.value)
    || input.value === null
    || typeof input.value !== "object"
    || Array.isArray(input.value)
  ) {
    failStaticAsset(
      "STATIC_ASSET_PUBLIC_REGISTRY",
      "始终公开素材注册表必须来自唯一已解码且深冻结的契约文档。",
      {sourcePath: REGISTRY_PATH},
    );
  }
  const value = input.value as Record<string, unknown>;
  if (
    !hasExactKeys(value, ENVELOPE_KEYS)
    || value.version !== "0.1.0"
    || value.kind !== "axial_muse_static_public_assets"
    || value.status !== "active"
    || value.owner !== "AxialMuseWebsite"
    || !Array.isArray(value.roleValues)
    || value.roleValues.length !== ROLE_VALUES.length
    || value.roleValues.some((role, index) => role !== ROLE_VALUES[index])
    || !Array.isArray(value.assets)
  ) {
    failStaticAsset(
      "STATIC_ASSET_PUBLIC_REGISTRY_SCHEMA",
      "始终公开素材注册表封套或枚举发生漂移。",
      {sourcePath: REGISTRY_PATH},
    );
  }

  const entries: StaticPublicRegistryEntry[] = [];
  const exactPaths = new Set<string>();
  const foldedPaths = new Set<string>();
  for (const [index, candidate] of value.assets.entries()) {
    if (
      candidate === null
      || typeof candidate !== "object"
      || Array.isArray(candidate)
      || !hasExactKeys(candidate, ENTRY_KEYS)
    ) {
      failStaticAsset(
        "STATIC_ASSET_PUBLIC_REGISTRY_ENTRY",
        "始终公开素材登记条目字段不合法。",
        {sourcePath: REGISTRY_PATH},
      );
    }
    const entry = candidate as Record<string, unknown>;
    if (!isSafeRelativePath(entry.sourcePath)) {
      failStaticAsset(
        "STATIC_ASSET_PUBLIC_PATH",
        "始终公开素材路径不符合规范相对路径契约。",
        {sourcePath: REGISTRY_PATH},
      );
    }
    if (entry.role !== "brand" && entry.role !== "operational") {
      failStaticAsset(
        "STATIC_ASSET_PUBLIC_ROLE",
        "始终公开素材角色不属于封闭枚举。",
        {sourcePath: `static-public/${entry.sourcePath}`},
      );
    }
    assertAllowedOutputPath(entry.sourcePath);
    if (!roleMatchesPath(entry.role, entry.sourcePath)) {
      failStaticAsset(
        "STATIC_ASSET_PUBLIC_ROLE_PATH",
        "始终公开素材角色与受控路径空间不匹配。",
        {sourcePath: `static-public/${entry.sourcePath}`},
      );
    }
    const folded = entry.sourcePath.toLocaleLowerCase("en-US");
    if (exactPaths.has(entry.sourcePath) || foldedPaths.has(folded)) {
      failStaticAsset(
        "STATIC_ASSET_PUBLIC_DUPLICATE",
        "始终公开素材登记存在重复或大小写冲突。",
        {sourcePath: `static-public/${entry.sourcePath}`},
      );
    }
    exactPaths.add(entry.sourcePath);
    foldedPaths.add(folded);
    entries.push(Object.freeze({
      sourcePath: entry.sourcePath,
      role: entry.role,
    }));
    if (index >= 2_047) {
      failStaticAsset(
        "STATIC_ASSET_SOURCE_COUNT",
        "始终公开素材登记数量超过上限。",
        {sourcePath: REGISTRY_PATH},
      );
    }
  }
  entries.sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath));
  return Object.freeze(entries);
}
